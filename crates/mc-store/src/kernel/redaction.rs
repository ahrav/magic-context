use std::sync::{Arc, OnceLock};

use mc_core::redaction::{
    redact_durable_text, redact_transaction_durable_text, Detection, DetectionAction,
    DetectionExactness, DetectionSpanKind, RedactionErrorKind, ScanProvenance,
};
use rusqlite::{params, Transaction};

use super::KernelError;

#[derive(Clone)]
pub(super) struct RedactedField {
    pub text: String,
    pub(super) detections: Vec<Detection>,
    provenance: Option<ScanProvenance>,
    scan_id: Arc<OnceLock<String>>,
}

pub(super) fn redact(value: &str) -> Result<RedactedField, KernelError> {
    let redaction =
        redact_durable_text(value).map_err(|error| KernelError::Redaction(error.kind()))?;
    Ok(RedactedField::scanned(redaction))
}

pub(super) fn redact_transaction(value: &str) -> Result<RedactedField, KernelError> {
    let redaction = redact_transaction_durable_text(value)
        .map_err(|error| KernelError::Redaction(error.kind()))?;
    Ok(RedactedField::scanned(redaction))
}

pub(super) fn reject(value: &str) -> Result<RedactedField, KernelError> {
    let field = redact(value)?;
    if field.detections.is_empty() {
        Ok(field)
    } else {
        Err(KernelError::Redaction(RedactionErrorKind::SecretDetected))
    }
}

pub(super) fn exact_unscanned(value: &str) -> RedactedField {
    RedactedField {
        text: value.to_string(),
        detections: Vec::new(),
        provenance: None,
        scan_id: Arc::new(OnceLock::new()),
    }
}

impl RedactedField {
    fn scanned(redaction: mc_core::redaction::Redaction) -> Self {
        Self {
            text: redaction.text,
            detections: redaction.detections,
            provenance: Some(redaction.provenance),
            scan_id: Arc::new(OnceLock::new()),
        }
    }
}

pub(super) fn create_batch(tx: &Transaction<'_>, commit_seq: i64) -> Result<String, KernelError> {
    insert_batch(tx, Some(commit_seq))
}

pub(super) fn create_standalone_batch(tx: &Transaction<'_>) -> Result<String, KernelError> {
    insert_batch(tx, None)
}

fn insert_batch(tx: &Transaction<'_>, commit_seq: Option<i64>) -> Result<String, KernelError> {
    let batch_id = opaque_id(tx)?;
    tx.execute(
        "INSERT INTO scan_batches(scan_batch_id,commit_seq,created_at) VALUES(?1,?2,?3)",
        params![batch_id, commit_seq, super::envelope::current_time_ms()],
    )
    .map_err(|_| KernelError::Io)?;
    Ok(batch_id)
}

pub(super) fn record(
    tx: &Transaction<'_>,
    owner_kind: &str,
    field_id: &str,
    field: &RedactedField,
    commit_seq: Option<i64>,
    standalone_batch_id: Option<&str>,
) -> Result<(), KernelError> {
    let Some(provenance) = &field.provenance else {
        return Ok(());
    };
    let scan_id = if let Some(scan_id) = field.scan_id.get() {
        scan_id.clone()
    } else {
        let batch_id = match commit_seq {
            Some(commit_seq) => tx
                .query_row(
                    "SELECT scan_batch_id FROM scan_batches WHERE commit_seq=?1",
                    [commit_seq],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|_| KernelError::Io)?,
            None => standalone_batch_id
                .ok_or(KernelError::InvalidInput)?
                .to_string(),
        };
        let scan_id = opaque_id(tx)?;
        let semantic_digest = provenance.semantic_digest.map(hex_digest);
        tx.execute(
            "INSERT INTO field_scans(
                 scan_id,scan_batch_id,detector_id,detector_revision,semantic_digest,finding_count
             ) VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                scan_id,
                batch_id,
                provenance.detector_id,
                provenance.detector_revision,
                semantic_digest,
                i64::try_from(field.detections.len()).map_err(|_| KernelError::InvalidInput)?,
            ],
        )
        .map_err(|_| KernelError::Io)?;
        for (ordinal, detection) in field.detections.iter().enumerate() {
            tx.execute(
                "INSERT INTO scan_detections(
                     scan_id,detection_ordinal,rule_id,detector_revision,exactness,label_id,
                     span_kind,action
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    scan_id,
                    i64::try_from(ordinal).map_err(|_| KernelError::InvalidInput)?,
                    detection.rule_id,
                    detection.detector_revision,
                    exactness_id(detection.exactness),
                    detection.secret_type,
                    span_kind_id(detection.span_kind),
                    action_id(detection.action),
                ],
            )
            .map_err(|_| KernelError::Io)?;
        }
        field
            .scan_id
            .set(scan_id.clone())
            .map_err(|_| KernelError::Io)?;
        scan_id
    };
    tx.execute(
        "INSERT INTO scan_owner_copies(
             owner_copy_id,scan_id,owner_kind,field_id,owner_commit_seq
         ) VALUES(?1,?2,?3,?4,?5)",
        params![opaque_id(tx)?, scan_id, owner_kind, field_id, commit_seq],
    )
    .map_err(|_| KernelError::Io)?;
    Ok(())
}

fn opaque_id(tx: &Transaction<'_>) -> Result<String, KernelError> {
    tx.query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))
        .map_err(|_| KernelError::Io)
}

fn hex_digest(bytes: [u8; 32]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

const fn exactness_id(value: DetectionExactness) -> &'static str {
    match value {
        DetectionExactness::Exact => "exact",
    }
}

const fn span_kind_id(value: DetectionSpanKind) -> &'static str {
    match value {
        DetectionSpanKind::Value => "value",
    }
}

const fn action_id(value: DetectionAction) -> &'static str {
    match value {
        DetectionAction::Substitute => "substitute",
    }
}
