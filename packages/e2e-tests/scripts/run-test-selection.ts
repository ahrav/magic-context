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
        ...[...new Glob("scripts/*.test.ts").scanSync({
            cwd: root,
            onlyFiles: true,
        })].filter((file) => file !== "scripts/prospective-holdout.test.ts"),
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
export function prospectiveUnitFiles(root: string = E2E_ROOT): string[] {
    const files = [
        ...new Glob("src/prospective-holdout/**/*.test.ts").scanSync({
            cwd: root,
            onlyFiles: true,
        }),
        "scripts/prospective-holdout.test.ts",
    ].sort();
    if (files.length === 1) throw new Error("prospective unit selection is empty");
    return assertPresent(files, root);
}

/**
 * Pure-data historian-eval lane tests (contract, scorer, mutation battery,
 * promote). Harness-booting lane tests live in the OpenCode standalone list
 * instead, so they never run under rust or pi modes.
 */
export function historianEvalUnitFiles(root: string = E2E_ROOT): string[] {
    const files = [
        ...new Glob("src/historian-eval/**/*.test.ts").scanSync({
            cwd: root,
            onlyFiles: true,
        }),
    ]
        .filter((file) => !HISTORIAN_EVAL_HARNESS_TESTS.includes(file))
        .sort();
    if (files.length === 0) throw new Error("historian eval unit selection is empty");
    return files;
}

/** Credential-free dreamer manifest contract and scorer tests. */
export function dreamerEvalUnitFiles(root: string = E2E_ROOT): string[] {
    const files = [
        ...new Glob("src/dreamer-eval/**/*.test.ts").scanSync({
            cwd: root,
            onlyFiles: true,
        }),
    ].sort();
    if (files.length === 0) throw new Error("dreamer eval unit selection is empty");
    return files;
}

/**
 * Historian-eval tests that boot the TestHarness (`opencode serve` + mock
 * provider). TS-mode only: `mc-module`'s Rust historian producer does not
 * promote claims, so these must never join a rust or pi selection.
 *
 * Forward declaration: entries are excluded from `historianEvalUnitFiles()` and
 * claimed by `tsOpenCodeStandaloneFiles()` the moment they land, so adding one
 * never trips `assertSrcTestsClassified` — which every CLI path runs, and which
 * would otherwise break `--mode ts` and `--incident-unit` alike. Listing a name
 * before the file exists is therefore deliberate, and the presence filter in
 * `tsOpenCodeStandaloneFiles` is what makes it harmless.
 */
export const HISTORIAN_EVAL_HARNESS_TESTS = ["src/historian-eval/runner.test.ts"];

export function standaloneUnitFiles(root: string = E2E_ROOT): string[] {
    const files = [
        "src/cache-analysis.test.ts",
        "src/metamorphic-eval/injection-canary.test.ts",
        "src/metamorphic-eval/invariants.test.ts",
        "src/metamorphic-eval/metamorphic.test.ts",
        "src/metamorphic-eval/transforms.test.ts",
        "src/oracle-arms/seed-gold-memories.test.ts",
        "src/opencode-runner/spawn.test.ts",
        "src/pi-runner/rpc-client.test.ts",
        "src/pi-runner/spawn.test.ts",
    ];
    return assertPresent(files, root);
}

