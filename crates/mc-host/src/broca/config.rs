//! Broca's fixed capacity contract (R12-R13).
//!
//! Every cap here is a named constant rather than deployment configuration:
//! the product contract pins these numbers so producers, the host's resource
//! declaration, and the run supervisor can never disagree about them.
//! [`BrocaLimits::default`] mirrors them one-to-one; tests may shrink a
//! limit through [`BrocaLimits`] but production always uses the defaults.

use std::time::Duration;

/// Largest accepted request body (R6/R12): a `session.send` at exactly this
/// size is admitted and the first byte beyond it is rejected before any run
/// state exists.
pub const MAX_SEND_BODY_BYTES: usize = 512 * 1024;

/// Largest inline `OPENCODE_CONFIG_CONTENT` document the OpenCode adapter
/// passes as one environment string. Linux caps a single argv/env string at
/// MAX_ARG_STRLEN (32 pages ≈ 128 KiB); exceeding it fails exec(2) with
/// E2BIG, an opaque permanent spawn error. 96 KiB leaves envelope headroom
/// under that kernel limit. A contract-valid send under
/// [`MAX_SEND_BODY_BYTES`] can still carry a `system` prompt too large for
/// this ceiling; the adapter rejects such runs with a structured message
/// naming the bound instead of letting exec fail opaquely.
pub const MAX_OPENCODE_CONFIG_BYTES: usize = 96 * 1024;

/// Per-run retained replay cap, including the terminal headroom (R12), so a
/// run that fills its replay can still record exactly one terminal unit.
pub const MAX_RUN_REPLAY_BYTES: usize = 1024 * 1024;

/// Slice of [`MAX_RUN_REPLAY_BYTES`] reserved at admission for the
/// `run_started` unit and one terminal unit. Charged with the run's base
/// reservation so a terminal append can never fail on budget pressure —
/// otherwise an overflowing run could not record the failure that stopped it.
pub const TERMINAL_HEADROOM_BYTES: usize = 4096;

/// Aggregate retained-data budget (R12): immutable request bytes, replay
/// allocation, session and run keys, and tombstone metadata all draw on this
/// one accounting bound. The supervisor enforces exactly this amount.
pub const MAX_RETAINED_BYTES: u64 = 64 * 1024 * 1024;

/// Most Broca routes bound at once. The route-identity headroom below is
/// declared from this constant, so the component enforces it at bind time
/// regardless of the host's configured `max_routes` — an operator raising
/// that host limit cannot silently grow Broca's retained identities past
/// the declared reservation.
pub const MAX_BOUND_ROUTES: usize = 1024;

/// Worst case for the component's route-identity map, which lives outside
/// the supervisor's budget: [`MAX_BOUND_ROUTES`] bound identities, each a
/// project root of up to 4096 bytes plus a session of up to 256 bytes, with
/// 128 bytes of key overhead. Declared to the host on top of
/// [`MAX_RETAINED_BYTES`] so the published reservation remains an actual
/// ceiling on resident bytes.
pub const ROUTE_IDENTITY_HEADROOM_BYTES: u64 = (MAX_BOUND_ROUTES as u64) * (4096 + 256 + 128);

/// Worst case for live backend transcript capture, also outside the
/// supervisor's budget: each of the [`MAX_BACKEND_PROCESSES`] concurrent
/// subprocesses buffers up to 4 MiB of stdout plus 64 KiB of stderr (the
/// subprocess capture bounds). Transcript parsing holds up to four more
/// transcript-sized values at once on the worst path — the owned JSON value
/// deserialized from a line, the extracted message text, the lowercase copy
/// the failure classifier scans, and a pathological all-digit retry-delay
/// scan — hence the factor of five. One extra request body per backend
/// covers the original the Pi provider-fallback wrapper retains across its
/// aliased first attempt. Declared alongside the retained budget for the
/// same reason as [`ROUTE_IDENTITY_HEADROOM_BYTES`].
pub const BACKEND_CAPTURE_HEADROOM_BYTES: u64 = (MAX_BACKEND_PROCESSES as u64)
    * ((4 * 1024 * 1024 + 64 * 1024) * 5 + MAX_SEND_BODY_BYTES as u64);

