//! TCP implementation of the frame channel: byte-stream mechanics stay here.
//!
//! Everything stream-shaped is owned by this module — fragmentation and
//! coalescing across reads, the absolute frame deadline armed by the first
//! received header byte, oversized-control body drains, short writes,
//! serialized frame publication, and socket close. The generation engine
//! above sees only complete frames and bounded events through
//! [`crate::frame_channel`].
//!
//! Structural corruption (bad header, truncation, oversize body, illegal
//! pure-header body) silently retires the generation without an `Error`
//! frame; semantic rejection with trustworthy identity flows through the
//! settlement path in `dispatch` instead (protocol §6.3).

#[cfg(test)]
use crate::wire::Flags;
use crate::wire::{
    decode_header, DecodeError, EnvelopeHeader, FrameType, FROZEN_PREFIX_LEN, HEADER_LEN,
    PROTOCOL_VERSION,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

use crate::frame_channel::{
    frame_sender, validate_inbound_header, CopyCounter, FrameReceiver, FrameSender, InboundEvent,
    InboundFrame, ReadClose, RejectedFrame, SenderQueue,
};
use crate::wire::{ByteBudget, ByteCharge, MAX_CONTROL_BODY_LEN};

/// Read-side buffering for coalesced small frames.
const READ_BUFFER_BYTES: usize = 64 * 1024;

/// One connection's TCP frame channel, receive side. Constructed by
/// [`TcpFrameChannel::start`], which also yields the cloneable sender and the
/// serialized write task.
pub(crate) struct TcpFrameChannel<R> {
    reader: BufReader<R>,
    frame_deadline: Duration,
    budget: ByteBudget,
    cancel: CancellationToken,
    /// A rejected oversized-control declaration whose body bytes are still
    /// on the stream: the next `recv` drains them under the rejected frame's
    /// own absolute deadline before reading further (protocol §7.1).
    pending_drain: Option<PendingDrain>,
    copies: CopyCounter,
}

struct PendingDrain {
    declared: u32,
    deadline: Instant,
}

impl<R: AsyncRead + Send + Unpin> TcpFrameChannel<R> {
    /// Builds the complete channel over an already-authenticated stream's
    /// halves: the cloneable sender, this single-owner receiver, and the
    /// write task the caller must spawn. The write task publishes queued
    /// frames strictly in order and closes the socket's write side when it
    /// exits; dropping the receiver closes the read side.
    ///
    /// `generation` is the engine's retirement root: write failure or an
    /// admission-deadline expiry cancels it. `read_cancel` bounds reads
    /// (and drains) for the receive side.
    pub(crate) fn start<W>(
        read: R,
        write: W,
        queue_frames: usize,
        frame_deadline: Duration,
        ingress: ByteBudget,
        generation: CancellationToken,
        read_cancel: CancellationToken,
    ) -> (
        FrameSender,
        Self,
        std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>,
    )
    where
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let (sender, queue) = frame_sender(queue_frames, generation, frame_deadline);
        let copies = CopyCounter::default();
        let receiver = Self {
            reader: BufReader::with_capacity(READ_BUFFER_BYTES, read),
            frame_deadline,
            budget: ingress,
            cancel: read_cancel,
            pending_drain: None,
            copies,
        };
        let task = Box::pin(write_frames(write, queue, frame_deadline));
        (sender, receiver, task)
    }
}

impl<R: AsyncRead + Send + Unpin> FrameReceiver for TcpFrameChannel<R> {
    async fn recv(&mut self) -> Result<InboundEvent, ReadClose> {
        if let Some(drain) = self.pending_drain.take() {
            if drain_declared_body(
                &mut self.reader,
                drain.declared,
                drain.deadline,
                &self.cancel,
            )
            .await
            .is_err()
            {
                // Regardless of how the drain failed (EOF, deadline, I/O,
                // cancellation), the engine's queued early terminal stays
                // authoritative and must survive the close (protocol §7.1).
                return Err(ReadClose::RejectedDrainFailed);
            }
        }
        match read_frame(
            &mut self.reader,
            self.frame_deadline,
            &self.budget,
            &self.cancel,
            &self.copies,
        )
        .await?
        {
            ReadEvent::Frame(frame) => Ok(InboundEvent::Frame(frame)),
            ReadEvent::OversizeControl { header, deadline } => {
                self.pending_drain = Some(PendingDrain {
                    declared: header.len,
                    deadline,
                });
                Ok(InboundEvent::Rejected(RejectedFrame { corr: header.corr }))
            }
        }
    }
}

