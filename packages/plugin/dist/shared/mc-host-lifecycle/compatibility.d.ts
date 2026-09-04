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
export type CompatibilityVerdict = {
    ok: true;
} | {
    ok: false;
    reason: Extract<DaemonReason, "incompatible_daemon" | "incompatible_module" | "incompatible_epochs">;
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
export declare function parseSemverTriple(value: string): SemverTriple | null;
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
export declare function evaluateDaemonCompatibility(peer: AuthenticatedPeer): CompatibilityVerdict;
/**
 * Evaluate the strictly parsed catalog's fixed module versions against each
 * contract range. A missing fixed module, a non-semver `module_version`, or
 * an out-of-range version is `incompatible_module` naming that module.
 */
export declare function evaluateModuleCompatibility(catalog: CatalogEntry[]): CompatibilityVerdict;
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
export declare function evaluateEpochCompatibility(observed: ObservedEpochs): CompatibilityVerdict;
/**
 * The composed demand/status/doctor gate order: daemon range, then modules,
 * then epochs. First failure wins and is reported without any stop, replace,
 * or restart side effect (R17).
 */
export declare function evaluateCompatibility(input: {
    authenticatedPeer: AuthenticatedPeer;
    catalog: CatalogEntry[];
    epochs: ObservedEpochs;
}): CompatibilityVerdict;
export {};
//# sourceMappingURL=compatibility.d.ts.map