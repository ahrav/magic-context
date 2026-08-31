//! This module runs one authenticated connection generation.
//!
//! Each generation owns its correlation watermark, membership lookups, pending correlation index, ping namespace, and writer; the global registry owns route cleanup.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use crate::wire::{FrameType, HEADER_LEN};
use tokio::net::TcpStream;
use tokio::sync::OwnedSemaphorePermit;
use tokio::time::{timeout_at, Instant};
use tokio_util::sync::CancellationToken;
use tokio_util::task::{AbortOnDropHandle, TaskTracker};

use crate::control::{parse_control, ControlAction, CODE_INVALID_CONTROL_REQUEST};
use crate::dispatch::{
    close_generation, dispatch_request, emit_error_terminal, emit_frame, handle_cancel, open_route,
};
use crate::frame_channel::{
    BoxedReceiver, FrameReceiver, FrameSender, InboundEvent, OutboundFrame, ReadClose,
    RejectedFrame,
};
use crate::handler::McHostHandler;
use crate::routing::CloseDecision;
use crate::runtime::HostShared;
use crate::tcp_frame_channel::TcpFrameChannel;
use crate::transport_negotiation::{
    activate_response_json, commit_response_json, decode_activate_request, decode_commit_request,
    encode_negotiate_response, FallbackReason, NegotiateRequest, NegotiateResponse,
    NegotiationError, SelectedTransport, ACTIVATION_CORRELATION, COMMIT_CORRELATION,
    NEGOTIATION_VERSION, TRANSPORT_TCP,
};
use crate::transport_provider::{
    fresh_activation_token, Candidate, GrantBinding, GrantRecord, InjectedProvider,
    PreflightEligibility, PreparedCandidate, ProviderContext, TCP_CAPABILITY_VERSION,
};
use crate::wire::{encode_owned_frame, pure_header_flags, response_flags, FrameId};

/// The pending-request map contains only consumer-originated requests; host Pings use a separate namespace.
pub type PendingKey = (u16, u32, u64);

/// Off-reader rejections reach this bound only when global pending capacity is exhausted and egress is contended.
const MAX_INFLIGHT_BUSY_REJECTS: usize = 32;

///
/// The reader accepts a Pong only when it observes the Pong at or after the Ping's `written_at`.
/// The writer sets `written_at` immediately after `write_all` returns.
///
/// The reader accepts a Pong observed at or after `written_at` even if it locks `pings` before the writer.
/// The reader discards a Pong observed before `written_at` because the Ping write had not completed.
///
/// Comparing against write start would admit pre-answers; requiring a mutex transition before the Pong would drop legitimate answers.
/// A peer can answer after receiving the bytes without reading them; no observer can distinguish that answer from a real answer.
/// The writer's per-frame stall deadline catches a peer that stops draining its socket.
pub struct PingProbe {
    pub flags: u8,
    pub sent: Instant,
    pub written_at: Option<Instant>,
    pub answered_at: Option<Instant>,
}

pub struct PendingEntry {
    pub cancel: CancellationToken,
    pub settlement: Arc<crate::dispatch::Settlement>,
}

/// The liveness handle stops and joins the bootstrap Ping task without retiring the generation.
/// generation.
pub struct LivenessHandle {
    pub stop: CancellationToken,
    pub task: tokio::task::JoinHandle<()>,
}

pub struct GenerationCore {
    pub id: u64,
    /// Cancellation retires the generation: reads stop, admitted work settles as cancelled, and the generation emits fail closed.
    pub token: CancellationToken,
    /// `read_cancel` stops the read side and generation-local frame producers but leaves the writer running to flush already-started terminals.
    pub read_cancel: CancellationToken,
    /// `read_tasks` contains read-loop tasks that can enqueue frames independently of route drains.
    /// Shutdown closes and joins this set before queuing connection Goodbye.
    pub read_tasks: TaskTracker,
    /// The connection owner is released after shutdown queues Goodbye so it cannot tear down the writer while the producer fence drains.
    pub shutdown_complete: CancellationToken,
    pub writer: FrameSender,
    /// The generation's route map only looks up routes; the registry inserts routes at bind and removes them at close.
    pub membership: Mutex<HashMap<u16, u32>>,
    pub pending: Mutex<HashMap<PendingKey, PendingEntry>>,
    /// The `pings` map stores outstanding host-originated Pings by correlation with their flags and send time.
    pub pings: Mutex<HashMap<u64, PingProbe>>,
    /// This bound prevents a client that floods control frames past global capacity from creating unbounded `server_busy` rejection-emission tasks.
    pub busy_rejects: Arc<tokio::sync::Semaphore>,
    pub next_ping_corr: std::sync::atomic::AtomicU64,
    /// The grant path takes the liveness handle to stop and join the liveness loop before publishing a selection.
    pub liveness: Mutex<Option<LivenessHandle>>,
}

