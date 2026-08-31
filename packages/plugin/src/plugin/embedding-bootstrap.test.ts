import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    _resetProjectEmbeddingRegistryForTests,
    getProjectEmbeddingSnapshot,
} from "../features/magic-context/memory/embedding";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import { closeDatabase, openDatabase } from "../features/magic-context/storage";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "./embedding-bootstrap";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    _resetProjectEmbeddingRegistryForTests();
    closeDatabase();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

describe("ensureProjectRegisteredFromOpenCodeDirectory", () => {
    it("reads the legacy config and registers the real identity (not observation) when only legacy config exists", async () => {
        const projectDir = tempDir("mc-legacy-boot-");
        process.env.HOME = tempDir("mc-legacy-home-");
        process.env.XDG_CONFIG_HOME = tempDir("mc-legacy-config-");
        process.env.XDG_DATA_HOME = tempDir("mc-legacy-data-");
        writeFileSync(
            join(projectDir, "magic-context.jsonc"),
            '{"embedding":{"provider":"openai-compatible","model":"qwen3","endpoint":"http://localhost:1234/v1"}}',
        );
        const db = openDatabase();
        const projectIdentity = resolveProjectIdentity(projectDir);

        await ensureProjectRegisteredFromOpenCodeDirectory(projectDir, db);

        const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
        expect(snapshot?.enabled).toBe(true);
        expect(snapshot?.runtimeFingerprint).not.toStartWith("observation:");
    });
});
