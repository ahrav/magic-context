import { lookup as dnsLookup } from "node:dns/promises";
import * as https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { domainToASCII } from "node:url";

import {
    isTerminalSmartNoteNetworkError,
    SmartNoteNetworkError,
    SmartNoteSecurityError,
} from "./types";

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
    lookup(
        hostname: string,
        signal: AbortSignal,
    ): Promise<Array<{ address: string; family: 4 | 6 }>>;
}

type SmartNoteAddressRequest = (
    validation: SmartNoteUrlValidation,
    candidate: ResolvedSmartNoteAddress,
    options: { signal: AbortSignal; timeoutMs: number; bodyLimitBytes: number },
) => Promise<{ status: number; body: string }>;

export interface GuardedSmartNoteHttpGetOptions {
    signal: AbortSignal;
    resolver?: SmartNoteResolver;
    timeoutMs?: number;
    bodyLimitBytes?: number;
    requestAddress?: SmartNoteAddressRequest;
}

const DNS_TIMEOUT_MS = 3_000;
const DEFAULT_HTTP_TIMEOUT_MS = 5_000;
const DEFAULT_HTTP_BODY_LIMIT_BYTES = 64 * 1024;
const MAX_HTTP_ADDRESS_CANDIDATES = 4;

const defaultResolver: SmartNoteResolver = {
    async lookup(hostname, signal) {
        return await withAbortAndTimeout(
            dnsLookup(hostname, { all: true, verbatim: true }) as Promise<
                Array<{ address: string; family: number }>
            >,
            signal,
            DNS_TIMEOUT_MS,
            "DNS lookup timed out",
        ).then((rows) =>
            rows
                .filter(
                    (row): row is { address: string; family: 4 | 6 } =>
                        row.family === 4 || row.family === 6,
                )
                .map((row) => ({ address: row.address, family: row.family })),
        );
    },
};

export async function validateSmartNoteHttpUrl(
    input: string,
    options: { signal?: AbortSignal; resolver?: SmartNoteResolver } = {},
): Promise<SmartNoteUrlValidation> {
    const signal = options.signal ?? new AbortController().signal;
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        throw new SmartNoteSecurityError("invalid URL");
    }
    if (url.protocol !== "https:") {
        throw new SmartNoteSecurityError("smart-note httpGet only permits https URLs");
    }
    if (url.username || url.password) {
        throw new SmartNoteSecurityError("credentials in URLs are not allowed");
    }
    if (url.hash) {
        // The validator removes fragments because servers never receive them.
        url.hash = "";
    }

    const hostname = stripIpv6Brackets(url.hostname);
    if (!hostname) {
        throw new SmartNoteSecurityError("URL host is required");
    }
    const addresses = await resolveHostToValidatedGlobalAddresses(
        hostname,
        signal,
        options.resolver,
    );
    return { url, hostname, addresses };
}

export async function guardedSmartNoteHttpGet(
    input: string,
    options: GuardedSmartNoteHttpGetOptions,
): Promise<{ status: number; body: string }> {
    const validation = await validateSmartNoteHttpUrl(input, {
        signal: options.signal,
        resolver: options.resolver,
    });
    const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_HTTP_BODY_LIMIT_BYTES;
    const requestAddress = options.requestAddress ?? requestValidatedAddress;
    // The request tries at most MAX_HTTP_ADDRESS_CANDIDATES validated IPs to bound per-host egress.
    const candidates = validation.addresses.slice(0, MAX_HTTP_ADDRESS_CANDIDATES);
    let lastError: unknown;
    for (const candidate of candidates) {
        try {
            return await requestAddress(validation, candidate, {
                signal: options.signal,
                timeoutMs,
                bodyLimitBytes,
            });
        } catch (error) {
            lastError = error;
            if (
                error instanceof SmartNoteSecurityError ||
                options.signal.aborted ||
                isTerminalSmartNoteNetworkError(error)
            ) {
                throw error;
            }
        }
    }
    throw toNetworkError(lastError, "all validated addresses failed");
}