///
/// `handshake_permit` releases when authenticated capacity is acquired or the socket closes.
///
/// Holding the permit throughout setup bounds prepared candidates by `max_connections`.
/// `run_connection` owns the bootstrap and candidate cancellation roots.
/// `run_connection` reaps an unpromoted candidate and its I/O task.
/// An explicit or omitted TCP selection continues serving the bootstrap channel.
/// A committed grant retires the bootstrap and serves the promoted candidate.
/// The promoted candidate uses a fresh generation whose application correlations start at 3.
pub async fn run_connection<H: McHostHandler>(
    shared: Arc<HostShared<H>>,
    mut stream: TcpStream,
    handshake_permit: OwnedSemaphorePermit,
) {
    let _ = stream.set_nodelay(true);
    let auth = crate::auth::authenticate_server(
        &mut stream,
        shared.auth_key.bytes(),
        &shared.daemon_id,
        &shared.daemon_ver,
        shared.timing.auth_deadline,
    )
    .await;
    // `role` is unverified reporting metadata.
    // `role` does not affect admission for a valid proof.
    if auth.is_err() {
        return;
    }

    // Authenticated capacity is acquired before the generation is published.
    let Ok(connection_permit) = shared.connection_permits.clone().try_acquire_owned() else {
        return;
    };
    drop(handshake_permit);
    let _connection_permit = connection_permit;

    // Generation tokens are independent roots.
    // When `shutdown` fires, admission stops, but draining keeps the generation live to emit terminals and `Goodbye`.
    // Only `shutdown_sequence` may retire generation tokens.
    // `shutdown_sequence` retires generation tokens in protocol order.
    let gen_token = CancellationToken::new();
    let read_cancel = gen_token.child_token();
    let (read_half, write_half) = stream.into_split();
    let (writer, channel, channel_io) = TcpFrameChannel::start(
        read_half,
        write_half,
        shared.limits.writer_queue_frames,
        shared.timing.frame_deadline,
        shared.ingress_budget.clone(),
        gen_token.clone(),
        read_cancel.clone(),
    );
    let writer_task = AbortOnDropHandle::new(shared.tracker.spawn(channel_io));
    let gen = new_generation(&shared, gen_token, read_cancel, writer);
    let handoff = serve_generation(
        &shared,
        gen,
        channel,
        writer_task,
        ConnectionSetup::bootstrap(),
    )
    .await;

    let Some(handoff) = handoff else {
        return;
    };
    let io_task = handoff.io.lock().expect("candidate io lock").take();
    let promoted = handoff
        .promoted
        .lock()
        .expect("candidate promotion lock")
        .take();
    match promoted {
        Some(receiver) => {
            let io_task =
                AbortOnDropHandle::new(io_task.expect("candidate io is spawned at grant"));
            let gen = new_generation(
                &shared,
                handoff.root.clone(),
                handoff.read_cancel.clone(),
                handoff.sender.clone(),
            );
            serve_generation(
                &shared,
                gen,
                receiver,
                io_task,
                ConnectionSetup::provider_active(),
            )
            .await;
        }
        None => {
            // Reaping the unpromoted candidate in the setup owner guarantees its resource release.
            handoff.sender.discard();
            handoff.root.cancel();
            if let Some(io) = io_task {
                let _ = io.await;
            }
        }
    }
}

fn new_generation<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    token: CancellationToken,
    read_cancel: CancellationToken,
    writer: FrameSender,
) -> Arc<GenerationCore> {
    Arc::new(GenerationCore {
        id: shared.gen_counter.fetch_add(1, Ordering::SeqCst),
        token,
        read_cancel,
        read_tasks: TaskTracker::new(),
        shutdown_complete: CancellationToken::new(),
        writer,
        membership: Mutex::new(HashMap::new()),
        pending: Mutex::new(HashMap::new()),
        pings: Mutex::new(HashMap::new()),
        busy_rejects: Arc::new(tokio::sync::Semaphore::new(MAX_INFLIGHT_BUSY_REJECTS)),
        next_ping_corr: std::sync::atomic::AtomicU64::new(1),
        liveness: Mutex::new(None),
    })
}

/// `serve_generation` returns a candidate handoff only after the finalized channel is torn down.
/// The caller promotes or reaps the candidate after channel teardown.
async fn serve_generation<H: McHostHandler, C: FrameReceiver>(
    shared: &Arc<HostShared<H>>,
    gen: Arc<GenerationCore>,
    channel: C,
    mut io_task: AbortOnDropHandle<()>,
    mut setup: ConnectionSetup,
) -> Option<Arc<CandidateHandoff>> {
    // The writer requires an explicit stop signal after `gen` is dropped.
    // A handler can retain a sender clone through `RequestCtx` after `gen` is dropped.
    let writer_finish = gen.writer.clone();
    // The read loop registers before the generation is published.
    // The read loop's tracker token prevents shutdown from observing an empty producer set.
    // The tracker token covers the interval between generation insertion and the first read-loop poll.
    let read_task = gen
        .read_tasks
        .track_future(read_loop(shared, &gen, channel, &mut setup));
    {
        let mut connections = shared.connections.lock().expect("connections lock");
        // Checking the shutdown token prevents registration after `host.shutdown` commits.
        // `host.shutdown` cancels the token before the shutdown sequence stores `draining`.
        // A socket accepted before `host.shutdown` commits must not register after that commit.
        if shared.draining.load(Ordering::SeqCst) || shared.shutdown.is_cancelled() {
            return None;
        }
        connections.insert(gen.id, Arc::clone(&gen));
    }

    if let Some(policy) = shared.liveness.clone() {
        // `liveness` is a child of `read_cancel`, so retirement still stops the loop;
        // the grant path cancels only `liveness` to stop Pings.
        let stop = gen.read_cancel.child_token();
        let gen_ping = Arc::clone(&gen);
        let task = shared.spawn_tracked(gen.read_tasks.track_future(liveness_loop(
            gen_ping,
            policy,
            stop.clone(),
        )));
        *gen.liveness.lock().expect("liveness lock") = Some(LivenessHandle { stop, task });
    }

    let read_exit = read_task.await;
    gen.read_cancel.cancel();
    match read_exit {
        // the generation continues draining in protocol order.
        // A cancelled `gen.token` indicates retirement rather than draining, so the code falls through to the silent close.
        ReadExit::HostCancelled if !gen.token.is_cancelled() => {}
        // For `PeerKeepQueue`, wait for the promised terminal before retiring.
        ReadExit::PeerKeepQueue(terminal_written) => {
            let _ = terminal_written.await;
            gen.token.cancel();
            gen.writer.discard();
        }
        // Peer-driven retirement closes silently.
        // Cancelling `gen.token` prevents off-reader emissions from succeeding.
        // Discarding `gen.writer` drops queued frames.
        // After a corrupt frame, the client receives no terminal or Goodbye.
        // (protocol §6.3).
        ReadExit::HostCancelled | ReadExit::Peer => {
            gen.token.cancel();
            gen.writer.discard();
        }
    }
    // `begin_close_generation` makes in-flight binds finish through `CloseWins` instead of installing routes on a retiring generation.
    // `read_tasks` keeps `route.open` wrappers alive until shutdown waits for them.
    let begun_closes = shared.registry.begin_close_generation(gen.id);
    gen.read_tasks.close();
    gen.read_tasks.wait().await;
    if shared.draining.load(Ordering::SeqCst) {
        gen.shutdown_complete.cancelled().await;
    }

    close_generation(shared, &gen, begun_closes).await;
    // The candidate driver is the only writer of the promotion slot.
    // `read_tasks.wait()` makes the handoff transfer race-free.
    let handoff = setup.handoff.take();
    drop(gen);
    // `writer_finish.finish()` is required because handler-held sender clones are inert.
    writer_finish.finish();
    // The writer drains queued terminals and Goodbye after the handles drop.
    // The writer enforces `frame_deadline` for each frame.
    // No additional deadline applies to the writer-task join.
    // A stalled peer cannot delay the join beyond the writer's self-retirement.
    let _ = (&mut io_task).await;
    handoff
}