/// Outcome of reading one frame.
enum ReadEvent {
    Frame(InboundFrame),
    /// A channel-0 `Request` declared a body over the control cap. The body
    /// has NOT been read; the caller reports the rejection and then drains
    /// via [`drain_declared_body`] under `deadline` (protocol §7.1).
    OversizeControl {
        header: EnvelopeHeader,
        deadline: Instant,
    },
}

/// Reads one frame. Waiting for the first header byte is unbounded; once it
/// arrives, the remaining header and body share one absolute deadline.
async fn read_frame<R>(
    reader: &mut R,
    frame_deadline: Duration,
    budget: &ByteBudget,
    cancel: &CancellationToken,
    copies: &CopyCounter,
) -> Result<ReadEvent, ReadClose>
where
    R: AsyncRead + Unpin,
{
    let mut header_bytes = [0u8; HEADER_LEN];

    let first = tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(ReadClose::Cancelled),
        read = reader.read(&mut header_bytes[..1]) => read.map_err(ReadClose::Io)?,
    };
    if first == 0 {
        return Err(ReadClose::CleanEof);
    }

    let deadline = Instant::now() + frame_deadline;
    read_exact_deadline(
        reader,
        &mut header_bytes[1..FROZEN_PREFIX_LEN],
        deadline,
        cancel,
    )
    .await?;
    if header_bytes[4] != PROTOCOL_VERSION {
        return Err(ReadClose::Corrupt("unsupported version"));
    }
    read_exact_deadline(
        reader,
        &mut header_bytes[FROZEN_PREFIX_LEN..],
        deadline,
        cancel,
    )
    .await?;

    let header = decode_header(&header_bytes).map_err(|err| {
        ReadClose::Corrupt(match err {
            DecodeError::UnsupportedVersion { .. } => "unsupported version",
            DecodeError::UnknownFrameType { .. } => "unknown frame type",
            _ => "invalid header",
        })
    })?;

    validate_inbound_header(header)?;

    if header.ty == FrameType::Request && header.channel == 0 && header.len > MAX_CONTROL_BODY_LEN {
        // The header alone proves the violation; never buffer the body
        // (protocol §7.1).
        return Ok(ReadEvent::OversizeControl { header, deadline });
    }

    let charge = if header.len == 0 {
        ByteCharge::none()
    } else {
        tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(ReadClose::Cancelled),
            charge = budget.charge(header.len) => charge,
            () = tokio::time::sleep_until(deadline) => {
                return Err(ReadClose::Corrupt("body budget wait exceeded frame deadline"));
            }
        }
    };

    let mut body = Vec::with_capacity(header.len as usize);
    if header.len > 0 {
        read_body_deadline(reader, &mut body, header.len as usize, deadline, cancel).await?;
    }

    Ok(ReadEvent::Frame(InboundFrame::contiguous(
        header,
        body,
        charge,
        copies.clone(),
    )))
}

/// Discards the declared bytes of an early-rejected oversize control body
/// without allocating it, preserving stream alignment. Failure here closes the
/// generation as usual; the already-queued terminal stays authoritative.
/// Discards a declared body the caller refused to buffer, realigning the stream.
async fn drain_declared_body<R>(
    reader: &mut R,
    declared: u32,
    deadline: Instant,
    cancel: &CancellationToken,
) -> Result<(), ReadClose>
where
    R: AsyncRead + Unpin,
{
    crate::frame_read::drain(reader, declared as usize, deadline, cancel)
        .await
        .map_err(drain_close)
}

/// Fills `buf`, classifying a short read as this layer sees it.
async fn read_exact_deadline<R>(
    reader: &mut R,
    buf: &mut [u8],
    deadline: Instant,
    cancel: &CancellationToken,
) -> Result<(), ReadClose>
where
    R: AsyncRead + Unpin,
{
    crate::frame_read::read_exact(reader, buf, deadline, cancel)
        .await
        .map_err(frame_close)
}

/// Reads exactly `len` body bytes under the frame deadline.
async fn read_body_deadline<R>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    len: usize,
    deadline: Instant,
    cancel: &CancellationToken,
) -> Result<(), ReadClose>
where
    R: AsyncRead + Unpin,
{
    crate::frame_read::read_body(reader, buf, len, deadline, cancel)
        .await
        .map_err(frame_close)
}

/// A stop inside a frame: EOF and deadline both mean stream alignment is lost, so
/// the generation closes without resynchronization (protocol section 6.3).
fn frame_close(stop: crate::frame_read::ReadStop) -> ReadClose {
    match stop {
        crate::frame_read::ReadStop::Cancelled => ReadClose::Cancelled,
        crate::frame_read::ReadStop::Eof => ReadClose::Corrupt("EOF inside frame"),
        crate::frame_read::ReadStop::DeadlineExpired => {
            ReadClose::Corrupt("frame deadline expired")
        }
        crate::frame_read::ReadStop::Io(error) => ReadClose::Io(error),
    }
}

