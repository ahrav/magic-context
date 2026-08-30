import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildSchema } from "./build-schema";

/**
 * Drift guard: the published JSON Schema (`assets/magic-context.schema.json`) is
 * generated from the Zod `MagicContextConfigSchema` via `build-schema.ts`. This
 * test fails if the committed file is out of sync with what the generator
 * produces — i.e. someone changed the Zod config (added a field, changed a
 * default/constraint/description) without re-running `bun build-schema.ts`.
 *
 * This is the structural fix for the class of bug where a config key exists at
 * runtime but is missing from the published schema (e.g. `auto_update`, issue
 * #109): the schema can no longer drift from the runtime validator.
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
        // Unwrap the .transform() to reach the underlying object shape.
        // biome-ignore lint/suspicious/noExplicitAny: zod internal shape access for the drift guard.
        const def: any = (MagicContextConfigSchema as any)._def ?? (MagicContextConfigSchema as any).def;
        // The schema is `z.object({...}).transform(...)`; reach the inner object.
        // biome-ignore lint/suspicious/noExplicitAny: zod internal shape access.
        const inner: any = def?.innerType ?? def?.schema ?? MagicContextConfigSchema;
        // biome-ignore lint/suspicious/noExplicitAny: zod internal shape access.
        const shape = (inner as any).shape ?? (inner as any)._def?.shape ?? (inner as any).def?.shape;
        const zodKeys =
            typeof shape === "function" ? Object.keys(shape()) : Object.keys(shape ?? {});

        const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as {
            properties: Record<string, unknown>;
        };
        const schemaKeys = new Set(Object.keys(schema.properties));

        // Every zod top-level field must be a documented schema property.
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
