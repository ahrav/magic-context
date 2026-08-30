import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard for the emergency-recovery disarm predicate.
 *
 * Regression: a session whose overflow armed `needs_emergency_recovery=1`, then was
 * rescued by `/ctx-recomp` (covering all but a tiny in-progress tail), looped
 * forever — every transform pass force-bumped pressure to 95% because the flag
 * never cleared. Two clearing paths exist:
 *   1. historian publish → onPublished → clearEmergencyRecovery (never fires:
 *      the trigger needs a RUNNABLE window, which a tiny tail isn't), and
 *   2. the early `isEmergency` disarm, which used the LOOSE
 *      `hasEligiblePiCompartmentHistory(db, sessionId)` (no snapshot) — that
 *      returns true for "any raw message past the boundary", so it never
 *      disarmed.
 *
 * FIX: disarm inside `maybeFireHistorian`'s no-fire (`!trigger.shouldFire`)
 * branch, where the AUTHORITATIVE runnable-window snapshot is in hand — clear
 * the flag when recovery is armed AND there is no runnable compartment window.
 * This guard pins that predicate so a future refactor can't silently revert to
 * the loose check.
 */
const SRC = readFileSync(join(import.meta.dir, "context-handler.ts"), "utf8");
const codeOnly = SRC.split("\n")
	.filter((line) => !line.trim().startsWith("//"))
	.join("\n");

describe("emergency-recovery disarm predicate", () => {
	test("the no-fire historian branch disarms using the RUNNABLE-window snapshot", () => {
		const noFire = codeOnly.indexOf(
			"shouldFire=false (no trigger condition met)",
		);
		expect(noFire).toBeGreaterThan(-1);
		// The disarm clears the flag right after the no-fire log, gated on the
		// authoritative runnable-window check (not the loose raw-beyond-boundary one).
		const disarm = codeOnly.indexOf(
			"clearEmergencyRecovery(db, sessionId)",
			noFire,
		);
		expect(disarm).toBeGreaterThan(noFire);
		const window = codeOnly.lastIndexOf(
			"hasRunnableCompartmentWindow(boundarySnapshot)",
			disarm,
		);
		expect(window).toBeGreaterThan(noFire);
		expect(window).toBeLessThan(disarm);
	});

	test("the disarm is gated on recovery being armed and no in-flight historian", () => {
		const noFire = codeOnly.indexOf(
			"shouldFire=false (no trigger condition met)",
		);
		const disarm = codeOnly.indexOf(
			"clearEmergencyRecovery(db, sessionId)",
			noFire,
		);
		const gateRegion = codeOnly.slice(noFire, disarm);
		expect(gateRegion).toContain("overflowState.needsEmergencyRecovery");
		expect(gateRegion).toContain("!inFlightHistorian.has(sessionId)");
	});

	test("disarm is gated on LOW real pressure (keep armed during a genuine overflow arc)", () => {
		// A non-runnable window at HIGH pressure is a real overflow whose tail is
		// one in-progress arc — keep the flag armed (OpenCode does too) so
		// drop-all-tools keeps shrinking until the arc closes. Only a STALE flag
		// (low real pressure, e.g. post-/ctx-recomp ~20%) disarms.
		const noFire = codeOnly.indexOf(
			"shouldFire=false (no trigger condition met)",
		);
		const disarm = codeOnly.indexOf(
			"clearEmergencyRecovery(db, sessionId)",
			noFire,
		);
		const gateRegion = codeOnly.slice(noFire, disarm);
		expect(gateRegion).toContain(
			"usage.percentage < historianForceMaterializationPercentage",
		);
	});
});
