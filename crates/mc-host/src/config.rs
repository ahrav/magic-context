//!

use std::path::PathBuf;
use std::time::Duration;

use crate::auth::{ServerProof, MAX_AUTH_MESSAGE_LEN, NONCE_LEN, PROOF_LEN};
use crate::connection_file::{
    ConnectionInfo, DAEMON_ID_LEN, KEY_LEN, MAX_CONNECTION_FILE_LEN, SCHEMA_VERSION,
};
use crate::wire::{HEADER_LEN, MAX_BODY_LEN, PROTOCOL_VERSION};

/// floor.
pub const MIN_RESIDENT_BYTES: u64 =
    MAX_BODY_LEN as u64 + EGRESS_RESERVED_BYTES + SCRATCH_RESERVED_BYTES;

pub(crate) const EGRESS_RESERVED_BYTES: u64 = MAX_BODY_LEN as u64 + HEADER_LEN as u64;

///
///
pub(crate) const SCRATCH_RESERVED_BYTES: u64 = (MAX_BODY_LEN as u64 * 5 / 2)
    + (6 * 1024 * 1024)
    + 256
    + (64 * 1024)
    + SYNAPSE_WAITER_HEADROOM_BYTES
    + RETAINED_METADATA_RESERVED_BYTES;

/// Startup rejects `max_waiting_queries >= 1` without this headroom.
pub(crate) const SYNAPSE_WAITER_HEADROOM_BYTES: u64 = 4 * (2 * 1024 * 1024 + 256);

/// Retained job metadata occupies this slice for the full retention window.
/// Validation excludes this slice when reserving parse and page capacity.
/// The reservation prevents a full retention set from starving the worst-case advertised request.
/// Without this reservation, retained metadata can leave insufficient capacity for an identical maximum-batch replay until expiry.
pub(crate) const RETAINED_METADATA_RESERVED_BYTES: u64 = 2 * 1024 * 1024;

/// `MAX_CONFIG_DURATION` bounds configured deadlines and periods to prevent `Instant + Duration` overflow panics.
/// Validation rejects unbounded durations such as `Duration::MAX` to prevent `Instant + Duration` overflow panics.
/// The one-year cap stays below the `Instant + Duration` overflow range.
pub const MAX_CONFIG_DURATION: Duration = Duration::from_secs(365 * 24 * 60 * 60);

