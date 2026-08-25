//! Independent raw protocol client for host conformance tests.
//!
//! This oracle deliberately re-implements framing, header layout, and proof
//! computation from the literal values in `docs/mc-host-wire-protocol.md`.
//! It must never call `mc-host`'s encoders or proof helpers: expected bytes
//! produced by the code under test prove only self-consistency
//! (protocol §14.1).

#![allow(dead_code)]

use std::path::Path;
use std::time::Duration;

use hmac::{Hmac, Mac};
use sha2::Sha256;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub const HEADER_LEN: usize = 21;
pub const WIRE_VERSION: u8 = 2;
pub const MAX_AUTH_MESSAGE_LEN: u32 = 4096;
pub const SERVER_DOMAIN: &[u8] = b"subc-server-v1";
pub const CLIENT_DOMAIN: &[u8] = b"subc-client-v1";

pub const TY_REQUEST: u8 = 0;
pub const TY_RESPONSE: u8 = 1;
pub const TY_PUSH: u8 = 2;
pub const TY_STREAM_DATA: u8 = 3;
pub const TY_STREAM_END: u8 = 4;
pub const TY_ERROR: u8 = 5;
pub const TY_CANCEL: u8 = 6;
pub const TY_PING: u8 = 7;
pub const TY_PONG: u8 = 8;
pub const TY_HELLO: u8 = 9;
pub const TY_HELLO_ACK: u8 = 10;
pub const TY_GOODBYE: u8 = 11;

/// Interactive priority, Normal admission, not binary, not last.
pub const FLAGS_INTERACTIVE: u8 = 0b0000_0010;
/// Passive priority, Normal admission: the shape host pure-header frames use.
pub const FLAGS_PURE_HEADER: u8 = 0b0000_0000;
/// The flags a terminal non-binary response carries (protocol flag layout:
/// bit0 BINARY, bits1-2 PRIORITY, bit3 LAST, bits4-5 ADMISSION, bits6-7
/// reserved): Interactive priority, Normal admission, binary 0, last 1.
pub const FLAGS_RESPONSE_TEXT_LAST: u8 = 0b0000_1010;

/// Every flag bit a pure-header frame must clear (binary, last,
/// admission, reserved); priority may be any valid value.
pub const FLAGS_PURE_HEADER_FORBIDDEN: u8 = 0b1111_1001;

/// Validates a host-originated connection frame (ping, push, goodbye)
/// against the wire contract's structural rules before a receiver skips
/// it: supported version; pure-header shape and `0/0/nonzero` identity
/// for ping; pure-header shape, zero correlation, and a route-shaped or
/// connection-shaped identity for goodbye; a route-shaped identity with
/// zero correlation and clear reserved bits for push. Accepting a
/// malformed frame solely by type would let a wire regression coexist
/// with an otherwise successful run.
pub fn connection_frame_violation(frame: &RawFrame) -> Option<String> {
    if frame.ver != WIRE_VERSION {
        return Some(format!(
            "connection frame type {} with unsupported wire version {}",
            frame.ty, frame.ver
        ));
    }
    // Generic flag-encoding rules ahead of the per-type shape: reserved
    // bits 6-7 must be zero, and the 0b11 priority and admission
    // encodings are reserved values.
    if frame.flags & 0b1100_0000 != 0 {
        return Some(format!(
            "connection frame type {} with reserved flag bits {:#04x}",
            frame.ty, frame.flags
        ));
    }
    if frame.flags & 0b0000_0110 == 0b0000_0110 {
        return Some(format!(
            "connection frame type {} with reserved priority encoding {:#04x}",
            frame.ty, frame.flags
        ));
    }
    if frame.flags & 0b0011_0000 == 0b0011_0000 {
        return Some(format!(
            "connection frame type {} with reserved admission encoding {:#04x}",
            frame.ty, frame.flags
        ));
    }
    match frame.ty {
        TY_PING => {
            if frame.len != 0 {
                return Some(format!("ping carries body length {}", frame.len));
            }
            if frame.flags & FLAGS_PURE_HEADER_FORBIDDEN != 0 {
                return Some(format!(
                    "ping with non-pure-header flags {:#04x}",
                    frame.flags
                ));
            }
            if frame.channel != 0 || frame.epoch != 0 || frame.corr == 0 {
                return Some(format!(
                    "ping with illegal identity {}/{}/{}",
                    frame.channel, frame.epoch, frame.corr
                ));
            }
        }
        TY_GOODBYE => {
            if frame.len != 0 {
                return Some(format!("goodbye carries body length {}", frame.len));
            }
            if frame.flags & FLAGS_PURE_HEADER_FORBIDDEN != 0 {
                return Some(format!(
                    "goodbye with non-pure-header flags {:#04x}",
                    frame.flags
                ));
            }
            if frame.corr != 0 {
                return Some(format!("goodbye with nonzero correlation {}", frame.corr));
            }
            let route_shaped = frame.channel != 0 && frame.epoch != 0;
            let connection_shaped = frame.channel == 0 && frame.epoch == 0;
            if !route_shaped && !connection_shaped {
                return Some(format!(
                    "goodbye with mixed identity {}/{}",
                    frame.channel, frame.epoch
                ));
            }
        }
        TY_PUSH if frame.channel == 0 || frame.epoch == 0 || frame.corr != 0 => {
            return Some(format!(
                "push with illegal identity {}/{}/{}",
                frame.channel, frame.epoch, frame.corr
            ));
        }
        _ => {}
    }
    None
}

