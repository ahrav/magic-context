import { splitmix32 } from "../../../plugin/scripts/retrieval-benchmark/synthetic";
import {
    MAX_TRANSCRIPT_TURNS,
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
        // Do not rewrite either message when only their combined text matches:
        // changing either message can make the combined text stop matching.
        const spansRoles = absentPredicates.some(
            (predicate) =>
                predicateMatches(predicate, `${turn.user}\n${turn.assistant}`) &&
                !predicateMatches(predicate, turn.user) &&
                !predicateMatches(predicate, turn.assistant),
        );
        if (spansRoles) return [];
        return (["user", "assistant"] as const).flatMap((role) => {
            const text = turn[role];
            return absentPredicates.some((predicate) => predicateMatches(predicate, text))
                ? []
                : [{ turnIndex, role, text }];
        });
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
        ).flatMap(([left, right]) => {
            const crossesProposalDecision =
                (absentIndexes.has(left) && expectedIndexes.has(right)) ||
                (expectedIndexes.has(left) && absentIndexes.has(right));
            if (crossesProposalDecision) return [];
            const rangeSafe = scenario.gold.expectedClaims.every(
                (claim) =>
                    claim.sourceTurnRange[1] < left ||
                    claim.sourceTurnRange[0] > right ||
                    claim.sourceTurnRange[0] === claim.sourceTurnRange[1],
            );
            if (!rangeSafe) return [];
            const order = scenario.transcript.turns.map((_, index) => index);
            [order[left], order[right]] = [order[right]!, order[left]!];
            return preservesContiguousGold(scenario, mapForOrder(order)) ? [order] : [];
        });
        if (candidates.length === 0) {
            return { applicable: false, reason: "no independent adjacent turns before epilogue" };
        }
        const order = pick(candidates, splitmix32(seed));
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
            // A one-position move produces the same order as the adjacent swap
            // in `reorder-independent-turns`, so only moves of two or more
            // positions are candidates; otherwise both transforms can emit
            // identical derivative transcripts that get scored twice.
            // commentlint: allow(JUDGE)
            Array.from(
                { length: Math.max(0, scenario.transcript.epilogueStartIndex - 2 - source) },
                (_, index) => {
                    const order = scenario.transcript.turns.map((_, turnIndex) => turnIndex);
                    const [moved] = order.splice(source, 1);
                    order.splice(source + index + 2, 0, moved!);
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
            return preservesContiguousGold(scenario, turnMap) ? [{ source: turnIndex, insertion, turnMap }] : [];
        });
        if (candidates.length === 0) {
            return {
                applicable: false,
                reason: rejected.length === 0
                    ? "no rejected proposal turn"
                    : "no rejected proposal insertion preserves contiguous gold ranges",
            };
        }
        const { source, insertion, turnMap } = pick(candidates, splitmix32(seed));
        const turns = scenario.transcript.turns.map((turn) => ({ ...turn }));
        turns.splice(insertion, 0, { ...scenario.transcript.turns[source]! });
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

// The separator class `[_./-]` must remain disjoint from `[A-Za-z0-9]`: if a
// segment can also contain separators, a long `-` run after a letter
// backtracks exponentially when the trailing `\b` fails.
// commentlint: allow(JUDGE)
const SYMBOL_RE = /`([^`]+)`|\b(?:[A-Za-z][A-Za-z0-9]*(?:[_./-][A-Za-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z]{2,})\b/g;

const renameUnrelatedSymbols: Transform = {
    id: "rename-unrelated-symbols",
    version: 1,
    alwaysApplicable: false,
    apply(scenario, rawSeed) {
        const seed = normalizedSeed(rawSeed);
        const messages = eligibleMessages(scenario);
        const eligibleKeys = new Set(messages.map((message) => `${message.turnIndex}:${message.role}`));
        // Symbols that also occur in a message the rename cannot touch stay
        // out of the candidate pool: renaming only some occurrences would name
        // one entity two ways within the derivative transcript.
        const blocked = new Set(
            scenario.transcript.turns.flatMap((turn, turnIndex) =>
                (["user", "assistant"] as const).flatMap((role) =>
                    eligibleKeys.has(`${turnIndex}:${role}`)
                        ? []
                        : [...turn[role].matchAll(SYMBOL_RE)].map((match) => match[1] ?? match[0]),
                ),
            ),
        );
        const candidates = [
            ...new Set(messages.flatMap((message) =>
                [...message.text.matchAll(SYMBOL_RE)].map((match) => match[1] ?? match[0])
            )),
        ].filter((symbol) => !blocked.has(symbol));
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
