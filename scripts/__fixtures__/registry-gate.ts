/**
 *
 * `release/mc-host-registry-gate.json` intentionally fails `validateRegistryGate`.
 * Generation requires a passing gate.
 * Generation tests stage a complete synthetic gate instead of editing the committed audit.
 *
 * `reservation_version` must be a prerelease because a bare `MAJOR.MINOR.PATCH` is selectable by ordinary dependent ranges.
 */
export function completeRegistryGate(gate: any): any {
    for (const pkg of gate.packages) {
        pkg.ownership_verified = true;
        pkg.trusted_publisher_configured = true;
        pkg.synchronized_version_unpublished = true;
        if (pkg.kind === "payload") {
            pkg.reservation_version = "0.0.1-reserved.0";
            pkg.bootstrap_credential_revoked = true;
        }
    }
    return gate;
}
