//! This module runs one authenticated connection generation.
//!
//! Each generation owns its correlation watermark, membership lookups, pending correlation index, ping namespace, and writer; the global registry owns route cleanup.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use crate::wire::{FrameType, HEADER_LEN};
use tokio::net::UnixStream;
use tokio::sync::OwnedSemaphorePermit;
use tokio::time::{timeout_at, Instant};
use tokio_util::sync::CancellationToken;
use tokio_util::task::{AbortOnDropHandle, TaskTracker};

use crate::control::{parse_control, ControlAction, CODE_INVALID_CONTROL_REQUEST};
use crate::dispatch::{
    close_generation, dispatch_request, emit_error_terminal, handle_cancel, open_route,
};
use crate::frame_channel::{FrameSender, InboundEvent, OutboundFrame, ReadClose, RejectedFrame};
use crate::handler::McHostHandler;
use crate::ring_transport::{PreparedRing, ShmReceiver};
use crate::routing::CloseDecision;
use crate::runtime::HostShared;
use crate::wire::{encode_owned_frame, pure_header_flags, FrameId};

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

/// Generation-owned state shared with the registry and dispatch tasks.
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
}

/// Runs one accepted setup socket to completion: authenticate, transfer the
/// fixed ring descriptors, commit activation, then retain the socket only as
/// peer-lifetime evidence while application frames use the ring.
///
/// `handshake_permit` releases when authenticated capacity is acquired or the socket closes.
///
/// This task owns the setup socket and ring candidate together. Any setup
/// failure or unexpected socket closure retires that exact ring generation.
pub async fn run_connection<H: McHostHandler>(
    shared: Arc<HostShared<H>>,
    mut stream: UnixStream,
    handshake_permit: OwnedSemaphorePermit,
) {
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

    let ring = Arc::clone(&shared.ring);
    let ingress = shared.ingress_budget.clone();
    let queue_frames = shared.limits.writer_queue_frames;
    let frame_deadline = shared.timing.frame_deadline;
    let mut prepared =
        tokio::task::spawn_blocking(move || ring.prepare(ingress, queue_frames, frame_deadline));
    // A timed-out `prepare` continues because `spawn_blocking` cannot abort it.
    // A dropped `CancellationToken` does not cancel `root`; late completion
    // discards `sender` and cancels `root`.
    let prepared = match timeout_at(
        Instant::now() + shared.timing.transport_setup_deadline,
        &mut prepared,
    )
    .await
    {
        Ok(joined) => joined,
        Err(_) => {
            shared.spawn_tracked(async move {
                if let Ok(Ok(late)) = prepared.await {
                    late.sender.discard();
                    late.root.cancel();
                }
            });
            return;
        }
    };
    let Ok(Ok(PreparedRing {
        descriptor,
        descriptors,
        sender,
        receiver,
        io,
        root,
        read_cancel,
    })) = prepared
    else {
        return;
    };
    let Ok(token) = activation_token() else {
        sender.discard();
        root.cancel();
        return;
    };
    if crate::setup_socket::activate_server(
        &mut stream,
        &descriptors,
        &descriptor,
        crate::wire::PROTOCOL_VERSION,
        mc_shm_transport::descriptor::DESCRIPTOR_SCHEMA_VERSION,
        token.as_str(),
        shared.timing.transport_setup_deadline,
    )
    .await
    .is_err()
    {
        sender.discard();
        root.cancel();
        return;
    }
    drop(descriptors);
    shared.ring.record_activation();

    let io_task = AbortOnDropHandle::new(shared.tracker.spawn(io));
    let gen = new_generation(&shared, root.clone(), read_cancel.clone(), sender);
    let peer_gen = Arc::clone(&gen);
    let peer_read_cancel = read_cancel.clone();
    let peer_ring = Arc::clone(&shared.ring);
    shared.spawn_tracked(gen.read_tasks.track_future(async move {
        tokio::select! {
            biased;
            () = peer_read_cancel.cancelled() => {}
            close = crate::setup_socket::observe_peer(&mut stream) => {
                if close != crate::setup_socket::PeerClose::Goodbye {
                    peer_ring.record_peer_death();
                }
                peer_gen.token.cancel();
                peer_gen.read_cancel.cancel();
            }
        }
    }));
    serve_generation(&shared, gen, receiver, io_task).await;
    shared.ring.record_reclamation();
}

fn activation_token() -> Result<String, ()> {
    activation_token_with(|bytes| getrandom::getrandom(bytes).map_err(|_| ()))
}

fn activation_token_with(fill: impl FnOnce(&mut [u8; 32]) -> Result<(), ()>) -> Result<String, ()> {
    let mut bytes = [0u8; 32];
    fill(&mut bytes)?;
    Ok(bytes
        .iter()
        .fold(String::with_capacity(64), |mut text, byte| {
            use std::fmt::Write;
            let _ = write!(text, "{byte:02x}");
            text
        }))
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
    })
}

