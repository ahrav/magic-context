#!/usr/bin/env bun
/**
 *
 * `MagicContextConfigSchema` in `src/config/schema/magic-context.ts` is the source of truth for this JSON Schema.
 *
 * This script generates the output from `MagicContextConfigSchema`, including its `.describe(...)` calls; do not hand-edit the output.
 *
 * Output: assets/magic-context.schema.json
 */

import * as path from "node:path";
import { z } from "zod";
import { MagicContextConfigSchema } from "../src/config/schema/magic-context";

const SCHEMA_ID =
    "https://raw.githubusercontent.com/ahrav/magic-context/main/assets/magic-context.schema.json";

export function buildSchema(): Record<string, unknown> {
    // The generator uses `io: "input"` so optional and defaulted fields describe accepted JSONC input rather than `.transform` output.
    // (the `.transform` output shape is irrelevant to what a user may write).
    const generated = z.toJSONSchema(MagicContextConfigSchema, {
        target: "draft-7",
        io: "input",
    }) as Record<string, unknown>;

    delete generated.$schema;

    const properties = (generated.properties ?? {}) as Record<string, unknown>;

    // The generated schema allows `$schema` for editor validation and autocomplete although `MagicContextConfigSchema` does not define it.
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

if (import.meta.main) {
    void main();
}
