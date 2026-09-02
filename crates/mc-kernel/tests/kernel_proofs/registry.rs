//! Policy-matrix registry: every kh8.1 policy row and every kh8 R8
//! obligation is a variant of an exhaustive enum whose `row()` names its
//! status, so a declared row cannot lack an entry. `Landed` rows name tests
//! that must exist as `#[test]` functions in the declared source file, with
//! any `#[ignore]` carrying a runnable rerun command. `Pending` rows name an
//! owner bead from `KNOWN_BEADS` and the tests expected to land, and fail as
//! soon as one of those tests exists without the row being promoted.
//! `Contradiction` rows name the filed bead and the contradicted policy text.
//!
//! Sources are read at test time from the declared paths under
//! `CARGO_MANIFEST_DIR`, not embedded with `include_str!`, because a pending
//! row's expected file may not exist yet and the validator has to observe
//! that absence. The validator itself is a pure function over rows and a
//! path catalog so its negative controls run on hand-built catalogs.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

/// One test the registry resolves: `path` is relative to the crate root and
/// `function` is the bare function name, so a test named in the wrong file
/// fails to resolve rather than matching a same-named function elsewhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Test {
    pub path: &'static str,
    pub function: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub enum Status {
    Landed {
        tests: &'static [Test],
    },
    Pending {
        owner_bead: &'static str,
        expected_tests: &'static [Test],
    },
    Contradiction {
        bead: &'static str,
        policy_text: &'static str,
    },
}

#[derive(Debug, Clone, Copy)]
pub struct Row {
    pub id: &'static str,
    pub claim: &'static str,
    pub status: Status,
}

/// Every bead a `Pending` or `Contradiction` row may name. Adding a row of
/// either kind is a reviewed edit here; the epic-close gate requires this
/// list to be empty.
pub const KNOWN_BEADS: &[&str] = &[
    "magic-context-kh8.8",
    "magic-context-kh8.10",
    "magic-context-3q5.9",
    "magic-context-3q5.15",
    "magic-context-kh8.18",
    "magic-context-kh8.21",
    "magic-context-kh8.22",
    "magic-context-kh8.24",
    "magic-context-kh8.25",
    "magic-context-kh8.26",
    "magic-context-kh8.27",
    "magic-context-kh8.28",
    "magic-context-kh8.30",
];

const KERNEL_ADMISSION: &str = "tests/kernel_admission.rs";
const KERNEL_ANCHOR_RESOLUTION: &str = "tests/kernel_anchor_resolution.rs";
const KERNEL_APPLICABILITY_ACCEPTANCE: &str = "tests/kernel_applicability_acceptance.rs";
const KERNEL_BACKUP: &str = "tests/kernel_backup.rs";
const KERNEL_CAS: &str = "tests/kernel_cas.rs";
const CAS_FAULT_INJECTION: &str = "tests/cas_fault_injection.rs";
const KERNEL_DELETION: &str = "tests/kernel_deletion.rs";
const KERNEL_ENVELOPE: &str = "tests/kernel_envelope.rs";
const KERNEL_FACTS: &str = "tests/kernel_facts.rs";
const KERNEL_GC: &str = "tests/kernel_gc.rs";
const KERNEL_OPEN: &str = "tests/kernel_open.rs";
const KERNEL_OUTBOX: &str = "tests/kernel_outbox.rs";
const KERNEL_REDACTION: &str = "tests/kernel_redaction.rs";
const KERNEL_RETENTION: &str = "tests/kernel_retention.rs";
const KERNEL_SCHEMA: &str = "tests/kernel_schema.rs";
const KERNEL_SCOPE_ALGEBRA: &str = "tests/kernel_scope_algebra.rs";
const KERNEL_SLICE_FIXTURES: &str = "tests/kernel_slice_fixtures.rs";
const DURABLE_FS: &str = "src/durable_fs.rs";
const PROOFS_O1: &str = "tests/kernel_proofs/obligations/o1_staging.rs";
const PROOFS_O2: &str = "tests/kernel_proofs/obligations/o2_atomic_repair.rs";
const PROOFS_O3: &str = "tests/kernel_proofs/obligations/o3_branch.rs";
const PROOFS_O5: &str = "tests/kernel_proofs/obligations/o5_correction.rs";
const PROOFS_O6: &str = "tests/kernel_proofs/obligations/o6_deletion.rs";
const PROOFS_O7: &str = "tests/kernel_proofs/obligations/o7_stale.rs";
const PROOFS_O8: &str = "tests/kernel_proofs/obligations/o8_restart_backup.rs";
const PROOFS_O9: &str = "tests/kernel_proofs/obligations/o9_egress.rs";
const PROOFS_O10: &str = "tests/kernel_proofs/obligations/o10_idempotency.rs";
const PROOFS_REGISTRY: &str = "tests/kernel_proofs/registry.rs";
/// Daemon-side tests land in the host crate; these are the paths the owning
/// beads are expected to create.
const HOST_KERNEL_ROUTES: &str = "../mc-host/tests/kernel_routes.rs";
const HOST_SEARCH_PROJECTOR: &str = "../mc-host/tests/search_projector.rs";
const HOST_VECTOR_PROJECTOR: &str = "../mc-host/tests/vector_projector.rs";
const HOST_SHADOW_EXTRACTION: &str = "../mc-host/tests/shadow_extraction.rs";

macro_rules! registry_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];
        }
    };
}

registry_enum! {
    /// kh8 R8 obligations O1–O10, split where the kernel proves one half and a
    /// daemon or projector owner proves the other.
    Obligation {
        O1StagingInvisibility,
        O2AtomicRepair,
        O3BranchApplicability,
        O4ScopeAlgebra,
        O5AppendOnlyCorrection,
        O6DeletionPropagationKernel,
        O6DeletionWithdrawsSubject,
        O6DeletionReachesSearch,
        O7StaleExclusionKernel,
        O7StaleServing,
        O7DeletedEvidenceExcluded,
        O8RestartBackup,
        O9EgressKernel,
        O9EgressGate,
        O10Idempotency,
    }
}

