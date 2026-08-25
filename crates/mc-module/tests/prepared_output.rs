use std::cell::Cell;
use std::io::{self, Write};
use std::sync::Arc;

use mc_module::dispatch::{
    PreparedOutcome, PreparedOutput, PreparedOutputError, PreparedSegment, MAX_WIRE_BODY_BYTES,
};
use serde_json::json;

fn reserved_vec(output: &PreparedOutput) -> Result<Vec<u8>, PreparedOutputError> {
    let measured = output.measure()?;
    let mut destination = Vec::with_capacity(measured.len());
    measured.write_to(&mut destination)?;
    Ok(destination)
}

#[test]
fn json_measurement_matches_small_and_facade_sized_bytes() {
    for value in [
        json!({"ok": true, "items": [1, 2, 3]}),
        json!({
            "content": [{"type": "text", "text": "x".repeat(900 * 1024)}],
            "isError": false,
        }),
    ] {
        let expected = serde_json::to_vec(&value).unwrap();
        let output = PreparedOutput::json(value);
        let measured = output.measure().unwrap();
        assert_eq!(measured.len(), expected.len());
        assert_eq!(reserved_vec(&output).unwrap(), expected);
    }
}

#[test]
fn transform_segments_preserve_existing_golden_bytes() {
    let messages = vec![
        PreparedSegment::exact(Arc::from(
            br#"{"mid":"m1","content":[{"kind":{"text":"hello"}}]}"#.as_slice(),
        )),
        PreparedSegment::exact(Arc::from(
            br#"{"mid":"m2","content":[{"kind":{"text":"cached"}}]}"#.as_slice(),
        )),
    ];
    let output = PreparedOutput::transform_segments(
        json!({"status": "ok", "ck_messages": null, "cache_ttl": "1h"}),
        messages,
    )
    .unwrap();
    let expected = br#"{"cache_ttl":"1h","ck_messages":[{"mid":"m1","content":[{"kind":{"text":"hello"}}]},{"mid":"m2","content":[{"kind":{"text":"cached"}}]}],"status":"ok"}"#;

    let measured = output.measure().unwrap();
    assert_eq!(measured.len(), expected.len());
    assert_eq!(reserved_vec(&output).unwrap(), expected);
}

struct ReservationWriter<'a> {
    reserved: &'a Cell<bool>,
    writes: &'a Cell<usize>,
    bytes: Vec<u8>,
}

impl<'a> ReservationWriter<'a> {
    fn reserve(reserved: &'a Cell<bool>, writes: &'a Cell<usize>, capacity: usize) -> Self {
        reserved.set(true);
        Self {
            reserved,
            writes,
            bytes: Vec::with_capacity(capacity),
        }
    }
}

impl Write for ReservationWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        assert!(self.reserved.get(), "copy occurred before reservation");
        self.writes.set(self.writes.get() + 1);
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn cached_bytes_copy_only_after_destination_reservation() {
    let expected = br#"{"cached":true,"value":"stable"}"#.to_vec();
    let output = PreparedOutput::cached_bytes(expected.clone());
    let reserved = Cell::new(false);
    let writes = Cell::new(0);

    let measured = output.measure().unwrap();
    assert!(!reserved.get());
    assert_eq!(writes.get(), 0);

    let mut destination = ReservationWriter::reserve(&reserved, &writes, measured.len());
    measured.write_to(&mut destination).unwrap();
    assert!(writes.get() > 0);
    assert_eq!(destination.bytes, expected);
}

#[test]
fn typed_errors_and_stream_markers_have_no_prepared_body() {
    let error = PreparedOutcome::Error {
        code: "invalid_params".to_string(),
        message: "bad request".to_string(),
    };
    let streamed = PreparedOutcome::Streamed;
    let response = PreparedOutcome::Response(PreparedOutput::json(json!({"ok": true})));

    assert!(matches!(error, PreparedOutcome::Error { .. }));
    assert!(matches!(streamed, PreparedOutcome::Streamed));
    assert!(matches!(response, PreparedOutcome::Response(_)));
}

#[derive(Default)]
struct CountingSink {
    written: usize,
}

