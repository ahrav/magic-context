import type { Database } from "../../../shared/sqlite";
import { ANTI_MEMORY_CATEGORY } from "./constants";

export function autoSearchHintFragmentsStillEligible(
    _db: Database,
    fragments: readonly { id: number; hash: string }[] | undefined,
): boolean {
    if (fragments === undefined) return false;
    return fragments.length === 0;
}

/**
 *
 *
 * `revisionExpr` must be a trusted SQL expression because the query interpolates it.
 */
/**
 *
 */
export function antiMemoryClaimSql(revisionExpr: string): string {
    return `EXISTS (
        SELECT 1 FROM claim_memory_revision_attributes anti_attrs
        WHERE anti_attrs.revision_id = ${revisionExpr}
          AND anti_attrs.category = '${ANTI_MEMORY_CATEGORY}'
    )`;
}

export function uniformlyAbsentClaimSql(revisionExpr: string, nowExpr: string): string {
    return `(
        COALESCE((
            SELECT policy.hard_hidden FROM claim_effective_policy policy
            WHERE policy.revision_id = ${revisionExpr}
        ), 0) = 1
        OR EXISTS (
            SELECT 1 FROM claim_conflicts
            WHERE relation = 'contradicts'
              AND (left_revision_id = ${revisionExpr} OR right_revision_id = ${revisionExpr})
        )
        OR COALESCE((
            SELECT action FROM claim_disposition_events
            WHERE revision_id = ${revisionExpr} AND disposition = 'quarantined'
            ORDER BY id DESC LIMIT 1
        ), 'clear') = 'assert'
        OR COALESCE((
            SELECT action FROM claim_disposition_events
            WHERE revision_id = ${revisionExpr} AND disposition = 'rejected'
            ORDER BY id DESC LIMIT 1
        ), 'clear') = 'assert'
        OR COALESCE((
            SELECT attributes.expires_at FROM claim_memory_revision_attributes attributes
            WHERE attributes.revision_id = ${revisionExpr}
        ), ${nowExpr} + 1) <= ${nowExpr}
    )`;
}
