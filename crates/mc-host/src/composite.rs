//!
//! The host `RouteRegistry` exclusively owns route lifecycle and channel reuse.
//! The host `RouteRegistry` exclusively owns route reservation, liveness, closing, and finalization.
//! The route map records only ownership of host-validated handles.
//! A route-map entry is inserted before the child's `bind` call.
//! A route-map entry remains until the child's `route_gone` callback returns.
//!
//! The direct profile's primary is `magic-context/tool_provider`.
//! The direct profile's secondary is `synapse/management_surface`.
//! The direct profile's tertiary is `broca/management_surface`.
//! The direct profile publishes its primary, secondary, and tertiary entries in that order.
//! Generic component types let tests substitute deterministic children.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;

use crate::config::HostInit;
use crate::handler::{
    BindOutcome, HealthReport, HealthStatus, InitError, ManifestSnapshot, McHostHandler,
    RequestCtx, RequestOutcome, ResourceDeclaration, RouteHandle, RouteIdentity, RouteTarget,
};

/// The composite reports a `ShutdownError` message's byte length, not its contents.
/// Diagnostics report only the `ShutdownError` message's byte length under protocol V24.
/// Reporting only the byte length prevents component detail from reaching host logs.
/// A component may include detailed diagnostics in `ShutdownError` because host logs report only its byte length.
#[derive(Debug)]
pub struct ShutdownError(pub String);

impl std::fmt::Display for ShutdownError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "component shutdown failed: {}", self.0)
    }
}

impl std::error::Error for ShutdownError {}

/// `CompositeComponent` has no shared `initialize` method because each role has a different initialization input.
pub trait CompositeComponent: Send + Sync + 'static {
    fn manifest(&self) -> ManifestSnapshot;

    fn install_connection_key(&self, _key: [u8; 32]) {}

    /// `resources` declares immutable resources before initialization.
    /// The default returns no resource reservation.
    /// No resource reservation preserves general single-pool admission for existing components.
    fn resources(&self) -> ResourceDeclaration {
        ResourceDeclaration::default()
    }

    fn bind(
        &self,
        route: RouteHandle,
        identity: RouteIdentity,
    ) -> impl Future<Output = BindOutcome> + Send;

    fn handle(&self, ctx: RequestCtx) -> impl Future<Output = RequestOutcome> + Send;

    fn route_gone(&self, route: RouteHandle) -> impl Future<Output = ()> + Send;

    fn health(&self) -> impl Future<Output = HealthReport> + Send;

    /// The composite drains all remaining children before returning a failure.
    /// The composite returns one deterministic redacted shutdown failure after draining all children.
    fn shutdown(&self) -> impl Future<Output = Result<(), ShutdownError>> + Send;
}

pub trait PrimaryComponent: CompositeComponent {
    fn initialize(&self, init: HostInit) -> impl Future<Output = Result<(), InitError>> + Send;

    /// `activate` defaults to `Ok(())` for components without deferred activation.
    fn activate(&self) -> impl Future<Output = Result<(), InitError>> + Send {
        async { Ok(()) }
    }
}

/// A missing or invalid artifact resolves to `Ok(())` with the component disabled.
/// An artifact-disabled component rejects `bind` with `artifact_invalid`.
/// An artifact-disabled component remains published in the catalog.
/// `Err` is reserved for host-fatal invariant failures.
pub trait SecondaryComponent: CompositeComponent {
    fn initialize(&self) -> impl Future<Output = Result<(), InitError>> + Send;

