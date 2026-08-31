/**
 *
 *
 * TUI shows a startup dialog; this module handles Desktop.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { ConflictResult } from "../shared/conflict-detector";
import { formatConflictShort } from "../shared/conflict-detector";
import { log } from "../shared/logger";
import { waitForSafeNotificationTarget } from "../shared/safe-notification-target";

const CONFLICT_WARNING_MARKER = "⚠️ Magic Context is disabled due to conflicting configuration:";
const SCHEMA_FENCE_MARKER = "⚠️ Magic Context is disabled — database is newer than this version";
const ENABLED_MARKER = "✨ Magic Context is now enabled";
const ANNOUNCEMENT_MARKER = "✨ Magic Context — what's new in";


function getDesktopStatePath(): string | null {
    const os = platform();
    const home = homedir();

    if (os === "darwin") {
        return join(
            home,
            "Library",
            "Application Support",
            "ai.opencode.desktop",
            "opencode.global.dat",
        );
    }
    if (os === "linux") {
        const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");
        return join(xdgConfig, "ai.opencode.desktop", "opencode.global.dat");
    }
    if (os === "win32") {
        const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
        return join(appData, "ai.opencode.desktop", "opencode.global.dat");
    }

    return null;
}

interface DesktopState {
    sessionId: string | null;
    sidecarUrl: string | null;
}

function readDesktopState(directory: string): DesktopState {
    const statePath = getDesktopStatePath();
    if (!statePath || !existsSync(statePath)) {
        log(`[magic-context] conflict-warning: Desktop state file not found at ${statePath}`);
        return { sessionId: null, sidecarUrl: null };
    }

    try {
        const raw = readFileSync(statePath, "utf-8");
        const state = JSON.parse(raw) as Record<string, unknown>;

        let sidecarUrl: string | null = null;
        const serverStr = state.server;
        if (typeof serverStr === "string") {
            try {
                const serverState = JSON.parse(serverStr) as Record<string, unknown>;
                if (typeof serverState.currentSidecarUrl === "string") {
                    sidecarUrl = serverState.currentSidecarUrl;
                }
            } catch {
            }
        }

        let sessionId: string | null = null;
        const layoutPage = state["layout.page"];
        if (typeof layoutPage === "string") {
            const parsed = JSON.parse(layoutPage) as Record<string, unknown>;
            const lastProjectSession = parsed.lastProjectSession as
                | Record<string, { id?: string }>
                | undefined;
            if (lastProjectSession) {
                const entry = lastProjectSession[directory];
                sessionId = entry?.id ?? null;
            }
        }

        return { sessionId, sidecarUrl };
    } catch (error) {
        log(
            `[magic-context] conflict-warning: failed to read Desktop state: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { sessionId: null, sidecarUrl: null };
    }
}

const cachedDesktopStateByDir = new Map<string, DesktopState>();

function getDesktopState(directory: string): DesktopState {
    let cached = cachedDesktopStateByDir.get(directory);
    if (!cached) {
        cached = readDesktopState(directory);
        cachedDesktopStateByDir.set(directory, cached);
    }
    return cached;
}


async function deleteMessage(
    serverUrl: string,
    sessionId: string,
    messageId: string,
): Promise<boolean> {
    // OpenCode's Session2 wrapper doesn't expose deleteMessage.
    const auth = getServerAuth();
    const url = `${serverUrl}/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`;

    try {
        const response = await fetch(url, {
            method: "DELETE",
            headers: auth ? { Authorization: auth } : {},
            signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
            log(
                `[magic-context] conflict-warning: DELETE failed status=${response.status} url=${url}`,
            );
            return false;
        }
        return true;
    } catch (error) {
        log(
            `[magic-context] conflict-warning: DELETE error (url=${serverUrl}): ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
    }
}

function getServerAuth(): string | undefined {
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    if (!password) return undefined;
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}


type SdkMessage = {
    info?: { id?: string; role?: string; sessionID?: string };
    parts?: Array<{ type?: string; text?: string; ignored?: boolean }>;
};

async function getSessionMessages(client: unknown, sessionId: string): Promise<SdkMessage[]> {
    try {
        const c = client as {
            session?: {
                messages?: (input: {
                    path: { id: string };
                    query?: { limit?: number };
                }) => Promise<{ data?: SdkMessage[] }>;
            };
        };

        if (typeof c.session?.messages === "function") {
            // Bounded limit prevents loading the entire session into memory.
            const result = await c.session.messages({
                path: { id: sessionId },
                query: { limit: 50 },
            });
            return result?.data ?? [];
        }
    } catch (error) {
        log(
            `[magic-context] conflict-warning: failed to read messages: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    return [];
}


/**
 */
