import * as https from "node:https";
import { type LookupFunction } from "node:net";
export interface ResolvedSmartNoteAddress {
    address: string;
    family: 4 | 6;
    classification: "global";
}
export interface SmartNoteUrlValidation {
    url: URL;
    hostname: string;
    addresses: ResolvedSmartNoteAddress[];
}
export interface SmartNoteResolver {
    lookup(hostname: string, signal: AbortSignal): Promise<Array<{
        address: string;
        family: 4 | 6;
    }>>;
}
type SmartNoteAddressRequest = (validation: SmartNoteUrlValidation, candidate: ResolvedSmartNoteAddress, options: {
    signal: AbortSignal;
    timeoutMs: number;
    bodyLimitBytes: number;
}) => Promise<{
    status: number;
    body: string;
}>;
export interface GuardedSmartNoteHttpGetOptions {
    signal: AbortSignal;
    resolver?: SmartNoteResolver;
    timeoutMs?: number;
    bodyLimitBytes?: number;
    requestAddress?: SmartNoteAddressRequest;
}
export declare function validateSmartNoteHttpUrl(input: string, options?: {
    signal?: AbortSignal;
    resolver?: SmartNoteResolver;
}): Promise<SmartNoteUrlValidation>;
export declare function guardedSmartNoteHttpGet(input: string, options: GuardedSmartNoteHttpGetOptions): Promise<{
    status: number;
    body: string;
}>;
/**
 * A `net.LookupFunction`-shaped hook that always resolves to the single
 * pre-validated, pinned IP — never re-querying DNS (anti-rebinding). Node may
 * invoke it with `{ all: true }` (Happy-Eyeballs / autoSelectFamily), which
 * expects the ARRAY callback form, or with the legacy single-address form. We
 * honor both: returning the wrong shape made Node's lookupAndConnectMultiple
 * call `results.sort(...)` on `undefined`, which surfaced as
 * "SMART_NOTE_NETWORK: results.sort is not a function" and broke every
 * network-touching smart-note check.
 *
 * Node's `LookupFunction` type only models the legacy 3-arg callback, so the
 * dual-shape dispatch is expressed against a locally-widened callback type and
 * the result is asserted back to `LookupFunction` for `https.request`.
 */
export declare function createPinnedLookup(candidate: {
    address: string;
    family: 4 | 6;
}): LookupFunction;
export declare function requestValidatedAddress(validation: SmartNoteUrlValidation, candidate: ResolvedSmartNoteAddress, options: {
    signal: AbortSignal;
    timeoutMs: number;
    bodyLimitBytes: number;
}): Promise<{
    status: number;
    body: string;
}>;
export declare function createSmartNoteRequestAgent(): https.Agent;
export {};
//# sourceMappingURL=ssrf-guard.d.ts.map