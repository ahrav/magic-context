/**
 * Shared fixtures for dreamer-lane tests: message shapes the fake SDK client
 * returns when a dream task's child session responds.
 */

/** One assistant reply carrying a single text part. */
export function assistantMessages(text: string) {
    return [
        {
            info: { role: "assistant", time: { created: Date.now() } },
            parts: [{ type: "text", text }],
        },
    ];
}
