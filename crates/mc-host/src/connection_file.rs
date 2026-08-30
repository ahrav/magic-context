//! Host-owned connection-file schema and secure discovery.
//!
//! Reads stay anchored to open directory and file descriptors. The path is
//! traversed without following links, the owner-only regular file is bounded
//! before JSON parsing, and a canonical-name replacement during the read is
//! rejected. Connection key bytes never appear in formatting or errors.

use std::{
    error::Error,
    ffi::OsString,
    fmt, io,
    path::{Path, PathBuf},
};

use rustix::{
    fd::OwnedFd,
    fs::{openat, Mode, OFlags},
};
use serde::{Deserialize, Serialize};

use crate::{
    instance::{is_safe_ancestor, is_secure_regular, mode_bits, read_all_fd, S_IFDIR, S_IFMT},
    wire::PROTOCOL_VERSION,
};

pub const SCHEMA_VERSION: u32 = 2;
pub const MIN_KEY_LEN: usize = 32;
pub const KEY_LEN: usize = 32;
pub const DAEMON_ID_LEN: usize = 16;
pub const MAX_CONNECTION_FILE_LEN: usize = 65_536;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionInfo {
    pub schema: u32,
    pub wire_version: u8,
    pub setup_socket: String,
    pub key: Vec<u8>,
    pub daemon_id: [u8; DAEMON_ID_LEN],
    pub pid: u32,
    pub daemon_ver: String,
}

impl fmt::Debug for ConnectionInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnectionInfo")
            .field("schema", &self.schema)
            .field("wire_version", &self.wire_version)
            .field("setup_socket", &self.setup_socket)
            .field("key", &format_args!("<{} bytes redacted>", self.key.len()))
            .field("daemon_id", &self.daemon_id)
            .field("pid", &self.pid)
            .field("daemon_ver", &self.daemon_ver)
            .finish()
    }
}

impl ConnectionInfo {
    pub fn validate(&self) -> Result<(), ConnectionFileError> {
        if self.schema != SCHEMA_VERSION {
            return Err(ConnectionFileError::UnsupportedSchema {
                schema: self.schema,
                supported: SCHEMA_VERSION,
            });
        }
        if self.wire_version != PROTOCOL_VERSION {
            return Err(ConnectionFileError::WireVersionMismatch {
                file: self.wire_version,
                supported: PROTOCOL_VERSION,
            });
        }
        if self.setup_socket.is_empty() || !Path::new(&self.setup_socket).is_absolute() {
            return Err(ConnectionFileError::Invalid("invalid setup socket path"));
        }
        if self.key.len() != KEY_LEN {
            return Err(ConnectionFileError::InvalidKeyLength {
                len: self.key.len(),
                expected: KEY_LEN,
            });
        }
        if self.daemon_ver.is_empty() {
            return Err(ConnectionFileError::Invalid("empty daemon version"));
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum ConnectionFileError {
    InvalidPath {
        path: PathBuf,
    },
    Io {
        op: &'static str,
        path: PathBuf,
        source: io::Error,
    },
    Insecure {
        path: PathBuf,
    },
    TooLarge {
        path: PathBuf,
        max: usize,
    },
    Replaced {
        path: PathBuf,
    },
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
    UnsupportedSchema {
        schema: u32,
        supported: u32,
    },
    WireVersionMismatch {
        file: u8,
        supported: u8,
    },
    Invalid(&'static str),
    InvalidKeyLength {
        len: usize,
        expected: usize,
    },
}

impl fmt::Display for ConnectionFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath { path } => {
                write!(f, "invalid connection file path {}", path.display())
            }
            Self::Io { op, path, source } => {
                write!(f, "connection file {op} failed for {}: {source}", path.display())
            }
            Self::Insecure { path } => write!(
                f,
                "refusing insecure connection file at {}: wrong type, owner, mode, or link count",
                path.display()
            ),
            Self::TooLarge { path, max } => write!(
                f,
                "connection file {} exceeds {max} byte limit",
                path.display()
            ),
            Self::Replaced { path } => {
                write!(f, "connection file {} changed while reading", path.display())
            }
            Self::Json { path, source } => write!(
                f,
                "connection file JSON read failed for {}: {source}",
                path.display()
            ),
            Self::UnsupportedSchema { schema, supported } => write!(
                f,
                "unsupported connection file schema {schema}; expected {supported}"
            ),
            Self::WireVersionMismatch { file, supported } => write!(
                f,
                "connection file wire version {file} does not match supported wire version {supported}"
            ),
            Self::Invalid(reason) => write!(f, "invalid connection file: {reason}"),
            Self::InvalidKeyLength { len, expected } => write!(
                f,
                "connection file key is {len} bytes; expected exactly {expected}"
            ),
        }
    }
}

impl Error for ConnectionFileError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Json { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// Reads one secure connection-file snapshot. Validation completes before a
/// caller can use its endpoint, so invalid versions never reach a dial.
pub fn read_for_client(path: impl AsRef<Path>) -> Result<ConnectionInfo, ConnectionFileError> {
    let path = path.as_ref();
    let (parent, name) = open_parent(path)?;
    let fd = open_file(&parent, &name, path)?;
    let before = checked_stat(&fd, path)?;
    if before.st_size < 0 || before.st_size as u64 > MAX_CONNECTION_FILE_LEN as u64 {
        return Err(ConnectionFileError::TooLarge {
            path: path.to_path_buf(),
            max: MAX_CONNECTION_FILE_LEN,
        });
    }
    let bytes = read_all_fd(&fd, MAX_CONNECTION_FILE_LEN).map_err(|source| {
        if source.kind() == io::ErrorKind::InvalidData {
            ConnectionFileError::TooLarge {
                path: path.to_path_buf(),
                max: MAX_CONNECTION_FILE_LEN,
            }
        } else {
            io_error("read", path, source)
        }
    })?;
    let after = rustix::fs::fstat(&fd)
        .map_err(|source| io_error("fstat_after_read", path, source.into()))?;
    let current = open_file(&parent, &name, path)?;
    let current = checked_stat(&current, path)?;
    if !same_snapshot(&before, &after) || !same_snapshot(&before, &current) {
        return Err(ConnectionFileError::Replaced {
            path: path.to_path_buf(),
        });
    }

    let info = serde_json::from_slice::<ConnectionInfo>(&bytes).map_err(|source| {
        ConnectionFileError::Json {
            path: path.to_path_buf(),
            source,
        }
    })?;
    info.validate()?;
    Ok(info)
}

fn open_parent(path: &Path) -> Result<(OwnedFd, OsString), ConnectionFileError> {
    let name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| ConnectionFileError::InvalidPath {
            path: path.to_path_buf(),
        })?
        .to_os_string();
    let parent = path
        .parent()
        .ok_or_else(|| ConnectionFileError::InvalidPath {
            path: path.to_path_buf(),
        })?;
    // Anchor open, ancestor-safety proof, and component classification are shared
    // with `instance::secure_runtime_dir`. The walks themselves are not: that one
    // creates and tightens the host's own runtime directory, while this one is
    // read-only discovery. Only the hardening rules are common, and those are the
    // part that must never drift.
    let mut current = crate::instance::open_safe_anchor(path)
        .map_err(|source| io_error("open_anchor", path, source.into()))?
        .ok_or_else(|| ConnectionFileError::Insecure {
            path: path.to_path_buf(),
        })?;
    validate_directory(&current, path, false)?;

