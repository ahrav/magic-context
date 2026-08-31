import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 *
 *
 *
 * `event-handler.ts:262-276`.
 */

const INDEX_SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
const HANDLER_SRC = readFileSync(
	join(import.meta.dir, "context-handler.ts"),
	"utf8",
);

describe("clearContextHandlerSession internals", () => {
	const fn = HANDLER_SRC.match(
		/export function clearContextHandlerSession\([^{]*\{([\s\S]*?)\n\}/,
	);

	const body = fn?.[1] ?? "";

	test("deletes from historyRefreshSessions", () => {
		expect(body).toContain("historyRefreshSessions.delete(sessionId)");
	});

	test("deletes from pendingMaterializationSessions", () => {
		// longer exists.
		expect(body).toContain("pendingMaterializationSessions.delete(sessionId)");
	});

	test("deletes from systemPromptRefreshSessions", () => {
		expect(body).toContain("systemPromptRefreshSessions.delete(sessionId)");
	});
});

describe("session_before_switch handler wiring", () => {
	const handler = INDEX_SRC.match(
		/pi\.on\("session_before_switch"[\s\S]*?\}\);/,
	);

	const body = handler?.[0] ?? "";

	test("handler resolves the OUTGOING session id (not the new target)", () => {
		// Pi fires `session_before_switch` before switching, so `getSessionId()` returns the outgoing session ID.
		expect(body).toContain("getSessionId()");
	});

	test("handler calls clearContextHandlerSession", () => {
		expect(body).toContain("clearContextHandlerSession(");
	});

	test("handler calls clearPiSystemPromptSession", () => {
		expect(body).toContain("clearPiSystemPromptSession(");
	});
});

describe("session_shutdown handler also drains per-session maps", () => {
	const handler = INDEX_SRC.match(
		/pi\.on\("session_shutdown"[\s\S]*?\n\s*\}\);/,
	);

	const body = handler?.[0] ?? "";

	test("calls clearContextHandlerSession on shutdown", () => {
		expect(body).toContain("clearContextHandlerSession(");
	});
});
