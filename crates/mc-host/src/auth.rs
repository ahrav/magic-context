//! Host-owned three-message authentication handshake.

use std::{error::Error, fmt, future::Future, io, time::Duration};

use hmac::{Hmac, Mac};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    time,
};

use crate::connection_file::{ConnectionInfo, DAEMON_ID_LEN, MIN_KEY_LEN};

pub const NONCE_LEN: usize = 32;
pub const PROOF_LEN: usize = 32;
pub const MAX_AUTH_MESSAGE_LEN: u32 = 4096;
pub const SERVER_PROOF_DOMAIN: &str = "subc-server-v1";
pub const CLIENT_AUTH_DOMAIN: &str = "subc-client-v1";
pub const DEFAULT_CLIENT_ROLE: &str = "client";

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientHello {
    pub client_nonce: [u8; NONCE_LEN],
    pub role: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerProof {
    pub daemon_id: [u8; DAEMON_ID_LEN],
    pub server_nonce: [u8; NONCE_LEN],
    pub daemon_ver: String,
    pub server_proof: [u8; PROOF_LEN],
}

// V24 classifies proof bytes as sensitive diagnostics. A derived `Debug` prints
// the whole HMAC, so one routine `{:?}` in an error path or panic message
// persists a live authentication transcript secret. The nonces and daemon ID stay
// visible: both travel in the clear and are what makes a transcript identifiable
// while debugging.
impl fmt::Debug for ServerProof {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServerProof")
            .field("daemon_id", &self.daemon_id)
            .field("server_nonce", &self.server_nonce)
            .field("daemon_ver", &self.daemon_ver)
            .field("server_proof", &"[redacted]")
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientAuth {
    pub client_auth: [u8; PROOF_LEN],
}

/// Redacted for the same reason as [`ServerProof`]; this struct is nothing but
/// the proof, so there is no non-secret field to keep.
impl fmt::Debug for ClientAuth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientAuth")
            .field("client_auth", &"[redacted]")
            .finish()
    }
}

/// The outcome of a successful handshake.
///
/// WHAT THIS PROVES: the peer possesses the connection key, and (client side)
/// that the daemon does too. Nothing more.
///
/// Deliberately empty: everything else in the handshake transcript is
/// client-asserted and unverified. `ClientHello.role` in particular is parsed
/// and then discarded — any peer holding the key can claim any role, so it
/// must never decide admission, capacity, or privilege. A type called
/// `Authenticated` invites reading its fields as attested, and only key
/// possession is. Module identity, which IS attested, travels a different
/// path entirely (spawn nonces validated at route.open).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Authenticated;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthStage {
    ClientHello,
    ServerProof,
    ClientAuth,
}

#[derive(Debug)]
pub enum AuthError {
    Io {
        stage: AuthStage,
        source: io::Error,
    },
    Timeout {
        stage: AuthStage,
        deadline: Duration,
    },
    UnexpectedEof {
        stage: AuthStage,
        expected: usize,
        actual: usize,
    },
    MessageTooLarge {
        stage: AuthStage,
        len: u32,
        max: u32,
    },
    JsonEncode {
        stage: AuthStage,
        source: serde_json::Error,
    },
    JsonDecode {
        stage: AuthStage,
        source: serde_json::Error,
    },
    /// The configured total is not representable as an absolute deadline, so no
    /// handshake can be attempted against it.
    InvalidDeadline {
        total: Duration,
    },
    Random(getrandom::Error),
    KeyTooShort {
        len: usize,
        min: usize,
    },
    InvalidServerProof,
    DaemonIdMismatch,
    /// The peer reported a `daemon_ver` other than the one in the connection-file
    /// snapshot this handshake authenticated against. `daemon_ver` is not an
    /// input to either proof, so this comparison is what binds the reported
    /// version to that snapshot and makes it usable for compatibility gating.
    DaemonVerMismatch,
    InvalidClientAuth,
}

pub fn compute_proof(
    key: &[u8],
    domain: &str,
    client_nonce: &[u8; NONCE_LEN],
    server_nonce: &[u8; NONCE_LEN],
    daemon_id: &[u8],
) -> [u8; PROOF_LEN] {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts keys of any length");
    mac.update(domain.as_bytes());
    mac.update(client_nonce);
    mac.update(server_nonce);
    mac.update(daemon_id);
    mac.finalize().into_bytes().into()
}

