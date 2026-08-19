//! Smart-note evaluation transition contract: the Rust port of the TypeScript
//! reducer in packages/plugin/src/features/magic-context/smart-notes/
//! (evaluation-state.ts, schedule.ts, storage.ts) plus the vendored 5-field
//! cron evaluator (dreamer/cron.ts). Both implementations replay the frozen
//! fixture crates/mc-module/testdata/smart-note-evaluation-golden.json, so
//! lifecycle behavior cannot drift between languages.
//!
//! Pure functions throughout: callers supply the pre-state, a phase-scoped
//! outcome, the transition clock, and a timezone (cron matching is a
//! wall-clock concept; production passes the machine-local zone).

use chrono::{Datelike, TimeZone, Timelike};
use serde::Deserialize;

/// Compiled-check policy version; other versions force recompilation.
pub const SMART_NOTE_CHECK_POLICY_VERSION: i64 = 1;
/// Minimum delay before the next check of a note.
pub const SMART_NOTE_CHECK_FLOOR_MS: i64 = 5 * 60 * 1000;
/// Maximum delay before the next check of a note.
pub const SMART_NOTE_CHECK_CEILING_MS: i64 = 24 * 60 * 60 * 1000;
/// Delay used when a note has no usable cron schedule.
pub const SMART_NOTE_CHECK_DEFAULT_INTERVAL_MS: i64 = 60 * 60 * 1000;
/// A check false for this long becomes eligible for a liveness recheck.
pub const SMART_NOTE_CHECK_MAX_STALENESS_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Minimum spacing between liveness recheck attempts.
pub const SMART_NOTE_CHECK_LIVENESS_RECHECK_MS: i64 = 24 * 60 * 60 * 1000;
/// Compile-phase selection cap per evaluation run.
pub const MAX_COMPILE_PER_RUN: usize = 5;
/// Fallback-phase selection cap per evaluation run.
pub const MAX_FALLBACK_PER_RUN: usize = 3;
/// Consecutive compilation failures before a note enters fallback.
pub const MAX_COMPILATION_FAILURES: i64 = 3;
/// Consecutive check failures before a compiled note needs reauthoring.
pub const MAX_FAILURES_BEFORE_REAUTHOR: i64 = 3;
/// Due-phase selection cap default.
pub const DEFAULT_MAX_DUE_CHECKS: usize = 10;

const MINUTE_MS: i64 = 60_000;
/// Forward search bound for cron next-occurrence (~4 years, covers Feb-29-only
/// crons). No occurrence within the bound means "never".
const MAX_SEARCH_MS: i64 = 4 * 366 * 24 * 60 * MINUTE_MS;

// ---------------------------------------------------------------------------
// Cron (port of dreamer/cron.ts, minus the civil-minute exclusion the
// smart-note path never uses)
// ---------------------------------------------------------------------------

/// Parsed 5-field cron: per-field membership bitmasks plus the Vixie
/// dom/dow restriction flags.
struct ParsedCron {
    minute: u64,
    hour: u64,
    dom: u64,
    month: u64,
    dow: u64,
    dom_restricted: bool,
    dow_restricted: bool,
}

fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// Parse one field into a membership bitmask, or `None` on error.
/// `dow_field` enables the 7→0 Sunday alias (after range validation, so `7`
/// is accepted but `8` is rejected).
fn parse_field(token: &str, min: u64, max: u64, dow_field: bool) -> Option<u64> {
    let mut mask = 0u64;
    for part in token.split(',') {
        let piece = part.trim();
        if piece.is_empty() {
            return None;
        }

        let mut split = piece.split('/');
        let range_part = split.next().unwrap_or_default();
        let step_part = split.next();
        if split.next().is_some() {
            return None;
        }
        let step = match step_part {
            Some(s) => {
                if !is_digits(s) {
                    return None;
                }
                let step: u64 = s.parse().ok()?;
                if step < 1 {
                    return None;
                }
                step
            }
            None => 1,
        };

        let (lo, hi) = if range_part == "*" {
            (min, max)
        } else if range_part.contains('-') {
            let mut bounds = range_part.split('-');
            let lo_str = bounds.next().unwrap_or_default();
            let hi_str = bounds.next().unwrap_or_default();
            if bounds.next().is_some() || !is_digits(lo_str) || !is_digits(hi_str) {
                return None;
            }
            (lo_str.parse().ok()?, hi_str.parse().ok()?)
        } else {
            if !is_digits(range_part) {
                return None;
            }
            let lo: u64 = range_part.parse().ok()?;
            // `a/step` (no upper bound) means a..max by step.
            let hi = if step_part.is_some() { max } else { lo };
            (lo, hi)
        };

        if lo < min || lo > max || hi < min || hi > max || lo > hi {
            return None;
        }

        let mut v = lo;
        while v <= hi {
            let normalized = if dow_field && v == 7 { 0 } else { v };
            mask |= 1u64 << normalized;
            // A wire-supplied step near u64::MAX would wrap `v` back under
            // `hi` and re-enter the loop; overflow means the range is done.
            let Some(next) = v.checked_add(step) else {
                break;
            };
            v = next;
        }
    }
    if mask == 0 {
        None
    } else {
        Some(mask)
    }
}

/// Parse a 5-field cron expression (`minute hour dom month dow`). Numeric
/// fields only; empty/whitespace input is rejected.
fn parse_cron(expression: &str) -> Option<ParsedCron> {
    let trimmed = expression.trim();
    if trimmed.is_empty() {
        return None;
    }
    let tokens: Vec<&str> = trimmed.split_whitespace().collect();
    if tokens.len() != 5 {
        return None;
    }
    Some(ParsedCron {
        minute: parse_field(tokens[0], 0, 59, false)?,
        hour: parse_field(tokens[1], 0, 23, false)?,
        dom: parse_field(tokens[2], 1, 31, false)?,
        month: parse_field(tokens[3], 1, 12, false)?,
        dow: parse_field(tokens[4], 0, 7, true)?,
        dom_restricted: tokens[2] != "*",
        dow_restricted: tokens[4] != "*",
    })
}

fn mask_has(mask: u64, value: u32) -> bool {
    (mask >> value) & 1 == 1
}

/// Vixie OR-semantics: when BOTH dom and dow are restricted, either may match.
fn matches_day(cron: &ParsedCron, dom_value: u32, dow_value: u32) -> bool {
    let dom = mask_has(cron.dom, dom_value);
    let dow = mask_has(cron.dow, dow_value);
    match (cron.dom_restricted, cron.dow_restricted) {
        (true, true) => dom || dow,
        (true, false) => dom,
        (false, true) => dow,
        (false, false) => true,
    }
}

