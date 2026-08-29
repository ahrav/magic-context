/// <reference types="bun-types" />

import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createDirectTestDatabase } from "../test-database";
import {
    acquireLease,
    acquireLeaseWithAcquisition,
    DREAMING_LEASE_KEY,
    getLeaseHolder,
    isLeaseActive,
    releaseLease,
    renewLease,
    runLeaseGuardedWrite,
    startLeaseHeartbeat,
} from "./lease";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function expireLease(db: Database, key = "dreaming_lease_expiry"): void {
    db.prepare(`UPDATE dream_state SET value = ? WHERE key = '${key}'`).run(String(Date.now() - 1));
}

function makeDb(path = ":memory:"): Database {
    const db = createDirectTestDatabase({ path: path }).db;
    return db;
}

describe("dreamer lease (atomic CAS)", () => {
    it("acquires, renews for the same holder, and releases", () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        expect(isLeaseActive(db)).toBe(true);
        expect(getLeaseHolder(db)).toBe("holder-a");
        expect(renewLease(db, "holder-a")).toBe(true);
        releaseLease(db, "holder-a");
        expect(isLeaseActive(db)).toBe(false);
        expect(getLeaseHolder(db)).toBeNull();
        closeQuietly(db);
    });

    it("blocks a second holder while the lease is active", () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        expect(acquireLease(db, "holder-b")).toBe(false);
        expect(getLeaseHolder(db)).toBe("holder-a");
        closeQuietly(db);
    });

    it("keyed leases for different domains do NOT block each other", () => {
        const db = makeDb();
        // memory domain held — key-files and global user-memories stay free.
        expect(acquireLease(db, "h-mem", "memory:git:abc")).toBe(true);
        expect(acquireLease(db, "h-kf", "key-files:git:abc")).toBe(true);
        expect(acquireLease(db, "h-um", "user-memories")).toBe(true);
        // Same memory domain, second holder → blocked.
        expect(acquireLease(db, "h-mem2", "memory:git:abc")).toBe(false);
        // Same domain but DIFFERENT project → independent, free.
        expect(acquireLease(db, "h-mem3", "memory:git:other")).toBe(true);
        expect(getLeaseHolder(db, "memory:git:abc")).toBe("h-mem");
        expect(getLeaseHolder(db, "key-files:git:abc")).toBe("h-kf");
        expect(isLeaseActive(db, "user-memories")).toBe(true);
        closeQuietly(db);
    });

    it("releasing one keyed lease leaves siblings untouched", () => {
        const db = makeDb();
        expect(acquireLease(db, "h-mem", "memory:git:abc")).toBe(true);
        expect(acquireLease(db, "h-kf", "key-files:git:abc")).toBe(true);
        releaseLease(db, "h-mem", "memory:git:abc");
        expect(isLeaseActive(db, "memory:git:abc")).toBe(false);
        expect(isLeaseActive(db, "key-files:git:abc")).toBe(true);
        expect(getLeaseHolder(db, "key-files:git:abc")).toBe("h-kf");
        closeQuietly(db);
    });

    it("legacy default key is isolated from new keyed leases", () => {
        const db = makeDb();
        expect(acquireLease(db, "legacy-holder")).toBe(true); // default = DREAMING_LEASE_KEY
        expect(isLeaseActive(db, DREAMING_LEASE_KEY)).toBe(true);
        // A keyed domain lease is unaffected by the legacy lease being held.
        expect(acquireLease(db, "h-mem", "memory:git:abc")).toBe(true);
        expect(isLeaseActive(db)).toBe(true); // legacy still held
        closeQuietly(db);
    });

    it("lets another holder reclaim an expired lease", () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        // Force expiry in the past.
        db.prepare("UPDATE dream_state SET value = ? WHERE key = 'dreaming_lease_expiry'").run(
            String(Date.now() - 1),
        );
        expect(acquireLease(db, "holder-b")).toBe(true);
        expect(getLeaseHolder(db)).toBe("holder-b");
        closeQuietly(db);
    });

    it("renew fails for holder mismatch or expired lease", () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        expect(renewLease(db, "holder-b")).toBe(false);
        db.prepare("UPDATE dream_state SET value = ? WHERE key = 'dreaming_lease_expiry'").run(
            String(Date.now() - 1),
        );
        expect(renewLease(db, "holder-a")).toBe(false);
        closeQuietly(db);
    });

    it("release is a no-op after another holder reclaims the lease", () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        db.prepare("UPDATE dream_state SET value = ? WHERE key = 'dreaming_lease_expiry'").run(
            String(Date.now() - 1),
        );
        expect(acquireLease(db, "holder-b")).toBe(true);
        // holder-a's stale release must NOT clear holder-b's live lease.
        releaseLease(db, "holder-a");
        expect(getLeaseHolder(db)).toBe("holder-b");
        expect(isLeaseActive(db)).toBe(true);
        closeQuietly(db);
    });

    it("lease-guarded writes reject a stolen lease before committing", () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a", "memory:proj")).toBe(true);
        expect(db.prepare("CREATE TABLE guarded_writes (value TEXT)").run()).toBeDefined();

        // Simulate the unsafe old pattern's gap: holder-a peeked successfully,
        // then its lease expired and another runner claimed it before the write.
        expect(getLeaseHolder(db, "memory:proj")).toBe("holder-a");
        expireLease(db, "lease:memory:proj:expiry");
        expect(acquireLease(db, "holder-b", "memory:proj")).toBe(true);

        expect(() =>
            runLeaseGuardedWrite(db, "holder-a", "memory:proj", () => {
                db.prepare("INSERT INTO guarded_writes (value) VALUES ('committed')").run();
            }),
        ).toThrow(/lease lost/i);
        expect(db.prepare("SELECT COUNT(*) AS count FROM guarded_writes").get()).toEqual({
            count: 0,
        });
        closeQuietly(db);
    });

    it("allows exactly one winner across separate DB handles", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-dream-lease-handles-"));
        const path = join(dir, "context.db");
        const dbA = makeDb(path);
        const dbB = new Database(path);
        dbB.exec("PRAGMA busy_timeout=5000");
        dbB.exec("PRAGMA foreign_keys=ON");
        dbB.exec("PRAGMA journal_mode=WAL");
        try {
            const results = [acquireLease(dbA, "holder-a"), acquireLease(dbB, "holder-b")];
            // Exactly one process may hold the global dream lease at a time.
            expect(results.filter(Boolean)).toHaveLength(1);
        } finally {
            closeQuietly(dbA);
            closeQuietly(dbB);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("allows exactly one winner across subprocesses sharing a DB", async () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-dream-lease-process-"));
        const path = join(dir, "context.db");
        const setup = makeDb(path);
        closeQuietly(setup);
        try {
            const pluginRoot = process.cwd().endsWith("/packages/plugin")
                ? process.cwd()
                : join(process.cwd(), "packages", "plugin");
            const script = `
                const sqlite = await import(${JSON.stringify(`file://${pluginRoot}/src/shared/sqlite.ts`)});
                const lease = await import(${JSON.stringify(`file://${pluginRoot}/src/features/magic-context/dreamer/lease.ts`)});
                const db = new sqlite.Database(${JSON.stringify(path)});
                db.exec("PRAGMA busy_timeout=5000");
                const ok = lease.acquireLease(db, process.argv.at(-1) ?? "missing-holder");
                db.close();
                console.log(JSON.stringify({ ok }));
            `;
            const [a, b] = await Promise.all([
                $`bun -e ${script} holder-a`.json() as Promise<{ ok: boolean }>,
                $`bun -e ${script} holder-b`.json() as Promise<{ ok: boolean }>,
            ]);
            expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("startLeaseHeartbeat", () => {
    it("keeps the lease alive without declaring it lost", async () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        const hb = startLeaseHeartbeat(db, "holder-a", DREAMING_LEASE_KEY, () => {}, 20);
        await sleep(70);
        expect(hb.lost).toBe(false);
        expect(getLeaseHolder(db)).toBe("holder-a");
        expect(isLeaseActive(db)).toBe(true);
        hb.stop();
        closeQuietly(db);
    });

    it("declares a different active holder lost before returning", () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-b")).toBe(true);
        let lostCalls = 0;
        const hb = startLeaseHeartbeat(
            db,
            "holder-a",
            DREAMING_LEASE_KEY,
            () => {
                lostCalls += 1;
            },
            20,
        );
        expect(hb.lost).toBe(true);
        expect(lostCalls).toBe(1);
        expect(getLeaseHolder(db)).toBe("holder-b");
        hb.stop();
        closeQuietly(db);
    });

    it("reclaims a self-inflicted expiry instead of declaring lost (transient-tolerant)", async () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        // Simulate a missed beat: the lease expired but nobody else took it.
        expireLease(db);
        let lostReason: string | null = null;
        const hb = startLeaseHeartbeat(
            db,
            "holder-a",
            DREAMING_LEASE_KEY,
            (reason) => {
                lostReason = reason;
            },
            20,
        );
        await sleep(50);
        // renew-or-reclaim: the heartbeat re-acquires the free lease, no loss.
        expect(lostReason).toBeNull();
        expect(hb.lost).toBe(false);
        expect(getLeaseHolder(db)).toBe("holder-a");
        hb.stop();
        closeQuietly(db);
    });

    it("declares lost (not reclaim) when the lease lapsed past a full TTL — split-brain guard", async () => {
        // A >TTL stall (e.g. machine sleep): our lease lapsed and a sibling could
        // have acquired AND mutated in the gap. Even though the lease may now be
        // free, blindly reclaiming + continuing on our stale snapshot is
        // split-brain — the heartbeat must declare lost. (A short ≤TTL gap still
        // reclaims; see the transient-tolerant test above.)
        const db = makeDb();
        const realNow = Date.now();
        const clock = { value: realNow };
        const nowSpy = spyOn(Date, "now").mockImplementation(() => clock.value);
        try {
            expect(acquireLease(db, "holder-a")).toBe(true);
            let lostReason: string | null = null;
            // Short interval so a real timer beat fires; the FIRST synchronous
            // beat confirms ownership at t0 (lastConfirmedAt = realNow).
            const hb = startLeaseHeartbeat(
                db,
                "holder-a",
                DREAMING_LEASE_KEY,
                (reason) => {
                    lostReason = reason;
                },
                20,
            );
            expect(hb.lost).toBe(false);

            // Jump the clock 3 minutes (> 2min TTL): our own lease has lapsed
            // (isLeaseActive false), so the next beat's renewLease fails and the
            // gap exceeds the TTL.
            clock.value = realNow + 3 * 60 * 1000;
            await sleep(60);

            expect(hb.lost).toBe(true);
            expect(lostReason).toContain("past TTL");
            hb.stop();
        } finally {
            nowSpy.mockRestore();
            closeQuietly(db);
        }
    });

    it("uses acquisition time and generation across a pre-heartbeat interloper gap", () => {
        const db = makeDb();
        const realNow = Date.now();
        const clock = { value: realNow };
        const nowSpy = spyOn(Date, "now").mockImplementation(() => clock.value);
        try {
            const acquisition = acquireLeaseWithAcquisition(db, "holder-a");
            expect(acquisition).not.toBeNull();
            clock.value = realNow + 3 * 60 * 1_000;
            expect(acquireLease(db, "holder-b")).toBe(true);
            releaseLease(db, "holder-b");
            let lostReason: string | null = null;

            const hb = startLeaseHeartbeat(
                db,
                "holder-a",
                DREAMING_LEASE_KEY,
                (reason) => {
                    lostReason = reason;
                },
                acquisition ?? undefined,
            );

            expect(hb.lost).toBe(true);
            expect(lostReason).toContain("generation changed");
            expect(getLeaseHolder(db)).toBeNull();
            hb.stop();
        } finally {
            nowSpy.mockRestore();
            closeQuietly(db);
        }
    });

    it("declares lost exactly once when a different holder actively owns the lease", async () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        let lostCalls = 0;
        const hb = startLeaseHeartbeat(
            db,
            "holder-a",
            DREAMING_LEASE_KEY,
            () => {
                lostCalls += 1;
            },
            20,
        );
        // A genuine theft: expire then let another holder claim it.
        expireLease(db);
        expect(acquireLease(db, "holder-b")).toBe(true);
        await sleep(80);
        expect(hb.lost).toBe(true);
        expect(lostCalls).toBe(1); // onLost fires once, not on every subsequent beat
        expect(getLeaseHolder(db)).toBe("holder-b");
        hb.stop();
        closeQuietly(db);
    });

    it("stops firing after stop()", async () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        let beats = 0;
        const hb = startLeaseHeartbeat(
            db,
            "holder-a",
            DREAMING_LEASE_KEY,
            () => {
                beats += 1;
            },
            20,
        );
        hb.stop();
        expireLease(db);
        expect(acquireLease(db, "holder-b")).toBe(true);
        await sleep(60);
        expect(beats).toBe(0); // no callbacks after stop()
        closeQuietly(db);
    });
});
