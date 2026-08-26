//! Focused Synapse composition host for the cross-language smoke: starts the
//! fixed two-target composite (an echoing Magic Context stand-in plus the
//! real Synapse component over a configured bundle), publishes its
//! connection file, and serves until SIGINT/SIGTERM.
//!
//! Usage:
//!   synapse_host <data-dir> <bundle-dir> <ort-library> <ort-library-sha256> [--stats-secs N]
//!
//! Pass `-` as <bundle-dir> to start with Synapse deliberately unconfigured
//! (degraded-lane smoke).

use std::time::Duration;

use mc_host::synapse::{SynapseComponent, SynapseConfig, SynapseLimits};
use mc_host::{
    BindOutcome, CancellationToken, CompositeComponent, HealthReport, HostConfig, HostInit,
    InitError, ManifestSnapshot, PrimaryComponent, RequestCtx, RequestOutcome, RouteHandle,
    RouteIdentity, SecondaryComponent, ShutdownError, StaticComposite,
};

fn emit_metrics(metrics: &mc_host::synapse::SynapseMetrics) {
    eprintln!(
        "{}",
        serde_json::to_string(&metrics.snapshot()).expect("metrics serialize")
    );
}

struct EchoPrimary;

impl CompositeComponent for EchoPrimary {
    fn manifest(&self) -> ManifestSnapshot {
        ManifestSnapshot {
            module_id: "magic-context".to_owned(),
            module_version: env!("CARGO_PKG_VERSION").to_owned(),
            provides: vec![serde_json::json!({
                "role": "tool_provider",
                "tools": [{
                    "name": "echo",
                    "execution_mode": "pure",
                    "schema": {"type": "object"}
                }]
            })],
            control_ops: Vec::new(),
        }
    }

    async fn bind(&self, _route: RouteHandle, _identity: RouteIdentity) -> BindOutcome {
        BindOutcome::Accept
    }

    async fn handle(&self, ctx: RequestCtx) -> RequestOutcome {
        let Ok(mut body) = ctx.reserve_output(ctx.body.len()).await else {
            return RequestOutcome::Error {
                code: "internal_error".to_owned(),
                message: "output reservation unavailable".to_owned(),
            };
        };
        body.extend_from_slice(&ctx.body)
            .expect("reservation matches request length");
        RequestOutcome::Response {
            body,
            binary: ctx.binary,
        }
    }

    async fn route_gone(&self, _route: RouteHandle) {}

    async fn health(&self) -> HealthReport {
        HealthReport::ok()
    }

    async fn shutdown(&self) -> Result<(), ShutdownError> {
        Ok(())
    }
}

impl PrimaryComponent for EchoPrimary {
    async fn initialize(&self, _init: HostInit) -> Result<(), InitError> {
        Ok(())
    }
}

struct PlaceholderBroca;

impl CompositeComponent for PlaceholderBroca {
    fn manifest(&self) -> ManifestSnapshot {
        ManifestSnapshot {
            module_id: "broca".to_owned(),
            module_version: env!("CARGO_PKG_VERSION").to_owned(),
            provides: vec![serde_json::json!({"role": "management_surface"})],
            control_ops: Vec::new(),
        }
    }

    async fn bind(&self, _route: RouteHandle, _identity: RouteIdentity) -> BindOutcome {
        BindOutcome::Reject {
            code: "artifact_invalid".to_owned(),
            message: "broca is unavailable in this smoke host".to_owned(),
        }
    }

    async fn handle(&self, _ctx: RequestCtx) -> RequestOutcome {
        RequestOutcome::Error {
            code: "internal_error".to_owned(),
            message: "unreachable: broca binds are rejected".to_owned(),
        }
    }

    async fn route_gone(&self, _route: RouteHandle) {}

    async fn health(&self) -> HealthReport {
        HealthReport::ok()
    }

    async fn shutdown(&self) -> Result<(), ShutdownError> {
        Ok(())
    }
}

impl SecondaryComponent for PlaceholderBroca {
    async fn initialize(&self) -> Result<(), InitError> {
        Ok(())
    }
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let usage = "usage: synapse_host <data-dir> <bundle-dir|-> <ort-library> <ort-library-sha256> [--stats-secs N]";
    let data_dir = std::path::PathBuf::from(args.next().expect(usage));
    let bundle_dir = args.next().expect(usage);
    let ort_library = std::path::PathBuf::from(args.next().expect(usage));
    let ort_library_sha256 = args.next().expect(usage);
    let remaining = args.collect::<Vec<_>>();
    let stats_secs = match remaining.as_slice() {
        [] => None,
        [flag, value] if flag == "--stats-secs" => match value.parse::<u64>() {
            Ok(seconds) if seconds > 0 => Some(seconds),
            _ => {
                eprintln!("{usage}");
                std::process::exit(2);
            }
        },
        _ => {
            eprintln!("{usage}");
            std::process::exit(2);
        }
    };

    let synapse_config = (bundle_dir != "-").then(|| SynapseConfig {
        bundle_dir: std::path::PathBuf::from(bundle_dir),
        ort_library,
        ort_library_sha256,
        limits: SynapseLimits::default(),
    });
    let synapse = SynapseComponent::new(synapse_config);
    let metrics = synapse.metrics_handle();
    let composite = StaticComposite::new(EchoPrimary, synapse, PlaceholderBroca)
        .expect("composite module IDs are distinct");

    let config = HostConfig {
        data_dir: Some(data_dir.clone()),
        daemon_ver: "mc-host/synapse-smoke".to_owned(),
        ..Default::default()
    };
    let publication = data_dir
        .join("cortexkit")
        .join("run")
        .join(mc_host::CONNECTION_FILE_NAME);
    let shutdown = CancellationToken::new();
    let host = tokio::spawn(mc_host::run(composite, config, shutdown.clone()));
    let stats = stats_secs.map(|seconds| {
        let shutdown = shutdown.clone();
        let metrics = metrics.clone();
        tokio::spawn(async move {
            let period = Duration::from_secs(seconds);
            let mut interval =
                tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    biased;
                    _ = shutdown.cancelled() => break,
                    _ = interval.tick() => emit_metrics(&metrics),
                }
            }
        })
    });

    while !publication.exists() {
        if host.is_finished() {
            let result = host.await;
            eprintln!("host exited before publishing: {result:?}");
            std::process::exit(1);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    println!("READY {}", publication.display());

    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = sigterm.recv() => {}
    }
    shutdown.cancel();
    let host_result = host.await;
    if let Some(stats) = stats {
        if let Err(join) = stats.await {
            eprintln!("stats join failed: {join}");
            std::process::exit(1);
        }
    }
    emit_metrics(&metrics);
    match host_result {
        Ok(Ok(())) => println!("SHUTDOWN graceful"),
        Ok(Err(error)) => {
            eprintln!("SHUTDOWN failed: {error}");
            std::process::exit(1);
        }
        Err(join) => {
            eprintln!("SHUTDOWN join failed: {join}");
            std::process::exit(1);
        }
    }
}
