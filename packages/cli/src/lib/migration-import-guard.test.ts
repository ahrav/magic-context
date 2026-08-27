import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../../..");
const SOURCE_ROOTS = ["packages/cli/src", "packages/plugin/src", "packages/pi-plugin/src"];

const ALLOWED_RUN_MIGRATIONS_IMPORTS = new Set<string>([]);

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

function hasRunMigrationsImport(source: string): boolean {
    return /\bimport\s+(?:type\s+)?\{[\s\S]*?\brunMigrations\b[\s\S]*?\}\s+from\s+["'][^"']+["']/.test(
        source,
    );
}

describe("schema migration import boundary", () => {
    it("keeps runMigrations imports inside the pinned boot allow-list", () => {
        const offenders: string[] = [];
        for (const root of SOURCE_ROOTS) {
            for (const path of sourceFiles(resolve(REPOSITORY_ROOT, root))) {
                const relativePath = relative(REPOSITORY_ROOT, path);
                if (hasRunMigrationsImport(readFileSync(path, "utf8"))) {
                    if (!ALLOWED_RUN_MIGRATIONS_IMPORTS.has(relativePath)) {
                        offenders.push(relativePath);
                    }
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
