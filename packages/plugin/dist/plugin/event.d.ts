export declare function createEventHandler(args: {
    magicContext: {
        event?: (input: {
            event: import("@opencode-ai/sdk").Event;
        }) => Promise<void>;
    } | null;
    autoUpdateChecker?: ((input: {
        event: import("@opencode-ai/sdk").Event;
    }) => Promise<void>) | null;
    /**
     * Orderly cleanup for THIS plugin instance when OpenCode disposes it. Fires
     * on the SDK `server.instance.disposed` event; the callback receives the
     * disposed instance's `directory` so the caller can match it against its own
     * `ctx.directory` (OpenCode Desktop runs multiple instances in one process,
     * each disposed independently, so a dispose for a different directory must
     * not tear down this instance's resources). Best-effort: failures are
     * swallowed so a cleanup error never propagates into OpenCode's event loop.
     */
    onInstanceDisposed?: (directory: string) => void | Promise<void>;
}): (input: {
    event: import("@opencode-ai/sdk").Event;
}) => Promise<void>;
//# sourceMappingURL=event.d.ts.map