async function resolveHostToValidatedGlobalAddresses(
    rawHostname: string,
    signal: AbortSignal,
    resolver = defaultResolver,
): Promise<ResolvedSmartNoteAddress[]> {
    throwIfAborted(signal);
    const literal = parseIpLiteral(rawHostname);
    const candidates = literal
        ? [{ address: literal.address, family: literal.family }]
        : await resolver.lookup(canonicalDnsName(rawHostname), signal).catch((error) => {
              throw toNetworkError(error, "DNS resolution failed");
          });

    if (candidates.length === 0) {
        throw new SmartNoteSecurityError("DNS resolution returned no addresses");
    }

    // Each request uses one validated IPv4 address, so the resolver discards IPv6 DNS answers to keep dual-stack hosts reachable.
    // IPv6-only destinations remain blocked because no request candidate survives.
    const ipv4Candidates = candidates.filter(
        (candidate) => candidate.family !== 6 && !candidate.address.includes(":"),
    );
    if (ipv4Candidates.length === 0) {
        throw new SmartNoteNetworkError("SMART_NOTE_NETWORK: IPv6 destinations are not permitted");
    }

    const classified = ipv4Candidates.map((candidate) => {
        const parsed = parseIpLiteral(candidate.address);
        if (parsed?.family !== 4) {
            throw new SmartNoteSecurityError(
                `DNS returned an unparsable IPv4 address: ${candidate.address}`,
            );
        }
        return {
            address: parsed.address,
            family: parsed.family,
            global: isGlobalAddress(parsed),
        };
    });

    if (classified.some((candidate) => !candidate.global)) {
        throw new SmartNoteSecurityError("URL resolves to a non-global/internal address");
    }

    return classified.map((candidate) => ({
        address: candidate.address,
        family: candidate.family,
        classification: "global" as const,
    }));
}

/**
 * The lookup hook returns only the prevalidated pinned IP and never re-queries DNS.
 * Node can invoke the lookup hook with `{ all: true }`, which requires the array callback form.
 *
 * The cast adapts the dual-shape hook to `https.request`'s legacy `LookupFunction` type.
 */
export function createPinnedLookup(candidate: { address: string; family: 4 | 6 }): LookupFunction {
    const hook = (
        _hostname: string,
        lookupOptions: { all?: boolean } | undefined,
        cb: (
            err: Error | null,
            addressOrList: string | Array<{ address: string; family: number }>,
            family?: number,
        ) => void,
    ): void => {
        if (lookupOptions?.all) {
            cb(null, [{ address: candidate.address, family: candidate.family }]);
            return;
        }
        cb(null, candidate.address, candidate.family);
    };
    return hook as unknown as LookupFunction;
}

