/**
 * Authenticated compatibility evaluation against the generated release
 * contract: daemon version against the half-open supported range, the three
 * fixed module versions against their ranges, and the exact five-part epoch
 * set. Pure report-only functions — a mismatch is returned, never acted on,
 * so no code path here can stop or replace a live daemon.
 */

import type { AuthenticatedPeer, CatalogEntry } from "../mc-host-client";
import type { DaemonReason } from "./contract";
import { releaseContract } from "./generated-contract";

export type CompatibilityVerdict =
    | { ok: true }
    | {
          ok: false;
          reason: Extract<
              DaemonReason,
              "incompatible_daemon" | "incompatible_module" | "incompatible_epochs"
          >;
          /** Bounded machine detail naming the exact mismatch. */
          detail: string;
      };

type SemverTriple = [number, number, number];

/**
 * Parse a canonical `X.Y.Z` triple. Each component is either a single `0` or a
 * digit run with no leading zero, so a spelling like `00.1.0` is rejected
 * instead of being silently normalized into the triple `0.1.0` — the grammar
 * the mismatch details name is exactly the one accepted here.
 */
export function parseSemverTriple(value: string): SemverTriple | null {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
    if (!match) return null;
    const triple: SemverTriple = [
        Number.parseInt(match[1] as string, 10),
        Number.parseInt(match[2] as string, 10),
        Number.parseInt(match[3] as string, 10),
    ];
    if (triple.some((part) => !Number.isSafeInteger(part))) return null;
    return triple;
}

function compareTriples(a: SemverTriple, b: SemverTriple): number {
    for (let i = 0; i < 3; i++) {
        const delta = (a[i] as number) - (b[i] as number);
        if (delta !== 0) return delta;
    }
    return 0;
}

function inHalfOpenRange(
    version: SemverTriple,
    range: { min_inclusive: string; max_exclusive: string },
): boolean {
    const min = parseSemverTriple(range.min_inclusive);
    const max = parseSemverTriple(range.max_exclusive);
    if (!min || !max) return false;
    return compareTriples(version, min) >= 0 && compareTriples(version, max) < 0;
}

/**
 * Evaluate the handshake-authenticated `daemon_ver` (shape `mc-host/X.Y.Z`)
 * against the contract's half-open supported daemon range. The parameter is
 * the whole {@link AuthenticatedPeer} rather than its version string so the
 * compiler refuses untrusted connection-file publication metadata, whose
 * `daemonVer` is otherwise an identically typed string.
 *
 * The native binary gates the same value against the same contract range in
 * `daemon_version_compatible` (`crates/mc-module/src/bin/ck-mc-host.rs`). The
 * two implementations must accept exactly the same inputs; a divergence makes
 * a native `probe`/`doctor` result and this policy verdict contradict each
 * other for one daemon. Change both together, or neither.
 */
export function evaluateDaemonCompatibility(peer: AuthenticatedPeer): CompatibilityVerdict {
    const authenticatedDaemonVer = peer.daemonVer;
    const raw = authenticatedDaemonVer.startsWith("mc-host/")
        ? authenticatedDaemonVer.slice("mc-host/".length)
        : null;
    const triple = raw === null ? null : parseSemverTriple(raw);
    if (triple === null) {
        return {
            ok: false,
            reason: "incompatible_daemon",
            detail: "daemon version is not a canonical mc-host/X.Y.Z value",
        };
    }
    if (!inHalfOpenRange(triple, releaseContract.versions.supported_daemon_range)) {
        return {
            ok: false,
            reason: "incompatible_daemon",
            detail: "daemon version is outside the supported range",
        };
    }
    return { ok: true };
}

const FIXED_MODULES: ReadonlyArray<{
    catalogId: string;
    contractKey: keyof typeof releaseContract.versions.modules;
}> = [
    { catalogId: "magic-context", contractKey: "magic_context" },
    { catalogId: "synapse", contractKey: "synapse" },
    { catalogId: "broca", contractKey: "broca" },
];

/**
 * Evaluate the strictly parsed catalog's fixed module versions against each
 * contract range. A missing fixed module, a non-semver `module_version`, or
 * an out-of-range version is `incompatible_module` naming that module.
 */
export function evaluateModuleCompatibility(catalog: CatalogEntry[]): CompatibilityVerdict {
    const byId = new Map(catalog.map((entry) => [entry.module_id, entry]));
    for (const { catalogId, contractKey } of FIXED_MODULES) {
        const entry = byId.get(catalogId);
        if (!entry) {
            return {
                ok: false,
                reason: "incompatible_module",
                detail: `module ${catalogId} is absent from the catalog`,
            };
        }
        const triple = parseSemverTriple(entry.module_version);
        if (!triple) {
            return {
                ok: false,
                reason: "incompatible_module",
                detail: `module ${catalogId} version is not canonical semver`,
            };
        }
        if (!inHalfOpenRange(triple, releaseContract.versions.modules[contractKey].range)) {
            return {
                ok: false,
                reason: "incompatible_module",
                detail: `module ${catalogId} version is outside the supported range`,
            };
        }
    }
    return { ok: true };
}

export type EpochName = keyof typeof releaseContract.epochs;

export type ObservedEpochs = Partial<Record<EpochName, unknown>>;

/**
 * Evaluate the exact five-part Magic Context epoch set. The observed key set
 * must equal the contract's: `observed` arrives as decoded JSON, which carries
 * no type at runtime, so an extra key names an epoch this release cannot
 * interpret and is a mismatch rather than a value to ignore. Every contract
 * epoch must then be present, numeric, and exactly equal; missing,
 * non-numeric, stale, and future values all name the failing epoch.
 */
export function evaluateEpochCompatibility(observed: ObservedEpochs): CompatibilityVerdict {
    const expectedNames = new Set(Object.keys(releaseContract.epochs));
    const observedNames = Object.keys(observed);
    if (
        observedNames.length !== expectedNames.size ||
        observedNames.some((name) => !expectedNames.has(name))
    ) {
        return {
            ok: false,
            reason: "incompatible_epochs",
            detail: "epoch set does not match the release contract",
        };
    }
    for (const [name, expected] of Object.entries(releaseContract.epochs)) {
        const value = observed[name as EpochName];
        if (typeof value !== "number" || !Number.isSafeInteger(value)) {
            return {
                ok: false,
                reason: "incompatible_epochs",
                detail: `epoch ${name} is missing or nonnumeric`,
            };
        }
        if (value !== expected) {
            return {
                ok: false,
                reason: "incompatible_epochs",
                detail: `epoch ${name} does not match the release contract`,
            };
        }
    }
    return { ok: true };
}

/**
 * The composed demand/status/doctor gate order: daemon range, then modules,
 * then epochs. First failure wins and is reported without any stop, replace,
 * or restart side effect (R17).
 */
export function evaluateCompatibility(input: {
    authenticatedPeer: AuthenticatedPeer;
    catalog: CatalogEntry[];
    epochs: ObservedEpochs;
}): CompatibilityVerdict {
    const daemon = evaluateDaemonCompatibility(input.authenticatedPeer);
    if (!daemon.ok) return daemon;
    const modules = evaluateModuleCompatibility(input.catalog);
    if (!modules.ok) return modules;
    return evaluateEpochCompatibility(input.epochs);
}
