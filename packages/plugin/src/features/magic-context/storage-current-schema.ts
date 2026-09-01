/**
 * The composable current-schema snapshot source. The converged non-memory
 * schema (claims/evidence v82, applicability v85, policy v86) is registered
 * here as explicit components so the direct bootstrap and the direct test
 * factory can create the exact current schema without running the legacy
 * migration chain.
 *
 * Registered-component contract:
 *   - every component declares the top-level tables it OWNS (`provides`);
 * Composition validates duplicate ownership, unknown dependencies, and dependency cycles.
 * Composition fails closed when it finds undeclared schema objects.
 *
 * Runtime imports use explicit `.ts` extensions because Node's type-stripping loader cannot resolve extensionless imports.
 */

import { createHash } from "node:crypto";
import { Database } from "../../shared/sqlite.ts";
import { ANTI_MEMORY_TABLES, createAntiMemorySchema } from "./storage-anti-memory-schema.ts";
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
import {
    createDirectFormatMarkerSchema,
    DIRECT_FORMAT_EPOCH,
    type ExpectedDirectFormat,
    MC_APPLICATION_ID,
} from "./storage-format-epoch.ts";
import {
    createSessionRuntimeSchema,
    SESSION_RUNTIME_TABLES,
} from "./storage-session-runtime-schema.ts";

/** SCHEMA_MANIFEST_PROTOCOL is the canonical protocol tag in the registered-component manifest digest. */
export const SCHEMA_MANIFEST_PROTOCOL = "mc-schema-manifest-v1";

export interface RegisteredSchemaComponent {
    /** name is stable and contributes to the manifest digest. */
    readonly name: string;
    /** Each dependency must be created before its component. */
    readonly dependsOn: readonly string[];
    /**
     * provides lists the top-level tables and views owned by the component; component lists cannot overlap.
     * Indexes and triggers use `sqlite_schema.tbl_name` to attribute ownership to their owning table, so they need no separate declarations.
     */
    readonly provides: readonly string[];
    /** `create` creates every owned object inside the caller's transaction. */
    readonly create: (db: Database) => void;
}

/**
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
            // The observations trust-class column is added before applicability objects classify against it.
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
    {
        name: "anti-memory",
        dependsOn: ["claims-evidence", "claim-memory"],
        provides: ANTI_MEMORY_TABLES,
        create: createAntiMemorySchema,
    },
    {
        name: "session-runtime",
        dependsOn: [],
        provides: SESSION_RUNTIME_TABLES,
        create: createSessionRuntimeSchema,
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
 * The validator returns every violation; an empty result is valid.
 * The validator reports duplicate component names and duplicate table ownership.
 * The validator reports unknown dependency names and dependency cycles.
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

/** The composer creates components in topological order and throws when validation fails. */
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

/** The manifest preserves registration order and each component's exact declared lists. */
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
 * The canonical encoding begins with one protocol line.
 * The encoding emits one `component ...` line for each component in manifest order.
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
 * SQLite treats `sqlite_sequence`, `sqlite_autoindex_*`, and `sqlite_stat*` as internal bookkeeping rather than registered schema.
 */
export function listSchemaObjectNames(db: Database): string[] {
    const rows = db
        .prepare("SELECT name FROM main.sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
}

/**
 * `composeRegisteredSchema` creates components in dependency order and rejects undeclared non-internal schema objects.
 * `composeRegisteredSchema` rejects non-internal schema objects whose `tbl_name` is absent from every component's `provides` list.
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

/**
 */
export function computeExpectedDirectFormat(
    components: readonly RegisteredSchemaComponent[] = CURRENT_SCHEMA_COMPONENTS,
): ExpectedDirectFormat {
    const manifest = buildSchemaComponentManifest(components);
    const scratch = new Database(":memory:");
    try {
        scratch.exec("PRAGMA foreign_keys=ON");
        composeRegisteredSchema(scratch, components);
        createDirectFormatMarkerSchema(scratch);
        return {
            applicationId: MC_APPLICATION_ID,
            formatEpoch: DIRECT_FORMAT_EPOCH,
            componentManifestDigest: computeSchemaManifestDigest(manifest),
            schemaObjectNames: listSchemaObjectNames(scratch),
        };
    } finally {
        scratch.close();
    }
}
