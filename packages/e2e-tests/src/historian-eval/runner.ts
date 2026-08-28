/**
 * Historian structural eval lane — replay runner (U2).
 *
 * Drives one scenario end-to-end through the REAL historian path: the e2e
 * harness boots `opencode serve`, the MockProvider scripts every main-agent
 * turn of the authored transcript, and the historian agent routes either to
 * a live model (operator runs) or to a scripted matcher (deterministic
 * tests). Everything scoring needs is captured into a run record; infra
 * failures are separated from model behavior (R6): they surface as a run
 * record `error`, never as a scored FAIL.
 *
 * Fresh temp environment per attempt (KTD9): each `runScenario` call boots
 * its own harness, and an artifact directory that already holds a run record
 * is refused — retrying in a reused environment would replay stale
 * idempotency receipts and score first-attempt state.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    extractLatestAssistantText,
} from "../../../plugin/src/shared/assistant-message-extractor";
import { extractLatestHistorianReasoning } from "../../../plugin/src/hooks/magic-context/compartment-runner-historian";
import { hasClaimMemoryFragment } from "../../../plugin/src/features/magic-context/memory/storage-claim-current-state";
import { resolveProjectIdentity } from "../../../plugin/src/features/magic-context/memory/project-identity";
import { createClaimMemorySchema } from "../../../plugin/src/features/magic-context/storage-claim-memory-schema";
import {
    INTERNAL_OPENCODE_AGENT_SIGNATURES,
    MAGIC_CONTEXT_INTERNAL_AGENT_SIGNATURES,
} from "../../../plugin/src/hooks/magic-context/internal-agent-signatures";
import { openTestDb } from "../test-db";
import { TestHarness, type TestHarnessOptions } from "../harness";
import { MockProvider, type MockResponse } from "../mock-provider/server";
import {
    EXECUTE_THRESHOLD_PERCENTAGE,
    FILLER_TURN,
    MAX_PADDING_TURNS,
    MIN_BUILD_TURNS,
    PROBE_CHOICE_SEPARATOR,
    containsCompleteValue,
    matchesGold,
    scenarioFingerprint,
    triggerFingerprint,
    triggerTurnUsage,
    type HistorianEvalScenario,
    type Probe,
} from "./contract";
import { ballastProse } from "../ballast";
import { deriveProtectedTailTokenTarget } from "../../../plugin/src/hooks/magic-context/protected-tail-boundary";
import {
    deriveHistorianChunkTokens,
    resolveHistorianContextLimit,
} from "../../../plugin/src/hooks/magic-context/derive-budgets";
import { promotionEvidenceCount, readInjectedClaims, type InjectedClaimRecord } from "./claim-read";
import { verifyAllActiveClaims } from "./verification-bridge";

export type { InjectedClaimRecord } from "./claim-read";

export const RUN_RECORD_SCHEMA = "historian-eval-run-record/v1";

/**
 * The canonical internal-agent signature containing `needle`. Request routing
 * keys off production's exported signature list rather than a local copy, so a
 * prompt rewording surfaces as a loud module-load failure here instead of
 * silently misrouting every scenario into script-drift ERRORs.
 */
function requireSignature(signatures: readonly string[], needle: string): string {
    const found = signatures.find((signature) => signature.includes(needle));
    if (found === undefined) {
        throw new Error(`historian-eval: no internal-agent signature contains "${needle}"`);
    }
    return found;
}

/**
 * Marker-based historian request detection (pattern proven by
 * tests/historian-success.test.ts). The historian's system prompt carries
 * this signature line; its user content carries the `<new_messages>` block.
 */
const HISTORIAN_SYSTEM_MARKER = requireSignature(MAGIC_CONTEXT_INTERNAL_AGENT_SIGNATURES, "Historian");

/** OpenCode's auxiliary title-generation agent, from the canonical signature list. */
const TITLE_SYSTEM_MARKER = requireSignature(INTERNAL_OPENCODE_AGENT_SIGNATURES, "title generator");



/**
 * Ordinals the scenario's authored turns occupy in the rendered transcript.
 *
 * Harness-owned filler turns precede the authored ones whenever the scenario is
 * shorter than `MIN_BUILD_TURNS`, so the layout is fully determined by the
 * scenario and nothing else. Exported because the scorer validates a stored
 * record's `authoredTurnOrdinals` against it: that field decides which
 * compartments count toward gold's minimum, and a second derivation of the same
 * layout is how the two could disagree about which rows are authored.
 */
export function authoredTurnOrdinalsFor(scenario: HistorianEvalScenario): Array<[number, number]> {
    const fillerCount = Math.max(0, MIN_BUILD_TURNS - scenario.transcript.turns.length);
    return scenario.transcript.turns.map((_, index) => {
        const userOrdinal = (fillerCount + index) * 2 + 1;
        return [userOrdinal, userOrdinal + 1];
    });
}

const POISON_TEXT = "HISTORIAN-EVAL-POISON: unscripted main-agent turn reached the default response";

/** Infra causes (R6). None of these may be attributed to historian quality. */
export type RunErrorReason =
    | "lease-lost"
    | "no-op-promotion"
    | "fallback-engaged"
    | "script-drift"
    | "gold-range-leak"
    | "stale-snapshot"
    | "run-never-fired"
    | "probe-envelope-malformed"
    | "probe-gold-uncovered"
    | "probe-response-leak"
    | "probe-tool-use"
    | "harness-failure";

export interface RunRecordError {
    reason: RunErrorReason;
    detail: string;
}

/** Per historian run: the raw output artifact plus healing evidence (R9). */
export interface HistorianRunArtifact {
    runIndex: number;
    /** Raw output text, extracted exactly as production validated it (KTD5). */
    rawOutput: string | null;
    status: "success" | "failed" | "noop";
    failureReason: string | null;
    repairUsed: boolean;
    attemptCount: number;
    discardedLast: boolean;
    /** chunkEndOrdinal - max persisted compartment end; null when unknowable. */
    lookaheadMargin: number | null;
    emittedCompartments: number;
    persistedCompartments: number;
    factsEmitted: number;
    chunkStartOrdinal: number | null;
    chunkEndOrdinal: number | null;
    /**
     * Promotion evidence this run added under the scenario's project — claims
     * created plus evidence rows attached to existing ones.
     *
     * Recorded per run because a scenario-wide count cannot separate them: run 1
     * promoting successfully leaves the total non-zero, so run 2's silently
     * skipped promotion passes the plumbing guard and its missing fact is then
     * charged to historian recall instead. Evidence attachments count because a
     * fact an earlier run already promoted is deduplicated onto that claim rather
     * than creating another.
     */
    promotionEvidenceAdded: number;
}

/**
 * A later probe's gold answer stated in the text OUTSIDE this response's answer
 * envelope, or null.
 *
 * `extractAnswerEnvelope` requires exactly one envelope and ignores everything
 * around it, which is deliberate — a model that prefixes "Sure, here you go" has
 * still answered, and failing the turn on that would convert ordinary chattiness
 * into `probe-envelope-malformed`. But probes share one resumed session and probe
 * turns are not compartment-covered, so an assistant reply stays raw in the
 * history the NEXT probe reads. Commentary that happens to state a later probe's
 * answer therefore hands it over, and no other gate covers it: `goldRangeLeak`
 * searches for authored TRANSCRIPT text, and the freeze-time probe guards cannot
 * know what the model will volunteer.
 *
 * Scoped to the answer's own envelope being excluded and to LATER probes only,
 * for the same reasons the freeze-time guard is: this probe's own answer inside
 * its envelope is the point of the exchange, and a probe already asked cannot be
 * influenced by a reply that comes after it.
 *
 * Complete values, so a reply mentioning "4096" does not count as stating the
 * answer "4".
 */
export function probeResponseLeak(args: {
    probes: readonly Probe[];
    probeIndex: number;
    responseText: string | null;
}): string | null {
    const { probes, probeIndex, responseText } = args;
    if (responseText === null) return null;
    const outside = responseText.replace(/<answer>[\s\S]*?<\/answer>/g, " ");
    for (const later of probes.slice(probeIndex + 1)) {
        if (later.answerType === "claim-id") continue;
        if (containsCompleteValue(outside, later.goldAnswer)) {
            return `response text outside the answer envelope states ${JSON.stringify(later.goldAnswer)}, which is a later probe's (${later.id}) gold answer`;
        }
    }
    return null;
}

export interface ProbeExchange {
    probeId: string;
    /** Envelope contents of the final answer attempt; null when malformed twice. */
    answerRaw: string | null;
    reAsked: boolean;
    /** revisionLocators recorded as injected for the probe turn. */
    injectedRevisionLocators: string[];
    /** Captured probe-turn request payload (mock-captured; null on live routes). */
    payloadText: string | null;
    /**
     * Assistant text the answer was extracted from.
     *
     * `answerRaw` is a derivation, and on its own an unfalsifiable one: rescoring
     * a stored record trusted it as the model's response with nothing to check it
     * against, so editing a wrong answer to the gold value turned a probe FAIL
     * into a PASS while every integrity check still passed. Keeping the response
     * makes the extraction reproducible, so the two must agree.
     */
    responseText: string | null;
}

