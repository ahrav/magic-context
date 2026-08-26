#[path = "../src/harness_closure.rs"]
mod harness_closure;

use std::collections::BTreeMap;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use harness_closure::{
    manifest_digest, validate_manifest, ClosureCandidate, ClosureDependency, ClosureManifest,
    ClosureNode, DependencyKind, HarnessClosureStore, NodeKind,
};
use sha2::{Digest, Sha256};

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn node(
    path: &str,
    source_path: &str,
    kind: NodeKind,
    bytes: &[u8],
    dependencies: Vec<ClosureDependency>,
) -> ClosureNode {
    ClosureNode {
        path: path.to_owned(),
        source_root: "install".to_owned(),
        source_path: source_path.to_owned(),
        kind,
        mode: if matches!(kind, NodeKind::Executable | NodeKind::Interpreter) {
            0o700
        } else {
            0o600
        },
        size_bytes: bytes.len() as u64,
        sha256: sha256(bytes),
        dependencies,
    }
}

fn dependency(path: &str, kind: DependencyKind) -> ClosureDependency {
    ClosureDependency {
        path: path.to_owned(),
        kind,
    }
}

fn fixture(source: &Path) -> ClosureCandidate {
    let files = [
        ("bin/node", b"node-runtime".as_slice()),
        (
            "node_modules/pi/dist/cli.js",
            b"import './helper.js'; import './addon.node'".as_slice(),
        ),
        (
            "node_modules/pi/dist/helper.js",
            b"export const answer = 42".as_slice(),
        ),
        (
            "node_modules/pi/dist/addon.node",
            b"native-addon".as_slice(),
        ),
        (
            "node_modules/provider/a.js",
            b"export const provider = 'a'".as_slice(),
        ),
        (
            "node_modules/provider/b.js",
            b"export const provider = 'b'".as_slice(),
        ),
    ];
    for (path, bytes) in files {
        let destination = source.join(path);
        std::fs::create_dir_all(destination.parent().expect("parent")).expect("create parent");
        std::fs::write(&destination, bytes).expect("write source");
    }
    let nodes = vec![
        node(
            "bin/node",
            "bin/node",
            NodeKind::Interpreter,
            b"node-runtime",
            vec![],
        ),
        node(
            "node_modules/pi/dist/addon.node",
            "node_modules/pi/dist/addon.node",
            NodeKind::NativeAddon,
            b"native-addon",
            vec![],
        ),
        node(
            "node_modules/pi/dist/cli.js",
            "node_modules/pi/dist/cli.js",
            NodeKind::Module,
            b"import './helper.js'; import './addon.node'",
            vec![
                dependency("node_modules/pi/dist/addon.node", DependencyKind::Native),
                dependency("node_modules/pi/dist/helper.js", DependencyKind::Static),
            ],
        ),
        node(
            "node_modules/pi/dist/helper.js",
            "node_modules/pi/dist/helper.js",
            NodeKind::Module,
            b"export const answer = 42",
            vec![],
        ),
        node(
            "node_modules/provider/a.js",
            "node_modules/provider/a.js",
            NodeKind::Extension,
            b"export const provider = 'a'",
            vec![],
        ),
        node(
            "node_modules/provider/b.js",
            "node_modules/provider/b.js",
            NodeKind::Extension,
            b"export const provider = 'b'",
            vec![],
        ),
    ];
    ClosureCandidate {
        manifest: ClosureManifest {
            schema: "magic-context.mc-host-harness-closure/v1".to_owned(),
            harness: "pi".to_owned(),
            package: "@earendil-works/pi-coding-agent".to_owned(),
            version: "0.80.2".to_owned(),
            argument_variant: "run_prompt".to_owned(),
            source_roots: vec!["install".to_owned()],
            executable: None,
            interpreter: Some("bin/node".to_owned()),
            entrypoint: Some("node_modules/pi/dist/cli.js".to_owned()),
            extensions: vec![
                "node_modules/provider/a.js".to_owned(),
                "node_modules/provider/b.js".to_owned(),
            ],
            nodes,
        },
        source_roots: BTreeMap::from([("install".to_owned(), source.to_path_buf())]),
    }
}

fn setup() -> (tempfile::TempDir, PathBuf, ClosureCandidate) {
    let temp = tempfile::tempdir().expect("tempdir");
    let source = temp.path().join("source");
    std::fs::create_dir(&source).expect("source");
    let candidate = fixture(&source);
    (temp, source, candidate)
}

