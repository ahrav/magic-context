/**
 *
 *
 *   bun crates/mc-tokenizer/gen/gen-claude-vocab.ts
 *
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

type StringEncoder = Record<string, number>;
type BinaryEncoder = Array<[Record<string, number>, number]>;

// Bun resolves bare specifiers relative to `pluginDir`.
// Resolving from `pluginDir` makes the generator independent of the current working directory.
// any cwd.
const pluginDir = join(import.meta.dir, "..", "..", "..", "packages", "plugin");
const claudeEntry = Bun.resolveSync("ai-tokenizer/encoding/claude", pluginDir);

async function main(): Promise<void> {
    const enc = (await import(claudeEntry)) as {
        stringEncoder: unknown;
        binaryEncoder: unknown;
    };
    const stringEncoder = enc.stringEncoder as StringEncoder;
    const binaryEncoder = enc.binaryEncoder as BinaryEncoder;

    const rows: Array<[string, number]> = [];

    for (const [str, rank] of Object.entries(stringEncoder)) {
        rows.push([Buffer.from(str, "utf8").toString("base64"), rank]);
    }
    for (const [obj, rank] of binaryEncoder) {
        // The byte object is { "0": b0, "1": b1, ... }; sort keys numerically so
        // the byte order is the token's real byte sequence.
        const bytes = Buffer.from(
            Object.keys(obj)
                .sort((a, b) => Number(a) - Number(b))
                .map((k) => obj[k]),
        );
        rows.push([bytes.toString("base64"), rank]);
    }

    const ranks = rows.map((r) => r[1]);
    const rankSet = new Set(ranks);
    if (rankSet.size !== ranks.length) {
        throw new Error(`duplicate ranks: ${ranks.length - rankSet.size}`);
    }
    const singleByteCovered = new Set<number>();
    for (const [b64] of rows) {
        const b = Buffer.from(b64, "base64");
        if (b.length === 1) singleByteCovered.add(b[0]);
    }
    if (singleByteCovered.size !== 256) {
        throw new Error(`missing base bytes: ${256 - singleByteCovered.size}`);
    }

    // Sorting by rank keeps regenerated assets stable and diffable.
    rows.sort((a, b) => a[1] - b[1]);

    const body = rows.map(([b64, rank]) => `${b64} ${rank}`).join("\n");
    const outPath = join(import.meta.dir, "..", "assets", "claude.tiktoken");
    writeFileSync(outPath, `${body}\n`, "utf8");

    // eslint-disable-next-line no-console
    console.log(
        `wrote ${rows.length} vocab entries (ranks ${ranks.length ? Math.min(...ranks) : 0}..${
            ranks.length ? Math.max(...ranks) : 0
        }) -> ${outPath}`,
    );
}

main();
