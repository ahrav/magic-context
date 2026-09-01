//! Machine-checked soundness of anchor preselection.
//!
//! `RuleSet::preselect` skips a rule when none of its declared anchors
//! occurs in the input. That is only safe when a skipped rule could not
//! have produced a finding. Every active rule must satisfy one of three
//! sufficient conditions, checked here against the pinned corpus:
//!
//! 1. keyword coverage: the rule requires a keyword in the candidate
//!    window and every declared keyword contains an anchor, so absent
//!    anchors reject every candidate;
//! 2. key-word coverage: the rule reports a key group, so the evaluator
//!    requires a secret key word in it, and every such word contains an
//!    anchor;
//! 3. syntactic implication: pattern structure forces an anchor into every
//!    match;
//! 4. product emptiness: no string matches the pattern without containing
//!    an anchor.

use std::collections::{HashMap, HashSet, VecDeque};

use aho_corasick::automaton::Automaton as AcAutomaton;
use aho_corasick::dfa::DFA as AcDfa;
use aho_corasick::{Anchored as AcAnchored, MatchKind, StartKind as AcStartKind};
use regex_automata::dfa::{dense, Automaton};
use regex_automata::{Anchored, Input};
use regex_syntax::hir::{Class, Hir, HirKind};
use regex_syntax::ParserBuilder;

use crate::rules::{Rule, RuleSet};
use crate::ScanProfile;

/// Absent anchors reject every candidate, because the rule requires a
/// keyword inside a window that is a slice of the input and every keyword
/// contains an anchor.
fn keyword_coverage_holds(rule: &Rule) -> bool {
    let Some(keywords) = &rule.declaration.keywords_any else {
        return false;
    };
    if keywords.is_empty() {
        return false;
    }
    let anchors: Vec<String> = rule
        .declaration
        .anchors
        .iter()
        .map(|anchor| anchor.to_ascii_lowercase())
        .collect();
    keywords.iter().all(|keyword| {
        let lowered = keyword.to_ascii_lowercase();
        anchors
            .iter()
            .any(|anchor| !anchor.is_empty() && lowered.contains(anchor.as_str()))
    })
}

/// The evaluator drops a keyed candidate unless its key carries one of
/// these words, so anchors that cover them make absent anchors sufficient
/// to reject every candidate. Mirrors `evaluator::SECRET_KEY_WORDS`;
/// `secret_key_words_match_the_evaluator` pins the two together.
const SECRET_KEY_WORDS: &[&str] = &[
    "key",
    "keys",
    "token",
    "tokens",
    "secret",
    "secrets",
    "password",
    "passwords",
    "auth",
    "authorization",
    "bearer",
    "credential",
    "credentials",
];

fn key_word_coverage_holds(rule: &Rule) -> bool {
    if rule.declaration.key_group.is_none() {
        return false;
    }
    let anchors: Vec<String> = rule
        .declaration
        .anchors
        .iter()
        .map(|anchor| anchor.to_ascii_lowercase())
        .collect();
    SECRET_KEY_WORDS.iter().all(|word| {
        anchors
            .iter()
            .any(|anchor| !anchor.is_empty() && word.contains(anchor.as_str()))
    })
}

fn parse(rule: &Rule) -> Option<Hir> {
    ParserBuilder::new()
        .unicode(rule.declaration.unicode)
        .utf8(false)
        .build()
        .parse(&rule.declaration.regex)
        .ok()
}

fn atom_byte_sets(hir: &Hir) -> Option<Vec<Vec<u8>>> {
    match hir.kind() {
        HirKind::Literal(literal) => Some(literal.0.iter().map(|byte| vec![*byte]).collect()),
        HirKind::Class(Class::Bytes(class)) => {
            let mut bytes = Vec::new();
            for range in class.ranges() {
                if usize::from(range.end() - range.start()) > 8 {
                    return None;
                }
                bytes.extend(range.start()..=range.end());
            }
            (bytes.len() <= 8).then_some(vec![bytes])
        }
        HirKind::Class(Class::Unicode(class)) => {
            let mut bytes = Vec::new();
            for range in class.ranges() {
                if !range.start().is_ascii() || !range.end().is_ascii() {
                    return None;
                }
                if (range.end() as u32 - range.start() as u32) > 8 {
                    return None;
                }
                for point in (range.start() as u32)..=(range.end() as u32) {
                    bytes.push(u8::try_from(point).ok()?);
                }
            }
            (bytes.len() <= 8).then_some(vec![bytes])
        }
        _ => None,
    }
}

