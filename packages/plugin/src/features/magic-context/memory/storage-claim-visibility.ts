import type { Database } from "../../../shared/sqlite";

export function autoSearchHintFragmentsStillEligible(
    _db: Database,
    fragments: readonly { id: number; hash: string }[] | undefined,
): boolean {
    if (fragments === undefined) return false;
    return fragments.length === 0;
}

/**
 * SQL boolean that is TRUE when the claim at `revisionExpr` is uniformly absent
 * — hard-hidden, contradicted, quarantined, rejected, or expired.
 *
 * These are the facts `surfaceDecision` excludes on EVERY surface, maintenance
 * lanes included, so any query that counts runnable work has to apply them or it
 * reports a pool its runner will not see. Defined here, beside the authoritative
 * per-fact reads above, so the rule has one definition.
 *
 * `revisionExpr` and `nowExpr` are caller-supplied SQL expressions, never user
 * input; every call site passes a literal column reference or bind placeholder.
 */
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