impl Obligation {
    pub fn row(self) -> Row {
        match self {
            Obligation::O1StagingInvisibility => Row {
                id: "O1",
                claim: "staged candidates reach no serving surface or canonical snapshot before admission",
                status: Status::Landed {
                    tests: &[
                        Test { path: PROOFS_O1, function: "staged_candidate_is_invisible_on_every_surface_until_admitted_across_restart" },
                        Test { path: PROOFS_O1, function: "canonical_object_without_an_admission_decision_stays_off_automatic_surfaces" },
                        Test { path: KERNEL_SLICE_FIXTURES, function: "staged_candidate_never_enters_canonical_state" },
                    ],
                },
            },
            Obligation::O2AtomicRepair => Row {
                id: "O2",
                claim: "multi-object repair is atomic under known_as_of",
                status: Status::Landed {
                    tests: &[
                        Test { path: PROOFS_O2, function: "concurrent_reader_never_observes_a_partial_three_object_correction" },
                        Test { path: PROOFS_O2, function: "faulted_three_object_correction_lands_no_object_and_survives_restart" },
                        Test { path: PROOFS_O2, function: "two_observations_in_one_envelope_share_one_commit_seq" },
                        Test { path: KERNEL_ADMISSION, function: "candidate_admission_is_atomic_and_receipt_replay_is_effect_free" },
                    ],
                },
            },
            Obligation::O3BranchApplicability => Row {
                id: "O3",
                claim: "git-branch applicability follows real ancestry with patch-id fallback",
                status: Status::Landed {
                    tests: &[
                        Test { path: PROOFS_O3, function: "ladder_matches_breadth_first_reachability_on_random_dags" },
                        Test { path: PROOFS_O3, function: "head_on_a_disconnected_root_reaches_nothing_from_the_other_component" },
                        Test { path: KERNEL_ANCHOR_RESOLUTION, function: "reachable_between_is_half_open_over_independent_ancestry_tests" },
                        Test { path: KERNEL_ANCHOR_RESOLUTION, function: "rebase_fixture_resolves_through_patch_id_and_duplicates_stay_uncertain" },
                        Test { path: KERNEL_APPLICABILITY_ACCEPTANCE, function: "acceptance_patch_id_fallback_resolves_moved_commits" },
                    ],
                },
            },
            Obligation::O4ScopeAlgebra => Row {
                id: "O4",
                claim: "scope overlap and subsumption are deterministic",
                status: Status::Landed {
                    tests: &[
                        Test { path: KERNEL_SCOPE_ALGEBRA, function: "canonicalization_is_idempotent_and_order_insensitive" },
                        Test { path: KERNEL_SCOPE_ALGEBRA, function: "version_range_containment_uses_interval_normalization" },
                        Test { path: KERNEL_SCOPE_ALGEBRA, function: "subsumption_is_reflexive" },
                        Test { path: KERNEL_SCOPE_ALGEBRA, function: "subsumption_is_transitive" },
                        Test { path: KERNEL_SCOPE_ALGEBRA, function: "overlap_is_symmetric" },
                        Test { path: KERNEL_SCOPE_ALGEBRA, function: "law_generators_reach_nontrivial_subsumption_pairs" },
                        Test { path: KERNEL_SCOPE_ALGEBRA, function: "git_terms_decide_through_a_graph_oracle" },
                    ],
                },
            },
            Obligation::O5AppendOnlyCorrection => Row {
                id: "O5",
                claim: "false classification is corrected append-only",
                status: Status::Landed {
                    tests: &[
                        Test { path: PROOFS_O5, function: "correction_chains_preserve_every_prior_snapshot_and_predecessor" },
                        Test { path: PROOFS_O5, function: "correction_naming_an_unknown_predecessor_lands_nothing" },
                        Test { path: KERNEL_SLICE_FIXTURES, function: "false_lru_classification_is_corrected_append_only" },
                    ],
                },
            },
            Obligation::O6DeletionPropagationKernel => Row {
                id: "O6/kernel",
                claim: "evidence deletion invalidates every reference in one commit and emits complete propagation work",
                status: Status::Landed {
                    tests: &[
                        Test { path: PROOFS_O6, function: "deletion_invalidates_references_and_emits_complete_work_across_restart" },
                        Test { path: PROOFS_O6, function: "deletion_fault_before_commit_leaves_references_live_and_no_barrier_across_restart" },
                        Test { path: KERNEL_DELETION, function: "deletion_invalidates_every_reference_in_one_commit_and_emits_complete_target_work" },
                        Test { path: KERNEL_DELETION, function: "barrier_uses_recorded_consumers_and_requires_explicit_empty_set_abandonment" },
                    ],
                },
            },
            Obligation::O6DeletionWithdrawsSubject => Row {
                id: "O6/admission",
                claim: "an admitted subject whose trigger evidence was deleted is withdrawn from serving",
                status: Status::Pending {
                    owner_bead: "magic-context-kh8.28",
                    expected_tests: &[Test { path: PROOFS_O6, function: "deleted_evidence_withdraws_the_admitted_subject_at_tip" }],
                },
            },
            Obligation::O6DeletionReachesSearch => Row {
                id: "O6/search",
                claim: "deletion propagation removes derived support and search documents",
                status: Status::Pending {
                    owner_bead: "magic-context-3q5.9",
                    expected_tests: &[Test { path: HOST_SEARCH_PROJECTOR, function: "deletion_barrier_removes_search_documents_before_acknowledgement" }],
                },
            },
            Obligation::O7StaleExclusionKernel => Row {
                id: "O7/kernel",
                claim: "a retracted or superseded subject is excluded at the tip while its admission snapshot still serves it; lag facts are exact",
                status: Status::Landed {
                    tests: &[
                        Test { path: PROOFS_O7, function: "retracted_subject_is_excluded_at_tip_but_served_at_its_admission_snapshot" },
                        Test { path: PROOFS_O7, function: "superseded_subject_is_excluded_at_tip_but_served_at_its_admission_snapshot" },
                        Test { path: KERNEL_FACTS, function: "lag_uses_slowest_consumer_and_oldest_age_grows_exactly" },
                        Test { path: KERNEL_FACTS, function: "no_consumers_report_absent_lag_rather_than_zero" },
                    ],
                },
            },
            Obligation::O7StaleServing => Row {
                id: "O7/serving",
                claim: "explicit search returns a typed stale marker and automatic injection abstains past the lag threshold",
                status: Status::Pending {
                    owner_bead: "magic-context-kh8.8",
                    expected_tests: &[Test { path: HOST_KERNEL_ROUTES, function: "search_returns_stale_marker_and_injection_abstains_past_threshold" }],
                },
            },
            Obligation::O7DeletedEvidenceExcluded => Row {
                id: "O7/deleted-evidence",
                claim: "a subject whose trigger evidence was deleted is excluded at the tip",
                status: Status::Pending {
                    owner_bead: "magic-context-kh8.28",
                    expected_tests: &[Test { path: PROOFS_O7, function: "deleted_evidence_excludes_subject_at_tip_but_serves_it_at_admission" }],
                },
            },
            Obligation::O8RestartBackup => Row {
                id: "O8",
                claim: "restart and backup/restore reproduce identical canonical state over every table",
                status: Status::Landed {
                    tests: &[
                        Test { path: PROOFS_O8, function: "seeded_state_digest_survives_reopen" },
                        Test { path: PROOFS_O8, function: "backup_and_restore_reproduce_every_table_and_the_commit_seq" },
                        Test { path: PROOFS_O8, function: "outbox_position_never_regresses_or_reuses_across_prune_and_reopen" },
                        Test { path: PROOFS_O8, function: "each_restore_fault_rolls_back_to_the_pre_restore_state" },
                        Test { path: KERNEL_OPEN, function: "kernel_with_uncheckpointed_wal_opens_and_preserves_rows" },
                        Test { path: KERNEL_OPEN, function: "fresh_open_and_exact_reopen_preserve_identity_and_advance_fence" },
                        Test { path: KERNEL_BACKUP, function: "backup_restores_exact_snapshot_and_reclaims_writer_fence" },
                    ],
                },
            },
            Obligation::O9EgressKernel => Row {
                id: "O9/kernel",
                claim: "eligibility denies sensitive, unknown, and secret egress over every reference mix and admission hides sensitive rows on remote-capable surfaces",
                status: Status::Landed {
                    tests: &[
                        Test { path: PROOFS_O9, function: "eligibility_matrix_is_exhaustive" },
                        Test { path: PROOFS_O9, function: "expected_policy_never_widens_when_a_reference_is_added" },
                        Test { path: PROOFS_O9, function: "unknown_and_dereferenced_digests_allow_local_and_deny_remote" },
                        Test { path: PROOFS_O9, function: "tombstone_denies_before_any_reference_is_consulted" },
                        Test { path: PROOFS_O9, function: "admission_hides_sensitive_subjects_on_remote_capable_surfaces" },
                        Test { path: KERNEL_CAS, function: "eligibility_matrix_includes_secret_unknown_and_tombstone" },
                    ],
                },
            },
            Obligation::O9EgressGate => Row {
                id: "O9/gate",
                claim: "the daemon egress gate refuses forbidden provider calls and makes no request",
                status: Status::Pending {
                    owner_bead: "magic-context-kh8.8",
                    expected_tests: &[Test { path: HOST_KERNEL_ROUTES, function: "egress_gate_rejects_sensitive_remote_and_all_secret_without_a_request" }],
                },
            },
            Obligation::O10Idempotency => Row {
                id: "O10",
                claim: "duplicate processing is idempotent across replay, restart, and fault",
                status: Status::Landed {
                    tests: &[
                        Test { path: PROOFS_O10, function: "perturbed_history_matches_clean_run_and_reference_model" },
                        Test { path: PROOFS_O10, function: "delete_after_ingest_propagates_identically_under_duplicates_and_restart" },
                        Test { path: KERNEL_ENVELOPE, function: "receipt_replay_is_effect_free_and_digest_conflict_is_typed" },
                        Test { path: KERNEL_CAS, function: "replayed_intent_returns_the_committed_reference" },
                        Test { path: KERNEL_DELETION, function: "a_replayed_deletion_reports_the_generation_it_committed" },
                        Test { path: KERNEL_OUTBOX, function: "publication_stays_idempotent_after_the_rows_are_pruned" },
                    ],
                },
            },
        }
    }
}

