/** Child-process exit primitive shared by the e2e runners. */

import type { ChildProcess } from "node:child_process";

/**
 * Resolve true once `child` has exited, or false if it is still running after
 * `timeoutMs`.
 *
 * A child that exited before this call resolves immediately: its `exit` event
 * already fired and never fires again, so `exitCode`/`signalCode` are the only
 * remaining record of it. Both settle paths detach their own resources — the
 * timeout removes the `exit` listener, the exit clears the timer — so a caller
 * that abandons the child after a false result leaves nothing attached to it.
 */
export function waitForChildExit(
    child: ChildProcess,
    timeoutMs: number,
): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null)
        return Promise.resolve(true);
    return new Promise((resolveExit) => {
        const onExit = (): void => {
            clearTimeout(timer);
            resolveExit(true);
        };
        const timer = setTimeout(() => {
            child.off("exit", onExit);
            resolveExit(false);
        }, timeoutMs);
        child.once("exit", onExit);
    });
}
