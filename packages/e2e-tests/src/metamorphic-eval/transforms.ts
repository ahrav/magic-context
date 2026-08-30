import { splitmix32 } from "../../../plugin/scripts/retrieval-benchmark/synthetic";
import {
    MAX_TRANSCRIPT_TURNS,
    MAX_TURN_TEXT_CHARS,
    authoredEvidenceText,
    containsCompleteValue,
    lintScenario,
    normalizeContent,
    normalizedEvidenceMessages,
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

/**
 * The reason prefix a derivative that violates the scenario contract carries.
 * The frozen corpus must never produce one: it means a transform built a
 * derivative the contract rejects rather than declining the candidate.
 */
export const CONTRACT_VIOLATION_REASON = "derivative violates the scenario contract";

/**
 * A lint diagnostic reduced to what it is about: the scenario ID it is labelled
 * with differs between a source and its derivative, and a measurement in
 * parentheses differs whenever the perturbation changed the number, so neither
 * belongs in an identity used to compare the two.
 */
function diagnosticKey(diagnostic: string, scenarioID: string): string {
    const unlabelled = diagnostic.startsWith(`${scenarioID}.`)
        ? diagnostic.slice(scenarioID.length + 1)
        : diagnostic;
    const measurement = unlabelled.indexOf(" (");
    return measurement === -1 ? unlabelled : unlabelled.slice(0, measurement);
}

/**
 * Builds the derivative, or declines the candidate when the perturbation is what
 * breaks the contract.
 *
 * Perturbing a transcript can push the result past a bound the source satisfied:
 * a rewrite lengthens a message, an insertion adds a turn and the tokens it
 * renders to, a reordering separates evidence a rule reads across the whole
 * range. `parseScenario` answers those by throwing and `lintScenario` by
 * returning diagnostics, and neither is a defect in the source — so the honest
 * result is an inapplicable transform, not an exception that aborts enumeration
 * for the whole scenario, and not an `applicable: true` carrying a scenario the
 * harness would reject.
 *
 * Only diagnostics the source did not already carry count. A scenario that is
 * unclean on its own stays the corpus's problem to fix, and blaming the
 * transform for inheriting it would report every transform as inapplicable and
 * hide whatever the perturbation actually did.
 *
 * A transform that can instead choose a different candidate should do so before
 * arriving here; this is the backstop for the cases where no candidate helps.
 */
function derivative(
    base: HistorianEvalScenario,
    transform: Pick<Transform, "id" | "version">,
    seed: number,
    turns: TranscriptTurn[],
    epilogueStartIndex: number,
    turnMap: number[],
): TransformResult {
    let scenario: HistorianEvalScenario;
    try {
        scenario = parseScenario({
            ...base,
            id: `${base.id}-d-${transform.id}-v${transform.version}-s${seed}`,
            transcript: { turns, epilogueStartIndex },
            gold: remapGold(base.gold, turnMap),
        });
    } catch (error) {
        return {
            applicable: false,
            reason: `${CONTRACT_VIOLATION_REASON}: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    const inherited = new Set(
        lintScenario(base).map((diagnostic) => diagnosticKey(diagnostic, base.id)),
    );
    const introduced = lintScenario(scenario).filter(
        (diagnostic) => !inherited.has(diagnosticKey(diagnostic, scenario.id)),
    );
    if (introduced.length > 0) {
        return { applicable: false, reason: `${CONTRACT_VIOLATION_REASON}: ${introduced.join("; ")}` };
    }
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

/**
 * Messages that authored negative evidence spans, keyed `turnIndex:role`.
 *
 * The expected-absent authorship rule searches the whole evidence range, so a
 * forbidden formation can be authored across a role or a turn boundary and match
 * no single message: one turn's assistant ends with `use` while the next turn's
 * user opens with `API/v2`. Rewriting either side deletes the authored evidence
 * and the derivative then fails lint with `not-authored-before-epilogue`, so
 * every message a match overlaps is off limits — not only the messages that
 * match on their own.
 *
 * Offsets come from the same normalized view the matcher compares, so the spans
 * name the messages the match actually crosses instead of approximating them
 * from turn boundaries.
 */
function absentEvidenceMessages(scenario: HistorianEvalScenario): Set<string> {
    const messages = normalizedEvidenceMessages(scenario.transcript.turns);
    const spans: Array<{ key: string; start: number; end: number }> = [];
    let offset = 0;
    for (const message of messages) {
        spans.push({
            key: `${message.turnIndex}:${message.role}`,
            start: offset,
            end: offset + message.text.length,
        });
        // The join separator sits between messages and belongs to neither.
        offset += message.text.length + 1;
    }
    const evidence = messages.map((message) => message.text).join(" ");
    const spanned = new Set<string>();
    for (const absent of scenario.gold.expectedAbsent) {
        const needle = normalizeContent(absent.predicate.value);
        if (needle.length === 0) continue;
        for (let at = evidence.indexOf(needle); at !== -1; at = evidence.indexOf(needle, at + 1)) {
            const matchEnd = at + needle.length;
            for (const span of spans) {
                if (span.start < matchEnd && at < span.end) spanned.add(span.key);
            }
        }
    }
    return spanned;
}

/** Turns that authored negative evidence runs through. */
function absentEvidenceTurnIndexes(scenario: HistorianEvalScenario): Set<number> {
    return new Set(
        [...absentEvidenceMessages(scenario)].map((key) => Number(key.slice(0, key.indexOf(":")))),
    );
}

function eligibleMessages(scenario: HistorianEvalScenario): EligibleMessage[] {
    const evidenceMessages = absentEvidenceMessages(scenario);
    return unprotectedMessages(scenario).filter(
        (message) => !evidenceMessages.has(`${message.turnIndex}:${message.role}`),
    );
}

/** Messages outside every expected-claim source range. */
function unprotectedMessages(scenario: HistorianEvalScenario): EligibleMessage[] {
    const protectedIndexes = protectedTurnIndexes(scenario);
    return scenario.transcript.turns.flatMap((turn, turnIndex) => {
        if (protectedIndexes.has(turnIndex)) return [];
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

/**
 * Whether `turns` still authors every forbidden formation the source authored.
 *
 * A predicate can be authored across a turn boundary, so moving, inserting, or
 * duplicating a turn can separate the two halves of a match that no single turn
 * contains. The authorship rule then reports the formation as never authored and
 * the derivative fails lint, so a candidate that loses a match is not a
 * candidate. Both windows are checked because the authorship rule looks at the
 * pre-epilogue evidence while the scorer sees the whole transcript.
 */
function preservesAbsentEvidence(
    scenario: HistorianEvalScenario,
    turns: readonly TranscriptTurn[],
    epilogueStartIndex: number,
): boolean {
    const windows: Array<readonly [readonly TranscriptTurn[], readonly TranscriptTurn[]]> = [
        [scenario.transcript.turns, turns],
        [
            scenario.transcript.turns.slice(0, scenario.transcript.epilogueStartIndex),
            turns.slice(0, epilogueStartIndex),
        ],
    ];
    return windows.every(([before, after]) => {
        const authored = authoredEvidenceText(before);
        const derived = authoredEvidenceText(after);
        return scenario.gold.expectedAbsent.every(
            (absent) =>
                !predicateMatches(absent.predicate, authored) ||
                predicateMatches(absent.predicate, derived),
        );
    });
}

/** The turn list a candidate order produces, without copying gold. */
function reorderedTurns(
    scenario: HistorianEvalScenario,
    order: readonly number[],
): TranscriptTurn[] {
    return order.map((index) => ({ ...scenario.transcript.turns[index]! }));
}

/** The turn list produced by copying `source` to `insertion`. */
function duplicatedTurns(
    scenario: HistorianEvalScenario,
    source: number,
    insertion: number,
): TranscriptTurn[] {
    const turns = scenario.transcript.turns.map((turn) => ({ ...turn }));
    turns.splice(insertion, 0, { ...scenario.transcript.turns[source]! });
    return turns;
}

function epilogueStartIndexAfter(scenario: HistorianEvalScenario, insertion: number): number {
    return (
        scenario.transcript.epilogueStartIndex +
        (insertion <= scenario.transcript.epilogueStartIndex ? 1 : 0)
    );
}

const paraphraseIrrelevant: Transform = {
    id: "paraphrase-irrelevant",
    version: 1,
    alwaysApplicable: true,
    apply(scenario, rawSeed) {
        const seed = normalizedSeed(rawSeed);
        const rewrites = [
            (text: string) => `For context, ${text.charAt(0).toLowerCase()}${text.slice(1)}`,
            (text: string) => `${text} This is background context only.`,
            (text: string) => `As background: ${text}`,
        ];
        // Each rewrite keeps the original wording and only frames it, so a
        // forbidden formation inside the message survives; only one that runs
        // into a neighbouring message can lose its adjacency, and only the
        // inserted framing can introduce a probe's answer. Candidates are
        // therefore whole `(message, rewrite)` pairs proven against both, which
        // keeps a message eligible for the rewrites that are safe for it instead
        // of excluding it for the one that is not.
        const candidates = unprotectedMessages(scenario).flatMap((message) =>
            rewrites
                .map((rewrite) => rewrite(message.text))
                .filter((text) => safeParaphrase(scenario, message, text))
                .map((text) => ({ message, text })),
        );
        if (candidates.length === 0) {
            return { applicable: false, reason: "no irrelevant message to paraphrase" };
        }
        const { message, text } = pick(candidates, splitmix32(seed));
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

/**
 * Whether rewriting `message` to `text` leaves the scenario's evidence intact.
 *
 * Three ways a framing rewrite can invalidate the comparison: it can outgrow the
 * per-message ceiling, it can insert framing between the halves of a forbidden
 * formation authored across a message boundary, and its own wording can state a
 * probe's gold answer. The last one is the quiet failure — the answer then sits
 * in raw history the probe still sees, so the probe can copy it without the
 * injected claim and a passing run overstates accuracy on a source that was
 * leakage-free.
 */
function safeParaphrase(
    scenario: HistorianEvalScenario,
    message: EligibleMessage,
    text: string,
): boolean {
    if (text.length > MAX_TURN_TEXT_CHARS) return false;
    const turns = replaceMessage(scenario.transcript.turns, message, text);
    if (!preservesAbsentEvidence(scenario, turns, scenario.transcript.epilogueStartIndex)) return false;
    return scenario.probes.every((probe) => {
        if (probe.answerType === "claim-id") return true;
        return (
            !containsCompleteValue(text, probe.goldAnswer) ||
            containsCompleteValue(message.text, probe.goldAnswer)
        );
    });
}

const reorderIndependentTurns: Transform = {
    id: "reorder-independent-turns",
    version: 1,
    alwaysApplicable: false,
    apply(scenario, rawSeed) {
        const seed = normalizedSeed(rawSeed);
        const expectedIndexes = protectedTurnIndexes(scenario);
        const absentIndexes = absentEvidenceTurnIndexes(scenario);
        const candidates = Array.from(
            { length: scenario.transcript.epilogueStartIndex - 1 },
            (_, index) => [index, index + 1] as const,
        ).flatMap(([left, right]) => {
            // Swapping two byte-identical turns yields the source transcript
            // back. The derivative would differ only by its generated ID, so the
            // comparison would score the baseline against itself and report
            // metamorphic evidence it never gathered.
            const leftTurn = scenario.transcript.turns[left]!;
            const rightTurn = scenario.transcript.turns[right]!;
            if (leftTurn.user === rightTurn.user && leftTurn.assistant === rightTurn.assistant) {
                return [];
            }
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
            if (!preservesContiguousGold(scenario, mapForOrder(order))) return [];
            return preservesAbsentEvidence(
                scenario,
                reorderedTurns(scenario, order),
                scenario.transcript.epilogueStartIndex,
            )
                ? [order]
                : [];
        });
        if (candidates.length === 0) {
            return { applicable: false, reason: "no independent adjacent turns before epilogue" };
        }
        const order = pick(candidates, splitmix32(seed));
        return derivative(
            scenario,
            this,
            seed,
            reorderedTurns(scenario, order),
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
        const absentIndexes = absentEvidenceTurnIndexes(scenario);
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
                    const destination = source + index + 2;
                    const order = scenario.transcript.turns.map((_, turnIndex) => turnIndex);
                    const [moved] = order.splice(source, 1);
                    order.splice(destination, 0, moved!);
                    return { source, destination, order };
                },
            ).filter(
                ({ source: from, destination, order }) =>
                    // Every turn the decision passes shifts ahead of it, so a
                    // rejected proposal inside the span would end up preceding
                    // the decision that rejected it — the same inversion
                    // `reorder-independent-turns` refuses for an adjacent pair.
                    !Array.from(
                        { length: destination - from },
                        (_, offset) => from + 1 + offset,
                    ).some((turnIndex) => absentIndexes.has(turnIndex)) &&
                    preservesContiguousGold(scenario, mapForOrder(order)) &&
                    preservesAbsentEvidence(
                        scenario,
                        reorderedTurns(scenario, order),
                        scenario.transcript.epilogueStartIndex,
                    ),
            ),
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
            reorderedTurns(scenario, order),
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
            if (!preservesContiguousGold(scenario, turnMap)) return [];
            const turns = duplicatedTurns(scenario, turnIndex, insertion);
            return preservesAbsentEvidence(scenario, turns, epilogueStartIndexAfter(scenario, insertion))
                ? [{ source: turnIndex, insertion, turnMap }]
                : [];
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
        return derivative(
            scenario,
            this,
            seed,
            duplicatedTurns(scenario, source, insertion),
            epilogueStartIndexAfter(scenario, insertion),
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
        // A replacement longer than the symbol it displaces can push a message
        // past the contract limit, which `derivative()` reports by throwing
        // instead of returning; enumeration must see an inapplicable transform.
        if (
            turns.some(
                (turn) =>
                    turn.user.length > MAX_TURN_TEXT_CHARS ||
                    turn.assistant.length > MAX_TURN_TEXT_CHARS,
            )
        ) {
            return { applicable: false, reason: "rename does not fit the turn text limit" };
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