registry_enum! {
    /// kh8.1 policy rows R1–R12e and the owner-matrix oracles that have no
    /// policy row of their own, split where owners differ.
    PolicyRow {
        R1AppendOnlyRetention,
        R2CommitHistoryRetained,
        R3OutboxPruning,
        R3VectorConsumer,
        R4StagingLeases,
        R5ArtifactRetention,
        R6SearchRebuild,
        R6VectorRebuild,
        R7CoreWarning,
        R8ArtifactBudget,
        R8CapConfigurable,
        R9PayloadCap,
        R10SensitivityAtIngestion,
        R10RedactionMetadata,
        R11EgressEligibility,
        R11EgressGate,
        R11ExtractionDelegation,
        R12aBackupContents,
        R12bRestoreExact,
        R12cRestoreRto,
        R12cArtifactFixture,
        R12dOutboxPosition,
        R12dLagFacts,
        R12dServing,
        R12dProjector,
        R12dVectorLag,
        R12eBackupPermissions,
        K2FullLogReplay,
        K7MatrixCompleteness,
    }
}

impl PolicyRow {
    pub fn row(self) -> Row {
        match self {
            PolicyRow::R1AppendOnlyRetention => Row {
                id: "kh8.1 R1",
                claim: "canonical rows have no age-based deletion; corrections append; removal only through evidence deletion",
                status: Status::Landed {
                    tests: &[
                        Test { path: KERNEL_SLICE_FIXTURES, function: "false_lru_classification_is_corrected_append_only" },
                        Test { path: KERNEL_SCHEMA, function: "replace_cannot_bypass_the_append_only_guards" },
                        Test { path: KERNEL_SCHEMA, function: "canonical_parents_refuse_deletion_instead_of_cascading" },
                        Test { path: KERNEL_DELETION, function: "deletion_invalidates_every_reference_in_one_commit_and_emits_complete_target_work" },
                        Test { path: PROOFS_O5, function: "correction_chains_preserve_every_prior_snapshot_and_predecessor" },
                    ],
                },
            },
            PolicyRow::R2CommitHistoryRetained => Row {
                id: "kh8.1 R2",
                claim: "commit_log rejects update and delete, change_event and receipt identity fields are immutable and undeletable, and only R8 payload remediation may overwrite a payload",
                status: Status::Landed {
                    tests: &[
                        Test { path: KERNEL_SCHEMA, function: "commit_log_rejects_update_and_delete" },
                        Test { path: KERNEL_SCHEMA, function: "commit_history_identity_is_immutable_and_undeletable" },
                    ],
                },
            },
            PolicyRow::R3OutboxPruning => Row {
                id: "kh8.1 R3",
                claim: "pruning uses the minimum required checkpoint, refuses on an empty set, registers at the oldest retained position, and abandonment records four facts",
                status: Status::Landed {
                    tests: &[
                        Test { path: KERNEL_OUTBOX, function: "slow_consumer_sets_commit_prune_horizon_and_registration_sees_oldest_retained_commit" },
                        Test { path: KERNEL_OUTBOX, function: "empty_required_set_refuses_prune_and_empty_outbox_registration_uses_pre_registration_tip" },
                        Test { path: KERNEL_OUTBOX, function: "deregistration_uses_commit_tip_without_publication_and_abandonment_records_four_facts" },
                        Test { path: KERNEL_OUTBOX, function: "derived_projection_discard_preserves_exact_checkpoints_and_receipts" },
                    ],
                },
            },
            PolicyRow::R3VectorConsumer => Row {
                id: "kh8.1 R3/vectors",
                claim: "the vector consumer registers and participates in the minimum checkpoint",
                status: Status::Pending {
                    owner_bead: "magic-context-3q5.15",
                    expected_tests: &[Test { path: HOST_VECTOR_PROJECTOR, function: "vector_consumer_participates_in_the_minimum_checkpoint" }],
                },
            },
            PolicyRow::R4StagingLeases => Row {
                id: "kh8.1 R4",
                claim: "leases renew, expire within one hour, abandon at the stored expiry, and terminal runs expire after thirty days keeping only the decision row",
                status: Status::Landed {
                    tests: &[
                        Test { path: KERNEL_RETENTION, function: "renew_advances_the_lease_and_never_shortens_it" },
                        Test { path: KERNEL_RETENTION, function: "renew_rejects_an_unknown_run_a_backwards_heartbeat_and_an_expired_lease" },
                        Test { path: KERNEL_RETENTION, function: "reaper_abandons_a_run_at_exactly_its_stored_lease_expiry" },
                        Test { path: KERNEL_RETENTION, function: "completed_staging_survives_day_29_and_is_deleted_day_31" },
                        Test { path: KERNEL_RETENTION, function: "staging_cleanup_preserves_exact_denormalized_admission_facts" },
                        Test { path: KERNEL_REDACTION, function: "a_lease_beyond_the_one_hour_ceiling_is_rejected" },
                    ],
                },
            },
            PolicyRow::R5ArtifactRetention => Row {
                id: "kh8.1 R5",
                claim: "referenced artifacts are retained, dereferenced ones reclaim after grace, commit failure cleans up, crash orphans reclaim at reservation expiry, and repeated maintenance is idempotent",
                status: Status::Landed {
                    tests: &[
                        Test { path: KERNEL_GC, function: "referenced_and_recently_invalidated_artifacts_survive" },
                        Test { path: KERNEL_GC, function: "invalidated_artifact_reclaims_after_grace_but_backward_clock_keeps_it" },
                        Test { path: KERNEL_GC, function: "reservation_honors_stored_and_renewed_lease_expiry" },
                        Test { path: KERNEL_GC, function: "reclaiming_blocks_delayed_commit_and_startup_converges" },
                        Test { path: KERNEL_GC, function: "reclaimed_digests_stop_being_gc_candidates" },
                        Test { path: KERNEL_CAS, function: "commit_failure_cleans_reference_and_errors_never_leak_payload" },
                        Test { path: CAS_FAULT_INJECTION, function: "startup_leaves_reservations_whose_digest_still_has_reference_history" },
                    ],
                },
            },
            PolicyRow::R6SearchRebuild => Row {
                id: "kh8.1 R6/search",
                claim: "search.sqlite rebuilds with identical logical identities and checkpoints",
                status: Status::Pending {
                    owner_bead: "magic-context-3q5.9",
                    expected_tests: &[Test { path: HOST_SEARCH_PROJECTOR, function: "discard_and_rebuild_yields_identical_identities_and_checkpoints" }],
                },
            },
            PolicyRow::R6VectorRebuild => Row {
                id: "kh8.1 R6/vectors",
                claim: "vectors/ rebuilds identically from canonical state",
                status: Status::Pending {
                    owner_bead: "magic-context-3q5.15",
                    expected_tests: &[Test { path: HOST_VECTOR_PROJECTOR, function: "vectors_rebuild_identically_from_canonical_state" }],
                },
            },
            PolicyRow::R7CoreWarning => Row {
                id: "kh8.1 R7",
                claim: "core.sqlite warns at 1 GiB while writes continue",
                status: Status::Pending {
                    owner_bead: "magic-context-kh8.25",
                    expected_tests: &[Test { path: KERNEL_FACTS, function: "main_file_warning_flips_at_one_gib_and_writes_continue" }],
                },
            },
            PolicyRow::R8ArtifactBudget => Row {
                id: "kh8.1 R8",
                claim: "cap errors are typed with usage and cap, and referenced artifacts are never reclaimed for pressure",
                status: Status::Landed {
                    tests: &[
                        Test { path: KERNEL_CAS, function: "cap_error_reports_usage_and_cap_without_poisoning_reads" },
                        Test { path: KERNEL_CAS, function: "invalidated_retained_object_still_consumes_cap" },
                        Test { path: KERNEL_GC, function: "reclaim_frees_capacity_for_next_write" },
                        Test { path: KERNEL_GC, function: "a_full_artifact_cap_is_reported_as_retriable" },
                        Test { path: KERNEL_GC, function: "orphan_mtime_grace_and_budget_facts_are_reconciled_from_objects" },
                    ],
                },
            },
            PolicyRow::R8CapConfigurable => Row {
                id: "kh8.1 R8/configurable",
                claim: "the artifact cap is configurable through a production constructor",
                status: Status::Pending {
                    owner_bead: "magic-context-kh8.18",
                    expected_tests: &[Test { path: KERNEL_CAS, function: "a_production_open_accepts_a_configured_artifact_cap" }],
                },
            },
            PolicyRow::R9PayloadCap => Row {
                id: "kh8.1 R9",
                claim: "one artifact payload is capped at 64 MiB",
                status: Status::Contradiction {
                    bead: "magic-context-kh8.21",
                    policy_text: "One artifact payload is capped at 64 MiB. Ingestion accepts 64 MiB and rejects 64 MiB plus one byte with a typed error. Production rejects every payload above the 512 KiB redaction ceiling.",
                },
            },
            PolicyRow::R10SensitivityAtIngestion => Row {
                id: "kh8.1 R10",
                claim: "sensitivity is stored at ingestion, unknown defaults sensitive, normal needs provenance, secrets are redacted before durable writes, and purge propagates",
                status: Status::Landed {
                    tests: &[
                        Test { path: KERNEL_REDACTION, function: "staging_requires_affirmative_repository_provenance_for_normal" },
                        Test { path: KERNEL_REDACTION, function: "envelope_redacts_before_bind_and_never_leaks_secret_to_storage_or_errors" },
                        Test { path: KERNEL_REDACTION, function: "staging_metadata_retains_no_verifier_for_a_redacted_secret" },
                        Test { path: KERNEL_CAS, function: "unproven_normal_and_non_utf8_are_clamped_sensitive" },
                        Test { path: KERNEL_CAS, function: "uninspectable_payload_never_persists_a_recognized_secret" },
                        Test { path: KERNEL_DELETION, function: "purge_tombstones_unlinks_degrades_pins_and_is_idempotent" },
                        Test { path: KERNEL_ADMISSION, function: "taint_sensitivity_floor_applies_to_existing_canonical_objects" },
                        Test { path: KERNEL_ADMISSION, function: "dispositions_and_sensitivity_only_reduce_visibility" },
                    ],
                },
            },
            PolicyRow::R10RedactionMetadata => Row {
                id: "kh8.1 R10/metadata",
                claim: "redaction metadata carries only detector id, secret type, offset, and length",
                status: Status::Contradiction {
                    bead: "magic-context-kh8.30",
                    policy_text: "R10 restricts persisted detection metadata to detector id, secret type, source UTF-8 offset, and source UTF-8 length. Production also persists a field key, and staging_metadata_retains_no_verifier_for_a_redacted_secret asserts all five while its message names only four.",
                },
            },
            PolicyRow::R11EgressEligibility => Row {
                id: "kh8.1 R11/eligibility",
                claim: "eligibility derives maximum sensitivity from stored records, treats unknown as sensitive, and refuses sensitive-to-remote and all secret egress",
                status: Status::Landed {
                    tests: &[
                        Test { path: PROOFS_O9, function: "eligibility_matrix_is_exhaustive" },
                        Test { path: PROOFS_O9, function: "unknown_and_dereferenced_digests_allow_local_and_deny_remote" },
                        Test { path: KERNEL_CAS, function: "eligibility_matrix_includes_secret_unknown_and_tombstone" },
                        Test { path: KERNEL_CAS, function: "dedup_merges_sensitivity_and_provider_restrictions_restrictively" },
                    ],
                },
            },
            PolicyRow::R11EgressGate => Row {
                id: "kh8.1 R11/gate",
                claim: "one daemon gate covers extraction, embedding, and LLM dispatch and rejects under-declaration",
                status: Status::Pending {
                    owner_bead: "magic-context-kh8.8",
                    expected_tests: &[Test { path: HOST_KERNEL_ROUTES, function: "egress_gate_rejects_sensitive_remote_and_all_secret_without_a_request" }],
                },
            },
            PolicyRow::R11ExtractionDelegation => Row {
                id: "kh8.1 R11/extraction",
                claim: "shadow extraction makes no direct provider call and no canonical write",
                status: Status::Pending {
                    owner_bead: "magic-context-kh8.10",
                    expected_tests: &[Test { path: HOST_SHADOW_EXTRACTION, function: "shadow_extraction_delegates_every_provider_call_and_writes_nothing_canonical" }],
                },
            },
            PolicyRow::R12aBackupContents => Row {
                id: "kh8.1 R12a",
                claim: "a backup contains core.sqlite plus every referenced artifact",
                status: Status::Contradiction {
                    bead: "magic-context-kh8.22",
                    policy_text: "A backup contains a consistent core.sqlite snapshot at one commit_seq plus every referenced artifact. Production backs up the SQLite file only and pins the referenced objects in place.",
                },
            },
            PolicyRow::R12bRestoreExact => Row {
                id: "kh8.1 R12b",
                claim: "restore reproduces canonical state and commit_seq exactly",
                status: Status::Landed {
                    tests: &[
                        Test { path: KERNEL_BACKUP, function: "backup_restores_exact_snapshot_and_reclaims_writer_fence" },
                        Test { path: PROOFS_O8, function: "backup_and_restore_reproduce_every_table_and_the_commit_seq" },
                        Test { path: KERNEL_DELETION, function: "purge_reissue_after_simulated_restore_recreates_control_facts_and_effects" },
                    ],
                },
            },
            PolicyRow::R12cRestoreRto => Row {
                id: "kh8.1 R12c/rto",
                claim: "restore of a 1 GiB core completes within five minutes on the reference profile or reports not evaluated",
                status: Status::Landed {
                    tests: &[Test { path: KERNEL_BACKUP, function: "threshold_size_restore_rto" }],
                },
            },
            PolicyRow::R12cArtifactFixture => Row {
                id: "kh8.1 R12c/artifacts",
                claim: "the RTO fixture carries 4 GiB of referenced artifacts",
                status: Status::Pending {
                    owner_bead: "magic-context-kh8.27",
                    expected_tests: &[Test { path: KERNEL_BACKUP, function: "threshold_size_restore_rto_with_referenced_artifacts" }],
                },
            },
            PolicyRow::R12dOutboxPosition => Row {
                id: "kh8.1 R12d/position",
                claim: "every outbox row has a monotonic outbox_position independent of commit_seq that never regresses across prune or reopen",
                status: Status::Landed {
                    tests: &[
                        Test { path: KERNEL_SCHEMA, function: "consumers_checkpoint_independent_outbox_positions" },
                        Test { path: KERNEL_OUTBOX, function: "publication_marks_rows_through_the_position_and_leaves_later_rows_unpublished" },
                        Test { path: PROOFS_O8, function: "outbox_position_never_regresses_or_reuses_across_prune_and_reopen" },
                    ],
                },
            },
            PolicyRow::R12dLagFacts => Row {
                id: "kh8.1 R12d/lag",
                claim: "lag is reported as published position minus minimum acknowledged position and oldest unconsumed age",
                status: Status::Pending {
                    owner_bead: "magic-context-kh8.24",
                    expected_tests: &[Test { path: KERNEL_FACTS, function: "lag_uses_outbox_positions_and_the_required_consumer_minimum" }],
                },
            },
            PolicyRow::R12dServing => Row {
                id: "kh8.1 R12d/serving",
                claim: "search returns stale or unavailable states, injection abstains, and canonical writes continue past the threshold",
                status: Status::Pending {
                    owner_bead: "magic-context-kh8.8",
                    expected_tests: &[Test { path: HOST_KERNEL_ROUTES, function: "search_returns_stale_marker_and_injection_abstains_past_threshold" }],
                },
            },
            PolicyRow::R12dProjector => Row {
                id: "kh8.1 R12d/projector",
                claim: "the search projector exercises the lag threshold boundaries",
                status: Status::Pending {
                    owner_bead: "magic-context-3q5.9",
                    expected_tests: &[Test { path: HOST_SEARCH_PROJECTOR, function: "projector_lag_crosses_the_threshold_at_exactly_the_boundary" }],
                },
            },
            PolicyRow::R12dVectorLag => Row {
                id: "kh8.1 R12d/vectors",
                claim: "vectors participate in lag through the minimum checkpoint",
                status: Status::Pending {
                    owner_bead: "magic-context-3q5.15",
                    expected_tests: &[Test { path: HOST_VECTOR_PROJECTOR, function: "vector_checkpoint_participates_in_lag" }],
                },
            },
            PolicyRow::R12eBackupPermissions => Row {
                id: "kh8.1 R12e",
                claim: "backups inherit maximum sensitivity, target local storage only, are owner-only independent of umask, and reject unsafe paths",
                status: Status::Landed {
                    tests: &[
                        Test { path: KERNEL_BACKUP, function: "staging_sensitivity_marks_backup_sensitive" },
                        Test { path: KERNEL_BACKUP, function: "a_secret_row_classifies_the_backup_secret_not_merely_sensitive" },
                        Test { path: KERNEL_BACKUP, function: "unsafe_destinations_and_restore_sources_are_rejected_before_live_touch" },
                        Test { path: KERNEL_BACKUP, function: "backup_restores_exact_snapshot_and_reclaims_writer_fence" },
                        Test { path: DURABLE_FS, function: "created_directories_and_files_are_owner_only" },
                    ],
                },
            },
            PolicyRow::K2FullLogReplay => Row {
                id: "kh8.1 matrix/K2 full-log replay",
                claim: "the K2 full-log replay oracle has a defined meaning and a discriminating test",
                status: Status::Pending {
                    owner_bead: "magic-context-kh8.26",
                    expected_tests: &[Test { path: KERNEL_ENVELOPE, function: "full_log_replay_rebuilds_canonical_tables_from_commit_history" }],
                },
            },
            PolicyRow::K7MatrixCompleteness => Row {
                id: "kh8.1 matrix/K7",
                claim: "every listed owner has landed a discriminating oracle or is tracked by a filed bead",
                status: Status::Landed {
                    tests: &[
                        Test { path: PROOFS_REGISTRY, function: "every_row_resolves_to_a_checked_test_or_a_known_bead" },
                        Test { path: PROOFS_REGISTRY, function: "epic_close" },
                    ],
                },
            },
        }
    }
}