export interface SystemVersionTuple {
    repoCommitSha: string;
    historianModelId: string;
    probeModelId: string;
    parserImpl: "ts";
    chunkTokenBudget: number | null;
}

export interface PerGoldPredicateCount {
    expectedClaimId: string;
    claimCount: number;
    revisionCount: number;
}

export interface HistorianEvalRunRecord {
    schema: typeof RUN_RECORD_SCHEMA;
    scenarioId: string;
    scenarioFingerprint: string;
    /**
     * Fingerprint of the trigger recipe this attempt executed under.
     *
     * Stored beside `scenarioFingerprint` rather than folded into it: the
     * scenario fingerprint is the release-facing semantic identity approvals bind
     * to, and trigger pressure is harness-owned, so moving it there would
     * invalidate approvals on a pressure retune. Recorded separately, the values
     * still bind an artifact to the recipe that produced it. See
     * `triggerFingerprint`.
     */
    triggerFingerprint: string;
    sessionId: string;
    /** Workspace identity claims were promoted under; scoring reads need it. */
    projectIdentity: string;
    /** Wall clock pinned at capture time; every scorer read threads this (KTD1). */
    nowMs: number;
    system: SystemVersionTuple;
    expectedHistorianRuns: number;
    historianRuns: HistorianRunArtifact[];
    /** Ordinal of each authored turn's [user, assistant] message. */
    authoredTurnOrdinals: Array<[number, number]>;
    perGoldPredicate: PerGoldPredicateCount[];
    injectedClaims: InjectedClaimRecord[];
    probes: ProbeExchange[];
    /** Claims verified by the lane-owned verification bridge (0 in ERROR records). */
    verifiedClaimCount: number;
    contextDbSnapshotPath: string;
    error: RunRecordError | null;
}

export interface ScriptedHistorianMode {
    kind: "scripted";
    /**
     * Responses served to successive historian requests (initial, repair,
     * second run...). A function entry receives the ordinal range parsed from
     * the request's `<new_messages>` block so scripts can cover whatever
     * chunk the plugin actually built.
     */
    outputs: Array<string | ((range: { start: number; end: number }) => string)>;
    /** Scripted probe-answer responses, consumed one per probe attempt. */
    probeResponses?: string[];
}

export interface LiveHistorianMode {
    kind: "live";
    apiKey: string;
    /**
     * User-tier historian route, e.g. "anthropic/claude-sonnet-4-5".
     * Well-known providers resolve from OpenCode's built-in registry with
     * the key supplied via `extraEnv`.
     */
    historianModel: string;
    probeModel: { providerID: string; modelID: string };
}

export interface RunScenarioOptions {
    mode: ScriptedHistorianMode | LiveHistorianMode;
    /** Directory the run record and DB snapshot are written into. */
    artifactDir: string;
    repoCommitSha?: string;
    /** Per-run historian completion wait. */
    historianWaitMs?: number;
}

class RunAbort extends Error {
    constructor(
        readonly reason: RunErrorReason,
        readonly detail: string,
    ) {
        super(`${reason}: ${detail}`);
    }
}

/**
 * Marker-based historian request detection, scoped to `body.system`.
 *
 * Scoping matters: the `<new_messages>` tag also travels inside ordinary
 * main-agent traffic — an authored transcript that discusses prompt shapes, a
 * probe prompt, or an echoed repair payload all carry it in `messages`, and
 * every later request retains it in history. Keying off message content there
 * would route a main-agent turn into `historianResponse`, consuming a scripted
 * historian output (script-drift) or tripping the live-mode `fallback-engaged`
 * abort. The system marker alone is sufficient and is how the existing lanes
 * route historian traffic (tests/pi-long-running-session.test.ts,
 * tests/compaction-off.test.ts). If the marker ever stops appearing, historian
 * requests fall through to the poison default and surface as a loud
 * script-drift ERROR rather than silently misrouting.
 */
function isHistorianRequest(body: Record<string, unknown>): boolean {
    const system = body.system;
    if (typeof system === "string") return system.includes(HISTORIAN_SYSTEM_MARKER);
    if (Array.isArray(system)) {
        return system.some(
            (block) =>
                typeof (block as { text?: unknown })?.text === "string" &&
                ((block as { text: string }).text ?? "").includes(HISTORIAN_SYSTEM_MARKER),
        );
    }
    return false;
}

/**
 * OpenCode fires an auxiliary title-generation request per session. It is
 * not part of the transcript script, so the matcher answers it benignly
 * instead of letting it consume a scripted turn or hit the poison default.
 */
function isTitleRequest(body: Record<string, unknown>): boolean {
    const system = body.system;
    const text = typeof system === "string" ? system : JSON.stringify(system ?? "");
    return text.includes(TITLE_SYSTEM_MARKER);
}

/**
 * Concatenated plain text of every user message in an Anthropic-shaped
 * request body. Turn matching CONTAINS-matches against this: the plugin's
 * injection pass can prepend blocks to or splice user messages, so neither
 * "last user message" nor an exact-equality match survives contact with the
 * real request shape.
 */
function allUserText(body: Record<string, unknown>): string {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const chunks: string[] = [];
    for (const raw of messages) {
        const message = raw as { role?: unknown; content?: unknown };
        if (message?.role !== "user") continue;
        if (typeof message.content === "string") {
            chunks.push(message.content);
        } else if (Array.isArray(message.content)) {
            for (const block of message.content) {
                const text = (block as { type?: unknown; text?: unknown })?.text;
                if ((block as { type?: unknown })?.type === "text" && typeof text === "string") {
                    chunks.push(text);
                }
            }
        }
    }
    return chunks.join("\n");
}

/**
 * Ordinal range the historian request covers, parsed from the `Messages X-Y:`
 * chunk header inside `<new_messages>`. `buildCompartmentAgentPrompt` places
 * the pre-formatted `inputSource` immediately after the opening tag, so the
 * first header match after the marker is authoritative. Scanning for bare
 * `[N]` ordinals instead would let bracketed numbers in authored transcript
 * text or an echoed repair payload corrupt the range and misattribute the
 * resulting validation failure to the historian (R6).
 */
export function findOrdinalRange(body: Record<string, unknown>): { start: number; end: number } | null {
    const text = JSON.stringify(body.messages ?? "");
    const markerIndex = text.indexOf("<new_messages>");
    if (markerIndex === -1) return null;
    const header = /Messages (\d+)-(\d+):/.exec(text.slice(markerIndex));
    if (!header) return null;
    return { start: Number(header[1]), end: Number(header[2]) };
}

export function buildProbePrompt(probe: Probe): string {
    const shared =
        "Answer strictly from the project memory and session history already available to you in this conversation. " +
        "Reply with the answer inside an <answer></answer> envelope. Put nothing else inside the envelope.";
    if (probe.answerType === "exact") {
        return `${shared}\nQuestion: ${probe.question}\nAnswer with the exact value only.`;
    }
    if (probe.answerType === "multiple-choice") {
        return `${shared}\nQuestion: ${probe.question}\nChoose exactly one of: ${probe.choices.join(PROBE_CHOICE_SEPARATOR)}.`;
    }
    return `${shared}\nQuestion: ${probe.question}\nAnswer with the id of the single project-memory claim (the identifier before the colon in the project-memory block) that records it.`;
}

/**
 * Contents of the response's single answer envelope, or null.
 *
 * Exactly one envelope is required. Taking the first of several would let
 * `<answer>correct</answer><answer>wrong</answer>` pass on an ambiguous or
 * self-contradictory reply, and because the extracted prefix is non-null the
 * runner would not re-ask. Null sends the probe back through the re-ask path,
 * and a second malformed reply is `probe-envelope-malformed`.
 */
export function extractAnswerEnvelope(text: string | null): string | null {
    if (text === null) return null;
    const matches = [...text.matchAll(/<answer>([\s\S]*?)<\/answer>/g)];
    if (matches.length !== 1) return null;
    const answer = matches[0][1].trim();
    return answer.length > 0 ? answer : null;
}

/**
 * Blocks the plugin splices into a request: materialized history, rendered
 * claim memory, the mural, and the auto-search hint. Their contents are
 * historian-authored or claim-derived, never the raw messages the injection
 * splice is responsible for removing.
 */
const INJECTED_BLOCK_TAGS = [
    "session-history",
    "session-history-since",
    "new-compartments",
    "project-memory",
    "memory-mural",
    "user-profile",
    "ctx-search-hint",
] as const;

/**
 * Drop injected Magic Context blocks so what remains is raw history.
 *
 * Sound only when the transcript does not author these tags itself — see
 * `carriesInjectedBlockTag`, which callers must consult first. A block whose
 * closing tag was lost to budget trimming does not match and its contents stay
 * in the searched text, which is the safe direction for a leak gate.
 */
export function stripInjectedBlocks(text: string): string {
    let remaining = text;
    for (const tag of INJECTED_BLOCK_TAGS) {
        remaining = remaining.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), "\n");
    }
    return remaining;
}