/// A frame as it appears on the wire, decoded by hand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawFrame {
    pub len: u32,
    pub ver: u8,
    pub ty: u8,
    pub flags: u8,
    pub channel: u16,
    pub epoch: u32,
    pub corr: u64,
    pub body: Vec<u8>,
}

impl RawFrame {
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).expect("frame body is JSON")
    }

    pub fn error_code(&self) -> String {
        self.json()["code"]
            .as_str()
            .expect("error body has a code")
            .to_owned()
    }
}

/// Contents of a published connection file, parsed independently.
#[derive(Debug, Clone)]
pub struct Discovered {
    pub host: String,
    pub port: u16,
    pub key: Vec<u8>,
    pub daemon_id: Vec<u8>,
    pub pid: u64,
    pub daemon_ver: String,
    pub schema: u64,
    pub wire_version: u64,
}

/// Validates and reads a publication the way a conforming client must
/// (protocol §4.1): bounded snapshot, schema 1, exactly 32 key bytes, exactly
/// 16 daemon-ID bytes, numeric loopback host, nonzero port.
pub fn discover(path: &Path) -> Result<Discovered, String> {
    let meta = std::fs::symlink_metadata(path).map_err(|err| err.to_string())?;
    if !meta.file_type().is_file() {
        return Err("publication is not a regular file".to_owned());
    }
    if meta.len() > 65_536 {
        return Err("publication exceeds the 64 KiB snapshot cap".to_owned());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(format!("insecure publication mode {mode:#o}"));
        }
    }

    let bytes = std::fs::read(path).map_err(|err| err.to_string())?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).map_err(|err| err.to_string())?;

    let schema = json["schema"].as_u64().ok_or("missing schema")?;
    if schema != 1 {
        return Err(format!("unsupported schema {schema}"));
    }
    let wire_version = json
        .get("wire_version")
        .and_then(serde_json::Value::as_u64)
        .ok_or("missing or invalid wire_version")?;
    if wire_version != u64::from(WIRE_VERSION) {
        return Err(format!("wire version {wire_version} is not 2"));
    }

    let endpoints = json["endpoints"].as_array().ok_or("missing endpoints")?;
    let first = endpoints.first().ok_or("no endpoint")?;
    let host = first["host"].as_str().ok_or("missing host")?.to_owned();
    if host != "127.0.0.1" {
        return Err(format!("non-loopback host {host}"));
    }
    let port = first["port"].as_u64().ok_or("missing port")?;
    if port == 0 || port > u64::from(u16::MAX) {
        return Err(format!("invalid port {port}"));
    }
    let port = u16::try_from(port).map_err(|_| "port out of range")?;

    let key = byte_array(&json["key"]).ok_or("missing key")?;
    if key.len() != 32 {
        return Err(format!("key is {} bytes, expected 32", key.len()));
    }
    let daemon_id = byte_array(&json["daemon_id"]).ok_or("missing daemon_id")?;
    if daemon_id.len() != 16 {
        return Err(format!(
            "daemon_id is {} bytes, expected 16",
            daemon_id.len()
        ));
    }
    let daemon_ver = json["daemon_ver"]
        .as_str()
        .ok_or("missing daemon_ver")?
        .to_owned();
    if daemon_ver.is_empty() {
        return Err("empty daemon_ver".to_owned());
    }

    Ok(Discovered {
        host,
        port,
        key,
        daemon_id,
        pid: json["pid"].as_u64().ok_or("missing pid")?,
        daemon_ver,
        schema,
        wire_version,
    })
}

