/**
 * Claim-aware memory visibility readers (KTD7-KTD8): the snapshot-provider
 * contract every current agent-facing surface consumes. Decisions come from
 * the indexed `claim_effective_policy` projection through the
 * `legacy_memory_claims` crosswalk; a retrieval-document provider replaces
 * this adapter without changing consumer behavior.
 *
 * Fail-closed semantics (R19-R22, R26): a memory with no claim link, no
 * projection row, or an unsupported policy version is automatic-hidden;
 * explicit search may include it only as a labeled unknown. Hard-hidden rows
 * (contradicted/quarantined) and review-only rejected rows return uniform
 * absence on every agent surface — those facts are read from the authoritative
 * conflict/disposition rows, not the projection, so absence does not depend on
 * the projection existing or on its policy version being understood.
 */

import type { Database } from "../../../shared/sqlite";
import { CLAIM_POLICY_VERSION, explicitSearchLabelFromFields } from "./claim-visibility-policy";
import type { Memory } from "./types";

export type MemoryPolicySurface = "auto_inject" | "auto_search" | "explicit_search";

export interface MemoryPolicyRow {
    memoryId: number;
    claimId: number;
    revisionId: number | null;
    /**
     * False when no `claim_effective_policy` row backs this memory. The
     * maturity/taint/eligibility fields are then defaults, NOT stored state,
     * and only the authoritative hard-hide facts below may be trusted.
     */
    projected: boolean;
    effectiveMaturity: string;
    originTaint: string;
    autoEligible: boolean;
    explicitEligible: boolean;
    hardHidden: boolean;
    /**
     * Authoritative hard-hide and review-only facts, read from
     * `claim_conflicts` / `claim_disposition_events` rather than the
     * projection, so uniform absence does not depend on a projection row
     * existing or on its policy version being understood (R17, R22, R26).
     */
    contradicted: boolean;
    quarantined: boolean;
    rejected: boolean;
    /**
     * Authoritative soft-hide facts, read from `verification_events` /
     * `claim_disposition_events` (mirroring `readActiveDispositions`): a
     * policy-unaware writer can append a stale/flagged verification without
     * refreshing the projection, and projected eligibility must not outlive
     * that event.
     */
    stale: boolean;
    disputed: boolean;
    dispositions: string[];
    policyVersion: number;
    generation: number;
}

export interface MemoryPolicyDecision {
    eligible: boolean;
    /** Sanitized agent label for labeled explicit-search rendering; null for
     * clean rows and for every ineligible row. */
    label: string | null;
}

export function hasClaimEffectivePolicy(db: Database): boolean {
    return (
        db
            .prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claim_effective_policy'",
            )
            .get() != null
    );
}

/** Indexed policy rows for a set of memory ids through the crosswalk. Ids
 * without a claim link are absent from the map; a linked id with no projection
 * row is present with `projected: false` so its authoritative hard-hide facts
 * still gate every surface. */
export function readMemoryPolicyRows(
    db: Database,
    memoryIds: readonly number[],
): Map<number, MemoryPolicyRow> {
    const map = new Map<number, MemoryPolicyRow>();
    if (memoryIds.length === 0 || !hasClaimEffectivePolicy(db)) return map;
    const CHUNK = 400;
    for (let index = 0; index < memoryIds.length; index += CHUNK) {
        const chunk = memoryIds.slice(index, index + CHUNK);
        const placeholders = chunk.map(() => "?").join(", ");
        const rows = db
            .prepare(
                // Interpolation is a compile-time placeholder list, not caller input.
                // pi-lens-ignore: sql-injection
                `SELECT lmc.memory_id AS memoryId, claims.id AS claimId,
                        claims.current_revision_id AS revisionId,
                        policy.revision_id IS NOT NULL AS projected,
                        policy.effective_maturity AS effectiveMaturity,
                        policy.origin_taint AS originTaint,
                        policy.auto_eligible AS autoEligible,
                        policy.explicit_eligible AS explicitEligible,
                        policy.hard_hidden AS hardHidden,
                        policy.dispositions_json AS dispositionsJson,
                        policy.policy_version AS policyVersion,
                        policy.generation AS generation,
                        EXISTS (
                            SELECT 1 FROM claim_conflicts
                            WHERE relation = 'contradicts'
                              AND (left_revision_id = claims.current_revision_id
                                   OR right_revision_id = claims.current_revision_id)
                        ) AS contradicted,
                        COALESCE((
                            SELECT action FROM claim_disposition_events
                            WHERE revision_id = claims.current_revision_id
                              AND disposition = 'quarantined'
                            ORDER BY id DESC LIMIT 1
                        ), 'clear') = 'assert' AS quarantined,
                        COALESCE((
                            SELECT action FROM claim_disposition_events
                            WHERE revision_id = claims.current_revision_id
                              AND disposition = 'rejected'
                            ORDER BY id DESC LIMIT 1
                        ), 'clear') = 'assert' AS rejected,
                        COALESCE((
                            SELECT outcome FROM verification_events
                            WHERE revision_id = claims.current_revision_id
                              AND outcome IN ('verified', 'stale', 'flagged')
                            ORDER BY id DESC LIMIT 1
                        ), '') = 'stale' OR COALESCE((
                            SELECT action FROM claim_disposition_events
                            WHERE revision_id = claims.current_revision_id
                              AND disposition = 'stale'
                            ORDER BY id DESC LIMIT 1
                        ), 'clear') = 'assert' AS stale,
                        COALESCE((
                            SELECT outcome FROM verification_events
                            WHERE revision_id = claims.current_revision_id
                              AND outcome IN ('verified', 'stale', 'flagged')
                            ORDER BY id DESC LIMIT 1
                        ), '') = 'flagged' OR COALESCE((
                            SELECT action FROM claim_disposition_events
                            WHERE revision_id = claims.current_revision_id
                              AND disposition = 'disputed'
                            ORDER BY id DESC LIMIT 1
                        ), 'clear') = 'assert' AS disputed
                 FROM legacy_memory_claims lmc
                 JOIN claims ON claims.id = lmc.claim_id
                 LEFT JOIN claim_effective_policy policy
                     ON policy.revision_id = claims.current_revision_id
                 WHERE lmc.memory_id IN (${placeholders})`,
            )
            .all(...chunk) as Array<{
            memoryId: number;
            claimId: number;
            revisionId: number | null;
            projected: number;
            effectiveMaturity: string | null;
            originTaint: string | null;
            autoEligible: number | null;
            explicitEligible: number | null;
            hardHidden: number | null;
            dispositionsJson: string | null;
            policyVersion: number | null;
            generation: number | null;
            contradicted: number;
            quarantined: number;
            rejected: number;
            stale: number;
            disputed: number;
        }>;
        for (const row of rows) {
            let dispositions: string[] = [];
            try {
                dispositions = JSON.parse(row.dispositionsJson ?? "[]") as string[];
            } catch {
                dispositions = [];
            }
            map.set(row.memoryId, {
                memoryId: row.memoryId,
                claimId: row.claimId,
                revisionId: row.revisionId,
                projected: row.projected === 1,
                effectiveMaturity: row.effectiveMaturity ?? "CANDIDATE",
                originTaint: row.originTaint ?? "unknown",
                autoEligible: row.autoEligible === 1,
                explicitEligible: row.explicitEligible === 1,
                hardHidden: row.hardHidden === 1,
                contradicted: row.contradicted === 1,
                quarantined: row.quarantined === 1,
                rejected: row.rejected === 1,
                stale: row.stale === 1,
                disputed: row.disputed === 1,
                dispositions,
                policyVersion: row.policyVersion ?? 0,
                generation: row.generation ?? 0,
            });
        }
    }
    return map;
}

