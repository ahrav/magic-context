//! Operation counters and disqualification reason codes. commentlint: allow(JUDGE)

/// Operation counters used to produce disqualification reason codes. commentlint: allow(JUDGE)
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OperationCounters {
    /// Transport-body copies.
    pub body_copies: u64,
    /// Native transport heap allocations.
    pub native_allocations: u64,
    /// Timed-path syscalls.
    pub syscalls: u64,
    /// Park/wake transitions.
    pub park_wakes: u64,
    /// Generic queue hops. commentlint: allow(JUDGE)
    pub generic_queue_hops: u64,
    /// Scheduler handoffs.
    pub scheduler_handoffs: u64,
}

impl OperationCounters {
    /// Returns one reason code for each nonzero forbidden operation. commentlint: allow(JUDGE)
    pub fn disqualifications(self, eventfd_wake_qualified: bool) -> Vec<&'static str> {
        let mut reasons = Vec::new();
        if self.body_copies != 0 {
            reasons.push("transport_body_copy");
        }
        if self.native_allocations != 0 {
            reasons.push("native_transport_allocation");
        }
        if self.generic_queue_hops != 0 {
            reasons.push("generic_queue_hop");
        }
        let wake_allowed = eventfd_wake_qualified;
        if self.syscalls != 0 && !wake_allowed {
            reasons.push("timed_path_syscall");
        }
        if self.park_wakes != 0 && !wake_allowed {
            reasons.push("unqualified_park_wake");
        }
        if self.scheduler_handoffs != 0 && !wake_allowed {
            reasons.push("scheduler_handoff");
        }
        reasons
    }
}