/// Only `HostCancelled` may keep the writer draining.
/// `Peer` retires silently; `PeerKeepQueue` flushes its authoritative early terminal before retirement.
/// `PeerKeepQueue` permits its authoritative early terminal to flush before the writer discards the remaining queue.
/// The early terminal is authoritative for its correlation.
enum ReadExit {
    HostCancelled,
    Peer,
    /// The receiver completes only after the authoritative terminal reaches the socket.
    PeerKeepQueue(tokio::sync::oneshot::Receiver<()>),
}

/// Returning retires the generation.
async fn read_loop<H: McHostHandler, C: FrameReceiver>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    mut channel: C,
    setup: &mut ConnectionSetup,
) -> ReadExit {
    // `read_loop` rejects Requests with correlations less than or equal to `watermark` before dispatch; promoted candidates initialize `watermark` to 2 so application correlations start at 3 (protocol §8.3, V44; §7.7.4).
    let mut watermark: u64 = setup.initial_watermark;
    // `read_loop` retains the most recent rejected-frame terminal's written signal so failed realignment fences that authoritative frame (protocol §7.1).
    let mut reject_written: Option<tokio::sync::oneshot::Receiver<()>> = None;

    loop {
        let event = match channel.recv().await {
            Ok(event) => event,
            Err(ReadClose::Cancelled) => return ReadExit::HostCancelled,
            Err(ReadClose::RejectedDrainFailed) => {
                // `read_loop` preserves the queued early terminal when declared-body drain fails because its correlation remains authoritative (protocol §7.1).
                return match reject_written.take() {
                    Some(terminal_rx) => ReadExit::PeerKeepQueue(terminal_rx),
                    None => ReadExit::Peer,
                };
            }
            Err(ReadClose::CleanEof)
            | Err(ReadClose::Corrupt(_))
            | Err(ReadClose::Io(_))
            | Err(ReadClose::Overloaded) => return ReadExit::Peer,
        };

        match event {
            InboundEvent::Rejected(RejectedFrame { corr }) => {
                // `read_loop` uses `RejectedFrame.corr` because the header provides a trustworthy correlation even when declared-body drain fails (protocol §7.1).
                // `read_loop` emits no-permit rejections off-reader so contended egress cannot block queued Pongs during declared-body drain.
                // be drained.
                if corr <= watermark {
                    return ReadExit::Peer;
                }
                watermark = corr;
                if !transport_ready(setup) {
                    return ReadExit::Peer;
                }
                // `read_loop` retains a written signal so body-drain failure on the next `recv` fences the authoritative terminal (protocol §7.1).
                // `read_loop` acquires `busy_rejects` before spawning so exhausted capacity retires the generation instead of accumulating tasks, oneshots, and captured `Arc`s.
                // `read_loop` uses the per-generation rejection semaphore because rejected frames consume no pending permit.
                let Ok(reject_permit) = gen.busy_rejects.clone().try_acquire_owned() else {
                    gen.token.cancel();
                    gen.writer.discard();
                    return ReadExit::Peer;
                };
                let (terminal_tx, terminal_rx) = tokio::sync::oneshot::channel();
                reject_written = Some(terminal_rx);
                let shared_task = Arc::clone(shared);
                let gen_task = Arc::clone(gen);
                shared.spawn_tracked(gen.read_tasks.track_future(async move {
                    let _reject_permit = reject_permit;
                    crate::dispatch::emit_authoritative_rejection(
                        &shared_task,
                        &gen_task,
                        FrameId::control(corr),
                        CODE_INVALID_CONTROL_REQUEST,
                        "control body exceeds profile cap",
                        terminal_tx,
                    )
                    .await;
                }));
            }
            InboundEvent::Frame(frame) => {
                let header = frame.header;
                match header.ty {
                    FrameType::Request => {
                        if header.corr <= watermark {
                            return ReadExit::Peer;
                        }
                        watermark = header.corr;
                        if header.channel == 0 {
                            let (corr, action) = decode_control_frame(frame, &shared.targets);
                            match handle_control(shared, gen, corr, action, setup).await {
                                ControlFlow::Continue => {}
                                ControlFlow::Close(exit) => return exit,
                            }
                        } else {
                            if header.epoch == 0 {
                                return ReadExit::Peer;
                            }
                            if !transport_ready(setup) {
                                return ReadExit::Peer;
                            }
                            dispatch_request(shared, gen, frame.into_owned()).await;
                        }
                    }
                    FrameType::Cancel => {
                        // Valid frames require the current route and a nonzero correlation (protocol §6.2 table).
                        if header.channel == 0 || header.epoch == 0 || header.corr == 0 {
                            return ReadExit::Peer;
                        }
                        if !transport_ready(setup) {
                            return ReadExit::Peer;
                        }
                        handle_cancel(gen, (header.channel, header.epoch, header.corr));
                    }
                    FrameType::Pong => {
                        if header.channel != 0 || header.corr == 0 {
                            return ReadExit::Peer;
                        }
                        let now = Instant::now();
                        let mut pings = gen.pings.lock().expect("pings lock");
                        match pings.get_mut(&header.corr) {
                            // The `Pong` payload must exactly match the sent `Ping` payload.
                            // The connection retains a matching Pong until the writer confirms that its probe was written.
                            Some(probe) if probe.flags == header.flags.0 => {
                                match probe.written_at {
                                    // After write completion, `sent` is the completion instant.
                                    // The Pong deadline starts at the write-completion instant.
                                    // Scheduler delay does not extend the Pong deadline.
                                    // A Pong received after the deadline leaves the probe for expiry.
                                    Some(_) => {
                                        let in_deadline =
                                            shared.liveness.as_ref().is_none_or(|p| {
                                                now.duration_since(probe.sent) < p.pong_deadline
                                            });
                                        if in_deadline {
                                            pings.remove(&header.corr);
                                        }
                                    }
                                    // Before write completion, `sent` is only the enqueue instant.
                                    // The Pong deadline cannot be evaluated before write completion.
                                    // A Ping queued behind large frames can receive a Pong before it is written.
                                    // A Pong received before write completion must not be rejected as late.
                                    // The write-completion hook evaluates stored Pongs against the completion instant.
                                    // completion instant.
                                    None => probe.answered_at = Some(now),
                                }
                            }
                            _ => {}
                        }
                    }
                    FrameType::Goodbye => {
                        if header.channel == 0 {
                            if header.corr != 0 {
                                return ReadExit::Peer;
                            }
                            // A channel-0 `Goodbye` closes the connection (protocol §9.4).
                            return ReadExit::Peer;
                        }
                        if header.epoch == 0 || header.corr != 0 {
                            return ReadExit::Peer;
                        }
                        if !transport_ready(setup) {
                            return ReadExit::Peer;
                        }
                        // The synchronous Closing transition makes later frames on the route observe `unknown_channel`.
                        // Awaiting the drain here would stall all other connection frames.
                        // Stalling the connection would delay Pong replies.
                        // Missed-Pong invalidation would interpret delayed Pong replies as a dead peer.
                        // dead peer.
                        let handle = crate::handler::RouteHandle {
                            channel: header.channel,
                            epoch: header.epoch,
                        };
                        let decision = shared.registry.begin_close_owned(handle, gen.id);
                        // Duplicate, stale, and mid-bind Goodbyes require no cleanup.
                        // Spawning for duplicate, stale, or mid-bind Goodbyes would allow client-pipelined no-op tasks.
                        // Clients could pipeline unbounded no-op tasks because pure-header frames have zero capacity cost.
                        if matches!(decision, CloseDecision::Owner { .. }) {
                            let shared_task = Arc::clone(shared);
                            shared.spawn_tracked(gen.read_tasks.track_future(async move {
                                crate::dispatch::close_route_decision(
                                    &shared_task,
                                    handle,
                                    decision,
                                )
                                .await;
                            }));
                        }
                    }
                    // Consumer-originated role violations close the generation
                    // `Ping` is host-to-consumer only (protocol §6.2).
                    // A consumer `Ping` closes the generation because handling it requires an implicit host `Pong` extension.
                    FrameType::Response
                    | FrameType::StreamData
                    | FrameType::StreamEnd
                    | FrameType::Error
                    | FrameType::Push
                    | FrameType::Hello
                    | FrameType::HelloAck
                    | FrameType::Ping => return ReadExit::Peer,
                }
            }
        }
    }
}

