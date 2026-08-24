use std::fmt;

/// Close states in required teardown order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseState {
    /// Traffic admission and publication are enabled.
    Open,
    /// New admission has stopped.
    Quiescing,
    /// Already-published frames are draining.
    DrainingPublished,
    /// New environment work has stopped.
    StoppingEnvScheduling,
    /// JavaScript aliases are being detached on environment thread.
    RevokingJsOnEnv,
    /// N-API asynchronous cleanup is joining native workers.
    AsyncCleanupJoin,
    /// Lexical Rust receive scopes are draining.
    AwaitingRustScopes,
    /// Backend samples are being released.
    ReleasingSamples,
    /// Transport mappings and objects are being dropped.
    DroppingTransport,
    /// All workers and mappings joined successfully.
    Joined,
    /// Alias state is uncertain and storage can never be reused.
    Quarantined,
}

/// Checked close state machine.
pub struct Lifecycle {
    state: CloseState,
    prepared: bool,
}

impl Lifecycle {
    /// Creates an open lifecycle before provider preparation.
    pub const fn new() -> Self {
        Self {
            state: CloseState::Open,
            prepared: false,
        }
    }

    /// Marks irreversible provider preparation boundary.
    pub fn mark_prepared(&mut self) -> Result<(), LifecycleError> {
        if self.state != CloseState::Open || self.prepared {
            return Err(LifecycleError::InvalidTransition);
        }
        self.prepared = true;
        Ok(())
    }

    /// Whether failure must remain on selected provider without replay.
    pub const fn must_fail_closed(&self) -> bool {
        self.prepared
    }

    /// Current state.
    pub const fn state(&self) -> CloseState {
        self.state
    }

    /// Advances exactly one edge from lifecycle state diagram.
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

    /// Whether storage may be reused after close.
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

/// Invalid lifecycle operation.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum LifecycleError {
    /// Requested edge is absent from state diagram.
    InvalidTransition,
    /// Joined and quarantined states are terminal.
    Terminal,
}

impl fmt::Debug for LifecycleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, formatter)
    }
}

impl fmt::Display for LifecycleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidTransition => "invalid lifecycle transition",
            Self::Terminal => "lifecycle state is terminal",
        })
    }
}

impl std::error::Error for LifecycleError {}
