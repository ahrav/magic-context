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

import { createHash } from "node:crypto";
import type { Database } from "../../shared/sqlite";
import {
    addObservationSourceTrustClassColumn,
    CLAIM_APPLICABILITY_TABLES,
    createClaimApplicabilitySchema,
} from "./storage-claim-applicability-schema.ts";
import {
    CLAIM_MEMORY_TABLES,
    createClaimMemoryComponentSchema,
} from "./storage-claim-memory-schema.ts";
import { CLAIM_POLICY_TABLES, createClaimPolicySchema } from "./storage-claim-policy-schema.ts";
import {
    CLAIMS_AND_EVIDENCE_TABLES,
    createClaimsAndEvidenceSchema,
} from "./storage-claims-schema.ts";

/** Canonical protocol tag for the registered-component manifest digest. */
export const SCHEMA_MANIFEST_PROTOCOL = "mc-schema-manifest-v1";

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
export const CURRENT_SCHEMA_COMPONENTS: readonly RegisteredSchemaComponent[] = [
    {
        name: "claims-evidence",
        dependsOn: [],
        provides: CLAIMS_AND_EVIDENCE_TABLES,
        create: createClaimsAndEvidenceSchema,
    },
    {
        name: "claim-applicability",
        dependsOn: ["claims-evidence"],
        provides: [...CLAIM_APPLICABILITY_TABLES, "claim_revision_applicability_intervals"],
        create: (db) => {
            // v85 order: the observations trust-class column lands before the
            // applicability objects that classify against it.
            addObservationSourceTrustClassColumn(db);
            createClaimApplicabilitySchema(db);
        },
    },
    {
        name: "claim-policy",
        dependsOn: ["claims-evidence", "claim-applicability"],
        provides: [...CLAIM_POLICY_TABLES, "claim_maturity_heads"],
        create: createClaimPolicySchema,
    },
    {
        name: "claim-memory",
        dependsOn: ["claims-evidence", "claim-applicability", "claim-policy"],
        provides: [
            ...CLAIM_MEMORY_TABLES,
            "claim_memory_lifecycle_heads",
            "claim_project_generations",
        ],
        create: createClaimMemoryComponentSchema,
    },
];

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
export function validateSchemaComponents(
    components: readonly RegisteredSchemaComponent[],
): string[] {
    const problems: string[] = [];
    const byName = new Map<string, RegisteredSchemaComponent>();
    for (const component of components) {
        if (byName.has(component.name)) {
            problems.push(`duplicate component name: ${component.name}`);
        }
        byName.set(component.name, component);
    }
    const tableOwner = new Map<string, string>();
    for (const component of components) {
        for (const table of component.provides) {
            const owner = tableOwner.get(table);
            if (owner !== undefined && owner !== component.name) {
                problems.push(
                    `duplicate object ownership: table '${table}' is declared by '${owner}' and '${component.name}'`,
                );
            } else {
                tableOwner.set(table, component.name);
            }
        }
        for (const dependency of component.dependsOn) {
            if (!byName.has(dependency)) {
                problems.push(
                    `unknown dependency: '${component.name}' depends on undeclared component '${dependency}'`,
                );
            }
        }
    }
    // Cycle detection: iterative DFS with tri-color marking.
    const state = new Map<string, "visiting" | "done">();
    const visit = (name: string, path: string[]): void => {
        const mark = state.get(name);
        if (mark === "done") return;
        if (mark === "visiting") {
            problems.push(`dependency cycle: ${[...path, name].join(" -> ")}`);
            return;
        }
        state.set(name, "visiting");
        for (const dependency of byName.get(name)?.dependsOn ?? []) {
            if (byName.has(dependency)) visit(dependency, [...path, name]);
        }
        state.set(name, "done");
    };
    for (const component of components) visit(component.name, []);
    return problems;
}

