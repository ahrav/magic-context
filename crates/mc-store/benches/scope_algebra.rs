use std::hint::black_box;

use criterion::{criterion_group, criterion_main, Criterion};
use mc_store::kernel::{
    coerce_version, scope_matches, scope_overlaps, scope_subsumes, CanonicalScope, Dimension,
    GraphOracle, ScopeMatchContext, ScopeTermSpec, UnknownGraph,
};
use sha2::{Digest, Sha256};

/// `YesOracle` returns `Some(true)` for every graph query, avoiding the
/// approximation fallback in git-term benchmarks.
struct YesOracle;

impl GraphOracle for YesOracle {
    fn is_ancestor_or_equal(&self, _ancestor: &str, _descendant: &str) -> Option<bool> {
        Some(true)
    }
}

fn spec(dimension: &str, operator: &str) -> ScopeTermSpec {
    ScopeTermSpec {
        dimension: dimension.to_string(),
        operator: operator.to_string(),
        ..ScopeTermSpec::default()
    }
}

fn exact(dimension: &str, value: &str) -> ScopeTermSpec {
    ScopeTermSpec {
        exact_value: Some(value.to_string()),
        ..spec(dimension, "exact")
    }
}

fn set(dimension: &str, values: &[&str]) -> ScopeTermSpec {
    ScopeTermSpec {
        set_values: Some(values.iter().map(|v| v.to_string()).collect()),
        ..spec(dimension, "set")
    }
}

fn version_range(dimension: &str, req: &str) -> ScopeTermSpec {
    ScopeTermSpec {
        version_range: Some(req.to_string()),
        ..spec(dimension, "version_range")
    }
}

fn git_reachable(oid: &str) -> ScopeTermSpec {
    ScopeTermSpec {
        git_oid: Some(oid.to_string()),
        ..spec("branch", "git_reachable")
    }
}

const OID_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OID_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn one_exact() -> Vec<ScopeTermSpec> {
    vec![exact("project", "magic-context")]
}

fn mixed_three() -> Vec<ScopeTermSpec> {
    vec![
        exact("project", "magic-context"),
        set("environment", &["prod", "staging", "gamma"]),
        version_range("platform", ">=1.2.0, <2.0.0"),
    ]
}

fn git_one() -> Vec<ScopeTermSpec> {
    vec![git_reachable(OID_A)]
}

fn matching_context() -> ScopeMatchContext {
    ScopeMatchContext::new()
        .with_value(Dimension::Project, "magic-context")
        .with_value(Dimension::Environment, "prod")
        .with_value(Dimension::Platform, "1.4.7")
        .with_head_commit(OID_B)
}

fn bench_decode(c: &mut Criterion) {
    let mut group = c.benchmark_group("decode");
    let one = one_exact();
    let three = mixed_three();
    let git = git_one();
    group.bench_function("empty", |b| {
        b.iter(|| CanonicalScope::from_term_specs(black_box(&[])).unwrap())
    });
    group.bench_function("one_exact", |b| {
        b.iter(|| CanonicalScope::from_term_specs(black_box(&one)).unwrap())
    });
    group.bench_function("mixed_three", |b| {
        b.iter(|| CanonicalScope::from_term_specs(black_box(&three)).unwrap())
    });
    group.bench_function("git_one", |b| {
        b.iter(|| CanonicalScope::from_term_specs(black_box(&git)).unwrap())
    });
    group.finish();
}

fn bench_matches(c: &mut Criterion) {
    let mut group = c.benchmark_group("matches");
    let ctx = matching_context();
    let exact_scope = CanonicalScope::from_term_specs(&one_exact()).unwrap();
    let set_scope =
        CanonicalScope::from_term_specs(&[set("environment", &["prod", "staging", "gamma"])])
            .unwrap();
    let vr_scope =
        CanonicalScope::from_term_specs(&[version_range("platform", ">=1.2.0, <2.0.0")]).unwrap();
    let mixed_scope = CanonicalScope::from_term_specs(&mixed_three()).unwrap();
    let git_scope = CanonicalScope::from_term_specs(&git_one()).unwrap();

    group.bench_function("one_exact", |b| {
        b.iter(|| scope_matches(black_box(&exact_scope), black_box(&ctx), &UnknownGraph))
    });
    group.bench_function("one_set", |b| {
        b.iter(|| scope_matches(black_box(&set_scope), black_box(&ctx), &UnknownGraph))
    });
    group.bench_function("one_version_range", |b| {
        b.iter(|| scope_matches(black_box(&vr_scope), black_box(&ctx), &UnknownGraph))
    });
    group.bench_function("mixed_three", |b| {
        b.iter(|| scope_matches(black_box(&mixed_scope), black_box(&ctx), &UnknownGraph))
    });
    group.bench_function("git_yes_oracle", |b| {
        b.iter(|| scope_matches(black_box(&git_scope), black_box(&ctx), &YesOracle))
    });
    group.finish();
}

