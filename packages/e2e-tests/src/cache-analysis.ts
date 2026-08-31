/**
 * E2E tests use this module to classify cache busts.
 *
 *
 * Anthropic cache hits end at the longest matching prefix with a `cache_control` breakpoint.
 * The oracle compares consecutive requests in a session.
 * The oracle finds the first changed wire-order segment.
 * A divergence in the appended tail yields `STABLE`.
 * BUST.
 *
 * Normalization removes `cache_control` and `cch=<nonce>` before comparing content.
 * OpenCode moves `cache_control` markers each turn to extend the cached boundary.
 * The system block contains a per-request `cch=<nonce>` billing nonce.
 * The oracle removes `cch=<nonce>` because Anthropic ignores it for cache keys.
 * The oracle retains `§N§` prefixes because they are on-wire model content.
 * A changed `§N§` tag number is a cache bust.
 *
 * The OpenCode and Pi harnesses expose `CapturedRequest` values through `mock.requests()`.
 * OpenCode and Pi suites use the same cache-bust oracle.
 */

import { createHash } from "node:crypto";
import {
    INTERNAL_OPENCODE_AGENT_SIGNATURES,
    MAGIC_CONTEXT_INTERNAL_AGENT_SIGNATURES,
} from "../../plugin/src/hooks/magic-context/internal-agent-signatures";

type Json = Record<string, unknown>;

export interface WireSegment {
    id: string;
    hash: string;
    bytes: number;
    breakpoint: boolean;
}

export interface WireSnapshot {
    /** `index` is this request's position in the filtered request list. */
    index: number;
    segments: WireSegment[];
}

export type BustVerdict = "BASE" | "SAME" | "STABLE" | "BUST";

export interface PassComparison {
    /** `index` is the later request's position in the pair. */
    index: number;
    verdict: BustVerdict;
    /** `divergeIndex` is the first diverging wire-order index, or `-1` when no segment diverges. */
    divergeIndex: number;
    /** `divergeSegmentId` identifies the first diverging segment for diagnostics. */
    divergeSegmentId: string | null;
    /* */
    cachedPrefixBytes: number;
    /** `cachedPrefixAt` identifies the last breakpoint before divergence. */
    cachedPrefixAt: string;
    /** `diff` stores previous and current snippets of the diverging segment for failure diagnostics. */
    diff: { prev: string | null; cur: string | null } | null;
}

interface MinimalRequest {
    body: { system?: unknown; messages?: unknown; [k: string]: unknown };
}

const HIDDEN_AGENT_SIGNATURES: readonly string[] = [
    ...INTERNAL_OPENCODE_AGENT_SIGNATURES,
    ...MAGIC_CONTEXT_INTERNAL_AGENT_SIGNATURES,
];

/**
 * Shared signature literals keep the oracle aligned with plugin-defined signatures.
 */
export function isInternalAgentRequest(request: MinimalRequest): boolean {
    const system = request.body.system;
    if (system === undefined || system === null) return false;
    const systemText = typeof system === "string" ? system : JSON.stringify(system);
    return HIDDEN_AGENT_SIGNATURES.some((signature) => systemText.includes(signature));
}

function sha(s: string): string {
    return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

/** `cache_control` movement does not change content. */
function stripCacheControl(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripCacheControl);
    if (value && typeof value === "object") {
        const out: Json = {};
        for (const [k, v] of Object.entries(value as Json)) {
            if (k === "cache_control") continue;
            out[k] = stripCacheControl(v);
        }
        return out;
    }
    return value;
}

function hasCacheControl(block: unknown): boolean {
    return !!block && typeof block === "object" && "cache_control" in (block as Json);
}

function messageHasBreakpoint(msg: Json): boolean {
    const content = msg.content;
    if (Array.isArray(content)) return content.some((p) => hasCacheControl(p));
    return hasCacheControl(msg);
}

/** The normalization step removes the per-request billing nonce so cache classification ignores it. */
function normalizeSystemText(text: string): string {
    return text.replace(/cch=[^;]*;/g, "cch=<NONCE>;");
}

function blockText(block: unknown): string {
    if (block && typeof block === "object" && typeof (block as Json).text === "string") {
        return (block as Json).text as string;
    }
    return JSON.stringify(stripCacheControl(block));
}

/** The segment list orders system blocks before every message. */
export function buildSegments(body: MinimalRequest["body"]): WireSegment[] {
    const segs: WireSegment[] = [];
    const system = body.system;
    const sysBlocks = Array.isArray(system) ? system : system != null ? [system] : [];
    sysBlocks.forEach((b, i) => {
        const raw = blockText(b);
        segs.push({
            id: `system[${i}]`,
            hash: sha(normalizeSystemText(raw)),
            bytes: Buffer.byteLength(raw),
            breakpoint: hasCacheControl(b),
        });
    });
    const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : [];
    messages.forEach((m, i) => {
        const norm = JSON.stringify({ role: m.role, content: stripCacheControl(m.content) });
        segs.push({
            id: `message[${i}](${String(m.role)})`,
            hash: sha(norm),
            bytes: Buffer.byteLength(JSON.stringify(m)),
            breakpoint: messageHasBreakpoint(m),
        });
    });
    return segs;
}

/** `divergeIndex` is the first wire-order index where `prev` and `cur` differ, including added or removed segments. */
function firstDivergence(prev: WireSegment[], cur: WireSegment[]): number {
    const n = Math.min(prev.length, cur.length);
    for (let i = 0; i < n; i += 1) {
        if (prev[i].hash !== cur[i].hash || prev[i].id !== cur[i].id) return i;
    }
    return prev.length === cur.length ? -1 : n;
}

