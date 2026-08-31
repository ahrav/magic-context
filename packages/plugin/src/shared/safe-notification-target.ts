import { log } from "./logger";

/**
 * Post ignored notifications only to sessions with non-default titles.
 *
 * OpenCode permanently skips title generation after a session has more than one non-synthetic user message.
 * Ignored notifications remain non-synthetic user messages.
 * Posting an ignored notification before the first prompt can permanently suppress title generation.
 *
 * Do not mark notifications `synthetic: true`: Desktop renders only non-synthetic text parts.
 *
 * Posting to a session with a non-default title cannot affect title generation.
 * Do not mark skipped notifications as delivered; retry them at the next startup.
 */

/**
 * Keep this regex aligned with OpenCode's `Session.isDefaultTitle`.
 */
const DEFAULT_TITLE_RE =
    /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isDefaultSessionTitle(title: string): boolean {
    return DEFAULT_TITLE_RE.test(title);
}

/**
 */
async function readSessionTitle(client: unknown, sessionId: string): Promise<string | null> {
    try {
        const c = client as {
            session?: { get?: (input: unknown) => unknown };
        };
        if (typeof c.session?.get !== "function") return null;
        const raw = await Promise.resolve(c.session.get({ path: { id: sessionId } }));
        const obj = raw as { data?: { title?: unknown }; title?: unknown } | null;
        const title = obj && typeof obj === "object" ? (obj.data?.title ?? obj.title) : undefined;
        return typeof title === "string" ? title : null;
    } catch {
        return null;
    }
}

export interface SafeTargetOptions {
    /* */
    attempts?: number;
    /* */
    delayMs?: number;
}

/**
 *
 *   unreadable (fail-open).
 * On `"skip"`, posting can permanently suppress the session's title generation.
 * The caller must leave the delivered/seen marker unset so the next startup retries the notification.
 *   startup retries.
 *
 */
export async function waitForSafeNotificationTarget(
    client: unknown,
    sessionId: string,
    options?: SafeTargetOptions,
): Promise<"safe" | "skip"> {
    const attempts = Math.max(1, options?.attempts ?? 4);
    const delayMs = options?.delayMs ?? 15_000;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const title = await readSessionTitle(client, sessionId);
        if (title === null) return "safe";
        if (!isDefaultSessionTitle(title)) return "safe";
        if (attempt < attempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    log(
        `[magic-context] notification skipped: session ${sessionId} still has its default title (would suppress title generation); will retry on a later startup`,
    );
    return "skip";
}
