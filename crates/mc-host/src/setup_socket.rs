//! Authenticated setup-socket protocol and descriptor transfer.
//!
//! This module deliberately has no dependency on application frame types or
//! decoders. Its closed message set can authenticate one current-format ring,
//! activate it, commit it, and observe peer lifetime.

use std::io::{self, IoSlice, IoSliceMut};
use std::mem::MaybeUninit;
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::Path;
use std::time::Duration;

use rustix::io::{fcntl_setfd, FdFlags};
use rustix::net::{
    recvmsg, sendmsg, RecvAncillaryBuffer, RecvAncillaryMessage, RecvFlags, ReturnFlags,
    SendAncillaryBuffer, SendAncillaryMessage, SendFlags,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt, Interest};
use tokio::net::UnixStream;
use tokio::time::{timeout_at, Instant};

pub const MAX_SETUP_MESSAGE_LEN: usize = 16 * 1024;
pub const RING_DESCRIPTOR_COUNT: usize = 2;

pub(crate) fn bind_owner_only(path: &Path) -> io::Result<tokio::net::UnixListener> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            let secure_stale_socket = metadata.file_type().is_socket()
                && metadata.uid() == rustix::process::geteuid().as_raw()
                && metadata.mode() & 0o777 == 0o600;
            if !secure_stale_socket {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "refusing insecure setup socket occupant",
                ));
            }
            std::fs::remove_file(path)?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let listener = tokio::net::UnixListener::bind(path)?;
    if let Err(error) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        let _ = std::fs::remove_file(path);
        return Err(error);
    }
    Ok(listener)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename = "grant")]
pub struct GrantMessage {
    pub wire_version: u8,
    pub descriptor_schema: u16,
    pub activation_token: String,
    pub descriptor: serde_json::Value,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum ClientMessage {
    Activate {
        wire_version: u8,
        descriptor_schema: u16,
        activation_token: String,
    },
    Commit,
    Goodbye,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMessage {
    Activated,
    Committed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerClose {
    Goodbye,
    UnexpectedEof,
    ProtocolError,
}

#[derive(Debug)]
pub enum SetupError {
    Io(io::Error),
    Timeout,
    MessageTooLarge,
    InvalidMessage,
    InvalidIdentity,
    InvalidActivation,
    MissingDescriptors,
    DuplicateDescriptors,
    TruncatedAncillary,
}

impl From<io::Error> for SetupError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl std::fmt::Display for SetupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Io(_) => "setup socket I/O failed",
            Self::Timeout => "setup socket deadline expired",
            Self::MessageTooLarge => "setup socket message exceeds its bound",
            Self::InvalidMessage => "setup socket message is invalid",
            Self::InvalidIdentity => "setup socket identity does not match",
            Self::InvalidActivation => "setup socket activation token does not match",
            Self::MissingDescriptors => "setup socket descriptor transfer is incomplete",
            Self::DuplicateDescriptors => "setup socket transferred unexpected descriptors",
            Self::TruncatedAncillary => "setup socket ancillary data was truncated",
        })
    }
}

impl std::error::Error for SetupError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

/// Sends the grant and exactly two ring descriptors in one `SCM_RIGHTS` message.
pub async fn send_grant(
    stream: &mut UnixStream,
    grant: &GrantMessage,
    descriptors: &[OwnedFd; RING_DESCRIPTOR_COUNT],
    deadline: Instant,
) -> Result<(), SetupError> {
    let bytes = encode_message(grant)?;
    let borrowed: [BorrowedFd<'_>; RING_DESCRIPTOR_COUNT] =
        std::array::from_fn(|index| descriptors[index].as_fd());
    let sent = loop {
        timeout_at(deadline, stream.writable())
            .await
            .map_err(|_| SetupError::Timeout)??;
        let mut space =
            [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(RING_DESCRIPTOR_COUNT))];
        let mut ancillary = SendAncillaryBuffer::new(&mut space);
        if !ancillary.push(SendAncillaryMessage::ScmRights(&borrowed)) {
            return Err(SetupError::MissingDescriptors);
        }
        match stream.try_io(Interest::WRITABLE, || {
            sendmsg(
                stream.as_fd(),
                &[IoSlice::new(&bytes)],
                &mut ancillary,
                SendFlags::DONTWAIT,
            )
            .map_err(io::Error::from)
        }) {
            Ok(sent) => break sent,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
            Err(error) => return Err(error.into()),
        }
    };
    if sent == 0 {
        return Err(SetupError::Io(io::Error::new(
            io::ErrorKind::WriteZero,
            "descriptor message wrote zero bytes",
        )));
    }
    timeout_at(deadline, stream.write_all(&bytes[sent..]))
        .await
        .map_err(|_| SetupError::Timeout)??;
    Ok(())
}

