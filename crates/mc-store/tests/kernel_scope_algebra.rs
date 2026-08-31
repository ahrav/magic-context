//! Scope algebra proofs: vocabulary decode, canonical form, and the four
//! predicates, with proptest law coverage over generated scopes.
//!
//! Proptest runs use the fixed RNG seed recorded in `proptest_config` so law
//! failures reproduce deterministically across runs.

use std::collections::{BTreeMap, BTreeSet};

use mc_store::kernel::{
    coerce_version, scope_equivalent, scope_matches, scope_overlaps, scope_subsumes,
    CanonicalScope, Dimension, GraphOracle, MatchOutcome, ScopeFormError, ScopeMatchContext,
    ScopeTermSpec, TermValue, UnknownGraph,
};
use proptest::prelude::*;

const PLACEHOLDER_BRANCH: &str = "feature/<ANTHROPIC_API_KEY_REDACTED>";

fn term(dimension: &str, operator: &str) -> ScopeTermSpec {
    ScopeTermSpec {
        dimension: dimension.to_string(),
        operator: operator.to_string(),
        ..ScopeTermSpec::default()
    }
}

fn exact(dimension: &str, value: &str) -> ScopeTermSpec {
    ScopeTermSpec {
        exact_value: Some(value.to_string()),
        ..term(dimension, "exact")
    }
}

fn set(dimension: &str, values: &[&str]) -> ScopeTermSpec {
    ScopeTermSpec {
        set_values: Some(values.iter().map(|value| value.to_string()).collect()),
        ..term(dimension, "set")
    }
}

fn range(dimension: &str, start: Option<&str>, end: Option<&str>) -> ScopeTermSpec {
    ScopeTermSpec {
        range_start: start.map(str::to_string),
        range_end: end.map(str::to_string),
        ..term(dimension, "range")
    }
}

fn version_range(dimension: &str, req: &str) -> ScopeTermSpec {
    ScopeTermSpec {
        version_range: Some(req.to_string()),
        ..term(dimension, "version_range")
    }
}

fn git_reachable(dimension: &str, oid: &str) -> ScopeTermSpec {
    ScopeTermSpec {
        git_oid: Some(oid.to_string()),
        ..term(dimension, "git_reachable")
    }
}

fn oid(byte: u8) -> String {
    format!("{byte:02x}").repeat(20)
}

fn scope(terms: &[ScopeTermSpec]) -> CanonicalScope {
    CanonicalScope::from_term_specs(terms).expect("fixture scope is well formed")
}

/// Linear-chain oracle: `oid(a)` is an ancestor of `oid(b)` when `a <= b`
/// and both commits are in the graph. OIDs outside the chain are unknown.
struct ChainOracle {
    depth: u8,
}

impl GraphOracle for ChainOracle {
    fn is_ancestor_or_equal(&self, ancestor: &str, descendant: &str) -> Option<bool> {
        let position =
            |value: &str| -> Option<u8> { (0..self.depth).find(|index| oid(*index) == value) };
        Some(position(ancestor)? <= position(descendant)?)
    }
}

// ---------------------------------------------------------------------------
// U1: decode, canonical form.
// ---------------------------------------------------------------------------

#[test]
fn round_trips_every_dimension_operator_combination() {
    for dimension in Dimension::ALL {
        let name = dimension.as_str();
        let specs = [
            exact(name, "value-a"),
            set(name, &["a", "b"]),
            range(name, Some("a"), Some("m")),
            range(name, None, Some("m")),
            range(name, Some("a"), None),
            version_range(name, ">=1.2.0, <2.0.0"),
            git_reachable(name, &oid(7)),
        ];
        for spec in specs {
            let decoded = scope(std::slice::from_ref(&spec));
            let term = decoded.term(dimension).expect("term decoded");
            match spec.operator.as_str() {
                "exact" => assert_eq!(term, &TermValue::Exact("value-a".to_string())),
                "set" => assert_eq!(
                    term,
                    &TermValue::Set(BTreeSet::from(["a".to_string(), "b".to_string()]))
                ),
                "range" => assert_eq!(
                    term,
                    &TermValue::Range {
                        start: spec.range_start.clone(),
                        end: spec.range_end.clone(),
                    }
                ),
                "version_range" => {
                    assert_eq!(
                        term,
                        &TermValue::VersionRange(">=1.2.0, <2.0.0".to_string())
                    )
                }
                "git_reachable" => assert_eq!(term, &TermValue::GitReachable(oid(7))),
                other => panic!("unexpected operator {other}"),
            }
        }
    }
}

