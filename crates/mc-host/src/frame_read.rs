//!
//! differently.
//!
//! `biased` gives cancellation precedence when cancellation and a read are both ready.

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::time::{timeout_at, Instant};
use tokio_util::sync::CancellationToken;

/// client reader.
#[derive(Debug)]
pub(crate) enum ReadStop {
    Cancelled,
    Eof,
    DeadlineExpired,
    Io(std::io::Error),
}

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

///
/// `read_buf` appends into spare capacity without zero-initializing it.
/// `take(len as u64)` caps reads at the frame boundary, preventing spare capacity from consuming a pipelined next-frame header.
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

/// A successful call discards exactly `declared` bytes to realign the stream.
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