/// The SHA-256 of zero bytes.
pub const UNSTAGED_PAYLOAD_MANIFEST_DIGEST: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// Each `HostLimits` field gates an independent resource class; exhausting one class does not consume another.
#[derive(Debug, Clone)]
pub struct HostLimits {
    /// The host closes excess unauthenticated sockets without reading client bytes.
    pub max_handshakes: usize,
    pub max_connections: usize,
    /// `max_routes` limits live routes across all connections and cannot exceed the `u16` channel namespace.
    /// namespace).
    pub max_routes: usize,
    /// `max_pending_requests` limits consumer requests admitted but not yet settled across all connections.
    pub max_pending_requests: usize,
    pub max_handler_tasks: usize,
    /// The cap includes inbound bodies, handler-owned request bodies, parser scratch, request-derived input ownership, encoded frames, writer queues, and handler-declared retained bytes.
    /// The limit accounts for named logical payloads, not exact process RSS.
    /// process-RSS claim.
    ///
    /// `max_resident_bytes` reserves [`EGRESS_RESERVED_BYTES`] for output and [`SCRATCH_RESERVED_BYTES`] for scratch; only the remaining capacity admits inbound frames.
    /// Increasing `max_resident_bytes` enlarges only the inbound admission pool; scratch capacity remains bounded by [`SCRATCH_RESERVED_BYTES`].
    /// Components that need more request scratch than [`SCRATCH_RESERVED_BYTES`] must declare limits that accommodate that scratch.
    /// `max_resident_bytes` must be at least [`MIN_RESIDENT_BYTES`].
    /// Startup requires catalog and retained reservations to leave capacity for one maximum ingress body.
    pub max_resident_bytes: u64,
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
            // The default `HostLimits` value assumes no component declares retained bytes.
            // The runtime subtracts the catalog reservation and each declared `retained_resident_bytes` from the resident-byte budget.
            // `HostLimits::default` cannot account for the components linked by a composite.
            // A composition with retained components must set its resident-byte budget explicitly.
            // The resident-byte budget must include the composition's floor plus all declared `retained_resident_bytes`.
            // Startup rejects composites whose resident-byte budget is below their floor plus declared retained bytes rather than over-offering ingress.
            max_resident_bytes: MIN_RESIDENT_BYTES + MAX_BODY_LEN as u64,
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
        // Tokio semaphores cap permits below `u32::MAX` on 32-bit targets; byte-granular charges must fit in that cap so `ByteBudget::new` cannot panic.
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

/// Each operation owns exactly one absolute deadline or period.
/// Stages within an operation share its deadline budget.
#[derive(Debug, Clone)]
pub struct HostTiming {
    /// The authentication deadline covers the whole three-message exchange for each accepted socket.
    pub auth_deadline: Duration,
    /// The frame deadline covers the remaining header and body after the first header byte arrives.
    /// Idle waiting between frames is unbounded (protocol §6.3).
    /// The frame deadline also bounds writing one dequeued frame to the consumer.
    /// The host retires a peer that stops reading instead of allowing it to pin shared egress budget indefinitely.
    /// budget indefinitely.
    pub frame_deadline: Duration,
    /// The budget covers bind, route-gone, initialization, and health callbacks; expiry is host-fatal.
    /// host-fatal.
    pub lifecycle_callback_deadline: Duration,
    /// The route-close budget settles or cancels one route's admitted work.
    pub route_close_budget: Duration,
    pub transport_setup_deadline: Duration,
    /// The shutdown deadline covers the whole graceful-shutdown drain.
    pub shutdown_deadline: Duration,
    pub health_interval: Duration,
}

impl Default for HostTiming {
    fn default() -> Self {
        Self {
            auth_deadline: Duration::from_secs(2),
            frame_deadline: Duration::from_secs(30),
            lifecycle_callback_deadline: Duration::from_secs(30),
            route_close_budget: Duration::from_secs(5),
            transport_setup_deadline: Duration::from_secs(2),
            shutdown_deadline: Duration::from_secs(10),
            health_interval: Duration::from_secs(30),
        }
    }
}

/// The host probes consumer liveness with Ping and client Pong.
///
/// Set `invalidate_on_missed` to false for clients that cannot answer Ping to preserve healthy long-running awaits.
/// Enabling `invalidate_on_missed` for clients that cannot answer Ping kills healthy long-running awaits.
#[derive(Debug, Clone)]
pub struct LivenessPolicy {
    pub ping_interval: Duration,
    pub pong_deadline: Duration,
    pub invalidate_on_missed: bool,
}

/// `HostInit` is a host-owned synthetic initialization payload handed to the linked handler.
/// The host hands the payload to the linked handler before the listener binds (protocol §8.1 steps 3–4).
#[derive(Clone, Default)]
pub struct HostInit {
    pub subc_capabilities: Vec<String>,
    /// Managed deployments pass an opaque resolved storage descriptor.
    /// The handler deserializes the descriptor; the host never reads it.
    pub storage: Option<serde_json::Value>,
}

impl std::fmt::Debug for HostInit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The storage descriptor can carry credentials or deployment metadata.
        // presence only.
        f.debug_struct("HostInit")
            .field("subc_capabilities", &self.subc_capabilities)
            .field("storage", &self.storage.is_some())
            .finish()
    }
}

