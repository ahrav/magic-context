#[cfg(not(target_os = "linux"))]
compile_error!("mc-shm-transport ring backend supports Linux only");

use std::cell::UnsafeCell;
use std::ffi::CString;
use std::fmt;
use std::fs::File;
use std::marker::PhantomData;
use std::mem::size_of;
use std::os::fd::RawFd;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::ptr::NonNull;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

use crate::arena::{ArenaCounts, ArenaError, ArenaSpan, SpanPlan, MAX_FRAME_BYTES};
use crate::descriptor::{
    DescriptorCounts, DescriptorError, FrameDescriptor, Incarnation, ReleaseIdentity,
    DESCRIPTOR_SCHEMA_VERSION, MAX_SPANS, WIRE_V2_HEADER_BYTES,
};
use crate::lease::{LeaseError, LeaseSpan, ReceiveLease};
use crate::profile::TargetProfile;

const MAPPING_MAGIC: u64 = 0x4d43_5348_4d52_3031;
const LAYOUT_VERSION: u16 = 3;
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
    active_leases: AtomicU64,
}

#[repr(C, align(128))]
struct ReclaimPage {
    completed: AtomicU64,
    arena_reclaimed: AtomicU64,
}

#[repr(C, align(128))]
struct WakeEpoch {
    generation: AtomicU64,
    parked: AtomicU64,
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
    reclaim: usize,
    data_wake: usize,
    capacity_wake: usize,
    slots: usize,
    arena: usize,
    lifecycle: usize,
    total: usize,
}

