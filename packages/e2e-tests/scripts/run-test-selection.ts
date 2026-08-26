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
        // Globbed, not listed: `assertSrcTestsClassified` only scans `src/`, so a
        // hand-maintained list here would silently drop a newly added
        // `scripts/*.test.ts` from the default, host, and incident-unit
        // selections without tripping any guard.
        ...new Glob("scripts/*.test.ts").scanSync({
            cwd: root,
            onlyFiles: true,
        }),
    ].sort();
    if (files.length === 0) throw new Error("incident unit selection is empty");
    return files;
}

/**
 * Hermetic unit tests that live outside `tests/` and outside the incident-pool
 * tree, so neither the mode manifest nor the incident-unit selection can see
 * them. The mode selection carries them because it replaced a bare `bun test`
 * as the package's default suite; without this they run nowhere. These need
 * nothing beyond Bun, so every mode can run them.
 */
export function standaloneUnitFiles(root: string = E2E_ROOT): string[] {
    const files = [
        "src/cache-analysis.test.ts",
        "src/opencode-runner/spawn.test.ts",
        "src/pi-runner/rpc-client.test.ts",
    ];
    return assertPresent(files, root);
}

/**
 * Standalone tests that build the direct-host Cargo fixture. They belong to the
 * Rust selection alone: a public TypeScript checkout has no `../commons` path
 * dependencies, so building the fixture there fails, and these tests carry no
 * skip guard of their own. The Rust selection gates on the prerequisite probe
 * before it reaches them.
 */
export function rustStandaloneFiles(root: string = E2E_ROOT): string[] {
    return assertPresent(["src/rust-runner/hermetic-mc-host.test.ts"], root);
}

/**
 * Two-way guard for the hand-maintained standalone lists above: every
 * `src/**\/*.test.ts` on disk must be claimed by exactly one selection
 * (incident-unit glob, standalone units, or Rust standalone), mirroring the
 * manifest's own missing/dead-path check for `tests/**`. Without this, a new
 * test file outside `tests/` that is absent from the literals runs in no
 * selection and silently drops coverage.
 */
export function assertSrcTestsClassified(root: string = E2E_ROOT): void {
    const onDisk = [
        ...new Glob("src/**/*.test.ts").scanSync({
            cwd: root,
            onlyFiles: true,
        }),
    ];
    const claimed = new Set([
        ...incidentUnitFiles(root).filter((file) => file.startsWith("src/")),
        ...standaloneUnitFiles(root),
        ...rustStandaloneFiles(root),
    ]);
    const unclassified = onDisk.filter((file) => !claimed.has(file)).sort();
    if (unclassified.length > 0) {
        throw new Error(
            `src test files missing from every selection: ${unclassified.join(", ")}; ` +
                "add them to standaloneUnitFiles, rustStandaloneFiles, or the incident-unit glob",
        );
    }
}

function assertPresent(files: string[], root: string): string[] {
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
    assertSrcTestsClassified();
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
    // second phase. Hermetic standalone units ride the first phase; the
    // Cargo-fixture ones join only when Rust prerequisites were proven above.
    const standalone = args.incidentUnit
        ? []
        : [
              ...standaloneUnitFiles(),
              ...(args.mode === "rust" ? rustStandaloneFiles() : []),
          ];
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
