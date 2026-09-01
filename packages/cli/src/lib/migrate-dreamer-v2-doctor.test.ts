import { describe, expect, it } from "bun:test";
import { migrateDreamerV2ForDoctor } from "./migrate-dreamer-v2-doctor";

function tasksOf(
    cfg: Record<string, unknown>,
): Record<string, { schedule?: string } & Record<string, unknown>> {
    return (cfg.dreamer as Record<string, unknown>).tasks as Record<
        string,
        { schedule?: string } & Record<string, unknown>
    >;
}

describe("migrateDreamerV2ForDoctor", () => {
    it("returns false (no-op) without a dreamer block", () => {
        const cfg: Record<string, unknown> = { enabled: true };
        expect(migrateDreamerV2ForDoctor(cfg)).toBe(false);
    });

    it("a v2 record missing verify-broad is touched up (adds it, coupled to verify)", () => {
        const cfg: Record<string, unknown> = {
            dreamer: { tasks: { verify: { schedule: "0 3 * * *" } } },
        };
        // Missing `verify-broad` inherits `verify`'s enabled state.
        expect(migrateDreamerV2ForDoctor(cfg)).toBe(true);
        expect(tasksOf(cfg)["verify-broad"].schedule).toBe("0 4 * * 0");
    });

    it("is a true no-op once verify-broad is present (no broad_interval_days)", () => {
        const cfg: Record<string, unknown> = {
            dreamer: {
                tasks: {
                    verify: { schedule: "0 3 * * *" },
                    "verify-broad": { schedule: "0 4 * * 0" },
                },
            },
        };
        expect(migrateDreamerV2ForDoctor(cfg)).toBe(false);
    });

    it("v2 record with verify DISABLED backfills verify-broad OFF + strips broad_interval_days", () => {
        const cfg: Record<string, unknown> = {
            dreamer: {
                tasks: { verify: { schedule: "", broad_interval_days: 9 } },
            },
        };
        expect(migrateDreamerV2ForDoctor(cfg)).toBe(true);
        const t = tasksOf(cfg);
        expect(t["verify-broad"].schedule).toBe("");
        expect(t.verify.broad_interval_days).toBeUndefined();
    });

    it("converts window + tasks array → per-task record (window→cron, omitted disabled)", () => {
        const cfg: Record<string, unknown> = {
            dreamer: { schedule: "02:00-06:00", tasks: ["consolidate"] },
        };
        expect(migrateDreamerV2ForDoctor(cfg)).toBe(true);
        const t = tasksOf(cfg);
        expect(t.curate.schedule).toBe("0 2 * * *");
        expect(t.verify.schedule).toBe("");
        expect(t["classify-memories"].schedule).toBe("0 6 * * *");
        expect(t.retrospective.schedule).toBe("0 5 * * *");
        expect(t["maintain-docs"].schedule).toBe(""); // omitted → disabled
    });

    it("preserves user_memories opt-out, drops retired keys (incl. pin_key_files)", () => {
        const cfg: Record<string, unknown> = {
            dreamer: {
                schedule: "03:00-06:00",
                model: "anthropic/x",
                max_runtime_minutes: 120,
                user_memories: { enabled: false },
                pin_key_files: { enabled: true, token_budget: 9000, min_reads: 5 },
            },
        };
        expect(migrateDreamerV2ForDoctor(cfg)).toBe(true);
        const d = cfg.dreamer as Record<string, unknown>;
        expect(d.model).toBe("anthropic/x"); // agent key preserved
        expect("schedule" in d).toBe(false);
        expect("max_runtime_minutes" in d).toBe(false);
        expect("user_memories" in d).toBe(false);
        expect("pin_key_files" in d).toBe(false);
        const t = tasksOf(cfg);
        expect(t["review-user-memories"].schedule).toBe(""); // opt-out preserved
        expect("key-files" in t).toBe(false);
    });

    it("mutates in place (preserves the original object reference for comment-json)", () => {
        const dreamer: Record<string, unknown> = { schedule: "02:00-06:00" };
        const cfg: Record<string, unknown> = { dreamer };
        migrateDreamerV2ForDoctor(cfg);
        // Retaining the object preserves comment-json comment symbols.
        expect(cfg.dreamer).toBe(dreamer);
        expect((dreamer.tasks as Record<string, unknown>).verify).toBeDefined();
        expect((dreamer.tasks as Record<string, unknown>).curate).toBeDefined();
    });

    it("folds object-shaped retired memory tasks into verify + curate", () => {
        const cfg: Record<string, unknown> = {
            dreamer: {
                tasks: {
                    verify: { schedule: "0 3 * * *" },
                    improve: { schedule: "0 * * * *" },
                },
            },
        };
        expect(migrateDreamerV2ForDoctor(cfg)).toBe(true);
        const t = tasksOf(cfg);
        expect(t.verify.schedule).toBe("0 3 * * *");
        expect(t.verify.broad_interval_days).toBeUndefined();
        expect(t["verify-broad"].schedule).toBe("0 4 * * 0");
        expect(t.curate.schedule).toBe("0 * * * *");
        expect(t["classify-memories"].schedule).toBe("0 6 * * *");
        expect(t.retrospective.schedule).toBe("0 5 * * *");
        expect(t.improve).toBeUndefined();
    });

    it("defaults classify-memories and retrospective on daily unless dreamer is disabled", () => {
        const cfg: Record<string, unknown> = {
            dreamer: { schedule: "02:00-06:00", tasks: [] },
        };
        expect(migrateDreamerV2ForDoctor(cfg)).toBe(true);
        expect(tasksOf(cfg)["classify-memories"].schedule).toBe("0 6 * * *");
        expect(tasksOf(cfg).retrospective.schedule).toBe("0 5 * * *");

        const disabled: Record<string, unknown> = {
            dreamer: { disable: true, schedule: "02:00-06:00" },
        };
        expect(migrateDreamerV2ForDoctor(disabled)).toBe(true);
        expect(tasksOf(disabled)["classify-memories"].schedule).toBe("");
        expect(tasksOf(disabled).retrospective.schedule).toBe("");
    });

    it("maps object-shaped maintain-memory to verify + curate", () => {
        const cfg: Record<string, unknown> = {
            dreamer: {
                tasks: {
                    "maintain-memory": {
                        schedule: "0 5 * * *",
                        model: "x/y",
                        broad_interval_days: 9,
                    },
                },
            },
        };
        expect(migrateDreamerV2ForDoctor(cfg)).toBe(true);
        const t = tasksOf(cfg);
        expect(t.verify.schedule).toBe("0 5 * * *");
        expect(t.verify.model).toBe("x/y");
        // The migration drops `broad_interval_days` because `verify-broad` is a separate task.
        expect(t.verify.broad_interval_days).toBeUndefined();
        expect(t["verify-broad"].schedule).toBe("0 4 * * 0");
        expect(t.curate.schedule).toBe("0 5 * * *");
        expect(t.curate.model).toBe("x/y");
        expect(t["maintain-memory"]).toBeUndefined();
    });
});
