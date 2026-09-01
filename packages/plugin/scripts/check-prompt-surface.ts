#!/usr/bin/env bun
/**
 * The script validates the prompt-surface checklist and fragment-composition map.
 * The validator derives applicability from each source fragment's `composedIn` and `sharedAcrossPresets` values, not from row status.
 * With `--budget`, the command also validates the budget fixture.
 *
 * Usage:
 *   bun packages/plugin/scripts/check-prompt-surface.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildMagicContextSection } from "../src/agents/magic-context-prompt";
import { validateBudgetFixture } from "./prompt-surface-fixture";
import { builtInLightSurface, type LightSurfaceInput } from "./prompt-surface-measurement";

const rootDir = resolve(import.meta.dir, "../../..");
const checklistPath = resolve(rootDir, "docs/specs/prompt-surface/checklist.json");
const budgetFixturePath = resolve(rootDir, "docs/specs/prompt-surface/budget-fixture.json");
const lightMappingPath = resolve(rootDir, "docs/specs/prompt-surface/light-mapping.md");
const VALID_STATUSES = new Set(["compressed", "shared", "not-present"]);

type Checklist = {
    status?: string;
    mappingStatus?: string;
    variants?: Record<string, { kind?: string }>;
    fragments?: Record<string, {
        source?: { file?: string; evidence?: string };
        sharedAcrossPresets?: boolean;
        composedIn?: string[];
        statusByVariant?: Record<string, string>;
    }>;
    requiredRuleIds?: string[];
    rules?: Array<{
        id?: string;
        title?: string;
        sourceFragment?: string;
        scope?: string;
        polarity?: string;
        operativeCondition?: string;
        mechanism?: string;
        consequence?: string;
        evidence?: string;
    }>;
};

export interface ChecklistValidationResult {
    errors: string[];
    messages: string[];
}

export interface ChecklistValidationOptions {
    mappingPath?: string;
    lightAssets?: Readonly<Record<string, string>>;
}

interface LightMappingRow {
    id: string;
    asset: string;
    line: string;
    quote: string;
}

export function builtInLightMappingAssets(
    surface: LightSurfaceInput = builtInLightSurface(),
): Record<string, string> {
    return {
        "guidance:primary": surface.guidance,
        "guidance:no-reduce": buildMagicContextSection(
            null,
            20,
            false,
            true,
            true,
            false,
            false,
            undefined,
            true,
            "light",
        ),
        "guidance:subagent": buildMagicContextSection(
            null,
            20,
            true,
            false,
            false,
            false,
            true,
            undefined,
            false,
            "light",
        ),
        ...Object.fromEntries(
            Object.entries(surface.descriptions).map(([id, text]) => [`tool:${id}`, text ?? ""]),
        ),
    };
}

function readLightMapping(path: string): LightMappingRow[] {
    return readFileSync(path, "utf8")
        .split(/\r?\n/)
        .flatMap((rawLine) => {
            const line = rawLine.trim();
            if (!line.startsWith("|") || !line.endsWith("|")) return [];
            const columns = line
                .slice(1, -1)
                .split("|")
                .map((column) => column.trim());
            if (columns.length !== 4 || !/^[GT]-\d{3}$/.test(columns[0] ?? "")) return [];
            return [
                {
                    id: columns[0] ?? "",
                    asset: columns[1] ?? "",
                    line: columns[2] ?? "",
                    quote: columns[3] ?? "",
                },
            ];
        });
}

function readChecklist(path = checklistPath): Checklist {
    return JSON.parse(readFileSync(path, "utf8")) as Checklist;
}

export function validateChecklist(
    path = checklistPath,
    options: ChecklistValidationOptions = {},
): ChecklistValidationResult {
    const checklist = readChecklist(path);
    const errors: string[] = [];
    const messages: string[] = [];
    const variants = checklist.variants ?? {};
    const fragments = checklist.fragments ?? {};
    const rules = checklist.rules ?? [];
    const requiredIds = checklist.requiredRuleIds ?? [];

    if (checklist.mappingStatus !== "PRE-LIGHT-AUTHORING") {
        errors.push("the ratified checklist mappingStatus must remain PRE-LIGHT-AUTHORING; S3 mapping is a separate artifact");
    }
    if (new Set(requiredIds).size !== requiredIds.length) {
        errors.push("requiredRuleIds contains duplicates");
    }
    const ruleIds = rules.map((rule) => rule.id ?? "");
    if (new Set(ruleIds).size !== ruleIds.length) {
        errors.push("checklist rules contain duplicate IDs");
    }
    const missingRules = requiredIds.filter((id) => !ruleIds.includes(id));
    const unexpectedRules = ruleIds.filter((id) => !requiredIds.includes(id));
    if (missingRules.length > 0) errors.push(`checklist entries missing: ${missingRules.join(", ")}`);
    if (unexpectedRules.length > 0) errors.push(`checklist entries not designated in requiredRuleIds: ${unexpectedRules.join(", ")}`);

    const variantIds = Object.keys(variants);
    if (variantIds.length === 0) errors.push("fragment-to-variant composition map has no variants");
    const referencedFragmentIds = new Set(
        rules.flatMap((rule) => (rule.sourceFragment ? [rule.sourceFragment] : [])),
    );
    for (const fragmentId of Object.keys(fragments)) {
        if (!referencedFragmentIds.has(fragmentId)) {
            errors.push(`fragment ${fragmentId} is not referenced by any checklist rule`);
        }
    }
    const sourceTextCache = new Map<string, string>();
    for (const [fragmentId, fragment] of Object.entries(fragments)) {
        if (!fragment.source?.file || !fragment.source.evidence) {
            errors.push(`fragment ${fragmentId} is missing source file or evidence`);
            continue;
        }
        const sourcePath = resolve(rootDir, fragment.source.file);
        try {
            let source = sourceTextCache.get(sourcePath);
            if (!source) {
                source = readFileSync(sourcePath, "utf8");
                sourceTextCache.set(sourcePath, source);
            }
            if (!source.includes(fragment.source.evidence)) {
                errors.push(`fragment ${fragmentId} source evidence is stale: ${fragment.source.file}`);
            }
        } catch {
            errors.push(`fragment ${fragmentId} source file is unreadable: ${fragment.source.file}`);
        }

        const composedIn = new Set(fragment.composedIn ?? []);
        const statuses = fragment.statusByVariant ?? {};
        if (JSON.stringify(Object.keys(statuses).sort()) !== JSON.stringify([...variantIds].sort())) {
            errors.push(`fragment ${fragmentId} does not map every variant exactly once`);
        }
        for (const variantId of variantIds) {
            const expected = composedIn.has(variantId)
                ? fragment.sharedAcrossPresets === true
                    ? "shared"
                    : "compressed"
                : "not-present";
            const actual = statuses[variantId];
            if (!VALID_STATUSES.has(actual)) {
                errors.push(`fragment ${fragmentId}/${variantId} has invalid status ${actual}`);
            } else if (actual !== expected) {
                errors.push(`fragment ${fragmentId}/${variantId} disagrees with composition: declared=${actual}, derived=${expected}`);
            }
        }
        for (const variantId of composedIn) {
            if (!variants[variantId]) errors.push(`fragment ${fragmentId} references unknown variant ${variantId}`);
        }
    }

    const statuses = { compressed: 0, shared: 0, "not-present": 0 };
    for (const rule of rules) {
        const requiredFields = [
            "id",
            "title",
            "sourceFragment",
            "scope",
            "polarity",
            "operativeCondition",
            "mechanism",
            "consequence",
            "evidence",
        ] as const;
        for (const field of requiredFields) {
            if (!rule[field] || rule[field]?.trim() === "") errors.push(`rule ${rule.id ?? "<missing>"} is missing ${field}`);
        }
        const fragment = rule.sourceFragment ? fragments[rule.sourceFragment] : undefined;
        if (!fragment) {
            errors.push(`rule ${rule.id ?? "<missing>"} references unknown fragment ${rule.sourceFragment}`);
            continue;
        }
        const sourcePath = fragment.source?.file ? resolve(rootDir, fragment.source.file) : "";
        const source = sourceTextCache.get(sourcePath) ?? "";
        if (rule.evidence && !source.includes(rule.evidence)) {
            errors.push(`rule ${rule.id} evidence is stale: ${rule.evidence}`);
        }
        for (const variantId of variantIds) {
            const status = fragment.statusByVariant?.[variantId];
            if (!status || !VALID_STATUSES.has(status)) {
                errors.push(`rule ${rule.id}/${variantId} has no derived applicability status`);
            } else {
                statuses[status as keyof typeof statuses] += 1;
            }
        }
    }

    const expectedMappedIds = rules
        .filter((rule) => {
            const fragment = rule.sourceFragment ? fragments[rule.sourceFragment] : undefined;
            return Object.values(fragment?.statusByVariant ?? {}).includes("compressed");
        })
        .map((rule) => rule.id ?? "");
    let mappingRows: LightMappingRow[] = [];
    try {
        mappingRows = readLightMapping(options.mappingPath ?? lightMappingPath);
    } catch {
        errors.push(`light mapping is unreadable: ${options.mappingPath ?? lightMappingPath}`);
    }
    const mappedIds = mappingRows.map((row) => row.id);
    const duplicateMappedIds = mappedIds.filter((id, index) => mappedIds.indexOf(id) !== index);
    if (duplicateMappedIds.length > 0) {
        errors.push(`light mapping contains duplicate checklist IDs: ${[...new Set(duplicateMappedIds)].join(", ")}`);
    }
    const missingMappedIds = expectedMappedIds.filter((id) => !mappedIds.includes(id));
    const unexpectedMappedIds = mappedIds.filter((id) => !expectedMappedIds.includes(id));
    if (missingMappedIds.length > 0) {
        errors.push(`compressed checklist entries missing light mappings: ${missingMappedIds.join(", ")}`);
    }
    if (unexpectedMappedIds.length > 0) {
        errors.push(`light mappings target non-compressed checklist entries: ${unexpectedMappedIds.join(", ")}`);
    }

    const lightAssets = options.lightAssets ?? builtInLightMappingAssets();
    for (const row of mappingRows) {
        if (!row.line || !/^L-[A-Z0-9-]+$/.test(row.line)) {
            errors.push(`light mapping ${row.id} has invalid named line ${row.line || "<missing>"}`);
        }
        if (!row.quote) {
            errors.push(`light mapping ${row.id}/${row.line} has an empty exact quote`);
            continue;
        }
        const asset = lightAssets[row.asset];
        if (asset === undefined) {
            errors.push(`light mapping ${row.id} references unknown asset ${row.asset}`);
            continue;
        }
        if (!asset.split(/\r?\n/).includes(row.quote)) {
            errors.push(`light mapping ${row.id}/${row.line} quote does not resolve as an exact line in ${row.asset}`);
        }
    }

    messages.push(`checked ${rules.length} checklist entries across ${variantIds.length} composed variants`);
    messages.push(`derived applicability: compressed=${statuses.compressed}, shared=${statuses.shared}, not-present=${statuses["not-present"]}`);
    messages.push(`resolved ${mappingRows.length} compressed-rule rows to named exact light lines; shared rows remain byte-identical and not-present rows remain absent`);
    if (errors.length === 0) messages.unshift("checklist completeness and source mapping passed");
    return { errors, messages };
}

if (import.meta.main) {
    const budgetMode = process.argv.includes("--budget");
    try {
        const checklist = validateChecklist();
        for (const message of checklist.messages) console.log(message);
        const errors = [...checklist.errors];
        if (budgetMode) {
            const budget = validateBudgetFixture({ fixturePath: budgetFixturePath });
            for (const message of budget.messages) console.log(message);
            errors.push(...budget.errors);
        }
        for (const error of errors) console.error(`ERROR: ${error}`);
        process.exitCode = errors.length > 0 ? 1 : 0;
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
