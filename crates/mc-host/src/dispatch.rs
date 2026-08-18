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
use crate::control::{CODE_CANCELLED, CODE_INTERNAL_ERROR, CODE_SERVER_BUSY, CODE_UNKNOWN_CHANNEL};
use crate::handler::{
    McHostHandler, OutputBuffer, RequestCtx, RequestOutcome, RouteHandle, StreamClosed,
};
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
    /// Set once any `StreamData` item reaches the writer. A streamed sequence
    /// may terminate only with `StreamEnd` or `Error` (protocol §8.3), so a
    /// later unary `Response` from the handler is a contract violation.
    streamed: AtomicBool,
}

impl Settlement {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            won: AtomicBool::new(false),
            order: tokio::sync::Mutex::new(()),
            streamed: AtomicBool::new(false),
        })
    }

    pub fn is_settled(&self) -> bool {
        self.won.load(Ordering::SeqCst)
    }

    fn has_streamed(&self) -> bool {
        self.streamed.load(Ordering::SeqCst)
    }
}

/// The terminal frames a request can settle with.
pub enum Terminal {
    Response { body: OutputBuffer, binary: bool },
    Error { code: String, message: String },
    StreamEnd,
}

/// Serialized length of `s` inside a JSON string, without materializing it:
/// `"` and `\` and the short control escapes emit two bytes, remaining
/// control characters emit six (`\u00XX`), and everything else (including
/// multi-byte UTF-8) passes through byte for byte.
fn escaped_json_len(s: &str) -> usize {
    s.bytes()
        .map(|byte| match byte {
            b'"' | b'\\' | 0x08 | 0x09 | 0x0A | 0x0C | 0x0D => 2,
            0x00..=0x1F => 6,
            _ => 1,
        })
        .sum()
}

/// Builds an error terminal body under a pre-acquired egress reservation.
/// The encoded size is computed exactly from the escaped field lengths, so
/// the charge exists BEFORE the body materializes — concurrent handler
/// errors wait on the budget as bytes, not as retained encoded buffers.
/// `Err` means the generation can no longer emit.
async fn charged_error_body(
    budget: &crate::wire::ByteBudget,
    gen: &GenerationCore,
    code: &str,
    message: &str,
) -> Result<OutputBuffer, ()> {
    const ERROR_ENVELOPE_OVERHEAD: usize = r#"{"code":"","message":""}"#.len();
    let encoded_len = |code: &str, message: &str| {
        escaped_json_len(code)
            .saturating_add(escaped_json_len(message))
            .saturating_add(ERROR_ENVELOPE_OVERHEAD)
    };
    let (code, message) = if encoded_len(code, message) > crate::wire::MAX_BODY_LEN as usize {
        (CODE_INTERNAL_ERROR, "handler error exceeds frame limit")
    } else {
        (code, message)
    };
    let body_len = encoded_len(code, message);
    if gen.writer.is_retired() || gen.token.is_cancelled() {
        return Err(());
    }
    let frame_bytes = u32::try_from(body_len + subc_protocol::HEADER_LEN).map_err(|_| ())?;
    let deadline = gen.writer.admission_deadline();
    let charge = tokio::select! {
        biased;
        () = gen.token.cancelled() => return Err(()),
        charge = tokio::time::timeout_at(deadline, budget.charge(frame_bytes)) => match charge {
            Ok(charge) => charge,
            Err(_) => {
                gen.token.cancel();
                return Err(());
            }
        },
    };
    let body = error_body_json_into(
        // Header spare capacity up front: an exactly sized buffer would force
        // `encode_owned_frame`'s reserve to reallocate, transiently retaining
        // two near-maximum bodies against one charge.
        Vec::with_capacity(body_len + subc_protocol::HEADER_LEN),
        code,
        message,
    );
    debug_assert_eq!(body.len(), body_len, "escaped length model diverged");
    Ok(OutputBuffer {
        body,
        charge,
        max_len: body_len,
    })
}

