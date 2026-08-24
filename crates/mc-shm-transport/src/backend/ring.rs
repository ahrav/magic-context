use std::cell::UnsafeCell;
use std::ffi::CString;
use std::fmt;
use std::fs::File;
use std::marker::PhantomData;
use std::mem::size_of;
#[cfg(target_os = "linux")]
use std::os::fd::RawFd;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::ptr::NonNull;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::time::{Duration, Instant};

use crate::arena::{prefault, ArenaCounts, ArenaError, ArenaSpan, SpanPlan, MAX_FRAME_BYTES};
use crate::descriptor::{
    BackendId, DescriptorCounts, DescriptorError, FrameDescriptor, Incarnation, MemoryLayout,
    ReleaseIdentity, SchedulingMode, DESCRIPTOR_SCHEMA_VERSION, WIRE_V2_HEADER_BYTES,
};
use crate::lease::{LeaseError, LeaseSpan, ReceiveLease};
use crate::profile::TargetProfile;

const MAPPING_MAGIC: u64 = 0x4d43_5348_4d52_3031;
const LAYOUT_VERSION: u16 = 1;
const CACHELINE: usize = 128;
const PAGE_SIZE: usize = 4096;
const GRANT_BYTES: usize = 58;

const SLOT_FREE: u8 = 0;
const SLOT_PRODUCER_RESERVED: u8 = 1;
const SLOT_PUBLISHED: u8 = 2;
const SLOT_RECEIVER_HELD: u8 = 3;
const SLOT_RECEIVER_LEASED: u8 = 4;
const SLOT_RELEASE_PENDING: u8 = 5;

#[repr(C, align(128))]
struct ProducerPage {
    published: AtomicU64,
    arena_write: AtomicU64,
}

#[repr(C, align(128))]
struct ConsumerPage {
    consumed: AtomicU64,
    completed: AtomicU64,
    arena_reclaimed: AtomicU64,
    active_leases: AtomicU64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct SharedDescriptor {
    schema_version: u16,
    wire_header: [u8; WIRE_V2_HEADER_BYTES],
    incarnation: [u8; 16],
    lane: u32,
    sequence: u64,
    body_len: u64,
    allocation_start: u64,
    allocation_len: u64,
    span_count: u8,
    span_offsets: [u64; 2],
    span_lengths: [u64; 2],
}

impl SharedDescriptor {
    const ZERO: Self = Self {
        schema_version: 0,
        wire_header: [0; WIRE_V2_HEADER_BYTES],
        incarnation: [0; 16],
        lane: 0,
        sequence: 0,
        body_len: 0,
        allocation_start: 0,
        allocation_len: 0,
        span_count: 0,
        span_offsets: [0; 2],
        span_lengths: [0; 2],
    };

    fn snapshot(self) -> FrameDescriptor {
        FrameDescriptor::from_untrusted(
            self.schema_version,
            self.wire_header,
            ReleaseIdentity::new(
                Incarnation::from_bytes(self.incarnation),
                self.lane,
                self.sequence,
            ),
            self.body_len,
            self.allocation_start,
            self.allocation_len,
            self.span_count,
            [
                ArenaSpan::from_untrusted(self.span_offsets[0], self.span_lengths[0]),
                ArenaSpan::from_untrusted(self.span_offsets[1], self.span_lengths[1]),
            ],
        )
    }
}

#[repr(C, align(128))]
struct DescriptorSlot {
    state: AtomicU8,
    completion_sequence: AtomicU64,
    reservation_len: AtomicU64,
    descriptor: UnsafeCell<SharedDescriptor>,
}

#[repr(C, align(128))]
struct LifecyclePage {
    magic: u64,
    layout_version: u16,
    descriptor_depth: u64,
    arena_bytes: u64,
    max_leases: u64,
    total_bytes: u64,
    incarnation: [u8; 16],
    lane: u32,
    quarantined: AtomicU8,
}

#[derive(Clone, Copy)]
struct Layout {
    producer: usize,
    consumer: usize,
    slots: usize,
    arena: usize,
    lifecycle: usize,
    total: usize,
}

impl Layout {
    fn new(depth: usize, arena_bytes: usize) -> Result<Self, RingError> {
        let producer = 0usize;
        let consumer = align_up(size_of::<ProducerPage>(), CACHELINE)?;
        let slots = align_up(
            consumer
                .checked_add(size_of::<ConsumerPage>())
                .ok_or(RingError::ArithmeticOverflow)?,
            CACHELINE,
        )?;
        let slot_bytes = size_of::<DescriptorSlot>()
            .checked_mul(depth)
            .ok_or(RingError::ArithmeticOverflow)?;
        let arena = align_up(
            slots
                .checked_add(slot_bytes)
                .ok_or(RingError::ArithmeticOverflow)?,
            PAGE_SIZE,
        )?;
        let lifecycle = align_up(
            arena
                .checked_add(arena_bytes)
                .ok_or(RingError::ArithmeticOverflow)?,
            PAGE_SIZE,
        )?;
        let total = lifecycle
            .checked_add(PAGE_SIZE)
            .ok_or(RingError::ArithmeticOverflow)?;
        Ok(Self {
            producer,
            consumer,
            slots,
            arena,
            lifecycle,
            total,
        })
    }
}

fn align_up(value: usize, alignment: usize) -> Result<usize, RingError> {
    let mask = alignment - 1;
    value
        .checked_add(mask)
        .map(|sum| sum & !mask)
        .ok_or(RingError::ArithmeticOverflow)
}

struct Mapping {
    #[cfg(target_os = "linux")]
    fd: OwnedFd,
    base: NonNull<u8>,
    len: usize,
}

impl Mapping {
    fn create(len: usize) -> Result<Self, RingError> {
        #[cfg(target_os = "linux")]
        let fd = create_linux_memfd(len)?;
        #[cfg(target_os = "macos")]
        let fd = create_macos_shm(len)?;

        validate_object(&fd, len)?;
        let raw = fd.as_raw_fd();
        // SAFETY: fd has exact nonzero length, flags request shared read/write mapping.
        let mapped = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                raw,
                0,
            )
        };
        if mapped == libc::MAP_FAILED {
            return Err(RingError::ObjectSetupFailed);
        }
        let base = NonNull::new(mapped.cast()).ok_or(RingError::ObjectSetupFailed)?;
        #[cfg(target_os = "macos")]
        drop(fd);
        Ok(Self {
            #[cfg(target_os = "linux")]
            fd,
            base,
            len,
        })
    }

    fn attach(fd: OwnedFd, len: usize) -> Result<Self, RingError> {
        validate_object(&fd, len)?;
        // SAFETY: authenticated fd was size-validated before mapping.
        let mapped = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                fd.as_raw_fd(),
                0,
            )
        };
        if mapped == libc::MAP_FAILED {
            return Err(RingError::ObjectSetupFailed);
        }
        let base = NonNull::new(mapped.cast()).ok_or(RingError::ObjectSetupFailed)?;
        #[cfg(target_os = "macos")]
        drop(fd);
        Ok(Self {
            #[cfg(target_os = "linux")]
            fd,
            base,
            len,
        })
    }

    #[cfg(target_os = "linux")]
    const fn fd(&self) -> &OwnedFd {
        &self.fd
    }

    fn ptr_at<T>(&self, offset: usize) -> Result<*mut T, RingError> {
        let end = offset
            .checked_add(size_of::<T>())
            .ok_or(RingError::ArithmeticOverflow)?;
        if end > self.len {
            return Err(RingError::InvalidLayout);
        }
        // SAFETY: checked offset remains inside mapping.
        Ok(unsafe { self.base.as_ptr().add(offset).cast() })
    }
}

