//! The connection engine and its transports share frame encoding, protocol
//! size caps, and aggregate resident-byte accounting.
//!
//! ```text
//!  offset  size  field     type    purpose
//!    0      4    len       u32     # of BODY bytes after this 21-byte header
//!    4      1    ver       u8      envelope version
//!    5      1    type      u8      frame kind (see FrameType)
//!    6      1    flags     u8      bit0 BINARY · bits1-2 PRIORITY · bit3 LAST · bits4-5 ADMISSION · bits6-7 reserved
//!    7      2    channel   u16     route slot; 0 = the host itself
//!    9      4    epoch     u32     per-slot binding epoch; 0 on channel 0
//!   13      8    corr      u64     correlation id; CANCEL carries the target call's corr
//!   21 -> body
//! ```
//!
//! Little-endian. **Frozen prefix:** `len` (u32 @ 0) and `ver` (u8 @ 4) keep
//! fixed meaning and position in every future version; `decode_header`
//! enforces that discipline.

use std::{error::Error, fmt, sync::Arc};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Envelope protocol version this build speaks.
pub const PROTOCOL_VERSION: u8 = 2;

/// Fixed header length for `PROTOCOL_VERSION` 2.
pub const HEADER_LEN: usize = 21;

/// Bytes of the frozen prefix (`len` u32 + `ver` u8) that are stable across
/// every envelope version.
pub const FROZEN_PREFIX_LEN: usize = 5;

/// Maximum frame body accepted before allocation (64 MiB).
pub const MAX_FRAME_BODY_LEN: u32 = 64 * 1024 * 1024;

/// Env var naming the module id a supervised child registers under.
/// Canonical version-2 vocabulary (KTD8): the name is protocol surface and
/// must stay byte-identical.
pub const SUBC_MODULE_ID_ENV: &str = "SUBC_MODULE_ID";

/// Env var carrying the one-time launch nonce injected into a spawned
/// reserved module. Canonical version-2 vocabulary (KTD8).
pub const SUBC_LAUNCH_NONCE_ENV: &str = "SUBC_LAUNCH_NONCE";

/// Frame kind (`type` byte at offset 5).
///
/// `CANCEL`, `PING`, `PONG`, and `GOODBYE` are pure-header frames (`len == 0`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FrameType {
    Request = 0,
    Response = 1,
    Push = 2,
    StreamData = 3,
    StreamEnd = 4,
    Error = 5,
    Cancel = 6,
    Ping = 7,
    Pong = 8,
    Hello = 9,
    HelloAck = 10,
    Goodbye = 11,
}

impl FrameType {
    /// Map the raw `type` byte to a `FrameType`, or `None` if unknown.
    pub fn from_u8(b: u8) -> Option<Self> {
        Some(match b {
            0 => Self::Request,
            1 => Self::Response,
            2 => Self::Push,
            3 => Self::StreamData,
            4 => Self::StreamEnd,
            5 => Self::Error,
            6 => Self::Cancel,
            7 => Self::Ping,
            8 => Self::Pong,
            9 => Self::Hello,
            10 => Self::HelloAck,
            11 => Self::Goodbye,
            _ => return None,
        })
    }

    pub fn is_pure_header(self) -> bool {
        matches!(self, Self::Cancel | Self::Ping | Self::Pong | Self::Goodbye)
    }
}

/// Scheduling priority carried in `flags` bits 1-2.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Priority {
    Passive = 0,
    Interactive = 1,
    Background = 2,
}

impl Priority {
    fn from_bits(bits: u8) -> Option<Self> {
        Some(match bits {
            0 => Self::Passive,
            1 => Self::Interactive,
            2 => Self::Background,
            _ => return None,
        })
    }
}

/// Admission behavior carried in `flags` bits 4-5.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum AdmissionClass {
    Normal = 0,
    Expedite = 1,
    Sheddable = 2,
}

impl AdmissionClass {
    fn from_bits(bits: u8) -> Option<Self> {
        Some(match bits {
            0 => Self::Normal,
            1 => Self::Expedite,
            2 => Self::Sheddable,
            _ => return None,
        })
    }
}

