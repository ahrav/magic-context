//! Deadline- and cancellation-bounded frame reads, shared by the host's framing
//! layer and the client's reader.
//!
//! These are the byte-moving mechanics only: fill a buffer, fill a body, discard a
//! declared body. The protocol policy around them — which lengths are legal, what
//! an oversize control body means, whether a short read is corruption or an
//! orderly close — stays with each caller, because the two answer those questions
//! differently.
//!
//! Single-sourced because the mechanics are where the subtle parts live: the
//! `biased` select that prefers cancellation over another read, treating a
//! zero-length read as end-of-stream rather than looping, and capping the body
//! read at the frame boundary so a pipelined next header is never consumed as
//! body. Two copies of that drifting apart reintroduces exactly the bugs the
//! comments around them describe.

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::time::{timeout_at, Instant};
use tokio_util::sync::CancellationToken;

/// Why a bounded read stopped short. Callers map this onto their own error type,
/// since the same stop means different things to a host framing layer and to a
/// client reader.
#[derive(Debug)]
pub(crate) enum ReadStop {
    /// The cancellation token fired; no further read was attempted.
    Cancelled,
    /// A read returned zero bytes with the buffer unfilled.
    Eof,
    /// The deadline passed before the buffer filled.
    DeadlineExpired,
    Io(std::io::Error),
}

/// Fills `buf` completely, or stops.
pub(crate) async fn read_exact<R>(
    reader: &mut R,
    buf: &mut [u8],
    deadline: Instant,
    cancel: &CancellationToken,
) -> Result<(), ReadStop>
where
    R: AsyncRead + Unpin,
{
    let mut filled = 0;
    while filled < buf.len() {
        let read = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(ReadStop::Cancelled),
            result = timeout_at(deadline, reader.read(&mut buf[filled..])) => match result {
                Ok(read) => read.map_err(ReadStop::Io)?,
                Err(_) => return Err(ReadStop::DeadlineExpired),
            },
        };
        if read == 0 {
            return Err(ReadStop::Eof);
        }
        filled += read;
    }
    Ok(())
}

/// Appends exactly `len` body bytes into `buf`.
///
/// `read_buf` appends into spare capacity without zero-initializing it, and
/// `take` caps the read at the frame boundary even when the allocated capacity
/// exceeds `len` — without that cap a pipelined next header would be read as this
/// frame's body.
pub(crate) async fn read_body<R>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    len: usize,
    deadline: Instant,
    cancel: &CancellationToken,
) -> Result<(), ReadStop>
where
    R: AsyncRead + Unpin,
{
    let mut limited = reader.take(len as u64);
    while buf.len() < len {
        let read = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(ReadStop::Cancelled),
            result = timeout_at(deadline, limited.read_buf(buf)) => match result {
                Ok(read) => read.map_err(ReadStop::Io)?,
                Err(_) => return Err(ReadStop::DeadlineExpired),
            },
        };
        if read == 0 {
            return Err(ReadStop::Eof);
        }
    }
    Ok(())
}

/// Discards exactly `declared` bytes, realigning the stream on a body the caller
/// refused to buffer.
pub(crate) async fn drain<R>(
    reader: &mut R,
    declared: usize,
    deadline: Instant,
    cancel: &CancellationToken,
) -> Result<(), ReadStop>
where
    R: AsyncRead + Unpin,
{
    let mut scratch = [0u8; 8192];
    let mut remaining = declared;
    while remaining > 0 {
        let want = remaining.min(scratch.len());
        let read = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(ReadStop::Cancelled),
            result = timeout_at(deadline, reader.read(&mut scratch[..want])) => match result {
                Ok(read) => read.map_err(ReadStop::Io)?,
                Err(_) => return Err(ReadStop::DeadlineExpired),
            },
        };
        if read == 0 {
            return Err(ReadStop::Eof);
        }
        remaining -= read;
    }
    Ok(())
}