impl fmt::Debug for Mapping {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Mapping(<redacted>)")
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        // SAFETY: base and len came from successful mmap and are unmapped once here.
        unsafe { libc::munmap(self.base.as_ptr().cast(), self.len) };
    }
}

/// Fd-validated owner-only setup directory.
pub struct RuntimeDir {
    path: PathBuf,
    fd: File,
}

impl RuntimeDir {
    /// Creates fresh 0700 runtime directory below given root.
    pub fn create_in(root: &Path) -> Result<Self, RingError> {
        let mut random = [0u8; 16];
        getrandom::getrandom(&mut random).map_err(|_| RingError::ObjectSetupFailed)?;
        let suffix = random
            .iter()
            .fold(String::with_capacity(32), |mut text, byte| {
                use std::fmt::Write;
                let _ = write!(text, "{byte:02x}");
                text
            });
        let path = root.join(format!("mc-shm-{suffix}"));
        let c_path =
            CString::new(path.as_os_str().as_bytes()).map_err(|_| RingError::ObjectSetupFailed)?;
        // SAFETY: path is valid NUL-terminated string and mode is owner-only at creation.
        if unsafe { libc::mkdir(c_path.as_ptr(), 0o700) } != 0 {
            return Err(RingError::ObjectSetupFailed);
        }
        let opened = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&path)
            .map_err(|_| RingError::ObjectSetupFailed);
        let fd = match opened {
            Ok(fd) => fd,
            Err(error) => {
                let _ = std::fs::remove_dir(&path);
                return Err(error);
            }
        };
        let by_path = std::fs::symlink_metadata(&path).map_err(|_| RingError::ObjectSetupFailed)?;
        let by_fd = fd.metadata().map_err(|_| RingError::ObjectSetupFailed)?;
        // SAFETY: geteuid has no preconditions.
        let current_uid = unsafe { libc::geteuid() };
        if !by_path.is_dir()
            || !by_fd.is_dir()
            || by_path.ino() != by_fd.ino()
            || by_fd.uid() != current_uid
            || by_fd.permissions().mode() & 0o777 != 0o700
        {
            let _ = std::fs::remove_dir(&path);
            return Err(RingError::ObjectValidationFailed);
        }
        Ok(Self { path, fd })
    }

    /// Revalidates owner, inode, type, and permissions through open descriptor.
    pub fn validate(&self) -> Result<(), RingError> {
        let by_path =
            std::fs::symlink_metadata(&self.path).map_err(|_| RingError::ObjectValidationFailed)?;
        let by_fd = self
            .fd
            .metadata()
            .map_err(|_| RingError::ObjectValidationFailed)?;
        // SAFETY: geteuid has no preconditions.
        let current_uid = unsafe { libc::geteuid() };
        if by_path.is_dir()
            && by_fd.is_dir()
            && by_path.ino() == by_fd.ino()
            && by_fd.uid() == current_uid
            && by_fd.permissions().mode() & 0o777 == 0o700
        {
            Ok(())
        } else {
            Err(RingError::ObjectValidationFailed)
        }
    }
}

impl fmt::Debug for RuntimeDir {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RuntimeDir(<redacted>)")
    }
}

impl Drop for RuntimeDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.path);
    }
}

/// Authenticated fixed-layout attachment grant.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct RingGrant {
    layout_version: u16,
    incarnation: Incarnation,
    lane: u32,
    descriptor_depth: u64,
    arena_bytes: u64,
    max_leases: u64,
    total_bytes: u64,
}

impl RingGrant {
    /// Encodes grant for authenticated bootstrap transport.
    pub fn encode(self) -> [u8; GRANT_BYTES] {
        let mut bytes = [0u8; GRANT_BYTES];
        bytes[0..2].copy_from_slice(&self.layout_version.to_le_bytes());
        bytes[2..18].copy_from_slice(&self.incarnation.into_bytes());
        bytes[18..22].copy_from_slice(&self.lane.to_le_bytes());
        bytes[22..30].copy_from_slice(&self.descriptor_depth.to_le_bytes());
        bytes[30..38].copy_from_slice(&self.arena_bytes.to_le_bytes());
        bytes[38..46].copy_from_slice(&self.max_leases.to_le_bytes());
        bytes[46..54].copy_from_slice(&self.total_bytes.to_le_bytes());
        bytes[54..58].copy_from_slice(&0u32.to_le_bytes());
        bytes
    }

    /// Decodes grant received through authenticated bootstrap transport.
    pub fn decode(bytes: [u8; GRANT_BYTES]) -> Result<Self, RingError> {
        if bytes[54..58] != [0; 4] {
            return Err(RingError::InvalidGrant);
        }
        let array = |range: std::ops::Range<usize>| -> [u8; 8] {
            bytes[range]
                .try_into()
                .expect("grant ranges have fixed eight-byte width")
        };
        Ok(Self {
            layout_version: u16::from_le_bytes([bytes[0], bytes[1]]),
            incarnation: Incarnation::from_bytes(
                bytes[2..18]
                    .try_into()
                    .expect("grant incarnation has fixed width"),
            ),
            lane: u32::from_le_bytes(
                bytes[18..22]
                    .try_into()
                    .expect("grant lane has fixed width"),
            ),
            descriptor_depth: u64::from_le_bytes(array(22..30)),
            arena_bytes: u64::from_le_bytes(array(30..38)),
            max_leases: u64::from_le_bytes(array(38..46)),
            total_bytes: u64::from_le_bytes(array(46..54)),
        })
    }

    /// Fixed encoded grant length.
    pub const fn encoded_len() -> usize {
        GRANT_BYTES
    }
}

impl fmt::Debug for RingGrant {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RingGrant(<redacted>)")
    }
}

/// Cacheline-isolated SPSC descriptor ring with FIFO payload arena.
pub struct Ring {
    mapping: Mapping,
    layout: Layout,
    grant: RingGrant,
    scheduling: SchedulingMode,
    owned_runtime_dir: Option<RuntimeDir>,
    _not_send_or_sync: PhantomData<Rc<()>>,
}

