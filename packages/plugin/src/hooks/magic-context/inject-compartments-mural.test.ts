/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { setProjectMemoryClaimLifecycle } from "../../features/magic-context/memory/storage-claim-operations";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta-session";
import { seedProjectMemoryClaim } from "../../features/magic-context/test-claim-database";
import { createDirectTestDatabase } from "../../features/magic-context/test-database";
import type { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { injectM0M1, type M0M1State } from "./inject-compartments";
import type { MessageLike } from "./tag-messages";

const SESSION_ID = "ses_mural_inject";
const PROJECT_ID = "git:mural-project";

function makeDb(): Database {
    const db = createDirectTestDatabase().db;
    getOrCreateSessionMeta(db, SESSION_ID);
    return db;
}

// A 1x1 transparent PNG data URL, standing in for a rendered mural.
const FAKE_MURAL_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function muralOption(dataUrl = FAKE_MURAL_DATA_URL, contentHash = "mural-hash-1") {
    return {
        enabled: true,
        supportsVision: true,
        dataUrl,
        contentHash,
    };
}

function imageUrl(messages: MessageLike[]): string | undefined {
    return (
        messages[0]?.parts.find((part) => (part as { type?: string }).type === "file") as
            | { url?: string }
            | undefined
    )?.url;
}

/** Concatenated text of the prepended synthetic m[0] head message. */
function headText(messages: MessageLike[]): string {
    return (
        messages[0]?.parts
            .filter((part) => (part as { type?: string }).type === "text")
            .map((part) => (part as { text?: string }).text ?? "")
            .join("\n") ?? ""
    );
}

function replaceCurrentManifest(db: Database, content = "current mural"): string {
    const image = Buffer.from(content, "utf8");
    db.prepare(
        `INSERT OR REPLACE INTO mural_manifest
            (project_path, image, content_hash, rendered_at, memory_ids_json, width, height)
         VALUES (?, ?, ?, ?, '[]', 1, 1)`,
    ).run(PROJECT_ID, image, "current-manifest-hash", Date.now());
    return `data:image/png;base64,${image.toString("base64")}`;
}

describe("m[0] mural image fold (on-demand render → wire)", () => {
    it("folds the <memory-mural> block and image part when a mural is supplied, and replays it on defer", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;

            const hardMessages: MessageLike[] = [];
            const first = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: hardMessages,
                state,
                projectPath: undefined,
                isCacheBustingPass: true,
                mural: muralOption(),
            });
            expect(first.injected).toBe(true);
            // m[0] carries the mural marker block.
            expect(first.m0Bytes?.toString("utf8")).toContain("<memory-mural>");
            // The prepended synthetic head message carries an image file part.
            const head = hardMessages[0];
            const imagePart = head?.parts.find(
                (part) => (part as { type?: string }).type === "file",
            ) as { type: string; mime?: string; url?: string } | undefined;
            expect(imagePart).toBeDefined();
            expect(imagePart?.mime).toBe("image/png");
            expect(imagePart?.url).toBe(FAKE_MURAL_DATA_URL);

            // A defer pass (no mural option supplied) must replay the SAME baked-in
            // data URL from state, not drop the image — the "swaps only on a HARD
            // fold" rule.
            const deferMessages: MessageLike[] = [];
            const second = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: deferMessages,
                state,
                projectPath: undefined,
                isCacheBustingPass: false,
            });
            expect(second.m0Bytes).toEqual(first.m0Bytes);
            const deferImage = deferMessages[0]?.parts.find(
                (part) => (part as { type?: string }).type === "file",
            ) as { url?: string } | undefined;
            expect(deferImage?.url).toBe(FAKE_MURAL_DATA_URL);
        } finally {
            closeQuietly(db);
        }
    });

    it("folds once when mural is disabled, removes the image, then defers byte-identically", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            const firstMessages: MessageLike[] = [];
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: firstMessages,
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: true,
                muralEnabled: true,
                mural: muralOption(),
                memoryInjectionBudgetTokens: 8_000,
                historyBudgetTokens: 60_000,
            });
            expect(imageUrl(firstMessages)).toBe(FAKE_MURAL_DATA_URL);

            const disabledMessages: MessageLike[] = [];
            const disabled = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: disabledMessages,
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: false,
                muralEnabled: false,
                memoryInjectionBudgetTokens: 8_000,
                historyBudgetTokens: 60_000,
            });
            expect(disabled.decision).toEqual({ value: true, reason: "render_config" });
            expect(disabled.m0RematerializedThisPass).toBe(true);
            expect(imageUrl(disabledMessages)).toBeUndefined();
            expect(disabled.m0Bytes?.toString("utf8")).not.toContain("<memory-mural>");

            const deferMessages: MessageLike[] = [];
            const defer = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: deferMessages,
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: false,
                muralEnabled: false,
                memoryInjectionBudgetTokens: 8_000,
                historyBudgetTokens: 60_000,
            });
            expect(defer.m0RematerializedThisPass).toBe(false);
            expect(defer.m0Bytes).toEqual(disabled.m0Bytes);
            expect(imageUrl(deferMessages)).toBeUndefined();
        } finally {
            closeQuietly(db);
        }
    });

    it("folds once when memory or history render budgets change", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: [],
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: true,
                muralEnabled: false,
                memoryInjectionBudgetTokens: 1_000,
                historyBudgetTokens: 2_000,
            });
            const changed = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: [],
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: false,
                muralEnabled: false,
                memoryInjectionBudgetTokens: 1_001,
                historyBudgetTokens: 2_000,
            });
            expect(changed.decision).toEqual({ value: true, reason: "render_config" });
            expect(changed.m0RematerializedThisPass).toBe(true);

            const unchanged = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: [],
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: false,
                muralEnabled: false,
                memoryInjectionBudgetTokens: 1_001,
                historyBudgetTokens: 2_000,
            });
            expect(unchanged.m0RematerializedThisPass).toBe(false);
            expect(unchanged.m0Bytes).toEqual(changed.m0Bytes);
        } finally {
            closeQuietly(db);
        }
    });

    it("replays the persisted frozen image after restart instead of the current project manifest", () => {
        const db = makeDb();
        try {
            const hardState = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            const hardMessages: MessageLike[] = [];
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: hardMessages,
                state: hardState,
                projectPath: PROJECT_ID,
                isCacheBustingPass: true,
                mural: muralOption(),
            });

            const currentManifestUrl = replaceCurrentManifest(db);
            const restartedState = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            expect(restartedState.cachedM0MuralDataUrl).toBe(FAKE_MURAL_DATA_URL);
            expect(restartedState.cachedM0MuralHash).toBe("mural-hash-1");

            const deferMessages: MessageLike[] = [];
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: deferMessages,
                state: restartedState,
                projectPath: PROJECT_ID,
                isCacheBustingPass: false,
            });
            expect(imageUrl(deferMessages)).toBe(FAKE_MURAL_DATA_URL);
            expect(imageUrl(deferMessages)).not.toBe(currentManifestUrl);
            expect(deferMessages[0]?.parts[0]).toEqual(hardMessages[0]?.parts[0]);
        } finally {
            closeQuietly(db);
        }
    });

    it("hydrates a sibling cached-row mural payload during adoption", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: [],
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: true,
                mural: muralOption(),
            });

            const siblingDataUrl = "data:image/png;base64,c2libGluZy1tdXJhbA==";
            db.prepare(
                `UPDATE session_meta
                    SET cached_m0_mural_data_url = ?, cached_m0_mural_hash = ?,
                        cached_m0_materialized_at = cached_m0_materialized_at + 1
                  WHERE session_id = ?`,
            ).run(siblingDataUrl, "sibling-hash", SESSION_ID);

            const messages: MessageLike[] = [];
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages,
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: true,
            });
            expect(imageUrl(messages)).toBe(siblingDataUrl);
            expect(state.cachedM0MuralDataUrl).toBe(siblingDataUrl);
            expect(state.cachedM0MuralHash).toBe("sibling-hash");
        } finally {
            closeQuietly(db);
        }
    });

    it("falls back to internally consistent text-only m0 when a legacy row lacks the payload", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: [],
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: true,
                mural: muralOption(),
            });
            const currentManifestUrl = replaceCurrentManifest(db);
            db.prepare(
                `UPDATE session_meta
                    SET cached_m0_mural_data_url = NULL, cached_m0_mural_hash = NULL
                  WHERE session_id = ?`,
            ).run(SESSION_ID);

            const restartedState = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            const messages: MessageLike[] = [];
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages,
                state: restartedState,
                projectPath: PROJECT_ID,
                isCacheBustingPass: false,
            });
            expect(imageUrl(messages)).toBeUndefined();
            expect(imageUrl(messages)).not.toBe(currentManifestUrl);
            expect((messages[0]?.parts[0] as { text?: string })?.text).not.toContain(
                "<memory-mural>",
            );
        } finally {
            closeQuietly(db);
        }
    });

    it("publishes no mural image and no marker when the claim snapshot went stale", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            const claim = seedProjectMemoryClaim(db, {
                projectIdentity: PROJECT_ID,
                content: "Claim whose cue the mural draws.",
                category: "ARCHITECTURE",
            });

            // Fold with a mural so both the marker and the image payload are cached
            // against this claim snapshot.
            const foldMessages: MessageLike[] = [];
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: foldMessages,
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: true,
                mural: muralOption(),
                memoryInjectionBudgetTokens: 8_000,
                historyBudgetTokens: 60_000,
            });
            expect(imageUrl(foldMessages)).toBe(FAKE_MURAL_DATA_URL);
            expect(headText(foldMessages)).toContain("<memory-mural>");
            expect(headText(foldMessages)).toContain("<project-memory>");

            // Withdraw the claim after the mural was cached, so the next pass must fold.
            setProjectMemoryClaimLifecycle(
                db,
                { producer: "test", operationKey: "mural-stale-archive" },
                { token: claim.token, state: "archived", actor: "user:test" },
            );

            // A sibling writer keeps landing claims, so every materialize attempt loses
            // the staleness check and the pass falls back to replaying the cached m[0]
            // — which still carries the mural marker and the cached image payload.
            let concurrentClaims = 0;
            const staleMessages: MessageLike[] = [];
            const stale = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: staleMessages,
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: true,
                mural: muralOption(),
                memoryInjectionBudgetTokens: 8_000,
                historyBudgetTokens: 60_000,
                beforePhase3ForTest: () => {
                    concurrentClaims += 1;
                    seedProjectMemoryClaim(db, {
                        projectIdentity: PROJECT_ID,
                        content: `Concurrent claim ${concurrentClaims}.`,
                        category: "ARCHITECTURE",
                    });
                },
            });
            expect(stale.materializationContentionRetryExhausted).toBe(true);

            // The publication fence withholds the claim text, so every other
            // claim-derived representation must obey it too: no image part, no
            // marker promising one, and no cached payload left to replay.
            const staleText = headText(staleMessages);
            expect(staleText).not.toContain("<project-memory>");
            expect(staleText).not.toContain("<memory-mural>");
            expect(imageUrl(staleMessages)).toBeUndefined();
            expect(state.cachedM0MuralDataUrl ?? null).toBeNull();
            expect(state.cachedM0MuralHash ?? null).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    it("omits the mural block entirely when no mural is supplied and the feature is off", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            const messages: MessageLike[] = [];
            const result = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages,
                state,
                projectPath: undefined,
                isCacheBustingPass: true,
                // muralEnabled defaults undefined → no image path.
            });
            expect(result.m0Bytes?.toString("utf8")).not.toContain("<memory-mural>");
            const imagePart = messages[0]?.parts.find(
                (part) => (part as { type?: string }).type === "file",
            );
            expect(imagePart).toBeUndefined();
        } finally {
            closeQuietly(db);
        }
    });
});
