import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { __ignoredNotificationTest } from "../hooks/magic-context/send-session-notification";
import type { ConflictResult } from "../shared/conflict-detector";
import { formatConflictShort } from "../shared/conflict-detector";
import {
    __resetNotificationStateForTests,
    registerNotificationSink,
} from "../shared/rpc-notifications";
import {
    cleanupConflictWarnings,
    sendConflictWarning,
    sendSchemaFenceWarning,
    sendStartupAnnouncement,
} from "./conflict-warning-hook";

const SESSION_ID = "ses_conflict_hook_test";
const REAL_TITLE = "Investigating the flaky cache";

let configHome: string;
let originalXdgConfigHome: string | undefined;
let directorySerial = 0;

/** Registers `SESSION_ID` as the Desktop session for a fresh project
 *  directory. The hook caches desktop state per directory, so each test gets
 *  its own directory key. */
function seedDesktopSession(): string {
    directorySerial += 1;
    const directory = `/project/conflict-hook-${directorySerial}`;
    const stateDir = join(configHome, "ai.opencode.desktop");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
        join(stateDir, "opencode.global.dat"),
        JSON.stringify({
            "layout.page": JSON.stringify({
                lastProjectSession: { [directory]: { id: SESSION_ID } },
            }),
        }),
    );
    return directory;
}

function titledClient() {
    const prompt = mock(async () => ({}));
    const get = mock(async () => ({ title: REAL_TITLE }));
    const messages = mock(async () => [
        {
            info: {
                role: "assistant",
                agent: "builder",
                model: { providerID: "anthropic", modelID: "claude-fable" },
                variant: "max",
            },
        },
    ]);
    return { client: { session: { prompt, get, messages } }, prompt };
}

const CONFLICT: ConflictResult = {
    hasConflict: true,
    reasons: ["another magic-context install is active"],
} as ConflictResult;

// The Desktop state file location is platform-specific; only the Linux
// location is env-relocatable for an isolated test.
describe.if(platform() === "linux")(
    "conflict-warning senders route through sendIgnoredMessage",
    () => {
        beforeEach(() => {
            originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
            configHome = join(tmpdir(), `conflict-hook-config-${Date.now()}-${directorySerial}`);
            process.env.XDG_CONFIG_HOME = configHome;
        });

        afterEach(() => {
            if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
            rmSync(configHome, { recursive: true, force: true });
            __ignoredNotificationTest.reset();
            __resetNotificationStateForTests();
        });

        it("defers the conflict warning while the assistant is mid-turn", async () => {
            const directory = seedDesktopSession();
            __ignoredNotificationTest.setMidTurnDetector(() => true);
            const { client, prompt } = titledClient();

            await sendConflictWarning(client, directory, CONFLICT);

            expect(prompt).not.toHaveBeenCalled();
            expect(__ignoredNotificationTest.pendingTexts(SESSION_ID)).toHaveLength(1);
        });

        it("pins the session's agent, model, and variant onto the schema-fence warning", async () => {
            const directory = seedDesktopSession();
            __ignoredNotificationTest.setMidTurnDetector(() => false);
            const { client, prompt } = titledClient();

            await sendSchemaFenceWarning(client, directory, {
                persistedVersion: 90,
                supportedVersion: 85,
            });

            expect(prompt).toHaveBeenCalledTimes(1);
            const input = prompt.mock.calls[0]?.[0] as {
                body: { agent?: string; model?: unknown; variant?: string };
            };
            expect(input.body.agent).toBe("builder");
            expect(input.body.model).toEqual({ providerID: "anthropic", modelID: "claude-fable" });
            expect(input.body.variant).toBe("max");
        });

        it("does not mark the announcement seen while delivery is deferred mid-turn", async () => {
            const directory = seedDesktopSession();
            __ignoredNotificationTest.setMidTurnDetector(() => true);
            const { client, prompt } = titledClient();
            const markSeen = mock(() => {});

            await sendStartupAnnouncement(client, directory, "9.9.9", ["a feature"], "", markSeen);

            expect(prompt).not.toHaveBeenCalled();
            expect(markSeen).not.toHaveBeenCalled();
            expect(__ignoredNotificationTest.pendingTexts(SESSION_ID)).toHaveLength(1);
        });

        it("marks the announcement seen after a confirmed persisted delivery", async () => {
            const directory = seedDesktopSession();
            __ignoredNotificationTest.setMidTurnDetector(() => false);
            const { client, prompt } = titledClient();
            const markSeen = mock(() => {});

            await sendStartupAnnouncement(client, directory, "9.9.9", ["a feature"], "", markSeen);

            expect(prompt).toHaveBeenCalledTimes(1);
            expect(markSeen).toHaveBeenCalledWith("9.9.9");
        });

        it("persists the conflict warning even when a TUI is connected", async () => {
            // cleanupConflictWarnings deletes the persisted warning row when
            // the conflict is resolved; a toast would leave nothing to clean
            // and vanish after five seconds despite the blocking state.
            const directory = seedDesktopSession();
            __ignoredNotificationTest.setMidTurnDetector(() => false);
            const toasts: unknown[] = [];
            const unregister = registerNotificationSink({
                sessionId: SESSION_ID,
                protocol: 2,
                send: (notification) => toasts.push(notification),
            });
            try {
                const { client, prompt } = titledClient();
                await sendConflictWarning(client, directory, CONFLICT);
                expect(prompt).toHaveBeenCalledTimes(1);
                expect(toasts).toHaveLength(0);
            } finally {
                unregister();
            }
        });

        it("routes the enabled confirmation to the TUI toast when a TUI is connected", async () => {
            const directory = seedDesktopSession();
            __ignoredNotificationTest.setMidTurnDetector(() => false);
            const warningText = formatConflictShort(CONFLICT);
            const toasts: unknown[] = [];
            const unregister = registerNotificationSink({
                sessionId: SESSION_ID,
                protocol: 2,
                send: (notification) => toasts.push(notification),
            });
            const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
                (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
            );
            try {
                const prompt = mock(async () => ({}));
                const messages = mock(async () => ({
                    data: [
                        {
                            info: { id: "msg_warning", role: "user" },
                            parts: [{ type: "text", text: warningText, ignored: true }],
                        },
                    ],
                }));
                const client = {
                    session: {
                        prompt,
                        get: mock(async () => ({ title: REAL_TITLE })),
                        messages,
                    },
                };

                await cleanupConflictWarnings(client, directory, "http://127.0.0.1:1");

                expect(prompt).not.toHaveBeenCalled();
                expect(toasts).toHaveLength(1);
            } finally {
                unregister();
                fetchSpy.mockRestore();
            }
        });
    },
);
