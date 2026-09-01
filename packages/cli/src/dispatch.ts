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
        } catch {}
    }
    return "0.0.0";
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
        "    doctor drain-authority <project>  Drain module memory/note authority to TypeScript",
        "    doctor migrate   Migrate OpenCode session to Pi or OMP JSONL",
        "    doctor migrate-session   Re-home an OpenCode session to another directory",
        "    doctor merge-identity   Merge project rows (--from ID --to ID [--dry-run] [--yes])",
        "    doctor repair-db   Back up and salvage a corrupted shared database",
        "    doctor reset-db    Abandon an unsupported database family (--dry-run/--yes)",
        "",
        "  Harness selection:",
        "    --harness opencode    Target OpenCode only",
        "    --harness pi          Target Pi only",
        "    --harness omp         Target Oh My Pi (OMP) only",
        "    (default: auto-detect, prompt if multiple installed)",
        "",
        "  Usage:",
        "    npx @cortexkit/magic-context@latest setup",
        "        # add --dry-run to preview the wizard without writing any files",
        "    npx @cortexkit/magic-context@latest doctor",
        "    npx @cortexkit/magic-context@latest doctor --issue",
        "    npx @cortexkit/magic-context@latest doctor migrate \\",
        "        --from opencode --to <pi|omp> --session ses_xxx --dry-run",
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
            return await dependencies.runDaemon(rest);
        }

        if (command === "setup") {
            const { runSetup } = await import("./commands/setup");
            return await runSetup(rest);
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
                return await runDoctorDrainAuthority(
                    projectRoot,
                    join(getMagicContextStorageDir(), "context.db"),
                );
            }
            if (rest[0] === "merge-identity") {
                const { runMergeIdentityCli } = await import("./commands/doctor-merge-identity");
                return await runMergeIdentityCli(rest.slice(1));
            }
            if (rest[0] === "repair-db") {
                const { runRepairDbCli } = await import("./commands/doctor-repair-db");
                return await runRepairDbCli(rest.slice(1));
            }
            if (rest[0] === "reset-db") {
                const { runResetDbCli } = await import("./commands/doctor-reset-db");
                return await runResetDbCli(rest.slice(1));
            }
            if (rest[0] === "migrate") {
                const { runMigrateCli } = await import("./commands/migrate");
                return await runMigrateCli(rest.slice(1));
            }
            if (rest[0] === "migrate-session") {
                const { runMigrateSessionCli } = await import("./commands/migrate-session");
                return await runMigrateSessionCli(rest.slice(1));
            }
            const { runDoctor } = await import("./commands/doctor");
            return await runDoctor({
                force: rest.includes("--force"),
                issue: rest.includes("--issue"),
                clear: rest.includes("--clear"),
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
