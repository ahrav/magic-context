import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import * as searchModule from "../../features/magic-context/search";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { extractBoundedAutoSearchQuery } from "./auto-search-prompt";
import { _resetAutoSearchCache, runAutoSearchHint } from "./auto-search-runner";
import type { MessageLike } from "./transform-operations";

function makeUserMsg(id: string, text: string): MessageLike {
    return {
        info: { id, role: "user" },
        parts: [{ type: "text", text }],
    } as unknown as MessageLike;
}

function findUserPromptText(msg: MessageLike): string {
    let out = "";
    for (const part of msg.parts) {
        const p = part as { type?: string; text?: string };
        if (p.type === "text" && typeof p.text === "string") {
            out += (out ? "\n" : "") + p.text;
        }
    }
    return out;
}

describe("auto-search-runner", () => {
    let db: Database;
    const baseOptions = {
        enabled: true,
        scoreThreshold: 0.6,
        minPromptChars: 20,
        projectPath: "git:test",
        memoryEnabled: true,
        embeddingEnabled: true,
        gitCommitsEnabled: true,
    };

    beforeEach(() => {
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        _resetAutoSearchCache();
    });

    afterEach(() => {
        _resetAutoSearchCache();
        closeQuietly(db);
    });

    test("caches no-hint decision on empty results so defer passes don't re-search", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(async () => []);
        try {
            const messages: MessageLike[] = [
                makeUserMsg("u1", "please explain how the historian decides when to run"),
            ];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });
            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });
            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            // Three passes on the same user message id → exactly one search call.
            expect(spy).toHaveBeenCalledTimes(1);
        } finally {
            spy.mockRestore();
        }
    });

    test("excludes Primers from transform-time auto-search hints", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(async () => []);
        try {
            const messages: MessageLike[] = [
                makeUserMsg(
                    "u1",
                    "please explain how durable project primer questions are maintained",
                ),
            ];

            await runAutoSearchHint({
                sessionId: "s-primer-neutral",
                db,
                messages,
                options: baseOptions,
            });

            const options = spy.mock.calls[0]?.[4];
            expect(options?.sources).toEqual(["memory", "message", "git_commit"]);
        } finally {
            spy.mockRestore();
        }
    });

    test("caches no-hint decision on below-threshold score", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            async () =>
                [{ source: "memory", score: 0.4, id: 1, text: "x" }] as unknown as Awaited<
                    ReturnType<typeof searchModule.unifiedSearch>
                >,
        );
        try {
            const messages: MessageLike[] = [
                makeUserMsg("u1", "please explain how the historian decides when to run"),
            ];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });
            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            expect(spy).toHaveBeenCalledTimes(1);
            expect(findUserPromptText(messages[0])).not.toContain("<ctx-search-hint>");
        } finally {
            spy.mockRestore();
        }
    });

    test("timeout path: returns without hanging transform and does NOT inject a hint", async () => {
        // Hanging search: never resolves.
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            () => new Promise(() => {}) as unknown as ReturnType<typeof searchModule.unifiedSearch>,
        );
        try {
            const messages: MessageLike[] = [
                makeUserMsg("u1", "a long enough prompt to pass the minPromptChars gate"),
            ];

            const started = Date.now();
            const runPromise = runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });
            const outerCap = new Promise<"cap">((resolve) =>
                setTimeout(() => resolve("cap"), 5_000),
            );
            const winner = await Promise.race([runPromise.then(() => "done" as const), outerCap]);
            const elapsed = Date.now() - started;

            expect(winner).toBe("done");
            // Must complete within the 3s AUTO_SEARCH_TIMEOUT_MS + some slack.
            expect(elapsed).toBeLessThan(4_000);
            // Timeout must not inject a hint into the user message.
            expect(findUserPromptText(messages[0])).not.toContain("<ctx-search-hint>");

            // Timeout is RETRYABLE: it does NOT persist a permanent no-hint
            // decision, so a later pass (with the user message still at the tail)
            // re-attempts the search rather than being suppressed forever. The
            // live-tail gate (user message must be the last element) is what bounds
            // re-search to new-turn passes, not a cached no-hint decision.
            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });
            expect(spy).toHaveBeenCalledTimes(2);
            expect(findUserPromptText(messages[0])).not.toContain("<ctx-search-hint>");
        } finally {
            spy.mockRestore();
        }
    }, 10_000);

    test("strips magic-context tag prefix, temporal markers, and system-reminder content before search", async () => {
        let capturedPrompt = "";
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            async (_db, _s, _p, prompt) => {
                capturedPrompt = prompt;
                return [];
            },
        );
        try {
            // Note: <system-reminder> content is DROPPED entirely (depth-aware
            // parser — content is plugin/host noise, never user data).
            // Generic paired tags like <instruction> have their MARKUP stripped
            // but their TEXT CONTENT preserved (see the generic-XML test below)
            // because pasted user content in arbitrary tags can carry signal.
            const rawText = [
                "§12345§ <!-- +5m -->",
                "<system-reminder>CONTEXT REMINDER — 42%</system-reminder>",
                "this is the actual user prompt text that should be embedded",
            ].join("\n");
            const messages: MessageLike[] = [makeUserMsg("u1", rawText)];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            expect(capturedPrompt).toBe(
                "this is the actual user prompt text that should be embedded",
            );
            // Plugin-internal markers are gone.
            expect(capturedPrompt).not.toContain("§");
            expect(capturedPrompt).not.toContain("<!--");
            // system-reminder block and its content are gone.
            expect(capturedPrompt).not.toContain("<system-reminder>");
            expect(capturedPrompt).not.toContain("CONTEXT REMINDER");
        } finally {
            spy.mockRestore();
        }
    });

    /**
     * Regression for the nested-system-reminder leak observed in production.
     *
     * Live LMStudio embedding logs showed the orphan tail
     * `Please address this message and continue with your tasks.\n</system-reminder>`
     * arriving as the embedded query. Root cause: the previous non-greedy regex
     * matched from the OUTER open tag to the FIRST close tag (which was the
     * INNER one), leaving the outer close tag and the text between the inner
     * close and outer close as the "user prompt".
     *
     * The depth-aware parser must drop ALL nested system-reminder content,
     * keeping only text outside every level.
     */
    test("strips nested system-reminders without leaking the outer reminder's tail or close tag", async () => {
        let capturedPrompt = "";
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            async (_db, _s, _p, prompt) => {
                capturedPrompt = prompt;
                return [];
            },
        );
        try {
            // Mirrors the real-world structure: outer reminder wrapping an
            // inner reminder whose content is a background-task notification,
            // followed by the outer reminder's "Please address..." tail.
            const rawText = [
                "actual user typed text before the noise",
                "<system-reminder>",
                "The user sent the following message:",
                "<system-reminder>",
                "[BACKGROUND TASK COMPLETED]",
                "**ID:** `bg_xyz`",
                "</system-reminder>",
                "",
                "Please address this message and continue with your tasks.",
                "</system-reminder>",
                "more user text after",
            ].join("\n");
            const messages: MessageLike[] = [makeUserMsg("u-nested", rawText)];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            // Both the inner reminder content AND the outer-reminder tail
            // ("Please address this message...") must be dropped. Only text
            // outside every reminder level survives.
            expect(capturedPrompt).not.toContain("Please address this message");
            expect(capturedPrompt).not.toContain("BACKGROUND TASK");
            expect(capturedPrompt).not.toContain("</system-reminder>");
            expect(capturedPrompt).not.toContain("<system-reminder>");
            expect(capturedPrompt).toContain("actual user typed text before the noise");
            expect(capturedPrompt).toContain("more user text after");
        } finally {
            spy.mockRestore();
        }
    });

    test("strips orphan system-reminder close tag (malformed input) without leaving it in the prompt", async () => {
        let capturedPrompt = "";
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            async (_db, _s, _p, prompt) => {
                capturedPrompt = prompt;
                return [];
            },
        );
        try {
            // Malformed input: close tag with no matching open tag. The
            // depth-aware parser must drop it silently rather than leaving
            // it as embedded text.
            const rawText =
                "real user prompt</system-reminder> with a leftover close tag from a truncated parent";
            const messages: MessageLike[] = [makeUserMsg("u-orphan", rawText)];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            expect(capturedPrompt).not.toContain("</system-reminder>");
            expect(capturedPrompt).toContain("real user prompt");
            expect(capturedPrompt).toContain("leftover close tag from a truncated parent");
        } finally {
            spy.mockRestore();
        }
    });

    test("truncates an oversized prompt to the shared query caps before search (AE2)", async () => {
        let capturedPrompt = "";
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            async (_db, _s, _p, prompt) => {
                capturedPrompt = prompt;
                return [];
            },
        );
        try {
            const rawText = `<system-reminder>noise</system-reminder> question about caps ${"context ".repeat(30_000)}`;
            const messages: MessageLike[] = [makeUserMsg("u-oversized", rawText)];

            await runAutoSearchHint({ sessionId: "s1", db, messages, options: baseOptions });

            expect(capturedPrompt).toContain("question about caps");
            expect(Buffer.byteLength(capturedPrompt, "utf8")).toBeLessThanOrEqual(16 * 1024);
            expect(capturedPrompt.split(/\s+/).length).toBeLessThanOrEqual(64);
            expect(capturedPrompt).toBe(
                extractBoundedAutoSearchQuery(findUserPromptText(messages[0])),
            );
        } finally {
            spy.mockRestore();
        }
    });

    test("strips arbitrary XML/HTML tags and HTML comments (generic, not allowlisted) before embedding", async () => {
        let capturedPrompt = "";
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            async (_db, _s, _p, prompt) => {
                capturedPrompt = prompt;
                return [];
            },
        );
        try {
            // Mix of plugin-known tags (instruction, ctx-search-hint),
            // plugin-unknown tags (custom-tag, deferred_notes), pasted code
            // markup (Component, props), comments with non-temporal content,
            // and self-closing tags. The generic stripper must remove all
            // tags while preserving any text between paired tags as data the
            // user typed.
            const rawText = [
                "<!-- arbitrary comment with note -->",
                '<instruction name="deferred_notes">You have 7 deferred notes.</instruction>',
                "<custom-tag>data the user wants embedded</custom-tag>",
                "real user question about <Component props={x} /> usage",
                "<some-future-marker/>",
                "after the markup",
            ].join("\n");
            const messages: MessageLike[] = [makeUserMsg("u-generic", rawText)];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            // All markup is gone…
            expect(capturedPrompt).not.toContain("<");
            expect(capturedPrompt).not.toContain(">");
            expect(capturedPrompt).not.toContain("<!--");
            expect(capturedPrompt).not.toContain("arbitrary comment");
            expect(capturedPrompt).not.toContain("deferred_notes");

            // Plugin-owned blocks and their content are excluded from
            // embeddings.
            expect(capturedPrompt).not.toContain("You have 7 deferred notes");

            // Preserve text between non-plugin paired tags because pasted
            // code and quoted logs can contain embedding-relevant text.
            expect(capturedPrompt).toContain("data the user wants embedded");
            expect(capturedPrompt).toContain("real user question about");
            expect(capturedPrompt).toContain("usage");
            expect(capturedPrompt).toContain("after the markup");
        } finally {
            spy.mockRestore();
        }
    });

    test("strips week-format temporal markers (+Xw / +Xw Yd) before embedding", async () => {
        let capturedPrompt = "";
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            async (_db, _s, _p, prompt) => {
                capturedPrompt = prompt;
                return [];
            },
        );
        try {
            const rawText = [
                "<!-- +1w -->",
                "<!-- +2w 3d -->",
                "what are the plans for historian v3 this quarter",
            ].join("\n");
            const messages: MessageLike[] = [makeUserMsg("u1", rawText)];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            expect(capturedPrompt).toBe("what are the plans for historian v3 this quarter");
            expect(capturedPrompt).not.toContain("+1w");
            expect(capturedPrompt).not.toContain("+2w");
            expect(capturedPrompt).not.toContain("<!--");
        } finally {
            spy.mockRestore();
        }
    });

    test("skips suppressed context (existing augmentation) without running search", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(async () => []);
        try {
            const messages: MessageLike[] = [
                makeUserMsg(
                    "u1",
                    [
                        "help me implement feature X in the plugin",
                        "",
                        "<sidekick-augmentation>",
                        "relevant memories: transform pipeline",
                        "</sidekick-augmentation>",
                    ].join("\n"),
                ),
            ];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            // Existing augmentation block present → suppressed → no search call.
            // This is the regression for the dead isSuppressedContext bug: the
            // check used to run on post-stripped text (where the tag is already
            // gone) and would never suppress. Now it runs on raw parts.
            expect(spy).toHaveBeenCalledTimes(0);

            // Second pass on same message still doesn't search — skip is cached.
            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });
            expect(spy).toHaveBeenCalledTimes(0);
        } finally {
            spy.mockRestore();
        }
    });

    test("timeout triggers AbortSignal so underlying search can cancel in-flight work", async () => {
        let capturedSignal: AbortSignal | undefined;
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            (_db, _s, _p, _prompt, options) => {
                capturedSignal = (options as { signal?: AbortSignal } | undefined)?.signal;
                // Hang forever — simulates a stuck embedding fetch.
                return new Promise(() => {}) as unknown as ReturnType<
                    typeof searchModule.unifiedSearch
                >;
            },
        );
        try {
            const messages: MessageLike[] = [
                makeUserMsg("u1", "a long enough prompt to pass the minPromptChars gate"),
            ];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            expect(capturedSignal).toBeDefined();
            // After the 3s timeout fires, the controller is aborted.
            expect(capturedSignal?.aborted).toBe(true);
        } finally {
            spy.mockRestore();
        }
    }, 10_000);

    test("caches skip when prompt is shorter than minPromptChars", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(async () => []);
        try {
            const messages: MessageLike[] = [makeUserMsg("u1", "short")];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });
            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            // Never calls search for too-short prompts, and caches the skip.
            expect(spy).toHaveBeenCalledTimes(0);
        } finally {
            spy.mockRestore();
        }
    });

    test("skips ignored plugin-internal messages — does not embed announcements/warnings", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(async () => []);
        try {
            // Mimic the startup announcement (or any sendIgnoredMessage payload) —
            // text part with `ignored: true`. These are persisted as ordinary
            // user-role messages but must NEVER reach the embedding endpoint.
            const announcement = {
                info: { id: "u_announcement", role: "user" },
                parts: [
                    {
                        type: "text",
                        text: "✨ Magic Context — what's new in v0.21.7:\n\n  • Pi parity sweep: 44 audit findings fixed, …",
                        ignored: true,
                    },
                ],
            } as unknown as MessageLike;
            const messages: MessageLike[] = [announcement];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            // No meaningful user message → no search call → no embedding hit.
            expect(spy).toHaveBeenCalledTimes(0);
        } finally {
            spy.mockRestore();
        }
    });

    test("ignored part next to a real user message: real prompt embedded, ignored text excluded", async () => {
        let capturedQuery: string | undefined;
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            async (_db, _sessionId, _projectPath, query) => {
                capturedQuery = query as string;
                return [];
            },
        );
        try {
            // Realistic shape: an OpenCode user message can carry MULTIPLE parts.
            // If an upstream extension ever attaches an ignored notification part
            // alongside the real prompt, the embedded query must contain only the
            // real prompt — the ignored part must be excluded from `collectUserPromptParts`.
            const mixed = {
                info: { id: "u_mixed", role: "user" },
                parts: [
                    {
                        type: "text",
                        text: "✨ Magic Context — what's new: announcement bullet here",
                        ignored: true,
                    },
                    {
                        type: "text",
                        text: "please explain how the historian decides when to run",
                    },
                ],
            } as unknown as MessageLike;
            const messages: MessageLike[] = [mixed];

            await runAutoSearchHint({
                sessionId: "s1",
                db,
                messages,
                options: baseOptions,
            });

            expect(spy).toHaveBeenCalledTimes(1);
            expect(capturedQuery).toBeDefined();
            // The real prompt is in the embedded query…
            expect(capturedQuery ?? "").toContain("historian decides when to run");
            // …and the ignored announcement is NOT.
            expect(capturedQuery ?? "").not.toContain("Magic Context");
            expect(capturedQuery ?? "").not.toContain("announcement bullet");
        } finally {
            spy.mockRestore();
        }
    });
});
