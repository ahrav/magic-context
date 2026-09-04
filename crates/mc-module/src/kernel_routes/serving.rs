//! Numeric serving policy from kh8.1 R12d: a gated read past either lag
//! threshold is served as stale or abstained rather than fresh.
//!
//! The store phase is judged before any read reaches this module, by
//! [`super::KernelOpenCoordinator::kernel_store`]; the policy here starts from
//! an open store's lag facts.

use mc_kernel::{OutboxLag, Surface};

use super::{KernelOutcome, UnavailableReason};

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

/// What a gated read may serve, before the surface decides how to say it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServingDecision {
    Available,
    Lagging {
        lag_positions: i64,
        oldest_unconsumed_age_ms: i64,
    },
    Unavailable(UnavailableReason),
}

/// Freshness cannot be judged without a consumer, so an empty consumer set is
/// unavailable rather than trivially fresh; with consumers, either threshold
/// makes the read lagging.
pub fn decide(lag: &OutboxLag) -> ServingDecision {
    if lag.consumer_count == 0 {
        return ServingDecision::Unavailable(UnavailableReason::NoRequiredConsumer);
    }
    if lag_threshold_tripped(lag) {
        return ServingDecision::Lagging {
            lag_positions: lag.position_lag.unwrap_or(0),
            oldest_unconsumed_age_ms: lag.oldest_unconsumed_age_ms.unwrap_or(0),
        };
    }
    ServingDecision::Available
}

/// Explicit search reports why it cannot serve fresh rows; an automatic
/// surface only abstains, because an injection path has no user to show a
/// reason to and must not inject on an unjudged store.
pub fn project(decision: ServingDecision, surface: Surface) -> KernelOutcome {
    match (decision, surface) {
        (ServingDecision::Available, _) => KernelOutcome::Available,
        (
            ServingDecision::Lagging {
                lag_positions,
                oldest_unconsumed_age_ms,
            },
            Surface::ExplicitSearch,
        ) => KernelOutcome::Stale {
            lag_positions,
            oldest_unconsumed_age_ms,
        },
        (
            ServingDecision::Lagging {
                lag_positions,
                oldest_unconsumed_age_ms,
            },
            Surface::AutoSearch | Surface::AutoInject,
        ) => KernelOutcome::Abstained {
            lag_positions,
            oldest_unconsumed_age_ms,
        },
        (ServingDecision::Unavailable(reason), Surface::ExplicitSearch) => {
            KernelOutcome::unavailable(reason)
        }
        (ServingDecision::Unavailable(_), Surface::AutoSearch | Surface::AutoInject) => {
            KernelOutcome::Abstained {
                lag_positions: 0,
                oldest_unconsumed_age_ms: 0,
            }
        }
    }
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

    #[test]
    fn decision_order_is_consumers_then_thresholds() {
        assert_eq!(
            decide(&lag(None, None)),
            ServingDecision::Unavailable(UnavailableReason::NoRequiredConsumer)
        );
        assert_eq!(
            decide(&lag(Some(9_999), Some(59_999))),
            ServingDecision::Available
        );
        assert_eq!(
            decide(&lag(Some(10_000), Some(5))),
            ServingDecision::Lagging {
                lag_positions: 10_000,
                oldest_unconsumed_age_ms: 5
            }
        );
        assert_eq!(
            decide(&lag(Some(1), Some(60_000))),
            ServingDecision::Lagging {
                lag_positions: 1,
                oldest_unconsumed_age_ms: 60_000
            }
        );
        // A consumer registered against an empty outbox has a count but no age.
        let registered_only = OutboxLag {
            position_lag: Some(LAG_POSITION_THRESHOLD),
            oldest_unconsumed_age_ms: None,
            consumer_count: 1,
        };
        assert_eq!(
            decide(&registered_only),
            ServingDecision::Lagging {
                lag_positions: LAG_POSITION_THRESHOLD,
                oldest_unconsumed_age_ms: 0
            }
        );
    }

    #[test]
    fn lagging_is_stale_on_explicit_search_and_abstained_on_automatic_surfaces() {
        let lagging = ServingDecision::Lagging {
            lag_positions: 10_000,
            oldest_unconsumed_age_ms: 7,
        };
        assert_eq!(
            project(lagging, Surface::ExplicitSearch),
            KernelOutcome::Stale {
                lag_positions: 10_000,
                oldest_unconsumed_age_ms: 7
            }
        );
        for surface in [Surface::AutoSearch, Surface::AutoInject] {
            assert_eq!(
                project(lagging, surface),
                KernelOutcome::Abstained {
                    lag_positions: 10_000,
                    oldest_unconsumed_age_ms: 7
                }
            );
        }
        for surface in Surface::ALL {
            assert_eq!(
                project(ServingDecision::Available, *surface),
                KernelOutcome::Available
            );
        }
    }

    #[test]
    fn an_unavailable_decision_names_its_reason_only_to_explicit_search() {
        let missing = ServingDecision::Unavailable(UnavailableReason::NoRequiredConsumer);
        assert_eq!(
            project(missing, Surface::ExplicitSearch),
            KernelOutcome::unavailable(UnavailableReason::NoRequiredConsumer)
        );
        for surface in [Surface::AutoSearch, Surface::AutoInject] {
            assert_eq!(
                project(missing, surface),
                KernelOutcome::Abstained {
                    lag_positions: 0,
                    oldest_unconsumed_age_ms: 0
                }
            );
        }
    }
}
