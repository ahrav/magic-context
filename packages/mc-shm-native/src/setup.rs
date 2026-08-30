use std::io::{self, IoSliceMut, Read, Write};
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

use hmac::{Hmac, Mac};
use mc_shm_transport::backend::ring::RingGrant;
use rustix::io::{fcntl_setfd, FdFlags};
use rustix::net::{recvmsg, RecvAncillaryBuffer, RecvAncillaryMessage, RecvFlags, ReturnFlags};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;

const NONCE_LEN: usize = 32;
const PROOF_LEN: usize = 32;
const DAEMON_ID_LEN: usize = 16;
const MAX_AUTH_MESSAGE_LEN: usize = 4096;
const MAX_SETUP_MESSAGE_LEN: usize = 16 * 1024;
const SERVER_PROOF_DOMAIN: &[u8] = b"subc-server-v1";
const CLIENT_AUTH_DOMAIN: &[u8] = b"subc-client-v1";

#[derive(Serialize)]
struct ClientHello {
    client_nonce: [u8; NONCE_LEN],
    role: &'static str,
}

#[derive(Deserialize)]
struct ServerProof {
    daemon_id: [u8; DAEMON_ID_LEN],
    server_nonce: [u8; NONCE_LEN],
    daemon_ver: String,
    server_proof: [u8; PROOF_LEN],
}

