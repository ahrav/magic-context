//!
//! The product contract fixes these caps as constants rather than deployment configuration.
//! The product contract fixes these values so producers, host resource declarations, and the run supervisor use the same limits.
//! `BrocaLimits::default` mirrors these constants one-to-one.
//! Production uses `BrocaLimits` defaults; tests may lower limits through `BrocaLimits`.

use std::time::Duration;

/// A `session.send` at exactly `MAX_SEND_BODY_BYTES` is admitted; the first byte beyond it is rejected before any run state exists.
/// state exists.
pub const MAX_SEND_BODY_BYTES: usize = 512 * 1024;

/// The OpenCode adapter passes inline `OPENCODE_CONFIG_CONTENT` as one environment string.
/// Linux limits each argv or environment string to `MAX_ARG_STRLEN` (32 pages, approximately 128 KiB); exceeding it makes `exec(2)` fail with `E2BIG`.
/// 96 KiB leaves envelope headroom below `MAX_ARG_STRLEN`.
/// A send within `MAX_SEND_BODY_BYTES` can contain a `system` prompt exceeding this limit.
/// The adapter rejects runs whose `system` prompt exceeds `MAX_OPENCODE_CONFIG_BYTES` with a structured message naming that bound.
/// The adapter rejects oversized configuration before `exec(2)` can fail with `E2BIG`.
pub const MAX_OPENCODE_CONFIG_BYTES: usize = 96 * 1024;

/// `MAX_RUN_REPLAY_BYTES` includes terminal headroom so a full replay can record one terminal unit.
pub const MAX_RUN_REPLAY_BYTES: usize = 1024 * 1024;

/// Admission reserves part of `MAX_RUN_REPLAY_BYTES` for `run_started`, `harness_dispatch`, and one terminal unit.
/// The run's base reservation includes this headroom, so these appends cannot fail from budget pressure.
/// Without this reservation, an overflowing run could fail to record the error that stopped it.
/// Without this reservation, an admitted run could terminate before spawning.
pub const TERMINAL_HEADROOM_BYTES: usize = 4096;

/// Immutable request bytes, replay allocation, session and run keys, and tombstone metadata draw on `MAX_RETAINED_BYTES`.
/// The supervisor enforces `MAX_RETAINED_BYTES` as a single accounting bound.
pub const MAX_RETAINED_BYTES: u64 = 64 * 1024 * 1024;

/// Broca derives route-identity headroom from `MAX_BOUND_ROUTES` and enforces that limit at bind time.
/// Broca enforces `MAX_BOUND_ROUTES` even when the host configures a larger `max_routes` value.
/// Raising the host's `max_routes` cannot increase Broca's retained route identities beyond the declared reservation.
pub const MAX_BOUND_ROUTES: usize = 1024;

/// The route-identity map lives outside the supervisor budget.
/// At most [`MAX_BOUND_ROUTES`] route identities exist outside the supervisor budget.
/// Each route identity stores a project root of at most 4096 bytes and a session of at most 256 bytes.
/// Each route identity stores three provider fingerprints plus map and key overhead.
/// Each route stores provider fingerprints in a `BTreeMap`.
/// Heap strings and the outer `HashMap` slot add per-route cost.
/// The 1024-byte term covers `BTreeMap` and outer `HashMap` allocation overhead.
/// The host reserves this headroom in addition to [`MAX_RETAINED_BYTES`].
pub const ROUTE_IDENTITY_HEADROOM_BYTES: u64 =
    (MAX_BOUND_ROUTES as u64) * (4096 + 256 + 3 * (16 + 64) + 1024);

/// The live backend transcript headroom covers worst-case capture outside the supervisor budget.
/// Each concurrent subprocess buffers captured stdout and stderr outside the supervisor budget.
/// Each subprocess buffers at most 4 MiB of stdout and 64 KiB of stderr.
/// Transcript parsing can retain four additional transcript-sized values simultaneously.
/// The parser can retain an owned JSON value deserialized from a transcript line.
/// The parser can retain the extracted message text separately from the JSON value.
/// The failure classifier scans a lowercase copy of the message text.
/// These five simultaneous transcript-sized allocations justify the factor of five.
/// The host reserves this headroom in addition to the retained budget.
pub const BACKEND_CAPTURE_HEADROOM_BYTES: u64 = (MAX_BACKEND_PROCESSES as u64)
    * ((4 * 1024 * 1024 + 64 * 1024) * 5 + MAX_SEND_BODY_BYTES as u64);

