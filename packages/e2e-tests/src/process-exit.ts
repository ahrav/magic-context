/* */

import type { ChildProcess } from "node:child_process";

/**
 * The returned promise resolves true when `child` exits and false when `timeoutMs` elapses first.
 * `timeoutMs`.
 *
 * The returned promise resolves immediately when `child` exited before the call.
 * After `child` exits, `exitCode` or `signalCode` records the exit because the `exit` event does not fire again.
 * After a timeout, the function removes its `exit` listener before resolving false.
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
