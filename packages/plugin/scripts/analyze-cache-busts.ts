#!/usr/bin/env bun
/**
 * The script locates Anthropic prompt-cache busts in a session's request dumps.
 *
 * The plugin writes each outbound request body to `<tmpdir>/opencode-anthropic-auth-dumps/*.body.json`.
 * The plugin stores a `.meta.json` file beside each request body dump.
 * Anthropic caches only the longest matching prefix ending at a `cache_control` breakpoint.
 * The first diverging segment identifies the cache-bust origin.
 *
 * Anthropic ignores the per-request `cch=<nonce>` billing-header value when cache-keying.
 * `cache_control` markers move between the last and second-last message each turn.
 * The tool strips `cache_control` before hashing because marker movement does not change content.
 * The tool preserves `§N§` tag prefixes because they are on-wire model input.
 * A changed `§N§` tag number is a genuine cache bust.
 *
 * Usage:
 * Options:
 * `--all-rows` includes STABLE and SAME rows.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Json = Record<string, unknown>;

interface Segment {
    id: string;
    hash: string;
    bytes: number;
    breakpoint: boolean;
}

interface Snapshot {
    file: string;
    createdAt: string;
    session: string;
    messagesCount: number;
    segments: Segment[];
}

function sha(s: string): string {
    return createHash("sha256").update(s).digest("hex").slice(0, 10);
}

function parseArgs(argv: string[]): {
    sessionPrefix: string;
    dir: string;
    since?: string;
    until?: string;
    limit?: number;
    showDiff: boolean;
    allBusts: boolean;
    allRows: boolean;
} {
    const args = argv.slice(2);
    const sessionPrefix = args.find((a) => !a.startsWith("--")) ?? "";
    const getOpt = (name: string): string | undefined => {
        const i = args.indexOf(name);
        return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
    };
    const dir =
        getOpt("--dir") ?? join(tmpdir(), "opencode-anthropic-auth-dumps");
    const limitRaw = getOpt("--limit");
    return {
        sessionPrefix,
        dir,
        since: getOpt("--since"),
        until: getOpt("--until"),
        limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
        showDiff: args.includes("--show-diff"),
        allBusts: args.includes("--all-busts"),
        allRows: args.includes("--all-rows"),
    };
}

/** stripCacheControl removes `cache_control` fields because marker movement does not change content. */
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
    if (Array.isArray(content)) {
        return content.some((p) => hasCacheControl(p));
    }
    return hasCacheControl(msg);
}

/** normalizeSystemText replaces the per-request billing nonce so it does not change the hash. */
function normalizeSystemText(text: string): string {
    return text.replace(/cch=[^;]*;/g, "cch=<NONCE>;");
}

function blockText(block: unknown): string {
    if (block && typeof block === "object" && typeof (block as Json).text === "string") {
        return (block as Json).text as string;
    }
    return JSON.stringify(stripCacheControl(block));
}

function buildSegments(body: Json): Segment[] {
    const segs: Segment[] = [];
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

function loadSnapshots(opts: ReturnType<typeof parseArgs>): Snapshot[] {
    const metas = readdirSync(opts.dir).filter((f) => f.endsWith(".meta.json"));
    const snaps: Snapshot[] = [];
    for (const metaFile of metas) {
        let meta: Json;
        try {
            meta = JSON.parse(readFileSync(join(opts.dir, metaFile), "utf8")) as Json;
        } catch {
            continue;
        }
        const session = String(meta.session ?? "");
        // Dumped session IDs contain an ellipsis; matching their visible head accepts both full IDs and head fragments.
        const head = session.replace(/[….]+$/, "");
        if (!session.startsWith(opts.sessionPrefix) && !opts.sessionPrefix.startsWith(head)) {
            continue;
        }
        const createdAt = String(meta.createdAt ?? "");
        if (opts.since && createdAt < opts.since) continue;
        if (opts.until && createdAt > opts.until) continue;
        const files = meta.files as Json | undefined;
        const bodyPath = files && typeof files.body === "string" ? files.body : undefined;
        if (!bodyPath) continue;
        let body: Json;
        try {
            body = JSON.parse(readFileSync(bodyPath, "utf8")) as Json;
        } catch {
            continue;
        }
        const bodyMeta = meta.body as Json | undefined;
        snaps.push({
            file: metaFile,
            createdAt,
            session,
            messagesCount:
                typeof bodyMeta?.messagesCount === "number" ? bodyMeta.messagesCount : -1,
            segments: buildSegments(body),
        });
    }
    snaps.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (opts.limit && snaps.length > opts.limit) {
        return snaps.slice(snaps.length - opts.limit);
    }
    return snaps;
}

/** The divergence index is the first wire-order segment where the previous and current requests differ, including additions and removals. */
function firstDivergence(prev: Segment[], cur: Segment[]): number {
    const n = Math.min(prev.length, cur.length);
    for (let i = 0; i < n; i += 1) {
        if (prev[i].hash !== cur[i].hash || prev[i].id !== cur[i].id) return i;
    }
    return prev.length === cur.length ? -1 : n;
}

/* */
function cachedPrefixBytes(segs: Segment[], divergeIdx: number): { bytes: number; at: string } {
    let bytes = 0;
    let lastBreakpointBytes = 0;
    let lastBreakpointId = "(none)";
    const limit = divergeIdx < 0 ? segs.length : divergeIdx;
    for (let i = 0; i < segs.length; i += 1) {
        if (i < limit && segs[i].breakpoint) {
            // The effective cached prefix contains bytes through the last breakpoint before divergence.
            lastBreakpointBytes = bytes + segs[i].bytes;
            lastBreakpointId = segs[i].id;
        }
        bytes += segs[i].bytes;
    }
    return { bytes: lastBreakpointBytes, at: lastBreakpointId };
}

function fmtTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mi = String(d.getUTCMinutes()).padStart(2, "0");
    const ss = String(d.getUTCSeconds()).padStart(2, "0");
    return `${mm}-${dd} ${hh}:${mi}:${ss} UTC`;
}