impl Layout {
    fn new(depth: usize, arena_bytes: usize) -> Result<Self, RingError> {
        let producer = 0usize;
        let consumer = align_up(size_of::<ProducerPage>(), CACHELINE)?;
        let reclaim = align_up(
            consumer
                .checked_add(size_of::<ConsumerPage>())
                .ok_or(RingError::ArithmeticOverflow)?,
            CACHELINE,
        )?;
        let data_wake = align_up(
            reclaim
                .checked_add(size_of::<ReclaimPage>())
                .ok_or(RingError::ArithmeticOverflow)?,
            CACHELINE,
        )?;
        let capacity_wake = align_up(
            data_wake
                .checked_add(size_of::<WakeEpoch>())
                .ok_or(RingError::ArithmeticOverflow)?,
            CACHELINE,
        )?;
        let slots = align_up(
            capacity_wake
                .checked_add(size_of::<WakeEpoch>())
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
            reclaim,
            data_wake,
            capacity_wake,
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

fn removal_ranges(
    arena_offset: usize,
    arena_bytes: usize,
    logical_start: u64,
    logical_len: u64,
    page_size: usize,
) -> Result<[(usize, usize); 2], RingError> {
    if arena_bytes == 0
        || page_size == 0
        || !page_size.is_power_of_two()
        || !arena_offset.is_multiple_of(page_size)
        || !arena_bytes.is_multiple_of(page_size)
    {
        return Err(RingError::InvalidLayout);
    }
    let logical_end = logical_start
        .checked_add(logical_len)
        .ok_or(RingError::ArithmeticOverflow)?;
    if logical_len > arena_bytes as u64 {
        return Err(RingError::InvalidSharedState);
    }
    let page_mask = !(page_size as u64 - 1);
    let removable_start = logical_start & page_mask;
    let removable_end = logical_end & page_mask;
    let len = usize::try_from(removable_end - removable_start)
        .map_err(|_| RingError::ArithmeticOverflow)?;
    let start = usize::try_from(removable_start % arena_bytes as u64)
        .map_err(|_| RingError::ArithmeticOverflow)?;
    let first_len = len.min(arena_bytes - start);
    let segments = [(start, first_len), (0, len - first_len)];
    let mut ranges = [(0, 0); 2];
    for (index, (offset, segment_len)) in segments.into_iter().enumerate() {
        if segment_len != 0 {
            ranges[index] = (
                arena_offset
                    .checked_add(offset)
                    .ok_or(RingError::ArithmeticOverflow)?,
                segment_len,
            );
        }
    }
    Ok(ranges)
}

#[cfg(test)]
static FAIL_NEXT_PAGE_REMOVAL: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn remove_pages(base: *mut u8, offset: usize, len: usize) -> libc::c_int {
    #[cfg(test)]
    if FAIL_NEXT_PAGE_REMOVAL.swap(false, Ordering::AcqRel) {
        return -1;
    }
    // SAFETY: caller supplies a live page-aligned range inside the shared mapping.
    unsafe { libc::madvise(base.add(offset).cast(), len, libc::MADV_REMOVE) }
}

fn system_page_size() -> usize {
    static PAGE_SIZE_CACHE: OnceLock<usize> = OnceLock::new();
    *PAGE_SIZE_CACHE.get_or_init(|| {
        // SAFETY: sysconf has no pointer or lifetime preconditions.
        let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        usize::try_from(page_size)
            .ok()
            .filter(|size| *size > 0)
            .unwrap_or(PAGE_SIZE)
    })
}

fn residency_vector_len(mapping_len: usize, page_size: usize) -> usize {
    mapping_len.div_ceil(page_size.max(1))
}

struct Mapping {
    fd: OwnedFd,
    base: NonNull<u8>,
    len: usize,
}

impl Mapping {
    fn create(len: usize) -> Result<Self, RingError> {
        let fd = create_linux_memfd(len)?;

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
        Ok(Self { fd, base, len })
    }

    fn attach(fd: OwnedFd, len: usize) -> Result<Self, RingError> {
        validate_object(&fd, len)?;
        validate_seals(&fd)?;
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
        Ok(Self { fd, base, len })
    }

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

struct Doorbell(OwnedFd);

impl Doorbell {
    fn create() -> Result<Self, RingError> {
        // SAFETY: eventfd creates one process-owned nonblocking counter.
        let raw = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC | libc::EFD_NONBLOCK) };
        if raw < 0 {
            return Err(RingError::DoorbellFailed);
        }
        // SAFETY: successful eventfd returns a new owned descriptor.
        Ok(Self(unsafe { OwnedFd::from_raw_fd(raw) }))
    }

    fn from_fd(fd: OwnedFd) -> Result<Self, RingError> {
        // SAFETY: F_GETFL validates descriptor liveness and returns its status flags.
        let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
        if flags < 0 || flags & libc::O_NONBLOCK == 0 {
            return Err(RingError::DoorbellFailed);
        }
        let target =
            std::fs::read_link(Path::new("/proc/self/fd").join(fd.as_raw_fd().to_string()))
                .map_err(|_| RingError::DoorbellFailed)?;
        if target.as_os_str().as_bytes() != b"anon_inode:[eventfd]" {
            return Err(RingError::DoorbellFailed);
        }
        Ok(Self(fd))
    }

    fn duplicate(&self) -> Result<OwnedFd, RingError> {
        self.0.try_clone().map_err(|_| RingError::DoorbellFailed)
    }

    fn signal(&self) -> Result<(), RingError> {
        let value = 1u64.to_ne_bytes();
        // SAFETY: pointer and length describe one eventfd word.
        let result = unsafe { libc::write(self.0.as_raw_fd(), value.as_ptr().cast(), value.len()) };
        if result == value.len() as isize {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EAGAIN) {
            return Ok(());
        }
        Err(RingError::DoorbellFailed)
    }

    fn drain(&self) -> Result<(), RingError> {
        let mut value = 0u64;
        // SAFETY: pointer and length describe one writable eventfd word.
        let result = unsafe {
            libc::read(
                self.0.as_raw_fd(),
                std::ptr::addr_of_mut!(value).cast(),
                size_of::<u64>(),
            )
        };
        if result == size_of::<u64>() as isize {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EAGAIN) {
            return Ok(());
        }
        Err(RingError::DoorbellFailed)
    }

    fn wait_until(&self, deadline: Instant) -> Result<bool, RingError> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(false);
        }
        let timeout = remaining
            .as_millis()
            .saturating_add(1)
            .min(i32::MAX as u128) as i32;
        let mut descriptor = libc::pollfd {
            fd: self.0.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: poll receives one initialized pollfd.
        let result = unsafe { libc::poll(&mut descriptor, 1, timeout) };
        if result > 0 {
            Ok(true)
        } else if result == 0 {
            Ok(false)
        } else if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
            Ok(Instant::now() < deadline)
        } else {
            Err(RingError::DoorbellFailed)
        }
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

/// Mapping geometry carried by an authenticated ring grant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RingGeometry {
    /// Descriptor slots in one direction.
    pub descriptor_depth: u64,
    /// Payload arena bytes in one direction.
    pub arena_bytes: u64,
    /// Concurrent receive leases in one direction.
    pub max_leases: u64,
    /// Complete mapping length, including control pages and alignment.
    pub mapping_bytes: u64,
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
    ///
    /// Rejects reserved-byte tampering and any geometry that cannot map a
    /// valid ring: wrong layout version, zero depth, an arena below one
    /// legal maximum frame, lease bounds outside `1..=depth`, or a total
    /// size that disagrees with the computed layout.
    pub fn decode(bytes: [u8; GRANT_BYTES]) -> Result<Self, RingError> {
        if bytes[54..58] != [0; 4] {
            return Err(RingError::InvalidGrant);
        }
        let array = |range: std::ops::Range<usize>| -> [u8; 8] {
            bytes[range]
                .try_into()
                .expect("grant ranges have fixed eight-byte width")
        };
        let grant = Self {
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
        };
        grant.checked_layout()?;
        Ok(grant)
    }

    /// Decodes one exact-length grant slice. commentlint: allow(JUDGE)
    pub fn decode_slice(bytes: &[u8]) -> Result<Self, RingError> {
        let bytes: [u8; GRANT_BYTES] = bytes.try_into().map_err(|_| RingError::InvalidGrant)?;
        Self::decode(bytes)
    }

    fn checked_layout(&self) -> Result<Layout, RingError> {
        if self.layout_version != LAYOUT_VERSION
            || self.descriptor_depth == 0
            || self.arena_bytes < MAX_FRAME_BYTES as u64
            || self.max_leases == 0
            || self.max_leases > self.descriptor_depth
        {
            return Err(RingError::InvalidGrant);
        }
        let depth = usize::try_from(self.descriptor_depth).map_err(|_| RingError::InvalidGrant)?;
        let arena = usize::try_from(self.arena_bytes).map_err(|_| RingError::InvalidGrant)?;
        let total = usize::try_from(self.total_bytes).map_err(|_| RingError::InvalidGrant)?;
        let layout = Layout::new(depth, arena)?;
        if layout.total != total {
            return Err(RingError::InvalidGrant);
        }
        Ok(layout)
    }

    /// Fixed encoded grant length.
    pub const fn encoded_len() -> usize {
        GRANT_BYTES
    }

    /// Returns validated mapping geometry from the grant itself.
    pub const fn geometry(self) -> RingGeometry {
        RingGeometry {
            descriptor_depth: self.descriptor_depth,
            arena_bytes: self.arena_bytes,
            max_leases: self.max_leases,
            mapping_bytes: self.total_bytes,
        }
    }
}

impl fmt::Debug for RingGrant {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RingGrant(<redacted>)")
    }
}

