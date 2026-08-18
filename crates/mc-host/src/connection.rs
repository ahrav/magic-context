//! One authenticated connection generation: admission, per-generation state,
//! the frame read loop, and consumer liveness.
//!
//! A generation owns its correlation watermark, membership lookups, pending
//! correlation index, ping namespace, and writer — but never a route's
//! cleanup, which stays with the global registry (plan KTD5).

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use subc_protocol::FrameType;
use tokio::net::TcpStream;
use tokio::sync::OwnedSemaphorePermit;
use tokio::time::{timeout_at, Instant};
use tokio_util::sync::CancellationToken;
use tokio_util::task::{AbortOnDropHandle, TaskTracker};

use crate::control::{parse_control, ControlAction, CODE_INVALID_CONTROL_REQUEST};
use crate::dispatch::{
    close_generation, dispatch_request, emit_error_terminal, handle_cancel, open_route,
};
use crate::handler::McHostHandler;
use crate::routing::CloseDecision;
use crate::runtime::HostShared;
use crate::wire::{
    drain_declared_body, encode_owned_frame, pure_header_flags, read_frame, FrameId, OutboundFrame,
    ReadClose, ReadEvent, WriterHandle,
};

/// Key of one pending consumer request: (channel, epoch, correlation).
/// Direction is implied — this map holds only consumer-originated requests;
/// host Pings live in their own namespace (protocol §8.3, V43).
pub type PendingKey = (u16, u32, u64);

/// Concurrent off-reader `server_busy` rejection emissions per generation.
/// Small: rejections only queue this deep when global pending capacity is
/// exhausted AND egress is contended; beyond it the reader emits inline.
const MAX_INFLIGHT_BUSY_REJECTS: usize = 32;

/// One outstanding host Ping. `written` flips when the writer reports the
/// frame fully on the socket: a Pong may only clear a written probe, or a
/// peer predicting the correlation sequence could pre-answer Pings it never
/// received and defeat read-liveness detection.
pub struct PingProbe {
    pub flags: u8,
    pub sent: Instant,
    pub written: bool,
}

pub struct PendingEntry {
    pub cancel: CancellationToken,
    pub settlement: Arc<crate::dispatch::Settlement>,
}

/// Generation-owned state shared with the registry and dispatch tasks.
pub struct GenerationCore {
    pub id: u64,
    /// Cancelling retires the generation: reads stop, admitted work settles as
    /// cancelled, emits fail closed.
    pub token: CancellationToken,
    /// Stops the read side and generation-local frame producers without
    /// retiring the writer needed to flush already-started terminals.
    pub read_cancel: CancellationToken,
    /// Read-loop work that can enqueue frames independently of route drains.
    /// Shutdown closes and joins this set before queuing connection Goodbye.
    pub read_tasks: TaskTracker,
    /// Releases the connection owner after shutdown has queued Goodbye, so it
    /// cannot tear down the writer while the producer fence is draining.
    pub shutdown_complete: CancellationToken,
    pub writer: WriterHandle,
    /// channel -> epoch for routes this generation may dispatch on. Lookup
    /// only; the registry owns insertion at bind and removal at close.
    pub membership: Mutex<HashMap<u16, u32>>,
    pub pending: Mutex<HashMap<PendingKey, PendingEntry>>,
    /// Outstanding host-originated Pings: correlation -> (flags byte, sent at).
    pub pings: Mutex<HashMap<u64, PingProbe>>,
    /// Bounds concurrent off-reader `server_busy` rejection emissions so a
    /// client flooding control frames past global capacity cannot grow
    /// unbounded tasks through them.
    pub busy_rejects: Arc<tokio::sync::Semaphore>,
    pub next_ping_corr: std::sync::atomic::AtomicU64,
}

