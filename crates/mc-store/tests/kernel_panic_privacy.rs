#![cfg(feature = "test-support")]

use std::{fs, process::Command};

use rusqlite::{Connection, OpenFlags};

const SENTINEL: &str = "password=panic-privacy-sentinel";

#[test]
fn unwind_and_abort_emit_no_input_and_rollback_real_replacement_path() {
    for mode in ["unwind", "abort"] {
        let directory = tempfile::tempdir().unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_mc-store-panic-probe"))
            .arg(directory.path())
            .arg(mode)
            .env("MC_PANIC_PROBE_INPUT", SENTINEL)
            .output()
            .unwrap();
        assert!(!output.status.success(), "{mode}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!stderr.contains(SENTINEL), "{mode}: {stderr}");
        assert_eq!(
            fs::read_to_string(directory.path().join("replacement-path-reached")).unwrap(),
            "replacement path reached",
            "{mode}: probe did not reach production replacement path"
        );

        for entry in fs::read_dir(directory.path()).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_file() {
                let bytes = fs::read(entry.path()).unwrap();
                assert!(
                    !bytes
                        .windows(SENTINEL.len())
                        .any(|window| window == SENTINEL.as_bytes()),
                    "{mode}: sentinel persisted in {}",
                    entry.path().display()
                );
            }
        }

        let connection = Connection::open_with_flags(
            directory.path().join("core.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM commit_log", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1,
            "{mode}: crashing replacement commit became visible"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM operation_receipts", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1,
            "{mode}: crashing replacement receipt became visible"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM domains WHERE object_id='object-1' AND superseded_by IS NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1,
            "{mode}: source object was altered"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM domains WHERE object_id='object-2'",
                    [],
                    |row| { row.get::<_, i64>(0) }
                )
                .unwrap(),
            0,
            "{mode}: replacement object became visible"
        );
    }
}
