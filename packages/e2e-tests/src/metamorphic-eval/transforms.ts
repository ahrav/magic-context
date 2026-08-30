import { splitmix32 } from "../../../plugin/scripts/retrieval-benchmark/synthetic";
import {
    MAX_TRANSCRIPT_TURNS,
    MAX_TURN_TEXT_CHARS,
    containsCompleteValue,
    lintScenario,
    normalizeContent,
    normalizedEvidenceMessages,
    parseScenario,
    type ContentPredicate,
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

function messageKey(turnIndex: number, role: "user" | "assistant"): string {
    return `${turnIndex}:${role}`;
}

/**
 * One authored occurrence of a forbidden formation, identified by the ordered
 * messages it runs through: `<absent id>|<turn>:<role>,...`.
 *
 * The authorship rule searches the whole evidence range, so an occurrence can
 * cross a role or a turn boundary and match no single message: one turn's
 * assistant ends with `use` while the next turn's user opens with `API/v2`.
 * Naming the messages it crosses is what lets a transform tell a perturbation
 * that keeps an occurrence intact from one that pulls its halves apart — and
 * identifying occurrences rather than predicates is what keeps a predicate with
 * two authored occurrences from hiding the loss of one behind the other.
 *
 * Offsets come from the same normalized view the matcher compares, so a span is
 * the messages the occurrence actually crosses rather than an approximation from
 * turn boundaries.
 */
function matchSpans(
    entries: readonly { id: string; predicate: ContentPredicate }[],
    turns: readonly TranscriptTurn[],
): string[] {
    const messages = normalizedEvidenceMessages(turns);
    const spans: Array<{ key: string; start: number; end: number }> = [];
    let offset = 0;
    for (const message of messages) {
        spans.push({
            key: messageKey(message.turnIndex, message.role),
            start: offset,
            end: offset + message.text.length,
        });
        // The join separator sits between messages and belongs to neither.
        offset += message.text.length + 1;
    }
    const evidence = messages.map((message) => message.text).join(" ");
    const matches: string[] = [];
    for (const entry of entries) {
        const needle = normalizeContent(entry.predicate.value);
        if (needle.length === 0) continue;
        for (let at = evidence.indexOf(needle); at !== -1; at = evidence.indexOf(needle, at + 1)) {
            const matchEnd = at + needle.length;
            const crossed = spans
                .filter((span) => span.start < matchEnd && at < span.end)
                .map((span) => span.key);
            matches.push(`${entry.id}|${crossed.join(",")}`);
        }
    }
    return matches;
}

/** Messages that authored negative evidence runs through. */
function absentEvidenceMessages(scenario: HistorianEvalScenario): Set<string> {
    return new Set(
        matchSpans(scenario.gold.expectedAbsent, scenario.transcript.turns).flatMap((match) =>
            match.slice(match.indexOf("|") + 1).split(","),
        ),
    );
}

/** Turns that authored negative evidence runs through. */
function absentEvidenceTurnIndexes(scenario: HistorianEvalScenario): Set<number> {
    return new Set(
        [...absentEvidenceMessages(scenario)].map((key) => Number(key.slice(0, key.indexOf(":")))),
    );
}

/** One turn reduced to what the historian receives from it. */
function visibleTurnPayload(turn: TranscriptTurn): string {
    return normalizedEvidenceMessages([turn])
        .map((message) => `${message.role}:${message.text}`)
        .join("\n");
}

function eligibleMessages(scenario: HistorianEvalScenario): EligibleMessage[] {
    const evidenceMessages = absentEvidenceMessages(scenario);
    return unprotectedMessages(scenario).filter(
        (message) => !evidenceMessages.has(messageKey(message.turnIndex, message.role)),
    );
}

/**
 * Messages outside every expected-claim source range that the historian actually
 * receives.
 *
 * Production discards a user message that is empty after cleaning or that is a
 * system directive, so such a message contributes no evidence — and framing text
 * prepended to one can stop it being recognised as a directive, or survive
 * reminder stripping, materializing a historian-visible message the baseline did
 * not have. That is a different transcript, not a perturbation of this one, so a
 * message the historian never sees is not a rewrite candidate.
 */
function unprotectedMessages(scenario: HistorianEvalScenario): EligibleMessage[] {
    const protectedIndexes = protectedTurnIndexes(scenario);
    const visible = new Set(
        normalizedEvidenceMessages(scenario.transcript.turns).map((message) =>
            messageKey(message.turnIndex, message.role),
        ),
    );
    return scenario.transcript.turns.flatMap((turn, turnIndex) => {
        if (protectedIndexes.has(turnIndex)) return [];
        return (["user", "assistant"] as const).flatMap((role) =>
            visible.has(messageKey(turnIndex, role)) ? [{ turnIndex, role, text: turn[role] }] : [],
        );
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
 * Whether every authored occurrence of a forbidden formation survives the
 * perturbation.
 *
 * An occurrence can be authored across a turn boundary, so moving, inserting, or
 * duplicating a turn can separate halves that no single turn contains, and
 * framing text inserted between them does the same. Asking only whether the
 * predicate still matches somewhere is not enough: a predicate authored twice
 * would let the surviving occurrence hide the loss of the other, and the
 * derivative would carry less rejection evidence than the scenario declares while
 * every check still passed. Each source occurrence is therefore mapped through
 * `turnMap` and looked for individually, with multiplicity.
 */
function preservesAbsentEvidence(
    scenario: HistorianEvalScenario,
    turns: readonly TranscriptTurn[],
    turnMap: readonly number[],
): boolean {
    const remaining = new Map<string, number>();
    for (const match of matchSpans(scenario.gold.expectedAbsent, turns)) {
        remaining.set(match, (remaining.get(match) ?? 0) + 1);
    }
    for (const match of matchSpans(scenario.gold.expectedAbsent, scenario.transcript.turns)) {
        const separator = match.indexOf("|");
        const expected = `${match.slice(0, separator)}|${match
            .slice(separator + 1)
            .split(",")
            .map((key) => {
                const colon = key.indexOf(":");
                return messageKey(
                    turnMap[Number(key.slice(0, colon))]!,
                    key.slice(colon + 1) as "user" | "assistant",
                );
            })
            .join(",")}`;
        const count = remaining.get(expected) ?? 0;
        if (count === 0) return false;
        remaining.set(expected, count - 1);
    }
    return true;
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
            (text: string) => `For context, ${text}`,
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
 * Four ways framing can invalidate the comparison. It can outgrow the per-message
 * ceiling. It can separate the halves of a forbidden formation authored across a
 * message boundary. Its own wording can state a probe's gold answer, which is the
 * quiet one — the answer then sits in raw history the probe still reads, so the
 * probe can copy it without the injected claim and a passing run overstates
 * accuracy on a source that was leakage-free. And its wording can satisfy an
 * expected-claim predicate, which authors gold evidence outside the range that
 * declares it and changes what the historian may legitimately promote; a
 * `claim-id` probe has no answer to collide with, so only this check catches it.
 */
function safeParaphrase(
    scenario: HistorianEvalScenario,
    message: EligibleMessage,
    text: string,
): boolean {
    if (text.length > MAX_TURN_TEXT_CHARS) return false;
    const turns = replaceMessage(scenario.transcript.turns, message, text);
    if (!preservesAbsentEvidence(scenario, turns, scenario.transcript.turns.map((_, index) => index))) {
        return false;
    }
    if (
        matchSpans(scenario.gold.expectedClaims, turns).length >
        matchSpans(scenario.gold.expectedClaims, scenario.transcript.turns).length
    ) {
        return false;
    }
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
            // Swapping two turns the historian receives identically produces the
            // same model input, so the derivative would differ only in bytes the
            // historian never sees and the comparison would score the baseline
            // against itself. Compared on the cleaned view rather than the raw
            // strings: two turns can differ only in a reminder block that
            // production strips.
            if (
                visibleTurnPayload(scenario.transcript.turns[left]!) ===
                visibleTurnPayload(scenario.transcript.turns[right]!)
            ) {
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
            return preservesAbsentEvidence(scenario, reorderedTurns(scenario, order), mapForOrder(order))
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
                    preservesAbsentEvidence(scenario, reorderedTurns(scenario, order), mapForOrder(order)),
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
        // Turns the rejection evidence actually runs through in the text the
        // historian receives. Matching the raw strings instead would select a
        // turn whose only occurrence sits in a reminder block or directive
        // production discards, duplicating a turn that carries no rejection at
        // all — and `preservesAbsentEvidence` would still pass on the occurrence
        // that lives elsewhere.
        const rejectedTurns = new Set(
            matchSpans(rejected, scenario.transcript.turns).flatMap((match) =>
                match
                    .slice(match.indexOf("|") + 1)
                    .split(",")
                    .map((key) => Number(key.slice(0, key.indexOf(":")))),
            ),
        );
        const protectedIndexes = protectedTurnIndexes(scenario);
        const candidates = scenario.transcript.turns.flatMap((turn, turnIndex) => {
            if (turnIndex >= scenario.transcript.epilogueStartIndex) return [];
            if (protectedIndexes.has(turnIndex)) return [];
            if (!rejectedTurns.has(turnIndex)) return [];
            const insertion = turnIndex + 1;
            const turnMap = scenario.transcript.turns.map((_, index) =>
                index < insertion ? index : index + 1,
            );
            if (!preservesContiguousGold(scenario, turnMap)) return [];
            const turns = duplicatedTurns(scenario, turnIndex, insertion);
            return preservesAbsentEvidence(scenario, turns, turnMap)
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

// Inline code is not necessarily a name: a backtick span can hold a command or
// an expression, and replacing the whole span would rewrite the instruction
// rather than rename an entity. Admitted backtick contents must therefore
// satisfy the same shape the unquoted alternatives accept.
const QUOTED_SYMBOL_RE = /^(?:[A-Za-z][A-Za-z0-9]*(?:[_./-][A-Za-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z]{2,})$/;

/** The renameable symbols of `text`, in match order. */
function symbolsIn(text: string): string[] {
    return [...text.matchAll(SYMBOL_RE)].flatMap((match) => {
        const quoted = match[1];
        if (quoted === undefined) return [match[0]];
        return QUOTED_SYMBOL_RE.test(quoted) ? [quoted] : [];
    });
}

const renameUnrelatedSymbols: Transform = {
    id: "rename-unrelated-symbols",
    version: 1,
    alwaysApplicable: false,
    apply(scenario, rawSeed) {
        const seed = normalizedSeed(rawSeed);
        const messages = eligibleMessages(scenario);
        const eligibleKeys = new Set(messages.map((message) => `${message.turnIndex}:${message.role}`));
        // Symbols that also occur in text the rename cannot touch stay out of the
        // candidate pool: renaming only some occurrences would name one entity
        // two ways. Probes count as untouchable text — a probe asking what
        // `buildAPI` returns against a history that now says `aux_symbol_N`
        // measures a broken query, not naming robustness.
        const blocked = new Set([
            ...scenario.transcript.turns.flatMap((turn, turnIndex) =>
                (["user", "assistant"] as const).flatMap((role) =>
                    eligibleKeys.has(`${turnIndex}:${role}`)
                        ? []
                        : symbolsIn(turn[role]),
                ),
            ),
            ...scenario.probes.flatMap((probe) =>
                [
                    probe.question,
                    probe.answerType === "claim-id" ? "" : probe.goldAnswer,
                    ...(probe.answerType === "multiple-choice" ? probe.choices : []),
                ].flatMap((text) => symbolsIn(text)),
            ),
        ]);
        const candidates = [...new Set(messages.flatMap((message) => symbolsIn(message.text)))].filter(
            (symbol) => !blocked.has(symbol),
        );
        if (candidates.length === 0) {
            return { applicable: false, reason: "no unrelated symbol to rename" };
        }
        const next = splitmix32(seed);
        const original = pick(candidates, next);
        const existing = new Set(
            scenario.transcript.turns.flatMap((turn) =>
                [turn.user, turn.assistant].flatMap((text) => symbolsIn(text)),
            ),
        );
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
