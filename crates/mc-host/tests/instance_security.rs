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
    let owned = mc_host::read_connection_file(host.publication_path())
        .expect("host-owned discovery accepts publication");
    assert_eq!(owned.wire_version, 2);
    assert_eq!(owned.key.len(), 32);

    let info = raw_client::discover(&host.publication_path()).expect("valid publication");
    assert_eq!(info.schema, 1);
    assert_eq!(info.wire_version, 2);
    assert_eq!(info.host, "127.0.0.1");
    assert_ne!(info.port, 0);
    assert_eq!(info.key.len(), 32);
    assert_eq!(info.daemon_id.len(), 16);
    assert_eq!(info.pid, u64::from(std::process::id()));
    assert_eq!(info.daemon_ver, "mc-host/test");

    let loose = host.data_root.path().join("loose-copy.json");
    std::fs::copy(host.publication_path(), &loose).expect("copy");
    std::fs::set_permissions(&loose, std::fs::Permissions::from_mode(0o644)).expect("chmod");
    assert!(
        raw_client::discover(&loose).is_err(),
        "an insecure mode must fail client validation"
    );
    assert!(mc_host::read_connection_file(&loose).is_err());

    let oversized = host.runtime_dir().join("oversized.json");
    std::fs::write(&oversized, vec![b' '; mc_host::MAX_CONNECTION_FILE_LEN + 1])
        .expect("write oversized publication");
    std::fs::set_permissions(&oversized, std::fs::Permissions::from_mode(0o600))
        .expect("owner-only oversized publication");
    assert!(mc_host::read_connection_file(&oversized).is_err());

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn discovery_requires_numeric_wire_version_two() {
    let host = TestHost::start().await;
    let original: serde_json::Value =
        serde_json::from_slice(&std::fs::read(host.publication_path()).expect("read publication"))
            .expect("parse publication");

    for (name, value) in [
        ("missing", None),
        ("null", Some(serde_json::Value::Null)),
        ("string", Some(serde_json::json!("2"))),
        ("other", Some(serde_json::json!(1))),
    ] {
        let path = host.runtime_dir().join(format!("{name}.json"));
        let mut candidate = original.clone();
        let object = candidate.as_object_mut().expect("object");
        match value {
            Some(value) => {
                object.insert("wire_version".to_owned(), value);
            }
            None => {
                object.remove("wire_version");
            }
        }
        std::fs::write(&path, serde_json::to_vec(&candidate).expect("serialize"))
            .expect("write candidate");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .expect("owner-only candidate");
        assert!(
            mc_host::read_connection_file(&path).is_err(),
            "{name} wire_version must fail discovery"
        );
    }

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn discovery_rejects_symlink_and_hard_link_publications() {
    let host = TestHost::start().await;
    let symlink = host.runtime_dir().join("symlink.json");
    std::os::unix::fs::symlink(host.publication_path(), &symlink).expect("create symlink");
    assert!(mc_host::read_connection_file(&symlink).is_err());

    let hard_link = host.runtime_dir().join("hard-link.json");
    std::fs::hard_link(host.publication_path(), &hard_link).expect("create hard link");
    assert!(mc_host::read_connection_file(&hard_link).is_err());

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

#[tokio::test]
async fn lifecycle_record_is_owner_only_and_removed_at_shutdown() {
    let host = TestHost::start().await;
    let record = host.runtime_dir().join(mc_host::LIFECYCLE_RECORD_NAME);
    let meta = std::fs::symlink_metadata(&record).expect("record exists");
    assert!(meta.file_type().is_file());
    assert_eq!(meta.permissions().mode() & 0o7777, 0o600);

    let json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&record).expect("read record")).expect("parse");
    assert_eq!(json["schema"], 1);
    assert_eq!(json["phase"], "running");

    host.shutdown_gracefully().await;
    assert!(
        !record.exists(),
        "graceful shutdown must remove the lifecycle record"
    );
}

#[tokio::test]
async fn a_planted_symlink_at_the_record_name_is_replaced_not_followed() {
    let outside = tempfile::tempdir().expect("outside root");
    let victim = outside.path().join("victim");
    std::fs::write(&victim, b"untouched").expect("write victim");

    let data_root = tempfile::tempdir().expect("temp root");
    let run_dir = data_root.path().join("cortexkit").join("run");
    std::fs::create_dir_all(&run_dir).expect("create runtime dir");
    std::os::unix::fs::symlink(&victim, run_dir.join(mc_host::LIFECYCLE_RECORD_NAME))
        .expect("plant symlink");

    let host = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await
    .expect("host publishes despite the planted link");

    // rename(2) replaces the link itself; the outside target is intact.
    assert_eq!(std::fs::read(&victim).expect("read victim"), b"untouched");
    let meta = std::fs::symlink_metadata(run_dir.join(mc_host::LIFECYCLE_RECORD_NAME))
        .expect("stat record");
    assert!(meta.file_type().is_file(), "the record must be a real file");

    host.shutdown_gracefully().await;
}

