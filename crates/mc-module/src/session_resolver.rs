//! Session lookup abstraction for mapping harness instances to durable sessions.

use std::{error::Error, fmt, path::Path};

use async_trait::async_trait;

/// Session identity and its last observed traffic time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSession {
    pub session_id: String,
    /// Unix epoch timestamp in milliseconds.
    pub last_traffic_ms: i64,
}

/// Failure to query or validate a session mapping.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionResolveError {
    Timeout,
    Transport(String),
    InvalidResponse(String),
}

impl fmt::Display for SessionResolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Timeout => write!(f, "session.resolve timed out"),
            Self::Transport(message) => write!(f, "session.resolve transport failed: {message}"),
            Self::InvalidResponse(message) => {
                write!(f, "session.resolve returned an invalid response: {message}")
            }
        }
    }
}

impl Error for SessionResolveError {}

/// Resolves one project, harness, and instance token to its current session.
#[async_trait]
pub trait SessionResolver: Send + Sync {
    /// Returns `Ok(None)` when no mapping exists.
    /// The resolver reports timeout, transport, and invalid-response failures separately.
    async fn resolve_session(
        &self,
        project_root: &Path,
        harness: &str,
        instance_token: &str,
    ) -> Result<Option<ResolvedSession>, SessionResolveError>;
}

/// Resolver used when session mapping is unsupported.
///
/// Every lookup returns local absence without network or filesystem access.
pub struct MissingSessionResolver;

#[async_trait]
impl SessionResolver for MissingSessionResolver {
    async fn resolve_session(
        &self,
        _project_root: &Path,
        _harness: &str,
        _instance_token: &str,
    ) -> Result<Option<ResolvedSession>, SessionResolveError> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unsupported_mapping_is_local_absence() {
        assert_eq!(
            MissingSessionResolver
                .resolve_session(Path::new("/project"), "claude-code", "instance")
                .await
                .unwrap(),
            None
        );
    }
}