impl Ring {
    /// Creates sealed, prefaulted active ring under fresh owner-only runtime directory.
    pub fn create(profile: &TargetProfile, lane: u32) -> Result<Self, RingError> {
        let runtime = RuntimeDir::create_in(&std::env::temp_dir())?;
        let mut ring = Self::create_in(profile, lane, &runtime)?;
        ring.owned_runtime_dir = Some(runtime);
        Ok(ring)
    }

    /// Creates ring using already validated candidate runtime directory.
    pub fn create_in(
        profile: &TargetProfile,
        lane: u32,
        runtime: &RuntimeDir,
    ) -> Result<Self, RingError> {
        runtime.validate()?;
        if profile.descriptor().backend() != BackendId::Ring
            || profile.descriptor().memory_layout() != MemoryLayout::TwoSpanWrap
        {
            return Err(RingError::ProfileMismatch);
        }
        let layout = Layout::new(profile.descriptor_depth(), profile.arena_bytes())?;
        let incarnation = Incarnation::random().map_err(RingError::Descriptor)?;
        let grant = RingGrant {
            layout_version: LAYOUT_VERSION,
            incarnation,
            lane,
            descriptor_depth: profile.descriptor_depth() as u64,
            arena_bytes: profile.arena_bytes() as u64,
            max_leases: profile.max_leases() as u64,
            total_bytes: layout.total as u64,
        };
        let mapping = Mapping::create(layout.total)?;
        // SAFETY: fresh writable mapping covers layout.total bytes.
        unsafe { prefault(mapping.base.as_ptr(), mapping.len) };
        initialize_mapping(&mapping, layout, grant)?;
        #[cfg(target_os = "linux")]
        {
            seal_object(mapping.fd())?;
            validate_object(mapping.fd(), mapping.len)?;
        }
        let ring = Self {
            mapping,
            layout,
            grant,
            scheduling: profile.descriptor().scheduling(),
            owned_runtime_dir: None,
            _not_send_or_sync: PhantomData,
        };
        if !ring.verify_prefaulted()? {
            return Err(RingError::PrefaultFailed);
        }
        Ok(ring)
    }

    /// Attaches exact authenticated grant to inherited or transferred descriptor.
    pub fn attach(
        fd: OwnedFd,
        grant: RingGrant,
        scheduling: SchedulingMode,
    ) -> Result<Self, RingError> {
        if grant.layout_version != LAYOUT_VERSION
            || grant.descriptor_depth == 0
            || grant.arena_bytes < MAX_FRAME_BYTES as u64
            || grant.max_leases == 0
            || grant.max_leases > grant.descriptor_depth
        {
            return Err(RingError::InvalidGrant);
        }
        let depth = usize::try_from(grant.descriptor_depth).map_err(|_| RingError::InvalidGrant)?;
        let arena = usize::try_from(grant.arena_bytes).map_err(|_| RingError::InvalidGrant)?;
        let total = usize::try_from(grant.total_bytes).map_err(|_| RingError::InvalidGrant)?;
        let layout = Layout::new(depth, arena)?;
        if layout.total != total {
            return Err(RingError::InvalidGrant);
        }
        let mapping = Mapping::attach(fd, total)?;
        validate_lifecycle(&mapping, layout, grant)?;
        prefault_read(&mapping);
        Ok(Self {
            mapping,
            layout,
            grant,
            scheduling,
            owned_runtime_dir: None,
            _not_send_or_sync: PhantomData,
        })
    }

    /// Attachment grant for authenticated bootstrap.
    pub const fn grant(&self) -> RingGrant {
        self.grant
    }

    /// Shared object descriptor for authenticated transfer.
    #[cfg(target_os = "linux")]
    pub fn raw_fd(&self) -> RawFd {
        self.mapping.fd.as_raw_fd()
    }

    /// Controls close-on-exec for child re-exec tests and handle transfer.
    #[cfg(target_os = "linux")]
    pub fn set_inheritable(&self, inheritable: bool) -> Result<(), RingError> {
        // SAFETY: F_GETFD reads flags from owned valid fd.
        let current = unsafe { libc::fcntl(self.raw_fd(), libc::F_GETFD) };
        if current < 0 {
            return Err(RingError::ObjectValidationFailed);
        }
        let flags = if inheritable {
            current & !libc::FD_CLOEXEC
        } else {
            current | libc::FD_CLOEXEC
        };
        // SAFETY: F_SETFD updates flags on owned valid fd.
        if unsafe { libc::fcntl(self.raw_fd(), libc::F_SETFD, flags) } < 0 {
            return Err(RingError::ObjectValidationFailed);
        }
        Ok(())
    }

    /// Attempts immediate descriptor and arena reservation.
    pub fn try_reserve(
        &self,
        bound: usize,
        wire_header: [u8; WIRE_V2_HEADER_BYTES],
    ) -> Result<ProducerReservation<'_>, ProducerError> {
        if bound > MAX_FRAME_BYTES {
            return Err(ProducerError::BoundExceedsSpans);
        }
        if self.is_quarantined() {
            return Err(ProducerError::Quarantined);
        }
        self.reclaim_completed().map_err(ProducerError::Ring)?;
        let producer = self.producer_ptr().map_err(ProducerError::Ring)?;
        let consumer = self.consumer_ptr().map_err(ProducerError::Ring)?;
        // SAFETY: producer and consumer pages were initialized before activation.
        let published = unsafe { (*producer).published.load(Ordering::Relaxed) };
        // SAFETY: same as above.
        let completed = unsafe { (*consumer).completed.load(Ordering::Acquire) };
        let outstanding = published
            .checked_sub(completed)
            .ok_or(ProducerError::Ring(RingError::InvalidSharedState))?;
        if outstanding >= self.grant.descriptor_depth {
            return Err(ProducerError::Exhausted);
        }
        let sequence = published
            .checked_add(1)
            .ok_or(ProducerError::SequenceExhausted)?;
        let slot = self.slot_ptr(sequence).map_err(ProducerError::Ring)?;
        // SAFETY: slot points to initialized atomics in mapping.
        unsafe {
            (*slot)
                .state
                .compare_exchange(
                    SLOT_FREE,
                    SLOT_PRODUCER_RESERVED,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .map_err(|_| ProducerError::Exhausted)?;
        }
        // SAFETY: pages remain mapped for self lifetime.
        let write = unsafe { (*producer).arena_write.load(Ordering::Relaxed) };
        // SAFETY: pages remain mapped for self lifetime.
        let reclaimed = unsafe { (*consumer).arena_reclaimed.load(Ordering::Acquire) };
        let plan = match SpanPlan::reserve(self.arena_bytes(), write, reclaimed, bound) {
            Ok(plan) => plan,
            Err(ArenaError::Exhausted) => {
                // SAFETY: producer owns reserved slot and no descriptor was published.
                unsafe { (*slot).state.store(SLOT_FREE, Ordering::Release) };
                return Err(ProducerError::Exhausted);
            }
            Err(error) => {
                // SAFETY: same rollback as exhaustion.
                unsafe { (*slot).state.store(SLOT_FREE, Ordering::Release) };
                return Err(ProducerError::Arena(error));
            }
        };
        // SAFETY: reserved slot is producer-owned until commit or drop.
        unsafe {
            (*slot)
                .reservation_len
                .store(plan.allocation_len(), Ordering::Relaxed)
        };
        Ok(ProducerReservation {
            ring: self,
            plan,
            sequence,
            cursor: 0,
            wire_header,
            finished: false,
            _not_send: PhantomData,
        })
    }