/// Receives one grant and exactly two close-on-exec descriptors.
pub async fn receive_grant(
    stream: &mut UnixStream,
    deadline: Instant,
) -> Result<(serde_json::Value, [OwnedFd; RING_DESCRIPTOR_COUNT]), SetupError> {
    let mut bytes = vec![0u8; MAX_SETUP_MESSAGE_LEN + 4];
    let mut control =
        [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(RING_DESCRIPTOR_COUNT + 1))];
    let mut ancillary = RecvAncillaryBuffer::new(&mut control);
    let received = loop {
        timeout_at(deadline, stream.readable())
            .await
            .map_err(|_| SetupError::Timeout)??;
        let mut iov = [IoSliceMut::new(&mut bytes)];
        match stream.try_io(Interest::READABLE, || {
            recvmsg(
                stream.as_fd(),
                &mut iov,
                &mut ancillary,
                RecvFlags::DONTWAIT,
            )
            .map_err(io::Error::from)
        }) {
            Ok(message) => break message,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
            Err(error) => return Err(error.into()),
        }
    };
    if received.flags.contains(ReturnFlags::CTRUNC) {
        return Err(SetupError::TruncatedAncillary);
    }
    if received.bytes == 0 {
        return Err(SetupError::MissingDescriptors);
    }
    bytes.truncate(received.bytes);

    let mut descriptors = Vec::new();
    for message in ancillary.drain() {
        match message {
            RecvAncillaryMessage::ScmRights(rights) => descriptors.extend(rights),
            _ => return Err(SetupError::DuplicateDescriptors),
        }
    }
    if descriptors.len() < RING_DESCRIPTOR_COUNT {
        return Err(SetupError::MissingDescriptors);
    }
    if descriptors.len() > RING_DESCRIPTOR_COUNT {
        return Err(SetupError::DuplicateDescriptors);
    }
    for descriptor in &descriptors {
        fcntl_setfd(descriptor, FdFlags::CLOEXEC).map_err(io::Error::from)?;
    }
    let descriptors: [OwnedFd; RING_DESCRIPTOR_COUNT] = descriptors
        .try_into()
        .map_err(|_| SetupError::MissingDescriptors)?;
    let value = read_message_from_prefix(stream, bytes, deadline).await?;
    Ok((value, descriptors))
}

/// Performs current-format activation and commit on the control-only socket.
pub async fn activate_server(
    stream: &mut UnixStream,
    descriptors: &[OwnedFd; RING_DESCRIPTOR_COUNT],
    descriptor: &serde_json::Value,
    wire_version: u8,
    descriptor_schema: u16,
    activation_token: &str,
    timeout: Duration,
) -> Result<(), SetupError> {
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or(SetupError::Timeout)?;
    send_grant(
        stream,
        &GrantMessage {
            wire_version,
            descriptor_schema,
            activation_token: activation_token.to_owned(),
            descriptor: descriptor.clone(),
        },
        descriptors,
        deadline,
    )
    .await?;
    match read_message(stream, deadline).await? {
        ClientMessage::Activate {
            wire_version: presented_wire,
            descriptor_schema: presented_schema,
            activation_token: presented_token,
        } if presented_wire == wire_version && presented_schema == descriptor_schema => {
            if subtle::ConstantTimeEq::ct_eq(
                presented_token.as_bytes(),
                activation_token.as_bytes(),
            )
            .into()
            {
                write_message(stream, &ServerMessage::Activated, deadline).await?;
            } else {
                return Err(SetupError::InvalidActivation);
            }
        }
        ClientMessage::Activate { .. } => return Err(SetupError::InvalidIdentity),
        _ => return Err(SetupError::InvalidMessage),
    }
    match read_message(stream, deadline).await? {
        ClientMessage::Commit => write_message(stream, &ServerMessage::Committed, deadline).await,
        _ => Err(SetupError::InvalidMessage),
    }
}