/// Runs one accepted socket to completion: authenticate, promote into
/// authenticated capacity, then serve frames until retirement.
///
/// `handshake_permit` is held from before the first byte is read; it releases
/// on every exit path once authenticated capacity is acquired or the socket
/// dies (protocol §5.1).
pub async fn run_connection<H: McHostHandler>(
    shared: Arc<HostShared<H>>,
    mut stream: TcpStream,
    handshake_permit: OwnedSemaphorePermit,
) {
    let auth = subc_transport::authenticate_server(
        &mut stream,
        shared.auth_key.bytes(),
        &shared.daemon_id,
        &shared.daemon_ver,
        shared.timing.auth_deadline,
    )
    .await;
    // `role` is unverified reporting metadata; every valid proof gets identical
    // admission regardless of it (protocol §5.2).
    if auth.is_err() {
        return;
    }

    // Authentication promotion linearizes here: authenticated capacity is
    // acquired before the generation becomes visible anywhere, and only then
    // is the handshake slot released (plan KTD10).
    let Ok(connection_permit) = shared.connection_permits.clone().try_acquire_owned() else {
        return;
    };
    drop(handshake_permit);
    let _connection_permit = connection_permit;

    // Generation tokens are independent roots rather than children of the
    // shutdown token. Admission stops when `shutdown` fires, but the drain must
    // still emit terminals and a Goodbye on a live generation, so only
    // `shutdown_sequence` may retire these — in protocol order.
    let gen_token = CancellationToken::new();
    let read_cancel = gen_token.child_token();
    let (read_half, write_half) = stream.into_split();
    let (writer, writer_task) = crate::wire::spawn_writer_tracked(
        write_half,
        shared.limits.writer_queue_frames,
        gen_token.clone(),
        shared.timing.frame_deadline,
        &shared.tracker,
    );
    let mut writer_task = AbortOnDropHandle::new(writer_task);

    let gen = Arc::new(GenerationCore {
        id: shared.gen_counter.fetch_add(1, Ordering::SeqCst),
        token: gen_token,
        read_cancel,
        read_tasks: TaskTracker::new(),
        shutdown_complete: CancellationToken::new(),
        writer,
        membership: Mutex::new(HashMap::new()),
        pending: Mutex::new(HashMap::new()),
        pings: Mutex::new(HashMap::new()),
        busy_rejects: Arc::new(tokio::sync::Semaphore::new(MAX_INFLIGHT_BUSY_REJECTS)),
        next_ping_corr: std::sync::atomic::AtomicU64::new(1),
    });
    // Register the read loop before publishing the generation. Its tracker
    // token prevents shutdown from observing an empty producer set between
    // insertion and the first read-loop poll.
    let read_task = gen
        .read_tasks
        .track_future(read_loop(&shared, &gen, read_half));
    {
        let mut connections = shared.connections.lock().expect("connections lock");
        if shared.draining.load(Ordering::SeqCst) {
            return;
        }
        connections.insert(gen.id, Arc::clone(&gen));
    }

    if let Some(liveness) = shared.liveness.clone() {
        let gen_ping = Arc::clone(&gen);
        shared.spawn_tracked(
            gen.read_tasks
                .track_future(liveness_loop(gen_ping, liveness)),
        );
    }

    let read_exit = read_task.await;
    gen.read_cancel.cancel();
    if matches!(read_exit, ReadExit::Peer) {
        // Peer-initiated or error retirement closes silently — even while
        // the host is draining: cancelling the generation token makes queued
        // off-reader emissions fail closed, and discarding the writer drops
        // frames already queued, so a client that sent a corrupt frame never
        // receives terminals or a Goodbye after the close decision
        // (protocol §6.3). Only a host-cancelled read keeps the writer
        // draining in protocol order.
        gen.token.cancel();
        gen.writer.discard();
    }
    // Mark generation-owned routes closing BEFORE waiting for in-flight
    // binds: the route.open wrappers below run inside `read_tasks`, and a
    // bind completing during that wait must observe `close_requested`
    // (finishing through CloseWins) instead of installing a route onto a
    // generation that is about to retire.
    let begun_closes = shared.registry.begin_close_generation(gen.id);
    gen.read_tasks.close();
    gen.read_tasks.wait().await;
    if shared.draining.load(Ordering::SeqCst) {
        gen.shutdown_complete.cancelled().await;
    }

    close_generation(&shared, &gen, begun_closes).await;
    drop(gen);
    // The writer drains queued terminals and Goodbye after the handles drop.
    // Its own per-frame stall deadline (`frame_deadline`, enforced inside the
    // writer task) already bounds this join, so no extra budget applies here:
    // the old `route_close_budget` cap could abort a drain that graceful
    // shutdown promised to flush, while a stalled peer still cannot hold the
    // join beyond the writer's self-retirement.
    let _ = (&mut writer_task).await;
}

