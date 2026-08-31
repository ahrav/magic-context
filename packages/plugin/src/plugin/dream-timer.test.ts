import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOOT_QUIET_MS, setBootQuietPeriodForTests } from "./boot-quiet";
import { resetStartupJitterSlotsForTests, startDreamScheduleTimer } from "./dream-timer";

/**
 * Every `openDatabase()` result in `dream-timer` must be null-checked before use.
 * sweepProject must not default db to openDatabase(), because callers must guard the result.
 */
describe("dream-timer null-DB guards (static)", () => {
    const source = readFileSync(join(import.meta.dir, "dream-timer.ts"), "utf8");

    test("defines the guarded open helper and uses it at both entry points", () => {
        expect(source).toContain("function openTimerDatabaseOrNull(");
        expect(source).toContain('openTimerDatabaseOrNull("schedule timer registration")');
        expect(source).toContain('openTimerDatabaseOrNull("maintenance tick")');
    });

    test("guards every guarded-open result with an early return", () => {
        const callSites = source.match(/openTimerDatabaseOrNull\("/g) ?? [];
        expect(callSites.length).toBeGreaterThanOrEqual(2);
        const guards = source.match(/if \(!db\) return;/g) ?? [];
        expect(guards.length).toBeGreaterThanOrEqual(callSites.length);
    });

    test("sweepProject has no unguarded openDatabase() default param", () => {
        expect(source).not.toContain("db: Database = openDatabase()");
    });

    test("openTimerDatabaseOrNull catches a FATAL openDatabase() throw and degrades to null", () => {
        // openDatabase() returns null at the schema fence but throws for corrupt or unwritable databases.
        // openTimerDatabaseOrNull must catch fatal openDatabase() throws.
        // Catching fatal open failures prevents timer startup from aborting plugin load.
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
    // startDreamScheduleTimer() runs before server() returns its hooks.
    // If startDreamScheduleTimer throws before server() returns its hooks, hook registration does not occur.
    const indexSource = readFileSync(join(import.meta.dir, "../index.ts"), "utf8");

    test("await startDreamScheduleTimer is wrapped in try/catch", () => {
        const callIdx = indexSource.indexOf("await startDreamScheduleTimer(");
        expect(callIdx).toBeGreaterThan(0);
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
        // Gate GC on the `dir:` prefix so a dead worktree cannot delete a shared `git:` project's schedule.
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
 * Each pass can drain its project's chunk backlog for minutes, so passes must be chained to avoid concurrent provider and database load.
 * Two projects' passes must never be inside ensureRegistered together.
 */
describe("dream-timer startup maintenance", () => {
    /**
     *  registered under. */
    const TIMER_INTERVAL_MS = 15 * 60 * 1000;
    const dirs: string[] = [];
    const originalXdgDataHome = process.env.XDG_DATA_HOME;

    // Reset module-scoped jitter slots so this test assigns deterministic delays.
    // The assigned slot pair determines the delay between the two project passes.
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
        // Slot 0 fires within 1 second and slot 1 within 2 seconds of the tick.
        setBootQuietPeriodForTests(Date.now() - BOOT_QUIET_MS);

        const inPass = new Set<string>();
        let maxConcurrent = 0;
        const entered: string[] = [];
        // Wait longer than the full jitter span while the first pass awaits ensureRegistered so the second unchained pass starts.
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
     * The serialized queue waits for the shared chunk-backfill budget and each project's git, smart-note, and due-dreamer drains.
     * The shared queue can delay an entry until after its directory is unregistered or re-registered.
     * Each queued entry re-checks its registration when it reaches the front of the queue.
     */
    test("a project unregistered while queued is skipped and the rest of the wave still runs", async () => {
        const dataHome = mkdtempSync(join(tmpdir(), "mc-stale-home-"));
        // Registration order fixes jitter slots and queue order.
        // The first registration starts the timer and is scheduled last by the startup tick.
        // The second registration receives slot 0 and dequeues first.
        const survivor = mkdtempSync(join(tmpdir(), "mc-stale-survivor-"));
        const gate = mkdtempSync(join(tmpdir(), "mc-stale-gate-"));
        const victim = mkdtempSync(join(tmpdir(), "mc-stale-victim-"));
        dirs.push(dataHome, survivor, gate, victim);
        process.env.XDG_DATA_HOME = dataHome;
        // Boot quiet has elapsed, so only per-project jitter delays the startup pass.
        // Slots 0–2 fire within 3 seconds of the startup tick.
        setBootQuietPeriodForTests(Date.now() - BOOT_QUIET_MS);

        const entered: string[] = [];
        let releaseGatePass: () => void = () => {};
        const gatePassGate = new Promise<void>((resolve) => {
            releaseGatePass = resolve;
        });
        const probe = (identity: string) => async () => {
            if (!entered.includes(identity)) entered.push(identity);
            // The head-of-queue pass parks here, keeping the queue open.
            // The parked pass allows two later entries to queue and one to be unregistered before dequeuing.
            if (identity === "dir:stale-gate") await gatePassGate;
        };

        const stops = new Map<string, (() => void) | undefined>();
        try {
            for (const [directory, identity] of [
                [survivor, "dir:stale-survivor"],
                [gate, "dir:stale-gate"],
                [victim, "dir:stale-victim"],
            ] as const) {
                stops.set(
                    identity,
                    await startDreamScheduleTimer({
                        directory,
                        projectIdentity: identity,
                        client: {} as never,
                        memoryEnabled: true,
                        ensureRegistered: probe(identity),
                    }),
                );
            }

            const deadline = Date.now() + 20_000;
            while (entered.length === 0 && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            expect(entered).toEqual(["dir:stale-gate"]);

            // Both remaining projects are queued behind the parked pass after the last jitter slot.
            await new Promise((resolve) => setTimeout(resolve, 3_300));
            expect(entered).toEqual(["dir:stale-gate"]);

            // Unregistering leaves a queued entry with an inactive registration.
            // longer live.
            stops.get("dir:stale-victim")?.();
            stops.delete("dir:stale-victim");

            releaseGatePass();
            while (!entered.includes("dir:stale-survivor") && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            await new Promise((resolve) => setTimeout(resolve, 300));

            expect(entered).not.toContain("dir:stale-victim");
            expect(entered.sort()).toEqual(["dir:stale-gate", "dir:stale-survivor"]);
        } finally {
            releaseGatePass();
            for (const stop of stops.values()) stop?.();
        }
    }, 40_000);

    /**
     * Startup-wave passes run on `startupQueue`, outside the timer tick.
     * A startup wave can outlast the timer interval because it waits for the shared chunk-backfill budget and memory and git drains.
     * The interval pass yields while the startup wave drains because both use the same provider and database.
     * The interval pass runs after the startup wave completes.
     * `ensureRegistered` is the first await of every pass, so its call count reports which passes ran.
     */
    test("an interval tick yields to a draining startup wave and runs after it", async () => {
        const dataHome = mkdtempSync(join(tmpdir(), "mc-interval-home-"));
        const project = mkdtempSync(join(tmpdir(), "mc-interval-a-"));
        dirs.push(dataHome, project);
        process.env.XDG_DATA_HOME = dataHome;
        // Boot quiet has elapsed, so only slot 0's sub-second jitter delays the startup pass.
        setBootQuietPeriodForTests(Date.now() - BOOT_QUIET_MS);

        // Capturing the callback allows the test to invoke an interval tick at a chosen time.
        // A delay mismatch leaves `fireIntervalTick` undefined, and the assertion reports it.
        const originalSetInterval = globalThis.setInterval;
        let fireIntervalTick: (() => void) | undefined;
        globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
            if (typeof handler === "function" && timeout === TIMER_INTERVAL_MS) {
                fireIntervalTick = handler as () => void;
                return originalSetInterval(() => {}, 2 ** 30);
            }
            return originalSetInterval(handler, timeout, ...args);
        }) as unknown as typeof setInterval;

        let calls = 0;
        let releaseStartupPass: () => void = () => {};
        const startupPassGate = new Promise<void>((resolve) => {
            releaseStartupPass = resolve;
        });
        // `startupPassGate` keeps the startup wave active until `releaseStartupPass()` resolves it.
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

            // Once `startupQueue` drains, an interval tick runs its pass.
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
