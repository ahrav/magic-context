import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import magicContextPiExtension, { __test } from "./index";
import { MAGIC_CONTEXT_PI_SUBAGENT_ENV } from "./subagent-runner";
import { createCountingPi } from "./test-utils";

const originalEnv = {
	MAGIC_CONTEXT_PI_SUBAGENT: process.env.MAGIC_CONTEXT_PI_SUBAGENT,
	XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
	XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};

function restoreEnv() {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function isolateXdgEnv() {
	const root = mkdtempSync(join(tmpdir(), "magic-context-pi-latch-test-"));
	process.env.XDG_CONFIG_HOME = join(root, "config");
	process.env.XDG_DATA_HOME = join(root, "data");
}

afterEach(() => {
	restoreEnv();
	// The latch lives on globalThis (process-global by design), so clear it
	// between tests or one test's init would suppress the next.
	__test.clearPiMagicContextActive();
});

describe("Pi in-process re-init latch (#247)", () => {
	it("second init in the same process is a no-op (no duplicate registrations)", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		__test.clearPiMagicContextActive();

		const first = createCountingPi();
		await magicContextPiExtension(first.pi);

		// Sanity: the first init registered the full runtime.
		expect(first.events.length).toBeGreaterThan(0);
		expect(first.tools.length).toBeGreaterThan(0);
		expect(first.commands.length).toBeGreaterThan(0);
		expect(first.entryRenderers).toEqual(["ctx-status"]);

		// The latch is now set in this process.
		expect(__test.isPiMagicContextActiveInProcess()).toBe(true);

		// Second init in the SAME process (the in-process child case).
		// It must register nothing — same contract as a spawned subagent.
		const second = createCountingPi();
		await magicContextPiExtension(second.pi);

		expect(second.events).toEqual([]);
		expect(second.tools).toEqual([]);
		expect(second.flags).toEqual([]);
		expect(second.commands).toEqual([]);
		expect(second.entryRenderers).toEqual([]);
	}, 15_000);

	it("clearing the latch (dispose) allows a full re-init", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		__test.clearPiMagicContextActive();

		const first = createCountingPi();
		await magicContextPiExtension(first.pi);
		expect(first.tools.length).toBeGreaterThan(0);

		// Simulate the session_shutdown dispose path clearing the latch.
		__test.clearPiMagicContextActive();
		expect(__test.isPiMagicContextActiveInProcess()).toBe(false);

		// A subsequent init re-registers the full runtime.
		const second = createCountingPi();
		await magicContextPiExtension(second.pi);

		expect(second.events.length).toBeGreaterThan(0);
		expect(second.tools.length).toBeGreaterThan(0);
		expect(second.commands.length).toBeGreaterThan(0);
		expect(second.entryRenderers).toEqual(["ctx-status"]);
	}, 15_000);

	it("spawned-child env guard still no-ops even when the latch is clear", async () => {
		isolateXdgEnv();
		process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV] = "1";
		__test.clearPiMagicContextActive();

		const registrations = createCountingPi();
		await magicContextPiExtension(registrations.pi);

		expect(registrations.events).toEqual([]);
		expect(registrations.tools).toEqual([]);
		expect(registrations.flags).toEqual([]);
		expect(registrations.commands).toEqual([]);
		expect(registrations.entryRenderers).toEqual([]);
		// The env guard returns BEFORE setting the latch, so a later in-process
		// init in the same process would still initialize fully. This pins the
		// spawned-child contract: the env guard is a separate, earlier gate.
		expect(__test.isPiMagicContextActiveInProcess()).toBe(false);
	});

	it("mutation direction: removing the latch makes the double-init test fail", async () => {
		// This test documents the regression guard: if the latch check is
		// removed from the entry, a second init would re-register everything.
		// We simulate the "latch removed" state by clearing it between the two
		// inits and asserting the second init then registers the full runtime
		// — proving the latch is what suppresses it.
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		__test.clearPiMagicContextActive();

		const first = createCountingPi();
		await magicContextPiExtension(first.pi);
		expect(first.tools.length).toBeGreaterThan(0);

		// Simulate the latch being absent: clear it before the second init.
		__test.clearPiMagicContextActive();

		const second = createCountingPi();
		await magicContextPiExtension(second.pi);

		// Without the latch suppressing it, the second init re-registers.
		expect(second.events.length).toBeGreaterThan(0);
		expect(second.tools.length).toBeGreaterThan(0);
		expect(second.commands.length).toBeGreaterThan(0);
	}, 15_000);
});
