//! Host runtime for the wire contract in `docs/mc-host-wire-protocol.md`.

#![forbid(unsafe_code)]

pub mod config;
pub mod handler;

mod connection;
mod control;
mod dispatch;
mod instance;
mod routing;
mod runtime;
mod wire;

pub use config::{ConfigError, HostConfig, HostInit, HostLimits, HostTiming, LivenessPolicy};
pub use handler::{
    BindOutcome, HealthReport, HealthStatus, InitError, ManifestSnapshot, McHostHandler,
    RequestCtx, RequestOutcome, RouteHandle, RouteIdentity, StreamClosed,
};
pub use instance::{runtime_dir_path, InstanceError, CONNECTION_FILE_NAME};
pub use runtime::{run, HostError};

pub use tokio_util::sync::CancellationToken;
