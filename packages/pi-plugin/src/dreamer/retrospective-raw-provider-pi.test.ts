/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { PiRetrospectiveRawProvider } from "./retrospective-raw-provider-pi";

describe("PiRetrospectiveRawProvider", () => {
	it("lists sessions for the resolved project cwd", async () => {
		const provider = new PiRetrospectiveRawProvider({
			projectCwd: "/repo/project",
			listSessions: () => [
				{
					id: "s1",
					cwd: "/repo/project",
					path: "/sessions/s1.jsonl",
					modified: 30,
				},
				{
					id: "s0",
					cwd: "/repo/project",
					path: "/sessions/s0.jsonl",
					modified: 20,
				},
				{
					id: "s2",
					cwd: "/repo/other",
					path: "/sessions/s2.jsonl",
					modified: 40,
				},
			],
			loadEntriesFromFile: () => [],
		});

		expect(await provider.listProjectSessions("identity")).toEqual([
			{ sessionId: "s0", path: "/sessions/s0.jsonl", updatedAt: 20 },
			{ sessionId: "s1", path: "/sessions/s1.jsonl", updatedAt: 30 },
		]);
	});

	it("reads only typed user messages newer than sinceMs", async () => {
		const provider = new PiRetrospectiveRawProvider({
			projectCwd: "/repo/project",
			listSessions: () => [
				{
					id: "s1",
					cwd: "/repo/project",
					path: "/sessions/s1.jsonl",
					modified: 30,
				},
			],
			loadEntriesFromFile: () => [
				{
					type: "message",
					message: { role: "user", timestamp: 100, content: "old" },
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						timestamp: 200,
						content: "tool output",
					},
				},
				{
					type: "custom_message",
					message: { role: "user", timestamp: 250, content: "nudge" },
				},
				{
					type: "message",
					message: {
						role: "user",
						timestamp: 300,
						content: [
							{ type: "text", text: "new line" },
							{ type: "image", data: "ignored" },
							{ type: "text", text: "second line" },
						],
					},
				},
			],
		});

		await provider.listProjectSessions("identity");
		expect(await provider.readUserMessagesSince("s1", 150, 10)).toEqual({
			messages: [
				{
					sessionId: "s1",
					ordinal: 4,
					role: "user",
					text: "new line\nsecond line",
					ts: 300,
				},
			],
			truncated: false,
		});
	});

	it("readUserMessagesBefore returns the newest N typed user lines at/before the cutoff", async () => {
		const provider = new PiRetrospectiveRawProvider({
			projectCwd: "/repo/project",
			listSessions: () => [
				{
					id: "s1",
					cwd: "/repo/project",
					path: "/sessions/s1.jsonl",
					modified: 30,
				},
			],
			loadEntriesFromFile: () => [
				{
					type: "message",
					message: { role: "user", timestamp: 100, content: "first" },
				},
				{
					type: "message",
					message: { role: "user", timestamp: 200, content: "second" },
				},
				{
					type: "message",
					message: { role: "user", timestamp: 300, content: "third" },
				},
				{
					type: "message",
					message: { role: "user", timestamp: 400, content: "future" },
				},
			],
		});

		await provider.listProjectSessions("identity");
		const before = await provider.readUserMessagesBefore("s1", 300, 2);
		expect(before.map((m) => m.text)).toEqual(["second", "third"]);
		expect(before.every((m) => m.ts <= 300)).toBe(true);
	});
});
