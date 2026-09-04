import { type RetainedBootstrap, type TrustIndex, type TrustIndexEntry } from "./bootstrap";
export type PayloadTarget = "linux-x64-gnu" | "darwin-arm64" | "darwin-x64";
export type PayloadTrustIndexEntry = TrustIndexEntry;
export type PayloadTrustIndex = TrustIndex;
export interface PreparedManagedLaunchTarget {
    kind: "retained-fd";
    fd: number;
    retained: RetainedBootstrap;
    payloadManifestDigest: string;
    payloadDir?: string;
}
export interface PrepareManagedLaunchTargetOptions {
    dataRoot: string;
    declaringParentRoot: string;
    target: PayloadTarget;
    trustIndex: PayloadTrustIndex;
    allowPackageLookup: boolean;
    explicitExternalRoot?: string;
}
export type ResolveManagedPayloadDirOptions = Omit<PrepareManagedLaunchTargetOptions, "dataRoot" | "allowPackageLookup">;
/**
 * Byte-identical to `canonicalJson` in
 * `scripts/generate-mc-host-release-manifest.ts`: recursively key-sorted with
 * code-point ordering, 2-space indentation, arrays keeping their order. The
 * `payload_manifest_digest` in the parent trust index is produced by the build
 * over exactly these bytes (`scripts/build-mc-host-payload.ts`), so any
 * divergence here fails every qualified package closed. `owner.test.ts`
 * asserts agreement against the producer implementation.
 */
export declare function canonicalPayloadManifestJson(value: unknown): string;
/**
 * Resolve one current-release launcher. Retained bootstrap validation always
 * runs first. Observational callers pass `allowPackageLookup:false`, making a
 * missing retained object a side-effect-free `null`; mutating callers may then
 * resolve one certified physical package and stage independent bytes.
 */
export declare function prepareManagedLaunchTarget(options: PrepareManagedLaunchTargetOptions): PreparedManagedLaunchTarget | null;
export declare function resolveManagedPayloadDir(options: ResolveManagedPayloadDirOptions): string | null;
//# sourceMappingURL=owner.d.ts.map