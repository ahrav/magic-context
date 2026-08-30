import { splitmix32 } from "../../../plugin/scripts/retrieval-benchmark/synthetic";
import {
    COMMIT_HASH_TEST_PATTERN,
    COMMIT_VERB_PATTERN,
} from "../../../plugin/src/shared/commit-detection";
import { OMO_INTERNAL_INITIATOR_MARKER } from "../../../plugin/src/shared/internal-initiator-marker";
import {
    MAX_TRANSCRIPT_TURNS,
    MAX_TURN_TEXT_CHARS,
    authoredEvidenceText,
    compactedEvidenceMessages,
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
 * The first candidate a seed reaches whose derivative the contract accepts.
 *
 * Proving a candidate costs a full evidence scan, and a scenario at the transcript
 * and expectation limits generates thousands of them, so proving the whole list to
 * use one of them is the dominant cost of an application. Probing from a
 * seed-chosen offset and stopping at the first success keeps the usual case at one
 * proof while leaving the worst case — nothing acceptable — no worse than
 * filtering. The offset makes the choice seed-stable, and the wrap makes it
 * exhaustive.
 *
 * Probing all the way through construction, rather than stopping at a validator
 * and building once, is what keeps one unusable candidate from spending the
 * application: a turn whose duplication would overrun the chunk budget no longer
 * hides a shorter one that fits.
 *
 * When nothing succeeds, a contract violation is reported ahead of an ordinary
 * rejection: it is the louder signal, and the corpus guard looks for it.
 */
function firstDerivative<T>(
    candidates: readonly T[],
    next: () => number,
    exhaustedReason: string,
    build: (candidate: T) => TransformResult,
): TransformResult {
    if (candidates.length === 0) return { applicable: false, reason: exhaustedReason };
    const start = Math.floor(next() * candidates.length);
    let rejection: string | undefined;
    let violation: string | undefined;
    for (let offset = 0; offset < candidates.length; offset += 1) {
        const result = build(candidates[(start + offset) % candidates.length]!);
        if (result.applicable) return result;
        rejection = result.reason;
        if (violation === undefined && result.reason.startsWith(CONTRACT_VIOLATION_REASON)) {
            violation = result.reason;
        }
    }
    return { applicable: false, reason: violation ?? rejection ?? exhaustedReason };
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
 * The lint diagnostics a scenario already carries, keyed for comparison.
 *
 * Enumerated once per application and handed to every `derivative()` call: linting
 * the unchanged source runs the whole freeze battery, token budget included, and an
 * exhaustive candidate probe would otherwise repeat it for every candidate.
 */
function inheritedDiagnostics(scenario: HistorianEvalScenario): ReadonlySet<string> {
    return new Set(
        lintScenario(scenario).map((diagnostic) => diagnosticKey(diagnostic, scenario.id)),
    );
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
    inherited: ReadonlySet<string>,
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
function matchCounts(
    entries: readonly { id: string; predicate: ContentPredicate }[],
    turns: readonly TranscriptTurn[],
): Map<string, number> {
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
    const counts = new Map<string, number>();
    for (const entry of entries) {
        const needle = normalizeContent(entry.predicate.value);
        if (needle.length === 0) continue;
        // Spans are ordered and occurrences are found in order, so the first span an
        // occurrence can touch never moves backwards. Aggregating identical
        // signatures rather than listing every occurrence keeps a one-character
        // predicate against a long transcript from materializing hundreds of
        // thousands of strings and rescanning every span for each of them.
        let first = 0;
        for (
            let at = evidence.indexOf(needle);
            at !== -1;
            at = evidence.indexOf(needle, at + 1)
        ) {
            const matchEnd = at + needle.length;
            while (first < spans.length && spans[first]!.end <= at) first += 1;
            const crossed: string[] = [];
            for (let index = first; index < spans.length; index += 1) {
                const span = spans[index]!;
                if (span.start >= matchEnd) break;
                crossed.push(span.key);
            }
            const signature = `${entry.id}|${crossed.join(",")}`;
            counts.set(signature, (counts.get(signature) ?? 0) + 1);
        }
    }
    return counts;
}

/** Messages that authored negative evidence runs through. */
function absentEvidenceMessages(scenario: HistorianEvalScenario): Set<string> {
    return new Set(
        [...matchCounts(scenario.gold.expectedAbsent, scenario.transcript.turns).keys()].flatMap(
            (match) => match.slice(match.indexOf("|") + 1).split(","),
        ),
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
    // The compacted view, which is the content the chunk builder actually emits.
    // Case-preserving on purpose — two turns differing only in an identifier's case
    // are different inputs even though the predicate matcher folds them together —
    // but commit hashes are compaction's business: it lifts them into lowercased
    // metadata, so two spellings of one hash are the same input and swapping them
    // changes nothing.
    return compactedEvidenceMessages(turns)
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
    /** Occurrence signature to how many times it occurs. */
    matches: ReadonlyMap<string, number>;
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
        matches: matchCounts(entries, scenario.transcript.turns),
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

/** The turn indexes an occurrence signature runs through. */
function matchTurns(match: string): number[] {
    return match
        .slice(match.indexOf("|") + 1)
        .split(",")
        .map((key) => Number(key.slice(0, key.indexOf(":"))));
}

/** An occurrence signature with its turn indexes mapped through `turnMap`. */
function remapMatch(match: string, turnMap: readonly number[]): string {
    const separator = match.indexOf("|");
    return `${match.slice(0, separator)}|${match
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
    const remaining = new Map(matchCounts(baseline.entries, turns));
    let lost = 0;
    for (const [match, occurrences] of baseline.matches) {
        const expected = remapMatch(match, turnMap);
        const available = remaining.get(expected) ?? 0;
        const matched = Math.min(available, occurrences);
        lost += occurrences - matched;
        remaining.set(expected, available - matched);
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

/** A probe's answer and the turn range whose text backs it. */
interface ProbeAnswer {
    answer: string;
    range: readonly [number, number];
}

/**
 * The answers a probe could copy out of raw history, with the range that backs each.
 *
 * The backing range is what injection replaces, so an occurrence inside it is not
 * copyable — the probe is supposed to need the injected claim to answer. Only
 * occurrences outside it are leakage, which is why the range travels with the
 * answer.
 */
function probeAnswers(scenario: HistorianEvalScenario): ProbeAnswer[] {
    const ranges = new Map(
        scenario.gold.expectedClaims.map((claim) => [claim.id, claim.sourceTurnRange]),
    );
    return scenario.probes.flatMap((probe) => {
        if (probe.answerType === "claim-id") return [];
        const range = ranges.get(probe.sourceClaimRef);
        return range === undefined ? [] : [{ answer: probe.goldAnswer, range }];
    });
}

/**
 * Evidence text with the turns in `excluded` replaced, so an occurrence touching
 * one of them is not counted.
 *
 * Replaced rather than dropped: removing a turn would let its neighbours become
 * adjacent and author a formation neither side had.
 */
const RANGE_SENTINEL = "zzmetamorphicrangesentinelzz";

function evidenceOutside(
    turns: readonly TranscriptTurn[],
    excluded: (index: number) => boolean,
): string {
    return authoredEvidenceText(
        turns.map((turn, index) =>
            excluded(index)
                ? { user: RANGE_SENTINEL, assistant: RANGE_SENTINEL }
                : turn,
        ),
    );
}

/**
 * Whether the derivative leaves each probe answer exactly as copyable as the source.
 *
 * Counted outside the range that backs the answer, not over the whole transcript: a
 * reordering can move an occurrence off a protected boundary and into wholly
 * unprotected history while the total stays the same, which turns a non-copyable
 * occurrence into a copyable one. Adding a copyable occurrence hands the probe its
 * answer without retrieval; removing one changes what the leakage gate sees. The
 * expected-claim comparison cannot stand in for either — a turn can carry the answer
 * `4096` without matching the claim predicate `capacity is 4096`.
 */
function preservesProbeAnswers(
    answers: readonly ProbeAnswer[],
    scenario: HistorianEvalScenario,
    turns: readonly TranscriptTurn[],
    turnMap: readonly number[],
): boolean {
    return answers.every(({ answer, range }) => {
        const inSource = (index: number) => index >= range[0] && index <= range[1];
        const mapped = new Set(
            scenario.transcript.turns.flatMap((_, index) =>
                inSource(index) ? [turnMap[index]!] : [],
            ),
        );
        return (
            countCompleteValues(
                evidenceOutside(turns, (index) => mapped.has(index)),
                answer,
            ) ===
            countCompleteValues(evidenceOutside(scenario.transcript.turns, inSource), answer)
        );
    });
}

/**
 * The evidence a duplication is allowed to produce, and nothing else.
 *
 * Copying turn `source` to `insertion` should repeat exactly the rejection
 * occurrences that turn carries on its own, at the copy's position. Permitting any
 * gain across the rejection baseline is too loose: the copy creates a new boundary
 * between the turn's own end and its own beginning, and a suffix and prefix that
 * form a different forbidden formation would strengthen a second proposal the
 * transform makes no claim about. Every other kind of evidence is held exactly, so
 * a copied turn cannot author an accepted claim or another negative family either.
 */
function preservesEvidenceForDuplication(
    baselines: EvidenceBaselines,
    turns: readonly TranscriptTurn[],
    turnMap: readonly number[],
    source: number,
    insertion: number,
): boolean {
    const expected = new Map<string, number>();
    const add = (match: string, times: number) =>
        expected.set(match, (expected.get(match) ?? 0) + times);
    for (const [match, occurrences] of baselines.rejected.matches) {
        add(remapMatch(match, turnMap), occurrences);
        // An occurrence wholly inside the copied turn appears once more, at the copy.
        // Wholly, not singly: a formation spanning the turn's user and assistant
        // names that turn twice, and requiring a single index would drop the expected
        // copy and reject the very candidate the transform exists to make.
        const crossedTurns = matchTurns(match);
        if (crossedTurns.every((turnIndex) => turnIndex === source)) {
            add(
                remapMatch(
                    match,
                    turnMap.map((_, index) => (index === source ? insertion : -1)),
                ),
                occurrences,
            );
        }
    }
    const actual = matchCounts(baselines.rejected.entries, turns);
    if (expected.size !== actual.size) return false;
    for (const [match, count] of expected) {
        if (actual.get(match) !== count) return false;
    }
    return [baselines.otherAbsent, baselines.claims].every((baseline) => {
        const { lost, gained } = matchDelta(baseline, turns, turnMap);
        return lost === 0 && gained === 0;
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
        const inherited = inheritedDiagnostics(scenario);
        return firstDerivative(
            pairs,
            splitmix32(seed),
            "no irrelevant message to paraphrase",
            ({ message, text }) => {
                if (!safeParaphrase(scenario, baselines, message, text)) {
                    return {
                        applicable: false,
                        reason: "no irrelevant message to paraphrase",
                    };
                }
                return derivative(
                    scenario,
                    inherited,
                    this,
                    seed,
                    replaceMessage(scenario.transcript.turns, message, text),
                    scenario.transcript.epilogueStartIndex,
                    scenario.transcript.turns.map((_, index) => index),
                );
            },
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
    // Counted over the historian-visible transcript, not the raw message: an
    // answer sitting inside a stripped reminder is not something the probe can
    // copy, so treating it as pre-existing would let the framing add the first
    // occurrence the historian actually receives.
    return preservesProbeAnswers(
        probeAnswers(scenario),
        scenario,
        turns,
        scenario.transcript.turns.map((_, index) => index),
    );
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
        const inherited = inheritedDiagnostics(scenario);
        const answers = probeAnswers(scenario);
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
        const exhausted = "no independent adjacent turns before epilogue";
        return firstDerivative(candidates, splitmix32(seed), exhausted, (order) => {
            const reordered = reorderedTurns(scenario, order);
            if (
                !preservesEvidenceExactly(baselines, reordered, mapForOrder(order)) ||
                !preservesProbeAnswers(answers, scenario, reordered, mapForOrder(order)) ||
                !changesVisibleTranscript(scenario, reordered)
            ) {
                return { applicable: false, reason: exhausted };
            }
            return derivative(
                scenario,
                inherited,
                this,
                seed,
                reordered,
                scenario.transcript.epilogueStartIndex,
                mapForOrder(order),
            );
        });
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
        const inherited = inheritedDiagnostics(scenario);
        const answers = probeAnswers(scenario);
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
        const exhausted = "no movable single-turn accepted decision before epilogue";
        return firstDerivative(candidates, splitmix32(seed), exhausted, ({ order }) => {
            const reordered = reorderedTurns(scenario, order);
            if (
                !preservesEvidenceExactly(baselines, reordered, mapForOrder(order)) ||
                !preservesProbeAnswers(answers, scenario, reordered, mapForOrder(order)) ||
                !changesVisibleTranscript(scenario, reordered)
            ) {
                return { applicable: false, reason: exhausted };
            }
            return derivative(
                scenario,
                inherited,
                this,
                seed,
                reordered,
                scenario.transcript.epilogueStartIndex,
                mapForOrder(order),
            );
        });
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
        const inherited = inheritedDiagnostics(scenario);
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
                matchCounts(rejected, [turn]).size > 0 ? [turnIndex] : [],
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
                return [{ source: turnIndex, insertion, turnMap }];
            },
        );
        return firstDerivative(
            candidates,
            splitmix32(seed),
            rejected.length === 0
                ? "no rejected proposal turn"
                : "no rejected proposal insertion preserves contiguous gold ranges",
            ({ source, insertion, turnMap }) => {
                const turns = duplicatedTurns(scenario, source, insertion);
                // Proved here rather than while building the candidate list: each
                // proof rescans the transcript for every rejected, other-absent, and
                // claim predicate, and near the contract limits there are enough
                // candidates that proving all of them to use one dominates the
                // application.
                if (
                    !preservesEvidenceForDuplication(
                        baselines,
                        turns,
                        turnMap,
                        source,
                        insertion,
                    ) ||
                    !preservesProbeAnswers(answers, scenario, turns, turnMap)
                ) {
                    return {
                        applicable: false,
                        reason: "no rejected proposal insertion preserves contiguous gold ranges",
                    };
                }
                return derivative(
                    scenario,
                    inherited,
                    this,
                    seed,
                    turns,
                    epilogueStartIndexAfter(scenario, insertion),
                    turnMap,
                );
            },
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
/**
 * Whether `symbol` is used as a markup element name — `<symbol>` or `</symbol>`.
 *
 * Production strips `<system-reminder>` blocks from user text, so renaming the tag
 * name rewrites the delimiter rather than an entity: the block stops being
 * recognised and text the baseline hid reaches the historian.
 */
function isMarkupName(symbol: string, text: string): boolean {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // An element name, or the internal-initiator marker production strips by exact
    // string: renaming either rewrites the structure rather than an entity, and the
    // text it delimited then reaches the historian.
    return (
        new RegExp(`</?${escaped}\\s*>`, "i").test(text) ||
        (OMO_INTERNAL_INITIATOR_MARKER.includes(symbol) &&
            text.includes(OMO_INTERNAL_INITIATOR_MARKER))
    );
}

/** Generated replacement names, and the pattern that finds one already taken. */
const REPLACEMENT_PREFIX = "aux_symbol_";
const REPLACEMENT_SPACE = 10_000;
const TAKEN_REPLACEMENT_RE = new RegExp(
    `(?<![\\p{L}\\p{N}])${REPLACEMENT_PREFIX}\\d+(?![\\p{L}\\p{N}])`,
    "gu",
);

const QUOTED_SYMBOL_RE =
    /^(?:[A-Za-z][A-Za-z0-9]*(?:[_./-][A-Za-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z]{2,})$/;

/**
 * A name with more separator-delimited parts than this is not treated as a name.
 *
 * The containment analysis below is quadratic in a candidate's own part count, and
 * a legal message may hold twenty thousand characters of separators. Refusing such
 * a spelling costs nothing real — nothing anyone renames looks like that — and
 * bounds the work.
 */
const MAX_SYMBOL_PARTS = 32;

/** The separator class the symbol grammar and every boundary check share. */
const SYMBOL_SEPARATOR_RE = /[_./-]/;

/** A symbol split into its parts, with the offset each part starts at. */
function symbolParts(symbol: string): { parts: string[]; offsets: number[] } {
    const pieces = symbol.split(/([_./-])/);
    const parts: string[] = [];
    const offsets: number[] = [];
    let offset = 0;
    for (let index = 0; index < pieces.length; index += 1) {
        if (index % 2 === 0) {
            parts.push(pieces[index]!);
            offsets.push(offset);
        }
        offset += pieces[index]!.length;
    }
    return { parts, offsets };
}

/**
 * The symbol and the parts a separator divides it into.
 *
 * A probe naming one part refers to the whole entity — a question about the `api`
 * endpoint is about `api/v2` — so each part is checked against probe text as well
 * as the full spelling.
 */
function symbolSegments(symbol: string): string[] {
    return [...new Set([symbol, ...symbol.split(/[_./-]/).filter((part) => part.length > 0)])];
}

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
        // Raw text, probe text, and the cleaned view together. Cleaning changes what
        // a scan can see in both directions: it can join fragments into a symbol the
        // raw string never spells, and it can turn a fragmented command span into a
        // recognisable one whose contents the rename cannot reach.
        const collisionText = [...allText, ...visibleText.values()];
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
            ...collisionText.flatMap((text) => shadowedSymbolsIn(text)),
        ]);
        // Commit-hash spellings are collected across the whole transcript before the
        // pool is formed: admission is per occurrence and then unioned, so the same
        // spelling appearing in one message without a commit verb would re-enable a
        // revision identifier another message uses as one, and the replacement runs
        // over every occurrence.
        // Markup names, like commit hashes, are collected before the pool is formed:
        // admission is per occurrence and then unioned, so one message mentioning
        // `system-reminder` as prose would admit a spelling another message uses as a
        // delimiter — and the replacement rewrites every occurrence.
        const markupNames = new Set(
            scenario.transcript.turns.flatMap((turn) =>
                (["user", "assistant"] as const).flatMap((role) =>
                    symbolsIn(turn[role]).filter((symbol) => isMarkupName(symbol, turn[role])),
                ),
            ),
        );
        const commitHashes = new Set(
            scenario.transcript.turns.flatMap((turn, turnIndex) =>
                (["user", "assistant"] as const).flatMap((role) => {
                    const text = visibleText.get(messageKey(turnIndex, role)) ?? "";
                    if (role !== "assistant" || !COMMIT_VERB_PATTERN.test(text)) return [];
                    return symbolsIn(text).filter((symbol) =>
                        COMMIT_HASH_TEST_PATTERN.test(symbol),
                    );
                }),
            ),
        );
        // Every spelling on the collision surface, including the ones inside command
        // spans the rename cannot edit: a compound sharing a name with a bare symbol
        // splits the entity whether or not the rename can reach both halves.
        const surfaceSymbols = new Set([
            ...collisionText.flatMap((text) => symbolsIn(text)),
            ...collisionText.flatMap((text) => shadowedSymbolsIn(text)),
        ]);
        // Indexed by part, not scanned per candidate: a containment can only start
        // where a part matches, and a legal transcript may hold thousands of
        // identifiers — the cross product was about a hundred million comparisons.
        const byPart = new Map<string, Array<{ symbol: string; offset: number }>>();
        for (const symbol of surfaceSymbols) {
            const layout = symbolParts(symbol);
            layout.parts.forEach((part, index) => {
                const at = byPart.get(part);
                const entry = { symbol, offset: layout.offsets[index]! };
                if (at === undefined) byPart.set(part, [entry]);
                else at.push(entry);
            });
        }
        /**
         * Whether renaming `symbol` alone would leave another spelling of the same
         * entity behind.
         *
         * Both directions: another symbol may contain this one — `buildAPI/v2`
         * against a bare `buildAPI` — or this one may contain another that stands on
         * its own, which the exact-match replacement would leave untouched.
         */
        const sharesAnEntity = (symbol: string): boolean => {
            const layout = symbolParts(symbol);
            if (layout.parts.length > MAX_SYMBOL_PARTS) return true;
            for (const { symbol: other, offset } of byPart.get(layout.parts[0]!) ?? []) {
                if (other === symbol) continue;
                if (!other.startsWith(symbol, offset)) continue;
                const after = other.charAt(offset + symbol.length);
                if (after === "" || SYMBOL_SEPARATOR_RE.test(after)) return true;
            }
            for (let first = 0; first < layout.parts.length; first += 1) {
                for (let last = first; last < layout.parts.length; last += 1) {
                    const end =
                        last + 1 < layout.offsets.length
                            ? layout.offsets[last + 1]! - 1
                            : symbol.length;
                    const spelling = symbol.slice(layout.offsets[first]!, end);
                    if (spelling !== symbol && surfaceSymbols.has(spelling)) return true;
                }
            }
            return false;
        };
        const candidates = [
            ...new Set(
                messages.flatMap((message) => {
                    // Production reads a hash-shaped token in a commit sentence as
                    // commit metadata and lifts it out of the assistant summary, so
                    // renaming it deletes the revision the block refers to rather
                    // than exercising an unrelated identifier.
                    const visibleMessage =
                        visibleText.get(
                            messageKey(message.turnIndex, message.role),
                        ) ?? "";
                    const commitContext =
                        message.role === "assistant" &&
                        COMMIT_VERB_PATTERN.test(visibleMessage);
                    // A candidate has to be present in BOTH views: the
                    // historian's, so renaming it changes the model input, and the
                    // raw text, so the replacement can find it at all — cleaning
                    // can join fragments into a symbol the raw string never spells.
                    const raw = new Set(symbolsIn(message.text));
                    return symbolsIn(visibleMessage).filter(
                        (symbol) =>
                            raw.has(symbol) &&
                            !(commitContext && COMMIT_HASH_TEST_PATTERN.test(symbol)),
                    );
                }),
            ),
        ].filter(
            (symbol) =>
                !blocked.has(symbol) &&
                !commitHashes.has(symbol) &&
                // Renaming a markup name rewrites the delimiter, not an entity:
                // `<system-reminder>` becomes `<aux_symbol_N>`, production stops
                // stripping the block, and text the baseline hid reaches the
                // historian.
                !markupNames.has(symbol) &&
                // A commit verb is what makes production read the hash beside it as
                // commit metadata, so renaming the verb changes the block's meaning
                // as surely as renaming the hash would.
                !COMMIT_VERB_PATTERN.test(symbol) &&
                !sharesAnEntity(symbol) &&
                // A symbol can carry a probe answer without being one: renaming
                // `api/v2` deletes the complete-value occurrence of `api`.
                !answers.some(({ answer }) => containsCompleteValue(symbol, answer)),
        );
        const next = splitmix32(seed);
        // Enumerated once: the source side does not vary across candidates, and an
        // exhaustive probe would otherwise rescan the whole transcript for every
        // claim and absent predicate on each failed candidate.
        const baselines = evidenceBaselines(scenario);
        const inherited = inheritedDiagnostics(scenario);
        // A replacement that aliases a probe-only entity changes the
        // query-to-history relationship as surely as renaming one would, and one
        // aliasing a name that exists only inside a command span collides with an
        // entity the rename cannot even reach.
        const existing = new Set([
            ...collisionText.flatMap((text) => symbolsIn(text)),
            ...collisionText.flatMap((text) => shadowedSymbolsIn(text)),
        ]);
        // Extracted spellings are not the whole answer: `aux_symbol_1234/v2` yields
        // only the full path, while `aux_symbol_1234` names the same entity and is a
        // complete value inside it. Scanned once for the whole family rather than
        // asked per candidate: `containsCompleteValue` normalizes its whole input,
        // and a transcript carrying many compound names would renormalize a
        // six-figure corpus ten thousand times over.
        const taken = new Set([
            ...existing,
            ...[
                ...normalizeContent(collisionText.join("\n")).matchAll(TAKEN_REPLACEMENT_RE),
            ].map((match) => match[0]),
        ]);
        // Two free names, found once on first use. Whether a free name exists is a
        // property of the scenario, not of the symbol being renamed, so searching per
        // candidate would repeat the whole walk for every one of them — and two is all
        // the per-candidate part needs, since its only rule is that the replacement
        // differ from the symbol it displaces. Deferred rather than eager so the draw
        // order stays candidate-offset first, which is what makes a given seed pick
        // the same symbol it always did.
        let free: string[] | undefined;
        const freeReplacements = (): string[] => {
            if (free !== undefined) return free;
            const start = Math.floor(next() * REPLACEMENT_SPACE);
            free = [];
            for (let offset = 0; offset < REPLACEMENT_SPACE && free.length < 2; offset += 1) {
                const candidate = `${REPLACEMENT_PREFIX}${(start + offset) % REPLACEMENT_SPACE}`;
                // A generated name contains its own parts as complete values, so a
                // probe whose gold answer is one of them — `aux`, `symbol` — would
                // find the answer copyable from raw history the moment a rename lands.
                if (answers.some(({ answer }) => containsCompleteValue(candidate, answer))) {
                    continue;
                }
                if (!taken.has(candidate)) free.push(candidate);
            }
            return free;
        };
        // Probed rather than picked: a symbol can pass candidate selection and still
        // fail the length, evidence, or orphaned-probe check, and discarding the
        // application for it would drop coverage another symbol would have provided.
        return firstDerivative(
            candidates,
            next,
            "no unrelated symbol to rename",
            (original) => {
                const replacement = freeReplacements().find(
                    (candidate) => candidate !== original,
                );
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
                !preservesEvidenceExactly(baselines, turns, turnMap) ||
                !preservesProbeAnswers(answers, scenario, turns, turnMap)
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
            // A probe can name an entity by one part of a symbol — a question about the
            // `api` endpoint refers to `api/v2` — and renaming it would leave the
            // question asking about something the history no longer mentions. Checked
            // against the derivative rather than by blocking the candidate outright,
            // because a part is often an ordinary word: `webhook` is a part of
            // `webhook_setup`, and a scenario about webhooks says it in many places, so
            // blocking on mention alone would freeze symbols the probe is not naming.
            const orphanedTerm = symbolSegments(original).some(
                (segment) =>
                    probeText.some((text) => containsCompleteValue(text, segment)) &&
                    countCompleteValues(authoredEvidenceText(scenario.transcript.turns), segment) > 0 &&
                    countCompleteValues(authoredEvidenceText(turns), segment) === 0,
            );
            if (orphanedTerm) {
                return {
                    applicable: false,
                    reason: "rename would leave a probe naming an absent entity",
                };
            }
            return derivative(
                    scenario,
                    inherited,
                    this,
                    seed,
                    turns,
                    scenario.transcript.epilogueStartIndex,
                    turnMap,
                );
            },
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
