//! Finite host configuration and limits.
//!
//! Every capacity in the host is bounded by a value here. Defaults are
//! production-plausible; tests inject smaller values for determinism. CLI or
//! config-file exposure of these knobs belongs to the spawn/doctor integration
//! (`magic-context-c50.8`), not this crate.

use std::path::PathBuf;
use std::time::Duration;

use crate::wire::MAX_BODY_LEN;

/// One maximum inbound body and one maximum encoded outbound frame must coexist:
/// a handler can stream before releasing its request body.
pub const MIN_RESIDENT_BYTES: u64 = (MAX_BODY_LEN as u64 * 2) + subc_protocol::HEADER_LEN as u64;

/// Capacity reserved exclusively for encoded output, preventing an admitted
/// request from consuming the permits its own terminal needs.
pub(crate) const EGRESS_RESERVED_BYTES: u64 =
    MAX_BODY_LEN as u64 + subc_protocol::HEADER_LEN as u64;

/// Upper bound for every configured deadline and period. `Instant + Duration`
/// panics on overflow, so unbounded values such as `Duration::MAX` must be
/// rejected at validation instead of crashing the published host when a
/// deadline is armed. One year exceeds any plausible operational deadline
/// while staying far below overflow range.
pub const MAX_CONFIG_DURATION: Duration = Duration::from_secs(365 * 24 * 60 * 60);

/// Capacity limits for one host incarnation. All limits are independent gates:
/// exhausting one class never consumes another (protocol §5.1, §8.3).
#[derive(Debug, Clone)]
pub struct HostLimits {
    /// Sockets admitted but not yet authenticated. Excess accepts are closed
    /// without reading any client byte.
    pub max_handshakes: usize,
    /// Authenticated connection generations.
    pub max_connections: usize,
    /// Live routes across every connection (also bounded by the u16 channel
    /// namespace).
    pub max_routes: usize,
    /// Consumer requests admitted but not yet settled, across all connections.
    pub max_pending_requests: usize,
    /// Concurrently running handler request tasks.
    pub max_handler_tasks: usize,
    /// Aggregate bytes simultaneously resident in inbound bodies, handler-owned
    /// request bodies, encoded frames, and writer queues. Must be at least
    /// [`MIN_RESIDENT_BYTES`].
    pub max_resident_bytes: u64,
    /// Encoded frames queued per connection writer.
    pub writer_queue_frames: usize,
}

impl Default for HostLimits {
    fn default() -> Self {
        Self {
            max_handshakes: 32,
            max_connections: 64,
            max_routes: 1024,
            max_pending_requests: 1024,
            max_handler_tasks: 256,
            max_resident_bytes: 256 * 1024 * 1024,
            writer_queue_frames: 64,
        }
    }
}

impl HostLimits {
    pub fn validate(&self) -> Result<(), ConfigError> {
        let zeros = [
            ("max_handshakes", self.max_handshakes),
            ("max_connections", self.max_connections),
            ("max_routes", self.max_routes),
            ("max_pending_requests", self.max_pending_requests),
            ("max_handler_tasks", self.max_handler_tasks),
            ("writer_queue_frames", self.writer_queue_frames),
        ];
        for (name, value) in zeros {
            if value == 0 {
                return Err(ConfigError::ZeroLimit { name });
            }
            if value > tokio::sync::Semaphore::MAX_PERMITS {
                return Err(ConfigError::LimitTooLarge {
                    name,
                    configured: value,
                    maximum: tokio::sync::Semaphore::MAX_PERMITS,
                });
            }
        }
        if self.max_routes > u16::MAX as usize {
            return Err(ConfigError::LimitTooLarge {
                name: "max_routes",
                configured: self.max_routes,
                maximum: u16::MAX as usize,
            });
        }
        if self.max_resident_bytes < MIN_RESIDENT_BYTES {
            return Err(ConfigError::ResidentBytesBelowInteropMinimum {
                configured: self.max_resident_bytes,
                minimum: MIN_RESIDENT_BYTES,
            });
        }
        // Tokio semaphores hold at most usize::MAX >> 3 permits (below
        // u32::MAX on 32-bit targets); byte-granular charges must fit so
        // `ByteBudget::new` cannot panic, and single acquisitions use u32
        // counts.
        let max_budget_bytes = (tokio::sync::Semaphore::MAX_PERMITS as u64).min(u32::MAX as u64);
        if self.max_resident_bytes > max_budget_bytes {
            return Err(ConfigError::ResidentBytesTooLarge {
                configured: self.max_resident_bytes,
                maximum: max_budget_bytes,
            });
        }
        Ok(())
    }
}

