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
pub mod generation;
pub mod handler;
pub mod harness_closure;
pub mod lifecycle;
#[doc(hidden)]
pub mod ring_transport;
pub mod synapse;

mod connection;
mod control;
mod dispatch;
mod file_mode;
#[doc(hidden)]
pub mod frame_channel;
mod instance;
mod panic_boundary;
mod routing;
mod runtime;
#[doc(hidden)]
pub mod setup_socket;
// Ring setup and tests name raw envelope types, while the managed client API
// exposes only responses, stream items, and call errors.
#[doc(hidden)]
pub mod wire;

pub use auth::{
    authenticate_client, authenticate_server, compute_proof, AuthError, AuthStage, Authenticated,
    ClientAuth, ClientAuthenticated, ClientHello, ServerProof, CLIENT_AUTH_DOMAIN,
    DEFAULT_CLIENT_ROLE, MAX_AUTH_MESSAGE_LEN, NONCE_LEN, PROOF_LEN, SERVER_PROOF_DOMAIN,
};
pub use client::{
    CallError, Client, ClientError, HostStatusSnapshot, RequestOptions, Response, ResponseStream,
    SendOutcome, StreamItem, CLIENT_CONTROL_QUEUE_FRAMES, CLIENT_DATA_QUEUE_FRAMES,
    CLIENT_FRAME_TIMEOUT, CLIENT_HANDSHAKE_TIMEOUT, CLIENT_MAX_LIVE_STREAMS,
    CLIENT_MAX_PENDING_REQUESTS, CLIENT_QUEUED_BYTES, CLIENT_REQUEST_TIMEOUT,
    CLIENT_RETAINED_RESPONSE_BYTES, CLIENT_ROUTE_OPEN_TIMEOUT, CLIENT_SHUTDOWN_TIMEOUT,
    CLIENT_STREAM_QUEUE_ITEMS,
};
pub use composite::{
    CompositeComponent, PrimaryComponent, SecondaryComponent, ShutdownError, StaticComposite,
};
pub use config::{ConfigError, HostConfig, HostInit, HostLimits, HostTiming, LivenessPolicy};
pub use connection_file::{
    read_for_client as read_connection_file, ConnectionFileError, ConnectionInfo, DAEMON_ID_LEN,
    KEY_LEN, MAX_CONNECTION_FILE_LEN, MIN_KEY_LEN, SCHEMA_VERSION,
};
pub use handler::{
    BindOutcome, HealthReport, HealthStatus, InitError, ManifestSnapshot, McHostHandler,
    OutputBuffer, RequestCtx, RequestOutcome, ResourceDeclaration, RouteClass, RouteHandle,
    RouteIdentity, RouteTarget, StreamClosed, TargetKind,
};
pub use instance::{
    data_dir_path, managed_dir_path, runtime_dir_path, InstanceError, CONNECTION_FILE_NAME,
    MANAGED_DIR_NAME,
};
pub use lifecycle::{
    coordination_dir_path, is_canonical_payload_digest, lifecycle_dir_path, probe_lifecycle,
    LifecyclePhase, LifecycleProbe, LifecycleRecord, LifecycleState, LifecycleTransactionLock,
    NamespaceAnchor, ProbeFreshness, PublicationSummary, COORDINATION_DIR_NAME,
    LIFECYCLE_RECORD_NAME, LIFETIME_LOCK_NAME, PAYLOAD_MANIFEST_DIGEST_LEN, TRANSACTION_LOCK_NAME,
    UNSUPPORTED_STATE_SCHEMA_REASON,
};
pub use runtime::{run, run_with_publish_hook, HostError};
/// The version-2 body cap. Published so a consumer preparing an output can
/// gate on the same value frame admission enforces, rather than restating it.
pub use wire::MAX_FRAME_BODY_LEN;
/// Launch-identity environment variable names. Published so module-side code
/// reads the same names the host injects at spawn, rather than restating the
/// protocol vocabulary as string literals.
pub use wire::{SUBC_LAUNCH_NONCE_ENV, SUBC_MODULE_ID_ENV};

pub use tokio_util::sync::CancellationToken;
