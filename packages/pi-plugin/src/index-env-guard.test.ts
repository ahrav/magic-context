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
	const root = mkdtempSync(join(tmpdir(), "magic-context-pi-index-test-"));
	process.env.XDG_CONFIG_HOME = join(root, "config");
	process.env.XDG_DATA_HOME = join(root, "data");
}

afterEach(() => {
	restoreEnv();
	// Clear the process-global init latch so one test's full init does not
	// leak into the next (the latch lives on globalThis, not module state).
	__test.clearPiMagicContextActive();
});

describe("Pi full extension subagent env guard", () => {
	it("no-ops before registering anything inside Magic Context Pi subagents", async () => {
		isolateXdgEnv();
		process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV] = "1";
		const registrations = createCountingPi();

		await magicContextPiExtension(registrations.pi);

		expect(registrations.events).toEqual([]);
		expect(registrations.tools).toEqual([]);
		expect(registrations.flags).toEqual([]);
		expect(registrations.commands).toEqual([]);
		expect(registrations.entryRenderers).toEqual([]);
	});

	it("registers the full runtime when the subagent guard is absent", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		const registrations = createCountingPi();

		await magicContextPiExtension(registrations.pi);

		expect(registrations.events.length).toBeGreaterThan(0);
		expect(registrations.tools.length).toBeGreaterThan(0);
		expect(registrations.commands.length).toBeGreaterThan(0);
		expect(registrations.entryRenderers).toEqual(["ctx-status"]);
		expect(registrations.events).toContain("before_agent_start");
		expect(registrations.tools).toContain("ctx_search");
		expect(registrations.commands).toContain("ctx-status");
		// This path initializes and migrates a fresh SQLite database before registering
		// the complete extension. In a 2-CPU Bun 1.3.14 Linux container it took
		// 0.49-2.59s (0.38-0.74s for SQLite alone), while a loaded 2-core release runner
		// reached 7.67s. Keep enough headroom for that measured cold-start work.
	}, 15_000);
});
