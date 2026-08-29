/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionFilePath, resolveLifecycleDataRoot } from "../../../shared/mc-host-lifecycle";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { evaluateSmartNotes } from "../dreamer/evaluate-smart-notes";
import { acquireLease } from "../dreamer/lease";
import { createDreamTaskExecutor } from "../dreamer/task-executor";
import { leaseKeyFor } from "../dreamer/task-registry";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { addNote, getPendingSmartNotes } from "../storage-notes";
import { runDueCompiledSmartNoteChecks } from "./runner";
import { SMART_NOTE_CHECK_POLICY_VERSION } from "./types";
import { __wakePlaneTest, WAKE_PLANE_CAPABILITY, wakePlaneStatus } from "./wake-plane";

const PROJECT = "git:wake-plane-test";

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function catalog(hasWakePlane: boolean) {
    return hasWakePlane
        ? [
              {
                  module_id: "scheduled-wakes",
                  module_version: "0.1.0",
                  roles: [],
                  control_ops: [WAKE_PLANE_CAPABILITY],
              },
          ]
        : [
              {
                  module_id: "other-module",
                  module_version: "0.1.0",
                  roles: [],
                  control_ops: ["other.operation"],
              },
          ];
}

function dueCompiledNote(db: Database) {
    const note = addNote(db, "smart", {
        projectPath: PROJECT,
        content: "Check the scheduled wake handoff.",
        surfaceCondition: "When the condition is met",
    });
    db.prepare(
        `UPDATE notes
         SET compiled_check = ?, check_hash = ?, check_cron = ?, check_version = ?,
             check_status = ?, check_next_due_at = ?, policy_version = ?
         WHERE id = ?`,
    ).run(
        "function check() { return { met: false }; }",
        "wake-plane-check",
        "* * * * *",
        1,
        "compiled",
        0,
        SMART_NOTE_CHECK_POLICY_VERSION,
        note.id,
    );
    return note;
}

// A different test file (ctx-note tools) exercises the gate and can leave the
// module-level verdict cache populated when the full suite interleaves files, so
// this file must clear it on entry, not only on exit.
beforeEach(() => {
    __wakePlaneTest.reset();
});

afterEach(() => {
    __wakePlaneTest.reset();
});

