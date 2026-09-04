import type { Database } from "../../../shared/sqlite";
export declare function autoSearchHintFragmentsStillEligible(_db: Database, fragments: readonly {
    id: number;
    hash: string;
}[] | undefined): boolean;
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
/**
 * SQL predicate: this revision is an anti-memory row.
 *
 * Shared so the reader filter and the maintenance gate counters cannot drift
 * apart. They must agree: a gate that counts a claim its reader will not return
 * is backlog the scheduler can never drain, and it reopens the work forever.
 * The category is a compile-time constant, never caller input, so it is
 * interpolated rather than bound — callers compose this into larger fragments
 * whose bindings they own.
 */
export declare function antiMemoryClaimSql(revisionExpr: string): string;
export declare function uniformlyAbsentClaimSql(revisionExpr: string, nowExpr: string): string;
//# sourceMappingURL=storage-claim-visibility.d.ts.map