    /// Applies profile scheduling until capacity or deadline.
    pub fn reserve_until(
        &self,
        bound: usize,
        wire_header: [u8; WIRE_V2_HEADER_BYTES],
        deadline: Instant,
    ) -> Result<ProducerReservation<'_>, ProducerError> {
        loop {
            match self.try_reserve(bound, wire_header) {
                Err(ProducerError::Exhausted) if Instant::now() < deadline => {
                    match self.scheduling {
                        SchedulingMode::HotPinnedPoll => std::hint::spin_loop(),
                        SchedulingMode::ColdParkWake => {
                            std::thread::sleep(Duration::from_micros(50));
                        }
                    }
                }
                Err(ProducerError::Exhausted) => return Err(ProducerError::Deadline),
                result => return result,
            }
        }
    }

    /// Acquires next complete frame after release/acquire publication.
    pub fn try_receive(&self) -> Result<Option<ReceiveLease<'_>>, RingError> {
        if self.is_quarantined() {
            return Err(RingError::Quarantined);
        }
        let producer = self.producer_ptr()?;
        let consumer = self.consumer_ptr()?;
        // SAFETY: consumer page remains mapped.
        let active = unsafe { (*consumer).active_leases.load(Ordering::Relaxed) };
        if active >= self.grant.max_leases {
            return Err(RingError::LeaseLimit);
        }
        // SAFETY: consumer owns consumed cursor.
        let consumed = unsafe { (*consumer).consumed.load(Ordering::Relaxed) };
        // SAFETY: acquire pairs with producer publication.
        let published = unsafe { (*producer).published.load(Ordering::Acquire) };
        if consumed == published {
            return Ok(None);
        }
        let sequence = consumed
            .checked_add(1)
            .ok_or(RingError::SequenceExhausted)?;
        let slot = self.slot_ptr(sequence)?;
        // SAFETY: consumer alone transitions published slot to held.
        unsafe {
            (*slot)
                .state
                .compare_exchange(
                    SLOT_PUBLISHED,
                    SLOT_RECEIVER_HELD,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .map_err(|_| RingError::InvalidSharedState)?;
        }
        // SAFETY: acquire publication made descriptor visible; one read snapshots all fields.
        let shared = unsafe { std::ptr::read_volatile((*slot).descriptor.get()) };
        let expected = ReleaseIdentity::new(self.grant.incarnation, self.grant.lane, sequence);
        let validated = match shared.snapshot().validate(expected, self.arena_bytes()) {
            Ok(validated) => validated,
            Err(error) => {
                self.enter_quarantine();
                return Err(RingError::Descriptor(error));
            }
        };
        // SAFETY: validated span offsets and lengths fit arena and usize on this mapping.
        let first =
            unsafe { self.lease_span(validated.span(0).ok_or(RingError::InvalidSharedState)?)? };
        let second = if validated.span_count() == 2 {
            // SAFETY: validated second span exists and fits mapping.
            Some(unsafe {
                self.lease_span(validated.span(1).ok_or(RingError::InvalidSharedState)?)?
            })
        } else {
            None
        };
        // SAFETY: consumer owns state and cursor; descriptor stays immutable until release.
        unsafe {
            (*slot).state.store(SLOT_RECEIVER_LEASED, Ordering::Release);
            (*consumer).consumed.store(sequence, Ordering::Release);
            (*consumer).active_leases.fetch_add(1, Ordering::Relaxed);
        }
        let body_len =
            usize::try_from(validated.body_len()).map_err(|_| RingError::InvalidLayout)?;
        // SAFETY: lease borrows self, spans stay mapped, callback context cannot outlive self.
        let lease = unsafe {
            ReceiveLease::new(
                [Some(first), second],
                validated.span_count(),
                body_len,
                validated.identity(),
                (self as *const Self).cast(),
                ring_release_callback,
            )
        }
        .map_err(RingError::Lease)?;
        Ok(Some(lease))
    }

    /// Validates and records one explicit completion.
    pub fn release(&self, identity: ReleaseIdentity) -> Result<(), LeaseError> {
        if self.is_quarantined() {
            return Err(LeaseError::Quarantined);
        }
        if identity.incarnation() != self.grant.incarnation {
            return Err(LeaseError::WrongIncarnation);
        }
        if identity.lane() != self.grant.lane {
            return Err(LeaseError::WrongLane);
        }
        let sequence = identity.sequence();
        if sequence == 0 {
            return Err(LeaseError::InvalidSequence);
        }
        let consumer = self
            .consumer_ptr()
            .map_err(|_| LeaseError::InvalidSequence)?;
        // SAFETY: consumer page remains mapped.
        let consumed = unsafe { (*consumer).consumed.load(Ordering::Acquire) };
        if sequence > consumed {
            return Err(LeaseError::InvalidSequence);
        }
        let slot = self
            .slot_ptr(sequence)
            .map_err(|_| LeaseError::InvalidSequence)?;
        // SAFETY: descriptor remains immutable until release.
        let descriptor = unsafe { std::ptr::read_volatile((*slot).descriptor.get()) };
        if descriptor.incarnation != identity.incarnation().into_bytes() {
            return Err(LeaseError::WrongIncarnation);
        }
        if descriptor.lane != identity.lane() {
            return Err(LeaseError::WrongLane);
        }
        if descriptor.sequence != sequence {
            return Err(LeaseError::InvalidSequence);
        }
        // SAFETY: release transitions only exact live lease.
        let changed = unsafe {
            (*slot).state.compare_exchange(
                SLOT_RECEIVER_LEASED,
                SLOT_RELEASE_PENDING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
        };
        if let Err(observed) = changed {
            return Err(
                if observed == SLOT_RELEASE_PENDING || observed == SLOT_FREE {
                    LeaseError::DuplicateRelease
                } else {
                    LeaseError::InvalidSequence
                },
            );
        }
        // SAFETY: release publishes completion after all receiver reads.
        unsafe {
            (*slot)
                .completion_sequence
                .store(sequence, Ordering::Release);
            (*consumer).active_leases.fetch_sub(1, Ordering::Relaxed);
        }
        Ok(())
    }

    /// Returns descriptor and byte conservation snapshot.
    pub fn conservation(&self) -> Result<(DescriptorCounts, ArenaCounts), RingError> {
        if self.is_quarantined() {
            return Ok((
                DescriptorCounts {
                    quarantined: self.grant.descriptor_depth,
                    ..DescriptorCounts::default()
                },
                ArenaCounts {
                    quarantined: self.grant.arena_bytes,
                    ..ArenaCounts::default()
                },
            ));
        }
        let mut descriptors = DescriptorCounts::default();
        let mut bytes = ArenaCounts::default();
        let mut charged = 0u64;
        for index in 0..self.grant.descriptor_depth {
            let slot = self.slot_ptr(index + 1)?;
            // SAFETY: slot atomics remain mapped.
            let state = unsafe { (*slot).state.load(Ordering::Acquire) };
            // SAFETY: reservation length is atomic and assigned before non-free state is observed.
            let len = unsafe { (*slot).reservation_len.load(Ordering::Relaxed) };
            match state {
                SLOT_FREE => descriptors.free += 1,
                SLOT_PRODUCER_RESERVED => {
                    descriptors.producer_reserved += 1;
                    bytes.producer_reserved = bytes
                        .producer_reserved
                        .checked_add(len)
                        .ok_or(RingError::ArithmeticOverflow)?;
                    charged = charged
                        .checked_add(len)
                        .ok_or(RingError::ArithmeticOverflow)?;
                }
                SLOT_PUBLISHED => {
                    descriptors.published += 1;
                    bytes.published = bytes
                        .published
                        .checked_add(len)
                        .ok_or(RingError::ArithmeticOverflow)?;
                    charged = charged
                        .checked_add(len)
                        .ok_or(RingError::ArithmeticOverflow)?;
                }
                SLOT_RECEIVER_HELD => {
                    descriptors.receiver_held += 1;
                    bytes.receiver_held = bytes
                        .receiver_held
                        .checked_add(len)
                        .ok_or(RingError::ArithmeticOverflow)?;
                    charged = charged
                        .checked_add(len)
                        .ok_or(RingError::ArithmeticOverflow)?;
                }
                SLOT_RECEIVER_LEASED => {
                    descriptors.receiver_leased += 1;
                    bytes.receiver_leased = bytes
                        .receiver_leased
                        .checked_add(len)
                        .ok_or(RingError::ArithmeticOverflow)?;
                    charged = charged
                        .checked_add(len)
                        .ok_or(RingError::ArithmeticOverflow)?;
                }
                SLOT_RELEASE_PENDING => {
                    descriptors.release_pending += 1;
                    bytes.release_pending = bytes
                        .release_pending
                        .checked_add(len)
                        .ok_or(RingError::ArithmeticOverflow)?;
                    charged = charged
                        .checked_add(len)
                        .ok_or(RingError::ArithmeticOverflow)?;
                }
                _ => return Err(RingError::InvalidSharedState),
            }
        }
        bytes.free = self
            .grant
            .arena_bytes
            .checked_sub(charged)
            .ok_or(RingError::InvalidSharedState)?;
        Ok((descriptors, bytes))
    }

    /// Verifies all pages are resident after setup prefault.
    pub fn verify_prefaulted(&self) -> Result<bool, RingError> {
        let pages = self.mapping.len.div_ceil(PAGE_SIZE);
        let mut residency = vec![0u8; pages];
        // SAFETY: mincore receives exact live mapping and output vector.
        let result = unsafe {
            libc::mincore(
                self.mapping.base.as_ptr().cast(),
                self.mapping.len,
                residency.as_mut_ptr().cast(),
            )
        };
        if result != 0 {
            return Err(RingError::PrefaultFailed);
        }
        Ok(residency.into_iter().all(|entry| entry & 1 == 1))
    }

    /// Number of mappings held by this direction.
    pub const fn mapping_count(&self) -> usize {
        1
    }

    /// Fixed object size.
    pub const fn object_size(&self) -> usize {
        self.mapping.len
    }

    /// Permanently prevents reuse after uncertain cleanup.
    pub fn enter_quarantine(&self) {
        if let Ok(page) = self.lifecycle_ptr() {
            // SAFETY: lifecycle page remains mapped and flag is atomic.
            unsafe { (*page).quarantined.store(1, Ordering::Release) };
        }
    }

    /// Whether lifecycle is terminally quarantined.
    pub fn is_quarantined(&self) -> bool {
        self.lifecycle_ptr()
            .map(|page| {
                // SAFETY: lifecycle page remains mapped and flag is atomic.
                unsafe { (*page).quarantined.load(Ordering::Acquire) != 0 }
            })
            .unwrap_or(true)
    }

    fn arena_bytes(&self) -> usize {
        self.grant.arena_bytes as usize
    }

    fn producer_ptr(&self) -> Result<*mut ProducerPage, RingError> {
        self.mapping.ptr_at(self.layout.producer)
    }

    fn consumer_ptr(&self) -> Result<*mut ConsumerPage, RingError> {
        self.mapping.ptr_at(self.layout.consumer)
    }

    fn lifecycle_ptr(&self) -> Result<*mut LifecyclePage, RingError> {
        self.mapping.ptr_at(self.layout.lifecycle)
    }

    fn slot_ptr(&self, sequence: u64) -> Result<*mut DescriptorSlot, RingError> {
        if sequence == 0 || self.grant.descriptor_depth == 0 {
            return Err(RingError::InvalidSharedState);
        }
        let index = (sequence - 1) % self.grant.descriptor_depth;
        let offset = self
            .layout
            .slots
            .checked_add(
                usize::try_from(index)
                    .map_err(|_| RingError::ArithmeticOverflow)?
                    .checked_mul(size_of::<DescriptorSlot>())
                    .ok_or(RingError::ArithmeticOverflow)?,
            )
            .ok_or(RingError::ArithmeticOverflow)?;
        self.mapping.ptr_at(offset)
    }

    unsafe fn lease_span<'lease>(
        &'lease self,
        span: ArenaSpan,
    ) -> Result<LeaseSpan<'lease>, RingError> {
        let offset = usize::try_from(span.offset()).map_err(|_| RingError::InvalidLayout)?;
        let len = usize::try_from(span.len()).map_err(|_| RingError::InvalidLayout)?;
        let end = offset
            .checked_add(len)
            .ok_or(RingError::ArithmeticOverflow)?;
        if end > self.arena_bytes() {
            return Err(RingError::InvalidLayout);
        }
        // SAFETY: descriptor validation bounded span within mapped arena.
        let ptr = unsafe { self.mapping.base.as_ptr().add(self.layout.arena + offset) };
        // SAFETY: pointer and length remain valid while self is borrowed.
        unsafe { LeaseSpan::new(ptr, len) }.map_err(RingError::Lease)
    }

    fn reclaim_completed(&self) -> Result<(), RingError> {
        let consumer = self.consumer_ptr()?;
        // SAFETY: consumer page remains mapped.
        let mut completed = unsafe { (*consumer).completed.load(Ordering::Relaxed) };
        loop {
            let next = completed
                .checked_add(1)
                .ok_or(RingError::SequenceExhausted)?;
            let slot = self.slot_ptr(next)?;
            // SAFETY: acquire pairs with receiver release publication.
            let completion = unsafe { (*slot).completion_sequence.load(Ordering::Acquire) };
            if completion != next {
                break;
            }
            // SAFETY: completion sequence requires pending descriptor.
            if unsafe { (*slot).state.load(Ordering::Acquire) } != SLOT_RELEASE_PENDING {
                return Err(RingError::InvalidSharedState);
            }
            // SAFETY: pending descriptor remains immutable.
            let descriptor = unsafe { std::ptr::read_volatile((*slot).descriptor.get()) };
            let expected = ReleaseIdentity::new(self.grant.incarnation, self.grant.lane, next);
            let validated = descriptor
                .snapshot()
                .validate(expected, self.arena_bytes())
                .map_err(RingError::Descriptor)?;
            // SAFETY: producer reads consumer-owned reclamation cursor atomically.
            let reclaimed = unsafe { (*consumer).arena_reclaimed.load(Ordering::Relaxed) };
            if validated.allocation_start() != reclaimed {
                return Err(RingError::InvalidSharedState);
            }
            let new_reclaimed = reclaimed
                .checked_add(validated.allocation_len())
                .ok_or(RingError::ArithmeticOverflow)?;
            // SAFETY: producer alone reclaims in publication order.
            unsafe {
                (*consumer)
                    .arena_reclaimed
                    .store(new_reclaimed, Ordering::Release);
                (*slot).reservation_len.store(0, Ordering::Relaxed);
                (*slot).completion_sequence.store(0, Ordering::Relaxed);
                (*slot).state.store(SLOT_FREE, Ordering::Release);
                (*consumer).completed.store(next, Ordering::Release);
            }
            completed = next;
        }
        Ok(())
    }

    fn abort_reservation(&self, sequence: u64) {
        if let Ok(slot) = self.slot_ptr(sequence) {
            // SAFETY: reservation owner calls only before publication.
            unsafe {
                (*slot).reservation_len.store(0, Ordering::Relaxed);
                (*slot).state.store(SLOT_FREE, Ordering::Release);
            }
        }
    }

    fn commit_reservation(
        &self,
        sequence: u64,
        plan: SpanPlan,
        exact_len: usize,
        wire_header: [u8; WIRE_V2_HEADER_BYTES],
    ) -> Result<ReleaseIdentity, ProducerError> {
        let exact = plan.prefix(exact_len).map_err(ProducerError::Arena)?;
        let declared_len = u32::from_le_bytes([
            wire_header[0],
            wire_header[1],
            wire_header[2],
            wire_header[3],
        ]);
        if declared_len as usize != exact_len || wire_header[4] != 2 {
            return Err(ProducerError::WireHeaderMismatch);
        }
        let identity = ReleaseIdentity::new(self.grant.incarnation, self.grant.lane, sequence);
        let spans = exact.spans();
        let shared = SharedDescriptor {
            schema_version: DESCRIPTOR_SCHEMA_VERSION,
            wire_header,
            incarnation: identity.incarnation().into_bytes(),
            lane: identity.lane(),
            sequence: identity.sequence(),
            body_len: exact_len as u64,
            allocation_start: plan.allocation_start(),
            allocation_len: plan.allocation_len(),
            span_count: exact.span_count(),
            span_offsets: [spans[0].offset(), spans[1].offset()],
            span_lengths: [spans[0].len(), spans[1].len()],
        };
        let slot = self.slot_ptr(sequence).map_err(ProducerError::Ring)?;
        let producer = self.producer_ptr().map_err(ProducerError::Ring)?;
        let next_write = plan
            .allocation_start()
            .checked_add(plan.allocation_len())
            .ok_or(ProducerError::SequenceExhausted)?;
        // SAFETY: producer exclusively owns reserved slot and arena range.
        unsafe {
            std::ptr::write_volatile((*slot).descriptor.get(), shared);
            (*slot).state.store(SLOT_PUBLISHED, Ordering::Relaxed);
            (*producer).arena_write.store(next_write, Ordering::Relaxed);
            (*producer).published.store(sequence, Ordering::Release);
        }
        Ok(identity)
    }

    fn write_reservation(
        &self,
        plan: SpanPlan,
        cursor: usize,
        bytes: &[u8],
    ) -> Result<(), ProducerError> {
        let end = cursor
            .checked_add(bytes.len())
            .ok_or(ProducerError::Overflow)?;
        if end > plan.allocation_len() as usize {
            return Err(ProducerError::Overflow);
        }
        let mut copied = 0usize;
        while copied < bytes.len() {
            let absolute = plan
                .allocation_start()
                .checked_add((cursor + copied) as u64)
                .ok_or(ProducerError::Overflow)?;
            let offset = (absolute % self.grant.arena_bytes) as usize;
            let available = self.arena_bytes() - offset;
            let take = available.min(bytes.len() - copied);
            // SAFETY: active reservation owns range and chunk remains inside arena mapping.
            unsafe {
                std::ptr::copy_nonoverlapping(
                    bytes.as_ptr().add(copied),
                    self.mapping.base.as_ptr().add(self.layout.arena + offset),
                    take,
                );
            }
            copied += take;
        }
        Ok(())
    }
}

