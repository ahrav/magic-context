use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use mc_host::{Client, RequestOptions, RouteHandle, RouteIdentity, RouteTarget, TargetKind};
use serde_json::{json, Value};

pub const BUDGET: Duration = Duration::from_secs(20);
pub const CONTROL_FILE: &str = "direct-host-control.sock";
pub const STORE_FILE: &str = "mc-store.db";
pub const REDACTION_SENTINEL: &str = "u5-redaction-sentinel-DO-NOT-LOG";

static BUILD_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("mc-module is under workspace/crates")
        .to_path_buf()
}

fn fixture_binary() -> PathBuf {
    let _guard = BUILD_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let workspace = workspace_root();
    let output = Command::new("cargo")
        .args([
            "build",
            "-p",
            "mc-module",
            "--example",
            "direct_host_fixture",
            "--features",
            "direct-host-fixture",
        ])
        .current_dir(&workspace)
        .output()
        .expect("cargo builds direct host fixture");
    assert!(
        output.status.success(),
        "direct host fixture build failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace.join("target"));
    let binary = target.join("debug/examples/direct_host_fixture");
    assert!(binary.is_file(), "missing fixture at {}", binary.display());
    binary
}

pub struct FixtureProcess {
    child: Option<Child>,
    root: PathBuf,
    _root_owner: Option<tempfile::TempDir>,
    readiness: Value,
    stdout: Arc<Mutex<Vec<String>>>,
    stderr: Arc<Mutex<Vec<String>>>,
    stdout_thread: Option<JoinHandle<()>>,
    stderr_thread: Option<JoinHandle<()>>,
}

impl FixtureProcess {
    pub fn start() -> Self {
        Self::start_in(tempfile::tempdir().expect("fixture state root"))
    }

    pub fn start_in(root: tempfile::TempDir) -> Self {
        let path = root.path().to_path_buf();
        Self::start_at_inner(path, Some(root))
    }

    pub fn start_at(root: PathBuf) -> Self {
        Self::start_at_inner(root, None)
    }

    fn start_at_inner(root: PathBuf, root_owner: Option<tempfile::TempDir>) -> Self {
        let mut child = Command::new(fixture_binary())
            .arg("--state-root")
            .arg(&root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start direct host fixture");
        let stdout_pipe = child.stdout.take().expect("fixture stdout");
        let stderr_pipe = child.stderr.take().expect("fixture stderr");
        let stdout = Arc::new(Mutex::new(Vec::new()));
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let stdout_lines = Arc::clone(&stdout);
        let stdout_thread = std::thread::spawn(move || {
            for line in BufReader::new(stdout_pipe).lines() {
                let Ok(line) = line else { break };
                stdout_lines
                    .lock()
                    .expect("fixture stdout mutex")
                    .push(line.clone());
                let _ = ready_tx.try_send(line);
            }
        });
        let stderr_lines = Arc::clone(&stderr);
        let stderr_thread = std::thread::spawn(move || {
            for line in BufReader::new(stderr_pipe).lines() {
                let Ok(line) = line else { break };
                stderr_lines
                    .lock()
                    .expect("fixture stderr mutex")
                    .push(line);
            }
        });
        let line = ready_rx.recv_timeout(BUDGET).unwrap_or_else(|error| {
            let status = child.try_wait().expect("fixture status");
            let diagnostics = stderr.lock().expect("fixture stderr mutex").join("\n");
            panic!("fixture readiness failed ({error}; status={status:?}): {diagnostics}")
        });
        assert!(line.len() <= 64 * 1024, "readiness must be bounded");
        let readiness: Value = serde_json::from_str(&line).expect("readiness JSON");
        assert_eq!(readiness["status"], "ready");
        assert_eq!(readiness["wire_version"], 2);
        assert_eq!(
            child.try_wait().expect("fixture status after readiness"),
            None,
            "fixture exited immediately after readiness"
        );
        Self {
            child: Some(child),
            root,
            _root_owner: root_owner,
            readiness,
            stdout,
            stderr,
            stdout_thread: Some(stdout_thread),
            stderr_thread: Some(stderr_thread),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn control_path(&self) -> PathBuf {
        self.root().join(CONTROL_FILE)
    }

    pub fn connection_file(&self) -> PathBuf {
        mc_host::runtime_dir_path(Some(self.root()))
            .expect("fixture runtime path")
            .join(mc_host::CONNECTION_FILE_NAME)
    }

    pub fn store_path(&self) -> PathBuf {
        self.root().join(STORE_FILE)
    }

    pub fn readiness(&self) -> &Value {
        &self.readiness
    }

    pub fn control(&self, id: u64, name: &str) -> Value {
        self.control_raw(format!("{}\n", json!({"id": id, "command": {"name": name}})).as_bytes())
    }

    /// Best-effort graceful shutdown that reports failure instead of panicking.
    /// `control_raw` panics loudly on purpose, which is right inside a test body
    /// and fatal in `Drop`: a panic while unwinding a failed test aborts the
    /// runner and hides the failure that started the unwind.
    fn try_graceful_shutdown(&self) -> std::io::Result<()> {
        let request = format!(
            "{}\n",
            json!({"id": 9_998, "command": {"name": "graceful-shutdown"}})
        );
        let mut stream = UnixStream::connect(self.control_path())?;
        stream.set_read_timeout(Some(BUDGET))?;
        stream.write_all(request.as_bytes())?;
        let mut response = Vec::new();
        BufReader::new(stream)
            .take(64 * 1024 + 1)
            .read_until(b'\n', &mut response)?;
        Ok(())
    }

    pub fn control_raw(&self, bytes: &[u8]) -> Value {
        let path = self.control_path();
        let mut stream = UnixStream::connect(&path).unwrap_or_else(|error| {
            let entries = fs::read_dir(self.root())
                .map(|entries| {
                    entries
                        .filter_map(Result::ok)
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            panic!(
                "connect control socket {} failed immediately after readiness: {error}; root_exists={}; entries={entries:?}; stderr={}",
                path.display(),
                self.root().exists(),
                self.stderr.lock().expect("fixture stderr mutex").join("\\n")
            );
        });
        stream
            .set_read_timeout(Some(BUDGET))
            .expect("control read timeout");
        stream.write_all(bytes).expect("write control request");
        let mut response = Vec::new();
        BufReader::new(stream)
            .take((64 * 1024 + 1) as u64)
            .read_until(b'\n', &mut response)
            .expect("read control response");
        assert!(response.len() <= 64 * 1024 + 1, "control response bounded");
        serde_json::from_slice(&response).expect("control response JSON")
    }

    pub fn counters(&self, id: u64) -> Value {
        let response = self.control(id, "counters");
        assert_eq!(response["id"], id);
        assert_eq!(response["ok"], true);
        response["result"].clone()
    }

    pub async fn client(&self) -> Client {
        Client::connect(self.connection_file())
            .await
            .expect("managed client connects")
    }

    pub async fn open_route(
        &self,
        client: &Client,
        module_id: &str,
        kind: TargetKind,
        session: &str,
    ) -> RouteHandle {
        client
            .open_route(
                RouteTarget {
                    module_id: module_id.to_owned(),
                    kind,
                },
                identity(self.root(), "opencode", session),
            )
            .await
            .expect("route opens")
    }

    pub fn signal_term(&mut self) {
        let pid = self.child.as_ref().expect("fixture child").id().to_string();
        let status = Command::new("kill")
            .args(["-TERM", &pid])
            .status()
            .expect("send SIGTERM");
        assert!(status.success(), "SIGTERM delivery failed");
    }

    pub fn shutdown(mut self) -> CapturedOutput {
        let response = self.control(9_999, "graceful-shutdown");
        assert_eq!(response["ok"], true);
        self.wait_for_exit()
    }

    pub fn wait_for_exit(&mut self) -> CapturedOutput {
        let deadline = Instant::now() + BUDGET;
        let status = loop {
            if let Some(status) = self
                .child
                .as_mut()
                .expect("fixture child")
                .try_wait()
                .expect("fixture wait")
            {
                break status;
            }
            assert!(Instant::now() < deadline, "fixture exceeded exit budget");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(status.success(), "fixture exited with {status}");
        self.child.take();
        if let Some(thread) = self.stdout_thread.take() {
            thread.join().expect("stdout reader joins");
        }
        if let Some(thread) = self.stderr_thread.take() {
            thread.join().expect("stderr reader joins");
        }
        let output = CapturedOutput {
            stdout: self.stdout.lock().expect("fixture stdout mutex").join("\n"),
            stderr: self.stderr.lock().expect("fixture stderr mutex").join("\n"),
        };
        assert!(!self.control_path().exists(), "control socket cleaned up");
        assert!(
            !self.connection_file().exists(),
            "connection publication cleaned up"
        );
        let lifecycle = mc_host::lifecycle_dir_path(Some(self.root()))
            .expect("lifecycle path")
            .join(mc_host::LIFECYCLE_RECORD_NAME);
        assert!(!lifecycle.exists(), "lifecycle record cleaned up");
        output
    }
}

impl Drop for FixtureProcess {
    fn drop(&mut self) {
        if self.child.is_none() {
            return;
        }
        if self
            .child
            .as_mut()
            .and_then(|child| child.try_wait().ok().flatten())
            .is_some()
        {
            return;
        }
        let _ = self.try_graceful_shutdown();
        let deadline = Instant::now() + BUDGET;
        while Instant::now() < deadline {
            if self
                .child
                .as_mut()
                .and_then(|child| child.try_wait().ok().flatten())
                .is_some()
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub struct CapturedOutput {
    pub stdout: String,
    pub stderr: String,
}

pub fn identity(root: &Path, harness: &str, session: &str) -> RouteIdentity {
    RouteIdentity {
        project_root: root.join("project"),
        harness: harness.to_owned(),
        session: session.to_owned(),
        consumer_module_id: None,
        consumer_launch_nonce: None,
        consumer_capabilities: Vec::new(),
        admission_facts: None,
    }
}

pub async fn request_json(client: &Client, route: RouteHandle, body: Value) -> Value {
    let response = client
        .request(
            route,
            serde_json::to_vec(&body).expect("request serializes"),
            RequestOptions {
                timeout: BUDGET,
                cancellation: None,
            },
        )
        .await
        .expect("request succeeds");
    serde_json::from_slice(&response.body).expect("response JSON")
}

pub fn send_body(prompt: &str) -> Value {
    json!({
        "method": "session.send",
        "params": {
            "prompt": prompt,
            "model": {"provider": "fixture", "model": "deterministic"},
            "tools": [],
            "generation": {"max_output_tokens": 1_024, "temperature": 0.1}
        }
    })
}

pub fn mode(path: &Path) -> u32 {
    fs::symlink_metadata(path)
        .expect("path metadata")
        .permissions()
        .mode()
        & 0o777
}

pub fn storage_descriptor(root: &Path) -> cortexkit_store_types::StorageDescriptor {
    cortexkit_store_types::StorageDescriptor {
        module_id: "magic-context".to_owned(),
        storage_namespace: "mc_cache".to_owned(),
        isolation: cortexkit_store_types::Isolation::Module,
        backend: cortexkit_store_types::StorageBackend::Sqlite {
            path: root.join(STORE_FILE).to_string_lossy().into_owned(),
        },
    }
}