#[derive(Debug, Clone)]
pub struct HostConfig {
    /// Diagnostics, including `HostConfig`'s derived `Debug`, report only whether storage is present.
    /// contains `cortexkit/run/subc-connection.json`.
    pub data_dir: Option<PathBuf>,
    /// The host publishes `daemon_ver` and echoes it in the authentication `ServerProof`.
    pub daemon_ver: String,
    /// `payload_manifest_digest` must contain 64 lowercase hex characters and defaults to `UNSTAGED_PAYLOAD_MANIFEST_DIGEST`.
    /// [`UNSTAGED_PAYLOAD_MANIFEST_DIGEST`].
    pub payload_manifest_digest: String,
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
            payload_manifest_digest: UNSTAGED_PAYLOAD_MANIFEST_DIGEST.to_owned(),
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
        if !crate::lifecycle::is_canonical_payload_digest(&self.payload_manifest_digest) {
            return Err(ConfigError::InvalidPayloadDigest {
                len: self.payload_manifest_digest.len(),
            });
        }
        // JSON serializes byte arrays as number arrays with one to three digits per byte, so sizing must use worst-case fills.
        // Validation must account for worst-case JSON byte-array encoding so generated bytes cannot exceed the caps at runtime.
        let auth_message_bytes = serde_json::to_vec(&ServerProof {
            daemon_id: [u8::MAX; DAEMON_ID_LEN],
            server_nonce: [u8::MAX; NONCE_LEN],
            daemon_ver: self.daemon_ver.clone(),
            server_proof: [u8::MAX; PROOF_LEN],
        })
        .expect("fixed auth shape serializes")
        .len();
        let connection_file_bytes = serde_json::to_vec_pretty(&ConnectionInfo {
            schema: SCHEMA_VERSION,
            wire_version: PROTOCOL_VERSION,
            setup_socket: "/tmp/mc-host.sock".to_owned(),
            key: vec![u8::MAX; KEY_LEN],
            daemon_id: [u8::MAX; DAEMON_ID_LEN],
            pid: u32::MAX,
            daemon_ver: self.daemon_ver.clone(),
        })
        .expect("fixed publication shape serializes")
        .len();
        if auth_message_bytes > MAX_AUTH_MESSAGE_LEN as usize
            || connection_file_bytes > MAX_CONNECTION_FILE_LEN
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
            (
                "transport_setup_deadline",
                self.timing.transport_setup_deadline,
            ),
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
    /// The error carries only the offending length to keep diagnostics bounded.
    InvalidPayloadDigest {
        len: usize,
    },
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
            Self::InvalidPayloadDigest { len } => write!(
                f,
                "payload_manifest_digest must be 64 lowercase hex characters; got {len} bytes"
            ),
            Self::DaemonVerTooLarge {
                auth_message_bytes,
                connection_file_bytes,
            } => write!(
                f,
                "daemon_ver makes auth/publication too large ({auth_message_bytes}/{connection_file_bytes} bytes)"
            ),
            Self::ResidentBytesBelowInteropMinimum { configured, minimum } => write!(
                f,
                "max_resident_bytes {configured} is below the host floor {minimum} \
                 (one maximum frame plus the egress and scratch reservations); \
                 raise max_resident_bytes to at least {minimum}"
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
    fn noncanonical_payload_digests_are_rejected() {
        for digest in [
            String::new(),
            "short".to_owned(),
            "E".repeat(64),
            "e".repeat(63),
            "e".repeat(65),
            format!("sha256:{}", "e".repeat(57)),
        ] {
            let config = HostConfig {
                payload_manifest_digest: digest.clone(),
                ..Default::default()
            };
            assert!(
                matches!(
                    config.validate(),
                    Err(ConfigError::InvalidPayloadDigest { .. })
                ),
                "digest {digest:?} must fail validation"
            );
        }
        HostConfig {
            payload_manifest_digest: "e".repeat(64),
            ..Default::default()
        }
        .validate()
        .expect("a canonical digest validates");
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
    fn the_resident_cap_splits_into_three_non_overlapping_pools() {
        let frame = MAX_BODY_LEN as u64;
        assert_eq!(
            MIN_RESIDENT_BYTES,
            frame + EGRESS_RESERVED_BYTES + SCRATCH_RESERVED_BYTES,
            "the floor must be exactly the sum of the three pools"
        );
        // `MIN_RESIDENT_BYTES` leaves one `MAX_BODY_LEN` after reserving the egress and scratch slices.
        let admission_at_floor =
            MIN_RESIDENT_BYTES - EGRESS_RESERVED_BYTES - SCRATCH_RESERVED_BYTES;
        assert_eq!(admission_at_floor, frame);
        // deployment tuning.
        let defaults = HostLimits::default();
        assert!(defaults.max_resident_bytes >= MIN_RESIDENT_BYTES);
        let admission_at_default =
            defaults.max_resident_bytes - EGRESS_RESERVED_BYTES - SCRATCH_RESERVED_BYTES;
        assert!(admission_at_default > frame);
        // egress guarantees.
        assert!(
            admission_at_default - frame > 0,
            "catalog headroom comes out of admission, not the reserved slices"
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
