export function createEventHandler(args: {
    magicContext: {
        event?: (input: { event: import("@opencode-ai/sdk").Event }) => Promise<void>;
    } | null;
    autoUpdateChecker?:
        | ((input: { event: import("@opencode-ai/sdk").Event }) => Promise<void>)
        | null;
    /**
     * Cleanup failures do not propagate into OpenCode's event loop.
     */
    onInstanceDisposed?: (directory: string) => void | Promise<void>;
}): (input: { event: import("@opencode-ai/sdk").Event }) => Promise<void> {
    return async (input): Promise<void> => {
        await args.autoUpdateChecker?.(input);
        await args.magicContext?.event?.(input);
        if (args.onInstanceDisposed && input.event?.type === "server.instance.disposed") {
            const directory = (input.event as { properties?: { directory?: string } }).properties
                ?.directory;
            if (typeof directory === "string") {
                try {
                    await args.onInstanceDisposed(directory);
                } catch {
                    // Cleanup failures do not propagate into OpenCode's event loop.
                }
            }
        }
    };
}
