/**
 *
 *
 */
let keepSubagents = false;

/* */
export function setKeepSubagents(value: boolean): void {
    keepSubagents = value === true;
}

/* */
export function shouldKeepSubagents(): boolean {
    return keepSubagents;
}

/* */
export function _resetKeepSubagentsForTesting(): void {
    keepSubagents = false;
}
