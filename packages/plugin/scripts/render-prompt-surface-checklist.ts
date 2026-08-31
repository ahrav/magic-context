#!/usr/bin/env bun
/* */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Checklist = {
    artifactId: string;
    revision: string;
    status: string;
    mappingStatus: string;
    sourceAuthority: string[];
    variants: Record<string, { kind: string; features: Record<string, boolean> }>;
    fragments: Record<string, { statusByVariant: Record<string, string>; asymmetryNote?: string }>;
    rules: Array<{
        id: string;
        title: string;
        sourceFragment: string;
        scope: string;
        polarity: string;
        operativeCondition: string;
        mechanism: string;
        consequence: string;
        evidence: string;
        asymmetry?: string;
    }>;
};

const rootDir = resolve(import.meta.dir, "../../..");
const checklistPath = resolve(rootDir, "docs/specs/prompt-surface/checklist.json");
const outputPath = resolve(rootDir, "docs/specs/prompt-surface/load-bearing-rules-checklist.md");

function cell(value: string): string {
    return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderChecklist(checklist: Checklist): string {
    const variantIds = Object.keys(checklist.variants);
    const out: string[] = [
        "# Load-bearing rules checklist",
        "",
        `Artifact: \`${checklist.artifactId}\` · revision \`${checklist.revision}\` · status **${checklist.status}**`,
        "",
        `Mapping status: **${checklist.mappingStatus}**. This is the pre-light extraction required before S3 authorship. ` +
            "`compressed` rows are intentionally awaiting exact light-line targets; `shared` rows name byte-identity fragments; `not-present` rows are derived source absences.",
        "",
        "## Authority and composition variants",
        "",
        ...checklist.sourceAuthority.map((source) => `- \`${source}\``),
        "",
        "| Variant | Kind | Feature flags |",
        "| --- | --- | --- |",
        ...variantIds.map((id) => `| \`${id}\` | ${checklist.variants[id].kind} | ${cell(JSON.stringify(checklist.variants[id].features))} |`),
        "",
        "Applicability is calculated from the fragment's `composedIn`/`statusByVariant` map in `checklist.json`. The checker rejects a status that disagrees with that composition map.",
        "",
        "## Stable rules",
        "",
    ];

    for (const rule of checklist.rules) {
        const fragment = checklist.fragments[rule.sourceFragment];
        out.push(`### ${rule.id} — ${rule.title}`);
        out.push("");
        out.push(`- **Source fragment:** \`${rule.sourceFragment}\``);
        out.push(`- **Scope:** ${rule.scope}`);
        out.push(`- **Polarity:** ${rule.polarity}`);
        out.push(`- **Operative condition:** ${rule.operativeCondition}`);
        out.push(`- **Mechanism:** ${rule.mechanism}`);
        out.push(`- **Consequence:** ${rule.consequence}`);
        out.push(`- **Source evidence:** \`${rule.evidence}\``);
        if (rule.asymmetry) out.push(`- **Asymmetry:** ${rule.asymmetry}`);
        if (fragment.asymmetryNote) out.push(`- **Fragment note:** ${fragment.asymmetryNote}`);
        out.push("");
        out.push("| Variant | Applicability status |");
        out.push("| --- | --- |");
        for (const variantId of variantIds) {
            out.push(`| \`${variantId}\` | **${fragment.statusByVariant[variantId]}** |`);
        }
        out.push("");
    }

    out.push("## Review notes");
    out.push("");
    out.push("- The `[dropped §N§]` imitation prohibition is deliberately listed as `G-030` with `compressed` only for `subagent-reduce`; primary variants are `not-present` for this exact SUBAGENT_REDUCE_INTRO clause.");
    out.push("- Tool descriptions are included as load-bearing contract/mechanism rules, with active and memory-disabled tool compositions represented separately.");
    out.push("- No light prose is authored by this artifact. S3 must replace pending compressed targets with exact light lines after ratification.");
    out.push("");
    return `${out.join("\n").trimEnd()}\n`;
}

if (import.meta.main) {
    const checklist = JSON.parse(readFileSync(checklistPath, "utf8")) as Checklist;
    writeFileSync(outputPath, renderChecklist(checklist));
    console.log(`written: ${outputPath}`);
}