/// Absolute deadlines and periods. Every operation owns exactly one deadline;
/// stages within it share the same budget (protocol §11).
#[derive(Debug, Clone)]
pub struct HostTiming {
    /// Whole three-message authentication exchange per accepted socket.
    pub auth_deadline: Duration,
    /// Remaining header plus body once the first header byte of a frame
    /// arrives. Idle waiting between frames is unbounded (protocol §6.3).
    /// Also bounds writing one dequeued frame to the consumer: a peer that
    /// stops reading is retired rather than allowed to pin shared egress
    /// budget indefinitely.
    pub frame_deadline: Duration,
    /// Bind, route-gone, initialization, and health callback budget; expiry is
    /// host-fatal (plan KTD9).
    pub lifecycle_callback_deadline: Duration,
    /// Settling or cancelling one route's admitted work at route close.
    pub route_close_budget: Duration,
    /// Whole graceful-shutdown drain.
    pub shutdown_deadline: Duration,
    /// Period between internal handler health probes.
    pub health_interval: Duration,
}

impl Default for HostTiming {
    fn default() -> Self {
        Self {
            auth_deadline: Duration::from_secs(2),
            frame_deadline: Duration::from_secs(30),
            lifecycle_callback_deadline: Duration::from_secs(30),
            route_close_budget: Duration::from_secs(5),
            shutdown_deadline: Duration::from_secs(10),
            health_interval: Duration::from_secs(30),
        }
    }
}

/// Consumer liveness probing (host Ping / client Pong).
///
/// `invalidate_on_missed` stays `false` until the raw Rust historian client can
/// answer Ping (`magic-context-c50.4`); enabling it before then would kill
/// healthy long-running awaits (protocol §9.3).
#[derive(Debug, Clone)]
pub struct LivenessPolicy {
    pub ping_interval: Duration,
    pub pong_deadline: Duration,
    pub invalidate_on_missed: bool,
}

/// Host-owned synthetic initialization payload handed to the linked handler
/// before the listener binds (protocol §8.1 step 3-4).
#[derive(Clone, Default)]
pub struct HostInit {
    pub subc_capabilities: Vec<String>,
    /// Opaque resolved storage descriptor, when deployment configures managed
    /// storage. The handler deserializes it; the host never reads it.
    pub storage: Option<serde_json::Value>,
}

impl std::fmt::Debug for HostInit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The storage descriptor can carry credentials or deployment
        // secrets; diagnostics (including HostConfig's derived Debug) get
        // presence and bounded structure only (protocol V24).
        f.debug_struct("HostInit")
            .field("subc_capabilities", &self.subc_capabilities)
            .field("storage", &self.storage.is_some())
            .finish()
    }
}

#[derive(Debug, Clone)]
pub struct HostConfig {
    /// Overrides `${XDG_DATA_HOME:-~/.local/share}` as the data root that
    /// contains `cortexkit/run/subc-connection.json`.
    pub data_dir: Option<PathBuf>,
    /// Published as `daemon_ver` and echoed in the auth `ServerProof`.
    pub daemon_ver: String,
    pub init: HostInit,
    pub limits: HostLimits,
    pub timing: HostTiming,
    /// `None` sends no Pings at all.
    pub liveness: Option<LivenessPolicy>,
}

impl Default for HostConfig {
    fn default() -> Self {
        Self {
            data_dir: None,
            daemon_ver: format!("mc-host/{}", env!("CARGO_PKG_VERSION")),
            init: HostInit::default(),
            limits: HostLimits::default(),
            timing: HostTiming::default(),
            liveness: None,
        }
    }
}