#[test]
fn materialization_preserves_layout_and_security() {
    let (temp, _source, candidate) = setup();
    let store_root = temp.path().join("closures");
    let store = HarnessClosureStore::open(&store_root).expect("store");
    let closure = store.materialize(&candidate).expect("materialize");

    let entrypoint = closure
        .resolve_node("node_modules/pi/dist/cli.js")
        .expect("entrypoint");
    assert_eq!(
        std::fs::read(&entrypoint).expect("read copied entrypoint"),
        b"import './helper.js'; import './addon.node'"
    );
    assert_eq!(closure.manifest().extensions, candidate.manifest.extensions);
    for node in &candidate.manifest.nodes {
        let path = closure.path().join("files").join(&node.path);
        let metadata = std::fs::symlink_metadata(path).expect("copied node metadata");
        assert_eq!(metadata.permissions().mode() & 0o777, node.mode);
        assert_eq!(metadata.nlink(), 1);
    }
}

#[test]
fn retained_closure_survives_source_deletion_and_deduplicates_by_digest() {
    let (temp, source, candidate) = setup();
    let store_root = temp.path().join("closures");
    let store = HarnessClosureStore::open(&store_root).expect("store");
    let first = store.materialize(&candidate).expect("first materialize");
    let digest = first.digest().to_owned();
    std::fs::remove_dir_all(source).expect("delete source");

    let second = store
        .materialize(&candidate)
        .expect("dedupe does not reopen deleted source");
    assert_eq!(second.digest(), digest);
    assert_eq!(
        std::fs::read(
            second
                .resolve_node("node_modules/pi/dist/helper.js")
                .expect("resolve retained node")
        )
        .expect("read retained node"),
        b"export const answer = 42"
    );
    let digest_directories = std::fs::read_dir(&store_root)
        .expect("read store")
        .filter_map(Result::ok)
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with(".tmp-"))
        .count();
    assert_eq!(digest_directories, 1);

    let descriptor_path = second
        .resolve_node_descriptor("node_modules/pi/dist/helper.js")
        .expect("descriptor-rooted retained node");
    let retained = store_root.join(&digest);
    let moved = store_root.join("moved-retained");
    std::fs::rename(&retained, &moved).expect("rename retained closure");
    let replacement = retained.join("files/node_modules/pi/dist");
    std::fs::create_dir_all(&replacement).expect("replacement tree");
    std::fs::write(
        replacement.join("helper.js"),
        b"export const answer = 'malicious'",
    )
    .expect("replacement bytes");
    assert_eq!(
        std::fs::read(descriptor_path.path()).expect("read descriptor-rooted node"),
        b"export const answer = 42",
        "path replacement must not change the retained closure object"
    );
}

#[test]
fn retained_executable_loads_dependency_and_extension_after_source_deletion() {
    let temp = tempfile::tempdir().expect("tempdir");
    let source = temp.path().join("source");
    std::fs::create_dir_all(source.join("bin")).expect("bin");
    std::fs::create_dir_all(source.join("node_modules/pkg")).expect("package");
    let script = b"#!/bin/sh\nroot=$(CDPATH= cd -- \"$(dirname -- \"$0\")/..\" && pwd)\nprintf '%s' \"$(cat \"$root/node_modules/pkg/dep\")$(cat \"$root/node_modules/pkg/ext\")\"\n";
    std::fs::write(source.join("bin/run"), script).expect("script");
    std::fs::write(source.join("node_modules/pkg/dep"), b"dependency").expect("dependency");
    std::fs::write(source.join("node_modules/pkg/ext"), b"extension").expect("extension");
    let manifest = ClosureManifest {
        schema: "magic-context.mc-host-harness-closure/v1".to_owned(),
        harness: "execution-test".to_owned(),
        package: "execution-test".to_owned(),
        version: "1.0.0".to_owned(),
        argument_variant: "run_prompt".to_owned(),
        source_roots: vec!["install".to_owned()],
        executable: Some("bin/run".to_owned()),
        interpreter: None,
        entrypoint: None,
        extensions: vec!["node_modules/pkg/ext".to_owned()],
        nodes: vec![
            node(
                "bin/run",
                "bin/run",
                NodeKind::Executable,
                script,
                vec![dependency("node_modules/pkg/dep", DependencyKind::Static)],
            ),
            node(
                "node_modules/pkg/dep",
                "node_modules/pkg/dep",
                NodeKind::Data,
                b"dependency",
                vec![],
            ),
            node(
                "node_modules/pkg/ext",
                "node_modules/pkg/ext",
                NodeKind::Extension,
                b"extension",
                vec![],
            ),
        ],
    };
    let store = HarnessClosureStore::open(&temp.path().join("closures")).expect("store");
    let closure = store
        .materialize(&ClosureCandidate {
            manifest,
            source_roots: BTreeMap::from([("install".to_owned(), source.clone())]),
        })
        .expect("materialize");
    std::fs::remove_dir_all(source).expect("delete source");

    let output = std::process::Command::new(
        closure
            .resolve_node("bin/run")
            .expect("retained executable"),
    )
    .env_clear()
    .output()
    .expect("execute retained closure");
    assert!(output.status.success());
    assert_eq!(output.stdout, b"dependencyextension");
}