    fn activate(&self) -> impl Future<Output = Result<(), InitError>> + Send {
        async { Ok(()) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Child {
    Primary,
    Secondary,
    Tertiary,
}

pub struct StaticComposite<P, S, B> {
    primary: P,
    secondary: S,
    tertiary: B,
    primary_id: Box<str>,
    secondary_id: Box<str>,
    tertiary_id: Box<str>,
    routes: Mutex<HashMap<RouteHandle, Child>>,
}

impl<P: PrimaryComponent, S: SecondaryComponent, B: SecondaryComponent> StaticComposite<P, S, B> {
    /// Duplicate module IDs are rejected to keep bind dispatch unambiguous.
    pub fn new(primary: P, secondary: S, tertiary: B) -> Result<Self, InitError> {
        let primary_id = primary.manifest().module_id.into_boxed_str();
        let secondary_id = secondary.manifest().module_id.into_boxed_str();
        let tertiary_id = tertiary.manifest().module_id.into_boxed_str();
        if primary_id == secondary_id || primary_id == tertiary_id || secondary_id == tertiary_id {
            return Err(InitError(
                "composite components share one module ID".to_owned(),
            ));
        }
        Ok(Self {
            primary,
            secondary,
            tertiary,
            primary_id,
            secondary_id,
            tertiary_id,
            routes: Mutex::new(HashMap::new()),
        })
    }

    fn child_of_route(&self, route: RouteHandle) -> Option<Child> {
        self.routes
            .lock()
            .expect("composite route map")
            .get(&route)
            .copied()
    }
}

fn severity(status: HealthStatus) -> u8 {
    match status {
        HealthStatus::Ok => 0,
        HealthStatus::Degraded => 1,
        HealthStatus::Failing => 2,
    }
}

/// `catch_child_panic` converts a panic while polling `future` into `Err(payload)`.
/// A child callback panic is returned as `Err(payload)` instead of unwinding through `catch_child_panic`.
async fn catch_child_panic<F: Future>(
    future: F,
) -> Result<F::Output, Box<dyn std::any::Any + Send + 'static>> {
    let mut future = std::pin::pin!(future);
    std::future::poll_fn(move |cx| {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| future.as_mut().poll(cx))) {
            Ok(poll) => poll.map(Ok),
            Err(payload) => std::task::Poll::Ready(Err(payload)),
        }
    })
    .await
}

/// The composite records only the byte length of each returned shutdown error.
/// Panic payloads are dropped entirely.
fn shutdown_failure_note(
    id: &str,
    outcome: Result<Result<(), ShutdownError>, Box<dyn std::any::Any + Send + 'static>>,
) -> Option<String> {
    match outcome {
        Ok(Ok(())) => None,
        Ok(Err(err)) => Some(format!(
            "{id} shutdown failed ({} bytes of detail redacted)",
            err.0.len()
        )),
        Err(_payload) => Some(format!("{id} shutdown panicked")),
    }
}

