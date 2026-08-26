#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dispatchCli } from "./dispatch";

export { dispatchCli as main } from "./dispatch";

function isExecutableEntry(): boolean {
    const entry = process.argv[1];
    if (entry === undefined) return false;
    try {
        return realpathSync.native(entry) === realpathSync.native(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isExecutableEntry()) {
    dispatchCli()
        .then((code) => {
            process.exitCode = code;
        })
        .catch((error: unknown) => {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        });
}
