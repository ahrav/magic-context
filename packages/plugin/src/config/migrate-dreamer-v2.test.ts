/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { migrateDreamerV2 } from "./migrate-dreamer-v2";

function migrate(raw: Record<string, unknown>): {
    out: Record<string, unknown>;
    warnings: string[];
} {
    const warnings: string[] = [];
    const out = migrateDreamerV2(raw, warnings);
    return { out, warnings };
}

function tasks(
    out: Record<string, unknown>,
): Record<string, { schedule?: string } & Record<string, unknown>> {
    return (out.dreamer as Record<string, unknown>).tasks as Record<
        string,
        { schedule?: string } & Record<string, unknown>
    >;
}

describe("migrateDreamerV2", () => {
    it("is a no-op when there is no dreamer block", () => {
        const { out } = migrate({ enabled: true });
        expect(out).toEqual({ enabled: true });
    });

    it("a v2 record MISSING verify-broad gets it backfilled (coupled to verify)", () => {
        // `verify-broad` must be added explicitly instead of inheriting Zod's default.
        const v2 = { dreamer: { tasks: { verify: { schedule: "0 3 * * *" } } } };
        const { out, warnings } = migrate(structuredClone(v2));
        expect(tasks(out)["verify-broad"].schedule).toBe("0 4 * * 0");
        expect(warnings).toHaveLength(0);
    });

    it("is a no-op when dreamer has only non-legacy keys (e.g. model)", () => {
        const { out, warnings } = migrate({ dreamer: { model: "x/y" } });
        expect(out).toEqual({ dreamer: { model: "x/y" } });
        expect(warnings).toHaveLength(0);
    });

    it("derives the base cron from the window START", () => {
        const { out } = migrate({ dreamer: { schedule: "02:00-06:00", tasks: ["consolidate"] } });
        expect(tasks(out).curate.schedule).toBe("0 2 * * *");
        expect(tasks(out).verify.schedule).toBe("");
    });

    it("listed tasks get the base cron; OMITTED canonical tasks are DISABLED", () => {
        const { out } = migrate({
            dreamer: { schedule: "03:30-06:00", tasks: ["consolidate", "verify"] },
        });
        const t = tasks(out);
        expect(t.verify.schedule).toBe("30 3 * * *");
        expect(t.curate.schedule).toBe("30 3 * * *");
        expect(t["classify-memories"].schedule).toBe("0 6 * * *");
        expect(t["maintain-docs"].schedule).toBe(""); // omitted → disabled
    });

    it("when tasks array is ABSENT, preserves the v1 default suite (maintain-docs off)", () => {
        const { out } = migrate({ dreamer: { schedule: "02:00-06:00" } });
        const t = tasks(out);
        expect(t.verify.schedule).toBe("0 2 * * *");
        expect(t["verify-broad"].schedule).toBe("0 4 * * 0");
        expect(t.verify.broad_interval_days).toBeUndefined();
        expect(t.curate.schedule).toBe("0 2 * * *");
        expect(t["classify-memories"].schedule).toBe("0 6 * * *");
        expect(t["maintain-docs"].schedule).toBe(""); // not in v1 default list
    });

    it("user_memories.enabled false → review-user-memories disabled (opt-out preserved)", () => {
        const { out } = migrate({
            dreamer: { schedule: "02:00-06:00", user_memories: { enabled: false } },
        });
        expect(tasks(out)["review-user-memories"].schedule).toBe("");
    });

    it("user_memories default (no block) → review-user-memories enabled", () => {
        const { out } = migrate({ dreamer: { schedule: "02:00-06:00" } });
        const rum = tasks(out)["review-user-memories"];
        expect(rum.schedule).toBe("0 2 * * *");
    });

    it("carries user_memories.promotion_threshold", () => {
        const { out } = migrate({
            dreamer: {
                schedule: "02:00-06:00",
                user_memories: { enabled: true, promotion_threshold: 7 },
            },
        });
        expect(tasks(out)["review-user-memories"].promotion_threshold).toBe(7);
    });

    it("legacy pin_key_files block is dropped — no key-files task is emitted", () => {
        const { out } = migrate({
            dreamer: {
                schedule: "02:00-06:00",
                pin_key_files: { enabled: true, token_budget: 8000, min_reads: 6 },
            },
        });
        expect("key-files" in tasks(out)).toBe(false);
        expect("pin_key_files" in (out.dreamer as Record<string, unknown>)).toBe(false);
    });

    it("evaluate-smart-notes always gets the base cron", () => {
        const { out } = migrate({ dreamer: { schedule: "02:00-06:00", tasks: [] } });
        expect(tasks(out)["evaluate-smart-notes"].schedule).toBe("0 2 * * *");
    });

    it("new classify-memories and retrospective tasks default on daily unless dreamer is disabled", () => {
        const { out } = migrate({ dreamer: { schedule: "02:00-06:00", tasks: [] } });
        expect(tasks(out)["classify-memories"].schedule).toBe("0 6 * * *");
        expect(tasks(out).retrospective.schedule).toBe("0 5 * * *");

        const disabled = migrate({ dreamer: { disable: true, schedule: "02:00-06:00" } });
        expect(tasks(disabled.out)["classify-memories"].schedule).toBe("");
        expect(tasks(disabled.out).retrospective.schedule).toBe("");
    });

    it("task_timeout_minutes becomes each task's timeout_minutes", () => {
        const { out } = migrate({
            dreamer: { schedule: "02:00-06:00", task_timeout_minutes: 15 },
        });
        const t = tasks(out);
        expect(t.verify.timeout_minutes).toBe(15);
        expect(t.curate.timeout_minutes).toBe(15);
        expect(t["review-user-memories"].timeout_minutes).toBe(15);
    });

    it("drops retired keys and preserves agent-config keys (model, disable)", () => {
        const { out } = migrate({
            dreamer: {
                schedule: "02:00-06:00",
                max_runtime_minutes: 120,
                model: "anthropic/x",
                disable: false,
            },
        });
        const d = out.dreamer as Record<string, unknown>;
        expect(d.model).toBe("anthropic/x");
        expect(d.disable).toBe(false);
        expect("schedule" in d).toBe(false);
        expect("max_runtime_minutes" in d).toBe(false);
        expect("user_memories" in d).toBe(false);
        expect("pin_key_files" in d).toBe(false);
    });

    it("falls back to the default base cron on an unparseable window", () => {
        const { out } = migrate({ dreamer: { schedule: "garbage", tasks: ["consolidate"] } });
        expect(tasks(out).curate.schedule).toBe("0 2 * * *");
    });

    it("emits a migration warning", () => {
        const { warnings } = migrate({ dreamer: { schedule: "02:00-06:00" } });
        expect(warnings.join("\n")).toContain("dreamer.tasks");
    });

    it("all canonical tasks are present after migration (no key-files)", () => {
        const { out } = migrate({ dreamer: { schedule: "02:00-06:00" } });
        expect(Object.keys(tasks(out)).sort()).toEqual(
            [
                "map-memories",
                "classify-memories",
                "curate",
                "evaluate-smart-notes",
                "maintain-docs",
                "retrospective",
                "review-user-memories",
                "verify",
                "verify-broad",
            ].sort(),
        );
    });

    it("strips a stale key-files task from an existing v2 tasks-object", () => {
        const { out } = migrate({
            dreamer: {
                tasks: {
                    verify: { schedule: "0 3 * * *" },
                    "verify-broad": { schedule: "0 4 * * 0" },
                    "key-files": { schedule: "0 2 * * *" },
                },
            },
        });
        expect("key-files" in tasks(out)).toBe(false);
        expect(tasks(out).verify.schedule).toBe("0 3 * * *");
    });

    it("folds object-shaped retired memory tasks into verify + curate", () => {
        const { out } = migrate({
            dreamer: {
                tasks: {
                    verify: { schedule: "0 3 * * *" },
                    improve: { schedule: "0 * * * *" },
                    "maintain-docs": { schedule: "0 4 * * *" },
                },
            },
        });
        const t = tasks(out);
        expect(t.verify.schedule).toBe("0 3 * * *");
        expect(t["verify-broad"].schedule).toBe("0 4 * * 0");
        expect(t.verify.broad_interval_days).toBeUndefined();
        expect(t.curate.schedule).toBe("0 * * * *");
        expect(t["classify-memories"].schedule).toBe("0 6 * * *");
        expect(t.retrospective.schedule).toBe("0 5 * * *");
        expect(t["maintain-docs"].schedule).toBe("0 4 * * *");
        expect(t.improve).toBeUndefined();
    });

    it("v2-object with verify DISABLED backfills verify-broad OFF (not Zod's default-on)", () => {
        const { out } = migrate({
            dreamer: {
                tasks: {
                    verify: { schedule: "" },
                    curate: { schedule: "0 4 * * 0" },
                },
            },
        });
        const t = tasks(out);
        expect(t.verify.schedule).toBe("");
        // `verify-broad` is disabled when `verify` is disabled to prevent Zod from applying `0 4 * * 0`.
        expect(t["verify-broad"].schedule).toBe("");
    });

    it("v2-object with verify ENABLED backfills verify-broad ON weekly", () => {
        const { out } = migrate({
            dreamer: { tasks: { verify: { schedule: "0 3 * * *" } } },
        });
        expect(tasks(out)["verify-broad"].schedule).toBe("0 4 * * 0");
    });

    it("v2-object strips a stale broad_interval_days from verify", () => {
        const { out } = migrate({
            dreamer: {
                tasks: { verify: { schedule: "0 3 * * *", broad_interval_days: 9 } },
            },
        });
        const t = tasks(out);
        expect(t.verify.broad_interval_days).toBeUndefined();
        expect(t["verify-broad"].schedule).toBe("0 4 * * 0");
    });

    it("v2-object already reconciled is a stable no-op (idempotent)", () => {
        const input = {
            dreamer: {
                tasks: {
                    verify: { schedule: "0 3 * * *" },
                    "verify-broad": { schedule: "0 4 * * 0" },
                },
            },
        };
        const { out } = migrate(input);
        expect(out).toBe(input);
    });

    it("maps object-shaped maintain-memory to verify + curate, broad_interval_days dropped", () => {
        const { out } = migrate({
            dreamer: {
                tasks: {
                    "maintain-memory": {
                        schedule: "0 5 * * *",
                        model: "x/y",
                        broad_interval_days: 9,
                    },
                },
            },
        });
        const t = tasks(out);
        expect(t.verify.schedule).toBe("0 5 * * *");
        expect(t.verify.model).toBe("x/y");
        // The legacy `broad_interval_days` knob is dropped because `verify-broad` is its own task.
        expect(t.verify.broad_interval_days).toBeUndefined();
        expect(t["verify-broad"].schedule).toBe("0 4 * * 0");
        expect(t.curate.schedule).toBe("0 5 * * *");
        expect(t.curate.model).toBe("x/y");
        expect(t["maintain-memory"]).toBeUndefined();
    });
});
