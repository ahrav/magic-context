#!/usr/bin/env bun
/**
 *
 * Usage:
 *   bun packages/plugin/scripts/measure-agent-surface.ts
 */
import { resolve } from "node:path";
import {
    builtInLightSurface,
    measureAgentSurface,
    measureLightSurface,
    readLightSurface,
} from "./prompt-surface-measurement";
import { ACTIVE_TOOL_IDS } from "../src/shared/prompt-surface-runtime";
import { validateBudgetFixture } from "./prompt-surface-fixture";

const fixturePath = resolve(import.meta.dir, "../../..", "docs/specs/prompt-surface/budget-fixture.json");
const args = process.argv.slice(2);
const assertMode = args.includes("--assert");
const lightSurfaceIndex = args.indexOf("--light-surface");
const lightSurfacePath = lightSurfaceIndex >= 0 ? args[lightSurfaceIndex + 1] : undefined;

function formatCount(value: { chars: number; tokens: number }): string {
    return `${value.chars} chars, ${value.tokens} tokens`;
}

function printReport() {
    const surface = measureAgentSurface();
    console.log(`tokenizer: ${surface.tokenizer.package} / ${surface.tokenizer.encoding} ${surface.tokenizer.version}`);
    console.log(`counting method: ${surface.tokenizer.method}`);
    console.log("");
    console.log("guidance variants");
    for (const row of surface.guidance) {
        console.log(`- ${row.id}: ${formatCount(row.full)}`);
    }
    console.log("");
    console.log("active built-in tool descriptions and serialized parameter schemas");
    for (const id of ACTIVE_TOOL_IDS) {
        const tool = surface.tools[id];
        console.log(
            `- ${id}: description ${formatCount(tool.description)}; serialized parameter schema ${formatCount(tool.serializedParameterSchema)}`,
        );
    }
    console.log("");
    console.log(`primary mutable-prose baseline: ${surface.primary.mutableProseBaseline} tokens`);
    console.log(
        `primary serialized parameter-schema total: ${surface.primary.serializedParameterSchemaTotal} tokens (reported separately; excluded from the ceiling)`,
    );
    console.log(
        `built-in provider-visible total: ${surface.primary.builtInProviderVisibleTotal} tokens (guidance + descriptions + serialized parameter schemas)`,
    );
    console.log("excluded adjuncts: project docs, profile, memory rendering, compartments, m0, temporal overlays, and USER overrides (no static counts fabricated)");
    console.log("approximately 6.1k: one-time issue-268 all-in measurement, not this mutable-prose metric");

    const light = measureLightSurface(
        lightSurfacePath ? readLightSurface(lightSurfacePath) : builtInLightSurface(),
        surface,
    );
    console.log("");
    console.log(`${lightSurfacePath ? "light candidate" : "built-in light surface"} (${light.variant})`);
    console.log(`- guidance: ${formatCount(light.guidance)}`);
    for (const id of ACTIVE_TOOL_IDS) {
        console.log(`- ${id} light description: ${formatCount(light.descriptions[id])}`);
    }
    console.log(`- light mutable-prose total: ${light.mutableProseTotal} tokens`);
    console.log(`- light built-in provider-visible total: ${light.builtInProviderVisibleTotal} tokens`);
}

if (import.meta.main) {
    try {
        if (assertMode) {
            printReport();
            const result = validateBudgetFixture({
                fixturePath,
                lightSurfacePath,
            });
            for (const message of result.messages) console.log(message);
            if (result.errors.length > 0) {
                for (const error of result.errors) console.error(`ERROR: ${error}`);
                process.exitCode = 1;
            }
        } else {
            printReport();
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
