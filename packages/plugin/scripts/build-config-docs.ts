#!/usr/bin/env bun
/**
 *
 *
 * Output: packages/docs/src/content/docs/reference/configuration.md
 */

import * as path from "node:path";
import { buildSchema } from "./build-schema";

type JsonSchema = {
    type?: string | string[];
    description?: string;
    default?: unknown;
    enum?: unknown[];
    properties?: Record<string, JsonSchema>;
    additionalProperties?: JsonSchema | boolean;
    anyOf?: JsonSchema[];
    oneOf?: JsonSchema[];
    items?: JsonSchema;
    minimum?: number;
    maximum?: number;
};

interface LeafRow {
    path: string;
    type: string;
    def: string;
    description: string;
}

function typeLabel(s: JsonSchema): string {
    if (s.enum) return s.enum.map((v) => `\`${JSON.stringify(v)}\``).join(" \\| ");
    const variants = s.anyOf ?? s.oneOf;
    if (variants) {
        const labels = variants.map(typeLabel);
        return [...new Set(labels)].join(" \\| ");
    }
    if (s.type === "array") return `${s.items ? typeLabel(s.items) : "unknown"}[]`;
    if (s.type === "object" && s.additionalProperties && s.additionalProperties !== true) {
        return `map<string, ${typeLabel(s.additionalProperties as JsonSchema)}>`;
    }
    if (Array.isArray(s.type)) return s.type.join(" \\| ");
    let label = s.type ?? "unknown";
    if (s.minimum !== undefined || s.maximum !== undefined) {
        const lo = s.minimum !== undefined ? `${s.minimum}` : "";
        const hi = s.maximum !== undefined ? `${s.maximum}` : "";
        label += ` (${lo}–${hi})`;
    }
    return label;
}

function defaultLabel(s: JsonSchema): string {
    if (s.default === undefined) return "—";
    return `\`${JSON.stringify(s.default)}\``;
}