    let components = crate::instance::normal_components(parent).ok_or_else(|| {
        ConnectionFileError::InvalidPath {
            path: path.to_path_buf(),
        }
    })?;
    for component in components {
        current = openat(
            &current,
            component,
            crate::instance::HARDENED_DIR_FLAGS,
            Mode::empty(),
        )
        .map_err(|source| io_error("open_parent", path, source.into()))?;
        validate_directory(&current, path, false)?;
    }
    validate_directory(&current, path, true)?;
    Ok((current, name))
}

fn validate_directory(
    fd: &OwnedFd,
    path: &Path,
    require_private: bool,
) -> Result<(), ConnectionFileError> {
    let stat =
        rustix::fs::fstat(fd).map_err(|source| io_error("fstat_parent", path, source.into()))?;
    // `mode_bits` and not `stat.st_mode`: `st_mode` is `u16` on Darwin and `u32`
    // on Linux, so mixing it with the `u32` type constants compiles on one target
    // and not the other. Every other mode check in this crate already goes
    // through that helper.
    let mode = mode_bits(&stat);
    let directory = (mode & S_IFMT) == S_IFDIR;
    let private = stat.st_uid == rustix::process::geteuid().as_raw() && mode & 0o077 == 0;
    if !directory || !is_safe_ancestor(&stat) || (require_private && !private) {
        return Err(ConnectionFileError::Insecure {
            path: path.to_path_buf(),
        });
    }
    Ok(())
}

fn open_file(
    parent: &OwnedFd,
    name: &OsString,
    path: &Path,
) -> Result<OwnedFd, ConnectionFileError> {
    // `NONBLOCK` so a special file reaches metadata validation instead of
    // stalling here: opening a FIFO for reading blocks until a writer appears,
    // which is before `checked_stat` gets to reject it as non-regular — so the
    // fail-closed contract never runs and the caller hangs. It cannot leak into
    // the read: `checked_stat` proves `S_IFREG` first, and a regular file never
    // reports `EAGAIN`. The TypeScript reader passes the same flag.
    openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    )
    .map_err(|source| io_error("open", path, source.into()))
}

fn checked_stat(fd: &OwnedFd, path: &Path) -> Result<rustix::fs::Stat, ConnectionFileError> {
    let stat = rustix::fs::fstat(fd).map_err(|source| io_error("fstat", path, source.into()))?;
    if !is_secure_regular(&stat) {
        return Err(ConnectionFileError::Insecure {
            path: path.to_path_buf(),
        });
    }
    Ok(stat)
}

