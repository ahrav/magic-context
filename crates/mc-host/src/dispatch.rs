//! Request dispatch, first-terminal-wins settlement, and route/generation
//! close orchestration.
//!
//! Logical settlement is distinct from socket-write outcome (plan KTD8): the
//! settlement primitive records which terminal won; the writer only reports
//! whether bytes made it out. Handler-task and byte permits live inside the
//! task that owns their resources and release only when that resource is gone.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use subc_protocol::FrameType;
use tokio::sync::oneshot;
use tokio::time::{timeout, timeout_at, Instant};
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;

use crate::connection::{GenerationCore, PendingEntry, PendingKey};
use crate::control::{
    error_body_json, CODE_CANCELLED, CODE_INTERNAL_ERROR, CODE_SERVER_BUSY, CODE_UNKNOWN_CHANNEL,
};
use crate::handler::{McHostHandler, RequestCtx, RequestOutcome, RouteHandle, StreamClosed};
use crate::routing::{BindInstall, CloseDecision};
use crate::runtime::HostShared;
use crate::wire::{
    encode_owned_frame, pure_header_flags, response_flags, FrameId, InboundFrame, OutboundFrame,
};

/// First-terminal-wins arbiter for one correlation.
///
/// `order` serializes every emission for the correlation, so a stream item can
/// never be queued after the terminal and the won check is race-free. `won`
/// flips exactly once, no matter which of handler completion, cancellation,
/// route close, or teardown arrives first.
pub struct Settlement {
    won: AtomicBool,
    order: tokio::sync::Mutex<()>,
}

impl Settlement {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            won: AtomicBool::new(false),
            order: tokio::sync::Mutex::new(()),
        })
    }

    pub fn is_settled(&self) -> bool {
        self.won.load(Ordering::SeqCst)
    }
}

/// The terminal frames a request can settle with.
pub enum Terminal {
    Response { body: Vec<u8>, binary: bool },
    Error { code: String, message: String },
    StreamEnd,
}

fn bounded_error_body(code: &str, message: &str) -> Vec<u8> {
    let body = error_body_json(code, message);
    if body.len() <= crate::wire::MAX_BODY_LEN as usize {
        body
    } else {
        error_body_json(CODE_INTERNAL_ERROR, "handler error exceeds frame limit")
    }
}

/// Queues one frame on a generation's writer, charging its resident bytes.
/// The byte-budget wait is bounded by generation retirement. `Err` means the
/// generation can no longer emit; logical state must not depend on it.
pub async fn emit_frame(
    budget: &crate::wire::ByteBudget,
    gen: &GenerationCore,
    ty: FrameType,
    flags: subc_protocol::Flags,
    id: FrameId,
    body: Vec<u8>,
) -> Result<(), ()> {
    if body.len() > crate::wire::MAX_BODY_LEN as usize || gen.writer.is_retired() {
        return Err(());
    }
    let charge = if body.is_empty() {
        crate::wire::ByteCharge::none()
    } else {
        let frame_bytes = u32::try_from(body.len() + subc_protocol::HEADER_LEN).map_err(|_| ())?;
        budget.try_charge(frame_bytes).ok_or(())?
    };
    let bytes = encode_owned_frame(ty, flags, id, body).map_err(|_| ())?;
    gen.writer
        .send(OutboundFrame { bytes, charge })
        .await
        .map_err(|_| ())
}

/// Emits one terminal `Error` for a correlation that has no settlement object
/// (semantic rejection before dispatch: `unknown_channel`, `server_busy`,
/// control rejections). The host proves no handler dispatch occurred for
/// these codes (protocol §8.3).
pub async fn emit_error_terminal(
    budget: &crate::wire::ByteBudget,
    gen: &GenerationCore,
    id: FrameId,
    code: &str,
    message: &str,
) {
    let body = bounded_error_body(code, message);
    if emit_frame(
        budget,
        gen,
        FrameType::Error,
        response_flags(false, true),
        id,
        body,
    )
    .await
    .is_err()
    {
        gen.token.cancel();
    }
}

/// Settles a request with `terminal` if nothing settled it first. Returns
/// whether this call won. Emission happens under the settlement's order lock
/// so late stream items can never follow the terminal.
pub async fn settle(
    settlement: &Settlement,
    budget: &crate::wire::ByteBudget,
    gen: &GenerationCore,
    route: RouteHandle,
    corr: u64,
    terminal: Terminal,
) -> bool {
    let _order = settlement.order.lock().await;
    if settlement.won.swap(true, Ordering::SeqCst) {
        return false;
    }
    let (ty, flags, body) = match terminal {
        Terminal::Response { body, binary } => {
            (FrameType::Response, response_flags(binary, true), body)
        }
        Terminal::Error { code, message } => (
            FrameType::Error,
            response_flags(false, true),
            bounded_error_body(&code, &message),
        ),
        Terminal::StreamEnd => (
            FrameType::StreamEnd,
            response_flags(false, true),
            Vec::new(),
        ),
    };
    if emit_frame(budget, gen, ty, flags, FrameId::routed(route, corr), body)
        .await
        .is_err()
    {
        gen.token.cancel();
    }
    true
}