/// Receives, validates, and commits the sole current ring on a client setup socket.
pub async fn activate_client(
    stream: &mut UnixStream,
    timeout: Duration,
) -> Result<(serde_json::Value, [OwnedFd; RING_DESCRIPTOR_COUNT]), SetupError> {
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or(SetupError::Timeout)?;
    let (value, descriptors) = receive_grant(stream, deadline).await?;
    let GrantMessage {
        wire_version,
        descriptor_schema,
        activation_token,
        descriptor,
    } = serde_json::from_value(value).map_err(|_| SetupError::InvalidMessage)?;
    if wire_version != crate::wire::PROTOCOL_VERSION
        || descriptor_schema != mc_shm_transport::descriptor::DESCRIPTOR_SCHEMA_VERSION
    {
        return Err(SetupError::InvalidIdentity);
    }
    write_message(
        stream,
        &ClientMessage::Activate {
            wire_version,
            descriptor_schema,
            activation_token,
        },
        deadline,
    )
    .await?;
    if !matches!(
        read_message(stream, deadline).await?,
        ServerMessage::Activated
    ) {
        return Err(SetupError::InvalidMessage);
    }
    write_message(stream, &ClientMessage::Commit, deadline).await?;
    if !matches!(
        read_message(stream, deadline).await?,
        ServerMessage::Committed
    ) {
        return Err(SetupError::InvalidMessage);
    }
    Ok((descriptor, descriptors))
}

/// Sends the only legal post-commit setup message.
pub async fn goodbye_client(stream: &mut UnixStream) {
    let deadline = Instant::now() + Duration::from_millis(100);
    let _ = write_message(stream, &ClientMessage::Goodbye, deadline).await;
    let _ = stream.shutdown().await;
}

pub(crate) fn encoded_goodbye() -> Result<Vec<u8>, SetupError> {
    encode_message(&ClientMessage::Goodbye)
}

/// Waits for the only legal post-commit setup message or peer EOF.
pub async fn observe_peer(stream: &mut UnixStream) -> PeerClose {
    match read_message_unbounded(stream).await {
        Ok(ClientMessage::Goodbye) => PeerClose::Goodbye,
        Err(SetupError::Io(error)) if error.kind() == io::ErrorKind::UnexpectedEof => {
            PeerClose::UnexpectedEof
        }
        _ => PeerClose::ProtocolError,
    }
}

async fn read_message_unbounded<T: DeserializeOwned>(
    stream: &mut UnixStream,
) -> Result<T, SetupError> {
    let mut len = [0u8; 4];
    stream.read_exact(&mut len).await?;
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_SETUP_MESSAGE_LEN {
        return Err(SetupError::MessageTooLarge);
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body).await?;
    serde_json::from_slice(&body).map_err(|_| SetupError::InvalidMessage)
}

async fn read_message<T: DeserializeOwned>(
    stream: &mut UnixStream,
    deadline: Instant,
) -> Result<T, SetupError> {
    let mut len = [0u8; 4];
    timeout_at(deadline, stream.read_exact(&mut len))
        .await
        .map_err(|_| SetupError::Timeout)??;
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_SETUP_MESSAGE_LEN {
        return Err(SetupError::MessageTooLarge);
    }
    let mut body = vec![0u8; len];
    timeout_at(deadline, stream.read_exact(&mut body))
        .await
        .map_err(|_| SetupError::Timeout)??;
    serde_json::from_slice(&body).map_err(|_| SetupError::InvalidMessage)
}

async fn read_message_from_prefix<T: DeserializeOwned>(
    stream: &mut UnixStream,
    mut prefix: Vec<u8>,
    deadline: Instant,
) -> Result<T, SetupError> {
    while prefix.len() < 4 {
        let mut byte = [0u8; 1];
        timeout_at(deadline, stream.read_exact(&mut byte))
            .await
            .map_err(|_| SetupError::Timeout)??;
        prefix.push(byte[0]);
    }
    let len = u32::from_le_bytes(prefix[..4].try_into().expect("four-byte prefix")) as usize;
    if len > MAX_SETUP_MESSAGE_LEN {
        return Err(SetupError::MessageTooLarge);
    }
    let total = 4usize.checked_add(len).ok_or(SetupError::MessageTooLarge)?;
    if prefix.len() > total {
        return Err(SetupError::InvalidMessage);
    }
    let received = prefix.len();
    prefix.resize(total, 0);
    if received < total {
        timeout_at(deadline, stream.read_exact(&mut prefix[received..]))
            .await
            .map_err(|_| SetupError::Timeout)??;
    }
    serde_json::from_slice(&prefix[4..]).map_err(|_| SetupError::InvalidMessage)
}