export async function sendConflictWarning(
    client: unknown,
    directory: string,
    conflictResult: ConflictResult,
): Promise<void> {
    const { sessionId } = getDesktopState(directory);
    if (!sessionId) {
        log("[magic-context] conflict-warning: could not find active session for Desktop warning");
        return;
    }

    // A non-synthetic user message in an untitled session permanently suppresses OpenCode title generation.
    // The plugin retries a skipped notification on the next launch.
    if ((await waitForSafeNotificationTarget(client, sessionId)) === "skip") return;

    const warningText = formatConflictShort(conflictResult);

    log(
        `[magic-context] sending conflict warning to session ${sessionId}: ${conflictResult.reasons.join(", ")}`,
    );

    try {
        const c = client as {
            session?: {
                prompt?: (input: unknown) => unknown;
                promptAsync?: (input: unknown) => unknown;
            };
        };

        const promptInput = {
            path: { id: sessionId },
            body: {
                noReply: true,
                parts: [
                    {
                        type: "text",
                        text: warningText,
                        ignored: true,
                    },
                ],
            },
        };

        if (typeof c.session?.prompt === "function") {
            await Promise.resolve(c.session.prompt(promptInput));
        } else if (typeof c.session?.promptAsync === "function") {
            await c.session.promptAsync(promptInput);
        } else {
            log("[magic-context] conflict-warning: session prompt API unavailable");
        }
    } catch (error: unknown) {
        log(
            `[magic-context] conflict-warning: failed to send: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/**
 * The plugin removes leftover conflict-warning messages from disabled runs.
 */
export async function cleanupConflictWarnings(
    client: unknown,
    directory: string,
    serverUrl?: string,
): Promise<void> {
    const { sessionId } = getDesktopState(directory);
    if (!sessionId) {
        log("[magic-context] cleanup: no active Desktop session found");
        return;
    }
    const messages = await getSessionMessages(client, sessionId);
    if (messages.length === 0) return;

    const warningMessageIds: string[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const msgId = msg.info?.id;
        const msgRole = msg.info?.role;
        if (!msgId || msgRole !== "user") break;

        const parts = msg.parts ?? [];
        const isWarning =
            parts.length > 0 &&
            parts.every(
                (p) =>
                    p.ignored === true &&
                    p.type === "text" &&
                    typeof p.text === "string" &&
                    p.text.startsWith(CONFLICT_WARNING_MARKER),
            );

        if (isWarning) {
            warningMessageIds.push(msgId);
        } else {
            break; // Stop at the first non-warning message from the tail
        }
    }

    if (warningMessageIds.length === 0) {
        await cleanupEnabledMessages(messages, serverUrl, sessionId);
        return;
    }

    if (!serverUrl) {
        log("[magic-context] cleanup: no serverUrl provided, cannot delete messages");
        return;
    }

    log(
        `[magic-context] cleaning up ${warningMessageIds.length} conflict warning message(s) from session ${sessionId}`,
    );

    for (const messageId of warningMessageIds) {
        const ok = await deleteMessage(serverUrl, sessionId, messageId);
        if (ok) {
            log(`[magic-context] deleted conflict warning message ${messageId}`);
        }
    }

    // The plugin sends an "enabled" confirmation so the user sees that the conflict is resolved.
    // The plugin always runs warning cleanup; it may skip only the confirmation.
    if ((await waitForSafeNotificationTarget(client, sessionId)) === "skip") return;
    const enabledText = `${ENABLED_MARKER}. Enjoy! ✨`;
    try {
        const c = client as {
            session?: {
                prompt?: (input: unknown) => unknown;
                promptAsync?: (input: unknown) => unknown;
            };
        };

        const promptInput = {
            path: { id: sessionId },
            body: {
                noReply: true,
                parts: [{ type: "text", text: enabledText, ignored: true }],
            },
        };

        if (typeof c.session?.prompt === "function") {
            await Promise.resolve(c.session.prompt(promptInput));
        } else if (typeof c.session?.promptAsync === "function") {
            await c.session.promptAsync(promptInput);
        }
    } catch {
    }

    // The plugin removes the "enabled" message after 1 second so it does not persist across restarts.
    // The plugin identifies enabled confirmations by ENABLED_MARKER and the ignored flag to avoid deleting user messages.
    setTimeout(async () => {
        try {
            const freshMessages = await getSessionMessages(client, sessionId);
            for (let i = freshMessages.length - 1; i >= 0; i--) {
                const msg = freshMessages[i];
                const msgId = msg.info?.id;
                const msgRole = msg.info?.role;
                if (!msgId || msgRole !== "user") break;

                const parts = msg.parts ?? [];
                const isEnabled =
                    parts.length > 0 &&
                    parts.every(
                        (p) =>
                            p.ignored === true &&
                            p.type === "text" &&
                            typeof p.text === "string" &&
                            p.text.startsWith(ENABLED_MARKER),
                    );

                if (isEnabled) {
                    await deleteMessage(serverUrl, sessionId, msgId);
                } else {
                    break;
                }
            }
        } catch {
            // Best-effort cleanup
        }
    }, 1000);
}

/** The startup cleanup removes enabled messages left by an earlier run. */
async function cleanupEnabledMessages(
    messages: SdkMessage[],
    serverUrl: string | undefined,
    sessionId: string,
): Promise<void> {
    if (!serverUrl) return;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const msgId = msg.info?.id;
        const msgRole = msg.info?.role;
        if (!msgId || msgRole !== "user") break;

        const parts = msg.parts ?? [];
        const isEnabled =
            parts.length > 0 &&
            parts.every(
                (p) =>
                    p.ignored === true &&
                    p.type === "text" &&
                    typeof p.text === "string" &&
                    p.text.startsWith(ENABLED_MARKER),
            );

        if (isEnabled) {
            await deleteMessage(serverUrl, sessionId, msgId);
        } else {
            break;
        }
    }
}

/**
 * When OpenCode and Pi share context.db, an update by either can migrate it beyond the other's supported schema.
 * The lagging harness fail-closes and disables Magic Context when the persisted schema exceeds its supported version.
 * Do not auto-remove the schema fence; updating the lagging harness resolves the block.
 */
export async function sendSchemaFenceWarning(
    client: unknown,
    directory: string,
    detail: { persistedVersion: number; supportedVersion: number },
): Promise<void> {
    const { sessionId } = getDesktopState(directory);
    if (!sessionId) return;

    // The schema fence retries at every startup while the version mismatch persists.
    // If the title-safety guard skips the fence notification, the plugin retries on the next launch.
    if ((await waitForSafeNotificationTarget(client, sessionId)) === "skip") return;

    const text = [
        `${SCHEMA_FENCE_MARKER}`,
        "",
        `The shared Magic Context database was upgraded to schema v${detail.persistedVersion} by a`,
        `newer build (OpenCode and Pi share one database). This build only supports`,
        `up to v${detail.supportedVersion}, so it has fail-closed to avoid corrupting the cache.`,
        "",
        "This usually means a pinned or stale plugin is sharing the database with a",
        "newer instance. Update or unpin Magic Context on this harness (or update",
        "OpenCode/Pi) to the latest version, then restart. The fastest fix is:",
        "",
        "  npx @cortexkit/magic-context@latest doctor --force",
        "",
        "Your data is safe; nothing is disabled permanently.",
    ].join("\n");

    try {
        const c = client as {
            session?: {
                prompt?: (input: unknown) => unknown;
                promptAsync?: (input: unknown) => unknown;
            };
        };
        const promptInput = {
            path: { id: sessionId },
            body: { noReply: true, parts: [{ type: "text", text, ignored: true }] },
        };
        if (typeof c.session?.prompt === "function") {
            await Promise.resolve(c.session.prompt(promptInput));
        } else if (typeof c.session?.promptAsync === "function") {
            await c.session.promptAsync(promptInput);
        }
    } catch {
        return;
    }
}

/**
 * The plugin posts one ignored announcement per ANNOUNCEMENT_VERSION at Desktop startup.
 *
 */
export async function sendStartupAnnouncement(
    client: unknown,
    directory: string,
    version: string,
    features: ReadonlyArray<string>,
    footer: string,
    markSeen: (version: string) => void,
): Promise<void> {
    if (!version || features.length === 0) return;

    const { sessionId } = getDesktopState(directory);
    if (!sessionId) {
        return;
    }

    //
    const { isTuiConnected } = await import("../shared/rpc-notifications");
    if (isTuiConnected(sessionId) || isTuiConnected()) return;

    // A skipped target must remain unmarked to allow retry.
    if ((await waitForSafeNotificationTarget(client, sessionId)) === "skip") return;

    const bullets = features.map((line) => `  • ${line}`).join("\n");
    const sections = [`${ANNOUNCEMENT_MARKER} v${version}:`, "", bullets];
    if (footer && footer.trim().length > 0) {
        sections.push("", footer);
    }
    const text = sections.join("\n");

    log(`[magic-context] sending startup announcement for v${version} to session ${sessionId}`);

    try {
        const c = client as {
            session?: {
                prompt?: (input: unknown) => unknown;
                promptAsync?: (input: unknown) => unknown;
            };
        };

        const promptInput = {
            path: { id: sessionId },
            body: {
                noReply: true,
                parts: [{ type: "text", text, ignored: true }],
            },
        };

        if (typeof c.session?.prompt === "function") {
            await Promise.resolve(c.session.prompt(promptInput));
        } else if (typeof c.session?.promptAsync === "function") {
            await c.session.promptAsync(promptInput);
        } else {
            log("[magic-context] announcement: session prompt API unavailable");
            return;
        }
    } catch (error: unknown) {
        log(
            `[magic-context] announcement: failed to send: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
    }

    // The version is marked seen only after the prompt succeeds, so delivery errors remain eligible for retry.
    // delivery error.
    markSeen(version);
}
