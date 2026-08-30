import { splitmix32 } from "../../../plugin/scripts/retrieval-benchmark/synthetic";
import {
    MAX_TRANSCRIPT_TURNS,
    MAX_TURN_TEXT_CHARS,
    authoredEvidenceText,
    containsCompleteValue,
    countCompleteValues,
    lintScenario,
    normalizeContent,
    normalizedEvidenceMessages,
    parseScenario,
    visibleEvidenceMessages,
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

/**
 * The first candidate a seed reaches that `accept` allows.
 *
 * Proving a candidate costs a full evidence scan, and a scenario at the transcript
 * and expectation limits generates thousands of them, so proving the whole list to
 * use one of them is the dominant cost of an application. Probing from a
 * seed-chosen offset and stopping at the first acceptance keeps the usual case at
 * one proof while leaving the worst case — nothing acceptable — no worse than
 * filtering. The offset makes the choice seed-stable, and the wrap makes it
 * exhaustive.
 */
function firstAccepted<T>(
    candidates: readonly T[],
    seed: number,
    accept: (candidate: T) => boolean,
): T | undefined {
    if (candidates.length === 0) return undefined;
    const start = Math.floor(splitmix32(seed)() * candidates.length);
    for (let offset = 0; offset < candidates.length; offset += 1) {
        const candidate = candidates[(start + offset) % candidates.length]!;
        if (accept(candidate)) return candidate;
    }
    return undefined;
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
            if (
                mapped.length === 0 ||
                mapped.some((index) => !Number.isInteger(index))
            ) {
                throw new Error(`turn map does not cover ${claim.id}`);
            }
            const ordered = [...mapped].sort((left, right) => left - right);
            if (
                ordered.some(
                    (index, offset) =>
                        offset > 0 && index !== ordered[offset - 1]! + 1,
                )
            ) {
                throw new Error(
                    `turn map produces non-contiguous source range for ${claim.id}`,
                );
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
export const CONTRACT_VIOLATION_REASON =
    "derivative violates the scenario contract";

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
        lintScenario(base).map((diagnostic) =>
            diagnosticKey(diagnostic, base.id),
        ),
    );
    const introduced = lintScenario(scenario).filter(
        (diagnostic) => !inherited.has(diagnosticKey(diagnostic, scenario.id)),
    );
    if (introduced.length > 0) {
        return {
            applicable: false,
            reason: `${CONTRACT_VIOLATION_REASON}: ${introduced.join("; ")}`,
        };
    }
    return { applicable: true, scenario, turnMap };
}

function protectedTurnIndexes(scenario: HistorianEvalScenario): Set<number> {
    const protectedIndexes = new Set<number>();
    for (const claim of scenario.gold.expectedClaims) {
        for (
            let index = claim.sourceTurnRange[0];
            index <= claim.sourceTurnRange[1];
            index += 1
        ) {
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
        for (
            let at = evidence.indexOf(needle);
            at !== -1;
            at = evidence.indexOf(needle, at + 1)
        ) {
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
        matchSpans(
            scenario.gold.expectedAbsent,
            scenario.transcript.turns,
        ).flatMap((match) => match.slice(match.indexOf("|") + 1).split(",")),
    );
}

/** Turns that authored negative evidence runs through. */
function absentEvidenceTurnIndexes(
    scenario: HistorianEvalScenario,
): Set<number> {
    return new Set(
        [...absentEvidenceMessages(scenario)].map((key) =>
            Number(key.slice(0, key.indexOf(":"))),
        ),
    );
}

/** The transcript reduced to what the historian receives from it. */
function visibleTranscript(turns: readonly TranscriptTurn[]): string {
    // Case-preserving on purpose: the historian receives the text as authored, so
    // two turns differing only in an identifier's case are different inputs even
    // though the predicate matcher would fold them together.
    return visibleEvidenceMessages(turns)
        .map((message) => `${message.role}:${message.text}`)
        .join("\n");
}

/**
 * Whether the historian would receive a different transcript.
 *
 * A reordering whose turns are interchangeable in the historian's view produces
 * the same model input, so the derivative differs only in bytes the historian
 * never sees and the comparison would score the baseline against itself. Compared
 * over the whole transcript rather than the turns being exchanged: a set of
 * interchangeable turns can be permuted without any adjacent pair matching, and
 * two turns can differ only inside a reminder block production strips.
 */
function changesVisibleTranscript(
    scenario: HistorianEvalScenario,
    turns: readonly TranscriptTurn[],
): boolean {
    return (
        visibleTranscript(turns) !==
        visibleTranscript(scenario.transcript.turns)
    );
}

function eligibleMessages(scenario: HistorianEvalScenario): EligibleMessage[] {
    const evidenceMessages = absentEvidenceMessages(scenario);
    return unprotectedMessages(scenario).filter(
        (message) =>
            !evidenceMessages.has(messageKey(message.turnIndex, message.role)),
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
function unprotectedMessages(
    scenario: HistorianEvalScenario,
): EligibleMessage[] {
    const protectedIndexes = protectedTurnIndexes(scenario);
    const visible = new Set(
        normalizedEvidenceMessages(scenario.transcript.turns).map((message) =>
            messageKey(message.turnIndex, message.role),
        ),
    );
    return scenario.transcript.turns.flatMap((turn, turnIndex) => {
        if (protectedIndexes.has(turnIndex)) return [];
        return (["user", "assistant"] as const).flatMap((role) =>
            visible.has(messageKey(turnIndex, role))
                ? [{ turnIndex, role, text: turn[role] }]
                : [],
        );
    });
}

function replaceMessage(
    turns: readonly TranscriptTurn[],
    message: EligibleMessage,
    text: string,
): TranscriptTurn[] {
    return turns.map((turn, index) =>
        index === message.turnIndex
            ? { ...turn, [message.role]: text }
            : { ...turn },
    );
}

function mapForOrder(order: readonly number[]): number[] {
    const turnMap = Array<number>(order.length);
    order.forEach((originalIndex, derivativeIndex) => {
        turnMap[originalIndex] = derivativeIndex;
    });
    return turnMap;
}

function preservesContiguousGold(
    scenario: HistorianEvalScenario,
    turnMap: readonly number[],
): boolean {
    try {
        remapGold(scenario.gold, turnMap);
        return true;
    } catch {
        return false;
    }
}

interface EvidenceBaseline {
    entries: readonly { id: string; predicate: ContentPredicate }[];
    matches: readonly string[];
}

interface EvidenceBaselines {
    /** Every forbidden formation. */
    absent: EvidenceBaseline;
    /** Rejected proposals: the only evidence duplication is allowed to repeat. */
    rejected: EvidenceBaseline;
    /** Forbidden formations of every other family. */
    otherAbsent: EvidenceBaseline;
    claims: EvidenceBaseline;
}

/**
 * The scenario's authored occurrences, enumerated once.
 *
 * Every candidate is judged against these, and the source side of that
 * comparison does not change between candidates — scanning it per candidate made
 * one `apply` on a hundred-turn scenario with a hundred expectation entries cost
 * over a second.
 */
function evidenceBaselines(scenario: HistorianEvalScenario): EvidenceBaselines {
    const baseline = (
        entries: readonly { id: string; predicate: ContentPredicate }[],
    ) => ({
        entries,
        matches: matchSpans(entries, scenario.transcript.turns),
    });
    const rejected = scenario.gold.expectedAbsent.filter(
        (absent) => absent.family === "proposed-but-rejected",
    );
    return {
        absent: baseline(scenario.gold.expectedAbsent),
        rejected: baseline(rejected),
        otherAbsent: baseline(
            scenario.gold.expectedAbsent.filter(
                (absent) => !rejected.includes(absent),
            ),
        ),
        claims: baseline(scenario.gold.expectedClaims),
    };
}

/**
 * How many authored occurrences the perturbation destroys and creates.
 *
 * An occurrence can be authored across a turn boundary, so moving, inserting, or
 * duplicating a turn can separate halves that no single turn contains, and
 * framing text inserted between them does the same — or, in the other direction,
 * can bring two neighbours into a formation neither authored. Asking only whether
 * the predicate matches somewhere answers neither: a predicate authored twice
 * would let the surviving occurrence hide the loss of the other, and a count
 * would hide a simultaneous loss and gain. Each source occurrence is therefore
 * mapped through `turnMap` and matched individually, with multiplicity, and
 * whatever the derivative has left over is a creation.
 */
function matchDelta(
    baseline: EvidenceBaseline,
    turns: readonly TranscriptTurn[],
    turnMap: readonly number[],
): { lost: number; gained: number } {
    const remaining = new Map<string, number>();
    for (const match of matchSpans(baseline.entries, turns)) {
        remaining.set(match, (remaining.get(match) ?? 0) + 1);
    }
    let lost = 0;
    for (const match of baseline.matches) {
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
        if (count === 0) {
            lost += 1;
            continue;
        }
        remaining.set(expected, count - 1);
    }
    let gained = 0;
    for (const count of remaining.values()) gained += count;
    return { lost, gained };
}

/**
 * Neither gold nor negative evidence changes at all.
 *
 * The perturbation a rewrite or a reordering stands for is wording or placement,
 * so authoring a formation the source never authored is as much a confound as
 * losing one: a derivative with extra rejection evidence, or with gold evidence
 * outside the range that declares it, can change what the historian promotes for
 * a reason the comparison does not attribute to the transform.
 */
function preservesEvidenceExactly(
    baselines: EvidenceBaselines,
    turns: readonly TranscriptTurn[],
    turnMap: readonly number[],
): boolean {
    return [baselines.absent, baselines.claims].every((baseline) => {
        const { lost, gained } = matchDelta(baseline, turns, turnMap);
        return lost === 0 && gained === 0;
    });
}

/**
 * Nothing is lost, and only the rejection may be repeated.
 *
 * Duplicating a rejected-proposal turn multiplies its rejection occurrences by
 * design — that is the perturbation. Every other kind of evidence on that turn is
 * collateral: a copied turn that also states an accepted claim authors it a second
 * time outside the range that declares it, and one that also carries an injection
 * canary or a superseded fact strengthens a family the transform does not claim to
 * vary. A behaviour change could then be attributed to the wrong cause, so
 * everything but the rejection is held exactly.
 */
function preservesEvidenceForDuplication(
    baselines: EvidenceBaselines,
    turns: readonly TranscriptTurn[],
    turnMap: readonly number[],
): boolean {
    return (
        matchDelta(baselines.rejected, turns, turnMap).lost === 0 &&
        [baselines.otherAbsent, baselines.claims].every((baseline) => {
            const { lost, gained } = matchDelta(baseline, turns, turnMap);
            return lost === 0 && gained === 0;
        })
    );
}

/** The gold answers a probe could copy out of raw history. */
function probeAnswers(scenario: HistorianEvalScenario): string[] {
    return scenario.probes.flatMap((probe) =>
        probe.answerType === "claim-id" ? [] : [probe.goldAnswer],
    );
}

/**
 * Whether the derivative states each probe answer exactly as often as the source.
 *
 * A probe is meant to be answerable only by retrieving the injected claim, and the
 * source is authored so its answer is not copyable from raw history beyond the
 * range that backs it. Adding an occurrence hands the probe a copyable answer;
 * removing one changes what the leakage gate sees. Neither is a perturbation these
 * transforms advertise, and the expected-claim comparison cannot stand in for it —
 * a turn can carry the answer `4096` without matching the claim predicate
 * `capacity is 4096`.
 */
function preservesProbeAnswers(
    answers: readonly string[],
    scenario: HistorianEvalScenario,
    turns: readonly TranscriptTurn[],
): boolean {
    if (answers.length === 0) return true;
    const before = authoredEvidenceText(scenario.transcript.turns);
    const after = authoredEvidenceText(turns);
    return answers.every(
        (answer) => countCompleteValues(after, answer) === countCompleteValues(before, answer),
    );
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

function epilogueStartIndexAfter(
    scenario: HistorianEvalScenario,
    insertion: number,
): number {
    return (
        scenario.transcript.epilogueStartIndex +
        (insertion <= scenario.transcript.epilogueStartIndex ? 1 : 0)
    );
}

const paraphraseIrrelevant: Transform = {
    id: "paraphrase-irrelevant",
    version: 1,
    // Every rewrite adds characters, so a scenario whose only rewritable messages
    // already sit at `MAX_TURN_TEXT_CHARS` admits none of them. That is reachable
    // for a contract-valid scenario, so applicability cannot be promised for
    // every input — the frozen corpus asserts it directly instead.
    alwaysApplicable: false,
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
        // inserted framing can author new evidence. Candidates are therefore
        // whole `(message, rewrite)` pairs, which keeps a message eligible for
        // the rewrites that are safe for it instead of excluding it for the one
        // that is not.
        const pairs = unprotectedMessages(scenario).flatMap((message) =>
            rewrites.map((rewrite) => ({
                message,
                text: rewrite(message.text),
            })),
        );
        if (pairs.length === 0) {
            return {
                applicable: false,
                reason: "no irrelevant message to paraphrase",
            };
        }
        // Probed lazily from a seed-chosen offset rather than filtered eagerly:
        // validating a pair costs a full evidence scan, and a scenario at the
        // transcript and expectation limits has hundreds of pairs, so proving all
        // of them to use one made a single application cost over a second.
        const baselines = evidenceBaselines(scenario);
        const chosen = firstAccepted(pairs, seed, ({ message, text }) =>
            safeParaphrase(scenario, baselines, message, text),
        );
        if (chosen === undefined) {
            return {
                applicable: false,
                reason: "no irrelevant message to paraphrase",
            };
        }
        return derivative(
            scenario,
            this,
            seed,
            replaceMessage(
                scenario.transcript.turns,
                chosen.message,
                chosen.text,
            ),
            scenario.transcript.epilogueStartIndex,
            scenario.transcript.turns.map((_, index) => index),
        );
    },
};

/**
 * Whether rewriting `message` to `text` leaves the scenario's evidence intact.
 *
 * Three ways framing can invalidate the comparison. It can outgrow the per-message
 * ceiling. It can change what is authored — separating the halves of a formation
 * spanning a message boundary, or authoring one the source never had, including
 * gold evidence outside the range that declares it. And its own wording can state
 * a probe's gold answer, which is the quiet one: the answer then sits in raw
 * history the probe still reads, so the probe can copy it without the injected
 * claim and a passing run overstates accuracy on a source that was leakage-free.
 */
function safeParaphrase(
    scenario: HistorianEvalScenario,
    baselines: EvidenceBaselines,
    message: EligibleMessage,
    text: string,
): boolean {
    if (text.length > MAX_TURN_TEXT_CHARS) return false;
    const turns = replaceMessage(scenario.transcript.turns, message, text);
    if (
        !preservesEvidenceExactly(
            baselines,
            turns,
            scenario.transcript.turns.map((_, index) => index),
        )
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
        const baselines = evidenceBaselines(scenario);
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
            return preservesContiguousGold(scenario, mapForOrder(order))
                ? [order]
                : [];
        });
        const order = firstAccepted(candidates, seed, (candidate) => {
            const reordered = reorderedTurns(scenario, candidate);
            return (
                preservesEvidenceExactly(
                    baselines,
                    reordered,
                    mapForOrder(candidate),
                ) && changesVisibleTranscript(scenario, reordered)
            );
        });
        if (order === undefined) {
            return {
                applicable: false,
                reason: "no independent adjacent turns before epilogue",
            };
        }
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
        const baselines = evidenceBaselines(scenario);
        // A multi-turn claim range declares an evidence chronology. Sorting the
        // mapped indices lets a rotation of that range look contiguous, so the
        // decision could be moved through it and reverse the order the range
        // declares — the inversion the adjacent-swap transform already refuses.
        const multiTurnRanges = scenario.gold.expectedClaims
            .filter(
                (claim) =>
                    claim.sourceTurnRange[0] !== claim.sourceTurnRange[1],
            )
            .map((claim) => claim.sourceTurnRange);
        const sources = [
            ...new Set(
                scenario.gold.expectedClaims
                    .filter(
                        (claim) =>
                            claim.sourceTurnRange[0] ===
                                claim.sourceTurnRange[1] &&
                            claim.sourceTurnRange[0] <
                                scenario.transcript.epilogueStartIndex - 1,
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
                {
                    length: Math.max(
                        0,
                        scenario.transcript.epilogueStartIndex - 2 - source,
                    ),
                },
                (_, index) => {
                    const destination = source + index + 2;
                    const order = scenario.transcript.turns.map(
                        (_, turnIndex) => turnIndex,
                    );
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
                    !multiTurnRanges.some(
                        ([first, last]) => first <= destination && from <= last,
                    ),
            ),
        );
        const chosen = firstAccepted(candidates, seed, ({ order }) => {
            const reordered = reorderedTurns(scenario, order);
            return (
                preservesEvidenceExactly(
                    baselines,
                    reordered,
                    mapForOrder(order),
                ) && changesVisibleTranscript(scenario, reordered)
            );
        });
        if (chosen === undefined) {
            return {
                applicable: false,
                reason: "no movable single-turn accepted decision before epilogue",
            };
        }
        const { order } = chosen;
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
            return {
                applicable: false,
                reason: "transcript is already at the turn limit",
            };
        }
        const baselines = evidenceBaselines(scenario);
        const rejected = baselines.rejected.entries;
        const answers = probeAnswers(scenario);
        // Turns the rejection evidence actually runs through in the text the
        // historian receives. Matching the raw strings instead would select a
        // turn whose only occurrence sits in a reminder block or directive
        // production discards, duplicating a turn that carries no rejection at
        // all — and the evidence comparison would still pass on the occurrence
        // that lives elsewhere.
        // A turn qualifies only when its OWN payload carries a complete
        // occurrence. Every turn a cross-turn occurrence runs through contributes
        // to it, but copying just one of them repeats unrelated content and
        // leaves the rejection density unchanged — the opposite of what this
        // transform is for.
        const rejectedTurns = new Set(
            scenario.transcript.turns.flatMap((turn, turnIndex) =>
                matchSpans(rejected, [turn]).length > 0 ? [turnIndex] : [],
            ),
        );
        const protectedIndexes = protectedTurnIndexes(scenario);
        const candidates = scenario.transcript.turns.flatMap(
            (turn, turnIndex) => {
                if (turnIndex >= scenario.transcript.epilogueStartIndex)
                    return [];
                if (protectedIndexes.has(turnIndex)) return [];
                if (!rejectedTurns.has(turnIndex)) return [];
                const insertion = turnIndex + 1;
                const turnMap = scenario.transcript.turns.map((_, index) =>
                    index < insertion ? index : index + 1,
                );
                if (!preservesContiguousGold(scenario, turnMap)) return [];
                const turns = duplicatedTurns(scenario, turnIndex, insertion);
                return preservesEvidenceForDuplication(
                    baselines,
                    turns,
                    turnMap,
                ) && preservesProbeAnswers(answers, scenario, turns)
                    ? [{ source: turnIndex, insertion, turnMap }]
                    : [];
            },
        );
        if (candidates.length === 0) {
            return {
                applicable: false,
                reason:
                    rejected.length === 0
                        ? "no rejected proposal turn"
                        : "no rejected proposal insertion preserves contiguous gold ranges",
            };
        }
        const { source, insertion, turnMap } = pick(
            candidates,
            splitmix32(seed),
        );
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
const SYMBOL_RE =
    /`([^`]+)`|\b(?:[A-Za-z][A-Za-z0-9]*(?:[_./-][A-Za-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z]{2,})\b/g;

// Inline code is not necessarily a name: a backtick span can hold a command or
// an expression, and replacing the whole span would rewrite the instruction
// rather than rename an entity. Admitted backtick contents must therefore
// satisfy the same shape the unquoted alternatives accept.
const QUOTED_SYMBOL_RE =
    /^(?:[A-Za-z][A-Za-z0-9]*(?:[_./-][A-Za-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z]{2,})$/;

/** The renameable symbols of `text`, in match order. */
function symbolsIn(text: string): string[] {
    return [...text.matchAll(SYMBOL_RE)].flatMap((match) => {
        const quoted = match[1];
        if (quoted === undefined) return [match[0]];
        return QUOTED_SYMBOL_RE.test(quoted) ? [quoted] : [];
    });
}

/**
 * Symbols that occur only inside a backtick span the grammar rejects.
 *
 * The regex consumes a whole backtick span, so a rename cannot reach the tokens
 * inside one — and rewriting the other occurrences would leave the span naming
 * the old entity, splitting one entity into two names. Such a symbol is therefore
 * not renameable anywhere in the scenario.
 */
function shadowedSymbolsIn(text: string): string[] {
    return [...text.matchAll(SYMBOL_RE)].flatMap((match) => {
        const quoted = match[1];
        if (quoted === undefined || QUOTED_SYMBOL_RE.test(quoted)) return [];
        return symbolsIn(quoted);
    });
}

const renameUnrelatedSymbols: Transform = {
    id: "rename-unrelated-symbols",
    version: 1,
    alwaysApplicable: false,
    apply(scenario, rawSeed) {
        const seed = normalizedSeed(rawSeed);
        const messages = eligibleMessages(scenario);
        const eligibleKeys = new Set(
            messages.map((message) => `${message.turnIndex}:${message.role}`),
        );
        // Candidate spellings come from the text the historian receives: a symbol
        // that exists only inside a stripped reminder can be renamed without
        // changing the model input at all, and the derivative would carry no
        // perturbation to compare.
        const visibleText = new Map(
            visibleEvidenceMessages(scenario.transcript.turns).map(
                (message) => [
                    messageKey(message.turnIndex, message.role),
                    message.text,
                ],
            ),
        );
        const probeText = scenario.probes.flatMap((probe) => [
            probe.question,
            probe.answerType === "claim-id" ? "" : probe.goldAnswer,
            ...(probe.answerType === "multiple-choice" ? probe.choices : []),
        ]);
        const answers = probeAnswers(scenario);
        // Symbols that also occur in text the rename cannot touch stay out of the
        // candidate pool: renaming only some occurrences would name one entity
        // two ways. Probes count as untouchable text — a probe asking what
        // `buildAPI` returns against a history that now says `aux_symbol_N`
        // measures a broken query, not naming robustness.
        const allText = [
            ...scenario.transcript.turns.flatMap((turn) => [
                turn.user,
                turn.assistant,
            ]),
            ...probeText,
        ];
        const blocked = new Set([
            ...scenario.transcript.turns.flatMap((turn, turnIndex) =>
                (["user", "assistant"] as const).flatMap((role) =>
                    eligibleKeys.has(messageKey(turnIndex, role))
                        ? []
                        : // Both views: cleaning can join fragments into a symbol
                          // that never appears contiguously in the raw text, so a
                          // raw-only scan misses what the historian receives.
                          [
                              ...symbolsIn(turn[role]),
                              ...symbolsIn(
                                  visibleText.get(messageKey(turnIndex, role)) ?? "",
                              ),
                          ],
                ),
            ),
            ...probeText.flatMap((text) => symbolsIn(text)),
            ...allText.flatMap((text) => shadowedSymbolsIn(text)),
        ]);
        const candidates = [
            ...new Set(
                messages.flatMap((message) => {
                    // A candidate has to be present in BOTH views: the
                    // historian's, so renaming it changes the model input, and the
                    // raw text, so the replacement can find it at all — cleaning
                    // can join fragments into a symbol the raw string never spells.
                    const raw = new Set(symbolsIn(message.text));
                    return symbolsIn(
                        visibleText.get(
                            messageKey(message.turnIndex, message.role),
                        ) ?? "",
                    ).filter((symbol) => raw.has(symbol));
                }),
            ),
        ].filter(
            (symbol) =>
                !blocked.has(symbol) &&
                // A symbol can carry a probe answer without being one: renaming
                // `api/v2` deletes the complete-value occurrence of `api`.
                !answers.some((answer) => containsCompleteValue(symbol, answer)),
        );
        if (candidates.length === 0) {
            return {
                applicable: false,
                reason: "no unrelated symbol to rename",
            };
        }
        const next = splitmix32(seed);
        const original = pick(candidates, next);
        // A replacement that aliases a probe-only entity changes the
        // query-to-history relationship as surely as renaming one would, and one
        // aliasing a name that exists only inside a command span collides with an
        // entity the rename cannot even reach.
        const existing = new Set([
            ...allText.flatMap((text) => symbolsIn(text)),
            ...allText.flatMap((text) => shadowedSymbolsIn(text)),
        ]);
        const replacementStart = Math.floor(next() * 10_000);
        let replacement: string | undefined;
        for (let offset = 0; offset < 10_000; offset += 1) {
            const candidate = `aux_symbol_${(replacementStart + offset) % 10_000}`;
            // A generated name contains its own parts as complete values, so a
            // probe whose gold answer is one of them — `aux`, `symbol` — would find
            // the answer copyable from raw history the moment any rename lands.
            if (answers.some((answer) => containsCompleteValue(candidate, answer))) {
                continue;
            }
            if (candidate !== original && !existing.has(candidate)) {
                replacement = candidate;
                break;
            }
        }
        if (replacement === undefined) {
            return {
                applicable: false,
                reason: "no unused replacement symbol",
            };
        }
        const turns = scenario.transcript.turns.map((turn) => ({ ...turn }));
        for (const message of messages) {
            turns[message.turnIndex]![message.role] = message.text.replace(
                SYMBOL_RE,
                (matched, quoted: string | undefined) => {
                    if ((quoted ?? matched) !== original) return matched;
                    return quoted === undefined
                        ? replacement
                        : `\`${replacement}\``;
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
            return {
                applicable: false,
                reason: "rename does not fit the turn text limit",
            };
        }
        // A generated name can contain a predicate: a claim predicate of
        // `aux_symbol` is newly authored the moment a symbol becomes
        // `aux_symbol_1234`. Exact-spelling collision checks cannot see that, and
        // the derivative stays lint-clean because the required occurrence still
        // exists elsewhere, so the rewritten turns are proven against the same
        // evidence comparison the framing and reordering transforms use.
        const turnMap = scenario.transcript.turns.map((_, index) => index);
        if (
            !preservesEvidenceExactly(
                evidenceBaselines(scenario),
                turns,
                turnMap,
            ) ||
            !preservesProbeAnswers(answers, scenario, turns)
        ) {
            return {
                applicable: false,
                reason: "rename would change authored evidence",
            };
        }
        if (!changesVisibleTranscript(scenario, turns)) {
            return {
                applicable: false,
                reason: "rename leaves the historian input unchanged",
            };
        }
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

export const ALWAYS_APPLICABLE_TRANSFORM_IDS: readonly string[] =
    TRANSFORMS.filter((transform) => transform.alwaysApplicable).map(
        (transform) => transform.id,
    );
