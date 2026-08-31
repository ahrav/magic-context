//! Bounded cheap checks against a checkout snapshot's worktree.

use super::checkout::{CheckoutSnapshot, EvalBudget};
use super::payloads::CheckSpec;

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
        CheckSpec::FileExists { path } => match snapshot.worktree_path(path) {
            Some(absolute) if absolute.is_file() => CheckOutcome::Passed,
            Some(_) => CheckOutcome::Failed {
                evidence: format!("file {path} does not exist in the checkout"),
            },
            None => CheckOutcome::Failed {
                evidence: "checkout has no worktree".to_string(),
            },
        },
        CheckSpec::ConfigKey { path, key } => {
            let Some(absolute) = snapshot.worktree_path(path) else {
                return CheckOutcome::Failed {
                    evidence: "checkout has no worktree".to_string(),
                };
            };
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
