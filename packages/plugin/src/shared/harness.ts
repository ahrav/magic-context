/**
 *
 * between harnesses.
 *
 * happens:
 *   needed
 *
 */
export type HarnessId = "opencode" | "pi";

let currentHarness: HarnessId = "opencode";
let harnessLocked = false;

/**
 *
 * defensively).
 */
export function setHarness(value: HarnessId): void {
    if (harnessLocked && currentHarness !== value) {
        throw new Error(
            `Magic Context: harness already locked to "${currentHarness}"; cannot change to "${value}"`,
        );
    }
    currentHarness = value;
    harnessLocked = true;
}

/**
 */
export function getHarness(): HarnessId {
    return currentHarness;
}

/**
 */
export function _resetHarnessForTesting(): void {
    currentHarness = "opencode";
    harnessLocked = false;
}
