//! This module validates ordered stored compartment ranges and partitions them for m0/m1 rendering.
//!
//! The functions are pure over compartments in the order McStore::load_compartments returns.
//! resolve_coverage rejects non-increasing or overlapping stored compartment ranges.
//! resolve_coverage returns the last compartment's end_message and end_message_id as the coverage end.
//! resolve_coverage uses the returned coverage end as the combined m0/m1 coverage anchor.
//! resolve_coverage permits sparse coordinate gaps because store data cannot distinguish retired ordinals from missing live messages.
//!    gaps are allowed here and live-aware callers guard against dropping present input.

use mc_store::StoredCompartment;

/// M0ContentEpoch fields trigger a HARD fold when their changes alter frozen m0 without a cheaper correction.
/// Changes to composition and structure fields change `render_config` and trigger a HARD fold.
/// Named fields preserve which M0ContentEpoch component changed in render_config diffs.
///
/// Discrete memories, sequenced compartments, and additive profile entries use m1 corrections instead of HARD folds.
/// New memories append on m1, and in-session memory edits use <memory-updates>.
/// A SOFT fold leaves m0 frozen while m1 carries these corrections.
/// A docs-only edit does not evict the cached m0 prefix.
/// Project docs fold into m0 during the next HARD fold caused by another change.
/// docs_hash is persisted with rendered m0 bytes as a snapshot marker.
/// docs_hash is a snapshot marker, not a HARD-fold trigger.
///
///
/// Content-only staleness may defer until the next HARD fold; composition changes require a HARD.
/// Changes to `workspace_fingerprint`, `upgrade_state`, or the external memory epoch require a HARD because they alter m0 composition or format.
/// An external memory-epoch change requires a HARD because m0 cannot otherwise observe the out-of-process edit.
/// Structure staleness requires a HARD fold.
/// Only composition and structure markers belong in this struct.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct M0ContentEpoch {
    /// `workspace_fingerprint` tracks workspace membership and shared-category policy for visible foreign memories.
    /// visible.
    pub workspace_fingerprint: String,
    /// A session upgrade rewrites the memory pool under the current taxonomy, changing `upgrade_state`.
    pub upgrade_state: String,
    /// `memory_content_epoch` changes only for out-of-process edits or session-upgrade migrations; in-session mutations use the m1 delta.
    /// An out-of-process edit changes `memory_content_epoch` because it creates no mutation-log row.
    /// `memory_content_epoch` changes force HARD invalidation.
    /// `memory_content_epoch` must not derive from the mutation log; otherwise in-session edits would force HARD invalidation.
    pub memory_content_epoch: String,
    /// `memory_render_epoch` coordinates one HARD fold across serializer profiles when the shared memory block format changes.
    /// An empty `memory_render_epoch` denotes epoch zero and is omitted from the folded identity.
    pub memory_render_epoch: String,
    /// `compartment_render_epoch` coordinates one HARD fold across serializer profiles when compartment history bytes change.
    /// An empty `compartment_render_epoch` denotes epoch zero and is omitted from the folded identity.
    pub compartment_render_epoch: String,
    /// `profile_render_epoch` coordinates one HARD transition per session when the serializer format changes.
    /// `profile_render_epoch` coordinates one HARD transition per session independently of the caller's `render_config`.
    /// An empty `profile_render_epoch` denotes epoch zero and is omitted from the folded identity.
    pub profile_render_epoch: String,
    /// `prompt_surface_epoch` combines guidance and tool-manifest identities for the selected prompt.
    pub prompt_surface_epoch: String,
    /// An empty `tagger_feature_epoch` is omitted so a disabled tag surface preserves existing effective render identities.
    pub tagger_feature_epoch: String,
    pub transition_epoch: String,
}

/// Any difference in `base_render_config` or an epoch field changes the returned string.
/// The encoding length-prefixes each field so no value can forge a field boundary.
pub fn fold_m0_content_epoch(base_render_config: &str, epoch: &M0ContentEpoch) -> String {
    fn part(label: &str, value: &str) -> String {
        format!("{label}:{}:{value}", value.len())
    }
    let mut parts = vec![
        part("ws", &epoch.workspace_fingerprint),
        part("upg", &epoch.upgrade_state),
        part("mem", &epoch.memory_content_epoch),
    ];
    if !epoch.memory_render_epoch.is_empty() {
        parts.push(part("mre", &epoch.memory_render_epoch));
    }
    if !epoch.compartment_render_epoch.is_empty() {
        parts.push(part("cre", &epoch.compartment_render_epoch));
    }
    if !epoch.profile_render_epoch.is_empty() {
        parts.push(part("mpe", &epoch.profile_render_epoch));
    }
    if !epoch.prompt_surface_epoch.is_empty() {
        parts.push(part("pse", &epoch.prompt_surface_epoch));
    }
    if !epoch.tagger_feature_epoch.is_empty() {
        parts.push(part("tfe", &epoch.tagger_feature_epoch));
    }
    if !epoch.transition_epoch.is_empty() {
        parts.push(part("xte", &epoch.transition_epoch));
    }
    format!("{base_render_config}|m0epoch[{}]", parts.join(";"))
}

