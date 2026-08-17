#!/usr/bin/env bun
/**
 * Generates JSON Schema for magic-context.jsonc configuration.
 *
 * Source of truth is the Zod schema `MagicContextConfigSchema` in
 * `src/config/schema/magic-context.ts`. This script derives the JSON Schema
 * directly from it via Zod 4's native `z.toJSONSchema`, so the published schema
 * can never drift from the runtime config validation — every field, default,
 * constraint, and `.describe()` string flows through automatically.
 *
 * To add or change a config field: edit the Zod schema (including its
 * `.describe(...)`), then re-run this script. Do NOT hand-edit the output.
 *
 * Run: bun packages/plugin/scripts/build-schema.ts
 * Output: assets/magic-context.schema.json
 */

import * as path from "node:path";
import { z } from "zod";
import { MagicContextConfigSchema } from "../src/config/schema/magic-context";

const SCHEMA_ID =
    "https://raw.githubusercontent.com/ahrav/magic-context/main/assets/magic-context.schema.json";

export function buildSchema(): Record<string, unknown> {
    // `io: "input"` so optional/defaulted fields render as accepted INPUT (a
    // user's jsonc), matching how the schema is consumed for editor validation
    // (the `.transform` output shape is irrelevant to what a user may write).
    const generated = z.toJSONSchema(MagicContextConfigSchema, {
        target: "draft-7",
        io: "input",
    }) as Record<string, unknown>;

    // Strip the draft-7 `$schema` that toJSONSchema injects at the root — we set
    // our own envelope below.
    delete generated.$schema;

    const properties = (generated.properties ?? {}) as Record<string, unknown>;

    // Allow (and document) the `$schema` self-reference line users put at the
    // top of magic-context.jsonc for editor support. It's not part of the Zod
    // config (the loader ignores it), so it isn't in the generated properties.
    if (!("$schema" in properties)) {
        properties.$schema = {
            type: "string",
            description: "JSON Schema reference for editor validation and autocomplete.",
        };
    }

    return {
        $schema: "http://json-schema.org/draft-07/schema#",
        $id: SCHEMA_ID,
        title: "Magic Context Configuration",
        description:
            "Configuration schema for the @cortexkit/opencode-magic-context plugin. Place as magic-context.jsonc in your project root or ~/.config/opencode/.",
        ...generated,
        properties,
        // The Zod schema strips unknown keys at runtime rather than rejecting,
        // but for editor validation we surface unknown keys as warnings.
        additionalProperties: false,
    };
}

async function main() {
    const rootDir = path.resolve(import.meta.dir, "..", "..", "..");
    const assetsDir = path.join(rootDir, "assets");
    const outputPath = path.join(assetsDir, "magic-context.schema.json");

    const fs = await import("node:fs");
    if (!fs.existsSync(assetsDir)) {
        fs.mkdirSync(assetsDir, { recursive: true });
    }

    const schema = buildSchema();
    await Bun.write(outputPath, `${JSON.stringify(schema, null, 2)}\n`);
    console.log(`✓ JSON Schema generated: ${outputPath}`);
}

// Only run when invoked directly (`bun build-schema.ts`), not when imported by
// the drift-guard test.
if (import.meta.main) {
    void main();
}
