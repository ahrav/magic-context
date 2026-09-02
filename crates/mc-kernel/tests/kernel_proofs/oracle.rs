//! Proofs that the canonical-state oracle discriminates: equal states digest
//! equal under the right profile, and each normalization step is exercised by
//! a negative control that would pass if the step were skipped.

use std::collections::BTreeSet;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use mc_kernel::schema::KERNEL_SCHEMA_COMPONENT_NAMES;
use mc_kernel::{BackupRequest, KernelStore, Sensitivity};
use rusqlite::{params, Connection};

use crate::canonical_state::{digest, digested_tables, Profile};
use crate::fixtures::{deletion, domain, ingest, intent, root_domain};

/// Seeds a domain, a registered consumer, two ingested artifacts, and two
/// deletions so every identity domain except capture pins has rows, and
/// barrier ids appear in relational columns and JSON payloads alike.
fn seed(root: &Path) -> KernelStore {
    let store = KernelStore::open(root).unwrap();
    store
        .commit(intent("domain"), |envelope| {
            envelope.insert_domain(root_domain())?;
            Ok("domain".to_string())
        })
        .unwrap();
    store
        .commit(intent("consumer"), |envelope| {
            envelope.register_outbox_consumer("search", 10)?;
            Ok("registered".to_string())
        })
        .unwrap();
    let first = store
        .ingest_artifact(ingest("first", b"first bytes", Sensitivity::Normal))
        .unwrap();
    let second = store
        .ingest_artifact(ingest("second", b"second bytes", Sensitivity::Normal))
        .unwrap();
    store
        .delete_artifact(deletion("delete-first", &first.digest))
        .unwrap();
    store
        .delete_artifact(deletion("delete-second", &second.digest))
        .unwrap();
    store
}

fn writable(root: &Path) -> Connection {
    let connection = Connection::open(root.join("core.sqlite")).unwrap();
    connection.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
    connection
}

fn barrier_ids(root: &Path) -> Vec<String> {
    writable(root)
        .prepare("SELECT barrier_id FROM deletion_backfill_barriers ORDER BY delete_commit_seq")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

/// Barrier consumer requirements are immutable under trigger, so swapping
/// which consumer row belongs to which barrier is a delete plus two inserts.
fn swap_consumer_rows(connection: &Connection, first: &str, second: &str) {
    let rows = connection
        .prepare(
            "SELECT barrier_id,consumer_id,required_checkpoint_commit_seq,acknowledged_at
             FROM deletion_backfill_barrier_consumers ORDER BY barrier_id",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(
        rows.len(),
        2,
        "positive control: one consumer row per barrier"
    );
    connection
        .execute("DELETE FROM deletion_backfill_barrier_consumers", [])
        .unwrap();
    for (barrier, consumer, required, acknowledged) in rows {
        let target = if barrier == first { second } else { first };
        connection
            .execute(
                "INSERT INTO deletion_backfill_barrier_consumers(
                     barrier_id,consumer_id,required_checkpoint_commit_seq,acknowledged_at
                 ) VALUES (?1,?2,?3,?4)",
                params![target, consumer, required, acknowledged],
            )
            .unwrap();
    }
}

fn last_recorded_at(root: &Path) -> i64 {
    writable(root)
        .query_row("SELECT MAX(recorded_at) FROM commit_log", [], |row| {
            row.get(0)
        })
        .unwrap()
}

fn backup(store: &KernelStore, expires_at: Option<i64>) {
    let destination = tempfile::tempdir().unwrap();
    std::fs::set_permissions(destination.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    store
        .backup(BackupRequest {
            destination_directory: destination.path().to_path_buf(),
            deadline: Instant::now() + Duration::from_secs(30),
            capture_pin_expires_at: expires_at,
        })
        .unwrap();
}

#[test]
fn cross_root_capture_pins_compare_by_expiry_presence_not_instant() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let mut stores = Vec::new();
    for root in [first.path(), second.path()] {
        let store = seed(root);
        // A live reference is what a backup pins; the seed deleted both of
        // its artifacts, so one more is ingested and kept.
        store
            .ingest_artifact(ingest("kept", b"kept bytes", Sensitivity::Normal))
            .unwrap();
        // Two pins per root, minted at different commits, one with an expiry
        // and one without; the second root's stamps differ by wall clock.
        backup(&store, None);
        store
            .commit(intent("domain-2"), |envelope| {
                envelope.insert_domain(domain(2))?;
                Ok("domain".to_string())
            })
            .unwrap();
        backup(&store, Some(i64::MAX / 2));
        thread::sleep(Duration::from_millis(3));
        stores.push(store);
    }
    let expected = digest(first.path(), Profile::CrossRoot);
    assert_eq!(digest(second.path(), Profile::CrossRoot), expected);
    assert_ne!(
        digest(first.path(), Profile::SameRoot).table("capture_pins"),
        digest(second.path(), Profile::SameRoot).table("capture_pins"),
        "positive control: pin ids and stamps differ between roots"
    );
    drop(stores);
    // Removing the expiry from the pin that had one changes a caller-chosen
    // contract, so the digests must diverge even though the instant itself
    // is never compared.
    writable(second.path())
        .execute(
            "UPDATE capture_pins SET expires_at=NULL WHERE expires_at IS NOT NULL",
            [],
        )
        .unwrap();
    let mutated = digest(second.path(), Profile::CrossRoot);
    assert_ne!(mutated, expected);
    assert_ne!(
        mutated.table("capture_pins"),
        expected.table("capture_pins")
    );
}