/** One table-driven decision per surface over the projected fields (R18). */
export function decideMemoryPolicy(
    row: MemoryPolicyRow | undefined,
    surface: MemoryPolicySurface,
): MemoryPolicyDecision {
    // Hard-hide and review-only rejection are decided from authoritative rows,
    // so they hold even when the projection is absent (pre-seed window) or was
    // written by a policy version this build cannot interpret. Absence of a
    // projection must never make a contradicted/quarantined row surfaceable:
    // that would break uniform absence (R17, R22).
    if (row != null && (row.hardHidden || row.contradicted || row.quarantined || row.rejected)) {
        return { eligible: false, label: null };
    }
    // `unprojected` means "no trustworthy stored decision": no projection row,
    // or a future policy version. Fail closed on automatic surfaces; explicit
    // search may still show it as a labeled unknown.
    const unprojected = row == null || !row.projected || row.policyVersion > CLAIM_POLICY_VERSION;
    // Authoritative soft-hide facts outrank projected eligibility: a
    // policy-unaware writer (a pre-v86 binary holding the database open) can
    // append a stale/flagged verification without refreshing the projection,
    // and the stored `autoEligible` must not keep injecting that revision.
    const authoritativeStale = row != null && row.stale;
    const authoritativeDisputed = row != null && row.disputed;
    if (surface === "explicit_search") {
        if (!unprojected && !row.explicitEligible) {
            return { eligible: false, label: null };
        }
        const dispositions = [...(row?.dispositions ?? [])];
        if (authoritativeStale && !dispositions.includes("stale")) dispositions.push("stale");
        if (authoritativeDisputed && !dispositions.includes("disputed")) {
            dispositions.push("disputed");
        }
        return {
            eligible: true,
            label: explicitSearchLabelFromFields({
                effectiveMaturity: unprojected ? "CANDIDATE" : row.effectiveMaturity,
                originTaint: unprojected ? "unknown" : row.originTaint,
                dispositions,
                policyMissing: unprojected,
                autoEligible:
                    !unprojected &&
                    row.autoEligible &&
                    !authoritativeStale &&
                    !authoritativeDisputed,
            }),
        };
    }
    if (unprojected || !row.autoEligible || authoritativeStale || authoritativeDisputed) {
        return { eligible: false, label: null };
    }
    return { eligible: true, label: null };
}

export interface MemoryPolicyFilterResult {
    memories: Memory[];
    /** Sanitized labels keyed by memory id, for labeled explicit rendering. */
    labels: Map<number, string>;
}

/** Apply the surface decision to a loaded memory list before any candidate
 * limit or scoring consumes slots (R21). */
export function filterMemoriesByPolicy(
    db: Database,
    memories: readonly Memory[],
    surface: MemoryPolicySurface,
): MemoryPolicyFilterResult {
    if (!hasClaimEffectivePolicy(db)) {
        return { memories: [...memories], labels: new Map() };
    }
    const rows = readMemoryPolicyRows(
        db,
        memories.map((memory) => memory.id),
    );
    const kept: Memory[] = [];
    const labels = new Map<number, string>();
    for (const memory of memories) {
        const decision = decideMemoryPolicy(rows.get(memory.id), surface);
        if (!decision.eligible) continue;
        kept.push(memory);
        if (decision.label) labels.set(memory.id, decision.label);
    }
    return { memories: kept, labels };
}