/// Ring attachment handle. commentlint: allow(JUDGE)
pub struct RingAttachment {
    descriptors: [OwnedFd; 3],
    grant: RingGrant,
}

impl RingAttachment {
    /// Attaches ring. commentlint: allow(JUDGE)
    pub fn attach(self) -> Result<Ring, RingError> {
        Ring::attach(self.descriptors, self.grant)
    }

    /// Grant. commentlint: allow(JUDGE)
    pub const fn grant(&self) -> RingGrant {
        self.grant
    }

    /// Splits descriptors from grant. commentlint: allow(JUDGE)
    pub fn into_parts(self) -> ([OwnedFd; 3], RingGrant) {
        (self.descriptors, self.grant)
    }
}

impl fmt::Debug for RingAttachment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RingAttachment(<redacted>)")
    }
}

/// Cacheline-isolated SPSC descriptor ring with FIFO payload arena.
pub struct Ring {
    mapping: Mapping,
    layout: Layout,
    grant: RingGrant,
    data_ready: Doorbell,
    capacity_ready: Doorbell,
    owned_runtime_dir: Option<RuntimeDir>,
    _not_send_or_sync: PhantomData<Rc<()>>,
}

impl Ring {
    /// Creates sealed sparse ring. commentlint: allow(JUDGE)
    pub fn create(profile: &TargetProfile, lane: u32) -> Result<Self, RingError> {
        let runtime = RuntimeDir::create_in(&std::env::temp_dir())?;
        let mut ring = Self::create_in(profile, lane, &runtime)?;
        ring.owned_runtime_dir = Some(runtime);
        Ok(ring)
    }

