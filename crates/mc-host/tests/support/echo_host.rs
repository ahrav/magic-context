//! Echo host support: one handler that echoes every request body, plus an
//! in-process host runner for tests that need a live ring endpoint without
//! a child process.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

pub struct EchoHandler;

pub const ECHO_MODULE_ID: &str = "perf-echo";

impl mc_host::McHostHandler for EchoHandler {
    fn manifests(&self) -> Vec<mc_host::ManifestSnapshot> {
        vec![mc_host::ManifestSnapshot {
            module_id: ECHO_MODULE_ID.to_owned(),
            module_version: "0.0.0".to_owned(),
            provides: vec![serde_json::json!({
                "role": "tool_provider",
                "tools": [{
                    "name": "echo",
                    "execution_mode": "pure",
                    "schema": {"type": "object"}
                }],
                "identity_scope": ["session", "project"],
                "concurrency": "module_managed",
                "emits_push": false,
                "sub_supervises": false
            })],
            control_ops: Vec::new(),
        }]
    }

    async fn initialize(&self, _init: mc_host::HostInit) -> Result<(), mc_host::InitError> {
        Ok(())
    }

    async fn bind(
        &self,
        _route: mc_host::RouteHandle,
        _target: mc_host::RouteTarget,
        _identity: mc_host::RouteIdentity,
    ) -> mc_host::BindOutcome {
        mc_host::BindOutcome::Accept
    }

    async fn handle(&self, ctx: mc_host::RequestCtx) -> mc_host::RequestOutcome {
        let Ok(mut body) = ctx.reserve_output(ctx.body.len()).await else {
            return mc_host::RequestOutcome::error(
                "internal_error",
                "output reservation unavailable",
            );
        };
        body.extend_from_slice(&ctx.body)
            .expect("reservation matches request length");
        mc_host::RequestOutcome::Response {
            body,
            binary: ctx.binary,
        }
    }

    async fn route_gone(&self, _route: mc_host::RouteHandle) {}

    async fn health(&self) -> mc_host::HealthReport {
        mc_host::HealthReport::ok()
    }

    async fn shutdown(&self) {}
}

/// An in-process echo host on its own runtime thread.
pub struct InProcessHost {
    pub publication: PathBuf,
    shutdown: mc_host::CancellationToken,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl InProcessHost {
    /// Starts the host and blocks until its publication exists.
    pub fn start(data_dir: &Path) -> Self {
        let publication = mc_host::runtime_dir_path(Some(data_dir))
            .expect("runtime dir")
            .join(mc_host::CONNECTION_FILE_NAME);
        let shutdown = mc_host::CancellationToken::new();
        let host_shutdown = shutdown.clone();
        let host_dir = data_dir.to_path_buf();
        let thread = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .expect("host runtime");
            runtime.block_on(async move {
                let config = mc_host::HostConfig {
                    data_dir: Some(host_dir),
                    daemon_ver: "mc-host/test".to_owned(),
                    ..Default::default()
                };
                let host = tokio::spawn(mc_host::run(EchoHandler, config, host_shutdown));
                let _ = host.await;
            });
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while !publication.exists() {
            assert!(std::time::Instant::now() < deadline, "host never published");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        Self {
            publication,
            shutdown,
            thread: Some(thread),
        }
    }
}

impl Drop for InProcessHost {
    fn drop(&mut self) {
        self.shutdown.cancel();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
