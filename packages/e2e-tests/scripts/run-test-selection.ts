#!/usr/bin/env bun

import { Glob } from "bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { detectRustPrerequisites } from "./check-rust-prerequisites";
import {
    E2E_ROOT,
    filesForMode,
    validateModeManifest,
    type Mode,
} from "./validate-mode-manifest";

export type GreenHarness = "all" | "opencode" | "pi";

export function incidentUnitFiles(root: string = E2E_ROOT): string[] {
    const files = [
        ...new Glob("src/incident-pool/**/*.test.ts").scanSync({
            cwd: root,
            onlyFiles: true,
        }),
        "scripts/check-rust-prerequisites.test.ts",
        "scripts/validate-incident-history.test.ts",
        "scripts/validate-incident-verifiers.test.ts",
        "scripts/validate-mode-manifest.test.ts",
    ].sort();
    if (files.length === 0) throw new Error("incident unit selection is empty");
    return files;
}

/**
 * Unit tests that live outside `tests/` and outside the incident-pool tree, so
 * neither the mode manifest nor the incident-unit selection can see them. The
 * mode selection carries them because it replaced a bare `bun test` as the
 * package's default suite; without this they run nowhere.
 */
export function standaloneUnitFiles(root: string = E2E_ROOT): string[] {
    const files = [
        "src/cache-analysis.test.ts",
        "src/pi-runner/rpc-client.test.ts",
        "src/rust-runner/hermetic-subc.test.ts",
    ];
    for (const file of files) {
        if (!existsSync(resolve(root, file))) {
            throw new Error(`standalone unit selection names a missing ${file}`);
        }
    }
    return files;
}

export function greenTestFiles(
    mode: Mode,
    harness: GreenHarness = "all",
): string[] {
    if (mode === "rust" && harness !== "all") {
        throw new Error("Rust green selection requires --harness all");
    }
    const files = filesForMode(validateModeManifest(), mode, harness);
    if (files.length === 0) {
        throw new Error(`${mode}/${harness} green selection is empty`);
    }
    return files;
}

interface CliArgs {
    incidentUnit: boolean;
    mode: Mode | null;
    harness: GreenHarness;
    timeoutMs: number;
    maxConcurrency: number | null;
}

function parseArgs(args: string[]): CliArgs {
    let incidentUnit = false;
    let mode: Mode | null = null;
    let harness: GreenHarness = "all";
    let timeoutMs = 120_000;
    let maxConcurrency: number | null = null;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--incident-unit") {
            incidentUnit = true;
        } else if (arg === "--mode") {
            const value = args[++index];
            if (value !== "ts" && value !== "rust") {
                throw new Error("--mode requires ts or rust");
            }
            mode = value;
        } else if (arg === "--harness") {
            const value = args[++index];
            if (value !== "all" && value !== "opencode" && value !== "pi") {
                throw new Error("--harness requires all, opencode, or pi");
            }
            harness = value;
        } else if (arg === "--timeout") {
            const value = Number(args[++index]);
            if (!Number.isInteger(value) || value <= 0) {
                throw new Error("--timeout requires positive milliseconds");
            }
            timeoutMs = value;
        } else if (arg === "--max-concurrency") {
            const value = Number(args[++index]);
            if (!Number.isInteger(value) || value <= 0) {
                throw new Error(
                    "--max-concurrency requires a positive integer",
                );
            }
            maxConcurrency = value;
        } else if (arg === "--help" || arg === "-h") {
            console.log(
                "Usage: run-test-selection.ts (--incident-unit | --mode ts|rust [--harness all|opencode|pi]) [--timeout <ms>] [--max-concurrency <n>]",
            );
            process.exit(0);
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    if (incidentUnit === (mode !== null)) {
        throw new Error("select exactly one of --incident-unit or --mode");
    }
    if (incidentUnit && harness !== "all") {
        throw new Error("--harness does not apply to incident unit tests");
    }
    return { incidentUnit, mode, harness, timeoutMs, maxConcurrency };
}

async function main(): Promise<number> {
    const args = parseArgs(Bun.argv.slice(2));
    const files = args.incidentUnit
        ? incidentUnitFiles()
        : greenTestFiles(args.mode!, args.harness);
    if (args.mode === "rust") {
        const prerequisite = detectRustPrerequisites();
        if (!prerequisite.ok) {
            throw new Error(
                `Rust green unavailable: ${prerequisite.missing.join("; ")}`,
            );
        }
    }
    const wrapper = "tests/incident-pool-green.test.ts";
    // The wrapper drives the whole pool in-process, so it runs alone in a
    // second phase. Standalone units are hermetic and ride the first phase.
    const standalone = args.incidentUnit ? [] : standaloneUnitFiles();
    const selected = [...files, ...standalone];
    const groups = selected.includes(wrapper)
        ? [selected.filter((file) => file !== wrapper), [wrapper]]
        : [selected];
    console.log(
        `Running ${selected.length} selected test files in ${groups.length} phase(s)`,
    );
    for (const group of groups) {
        if (group.length === 0) continue;
        const command = [
            process.execPath,
            "test",
            "--timeout",
            String(args.timeoutMs),
            ...(args.maxConcurrency === null
                ? []
                : [`--max-concurrency=${args.maxConcurrency}`]),
            ...group,
        ];
        const child = Bun.spawn(command, {
            cwd: resolve(E2E_ROOT),
            env: {
                ...process.env,
                ...(args.mode ? { MC_E2E_MODE: args.mode } : {}),
            },
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
        });
        const code = await child.exited;
        if (code !== 0) return code;
    }
    return 0;
}

if (import.meta.main) {
    main()
        .then((code) => process.exit(code))
        .catch((error: unknown) => {
            console.error(
                `test selection failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            process.exit(1);
        });
}
