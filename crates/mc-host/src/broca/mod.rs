//! The Broca LLM-runner component: the third fixed `management_surface`
//! target of the direct profile (R1), implementing exactly the five
//! operations `HistorianProducer` consumes — `session.send`,
//! `session.subscribe`, `run.status`, `run.cancel`, and `session.delete`
//! (R3, R28).
//!
//! The component is the thin host adapter: it validates route identity at
//! bind (R4), strictly decodes each body before any state exists (R3), and
//! translates between `RequestCtx` and the [`supervisor::Supervisor`], which
//! owns every run, cap, replay log, and lifecycle decision.

pub mod backend;
pub mod config;
pub mod opencode;
pub mod pi;
pub mod protocol;
pub mod subprocess;
pub mod supervisor;

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};

use crate::composite::{CompositeComponent, SecondaryComponent, ShutdownError};
use crate::handler::{
    BindOutcome, HealthReport, HealthStatus, InitError, ManifestSnapshot, RequestCtx,
    RequestOutcome, ResourceDeclaration, RouteClass, RouteHandle, RouteIdentity,
};
use subtle::ConstantTimeEq;

use backend::{Harness, LlmExecutionBackend};
use protocol::{Request, RequestError};
use subprocess::EnvSnapshot;
use supervisor::{SessionKey, Supervisor};

pub const BROCA_MODULE_ID: &str = "broca";

pub struct BrocaComponent {
    supervisor: Arc<Supervisor>,
    /// Route handle -> bind-validated session key. Requests carry only the
    /// handle, so this map is how a body-less identity (subscribe, delete)
    /// resolves its session scope.
    routes: Arc<Mutex<HashMap<RouteHandle, SessionKey>>>,
    route_fingerprints: Arc<Mutex<HashMap<RouteHandle, BTreeMap<String, String>>>>,
    credential_verifier: Option<Arc<CredentialVerifier>>,
}

struct CredentialVerifier {
    env: EnvSnapshot,
    key: OnceLock<[u8; 32]>,
}

impl CredentialVerifier {
    fn verify(
        &self,
        harness: Harness,
        provider: &str,
        presented: &BTreeMap<String, String>,
    ) -> Result<(), &'static str> {
        let key = self.key.get().ok_or("credential_snapshot_mismatch")?;
        let harness_name = match harness {
            Harness::OpenCode => "opencode",
            Harness::Pi => "pi",
        };
        // The same alias map used for row selection and fingerprint
        // derivation; a divergent local copy here would look presented
        // fingerprints up under a name the client never binds.
        let canonical = subprocess::canonical_provider(harness_name, provider)
            .map_err(|error| error.subreason())?;
        let expected = self
            .env
            .credential_fingerprint(key, harness_name, provider)
            .map_err(|error| error.subreason())?;
        let actual = presented
            .get(canonical)
            .ok_or("credential_snapshot_mismatch")?;
        if expected.as_bytes().ct_eq(actual.as_bytes()).into() {
            Ok(())
        } else {
            Err("credential_snapshot_mismatch")
        }
    }
}

impl BrocaComponent {
    pub fn new(backend: Arc<dyn LlmExecutionBackend>) -> Self {
        Self {
            supervisor: Arc::new(Supervisor::new(backend)),
            routes: Arc::new(Mutex::new(HashMap::new())),
            route_fingerprints: Arc::new(Mutex::new(HashMap::new())),
            credential_verifier: None,
        }
    }

    pub fn new_with_credentials(backend: Arc<dyn LlmExecutionBackend>, env: EnvSnapshot) -> Self {
        Self {
            supervisor: Arc::new(Supervisor::new(backend)),
            routes: Arc::new(Mutex::new(HashMap::new())),
            route_fingerprints: Arc::new(Mutex::new(HashMap::new())),
            credential_verifier: Some(Arc::new(CredentialVerifier {
                env,
                key: OnceLock::new(),
            })),
        }
    }

    /// The shared supervisor, cloned by tests before the component moves
    /// into a composite so caps and charges stay observable from outside
    /// the running host.
    pub fn supervisor(&self) -> Arc<Supervisor> {
        Arc::clone(&self.supervisor)
    }

    /// Shared route-map handle for teardown observation, cloned before the component moves into its composite like [`BrocaComponent::supervisor`]; metrics carry no route-mapping count.
    pub fn route_index(&self) -> Arc<Mutex<HashMap<RouteHandle, SessionKey>>> {
        Arc::clone(&self.routes)
    }

    fn key_of_route(&self, route: RouteHandle) -> Option<SessionKey> {
        self.routes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&route)
            .cloned()
    }
}

fn request_error(error: RequestError) -> RequestOutcome {
    RequestOutcome::error(error.code, error.message)
}

fn app_error(code: &str, message: &str) -> RequestOutcome {
    RequestOutcome::error(code, message)
}

async fn respond(ctx: &RequestCtx, body: Vec<u8>) -> RequestOutcome {
    let Ok(mut output) = ctx.reserve_output(body.len()).await else {
        return app_error("internal_error", "output reservation failed");
    };
    if output.extend_from_slice(&body).is_err() {
        return app_error("internal_error", "output reservation too small");
    }
    RequestOutcome::Response {
        body: output,
        binary: false,
    }
}

