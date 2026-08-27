use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use magic_context_dashboard_lib::db;
use magic_context_dashboard_lib::workspaces;
use rusqlite::{params, Connection};

static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn make_db_with_workspace_schema(version: i64, include_share_categories: bool) -> Connection {
    let conn = Connection::open_in_memory().expect("open");
    let share_column = if include_share_categories {
        ",\n              share_categories TEXT NOT NULL DEFAULT '[\"CONSTRAINTS\"]'"
    } else {
        ""
    };
    let sql = format!(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
         INSERT INTO schema_migrations (version) VALUES ({version});
         CREATE TABLE projects (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             canonical_identity TEXT NOT NULL UNIQUE
         );
         CREATE TABLE claim_memory_current_heads (
             claim_id INTEGER PRIMARY KEY,
             project_id INTEGER NOT NULL,
             lifecycle_state TEXT NOT NULL
         );
         CREATE TABLE project_state (
             project_path TEXT PRIMARY KEY,
             project_memory_epoch INTEGER NOT NULL DEFAULT 0,
             project_user_profile_version INTEGER NOT NULL DEFAULT 0,
             updated_at INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE workspaces (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             name TEXT NOT NULL UNIQUE,
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL{share_column}
         );
         CREATE TABLE workspace_members (
             workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
             project_path TEXT NOT NULL,
             display_name TEXT NOT NULL,
             display_path TEXT NOT NULL,
             added_at INTEGER NOT NULL,
             PRIMARY KEY (workspace_id, project_path)
         );
         CREATE UNIQUE INDEX idx_workspace_member_unique ON workspace_members(project_path);
         CREATE UNIQUE INDEX idx_workspace_member_name ON workspace_members(workspace_id, display_name);"
    );
    conn.execute_batch(&sql).expect("schema");
    workspaces::clear_workspace_schema_ready_cache_for_tests();
    conn
}

fn make_db_v35() -> Connection {
    make_db_with_workspace_schema(35, true)
}

fn make_db_v34() -> Connection {
    make_db_with_workspace_schema(34, false)
}

fn make_db_v35_missing_share_column() -> Connection {
    make_db_with_workspace_schema(35, false)
}

fn make_db_fork_only() -> Connection {
    make_db_with_workspace_schema(10_000, true)
}

fn make_db_pre_v34() -> Connection {
    let conn = Connection::open_in_memory().expect("open");
    conn.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
         INSERT INTO schema_migrations (version) VALUES (33);
         CREATE TABLE project_state (
             project_path TEXT PRIMARY KEY,
             project_memory_epoch INTEGER NOT NULL DEFAULT 0,
             project_user_profile_version INTEGER NOT NULL DEFAULT 0,
             updated_at INTEGER NOT NULL DEFAULT 0
         );",
    )
    .expect("schema");
    workspaces::clear_workspace_schema_ready_cache_for_tests();
    conn
}

fn seed_epoch(conn: &Connection, project: &str, epoch: i64) {
    conn.execute(
        "INSERT INTO project_state (project_path, project_memory_epoch, project_user_profile_version, updated_at)
         VALUES (?1, ?2, 0, 0)",
        params![project, epoch],
    )
    .expect("seed");
}