/// Same classes, named for the drain so a failure says which phase lost alignment.
fn drain_close(stop: crate::frame_read::ReadStop) -> ReadClose {
    match stop {
        crate::frame_read::ReadStop::Eof => ReadClose::Corrupt("EOF while draining oversize body"),
        crate::frame_read::ReadStop::DeadlineExpired => {
            ReadClose::Corrupt("drain deadline expired")
        }
        other => frame_close(other),
    }
}

/// The single serialized write task for one connection.
///
/// Every frame's bytes reach the socket completely before any byte of the
/// next. Partial writes are retried; an I/O failure or `write_deadline`
/// expiry before the frame completes retires the generation (protocol §6.3).
/// The deadline bounds how long one consumer can hold shared egress-budget
/// charges: a peer that stops reading would otherwise pin its queued frames'
/// charges forever and stall every other generation's emissions. Dropping
/// every `FrameSender` closes the queue, which lets already queued terminals
/// and `Goodbye` flush before the task exits.
async fn write_frames<W>(mut stream: W, mut queue: SenderQueue, write_deadline: Duration)
where
    W: AsyncWrite + Send + Unpin + 'static,
{
    let discard = queue.discard.clone();
    let finish = queue.finish.clone();
    loop {
        let mut queued = tokio::select! {
            biased;
            () = discard.cancelled() => break,
            // Finished: flush what is queued, then exit without waiting
            // for senders an inert handler may still hold.
            () = finish.cancelled() => match queue.try_recv() {
                Ok(frame) => frame,
                Err(_) => break,
            },
            frame = queue.recv() => match frame {
                Some(frame) => frame,
                None => break,
            },
        };
        // `begin_publication` synchronizes cancellation with the possible-send
        // transition before the first transport write.
        if !queued.begin_publication() {
            continue;
        }
        let completion = std::sync::Arc::clone(&queued.state);
        let crate::frame_channel::OutboundFrame {
            mut bytes,
            mut tail,
            direct,
            charge,
            written,
        } = queued.frame;
        if let Some(direct) = direct {
            let encoded =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| direct.into_owned()));
            match encoded {
                Ok(Ok(encoded)) => {
                    bytes = encoded;
                    tail.clear();
                }
                Ok(Err(_)) | Err(_) => {
                    queue.retired.cancel();
                    queue.generation.cancel();
                    break;
                }
            }
        }
        // The completion instant is taken inside the arm, the moment
        // `write_all` returns — not after the result check — so a
        // preemption between them cannot push `completed_at` past a peer
        // answer that the bytes themselves caused.
        let result = tokio::select! {
            biased;
            () = discard.cancelled() => None,
            result = tokio::time::timeout(write_deadline, async {
                stream.write_all(&bytes).await?;
                if !tail.is_empty() {
                    stream.write_all(&tail).await?;
                }
                Ok::<(), std::io::Error>(())
            }) => {
                Some((result, Instant::now()))
            }
        };
        let Some((result, completed_at)) = result else {
            queue.retired.cancel();
            queue.generation.cancel();
            break;
        };
        if !matches!(result, Ok(Ok(()))) {
            queue.retired.cancel();
            queue.generation.cancel();
            break;
        }
        completion.store(
            crate::frame_channel::COMPLETE,
            std::sync::atomic::Ordering::Release,
        );
        if let Some(written) = written {
            written(completed_at);
        }
        drop(bytes);
        drop(tail);
        drop(charge);
    }
    // Dropping the queue receiver here frees any still-queued frames and
    // their charges.
    queue.retired.cancel();
    let _ = stream.shutdown().await;
}

/// Spawns only the write half of a TCP channel over an arbitrary stream, for
/// tests that drive the sender without a read side.
#[cfg(test)]
pub(crate) fn spawn_writer<W>(
    stream: W,
    queue_frames: usize,
    generation: CancellationToken,
    write_deadline: Duration,
) -> (FrameSender, tokio::task::JoinHandle<()>)
where
    W: AsyncWrite + Send + Unpin + 'static,
{
    let (sender, queue) = frame_sender(queue_frames, generation, write_deadline);
    let task = tokio::spawn(write_frames(stream, queue, write_deadline));
    (sender, task)
}

/// Contract-suite factory for the TCP adapter: connects a channel under test
/// to an independent frame-level peer over an in-memory duplex stream.
#[cfg(test)]
pub(crate) struct TcpChannelFactory;