fn run_forces_anchor(run: &[Vec<u8>], anchor: &[u8]) -> bool {
    if anchor.is_empty() || run.len() < anchor.len() {
        return false;
    }
    (0..=(run.len() - anchor.len())).any(|offset| {
        anchor.iter().enumerate().all(|(position, byte)| {
            let lower = byte.to_ascii_lowercase();
            let upper = byte.to_ascii_uppercase();
            run[offset + position]
                .iter()
                .all(|candidate| *candidate == lower || *candidate == upper)
        })
    })
}

/// Pattern syntax forces an anchor: walks required elements and checks
/// contiguous runs of single-byte or case-pair classes.
fn syntax_forces_anchor(hir: &Hir, anchors: &[String]) -> bool {
    let forced = |run: &[Vec<u8>]| {
        anchors
            .iter()
            .any(|anchor| run_forces_anchor(run, anchor.as_bytes()))
    };
    match hir.kind() {
        HirKind::Alternation(branches) => branches
            .iter()
            .all(|branch| syntax_forces_anchor(branch, anchors)),
        HirKind::Capture(capture) => syntax_forces_anchor(&capture.sub, anchors),
        HirKind::Repetition(repetition) if repetition.min >= 1 => {
            syntax_forces_anchor(&repetition.sub, anchors)
        }
        HirKind::Concat(parts) => {
            let mut run: Vec<Vec<u8>> = Vec::new();
            for part in parts {
                match atom_byte_sets(part) {
                    Some(mut sets) => run.append(&mut sets),
                    None => {
                        if forced(&run) || syntax_forces_anchor(part, anchors) {
                            return true;
                        }
                        run.clear();
                    }
                }
            }
            forced(&run)
        }
        _ => atom_byte_sets(hir).is_some_and(|sets| forced(&sets)),
    }
}

/// Searches for a string the pattern matches that contains no anchor.
/// `Ok(true)` means none exists.
fn product_is_empty(rule: &Rule, budget: usize) -> Result<bool, String> {
    let hir = parse(rule).ok_or_else(|| "pattern does not parse".to_string())?;
    let nfa = regex_automata::nfa::thompson::Compiler::new()
        .configure(regex_automata::nfa::thompson::Config::new().utf8(false))
        .build_from_hir(&hir)
        .map_err(|error| format!("nfa: {error}"))?;
    let pattern = dense::Builder::new()
        .build_from_nfa(&nfa)
        .map_err(|error| format!("dfa: {error}"))?;
    let gate = AcDfa::builder()
        .ascii_case_insensitive(true)
        .match_kind(MatchKind::Standard)
        .start_kind(AcStartKind::Unanchored)
        .build(&rule.declaration.anchors)
        .map_err(|error| format!("anchor automaton: {error}"))?;

    let pattern_start = pattern
        .start_state_forward(&Input::new("").anchored(Anchored::No))
        .map_err(|error| format!("start: {error}"))?;
    let gate_start = gate
        .start_state(AcAnchored::No)
        .map_err(|error| format!("gate start: {error}"))?;

    // Joint alphabet compression: bytes indistinguishable to both automata
    // are interchangeable for reachability.
    let gate_states = {
        let mut states = vec![gate_start];
        let mut seen = HashSet::new();
        seen.insert(gate_start.as_usize());
        let mut index = 0;
        while index < states.len() {
            let state = states[index];
            index += 1;
            for byte in 0..=255u8 {
                let next = gate.next_state(AcAnchored::No, state, byte);
                if !gate.is_match(next) && seen.insert(next.as_usize()) {
                    states.push(next);
                }
            }
        }
        states
    };
    let mut representatives = Vec::new();
    let mut signatures: HashMap<Vec<usize>, usize> = HashMap::new();
    for byte in 0..=255u8 {
        let mut signature = Vec::with_capacity(gate_states.len() + 1);
        signature.push(usize::from(pattern.byte_classes().get(byte)));
        for state in &gate_states {
            signature.push(gate.next_state(AcAnchored::No, *state, byte).as_usize());
        }
        if signatures
            .insert(signature, representatives.len())
            .is_none()
        {
            representatives.push(byte);
        }
    }

    let mut queue = VecDeque::new();
    let mut seen = HashSet::new();
    queue.push_back((Some(pattern_start), gate_start));
    seen.insert((Some(pattern_start.as_usize()), gate_start.as_usize()));
    while let Some((pattern_state, gate_state)) = queue.pop_front() {
        if seen.len() > budget {
            return Err(format!("state budget exceeded ({} states)", seen.len()));
        }
        let matched = match pattern_state {
            None => true,
            Some(state) => pattern.is_match_state(pattern.next_eoi_state(state)),
        };
        if matched && !gate.is_match(gate_state) {
            return Ok(false);
        }
        for byte in representatives.iter().copied() {
            let next_gate = gate.next_state(AcAnchored::No, gate_state, byte);
            if gate.is_match(next_gate) {
                continue;
            }
            let next_pattern = match pattern_state {
                None => None,
                Some(state) => {
                    let next = pattern.next_state(state, byte);
                    if pattern.is_dead_state(next) {
                        continue;
                    }
                    if pattern.is_quit_state(next) {
                        return Err("pattern dfa quit state".to_string());
                    }
                    if pattern.is_match_state(next) {
                        None
                    } else {
                        Some(next)
                    }
                }
            };
            let key = (
                next_pattern.map(|state| state.as_usize()),
                next_gate.as_usize(),
            );
            if seen.insert(key) {
                queue.push_back((next_pattern, next_gate));
            }
        }
    }
    Ok(true)
}