/**
 * Whether text opens or closes an injected-block tag itself.
 *
 * `stripInjectedBlocks` treats every matching tag span as injected, which an
 * authored transcript can forge: a user message opening `<session-history>` and
 * a later assistant reply closing it makes the raw gold text between them look
 * like an injected span, so stripping would remove the very bytes the leak gate
 * is searching for and hide a real leak. A scenario whose authored text carries
 * these tags therefore keeps the unstripped payload.
 */
export function carriesInjectedBlockTag(text: string): boolean {
    return INJECTED_BLOCK_TAGS.some((tag) => text.includes(`<${tag}>`) || text.includes(`</${tag}>`));
}

/**
 * Whether every ordinal in `range` lies inside some compartment.
 *
 * Union coverage, not containment: adjacent compartments legitimately tile a
 * multi-turn gold range, so requiring one enclosing compartment would
 * misclassify valid output as uncovered. Exported because the scorer applies the
 * same precondition when rescoring a stored artifact, which never passes through
 * the runner's live gate.
 */
export function rangeCoveredByCompartments(
    range: readonly [number, number],
    compartments: ReadonlyArray<{ start: number; end: number }>,
): boolean {
    for (let ordinal = range[0]; ordinal <= range[1]; ordinal += 1) {
        if (!compartments.some((compartment) => compartment.start <= ordinal && compartment.end >= ordinal)) {
            return false;
        }
    }
    return true;
}

/**
 * Raw gold text surviving in a captured probe payload, or null.
 *
 * Exported so the scorer can reapply the gate to a persisted artifact's recorded
 * payload: a stored record never passes through the live check, and a copied or
 * older record whose captured request still holds raw gold text would otherwise
 * score from that leaked answer.
 *
 * Injected Magic Context blocks are excluded, since a summary may legitimately
 * restate an authored sentence verbatim — unless the transcript authors those
 * tags itself, in which case a tag span is not evidence of injection and
 * stripping could hide a real leak. The probe prompt is removed because it is in
 * the payload by construction and may quote its own gold source turn. An empty
 * authored side is skipped: `includes("")` matches everything, and an empty
 * message has no bytes to survive the splice.
 */
export function goldRangeLeak(args: {
    scenario: HistorianEvalScenario;
    goldClaims: ReadonlyArray<{ id: string; sourceTurnRange: readonly [number, number] }>;
    payloadText: string | null;
    probePrompt: string;
}): string | null {
    const { scenario, goldClaims, payloadText, probePrompt } = args;
    if (payloadText === null) return null;
    const authoredCarriesTag = scenario.transcript.turns.some(
        (turn) => carriesInjectedBlockTag(turn.user) || carriesInjectedBlockTag(turn.assistant),
    );
    const withoutPrompt = probePrompt.length === 0 ? payloadText : payloadText.split(probePrompt).join("\n");
    const rawHistory = authoredCarriesTag ? withoutPrompt : stripInjectedBlocks(withoutPrompt);
    for (const claim of goldClaims) {
        for (let turn = claim.sourceTurnRange[0]; turn <= claim.sourceTurnRange[1]; turn += 1) {
            const authored = scenario.transcript.turns[turn];
            for (const raw of [authored.user, authored.assistant]) {
                if (raw.trim().length === 0) continue;
                if (rawHistory.includes(raw)) {
                    return `raw transcript text of gold turn ${turn} survived in the probe payload`;
                }
            }
        }
    }
    return null;
}

/** Ids of the messages in a session-messages response. */
function messageIds(messages: unknown): string[] {
    if (!Array.isArray(messages)) return [];
    const ids: string[] = [];
    for (const message of messages) {
        const direct = (message as { id?: unknown })?.id;
        const nested = (message as { info?: { id?: unknown } })?.info?.id;
        const id = typeof nested === "string" ? nested : typeof direct === "string" ? direct : null;
        if (id !== null) ids.push(id);
    }
    return ids;
}

/**
 * Tool invocations recorded in messages absent from `known`.
 *
 * OpenCode records a tool call as a message part whose `type` carries "tool".
 * The name key has moved between SDK versions, so an invocation whose name
 * cannot be read reports as `<unnamed>` rather than being dropped — the gate
 * cares that a tool ran at all.
 */
function toolInvocationsInNewMessages(messages: unknown, known: ReadonlySet<string>): string[] {
    if (!Array.isArray(messages)) return [];
    const names = new Set<string>();
    for (const message of messages) {
        const direct = (message as { id?: unknown })?.id;
        const nested = (message as { info?: { id?: unknown } })?.info?.id;
        const id = typeof nested === "string" ? nested : typeof direct === "string" ? direct : null;
        if (id !== null && known.has(id)) continue;
        const parts = (message as { parts?: unknown })?.parts;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
            const type = (part as { type?: unknown })?.type;
            if (typeof type !== "string" || !type.includes("tool")) continue;
            const candidate = part as { tool?: unknown; toolName?: unknown; name?: unknown };
            const name = [candidate.tool, candidate.toolName, candidate.name].find(
                (value): value is string => typeof value === "string" && value.length > 0,
            );
            names.add(name ?? "<unnamed>");
        }
    }
    return [...names].sort();
}

/**
 * Concrete checkout SHA for the system-version tuple, resolved once per
 * process. A recorded `unknown` cannot identify the code that produced a live
 * artifact or be compared across system changes, so callers that omit
 * `repoCommitSha` get the real checkout; `unknown` survives only where git
 * cannot answer (exported tree, tarball checkout).
 */
let cachedRepoCommitSha: string | null = null;
function resolveRepoCommitSha(): string {
    if (cachedRepoCommitSha !== null) return cachedRepoCommitSha;
    let sha = "unknown";
    try {
        const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
        const candidate = head.success ? head.stdout.toString().trim() : "";
        if (/^[0-9a-f]{40}$/.test(candidate)) {
            sha = candidate;
            // A dirty worktree did not execute HEAD. Recording the clean SHA
            // would let two experiments built from different uncommitted trees
            // carry the same system tuple and be combined into one report, so the
            // local modifications become part of the identity: the digest covers
            // the tracked diff plus the porcelain status, which names untracked
            // files (their contents stay outside it).
            const status = Bun.spawnSync(["git", "status", "--porcelain"], { stdout: "pipe", stderr: "ignore" });
            const porcelain = status.success ? status.stdout.toString() : "";
            if (porcelain.trim().length > 0) {
                const diff = Bun.spawnSync(["git", "diff", "HEAD"], { stdout: "pipe", stderr: "ignore" });
                const hasher = new Bun.CryptoHasher("sha256");
                hasher.update(porcelain);
                hasher.update(diff.success ? diff.stdout.toString() : "");
                // `git diff HEAD` covers tracked modifications only, so untracked
                // file CONTENTS have to be hashed explicitly: two trees whose
                // untracked files share names but differ in bytes would otherwise
                // produce the same identity, which is the collision this whole
                // branch exists to prevent. `--exclude-standard` keeps ignored
                // paths (build output, node_modules) out of the walk.
                const untracked = Bun.spawnSync(
                    ["git", "ls-files", "--others", "--exclude-standard", "-z"],
                    { stdout: "pipe", stderr: "ignore" },
                );
                if (untracked.success) {
                    for (const path of untracked.stdout.toString().split("\0").filter((entry) => entry.length > 0)) {
                        hasher.update(path);
                        try {
                            hasher.update(readFileSync(path));
                        } catch {
                            // Unreadable or vanished between listing and reading:
                            // the path is still in the digest, so the tree is not
                            // mistaken for clean.
                            hasher.update("<unreadable>");
                        }
                    }
                }
                sha = `${candidate}-dirty.${hasher.digest("hex").slice(0, 12)}`;
            }
        }
    } catch {
        sha = "unknown";
    }
    cachedRepoCommitSha = sha;
    return sha;
}

/**
 * Both live routes must resolve to Anthropic.
 *
 * `boot` exports the single `apiKey` as `ANTHROPIC_API_KEY`, so a model on any
 * other provider reaches it with no credential and the run records an
 * authentication failure as though the models had been evaluated. Refusing the
 * mode up front turns that into a `harness-failure` ERROR naming the offending
 * route, which is the R6-correct attribution.
 */
function assertLiveProvidersCredentialed(mode: LiveHistorianMode): void {
    const routes: Array<{ label: string; providerId: string }> = [
        { label: "historianModel", providerId: mode.historianModel.split("/")[0] ?? "" },
        { label: "probeModel.providerID", providerId: mode.probeModel.providerID },
    ];
    const offenders = routes.filter((route) => route.providerId !== "anthropic");
    if (offenders.length > 0) {
        throw new Error(
            `historian-eval: live mode exports only ANTHROPIC_API_KEY, so every live route must use the anthropic provider; ` +
                `${offenders.map((route) => `${route.label} resolves to "${route.providerId || "<empty>"}"`).join(", ")}`,
        );
    }
}