const FLAG_BINARY: u8 = 0b0000_0001; // bit 0
const FLAG_PRIORITY_MASK: u8 = 0b0000_0110; // bits 1-2
const FLAG_PRIORITY_SHIFT: u8 = 1;
const FLAG_LAST: u8 = 0b0000_1000; // bit 3
const FLAG_ADMISSION_MASK: u8 = 0b0011_0000; // bits 4-5
const FLAG_ADMISSION_SHIFT: u8 = 4;
const FLAG_RESERVED_MASK: u8 = 0b1100_0000; // bits 6-7 must be zero

/// The `flags` byte (offset 6): binary, priority, last, admission, then
/// reserved bits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Flags(pub u8);

impl Flags {
    /// Build flags with the default [`AdmissionClass::Normal`] class.
    pub fn new(binary: bool, priority: Priority, last: bool) -> Self {
        let mut b = 0u8;
        if binary {
            b |= FLAG_BINARY;
        }
        b |= (priority as u8) << FLAG_PRIORITY_SHIFT;
        if last {
            b |= FLAG_LAST;
        }
        Flags(b)
    }

    /// Body is raw bytes (bulk lane) rather than JSON-RPC.
    pub fn is_binary(self) -> bool {
        self.0 & FLAG_BINARY != 0
    }

    /// Final frame of a streamed message.
    pub fn is_last(self) -> bool {
        self.0 & FLAG_LAST != 0
    }

    /// Decode the priority bits, or `None` if they hold a reserved value.
    pub fn priority(self) -> Option<Priority> {
        Priority::from_bits((self.0 & FLAG_PRIORITY_MASK) >> FLAG_PRIORITY_SHIFT)
    }

    /// Decode the admission-class bits, or `None` if they hold `0b11`.
    pub fn admission_class(self) -> Option<AdmissionClass> {
        AdmissionClass::from_bits((self.0 & FLAG_ADMISSION_MASK) >> FLAG_ADMISSION_SHIFT)
    }

    /// True if either reserved bit (6-7) is set.
    pub fn has_reserved_bits(self) -> bool {
        self.0 & FLAG_RESERVED_MASK != 0
    }
}

/// A decoded envelope header. The body is the `len` bytes that follow it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnvelopeHeader {
    /// Number of body bytes after the header.
    pub len: u32,
    /// Envelope version.
    pub ver: u8,
    /// Frame kind.
    pub ty: FrameType,
    /// Flag bits.
    pub flags: Flags,
    /// Sender-local route slot; 0 is the control channel.
    pub channel: u16,
    /// Sender-local binding epoch; 0 is reserved for the control channel.
    pub epoch: u32,
    /// Correlation id.
    pub corr: u64,
}

impl EnvelopeHeader {
    /// Serialize the header to its fixed 21-byte little-endian form.
    pub fn encode(&self) -> [u8; HEADER_LEN] {
        let mut buf = [0u8; HEADER_LEN];
        buf[0..4].copy_from_slice(&self.len.to_le_bytes());
        buf[4] = self.ver;
        buf[5] = self.ty as u8;
        buf[6] = self.flags.0;
        buf[7..9].copy_from_slice(&self.channel.to_le_bytes());
        buf[9..13].copy_from_slice(&self.epoch.to_le_bytes());
        buf[13..21].copy_from_slice(&self.corr.to_le_bytes());
        buf
    }
}

