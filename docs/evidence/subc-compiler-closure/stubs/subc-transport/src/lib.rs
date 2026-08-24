//! Compile-closure stub for `subc-transport` (private 0.5.1); each public
//! item is one row of the subc API surface inventory, every body is
//! `unimplemented!()`, and the crate is compiled but never executed.

use std::path::Path;
use std::time::Duration;

use subc_protocol::Frame;
use tokio::net::TcpStream;

/// Row: `ConnectionInfo` (read + write side) — literal `{ schema,
/// wire_version, endpoints, key, daemon_id, pid, daemon_ver }`;
/// `.endpoints.first()` on the read side.
pub struct ConnectionInfo {
    pub schema: u32,
    pub wire_version: Option<u8>,
    pub endpoints: Vec<Endpoint>,
    pub key: Vec<u8>,
    pub daemon_id: [u8; 16],
    pub pid: u32,
    pub daemon_ver: String,
}

/// Row: `Endpoint`, `SCHEMA_VERSION` — `{ host, port }`; `u32` schema tag.
pub struct Endpoint {
    pub host: String,
    pub port: u16,
}

/// Row: `Endpoint`, `SCHEMA_VERSION`.
pub const SCHEMA_VERSION: u32 = 1;

/// Row: `AuthError` — producer error variant.
#[derive(Debug)]
pub struct AuthError {
    _private: (),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, _f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        unimplemented!("compile-closure stub")
    }
}

/// `std::error::Error` demanded by `historian_producer.rs:524`
/// (`source()` casts `&AuthError` to `&dyn StdError`, E0277).
impl std::error::Error for AuthError {}


/// Row: `ConnectionFileError` — producer error variant, carried with the path.
#[derive(Debug)]
pub struct ConnectionFileError {
    _private: (),
}

impl std::fmt::Display for ConnectionFileError {
    fn fmt(&self, _f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        unimplemented!("compile-closure stub")
    }
}

/// `std::error::Error` demanded by `historian_producer.rs:522`
/// (`source()` casts `&ConnectionFileError` to `&dyn StdError`, E0277).
impl std::error::Error for ConnectionFileError {}


/// Row: `FrameIoError` — `From` source for the producer error enum.
#[derive(Debug)]
pub struct FrameIoError {
    _private: (),
}

impl std::fmt::Display for FrameIoError {
    fn fmt(&self, _f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        unimplemented!("compile-closure stub")
    }
}

/// `std::error::Error` demanded by `historian_producer.rs:525`
/// (`source()` casts `&FrameIoError` to `&dyn StdError`, E0277).
impl std::error::Error for FrameIoError {}


/// Row: `authenticate_client` — `(&mut stream, &ConnectionInfo, Duration)`.
pub async fn authenticate_client(
    _stream: &mut TcpStream,
    _info: &ConnectionInfo,
    _timeout: Duration,
) -> Result<(), AuthError> {
    unimplemented!("compile-closure stub")
}

/// Row: `authenticate_server` — `(&mut stream, &key, &daemon_id, ver,
/// Duration)`. Test-classified surface.
pub async fn authenticate_server(
    _stream: &mut TcpStream,
    _key: &[u8],
    _daemon_id: &[u8; 16],
    _daemon_ver: &str,
    _timeout: Duration,
) -> Result<(), AuthError> {
    unimplemented!("compile-closure stub")
}

/// Row: `read_frame` — `-> Result<Option<Frame>, FrameIoError>`;
/// `None` = peer closed.
pub async fn read_frame(_stream: &mut TcpStream) -> Result<Option<Frame>, FrameIoError> {
    unimplemented!("compile-closure stub")
}

/// Row: `write_frame` — `(&mut stream, &Frame)`.
pub async fn write_frame(_stream: &mut TcpStream, _frame: &Frame) -> Result<(), FrameIoError> {
    unimplemented!("compile-closure stub")
}

/// Row: `generate_key` — `-> Result<Vec<u8>, _>`. Test-classified surface.
pub fn generate_key() -> Result<Vec<u8>, AuthError> {
    unimplemented!("compile-closure stub")
}

/// Row: `generate_daemon_id` — `-> Result<[u8; 16], _>`. Test-classified.
pub fn generate_daemon_id() -> Result<[u8; 16], AuthError> {
    unimplemented!("compile-closure stub")
}

/// Row: `write_atomic` — writes a `ConnectionInfo` a real client can read.
/// Test-classified surface.
pub fn write_atomic(_path: &Path, _info: &ConnectionInfo) -> Result<(), ConnectionFileError> {
    unimplemented!("compile-closure stub")
}

pub mod connection_file {
    use std::path::Path;

    use super::{ConnectionFileError, ConnectionInfo};

    /// Row: `connection_file::read` — `-> Result<ConnectionInfo,
    /// ConnectionFileError>`.
    pub fn read(_path: &Path) -> Result<ConnectionInfo, ConnectionFileError> {
        unimplemented!("compile-closure stub")
    }
}