impl fmt::Debug for Ring {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Ring(<redacted>)")
    }
}

unsafe fn ring_release_callback(
    context: *const (),
    identity: ReleaseIdentity,
) -> Result<(), LeaseError> {
    // SAFETY: ReceiveLease ties context to live borrowed Ring.
    let ring = unsafe { &*context.cast::<Ring>() };
    ring.release(identity)
}

/// Direct bounded producer over one or two arena spans.
#[must_use = "producer reservation must be committed or aborted"]
pub struct ProducerReservation<'ring> {
    ring: &'ring Ring,
    plan: SpanPlan,
    sequence: u64,
    cursor: usize,
    wire_header: [u8; WIRE_V2_HEADER_BYTES],
    finished: bool,
    _not_send: PhantomData<Rc<()>>,
}

impl ProducerReservation<'_> {
    /// Reserved capacity bound.
    pub const fn capacity(&self) -> usize {
        self.plan.allocation_len() as usize
    }

    /// Bytes written so far.
    pub const fn written(&self) -> usize {
        self.cursor
    }

    /// Remaining reserved bytes.
    pub const fn remaining(&self) -> usize {
        self.capacity() - self.cursor
    }

    /// Writes all bytes or aborts reservation on overflow.
    pub fn write(&mut self, bytes: &[u8]) -> Result<(), ProducerError> {
        if self.finished {
            return Err(ProducerError::Aborted);
        }
        if let Err(error) = self.ring.write_reservation(self.plan, self.cursor, bytes) {
            self.ring.abort_reservation(self.sequence);
            self.finished = true;
            return Err(error);
        }
        self.cursor += bytes.len();
        Ok(())
    }

    /// Publishes exact committed length after cursor equality check.
    pub fn commit(mut self, body_len: usize) -> Result<ReleaseIdentity, ProducerError> {
        if self.finished {
            return Err(ProducerError::Aborted);
        }
        if body_len > self.capacity() {
            self.ring.abort_reservation(self.sequence);
            self.finished = true;
            return Err(ProducerError::CommitOutsideReservation);
        }
        if self.cursor != body_len {
            self.ring.abort_reservation(self.sequence);
            self.finished = true;
            return Err(ProducerError::Underfill);
        }
        match self
            .ring
            .commit_reservation(self.sequence, self.plan, body_len, self.wire_header)
        {
            Ok(identity) => {
                self.finished = true;
                Ok(identity)
            }
            Err(error) => {
                self.ring.abort_reservation(self.sequence);
                self.finished = true;
                Err(error)
            }
        }
    }

    /// Returns descriptor and arena reservation without publication.
    pub fn abort(mut self) {
        if !self.finished {
            self.ring.abort_reservation(self.sequence);
            self.finished = true;
        }
    }
}