/// First instant strictly after `after_ms` whose LOCAL civil time in `tz`
/// matches `cron`. Steps by epoch minutes and reads civil fields off each
/// candidate, so DST transitions are handled by construction. `None` if no
/// match within `after_ms + min(MAX_SEARCH_MS, max_search_ms)`.
fn next_occurrence<Tz: TimeZone>(
    cron: &ParsedCron,
    after_ms: i64,
    max_search_ms: i64,
    tz: &Tz,
) -> Option<i64> {
    let mut cursor_ms = after_ms
        .div_euclid(MINUTE_MS)
        .checked_mul(MINUTE_MS)?
        .checked_add(MINUTE_MS)?;
    let cap_ms = after_ms.saturating_add(max_search_ms.clamp(0, MAX_SEARCH_MS));
    while cursor_ms <= cap_ms {
        // An in-range instant maps to exactly one civil time; an instant
        // beyond chrono's representable date range maps to none, which ends
        // the search as "no occurrence" instead of panicking.
        let civil = tz.timestamp_millis_opt(cursor_ms).single()?;
        if mask_has(cron.minute, civil.minute())
            && mask_has(cron.hour, civil.hour())
            && mask_has(cron.month, civil.month())
            && matches_day(cron, civil.day(), civil.weekday().num_days_from_sunday())
        {
            return Some(cursor_ms);
        }
        cursor_ms = cursor_ms.checked_add(MINUTE_MS)?;
    }
    None
}

/// Parse + compute next-due epoch (ms) for a schedule string. `None` for
/// empty / invalid / effectively-never schedules.
fn next_due_at_ms<Tz: TimeZone>(
    expression: &str,
    after_ms: i64,
    max_search_ms: i64,
    tz: &Tz,
) -> Option<i64> {
    let cron = parse_cron(expression)?;
    next_occurrence(&cron, after_ms, max_search_ms, tz)
}

/// Whether a wire-submitted cron expression parses under this contract's
/// 5-field grammar.
pub fn is_valid_smart_note_cron(expression: &str) -> bool {
    parse_cron(expression).is_some()
}

// ---------------------------------------------------------------------------
// Schedule (port of smart-notes/schedule.ts)
// ---------------------------------------------------------------------------

/// Absolute epoch (ms) of the next check for a note: cron-driven delta (or
/// the default interval when the cron is absent/invalid/never), clamped to
/// [floor, ceiling], plus deterministic jitter, clamped again.
pub fn next_smart_note_check_due_at<Tz: TimeZone>(
    cron: Option<&str>,
    now: i64,
    note_id: i64,
    hash: Option<&str>,
    tz: &Tz,
) -> i64 {
    let raw_next = cron
        .filter(|c| !c.trim().is_empty())
        .and_then(|c| next_due_at_ms(c, now, SMART_NOTE_CHECK_CEILING_MS, tz))
        // The TS source treats a (unreachable) zero epoch as "no occurrence".
        .filter(|&ms| ms != 0);
    let raw_delta = match raw_next {
        Some(next) => next - now,
        None => SMART_NOTE_CHECK_DEFAULT_INTERVAL_MS,
    };
    let clamped = raw_delta.clamp(SMART_NOTE_CHECK_FLOOR_MS, SMART_NOTE_CHECK_CEILING_MS);
    let jittered = clamped + deterministic_jitter_ms(clamped, note_id, hash);
    let bounded = jittered.clamp(SMART_NOTE_CHECK_FLOOR_MS, SMART_NOTE_CHECK_CEILING_MS);
    now + bounded
}

/// FNV-1a-seeded jitter in [-max, +max] where max = min(60s, 10% of the
/// interval). The hash step mirrors JS exactly: u32 wrapping arithmetic over
/// UTF-16 code units, and `floor(interval * 0.1)` in binary floating point.
fn deterministic_jitter_ms(interval_ms: i64, note_id: i64, hash: Option<&str>) -> i64 {
    let max = 60_000i64.min((interval_ms as f64 * 0.1).floor() as i64);
    if max <= 0 {
        return 0;
    }
    let seed = format!("{note_id}:{}", hash.unwrap_or(""));
    let mut h: u32 = 2166136261;
    for unit in seed.encode_utf16() {
        h ^= u32::from(unit);
        h = h.wrapping_mul(16777619);
    }
    i64::from(h) % (max * 2 + 1) - max
}

// ---------------------------------------------------------------------------
// Reducer (port of smart-notes/evaluation-state.ts)
// ---------------------------------------------------------------------------

/// The lifecycle projection owned by this contract.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SmartNoteLifecycleState {
    pub status: String,
    pub ready_at: Option<i64>,
    pub ready_reason: Option<String>,
    pub last_checked_at: Option<i64>,
    pub updated_at: i64,
    pub compiled_check: Option<String>,
    pub manifest_json: Option<String>,
    pub check_hash: Option<String>,
    pub check_cron: Option<String>,
    pub check_version: i64,
    pub check_status: String,
    pub check_failure_count: i64,
    pub check_network_failure_count: i64,
    pub check_quarantined_until: Option<i64>,
    pub check_next_due_at: Option<i64>,
    pub check_compiled_at: Option<i64>,
    pub check_false_since_at: Option<i64>,
    pub check_last_liveness_at: Option<i64>,
    pub policy_version: i64,
}

/// Normalized compiler output recorded with its producing source revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledCheckArtifact {
    pub compiled_check: String,
    pub manifest_json: String,
    pub check_hash: String,
    pub check_cron: String,
}

/// Compile-phase result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompileOutcome {
    CompiledMet(CompiledCheckArtifact),
    CompiledFalse(CompiledCheckArtifact),
    CompilationFailed,
}

/// Due/liveness-phase result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckOutcome {
    Met,
    False,
    LogicFailed,
    NetworkFailed,
}

/// Fallback-phase result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FallbackOutcome {
    Met,
    False,
}

/// Phase-scoped outcome: a smuggled cross-phase result cannot type-check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SmartNoteEvaluationOutcome {
    Compile(CompileOutcome),
    Due(CheckOutcome),
    Liveness(CheckOutcome),
    Fallback(FallbackOutcome),
}

/// Result of one reduction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmartNoteReduction {
    pub next: SmartNoteLifecycleState,
    /// True when this transition surfaced the note (status became ready).
    pub surfaced: bool,
}

