#[cfg(target_os = "linux")]
use std::collections::HashSet;
use std::fmt;
use std::sync::{Arc, Mutex};

use crate::arena::MIN_ARENA_BYTES;
use crate::descriptor::{HardwareProfileId, TransportDescriptor, MAX_SPANS};

/// Producer arbitration topology.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProducerTopology {
    /// Caller owns one SPSC producer lane.
    CallerConfined,
    /// Each producer owns one SPSC lane and receiver merges ordering.
    ShardedSpsc,
    /// Producers arbitrate access before one publication lane.
    Arbitrated,
}

/// Worker ownership topology.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkerTopology {
    /// Caller publishes and receives directly.
    CallerThread,
    /// One worker owns each direction.
    SplitDirection,
    /// One worker owns both directions.
    Fused,
}

/// Completion delivery topology.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompletionMode {
    /// Caller synchronously pulls completions.
    SynchronousPull,
    /// Caller polls completion batches.
    BatchedPoll,
    /// Runtime callback delivers promise completion.
    TsfnPromise,
}

/// Resource charges retained for one admitted duplex candidate.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ResourceCharges {
    /// Descriptors across both directions.
    pub descriptors: u64,
    /// Payload bytes across both directions.
    pub arena_bytes: u64,
    /// Maximum spans in one frame.
    pub spans_per_frame: u64,
    /// Receive leases across both directions.
    pub leases: u64,
    /// Shared mappings.
    pub mappings: u64,
    /// File descriptors retaining shared mappings.
    pub file_descriptors: u64,
    /// Dedicated endpoint workers.
    pub workers: u64,
    /// Process-level client instances.
    pub client_instances: u64,
    /// Dedicated workers for hot-active scheduling.
    pub pinned_workers: u64,
}

impl ResourceCharges {
    /// Empty resource commitment.
    pub const ZERO: Self = Self {
        descriptors: 0,
        arena_bytes: 0,
        spans_per_frame: 0,
        leases: 0,
        mappings: 0,
        file_descriptors: 0,
        workers: 0,
        client_instances: 0,
        pinned_workers: 0,
    };

    fn checked_add(self, other: Self) -> Option<Self> {
        Some(Self {
            descriptors: self.descriptors.checked_add(other.descriptors)?,
            arena_bytes: self.arena_bytes.checked_add(other.arena_bytes)?,
            spans_per_frame: self.spans_per_frame.max(other.spans_per_frame),
            leases: self.leases.checked_add(other.leases)?,
            mappings: self.mappings.checked_add(other.mappings)?,
            file_descriptors: self.file_descriptors.checked_add(other.file_descriptors)?,
            workers: self.workers.checked_add(other.workers)?,
            client_instances: self.client_instances.checked_add(other.client_instances)?,
            pinned_workers: self.pinned_workers.checked_add(other.pinned_workers)?,
        })
    }

    fn checked_sub(self, other: Self) -> Option<Self> {
        Some(Self {
            descriptors: self.descriptors.checked_sub(other.descriptors)?,
            arena_bytes: self.arena_bytes.checked_sub(other.arena_bytes)?,
            // A maximum, not a sum: release paths recompute it from the
            // per-admission span counts in `Accounting`.
            spans_per_frame: self.spans_per_frame,
            leases: self.leases.checked_sub(other.leases)?,
            mappings: self.mappings.checked_sub(other.mappings)?,
            file_descriptors: self.file_descriptors.checked_sub(other.file_descriptors)?,
            workers: self.workers.checked_sub(other.workers)?,
            client_instances: self.client_instances.checked_sub(other.client_instances)?,
            pinned_workers: self.pinned_workers.checked_sub(other.pinned_workers)?,
        })
    }
}

/// Inputs validated into an immutable target profile.
pub struct ProfileConfig {
    /// Immutable grant descriptor.
    pub descriptor: TransportDescriptor,
    /// Descriptor depth per direction.
    pub descriptor_depth: usize,
    /// Payload bytes per direction.
    pub arena_bytes: usize,
    /// Maximum spans per complete frame.
    pub max_spans: usize,
    /// Maximum outstanding receive leases per direction.
    pub max_leases: usize,
    /// Shared mappings charged by candidate.
    pub mappings: usize,
    /// Dedicated workers charged by hot profile.
    pub pinned_workers: usize,
    /// Producer ownership topology.
    pub producer_topology: ProducerTopology,
    /// Worker ownership topology.
    pub worker_topology: WorkerTopology,
    /// Completion delivery topology.
    pub completion_mode: CompletionMode,
}

