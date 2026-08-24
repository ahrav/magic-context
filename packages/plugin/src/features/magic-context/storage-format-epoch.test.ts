/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import vocabulary from "./fixtures/direct-format-vocabulary-v1.json";
import {
    buildSchemaComponentManifest,
    CURRENT_SCHEMA_COMPONENTS,
    canonicalSchemaManifestLines,
    composeRegisteredSchema,
    computeSchemaManifestDigest,
    type RegisteredSchemaComponent,
    SCHEMA_MANIFEST_PROTOCOL,
    validateSchemaComponents,
} from "./storage-current-schema";
import {
    buildDirectFormatMarker,
    classifyDatabaseFormatFamily,
    computeMarkerDigest,
    DATABASE_RESET_MARKER_SUFFIX,
    DIRECT_FORMAT_EPOCH,
    DIRECT_FORMAT_MARKER_TABLE,
    FORMAT_MARKER_DIGEST_PROTOCOL,
    type FormatFamilyInspection,
    generateDatabaseIncarnationId,
    inspectDatabaseForClassification,
    listDatabaseFamilyArtifacts,
    MC_APPLICATION_ID,
    readDirectFormatMarker,
} from "./storage-format-epoch";
import { computeExpectedDirectFormat, createDirectTestDatabase } from "./test-database";

const EXPECTED = computeExpectedDirectFormat();

function pristineInspection(
    overrides: Partial<FormatFamilyInspection> = {},
): FormatFamilyInspection {
    return {
        mainFileExists: true,
        applicationId: 0,
        userVersion: 0,
        schemaObjectNames: [],
        marker: { status: "absent" },
        artifacts: [],
        ...overrides,
    };
}

describe("cross-runtime direct-format vocabulary", () => {
    it("matches the shared fixture consumed by the Rust runtimes", () => {
        expect(MC_APPLICATION_ID).toBe(vocabulary.applicationId);
        expect(DIRECT_FORMAT_EPOCH).toBe(vocabulary.formatEpoch);
        expect(DIRECT_FORMAT_MARKER_TABLE).toBe(vocabulary.markerTable);
        expect(FORMAT_MARKER_DIGEST_PROTOCOL).toBe(vocabulary.markerDigestProtocol);
        expect(SCHEMA_MANIFEST_PROTOCOL).toBe(vocabulary.manifestProtocol);
    });

    it("builds exactly the fixture's component manifest and digest", () => {
        const manifest = buildSchemaComponentManifest(CURRENT_SCHEMA_COMPONENTS);
        expect(manifest).toEqual(vocabulary.componentManifest as typeof manifest);
        expect(computeSchemaManifestDigest(manifest)).toBe(vocabulary.goldens.manifestDigest);
    });

    it("reproduces the golden marker digest", () => {
        const golden = vocabulary.goldens.marker;
        expect(
            computeMarkerDigest({
                formatEpoch: golden.formatEpoch,
                databaseIncarnationId: golden.databaseIncarnationId,
                componentManifestDigest: golden.componentManifestDigest,
                createdAtMs: golden.createdAtMs,
            }),
        ).toBe(golden.markerDigest);
    });
});