/// Backoff after the Nth consecutive failure: min(24h, 5 * 2^(N-1)) minutes.
pub fn evaluation_backoff_ms(failure_count: i64) -> i64 {
    // 5 * 2^9 already exceeds the 24h cap, so larger exponents can saturate.
    let exponent = (failure_count - 1).clamp(0, 9);
    let minutes = (24 * 60).min(5 << exponent);
    minutes * 60 * 1000
}

/// Host-derived ready reason for a due-phase met result: the manifest's first
/// signal, else its summary, else a fixed default; truncated to 240 units.
///
/// The bound is 240 UTF-16 code units, not 240 Unicode scalars, because the
/// TypeScript reducer this mirrors truncates with `String.prototype.slice`. For a
/// reason containing non-BMP characters the two counts differ, and this field is
/// persisted, so counting scalars here would let the two authorities store
/// different `ready_reason` values for the same note.
pub fn due_ready_reason(note_id: i64, manifest_json: Option<&str>) -> String {
    let signal = manifest_signal_or_summary(manifest_json)
        .unwrap_or_else(|| "compiled check returned met=true".to_string());
    truncate_utf16_units(&format!("Smart note #{note_id}: {signal}"), 240)
}

/// Truncate to at most `max_units` UTF-16 code units, matching JS `slice`.
/// A trailing lone surrogate (a split surrogate pair) is dropped rather than
/// emitted, since Rust `String` cannot hold an unpaired surrogate.
fn truncate_utf16_units(value: &str, max_units: usize) -> String {
    if value.chars().map(char::len_utf16).sum::<usize>() <= max_units {
        return value.to_string();
    }
    let mut used = 0usize;
    let mut out = String::new();
    for ch in value.chars() {
        let width = ch.len_utf16();
        if used + width > max_units {
            break;
        }
        used += width;
        out.push(ch);
    }
    out
}

/// Mirror of parseSmartNoteManifest for the fields the ready reason reads:
/// unparseable/absent JSON yields the empty manifest; `signals` keeps only
/// string entries and an all-invalid array is treated as absent.
fn manifest_signal_or_summary(manifest_json: Option<&str>) -> Option<String> {
    let json = manifest_json.filter(|j| !j.is_empty())?;
    let parsed: serde_json::Value = serde_json::from_str(json).ok()?;
    let signals: Option<Vec<&str>> = parsed.get("signals").and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(serde_json::Value::as_str)
            .collect::<Vec<_>>()
    });
    if let Some(first) = signals.and_then(|s| s.first().map(ToString::to_string)) {
        return Some(first);
    }
    parsed
        .get("summary")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn ready_fields(
    mut state: SmartNoteLifecycleState,
    reason: String,
    now: i64,
) -> SmartNoteLifecycleState {
    state.status = "ready".to_string();
    state.ready_at = Some(now);
    state.ready_reason = Some(reason);
    state.last_checked_at = Some(now);
    state.updated_at = now;
    state
}

fn false_fields<Tz: TimeZone>(
    mut state: SmartNoteLifecycleState,
    note_id: i64,
    now: i64,
    cron: Option<&str>,
    hash: Option<&str>,
    tz: &Tz,
) -> SmartNoteLifecycleState {
    state.last_checked_at = Some(now);
    state.updated_at = now;
    state.check_next_due_at = Some(next_smart_note_check_due_at(cron, now, note_id, hash, tz));
    state.check_failure_count = 0;
    state.check_network_failure_count = 0;
    state.check_false_since_at = state.check_false_since_at.or(Some(now));
    state
}

fn reduce_compile<Tz: TimeZone>(
    pre: &SmartNoteLifecycleState,
    outcome: &CompileOutcome,
    note_id: i64,
    now: i64,
    tz: &Tz,
) -> SmartNoteReduction {
    let artifact = match outcome {
        CompileOutcome::CompilationFailed => {
            let failure_count = pre.check_failure_count + 1;
            let mut next = pre.clone();
            next.check_failure_count = failure_count;
            next.check_status = if failure_count >= MAX_COMPILATION_FAILURES {
                "fallback".to_string()
            } else {
                "uncompiled".to_string()
            };
            next.check_next_due_at = Some(now + evaluation_backoff_ms(failure_count));
            next.updated_at = now;
            return SmartNoteReduction {
                next,
                surfaced: false,
            };
        }
        CompileOutcome::CompiledMet(artifact) | CompileOutcome::CompiledFalse(artifact) => artifact,
    };
    let next_due_at = next_smart_note_check_due_at(
        Some(&artifact.check_cron),
        now,
        note_id,
        Some(&artifact.check_hash),
        tz,
    );
    let mut stored = pre.clone();
    stored.compiled_check = Some(artifact.compiled_check.clone());
    stored.manifest_json = Some(artifact.manifest_json.clone());
    stored.check_hash = Some(artifact.check_hash.clone());
    stored.check_cron = Some(artifact.check_cron.clone());
    stored.check_version = 1;
    stored.check_status = "compiled".to_string();
    stored.check_failure_count = 0;
    stored.check_network_failure_count = 0;
    stored.check_quarantined_until = None;
    stored.check_next_due_at = Some(next_due_at);
    stored.check_compiled_at = Some(now);
    stored.check_false_since_at = pre.check_false_since_at.or(Some(now));
    stored.check_last_liveness_at = None;
    stored.policy_version = SMART_NOTE_CHECK_POLICY_VERSION;
    stored.updated_at = now;
    if matches!(outcome, CompileOutcome::CompiledMet(_)) {
        return SmartNoteReduction {
            next: ready_fields(
                stored,
                format!("Smart note #{note_id}: compiled check returned met=true"),
                now,
            ),
            surfaced: true,
        };
    }
    SmartNoteReduction {
        next: false_fields(
            stored,
            note_id,
            now,
            Some(&artifact.check_cron),
            Some(&artifact.check_hash),
            tz,
        ),
        surfaced: false,
    }
}

fn reduce_check_failure(
    pre: &SmartNoteLifecycleState,
    outcome: CheckOutcome,
    now: i64,
) -> SmartNoteLifecycleState {
    let mut next = pre.clone();
    if outcome == CheckOutcome::LogicFailed {
        let failure_count = pre.check_failure_count + 1;
        next.check_failure_count = failure_count;
        next.check_status = if failure_count >= MAX_FAILURES_BEFORE_REAUTHOR {
            "failing".to_string()
        } else {
            "compiled".to_string()
        };
        next.check_next_due_at = Some(now + evaluation_backoff_ms(failure_count));
        next.updated_at = now;
        return next;
    }
    let network_count = pre.check_network_failure_count + 1;
    let quarantined_until = now + evaluation_backoff_ms(network_count);
    next.check_network_failure_count = network_count;
    next.check_status = if network_count >= MAX_FAILURES_BEFORE_REAUTHOR {
        "failing".to_string()
    } else {
        "compiled".to_string()
    };
    next.check_next_due_at = Some(quarantined_until);
    next.check_quarantined_until = Some(quarantined_until);
    next.updated_at = now;
    next
}

