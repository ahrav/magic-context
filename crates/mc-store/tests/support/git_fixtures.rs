//! Fixture repositories built entirely with gix write APIs — no git CLI.
//!
//! Histories are deterministic: commits carry a fixed signature and a
//! caller-supplied timestamp, so fixture OIDs are stable across runs.
//! Rebase- and cherry-pick-shaped histories are written directly as trees
//! and commits with new parents rather than by running git commands.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use gix::bstr::BString;
use gix::ObjectId;

/// One fixture checkout: the repository plus its root path.
pub struct FixtureRepo {
    pub root: PathBuf,
    pub repo: gix::Repository,
}

/// Initializes a non-bare repository and reopens it with isolated options,
/// so no user or system git configuration leaks into fixture behavior.
pub fn init_repo(root: &Path) -> FixtureRepo {
    std::fs::create_dir_all(root).expect("fixture root creatable");
    gix::init(root).expect("fixture repo initializes");
    let repo = gix::open_opts(root, gix::open::Options::isolated()).expect("fixture repo reopens");
    FixtureRepo {
        root: root.to_path_buf(),
        repo,
    }
}

fn signature(seconds: i64) -> gix::actor::Signature {
    gix::actor::Signature {
        name: "fixture".into(),
        email: "fixture@example.com".into(),
        time: gix::date::Time::new(seconds, 0),
    }
}

/// Writes a full snapshot of `files` as a (possibly nested) tree.
pub fn write_tree(repo: &gix::Repository, files: &[(&str, &str)]) -> ObjectId {
    #[derive(Default)]
    struct Node {
        files: BTreeMap<String, ObjectId>,
        dirs: BTreeMap<String, Node>,
    }
    fn insert(node: &mut Node, path: &str, blob: ObjectId) {
        match path.split_once('/') {
            Some((dir, rest)) => insert(node.dirs.entry(dir.to_string()).or_default(), rest, blob),
            None => {
                node.files.insert(path.to_string(), blob);
            }
        }
    }
    fn write_node(repo: &gix::Repository, node: &Node) -> ObjectId {
        let mut entries = Vec::new();
        for (name, child) in &node.dirs {
            entries.push(gix::objs::tree::Entry {
                mode: gix::objs::tree::EntryKind::Tree.into(),
                filename: BString::from(name.as_str()),
                oid: write_node(repo, child),
            });
        }
        for (name, blob) in &node.files {
            entries.push(gix::objs::tree::Entry {
                mode: gix::objs::tree::EntryKind::Blob.into(),
                filename: BString::from(name.as_str()),
                oid: *blob,
            });
        }
        entries.sort();
        let tree = gix::objs::Tree { entries };
        repo.write_object(&tree).expect("tree writes").detach()
    }
    let mut root = Node::default();
    for (path, content) in files {
        let blob = repo.write_blob(content.as_bytes()).expect("blob writes");
        insert(&mut root, path, blob.detach());
    }
    write_node(repo, &root)
}

/// Commits a full file snapshot onto `branch` with the given parents.
/// `seconds` feeds the signature timestamp, keeping OIDs deterministic and
/// letting rewrites of the same diff produce distinct commits.
pub fn commit_snapshot(
    repo: &gix::Repository,
    branch: &str,
    parents: &[ObjectId],
    files: &[(&str, &str)],
    message: &str,
    seconds: i64,
) -> ObjectId {
    let tree = write_tree(repo, files);
    commit_tree(repo, branch, parents, tree, message, seconds)
}

/// Commits an existing tree object onto `branch`.
pub fn commit_tree(
    repo: &gix::Repository,
    branch: &str,
    parents: &[ObjectId],
    tree: ObjectId,
    message: &str,
    seconds: i64,
) -> ObjectId {
    let signature = signature(seconds);
    repo.commit_as(
        signature.to_ref(&mut Default::default()),
        signature.to_ref(&mut Default::default()),
        format!("refs/heads/{branch}"),
        message,
        tree,
        parents.iter().copied(),
    )
    .expect("commit writes")
    .detach()
}

/// Points HEAD at `branch` without touching worktree or index. Combine with
/// `materialize` for a clean checkout of that branch.
pub fn set_head(repo: &gix::Repository, branch: &str) {
    std::fs::write(
        repo.git_dir().join("HEAD"),
        format!("ref: refs/heads/{branch}\n"),
    )
    .expect("HEAD writes");
}