#[cfg(test)]
impl crate::frame_channel::contract_tests::ChannelFactory for TcpChannelFactory {
    type Channel = TcpFrameChannel<tokio::io::ReadHalf<tokio::io::DuplexStream>>;
    type Peer = TcpPeer;

    async fn connect(
        &self,
        cfg: crate::frame_channel::contract_tests::ContractConfig,
    ) -> crate::frame_channel::contract_tests::Harness<Self::Channel, Self::Peer> {
        let (host, peer) = tokio::io::duplex(cfg.transport_buffer_bytes);
        let (read, write) = tokio::io::split(host);
        let budget = ByteBudget::new(cfg.budget_bytes);
        let generation = CancellationToken::new();
        let read_cancel = generation.child_token();
        let (sender, channel, io) = TcpFrameChannel::start(
            read,
            write,
            cfg.queue_frames,
            cfg.write_deadline,
            budget.clone(),
            generation.clone(),
            read_cancel,
        );
        crate::frame_channel::contract_tests::Harness {
            sender,
            channel,
            peer: TcpPeer { stream: peer },
            generation,
            budget,
            io_task: tokio::spawn(io),
        }
    }
}

/// Independent frame-level peer over the raw byte stream: encodes and
/// decodes v2 frames itself so the channel under test is never used to
/// verify its own output.
#[cfg(test)]
pub(crate) struct TcpPeer {
    stream: tokio::io::DuplexStream,
}

#[cfg(test)]
impl crate::frame_channel::contract_tests::PeerDriver for TcpPeer {
    async fn send_frame(
        &mut self,
        ty: FrameType,
        flags: Flags,
        id: crate::wire::FrameId,
        body: Vec<u8>,
    ) {
        let bytes = crate::wire::encode_frame(ty, flags, id, &body).expect("peer frame encodes");
        self.stream
            .write_all(&bytes)
            .await
            .expect("peer write succeeds");
    }

    async fn recv_frame(&mut self) -> Option<(EnvelopeHeader, Vec<u8>)> {
        let mut header_bytes = [0u8; HEADER_LEN];
        let mut filled = 0;
        while filled < HEADER_LEN {
            match self.stream.read(&mut header_bytes[filled..]).await {
                Ok(0) if filled == 0 => return None,
                Ok(0) => panic!("peer observed EOF inside a frame header"),
                Ok(read) => filled += read,
                Err(_) => return None,
            }
        }
        let header = decode_header(&header_bytes).expect("peer decodes a valid header");
        let mut body = vec![0u8; header.len as usize];
        self.stream
            .read_exact(&mut body)
            .await
            .expect("peer reads the declared body");
        Some((header, body))
    }