fn reduce_due<Tz: TimeZone>(
    pre: &SmartNoteLifecycleState,
    outcome: CheckOutcome,
    note_id: i64,
    now: i64,
    tz: &Tz,
) -> SmartNoteReduction {
    match outcome {
        CheckOutcome::Met => SmartNoteReduction {
            next: ready_fields(
                pre.clone(),
                due_ready_reason(note_id, pre.manifest_json.as_deref()),
                now,
            ),
            surfaced: true,
        },
        CheckOutcome::False => SmartNoteReduction {
            next: false_fields(
                pre.clone(),
                note_id,
                now,
                pre.check_cron.as_deref(),
                pre.check_hash.as_deref(),
                tz,
            ),
            surfaced: false,
        },
        CheckOutcome::LogicFailed | CheckOutcome::NetworkFailed => SmartNoteReduction {
            next: reduce_check_failure(pre, outcome, now),
            surfaced: false,
        },
    }
}

fn reduce_liveness<Tz: TimeZone>(
    pre: &SmartNoteLifecycleState,
    outcome: CheckOutcome,
    note_id: i64,
    now: i64,
    tz: &Tz,
) -> SmartNoteReduction {
    let mut attempted = pre.clone();
    attempted.check_last_liveness_at = Some(now);
    attempted.updated_at = now;
    match outcome {
        CheckOutcome::Met => SmartNoteReduction {
            next: ready_fields(
                attempted,
                format!("Smart note #{note_id}: max-staleness liveness check returned met=true"),
                now,
            ),
            surfaced: true,
        },
        CheckOutcome::False => SmartNoteReduction {
            next: false_fields(
                attempted,
                note_id,
                now,
                pre.check_cron.as_deref(),
                pre.check_hash.as_deref(),
                tz,
            ),
            surfaced: false,
        },
        // Liveness runs a previously healthy compiled check; a logic error
        // here means the check itself broke, so reauthoring is immediate.
        CheckOutcome::LogicFailed => {
            attempted.check_status = "failing".to_string();
            SmartNoteReduction {
                next: attempted,
                surfaced: false,
            }
        }
        CheckOutcome::NetworkFailed => SmartNoteReduction {
            next: attempted,
            surfaced: false,
        },
    }
}

fn reduce_fallback(
    pre: &SmartNoteLifecycleState,
    outcome: FallbackOutcome,
    note_id: i64,
    now: i64,
) -> SmartNoteReduction {
    match outcome {
        FallbackOutcome::Met => SmartNoteReduction {
            next: ready_fields(
                pre.clone(),
                format!(
                    "Smart note #{note_id}: read-only confirmation evaluator returned met=true"
                ),
                now,
            ),
            surfaced: true,
        },
        FallbackOutcome::False => {
            let mut next = pre.clone();
            next.last_checked_at = Some(now);
            next.updated_at = now;
            next.check_status = "fallback".to_string();
            SmartNoteReduction {
                next,
                surfaced: false,
            }
        }
    }
}

/// Derive the complete next lifecycle state for one phase outcome.
pub fn reduce_smart_note_evaluation<Tz: TimeZone>(
    pre: &SmartNoteLifecycleState,
    outcome: &SmartNoteEvaluationOutcome,
    note_id: i64,
    now: i64,
    tz: &Tz,
) -> SmartNoteReduction {
    match outcome {
        SmartNoteEvaluationOutcome::Compile(o) => reduce_compile(pre, o, note_id, now, tz),
        SmartNoteEvaluationOutcome::Due(o) => reduce_due(pre, *o, note_id, now, tz),
        SmartNoteEvaluationOutcome::Liveness(o) => reduce_liveness(pre, *o, note_id, now, tz),
        SmartNoteEvaluationOutcome::Fallback(o) => reduce_fallback(pre, *o, note_id, now),
    }
}

// ---------------------------------------------------------------------------
// Phase selection (port of smart-notes/storage.ts, as pure functions over
// note snapshots)
// ---------------------------------------------------------------------------

/// The note fields the phase selectors consult.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmartNoteSelectionSnapshot {
    pub id: i64,
    pub status: String,
    /// Retina compile pipeline status; a retina handoff skips notes it
    /// already compiled.
    pub compile_status: Option<String>,
    pub created_at: i64,
    /// Only artifact PRESENCE affects selection, so the snapshot avoids copying
    /// the artifact body for every pending note on every acquisition poll.
    pub has_compiled_check: bool,
    pub check_status: String,
    pub check_quarantined_until: Option<i64>,
    pub check_next_due_at: Option<i64>,
    pub check_false_since_at: Option<i64>,
    pub check_last_liveness_at: Option<i64>,
    pub policy_version: i64,
}

fn eligible(note: &SmartNoteSelectionSnapshot, retina_handoff: bool) -> bool {
    note.status == "pending"
        && (!retina_handoff || note.compile_status.as_deref() != Some("compiled"))
}

/// Compiled, on-policy, unquarantined notes whose next check is due, earliest
/// due first.
pub fn get_due_compiled_smart_note_checks(
    notes: &[SmartNoteSelectionSnapshot],
    now: i64,
    limit: usize,
    retina_handoff: bool,
) -> Vec<&SmartNoteSelectionSnapshot> {
    let mut selected: Vec<&SmartNoteSelectionSnapshot> = notes
        .iter()
        .filter(|note| {
            eligible(note, retina_handoff)
                && note.check_status == "compiled"
                && note.has_compiled_check
                && note.policy_version == SMART_NOTE_CHECK_POLICY_VERSION
                && note.check_quarantined_until.is_none_or(|q| q <= now)
                && note.check_next_due_at.is_none_or(|d| d <= now)
        })
        .collect();
    selected.sort_by_key(|note| (note.check_next_due_at.unwrap_or(0), note.id));
    selected.truncate(limit.max(1));
    selected
}