/// Why a header could not be decoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeError {
    /// Fewer than `FROZEN_PREFIX_LEN` bytes — cannot even read `len`/`ver`.
    TooShortForPrefix { have: usize },
    /// `ver` is not a version this build understands.
    UnsupportedVersion { ver: u8 },
    /// Version known but fewer than its header length is present.
    TooShortForHeader { have: usize, need: usize },
    /// `type` byte is not a known `FrameType`.
    UnknownFrameType { byte: u8 },
    /// A reserved flag bit (6-7) is set.
    ReservedFlagBits { flags: u8 },
    /// Priority bits 1-2 hold the reserved value `0b11`.
    ReservedPriorityBits { flags: u8 },
    /// Admission bits 4-5 hold the reserved value `0b11`.
    ReservedAdmissionClass { flags: u8 },
    /// SHEDDABLE is set on a frame type that must be delivered.
    SheddableIllegalFrameType { ty: FrameType, flags: u8 },
    /// Channel 0 carried an epoch other than its reserved epoch 0.
    NonzeroEpochOnControlChannel { epoch: u32 },
    /// A routed channel carried epoch 0, which is reserved for channel 0.
    ZeroEpochOnRoutedChannel { channel: u16 },
    /// A pure-header frame declared body bytes.
    PureHeaderFrameWithBody { ty: FrameType, len: u32 },
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooShortForPrefix { have } => {
                write!(f, "header shorter than frozen prefix: have {have} bytes")
            }
            Self::UnsupportedVersion { ver } => write!(f, "unsupported envelope version {ver}"),
            Self::TooShortForHeader { have, need } => {
                write!(
                    f,
                    "header too short for version: have {have} bytes, need {need}"
                )
            }
            Self::UnknownFrameType { byte } => write!(f, "unknown frame type byte {byte}"),
            Self::ReservedFlagBits { flags } => {
                write!(f, "reserved flag bits set in flags 0b{flags:08b}")
            }
            Self::ReservedPriorityBits { flags } => {
                write!(f, "reserved priority bits set in flags 0b{flags:08b}")
            }
            Self::ReservedAdmissionClass { flags } => {
                write!(f, "reserved admission class set in flags 0b{flags:08b}")
            }
            Self::SheddableIllegalFrameType { ty, flags } => write!(
                f,
                "SHEDDABLE admission class is illegal on {ty:?} in flags 0b{flags:08b}"
            ),
            Self::NonzeroEpochOnControlChannel { epoch } => {
                write!(f, "control channel carried nonzero epoch {epoch}")
            }
            Self::ZeroEpochOnRoutedChannel { channel } => {
                write!(f, "routed channel {channel} carried zero epoch")
            }
            Self::PureHeaderFrameWithBody { ty, len } => {
                write!(
                    f,
                    "pure-header frame {ty:?} declared non-zero body length {len}"
                )
            }
        }
    }
}

impl Error for DecodeError {}

/// How many header bytes a given envelope version occupies. Driven by the
/// frozen prefix: read `ver`, then learn the full header length here.
fn header_len_for_version(ver: u8) -> Option<usize> {
    match ver {
        PROTOCOL_VERSION => Some(HEADER_LEN),
        _ => None,
    }
}

/// Decode an envelope header from the front of `bytes`, following the
/// frozen-prefix discipline:
/// 1. need at least the 5-byte prefix to read `len` + `ver`;
/// 2. dispatch the full header length on `ver`;
/// 3. need the full header present; then parse the rest.
///
/// Never panics on malformed input — returns a typed [`DecodeError`].
pub fn decode_header(bytes: &[u8]) -> Result<EnvelopeHeader, DecodeError> {
    if bytes.len() < FROZEN_PREFIX_LEN {
        return Err(DecodeError::TooShortForPrefix { have: bytes.len() });
    }
    let ver = bytes[4];
    let need = header_len_for_version(ver).ok_or(DecodeError::UnsupportedVersion { ver })?;
    if bytes.len() < need {
        return Err(DecodeError::TooShortForHeader {
            have: bytes.len(),
            need,
        });
    }

    let len = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    let ty =
        FrameType::from_u8(bytes[5]).ok_or(DecodeError::UnknownFrameType { byte: bytes[5] })?;
    let flags = Flags(bytes[6]);
    if flags.has_reserved_bits() {
        return Err(DecodeError::ReservedFlagBits { flags: bytes[6] });
    }
    if flags.priority().is_none() {
        return Err(DecodeError::ReservedPriorityBits { flags: bytes[6] });
    }
    let admission_class = flags
        .admission_class()
        .ok_or(DecodeError::ReservedAdmissionClass { flags: bytes[6] })?;
    if admission_class == AdmissionClass::Sheddable
        && !matches!(ty, FrameType::Push | FrameType::StreamData)
    {
        return Err(DecodeError::SheddableIllegalFrameType {
            ty,
            flags: bytes[6],
        });
    }
    if ty.is_pure_header() && len != 0 {
        return Err(DecodeError::PureHeaderFrameWithBody { ty, len });
    }
    let channel = u16::from_le_bytes([bytes[7], bytes[8]]);
    let epoch = u32::from_le_bytes([bytes[9], bytes[10], bytes[11], bytes[12]]);
    if channel == 0 && epoch != 0 {
        return Err(DecodeError::NonzeroEpochOnControlChannel { epoch });
    }
    // Epoch 0 is reserved for the control channel (Section 6.1), so a routed
    // channel without an epoch names no bindable route. Rejecting it here keeps
    // the framing layer's identity contract symmetric instead of leaving the
    // frame to be dropped as unmatched further up.
    if channel != 0 && epoch == 0 {
        return Err(DecodeError::ZeroEpochOnRoutedChannel { channel });
    }
    let corr = u64::from_le_bytes([
        bytes[13], bytes[14], bytes[15], bytes[16], bytes[17], bytes[18], bytes[19], bytes[20],
    ]);

    Ok(EnvelopeHeader {
        len,
        ver,
        ty,
        flags,
        channel,
        epoch,
        corr,
    })
}

