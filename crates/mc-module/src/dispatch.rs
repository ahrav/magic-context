use std::fmt;
use std::io::{self, Write};
use std::sync::Arc;

use serde_json::{Map, Value};

/// Maximum body accepted by the version-2 wire contract.
pub const MAX_WIRE_BODY_BYTES: usize = 64 * 1024 * 1024;

/// Successful response body prepared without an encoded output buffer.
#[derive(Clone)]
pub struct PreparedOutput {
    source: PreparedSource,
    #[cfg(test)]
    encoded_for_test: Arc<std::sync::OnceLock<Vec<u8>>>,
}

#[derive(Clone)]
enum PreparedSource {
    Json(Arc<Value>),
    Exact(Arc<Vec<u8>>),
    Transform(Arc<TransformSegments>),
}

struct TransformSegments {
    envelope: Map<String, Value>,
    messages: Vec<PreparedSegment>,
}

#[derive(Clone)]
enum PreparedSegmentSource {
    Exact(Arc<[u8]>),
    Served(crate::transform::ServedMessage),
}

/// One immutable, already encoded transform message.
#[derive(Clone)]
pub struct PreparedSegment {
    source: PreparedSegmentSource,
    measured_len: usize,
}

impl PreparedSegment {
    pub fn exact(bytes: Arc<[u8]>) -> Self {
        let measured_len = bytes.len();
        Self {
            source: PreparedSegmentSource::Exact(bytes),
            measured_len,
        }
    }

    pub(crate) fn served(message: crate::transform::ServedMessage) -> Self {
        let measured_len = message.canonical_bytes().len();
        Self {
            source: PreparedSegmentSource::Served(message),
            measured_len,
        }
    }

    /// Constructs a deliberately inconsistent segment for length-check tests.
    #[doc(hidden)]
    pub fn inconsistent_for_test(bytes: Arc<[u8]>, measured_len: usize) -> Self {
        Self {
            source: PreparedSegmentSource::Exact(bytes),
            measured_len,
        }
    }

    fn bytes(&self) -> &[u8] {
        match &self.source {
            PreparedSegmentSource::Exact(bytes) => bytes,
            PreparedSegmentSource::Served(message) => message.canonical_bytes(),
        }
    }
}

impl fmt::Debug for PreparedSegment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PreparedSegment")
            .field("bytes_len", &self.bytes().len())
            .field("measured_len", &self.measured_len)
            .finish()
    }
}

impl PreparedOutput {
    /// Retains a JSON value for counting and serialization after reservation.
    pub fn json(value: Value) -> Self {
        Self {
            source: PreparedSource::Json(Arc::new(value)),
            #[cfg(test)]
            encoded_for_test: Arc::new(std::sync::OnceLock::new()),
        }
    }

    /// Retains existing encoded bytes without copying them into an output body.
    pub fn cached_bytes(bytes: Vec<u8>) -> Self {
        Self {
            source: PreparedSource::Exact(Arc::new(bytes)),
            #[cfg(test)]
            encoded_for_test: Arc::new(std::sync::OnceLock::new()),
        }
    }

    pub fn transform_segments(
        envelope: Value,
        messages: Vec<PreparedSegment>,
    ) -> Result<Self, PreparedOutputError> {
        let Value::Object(envelope) = envelope else {
            return Err(PreparedOutputError::InvalidTransformEnvelope);
        };
        if envelope.get("ck_messages") != Some(&Value::Null) {
            return Err(PreparedOutputError::InvalidTransformEnvelope);
        }
        Ok(Self {
            source: PreparedSource::Transform(Arc::new(TransformSegments { envelope, messages })),
            #[cfg(test)]
            encoded_for_test: Arc::new(std::sync::OnceLock::new()),
        })
    }

    /// Measures this immutable source exactly before output reservation.
    pub fn measure(&self) -> Result<MeasuredOutput<'_>, PreparedOutputError> {
        let len = match &self.source {
            PreparedSource::Json(value) => measure_json(value)?,
            PreparedSource::Exact(bytes) => checked_body_len([bytes.len()])?,
            PreparedSource::Transform(segments) => measure_transform(segments)?,
        };
        Ok(MeasuredOutput { output: self, len })
    }
}