/// An absolute handshake deadline. Every per-stage read/write recomputes the time
/// remaining until `at`, so the WHOLE handshake (length byte + body, across all
/// stages, plus error teardown) is bounded by a single wall-clock budget. Passing
/// a bare `Duration` to each step instead would let a slow peer spend the full
/// budget on every length read AND every body read — multiplying the real bound.
#[derive(Clone, Copy)]
struct Deadline {
    at: time::Instant,
    total: Duration,
}

impl Deadline {
    /// Fallible because the total is operator configuration: `Instant +
    /// Duration` panics when the sum is unrepresentable, and a `Duration::MAX`
    /// auth deadline would take down the connection task rather than reporting
    /// a bad setting.
    fn starting_now(total: Duration) -> Result<Self, AuthError> {
        let at = time::Instant::now()
            .checked_add(total)
            .ok_or(AuthError::InvalidDeadline { total })?;
        Ok(Self { at, total })
    }

    /// Time left until the deadline, or `Timeout` if it has already elapsed.
    fn remaining(&self, stage: AuthStage) -> Result<Duration, AuthError> {
        let remaining = self.at.saturating_duration_since(time::Instant::now());
        if remaining.is_zero() {
            Err(AuthError::Timeout {
                stage,
                deadline: self.total,
            })
        } else {
            Ok(remaining)
        }
    }

    /// Time left until the deadline, clamped to zero — for best-effort teardown
    /// that must not outlive the handshake budget.
    fn remaining_or_zero(&self) -> Duration {
        self.at.saturating_duration_since(time::Instant::now())
    }
}

/// Error-path teardown for either handshake side.
///
/// Bounded by the SAME absolute deadline as the handshake itself, so a failed
/// attempt — and the unauthenticated-handshake slot it holds — is released
/// promptly instead of waiting out another full budget.
///
/// The policy lives here rather than in both wrappers: the surrounding four lines
/// of scaffolding are shape, but *how* a failed handshake tears down is the part
/// that must not diverge between server and client.
async fn teardown_failed_handshake<S>(stream: &mut S, deadline: Deadline)
where
    S: AsyncWrite + Unpin,
{
    let _ = time::timeout(deadline.remaining_or_zero(), stream.shutdown()).await;
}

pub async fn authenticate_server<S>(
    stream: &mut S,
    key: &[u8],
    daemon_id: &[u8; DAEMON_ID_LEN],
    daemon_ver: &str,
    deadline: Duration,
) -> Result<Authenticated, AuthError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let deadline = Deadline::starting_now(deadline)?;
    let result = authenticate_server_inner(stream, key, daemon_id, daemon_ver, deadline).await;
    if result.is_err() {
        teardown_failed_handshake(stream, deadline).await;
    }
    result
}

async fn authenticate_server_inner<S>(
    stream: &mut S,
    key: &[u8],
    daemon_id: &[u8; DAEMON_ID_LEN],
    daemon_ver: &str,
    deadline: Deadline,
) -> Result<Authenticated, AuthError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    validate_key(key)?;

    let hello: ClientHello = read_message(stream, AuthStage::ClientHello, deadline).await?;
    let server_nonce = random_nonce()?;
    let server_proof = compute_proof(
        key,
        SERVER_PROOF_DOMAIN,
        &hello.client_nonce,
        &server_nonce,
        daemon_id,
    );

    write_message(
        stream,
        AuthStage::ServerProof,
        &ServerProof {
            daemon_id: *daemon_id,
            server_nonce,
            daemon_ver: daemon_ver.to_owned(),
            server_proof,
        },
        deadline,
    )
    .await?;

    let client_auth: ClientAuth = read_message(stream, AuthStage::ClientAuth, deadline).await?;
    let expected_client_auth = compute_proof(
        key,
        CLIENT_AUTH_DOMAIN,
        &hello.client_nonce,
        &server_nonce,
        daemon_id,
    );
    if !constant_time_eq(&expected_client_auth, &client_auth.client_auth) {
        return Err(AuthError::InvalidClientAuth);
    }

    Ok(Authenticated)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientAuthenticated {
    pub daemon_ver: String,
}

pub async fn authenticate_client<S>(
    stream: &mut S,
    conn: &ConnectionInfo,
    deadline: Duration,
) -> Result<ClientAuthenticated, AuthError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let deadline = Deadline::starting_now(deadline)?;
    let result = authenticate_client_inner(stream, conn, deadline).await;
    if result.is_err() {
        teardown_failed_handshake(stream, deadline).await;
    }
    result
}

