import { createHash } from "node:crypto";

import type { MessageLike } from "./transform-operations";

export interface LkgSlot {
    jsonPrefix: string;
    inputIdSeq: string[];
    inputContentDigests: string[];
    /** `inputContentSignatures` stores cheap content signatures aligned with `inputIdSeq` to reuse digests. */
    inputContentSignatures?: string[];
    lastInputMessageId: string;
    modelKey: string | null;
    providerKey: string | null;
    capturedAt: number;
    rowVersion?: number;
    captureSequence?: number;
}

export interface LkgEntryNote {
    pristineTail: MessageLike[];
    entryInputIds: string[];
    entryContentDigests: string[];
    anchorIndex: number;
}

const LKG_TOTAL_BYTES = 64 * 1024 * 1024;
const LKG_SINGLE_SLOT_BYTES = 24 * 1024 * 1024;
const LKG_METADATA_BYTES = 256;

const slots = new Map<string, { slot: LkgSlot; bytes: number }>();
let totalBytes = 0;

function slotBytes(slot: LkgSlot): number {
    const digestBytes = slot.inputContentDigests.reduce(
        (total, digest) => total + 2 * digest.length,
        0,
    );
    return 2 * slot.jsonPrefix.length + digestBytes + LKG_METADATA_BYTES;
}

export type LkgContentField = string | number | boolean | symbol;

export const LKG_SNAPSHOT_ARRAY = Symbol("array");
export const LKG_SNAPSHOT_OBJECT = Symbol("object");
export const LKG_SNAPSHOT_KEY = Symbol("key");
export const LKG_SNAPSHOT_STRING = Symbol("string");
export const LKG_SNAPSHOT_NUMBER = Symbol("number");
export const LKG_SNAPSHOT_BOOLEAN = Symbol("boolean");
export const LKG_SNAPSHOT_NULL = Symbol("null");
export const LKG_SNAPSHOT_UNDEFINED = Symbol("undefined");

/** `lkgContentFields` tokenizes values without deep-copying strings. */
export function lkgContentFields(value: unknown): LkgContentField[] | null {
    const fields: LkgContentField[] = [];
    const seen = new WeakSet<object>();
    const visit = (child: unknown): void => {
        if (child === null) fields.push(LKG_SNAPSHOT_NULL);
        else if (typeof child === "string") fields.push(LKG_SNAPSHOT_STRING, child);
        else if (typeof child === "number") fields.push(LKG_SNAPSHOT_NUMBER, child);
        else if (typeof child === "boolean") fields.push(LKG_SNAPSHOT_BOOLEAN, child);
        else if (child === undefined || typeof child === "function" || typeof child === "symbol") {
            fields.push(LKG_SNAPSHOT_UNDEFINED);
        } else if (Array.isArray(child)) {
            if (seen.has(child)) throw new Error("cyclic message");
            seen.add(child);
            fields.push(LKG_SNAPSHOT_ARRAY, child.length);
            for (const item of child) visit(item);
            seen.delete(child);
        } else if (typeof child === "object") {
            if (seen.has(child)) throw new Error("cyclic message");
            seen.add(child);
            const entries = Object.entries(child).filter(
                ([, entry]) =>
                    entry !== undefined && typeof entry !== "function" && typeof entry !== "symbol",
            );
            fields.push(LKG_SNAPSHOT_OBJECT, entries.length);
            for (const [key, entry] of entries) {
                fields.push(LKG_SNAPSHOT_KEY, key);
                visit(entry);
            }
            seen.delete(child);
        } else fields.push(LKG_SNAPSHOT_UNDEFINED);
    };
    try {
        visit(value);
        return fields;
    } catch {
        return null;
    }
}

export function lkgContentDigestFromFields(fields: readonly LkgContentField[]): string {
    const hash = createHash("sha256");
    for (const field of fields) {
        const value = typeof field === "symbol" ? (field.description ?? "") : String(field);
        hash.update(`${typeof field}:${value.length}:`)
            .update(value)
            .update("\0");
    }
    return hash.digest("base64url");
}

export interface LkgDigestEntry {
    id: string;
    signature: string;
    fields: readonly LkgContentField[];
}

export interface LkgDigestPrior {
    ids: readonly string[];
    signatures: readonly string[];
    digests: readonly string[];
}

/**
 * The digest computation reuses prior digests for the unchanged ID-and-signature prefix and hashes entries from the first changed entry onward.
 * Digest reuse must match a full recomputation after any ID or signature change.
 */
