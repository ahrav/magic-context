import type { Database } from "../../../shared/sqlite";

export function autoSearchHintFragmentsStillEligible(
    _db: Database,
    fragments: readonly { id: number; hash: string }[] | undefined,
): boolean {
    if (fragments === undefined) return false;
    return fragments.length === 0;
}