/// `decode` receives each body as one contiguous byte slice; wrapped ring-buffer bodies are copied first, and decoded values do not escape the lease scope.
fn decode_contiguous<T>(
    frame: &crate::frame_channel::InboundFrame,
    decode: impl FnOnce(&[u8]) -> T,
) -> T {
    let copies = frame.copy_counter();
    frame.with_lease(|lease| match lease.contiguous_bytes() {
        Some(body) => decode(body),
        None => decode(&lease.to_owned(&copies)),
    })
}

fn decode_control_frame(
    frame: crate::frame_channel::InboundFrame,
    targets: &crate::control::TargetIndex,
) -> (u64, ControlAction) {
    let corr = frame.header.corr;
    let binary = frame.header.flags.is_binary();
    let action = decode_contiguous(&frame, |body| parse_control(body, binary, targets));
    (corr, action)
}

async fn handle_control<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    corr: u64,
    action: ControlAction,
    setup: &mut ConnectionSetup,
) -> ControlFlow {
    // Exhausted global capacity must not turn setup negotiation into a `server_busy` terminal.
    // `server_busy` terminal.
    let action = match action {
        ControlAction::TransportNegotiate(decoded) => {
            return handle_negotiate(shared, gen, corr, decoded, setup).await;
        }
        action => action,
    };
    if !matches!(
        setup.state,
        TransportState::TcpCommitted | TransportState::ProviderActive
    ) {
        return ControlFlow::Close(ReadExit::Peer);
    }

    // Every channel-0 request, including semantic rejections, consumes one global unsettled-request permit.
    // At capacity, the no-dispatch `server_busy` terminal takes precedence over semantic errors (protocol §8.3).
    //
    // Reserved `route.open` uses the reserved pool so it remains possible when the general pool is full.
    let pending_pool = match &action {
        ControlAction::RouteOpen { target, .. }
            if shared.targets.class_of(&target.module_id)
                == Some(crate::handler::RouteClass::Reserved) =>
        {
            &shared.reserved_pending_permits
        }
        _ => &shared.pending_permits,
    };
    let Ok(pending_permit) = pending_pool.clone().try_acquire_owned() else {
        crate::dispatch::emit_rejection(
            shared,
            gen,
            FrameId::control(corr),
            crate::control::CODE_SERVER_BUSY,
            "pending request capacity exhausted",
        )
        .await;
        return ControlFlow::Continue;
    };

    match action {
        ControlAction::Reject { code, message } => {
            // The read loop queues emission because egress-budget acquisition can block.
            // The acquired permit bounds queued emissions.
            let shared_task = Arc::clone(shared);
            let gen_task = Arc::clone(gen);
            shared.spawn_tracked(gen.read_tasks.track_future(async move {
                let _pending_permit = pending_permit;
                emit_error_terminal(
                    &shared_task.egress_budget,
                    &gen_task,
                    FrameId::control(corr),
                    code,
                    &message,
                )
                .await;
            }));
        }
        ControlAction::CatalogList { module_id_filter } => {
            // The read loop queues the catalog response because egress-budget acquisition can block.
            let shared_task = Arc::clone(shared);
            let gen_task = Arc::clone(gen);
            shared.spawn_tracked(gen.read_tasks.track_future(async move {
                let _pending_permit = pending_permit;
                let body = shared_task.catalog.body(module_id_filter.as_deref());
                if emit_catalog_response(
                    &shared_task.egress_budget,
                    &gen_task,
                    FrameId::control(corr),
                    body,
                )
                .await
                .is_err()
                {
                    gen_task.token.cancel();
                }
            }));
        }
        ControlAction::HostShutdown => {
            let shared_task = Arc::clone(shared);
            let gen_task = Arc::clone(gen);
            shared.spawn_tracked(gen.read_tasks.track_future(async move {
                let _pending_permit = pending_permit;
                crate::dispatch::handle_host_shutdown(&shared_task, &gen_task, corr).await;
            }));
        }
        ControlAction::HostStatus => {
            let shared_task = Arc::clone(shared);
            let gen_task = Arc::clone(gen);
            shared.spawn_tracked(gen.read_tasks.track_future(async move {
                let _pending_permit = pending_permit;
                let report = shared_task
                    .health_snapshot
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone();
                let body = crate::control::host_status_response_json(&report);
                if emit_catalog_response(
                    &shared_task.egress_budget,
                    &gen_task,
                    FrameId::control(corr),
                    &body,
                )
                .await
                .is_err()
                {
                    gen_task.token.cancel();
                }
            }));
        }
        ControlAction::RouteOpen { target, identity } => {
            // The read loop must not wait for bind callbacks because they may be slow.
            // The wrapper must be abort-exempt because it owns its route's cleanup.
            // Rejected or close-raced binds must emit `route-gone` exactly once.
            // self-bounded.
            let shared_task = Arc::clone(shared);
            let gen_task = Arc::clone(gen);
            shared.spawn_lifecycle(gen.read_tasks.track_future(async move {
                let _pending_permit = pending_permit;
                open_route(shared_task, gen_task, corr, target, identity).await;
            }));
        }
        ControlAction::TransportNegotiate(_) => {
            unreachable!("negotiation is intercepted before control admission")
        }
    }
    ControlFlow::Continue
}