export function requestValidatedAddress(
    validation: SmartNoteUrlValidation,
    candidate: ResolvedSmartNoteAddress,
    options: { signal: AbortSignal; timeoutMs: number; bodyLimitBytes: number },
): Promise<{ status: number; body: string }> {
    // A request-local agent prevents reuse of sockets not opened through the pinned lookup.
    const agent = createSmartNoteRequestAgent();
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const url = validation.url;
        const hostHeader = url.host;
        const request = https.request(
            {
                protocol: "https:",
                hostname: validation.hostname,
                port: url.port ? Number(url.port) : 443,
                path: `${url.pathname}${url.search}`,
                method: "GET",
                servername: isIP(validation.hostname) ? undefined : validation.hostname,
                headers: {
                    Host: hostHeader,
                    "User-Agent": "magic-context-smart-note-check/1",
                    Accept: "text/plain, application/json;q=0.9, */*;q=0.1",
                },
                // The connector uses the prevalidated IP while TLS verifies the original hostname.
                // network-touching check.
                lookup: createPinnedLookup(candidate),
                agent,
                timeout: options.timeoutMs,
            },
            (response) => {
                const chunks: Buffer[] = [];
                let bytes = 0;
                response.on("data", (chunk: Buffer | string) => {
                    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    bytes += buf.byteLength;
                    if (bytes > options.bodyLimitBytes) {
                        // Destroying the request without an error avoids an error emitted by `destroy()`.
                        reject(
                            new SmartNoteNetworkError(
                                "SMART_NOTE_NETWORK: response body too large",
                                { terminal: true },
                            ),
                        );
                        response.destroy();
                        request.destroy();
                        return;
                    }
                    chunks.push(buf);
                });
                response.on("error", (error) => {
                    reject(toNetworkError(error, "response failed"));
                });
                response.on("end", () => {
                    const status = response.statusCode ?? 0;
                    if (status >= 500) {
                        reject(
                            new SmartNoteNetworkError(
                                `SMART_NOTE_NETWORK: transient HTTP ${status}`,
                            ),
                        );
                        return;
                    }
                    resolve({ status, body: Buffer.concat(chunks).toString("utf8") });
                });
            },
        );

        const onAbort = () => {
            reject(new SmartNoteNetworkError("SMART_NOTE_NETWORK: aborted"));
            request.destroy();
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        request.on("timeout", () => {
            reject(
                new SmartNoteNetworkError("SMART_NOTE_NETWORK: request timed out", {
                    terminal: true,
                }),
            );
            request.destroy();
        });
        request.on("error", (error) => {
            options.signal.removeEventListener("abort", onAbort);
            reject(toNetworkError(error, "request failed"));
        });
        request.on("close", () => options.signal.removeEventListener("abort", onAbort));
        request.end();
    }).finally(() => agent.destroy());
}

export function createSmartNoteRequestAgent(): https.Agent {
    return new https.Agent({ keepAlive: false, maxSockets: 1 });
}

function canonicalDnsName(hostname: string): string {
    const ascii = domainToASCII(hostname);
    if (!ascii) throw new SmartNoteSecurityError("invalid DNS hostname");
    return ascii;
}

function parseIpLiteral(
    hostname: string,
):
    | { family: 4; address: string; value: number }
    | { family: 6; address: string; value: bigint; mappedIpv4?: number }
    | null {
    const host = stripIpv6Brackets(hostname).toLowerCase();
    if (isIP(host) === 4) {
        return { family: 4, address: host, value: ipv4ToNumber(host) };
    }
    if (isIP(host) === 6) {
        const parsed = parseIpv6ToParts(host);
        if (!parsed) return null;
        const value = ipv6PartsToBigInt(parsed.parts);
        const mappedIpv4 = ipv4MappedValue(parsed.parts);
        return { family: 6, address: host, value, mappedIpv4 };
    }
    return null;
}