impl fmt::Debug for ProducerReservation<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProducerReservation(<redacted>)")
    }
}

impl Drop for ProducerReservation<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.ring.abort_reservation(self.sequence);
            self.finished = true;
        }
    }
}

/// Pair of exclusive ordered logical directions under one runtime root.
pub struct DuplexRing {
    /// Caller-to-peer direction.
    pub first: Ring,
    /// Peer-to-caller direction.
    pub second: Ring,
    _runtime: RuntimeDir,
}

impl DuplexRing {
    /// Creates two independently cache-isolated directions.
    pub fn create(profile: &TargetProfile) -> Result<Self, RingError> {
        let runtime = RuntimeDir::create_in(&std::env::temp_dir())?;
        let first = Ring::create_in(profile, 0, &runtime)?;
        let second = Ring::create_in(profile, 1, &runtime)?;
        Ok(Self {
            first,
            second,
            _runtime: runtime,
        })
    }
}

impl fmt::Debug for DuplexRing {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DuplexRing(<redacted>)")
    }
}

/// Builds minimal structurally valid wire-v2 header for body length.
pub fn wire_v2_header(body_len: usize) -> Result<[u8; WIRE_V2_HEADER_BYTES], ProducerError> {
    let body_len = u32::try_from(body_len).map_err(|_| ProducerError::BoundExceedsSpans)?;
    if body_len as usize > MAX_FRAME_BYTES {
        return Err(ProducerError::BoundExceedsSpans);
    }
    let mut header = [0u8; WIRE_V2_HEADER_BYTES];
    header[0..4].copy_from_slice(&body_len.to_le_bytes());
    header[4] = 2;
    Ok(header)
}

