import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { listSchemaObjectNames } from "./storage-current-schema";
import { createDirectTestDatabase } from "./test-database";

const REPO_ROOT = existsSync(resolve(process.cwd(), "packages", "plugin"))
    ? process.cwd()
    : resolve(process.cwd(), "../..");
const INVENTORY_COUNT = 361;
const INVENTORY_SHA256 = "f68787e374938276a514f8bade0c10c2b9187a2f4cf55cc261daefbee0ba1883";

const REQUIRED_DIRECT_OBJECTS = [
    "mc_format_marker",
    "projects",
    "claims",
    "claim_revisions",
    "claim_evidence",
    "claim_public_ids",
    "claim_memory_revision_attributes",
    "claim_memory_lifecycle_events",
    "claim_memory_lifecycle_heads",
    "claim_memory_current_heads",
    "claim_revision_applicability_streams",
    "claim_revision_applicability_assertions",
    "claim_revision_policy_subjects",
    "claim_effective_policy",
    "claim_operation_receipts",
    "claim_operation_effects",
    "claim_project_generations",
    "claim_outbox_consumer_checkpoints",
] as const;

const RETIRED_SCHEMA_OBJECT =
    /^(?:memories(?:_fts(?:_.+)?)?|mc_memories|mc_memory_mappings|memory_(?:fts(?:_.+)?|embeddings|stats|verifications|mutation_log|mutations)|legacy_memory_claims|claims?_backfill(?:_.+)?|claim_backfill(?:_.+)?|claim_compatibility(?:_.+)?)$/i;

const RETIRED_MODULE_PATHS = [
    "packages/plugin/src/features/magic-context/claims-backfill.ts",
    "packages/plugin/src/features/magic-context/claims-backfill-startup.ts",
    "packages/plugin/src/features/magic-context/claim-policy-backfill.ts",
    "packages/plugin/src/features/magic-context/claim-policy-backfill-startup.ts",
    "packages/plugin/src/features/magic-context/storage-memory-claims-schema.ts",
    "packages/plugin/src/features/magic-context/memory/storage-memory.ts",
    "packages/plugin/src/features/magic-context/memory/storage-memory-claims.ts",
    "packages/plugin/src/features/magic-context/memory/storage-memory-projection.ts",
    "packages/plugin/src/features/magic-context/memory/storage-memory-verifications.ts",
    "packages/plugin/src/features/magic-context/memory/storage-memory-fts.ts",
    "packages/plugin/src/features/magic-context/memory/storage-memory-embeddings.ts",
    "packages/plugin/src/features/magic-context/storage-memory-mutation-log.ts",
    "packages/plugin/src/features/magic-context/memory/memory-migration.ts",
    "packages/plugin/src/features/magic-context/search-result-locator.ts",
    "packages/pi-plugin/src/pi-memory-migration.ts",
    "packages/cli/src/lib/claims-backfill-commands.ts",
] as const;

const SOURCE_ROOTS = [
    "packages/plugin/src",
    // Executable experiment and benchmark scripts run against a real database,
    // so retired SQL here corrupts results rather than failing to compile. One
    // such script wrapped its `memory_fts` query in a catch that returned an
    // empty array, reporting zero recall instead of a missing table.
    "packages/plugin/scripts",
    "packages/pi-plugin/src",
    "packages/cli/src",
    "crates",
] as const;
const SOURCE_EXTENSION = /\.(?:ts|tsx|js|mjs|rs)$/;

/**
 * The retrieval-benchmark fixture store, which still creates and writes the
 * retired `memories` and `memory_embeddings` tables.
 *
 * It is exempt from the retired-SQL rule alone, not from the scan: the corpus it
 * seeds is evaluated through `unifiedSearch`, which runs no memory source, so the
 * fixture cannot be pointed at a claim-backed equivalent until that retrieval
 * path exists. Naming the one path keeps the exemption greppable and keeps every
 * other file under `packages/plugin/scripts` covered.
 */
const RETRIEVAL_BENCHMARK_MEMORY_FIXTURE =
    "packages/plugin/scripts/retrieval-benchmark/memory-vector-store.ts";

interface SourceRule {
    name: string;
    pattern: RegExp;
    appliesTo?: (path: string) => boolean;
}