class ScenarioRunner {
    private harness: TestHarness | null = null;
    private embedMock: MockProvider | null = null;
    private historianMarkerMockHits = 0;
    private capturedChildIds = new Set<string>();
    private seenProbeMessageIds = new Set<string>();
    private probeResponseQueue: string[] = [];
    private turnScripts: Array<{ prompt: string; response: MockResponse; hits: number }> = [];
    private historianScriptExhausted = false;
    private historianRangeUnparseable = false;
    // Partial evidence accumulated as the scenario progresses, so an ERROR
    // record still carries whatever the run produced before the abort (R6).
    private collectedRuns: HistorianRunArtifact[] = [];
    private collectedProbes: ProbeExchange[] = [];
    private sessionId = "";

    constructor(
        private readonly scenario: HistorianEvalScenario,
        private readonly options: RunScenarioOptions,
    ) {}

    async run(): Promise<HistorianEvalRunRecord> {
        // Resolve the checkout identity BEFORE anything is written. The DB
        // snapshot and logs land in `artifactDir`, which may sit inside the
        // checkout, so they would be untracked files feeding the dirty-worktree
        // digest — making two runs from the same clean commit record different
        // SHAs, and making the value depend on where in the flow `baseRecord()`
        // happened to be reached first. Cached per process, so this call fixes it
        // for every later reader.
        resolveRepoCommitSha();
        const recordPath = join(this.options.artifactDir, "run-record.json");
        if (existsSync(recordPath)) {
            // Fresh-environment invariant (KTD9): a reused attempt directory
            // means a reused environment; refuse rather than replay receipts.
            throw new Error(
                `historian-eval: run record already exists at ${recordPath}; each attempt needs a fresh artifact directory`,
            );
        }
        mkdirSync(this.options.artifactDir, { recursive: true });

        let record: HistorianEvalRunRecord;
        try {
            record = await this.execute();
        } catch (error) {
            if (error instanceof RunAbort) {
                record = this.emptyRecord({ reason: error.reason, detail: error.detail });
            } else {
                record = this.emptyRecord({
                    reason: "harness-failure",
                    detail: error instanceof Error ? error.message : String(error),
                });
            }
        } finally {
            await this.teardown();
        }
        writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
        return record;
    }

    /**
     * The fields every run-record variant shares. Variants override the rest
     * explicitly, so ERROR vs scoreable-exhaustion vs full-record semantics
     * stay visible as diffs from this base (R6/KTD4).
     */
    private baseRecord(): Omit<
        HistorianEvalRunRecord,
        "projectIdentity" | "nowMs" | "perGoldPredicate" | "injectedClaims" | "probes" | "verifiedClaimCount" | "contextDbSnapshotPath" | "error"
    > {
        return {
            schema: RUN_RECORD_SCHEMA,
            scenarioId: this.scenario.id,
            scenarioFingerprint: scenarioFingerprint(this.scenario),
            triggerFingerprint: triggerFingerprint(this.scenario),
            sessionId: this.sessionId,
            system: this.systemTuple(),
            expectedHistorianRuns: this.scenario.trigger.expectedHistorianRuns,
            historianRuns: this.collectedRuns,
            authoredTurnOrdinals: this.authoredTurnOrdinals(),
        };
    }

    private emptyRecord(error: RunRecordError): HistorianEvalRunRecord {
        // Best-effort DB snapshot: an ERROR record with the database beside
        // it is diagnosable without re-running the scenario.
        let snapshotPath = "";
        try {
            if (this.harness !== null && this.harness.hasContextDb()) {
                snapshotPath = this.snapshotContextDb(this.harness);
            }
        } catch {
            snapshotPath = "";
        }
        return {
            ...this.baseRecord(),
            projectIdentity: "",
            nowMs: Date.now(),
            perGoldPredicate: [],
            injectedClaims: [],
            probes: this.collectedProbes,
            verifiedClaimCount: 0,
            contextDbSnapshotPath: snapshotPath,
            // Harness-failure details splice in child stdout/stderr verbatim;
            // scrub the live credential before the record hits disk.
            error: { reason: error.reason, detail: this.redactSecrets(error.detail) },
        };
    }

    /**
     * Strip the live-mode API key from text destined for durable artifacts
     * (run records, persisted server logs). The live child process holds the
     * real key in its environment, and harness error messages and server
     * stderr are captured unfiltered.
     */
    private redactSecrets(text: string): string {
        const mode = this.options.mode;
        if (mode.kind !== "live" || mode.apiKey.length === 0) return text;
        return text.replaceAll(mode.apiKey, "[REDACTED]");
    }

    private fillerCount(): number {
        return Math.max(0, MIN_BUILD_TURNS - this.scenario.transcript.turns.length);
    }

    /**
     * Harness-owned padding turns AFTER the authored epilogue (excluded from
     * gold and the fingerprint, R5/KTD3). The protected-tail boundary keeps
     * the newest ~N tokens of raw history away from the historian; without
     * padding, N lands squarely on the authored transcript and no run can
     * ever cover the gold-fact ranges. Sized from the production tail-target
     * math at the scenario's own pressure numbers so recipe and product
     * cannot drift apart.
     */
    private paddingTurnCount(): number {
        const trigger = this.scenario.trigger;
        const target = deriveProtectedTailTokenTarget({
            contextLimit: trigger.modelContextLimit,
            executeThresholdPercentage: EXECUTE_THRESHOLD_PERCENTAGE,
            usagePercentage: (trigger.spikeUsageTokens / trigger.modelContextLimit) * 100,
        });
        // Sized from the ballast the padding turns actually carry. Assuming a
        // 100-token floor over-counted every turn's contribution whenever the
        // recipe configured less (the contract admits zero), so the padding came
        // out short, the protected tail still covered the authored gold, and the
        // scenario ended as `run-never-fired` or `probe-gold-uncovered` instead of
        // evaluating anything. The prose itself is a few tokens, which is not
        // enough to close that gap and is deliberately not counted as if it were.
        const tokensPerTurn = Math.max(1, trigger.ballastTokensPerTurn);
        // One extra turn absorbs rounding; the spike turn itself also carries
        // ballast and joins the tail. Capped so degenerate pressure numbers
        // (huge context limits push the tail target to its 96K ceiling)
        // cannot stretch a scenario into hundreds of padding turns.
        // The cap can still leave the tail short; `lintScenario` reports that at
        // freeze time, where it does not pre-empt the runtime diagnostics a
        // genuinely unreachable trigger produces on its own.
        return Math.min(MAX_PADDING_TURNS, Math.ceil(target.N / tokensPerTurn) + 1);
    }

    private systemTuple(): SystemVersionTuple {
        const mode = this.options.mode;
        return {
            repoCommitSha: this.options.repoCommitSha ?? resolveRepoCommitSha(),
            historianModelId: mode.kind === "live" ? mode.historianModel : "scripted-mock",
            probeModelId:
                mode.kind === "live" ? `${mode.probeModel.providerID}/${mode.probeModel.modelID}` : "scripted-mock",
            parserImpl: "ts",
            chunkTokenBudget: deriveHistorianChunkTokens(
                resolveHistorianContextLimit(mode.kind === "live" ? mode.historianModel : undefined),
            ),
        };
    }

    private async execute(): Promise<HistorianEvalRunRecord> {
        const harness = await this.boot();
        const sessionId = await harness.createSession();
        this.sessionId = sessionId;
        await this.installClaimMemoryFragment(harness);

        const fillerCount = this.fillerCount();
        await this.driveTranscript(harness, sessionId, fillerCount);

        const runs = this.collectedRuns;
        for (let runIndex = 1; runIndex <= this.scenario.trigger.expectedHistorianRuns; runIndex += 1) {
            runs.push(await this.driveHistorianRun(harness, sessionId, runIndex));
        }
        this.assertNoScriptDrift(harness);

        // Live historian whose every attempt fails validation is model
        // behavior, not infrastructure (KTD4): return a scoreable record
        // (the scorer maps it to FAIL:invalid-output). Probes and claim
        // capture are meaningless with nothing published.
        if (runs.every((run) => run.status === "failed")) {
            return {
                ...this.baseRecord(),
                projectIdentity: resolveProjectIdentity(harness.opencode.env.workdir),
                nowMs: Date.now(),
                perGoldPredicate: [],
                injectedClaims: [],
                probes: [],
                verifiedClaimCount: 0,
                contextDbSnapshotPath: this.snapshotContextDb(harness),
                error: null,
            };
        }
        this.assertPromotionNotSilentlySkipped(harness, sessionId, runs);

        // Lane-owned verification bridge: historian promotions land as
        // CANDIDATE (`model_inference`) and the visibility policy hides them
        // from automatic surfaces until VERIFIED. The lane measures
        // formation, not the orthogonal maturity gate, so it verifies every
        // active claim through the production verification operation before
        // the injection-dependent probe tier runs. See verification-bridge.ts.
        const verifiedClaimCount = this.runVerificationBridge(harness);

        const probes = await this.driveProbes(harness, sessionId);

        // Pin the clock before the authoritative snapshot read so re-scoring
        // is time-independent (KTD1).
        const nowMs = Date.now();
        const { injectedClaims, perGoldPredicate } = this.captureClaimState(harness, nowMs);
        const snapshotPath = this.snapshotContextDb(harness);

        return {
            ...this.baseRecord(),
            projectIdentity: resolveProjectIdentity(harness.opencode.env.workdir),
            nowMs,
            perGoldPredicate,
            injectedClaims,
            probes,
            verifiedClaimCount,
            contextDbSnapshotPath: snapshotPath,
            error: null,
        };
    }

