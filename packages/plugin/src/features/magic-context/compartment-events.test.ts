import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type CompartmentEventInput,
    getCompartmentEvents,
    insertCompartmentEvents,
} from "./compartment-events";
import { closeDatabase, openDatabase } from "./storage";

let prevDataHome: string | undefined;
let tempHome: string;

beforeEach(() => {
    prevDataHome = process.env.XDG_DATA_HOME;
    tempHome = mkdtempSync(join(tmpdir(), "mc-events-"));
    process.env.XDG_DATA_HOME = tempHome;
    // openDatabase() requires the cortexkit/magic-context parent dir to exist.
    mkdirSync(join(tempHome, "cortexkit", "magic-context"), { recursive: true });
    closeDatabase();
});

afterEach(() => {
    closeDatabase();
    if (prevDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevDataHome;
    rmSync(tempHome, { recursive: true, force: true });
});

describe("compartment events storage (E2)", () => {
    it("creates the compartment_events table via migration v23", () => {
        const db = openDatabase();
        const row = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='compartment_events'",
            )
            .get();
        expect(row).toBeTruthy();
    });

    it("resolves at_compartment (1-based) to the durable compartment id", () => {
        const db = openDatabase();
        const events: CompartmentEventInput[] = [
            {
                kind: "causal_incident",
                atCompartment: 2,
                fields: {
                    trigger: "proxy dropped connections",
                    implication: "assume mid-stream drops",
                },
            },
            {
                kind: "trajectory_correction",
                atCompartment: 1,
                fields: { from: "polling", to: "SSE" },
            },
        ];
        // The array lists emitted compartments' durable IDs in emission order.
        insertCompartmentEvents(db, "ses-ev", events, [101, 202]);

        const stored = getCompartmentEvents(db, "ses-ev");
        expect(stored).toHaveLength(2);

        const causal = stored.find((e) => e.kind === "causal_incident");
        expect(causal?.atCompartment).toBe(2);
        expect(causal?.compartmentId).toBe(202); // 1-based idx 2 → ids[1]
        expect(causal?.fields.trigger).toBe("proxy dropped connections");

        const traj = stored.find((e) => e.kind === "trajectory_correction");
        expect(traj?.compartmentId).toBe(101); // 1-based idx 1 → ids[0]
        expect(traj?.fields.to).toBe("SSE");
    });

    it("stores NULL compartment_id when at_compartment is out of range or absent", () => {
        const db = openDatabase();
        insertCompartmentEvents(
            db,
            "ses-ev2",
            [
                { kind: "causal_incident", atCompartment: 9, fields: {} }, // out of range
                { kind: "causal_incident", atCompartment: null, fields: {} }, // absent
            ],
            [101],
        );
        const stored = getCompartmentEvents(db, "ses-ev2");
        expect(stored).toHaveLength(2);
        expect(stored.every((e) => e.compartmentId === null)).toBe(true);
    });

    it("is a no-op for an empty events array", () => {
        const db = openDatabase();
        insertCompartmentEvents(db, "ses-ev3", [], [101]);
        expect(getCompartmentEvents(db, "ses-ev3")).toHaveLength(0);
    });
});