pub fn all_rows() -> Vec<Row> {
    Obligation::ALL
        .iter()
        .map(|obligation| obligation.row())
        .chain(PolicyRow::ALL.iter().map(|row| row.row()))
        .collect()
}

/// Source text per declared path, `None` when the file does not exist.
pub type Catalog = BTreeMap<String, Option<String>>;

pub fn read_catalog(rows: &[Row]) -> Catalog {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    // Collect the distinct paths first; many rows name the same file, and
    // reading once per row would re-read it for every reference.
    rows.iter()
        .flat_map(|row| match row.status {
            Status::Landed { tests }
            | Status::Pending {
                expected_tests: tests,
                ..
            } => tests,
            Status::Contradiction { .. } => &[],
        })
        .map(|test| test.path)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|path| {
            (
                path.to_string(),
                fs::read_to_string(manifest.join(path)).ok(),
            )
        })
        .collect()
}

/// Validates `rows` against `catalog` and `known_beads`; every failure is
/// reported so one run names every broken row.
pub fn validate(rows: &[Row], catalog: &Catalog, known_beads: &[&str]) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    let mut referenced = BTreeSet::new();
    let mut ids = BTreeSet::new();
    for row in rows {
        if !ids.insert(row.id) {
            errors.push(format!("{} ({}): duplicate row id", row.id, row.claim));
        }
        match row.status {
            Status::Landed { tests } => {
                if tests.is_empty() {
                    errors.push(format!("{} ({}): landed with no tests", row.id, row.claim));
                }
                for test in tests {
                    if let Err(error) = check_landed(catalog, test) {
                        errors.push(format!("{} ({}): {error}", row.id, row.claim));
                    }
                }
            }
            Status::Pending {
                owner_bead,
                expected_tests,
            } => {
                referenced.insert(owner_bead);
                if !known_beads.contains(&owner_bead) {
                    errors.push(format!(
                        "{} ({}): owner {owner_bead} is not in KNOWN_BEADS",
                        row.id, row.claim
                    ));
                }
                if expected_tests.is_empty() {
                    errors.push(format!(
                        "{} ({}): pending with no expected tests",
                        row.id, row.claim
                    ));
                }
                for test in expected_tests {
                    if let Some(Some(source)) = catalog.get(test.path) {
                        // Ambiguous matches satisfy the existence check; only
                        // `LocateError::NotFound` leaves the row pending.
                        match locate(source, test.function) {
                            Ok(_) => errors.push(format!(
                                "{} ({}): expected test {}::{} exists; promote the row to Landed",
                                row.id, row.claim, test.path, test.function
                            )),
                            Err(LocateError::Ambiguous) => errors.push(format!(
                                "{} ({}): expected test {}::{} exists more than once; promote the row to Landed and disambiguate it",
                                row.id, row.claim, test.path, test.function
                            )),
                            Err(LocateError::NotFound) => {}
                        }
                    } else if !catalog.contains_key(test.path) {
                        errors.push(format!(
                            "{} ({}): {} is not in the catalog",
                            row.id, row.claim, test.path
                        ));
                    }
                }
            }
            Status::Contradiction { bead, policy_text } => {
                referenced.insert(bead);
                if !known_beads.contains(&bead) {
                    errors.push(format!(
                        "{} ({}): bead {bead} is not in KNOWN_BEADS",
                        row.id, row.claim
                    ));
                }
                if policy_text.trim().is_empty() {
                    errors.push(format!(
                        "{} ({}): contradiction without policy text",
                        row.id, row.claim
                    ));
                }
            }
        }
    }
    for bead in known_beads {
        if !referenced.contains(bead) {
            errors.push(format!("KNOWN_BEADS lists {bead}, which no row references"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// The `cfg` conditions CI satisfies for every kernel test target, so a named oracle behind one still reaches the harness.
const CI_ENABLED_CFG: &[&str] = &["unix", "feature = \"test-support\""];

fn check_landed(catalog: &Catalog, test: &Test) -> Result<(), String> {
    let source = match catalog.get(test.path) {
        Some(Some(source)) => source,
        Some(None) => return Err(format!("{} does not exist", test.path)),
        None => return Err(format!("{} is not in the catalog", test.path)),
    };
    let attributes = locate(source, test.function)
        .map_err(|error| format!("{}::{}: {error}", test.path, test.function))?;
    if !attributes.iter().any(|line| line.trim() == "#[test]") {
        return Err(format!(
            "{}::{} is not a #[test] function",
            test.path, test.function
        ));
    }
    let package = format!("-p {} ", owning_package(test.path));
    let target = owning_test_target(test.path).map(|target| format!("--test {target} "));
    for line in &attributes {
        let line = line.trim();
        // Cargo omits tests disabled by unsatisfied `cfg` values from the harness; accept only conditions CI is known to satisfy.
        if let Some(condition) = line
            .strip_prefix("#[cfg(")
            .and_then(|rest| rest.strip_suffix(")]"))
        {
            if !CI_ENABLED_CFG.contains(&condition) {
                return Err(format!(
                    "{}::{} is behind #[cfg({condition})], which is not known to be enabled",
                    test.path, test.function
                ));
            }
        } else if line.starts_with("#[cfg_attr(") {
            return Err(format!(
                "{}::{} is behind #[cfg_attr(..)]; name an unconditional oracle",
                test.path, test.function
            ));
        }
        if line.starts_with("#[ignore") {
            // The rerun command has to select this ignored test in the package
            // and test target that own its file; `cargo test` runs no ignored
            // test otherwise, and a selector naming another target errors
            // before Cargo evaluates this test.
            let selects_target = target
                .as_ref()
                .is_none_or(|target| line.contains(target.as_str()));
            let runnable = line.starts_with("#[ignore = \"")
                && line.contains("run with: cargo test")
                && line.contains(&package)
                && selects_target
                && line.contains(test.function)
                && line.contains("--ignored");
            if !runnable {
                let selector = match &target {
                    Some(target) => format!("{package}{target}"),
                    None => package.clone(),
                };
                return Err(format!(
                    "{}::{} is ignored without a rerun command for {selector}",
                    test.path, test.function
                ));
            }
        }
    }
    Ok(())
}

fn owning_package(path: &str) -> &str {
    path.strip_prefix("../")
        .and_then(|rest| rest.split('/').next())
        .unwrap_or(env!("CARGO_PKG_NAME"))
}

/// Returns the `cargo test --test` target owning `path`; a path outside `tests/` yields `None`.
fn owning_test_target(path: &str) -> Option<&str> {
    let rest = path.strip_prefix("../").map_or(path, |rest| {
        rest.split_once('/').map_or(rest, |(_, rest)| rest)
    });
    let head = rest.strip_prefix("tests/")?.split('/').next()?;
    Some(head.strip_suffix(".rs").unwrap_or(head))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocateError {
    NotFound,
    Ambiguous,
}

impl std::fmt::Display for LocateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            LocateError::NotFound => "function not found",
            LocateError::Ambiguous => "function name is ambiguous in this file",
        })
    }
}

/// Reports whether `line` defines `signature` rather than merely mentioning it.
/// Restricting the prefix to `LEADING` prevents comments and strings that
/// mention `signature` from matching, so a named function that no longer exists
/// cannot resolve to a line that only refers to it.
fn defines_function(line: &str, signature: &str) -> bool {
    const LEADING: &[&str] = &[
        "pub",
        "pub(crate)",
        "pub(super)",
        "pub(self)",
        "const",
        "async",
        "unsafe",
        "extern",
        "\"C\"",
        "\"C-unwind\"",
        "default",
    ];
    let Some(offset) = line.find(signature) else {
        return false;
    };
    line[..offset]
        .split_whitespace()
        .all(|token| LEADING.contains(&token))
}

/// Finds the single definition of `function` and returns the attribute and
/// comment lines immediately above it, stopping at the first line that is
/// neither, so an attribute on the previous item is never attributed to this
/// one.
fn locate(source: &str, function: &str) -> Result<Vec<String>, LocateError> {
    let signature = format!("fn {function}(");
    let lines = source.lines().collect::<Vec<_>>();
    let matches = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| defines_function(line, &signature))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let index = match matches.as_slice() {
        [index] => *index,
        [] => return Err(LocateError::NotFound),
        _ => return Err(LocateError::Ambiguous),
    };
    let mut attributes = Vec::new();
    for line in lines[..index].iter().rev() {
        let trimmed = line.trim();
        if trimmed.starts_with("#[") || trimmed.starts_with("//") {
            attributes.push(line.to_string());
        } else {
            break;
        }
    }
    attributes.reverse();
    Ok(attributes)
}

