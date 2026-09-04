/**
 * Lifecycle data-root resolution and filesystem admission (plan U3, KTD11).
 *
 * Root selection mirrors the Rust resolver in `crates/mc-host/src/instance.rs`
 * exactly: an absolute nonempty `XDG_DATA_HOME` wins, then an absolute
 * nonempty `HOME/.local/share`, and everything else is `no_data_dir`. Relative
 * or empty values are ignored rather than joined to cwd, and `os.homedir()` is
 * never consulted as competing authority.
 *
 * This module deliberately does NOT reuse `data-path.ts`'s `getDataDir()`:
 * that resolver serves application storage (with `os.homedir()` fallback and
 * test backstops that must keep their current behavior), while lifecycle
 * paths must agree byte-for-byte with the Rust daemon or two processes would
 * coordinate on different roots. The test-isolation guard is preserved by
 * honoring `MAGIC_CONTEXT_TEST_DATA_DIR` the same way `data-path.ts` does, and
 * by sharing its `NODE_ENV=test` backstop root so an unisolated test cannot
 * reach the user's live tree through either resolver.
 */
/** Canonical publication filename (version-2 `subc` literal, R45). */
export declare const CONNECTION_FILE_NAME = "subc-connection.json";
export type DataRootResolution = {
    ok: true;
    root: string;
} | {
    ok: false;
    reason: "no_data_dir";
};
/**
 * Resolve the lifecycle data root from the supplied environment. The
 * `MAGIC_CONTEXT_TEST_DATA_DIR` guard (set only by test preloads) wins over
 * the HOME fallback but not over an explicit absolute `XDG_DATA_HOME`,
 * matching `data-path.ts`'s isolation contract.
 *
 * That contract includes a third layer, and this resolver honors it too: the
 * preload only runs when `bun test`'s CWD has a bunfig wiring `[test] preload`,
 * so a run from a directory without it executes every test with no preload and
 * no `MAGIC_CONTEXT_TEST_DATA_DIR`. Falling through to the real `HOME` there
 * would let a lifecycle policy probe, start, stop, or stage inside the user's
 * live `~/.local/share` tree. Bun sets `NODE_ENV=test` for every `bun test`
 * regardless of CWD and production never sets it, so that window redirects to
 * the same throwaway root the storage resolver uses.
 */
export declare function resolveLifecycleDataRoot(env?: Record<string, string | undefined>): DataRootResolution;
export declare function coordinationDirPath(dataRoot: string): string;
export declare function managedSubtreePath(dataRoot: string): string;
export declare function runtimeDirPath(dataRoot: string): string;
export declare function connectionFilePath(dataRoot: string): string;
/**
 * The connection file a managed daemon publishes to.
 *
 * The lifecycle root is authoritative because `McHostLifecyclePolicy` launches
 * the daemon with `XDG_DATA_HOME` set to exactly this root, so the publication
 * lands here. Readers must not re-derive the path from `data-path.ts`'s
 * `getDataDir()`: that resolver accepts a relative `XDG_DATA_HOME`, prefers
 * bun's cached `os.homedir()` over `env.HOME`, and ignores
 * `MAGIC_CONTEXT_TEST_DATA_DIR`, so under any of those it names a different
 * file than the one the daemon just wrote.
 *
 * `fallbackRoot` covers only the `no_data_dir` case, where the policy cannot
 * start a daemon at all and the legacy derivation is the best remaining guess.
 */
export declare function defaultConnectionFilePath(fallbackRoot: string, env?: Record<string, string | undefined>): string;
/**
 * Sensitive roots for diagnostic path redaction: the admitted data root and
 * the HOME it may derive from. Renderers must replace these prefixes before
 * any path reaches human or JSON output (R35).
 */
export declare function sensitiveRootsFor(dataRoot: string, env?: Record<string, string | undefined>): string[];
/**
 * Replace a sensitive root with a stable placeholder, matching on path
 * boundaries rather than characters: a sibling that merely starts with the
 * root's text (`<root>-backup`) is a different directory and keeps its own
 * name, so only the root itself and paths beneath it are replaced.
 */
export declare function redactLifecyclePath(value: string, sensitiveRoots: string[]): string;
/**
 * A rejection carries the reason class it actually earned. Only a host whose
 * platform the release qualifies can have its filesystem judged, so a
 * platform this function cannot judge for is reported as `unsupported_platform`
 * rather than as a filesystem verdict: telling an operator to
 * `set_data_directory` on a platform where no data directory can ever be
 * admitted names a remedy that cannot work.
 */
export type FilesystemAdmission = {
    ok: true;
} | {
    ok: false;
    reason: "unsupported_filesystem";
    remediation: "set_data_directory";
    detail: string;
} | {
    ok: false;
    reason: "unsupported_platform";
    remediation: "use_supported_platform";
    detail: string;
};
export interface MountEntry {
    mountPoint: string;
    fsType: string;
    options: string[];
}
/** Parse `/proc/self/mounts` (Linux). Octal escapes in mount points are decoded. */
export declare function parseMounts(text: string): MountEntry[];
export interface AdmissionIo {
    platform: NodeJS.Platform;
    readMounts: () => string;
    /**
     * Canonicalizer applied to the data root before mount lookup, defaulting
     * to `realpathSync.native`. Substituting it keeps mount selection decidable
     * against a fabricated mount table that names paths this host does not have.
     */
    realpath?: (value: string) => string;
}
/**
 * Practical bounded admission of the selected data root: the root must be
 * absolute and, on Linux, sit on a local mount that is neither a known
 * remote/synthetic filesystem type nor mounted `noexec` (retained-object
 * execution). Linux classification runs against the canonicalized root, so
 * `..` segments and symlinked ancestors are judged on the mount the kernel
 * traverses rather than the one the literal string names. macOS admission is
 * release-qualified rather than runtime-probed and passes here. A platform the
 * release does not qualify is rejected as `unsupported_platform`; every other
 * rejection is `unsupported_filesystem`/`set_data_directory`. Nothing here
 * mutates anything.
 */
export declare function admitLifecycleFilesystem(dataRoot: string, io?: AdmissionIo): FilesystemAdmission;
//# sourceMappingURL=paths.d.ts.map