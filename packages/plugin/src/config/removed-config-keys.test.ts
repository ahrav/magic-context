/// <reference types="bun-types" />

//

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_SRC = join(__dirname, "..");
const PI_SRC = join(__dirname, "..", "..", "..", "pi-plugin", "src");

const FORBIDDEN = [
    "auto_drop_tool_age",
    "drop_tool_structure",
    "autoDropToolAge",
    "dropToolStructure",
    "nudge_interval_tokens",
    "iteration_nudge_threshold",
    "nudgeIntervalTokens",
    "iterationNudgeThreshold",
];

const ALLOWED_BASENAMES = new Set<string>([]);

function walkSourceFiles(dir: string, out: string[] = []): string[] {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return out; // package not present in this checkout
    }
    for (const entry of entries) {
        if (entry === "node_modules" || entry === "dist") continue;
        const full = join(dir, entry);
        const s = statSync(full);
        if (s.isDirectory()) {
            walkSourceFiles(full, out);
        } else if (
            s.isFile() &&
            entry.endsWith(".ts") &&
            !entry.endsWith(".test.ts") &&
            !entry.endsWith(".gen.ts") &&
            !ALLOWED_BASENAMES.has(entry)
        ) {
            out.push(full);
        }
    }
    return out;
}

function scanForForbidden(files: string[]): string[] {
    const offenders: string[] = [];
    for (const file of files) {
        let text: string;
        try {
            text = readFileSync(file, "utf-8");
        } catch {
            continue; // file absent in this checkout
        }
        for (const key of FORBIDDEN) {
            if (text.includes(key)) offenders.push(`${file}: ${key}`);
        }
    }
    return offenders;
}

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

describe("removed Phase 2 config keys", () => {
    it("no production source references auto_drop_tool_age / drop_tool_structure", () => {
        const files = [...walkSourceFiles(PLUGIN_SRC), ...walkSourceFiles(PI_SRC)];
        expect(scanForForbidden(files)).toEqual([]);
    });

    it("no docs / generated schema / e2e config references the removed keys", () => {
        const docFiles = [
            join(REPO_ROOT, "CONFIGURATION.md"),
            join(REPO_ROOT, "README.md"),
            join(REPO_ROOT, "assets", "magic-context.schema.json"),
        ];
        const e2eFiles = walkSourceFiles(join(REPO_ROOT, "packages", "e2e-tests", "tests")).filter(
            () => true,
        );
        const e2eDir = join(REPO_ROOT, "packages", "e2e-tests", "tests");
        let e2eEntries: string[] = [];
        try {
            e2eEntries = readdirSync(e2eDir)
                .filter((f) => f.endsWith(".ts"))
                .map((f) => join(e2eDir, f));
        } catch {
            e2eEntries = [];
        }
        expect(scanForForbidden([...docFiles, ...e2eFiles, ...e2eEntries])).toEqual([]);
    });
});