#[test]
fn duplicate_dimension_rows_are_malformed() {
    let error = CanonicalScope::from_term_specs(&[exact("branch", "main"), exact("branch", "dev")])
        .unwrap_err();
    assert_eq!(error, ScopeFormError::DuplicateDimension(Dimension::Branch));
}

#[test]
fn unknown_vocabulary_is_malformed() {
    assert_eq!(
        CanonicalScope::from_term_specs(&[exact("repository", "x")]).unwrap_err(),
        ScopeFormError::UnknownDimension("repository".to_string())
    );
    assert_eq!(
        CanonicalScope::from_term_specs(&[term("branch", "regex")]).unwrap_err(),
        ScopeFormError::UnknownOperator("regex".to_string())
    );
}

#[test]
fn operator_owning_wrong_columns_is_malformed() {
    let mut spec = exact("branch", "main");
    spec.git_oid = Some(oid(1));
    assert_eq!(
        CanonicalScope::from_term_specs(&[spec]).unwrap_err(),
        ScopeFormError::ConflictingColumns(Dimension::Branch)
    );
}

#[test]
fn malformed_version_range_is_malformed_scope() {
    assert_eq!(
        CanonicalScope::from_term_specs(&[version_range("platform", "not a range")]).unwrap_err(),
        ScopeFormError::InvalidVersionRange(Dimension::Platform)
    );
}

#[test]
fn inverted_or_empty_ranges_are_malformed() {
    assert_eq!(
        CanonicalScope::from_term_specs(&[range("region", Some("m"), Some("a"))]).unwrap_err(),
        ScopeFormError::InvalidRange(Dimension::Region)
    );
    assert_eq!(
        CanonicalScope::from_term_specs(&[range("region", None, None)]).unwrap_err(),
        ScopeFormError::MissingValue(Dimension::Region)
    );
}

#[test]
fn canonicalization_is_idempotent_and_order_insensitive() {
    let forward = scope(&[exact("branch", "main"), set("region", &["b", "a"])]);
    let reversed = scope(&[set("region", &["a", "b"]), exact("branch", "main")]);
    assert_eq!(forward, reversed);
    let dimensions: Vec<Dimension> = forward.terms().map(|(dimension, _)| dimension).collect();
    let mut sorted = dimensions.clone();
    sorted.sort();
    assert_eq!(dimensions, sorted, "terms iterate in dimension order");
}

#[test]
fn redaction_placeholder_branch_decodes_as_placeholder_term() {
    let decoded = scope(&[exact("branch", PLACEHOLDER_BRANCH)]);
    assert_eq!(
        decoded.term(Dimension::Branch),
        Some(&TermValue::RedactedPlaceholder)
    );
}

// ---------------------------------------------------------------------------
// U2: predicate examples.
// ---------------------------------------------------------------------------

#[test]
fn version_range_containment_uses_interval_normalization() {
    let outer = scope(&[version_range("platform", ">=1.0.0, <3.0.0")]);
    let nested = scope(&[version_range("platform", ">=1.2.0, <2.0.0")]);
    let disjoint = scope(&[version_range("platform", ">=3.0.0, <4.0.0")]);
    let touching = scope(&[version_range("platform", ">=2.0.0, <3.0.0")]);
    let oracle = UnknownGraph;
    assert!(scope_subsumes(&outer, &nested, &oracle));
    assert!(!scope_subsumes(&nested, &outer, &oracle));
    assert!(!scope_subsumes(&outer, &disjoint, &oracle));
    assert!(!scope_overlaps(&nested, &disjoint, &oracle));
    // Half-open ends: [1,3) and [3,4) touch without overlapping; [2,3) sits
    // inside [1,3).
    assert!(!scope_overlaps(&outer, &disjoint, &oracle));
    assert!(scope_subsumes(&outer, &touching, &oracle));
}

#[test]
fn prerelease_comparators_follow_the_approximation_rule() {
    let with_pre = scope(&[version_range("platform", ">=1.0.0-beta.1")]);
    let plain = scope(&[version_range("platform", ">=1.0.0")]);
    let oracle = UnknownGraph;
    // No interval reading for pre-release comparators: subsumption
    // under-approximates, overlap over-approximates.
    assert!(!scope_subsumes(&with_pre, &plain, &oracle));
    assert!(!scope_subsumes(&plain, &with_pre, &oracle));
    assert!(scope_overlaps(&with_pre, &plain, &oracle));
    // Identical requirement strings stay decidable.
    assert!(scope_subsumes(&with_pre, &with_pre, &oracle));
}