/// Serializes the error envelope directly into `buf` — no intermediate
/// `serde_json::Value` — so the only allocation is the charged output buffer.
/// Field order and escaping match `serde_json`, which `escaped_json_len`
/// models exactly.
fn error_body_json_into(mut buf: Vec<u8>, code: &str, message: &str) -> Vec<u8> {
    buf.extend_from_slice(b"{\"code\":");
    serde_json::to_writer(&mut buf, code).expect("string serialization cannot fail");
    buf.extend_from_slice(b",\"message\":");
    serde_json::to_writer(&mut buf, message).expect("string serialization cannot fail");
    buf.push(b'}');
    buf
}

/// Queues one frame on a generation's writer. Body-bearing frames charge their
/// body plus wire header against the resident-byte budget; header-only frames
/// are exempt. The byte-budget wait is bounded by generation retirement.
/// `Err` means the generation can no longer emit; logical state must not
/// depend on it.
///
/// A cancelled generation fails closed: retirement paths (structural
/// corruption, connection teardown) cancel the token before settling admitted
/// work, and the protocol requires those closes to stay silent rather than
/// fabricate terminals (protocol §6.3).
pub async fn emit_frame(
    budget: &crate::wire::ByteBudget,
    gen: &GenerationCore,
    ty: FrameType,
    flags: subc_protocol::Flags,
    id: FrameId,
    body: Vec<u8>,
) -> Result<(), ()> {
    if body.len() > crate::wire::MAX_BODY_LEN as usize
        || gen.writer.is_retired()
        || gen.token.is_cancelled()
    {
        return Err(());
    }
    let deadline = gen.writer.admission_deadline();
    let charge = if body.is_empty() {
        crate::wire::ByteCharge::none()
    } else {
        let frame_bytes = u32::try_from(body.len() + subc_protocol::HEADER_LEN).map_err(|_| ())?;
        tokio::select! {
            biased;
            () = gen.token.cancelled() => return Err(()),
            charge = timeout_at(deadline, budget.charge(frame_bytes)) => match charge {
                Ok(charge) => charge,
                Err(_) => {
                    gen.token.cancel();
                    return Err(());
                }
            },
        }
    };
    let bytes = encode_owned_frame(ty, flags, id, body).map_err(|_| ())?;
    gen.writer
        .send_before(
            OutboundFrame {
                bytes,
                charge,
                written: None,
            },
            deadline,
        )
        .await
        .map_err(|_| ())
}