/// Notes whose check must be (re)compiled: never compiled, failing, or on an
/// old policy — once due, oldest note first.
pub fn get_smart_notes_needing_compilation(
    notes: &[SmartNoteSelectionSnapshot],
    now: i64,
    limit: usize,
    retina_handoff: bool,
) -> Vec<&SmartNoteSelectionSnapshot> {
    let mut selected: Vec<&SmartNoteSelectionSnapshot> = notes
        .iter()
        .filter(|note| {
            eligible(note, retina_handoff)
                && note.check_next_due_at.is_none_or(|d| d <= now)
                && (note.check_status == "uncompiled"
                    || note.check_status == "failing"
                    || !note.has_compiled_check
                    || note.policy_version != SMART_NOTE_CHECK_POLICY_VERSION)
        })
        .collect();
    selected.sort_by_key(|note| (note.created_at, note.id));
    selected.truncate(limit.max(1));
    selected
}

/// Compiled notes false past the max-staleness window and outside the
/// liveness recheck spacing, stalest first.
pub fn get_stale_compiled_smart_notes(
    notes: &[SmartNoteSelectionSnapshot],
    now: i64,
    limit: usize,
    retina_handoff: bool,
) -> Vec<&SmartNoteSelectionSnapshot> {
    let stale_before = now - SMART_NOTE_CHECK_MAX_STALENESS_MS;
    let liveness_before = now - SMART_NOTE_CHECK_LIVENESS_RECHECK_MS;
    let mut selected: Vec<&SmartNoteSelectionSnapshot> = notes
        .iter()
        .filter(|note| {
            eligible(note, retina_handoff)
                && note.check_status == "compiled"
                && note.has_compiled_check
                && note.policy_version == SMART_NOTE_CHECK_POLICY_VERSION
                && note.check_false_since_at.is_some_and(|f| f <= stale_before)
                && note
                    .check_last_liveness_at
                    .is_none_or(|l| l <= liveness_before)
        })
        .collect();
    selected.sort_by_key(|note| (note.check_false_since_at.unwrap_or(0), note.id));
    selected.truncate(limit.max(1));
    selected
}

/// Fallback-status notes in input order.
pub fn get_fallback_smart_notes(
    notes: &[SmartNoteSelectionSnapshot],
    limit: usize,
    retina_handoff: bool,
) -> Vec<&SmartNoteSelectionSnapshot> {
    let mut selected: Vec<&SmartNoteSelectionSnapshot> = notes
        .iter()
        .filter(|note| eligible(note, retina_handoff) && note.check_status == "fallback")
        .collect();
    selected.truncate(limit.max(1));
    selected
}

