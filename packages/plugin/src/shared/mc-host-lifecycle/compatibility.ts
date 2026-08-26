/**
 * Authenticated compatibility evaluation against the generated release
 * contract: daemon version against the half-open supported range, the three
 * fixed module versions against their ranges, and the exact five-part epoch
 * set. Pure report-only functions — a mismatch is returned, never acted on,
 * so no code path here can stop or replace a live daemon.
 */

import type { CatalogEntry } from "../mc-host-client";
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

export function parseSemverTriple(value: string): SemverTriple | null {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
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
 * Evaluate the authenticated `daemon_ver` (shape `mc-host/X.Y.Z`) against the
 * contract's half-open supported daemon range. Publication metadata must
 * never be passed here — only the handshake-retained value.
 */
export function evaluateDaemonCompatibility(authenticatedDaemonVer: string): CompatibilityVerdict {
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
 * Evaluate the exact five-part Magic Context epoch set. Every contract epoch
 * must be present, numeric, and exactly equal; missing, non-numeric, stale,
 * and future values all name the failing epoch.
 */
export function evaluateEpochCompatibility(observed: ObservedEpochs): CompatibilityVerdict {
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
    authenticatedDaemonVer: string;
    catalog: CatalogEntry[];
    epochs: ObservedEpochs;
}): CompatibilityVerdict {
    const daemon = evaluateDaemonCompatibility(input.authenticatedDaemonVer);
    if (!daemon.ok) return daemon;
    const modules = evaluateModuleCompatibility(input.catalog);
    if (!modules.ok) return modules;
    return evaluateEpochCompatibility(input.epochs);
}
