/**
 * The anti-memory payload and its text form. Rendering and parsing are
 * inverses over normalized payloads, so a payload stored as text round-trips
 * without a database.
 */

import { ClaimOperationInputError } from "./claim-operation-contract";

/** Anti-memories age out: a rejected strategy is a warning about a point in time, not a permanent rule, so a write without an explicit expiry gets this horizon. commentlint: allow(JUDGE) */
export const ANTI_MEMORY_DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

export interface AntiMemoryPayload {
    trigger: string;
    rejectedStrategy: string;
    rejectionReason: string;
    saferAlternative?: string | null;
    preconditions?: string | null;
    attemptedApproach?: string | null;
    observedFailure?: string | null;
    rootCause?: string | null;
    recovery?: string | null;
    nonApplicableWhen?: string | null;
    /** Epoch milliseconds after which the payload no longer surfaces; rides in the rendered text because kernel decisions carry no lifecycle expiry. commentlint: allow(JUDGE) */
    expiresAt?: number | null;
}

export interface StoredAntiMemoryPayload {
    trigger: string;
    rejectedStrategy: string;
    rejectionReason: string;
    saferAlternative: string | null;
    preconditions: string | null;
    attemptedApproach: string | null;
    observedFailure: string | null;
    rootCause: string | null;
    recovery: string | null;
    nonApplicableWhen: string | null;
}

function requiredText(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new ClaimOperationInputError(`anti-memory ${field} must be non-empty`);
    }
    return value.replace(/\s+/g, " ").trim();
}

function optionalText(value: unknown, field: string): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value === "string" && value.trim().length === 0) return null;
    return requiredText(value, field);
}

/** `undefined` and `null` both mean no expiry; anything else must be a positive epoch-milliseconds integer. commentlint: allow(JUDGE) */
function optionalEpochMs(value: unknown, field: string): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new ClaimOperationInputError(
            `anti-memory ${field} must be a positive epoch-milliseconds integer`,
        );
    }
    return value;
}

function antiMemoryExpiry(payload: AntiMemoryPayload): number | null {
    return optionalEpochMs(payload.expiresAt, "expiresAt");
}

/** `true` once the payload's expiry horizon has passed; a payload without one never expires. commentlint: allow(JUDGE) */
export function antiMemoryExpired(payload: AntiMemoryPayload, nowMs: number): boolean {
    const expiresAt = antiMemoryExpiry(payload);
    return expiresAt !== null && expiresAt <= nowMs;
}

/**
 */
export function normalizeAntiMemoryPayload(payload: AntiMemoryPayload): StoredAntiMemoryPayload {
    return {
        trigger: requiredText(payload.trigger, "trigger"),
        rejectedStrategy: requiredText(payload.rejectedStrategy, "rejectedStrategy"),
        rejectionReason: requiredText(payload.rejectionReason, "rejectionReason"),
        saferAlternative: optionalText(payload.saferAlternative, "saferAlternative"),
        preconditions: optionalText(payload.preconditions, "preconditions"),
        attemptedApproach: optionalText(payload.attemptedApproach, "attemptedApproach"),
        observedFailure: optionalText(payload.observedFailure, "observedFailure"),
        rootCause: optionalText(payload.rootCause, "rootCause"),
        recovery: optionalText(payload.recovery, "recovery"),
        nonApplicableWhen: optionalText(payload.nonApplicableWhen, "nonApplicableWhen"),
    };
}

export function renderAntiMemoryContent(payload: AntiMemoryPayload): string {
    const stored = normalizeAntiMemoryPayload(payload);
    const expiresAt = antiMemoryExpiry(payload);
    const lines = [
        `Trigger: ${stored.trigger}`,
        `Rejected strategy: ${stored.rejectedStrategy}`,
        `Rejection reason: ${stored.rejectionReason}`,
    ];
    const optional: Array<[string, string | null]> = [
        ["Safer alternative", stored.saferAlternative],
        ["Preconditions", stored.preconditions],
        ["Attempted approach", stored.attemptedApproach],
        ["Observed failure", stored.observedFailure],
        ["Root cause", stored.rootCause],
        ["Recovery", stored.recovery],
        ["Non-applicable when", stored.nonApplicableWhen],
    ];
    for (const [label, value] of optional) {
        if (value !== null) lines.push(`${label}: ${value}`);
    }
    if (expiresAt !== null) lines.push(`Expires at: ${expiresAt}`);
    return lines.join("\n");
}

export function parseAntiMemoryContent(content: string): AntiMemoryPayload {
    const fields = new Map<string, string>();
    for (const line of content.split(/\r?\n/)) {
        if (line.trim().length === 0) continue;
        const separator = line.indexOf(":");
        if (separator <= 0) throw new ClaimOperationInputError("invalid anti-memory content line");
        const label = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (fields.has(label)) throw new ClaimOperationInputError(`duplicate anti-memory ${label}`);
        fields.set(label, value);
    }
    const known = new Set([
        "Trigger",
        "Rejected strategy",
        "Rejection reason",
        "Safer alternative",
        "Preconditions",
        "Attempted approach",
        "Observed failure",
        "Root cause",
        "Recovery",
        "Non-applicable when",
        "Expires at",
    ]);
    for (const label of fields.keys()) {
        if (!known.has(label))
            throw new ClaimOperationInputError(`unknown anti-memory field ${label}`);
    }
    const rawExpiresAt = fields.get("Expires at");
    const expiresAt =
        rawExpiresAt === undefined
            ? null
            : optionalEpochMs(
                  /^\d+$/.test(rawExpiresAt) ? Number(rawExpiresAt) : rawExpiresAt,
                  "expiresAt",
              );
    return {
        ...normalizeAntiMemoryPayload({
            trigger: requiredText(fields.get("Trigger"), "trigger"),
            rejectedStrategy: requiredText(fields.get("Rejected strategy"), "rejectedStrategy"),
            rejectionReason: requiredText(fields.get("Rejection reason"), "rejectionReason"),
            saferAlternative: fields.get("Safer alternative"),
            preconditions: fields.get("Preconditions"),
            attemptedApproach: fields.get("Attempted approach"),
            observedFailure: fields.get("Observed failure"),
            rootCause: fields.get("Root cause"),
            recovery: fields.get("Recovery"),
            nonApplicableWhen: fields.get("Non-applicable when"),
        }),
        ...(expiresAt === null ? {} : { expiresAt }),
    };
}