/// Rules covered only by the product proof, which is too slow to run on
/// every build. `preselection_soundness_is_current` re-derives this set.
const PRODUCT_PROVEN: &[&str] = &[
    "azure-ad-client-secret",
    "magic-github-token",
    "twilio-api-key",
];

/// Preselection cannot drop a finding from any rule in the pinned corpus.
#[test]
fn preselection_cannot_drop_a_finding() {
    let rules = RuleSet::from_embedded().expect("embedded rules are valid");
    for rule in rules.active(ScanProfile::Comprehensive) {
        let name = rule.declaration.name.as_str();
        if keyword_coverage_holds(rule) || key_word_coverage_holds(rule) {
            continue;
        }
        if parse(rule).is_some_and(|hir| syntax_forces_anchor(&hir, &rule.declaration.anchors)) {
            continue;
        }
        assert!(
            PRODUCT_PROVEN.contains(&name),
            "{name}: preselection may skip it while its pattern still matches"
        );
    }
}

/// The proof's copy of the evaluator's secret key words must not drift.
#[test]
fn secret_key_words_match_the_evaluator() {
    let mirrored: Vec<&[u8]> = SECRET_KEY_WORDS
        .iter()
        .map(|word| word.as_bytes())
        .collect();
    assert_eq!(mirrored, crate::evaluator::secret_key_words_for_test());
}

/// The corpus digests the recorded product proofs were derived against.
#[test]
fn corpus_digests_match_recorded_proof() {
    assert_eq!(
        crate::rules::UPSTREAM_CORPUS_SHA256,
        "2f1292b50148d38afe3ebdb7c489449d103b75b7df464e06da0d5d7c89ac2820"
    );
    assert_eq!(
        crate::rules::CONSERVATIVE_OVERLAY_SHA256,
        "973181a0af049fb4c0ae06160cd022b1beae3660b87ac9fa4d498864912b3487"
    );
}

/// Re-derives the product-proven set. Slow, so it is ignored by default;
/// run it with `cargo test --release -p mc-secret-scanner -- --ignored`
/// after a corpus digest change.
#[test]
#[ignore = "product proof over every uncovered rule; rerun on corpus change"]
fn preselection_soundness_is_current() {
    let rules = RuleSet::from_embedded().expect("embedded rules are valid");
    let mut product_proven = Vec::new();
    let mut unproven = Vec::new();
    for rule in rules.active(ScanProfile::Comprehensive) {
        if keyword_coverage_holds(rule) || key_word_coverage_holds(rule) {
            continue;
        }
        if parse(rule).is_some_and(|hir| syntax_forces_anchor(&hir, &rule.declaration.anchors)) {
            continue;
        }
        match product_is_empty(rule, 8_000_000) {
            Ok(true) => product_proven.push(rule.declaration.name.clone()),
            Ok(false) => unproven.push(rule.declaration.name.clone()),
            Err(error) => unproven.push(format!("{}: {error}", rule.declaration.name)),
        }
    }
    product_proven.sort();
    let mut recorded: Vec<String> = PRODUCT_PROVEN.iter().map(|name| (*name).into()).collect();
    recorded.sort();
    assert_eq!(unproven, Vec::<String>::new());
    assert_eq!(product_proven, recorded);
}
