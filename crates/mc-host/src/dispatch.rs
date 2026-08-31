//! This module dispatches requests and orchestrates first-terminal-wins settlement and route/generation closure.
//! close orchestration.
//!
//! Logical settlement is distinct from socket-write outcome:
//! `Settlement` records which terminal won; the writer reports whether bytes were sent.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::wire::{EnvelopeHeader, Flags, FrameType, HEADER_LEN};
use tokio::sync::oneshot;
use tokio::time::{timeout, timeout_at, Instant};
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;

use crate::connection::{GenerationCore, PendingEntry, PendingKey};
use crate::control::{CODE_CANCELLED, CODE_INTERNAL_ERROR, CODE_SERVER_BUSY, CODE_UNKNOWN_CHANNEL};
use crate::frame_channel::{DirectFrame, OutboundFrame, OwnedInboundFrame};
use crate::handler::{
    McHostHandler, OutputBuffer, OutputParts, RequestCtx, RequestOutcome, RouteHandle, StreamClosed,
};
use crate::routing::{BindInstall, CloseDecision};
use crate::runtime::HostShared;
use crate::wire::{encode_owned_frame, pure_header_flags, response_flags, FrameId};

/// `Settlement` arbitrates first-terminal-wins settlement for one correlation.
///
/// `order` prevents stream items from being queued after a terminal.
/// `order` makes the `won` check race-free.
/// `won` flips exactly once when handler completion, cancellation, route close, or teardown arrives first.
pub struct Settlement {
    won: AtomicBool,
    order: tokio::sync::Mutex<()>,
    /// `streamed` is set once any `StreamData` item reaches the writer.
    /// A streamed response may terminate only with `StreamEnd` or `Error` (protocol §8.3).
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

pub enum Terminal {
    Response {
        body: OutputBuffer,
        binary: bool,
    },
    Error {
        code: String,
        message: String,
        retry_after_ms: Option<u64>,
    },
    StreamEnd,
}

/// `MAX_TERMINAL_CODE_LEN` and `MAX_TERMINAL_MESSAGE_LEN` bound diagnostics held across egress waits without budget charge.
const MAX_TERMINAL_CODE_LEN: usize = 128;
const MAX_TERMINAL_MESSAGE_LEN: usize = 4096;

fn bounded_terminal_error(code: String, message: String, retry_after_ms: Option<u64>) -> Terminal {
    if code.len() > MAX_TERMINAL_CODE_LEN || message.len() > MAX_TERMINAL_MESSAGE_LEN {
        return Terminal::Error {
            code: CODE_INTERNAL_ERROR.to_owned(),
            message: "handler error exceeds diagnostic limit".to_owned(),
            retry_after_ms: None,
        };
    }
    Terminal::Error {
        code,
        message,
        retry_after_ms,
    }
}

/// `escaped_json_len` returns the escaped UTF-8 byte length of `s` without materializing it.
fn escaped_json_len(s: &str) -> usize {
    s.bytes()
        .map(|byte| match byte {
            b'"' | b'\\' | 0x08 | 0x09 | 0x0A | 0x0C | 0x0D => 2,
            0x00..=0x1F => 6,
            _ => 1,
        })
        .sum()
}

fn decimal_u64_len(value: u64) -> usize {
    value.checked_ilog10().map_or(1, |log| log as usize + 1)
}

fn error_body_len(code: &str, message: &str, retry_after_ms: Option<u64>) -> usize {
    const ERROR_ENVELOPE_OVERHEAD: usize = r#"{"code":"","message":""}"#.len();
    const RETRY_AFTER_FIELD_OVERHEAD: usize = b",\"retry_after_ms\":".len();
    escaped_json_len(code)
        .saturating_add(escaped_json_len(message))
        .saturating_add(ERROR_ENVELOPE_OVERHEAD)
        .saturating_add(retry_after_ms.map_or(0, |value| {
            RETRY_AFTER_FIELD_OVERHEAD.saturating_add(decimal_u64_len(value))
        }))
}

/// The caller must acquire egress capacity before building an error terminal body.
/// `charge_frame_or_cancel` charges `bytes` or cancels the generation.
///
/// `None` means cancellation won or egress admission exceeded the writer deadline.
///
/// `also_cancelled` is the request-scoped cancellation token.
///
async fn charge_frame_or_cancel(
    budget: &crate::wire::ByteBudget,
    generation: &GenerationCore,
    bytes: u32,
    deadline: Instant,
    also_cancelled: Option<&CancellationToken>,
) -> Option<crate::wire::ByteCharge> {
    let request_cancelled = async {
        match also_cancelled {
            Some(token) => token.cancelled().await,
            None => std::future::pending().await,
        }
    };
    tokio::select! {
        biased;
        () = request_cancelled => None,
        () = generation.token.cancelled() => None,
        charge = timeout_at(deadline, budget.charge(bytes)) => match charge {
            Ok(charge) => Some(charge),
            Err(_) => {
                generation.token.cancel();
                None
            }
        },
    }
}

/// The budget charges bytes before `error_body_json_into` allocates the body.
/// errors wait on the budget as bytes, not as retained encoded buffers.
/// `charged_error_body` returns the deadline used for budget admission.
/// The returned deadline keeps serialization and queueing within one admission window.
async fn charged_error_body(
    budget: &crate::wire::ByteBudget,
    gen: &GenerationCore,
    code: &str,
    message: &str,
    retry_after_ms: Option<u64>,
) -> Result<(OutputBuffer, Instant), ()> {
    let (code, message, retry_after_ms) =
        if error_body_len(code, message, retry_after_ms) > crate::wire::MAX_BODY_LEN as usize {
            (
                CODE_INTERNAL_ERROR,
                "handler error exceeds frame limit",
                None,
            )
        } else {
            (code, message, retry_after_ms)
        };
    let body_len = error_body_len(code, message, retry_after_ms);
    if gen.writer.is_retired() || gen.token.is_cancelled() {
        return Err(());
    }
    let frame_bytes = u32::try_from(body_len + HEADER_LEN).map_err(|_| ())?;
    let deadline = gen.writer.admission_deadline();
    let charge = charge_frame_or_cancel(budget, gen, frame_bytes, deadline, None)
        .await
        .ok_or(())?;
    let body = error_body_json_into(
        // Without header capacity, `encode_owned_frame` reallocates the body buffer.
        // Reallocation transiently retains two near-maximum bodies under one charge.
        Vec::with_capacity(body_len + HEADER_LEN),
        code,
        message,
        retry_after_ms,
    );
    debug_assert_eq!(body.len(), body_len, "escaped length model diverged");
    Ok((
        OutputBuffer {
            body,
            direct: None,
            charge,
            max_len: body_len,
        },
        deadline,
    ))
}

/// Writing directly to `buf` avoids allocating a `serde_json::Value`.
/// models exactly.
fn error_body_json_into(
    mut buf: Vec<u8>,
    code: &str,
    message: &str,
    retry_after_ms: Option<u64>,
) -> Vec<u8> {
    buf.extend_from_slice(b"{\"code\":");
    serde_json::to_writer(&mut buf, code).expect("string serialization cannot fail");
    buf.extend_from_slice(b",\"message\":");
    serde_json::to_writer(&mut buf, message).expect("string serialization cannot fail");
    if let Some(retry_after_ms) = retry_after_ms {
        buf.extend_from_slice(b",\"retry_after_ms\":");
        serde_json::to_writer(&mut buf, &retry_after_ms)
            .expect("integer serialization cannot fail");
    }
    buf.push(b'}');
    buf
}

/// `Err` means the generation can no longer emit.
///
/// Structural-corruption and connection-teardown closes must remain silent rather than emit terminals.
pub async fn emit_frame(
    budget: &crate::wire::ByteBudget,
    gen: &GenerationCore,
    ty: FrameType,
    flags: Flags,
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
        let frame_bytes = u32::try_from(body.len() + HEADER_LEN).map_err(|_| ())?;
        charge_frame_or_cancel(budget, gen, frame_bytes, deadline, None)
            .await
            .ok_or(())?
    };
    let (bytes, tail) = crate::wire::encode_split_frame(ty, flags, id, body).map_err(|_| ())?;
    gen.writer
        .send_before(
            OutboundFrame {
                bytes,
                tail,
                direct: None,
                charge,
                written: None,
            },
            deadline,
        )
        .await
        .map_err(|_| ())
}