#[test]
fn source_and_retained_hash_mismatches_fail_closed() {
    let (temp, _source, candidate) = setup();
    let store = HarnessClosureStore::open(&temp.path().join("closures")).expect("store");
    let bad_source = candidate.clone();
    std::fs::write(
        bad_source.source_roots["install"].join("node_modules/pi/dist/helper.js"),
        b"export const answer = 41",
    )
    .expect("mutate source");
    assert_eq!(
        store
            .materialize(&bad_source)
            .expect_err("source hash mismatch")
            .detail(),
        "source node bytes diverge from manifest"
    );

    std::fs::write(
        bad_source.source_roots["install"].join("node_modules/pi/dist/helper.js"),
        b"export const answer = 42",
    )
    .expect("restore source");
    let closure = store.materialize(&candidate).expect("materialize");
    let retained = closure.path().join("files/node_modules/pi/dist/helper.js");
    std::fs::write(&retained, b"export const answer = 41").expect("mutate retained");
    assert_eq!(
        store
            .validate(closure.digest())
            .expect_err("retained hash mismatch")
            .detail(),
        "closure node hash diverges from manifest"
    );
}

#[test]
fn traversal_and_symlink_sources_are_rejected() {
    let (temp, source, candidate) = setup();
    let mut traversal = candidate.clone();
    traversal.manifest.nodes[0].source_path = "../node".to_owned();
    assert_eq!(
        validate_manifest(&traversal.manifest)
            .expect_err("traversal")
            .detail(),
        "manifest path has an invalid component"
    );

    let real = source.join("real-node");
    std::fs::write(&real, b"node-runtime").expect("real source");
    std::fs::remove_file(source.join("bin/node")).expect("remove original");
    std::os::unix::fs::symlink(&real, source.join("bin/node")).expect("symlink source");
    let store = HarnessClosureStore::open(&temp.path().join("closures")).expect("store");
    assert_eq!(
        store
            .materialize(&candidate)
            .expect_err("symlink refused")
            .detail(),
        "source node is missing or insecure"
    );
}

#[test]
fn missing_dependency_and_unreachable_nodes_are_rejected() {
    let (_temp, _source, candidate) = setup();
    let mut missing = candidate.manifest.clone();
    missing.nodes[2].dependencies[1].path = "node_modules/pi/dist/missing.js".to_owned();
    assert_eq!(
        validate_manifest(&missing)
            .expect_err("missing dependency")
            .detail(),
        "manifest references a missing node"
    );

    let mut unreachable = candidate.manifest.clone();
    unreachable.nodes[2].dependencies.pop();
    assert_eq!(
        validate_manifest(&unreachable)
            .expect_err("unreachable helper")
            .detail(),
        "manifest contains an unreachable node"
    );
}

#[test]
fn ordered_extensions_are_part_of_manifest_identity() {
    let (_temp, _source, candidate) = setup();
    let first = manifest_digest(&candidate.manifest).expect("first digest");
    let mut reordered = candidate.manifest.clone();
    reordered.extensions.reverse();
    let second = manifest_digest(&reordered).expect("second digest");
    assert_ne!(first, second);
}

#[test]
fn strict_manifest_decode_rejects_unknown_fields() {
    let (_temp, _source, candidate) = setup();
    let mut value = serde_json::to_value(&candidate.manifest).expect("value");
    value
        .as_object_mut()
        .expect("object")
        .insert("ambient_path".to_owned(), serde_json::Value::Bool(true));
    assert!(serde_json::from_value::<ClosureManifest>(value).is_err());
}