impl CompositeComponent for BrocaComponent {
    fn install_connection_key(&self, key: [u8; 32]) {
        if let Some(verifier) = &self.credential_verifier {
            let _ = verifier.key.set(key);
        }
    }

    fn manifest(&self) -> ManifestSnapshot {
        ManifestSnapshot {
            module_id: BROCA_MODULE_ID.to_owned(),
            module_version: env!("CARGO_PKG_VERSION").to_owned(),
            provides: vec![serde_json::json!({"role": "management_surface"})],
            control_ops: Vec::new(),
        }
    }

    fn resources(&self) -> ResourceDeclaration {
        // The fixed reserved-class declaration (R13, KTD2): 96 pending, 96
        // tasks, and the 64 MiB retained budget the supervisor enforces
        // internally plus the two retention classes that live outside that
        // budget — the route-identity map and live backend transcript
        // capture. Constants rather than limits so a test-shrunken
        // supervisor still declares the product contract.
        ResourceDeclaration {
            reserved_handler_tasks: config::RESERVED_HANDLER_TASKS,
            reserved_pending_requests: config::RESERVED_PENDING_REQUESTS,
            retained_resident_bytes: config::DECLARED_RETAINED_RESIDENT_BYTES,
            general_task_hold_bound: 0,
            route_class: RouteClass::Reserved,
        }
    }

    async fn bind(&self, route: RouteHandle, identity: RouteIdentity) -> BindOutcome {
        // R4: the route claims scope runs but grants no authority, so the
        // only checks are the ones the supervisor's key needs to be
        // well-formed. Messages stay value-free (R19).
        if identity.project_root.as_os_str().is_empty() || !identity.project_root.is_absolute() {
            return BindOutcome::Reject {
                code: "invalid_identity".to_owned(),
                message: "project_root must be a nonempty absolute path".to_owned(),
            };
        }
        if identity.session.is_empty() {
            return BindOutcome::Reject {
                code: "invalid_identity".to_owned(),
                message: "session must be nonempty".to_owned(),
            };
        }
        let Some(harness) = Harness::parse(&identity.harness) else {
            return BindOutcome::Reject {
                code: "invalid_identity".to_owned(),
                message: "harness must be \"opencode\" or \"pi\"".to_owned(),
            };
        };
        let key = SessionKey {
            project_root: identity.project_root,
            harness,
            session: identity.session,
        };
        let credential_fingerprints = identity.credential_fingerprints;
        let mut routes = self
            .routes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // The declared route-identity headroom covers exactly
        // MAX_BOUND_ROUTES identities; binding past it would retain bytes
        // outside the published reservation whenever the host's own route
        // limit is configured higher.
        if routes.len() >= config::MAX_BOUND_ROUTES && !routes.contains_key(&route) {
            return BindOutcome::Reject {
                code: "queue_full".to_owned(),
                message: "broca route capacity is exhausted".to_owned(),
            };
        }
        routes.insert(route, key);
        self.route_fingerprints
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(route, credential_fingerprints);
        BindOutcome::Accept
    }

    async fn handle(&self, ctx: RequestCtx) -> RequestOutcome {
        let Some(key) = self.key_of_route(ctx.route) else {
            return app_error("internal_error", "route is not bound to a broca session");
        };
        // Parser scratch is reserved BEFORE decoding (KTD2): `parse_request`
        // materializes owned prompt/system/model strings up to the body
        // size, and up to the full callback fan-in could otherwise hold
        // those copies outside the resident-byte budget before learning the
        // pool is exhausted. The reservation depends only on the body
        // length, so decode strictness is unchanged for admitted requests;
        // the supervisor charges only what it retains.
        let Some(_scratch) = ctx.try_reserve_resident(ctx.body.len() + 512) else {
            return app_error(
                "queue_full",
                "resident capacity for request handling is exhausted",
            );
        };
        let request = match protocol::parse_request(&ctx.body, ctx.binary) {
            Ok(request) => request,
            Err(error) => return request_error(error),
        };
        match request {
            Request::Send(send) => {
                // Contract precedence (`harness_unavailable.reasons_by_precedence`):
                // descriptor_absent, descriptor_invalid, closure_incomplete, and
                // argument_variant_invalid all rank ahead of every credential
                // reason. The backend owns that verdict, so it is asked before the
                // credential snapshot is verified — otherwise a startup with no
                // usable descriptor and no provider row answered
                // `credential_missing`, which names a remedy that cannot fix the
                // descriptor the run actually lacks.
                if let Some(reason) = self.supervisor.harness_unavailable_reason(key.harness) {
                    return app_error("harness_unavailable", reason);
                }
                if let Some(verifier) = &self.credential_verifier {
                    let fingerprints = self
                        .route_fingerprints
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .get(&ctx.route)
                        .cloned()
                        .unwrap_or_default();
                    if let Err(reason) = verifier.verify(key.harness, &send.provider, &fingerprints)
                    {
                        return app_error("harness_unavailable", reason);
                    }
                }
                match self.supervisor.send(&key, send, &ctx.body) {
                    Ok(run_id) => respond(&ctx, protocol::send_response_body(&run_id)).await,
                    Err(error) => request_error(error),
                }
            }
            Request::Status { run_id } => match self.supervisor.status(&key, &run_id) {
                Ok(state) => respond(&ctx, protocol::status_response_body(&run_id, state)).await,
                Err(error) => request_error(error),
            },
            Request::Cancel { run_id } => match self.supervisor.cancel(&key, &run_id).await {
                Ok(()) => respond(&ctx, protocol::ok_response_body()).await,
                Err(error) => request_error(error),
            },
            Request::Delete => match self.supervisor.delete(&key).await {
                Ok(()) => respond(&ctx, protocol::ok_response_body()).await,
                Err(error) => request_error(error),
            },
            Request::Subscribe => {
                let mut subscription = match self.supervisor.subscribe(&key) {
                    Ok(subscription) => subscription,
                    Err(error) => return request_error(error),
                };
                loop {
                    let unit = tokio::select! {
                        biased;
                        // Request cancellation detaches only this waiter
                        // (R9): the subscription drops below and the run
                        // continues untouched.
                        () = ctx.cancelled() => break,
                        unit = subscription.next() => unit,
                    };
                    let Some(unit) = unit else { break };
                    let Ok(mut item) = ctx.reserve_output(unit.len()).await else {
                        break;
                    };
                    if item.extend_from_slice(&unit).is_err() {
                        break;
                    }
                    if ctx.stream(item, false).await.is_err() {
                        // Route closure or TCP loss: same detach rule.
                        break;
                    }
                }
                RequestOutcome::Streamed
            }
        }
    }