#[derive(Serialize)]
struct ClientAuth {
    client_auth: [u8; PROOF_LEN],
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum GrantMessage {
    Grant {
        wire_version: u8,
        descriptor_schema: u16,
        activation_token: String,
        descriptor: Descriptor,
    },
}

struct Grant {
    wire_version: u8,
    descriptor_schema: u16,
    activation_token: String,
    descriptor: Descriptor,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Descriptor {
    profile: String,
    host_to_peer_grant: String,
    peer_to_host_grant: String,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage<'a> {
    Activate {
        wire_version: u8,
        descriptor_schema: u16,
        activation_token: &'a str,
    },
    Commit,
    Goodbye,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum ServerMessage {
    Activated,
    Committed,
}

pub struct SetupConnection {
    pub stream: UnixStream,
    pub host_to_peer_fd: OwnedFd,
    pub peer_to_host_fd: OwnedFd,
    pub host_to_peer_grant: RingGrant,
    pub peer_to_host_grant: RingGrant,
}

pub fn connect(
    path: &Path,
    key: &[u8],
    expected_daemon_id: &[u8],
    expected_daemon_ver: &str,
    timeout: Duration,
) -> io::Result<SetupConnection> {
    if key.len() != 32 || expected_daemon_id.len() != DAEMON_ID_LEN || timeout.is_zero() {
        return Err(invalid());
    }
    let deadline = Instant::now().checked_add(timeout).ok_or_else(timed_out)?;
    let mut stream = UnixStream::connect(path)?;
    authenticate(
        &mut stream,
        key,
        expected_daemon_id,
        expected_daemon_ver,
        deadline,
    )?;
    let (grant, descriptors) = receive_grant(&mut stream, deadline)?;
    if grant.wire_version != 2
        || grant.descriptor_schema != mc_shm_transport::descriptor::DESCRIPTOR_SCHEMA_VERSION
    {
        return Err(invalid());
    }
    let host_to_peer_grant = decode_grant(&grant.descriptor.host_to_peer_grant)?;
    let peer_to_host_grant = decode_grant(&grant.descriptor.peer_to_host_grant)?;
    if grant.descriptor.profile != super::PROFILE || host_to_peer_grant == peer_to_host_grant {
        return Err(invalid());
    }
    write_message(
        &mut stream,
        &ClientMessage::Activate {
            wire_version: grant.wire_version,
            descriptor_schema: grant.descriptor_schema,
            activation_token: &grant.activation_token,
        },
        deadline,
        MAX_SETUP_MESSAGE_LEN,
    )?;
    if !matches!(
        read_message::<ServerMessage>(&mut stream, deadline, MAX_SETUP_MESSAGE_LEN)?,
        ServerMessage::Activated
    ) {
        return Err(invalid());
    }
    write_message(
        &mut stream,
        &ClientMessage::Commit,
        deadline,
        MAX_SETUP_MESSAGE_LEN,
    )?;
    if !matches!(
        read_message::<ServerMessage>(&mut stream, deadline, MAX_SETUP_MESSAGE_LEN)?,
        ServerMessage::Committed
    ) {
        return Err(invalid());
    }
    let [host_to_peer_fd, peer_to_host_fd] = descriptors;
    Ok(SetupConnection {
        stream,
        host_to_peer_fd,
        peer_to_host_fd,
        host_to_peer_grant,
        peer_to_host_grant,
    })
}

pub fn goodbye(stream: &mut UnixStream) {
    let deadline = Instant::now() + Duration::from_millis(100);
    let _ = write_message(
        stream,
        &ClientMessage::Goodbye,
        deadline,
        MAX_SETUP_MESSAGE_LEN,
    );
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

fn authenticate(
    stream: &mut UnixStream,
    key: &[u8],
    expected_daemon_id: &[u8],
    expected_daemon_ver: &str,
    deadline: Instant,
) -> io::Result<()> {
    let mut client_nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut client_nonce).map_err(|_| invalid())?;
    write_message(
        stream,
        &ClientHello {
            client_nonce,
            role: "client",
        },
        deadline,
        MAX_AUTH_MESSAGE_LEN,
    )?;
    let server: ServerProof = read_message(stream, deadline, MAX_AUTH_MESSAGE_LEN)?;
    let expected = proof(
        key,
        SERVER_PROOF_DOMAIN,
        &client_nonce,
        &server.server_nonce,
        &server.daemon_id,
    );
    if !bool::from(expected.ct_eq(&server.server_proof))
        || !bool::from(server.daemon_id.as_slice().ct_eq(expected_daemon_id))
        || server.daemon_ver != expected_daemon_ver
    {
        return Err(identity_mismatch());
    }
    write_message(
        stream,
        &ClientAuth {
            client_auth: proof(
                key,
                CLIENT_AUTH_DOMAIN,
                &client_nonce,
                &server.server_nonce,
                &server.daemon_id,
            ),
        },
        deadline,
        MAX_AUTH_MESSAGE_LEN,
    )
}

fn proof(
    key: &[u8],
    domain: &[u8],
    client_nonce: &[u8; NONCE_LEN],
    server_nonce: &[u8; NONCE_LEN],
    daemon_id: &[u8],
) -> [u8; PROOF_LEN] {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts every key length");
    mac.update(domain);
    mac.update(client_nonce);
    mac.update(server_nonce);
    mac.update(daemon_id);
    mac.finalize().into_bytes().into()
}

fn receive_grant(stream: &mut UnixStream, deadline: Instant) -> io::Result<(Grant, [OwnedFd; 2])> {
    set_timeout(stream, deadline)?;
    let mut bytes = vec![0u8; MAX_SETUP_MESSAGE_LEN + 4];
    let mut control = [std::mem::MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(3))];
    let mut ancillary = RecvAncillaryBuffer::new(&mut control);
    let mut iov = [IoSliceMut::new(&mut bytes)];
    let received = recvmsg(stream.as_fd(), &mut iov, &mut ancillary, RecvFlags::empty())?;
    if received.bytes == 0 || received.flags.contains(ReturnFlags::CTRUNC) {
        return Err(invalid());
    }
    bytes.truncate(received.bytes);
    let mut descriptors = Vec::new();
    for message in ancillary.drain() {
        match message {
            RecvAncillaryMessage::ScmRights(rights) => descriptors.extend(rights),
            _ => return Err(invalid()),
        }
    }
    if descriptors.len() != 2 {
        return Err(invalid());
    }
    for descriptor in &descriptors {
        fcntl_setfd(descriptor, FdFlags::CLOEXEC)?;
    }
    let descriptors = descriptors.try_into().map_err(|_| invalid())?;
    let message: GrantMessage =
        read_message_from_prefix(stream, bytes, deadline, MAX_SETUP_MESSAGE_LEN)?;
    let GrantMessage::Grant {
        wire_version,
        descriptor_schema,
        activation_token,
        descriptor,
    } = message;
    let grant = Grant {
        wire_version,
        descriptor_schema,
        activation_token,
        descriptor,
    };
    Ok((grant, descriptors))
}

fn read_message_from_prefix<T: DeserializeOwned>(
    stream: &mut UnixStream,
    mut prefix: Vec<u8>,
    deadline: Instant,
    max: usize,
) -> io::Result<T> {
    while prefix.len() < 4 {
        let mut byte = [0u8; 1];
        read_exact(stream, &mut byte, deadline)?;
        prefix.push(byte[0]);
    }
    let len = u32::from_le_bytes(prefix[..4].try_into().expect("four-byte prefix")) as usize;
    if len > max {
        return Err(invalid());
    }
    let total = 4usize.checked_add(len).ok_or_else(invalid)?;
    if prefix.len() > total {
        return Err(invalid());
    }
    let received = prefix.len();
    prefix.resize(total, 0);
    read_exact(stream, &mut prefix[received..], deadline)?;
    serde_json::from_slice(&prefix[4..]).map_err(|_| invalid())
}

fn read_message<T: DeserializeOwned>(
    stream: &mut UnixStream,
    deadline: Instant,
    max: usize,
) -> io::Result<T> {
    let mut len = [0u8; 4];
    read_exact(stream, &mut len, deadline)?;
    let len = u32::from_le_bytes(len) as usize;
    if len > max {
        return Err(invalid());
    }
    let mut body = vec![0u8; len];
    read_exact(stream, &mut body, deadline)?;
    serde_json::from_slice(&body).map_err(|_| invalid())
}

fn write_message<T: Serialize>(
    stream: &mut UnixStream,
    value: &T,
    deadline: Instant,
    max: usize,
) -> io::Result<()> {
    let body = serde_json::to_vec(value).map_err(|_| invalid())?;
    if body.len() > max {
        return Err(invalid());
    }
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    set_timeout(stream, deadline)?;
    stream.write_all(&frame)
}

fn read_exact(stream: &mut UnixStream, bytes: &mut [u8], deadline: Instant) -> io::Result<()> {
    if bytes.is_empty() {
        return Ok(());
    }
    set_timeout(stream, deadline)?;
    stream.read_exact(bytes)
}

fn set_timeout(stream: &UnixStream, deadline: Instant) -> io::Result<()> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(timed_out());
    }
    stream.set_read_timeout(Some(remaining))?;
    stream.set_write_timeout(Some(remaining))
}

