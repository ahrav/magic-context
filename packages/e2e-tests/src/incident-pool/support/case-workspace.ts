/**
 * Case isolation primitives (U2, KTD3, R13).
 *
 * Every executable variant gets a fresh owner-only (0o700) workspace with a
 * relocated home/temp root, its own store namespace, and an allowlisted
 * environment built from scratch — credentials, proxies, and ambient paths
 * are absent by construction, not by blocklist. Diagnostic sinks are capped
 * owner-only files that live inside the workspace and die with it; they are
 * never parsed as verdicts or published.
 */

import {
    chmodSync,
    closeSync,
    mkdirSync,
    openSync,
    rmSync,
    writeSync,
} from "node:fs";
import { join, resolve } from "node:path";

export interface CaseWorkspace {
    /** Owner-only root; deleted (with every sink) at teardown. */
    root: string;
    home: string;
    tmp: string;
    /** Case-owned store root — durable state never touches the ambient store. */
    store: string;
    diagnosticsDir: string;
    /** Unique per-case store namespace (variant + run-nonce prefix). */
    storeNamespace: string;
}

export function createCaseWorkspace(
    parentDir: string,
    variantId: string,
    runNonce: string,
): CaseWorkspace {
    const suffix = `${variantId}-${runNonce.slice(0, 8)}`;
    const root = resolve(parentDir, `case-${suffix}`);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700); // mkdir mode is masked by umask; make 0o700 unconditional
    const sub = (name: string): string => {
        const path = join(root, name);
        mkdirSync(path, { mode: 0o700 });
        // Same umask correction as `root` above. These hold the relocated HOME,
        // TMPDIR, the case-owned store, and diagnostics, so they are exactly the
        // directories the isolation guarantee is about.
        chmodSync(path, 0o700);
        return path;
    };
    return {
        root,
        home: sub("home"),
        tmp: sub("tmp"),
        store: sub("store"),
        diagnosticsDir: sub("diagnostics"),
        storeNamespace: `incident-${suffix}`,
    };
}

export function destroyCaseWorkspace(workspace: CaseWorkspace): void {
    rmSync(workspace.root, { recursive: true, force: true });
}

/**
 * The ONLY parent variables a child may inherit. Everything else — AWS/API
 * credentials, tokens, proxy configuration, ambient HOME/TMPDIR/XDG paths —
 * is stripped because it is never copied.
 *
 * The toolchain entries carry no secrets and are required for a Rust case to
 * resolve its own toolchain: a rustup-backed `cargo` shim locates the installed
 * toolchain through `RUSTUP_HOME`, which the relocated `HOME` no longer implies,
 * and `MC_E2E_DIRECT_HOST_FIXTURE_BIN` names an already-built fixture so the
 * child does not build one at all.
 *
 * `CARGO_HOME` is deliberately NOT inherited: a real one holds
 * `credentials.toml` and credential-provider configuration, so copying it would
 * hand every case child the developer's registry tokens and contradict the
 * guarantee above. It is relocated into the workspace instead, which leaves the
 * variable valid for anything that reads it while resolving to an empty
 * directory the case owns.
 */
export const CASE_ENV_ALLOWLIST = [
    "PATH",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "TERM",
    "TZ",
    "USER",
    "LOGNAME",
    "SHELL",
    "RUSTUP_HOME",
    "MC_E2E_DIRECT_HOST_FIXTURE_BIN",
] as const;

/** Allowlisted env with home/temp/XDG roots relocated into the workspace. */
export function buildCaseEnv(
    workspace: CaseWorkspace,
    baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of CASE_ENV_ALLOWLIST) {
        const value = baseEnv[key];
        if (typeof value === "string") env[key] = value;
    }
    env.HOME = workspace.home;
    env.TMPDIR = workspace.tmp;
    env.TMP = workspace.tmp;
    env.TEMP = workspace.tmp;
    env.XDG_CONFIG_HOME = join(workspace.home, ".config");
    env.XDG_DATA_HOME = join(workspace.home, ".local", "share");
    env.XDG_STATE_HOME = join(workspace.home, ".local", "state");
    env.XDG_CACHE_HOME = join(workspace.home, ".cache");
    env.CARGO_HOME = join(workspace.home, ".cargo");
    return env;
}

/** Strict loopback test: exact IPv4 127.x.x.x, ::1, or the literal host
 *  `localhost`. Domains like `127.evil.com` or `foo.localhost` are rejected. */
export function isLoopbackUrl(raw: string): boolean {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return false;
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (hostname === "localhost" || hostname === "::1") return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/** Reject any configured provider endpoint that is not declared loopback
 *  (KTD3). Throws before a child is ever spawned. */
export function assertLoopbackProviderEndpoints(
    endpoints: Record<string, string>,
): void {
    for (const [name, url] of Object.entries(endpoints)) {
        if (!isLoopbackUrl(url)) {
            throw new Error(
                `provider endpoint ${name} is not a loopback URL; refusing to run the case`,
            );
        }
    }
}

/**
 * Capped owner-only diagnostic sink for child stdout/stderr. Bytes past the
 * cap are dropped (never buffered); the file is deleted with the workspace.
 */
export class DiagnosticSink {
    bytesWritten = 0;
    truncated = false;
    #fd: number;
    #capBytes: number;
    #closed = false;

    constructor(path: string, capBytes: number) {
        if (!Number.isInteger(capBytes) || capBytes <= 0) {
            throw new Error("diagnostic sink cap must be a positive integer");
        }
        this.#fd = openSync(path, "wx", 0o600);
        this.#capBytes = capBytes;
    }

    write(chunk: Uint8Array | string): void {
        if (this.#closed) return;
        const buffer =
            typeof chunk === "string"
                ? Buffer.from(chunk, "utf8")
                : Buffer.from(chunk);
        const remaining = this.#capBytes - this.bytesWritten;
        if (buffer.length > remaining) this.truncated = true;
        if (remaining <= 0) return;
        const slice = buffer.subarray(0, Math.min(buffer.length, remaining));
        writeSync(this.#fd, slice);
        this.bytesWritten += slice.length;
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        closeSync(this.#fd);
    }
}
