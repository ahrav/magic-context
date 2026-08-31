import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function publishJsonAtomically(
    value: unknown,
    path: string,
    options?: { mode?: number },
): void {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
    writeFileSync(temp, `${JSON.stringify(value, null, 4)}\n`, {
        mode: options?.mode ?? 0o644,
    });
    renameSync(temp, path);
}
