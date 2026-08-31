use std::fmt;

/// Maximum legal wire-v2 body size.
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
/// Minimum payload capacity for each logical direction.
pub const MIN_ARENA_BYTES: usize = MAX_FRAME_BYTES;

/// Failure while planning a FIFO arena reservation.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ArenaError {
    /// Arena cannot hold one legal maximum frame.
    BelowMinimumCapacity,
    /// Requested frame exceeds the wire limit.
    FrameTooLarge,
    /// Absolute cursors are malformed or wrapped.
    InvalidCursor,
    /// Current FIFO hold leaves insufficient contiguous logical capacity.
    Exhausted,
    /// Offset or length arithmetic overflowed.
    ArithmeticOverflow,
}

impl fmt::Debug for ArenaError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, formatter)
    }
}

impl fmt::Display for ArenaError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::BelowMinimumCapacity => "arena capacity is below the protocol minimum",
            Self::FrameTooLarge => "frame exceeds the protocol maximum",
            Self::InvalidCursor => "arena cursor is invalid",
            Self::Exhausted => "arena capacity is exhausted",
            Self::ArithmeticOverflow => "arena arithmetic overflow",
        })
    }
}

impl std::error::Error for ArenaError {}

/// One offset-and-length region within an arena.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub struct ArenaSpan {
    pub(crate) offset: u64,
    pub(crate) len: u64,
}

impl ArenaSpan {
    /// Constructs an untrusted span for later validation.
    pub const fn from_untrusted(offset: u64, len: u64) -> Self {
        Self { offset, len }
    }

    /// Offset from arena base.
    pub const fn offset(self) -> u64 {
        self.offset
    }

    /// Span byte length.
    pub const fn len(self) -> u64 {
        self.len
    }

    /// Whether span is empty.
    pub const fn is_empty(self) -> bool {
        self.len == 0
    }
}

impl fmt::Debug for ArenaSpan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ArenaSpan(<redacted>)")
    }
}

/// Checked at-most-two-span reservation plan.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct SpanPlan {
    allocation_start: u64,
    allocation_len: u64,
    spans: [ArenaSpan; 2],
    span_count: u8,
}

impl SpanPlan {
    /// Plans a FIFO reservation from monotonic write and reclaim cursors.
    pub fn reserve(
        capacity: usize,
        write: u64,
        reclaimed: u64,
        len: usize,
    ) -> Result<Self, ArenaError> {
        if capacity < MIN_ARENA_BYTES {
            return Err(ArenaError::BelowMinimumCapacity);
        }
        if len > MAX_FRAME_BYTES {
            return Err(ArenaError::FrameTooLarge);
        }
        let capacity = u64::try_from(capacity).map_err(|_| ArenaError::ArithmeticOverflow)?;
        let len = u64::try_from(len).map_err(|_| ArenaError::ArithmeticOverflow)?;
        let used = write
            .checked_sub(reclaimed)
            .ok_or(ArenaError::InvalidCursor)?;
        if used > capacity {
            return Err(ArenaError::InvalidCursor);
        }
        if len > capacity - used {
            return Err(ArenaError::Exhausted);
        }
        write
            .checked_add(len)
            .ok_or(ArenaError::ArithmeticOverflow)?;

        let offset = write % capacity;
        let first_len = len.min(capacity - offset);
        let second_len = len - first_len;
        Ok(Self {
            allocation_start: write,
            allocation_len: len,
            spans: [
                ArenaSpan::from_untrusted(offset, first_len),
                ArenaSpan::from_untrusted(0, second_len),
            ],
            span_count: if second_len == 0 { 1 } else { 2 },
        })
    }

    /// Returns same allocation shortened to exact committed body length.
    pub fn prefix(self, exact_len: usize) -> Result<Self, ArenaError> {
        let exact_len = u64::try_from(exact_len).map_err(|_| ArenaError::ArithmeticOverflow)?;
        if exact_len > self.allocation_len {
            return Err(ArenaError::FrameTooLarge);
        }
        let first_len = exact_len.min(self.spans[0].len);
        let second_len = exact_len - first_len;
        Ok(Self {
            allocation_start: self.allocation_start,
            allocation_len: self.allocation_len,
            spans: [
                ArenaSpan::from_untrusted(self.spans[0].offset, first_len),
                ArenaSpan::from_untrusted(0, second_len),
            ],
            span_count: if second_len == 0 { 1 } else { 2 },
        })
    }

    /// Absolute monotonic allocation start.
    pub const fn allocation_start(self) -> u64 {
        self.allocation_start
    }

    /// Reserved bytes, including any uncommitted tail.
    pub const fn allocation_len(self) -> u64 {
        self.allocation_len
    }

    /// Number of body spans.
    pub const fn span_count(self) -> u8 {
        self.span_count
    }

    /// Returns one body span.
    pub fn span(self, index: usize) -> Option<ArenaSpan> {
        (index < usize::from(self.span_count)).then_some(self.spans[index])
    }

    /// Returns fixed storage used by shared descriptors.
    pub(crate) const fn spans(self) -> [ArenaSpan; 2] {
        self.spans
    }
}

impl fmt::Debug for SpanPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SpanPlan(<redacted>)")
    }
}

/// Arena byte-state snapshot.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ArenaCounts {
    /// Uncharged bytes.
    pub free: u64,
    /// Bytes held by an unfinished producer.
    pub producer_reserved: u64,
    /// Published bytes not acquired by receiver.
    pub published: u64,
    /// Bytes undergoing receiver validation.
    pub receiver_held: u64,
    /// Bytes visible through receive leases.
    pub receiver_leased: u64,
    /// Released bytes awaiting FIFO reclamation.
    pub release_pending: u64,
    /// Contiguous-wrap padding.
    pub pad: u64,
    /// Bytes permanently withheld after uncertain cleanup.
    pub quarantined: u64,
}

impl ArenaCounts {
    /// Checks exact byte conservation against arena capacity.
    pub fn conserves(self, capacity: u64) -> bool {
        [
            self.free,
            self.producer_reserved,
            self.published,
            self.receiver_held,
            self.receiver_leased,
            self.release_pending,
            self.pad,
            self.quarantined,
        ]
        .into_iter()
        .try_fold(0u64, u64::checked_add)
            == Some(capacity)
    }
}