#[test]
fn version_range_subsumes_matching_exact_value() {
    let req = scope(&[version_range("platform", "=1.2.3")]);
    let value = scope(&[exact("platform", "1.2.3")]);
    let oracle = UnknownGraph;
    assert!(scope_subsumes(&req, &value, &oracle));
    assert!(!scope_subsumes(&value, &req, &oracle));
}

#[test]
fn undecidable_pairs_follow_the_approximation_rule_both_ways() {
    let exact_term = scope(&[exact("branch", "main")]);
    let git_term = scope(&[git_reachable("branch", &oid(1))]);
    let oracle = UnknownGraph;
    for (a, b) in [(&exact_term, &git_term), (&git_term, &exact_term)] {
        assert!(!scope_subsumes(a, b, &oracle));
        assert!(scope_overlaps(a, b, &oracle));
        assert!(!scope_equivalent(a, b, &oracle));
    }
    let other_git = scope(&[git_reachable("branch", &oid(9))]);
    // The unknown oracle cannot decide distinct commits either way.
    assert!(!scope_subsumes(&git_term, &other_git, &oracle));
    assert!(scope_overlaps(&git_term, &other_git, &oracle));
}

#[test]
fn placeholder_terms_never_match_or_subsume() {
    let a = scope(&[exact("branch", PLACEHOLDER_BRANCH)]);
    let b = scope(&[exact("branch", PLACEHOLDER_BRANCH)]);
    let oracle = UnknownGraph;
    assert!(!scope_subsumes(&a, &b, &oracle));
    assert!(!scope_equivalent(&a, &b, &oracle));
    let ctx = ScopeMatchContext::new().with_value(Dimension::Branch, PLACEHOLDER_BRANCH);
    assert_eq!(scope_matches(&a, &ctx, &oracle), MatchOutcome::Uncertain);
    // A placeholder context value is equally unresolvable against an
    // ordinary term.
    let plain = scope(&[exact("branch", "main")]);
    assert_eq!(
        scope_matches(&plain, &ctx, &oracle),
        MatchOutcome::Uncertain
    );
}

#[test]
fn git_terms_decide_through_a_graph_oracle() {
    let oracle = ChainOracle { depth: 4 };
    let older = scope(&[git_reachable("branch", &oid(1))]);
    let newer = scope(&[git_reachable("branch", &oid(2))]);
    // descendants(older) ⊇ descendants(newer): the older commit is the
    // ancestor.
    assert!(scope_subsumes(&older, &newer, &oracle));
    assert!(!scope_subsumes(&newer, &older, &oracle));
    assert!(scope_overlaps(&older, &newer, &oracle));
    let ctx = ScopeMatchContext::new().with_head_commit(oid(3));
    assert_eq!(scope_matches(&older, &ctx, &oracle), MatchOutcome::Matches);
    let ctx_before = ScopeMatchContext::new().with_head_commit(oid(0));
    assert_eq!(
        scope_matches(&newer, &ctx_before, &oracle),
        MatchOutcome::DoesNotMatch
    );
    // Unknown pairs (outside the chain) follow the approximation rule.
    let foreign = scope(&[git_reachable("branch", &oid(0xEE))]);
    assert!(!scope_subsumes(&older, &foreign, &oracle));
    assert!(scope_overlaps(&older, &foreign, &oracle));
    let ctx_unknown = ScopeMatchContext::new().with_head_commit(oid(0xEE));
    assert_eq!(
        scope_matches(&older, &ctx_unknown, &oracle),
        MatchOutcome::Uncertain
    );
}

#[test]
fn missing_context_value_for_constrained_dimension_is_uncertain() {
    let constrained = scope(&[exact("region", "us-east-1")]);
    let ctx = ScopeMatchContext::new();
    assert_eq!(
        scope_matches(&constrained, &ctx, &UnknownGraph),
        MatchOutcome::Uncertain
    );
}

#[test]
fn coerce_version_pads_and_demotes_suffixes() {
    assert_eq!(coerce_version("14.4"), Some(semver::Version::new(14, 4, 0)));
    assert_eq!(coerce_version("14"), Some(semver::Version::new(14, 0, 0)));
    let vendored = coerce_version("1.2.3ubuntu1").expect("vendor suffix coerces");
    assert_eq!((vendored.major, vendored.minor, vendored.patch), (1, 2, 3));
    assert!(
        !vendored.pre.is_empty(),
        "vendor suffix becomes pre-release"
    );
    let build = coerce_version("1.2.3+build.5").expect("build metadata parses");
    assert_eq!((build.major, build.minor, build.patch), (1, 2, 3));
    assert!(build.pre.is_empty());
    assert_eq!(coerce_version("not-a-version"), None);
    assert_eq!(coerce_version(""), None);
}

