//! Byte-level connection machinery: frame reading under one absolute deadline,
//! resident-byte charging, and the single serialized writer per connection.
//!
//! Structural corruption (bad header, truncation, oversize body, illegal
//! pure-header body) silently retires the generation without an `Error` frame;
//! semantic rejection with trustworthy identity flows through the settlement
//! path in `dispatch` instead (protocol §6.3).

use std::sync::Arc;

use subc_protocol::{
    decode_header, AdmissionClass, DecodeError, EnvelopeHeader, Flags, FrameType, Priority,
    FROZEN_PREFIX_LEN, HEADER_LEN, MAX_FRAME_BODY_LEN,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tokio::time::{timeout_at, Duration, Instant};
use tokio_util::sync::CancellationToken;

/// Interoperability body maximum: exactly 64 MiB (protocol §6.3).
pub const MAX_BODY_LEN: u32 = MAX_FRAME_BODY_LEN;

/// Profile cap for a channel-0 control body (protocol §7.1).
pub const MAX_CONTROL_BODY_LEN: u32 = 65_536;

/// Aggregate resident-byte accounting.
///
/// One permit is one byte. Charges attach to the buffers they account for and
/// travel with moves; a copy acquires a second charge. Tokio's semaphore is
/// FIFO, so a queued maximum-size acquisition cannot be starved by later small
/// ones; the frame deadline bounds how long an admission may wait.
#[derive(Clone)]
pub struct ByteBudget {
    semaphore: Arc<Semaphore>,
}

impl ByteBudget {
    pub fn new(max_bytes: u64) -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(max_bytes as usize)),
        }
    }

    /// Waits for `bytes` of budget. Callers must bound the wait (deadline or
    /// cancellation); the reader races this against the frame deadline and
    /// emit paths race it against generation retirement.
    pub async fn charge(&self, bytes: u32) -> ByteCharge {
        let permit = self
            .semaphore
            .clone()
            .acquire_many_owned(bytes)
            .await
            .expect("byte budget semaphore is never closed");
        ByteCharge {
            _permit: Some(permit),
        }
    }

    #[cfg(test)]
    pub fn available(&self) -> usize {
        self.semaphore.available_permits()
    }
}

/// One held byte charge; releases its bytes on drop.
#[derive(Debug)]
pub struct ByteCharge {
    // Held only for its Drop: releasing the permit returns the bytes to the
    // budget at exactly the point the accounted buffer dies.
    _permit: Option<OwnedSemaphorePermit>,
}

impl ByteCharge {
    /// A zero-byte charge for header-only frames.
    pub fn none() -> Self {
        Self { _permit: None }
    }
}

