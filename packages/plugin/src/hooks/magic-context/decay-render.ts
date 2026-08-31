/**
 *
 * Responsibilities:
 * Legacy compartments use flat `content` and start at P3 when `content` has a line beginning `U:`, otherwise P4.
 *    truncated `content`.
 * The renderer demotes the oldest compartments first when rendered output exceeds the token budget.
 * Demotion protects against token-estimate drift.
 *
 * The renderer never emits `<session_facts>`.
 */

import { computeBudgetPressure, renderedTier, TIER_COST, type Tier } from "./decay-curve";
import { estimateTokens } from "./read-session-formatting";

/* */
export const DEFAULT_HISTORY_BUDGET_TOKENS = 60_000;

/* */
export interface DecayRenderCompartment {
    startMessage: number;
    endMessage: number;
    title: string;
    content: string;
    startDate?: string | null;
    endDate?: string | null;
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    importance?: number | null;
    legacy?: number | null;
}

function escapeXmlContent(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatDateRange(startDate?: string | null, endDate?: string | null): string {
    if (!startDate || !endDate) return "";
    if (startDate === endDate) return startDate;
    if (startDate.slice(0, 7) === endDate.slice(0, 7)) return `${startDate}→${endDate.slice(8)}`;
    return `${startDate}→${endDate}`;
}

function sanitizeCompartmentTitle(title: string): string {
    // `sanitizeCompartmentTitle` collapses `Cc`, line-separator, and paragraph-separator runs to prevent multiline-heading forgery.
    return escapeXmlContent(title.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " "));
}

function compartmentHeading(c: DecayRenderCompartment): string {
    const dateRange = formatDateRange(c.startDate, c.endDate);
    const dateSegment = dateRange ? ` · ${dateRange}` : "";
    return `## ${c.startMessage}-${c.endMessage}${dateSegment} · ${sanitizeCompartmentTitle(c.title)}`;
}