// ---------------------------------------------------------------------------
// U2: property laws.
// ---------------------------------------------------------------------------

/// Generated value pool kept small so set/range comparisons exercise both
/// containment and disjointness.
fn value_strategy() -> impl Strategy<Value = String> {
    prop::sample::select(vec![
        "alpha".to_string(),
        "beta".to_string(),
        "delta".to_string(),
        "gamma".to_string(),
        "omega".to_string(),
    ])
}

fn term_strategy() -> impl Strategy<Value = TermValueSpec> {
    prop_oneof![
        value_strategy().prop_map(TermValueSpec::Exact),
        prop::collection::btree_set(value_strategy(), 1..4).prop_map(TermValueSpec::Set),
        (value_strategy(), value_strategy()).prop_map(|(a, b)| {
            let (start, end) = if a < b { (a, b) } else { (b, a) };
            TermValueSpec::Range { start, end }
        }),
        (0u64..4, 0u64..4).prop_map(|(lo, span)| TermValueSpec::VersionRange {
            lo,
            hi: lo + span + 1,
        }),
        (0u8..4).prop_map(TermValueSpec::Git),
    ]
}

/// Spec-level term the strategies generate; converts to column specs so the
/// laws exercise the real decode path.
#[derive(Debug, Clone)]
enum TermValueSpec {
    Exact(String),
    Set(BTreeSet<String>),
    Range { start: String, end: String },
    VersionRange { lo: u64, hi: u64 },
    Git(u8),
}

impl TermValueSpec {
    fn to_spec(&self, dimension: Dimension) -> Option<ScopeTermSpec> {
        let name = dimension.as_str();
        match self {
            Self::Exact(value) => Some(exact(name, value)),
            Self::Set(values) => {
                let values: Vec<&str> = values.iter().map(String::as_str).collect();
                Some(set(name, &values))
            }
            Self::Range { start, end } => {
                if start >= end {
                    return None;
                }
                Some(range(name, Some(start), Some(end)))
            }
            Self::VersionRange { lo, hi } => {
                Some(version_range(name, &format!(">={lo}.0.0, <{hi}.0.0")))
            }
            Self::Git(index) => Some(git_reachable(name, &oid(*index))),
        }
    }
}

/// Laws draw dimensions from a three-element pool so two generated scopes
/// share dimensions roughly half the time; over the full ten-dimension
/// vocabulary, non-trivial subsumption pairs almost never arise and the
/// implication laws pass vacuously.
const LAW_DIMENSIONS: [Dimension; 3] = [Dimension::Branch, Dimension::Region, Dimension::Platform];

fn scope_strategy() -> impl Strategy<Value = CanonicalScope> {
    prop::collection::btree_map(
        prop::sample::select(LAW_DIMENSIONS.to_vec()),
        term_strategy(),
        1..3,
    )
    .prop_map(|terms: BTreeMap<Dimension, TermValueSpec>| {
        let specs: Vec<ScopeTermSpec> = terms
            .iter()
            .filter_map(|(dimension, term)| term.to_spec(*dimension))
            .collect();
        scope(&specs)
    })
}

/// Widens one decoded term into a strictly-larger value set, giving the
/// laws a construction-side subsumption witness that does not depend on
/// `scope_subsumes` itself.
fn widen_term(dimension: Dimension, value: &TermValue) -> Option<ScopeTermSpec> {
    let name = dimension.as_str();
    match value {
        TermValue::Exact(value) => Some(set(name, &[value, "zz-widened"])),
        TermValue::Set(values) => {
            let mut widened: Vec<&str> = values.iter().map(String::as_str).collect();
            widened.push("zz-widened");
            Some(set(name, &widened))
        }
        TermValue::Range { start, .. } => Some(range(name, start.as_deref().min(Some("a")), None)),
        TermValue::VersionRange(_) => Some(version_range(name, ">=0.0.0")),
        TermValue::GitReachable(_) => Some(git_reachable(name, &oid(0))),
        TermValue::RedactedPlaceholder => None,
    }
}

