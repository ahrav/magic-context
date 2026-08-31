//! This crate is a compile-closure stub for `subc-protocol`.
//!
//! executed.
//!
#![allow(clippy::new_without_default)]

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u8 = 1;
/// Row: `SUBC_MODULE_ID_ENV`.
pub const SUBC_MODULE_ID_ENV: &str = "SUBC_MODULE_ID";
/// Row: `SUBC_LAUNCH_NONCE_ENV`.
pub const SUBC_LAUNCH_NONCE_ENV: &str = "SUBC_LAUNCH_NONCE";

#[derive(Clone, Serialize, Deserialize)]
pub struct BindIdentity {
    pub project_root: PathBuf,
    pub harness: String,
    pub session: String,
}

/// `assert_eq!` (E0369/E0277).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RouteTarget {
    ManagementSurface { module_id: String },
    ToolProvider { module_id: String },
}

#[derive(Debug)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

impl ErrorBody {
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

pub struct Flags {
    _private: (),
}

impl Flags {
    pub fn new(_binary: bool, _priority: Priority, _last: bool) -> Self {
        unimplemented!("compile-closure stub")
    }
}

///
/// (E0277).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FrameType {
    Request,
    Response,
    Error,
    StreamData,
    StreamEnd,
    Goodbye,
    Ping,
}

pub struct EnvelopeHeader {
    pub ty: FrameType,
    pub channel: u16,
    pub epoch: u32,
    pub corr: u64,
}

pub struct Frame {
    pub header: EnvelopeHeader,
    pub body: Vec<u8>,
}

impl Frame {
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

#[derive(Debug)]
pub struct FrameBuildError {
    _private: (),
}

impl std::fmt::Display for FrameBuildError {
    fn fmt(&self, _f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        unimplemented!("compile-closure stub")
    }
}

/// `source()` requires `FrameBuildError: std::error::Error`.
impl std::error::Error for FrameBuildError {}


pub struct ModuleHelloAckBody {
    pub storage: Option<Value>,
}

pub mod manifest {
    use serde::{Deserialize, Serialize};
    use serde_json::Value;

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

    /// `assert_eq!` requires `ConsumerRole: Debug + PartialEq`.
    #[derive(Debug, PartialEq)]
    pub enum ConsumerRole {
        ServiceClient { of: Vec<String> },
    }

    pub struct Bindings {
        pub storage: StorageBinding,
        pub vault_grants: Vec<String>,
        pub identity: IdentityBinding,
    }

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

    pub struct IdentityBinding {
        pub requires: Vec<IdentityScope>,
        pub optional: Vec<IdentityScope>,
    }

    pub enum IdentityScope {
        Project,
        Session,
    }

    /// Row: `manifest::Concurrency::ModuleManaged`.
    pub enum Concurrency {
        ModuleManaged,
    }

    #[derive(Serialize, Deserialize)]
    pub struct Tool {
        pub name: String,
        pub description: Option<String>,
        pub execution_mode: ExecutionMode,
        pub schema: Value,
    }

    /// `assert_eq!` requires `ExecutionMode: Debug`.
    /// (E0277).
    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    pub enum ExecutionMode {
        Pure,
        Mutating,
    }
}
