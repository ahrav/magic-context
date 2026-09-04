/**
 * Release-notes startup announcement shared by OpenCode plugin and Pi plugin.
 *
 * Bump `ANNOUNCEMENT_VERSION` and populate `ANNOUNCEMENT_FEATURES` *only* when a
 * release ships user-facing news worth surfacing once at startup. Patch releases
 * with no user-visible changes should leave both untouched — that way a user who
 * already dismissed the dialog for the current `ANNOUNCEMENT_VERSION` won't see
 * it again on the next bugfix bump.
 *
 * The persisted state is a single line of text (`last_announced_version`) under
 * `getMagicContextStorageDir()`. OpenCode and Pi share the same file because
 * they share the same storage root — so dismissing in one harness suppresses
 * the dialog in the other for the same announcement.
 *
 * Leave both empty (`""` and `[]`) to skip the dialog entirely.
 */
/**
 * Bump only when there are user-visible changes worth a startup dialog.
 * Does NOT need to match the published package version.
 */
export declare const ANNOUNCEMENT_VERSION = "0.31.0";
/**
 * Short, user-facing bullet strings. Keep each line ~80 chars or shorter so the
 * TUI dialog renders cleanly without horizontal scroll on a typical terminal.
 */
export declare const ANNOUNCEMENT_FEATURES: ReadonlyArray<string>;
/**
 * Persistent footer rendered below the version-specific bullets in every
 * announcement. Stays in place across releases so users always see the Discord
 * invite without us needing to repeat it in `ANNOUNCEMENT_FEATURES` each time.
 *
 * Leave empty (`""`) to suppress the footer.
 */
export declare const ANNOUNCEMENT_FOOTER = "Join us on Discord: https://discord.gg/F2uWxjGnU";
/**
 * Read the most recently dismissed announcement version, or `""` if none can be
 * returned. Callers that need to distinguish first-run from read/corruption
 * failures should use the internal tri-state path in `shouldShowAnnouncement`.
 */
export declare function readLastAnnouncedVersion(): string;
/**
 * Persist `version` as the most recently dismissed announcement. Best-effort:
 * write failures are swallowed so dialog-confirm flows never throw on storage
 * errors. Worst case the user sees the same dialog once more on next startup.
 */
export declare function markAnnouncementSeen(version: string): void;
/**
 * True when the configured `ANNOUNCEMENT_VERSION` has not yet been dismissed
 * AND there is at least one feature to show. Used by both the TUI dialog path
 * and the Desktop ignored-message fallback.
 *
 * First-run / sandbox handling: when NO state file exists yet, we seed it to the
 * current `ANNOUNCEMENT_VERSION` and return false instead of announcing. This
 * covers two cases that previously spammed the dialog (issue #99):
 *   - Fresh installs: a brand-new user shouldn't be shown a changelog of release
 *     bullets they have no context for — they need onboarding, not patch notes.
 *   - Ephemeral/sandbox environments (Docker, CI, disposable dev containers)
 *     where the storage dir is wiped between launches: without the seed, the
 *     missing file made the announcement re-show on every single startup.
 * Real upgrades still announce exactly once: an existing user already has a
 * state file at the prior version, so the version mismatch shows the dialog and
 * dismissing it advances the file to the current version.
 *
 * The seed is a deliberate write side-effect on the "no file" branch — folding
 * it here (rather than a separate startup call) makes every caller path (plugin
 * startup, Pi startup, TUI rpc pull) consistent with no ordering dependency.
 */
export declare function shouldShowAnnouncement(): boolean;
//# sourceMappingURL=announcement.d.ts.map