enum ControlFlow {
    Continue,
    Close(ReadExit),
}

/// `ConnectionSetup` stores transport-setup state for one served channel (protocol §7.7.5).
/// `Retired` has no variant: it is the read loop returning a [`ReadExit`].
/// `CandidatePrepared`, `Activating`, and `AwaitingCommit` occur in that order in `run_candidate_setup`.
/// [`TransportState::CandidateSetup`].
enum TransportState {
    BootstrapTcp,
    TcpCommitted,
    /// requests.
    CandidateSetup,
    /// `ProviderActive` serves a promoted candidate; selection remains sticky until retirement.
    ProviderActive,
}

pub(crate) struct ConnectionSetup {
    state: TransportState,
    initial_watermark: u64,
    handoff: Option<Arc<CandidateHandoff>>,
}

impl ConnectionSetup {
    fn bootstrap() -> Self {
        Self {
            state: TransportState::BootstrapTcp,
            initial_watermark: 0,
            handoff: None,
        }
    }

    /// The first application request on a promoted candidate has sequence number 3 (§7.7.4).
    fn provider_active() -> Self {
        Self {
            state: TransportState::ProviderActive,
            initial_watermark: COMMIT_CORRELATION,
            handoff: None,
        }
    }
}

/// The sender and cancellation token share one prepared-candidate handle.
/// Both the driver and setup owner can reach the cancellation roots.
/// The driver fills `promoted` after the commit response completes locally.
pub(crate) struct CandidateHandoff {
    sender: FrameSender,
    root: CancellationToken,
    read_cancel: CancellationToken,
    promoted: Mutex<Option<BoxedReceiver>>,
    io: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

fn transport_ready(setup: &ConnectionSetup) -> bool {
    matches!(
        setup.state,
        TransportState::TcpCommitted | TransportState::ProviderActive
    )
}

async fn handle_negotiate<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    corr: u64,
    decoded: Result<NegotiateRequest, NegotiationError>,
    setup: &mut ConnectionSetup,
) -> ControlFlow {
    if !matches!(setup.state, TransportState::BootstrapTcp) {
        return ControlFlow::Close(ReadExit::Peer);
    }
    let request = match decoded {
        Ok(request) => request,
        Err(_) => {
            // `handle_negotiate` sends the terminal response before retiring the generation.
            // `ReadExit::PeerKeepQueue` waits for the authoritative rejection to enter the egress queue before closing.
            // The malformed-negotiation path stops liveness before waiting for terminal egress.
            // A missed Pong during terminal egress would invalidate the closing generation.
            // Terminal egress waits only for the bounded egress budget.
            // Generation cancellation would abort the required terminal response.
            // requires.
            let liveness = gen.liveness.lock().expect("liveness lock").take();
            if let Some(handle) = liveness {
                handle.stop.cancel();
                let _ = handle.task.await;
            }
            let (terminal_tx, terminal_rx) = tokio::sync::oneshot::channel();
            crate::dispatch::emit_authoritative_rejection(
                shared,
                gen,
                FrameId::control(corr),
                CODE_INVALID_CONTROL_REQUEST,
                "malformed transport negotiation",
                terminal_tx,
            )
            .await;
            return ControlFlow::Close(ReadExit::PeerKeepQueue(terminal_rx));
        }
    };
    if !request.offers.iter().any(|offer| {
        offer.transport == TRANSPORT_TCP && offer.capability_version == TCP_CAPABILITY_VERSION
    }) {
        return ControlFlow::Close(ReadExit::Peer);
    }
    if request.negotiation_version != NEGOTIATION_VERSION {
        return ControlFlow::Close(ReadExit::Peer);
    }
    // The first serveable offer in client preference order wins.
    let mut capability_mismatch = false;
    let mut dynamically_unavailable = false;
    for offer in &request.offers {
        if offer.transport == TRANSPORT_TCP {
            if offer.capability_version == TCP_CAPABILITY_VERSION {
                break;
            }
            continue;
        }
        // Lookup must include `capability_version` so a mismatched sibling cannot hide a serveable provider.
        match shared
            .providers
            .find(&offer.transport, offer.capability_version)
        {
            Some(provider) => {
                // `preflight` panics are treated as `StaticallyOmitted`.
                let eligibility = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    crate::panic_boundary::redact_sync(|| {
                        provider.preflight(offer.parameters.as_ref())
                    })
                }))
                .unwrap_or(PreflightEligibility::StaticallyOmitted);
                match eligibility {
                    PreflightEligibility::Serveable => {
                        let provider = Arc::clone(provider);
                        let selected = SelectedTransport {
                            transport: offer.transport.clone(),
                            capability_version: offer.capability_version,
                        };
                        return grant_candidate(
                            shared,
                            gen,
                            corr,
                            selected,
                            provider,
                            offer.parameters.clone(),
                            setup,
                        )
                        .await;
                    }
                    PreflightEligibility::DynamicallyUnavailable => {
                        dynamically_unavailable = true;
                    }
                    PreflightEligibility::StaticallyOmitted => {}
                }
            }
            // `capability_version_mismatch` reports a known transport offered at an unsupported version.
            None if shared.providers.serves_transport(&offer.transport) => {
                capability_mismatch = true;
            }
            None => {}
        }
    }
    // `unavailable` takes precedence over `capability_version_mismatch` among evaluated offers.
    let reason = if dynamically_unavailable {
        Some(FallbackReason::Unavailable)
    } else if capability_mismatch {
        Some(FallbackReason::CapabilityVersionMismatch)
    } else {
        None
    };
    setup.state = TransportState::TcpCommitted;
    respond_tcp(shared, gen, corr, request.negotiation_version, reason).await
}