    async fn close(self) {
        drop(self.stream);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use tokio::io::{duplex, AsyncWriteExt};

    use crate::wire::{encode_frame, response_flags, FrameId, MAX_BODY_LEN};

    fn budget() -> ByteBudget {
        ByteBudget::new(crate::config::MIN_RESIDENT_BYTES)
    }

    fn header_bytes(len: u32, ty: u8, flags: u8, channel: u16, epoch: u32, corr: u64) -> Vec<u8> {
        let mut b = Vec::with_capacity(HEADER_LEN);
        b.extend_from_slice(&len.to_le_bytes());
        b.push(PROTOCOL_VERSION);
        b.push(ty);
        b.push(flags);
        b.extend_from_slice(&channel.to_le_bytes());
        b.extend_from_slice(&epoch.to_le_bytes());
        b.extend_from_slice(&corr.to_le_bytes());
        b
    }

    fn outbound(bytes: Vec<u8>) -> crate::frame_channel::OutboundFrame {
        crate::frame_channel::OutboundFrame {
            bytes,
            tail: Vec::new(),
            direct: None,
            charge: ByteCharge::none(),
            written: None,
        }
    }

    fn receiver_over(
        stream: tokio::io::DuplexStream,
        frame_deadline: Duration,
        budget: ByteBudget,
        cancel: CancellationToken,
    ) -> TcpFrameChannel<tokio::io::ReadHalf<tokio::io::DuplexStream>> {
        let (read, _write) = tokio::io::split(stream);
        TcpFrameChannel {
            reader: BufReader::with_capacity(READ_BUFFER_BYTES, read),
            frame_deadline,
            budget,
            cancel,
            pending_drain: None,
            copies: CopyCounter::default(),
        }
    }

    #[tokio::test]
    async fn clean_eof_before_header_is_orderly() {
        let (client, mut server) = duplex(64);
        drop(client);
        let cancel = CancellationToken::new();
        let err = read_frame(
            &mut server,
            Duration::from_secs(1),
            &budget(),
            &cancel,
            &CopyCounter::default(),
        )
        .await
        .err()
        .expect("close");
        assert!(matches!(err, ReadClose::CleanEof));
    }

    #[tokio::test]
    async fn eof_after_first_header_byte_is_corruption() {
        let (mut client, mut server) = duplex(64);
        let cancel = CancellationToken::new();
        client.write_all(&[7u8]).await.unwrap();
        drop(client);
        let err = read_frame(
            &mut server,
            Duration::from_secs(1),
            &budget(),
            &cancel,
            &CopyCounter::default(),
        )
        .await
        .err()
        .expect("close");
        assert!(matches!(err, ReadClose::Corrupt(_)));
    }

    #[tokio::test]
    async fn eof_inside_a_declared_body_is_corruption() {
        let (mut client, mut server) = duplex(64);
        let cancel = CancellationToken::new();
        let mut wire = header_bytes(8, FrameType::Request as u8, 0, 3, 1, 1);
        wire.extend_from_slice(b"abc");
        client.write_all(&wire).await.unwrap();
        drop(client);
        let err = read_frame(
            &mut server,
            Duration::from_secs(1),
            &budget(),
            &cancel,
            &CopyCounter::default(),
        )
        .await
        .err()
        .expect("close");
        assert!(matches!(err, ReadClose::Corrupt("EOF inside frame")));
    }

    #[tokio::test(start_paused = true)]
    async fn frame_deadline_is_absolute_from_first_header_byte() {
        let (mut client, mut server) = duplex(64);
        let cancel = CancellationToken::new();
        let read = tokio::spawn(async move {
            match read_frame(
                &mut server,
                Duration::from_secs(5),
                &budget(),
                &cancel,
                &CopyCounter::default(),
            )
            .await
            {
                Ok(_) => Ok(()),
                Err(error) => Err(error),
            }
        });
        // Idle wait is unbounded: nothing has been sent yet.
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert!(!read.is_finished());
        // First byte starts the absolute deadline; trickling the rest of the
        // header cannot extend it.
        client.write_all(&[10u8]).await.unwrap();
        tokio::time::sleep(Duration::from_secs(4)).await;
        client.write_all(&[0u8, 0u8]).await.unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;
        let err = read.await.unwrap().expect_err("deadline close");
        assert!(matches!(err, ReadClose::Corrupt("frame deadline expired")));
    }

    #[tokio::test]
    async fn oversize_control_is_reported_without_reading_body() {
        let (mut client, mut server) = duplex(1024);
        let cancel = CancellationToken::new();
        let header = header_bytes(
            MAX_CONTROL_BODY_LEN + 1,
            FrameType::Request as u8,
            0,
            0,
            0,
            9,
        );
        client.write_all(&header).await.unwrap();
        let event = read_frame(
            &mut server,
            Duration::from_secs(1),
            &budget(),
            &cancel,
            &CopyCounter::default(),
        )
        .await
        .expect("event");
        match event {
            ReadEvent::OversizeControl { header, .. } => {
                assert_eq!(header.len, MAX_CONTROL_BODY_LEN + 1);
                assert_eq!(header.corr, 9);
            }
            ReadEvent::Frame(_) => panic!("oversize control must not be admitted"),
        }
    }

    #[tokio::test]
    async fn control_cap_boundary_is_exact() {
        let (mut client, mut server) = duplex(1 << 20);
        let cancel = CancellationToken::new();
        let mut wire = header_bytes(MAX_CONTROL_BODY_LEN, FrameType::Request as u8, 0, 0, 0, 3);
        wire.extend_from_slice(&vec![b' '; MAX_CONTROL_BODY_LEN as usize]);
        let writer = tokio::spawn(async move { client.write_all(&wire).await });
        let event = read_frame(
            &mut server,
            Duration::from_secs(5),
            &budget(),
            &cancel,
            &CopyCounter::default(),
        )
        .await
        .expect("event");
        writer.await.unwrap().unwrap();
        assert!(matches!(
            event,
            ReadEvent::Frame(InboundFrame { header, .. }) if header.len == MAX_CONTROL_BODY_LEN
        ));
    }

    #[tokio::test]
    async fn body_over_interop_cap_closes_before_allocation() {
        let (mut client, mut server) = duplex(64);
        // A one-byte budget would panic or hang on allocation if the reader
        // tried to admit this body; rejection must come from the header alone.
        let tiny_budget = ByteBudget::new(1);
        let cancel = CancellationToken::new();
        let header = header_bytes(MAX_BODY_LEN + 1, FrameType::Request as u8, 0, 7, 1, 1);
        client.write_all(&header).await.unwrap();
        let err = read_frame(
            &mut server,
            Duration::from_secs(1),
            &tiny_budget,
            &cancel,
            &CopyCounter::default(),
        )
        .await
        .err()
        .expect("close");
        assert!(matches!(
            err,
            ReadClose::Corrupt("body over interoperability cap")
        ));
    }

    #[tokio::test]
    async fn drain_discards_exactly_declared_bytes_and_realigns() {
        let (mut client, mut server) = duplex(1 << 20);
        let cancel = CancellationToken::new();
        let declared = MAX_CONTROL_BODY_LEN + 5;
        let mut wire = header_bytes(declared, FrameType::Request as u8, 0, 0, 0, 4);
        wire.extend_from_slice(&vec![0xEE; declared as usize]);
        // A following valid pure-header frame proves alignment survives.
        wire.extend_from_slice(&header_bytes(0, FrameType::Goodbye as u8, 0, 0, 0, 0));
        let writer = tokio::spawn(async move { client.write_all(&wire).await });

        let event = read_frame(
            &mut server,
            Duration::from_secs(5),
            &budget(),
            &cancel,
            &CopyCounter::default(),
        )
        .await
        .expect("event");
        let ReadEvent::OversizeControl { header, deadline } = event else {
            panic!("expected oversize control");
        };
        drain_declared_body(&mut server, header.len, deadline, &cancel)
            .await
            .expect("drain");
        let next = read_frame(
            &mut server,
            Duration::from_secs(5),
            &budget(),
            &cancel,
            &CopyCounter::default(),
        )
        .await
        .expect("aligned next frame");
        writer.await.unwrap().unwrap();
        assert!(matches!(
            next,
            ReadEvent::Frame(InboundFrame { header, .. }) if header.ty == FrameType::Goodbye
        ));
    }

    #[tokio::test]
    async fn receiver_reports_rejection_then_drains_without_allocation_and_realigns() {
        let (mut client, server) = duplex(1 << 20);
        // Budget far below the declared body: any attempt to admit or
        // allocate the oversize body would hang on this budget, so a
        // successful drain proves the bytes were discarded unbuffered.
        let tiny_budget = ByteBudget::new(1024);
        let mut channel = receiver_over(
            server,
            Duration::from_secs(5),
            tiny_budget.clone(),
            CancellationToken::new(),
        );

        let declared = MAX_CONTROL_BODY_LEN + 7;
        let mut wire = header_bytes(declared, FrameType::Request as u8, 0, 0, 0, 6);
        wire.extend_from_slice(&vec![0xAB; declared as usize]);
        wire.extend_from_slice(&header_bytes(0, FrameType::Goodbye as u8, 0, 0, 0, 0));
        let writer = tokio::spawn(async move { client.write_all(&wire).await });

        let event = channel.recv().await.expect("rejected event");
        let InboundEvent::Rejected(rejected) = event else {
            panic!("expected a rejected-frame event");
        };
        assert_eq!(rejected.corr, 6);
        let next = channel.recv().await.expect("aligned next frame");
        writer.await.unwrap().unwrap();
        assert!(matches!(
            next,
            InboundEvent::Frame(InboundFrame { header, .. }) if header.ty == FrameType::Goodbye
        ));
        assert_eq!(
            tiny_budget.available(),
            1024,
            "an oversize declaration must never hold ingress budget"
        );
    }

    #[tokio::test]
    async fn receiver_reports_failed_drain_as_rejected_drain_failure() {
        let (mut client, server) = duplex(1 << 20);
        let mut channel = receiver_over(
            server,
            Duration::from_secs(5),
            budget(),
            CancellationToken::new(),
        );

        let declared = MAX_CONTROL_BODY_LEN + 9;
        let mut wire = header_bytes(declared, FrameType::Request as u8, 0, 0, 0, 8);
        // Truncate the declared body so the drain hits EOF.
        wire.extend_from_slice(&[0xCD; 16]);
        client.write_all(&wire).await.unwrap();
        drop(client);

        let event = channel.recv().await.expect("rejected event");
        assert!(matches!(
            event,
            InboundEvent::Rejected(RejectedFrame { corr: 8 })
        ));
        let err = channel.recv().await.err().expect("drain failure");
        assert!(matches!(err, ReadClose::RejectedDrainFailed));
    }

    #[tokio::test]
    async fn fragmented_and_coalesced_frames_preserve_alignment() {
        let (mut client, server) = duplex(1 << 20);
        let mut channel = receiver_over(
            server,
            Duration::from_secs(5),
            budget(),
            CancellationToken::new(),
        );

        // Frame A arrives byte by byte across every header and body
        // boundary; frames B and C arrive coalesced in one write.
        let frame_a = encode_frame(
            FrameType::Request,
            response_flags(false, true),
            FrameId {
                channel: 3,
                epoch: 1,
                corr: 1,
            },
            b"fragmented",
        )
        .expect("frame encodes");
        let mut coalesced = Vec::new();
        for corr in 2..=3u64 {
            coalesced.extend_from_slice(
                &encode_frame(
                    FrameType::Request,
                    response_flags(false, true),
                    FrameId {
                        channel: 3,
                        epoch: 1,
                        corr,
                    },
                    b"coalesced",
                )
                .expect("frame encodes"),
            );
        }
        let writer = tokio::spawn(async move {
            for byte in frame_a {
                client.write_all(&[byte]).await.unwrap();
            }
            client.write_all(&coalesced).await.unwrap();
        });

        for (corr, body) in [
            (1u64, &b"fragmented"[..]),
            (2, &b"coalesced"[..]),
            (3, &b"coalesced"[..]),
        ] {
            let event = channel.recv().await.expect("frame");
            let InboundEvent::Frame(frame) = event else {
                panic!("expected a complete frame");
            };
            assert_eq!(frame.header.corr, corr);
            frame.with_lease(|lease| assert_eq!(lease.segment(0), Some(body)));
        }
        writer.await.unwrap();
    }

    #[tokio::test]
    async fn maximum_size_frame_is_admitted_whole_and_releases_its_charge() {
        let (mut client, server) = duplex(1 << 20);
        let budget = budget();
        let baseline = budget.available();
        let mut channel = receiver_over(
            server,
            Duration::from_secs(30),
            budget.clone(),
            CancellationToken::new(),
        );

        let writer = tokio::spawn(async move {
            let header = {
                let mut b = Vec::with_capacity(HEADER_LEN);
                b.extend_from_slice(&MAX_BODY_LEN.to_le_bytes());
                b.push(PROTOCOL_VERSION);
                b.push(FrameType::Request as u8);
                b.push(0);
                b.extend_from_slice(&7u16.to_le_bytes());
                b.extend_from_slice(&1u32.to_le_bytes());
                b.extend_from_slice(&1u64.to_le_bytes());
                b
            };
            client.write_all(&header).await.unwrap();
            let chunk = vec![0x5A; 1 << 20];
            let mut remaining = MAX_BODY_LEN as usize;
            while remaining > 0 {
                let take = remaining.min(chunk.len());
                client.write_all(&chunk[..take]).await.unwrap();
                remaining -= take;
            }
        });

        let event = channel.recv().await.expect("maximum-size frame");
        writer.await.unwrap();
        let InboundEvent::Frame(frame) = event else {
            panic!("expected a complete frame");
        };
        assert_eq!(frame.header.len, MAX_BODY_LEN);
        assert_eq!(frame.body_len(), MAX_BODY_LEN as usize);
        assert_eq!(budget.available(), baseline - MAX_BODY_LEN as usize);
        drop(frame);
        assert_eq!(budget.available(), baseline);
    }

    #[tokio::test]
    async fn byte_charges_release_with_their_frame() {
        let budget = ByteBudget::new(crate::config::MIN_RESIDENT_BYTES);
        let baseline = budget.available();
        let (mut client, mut server) = duplex(1024);
        let cancel = CancellationToken::new();
        let mut wire = header_bytes(5, FrameType::Request as u8, 0, 3, 1, 1);
        wire.extend_from_slice(b"hello");
        client.write_all(&wire).await.unwrap();
        let event = read_frame(
            &mut server,
            Duration::from_secs(1),
            &budget,
            &cancel,
            &CopyCounter::default(),
        )
        .await
        .expect("frame");
        let ReadEvent::Frame(frame) = event else {
            panic!("expected frame");
        };
        assert_eq!(budget.available(), baseline - 5);
        drop(frame);
        assert_eq!(budget.available(), baseline);
    }

    struct ByteByByteWriter {
        bytes: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    }

    impl AsyncWrite for ByteByByteWriter {
        fn poll_write(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            buf: &[u8],
        ) -> std::task::Poll<io::Result<usize>> {
            if buf.is_empty() {
                return std::task::Poll::Ready(Ok(0));
            }
            self.bytes.lock().expect("bytes lock").push(buf[0]);
            std::task::Poll::Ready(Ok(1))
        }

        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }

        fn poll_shutdown(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn partial_writes_finish_one_frame_before_the_next() {
        let bytes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let writer = ByteByByteWriter {
            bytes: std::sync::Arc::clone(&bytes),
        };
        let generation = CancellationToken::new();
        let (handle, task) = spawn_writer(writer, 4, generation, Duration::from_secs(5));
        let mut expected = Vec::new();
        for corr in 1..=2 {
            let encoded = encode_frame(
                FrameType::Response,
                response_flags(false, true),
                FrameId {
                    channel: 7,
                    epoch: 1,
                    corr,
                },
                &[corr as u8; 32],
            )
            .expect("frame encodes");
            expected.extend_from_slice(&encoded);
            handle.send(outbound(encoded)).await.expect("queue frame");
        }
        drop(handle);
        task.await.expect("writer task");
        assert_eq!(*bytes.lock().expect("bytes lock"), expected);
    }

    #[tokio::test]
    async fn writer_serializes_frames_and_flushes_queue_on_close() {
        let (server, mut client) = duplex(1 << 16);
        let generation = CancellationToken::new();
        let (handle, task) = spawn_writer(server, 8, generation, Duration::from_secs(5));
        for corr in 1..=3u64 {
            let bytes = encode_frame(
                FrameType::Response,
                response_flags(false, false),
                FrameId {
                    channel: 7,
                    epoch: 1,
                    corr,
                },
                b"abc",
            )
            .expect("small frame encodes");
            handle.send(outbound(bytes)).await.expect("send");
        }
        drop(handle);
        task.await.unwrap();
        let mut read = Vec::new();
        client.read_to_end(&mut read).await.unwrap();
        assert_eq!(read.len(), 3 * (HEADER_LEN + 3));
        for (i, chunk) in read.chunks(HEADER_LEN + 3).enumerate() {
            let header = decode_header(chunk).expect("valid header");
            assert_eq!(header.corr, i as u64 + 1);
            assert_eq!(&chunk[HEADER_LEN..], b"abc");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_consumer_write_retires_generation_and_frees_charges() {
        let budget = ByteBudget::new(crate::config::MIN_RESIDENT_BYTES);
        let baseline = budget.available();
        // Tiny duplex: the frame cannot fully flush while the peer reads nothing.
        let (server, client) = duplex(16);
        let generation = CancellationToken::new();
        let (handle, task) = spawn_writer(server, 2, generation.clone(), Duration::from_secs(5));
        let charge = budget.charge(1024).await;
        let bytes = encode_frame(
            FrameType::Response,
            response_flags(false, true),
            FrameId {
                channel: 1,
                epoch: 1,
                corr: 1,
            },
            &vec![0u8; 1024],
        )
        .expect("frame encodes");
        handle
            .send(crate::frame_channel::OutboundFrame {
                bytes,
                tail: Vec::new(),
                direct: None,
                charge,
                written: None,
            })
            .await
            .expect("queued");
        drop(handle);
        task.await.expect("writer task");
        // The stalled write hit the deadline: generation retired, charge freed.
        assert!(generation.is_cancelled());
        assert_eq!(budget.available(), baseline);
        drop(client);
    }

    #[tokio::test(start_paused = true)]
    async fn queue_admission_uses_the_remaining_operation_deadline() {
        let (server, client) = duplex(1);
        let generation = CancellationToken::new();
        let (handle, task) = spawn_writer(server, 1, generation.clone(), Duration::from_secs(10));
        let frame = || outbound(vec![0; 1024]);

        // The writer consumes the first frame and stalls on the tiny duplex;
        // the second frame fills the single queue slot.
        handle.send(frame()).await.expect("first frame");
        handle.send(frame()).await.expect("second frame");

        let deadline = Instant::now() + Duration::from_secs(5);
        tokio::time::advance(Duration::from_secs(4)).await;
        assert!(
            handle.send_before(frame(), deadline).await.is_err(),
            "a full queue must not receive a fresh deadline"
        );
        assert_eq!(
            Instant::now(),
            deadline,
            "queue admission used only the one second remaining"
        );
        assert!(generation.is_cancelled());

        drop(handle);
        drop(client);
        task.await.expect("writer task");
    }

    #[tokio::test]
    async fn writer_failure_retires_generation() {
        let (server, client) = duplex(16);
        let generation = CancellationToken::new();
        let (handle, task) = spawn_writer(server, 2, generation.clone(), Duration::from_secs(5));
        drop(client);
        let bytes = encode_frame(
            FrameType::Response,
            response_flags(false, false),
            FrameId {
                channel: 1,
                epoch: 1,
                corr: 1,
            },
            &vec![0u8; 1024],
        )
        .expect("small frame encodes");
        handle
            .send(outbound(bytes))
            .await
            .expect("queued before failure observed");
        task.await.unwrap();
        assert!(generation.is_cancelled());
        assert!(handle.is_retired());
        assert!(handle.send(outbound(Vec::new())).await.is_err());
    }
}