    /// Creates ring using already validated candidate runtime directory.
    ///
    /// Profile identity is enforced upstream by `TargetProfile::new`; only span geometry is re-checked here because it constrains this ring's wrap behavior. commentlint: allow(JUDGE)
    pub fn create_in(
        profile: &TargetProfile,
        lane: u32,
        runtime: &RuntimeDir,
    ) -> Result<Self, RingError> {
        runtime.validate()?;
        debug_assert_eq!(
            profile.descriptor().schema_version(),
            DESCRIPTOR_SCHEMA_VERSION
        );
        // Reservations crossing the arena end wrap into two spans, so a
        // profile advertising fewer spans per frame cannot be honored.
        if profile.max_spans() < MAX_SPANS {
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
        initialize_mapping(&mapping, layout, grant)?;
        seal_object(mapping.fd())?;
        validate_object(mapping.fd(), mapping.len)?;
        Ok(Self {
            mapping,
            layout,
            grant,
            data_ready: Doorbell::create()?,
            capacity_ready: Doorbell::create()?,
            owned_runtime_dir: None,
            _not_send_or_sync: PhantomData,
        })
    }

    /// Attaches exact authenticated grant to inherited or transferred descriptor.
    pub fn attach(descriptors: [OwnedFd; 3], grant: RingGrant) -> Result<Self, RingError> {
        let [mapping_fd, data_ready, capacity_ready] = descriptors;
        let layout = grant.checked_layout()?;
        let total = usize::try_from(grant.total_bytes).map_err(|_| RingError::InvalidGrant)?;
        let mapping = Mapping::attach(mapping_fd, total)?;
        validate_lifecycle(&mapping, layout, grant)?;
        Ok(Self {
            mapping,
            layout,
            grant,
            data_ready: Doorbell::from_fd(data_ready)?,
            capacity_ready: Doorbell::from_fd(capacity_ready)?,
            owned_runtime_dir: None,
            _not_send_or_sync: PhantomData,
        })
    }

    /// Attachment grant for authenticated bootstrap.
    pub const fn grant(&self) -> RingGrant {
        self.grant
    }

    /// Shared object descriptor for authenticated transfer.
    pub fn raw_fd(&self) -> RawFd {
        self.mapping.fd.as_raw_fd()
    }

    /// Returns mapping, data, and capacity descriptors. commentlint: allow(JUDGE)
    pub fn raw_descriptors(&self) -> [RawFd; 3] {
        [
            self.mapping.fd.as_raw_fd(),
            self.data_ready.0.as_raw_fd(),
            self.capacity_ready.0.as_raw_fd(),
        ]
    }

    /// Duplicates the data-readiness descriptor for an owning event-loop registration. commentlint: allow(JUDGE)
    pub fn duplicate_data_ready(&self) -> Result<OwnedFd, RingError> {
        self.data_ready.duplicate()
    }

    /// Binds one data wait to the observed generation. commentlint: allow(JUDGE)
    ///
    /// Returns `true` only when the caller should block on the data-readiness descriptor.
    /// A `false` result means data or a generation change is already visible.
    pub fn arm_data_wait(&self) -> Result<bool, RingError> {
        if self.data_available()? {
            return Ok(false);
        }
        let wake = self.data_wake_ptr()?;
        // SAFETY: wake page remains mapped and atomics were initialized before activation.
        let generation = unsafe { (*wake).generation.load(Ordering::Acquire) };
        unsafe {
            (*wake)
                .parked
                .store(generation.wrapping_add(1), Ordering::Release)
        };
        if self.data_available()?
            || unsafe { (*wake).generation.load(Ordering::Acquire) } != generation
        {
            unsafe { (*wake).parked.store(0, Ordering::Release) };
            return Ok(false);
        }
        self.data_ready.drain()?;
        if self.data_available()?
            || unsafe { (*wake).generation.load(Ordering::Acquire) } != generation
        {
            unsafe { (*wake).parked.store(0, Ordering::Release) };
            return Ok(false);
        }
        Ok(true)
    }

    /// Ends an external data wait and drains its coalesced token. commentlint: allow(JUDGE)
    pub fn complete_data_wait(&self) -> Result<(), RingError> {
        let wake = self.data_wake_ptr()?;
        // SAFETY: wake page remains mapped and atomics were initialized before activation.
        unsafe { (*wake).parked.store(0, Ordering::Release) };
        self.data_ready.drain()
    }

    /// Duplicates attachment handle. commentlint: allow(JUDGE)
    pub fn attachment(&self) -> Result<RingAttachment, RingError> {
        // SAFETY: F_DUPFD_CLOEXEC duplicates owned valid descriptor.
        let raw = unsafe { libc::fcntl(self.raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
        if raw < 0 {
            return Err(RingError::ObjectSetupFailed);
        }
        // SAFETY: successful fcntl returns a newly owned descriptor.
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        Ok(RingAttachment {
            descriptors: [
                fd,
                self.data_ready.duplicate()?,
                self.capacity_ready.duplicate()?,
            ],
            grant: self.grant,
        })
    }

    /// Controls close-on-exec for child re-exec tests and handle transfer.
    pub fn set_inheritable(&self, inheritable: bool) -> Result<(), RingError> {
        for descriptor in self.raw_descriptors() {
            // SAFETY: F_GETFD reads flags from owned valid fd.
            let current = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
            if current < 0 {
                return Err(RingError::ObjectValidationFailed);
            }
            let flags = if inheritable {
                current & !libc::FD_CLOEXEC
            } else {
                current | libc::FD_CLOEXEC
            };
            // SAFETY: F_SETFD updates flags on owned valid fd.
            if unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags) } < 0 {
                return Err(RingError::ObjectValidationFailed);
            }
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
        let reclaim = self.reclaim_ptr().map_err(ProducerError::Ring)?;
        // SAFETY: producer and reclaim pages were initialized before activation.
        let published = unsafe { (*producer).published.load(Ordering::Relaxed) };
        // SAFETY: same as above.
        let completed = unsafe { (*reclaim).completed.load(Ordering::Acquire) };
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
        let reclaimed = unsafe { (*reclaim).arena_reclaimed.load(Ordering::Acquire) };
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

    /// Waits on capacity readiness until deadline. commentlint: allow(JUDGE)
    pub fn reserve_until(
        &self,
        bound: usize,
        wire_header: [u8; WIRE_V2_HEADER_BYTES],
        deadline: Instant,
    ) -> Result<ProducerReservation<'_>, ProducerError> {
        loop {
            match self.try_reserve(bound, wire_header) {
                Err(ProducerError::Exhausted) if Instant::now() < deadline => {}
                Err(ProducerError::Exhausted) => return Err(ProducerError::Deadline),
                result => return result,
            }
            let wake = self.capacity_wake_ptr().map_err(ProducerError::Ring)?;
            // SAFETY: wake page remains mapped and atomics were initialized before activation.
            let generation = unsafe { (*wake).generation.load(Ordering::Acquire) };
            // A nonzero parked value identifies this generation-bound park epoch.
            unsafe {
                (*wake)
                    .parked
                    .store(generation.wrapping_add(1), Ordering::Release)
            };
            match self.try_reserve(bound, wire_header) {
                Err(ProducerError::Exhausted) if Instant::now() < deadline => {}
                Err(ProducerError::Exhausted) => {
                    unsafe { (*wake).parked.store(0, Ordering::Release) };
                    return Err(ProducerError::Deadline);
                }
                result => {
                    unsafe { (*wake).parked.store(0, Ordering::Release) };
                    return result;
                }
            }
            if unsafe { (*wake).generation.load(Ordering::Acquire) } != generation {
                unsafe { (*wake).parked.store(0, Ordering::Release) };
                continue;
            }
            if let Err(error) = self.capacity_ready.drain() {
                unsafe { (*wake).parked.store(0, Ordering::Release) };
                return Err(ProducerError::Ring(error));
            }
            match self.try_reserve(bound, wire_header) {
                Err(ProducerError::Exhausted) if Instant::now() < deadline => {}
                Err(ProducerError::Exhausted) => {
                    unsafe { (*wake).parked.store(0, Ordering::Release) };
                    return Err(ProducerError::Deadline);
                }
                result => {
                    unsafe { (*wake).parked.store(0, Ordering::Release) };
                    return result;
                }
            }
            if unsafe { (*wake).generation.load(Ordering::Acquire) } != generation {
                unsafe { (*wake).parked.store(0, Ordering::Release) };
                continue;
            }
            let ready = match self.capacity_ready.wait_until(deadline) {
                Ok(ready) => ready,
                Err(error) => {
                    unsafe { (*wake).parked.store(0, Ordering::Release) };
                    return Err(ProducerError::Ring(error));
                }
            };
            unsafe { (*wake).parked.store(0, Ordering::Release) };
            if !ready && Instant::now() >= deadline {
                return Err(ProducerError::Deadline);
            }
            self.capacity_ready.drain().map_err(ProducerError::Ring)?;
        }
    }

    /// Acquires next complete frame after release/acquire publication.
    ///
    /// Returns `Ok(None)` when no frame is deliverable right now: the ring
    /// is empty or every `max_leases` receive lease is outstanding. Errors
    /// are reserved for faults that end the channel.
    pub fn try_receive(&self) -> Result<Option<ReceiveLease<'_>>, RingError> {
        if self.is_quarantined() {
            return Err(RingError::Quarantined);
        }
        let producer = self.producer_ptr()?;
        let consumer = self.consumer_ptr()?;
        // SAFETY: consumer page remains mapped.
        let active = unsafe { (*consumer).active_leases.load(Ordering::Relaxed) };
        if active >= self.grant.max_leases {
            // A full lease set is backpressure, not a fault: published
            // frames stay queued until a lease is released and the caller
            // polls again.
            return Ok(None);
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
                validated.wire_header(),
                validated.identity(),
                (self as *const Self).cast(),
                ring_release_callback,
            )
        }
        .map_err(RingError::Lease)?;
        Ok(Some(lease))
    }