/// Producer reservation or commit failure.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ProducerError {
    /// Reserved spans cannot cover requested bound.
    BoundExceedsSpans,
    /// A write crossed checked capacity.
    Overflow,
    /// Commit length exceeds reservation.
    CommitOutsideReservation,
    /// Cursor differs from exact commit length.
    Underfill,
    /// Reservation was already aborted.
    Aborted,
    /// No descriptor or arena capacity is available.
    Exhausted,
    /// Backpressure deadline elapsed before publication.
    Deadline,
    /// Sequence would wrap within incarnation.
    SequenceExhausted,
    /// Wire header version or length disagrees with body.
    WireHeaderMismatch,
    /// Candidate is terminally quarantined.
    Quarantined,
    /// Arena planning failure.
    Arena(ArenaError),
    /// Ring state failure.
    Ring(RingError),
}

impl fmt::Debug for ProducerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, formatter)
    }
}

impl fmt::Display for ProducerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::BoundExceedsSpans => "producer bound exceeds legal spans",
            Self::Overflow => "producer cursor overflow",
            Self::CommitOutsideReservation => "commit exceeds reservation",
            Self::Underfill => "producer reservation is underfilled",
            Self::Aborted => "producer reservation is aborted",
            Self::Exhausted => "bounded ring capacity is exhausted",
            Self::Deadline => "bounded backpressure deadline elapsed",
            Self::SequenceExhausted => "release sequence exhausted",
            Self::WireHeaderMismatch => "wire header disagrees with committed body",
            Self::Quarantined => "transport storage is quarantined",
            Self::Arena(_) => "arena reservation failed",
            Self::Ring(_) => "ring operation failed",
        })
    }
}

impl std::error::Error for ProducerError {}

/// Ring setup, validation, or receive failure.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RingError {
    /// Offset or size arithmetic overflowed.
    ArithmeticOverflow,
    /// Target profile does not select this layout.
    ProfileMismatch,
    /// Runtime directory or shared object creation failed.
    ObjectSetupFailed,
    /// Owner, inode, size, type, mode, or seal validation failed.
    ObjectValidationFailed,
    /// Attachment grant is malformed or mismatched.
    InvalidGrant,
    /// Shared layout fields are invalid.
    InvalidLayout,
    /// Shared state transition is impossible.
    InvalidSharedState,
    /// Mapping prefault or residency verification failed.
    PrefaultFailed,
    /// Release sequence would wrap.
    SequenceExhausted,
    /// Outstanding receive-lease limit reached.
    LeaseLimit,
    /// Candidate is terminally quarantined.
    Quarantined,
    /// Descriptor validation failed.
    Descriptor(DescriptorError),
    /// Lease construction failed.
    Lease(LeaseError),
}

impl fmt::Debug for RingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, formatter)
    }
}

impl fmt::Display for RingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ArithmeticOverflow => "ring arithmetic overflow",
            Self::ProfileMismatch => "target profile does not match ring backend",
            Self::ObjectSetupFailed => "shared object setup failed",
            Self::ObjectValidationFailed => "shared object validation failed",
            Self::InvalidGrant => "attachment grant is invalid",
            Self::InvalidLayout => "shared memory layout is invalid",
            Self::InvalidSharedState => "shared ring state is invalid",
            Self::PrefaultFailed => "shared mapping prefault failed",
            Self::SequenceExhausted => "release sequence exhausted",
            Self::LeaseLimit => "receive lease limit reached",
            Self::Quarantined => "transport storage is quarantined",
            Self::Descriptor(_) => "shared descriptor validation failed",
            Self::Lease(_) => "receive lease construction failed",
        })
    }
}

impl std::error::Error for RingError {}