#[test]
fn same_root_digest_survives_reopen_and_detects_one_insert() {
    let root = tempfile::tempdir().unwrap();
    let store = seed(root.path());
    let before = digest(root.path(), Profile::SameRoot);
    drop(store);
    let reopened = KernelStore::open(root.path()).unwrap();
    assert_eq!(digest(root.path(), Profile::SameRoot), before);
    reopened
        .commit(intent("domain-2"), |envelope| {
            envelope.insert_domain(domain(2))?;
            Ok("domain".to_string())
        })
        .unwrap();
    let after = digest(root.path(), Profile::SameRoot);
    assert_ne!(after, before);
    assert_ne!(after.table("domains"), before.table("domains"));
}

#[test]
fn identical_histories_in_two_roots_agree_cross_root_and_differ_same_root() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let _first_store = seed(first.path());
    // Distinct wall-clock stamps make every volatile column actually differ,
    // so an omission from the drop list cannot pass by timestamp coincidence.
    thread::sleep(Duration::from_millis(3));
    let _second_store = seed(second.path());
    assert_ne!(
        last_recorded_at(first.path()),
        last_recorded_at(second.path()),
        "positive control: wall-clock stamps differ between roots"
    );
    assert_eq!(
        digest(first.path(), Profile::CrossRoot),
        digest(second.path(), Profile::CrossRoot)
    );
    let same_first = digest(first.path(), Profile::SameRoot);
    let same_second = digest(second.path(), Profile::SameRoot);
    assert_ne!(same_first, same_second);
    assert_ne!(
        same_first.table("mc_kernel_format_marker"),
        same_second.table("mc_kernel_format_marker")
    );
    assert_ne!(
        same_first.table("deletion_backfill_barriers"),
        same_second.table("deletion_backfill_barriers")
    );
}

#[test]
fn cross_root_rename_keeps_cardinality_swaps_and_payload_references() {
    let reference = tempfile::tempdir().unwrap();
    let _reference_store = seed(reference.path());
    let expected = digest(reference.path(), Profile::CrossRoot);

    // Merging two barrier identities into one makes every payload reference
    // name the first barrier; a placeholder rename would erase the difference.
    let merged = tempfile::tempdir().unwrap();
    let store = seed(merged.path());
    drop(store);
    let ids = barrier_ids(merged.path());
    assert_eq!(ids.len(), 2, "positive control: two barriers minted");
    let connection = writable(merged.path());
    connection
        .execute(
            "UPDATE outbox SET payload=CAST(replace(CAST(payload AS TEXT),?1,?2) AS BLOB)",
            params![ids[1], ids[0]],
        )
        .unwrap();
    assert_ne!(digest(merged.path(), Profile::CrossRoot), expected);

    // Swapping which consumer row points at which barrier keeps cardinality
    // but changes the reference structure.
    let swapped = tempfile::tempdir().unwrap();
    let store = seed(swapped.path());
    drop(store);
    let ids = barrier_ids(swapped.path());
    let connection = writable(swapped.path());
    swap_consumer_rows(&connection, &ids[0], &ids[1]);
    assert_ne!(digest(swapped.path(), Profile::CrossRoot), expected);

    // Dropping the JSON payload reference leaves relational rows intact but
    // the outbox payload no longer names the barrier.
    let stripped = tempfile::tempdir().unwrap();
    let store = seed(stripped.path());
    drop(store);
    let connection = writable(stripped.path());
    connection
        .execute(
            "UPDATE outbox SET payload=CAST(json_remove(CAST(payload AS TEXT),'$.audit.barrier_id') AS BLOB)
             WHERE json_extract(CAST(payload AS TEXT),'$.audit.barrier_id') IS NOT NULL",
            [],
        )
        .unwrap();
    assert_ne!(digest(stripped.path(), Profile::CrossRoot), expected);
}

#[test]
#[should_panic(expected = "references an identity no defining row declares")]
fn cross_root_digest_refuses_an_unresolved_identity_reference() {
    let root = tempfile::tempdir().unwrap();
    let store = seed(root.path());
    drop(store);
    let ids = barrier_ids(root.path());
    let connection = writable(root.path());
    // Rewriting the counter yields a barrier-shaped token no defining row
    // declares; the payload now references an identity that does not exist.
    connection
        .execute(
            "UPDATE outbox SET payload=CAST(replace(CAST(payload AS TEXT),?1,?2) AS BLOB)",
            params![ids[0], format!("{}0", ids[0])],
        )
        .unwrap();
    digest(root.path(), Profile::CrossRoot);
}

#[test]
fn digested_table_set_equals_schema_inventory() {
    let root = tempfile::tempdir().unwrap();
    let _store = KernelStore::open(root.path()).unwrap();
    let declared = KERNEL_SCHEMA_COMPONENT_NAMES
        .iter()
        .map(|name| name.to_string())
        .collect::<BTreeSet<_>>();
    assert_eq!(digested_tables(root.path()), declared);
    let digested = digest(root.path(), Profile::SameRoot);
    let mut keys = digested.tables.keys().cloned().collect::<BTreeSet<_>>();
    assert!(keys.remove("cas_objects"));
    assert_eq!(keys, declared);
}