/** Topological creation order. Throws on any validation failure. */
export function orderSchemaComponents(
    components: readonly RegisteredSchemaComponent[],
): RegisteredSchemaComponent[] {
    const problems = validateSchemaComponents(components);
    if (problems.length > 0) {
        throw new Error(`registered schema components are invalid: ${problems.join("; ")}`);
    }
    const byName = new Map(components.map((component) => [component.name, component]));
    const ordered: RegisteredSchemaComponent[] = [];
    const placed = new Set<string>();
    const place = (component: RegisteredSchemaComponent): void => {
        if (placed.has(component.name)) return;
        for (const dependency of component.dependsOn) {
            const dep = byName.get(dependency);
            if (dep) place(dep);
        }
        placed.add(component.name);
        ordered.push(component);
    };
    for (const component of components) place(component);
    return ordered;
}

/** Build the declared manifest (registration order, exact declared lists). */
export function buildSchemaComponentManifest(
    components: readonly RegisteredSchemaComponent[] = CURRENT_SCHEMA_COMPONENTS,
): SchemaComponentManifest {
    return {
        protocol: SCHEMA_MANIFEST_PROTOCOL,
        components: components.map((component) => ({
            name: component.name,
            dependsOn: [...component.dependsOn],
            provides: [...component.provides],
        })),
    };
}

/**
 * Canonical line encoding shared with the Rust runtimes: one protocol line,
 * then one `component ...` line per component in manifest order. The digest is
 * SHA-256 over these lines joined with '\n' (no trailing newline).
 */
export function canonicalSchemaManifestLines(manifest: SchemaComponentManifest): string[] {
    return [
        manifest.protocol,
        ...manifest.components.map(
            (component) =>
                `component name=${component.name} dependsOn=${component.dependsOn.join(",")} provides=${component.provides.join(",")}`,
        ),
    ];
}

export function computeSchemaManifestDigest(manifest: SchemaComponentManifest): string {
    return createHash("sha256")
        .update(canonicalSchemaManifestLines(manifest).join("\n"), "utf8")
        .digest("hex");
}

/**
 * Every non-internal object name in `main.sqlite_schema`. SQLite-internal
 * objects (`sqlite_sequence`, `sqlite_autoindex_*`, `sqlite_stat*`) are engine
 * bookkeeping, not registered schema.
 */
export function listSchemaObjectNames(db: Database): string[] {
    const rows = db
        .prepare("SELECT name FROM main.sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
}

/**
 * Create every registered component in dependency order, then fail closed if
 * any resulting schema object is not attributable to a declared owner. Runs
 * against an empty `main` schema; callers own transaction scope and PRAGMAs.
 */
export function composeRegisteredSchema(
    db: Database,
    components: readonly RegisteredSchemaComponent[] = CURRENT_SCHEMA_COMPONENTS,
): void {
    const preExisting = listSchemaObjectNames(db);
    if (preExisting.length > 0) {
        throw new Error(
            `composeRegisteredSchema requires an empty schema; found: ${preExisting.join(", ")}`,
        );
    }
    const ordered = orderSchemaComponents(components);
    for (const component of ordered) component.create(db);
    const declaredTables = new Set(components.flatMap((component) => [...component.provides]));
    const rows = db
        .prepare(
            "SELECT name, type, tbl_name FROM main.sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
        )
        .all() as Array<{ name: string; type: string; tbl_name: string }>;
    const undeclared = rows.filter((row) => !declaredTables.has(row.tbl_name));
    if (undeclared.length > 0) {
        throw new Error(
            `undeclared schema objects after composition: ${undeclared
                .map((row) => `${row.type} ${row.name} (on ${row.tbl_name})`)
                .join(", ")}`,
        );
    }
    const missing = [...declaredTables].filter(
        (name) =>
            !rows.some((row) => (row.type === "table" || row.type === "view") && row.name === name),
    );
    if (missing.length > 0) {
        throw new Error(`declared objects were not created: ${missing.join(", ")}`);
    }
}
