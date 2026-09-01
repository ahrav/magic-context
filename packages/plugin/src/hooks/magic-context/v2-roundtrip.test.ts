import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    appendCompartments,
    type CompartmentInput,
    getCompartments,
} from "../../features/magic-context/compartment-storage";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { parseCompartmentOutput } from "./compartment-parser";

/**
 * verification.
 */

let prevDataHome: string | undefined;
let tempHome: string;

beforeEach(() => {
    prevDataHome = process.env.XDG_DATA_HOME;
    tempHome = mkdtempSync(join(tmpdir(), "mc-v2-roundtrip-"));
    process.env.XDG_DATA_HOME = tempHome;
    closeDatabase();
});

afterEach(() => {
    closeDatabase();
    if (prevDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevDataHome;
    rmSync(tempHome, { recursive: true, force: true });
});

const V873_OUTPUT = `<output>
<compartments>
<compartment start="3" end="18" title="Wire SSE reconnect with jittered backoff" episode_type="feature" importance="72">
<p1>
Implemented SSE reconnect in src/stream/client.ts using jittered exponential backoff (base 500ms, cap 30s, full jitter). Reconnect attempts cap at 8 before surfacing a fatal error to the caller.

U: "make sure a flaky network doesn't hammer the server — add jitter"

Verified against a proxy that drops every 3rd connection; reconnect storms disappeared. Committed a1b2c3d.
</p1>
<p2>
SSE reconnect with jittered exponential backoff (base 500ms, cap 30s, 8 attempts) in src/stream/client.ts. Committed a1b2c3d.
</p2>
<p3>
SSE client reconnects with jittered backoff, capped at 8 attempts.
</p3>
<p4>
SSE reconnect; jittered backoff; src/stream/client.ts
</p4>
</compartment>
<compartment start="19" end="24" title="Rename env var STREAM_KEY to SSE_AUTH_TOKEN" episode_type="infra" importance="8">
<p1>
Renamed the STREAM_KEY environment variable to SSE_AUTH_TOKEN across config loader, docker-compose, and README. One-time settled rename; no behavior change.
</p1>
<p2>
Renamed STREAM_KEY env var to SSE_AUTH_TOKEN across config + docs.
</p2>
<p3>
STREAM_KEY renamed to SSE_AUTH_TOKEN.
</p3>
<p4/>
</compartment>
</compartments>
<facts>
<ARCHITECTURE>
* SSE client owns reconnection; callers never re-establish the stream manually.
</ARCHITECTURE>
<CONFIG_VALUES>
* SSE reconnect: base 500ms, cap 30s, max 8 attempts, full jitter.
</CONFIG_VALUES>
<NAMING>
* SSE auth env var is SSE_AUTH_TOKEN (was STREAM_KEY).
</NAMING>
</facts>
<events>
<causal_incident at_compartment="1">
<trigger>proxy dropped every 3rd connection during testing</trigger>
<implication>reconnect logic must assume mid-stream drops are routine, not exceptional</implication>
</causal_incident>
</events>
<meta>
<messages_processed>3-24</messages_processed>
<unprocessed_from>25</unprocessed_from>
</meta>
</output>`;

describe("v2 historian output round-trip (E1.7)", () => {
    it("parses the v8.7.3 envelope into tiered compartments + 5-cat facts + events", () => {
        const parsed = parseCompartmentOutput(V873_OUTPUT);

        expect(parsed.compartments).toHaveLength(2);
        expect(parsed.unprocessedFrom).toBe(25);

        const [c1, c2] = parsed.compartments;
        expect(c1.startMessage).toBe(3);
        expect(c1.endMessage).toBe(18);
        expect(c1.title).toBe("Wire SSE reconnect with jittered backoff");
        expect(c1.episodeType).toBe("feature");
        expect(c1.importance).toBe(72);
        expect(c1.p1).toContain('U: "make sure a flaky network');
        expect(c1.p2).toContain("jittered exponential backoff");
        expect(c1.p3).toContain("capped at 8 attempts");
        expect(c1.p4).toContain("src/stream/client.ts");
        expect(c1.content).toBe(c1.p1);

        expect(c2.importance).toBe(8);
        expect(c2.episodeType).toBe("infra");
        expect(c2.p1).toContain("Renamed the STREAM_KEY");
        // A self-closing <p4/> may parse as an empty string or be omitted.
        expect(c2.p4 === "" || c2.p4 === undefined).toBe(true);

        const cats = parsed.facts.map((f) => f.category).sort();
        expect(cats).toEqual(["ARCHITECTURE", "CONFIG_VALUES", "NAMING"]);

        expect(parsed.events).toHaveLength(1);
        expect(parsed.events[0].kind).toBe("causal_incident");
        expect(parsed.events[0].atCompartment).toBe(1);
    });

    it("survives store → load with all tier/importance/episode_type fields intact", () => {
        const parsed = parseCompartmentOutput(V873_OUTPUT);
        const db = openDatabase();

        const inputs: CompartmentInput[] = parsed.compartments.map((c, i) => ({
            sequence: i,
            startMessage: c.startMessage,
            endMessage: c.endMessage,
            startMessageId: `m-${c.startMessage}`,
            endMessageId: `m-${c.endMessage}`,
            title: c.title,
            content: c.content,
            p1: c.p1,
            p2: c.p2,
            p3: c.p3,
            p4: c.p4,
            importance: c.importance,
            episodeType: c.episodeType,
        }));
        appendCompartments(db, "ses-roundtrip", inputs);

        const loaded = getCompartments(db, "ses-roundtrip");
        expect(loaded).toHaveLength(2);

        const l1 = loaded[0];
        expect(l1.title).toBe("Wire SSE reconnect with jittered backoff");
        expect(l1.importance).toBe(72);
        expect(l1.episodeType).toBe("feature");
        expect(l1.p1).toContain('U: "make sure a flaky network');
        expect(l1.p2).toContain("jittered exponential backoff");
        expect(l1.p3).toContain("capped at 8 attempts");
        expect(l1.p4).toContain("src/stream/client.ts");
        expect(l1.legacy).toBeFalsy();

        const l2 = loaded[1];
        expect(l2.importance).toBe(8);
        expect(l2.episodeType).toBe("infra");
    });
});
