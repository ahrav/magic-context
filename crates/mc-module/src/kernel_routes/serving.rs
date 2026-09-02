//! Numeric serving policy from kh8.1 R12d: a gated read past either lag
//! threshold is served as stale or abstained rather than fresh.

use mc_kernel::OutboxLag;

/// Published outbox positions the slowest required consumer may trail by.
pub const LAG_POSITION_THRESHOLD: i64 = 10_000;
/// Age of the oldest unconsumed outbox row, in milliseconds.
pub const LAG_AGE_THRESHOLD_MS: i64 = 60_000;

/// True at or past either threshold. `None` lag, meaning no registered
/// consumer, never trips; that case is reported as `no_required_consumer`.
pub fn lag_threshold_tripped(lag: &OutboxLag) -> bool {
    lag.position_lag
        .is_some_and(|positions| positions >= LAG_POSITION_THRESHOLD)
        || lag
            .oldest_unconsumed_age_ms
            .is_some_and(|age| age >= LAG_AGE_THRESHOLD_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lag(positions: Option<i64>, age: Option<i64>) -> OutboxLag {
        OutboxLag {
            position_lag: positions,
            oldest_unconsumed_age_ms: age,
            consumer_count: u64::from(positions.is_some()),
        }
    }

    #[test]
    fn thresholds_are_inclusive_and_absent_lag_never_trips() {
        assert!(!lag_threshold_tripped(&lag(Some(9_999), Some(59_999))));
        assert!(lag_threshold_tripped(&lag(Some(10_000), Some(0))));
        assert!(lag_threshold_tripped(&lag(Some(0), Some(60_000))));
        assert!(!lag_threshold_tripped(&lag(None, None)));
    }
}