/// Worst case for deletion tombstones installed UNCHARGED when the retained
/// budget is exhausted at the delete/eviction race: every such tombstone
/// still counts toward [`MAX_TERMINAL_SESSIONS`], so at most that many
/// session keys (each charged at the `meta_bytes` worst case — three
/// identity copies plus overhead) can sit outside the charged budget until
/// they expire or the cap evicts them. Declared alongside the retained
/// budget for the same reason as [`ROUTE_IDENTITY_HEADROOM_BYTES`].
pub const DELETION_TOMBSTONE_HEADROOM_BYTES: u64 =
    (MAX_TERMINAL_SESSIONS as u64) * ((4096 + 256) * 3 + 128);

/// Ceiling on the daemon-startup environment this component will capture.
///
/// An inherited environment has no platform-fixed size: Linux bounds one exec
/// payload at a quarter of `RLIMIT_STACK`, which a raised stack limit pushes
/// well past the conventional 2 MiB. A declaration can therefore only be a
/// true ceiling if the capture itself is bounded, so a larger environment
/// fails startup with a named limit rather than silently pushing the
/// component past what the host subtracted from ingress. Rejecting beats
/// truncating: dropping variables would silently remove provider
/// credentials.
///
/// Sized to leave exec headroom UNDER the conventional 2 MiB limit rather
/// than to consume it: a child's payload is this snapshot plus the adapter's
/// own variables — up to [`MAX_OPENCODE_CONFIG_BYTES`] of inline config, the
/// generation and identity controls — plus argv. Accepting a snapshot that
/// only the daemon itself could exec would start a host on which every run
/// fails `E2BIG`.
pub const MAX_ENV_SNAPSHOT_BYTES: usize = 1536 * 1024;

/// Per-variable charge added to the string bytes when a snapshot is
/// admitted against [`MAX_ENV_SNAPSHOT_BYTES`].
///
/// Counting string bytes alone would let an environment of many short
/// variables pass the ceiling while each representation of it pays a
/// per-entry container cost the ceiling never saw: the retained and
/// adapter vectors hold two `OsString` headers (48 bytes on 64-bit) plus
/// two heap allocations per entry, `Command`'s map adds its ordering
/// nodes, and the exec-ready array adds a pointer and a `CString`
/// allocation per `NAME=VALUE\0`. 128 bytes dominates each of those
/// shapes, so the charged sum — not just the character data — is what
/// every simultaneous representation stays under, and
/// [`ENV_SNAPSHOT_HEADROOM_BYTES`] remains a real peak bound.
pub const ENV_ENTRY_OVERHEAD_BYTES: usize = 128;

/// Bytes each ADAPTER adds to a spawn's child environment beyond the
/// captured snapshot. The OpenCode inline config (`OPENCODE_CONFIG_CONTENT`,
/// up to [`MAX_OPENCODE_CONFIG_BYTES`]) dominates; the database path, the
/// project-config kill switch, the child marker, and Pi's model, thinking,
/// and token/temperature controls ride in the slack. These variables live
/// in the same three per-spawn representations as the snapshot itself, so
/// they multiply by the same factor in the declared headroom.
pub const ADAPTER_ENV_HEADROOM_BYTES: u64 = MAX_OPENCODE_CONFIG_BYTES as u64 + 8 * 1024;