/// Queues a handler body whose resident-byte reservation was acquired before
/// allocation. The charge transfers directly to the writer with no second
/// budget acquisition. Writer admission is timed from submission here — a
/// handler may legitimately spend longer than one admission window filling
/// its reservation, and a deadline captured at reserve time would retire a
/// healthy generation when the completed buffer finally arrives.
async fn emit_reserved_frame(
    gen: &GenerationCore,
    ty: FrameType,
    flags: subc_protocol::Flags,
    id: FrameId,
    body: OutputBuffer,
) -> Result<(), ()> {
    if gen.writer.is_retired() || gen.token.is_cancelled() {
        return Err(());
    }
    let (body, charge) = body.into_parts();
    let bytes = encode_owned_frame(ty, flags, id, body).map_err(|_| ())?;
    gen.writer
        .send(OutboundFrame {
            bytes,
            charge,
            written: None,
        })
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
    let Ok(body) = charged_error_body(budget, gen, code, message).await else {
        gen.token.cancel();
        return;
    };
    if emit_reserved_frame(gen, FrameType::Error, response_flags(false, true), id, body)
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
            if emit_reserved_frame(
                gen,
                FrameType::Response,
                response_flags(binary, true),
                FrameId::routed(route, corr),
                body,
            )
            .await
            .is_err()
            {
                gen.token.cancel();
            }
            return true;
        }
        Terminal::Error { code, message } => {
            let Ok(body) = charged_error_body(budget, gen, &code, &message).await else {
                gen.token.cancel();
                return true;
            };
            if emit_reserved_frame(
                gen,
                FrameType::Error,
                response_flags(false, true),
                FrameId::routed(route, corr),
                body,
            )
            .await
            .is_err()
            {
                gen.token.cancel();
            }
            return true;
        }
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
    pub(crate) async fn reserve(&self, max_len: usize) -> Result<OutputBuffer, StreamClosed> {
        // Terminal selection closes the stream (StreamClosed's contract): a
        // context escaped into a background task must not keep reserving
        // egress budget for buffers `send` can never emit.
        if max_len > crate::wire::MAX_BODY_LEN as usize
            || self.cancel.is_cancelled()
            || self.settlement.won.load(Ordering::SeqCst)
        {
            return Err(StreamClosed);
        }
        let bytes = u32::try_from(max_len + subc_protocol::HEADER_LEN).map_err(|_| StreamClosed)?;
        let deadline = self.gen.writer.admission_deadline();
        let charge = tokio::select! {
            biased;
            () = self.cancel.cancelled() => return Err(StreamClosed),
            () = self.gen.token.cancelled() => return Err(StreamClosed),
            charge = timeout_at(deadline, self.budget.charge(bytes)) => match charge {
                Ok(charge) => charge,
                Err(_) => {
                    self.gen.token.cancel();
                    return Err(StreamClosed);
                }
            },
        };
        if self.cancel.is_cancelled()
            || self.gen.token.is_cancelled()
            || self.settlement.won.load(Ordering::SeqCst)
        {
            return Err(StreamClosed);
        }
        Ok(OutputBuffer {
            body: Vec::with_capacity(max_len + subc_protocol::HEADER_LEN),
            charge,
            max_len,
        })
    }

    pub(crate) async fn send(&self, item: OutputBuffer, binary: bool) -> Result<(), StreamClosed> {
        if self.cancel.is_cancelled() {
            return Err(StreamClosed);
        }
        let _order = self.settlement.order.lock().await;
        if self.settlement.won.load(Ordering::SeqCst) || self.cancel.is_cancelled() {
            return Err(StreamClosed);
        }
        tokio::select! {
            biased;
            () = self.cancel.cancelled() => Err(StreamClosed),
            result = emit_reserved_frame(
                &self.gen,
                FrameType::StreamData,
                response_flags(binary, false),
                FrameId::routed(self.route, self.corr),
                item,
            ) => match result {
                Ok(()) => {
                    self.settlement.streamed.store(true, Ordering::SeqCst);
                    Ok(())
                }
                Err(()) => Err(StreamClosed),
            },
        }
    }
}