fn catalog(entries: &[(&str, Option<&str>)]) -> Catalog {
    entries
        .iter()
        .map(|(path, source)| (path.to_string(), source.map(str::to_string)))
        .collect()
}

const PROVEN: &[Test] = &[Test {
    path: "a.rs",
    function: "proven",
}];
const ABSENT: &[Test] = &[Test {
    path: "a.rs",
    function: "absent",
}];
const PROVEN_IN_TARGET: &[Test] = &[Test {
    path: "tests/x.rs",
    function: "proven",
}];

fn landed(tests: &'static [Test]) -> Row {
    Row {
        id: "row",
        claim: "claim",
        status: Status::Landed { tests },
    }
}

fn pending(expected_tests: &'static [Test], owner_bead: &'static str) -> Row {
    Row {
        id: "row",
        claim: "claim",
        status: Status::Pending {
            owner_bead,
            expected_tests,
        },
    }
}

const GOOD: &str = "#[test]\nfn proven() {}\n";
const OTHER_ITEM: &str = "#[test]\nfn other() {}\n\nfn proven() {}\n";
const IGNORED_BARE: &str = "#[test]\n#[ignore]\nfn proven() {}\n";
const IGNORED_RUNNABLE: &str =
    "#[test]\n#[ignore = \"heavy; run with: cargo test -p mc-kernel --test x proven -- --ignored\"]\nfn proven() {}\n";
