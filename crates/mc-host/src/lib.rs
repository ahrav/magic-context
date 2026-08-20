//! Host runtime for the wire contract in `docs/mc-host-wire-protocol.md`.

#![forbid(unsafe_code)]

pub mod composite;
pub mod config;
pub mod handler;

mod connection;
mod control;
mod dispatch;
mod instance;
mod panic_boundary;
mod routing;
mod runtime;
mod wire;

pub use composite::{CompositeComponent, PrimaryComponent, SecondaryComponent, StaticComposite};
pub use config::{ConfigError, HostConfig, HostInit, HostLimits, HostTiming, LivenessPolicy};
pub use handler::{
    BindOutcome, HealthReport, HealthStatus, InitError, ManifestSnapshot, McHostHandler,
    OutputBuffer, RequestCtx, RequestOutcome, RouteHandle, RouteIdentity, RouteTarget,
    StreamClosed, TargetKind,
};
pub use instance::{runtime_dir_path, InstanceError, CONNECTION_FILE_NAME};
pub use runtime::{run, HostError};

pub use tokio_util::sync::CancellationToken;
