import { estimateTokens } from "./read-session-formatting";
import { byteSize } from "./tag-content-primitives";
import {
    stripChannel1ReminderSpans,
    type TailHygieneBaseline,
    type TailHygienePartMeasurement,
} from "./tail-hygiene-walk";

export type Channel1Level = "gentle" | "firm" | "urgent";

export interface ToolReclaimHint {
    tagNumber: number;
    toolName: string | null;
}

export interface Channel1State {
    baselineU: number;
    baselineT: number;
    turnDeltaU: number;
    turnDeltaT: number;
    baselineGeneration: number;
    computedAt: number;
    evaluable: boolean;
    generationInvalidated: boolean;
    baselineParts: TailHygienePartMeasurement[];
    contentSignature: string;
    reducedSinceRefresh: boolean;
    oldestReclaimableToolTags: ToolReclaimHint[];
}

export const CHANNEL1_SENTINEL = "<system-reminder>";
export const TOKENS_PER_BYTE = 0.25;
export const CHANNEL1_MIN_TOKENS = 60_000;
export const CHANNEL1_FLOOR_TOKENS = 25_000;
export const CHANNEL1_REFIRE_FLOOR_TOKENS = 25_000;
const S_GENTLE = 0.2;
const S_FIRM = 0.4;
const S_URGENT = 0.6;
const LEVEL_RANK: Record<Channel1Level, number> = { gentle: 1, firm: 2, urgent: 3 };
const DROP_SENTINELS = ["[dropped", "[truncated"];

export function channel1RefireTokens(tailTokens: number): number {
    const scaled = Math.round(0.08 * Math.max(0, tailTokens));
    return Math.max(CHANNEL1_REFIRE_FLOOR_TOKENS, scaled);
}

function isDroppedToolOutput(output: string): boolean {
    const head = output
        .trimStart()
        .replace(/^§\d+§\s*/, "")
        .slice(0, 16)
        .toLowerCase();
    return DROP_SENTINELS.some((sentinel) => head.startsWith(sentinel));
}

export function tailToolTokensFromStrings(outputs: readonly string[]): number {
    let bytes = 0;
    for (const output of outputs) {
        if (isDroppedToolOutput(output)) continue;
        bytes += byteSize(stripChannel1ReminderSpans(output));
    }
    return Math.round(bytes * TOKENS_PER_BYTE);
}

export function toolOutputTokens(output: string): number {
    return estimateTokens(stripChannel1ReminderSpans(output));
}

export interface TailTokenEstimate {
    tailToolTokens: number;
    liveTailTokens: number;
}

export interface Channel1Decision {
    fire: boolean;
    level: Channel1Level;
    undroppedTokens: number;
    tailTokens: number;
    severity: number;
    nextLastNudge: number;
    nextLastNudgeLevel: Channel1Level | "";
}

export function decideChannel1(input: {
    baselineU: number;
    baselineT: number;
    turnDeltaU: number;
    turnDeltaT: number;
    lastNudgeUndropped: number;
    lastNudgeLevel: Channel1Level | "";
    hasRecentReduce: boolean;
    evaluable?: boolean;
    generationInvalidated?: boolean;
}): Channel1Decision {
    const tailTokens = Math.max(0, input.baselineT + input.turnDeltaT);
    const undroppedTokens = Math.min(tailTokens, Math.max(0, input.baselineU + input.turnDeltaU));
    const severity = Math.min(1, Math.max(0, undroppedTokens / Math.max(tailTokens, 1)));
    const resetCycle = input.hasRecentReduce || undroppedTokens < input.lastNudgeUndropped;
    const lastNudge = resetCycle ? 0 : input.lastNudgeUndropped;
    const lastLevel = resetCycle ? "" : input.lastNudgeLevel;
    const quiet = (): Channel1Decision => ({
        fire: false,
        level: "gentle",
        undroppedTokens,
        tailTokens,
        severity,
        nextLastNudge: lastNudge,
        nextLastNudgeLevel: lastLevel,
    });

    if (input.evaluable === false || input.generationInvalidated === true) return quiet();
    if (input.hasRecentReduce) return quiet();
    if (tailTokens < CHANNEL1_MIN_TOKENS) return quiet();
    if (undroppedTokens < CHANNEL1_FLOOR_TOKENS || undroppedTokens === 0) return quiet();
    if (severity < S_GENTLE) return quiet();

    let level: Channel1Level;
    if (severity >= S_URGENT) level = "urgent";
    else if (severity >= S_FIRM) level = "firm";
    else level = "gentle";

    const escalated = lastLevel === "" || LEVEL_RANK[level] > LEVEL_RANK[lastLevel];
    const cadenceReached =
        lastLevel !== "" && undroppedTokens - lastNudge >= channel1RefireTokens(tailTokens);
    if (!escalated && !cadenceReached) return quiet();

    return {
        fire: true,
        level,
        undroppedTokens,
        tailTokens,
        severity,
        nextLastNudge: undroppedTokens,
        nextLastNudgeLevel: level,
    };
}

