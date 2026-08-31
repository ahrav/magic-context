//! This module produces execute, defer, force, and block pass classes.
//! This module fires idle TTLs and transitions deferred work to execution mid-turn.
//! This module manages the emergency-drain latch and detects provider context overflows.
//! Functions in this module receive durable state as parameters and return updated state.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::selection::PassClass;

/// The scheduler uses 65.0 when configuration has no usable execute threshold.
pub const DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE: f64 = 65.0;
pub const MAX_EXECUTE_THRESHOLD_PERCENTAGE: f64 = 90.0;
/// The scheduler may force materialization at 85.0% context usage.
pub const MIN_FORCE_MATERIALIZE_PERCENTAGE: f64 = 85.0;
/// The scheduler enters the emergency block-and-drain band at 95.0% context usage.
pub const EMERGENCY_PERCENTAGE: f64 = 95.0;
/// The TTL parser returns 300_000 ms for an invalid configuration string.
pub const DEFAULT_CACHE_TTL_MS: u64 = 5 * 60 * 1000;
/// The latch clears 10.0 percentage points below the execute threshold.
pub const EMERGENCY_DRAIN_EXIT_MARGIN: f64 = 10.0;
/// The latch exits at 55.0% when the execute threshold is unusable.
pub const EMERGENCY_DRAIN_FALLBACK_EXIT_PERCENTAGE: f64 = 55.0;
/// A drain failure suppresses latch bypass for 60_000 ms.
pub const EMERGENCY_DRAIN_FAILURE_BACKOFF_MS: u64 = 60_000;
/// The latch expires after 1_800_000 ms without re-entry.
pub const EMERGENCY_DRAIN_MAX_LATCH_MS: u64 = 30 * 60 * 1000;
/// The validator accepts provider limits no smaller than 1024.
pub const MIN_PLAUSIBLE_CONTEXT_LIMIT: u64 = 1024;
/// The validator accepts provider limits no larger than 10_000_000.
pub const MAX_PLAUSIBLE_CONTEXT_LIMIT: u64 = 10_000_000;

const OVERFLOW_PATTERN_SOURCES: &[&str] = &[
    r"prompt is too long",
    r"input is too long for requested model",
    r"exceeds the context window",
    r"input token count.*exceeds the maximum",
    r"maximum prompt length is \d+",
    r"reduce the length of the messages",
    r"maximum context length is \d+ tokens",
    r"maximum model length is \d+",
    r"exceeds the limit of \d+",
    r"exceeds the available context size",
    r"greater than the context length",
    r"context window exceeds limit",
    r"exceeded model token limit",
    r"context[_ ]length[_ ]exceeded",
    r"request entity too large",
    r"context length is only \d+ tokens",
    r"input length.*exceeds.*context length",
    r"prompt too long; exceeded (?:max )?context length",
    r"too large for model with \d+ maximum context length",
    r"model_context_window_exceeded",
    r"context size has been exceeded",
];

const LIMIT_EXTRACTION_PATTERN_SOURCES: &[(&str, ContextLimitProvenance)] = &[
    (
        r"maximum prompt length is (\d+)",
        ContextLimitProvenance::PromptOnly,
    ),
    (
        r"maximum context length is (\d+) tokens?",
        ContextLimitProvenance::Combined,
    ),
    (
        r"maximum model length is (\d+)",
        ContextLimitProvenance::Combined,
    ),
    (
        r"context length is only (\d+) tokens?",
        ContextLimitProvenance::Combined,
    ),
    (
        r"exceeds the limit of (\d+)",
        ContextLimitProvenance::Unknown,
    ),
    (
        r"too large for model with (\d+) maximum context length",
        ContextLimitProvenance::Combined,
    ),
    (
        r"context size.*(\d+) tokens?",
        ContextLimitProvenance::Combined,
    ),
    (
        r"exceeds? the context length of (\d+)",
        ContextLimitProvenance::Combined,
    ),
    (
        r">\s*(\d+)\s*(?:tokens?\s*)?(?:maximum|max|limit)\b",
        ContextLimitProvenance::PromptOnly,
    ),
    (
        r"max(?:imum)?.*context.*?(\d+)",
        ContextLimitProvenance::Unknown,
    ),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheTtlParseError;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ExecuteThresholdConfig {
    Percentage(f64),
    ByModel(BTreeMap<String, f64>),
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ExecuteThresholdTokensConfig {
    /// The `default` key is used when no model-specific key matches.
    pub values: BTreeMap<String, f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchedulerConfig {
    /// `MAX_EXECUTE_THRESHOLD_PERCENTAGE` caps the percentage threshold configuration.
    pub execute_threshold_percentage: ExecuteThresholdConfig,
    /// The absolute-token threshold overrides the percentage threshold when a context limit is known.
    pub execute_threshold_tokens: Option<ExecuteThresholdTokensConfig>,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            execute_threshold_percentage: ExecuteThresholdConfig::Percentage(
                DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
            ),
            execute_threshold_tokens: None,
        }
    }
}

/// The field records provider-reported context pressure for the current pass.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ContextUsage {
    /// The field records provider-reported context fill against the soft scheduling window.
    pub percentage: f64,
    /// The field records provider-reported input tokens for the pass.
    pub input_tokens: f64,
    /// The field records context fill against the provider's absolute hard wall.
    /// The scheduler uses the soft-window percentage when the absolute-token threshold is absent.
    #[serde(default)]
    pub hard_wall_percentage: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionMeta {
    /// The field records the Unix-millisecond timestamp of the last completed provider response; `0` means none exists.
    pub last_response_time_ms: u64,
    /// The parser accepts `5m`, `30s`, `2h`, and bare millisecond counts.
    pub cache_ttl: String,
}

/// Pressure bands and boundary deferral modify the base scheduler decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BaseDecision {
    Defer,
    Execute,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EscalationBands {
    /// `EMERGENCY_PERCENTAGE` fixes the emergency block-and-drain threshold at 95.0%.
    pub force_materialize_percentage: f64,
    /// The provider-wall threshold is never derived from configuration.
    pub emergency_percentage: f64,
}

pub fn escalation_bands(effective_threshold_percentage: f64) -> EscalationBands {
    let threshold = if effective_threshold_percentage.is_finite() {
        effective_threshold_percentage.min(MAX_EXECUTE_THRESHOLD_PERCENTAGE)
    } else {
        DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE
    };
    EscalationBands {
        force_materialize_percentage: MIN_FORCE_MATERIALIZE_PERCENTAGE.max(threshold + 2.0),
        emergency_percentage: EMERGENCY_PERCENTAGE,
    }
}

/// Provider-reported context usage determines the pressure band.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Band {
    /// `Band::Execute` applies below the force-materialization threshold.
    Normal,
    /// `Band::Force85` materializes and bypasses mid-turn deferral at or above the derived force band.
    Force85,
    /// `Band::Emergency95` blocks and drains at or above 95% usage.
    Emergency95,
}

