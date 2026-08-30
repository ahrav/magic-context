use mc_core::redaction::{redact_secret_text, Detection};
use rusqlite::{params, Transaction};

use super::{map_sqlite, KernelError};

#[derive(Clone)]
pub(super) struct RedactedField {
    pub text: String,
    pub detections: Vec<Detection>,
}

pub(super) fn redact(value: &str) -> RedactedField {
    let redaction = redact_secret_text(value);
    RedactedField {
        text: redaction.text,
        detections: redaction.detections,
    }
}

/// Lookup keys, primary keys, and dedup identities must not contain detected secrets because redaction can alias distinct values. commentlint: allow(JUDGE)
pub(super) fn identity(value: &str) -> Result<String, KernelError> {
    let redaction = redact_secret_text(value);
    if redaction.detections.is_empty() {
        Ok(redaction.text)
    } else {
        Err(KernelError::InvalidInput)
    }
}

pub(super) fn record(
    tx: &Transaction<'_>,
    owner_kind: &str,
    owner_id: &str,
    field_name: &str,
    field: &RedactedField,
    commit_seq: Option<i64>,
) -> Result<(), KernelError> {
    for (ordinal, detection) in field.detections.iter().enumerate() {
        tx.execute(
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

/// Clears an owner_kind so a rewrite cannot collide with the `(owner_kind,owner_id,field_name,detection_ordinal)` primary key. commentlint: allow(JUDGE)
pub(super) fn clear_owner_kind(tx: &Transaction<'_>, owner_kind: &str) -> Result<(), KernelError> {
    tx.execute(
        "DELETE FROM durable_text_redactions WHERE owner_kind=?1",
        [owner_kind],
    )
    .map_err(map_sqlite)?;
    Ok(())
}