async fn authenticate_client_inner<S>(
    stream: &mut S,
    conn: &ConnectionInfo,
    deadline: Deadline,
) -> Result<ClientAuthenticated, AuthError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    validate_key(&conn.key)?;

    let client_nonce = random_nonce()?;
    write_message(
        stream,
        AuthStage::ClientHello,
        &ClientHello {
            client_nonce,
            role: DEFAULT_CLIENT_ROLE.to_owned(),
        },
        deadline,
    )
    .await?;

    let server_proof: ServerProof = read_message(stream, AuthStage::ServerProof, deadline).await?;
    let expected_server_proof = compute_proof(
        &conn.key,
        SERVER_PROOF_DOMAIN,
        &client_nonce,
        &server_proof.server_nonce,
        &server_proof.daemon_id,
    );
    if !constant_time_eq(&expected_server_proof, &server_proof.server_proof) {
        return Err(AuthError::InvalidServerProof);
    }
    if server_proof.daemon_id != conn.daemon_id {
        return Err(AuthError::DaemonIdMismatch);
    }
    // Wire protocol §5.2: the client MUST require `ServerProof.daemon_ver` to
    // equal the connection-file `daemon_ver`, and MUST emit no `ClientAuth`
    // until all three checks succeed. `daemon_ver` is not an input to either
    // proof, so without this comparison the returned version is whatever the
    // peer claimed rather than the version of the snapshot that was
    // authenticated — and a consumer gating compatibility on it would be
    // trusting an unbound field.
    if server_proof.daemon_ver != conn.daemon_ver {
        return Err(AuthError::DaemonVerMismatch);
    }

    let client_auth = compute_proof(
        &conn.key,
        CLIENT_AUTH_DOMAIN,
        &client_nonce,
        &server_proof.server_nonce,
        &server_proof.daemon_id,
    );
    write_message(
        stream,
        AuthStage::ClientAuth,
        &ClientAuth { client_auth },
        deadline,
    )
    .await?;
    Ok(ClientAuthenticated {
        daemon_ver: server_proof.daemon_ver,
    })
}

fn validate_key(key: &[u8]) -> Result<(), AuthError> {
    if key.len() < MIN_KEY_LEN {
        return Err(AuthError::KeyTooShort {
            len: key.len(),
            min: MIN_KEY_LEN,
        });
    }
    Ok(())
}

fn random_nonce() -> Result<[u8; NONCE_LEN], AuthError> {
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce).map_err(AuthError::Random)?;
    Ok(nonce)
}

/// Both directions of this comparison are fenced, verified by mutation rather than
/// assumed, because a proof check has the failure mode where a suite proves only
/// that it can say NO.
///
/// ALWAYS-FALSE (no proof ever verifies, every connection in the fleet refused) is
/// caught by the handshake integration tests and by two bootstrap tests -- named
/// for key rotation and singleton probing, so this is coverage carried by tests
/// about something else. Narrowing either would remove it silently.
///
/// ALWAYS-TRUE is caught by `foreign_server_reused_port_never_receives_client_auth`
/// -- the case where a client must refuse a server that cannot produce the proof.
/// Named for the refusal, and it holds that direction directly.
///
/// The construction feeding it is pinned separately by
/// `committed_wire_vectors_pin_the_proof_construction`, which reddens for a constant
/// proof AND for one that folds only part of its input -- the second matters because
/// a partial-input proof still produces different outputs for different inputs, so
/// any distinctness assertion passes it while a proof minted against one daemon
/// verifies against another.
fn constant_time_eq(expected: &[u8; PROOF_LEN], actual: &[u8; PROOF_LEN]) -> bool {
    expected.as_slice().ct_eq(actual.as_slice()).into()
}

async fn read_message<S, T>(
    stream: &mut S,
    stage: AuthStage,
    deadline: Deadline,
) -> Result<T, AuthError>
where
    S: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    // Both the length read and the body read recompute the time remaining against
    // the same absolute deadline, so the two together cannot exceed the budget.
    let mut len_bytes = [0u8; 4];
    read_exact_deadline(stream, &mut len_bytes, stage, deadline).await?;
    let len = u32::from_le_bytes(len_bytes);
    if len > MAX_AUTH_MESSAGE_LEN {
        return Err(AuthError::MessageTooLarge {
            stage,
            len,
            max: MAX_AUTH_MESSAGE_LEN,
        });
    }

    let mut json = vec![0u8; len as usize];
    if !json.is_empty() {
        read_exact_deadline(stream, &mut json, stage, deadline).await?;
    }
    serde_json::from_slice(&json).map_err(|source| AuthError::JsonDecode { stage, source })
}

