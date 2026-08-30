import { splitmix32 } from "../../../plugin/scripts/retrieval-benchmark/synthetic";
import {
    MAX_TRANSCRIPT_TURNS,
    normalizeContent,
    parseScenario,
    predicateMatches,
    type GoldExpectations,
    type HistorianEvalScenario,
    type TranscriptTurn,
} from "../historian-eval/contract";

export interface TurnTransform {
    applicable: true;
    scenario: HistorianEvalScenario;
    /** Original turn index to derivative turn index. */
    turnMap: number[];
}

export interface InapplicableTransform {
    applicable: false;
    reason: string;
}

export type TransformResult = TurnTransform | InapplicableTransform;

export interface Transform {
    id: string;
    version: number;
    alwaysApplicable: boolean;
    /** A rewritten turn is indistinguishable from a misplaced one, so admission
     * verifies `turnMap` against the transcript only when this is `true`. */
    preservesTurnText: boolean;
    apply(scenario: HistorianEvalScenario, seed: number): TransformResult;
}

interface EligibleMessage {
    turnIndex: number;
    role: "user" | "assistant";
    text: string;
}

function normalizedSeed(seed: number): number {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
        throw new Error("transform seed must be an unsigned 32-bit integer");
    }
    return seed >>> 0;
}

function pick<T>(values: readonly T[], next: () => number): T {
    return values[Math.floor(next() * values.length)]!;
}

export function remapGold(
    gold: GoldExpectations,
    turnMap: readonly number[],
): GoldExpectations {
    return {
        ...gold,
        expectedClaims: gold.expectedClaims.map((claim) => {
            const mapped = turnMap.slice(
                claim.sourceTurnRange[0],
                claim.sourceTurnRange[1] + 1,
            );
            if (mapped.length === 0 || mapped.some((index) => !Number.isInteger(index))) {
                throw new Error(`turn map does not cover ${claim.id}`);
            }
            const ordered = [...mapped].sort((left, right) => left - right);
            if (ordered.some((index, offset) => offset > 0 && index !== ordered[offset - 1]! + 1)) {
                throw new Error(`turn map produces non-contiguous source range for ${claim.id}`);
            }
            return {
                ...claim,
                sourceTurnRange: [ordered[0]!, ordered[ordered.length - 1]!],
            };
        }),
    };
}

function derivative(
    base: HistorianEvalScenario,
    transform: Pick<Transform, "id" | "version">,
    seed: number,
    turns: TranscriptTurn[],
    epilogueStartIndex: number,
    turnMap: number[],
): TurnTransform {
    const scenario = parseScenario({
        ...base,
        id: `${base.id}-d-${transform.id}-v${transform.version}-s${seed}`,
        transcript: { turns, epilogueStartIndex },
        gold: remapGold(base.gold, turnMap),
    });
    return { applicable: true, scenario, turnMap };
}

function protectedTurnIndexes(scenario: HistorianEvalScenario): Set<number> {
    const protectedIndexes = new Set<number>();
    for (const claim of scenario.gold.expectedClaims) {
        for (let index = claim.sourceTurnRange[0]; index <= claim.sourceTurnRange[1]; index += 1) {
            protectedIndexes.add(index);
        }
    }
    return protectedIndexes;
}

function eligibleMessages(scenario: HistorianEvalScenario): EligibleMessage[] {
    const protectedIndexes = protectedTurnIndexes(scenario);
    const absentPredicates = scenario.gold.expectedAbsent.map((absent) => absent.predicate);
    return scenario.transcript.turns.flatMap((turn, turnIndex) => {
        if (protectedIndexes.has(turnIndex)) return [];
        const turnText = `${turn.user}\n${turn.assistant}`;
        if (absentPredicates.some((predicate) => predicateMatches(predicate, turnText))) return [];
        return (["user", "assistant"] as const).map((role) => ({
            turnIndex,
            role,
            text: turn[role],
        }));
    });
}

function replaceMessage(
    turns: readonly TranscriptTurn[],
    message: EligibleMessage,
    text: string,
): TranscriptTurn[] {
    return turns.map((turn, index) =>
        index === message.turnIndex ? { ...turn, [message.role]: text } : { ...turn },
    );
}

function mapForOrder(order: readonly number[]): number[] {
    const turnMap = Array<number>(order.length);
    order.forEach((originalIndex, derivativeIndex) => {
        turnMap[originalIndex] = derivativeIndex;
    });
    return turnMap;
}

function preservesContiguousGold(scenario: HistorianEvalScenario, turnMap: readonly number[]): boolean {
    try {
        remapGold(scenario.gold, turnMap);
        return true;
    } catch {
        return false;
    }
}

