import { McHostClient, type McHostClientOptions } from "./client";

const clients = new Map<string, Promise<McHostClient>>();

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
    if (existing) return existing;
    const created = McHostClient.connect(options);
    clients.set(key, created);
    void created.catch(() => {
        if (clients.get(key) === created) clients.delete(key);
    });
    return created;
}

export function resetProcessMcHostClientsForTest(): void {
    for (const client of clients.values()) {
        void client.then((value) => value.closeAsync()).catch(() => undefined);
    }
    clients.clear();
}
