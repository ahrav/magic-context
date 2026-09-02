//! The all-zero atomicity oracle requires a count for every scan-audit table.

#![allow(dead_code)]

use std::path::Path;

use rusqlite::Connection;

/// Row counts for every table participating in scan-audit atomicity checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScanAuditCounts {
    pub batches: i64,
    pub owner_scopes: i64,
    pub domain_owners: i64,
    pub field_scans: i64,
    pub owner_copies: i64,
    pub detections: i64,
}

impl ScanAuditCounts {
    /// Expected state when no scan-audit transaction has committed.
    pub const EMPTY: Self = Self {
        batches: 0,
        owner_scopes: 0,
        domain_owners: 0,
        field_scans: 0,
        owner_copies: 0,
        detections: 0,
    };
}

/// Reads all counts from one SQLite statement and snapshot.
///
/// # Panics
///
/// Panics when `store.db` cannot be opened, the query fails, or a count cannot
/// be decoded as `i64`.
pub fn scan_audit_counts(root: &Path) -> ScanAuditCounts {
    Connection::open(root.join("store.db"))
        .unwrap()
        .query_row(
            "SELECT
                 (SELECT COUNT(*) FROM mc_scan_batches),
                 (SELECT COUNT(*) FROM mc_scan_owner_scopes),
                 (SELECT COUNT(*) FROM mc_scan_domain_owners),
                 (SELECT COUNT(*) FROM mc_field_scans),
                 (SELECT COUNT(*) FROM mc_scan_owner_copies),
                 (SELECT COUNT(*) FROM mc_scan_detections)",
            [],
            |row| {
                Ok(ScanAuditCounts {
                    batches: row.get(0)?,
                    owner_scopes: row.get(1)?,
                    domain_owners: row.get(2)?,
                    field_scans: row.get(3)?,
                    owner_copies: row.get(4)?,
                    detections: row.get(5)?,
                })
            },
        )
        .unwrap()
}