/// This headroom covers deletion tombstones that are installed without retained-budget charges.
/// A delete/eviction race can install an uncharged tombstone after the retained budget is exhausted.
/// At most [`MAX_TERMINAL_SESSIONS`] tombstone session keys can exist because each counts toward that cap.
/// Each tombstone key can consume the `meta_bytes` worst case: three identity copies plus overhead.
/// Uncharged tombstone keys remain outside the retained budget until expiry or cap eviction.
/// The host reserves this headroom in addition to the retained budget.
pub const DELETION_TOMBSTONE_HEADROOM_BYTES: u64 =
    (MAX_TERMINAL_SESSIONS as u64) * ((4096 + 256) * 3 + 128);

/// [`MAX_ENV_SNAPSHOT_BYTES`] caps the environment captured at daemon startup.
///
/// Linux bounds each exec payload rather than the inherited environment itself.
/// On Linux, the exec-payload limit is derived from `RLIMIT_STACK`.
/// Only a bounded capture makes this limit a true environment-size ceiling.
/// Startup rejects larger environments instead of exceeding the host-reserved ingress budget.
/// Oversize environments fail startup with a named limit rather than exceed ingress headroom.
/// Startup rejects oversize environments rather than truncate variables.
/// Truncation can silently remove provider credentials.
/// credentials.
///
/// The 1536 KiB cap leaves 512 KiB below a 2 MiB exec-payload limit.
/// The child exec payload includes the snapshot, adapter variables, and argv.
/// The child exec payload also includes generation and identity controls.
/// Startup rejects snapshots that would cause child execs to fail with `E2BIG`.
/// fails `E2BIG`.
pub const MAX_ENV_SNAPSHOT_BYTES: usize = 1536 * 1024;

///
/// Charging only string bytes would admit environments with many short variables without accounting for per-entry allocation costs.
/// `ENV_ENTRY_OVERHEAD_BYTES` charges each variable for container and allocation overhead beyond its string bytes.
pub const ENV_ENTRY_OVERHEAD_BYTES: usize = 128;

/// `OPENCODE_CONFIG_CONTENT` contributes at most [`MAX_OPENCODE_CONFIG_BYTES`] bytes to the child environment.
/// Each spawn materializes adapter variables in three child-environment representations.
/// `ADAPTER_ENV_HEADROOM_BYTES` is multiplied by three because each spawn holds three child-environment representations.
pub const ADAPTER_ENV_HEADROOM_BYTES: u64 = MAX_OPENCODE_CONFIG_BYTES as u64 + 8 * 1024;

///
/// Each concurrent spawn holds three additional snapshot representations at peak.
/// `spawn` materializes the exec-ready C-string array in the parent.
/// The three per-spawn representations are freed when the child exits.
/// Each per-spawn representation includes [`ADAPTER_ENV_HEADROOM_BYTES`] in addition to the snapshot.
/// Admission charges [`ENV_ENTRY_OVERHEAD_BYTES`] per variable against [`MAX_ENV_SNAPSHOT_BYTES`], covering each representation's container overhead.
/// [`ROUTE_IDENTITY_HEADROOM_BYTES`].
pub const ENV_SNAPSHOT_HEADROOM_BYTES: u64 = (1 + 3 * MAX_BACKEND_PROCESSES as u64)
    * MAX_ENV_SNAPSHOT_BYTES as u64
    + 3 * MAX_BACKEND_PROCESSES as u64 * ADAPTER_ENV_HEADROOM_BYTES;