fn bench_decode_plus_match(c: &mut Criterion) {
    let mut group = c.benchmark_group("decode_plus_match");
    let ctx = matching_context();
    let three = mixed_three();
    group.bench_function("mixed_three", |b| {
        b.iter(|| {
            let scope = CanonicalScope::from_term_specs(black_box(&three)).unwrap();
            scope_matches(&scope, black_box(&ctx), &UnknownGraph)
        })
    });
    group.finish();
}

fn bench_coerce_version(c: &mut Criterion) {
    let mut group = c.benchmark_group("coerce_version");
    for raw in [
        "1.2.3",
        "14",
        "3ubuntu1",
        "1.2.3-beta.1+build5",
        "10.04_LTS",
    ] {
        group.bench_function(raw, |b| b.iter(|| coerce_version(black_box(raw))));
    }
    group.finish();
}

fn bench_pairwise(c: &mut Criterion) {
    let mut group = c.benchmark_group("pairwise");
    let vr_scope =
        CanonicalScope::from_term_specs(&[version_range("platform", ">=1.2.0, <2.0.0")]).unwrap();
    let set_scope = CanonicalScope::from_term_specs(&[ScopeTermSpec {
        set_values: Some(vec![
            "1.3.0".to_string(),
            "1.4.0".to_string(),
            "1.5.0".to_string(),
        ]),
        ..spec("platform", "set")
    }])
    .unwrap();
    group.bench_function("subsumes_vr_vs_set3", |b| {
        b.iter(|| scope_subsumes(black_box(&vr_scope), black_box(&set_scope), &UnknownGraph))
    });
    group.bench_function("overlaps_vr_vs_set3", |b| {
        b.iter(|| scope_overlaps(black_box(&vr_scope), black_box(&set_scope), &UnknownGraph))
    });
    group.finish();
}

fn bench_digest_shape(c: &mut Criterion) {
    let mut group = c.benchmark_group("digest_shape");
    let terms = mixed_three();
    group.bench_function("debug_format", |b| {
        b.iter(|| {
            let mut hash = Sha256::new();
            let terms = black_box(&terms);
            hash.update(format!("{terms:?}").as_bytes());
            format!("{:x}", hash.finalize())
        })
    });
    group.bench_function("direct_fields", |b| {
        b.iter(|| {
            let mut hash = Sha256::new();
            let mut update_opt = |field: Option<&str>| {
                hash.update(field.unwrap_or("<none>").as_bytes());
                hash.update(b"\0");
            };
            for term in black_box(&terms) {
                update_opt(Some(&term.dimension));
                update_opt(Some(&term.operator));
                update_opt(term.exact_value.as_deref());
                match &term.set_values {
                    Some(values) => {
                        for value in values {
                            update_opt(Some(value));
                        }
                    }
                    None => update_opt(None),
                }
                update_opt(term.range_start.as_deref());
                update_opt(term.range_end.as_deref());
                update_opt(term.version_range.as_deref());
                update_opt(term.git_oid.as_deref());
                update_opt(term.git_start_oid.as_deref());
                update_opt(term.git_end_oid.as_deref());
                update_opt(term.payload.as_deref());
            }
            format!("{:x}", hash.finalize())
        })
    });
    group.finish();
}

criterion_group!(
    benches,
    bench_decode,
    bench_matches,
    bench_decode_plus_match,
    bench_coerce_version,
    bench_pairwise,
    bench_digest_shape,
);
criterion_main!(benches);
