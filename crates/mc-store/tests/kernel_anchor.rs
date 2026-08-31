//! Anchor vocabulary proofs: typed decode from frozen `anchors` columns and
//! non-git evaluation against an explicit query context.

use mc_store::kernel::{
    encode_anchor_captures, evaluate_non_git, AnchorCapture, AnchorCondition, AnchorDecodeError,
    AnchorEvaluation, AnchorKind, AnchorRowSpec, GitCondition, PatchIdCapture, QueryContext,
};

fn oid(byte: u8) -> String {
    format!("{byte:02x}").repeat(20)
}

fn row(kind: &str) -> AnchorRowSpec {
    AnchorRowSpec {
        anchor_id: "anchor".to_string(),
        anchor_kind: kind.to_string(),
        ..AnchorRowSpec::default()
    }
}

fn decode(row: &AnchorRowSpec) -> AnchorCondition {
    AnchorCondition::decode(row).expect("fixture anchor decodes")
}

#[test]
fn exact_anchor_compares_against_the_context_token() {
    let condition = decode(&AnchorRowSpec {
        exact_value: Some("pinned-token".to_string()),
        ..row("exact")
    });
    let holds = QueryContext {
        exact_token: Some("pinned-token".to_string()),
        ..QueryContext::default()
    };
    let fails = QueryContext {
        exact_token: Some("other".to_string()),
        ..QueryContext::default()
    };
    assert_eq!(
        evaluate_non_git(&condition, &holds),
        AnchorEvaluation::Holds
    );
    assert_eq!(
        evaluate_non_git(&condition, &fails),
        AnchorEvaluation::DoesNotHold { historical: false }
    );
    assert_eq!(
        evaluate_non_git(&condition, &QueryContext::default()),
        AnchorEvaluation::Uncertain
    );
}

#[test]
fn deployment_and_config_revisions_hold_fail_and_stay_uncertain() {
    for (kind, context_field) in [
        ("deployment_revision", "deployment"),
        ("config_revision", "config"),
    ] {
        let mut spec = row(kind);
        match kind {
            "deployment_revision" => spec.deployment_revision = Some("rev-42".to_string()),
            _ => spec.config_revision = Some("rev-42".to_string()),
        }
        let condition = decode(&spec);
        let mut ctx = QueryContext::default();
        match context_field {
            "deployment" => ctx.deployment_revision = Some("rev-42".to_string()),
            _ => ctx.config_revision = Some("rev-42".to_string()),
        }
        assert_eq!(evaluate_non_git(&condition, &ctx), AnchorEvaluation::Holds);
        match context_field {
            "deployment" => ctx.deployment_revision = Some("rev-43".to_string()),
            _ => ctx.config_revision = Some("rev-43".to_string()),
        }
        assert_eq!(
            evaluate_non_git(&condition, &ctx),
            AnchorEvaluation::DoesNotHold { historical: false }
        );
        assert_eq!(
            evaluate_non_git(&condition, &QueryContext::default()),
            AnchorEvaluation::Uncertain
        );
    }
}

#[test]
fn platform_version_evaluates_at_range_edges() {
    let condition = decode(&AnchorRowSpec {
        platform_version_range: Some(">=1.2.0, <2.0.0".to_string()),
        ..row("platform_version")
    });
    let with_version = |version: &str| QueryContext {
        platform_version: Some(version.to_string()),
        ..QueryContext::default()
    };
    assert_eq!(
        evaluate_non_git(&condition, &with_version("1.2.0")),
        AnchorEvaluation::Holds
    );
    assert_eq!(
        evaluate_non_git(&condition, &with_version("2.0.0")),
        AnchorEvaluation::DoesNotHold { historical: false }
    );
    assert_eq!(
        evaluate_non_git(&condition, &with_version("1.999.999")),
        AnchorEvaluation::Holds
    );
}

#[test]
fn platform_version_coerces_non_semver_context_values() {
    let condition = decode(&AnchorRowSpec {
        platform_version_range: Some(">=14.0.0, <15.0.0".to_string()),
        ..row("platform_version")
    });
    let with_version = |version: &str| QueryContext {
        platform_version: Some(version.to_string()),
        ..QueryContext::default()
    };
    // Two-component versions pad to semver.
    assert_eq!(
        evaluate_non_git(&condition, &with_version("14.4")),
        AnchorEvaluation::Holds
    );
    // Vendor-suffixed build strings demote the suffix to a pre-release
    // rather than failing the parse; pre-releases do not match a plain
    // range, so the verdict is a definite non-match, not a panic.
    assert_eq!(
        evaluate_non_git(&condition, &with_version("14.4.1ubuntu3")),
        AnchorEvaluation::DoesNotHold { historical: false }
    );
    // Unparseable strings are uncertain, never a match and never a panic.
    assert_eq!(
        evaluate_non_git(&condition, &with_version("not-a-version")),
        AnchorEvaluation::Uncertain
    );
}

