import { McHostClient, type McHostDiagnosticsObserver } from "./client";

interface ProcessClientEntry {
    promise: Promise<McHostClient>;
    client?: McHostClient;
}

const clients = new Map<string, ProcessClientEntry>();

export interface ProcessMcHostClientOptions {
    connectionFile: string;
    diagnostics?: McHostDiagnosticsObserver;
}

/** Returns one normalized process owner for a publication path. */
export function processMcHostClient(options: ProcessMcHostClientOptions): Promise<McHostClient> {
    const key = options.connectionFile;
    const existing = clients.get(key);
    if (existing && !existing.client?.isClosed) return existing.promise;
    if (existing) clients.delete(key);
    const created = McHostClient.connect({
        connectionFile: key,
        credentialSource: process.env,
        diagnostics: options.diagnostics,
    });
    const entry: ProcessClientEntry = { promise: created };
    clients.set(key, entry);
    void created.then(
        (client) => {
            if (clients.get(key) === entry) entry.client = client;
        },
        () => {},
    );
    void created.catch(() => {
        if (clients.get(key) === entry) clients.delete(key);
    });
    return created;
}

export function resetProcessMcHostClientsForTest(): void {
    for (const { promise } of clients.values()) {
        void promise.then((value) => value.closeAsync()).catch(() => undefined);
    }
    clients.clear();
}
