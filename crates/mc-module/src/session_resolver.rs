use std::{error::Error, fmt, path::Path};

use async_trait::async_trait;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSession {
    pub session_id: String,
    pub last_traffic_ms: i64,
}

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

#[async_trait]
pub trait SessionResolver: Send + Sync {
    async fn resolve_session(
        &self,
        project_root: &Path,
        harness: &str,
        instance_token: &str,
    ) -> Result<Option<ResolvedSession>, SessionResolveError>;
}

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
