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
        // The glob includes script tests because `assertSrcTestsClassified` scans only `src/`.
        ...[...new Glob("scripts/*.test.ts").scanSync({
            cwd: root,
            onlyFiles: true,
        })].filter((file) => file !== "scripts/prospective-holdout.test.ts"),
    ].sort();
    if (files.length === 0) throw new Error("incident unit selection is empty");
    return files;
}

/**
 * Prospective unit tests run only through this default suite because no manifest or incident-unit selection includes them.
 * Mode selection includes these files because neither the manifest nor the incident-unit selection selects them.
 * Every mode can run prospective-unit tests because they require only Bun.
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
 * promote) and the metamorphic lane built on them. Harness-booting lane tests
 * live in the OpenCode standalone list instead, so they never run under rust or
 * pi modes.
 *
 * The metamorphic directory belongs here rather than in `standaloneUnitFiles`:
 * its transforms, invariants, and canary are credential-free and boot nothing,
 * and `historian-eval-contracts` is the job that exists so a deterministic
 * historian gate cannot be skipped by an unrelated failure. Classified as a
 * standalone unit, it ran only inside the host-mode suites and never in that job,
 * because `--historian-eval-unit` selects no standalone files at all.
 */
export function historianEvalUnitFiles(root: string = E2E_ROOT): string[] {
    // Historian only. The metamorphic suite is owned by `metamorphicEvalUnitFiles`
    // and runs in its own CI job; globbing it here as well ran every metamorphic
    // test twice per PR and made a metamorphic-only regression fail the HISTORIAN
    // status, which contradicts that job being the single owner.
    // `assertSrcTestsClassified` already claims those files through
    // `metamorphicEvalUnitFiles`, so dropping them here leaves nothing unclassified.
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

/** Credential-free metamorphic transform and invariant tests. */
export function metamorphicEvalUnitFiles(root: string = E2E_ROOT): string[] {
    const files = [
        ...new Glob("src/metamorphic-eval/**/*.test.ts").scanSync({
            cwd: root,
            onlyFiles: true,
        }),
    ].sort();
    if (files.length === 0) throw new Error("metamorphic eval unit selection is empty");
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
 * TS mode alone runs TestHarness-booting historian-eval tests because the Rust historian producer does not promote claims.
 *
 * `assertSrcTestsClassified` must accept present harness-test entries.
 */
export const HISTORIAN_EVAL_HARNESS_TESTS = ["src/historian-eval/runner.test.ts"];

export function standaloneUnitFiles(root: string = E2E_ROOT): string[] {
    const files = [
        "src/cache-analysis.test.ts",
        "src/oracle-arms/seed-gold-memories.test.ts",
        "src/opencode-runner/spawn.test.ts",
        "src/pi-runner/rpc-client.test.ts",
        "src/pi-runner/spawn.test.ts",
    ];
    return assertPresent(files, root);
}

/** These OpenCode-only oracle tests require the TypeScript TestHarness. */
export function tsOpenCodeStandaloneFiles(root: string = E2E_ROOT): string[] {
    return [
        ...assertPresent(
            [
                "src/oracle-arms/presets.test.ts",
                "src/oracle-arms/scripted-ctx-search.test.ts",
            ],
            root,
        ),
        // `tsOpenCodeStandaloneFiles()` filters absent entries because `HISTORIAN_EVAL_HARNESS_TESTS` may name a test before its file exists.
        ...HISTORIAN_EVAL_HARNESS_TESTS.filter((file) => existsSync(resolve(root, file))),
    ];
}

/**
 * The Rust selection alone runs these Cargo-fixture tests because TypeScript checkouts lack `../commons` and the tests have no skip guard.
 */
export function rustStandaloneFiles(root: string = E2E_ROOT): string[] {
    return assertPresent(["src/rust-runner/hermetic-mc-host.test.ts"], root);
}

/**
 * `src/**\/*.test.ts` files must be claimed by at least one selection.
 * A new `src/` test file that no selection claims runs in no selection.
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
        ...metamorphicEvalUnitFiles(root),
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

const UNIT_SELECTIONS = {
    "--incident-unit": incidentUnitFiles,
    "--prospective-unit": prospectiveUnitFiles,
    "--historian-eval-unit": historianEvalUnitFiles,
    "--metamorphic-eval-unit": metamorphicEvalUnitFiles,
    "--dreamer-eval-unit": dreamerEvalUnitFiles,
} as const;

type UnitSelectionFlag = keyof typeof UNIT_SELECTIONS;
type TestSelection =
    | { kind: "unit"; flag: UnitSelectionFlag }
    | { kind: "mode"; mode: Mode };

interface CliArgs {
    selection: TestSelection;
    harness: GreenHarness;
    timeoutMs: number;
    maxConcurrency: number | null;
}

export function parseArgs(args: string[]): CliArgs {
    let selection: TestSelection | null = null;
    let selectionConflict = false;
    let harness: GreenHarness = "all";
    let timeoutMs = 120_000;
    let maxConcurrency: number | null = null;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (Object.hasOwn(UNIT_SELECTIONS, arg)) {
            const next = { kind: "unit", flag: arg as UnitSelectionFlag } as const;
            selectionConflict ||= selection !== null &&
                (selection.kind !== "unit" || selection.flag !== next.flag);
            selection ??= next;
        } else if (arg === "--mode") {
            const value = args[++index];
            if (value !== "ts" && value !== "rust") {
                throw new Error("--mode requires ts or rust");
            }
            selectionConflict ||= selection !== null &&
                (selection.kind !== "mode" || selection.mode !== value);
            if (selection === null || selection.kind === "mode") {
                selection = { kind: "mode", mode: value };
            }
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
                "Usage: run-test-selection.ts (--incident-unit | --prospective-unit | --historian-eval-unit | --metamorphic-eval-unit | --dreamer-eval-unit | --mode ts|rust [--harness all|opencode|pi]) [--timeout <ms>] [--max-concurrency <n>]",
            );
            process.exit(0);
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    if (selection === null || selectionConflict) {
        throw new Error(
            "select exactly one of --incident-unit, --prospective-unit, --historian-eval-unit, --metamorphic-eval-unit, --dreamer-eval-unit, or --mode",
        );
    }
    if (selection.kind === "unit" && harness !== "all") {
        throw new Error("--harness does not apply to unit test selections");
    }
    return { selection, harness, timeoutMs, maxConcurrency };
}

async function main(): Promise<number> {
    const args = parseArgs(Bun.argv.slice(2));
    assertSrcTestsClassified();
    const files = args.selection.kind === "unit"
        ? UNIT_SELECTIONS[args.selection.flag]()
        : greenTestFiles(args.selection.mode, args.harness);
    if (args.selection.kind === "mode" && args.selection.mode === "rust") {
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
    const standalone = args.selection.kind === "unit"
        ? []
        : standaloneFilesForSelection(args.selection.mode, args.harness);
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
                ...(args.selection.kind === "mode" ? { MC_E2E_MODE: args.selection.mode } : {}),
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