fn epoch(conn: &Connection, project: &str) -> i64 {
    conn.query_row(
        "SELECT project_memory_epoch FROM project_state WHERE project_path = ?1",
        params![project],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

fn add(
    project_path: &str,
    display_name: &str,
    display_path: &str,
) -> workspaces::WorkspaceMemberChange {
    workspaces::WorkspaceMemberChange {
        project_path: project_path.to_string(),
        display_name: display_name.to_string(),
        display_path: display_path.to_string(),
    }
}

fn set_name(project_path: &str, display_name: &str) -> workspaces::WorkspaceDisplayNameChange {
    workspaces::WorkspaceDisplayNameChange {
        project_path: project_path.to_string(),
        display_name: display_name.to_string(),
    }
}

fn default_share_categories() -> Vec<String> {
    vec!["CONSTRAINTS".to_string()]
}

fn apply_add_member(
    conn: &mut Connection,
    workspace_id: i64,
    project_path: &str,
    display_name: &str,
    display_path: &str,
) {
    workspaces::apply_workspace_changes(
        conn,
        workspace_id,
        None,
        vec![add(project_path, display_name, display_path)],
        Vec::new(),
        Vec::new(),
        default_share_categories(),
    )
    .expect("add member");
}

fn seed_workspace(conn: &Connection, name: &str) -> i64 {
    conn.execute(
        "INSERT INTO workspaces (name, created_at, updated_at) VALUES (?1, 0, 0)",
        params![name],
    )
    .expect("seed workspace");
    conn.last_insert_rowid()
}

fn seed_workspace_member(
    conn: &Connection,
    workspace_id: i64,
    project_path: &str,
    display_name: &str,
    display_path: &str,
) {
    conn.execute(
        "INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
         VALUES (?1, ?2, ?3, ?4, 0)",
        params![workspace_id, project_path, display_name, display_path],
    )
    .expect("seed member");
}

#[test]
fn workspace_schema_ready_false_before_v34() {
    let _g = env_lock();
    let conn = make_db_pre_v34();
    assert!(!workspaces::workspace_schema_ready(&conn).unwrap());
    assert!(workspaces::list_workspaces(&conn).unwrap().is_empty());
}

#[test]
fn workspace_schema_ready_false_at_v34_without_share_column() {
    let _g = env_lock();
    let conn = make_db_v34();
    assert!(!workspaces::workspace_schema_ready(&conn).unwrap());
    assert!(workspaces::list_workspaces(&conn).unwrap().is_empty());
}

#[test]
fn workspace_schema_ready_requires_share_categories_column() {
    let _g = env_lock();
    let conn = make_db_v35_missing_share_column();
    assert!(!workspaces::workspace_schema_ready(&conn).unwrap());
}

#[test]
fn workspace_schema_ready_true_at_v35() {
    let _g = env_lock();
    let conn = make_db_v35();
    assert!(workspaces::workspace_schema_ready(&conn).unwrap());
}

#[test]
fn workspace_schema_ready_ignores_fork_rows_until_upstream_migration_arrives() {
    let _g = env_lock();
    let conn = make_db_fork_only();
    assert!(!workspaces::workspace_schema_ready(&conn).unwrap());

    conn.execute(
        "INSERT INTO schema_migrations (version) VALUES (?1)",
        params![35_i64],
    )
    .expect("seed upstream migration");
    workspaces::clear_workspace_schema_ready_cache_for_tests();
    assert!(workspaces::workspace_schema_ready(&conn).unwrap());
}

#[test]
fn workspace_crud_round_trip() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    let id = workspaces::create_workspace(&mut conn, "  team-alpha  ").expect("create");
    let list = workspaces::list_workspaces(&conn).expect("list");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "team-alpha");
    assert_eq!(list[0].id, id);
    assert_eq!(list[0].share_categories, default_share_categories());

    workspaces::rename_workspace(&mut conn, id, "team-beta").expect("rename");
    let list = workspaces::list_workspaces(&conn).expect("list");
    assert_eq!(list[0].name, "team-beta");

    workspaces::delete_workspace(&mut conn, id).expect("delete");
    assert!(workspaces::list_workspaces(&conn).unwrap().is_empty());
}

#[test]
fn workspace_refuses_the_user_home_directory() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    let ws = seed_workspace(&conn, "pool");
    let home = std::fs::canonicalize(dirs::home_dir().expect("user home")).expect("canonical home");
    let digest = format!("{:x}", md5::compute(home.to_string_lossy().as_bytes()));
    let home_identity = format!("dir:{}", &digest[..12]);

    let err = workspaces::apply_workspace_changes(
        &mut conn,
        ws,
        None,
        vec![add(
            &home_identity,
            "home",
            home.to_str().expect("utf8 home path"),
        )],
        Vec::new(),
        Vec::new(),
        default_share_categories(),
    )
    .expect_err("home projects must not join workspaces");

    assert!(err
        .to_string()
        .contains("home directory cannot be added to a workspace"));
}

#[test]
fn list_workspaces_returns_normalized_share_categories() {
    let _g = env_lock();
    let conn = make_db_v35();
    let ws = seed_workspace(&conn, "w");
    conn.execute(
        "UPDATE workspaces SET share_categories = ?1 WHERE id = ?2",
        params!["[\"NAMING\",\"CONSTRAINTS\",\"NAMING\"]", ws],
    )
    .unwrap();

    let list = workspaces::list_workspaces(&conn).unwrap();
    assert_eq!(
        list[0].share_categories,
        vec!["CONSTRAINTS".to_string(), "NAMING".to_string()]
    );
}

#[test]
fn apply_workspace_changes_multiple_add_remove_single_epoch_fanout() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    seed_epoch(&conn, "git:a", 10);
    seed_epoch(&conn, "git:b", 20);
    seed_epoch(&conn, "git:c", 30);
    let ws = seed_workspace(&conn, "pool");
    seed_workspace_member(&conn, ws, "git:a", "svc-a", "/a");
    seed_workspace_member(&conn, ws, "git:b", "svc-b", "/b");

    workspaces::apply_workspace_changes(
        &mut conn,
        ws,
        None,
        vec![add("git:c", "svc-c", "/c")],
        vec!["git:a".to_string()],
        vec![set_name("git:b", "svc-b-renamed")],
        default_share_categories(),
    )
    .unwrap();

    assert_eq!(epoch(&conn, "git:a"), 11, "old removed member bumped once");
    assert_eq!(
        epoch(&conn, "git:b"),
        21,
        "retained renamed member bumped once"
    );
    assert_eq!(epoch(&conn, "git:c"), 31, "new member bumped once");
}