/// `PassDecision` is the scheduler's final decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PassDecision {
    /// `PassDecision::Defer` prevents a new cache-busting pass.
    Defer,
    /// `PassDecision::Execute` runs a normal cache-busting pass.
    Execute,
    /// `PassDecision::Force85` forces materialization at or above the derived escalation band.
    Force85,
    /// `PassDecision::Emergency95` blocks and drains at or above 95% usage.
    Emergency95,
}

impl PassDecision {
    fn is_force_or_emergency(self) -> bool {
        matches!(self, PassDecision::Force85 | PassDecision::Emergency95)
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            PassDecision::Defer => "Defer",
            PassDecision::Execute => "Execute",
            PassDecision::Force85 => "Force85",
            PassDecision::Emergency95 => "Emergency95",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TailState {
    /// `mid_tool_use` is true when the newest assistant span has a tool call without its paired result.
    pub mid_tool_use: bool,
}

/// `BoundaryBypass` bypasses mid-turn deferral for execute decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct BoundaryBypass {
    pub explicit_bust: bool,
    /// `subagent` bypasses deferral so subagent cache work does not wait on the parent session's tail state.
    pub subagent: bool,
}

impl BoundaryBypass {
    fn is_active(self) -> bool {
        self.explicit_bust || self.subagent
    }
}

/// `DeferredExecute` records an execute pass deferred until the current tool call resolves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeferredExecute {
    pub reason: String,
}

impl DeferredExecute {
    /// `pending_execute` returns the canonical intent for a mid-turn-deferred execute pass.
    pub fn pending_execute() -> Self {
        Self {
            reason: "execute-none".to_string(),
        }
    }
}

/// `LatchState` persists the emergency-drain latch between passes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct LatchState {
    /// `active_since_ms` stores the Unix milliseconds when the latch armed; `None` means inactive.
    pub active_since_ms: Option<u64>,
}

impl LatchState {
    pub fn is_active(self) -> bool {
        self.active_since_ms.is_some()
    }
}

