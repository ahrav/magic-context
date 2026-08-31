/**
 *
 * compatibility diagnosis.
 */
export type SqliteProbe = () => Promise<unknown>;

export async function probeSqliteBackend(): Promise<void> {
    await import("@magic-context/core/shared/sqlite");
}

export function formatSqlitePreflightFailure(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error ?? "Unknown error");
    return [
        "Magic Context doctor cannot use SQLite in this runtime.",
        `SQLite probe: ${detail}`,
        "Remediation: install Node.js >= 24 or use a Bun build with node:sqlite.",
        "For Docker, use node:24-slim or a two-runtime image.",
    ].join("\n");
}

export async function runSqlitePreflight(
    probe: SqliteProbe = probeSqliteBackend,
    report: (message: string) => void = (message) => console.error(message),
): Promise<boolean> {
    try {
        await probe();
        return true;
    } catch (error) {
        report(formatSqlitePreflightFailure(error));
        return false;
    }
}