    /// Waits until a frame can be leased or deadline expires. commentlint: allow(JUDGE)
    pub fn wait_for_data(&self, deadline: Instant) -> Result<bool, RingError> {
        loop {
            if self.data_available()? {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            if !self.arm_data_wait()? {
                continue;
            }
            let ready = self.data_ready.wait_until(deadline)?;
            if !ready && Instant::now() >= deadline {
                let wake = self.data_wake_ptr()?;
                // SAFETY: wake page remains mapped and atomics were initialized before activation.
                unsafe { (*wake).parked.store(0, Ordering::Release) };
                return Ok(false);
            }
            self.complete_data_wait()?;
        }
    }

    fn data_available(&self) -> Result<bool, RingError> {
        let producer = self.producer_ptr()?;
        let consumer = self.consumer_ptr()?;
        // SAFETY: cursor and lease fields are initialized shared atomics.
        let (published, consumed, active) = unsafe {
            (
                (*producer).published.load(Ordering::Acquire),
                (*consumer).consumed.load(Ordering::Acquire),
                (*consumer).active_leases.load(Ordering::Acquire),
            )
        };
        Ok(published != consumed && active < self.grant.max_leases)
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
        if self
            .signal_wake(self.capacity_wake_ptr(), &self.capacity_ready)
            .is_err()
            || self
                .signal_wake(self.data_wake_ptr(), &self.data_ready)
                .is_err()
        {
            self.enter_quarantine();
            return Err(LeaseError::Quarantined);
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

    /// Readiness probe that only reads shared state. commentlint: allow(JUDGE)
    pub fn probe(&self) -> Result<(), RingError> {
        if self.is_quarantined() {
            return Err(RingError::Quarantined);
        }
        self.conservation().map(|_| ())
    }

    /// Counts resident arena pages. commentlint: allow(JUDGE)
    pub fn resident_arena_pages(&self) -> Result<usize, RingError> {
        let page_size = system_page_size();
        let arena_len = self.arena_bytes();
        let mut residency = vec![0u8; residency_vector_len(arena_len, page_size)];
        // SAFETY: arena offset and length lie inside live mapping.
        let result = unsafe {
            libc::mincore(
                self.mapping.base.as_ptr().add(self.layout.arena).cast(),
                arena_len,
                residency.as_mut_ptr().cast(),
            )
        };
        if result != 0 {
            return Err(RingError::ObjectValidationFailed);
        }
        Ok(residency.into_iter().filter(|entry| entry & 1 == 1).count())
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

    fn reclaim_ptr(&self) -> Result<*mut ReclaimPage, RingError> {
        self.mapping.ptr_at(self.layout.reclaim)
    }

    fn data_wake_ptr(&self) -> Result<*mut WakeEpoch, RingError> {
        self.mapping.ptr_at(self.layout.data_wake)
    }

    fn capacity_wake_ptr(&self) -> Result<*mut WakeEpoch, RingError> {
        self.mapping.ptr_at(self.layout.capacity_wake)
    }

    fn lifecycle_ptr(&self) -> Result<*mut LifecyclePage, RingError> {
        self.mapping.ptr_at(self.layout.lifecycle)
    }

    fn signal_wake(
        &self,
        wake: Result<*mut WakeEpoch, RingError>,
        doorbell: &Doorbell,
    ) -> Result<(), RingError> {
        let wake = wake?;
        // SAFETY: wake page remains mapped and is shared through atomics.
        unsafe {
            (*wake).generation.fetch_add(1, Ordering::Release);
            if (*wake).parked.swap(0, Ordering::AcqRel) != 0 {
                doorbell.signal()?;
            }
        }
        Ok(())
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
        let reclaim = self.reclaim_ptr()?;
        // SAFETY: producer-owned reclaim page remains mapped.
        let completed = unsafe { (*reclaim).completed.load(Ordering::Relaxed) };
        let reclaimed = unsafe { (*reclaim).arena_reclaimed.load(Ordering::Relaxed) };
        let mut last = completed;
        let mut run_len = 0u64;
        loop {
            let next = last.checked_add(1).ok_or(RingError::SequenceExhausted)?;
            let slot = self.slot_ptr(next)?;
            // SAFETY: acquire pairs with receiver release publication.
            if unsafe { (*slot).completion_sequence.load(Ordering::Acquire) } != next {
                break;
            }
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
            let expected_start = reclaimed
                .checked_add(run_len)
                .ok_or(RingError::ArithmeticOverflow)?;
            if validated.allocation_start() != expected_start {
                return Err(RingError::InvalidSharedState);
            }
            run_len = run_len
                .checked_add(validated.allocation_len())
                .ok_or(RingError::ArithmeticOverflow)?;
            last = next;
        }
        if last == completed {
            return Ok(());
        }
        for (offset, len) in removal_ranges(
            self.layout.arena,
            self.arena_bytes(),
            reclaimed,
            run_len,
            system_page_size(),
        )?
        .into_iter()
        .filter(|(_, len)| *len != 0)
        {
            let result = remove_pages(self.mapping.base.as_ptr(), offset, len);
            if result != 0 {
                self.enter_quarantine();
                return Err(RingError::PageRemovalFailed);
            }
        }
        for sequence in completed + 1..=last {
            let slot = self.slot_ptr(sequence)?;
            // SAFETY: removal succeeded and producer exclusively publishes reclaimed capacity.
            unsafe {
                (*slot).reservation_len.store(0, Ordering::Relaxed);
                (*slot).completion_sequence.store(0, Ordering::Relaxed);
                (*slot).state.store(SLOT_FREE, Ordering::Release);
            }
        }
        let new_reclaimed = reclaimed
            .checked_add(run_len)
            .ok_or(RingError::ArithmeticOverflow)?;
        // SAFETY: capacity becomes visible only after every removal succeeds.
        unsafe {
            (*reclaim)
                .arena_reclaimed
                .store(new_reclaimed, Ordering::Release);
            (*reclaim).completed.store(last, Ordering::Release);
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
        if let Err(error) = self.signal_wake(self.data_wake_ptr(), &self.data_ready) {
            self.enter_quarantine();
            return Err(ProducerError::Ring(error));
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

    /// Number of reserved spans. commentlint: allow(JUDGE)
    pub const fn segment_count(&self) -> usize {
        self.plan.span_count() as usize
    }

    /// Returns one reserved span. commentlint: allow(JUDGE)
    pub fn segment(&self, index: usize) -> Result<Option<LeaseSpan<'_>>, ProducerError> {
        let Some(span) = self.plan.span(index) else {
            return Ok(None);
        };
        // SAFETY: reservation keeps ring mapping and arena range live.
        unsafe { self.ring.lease_span(span) }
            .map(Some)
            .map_err(ProducerError::Ring)
    }

    /// Advances cursor after writes into reserved spans. commentlint: allow(JUDGE)
    pub fn advance(&mut self, bytes: usize) -> Result<(), ProducerError> {
        if self.finished {
            return Err(ProducerError::Aborted);
        }
        let Some(cursor) = self.cursor.checked_add(bytes) else {
            self.ring.abort_reservation(self.sequence);
            self.finished = true;
            return Err(ProducerError::Overflow);
        };
        if cursor > self.capacity() {
            self.ring.abort_reservation(self.sequence);
            self.finished = true;
            return Err(ProducerError::Overflow);
        }
        self.cursor = cursor;
        Ok(())
    }

    /// Sets the wire header that commit validates against exact body length. commentlint: allow(JUDGE)
    pub fn set_wire_header(
        &mut self,
        wire_header: [u8; WIRE_V2_HEADER_BYTES],
    ) -> Result<(), ProducerError> {
        if self.finished {
            return Err(ProducerError::Aborted);
        }
        self.wire_header = wire_header;
        Ok(())
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

impl std::error::Error for ProducerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Arena(error) => Some(error),
            Self::Ring(error) => Some(error),
            _ => None,
        }
    }
}

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
    /// Eventfd creation, wait, read, or write failed.
    DoorbellFailed,
    /// Sparse page removal failed.
    PageRemovalFailed,
    /// Release sequence would wrap.
    SequenceExhausted,
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
            Self::DoorbellFailed => "ring doorbell failed",
            Self::PageRemovalFailed => "shared arena page removal failed",
            Self::SequenceExhausted => "release sequence exhausted",
            Self::Quarantined => "transport storage is quarantined",
            Self::Descriptor(_) => "shared descriptor validation failed",
            Self::Lease(_) => "receive lease construction failed",
        })
    }
}

impl std::error::Error for RingError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Descriptor(error) => Some(error),
            Self::Lease(error) => Some(error),
            _ => None,
        }
    }
}

