/**
 * Shared project-identity discovery and terminal-chain resolution.
 *
 * One algorithm serves three consumers so they cannot drift: the v82 migration
 * seeds `projects`/`project_aliases` from it, workspace expansion resolves
 * historical aliases through it, and runtime identity merges flatten both the
 * legacy `v22_identity_rekey_map` and the numeric registry through it.
 *
 * Dependency-light on purpose: type-only imports keep this module loadable by
 * the Node SQLite smoke script, whose loader cannot resolve extensionless
 * runtime imports.
 */
import type { Database } from "../../shared/sqlite";
export interface IdentityTableInfo {
    name: string;
    identityColumn: string;
    derived: boolean;
}
export declare function quoteIdentifier(identifier: string): string;
export declare function tableExists(db: Database, tableName: string): boolean;
/** Every table carrying a project identity column, flagged when search-derived. */
export declare function discoverIdentityTables(db: Database): IdentityTableInfo[];
/**
 * Canonical identities are `git:<root-commit>` or `dir:<hash>`. Raw filesystem
 * paths are not canonical and stay in the v22 repair path until rekeyed.
 */
export declare function isCanonicalProjectIdentity(identity: string): boolean;
/**
 * Walk a rekey chain to its terminal identity. A cycle aborts with a bounded
 * diagnostic instead of seeding split or looping authoritative history.
 */
export declare function resolveTerminalIdentity(rekeyMap: ReadonlyMap<string, string>, identity: string): string;
export interface ProjectIdentitySeed {
    /** Sorted canonical identities that become `projects` rows. */
    terminals: string[];
    /** Every identity (self and historical) mapped to its terminal. */
    aliasTargets: Map<string, string>;
    /**
     * Bounded diagnostics for identities whose rekey chain is cyclic. Cycles
     * are legacy repair-path corruption (old merge flows upserted `old→new`
     * with no acyclicity check); they skip registration instead of failing
     * the owning migration, matching the tolerant read path in
     * `collectAliasesForTargets`.
     */
    skippedCycles: string[];
}
/**
 * Collect every observed canonical identity plus every rekey-map key, resolve
 * each through the terminal-chain algorithm, and produce the seed set. Chains
 * that terminate at a non-canonical identity are left to the v22 repair path;
 * cyclic chains are skipped and reported rather than aborting the migration.
 */
export declare function resolveProjectIdentitySeed(db: Database): ProjectIdentitySeed;
/**
 * Insert the seed rows. No OR IGNORE: an unexpected collision must abort the
 * owning migration rather than silently splitting authoritative history.
 */
export declare function seedProjectRegistry(db: Database, seed: ProjectIdentitySeed, now: number): void;
/**
 * Resolve every historical alias of the given canonical identities, walking
 * multi-hop rekey chains and the numeric registry. Corrupt cycles skip their
 * chain instead of failing the read path.
 */
export declare function collectAliasesForTargets(db: Database, targets: readonly string[]): Map<string, string>;
/**
 * Keep the numeric registry atomic with a runtime identity merge. Must run
 * inside the caller's immediate write transaction so a competing authoritative
 * child insert either precedes the checked failure or follows a completed safe
 * merge. Throwing rolls back the whole merge, leaving both registries intact.
 */
export declare function applyIdentityMergeToProjectRegistry(db: Database, fromIdentity: string, toIdentity: string, now: number): void;
//# sourceMappingURL=storage-project-identities.d.ts.map