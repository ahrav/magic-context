use mc_core::redaction::{
    detect_windowed_durable_bytes, redact_durable_text, redact_windowed_durable_text, Detection,
    RedactionError,
};
use rusqlite::{params, Transaction};

use crate::CachedSql;

use super::{map_sqlite, KernelError};

/// Redacted durable text and its detection metadata.
#[derive(Clone)]
pub(super) struct RedactedField {
    /// Text returned by the durable redactor.
    pub text: String,
    /// Detections returned by the durable redactor.
    pub detections: Vec<Detection>,
}

/// Use [`redact`] when input may exceed `MAX_REDACTABLE_BYTES`; `redact_lossy`
/// does not preserve oversized input.
pub(super) fn redact_lossy(value: &str) -> RedactedField {
    let redaction = redact_durable_text(value);
    RedactedField {
        text: redaction.text,
        detections: redaction.detections,
    }
}

/// Artifact payloads may exceed `MAX_REDACTABLE_BYTES`, so they scan in
/// overlapping windows. Unlike [`redact_lossy`], a scan failure is reported
/// rather than replaced by a placeholder: the payload bytes are the artifact,
/// so a placeholder would silently become the stored content.
pub(super) fn redact_payload(
    value: &str,
    max_detections: usize,
) -> Result<RedactedField, RedactionError> {
    redact_windowed_durable_text(value, max_detections).map(|redaction| RedactedField {
        text: redaction.text,
        detections: redaction.detections,
    })
}

/// Whether a payload that will be stored verbatim holds a recognized secret;
/// `Err` means scanning could not prove the payload secret-free.
pub(super) fn payload_has_secret(payload: &[u8]) -> Result<bool, RedactionError> {
    detect_windowed_durable_bytes(payload)
}

/// Redacts input that fits the durable-text size limit.
///
/// Returns [`KernelError::InvalidInput`] when UTF-8 byte length exceeds
/// `MAX_REDACTABLE_BYTES`.
pub(super) fn redact(value: &str) -> Result<RedactedField, KernelError> {
    if value.len() > mc_core::redaction::MAX_REDACTABLE_BYTES {
        return Err(KernelError::InvalidInput);
    }
    Ok(redact_lossy(value))
}

/// Lookup keys, primary keys, and dedup identities must not contain detected secrets because redaction can alias distinct values.
pub(super) fn identity(value: &str) -> Result<String, KernelError> {
    let redaction = redact_durable_text(value);
    if redaction.detections.is_empty() {
        Ok(redaction.text)
    } else {
        Err(KernelError::InvalidInput)
    }
}

/// Inserts one metadata row per detection in ordinal order.
///
/// Detection offsets and lengths use UTF-8 byte units. Returns
/// [`KernelError::InvalidInput`] if an ordinal or coordinate cannot fit in
/// SQLite's signed integer representation, and maps database failures through
/// `map_sqlite`.
pub(super) fn record(
    tx: &Transaction<'_>,
    owner_kind: &str,
    owner_id: &str,
    field_name: &str,
    field: &RedactedField,
    commit_seq: Option<i64>,
) -> Result<(), KernelError> {
    for (ordinal, detection) in field.detections.iter().enumerate() {
        tx.execute_cached(
            "INSERT INTO durable_text_redactions(
                 owner_kind,owner_id,field_name,detection_ordinal,detector_id,secret_type,
                 source_utf8_offset,source_utf8_length,commit_seq
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                owner_kind,
                owner_id,
                field_name,
                i64::try_from(ordinal).map_err(|_| KernelError::InvalidInput)?,
                detection.detector_id,
                detection.secret_type,
                i64::try_from(detection.offset).map_err(|_| KernelError::InvalidInput)?,
                i64::try_from(detection.length).map_err(|_| KernelError::InvalidInput)?,
                commit_seq,
            ],
        )
        .map_err(map_sqlite)?;
    }
    Ok(())
}

/// A rewrite under a reused owner id collides with `(owner_kind,owner_id,field_name,detection_ordinal)` unless prior rows are cleared first.
pub(super) fn clear_owner_kind(tx: &Transaction<'_>, owner_kind: &str) -> Result<(), KernelError> {
    tx.execute_cached(
        "DELETE FROM durable_text_redactions WHERE owner_kind=?1",
        [owner_kind],
    )
    .map_err(map_sqlite)?;
    Ok(())
}

/// Clears one owner's rows so a reused owner id cannot collide with metadata left by a deleted predecessor.
pub(super) fn clear_owner(
    tx: &Transaction<'_>,
    owner_kind: &str,
    owner_id: &str,
) -> Result<(), KernelError> {
    tx.execute_cached(
        "DELETE FROM durable_text_redactions WHERE owner_kind=?1 AND owner_id=?2",
        [owner_kind, owner_id],
    )
    .map_err(map_sqlite)?;
    Ok(())
}
