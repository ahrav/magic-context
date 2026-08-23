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

/// Longest handler-authored diagnostic retained on a terminal. Diagnostics
/// are held across the egress wait without a charge, so the cap — not the
/// frame limit — is what bounds their retained cost per pending request.
/// Anything larger is replaced immediately, dropping the oversized strings.
const MAX_TERMINAL_CODE_LEN: usize = 128;
const MAX_TERMINAL_MESSAGE_LEN: usize = 4096;

fn bounded_terminal_error(code: String, message: String) -> Terminal {
    if code.len() > MAX_TERMINAL_CODE_LEN || message.len() > MAX_TERMINAL_MESSAGE_LEN {
        return Terminal::Error {
            code: CODE_INTERNAL_ERROR.to_owned(),
            message: "handler error exceeds diagnostic limit".to_owned(),
        };
    }
    Terminal::Error { code, message }
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
/// Returns the buffer with the admission deadline the budget wait ran under:
/// serialization and queueing are contiguous, so the whole error emission is
/// one bounded operation rather than two stacked frame deadlines. `Err`
/// means the generation can no longer emit.
async fn charged_error_body(
    budget: &crate::wire::ByteBudget,
    gen: &GenerationCore,
    code: &str,
    message: &str,
) -> Result<(OutputBuffer, Instant), ()> {
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
    Ok((
        OutputBuffer {
            body,
            charge,
            max_len: body_len,
        },
        deadline,
    ))
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
    let (bytes, tail) = crate::wire::encode_split_frame(ty, flags, id, body).map_err(|_| ())?;
    gen.writer
        .send_before(
            OutboundFrame {
                bytes,
                tail,
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
/// budget acquisition. `deadline` is the caller's admission window: handler
/// outputs pass a fresh one at submission (a handler may validly compute
/// longer than one window after reserving), while error emission passes the
/// deadline its budget wait already ran under so the whole emission stays
/// one bounded operation.
async fn emit_reserved_frame(
    gen: &GenerationCore,
    ty: FrameType,
    flags: subc_protocol::Flags,
    id: FrameId,
    body: OutputBuffer,
    deadline: Instant,
) -> Result<(), ()> {
    if gen.writer.is_retired() || gen.token.is_cancelled() {
        return Err(());
    }
    let (body, charge) = body.into_parts();
    let (bytes, tail) = crate::wire::encode_split_frame(ty, flags, id, body).map_err(|_| ())?;
    gen.writer
        .send_before(
            OutboundFrame {
                bytes,
                tail,
                charge,
                written: None,
            },
            deadline,
        )
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
    let Ok((body, deadline)) = charged_error_body(budget, gen, code, message).await else {
        gen.token.cancel();
        return;
    };
    if emit_reserved_frame(
        gen,
        FrameType::Error,
        response_flags(false, true),
        id,
        body,
        deadline,
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
            // Authoritative streamed-state check, under the same order lock
            // that serializes stream emission: a context escaped into a
            // background task can queue StreamData after the caller's
            // outside-the-lock check, and a Response following StreamData is
            // a forbidden sequence (protocol §8.3).
            if settlement.has_streamed() {
                drop(body);
                let Ok((error_body, deadline)) = charged_error_body(
                    budget,
                    gen,
                    CODE_INTERNAL_ERROR,
                    "handler returned a unary response after streaming",
                )
                .await
                else {
                    gen.token.cancel();
                    return true;
                };
                if emit_reserved_frame(
                    gen,
                    FrameType::Error,
                    response_flags(false, true),
                    FrameId::routed(route, corr),
                    error_body,
                    deadline,
                )
                .await
                .is_err()
                {
                    gen.token.cancel();
                }
                return true;
            }
            if emit_reserved_frame(
                gen,
                FrameType::Response,
                response_flags(binary, true),
                FrameId::routed(route, corr),
                body,
                gen.writer.admission_deadline(),
            )
            .await
            .is_err()
            {
                gen.token.cancel();
            }
            return true;
        }
        Terminal::Error { code, message } => {
            let Ok((body, deadline)) = charged_error_body(budget, gen, &code, &message).await
            else {
                gen.token.cancel();
                return true;
            };
            if emit_reserved_frame(
                gen,
                FrameType::Error,
                response_flags(false, true),
                FrameId::routed(route, corr),
                body,
                deadline,
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
                self.gen.writer.admission_deadline(),
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
            // Past the bound, awaiting inline would stall the generation's
            // sole reader for a frame deadline and starve a queued Pong into
            // a liveness false-kill. A peer with 32 no-dispatch rejections
            // already stuck on contended egress is past its capacity grant:
            // retire the generation instead (O(1), no reader stall). The
            // unemitted terminals become outcome_unknown, which is the
            // documented result of retirement (protocol §6.3).
            gen.token.cancel();
            gen.writer.discard();
        }
    }
}

/// Serves one authenticated `host.shutdown` request against the host-owned
/// commit latch (plan KTD4).
///
/// The owner enqueues the correlated success response carrying a
/// [`crate::lifecycle::CommitOnAck`] hook: commit and host cancellation run
/// inside the writer task at full-frame write completion, and every earlier
/// failure — charge, encode, enqueue, writer retirement, partial write —
/// drops the hook unrun, reopening ownership for a later requester.
/// Contenders wait for the active attempt's outcome; only a committed
/// attempt answers them without a second commit.
pub async fn handle_host_shutdown<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    corr: u64,
) {
    loop {
        // `notify_waiters` wakes only enabled or polled futures, so a reopen
        // between the check and the first poll would otherwise be missed
        // forever.
        let changed = shared.shutdown_latch.changed();
        tokio::pin!(changed);
        changed.as_mut().enable();
        match shared.shutdown_latch.try_own() {
            crate::lifecycle::LatchDecision::Owner => break,
            crate::lifecycle::LatchDecision::Committed => {
                // A prior attempt already linearized the stop; this request
                // still settles with its own correlated success.
                if emit_frame(
                    &shared.egress_budget,
                    gen,
                    FrameType::Response,
                    response_flags(false, true),
                    FrameId::control(corr),
                    crate::control::host_shutdown_response_json(),
                )
                .await
                .is_err()
                {
                    gen.token.cancel();
                }
                return;
            }
            crate::lifecycle::LatchDecision::Wait => {
                tokio::select! {
                    biased;
                    () = gen.token.cancelled() => return,
                    () = &mut changed => continue,
                }
            }
        }
    }

    // Owner path. Constructed before any fallible step so every early return
    // (or panic unwind) reopens the latch via Drop.
    let commit = crate::lifecycle::CommitOnAck::new(
        Arc::clone(&shared.shutdown_latch),
        shared.shutdown.clone(),
    );
    let body = crate::control::host_shutdown_response_json();
    if gen.writer.is_retired() || gen.token.is_cancelled() {
        return;
    }
    let deadline = gen.writer.admission_deadline();
    let frame_bytes =
        u32::try_from(body.len() + subc_protocol::HEADER_LEN).expect("fixed-size body");
    let charge = tokio::select! {
        biased;
        () = gen.token.cancelled() => return,
        charge = timeout_at(deadline, shared.egress_budget.charge(frame_bytes)) => match charge {
            Ok(charge) => charge,
            Err(_) => {
                gen.token.cancel();
                return;
            }
        },
    };
    let Ok(bytes) = encode_owned_frame(
        FrameType::Response,
        response_flags(false, true),
        FrameId::control(corr),
        body,
    ) else {
        // Unreachable for the fixed-size shutdown body, but tear the
        // generation down like every sibling failure branch rather than
        // stranding the requester without a response or a cancellation.
        gen.token.cancel();
        return;
    };
    let _ = gen
        .writer
        .send_before(
            OutboundFrame {
                bytes,
                tail: Vec::new(),
                charge,
                written: Some(Box::new({
                    let shared = Arc::clone(shared);
                    move |_completed_at| {
                        // The write acknowledgement IS the commit point, so
                        // the admission fence must flip here, atomically with
                        // it: `shutdown_sequence` stores these again only
                        // after the accept loop observes cancellation, and a
                        // dispatch that passed the flag checks before the
                        // commit must find the registry already frozen.
                        shared.draining.store(true, Ordering::SeqCst);
                        shared.registry.freeze_admission();
                        commit.acknowledge();
                    }
                })),
            },
            deadline,
        )
        .await;
    // Admission into the writer queue is not delivery: behind a slow reader,
    // the committing response could otherwise sit queued for the whole
    // per-frame stall budget of every earlier frame while the latch holds
    // `ResponseInFlight` and healthy requesters can only wait. Hold the same
    // absolute deadline through write completion: if the commit has not
    // happened by then, retire the winning generation, which drops the
    // acknowledgement hook unfired and reopens the latch for a successor.
    let shutdown = shared.shutdown.clone();
    let gen_watch = Arc::clone(gen);
    tokio::spawn(async move {
        tokio::select! {
            biased;
            () = shutdown.cancelled() => {}
            () = gen_watch.token.cancelled() => {}
            () = tokio::time::sleep_until(deadline) => {
                gen_watch.token.cancel();
            }
        }
    });
}

/// Queues one §7.1-authoritative rejection terminal and reports (via
/// `written_tx`) when its bytes fully reach the socket, so the caller can
/// fence an otherwise-silent close around exactly this frame. The sender
/// drops unfired if the emission fails at any stage.
pub(crate) async fn emit_authoritative_rejection<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    id: FrameId,
    code: &'static str,
    message: &'static str,
    written_tx: oneshot::Sender<()>,
) {
    let Ok((body, deadline)) = charged_error_body(&shared.egress_budget, gen, code, message).await
    else {
        return;
    };
    let (body, charge) = body.into_parts();
    let Ok(bytes) = encode_owned_frame(FrameType::Error, response_flags(false, true), id, body)
    else {
        return;
    };
    let _ = gen
        .writer
        .send_before(
            OutboundFrame {
                bytes,
                tail: Vec::new(),
                charge,
                written: Some(Box::new(move |_completed_at| {
                    let _ = written_tx.send(());
                })),
            },
            deadline,
        )
        .await;
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

    // `draining` is stored by the shutdown sequence, which starts only after
    // the accept loop observes cancellation; a request pipelined behind a
    // committed `host.shutdown` response can reach here first. The token
    // check makes the admission fence coincide with the commit point.
    if shared.draining.load(Ordering::SeqCst) || shared.shutdown.is_cancelled() {
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
    // `register_dispatch` below is the authoritative recheck. The tracker
    // wraps the dispatch future so route close can wait for it to STOP even
    // if the waiting future is later dropped.
    let Some(route_tracker) = shared.registry.route_tracker(route, gen.id) else {
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
    };

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
    // The route's completion fence must cover the handler callback itself, not
    // just this outer task: aborting the outer drops its AbortOnDropHandle,
    // which only REQUESTS the callback's abort, so a route close could
    // otherwise see the tracker empty while request code still runs.
    let handler_fence = route_tracker.clone();
    let outer = shared.spawn_tracked(route_tracker.track_future(async move {
        let _pending_permit = pending_permit;
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
            // The charge travels inside the body: a handler that moves it
            // into a background task keeps the ingress accounting with it.
            body: crate::handler::InputBuffer {
                body,
                _charge: body_charge,
            },
            binary,
            cancel: cancel.clone(),
            stream: sink,
            scratch: shared_task.scratch_budget.clone(),
        };
        let handler = Arc::clone(&shared_task.handler);
        let inner = shared_task.spawn_tracked(handler_fence.track_future(async move {
            // The task permit lives in the callback task, not the settling
            // outer task: capacity frees when the handler finishes, so a
            // slow client blocking terminal emission cannot occupy
            // max_handler_tasks with already-finished handlers.
            let _task_permit = task_permit;
            // Construct under the sync guard, poll under the async guard:
            // a panic in the callback's synchronous prologue must reach the
            // redacting hook too.
            let callback = crate::panic_boundary::redact_sync(|| handler.handle(ctx));
            crate::panic_boundary::redact(callback).await
        }));
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
                    Ok(RequestOutcome::Error { code, message }) => {
                        // Normalized before the terminal is held across the
                        // egress wait: the handler task permit is already
                        // released, so oversized owned strings would otherwise
                        // accumulate uncharged across up to
                        // max_pending_requests settlements.
                        bounded_terminal_error(code, message)
                    }
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
    }));

    if shared
        .registry
        .register_dispatch(route, gen.id, outer.abort_handle())
        .is_some()
    {
        let _ = start_tx.send(());
    } else {
        // No dispatch crossed the registry's live-route linearization point,
        // so this rejection proves zero handler invocation; the spawned task
        // observes the dropped start signal and removes the pending entry.
        // Registration refuses for two distinct reasons that need different
        // codes: frozen admission (the shutdown fence won the race after the
        // advisory check above) is retryable-elsewhere `server_busy`, while
        // a route that left Live is `unknown_channel`.
        drop(start_tx);
        let (code, message) =
            if shared.draining.load(Ordering::SeqCst) || shared.shutdown.is_cancelled() {
                (CODE_SERVER_BUSY, "host is shutting down")
            } else {
                (
                    CODE_UNKNOWN_CHANNEL,
                    "no live route for this channel and epoch",
                )
            };
        emit_rejection(shared, gen, FrameId::routed(route, corr), code, message).await;
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
    target: crate::handler::RouteTarget,
    identity: crate::handler::RouteIdentity,
) {
    // Same fence as routed dispatch: reject at the shutdown commit point,
    // not only once the later shutdown sequence stores `draining`.
    if shared.draining.load(Ordering::SeqCst) || shared.shutdown.is_cancelled() {
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
        let callback =
            crate::panic_boundary::redact_sync(|| handler.bind(handle, target, identity));
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
    let outcome = match shared.lifecycle_join("bind", bind_task).await {
        Ok(Some(outcome)) => outcome,
        // The callback stopped (panic, abort) or self-bounded its own inner
        // deadline, so the handle is inert and cleanup may proceed.
        Ok(None) | Err(crate::runtime::LifecycleFailure { stopped: true }) => {
            shared.registry.take_rejected_bind(handle);
            if run_route_gone(&shared, handle).await {
                shared.registry.finalize_close(handle);
            }
            return;
        }
        // Still executing: running route-gone or freeing the channel would
        // overlap it for the same handle. The latch is already tripped, so
        // the route stays claimed and the incarnation terminates.
        Err(crate::runtime::LifecycleFailure { stopped: false }) => return,
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
                if run_route_gone(&shared, handle).await {
                    shared.registry.finalize_close(handle);
                }
            }
        },
        crate::handler::BindOutcome::Reject { code, message } => {
            // Normalized before the cleanup awaits below: these are
            // handler-authored strings held across route-gone and the egress
            // wait with no byte charge, so up to max_routes concurrent binds
            // would otherwise retain arbitrary allocations. Same caps as
            // request-error terminals.
            let (code, message) =
                if code.len() > MAX_TERMINAL_CODE_LEN || message.len() > MAX_TERMINAL_MESSAGE_LEN {
                    (
                        CODE_INTERNAL_ERROR.to_owned(),
                        "bind rejection exceeds diagnostic limit".to_owned(),
                    )
                } else {
                    (code, message)
                };
            shared.registry.take_rejected_bind(handle);
            let stopped = run_route_gone(&shared, handle).await;
            if stopped {
                shared.registry.finalize_close(handle);
            }
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
/// Returns whether the callback is no longer running: `false` means its
/// deadline expired inside a non-yielding poll, so the caller must NOT
/// finalize the route — finalizing frees the channel for reuse, and a later
/// bind on the same channel would overlap the still-running callback.
async fn run_route_gone<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    handle: RouteHandle,
) -> bool {
    if !shared.registry.mark_gone_started(handle) {
        return true;
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
    match shared.lifecycle_join("route_gone", task).await {
        Ok(()) => true,
        Err(failure) => failure.stopped,
    }
}

/// Phase A only, for host shutdown: settles a route's admitted work (emitting
/// its terminals) without running route-gone, so connection Goodbyes can be
/// queued between settlement and cleanup (protocol §12 steps 3-5). Returns
/// whether this caller owns the route's phase B.
pub async fn settle_route<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    handle: RouteHandle,
) -> bool {
    settle_route_work(shared, handle, shared.registry.begin_close(handle)).await
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
    if settle_route_work(shared, handle, decision).await {
        finish_route_close(shared, handle).await;
    }
}

/// Phase B of a route close: exactly-once route-gone, then finalize only if
/// the callback stopped. Split from settlement so host shutdown can queue
/// connection Goodbyes between the two (protocol §12 steps 3-5).
pub(crate) async fn finish_route_close<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    handle: RouteHandle,
) {
    if run_route_gone(shared, handle).await {
        shared.registry.finalize_close(handle);
    }
}

/// Phase A of a route close: cancel admitted work, emit its terminals, and
/// wait for dispatch tasks to stop. Returns whether the caller owns phase B.
pub(crate) async fn settle_route_work<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    handle: RouteHandle,
    decision: CloseDecision,
) -> bool {
    match decision {
        CloseDecision::AlreadyGone | CloseDecision::DeferredToBind => false,
        CloseDecision::Owner {
            gen,
            aborts,
            tracker,
        } => {
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

            // Grace, then abort, then WAIT on the registry-owned tracker:
            // route-gone must follow dispatch tasks actually stopping. The
            // tracker (not this future) owns that ability, so a dropped
            // drain leaves the forced path able to wait on the same signal.
            let deadline = Instant::now() + shared.timing.route_close_budget;
            tracker.close();
            if timeout_at(deadline, tracker.wait()).await.is_err() {
                for abort in &aborts {
                    abort.abort();
                }
                // Abort only takes effect at an await point, so a future that
                // never yields cannot be stopped by any mechanism; shutdown
                // must still terminate. Surface the violated ordering instead
                // of proceeding silently.
                if timeout(shared.timing.route_close_budget, tracker.wait())
                    .await
                    .is_err()
                {
                    // Request code may still be executing, so route-gone must
                    // NOT run: handler cleanup and channel finalization would
                    // race it. The latch makes the incarnation fatal instead,
                    // and this route stays claimed — inert, because the host
                    // is terminating.
                    shared.fatal.trip(
                        &shared.shutdown,
                        "dispatch task did not stop before route-gone".to_owned(),
                    );
                    return false;
                }
            }
            // Aborted tasks never removed their own pending entries.
            {
                let mut pending = gen.pending.lock().expect("pending lock");
                for key in keys {
                    pending.remove(&key);
                }
            }
            true
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
    for (handle, aborts, tracker) in shared.registry.force_drain() {
        let shared = Arc::clone(shared);
        drains.spawn(async move {
            for abort in &aborts {
                abort.abort();
            }
            // Wait for the route's dispatch tasks to STOP before route-gone,
            // even when a graceful close owner already claimed (and lost)
            // their handles: the tracker lives in the registry, so abort_all
            // plus this wait still proves no request code is running.
            tracker.close();
            if timeout(shared.timing.lifecycle_callback_deadline, tracker.wait())
                .await
                .is_err()
            {
                // Same rule as the graceful path: never run route-gone beside
                // still-executing request code. Fatal, and no finalize.
                shared.fatal.trip(
                    &shared.shutdown,
                    "dispatch task did not stop before route-gone".to_owned(),
                );
                return;
            }
            if run_route_gone(&shared, handle).await {
                shared.registry.finalize_close(handle);
            }
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
            tail: Vec::new(),
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
