import { canonicalFingerprint, canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import {
    EPOCH_ID_RE,
    HoldoutContractError,
    array,
    enumeration,
    exact,
    fail,
    hex64,
    integer,
    instant,
    record,
    staticId,
} from "./contract";

export const LIFECYCLE_EVENT_SCHEMA = "prospective-lifecycle-event/v1";
export const LIFECYCLE_STATES = [
    "frozen",
    "intake-open",
    "cohort-closed",
    "running",
    "reported",
    "insufficient-evidence",
    "invalidated",
    "graduated",
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];
export const INVALIDATION_CODES = [
    "identity-drift",
    "policy-drift",
    "suite-drift",
    "trust-failure",
    "execution-contract-breach",
    "adjudication-breach",
    "forbidden-amendment",
] as const;
export type InvalidationCode = (typeof INVALIDATION_CODES)[number];

export interface LifecycleEvent {
    schema: typeof LIFECYCLE_EVENT_SCHEMA;
    epochId: string;
    seq: number;
    state: LifecycleState;
    occurredAt: string;
    previousEventFingerprint: string | null;
    artifactFingerprint: string | null;
    reasonCode: InvalidationCode | null;
    approvers: string[];
}

const ALLOWED: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
    frozen: ["intake-open", "invalidated"],
    "intake-open": ["cohort-closed", "invalidated"],
    "cohort-closed": ["running", "invalidated"],
    running: ["reported", "insufficient-evidence", "invalidated"],
    reported: ["graduated", "invalidated"],
    "insufficient-evidence": ["graduated", "invalidated"],
    invalidated: [],
    graduated: [],
};

export function parseLifecycleEvent(raw: unknown, label: string): LifecycleEvent {
    const value = record(raw, label);
    exact(value, [
        "schema",
        "epochId",
        "seq",
        "state",
        "occurredAt",
        "previousEventFingerprint",
        "artifactFingerprint",
        "reasonCode",
        "approvers",
    ], label);
    if (value.schema !== LIFECYCLE_EVENT_SCHEMA) fail(`${label}.schema: version-invalid`);
    const state = enumeration(value.state, LIFECYCLE_STATES, `${label}.state`);
    const artifactFingerprint = value.artifactFingerprint === null
        ? null
        : hex64(value.artifactFingerprint, `${label}.artifactFingerprint`);
    const reasonCode = value.reasonCode === null
        ? null
        : enumeration(value.reasonCode, INVALIDATION_CODES, `${label}.reasonCode`);
    if (state === "invalidated" ? reasonCode === null : reasonCode !== null) {
        fail(`${label}.reasonCode: state-mismatch`);
    }
    if (["frozen", "cohort-closed", "reported", "insufficient-evidence", "graduated"].includes(state) && artifactFingerprint === null) {
        fail(`${label}.artifactFingerprint: state-requires-artifact`);
    }
    const approvers = array(value.approvers, `${label}.approvers`).map((entry, index) =>
        staticId(entry, `${label}.approvers[${index}]`),
    );
    if (approvers.length === 0 || new Set(approvers).size !== approvers.length) {
        fail(`${label}.approvers: invalid`);
    }
    return {
        schema: LIFECYCLE_EVENT_SCHEMA,
        epochId: staticId(value.epochId, `${label}.epochId`, EPOCH_ID_RE),
        seq: integer(value.seq, `${label}.seq`, 1),
        state,
        occurredAt: instant(value.occurredAt, `${label}.occurredAt`),
        previousEventFingerprint: value.previousEventFingerprint === null
            ? null
            : hex64(value.previousEventFingerprint, `${label}.previousEventFingerprint`),
        artifactFingerprint,
        reasonCode,
        approvers,
    };
}