impl<P: PrimaryComponent, S: SecondaryComponent, B: SecondaryComponent> McHostHandler
    for StaticComposite<P, S, B>
{
    fn install_connection_key(&self, key: [u8; 32]) {
        self.primary.install_connection_key(key);
        self.secondary.install_connection_key(key);
        self.tertiary.install_connection_key(key);
    }

    fn manifests(&self) -> Vec<ManifestSnapshot> {
        vec![
            self.primary.manifest(),
            self.secondary.manifest(),
            self.tertiary.manifest(),
        ]
    }

    fn resource_declarations(&self) -> Vec<ResourceDeclaration> {
        // Resource declarations use the same deterministic order as `manifests`.
        vec![
            self.primary.resources(),
            self.secondary.resources(),
            self.tertiary.resources(),
        ]
    }

    async fn initialize(&self, init: HostInit) -> Result<(), InitError> {
        // Independent children initialize concurrently; primary, then secondary, then tertiary errors win when initializers fail in the same poll.
        tokio::try_join!(
            biased;
            self.primary.initialize(init),
            self.secondary.initialize(),
            self.tertiary.initialize()
        )?;
        Ok(())
    }

    async fn activate(&self) -> Result<(), InitError> {
        // Children activate concurrently; when activations fail in the same poll, primary, then secondary, then tertiary errors take precedence.
        tokio::try_join!(
            biased;
            self.primary.activate(),
            self.secondary.activate(),
            self.tertiary.activate()
        )?;
        Ok(())
    }

    async fn bind(
        &self,
        route: RouteHandle,
        target: RouteTarget,
        identity: RouteIdentity,
    ) -> BindOutcome {
        let child = if target.module_id == self.primary_id.as_ref() {
            Child::Primary
        } else if target.module_id == self.secondary_id.as_ref() {
            Child::Secondary
        } else if target.module_id == self.tertiary_id.as_ref() {
            Child::Tertiary
        } else {
            return BindOutcome::Reject {
                code: crate::control::CODE_TARGET_UNAVAILABLE.to_owned(),
                message: "target module is not part of this composition".to_owned(),
            };
        };
        // The map records the target child before `bind` so `route_gone` can dispatch if the route closes while `bind` is pending.
        self.routes
            .lock()
            .expect("composite route map")
            .insert(route, child);
        match child {
            Child::Primary => self.primary.bind(route, identity).await,
            Child::Secondary => self.secondary.bind(route, identity).await,
            Child::Tertiary => self.tertiary.bind(route, identity).await,
        }
    }

    async fn handle(&self, ctx: RequestCtx) -> RequestOutcome {
        match self.child_of_route(ctx.route) {
            Some(Child::Primary) => self.primary.handle(ctx).await,
            Some(Child::Secondary) => self.secondary.handle(ctx).await,
            Some(Child::Tertiary) => self.tertiary.handle(ctx).await,
            None => RequestOutcome::error(
                crate::control::CODE_INTERNAL_ERROR,
                "route is not mapped to a component",
            ),
        }
    }

    async fn route_gone(&self, route: RouteHandle) {
        let child = self.child_of_route(route);
        match child {
            Some(Child::Primary) => self.primary.route_gone(route).await,
            Some(Child::Secondary) => self.secondary.route_gone(route).await,
            Some(Child::Tertiary) => self.tertiary.route_gone(route).await,
            None => return,
        }
        // `route_gone` removes a route only after the dispatched child callback returns.
        self.routes
            .lock()
            .expect("composite route map")
            .remove(&route);
    }

    async fn health(&self) -> HealthReport {
        let primary = self.primary.health().await;
        let panicked = |id: &str| HealthReport {
            status: HealthStatus::Failing,
            detail: Some(format!("{id} health check panicked")),
            metrics: None,
        };
        let secondary = catch_child_panic(self.secondary.health())
            .await
            .unwrap_or_else(|_payload| panicked(&self.secondary_id));
        let tertiary = catch_child_panic(self.tertiary.health())
            .await
            .unwrap_or_else(|_payload| panicked(&self.tertiary_id));
        // `Ok < Degraded < Failing`; equal severities use catalog order: primary, secondary, then tertiary.
        // child.
        let component_status = |report: &HealthReport| match report.status {
            HealthStatus::Ok => "ok",
            HealthStatus::Degraded => "degraded",
            HealthStatus::Failing => "failing",
        };
        let mut components = serde_json::Map::new();
        for (id, report) in [
            (self.primary_id.as_ref(), &primary),
            (self.secondary_id.as_ref(), &secondary),
            (self.tertiary_id.as_ref(), &tertiary),
        ] {
            components.insert(
                id.to_owned(),
                serde_json::json!({
                    "status": component_status(report),
                    "metrics": report.metrics.clone(),
                }),
            );
        }
        let metrics = serde_json::json!({"components": components});
        let mut winner = primary;
        for candidate in [secondary, tertiary] {
            if severity(candidate.status) > severity(winner.status) {
                winner = candidate;
            }
        }
        winner.metrics = Some(metrics);
        winner
    }

    async fn shutdown(&self) {
        // An earlier failure does not skip later children's drains.
        // cleanly returned.
        let mut failures: Vec<String> = Vec::new();
        let outcomes = [
            shutdown_failure_note(
                &self.tertiary_id,
                catch_child_panic(self.tertiary.shutdown()).await,
            ),
            shutdown_failure_note(
                &self.secondary_id,
                catch_child_panic(self.secondary.shutdown()).await,
            ),
            shutdown_failure_note(
                &self.primary_id,
                catch_child_panic(self.primary.shutdown()).await,
            ),
        ];
        failures.extend(outcomes.into_iter().flatten());
        if !failures.is_empty() {
            panic!("{}", failures.join("; "));
        }
    }
}
