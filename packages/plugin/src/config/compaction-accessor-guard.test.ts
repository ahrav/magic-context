import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// isCompactionEnabled (config/agent-disable.ts) is the ONLY non-schema reader
// Gate sites must use `isCompactionEnabled` rather than read `compaction.enabled` directly.
// Reject direct `compaction.enabled` and `compaction?.enabled` reads outside `ALLOWED_READERS`.
// (packages/cli/src/lib/migration-import-guard.test.ts).
//
// `magic-context.ts` defines `compaction.enabled` and is excluded from this check.

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../../..");
const SOURCE_ROOTS = ["packages/cli/src", "packages/plugin/src", "packages/pi-plugin/src"];

const ALLOWED_READERS = new Set<string>([
    // `agent-disable.ts` is the permitted non-schema reader.
    "packages/plugin/src/config/agent-disable.ts",
    // `magic-context.ts` defines `compaction.enabled`.
    "packages/plugin/src/config/schema/magic-context.ts",
    // `project-security.ts` only names `compaction.enabled` in a warning while deleting a raw project-tier key.
    "packages/plugin/src/config/project-security.ts",
    // OMP's own setting key appears only as an external CLI string literal;
    // `omp-helpers.ts`, `setup-omp.ts`, and `doctor-omp.ts` never read Magic Context's parsed compaction config.
    "packages/cli/src/lib/omp-helpers.ts",
    "packages/cli/src/commands/setup-omp.ts",
    "packages/cli/src/commands/doctor-omp.ts",
]);

function sourceFiles(directory: string): string[] {
    const result: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            result.push(...sourceFiles(path));
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
            result.push(path);
        }
    }
    return result;
}

// `COMPACTION_ENABLED_READ` matches `compaction.enabled` and `compaction?.enabled`, including string literals.
// False positives are allow-listed only when they do not read Magic Context's parsed config path.
// config path.
// `COMPACTION_ENABLED_READ` excludes `compaction_mode_record`, `isCompactionEnabled`, and schema `.object({ enabled: ... })`.
const COMPACTION_ENABLED_READ = /\bcompaction\??\s*\.\s*enabled\b(?!_)/;

describe("compaction.enabled accessor exclusivity (issue #266)", () => {
    it("no non-schema source file reads compaction.enabled directly", () => {
        const offenders: string[] = [];
        for (const root of SOURCE_ROOTS) {
            for (const path of sourceFiles(resolve(REPOSITORY_ROOT, root))) {
                const relativePath = relative(REPOSITORY_ROOT, path);
                if (ALLOWED_READERS.has(relativePath)) continue;
                const source = readFileSync(path, "utf8");
                if (COMPACTION_ENABLED_READ.test(source)) {
                    offenders.push(relativePath);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it("isCompactionEnabled is exported from the accessor module", async () => {
        const mod = await import("../config/agent-disable");
        expect(typeof mod.isCompactionEnabled).toBe("function");
    });

    it("isCompactionEnabled resolves default-on for absent block and explicit true, off for false", async () => {
        const { isCompactionEnabled } = await import("../config/agent-disable");
        expect(isCompactionEnabled({})).toBe(true);
        expect(isCompactionEnabled({ compaction: {} })).toBe(true);
        expect(isCompactionEnabled({ compaction: { enabled: true } })).toBe(true);
        expect(isCompactionEnabled({ compaction: { enabled: false } })).toBe(false);
        expect(isCompactionEnabled({ compaction: null })).toBe(true);
    });
});
