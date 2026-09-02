//! Bounded cheap checks against a checkout snapshot's worktree.

use std::collections::HashMap;
use std::io::Read;
use std::sync::Arc;

use sha2::{Digest, Sha256};

use super::checkout::{CheckoutSnapshot, EvalBudget, WorktreeEntry};
use super::payloads::CheckSpec;

pub const MAX_CONFIG_BYTES: u64 = 1 << 20;

/// Typed verdict of one cheap check. `Unsupported` is a first-class
/// outcome — the evaluator maps it to uncertain rather than inventing a
/// pass or fail (KTD8: no speculative resolver trait).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckOutcome {
    Passed,
    Failed { evidence: String },
    Unsupported { evidence: String },
    BudgetExhausted,
}

/// Absence is settled by the shape probe before a read is attempted, so a read
/// either yields content or leaves the key unevaluated: a permission error, a
/// transient I/O error, a vanished path, or a file past the size cap.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ConfigRead {
    Content(Arc<str>),
    Unevaluated(String),
}

impl ConfigRead {
    /// Digest material naming the content this batch read, so a cache key can
    /// distinguish two runs that read different bytes at one path.
    fn observation(&self) -> String {
        match self {
            Self::Content(content) => {
                let mut hash = Sha256::new();
                hash.update(content.as_bytes());
                format!("content:{:x}", hash.finalize())
            }
            Self::Unevaluated(reason) => format!("unevaluated:{reason}"),
        }
    }
}

/// Whether a declared path is a file a check can read, and if not, why.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Resolved {
    /// Present and a regular file, established without following a symlink.
    RegularFile,
    /// Resolved beneath the worktree and definitely not there.
    Absent,
    /// Present, and established to be a shape no check can read: a directory,
    /// socket, device, or FIFO. No regular file is at this path, which is as
    /// definite an answer about the declared file as absence — unlike a
    /// symlink, whose unfollowed target could be one.
    NotAFile(String),
    /// Nothing was read: the spelling leaves the worktree, or an inspection
    /// failed, or a symlink was refused rather than followed.
    Unresolvable(String),
}

impl Resolved {
    fn observation(&self) -> &str {
        match self {
            Self::RegularFile => "regular-file",
            Self::Absent => "absent",
            Self::NotAFile(reason) | Self::Unresolvable(reason) => reason,
        }
    }
}

/// Single authority on what one batch observed in the worktree.
///
/// The object cache key and the check that produces a verdict both read
/// through here, so a cached verdict can never describe bytes its key does
/// not. Reading the live filesystem twice would let a path change between the
/// two reads and revert afterwards, storing a verdict under a key no later
/// request reproduces.
#[derive(Debug, Default)]
pub struct CheckCache {
    resolved: HashMap<String, Resolved>,
    contents: HashMap<String, ConfigRead>,
}

impl CheckCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn resolve(&mut self, snapshot: &CheckoutSnapshot, path: &str) -> Resolved {
        if let Some(cached) = self.resolved.get(path) {
            return cached.clone();
        }
        let resolved = match snapshot.worktree_entry(path) {
            WorktreeEntry::RegularFile => Resolved::RegularFile,
            WorktreeEntry::Absent => Resolved::Absent,
            // A terminal symlink is where the target could sit outside the
            // checkout, so no check follows one to a verdict.
            WorktreeEntry::Symlink => Resolved::Unresolvable(format!(
                "check path {path} is a symlink, whose target this check will not follow"
            )),
            WorktreeEntry::Directory => Resolved::NotAFile(format!(
                "check path {path} is a directory, not a file a check can read"
            )),
            WorktreeEntry::Other => {
                Resolved::NotAFile(format!("check path {path} is not a regular file"))
            }
            WorktreeEntry::Unresolvable(reason) => Resolved::Unresolvable(reason),
        };
        self.resolved.insert(path.to_string(), resolved.clone());
        resolved
    }

    fn read(&mut self, snapshot: &CheckoutSnapshot, path: &str) -> ConfigRead {
        if let Some(cached) = self.contents.get(path) {
            return cached.clone();
        }
        let outcome = read_bounded(snapshot, path);
        self.contents.insert(path.to_string(), outcome.clone());
        outcome
    }
}

/// Digest material for the worktree state `check` reads, or `None` for a check
/// whose verdict does not depend on the filesystem.
pub fn check_observation(
    cache: &mut CheckCache,
    snapshot: &CheckoutSnapshot,
    check: &CheckSpec,
) -> Option<String> {
    match check {
        CheckSpec::FileExists { path } => {
            Some(cache.resolve(snapshot, path).observation().to_string())
        }
        CheckSpec::ConfigKey { path, .. } => {
            let resolved = cache.resolve(snapshot, path);
            let shape = resolved.observation().to_string();
            // Only a regular file is read, so only then is there content to
            // name; the shape alone settles the other cases.
            match resolved {
                Resolved::RegularFile => {
                    let content = cache.read(snapshot, path).observation();
                    Some(format!("{shape}\u{1f}{content}"))
                }
                Resolved::Absent | Resolved::NotAFile(_) | Resolved::Unresolvable(_) => Some(shape),
            }
        }
        // Both are `Unsupported` whatever the worktree holds.
        CheckSpec::Symbol { .. } | CheckSpec::Unrecognized => None,
    }
}

