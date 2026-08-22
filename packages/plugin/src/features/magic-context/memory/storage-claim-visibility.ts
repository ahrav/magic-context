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
 * (contradicted/quarantined) return uniform absence on every agent surface.
 */

import type { Database } from "../../../shared/sqlite";
import { CLAIM_POLICY_VERSION, explicitSearchLabelFromFields } from "./claim-visibility-policy";
import type { Memory } from "./types";

export type MemoryPolicySurface = "auto_inject" | "auto_search" | "explicit_search";

export interface MemoryPolicyRow {
    memoryId: number;
    claimId: number;
    revisionId: number;
    effectiveMaturity: string;
    originTaint: string;
    autoEligible: boolean;
    explicitEligible: boolean;
    hardHidden: boolean;
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
 * without a link or projection row are absent from the map. */
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
                        policy.revision_id AS revisionId,
                        policy.effective_maturity AS effectiveMaturity,
                        policy.origin_taint AS originTaint,
                        policy.auto_eligible AS autoEligible,
                        policy.explicit_eligible AS explicitEligible,
                        policy.hard_hidden AS hardHidden,
                        policy.dispositions_json AS dispositionsJson,
                        policy.policy_version AS policyVersion,
                        policy.generation AS generation
                 FROM legacy_memory_claims lmc
                 JOIN claims ON claims.id = lmc.claim_id
                 JOIN claim_effective_policy policy
                     ON policy.revision_id = claims.current_revision_id
                 WHERE lmc.memory_id IN (${placeholders})`,
            )
            .all(...chunk) as Array<{
            memoryId: number;
            claimId: number;
            revisionId: number;
            effectiveMaturity: string;
            originTaint: string;
            autoEligible: number;
            explicitEligible: number;
            hardHidden: number;
            dispositionsJson: string;
            policyVersion: number;
            generation: number;
        }>;
        for (const row of rows) {
            let dispositions: string[] = [];
            try {
                dispositions = JSON.parse(row.dispositionsJson) as string[];
            } catch {
                dispositions = [];
            }
            map.set(row.memoryId, {
                memoryId: row.memoryId,
                claimId: row.claimId,
                revisionId: row.revisionId,
                effectiveMaturity: row.effectiveMaturity,
                originTaint: row.originTaint,
                autoEligible: row.autoEligible === 1,
                explicitEligible: row.explicitEligible === 1,
                hardHidden: row.hardHidden === 1,
                dispositions,
                policyVersion: row.policyVersion,
                generation: row.generation,
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
    const missing = row == null || row.policyVersion > CLAIM_POLICY_VERSION;
    if (surface === "explicit_search") {
        if (row != null && row.hardHidden) return { eligible: false, label: null };
        if (row != null && !missing && !row.explicitEligible) {
            return { eligible: false, label: null };
        }
        return {
            eligible: true,
            label: explicitSearchLabelFromFields({
                effectiveMaturity: row?.effectiveMaturity ?? "CANDIDATE",
                originTaint: missing ? "unknown" : (row?.originTaint ?? "unknown"),
                dispositions: row?.dispositions ?? [],
                policyMissing: missing,
                autoEligible: row?.autoEligible ?? false,
            }),
        };
    }
    if (missing || row.hardHidden || !row.autoEligible) return { eligible: false, label: null };
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
