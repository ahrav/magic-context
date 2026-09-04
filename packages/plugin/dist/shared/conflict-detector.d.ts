export interface ConflictResult {
    /** Whether any blocking conflict was found */
    hasConflict: boolean;
    /** Human-readable reasons for each conflict */
    reasons: string[];
    /** Which conflicts were found — used for targeted fixes */
    conflicts: {
        compactionAuto: boolean;
        compactionPrune: boolean;
        dcpPlugin: boolean;
        omoPreemptiveCompaction: boolean;
        omoContextWindowMonitor: boolean;
        omoAnthropicRecovery: boolean;
    };
    /**
     * Resolved native compaction state observed during detection, for honest
     * reporting in both MC modes. `auto`/`prune` reflect the OpenCode
     * `compaction` block as resolved by the detector (env override, project
     * then user, default-on). They are populated even when MC compaction is
     * OFF (in which case they are NOT flagged as conflicts).
     */
    nativeCompaction: {
        auto: boolean;
        prune: boolean;
    };
}
/**
 * Resolved native compaction state, as reported by the host's own config
 * resolution (ctx.client.config.get() — the same object `opencode debug
 * config` prints). `auto`/`prune` are booleans; the OpenCode schema annotates
 * `auto` with default `true` and `prune` with default `false`, so an absent
 * compaction block resolves to `{ auto: true, prune: false }`.
 */
export interface ResolvedCompaction {
    auto: boolean;
    prune: boolean;
}
/**
 * Options for {@link detectConflicts}.
 *
 * `compactionEnabled` is the boot-resolved Magic Context compaction mode
 * (the result of {@link isCompactionEnabled} on the resolved user-tier
 * config). It MUST be threaded through every production call site — plugin
 * boot, setup, doctor, conflict-fixer — so the MC-mode decision is never
 * re-derived at a call site. A call site that genuinely cannot supply it
 * (e.g. a low-level native-config reader with no MC config handle) MUST
 * omit it and accept the default `true` (mode-on) behavior, which preserves
 * today's conflict semantics; it must never silently skip the check.
 *
 * `resolvedCompaction` is the host's RESOLVED native compaction state
 * (fetched via {@link resolveCompactionForBoot}). When present, the
 * file-based {@link checkCompaction} is NOT called — the resolved values are
 * used directly. Absent means the file-based fallback is used. The
 * OPENCODE_DISABLE_AUTOCOMPACT env short-circuit is applied on top of
 * whichever arm produced the value.
 *
 * When `compactionEnabled` is `false` (compaction-off mode), OpenCode
 * `compaction.auto=true` / `compaction.prune=true` are NOT plugin-disabling
 * conflicts — native compaction is the user's chosen window manager. DCP
 * and the three OMO conflict classes keep their existing policy in BOTH
 * modes.
 */
export interface DetectConflictsOptions {
    compactionEnabled?: boolean;
    resolvedCompaction?: ResolvedCompaction;
}
/**
 * Detect all conflicts that would prevent magic-context from working correctly.
 * Checks: OpenCode compaction, DCP plugin, OMO conflicting hooks.
 *
 * `compactionEnabled` (default `true`) is the resolved MC compaction mode.
 * When `false` (compaction-off mode), native `compaction.auto`/`prune` are
 * reported in {@link ConflictResult.nativeCompaction} but are NOT flagged as
 * conflicts — native compaction is the intended window manager in that mode.
 *
 * `resolvedCompaction` (optional) is the host's RESOLVED native compaction
 * state from {@link resolveCompactionForBoot}. When present it is used
 * directly and the file-based {@link checkCompaction} is skipped; when absent
 * the file-based fallback runs unchanged.
 */
export declare function detectConflicts(directory: string, options?: DetectConflictsOptions): ConflictResult;
/**
 * Minimal shape of the OpenCode SDK client's `config.get()` response. The
 * SDK's generated `Config` type does not declare a `compaction` field (the
 * schema lives in OpenCode's core config, not the SDK surface), so we read it
 * defensively at runtime. `config.get()` returns a `RequestResult` whose
 * `data` is the resolved config object — the same object `opencode debug
 * config` prints. The `data` is typed as `unknown` here so the real SDK client
 * (whose `Config` has no `compaction` key) is structurally assignable.
 */