/// `CompartmentCoverage` records the latest sequence, terminal covered ordinal, and cache anchor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompartmentCoverage {
    pub max_sequence: i64,
    /// `first_covered_ordinal` marks the leading edge of m0 coverage.
    /// The caller rejects a live item below `start_message` to prevent a silent leading-gap drop.
    pub first_covered_ordinal: u64,
    /// `coverage_end_ordinal` marks the m0+m1 coverage end ordinal.
    /// `coverage_end_ordinal` is the tail-trim point: items with greater ordinals form the live tail.
    pub coverage_end_ordinal: u64,
    /// The last compartment's `end_message_id` is the cache/revert anchor.
    pub boundary_id: String,
}

/// `CoverageGap` reports overlapping or non-increasing compartments.
/// Overlaps are legal for consumer legs because retired ordinals are absent from the input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoverageGap {
    pub prev_end: i64,
    pub next_start: i64,
}

impl std::fmt::Display for CoverageGap {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "compartment coverage overlap: a compartment ends at ordinal {} but the next starts at {}; ranges must be strictly increasing",
            self.prev_end, self.next_start
        )
    }
}

/// overlap found.
///
/// The store-only check rejects overlaps (`next.start_message <= prev.end_message`) but allows coordinate gaps.
pub fn resolve_coverage(
    compartments: &[StoredCompartment],
) -> Result<Option<CompartmentCoverage>, CoverageGap> {
    let Some(first) = compartments.first() else {
        return Ok(None);
    };
    let mut prev = first;
    for next in &compartments[1..] {
        if next.start_message <= prev.end_message {
            return Err(CoverageGap {
                prev_end: prev.end_message,
                next_start: next.start_message,
            });
        }
        prev = next;
    }
    let last = compartments.last().expect("non-empty checked above");
    Ok(Some(CompartmentCoverage {
        max_sequence: compartments.iter().map(|c| c.sequence).max().unwrap_or(0),
        first_covered_ordinal: first.start_message.max(0) as u64,
        coverage_end_ordinal: last.end_message.max(0) as u64,
        boundary_id: last.end_message_id.clone(),
    }))
}