fn decode_grant(text: &str) -> io::Result<RingGrant> {
    const N: usize = RingGrant::encoded_len();
    if text.len() != N * 2 {
        return Err(invalid());
    }
    let mut bytes = [0u8; N];
    for (index, byte) in bytes.iter_mut().enumerate() {
        let high = nibble(text.as_bytes()[index * 2])?;
        let low = nibble(text.as_bytes()[index * 2 + 1])?;
        *byte = high << 4 | low;
    }
    RingGrant::decode(bytes).map_err(|_| invalid())
}

fn nibble(byte: u8) -> io::Result<u8> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err(invalid()),
    }
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "shared-memory setup failed")
}

fn identity_mismatch() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "shared-memory identity mismatch",
    )
}

fn timed_out() -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        "shared-memory setup deadline expired",
    )
}

#[cfg(test)]
mod tests {
    use super::GrantMessage;

    #[test]
    fn grant_message_accepts_tagged_setup_envelope() {
        let message: GrantMessage = serde_json::from_value(serde_json::json!({
            "type": "grant",
            "wire_version": 2,
            "descriptor_schema": 1,
            "activation_token": "token",
            "descriptor": {
                "profile": "mc-host-test-ring-v1",
                "host_to_peer_grant": "aa",
                "peer_to_host_grant": "bb"
            }
        }))
        .expect("tagged grant envelope decodes");

        let GrantMessage::Grant { wire_version, .. } = message;
        assert_eq!(wire_version, 2);
    }
}