impl HostConfig {
    pub fn validate(&self) -> Result<(), ConfigError> {
        self.limits.validate()?;
        if self.daemon_ver.is_empty() {
            return Err(ConfigError::EmptyDaemonVer);
        }
        // Byte arrays serialize as JSON number arrays whose length depends on
        // the values ("0" is one char, "255" is three), so sizing must use
        // worst-case fills or a validated daemon_ver can exceed the caps at
        // runtime depending on the generated bytes.
        let auth_message_bytes = serde_json::to_vec(&subc_transport::ServerProof {
            daemon_id: [u8::MAX; subc_transport::DAEMON_ID_LEN],
            server_nonce: [u8::MAX; subc_transport::NONCE_LEN],
            daemon_ver: self.daemon_ver.clone(),
            server_proof: [u8::MAX; subc_transport::PROOF_LEN],
        })
        .expect("fixed auth shape serializes")
        .len();
        let connection_file_bytes = serde_json::to_vec_pretty(&subc_transport::ConnectionInfo {
            schema: subc_transport::SCHEMA_VERSION,
            wire_version: Some(subc_protocol::PROTOCOL_VERSION),
            endpoints: vec![subc_transport::Endpoint {
                host: "127.0.0.1".to_owned(),
                port: u16::MAX,
            }],
            key: vec![u8::MAX; subc_transport::KEY_LEN],
            daemon_id: [u8::MAX; subc_transport::DAEMON_ID_LEN],
            pid: u32::MAX,
            daemon_ver: self.daemon_ver.clone(),
        })
        .expect("fixed publication shape serializes")
        .len();
        if auth_message_bytes > subc_transport::MAX_AUTH_MESSAGE_LEN as usize
            || connection_file_bytes > 65_536
        {
            return Err(ConfigError::DaemonVerTooLarge {
                auth_message_bytes,
                connection_file_bytes,
            });
        }
        let durations = [
            ("auth_deadline", self.timing.auth_deadline),
            ("frame_deadline", self.timing.frame_deadline),
            (
                "lifecycle_callback_deadline",
                self.timing.lifecycle_callback_deadline,
            ),
            ("route_close_budget", self.timing.route_close_budget),
            ("shutdown_deadline", self.timing.shutdown_deadline),
            ("health_interval", self.timing.health_interval),
        ];
        for (name, value) in durations {
            if value.is_zero() {
                return Err(ConfigError::ZeroDuration { name });
            }
            if value > MAX_CONFIG_DURATION {
                return Err(ConfigError::DurationTooLarge { name });
            }
        }
        if let Some(liveness) = &self.liveness {
            if liveness.ping_interval.is_zero() || liveness.pong_deadline.is_zero() {
                return Err(ConfigError::ZeroDuration {
                    name: "liveness period",
                });
            }
            if liveness.ping_interval > MAX_CONFIG_DURATION
                || liveness.pong_deadline > MAX_CONFIG_DURATION
            {
                return Err(ConfigError::DurationTooLarge {
                    name: "liveness period",
                });
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    ZeroLimit {
        name: &'static str,
    },
    LimitTooLarge {
        name: &'static str,
        configured: usize,
        maximum: usize,
    },
    ZeroDuration {
        name: &'static str,
    },
    DurationTooLarge {
        name: &'static str,
    },
    EmptyDaemonVer,
    DaemonVerTooLarge {
        auth_message_bytes: usize,
        connection_file_bytes: usize,
    },
    ResidentBytesBelowInteropMinimum {
        configured: u64,
        minimum: u64,
    },
    ResidentBytesTooLarge {
        configured: u64,
        maximum: u64,
    },
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ZeroLimit { name } => write!(f, "host limit {name} must be nonzero"),
            Self::LimitTooLarge {
                name,
                configured,
                maximum,
            } => write!(
                f,
                "host limit {name} is {configured}; supported maximum is {maximum}"
            ),
            Self::ZeroDuration { name } => write!(f, "host duration {name} must be nonzero"),
            Self::DurationTooLarge { name } => write!(
                f,
                "host duration {name} exceeds the supported maximum of {} seconds",
                MAX_CONFIG_DURATION.as_secs()
            ),
            Self::EmptyDaemonVer => write!(f, "daemon_ver must be nonempty"),
            Self::DaemonVerTooLarge {
                auth_message_bytes,
                connection_file_bytes,
            } => write!(
                f,
                "daemon_ver makes auth/publication too large ({auth_message_bytes}/{connection_file_bytes} bytes)"
            ),
            Self::ResidentBytesBelowInteropMinimum { configured, minimum } => write!(
                f,
                "max_resident_bytes {configured} cannot hold one maximum request and response; need at least {minimum}"
            ),
            Self::ResidentBytesTooLarge { configured, maximum } => write!(
                f,
                "max_resident_bytes {configured} exceeds supported maximum {maximum}"
            ),
        }
    }
}

impl std::error::Error for ConfigError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_validate() {
        HostConfig::default().validate().expect("defaults valid");
    }

