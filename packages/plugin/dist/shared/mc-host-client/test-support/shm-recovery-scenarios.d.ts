/**
 * Runtime-neutral fresh-generation re-upgrade scenarios (U3, R9-R11).
 *
 * Each scenario drives a real `McHostClient` against the independent
 * `FakePeer` plus the in-process fake paired provider using
 * `node:assert/strict` only — no bun:test — so the same key scenarios also
 * execute under Node 24 through `run-mc-host-client-node.ts`.
 * `shm-recovery.test.ts` wraps every scenario in a bun test and adds
 * bun-specific cases on top.
 */
import { McHostClient, type McHostClientOptions } from "../client";
import { FakePeer, type FakePeerConnection, type PeerFrame } from "./fake-peer";
import { type FakePairedProvider } from "./test-util";
export declare const RECOVERY_GRANT_TOKEN = "00112233445566778899aabbccddeeff";
export interface RecoveryScenario {
    name: string;
    run(ctx: RecoveryContext): Promise<void>;
}
/** Tracked peers/clients/tmp files, torn down after each scenario. */
export interface RecoveryContext {
    startPeer(options?: Parameters<typeof FakePeer.start>[0]): Promise<FakePeer>;
    connect(peer: FakePeer, overrides?: Partial<McHostClientOptions>): Promise<McHostClient>;
    /** Path of the connection file written by the most recent `connect`. */
    lastConnectionFile: string;
}
export declare function runRecoveryScenario(scenario: RecoveryScenario): Promise<void>;
export declare function tcpSelectionBody(reason?: string): Record<string, unknown>;
export declare function grantSelectionBody(transport?: string): Record<string, unknown>;
/**
 * Script every `transport.negotiate` across ALL connections in accept
 * order: `bodies(index)` returns the response body for the index-th
 * negotiation, or `null` to stay silent.
 */
export declare function scriptNegotiations(peer: FakePeer, bodies: (index: number, frame: PeerFrame, conn: FakePeerConnection) => unknown): () => number;
/** Stopping suppresses route responses without removing the socket data listener. */
export declare function serveTcpRoutes(conn: FakePeerConnection, firstChannel: number): () => void;
/** Default provider-host script serving managed routes on channel 5. */
export declare function recoveryProvider(): FakePairedProvider;
/** Runs `turns` `setImmediate` turns without timer delays. */
export declare function settle(turns?: number): Promise<void>;
export declare const shmRecoveryScenarios: readonly RecoveryScenario[];
//# sourceMappingURL=shm-recovery-scenarios.d.ts.map