impl Write for CountingSink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.written = self.written.checked_add(bytes.len()).unwrap();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn exactly_at_wire_cap_succeeds_without_destination_allocation() {
    let output = PreparedOutput::cached_bytes(vec![0x5a; MAX_WIRE_BODY_BYTES]);
    let measured = output.measure().unwrap();
    assert_eq!(measured.len(), MAX_WIRE_BODY_BYTES);

    let mut destination = CountingSink::default();
    assert_eq!(
        measured.write_to(&mut destination).unwrap(),
        MAX_WIRE_BODY_BYTES
    );
    assert_eq!(destination.written, MAX_WIRE_BODY_BYTES);
}

#[test]
fn cap_plus_one_and_arithmetic_overflow_fail_before_write() {
    let envelope = json!({"ck_messages": null});
    let fixed_len = br#"{"ck_messages":[]}"#.len();
    let cap_plus_one = PreparedOutput::transform_segments(
        envelope.clone(),
        vec![PreparedSegment::inconsistent_for_test(
            Arc::from([]),
            MAX_WIRE_BODY_BYTES + 1 - fixed_len,
        )],
    )
    .unwrap();
    assert!(matches!(
        cap_plus_one.measure(),
        Err(PreparedOutputError::BodyTooLarge {
            len,
            max: MAX_WIRE_BODY_BYTES
        }) if len == MAX_WIRE_BODY_BYTES + 1
    ));

    let overflow = PreparedOutput::transform_segments(
        envelope,
        vec![PreparedSegment::inconsistent_for_test(
            Arc::from([]),
            usize::MAX,
        )],
    )
    .unwrap();
    assert!(matches!(
        overflow.measure(),
        Err(PreparedOutputError::LengthOverflow)
    ));
}

fn settle_with_cancellation(
    output: &PreparedOutput,
    cancel_before_reserve: bool,
    reserve: bool,
    cancel_before_write: bool,
) -> Option<Vec<u8>> {
    let measured = output.measure().ok()?;
    if cancel_before_reserve || !reserve {
        return None;
    }
    let mut destination = Vec::with_capacity(measured.len());
    if cancel_before_write {
        return None;
    }
    measured.write_to(&mut destination).ok()?;
    Some(destination)
}

#[test]
fn cancellation_before_reservation_or_write_emits_nothing() {
    let output = PreparedOutput::json(json!({"ok": true}));
    assert_eq!(settle_with_cancellation(&output, true, true, false), None);
    assert_eq!(settle_with_cancellation(&output, false, true, true), None);
}

#[test]
fn reserve_denial_emits_nothing() {
    let output = PreparedOutput::cached_bytes(b"cached".to_vec());
    assert_eq!(settle_with_cancellation(&output, false, false, false), None);
}

struct FailAfter {
    remaining: usize,
    accepted: usize,
}

impl Write for FailAfter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Err(io::Error::other("injected serializer failure"));
        }
        let written = bytes.len().min(self.remaining);
        self.remaining -= written;
        self.accepted += written;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn serializer_failure_retains_no_partial_terminal() {
    let output = PreparedOutput::json(json!({"value": "serializer must fail after bytes"}));
    let measured = output.measure().unwrap();
    let mut destination = FailAfter {
        remaining: 5,
        accepted: 0,
    };
    let mut terminal = None;

    let result = measured.write_to(&mut destination);
    if result.is_ok() {
        terminal = Some(destination.accepted);
    }

    assert!(matches!(result, Err(PreparedOutputError::Serialize(_))));
    assert!(destination.accepted > 0);
    assert_eq!(terminal, None);
}

#[test]
fn inconsistent_source_reports_length_mismatch_without_emission() {
    let output = PreparedOutput::transform_segments(
        json!({"ck_messages": null}),
        vec![PreparedSegment::inconsistent_for_test(
            Arc::from(b"1".as_slice()),
            2,
        )],
    )
    .unwrap();
    let measured = output.measure().unwrap();
    let mut destination = Vec::with_capacity(measured.len());
    let mut terminal = None;

    let result = measured.write_to(&mut destination);
    if result.is_ok() {
        terminal = Some(destination.clone());
    }

    let expected = br#"{"ck_messages":[1]}"#;
    assert!(matches!(
        result,
        Err(PreparedOutputError::LengthMismatch {
            measured: 20,
            written: 19
        })
    ));
    assert_eq!(destination, expected);
    assert_eq!(terminal, None);
}