function lastBreakpointIndex(segs: Segment[]): number {
    let last = -1;
    for (let i = 0; i < segs.length; i += 1) if (segs[i].breakpoint) last = i;
    return last;
}

function main(): void {
    const opts = parseArgs(process.argv);
    if (!opts.sessionPrefix) {
        console.error(
            "usage: bun scripts/analyze-cache-busts.ts <sessionIdPrefix> [--dir <path>] [--since ISO] [--until ISO] [--limit N] [--show-diff] [--all-busts]",
        );
        process.exit(1);
    }
    const snaps = loadSnapshots(opts);
    if (snaps.length === 0) {
        console.error(`No dumps found for session prefix "${opts.sessionPrefix}" in ${opts.dir}`);
        process.exit(1);
    }
    console.log(`Session: ${snaps[0].session}`);
    console.log(`Dumps:   ${snaps.length}  (dir: ${opts.dir})`);
    console.log("");
    console.log("Dashboard times are local (UTC+2); table times are UTC.");
    console.log(
        "time(UTC)          | segs | verdict | first-divergence        | prevBytes → curBytes        | cachedPrefix@breakpoint",
    );
    console.log(
        "-------------------|------|---------|-------------------------|-----------------------------|------------------------",
    );

    // Default output omits STABLE and SAME rows so BUST rows remain visible.
    // STABLE means the divergence is a pure tail addition after the previous request's last breakpoint.
    let bustCount = 0;
    for (let k = 0; k < snaps.length; k += 1) {
        const cur = snaps[k];
        if (k === 0) {
            if (opts.allRows) {
                console.log(
                    `${fmtTime(cur.createdAt)} | ${String(cur.segments.length).padStart(4)} | BASE    | (first request)         |                             |`,
                );
            }
            continue;
        }
        const prev = snaps[k - 1];
        const idx = firstDivergence(prev.segments, cur.segments);
        if (idx === -1) {
            if (opts.allRows) {
                console.log(
                    `${fmtTime(cur.createdAt)} | ${String(cur.segments.length).padStart(4)} | SAME    | (identical to prev)     |                             |`,
                );
            }
            continue;
        }
        const seg = cur.segments[idx] ?? prev.segments[idx];
        const prevLastBreakpoint = lastBreakpointIndex(prev.segments);
        const verdict = idx > prevLastBreakpoint ? "STABLE" : "BUST";
        if (verdict === "BUST") bustCount += 1;
        if (verdict !== "BUST" && !opts.allRows) continue;
        const prevPrefix = cachedPrefixBytes(prev.segments, prev.segments.length);
        const cp = cachedPrefixBytes(cur.segments, idx);
        const byteDelta = `${prevPrefix.bytes.toLocaleString()}B → ${cp.bytes.toLocaleString()}B`;
        const segId = seg?.id ?? `seg[${idx}]`;
        console.log(
            `${fmtTime(cur.createdAt)} | ${String(cur.segments.length).padStart(4)} | ${verdict.padEnd(7)} | ${segId.padEnd(23)} | ${byteDelta.padEnd(27)} | ${cp.at} (${cp.bytes.toLocaleString()}B)`,
        );

        if ((opts.showDiff || opts.allBusts) && verdict === "BUST") {
            const allDiffs: number[] = [];
            const n = Math.max(prev.segments.length, cur.segments.length);
            for (let i = idx; i < n; i += 1) {
                if (prev.segments[i]?.hash !== cur.segments[i]?.hash || prev.segments[i]?.id !== cur.segments[i]?.id) {
                    allDiffs.push(i);
                    if (!opts.allBusts && allDiffs.length >= 1) break;
                }
            }
            for (const di of allDiffs) {
                console.log(
                    `          └─ diverge @${di}: prev=${prev.segments[di]?.id ?? "—"}/${prev.segments[di]?.hash ?? "—"}  cur=${cur.segments[di]?.id ?? "—"}/${cur.segments[di]?.hash ?? "—"}`,
                );
            }
        }
    }

    console.log("");
    if (bustCount === 0) {
        console.log(
            `No busts across ${snaps.length} request(s) — the cached prefix held (only tail growth).`,
        );
    } else {
        console.log(
            `${bustCount} bust(s) across ${snaps.length} request(s).${opts.allRows ? "" : " (STABLE/SAME rows hidden; pass --all-rows to show them.)"}`,
        );
    }
}

main();
