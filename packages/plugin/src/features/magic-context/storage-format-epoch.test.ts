/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    appendFileSync,
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
    Database,
    MIN_SUPPORTED_BUN_VERSION,
    MIN_SUPPORTED_NODE_VERSION,
    MIN_SUPPORTED_SQLITE_VERSION,
} from "../../shared/sqlite";
import vocabulary from "./fixtures/direct-format-vocabulary-v1.json";
import { DIRECT_FORMAT_FENCE_MIGRATION_VERSION } from "./migrations";
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
    buildDatabaseResetMarker,
    buildDirectFormatMarker,
    canonicalResetMarkerLines,
    captureDatabaseFamilyIdentities,
    classifyDatabaseFormatFamily,
    computeMarkerDigest,
    computeResetMarkerDigest,
    DATABASE_FAMILY_MOVE_ORDER,
    DATABASE_RESET_MARKER_SUFFIX,
    DIRECT_FORMAT_EPOCH,
    DIRECT_FORMAT_MARKER_TABLE,
    databaseFamilyFilePath,
    databaseResetMarkerPath,
    FORMAT_MARKER_DIGEST_PROTOCOL,
    type FormatFamilyInspection,
    generateDatabaseIncarnationId,
    inspectDatabaseForClassification,
    listDatabaseFamilyArtifacts,
    MC_APPLICATION_ID,
    type ResetMarkerPublicationFs,
    readDatabaseResetMarker,
    readDirectFormatMarker,
    verifyResetMarkerFamily,
    writeDatabaseResetMarker,
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
        expect(MIN_SUPPORTED_SQLITE_VERSION).toBe(vocabulary.minSqliteVersion);
        expect(MIN_SUPPORTED_NODE_VERSION).toBe(vocabulary.minNodeVersion);
        expect(MIN_SUPPORTED_BUN_VERSION).toBe(vocabulary.minBunVersion);
    });

    it("builds exactly the fixture's component manifest and digest", () => {
        const manifest = buildSchemaComponentManifest(CURRENT_SCHEMA_COMPONENTS);
        expect(manifest).toEqual(vocabulary.componentManifest as typeof manifest);
        expect(computeSchemaManifestDigest(manifest)).toBe(vocabulary.goldens.manifestDigest);
    });

    // The Rust verifier uses `goldens.schemaObjectNames` because `provides` omits indexes, triggers, and views from the manifest digest.
    it("pins the golden schema-object inventory the Rust verifier consumes", () => {
        expect(vocabulary.goldens.schemaObjectNames).toEqual([...EXPECTED.schemaObjectNames]);
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

    it("refuses the prior direct format after the anti-memory component changes identity", () => {
        const { db } = createDirectTestDatabase();
        try {
            const current = inspectDatabaseForClassification(db);
            if (current.marker.status !== "present") throw new Error("missing current marker");
            const antiMemoryObjects = new Set([
                "claim_anti_memory_payloads_append_only_delete",
                "claim_anti_memory_payloads_append_only_insert_collision",
                "claim_anti_memory_payloads_append_only_update",
                "claim_anti_memory_payloads_category_guard",
                "claim_anti_memory_revision_payloads",
            ]);
            const { markerDigest: _currentDigest, ...currentMarker } = current.marker.marker;
            const priorMarker = {
                ...currentMarker,
                componentManifestDigest:
                    "7006b7e53e06ae463b46963c125a7b6629238d19c90b37e6c81db133b1be7767",
            };
            const prior: FormatFamilyInspection = {
                ...current,
                schemaObjectNames: current.schemaObjectNames.filter(
                    (name) => !antiMemoryObjects.has(name),
                ),
                marker: {
                    status: "present",
                    marker: {
                        ...priorMarker,
                        markerDigest: computeMarkerDigest(priorMarker),
                    },
                },
            };

            const classification = classifyDatabaseFormatFamily(prior, EXPECTED);
            expect(classification.family).toBe("unsupported");
            expect(classification.reasons).toContain(
                "marker component manifest digest does not match this build's manifest",
            );
            expect(classification.reasons).toContain(
                "missing registered schema object: claim_anti_memory_revision_payloads",
            );
        } finally {
            db.close();
        }
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

describe("reset marker and interrupted quarantine", () => {
    it("serializes a private marker canonically and rejects digest tampering", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-reset-marker-"));
        try {
            const dbPath = join(dir, "context.db");
            writeFileSync(dbPath, "database");
            const marker = buildDatabaseResetMarker({
                dbPath,
                createdAtMs: 123,
                databaseIncarnationId: "a".repeat(32),
                quarantineDirPath: `${dbPath}.mc-quarantine-test`,
                fileIdentities: captureDatabaseFamilyIdentities(dbPath),
            });
            expect(marker.markerDigest).toBe(computeResetMarkerDigest(marker));
            expect(canonicalResetMarkerLines(marker)).toEqual([
                "mc-database-reset-marker-v1",
                `db_path=${dbPath}`,
                "created_at_ms=123",
                `database_incarnation_id=${"a".repeat(32)}`,
                `quarantine_dir=${dbPath}.mc-quarantine-test`,
                `file role=main dev=${statSync(dbPath).dev} ino=${statSync(dbPath).ino} size_bytes=8`,
            ]);

            writeDatabaseResetMarker(marker);
            expect(readDatabaseResetMarker(dbPath)).toEqual({ status: "present", marker });
            if (process.platform !== "win32") {
                expect(statSync(databaseResetMarkerPath(dbPath)).mode & 0o777).toBe(0o600);
            }

            const tampered = JSON.parse(
                readFileSync(databaseResetMarkerPath(dbPath), "utf8"),
            ) as Record<string, unknown>;
            tampered.createdAtMs = 124;
            writeFileSync(databaseResetMarkerPath(dbPath), JSON.stringify(tampered));
            expect(readDatabaseResetMarker(dbPath)).toEqual({
                status: "malformed",
                reason: "reset marker digest mismatch",
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("captures every family identity in sidecar-first move order", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-reset-identities-"));
        try {
            const dbPath = join(dir, "context.db");
            for (const role of DATABASE_FAMILY_MOVE_ORDER) {
                writeFileSync(databaseFamilyFilePath(dbPath, role), role);
            }
            const identities = captureDatabaseFamilyIdentities(dbPath);
            expect(identities.map((identity) => identity.role)).toEqual([
                ...DATABASE_FAMILY_MOVE_ORDER,
            ]);
            for (const identity of identities) {
                const stats = statSync(databaseFamilyFilePath(dbPath, identity.role));
                expect(identity).toMatchObject({ dev: stats.dev, ino: stats.ino });
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("classifies interrupted moves by identity and rejects a replaced destination", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-reset-interrupted-"));
        try {
            const dbPath = join(dir, "context.db");
            for (const role of DATABASE_FAMILY_MOVE_ORDER) {
                writeFileSync(databaseFamilyFilePath(dbPath, role), role);
            }
            const quarantineDirPath = `${dbPath}.mc-quarantine-test`;
            const marker = buildDatabaseResetMarker({
                dbPath,
                createdAtMs: 1,
                databaseIncarnationId: null,
                quarantineDirPath,
                fileIdentities: captureDatabaseFamilyIdentities(dbPath),
            });
            mkdirSync(quarantineDirPath);
            for (const role of ["rollback-journal", "wal"] as const) {
                const source = databaseFamilyFilePath(dbPath, role);
                renameSync(source, join(quarantineDirPath, basename(source)));
            }

            const interrupted = verifyResetMarkerFamily(marker);
            expect(interrupted.problems).toEqual([]);
            expect(interrupted.anyMoved).toBe(true);
            expect(interrupted.files).toEqual([
                { role: "rollback-journal", status: "moved" },
                { role: "wal", status: "moved" },
                { role: "shm", status: "at-source" },
                { role: "main", status: "at-source" },
            ]);

            const walDestination = join(quarantineDirPath, "context.db-wal");
            // Deleting first can recycle the just-freed inode and classify the replacement as a clean move.
            // Renaming the staged sibling into place preserves its distinct inode.
            const replacement = `${walDestination}.replacement`;
            writeFileSync(replacement, "replacement");
            expect(statSync(replacement).ino).not.toBe(statSync(walDestination).ino);
            renameSync(replacement, walDestination);
            const replaced = verifyResetMarkerFamily(marker);
            expect(replaced.files).toContainEqual({ role: "wal", status: "mismatch" });
            expect(replaced.problems.join("\n")).toContain("changed identity");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("keeps a same-identity family file whose size drifted from the record", () => {
        // Size is not an identity input: a holder can change a family file's size after recording while its dev/inode remain fixed.
        const dir = mkdtempSync(join(tmpdir(), "mc-reset-size-drift-"));
        try {
            const dbPath = join(dir, "context.db");
            for (const role of DATABASE_FAMILY_MOVE_ORDER) {
                writeFileSync(databaseFamilyFilePath(dbPath, role), role);
            }
            const quarantineDirPath = `${dbPath}.mc-quarantine-test`;
            const marker = buildDatabaseResetMarker({
                dbPath,
                createdAtMs: 2,
                databaseIncarnationId: null,
                quarantineDirPath,
                fileIdentities: captureDatabaseFamilyIdentities(dbPath),
            });
            mkdirSync(quarantineDirPath);
            const walSource = databaseFamilyFilePath(dbPath, "wal");
            const walDestination = join(quarantineDirPath, basename(walSource));
            renameSync(walSource, walDestination);

            // Growing either file or truncating the source preserves dev/inode identity.
            appendFileSync(databaseFamilyFilePath(dbPath, "main"), " appended by a live holder");
            appendFileSync(walDestination, " appended through a pre-rename descriptor");
            writeFileSync(databaseFamilyFilePath(dbPath, "shm"), "");
            for (const role of ["main", "wal", "shm"] as const) {
                const recorded = marker.fileIdentities.find((file) => file.role === role);
                const path = role === "wal" ? walDestination : databaseFamilyFilePath(dbPath, role);
                const current = statSync(path);
                expect(current.size).not.toBe(recorded?.sizeBytes);
                expect({ dev: current.dev, ino: current.ino }).toEqual({
                    dev: recorded?.dev,
                    ino: recorded?.ino,
                });
            }

            const verification = verifyResetMarkerFamily(marker);
            expect(verification.problems).toEqual([]);
            expect(verification.inspectionComplete).toBe(true);
            expect(verification.files).toEqual([
                { role: "rollback-journal", status: "at-source" },
                { role: "wal", status: "moved" },
                { role: "shm", status: "at-source" },
                { role: "main", status: "at-source" },
            ]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("treats a reset marker without a main database as an orphan artifact", () => {
        expect(
            classifyDatabaseFormatFamily(
                pristineInspection({ mainFileExists: false, artifacts: ["reset-marker"] }),
                EXPECTED,
            ),
        ).toEqual({
            family: "orphan-artifacts",
            reasons: ["orphan reset-marker artifact without a current main database"],
        });
    });

    describe("marker publication is all-or-nothing", () => {
        const realPublicationFs: ResetMarkerPublicationFs = {
            openSync,
            writeSync,
            fsyncSync,
            closeSync,
            chmodSync,
            unlinkSync,
        };

        function failWith(code: string, call: string): never {
            throw Object.assign(new Error(`injected ${code} on ${call}`), { code });
        }

        /* */
        function cappedWrite(limit: number): ResetMarkerPublicationFs["writeSync"] {
            return ((fd: number, buffer: Buffer, offset: number, _length: number) =>
                writeSync(
                    fd,
                    buffer,
                    offset,
                    Math.min(limit, buffer.length - offset),
                )) as ResetMarkerPublicationFs["writeSync"];
        }

        function seedCurrentFamily(dir: string): { dbPath: string; incarnation: string } {
            const dbPath = join(dir, "context.db");
            const seeded = createDirectTestDatabase({ path: dbPath });
            seeded.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
            seeded.db.close();
            return { dbPath, incarnation: seeded.marker.databaseIncarnationId };
        }

        function markerFor(dbPath: string) {
            return buildDatabaseResetMarker({
                dbPath,
                createdAtMs: 7,
                databaseIncarnationId: null,
                quarantineDirPath: `${dbPath}.mc-quarantine-test`,
                fileIdentities: captureDatabaseFamilyIdentities(dbPath),
            });
        }

        /**
         * The bootstrap refusal in `storage-db` keys on the `reset-marker` artifact; a leftover marker satisfies that predicate.
         */
        function familyOpensAsCurrent(dbPath: string, incarnation: string): void {
            expect(listDatabaseFamilyArtifacts(dbPath)).not.toContain("reset-marker");
            expect(readDatabaseResetMarker(dbPath)).toEqual({ status: "absent" });
            const db = new Database(dbPath, { readonly: true });
            try {
                expect(readDirectFormatMarker(db)).toMatchObject({
                    status: "present",
                    marker: { databaseIncarnationId: incarnation },
                });
                expect(
                    classifyDatabaseFormatFamily(
                        inspectDatabaseForClassification(db, dbPath),
                        EXPECTED,
                    ),
                ).toEqual({ family: "current", reasons: [] });
            } finally {
                db.close();
            }
        }

        it("removes the file it created when publication fails, leaving the database openable", () => {
            const failures: Array<[string, Partial<ResetMarkerPublicationFs>, RegExp]> = [
                // Cleanup prevents the fsynced prefix from being read as a malformed marker.
                [
                    "short write then fsync failure",
                    {
                        writeSync: cappedWrite(40),
                        fsyncSync: () => failWith("EIO", "fsync"),
                    },
                    /injected EIO on fsync/,
                ],
                ["fsync failure", { fsyncSync: () => failWith("EIO", "fsync") }, /EIO on fsync/],
                [
                    "chmod failure",
                    { chmodSync: () => failWith("EPERM", "chmod") },
                    /EPERM on chmod/,
                ],
                // A write that stops making progress must fail without retrying or leaving the written prefix.
                [
                    "write that stops making progress",
                    { writeSync: (() => 0) as ResetMarkerPublicationFs["writeSync"] },
                    /made no progress after 0 of \d+ bytes/,
                ],
            ];

            for (const [label, overrides, expectedError] of failures) {
                const dir = mkdtempSync(join(tmpdir(), "mc-reset-publish-fail-"));
                try {
                    const { dbPath, incarnation } = seedCurrentFamily(dir);
                    expect(() =>
                        writeDatabaseResetMarker(markerFor(dbPath), {
                            ...realPublicationFs,
                            ...overrides,
                        }),
                    ).toThrow(expectedError);
                    expect({
                        label,
                        markerLeftBehind: existsSync(databaseResetMarkerPath(dbPath)),
                    }).toEqual({ label, markerLeftBehind: false });
                    familyOpensAsCurrent(dbPath, incarnation);
                } finally {
                    rmSync(dir, { recursive: true, force: true });
                }
            }
        });

        it("blocks the database once publication actually succeeds", () => {
            // A published reset marker causes bootstrap to refuse its database family.
            // A published reset marker causes bootstrap to refuse its database family.
            const dir = mkdtempSync(join(tmpdir(), "mc-reset-publish-ok-"));
            try {
                const { dbPath } = seedCurrentFamily(dir);
                // Short writes that keep making progress still publish in full.
                writeDatabaseResetMarker(markerFor(dbPath), {
                    ...realPublicationFs,
                    writeSync: cappedWrite(7),
                });
                expect(readDatabaseResetMarker(dbPath)).toEqual({
                    status: "present",
                    marker: markerFor(dbPath),
                });
                expect(listDatabaseFamilyArtifacts(dbPath)).toContain("reset-marker");
                const db = new Database(dbPath, { readonly: true });
                try {
                    expect(
                        classifyDatabaseFormatFamily(
                            inspectDatabaseForClassification(db, dbPath),
                            EXPECTED,
                        ),
                    ).toEqual({
                        family: "unsupported",
                        reasons: ["a pending reset marker exists for this database family"],
                    });
                } finally {
                    db.close();
                }
                if (process.platform !== "win32") {
                    expect(statSync(databaseResetMarkerPath(dbPath)).mode & 0o777).toBe(0o600);
                }
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it("never touches a marker this call did not create", () => {
            const dir = mkdtempSync(join(tmpdir(), "mc-reset-publish-excl-"));
            try {
                const { dbPath } = seedCurrentFamily(dir);
                const path = databaseResetMarkerPath(dbPath);
                // An existing marker prevents exclusive creation without cleanup.
                writeFileSync(path, "another reset's marker\n", { mode: 0o600 });
                expect(() =>
                    writeDatabaseResetMarker(markerFor(dbPath), {
                        ...realPublicationFs,
                        unlinkSync: () => failWith("EACCES", "unlink"),
                    }),
                ).toThrow(/EEXIST/);
                expect(readFileSync(path, "utf8")).toBe("another reset's marker\n");
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it("reports the leftover path when cleanup itself fails, without losing the cause", () => {
            const dir = mkdtempSync(join(tmpdir(), "mc-reset-publish-stuck-"));
            try {
                const { dbPath } = seedCurrentFamily(dir);
                let thrown: unknown = null;
                try {
                    writeDatabaseResetMarker(markerFor(dbPath), {
                        ...realPublicationFs,
                        writeSync: cappedWrite(40),
                        fsyncSync: () => failWith("EIO", "fsync"),
                        unlinkSync: () => failWith("EACCES", "unlink"),
                    });
                } catch (error) {
                    thrown = error;
                }
                expect(thrown).toBeInstanceOf(Error);
                const message = (thrown as Error).message;
                expect(message).toContain("injected EIO on fsync");
                expect(message).toContain(databaseResetMarkerPath(dbPath));
                expect(message).toContain("injected EACCES on unlink");
                expect(message).toContain("remove it manually");
                expect((thrown as Error).cause).toMatchObject({ code: "EIO" });
                expect(existsSync(databaseResetMarkerPath(dbPath))).toBe(true);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
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
                    "SELECT name FROM main.sqlite_schema WHERE name IN ('memories', 'memories_fts', 'memory_embeddings', 'memory_stats', 'memory_verifications', 'memory_mutation_log', 'legacy_memory_claims', 'claim_change_outbox', 'claim_compatibility_write_state')",
                )
                .all();
            expect(legacyTables).toEqual([]);
            const sessionRuntimeTables = db
                .prepare(
                    "SELECT name FROM main.sqlite_schema WHERE name IN ('tags', 'session_meta', 'compartments') ORDER BY name",
                )
                .all() as Array<{ name: string }>;
            expect(sessionRuntimeTables.map((row) => row.name)).toEqual([
                "compartments",
                "session_meta",
                "tags",
            ]);
            const fenceRows = db
                .prepare("SELECT version FROM schema_migrations ORDER BY version")
                .all() as Array<{ version: number }>;
            expect(fenceRows).toEqual([{ version: DIRECT_FORMAT_FENCE_MIGRATION_VERSION }]);
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
