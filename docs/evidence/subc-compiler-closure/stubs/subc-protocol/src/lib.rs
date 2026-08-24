//! STRICT compile-closure stub for `subc-protocol` (private 0.12.0).
//!
//! Every public item maps to a row in the verified subc API surface
//! inventory. Function bodies are `unimplemented!()`, except `ErrorBody::new`,
//! which carries its trivial field-assignment body (and, like every other stub
//! body, is never executed): this crate exists only
//! to prove that the inventory is a COMPLETE enumeration of the surface
//! `mc-module` compiles against. Binaries linked against it must never be
//! executed.
//!
//! Positive control: `FrameType::Ping` (present below) was deliberately left
//! out of the seeded stub so the pass had to prove the compiler detects an
//! inventory miss; `compiler-error-ledger.md` entry 1 records the diagnostic
//! that demanded it.
#![allow(clippy::new_without_default)]

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Row: `PROTOCOL_VERSION` — u8, sent in the manifest and connection file.
pub const PROTOCOL_VERSION: u8 = 1;
/// Row: `SUBC_MODULE_ID_ENV`.
pub const SUBC_MODULE_ID_ENV: &str = "SUBC_MODULE_ID";
/// Row: `SUBC_LAUNCH_NONCE_ENV`.
pub const SUBC_LAUNCH_NONCE_ENV: &str = "SUBC_LAUNCH_NONCE";

/// Row: `BindIdentity` — `{ project_root, harness, session }`; `Clone`
/// demanded by `session_resolver.rs:101` (`identity.clone()`, E0599).
#[derive(Clone, Serialize, Deserialize)]
pub struct BindIdentity {
    pub project_root: PathBuf,
    pub harness: String,
    pub session: String,
}

/// Row: `RouteTarget` — serde `tag = "kind"`, snake_case.
/// Rows: `RouteTarget::ManagementSurface`, `RouteTarget::ToolProvider`.
/// `Clone` demanded by `session_resolver.rs:100` (`target.clone()`, E0599);
/// `PartialEq` + `Debug` by the `session_resolver.rs:255` unit-test
/// `assert_eq!` (E0369/E0277).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RouteTarget {
    ManagementSurface { module_id: String },
    ToolProvider { module_id: String },
}

/// Row: `ErrorBody` — pub `code`, `message`. `Debug` is structural: the
/// `CallError` row records `Display + Debug`, and `CallError::Module`
/// carries an `ErrorBody`.
#[derive(Debug)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

impl ErrorBody {
    /// Row: `ErrorBody::new(code, message)` — status `changed` (absent in
    /// published 0.10.0; private-tree addition).
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// Row: `Priority::Interactive`.
pub enum Priority {
    Interactive,
}

/// Row: `Flags` / `Flags::new(binary, priority, last)`.
pub struct Flags {
    _private: (),
}

impl Flags {
    pub fn new(_binary: bool, _priority: Priority, _last: bool) -> Self {
        unimplemented!("compile-closure stub")
    }
}

/// Row: `FrameType` — variants used by mc-module; `Copy + PartialEq`.
///
/// `Ping` is omitted at seed time as the positive control (see crate doc).
/// `Debug` demanded by the `tests/broca_roundtrip.rs:583` `assert_eq!`
/// (E0277).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FrameType {
    Request,
    Response,
    Error,
    StreamData,
    StreamEnd,
    Goodbye,
    /// The producer's liveness check compares against this variant
    /// (`frame.header.ty != FrameType::Ping`, `tests/broca_roundtrip.rs:544`).
    /// This is the seed omission the pass had to detect; the captured
    /// diagnostic is `compiler-error-ledger.md` entry 1.
    Ping,
}

/// Row: `EnvelopeHeader` fields — `frame.header.{ty, channel, epoch, corr}`.
pub struct EnvelopeHeader {
    pub ty: FrameType,
    pub channel: u16,
    pub epoch: u32,
    pub corr: u64,
}

/// Row: `Frame` — `{ header, body }`, both pub.
pub struct Frame {
    pub header: EnvelopeHeader,
    pub body: Vec<u8>,
}

