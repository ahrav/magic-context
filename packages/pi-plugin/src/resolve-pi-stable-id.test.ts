import { describe, expect, it } from "bun:test";
import { resolvePiStableId } from "./read-session-pi";

describe("resolvePiStableId — precedence", () => {
	const msg = { role: "assistant", timestamp: 1700 };

	it("prefers entryIdByRef (reference identity) over everything", () => {
		const ref = new Map<object, string>([[msg, "entry-real"]]);
		expect(resolvePiStableId(msg, 3, ["positional-id"], ref)).toBe(
			"entry-real",
		);
	});

	it("falls back to positional entryIds when ref misses", () => {
		// A cloned message object misses entryIdByRef; positional entryIds must provide its ID.
		const ref = new Map<object, string>([[{ other: true }, "entry-other"]]);
		expect(resolvePiStableId(msg, 2, ["a", "b", "entry-pos"], ref)).toBe(
			"entry-pos",
		);
	});

	it("falls back to the pi-msg index id when no real id resolves", () => {
		expect(resolvePiStableId(msg, 5)).toBe("pi-msg-5-1700-assistant");
	});

	it("omits the timestamp segment when the message has none", () => {
		expect(resolvePiStableId({ role: "user" }, 4)).toBe("pi-msg-4-user");
	});

	it("uses role=unknown when role is absent", () => {
		expect(resolvePiStableId({ timestamp: 9 }, 1)).toBe("pi-msg-1-9-unknown");
	});

	it("returns undefined for non-object messages", () => {
		expect(resolvePiStableId(null, 0)).toBeUndefined();
		expect(resolvePiStableId("nope", 0)).toBeUndefined();
		expect(resolvePiStableId(undefined, 0)).toBeUndefined();
	});

	it("skips empty/whitespace positional and ref ids, falling through to index", () => {
		const ref = new Map<object, string>([[msg, ""]]);
		expect(resolvePiStableId(msg, 7, [""], ref)).toBe(
			"pi-msg-7-1700-assistant",
		);
	});
});

describe("resolvePiStableId — index-shift stability (the core invariant)", () => {
	// A prefix trim can move a message to a different index.
	// A resolved entry ID prevents an index shift from changing the stable ID.
	it("keeps a stable id for the same message across an index shift when a real entry id resolves", () => {
		const m = { role: "assistant", timestamp: 42 };

		const entryIdsPass1 = Array(6).fill(undefined);
		entryIdsPass1[5] = "entry-ABC";
		const idPass1 = resolvePiStableId(m, 5, entryIdsPass1);

		const entryIdsPass2 = Array(3).fill(undefined);
		entryIdsPass2[2] = "entry-ABC";
		const idPass2 = resolvePiStableId(m, 2, entryIdsPass2);

		expect(idPass1).toBe("entry-ABC");
		expect(idPass2).toBe("entry-ABC");
		expect(idPass1).toBe(idPass2); // stable across the shift — no drift.
	});

	it("DOES drift for a synthetic/unresolved message (acceptable — no real id exists)", () => {
		// Messages without real entry IDs use index-based fallback IDs.
		const m = { role: "user", timestamp: 7 };
		expect(resolvePiStableId(m, 5)).not.toBe(resolvePiStableId(m, 2));
	});
});

describe("resolvePiStableId — consistency invariant (F1)", () => {
	// Transcript and reasoning must use matching positional entryIds so cloned messages receive the original ID.
	// A cloned message misses entryIdByRef and must resolve through positional entryIds.
	// Positional entryIds must resolve the cloned message to the original message's ID.
	it("transcript path and reasoning path agree even when the object was cloned (ref miss)", () => {
		const original = { role: "assistant", timestamp: 100 };
		const cloned = { ...original }; // what tagging does to working[idx]
		const entryIds: (string | undefined)[] = [];
		entryIds[4] = "entry-XYZ";
		// entryIdByRef maps original message objects, not clones.
		const ref = new Map<object, string>([[original, "entry-XYZ"]]);

		const transcriptId = resolvePiStableId(original, 4, entryIds, ref);
		const reasoningId = resolvePiStableId(cloned, 4, entryIds, ref);

		expect(transcriptId).toBe("entry-XYZ");
		expect(reasoningId).toBe("entry-XYZ");
		expect(transcriptId).toBe(reasoningId);
	});
});
