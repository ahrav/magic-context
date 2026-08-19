//! Adversarial descriptor-level cases live in `src/instance.rs` unit tests,
//! where the guard is constructible directly; this file covers what a client
//! and a racing successor can observe from outside.

mod support;

use std::os::unix::fs::PermissionsExt;
use std::process::Command;

use support::raw_client;
use support::{TestHandler, TestHost};

const UMASK_CHILD_ENV: &str = "MC_HOST_RESTRICTIVE_UMASK_CHILD";

#[test]
fn restrictive_umask_preserves_required_owner_permissions() {
    let output = Command::new(std::env::current_exe().expect("test executable"))
        .args([
            "--exact",
            "restrictive_umask_subprocess_child",
            "--nocapture",
        ])
        .env(UMASK_CHILD_ENV, "1")
        .output()
        .expect("run restrictive-umask subprocess");
    assert!(
        output.status.success(),
        "subprocess failed:\nstdout={}\nstderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn restrictive_umask_subprocess_child() {
    if std::env::var_os(UMASK_CHILD_ENV).is_none() {
        return;
    }
    let data_root = tempfile::tempdir().expect("data root");
    rustix::process::umask(rustix::fs::Mode::from_raw_mode(0o777));
    let host = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await
    .expect("host publishes under restrictive umask");

    let dir_mode = std::fs::symlink_metadata(host.runtime_dir())
        .expect("stat dir")
        .permissions()
        .mode()
        & 0o7777;
    let file_mode = std::fs::symlink_metadata(host.publication_path())
        .expect("stat publication")
        .permissions()
        .mode()
        & 0o7777;
    assert_eq!(dir_mode, 0o700);
    assert_eq!(file_mode, 0o600);
    raw_client::discover(&host.publication_path()).expect("publication stays readable");

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn publication_is_an_owner_only_regular_file_in_an_owner_only_dir() {
    let host = TestHost::start().await;

    let dir_meta = std::fs::symlink_metadata(host.runtime_dir()).expect("stat dir");
    assert!(dir_meta.is_dir());
    assert_eq!(dir_meta.permissions().mode() & 0o7777, 0o700);

    let file_meta = std::fs::symlink_metadata(host.publication_path()).expect("stat file");
    assert!(file_meta.file_type().is_file());
    assert_eq!(file_meta.permissions().mode() & 0o7777, 0o600);

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn discovery_validates_the_publication_the_way_a_client_must() {
    let host = TestHost::start().await;
    let info = raw_client::discover(&host.publication_path()).expect("valid publication");
    assert_eq!(info.schema, 1);
    assert_eq!(info.wire_version, Some(2));
    assert_eq!(info.host, "127.0.0.1");
    assert_ne!(info.port, 0);
    assert_eq!(info.key.len(), 32);
    assert_eq!(info.daemon_id.len(), 16);
    assert_eq!(info.pid, u64::from(std::process::id()));
    assert_eq!(info.daemon_ver, "mc-host/test");

    // A mode-0644 copy of the same file must be refused.
    let loose = host.data_root.path().join("loose-copy.json");
    std::fs::copy(host.publication_path(), &loose).expect("copy");
    std::fs::set_permissions(&loose, std::fs::Permissions::from_mode(0o644)).expect("chmod");
    assert!(
        raw_client::discover(&loose).is_err(),
        "an insecure mode must fail client validation"
    );

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn shutdown_removes_the_publication_and_releases_the_lock() {
    let data_root = tempfile::tempdir().expect("temp root");
    let host = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await
    .expect("host publishes");
    let publication = host.publication_path();
    assert!(publication.exists());

    host.shutdown_gracefully().await;
    assert!(
        !publication.exists(),
        "graceful shutdown must remove the publication"
    );

    // The lock released: a successor starts immediately in the same root.
    let successor = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await
    .expect("successor starts after lock release");
    successor.shutdown_gracefully().await;
}

#[tokio::test]
async fn a_replaced_publication_survives_the_old_incarnation_cleanup() {
    let data_root = tempfile::tempdir().expect("temp root");
    let host = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await
    .expect("host publishes");
    let publication = host.publication_path();

    let mut json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&publication).expect("read")).expect("parse");
    json["daemon_id"] = serde_json::json!(vec![7u8; 16]);
    let replacement = host.runtime_dir().join("replacement.tmp");
    std::fs::write(&replacement, serde_json::to_vec(&json).expect("serialize"))
        .expect("write replacement");
    std::fs::set_permissions(&replacement, std::fs::Permissions::from_mode(0o600)).expect("chmod");
    std::fs::rename(&replacement, &publication).expect("replace");

    host.shutdown_gracefully().await;

    assert!(
        publication.exists(),
        "cleanup must not delete a successor's publication"
    );
    let survived: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&publication).expect("read")).expect("parse");
    assert_eq!(survived["daemon_id"], serde_json::json!(vec![7u8; 16]));
}

#[tokio::test]
async fn no_secret_bearing_temp_files_survive_startup() {
    let host = TestHost::start().await;
    let leftovers: Vec<String> = std::fs::read_dir(host.runtime_dir())
        .expect("read runtime dir")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "no key-bearing temp file may outlive publication: {leftovers:?}"
    );
    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn startup_errors_render_without_key_material() {
    let data_root = tempfile::tempdir().expect("temp root");
    let holder = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await
    .expect("holder publishes");
    let holder_key_hex: String = holder
        .info
        .key
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();

    let refused = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await;
    let err = match refused {
        Ok(_) => panic!("second instance must be refused"),
        Err(err) => err,
    };
    let rendered = format!("{err} / {err:?}");
    assert!(
        rendered.contains("lock") || rendered.contains("AlreadyRunning"),
        "the refusal must be identifiable: {rendered}"
    );
    assert!(
        !rendered.contains(&holder_key_hex),
        "an error chain must never carry key bytes"
    );

    holder.shutdown_gracefully().await;
}
