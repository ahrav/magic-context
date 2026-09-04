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

    /// Query work scales with `object_ids`, not the store's total decision count.
    ///
    /// Object IDs are queried in chunks of [`DECISION_LOOKUP_CHUNK`] to stay within SQLite's bound-variable limit.
    /// Every chunk runs in the same deferred transaction, so all rows share one database view.
    /// Result order is unspecified; callers key rows by `object_id`.
    /// An empty id list returns an empty vector without opening a transaction.
    ///
    /// Returns [`KernelError::InvalidInput`] for a negative sequence,
    /// [`KernelError::FutureSnapshot`] when `requested` exceeds the transaction's current tip,
    /// [`KernelError::CorruptCanonicalRow`] for invalid stored JSON payloads, and
    /// [`KernelError::Io`] for lock, SQLite, conversion, or commit failures.
    pub fn decisions_for_objects_as_of(
        &self,
        object_ids: &[String],
        requested: i64,
    ) -> Result<Vec<DecisionRow>, KernelError> {
        if object_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut reader = self.lock_reader()?;
        let tx = reader
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(|_| KernelError::Io)?;
        snapshot_tip(&tx, requested)?;
        let mut rows = Vec::new();
        for chunk in object_ids.chunks(DECISION_LOOKUP_CHUNK) {
            rows.extend(load_decisions_for_objects(&tx, requested, chunk)?);
        }
        tx.commit().map_err(|_| KernelError::Io)?;
        Ok(rows)
    }

    /// Returns decision-payload sizes in bytes at snapshot `requested`, keyed by `object_id`: the query reads `length(decision_payload)` only, so a caller can bound how many full payloads it materializes before asking for any of them. commentlint: allow(JUDGE)
    ///
    /// Uses the same chunking, snapshot, and error semantics as [`Self::decisions_for_objects_as_of`]; no payload is parsed, so [`KernelError::CorruptCanonicalRow`] is never returned. commentlint: allow(JUDGE)
    pub fn decision_payload_sizes_as_of(
        &self,
        object_ids: &[String],
        requested: i64,
    ) -> Result<Vec<(String, u64)>, KernelError> {
        if object_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut reader = self.lock_reader()?;
        let tx = reader
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(|_| KernelError::Io)?;
        snapshot_tip(&tx, requested)?;
        let mut sizes = Vec::new();
        for chunk in object_ids.chunks(DECISION_LOOKUP_CHUNK) {
            sizes.extend(load_decision_payload_sizes(&tx, requested, chunk)?);
        }
        tx.commit().map_err(|_| KernelError::Io)?;
        Ok(sizes)
    }
}

/// Object identifiers bound per `IN (...)` query. SQLite permits at most 32766
/// parameters; one is reserved for the sequence in `?1`.
const DECISION_LOOKUP_CHUNK: usize = 500;

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
        .query_map([requested], decision_row_from)
        .map_err(|_| KernelError::Io)?
        .collect::<rusqlite::Result<_>>()
        .map_err(classify_row_error)?;
    Ok(rows)
}

/// Same live-at-`requested` predicate as [`load_decisions`], restricted to `object_ids`.
/// Result order is unspecified. Placeholders start at `?2` because `?1` carries the sequence.
fn load_decisions_for_objects(
    tx: &Transaction<'_>,
    requested: i64,
    object_ids: &[String],
) -> Result<Vec<DecisionRow>, KernelError> {
    let placeholders = (0..object_ids.len())
        .map(|index| format!("?{}", index + 2))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT decision_id,object_id,proposition_id,scope_id,anchor_id,evidence_id,
                decision_kind,decision_payload,created_commit_seq,
                sensitivity_class
         FROM decisions
         WHERE created_commit_seq<=?1
           AND (invalidated_commit_seq IS NULL OR ?1<invalidated_commit_seq)
           AND object_id IN ({placeholders})"
    );
    let mut statement = tx.prepare(&sql).map_err(|_| KernelError::Io)?;
    let params = std::iter::once(rusqlite::types::Value::Integer(requested)).chain(
        object_ids
            .iter()
            .map(|id| rusqlite::types::Value::Text(id.clone())),
    );
    let rows = statement
        .query_map(rusqlite::params_from_iter(params), decision_row_from)
        .map_err(|_| KernelError::Io)?
        .collect::<rusqlite::Result<_>>()
        .map_err(classify_row_error)?;
    Ok(rows)
}

/// Shares `load_decisions_for_objects`'s visibility predicate so a size row exists exactly when the full decision row would. commentlint: allow(JUDGE)
fn load_decision_payload_sizes(
    tx: &Transaction<'_>,
    requested: i64,
    object_ids: &[String],
) -> Result<Vec<(String, u64)>, KernelError> {
    let placeholders = (0..object_ids.len())
        .map(|index| format!("?{}", index + 2))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT object_id, length(decision_payload)
         FROM decisions
         WHERE created_commit_seq<=?1
           AND (invalidated_commit_seq IS NULL OR ?1<invalidated_commit_seq)
           AND object_id IN ({placeholders})"
    );
    let mut statement = tx.prepare(&sql).map_err(|_| KernelError::Io)?;
    let params = std::iter::once(rusqlite::types::Value::Integer(requested)).chain(
        object_ids
            .iter()
            .map(|id| rusqlite::types::Value::Text(id.clone())),
    );
    let sizes = statement
        .query_map(rusqlite::params_from_iter(params), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?.max(0) as u64,
            ))
        })
        .map_err(|_| KernelError::Io)?
        .collect::<rusqlite::Result<_>>()
        .map_err(|_| KernelError::Io)?;
    Ok(sizes)
}

/// Column order matches the shared decision-loader SELECT list.
fn decision_row_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<DecisionRow> {
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