/// A scope paired with a widening of itself: every term's value set grows,
/// so the widened scope subsumes the original by construction.
fn widened_pair_strategy() -> impl Strategy<Value = (CanonicalScope, CanonicalScope)> {
    scope_strategy().prop_filter_map("terms must be widenable", |narrow| {
        let widened: Option<Vec<ScopeTermSpec>> = narrow
            .terms()
            .map(|(dimension, term)| widen_term(dimension, term))
            .collect();
        widened.map(|specs| (scope(&specs), narrow))
    })
}

fn context_strategy() -> impl Strategy<Value = ScopeMatchContext> {
    (
        prop::collection::btree_map(
            prop::sample::select(LAW_DIMENSIONS.to_vec()),
            prop_oneof![
                value_strategy(),
                (0u64..6).prop_map(|major| format!("{major}.1.0")),
            ],
            0..4,
        ),
        0u8..4,
    )
        .prop_map(|(values, head)| {
            let mut ctx = ScopeMatchContext::new().with_head_commit(oid(head));
            for (dimension, value) in values {
                ctx = ctx.with_value(dimension, value);
            }
            ctx
        })
}

fn law_oracle() -> ChainOracle {
    // Complete over every generated OID, so approximation never fires inside
    // the law properties.
    ChainOracle { depth: 4 }
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 256,
        rng_algorithm: prop::test_runner::RngAlgorithm::ChaCha,
        rng_seed: prop::test_runner::RngSeed::Fixed(0x5C0BEA16E),
        ..ProptestConfig::default()
    })]

    #[test]
    fn subsumption_is_reflexive(a in scope_strategy()) {
        prop_assert!(scope_subsumes(&a, &a, &law_oracle()));
    }

    #[test]
    fn subsumption_is_transitive(
        a in scope_strategy(),
        b in scope_strategy(),
        c in scope_strategy(),
    ) {
        let oracle = law_oracle();
        if scope_subsumes(&a, &b, &oracle) && scope_subsumes(&b, &c, &oracle) {
            prop_assert!(scope_subsumes(&a, &c, &oracle));
        }
    }

    #[test]
    fn equivalence_is_reflexive_and_symmetric(
        a in scope_strategy(),
        b in scope_strategy(),
    ) {
        let oracle = law_oracle();
        prop_assert!(scope_equivalent(&a, &a, &oracle));
        prop_assert_eq!(
            scope_equivalent(&a, &b, &oracle),
            scope_equivalent(&b, &a, &oracle)
        );
    }

    #[test]
    fn equivalence_is_transitive(
        a in scope_strategy(),
        b in scope_strategy(),
        c in scope_strategy(),
    ) {
        let oracle = law_oracle();
        if scope_equivalent(&a, &b, &oracle) && scope_equivalent(&b, &c, &oracle) {
            prop_assert!(scope_equivalent(&a, &c, &oracle));
        }
    }

    #[test]
    fn subsumption_preserves_matches(
        a in scope_strategy(),
        b in scope_strategy(),
        ctx in context_strategy(),
    ) {
        let oracle = law_oracle();
        if scope_subsumes(&a, &b, &oracle)
            && scope_matches(&b, &ctx, &oracle) == MatchOutcome::Matches
        {
            prop_assert_eq!(scope_matches(&a, &ctx, &oracle), MatchOutcome::Matches);
        }
    }

    #[test]
    fn overlap_is_symmetric(a in scope_strategy(), b in scope_strategy()) {
        let oracle = law_oracle();
        prop_assert_eq!(
            scope_overlaps(&a, &b, &oracle),
            scope_overlaps(&b, &a, &oracle)
        );
    }

    #[test]
    fn subsumption_of_matchable_scope_implies_overlap(
        a in scope_strategy(),
        b in scope_strategy(),
        ctx in context_strategy(),
    ) {
        let oracle = law_oracle();
        // Non-emptiness of `b` is witnessed by a context that matches it.
        if scope_subsumes(&a, &b, &oracle)
            && scope_matches(&b, &ctx, &oracle) == MatchOutcome::Matches
        {
            prop_assert!(scope_overlaps(&a, &b, &oracle));
        }
    }

    #[test]
    fn constructed_widening_subsumes_and_preserves_matches(
        (wide, narrow) in widened_pair_strategy(),
        ctx in context_strategy(),
    ) {
        let oracle = law_oracle();
        // The widening is a subsumption witness built independently of the
        // predicate under test.
        prop_assert!(scope_subsumes(&wide, &narrow, &oracle));
        if scope_matches(&narrow, &ctx, &oracle) == MatchOutcome::Matches {
            prop_assert_eq!(scope_matches(&wide, &ctx, &oracle), MatchOutcome::Matches);
        }
        prop_assert!(scope_overlaps(&wide, &narrow, &oracle));
    }

    #[test]
    fn absent_dimension_scope_subsumes_added_term(
        a in scope_strategy(),
        term in term_strategy(),
    ) {
        let oracle = law_oracle();
        // Adding a term on a dimension `a` leaves open never breaks
        // subsumption of the tightened scope by `a`... provided `a` already
        // subsumes the base scope (reflexivity gives that).
        let open_dimension = Dimension::ALL
            .into_iter()
            .find(|dimension| a.term(*dimension).is_none());
        if let Some(dimension) = open_dimension {
            if let Some(spec) = term.to_spec(dimension) {
                let mut specs: Vec<ScopeTermSpec> = Vec::new();
                for (existing_dimension, existing) in a.terms() {
                    specs.extend(term_value_to_spec(existing_dimension, existing));
                }
                specs.push(spec);
                let tightened = scope(&specs);
                prop_assert!(scope_subsumes(&a, &tightened, &oracle));
            }
        }
    }
}