    async fn route_gone(&self, route: RouteHandle) {
        // The host has already completed or force-aborted this route's
        // request tasks, which dropped their `Subscription` waiters; only
        // the identity mapping remains to clean up. Runs outlive their
        // routes by design (R9).
        self.routes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&route);
        self.route_fingerprints
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&route);
    }

    async fn health(&self) -> HealthReport {
        HealthReport {
            status: HealthStatus::Ok,
            detail: None,
            metrics: Some(serde_json::json!({"broca_state": "ready"})),
        }
    }

    async fn shutdown(&self) -> Result<(), ShutdownError> {
        let unresolved = self.supervisor.shutdown().await;
        self.routes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.route_fingerprints
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        // Local state is drained either way, but a run whose process-group
        // teardown was never proven may leave a provider descendant alive —
        // and its crash record names this still-live process as owner, so a
        // successor host skips it as live and never sweeps the orphan. The
        // shutdown must fail so the runtime reports the host as not
        // gracefully drained instead of vouching for work it cannot prove
        // stopped.
        if unresolved > 0 {
            return Err(ShutdownError(format!(
                "{unresolved} run(s) ended without confirming harness \
                 process-group teardown; provider work may still be running"
            )));
        }
        Ok(())
    }
}

impl SecondaryComponent for BrocaComponent {
    async fn initialize(&self) -> Result<(), InitError> {
        // The crash-ownership registry proves process identity through
        // Linux `/proc` semantics (stat starttime, boot_id, group-member
        // scans). No other platform provides those proofs, so the
        // component refuses to initialize with a named platform error
        // instead of surfacing an incidental `/proc` read failure from the
        // sweep — and the post-spawn registration path that would kill
        // every run before prompt delivery stays unreachable.
        if cfg!(not(target_os = "linux")) {
            return Err(InitError(
                "broca requires Linux: crash-ownership records and sweeps \
                 depend on /proc process identity"
                    .to_owned(),
            ));
        }
        // No artifact to load: the deterministic or subprocess backend was
        // constructed by the caller, and run state is process-local (R11).
        //
        // Kill harness process groups a crashed predecessor left behind.
        // This belongs here, not in `new`: initialization runs after the
        // runtime holds the exclusive instance lock, so the predecessor is
        // provably gone. Sweeping at construction would race — a
        // predecessor still alive then has its entries skipped (live
        // owner), and if it crashes while the successor is still retrying
        // the lock, nothing would ever sweep them.
        //
        // A sweep that cannot prove it finished fails startup rather than
        // proceeding: recovery treats an unknown run as `missing` and may
        // refire it, so an unverified registry could let a duplicate
        // billable run race a surviving provider descendant. Refusing to
        // start is recoverable; a double-billed refire is not.
        subprocess::group_registry::sweep_orphaned_groups().map_err(|err| {
            InitError(format!(
                "broca could not sweep crash-orphaned process groups: {err}"
            ))
        })?;
        // Same pass, same reason: a crash skips PrivateDir cleanup, leaving
        // a run's hidden prompt and transcript on disk (R17/R19).
        subprocess::group_registry::sweep_orphaned_run_dirs().map_err(|err| {
            InitError(format!(
                "broca could not sweep crash-orphaned run directories: {err}"
            ))
        })?;
        Ok(())
    }
}
