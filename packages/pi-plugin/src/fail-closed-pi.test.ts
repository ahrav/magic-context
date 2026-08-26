/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
	FAIL_CLOSED_DOCTOR_COMMAND,
	isFailClosedBlockingError,
} from "@magic-context/core/features/magic-context/fail-closed-block";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";

import { registerPiFailClosedSurface } from "./fail-closed-pi";

type Handler = (...args: unknown[]) => unknown;

function createFakePi() {
	const handlers = new Map<string, Handler[]>();
	return {
		pi: {
			on(event: string, handler: Handler) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
		},
		handlers,
		async emit(event: string, ...args: unknown[]) {
			const list = handlers.get(event) ?? [];
			let last: unknown;
			for (const handler of list) {
				last = await handler(...args);
			}
			return last;
		},
	};
}

describe("registerPiFailClosedSurface", () => {
	it("cancels session_before_compact and throws fence error from context", async () => {
		const fake = createFakePi();
		registerPiFailClosedSurface(fake.pi as never, {
			reason: {
				kind: "schema_fence",
				persistedVersion: 65,
				supportedVersion: 64,
			},
			tryReopen: async () => null,
			onRecovered: async () => {},
		});

		const cancel = await fake.emit("session_before_compact", {}, {});
		expect(cancel).toEqual({ cancel: true });

		let thrown: unknown;
		try {
			await fake.emit("context", { messages: [] }, {});
		} catch (error) {
			thrown = error;
		}
		expect(isFailClosedBlockingError(thrown)).toBe(true);
		const message = thrown instanceof Error ? thrown.message : String(thrown);
		expect(message).toContain("v65");
		expect(message).toContain("v64");
		expect(message).toContain(FAIL_CLOSED_DOCTOR_COMMAND);
	});

	it("threads direct-format refusal guidance into the blocking error", async () => {
		const fake = createFakePi();
		registerPiFailClosedSurface(fake.pi as never, {
			reason: {
				kind: "format_refusal",
				family: "unsupported",
				reasons: ["legacy migration schema"],
			},
			tryReopen: async () => null,
			onRecovered: async () => {},
		});

		let thrown: unknown;
		try {
			await fake.emit("context", { messages: [] }, {});
		} catch (error) {
			thrown = error;
		}
		expect(isFailClosedBlockingError(thrown)).toBe(true);
		const message = thrown instanceof Error ? thrown.message : String(thrown);
		expect(message).toContain("No data was changed");
		expect(message).toContain(`${FAIL_CLOSED_DOCTOR_COMMAND} reset-db`);
	});

	it("re-probe heals and invokes onRecovered without restart", async () => {
		const fake = createFakePi();
		let opens = 0;
		let recovered = false;
		const fakeDb = { __test: true } as unknown as ContextDatabase;
		registerPiFailClosedSurface(fake.pi as never, {
			reason: { kind: "storage_failure", cause: "migration lock" },
			tryReopen: async () => {
				opens += 1;
				return opens >= 1 ? fakeDb : null;
			},
			onRecovered: async (db) => {
				expect(db).toBe(fakeDb);
				recovered = true;
			},
		});

		// First context pass re-probes (pass count 1) and heals.
		await expect(
			fake.emit("context", { messages: [] }, {}),
		).resolves.toBeUndefined();
		expect(recovered).toBe(true);
		expect(opens).toBe(1);

		// Later passes stay quiet once recovered.
		await expect(
			fake.emit("context", { messages: [] }, {}),
		).resolves.toBeUndefined();
		expect(opens).toBe(1);
	});
});
