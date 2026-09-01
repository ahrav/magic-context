import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe("writeFileAtomic", () => {
    it("writes content and leaves no .tmp sibling", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-atomic-"));
        roots.push(root);
        const target = join(root, "config.jsonc");
        writeFileAtomic(target, '{"ok":true}\n');
        expect(readFileSync(target, "utf-8")).toBe('{"ok":true}\n');
        expect(existsSync(`${target}.tmp`)).toBe(false);
    });

    it("preserves file mode on replace", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-atomic-mode-"));
        roots.push(root);
        const target = join(root, "config.jsonc");
        writeFileAtomic(target, "v1\n");
        chmodSync(target, 0o600);
        writeFileAtomic(target, "v2\n");
        expect(readFileSync(target, "utf-8")).toBe("v2\n");
        expect(statSync(target).mode & 0o777).toBe(0o600);
    });

    it("creates missing parent directories (fresh CortexKit config location)", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-atomic-mkdir-"));
        roots.push(root);
        const target = join(root, "cortexkit", "nested", "magic-context.jsonc");
        expect(existsSync(join(root, "cortexkit"))).toBe(false);
        writeFileAtomic(target, '{"created":true}\n');
        expect(readFileSync(target, "utf-8")).toBe('{"created":true}\n');
        expect(existsSync(`${target}.tmp`)).toBe(false);
    });
});
