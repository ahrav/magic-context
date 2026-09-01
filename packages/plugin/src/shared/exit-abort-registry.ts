/**
 * register.
 *
 * The warning is `MaxListenersExceededWarning` at 11 `exit` listeners on `process`.
 */

const controllers = new Set<AbortController>();
let listenerRegistered = false;

function abortAll(): void {
    for (const controller of controllers) {
        try {
            controller.abort();
        } catch {
            // Exit handling ignores individual `abort()` failures so remaining controllers are aborted.
        }
    }
}

/**
 * fan-out set.
 */
export function registerExitAbort(controller: AbortController): void {
    controllers.add(controller);
    if (listenerRegistered) return;
    listenerRegistered = true;
    process.once("exit", abortAll);
}

/**
 */
export function unregisterExitAbort(controller: AbortController): void {
    controllers.delete(controller);
}