/// The charge transfers directly to the writer without a second budget acquisition.
/// `charged_error_body` reuses its admission deadline so error emission remains one bounded operation.
async fn emit_reserved_frame(
    gen: &GenerationCore,
    ty: FrameType,
    flags: Flags,
    id: FrameId,
    body: OutputBuffer,
    deadline: Instant,
) -> Result<(), ()> {
    if gen.writer.is_retired() || gen.token.is_cancelled() {
        return Err(());
    }
    let (bytes, tail, direct, charge) = match body.into_parts() {
        OutputParts::Owned(body, charge) => {
            let (bytes, tail) =
                crate::wire::encode_split_frame(ty, flags, id, body).map_err(|_| ())?;
            (bytes, tail, None, charge)
        }
        OutputParts::Direct(body, charge) => {
            let len = u32::try_from(body.len).map_err(|_| ())?;
            let header = EnvelopeHeader {
                len,
                ver: crate::wire::PROTOCOL_VERSION,
                ty,
                flags,
                channel: id.channel,
                epoch: id.epoch,
                corr: id.corr,
            };
            (
                Vec::new(),
                Vec::new(),
                Some(DirectFrame::new(header, body.len, body.serializer)),
                charge,
            )
        }
    };
    gen.writer
        .send_before(
            OutboundFrame {
                bytes,
                tail,
                direct,
                charge,
                written: None,
            },
            deadline,
        )
        .await
        .map_err(|_| ())
}

