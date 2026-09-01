/**
 *
 *
 * TUI shows a startup dialog; this module handles Desktop.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { sendIgnoredMessage } from "../hooks/magic-context/send-session-notification";
import type { ConflictResult } from "../shared/conflict-detector";
import { formatConflictShort } from "../shared/conflict-detector";
import { log } from "../shared/logger";

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
            } catch {}
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

    const warningText = formatConflictShort(conflictResult);

    log(
        `[magic-context] sending conflict warning to session ${sessionId}: ${conflictResult.reasons.join(", ")}`,
    );

    // forcePersist: the warning describes a blocking state the user must act
    // on, and cleanupConflictWarnings deletes the persisted row once the
    // conflict is resolved — a transient toast would satisfy neither. The
    // helper owns the title-safety guard, the mid-turn queue, and prompt-
    // context pinning; conflict detection re-fires on every startup, so a
    // skipped delivery retries on the next launch.
    await sendIgnoredMessage(client, sessionId, warningText, {}, true);
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

    // Send a brief "enabled" confirmation so the user sees the conflict is
    // resolved. The confirmation is transient by design (the timer below
    // removes a persisted copy after a second), so the helper's toast-first
    // path is the right surface when a TUI is connected; the warning cleanup
    // above already ran — only the confirmation is skippable.
    const enabledText = `${ENABLED_MARKER}. Enjoy! ✨`;
    const disposition = await sendIgnoredMessage(client, sessionId, enabledText, {});
    // Schedule the auto-remove only for a confirmed persisted post: a toast
    // leaves no row, and a queued/skipped delivery has no row yet — a copy
    // flushed later is reclaimed by cleanupEnabledMessages on the next
    // startup instead.
    if (disposition !== "sent") return;

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

    log(
        `[magic-context] sending schema-fence warning to session ${sessionId}: v${detail.persistedVersion} > supported v${detail.supportedVersion}`,
    );

    // forcePersist: a fail-closed schema fence is a blocking state the user
    // must act on, so the notice stays in scrollback rather than flashing as
    // a toast. The helper owns the title-safety guard, the mid-turn queue,
    // and prompt-context pinning; the fence re-fires on every startup while
    // the version mismatch persists, so a skipped delivery retries next
    // launch.
    await sendIgnoredMessage(client, sessionId, text, {}, true);
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

    // TUI owns its own announcement surface: the TUI plugin shows a DialogAlert
    // via the get-announcement / mark-announced RPC. This server-side path is the
    // Desktop/Web fallback ONLY. Without this gate both fire for a TUI session —
    // the ignored message lands in the scrollback AND stamps last_announced_version,
    // which then suppresses (or races) the dialog. The send below passes
    // forcePersist, which makes the helper skip its own isTuiConnected toast
    // check, so this gate is the only TUI suppression on this path.
    //
    const { isTuiConnected } = await import("../shared/rpc-notifications");
    if (isTuiConnected(sessionId) || isTuiConnected()) return;

    // NOTE: OpenCode Desktop renders user messages through HighlightedText
    // (packages/ui/src/components/message-part.tsx ~L1184), which is plain
    // <span> text — not Markdown, no URL auto-linking. So `[url](url)` would
    // show as literal text, and bare URLs don't get linkified either. We
    // leave URLs as plain text so the user can copy them; clickable rendering
    // requires upstream OpenCode to add URL detection to HighlightedText.
    const bullets = features.map((line) => `  • ${line}`).join("\n");
    const sections = [`${ANNOUNCEMENT_MARKER} v${version}:`, "", bullets];
    if (footer && footer.trim().length > 0) {
        sections.push("", footer);
    }
    const text = sections.join("\n");

    log(`[magic-context] sending startup announcement for v${version} to session ${sessionId}`);

    // forcePersist: release notes are multi-line reference content, not a
    // five-second toast (and the TUI gate above already returned for any
    // toast-capable surface). The helper owns the title-safety guard, the
    // mid-turn queue, and prompt-context pinning.
    const disposition = await sendIgnoredMessage(client, sessionId, text, {}, true);

    // Persist the dismissal only on confirmed delivery, so a skipped, failed,
    // or mid-turn-queued announcement is never silently suppressed; the next
    // startup retries. A queued copy that still flushes later duplicates the
    // notice (once per startup that deferred), which beats stamping a version
    // the user never saw.
    if (disposition === "sent") markSeen(version);
}
