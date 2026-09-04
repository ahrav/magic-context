use rusqlite::{Transaction, TransactionBehavior};

use super::{DecisionPayload, ObservationPayload};
use crate::{KernelError, KernelStore, Sensitivity};

/// Decision visible at a requested commit sequence.
///
/// Optional identifiers preserve nullable database relationships. `created_commit_seq` is the
/// sequence that introduced the row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionRow {
    pub decision_id: String,
    pub object_id: String,
    pub proposition_id: Option<String>,
    pub scope_id: Option<String>,
    pub anchor_id: Option<String>,
    pub evidence_id: Option<String>,
    pub decision_kind: String,
    pub payload: DecisionPayload,
    pub created_commit_seq: i64,
    pub sensitivity: Sensitivity,
}

/// Observation visible at a requested commit sequence.
///
/// `observed_at` is the stored observation timestamp. `created_commit_seq` orders the row in the
/// commit history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservationRow {
    pub observation_id: String,
    pub object_id: String,
    pub proposition_id: Option<String>,
    pub scope_id: Option<String>,
    pub anchor_id: Option<String>,
    pub evidence_id: Option<String>,
    pub observation_kind: String,
    pub payload: ObservationPayload,
    pub observed_at: i64,
    pub created_commit_seq: i64,
    pub sensitivity: Sensitivity,
}

/// Point-in-time decision and observation view.
///
/// Rows are ordered lexicographically by their IDs. `known_as_of` records the requested commit
/// sequence, while `tip` records the latest commit visible in the same read transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SliceSnapshot {
    pub known_as_of: i64,
    pub tip: i64,
    pub decisions: Vec<DecisionRow>,
    pub observations: Vec<ObservationRow>,
}

impl KernelStore {
    /// Reads decisions and observations live at `requested` from one deferred transaction.
    ///
    /// Returns [`KernelError::InvalidInput`] for a negative sequence,
    /// [`KernelError::FutureSnapshot`] when `requested` exceeds the transaction's current tip,
    /// [`KernelError::CorruptCanonicalRow`] for invalid stored JSON payloads, and
    /// [`KernelError::Io`] for lock, SQLite, conversion, or commit failures.
    pub fn slice_as_of(&self, requested: i64) -> Result<SliceSnapshot, KernelError> {
        let mut reader = self.lock_reader()?;
        let tx = reader
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(|_| KernelError::Io)?;
        let snapshot = load_slice(&tx, requested)?;
        tx.commit().map_err(|_| KernelError::Io)?;
        Ok(snapshot)
    }
}

/// Loads one snapshot from the caller's transaction so tip and rows share a database view.
pub(super) fn load_slice(
    tx: &Transaction<'_>,
    requested: i64,
) -> Result<SliceSnapshot, KernelError> {
    let tip = snapshot_tip(tx, requested)?;
    Ok(SliceSnapshot {
        known_as_of: requested,
        tip,
        decisions: load_decisions(tx, requested)?,
        observations: load_observations(tx, requested)?,
    })
}

/// Returns the transaction-visible tip after validating `requested` against the commit range.
pub(super) fn snapshot_tip(tx: &Transaction<'_>, requested: i64) -> Result<i64, KernelError> {
    if requested < 0 {
        return Err(KernelError::InvalidInput);
    }
    let tip = tx
        .query_row(
            "SELECT COALESCE(MAX(commit_seq),0) FROM commit_log",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| KernelError::Io)?;
    if requested > tip {
        return Err(KernelError::FutureSnapshot);
    }
    Ok(tip)
}

/// Loads decisions live at `requested`, ordered by `decision_id`.
pub(super) fn load_decisions(
    tx: &Transaction<'_>,
    requested: i64,
) -> Result<Vec<DecisionRow>, KernelError> {
    let mut statement = tx
        .prepare(
            "SELECT decision_id,object_id,proposition_id,scope_id,anchor_id,evidence_id,
                    decision_kind,decision_payload,created_commit_seq,
                    sensitivity_class
             FROM decisions
             WHERE created_commit_seq<=?1
               AND (invalidated_commit_seq IS NULL OR ?1<invalidated_commit_seq)
             ORDER BY decision_id",
        )
        .map_err(|_| KernelError::Io)?;
    let rows = statement
        .query_map([requested], |row| {
            let payload = row.get::<_, Vec<u8>>(7)?;
            let sensitivity = row.get::<_, String>(9)?;
            Ok(DecisionRow {
                decision_id: row.get(0)?,
                object_id: row.get(1)?,
                proposition_id: row.get(2)?,
                scope_id: row.get(3)?,
                anchor_id: row.get(4)?,
                evidence_id: row.get(5)?,
                decision_kind: row.get(6)?,
                payload: serde_json::from_slice(&payload).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        payload.len(),
                        rusqlite::types::Type::Blob,
                        Box::new(error),
                    )
                })?,
                created_commit_seq: row.get(8)?,
                sensitivity: Sensitivity::from_stored(&sensitivity),
            })
        })
        .map_err(|_| KernelError::Io)?
        .collect::<rusqlite::Result<_>>()
        .map_err(classify_row_error)?;
    Ok(rows)
}

/// Loads observations live at `requested`, ordered by `observation_id`.
pub(super) fn load_observations(
    tx: &Transaction<'_>,
    requested: i64,
) -> Result<Vec<ObservationRow>, KernelError> {
    let mut statement = tx
        .prepare(
            "SELECT observation_id,object_id,proposition_id,scope_id,anchor_id,evidence_id,
                    observation_kind,observation_payload,observed_at,created_commit_seq,
                    sensitivity_class
             FROM observations
             WHERE created_commit_seq<=?1
               AND (invalidated_commit_seq IS NULL OR ?1<invalidated_commit_seq)
             ORDER BY observation_id",
        )
        .map_err(|_| KernelError::Io)?;
    let rows = statement
        .query_map([requested], |row| {
            let payload = row.get::<_, Vec<u8>>(7)?;
            let sensitivity = row.get::<_, String>(10)?;
            Ok(ObservationRow {
                observation_id: row.get(0)?,
                object_id: row.get(1)?,
                proposition_id: row.get(2)?,
                scope_id: row.get(3)?,
                anchor_id: row.get(4)?,
                evidence_id: row.get(5)?,
                observation_kind: row.get(6)?,
                payload: serde_json::from_slice(&payload).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        payload.len(),
                        rusqlite::types::Type::Blob,
                        Box::new(error),
                    )
                })?,
                observed_at: row.get(8)?,
                created_commit_seq: row.get(9)?,
                sensitivity: Sensitivity::from_stored(&sensitivity),
            })
        })
        .map_err(|_| KernelError::Io)?
        .collect::<rusqlite::Result<_>>()
        .map_err(classify_row_error)?;
    Ok(rows)
}

// A `serde_json::Error` indicates non-transient stored-payload corruption; every
// other failure this query can raise is retriable.
fn classify_row_error(error: rusqlite::Error) -> KernelError {
    match &error {
        rusqlite::Error::FromSqlConversionFailure(_, _, source)
            if source.downcast_ref::<serde_json::Error>().is_some() =>
        {
            KernelError::CorruptCanonicalRow
        }
        _ => KernelError::Io,
    }
}
