import { createHmac, randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalFingerprint, canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { type BlindedPacket, type ConcealedMap, verifyConcealedMap } from "./blinding";
import {
    type CohortCloseManifest,
    HoldoutContractError,
    enumeration,
    exact,
    fail,
    hex64,
    instant,
    integer,
    record,
    staticId,
} from "./contract";

export const JUDGMENT_SCHEMA = "prospective-judgment/v1";
export const ADJUDICATION_CLOSE_SCHEMA = "prospective-adjudication-close/v1";
export const JUDGMENT_VERDICTS = ["build-a", "build-b", "tie", "neither"] as const;

export interface JudgmentEvent {
    schema: typeof JUDGMENT_SCHEMA;
    eventId: string;
    seq: number;
    caseId: string;
    packetId: string;
    packetFingerprint: string;
    adjudicator: string;
    verdict: (typeof JUDGMENT_VERDICTS)[number];
    previousEventFingerprint: string | null;
    judgmentSignature: string;
}

export interface AdjudicationClose {
    schema: typeof ADJUDICATION_CLOSE_SCHEMA;
    epochId: string;
    closeManifestFingerprint: string;
    subjectiveMapCommitment: string;
    closedAt: string;
    judgmentsFingerprint: string;
    judgmentCount: number;
    approval: {
        kind: "adjudication-close";
        approver: string;
        subjectFingerprint: string;
    };
}

function sign(event: Omit<JudgmentEvent, "judgmentSignature">, key: Uint8Array): string {
    return createHmac("sha256", key).update(canonicalJson(event)).digest("hex");
}

export function appendJudgment(input: {
    prior: readonly JudgmentEvent[];
    packet: BlindedPacket;
    sealedPackets: readonly BlindedPacket[];
    adjudicator: string;
    verdict: JudgmentEvent["verdict"];
    authenticationKey: Uint8Array;
}): JudgmentEvent[] {
    if (input.authenticationKey.byteLength < 32) fail("judgment.authentication-key: too-short");
    const packetFingerprint = canonicalFingerprint(input.packet);
    if (input.prior.some((event) => event.packetId === input.packet.packetId || event.caseId === input.packet.caseId)) {
        throw new HoldoutContractError(["judgment: duplicate-packet"]);
    }
    const unsigned = {
        schema: JUDGMENT_SCHEMA,
        eventId: `judgment-${canonicalFingerprint([input.packet.packetId, packetFingerprint, input.prior.length + 1]).slice(0, 32)}`,
        seq: input.prior.length + 1,
        caseId: input.packet.caseId,
        packetId: input.packet.packetId,
        packetFingerprint,
        adjudicator: input.adjudicator,
        verdict: input.verdict,
        previousEventFingerprint: input.prior.length === 0
            ? null
            : canonicalFingerprint(input.prior[input.prior.length - 1]),
    } satisfies Omit<JudgmentEvent, "judgmentSignature">;
    const event: JudgmentEvent = {
        ...unsigned,
        judgmentSignature: sign(unsigned, input.authenticationKey),
    };
    return validateJudgments([...input.prior, event], input.authenticationKey, input.sealedPackets);
}

export function parseJudgment(raw: unknown, label: string): JudgmentEvent {
    const value = record(raw, label);
    exact(value, [
        "schema",
        "eventId",
        "seq",
        "caseId",
        "packetId",
        "packetFingerprint",
        "adjudicator",
        "verdict",
        "previousEventFingerprint",
        "judgmentSignature",
    ], label);
    if (value.schema !== JUDGMENT_SCHEMA) fail(`${label}.schema: version-invalid`);
    return {
        schema: JUDGMENT_SCHEMA,
        eventId: staticId(value.eventId, `${label}.eventId`, /^judgment-[0-9a-f]{32}$/),
        seq: integer(value.seq, `${label}.seq`, 1),
        caseId: staticId(value.caseId, `${label}.caseId`, /^case-[0-9a-f]{32}$/),
        packetId: staticId(value.packetId, `${label}.packetId`, /^packet-[0-9a-f]{32}$/),
        packetFingerprint: hex64(value.packetFingerprint, `${label}.packetFingerprint`),
        adjudicator: staticId(value.adjudicator, `${label}.adjudicator`),
        verdict: enumeration(value.verdict, JUDGMENT_VERDICTS, `${label}.verdict`),
        previousEventFingerprint: value.previousEventFingerprint === null
            ? null
            : hex64(value.previousEventFingerprint, `${label}.previousEventFingerprint`),
        judgmentSignature: hex64(value.judgmentSignature, `${label}.judgmentSignature`),
    };
}

export function validateJudgments(
    raw: readonly unknown[],
    key: Uint8Array,
    sealedPackets: readonly BlindedPacket[],
): JudgmentEvent[] {
    if (key.byteLength < 32) fail("judgments.authentication-key: too-short");
    const events = raw.map((entry, index) => parseJudgment(entry, `judgments[${index}]`));
    const packetsById = new Map(sealedPackets.map((packet) => [packet.packetId, packet]));
    if (packetsById.size !== sealedPackets.length || new Set(sealedPackets.map((packet) => packet.caseId)).size !== sealedPackets.length) {
        fail("judgments: sealed-packets-duplicate");
    }
    const packetIds = new Set<string>();
    const caseIds = new Set<string>();
    for (const [index, event] of events.entries()) {
        if (event.seq !== index + 1) fail(`judgments[${index}].seq: non-contiguous`);
        const expectedPrevious = index === 0 ? null : canonicalFingerprint(events[index - 1]);
        if (event.previousEventFingerprint !== expectedPrevious) fail(`judgments[${index}]: chain-invalid`);
        if (packetIds.has(event.packetId) || caseIds.has(event.caseId)) fail(`judgments[${index}]: duplicate-packet`);
        packetIds.add(event.packetId);
        caseIds.add(event.caseId);
        const sealed = packetsById.get(event.packetId);
        if (!sealed || sealed.caseId !== event.caseId || canonicalFingerprint(sealed) !== event.packetFingerprint) {
            fail(`judgments[${index}]: sealed-packet-mismatch`);
        }
        const { judgmentSignature: _signature, ...unsigned } = event;
        if (sign(unsigned, key) !== event.judgmentSignature) fail(`judgments[${index}]: authentication-invalid`);
    }
    return events;
}

function validateCohortJudgments(
    close: CohortCloseManifest,
    judgments: readonly JudgmentEvent[],
    key: Uint8Array,
    sealedPackets: readonly BlindedPacket[],
): JudgmentEvent[] {
    const subjectiveCaseIds = close.body.cases
        .filter((entry) => entry.subjective)
        .map((entry) => entry.caseId)
        .sort();
    if (subjectiveCaseIds.length === 0) fail("judgments: subjective-cases-required");
    const packetCaseIds = sealedPackets.map((packet) => packet.caseId).sort();
    const events = validateJudgments(judgments, key, sealedPackets);
    const judgmentCaseIds = events.map((event) => event.caseId).sort();
    if (
        JSON.stringify(packetCaseIds) !== JSON.stringify(subjectiveCaseIds) ||
        JSON.stringify(judgmentCaseIds) !== JSON.stringify(subjectiveCaseIds)
    ) {
        fail("judgments: subjective-case-cardinality-mismatch");
    }
    return events;
}

export function closeAdjudication(input: {
    close: CohortCloseManifest;
    trustedCloseFingerprint: string;
    closedAt: string;
    judgments: readonly JudgmentEvent[];
    sealedPackets: readonly BlindedPacket[];
    authenticationKey: Uint8Array;
    approver: string;
}): AdjudicationClose {
    if (canonicalFingerprint(input.close) !== input.trustedCloseFingerprint) fail("adjudication-close: cohort-close-untrusted");
    if (input.close.approvals.some((approval) => approval.approver === input.approver)) {
        fail("adjudication-close.approval: independence-required");
    }
    // Reject closes before `input.close.body.closedAt` because intake could still add cases.
    // Allow equality because the cohort is fixed at `input.close.body.closedAt`.
    if (Date.parse(input.closedAt) < Date.parse(input.close.body.closedAt)) {
        fail("adjudication-close.closedAt: before-cohort-close");
    }
    const judgments = validateCohortJudgments(
        input.close,
        input.judgments,
        input.authenticationKey,
        input.sealedPackets,
    );
    const subject = {
        epochId: input.close.body.epochId,
        closeManifestFingerprint: input.trustedCloseFingerprint,
        subjectiveMapCommitment: input.close.body.subjectiveMapCommitment,
        closedAt: input.closedAt,
        judgmentsFingerprint: canonicalFingerprint(judgments),
        judgmentCount: judgments.length,
    };
    const subjectFingerprint = canonicalFingerprint(subject);
    return parseAdjudicationClose({
        schema: ADJUDICATION_CLOSE_SCHEMA,
        ...subject,
        approval: { kind: "adjudication-close", approver: input.approver, subjectFingerprint },
    });
}

export function parseAdjudicationClose(raw: unknown): AdjudicationClose {
    const value = record(raw, "adjudication-close");
    exact(value, [
        "schema", "epochId", "closeManifestFingerprint", "subjectiveMapCommitment",
        "closedAt", "judgmentsFingerprint", "judgmentCount", "approval",
    ], "adjudication-close");
    if (value.schema !== ADJUDICATION_CLOSE_SCHEMA) fail("adjudication-close.schema: version-invalid");
    const approval = record(value.approval, "adjudication-close.approval");
    exact(approval, ["kind", "approver", "subjectFingerprint"], "adjudication-close.approval");
    if (approval.kind !== "adjudication-close") fail("adjudication-close.approval.kind: invalid");
    const parsed: AdjudicationClose = {
        schema: ADJUDICATION_CLOSE_SCHEMA,
        epochId: staticId(value.epochId, "adjudication-close.epochId", /^epoch-[a-z0-9]+(?:-[a-z0-9]+)*$/),
        closeManifestFingerprint: hex64(value.closeManifestFingerprint, "adjudication-close.closeManifestFingerprint"),
        subjectiveMapCommitment: hex64(value.subjectiveMapCommitment, "adjudication-close.subjectiveMapCommitment"),
        closedAt: instant(value.closedAt, "adjudication-close.closedAt"),
        judgmentsFingerprint: hex64(value.judgmentsFingerprint, "adjudication-close.judgmentsFingerprint"),
        judgmentCount: integer(value.judgmentCount, "adjudication-close.judgmentCount"),
        approval: {
            kind: "adjudication-close",
            approver: staticId(approval.approver, "adjudication-close.approval.approver"),
            subjectFingerprint: hex64(approval.subjectFingerprint, "adjudication-close.approval.subjectFingerprint"),
        },
    };
    const { schema: _schema, approval: _approval, ...subject } = parsed;
    if (canonicalFingerprint(subject) !== parsed.approval.subjectFingerprint) {
        fail("adjudication-close.approval: stale-subject");
    }
    return parsed;
}

export function publishAdjudicationClose(close: AdjudicationClose, destination: string): void {
    const bytes = `${JSON.stringify(close, null, 2)}\n`;
    /**
     * acceptExisting returns true for identical existing bytes and rejects differing bytes to preserve retry idempotence.
     */
    const acceptExisting = (): boolean => {
        if (!existsSync(destination)) return false;
        if (readFileSync(destination, "utf8") !== bytes) {
            throw new HoldoutContractError(["adjudication-close: destination-conflict"]);
        }
        return true;
    };
    if (acceptExisting()) return;
    mkdirSync(dirname(destination), { recursive: true });
    const temp = `${destination}.tmp-${randomBytes(8).toString("hex")}`;
    try {
        writeFileSync(temp, bytes, { flag: "wx" });
        linkSync(temp, destination);
    } catch (error) {
        if (acceptExisting()) return;
        throw error;
    } finally {
        rmSync(temp, { force: true });
    }
}

export function unblindAfterClose(input: {
    close: AdjudicationClose;
    cohortClose: CohortCloseManifest;
    trustedCloseFingerprint: string;
    judgments: readonly JudgmentEvent[];
    sealedPackets: readonly BlindedPacket[];
    authenticationKey: Uint8Array;
    concealedMap: ConcealedMap;
    commitmentSecret: Uint8Array;
    unblindApprover: string;
    /**
     *
     */
    unblindApprovalKey: Uint8Array;
    approvalFingerprint: string;
}): ConcealedMap {
    if (
        canonicalFingerprint(input.cohortClose) !== input.trustedCloseFingerprint ||
        input.close.epochId !== input.cohortClose.body.epochId ||
        input.close.closeManifestFingerprint !== input.trustedCloseFingerprint ||
        input.close.subjectiveMapCommitment !== input.cohortClose.body.subjectiveMapCommitment
    ) {
        fail("unblind: cohort-close-binding-invalid");
    }
    if (
        input.unblindApprover === input.close.approval.approver ||
        input.cohortClose.approvals.some((approval) => approval.approver === input.unblindApprover)
    ) {
        fail("unblind: approver-not-independent");
    }
    const judgments = validateCohortJudgments(
        input.cohortClose,
        input.judgments,
        input.authenticationKey,
        input.sealedPackets,
    );
    if (
        judgments.length !== input.close.judgmentCount ||
        canonicalFingerprint(judgments) !== input.close.judgmentsFingerprint
    ) {
        fail("unblind: judgment-set-mismatch");
    }
    if (input.unblindApprovalKey.byteLength < 32) fail("unblind.approval-key: too-short");
    const expectedApproval = createHmac("sha256", input.unblindApprovalKey)
        .update(canonicalJson({
            kind: "unblind",
            approver: input.unblindApprover,
            adjudicationCloseFingerprint: canonicalFingerprint(input.close),
            closeManifestFingerprint: input.trustedCloseFingerprint,
            mapCommitment: input.cohortClose.body.subjectiveMapCommitment,
        }))
        .digest("hex");
    if (expectedApproval !== input.approvalFingerprint) fail("unblind: approval-invalid");
    return verifyConcealedMap(
        input.concealedMap,
        input.commitmentSecret,
        input.cohortClose.body.subjectiveMapCommitment,
        input.cohortClose.body.cases
            .filter((entry) => entry.subjective)
            .map((entry) => entry.caseId),
    );
}