/** `cachedPrefixBytes` counts bytes through the last breakpoint before divergence. */
function cachedPrefixBytes(segs: WireSegment[], divergeIdx: number): { bytes: number; at: string } {
    let bytes = 0;
    let lastBreakpointBytes = 0;
    let lastBreakpointId = "(none)";
    const limit = divergeIdx < 0 ? segs.length : divergeIdx;
    for (let i = 0; i < segs.length; i += 1) {
        if (i < limit && segs[i].breakpoint) {
            lastBreakpointBytes = bytes + segs[i].bytes;
            lastBreakpointId = segs[i].id;
        }
        bytes += segs[i].bytes;
    }
    return { bytes: lastBreakpointBytes, at: lastBreakpointId };
}

function lastBreakpointIndex(segs: WireSegment[]): number {
    let last = -1;
    for (let i = 0; i < segs.length; i += 1) if (segs[i].breakpoint) last = i;
    return last;
}

function rawSegmentText(body: MinimalRequest["body"], idx: number): string | null {
    const system = body.system;
    const sysBlocks = Array.isArray(system) ? system : system != null ? [system] : [];
    if (idx < sysBlocks.length) return blockText(sysBlocks[idx]);
    const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : [];
    const mIdx = idx - sysBlocks.length;
    const m = messages[mIdx];
    if (!m) return null;
    return JSON.stringify({ role: m.role, content: stripCacheControl(m.content) });
}

/**
 * `requests` is in wire order.
 */
export function analyzePasses(requests: MinimalRequest[]): PassComparison[] {
    const out: PassComparison[] = [];
    const snaps = requests.map((r) => buildSegments(r.body));
    for (let k = 0; k < snaps.length; k += 1) {
        if (k === 0) {
            out.push({
                index: 0,
                verdict: "BASE",
                divergeIndex: -1,
                divergeSegmentId: null,
                cachedPrefixBytes: 0,
                cachedPrefixAt: "(base)",
                diff: null,
            });
            continue;
        }
        const prev = snaps[k - 1];
        const cur = snaps[k];
        const idx = firstDivergence(prev, cur);
        if (idx === -1) {
            out.push({
                index: k,
                verdict: "SAME",
                divergeIndex: -1,
                divergeSegmentId: null,
                cachedPrefixBytes: cachedPrefixBytes(cur, -1).bytes,
                cachedPrefixAt: cachedPrefixBytes(cur, -1).at,
                diff: null,
            });
            continue;
        }
        // Classify the transition using `PREV`'s last breakpoint, not `CUR`'s.
        // The oracle returns `STABLE` when the first divergence is strictly after `prev`'s last breakpoint.
        // `STABLE` permits changes only after the previous request's last breakpoint, including a pure append.
        // `BUST` applies when the first divergence is at or before the previous request's last breakpoint.
        // prevLastBreakpoint === -1 means prev cached nothing → no bust possible.
        const prevLastBreakpoint = lastBreakpointIndex(prev);
        const verdict: BustVerdict = idx > prevLastBreakpoint ? "STABLE" : "BUST";
        const cp = cachedPrefixBytes(cur, idx);
        const seg = cur[idx] ?? prev[idx];
        out.push({
            index: k,
            verdict,
            divergeIndex: idx,
            divergeSegmentId: seg?.id ?? `seg[${idx}]`,
            cachedPrefixBytes: cp.bytes,
            cachedPrefixAt: cp.at,
            diff:
                verdict === "BUST"
                    ? {
                          prev: rawSegmentText(requests[k - 1].body, idx)?.slice(0, 400) ?? null,
                          cur: rawSegmentText(requests[k].body, idx)?.slice(0, 400) ?? null,
                      }
                    : null,
        });
    }
    return out;
}

/* */
export function findBusts(requests: MinimalRequest[]): PassComparison[] {
    return analyzePasses(requests).filter((c) => c.verdict === "BUST");
}

/* */
export function mainAgentRequests<T extends MinimalRequest>(requests: T[]): T[] {
    return requests.filter((r) => {
        const sys = r.body.system;
        if (sys === undefined || sys === null) return false;
        const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
        return asString.includes("## Magic Context");
    });
}

/**
 *
 */
export function extractMessageText(body: MinimalRequest["body"], marker: string): string | null {
    const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : [];
    for (const m of messages) {
        const content = m.content;
        // Whole-message scans can conflate text blocks that contain different session-history markers.
        // The `-since>` suffix prevents `<session-history-since>` from matching `<session-history>`.
        if (typeof content === "string") {
            if (content.includes(marker)) return content;
        } else if (Array.isArray(content)) {
            for (const block of content) {
                if (block && typeof block === "object" && typeof (block as Json).text === "string") {
                    const text = (block as Json).text as string;
                    if (text.includes(marker)) return text;
                }
            }
        }
    }
    return null;
}

/* */
export function extractM0(body: MinimalRequest["body"]): string | null {
    return extractMessageText(body, "<session-history>");
}

/* */
export function extractM1(body: MinimalRequest["body"]): string | null {
    return extractMessageText(body, "<session-history-since>");
}

/* */
export function formatBustReport(comparisons: PassComparison[]): string {
    const lines: string[] = [];
    for (const c of comparisons) {
        if (c.verdict === "BUST") {
            lines.push(
                `  BUST @pass ${c.index}: first divergence ${c.divergeSegmentId} ` +
                    `(before final breakpoint; cached prefix collapsed to ${c.cachedPrefixAt}, ${c.cachedPrefixBytes.toLocaleString()}B)`,
            );
            if (c.diff) {
                lines.push(`    prev: ${c.diff.prev ?? "—"}`);
                lines.push(`    cur:  ${c.diff.cur ?? "—"}`);
            }
        }
    }
    return lines.length ? lines.join("\n") : "  (no busts)";
}