export function parseLifecycleLedger(text: string): LifecycleEvent[] {
    if (text.length === 0) return [];
    if (!text.endsWith("\n")) throw new HoldoutContractError(["lifecycle: newline-required"]);
    return text.slice(0, -1).split("\n").map((line, index) => {
        let raw: unknown;
        try {
            raw = JSON.parse(line) as unknown;
        } catch {
            throw new HoldoutContractError([`lifecycle[${index}]: invalid-json`]);
        }
        const event = parseLifecycleEvent(raw, `lifecycle[${index}]`);
        if (canonicalJson(event) !== line) throw new HoldoutContractError([`lifecycle[${index}]: non-canonical`]);
        return event;
    });
}

export interface ValidatedLifecycle {
    events: LifecycleEvent[];
    state: LifecycleState;
    ledgerFingerprint: string;
}

export function validateLifecycle(
    rawEvents: readonly unknown[],
    options: { epochId?: string; trustedPrefix?: readonly LifecycleEvent[] } = {},
): ValidatedLifecycle {
    if (rawEvents.length === 0) throw new HoldoutContractError(["lifecycle: empty"]);
    const events = rawEvents.map((entry, index) => parseLifecycleEvent(entry, `lifecycle[${index}]`));
    const epochId = options.epochId ?? events[0]!.epochId;
    for (const [index, event] of events.entries()) {
        if (event.epochId !== epochId) fail(`lifecycle[${index}].epochId: mismatch`);
        if (event.seq !== index + 1) fail(`lifecycle[${index}].seq: non-contiguous`);
        if (index === 0) {
            if (event.state !== "frozen" || event.previousEventFingerprint !== null) {
                fail("lifecycle[0]: must-freeze-first");
            }
            continue;
        }
        const previous = events[index - 1]!;
        if (!ALLOWED[previous.state].includes(event.state)) {
            fail(`lifecycle[${index}].state: illegal-transition`);
        }
        if (event.previousEventFingerprint !== canonicalFingerprint(previous)) {
            fail(`lifecycle[${index}].previousEventFingerprint: mismatch`);
        }
        if (Date.parse(event.occurredAt) < Date.parse(previous.occurredAt)) {
            fail(`lifecycle[${index}].occurredAt: order-invalid`);
        }
    }
    const trustedPrefix = options.trustedPrefix ?? [];
    if (trustedPrefix.length > events.length) fail("lifecycle: trusted-prefix-longer-than-ledger");
    for (const [index, expected] of trustedPrefix.entries()) {
        if (canonicalJson(events[index]) !== canonicalJson(expected)) {
            fail(`lifecycle[${index}]: trusted-prefix-rewritten`);
        }
    }
    return {
        events,
        state: events[events.length - 1]!.state,
        ledgerFingerprint: canonicalFingerprint(events),
    };
}

export function appendLifecycleEvent(
    prior: readonly LifecycleEvent[],
    next: Omit<LifecycleEvent, "schema" | "seq" | "previousEventFingerprint">,
): LifecycleEvent[] {
    if (prior.length === 0 && next.state !== "frozen") fail("lifecycle: must-freeze-first");
    const previous = prior.at(-1);
    const candidate: LifecycleEvent = {
        schema: LIFECYCLE_EVENT_SCHEMA,
        epochId: next.epochId,
        seq: prior.length + 1,
        state: next.state,
        occurredAt: next.occurredAt,
        previousEventFingerprint: previous ? canonicalFingerprint(previous) : null,
        artifactFingerprint: next.artifactFingerprint,
        reasonCode: next.reasonCode,
        approvers: next.approvers,
    };
    return validateLifecycle([...prior, candidate], { epochId: next.epochId }).events;
}

export function invalidateLifecycle(
    prior: readonly LifecycleEvent[],
    input: {
        occurredAt: string;
        reasonCode: InvalidationCode;
        approvers: string[];
    },
): LifecycleEvent[] {
    const previous = prior.at(-1);
    if (!previous) fail("lifecycle: cannot-invalidate-empty");
    return appendLifecycleEvent(prior, {
        epochId: previous.epochId,
        state: "invalidated",
        occurredAt: input.occurredAt,
        artifactFingerprint: null,
        reasonCode: input.reasonCode,
        approvers: input.approvers,
    });
}
