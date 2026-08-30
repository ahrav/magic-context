/** PiTestHarness — facade for Pi Magic Context e2e tests. */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createDirectTestDatabase } from "../../plugin/src/features/magic-context/test-database";
import { Database } from "../../plugin/src/shared/sqlite";
import { ballastProse } from "./ballast";
import { initializeIsolatedContextDb as initializeContextDbFromRelease } from "./initialize-context-db";
import { MockProvider, type MockResponse } from "./mock-provider/server";
import { createPiIsolatedEnv, type PiIsolatedEnv, type PiRunResult } from "./pi-runner/spawn";
import type { VerifiedReleaseRoot } from "./prospective-holdout/release-root";
import {
  PiRpcClient,
  type PiMessage,
  type PiRpcEvent,
  type PiSessionStats,
  type PiState,
  requireSuccessfulResponse,
} from "./pi-runner/rpc-client";

export interface PiTestHarnessOptions {
  magicContextConfig?: Record<string, unknown>;
  piSettingsExtra?: Record<string, unknown>;
  modelContextLimit?: number;
  mockDefault?: MockResponse;
  /** Share the cortexkit DB with another harness. */
  sharedDataDir?: string;
  /** Optional working directory override before the persistent Pi process starts. */
  workdir?: string;
  /** Verified immutable release root. Omitted keeps active-checkout behavior. */
  releaseRoot?: VerifiedReleaseRoot;
}

const DEFAULT_MOCK_RESPONSE: MockResponse = {
  text: "ok",
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 0,
  },
};

function initializeIsolatedContextDb(
  dataDir: string,
  releaseRoot?: VerifiedReleaseRoot,
): void {
  if (releaseRoot) {
    initializeContextDbFromRelease(dataDir, releaseRoot);
    return;
  }
  const path = join(dataDir, "cortexkit", "magic-context", "context.db");
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  createDirectTestDatabase({ path }).db.close();
}

export class PiTestHarness {
  readonly mock: MockProvider;
  readonly env: PiIsolatedEnv;

  private readonly rpc: PiRpcClient;
  private contextDbCached: Database | null = null;
  private turns: PiRunResult[] = [];

  private constructor(mock: MockProvider, rpc: PiRpcClient) {
    this.mock = mock;
    this.rpc = rpc;
    this.env = rpc.env;
  }

  static async create(options: PiTestHarnessOptions = {}): Promise<PiTestHarness> {
    const mock = new MockProvider();
    await mock.start();
    mock.setDefault(options.mockDefault ?? DEFAULT_MOCK_RESPONSE);
    const env = createPiIsolatedEnv(options.sharedDataDir);
    if (options.workdir) env.workdir = options.workdir;
    initializeIsolatedContextDb(env.dataDir, options.releaseRoot);
    const rpc = new PiRpcClient({
      env,
      mockProviderURL: PiTestHarness.mockBaseURL(mock),
      magicContextConfig: options.magicContextConfig,
      piSettingsExtra: options.piSettingsExtra,
      modelContextLimit: options.modelContextLimit,
      releaseRoot: options.releaseRoot,
    });

    try {
      await rpc.start();
    } catch (error) {
      await mock.stop();
      throw error;
    }

    return new PiTestHarness(mock, rpc);
  }

  /**
   * Generate ~`tokens` tokens of varied prose ballast. Delegates to the shared
   * generator (see ballast.ts): the v3 protected-tail boundary measures
   * TRUE-RAW content, not mock usage numbers, so pressure-driving turns must
   * carry real content mass or the boundary resolves no eligible head and the
   * historian (correctly) never starts.
   */
  ballast(tokens: number): string {
    return ballastProse(tokens);
  }

