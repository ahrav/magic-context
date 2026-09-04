/**
 * v86 claim trust policy DDL (claim-trust-policy plan: U1; KTD1, KTD2,
 * KTD5-KTD7, KTD11-KTD12).
 *
 * Dependency-light on purpose: runtime imports here must carry explicit `.ts`
 * extensions so the Node SQLite smoke
 * (`packages/plugin/scripts/smoke-node-sqlite.ts`) can import this module
 * directly under Node's type-stripping loader.
 *
 * Every object here is migration-owned (created by migration v86, never by
 * `initializeDatabase()`), following the v82/v84/v85 precedent.
 *
 * Physical model (KTD1): trust state is an append-only decision ledger, never
 * mutable columns on `claims` or `claim_revisions`. Historical maturity only
 * moves upward within one gapless per-revision stream; the effective state
 * used by retrieval is derived by the TypeScript reducer from current support
 * (verification, approval, artifact validity, dispositions) and materialized
 * into the rebuildable, non-authoritative `claim_effective_policy` projection.
 * Missing policy state reads as `CANDIDATE` / unknown taint / automatic-hidden
 * by contract (R26).
 */
import type { Database } from "../../shared/sqlite";
/** Versioned policy contract consumed by U8/U18 (R1, R18). */
export declare const CLAIM_POLICY_VERSION = 1;
export declare const CLAIM_POLICY_TABLES: readonly ["claim_revision_policy_subjects", "claim_maturity_streams", "claim_maturity_assertions", "claim_disposition_events", "claim_approval_actions", "claim_enforcement_artifacts", "claim_enforcement_artifact_events", "claim_effective_policy", "claim_policy_projector_watermarks"];
/** Claim kinds (R2). `unknown` receives directive-strength restrictions. */
export declare const CLAIM_KINDS: readonly ["descriptive", "directive", "unknown"];
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export declare const FINE_TAINTS: readonly ["USER_EXPLICIT", "USER_INFERRED", "CURRENT_CODE", "CURRENT_TEST", "CURRENT_CONFIG", "REPO_UNTRUSTED_TEXT", "TOOL_UNTRUSTED_OUTPUT", "ASSISTANT_INFERENCE", "DREAMER_INFERENCE"];
export type FineTaint = (typeof FINE_TAINTS)[number];
/** Maturity ladder (R7). Historical assertions only move upward (R15). */
export declare const MATURITY_LEVELS: readonly ["CANDIDATE", "CORROBORATED", "VERIFIED", "APPROVED", "ENFORCED"];
export type MaturityLevel = (typeof MATURITY_LEVELS)[number];
export declare const MATURITY_RANK: Readonly<Record<MaturityLevel, number>>;
/**
 * Explicit disposition kinds owned by `claim_disposition_events` (R14).
 * `contradicted` and `superseded` derive from `claim_conflicts`; verification
 * `stale`/`flagged` events additionally feed the reducer's stale/disputed
 * facts. Rejected is review-only; quarantined is hard-hidden (R16-R17).
 */
export declare const DISPOSITION_KINDS: readonly ["stale", "disputed", "rejected", "quarantined"];
export type DispositionKind = (typeof DISPOSITION_KINDS)[number];
export declare const DISPOSITION_ACTIONS: readonly ["assert", "clear"];
export type DispositionAction = (typeof DISPOSITION_ACTIONS)[number];
/** Host-recorded human authority actions (R10, KTD5). */
export declare const APPROVAL_ACTIONS: readonly ["approve", "revoke"];
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];
/** Content-addressed enforcement artifact kinds (R11, KTD6). */
export declare const ENFORCEMENT_ARTIFACT_KINDS: readonly ["test", "policy", "config"];
export type EnforcementArtifactKind = (typeof ENFORCEMENT_ARTIFACT_KINDS)[number];
export declare const ENFORCEMENT_ARTIFACT_RESULTS: readonly ["pass", "fail"];
export type EnforcementArtifactResult = (typeof ENFORCEMENT_ARTIFACT_RESULTS)[number];
/** Append-only artifact support removal (KTD6). Re-validation appends a new
 * artifact row; there is no mutate-in-place path. */
export declare const ENFORCEMENT_ARTIFACT_EVENT_ACTIONS: readonly ["revoked"];
/** Full v86 object graph: tables from dependency roots outward, indexes, the
 * head view, then guards. */
export declare function createClaimPolicySchema(db: Database): void;
//# sourceMappingURL=storage-claim-policy-schema.d.ts.map