async fn write_message<S, T>(
    stream: &mut S,
    stage: AuthStage,
    value: &T,
    deadline: Deadline,
) -> Result<(), AuthError>
where
    S: AsyncWrite + Unpin,
    T: Serialize,
{
    let json =
        serde_json::to_vec(value).map_err(|source| AuthError::JsonEncode { stage, source })?;
    let len = u32::try_from(json.len()).map_err(|_| AuthError::MessageTooLarge {
        stage,
        len: u32::MAX,
        max: MAX_AUTH_MESSAGE_LEN,
    })?;
    if len > MAX_AUTH_MESSAGE_LEN {
        return Err(AuthError::MessageTooLarge {
            stage,
            len,
            max: MAX_AUTH_MESSAGE_LEN,
        });
    }

    write_all_deadline(stream, &len.to_le_bytes(), stage, deadline).await?;
    write_all_deadline(stream, &json, stage, deadline).await
}

async fn read_exact_deadline<S>(
    stream: &mut S,
    buf: &mut [u8],
    stage: AuthStage,
    deadline: Deadline,
) -> Result<(), AuthError>
where
    S: AsyncRead + Unpin,
{
    let remaining = deadline.remaining(stage)?;
    let expected = buf.len();
    with_timeout(stage, remaining, async {
        let mut actual = 0;
        while actual < expected {
            let read = stream.read(&mut buf[actual..]).await?;
            if read == 0 {
                return Err(ReadExactError::UnexpectedEof { actual });
            }
            actual += read;
        }
        Ok(())
    })
    .await
    .map_err(|err| match err {
        DeadlineIoError::Io(source) => AuthError::Io { stage, source },
        DeadlineIoError::Timeout => AuthError::Timeout {
            stage,
            deadline: deadline.total,
        },
        DeadlineIoError::UnexpectedEof { actual } => AuthError::UnexpectedEof {
            stage,
            expected,
            actual,
        },
    })
}

async fn write_all_deadline<S>(
    stream: &mut S,
    buf: &[u8],
    stage: AuthStage,
    deadline: Deadline,
) -> Result<(), AuthError>
where
    S: AsyncWrite + Unpin,
{
    let remaining = deadline.remaining(stage)?;
    timeout_io(stage, remaining, deadline.total, stream.write_all(buf)).await
}

async fn timeout_io<T, F>(
    stage: AuthStage,
    remaining: Duration,
    total: Duration,
    future: F,
) -> Result<T, AuthError>
where
    F: Future<Output = io::Result<T>>,
{
    match time::timeout(remaining, future).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(source)) => Err(AuthError::Io { stage, source }),
        Err(_) => Err(AuthError::Timeout {
            stage,
            deadline: total,
        }),
    }
}

async fn with_timeout<F>(
    _stage: AuthStage,
    deadline: Duration,
    future: F,
) -> Result<(), DeadlineIoError>
where
    F: Future<Output = Result<(), ReadExactError>>,
{
    match time::timeout(deadline, future).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(ReadExactError::Io(source))) => Err(DeadlineIoError::Io(source)),
        Ok(Err(ReadExactError::UnexpectedEof { actual })) => {
            Err(DeadlineIoError::UnexpectedEof { actual })
        }
        Err(_) => Err(DeadlineIoError::Timeout),
    }
}

#[derive(Debug)]
enum ReadExactError {
    Io(io::Error),
    UnexpectedEof { actual: usize },
}

impl From<io::Error> for ReadExactError {
    fn from(source: io::Error) -> Self {
        Self::Io(source)
    }
}