    /**
     * Workaround for the pre-existing HEAD breakage tracked as a P1 bug:
     * TS-mode `openDatabase()` builds legacy-format databases (migrations
     * ceiling v89) that never install the claim-memory fragment, so the
     * production publish transaction's direct-claims promotion throws
     * "no such table" and rolls the whole publish back. The lane installs
     * the fragment with the production schema factory before any historian
     * run; remove once the runtime installs it itself.
     */
    private async installClaimMemoryFragment(harness: TestHarness): Promise<void> {
        await harness.waitFor(() => harness.hasContextDb(), { label: "context.db created" });
        const db = openTestDb(harness.contextDbPath(), { readwrite: true });
        try {
            if (!hasClaimMemoryFragment(db)) {
                db.transaction(() => createClaimMemorySchema(db)).immediate();
            }
        } finally {
            db.close();
        }
    }

    private runVerificationBridge(harness: TestHarness): number {
        const identity = resolveProjectIdentity(harness.opencode.env.workdir);
        const db = openTestDb(harness.contextDbPath(), { readwrite: true });
        try {
            return verifyAllActiveClaims(db, identity, Date.now());
        } finally {
            db.close();
        }
    }

    private async boot(): Promise<TestHarness> {
        const mode = this.options.mode;
        if (mode.kind === "live") assertLiveProvidersCredentialed(mode);
        // Dedicated deterministic embedding endpoint (KTD9): fire-and-forget
        // embedding dispatch must never race teardown against a real network.
        this.embedMock = new MockProvider();
        const { baseURL: embeddingEndpoint } = await this.embedMock.start();

        const magicContextConfig: Record<string, unknown> = {
            execute_threshold_percentage: EXECUTE_THRESHOLD_PERCENTAGE,
            keep_subagents: true,
            historian: {
                two_pass: false,
                disallowed_tools: ["*"],
                fallback_models: [],
                // Always pinned explicitly: an unset historian model lets the
                // agent resolve an ambient default (a real provider on a
                // developer machine), and `historian.model` also gates the
                // memory migration that installs the claim-memory schema —
                // without it, fact promotion throws on a fresh database.
                model: mode.kind === "live" ? mode.historianModel : "mock-anthropic/mock-sonnet",
            },
            embedding: {
                provider: "openai-compatible",
                endpoint: embeddingEndpoint,
                model: "historian-eval-embed",
            },
        };

        const harnessOptions: TestHarnessOptions = {
            magicContextConfig,
            modelContextLimit: this.scenario.trigger.modelContextLimit,
            mockDefault: {
                text: POISON_TEXT,
                usage: { input_tokens: this.scenario.trigger.usageTokensPerTurn, output_tokens: 20 },
            },
            ...(mode.kind === "live"
                ? {
                      extraEnv: { ANTHROPIC_API_KEY: mode.apiKey },
                      hostname: "127.0.0.1" as const,
                  }
                : {}),
        };

        const harness = await TestHarness.create(harnessOptions);
        this.harness = harness;
        this.installMatchers(harness);
        if (mode.kind === "scripted") {
            this.probeResponseQueue = [...(mode.probeResponses ?? [])];
        }
        return harness;
    }

    /**
     * All main-agent scripting is matcher-keyed on the exact prompt the
     * runner sent, never on request order: OpenCode fires auxiliary
     * requests (title generation) that would silently steal queue-ordered
     * responses and misalign every later turn. Aux traffic gets a benign
     * reply; anything unrecognized falls through to the poison default and
     * trips the script-drift ERROR.
     */
    private installMatchers(harness: TestHarness): void {
        const mode = this.options.mode;
        const scripted = mode.kind === "scripted" ? [...mode.outputs] : null;
        harness.mock.addMatcher((body) => {
            if (isHistorianRequest(body)) return this.historianResponse(body, scripted);
            if (isTitleRequest(body)) {
                return { text: "historian-eval scenario session", usage: { input_tokens: 50, output_tokens: 10 } };
            }
            const userText = allUserText(body);
            for (const entry of this.turnScripts) {
                if (entry.hits === 0 && userText.includes(entry.prompt)) {
                    entry.hits += 1;
                    return entry.response;
                }
            }
            return null;
        });
    }