describe("wakePlaneStatus", () => {
    test("recognizes only the affirmative wake.create catalog capability", async () => {
        __wakePlaneTest.setCatalogProbe(async () => catalog(true));
        expect(await wakePlaneStatus()).toBe("present");

        __wakePlaneTest.reset();
        __wakePlaneTest.setCatalogProbe(async () => catalog(false));
        expect(await wakePlaneStatus()).toBe("absent");

        __wakePlaneTest.reset();
        __wakePlaneTest.setCatalogProbe(async () => {
            throw new Error("daemon unavailable");
        });
        expect(await wakePlaneStatus()).toBe("unknown");
    });

    test("a malformed catalog stays fail-open", async () => {
        __wakePlaneTest.setCatalogProbe(async () => [
            { control_ops: WAKE_PLANE_CAPABILITY } as never,
            { control_ops: 42 } as never,
            {} as never,
        ]);
        expect(await wakePlaneStatus()).toBe("absent");
    });

    test("a missing connection file maps to unknown through the real probe without a preflight", async () => {
        const dir = mkdtempSync(join(tmpdir(), "wake-plane-missing-"));
        const previous = process.env.XDG_DATA_HOME;
        process.env.XDG_DATA_HOME = dir;
        try {
            expect(await wakePlaneStatus()).toBe("unknown");
        } finally {
            if (previous === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = previous;
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("an invalid connection file maps to unknown through the real probe", async () => {
        const dir = mkdtempSync(join(tmpdir(), "wake-plane-invalid-"));
        const previous = process.env.XDG_DATA_HOME;
        process.env.XDG_DATA_HOME = dir;
        try {
            const runDir = join(dir, "cortexkit", "run");
            mkdirSync(runDir, { recursive: true });
            writeFileSync(join(runDir, "subc-connection.json"), "not json {", { mode: 0o600 });
            expect(await wakePlaneStatus()).toBe("unknown");
        } finally {
            if (previous === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = previous;
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("concurrent callers coalesce onto one in-flight probe", async () => {
        let probes = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        __wakePlaneTest.setCatalogProbe(async () => {
            probes += 1;
            await gate;
            return catalog(true);
        });
        const first = wakePlaneStatus();
        const second = wakePlaneStatus();
        release();
        expect(await first).toBe("present");
        expect(await second).toBe("present");
        expect(probes).toBe(1);
    });

    test("does not retain an affirmative answer with no readable publication", async () => {
        let probes = 0;
        __wakePlaneTest.setCatalogProbe(async () => {
            probes += 1;
            return catalog(true);
        });
        __wakePlaneTest.setPublicationReader(() => null);

        expect(await wakePlaneStatus()).toBe("present");
        expect(await wakePlaneStatus()).toBe("present");
        expect(probes).toBe(2);
    });

    test("reuses an affirmative answer while the publishing daemon is unchanged", async () => {
        let probes = 0;
        __wakePlaneTest.setCatalogProbe(async () => {
            probes += 1;
            return catalog(true);
        });
        __wakePlaneTest.setPublicationReader(() => "dev:ino:1000:64");

        expect(await wakePlaneStatus()).toBe("present");
        expect(await wakePlaneStatus()).toBe("present");
        expect(probes).toBe(1);
    });

    test("re-probes an affirmative answer after the daemon republishes", async () => {
        let probes = 0;
        let hasWakePlane = true;
        let publication = "dev:ino:1000:64";
        __wakePlaneTest.setCatalogProbe(async () => {
            probes += 1;
            return catalog(hasWakePlane);
        });
        __wakePlaneTest.setPublicationReader(() => publication);

        expect(await wakePlaneStatus()).toBe("present");
        // A replacement daemon republishes its connection file; the capability
        // the previous daemon proved must not carry over to it.
        publication = "dev:ino:2000:64";
        hasWakePlane = false;
        expect(await wakePlaneStatus()).toBe("absent");
        expect(probes).toBe(2);
    });

    test("dials and binds to the connection file the lifecycle owner publishes", () => {
        // An empty XDG_DATA_HOME is ignored by the lifecycle resolver, which
        // starts mc-host under HOME/.local/share. Reading getDataDir() here
        // instead would stat a different path, so a managed start would neither
        // answer the catalog probe nor retire the negative answer cached before it.
        const home = mkdtempSync(join(tmpdir(), "wake-plane-root-"));
        const previousXdg = process.env.XDG_DATA_HOME;
        const previousTestRoot = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
        const previousHome = process.env.HOME;
        process.env.XDG_DATA_HOME = "";
        delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
        process.env.HOME = home;
        try {
            expect(__wakePlaneTest.connectionFile()).toBe(
                connectionFilePath(join(home, ".local", "share")),
            );
            const root = resolveLifecycleDataRoot(process.env);
            expect(root.ok && root.root).toBe(join(home, ".local", "share"));
        } finally {
            if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = previousXdg;
            if (previousTestRoot === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
            else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = previousTestRoot;
            if (previousHome === undefined) delete process.env.HOME;
            else process.env.HOME = previousHome;
            rmSync(home, { recursive: true, force: true });
        }
    });

    test("re-probes a negative answer once a daemon publishes", async () => {
        // Under lazy demand-start the first passive probe usually runs before
        // any Rust or Synapse demand, so it caches a negative answer with no
        // publication. The managed start that follows publishes a connection
        // file and takes over scheduled wakes; retaining the negative answer for
        // the rest of its TTL would leave both planes evaluating conditions.
        let probes = 0;
        let hasWakePlane = false;
        let publication: string | null = null;
        __wakePlaneTest.setCatalogProbe(async () => {
            probes += 1;
            return catalog(hasWakePlane);
        });
        __wakePlaneTest.setPublicationReader(() => publication);

        expect(await wakePlaneStatus()).toBe("absent");
        expect(await wakePlaneStatus()).toBe("absent");
        expect(probes).toBe(1);

        publication = "dev:ino:3000:64";
        hasWakePlane = true;
        expect(await wakePlaneStatus()).toBe("present");
        expect(probes).toBe(2);
    });

    test("re-probes after the TTL instead of retaining a stale catalog answer", async () => {
        let clock = 10_000;
        let hasWakePlane = false;
        let probes = 0;
        __wakePlaneTest.setNow(() => clock);
        __wakePlaneTest.setCatalogProbe(async () => {
            probes += 1;
            return catalog(hasWakePlane);
        });

        expect(await wakePlaneStatus()).toBe("absent");
        hasWakePlane = true;
        expect(await wakePlaneStatus()).toBe("absent");
        expect(probes).toBe(1);

        clock += __wakePlaneTest.ttlMs;
        expect(await wakePlaneStatus()).toBe("present");
        expect(probes).toBe(2);
    });
});

describe("wake-plane smart-note gates", () => {
    test("present skips the dreamer task and leaves its compiled check pending", async () => {
        const db = freshDb();
        try {
            dueCompiledNote(db);
            __wakePlaneTest.setCatalogProbe(async () => catalog(true));
            const client = {
                session: {
                    list: mock(async () => ({ data: [] })),
                    create: mock(async () => ({ data: { id: "must-not-create" } })),
                    prompt: mock(async () => ({})),
                    messages: mock(async () => ({ data: [] })),
                    delete: mock(async () => ({})),
                },
            };
            const executor = createDreamTaskExecutor({
                client: client as never,
                sessionDirectory: process.cwd(),
                openOpenCodeDb: () => null,
            });

            await expect(
                executor(
                    { task: "evaluate-smart-notes", schedule: "* * * * *", timeoutMinutes: 1 },
                    {
                        db,
                        projectIdentity: PROJECT,
                        holderId: "wake-plane-task-holder",
                        leaseKey: leaseKeyFor("evaluate-smart-notes", PROJECT),
                    },
                ),
            ).resolves.toEqual({ status: "completed" });
            expect(getPendingSmartNotes(db, PROJECT)).toHaveLength(1);
            expect(client.session.create).not.toHaveBeenCalled();
            expect(client.session.prompt).not.toHaveBeenCalled();
        } finally {
            closeQuietly(db);
        }
    });

    test("present also blocks the timer sweep before QuickJS, while absent and unknown run it", async () => {
        for (const status of ["present", "absent", "unknown"] as const) {
            const db = freshDb();
            try {
                dueCompiledNote(db);
                __wakePlaneTest.setCatalogProbe(async () => {
                    if (status === "unknown") throw new Error("daemon vanished");
                    return catalog(status === "present");
                });

                const result = await runDueCompiledSmartNoteChecks({
                    db,
                    projectIdentity: PROJECT,
                    projectRoot: process.cwd(),
                    now: 0,
                });
                expect(result.ran).toBe(status === "present" ? 0 : 1);
                __wakePlaneTest.reset();
            } finally {
                closeQuietly(db);
            }
        }
    });

    test("a daemon that vanishes after reporting present resumes standalone evaluation", async () => {
        const db = freshDb();
        try {
            dueCompiledNote(db);
            let clock = 0;
            let daemonAvailable = true;
            __wakePlaneTest.setNow(() => clock);
            __wakePlaneTest.setCatalogProbe(async () => {
                if (!daemonAvailable) throw new Error("daemon vanished");
                return catalog(true);
            });

            expect(
                await runDueCompiledSmartNoteChecks({
                    db,
                    projectIdentity: PROJECT,
                    projectRoot: process.cwd(),
                    now: 0,
                }),
            ).toMatchObject({ ran: 0 });

            daemonAvailable = false;
            clock += __wakePlaneTest.ttlMs;
            expect(
                await runDueCompiledSmartNoteChecks({
                    db,
                    projectIdentity: PROJECT,
                    projectRoot: process.cwd(),
                    now: 0,
                }),
            ).toMatchObject({ ran: 1 });
        } finally {
            closeQuietly(db);
        }
    });

    test("absent and unknown preserve standalone evaluator behavior", async () => {
        for (const status of ["absent", "unknown"] as const) {
            const db = freshDb();
            try {
                dueCompiledNote(db);
                __wakePlaneTest.setCatalogProbe(async () => {
                    if (status === "unknown") throw new Error("daemon unavailable");
                    return catalog(false);
                });
                const leaseKey = `wake-plane-${status}`;
                expect(acquireLease(db, "holder", leaseKey)).toBe(true);

                await expect(
                    evaluateSmartNotes({
                        db,
                        client: {} as never,
                        projectIdentity: PROJECT,
                        parentSessionId: undefined,
                        sessionDirectory: process.cwd(),
                        holderId: "holder",
                        leaseKey,
                        deadline: Date.now() + 60_000,
                    }),
                ).resolves.toMatchObject({ ran: true, pending: 1 });
                __wakePlaneTest.reset();
            } finally {
                closeQuietly(db);
            }
        }
    });
});
