import { describe, expect, test } from "bun:test";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import type { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    _resetCompartmentChunkSearchCacheForTests,
    buildCanonicalChunkTextFromFts,
    CHUNK_WINDOW_SAFETY_RATIO,
    type CompartmentChunkWindow,
    canonicalizeInMemoryChunkTextForEmbedding,
    chunkCanonicalText,
    chunkEmbeddingWindowsAreCurrent,
    loadCompartmentChunkEmbeddingsForSearch,
    replaceCompartmentChunkEmbeddings,
} from "./compartment-chunk-embedding";
import { embedAndStoreCompartmentChunks } from "./compartment-embedding";
import { appendCompartments, getCompartments } from "./compartment-storage";
import type { EmbeddingProvider, EmbeddingPurpose } from "./memory/embedding-provider";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    contentSha256,
    embedCompartmentWindowsDetailedForProject,
    getProjectEmbeddingSnapshot,
    registerProjectEmbedding,
} from "./project-embedding-registry";
import { clearSession } from "./storage-meta-session";
import {
    DetailedSynapseTestHost,
    detailedSynapseTestProvider,
    synapseTestConfig,
} from "./synapse-detailed-test-support";
import { createDirectTestDatabase } from "./test-database";

function referenceRecursiveSplit(text: string, chunkSize: number): string[] {
    const lengthFunction = estimateTokens;
    const separators = ["\n\n", "\n", " ", ""];

    const splitOnSeparator = (input: string, separator: string): string[] => {
        const splits = separator ? input.split(separator) : input.split("");
        return splits.filter((s) => s !== "");
    };

    const mergeSplits = (splits: string[], separator: string): string[] => {
        const docs: string[] = [];
        const currentDoc: string[] = [];
        let total = 0;
        const joinDocs = (docsToJoin: string[]): string | null => {
            const joined = docsToJoin.join(separator).trim();
            return joined === "" ? null : joined;
        };
        for (const d of splits) {
            const len = lengthFunction(d);
            if (total + len + currentDoc.length * separator.length > chunkSize) {
                if (currentDoc.length > 0) {
                    const doc = joinDocs(currentDoc);
                    if (doc !== null) docs.push(doc);
                    while (total > 0 && currentDoc.length > 0) {
                        total -= lengthFunction(currentDoc[0]);
                        currentDoc.shift();
                    }
                }
            }
            currentDoc.push(d);
            total += len;
        }
        const doc = joinDocs(currentDoc);
        if (doc !== null) docs.push(doc);
        return docs;
    };

    const splitTextRecursive = (input: string, seps: string[]): string[] => {
        const finalChunks: string[] = [];
        let separator = seps[seps.length - 1];
        let newSeparators: string[] | undefined;
        for (let i = 0; i < seps.length; i += 1) {
            const s = seps[i];
            if (s === "") {
                separator = s;
                break;
            }
            if (input.includes(s)) {
                separator = s;
                newSeparators = seps.slice(i + 1);
                break;
            }
        }
        const splits = splitOnSeparator(input, separator);
        let goodSplits: string[] = [];
        for (const s of splits) {
            if (lengthFunction(s) < chunkSize) {
                goodSplits.push(s);
            } else {
                if (goodSplits.length) {
                    finalChunks.push(...mergeSplits(goodSplits, separator));
                    goodSplits = [];
                }
                if (!newSeparators) {
                    finalChunks.push(s);
                } else {
                    finalChunks.push(...splitTextRecursive(s, newSeparators));
                }
            }
        }
        if (goodSplits.length) {
            finalChunks.push(...mergeSplits(goodSplits, separator));
        }
        return finalChunks;
    };

    if (text.length === 0) return [];
    return splitTextRecursive(text, separators);
}

class CapturingEmbeddingProvider implements EmbeddingProvider {
    readonly modelId = "mock:model";
    readonly maxInputTokens = 10_000;
    readonly texts: string[];

