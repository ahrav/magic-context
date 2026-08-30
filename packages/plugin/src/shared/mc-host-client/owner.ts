import { McHostClient, type McHostClientOptions } from "./client";

const clients = new Map<string, Promise<McHostClient>>();

/** Returns the sole mc-host client owner for one process and publication path. */
export function processMcHostClient(options: McHostClientOptions): Promise<McHostClient> {
    const key = options.connectionFile;
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