#[derive(Debug)]
enum DeadlineIoError {
    Io(io::Error),
    Timeout,
    UnexpectedEof { actual: usize },
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { stage, source } => write!(f, "auth {stage:?} I/O error: {source}"),
            Self::Timeout { stage, deadline } => {
                write!(f, "auth {stage:?} timed out after {deadline:?}")
            }
            Self::UnexpectedEof {
                stage,
                expected,
                actual,
            } => write!(
                f,
                "auth {stage:?} ended early: expected {expected} bytes, got {actual}"
            ),
            Self::MessageTooLarge { stage, len, max } => write!(
                f,
                "auth {stage:?} message length {len} exceeds hard cap {max}"
            ),
            Self::JsonEncode { stage, source } => {
                write!(f, "auth {stage:?} JSON encode error: {source}")
            }
            Self::JsonDecode { stage, source } => {
                write!(f, "auth {stage:?} JSON decode error: {source}")
            }
            Self::Random(source) => write!(f, "auth random generation failed: {source}"),
            Self::InvalidDeadline { total } => {
                write!(f, "auth deadline {total:?} is not a representable instant")
            }
            Self::KeyTooShort { len, min } => {
                write!(f, "auth key is too short: {len} bytes, need at least {min}")
            }
            Self::InvalidServerProof => write!(f, "invalid server auth proof"),
            Self::DaemonIdMismatch => write!(f, "server daemon_id did not match connection file"),
            Self::DaemonVerMismatch => {
                write!(f, "server daemon_ver did not match connection file")
            }
            Self::InvalidClientAuth => write!(f, "invalid client auth proof"),
        }
    }
}