function guardCompartmentBody(body: string): string {
    // `guardCompartmentBody` indents body lines beginning with `## ` so only unindented headings delimit compartments.
    return body.replace(/^## /gm, " ## ");
}

/**
 * The renderer uses flat `content`, not a tier body, when `p1` is empty or null.
 * A tiered row may have an empty `p4`; render it as a title-only heading.
 */
function isTieredRow(c: DecayRenderCompartment): boolean {
    return typeof c.p1 === "string" && c.p1.length > 0;
}

/* */
function tierBody(c: DecayRenderCompartment, tier: number): string {
    const tiers = [c.p1, c.p2, c.p3, c.p4];
    const requested = tiers[tier - 1];
    if (typeof requested === "string") return requested.trim();
    for (let i = tier - 2; i >= 0; i--) {
        const t = tiers[i];
        if (typeof t === "string" && t.length > 0) return t.trim();
    }
    return (c.content ?? "").trim();
}

/* */
function legacyBodyForTier(content: string, tier: number): string {
    if (tier <= 1) return content;
    if (tier === 2)
        return content.length > 1_200 ? `${content.slice(0, 1_200).trimEnd()}…` : content;
    return content.length > 420 ? `${content.slice(0, 420).trimEnd()}…` : content;
}

/* */
function legacyTier(c: DecayRenderCompartment): Tier {
    return /^U:/m.test(c.content) ? 3 : 4;
}

/**
 * The decay curve assigns P1 to the newest compartment without decay.
 */
export function renderCompartmentAtTier(c: DecayRenderCompartment, tier: number): string {
    return renderOneCompartment(c, tier);
}

function renderOneCompartment(c: DecayRenderCompartment, tier: number): string {
    if (tier >= 5) return ""; // archived
    const heading = compartmentHeading(c);

    if (c.legacy === 1 || !isTieredRow(c)) {
        const flat = (c.content ?? "").trim();
        if (tier >= 4 || flat.length === 0) return heading;
        const body = guardCompartmentBody(escapeXmlContent(legacyBodyForTier(flat, tier)));
        return `${heading}\n${body}`;
    }

    const body = tierBody(c, tier);
    if (body.length === 0) return heading;
    return `${heading}\n${guardCompartmentBody(escapeXmlContent(body))}`;
}

/**
 * The decay curve indexes chronological `compartments` from newest (`1`).
 * `compartments` are ordered oldest first.
 */
function computeTiers(
    compartments: DecayRenderCompartment[],
    historyBudgetTokens: number,
): number[] {
    const v2Compartments = compartments
        .map((c, originalIndex) => ({ c, originalIndex }))
        .filter(({ c }) => c.legacy !== 1);
    const v2Total = v2Compartments.length;
    const v2IndexByOriginalIndex = new Map<number, number>();

    // Legacy rows do not contribute to the decay curve, so they cannot demote v2 paraphrases in mixed sessions.
    const curveInputs = v2Compartments.map(({ c, originalIndex }, v2Ordinal) => {
        const curveIndex = v2Total - v2Ordinal; // 1-based from newest v2 row
        v2IndexByOriginalIndex.set(originalIndex, curveIndex);
        return {
            index: curveIndex,
            importance: Math.max(1, Math.min(100, c.importance ?? 50)),
        };
    });
    const pressure =
        historyBudgetTokens > 0 ? computeBudgetPressure(curveInputs, historyBudgetTokens) : 1;

    return compartments.map((c, index) => {
        if (c.legacy === 1) return legacyTier(c);
        return renderedTier(
            v2IndexByOriginalIndex.get(index) ?? 1,
            c.importance ?? 50,
            pressure,
            0,
        );
    });
}

/**
 * The renderer returns the joined compartment body without a `<session-history>` wrapper.
 */
export function renderDecayedCompartments(args: {
    compartments: DecayRenderCompartment[];
    historyBudgetTokens: number;
}): string {
    const { compartments, historyBudgetTokens } = args;
    if (compartments.length === 0) return "";

    const tiers = computeTiers(compartments, historyBudgetTokens);
    const renderedByTier = compartments.map(() => new Array<string | undefined>(6));
    const tokensByTier = compartments.map(() => new Array<number | undefined>(6));

    const renderedAt = (index: number, tier: number): string => {
        const cached = renderedByTier[index][tier];
        if (cached !== undefined) return cached;
        const rendered = renderOneCompartment(compartments[index], tier);
        renderedByTier[index][tier] = rendered;
        return rendered;
    };
    const tokensAt = (index: number, tier: number): number => {
        const cached = tokensByTier[index][tier];
        if (cached !== undefined) return cached;
        const rendered = renderedAt(index, tier);
        const tokens = rendered.length === 0 ? 0 : estimateTokens(rendered);
        tokensByTier[index][tier] = tokens;
        return tokens;
    };
    const render = (): string => {
        const parts: string[] = [];
        for (let i = 0; i < compartments.length; i++) {
            const rendered = renderedAt(i, tiers[i]);
            if (rendered.length > 0) parts.push(rendered);
        }
        return parts.join("\n\n");
    };

    let body = render();
    if (historyBudgetTokens <= 0) return body;

    // The final joined-body check accounts for separator and boundary tokenization costs.
    let runningTokens = 0;
    for (let i = 0; i < tiers.length; i++) {
        runningTokens += tokensAt(i, tiers[i]);
    }

    let guard = compartments.length * 5;
    let oldestDemotableIndex = 0;
    const demoteOldest = (): boolean => {
        while (oldestDemotableIndex < tiers.length && tiers[oldestDemotableIndex] >= 5) {
            oldestDemotableIndex += 1;
        }
        if (oldestDemotableIndex >= tiers.length) return false;

        const index = oldestDemotableIndex;
        const previousTier = tiers[index];
        const nextTier = previousTier + 1;
        runningTokens += tokensAt(index, nextTier) - tokensAt(index, previousTier);
        tiers[index] = nextTier;
        return true;
    };

    while (runningTokens > historyBudgetTokens && guard > 0) {
        if (!demoteOldest()) break;
        guard -= 1;
    }

    body = render();
    let exactTokens = estimateTokens(body);
    while (exactTokens > historyBudgetTokens && guard > 0) {
        if (!demoteOldest()) break;
        guard -= 1;
        body = render();
        exactTokens = estimateTokens(body);
    }
    return body;
}

/**
 * The extractor uses the top-level `m[0]` block for budget measurement and token attribution.
 * `tag` must be a literal block name.
 *
 * Both render harnesses use identical block slices so token budgets and attribution match rendered blocks.
 */
export function extractM0Block(m0Text: string, tag: string): string | null {
    const m = m0Text.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`));
    return m ? m[0] : null;
}

export { TIER_COST };