async fn respond_tcp<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    corr: u64,
    negotiation_version: u32,
    reason: Option<FallbackReason>,
) -> ControlFlow {
    let body = encode_negotiate_response(
        &NegotiateResponse::Tcp { reason },
        negotiation_version,
        TCP_CAPABILITY_VERSION,
    )
    .expect("a tcp selection always encodes");
    let shared_task = Arc::clone(shared);
    let gen_task = Arc::clone(gen);
    shared.spawn_tracked(gen.read_tasks.track_future(async move {
        if emit_frame(
            &shared_task.egress_budget,
            &gen_task,
            FrameType::Response,
            response_flags(false, true),
            FrameId::control(corr),
            body,
        )
        .await
        .is_err()
        {
            gen_task.token.cancel();
        }
    }));
    ControlFlow::Continue
}

async fn grant_candidate<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    corr: u64,
    selected: SelectedTransport,
    provider: Arc<dyn InjectedProvider>,
    offer_parameters: Option<serde_json::Value>,
    setup: &mut ConnectionSetup,
) -> ControlFlow {
    let ctx = ProviderContext::new(
        shared.ingress_budget.clone(),
        shared.limits.writer_queue_frames,
        shared.timing.frame_deadline,
        offer_parameters,
    );
    let deadline = Instant::now() + shared.timing.transport_setup_deadline;
    // again.
    let liveness = gen.liveness.lock().expect("liveness lock").take();
    if let Some(handle) = liveness {
        handle.stop.cancel();
        let _ = handle.task.await;
    }
    let reply = shared.providers.prepare_on_worker(provider, ctx);
    // TCP continuation.
    let PreparedCandidate {
        descriptor,
        candidate_id,
        candidate,
    } = match timeout_at(deadline, reply).await {
        Ok(Ok(Ok(prepared))) => prepared,
        _ => return ControlFlow::Close(ReadExit::Peer),
    };
    let token = fresh_activation_token();
    let binding = GrantBinding {
        daemon_id: shared.daemon_id,
        bootstrap_generation: gen.id,
        negotiation_correlation: corr,
        transport: selected.transport.clone(),
        capability_version: selected.capability_version,
        candidate_id,
    };
    let grant = GrantRecord::new(binding.clone(), token.clone());
    let body = match encode_negotiate_response(
        &NegotiateResponse::Grant {
            selected,
            activation_token: token,
            descriptor,
        },
        NEGOTIATION_VERSION,
        TCP_CAPABILITY_VERSION,
    ) {
        Ok(body) => body,
        // resources.
        Err(_) => return ControlFlow::Close(ReadExit::Peer),
    };
    let Candidate {
        sender,
        receiver,
        io,
        root,
        read_cancel,
    } = candidate;
    let io_task = shared.spawn_tracked(io);
    let handoff = Arc::new(CandidateHandoff {
        sender,
        root,
        read_cancel,
        promoted: Mutex::new(None),
        io: Mutex::new(Some(io_task)),
    });
    let shared_task = Arc::clone(shared);
    let gen_task = Arc::clone(gen);
    let handoff_task = Arc::clone(&handoff);
    shared.spawn_tracked(gen.read_tasks.track_future(run_candidate_setup(
        shared_task,
        gen_task,
        handoff_task,
        receiver,
        grant,
        binding,
        deadline,
    )));
    setup.state = TransportState::CandidateSetup;
    setup.handoff = Some(handoff);
    // candidate.
    if emit_frame(
        &shared.egress_budget,
        gen,
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
    ControlFlow::Continue
}

async fn run_candidate_setup<H: McHostHandler>(
    shared: Arc<HostShared<H>>,
    bootstrap: Arc<GenerationCore>,
    handoff: Arc<CandidateHandoff>,
    mut receiver: BoxedReceiver,
    grant: GrantRecord,
    binding: GrantBinding,
    deadline: Instant,
) {
    let exchange = async {
        let frame = expect_candidate_request(&mut receiver, ACTIVATION_CORRELATION).await?;
        let request = decode_candidate_activate(frame)?;
        grant
            .consume(&request.activation_token, &binding)
            .map_err(|_| ())?;
        send_candidate_response(
            &shared,
            &handoff,
            ACTIVATION_CORRELATION,
            activate_response_json(),
            None,
        )
        .await?;

        let frame = expect_candidate_request(&mut receiver, COMMIT_CORRELATION).await?;
        decode_candidate_commit(frame)?;
        let (written_tx, written_rx) = tokio::sync::oneshot::channel();
        send_candidate_response(
            &shared,
            &handoff,
            COMMIT_CORRELATION,
            commit_response_json(),
            Some(written_tx),
        )
        .await?;
        written_rx.await.map_err(|_| ())
    };
    let outcome = tokio::select! {
        biased;
        outcome = timeout_at(deadline, exchange) => outcome.unwrap_or(Err(())),
        () = bootstrap.read_cancel.cancelled() => Err(()),
    };
    match outcome {
        Ok(()) => {
            *handoff.promoted.lock().expect("candidate promotion lock") = Some(receiver);
            // candidate.
            bootstrap.token.cancel();
            bootstrap.writer.discard();
        }
        Err(()) => {
            handoff.sender.discard();
            handoff.root.cancel();
            bootstrap.token.cancel();
            bootstrap.writer.discard();
        }
    }
}

fn decode_candidate_activate(
    frame: crate::frame_channel::InboundFrame,
) -> Result<crate::transport_negotiation::ActivateRequest, ()> {
    decode_contiguous(&frame, decode_activate_request).map_err(|_| ())
}

fn decode_candidate_commit(frame: crate::frame_channel::InboundFrame) -> Result<(), ()> {
    decode_contiguous(&frame, decode_commit_request).map_err(|_| ())
}

async fn expect_candidate_request(
    receiver: &mut BoxedReceiver,
    corr: u64,
) -> Result<crate::frame_channel::InboundFrame, ()> {
    match receiver.recv().await {
        Ok(InboundEvent::Frame(frame))
            if frame.header.ty == FrameType::Request
                && frame.header.channel == 0
                && frame.header.epoch == 0
                && frame.header.corr == corr
                && !frame.header.flags.is_binary() =>
        {
            Ok(frame)
        }
        _ => Err(()),
    }
}

async fn send_candidate_response<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    handoff: &CandidateHandoff,
    corr: u64,
    body: Vec<u8>,
    written_tx: Option<tokio::sync::oneshot::Sender<()>>,
) -> Result<(), ()> {
    let deadline = handoff.sender.admission_deadline();
    let frame_bytes = u32::try_from(body.len() + HEADER_LEN).map_err(|_| ())?;
    let charge = tokio::select! {
        biased;
        () = handoff.root.cancelled() => return Err(()),
        charge = timeout_at(deadline, shared.egress_budget.charge(frame_bytes)) => {
            charge.map_err(|_| ())?
        }
    };
    let bytes = encode_owned_frame(
        FrameType::Response,
        response_flags(false, true),
        FrameId::control(corr),
        body,
    )
    .map_err(|_| ())?;
    handoff
        .sender
        .send_before(
            OutboundFrame {
                bytes,
                tail: Vec::new(),
                direct: None,
                charge,
                written: written_tx.map(|tx| {
                    Box::new(move |_completed_at: Instant| {
                        let _ = tx.send(());
                    }) as Box<dyn FnOnce(Instant) + Send>
                }),
            },
            deadline,
        )
        .await
        .map_err(|_| ())
}