fn byte_array(value: &serde_json::Value) -> Option<Vec<u8>> {
    value
        .as_array()?
        .iter()
        .map(|entry| u8::try_from(entry.as_u64()?).ok())
        .collect()
}

/// `HMAC-SHA256(key, domain || client_nonce || server_nonce || daemon_id)`,
/// written out from the protocol text rather than shared with the host.
pub fn proof(
    key: &[u8],
    domain: &[u8],
    client_nonce: &[u8],
    server_nonce: &[u8],
    daemon_id: &[u8],
) -> Vec<u8> {
    let mut mac = <Hmac<Sha256>>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(domain);
    mac.update(client_nonce);
    mac.update(server_nonce);
    mac.update(daemon_id);
    mac.finalize().into_bytes().to_vec()
}

/// Encodes a v2 header by writing each field at its documented offset.
pub fn header(len: u32, ty: u8, flags: u8, channel: u16, epoch: u32, corr: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN);
    out.extend_from_slice(&len.to_le_bytes());
    out.push(WIRE_VERSION);
    out.push(ty);
    out.push(flags);
    out.extend_from_slice(&channel.to_le_bytes());
    out.extend_from_slice(&epoch.to_le_bytes());
    out.extend_from_slice(&corr.to_le_bytes());
    out
}

/// Decodes a v2 header by reading each field from its documented offset.
pub fn decode_header(bytes: &[u8]) -> RawFrame {
    assert_eq!(bytes.len(), HEADER_LEN, "header must be 21 bytes");
    RawFrame {
        len: u32::from_le_bytes(bytes[0..4].try_into().expect("len")),
        ver: bytes[4],
        ty: bytes[5],
        flags: bytes[6],
        channel: u16::from_le_bytes(bytes[7..9].try_into().expect("channel")),
        epoch: u32::from_le_bytes(bytes[9..13].try_into().expect("epoch")),
        corr: u64::from_le_bytes(bytes[13..21].try_into().expect("corr")),
        body: Vec::new(),
    }
}

/// An authenticated raw connection.
pub struct RawClient {
    stream: TcpStream,
    pub daemon_ver: String,
    pub server_nonce: Vec<u8>,
    pub client_nonce: Vec<u8>,
    next_corr: u64,
}

impl RawClient {
    pub async fn connect(info: &Discovered) -> Result<Self, String> {
        Self::connect_with_role(info, "client").await
    }

    pub async fn connect_with_role(info: &Discovered, role: &str) -> Result<Self, String> {
        let mut client = Self::connect_setup_only_with_role(info, role).await?;
        client.negotiate_tcp().await?;
        Ok(client)
    }

    pub async fn connect_setup_only(info: &Discovered) -> Result<Self, String> {
        Self::connect_setup_only_with_role(info, "client").await
    }

