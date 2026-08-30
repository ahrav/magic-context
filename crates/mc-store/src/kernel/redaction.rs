use mc_core::redaction::{redact_secret_text, Detection};
use rusqlite::{params, Transaction};

use super::KernelError;

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
                 utf8_offset,utf8_length,commit_seq
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
        .map_err(|_| KernelError::Io)?;
    }
    Ok(())
}