impl Frame {
    /// Row: `Frame::build(ty, flags, channel, epoch, corr, body)`.
    pub fn build(
        _ty: FrameType,
        _flags: Flags,
        _channel: u16,
        _epoch: u32,
        _corr: u64,
        _body: Vec<u8>,
    ) -> Result<Frame, FrameBuildError> {
        unimplemented!("compile-closure stub")
    }
}

/// Row: `FrameBuildError` — `From` source for producer error enums.
#[derive(Debug)]
pub struct FrameBuildError {
    _private: (),
}

impl std::fmt::Display for FrameBuildError {
    fn fmt(&self, _f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        unimplemented!("compile-closure stub")
    }
}

/// `std::error::Error` demanded by `historian_producer.rs:526`
/// (`source()` casts `&FrameBuildError` to `&dyn StdError`, E0277).
impl std::error::Error for FrameBuildError {}


/// Row: `ModuleHelloAckBody` / `.storage: Option<Value>`.
pub struct ModuleHelloAckBody {
    pub storage: Option<Value>,
}

pub mod manifest {
    use serde::{Deserialize, Serialize};
    use serde_json::Value;

    /// Row: `manifest::ModuleManifest` — struct literal WITHOUT
    /// `scheduled_tasks` (status `changed`: published 0.10.0 requires it,
    /// the private 0.12.0 shape mc-module initializes does not).
    pub struct ModuleManifest {
        pub module_id: String,
        pub module_version: String,
        pub protocol_ver: u8,
        pub trust_tier: TrustTier,
        pub provides: Vec<ProviderRole>,
        pub consumes: Vec<ConsumerRole>,
        pub bindings: Bindings,
    }

    /// Row: `manifest::TrustTier::FirstParty`.
    pub enum TrustTier {
        FirstParty,
    }

    /// Row: `manifest::ProviderRole::ToolProvider`.
    pub enum ProviderRole {
        ToolProvider {
            tools: Vec<Tool>,
            identity_scope: Vec<IdentityScope>,
            concurrency: Concurrency,
            emits_push: bool,
            sub_supervises: bool,
        },
    }

    /// Row: `manifest::ConsumerRole::ServiceClient` — `{ of: Vec<String> }`.
    /// `PartialEq` is required because a unit test compares
    /// `manifest().consumes` with `assert_eq!` (mc-module lib.rs:16853), and
    /// `Debug` because `assert_eq!` formats both sides on failure. See
    /// `compiler-error-ledger.md` entry 2.
    #[derive(Debug, PartialEq)]
    pub enum ConsumerRole {
        ServiceClient { of: Vec<String> },
    }

    /// Row: `manifest::Bindings` — `{ storage, vault_grants, identity }`.
    pub struct Bindings {
        pub storage: StorageBinding,
        pub vault_grants: Vec<String>,
        pub identity: IdentityBinding,
    }

    /// Row: `manifest::StorageBinding` — `{ kind, scope, owns_schema }`.
    pub struct StorageBinding {
        pub kind: StorageKind,
        pub scope: StorageScope,
        pub owns_schema: bool,
    }

    /// Row: `manifest::StorageKind::Sqlite`.
    pub enum StorageKind {
        Sqlite,
    }

    /// Row: `manifest::StorageScope::Project`.
    pub enum StorageScope {
        Project,
    }

    /// Row: `manifest::IdentityBinding` — `{ requires, optional }`.
    pub struct IdentityBinding {
        pub requires: Vec<IdentityScope>,
        pub optional: Vec<IdentityScope>,
    }

    /// Row: `manifest::IdentityScope` — `Project`, `Session`.
    pub enum IdentityScope {
        Project,
        Session,
    }

    /// Row: `manifest::Concurrency::ModuleManaged`.
    pub enum Concurrency {
        ModuleManaged,
    }

    /// Row: `manifest::Tool` — serde must round-trip.
    #[derive(Serialize, Deserialize)]
    pub struct Tool {
        pub name: String,
        pub description: Option<String>,
        pub execution_mode: ExecutionMode,
        pub schema: Value,
    }

    /// Row: `manifest::ExecutionMode` — `Pure`, `Mutating`; `PartialEq`.
    /// `Debug` demanded by the `prompt_surface.rs:338` unit-test `assert_eq!`
    /// (E0277).
    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    pub enum ExecutionMode {
        Pure,
        Mutating,
    }
}