/// `ContextLimitProvenance` identifies the accounting convention for a limit extracted from a provider overflow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextLimitProvenance {
    /// The provider already reported its accepted input/prompt ceiling.
    PromptOnly,
    /// The provider reported a combined input-plus-output context window.
    Combined,
    /// The message does not identify which accounting convention it uses.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportedContextLimit {
    pub value: u64,
    pub provenance: ContextLimitProvenance,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OverflowDetection {
    /// `is_overflow` is true when the error text matches a known context-overflow pattern.
    pub is_overflow: bool,
    /// `reported_limit` stores an extractable, plausible provider context limit in tokens.
    pub reported_limit: Option<u64>,
    /// `reported_limit_provenance` identifies the accounting convention for an extracted `reported_limit`.
    pub reported_limit_provenance: Option<ContextLimitProvenance>,
    /// `matched_pattern` stores the first matching overflow regex source for diagnostics.
    pub matched_pattern: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchedulerInputs {
    pub config: SchedulerConfig,
    /// `usage` contains provider-reported context pressure.
    pub usage: ContextUsage,
    /// `session` stores durable session timing metadata.
    pub session: SessionMeta,
    /// `now_ms` is caller-supplied Unix time in milliseconds, which keeps decisions deterministic.
    pub now_ms: u64,
    /// `model_key` selects per-model thresholds.
    pub model_key: Option<String>,
    /// `context_limit` stores an explicit model context limit in tokens.
    pub context_limit: Option<f64>,
    /// `tail_state` controls mid-turn deferral.
    pub tail_state: TailState,
    /// `deferred_execute` preserves an execute intent postponed by a prior pass.
    pub deferred_execute: Option<DeferredExecute>,
    /// `boundary_bypass` bypasses mid-turn deferral for non-pressure conditions.
    pub boundary_bypass: BoundaryBypass,
    pub drain_latch: LatchState,
    /// `overflow_error_text` supplies provider error text for context-overflow detection.
    pub overflow_error_text: Option<String>,
    /// `emergency_recovery_armed` is a host-persisted provider-overflow recovery arm.
    /// The recovery arm upgrades a would-be defer to the emergency path even when local usage is below the reported limit.
    pub emergency_recovery_armed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchedulerOutcome {
    pub pass: PassDecision,
    /// `pressure_execute` is true only when the configured usage threshold causes execution.
    pub pressure_execute: bool,
    /// `idle_ttl_fired` is true when the hard idle-TTL predicate fires and requires materialization.
    pub idle_ttl_fired: bool,
    /// `drain_latch` is the updated emergency drain state the caller must persist.
    pub drain_latch: LatchState,
    /// `deferred_execute` is the updated deferred execute intent the caller must persist.
    pub deferred_execute: Option<DeferredExecute>,
    /// `detected_limit` stores the provider context limit reported in overflow text.
    pub detected_limit: Option<u64>,
    /// `detected_limit_provenance` identifies `detected_limit`'s accounting convention.
    pub detected_limit_provenance: Option<ContextLimitProvenance>,
}

struct CompiledPattern {
    source: &'static str,
    regex: Regex,
}

struct CompiledLimitPattern {
    regex: Regex,
    provenance: ContextLimitProvenance,
}

pub fn parse_cache_ttl(ttl: &str) -> Result<u64, CacheTtlParseError> {
    let normalized = ttl.trim();
    if normalized.eq_ignore_ascii_case("never") {
        return Ok(u64::MAX);
    }
    let (number, multiplier) =
        if !normalized.is_empty() && normalized.chars().all(|c| c.is_ascii_digit()) {
            (normalized, 1.0)
        } else {
            let Some(unit) = normalized.chars().last() else {
                return Err(CacheTtlParseError);
            };
            let number = &normalized[..normalized.len().saturating_sub(unit.len_utf8())];
            let multiplier = match unit {
                's' => 1_000.0,
                'm' => 60.0 * 1_000.0,
                'h' => 60.0 * 60.0 * 1_000.0,
                _ => return Err(CacheTtlParseError),
            };
            (number, multiplier)
        };
    if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) {
        return Err(CacheTtlParseError);
    }
    // `parse_cache_ttl` saturates overflowing TTL values at `u64::MAX` because elapsed time cannot exceed `u64::MAX`.
    let milliseconds = number.parse::<f64>().map_err(|_| CacheTtlParseError)? * multiplier;
    Ok(
        if !milliseconds.is_finite() || milliseconds >= u64::MAX as f64 {
            u64::MAX
        } else {
            milliseconds as u64
        },
    )
}

pub fn ttl_execute_fired(now_ms: u64, last_response_time_ms: u64, ttl_ms: u64) -> bool {
    now_ms.saturating_sub(last_response_time_ms) > ttl_ms
}

/// `ttl_execute_fired` and `ttl_force_fired` defer when `elapsed == ttl_ms`.
pub fn ttl_hard_expired(now_ms: u64, last_response_time_ms: u64, ttl_ms: u64) -> bool {
    last_response_time_ms > 0 && now_ms.saturating_sub(last_response_time_ms) > ttl_ms
}

pub fn resolve_execute_threshold(
    config: &ExecuteThresholdConfig,
    model_key: Option<&str>,
    fallback: f64,
    tokens_config: Option<&ExecuteThresholdTokensConfig>,
    context_limit: Option<f64>,
) -> f64 {
    if let (Some(tokens), Some(limit)) = (tokens_config, context_limit) {
        if is_finite_positive(limit) {
            if let Some((token_value, _matched_key)) = resolve_tokens_match(tokens, model_key) {
                if is_finite_positive(token_value) {
                    let cap = limit * (MAX_EXECUTE_THRESHOLD_PERCENTAGE / 100.0);
                    let effective_tokens = token_value.min(cap);
                    let percentage = (effective_tokens / limit) * 100.0;
                    return percentage.min(MAX_EXECUTE_THRESHOLD_PERCENTAGE);
                }
            }
        }
    }

    let mut resolved = match config {
        ExecuteThresholdConfig::Percentage(value) => *value,
        ExecuteThresholdConfig::ByModel(values) => {
            resolve_percentage_match(values, model_key).unwrap_or(fallback)
        }
    };

    if !resolved.is_finite() || resolved < 0.0 {
        resolved = fallback;
    }
    resolved.min(MAX_EXECUTE_THRESHOLD_PERCENTAGE)
}

pub fn should_execute(
    config: &SchedulerConfig,
    session: &SessionMeta,
    usage: &ContextUsage,
    now_ms: u64,
    model_key: Option<&str>,
    context_limit: Option<f64>,
) -> BaseDecision {
    if usage.percentage == 0.0 && session.last_response_time_ms == 0 {
        return BaseDecision::Defer;
    }

    let effective_context_limit = context_limit.or_else(|| {
        if usage.percentage > 0.0 && usage.input_tokens > 0.0 {
            Some(usage.input_tokens / (usage.percentage / 100.0))
        } else {
            None
        }
    });
    let threshold = resolve_execute_threshold(
        &config.execute_threshold_percentage,
        model_key,
        DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
        config.execute_threshold_tokens.as_ref(),
        effective_context_limit,
    );
    if usage.percentage >= threshold {
        return BaseDecision::Execute;
    }

    let ttl_ms = scheduler_ttl_ms(&session.cache_ttl);
    if ttl_execute_fired(now_ms, session.last_response_time_ms, ttl_ms) {
        BaseDecision::Execute
    } else {
        BaseDecision::Defer
    }
}

pub fn derive_band(usage_percentage: f64, effective_threshold_percentage: f64) -> Band {
    derive_band_with_hard_wall(
        usage_percentage,
        usage_percentage,
        effective_threshold_percentage,
    )
}

/// The force arm uses the soft percentage; only the absolute 95% arm uses hard_wall_percentage.
pub fn derive_band_with_hard_wall(
    usage_percentage: f64,
    hard_wall_percentage: f64,
    effective_threshold_percentage: f64,
) -> Band {
    let bands = escalation_bands(effective_threshold_percentage);
    if hard_wall_percentage >= bands.emergency_percentage {
        Band::Emergency95
    } else if usage_percentage >= bands.force_materialize_percentage {
        Band::Force85
    } else {
        Band::Normal
    }
}

pub fn apply_boundary_deferral(
    decision: PassDecision,
    tail_state: TailState,
    pending: Option<DeferredExecute>,
    bypass: BoundaryBypass,
) -> (PassDecision, Option<DeferredExecute>) {
    if decision == PassDecision::Defer {
        return (PassDecision::Defer, pending);
    }
    if decision.is_force_or_emergency() || bypass.is_active() {
        return (decision, pending);
    }
    if tail_state.mid_tool_use {
        return (
            PassDecision::Defer,
            Some(pending.unwrap_or_else(DeferredExecute::pending_execute)),
        );
    }
    (decision, pending)
}

/// A successful scheduled work item clears the deferred execute intent.
pub fn drain_deferred_after_work(
    pending: Option<DeferredExecute>,
    work_succeeded: bool,
) -> Option<DeferredExecute> {
    if work_succeeded {
        None
    } else {
        pending
    }
}

pub fn emergency_drain_exit_threshold(execute_threshold_percentage: f64) -> f64 {
    if !execute_threshold_percentage.is_finite() || execute_threshold_percentage <= 0.0 {
        return EMERGENCY_DRAIN_FALLBACK_EXIT_PERCENTAGE;
    }
    (execute_threshold_percentage - EMERGENCY_DRAIN_EXIT_MARGIN).max(0.0)
}

pub fn advance_drain_latch(
    state: LatchState,
    usage_percentage: f64,
    execute_threshold_percentage: f64,
    now_ms: u64,
) -> LatchState {
    if usage_percentage
        >= escalation_bands(execute_threshold_percentage).force_materialize_percentage
    {
        return LatchState {
            active_since_ms: state.active_since_ms.or(Some(now_ms)),
        };
    }

    let Some(active_since_ms) = state.active_since_ms else {
        return state;
    };
    let expired = now_ms.saturating_sub(active_since_ms) > EMERGENCY_DRAIN_MAX_LATCH_MS;
    let below_exit =
        usage_percentage < emergency_drain_exit_threshold(execute_threshold_percentage);
    if below_exit || expired {
        LatchState {
            active_since_ms: None,
        }
    } else {
        state
    }
}

pub fn drain_bypass_allowed(latch: LatchState, failure_at_ms: u64, now_ms: u64) -> bool {
    if !latch.is_active() {
        return false;
    }
    !(failure_at_ms > 0
        && now_ms.saturating_sub(failure_at_ms) < EMERGENCY_DRAIN_FAILURE_BACKOFF_MS)
}

pub fn extract_error_message(error: &serde_json::Value) -> String {
    match error {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Object(obj) => {
            if let Some(message) = obj
                .get("error")
                .and_then(serde_json::Value::as_object)
                .and_then(|nested| nested.get("message"))
                .and_then(serde_json::Value::as_str)
            {
                if !message.is_empty() {
                    return message.to_string();
                }
            }
            if let Some(message) = obj.get("message").and_then(serde_json::Value::as_str) {
                return message.to_string();
            }
            if let Some(body) = obj.get("responseBody").and_then(serde_json::Value::as_str) {
                return body.to_string();
            }
            serde_json::to_string(error).unwrap_or_else(|_| error.to_string())
        }
        _ => error.to_string(),
    }
}

pub fn detect_overflow(error_text: &str) -> OverflowDetection {
    if error_text.is_empty() {
        return OverflowDetection {
            is_overflow: false,
            reported_limit: None,
            reported_limit_provenance: None,
            matched_pattern: None,
        };
    }

    let has_status_413 =
        status_413_regex().is_match(error_text) && status_413_context_regex().is_match(error_text);
    let matched = overflow_patterns()
        .iter()
        .find(|pattern| pattern.regex.is_match(error_text));

    if matched.is_none() && !has_status_413 {
        return OverflowDetection {
            is_overflow: false,
            reported_limit: None,
            reported_limit_provenance: None,
            matched_pattern: None,
        };
    }

    let reported = parse_reported_limit(error_text);
    OverflowDetection {
        is_overflow: true,
        reported_limit: reported.map(|limit| limit.value),
        reported_limit_provenance: reported.map(|limit| limit.provenance),
        matched_pattern: matched.map(|pattern| pattern.source.to_string()),
    }
}

pub fn detect_overflow_value(error: &serde_json::Value) -> OverflowDetection {
    let message = extract_error_message(error);
    detect_overflow(&message)
}

pub fn parse_reported_limit(message: &str) -> Option<ReportedContextLimit> {
    if message.is_empty() {
        return None;
    }
    for pattern in limit_patterns() {
        let Some(captures) = pattern.regex.captures(message) else {
            continue;
        };
        let Some(raw) = captures.get(1).map(|m| m.as_str()) else {
            continue;
        };
        let Ok(value) = raw.parse::<u64>() else {
            continue;
        };
        if (MIN_PLAUSIBLE_CONTEXT_LIMIT..=MAX_PLAUSIBLE_CONTEXT_LIMIT).contains(&value) {
            return Some(ReportedContextLimit {
                value,
                provenance: pattern.provenance,
            });
        }
    }
    None
}

pub fn decide(inputs: &SchedulerInputs) -> SchedulerOutcome {
    let effective_context_limit = inputs.context_limit.or_else(|| {
        if inputs.usage.percentage > 0.0 && inputs.usage.input_tokens > 0.0 {
            Some(inputs.usage.input_tokens / (inputs.usage.percentage / 100.0))
        } else {
            None
        }
    });
    let threshold = resolve_execute_threshold(
        &inputs.config.execute_threshold_percentage,
        inputs.model_key.as_deref(),
        DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
        inputs.config.execute_threshold_tokens.as_ref(),
        effective_context_limit,
    );

    let ttl_ms = scheduler_ttl_ms(&inputs.session.cache_ttl);
    let idle_ttl_fired =
        ttl_hard_expired(inputs.now_ms, inputs.session.last_response_time_ms, ttl_ms);
    let base = should_execute(
        &inputs.config,
        &inputs.session,
        &inputs.usage,
        inputs.now_ms,
        inputs.model_key.as_deref(),
        inputs.context_limit,
    );
    let pressure_execute_requested =
        inputs.usage.percentage > 0.0 && inputs.usage.percentage >= threshold;
    let mut pass =
        if base == BaseDecision::Execute || idle_ttl_fired || inputs.deferred_execute.is_some() {
            PassDecision::Execute
        } else {
            PassDecision::Defer
        };

    // The soft percentage controls execute, force, and drain decisions; hard_wall_percentage controls only the absolute wall.
    pass = match derive_band_with_hard_wall(
        inputs.usage.percentage,
        inputs
            .usage
            .hard_wall_percentage
            .unwrap_or(inputs.usage.percentage),
        threshold,
    ) {
        Band::Emergency95 => PassDecision::Emergency95,
        Band::Force85 => PassDecision::Force85,
        Band::Normal => pass,
    };
    // A provider rejection of the session's wire shape requires the ≥95% emergency recovery path regardless of local usage.
    if inputs.emergency_recovery_armed && pass == PassDecision::Defer {
        pass = PassDecision::Emergency95;
    }

    let (pass, deferred_execute) = apply_boundary_deferral(
        pass,
        inputs.tail_state,
        inputs.deferred_execute.clone(),
        inputs.boundary_bypass,
    );
    let pressure_execute = pressure_execute_requested && pass != PassDecision::Defer;
    let drain_latch = advance_drain_latch(
        inputs.drain_latch,
        inputs.usage.percentage,
        threshold,
        inputs.now_ms,
    );
    let overflow_detection = inputs
        .overflow_error_text
        .as_deref()
        .map(detect_overflow)
        .filter(|detection| detection.is_overflow);
    let detected_limit = overflow_detection
        .as_ref()
        .and_then(|detection| detection.reported_limit);
    let detected_limit_provenance = overflow_detection
        .as_ref()
        .and_then(|detection| detection.reported_limit_provenance);

    SchedulerOutcome {
        pass,
        pressure_execute,
        idle_ttl_fired,
        drain_latch,
        deferred_execute,
        detected_limit,
        detected_limit_provenance,
    }
}

pub fn to_selection_pass_class(pass: PassDecision) -> PassClass {
    match pass {
        PassDecision::Defer => PassClass::Defer,
        PassDecision::Execute => PassClass::Execute,
        PassDecision::Force85 | PassDecision::Emergency95 => PassClass::EmergencyForce,
    }
}

fn scheduler_ttl_ms(cache_ttl: &str) -> u64 {
    parse_cache_ttl(cache_ttl).unwrap_or(DEFAULT_CACHE_TTL_MS)
}

fn is_finite_positive(value: f64) -> bool {
    value.is_finite() && value > 0.0
}

fn resolve_percentage_match(
    values: &BTreeMap<String, f64>,
    model_key: Option<&str>,
) -> Option<f64> {
    if let Some(model_key) = model_key {
        for candidate in model_key_lookup_order(model_key) {
            if let Some(value) = values.get(&candidate) {
                return Some(*value);
            }
        }
    }
    values.get("default").copied()
}

fn resolve_tokens_match(
    tokens: &ExecuteThresholdTokensConfig,
    model_key: Option<&str>,
) -> Option<(f64, String)> {
    if let Some(model_key) = model_key {
        for candidate in model_key_lookup_order(model_key) {
            if let Some(value) = tokens.values.get(&candidate) {
                return Some((*value, candidate));
            }
        }
    }
    tokens
        .values
        .get("default")
        .map(|value| (*value, "default".to_string()))
}

fn model_key_lookup_order(model_key: &str) -> Vec<String> {
    let slash = model_key.find('/');
    let provider = slash.map_or("", |idx| &model_key[..idx]);
    let mut model_id = slash.map_or(model_key, |idx| &model_key[idx + 1..]);
    let mut keys = Vec::new();

    while !model_id.is_empty() {
        if !provider.is_empty() {
            keys.push(format!("{provider}/{model_id}"));
        }
        keys.push(model_id.to_string());
        let Some(last_dash) = model_id.rfind('-') else {
            break;
        };
        if last_dash == 0 {
            break;
        }
        model_id = &model_id[..last_dash];
    }
    keys
}

fn compile_case_insensitive(source: &'static str) -> Regex {
    RegexBuilder::new(source)
        .case_insensitive(true)
        .build()
        .unwrap_or_else(|err| panic!("invalid regex {source:?}: {err}"))
}

fn overflow_patterns() -> &'static [CompiledPattern] {
    static PATTERNS: OnceLock<Vec<CompiledPattern>> = OnceLock::new();
    PATTERNS
        .get_or_init(|| {
            OVERFLOW_PATTERN_SOURCES
                .iter()
                .map(|source| CompiledPattern {
                    source,
                    regex: compile_case_insensitive(source),
                })
                .collect()
        })
        .as_slice()
}

