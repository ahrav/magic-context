import { describe, expect, it } from "bun:test";
import { CTX_REDUCE_DESCRIPTION } from "./constants";

describe("ctx-reduce constants", () => {
    //#given
    describe("CTX_REDUCE_DESCRIPTION", () => {
        //#then
        it("frames reduction as deferred discard, not immediate delete", () => {
            // The contract must teach the deferred mechanic (so models don't treat
            // it like an irreversible `rm` and hoard the call) while keeping the
            // real caution (re-fetch is the only way back → mark only spent content).
            expect(CTX_REDUCE_DESCRIPTION).toContain("discardable");
            expect(CTX_REDUCE_DESCRIPTION).toContain("NOT an immediate delete");
            expect(CTX_REDUCE_DESCRIPTION).toContain("DONE with");
            // No scarcity/rm framing that makes models over-conservative.
            expect(CTX_REDUCE_DESCRIPTION).not.toContain("gone forever");
            expect(CTX_REDUCE_DESCRIPTION).not.toContain("Remove entirely");
        });
    });
});
