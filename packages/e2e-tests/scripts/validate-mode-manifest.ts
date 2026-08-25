#!/usr/bin/env bun

import { Glob } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    parseIncidentCatalog,
    type IncidentCatalog,
} from "../src/incident-pool/contract";

export const E2E_ROOT = resolve(import.meta.dir, "..");
export const MANIFEST_PATH = resolve(E2E_ROOT, "mode-manifest.json");
const TEST_GLOB = "tests/**/*.test.ts";

export const TIERS = ["both-modes", "ts-only", "rust-only", "excluded"] as const;
export type Tier = (typeof TIERS)[number];
export type Mode = "ts" | "rust";

export interface ModeManifestEntry {
    path: string;
    tier: Tier;
    invocation: { ts: boolean; rust: boolean };
    rationale: string;
    contract_refs: string[];
}

export interface ModeManifest {
    schema: number;
    header: string;
    entries: ModeManifestEntry[];
}

export interface ValidationResult {
    manifest: ModeManifest;
    files: string[];
}

function enumerateTestFiles(): string[] {
    const glob = new Glob(TEST_GLOB);
    return [...glob.scanSync({ cwd: E2E_ROOT, onlyFiles: true })].sort();
}

function parseJsonFile<T>(
    path: string,
    parse: (raw: unknown) => T,
): T {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
        throw new Error(`could not read ${path}: ${String(error)}`);
    }
    return parse(raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateEntry(value: unknown, index: number): ModeManifestEntry {
    if (!isRecord(value)) throw new Error(`entry ${index} is not an object`);
    const expectedKeys = ["path", "tier", "invocation", "rationale", "contract_refs"];
    const actualKeys = Object.keys(value).sort();
    if (actualKeys.join("\0") !== expectedKeys.slice().sort().join("\0")) {
        throw new Error(
            `entry ${index} must contain exactly ${expectedKeys.join(", ")}; got ${actualKeys.join(", ")}`,
        );
    }

    const path = value.path;
    if (typeof path !== "string" || path.length === 0) {
        throw new Error(`entry ${index} has an invalid path`);
    }
    const tier = value.tier;
    if (typeof tier !== "string" || !TIERS.includes(tier as Tier)) {
        throw new Error(`entry ${index} has invalid classification ${JSON.stringify(tier)}`);
    }
    const invocation = value.invocation;
    if (
        !isRecord(invocation) ||
        Object.keys(invocation).sort().join("\0") !== "rust\0ts" ||
        typeof invocation.ts !== "boolean" ||
        typeof invocation.rust !== "boolean"
    ) {
        throw new Error(`entry ${index} has invalid invocation; expected {ts:boolean,rust:boolean}`);
    }
    const rationale = value.rationale;
    if (typeof rationale !== "string" || rationale.trim().length === 0) {
        throw new Error(`entry ${index} must have a rationale`);
    }
    const contractRefs = value.contract_refs;
    if (
        !Array.isArray(contractRefs) ||
        contractRefs.some((ref) => typeof ref !== "string" || ref.trim().length === 0)
    ) {
        throw new Error(`entry ${index} must have a string-array contract_refs`);
    }

    const typedTier = tier as Tier;
    const expectedInvocation = {
        ts: typedTier === "both-modes" || typedTier === "ts-only",
        rust: typedTier === "both-modes" || typedTier === "rust-only",
    };
    if (invocation.ts !== expectedInvocation.ts || invocation.rust !== expectedInvocation.rust) {
        throw new Error(
            `entry ${index} invocation disagrees with ${typedTier}; expected ${JSON.stringify(expectedInvocation)}`,
        );
    }
    if (typedTier !== "both-modes" && contractRefs.length === 0) {
        throw new Error(`entry ${index} (${path}) is divergent/excluded but has no contract_refs`);
    }
    if (typedTier === "both-modes" && (!invocation.ts || !invocation.rust)) {
        throw new Error(`entry ${index} (${path}) is both-modes but is absent from an invocation`);
    }

    return {
        path,
        tier: typedTier,
        invocation: { ts: invocation.ts, rust: invocation.rust },
        rationale,
        contract_refs: [...contractRefs] as string[],
    };
}

/** Validate the committed manifest against the live test-file inventory. */
export function validateManifestDocument(
    raw: unknown,
    expectedFiles: string[] = enumerateTestFiles(),
): ValidationResult {
    if (!isRecord(raw) || raw.schema !== 1 || typeof raw.header !== "string" || !Array.isArray(raw.entries)) {
        throw new Error("mode manifest must be an object with schema: 1, header, and entries");
    }

    const entries = raw.entries.map(validateEntry);
    const expectedSet = new Set(expectedFiles);
    const seen = new Map<string, number>();
    for (const entry of entries) {
        seen.set(entry.path, (seen.get(entry.path) ?? 0) + 1);
        if (!expectedSet.has(entry.path)) {
            throw new Error(`dead or out-of-scope manifest path: ${entry.path}`);
        }
        if (!existsSync(resolve(E2E_ROOT, entry.path))) {
            throw new Error(`manifest path does not exist: ${entry.path}`);
        }
        if (!entry.path.startsWith("tests/") || !entry.path.endsWith(".test.ts")) {
            throw new Error(`manifest path is not under ${TEST_GLOB}: ${entry.path}`);
        }
        if (seen.get(entry.path)! > 1) {
            throw new Error(`duplicate manifest entry: ${entry.path}`);
        }
    }

    const missing = expectedFiles.filter((path) => !seen.has(path));
    if (missing.length > 0) {
        throw new Error(`missing manifest entries: ${missing.join(", ")}`);
    }
    const duplicate = [...seen.entries()].filter(([, count]) => count > 1).map(([path]) => path);
    if (duplicate.length > 0) {
        throw new Error(`duplicate manifest entries: ${duplicate.join(", ")}`);
    }

    return {
        manifest: { schema: 1, header: raw.header, entries },
        files: expectedFiles,
    };
}

export function validateGreenIncidentWrapperSource(
    source: string,
    catalog: IncidentCatalog,
): string[] {
    if (
        /from\s+["'][^"']*\/(?:parity-pi-todo|parity-synthetic-todo)["']/.test(
            source,
        )
    ) {
        throw new Error(
            "green incident wrapper imports a known-red-only scenario module",
        );
    }
    const variants = new Map(
        catalog.families.flatMap((family) =>
            family.variants.map((variant) => [variant.id, variant] as const),
        ),
    );
    const ids = [
        ...new Set(source.match(/\bvar-[a-z0-9-]+\b/g) ?? []),
    ].sort();
    if (ids.length === 0) {
        throw new Error("green incident wrapper selects no registry IDs");
    }
    for (const id of ids) {
        const variant = variants.get(id);
        if (!variant) {
            throw new Error(`green incident wrapper selects unknown registry ID ${id}`);
        }
        if (variant.lane !== "green") {
            throw new Error(
                `green incident wrapper selects known-red registry ID ${id}`,
            );
        }
    }
    return ids;
}

export function validateGreenPackageScripts(raw: unknown): void {
    if (!isRecord(raw) || !isRecord(raw.scripts)) {
        throw new Error("package.json must define scripts");
    }
    const required: Record<string, string> = {
        test: "bun scripts/run-test-selection.ts --mode ts --timeout 120000",
        "test:opencode-e2e":
            "bun scripts/run-test-selection.ts --mode ts --harness opencode --timeout 600000 --max-concurrency 1",
        "test:pi-e2e":
            "bun scripts/run-test-selection.ts --mode ts --harness pi --timeout 600000",
        "test:rust-e2e":
            "bun scripts/run-test-selection.ts --mode rust --timeout 600000 --max-concurrency 1",
        "test:incident-unit":
            "bun scripts/run-test-selection.ts --incident-unit --timeout 120000",
    };
    for (const [name, command] of Object.entries(required)) {
        if (raw.scripts[name] !== command) {
            throw new Error(
                `package script ${name} must derive its exact file list through run-test-selection.ts`,
            );
        }
    }
}

export function validateModeManifest(): ValidationResult {
    const validation = parseJsonFile(MANIFEST_PATH, (raw) =>
        validateManifestDocument(raw),
    );
    const catalog = parseJsonFile(
        resolve(E2E_ROOT, "incidents", "catalog.json"),
        parseIncidentCatalog,
    );
    const wrappers = validation.manifest.entries.filter((entry) =>
        entry.path.endsWith("incident-pool-green.test.ts"),
    );
    if (wrappers.length !== 1) {
        throw new Error("mode manifest must contain exactly one incident green wrapper");
    }
    const wrapper = wrappers[0]!;
    if (wrapper.tier !== "both-modes") {
        throw new Error("incident green wrapper must run in both TS and Rust modes");
    }
    validateGreenIncidentWrapperSource(
        readFileSync(resolve(E2E_ROOT, wrapper.path), "utf8"),
        catalog,
    );
    parseJsonFile(resolve(E2E_ROOT, "package.json"), (raw) => {
        validateGreenPackageScripts(raw);
        return true;
    });
    for (const [mode, harness] of [
        ["ts", "all"],
        ["ts", "opencode"],
        ["ts", "pi"],
        ["rust", "all"],
    ] as const) {
        if (filesForMode(validation, mode, harness).length === 0) {
            throw new Error(`${mode}/${harness} manifest selector is empty`);
        }
    }
    return validation;
}

export function filesForMode(
    validation: ValidationResult,
    mode: Mode,
    harness: "all" | "opencode" | "pi" = "all",
): string[] {
    return validation.manifest.entries
        .filter((entry) => entry.invocation[mode])
        .filter((entry) => {
            if (harness === "all") return true;
            const isPi = entry.path.startsWith("tests/pi-");
            return harness === "pi" ? isPi : !isPi;
        })
        .map((entry) => entry.path)
        .sort();
}

function parseArgs(args: string[]): { mode?: Mode; harness: "all" | "opencode" | "pi" } {
    let mode: Mode | undefined;
    let harness: "all" | "opencode" | "pi" = "all";
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--mode") {
            const value = args[++index];
            if (value !== "ts" && value !== "rust") throw new Error("--mode must be ts or rust");
            mode = value;
        } else if (arg === "--harness") {
            const value = args[++index];
            if (value !== "all" && value !== "opencode" && value !== "pi") {
                throw new Error("--harness must be all, opencode, or pi");
            }
            harness = value;
        } else if (arg === "--help" || arg === "-h") {
            console.log("Usage: validate-mode-manifest.ts [--mode ts|rust] [--harness all|opencode|pi]");
            process.exit(0);
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    return { mode, harness };
}

if (import.meta.main) {
    try {
        const { mode, harness } = parseArgs(Bun.argv.slice(2));
        const validation = validateModeManifest();
        if (!mode) {
            console.log(`validated ${validation.files.length} e2e test entries`);
        } else {
            for (const path of filesForMode(validation, mode, harness)) console.log(path);
        }
    } catch (error) {
        console.error(`mode manifest validation failed: ${String(error)}`);
        process.exit(1);
    }
}