#[test]
fn apply_workspace_changes_rename_only_does_not_bump_member_epochs() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    seed_epoch(&conn, "git:m", 5);
    let ws = seed_workspace(&conn, "before");
    seed_workspace_member(&conn, ws, "git:m", "m", "/m");

    workspaces::apply_workspace_changes(
        &mut conn,
        ws,
        Some("after".to_string()),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        default_share_categories(),
    )
    .unwrap();

    assert_eq!(epoch(&conn, "git:m"), 5);
    assert_eq!(workspaces::list_workspaces(&conn).unwrap()[0].name, "after");
}

#[test]
fn apply_workspace_changes_share_categories_change_bumps_and_stores_canonical_json() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    seed_epoch(&conn, "git:a", 1);
    seed_epoch(&conn, "git:b", 2);
    let ws = seed_workspace(&conn, "w");
    seed_workspace_member(&conn, ws, "git:a", "a", "/a");
    seed_workspace_member(&conn, ws, "git:b", "b", "/b");

    workspaces::apply_workspace_changes(
        &mut conn,
        ws,
        None,
        Vec::new(),
        Vec::new(),
        Vec::new(),
        vec![
            "NAMING".to_string(),
            "PROJECT_RULES".to_string(),
            "NAMING".to_string(),
        ],
    )
    .unwrap();

    assert_eq!(epoch(&conn, "git:a"), 2);
    assert_eq!(epoch(&conn, "git:b"), 3);
    let stored: String = conn
        .query_row(
            "SELECT share_categories FROM workspaces WHERE id = ?1",
            params![ws],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stored, "[\"PROJECT_RULES\",\"NAMING\"]");
}

#[test]
fn apply_workspace_changes_validates_against_final_staged_members() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    let ws = seed_workspace(&conn, "w");
    seed_workspace_member(&conn, ws, "git:a", "shared-name", "/a");

    workspaces::apply_workspace_changes(
        &mut conn,
        ws,
        None,
        vec![add("git:b", "shared-name", "/b")],
        vec!["git:a".to_string()],
        Vec::new(),
        default_share_categories(),
    )
    .unwrap();

    let members = workspaces::list_workspaces(&conn).unwrap()[0]
        .members
        .clone();
    assert_eq!(members.len(), 1);
    assert_eq!(members[0].project_path, "git:b");
    assert_eq!(members[0].display_name, "shared-name");
}

#[test]
fn apply_workspace_changes_rejects_identity_in_both_add_and_remove() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    let ws = seed_workspace(&conn, "w");
    seed_workspace_member(&conn, ws, "git:a", "a", "/a");

    let err = workspaces::apply_workspace_changes(
        &mut conn,
        ws,
        None,
        vec![add("git:a", "a2", "/a")],
        vec!["git:a".to_string()],
        Vec::new(),
        default_share_categories(),
    )
    .unwrap_err();
    assert!(err.to_string().contains("both added and removed"));
}

#[test]
fn apply_workspace_changes_rejects_unknown_share_categories() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    let ws = seed_workspace(&conn, "w");

    let err = workspaces::apply_workspace_changes(
        &mut conn,
        ws,
        None,
        Vec::new(),
        Vec::new(),
        Vec::new(),
        vec!["UNKNOWN".to_string()],
    )
    .unwrap_err();
    assert!(err.to_string().contains("Unknown workspace share category"));
}

#[test]
fn display_name_unique_within_workspace() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    let ws = workspaces::create_workspace(&mut conn, "w").unwrap();
    apply_add_member(&mut conn, ws, "git:a", "dup", "/a");
    let err = workspaces::apply_workspace_changes(
        &mut conn,
        ws,
        None,
        vec![add("git:b", "dup", "/b")],
        Vec::new(),
        Vec::new(),
        default_share_categories(),
    )
    .unwrap_err();
    assert!(err.to_string().contains("already used"));
}

#[test]
fn rename_workspace_does_not_bump_member_epochs() {
    let _g = env_lock();
    let mut conn = make_db_v35();
    let ws = workspaces::create_workspace(&mut conn, "before").unwrap();
    apply_add_member(&mut conn, ws, "git:m", "m", "/m");
    let epoch_before = epoch(&conn, "git:m");

    workspaces::rename_workspace(&mut conn, ws, "after").unwrap();

    let epoch_after = epoch(&conn, "git:m");
    assert_eq!(
        epoch_before, epoch_after,
        "renaming the workspace must not fold member m[0] (name is not rendered)"
    );
}

#[test]
fn workspace_member_identities_union_helper() {
    let old: HashSet<String> = ["git:a".into(), "git:b".into()].into_iter().collect();
    let new: HashSet<String> = ["git:b".into(), "git:c".into()].into_iter().collect();
    let u = workspaces::workspace_member_identities_union(&old, &new);
    assert_eq!(u.len(), 3);
}