export interface OpencodeConfigClientLike {
    config: {
        get: () => Promise<{
            data?: unknown;
        }>;
    };
}
/**
 * Fetch the host's RESOLVED native compaction state from the OpenCode SDK
 * client (`ctx.client.config.get()`). This is the authority for the plugin's
 * conflict decision (issue #309): the file-based re-derivation cannot see
 * every layer OpenCode folds in (env-var config path, managed configs,
 * multi-file merge), so any user whose `auto=false` lives in a layer we don't
 * read would be wrongly flagged. We never re-derive what the host will tell
 * us.
 *
 * A response WITHOUT a compaction block is INCONCLUSIVE, not "host defaults
 * apply": a server whose `/config` shape drifted (OpenCode Desktop bundles
 * its own server version) or a fetch racing boot returns data with no
 * `compaction` key, and reading that absence as `auto=true` disables the
 * plugin — the one wrong direction, because a false disable leaves NOTHING
 * managing the window and every long session overflows (issue #309, second
 * arm). Only an explicit boolean from the host resolves this arm; anything
 * else returns `null` so the caller falls back to the file-based check,
 * which reads the layers the user actually wrote.
 *
 * Returns `null` when the fetch fails, times out (bounded to `timeoutMs` so
 * boot never hangs), or serves no explicit compaction block.
 */
export declare function resolveCompactionForBoot(client: OpencodeConfigClientLike, timeoutMs?: number): Promise<ResolvedCompaction | null>;
/**
 * Canonical npm package names that represent the conflicting plugin.
 * Matched against the npm-style segment of each plugin entry, so:
 *   - "@tarquinen/opencode-dcp"           ✓ direct match
 *   - "@tarquinen/opencode-dcp@latest"    ✓ version suffix stripped
 *   - "@tarquinen/opencode-dcp@^3.1.0"    ✓ semver suffix stripped
 *   - "file:///path/to/opencode-dcp-fork" ✗ unrelated path
 *
 * forks/renames that don't ship the conflicting transform/system hooks are
 * intentionally NOT matched.
 */
export declare const DCP_PACKAGE_NAMES: Set<string>;
/**
 * Match a plugin entry against a set of canonical npm package names.
 *
 * A plugin entry can be:
 *   - "pkg-name"
 *   - "pkg-name@version"
 *   - "@scope/pkg-name"
 *   - "@scope/pkg-name@version"
 *   - "file://..." or other URL/path forms (never matched here)
 *
 * For the canonical-name path we only match the exact package name (with
 * optional version suffix). file:// paths and forks with different
 * package names are intentionally NOT matched — even if a path string
 * happens to contain a substring like "oh-my-opencode" (e.g. forks like
 * "oh-my-opencode-slim" published under a different package name).
 */
export declare function matchesPackageName(entry: string, canonicalNames: Set<string>): boolean;
/** Extract the package-name string from a plugin entry.
 *  OpenCode supports two forms:
 *   - plain string:        "@scope/pkg@latest"
 *   - tuple [name, opts]:  ["@scope/pkg@latest", { ... }]
 *  Returns null for any other shape (numbers, objects, etc.). */
export declare function extractPluginName(entry: unknown): string | null;
/**
 * Canonical OMO npm package names. The plugin publishes under both names as
 * a versioned alias (latest 3.17.5 on npm at time of writing).
 *
 * Forks under a different package name (e.g. `oh-my-opencode-slim`,
 * `oh-my-opencode-cli`, etc.) are intentionally NOT matched here — they
 * don't ship the `preemptive-compaction`, `context-window-monitor`, or
 * `anthropic-context-window-limit-recovery` hooks that conflict with
 * Magic Context. See https://github.com/cortexkit/magic-context/issues/43.
 *
 * The legacy `@code-yeongyu/` scope is no longer used — both names are
 * unscoped on npm.
 */
export declare const OMO_PACKAGE_NAMES: Set<string>;
/**
 * Generate a short conflict summary for ignored message display.
 */
export declare function formatConflictShort(result: ConflictResult): string;
//# sourceMappingURL=conflict-detector.d.ts.map