/// Emits one no-dispatch rejection terminal off the connection reader while
/// the per-generation bound allows, inline past it. The wait for contended
/// egress can span a frame deadline; on the reader it would starve a queued
/// Pong into a liveness false-kill, while unbounded spawning would let a
/// client pipeline no-permit rejections into unbounded tasks.
pub async fn emit_rejection<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    id: FrameId,
    code: &'static str,
    message: &'static str,
) {
    match gen.busy_rejects.clone().try_acquire_owned() {
        Ok(reject_permit) => {
            let shared_task = Arc::clone(shared);
            let gen_task = Arc::clone(gen);
            shared.spawn_tracked(gen.read_tasks.track_future(async move {
                let _reject_permit = reject_permit;
                emit_error_terminal(&shared_task.egress_budget, &gen_task, id, code, message).await;
            }));
        }
        Err(_) => {
            emit_error_terminal(&shared.egress_budget, gen, id, code, message).await;
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
        emit_rejection(
            shared,
            gen,
            FrameId::routed(route, corr),
            CODE_SERVER_BUSY,
            "host is shutting down",
        )
        .await;
        return;
    }

    // Advisory liveness first so `unknown_channel` consumes no capacity;
    // `register_dispatch` below is the authoritative recheck.
    if !shared.registry.route_live(route, gen.id) {
        drop(frame);
        emit_rejection(
            shared,
            gen,
            FrameId::routed(route, corr),
            CODE_UNKNOWN_CHANNEL,
            "no live route for this channel and epoch",
        )
        .await;
        return;
    }

    // Admission is synchronous with the read loop: acquiring permits inside
    // the spawned task would let a client pipeline unbounded dispatch tasks
    // ahead of the capacity gate.
    let Ok(pending_permit) = shared.pending_permits.clone().try_acquire_owned() else {
        drop(frame);
        emit_rejection(
            shared,
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
        emit_rejection(
            shared,
            gen,
            FrameId::routed(route, corr),
            CODE_SERVER_BUSY,
            "handler task capacity exhausted",
        )
        .await;
        return;
    };

    // The pending entry is visible before the read loop can process any
    // later frame, so a pipelined Cancel arriving right behind its Request
    // always finds the correlation. The request token is a free-standing
    // root: route close cancels entries explicitly when it collects them.
    let settlement = Settlement::new();
    let cancel = CancellationToken::new();
    let key: PendingKey = (route.channel, route.epoch, corr);
    gen.pending.lock().expect("pending lock").insert(
        key,
        PendingEntry {
            cancel: cancel.clone(),
            settlement: Arc::clone(&settlement),
        },
    );

    let (start_tx, start_rx) = oneshot::channel::<()>();
    let shared_task = Arc::clone(shared);
    let gen_task = Arc::clone(gen);
    let outer = shared.spawn_tracked(async move {
        let _pending_permit = pending_permit;
        let _task_permit = task_permit;
        if start_rx.await.is_err() {
            remove_pending(&gen_task, key);
            return;
        }

        let InboundFrame {
            body,
            charge: body_charge,
            ..
        } = frame;
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

        let binary = header.flags.is_binary();
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
            // Construct under the sync guard, poll under the async guard:
            // a panic in the callback's synchronous prologue must reach the
            // redacting hook too.
            let callback = crate::panic_boundary::redact_sync(|| handler.handle(ctx));
            crate::panic_boundary::redact(callback).await
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
                    Ok(RequestOutcome::Response { .. }) if settlement.has_streamed() => {
                        // Streamed sequences terminate only with StreamEnd or
                        // Error (protocol §8.3); a unary Response after
                        // StreamData would corrupt the client's view.
                        Terminal::Error {
                            code: CODE_INTERNAL_ERROR.to_owned(),
                            message: "handler returned a unary response after streaming"
                                .to_owned(),
                        }
                    }
                    Ok(RequestOutcome::Response { body, binary })
                        if body.len() <= crate::wire::MAX_BODY_LEN as usize => {
                            Terminal::Response { body, binary }
                        }
                    Ok(RequestOutcome::Response { .. }) => Terminal::Error {
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

    if shared
        .registry
        .register_dispatch(route, gen.id, outer)
        .is_some()
    {
        let _ = start_tx.send(());
    } else {
        // The route left Live between the advisory check and registration.
        // No dispatch crossed the registry's live-route linearization point,
        // so this rejection proves zero handler invocation; the spawned task
        // observes the dropped start signal and removes the pending entry.
        drop(start_tx);
        emit_rejection(
            shared,
            gen,
            FrameId::routed(route, corr),
            CODE_UNKNOWN_CHANNEL,
            "no live route for this channel and epoch",
        )
        .await;
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
    let bind_deadline = shared.timing.lifecycle_callback_deadline;
    let bind_watchdog = Arc::clone(&shared);
    // Abort-exempt and self-bounded like route-gone: the forced shutdown
    // path must not abort a bind callback mid-flight (the handler observed
    // the handle, and route-gone must follow a completed or failed bind, not
    // interleave with it).
    let bind_task = shared.spawn_lifecycle(async move {
        let callback = crate::panic_boundary::redact_sync(|| handler.bind(handle, identity));
        tokio::select! {
            outcome = crate::panic_boundary::redact(callback) => Some(outcome),
            () = tokio::time::sleep(bind_deadline) => {
                bind_watchdog.fatal.trip(
                    &bind_watchdog.shutdown,
                    "bind callback deadline expired".to_owned(),
                );
                None
            }
        }
    });
    let Ok(Some(outcome)) = shared.lifecycle_join("bind", bind_task).await else {
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
///
/// The callback task is abort-exempt and self-bounded: the shutdown drain can
/// drop this caller at its deadline and `abort_all` reaps ordinary tasks, but
/// route-gone runs exactly once and must complete (or trip the fatal latch)
/// before handler drop, so the spawned task enforces its own deadline.
async fn run_route_gone<H: McHostHandler>(shared: &Arc<HostShared<H>>, handle: RouteHandle) {
    if !shared.registry.mark_gone_started(handle) {
        return;
    }
    let handler = Arc::clone(&shared.handler);
    let deadline = shared.timing.lifecycle_callback_deadline;
    let watchdog = Arc::clone(shared);
    let task = shared.spawn_lifecycle(async move {
        let callback = crate::panic_boundary::redact_sync(|| handler.route_gone(handle));
        if timeout(deadline, crate::panic_boundary::redact(callback))
            .await
            .is_err()
        {
            watchdog.fatal.trip(
                &watchdog.shutdown,
                "route_gone callback deadline expired".to_owned(),
            );
        }
    });
    let _ = shared.lifecycle_join("route_gone", task).await;
}

/// Closes one route: stop dispatch, cancel admitted work, await its tasks until
/// the close budget, abort overdue tasks, run route-gone once, and free the
/// channel (protocol §9.4, §12).
pub async fn close_route<H: McHostHandler>(shared: &Arc<HostShared<H>>, handle: RouteHandle) {
    close_route_decision(shared, handle, shared.registry.begin_close(handle)).await;
}

/// Completes a supplied close decision whose registry transition already
/// applied route ownership and generation fencing. Later frames on a route
/// transitioned by that decision get `unknown_channel` immediately; callers
/// run the returned drain off their own loop when cleanup latency must not
/// stall them.
pub(crate) async fn close_route_decision<H: McHostHandler>(
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
/// work as cancelled) and closes every route it owned (protocol §12). `begun`
/// carries decisions the caller marked before waiting for in-flight binds; a
/// second sweep after the token cancel catches routes reserved in the window
/// between that marking pass and here. Routes close concurrently — bounded by
/// `max_routes` — because serial closes would multiply a slow route-gone
/// callback by the route count, retaining the connection permit and global
/// channels for the whole product.
pub async fn close_generation<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    begun: Vec<(RouteHandle, CloseDecision)>,
) {
    gen.token.cancel();
    let mut closes = tokio::task::JoinSet::new();
    let sweep = shared.registry.begin_close_generation(gen.id);
    for (handle, decision) in begun.into_iter().chain(sweep) {
        let shared = Arc::clone(shared);
        closes.spawn(async move {
            close_route_decision(&shared, handle, decision).await;
        });
    }
    while closes.join_next().await.is_some() {}
    shared
        .connections
        .lock()
        .expect("connections lock")
        .remove(&gen.id);
}

/// Forced-path cleanup after the shutdown deadline: aborts every remaining
/// route task and still runs exactly-once route-gone before handler drop
/// (protocol §12 forced shutdown). Route drains run concurrently — bounded by
/// `max_routes` — because a serial sweep would multiply each route-gone
/// callback's deadline by the route count while `run` holds the instance lock.
pub async fn force_close_all_routes<H: McHostHandler>(shared: &Arc<HostShared<H>>) {
    let mut drains = tokio::task::JoinSet::new();
    for (handle, tasks) in shared.registry.force_drain() {
        let shared = Arc::clone(shared);
        drains.spawn(async move {
            for task in tasks {
                task.abort();
                let _ = timeout(shared.timing.lifecycle_callback_deadline, task).await;
            }
            run_route_gone(&shared, handle).await;
            shared.registry.finalize_close(handle);
        });
    }
    while drains.join_next().await.is_some() {}
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
            written: None,
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
