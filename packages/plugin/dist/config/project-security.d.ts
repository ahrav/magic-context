/**
 * Strip unsafe fields from a raw PROJECT config IN PLACE, before it is merged
 * over the user config. Returns warnings describing what was ignored.
 *
 * Closes:
 *  - `auto_update` — a repo must not suppress plugin self-updates (which can
 *    carry security fixes).
 *  - `fail_closed_blocking` — a repo must not un-block (or force-block) the
 *    loud inoperability gate; only the user may restore silent degrade.
 *  - `allow_home_project` — only the user may opt a home-directory session
 *    into a durable project identity.
 *  - `output_reserve` / `models.window_overlay_path` — only the user may change
 *    process-wide window geometry inputs.
 *  - `language`: a repo must not inject prompt text through a user preference.
 *  - `sqlite` — `sqlite.cache_size_mb` / `mmap_size_mb` become PRAGMAs on the
 *    process-global shared DB handle (one connection across every project in the
 *    process). A cloned repo could set a huge value to exhaust host memory /
 *    address space — a resource-exhaustion vector with no legitimate per-repo
 *    use. Honor user-level config only.
 *  - `storage.enforce_private_permissions` — changing a shared store from
 *    owner-private to group-readable changes every session and memory's local
 *    confidentiality. Only the machine operator's user config may opt into an
 *    externally managed trusted-group deployment.
 *  - `embedding.endpoint` / `embedding.provider` — a repo must not choose
 *    where private memory/search/commit text is embedded. User-level config is
 *    the trust boundary for embedding destinations.
 *  - `transform_mode` is intentionally allowed at project tier so a repository
 *    can opt its own runtime into the experimental Rust pipeline. The resolver
 *    requires user-tier consent (a user-level `transform_mode` selection or
 *    trusted user-level `subc` configuration) before Rust — and the managed
 *    native-host lifecycle it may demand-start — can activate.
 *  - `historian.model` / `historian.fallback_models` — historian model spend is
 *    user-level only; a cloned repo cannot force extra compaction cost.
 *  - `mural.model` — mural cue-compressor model selection is user-level only;
 *    a cloned repo cannot choose a model that sends project memory to a provider.
 *  - `pi.subagent_extensions` — a cloned repo must not choose which extensions
 *    the user's Pi child processes load.
 *  - `prompt_surface.guidance_override_path` / `tool_descriptions` — a repository
 *    may select a reviewed preset, but must not inject arbitrary guidance or tool
 *    description text into the user's provider-visible prompt.
 *  - hidden-agent `prompt`/`permission`/`tools` — a repo must not reprogram or
 *    re-permission the historian/dreamer/sidekick.
 */
export declare function stripUnsafeProjectConfigFields(projectRaw: Record<string, unknown>): string[];
/**
 * Clamp project-tier compaction thresholds after merge so a cloned repository
 * may only DELAY compaction relative to the trusted user/default settings. A
 * repo may never lower thresholds in a way that forces earlier historian work
 * or cloned-repo cost escalation on the user's account.
 */
export declare function constrainProjectThresholdOverrides(args: {
    mergedRaw: Record<string, unknown>;
    projectRaw: Record<string, unknown>;
    trustedBaseConfig: {
        execute_threshold_percentage?: unknown;
        execute_threshold_tokens?: unknown;
    };
}): string[];
export declare function dropInheritedEmbeddingKeyOnRedirect(projectRaw: Record<string, unknown>, mergedRaw: Record<string, unknown>, userRaw?: Record<string, unknown>): string[];
//# sourceMappingURL=project-security.d.ts.map