const SOURCE_RULES: readonly SourceRule[] = [
    {
        name: "retired project-memory module import",
        pattern:
            /\b(?:from\s*|import\s*\(|require\s*\()\s*["'][^"']*(?:claims-backfill(?:-startup)?|claim-policy-backfill(?:-startup)?|storage-memory(?:-claims|-projection|-verifications|-fts|-embeddings)?|memory-migration|search-result-locator|pi-memory-migration|claims-backfill-commands)(?:\.[cm]?[jt]s)?["']/,
    },
    {
        name: "retired project-memory SQL object",
        pattern:
            /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|ON|DELETE\s+FROM)\s+(?:main\.)?(?:memories(?:_fts(?:_\w+)?)?|mc_memories|mc_memory_mappings|memory_(?:fts(?:_\w+)?|embeddings|stats|verifications|mutation_log|mutations)|legacy_memory_claims|claims?_backfill_\w+|claim_compatibility_\w+)\b/,
        appliesTo: (path) => path !== RETRIEVAL_BENCHMARK_MEMORY_FIXTURE,
    },
    {
        name: "retired numeric project-memory wire key",
        pattern:
            /["'](?:memory_id|memory_ids|target_memory_id|rendered_memory_ids|max_memory_id|superseded_by_memory_id)["']\s*:/,
        appliesTo: (path) => !path.includes("/features/magic-context/user-memory/"),
    },
    {
        name: "retired claims-backfill Doctor command",
        pattern: /(?:--check-claims-backfill|--retry-claims-backfill|doctor\s+claims-backfill)/i,
        appliesTo: (path) => path.startsWith("packages/cli/src/"),
    },
];

function excludedProductionPath(path: string): boolean {
    const segments = path.split("/");
    return (
        path.endsWith(".test.ts") ||
        path.endsWith(".test.tsx") ||
        path.endsWith(".spec.ts") ||
        segments.some((segment) =>
            [
                "dist",
                "generated",
                "fixtures",
                "tui-compiled",
                "vendor",
                "node_modules",
                "target",
                "tests",
                "testdata",
                "benches",
                "examples",
                "__tests__",
            ].includes(segment),
        )
    );
}

function collectSourceFiles(root: string): string[] {
    const absoluteRoot = resolve(REPO_ROOT, root);
    if (!existsSync(absoluteRoot)) return [];
    const files: string[] = [];
    const visit = (path: string): void => {
        const stats = statSync(path);
        if (stats.isDirectory()) {
            for (const entry of readdirSync(path)) visit(resolve(path, entry));
            return;
        }
        const repositoryPath = relative(REPO_ROOT, path).split(sep).join("/");
        if (SOURCE_EXTENSION.test(repositoryPath) && !excludedProductionPath(repositoryPath)) {
            files.push(repositoryPath);
        }
    };
    visit(absoluteRoot);
    return files;
}

function productionSourceFiles(): string[] {
    return SOURCE_ROOTS.flatMap(collectSourceFiles).sort();
}

function productionLines(path: string): string[] {
    const lines = readFileSync(resolve(REPO_ROOT, path), "utf8").split("\n");
    if (!path.endsWith(".rs")) return lines;
    const production: string[] = [];
    let skippingTestItem = false;
    let sawItemBlock = false;
    let blockDepth = 0;
    for (const line of lines) {
        if (!skippingTestItem && line.trim() === "#[cfg(test)]") {
            skippingTestItem = true;
            sawItemBlock = false;
            blockDepth = 0;
            continue;
        }
        if (!skippingTestItem) {
            production.push(line);
            continue;
        }
        if (!sawItemBlock && line.trim().startsWith("#[")) continue;
        const opens = line.split("{").length - 1;
        const closes = line.split("}").length - 1;
        if (opens > 0) sawItemBlock = true;
        blockDepth += opens - closes;
        if ((sawItemBlock && blockDepth <= 0) || (!sawItemBlock && line.trim().endsWith(";"))) {
            skippingTestItem = false;
        }
    }
    return production;
}

function sourceViolations(files: readonly string[]): string[] {
    const matches = new Map<string, Array<{ line: number; text: string }>>();
    for (const path of files) {
        const lines = productionLines(path);
        for (const rule of SOURCE_RULES) {
            if (rule.appliesTo && !rule.appliesTo(path)) continue;
            for (const [index, line] of lines.entries()) {
                if (!rule.pattern.test(line)) continue;
                const key = `${path}\u0000${rule.name}`;
                const found = matches.get(key) ?? [];
                found.push({ line: index + 1, text: line.trim() });
                matches.set(key, found);
            }
        }
    }
    return [...matches.entries()].map(([key, found]) => {
        const [path, rule] = key.split("\u0000");
        const first = found[0]!;
        return `${path}:${first.line}: ${rule} (${found.length} match${found.length === 1 ? "" : "es"}; first: ${first.text})`;
    });
}

describe("U8 direct claims cutover gate", () => {
    test("fresh direct schema has the exact frozen inventory and required claim objects", () => {
        const { db } = createDirectTestDatabase();
        try {
            const names = listSchemaObjectNames(db);
            const digest = createHash("sha256").update(names.join("\n")).digest("hex");
            expect(names).toHaveLength(INVENTORY_COUNT);
            expect(digest).toBe(INVENTORY_SHA256);
            expect(
                db
                    .prepare(
                        "SELECT type, COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' GROUP BY type ORDER BY type",
                    )
                    .all(),
            ).toEqual([
                { type: "index", count: 93 },
                { type: "table", count: 122 },
                { type: "trigger", count: 142 },
                { type: "view", count: 4 },
            ]);
            for (const required of REQUIRED_DIRECT_OBJECTS) expect(names).toContain(required);
            expect(names.filter((name) => RETIRED_SCHEMA_OBJECT.test(name))).toEqual([]);
        } finally {
            db.close();
        }
    });

    test("retired project-memory modules are deleted", () => {
        expect(RETIRED_MODULE_PATHS.filter((path) => existsSync(resolve(REPO_ROOT, path)))).toEqual(
            [],
        );
    });

    test("shipped production source contains no retired imports, SQL, wire keys, or Doctor commands", () => {
        const files = productionSourceFiles();
        expect(files.length).toBeGreaterThan(100);
        expect(sourceViolations(files)).toEqual([]);
    });
});
