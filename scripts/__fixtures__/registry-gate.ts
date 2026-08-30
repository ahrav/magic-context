/**
 * Flip a parsed fail-closed registry gate into the fully satisfied shape.
 *
 * `release/mc-host-registry-gate.json` is committed fail-closed: it records a
 * live audit whose conditions release engineering has not met, so
 * `validateRegistryGate` rejects it by design. Generation demands a passing
 * gate, so any test exercising something downstream of generation stages a
 * synthetic complete gate rather than editing the committed audit.
 *
 * `reservation_version` must be an inert prerelease. A bare `MAJOR.MINOR.PATCH`
 * is selectable by an ordinary dependent range, so the gate rejects it — a
 * synthetic gate carrying one fails for its own setup's reason instead of
 * reaching the rule under test.
 */
// biome-ignore lint/suspicious/noExplicitAny: tests mutate deep copies of the gate
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