/// Immutable admitted profile dimensions and bounds.
pub struct TargetProfile {
    descriptor: TransportDescriptor,
    descriptor_depth: usize,
    arena_bytes: usize,
    max_spans: usize,
    max_leases: usize,
    producer_topology: ProducerTopology,
    worker_topology: WorkerTopology,
    completion_mode: CompletionMode,
    charges: ResourceCharges,
}

impl TargetProfile {
    /// Validates a profile before any candidate object is created.
    pub fn new(config: ProfileConfig) -> Result<Self, ProfileError> {
        if config.descriptor.schema_version() != crate::descriptor::DESCRIPTOR_SCHEMA_VERSION {
            return Err(ProfileError::UnsupportedSchema);
        }
        if config.descriptor_depth == 0 {
            return Err(ProfileError::ZeroDescriptorDepth);
        }
        if config.arena_bytes < MIN_ARENA_BYTES {
            return Err(ProfileError::ArenaBelowMinimum);
        }
        if !(1..=MAX_SPANS).contains(&config.max_spans) {
            return Err(ProfileError::InvalidSpanLimit);
        }
        if config.max_leases == 0 || config.max_leases > config.descriptor_depth {
            return Err(ProfileError::InvalidLeaseLimit);
        }
        if config.mappings < 2 {
            return Err(ProfileError::InvalidMappingCharge);
        }
        if config.pinned_workers != 0 {
            return Err(ProfileError::InvalidWorkerCharge);
        }
        let descriptors = u64::try_from(config.descriptor_depth)
            .ok()
            .and_then(|value| value.checked_mul(2))
            .ok_or(ProfileError::ChargeOverflow)?;
        let arena_bytes = u64::try_from(config.arena_bytes)
            .ok()
            .and_then(|value| value.checked_mul(2))
            .ok_or(ProfileError::ChargeOverflow)?;
        let leases = u64::try_from(config.max_leases)
            .ok()
            .and_then(|value| value.checked_mul(2))
            .ok_or(ProfileError::ChargeOverflow)?;
        let charges = ResourceCharges {
            descriptors,
            arena_bytes,
            spans_per_frame: config.max_spans as u64,
            leases,
            mappings: config.mappings as u64,
            file_descriptors: (config.mappings as u64)
                .checked_add(4)
                .ok_or(ProfileError::ChargeOverflow)?,
            workers: match config.worker_topology {
                WorkerTopology::CallerThread => 0,
                WorkerTopology::SplitDirection => 2,
                WorkerTopology::Fused => 1,
            },
            client_instances: 1,
            pinned_workers: config.pinned_workers as u64,
        };

        Ok(Self {
            descriptor: config.descriptor,
            descriptor_depth: config.descriptor_depth,
            arena_bytes: config.arena_bytes,
            max_spans: config.max_spans,
            max_leases: config.max_leases,
            producer_topology: config.producer_topology,
            worker_topology: config.worker_topology,
            completion_mode: config.completion_mode,
            charges,
        })
    }

    /// Immutable transport descriptor.
    pub const fn descriptor(&self) -> &TransportDescriptor {
        &self.descriptor
    }

    /// Descriptor depth per direction.
    pub const fn descriptor_depth(&self) -> usize {
        self.descriptor_depth
    }

    /// Arena bytes per direction.
    pub const fn arena_bytes(&self) -> usize {
        self.arena_bytes
    }

    /// Maximum spans per frame.
    pub const fn max_spans(&self) -> usize {
        self.max_spans
    }

    /// Outstanding receive leases per direction.
    pub const fn max_leases(&self) -> usize {
        self.max_leases
    }

    /// Producer topology.
    pub const fn producer_topology(&self) -> ProducerTopology {
        self.producer_topology
    }

    /// Worker topology.
    pub const fn worker_topology(&self) -> WorkerTopology {
        self.worker_topology
    }

    /// Completion topology.
    pub const fn completion_mode(&self) -> CompletionMode {
        self.completion_mode
    }

    /// Host-wide admission charge.
    pub const fn charges(&self) -> ResourceCharges {
        self.charges
    }
}

impl fmt::Debug for TargetProfile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TargetProfile(<redacted>)")
    }
}