/// Serves one finalized frame channel to retirement: register, read, drain,
/// close. Returns the candidate handoff if the read loop granted one, so the
/// caller can promote or reap it after this channel is fully torn down.
async fn serve_generation<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: Arc<GenerationCore>,
    channel: ShmReceiver,
    mut io_task: AbortOnDropHandle<()>,
) {
    // Retained past `gen`: the writer must be told to stop even when a
    // handler still holds a sender clone through a retained RequestCtx.
    let writer_finish = gen.writer.clone();
    // The read loop registers before the generation is published.
    // The read loop's tracker token prevents shutdown from observing an empty producer set.
    // The tracker token covers the interval between generation insertion and the first read-loop poll.
    let read_task = gen
        .read_tasks
        .track_future(read_loop(shared, &gen, channel));
    {
        let mut connections = shared.connections.lock().expect("connections lock");
        // Checking the shutdown token prevents registration after `host.shutdown` commits.
        // `host.shutdown` cancels the token before the shutdown sequence stores `draining`.
        // A socket accepted before `host.shutdown` commits must not register after that commit.
        if shared.draining.load(Ordering::SeqCst) || shared.shutdown.is_cancelled() {
            discard_unregistered_generation(&gen);
            return;
        }
        connections.insert(gen.id, Arc::clone(&gen));
    }
    if let Some(policy) = shared.liveness.clone() {
        // `liveness` is a child of `read_cancel`, so retirement still stops the loop;
        // the grant path cancels only `liveness` to stop Pings.
        let stop = gen.read_cancel.child_token();
        let gen_ping = Arc::clone(&gen);
        shared.spawn_tracked(gen.read_tasks.track_future(liveness_loop(
            gen_ping,
            policy,
            stop.clone(),
        )));
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
    // The candidate driver (tracked in `read_tasks`, so already joined) is
    // the only writer of the promotion slot; taking the handoff after the
    // wait is what makes the transfer race-free.
    drop(gen);
    // `writer_finish.finish()` is required because handler-held sender clones are inert.
    writer_finish.finish();
    // The writer drains queued terminals and Goodbye after the handles drop.
    // The writer enforces `frame_deadline` for each frame.
    // No additional deadline applies to the writer-task join.
    // A stalled peer cannot delay the join beyond the writer's self-retirement.
    let _ = (&mut io_task).await;
}

fn discard_unregistered_generation(gen: &GenerationCore) {
    gen.read_cancel.cancel();
    gen.token.cancel();
    gen.writer.discard();
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

/// Serves validated frames until close. Returning retires the generation.
async fn read_loop<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    mut channel: ShmReceiver,
) -> ReadExit {
    // Highest consumer Request correlation seen; any non-increasing Request
    // closes the generation before dispatch (protocol §8.3, V44). A promoted
    // candidate starts at 2 so application correlations begin at 3 (§7.7.4).
    let mut watermark: u64 = 0;
    // Written-signal of the most recent rejected-frame terminal: if the
    // transport's realignment then fails, the close fences exactly that
    // authoritative frame (protocol §7.1).
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
                // Off-reader like the other rejections (contended egress
                // must not block this reader from a queued Pong), but with a
                // written-signal: if the transport's body drain on the next
                // `recv` fails, the close fences exactly this authoritative
                // frame (protocol §7.1). Rejected frames consume no pending
                // permit, so the per-generation rejection semaphore is what
                // bounds these emissions. Acquired BEFORE spawning: past the
                // bound a peer streaming oversize bodies would otherwise
                // accumulate tasks, oneshots, and captured Arcs, so
                // exhaustion retires instead.
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
                            handle_control(shared, gen, corr, action).await;
                        } else {
                            if header.epoch == 0 {
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
                        // The Closing transition is synchronous, so any later
                        // frame on this route observes `unknown_channel`; the
                        // drain and route-gone callback run on a tracked task
                        // because awaiting them here would stall every other
                        // frame on this connection — including Pong replies,
                        // which missed-Pong invalidation would misread as a
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

/// Runs `decode` over the frame's body as one contiguous byte slice. A body
/// that wraps the ring arena end flattens through the explicit copying adapter
/// first. Only decoded values leave the lease scope.
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
) {
    // Every channel-0 request — including semantic rejections — is one
    // consumer request against the global unsettled bound; at capacity the
    // no-dispatch `server_busy` terminal takes precedence over the semantic
    // error (protocol §8.3).
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
        return;
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
                let body = crate::control::host_status_response_json(
                    &report,
                    shared_task.ring.diagnostics(),
                );
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
    }
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
    use crate::frame_channel::frame_sender;
    use std::time::Duration;

    #[test]
    fn activation_entropy_failure_is_redacted_without_panicking() {
        let result = std::panic::catch_unwind(|| activation_token_with(|_| Err(())));
        assert!(matches!(result, Ok(Err(()))));
    }

    #[tokio::test]
    async fn shutdown_registration_rejection_leaves_no_graceful_drain_work() {
        let token = CancellationToken::new();
        let read_cancel = token.child_token();
        let (writer, queue) = frame_sender(1, token.clone(), Duration::from_secs(1));
        let gen = GenerationCore {
            id: 1,
            token,
            read_cancel,
            read_tasks: TaskTracker::new(),
            shutdown_complete: CancellationToken::new(),
            writer,
            membership: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            pings: Mutex::new(HashMap::new()),
            busy_rejects: Arc::new(tokio::sync::Semaphore::new(1)),
            next_ping_corr: std::sync::atomic::AtomicU64::new(1),
        };

        discard_unregistered_generation(&gen);

        assert!(gen.read_cancel.is_cancelled());
        assert!(gen.token.is_cancelled());
        assert!(queue.discard.is_cancelled());
        gen.read_tasks.close();
        tokio::time::timeout(Duration::from_millis(10), gen.read_tasks.wait())
            .await
            .expect("never-started read loop must not force shutdown");
    }
}
