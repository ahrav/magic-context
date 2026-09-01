
use std::path::Path;
use std::time::Duration;

use subc_protocol::Frame;
use tokio::net::TcpStream;

pub struct ConnectionInfo {
    pub schema: u32,
    pub wire_version: Option<u8>,
    pub endpoints: Vec<Endpoint>,
    pub key: Vec<u8>,
    pub daemon_id: [u8; 16],
    pub pid: u32,
    pub daemon_ver: String,
}

pub struct Endpoint {
    pub host: String,
    pub port: u16,
}

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug)]
pub struct AuthError {
    _private: (),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, _f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        unimplemented!("compile-closure stub")
    }
}

impl std::error::Error for AuthError {}


#[derive(Debug)]
pub struct ConnectionFileError {
    _private: (),
}

impl std::fmt::Display for ConnectionFileError {
    fn fmt(&self, _f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        unimplemented!("compile-closure stub")
    }
}

impl std::error::Error for ConnectionFileError {}


#[derive(Debug)]
pub struct FrameIoError {
    _private: (),
}

impl std::fmt::Display for FrameIoError {
    fn fmt(&self, _f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        unimplemented!("compile-closure stub")
    }
}

impl std::error::Error for FrameIoError {}


pub async fn authenticate_client(
    _stream: &mut TcpStream,
    _info: &ConnectionInfo,
    _timeout: Duration,
) -> Result<(), AuthError> {
    unimplemented!("compile-closure stub")
}

pub async fn authenticate_server(
    _stream: &mut TcpStream,
    _key: &[u8],
    _daemon_id: &[u8; 16],
    _daemon_ver: &str,
    _timeout: Duration,
) -> Result<(), AuthError> {
    unimplemented!("compile-closure stub")
}

/// `read_frame` returns `None` when the peer closes the connection.
pub async fn read_frame(_stream: &mut TcpStream) -> Result<Option<Frame>, FrameIoError> {
    unimplemented!("compile-closure stub")
}

pub async fn write_frame(_stream: &mut TcpStream, _frame: &Frame) -> Result<(), FrameIoError> {
    unimplemented!("compile-closure stub")
}

pub fn generate_key() -> Result<Vec<u8>, AuthError> {
    unimplemented!("compile-closure stub")
}

pub fn generate_daemon_id() -> Result<[u8; 16], AuthError> {
    unimplemented!("compile-closure stub")
}

/// Test-classified surface.
pub fn write_atomic(_path: &Path, _info: &ConnectionInfo) -> Result<(), ConnectionFileError> {
    unimplemented!("compile-closure stub")
}

pub mod connection_file {
    use std::path::Path;

    use super::{ConnectionFileError, ConnectionInfo};

    /// ConnectionFileError>`.
    pub fn read(_path: &Path) -> Result<ConnectionInfo, ConnectionFileError> {
        unimplemented!("compile-closure stub")
    }
}
