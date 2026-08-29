/**
 * Outcome of one config-file load. `isConfigLoadUntrusted` switches on
 * specific members, so every loader and the untrusted-config gate must share
 * this single declaration: an outcome added in one copy but not the other
 * would silently classify as trusted.
 */
export type LoadOutcome =
    | "ok"
    | "project-file-parse-error"
    | "project-file-io-error"
    | "legacy-config-unmigrated"
    | "schema-recovery"
    | "substitution-failure";