fn initialize_mapping(
    mapping: &Mapping,
    layout: Layout,
    grant: RingGrant,
) -> Result<(), RingError> {
    let producer = mapping.ptr_at::<ProducerPage>(layout.producer)?;
    let consumer = mapping.ptr_at::<ConsumerPage>(layout.consumer)?;
    // SAFETY: fresh mapping is exclusively initialized before publication.
    unsafe {
        producer.write(ProducerPage {
            published: AtomicU64::new(0),
            arena_write: AtomicU64::new(0),
        });
        consumer.write(ConsumerPage {
            consumed: AtomicU64::new(0),
            completed: AtomicU64::new(0),
            arena_reclaimed: AtomicU64::new(0),
            active_leases: AtomicU64::new(0),
        });
    }
    for index in 0..grant.descriptor_depth {
        let offset = layout
            .slots
            .checked_add(
                usize::try_from(index)
                    .map_err(|_| RingError::ArithmeticOverflow)?
                    .checked_mul(size_of::<DescriptorSlot>())
                    .ok_or(RingError::ArithmeticOverflow)?,
            )
            .ok_or(RingError::ArithmeticOverflow)?;
        let slot = mapping.ptr_at::<DescriptorSlot>(offset)?;
        // SAFETY: each fresh slot is initialized once before activation.
        unsafe {
            slot.write(DescriptorSlot {
                state: AtomicU8::new(SLOT_FREE),
                completion_sequence: AtomicU64::new(0),
                reservation_len: AtomicU64::new(0),
                descriptor: UnsafeCell::new(SharedDescriptor::ZERO),
            });
        }
    }
    let lifecycle = mapping.ptr_at::<LifecyclePage>(layout.lifecycle)?;
    // SAFETY: fresh lifecycle page is initialized once before activation.
    unsafe {
        lifecycle.write(LifecyclePage {
            magic: MAPPING_MAGIC,
            layout_version: LAYOUT_VERSION,
            descriptor_depth: grant.descriptor_depth,
            arena_bytes: grant.arena_bytes,
            max_leases: grant.max_leases,
            total_bytes: grant.total_bytes,
            incarnation: grant.incarnation.into_bytes(),
            lane: grant.lane,
            quarantined: AtomicU8::new(0),
        });
    }
    Ok(())
}

fn validate_lifecycle(
    mapping: &Mapping,
    layout: Layout,
    expected: RingGrant,
) -> Result<(), RingError> {
    let lifecycle = mapping.ptr_at::<LifecyclePage>(layout.lifecycle)?;
    // SAFETY: bounds validated; integer fields have all-bit valid representations.
    let snapshot = unsafe {
        (
            std::ptr::read_volatile(std::ptr::addr_of!((*lifecycle).magic)),
            std::ptr::read_volatile(std::ptr::addr_of!((*lifecycle).layout_version)),
            std::ptr::read_volatile(std::ptr::addr_of!((*lifecycle).descriptor_depth)),
            std::ptr::read_volatile(std::ptr::addr_of!((*lifecycle).arena_bytes)),
            std::ptr::read_volatile(std::ptr::addr_of!((*lifecycle).max_leases)),
            std::ptr::read_volatile(std::ptr::addr_of!((*lifecycle).total_bytes)),
            std::ptr::read_volatile(std::ptr::addr_of!((*lifecycle).incarnation)),
            std::ptr::read_volatile(std::ptr::addr_of!((*lifecycle).lane)),
        )
    };
    if snapshot.0 != MAPPING_MAGIC
        || snapshot.1 != expected.layout_version
        || snapshot.2 != expected.descriptor_depth
        || snapshot.3 != expected.arena_bytes
        || snapshot.4 != expected.max_leases
        || snapshot.5 != expected.total_bytes
        || snapshot.6 != expected.incarnation.into_bytes()
        || snapshot.7 != expected.lane
    {
        return Err(RingError::InvalidGrant);
    }
    Ok(())
}

fn prefault_read(mapping: &Mapping) {
    for offset in (0..mapping.len).step_by(PAGE_SIZE) {
        // SAFETY: offsets remain in mapped range; volatile read faults page in.
        unsafe { mapping.base.as_ptr().add(offset).read_volatile() };
    }
}

fn validate_object(fd: &OwnedFd, expected_len: usize) -> Result<(), RingError> {
    // SAFETY: zeroed stat is valid output storage for fstat.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: fd is owned and stat points to writable storage.
    if unsafe { libc::fstat(fd.as_raw_fd(), &mut stat) } != 0 {
        return Err(RingError::ObjectValidationFailed);
    }
    // SAFETY: geteuid has no preconditions.
    let current_uid = unsafe { libc::geteuid() };
    if stat.st_uid != current_uid
        || stat.st_size < 0
        || stat.st_size as usize != expected_len
        || stat.st_mode & libc::S_IFMT != libc::S_IFREG
        || stat.st_mode & 0o077 != 0
    {
        return Err(RingError::ObjectValidationFailed);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn create_linux_memfd(len: usize) -> Result<OwnedFd, RingError> {
    let name = c"mc-shm-transport";
    // SAFETY: static name is valid and flags request sealing support.
    let raw = unsafe {
        libc::syscall(
            libc::SYS_memfd_create,
            name.as_ptr(),
            libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
        ) as libc::c_int
    };
    if raw < 0 {
        return Err(RingError::ObjectSetupFailed);
    }
    // SAFETY: successful memfd_create returns newly owned descriptor.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    let len = libc::off_t::try_from(len).map_err(|_| RingError::ArithmeticOverflow)?;
    // SAFETY: fd is valid and length was checked.
    if unsafe { libc::ftruncate(fd.as_raw_fd(), len) } != 0
        // SAFETY: fd is valid and mode removes group/other access.
        || unsafe { libc::fchmod(fd.as_raw_fd(), 0o600) } != 0
    {
        return Err(RingError::ObjectSetupFailed);
    }
    Ok(fd)
}

#[cfg(target_os = "linux")]
fn seal_object(fd: &OwnedFd) -> Result<(), RingError> {
    let seals = libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
    // SAFETY: fd supports seals because it was created with MFD_ALLOW_SEALING.
    if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_ADD_SEALS, seals) } < 0 {
        return Err(RingError::ObjectSetupFailed);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn create_macos_shm(len: usize) -> Result<OwnedFd, RingError> {
    let mut random = [0u8; 16];
    getrandom::getrandom(&mut random).map_err(|_| RingError::ObjectSetupFailed)?;
    let name = random
        .iter()
        .fold(String::from("/mc-shm-"), |mut text, byte| {
            use std::fmt::Write;
            let _ = write!(text, "{byte:02x}");
            text
        });
    let name = CString::new(name).map_err(|_| RingError::ObjectSetupFailed)?;
    // SAFETY: unique NUL-terminated name and owner-only flags.
    let raw = unsafe {
        libc::shm_open(
            name.as_ptr(),
            libc::O_CREAT | libc::O_EXCL | libc::O_RDWR | libc::O_CLOEXEC,
            0o600,
        )
    };
    if raw < 0 {
        return Err(RingError::ObjectSetupFailed);
    }
    // SAFETY: successful shm_open returns newly owned descriptor.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    let len = libc::off_t::try_from(len).map_err(|_| RingError::ArithmeticOverflow)?;
    // SAFETY: fd is valid and resized exactly once before unlink.
    if unsafe { libc::ftruncate(fd.as_raw_fd(), len) } != 0 {
        return Err(RingError::ObjectSetupFailed);
    }
    // SAFETY: name remains valid and unlink removes locator before activation.
    if unsafe { libc::shm_unlink(name.as_ptr()) } != 0 {
        return Err(RingError::ObjectSetupFailed);
    }
    Ok(fd)
}
