//! Bounded cheap checks against a checkout snapshot's worktree.

use std::path::{Component, Path, PathBuf};

use super::checkout::{CheckoutSnapshot, EvalBudget};
use super::payloads::CheckSpec;

/// Config files larger than this stop the key scan: the presence heuristic
/// targets ordinary configuration, not arbitrary blobs, and an unbounded
/// read would let one payload exhaust memory.
const CONFIG_SCAN_CAP_BYTES: u64 = 4 * 1024 * 1024;

/// Typed verdict of one cheap check. `Unsupported` and `Invalid` are
/// first-class outcomes — the evaluator maps them to uncertain rather than
/// inventing a pass or fail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckOutcome {
    Passed,
    Failed {
        evidence: String,
    },
    Unsupported {
        evidence: String,
    },
    /// The check specification itself is unusable (a path escaping the
    /// checkout, an oversized target).
    Invalid {
        evidence: String,
    },
    BudgetExhausted,
}

/// Confines a payload-supplied path to the worktree: absolute paths, parent
/// traversal, and drive prefixes are rejected before any filesystem access.
/// Symlinked segments inside the worktree still resolve wherever they
/// point; the guard stops payload-authored traversal, not repository
/// contents.
fn confined_worktree_path(snapshot: &CheckoutSnapshot, rela_path: &str) -> Option<PathBuf> {
    let relative = Path::new(rela_path);
    let confined = relative
        .components()
        .all(|component| matches!(component, Component::Normal(_) | Component::CurDir));
    if !confined {
        return None;
    }
    snapshot.worktree_path(rela_path)
}

/// Runs one check natively against the snapshot's worktree. File existence
/// and config-key presence ship here; symbol resolution returns
/// `Unsupported` until a real resolver exists.
pub fn run_cheap_check(
    snapshot: &CheckoutSnapshot,
    check: &CheckSpec,
    budget: &EvalBudget,
) -> CheckOutcome {
    if budget.is_exhausted() {
        return CheckOutcome::BudgetExhausted;
    }
    match check {
        CheckSpec::FileExists { path } => {
            let Some(absolute) = confined_worktree_path(snapshot, path) else {
                return invalid_path(path, snapshot);
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
            let Some(absolute) = confined_worktree_path(snapshot, path) else {
                return invalid_path(path, snapshot);
            };
            match std::fs::metadata(&absolute) {
                Ok(metadata) if metadata.len() > CONFIG_SCAN_CAP_BYTES => {
                    return CheckOutcome::Invalid {
                        evidence: format!("config file {path} exceeds the scan cap"),
                    };
                }
                Ok(_) => {}
                Err(_) => {
                    return CheckOutcome::Failed {
                        evidence: format!("config file {path} is missing or unreadable"),
                    };
                }
            }
            let Ok(content) = std::fs::read_to_string(&absolute) else {
                return CheckOutcome::Failed {
                    evidence: format!("config file {path} is missing or unreadable"),
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
    }
}

fn invalid_path(path: &str, snapshot: &CheckoutSnapshot) -> CheckOutcome {
    if snapshot.worktree_path(path).is_none() {
        return CheckOutcome::Failed {
            evidence: "checkout has no worktree".to_string(),
        };
    }
    CheckOutcome::Invalid {
        evidence: format!("check path {path} is not a repository-relative path"),
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