/// Interoperability body maximum: exactly 64 MiB (protocol §6.3).
pub const MAX_BODY_LEN: u32 = MAX_FRAME_BODY_LEN;

/// Profile cap for a channel-0 control body (protocol §7.1).
pub const MAX_CONTROL_BODY_LEN: u32 = 65_536;

/// Aggregate resident-byte accounting.
///
/// One permit is one byte. Charges attach to the buffers they account for and
/// travel with moves; host-managed copies acquire a second charge. Tokio's
/// semaphore is FIFO, so a queued maximum-size acquisition cannot be starved
/// by later small ones; the frame deadline bounds how long an admission may
/// wait.
#[derive(Clone)]
pub struct ByteBudget {
    semaphore: Arc<Semaphore>,
    /// Permits the budget was created with. Retained because the semaphore
    /// reports only what is currently available, and distinguishing "cannot
    /// be satisfied right now" from "can never be satisfied" needs the
    /// ceiling: the second case is a permanent rejection, not backpressure.
    capacity: usize,
}

impl ByteBudget {
    pub fn new(max_bytes: u64) -> Self {
        let capacity = max_bytes as usize;
        Self {
            semaphore: Arc::new(Semaphore::new(capacity)),
            capacity,
        }
    }

    /// The ceiling an acquisition is measured against. A request for more
    /// than this can never succeed no matter how much traffic drains, so
    /// callers must report it as permanent rather than retryable.
    pub(crate) fn capacity(&self) -> usize {
        self.capacity
    }

    /// Waits for `bytes` of budget. Callers must bound the wait (deadline or
    /// cancellation); the reader races this against the frame deadline and
    /// emit paths race it against generation retirement.
    pub async fn charge(&self, bytes: u32) -> ByteCharge {
        let permit = self
            .semaphore
            .clone()
            .acquire_many_owned(bytes)
            .await
            .expect("byte budget semaphore is never closed");
        ByteCharge {
            permit: Some(permit),
        }
    }

    /// Atomically reserves `bytes` without waiting. `None` means the budget
    /// cannot cover the request right now (or the count does not fit a
    /// permit count); nothing is acquired partially.
    pub fn try_charge(&self, bytes: usize) -> Option<ByteCharge> {
        let bytes = u32::try_from(bytes).ok()?;
        if bytes == 0 {
            return Some(ByteCharge::none());
        }
        self.semaphore
            .clone()
            .try_acquire_many_owned(bytes)
            .ok()
            .map(|permit| ByteCharge {
                permit: Some(permit),
            })
    }

    pub(crate) fn available(&self) -> usize {
        self.semaphore.available_permits()
    }
}

/// One held byte charge; releases its bytes on drop.
#[derive(Debug)]
pub struct ByteCharge {
    // Held for its Drop: releasing the permit returns the bytes to the
    // budget at exactly the point the accounted buffer dies.
    permit: Option<OwnedSemaphorePermit>,
}

impl ByteCharge {
    /// A zero-byte charge for header-only frames.
    pub fn none() -> Self {
        Self { permit: None }
    }

