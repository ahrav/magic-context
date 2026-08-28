import { describe, expect, test } from "bun:test";
import { mayDemandStart, resolveConnectionOrigin } from "./ownership";

describe("connection-origin provenance (U3 scenario 2)", () => {
    test("omitted configuration is managed-default and may demand-start", () => {
        const origin = resolveConnectionOrigin({});
        expect(origin).toBe("managed-default");
        expect(mayDemandStart(origin)).toBe(true);
    });

    test("an explicit connection file stays explicit even for the canonical text", () => {
        const canonical = "/home/user/.local/share/cortexkit/run/subc-connection.json";
        const origin = resolveConnectionOrigin({ connectionFile: canonical });
        expect(origin).toBe("explicit");
        expect(mayDemandStart(origin)).toBe(false);
    });

    test("injected clients and factories are lifecycle-neutral", () => {
        const origin = resolveConnectionOrigin({ injected: true });
        expect(origin).toBe("injected");
        expect(mayDemandStart(origin)).toBe(false);
    });

    test("injection wins over a simultaneously supplied path", () => {
        expect(resolveConnectionOrigin({ connectionFile: "/x", injected: true })).toBe("injected");
    });
});
