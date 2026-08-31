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
	// Clear the process-global latch between tests; otherwise one test's initialization suppresses the next.
	__test.clearPiMagicContextActive();
});

describe("Pi in-process re-init latch (#247)", () => {
	it("second init in the same process is a no-op (no duplicate registrations)", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		__test.clearPiMagicContextActive();

		const first = createCountingPi();
		await magicContextPiExtension(first.pi);

		expect(first.events.length).toBeGreaterThan(0);
		expect(first.tools.length).toBeGreaterThan(0);
		expect(first.commands.length).toBeGreaterThan(0);
		expect(first.entryRenderers).toEqual(["ctx-status"]);

		expect(__test.isPiMagicContextActiveInProcess()).toBe(true);

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

		__test.clearPiMagicContextActive();
		expect(__test.isPiMagicContextActiveInProcess()).toBe(false);

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
		// The environment guard returns before setting the latch, so a later in-process initialization still registers fully.
		expect(__test.isPiMagicContextActiveInProcess()).toBe(false);
	});

	it("mutation direction: removing the latch makes the double-init test fail", async () => {
		// Clearing the latch permits a second initialization to register again.
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		__test.clearPiMagicContextActive();

		const first = createCountingPi();
		await magicContextPiExtension(first.pi);
		expect(first.tools.length).toBeGreaterThan(0);

		__test.clearPiMagicContextActive();

		const second = createCountingPi();
		await magicContextPiExtension(second.pi);

		expect(second.events.length).toBeGreaterThan(0);
		expect(second.tools.length).toBeGreaterThan(0);
		expect(second.commands.length).toBeGreaterThan(0);
	}, 15_000);
});
