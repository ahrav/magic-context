import { describe, expect, it } from "bun:test";
import {
    CANONICAL_DREAMER_TASKS,
    migrateDreamerV2,
} from "@magic-context/core/config/migrate-dreamer-v2";
import { parse, stringify } from "comment-json";
import { migrateDreamerV2ForDoctor } from "./migrate-dreamer-v2-doctor";

/** Legacy and v2 dreamer shapes covering every migration branch: window
 *  schedule, tasks array (full/partial/empty), retired object tasks,
 *  user_memories/pin_key_files blocks, timeouts, disable, v2 touch-ups,
 *  and no-ops. The doctor's on-disk rewrite and the plugin's in-memory
 *  load migration must produce the same dreamer block for each, or the
 *  doctor persists a config the runtime disagrees with. */
const FIXTURES: Record<string, Record<string, unknown>> = {
    "no dreamer block": { enabled: true },
    "empty dreamer": { dreamer: {} },
    "window schedule only": { dreamer: { schedule: "02:00-06:00" } },
    "window schedule with minutes": { dreamer: { schedule: "23:45-06:00" } },
    "unparseable window": { dreamer: { schedule: "whenever" } },
    "legacy tasks array (deliberate selection)": {
        dreamer: { schedule: "03:00-05:00", tasks: ["verify", "maintain-docs"] },
    },
    "legacy tasks array without verify": {
        dreamer: { tasks: ["consolidate"] },
    },
    "empty legacy tasks array": { dreamer: { tasks: [] } },
    "legacy blocks and timeouts": {
        dreamer: {
            schedule: "02:00-06:00",
            tasks: ["verify", "improve"],
            task_timeout_minutes: 20,
            max_runtime_minutes: 120,
            user_memories: { enabled: true, promotion_threshold: 3 },
            pin_key_files: { enabled: true, token_budget: 1000 },
        },
    },
    "user memories disabled": {
        dreamer: { schedule: "02:00-06:00", user_memories: { enabled: false } },
    },
    "disabled dreamer with legacy keys": {
        dreamer: { disable: true, schedule: "02:00-06:00", tasks: ["verify"] },
    },
    "retired object tasks folded into verify and curate": {
        dreamer: {
            tasks: {
                "maintain-memory": { schedule: "0 1 * * *", broad_interval_days: 7 },
                consolidate: { schedule: "0 2 * * *" },
                "archive-stale": { schedule: "*/30 * * * *" },
                improve: { schedule: "0 3 * * 0" },
            },
        },
    },
    "object tasks with retired keys and explicit verify": {
        dreamer: {
            tasks: {
                verify: { schedule: "0 7 * * *", model: "claude" },
                "maintain-memory": { schedule: "0 1 * * *" },
            },
            task_timeout_minutes: 15,
        },
    },
    "v2 record missing verify-broad": {
        dreamer: { tasks: { verify: { schedule: "0 3 * * *" } } },
    },
    "v2 record with disabled verify missing verify-broad": {
        dreamer: { tasks: { verify: { schedule: "" } } },
    },
    "v2 record with stale broad_interval_days and key-files": {
        dreamer: {
            tasks: {
                verify: { schedule: "0 3 * * *", broad_interval_days: 14 },
                "verify-broad": { schedule: "0 4 * * 0" },
                "key-files": { schedule: "0 5 * * *" },
            },
        },
    },
    "complete v2 record (no-op)": {
        dreamer: {
            tasks: {
                verify: { schedule: "0 3 * * *" },
                "verify-broad": { schedule: "0 4 * * 0" },
            },
        },
    },
};

describe("doctor on-disk migration agrees with the shared in-memory migration", () => {
    for (const [name, fixture] of Object.entries(FIXTURES)) {
        it(name, () => {
            const doctorConfig = structuredClone(fixture);
            const doctorChanged = migrateDreamerV2ForDoctor(doctorConfig);

            const inMemory = migrateDreamerV2(structuredClone(fixture), []);

            expect(doctorConfig).toEqual(inMemory as Record<string, unknown>);
            // The doctor's boolean means "the file content would change".
            expect(doctorChanged).toBe(!Bun.deepEquals(inMemory, fixture));
        });
    }
});

describe("doctor output covers the canonical task list", () => {
    it("schedules every canonical task when migrating a legacy shape", () => {
        // The guarantee that motivated sharing one migration: a task added to
        // CANONICAL_DREAMER_TASKS appears in the doctor's persisted record
        // instead of being silently absent (which the runtime would read as
        // disabled for object-shaped configs).
        const cfg: Record<string, unknown> = {
            dreamer: { schedule: "02:00-06:00", tasks: { verify: { schedule: "0 3 * * *" } } },
        };
        expect(migrateDreamerV2ForDoctor(cfg)).toBe(true);
        const tasks = (cfg.dreamer as Record<string, unknown>).tasks as Record<string, unknown>;
        for (const task of CANONICAL_DREAMER_TASKS) {
            expect(tasks[task]).toBeDefined();
        }
    });
});

describe("comment preservation through the doctor migration", () => {
    it("keeps comments on the dreamer block, the tasks record, and task entries", () => {
        const cfg = parse(
            `{
    // dreamer runs overnight
    "dreamer": {
        "tasks": {
            // nightly: this repo is huge
            "verify": {
                // cron chosen to dodge backups
                "schedule": "0 3 * * *"
            }
        }
    }
}`,
        ) as Record<string, unknown>;

        expect(migrateDreamerV2ForDoctor(cfg)).toBe(true);

        const rendered = stringify(cfg, null, 2);
        expect(rendered).toContain("// dreamer runs overnight");
        expect(rendered).toContain("// nightly: this repo is huge");
        expect(rendered).toContain("// cron chosen to dodge backups");
        const tasks = (cfg.dreamer as Record<string, unknown>).tasks as Record<string, unknown>;
        expect(tasks["verify-broad"]).toEqual({ schedule: "0 4 * * 0" });
    });
});
