use rusqlite::{params, Transaction};

use super::envelope::ObjectRow;
use super::redaction::{record, RedactedField};
use super::KernelError;

pub(super) fn map_write_error(error: rusqlite::Error) -> KernelError {
    super::map_sqlite(error)
}

pub(super) fn insert_registry(
    tx: &Transaction<'_>,
    commit_seq: i64,
    object: &ObjectRow,
) -> Result<(), KernelError> {
    tx.execute(
        "INSERT INTO object_registry(
             object_id,object_kind,domain_id,source_kind,source_id,source_revision,
             created_commit_seq,sensitivity_class
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            object.object_id,
            object.object_kind,
            object.domain_id,
            object.source_kind,
            object.source_id,
            object.source_revision,
            commit_seq,
            object.sensitivity.as_str(),
        ],
    )
    .map(|_| ())
    .map_err(map_write_error)
}

pub(super) fn record_registry_fields(
    tx: &Transaction<'_>,
    owner_id: &str,
    domain_id: &RedactedField,
    object_id: &RedactedField,
    source_kind: &RedactedField,
    source_id: &RedactedField,
    commit_seq: i64,
) -> Result<(), KernelError> {
    record_fields(
        tx,
        "object_registry",
        owner_id,
        &[
            ("domain_id".to_string(), domain_id.clone()),
            ("object_id".to_string(), object_id.clone()),
            ("source_kind".to_string(), source_kind.clone()),
            ("source_id".to_string(), source_id.clone()),
        ],
        commit_seq,
    )
}

pub(super) fn record_fields(
    tx: &Transaction<'_>,
    owner_kind: &str,
    owner_id: &str,
    fields: &[(String, RedactedField)],
    commit_seq: i64,
) -> Result<(), KernelError> {
    for (name, field) in fields {
        record(tx, owner_kind, owner_id, name, field, Some(commit_seq))?;
    }
    Ok(())
}

/// Invalidation requires exactly one live row in both the registry and typed
/// table.
pub(super) fn invalidate(
    tx: &Transaction<'_>,
    commit_seq: i64,
    table: &str,
    column: &str,
    object_id: &str,
) -> Result<(), KernelError> {
    let changed = tx
        .execute(
            "UPDATE object_registry SET invalidated_commit_seq=?1
             WHERE object_id=?2 AND invalidated_commit_seq IS NULL",
            params![commit_seq, object_id],
        )
        .map_err(map_write_error)?;
    if changed != 1 {
        return Err(KernelError::NotFound);
    }
    let sql = format!(
        "UPDATE {table} SET invalidated_commit_seq=?1
         WHERE {column}=?2 AND invalidated_commit_seq IS NULL"
    );
    if tx
        .execute(&sql, params![commit_seq, object_id])
        .map_err(map_write_error)?
        != 1
    {
        return Err(KernelError::NotFound);
    }
    Ok(())
}

pub(super) fn set_successor(
    tx: &Transaction<'_>,
    table: &str,
    old_object_id: &str,
    new_object_id: &str,
) -> Result<(), KernelError> {
    tx.execute(
        "UPDATE object_registry SET superseded_by=?1 WHERE object_id=?2",
        params![new_object_id, old_object_id],
    )
    .map_err(map_write_error)?;
    let sql = format!("UPDATE {table} SET superseded_by=?1 WHERE object_id=?2");
    tx.execute(&sql, params![new_object_id, old_object_id])
        .map_err(map_write_error)?;
    Ok(())
}