/// Why the read side of a connection stopped. Only a host-cancelled read may
/// keep the writer draining: every peer-driven exit (EOF, corruption, peer
/// Goodbye, protocol violation) retires silently, even mid-shutdown.
enum ReadExit {
    HostCancelled,
    Peer,
}

/// Serves validated frames until close. Returning retires the generation.
async fn read_loop<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    mut reader: tokio::net::tcp::OwnedReadHalf,
) -> ReadExit {
    // Highest consumer Request correlation seen; any non-increasing Request
    // closes the generation before dispatch (protocol §8.3, V44).
    let mut watermark: u64 = 0;

    loop {
        let event = match read_frame(
            &mut reader,
            shared.timing.frame_deadline,
            &shared.ingress_budget,
            &gen.read_cancel,
        )
        .await
        {
            Ok(event) => event,
            Err(ReadClose::Cancelled) => return ReadExit::HostCancelled,
            Err(ReadClose::CleanEof) | Err(ReadClose::Corrupt(_)) | Err(ReadClose::Io(_)) => {
                return ReadExit::Peer
            }
        };

        match event {
            ReadEvent::OversizeControl { header, deadline } => {
                // The correlation is trustworthy from the header alone; the
                // early terminal is authoritative even if the drain then fails
                // (protocol §7.1). The watermark still applies first. Emitted
                // off-reader (bounded) like the other no-permit rejections so
                // contended egress cannot block this reader from a queued
                // Pong while the declared body waits to be drained.
                if header.corr <= watermark {
                    return ReadExit::Peer;
                }
                watermark = header.corr;
                crate::dispatch::emit_rejection(
                    shared,
                    gen,
                    FrameId::control(header.corr),
                    CODE_INVALID_CONTROL_REQUEST,
                    "control body exceeds profile cap",
                )
                .await;
                if drain_declared_body(&mut reader, header.len, deadline, &gen.read_cancel)
                    .await
                    .is_err()
                {
                    return ReadExit::Peer;
                }
            }
            ReadEvent::Frame(frame) => {
                let header = frame.header;
                match header.ty {
                    FrameType::Request => {
                        if header.corr <= watermark {
                            return ReadExit::Peer;
                        }
                        watermark = header.corr;
                        if header.channel == 0 {
                            handle_control(shared, gen, frame).await;
                        } else {
                            if header.epoch == 0 {
                                return ReadExit::Peer;
                            }
                            dispatch_request(shared, gen, frame).await;
                        }
                    }
                    FrameType::Cancel => {
                        // Structural shape: current nonzero route, nonzero
                        // correlation (protocol §6.2 table).
                        if header.channel == 0 || header.epoch == 0 || header.corr == 0 {
                            return ReadExit::Peer;
                        }
                        handle_cancel(gen, (header.channel, header.epoch, header.corr));
                    }
                    FrameType::Pong => {
                        if header.channel != 0 || header.corr == 0 {
                            return ReadExit::Peer;
                        }
                        let mut pings = gen.pings.lock().expect("pings lock");
                        match pings.get(&header.corr) {
                            // The echo must match what we sent exactly
                            // (protocol V35) AND the Ping must have reached
                            // the socket — a predictable-correlation Pong
                            // sent before its Ping is unmatched and dropped
                            // (protocol §6.2 table).
                            Some(probe) if probe.flags == header.flags.0 && probe.written => {
                                pings.remove(&header.corr);
                            }
                            _ => {}
                        }
                    }
                    FrameType::Goodbye => {
                        if header.channel == 0 {
                            if header.corr != 0 {
                                return ReadExit::Peer;
                            }
                            // Orderly connection close (protocol §9.4).
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
                        // Duplicate, stale, or mid-bind Goodbyes carry no
                        // cleanup work; spawning for them would let a client
                        // pipeline unbounded no-op tasks past the pure-header
                        // frames' zero capacity cost.
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
                    // rather than extend the profile (protocol §6.2). Ping is
                    // host-to-consumer only; a consumer Ping would demand an
                    // implicit host-Pong extension, so it closes too.
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

async fn handle_control<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    frame: crate::wire::InboundFrame,
) {
    let corr = frame.header.corr;
    let action = parse_control(
        &frame.body,
        frame.header.flags.is_binary(),
        &shared.module_id,
    );
    // The body and its charge are done: validation is complete.
    drop(frame);

    // Every channel-0 request — including semantic rejections — is one
    // consumer request against the global unsettled bound; at capacity the
    // no-dispatch `server_busy` terminal takes precedence over the semantic
    // error (protocol §8.3).
    let Ok(pending_permit) = shared.pending_permits.clone().try_acquire_owned() else {
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
            // Emission can wait on shared egress budget; queue it off the
            // read loop so a contended budget cannot stall Pong reads into a
            // liveness false-kill. Bounded: the permit was acquired above.
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
            // Catalog stays serviceable during drain (protocol §12 step 1
            // freezes routes and dispatch, not control reads). Emitted off
            // the read loop for the same liveness reason as rejections.
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
        ControlAction::RouteOpen { identity } => {
            // Bind callbacks may be slow; never stall the read loop on them.
            // Abort-exempt: this wrapper owns its route's cleanup (rejected
            // or close-raced binds still get exactly-once route-gone), so the
            // forced shutdown path must let it finish; every await inside is
            // self-bounded.
            let shared_task = Arc::clone(shared);
            let gen_task = Arc::clone(gen);
            shared.spawn_lifecycle(gen.read_tasks.track_future(async move {
                let _pending_permit = pending_permit;
                open_route(shared_task, gen_task, corr, identity).await;
            }));
        }
    }
}

/// Clones a startup-cached catalog only after its encoded size is charged,
/// then transfers that charge unchanged to the connection writer.
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
    let frame_bytes = body
        .len()
        .checked_add(subc_protocol::HEADER_LEN)
        .ok_or(())?;
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

    // Capacity includes the eventual header, so encoding does not need a
    // second allocation while the cached bytes are copied.
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
        charge,
        written: None,
    })
}

/// Host-side Ping issuance. The correlation namespace is host-owned and
/// independent of consumer correlations (protocol §8.3): a Ping correlation
/// numerically equal to a pending consumer correlation cannot cross-settle
/// because Pongs only match this map.
async fn liveness_loop(gen: Arc<GenerationCore>, policy: crate::config::LivenessPolicy) {
    let mut next_ping_at = Instant::now() + policy.ping_interval;
    loop {
        // Wake at the sooner of the next Ping tick and the earliest
        // outstanding Pong deadline: the deadline wake honors
        // `pong_deadline` exactly, and the tick wake notices an answered
        // Pong so the next Ping is not delayed until the old deadline.
        let wake_at = {
            let pings = gen.pings.lock().expect("pings lock");
            pings
                .values()
                .map(|probe| probe.sent + policy.pong_deadline)
                .min()
                .map_or(next_ping_at, |deadline| deadline.min(next_ping_at))
        };
        tokio::select! {
            () = gen.read_cancel.cancelled() => return,
            () = tokio::time::sleep_until(wake_at) => {}
        }
        let now = Instant::now();
        let expired = {
            let pings = gen.pings.lock().expect("pings lock");
            pings
                .values()
                .any(|probe| now.duration_since(probe.sent) >= policy.pong_deadline)
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
                // An unexpired Ping is outstanding; no new Ping is added
                // beside it. Advance the tick so the next wake makes
                // progress — re-arming a past tick would spin this task
                // until the Pong arrived or its deadline expired.
                next_ping_at = now + policy.ping_interval;
                continue;
            }
        }
        if now < next_ping_at {
            // Woke for a Pong deadline that was answered in time; the next
            // Ping still waits for its tick.
            continue;
        }
        next_ping_at = now + policy.ping_interval;
        let corr = gen.next_ping_corr.fetch_add(1, Ordering::SeqCst);
        let flags = pure_header_flags();
        // The entry must exist before the Ping can reach the wire, or the
        // read loop would drop a fast Pong as unmatched.
        gen.pings.lock().expect("pings lock").insert(
            corr,
            PingProbe {
                flags: flags.0,
                sent: Instant::now(),
                written: false,
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
        // The hook runs inside the writer task at write completion, so the
        // probe is answerable the instant the Ping can reach the peer — an
        // async notification would leave a gap where a fast (or adversarial
        // pre-answering) Pong races the flag update.
        let gen_probe = Arc::clone(&gen);
        let written_hook = Box::new(move || {
            if let Some(probe) = gen_probe.pings.lock().expect("pings lock").get_mut(&corr) {
                probe.sent = Instant::now();
                probe.written = true;
            }
            let _ = written_tx.send(());
        });
        let send = gen.writer.send(crate::wire::OutboundFrame {
            bytes,
            charge: crate::wire::ByteCharge::none(),
            written: Some(written_hook),
        });
        let sent = tokio::select! {
            biased;
            () = gen.read_cancel.cancelled() => return,
            sent = send => sent,
        };
        if sent.is_err() {
            return;
        }
        // Wait for write completion before arming expiry: the hook above
        // already anchored the deadline and flipped `written` inside the
        // writer task; this await only paces the loop.
        tokio::select! {
            () = gen.read_cancel.cancelled() => return,
            written = written_rx => {
                if written.is_err() {
                    // Writer retired before the Ping reached the socket.
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

    #[derive(Clone, Copy)]
    enum FencedProducer {
        Catalog,
        CapacityRejection,
    }

    async fn read_frame_from(stream: &mut DuplexStream) -> subc_protocol::EnvelopeHeader {
        let mut header_bytes = [0; subc_protocol::HEADER_LEN];
        stream
            .read_exact(&mut header_bytes)
            .await
            .expect("frame header");
        let header = subc_protocol::decode_header(&header_bytes).expect("valid frame header");
        let mut body = vec![0; header.len as usize];
        stream.read_exact(&mut body).await.expect("frame body");
        header
    }

    async fn assert_started_producer_precedes_goodbye(producer: FencedProducer) {
        let generation = CancellationToken::new();
        let read_cancel = generation.child_token();
        let (server, mut client) = tokio::io::duplex(4096);
        let (writer, writer_task) =
            crate::wire::spawn_writer(server, 4, generation.clone(), Duration::from_secs(1));
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
        let frame_bytes = subc_protocol::HEADER_LEN + body.len();
        let budget = crate::wire::ByteBudget::new(frame_bytes as u64);
        let generation = CancellationToken::new();
        let (server, client) = tokio::io::duplex(64);
        let (writer, writer_task) =
            crate::wire::spawn_writer(server, 1, generation.clone(), Duration::from_secs(1));
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
        assert_eq!(&frame.bytes[subc_protocol::HEADER_LEN..], body);
        drop(frame);
        assert_eq!(budget.available(), frame_bytes);

        drop(gen);
        drop(client);
        writer_task.await.expect("writer task");
    }
}