function escapeCell(text: string): string {
    return text.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

/* */
function collectLeaves(schema: JsonSchema, prefix: string, rows: LeafRow[]): void {
    const props = schema.properties;
    if (!props || Object.keys(props).length === 0) {
        rows.push({
            path: prefix,
            type: typeLabel(schema),
            def: defaultLabel(schema),
            description: schema.description ?? "",
        });
        return;
    }
    for (const [key, child] of Object.entries(props)) {
        const childPath = prefix ? `${prefix}.${key}` : key;
        if (child.properties && Object.keys(child.properties).length > 0) {
            if (child.description) {
                rows.push({
                    path: childPath,
                    type: "object",
                    def: "—",
                    description: child.description,
                });
            }
            collectLeaves(child, childPath, rows);
        } else {
            rows.push({
                path: childPath,
                type: typeLabel(child),
                def: defaultLabel(child),
                description: child.description ?? "",
            });
        }
    }
}

const SECTION_ORDER: Array<{ keys: string[]; title: string; intro: string }> = [
    {
        keys: [
            "enabled",
            "allow_home_project",
            "language",
            "auto_update",
            "keep_subagents",
            "todowrite",
            "mural",
        ],
        title: "Top-level switches",
        intro: "Global on/off switches for the plugin and its agent-facing surface.",
    },
    {
        keys: ["prompt_surface"],
        title: "Prompt surface",
        intro: "Select the full or light built-in prompt preset. Model routes use the same progressive lookup walk as `cache_ttl`, with literal case-sensitive `provider/model` keys and the `provider/*` wildcard; guidance and tool-description overrides are user-level only.",
    },
    {
        keys: [
            "cache_ttl",
            "output_reserve",
            "execute_threshold_percentage",
            "execute_threshold_tokens",
            "protected_tags",
            "clear_reasoning_age",
            "history_budget_percentage",
        ],
        title: "Context management",
        intro: "When and how aggressively Magic Context manages the session's context window. Per-model keys accept `provider/model` map form where noted.",
    },
    {
        keys: ["historian", "historian_timeout_ms", "commit_cluster_trigger"],
        title: "Historian",
        intro: "The background agent that condenses old conversation into compact history.",
    },
    {
        keys: ["memory", "embedding"],
        title: "Memory & recall",
        intro: "Durable project memory, semantic search, and recall features.",
    },
    {
        keys: ["dreamer", "sidekick"],
        title: "Background agents",
        intro: "Off-hours maintenance (Dreamer) and on-demand prompt augmentation (Sidekick).",
    },
    {
        keys: [
            "temporal_awareness",
            "caveman_text_compression",
            "system_prompt_injection",
            "sqlite",
            "storage",
        ],
        title: "Advanced",
        intro: "Behavior tuning most installs never need to touch.",
    },
];

function renderTable(rows: LeafRow[]): string {
    const header = "| Key | Type | Default | Description |\n|---|---|---|---|";
    const body = rows
        .map(
            (r) =>
                `| \`${r.path}\` | ${escapeCell(r.type)} | ${escapeCell(r.def)} | ${escapeCell(r.description)} |`,
        )
        .join("\n");
    return `${header}\n${body}`;
}

// Public docs exclude developer-only keys even though the generated JSON Schema retains them.
const DEV_ONLY_KEYS = new Set<string>([
    "shadow_embedding",
    "transform_mode",
]);

export function buildConfigDocs(): string {
    const schema = buildSchema() as JsonSchema;
    const props = schema.properties ?? {};

    const covered = new Set<string>(["$schema", ...DEV_ONLY_KEYS]);
    const sections: string[] = [];

    for (const section of SECTION_ORDER) {
        const rows: LeafRow[] = [];
        for (const key of section.keys) {
            const child = props[key];
            if (!child) continue;
            covered.add(key);
            if (child.properties && Object.keys(child.properties).length > 0) {
                if (child.description) {
                    rows.push({
                        path: key,
                        type: "object",
                        def: "—",
                        description: child.description,
                    });
                }
                collectLeaves(child, key, rows);
            } else {
                rows.push({
                    path: key,
                    type: typeLabel(child),
                    def: defaultLabel(child),
                    description: child.description ?? "",
                });
            }
        }
        if (rows.length > 0) {
            sections.push(`## ${section.title}\n\n${section.intro}\n\n${renderTable(rows)}`);
        }
    }

    // The trailing section emits unassigned top-level schema keys so generated docs omit none.
    const uncovered = Object.keys(props).filter((k) => !covered.has(k));
    if (uncovered.length > 0) {
        const rows: LeafRow[] = [];
        for (const key of uncovered) {
            collectLeaves(props[key] as JsonSchema, key, rows);
        }
        sections.push(`## Other\n\n${renderTable(rows)}`);
    }

    return `---
title: Configuration
description: Every magic-context.jsonc key, with types, defaults, and where to put the file.
---

<!-- GENERATED FILE — do not edit. Source of truth is the Zod schema in
    packages/plugin/src/config/schema/magic-context.ts; regenerate with
    \`bun packages/plugin/scripts/build-config-docs.ts\`. -->

Magic Context reads \`magic-context.jsonc\` (or \`.json\`) from one shared CortexKit location across OpenCode, Pi, and OMP. Project config overrides user config, key by key. Prompt-surface routing is shared by all three harnesses; project config may select \`default\` and \`models\`, while \`guidance_override_path\` and \`tool_descriptions\` are stripped at the project trust boundary.

- **Project** — \`<project>/.cortexkit/magic-context.jsonc\`
- **User-wide** — \`~/.config/cortexkit/magic-context.jsonc\`

Upgrading from an earlier version moves your existing config here automatically on first run (a \`.MOVED_READPLEASE\` breadcrumb is left at the old per-harness path).

Add the schema line for editor validation and autocomplete:

\`\`\`jsonc
{
  "$schema": "https://raw.githubusercontent.com/ahrav/magic-context/main/assets/magic-context.schema.json"
}
\`\`\`

:::note
Project-level configs cannot use \`{env:VAR}\` / \`{file:path}\` expansion. A cloned repository also cannot set \`output_reserve\`, \`sqlite.*\`, \`storage.enforce_private_permissions\`, hidden-agent prompts/permissions, \`historian.model\`, or \`historian.fallback_models\`. Project \`execute_threshold_percentage\` / \`execute_threshold_tokens\` may only RAISE thresholds relative to the user's effective settings (a repo may delay compaction, not make it happen earlier). Dreamer model/schedule/task tuning and \`memory.enabled\` remain allowed project overrides.
:::

${sections.join("\n\n")}
`;
}

async function main() {
    const rootDir = path.resolve(import.meta.dir, "..", "..", "..");
    const outputPath = path.join(
        rootDir,
        "packages",
        "docs",
        "src",
        "content",
        "docs",
        "reference",
        "configuration.md",
    );
    await Bun.write(outputPath, buildConfigDocs());
    console.log(`✓ Config reference generated: ${outputPath}`);
}

if (import.meta.main) {
    void main();
}
