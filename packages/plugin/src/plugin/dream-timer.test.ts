import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../features/magic-context/storage";
import { BOOT_QUIET_MS, setBootQuietPeriodForTests } from "./boot-quiet";
import { resetStartupJitterSlotsForTests, startDreamScheduleTimer } from "./dream-timer";

/**
 * Regression coverage for the schema-fence / null-DB crash:
 *
 * When the on-disk cache schema is newer than this binary supports (e.g. a
 * stale OpenCode/Pi process still running an older dist after another process
 * migrated the shared DB forward), openDatabase() fails closed by returning a
 * typed-null instead of a live handle. The dream-timer used to drive that null
 * straight into `db.transaction(...)` inside embedding registration, producing
 * a confusing `null is not an object (evaluating 'db.transaction')` TypeError
 * on every 15-minute tick. The timer must instead skip gracefully.
 */
describe("schema-fence null-DB contract", () => {
    test("openDatabase returns falsy (never throws) when DB schema exceeds supported version", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-fence-"));
        const dbPath = join(dir, "context.db");
        try {
            // First open migrates the fresh DB to the current LATEST schema.
            const healthy = openDatabase({ dbPath });
            expect(healthy).toBeTruthy();

            // Re-open pretending this binary only supports schema v0 — any real
            // schema version (>=1) is "newer than supported", so the fence trips.
            // The contract the dream-timer relies on: this returns falsy, it
            // does NOT throw.
            let fenced: unknown;
            expect(() => {
                fenced = openDatabase({ dbPath, latestSupportedVersion: 0 });
            }).not.toThrow();
            expect(fenced).toBeFalsy();

            // A binary that DOES support the schema still opens normally.
            const supported = openDatabase({ dbPath, latestSupportedVersion: 999 });
            expect(supported).toBeTruthy();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

/**
 * Static guard: every openDatabase()/openTimerDatabaseOrNull() result in the
 * dream-timer must be null-checked before use, and sweepProject must not carry
 * an `openDatabase()` default param (which would re-introduce an unguarded
 * null). These assertions fail loudly if the guards are ever removed.
 */
describe("dream-timer null-DB guards (static)", () => {
    const source = readFileSync(join(import.meta.dir, "dream-timer.ts"), "utf8");

    test("defines the guarded open helper and uses it at both entry points", () => {
        expect(source).toContain("function openTimerDatabaseOrNull(");
        expect(source).toContain('openTimerDatabaseOrNull("schedule timer registration")');
        expect(source).toContain('openTimerDatabaseOrNull("maintenance tick")');
    });

    test("guards every guarded-open result with an early return", () => {
        // Count only INVOCATIONS (string-arg call sites), not the function
        // definition. Each must be backed by an `if (!db) return;` guard.
        const callSites = source.match(/openTimerDatabaseOrNull\("/g) ?? [];
        expect(callSites.length).toBeGreaterThanOrEqual(2);
        const guards = source.match(/if \(!db\) return;/g) ?? [];
        expect(guards.length).toBeGreaterThanOrEqual(callSites.length);
    });

    test("sweepProject has no unguarded openDatabase() default param", () => {
        expect(source).not.toContain("db: Database = openDatabase()");
    });

    test("openTimerDatabaseOrNull catches a FATAL openDatabase() throw and degrades to null", () => {
        // openDatabase() returns typed-null on the schema fence but THROWS on a
        // fatal open (corrupt/unwritable DB). openTimerDatabaseOrNull must catch
        // that throw too, so a fatal open can't escape the awaited startup
        // registration in index.ts and abort the whole plugin load.
        const helper = source.slice(
            source.indexOf("function openTimerDatabaseOrNull("),
            source.indexOf("const registeredProjects"),
        );
        expect(helper).toContain("try {");
        expect(helper).toContain("catch");
        expect(helper).toContain("storage fatal");
    });
});

describe("dream-timer startup is fail-open at the index.ts call site (static)", () => {
    // The awaited startDreamScheduleTimer(...) in index.ts runs BEFORE the hooks
    // are returned from server(). If it throws, the transform/compaction pipeline
    // never registers and every session's context balloons. The call must be
    // wrapped so any throw is logged and swallowed.
    const indexSource = readFileSync(join(import.meta.dir, "../index.ts"), "utf8");

    test("await startDreamScheduleTimer is wrapped in try/catch", () => {
        const callIdx = indexSource.indexOf("await startDreamScheduleTimer(");
        expect(callIdx).toBeGreaterThan(0);
        // The 200 chars before the call must contain a `try {`, and the call must
        // be followed (within a small window) by a `catch`.
        const before = indexSource.slice(Math.max(0, callIdx - 200), callIdx);
        const after = indexSource.slice(callIdx, callIdx + 300);
        expect(before).toContain("try {");
        expect(after).toContain("catch");
    });
});

describe("dream-timer message-history maintenance (static)", () => {
    const source = readFileSync(join(import.meta.dir, "dream-timer.ts"), "utf8");

    test("runs durable cleanup retries and the orphan sweep from the global tick", () => {
        const tick = source.slice(
            source.indexOf("function runTick("),
            source.indexOf("function startupJitterMs("),
        );
        expect(tick).toContain("runMessageHistoryMaintenance(db)");
        expect(tick).toContain("retryPendingSessionCleanups(db)");
        expect(tick).toContain("sweepOrphanedOpenCodeMessageIndexes(db, openOpenCodeDb)");
    });
});

describe("dream-timer git commit backlog drain (static)", () => {
    const source = readFileSync(join(import.meta.dir, "dream-timer.ts"), "utf8");

    test("sweepGitCommits invokes coordinated backlog drain after the index sweep", () => {
        expect(source).toContain("drainCommitBacklogForProject");
        expect(source).toContain("memorySnapshot?.gitCommitEnabled");
        expect(source).toContain("backlogDrained");
    });
});

describe("dream-timer dead-directory guard (static)", () => {
    const source = readFileSync(join(import.meta.dir, "dream-timer.ts"), "utf8");

    test("sweepProject skips + unregisters when the directory is gone", () => {
        expect(source).toContain("directoryStillExists(reg.directory)");
        expect(source).toContain("registeredProjects.delete(reg.directory)");
    });

    test("only a dir: identity GCs its schedule rows (git: is shared, must not)", () => {
        // The GC call must be gated behind the dir:-prefix check so a single dead
        // worktree never deletes a shared git: project's schedule.
        const gcIdx = source.indexOf("deleteTaskScheduleRowsForProject(db, reg.projectIdentity)");
        const guardIdx = source.indexOf('reg.projectIdentity.startsWith("dir:")');
        expect(guardIdx).toBeGreaterThan(0);
        expect(gcIdx).toBeGreaterThan(guardIdx);
    });
});

describe("dream-timer normal chunk recovery trigger (static)", () => {
    const source = readFileSync(join(import.meta.dir, "dream-timer.ts"), "utf8");

    test("runProjectMaintenance drains missing compartment chunks under the existing selector", () => {
        const maintenance = source.slice(
            source.indexOf("async function runProjectMaintenance("),
            source.indexOf("async function sweepProject("),
        );
        expect(maintenance).toContain("embedUnembeddedMemoriesForProject(db, reg.projectIdentity)");
        expect(maintenance).toContain("embedUnembeddedCompartmentChunksForProject");
    });

    test("no ledger scan, ledger lease, or recovery queue is introduced", () => {
        expect(source).not.toContain("synapse_batch_ledger");
        expect(source).not.toContain("SynapseLedger");
        expect(source).not.toContain("recoveryQueue");
    });
});

/**
 * Startup project passes are scheduled as jittered timers, one per project.
 * Each pass can drain that project's chunk backlog for minutes, so unless the
 * passes are chained they overlap and load the shared provider and DB at once.
 * `ensureRegistered` is the first await of every pass, which makes it the
 * concurrency probe: two projects' passes must never be inside it together.
 */
describe("dream-timer startup maintenance", () => {
    /** Mirrors DREAM_TIMER_INTERVAL_MS, the delay the timer's interval tick is
     *  registered under. */
    const TIMER_INTERVAL_MS = 15 * 60 * 1000;
    const dirs: string[] = [];
    const originalXdgDataHome = process.env.XDG_DATA_HOME;

    // Jitter slots live at module scope and are shared by every test in this
    // file, so the slot pair this test's projects receive — and therefore the
    // delay between their two passes — is only known once the slots are cleared.
    beforeEach(() => {
        resetStartupJitterSlotsForTests();
    });

    afterEach(() => {
        setBootQuietPeriodForTests(null);
        process.env.XDG_DATA_HOME = originalXdgDataHome;
        for (const dir of dirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("a second project's pass waits for the first instead of draining concurrently", async () => {
        const dataHome = mkdtempSync(join(tmpdir(), "mc-startup-home-"));
        const first = mkdtempSync(join(tmpdir(), "mc-startup-a-"));
        const second = mkdtempSync(join(tmpdir(), "mc-startup-b-"));
        dirs.push(dataHome, first, second);
        process.env.XDG_DATA_HOME = dataHome;
        // Boot quiet already elapsed, so only the per-project jitter delays the
        // passes: slot 0 fires within 1s and slot 1 within 2s of the tick.
        setBootQuietPeriodForTests(Date.now() - BOOT_QUIET_MS);

        const inPass = new Set<string>();
        let maxConcurrent = 0;
        const entered: string[] = [];
        // Longer than the whole jitter span, so an unchained second pass is
        // guaranteed to start while the first is still inside this await.
        const passWorkMs = 2_200;
        const probe = (identity: string) => async () => {
            if (!entered.includes(identity)) entered.push(identity);
            inPass.add(identity);
            maxConcurrent = Math.max(maxConcurrent, inPass.size);
            await new Promise((resolve) => setTimeout(resolve, passWorkMs));
            inPass.delete(identity);
        };

        const stops: Array<(() => void) | undefined> = [];
        try {
            for (const [directory, identity] of [
                [first, "dir:startup-a"],
                [second, "dir:startup-b"],
            ] as const) {
                stops.push(
                    await startDreamScheduleTimer({
                        directory,
                        projectIdentity: identity,
                        client: {} as never,
                        memoryEnabled: true,
                        ensureRegistered: probe(identity),
                    }),
                );
            }

            const deadline = Date.now() + 15_000;
            while (entered.length < 2 && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            while (inPass.size > 0 && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }

            expect(entered.sort()).toEqual(["dir:startup-a", "dir:startup-b"]);
            expect(maxConcurrent).toBe(1);
        } finally {
            for (const stop of stops) stop?.();
        }
    }, 30_000);

    /**
     * A startup wave's passes run on `startupQueue`, outside the tick that
     * scheduled them, and one wave can outlast the timer's interval: it spends a
     * whole shared chunk-backfill budget plus its memory and git drains. An
     * interval pass drives the same provider and database, so it yields while
     * the wave is draining and runs once the wave is done. `ensureRegistered` is
     * the first await of every pass, so its call count reports which passes ran.
     */
    test("an interval tick yields to a draining startup wave and runs after it", async () => {
        const dataHome = mkdtempSync(join(tmpdir(), "mc-interval-home-"));
        const project = mkdtempSync(join(tmpdir(), "mc-interval-a-"));
        dirs.push(dataHome, project);
        process.env.XDG_DATA_HOME = dataHome;
        // Boot quiet already elapsed, so only slot 0's sub-second jitter delays
        // the startup pass.
        setBootQuietPeriodForTests(Date.now() - BOOT_QUIET_MS);

        // Interval ticks are fire-and-forget on a 15-minute setInterval;
        // capturing the callback makes one invocable at a chosen moment. A
        // mismatch on the delay leaves the handle undefined, which the
        // assertion below reports.
        const originalSetInterval = globalThis.setInterval;
        let fireIntervalTick: (() => void) | undefined;
        globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
            if (typeof handler === "function" && timeout === TIMER_INTERVAL_MS) {
                fireIntervalTick = handler as () => void;
                // A parked real timer keeps unref()/clearInterval() working on
                // the handle the timer stores.
                return originalSetInterval(() => {}, 2 ** 30);
            }
            return originalSetInterval(handler, timeout, ...args);
        }) as unknown as typeof setInterval;

        let calls = 0;
        let releaseStartupPass: () => void = () => {};
        const startupPassGate = new Promise<void>((resolve) => {
            releaseStartupPass = resolve;
        });
        // The wave's pass parks inside its first await, holding the startup
        // queue open; every later call returns at once.
        const ensureRegistered = async () => {
            calls += 1;
            if (calls === 1) await startupPassGate;
        };

        const stops: Array<(() => void) | undefined> = [];
        try {
            stops.push(
                await startDreamScheduleTimer({
                    directory: project,
                    projectIdentity: "dir:interval-a",
                    client: {} as never,
                    memoryEnabled: true,
                    ensureRegistered,
                }),
            );

            const deadline = Date.now() + 15_000;
            while (calls === 0 && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            expect(calls).toBe(1);
            expect(fireIntervalTick).toBeDefined();

            // An interval tick landing mid-wave must not open a second pass.
            fireIntervalTick?.();
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(calls).toBe(1);

            releaseStartupPass();
            while (calls < 2 && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            expect(calls).toBe(2);

            // Once the queue drains, an interval tick runs its pass.
            while (calls < 3 && Date.now() < deadline) {
                fireIntervalTick?.();
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            expect(calls).toBeGreaterThanOrEqual(3);
        } finally {
            globalThis.setInterval = originalSetInterval;
            releaseStartupPass();
            for (const stop of stops) stop?.();
        }
    }, 30_000);
});