    #[test]
    fn zero_limits_rejected() {
        let limits = HostLimits {
            max_routes: 0,
            ..Default::default()
        };
        assert_eq!(
            limits.validate(),
            Err(ConfigError::ZeroLimit { name: "max_routes" })
        );
    }

    #[test]
    fn byte_budget_below_interop_minimum_rejected() {
        let mut limits = HostLimits {
            max_resident_bytes: MIN_RESIDENT_BYTES - 1,
            ..Default::default()
        };
        assert!(matches!(
            limits.validate(),
            Err(ConfigError::ResidentBytesBelowInteropMinimum { .. })
        ));
        limits.max_resident_bytes = MIN_RESIDENT_BYTES;
        limits.validate().expect("exact minimum accepted");
    }

    #[test]
    fn oversize_byte_budget_rejected() {
        let limits = HostLimits {
            max_resident_bytes: u32::MAX as u64 + 1,
            ..Default::default()
        };
        assert!(matches!(
            limits.validate(),
            Err(ConfigError::ResidentBytesTooLarge { .. })
        ));
    }

    #[test]
    fn constructor_capacity_bounds_are_validated() {
        let too_many_routes = HostLimits {
            max_routes: u16::MAX as usize + 1,
            ..Default::default()
        };
        assert!(matches!(
            too_many_routes.validate(),
            Err(ConfigError::LimitTooLarge {
                name: "max_routes",
                ..
            })
        ));

        let too_many_tasks = HostLimits {
            max_handler_tasks: tokio::sync::Semaphore::MAX_PERMITS + 1,
            ..Default::default()
        };
        assert!(matches!(
            too_many_tasks.validate(),
            Err(ConfigError::LimitTooLarge {
                name: "max_handler_tasks",
                ..
            })
        ));
    }

    #[test]
    fn daemon_version_boundary_keeps_auth_and_discovery_readable() {
        let mut first_rejected = None;
        for len in 1..=10_000 {
            let config = HostConfig {
                daemon_ver: "v".repeat(len),
                ..Default::default()
            };
            if matches!(
                config.validate(),
                Err(ConfigError::DaemonVerTooLarge { .. })
            ) {
                first_rejected = Some(len);
                break;
            }
        }
        let first_rejected = first_rejected.expect("a finite auth cap exists");
        HostConfig {
            daemon_ver: "v".repeat(first_rejected - 1),
            ..Default::default()
        }
        .validate()
        .expect("the exact accepted boundary is usable");
        assert!(matches!(
            HostConfig {
                daemon_ver: "v".repeat(first_rejected),
                ..Default::default()
            }
            .validate(),
            Err(ConfigError::DaemonVerTooLarge { .. })
        ));
    }

    #[test]
    fn zero_durations_rejected() {
        let mut config = HostConfig::default();
        config.timing.shutdown_deadline = Duration::ZERO;
        assert!(matches!(
            config.validate(),
            Err(ConfigError::ZeroDuration { .. })
        ));
    }

    #[test]
    fn overflowing_durations_rejected() {
        let mut config = HostConfig::default();
        config.timing.shutdown_deadline = Duration::MAX;
        assert!(matches!(
            config.validate(),
            Err(ConfigError::DurationTooLarge {
                name: "shutdown_deadline"
            })
        ));

        let config = HostConfig {
            liveness: Some(LivenessPolicy {
                ping_interval: Duration::from_secs(30),
                pong_deadline: Duration::MAX,
                invalidate_on_missed: false,
            }),
            ..Default::default()
        };
        assert!(matches!(
            config.validate(),
            Err(ConfigError::DurationTooLarge { .. })
        ));

        let mut config = HostConfig::default();
        config.timing.shutdown_deadline = MAX_CONFIG_DURATION;
        config.validate().expect("exact maximum accepted");
    }
}