/// Handler-facing ordered stream emitter for one request.
#[derive(Clone)]
pub struct StreamSink {
    pub(crate) settlement: Arc<Settlement>,
    pub(crate) gen: Arc<GenerationCore>,
    pub(crate) budget: crate::wire::ByteBudget,
    pub(crate) route: RouteHandle,
    pub(crate) corr: u64,
    pub(crate) cancel: CancellationToken,
}

impl StreamSink {
    pub(crate) async fn send(&self, item: Vec<u8>, binary: bool) -> Result<(), StreamClosed> {
        if item.len() > crate::wire::MAX_BODY_LEN as usize || self.cancel.is_cancelled() {
            return Err(StreamClosed);
        }
        let _order = self.settlement.order.lock().await;
        if self.settlement.won.load(Ordering::SeqCst) || self.cancel.is_cancelled() {
            return Err(StreamClosed);
        }
        tokio::select! {
            biased;
            () = self.cancel.cancelled() => Err(StreamClosed),
            result = emit_frame(
                &self.budget,
                &self.gen,
                FrameType::StreamData,
                response_flags(binary, false),
                FrameId::routed(self.route, self.corr),
                item,
            ) => result.map_err(|_| StreamClosed),
        }
    }
}

/// Admits and dispatches one routed request frame (protocol §8.3, §9.1).
///
/// Order matters: route lookup proves `unknown_channel` without consuming
/// capacity; capacity rejections prove no dispatch; only then is the single
/// handler task spawned.
pub async fn dispatch_request<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    frame: InboundFrame,
) {
    let header = frame.header;
    let route = RouteHandle {
        channel: header.channel,
        epoch: header.epoch,
    };
    let corr = header.corr;

    if shared.draining.load(Ordering::SeqCst) {
        drop(frame);
        emit_error_terminal(
            &shared.egress_budget,
            gen,
            FrameId::routed(route, corr),
            CODE_SERVER_BUSY,
            "host is shutting down",
        )
        .await;
        return;
    }

    let Some(route_cancel) = shared.registry.route_cancel(route, gen.id) else {
        drop(frame);
        emit_error_terminal(
            &shared.egress_budget,
            gen,
            FrameId::routed(route, corr),
            CODE_UNKNOWN_CHANNEL,
            "no live route for this channel and epoch",
        )
        .await;
        return;
    };

    let Ok(pending_permit) = shared.pending_permits.clone().try_acquire_owned() else {
        drop(frame);
        emit_error_terminal(
            &shared.egress_budget,
            gen,
            FrameId::routed(route, corr),
            CODE_SERVER_BUSY,
            "pending request capacity exhausted",
        )
        .await;
        return;
    };
    let Ok(task_permit) = shared.task_permits.clone().try_acquire_owned() else {
        drop(frame);
        emit_error_terminal(
            &shared.egress_budget,
            gen,
            FrameId::routed(route, corr),
            CODE_SERVER_BUSY,
            "handler task capacity exhausted",
        )
        .await;
        return;
    };

    let InboundFrame {
        body,
        charge: body_charge,
        ..
    } = frame;
    let settlement = Settlement::new();
    let cancel = route_cancel.child_token();
    let key: PendingKey = (route.channel, route.epoch, corr);
    gen.pending.lock().expect("pending lock").insert(
        key,
        PendingEntry {
            cancel: cancel.clone(),
            settlement: Arc::clone(&settlement),
        },
    );

    let (start_tx, start_rx) = oneshot::channel();
    let shared_task = Arc::clone(shared);
    let gen_task = Arc::clone(gen);
    let binary = header.flags.is_binary();
    let outer = shared.spawn_tracked(async move {
        let _pending_permit = pending_permit;
        let _task_permit = task_permit;
        if start_rx.await.is_err() {
            remove_pending(&gen_task, key);
            return;
        }
        if cancel.is_cancelled() {
            settle(
                &settlement,
                &shared_task.egress_budget,
                &gen_task,
                route,
                corr,
                Terminal::Error {
                    code: CODE_CANCELLED.to_owned(),
                    message: "request cancelled".to_owned(),
                },
            )
            .await;
            remove_pending(&gen_task, key);
            return;
        }

        let sink = StreamSink {
            settlement: Arc::clone(&settlement),
            gen: Arc::clone(&gen_task),
            budget: shared_task.egress_budget.clone(),
            route,
            corr,
            cancel: cancel.clone(),
        };
        let ctx = RequestCtx {
            route,
            body,
            binary,
            cancel: cancel.clone(),
            stream: sink,
        };
        let handler = Arc::clone(&shared_task.handler);
        let inner = shared_task.spawn_tracked(async move {
            let _body_charge = body_charge;
            handler.handle(ctx).await
        });
        let mut inner = AbortOnDropHandle::new(inner);

        tokio::select! {
            biased;
            () = cancel.cancelled() => {
                inner.abort();
                let _ = (&mut inner).await;
                settle(
                    &settlement,
                    &shared_task.egress_budget,
                    &gen_task,
                    route,
                    corr,
                    Terminal::Error {
                        code: CODE_CANCELLED.to_owned(),
                        message: "request cancelled".to_owned(),
                    },
                )
                .await;
            }
            joined = &mut inner => {
                let terminal = match joined {
                    Ok(RequestOutcome::Response(body))
                        if body.len() <= crate::wire::MAX_BODY_LEN as usize => {
                            Terminal::Response { body, binary: false }
                        }
                    Ok(RequestOutcome::Response(_)) => Terminal::Error {
                        code: CODE_INTERNAL_ERROR.to_owned(),
                        message: "handler response exceeds frame limit".to_owned(),
                    },
                    Ok(RequestOutcome::Error { code, message }) => Terminal::Error { code, message },
                    Ok(RequestOutcome::Streamed) => Terminal::StreamEnd,
                    Err(join_err) if join_err.is_panic() => Terminal::Error {
                        code: CODE_INTERNAL_ERROR.to_owned(),
                        message: "handler request task failed".to_owned(),
                    },
                    Err(_) => {
                        remove_pending(&gen_task, key);
                        return;
                    }
                };
                settle(&settlement, &shared_task.egress_budget, &gen_task, route, corr, terminal).await;
            }
        }
        remove_pending(&gen_task, key);
    });

    if shared.registry.register_task(route, gen.id, outer) {
        let _ = start_tx.send(());
    } else {
        drop(start_tx);
        remove_pending(gen, key);
    }
}