fn initialize_mapping(
    mapping: &Mapping,
    layout: Layout,
    grant: RingGrant,
) -> Result<(), RingError> {
    let producer = mapping.ptr_at::<ProducerPage>(layout.producer)?;
    let consumer = mapping.ptr_at::<ConsumerPage>(layout.consumer)?;
    let reclaim = mapping.ptr_at::<ReclaimPage>(layout.reclaim)?;
    let data_wake = mapping.ptr_at::<WakeEpoch>(layout.data_wake)?;
    let capacity_wake = mapping.ptr_at::<WakeEpoch>(layout.capacity_wake)?;
    // SAFETY: fresh mapping is exclusively initialized before publication.
    unsafe {
        producer.write(ProducerPage {
            published: AtomicU64::new(0),
            arena_write: AtomicU64::new(0),
        });
        consumer.write(ConsumerPage {
            consumed: AtomicU64::new(0),
            active_leases: AtomicU64::new(0),
        });
        reclaim.write(ReclaimPage {
            completed: AtomicU64::new(0),
            arena_reclaimed: AtomicU64::new(0),
        });
        data_wake.write(WakeEpoch {
            generation: AtomicU64::new(0),
            parked: AtomicU64::new(0),
        });
        capacity_wake.write(WakeEpoch {
            generation: AtomicU64::new(0),
            parked: AtomicU64::new(0),
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

fn validate_object(fd: &OwnedFd, expected_len: usize) -> Result<(), RingError> {
    // SAFETY: zeroed stat is valid output storage for fstat.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: fd is owned and stat points to writable storage.
    if unsafe { libc::fstat(fd.as_raw_fd(), &mut stat) } != 0 {
        return Err(RingError::ObjectValidationFailed);
    }
    // SAFETY: geteuid has no preconditions.
    let current_uid = unsafe { libc::geteuid() };
    #[cfg(target_os = "linux")]
    let type_valid = stat.st_mode & libc::S_IFMT == libc::S_IFREG;
    // Darwin POSIX shared-memory descriptors do not provide a portable
    // regular-file type bit. Size, owner, permissions, and ring identity
    // validate the unlinked object instead.
    #[cfg(target_os = "macos")]
    let type_valid = true;
    if stat.st_uid != current_uid
        || stat.st_size < 0
        || stat.st_size as usize != expected_len
        || !type_valid
        || stat.st_mode & 0o077 != 0
    {
        return Err(RingError::ObjectValidationFailed);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn validate_seals(fd: &OwnedFd) -> Result<(), RingError> {
    // SAFETY: F_GET_SEALS reads flags from an owned valid descriptor.
    let seals = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GET_SEALS) };
    let required = libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
    if seals < 0 || seals & required != required {
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
    // Darwin limits POSIX shared-memory names to 31 bytes. Prefix plus 80 bits
    // of random identity remains below that limit; O_EXCL rejects collisions.
    let mut random = [0u8; 10];
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
            libc::O_CREAT | libc::O_EXCL | libc::O_RDWR,
            0o600,
        )
    };
    if raw < 0 {
        return Err(RingError::ObjectSetupFailed);
    }
    // SAFETY: successful shm_open returns newly owned descriptor.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    // macOS rejects O_CLOEXEC in shm_open flags, so a fork+exec racing
    // fcntl can inherit the descriptor. Set FD_CLOEXEC immediately after
    // shm_open to minimize that inheritance window.
    // SAFETY: fd is owned and F_SETFD changes only its descriptor flags.
    let cloexec = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) };
    // An un-unlinked name persists in the kernel until reboot, so the unlink runs before either result is reported. commentlint: allow(JUDGE)
    // SAFETY: name.as_ptr() remains valid for the call; shm_unlink removes the name immediately.
    let unlinked = unsafe { libc::shm_unlink(name.as_ptr()) };
    if cloexec < 0 || unlinked != 0 {
        return Err(RingError::ObjectSetupFailed);
    }
    let len = libc::off_t::try_from(len).map_err(|_| RingError::ArithmeticOverflow)?;
    // SAFETY: fd remains owned here and len was checked for off_t conversion.
    if unsafe { libc::ftruncate(fd.as_raw_fd(), len) } != 0 {
        return Err(RingError::ObjectSetupFailed);
    }
    Ok(fd)
}

#[cfg(test)]
mod tests {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::sync::atomic::Ordering;

    use crate::descriptor::HardwareProfileId;
    use crate::profile::ring_profile;

    use super::{
        removal_ranges, residency_vector_len, wire_v2_header, Doorbell, ProducerError, Ring,
        RingError, FAIL_NEXT_PAGE_REMOVAL,
    };

    fn ring() -> Ring {
        let profile = ring_profile(HardwareProfileId::new("ring-reclaim-test").unwrap()).unwrap();
        Ring::create(&profile, 99).unwrap()
    }

    fn publish(ring: &Ring, bytes: &[u8]) {
        let mut reservation = ring
            .try_reserve(bytes.len(), wire_v2_header(bytes.len()).unwrap())
            .unwrap();
        reservation.write(bytes).unwrap();
        reservation.commit(bytes.len()).unwrap();
    }

    #[test]
    fn doorbell_attachment_requires_nonblocking_eventfd() {
        // SAFETY: eventfd returns a fresh owned descriptor on success.
        let blocking = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC) };
        assert!(blocking >= 0);
        // SAFETY: the successful eventfd result transfers ownership here.
        let blocking = unsafe { OwnedFd::from_raw_fd(blocking) };
        assert!(matches!(
            Doorbell::from_fd(blocking),
            Err(RingError::DoorbellFailed)
        ));

        let non_eventfd: OwnedFd = std::fs::File::open("/dev/null").unwrap().into();
        // SAFETY: F_SETFL updates status flags on this live owned descriptor.
        assert_eq!(
            unsafe { libc::fcntl(non_eventfd.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK,) },
            0
        );
        assert!(matches!(
            Doorbell::from_fd(non_eventfd),
            Err(RingError::DoorbellFailed)
        ));
    }

    #[test]
    fn residency_vector_tracks_runtime_page_size() {
        let mapping_len = 128 * 1024 + 1;
        assert_eq!(residency_vector_len(mapping_len, 16 * 1024), 9);
        assert_eq!(residency_vector_len(mapping_len, 64 * 1024), 3);
    }

    #[test]
    fn removal_ranges_exclude_partial_pages_and_split_once_at_wrap() {
        for page in [4 * 1024, 16 * 1024, 64 * 1024] {
            let arena = page * 4;
            assert_eq!(
                removal_ranges(page, arena, 1, (page * 3 - 2) as u64, page).unwrap(),
                [(page, page * 2), (0, 0)]
            );
            assert_eq!(
                removal_ranges(page, arena, (arena - page) as u64, (page * 2) as u64, page)
                    .unwrap(),
                [(page * 4, page), (page, page)]
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reclaimed_pages_leave_residency_and_reuse_as_zeroes() {
        let ring = ring();
        let arena_len = ring.arena_bytes();
        publish(&ring, &vec![0xa5; arena_len]);
        ring.try_receive().unwrap().unwrap().release().unwrap();
        assert!(ring.resident_arena_pages().unwrap() > 0);

        let reservation = ring
            .try_reserve(arena_len, wire_v2_header(arena_len).unwrap())
            .unwrap();
        assert_eq!(ring.resident_arena_pages().unwrap(), 0);
        let segment = reservation.segment(0).unwrap().unwrap();
        assert_eq!(segment.read_byte(0), Some(0));
        assert_eq!(segment.read_byte(segment.len() - 1), Some(0));
        reservation.abort();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn repeated_subpage_releases_eventually_remove_complete_pages() {
        let ring = ring();
        let page = super::system_page_size();
        assert!(page >= 256 && page.is_multiple_of(256));

        for index in 0..page / 256 {
            publish(&ring, &[index as u8; 256]);
            ring.try_receive().unwrap().unwrap().release().unwrap();
            ring.try_reserve(0, wire_v2_header(0).unwrap())
                .unwrap()
                .abort();
            let expected = usize::from(index + 1 < page / 256);
            assert_eq!(ring.resident_arena_pages().unwrap(), expected);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn partial_page_reclaim_preserves_live_neighbor() {
        let ring = ring();
        publish(&ring, &[0x11; 256]);
        publish(&ring, &[0x22; 256]);
        let first = ring.try_receive().unwrap().unwrap();
        let second = ring.try_receive().unwrap().unwrap();
        first.release().unwrap();

        ring.try_reserve(0, wire_v2_header(0).unwrap())
            .unwrap()
            .abort();
        assert_eq!(second.segment(0).unwrap().read_byte(0), Some(0x22));
        assert_eq!(second.segment(0).unwrap().read_byte(255), Some(0x22));
        second.release().unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn page_removal_failure_quarantines_before_capacity_publication() {
        let ring = ring();
        let page = super::system_page_size();
        publish(&ring, &vec![1; page]);
        ring.try_receive().unwrap().unwrap().release().unwrap();
        FAIL_NEXT_PAGE_REMOVAL.store(true, Ordering::Release);

        assert!(matches!(
            ring.try_reserve(0, wire_v2_header(0).unwrap()),
            Err(ProducerError::Ring(RingError::PageRemovalFailed))
        ));
        assert!(ring.is_quarantined());
        let reclaim = ring.reclaim_ptr().unwrap();
        // SAFETY: test-owned ring keeps reclaim page mapped.
        unsafe {
            assert_eq!((*reclaim).completed.load(Ordering::Acquire), 0);
            assert_eq!((*reclaim).arena_reclaimed.load(Ordering::Acquire), 0);
        }
    }
}