fn limit_patterns() -> &'static [CompiledLimitPattern] {
    static PATTERNS: OnceLock<Vec<CompiledLimitPattern>> = OnceLock::new();
    PATTERNS
        .get_or_init(|| {
            LIMIT_EXTRACTION_PATTERN_SOURCES
                .iter()
                .map(|(source, provenance)| CompiledLimitPattern {
                    regex: compile_case_insensitive(source),
                    provenance: *provenance,
                })
                .collect()
        })
        .as_slice()
}

fn status_413_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b413\b").expect("valid 413 regex"))
}

fn status_413_context_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| compile_case_insensitive(r"(entity|payload|context|prompt)"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Golden {
        constants: GoldenConstants,
        parse_ttl_cases: Vec<ParseTtlCase>,
        threshold_cases: Vec<ThresholdCase>,
        should_execute_cases: Vec<ShouldExecuteCase>,
        ttl_predicate_cases: Vec<TtlPredicateCase>,
        overflow_cases: Vec<OverflowCase>,
        limit_cases: Vec<LimitCase>,
    }

    #[derive(Deserialize)]
    struct GoldenConstants {
        default_execute_threshold_percentage: f64,
        max_execute_threshold_percentage: f64,
        force_materialize_percentage: f64,
        emergency_percentage: f64,
        default_cache_ttl_ms: u64,
        one_second_ms: u64,
        one_minute_ms: u64,
        one_hour_ms: u64,
        bare_numeric_ms: u64,
        emergency_drain_enter_percentage: f64,
        emergency_drain_exit_margin: f64,
        emergency_drain_fallback_exit_percentage: f64,
        emergency_drain_failure_backoff_ms: u64,
        emergency_drain_max_latch_ms: u64,
        min_plausible_context_limit: u64,
        max_plausible_context_limit: u64,
        overflow_pattern_sources: Vec<String>,
    }

    #[derive(Deserialize)]
    struct ParseTtlCase {
        label: String,
        ttl: String,
        expected_ms: Option<u64>,
    }

    #[derive(Deserialize)]
    struct ThresholdCase {
        label: String,
        percentage_config: ExecuteThresholdConfig,
        tokens_config: Option<ExecuteThresholdTokensConfig>,
        model_key: Option<String>,
        fallback: f64,
        context_limit: Option<f64>,
        expected: f64,
    }

    #[derive(Deserialize)]
    struct ShouldExecuteCase {
        label: String,
        config: SchedulerConfig,
        session: SessionMeta,
        usage: ContextUsage,
        now_ms: u64,
        model_key: Option<String>,
        context_limit: Option<f64>,
        expected: String,
    }

    #[derive(Deserialize)]
    struct TtlPredicateCase {
        label: String,
        now_ms: u64,
        last_response_time_ms: u64,
        ttl_ms: u64,
        expected_execute_fired: bool,
        expected_hard_expired: bool,
    }

    #[derive(Deserialize)]
    struct OverflowCase {
        label: String,
        input: serde_json::Value,
        expected_message: String,
        expected: OverflowExpected,
    }

    #[derive(Deserialize)]
    struct OverflowExpected {
        is_overflow: bool,
        reported_limit: Option<u64>,
        reported_limit_provenance: Option<ContextLimitProvenance>,
        matched_pattern: Option<String>,
    }

    #[derive(Deserialize)]
    struct LimitCase {
        label: String,
        message: String,
        expected: Option<ReportedContextLimit>,
    }

    fn assert_close(got: f64, expected: f64, label: &str) {
        assert!(
            (got - expected).abs() < 1e-9,
            "{label}: got {got}, expected {expected}"
        );
    }

    fn base_inputs() -> SchedulerInputs {
        SchedulerInputs {
            config: SchedulerConfig::default(),
            usage: ContextUsage {
                percentage: 10.0,
                input_tokens: 10_000.0,
                hard_wall_percentage: None,
            },
            session: SessionMeta {
                last_response_time_ms: 1_000,
                cache_ttl: "5m".to_string(),
            },
            now_ms: 2_000,
            model_key: None,
            context_limit: None,
            tail_state: TailState::default(),
            deferred_execute: None,
            boundary_bypass: BoundaryBypass::default(),
            drain_latch: LatchState::default(),
            overflow_error_text: None,
            emergency_recovery_armed: false,
        }
    }

    #[test]
    fn scheduler_golden_matches_production_behaviour() {
        let raw = include_str!("../testdata/scheduler-golden.json");
        let golden: Golden = serde_json::from_str(raw).expect("parse scheduler-golden.json");

        assert_close(
            DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
            golden.constants.default_execute_threshold_percentage,
            "default execute threshold",
        );
        assert_close(
            MAX_EXECUTE_THRESHOLD_PERCENTAGE,
            golden.constants.max_execute_threshold_percentage,
            "max execute threshold",
        );
        assert_close(
            escalation_bands(DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE).force_materialize_percentage,
            golden.constants.force_materialize_percentage,
            "force materialize percentage",
        );
        assert_close(
            EMERGENCY_PERCENTAGE,
            golden.constants.emergency_percentage,
            "emergency percentage",
        );
        assert_eq!(DEFAULT_CACHE_TTL_MS, golden.constants.default_cache_ttl_ms);
        assert_eq!(1000, golden.constants.one_second_ms);
        assert_eq!(60_000, golden.constants.one_minute_ms);
        assert_eq!(3_600_000, golden.constants.one_hour_ms);
        assert_eq!(1234, golden.constants.bare_numeric_ms);
        assert_close(
            escalation_bands(DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE).force_materialize_percentage,
            golden.constants.emergency_drain_enter_percentage,
            "emergency drain enter",
        );
        assert_close(
            EMERGENCY_DRAIN_EXIT_MARGIN,
            golden.constants.emergency_drain_exit_margin,
            "emergency drain exit margin",
        );
        assert_close(
            EMERGENCY_DRAIN_FALLBACK_EXIT_PERCENTAGE,
            golden.constants.emergency_drain_fallback_exit_percentage,
            "emergency drain fallback exit",
        );
        assert_eq!(
            EMERGENCY_DRAIN_FAILURE_BACKOFF_MS,
            golden.constants.emergency_drain_failure_backoff_ms
        );
        assert_eq!(
            EMERGENCY_DRAIN_MAX_LATCH_MS,
            golden.constants.emergency_drain_max_latch_ms
        );
        assert_eq!(
            MIN_PLAUSIBLE_CONTEXT_LIMIT,
            golden.constants.min_plausible_context_limit
        );
        assert_eq!(
            MAX_PLAUSIBLE_CONTEXT_LIMIT,
            golden.constants.max_plausible_context_limit
        );
        assert_eq!(
            OVERFLOW_PATTERN_SOURCES,
            golden
                .constants
                .overflow_pattern_sources
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .as_slice()
        );

        for case in golden.parse_ttl_cases {
            let got = parse_cache_ttl(&case.ttl).ok();
            assert_eq!(got, case.expected_ms, "parse ttl {}", case.label);
        }

        for case in golden.threshold_cases {
            let got = resolve_execute_threshold(
                &case.percentage_config,
                case.model_key.as_deref(),
                case.fallback,
                case.tokens_config.as_ref(),
                case.context_limit,
            );
            assert_close(got, case.expected, &case.label);
        }

        for case in golden.should_execute_cases {
            let got = should_execute(
                &case.config,
                &case.session,
                &case.usage,
                case.now_ms,
                case.model_key.as_deref(),
                case.context_limit,
            );
            let expected = match case.expected.as_str() {
                "execute" => BaseDecision::Execute,
                "defer" => BaseDecision::Defer,
                other => panic!("unknown expected decision {other:?}"),
            };
            assert_eq!(got, expected, "should execute {}", case.label);
        }

        for case in golden.ttl_predicate_cases {
            assert_eq!(
                ttl_execute_fired(case.now_ms, case.last_response_time_ms, case.ttl_ms),
                case.expected_execute_fired,
                "scheduler ttl predicate {}",
                case.label
            );
            assert_eq!(
                ttl_hard_expired(case.now_ms, case.last_response_time_ms, case.ttl_ms),
                case.expected_hard_expired,
                "hard ttl predicate {}",
                case.label
            );
        }

        for case in golden.overflow_cases {
            let message = extract_error_message(&case.input);
            assert_eq!(message, case.expected_message, "extract {}", case.label);
            let got = detect_overflow_value(&case.input);
            assert_eq!(
                got.is_overflow, case.expected.is_overflow,
                "overflow flag {}",
                case.label
            );
            assert_eq!(
                got.reported_limit, case.expected.reported_limit,
                "reported limit {}",
                case.label
            );
            assert_eq!(
                got.reported_limit_provenance, case.expected.reported_limit_provenance,
                "reported limit provenance {}",
                case.label
            );
            assert_eq!(
                got.matched_pattern, case.expected.matched_pattern,
                "matched pattern {}",
                case.label
            );
        }

        for case in golden.limit_cases {
            assert_eq!(
                parse_reported_limit(&case.message),
                case.expected,
                "parse reported limit {}",
                case.label
            );
        }
    }

    #[test]
    fn band_boundaries_are_non_vacuous() {
        assert_eq!(derive_band(84.9, 65.0), Band::Normal);
        assert_eq!(derive_band(85.0, 65.0), Band::Force85);
        assert_eq!(derive_band(94.9, 90.0), Band::Force85);
        assert_eq!(derive_band(95.0, 90.0), Band::Emergency95);
    }

    #[test]
    fn split_geometry_keeps_force_soft_and_moves_only_the_absolute_wall() {
        assert_eq!(
            derive_band_with_hard_wall(96.0, 73.2, 65.0),
            Band::Force85,
            "soft pressure may force materialization before the provider wall"
        );
        assert_eq!(
            derive_band_with_hard_wall(96.0, 95.0, 65.0),
            Band::Emergency95
        );
    }

    #[test]
    fn absent_and_coinciding_hard_geometry_produce_identical_decision_bytes() {
        let absent = base_inputs();
        let mut coinciding = absent.clone();
        coinciding.usage.hard_wall_percentage = Some(coinciding.usage.percentage);

        let absent_bytes = serde_json::to_vec(&decide(&absent)).unwrap();
        let coinciding_bytes = serde_json::to_vec(&decide(&coinciding)).unwrap();
        assert_eq!(absent_bytes, coinciding_bytes);
    }

    #[test]
    fn escalation_bands_stay_ordered_above_execute_and_below_emergency() {
        for (threshold, expected_force) in [(65.0, 85.0), (80.0, 85.0), (88.0, 90.0), (90.0, 92.0)]
        {
            let bands = escalation_bands(threshold);
            assert_eq!(bands.force_materialize_percentage, expected_force);
            assert!(threshold < bands.force_materialize_percentage);
            assert!(bands.force_materialize_percentage >= 85.0);
            assert!(bands.force_materialize_percentage < 95.0);
            assert_eq!(bands.emergency_percentage, 95.0);
        }
    }

    #[test]
    fn pre_raise_thresholds_keep_the_exact_85_percent_force_band() {
        assert_eq!(escalation_bands(65.0).force_materialize_percentage, 85.0);
        assert_eq!(escalation_bands(80.0).force_materialize_percentage, 85.0);
    }

    #[test]
    fn durable_overflow_arm_upgrades_only_a_would_be_defer_to_emergency() {
        let mut inputs = base_inputs();
        inputs.emergency_recovery_armed = true;
        let forced = decide(&inputs);
        assert_eq!(forced.pass, PassDecision::Emergency95);

        inputs.usage.percentage = 70.0;
        inputs.usage.input_tokens = 70_000.0;
        let natural_execute = decide(&inputs);
        assert_eq!(natural_execute.pass, PassDecision::Execute);
    }

    #[test]
    fn boundary_deferral_records_retries_and_respects_bypasses() {
        let tail = TailState { mid_tool_use: true };
        let (decision, pending) =
            apply_boundary_deferral(PassDecision::Execute, tail, None, BoundaryBypass::default());
        assert_eq!(decision, PassDecision::Defer);
        assert!(pending.is_some(), "mid-tool execute must record an intent");

        let (decision, pending) = apply_boundary_deferral(
            PassDecision::Execute,
            TailState {
                mid_tool_use: false,
            },
            pending,
            BoundaryBypass::default(),
        );
        assert_eq!(decision, PassDecision::Execute);
        let pending = drain_deferred_after_work(pending, true);
        assert!(pending.is_none(), "successful work drains the retry intent");

        let (decision, pending) =
            apply_boundary_deferral(PassDecision::Force85, tail, None, BoundaryBypass::default());
        assert_eq!(decision, PassDecision::Force85);
        assert!(pending.is_none(), "force passes bypass mid-turn deferral");

        let (decision, pending) = apply_boundary_deferral(
            PassDecision::Execute,
            tail,
            None,
            BoundaryBypass {
                explicit_bust: false,
                subagent: true,
            },
        );
        assert_eq!(decision, PassDecision::Execute);
        assert!(
            pending.is_none(),
            "subagent passes bypass mid-turn deferral"
        );

        let failed = drain_deferred_after_work(Some(DeferredExecute::pending_execute()), false);
        assert!(failed.is_some(), "failed work keeps the retry intent");
    }

    #[test]
    fn latch_lifecycle_and_failure_backoff_are_distinct() {
        let t = 1_000_000;
        let entered = advance_drain_latch(LatchState::default(), 95.0, 65.0, t);
        assert_eq!(entered.active_since_ms, Some(t));

        let held = advance_drain_latch(entered, 90.0, 65.0, t + 1_000);
        assert_eq!(held, entered, "90% is above the 55% exit threshold");

        let exited = advance_drain_latch(held, 54.9, 65.0, t + 2_000);
        assert_eq!(exited.active_since_ms, None);

        let expired =
            advance_drain_latch(entered, 84.0, 65.0, t + EMERGENCY_DRAIN_MAX_LATCH_MS + 1);
        assert_eq!(expired.active_since_ms, None);

        let below_raised_band = advance_drain_latch(LatchState::default(), 91.0, 90.0, t);
        assert_eq!(below_raised_band.active_since_ms, None);
        let at_raised_band = advance_drain_latch(LatchState::default(), 92.0, 90.0, t);
        assert_eq!(at_raised_band.active_since_ms, Some(t));

        let failure_at = t + 10;
        assert!(
            !drain_bypass_allowed(entered, failure_at, t + 20),
            "recent failure suppresses only the bypass"
        );
        assert_eq!(
            advance_drain_latch(entered, 90.0, 65.0, t + 20),
            entered,
            "failure backoff must not deactivate the latch"
        );
        assert!(
            drain_bypass_allowed(
                entered,
                failure_at,
                failure_at + EMERGENCY_DRAIN_FAILURE_BACKOFF_MS
            ),
            "bypass resumes at the backoff boundary"
        );
    }

    #[test]
    fn decide_is_deterministic_for_identical_inputs() {
        let mut inputs = base_inputs();
        inputs.usage.percentage = 86.0;
        inputs.overflow_error_text =
            Some("This model's maximum context length is 128000 tokens".to_string());
        let first = decide(&inputs);
        let second = decide(&inputs);
        assert_eq!(first, second);
    }

    #[test]
    fn hard_idle_ttl_forces_execute_but_fresh_session_stays_deferred() {
        let mut inputs = base_inputs();
        inputs.session.last_response_time_ms = 1_000;
        inputs.session.cache_ttl = "5m".to_string();
        inputs.now_ms = 1_000 + DEFAULT_CACHE_TTL_MS + 1;
        let boundary = decide(&inputs);
        assert!(boundary.idle_ttl_fired);
        assert_eq!(boundary.pass, PassDecision::Execute);
        assert!(!boundary.pressure_execute);

        inputs.usage.percentage = 0.0;
        inputs.usage.input_tokens = 0.0;
        inputs.session.last_response_time_ms = 0;
        inputs.now_ms = DEFAULT_CACHE_TTL_MS + 1;
        let fresh = decide(&inputs);
        assert!(!fresh.idle_ttl_fired);
        assert_eq!(fresh.pass, PassDecision::Defer);
    }

    #[test]
    fn pending_execute_retries_after_tail_closes() {
        let mut inputs = base_inputs();
        inputs.deferred_execute = Some(DeferredExecute::pending_execute());
        inputs.tail_state.mid_tool_use = false;
        let outcome = decide(&inputs);
        assert_eq!(outcome.pass, PassDecision::Execute);
        assert!(outcome.deferred_execute.is_some());
        assert!(drain_deferred_after_work(outcome.deferred_execute, true).is_none());
    }

    #[test]
    fn pass_decision_maps_to_selection_vocabulary() {
        assert_eq!(
            to_selection_pass_class(PassDecision::Defer),
            PassClass::Defer
        );
        assert_eq!(
            to_selection_pass_class(PassDecision::Execute),
            PassClass::Execute
        );
        assert_eq!(
            to_selection_pass_class(PassDecision::Force85),
            PassClass::EmergencyForce
        );
        assert_eq!(
            to_selection_pass_class(PassDecision::Emergency95),
            PassClass::EmergencyForce
        );
    }

    #[test]
    fn parse_cache_ttl_never_returns_u64_max() {
        assert_eq!(parse_cache_ttl("never"), Ok(u64::MAX));
        assert_eq!(parse_cache_ttl("NEVER"), Ok(u64::MAX));
        assert_eq!(parse_cache_ttl(" never "), Ok(u64::MAX));
        assert_eq!(parse_cache_ttl("Never"), Ok(u64::MAX));
        assert_eq!(parse_cache_ttl("5m"), Ok(300_000));
        assert_eq!(parse_cache_ttl("bad-format"), Err(CacheTtlParseError));
    }

    #[test]
    fn never_ttl_predicates_are_always_false() {
        assert!(!ttl_execute_fired(u64::MAX, 0, u64::MAX));
        assert!(!ttl_execute_fired(1_000_000, 0, u64::MAX));
        assert!(!ttl_hard_expired(u64::MAX, 1, u64::MAX));
        assert!(!ttl_hard_expired(1_000_000, 1, u64::MAX));
    }

    #[test]
    fn never_ttl_scheduler_stays_deferred() {
        let mut inputs = base_inputs();
        inputs.session.last_response_time_ms = 1_000;
        inputs.session.cache_ttl = "never".to_string();
        inputs.now_ms = 1_000 + 10 * 24 * 60 * 60 * 1000;
        inputs.usage.percentage = 50.0;
        let outcome = decide(&inputs);
        assert!(!outcome.idle_ttl_fired);
        assert_eq!(outcome.pass, PassDecision::Defer);
    }
}