fn remove_pending(gen: &GenerationCore, key: PendingKey) {
    gen.pending.lock().expect("pending lock").remove(&key);
}

/// Handles a validated `route.open` after control parsing: reserve, bind,
/// publish-or-cleanup, respond (protocol §8.2).
pub async fn open_route<H: McHostHandler>(
    shared: Arc<HostShared<H>>,
    gen: Arc<GenerationCore>,
    corr: u64,
    identity: crate::handler::RouteIdentity,
) {
    if shared.draining.load(Ordering::SeqCst) {
        emit_error_terminal(
            &shared.egress_budget,
            &gen,
            FrameId::control(corr),
            crate::control::CODE_TARGET_UNAVAILABLE,
            "host is shutting down",
        )
        .await;
        return;
    }
    let Some(handle) = shared.registry.reserve(&gen) else {
        emit_error_terminal(
            &shared.egress_budget,
            &gen,
            FrameId::control(corr),
            crate::control::CODE_TARGET_UNAVAILABLE,
            "route capacity exhausted",
        )
        .await;
        return;
    };

    let handler = Arc::clone(&shared.handler);
    let bind_task = shared.spawn_tracked(async move { handler.bind(handle, identity).await });
    let Ok(outcome) = shared.lifecycle_join("bind", bind_task).await else {
        shared.registry.take_rejected_bind(handle);
        run_route_gone(&shared, handle).await;
        shared.registry.finalize_close(handle);
        return;
    };

    match outcome {
        crate::handler::BindOutcome::Accept => match shared.registry.install_bound(handle) {
            BindInstall::Installed => {
                let body = crate::control::route_open_response_json(handle.channel, handle.epoch);
                if emit_frame(
                    &shared.egress_budget,
                    &gen,
                    FrameType::Response,
                    response_flags(false, true),
                    FrameId::control(corr),
                    body,
                )
                .await
                .is_err()
                {
                    gen.token.cancel();
                }
            }
            BindInstall::CloseWins => {
                // Close raced the bind and wins: never publish, still exactly
                // one route-gone because the handler observed the handle
                // (protocol AE8).
                run_route_gone(&shared, handle).await;
                shared.registry.finalize_close(handle);
            }
        },
        crate::handler::BindOutcome::Reject { code, message } => {
            shared.registry.take_rejected_bind(handle);
            run_route_gone(&shared, handle).await;
            shared.registry.finalize_close(handle);
            let code = if code.is_empty() {
                "bind_rejected".to_owned()
            } else {
                code
            };
            emit_error_terminal(
                &shared.egress_budget,
                &gen,
                FrameId::control(corr),
                &code,
                &message,
            )
            .await;
        }
    }
}