#[cfg(test)]
impl std::ops::Deref for PreparedOutput {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        self.encoded_for_test
            .get_or_init(|| {
                let measured = self.measure().expect("test response must measure");
                let mut bytes = Vec::with_capacity(measured.len());
                measured
                    .write_to(&mut bytes)
                    .expect("test response must serialize");
                bytes
            })
            .as_slice()
    }
}

#[cfg(test)]
impl AsRef<[u8]> for PreparedOutput {
    fn as_ref(&self) -> &[u8] {
        self
    }
}

#[cfg(test)]
impl PartialEq<Vec<u8>> for PreparedOutput {
    fn eq(&self, other: &Vec<u8>) -> bool {
        &**self == other.as_slice()
    }
}

impl fmt::Debug for PreparedOutput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let kind = match self.source {
            PreparedSource::Json(_) => "json",
            PreparedSource::Exact(_) => "exact",
            PreparedSource::Transform(_) => "transform",
        };
        f.debug_struct("PreparedOutput")
            .field("kind", &kind)
            .finish()
    }
}

/// Successful, typed-error, and streamed dispatch settlements.
pub enum PreparedOutcome {
    Response(PreparedOutput),
    Error { code: String, message: String },
    Streamed,
}

impl fmt::Debug for PreparedOutcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Response(body) => f.debug_tuple("Response").field(body).finish(),
            Self::Error { code, message } => f
                .debug_struct("Error")
                .field("code_len", &code.len())
                .field("message_len", &message.len())
                .finish(),
            Self::Streamed => f.write_str("Streamed"),
        }
    }
}

/// Exact measurement tied to the immutable source that produced it.
pub struct MeasuredOutput<'a> {
    output: &'a PreparedOutput,
    len: usize,
}

impl MeasuredOutput<'_> {
    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Writes into a caller-reserved destination and verifies exact length.
    pub fn write_to<W: Write>(&self, destination: &mut W) -> Result<usize, PreparedOutputError> {
        let mut destination = BoundedWriter::new(destination, self.len);
        match &self.output.source {
            PreparedSource::Json(value) => {
                serde_json::to_writer(&mut destination, value)
                    .map_err(PreparedOutputError::Serialize)?;
            }
            PreparedSource::Exact(bytes) => destination.write_all(bytes)?,
            PreparedSource::Transform(segments) => write_transform(segments, &mut destination)?,
        }
        let written = destination.written();
        if written != self.len {
            return Err(PreparedOutputError::LengthMismatch {
                measured: self.len,
                written,
            });
        }
        Ok(written)
    }
}

#[derive(Debug)]
pub enum PreparedOutputError {
    BodyTooLarge { len: usize, max: usize },
    LengthOverflow,
    InvalidTransformEnvelope,
    Serialize(serde_json::Error),
    Write(io::Error),
    LengthMismatch { measured: usize, written: usize },
}

impl fmt::Display for PreparedOutputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BodyTooLarge { len, max } => {
                write!(f, "prepared body length {len} exceeds wire cap {max}")
            }
            Self::LengthOverflow => f.write_str("prepared body length overflowed"),
            Self::InvalidTransformEnvelope => {
                f.write_str("transform envelope must contain a null ck_messages field")
            }
            Self::Serialize(error) => write!(f, "prepared JSON serialization failed: {error}"),
            Self::Write(error) => write!(f, "prepared body write failed: {error}"),
            Self::LengthMismatch { measured, written } => write!(
                f,
                "prepared body length mismatch: measured {measured}, wrote {written}"
            ),
        }
    }
}

impl std::error::Error for PreparedOutputError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Serialize(error) => Some(error),
            Self::Write(error) => Some(error),
            Self::BodyTooLarge { .. }
            | Self::LengthOverflow
            | Self::InvalidTransformEnvelope
            | Self::LengthMismatch { .. } => None,
        }
    }
}

impl From<io::Error> for PreparedOutputError {
    fn from(error: io::Error) -> Self {
        Self::Write(error)
    }
}

fn checked_body_len(
    lengths: impl IntoIterator<Item = usize>,
) -> Result<usize, PreparedOutputError> {
    let mut total = 0usize;
    for len in lengths {
        total = total
            .checked_add(len)
            .ok_or(PreparedOutputError::LengthOverflow)?;
    }
    if total > MAX_WIRE_BODY_BYTES {
        return Err(PreparedOutputError::BodyTooLarge {
            len: total,
            max: MAX_WIRE_BODY_BYTES,
        });
    }
    Ok(total)
}

