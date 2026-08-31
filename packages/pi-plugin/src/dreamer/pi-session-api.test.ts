/// <reference types="bun-types" />

import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
	clearCachedModule,
	loadDefaultPiSessionApi,
	type ModuleLoader,
} from "./pi-session-api";

/**
 * degrading retrospective/refresh-primers.
 */
describe("loadDefaultPiSessionApi", () => {
	beforeEach(() => {
		clearCachedModule();
	});

	it("resolves the session APIs from the installed pi-coding-agent", async () => {
		const api = await loadDefaultPiSessionApi();
		expect(typeof api.listSessions).toBe("function");
		expect(typeof api.loadEntriesFromFile).toBe("function");
	}, 30000);

	it("parses JSONL session entries through the resolved loader", async () => {
		const api = await loadDefaultPiSessionApi();
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");

		const dir = mkdtempSync(join(tmpdir(), "pi-session-api-test-"));
		const file = join(dir, "session.jsonl");
		const entry = {
			type: "message",
			id: "e1",
			message: {
				role: "user",
				timestamp: 123,
				content: [{ type: "text", text: "hello" }],
			},
		};
		writeFileSync(file, `${JSON.stringify(entry)}\n`);

		const entries = await api.loadEntriesFromFile(file);
		expect(Array.isArray(entries)).toBe(true);
		expect(entries.length).toBeGreaterThan(0);
	}, 30000);

	describe("resolution ladder mechanics", () => {
		it("ladder order: first loader succeeds -> second never called", async () => {
			const firstLoaderCalled = mock(() =>
				Promise.resolve({ SessionManager: { listAll: () => [] } }),
			);
			const secondLoaderCalled = mock(() =>
				Promise.resolve({ SessionManager: { listAll: () => [] } }),
			);

			const loaders: ModuleLoader[] = [
				{ name: "First", load: firstLoaderCalled },
				{ name: "Second", load: secondLoaderCalled },
			];

			const api = await loadDefaultPiSessionApi(loaders);
			expect(firstLoaderCalled).toHaveBeenCalledTimes(1);
			expect(secondLoaderCalled).not.toHaveBeenCalled();
			expect(typeof api.listSessions).toBe("function");
		});

		it("first loader throws ERR_MODULE_NOT_FOUND -> second loader's module used", async () => {
			const firstLoaderCalled = mock(() =>
				Promise.reject(new Error("Cannot find module")),
			);
			const secondLoaderCalled = mock(() =>
				Promise.resolve({ SessionManager: { listAll: () => [] } }),
			);

			const loaders: ModuleLoader[] = [
				{ name: "First", load: firstLoaderCalled },
				{ name: "Second", load: secondLoaderCalled },
			];

			const api = await loadDefaultPiSessionApi(loaders);
			expect(firstLoaderCalled).toHaveBeenCalledTimes(1);
			expect(secondLoaderCalled).toHaveBeenCalledTimes(1);
			expect(typeof api.listSessions).toBe("function");
		});

		it("all loaders fail -> single aggregated error naming both strategies (assert message mentions the symlink/layout hint)", async () => {
			const firstLoaderCalled = mock(() =>
				Promise.reject(new Error("Cannot find module")),
			);
			const secondLoaderCalled = mock(() =>
				Promise.reject(new Error("process.argv[1] is undefined")),
			);

			const loaders: ModuleLoader[] = [
				{ name: "First", load: firstLoaderCalled },
				{ name: "Second", load: secondLoaderCalled },
			];

			let error: Error | null = null;
			try {
				await loadDefaultPiSessionApi(loaders);
			} catch (e: unknown) {
				error = e as Error;
			}

			expect(error).not.toBeNull();
			expect(error?.message).toContain(
				"Failed to resolve @earendil-works/pi-coding-agent via all strategies",
			);
			expect(error?.message).toContain("- First: Cannot find module");
			expect(error?.message).toContain(
				"- Second: process.argv[1] is undefined",
			);
			expect(error?.message).toContain(
				"symlinked or nonstandard install layout",
			);
		});

		it("memoization: two calls -> loaders invoked once", async () => {
			const loaderCalled = mock(() =>
				Promise.resolve({ SessionManager: { listAll: () => [] } }),
			);

			const loaders: ModuleLoader[] = [
				{ name: "SpyLoader", load: loaderCalled },
			];

			await loadDefaultPiSessionApi(loaders);
			await loadDefaultPiSessionApi(loaders);

			expect(loaderCalled).toHaveBeenCalledTimes(1);
		});
	});
});