#[test]
fn rust_and_typescript_share_the_canonical_manifest_digest() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/__fixtures__/mc-host-qualification/harness-closures/pi-valid.json");
    let manifest: ClosureManifest =
        serde_json::from_slice(&std::fs::read(fixture).expect("read TS fixture"))
            .expect("decode TS fixture");
    assert_eq!(
        manifest_digest(&manifest).expect("digest"),
        "4043614cab86bdd36613d210af091aede71992a7b6e2dee7eebc26e755c35e51"
    );
}

#[test]
#[ignore = "requires U9 external closure roots; run explicitly in release qualification"]
fn production_closures_from_environment_materialize() {
    let opencode_root =
        std::env::var_os("MC_OPENCODE_CLOSURE_RUNTIME_ROOT").expect("OpenCode closure root");
    let pi_install = PathBuf::from(
        std::env::var_os("MC_PI_CLOSURE_INSTALL_ROOT")
            .expect("MC_PI_CLOSURE_INSTALL_ROOT accompanies OpenCode root"),
    );
    let pi_runtime = PathBuf::from(
        std::env::var_os("MC_PI_CLOSURE_RUNTIME_ROOT")
            .expect("MC_PI_CLOSURE_RUNTIME_ROOT accompanies OpenCode root"),
    );
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let read_manifest = |name: &str| -> ClosureManifest {
        serde_json::from_slice(
            &std::fs::read(repo.join("release/mc-host-harness-closures").join(name))
                .expect("read production closure manifest"),
        )
        .expect("decode production closure manifest")
    };
    let store_root = tempfile::tempdir().expect("closure store");
    let store =
        HarnessClosureStore::open(&store_root.path().join("closures")).expect("open closure store");

    let opencode = store
        .materialize(&ClosureCandidate {
            manifest: read_manifest("opencode-linux-x64-1.18.22.json"),
            source_roots: BTreeMap::from([("runtime".to_owned(), PathBuf::from(opencode_root))]),
        })
        .expect("materialize OpenCode closure");
    assert!(opencode
        .resolve_node("bin/opencode")
        .expect("OpenCode executable")
        .is_file());

    let pi = store
        .materialize(&ClosureCandidate {
            manifest: read_manifest("pi-linux-x64-node-24.18.0.json"),
            source_roots: BTreeMap::from([
                ("pi-install".to_owned(), pi_install),
                ("runtime".to_owned(), pi_runtime),
            ]),
        })
        .expect("materialize Pi closure");
    assert!(pi
        .resolve_node("node_modules/@earendil-works/pi-coding-agent/dist/cli.js")
        .expect("Pi entrypoint")
        .is_file());
    assert_eq!(pi.manifest().nodes.len(), 3_081);
}

#[test]
fn retained_closure_rejects_extra_missing_and_wrong_mode_nodes() {
    let (extra_temp, _source, extra_candidate) = setup();
    let extra_store =
        HarnessClosureStore::open(&extra_temp.path().join("closures")).expect("store");
    let extra = extra_store
        .materialize(&extra_candidate)
        .expect("materialize");
    std::fs::write(extra.path().join("files/unlisted"), b"extra").expect("extra file");
    assert_eq!(
        extra_store
            .validate(extra.digest())
            .expect_err("unlisted file must fail")
            .detail(),
        "closure contains an unlisted file"
    );

    let (missing_temp, _source, missing_candidate) = setup();
    let missing_store =
        HarnessClosureStore::open(&missing_temp.path().join("closures")).expect("store");
    let missing = missing_store
        .materialize(&missing_candidate)
        .expect("materialize");
    std::fs::remove_file(missing.path().join("files/node_modules/pi/dist/helper.js"))
        .expect("remove retained node");
    assert_eq!(
        missing_store
            .validate(missing.digest())
            .expect_err("missing node must fail")
            .detail(),
        "closure is missing a manifest-listed node"
    );

    let (mode_temp, _source, mode_candidate) = setup();
    let mode_store = HarnessClosureStore::open(&mode_temp.path().join("closures")).expect("store");
    let mode = mode_store
        .materialize(&mode_candidate)
        .expect("materialize");
    let helper = mode.path().join("files/node_modules/pi/dist/helper.js");
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700))
        .expect("change retained mode");
    assert_eq!(
        mode_store
            .validate(mode.digest())
            .expect_err("wrong mode must fail")
            .detail(),
        "closure file is not owner-only single-link"
    );
}
