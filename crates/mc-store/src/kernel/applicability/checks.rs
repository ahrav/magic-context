//! Bounded cheap checks against a checkout snapshot's worktree.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use super::checkout::{CheckoutSnapshot, EvalBudget};
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

#[derive(Debug, Default)]
pub struct CheckCache {
    files: HashMap<PathBuf, Option<Arc<str>>>,
}

impl CheckCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn read(&mut self, absolute: &Path) -> Option<Arc<str>> {
        if let Some(cached) = self.files.get(absolute) {
            return cached.clone();
        }
        let content = read_bounded(absolute).map(Arc::<str>::from);
        self.files.insert(absolute.to_path_buf(), content.clone());
        content
    }
}

/// FIFOs can block reads. Character devices such as `/dev/zero` produce valid
/// UTF-8 indefinitely.
fn read_bounded(absolute: &Path) -> Option<String> {
    let metadata = std::fs::metadata(absolute).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES {
        return None;
    }
    let file = std::fs::File::open(absolute).ok()?;
    let mut content = String::new();
    file.take(MAX_CONFIG_BYTES)
        .read_to_string(&mut content)
        .ok()?;
    Some(content)
}

/// `Path::join` lets an absolute path replace the workdir and never resolves
/// `..`.
fn confined_path(snapshot: &CheckoutSnapshot, path: &str) -> Option<PathBuf> {
    if !Path::new(path)
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
    {
        return None;
    }
    snapshot.worktree_path(path)
}

/// `Unsupported` rather than `Failed`: the check was never evaluated, so the
/// checked object is uncertain rather than definitely stale.
fn escaped(path: &str) -> CheckOutcome {
    CheckOutcome::Unsupported {
        evidence: format!("check path {path} is not a plain relative path inside the checkout"),
    }
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
        CheckSpec::FileExists { path } => {
            let Some(absolute) = confined_path(snapshot, path) else {
                return escaped(path);
            };
            if absolute.is_file() {
                CheckOutcome::Passed
            } else {
                CheckOutcome::Failed {
                    evidence: format!("file {path} does not exist in the checkout"),
                }
            }
        }
        CheckSpec::ConfigKey { path, key } => {
            let Some(absolute) = confined_path(snapshot, path) else {
                return escaped(path);
            };
            let Some(content) = cache.read(&absolute) else {
                return CheckOutcome::Failed {
                    evidence: format!("config file {path} is missing, unreadable, or too large"),
                };
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

/// Presence heuristic over line-oriented config formats: the key must open
/// a line (after whitespace and optional quoting) and be followed by a
/// delimiter, which holds across TOML, YAML, INI, and JSON object keys.
fn config_contains_key(content: &str, key: &str) -> bool {
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
