import { describe, expect, it } from "bun:test";
import { CTX_REDUCE_DESCRIPTION } from "./constants";

describe("ctx-reduce constants", () => {
    //#given
    describe("CTX_REDUCE_DESCRIPTION", () => {
        //#then
        it("frames reduction as deferred discard, not immediate delete", () => {
            expect(CTX_REDUCE_DESCRIPTION).toContain("discardable");
            expect(CTX_REDUCE_DESCRIPTION).toContain("NOT an immediate delete");
            expect(CTX_REDUCE_DESCRIPTION).toContain("DONE with");
            expect(CTX_REDUCE_DESCRIPTION).not.toContain("gone forever");
            expect(CTX_REDUCE_DESCRIPTION).not.toContain("Remove entirely");
        });
    });
});