/// Makes worktree and index match `commit` exactly: clears the worktree,
/// writes the commit's files, and rebuilds the index from its tree.
pub fn materialize(repo: &gix::Repository, commit: ObjectId) {
    let workdir = repo.workdir().expect("fixture repo has a worktree");
    clear_worktree(workdir);
    let tree_id = repo
        .find_commit(commit)
        .expect("commit exists")
        .tree_id()
        .expect("commit has a tree")
        .detach();
    write_tree_files(repo, tree_id, workdir);
    let mut index = repo
        .index_from_tree(&tree_id)
        .expect("index builds from tree");
    index.set_path(repo.git_dir().join("index"));
    index
        .write(gix::index::write::Options::default())
        .expect("index writes");
}

fn clear_worktree(workdir: &Path) {
    for entry in std::fs::read_dir(workdir).expect("worktree readable") {
        let entry = entry.expect("worktree entry readable");
        if entry.file_name() == ".git" {
            continue;
        }
        let path = entry.path();
        if entry.file_type().expect("file type readable").is_dir() {
            std::fs::remove_dir_all(&path).expect("worktree dir removable");
        } else {
            std::fs::remove_file(&path).expect("worktree file removable");
        }
    }
}

fn write_tree_files(repo: &gix::Repository, tree: ObjectId, target: &Path) {
    let tree = repo.find_tree(tree).expect("tree exists");
    for entry in tree.iter() {
        let entry = entry.expect("tree entry decodes");
        let name = entry.filename().to_string();
        let path = target.join(&name);
        if entry.mode().is_tree() {
            std::fs::create_dir_all(&path).expect("tree dir creatable");
            write_tree_files(repo, entry.object_id(), &path);
        } else {
            let blob = repo.find_blob(entry.object_id()).expect("blob exists");
            std::fs::write(&path, &blob.data).expect("worktree file writes");
        }
    }
}

/// Writes one worktree file (creating parent directories), leaving the rest
/// of the checkout untouched — the building block for dirty fixtures.
pub fn write_worktree_file(repo: &gix::Repository, rela_path: &str, content: &str) {
    let path = repo
        .workdir()
        .expect("fixture repo has a worktree")
        .join(rela_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("worktree dirs creatable");
    }
    std::fs::write(path, content).expect("worktree file writes");
}

/// Adds stage-1/2/3 entries for `rela_path` to the index, simulating an
/// unresolved merge conflict.
pub fn write_conflicted_index_entry(
    repo: &gix::Repository,
    rela_path: &str,
    base: &str,
    ours: &str,
    theirs: &str,
) {
    use gix::index::entry::{Flags, Mode, Stage, Stat};
    let mut index = repo.open_index().expect("index opens");
    // Drop any stage-0 entry for the path; a conflicted path has none.
    index.remove_entries(|_, path, _| path == rela_path);
    for (stage, content) in [
        (Stage::Base, base),
        (Stage::Ours, ours),
        (Stage::Theirs, theirs),
    ] {
        let blob = repo
            .write_blob(content.as_bytes())
            .expect("conflict blob writes")
            .detach();
        index.dangerously_push_entry(
            Stat::default(),
            blob,
            Flags::from_stage(stage),
            Mode::FILE,
            rela_path.into(),
        );
    }
    index.sort_entries();
    index
        .write(gix::index::write::Options::default())
        .expect("index writes");
}

/// Fabricates a linked worktree at `target` for `branch`, writing the same
/// `.git` file plus `worktrees/<name>` metadata layout git produces.
pub fn add_linked_worktree(
    main: &FixtureRepo,
    name: &str,
    target: &Path,
    branch: &str,
) -> FixtureRepo {
    let main_git_dir = main.repo.git_dir();
    let private_dir = main_git_dir.join("worktrees").join(name);
    std::fs::create_dir_all(&private_dir).expect("worktree metadata dir creatable");
    std::fs::create_dir_all(target).expect("worktree dir creatable");
    std::fs::write(
        target.join(".git"),
        format!("gitdir: {}\n", private_dir.display()),
    )
    .expect(".git file writes");
    std::fs::write(
        private_dir.join("gitdir"),
        format!("{}\n", target.join(".git").display()),
    )
    .expect("gitdir file writes");
    std::fs::write(private_dir.join("commondir"), "../..\n").expect("commondir writes");
    std::fs::write(
        private_dir.join("HEAD"),
        format!("ref: refs/heads/{branch}\n"),
    )
    .expect("worktree HEAD writes");
    let repo =
        gix::open_opts(target, gix::open::Options::isolated()).expect("linked worktree opens");
    FixtureRepo {
        root: target.to_path_buf(),
        repo,
    }
}

/// Detaches HEAD at `commit` without touching worktree or index.
pub fn set_head_detached(repo: &gix::Repository, commit: ObjectId) {
    std::fs::write(repo.git_dir().join("HEAD"), format!("{commit}\n")).expect("HEAD writes");
}
