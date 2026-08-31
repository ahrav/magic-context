import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { TUI_RUNTIME_SPECIFIERS } from "../shared/tui-runtime-specifiers";

/**
 * Every `opentui:runtime-module:*` import must name an export of its target module.
 *
 *
 *
 *
 * The shared list makes unknown runtime module IDs fail instead of remaining unverified.
 * unverified.
 */
describe("compiled TUI runtime imports", () => {
    const COMPILED_ROOT = join(import.meta.dir, "..", "tui-compiled");
    const IMPORT_PATTERN = /import \{([^}]+)\} from "opentui:runtime-module:([^"]+)"/g;

    function compiledFiles(dir: string): string[] {
        const found: string[] = [];
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) {
                found.push(...compiledFiles(full));
            } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
                found.push(full);
            }
        }
        return found;
    }

    /**
     *  build rewrites. */
    async function loadExportSets(): Promise<Record<string, Set<string>>> {
        const entries = await Promise.all(
            TUI_RUNTIME_SPECIFIERS.map(
                async (specifier) =>
                    [specifier, new Set(Object.keys(await import(specifier)))] as const,
            ),
        );
        return Object.fromEntries(entries);
    }

    test("every runtime specifier exists in the module it is imported from", async () => {
        const exportSets = await loadExportSets();

        const unresolved: string[] = [];
        let checked = 0;

        for (const file of compiledFiles(COMPILED_ROOT)) {
            const source = readFileSync(file, "utf8");
            for (const match of source.matchAll(IMPORT_PATTERN)) {
                const moduleId = decodeURIComponent(match[2] ?? "");
                const exports = exportSets[moduleId];
                if (!exports) {
                    unresolved.push(
                        `${file}: imports from unknown runtime module '${moduleId}' — ` +
                            "add it to TUI_RUNTIME_SPECIFIERS so it can be verified",
                    );
                    continue;
                }

                for (const specifier of (match[1] ?? "").split(",")) {
                    const importedName = specifier
                        .trim()
                        .split(/\s+as\s+/)[0]
                        ?.trim();
                    if (!importedName) continue;
                    checked += 1;
                    if (!exports.has(importedName)) {
                        unresolved.push(
                            `${file}: '${importedName}' is not exported by ${moduleId}`,
                        );
                    }
                }
            }
        }

        expect(checked).toBeGreaterThan(0);
        expect(unresolved).toEqual([]);
    });

    test("every rewritten specifier resolves to a non-empty module", async () => {
        // An unresolvable specifier rejects `loadExportSets` because its dynamic import propagates to the test.
        // An empty resolved module makes every name imported from it appear missing.
        const exportSets = await loadExportSets();

        const empty = TUI_RUNTIME_SPECIFIERS.filter(
            (specifier) => (exportSets[specifier]?.size ?? 0) === 0,
        );
        expect(empty).toEqual([]);
    });

    test("TUI_RUNTIME_SPECIFIERS has no duplicates", () => {
        // `Object.fromEntries` collapses duplicate specifiers, reducing the export-set map without an error.
        expect([...new Set(TUI_RUNTIME_SPECIFIERS)]).toEqual([...TUI_RUNTIME_SPECIFIERS]);
    });

    test("solid control-flow builtins are imported from solid-js, not @opentui/solid", async () => {
        const openTuiExports = new Set(Object.keys(await import("@opentui/solid")));
        const solidExports = new Set(Object.keys(await import("solid-js")));

        const misroutable = [...solidExports].filter((name) => !openTuiExports.has(name));

        const violations: string[] = [];
        for (const file of compiledFiles(COMPILED_ROOT)) {
            const source = readFileSync(file, "utf8");
            for (const match of source.matchAll(IMPORT_PATTERN)) {
                if (decodeURIComponent(match[2] ?? "") !== "@opentui/solid") continue;
                for (const specifier of (match[1] ?? "").split(",")) {
                    const importedName = specifier
                        .trim()
                        .split(/\s+as\s+/)[0]
                        ?.trim();
                    if (importedName && misroutable.includes(importedName)) {
                        violations.push(`${file}: '${importedName}' must come from solid-js`);
                    }
                }
            }
        }

        expect(violations).toEqual([]);
    });
});