fn same_snapshot(left: &rustix::fs::Stat, right: &rustix::fs::Stat) -> bool {
    left.st_dev == right.st_dev
        && left.st_ino == right.st_ino
        && left.st_size == right.st_size
        && left.st_mtime == right.st_mtime
        && left.st_mtime_nsec == right.st_mtime_nsec
        && left.st_ctime == right.st_ctime
        && left.st_ctime_nsec == right.st_ctime_nsec
}

fn io_error(op: &'static str, path: &Path, source: io::Error) -> ConnectionFileError {
    ConnectionFileError::Io {
        op,
        path: path.to_path_buf(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `st_mode` is `u16` on Darwin and `u32` on Linux, so mode arithmetic against
    /// this crate's `u32` type constants compiles on one target and not the other.
    /// `mode_bits` is the cfg-gated widening that makes it portable, and reading
    /// `st_mode` directly bypassed it — a break no Linux build could catch, which
    /// is why it reached CI as a macOS-only failure.
    #[test]
    fn mode_arithmetic_goes_through_the_portable_accessor() {
        for source in [
            include_str!("connection_file.rs"),
            include_str!("instance.rs"),
        ] {
            let production = source
                .split("#[cfg(test)]\nmod tests {")
                .next()
                .expect("production source");
            for (number, line) in production.lines().enumerate() {
                // Prose may name the field while explaining why not to use it.
                let code = line.split("//").next().unwrap_or("");
                // The accessor's own two cfg branches are the one place that may
                // touch the field.
                if code.contains("u32::from(stat.st_mode)") || code.trim() == "stat.st_mode" {
                    continue;
                }
                assert!(
                    !code.contains(".st_mode"),
                    "line {} reads st_mode directly instead of mode_bits(): {}",
                    number + 1,
                    line.trim()
                );
            }
        }
    }

    fn info() -> ConnectionInfo {
        ConnectionInfo {
            schema: SCHEMA_VERSION,
            wire_version: PROTOCOL_VERSION,
            setup_socket: "/tmp/mc-host.sock".to_owned(),
            key: vec![7; KEY_LEN],
            daemon_id: [8; DAEMON_ID_LEN],
            pid: 9,
            daemon_ver: "test".to_owned(),
        }
    }

    /// A FIFO at the configured path must be rejected, not waited on. Without
    /// `NONBLOCK` the open itself parks until a writer appears, so this call
    /// never returns and `Client::connect` hangs with it.
    ///
    /// The scratch directory is chmodded to owner-only on purpose: `open_parent`
    /// requires a private leaf parent, so a default-mode temp directory is
    /// rejected before `open_file` runs and the test would pass without ever
    /// reaching the open under test.
    #[test]
    fn a_fifo_is_rejected_rather_than_blocking_the_open() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("mc-fifo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .expect("owner-only scratch dir");
        let path = dir.join("subc-connection.json");
        let _ = std::fs::remove_file(&path);
        // The POSIX `mkfifo` utility, not rustix: rustix gates both `mknodat` and
        // `mkfifoat` away from Apple targets, and this crate is
        // `deny(unsafe_code)`, so calling `mkfifo(2)` directly is not available
        // either. The rejection matters just as much on macOS, so the test stays
        // compiled on every platform rather than being cfg'd out on the one whose
        // absence let a build break reach CI unnoticed.
        let made = std::process::Command::new("mkfifo")
            .arg(&path)
            .status()
            .expect("mkfifo is a POSIX utility present on every supported platform");
        assert!(made.success(), "mkfifo failed: {made:?}");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .expect("owner-only fifo");

        // No writer is ever opened, so a blocking open can never complete.
        // Bounded on a worker thread rather than called directly: a regression
        // hangs instead of returning, and this turns that into a failure rather
        // than a wedged suite.
        let (tx, rx) = std::sync::mpsc::channel();
        let probe = path.clone();
        std::thread::spawn(move || {
            let _ = tx.send(read_for_client(&probe).map_err(|error| format!("{error:?}")));
        });
        let outcome = rx.recv_timeout(std::time::Duration::from_secs(5));

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);

        let outcome = outcome.expect("the open must not block on a writer that never arrives");
        let error = outcome.expect_err("a FIFO is not a connection file");
        assert!(
            error.contains("Insecure"),
            "expected an insecure-type rejection, got {error}"
        );
    }

    #[test]
    fn strict_wire_version_rejects_missing_null_string_and_other() {
        let valid = serde_json::to_value(info()).expect("serialize");
        for version in [
            None,
            Some(serde_json::Value::Null),
            Some(serde_json::json!("2")),
            Some(serde_json::json!(1)),
        ] {
            let mut candidate = valid.clone();
            let object = candidate.as_object_mut().expect("object");
            match version {
                Some(value) => {
                    object.insert("wire_version".to_owned(), value);
                }
                None => {
                    object.remove("wire_version");
                }
            }
            assert!(serde_json::from_value::<ConnectionInfo>(candidate)
                .and_then(|info| info.validate().map_err(serde::de::Error::custom))
                .is_err());
        }
    }

    #[test]
    fn debug_redacts_key() {
        let rendered = format!("{:?}", info());
        assert!(rendered.contains("redacted"));
        assert!(!rendered.contains("7, 7"));
    }
}
