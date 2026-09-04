/**
 * U1 direct-cutover groundwork (KTD1): the composable current-schema snapshot
 * source. The converged non-memory schema (claims/evidence v82, applicability
 * v85, policy v86) is registered here as explicit components so the direct
 * bootstrap (U8) and the direct test factory can create the exact current
 * schema without running the legacy migration chain.
 *
 * Registered-component contract:
 *   - every component declares the top-level tables it OWNS (`provides`);
 *     indexes/triggers/views attribute to their owning table through
 *     `sqlite_schema.tbl_name`, so they never need separate declarations.
 *   - composition validates duplicate ownership, unknown/cyclic dependencies,
 *     and undeclared schema objects, then fails closed.
 *
 * Dependency-light on purpose: runtime imports use explicit `.ts` extensions
 * so the Node smoke scripts can load this module under Node's type-stripping
 * loader (which cannot resolve extensionless runtime imports).
 */
import { Database } from "../../shared/sqlite.ts";
import { type ExpectedDirectFormat } from "./storage-format-epoch.ts";
/** Canonical protocol tag for the registered-component manifest digest. */
export declare const SCHEMA_MANIFEST_PROTOCOL = "mc-schema-manifest-v1";
export interface RegisteredSchemaComponent {
    /** Stable component name; part of the manifest digest. */
    readonly name: string;
    /** Names of components that must be created first. */
    readonly dependsOn: readonly string[];
    /**
     * Top-level tables and views this component owns (exactly, no overlap).
     * Indexes and triggers attribute to their owning table through
     * `sqlite_schema.tbl_name` and are not declared separately.
     */
    readonly provides: readonly string[];
    /** Creates every owned object. Runs inside the caller's transaction. */
    readonly create: (db: Database) => void;
}
/**
 * The converged non-memory current schema, in registration order. U2 appends
 * the claim-memory component and `magic-context-3q5.9` appends the retrieval
 * projection to this same list; there is no direct-format data migration.
 */
export declare const CURRENT_SCHEMA_COMPONENTS: readonly RegisteredSchemaComponent[];
export interface SchemaComponentManifest {
    readonly protocol: typeof SCHEMA_MANIFEST_PROTOCOL;
    readonly components: ReadonlyArray<{
        readonly name: string;
        readonly dependsOn: readonly string[];
        readonly provides: readonly string[];
    }>;
}
/**
 * Validate the registered-component set. Returns every violation (empty =
 * valid): duplicate component names, duplicate table ownership, unknown
 * dependency names, and dependency cycles.
 */
export declare function validateSchemaComponents(components: readonly RegisteredSchemaComponent[]): string[];
/** Topological creation order. Throws on any validation failure. */
export declare function orderSchemaComponents(components: readonly RegisteredSchemaComponent[]): RegisteredSchemaComponent[];
/** Build the declared manifest (registration order, exact declared lists). */
export declare function buildSchemaComponentManifest(components?: readonly RegisteredSchemaComponent[]): SchemaComponentManifest;
/**
 * Canonical line encoding shared with the Rust runtimes: one protocol line,
 * then one `component ...` line per component in manifest order. The digest is
 * SHA-256 over these lines joined with '\n' (no trailing newline).
 */
export declare function canonicalSchemaManifestLines(manifest: SchemaComponentManifest): string[];
export declare function computeSchemaManifestDigest(manifest: SchemaComponentManifest): string;
/**
 * Every non-internal object name in `main.sqlite_schema`. SQLite-internal
 * objects (`sqlite_sequence`, `sqlite_autoindex_*`, `sqlite_stat*`) are engine
 * bookkeeping, not registered schema.
 */
export declare function listSchemaObjectNames(db: Database): string[];
/**
 * Create every registered component in dependency order, then fail closed if
 * any resulting schema object is not attributable to a declared owner. Runs
 * against an empty `main` schema; callers own transaction scope and PRAGMAs.
 */
export declare function composeRegisteredSchema(db: Database, components?: readonly RegisteredSchemaComponent[]): void;
/**
 * Compute the expected direct format (registered inventory plus marker
 * objects) by composing the components into a scratch in-memory database so
 * the expectation can never drift from what composition actually creates.
 */
export declare function computeExpectedDirectFormat(components?: readonly RegisteredSchemaComponent[]): ExpectedDirectFormat;
//# sourceMappingURL=storage-current-schema.d.ts.map