/// Why a generation must be retired without any further frame.
///
/// The host branches only on the variant; the payloads are diagnostic detail
/// that tests assert on to pin which rule fired.
#[derive(Debug)]
#[allow(dead_code)]
pub enum ReadClose {
    /// Clean EOF before any byte of the next header: orderly close.
    CleanEof,
    /// Structural stream corruption or a read deadline expiry.
    Corrupt(&'static str),
    /// The generation or host was cancelled while reading.
    Cancelled,
    /// Socket-level I/O failure.
    Io(std::io::Error),
}

/// One admitted inbound frame with its resident-byte charge.
pub struct InboundFrame {
    pub header: EnvelopeHeader,
    pub body: Vec<u8>,
    pub charge: ByteCharge,
}

/// Outcome of reading one frame.
pub enum ReadEvent {
    Frame(InboundFrame),
    /// A channel-0 `Request` declared a body over the control cap. The body
    /// has NOT been read; the caller queues the early `invalid_control_request`
    /// terminal and then drains via [`drain_declared_body`] under `deadline`
    /// (protocol §7.1).
    OversizeControl {
        header: EnvelopeHeader,
        deadline: Instant,
    },
}

/// Reads one frame. Waiting for the first header byte is unbounded; once it
/// arrives, the remaining header and body share one absolute deadline.
pub async fn read_frame<R>(
    reader: &mut R,
    frame_deadline: Duration,
    budget: &ByteBudget,
    cancel: &CancellationToken,
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
    if header_bytes[4] != subc_protocol::PROTOCOL_VERSION {
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

    if header.len > MAX_BODY_LEN {
        return Err(ReadClose::Corrupt("body over interoperability cap"));
    }
    if header.ty.is_pure_header()
        && (header.flags.is_binary()
            || header.flags.is_last()
            || header.flags.admission_class() != Some(AdmissionClass::Normal))
    {
        return Err(ReadClose::Corrupt("invalid pure-header flags"));
    }

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

    let mut body = vec![0u8; header.len as usize];
    if !body.is_empty() {
        read_exact_deadline(reader, &mut body, deadline, cancel).await?;
    }

    Ok(ReadEvent::Frame(InboundFrame {
        header,
        body,
        charge,
    }))
}

/// Discards the declared bytes of an early-rejected oversize control body
/// without allocating it, preserving stream alignment. Failure here closes the
/// generation as usual; the already-queued terminal stays authoritative.
pub async fn drain_declared_body<R>(
    reader: &mut R,
    declared: u32,
    deadline: Instant,
    cancel: &CancellationToken,
) -> Result<(), ReadClose>
where
    R: AsyncRead + Unpin,
{
    let mut scratch = [0u8; 8192];
    let mut remaining = declared as usize;
    while remaining > 0 {
        let want = remaining.min(scratch.len());
        let read = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(ReadClose::Cancelled),
            result = timeout_at(deadline, reader.read(&mut scratch[..want])) => match result {
                Ok(read) => read.map_err(ReadClose::Io)?,
                Err(_) => return Err(ReadClose::Corrupt("drain deadline expired")),
            },
        };
        if read == 0 {
            return Err(ReadClose::Corrupt("EOF while draining oversize body"));
        }
        remaining -= read;
    }
    Ok(())
}

/// Offset-tracked exact read under an absolute deadline. Cancellation-safe by
/// construction: partial progress retires the generation, so a torn read never
/// resumes on the same stream.
async fn read_exact_deadline<R>(
    reader: &mut R,
    buf: &mut [u8],
    deadline: Instant,
    cancel: &CancellationToken,
) -> Result<(), ReadClose>
where
    R: AsyncRead + Unpin,
{
    let mut filled = 0;
    while filled < buf.len() {
        let read = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(ReadClose::Cancelled),
            result = timeout_at(deadline, reader.read(&mut buf[filled..])) => match result {
                Ok(read) => read.map_err(ReadClose::Io)?,
                Err(_) => return Err(ReadClose::Corrupt("frame deadline expired")),
            },
        };
        if read == 0 {
            return Err(ReadClose::Corrupt("EOF inside frame"));
        }
        filled += read;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameId {
    pub channel: u16,
    pub epoch: u32,
    pub corr: u64,
}

impl FrameId {
    /// Control frames use channel 0 and epoch 0.
    pub fn control(corr: u64) -> Self {
        Self {
            channel: 0,
            epoch: 0,
            corr,
        }
    }

    pub fn routed(route: crate::handler::RouteHandle, corr: u64) -> Self {
        Self {
            channel: route.channel,
            epoch: route.epoch,
            corr,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncodeError {
    pub body_len: usize,
}

/// Encodes one complete frame (header then body) as a single buffer so the
/// writer emits it in one logical write.
#[cfg(test)]
pub fn encode_frame(
    ty: FrameType,
    flags: Flags,
    id: FrameId,
    body: &[u8],
) -> Result<Vec<u8>, EncodeError> {
    if body.len() > MAX_BODY_LEN as usize {
        return Err(EncodeError {
            body_len: body.len(),
        });
    }
    let len = u32::try_from(body.len()).map_err(|_| EncodeError {
        body_len: body.len(),
    })?;
    let header = EnvelopeHeader {
        len,
        ver: subc_protocol::PROTOCOL_VERSION,
        ty,
        flags,
        channel: id.channel,
        epoch: id.epoch,
        corr: id.corr,
    };
    let mut buf = Vec::with_capacity(HEADER_LEN + body.len());
    buf.extend_from_slice(&header.encode());
    buf.extend_from_slice(body);
    Ok(buf)
}

pub fn encode_owned_frame(
    ty: FrameType,
    flags: Flags,
    id: FrameId,
    mut body: Vec<u8>,
) -> Result<Vec<u8>, EncodeError> {
    if body.len() > MAX_BODY_LEN as usize {
        return Err(EncodeError {
            body_len: body.len(),
        });
    }
    let body_len = body.len();
    let len = u32::try_from(body_len).map_err(|_| EncodeError { body_len })?;
    let header = EnvelopeHeader {
        len,
        ver: subc_protocol::PROTOCOL_VERSION,
        ty,
        flags,
        channel: id.channel,
        epoch: id.epoch,
        corr: id.corr,
    }
    .encode();
    // Exact-size growth: amortized `reserve` may double a full-capacity body
    // (a 64 MiB response would hold 128 MiB), exceeding what the caller's
    // byte-budget charge accounts for.
    body.reserve_exact(HEADER_LEN);
    body.resize(body_len + HEADER_LEN, 0);
    body.copy_within(..body_len, HEADER_LEN);
    body[..HEADER_LEN].copy_from_slice(&header);
    Ok(body)
}

/// Default flags for host-emitted body frames.
pub fn response_flags(binary: bool, last: bool) -> Flags {
    Flags::new(binary, Priority::Interactive, last)
}

/// Flags for host-emitted pure-header frames: binary 0, last 0, Normal
/// admission (protocol §6.1).
pub fn pure_header_flags() -> Flags {
    Flags::new(false, Priority::Passive, false)
}

/// One encoded frame queued for the single connection writer, carrying its
/// resident-byte charge until the bytes leave host memory.
pub struct OutboundFrame {
    pub bytes: Vec<u8>,
    pub charge: ByteCharge,
    /// Fired once the frame's bytes have fully reached the socket. Senders
    /// that anchor deadlines on delivery (Ping/Pong liveness) pass a sender;
    /// everything else passes `None`. Dropped unfired if the writer retires
    /// before writing the frame.
    pub written: Option<tokio::sync::oneshot::Sender<()>>,
}

/// Sender half of one connection's serialized writer.
#[derive(Clone)]
pub struct WriterHandle {
    tx: mpsc::Sender<OutboundFrame>,
    retired: CancellationToken,
}

impl WriterHandle {
    /// Queues one encoded frame. Waits for queue capacity, bounded by writer
    /// retirement; `Err` means the generation can no longer emit frames.
    pub async fn send(&self, frame: OutboundFrame) -> Result<(), WriterGone> {
        tokio::select! {
            biased;
            () = self.retired.cancelled() => Err(WriterGone),
            sent = self.tx.send(frame) => sent.map_err(|_| WriterGone),
        }
    }

    /// True once the writer has failed or shut down.
    pub fn is_retired(&self) -> bool {
        self.retired.is_cancelled()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriterGone;

/// Spawns the single writer task for one connection.
///
/// Every frame's bytes reach the socket completely before any byte of the
/// next; a partial write, I/O failure, or `write_deadline` expiry retires the
/// generation (protocol §6.3). The deadline is what bounds how long one
/// consumer can hold shared egress-budget charges: a peer that stops reading
/// would otherwise pin its queued frames' charges forever and stall every
/// other generation's emissions. Dropping every `WriterHandle` closes the
/// queue, which lets already queued terminals and `Goodbye` flush before the
/// task exits.
#[cfg(test)]
pub fn spawn_writer<W>(
    stream: W,
    queue_frames: usize,
    generation: CancellationToken,
    write_deadline: Duration,
) -> (WriterHandle, tokio::task::JoinHandle<()>)
where
    W: AsyncWrite + Send + Unpin + 'static,
{
    let (handle, task) = writer_parts(stream, queue_frames, generation, write_deadline);
    (handle, tokio::spawn(task))
}

pub fn spawn_writer_tracked<W>(
    stream: W,
    queue_frames: usize,
    generation: CancellationToken,
    write_deadline: Duration,
    tracker: &tokio_util::task::TaskTracker,
) -> (WriterHandle, tokio::task::JoinHandle<()>)
where
    W: AsyncWrite + Send + Unpin + 'static,
{
    let (handle, task) = writer_parts(stream, queue_frames, generation, write_deadline);
    (handle, tracker.spawn(task))
}

fn writer_parts<W>(
    stream: W,
    queue_frames: usize,
    generation: CancellationToken,
    write_deadline: Duration,
) -> (WriterHandle, impl std::future::Future<Output = ()> + Send)
where
    W: AsyncWrite + Send + Unpin + 'static,
{
    let (tx, mut rx) = mpsc::channel::<OutboundFrame>(queue_frames);
    let retired = CancellationToken::new();
    let handle = WriterHandle {
        tx,
        retired: retired.clone(),
    };
    let task = async move {
        let mut stream = stream;
        while let Some(frame) = rx.recv().await {
            let OutboundFrame {
                bytes,
                charge,
                written,
            } = frame;
            let result = tokio::time::timeout(write_deadline, stream.write_all(&bytes)).await;
            if !matches!(result, Ok(Ok(()))) {
                retired.cancel();
                generation.cancel();
                break;
            }
            if let Some(written) = written {
                let _ = written.send(());
            }
            drop(bytes);
            drop(charge);
        }
        retired.cancel();
        let _ = stream.shutdown().await;
    };
    (handle, task)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use subc_protocol::PROTOCOL_VERSION;
    use tokio::io::{duplex, AsyncWriteExt};

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

    #[tokio::test]
    async fn clean_eof_before_header_is_orderly() {
        let (client, mut server) = duplex(64);
        drop(client);
        let cancel = CancellationToken::new();
        let err = read_frame(&mut server, Duration::from_secs(1), &budget(), &cancel)
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
        let err = read_frame(&mut server, Duration::from_secs(1), &budget(), &cancel)
            .await
            .err()
            .expect("close");
        assert!(matches!(err, ReadClose::Corrupt(_)));
    }

    #[tokio::test(start_paused = true)]
    async fn frame_deadline_is_absolute_from_first_header_byte() {
        let (mut client, mut server) = duplex(64);
        let cancel = CancellationToken::new();
        let read = tokio::spawn(async move {
            read_frame(&mut server, Duration::from_secs(5), &budget(), &cancel).await
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
        let err = read.await.unwrap().err().expect("deadline close");
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
        let event = read_frame(&mut server, Duration::from_secs(1), &budget(), &cancel)
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
        let event = read_frame(&mut server, Duration::from_secs(5), &budget(), &cancel)
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
        let err = read_frame(&mut server, Duration::from_secs(1), &tiny_budget, &cancel)
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

        let event = read_frame(&mut server, Duration::from_secs(5), &budget(), &cancel)
            .await
            .expect("event");
        let ReadEvent::OversizeControl { header, deadline } = event else {
            panic!("expected oversize control");
        };
        drain_declared_body(&mut server, header.len, deadline, &cancel)
            .await
            .expect("drain");
        let next = read_frame(&mut server, Duration::from_secs(5), &budget(), &cancel)
            .await
            .expect("aligned next frame");
        writer.await.unwrap().unwrap();
        assert!(matches!(
            next,
            ReadEvent::Frame(InboundFrame { header, .. }) if header.ty == FrameType::Goodbye
        ));
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
        let event = read_frame(&mut server, Duration::from_secs(1), &budget, &cancel)
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
            handle
                .send(OutboundFrame {
                    bytes: encoded,
                    charge: ByteCharge::none(),
                    written: None,
                })
                .await
                .expect("queue frame");
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
            handle
                .send(OutboundFrame {
                    bytes,
                    charge: ByteCharge::none(),
                    written: None,
                })
                .await
                .expect("send");
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
            .send(OutboundFrame {
                bytes,
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
            .send(OutboundFrame {
                bytes,
                charge: ByteCharge::none(),
                written: None,
            })
            .await
            .expect("queued before failure observed");
        task.await.unwrap();
        assert!(generation.is_cancelled());
        assert!(handle.is_retired());
        assert!(handle
            .send(OutboundFrame {
                bytes: Vec::new(),
                charge: ByteCharge::none(),
                written: None,
            })
            .await
            .is_err());
    }
}
