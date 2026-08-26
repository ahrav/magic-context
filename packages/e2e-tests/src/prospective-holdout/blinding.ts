import { createHmac, randomBytes } from "node:crypto";
import { canonicalFingerprint, canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { CASE_ID_RE, HoldoutContractError, array, enumeration, exact, fail, record, staticId } from "./contract";

export type ReleaseRole = "release-n" | "release-n-minus-1";
export interface ConcealedAssignment {
    caseId: string;
    buildA: ReleaseRole;
    buildB: ReleaseRole;
}
export interface ConcealedMap {
    schema: "prospective-concealed-map/v1";
    salt: string;
    assignments: ConcealedAssignment[];
    commitment: string;
}

export interface BoundedObservation {
    status: "pass" | "fail" | "not-evaluated";
    checkIds: string[];
}
export interface BlindedPacket {
    schema: "prospective-blinded-packet/v1";
    caseId: string;
    packetId: string;
    buildA: BoundedObservation;
    buildB: BoundedObservation;
}

function commitment(secret: Uint8Array, salt: string, assignments: readonly ConcealedAssignment[]): string {
    return createHmac("sha256", secret)
        .update(canonicalJson({ salt, assignments }))
        .digest("hex");
}

export function createConcealedMap(caseIds: readonly string[], secret: Uint8Array, salt = randomBytes(16).toString("hex")): ConcealedMap {
    if (secret.byteLength < 32) fail("blinding.secret: too-short");
    if (!/^[0-9a-f]{32}$/.test(salt)) fail("blinding.salt: invalid");
    const sorted = [...caseIds].sort();
    if (new Set(sorted).size !== sorted.length || sorted.some((id) => !CASE_ID_RE.test(id))) {
        fail("blinding.caseIds: invalid");
    }
    const assignments = sorted.map((caseId) => {
        const bit = createHmac("sha256", secret).update(`${salt}:${caseId}`).digest()[0]! & 1;
        return bit === 0
            ? { caseId, buildA: "release-n" as const, buildB: "release-n-minus-1" as const }
            : { caseId, buildA: "release-n-minus-1" as const, buildB: "release-n" as const };
    });
    return {
        schema: "prospective-concealed-map/v1",
        salt,
        assignments,
        commitment: commitment(secret, salt, assignments),
    };
}

export function verifyConcealedMap(map: ConcealedMap, secret: Uint8Array, expectedCommitment: string): void {
    if (commitment(secret, map.salt, map.assignments) !== expectedCommitment || map.commitment !== expectedCommitment) {
        throw new HoldoutContractError(["blinding.map: commitment-mismatch"]);
    }
}

function parseObservation(raw: unknown, label: string): BoundedObservation {
    const value = record(raw, label);
    exact(value, ["status", "checkIds"], label);
    const checkIds = array(value.checkIds, `${label}.checkIds`).map((entry, index) =>
        staticId(entry, `${label}.checkIds[${index}]`, /^check-[a-z0-9]+(?:-[a-z0-9]+)*$/),
    );
    if (new Set(checkIds).size !== checkIds.length) fail(`${label}.checkIds: duplicate`);
    return {
        status: enumeration(value.status, ["pass", "fail", "not-evaluated"] as const, `${label}.status`),
        checkIds,
    };
}

export function parseBlindedPacket(raw: unknown): BlindedPacket {
    const value = record(raw, "packet");
    exact(value, ["schema", "caseId", "packetId", "buildA", "buildB"], "packet");
    if (value.schema !== "prospective-blinded-packet/v1") fail("packet.schema: version-invalid");
    return {
        schema: "prospective-blinded-packet/v1",
        caseId: staticId(value.caseId, "packet.caseId", CASE_ID_RE),
        packetId: staticId(value.packetId, "packet.packetId", /^packet-[0-9a-f]{32}$/),
        buildA: parseObservation(value.buildA, "packet.buildA"),
        buildB: parseObservation(value.buildB, "packet.buildB"),
    };
}

const IDENTITY_CUE_CHECK_ID = /(?:^|-)(?:release-n(?:-minus-1)?|build-[ab]|version|root|sha)(?:-|$)/;

export function buildBlindedPacket(input: {
    caseId: string;
    assignment: ConcealedAssignment;
    observations: Record<ReleaseRole, BoundedObservation>;
    allowedCheckIds: readonly string[];
}): BlindedPacket {
    if (input.assignment.caseId !== input.caseId) fail("packet: assignment-case-mismatch");
    const raw = {
        schema: "prospective-blinded-packet/v1",
        caseId: input.caseId,
        packetId: `packet-${canonicalFingerprint([input.caseId, input.assignment]).slice(0, 32)}`,
        buildA: input.observations[input.assignment.buildA],
        buildB: input.observations[input.assignment.buildB],
    };
    assertNoIdentityCue(raw, input.allowedCheckIds);
    return parseBlindedPacket(raw);
}

export function assertNoIdentityCue(raw: unknown, allowedCheckIds: readonly string[]): void {
    try {
        const packet = parseBlindedPacket(raw);
        const allowed = new Set(allowedCheckIds);
        const checkIds = [...packet.buildA.checkIds, ...packet.buildB.checkIds];
        if (
            allowed.size !== allowedCheckIds.length ||
            allowedCheckIds.some((id) => IDENTITY_CUE_CHECK_ID.test(id)) ||
            checkIds.some((id) => !allowed.has(id) || IDENTITY_CUE_CHECK_ID.test(id))
        ) {
            throw new Error("identity cue");
        }
    } catch {
        throw new HoldoutContractError(["packet: identity-cue-or-schema-invalid"]);
    }
}
