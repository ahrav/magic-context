export const DATABASE_REPAIR_COMMAND = "bunx @cortexkit/magic-context@latest doctor repair-db";

export const DATABASE_RESET_COMMAND = "bunx @cortexkit/magic-context@latest doctor reset-db";

export function formatUnsupportedFormatResetGuidance(dbPath: string): string {
    return `Database: ${dbPath}. This database family is not supported by this build; the only supported action is an explicit reset: run \`${DATABASE_RESET_COMMAND}\` (preview with --dry-run). Reset abandons the family into a private quarantine directory; nothing is migrated or salvaged.`;
}

export function formatDatabaseRepairGuidance(dbPath: string): string {
    return `Database: ${dbPath}. Recovery: run \`${DATABASE_REPAIR_COMMAND}\` (salvage needs a sqlite3 shell built with SQLITE_ENABLE_DBPAGE_VTAB; without one, the command backs up and stops without modifying the database).`;
}