function stripIpv6Brackets(hostname: string): string {
    return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function ipv4ToNumber(address: string): number {
    const parts = address.split(".").map((part) => Number(part));
    if (
        parts.length !== 4 ||
        parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
        throw new SmartNoteSecurityError(`invalid IPv4 address: ${address}`);
    }
    return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function parseIpv6ToParts(address: string): { parts: number[] } | null {
    if (address.includes("%")) return null;
    let text = address;
    if (text.includes(".")) {
        const idx = text.lastIndexOf(":");
        if (idx < 0) return null;
        const ipv4 = text.slice(idx + 1);
        const v4 = ipv4ToNumber(ipv4);
        text = `${text.slice(0, idx)}:${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
    }
    const halves = text.split("::");
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const parse = (part: string) => {
        if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
        const value = Number.parseInt(part, 16);
        return Number.isInteger(value) && value >= 0 && value <= 0xffff ? value : null;
    };
    const parsedLeft = left.map(parse);
    const parsedRight = right.map(parse);
    if (parsedLeft.some((p) => p == null) || parsedRight.some((p) => p == null)) return null;
    const missing = 8 - parsedLeft.length - parsedRight.length;
    if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
    return {
        parts: [
            ...(parsedLeft as number[]),
            ...Array.from({ length: missing }, () => 0),
            ...(parsedRight as number[]),
        ],
    };
}

function ipv6PartsToBigInt(parts: number[]): bigint {
    return parts.reduce((acc, part) => (acc << 16n) | BigInt(part), 0n);
}

function ipv4MappedValue(parts: number[]): number | undefined {
    if (parts.length !== 8) return undefined;
    if (parts.slice(0, 5).some((part) => part !== 0) || parts[5] !== 0xffff) return undefined;
    return (((parts[6] << 16) >>> 0) + parts[7]) >>> 0;
}

function isGlobalAddress(
    parsed: { family: 4; value: number } | { family: 6; value: bigint; mappedIpv4?: number },
): boolean {
    if (parsed.family === 4) return isGlobalIpv4(parsed.value);
    if (parsed.mappedIpv4 !== undefined) return isGlobalIpv4(parsed.mappedIpv4);
    return isGlobalIpv6(parsed.value);
}

function isGlobalIpv4(value: number): boolean {
    const inRange = (base: number, bits: number) => (value & mask(bits)) === (base & mask(bits));
    return !(
        inRange(0x00000000, 8) ||
        inRange(0x0a000000, 8) ||
        inRange(0x64400000, 10) ||
        inRange(0x7f000000, 8) ||
        inRange(0xa9fe0000, 16) ||
        inRange(0xac100000, 12) ||
        inRange(0xc0000000, 24) ||
        inRange(0xc0000200, 24) ||
        inRange(0xc0a80000, 16) ||
        inRange(0xc0586300, 24) ||
        inRange(0xc6120000, 15) ||
        inRange(0xc6336400, 24) ||
        inRange(0xcb007100, 24) ||
        inRange(0xe0000000, 4) ||
        inRange(0xf0000000, 4) ||
        value === 0xffffffff
    );
}

function mask(bits: number): number {
    return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}

function isGlobalIpv6(value: bigint): boolean {
    const inRange = (base: bigint, bits: number) =>
        (value & maskBig(bits)) === (base & maskBig(bits));
    return (
        inRange(0x20000000000000000000000000000000n, 3) &&
        !inRange(0x20010000000000000000000000000000n, 23) &&
        !inRange(0x20010db8000000000000000000000000n, 32) &&
        !inRange(0x20020000000000000000000000000000n, 16) &&
        !inRange(0x64ff9b00000000000000000000000000n, 96) &&
        !inRange(0x64ff9b00010000000000000000000000n, 48) &&
        !inRange(0x10000000000000000000000000000000n, 64) &&
        !inRange(0xfc000000000000000000000000000000n, 7) &&
        !inRange(0xfe800000000000000000000000000000n, 10) &&
        !inRange(0xff000000000000000000000000000000n, 8) &&
        value !== 0n &&
        value !== 1n
    );
}

function maskBig(bits: number): bigint {
    return bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
}

async function withAbortAndTimeout<T>(
    promise: Promise<T>,
    signal: AbortSignal,
    timeoutMs: number,
    timeoutMessage: string,
): Promise<T> {
    throwIfAborted(signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(
                    () => reject(new SmartNoteNetworkError(timeoutMessage)),
                    timeoutMs,
                );
                signal.addEventListener(
                    "abort",
                    () => reject(new SmartNoteNetworkError("SMART_NOTE_NETWORK: aborted")),
                    { once: true },
                );
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new SmartNoteNetworkError("SMART_NOTE_NETWORK: aborted");
}

function toNetworkError(error: unknown, fallback: string): SmartNoteNetworkError {
    if (error instanceof SmartNoteNetworkError) return error;
    const message = error instanceof Error ? error.message : String(error || fallback);
    return new SmartNoteNetworkError(`SMART_NOTE_NETWORK: ${message || fallback}`);
}