#[test]
fn wall_clock_interval_is_half_open() {
    let condition = decode(&AnchorRowSpec {
        wall_clock_start: Some(1_000),
        wall_clock_end: Some(2_000),
        ..row("wall_clock_interval")
    });
    let at = |instant: i64| QueryContext {
        query_instant_ms: Some(instant),
        ..QueryContext::default()
    };
    assert_eq!(
        evaluate_non_git(&condition, &at(1_000)),
        AnchorEvaluation::Holds
    );
    assert_eq!(
        evaluate_non_git(&condition, &at(2_000)),
        AnchorEvaluation::DoesNotHold { historical: true }
    );
    assert_eq!(
        evaluate_non_git(&condition, &at(999)),
        AnchorEvaluation::DoesNotHold { historical: false }
    );
    assert_eq!(
        evaluate_non_git(&condition, &QueryContext::default()),
        AnchorEvaluation::Uncertain
    );
}

#[test]
fn git_kinds_decode_into_resolution_requests() {
    let capture = AnchorCapture {
        commit_oid: oid(3),
        tree_oid: Some(oid(4)),
        patch_id: Some(PatchIdCapture {
            algorithm: "mc-patch-id-v1".to_string(),
            value: "aa".repeat(32),
        }),
        changed_paths: vec!["src/lib.rs".to_string()],
    };
    let reachable = decode(&AnchorRowSpec {
        reachable_from_oid: Some(oid(3)),
        payload: Some(encode_anchor_captures(std::slice::from_ref(&capture))),
        ..row("reachable_from")
    });
    match &reachable {
        AnchorCondition::Git(GitCondition::ReachableFrom {
            oid: anchor,
            captures,
        }) => {
            assert_eq!(anchor, &oid(3));
            assert_eq!(captures.get(&oid(3)), Some(&capture));
        }
        other => panic!("expected reachable_from, got {other:?}"),
    }
    assert_eq!(
        evaluate_non_git(&reachable, &QueryContext::default()),
        AnchorEvaluation::NeedsGitResolution
    );
    let between = decode(&AnchorRowSpec {
        reachable_between_start_oid: Some(oid(1)),
        reachable_between_end_oid: Some(oid(2)),
        ..row("reachable_between")
    });
    assert!(matches!(
        between,
        AnchorCondition::Git(GitCondition::ReachableBetween { .. })
    ));
}

#[test]
fn unknown_kind_and_missing_values_fail_decode() {
    assert_eq!(
        AnchorCondition::decode(&row("symbol_hash")).unwrap_err(),
        AnchorDecodeError::UnknownKind("symbol_hash".to_string())
    );
    assert_eq!(
        AnchorCondition::decode(&row("exact")).unwrap_err(),
        AnchorDecodeError::MissingValue(AnchorKind::Exact)
    );
    assert_eq!(
        AnchorCondition::decode(&AnchorRowSpec {
            reachable_from_oid: Some("not-an-oid".to_string()),
            ..row("reachable_from")
        })
        .unwrap_err(),
        AnchorDecodeError::InvalidOid(AnchorKind::ReachableFrom)
    );
    assert_eq!(
        AnchorCondition::decode(&AnchorRowSpec {
            wall_clock_start: Some(5),
            wall_clock_end: Some(5),
            ..row("wall_clock_interval")
        })
        .unwrap_err(),
        AnchorDecodeError::InvalidInterval
    );
    assert_eq!(
        AnchorCondition::decode(&AnchorRowSpec {
            platform_version_range: Some("banana".to_string()),
            ..row("platform_version")
        })
        .unwrap_err(),
        AnchorDecodeError::InvalidVersionRange
    );
}

#[test]
fn corrupt_capture_payload_only_disables_fallback_rungs() {
    let condition = decode(&AnchorRowSpec {
        reachable_from_oid: Some(oid(3)),
        payload: Some(b"not json".to_vec()),
        ..row("reachable_from")
    });
    match condition {
        AnchorCondition::Git(GitCondition::ReachableFrom { captures, .. }) => {
            assert!(captures.is_empty());
        }
        other => panic!("expected reachable_from, got {other:?}"),
    }
}
