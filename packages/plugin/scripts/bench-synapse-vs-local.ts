#!/usr/bin/env bun
/**
 * This script benchmarks the default local embedding lane against Synapse over the subc daemon.
 *
 * Users invoke this script with `bun packages/plugin/scripts/bench-synapse-vs-local.ts [--n 100]`.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../src/config/schema/magic-context";
import { SynapseEmbeddingProvider } from "../src/features/magic-context/memory/embedding-synapse";
import { LocalEmbeddingProvider } from "../src/features/magic-context/memory/embedding-local";

const nIdx = process.argv.indexOf("--n");
const N = nIdx >= 0 ? Number(process.argv[nIdx + 1]) : 100;

const { Database } = await import("bun:sqlite");
const db = new Database(join(homedir(), ".local/share/cortexkit/magic-context/context.db"), {
    readonly: true,
});
const rows = db
    .query(`SELECT id, p1 FROM compartments WHERE p1 IS NOT NULL AND LENGTH(p1) > 100 ORDER BY id DESC LIMIT ${N}`)
    .all() as { id: number; p1: string }[];
db.close();
const totalChars = rows.reduce((s, r) => s + r.p1.length, 0);
console.log(`corpus: ${rows.length} compartment P1 texts, ${totalChars} chars total, avg ${(totalChars / rows.length).toFixed(0)}`);

const items = rows.map((r) => ({
    id: `compartment:${r.id}`,
    text: r.p1,
    contentSha256: new Bun.CryptoHasher("sha256").update(r.p1).digest("hex"),
}));

{
    const connectionFile = join(homedir(), ".local/share/cortexkit/run/subc-connection.json");
    const metadata = await SynapseEmbeddingProvider.discover({
        connectionFile,
        projectRoot: process.cwd(),
        session: `script:bench:${Date.now()}`,
    });
    const provider = new SynapseEmbeddingProvider({
        connectionFile,
        projectRoot: process.cwd(),
        session: `script:bench:${Date.now()}`,
        model: metadata.model,
        fingerprint: metadata.fingerprint,
        tableEpoch: metadata.table_epoch,
    });
    // The timed interval excludes the warmup embed.
    await provider.embed("warmup");
    const t = Date.now();
    const result = await provider.embedItems(items);
    const ms = Date.now() - t;
    console.log(
        `synapse (gte-modernbert-f16 @ subc): ${result.size}/${items.length} vectors in ${ms}ms  (${(ms / items.length).toFixed(1)}ms/item, ${((totalChars / 1000) / (ms / 1000)).toFixed(0)}k chars/s)`,
    );
}

{
    const provider = new LocalEmbeddingProvider();
    const warm = await provider.embed("warmup");
    if (!warm) {
        console.error("local embedding lane unavailable (onnxruntime missing?)");
        process.exit(1);
    }
    const t = Date.now();
    const vectors = await provider.embedBatch(items.map((i) => i.text));
    const ms = Date.now() - t;
    const ok = vectors.filter((v) => v !== null).length;
    console.log(
        `local (${DEFAULT_LOCAL_EMBEDDING_MODEL}): ${ok}/${items.length} vectors in ${ms}ms  (${(ms / items.length).toFixed(1)}ms/item, ${((totalChars / 1000) / (ms / 1000)).toFixed(0)}k chars/s)`,
    );
}

process.exit(0);