/// Worst case for the environment snapshot and every simultaneous
/// representation of it during a spawn.
///
/// One copy is retained for the component's lifetime (captured once, shared
/// behind an `Arc`). Each concurrent spawn holds three more at its peak: the
/// adapter's assembled child environment, the `Command`'s own map, and the
/// exec-ready C-string array `spawn` materializes in the parent — the
/// `pre_exec` hook forces the fork path, so that last one is real. All three
/// are freed as soon as the child exists, and all three carry the adapter's
/// own additions ([`ADAPTER_ENV_HEADROOM_BYTES`]) on top of the snapshot.
/// Each representation's container overhead is covered because admission
/// charges [`ENV_ENTRY_OVERHEAD_BYTES`] per variable against the same
/// ceiling. Declared alongside the retained budget for the same reason as
/// [`ROUTE_IDENTITY_HEADROOM_BYTES`].
pub const ENV_SNAPSHOT_HEADROOM_BYTES: u64 = (1 + 3 * MAX_BACKEND_PROCESSES as u64)
    * MAX_ENV_SNAPSHOT_BYTES as u64
    + 3 * MAX_BACKEND_PROCESSES as u64 * ADAPTER_ENV_HEADROOM_BYTES;

/// The complete retained-byte reservation the component declares to the
/// host: the supervisor's enforced budget plus the retention classes that
/// live outside it. The host subtracts this whole amount from ingress,
/// so anything sizing ingress headroom around Broca must use this sum, not
/// [`MAX_RETAINED_BYTES`] alone.
pub const DECLARED_RETAINED_RESIDENT_BYTES: u64 = MAX_RETAINED_BYTES
    + ROUTE_IDENTITY_HEADROOM_BYTES
    + BACKEND_CAPTURE_HEADROOM_BYTES
    + DELETION_TOMBSTONE_HEADROOM_BYTES
    + ENV_SNAPSHOT_HEADROOM_BYTES;

/// Most sessions retained in a terminal or deletion-tombstone state (R12);
/// beyond it the oldest eligible entry is evicted.
pub const MAX_TERMINAL_SESSIONS: usize = 256;

/// How long terminal replay and deletion tombstones stay resident (R12);
/// after this an entry reports `missing` and its charges are released.
pub const TERMINAL_RETENTION: Duration = Duration::from_secs(15 * 60);

/// Most queued-plus-running runs at once (R13); run 33 fails before any
/// index entry exists.
pub const MAX_ACTIVE_RUNS: usize = 32;

/// Most concurrent non-subscription command callbacks (R13).
pub const MAX_COMMAND_CALLBACKS: usize = 32;

/// Most concurrent subscribers on one run (R13).
pub const MAX_SUBSCRIBERS_PER_RUN: usize = 2;

/// Most concurrent subscribers across every run (R13).
pub const MAX_TOTAL_SUBSCRIBERS: usize = 64;

/// Most concurrently executing backends (R13). Admitted runs beyond this
/// queue in `queued` state until a permit frees.
pub const MAX_BACKEND_PROCESSES: usize = 8;

/// Pending-request slots the module reserves from the host (R13); paired
/// with [`RESERVED_HANDLER_TASKS`] so saturated Broca work can never consume
/// a general admission slot.
pub const RESERVED_PENDING_REQUESTS: usize = 96;

/// Handler-task slots the module reserves from the host (R13).
pub const RESERVED_HANDLER_TASKS: usize = 96;

/// Upper bound on `generation.max_output_tokens` (R6). Providers clamp to
/// their own per-model ceilings, so this only rejects nonsensical requests
/// rather than modeling any provider.
pub const MAX_OUTPUT_TOKENS_BOUND: u64 = 1_000_000;

/// Inclusive `generation.temperature` range (R6), matching the common
/// provider convention.
pub const TEMPERATURE_RANGE: std::ops::RangeInclusive<f64> = 0.0..=2.0;

/// Supervisor capacities, defaulting to the fixed product-contract caps.
///
/// Exists so deterministic tests can exercise eviction, overflow, and
/// saturation without materializing megabytes or hundreds of sessions; the
/// component itself always runs `BrocaLimits::default()`.
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