    pub async fn connect_setup_only_with_role(
        info: &Discovered,
        role: &str,
    ) -> Result<Self, String> {
        let mut stream = TcpStream::connect((info.host.as_str(), info.port))
            .await
            .map_err(|err| err.to_string())?;

        let client_nonce: Vec<u8> = (0u8..32)
            .map(|i| i.wrapping_mul(7).wrapping_add(3))
            .collect();
        write_auth(
            &mut stream,
            &serde_json::json!({"client_nonce": client_nonce, "role": role}),
        )
        .await?;

        let server_message = read_auth(&mut stream).await?;
        let server_nonce =
            byte_array(&server_message["server_nonce"]).ok_or("missing server_nonce")?;
        let daemon_id = byte_array(&server_message["daemon_id"]).ok_or("missing daemon_id")?;
        let server_proof =
            byte_array(&server_message["server_proof"]).ok_or("missing server_proof")?;
        let daemon_ver = server_message["daemon_ver"]
            .as_str()
            .ok_or("missing daemon_ver")?
            .to_owned();

        let expected = proof(
            &info.key,
            SERVER_DOMAIN,
            &client_nonce,
            &server_nonce,
            &daemon_id,
        );
        if expected != server_proof {
            return Err("server proof mismatch".to_owned());
        }
        if daemon_id != info.daemon_id {
            return Err("daemon id mismatch".to_owned());
        }

        let client_auth = proof(
            &info.key,
            CLIENT_DOMAIN,
            &client_nonce,
            &server_nonce,
            &daemon_id,
        );
        write_auth(
            &mut stream,
            &serde_json::json!({"client_auth": client_auth}),
        )
        .await?;

        Ok(Self {
            stream,
            daemon_ver,
            server_nonce,
            client_nonce,
            next_corr: 0,
        })
    }

    async fn negotiate_tcp(&mut self) -> Result<(), String> {
        let corr = self
            .control(&serde_json::json!({
                "op": "transport.negotiate",
                "negotiation_version": 1,
                "offers": [{"transport": "tcp", "capability_version": 1}]
            }))
            .await
            .map_err(|err| err.to_string())?;
        let (skipped, frame) = self.frames_until_corr(corr, Duration::from_secs(5)).await?;
        if !skipped.is_empty() {
            return Err("unexpected frame before transport selection".to_owned());
        }
        if frame.ty != TY_RESPONSE
            || frame.channel != 0
            || frame.epoch != 0
            || frame.flags != FLAGS_RESPONSE_TEXT_LAST
        {
            return Err("invalid transport selection frame".to_owned());
        }
        let expected = serde_json::json!({
            "op": "transport.negotiate",
            "negotiation_version": 1,
            "selected": {"transport": "tcp", "capability_version": 1}
        });
        if frame.json() != expected {
            return Err("invalid TCP transport selection".to_owned());
        }
        Ok(())
    }

    /// Allocates the next monotonic consumer correlation.
    pub fn next_corr(&mut self) -> u64 {
        self.next_corr += 1;
        self.next_corr
    }

    pub fn into_stream(self) -> TcpStream {
        self.stream
    }

    pub async fn send_raw(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.stream.write_all(bytes).await
    }

    /// Half-closes the write side, causing the peer to observe EOF after buffered bytes.
    pub async fn shutdown_write(&mut self) -> std::io::Result<()> {
        self.stream.shutdown().await
    }

    pub async fn send_frame(
        &mut self,
        ty: u8,
        flags: u8,
        channel: u16,
        epoch: u32,
        corr: u64,
        body: &[u8],
    ) -> std::io::Result<()> {
        let mut wire = header(body.len() as u32, ty, flags, channel, epoch, corr);
        wire.extend_from_slice(body);
        self.stream.write_all(&wire).await
    }

    /// Sends a channel-0 control request and returns its correlation.
    pub async fn control(&mut self, body: &serde_json::Value) -> std::io::Result<u64> {
        let corr = self.next_corr();
        let encoded = serde_json::to_vec(body).expect("control body serializes");
        self.send_frame(TY_REQUEST, FLAGS_INTERACTIVE, 0, 0, corr, &encoded)
            .await?;
        Ok(corr)
    }

    /// Opens a route and returns `(channel, epoch)` on success.
    pub async fn route_open(
        &mut self,
        module_id: &str,
        project_root: &str,
        harness: &str,
        session: &str,
    ) -> Result<(u16, u32), String> {
        self.route_open_target("tool_provider", module_id, project_root, harness, session)
            .await
    }

