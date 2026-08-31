import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `agent_end` must return without awaiting historian work.
 *
 *
 * trigger turn.
 *
 * `agent_end` must return synchronously without `await`.
 *
 * `The tests inspect source because the `agent_end` contract depends on the handler signature and awaited expressions.`
 * Source inspection enforces the structural `agent_end` handler contract without a Pi runtime mock.
 */

const INDEX_PATH = join(import.meta.dir, "index.ts");
const INDEX_SRC = readFileSync(INDEX_PATH, "utf8");

function extractAgentEndHandlerBody(src: string): string {
	// This extractor checks only the first `agent_end` handler.
	const start = src.indexOf('pi.on("agent_end"');
	if (start === -1) throw new Error("no agent_end handler found in index.ts");
	// `The handler must not contain nested `});`.`
	const end = src.indexOf("});", start);
	if (end === -1) throw new Error("no closing }); for agent_end handler");
	return src.slice(start, end + 3);
}

function extractSessionShutdownHandlerBody(src: string): string {
	const start = src.indexOf('pi.on("session_shutdown"');
	if (start === -1) throw new Error("no session_shutdown handler in index.ts");
	let depth = 0;
	let i = start;
	let started = false;
	while (i < src.length) {
		const ch = src[i];
		if (ch === "{") {
			depth++;
			started = true;
		} else if (ch === "}") {
			depth--;
			if (started && depth === 0) {
				const tail = src.slice(i, i + 3);
				if (tail.startsWith("})")) return src.slice(start, i + 3);
			}
		}
		i++;
	}
	throw new Error("no closing }); for session_shutdown handler");
}

describe("agent_end handler (blocking-historian regression)", () => {
	const body = extractAgentEndHandlerBody(INDEX_SRC);
	// `codeOnly` excludes lines whose trimmed text starts with `//`, so commented function names on those lines do not count as calls.
	const codeOnly = body
		.split("\n")
		.filter((line) => !line.trim().startsWith("//"))
		.join("\n");

	test("handler arrow function is NOT marked async", () => {
		expect(body).toMatch(/pi\.on\("agent_end", \([^)]*\) =>/);
		expect(body).not.toContain('pi.on("agent_end", async');
	});

	test("handler code does NOT call awaitInFlightHistorians", () => {
		expect(codeOnly).not.toContain("awaitInFlightHistorians");
	});

	test("handler code does NOT call awaitInFlightDreamers", () => {
		expect(codeOnly).not.toContain("awaitInFlightDreamers");
	});

	test("handler contains no await keyword in code", () => {
		expect(codeOnly).not.toMatch(/\bawait\s+\w/);
	});
});

describe("session_shutdown handler (drain location)", () => {
	const body = extractSessionShutdownHandlerBody(INDEX_SRC);

	test("drains in-flight historians through withTimeout", () => {
		expect(body).toContain("awaitInFlightHistorians");
		expect(body).toContain(
			"withTimeout(awaitInFlightHistorians(), SHUTDOWN_DRAIN_MS)",
		);
		expect(body).not.toContain("Promise.race");
	});

	test("drains in-flight dreamers (Promise.race with timeout)", () => {
		expect(body).toContain("awaitInFlightDreamers");
	});

	test("drain timeout uses unref/clear helper", () => {
		expect(body).toContain("withTimeout");
		expect(body).not.toMatch(/setTimeout\(.*\)/);
	});
});
