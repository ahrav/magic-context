import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildSchema } from "./build-schema";

/**
 *
 */
describe("magic-context JSON schema", () => {
    const schemaPath = path.resolve(
        import.meta.dir,
        "..",
        "..",
        "..",
        "assets",
        "magic-context.schema.json",
    );

    test("committed schema matches generator output (run `bun packages/plugin/scripts/build-schema.ts` if this fails)", () => {
        const committed = fs.readFileSync(schemaPath, "utf-8");
        const regenerated = `${JSON.stringify(buildSchema(), null, 2)}\n`;
        expect(committed).toBe(regenerated);
    });

    test("every top-level Zod config key appears in the schema", async () => {
        const { MagicContextConfigSchema } = await import("../src/config/schema/magic-context");
        // MagicContextConfigSchema wraps its object shape in `.transform()`.
        // biome-ignore lint/suspicious/noExplicitAny: `_def` and `def` are untyped Zod internals used to unwrap `.transform()`.
        const def: any = (MagicContextConfigSchema as any)._def ?? (MagicContextConfigSchema as any).def;
        // biome-ignore lint/suspicious/noExplicitAny: `innerType` and `schema` are untyped Zod internals.
        const inner: any = def?.innerType ?? def?.schema ?? MagicContextConfigSchema;
        // biome-ignore lint/suspicious/noExplicitAny: `shape` is an untyped Zod internal.
        const shape = (inner as any).shape ?? (inner as any)._def?.shape ?? (inner as any).def?.shape;
        const zodKeys =
            typeof shape === "function" ? Object.keys(shape()) : Object.keys(shape ?? {});

        const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as {
            properties: Record<string, unknown>;
        };
        const schemaKeys = new Set(Object.keys(schema.properties));

        const missing = zodKeys.filter((k) => !schemaKeys.has(k));
        expect(missing).toEqual([]);
    });

    test("auto_update is present in the schema (issue #109 regression guard)", () => {
        const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as {
            properties: Record<string, { type?: string; description?: string }>;
        };
        expect(schema.properties.auto_update).toBeDefined();
        expect(schema.properties.auto_update.type).toBe("boolean");
        expect(typeof schema.properties.auto_update.description).toBe("string");
    });

    test("experimental is not a published schema property", () => {
        // The in-memory migration relocates `experimental.*` keys, so the
        // published schema must not document the legacy container.
        const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as {
            properties: Record<string, unknown>;
        };
        expect(schema.properties.experimental).toBeUndefined();
    });
});
