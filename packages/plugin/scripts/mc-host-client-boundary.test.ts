import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const NPM_CLIENT = ["@cortexkit", ["subc", "client"].join("-")].join("/");
const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

const OLD_API_NAMES = [
    "HermeticSubcOptions",
    "HermeticSubcStack",
    "SubcCallError",
    "SubcCallErrorKind",
    "SubcCallOptions",
    "SubcClient",
    "SubcClientOptions",
    "SubcDiagnosticsEvent",
    "SubcDiagnosticsObserver",
    "SubcError",
    "SubcModuleTransport",
    "SubcProvider",
    "SubcProviderConnectOptions",
    "SubcProviderError",
    "SubcSocket",
    "__hermeticSubcTest",
    "buildHermeticBinaries",
    "expectSubcCallError",
    "isLegacyFallbackTerminalBody",
    "isLegacyUnsupportedOperationBody",
    "isSubcCallError",
];
type PackageManifest = {
    workspaces?: string[] | { packages?: string[] };
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
};

function readManifest(file: string): PackageManifest {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as PackageManifest;
}

function workspacePackageRoots(root: string): string[] {
    const configured = readManifest(path.join(root, "package.json")).workspaces;
    const patterns = Array.isArray(configured) ? configured : configured?.packages;
    if (!patterns) throw new Error("root package.json must declare workspaces");

    const roots = new Set<string>();
    for (const pattern of patterns) {
        if (pattern.endsWith("/*") && !pattern.slice(0, -2).includes("*")) {
            const parent = path.join(root, pattern.slice(0, -2));
            for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
                const candidate = path.join(parent, entry.name);
                if (entry.isDirectory() && fs.existsSync(path.join(candidate, "package.json"))) {
                    roots.add(candidate);
                }
            }
        } else if (!pattern.includes("*")) {
            const candidate = path.join(root, pattern);
            if (fs.existsSync(path.join(candidate, "package.json"))) roots.add(candidate);
        } else {
            throw new Error(`unsupported workspace pattern: ${pattern}`);
        }
    }
    return [...roots].sort();
}

function* walkSourceFiles(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walkSourceFiles(full);
        else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) yield full;
    }
}

function oldApiNames(source: string): string[] {
    const matches: string[] = [];
    for (const name of OLD_API_NAMES) {
        let offset = 0;
        for (;;) {
            const index = source.indexOf(name, offset);
            if (index < 0) break;
            const before = source[index - 1];
            const after = source[index + name.length];
            if ((!before || !/[\w$]/.test(before)) && (!after || !/[\w$]/.test(after))) {
                matches.push(name);
            }
            offset = index + name.length;
        }
    }
    return matches;
}

function manifestDependencies(packageRoot: string): Record<string, string> {
    const manifest = readManifest(path.join(packageRoot, "package.json"));
    return {
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
    };
}

function sourceOffenders(
    packageRoots: string[],
    root: string,
    matches: (source: string) => boolean,
    allowlist: ReadonlySet<string> = new Set(),
): string[] {
    const offenders: string[] = [];
    for (const packageRoot of packageRoots) {
        for (const file of walkSourceFiles(packageRoot)) {
            const relative = path.relative(root, file);
            if (!allowlist.has(relative) && matches(fs.readFileSync(file, "utf-8"))) {
                offenders.push(relative);
            }
        }
    }
    return offenders.sort();
}

function manifestOffenders(
    packageRoots: string[],
    root: string,
    matches: (source: string) => boolean,
): string[] {
    return packageRoots
        .map((packageRoot) => path.join(packageRoot, "package.json"))
        .filter((file) => matches(fs.readFileSync(file, "utf-8")))
        .map((file) => path.relative(root, file))
        .sort();
}

describe("mc-host-client dependency boundary", () => {
    const packageRoots = workspacePackageRoots(repoRoot);

    test("workspace package manifests do not depend on the npm client", () => {
        const offenders = packageRoots
            .filter((packageRoot) => NPM_CLIENT in manifestDependencies(packageRoot))
            .map((packageRoot) => path.relative(repoRoot, path.join(packageRoot, "package.json")));
        expect(offenders).toEqual([]);
        expect(manifestOffenders(packageRoots, repoRoot, (source) => source.includes(NPM_CLIENT))).toEqual(
            [],
        );
    });

    test("workspace package sources do not reference the npm client", () => {
        expect(
            sourceOffenders(packageRoots, repoRoot, (source) => source.includes(NPM_CLIENT)),
        ).toEqual([]);
    });

    test("workspace package sources do not reference removed client API names", () => {
        const canonicalLiteralAllowlist = new Set([
            path.relative(repoRoot, import.meta.path),
        ]);
        expect([
            ...manifestOffenders(
                packageRoots,
                repoRoot,
                (source) => oldApiNames(source).length > 0,
            ),
            ...sourceOffenders(
                packageRoots,
                repoRoot,
                (source) => oldApiNames(source).length > 0,
                canonicalLiteralAllowlist,
            ),
        ]).toEqual([]);
    });

    test("workspace discovery and matchers catch retina/dashboard-like packages", () => {
        const root = fs.mkdtempSync(path.join(tmpdir(), "mc-host-boundary-"));
        try {
            fs.writeFileSync(
                path.join(root, "package.json"),
                JSON.stringify({ private: true, workspaces: ["packages/*"] }),
            );
            const retina = path.join(root, "packages", "retina-local-fs");
            const dashboard = path.join(root, "packages", "dashboard");
            for (const packageRoot of [retina, dashboard]) {
                fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
                fs.writeFileSync(path.join(packageRoot, "package.json"), "{}");
                fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
                fs.writeFileSync(
                    path.join(packageRoot, "dist", "generated.js"),
                    `import ${JSON.stringify(NPM_CLIENT)};`,
                );
            }
            fs.writeFileSync(
                path.join(retina, "src", "provider.ts"),
                `import client from ${JSON.stringify(NPM_CLIENT)};`,
            );
            fs.writeFileSync(
                path.join(dashboard, "package.json"),
                JSON.stringify({ scripts: { legacy: OLD_API_NAMES[6] } }),
            );

            const roots = workspacePackageRoots(root);
            expect(roots.map((packageRoot) => path.basename(packageRoot))).toEqual([
                "dashboard",
                "retina-local-fs",
            ]);
            expect(sourceOffenders(roots, root, (source) => source.includes(NPM_CLIENT))).toEqual([
                "packages/retina-local-fs/src/provider.ts",
            ]);
            expect(
                manifestOffenders(roots, root, (source) => oldApiNames(source).length > 0),
            ).toEqual(["packages/dashboard/package.json"]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test("removed-name matcher covers E2E and client option surfaces", () => {
        expect(oldApiNames("let stack: HermeticSubcStack;")).toEqual(["HermeticSubcStack"]);
        expect(oldApiNames("type Options = SubcClientOptions;")).toEqual(["SubcClientOptions"]);
        expect(
            oldApiNames('const ops = ["subc_ops", "subc-client-v1", "subc-connection.json"];'),
        ).toEqual([]);
    });

    test("lockfile does not resolve the npm client", () => {
        expect(fs.readFileSync(path.join(repoRoot, "bun.lock"), "utf-8")).not.toContain(NPM_CLIENT);
    });
});