    pub(crate) fn bytes(&self) -> usize {
        self.permit
            .as_ref()
            .map_or(0, OwnedSemaphorePermit::num_permits)
    }

    /// Splits `bytes` off into an independently owned charge. `None` when
    /// this charge holds fewer than `bytes`; the original is unchanged then,
    /// so a failed split can never create or destroy permits.
    pub(crate) fn split(&mut self, bytes: usize) -> Option<ByteCharge> {
        if bytes == 0 {
            return Some(ByteCharge::none());
        }
        let permit = self.permit.as_mut()?.split(bytes)?;
        Some(ByteCharge {
            permit: Some(permit),
        })
    }

    pub(crate) fn split_or_take(&mut self, bytes: usize) -> ByteCharge {
        match self.split(bytes) {
            Some(charge) => charge,
            None => std::mem::replace(self, ByteCharge::none()),
        }
    }

    /// Monotonic shrink: releases everything above `bytes` back to the
    /// budget immediately. A request to grow (bytes above the held count)
    /// is a no-op — a charge can never be inflated after acquisition.
    pub(crate) fn shrink_to(&mut self, bytes: usize) {
        drop(self.split_excess(bytes));
    }

    /// Monotonic shrink that hands the released permits back instead of
    /// dropping them, so a caller holding a lock can defer the release
    /// until after the guard falls. Releasing a permit takes the budget's
    /// own waiter lock and wakes queued waiters, which must not happen
    /// underneath an unrelated mutex.
    pub(crate) fn split_excess(&mut self, bytes: usize) -> ByteCharge {
        let excess = self.bytes().saturating_sub(bytes);
        if excess == 0 {
            return ByteCharge::none();
        }
        // `excess` is at most the held count, so the split cannot fail.
        self.split(excess).unwrap_or_else(ByteCharge::none)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameId {
    pub channel: u16,
    pub epoch: u32,
    pub corr: u64,
}

impl FrameId {
    /// Control frames use channel 0 and epoch 0.
    pub fn control(corr: u64) -> Self {
        Self {
            channel: 0,
            epoch: 0,
            corr,
        }
    }

    pub fn routed(route: crate::handler::RouteHandle, corr: u64) -> Self {
        Self {
            channel: route.channel,
            epoch: route.epoch,
            corr,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncodeError {
    pub body_len: usize,
}

/// Encodes one complete frame (header then body) as a single buffer so the
/// writer emits it in one logical write.
#[cfg(test)]
pub fn encode_frame(
    ty: FrameType,
    flags: Flags,
    id: FrameId,
    body: &[u8],
) -> Result<Vec<u8>, EncodeError> {
    if body.len() > MAX_BODY_LEN as usize {
        return Err(EncodeError {
            body_len: body.len(),
        });
    }
    let len = u32::try_from(body.len()).map_err(|_| EncodeError {
        body_len: body.len(),
    })?;
    let header = EnvelopeHeader {
        len,
        ver: PROTOCOL_VERSION,
        ty,
        flags,
        channel: id.channel,
        epoch: id.epoch,
        corr: id.corr,
    };
    let mut buf = Vec::with_capacity(HEADER_LEN + body.len());
    buf.extend_from_slice(&header.encode());
    buf.extend_from_slice(body);
    Ok(buf)
}

pub fn encode_owned_frame(
    ty: FrameType,
    flags: Flags,
    id: FrameId,
    mut body: Vec<u8>,
) -> Result<Vec<u8>, EncodeError> {
    if body.len() > MAX_BODY_LEN as usize {
        return Err(EncodeError {
            body_len: body.len(),
        });
    }
    let body_len = body.len();
    let len = u32::try_from(body_len).map_err(|_| EncodeError { body_len })?;
    let header = EnvelopeHeader {
        len,
        ver: PROTOCOL_VERSION,
        ty,
        flags,
        channel: id.channel,
        epoch: id.epoch,
        corr: id.corr,
    }
    .encode();
    // Exact-size growth: amortized `reserve` may double a full-capacity body
    // (a 64 MiB response would hold 128 MiB), exceeding what the caller's
    // byte-budget charge accounts for.
    body.reserve_exact(HEADER_LEN);
    body.resize(body_len + HEADER_LEN, 0);
    body.copy_within(..body_len, HEADER_LEN);
    body[..HEADER_LEN].copy_from_slice(&header);
    Ok(body)
}

/// Bodies of at least this size use [`OutboundFrame::tail`] to avoid copying
/// the body.
const SPLIT_WRITE_MIN_BODY: usize = 16 * 1024;

pub fn encode_split_frame(
    ty: FrameType,
    flags: Flags,
    id: FrameId,
    body: Vec<u8>,
) -> Result<(Vec<u8>, Vec<u8>), EncodeError> {
    if body.len() < SPLIT_WRITE_MIN_BODY {
        return Ok((encode_owned_frame(ty, flags, id, body)?, Vec::new()));
    }
    let body_len = body.len();
    if body_len > MAX_BODY_LEN as usize {
        return Err(EncodeError { body_len });
    }
    let len = u32::try_from(body_len).map_err(|_| EncodeError { body_len })?;
    let header = EnvelopeHeader {
        len,
        ver: PROTOCOL_VERSION,
        ty,
        flags,
        channel: id.channel,
        epoch: id.epoch,
        corr: id.corr,
    }
    .encode();
    Ok((header.to_vec(), body))
}

/// Default flags for host-emitted body frames.
pub fn response_flags(binary: bool, last: bool) -> Flags {
    Flags::new(binary, Priority::Interactive, last)
}

/// Flags for host-emitted pure-header frames: binary 0, last 0, Normal
/// admission (protocol §6.1).
pub fn pure_header_flags() -> Flags {
    Flags::new(false, Priority::Passive, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hdr(len: u32, ty: FrameType, flags: Flags, channel: u16, corr: u64) -> EnvelopeHeader {
        hdr_with_epoch(len, ty, flags, channel, u32::from(channel != 0), corr)
    }

    fn hdr_with_epoch(
        len: u32,
        ty: FrameType,
        flags: Flags,
        channel: u16,
        epoch: u32,
        corr: u64,
    ) -> EnvelopeHeader {
        EnvelopeHeader {
            len,
            ver: PROTOCOL_VERSION,
            ty,
            flags,
            channel,
            epoch,
            corr,
        }
    }

    #[test]
    fn canonical_env_names_are_pinned() {
        assert_eq!(SUBC_MODULE_ID_ENV, "SUBC_MODULE_ID");
        assert_eq!(SUBC_LAUNCH_NONCE_ENV, "SUBC_LAUNCH_NONCE");
    }

    #[test]
    fn round_trip_request() {
        let h = hdr(
            1234,
            FrameType::Request,
            Flags::new(false, Priority::Interactive, false),
            42,
            0xDEAD_BEEF_0000_0001,
        );
        let decoded = decode_header(&h.encode()).unwrap();
        assert_eq!(h, decoded);
    }

    #[test]
    fn round_trip_all_frame_types() {
        for b in 0u8..=11 {
            let ty = FrameType::from_u8(b).unwrap();
            let h = hdr(0, ty, Flags::new(false, Priority::Passive, false), 0, 0);
            assert_eq!(decode_header(&h.encode()).unwrap().ty, ty);
        }
        assert_eq!(FrameType::from_u8(12), None);
    }

    #[test]
    fn little_endian_and_frozen_prefix_layout() {
        let h = hdr_with_epoch(
            0x0403_0201,
            FrameType::Request,
            Flags(0),
            0x0605,
            0x0a09_0807,
            0x1211_100f_0e0d_0c0b,
        );
        let buf = h.encode();
        assert_eq!(&buf[0..4], &[1, 2, 3, 4]);
        assert_eq!(buf[4], PROTOCOL_VERSION);
        assert_eq!(&buf[7..9], &[5, 6]);
        assert_eq!(&buf[9..13], &[7, 8, 9, 10]);
        assert_eq!(&buf[13..21], &[11, 12, 13, 14, 15, 16, 17, 18]);
        assert_eq!(buf.len(), HEADER_LEN);
    }

    #[test]
    fn reject_truncated_headers_and_unsupported_versions() {
        assert_eq!(
            decode_header(&[0, 0, 0, 0]),
            Err(DecodeError::TooShortForPrefix { have: 4 })
        );
        let mut b = [0u8; 10];
        b[4] = PROTOCOL_VERSION;
        assert_eq!(
            decode_header(&b),
            Err(DecodeError::TooShortForHeader {
                have: 10,
                need: HEADER_LEN
            })
        );
        let mut b = [0u8; HEADER_LEN];
        b[4] = 1;
        assert_eq!(
            decode_header(&b),
            Err(DecodeError::UnsupportedVersion { ver: 1 })
        );
    }

    #[test]
    fn reject_unknown_frame_type_and_reserved_flag_encodings() {
        let mut b = [0u8; HEADER_LEN];
        b[4] = PROTOCOL_VERSION;
        b[5] = 99;
        assert_eq!(
            decode_header(&b),
            Err(DecodeError::UnknownFrameType { byte: 99 })
        );

        let mut b = [0u8; HEADER_LEN];
        b[4] = PROTOCOL_VERSION;
        b[5] = FrameType::Request as u8;
        b[6] = 0b1000_0000; // reserved bit 7 set
        assert_eq!(
            decode_header(&b),
            Err(DecodeError::ReservedFlagBits { flags: 0b1000_0000 })
        );

        b[6] = 0b0000_0110; // priority bits 1-2 hold reserved 0b11
        assert_eq!(
            decode_header(&b),
            Err(DecodeError::ReservedPriorityBits { flags: 0b0000_0110 })
        );

        b[6] = 0b0011_0000; // admission bits 4-5 hold reserved 0b11
        assert_eq!(
            decode_header(&b),
            Err(DecodeError::ReservedAdmissionClass { flags: 0b0011_0000 })
        );
    }

    #[test]
    fn reject_pure_header_frame_with_body_len() {
        let h = hdr(
            1,
            FrameType::Ping,
            Flags::new(false, Priority::Passive, false),
            0,
            1,
        );
        assert_eq!(
            decode_header(&h.encode()),
            Err(DecodeError::PureHeaderFrameWithBody {
                ty: FrameType::Ping,
                len: 1
            })
        );
    }

    #[test]
    fn epoch_boundaries_round_trip_and_control_channel_epoch_is_reserved() {
        for (channel, epoch) in [(0, 0), (1, 1), (u16::MAX, u32::MAX)] {
            let h = hdr_with_epoch(
                0,
                FrameType::Request,
                Flags::new(false, Priority::Passive, false),
                channel,
                epoch,
                9,
            );
            assert_eq!(decode_header(&h.encode()).unwrap(), h);
        }
        let h = hdr_with_epoch(
            0,
            FrameType::Request,
            Flags::new(false, Priority::Passive, false),
            0,
            u32::MAX,
            2,
        );
        assert_eq!(
            decode_header(&h.encode()),
            Err(DecodeError::NonzeroEpochOnControlChannel { epoch: u32::MAX })
        );
        // Epoch 0 is reserved for channel 0, so a routed channel must carry a
        // nonzero epoch. Both halves of the pairing are structural.
        let h = hdr_with_epoch(
            0,
            FrameType::Request,
            Flags::new(false, Priority::Passive, false),
            7,
            0,
            2,
        );
        assert_eq!(
            decode_header(&h.encode()),
            Err(DecodeError::ZeroEpochOnRoutedChannel { channel: 7 })
        );
    }

    #[test]
    fn sheddable_rejected_on_every_illegal_frame_type() {
        // AdmissionClass::Sheddable = 0b10 at bits 4-5.
        let flags = Flags(Flags::new(false, Priority::Passive, false).0 | 0b0010_0000);
        assert_eq!(flags.admission_class(), Some(AdmissionClass::Sheddable));
        for ty in [
            FrameType::Request,
            FrameType::Response,
            FrameType::StreamEnd,
            FrameType::Error,
            FrameType::Cancel,
            FrameType::Ping,
            FrameType::Pong,
            FrameType::Hello,
            FrameType::HelloAck,
            FrameType::Goodbye,
        ] {
            let h = hdr(0, ty, flags, 1, 2);
            assert_eq!(
                decode_header(&h.encode()),
                Err(DecodeError::SheddableIllegalFrameType { ty, flags: flags.0 })
            );
        }
        for ty in [FrameType::Push, FrameType::StreamData] {
            let h = hdr_with_epoch(0, ty, flags, 1, 1, 0);
            assert_eq!(decode_header(&h.encode()).unwrap().flags, flags);
        }
    }

    #[test]
    fn capacity_separates_permanent_from_transient_exhaustion() {
        let budget = ByteBudget::new(100);
        assert_eq!(budget.capacity(), 100);
        // Above the ceiling: no drain can ever satisfy it, so a caller must
        // report this permanently rather than as retryable backpressure.
        assert!(budget.try_charge(101).is_none());
        assert_eq!(
            budget.available(),
            budget.capacity(),
            "a request above the ceiling consumes nothing"
        );
        // Within the ceiling but currently held: the same `None`, and only
        // `capacity` distinguishes it from the permanent case.
        let held = budget.try_charge(80).expect("fits");
        assert!(budget.try_charge(40).is_none());
        assert!(
            40 <= budget.capacity(),
            "this request is transiently blocked, not impossible"
        );
        drop(held);
        assert!(budget.try_charge(40).is_some(), "capacity reopened");
    }

    #[test]
    fn try_charge_is_exact_and_all_or_none() {
        let budget = ByteBudget::new(100);
        let charge = budget.try_charge(60).expect("fits");
        assert_eq!(budget.available(), 40);
        assert!(
            budget.try_charge(41).is_none(),
            "over-capacity acquisition must not partially reduce the budget"
        );
        assert_eq!(budget.available(), 40);
        drop(charge);
        assert_eq!(budget.available(), 100);
        // Zero-byte and unconvertible requests never create a backed charge.
        assert_eq!(budget.try_charge(0).expect("zero charge").bytes(), 0);
        assert!(budget.try_charge(u32::MAX as usize + 1).is_none());
        assert_eq!(budget.available(), 100);
    }

    #[test]
    fn split_preserves_total_and_shrink_releases_only_the_delta() {
        let budget = ByteBudget::new(100);
        let mut charge = budget.try_charge(80).expect("fits");
        let mut portion = charge.split(30).expect("within the charge");
        assert_eq!(charge.bytes(), 50);
        assert_eq!(portion.bytes(), 30);
        assert_eq!(
            budget.available(),
            20,
            "a split moves permits, never frees them"
        );

        portion.shrink_to(10);
        assert_eq!(portion.bytes(), 10);
        assert_eq!(budget.available(), 40);
        // Growing is refused: shrink is monotonic.
        portion.shrink_to(usize::MAX);
        assert_eq!(portion.bytes(), 10);
        assert_eq!(budget.available(), 40);

        assert!(
            charge.split(51).is_none(),
            "an over-split must not change the charge"
        );
        assert_eq!(charge.bytes(), 50);

        drop(portion);
        drop(charge);
        assert_eq!(budget.available(), 100);
    }

    #[test]
    fn split_or_take_falls_back_to_the_whole_charge() {
        let budget = ByteBudget::new(100);
        let mut charge = budget.try_charge(30).expect("fits");
        let taken = charge.split_or_take(50);
        assert_eq!(
            taken.bytes(),
            30,
            "an oversized request takes everything remaining"
        );
        assert_eq!(charge.bytes(), 0);
        drop(taken);
        drop(charge);
        assert_eq!(budget.available(), 100);
    }

    #[tokio::test]
    async fn body_charge_and_reservation_share_one_ingress_pool() {
        let budget = ByteBudget::new(100);
        let body_charge = budget.charge(60).await;
        assert!(
            budget.try_charge(50).is_none(),
            "a reservation must see the body's pressure"
        );
        let reservation = budget.try_charge(40).expect("remaining capacity");
        assert_eq!(budget.available(), 0);
        drop(reservation);
        assert_eq!(
            budget.available(),
            40,
            "an untransferred reservation restores its exact permits"
        );
        drop(body_charge);
        assert_eq!(budget.available(), 100);
    }
}
