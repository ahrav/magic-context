//! Perf-harness host process, separate from the load generator so
//! strace/perf attribute host cost only. See docs/perf/mc-host-baseline.md
//! for the harness contract, including the request-body mode layout the load
//! generator encodes.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use mc_host::{
    BindOutcome, CancellationToken, HealthReport, HostConfig, HostInit, InitError,
    ManifestSnapshot, McHostHandler, RequestCtx, RequestOutcome, RouteHandle, RouteIdentity,
};

// The fixture-echo contract (manifest, bind, echo semantics) has exactly one
// definition, shared with the ipc-budget tests, so the `compact-json-v1`
// workload identity always names the same server behavior.
#[path = "../tests/support/echo_host.rs"]
mod echo_host;

static ALLOCS: AtomicU64 = AtomicU64::new(0);
static ALLOC_BYTES: AtomicU64 = AtomicU64::new(0);

/// Relaxed counters perform two fetch_add operations per allocation.
struct CountingAlloc;

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        ALLOC_BYTES.fetch_add(layout.size() as u64, Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

/// Shared echo handler plus the perf-only mode-byte sleep branch: a request
/// body starting with byte 1 carries a little-endian u32 sleep duration in
/// milliseconds, applied before the delegated echo.
struct EchoHandler {
    inner: echo_host::EchoHandler,
}

impl McHostHandler for EchoHandler {
    fn manifests(&self) -> Vec<ManifestSnapshot> {
        self.inner.manifests()
    }

    async fn initialize(&self, init: HostInit) -> Result<(), InitError> {
        self.inner.initialize(init).await
    }

    async fn bind(
        &self,
        route: RouteHandle,
        target: mc_host::RouteTarget,
        identity: RouteIdentity,
    ) -> BindOutcome {
        self.inner.bind(route, target, identity).await
    }

    async fn handle(&self, ctx: RequestCtx) -> RequestOutcome {
        if ctx.body.len() >= 5 && ctx.body[0] == 1 {
            let ms = u32::from_le_bytes(ctx.body[1..5].try_into().expect("4 bytes"));
            tokio::time::sleep(Duration::from_millis(u64::from(ms))).await;
        }
        self.inner.handle(ctx).await
    }

    async fn route_gone(&self, route: RouteHandle) {
        self.inner.route_gone(route).await
    }

    async fn health(&self) -> HealthReport {
        self.inner.health().await
    }

    async fn shutdown(&self) {
        self.inner.shutdown().await
    }
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let data_dir = std::path::PathBuf::from(args.next().expect("usage: perf_host <data-dir>"));
    let frame_deadline = args
        .next()
        .map(|s| Duration::from_secs(s.parse().expect("frame_deadline_secs")));

    let mut config = HostConfig {
        data_dir: Some(data_dir.clone()),
        daemon_ver: "mc-host/perf".to_owned(),
        ..Default::default()
    };
    if let Some(deadline) = frame_deadline {
        config.timing.frame_deadline = deadline;
    }

    let publication = data_dir
        .join("cortexkit")
        .join("run")
        .join(mc_host::CONNECTION_FILE_NAME);
    let shutdown = CancellationToken::new();
    let host = tokio::spawn(mc_host::run(
        EchoHandler {
            inner: echo_host::EchoHandler,
        },
        config,
        shutdown.clone(),
    ));

    while !publication.exists() {
        if host.is_finished() {
            let result = host.await;
            eprintln!("host exited before publishing: {result:?}");
            std::process::exit(1);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let allocs_ready = ALLOCS.load(Ordering::Relaxed);
    let bytes_ready = ALLOC_BYTES.load(Ordering::Relaxed);
    println!("READY {}", publication.display());

    tokio::signal::ctrl_c().await.expect("signal");
    let allocs_end = ALLOCS.load(Ordering::Relaxed);
    let bytes_end = ALLOC_BYTES.load(Ordering::Relaxed);
    shutdown.cancel();
    let _ = host.await;
    println!(
        "ALLOC_STATS allocs={} bytes={}",
        allocs_end - allocs_ready,
        bytes_end - bytes_ready
    );
}
