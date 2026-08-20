/**
 * Shared runtime-neutral test helpers for the mc-host-client suites.
 * `node:assert/strict` only — no bun:test — so runtime-neutral callers
 * (like the adversarial scenario runner) can import everything here.
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { ConnectionGeneration, type ConnectionGenerationOptions } from "../connection";
import { Deadline } from "../deadline";
import { SubcCallError } from "../errors";
import { FakePeer, type FakePeerOptions } from "./fake-peer";

/** Await a promise that MUST reject and return its rejection value. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
        () => {
            throw new Error("promise unexpectedly resolved");
        },
        (error: unknown) => error,
    );
}

export async function waitUntil(check: () => boolean, timeoutMs = 3_000): Promise<void> {
    const startedAt = Date.now();
    while (!check()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error("waitUntil timed out");
        }
        await delay(5);
    }
}

export function expectSubcCallError(
    error: unknown,
    kind: SubcCallError["kind"],
    code?: string,
): SubcCallError {
    assert.ok(error instanceof SubcCallError, `expected SubcCallError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    if (code !== undefined) assert.equal(error.code, code);
    return error;
}

export async function writeConnectionFile(filePath: string, peer: FakePeer): Promise<void> {
    const json = JSON.stringify({
        schema: 1,
        wire_version: 2,
        endpoints: [{ host: "127.0.0.1", port: peer.port }],
        key: Array.from(peer.key),
        daemon_id: Array.from(peer.daemonId),
        pid: process.pid,
        daemon_ver: "fake-peer/0.0.1",
    });
    await writeFile(filePath, json, { mode: 0o600 });
}

/** Peer/generation factory whose creations are tracked for cleanup. */
export interface ScenarioContext {
    /** Start a tracked fake peer; closed by `cleanup()`. */
    startPeer(options?: FakePeerOptions): Promise<FakePeer>;
    /** Construct a tracked, unstarted generation dialing `peer`. */
    createGeneration(
        peer: FakePeer,
        overrides?: Partial<ConnectionGenerationOptions>,
    ): ConnectionGeneration;
    /** Construct AND start a tracked generation under `deadlineMs`. */
    dial(
        peer: FakePeer,
        overrides?: Partial<ConnectionGenerationOptions>,
        deadlineMs?: number,
    ): Promise<ConnectionGeneration>;
}

export interface TrackedHarness extends ScenarioContext {
    /** Retire every tracked generation, then close every tracked peer. */
    cleanup(): Promise<void>;
}

export function createTrackedHarness(): TrackedHarness {
    const peers: FakePeer[] = [];
    const generations: ConnectionGeneration[] = [];
    const harness: TrackedHarness = {
        async startPeer(options?: FakePeerOptions): Promise<FakePeer> {
            const peer = await FakePeer.start(options);
            peers.push(peer);
            return peer;
        },
        createGeneration(
            peer: FakePeer,
            overrides: Partial<ConnectionGenerationOptions> = {},
        ): ConnectionGeneration {
            const generation = new ConnectionGeneration({
                host: "127.0.0.1",
                port: peer.port,
                credentials: { key: peer.key, daemonId: peer.daemonId },
                ...overrides,
            });
            generations.push(generation);
            return generation;
        },
        async dial(
            peer: FakePeer,
            overrides: Partial<ConnectionGenerationOptions> = {},
            deadlineMs = 2_000,
        ): Promise<ConnectionGeneration> {
            const generation = harness.createGeneration(peer, overrides);
            await generation.start(Deadline.start(deadlineMs));
            return generation;
        },
        async cleanup(): Promise<void> {
            for (const generation of generations) {
                generation.retire("owner_close");
            }
            for (const peer of peers) {
                await peer.close();
            }
        },
    };
    return harness;
}