    constructor(texts: string[]) {
        this.texts = texts;
    }

    async initialize(): Promise<boolean> {
        return true;
    }

    async embed(
        text: string,
        _signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<Float32Array> {
        this.texts.push(text);
        return new Float32Array([1, 0]);
    }

    async embedBatch(
        texts: string[],
        _signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<Float32Array[]> {
        this.texts.push(...texts);
        return texts.map(() => new Float32Array([1, 0]));
    }

    async dispose(): Promise<void> {}

    isLoaded(): boolean {
        return true;
    }
}

function createDb(): Database {
    const db = createDirectTestDatabase().db;
    return db;
}

function insertFtsRow(
    db: Database,
    sessionId: string,
    ordinal: number,
    role: "user" | "assistant",
    content: string,
): void {
    db.prepare(
        "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
    ).run(sessionId, ordinal, `${role}-${ordinal}`, role, content);
}

function currentChunkModelId(projectIdentity: string): string {
    return getProjectEmbeddingSnapshot(projectIdentity)?.chunkModelId ?? "off";
}

describe("compartment chunk embedding core", () => {
    test("FTS reconstruction and in-memory stripping produce the same canonical bytes", () => {
        const db = createDb();
        try {
            insertFtsRow(db, "ses-canon", 1, "user", "How should semantic search work?");
            insertFtsRow(db, "ses-canon", 2, "user", "Keep adjacent user lines grouped.");
            insertFtsRow(db, "ses-canon", 3, "assistant", "Embed raw compartment chunks.");

            const fromFts = buildCanonicalChunkTextFromFts(db, "ses-canon", 1, 4);
            const fromMemory = canonicalizeInMemoryChunkTextForEmbedding(
                [
                    "[1-2] U: How should semantic search work? / Keep adjacent user lines grouped.",
                    "[3-4] A: Embed raw compartment chunks. / TC: read(packages/plugin/src/features/magic-context/search.ts)",
                ].join("\n"),
                1,
                4,
            );

            expect(fromFts).toBe(fromMemory);
            expect(fromFts).toBe(
                "[1-2] U: How should semantic search work? / Keep adjacent user lines grouped.\n[3] A: Embed raw compartment chunks.",
            );

            const clippedFromFts = buildCanonicalChunkTextFromFts(db, "ses-canon", 2, 3);
            const clippedFromMemory = canonicalizeInMemoryChunkTextForEmbedding(
                [
                    "[1-2] U: How should semantic search work? / Keep adjacent user lines grouped.",
                    "[3-4] A: Embed raw compartment chunks. / TC: read(packages/plugin/src/features/magic-context/search.ts)",
                ].join("\n"),
                2,
                3,
            );
            expect(clippedFromMemory).toBe(clippedFromFts);
            expect(clippedFromFts).toBe(
                "[2] U: Keep adjacent user lines grouped.\n[3] A: Embed raw compartment chunks.",
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("chunker uses one whole-compartment row when it fits and windows on line boundaries otherwise", () => {
        const text = [
            "[1] U: alpha beta gamma",
            "[2] A: delta epsilon zeta",
            "[3] U: eta theta iota",
        ].join("\n");

        const whole = chunkCanonicalText(text, 1, 3, 10_000);
        expect(whole).toHaveLength(1);
        expect(whole[0]).toMatchObject({ windowIndex: 0, startOrdinal: 1, endOrdinal: 3 });
        expect(whole[0]?.text).toBe(text);

        // The safety-margined budget fits one canonical line but not two, so chunking emits one line per window.
        const perLineBudget = Math.ceil(
            (estimateTokens("[1] U: alpha beta gamma") + 1) / CHUNK_WINDOW_SAFETY_RATIO,
        );
        const windowed = chunkCanonicalText(text, 1, 3, perLineBudget);
        expect(windowed.map((window) => window.windowIndex)).toEqual([1, 2, 3]);
        expect(windowed.map((window) => [window.startOrdinal, window.endOrdinal])).toEqual([
            [1, 1],
            [2, 2],
            [3, 3],
        ]);
    });

    test("every window stays under the safety-margined budget (never exceeds the provider ceiling)", () => {
        // Short lines ensure the token budget, rather than line count, determines windowing.
        const maxInputTokens = 200;
        const effective = Math.floor(maxInputTokens * CHUNK_WINDOW_SAFETY_RATIO);
        const lines = Array.from(
            { length: 60 },
            (_, i) => `[${i + 1}] U: lorem ipsum dolor sit amet consectetur adipiscing elit ${i}`,
        );
        const windows = chunkCanonicalText(lines.join("\n"), 1, 60, maxInputTokens);
        expect(windows.length).toBeGreaterThan(1);
        for (const window of windows) {
            // configured ceiling.
            expect(estimateTokens(window.text)).toBeLessThanOrEqual(effective);
        }
    });

    test("every window stays under the provider byte ceiling", () => {
        const maxInputBytes = 1_024;
        const text = `[1] U: ${"a".repeat(maxInputBytes * 3)}`;

        const windows = chunkCanonicalText(text, 1, 1, 1_048_576, maxInputBytes);

        expect(windows.length).toBeGreaterThan(1);
        for (const window of windows) {
            expect(Buffer.byteLength(window.text, "utf8")).toBeLessThanOrEqual(maxInputBytes);
        }
    });

    test("splits a single oversized canonical line so no window exceeds the budget (#206)", () => {
        // A single canonical line can exceed the token budget and must be split.
        const maxInputTokens = 200;
        const effective = Math.floor(maxInputTokens * CHUNK_WINDOW_SAFETY_RATIO);
        const huge = Array.from(
            { length: 4000 },
            (_, i) => `word${i} alpha beta gamma delta epsilon`,
        ).join(" ");
        const line = `[1] A: ${huge}`;
        expect(estimateTokens(line)).toBeGreaterThan(effective * 10); // genuinely oversized

        const windows = chunkCanonicalText(line, 1, 1, maxInputTokens);

        expect(windows.length).toBeGreaterThan(1);
        for (const window of windows) {
            expect(estimateTokens(window.text)).toBeLessThanOrEqual(effective);
        }
        // Sub-windows all carry the owning line's ordinal range.
        for (const window of windows) {
            expect(window.startOrdinal).toBe(1);
            expect(window.endOrdinal).toBe(1);
        }
        expect(windows.map((w) => w.windowIndex)).toEqual(windows.map((_, i) => i + 1));
    });

    test("one-megabyte single-line fixture yields the same slices and window metadata as the frozen pre-change splitter", () => {
        const maxInputTokens = 512;
        const effective = Math.floor(maxInputTokens * CHUNK_WINDOW_SAFETY_RATIO);
        const huge = Array.from({ length: 180_000 }, (_, i) => `w${String(i % 9973)}`).join(" ");
        const line = `[7] A: ${huge}`;
        expect(line.length).toBeGreaterThan(1_000_000);

        const windows = chunkCanonicalText(line, 7, 7, maxInputTokens);
        const referenceSlices = referenceRecursiveSplit(line, effective);

        expect(windows.map((w) => w.text)).toEqual(referenceSlices);
        expect(windows.map((w) => w.windowIndex)).toEqual(windows.map((_, i) => i + 1));
        for (const window of windows) {
            expect(window.startOrdinal).toBe(7);
            expect(window.endOrdinal).toBe(7);
            expect(estimateTokens(window.text)).toBeLessThanOrEqual(effective);
        }
    });

    test("mixes split sub-windows with normal line windows without index gaps", () => {
        const maxInputTokens = 200;
        const effective = Math.floor(maxInputTokens * CHUNK_WINDOW_SAFETY_RATIO);
        const huge = Array.from({ length: 2000 }, (_, i) => `tok${i}`).join(" ");
        const text = ["[1] U: short opener", `[2] A: ${huge}`, "[3] U: short closer"].join("\n");

        const windows = chunkCanonicalText(text, 1, 3, maxInputTokens);

        expect(windows.length).toBeGreaterThan(2);
        for (const window of windows) {
            expect(estimateTokens(window.text)).toBeLessThanOrEqual(effective);
        }
        expect(windows.map((w) => w.windowIndex)).toEqual(windows.map((_, i) => i + 1));
    });

    test("storage replaces chunks idempotently and clearSession removes rows", () => {
        const db = createDb();
        try {
            appendCompartments(db, "ses-store", [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 2,
                    startMessageId: "u1",
                    endMessageId: "a2",
                    title: "Chunk storage",
                    content: "P1 content",
                    p1: "P1 content",
                },
            ]);
            const compartment = getCompartments(db, "ses-store")[0];
            expect(compartment).toBeDefined();
            const windows = chunkCanonicalText("[1] U: hello\n[2] A: world", 1, 2, 10_000);
            replaceCompartmentChunkEmbeddings(
                db,
                windows.map((window) => ({
                    compartmentId: compartment.id,
                    sessionId: "ses-store",
                    projectPath: "/repo/store",
                    window,
                    modelId: "mock:model",
                    vector: new Float32Array([1, 0]),
                })),
            );

            expect(chunkEmbeddingWindowsAreCurrent(db, compartment.id, "mock:model", windows)).toBe(
                true,
            );
            expect(
                loadCompartmentChunkEmbeddingsForSearch(
                    db,
                    "ses-store",
                    "/repo/store",
                    "mock:model",
                ),
            ).toHaveLength(1);

            clearSession(db, "ses-store");
            expect(
                loadCompartmentChunkEmbeddingsForSearch(
                    db,
                    "ses-store",
                    "/repo/store",
                    "mock:model",
                ),
            ).toHaveLength(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("reuses decoded search vectors until the pool probe changes", () => {
        const db = createDb();
        try {
            appendCompartments(db, "ses-cache", [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 2,
                    startMessageId: "u1",
                    endMessageId: "a2",
                    title: "Cached chunks",
                    content: "P1 content",
                    p1: "P1 content",
                },
            ]);
            const compartment = getCompartments(db, "ses-cache")[0];
            const [window] = chunkCanonicalText("[1] U: hello\n[2] A: world", 1, 2, 10_000);
            const writeVector = (vector: Float32Array) =>
                replaceCompartmentChunkEmbeddings(db, [
                    {
                        compartmentId: compartment.id,
                        sessionId: "ses-cache",
                        projectPath: "/repo/cache",
                        window,
                        modelId: "mock:model",
                        vector,
                    },
                ]);

            writeVector(new Float32Array([1, 0]));
            const first = loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-cache",
                "/repo/cache",
                "mock:model",
            );
            const cached = loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-cache",
                "/repo/cache",
                "mock:model",
            );
            expect(cached).toBe(first);

            writeVector(new Float32Array([0, 1]));
            const replaced = loadCompartmentChunkEmbeddingsForSearch(
                db,
                "ses-cache",
                "/repo/cache",
                "mock:model",
            );
            expect(replaced).not.toBe(first);
            expect([...replaced[0].vector]).toEqual([0, 1]);
        } finally {
            _resetCompartmentChunkSearchCacheForTests();
            closeQuietly(db);
        }
    });

    test("publish helper embeds chunks with TC lines stripped", async () => {
        const db = createDb();
        const embeddedTexts: string[] = [];
        try {
            _setTestProviderFactoryForProject(() => new CapturingEmbeddingProvider(embeddedTexts));
            registerProjectEmbedding(
                db,
                "/repo/publish",
                { provider: "local", model: "mock-local" },
                { memoryEnabled: true, gitCommitEnabled: false },
                "/repo/publish",
            );
            appendCompartments(db, "ses-publish", [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 2,
                    startMessageId: "u1",
                    endMessageId: "a2",
                    title: "Publish chunks",
                    content: "P1 content",
                    p1: "P1 content",
                },
            ]);
            const compartment = getCompartments(db, "ses-publish")[0];

            await embedAndStoreCompartmentChunks(db, "ses-publish", "/repo/publish", [
                {
                    id: compartment.id,
                    startMessage: 1,
                    endMessage: 2,
                    sourceChunkText: "[1] U: Keep this line\n[2] A: TC: bash(Run tests)",
                },
            ]);

            expect(embeddedTexts).toEqual(["[1] U: Keep this line"]);
            expect(
                loadCompartmentChunkEmbeddingsForSearch(
                    db,
                    "ses-publish",
                    "/repo/publish",
                    currentChunkModelId("/repo/publish"),
                ),
            ).toHaveLength(1);
        } finally {
            _resetProjectEmbeddingRegistryForTests();
            closeQuietly(db);
        }
    });

    test("empty raw span falls back to embedding the compartment summary (title + p1)", async () => {
        const db = createDb();
        const embeddedTexts: string[] = [];
        try {
            _setTestProviderFactoryForProject(() => new CapturingEmbeddingProvider(embeddedTexts));
            registerProjectEmbedding(
                db,
                "/repo/fallback",
                { provider: "local", model: "mock-local" },
                { memoryEnabled: true, gitCommitEnabled: false },
                "/repo/fallback",
            );
            appendCompartments(db, "ses-fallback", [
                {
                    sequence: 0,
                    startMessage: 5,
                    endMessage: 6,
                    startMessageId: "u5",
                    endMessageId: "a6",
                    title: "Executed background oracle audit for oxc engine",
                    content: "Ran the background oracle audit to verify the oxc cutover.",
                    p1: "Ran the background oracle audit to verify the oxc cutover.",
                },
            ]);
            const compartment = getCompartments(db, "ses-fallback")[0];

            await embedAndStoreCompartmentChunks(db, "ses-fallback", "/repo/fallback", [
                {
                    id: compartment.id,
                    startMessage: 5,
                    endMessage: 6,
                    sourceChunkText: "[5] A: TC: task(Audit oxc engine)",
                },
            ]);

            expect(embeddedTexts).toEqual([
                "Executed background oracle audit for oxc engine\nRan the background oracle audit to verify the oxc cutover.",
            ]);
            expect(
                loadCompartmentChunkEmbeddingsForSearch(
                    db,
                    "ses-fallback",
                    "/repo/fallback",
                    currentChunkModelId("/repo/fallback"),
                ),
            ).toHaveLength(1);
        } finally {
            _resetProjectEmbeddingRegistryForTests();
            closeQuietly(db);
        }
    });
});

describe("all-window replacement through versioned synapse receipts", () => {
    function seedCompartment(db: Database, sessionId: string): number {
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 5,
                startMessageId: "u1",
                endMessageId: "a5",
                title: "Receipt span",
                content: "P1 content",
                p1: "P1 content",
            },
        ]);
        return getCompartments(db, sessionId)[0].id;
    }

    function testWindows(count: number): CompartmentChunkWindow[] {
        return Array.from({ length: count }, (_, index) => {
            const text = `window text ${index + 1}`;
            return {
                windowIndex: index + 1,
                startOrdinal: index + 1,
                endOrdinal: index + 1,
                text,
                chunkHash: contentSha256(text),
            };
        });
    }

    function chunkRowCount(db: Database, compartmentId: number, modelId: string): number {
        return (
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM compartment_chunk_embeddings WHERE compartment_id = ? AND model_id = ?",
                )
                .get(compartmentId, modelId) as { count: number }
        ).count;
    }

    function ledgerRows(db: Database): Array<{ application_group: string; state: string }> {
        return db
            .prepare("SELECT application_group, state FROM synapse_batch_ledger ORDER BY id")
            .all() as Array<{ application_group: string; state: string }>;
    }

    function registerDetailedChunkProject(
        db: Database,
        projectIdentity: string,
        host: DetailedSynapseTestHost,
    ): string {
        _setTestProviderFactoryForProject((config) =>
            config.provider === "synapse" ? detailedSynapseTestProvider(host) : null,
        );
        registerProjectEmbedding(
            db,
            projectIdentity,
            synapseTestConfig(),
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/chunk-detailed",
        );
        return getProjectEmbeddingSnapshot(projectIdentity)?.chunkModelId ?? "off";
    }

    test("a compartment spanning three provider pages replaces all windows and completes all receipts once", async () => {
        const db = createDb();
        try {
            const host = new DetailedSynapseTestHost();
            const chunkModelId = registerDetailedChunkProject(db, "git:chunk-span", host);
            const compartmentId = seedCompartment(db, "ses-span");
            const windows = testWindows(5);

            const applied = await embedCompartmentWindowsDetailedForProject(db, "git:chunk-span", {
                compartmentId,
                sessionId: "ses-span",
                windows,
                currentWindows: () => windows,
            });

            expect(applied).toBe(true);
            expect(chunkRowCount(db, compartmentId, chunkModelId)).toBe(5);
            const rows = ledgerRows(db);
            expect(rows).toHaveLength(3);
            expect(
                rows.every((row) => row.application_group === `compartment:${compartmentId}`),
            ).toBe(true);
            expect(rows.every((row) => row.state === "complete")).toBe(true);
        } finally {
            _resetProjectEmbeddingRegistryForTests();
            _resetCompartmentChunkSearchCacheForTests();
            closeQuietly(db);
        }
    });

    test("one missing window preserves prior rows and leaves every receipt non-complete", async () => {
        const db = createDb();
        try {
            const host = new DetailedSynapseTestHost();
            const chunkModelId = registerDetailedChunkProject(db, "git:chunk-miss", host);
            const compartmentId = seedCompartment(db, "ses-miss");
            const windows = testWindows(5);

            const priorWindow = testWindows(1)[0];
            replaceCompartmentChunkEmbeddings(db, [
                {
                    compartmentId,
                    sessionId: "ses-miss",
                    projectPath: "git:chunk-miss",
                    window: { ...priorWindow, text: "prior text", chunkHash: "prior-hash" },
                    modelId: chunkModelId,
                    vector: new Float32Array([9, 9, 9]),
                },
            ]);
            expect(chunkRowCount(db, compartmentId, chunkModelId)).toBe(1);

            host.resultPages = (jobId, items) => {
                if (jobId === "job-2") {
                    const error = new Error("malformed page") as Error & { code: string };
                    error.code = "schema_violation";
                    return error;
                }
                return {
                    result: {
                        ...host.envelope(),
                        done: true,
                        vectors: items.map((item) => ({
                            id: item.id,
                            content_sha256: item.content_sha256,
                            vector: [1, 2, 3],
                        })),
                    },
                };
            };

            const applied = await embedCompartmentWindowsDetailedForProject(db, "git:chunk-miss", {
                compartmentId,
                sessionId: "ses-miss",
                windows,
                currentWindows: () => windows,
            });

            expect(applied).toBe(false);
            expect(chunkRowCount(db, compartmentId, chunkModelId)).toBe(1);
            const prior = db
                .prepare(
                    "SELECT chunk_hash AS chunkHash FROM compartment_chunk_embeddings WHERE compartment_id = ?",
                )
                .get(compartmentId) as { chunkHash: string };
            expect(prior.chunkHash).toBe("prior-hash");
            const rows = ledgerRows(db);
            expect(rows.length).toBeGreaterThan(0);
            expect(rows.every((row) => row.state !== "complete")).toBe(true);
        } finally {
            _resetProjectEmbeddingRegistryForTests();
            _resetCompartmentChunkSearchCacheForTests();
            closeQuietly(db);
        }
    });
});