  async sendPrompt(
    text: string,
    options: { timeoutMs?: number; continueSession?: boolean; images?: unknown[] } = {},
  ): Promise<PiRunResult> {
    // Default bumped from 60s → 180s. Pi historian + ctx_search work spawn a
    // `pi --print` subprocess that calls the mock provider over HTTP, which on
    // GitHub-hosted ubuntu runners is ~3-5x slower than local hardware. 180s
    // covers the slowest known Pi paths (historian + compartment publish chain)
    // while still bounding tests. Individual call sites can pass smaller values.
    const timeoutMs = options.timeoutMs ?? 180_000;
    const events: PiRpcEvent[] = [];
    let capturing = false;
    const unsubscribe = this.rpc.onEvent((event) => {
      if (event.type === "agent_start") capturing = true;
      if (capturing) events.push(event);
    });
    const agentEnd = this.rpc.waitForEvent(
      (event) => capturing && event.type === "agent_end",
      { timeoutMs, label: "agent_end" },
    );

    try {
      const promptResponse = await this.rpc.sendCommand(
        "prompt",
        { message: text, ...(options.images ? { images: options.images } : {}) },
        { timeoutMs, label: "prompt response" },
      );
      requireSuccessfulResponse(promptResponse);
      await agentEnd;
      const state = await this.getState();
      const result: PiRunResult = {
        sessionId: typeof state.sessionId === "string" ? state.sessionId : null,
        events: events as Array<Record<string, unknown>>,
        stdout: events.map((event) => JSON.stringify(event)).join("\n"),
        stderr: this.rpc.getStderr(),
        exitCode: null,
        signalCode: null,
      };
      this.turns.push(result);
      return result;
    } catch (error) {
      void agentEnd.catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\n--- pi rpc stderr ---\n${this.rpc.getStderr()}`);
    } finally {
      unsubscribe();
    }
  }

  private static mockBaseURL(mock: MockProvider): string {
    const last = mock.requests()[0];
    if (last) return `http://${last.headers.host}`;
    // SAFETY: MockProvider.start stores Bun server under this stable test-only field.
    const server = (mock as unknown as { server?: { port?: number } }).server;
    const port = server?.port;
    if (!port) throw new Error("mock provider is not running");
    return `http://127.0.0.1:${port}`;
  }

  async getState(): Promise<PiState> {
    const response = await this.rpc.sendCommand<PiState>("get_state");
    return requireSuccessfulResponse(response);
  }

  async getMessages(): Promise<PiMessage[]> {
    const response = await this.rpc.sendCommand<{ messages: PiMessage[] }>("get_messages");
    return requireSuccessfulResponse(response).messages;
  }

  async getSessionStats(): Promise<PiSessionStats> {
    const response = await this.rpc.sendCommand<PiSessionStats>("get_session_stats");
    return requireSuccessfulResponse(response);
  }

  async compactNow(): Promise<void> {
    const response = await this.rpc.sendCommand("compact");
    requireSuccessfulResponse(response);
  }

  async newSession(): Promise<void> {
    const response = await this.rpc.sendCommand<{ cancelled?: boolean }>("new_session");
    const data = requireSuccessfulResponse(response);
    if (data?.cancelled) throw new Error("Pi new_session was cancelled by an extension");
  }

  get lastTurn(): PiRunResult | null {
    return this.turns[this.turns.length - 1] ?? null;
  }

  contextDbPath(): string {
    return join(this.env.dataDir, "cortexkit", "magic-context", "context.db");
  }

  contextDb(): Database {
    if (this.contextDbCached) return this.contextDbCached;
    const dbPath = this.contextDbPath();
    if (!existsSync(dbPath)) throw new Error(`context.db not found at ${dbPath}`);
    this.contextDbCached = new Database(dbPath, { readonly: true });
    return this.contextDbCached;
  }

  closeContextDb(): void {
    if (!this.contextDbCached) return;
    try {
      this.contextDbCached.close();
    } catch {
      // ignore close errors in test polling helpers
    }
    this.contextDbCached = null;
  }

  hasContextDb(): boolean {
    return existsSync(this.contextDbPath());
  }

  countTags(sessionId: string, harness = "pi"): number {
    try {
      const row = this.contextDb()
        .prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND harness = ?")
        .get(sessionId, harness) as { n: number } | null;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  countPendingOps(sessionId: string, harness = "pi"): number {
    try {
      const row = this.contextDb()
        .prepare("SELECT COUNT(*) AS n FROM pending_ops WHERE session_id = ? AND harness = ?")
        .get(sessionId, harness) as { n: number } | null;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  countDroppedTags(sessionId: string, harness = "pi"): number {
    try {
      const row = this.contextDb()
        .prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND harness = ? AND status = 'dropped'")
        .get(sessionId, harness) as { n: number } | null;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  async waitFor<T>(
    predicate: () => T | null | undefined | false,
    opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
  ): Promise<T> {
    // Default bumped from 10s → 60s for CI. waitFor polls for DB rows /
    // queued ops to appear; on CI shared runners there can be material
    // latency between an event firing and the SQLite row being visible.
    // Individual call sites can pass a smaller timeoutMs.
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const intervalMs = opts.intervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value as T;
      await Bun.sleep(intervalMs);
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms${opts.label ? ` (${opts.label})` : ""}`);
  }

  requests() {
    return this.mock.requests();
  }

  async dispose(): Promise<void> {
    if (this.contextDbCached) {
      try {
        this.contextDbCached.close();
      } catch {
        // ignore close errors
      }
      this.contextDbCached = null;
    }
    await this.rpc.shutdown();
    await this.mock.stop();
    rmSync(this.env.baseDir, { recursive: true, force: true });
  }
}