/// Explicit process-wide admission limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostLimits {
    /// Active plus quarantined descriptors.
    pub descriptors: u64,
    /// Active plus quarantined arena bytes.
    pub arena_bytes: u64,
    /// Active plus quarantined receive leases.
    pub leases: u64,
    /// Active plus quarantined mappings.
    pub mappings: u64,
    /// Active plus quarantined mapping descriptors.
    pub file_descriptors: u64,
    /// Active endpoint workers.
    pub workers: u64,
    /// Active plus quarantined process-level clients.
    pub client_instances: u64,
    /// Active pinned workers.
    pub pinned_workers: u64,
}

/// Physical-core count verified from Linux package/core topology.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VerifiedPhysicalCores(u64);

impl VerifiedPhysicalCores {
    /// Reads allowed logical CPUs and counts unique package/core pairs.
    #[cfg(target_os = "linux")]
    pub fn detect() -> Option<Self> {
        let allowed = allowed_linux_cpus()?;
        let mut physical = HashSet::new();
        for cpu in allowed {
            let root = format!("/sys/devices/system/cpu/cpu{cpu}/topology");
            let package: u64 = std::fs::read_to_string(format!("{root}/physical_package_id"))
                .ok()?
                .trim()
                .parse()
                .ok()?;
            let core: u64 = std::fs::read_to_string(format!("{root}/core_id"))
                .ok()?
                .trim()
                .parse()
                .ok()?;
            physical.insert((package, core));
        }
        (!physical.is_empty()).then_some(Self(physical.len() as u64))
    }

    /// macOS execution is qualified on a designated host; generic builds do not guess affinity.
    #[cfg(not(target_os = "linux"))]
    pub const fn detect() -> Option<Self> {
        None
    }

    /// Verified physical-core count.
    pub const fn get(self) -> u64 {
        self.0
    }
}

#[cfg(target_os = "linux")]
fn allowed_linux_cpus() -> Option<Vec<u32>> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let spec = status
        .lines()
        .find_map(|line| line.strip_prefix("Cpus_allowed_list:\t"))?;
    let mut cpus = Vec::new();
    for item in spec.split(',') {
        if let Some((start, end)) = item.split_once('-') {
            let start: u32 = start.parse().ok()?;
            let end: u32 = end.parse().ok()?;
            cpus.extend(start..=end);
        } else {
            cpus.push(item.parse().ok()?);
        }
    }
    Some(cpus)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Accounting {
    active: ResourceCharges,
    quarantined: ResourceCharges,
    // Active admissions per span charge; slot `i` counts admissions
    // charging `i + 1` spans. `active.spans_per_frame` is the maximum over
    // active admissions, so releasing one must recompute it from these
    // counts instead of subtracting.
    active_span_counts: [u64; MAX_SPANS],
}

impl Accounting {
    fn span_slot(spans: u64) -> Option<usize> {
        usize::try_from(spans)
            .ok()
            .and_then(|spans| spans.checked_sub(1))
            .filter(|slot| *slot < MAX_SPANS)
    }

    fn charge_spans(&mut self, spans: u64) {
        if let Some(slot) = Self::span_slot(spans) {
            self.active_span_counts[slot] = self.active_span_counts[slot].saturating_add(1);
        }
    }

    fn release_spans(&mut self, spans: u64) {
        if let Some(slot) = Self::span_slot(spans) {
            self.active_span_counts[slot] = self.active_span_counts[slot].saturating_sub(1);
        }
        self.active.spans_per_frame = self
            .active_span_counts
            .iter()
            .rposition(|count| *count > 0)
            .map_or(0, |slot| slot as u64 + 1);
    }
}

/// Observable aggregate admission counters without candidate identities.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AccountingSnapshot {
    /// Active charges.
    pub active: ResourceCharges,
    /// Quarantined charges. Pinned workers are always zero here.
    pub quarantined: ResourceCharges,
}

/// Process-wide admission authority.
pub struct AdmissionController {
    limits: HostLimits,
    accounting: Mutex<Accounting>,
}

impl AdmissionController {
    /// Creates an empty controller with explicit ceilings.
    pub const fn new(limits: HostLimits) -> Self {
        Self {
            limits,
            accounting: Mutex::new(Accounting {
                active: ResourceCharges::ZERO,
                quarantined: ResourceCharges::ZERO,
                active_span_counts: [0; MAX_SPANS],
            }),
        }
    }

    /// Checks candidate admission without changing accounting or creating resources.
    pub fn can_admit(
        &self,
        profile: &TargetProfile,
        physical_cores: Option<VerifiedPhysicalCores>,
    ) -> Result<(), AdmissionError> {
        let accounting = self
            .accounting
            .lock()
            .map_err(|_| AdmissionError::AccountingUnavailable)?;
        self.check_admission(*accounting, profile, physical_cores)
            .map(|_| ())
    }

