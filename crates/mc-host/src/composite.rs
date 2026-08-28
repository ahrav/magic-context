//! Static three-component composition.
//!
//! The composite is dispatch metadata only: the host `RouteRegistry` remains
//! the sole owner of route reservation, liveness, closing, finalization,
//! cancellation, and channel reuse. The route map here answers exactly one
//! question — which child owns a handle the host already validated — and an
//! entry lives from just before the child's bind until that child's
//! route-gone callback returns.
//!
//! The direct profile's occupants are fixed (plan KTD1): the primary is
//! `magic-context/tool_provider`, the secondary is
//! `synapse/management_surface`, and the tertiary is
//! `broca/management_surface`, published in that deterministic catalog
//! order. The composite itself stays generic over the component types so
//! tests can substitute deterministic children.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;

use crate::config::HostInit;
use crate::handler::{
    BindOutcome, HealthReport, HealthStatus, InitError, ManifestSnapshot, McHostHandler,
    RequestCtx, RequestOutcome, ResourceDeclaration, RouteHandle, RouteIdentity, RouteTarget,
};

/// Typed child shutdown failure. The composite never surfaces the message
/// itself — diagnostics report its byte length only (protocol V24), matching
/// the runtime's `InitError` redaction — so a component may put real detail
/// here without leaking it into host logs.
#[derive(Debug)]
pub struct ShutdownError(pub String);

impl std::fmt::Display for ShutdownError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "component shutdown failed: {}", self.0)
    }
}

impl std::error::Error for ShutdownError {}

/// Unlike [`McHostHandler`], a component has no `initialize` here: the
/// mandatory primary receives the host's `HostInit` and the optional
/// secondaries initialize from their own trusted configuration, so each
/// composite role declares its own initialization shape.
pub trait CompositeComponent: Send + Sync + 'static {
    fn manifest(&self) -> ManifestSnapshot;

    /// Immutable pre-initialization resource declaration (plan KTD2). The
    /// default reserves nothing, which keeps existing components on the
    /// general single-pool admission path unchanged.
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

    /// Drains component-owned work. A returned error is a typed shutdown
    /// failure: the composite still drains every other child first and only
    /// then surfaces one deterministic redacted failure (plan KTD1).
    fn shutdown(&self) -> impl Future<Output = Result<(), ShutdownError>> + Send;
}

pub trait PrimaryComponent: CompositeComponent {
    fn initialize(&self, init: HostInit) -> impl Future<Output = Result<(), InitError>> + Send;

    /// Post-publication activation with [`McHostHandler::activate`]'s contract; the default does nothing so components without deferred work stay unchanged. commentlint: allow(JUDGE)
    fn activate(&self) -> impl Future<Output = Result<(), InitError>> + Send {
        async { Ok(()) }
    }
}

/// An expected artifact fault (missing or invalid bundle) must resolve to
/// `Ok(())` with the component internally disabled — its binds then reject
/// with `artifact_invalid` while its catalog identity stays published.
/// `Err` is reserved for host-fatal invariant failures.
pub trait SecondaryComponent: CompositeComponent {
    fn initialize(&self) -> impl Future<Output = Result<(), InitError>> + Send;

    /// Post-publication activation with [`McHostHandler::activate`]'s contract; the default does nothing so components without deferred work stay unchanged. commentlint: allow(JUDGE)
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
    /// Duplicate module IDs are refused here so bind dispatch can never be
    /// ambiguous; the runtime re-validates the published manifest set.
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

/// Polls `future` with every poll wrapped in `catch_unwind`, so a child
/// callback's panic becomes a value instead of unwinding through the
/// composite. The runtime trips its fatal cell when a handler callback
/// unwinds, and the caller — not this helper — decides whether the caught
/// payload is dropped (health) or aggregated and re-raised (shutdown).
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

/// One drained child's shutdown outcome, already redacted: the child name is
/// manifest identity (never sensitive), and a returned error contributes only
/// its byte length (protocol V24). Panic payloads are dropped entirely.
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
    fn manifests(&self) -> Vec<ManifestSnapshot> {
        vec![
            self.primary.manifest(),
            self.secondary.manifest(),
            self.tertiary.manifest(),
        ]
    }

    fn resource_declarations(&self) -> Vec<ResourceDeclaration> {
        // Same deterministic order as `manifests`; the runtime checked-sums
        // and validates these before initialization (plan KTD2).
        vec![
            self.primary.resources(),
            self.secondary.resources(),
            self.tertiary.resources(),
        ]
    }

    async fn initialize(&self, init: HostInit) -> Result<(), InitError> {
        // Independent children initialize concurrently. Fixed polling order
        // preserves primary error precedence — then secondary before
        // tertiary — when independent initializers fail in the same poll.
        tokio::try_join!(
            biased;
            self.primary.initialize(init),
            self.secondary.initialize(),
            self.tertiary.initialize()
        )?;
        Ok(())
    }

    async fn activate(&self) -> Result<(), InitError> {
        // Children activate concurrently; fixed polling order preserves
        // deterministic error precedence.
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
            // The host classifies targets before bind, so an unmapped module
            // here means the host and composite disagree about the catalog.
            return BindOutcome::Reject {
                code: crate::control::CODE_TARGET_UNAVAILABLE.to_owned(),
                message: "target module is not part of this composition".to_owned(),
            };
        };
        // Inserted before the child observes the handle and retained through
        // rejection, panic, and close-wins-bind: the host still owes exactly
        // one route-gone for each of those outcomes, and that callback needs
        // this entry to reach the same child.
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
        // Removed only after the child's callback stopped, so the map can
        // never claim a child is done with a handle it is still cleaning up.
        self.routes
            .lock()
            .expect("composite route map")
            .remove(&route);
    }

    async fn health(&self) -> HealthReport {
        // The runtime trips its fatal cell when a health callback unwinds, so
        // an escaping panic from an optional child would tear down the whole
        // host over a component the host can run without. Each optional
        // child's poll is caught and the payload dropped rather than
        // re-raised: the fault becomes a failing report for that component,
        // and the mandatory primary's report keeps deciding the aggregate.
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
        // Ok < Degraded < Failing, with the deterministic catalog order —
        // primary, then secondary, then tertiary — breaking ties so the
        // mandatory primary's detail is never masked by an optional
        // component and equal optional severities always report the same
        // child.
        let mut winner = primary;
        for candidate in [secondary, tertiary] {
            if severity(candidate.status) > severity(winner.status) {
                winner = candidate;
            }
        }
        winner
    }

    async fn shutdown(&self) {
        // Fixed drain order (plan KTD1): tertiary (Broca) first — it owns
        // subprocess groups whose reaping must not wait behind other
        // children — then secondary (Synapse), then the mandatory primary.
        // Every child's poll is caught: a panicking or erroring earlier
        // child must not skip a later child's drain, or the runtime would
        // release the instance fence while that child's background work is
        // still live. Failures are collected as redacted notes and surfaced
        // only after every child has drained, as one deterministic panic so
        // the runtime still classifies this callback as failed rather than
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