const IGNORED_VAGUE: &str = "#[test]\n#[ignore = \"run with: cargo test\"]\nfn proven() {}\n";
const IGNORED_WRONG_PACKAGE: &str =
    "#[test]\n#[ignore = \"run with: cargo test -p mc-store --test x proven -- --ignored\"]\nfn proven() {}\n";
const IGNORED_WRONG_TARGET: &str =
    "#[test]\n#[ignore = \"run with: cargo test -p mc-kernel --test other proven -- --ignored\"]\nfn proven() {}\n";
const RENAMED_TO_COMMENT: &str = "#[test]\n// formerly fn proven()\nfn renamed() {}\n";
const CFG_DISABLED: &str = "#[test]\n#[cfg(any())]\nfn proven() {}\n";
const CFG_ENABLED: &str = "#[test]\n#[cfg(unix)]\nfn proven() {}\n";
const DUPLICATED: &str = "#[test]\nfn proven() {}\nmod inner { #[test]\nfn proven() {} }\n";

#[test]
fn every_row_resolves_to_a_checked_test_or_a_known_bead() {
    let rows = all_rows();
    assert_eq!(rows.len(), Obligation::ALL.len() + PolicyRow::ALL.len());
    let catalog = read_catalog(&rows);
    if let Err(errors) = validate(&rows, &catalog, KNOWN_BEADS) {
        panic!("registry violations:\n{}", errors.join("\n"));
    }
    // Positive control: the registry is not vacuously green.
    let landed = rows
        .iter()
        .filter(|row| matches!(row.status, Status::Landed { .. }))
        .count();
    let pending = rows
        .iter()
        .filter(|row| matches!(row.status, Status::Pending { .. }))
        .count();
    let contradicted = rows
        .iter()
        .filter(|row| matches!(row.status, Status::Contradiction { .. }))
        .count();
    assert!(landed > pending, "{landed} landed, {pending} pending");
    assert_eq!(contradicted, 3);
}