/// `deny(unsafe_code)` permits the scoped `allow(unsafe_code)` required for the `pre_exec` hook that arms `PR_SET_PDEATHSIG` so harness children die with a crashed host.
/// `deny(unsafe_code)` permits the scoped `allow(unsafe_code)` required for the `pre_exec` hook that arms `PR_SET_PDEATHSIG` so harness children die with a crashed host.
/// `deny(unsafe_code)` permits the scoped `allow(unsafe_code)` required for the `pre_exec` hook that arms `PR_SET_PDEATHSIG` so harness children die with a crashed host.
///
/// `forbid(unsafe_code)` cannot be overridden within the crate.
#[test]
fn exactly_one_unsafe_escape_hatch_exists_in_the_crate() {
    const BLESSED: &str = "broca/subprocess.rs";
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut sites = Vec::new();

    let mut stack = vec![src.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("read source dir") {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("read source file");
            for (index, line) in text.lines().enumerate() {
                if line.contains("allow(unsafe_code)") {
                    let relative = path
                        .strip_prefix(&src)
                        .expect("source-relative path")
                        .to_string_lossy()
                        .into_owned();
                    sites.push((relative, index + 1, text.clone()));
                }
            }
        }
    }

    assert_eq!(
        sites.len(),
        1,
        "exactly one allow(unsafe_code) may exist; found {:?}",
        sites
            .iter()
            .map(|(file, line, _)| format!("{file}:{line}"))
            .collect::<Vec<_>>()
    );
    let (file, _, text) = &sites[0];
    assert_eq!(
        file, BLESSED,
        "the only allow(unsafe_code) must stay in {BLESSED}"
    );
    assert!(
        text.contains("// SAFETY:"),
        "the unsafe escape hatch must carry a SAFETY justification"
    );
}

/// The coordination fences are owner-only regular files in an owner-only
/// Coordination fences remain present while the host serves.
/// Host teardown never unlinks coordination fences.
#[tokio::test]
async fn coordination_locks_are_owner_only_and_survive_teardown() {
    let data_root = tempfile::tempdir().expect("temp root");
    let host = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await
    .expect("host publishes");

    let coordination = data_root.path().join(mc_host::COORDINATION_DIR_NAME);
    let dir_meta = std::fs::symlink_metadata(&coordination).expect("coordination dir");
    assert!(dir_meta.is_dir());
    assert_eq!(dir_meta.permissions().mode() & 0o7777, 0o700);
    for name in [mc_host::TRANSACTION_LOCK_NAME, mc_host::LIFETIME_LOCK_NAME] {
        let meta = std::fs::symlink_metadata(coordination.join(name)).expect("lock file");
        assert!(meta.file_type().is_file(), "{name} must be a regular file");
        assert_eq!(meta.permissions().mode() & 0o7777, 0o600, "{name}");
    }

    host.shutdown_gracefully().await;
    for name in [mc_host::TRANSACTION_LOCK_NAME, mc_host::LIFETIME_LOCK_NAME] {
        assert!(
            coordination.join(name).exists(),
            "{name} must never be unlinked by supported teardown"
        );
    }
}

/// An unknown lifecycle schema at the record name blocks startup without
/// An unknown lifecycle schema leaves quarantined bytes uninterpreted, unmigrated, and unchanged.
#[tokio::test]
async fn startup_refuses_to_overwrite_an_unknown_lifecycle_schema() {
    let data_root = tempfile::tempdir().expect("temp root");
    let run_dir = data_root.path().join("cortexkit").join("run");
    std::fs::create_dir_all(&run_dir).expect("runtime dir");
    let record = run_dir.join(mc_host::LIFECYCLE_RECORD_NAME);
    let future_bytes = br#"{"schema":9,"phase":"carried-forward"}"#.to_vec();
    std::fs::write(&record, &future_bytes).expect("plant future record");
    std::fs::set_permissions(&record, std::fs::Permissions::from_mode(0o600)).expect("mode");

    let refused = TestHost::try_start_with(TestHandler::new(), {
        let path = data_root.path().to_path_buf();
        move |config| config.data_dir = Some(path)
    })
    .await;
    assert!(
        matches!(
            refused,
            Err(mc_host::HostError::Instance(
                mc_host::InstanceError::UnsupportedStateSchema { .. }
            ))
        ),
        "startup over an unknown schema must fail closed on the quarantine gate, \
         not on some unrelated instance error"
    );
    assert_eq!(
        std::fs::read(&record).expect("reread"),
        future_bytes,
        "the quarantined bytes must be preserved byte-for-byte"
    );
}