async fn write_message<T: Serialize>(
    stream: &mut UnixStream,
    value: &T,
    deadline: Instant,
) -> Result<(), SetupError> {
    let bytes = encode_message(value)?;
    timeout_at(deadline, stream.write_all(&bytes))
        .await
        .map_err(|_| SetupError::Timeout)??;
    Ok(())
}

fn encode_message<T: Serialize>(value: &T) -> Result<Vec<u8>, SetupError> {
    let body = serde_json::to_vec(value).map_err(|_| SetupError::InvalidMessage)?;
    if body.len() > MAX_SETUP_MESSAGE_LEN {
        return Err(SetupError::MessageTooLarge);
    }
    let mut bytes = Vec::with_capacity(4 + body.len());
    bytes.extend_from_slice(&(body.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&body);
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::OwnedFd;

    fn descriptors() -> [OwnedFd; RING_DESCRIPTOR_COUNT] {
        std::array::from_fn(|_| tempfile::tempfile().expect("temporary descriptor").into())
    }

    #[tokio::test]
    async fn grant_transfers_exactly_two_descriptors() {
        let (mut server, mut client) = UnixStream::pair().expect("socket pair");
        let descriptors = descriptors();
        let deadline = Instant::now() + Duration::from_secs(1);
        let sent = tokio::spawn(async move {
            send_grant(
                &mut server,
                &GrantMessage {
                    wire_version: 2,
                    descriptor_schema: mc_shm_transport::descriptor::DESCRIPTOR_SCHEMA_VERSION,
                    activation_token: "token".to_owned(),
                    descriptor: serde_json::json!({"ring": "v1"}),
                },
                &descriptors,
                deadline,
            )
            .await
        });

        let (grant, received) = receive_grant(&mut client, deadline).await.expect("grant");
        sent.await.expect("sender task").expect("send grant");
        assert_eq!(grant["type"], "grant");
        assert_eq!(grant["descriptor"]["ring"], "v1");
        for descriptor in received {
            let flags = rustix::io::fcntl_getfd(&descriptor).expect("descriptor flags");
            assert!(flags.contains(FdFlags::CLOEXEC));
        }
    }

    #[tokio::test]
    async fn setup_socket_is_owner_only() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("setup.sock");
        let _listener = bind_owner_only(&path).expect("bind setup socket");
        let mode = std::fs::symlink_metadata(path)
            .expect("socket metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[tokio::test]
    async fn insecure_stale_occupant_is_not_replaced() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("setup.sock");
        std::fs::write(&path, b"not a socket").unwrap();
        let error = bind_owner_only(&path).expect_err("regular file must fail closed");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(std::fs::read(path).unwrap(), b"not a socket");
    }

    #[tokio::test]
    async fn grant_without_ancillary_descriptors_is_rejected() {
        let (mut server, mut client) = UnixStream::pair().expect("socket pair");
        let deadline = Instant::now() + Duration::from_secs(1);
        server
            .write_all(&encode_message(&serde_json::json!({"type": "grant_message"})).unwrap())
            .await
            .unwrap();
        assert!(matches!(
            receive_grant(&mut client, deadline).await,
            Err(SetupError::MissingDescriptors)
        ));
    }

    #[tokio::test]
    async fn grant_with_extra_descriptor_is_rejected() {
        let (server, mut client) = UnixStream::pair().expect("socket pair");
        let descriptors: [OwnedFd; 3] =
            std::array::from_fn(|_| tempfile::tempfile().expect("temporary descriptor").into());
        let borrowed: [BorrowedFd<'_>; 3] = std::array::from_fn(|index| descriptors[index].as_fd());
        let bytes = encode_message(&serde_json::json!({"type": "grant"})).unwrap();
        server.writable().await.unwrap();
        let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(3))];
        let mut ancillary = SendAncillaryBuffer::new(&mut space);
        assert!(ancillary.push(SendAncillaryMessage::ScmRights(&borrowed)));
        sendmsg(
            server.as_fd(),
            &[IoSlice::new(&bytes)],
            &mut ancillary,
            SendFlags::empty(),
        )
        .unwrap();

        assert!(matches!(
            receive_grant(&mut client, Instant::now() + Duration::from_secs(1)).await,
            Err(SetupError::DuplicateDescriptors)
        ));
    }

    #[tokio::test]
    async fn truncated_ancillary_data_is_rejected() {
        let (server, mut client) = UnixStream::pair().expect("socket pair");
        let descriptors: [OwnedFd; 32] =
            std::array::from_fn(|_| tempfile::tempfile().expect("temporary descriptor").into());
        let borrowed: [BorrowedFd<'_>; 32] =
            std::array::from_fn(|index| descriptors[index].as_fd());
        let bytes = encode_message(&serde_json::json!({"type": "grant"})).unwrap();
        server.writable().await.unwrap();
        let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(32))];
        let mut ancillary = SendAncillaryBuffer::new(&mut space);
        assert!(ancillary.push(SendAncillaryMessage::ScmRights(&borrowed)));
        sendmsg(
            server.as_fd(),
            &[IoSlice::new(&bytes)],
            &mut ancillary,
            SendFlags::empty(),
        )
        .unwrap();

        assert!(matches!(
            receive_grant(&mut client, Instant::now() + Duration::from_secs(1)).await,
            Err(SetupError::TruncatedAncillary)
        ));
    }

    #[tokio::test]
    async fn application_message_is_not_a_setup_message() {
        let (mut server, mut client) = UnixStream::pair().expect("socket pair");
        let descriptors = descriptors();
        let task = tokio::spawn(async move {
            activate_server(
                &mut server,
                &descriptors,
                &serde_json::json!({"ring": "v1"}),
                2,
                mc_shm_transport::descriptor::DESCRIPTOR_SCHEMA_VERSION,
                "token",
                Duration::from_secs(1),
            )
            .await
        });
        let deadline = Instant::now() + Duration::from_secs(1);
        let _ = receive_grant(&mut client, deadline).await.expect("grant");
        write_message(
            &mut client,
            &serde_json::json!({"type": "request", "corr": 1}),
            deadline,
        )
        .await
        .unwrap();
        assert!(matches!(
            task.await.expect("server task"),
            Err(SetupError::InvalidMessage)
        ));
    }

    #[tokio::test]
    async fn activation_and_commit_complete_on_setup_socket() {
        let (mut server, mut client) = UnixStream::pair().expect("socket pair");
        let descriptors = descriptors();
        let task = tokio::spawn(async move {
            activate_server(
                &mut server,
                &descriptors,
                &serde_json::json!({"ring": "v1"}),
                2,
                mc_shm_transport::descriptor::DESCRIPTOR_SCHEMA_VERSION,
                "token",
                Duration::from_secs(1),
            )
            .await?;
            Ok::<_, SetupError>(observe_peer(&mut server).await)
        });
        let deadline = Instant::now() + Duration::from_secs(1);
        let _ = receive_grant(&mut client, deadline).await.expect("grant");
        write_message(
            &mut client,
            &ClientMessage::Activate {
                wire_version: 2,
                descriptor_schema: mc_shm_transport::descriptor::DESCRIPTOR_SCHEMA_VERSION,
                activation_token: "token".to_owned(),
            },
            deadline,
        )
        .await
        .unwrap();
        assert!(matches!(
            read_message::<ServerMessage>(&mut client, deadline).await,
            Ok(ServerMessage::Activated)
        ));
        write_message(&mut client, &ClientMessage::Commit, deadline)
            .await
            .unwrap();
        assert!(matches!(
            read_message::<ServerMessage>(&mut client, deadline).await,
            Ok(ServerMessage::Committed)
        ));
        write_message(
            &mut client,
            &serde_json::json!({"type": "request", "corr": 1}),
            deadline,
        )
        .await
        .unwrap();
        assert_eq!(
            task.await.expect("server task").expect("activation"),
            PeerClose::ProtocolError
        );
    }

    #[tokio::test]
    async fn authenticated_setup_transfers_and_commits_descriptors() {
        let (mut server, mut client) = UnixStream::pair().expect("socket pair");
        let key = vec![0x5a; crate::connection_file::KEY_LEN];
        let daemon_id = [0x6b; crate::connection_file::DAEMON_ID_LEN];
        let server_key = key.clone();
        let descriptors = descriptors();
        let task = tokio::spawn(async move {
            crate::auth::authenticate_server(
                &mut server,
                &server_key,
                &daemon_id,
                "test",
                Duration::from_secs(1),
            )
            .await
            .expect("server auth");
            activate_server(
                &mut server,
                &descriptors,
                &serde_json::json!({"ring": "v1"}),
                2,
                mc_shm_transport::descriptor::DESCRIPTOR_SCHEMA_VERSION,
                "token",
                Duration::from_secs(1),
            )
            .await
        });
        crate::auth::authenticate_client(
            &mut client,
            &crate::connection_file::ConnectionInfo {
                schema: crate::connection_file::SCHEMA_VERSION,
                wire_version: crate::wire::PROTOCOL_VERSION,
                setup_socket: "/tmp/test.sock".to_owned(),
                key,
                daemon_id,
                pid: 1,
                daemon_ver: "test".to_owned(),
            },
            Duration::from_secs(1),
        )
        .await
        .expect("client auth");
        let deadline = Instant::now() + Duration::from_secs(1);
        let (_, received) = receive_grant(&mut client, deadline).await.expect("grant");
        assert_eq!(received.len(), RING_DESCRIPTOR_COUNT);
        write_message(
            &mut client,
            &ClientMessage::Activate {
                wire_version: 2,
                descriptor_schema: mc_shm_transport::descriptor::DESCRIPTOR_SCHEMA_VERSION,
                activation_token: "token".to_owned(),
            },
            deadline,
        )
        .await
        .unwrap();
        assert!(matches!(
            read_message::<ServerMessage>(&mut client, deadline).await,
            Ok(ServerMessage::Activated)
        ));
        write_message(&mut client, &ClientMessage::Commit, deadline)
            .await
            .unwrap();
        assert!(matches!(
            read_message::<ServerMessage>(&mut client, deadline).await,
            Ok(ServerMessage::Committed)
        ));
        task.await.expect("server task").expect("activation");
    }

    #[tokio::test]
    async fn stale_wire_or_descriptor_schema_is_invalid_identity() {
        for (wire_version, descriptor_schema) in [
            (
                crate::wire::PROTOCOL_VERSION.saturating_sub(1),
                mc_shm_transport::descriptor::DESCRIPTOR_SCHEMA_VERSION,
            ),
            (crate::wire::PROTOCOL_VERSION, 1),
        ] {
            let (mut server, mut client) = UnixStream::pair().expect("socket pair");
            let descriptors = descriptors();
            let task = tokio::spawn(async move {
                activate_server(
                    &mut server,
                    &descriptors,
                    &serde_json::json!({}),
                    crate::wire::PROTOCOL_VERSION,
                    mc_shm_transport::descriptor::DESCRIPTOR_SCHEMA_VERSION,
                    "token",
                    Duration::from_secs(1),
                )
                .await
            });
            let deadline = Instant::now() + Duration::from_secs(1);
            let _ = receive_grant(&mut client, deadline).await.expect("grant");
            write_message(
                &mut client,
                &ClientMessage::Activate {
                    wire_version,
                    descriptor_schema,
                    activation_token: "token".to_owned(),
                },
                deadline,
            )
            .await
            .unwrap();
            assert!(matches!(
                task.await.expect("server task"),
                Err(SetupError::InvalidIdentity)
            ));
        }
    }

    #[tokio::test]
    async fn client_rejects_stale_identity_without_activate_write_or_returned_descriptors() {
        for (wire_version, descriptor_schema) in [
            (
                crate::wire::PROTOCOL_VERSION.saturating_sub(1),
                mc_shm_transport::descriptor::DESCRIPTOR_SCHEMA_VERSION,
            ),
            (crate::wire::PROTOCOL_VERSION, 1),
        ] {
            let (mut server, mut client) = UnixStream::pair().expect("socket pair");
            let descriptors = descriptors();
            let deadline = Instant::now() + Duration::from_secs(1);
            let sent = tokio::spawn(async move {
                send_grant(
                    &mut server,
                    &GrantMessage {
                        wire_version,
                        descriptor_schema,
                        activation_token: "token".to_owned(),
                        descriptor: serde_json::json!({}),
                    },
                    &descriptors,
                    deadline,
                )
                .await?;
                let mut byte = [0u8; 1];
                Ok::<_, SetupError>(
                    tokio::time::timeout(Duration::from_millis(100), server.read(&mut byte)).await,
                )
            });

            assert!(matches!(
                activate_client(&mut client, Duration::from_secs(1)).await,
                Err(SetupError::InvalidIdentity)
            ));
            assert!(sent
                .await
                .expect("sender task")
                .expect("send stale grant")
                .is_err());
        }
    }

    #[tokio::test]
    async fn goodbye_and_eof_have_distinct_outcomes() {
        let (mut server, mut client) = UnixStream::pair().expect("socket pair");
        write_message(
            &mut client,
            &ClientMessage::Goodbye,
            Instant::now() + Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert_eq!(observe_peer(&mut server).await, PeerClose::Goodbye);

        let (mut server, client) = UnixStream::pair().expect("socket pair");
        drop(client);
        assert_eq!(observe_peer(&mut server).await, PeerClose::UnexpectedEof);
    }
}
