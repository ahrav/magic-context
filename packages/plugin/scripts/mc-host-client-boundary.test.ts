import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Dependency-boundary gate: production packages must not depend on or import
 * `@cortexkit/subc-client`. Only `PROVIDER_EXCEPTION` may import it.
 */

const NPM_CLIENT = "@cortexkit/subc-client";
const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

const PRODUCTION_PACKAGES = ["packages/plugin", "packages/cli", "packages/pi-plugin"];

const PROVIDER_EXCEPTION = "packages/e2e-tests/src/rust-runner/fake-broca.ts";

/** IMPORT_PATTERN matches import, export-from, require, and dynamic-import specifiers for NPM_CLIENT. */
const IMPORT_PATTERN =
    /(?:from\s*["']@cortexkit\/subc-client["']|import\s*\(\s*["']@cortexkit\/subc-client["']\s*\)|require\s*\(\s*["']@cortexkit\/subc-client["']\s*\)|import\s*["']@cortexkit\/subc-client["'])/;

function* walkSourceFiles(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith("."))
            continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walkSourceFiles(full);
        else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) yield full;
    }
}

function manifestDependencies(packageDir: string): Record<string, string> {
    const manifest = JSON.parse(
        fs.readFileSync(path.join(repoRoot, packageDir, "package.json"), "utf-8"),
    ) as Record<string, Record<string, string> | undefined>;
    return {
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
    };
}

describe("mc-host-client dependency boundary", () => {
    test("production manifests do not depend on the npm client", () => {
        for (const pkg of PRODUCTION_PACKAGES) {
            expect(
                Object.keys(manifestDependencies(pkg)),
                `${pkg}/package.json must not declare ${NPM_CLIENT}`,
            ).not.toContain(NPM_CLIENT);
        }
    });

    test("production and consumer-side sources do not import the npm client", () => {
        const offenders: string[] = [];
        for (const pkg of [...PRODUCTION_PACKAGES, "packages/e2e-tests"]) {
            const root = path.join(repoRoot, pkg);
            if (!fs.existsSync(root)) continue;
            for (const file of walkSourceFiles(root)) {
                const relative = path.relative(repoRoot, file);
                if (relative === PROVIDER_EXCEPTION) continue;
                if (IMPORT_PATTERN.test(fs.readFileSync(file, "utf-8"))) offenders.push(relative);
            }
        }
        expect(offenders, `only ${PROVIDER_EXCEPTION} may import ${NPM_CLIENT}`).toEqual([]);
    });

    test("the E2E provider exception still holds the one permitted import", () => {
        const source = fs.readFileSync(path.join(repoRoot, PROVIDER_EXCEPTION), "utf-8");
        expect(IMPORT_PATTERN.test(source)).toBe(true);
        expect(Object.keys(manifestDependencies("packages/e2e-tests"))).toContain(NPM_CLIENT);
    });

    test("lockfile resolves the npm client only through the E2E package", () => {
        const lock = fs.readFileSync(path.join(repoRoot, "bun.lock"), "utf-8");
        const references = lock.split("\n").filter((line) => line.includes(NPM_CLIENT));
        expect(references.length).toBeGreaterThan(0);
        for (const pkg of PRODUCTION_PACKAGES) {
            const manifest = JSON.parse(
                fs.readFileSync(path.join(repoRoot, pkg, "package.json"), "utf-8"),
            ) as { name: string };
            // bun.lock lists each workspace's dependencies on its workspace
            // entry line, so no production package name may share a line with
            // the npm client.
            for (const line of references) {
                expect(
                    line.includes(`"${manifest.name}"`),
                    `bun.lock ties ${NPM_CLIENT} to ${manifest.name}`,
                ).toBe(false);
            }
        }
    });
});