/// Reconstructs column specs from a decoded term so property tests can
/// tighten an existing scope.
fn term_value_to_spec(dimension: Dimension, value: &TermValue) -> Option<ScopeTermSpec> {
    let name = dimension.as_str();
    match value {
        TermValue::Exact(value) => Some(exact(name, value)),
        TermValue::Set(values) => {
            let values: Vec<&str> = values.iter().map(String::as_str).collect();
            Some(set(name, &values))
        }
        TermValue::Range { start, end } => Some(range(name, start.as_deref(), end.as_deref())),
        TermValue::VersionRange(req) => Some(version_range(name, req)),
        TermValue::GitReachable(oid) => Some(git_reachable(name, oid)),
        TermValue::RedactedPlaceholder => None,
    }
}

#[test]
fn law_generators_reach_nontrivial_subsumption_pairs() {
    use proptest::strategy::ValueTree;
    use proptest::test_runner::TestRunner;
    let mut runner = TestRunner::deterministic();
    let strategy = (scope_strategy(), scope_strategy());
    let oracle = law_oracle();
    let mut nontrivial = 0usize;
    for _ in 0..2_000 {
        let (a, b) = strategy
            .new_tree(&mut runner)
            .expect("strategy generates")
            .current();
        let a_size = a.terms().count();
        if a_size > 0 && b.terms().count() > 0 && a != b && scope_subsumes(&a, &b, &oracle) {
            nontrivial += 1;
        }
    }
    assert!(
        nontrivial >= 50,
        "law generators must reach non-trivial subsumption pairs, got {nontrivial}"
    );
}

#[test]
fn placeholder_terms_decode_on_every_operator_carrier() {
    for spec in [
        set("branch", &["main", PLACEHOLDER_BRANCH]),
        range("branch", Some(PLACEHOLDER_BRANCH), None),
        range("branch", None, Some(PLACEHOLDER_BRANCH)),
    ] {
        assert_eq!(
            scope(std::slice::from_ref(&spec)).term(Dimension::Branch),
            Some(&TermValue::RedactedPlaceholder),
            "{spec:?}"
        );
    }
    // Two different secrets collapse onto one token; they must never be
    // judged equivalent or mutually subsuming.
    let a = scope(&[set("branch", &["x", PLACEHOLDER_BRANCH])]);
    let b = scope(&[set("branch", &["y", PLACEHOLDER_BRANCH])]);
    assert!(!scope_subsumes(&a, &b, &UnknownGraph));
    assert!(!scope_equivalent(&a, &b, &UnknownGraph));
    assert!(scope_overlaps(&a, &b, &UnknownGraph));
}

#[test]
fn contradictory_version_ranges_are_empty_sets() {
    let empty = scope(&[version_range("platform", ">=3.0.0, <2.0.0")]);
    let point = scope(&[version_range("platform", "=1.0.0")]);
    // Everything subsumes the empty set; nothing overlaps it.
    assert!(scope_subsumes(&point, &empty, &UnknownGraph));
    assert!(!scope_overlaps(&point, &empty, &UnknownGraph));
}

#[test]
fn coerce_version_rejects_components_after_a_vendor_suffix() {
    assert_eq!(coerce_version("1foo.9.9"), None);
    assert_eq!(coerce_version("1.2foo.9"), None);
    assert!(coerce_version("1.2.3foo").is_some());
}