    private historianResponse(
        body: Record<string, unknown>,
        scripted: Array<string | ((range: { start: number; end: number }) => string)> | null,
    ): MockResponse {
        if (scripted === null) {
            // Live mode: a historian request reaching the mock means the
            // production fallback chain terminated at the session model.
            this.historianMarkerMockHits += 1;
            return {
                error: { status: 500, type: "historian_eval_fallback", message: "fallback engaged" },
            };
        }
        const next = scripted.shift();
        if (next === undefined) {
            // An under-scripted historian is harness misconfiguration, not
            // model behavior: without this flag the poison text would fail
            // validation and masquerade as FAIL:invalid-output.
            this.historianScriptExhausted = true;
            return { text: POISON_TEXT, usage: { input_tokens: 100, output_tokens: 10 } };
        }
        let text: string;
        if (typeof next === "function") {
            const range = findOrdinalRange(body);
            if (range === null) {
                // A range-taking script cannot cover an unparseable chunk; an
                // invented range would fail validation and masquerade as
                // FAIL:invalid-output, so flag it as drift instead (R6).
                this.historianRangeUnparseable = true;
                return { text: POISON_TEXT, usage: { input_tokens: 100, output_tokens: 10 } };
            }
            text = next(range);
        } else {
            text = next;
        }
        return {
            text,
            usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 500 },
        };
    }

    /** Register the scripted reply for one prompt, then send it. */
    private async scriptedTurn(
        harness: TestHarness,
        sessionId: string,
        prompt: string,
        response: MockResponse,
        promptOptions: { providerID?: string; modelID?: string } = {},
    ): Promise<void> {
        this.turnScripts.push({ prompt, response, hits: 0 });
        await harness.sendPrompt(sessionId, prompt, promptOptions);
    }

    /**
     * Render the transcript: harness-owned filler turns first (excluded from
     * gold and fingerprint), then the authored turns, each user prompt
     * carrying deterministic ballast so the size-based protected-tail
     * boundary sees real content mass (R5/KTD3).
     */
    private async driveTranscript(harness: TestHarness, sessionId: string, fillerCount: number): Promise<void> {
        const usage = {
            ...triggerTurnUsage(this.scenario.trigger.usageTokensPerTurn),
            output_tokens: 40,
        };
        for (let index = 0; index < fillerCount; index += 1) {
            await this.scriptedTurn(
                harness,
                sessionId,
                `${FILLER_TURN.user} ${ballastProse(this.scenario.trigger.ballastTokensPerTurn)}`,
                { text: FILLER_TURN.assistant, usage },
            );
        }
        for (const [index, turn] of this.scenario.transcript.turns.entries()) {
            await this.scriptedTurn(
                harness,
                sessionId,
                `${turn.user} ${ballastProse(this.scenario.trigger.ballastTokensPerTurn)}`,
                { text: turn.assistant, usage },
            );
        }
        // Post-epilogue padding: pushes the protected tail past the authored
        // content so the historian chunk can reach every gold-fact range.
        const paddingBase = fillerCount + this.scenario.transcript.turns.length;
        for (let index = 0; index < this.paddingTurnCount(); index += 1) {
            await this.scriptedTurn(
                harness,
                sessionId,
                `Wrap-up housekeeping note ${index + 1}. ${ballastProse(this.scenario.trigger.ballastTokensPerTurn)}`,
                { text: "Housekeeping acknowledged.", usage },
            );
        }
    }

    private authoredTurnOrdinals(): Array<[number, number]> {
        return authoredTurnOrdinalsFor(this.scenario);
    }

    /**
     * Spike + kick pattern from tests/historian-success.test.ts: one turn
     * carries the threshold-crossing usage; the following turn gives the
     * transform a fresh pass to actually start the historian.
     */
    private async driveHistorianRun(
        harness: TestHarness,
        sessionId: string,
        runIndex: number,
    ): Promise<HistorianRunArtifact> {
        const trigger = this.scenario.trigger;
        const invocationsBefore = this.countHistorianInvocations(harness, sessionId);
        const markerHitsBefore = this.historianMarkerMockHits;
        const promotionEvidenceBefore = this.scopedPromotionEvidenceCount(harness);

        await this.scriptedTurn(
            harness,
            sessionId,
            `Continuing. ${ballastProse(trigger.ballastTokensPerTurn)}`,
            {
                text: "Acknowledged.",
                usage: { ...triggerTurnUsage(trigger.spikeUsageTokens), output_tokens: 40 },
            },
        );
        await this.scriptedTurn(harness, sessionId, `Please continue with step ${runIndex} of the plan.`, {
            text: "Standing by.",
            usage: { input_tokens: trigger.usageTokensPerTurn, output_tokens: 20 },
        });

        try {
            await harness.waitFor(
                () => this.historianRunRows(harness, sessionId).length >= runIndex && this.historianQuiesced(harness, sessionId),
                { timeoutMs: this.options.historianWaitMs ?? 90_000, label: `historian run ${runIndex}` },
            );
        } catch {
            throw new RunAbort(
                "run-never-fired",
                `scenario declares ${this.scenario.trigger.expectedHistorianRuns} historian runs; run ${runIndex} never completed`,
            );
        }

        const row = this.historianRunRows(harness, sessionId)[runIndex - 1];
        if (row.status === "failed" && /lease/i.test(row.failure_reason ?? "")) {
            throw new RunAbort("lease-lost", row.failure_reason ?? "lease lost");
        }
        // Fallback detection must not consume the evidence it sits in front of.
        //
        // Production's fallback chain ends at the live SESSION model as a last
        // resort, and this runner drives the source session with the
        // MockProvider — so a live historian that returns invalid output on both
        // its attempts necessarily lands a marker request on the mock. Aborting
        // on that alone converted precisely the live model behavior this lane
        // measures into `ERROR:fallback-engaged`, so `FAIL:invalid-output` could
        // never be recorded for a live run. A row that already failed validation
        // is that evidence, and it takes precedence.
        //
        // Counted per run rather than cumulatively: the marker counter spans the
        // whole scenario, so an earlier run's fallback would otherwise abort a
        // later, healthy one.
        const markerHitsDuringRun = this.historianMarkerMockHits - markerHitsBefore;
        const failedValidation =
            row.status === "failed" && (row.failure_reason ?? "").startsWith("validation: ");
        if (this.options.mode.kind === "live" && markerHitsDuringRun > 0 && !failedValidation) {
            throw new RunAbort(
                "fallback-engaged",
                `${markerHitsDuringRun} historian-marker request(s) reached the MockProvider during a live run`,
            );
        }
        // `status: "failed"` is not by itself model behavior. Production records
        // it for infrastructure conditions too — `stale_snapshot`,
        // `chunk-coverage: ...`, a missing protected-tail boundary snapshot,
        // drain-quota exhaustion, `exception: ...` — and only `validation: ...`
        // means the historian emitted unusable output. Letting the others reach
        // the scorer's all-attempts-invalid path would charge a runner or
        // database regression to historian quality as FAIL:invalid-output,
        // which is exactly the attribution R6 forbids. An unexplained failure
        // is not evidence of model behavior either, so it takes this path too.
        // A `noop` row means the pass ended without a historian request at all —
        // no eligible head, drain quota exhausted. The inventory check cannot
        // see it because the row occupies the expected index, so the declared
        // run would be accepted as complete while its scripted output was never
        // consumed; if an earlier run already covers the gold, probes and
        // structural scoring could then PASS for a run that did not happen.
        if (row.status === "noop") {
            throw new RunAbort(
                "run-never-fired",
                `historian run ${runIndex} recorded a no-op (${row.failure_reason ?? "no reason recorded"}); no historian request was made`,
            );
        }
        if (row.status === "failed" && !failedValidation) {
            throw new RunAbort(
                "harness-failure",
                `historian run ${runIndex} failed for a non-validation reason: ${row.failure_reason ?? "<none recorded>"}`,
            );
        }

        const rawOutput = await this.captureChildOutput(harness, sessionId);
        if (rawOutput === null && row.status === "success") {
            // A successful publish with no capturable child output means the
            // SDK surface drifted or the child session vanished — evidence
            // loss, never model behavior (R6).
            throw new RunAbort(
                "harness-failure",
                `historian run ${runIndex} published but its child-session output could not be captured`,
            );
        }
        const attemptCount = this.countHistorianInvocations(harness, sessionId) - invocationsBefore;
        const persisted = row.compartments_produced ?? 0;
        const discardedLast = row.discarded_last === 1;
        const maxPersistedEnd = this.maxPersistedCompartmentEnd(harness, sessionId);
        return {
            runIndex,
            rawOutput,
            status: row.status as HistorianRunArtifact["status"],
            failureReason: row.failure_reason ?? null,
            repairUsed: attemptCount > 1,
            attemptCount,
            discardedLast,
            lookaheadMargin:
                row.chunk_end_ordinal !== null && maxPersistedEnd !== null
                    ? row.chunk_end_ordinal - maxPersistedEnd
                    : null,
            emittedCompartments: persisted + (discardedLast ? 1 : 0),
            persistedCompartments: persisted,
            factsEmitted: row.facts_emitted ?? 0,
            chunkStartOrdinal: row.chunk_start_ordinal,
            chunkEndOrdinal: row.chunk_end_ordinal,
            promotionEvidenceAdded: Math.max(0, this.scopedPromotionEvidenceCount(harness) - promotionEvidenceBefore),
        };
    }

    /**
     * Promotion evidence under the scenario's project, read from the LIVE
     * database. Sampled before and after each run so the difference is that run's
     * own contribution; see `promotionEvidenceCount` for what counts and why.
     */
    private scopedPromotionEvidenceCount(harness: TestHarness): number {
        const db = openTestDb(harness.contextDbPath(), { readonly: true });
        try {
            return promotionEvidenceCount(db, resolveProjectIdentity(harness.opencode.env.workdir));
        } finally {
            db.close();
        }
    }

    private historianRunRows(
        harness: TestHarness,
        sessionId: string,
    ): Array<{
        status: string;
        failure_reason: string | null;
        chunk_start_ordinal: number | null;
        chunk_end_ordinal: number | null;
        compartments_produced: number | null;
        facts_emitted: number | null;
        discarded_last: number;
    }> {
        if (!harness.hasContextDb()) return [];
        try {
            return harness
                .contextDb()
                .prepare(
                    `SELECT status, failure_reason, chunk_start_ordinal, chunk_end_ordinal,
                            compartments_produced, facts_emitted, discarded_last
                     FROM historian_runs WHERE session_id = ? ORDER BY id ASC`,
                )
                .all(sessionId) as ReturnType<ScenarioRunner["historianRunRows"]>;
        } catch {
            return [];
        }
    }

    private historianQuiesced(harness: TestHarness, sessionId: string): boolean {
        try {
            const row = harness
                .contextDb()
                .prepare("SELECT compartment_in_progress FROM session_meta WHERE session_id = ?")
                .get(sessionId) as { compartment_in_progress: number } | null;
            return row !== null && row.compartment_in_progress === 0;
        } catch {
            return false;
        }
    }

    private countHistorianInvocations(harness: TestHarness, sessionId: string): number {
        if (!harness.hasContextDb()) return 0;
        try {
            const row = harness
                .contextDb()
                .prepare(
                    "SELECT COUNT(*) AS n FROM subagent_invocations WHERE session_id = ? AND subagent = 'historian'",
                )
                .get(sessionId) as { n: number } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

    private maxPersistedCompartmentEnd(harness: TestHarness, sessionId: string): number | null {
        try {
            const row = harness
                .contextDb()
                .prepare("SELECT MAX(end_message) AS m FROM compartments WHERE session_id = ?")
                .get(sessionId) as { m: number | null } | null;
            return row?.m ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Read the historian child session immediately after the pass
     * (`keep_subagents: true` keeps it alive) and extract the raw output
     * artifact with production's own extraction, so a reasoning-only payload
     * yields exactly what production validated (KTD5).
     */
    private async captureChildOutput(harness: TestHarness, sessionId: string): Promise<string | null> {
        const childrenRes = await harness.client.session.children({ path: { id: sessionId } });
        const children = Array.isArray(childrenRes.data)
            ? (childrenRes.data as Array<{ id?: string; title?: string; time?: { created?: number } }>)
            : [];
        const candidates = children
            .filter(
                (child) =>
                    typeof child.id === "string" &&
                    (child.title ?? "").includes("magic-context-compartment") &&
                    !this.capturedChildIds.has(child.id),
            )
            .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
        // Claim every candidate up front, not one per loop iteration. The loop
        // returns on the newest child that yields text, so marking inside it
        // leaves the older repair-attempt children eligible; a later run that
        // creates no capturable child of its own would then adopt one of them
        // and record another run's output as its `rawOutput`.
        for (const child of candidates) {
            this.capturedChildIds.add(child.id as string);
        }
        for (const child of candidates) {
            const messagesRes = await harness.client.session.messages({ path: { id: child.id as string } });
            const messages = messagesRes.data;
            const text = extractLatestAssistantText(messages) ?? extractLatestHistorianReasoning(messages);
            if (text !== null) return text;
        }
        return null;
    }

    private assertNoScriptDrift(harness: TestHarness): void {
        if (this.historianScriptExhausted) {
            throw new RunAbort("script-drift", "historian request arrived after the scripted output queue was exhausted");
        }
        if (this.historianRangeUnparseable) {
            throw new RunAbort(
                "script-drift",
                "historian request carried no parseable `Messages X-Y:` chunk header for a range-taking scripted output",
            );
        }
        const unconsumed = this.turnScripts.filter((entry) => entry.hits === 0).length;
        if (unconsumed > 0) {
            throw new RunAbort("script-drift", `${unconsumed} scripted main-agent turn(s) never consumed`);
        }
        const defaultHits = harness.mock.defaultHits();
        if (defaultHits > 0) {
            throw new RunAbort("script-drift", `${defaultHits} request(s) fell through to the poison default response`);
        }
    }

    /**
     * Silent no-op promotion (R6): facts were emitted but no claim ever
     * reached the store. That is a plumbing loss (empty promotion directory,
     * skipped unanchored promotion on every run), not historian quality.
     *
     * Runs that discarded their provisional last compartment are excluded:
     * production skips that pass's unanchored promotion outright
     * (`skipUnanchoredPromotion` in compartment-runner-incremental), deferring
     * the range to a healing run, so their emitted facts are expected to reach
     * no claim. Counting them would report a deliberate deferral as a plumbing
     * loss and, for a scenario declaring only that run, replace the structural
     * unhealed-discard FAIL the scorer derives from the same evidence.
     */
    private assertPromotionNotSilentlySkipped(
        harness: TestHarness,
        sessionId: string,
        runs: HistorianRunArtifact[],
    ): void {
        // Per run, not scenario-wide. A run that emitted facts without discarding
        // its provisional tail must have changed the claim state; checking only
        // whether the scenario ended with any claims lets an earlier success mask a
        // later run's lost promotion.
        const lostPromotion = runs.filter(
            (run) => !run.discardedLast && run.factsEmitted > 0 && run.promotionEvidenceAdded === 0,
        );
        if (lostPromotion.length > 0) {
            throw new RunAbort(
                "no-op-promotion",
                lostPromotion
                    .map(
                        (run) =>
                            `run ${run.runIndex} emitted ${run.factsEmitted} fact(s) but added no claim or evidence`,
                    )
                    .join("; "),
            );
        }
        const totalFacts = runs
            .filter((run) => !run.discardedLast)
            .reduce((sum, run) => sum + run.factsEmitted, 0);
        if (totalFacts === 0) return;
        try {
            // Scoped to the scenario's project, not the whole database. The
            // verification bridge and the authoritative claim read are both scoped
            // to this identity, so claims promoted under a different one — after
            // session-directory or identity-normalization drift — satisfy a global
            // count while leaving those reads empty. The scorer would then report
            // FAIL:recall, charging a project-routing fault to the historian.
            if (this.scopedPromotionEvidenceCount(harness) === 0) {
                throw new RunAbort(
                    "no-op-promotion",
                    `${totalFacts} fact(s) emitted across runs but zero claims reached the store`,
                );
            }
        } catch (error) {
            if (error instanceof RunAbort) throw error;
            throw new RunAbort("no-op-promotion", "claims table unreadable after fact-emitting runs");
        }
    }

    /**
     * Hidden probes (KTD6): resume the source session; the production
     * injection splice removes compartment-covered raw messages on the next
     * prompt, so the probe model answers from compartments and claim-backed
     * memories only.
     */
    private async driveProbes(harness: TestHarness, sessionId: string): Promise<ProbeExchange[]> {
        const exchanges = this.collectedProbes;
        // Watermark the transcript phase's messages so the per-probe tool-use
        // gate inspects only what the probe turns themselves add.
        const seed = await harness.client.session.messages({ path: { id: sessionId } });
        for (const id of messageIds(seed.data)) this.seenProbeMessageIds.add(id);
        // Probe turns are ordinary prompts, so the transform can start another
        // historian pass on one — reachable whenever a probe reply's usage crosses
        // the execution threshold. That pass is invisible to everything that has
        // already run: `assertNoScriptDrift` is done, `collectedRuns` is closed,
        // and the claim snapshot is taken after this loop, so its compartments and
        // claims would reach structural, recall, and later-probe scoring without
        // appearing in the run inventory. The declared schedule is the experiment,
        // so an extra pass invalidates the run rather than adding to it.
        const runRowsBefore = this.historianRunRows(harness, sessionId).length;
        for (const [probeIndex, probe] of this.scenario.probes.entries()) {
            exchanges.push(await this.driveProbe(harness, sessionId, probe, probeIndex));
        }
        // Quiesce first. `startCompartmentAgent` launches asynchronously and
        // `compartment-runner-incremental` writes its `historian_runs` row in a
        // `finally`, so counting rows immediately can still read the pre-probe
        // number while an undeclared pass is mid-flight — and then the snapshot is
        // taken with its compartments present but its row absent.
        try {
            await harness.waitFor(() => this.historianQuiesced(harness, sessionId), {
                timeoutMs: this.options.historianWaitMs ?? 90_000,
                label: "historian quiescent after the probe phase",
            });
        } catch {
            throw new RunAbort(
                "harness-failure",
                "a historian pass was still in flight after the probe phase; its run row cannot be accounted for",
            );
        }
        const runRowsAfter = this.historianRunRows(harness, sessionId).length;
        if (runRowsAfter !== runRowsBefore) {
            throw new RunAbort(
                "harness-failure",
                `${runRowsAfter - runRowsBefore} undeclared historian run(s) fired during the probe phase; the scenario's declared schedule is ${this.scenario.trigger.expectedHistorianRuns}`,
            );
        }
        return exchanges;
    }

    private async driveProbe(
        harness: TestHarness,
        sessionId: string,
        probe: Probe,
        probeIndex: number,
    ): Promise<ProbeExchange> {
        this.assertProbeGoldCovered(harness, sessionId, probe);
        const requestCountBefore = harness.mock.requests().length;

        const first = await this.askProbe(harness, sessionId, buildProbePrompt(probe));
        let answerRaw = first.answerRaw;
        let responseText = first.responseText;
        const toolNames = new Set(first.toolNames);
        let reAsked = false;
        // Every attempt's reply, not only the recorded one: a malformed first
        // attempt is discarded as an answer but its text still lands in the session
        // and reaches the next probe. The record keeps only the final reply, so
        // replay can reapply this to that one alone — which is why the abort has to
        // happen here, where both are in hand.
        this.assertNoProbeResponseLeak(probe, probeIndex, first.responseText);
        if (answerRaw === null) {
            reAsked = true;
            const retry = await this.askProbe(
                harness,
                sessionId,
                `Your previous reply had no valid <answer></answer> envelope. ${buildProbePrompt(probe)}`,
            );
            answerRaw = retry.answerRaw;
            responseText = retry.responseText;
            for (const name of retry.toolNames) toolNames.add(name);
            this.assertNoProbeResponseLeak(probe, probeIndex, retry.responseText);
            if (answerRaw === null) {
                throw new RunAbort("probe-envelope-malformed", `probe ${probe.id} answered without a valid envelope twice`);
            }
        }

        // A probe that retrieved anything is no longer a hidden probe: the
        // production main-agent prompt encourages `ctx_search`/`ctx_expand` for
        // prior context, and those reach the compartment-covered history the
        // splice just removed. Its answer would then prove nothing about what
        // the injected payload carried, so an invocation invalidates the
        // measurement rather than earning a score.
        if (toolNames.size > 0) {
            throw new RunAbort(
                "probe-tool-use",
                `probe ${probe.id} invoked ${[...toolNames].join(", ")}; a retrieved answer does not measure the injected payload`,
            );
        }

        const payloadText = this.capturedProbePayload(harness, requestCountBefore);
        this.assertNoGoldRangeLeak(probe, payloadText, buildProbePrompt(probe));
        return {
            probeId: probe.id,
            answerRaw,
            reAsked,
            injectedRevisionLocators: this.visibleRevisionLocators(harness, sessionId),
            payloadText,
            responseText,
        };
    }

    private async askProbe(
        harness: TestHarness,
        sessionId: string,
        prompt: string,
    ): Promise<{ answerRaw: string | null; responseText: string | null; toolNames: string[] }> {
        const mode = this.options.mode;
        if (mode.kind === "scripted") {
            const next = this.probeResponseQueue.shift();
            if (next === undefined) {
                throw new RunAbort("script-drift", "probe turn had no scripted probe response left");
            }
            await this.scriptedTurn(harness, sessionId, prompt, {
                text: next,
                usage: { input_tokens: 200, output_tokens: 40 },
            });
        } else {
            await harness.sendPrompt(sessionId, prompt, {
                providerID: mode.probeModel.providerID,
                modelID: mode.probeModel.modelID,
            });
        }
        const messagesRes = await harness.client.session.messages({ path: { id: sessionId } });
        const toolNames = toolInvocationsInNewMessages(messagesRes.data, this.seenProbeMessageIds);
        for (const id of messageIds(messagesRes.data)) this.seenProbeMessageIds.add(id);
        const responseText = extractLatestAssistantText(messagesRes.data);
        return {
            answerRaw: extractAnswerEnvelope(responseText),
            responseText,
            toolNames,
        };
    }

    /**
     * The gold claim a probe's leakage/coverage gates must protect (KTD6).
     *
     * Every probe type carries exactly one gold reference — `expectedClaimRef`
     * for claim-id, `sourceClaimRef` for exact and multiple-choice — and
     * `parseScenario` proves it resolves. Resolving it here matches how the
     * scorer resolves the probe's backing claim, so the gates cover exactly
     * what this probe's answer depends on. Returning every gold claim instead
     * would make one unrelated historian omission ERROR a probe whose own
     * backing range is compartment-covered; that omission is recall evidence
     * and the facts tier already scores it.
     */
    private probeGoldClaims(probe: Probe): typeof this.scenario.gold.expectedClaims {
        const reference = probe.answerType === "claim-id" ? probe.expectedClaimRef : probe.sourceClaimRef;
        return this.scenario.gold.expectedClaims.filter((claim) => claim.id === reference);
    }

    /**
     * Leakage-gate precondition (KTD6), scoped to what injection can
     * promise: each probe-relevant gold-fact ordinal range must be covered
     * by published compartment rows, or the splice cannot have removed its
     * raw messages. Uncovered gold range → ERROR, never a scored FAIL.
     */
    private assertProbeGoldCovered(harness: TestHarness, sessionId: string, probe: Probe): void {
        const compartments = harness
            .contextDb()
            .prepare("SELECT start_message AS start, end_message AS end FROM compartments WHERE session_id = ?")
            .all(sessionId) as Array<{ start: number; end: number }>;
        const ordinals = this.authoredTurnOrdinals();
        for (const claim of this.probeGoldClaims(probe)) {
            const [startTurn, endTurn] = claim.sourceTurnRange;
            const range: [number, number] = [ordinals[startTurn][0], ordinals[endTurn][1]];
            if (!rangeCoveredByCompartments(range, compartments)) {
                throw new RunAbort(
                    "probe-gold-uncovered",
                    `probe ${probe.id}: gold claim ${claim.id} ordinal range ${range[0]}-${range[1]} not covered by the published compartments`,
                );
            }
        }
    }

    /**
     * Plain text of every message (user AND assistant) across every request
     * captured during the probe turn's window, decoded from structured
     * content blocks so JSON escaping cannot hide a leak. Mock-captured, so
     * scripted mode only; live probe routes go to the live provider (the
     * compartment-coverage precondition still enforces the gate there).
     */
    private capturedProbePayload(harness: TestHarness, requestCountBefore: number): string | null {
        if (this.options.mode.kind === "live") return null;
        const probeRequests = harness.mock.requests().slice(requestCountBefore);
        // Scripted mode IS the capture-capable route, so zero captured requests
        // is capture drift, not an absent payload. Returning null would make
        // `assertNoGoldRangeLeak` skip silently and let the probe take a normal
        // PASS with the evidence its verdict depends on never collected.
        if (probeRequests.length === 0) {
            throw new RunAbort(
                "harness-failure",
                "scripted probe turn captured no provider request; the leak gate has no payload to inspect",
            );
        }
        const chunks: string[] = [];
        for (const request of probeRequests) {
            const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
            for (const raw of messages) {
                const message = raw as { content?: unknown };
                if (typeof message?.content === "string") {
                    chunks.push(message.content);
                } else if (Array.isArray(message?.content)) {
                    for (const block of message.content) {
                        const text = (block as { text?: unknown })?.text;
                        if (typeof text === "string") chunks.push(text);
                    }
                }
            }
        }
        return chunks.join("\n");
    }

    /**
     * Gold-fact-bearing raw ranges must not survive in the probe payload.
     * The gate is scoped to gold ranges: an uncovered non-gold tail (the
     * epilogue and harness-owned kick turns) is allowed to remain raw.
     *
     * Injected Magic Context blocks are excluded before the search. They carry
     * historian-authored summaries and claim text, and a summary may legitimately
     * restate an authored sentence verbatim — most likely for a short factual
     * assistant reply. Searching them too would convert a correct splice into a
     * `gold-range-leak` ERROR on summarization wording alone.
     *
     * The exclusion is skipped for a scenario whose own transcript authors those
     * tags, because there a tag span is not evidence of injection and stripping
     * could hide a real leak. Such a scenario keeps the unstripped search, which
     * can over-report but never conceals surviving raw text.
     */
    private assertNoProbeResponseLeak(probe: Probe, probeIndex: number, responseText: string | null): void {
        const leak = probeResponseLeak({ probes: this.scenario.probes, probeIndex, responseText });
        if (leak !== null) throw new RunAbort("probe-response-leak", `probe ${probe.id}: ${leak}`);
    }

    private assertNoGoldRangeLeak(probe: Probe, payloadText: string | null, probePrompt: string): void {
        const leak = goldRangeLeak({
            scenario: this.scenario,
            goldClaims: this.probeGoldClaims(probe),
            payloadText,
            probePrompt,
        });
        if (leak !== null) throw new RunAbort("gold-range-leak", `probe ${probe.id}: ${leak}`);
    }


    /**
     * Revision locators recorded as injected for the probe turn.
     *
     * A read or parse failure is NOT an empty injected set. Exact and
     * multiple-choice probes that answer correctly pass before locator-based
     * trimming is ever consulted, so swallowing the failure would let an
     * exact/choice-only scenario PASS with its per-probe injection evidence
     * never captured. An absent row or absent column value is a legitimate
     * empty; anything else aborts.
     */
    private visibleRevisionLocators(harness: TestHarness, sessionId: string): string[] {
        let raw: string | null;
        try {
            const row = harness
                .contextDb()
                .prepare("SELECT memory_block_ids FROM session_meta WHERE session_id = ?")
                .get(sessionId) as { memory_block_ids: string | null } | null;
            raw = row?.memory_block_ids ?? null;
        } catch (error) {
            throw new RunAbort(
                "harness-failure",
                `probe injection metadata unreadable: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        if (raw === null || raw.length === 0) return [];
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            throw new RunAbort(
                "harness-failure",
                `probe injection metadata is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        if (!Array.isArray(parsed)) {
            throw new RunAbort("harness-failure", `probe injection metadata is not an array: ${typeof parsed}`);
        }
        // Filtering a wrong-typed entry out would reproduce the same silent
        // evidence loss one level down: `[42]` would become an empty injected
        // set, and a correctly answered exact or multiple-choice probe passes
        // without ever consulting locators.
        const malformed = parsed.filter((entry) => typeof entry !== "string");
        if (malformed.length > 0) {
            throw new RunAbort(
                "harness-failure",
                `probe injection metadata has ${malformed.length} non-string entr(ies): ${JSON.stringify(malformed.slice(0, 3))}`,
            );
        }
        return parsed as string[];
    }

    /**
     * The authoritative claim read: the literal injection surface
     * (`auto_inject`, active lifecycle, stale retry) with the pinned clock
     * (KTD1). A snapshot still stale after the built-in retry is ERROR.
     */
    private captureClaimState(
        harness: TestHarness,
        nowMs: number,
    ): { injectedClaims: InjectedClaimRecord[]; perGoldPredicate: PerGoldPredicateCount[] } {
        const identity = resolveProjectIdentity(harness.opencode.env.workdir);
        const db = openTestDb(harness.contextDbPath(), { readonly: true });
        try {
            const injectedClaims = readInjectedClaims(db, identity, this.scenario.id, nowMs);
            if (injectedClaims === null) {
                throw new RunAbort("stale-snapshot", "claim snapshot remained stale after the injection read's retry");
            }
            const perGoldPredicate = this.scenario.gold.expectedClaims.map((claim) => {
                const matching = injectedClaims.filter((item) => matchesGold(claim, item));
                return {
                    expectedClaimId: claim.id,
                    claimCount: matching.length,
                    revisionCount: matching.reduce((sum, item) => sum + item.revision, 0),
                };
            });
            return { injectedClaims, perGoldPredicate };
        } finally {
            db.close();
        }
    }

    private snapshotContextDb(harness: TestHarness): string {
        const snapshotPath = join(this.options.artifactDir, "context-db-snapshot.sqlite");
        // VACUUM INTO produces a complete single-file image regardless of the
        // live database's WAL state; a plain file copy would silently drop
        // committed pages still sitting in `-wal`.
        const db = openTestDb(harness.contextDbPath(), { readwrite: true });
        try {
            db.exec(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`);
        } finally {
            db.close();
        }
        return snapshotPath;
    }

    /** Teardown never fails the scenario (KTD9). */
    private async teardown(): Promise<void> {
        // Give fire-and-forget embedding dispatch a moment to quiesce against
        // the deterministic endpoint before the temp tree is removed.
        await Bun.sleep(250);
        try {
            // Server logs are run evidence: infra ERRORs are diagnosed from
            // them without re-running the scenario. Redacted: a live child
            // holds the real API key in its environment.
            if (this.harness !== null) {
                writeFileSync(
                    join(this.options.artifactDir, "opencode-stderr.log"),
                    this.redactSecrets(this.harness.opencode.stderr()),
                );
            }
        } catch {
            // ignore
        }
        try {
            await this.harness?.dispose();
        } catch {
            // Logged failures are tolerated; teardown ordering never fails a scenario.
        }
        try {
            await this.embedMock?.stop();
        } catch {
            // ignore
        }
        this.harness = null;
        this.embedMock = null;
    }
}

export async function runScenario(
    scenario: HistorianEvalScenario,
    options: RunScenarioOptions,
): Promise<HistorianEvalRunRecord> {
    return new ScenarioRunner(scenario, options).run();
}
