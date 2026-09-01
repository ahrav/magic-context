import { join } from "node:path";
import {
    type IdentityMergeReport,
    mergeProjectIdentities,
} from "@magic-context/core/features/magic-context/storage-identity-merge";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import type { Database } from "@magic-context/core/shared/sqlite";
import {
    openExistingContextDatabase,
    openExistingContextDatabaseForMutation,
} from "../lib/database-access";

export interface MergeIdentityCliOptions {
    from: string;
    to: string;
    dryRun: boolean;
    yes: boolean;
    dbPath?: string;
}

function valueAfter(args: string[], flag: string): string | null {
    const index = args.indexOf(flag);
    if (index < 0) return null;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

export function parseMergeIdentityArgs(args: string[]): MergeIdentityCliOptions {
    const from = valueAfter(args, "--from");
    const to = valueAfter(args, "--to");
    if (!from || !to) throw new Error("doctor merge-identity requires --from and --to");
    const dbPath = valueAfter(args, "--db");
    const knownFlags = new Set(["--from", "--to", "--db"]);
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (knownFlags.has(arg)) {
            index += 1;
            continue;
        }
        if (arg === "--dry-run" || arg === "--yes") continue;
        throw new Error(`Unknown doctor merge-identity option: ${arg}`);
    }
    return {
        from,
        to,
        dryRun: args.includes("--dry-run"),
        yes: args.includes("--yes"),
        ...(dbPath ? { dbPath } : {}),
    };
}

function printReport(report: IdentityMergeReport): void {
    console.log(`Identity merge ${report.dryRun ? "preview" : "complete"}:`);
    console.log(`  from: ${report.fromIdentity}`);
    console.log(`  to:   ${report.toIdentity}`);
    console.log("  audited project-scoped tables:");
    for (const table of report.auditedTables) {
        const suffix = table.derived ? " (derived; updated by source triggers)" : "";
        console.log(
            `    ${table.tableName} [${table.identityColumn}]${suffix}: ${report.dryRun ? table.sourceRows : table.changedRows} row(s)`,
        );
    }
    console.log(`  rows changed: ${report.changedRows}`);
    if (report.dryRun) {
        console.log("  no database writes performed");
    }
}

function openMergeDatabase(path: string, mutate: boolean): Database {
    // The opener must not run migrations because a running OpenCode/Pi process may enforce an older maximum schema version.
    const db = mutate
        ? openExistingContextDatabaseForMutation(path)
        : openExistingContextDatabase(path, { readonly: true });
    if (!db) throw new Error(`Context database does not exist: ${path}`);
    return db;
}

export function runMergeIdentityCli(args: string[]): number {
    const options = parseMergeIdentityArgs(args);
    if (!options.dryRun && !options.yes) {
        console.error(
            "Refusing to mutate context.db without explicit --yes. Re-run with --yes, or use --dry-run to preview.",
        );
        return 2;
    }

    const dbPath = options.dbPath ?? join(getMagicContextStorageDir(), "context.db");
    const db = openMergeDatabase(dbPath, !options.dryRun);
    try {
        const report = mergeProjectIdentities(db, options.from, options.to, {
            dryRun: options.dryRun,
        });
        printReport(report);
        return 0;
    } finally {
        db.close();
    }
}
