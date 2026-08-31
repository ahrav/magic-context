use std::fmt;
use std::marker::PhantomData;
use std::ptr::NonNull;
use std::rc::Rc;

use crate::descriptor::ReleaseIdentity;

/// `LeaseSpan` provides a raw view of a span whose mapping remains readable for `'lease`.
#[derive(Clone, Copy)]
pub struct LeaseSpan<'lease> {
    base: NonNull<u8>,
    len: usize,
    _lifetime: PhantomData<&'lease [u8]>,
    _not_send: PhantomData<Rc<()>>,
}

impl<'lease> LeaseSpan<'lease> {
    ///
    /// # Safety
    /// `base..base.add(len)` must remain mapped and readable for `'lease`.
    pub(crate) unsafe fn new(base: *mut u8, len: usize) -> Result<Self, LeaseError> {
        let base = NonNull::new(base).ok_or(LeaseError::InvalidSpan)?;
        Ok(Self {
            base,
            len,
            _lifetime: PhantomData,
            _not_send: PhantomData,
        })
    }

    /// Span length.
    pub const fn len(self) -> usize {
        self.len
    }

    pub const fn as_mut_ptr(self) -> *mut u8 {
        self.base.as_ptr()
    }

    pub const fn is_empty(self) -> bool {
        self.len == 0
    }

    /// `read_byte` reads one byte through raw access to a peer-writable mapping.
    pub fn read_byte(self, index: usize) -> Option<u8> {
        if index >= self.len {
            return None;
        }
        // SAFETY: constructor bound covers len and index was checked.
        Some(unsafe { self.base.as_ptr().add(index).read_volatile() })
    }

    pub fn copy_to(self, destination: &mut [u8]) -> Result<(), LeaseError> {
        if destination.len() != self.len {
            return Err(LeaseError::LengthMismatch);
        }
        // SAFETY: `LeaseSpan::new` guarantees that the source range is readable.
        unsafe {
            std::ptr::copy_nonoverlapping(self.base.as_ptr(), destination.as_mut_ptr(), self.len)
        };
        Ok(())
    }

    pub fn checksum(self) -> u64 {
        // SAFETY: `LeaseSpan::new` guarantees that the slice range is readable for the lease.
        let bytes = unsafe { std::slice::from_raw_parts(self.base.as_ptr(), self.len) };
        bytes
            .iter()
            .fold(0u64, |sum, byte| sum.wrapping_add(u64::from(*byte)))
    }
}

impl fmt::Debug for LeaseSpan<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("LeaseSpan(<redacted>)")
    }
}

pub(crate) type ReleaseFn = unsafe fn(*const (), ReleaseIdentity) -> Result<(), LeaseError>;

///
/// Raw span access avoids long-lived safe references to mappings a trusted peer can address.
/// `Rc` marker makes `ReceiveLease` `!Send`.
pub struct ReceiveLease<'lease> {
    spans: [Option<LeaseSpan<'lease>>; 2],
    span_count: u8,
    body_len: usize,
    wire_header: [u8; crate::descriptor::WIRE_V2_HEADER_BYTES],
    identity: ReleaseIdentity,
    release_context: *const (),
    release_fn: ReleaseFn,
    released: bool,
    _owner: PhantomData<&'lease ()>,
    _not_send: PhantomData<Rc<()>>,
}

impl<'lease> ReceiveLease<'lease> {
    ///
    /// # Safety
    /// Spans and release context must remain valid for `'lease`.
    /// callback must accept this identity exactly once.
    pub(crate) unsafe fn new(
        spans: [Option<LeaseSpan<'lease>>; 2],
        span_count: u8,
        body_len: usize,
        wire_header: [u8; crate::descriptor::WIRE_V2_HEADER_BYTES],
        identity: ReleaseIdentity,
        release_context: *const (),
        release_fn: ReleaseFn,
    ) -> Result<Self, LeaseError> {
        if !(1..=2).contains(&span_count)
            || spans[0].is_none()
            || (span_count == 1 && spans[1].is_some())
            || (span_count == 2 && spans[1].is_none())
        {
            return Err(LeaseError::InvalidSpan);
        }
        Ok(Self {
            spans,
            span_count,
            body_len,
            wire_header,
            identity,
            release_context,
            release_fn,
            released: false,
            _owner: PhantomData,
            _not_send: PhantomData,
        })
    }

    pub const fn len(&self) -> usize {
        self.body_len
    }

    pub const fn is_empty(&self) -> bool {
        self.body_len == 0
    }

    pub const fn segment_count(&self) -> usize {
        self.span_count as usize
    }

    pub fn segment(&self, index: usize) -> Option<LeaseSpan<'_>> {
        if index >= usize::from(self.span_count) {
            return None;
        }
        self.spans[index]
    }

    /// Wire-v2 header.
    pub const fn wire_header(&self) -> [u8; crate::descriptor::WIRE_V2_HEADER_BYTES] {
        self.wire_header
    }

    pub const fn identity(&self) -> ReleaseIdentity {
        self.identity
    }

    pub fn release(mut self) -> Result<(), LeaseError> {
        self.release_once()
    }

    pub fn to_vec(&self) -> Result<Vec<u8>, LeaseError> {
        let mut bytes = vec![0u8; self.body_len];
        let mut cursor = 0usize;
        for index in 0..usize::from(self.span_count) {
            let span = self.spans[index].ok_or(LeaseError::InvalidSpan)?;
            let end = cursor
                .checked_add(span.len())
                .ok_or(LeaseError::LengthMismatch)?;
            let destination = bytes
                .get_mut(cursor..end)
                .ok_or(LeaseError::LengthMismatch)?;
            span.copy_to(destination)?;
            cursor = end;
        }
        if cursor != self.body_len {
            return Err(LeaseError::LengthMismatch);
        }
        Ok(bytes)
    }

    fn release_once(&mut self) -> Result<(), LeaseError> {
        if self.released {
            return Err(LeaseError::DuplicateRelease);
        }
        // SAFETY: constructor requires a live callback context for lease lifetime.
        unsafe { (self.release_fn)(self.release_context, self.identity)? };
        self.released = true;
        Ok(())
    }
}

impl fmt::Debug for ReceiveLease<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ReceiveLease(<redacted>)")
    }
}

impl Drop for ReceiveLease<'_> {
    fn drop(&mut self) {
        if !self.released {
            let _ = self.release_once();
        }
    }
}

/// `LeaseError` reports receive-span or completion failures.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum LeaseError {
    /// `LeaseError` reports an invalid span pointer or count.
    InvalidSpan,
    LengthMismatch,
    WrongIncarnation,
    WrongLane,
    InvalidSequence,
    DuplicateRelease,
    Quarantined,
}

impl fmt::Debug for LeaseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, formatter)
    }
}

impl fmt::Display for LeaseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidSpan => "receive span is invalid",
            Self::LengthMismatch => "receive span lengths disagree",
            Self::WrongIncarnation => "release identity does not match incarnation",
            Self::WrongLane => "release identity does not match lane",
            Self::InvalidSequence => "release sequence is invalid",
            Self::DuplicateRelease => "release is duplicated",
            Self::Quarantined => "transport storage is quarantined",
        })
    }
}

impl std::error::Error for LeaseError {}