const paraphraseIrrelevant: Transform = {
    id: "paraphrase-irrelevant",
    version: 1,
    alwaysApplicable: true,
    preservesTurnText: false,
    apply(scenario, rawSeed) {
        const seed = normalizedSeed(rawSeed);
        const candidates = eligibleMessages(scenario);
        if (candidates.length === 0) {
            return { applicable: false, reason: "no irrelevant message to paraphrase" };
        }
        const next = splitmix32(seed);
        const message = pick(candidates, next);
        const rewrites = [
            (text: string) => `For context, ${text.charAt(0).toLowerCase()}${text.slice(1)}`,
            (text: string) => `${text} This is background context only.`,
            (text: string) => `As background: ${text}`,
        ];
        const text = pick(rewrites, next)(message.text);
        const turnMap = scenario.transcript.turns.map((_, index) => index);
        return derivative(
            scenario,
            this,
            seed,
            replaceMessage(scenario.transcript.turns, message, text),
            scenario.transcript.epilogueStartIndex,
            turnMap,
        );
    },
};

const reorderIndependentTurns: Transform = {
    id: "reorder-independent-turns",
    version: 1,
    alwaysApplicable: false,
    preservesTurnText: true,
    apply(scenario, rawSeed) {
        const seed = normalizedSeed(rawSeed);
        const expectedIndexes = protectedTurnIndexes(scenario);
        const absentIndexes = new Set(
            scenario.transcript.turns.flatMap((turn, index) => {
                const text = `${turn.user}\n${turn.assistant}`;
                return scenario.gold.expectedAbsent.some((absent) => predicateMatches(absent.predicate, text))
                    ? [index]
                    : [];
            }),
        );
        const candidates = Array.from(
            { length: scenario.transcript.epilogueStartIndex - 1 },
            (_, index) => [index, index + 1] as const,
        ).filter(([left, right]) => {
            const crossesProposalDecision =
                (absentIndexes.has(left) && expectedIndexes.has(right)) ||
                (expectedIndexes.has(left) && absentIndexes.has(right));
            if (crossesProposalDecision) return false;
            const rangeSafe = scenario.gold.expectedClaims.every(
                (claim) =>
                    claim.sourceTurnRange[1] < left ||
                    claim.sourceTurnRange[0] > right ||
                    claim.sourceTurnRange[0] === claim.sourceTurnRange[1],
            );
            if (!rangeSafe) return false;
            const order = scenario.transcript.turns.map((_, index) => index);
            [order[left], order[right]] = [order[right]!, order[left]!];
            return preservesContiguousGold(scenario, mapForOrder(order));
        });
        if (candidates.length === 0) {
            return { applicable: false, reason: "no independent adjacent turns before epilogue" };
        }
        const [left, right] = pick(candidates, splitmix32(seed));
        const order = scenario.transcript.turns.map((_, index) => index);
        [order[left], order[right]] = [order[right]!, order[left]!];
        return derivative(
            scenario,
            this,
            seed,
            order.map((index) => ({ ...scenario.transcript.turns[index]! })),
            scenario.transcript.epilogueStartIndex,
            mapForOrder(order),
        );
    },
};

const moveAcceptedDecision: Transform = {
    id: "move-accepted-decision",
    version: 1,
    alwaysApplicable: false,
    preservesTurnText: true,
    apply(scenario, rawSeed) {
        const seed = normalizedSeed(rawSeed);
        const sources = [
            ...new Set(
                scenario.gold.expectedClaims
                    .filter(
                        (claim) =>
                            claim.sourceTurnRange[0] === claim.sourceTurnRange[1] &&
                            claim.sourceTurnRange[0] < scenario.transcript.epilogueStartIndex - 1,
                    )
                    .map((claim) => claim.sourceTurnRange[0]),
            ),
        ];
        const candidates = sources.flatMap((source) =>
            Array.from(
                { length: scenario.transcript.epilogueStartIndex - 1 - source },
                (_, offset) => {
                    const order = scenario.transcript.turns.map((_, index) => index);
                    const [moved] = order.splice(source, 1);
                    order.splice(source + offset + 1, 0, moved!);
                    return { source, order };
                },
            ).filter(({ order }) => preservesContiguousGold(scenario, mapForOrder(order))),
        );
        if (candidates.length === 0) {
            return {
                applicable: false,
                reason: "no movable single-turn accepted decision before epilogue",
            };
        }
        const next = splitmix32(seed);
        const { order } = pick(candidates, next);
        return derivative(
            scenario,
            this,
            seed,
            order.map((index) => ({ ...scenario.transcript.turns[index]! })),
            scenario.transcript.epilogueStartIndex,
            mapForOrder(order),
        );
    },
};