#[test]
#[ignore = "epic-close gate; run with: cargo test -p mc-kernel --test kernel_proofs registry::epic_close -- --ignored"]
fn epic_close() {
    // `every_row_resolves_to_a_checked_test_or_a_known_bead` does not run under an `epic_close` name filter.
    // Revalidating here, and deriving closure from the row statuses, stops an emptied KNOWN_BEADS from authorizing closure alone.
    let rows = all_rows();
    if let Err(errors) = validate(&rows, &read_catalog(&rows), KNOWN_BEADS) {
        panic!("registry violations:\n{}", errors.join("\n"));
    }
    let unresolved = rows
        .iter()
        .filter(|row| !matches!(row.status, Status::Landed { .. }))
        .map(|row| row.id)
        .collect::<Vec<_>>();
    assert!(
        unresolved.is_empty(),
        "epic cannot close while rows are unresolved: {unresolved:?}"
    );
    assert!(
        KNOWN_BEADS.is_empty(),
        "epic cannot close while rows still name open beads: {KNOWN_BEADS:?}"
    );
}

#[test]
fn a_landed_test_resolves_and_missing_or_untested_functions_fail() {
    let good = catalog(&[("a.rs", Some(GOOD))]);
    validate(&[landed(PROVEN)], &good, &[]).unwrap();

    let errors = validate(&[landed(ABSENT)], &good, &[]).unwrap_err();
    assert!(errors[0].contains("function not found"), "{errors:?}");

    let errors = validate(&[landed(PROVEN)], &catalog(&[("a.rs", None)]), &[]).unwrap_err();
    assert!(errors[0].contains("does not exist"), "{errors:?}");

    let errors = validate(
        &[landed(PROVEN)],
        &catalog(&[("a.rs", Some(OTHER_ITEM))]),
        &[],
    )
    .unwrap_err();
    assert!(errors[0].contains("not a #[test] function"), "{errors:?}");

    let errors = validate(
        &[landed(PROVEN)],
        &catalog(&[("a.rs", Some(DUPLICATED))]),
        &[],
    )
    .unwrap_err();
    assert!(errors[0].contains("ambiguous"), "{errors:?}");

    // A comment naming a renamed test must not inherit the `#[test]` above it.
    let errors = validate(
        &[landed(PROVEN)],
        &catalog(&[("a.rs", Some(RENAMED_TO_COMMENT))]),
        &[],
    )
    .unwrap_err();
    assert!(errors[0].contains("function not found"), "{errors:?}");

    // A `cfg` CI does not satisfy keeps the oracle out of the harness.
    let errors = validate(
        &[landed(PROVEN)],
        &catalog(&[("a.rs", Some(CFG_DISABLED))]),
        &[],
    )
    .unwrap_err();
    assert!(errors[0].contains("#[cfg(any())]"), "{errors:?}");
    validate(
        &[landed(PROVEN)],
        &catalog(&[("a.rs", Some(CFG_ENABLED))]),
        &[],
    )
    .unwrap();
}