describe("pure format-family classification", () => {
    it("recognizes a current direct-format database", () => {
        const { db } = createDirectTestDatabase();
        try {
            const classification = classifyDatabaseFormatFamily(
                inspectDatabaseForClassification(db),
                EXPECTED,
            );
            expect(classification).toEqual({ family: "current", reasons: [] });
        } finally {
            db.close();
        }
    });

    it("recognizes a pristine family", () => {
        expect(classifyDatabaseFormatFamily(pristineInspection(), EXPECTED).family).toBe(
            "pristine",
        );
        expect(
            classifyDatabaseFormatFamily(pristineInspection({ mainFileExists: false }), EXPECTED)
                .family,
        ).toBe("pristine");
    });

    it("refuses an unsupported legacy-migration database", () => {
        const inspection = pristineInspection({
            schemaObjectNames: ["schema_migrations", "memories", "tags"],
        });
        const classification = classifyDatabaseFormatFamily(inspection, EXPECTED);
        expect(classification.family).toBe("unsupported");
        expect(classification.reasons).toContain("direct-format marker is absent");
        expect(classification.reasons).toContain("unregistered schema object: memories");
    });

    it("refuses a malformed marker before any other verdict", () => {
        const { db } = createDirectTestDatabase();
        try {
            const inspection = inspectDatabaseForClassification(db);
            const tampered: FormatFamilyInspection = {
                ...inspection,
                marker: { status: "malformed", reason: "marker digest mismatch" },
            };
            expect(classifyDatabaseFormatFamily(tampered, EXPECTED)).toEqual({
                family: "malformed-marker",
                reasons: ["marker digest mismatch"],
            });
        } finally {
            db.close();
        }
    });

    it("detects a tampered marker row through the stored digest", () => {
        const { db } = createDirectTestDatabase();
        try {
            // pi-lens-ignore: sql-injection
            db.exec(`DROP TRIGGER ${DIRECT_FORMAT_MARKER_TABLE}_no_update`);
            db.prepare(`UPDATE ${DIRECT_FORMAT_MARKER_TABLE} SET database_incarnation_id = ?`).run(
                generateDatabaseIncarnationId(),
            );
            const read = readDirectFormatMarker(db);
            expect(read).toEqual({ status: "malformed", reason: "marker digest mismatch" });
        } finally {
            db.close();
        }
    });

    it("refuses orphan sidecar and journal artifacts without a main database", () => {
        const orphan = classifyDatabaseFormatFamily(
            pristineInspection({ mainFileExists: false, artifacts: ["wal", "journal"] }),
            EXPECTED,
        );
        expect(orphan.family).toBe("orphan-artifacts");
        expect(orphan.reasons).toHaveLength(2);
    });

    it("refuses a current database with a pending reset marker", () => {
        const { db } = createDirectTestDatabase();
        try {
            const inspection = inspectDatabaseForClassification(db);
            const withReset: FormatFamilyInspection = {
                ...inspection,
                artifacts: ["reset-marker"],
            };
            const classification = classifyDatabaseFormatFamily(withReset, EXPECTED);
            expect(classification.family).toBe("unsupported");
            expect(classification.reasons).toEqual([
                "a pending reset marker exists for this database family",
            ]);
        } finally {
            db.close();
        }
    });

    it("lists on-disk family artifacts including the reset marker", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-format-artifacts-"));
        try {
            const dbPath = join(dir, "context.db");
            writeFileSync(`${dbPath}-wal`, "");
            writeFileSync(`${dbPath}${DATABASE_RESET_MARKER_SUFFIX}`, "");
            expect(listDatabaseFamilyArtifacts(dbPath)).toEqual(["wal", "reset-marker"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("database incarnation identity", () => {
    it("generates random 128-bit lowercase hex identities", () => {
        const first = generateDatabaseIncarnationId();
        const second = generateDatabaseIncarnationId();
        expect(first).toMatch(/^[0-9a-f]{32}$/);
        expect(second).toMatch(/^[0-9a-f]{32}$/);
        expect(first).not.toBe(second);
    });

    it("binds the incarnation into the marker digest", () => {
        const base = {
            formatEpoch: DIRECT_FORMAT_EPOCH,
            componentManifestDigest: "a".repeat(64),
            createdAtMs: 1_000,
        };
        const one = computeMarkerDigest({ ...base, databaseIncarnationId: "0".repeat(32) });
        const two = computeMarkerDigest({ ...base, databaseIncarnationId: "1".repeat(32) });
        expect(one).not.toBe(two);
    });

    it("is immutable at the database boundary and stable across reopen", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-incarnation-"));
        try {
            const dbPath = join(dir, "context.db");
            const { db, marker } = createDirectTestDatabase({ path: dbPath });
            expect(() =>
                db
                    .prepare(`UPDATE ${DIRECT_FORMAT_MARKER_TABLE} SET database_incarnation_id = ?`)
                    .run(generateDatabaseIncarnationId()),
            ).toThrow(/immutable/);
            // pi-lens-ignore: sql-injection
            expect(() => db.exec(`DELETE FROM ${DIRECT_FORMAT_MARKER_TABLE}`)).toThrow(/immutable/);
            db.close();

            const reopened = new Database(dbPath);
            try {
                const read = readDirectFormatMarker(reopened);
                expect(read.status).toBe("present");
                if (read.status === "present") {
                    expect(read.marker).toEqual(marker);
                }
                const classification = classifyDatabaseFormatFamily(
                    inspectDatabaseForClassification(reopened, dbPath),
                    EXPECTED,
                );
                expect(classification.family).toBe("current");
            } finally {
                reopened.close();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("registered-component composition", () => {
    const componentStub = (
        name: string,
        dependsOn: string[],
        provides: string[],
    ): RegisteredSchemaComponent => ({
        name,
        dependsOn,
        provides,
        create: (db) => {
            // pi-lens-ignore: sql-injection
            for (const table of provides) db.exec(`CREATE TABLE ${table} (id INTEGER)`);
        },
    });

    it("rejects duplicate object ownership", () => {
        const problems = validateSchemaComponents([
            componentStub("a", [], ["shared"]),
            componentStub("b", [], ["shared"]),
        ]);
        expect(problems).toEqual([
            "duplicate object ownership: table 'shared' is declared by 'a' and 'b'",
        ]);
    });

    it("rejects dependency cycles", () => {
        const problems = validateSchemaComponents([
            componentStub("a", ["b"], ["ta"]),
            componentStub("b", ["a"], ["tb"]),
        ]);
        expect(problems.some((problem) => problem.startsWith("dependency cycle:"))).toBe(true);
    });

    it("rejects unknown dependencies", () => {
        const problems = validateSchemaComponents([componentStub("a", ["ghost"], ["ta"])]);
        expect(problems).toEqual([
            "unknown dependency: 'a' depends on undeclared component 'ghost'",
        ]);
    });

    it("fails closed on an undeclared schema object", () => {
        const sneaky: RegisteredSchemaComponent = {
            name: "sneaky",
            dependsOn: [],
            provides: ["declared"],
            create: (db) => {
                db.exec("CREATE TABLE declared (id INTEGER)");
                db.exec("CREATE TABLE undeclared (id INTEGER)");
            },
        };
        const db = new Database(":memory:");
        try {
            expect(() => composeRegisteredSchema(db, [sneaky])).toThrow(
                /undeclared schema objects after composition: table undeclared/,
            );
        } finally {
            db.close();
        }
    });

    it("accepts the registered current components", () => {
        expect(validateSchemaComponents(CURRENT_SCHEMA_COMPONENTS)).toEqual([]);
    });

    it("encodes the manifest canonically for the cross-runtime digest", () => {
        const manifest = buildSchemaComponentManifest(CURRENT_SCHEMA_COMPONENTS);
        const lines = canonicalSchemaManifestLines(manifest);
        expect(lines[0]).toBe(SCHEMA_MANIFEST_PROTOCOL);
        expect(lines[1]).toStartWith(
            "component name=claims-evidence dependsOn= provides=projects,",
        );
    });
});

describe("direct test-database factory", () => {
    it("creates the registered schema without the legacy migration chain", () => {
        const { db } = createDirectTestDatabase();
        try {
            const legacyTables = db
                .prepare(
                    "SELECT name FROM main.sqlite_schema WHERE name IN ('schema_migrations', 'memories', 'tags')",
                )
                .all();
            expect(legacyTables).toEqual([]);
            const marker = readDirectFormatMarker(db);
            expect(marker.status).toBe("present");
        } finally {
            db.close();
        }
    });

    it("supports the deterministic incarnation override", () => {
        const incarnation = "f".repeat(32);
        const { db, marker } = createDirectTestDatabase({
            databaseIncarnationId: incarnation,
            nowMs: 42,
        });
        try {
            expect(marker.databaseIncarnationId).toBe(incarnation);
            expect(marker.createdAtMs).toBe(42);
            expect(marker.markerDigest).toBe(computeMarkerDigest(marker));
        } finally {
            db.close();
        }
    });

    it("uses a distinct incarnation per database", () => {
        const first = createDirectTestDatabase();
        const second = createDirectTestDatabase();
        try {
            expect(first.marker.databaseIncarnationId).not.toBe(
                second.marker.databaseIncarnationId,
            );
        } finally {
            first.db.close();
            second.db.close();
        }
    });

    it("builds markers only from valid incarnation identities", () => {
        expect(() =>
            buildDirectFormatMarker({
                componentManifestDigest: "a".repeat(64),
                createdAtMs: 1,
                databaseIncarnationId: "not-hex",
            }),
        ).toThrow(/invalid database incarnation ID/);
    });
});