fn measure_json(value: &Value) -> Result<usize, PreparedOutputError> {
    let mut counter = CountingWriter::default();
    let result = serde_json::to_writer(&mut counter, value).map_err(PreparedOutputError::Serialize);
    finish_count(counter, result)
}

fn finish_count(
    counter: CountingWriter,
    result: Result<(), PreparedOutputError>,
) -> Result<usize, PreparedOutputError> {
    match counter.failure {
        Some(CountFailure::Overflow) => Err(PreparedOutputError::LengthOverflow),
        Some(CountFailure::TooLarge(len)) => Err(PreparedOutputError::BodyTooLarge {
            len,
            max: MAX_WIRE_BODY_BYTES,
        }),
        None => {
            result?;
            Ok(counter.len)
        }
    }
}

fn measure_transform(segments: &TransformSegments) -> Result<usize, PreparedOutputError> {
    let mut counter = CountingWriter::default();
    let result = write_transform_envelope(segments, &mut counter, |counter, message| {
        counter.add_len(message.measured_len)
    });
    finish_count(counter, result)
}

fn write_transform<W: Write>(
    segments: &TransformSegments,
    destination: &mut W,
) -> Result<(), PreparedOutputError> {
    write_transform_envelope(segments, destination, |destination, message| {
        destination.write_all(message.bytes())?;
        Ok(())
    })
}

fn write_transform_envelope<W: Write>(
    segments: &TransformSegments,
    destination: &mut W,
    mut write_message: impl FnMut(&mut W, &PreparedSegment) -> Result<(), PreparedOutputError>,
) -> Result<(), PreparedOutputError> {
    destination.write_all(b"{")?;
    for (index, (key, value)) in segments.envelope.iter().enumerate() {
        if index > 0 {
            destination.write_all(b",")?;
        }
        serde_json::to_writer(&mut *destination, key).map_err(PreparedOutputError::Serialize)?;
        destination.write_all(b":")?;
        if key == "ck_messages" {
            destination.write_all(b"[")?;
            for (message_index, message) in segments.messages.iter().enumerate() {
                if message_index > 0 {
                    destination.write_all(b",")?;
                }
                write_message(destination, message)?;
            }
            destination.write_all(b"]")?;
        } else {
            serde_json::to_writer(&mut *destination, value)
                .map_err(PreparedOutputError::Serialize)?;
        }
    }
    destination.write_all(b"}")?;
    Ok(())
}

#[derive(Debug, Clone, Copy)]
enum CountFailure {
    Overflow,
    TooLarge(usize),
}

#[derive(Default)]
struct CountingWriter {
    len: usize,
    failure: Option<CountFailure>,
}

impl CountingWriter {
    fn add_len(&mut self, len: usize) -> Result<(), PreparedOutputError> {
        let Some(next) = self.len.checked_add(len) else {
            self.failure = Some(CountFailure::Overflow);
            return Err(PreparedOutputError::LengthOverflow);
        };
        if next > MAX_WIRE_BODY_BYTES {
            self.failure = Some(CountFailure::TooLarge(next));
            return Err(PreparedOutputError::BodyTooLarge {
                len: next,
                max: MAX_WIRE_BODY_BYTES,
            });
        }
        self.len = next;
        Ok(())
    }
}

impl Write for CountingWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.add_len(bytes.len())
            .map_err(|error| io::Error::new(io::ErrorKind::FileTooLarge, error.to_string()))?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct BoundedWriter<'a, W> {
    inner: &'a mut W,
    max_len: usize,
    written: usize,
}

impl<'a, W> BoundedWriter<'a, W> {
    fn new(inner: &'a mut W, max_len: usize) -> Self {
        Self {
            inner,
            max_len,
            written: 0,
        }
    }

    fn written(&self) -> usize {
        self.written
    }
}

impl<W: Write> Write for BoundedWriter<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.max_len - self.written {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "prepared body exceeded measured length",
            ));
        }
        let written = self.inner.write(bytes)?;
        if written > bytes.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "destination reported an invalid write length",
            ));
        }
        self.written += written;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}
