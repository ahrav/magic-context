//! The connection engine and its transports share frame encoding, protocol
//! size caps, and aggregate resident-byte accounting.

use std::sync::Arc;

use subc_protocol::{EnvelopeHeader, Flags, FrameType, Priority, HEADER_LEN, MAX_FRAME_BODY_LEN};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

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

    #[cfg(test)]
    pub fn available(&self) -> usize {
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
        ver: subc_protocol::PROTOCOL_VERSION,
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
        ver: subc_protocol::PROTOCOL_VERSION,
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
        ver: subc_protocol::PROTOCOL_VERSION,
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