impl Error for AuthError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::JsonEncode { source, .. } | Self::JsonDecode { source, .. } => Some(source),
            Self::Random(_) => None,
            Self::Timeout { .. }
            | Self::UnexpectedEof { .. }
            | Self::MessageTooLarge { .. }
            | Self::KeyTooShort { .. }
            | Self::InvalidServerProof
            | Self::DaemonIdMismatch
            | Self::DaemonVerMismatch
            | Self::InvalidDeadline { .. }
            | Self::InvalidClientAuth => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proof_debug_output_never_carries_the_proof_bytes() {
        // V24 classifies proof bytes as sensitive diagnostics. A derived `Debug`
        // prints the whole HMAC, so one `{:?}` in an error path or panic message
        // persists a live authentication transcript secret.
        let sentinel = 0xAB;
        let server = ServerProof {
            daemon_id: [1; DAEMON_ID_LEN],
            server_nonce: [2; NONCE_LEN],
            daemon_ver: "1.2.3".to_owned(),
            server_proof: [sentinel; PROOF_LEN],
        };
        let rendered = format!("{server:?}");
        let byte = format!("{sentinel}");
        assert!(
            !rendered.contains(&byte),
            "server_proof bytes leaked into Debug: {rendered}"
        );
        assert!(rendered.contains("[redacted]"), "{rendered}");
        // The identifying, non-secret fields stay debuggable.
        assert!(rendered.contains("1.2.3"), "{rendered}");
        assert!(rendered.contains("server_nonce"), "{rendered}");

        let client = ClientAuth {
            client_auth: [sentinel; PROOF_LEN],
        };
        let rendered = format!("{client:?}");
        assert!(
            !rendered.contains(&byte),
            "client_auth bytes leaked into Debug: {rendered}"
        );
        assert!(rendered.contains("[redacted]"), "{rendered}");
    }

    #[test]
    fn an_unrepresentable_auth_deadline_is_rejected_not_panicked() {
        // The total is operator configuration, so `Duration::MAX` must report a
        // bad setting rather than panic inside the connection task.
        let error = Deadline::starting_now(Duration::MAX)
            .err()
            .expect("an unrepresentable total has no absolute deadline");
        assert!(
            matches!(error, AuthError::InvalidDeadline { .. }),
            "{error:?}"
        );
        assert!(Deadline::starting_now(Duration::from_secs(2)).is_ok());
    }
    use tokio::{
        io::{duplex, DuplexStream},
        task::yield_now,
        time::advance,
    };

    const TEST_DAEMON_VER: &str = "mc-host-auth-test-1";
    const TEST_ROLE: &str = "client";

    /// The TypeScript client asserts its handshake against the same fixed
    /// vectors (`packages/plugin/src/shared/mc-host-client/auth.test.ts`), so
    /// they form a cross-language contract: changing the domain separator,
    /// the field order, or the MAC breaks the build here, where the change is
    /// being made, instead of surfacing as a handshake failure against a peer
    /// that has not been rebuilt.
    #[test]
    fn committed_wire_vectors_pin_the_proof_construction() {
        fn unhex(hex: &str) -> Vec<u8> {
            assert!(hex.len().is_multiple_of(2), "odd-length hex");
            (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex byte"))
                .collect()
        }

        let key = unhex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
        let client_nonce: [u8; NONCE_LEN] = unhex(&"ab".repeat(NONCE_LEN))
            .try_into()
            .expect("client nonce length");
        let server_nonce: [u8; NONCE_LEN] = unhex(&"cd".repeat(NONCE_LEN))
            .try_into()
            .expect("server nonce length");
        let daemon_id = unhex("000102030405060708090a0b0c0d0e0f");

        for (domain, expected) in [
            (
                SERVER_PROOF_DOMAIN,
                "ea06076a980bc7558e45017df86de89f3d2fc09861f8460795dea31eadf40527",
            ),
            (
                CLIENT_AUTH_DOMAIN,
                "a3bc64784dbd94c4f52799e0c66f7b2b8183aa4655594630245c5d4a2fa387a9",
            ),
        ] {
            let proof = compute_proof(&key, domain, &client_nonce, &server_nonce, &daemon_id);
            let actual: String = proof.iter().map(|byte| format!("{byte:02x}")).collect();
            assert_eq!(
                actual, expected,
                "proof construction changed for domain {domain}: the committed \
                 cross-language wire vectors no longer describe this implementation"
            );
        }
    }

    async fn write_auth_json<T>(stream: &mut DuplexStream, value: &T)
    where
        T: Serialize,
    {
        let body = serde_json::to_vec(value).expect("encode auth json");
        assert!(
            body.len() <= MAX_AUTH_MESSAGE_LEN as usize,
            "test helper auth message over cap"
        );
        stream
            .write_all(&(body.len() as u32).to_le_bytes())
            .await
            .expect("write auth length");
        stream.write_all(&body).await.expect("write auth body");
    }

    async fn read_auth_json<T>(stream: &mut DuplexStream) -> T
    where
        T: DeserializeOwned,
    {
        let mut len_bytes = [0u8; 4];
        stream
            .read_exact(&mut len_bytes)
            .await
            .expect("read auth length");
        let len = u32::from_le_bytes(len_bytes);
        assert!(
            len <= MAX_AUTH_MESSAGE_LEN,
            "test helper received auth message over cap"
        );
        let mut body = vec![0u8; len as usize];
        stream.read_exact(&mut body).await.expect("read auth body");
        serde_json::from_slice(&body).expect("decode auth json")
    }

    /// Write only the 4-byte length prefix of an auth message, withholding
    /// the body — stalls the peer mid-message so the within-stage deadline
    /// can be exercised.
    async fn write_auth_len_only<T>(stream: &mut DuplexStream, value: &T)
    where
        T: Serialize,
    {
        let body = serde_json::to_vec(value).expect("encode auth json");
        stream
            .write_all(&(body.len() as u32).to_le_bytes())
            .await
            .expect("write auth length");
    }

    #[tokio::test(start_paused = true)]
    async fn authenticate_server_deadline_is_absolute_across_handshake() {
        let key = vec![0x5a; MIN_KEY_LEN];
        let daemon_id = [0x6b; DAEMON_ID_LEN];
        let deadline = Duration::from_millis(100);
        let stage_delay = Duration::from_millis(60);
        let (mut client, mut server) = duplex(4096);

        let server_task = tokio::spawn(async move {
            authenticate_server(&mut server, &key, &daemon_id, TEST_DAEMON_VER, deadline).await
        });

        yield_now().await;
        assert!(!server_task.is_finished());

        advance(stage_delay).await;
        write_auth_json(
            &mut client,
            &ClientHello {
                client_nonce: [0x11; NONCE_LEN],
                role: TEST_ROLE.to_owned(),
            },
        )
        .await;
        yield_now().await;

        let server_proof: ServerProof = read_auth_json(&mut client).await;
        assert_eq!(server_proof.daemon_id, daemon_id);
        assert_eq!(server_proof.daemon_ver, TEST_DAEMON_VER);
        assert!(!server_task.is_finished());

        advance(stage_delay).await;
        yield_now().await;
        assert!(server_task.is_finished());

        let err = server_task
            .await
            .expect("server task should join")
            .expect_err("server handshake should time out once the total deadline elapses");
        assert!(matches!(
            err,
            AuthError::Timeout {
                stage: AuthStage::ClientAuth,
                ..
            }
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn server_deadline_spans_length_and_body_within_one_stage() {
        // The bug this guards: applying the timeout independently to the
        // length read and the body read lets a single stage consume ~2x the
        // budget. Here the client sends the ClientHello length prefix late,
        // then withholds the body until the absolute deadline has passed.
        let key = vec![0x5a; MIN_KEY_LEN];
        let daemon_id = [0x6b; DAEMON_ID_LEN];
        let deadline = Duration::from_millis(100);
        let (mut client, mut server) = duplex(4096);

        let server_task = tokio::spawn(async move {
            authenticate_server(&mut server, &key, &daemon_id, TEST_DAEMON_VER, deadline).await
        });

        yield_now().await;
        advance(Duration::from_millis(60)).await;
        write_auth_len_only(
            &mut client,
            &ClientHello {
                client_nonce: [0x11; NONCE_LEN],
                role: TEST_ROLE.to_owned(),
            },
        )
        .await;
        yield_now().await;
        assert!(!server_task.is_finished());

        // Cross the absolute deadline (60 + 50 > 100) without sending the body.
        advance(Duration::from_millis(50)).await;
        yield_now().await;
        assert!(
            server_task.is_finished(),
            "body read must share the handshake deadline, not get a fresh window"
        );
        let err = server_task
            .await
            .expect("join")
            .expect_err("must time out at ClientHello body");
        assert!(matches!(
            err,
            AuthError::Timeout {
                stage: AuthStage::ClientHello,
                ..
            }
        ));
    }

    /// Drives one full handshake against `authenticate_server` and returns
    /// the server's `ServerProof` message.
    async fn complete_handshake(key: &[u8], daemon_id: [u8; DAEMON_ID_LEN]) -> ServerProof {
        let (mut client, mut server) = duplex(4096);
        let key_owned = key.to_vec();
        let server_task = tokio::spawn(async move {
            authenticate_server(
                &mut server,
                &key_owned,
                &daemon_id,
                TEST_DAEMON_VER,
                Duration::from_secs(5),
            )
            .await
        });

        let client_nonce = [0x11u8; NONCE_LEN];
        write_auth_json(
            &mut client,
            &ClientHello {
                client_nonce,
                role: TEST_ROLE.to_owned(),
            },
        )
        .await;
        let server_proof: ServerProof = read_auth_json(&mut client).await;
        let client_auth = compute_proof(
            key,
            CLIENT_AUTH_DOMAIN,
            &client_nonce,
            &server_proof.server_nonce,
            &server_proof.daemon_id,
        );
        write_auth_json(&mut client, &ClientAuth { client_auth }).await;
        server_task
            .await
            .expect("join")
            .expect("handshake completes");
        server_proof
    }

    #[tokio::test]
    async fn repeated_handshakes_receive_fresh_server_nonces() {
        let key = vec![0x5a; MIN_KEY_LEN];
        let daemon_id = [0x6b; DAEMON_ID_LEN];
        let first = complete_handshake(&key, daemon_id).await;
        let second = complete_handshake(&key, daemon_id).await;
        assert_ne!(
            first.server_nonce, second.server_nonce,
            "server nonces must be fresh per handshake, never replayed"
        );
        assert_ne!(
            first.server_proof, second.server_proof,
            "a fresh nonce must produce a fresh proof"
        );
    }

    #[tokio::test]
    async fn wrong_client_proof_is_rejected_and_error_carries_no_secrets() {
        let key = vec![0x5a; MIN_KEY_LEN];
        let daemon_id = [0x6b; DAEMON_ID_LEN];
        let (mut client, mut server) = duplex(4096);
        let key_task = key.clone();
        let server_task = tokio::spawn(async move {
            authenticate_server(
                &mut server,
                &key_task,
                &daemon_id,
                TEST_DAEMON_VER,
                Duration::from_secs(5),
            )
            .await
        });

        write_auth_json(
            &mut client,
            &ClientHello {
                client_nonce: [0x11; NONCE_LEN],
                role: TEST_ROLE.to_owned(),
            },
        )
        .await;
        let _proof: ServerProof = read_auth_json(&mut client).await;
        write_auth_json(
            &mut client,
            &ClientAuth {
                client_auth: [0u8; PROOF_LEN],
            },
        )
        .await;

        let err = server_task
            .await
            .expect("join")
            .expect_err("wrong proof must be rejected");
        assert!(matches!(err, AuthError::InvalidClientAuth));
        let key_decimals = format!("{:?}", key);
        for rendered in [format!("{err}"), format!("{err:?}")] {
            assert!(
                !rendered.contains(&key_decimals),
                "auth errors must not leak key bytes: {rendered}"
            );
        }
    }

    #[tokio::test]
    async fn over_cap_auth_message_is_rejected_before_allocation() {
        let key = vec![0x5a; MIN_KEY_LEN];
        let daemon_id = [0x6b; DAEMON_ID_LEN];
        let (mut client, mut server) = duplex(4096);
        let server_task = tokio::spawn(async move {
            authenticate_server(
                &mut server,
                &key,
                &daemon_id,
                TEST_DAEMON_VER,
                Duration::from_secs(5),
            )
            .await
        });

        client
            .write_all(&(MAX_AUTH_MESSAGE_LEN + 1).to_le_bytes())
            .await
            .expect("write oversize length");
        let err = server_task
            .await
            .expect("join")
            .expect_err("over-cap message must be rejected");
        assert!(matches!(
            err,
            AuthError::MessageTooLarge {
                stage: AuthStage::ClientHello,
                len,
                max: MAX_AUTH_MESSAGE_LEN,
            } if len == MAX_AUTH_MESSAGE_LEN + 1
        ));
    }

    async fn rejected_server_sends_no_client_auth(
        server_daemon_id: [u8; DAEMON_ID_LEN],
        valid_proof: bool,
        expected: fn(&AuthError) -> bool,
    ) {
        let key = vec![0x5a; MIN_KEY_LEN];
        let expected_daemon_id = [0x6b; DAEMON_ID_LEN];
        let conn = ConnectionInfo {
            schema: crate::connection_file::SCHEMA_VERSION,
            wire_version: crate::wire::PROTOCOL_VERSION,
            endpoints: vec![crate::connection_file::Endpoint {
                host: "127.0.0.1".to_owned(),
                port: 1,
            }],
            key: key.clone(),
            daemon_id: expected_daemon_id,
            pid: 1,
            daemon_ver: TEST_DAEMON_VER.to_owned(),
        };
        let (mut server, mut client) = duplex(4096);
        let task = tokio::spawn(async move {
            authenticate_client(&mut client, &conn, Duration::from_secs(5)).await
        });
        let hello: ClientHello = read_auth_json(&mut server).await;
        let server_nonce = [0x22; NONCE_LEN];
        let server_proof = if valid_proof {
            compute_proof(
                &key,
                SERVER_PROOF_DOMAIN,
                &hello.client_nonce,
                &server_nonce,
                &server_daemon_id,
            )
        } else {
            [0; PROOF_LEN]
        };
        write_auth_json(
            &mut server,
            &ServerProof {
                daemon_id: server_daemon_id,
                server_nonce,
                daemon_ver: TEST_DAEMON_VER.to_owned(),
                server_proof,
            },
        )
        .await;
        let err = task.await.expect("join").expect_err("server rejected");
        assert!(expected(&err), "unexpected error: {err}");
        let mut byte = [0u8; 1];
        assert_eq!(
            server.read(&mut byte).await.expect("read after rejection"),
            0
        );
    }

    #[tokio::test]
    async fn invalid_server_proof_sends_no_client_auth() {
        rejected_server_sends_no_client_auth([0x6b; DAEMON_ID_LEN], false, |err| {
            matches!(err, AuthError::InvalidServerProof)
        })
        .await;
    }

    #[tokio::test]
    async fn daemon_id_mismatch_sends_no_client_auth() {
        rejected_server_sends_no_client_auth([0x7c; DAEMON_ID_LEN], true, |err| {
            matches!(err, AuthError::DaemonIdMismatch)
        })
        .await;
    }

    #[tokio::test]
    async fn short_key_is_rejected_before_any_read() {
        let key = vec![0x5a; MIN_KEY_LEN - 1];
        let daemon_id = [0x6b; DAEMON_ID_LEN];
        let (_client, mut server) = duplex(64);
        let err = authenticate_server(
            &mut server,
            &key,
            &daemon_id,
            TEST_DAEMON_VER,
            Duration::from_secs(1),
        )
        .await
        .expect_err("short key must be rejected");
        assert!(matches!(
            err,
            AuthError::KeyTooShort {
                len,
                min: MIN_KEY_LEN
            } if len == MIN_KEY_LEN - 1
        ));
    }
}