    /// Charges candidate before mappings or workers are created.
    pub fn admit(
        self: &Arc<Self>,
        profile: &TargetProfile,
        physical_cores: Option<VerifiedPhysicalCores>,
    ) -> Result<Admission, AdmissionError> {
        let mut accounting = self
            .accounting
            .lock()
            .map_err(|_| AdmissionError::AccountingUnavailable)?;
        let active = self.check_admission(*accounting, profile, physical_cores)?;
        let charges = profile.charges();
        accounting.active = active;
        accounting.charge_spans(charges.spans_per_frame);
        Ok(Admission {
            controller: Arc::clone(self),
            charges,
            state: AdmissionState::Active,
        })
    }

    fn check_admission(
        &self,
        accounting: Accounting,
        profile: &TargetProfile,
        physical_cores: Option<VerifiedPhysicalCores>,
    ) -> Result<ResourceCharges, AdmissionError> {
        let requested = profile.charges();
        let active = accounting
            .active
            .checked_add(requested)
            .ok_or(AdmissionError::ChargeOverflow)?;
        let committed = active
            .checked_add(accounting.quarantined)
            .ok_or(AdmissionError::ChargeOverflow)?;
        if committed.descriptors > self.limits.descriptors {
            return Err(AdmissionError::DescriptorLimit);
        }
        if committed.arena_bytes > self.limits.arena_bytes {
            return Err(AdmissionError::ArenaByteLimit);
        }
        if committed.leases > self.limits.leases {
            return Err(AdmissionError::LeaseLimit);
        }
        if committed.mappings > self.limits.mappings {
            return Err(AdmissionError::MappingLimit);
        }
        if committed.file_descriptors > self.limits.file_descriptors {
            return Err(AdmissionError::FileDescriptorLimit);
        }
        if active.workers > self.limits.workers {
            return Err(AdmissionError::WorkerLimit);
        }
        if committed.client_instances > self.limits.client_instances {
            return Err(AdmissionError::ClientInstanceLimit);
        }
        let core_limit = physical_cores
            .map(VerifiedPhysicalCores::get)
            .unwrap_or(self.limits.pinned_workers)
            .min(self.limits.pinned_workers);
        if active.pinned_workers > core_limit {
            return Err(AdmissionError::PhysicalCoreBudgetExceeded);
        }
        Ok(active)
    }

    /// Returns redacted aggregate resource counters.
    pub fn snapshot(&self) -> Result<AccountingSnapshot, AdmissionError> {
        let accounting = self
            .accounting
            .lock()
            .map_err(|_| AdmissionError::AccountingUnavailable)?;
        Ok(AccountingSnapshot {
            active: accounting.active,
            quarantined: accounting.quarantined,
        })
    }

    fn release(&self, charges: ResourceCharges) {
        let Ok(mut accounting) = self.accounting.lock() else {
            return;
        };
        if let Some(active) = accounting.active.checked_sub(charges) {
            accounting.active = active;
            accounting.release_spans(charges.spans_per_frame);
        }
    }

    fn quarantine(&self, charges: ResourceCharges) -> Result<(), AdmissionError> {
        let mut accounting = self
            .accounting
            .lock()
            .map_err(|_| AdmissionError::AccountingUnavailable)?;
        accounting.active = accounting
            .active
            .checked_sub(charges)
            .ok_or(AdmissionError::AccountingUnavailable)?;
        accounting.release_spans(charges.spans_per_frame);
        let retained = ResourceCharges {
            workers: 0,
            pinned_workers: 0,
            ..charges
        };
        accounting.quarantined = accounting
            .quarantined
            .checked_add(retained)
            .ok_or(AdmissionError::ChargeOverflow)?;
        Ok(())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AdmissionState {
    Active,
    Released,
    Quarantined,
}

/// RAII admission charge returned before candidate setup.
#[must_use = "admission must remain alive while candidate resources exist"]
pub struct Admission {
    controller: Arc<AdmissionController>,
    charges: ResourceCharges,
    state: AdmissionState,
}

impl Admission {
    /// Releases all active charges after successful join.
    pub fn release(mut self) {
        self.controller.release(self.charges);
        self.state = AdmissionState::Released;
    }

    /// Retains bytes, descriptors, leases, and mappings until process teardown.
    pub fn quarantine(mut self) -> Result<QuarantineRecord, AdmissionError> {
        self.controller.quarantine(self.charges)?;
        self.state = AdmissionState::Quarantined;
        Ok(QuarantineRecord { _private: () })
    }
}

impl fmt::Debug for Admission {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Admission(<redacted>)")
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        if self.state == AdmissionState::Active {
            self.controller.release(self.charges);
            self.state = AdmissionState::Released;
        }
    }
}

/// Marker proving quarantined charges remain host-accounted.
pub struct QuarantineRecord {
    _private: (),
}

impl fmt::Debug for QuarantineRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("QuarantineRecord(<redacted>)")
    }
}