/// The host emits one terminal `Error` for a correlation with no settlement object.
pub async fn emit_error_terminal(
    budget: &crate::wire::ByteBudget,
    gen: &GenerationCore,
    id: FrameId,
    code: &str,
    message: &str,
) {
    let Ok((body, deadline)) = charged_error_body(budget, gen, code, message, None).await else {
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

/// The `settle` function settles a request with `terminal` only if no earlier call settled it.
/// The `settle` function returns whether it won the settlement race.
/// Holding `settlement.order` until terminal emission prevents late stream items from following the terminal.
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
            // `settlement.order` serializes stream emission, so `has_streamed()` must be checked while holding it.
            if settlement.has_streamed() {
                drop(body);
                let Ok((error_body, deadline)) = charged_error_body(
                    budget,
                    gen,
                    CODE_INTERNAL_ERROR,
                    "handler returned a unary response after streaming",
                    None,
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
        Terminal::Error {
            code,
            message,
            retry_after_ms,
        } => {
            let Ok((body, deadline)) =
                charged_error_body(budget, gen, &code, &message, retry_after_ms).await
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

/// `StreamSink` serializes stream-item emission for each request.
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
        // Terminal selection closes `StreamSink` so escaped contexts cannot reserve buffers that `send` cannot emit.
        if max_len > crate::wire::MAX_BODY_LEN as usize
            || self.cancel.is_cancelled()
            || self.settlement.won.load(Ordering::SeqCst)
        {
            return Err(StreamClosed);
        }
        let bytes = u32::try_from(max_len + HEADER_LEN).map_err(|_| StreamClosed)?;
        let deadline = self.gen.writer.admission_deadline();
        let charge =
            charge_frame_or_cancel(&self.budget, &self.gen, bytes, deadline, Some(&self.cancel))
                .await
                .ok_or(StreamClosed)?;
        if self.cancel.is_cancelled()
            || self.gen.token.is_cancelled()
            || self.settlement.won.load(Ordering::SeqCst)
        {
            return Err(StreamClosed);
        }
        Ok(OutputBuffer {
            body: Vec::with_capacity(max_len + HEADER_LEN),
            direct: None,
            charge,
            max_len,
        })
    }

    pub(crate) async fn reserve_direct(
        &self,
        exact_len: usize,
        serializer: impl FnOnce(&mut dyn std::io::Write) -> std::io::Result<()> + Send + 'static,
    ) -> Result<OutputBuffer, StreamClosed> {
        if exact_len > crate::wire::MAX_BODY_LEN as usize
            || self.cancel.is_cancelled()
            || self.settlement.won.load(Ordering::SeqCst)
        {
            return Err(StreamClosed);
        }
        let bytes = u32::try_from(exact_len + crate::wire::HEADER_LEN).map_err(|_| StreamClosed)?;
        let deadline = self.gen.writer.admission_deadline();
        let charge =
            charge_frame_or_cancel(&self.budget, &self.gen, bytes, deadline, Some(&self.cancel))
                .await
                .ok_or(StreamClosed)?;
        if self.cancel.is_cancelled()
            || self.gen.token.is_cancelled()
            || self.settlement.won.load(Ordering::SeqCst)
        {
            return Err(StreamClosed);
        }
        Ok(OutputBuffer {
            body: Vec::new(),
            direct: Some(crate::handler::DirectOutput {
                len: exact_len,
                serializer: Box::new(serializer),
            }),
            charge,
            max_len: exact_len,
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

/// The connection reader emits one no-dispatch rejection terminal in a task while the per-generation bound permits it.
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
            // The connection reader retires the generation after 32 no-dispatch rejections are blocked on contended egress; awaiting inline can starve queued Pong processing for a frame deadline.
            gen.token.cancel();
            gen.writer.discard();
        }
    }
}

/// The host serves one authenticated `host.shutdown` request against its commit latch.
///
/// The `CommitOnAck` hook commits and cancels the host after the writer completes the frame.
/// The writer runs the hook only after writing the full frame.
/// Charge, encoding, enqueue, writer-retirement, and partial-write failures leave the hook unrun.
/// Charge, encoding, enqueue, writer-retirement, and partial-write failures drop the hook without running it, reopening ownership for a later requester.
/// Contenders wait for the active attempt's outcome; only a committed attempt replies without a second commit.
/// Contenders receive a reply without a second commit only after the active attempt commits.
pub async fn handle_host_shutdown<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    corr: u64,
) {
    loop {
        // A reopen between `try_own` and the first poll must be handled because `notify_waiters` wakes only enabled or polled futures.
        // forever.
        let changed = shared.shutdown_latch.changed();
        tokio::pin!(changed);
        changed.as_mut().enable();
        match shared.shutdown_latch.try_own() {
            crate::lifecycle::LatchDecision::Owner => break,
            crate::lifecycle::LatchDecision::Committed => {
                // A request that observes `Committed` still emits a success response with `corr`.
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

    // `CommitOnAck` is constructed before fallible operations so Drop reopens the latch on early return or panic unwind.
    let commit = crate::lifecycle::CommitOnAck::new(
        Arc::clone(&shared.shutdown_latch),
        shared.shutdown.clone(),
    );
    let body = crate::control::host_shutdown_response_json();
    if gen.writer.is_retired() || gen.token.is_cancelled() {
        return;
    }
    let deadline = gen.writer.admission_deadline();
    let frame_bytes = u32::try_from(body.len() + HEADER_LEN).expect("fixed-size body");
    let Some(charge) =
        charge_frame_or_cancel(&shared.egress_budget, gen, frame_bytes, deadline, None).await
    else {
        return;
    };
    let Ok(bytes) = encode_owned_frame(
        FrameType::Response,
        response_flags(false, true),
        FrameId::control(corr),
        body,
    ) else {
        // The generation is cancelled when encoding fails so the requester receives either a response or cancellation.
        gen.token.cancel();
        return;
    };
    let _ = gen
        .writer
        .send_before(
            OutboundFrame {
                bytes,
                tail: Vec::new(),
                direct: None,
                charge,
                written: Some(Box::new({
                    let shared = Arc::clone(shared);
                    move |_completed_at| {
                        // The write acknowledgement is the commit point.
                        // `shutdown_sequence` restores admission only after the accept loop observes cancellation.
                        shared.draining.store(true, Ordering::SeqCst);
                        shared.registry.freeze_admission();
                        commit.acknowledge();
                    }
                })),
            },
            deadline,
        )
        .await;
    // Earlier stalled frames can delay the committing response until the write deadline.
    // The admission deadline covers write completion so stalled earlier frames cannot retain `ResponseInFlight` indefinitely.
    // Write-deadline expiry before commit retires the generation.
    // Retiring the generation drops `CommitOnAck` without committing and reopens the latch.
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

/// The sender reports through `written_tx` when the rejection frame fully reaches the socket.
/// The caller can fence a silent close after `written_tx` reports the rejection frame.
/// The sender drops the completion notification if emission fails.
pub(crate) async fn emit_authoritative_rejection<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    id: FrameId,
    code: &'static str,
    message: &'static str,
    written_tx: oneshot::Sender<()>,
) {
    let Ok((body, deadline)) =
        charged_error_body(&shared.egress_budget, gen, code, message, None).await
    else {
        return;
    };
    let OutputParts::Owned(body, charge) = body.into_parts() else {
        return;
    };
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
                direct: None,
                charge,
                written: Some(Box::new(move |_completed_at| {
                    let _ = written_tx.send(());
                })),
            },
            deadline,
        )
        .await;
}

///
/// Route lookup proves `unknown_channel` without consuming capacity; capacity rejections prove no dispatch; only then is the single handler task spawned.
pub async fn dispatch_request<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    frame: OwnedInboundFrame,
) {
    let header = frame.header;
    let route = RouteHandle {
        channel: header.channel,
        epoch: header.epoch,
    };
    let corr = header.corr;

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

    // `register_dispatch` rechecks admission before dispatch.
    // The tracker wraps the dispatch future so route close can wait for it to stop even if the waiting future is dropped.
    let Some((route_tracker, class)) = shared.registry.route_tracker(route, gen.id) else {
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
    let (pending_pool, task_pool) = match class {
        crate::handler::RouteClass::General => (&shared.pending_permits, &shared.task_permits),
        crate::handler::RouteClass::Reserved => (
            &shared.reserved_pending_permits,
            &shared.reserved_task_permits,
        ),
    };

    // Admission acquires permits synchronously with the read loop to prevent clients from queueing unbounded dispatch tasks ahead of the capacity gate.
    let Ok(pending_permit) = pending_pool.clone().try_acquire_owned() else {
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
    let Ok(task_permit) = task_pool.clone().try_acquire_owned() else {
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

    // The pending entry is visible before the read loop processes later frames, so a pipelined `Cancel` finds the correlation.
    // `cancel` remains a free-standing root; route close cancels collected pending entries explicitly.
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
    // The route completion fence covers the handler callback because dropping the outer task only requests callback abort.
    // Without the handler fence, route close could see the tracker empty while request code still runs.
    let handler_fence = route_tracker.clone();
    let outer = shared.spawn_tracked(route_tracker.track_future(async move {
        let _pending_permit = pending_permit;
        if start_rx.await.is_err() {
            remove_pending(&gen_task, key);
            return;
        }

        let OwnedInboundFrame {
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
                    retry_after_ms: None,
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
            // A handler that moves the body into a background task retains ingress accounting in that task.
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
            // The task permit belongs to the callback task so capacity frees when the handler finishes rather than when terminal emission settles.
            let _task_permit = task_permit;
            // Construct the callback under the sync guard and poll it under the async guard so synchronous prologue panics reach the redacting hook.
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
                        retry_after_ms: None,
                    },
                )
                .await;
            }
            joined = &mut inner => {
                let terminal = match joined {
                    Ok(RequestOutcome::Response { .. }) if settlement.has_streamed() => {
                        // After `StreamData`, protocol §8.3 permits only `StreamEnd` or `Error`; a unary `Response` would corrupt the client's stream state.
                        Terminal::Error {
                            code: CODE_INTERNAL_ERROR.to_owned(),
                            message: "handler returned a unary response after streaming"
                                .to_owned(),
                            retry_after_ms: None,
                        }
                    }
                    Ok(RequestOutcome::Response { body, binary })
                        if body.len() <= crate::wire::MAX_BODY_LEN as usize => {
                            Terminal::Response { body, binary }
                        }
                    Ok(RequestOutcome::Response { .. }) => Terminal::Error {
                        code: CODE_INTERNAL_ERROR.to_owned(),
                        message: "handler response exceeds frame limit".to_owned(),
                        retry_after_ms: None,
                    },
                    Ok(RequestOutcome::Error {
                        code,
                        message,
                        retry_after_ms,
                    }) => {
                        // max_pending_requests settlements.
                        bounded_terminal_error(code, message, retry_after_ms)
                    }
                    Ok(RequestOutcome::Streamed) => Terminal::StreamEnd,
                    Err(join_err) if join_err.is_panic() => Terminal::Error {
                        code: CODE_INTERNAL_ERROR.to_owned(),
                        message: "handler request task failed".to_owned(),
                        retry_after_ms: None,
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

pub async fn open_route<H: McHostHandler>(
    shared: Arc<HostShared<H>>,
    gen: Arc<GenerationCore>,
    corr: u64,
    target: crate::handler::RouteTarget,
    identity: crate::handler::RouteIdentity,
) {
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
    let class = shared
        .targets
        .class_of(&target.module_id)
        .expect("validated route.open target is indexed");
    let Some(handle) = shared.registry.reserve(&gen, class) else {
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
        Ok(None) | Err(crate::runtime::LifecycleFailure { stopped: true }) => {
            shared.registry.take_rejected_bind(handle);
            if run_route_gone(&shared, handle).await {
                shared.registry.finalize_close(handle);
            }
            return;
        }
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
                // (protocol AE8).
                if run_route_gone(&shared, handle).await {
                    shared.registry.finalize_close(handle);
                }
            }
        },
        crate::handler::BindOutcome::Reject { code, message } => {
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

///
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

pub async fn settle_route<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    handle: RouteHandle,
) -> bool {
    settle_route_work(shared, handle, shared.registry.begin_close(handle)).await
}

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

pub(crate) async fn finish_route_close<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    handle: RouteHandle,
) {
    if run_route_gone(shared, handle).await {
        shared.registry.finalize_close(handle);
    }
}

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

            // route-gone must follow dispatch tasks actually stopping.
            let deadline = Instant::now() + shared.timing.route_close_budget;
            tracker.close();
            if timeout_at(deadline, tracker.wait()).await.is_err() {
                for abort in &aborts {
                    abort.abort();
                }
                // A task observes abort only when it yields.
                // A future that never yields prevents its task from observing abort.
                // Shutdown must still terminate; trip the fatal latch when the task does not stop within the post-abort budget.
                if timeout(shared.timing.route_close_budget, tracker.wait())
                    .await
                    .is_err()
                {
                    // If `tracker.wait()` times out, request code may still execute; do not run route-gone.
                    // Running route-gone while request code executes races handler cleanup and channel finalization.
                    // is terminating.
                    shared.fatal.trip(
                        &shared.shutdown,
                        "dispatch task did not stop before route-gone".to_owned(),
                    );
                    return false;
                }
            }
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

pub async fn force_close_all_routes<H: McHostHandler>(shared: &Arc<HostShared<H>>) {
    let mut drains = tokio::task::JoinSet::new();
    for (handle, aborts, tracker) in shared.registry.force_drain() {
        let shared = Arc::clone(shared);
        drains.spawn(async move {
            for abort in &aborts {
                abort.abort();
            }
            tracker.close();
            if timeout(shared.timing.lifecycle_callback_deadline, tracker.wait())
                .await
                .is_err()
            {
                // Do not finalize while request code may still execute.
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
            direct: None,
            charge: crate::wire::ByteCharge::none(),
            written: None,
        })
        .await;
}

pub fn handle_cancel(gen: &GenerationCore, key: PendingKey) {
    let pending = gen.pending.lock().expect("pending lock");
    if let Some(entry) = pending.get(&key) {
        if !entry.settlement.is_settled() {
            entry.cancel.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{bounded_terminal_error, error_body_json_into, error_body_len, Terminal};

    #[test]
    fn error_body_length_model_is_exact_with_and_without_retry_hint() {
        for retry_after_ms in [None, Some(0), Some(9), Some(10), Some(50), Some(u64::MAX)] {
            let code = "quoted\"code";
            let message = "line one\nline two\\tail";
            let expected = error_body_len(code, message, retry_after_ms);
            let body =
                error_body_json_into(Vec::with_capacity(expected), code, message, retry_after_ms);
            assert_eq!(body.len(), expected);
            assert_eq!(body.capacity(), expected);

            let parsed: serde_json::Value =
                serde_json::from_slice(&body).expect("valid error JSON");
            assert_eq!(parsed["code"], code);
            assert_eq!(parsed["message"], message);
            match retry_after_ms {
                Some(value) => assert_eq!(parsed["retry_after_ms"], value),
                None => assert!(parsed.get("retry_after_ms").is_none()),
            }
        }
    }

    #[test]
    fn diagnostic_limit_substitution_drops_retry_hint() {
        let terminal = bounded_terminal_error("x".repeat(129), "message".to_owned(), Some(50));
        let Terminal::Error {
            code,
            message,
            retry_after_ms,
        } = terminal
        else {
            panic!("expected error terminal");
        };
        assert_eq!(code, "internal_error");
        assert_eq!(message, "handler error exceeds diagnostic limit");
        assert_eq!(retry_after_ms, None);
    }
}
