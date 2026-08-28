import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    fidelityDrift,
    RUST_POLICY_SOURCE,
    SYNAPSE_SOURCE,
} from "./check-synapse-fidelity";

const source = readFileSync(join(process.cwd(), SYNAPSE_SOURCE), "utf8");
const rustSource = readFileSync(join(process.cwd(), RUST_POLICY_SOURCE), "utf8");

test("current plugin policy satisfies the Rust harness literals", () => {
    expect(fidelityDrift(source, rustSource)).toEqual([]);
});

test("each directional literal detects source drift", () => {
    const mutations = [
        [" = 1;", " = 2;"],
        [" = 1.6;", " = 1.7;"],
        [" = 10;", " = 11;"],
        [" = 64;", " = 63;"],
        [" : 3;", " : 4;"],
        ["Math.min(2_000, 100 * 2 ** Math.min(attempt, 4))", "100"],
    ] as const;
    for (const [from, to] of mutations) {
        expect(fidelityDrift(source.replace(from, to), rustSource).length).toBeGreaterThan(0);
    }
});

test("Rust mirror drift is detected independently", () => {
    expect(fidelityDrift(source, rustSource.replace(" = 1.6;", " = 1.7;"))).toContain(
        "pollMultiplier",
    );
});
