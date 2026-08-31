import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 *
 *      disarmed.
 *
 * `maybeFireHistorian` disarms emergency recovery only in its no-fire branch.
 * `maybeFireHistorian` clears `needsEmergencyRecovery` only when recovery is armed, no historian is in flight, no runnable compartment window exists, and `usage.percentage < historianForceMaterializationPercentage`.
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