/// Invalid target profile.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ProfileError {
    /// Descriptor schema is unsupported.
    UnsupportedSchema,
    /// Descriptor depth is zero.
    ZeroDescriptorDepth,
    /// Arena cannot hold one legal maximum frame.
    ArenaBelowMinimum,
    /// Maximum span count is outside one through two.
    InvalidSpanLimit,
    /// Lease bound is zero or exceeds descriptor depth.
    InvalidLeaseLimit,
    /// Candidate does not charge both directional mappings.
    InvalidMappingCharge,
    /// Worker charge disagrees with scheduling mode.
    InvalidWorkerCharge,
    /// Resource charge arithmetic overflowed.
    ChargeOverflow,
}

impl fmt::Debug for ProfileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, formatter)
    }
}

impl fmt::Display for ProfileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::UnsupportedSchema => "target profile schema is unsupported",
            Self::ZeroDescriptorDepth => "descriptor depth is zero",
            Self::ArenaBelowMinimum => "arena is below protocol minimum",
            Self::InvalidSpanLimit => "span limit is invalid",
            Self::InvalidLeaseLimit => "lease limit is invalid",
            Self::InvalidMappingCharge => "mapping charge is invalid",
            Self::InvalidWorkerCharge => "worker charge is invalid",
            Self::ChargeOverflow => "profile resource charge overflow",
        })
    }
}

impl std::error::Error for ProfileError {}

/// Host-wide admission rejection.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AdmissionError {
    /// Physical-core topology could not be verified.
    PhysicalCoresUnverified,
    /// Active workers exceed verified or configured physical cores.
    PhysicalCoreBudgetExceeded,
    /// Descriptor commitment exceeds host limit.
    DescriptorLimit,
    /// Arena-byte commitment exceeds host limit.
    ArenaByteLimit,
    /// Lease commitment exceeds host limit.
    LeaseLimit,
    /// Mapping commitment exceeds host limit.
    MappingLimit,
    /// Mapping descriptor commitment exceeds host limit.
    FileDescriptorLimit,
    /// Active endpoint workers exceed host limit.
    WorkerLimit,
    /// Client instances exceed host limit.
    ClientInstanceLimit,
    /// Resource charge arithmetic overflowed.
    ChargeOverflow,
    /// Accounting lock was poisoned.
    AccountingUnavailable,
}

impl fmt::Debug for AdmissionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, formatter)
    }
}

impl fmt::Display for AdmissionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::PhysicalCoresUnverified => "physical-core topology is unverified",
            Self::PhysicalCoreBudgetExceeded => "physical-core budget exceeded",
            Self::DescriptorLimit => "host descriptor limit exceeded",
            Self::ArenaByteLimit => "host arena-byte limit exceeded",
            Self::LeaseLimit => "host lease limit exceeded",
            Self::MappingLimit => "host mapping limit exceeded",
            Self::FileDescriptorLimit => "host file-descriptor limit exceeded",
            Self::WorkerLimit => "host worker limit exceeded",
            Self::ClientInstanceLimit => "host client-instance limit exceeded",
            Self::ChargeOverflow => "host admission arithmetic overflow",
            Self::AccountingUnavailable => "host admission accounting unavailable",
        })
    }
}

impl std::error::Error for AdmissionError {}

/// Builds the fixed ring profile for tests and local tools.
pub fn ring_profile(hardware: HardwareProfileId) -> Result<TargetProfile, ProfileError> {
    TargetProfile::new(ProfileConfig {
        descriptor: TransportDescriptor::new(hardware),
        descriptor_depth: 32,
        arena_bytes: MIN_ARENA_BYTES,
        max_spans: 2,
        max_leases: 32,
        mappings: 2,
        pinned_workers: 0,
        producer_topology: ProducerTopology::CallerConfined,
        worker_topology: WorkerTopology::CallerThread,
        completion_mode: CompletionMode::SynchronousPull,
    })
}