async fn emit_catalog_response(
    budget: &crate::wire::ByteBudget,
    gen: &GenerationCore,
    id: FrameId,
    body: &[u8],
) -> Result<(), ()> {
    if body.len() > crate::wire::MAX_BODY_LEN as usize
        || gen.writer.is_retired()
        || gen.token.is_cancelled()
    {
        return Err(());
    }
    let deadline = gen.writer.admission_deadline();
    let frame = reserve_catalog_frame(budget, gen, deadline, id, body).await?;
    gen.writer
        .send_before(frame, deadline)
        .await
        .map_err(|_| ())
}

async fn reserve_catalog_frame(
    budget: &crate::wire::ByteBudget,
    gen: &GenerationCore,
    deadline: Instant,
    id: FrameId,
    body: &[u8],
) -> Result<OutboundFrame, ()> {
    let frame_bytes = body.len().checked_add(HEADER_LEN).ok_or(())?;
    let charged_bytes = u32::try_from(frame_bytes).map_err(|_| ())?;
    let charge = tokio::select! {
        biased;
        () = gen.token.cancelled() => return Err(()),
        charge = timeout_at(deadline, budget.charge(charged_bytes)) => match charge {
            Ok(charge) => charge,
            Err(_) => {
                gen.token.cancel();
                return Err(());
            }
        },
    };
    if gen.token.is_cancelled() {
        return Err(());
    }

    let mut owned_body = Vec::with_capacity(frame_bytes);
    owned_body.extend_from_slice(body);
    let bytes = encode_owned_frame(
        FrameType::Response,
        crate::wire::response_flags(false, true),
        id,
        owned_body,
    )
    .map_err(|_| ())?;
    Ok(OutboundFrame {
        bytes,
        tail: Vec::new(),
        direct: None,
        charge,
        written: None,
    })
}

