import { McHostClient, type McHostClientOptions } from "./client";

interface ProcessClientEntry {
    promise: Promise<McHostClient>;
    client?: McHostClient;
}

const clients = new Map<string, ProcessClientEntry>();

/** The cache keys `credentialSource` by identity, so callers sharing a client must pass the same object. commentlint: allow(JUDGE) */
const referenceIds = new WeakMap<object, number>();
let nextReferenceId = 0;

function referenceKey(value: unknown): string {
    if (value === undefined) return "-";
    if (value === null) return "null";
    if (typeof value !== "object" && typeof value !== "function") return String(value);
    const existing = referenceIds.get(value as object);
    if (existing !== undefined) return `#${existing}`;
    nextReferenceId += 1;
    referenceIds.set(value as object, nextReferenceId);
    return `#${nextReferenceId}`;
}

/** Shared clients retain the first caller's configuration, so the cache key distinguishes construction-time behavior options: timeouts, route identity, and whether credential fingerprints are presented at all. commentlint: allow(JUDGE) */
function ownerKey(options: McHostClientOptions): string {
    const identity = options.identity;
    return JSON.stringify([
        options.connectionFile,
        options.handshakeTimeoutMs ?? null,
        options.requestTimeoutMs ?? null,
        options.routeOpenDeadlineMs ?? null,
        options.shutdownDeadlineMs ?? null,
        options.targetKind ?? null,
        options.maxDiagnosticEventsPerSecond ?? null,
        identity === undefined
            ? null
            : [
                  identity.project_root,
                  identity.harness,
                  identity.session,
                  identity.credential_fingerprints === undefined
                      ? null
                      : Object.entries(identity.credential_fingerprints).sort(),
              ],
        referenceKey(options.credentialSource),
        referenceKey(options.clock),
        referenceKey(options.sleep),
        referenceKey(options.diagnostics),
        referenceKey(options.connectionFileAfterOpen),
    ]);
}

export function processMcHostClient(options: McHostClientOptions): Promise<McHostClient> {
    const key = ownerKey(options);
    const existing = clients.get(key);
    // Do not return a closed client; closing is irreversible.
    if (existing && !existing.client?.isClosed) return existing.promise;
    if (existing) clients.delete(key);
    const created = McHostClient.connect(options);
    const entry: ProcessClientEntry = { promise: created };
    clients.set(key, entry);
    void created.then(
        (client) => {
            if (clients.get(key) === entry) entry.client = client;
        },
        () => {
            if (clients.get(key) === entry) clients.delete(key);
        },
    );
    return created;
}

/** The cache retains resolved promises, so a caller that closes a shared client must first drop the entry or later callers receive the closed instance. Eviction is identity-scoped: a concurrently created replacement under the same key survives. commentlint: allow(JUDGE) */
export async function evictProcessMcHostClient(
    options: McHostClientOptions,
    client: McHostClient,
): Promise<void> {
    const key = ownerKey(options);
    const entry = clients.get(key);
    if (entry === undefined) return;
    const resolved = await entry.promise.then(
        (value) => value,
        () => undefined,
    );
    if (resolved === client && clients.get(key) === entry) clients.delete(key);
}

export function resetProcessMcHostClientsForTest(): void {
    for (const { promise } of clients.values()) {
        void promise.then((value) => value.closeAsync()).catch(() => undefined);
    }
    clients.clear();
}