#[test]
fn an_ignored_test_needs_a_runnable_rerun_command() {
    for source in [IGNORED_BARE, IGNORED_VAGUE, IGNORED_WRONG_PACKAGE] {
        let errors =
            validate(&[landed(PROVEN)], &catalog(&[("a.rs", Some(source))]), &[]).unwrap_err();
        assert!(
            errors[0].contains("without a rerun command for -p mc-kernel"),
            "{errors:?}"
        );
    }
    validate(
        &[landed(PROVEN)],
        &catalog(&[("a.rs", Some(IGNORED_RUNNABLE))]),
        &[],
    )
    .unwrap();

    // A path under `tests/` also has to be selected by `--test <target>`.
    let errors = validate(
        &[landed(PROVEN_IN_TARGET)],
        &catalog(&[("tests/x.rs", Some(IGNORED_WRONG_TARGET))]),
        &[],
    )
    .unwrap_err();
    assert!(
        errors[0].contains("without a rerun command for -p mc-kernel --test x"),
        "{errors:?}"
    );
    validate(
        &[landed(PROVEN_IN_TARGET)],
        &catalog(&[("tests/x.rs", Some(IGNORED_RUNNABLE))]),
        &[],
    )
    .unwrap();
}

#[test]
fn a_sibling_crate_path_is_owned_by_that_crate() {
    assert_eq!(
        owning_package("../mc-host/tests/kernel_routes.rs"),
        "mc-host"
    );
    assert_eq!(owning_package("tests/kernel_backup.rs"), "mc-kernel");
    assert_eq!(owning_package("src/durable_fs.rs"), "mc-kernel");
    assert_eq!(
        owning_test_target("../mc-host/tests/kernel_routes.rs"),
        Some("kernel_routes")
    );
    assert_eq!(
        owning_test_target("tests/kernel_backup.rs"),
        Some("kernel_backup")
    );
    assert_eq!(
        owning_test_target("tests/kernel_proofs/registry.rs"),
        Some("kernel_proofs")
    );
    assert_eq!(owning_test_target("src/durable_fs.rs"), None);
}

#[test]
fn a_pending_row_needs_a_known_owner_and_fails_once_its_test_exists() {
    let absent = catalog(&[("a.rs", None)]);
    validate(&[pending(PROVEN, "bead-1")], &absent, &["bead-1"]).unwrap();

    let errors = validate(&[pending(PROVEN, "bead-2")], &absent, &["bead-1"]).unwrap_err();
    assert!(
        errors
            .iter()
            .any(|error| error.contains("not in KNOWN_BEADS")),
        "{errors:?}"
    );
    assert!(
        errors
            .iter()
            .any(|error| error.contains("no row references")),
        "{errors:?}"
    );

    let present_other = catalog(&[("a.rs", Some(OTHER_ITEM))]);
    let errors = validate(&[pending(PROVEN, "bead-1")], &present_other, &["bead-1"]).unwrap_err();
    assert!(
        errors[0].contains("promote the row to Landed"),
        "{errors:?}"
    );

    let duplicated = catalog(&[("a.rs", Some(DUPLICATED))]);
    let errors = validate(&[pending(PROVEN, "bead-1")], &duplicated, &["bead-1"]).unwrap_err();
    assert!(
        errors[0].contains("exists more than once; promote the row to Landed"),
        "{errors:?}"
    );

    validate(&[pending(ABSENT, "bead-1")], &present_other, &["bead-1"]).unwrap();
}

#[test]
fn a_contradiction_row_needs_a_known_bead_and_policy_text() {
    let row = |bead, policy_text| Row {
        id: "row",
        claim: "claim",
        status: Status::Contradiction { bead, policy_text },
    };
    validate(&[row("bead-1", "policy")], &Catalog::new(), &["bead-1"]).unwrap();
    let errors = validate(&[row("bead-9", " ")], &Catalog::new(), &["bead-1"]).unwrap_err();
    assert!(
        errors
            .iter()
            .any(|error| error.contains("not in KNOWN_BEADS")),
        "{errors:?}"
    );
    assert!(
        errors
            .iter()
            .any(|error| error.contains("without policy text")),
        "{errors:?}"
    );
}
