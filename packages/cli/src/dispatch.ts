import { createRequire } from "node:module";
import { isPromptCancelledError } from "./lib/prompts";
import { runSqlitePreflight } from "./lib/sqlite-preflight";

export interface CliDispatchDependencies {
    runDaemon: (args: string[]) => Promise<number>;
    runSqlitePreflight: () => Promise<boolean>;
    stdout: (line: string) => void;
    stderr: (line: string) => void;
}

const defaultDependencies: CliDispatchDependencies = {
    runDaemon: async (args) => {
        const { runDaemonCommand } = await import("./commands/daemon");
        return runDaemonCommand(args);
    },
    runSqlitePreflight,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
};

function getVersion(): string {
    const req = createRequire(import.meta.url);
    for (const relPath of ["../../package.json", "../package.json"]) {
        try {
            const pkg = req(relPath) as { version?: unknown };
            if (typeof pkg.version === "string" && pkg.version.length > 0) {
                return pkg.version;
            }
        } catch {
            // Try the source or published layout next.
        }
    }
    return "0.0.0";
}

function valueAfter(args: string[], flag: string): string | null {
    const index = args.indexOf(flag);
    if (index === -1) return null;
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) return null;
    return next;
}

export function usageText(): string {
    return [
        "",
        "  Magic Context CLI",
        "  -----------------",
        "",
        "  Commands:",
        "    setup            Interactive setup wizard",
        "    doctor           Check and fix configuration issues",
        "    daemon start     Start the managed mc-host",
        "    daemon stop      Stop the managed mc-host",
        "    daemon restart   Restart the managed mc-host as one transaction",
        "    daemon status    Show lifecycle and readiness state without mutation",
        "    daemon doctor    Run read-only lifecycle diagnostics",
        "",
        "  Daemon output:",
        "    --json            Emit one magic-context.daemon/v1 JSON object",
        "",
        "  Doctor options:",
        "    doctor --force   Force-clear plugin cache",
        "    doctor --issue   Collect diagnostics and open a GitHub issue",
        "    doctor --clear   Interactive cache cleanup picker",
        "    doctor --check-v22-backfill       Show v22 memory backfill status",
        "    doctor --retry-v22-backfill       Retry failed v22 memory backfill rows",
        "    doctor --rekey-v22-dir-identity <path>  Re-key legacy dir identity rows",
        "    doctor --check-claims-backfill    Show v84 claims backfill status",
        "    doctor --retry-claims-backfill    Repair and resume the v84 claims backfill",
        '    doctor --waive-claims-backfill-failure <id> --rationale "<why>"',
        "    doctor drain-authority <project>  Drain module memory/note authority to TypeScript",
        "    doctor migrate   Migrate OpenCode session to Pi or OMP JSONL",
        "    doctor migrate-session   Re-home an OpenCode session to another directory",
        "    doctor merge-identity   Merge project rows (--from ID --to ID [--dry-run] [--yes])",
        "    doctor repair-db   Back up and salvage a corrupted shared database",
        "",
        "  Harness selection:",
        "    --harness opencode    Target OpenCode only",
        "    --harness pi          Target Pi only",
        "    --harness omp         Target Oh My Pi (OMP) only",
        "    (default: auto-detect, prompt if multiple installed)",
        "",
        "  Usage:",
        "    npx @cortexkit/magic-context@latest setup",
        "    npx @cortexkit/magic-context@latest doctor",
        "    npx @cortexkit/magic-context@latest daemon status --json",
        "",
    ].join("\n");
}

export async function dispatchCli(
    argv: string[] = process.argv.slice(2),
    dependencies: CliDispatchDependencies = defaultDependencies,
): Promise<number> {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
        dependencies.stdout(usageText());
        return 0;
    }

    if (argv[0] === "--version" || argv[0] === "-v") {
        dependencies.stdout(getVersion());
        return 0;
    }

    const command = argv[0];
    const rest = argv.slice(1);

    try {
        if (command === "daemon") {
            return dependencies.runDaemon(rest);
        }

        if (command === "setup") {
            const { runSetup } = await import("./commands/setup");
            return runSetup(rest);
        }

        if (command === "doctor") {
            if (!(await dependencies.runSqlitePreflight())) return 1;

            if (rest[0] === "drain-authority") {
                const projectRoot = rest[1];
                if (!projectRoot || projectRoot.startsWith("-")) {
                    dependencies.stderr("Usage: magic-context doctor drain-authority <project>");
                    return 1;
                }
                const [{ runDoctorDrainAuthority }, { getMagicContextStorageDir }, { join }] =
                    await Promise.all([
                        import("./commands/doctor-authority"),
                        import("@magic-context/core/shared/data-path"),
                        import("node:path"),
                    ]);
                return runDoctorDrainAuthority(
                    projectRoot,
                    join(getMagicContextStorageDir(), "context.db"),
                );
            }
            if (rest[0] === "merge-identity") {
                const { runMergeIdentityCli } = await import("./commands/doctor-merge-identity");
                return runMergeIdentityCli(rest.slice(1));
            }
            if (rest[0] === "repair-db") {
                const { runRepairDbCli } = await import("./commands/doctor-repair-db");
                return runRepairDbCli(rest.slice(1));
            }
            if (rest[0] === "migrate") {
                const { runMigrateCli } = await import("./commands/migrate");
                return runMigrateCli(rest.slice(1));
            }
            if (rest[0] === "migrate-session") {
                const { runMigrateSessionCli } = await import("./commands/migrate-session");
                return runMigrateSessionCli(rest.slice(1));
            }
            const { runDoctor } = await import("./commands/doctor");
            const rekeyV22DirIdentity = valueAfter(rest, "--rekey-v22-dir-identity");
            const waiveClaimsBackfillFailure = valueAfter(rest, "--waive-claims-backfill-failure");
            const waiveRationale = valueAfter(rest, "--rationale");
            return runDoctor({
                force: rest.includes("--force"),
                issue: rest.includes("--issue"),
                clear: rest.includes("--clear"),
                checkV22Backfill: rest.includes("--check-v22-backfill"),
                retryV22Backfill: rest.includes("--retry-v22-backfill"),
                ...(rekeyV22DirIdentity !== null ? { rekeyV22DirIdentity } : {}),
                checkClaimsBackfill: rest.includes("--check-claims-backfill"),
                retryClaimsBackfill: rest.includes("--retry-claims-backfill"),
                ...(rest.includes("--waive-claims-backfill-failure")
                    ? { waiveClaimsBackfillFailure }
                    : {}),
                ...(waiveRationale !== null ? { waiveRationale } : {}),
                argv: rest,
            });
        }
    } catch (error) {
        if (isPromptCancelledError(error)) return 0;
        throw error;
    }

    dependencies.stderr(`Unknown command: ${command}`);
    dependencies.stdout(usageText());
    return 1;
}
