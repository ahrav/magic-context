use std::fmt;

/// Ordered shutdown stage.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseState {
    /// The lifecycle admits and publishes traffic.
    Open,
    /// New admission has stopped.
    Quiescing,
    /// Already-published frames are draining.
    DrainingPublished,
    /// New environment work has stopped.
    StoppingEnvScheduling,
    /// The environment thread detaches JavaScript aliases.
    RevokingJsOnEnv,
    /// N-API asynchronous cleanup is joining native workers.
    AsyncCleanupJoin,
    /// Lexical Rust receive scopes are draining.
    AwaitingRustScopes,
    /// The lifecycle releases backend samples.
    ReleasingSamples,
    /// The lifecycle drops transport mappings and objects.
    DroppingTransport,
    /// Shutdown completed and storage can be reused.
    Joined,
    /// Storage can never be reused after `Quarantined`.
    Quarantined,
}

/// Validates shutdown transitions and tracks prepared setup.
pub struct Lifecycle {
    state: CloseState,
    prepared: bool,
}

impl Lifecycle {
    /// Starts unprepared in [`CloseState::Open`].
    pub const fn new() -> Self {
        Self {
            state: CloseState::Open,
            prepared: false,
        }
    }

    /// Marks setup complete once while lifecycle remains open.
    pub fn mark_prepared(&mut self) -> Result<(), LifecycleError> {
        if self.state != CloseState::Open || self.prepared {
            return Err(LifecycleError::InvalidTransition);
        }
        self.prepared = true;
        Ok(())
    }

    /// Reports whether setup requires fail-closed cleanup.
    pub const fn must_fail_closed(&self) -> bool {
        self.prepared
    }

    /// Current state.
    pub const fn state(&self) -> CloseState {
        self.state
    }

    /// Advances one permitted shutdown edge.
    pub fn advance(&mut self, next: CloseState) -> Result<(), LifecycleError> {
        let valid = matches!(
            (self.state, next),
            (CloseState::Open, CloseState::Quiescing)
                | (CloseState::Quiescing, CloseState::DrainingPublished)
                | (
                    CloseState::DrainingPublished,
                    CloseState::StoppingEnvScheduling
                )
                | (
                    CloseState::StoppingEnvScheduling,
                    CloseState::RevokingJsOnEnv
                )
                | (CloseState::RevokingJsOnEnv, CloseState::AsyncCleanupJoin)
                | (CloseState::RevokingJsOnEnv, CloseState::Quarantined)
                | (CloseState::AsyncCleanupJoin, CloseState::AwaitingRustScopes)
                | (CloseState::AwaitingRustScopes, CloseState::ReleasingSamples)
                | (CloseState::ReleasingSamples, CloseState::DroppingTransport)
                | (CloseState::DroppingTransport, CloseState::Joined)
        );
        if !valid {
            return Err(
                if matches!(self.state, CloseState::Joined | CloseState::Quarantined) {
                    LifecycleError::Terminal
                } else {
                    LifecycleError::InvalidTransition
                },
            );
        }
        self.state = next;
        Ok(())
    }

    /// Permits reuse only after [`CloseState::Joined`].
    pub fn reusable(&self) -> bool {
        self.state == CloseState::Joined
    }
}

impl Default for Lifecycle {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for Lifecycle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Lifecycle")
            .field("state", &self.state)
            .field("prepared", &self.prepared)
            .finish()
    }
}

/// Reports rejected lifecycle transitions.
#[derive(thiserror::Error, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleError {
    /// Requested edge is outside ordered shutdown.
    #[error("invalid lifecycle transition")]
    InvalidTransition,
    /// Current state cannot transition further.
    #[error("lifecycle state is terminal")]
    Terminal,
}

impl fmt::Debug for LifecycleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, formatter)
    }
}