/** OpenCode-only oracle tests that require the TypeScript TestHarness. */
export function tsOpenCodeStandaloneFiles(root: string = E2E_ROOT): string[] {
    return [
        ...assertPresent(
            [
                "src/oracle-arms/presets.test.ts",
                "src/oracle-arms/scripted-ctx-search.test.ts",
            ],
            root,
        ),
        // Presence-filtered, not asserted: the harness list is a forward
        // declaration (see HISTORIAN_EVAL_HARNESS_TESTS), so a name may legally
        // precede its file. Claiming the ones that do exist is what keeps the
        // historian-eval exclusion wired to a destination.
        ...HISTORIAN_EVAL_HARNESS_TESTS.filter((file) => existsSync(resolve(root, file))),
    ];
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
        ...prospectiveUnitFiles(root).filter((file) => file.startsWith("src/")),
        ...historianEvalUnitFiles(root),
        ...dreamerEvalUnitFiles(root),
        ...standaloneUnitFiles(root),
        ...tsOpenCodeStandaloneFiles(root),
        ...rustStandaloneFiles(root),
    ]);
    const unclassified = onDisk.filter((file) => !claimed.has(file)).sort();
    if (unclassified.length > 0) {
        throw new Error(
            `src test files missing from every selection: ${unclassified.join(", ")}; ` +
                "add them to standaloneUnitFiles, rustStandaloneFiles, the historian-eval glob, or the incident-unit glob. " +
                "Harness-booting TS-only tests (e.g. historian-eval runner tests excluded via " +
                "HISTORIAN_EVAL_HARNESS_TESTS) belong in tsOpenCodeStandaloneFiles — never in " +
                "standaloneUnitFiles, which joins rust and pi selections",
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

export function standaloneFilesForSelection(
    mode: Mode,
    harness: GreenHarness,
    root: string = E2E_ROOT,
): string[] {
    return [
        ...standaloneUnitFiles(root),
        ...(mode === "ts" && harness !== "pi"
            ? tsOpenCodeStandaloneFiles(root)
            : []),
        ...(mode === "rust" ? rustStandaloneFiles(root) : []),
    ];
}

interface CliArgs {
    incidentUnit: boolean;
    prospectiveUnit: boolean;
    historianEvalUnit: boolean;
    dreamerEvalUnit: boolean;
    mode: Mode | null;
    harness: GreenHarness;
    timeoutMs: number;
    maxConcurrency: number | null;
}

function parseArgs(args: string[]): CliArgs {
    let incidentUnit = false;
    let prospectiveUnit = false;
    let historianEvalUnit = false;
    let dreamerEvalUnit = false;
    let mode: Mode | null = null;
    let harness: GreenHarness = "all";
    let timeoutMs = 120_000;
    let maxConcurrency: number | null = null;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--incident-unit") {
            incidentUnit = true;
        } else if (arg === "--prospective-unit") {
            prospectiveUnit = true;
        } else if (arg === "--historian-eval-unit") {
            historianEvalUnit = true;
        } else if (arg === "--dreamer-eval-unit") {
            dreamerEvalUnit = true;
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
                "Usage: run-test-selection.ts (--incident-unit | --prospective-unit | --historian-eval-unit | --dreamer-eval-unit | --mode ts|rust [--harness all|opencode|pi]) [--timeout <ms>] [--max-concurrency <n>]",
            );
            process.exit(0);
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    const selectionCount =
        Number(incidentUnit) + Number(prospectiveUnit) + Number(historianEvalUnit) + Number(dreamerEvalUnit) + Number(mode !== null);
    if (selectionCount !== 1) {
        throw new Error(
            "select exactly one of --incident-unit, --prospective-unit, --historian-eval-unit, --dreamer-eval-unit, or --mode",
        );
    }
    if ((incidentUnit || prospectiveUnit || historianEvalUnit || dreamerEvalUnit) && harness !== "all") {
        throw new Error("--harness does not apply to unit test selections");
    }
    return { incidentUnit, prospectiveUnit, historianEvalUnit, dreamerEvalUnit, mode, harness, timeoutMs, maxConcurrency };
}

async function main(): Promise<number> {
    const args = parseArgs(Bun.argv.slice(2));
    assertSrcTestsClassified();
    const files = args.incidentUnit
        ? incidentUnitFiles()
        : args.prospectiveUnit
          ? prospectiveUnitFiles()
          : args.historianEvalUnit
            ? historianEvalUnitFiles()
            : args.dreamerEvalUnit
              ? dreamerEvalUnitFiles()
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
    const standalone =
        args.incidentUnit || args.prospectiveUnit || args.historianEvalUnit || args.dreamerEvalUnit
            ? []
            : standaloneFilesForSelection(args.mode!, args.harness);
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