/// The reservation includes the supervisor's enforced budget and retention classes outside that budget.
/// The host subtracts `DECLARED_RETAINED_RESIDENT_BYTES` from ingress headroom.
/// Ingress sizing around Broca must use `DECLARED_RETAINED_RESIDENT_BYTES`, not `MAX_RETAINED_BYTES` alone.
/// [`MAX_RETAINED_BYTES`] alone.
pub const DECLARED_RETAINED_RESIDENT_BYTES: u64 = MAX_RETAINED_BYTES
    + ROUTE_IDENTITY_HEADROOM_BYTES
    + BACKEND_CAPTURE_HEADROOM_BYTES
    + DELETION_TOMBSTONE_HEADROOM_BYTES
    + ENV_SNAPSHOT_HEADROOM_BYTES;

/// The supervisor retains at most 256 terminal or deletion-tombstone sessions.
/// Beyond 256 retained terminal or deletion-tombstone sessions, the supervisor evicts the oldest eligible entry.
pub const MAX_TERMINAL_SESSIONS: usize = 256;

/// The supervisor retains terminal replay and deletion tombstones for 15 minutes.
/// After 15 minutes, an expired entry reports `missing` and releases its charges.
pub const TERMINAL_RETENTION: Duration = Duration::from_secs(15 * 60);

/// The supervisor rejects the 33rd queued-or-running run before creating an index entry.
pub const MAX_ACTIVE_RUNS: usize = 32;

/// `MAX_COMMAND_CALLBACKS` limits concurrent non-subscription command callbacks to 32.
pub const MAX_COMMAND_CALLBACKS: usize = 32;

/// `MAX_SUBSCRIBERS_PER_RUN` limits each run to two concurrent subscribers.
pub const MAX_SUBSCRIBERS_PER_RUN: usize = 2;

pub const MAX_TOTAL_SUBSCRIBERS: usize = 64;

/// Runs admitted after all eight backend permits are occupied remain `queued` until a permit frees.
pub const MAX_BACKEND_PROCESSES: usize = 8;

/// The paired reservations prevent saturated Broca work from consuming a general admission slot.
pub const RESERVED_PENDING_REQUESTS: usize = 96;

pub const RESERVED_HANDLER_TASKS: usize = 96;

/// `MAX_OUTPUT_TOKENS_BOUND` rejects `generation.max_output_tokens` values above 1,000,000.
/// Providers enforce per-model ceilings separately from this bound.
pub const MAX_OUTPUT_TOKENS_BOUND: u64 = 1_000_000;

/// `TEMPERATURE_RANGE` accepts `generation.temperature` values from 0.0 through 2.0.
/// provider convention.
pub const TEMPERATURE_RANGE: std::ops::RangeInclusive<f64> = 0.0..=2.0;

/// `BrocaLimits::default()` uses the fixed product-contract capacities.
///
/// `BrocaLimits` lets deterministic tests exercise eviction, overflow, and saturation with smaller capacities.
#[derive(Debug, Clone)]
pub struct BrocaLimits {
    pub max_active_runs: usize,
    pub max_command_callbacks: usize,
    pub max_subscribers_per_run: usize,
    pub max_total_subscribers: usize,
    pub max_backend_processes: usize,
    pub max_run_replay_bytes: usize,
    pub max_retained_bytes: u64,
    pub max_terminal_sessions: usize,
    pub terminal_retention: Duration,
}

impl Default for BrocaLimits {
    fn default() -> Self {
        Self {
            max_active_runs: MAX_ACTIVE_RUNS,
            max_command_callbacks: MAX_COMMAND_CALLBACKS,
            max_subscribers_per_run: MAX_SUBSCRIBERS_PER_RUN,
            max_total_subscribers: MAX_TOTAL_SUBSCRIBERS,
            max_backend_processes: MAX_BACKEND_PROCESSES,
            max_run_replay_bytes: MAX_RUN_REPLAY_BYTES,
            max_retained_bytes: MAX_RETAINED_BYTES,
            max_terminal_sessions: MAX_TERMINAL_SESSIONS,
            terminal_retention: TERMINAL_RETENTION,
        }
    }
}
