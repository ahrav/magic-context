import { describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type LegacyConfigSource,
    migrateConfigFile,
    resolveLegacyConfigSources,
} from "./migrate-config-location";

function tmp(): string {
    return mkdtempSync(join(tmpdir(), "mc-cfgloc-"));
}

function src(path: string, label = "legacy"): LegacyConfigSource {
    return { path, label };
}

describe("migrateConfigFile (location migration)", () => {
    it("no-ops when no legacy source exists", () => {
        const dir = tmp();
        try {
            const target = join(dir, ".cortexkit", "magic-context.jsonc");
            const r = migrateConfigFile({
                scope: "project",
                targetPath: target,
                legacySources: [src(join(dir, "magic-context.jsonc"))],
            });
            expect(r.migrated).toBe(false);
            expect(r.conflict).toBe(false);
            expect(existsSync(target)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reclaims a stale (crashed-holder) lock in one shot without blocking init", () => {
        const dir = tmp();
        try {
            const target = join(dir, ".cortexkit", "magic-context.jsonc");
            const legacy = join(dir, "magic-context.jsonc");
            writeFileSync(legacy, '{"enabled":false}');
            // The lock directory simulates a crashed holder.
            // The lock directory's mtime exceeds CONFIG_LOCK_STALE_MS (4 s).
            // The non-blocking lock retries mkdir once after removal.
            // Migration proceeds without waiting for the lock.
            const lockDir = `${target}.lock`;
            mkdirSync(lockDir, { recursive: true });
            // 60 s exceeds CONFIG_LOCK_STALE_MS (4 s).
            const old = Date.now() - 60_000;
            utimesSync(lockDir, new Date(old), new Date(old));
            const start = Date.now();
            const r = migrateConfigFile({
                scope: "project",
                targetPath: target,
                legacySources: [src(legacy)],
            });
            const elapsed = Date.now() - start;
            expect(elapsed).toBeLessThan(1_000);
            expect(r.migrated).toBe(true);
            expect(existsSync(target)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("skips migration this run (no block) when a LIVE holder owns the lock", () => {
        const dir = tmp();
        try {
            const target = join(dir, ".cortexkit", "magic-context.jsonc");
            const legacy = join(dir, "magic-context.jsonc");
            writeFileSync(legacy, '{"enabled":false}');
            // A fresh lock represents a live holder, so migration skips this run without waiting.
            mkdirSync(`${target}.lock`, { recursive: true });
            const start = Date.now();
            const r = migrateConfigFile({
                scope: "project",
                targetPath: target,
                legacySources: [src(legacy)],
            });
            const elapsed = Date.now() - start;
            expect(elapsed).toBeLessThan(1_000);
            expect(r.migrated).toBe(false);
            expect(r.conflict).toBe(false);
            expect(existsSync(target)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("moves a single legacy source to the target and leaves a .MOVED_READPLEASE marker", () => {
        const dir = tmp();
        try {
            const legacy = join(dir, ".opencode", "magic-context.jsonc");
            mkdirSync(join(dir, ".opencode"), { recursive: true });
            writeFileSync(legacy, '{ "enabled": true }');
            const target = join(dir, ".cortexkit", "magic-context.jsonc");

            const r = migrateConfigFile({
                scope: "project",
                targetPath: target,
                legacySources: [src(legacy)],
            });

            expect(r.migrated).toBe(true);
            expect(r.conflict).toBe(false);
            expect(readFileSync(target, "utf8")).toContain("enabled");
            // Removing the legacy file makes migration idempotent.
            expect(existsSync(legacy)).toBe(false);
            // The marker preserves the legacy content below a header.
            const marker = `${legacy}.MOVED_READPLEASE`;
            expect(existsSync(marker)).toBe(true);
            const markerText = readFileSync(marker, "utf8");
            expect(markerText).toContain("configuration moved");
            expect(markerText).toContain(target);
            expect(markerText).toContain("enabled");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("is idempotent: a second run finds no legacy source and no-ops", () => {
        const dir = tmp();
        try {
            const legacy = join(dir, "magic-context.jsonc");
            writeFileSync(legacy, '{ "protected_tags": 5 }');
            const target = join(dir, ".cortexkit", "magic-context.jsonc");
            const opts = {
                scope: "project" as const,
                targetPath: target,
                legacySources: [src(legacy)],
            };
            const first = migrateConfigFile(opts);
            expect(first.migrated).toBe(true);
            const second = migrateConfigFile(opts);
            expect(second.migrated).toBe(false);
            expect(second.conflict).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("moves legacy aside (no overwrite) when target already exists and matches semantically", () => {
        const dir = tmp();
        try {
            const target = join(dir, ".cortexkit", "magic-context.jsonc");
            mkdirSync(join(dir, ".cortexkit"), { recursive: true });
            writeFileSync(target, '{\n  "protected_tags": 5,\n  "cache_ttl": "1h"\n}\n');
            const legacy = join(dir, ".opencode", "magic-context.jsonc");
            mkdirSync(join(dir, ".opencode"), { recursive: true });
            writeFileSync(legacy, '// mine\n{ "cache_ttl": "1h", "protected_tags": 5, }');

            const r = migrateConfigFile({
                scope: "project",
                targetPath: target,
                legacySources: [src(legacy)],
            });

            expect(r.migrated).toBe(false);
            expect(r.conflict).toBe(false);
            expect(readFileSync(target, "utf8")).toContain('"protected_tags": 5');
            expect(existsSync(legacy)).toBe(false);
            expect(existsSync(`${legacy}.MOVED_READPLEASE`)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("REFUSES (conflict) when target exists with different settings — leaves both untouched", () => {
        const dir = tmp();
        try {
            const target = join(dir, ".cortexkit", "magic-context.jsonc");
            mkdirSync(join(dir, ".cortexkit"), { recursive: true });
            writeFileSync(target, '{ "protected_tags": 5 }');
            const legacy = join(dir, ".opencode", "magic-context.jsonc");
            mkdirSync(join(dir, ".opencode"), { recursive: true });
            writeFileSync(legacy, '{ "protected_tags": 9 }');

            const r = migrateConfigFile({
                scope: "project",
                targetPath: target,
                legacySources: [src(legacy)],
            });

            expect(r.conflict).toBe(true);
            expect(r.migrated).toBe(false);
            expect(r.warnings.join("\n")).toContain("already exists with different settings");
            // Migration leaves both files unchanged for manual reconciliation.
            expect(readFileSync(target, "utf8")).toContain('"protected_tags": 5');
            expect(readFileSync(legacy, "utf8")).toContain('"protected_tags": 9');
            expect(existsSync(`${legacy}.MOVED_READPLEASE`)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("REFUSES (conflict) when multiple legacy sources disagree and no target exists", () => {
        const dir = tmp();
        try {
            const a = join(dir, ".opencode", "magic-context.jsonc");
            const b = join(dir, ".pi", "magic-context.jsonc");
            mkdirSync(join(dir, ".opencode"), { recursive: true });
            mkdirSync(join(dir, ".pi"), { recursive: true });
            writeFileSync(a, '{ "protected_tags": 5 }');
            writeFileSync(b, '{ "protected_tags": 9 }');
            const target = join(dir, ".cortexkit", "magic-context.jsonc");

            const r = migrateConfigFile({
                scope: "project",
                targetPath: target,
                legacySources: [src(a), src(b)],
            });

            expect(r.conflict).toBe(true);
            expect(r.migrated).toBe(false);
            expect(existsSync(target)).toBe(false);
            // Migration leaves both files in place for manual reconciliation.
            expect(existsSync(a)).toBe(true);
            expect(existsSync(b)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("migrates once and moves ALL matching legacy sources aside when they agree", () => {
        const dir = tmp();
        try {
            const a = join(dir, ".opencode", "magic-context.jsonc");
            const b = join(dir, ".pi", "magic-context.jsonc");
            mkdirSync(join(dir, ".opencode"), { recursive: true });
            mkdirSync(join(dir, ".pi"), { recursive: true });
            writeFileSync(a, '{ "protected_tags": 5 }');
            writeFileSync(b, '{ "protected_tags": 5 }'); // same
            const target = join(dir, ".cortexkit", "magic-context.jsonc");

            const r = migrateConfigFile({
                scope: "project",
                targetPath: target,
                legacySources: [src(a), src(b)],
            });

            expect(r.migrated).toBe(true);
            expect(existsSync(target)).toBe(true);
            expect(existsSync(`${a}.MOVED_READPLEASE`)).toBe(true);
            expect(existsSync(`${b}.MOVED_READPLEASE`)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("resolveLegacyConfigSources", () => {
    it("includes the bare-root project source unique to Magic Context", () => {
        const sources = resolveLegacyConfigSources("/proj");
        const projectPaths = sources.project.map((s) => s.path);
        expect(projectPaths).toContain("/proj/magic-context.jsonc");
        expect(projectPaths).toContain("/proj/magic-context.json");
        expect(projectPaths).toContain("/proj/.opencode/magic-context.jsonc");
        expect(projectPaths).toContain("/proj/.pi/magic-context.jsonc");
    });

    it("includes both OpenCode and Pi user sources", () => {
        const sources = resolveLegacyConfigSources("/proj");
        const userPaths = sources.user.map((s) => s.path);
        expect(userPaths.some((p) => p.includes(join("opencode", "magic-context.jsonc")))).toBe(
            true,
        );
        expect(userPaths.some((p) => p.includes(join(".pi", "agent", "magic-context.jsonc")))).toBe(
            true,
        );
    });

    it("never lists a user-scope config as a project source when the project dir is the CortexKit config home", () => {
        // Project migration must exclude the user config path when cwd is ~/.config/cortexkit.
        // The bare-root project source must not resolve to the user config path.
        const prev = process.env.XDG_CONFIG_HOME;
        const home = tmp();
        try {
            process.env.XDG_CONFIG_HOME = home;
            const cortexkitHome = join(home, "cortexkit");
            const sources = resolveLegacyConfigSources(cortexkitHome);
            const projectPaths = sources.project.map((s) => s.path);
            expect(projectPaths).not.toContain(join(cortexkitHome, "magic-context.jsonc"));
            expect(projectPaths).not.toContain(join(cortexkitHome, "magic-context.json"));
            // Exclusion retains the .opencode and .pi project sources.
            expect(projectPaths).toContain(join(cortexkitHome, ".opencode", "magic-context.jsonc"));
            expect(projectPaths).toContain(join(cortexkitHome, ".pi", "magic-context.jsonc"));
        } finally {
            if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = prev;
            rmSync(home, { recursive: true, force: true });
        }
    });

    it("never lists the OpenCode/Pi user legacy paths as project sources when the project dir is the user config dir", () => {
        // When the project root is ~/.config/opencode, migration must exclude the bare-root legacy path.
        // At ~/.config/opencode, the bare-root path resolves to the OpenCode user legacy config.
        const prev = process.env.XDG_CONFIG_HOME;
        const home = tmp();
        try {
            process.env.XDG_CONFIG_HOME = home;
            const opencodeHome = join(home, "opencode");
            const sources = resolveLegacyConfigSources(opencodeHome);
            const projectPaths = sources.project.map((s) => s.path);
            expect(projectPaths).not.toContain(join(opencodeHome, "magic-context.jsonc"));
            expect(projectPaths).not.toContain(join(opencodeHome, "magic-context.json"));
        } finally {
            if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = prev;
            rmSync(home, { recursive: true, force: true });
        }
    });
});