/// Runs the route-gone callback exactly once per handle, gated by the
/// registry's `gone_started` mark. Panic or timeout is host-fatal.
async fn run_route_gone<H: McHostHandler>(shared: &Arc<HostShared<H>>, handle: RouteHandle) {
    if !shared.registry.mark_gone_started(handle) {
        return;
    }
    let handler = Arc::clone(&shared.handler);
    let task = shared.spawn_tracked(async move { handler.route_gone(handle).await });
    let _ = shared.lifecycle_join("route_gone", task).await;
}

/// Closes one route: stop dispatch, cancel and settle admitted work within
/// the close budget, join handler tasks, run route-gone once, free the
/// channel (protocol §9.4, §12).
pub async fn close_route<H: McHostHandler>(shared: &Arc<HostShared<H>>, handle: RouteHandle) {
    close_route_decision(shared, handle, shared.registry.begin_close(handle)).await;
}

/// `gen_id` fences the close to its owning generation.
pub async fn close_route_owned<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    handle: RouteHandle,
    gen_id: u64,
) {
    close_route_decision(
        shared,
        handle,
        shared.registry.begin_close_owned(handle, gen_id),
    )
    .await;
}

async fn close_route_decision<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    handle: RouteHandle,
    decision: CloseDecision,
) {
    match decision {
        CloseDecision::AlreadyGone | CloseDecision::DeferredToBind => {}
        CloseDecision::Owner { gen, tasks } => {
            let keys: Vec<PendingKey> = gen
                .pending
                .lock()
                .expect("pending lock")
                .iter()
                .filter(|(key, _)| key.0 == handle.channel && key.1 == handle.epoch)
                .map(|(key, entry)| {
                    entry.cancel.cancel();
                    *key
                })
                .collect();

            let deadline = Instant::now() + shared.timing.route_close_budget;
            for mut task in tasks {
                if timeout_at(deadline, &mut task).await.is_err() {
                    task.abort();
                    let _ = task.await;
                }
            }
            // Aborted tasks never removed their own pending entries.
            {
                let mut pending = gen.pending.lock().expect("pending lock");
                for key in keys {
                    pending.remove(&key);
                }
            }

            run_route_gone(shared, handle).await;
            shared.registry.finalize_close(handle);
        }
    }
}

/// Retires a generation: cancels its token (stopping reads, settling admitted
/// work as cancelled) and closes every route it owned (protocol §12).
pub async fn close_generation<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
) {
    gen.token.cancel();
    for handle in shared.registry.routes_of_generation(gen.id) {
        close_route(shared, handle).await;
    }
    shared
        .connections
        .lock()
        .expect("connections lock")
        .remove(&gen.id);
}

/// Forced-path cleanup after the shutdown deadline: aborts every remaining
/// route task and still runs exactly-once route-gone before handler drop
/// (protocol §12 forced shutdown).
pub async fn force_close_all_routes<H: McHostHandler>(shared: &Arc<HostShared<H>>) {
    for (handle, tasks) in shared.registry.force_drain() {
        for task in tasks {
            task.abort();
            let _ = timeout(shared.timing.lifecycle_callback_deadline, task).await;
        }
        run_route_gone(shared, handle).await;
        shared.registry.finalize_close(handle);
    }
}

/// Best-effort connection `Goodbye` (0/0/0), queued after drain terminals so
/// clients do not retire the generation before those terminals arrive
/// (protocol §12 step 4).
pub async fn send_connection_goodbye(gen: &GenerationCore) {
    let bytes = encode_owned_frame(
        FrameType::Goodbye,
        pure_header_flags(),
        FrameId::control(0),
        Vec::new(),
    )
    .expect("header-only Goodbye always encodes");
    let _ = gen
        .writer
        .send(OutboundFrame {
            bytes,
            charge: crate::wire::ByteCharge::none(),
        })
        .await;
}

/// Cancels one pending request if it exists; stale or settled targets are
/// idempotent no-ops (protocol §9.2).
pub fn handle_cancel(gen: &GenerationCore, key: PendingKey) {
    let pending = gen.pending.lock().expect("pending lock");
    if let Some(entry) = pending.get(&key) {
        if !entry.settlement.is_settled() {
            entry.cancel.cancel();
        }
    }
}