/// Reads through a descriptor walk that follows no symlink at any level, and
/// sizes the file by that descriptor.
///
/// A pathname re-resolved after a containment check can escape: a concurrent
/// checkout that replaces an ancestor directory with a symlink redirects every
/// later pathname operation, and `NOFOLLOW` guards only the final component.
/// FIFOs can block reads and character devices such as `/dev/zero` produce
/// valid UTF-8 indefinitely, both of which the open refuses.
fn read_bounded(snapshot: &CheckoutSnapshot, path: &str) -> ConfigRead {
    let file = match snapshot.open_worktree_regular(path) {
        Ok(Some(file)) => file,
        // Resolution already saw a regular file here, so the path moved.
        Ok(None) => {
            return ConfigRead::Unevaluated("path is no longer a regular file".to_string());
        }
        Err(error) => return ConfigRead::Unevaluated(error.to_string()),
    };
    match file.metadata() {
        Ok(metadata) if metadata.len() > MAX_CONFIG_BYTES => {
            return ConfigRead::Unevaluated(format!("file exceeds {MAX_CONFIG_BYTES} bytes"));
        }
        Ok(_) => {}
        Err(error) => return ConfigRead::Unevaluated(error.to_string()),
    }
    let mut content = String::new();
    // Metadata size can race file growth and does not always bound the stream,
    // so `MAX_CONFIG_BYTES` is enforced on bytes read.
    match file.take(MAX_CONFIG_BYTES + 1).read_to_string(&mut content) {
        Ok(_) if content.len() as u64 > MAX_CONFIG_BYTES => {
            ConfigRead::Unevaluated(format!("file exceeds {MAX_CONFIG_BYTES} bytes"))
        }
        Ok(_) => ConfigRead::Content(Arc::from(content)),
        Err(error) => ConfigRead::Unevaluated(error.to_string()),
    }
}

/// `Unsupported` rather than `Failed`: the check was never evaluated, so the
/// checked object is uncertain rather than definitely stale.
fn unevaluated(evidence: String) -> CheckOutcome {
    CheckOutcome::Unsupported { evidence }
}

/// Runs one check natively against the snapshot's worktree. File existence
/// and config-key presence ship here; symbol resolution returns
/// `Unsupported` until a real resolver exists.
pub fn run_cheap_check(
    snapshot: &CheckoutSnapshot,
    check: &CheckSpec,
    budget: &EvalBudget,
    cache: &mut CheckCache,
) -> CheckOutcome {
    if budget.is_exhausted() {
        return CheckOutcome::BudgetExhausted;
    }
    match check {
        CheckSpec::FileExists { path } => match cache.resolve(snapshot, path) {
            Resolved::RegularFile => CheckOutcome::Passed,
            Resolved::Absent => CheckOutcome::Failed {
                evidence: format!("file {path} does not exist in the checkout"),
            },
            // No regular file is here, which the check asked about; repair can
            // act on that exactly as it acts on an absent path.
            Resolved::NotAFile(reason) => CheckOutcome::Failed { evidence: reason },
            // A path that was never read is not a definite absence.
            Resolved::Unresolvable(reason) => unevaluated(reason),
        },
        CheckSpec::ConfigKey { path, key } => {
            match cache.resolve(snapshot, path) {
                Resolved::RegularFile => {}
                Resolved::Absent => {
                    return CheckOutcome::Failed {
                        evidence: format!("config file {path} does not exist in the checkout"),
                    };
                }
                // `Failed` here would claim the file exists and omits the key,
                // which is what repair would then try to edit. A shape that is
                // not a config file leaves the key unevaluated instead.
                Resolved::NotAFile(reason) | Resolved::Unresolvable(reason) => {
                    return unevaluated(reason);
                }
            }
            let content = match cache.read(snapshot, path) {
                ConfigRead::Content(content) => content,
                // The key may well be defined; the read never got to look.
                ConfigRead::Unevaluated(reason) => {
                    return unevaluated(format!("config file {path} could not be read: {reason}"));
                }
            };
            if config_contains_key(&content, key) {
                CheckOutcome::Passed
            } else {
                CheckOutcome::Failed {
                    evidence: format!("config file {path} does not define key {key}"),
                }
            }
        }
        CheckSpec::Symbol { path, symbol } => CheckOutcome::Unsupported {
            evidence: format!("symbol check for {symbol} in {path} is not supported yet"),
        },
        CheckSpec::Unrecognized => CheckOutcome::Unsupported {
            evidence: "check kind is not recognized".to_string(),
        },
    }
}

/// JSON carries no line structure, so a minified document has to be parsed
/// rather than scanned; the line heuristic below reports every key in
/// `{"flag":true}` missing.
fn json_contains_key(value: &serde_json::Value, key: &str) -> bool {
    match value {
        serde_json::Value::Object(map) => {
            // Any depth, matching what the line scan finds in a pretty-printed
            // document.
            map.contains_key(key) || map.values().any(|value| json_contains_key(value, key))
        }
        serde_json::Value::Array(items) => items.iter().any(|item| json_contains_key(item, key)),
        _ => false,
    }
}

/// Presence heuristic over line-oriented config formats: the key must open
/// a line (after whitespace and optional quoting) and be followed by a
/// delimiter, which holds across TOML, YAML, INI, and JSON object keys.
fn config_contains_key(content: &str, key: &str) -> bool {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(content) {
        return json_contains_key(&value, key);
    }
    content.lines().any(|line| {
        let line = line.trim_start();
        let line = line.strip_prefix(['"', '\'']).unwrap_or(line);
        let Some(rest) = line.strip_prefix(key) else {
            return false;
        };
        let rest = rest.strip_prefix(['"', '\'']).unwrap_or(rest);
        let rest = rest.trim_start();
        rest.starts_with('=') || rest.starts_with(':')
    })
}