    pub async fn route_open_target(
        &mut self,
        kind: &str,
        module_id: &str,
        project_root: &str,
        harness: &str,
        session: &str,
    ) -> Result<(u16, u32), String> {
        let corr = self
            .control(&serde_json::json!({
                "op": "route.open",
                "target": {"kind": kind, "module_id": module_id},
                "identity": {
                    "project_root": project_root,
                    "harness": harness,
                    "session": session
                }
            }))
            .await
            .map_err(|err| err.to_string())?;
        let frame = self.expect_frame().await.map_err(|err| err.to_string())?;
        if frame.corr != corr {
            return Err(format!("correlation {} did not match {corr}", frame.corr));
        }
        if frame.ty == TY_ERROR {
            return Err(frame.error_code());
        }
        let json = frame.json();
        if json["op"] != "route.open" {
            return Err(format!("response lost its tag: {json}"));
        }
        Ok((
            u16::try_from(json["route_channel"].as_u64().ok_or("no channel")?)
                .map_err(|_| "channel out of range")?,
            u32::try_from(json["route_epoch"].as_u64().ok_or("no epoch")?)
                .map_err(|_| "epoch out of range")?,
        ))
    }

    /// Reads one complete frame, header first.
    pub async fn expect_frame(&mut self) -> std::io::Result<RawFrame> {
        let mut header_bytes = [0u8; HEADER_LEN];
        self.stream.read_exact(&mut header_bytes).await?;
        let mut frame = decode_header(&header_bytes);
        if frame.len > 0 {
            let mut body = vec![0u8; frame.len as usize];
            self.stream.read_exact(&mut body).await?;
            frame.body = body;
        }
        Ok(frame)
    }

    /// Reads one frame within `budget`.
    pub async fn frame_within(&mut self, budget: Duration) -> Result<RawFrame, String> {
        match tokio::time::timeout(budget, self.expect_frame()).await {
            Ok(Ok(frame)) => Ok(frame),
            Ok(Err(err)) => Err(format!("frame read failed: {err}")),
            Err(_) => Err("timed out waiting for a frame".to_owned()),
        }
    }

    /// Reads frames until one matches `corr`, collecting the skipped frames.
    pub async fn frames_until_corr(
        &mut self,
        corr: u64,
        budget: Duration,
    ) -> Result<(Vec<RawFrame>, RawFrame), String> {
        let deadline = tokio::time::Instant::now() + budget;
        let mut skipped = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(format!("no frame for correlation {corr} within budget"));
            }
            let frame = self.frame_within(remaining).await?;
            if frame.corr == corr && frame.ty != TY_PING {
                return Ok((skipped, frame));
            }
            skipped.push(frame);
        }
    }

    /// True when the host closed the connection without sending more frames.
    pub async fn closed_within(&mut self, budget: Duration) -> bool {
        let mut byte = [0u8; 1];
        match tokio::time::timeout(budget, self.stream.read(&mut byte)).await {
            Ok(Ok(0)) => true,
            Ok(Ok(_)) => false,
            Ok(Err(_)) => true,
            Err(_) => false,
        }
    }

    /// Drains frames until EOF, returning everything read.
    pub async fn drain_until_close(&mut self, budget: Duration) -> Vec<RawFrame> {
        let deadline = tokio::time::Instant::now() + budget;
        let mut frames = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return frames;
            }
            match self.frame_within(remaining).await {
                Ok(frame) => frames.push(frame),
                Err(_) => return frames,
            }
        }
    }
}

async fn write_auth(stream: &mut TcpStream, value: &serde_json::Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|err| err.to_string())?;
    let len = u32::try_from(body.len()).map_err(|_| "auth message too long")?;
    stream
        .write_all(&len.to_le_bytes())
        .await
        .map_err(|err| err.to_string())?;
    stream.write_all(&body).await.map_err(|err| err.to_string())
}

async fn read_auth(stream: &mut TcpStream) -> Result<serde_json::Value, String> {
    let mut len_bytes = [0u8; 4];
    stream
        .read_exact(&mut len_bytes)
        .await
        .map_err(|err| err.to_string())?;
    let len = u32::from_le_bytes(len_bytes);
    if len > MAX_AUTH_MESSAGE_LEN {
        return Err(format!("auth message length {len} over cap"));
    }
    let mut body = vec![0u8; len as usize];
    stream
        .read_exact(&mut body)
        .await
        .map_err(|err| err.to_string())?;
    serde_json::from_slice(&body).map_err(|err| err.to_string())
}

/// Opens a TCP connection and returns it without authenticating, for
/// admission and handshake-deadline tests.
pub async fn connect_unauthenticated(info: &Discovered) -> std::io::Result<TcpStream> {
    TcpStream::connect((info.host.as_str(), info.port)).await
}