export const CHANNEL2_SEVERITY_THRESHOLD = 0.75;
export const CHANNEL2_FLOOR_TOKENS = 50_000;

export type Channel2PredicateBaseline = Pick<
    TailHygieneBaseline,
    "baselineU" | "baselineT" | "turnDeltaU" | "turnDeltaT" | "evaluable" | "generationInvalidated"
>;

export interface Channel2PredicateEvaluation {
    evaluable: boolean;
    shouldTrigger: boolean;
    reclaimableTokens: number;
    tailTokens: number;
    severity: number;
}

export function evaluateChannel2(
    input: Channel2PredicateBaseline | undefined,
): Channel2PredicateEvaluation {
    const values = input
        ? [input.baselineU, input.baselineT, input.turnDeltaU, input.turnDeltaT]
        : [];
    if (
        input?.evaluable !== true ||
        input.generationInvalidated === true ||
        values.some((value) => !Number.isFinite(value))
    ) {
        return {
            evaluable: false,
            shouldTrigger: false,
            reclaimableTokens: 0,
            tailTokens: 0,
            severity: 0,
        };
    }

    const tailTokens = Math.max(0, input.baselineT + input.turnDeltaT);
    const reclaimableTokens = Math.min(tailTokens, Math.max(0, input.baselineU + input.turnDeltaU));
    const severity = Math.min(1, Math.max(0, reclaimableTokens / Math.max(tailTokens, 1)));
    return {
        evaluable: true,
        shouldTrigger:
            tailTokens >= CHANNEL1_MIN_TOKENS &&
            reclaimableTokens >= CHANNEL2_FLOOR_TOKENS &&
            severity >= CHANNEL2_SEVERITY_THRESHOLD,
        reclaimableTokens,
        tailTokens,
        severity,
    };
}

function approxThousands(tokens: number): string {
    return `${Math.round(tokens / 1000)}k`;
}

function formatOldestReclaimableHint(hint?: readonly ToolReclaimHint[]): string {
    if (!hint || hint.length === 0) return "";
    const rendered = hint
        .slice(0, 4)
        .map((tag) => `§${tag.tagNumber}§ ${tag.toolName ?? "tool"}`)
        .join(" · ");
    return rendered.length > 0 ? `\noldest reclaimable: ${rendered}.` : "";
}

export function buildChannel2Reminder(
    undroppedTokens: number,
    hint?: readonly ToolReclaimHint[],
): string {
    const amount = approxThousands(undroppedTokens);
    const hintText = formatOldestReclaimableHint(hint);
    return (
        `<system-reminder>\n` +
        `Routine context housekeeping is near: a large span of this session will be comparted soon, ` +
        `and ~${amount} tokens of tool output remain unreduced. Drop spent outputs with ctx_reduce ` +
        `first so the archived span is the part that matters.${hintText}\n` +
        `</system-reminder>`
    );
}

export function buildChannel1Reminder(
    level: Channel1Level,
    undroppedTokens: number,
    hint?: readonly ToolReclaimHint[],
): string {
    const amount = approxThousands(undroppedTokens);
    const hintText = formatOldestReclaimableHint(hint);
    let body: string;
    switch (level) {
        case "gentle":
            body =
                `You have ~${amount} tokens of content you have not reduced. ` +
                `When you are done with earlier outputs, dropping them with ctx_reduce keeps context lean.`;
            break;
        case "firm":
            body =
                `~${amount} tokens of unreduced content has built up. ` +
                `At your next natural stopping point, consider dropping what you have already processed with ctx_reduce.`;
            break;
        case "urgent":
            body =
                `~${amount} tokens of unreduced content remain across most of the live tail. ` +
                `Consider dropping spent outputs with ctx_reduce so the archived span is the part that matters.`;
            break;
    }
    return `\n\n<system-reminder>\n${body}${hintText}\n</system-reminder>`;
}