pub fn partition_by_folded_seq(
    compartments: &[StoredCompartment],
    folded_seq: i64,
) -> (Vec<&StoredCompartment>, Vec<&StoredCompartment>) {
    compartments.iter().partition(|c| c.sequence <= folded_seq)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comp(seq: i64, start: i64, end: i64, end_id: &str) -> StoredCompartment {
        StoredCompartment {
            sequence: seq,
            start_message: start,
            end_message: end,
            end_message_id: end_id.to_string(),
            title: format!("c{seq}"),
            content: "x".into(),
            p1: Some("x".into()),
            importance: 50,
            ..Default::default()
        }
    }

    #[test]
    fn empty_set_has_no_coverage() {
        assert_eq!(resolve_coverage(&[]), Ok(None));
    }

    #[test]
    fn ordered_set_reports_last_as_coverage() {
        let comps = vec![
            comp(1, 1, 10, "m10"),
            comp(2, 11, 20, "m20"),
            comp(3, 21, 30, "m30"),
        ];
        let cov = resolve_coverage(&comps).unwrap().unwrap();
        assert_eq!(cov.max_sequence, 3);
        assert_eq!(cov.coverage_end_ordinal, 30);
        assert_eq!(cov.boundary_id, "m30");
    }

    #[test]
    fn single_compartment_is_its_own_coverage() {
        let cov = resolve_coverage(&[comp(1, 1, 9, "m9")]).unwrap().unwrap();
        assert_eq!(cov.max_sequence, 1);
        assert_eq!(cov.coverage_end_ordinal, 9);
        assert_eq!(cov.boundary_id, "m9");
    }

    #[test]
    fn sparse_coordinate_gap_is_store_pure_valid() {
        let comps = vec![comp(1, 1, 10, "m10"), comp(2, 20, 30, "m30")];
        let cov = resolve_coverage(&comps).unwrap().unwrap();
        assert_eq!(cov.coverage_end_ordinal, 30);
        assert_eq!(cov.boundary_id, "m30");
    }

    #[test]
    fn an_overlap_fails_loud() {
        let comps = vec![comp(1, 1, 10, "m10"), comp(2, 8, 15, "m15")];
        assert!(resolve_coverage(&comps).is_err());
    }

    #[test]
    fn m0_content_epoch_folds_legibly_and_deterministically() {
        let base = "sys0|tools0|model0|prof0";
        let epoch = M0ContentEpoch {
            workspace_fingerprint: "wf1".into(),
            upgrade_state: "u1".into(),
            memory_content_epoch: "mc1".into(),
            memory_render_epoch: String::new(),
            compartment_render_epoch: String::new(),
            profile_render_epoch: String::new(),
            prompt_surface_epoch: String::new(),
            tagger_feature_epoch: String::new(),
            transition_epoch: String::new(),
        };
        let folded = fold_m0_content_epoch(base, &epoch);
        assert_eq!(
            folded, "sys0|tools0|model0|prof0|m0epoch[ws:3:wf1;upg:2:u1;mem:3:mc1]",
            "omitted epoch-zero fields must not change existing render identities"
        );
        assert!(folded.starts_with(base));
        assert!(folded.contains("ws:3:wf1"));
        assert!(folded.contains("mem:3:mc1"));
        assert!(!folded.contains("mre:"), "global epoch zero must be inert");
        assert!(
            !folded.contains("cre:"),
            "compartment epoch zero must not add a component"
        );
        assert!(
            !folded.contains("mpe:"),
            "profile epoch zero must not add a component"
        );
        assert!(
            !folded.contains("pse:"),
            "default prompt surface must leave the identity byte-identical"
        );
        assert!(
            !folded.contains("tfe:"),
            "tagger epoch zero must leave the identity byte-identical"
        );
        let mut memory_render_epoch = epoch.clone();
        memory_render_epoch.memory_render_epoch = "mre1".into();
        let memory_render_folded = fold_m0_content_epoch(base, &memory_render_epoch);
        assert!(memory_render_folded.contains("mre:4:mre1"));
        assert_ne!(folded, memory_render_folded);

        let mut compartment_render_epoch = epoch.clone();
        compartment_render_epoch.compartment_render_epoch = "cre1".into();
        let compartment_render_folded = fold_m0_content_epoch(base, &compartment_render_epoch);
        assert!(compartment_render_folded.contains("cre:4:cre1"));
        assert_ne!(folded, compartment_render_folded);

        let mut profile_epoch = epoch.clone();
        profile_epoch.profile_render_epoch = "mpe1".into();
        let profile_folded = fold_m0_content_epoch(base, &profile_epoch);
        assert!(profile_folded.contains("mpe:4:mpe1"));
        assert_ne!(folded, profile_folded);

        let mut prompt_surface_epoch = epoch.clone();
        prompt_surface_epoch.prompt_surface_epoch = "ps1".into();
        let prompt_surface_folded = fold_m0_content_epoch(base, &prompt_surface_epoch);
        assert!(prompt_surface_folded.contains("pse:3:ps1"));
        assert_ne!(folded, prompt_surface_folded);

        let mut tagger_epoch = epoch.clone();
        tagger_epoch.tagger_feature_epoch = "tfe1".into();
        let tagger_folded = fold_m0_content_epoch(base, &tagger_epoch);
        assert!(tagger_folded.contains("tfe:4:tfe1"));
        assert_ne!(folded, tagger_folded);

        let mut transition_epoch = epoch.clone();
        transition_epoch.transition_epoch = "renderer-transition-v1".into();
        let transition_folded = fold_m0_content_epoch(base, &transition_epoch);
        assert!(transition_folded.contains("xte:22:renderer-transition-v1"));
        assert_ne!(folded, transition_folded);
        assert!(!folded.contains("docs"));
        assert_eq!(folded, fold_m0_content_epoch(base, &epoch));

        let mut e2 = epoch.clone();
        e2.memory_content_epoch = "mc2".into();
        assert_ne!(folded, fold_m0_content_epoch(base, &e2));
        let mut e3 = epoch.clone();
        e3.upgrade_state = "u2".into();
        assert_ne!(folded, fold_m0_content_epoch(base, &e3));

        let forge_a = M0ContentEpoch {
            workspace_fingerprint: "a".into(),
            upgrade_state: "bc".into(),
            ..Default::default()
        };
        let forge_b = M0ContentEpoch {
            workspace_fingerprint: "ab".into(),
            upgrade_state: "c".into(),
            ..Default::default()
        };
        assert_ne!(
            fold_m0_content_epoch(base, &forge_a),
            fold_m0_content_epoch(base, &forge_b)
        );
    }

    #[test]
    fn partition_splits_at_folded_seq() {
        let comps = vec![
            comp(1, 1, 10, "m10"),
            comp(2, 11, 20, "m20"),
            comp(3, 21, 30, "m30"),
        ];
        let (folded, new) = partition_by_folded_seq(&comps, 1);
        assert_eq!(
            folded.iter().map(|c| c.sequence).collect::<Vec<_>>(),
            vec![1]
        );
        assert_eq!(
            new.iter().map(|c| c.sequence).collect::<Vec<_>>(),
            vec![2, 3]
        );

        let (folded0, new0) = partition_by_folded_seq(&comps, 0);
        assert!(folded0.is_empty());
        assert_eq!(new0.len(), 3);

        let (folded_all, new_all) = partition_by_folded_seq(&comps, 3);
        assert_eq!(folded_all.len(), 3);
        assert!(new_all.is_empty());
    }
}