export function incrementalLkgContentDigests(
    entries: readonly LkgDigestEntry[],
    prior?: LkgDigestPrior,
): { digests: string[]; reusedPrefix: number } {
    const aligned =
        prior !== undefined &&
        prior.ids.length === prior.signatures.length &&
        prior.signatures.length === prior.digests.length;
    let reusedPrefix = 0;
    if (aligned && prior) {
        while (
            reusedPrefix < entries.length &&
            reusedPrefix < prior.ids.length &&
            entries[reusedPrefix]?.id === prior.ids[reusedPrefix] &&
            entries[reusedPrefix]?.signature === prior.signatures[reusedPrefix]
        ) {
            reusedPrefix += 1;
        }
    }
    const digests: string[] = [];
    if (aligned && prior) {
        for (let index = 0; index < reusedPrefix; index += 1) {
            digests.push(prior.digests[index] as string);
        }
    }
    for (let index = reusedPrefix; index < entries.length; index += 1) {
        digests.push(lkgContentDigestFromFields(entries[index]?.fields ?? []));
    }
    return { digests, reusedPrefix };
}

/** The LKG replay check digests the full message tree to detect input drift. */
export function lkgContentDigest(message: MessageLike): string | null {
    const fields = lkgContentFields(message);
    return fields ? lkgContentDigestFromFields(fields) : null;
}

function touch(sessionId: string, entry: { slot: LkgSlot; bytes: number }): void {
    slots.delete(sessionId);
    slots.set(sessionId, entry);
}

export function captureSlot(sessionId: string, slot: LkgSlot): boolean {
    if (
        slot.inputContentDigests.length !== slot.inputIdSeq.length ||
        slot.inputContentDigests.some((digest) => digest.length === 0) ||
        (slot.inputContentSignatures !== undefined &&
            (slot.inputContentSignatures.length !== slot.inputIdSeq.length ||
                slot.inputContentSignatures.some((signature) => signature.length === 0)))
    ) {
        return false;
    }
    const bytes = slotBytes(slot);
    if (bytes > LKG_SINGLE_SLOT_BYTES) return false;
    const prior = slots.get(sessionId);
    if (
        prior?.slot.rowVersion !== undefined &&
        slot.rowVersion !== undefined &&
        (slot.rowVersion < prior.slot.rowVersion ||
            (slot.rowVersion === prior.slot.rowVersion &&
                (slot.captureSequence ?? 0) < (prior.slot.captureSequence ?? 0)))
    ) {
        return false;
    }
    if (prior) totalBytes -= prior.bytes;
    slots.delete(sessionId);
    while (totalBytes + bytes > LKG_TOTAL_BYTES) {
        const oldest = slots.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        const evicted = slots.get(oldest);
        slots.delete(oldest);
        if (evicted) totalBytes -= evicted.bytes;
    }
    if (totalBytes + bytes > LKG_TOTAL_BYTES) {
        if (prior) {
            slots.set(sessionId, prior);
            totalBytes += prior.bytes;
        }
        return false;
    }
    const entry = {
        slot: {
            ...slot,
            inputIdSeq: [...slot.inputIdSeq],
            inputContentDigests: [...slot.inputContentDigests],
            inputContentSignatures: slot.inputContentSignatures
                ? [...slot.inputContentSignatures]
                : undefined,
        },
        bytes,
    };
    slots.set(sessionId, entry);
    totalBytes += bytes;
    return true;
}

export function getSlot(sessionId: string): LkgSlot | undefined {
    const entry = slots.get(sessionId);
    if (!entry) return undefined;
    touch(sessionId, entry);
    return {
        ...entry.slot,
        inputIdSeq: [...entry.slot.inputIdSeq],
        inputContentDigests: [...entry.slot.inputContentDigests],
        inputContentSignatures: entry.slot.inputContentSignatures
            ? [...entry.slot.inputContentSignatures]
            : undefined,
    };
}

export function dropSlot(sessionId: string, _reason?: string): void {
    const entry = slots.get(sessionId);
    if (!entry) return;
    slots.delete(sessionId);
    totalBytes -= entry.bytes;
}

export function noteEntry(sessionId: string, messages: MessageLike[]): LkgEntryNote | null {
    const slot = getSlot(sessionId);
    if (!slot) return null;
    const entryInputIds = messages.map((message) => {
        const id = (message.info as { id?: unknown } | undefined)?.id;
        return typeof id === "string" ? id : "";
    });
    const anchorIndex = entryInputIds.indexOf(slot.lastInputMessageId);
    if (anchorIndex < 0) return null;
    const entryContentDigests = messages
        .slice(0, anchorIndex + 1)
        .map((message) => lkgContentDigest(message));
    if (entryContentDigests.some((digest) => digest === null)) return null;
    const pristineTail = structuredClone(messages.slice(anchorIndex + 1)) as MessageLike[];
    return {
        pristineTail,
        entryInputIds,
        entryContentDigests: entryContentDigests as string[],
        anchorIndex,
    };
}

export function resetLkgSlotsForTest(): void {
    slots.clear();
    totalBytes = 0;
}

export function getLkgSlotStatsForTest(): { totalBytes: number; count: number } {
    return { totalBytes, count: slots.size };
}

export const __resetLkgSlotStoreForTest = resetLkgSlotsForTest;