async fn liveness_loop(
    gen: Arc<GenerationCore>,
    policy: crate::config::LivenessPolicy,
    stop: CancellationToken,
) {
    let mut next_ping_at = Instant::now() + policy.ping_interval;
    loop {
        // The loop wakes at the earlier of the next Ping tick and the earliest outstanding Pong deadline to avoid delaying the next Ping after an answered Pong.
        let wake_at = {
            let pings = gen.pings.lock().expect("pings lock");
            pings
                .values()
                .filter(|probe| probe.written_at.is_some())
                .map(|probe| probe.sent + policy.pong_deadline)
                .min()
                .map_or(next_ping_at, |deadline| deadline.min(next_ping_at))
        };
        tokio::select! {
            () = stop.cancelled() => return,
            () = tokio::time::sleep_until(wake_at) => {}
        }
        let now = Instant::now();
        let expired = {
            let pings = gen.pings.lock().expect("pings lock");
            pings.values().any(|probe| {
                probe.written_at.is_some() && now.duration_since(probe.sent) >= policy.pong_deadline
            })
        };
        if expired && policy.invalidate_on_missed {
            gen.token.cancel();
            return;
        }
        {
            let mut pings = gen.pings.lock().expect("pings lock");
            if expired {
                pings.clear();
            } else if !pings.is_empty() {
                // When a Ping is unexpired, the loop adds no Ping and advances `next_ping_at`; otherwise a past tick would spin until the Pong arrives or its deadline expires.
                next_ping_at = now + policy.ping_interval;
                continue;
            }
        }
        if now < next_ping_at {
            // After an on-time Pong wakes the loop at its former deadline, the next Ping waits for `next_ping_at`.
            continue;
        }
        next_ping_at = now + policy.ping_interval;
        let corr = gen.next_ping_corr.fetch_add(1, Ordering::SeqCst);
        let flags = pure_header_flags();
        // `gen.pings` must contain the correlation before the Ping reaches the wire; otherwise the read loop drops a fast Pong as unmatched.
        gen.pings.lock().expect("pings lock").insert(
            corr,
            PingProbe {
                flags: flags.0,
                sent: Instant::now(),
                written_at: None,
                answered_at: None,
            },
        );
        let bytes = crate::wire::encode_owned_frame(
            FrameType::Ping,
            flags,
            crate::wire::FrameId::control(corr),
            Vec::new(),
        )
        .expect("header-only Ping always encodes");
        let (written_tx, written_rx) = tokio::sync::oneshot::channel();
        // The hook runs in the writer task at write completion, so the probe is answerable when the Ping can reach the peer.
        // An async notification could let a Pong arrive before the hook records completion.
        let gen_probe = Arc::clone(&gen);
        let pong_deadline = policy.pong_deadline;
        let written_hook = Box::new(move |completed_at: Instant| {
            let mut pings = gen_probe.pings.lock().expect("pings lock");
            if let Some(probe) = pings.get_mut(&corr) {
                match probe.answered_at {
                    Some(answered_at)
                        if answered_at >= completed_at
                            && answered_at.duration_since(completed_at) < pong_deadline =>
                    {
                        pings.remove(&corr);
                    }
                    _ => {
                        probe.answered_at = None;
                        probe.sent = completed_at;
                        probe.written_at = Some(completed_at);
                    }
                }
            }
            let _ = written_tx.send(());
        });
        let send = gen.writer.send(crate::frame_channel::OutboundFrame {
            bytes,
            tail: Vec::new(),
            direct: None,
            charge: crate::wire::ByteCharge::none(),
            written: Some(written_hook),
        });
        let sent = tokio::select! {
            biased;
            () = stop.cancelled() => return,
            sent = send => sent,
        };
        if sent.is_err() {
            return;
        }
        // The writer hook anchors expiry; waiting on `written_rx` only paces the loop.
        tokio::select! {
            () = stop.cancelled() => return,
            written = written_rx => {
                if written.is_err() {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, DuplexStream};

    use crate::wire::decode_header;

    #[derive(Clone, Copy)]
    enum FencedProducer {
        Catalog,
        CapacityRejection,
    }

    async fn read_frame_from(stream: &mut DuplexStream) -> crate::wire::EnvelopeHeader {
        let mut header_bytes = [0; HEADER_LEN];
        stream
            .read_exact(&mut header_bytes)
            .await
            .expect("frame header");
        let header = decode_header(&header_bytes).expect("valid frame header");
        let mut body = vec![0; header.len as usize];
        stream.read_exact(&mut body).await.expect("frame body");
        header
    }

    async fn assert_started_producer_precedes_goodbye(producer: FencedProducer) {
        let generation = CancellationToken::new();
        let read_cancel = generation.child_token();
        let (server, mut client) = tokio::io::duplex(4096);
        let (writer, writer_task) = crate::tcp_frame_channel::spawn_writer(
            server,
            4,
            generation.clone(),
            Duration::from_secs(1),
        );
        let gen = Arc::new(GenerationCore {
            id: 1,
            token: generation,
            read_cancel,
            read_tasks: TaskTracker::new(),
            shutdown_complete: CancellationToken::new(),
            writer,
            membership: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            pings: Mutex::new(HashMap::new()),
            busy_rejects: Arc::new(tokio::sync::Semaphore::new(MAX_INFLIGHT_BUSY_REJECTS)),
            next_ping_corr: std::sync::atomic::AtomicU64::new(1),
            liveness: Mutex::new(None),
        });
        let budget = crate::wire::ByteBudget::new(4096);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let producer_gen = Arc::clone(&gen);
        let producer_budget = budget.clone();
        let task = tokio::spawn(gen.read_tasks.track_future(async move {
            let _ = started_tx.send(());
            let _ = release_rx.await;
            match producer {
                FencedProducer::Catalog => {
                    emit_catalog_response(
                        &producer_budget,
                        &producer_gen,
                        FrameId::control(7),
                        br#"{"op":"catalog.list","modules":[]}"#,
                    )
                    .await
                    .expect("catalog queued");
                }
                FencedProducer::CapacityRejection => {
                    crate::dispatch::emit_error_terminal(
                        &producer_budget,
                        &producer_gen,
                        FrameId::control(7),
                        crate::control::CODE_SERVER_BUSY,
                        "pending request capacity exhausted",
                    )
                    .await;
                }
            }
        }));
        started_rx.await.expect("producer started");

        gen.read_cancel.cancel();
        gen.read_tasks.close();
        let tracker = gen.read_tasks.clone();
        let (wait_started_tx, wait_started_rx) = tokio::sync::oneshot::channel();
        let fence = tokio::spawn(async move {
            let _ = wait_started_tx.send(());
            tracker.wait().await;
        });
        wait_started_rx.await.expect("fence started");
        tokio::task::yield_now().await;
        assert!(
            !fence.is_finished(),
            "shutdown must wait for an already-started producer"
        );

        release_tx.send(()).expect("release producer");
        fence.await.expect("producer fence");
        task.await.expect("producer task");
        crate::dispatch::send_connection_goodbye(&gen).await;

        let terminal = read_frame_from(&mut client).await;
        assert_eq!(terminal.corr, 7);
        assert!(matches!(
            terminal.ty,
            FrameType::Response | FrameType::Error
        ));
        let goodbye = read_frame_from(&mut client).await;
        assert_eq!(goodbye.ty, FrameType::Goodbye);
        assert_eq!((goodbye.channel, goodbye.epoch, goodbye.corr), (0, 0, 0));

        drop(gen);
        drop(client);
        writer_task.await.expect("writer task");
    }

    #[tokio::test]
    async fn shutdown_fence_queues_started_catalog_before_goodbye() {
        assert_started_producer_precedes_goodbye(FencedProducer::Catalog).await;
    }

    #[tokio::test]
    async fn shutdown_fence_queues_started_capacity_rejection_before_goodbye() {
        assert_started_producer_precedes_goodbye(FencedProducer::CapacityRejection).await;
    }

    #[tokio::test]
    async fn cached_catalog_clone_holds_one_full_frame_charge() {
        let body = br#"{"op":"catalog.list","modules":[]}"#;
        let frame_bytes = HEADER_LEN + body.len();
        let budget = crate::wire::ByteBudget::new(frame_bytes as u64);
        let generation = CancellationToken::new();
        let (server, client) = tokio::io::duplex(64);
        let (writer, writer_task) = crate::tcp_frame_channel::spawn_writer(
            server,
            1,
            generation.clone(),
            Duration::from_secs(1),
        );
        let gen = GenerationCore {
            id: 1,
            token: generation,
            read_cancel: CancellationToken::new(),
            read_tasks: TaskTracker::new(),
            shutdown_complete: CancellationToken::new(),
            writer,
            membership: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            pings: Mutex::new(HashMap::new()),
            busy_rejects: Arc::new(tokio::sync::Semaphore::new(MAX_INFLIGHT_BUSY_REJECTS)),
            next_ping_corr: std::sync::atomic::AtomicU64::new(1),
            liveness: Mutex::new(None),
        };

        let frame = reserve_catalog_frame(
            &budget,
            &gen,
            Instant::now() + Duration::from_secs(1),
            FrameId::control(7),
            body,
        )
        .await
        .expect("catalog frame reservation");

        assert_eq!(budget.available(), 0);
        assert_eq!(&frame.bytes[HEADER_LEN..], body);
        drop(frame);
        assert_eq!(budget.available(), frame_bytes);

        drop(gen);
        drop(client);
        writer_task.await.expect("writer task");
    }
}
