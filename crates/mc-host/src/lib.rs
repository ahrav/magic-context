//! Host runtime for the wire contract in `docs/mc-host-wire-protocol.md`.

// `deny` rather than `forbid`: the Broca subprocess spawner carries the one
// permitted `unsafe` block in this crate — a `pre_exec` hook that arms
// `PR_SET_PDEATHSIG` so harness children cannot outlive a crashed host.
// Every other module remains unsafe-free; new `unsafe` requires its own
// scoped `allow` and a safety justification.
#![deny(unsafe_code)]

pub mod auth;
pub mod broca;
pub mod client;
pub mod composite;
pub mod config;
pub mod connection_file;
pub mod handler;
pub mod lifecycle;
#[doc(hidden)]
pub mod provider_recovery;
#[doc(hidden)]
pub mod shm_provider;
pub mod synapse;
#[doc(hidden)]
pub mod transport_negotiation;
#[doc(hidden)]
pub mod transport_provider;

mod connection;
mod control;
mod dispatch;
#[doc(hidden)]
pub mod frame_channel;
mod frame_read;
mod instance;
mod panic_boundary;
mod routing;
mod runtime;
mod tcp_frame_channel;
// Doc-hidden rather than private because `shm_provider`'s public `send`/`recv`
// already take and return `EnvelopeHeader`, so the type must be nameable by any
// consumer of that module. Doc-hidden keeps it out of the documented surface:
// the managed `client` API still yields only `Response`, `StreamItem`, and
// `CallError`, so raw frame types never reach an ordinary caller.
#[doc(hidden)]
pub mod wire;

pub use auth::{
    authenticate_client, authenticate_server, compute_proof, AuthError, AuthStage, Authenticated,
    ClientAuth, ClientHello, ServerProof, CLIENT_AUTH_DOMAIN, DEFAULT_CLIENT_ROLE,
    MAX_AUTH_MESSAGE_LEN, NONCE_LEN, PROOF_LEN, SERVER_PROOF_DOMAIN,
};
pub use client::{
    CallError, Client, ClientError, RequestOptions, Response, ResponseStream, SendOutcome,
    StreamItem, CLIENT_CONTROL_QUEUE_FRAMES, CLIENT_DATA_QUEUE_FRAMES, CLIENT_FRAME_TIMEOUT,
    CLIENT_HANDSHAKE_TIMEOUT, CLIENT_MAX_LIVE_STREAMS, CLIENT_MAX_PENDING_REQUESTS,
    CLIENT_QUEUED_BYTES, CLIENT_REQUEST_TIMEOUT, CLIENT_RETAINED_RESPONSE_BYTES,
    CLIENT_ROUTE_OPEN_TIMEOUT, CLIENT_SHUTDOWN_TIMEOUT, CLIENT_STREAM_QUEUE_ITEMS,
};
pub use composite::{
    CompositeComponent, PrimaryComponent, SecondaryComponent, ShutdownError, StaticComposite,
};
pub use config::{ConfigError, HostConfig, HostInit, HostLimits, HostTiming, LivenessPolicy};
pub use connection_file::{
    read_for_client as read_connection_file, ConnectionFileError, ConnectionInfo, Endpoint,
    DAEMON_ID_LEN, KEY_LEN, MAX_CONNECTION_FILE_LEN, MIN_KEY_LEN, SCHEMA_VERSION,
};
pub use handler::{
    BindOutcome, HealthReport, HealthStatus, InitError, ManifestSnapshot, McHostHandler,
    OutputBuffer, RequestCtx, RequestOutcome, ResourceDeclaration, RouteClass, RouteHandle,
    RouteIdentity, RouteTarget, StreamClosed, TargetKind,
};
pub use instance::{runtime_dir_path, InstanceError, CONNECTION_FILE_NAME};
pub use lifecycle::{
    lifecycle_dir_path, probe_lifecycle, LifecyclePhase, LifecycleProbe, LifecycleRecord,
    LifecycleRootLock, LifecycleState, ProbeFreshness, PublicationSummary, LIFECYCLE_RECORD_NAME,
};
pub use runtime::{run, HostError};
/// The version-2 body cap. Published so a consumer preparing an output can
/// gate on the same value frame admission enforces, rather than restating it.
pub use wire::MAX_FRAME_BODY_LEN;
/// Launch-identity environment variable names. Published so module-side code
/// reads the same names the host injects at spawn, rather than restating the
/// protocol vocabulary as string literals.
pub use wire::{SUBC_LAUNCH_NONCE_ENV, SUBC_MODULE_ID_ENV};

pub use tokio_util::sync::CancellationToken;