/// Evaluator polls prioritize due checks over compilation, liveness, and
/// fallback.
pub fn select_next_smart_note_evaluation(
    notes: &[SmartNoteSelectionSnapshot],
    now: i64,
    retina_handoff: bool,
) -> Option<(i64, String)> {
    fn first(selected: &[&SmartNoteSelectionSnapshot], phase: &str) -> Option<(i64, String)> {
        selected.first().map(|note| (note.id, phase.to_string()))
    }
    first(
        &get_due_compiled_smart_note_checks(notes, now, DEFAULT_MAX_DUE_CHECKS, retina_handoff),
        "due",
    )
    .or_else(|| {
        first(
            &get_smart_notes_needing_compilation(notes, now, MAX_COMPILE_PER_RUN, retina_handoff),
            "compile",
        )
    })
    .or_else(|| {
        first(
            &get_stale_compiled_smart_notes(notes, now, DEFAULT_MAX_DUE_CHECKS, retina_handoff),
            "liveness",
        )
    })
    .or_else(|| {
        first(
            &get_fallback_smart_notes(notes, MAX_FALLBACK_PER_RUN, retina_handoff),
            "fallback",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono_tz::Tz as ChronoTz;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Golden {
        provenance: Provenance,
        constants: Constants,
        transition_cases: Vec<TransitionCase>,
        schedule_cases: Vec<ScheduleCase>,
        selection_cases: Vec<SelectionCase>,
    }

    #[derive(Deserialize)]
    struct Provenance {
        timezone: String,
    }

    #[derive(Deserialize)]
    struct Constants {
        policy_version: i64,
        floor_ms: i64,
        ceiling_ms: i64,
        default_interval_ms: i64,
        max_staleness_ms: i64,
        liveness_recheck_ms: i64,
        max_compile_per_run: usize,
        max_fallback_per_run: usize,
        max_compilation_failures: i64,
        default_max_checks: usize,
        max_failures_before_reauthor: i64,
        backoff_minutes: Vec<i64>,
    }

    #[derive(Deserialize)]
    struct TransitionCase {
        id: String,
        phase: String,
        outcome: OutcomeJson,
        note_id: i64,
        now: i64,
        pre: SmartNoteLifecycleState,
        expected: SmartNoteLifecycleState,
    }

    #[derive(Deserialize)]
    struct OutcomeJson {
        kind: String,
        compiled_check: Option<String>,
        manifest_json: Option<String>,
        check_hash: Option<String>,
        check_cron: Option<String>,
    }

    #[derive(Deserialize)]
    struct ScheduleCase {
        id: String,
        cron: Option<String>,
        now_ms: i64,
        note_id: i64,
        hash: Option<String>,
        expected_due_at: i64,
    }

    #[derive(Deserialize)]
    struct SelectionCase {
        id: String,
        phase: String,
        now: i64,
        limit: usize,
        retina_handoff: bool,
        notes: Vec<SelectionNoteJson>,
        expected_ids: Vec<i64>,
    }

    #[derive(Deserialize)]
    struct SelectionNoteJson {
        id: i64,
        status: Option<String>,
        compile_status: Option<String>,
        created_at: Option<i64>,
        compiled_check: Option<String>,
        check_status: Option<String>,
        check_quarantined_until: Option<i64>,
        check_next_due_at: Option<i64>,
        check_false_since_at: Option<i64>,
        check_last_liveness_at: Option<i64>,
        policy_version: Option<i64>,
    }

    /// Generator insertNote defaults for keys the fixture omits.
    fn snapshot_with_defaults(note: &SelectionNoteJson, now: i64) -> SmartNoteSelectionSnapshot {
        SmartNoteSelectionSnapshot {
            id: note.id,
            status: note.status.clone().unwrap_or_else(|| "pending".to_string()),
            compile_status: note.compile_status.clone(),
            created_at: note.created_at.unwrap_or(now - 1_000_000),
            // The fixture records the artifact itself; selection only observes
            // presence, so map it here rather than changing the frozen fixture.
            has_compiled_check: note.compiled_check.is_some(),
            check_status: note
                .check_status
                .clone()
                .unwrap_or_else(|| "uncompiled".to_string()),
            check_quarantined_until: note.check_quarantined_until,
            check_next_due_at: note.check_next_due_at,
            check_false_since_at: note.check_false_since_at,
            check_last_liveness_at: note.check_last_liveness_at,
            policy_version: note.policy_version.unwrap_or(1),
        }
    }

    fn build_outcome(case: &TransitionCase) -> SmartNoteEvaluationOutcome {
        let artifact = || CompiledCheckArtifact {
            compiled_check: case.outcome.compiled_check.clone().expect("compiled_check"),
            manifest_json: case.outcome.manifest_json.clone().expect("manifest_json"),
            check_hash: case.outcome.check_hash.clone().expect("check_hash"),
            check_cron: case.outcome.check_cron.clone().expect("check_cron"),
        };
        let check = |kind: &str| match kind {
            "met" => CheckOutcome::Met,
            "false" => CheckOutcome::False,
            "logic_failed" => CheckOutcome::LogicFailed,
            "network_failed" => CheckOutcome::NetworkFailed,
            other => panic!("unknown check outcome kind {other:?}"),
        };
        match (case.phase.as_str(), case.outcome.kind.as_str()) {
            ("compile", "compiled_met") => {
                SmartNoteEvaluationOutcome::Compile(CompileOutcome::CompiledMet(artifact()))
            }
            ("compile", "compiled_false") => {
                SmartNoteEvaluationOutcome::Compile(CompileOutcome::CompiledFalse(artifact()))
            }
            ("compile", "compilation_failed") => {
                SmartNoteEvaluationOutcome::Compile(CompileOutcome::CompilationFailed)
            }
            ("due", kind) => SmartNoteEvaluationOutcome::Due(check(kind)),
            ("liveness", kind) => SmartNoteEvaluationOutcome::Liveness(check(kind)),
            ("fallback", "met") => SmartNoteEvaluationOutcome::Fallback(FallbackOutcome::Met),
            ("fallback", "false") => SmartNoteEvaluationOutcome::Fallback(FallbackOutcome::False),
            (phase, kind) => panic!("unknown outcome {phase}/{kind}"),
        }
    }

    #[test]
    fn smart_note_evaluation_golden_matches_production_behaviour() {
        let raw = include_str!("../testdata/smart-note-evaluation-golden.json");
        let golden: Golden = serde_json::from_str(raw).expect("parse fixture");
        let tz: ChronoTz = golden
            .provenance
            .timezone
            .parse()
            .expect("parse fixture timezone");

        let c = &golden.constants;
        assert_eq!(SMART_NOTE_CHECK_POLICY_VERSION, c.policy_version);
        assert_eq!(SMART_NOTE_CHECK_FLOOR_MS, c.floor_ms);
        assert_eq!(SMART_NOTE_CHECK_CEILING_MS, c.ceiling_ms);
        assert_eq!(SMART_NOTE_CHECK_DEFAULT_INTERVAL_MS, c.default_interval_ms);
        assert_eq!(SMART_NOTE_CHECK_MAX_STALENESS_MS, c.max_staleness_ms);
        assert_eq!(SMART_NOTE_CHECK_LIVENESS_RECHECK_MS, c.liveness_recheck_ms);
        assert_eq!(MAX_COMPILE_PER_RUN, c.max_compile_per_run);
        assert_eq!(MAX_FALLBACK_PER_RUN, c.max_fallback_per_run);
        assert_eq!(MAX_COMPILATION_FAILURES, c.max_compilation_failures);
        assert_eq!(DEFAULT_MAX_DUE_CHECKS, c.default_max_checks);
        assert_eq!(MAX_FAILURES_BEFORE_REAUTHOR, c.max_failures_before_reauthor);
        for (i, minutes) in c.backoff_minutes.iter().enumerate() {
            let failure_count = i as i64 + 1;
            assert_eq!(
                evaluation_backoff_ms(failure_count),
                minutes * 60 * 1000,
                "backoff for failure {failure_count}"
            );
        }

        for case in &golden.transition_cases {
            let outcome = build_outcome(case);
            let reduction =
                reduce_smart_note_evaluation(&case.pre, &outcome, case.note_id, case.now, &tz);
            assert_eq!(reduction.next, case.expected, "transition case {}", case.id);
            assert_eq!(
                reduction.surfaced,
                case.expected.status == "ready",
                "surfaced for transition case {}",
                case.id
            );
        }

        for case in &golden.schedule_cases {
            let due_at = next_smart_note_check_due_at(
                case.cron.as_deref(),
                case.now_ms,
                case.note_id,
                case.hash.as_deref(),
                &tz,
            );
            assert_eq!(due_at, case.expected_due_at, "schedule case {}", case.id);
        }

        for case in &golden.selection_cases {
            let notes: Vec<SmartNoteSelectionSnapshot> = case
                .notes
                .iter()
                .map(|n| snapshot_with_defaults(n, case.now))
                .collect();
            let selected = match case.phase.as_str() {
                "due" => get_due_compiled_smart_note_checks(
                    &notes,
                    case.now,
                    case.limit,
                    case.retina_handoff,
                ),
                "compile" => get_smart_notes_needing_compilation(
                    &notes,
                    case.now,
                    case.limit,
                    case.retina_handoff,
                ),
                "liveness" => get_stale_compiled_smart_notes(
                    &notes,
                    case.now,
                    case.limit,
                    case.retina_handoff,
                ),
                "fallback" => get_fallback_smart_notes(&notes, case.limit, case.retina_handoff),
                other => panic!("unknown selection phase {other:?}"),
            };
            let ids: Vec<i64> = selected.iter().map(|n| n.id).collect();
            assert_eq!(ids, case.expected_ids, "selection case {}", case.id);
        }
    }

    #[test]
    fn smart_note_revision_matrix_normative_matches_mc_store() {
        use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
        use mc_store::{
            McStore, NoteCasOutcome, NoteEvalAcquireOutcome, NoteEvalClaim, NoteEvalRenewOutcome,
            NoteTransitionInput, NoteWriteInput, StoredNote,
        };

        #[derive(Deserialize)]
        struct Normative {
            revision_matrix_cases: Vec<RevisionCase>,
        }

        #[derive(Deserialize)]
        struct RevisionCase {
            id: String,
            event: String,
            pre: Option<RevisionPre>,
            expected: RevisionExpected,
        }

        #[derive(Deserialize, Default)]
        struct RevisionPre {
            #[serde(default)]
            source_revision: i64,
            #[serde(default)]
            state_version: i64,
            status_version: i64,
        }

        #[derive(Deserialize)]
        struct RevisionExpected {
            source_revision: i64,
            state_version: i64,
            status_version: i64,
            artifact_cleared: Option<bool>,
            active_claims_fenced: Option<bool>,
        }

        const PROJECT: &str = "git:rev-matrix";

        fn open_store(dir: &std::path::Path) -> McStore {
            let store = McStore::open(&StorageDescriptor {
                module_id: "magic-context-test".to_string(),
                storage_namespace: "mc_cache".to_string(),
                isolation: Isolation::Module,
                backend: StorageBackend::Sqlite {
                    path: dir.join("store.db").to_string_lossy().to_string(),
                },
            })
            .unwrap();
            let preparing = store
                .authority_begin_prepare("ctx", PROJECT, "notes")
                .unwrap();
            store
                .authority_finish_prepare(
                    "ctx",
                    PROJECT,
                    "notes",
                    preparing.generation,
                    "hash",
                    "hash",
                    true,
                )
                .unwrap();
            store
        }

        fn insert_note(store: &McStore) -> StoredNote {
            store
                .insert_project_note(NoteWriteInput {
                    project_path: PROJECT,
                    route_project_root: None,
                    session_id: Some("writer"),
                    content: "base content",
                    surface_condition: Some("base condition"),
                    anchor_block_id: None,
                    anchor_ordinal: None,
                    compiled_provider: None,
                    compiled_config: None,
                    compiled_at: None,
                    compile_status: None,
                    now_ms: 1,
                })
                .unwrap()
        }

        /// Content edits increment source_revision and state_version;
        /// pending-to-pending transitions increment state_version only.
        fn stage(store: &McStore, mut note: StoredNote, src: i64, state: i64) -> StoredNote {
            for i in 0..src {
                note = match store
                    .update_note_cas(
                        PROJECT,
                        note.id,
                        "pending",
                        note.status_version,
                        Some(&format!("staged content {i}")),
                        None,
                        None,
                        2,
                    )
                    .unwrap()
                {
                    NoteCasOutcome::Applied(next) => next,
                    other => panic!("staging content edit failed: {other:?}"),
                };
            }
            while note.state_version < state {
                note = match store
                    .transition_note(NoteTransitionInput {
                        project_path: PROJECT,
                        note_id: note.id,
                        from_status: "pending",
                        source_revision: note.status_version,
                        to_status: "pending",
                        result: None,
                        now_ms: 3,
                    })
                    .unwrap()
                {
                    NoteCasOutcome::Applied(next) => next,
                    other => panic!("staging transition failed: {other:?}"),
                };
            }
            assert_eq!(
                (
                    note.source_revision,
                    note.state_version,
                    note.status_version
                ),
                (src, state, state),
                "pre-state staging"
            );
            note
        }

        fn stage_artifact(store: &McStore, note: &StoredNote) {
            store
                .execute_tag_sql_for_test(&format!(
                    "UPDATE mc_notes SET compiled_check = 'check-code', manifest_json = '{{}}',
                        check_hash = 'hash', check_status = 'compiled', check_version = 1,
                        compiled_source_revision = {}, compiled_project_path = '{PROJECT}'
                      WHERE id = {}",
                    note.source_revision, note.id
                ))
                .unwrap();
        }

        fn stage_claim(store: &McStore, note_id: i64) -> NoteEvalClaim {
            match store
                .acquire_note_evaluation(
                    PROJECT,
                    "acq-1",
                    "eval-a",
                    0,
                    1,
                    |notes| {
                        notes
                            .iter()
                            .find(|note| note.id == note_id)
                            .map(|note| (note.id, "due".to_string()))
                    },
                    10,
                )
                .unwrap()
            {
                NoteEvalAcquireOutcome::Claim { claim, .. } => claim,
                other => panic!("claim staging failed: {other:?}"),
            }
        }

        let raw = include_str!("../testdata/smart-note-evaluation-normative.json");
        let normative: Normative = serde_json::from_str(raw).expect("parse normative fixture");

        for case in &normative.revision_matrix_cases {
            let dir = tempfile::tempdir().unwrap();
            let store = open_store(dir.path());
            let note = insert_note(&store);
            let pre = case.pre.as_ref();
            let mut claim = None;

            let post = match case.event.as_str() {
                "migrate" => {
                    let pre = pre.expect("migrate pre");
                    store
                        .execute_tag_sql_for_test(&format!(
                            "UPDATE mc_notes SET status_version = {}, source_revision = 0,
                                state_version = 0 WHERE id = {};
                             UPDATE mc_notes SET source_revision = status_version,
                                state_version = status_version;",
                            pre.status_version, note.id
                        ))
                        .unwrap();
                    store
                        .get_note_by_id(PROJECT, "writer", note.id)
                        .unwrap()
                        .unwrap()
                }
                "create" => note,
                "edit_compiler_input" => {
                    if case.id == "edit_project" {
                        // A project move cannot be expressed through the module
                        // authority: update_note_cas pins project_path in its
                        // WHERE clause. The TypeScript replay in
                        // storage-notes.test.ts covers this case.
                        continue;
                    }
                    let pre = pre.expect("edit pre");
                    let staged = stage(&store, note, pre.source_revision, pre.state_version);
                    stage_artifact(&store, &staged);
                    claim = Some(stage_claim(&store, staged.id));
                    let (content, condition) = if case.id.contains("condition") {
                        (None, Some(Some("edited condition")))
                    } else {
                        (Some("edited body"), None)
                    };
                    match store
                        .update_note_cas(
                            PROJECT,
                            staged.id,
                            "pending",
                            staged.status_version,
                            content,
                            condition,
                            None,
                            20,
                        )
                        .unwrap()
                    {
                        NoteCasOutcome::Applied(next) => next,
                        other => panic!("case {}: edit failed: {other:?}", case.id),
                    }
                }
                "lifecycle_transition" => {
                    let pre = pre.expect("transition pre");
                    let staged = stage(&store, note, pre.source_revision, pre.state_version);
                    stage_artifact(&store, &staged);
                    claim = Some(stage_claim(&store, staged.id));
                    match store
                        .transition_note(NoteTransitionInput {
                            project_path: PROJECT,
                            note_id: staged.id,
                            from_status: "pending",
                            source_revision: staged.status_version,
                            to_status: "ready",
                            result: Some("condition_true"),
                            now_ms: 20,
                        })
                        .unwrap()
                    {
                        NoteCasOutcome::Applied(next) => next,
                        other => panic!("case {}: transition failed: {other:?}", case.id),
                    }
                }
                "dismiss" => {
                    let pre = pre.expect("dismiss pre");
                    let staged = stage(&store, note, pre.source_revision, pre.state_version);
                    stage_artifact(&store, &staged);
                    claim = Some(stage_claim(&store, staged.id));
                    store
                        .dismiss_note(PROJECT, "writer", staged.id, Some("done"), 20)
                        .unwrap()
                        .expect("dismissal applies")
                }
                "authority_transfer" => {
                    let pre = pre.expect("transfer pre");
                    let staged = stage(&store, note, pre.source_revision, pre.state_version);
                    store
                        .authority_begin_drain("ctx", PROJECT, "notes", "lease", 1_000_000, 20)
                        .unwrap();
                    store
                        .get_note_by_id(PROJECT, "writer", staged.id)
                        .unwrap()
                        .unwrap()
                }
                other => panic!("unknown revision matrix event {other:?}"),
            };

            let expected = &case.expected;
            assert_eq!(
                (
                    post.source_revision,
                    post.state_version,
                    post.status_version
                ),
                (
                    expected.source_revision,
                    expected.state_version,
                    expected.status_version
                ),
                "revisions for case {}",
                case.id
            );
            if let Some(cleared) = expected.artifact_cleared {
                assert_eq!(
                    post.compiled_check.is_none(),
                    cleared,
                    "artifact for case {}",
                    case.id
                );
            }
            if let Some(should_fence) = expected.active_claims_fenced {
                let claim = claim.expect("fence-pinned case stages a claim");
                let outcome = store
                    .renew_note_evaluation_claim(PROJECT, &claim.claim_id, "eval-a", 0, 1, 30)
                    .unwrap();
                if should_fence {
                    assert!(
                        matches!(outcome, NoteEvalRenewOutcome::TerminalReplay { .. }),
                        "claim fencing for case {}",
                        case.id
                    );
                } else {
                    assert!(
                        matches!(outcome, NoteEvalRenewOutcome::Renewed { .. }),
                        "claim must stay live for case {}",
                        case.id
                    );
                }
            }
            assert_eq!(
                post.state_version, post.status_version,
                "state/status invariant for case {}",
                case.id
            );
        }
    }

    /// The TypeScript reducer truncates `ready_reason` with `String.slice`, which
    /// counts UTF-16 code units. Counting Unicode scalars here would persist a
    /// different value for the same note whenever the reason runs past the bound
    /// with non-BMP characters in it.
    #[test]
    fn due_ready_reason_truncates_on_utf16_units_like_the_ts_reducer() {
        // Each emoji is one scalar but TWO UTF-16 units.
        let signal = "\u{1F600}".repeat(200);
        let manifest = format!("{{\"signals\":[\"{signal}\"]}}");
        let reason = due_ready_reason(1, Some(manifest.as_str()));

        let units: usize = reason.chars().map(char::len_utf16).sum();
        assert!(
            units <= 240,
            "expected at most 240 UTF-16 units, got {units}"
        );
        // A scalar-based bound would have kept 240 emoji (480 units).
        assert!(
            reason.chars().count() < 240,
            "scalar-counted truncation would exceed the JS bound"
        );
        // Never emit a broken pair.
        assert!(reason.is_char_boundary(reason.len()));
    }

    #[test]
    fn due_ready_reason_leaves_short_reasons_untouched() {
        let manifest = r#"{"signals":["build is green"]}"#;
        assert_eq!(
            due_ready_reason(7, Some(manifest)),
            "Smart note #7: build is green"
        );
    }

    #[test]
    fn next_occurrence_survives_extreme_instants() {
        // i64::MIN underflows the minute-floor multiplication and i64::MAX
        // overflows the cap; both must resolve to "no occurrence", never a
        // debug-build panic.
        let utc = chrono::Utc;
        assert_eq!(
            next_due_at_ms("* * * * *", i64::MIN, MAX_SEARCH_MS, &utc),
            None
        );
        assert_eq!(
            next_due_at_ms("* * * * *", i64::MAX, MAX_SEARCH_MS, &utc),
            None
        );
    }

    // The golden fixtures exercise each phase selector in isolation; this pins
    // the composed priority chain itself so an ordering regression cannot slip
    // past the fixture replay.
    #[test]
    fn phase_selection_prefers_due_then_compile_then_liveness_then_fallback() {
        let now: i64 = 1_781_542_800_000;
        let base = SmartNoteSelectionSnapshot {
            id: 0,
            status: "pending".to_string(),
            compile_status: None,
            created_at: 1,
            has_compiled_check: false,
            check_status: "uncompiled".to_string(),
            check_quarantined_until: None,
            check_next_due_at: None,
            check_false_since_at: None,
            check_last_liveness_at: None,
            policy_version: SMART_NOTE_CHECK_POLICY_VERSION,
        };
        let due = SmartNoteSelectionSnapshot {
            id: 1,
            check_status: "compiled".to_string(),
            has_compiled_check: true,
            check_next_due_at: Some(now - 1),
            ..base.clone()
        };
        let compile = SmartNoteSelectionSnapshot {
            id: 2,
            ..base.clone()
        };
        let liveness = SmartNoteSelectionSnapshot {
            id: 3,
            check_status: "compiled".to_string(),
            has_compiled_check: true,
            check_next_due_at: Some(now + 60_000),
            check_false_since_at: Some(now - SMART_NOTE_CHECK_MAX_STALENESS_MS - 1),
            ..base.clone()
        };
        let fallback = SmartNoteSelectionSnapshot {
            id: 4,
            check_status: "fallback".to_string(),
            has_compiled_check: true,
            ..base.clone()
        };
        let all = [
            fallback.clone(),
            liveness.clone(),
            compile.clone(),
            due.clone(),
        ];
        assert_eq!(
            select_next_smart_note_evaluation(&all, now, false),
            Some((1, "due".to_string()))
        );
        let no_due = [fallback.clone(), liveness.clone(), compile.clone()];
        assert_eq!(
            select_next_smart_note_evaluation(&no_due, now, false),
            Some((2, "compile".to_string()))
        );
        let no_compile = [fallback.clone(), liveness];
        assert_eq!(
            select_next_smart_note_evaluation(&no_compile, now, false),
            Some((3, "liveness".to_string()))
        );
        assert_eq!(
            select_next_smart_note_evaluation(&[fallback], now, false),
            Some((4, "fallback".to_string()))
        );
        assert_eq!(select_next_smart_note_evaluation(&[], now, false), None);
    }
}