const duplicateRejectedProposal: Transform = {
    id: "duplicate-rejected-proposal",
    version: 1,
    alwaysApplicable: false,
    preservesTurnText: true,
    apply(scenario, rawSeed) {
        const seed = normalizedSeed(rawSeed);
        if (scenario.transcript.turns.length >= MAX_TRANSCRIPT_TURNS) {
            return { applicable: false, reason: "transcript is already at the turn limit" };
        }
        const rejected = scenario.gold.expectedAbsent.filter(
            (absent) => absent.family === "proposed-but-rejected",
        );
        const protectedIndexes = protectedTurnIndexes(scenario);
        const candidates = scenario.transcript.turns.flatMap((turn, turnIndex) => {
            if (turnIndex >= scenario.transcript.epilogueStartIndex) return [];
            if (protectedIndexes.has(turnIndex)) return [];
            const text = `${turn.user}\n${turn.assistant}`;
            if (!rejected.some((absent) => predicateMatches(absent.predicate, text))) return [];
            const insertion = turnIndex + 1;
            const turnMap = scenario.transcript.turns.map((_, index) =>
                index < insertion ? index : index + 1,
            );
            return preservesContiguousGold(scenario, turnMap) ? [turnIndex] : [];
        });
        if (candidates.length === 0) {
            return {
                applicable: false,
                reason: rejected.length === 0
                    ? "no rejected proposal turn"
                    : "no rejected proposal insertion preserves contiguous gold ranges",
            };
        }
        const source = pick(candidates, splitmix32(seed));
        const insertion = source + 1;
        const turns = scenario.transcript.turns.map((turn) => ({ ...turn }));
        turns.splice(insertion, 0, { ...scenario.transcript.turns[source]! });
        const turnMap = scenario.transcript.turns.map((_, index) =>
            index < insertion ? index : index + 1,
        );
        return derivative(
            scenario,
            this,
            seed,
            turns,
            scenario.transcript.epilogueStartIndex +
                (insertion <= scenario.transcript.epilogueStartIndex ? 1 : 0),
            turnMap,
        );
    },
};

const SYMBOL_RE = /`([^`]+)`|\b(?:[A-Za-z][A-Za-z0-9]*(?:[_./-][A-Za-z0-9_.-]+)+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z]{2,})\b/g;

const renameUnrelatedSymbols: Transform = {
    id: "rename-unrelated-symbols",
    version: 1,
    alwaysApplicable: false,
    preservesTurnText: false,
    apply(scenario, rawSeed) {
        const seed = normalizedSeed(rawSeed);
        const messages = eligibleMessages(scenario);
        const candidates = [
            ...new Set(messages.flatMap((message) =>
                [...message.text.matchAll(SYMBOL_RE)].map((match) => match[1] ?? match[0])
            )),
        ];
        if (candidates.length === 0) {
            return { applicable: false, reason: "no unrelated symbol to rename" };
        }
        const next = splitmix32(seed);
        const original = pick(candidates, next);
        const existing = new Set(scenario.transcript.turns.flatMap((turn) =>
            [turn.user, turn.assistant].flatMap((text) =>
                [...text.matchAll(SYMBOL_RE)].map((match) => match[1] ?? match[0])
            )
        ));
        const replacementStart = Math.floor(next() * 10_000);
        let replacement: string | undefined;
        for (let offset = 0; offset < 10_000; offset += 1) {
            const candidate = `aux_symbol_${(replacementStart + offset) % 10_000}`;
            if (candidate !== original && !existing.has(candidate)) {
                replacement = candidate;
                break;
            }
        }
        if (replacement === undefined) {
            return { applicable: false, reason: "no unused replacement symbol" };
        }
        const turns = scenario.transcript.turns.map((turn) => ({ ...turn }));
        for (const message of messages) {
            turns[message.turnIndex]![message.role] = message.text.replace(
                SYMBOL_RE,
                (matched, quoted: string | undefined) => {
                    if ((quoted ?? matched) !== original) return matched;
                    return quoted === undefined ? replacement : `\`${replacement}\``;
                },
            );
        }
        const turnMap = scenario.transcript.turns.map((_, index) => index);
        return derivative(
            scenario,
            this,
            seed,
            turns,
            scenario.transcript.epilogueStartIndex,
            turnMap,
        );
    },
};

export const TRANSFORMS: readonly Transform[] = [
    paraphraseIrrelevant,
    reorderIndependentTurns,
    moveAcceptedDecision,
    duplicateRejectedProposal,
    renameUnrelatedSymbols,
];

export const ALWAYS_APPLICABLE_TRANSFORM_IDS: readonly string[] = TRANSFORMS.filter(
    (transform) => transform.alwaysApplicable,
).map((transform) => transform.id);
