//! Static two-component composition.
//!
//! The composite is dispatch metadata only: the host `RouteRegistry` remains
//! the sole owner of route reservation, liveness, closing, finalization,
//! cancellation, and channel reuse. The route map here answers exactly one
//! question — which child owns a handle the host already validated — and an
//! entry lives from just before the child's bind until that child's
//! route-gone callback returns.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;

use crate::config::HostInit;
use crate::handler::{
    BindOutcome, HealthReport, HealthStatus, InitError, ManifestSnapshot, McHostHandler,
    RequestCtx, RequestOutcome, RouteHandle, RouteIdentity, RouteTarget,
};

/// Unlike [`McHostHandler`], a component has no `initialize` here: the
/// mandatory primary receives the host's `HostInit` and the optional
/// secondary initializes from its own trusted configuration, so each
/// composite role declares its own initialization shape.
pub trait CompositeComponent: Send + Sync + 'static {
    fn manifest(&self) -> ManifestSnapshot;

    fn bind(
        &self,
        route: RouteHandle,
        identity: RouteIdentity,
    ) -> impl Future<Output = BindOutcome> + Send;

    fn handle(&self, ctx: RequestCtx) -> impl Future<Output = RequestOutcome> + Send;

    fn route_gone(&self, route: RouteHandle) -> impl Future<Output = ()> + Send;

    fn health(&self) -> impl Future<Output = HealthReport> + Send;

    fn shutdown(&self) -> impl Future<Output = ()> + Send;
}

pub trait PrimaryComponent: CompositeComponent {
    fn initialize(&self, init: HostInit) -> impl Future<Output = Result<(), InitError>> + Send;
}

/// An expected artifact fault (missing or invalid bundle) must resolve to
/// `Ok(())` with the component internally disabled — its binds then reject
/// with `artifact_invalid` while its catalog identity stays published.
/// `Err` is reserved for host-fatal invariant failures.
pub trait SecondaryComponent: CompositeComponent {
    fn initialize(&self) -> impl Future<Output = Result<(), InitError>> + Send;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Child {
    Primary,
    Secondary,
}

pub struct StaticComposite<P, S> {
    primary: P,
    secondary: S,
    primary_id: Box<str>,
    secondary_id: Box<str>,
    routes: Mutex<HashMap<RouteHandle, Child>>,
}

impl<P: PrimaryComponent, S: SecondaryComponent> StaticComposite<P, S> {
    /// Duplicate module IDs are refused here so bind dispatch can never be
    /// ambiguous; the runtime re-validates the published manifest set.
    pub fn new(primary: P, secondary: S) -> Result<Self, InitError> {
        let primary_id = primary.manifest().module_id.into_boxed_str();
        let secondary_id = secondary.manifest().module_id.into_boxed_str();
        if primary_id == secondary_id {
            return Err(InitError(
                "composite components share one module ID".to_owned(),
            ));
        }
        Ok(Self {
            primary,
            secondary,
            primary_id,
            secondary_id,
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

impl<P: PrimaryComponent, S: SecondaryComponent> McHostHandler for StaticComposite<P, S> {
    fn manifests(&self) -> Vec<ManifestSnapshot> {
        vec![self.primary.manifest(), self.secondary.manifest()]
    }

    async fn initialize(&self, init: HostInit) -> Result<(), InitError> {
        self.primary.initialize(init).await?;
        self.secondary.initialize().await
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
        }
    }

    async fn handle(&self, ctx: RequestCtx) -> RequestOutcome {
        match self.child_of_route(ctx.route) {
            Some(Child::Primary) => self.primary.handle(ctx).await,
            Some(Child::Secondary) => self.secondary.handle(ctx).await,
            None => RequestOutcome::Error {
                code: crate::control::CODE_INTERNAL_ERROR.to_owned(),
                message: "route is not mapped to a component".to_owned(),
            },
        }
    }

    async fn route_gone(&self, route: RouteHandle) {
        let child = self.child_of_route(route);
        match child {
            Some(Child::Primary) => self.primary.route_gone(route).await,
            Some(Child::Secondary) => self.secondary.route_gone(route).await,
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
        let primary = self.primary.health().await;
        let secondary = self.secondary.health().await;
        // Ok < Degraded < Failing, with the mandatory primary reported first
        // on ties so its detail is not masked by the optional component.
        if severity(primary.status) >= severity(secondary.status) {
            primary
        } else {
            secondary
        }
    }

    async fn shutdown(&self) {
        // The optional secondary drains first, but its panic must not skip
        // the mandatory primary's drain: an unwinding future would return
        // before `primary.shutdown()` runs, and the runtime would release
        // the instance fence while primary-owned background work is still
        // live. Each poll is caught instead, the primary always drains, and
        // the payload is re-raised so the runtime still classifies this
        // callback as panicked rather than cleanly returned.
        let secondary = {
            let mut shutdown = std::pin::pin!(self.secondary.shutdown());
            std::future::poll_fn(move |cx| {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    shutdown.as_mut().poll(cx)
                })) {
                    Ok(poll) => poll.map(Ok),
                    Err(payload) => std::task::Poll::Ready(Err(payload)),
                }
            })
            .await
        };
        self.primary.shutdown().await;
        if let Err(payload) = secondary {
            std::panic::resume_unwind(payload);
        }
    }
}
