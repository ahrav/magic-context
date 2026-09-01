#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dispatchCli } from "./dispatch";

/**
 *
 * Classifying an unresolvable path as `module` would make the CLI exit 0 without output.
 * An exit status of 0 with no output is indistinguishable from success to the binary's caller.
 */
type EntryKind = "entry" | "module" | "unresolved";

function classifyEntry(): EntryKind {
    const entry = process.argv[1];
    if (entry === undefined) return "module";
    const self = fileURLToPath(import.meta.url);
    // Direct invocation of this exact path needs no syscall and cannot throw.
    if (entry === self) return "entry";
    try {
        // `realpathSync.native` resolves both paths so npm bin symlinks compare equal to this module.
        return realpathSync.native(entry) === realpathSync.native(self) ? "entry" : "module";
    } catch {
        return "unresolved";
    }
}

const entryKind = classifyEntry();

if (entryKind === "unresolved") {
    // At least one path could not be resolved, so entry-ness is undecidable.
    // A removed npm bin symlink produces `unresolved`.
    // Reporting `unresolved` prevents a silent exit with status 0.
    console.error(
        `magic-context: cannot resolve the invoked path (${process.argv[1]}) to determine whether to run.`,
    );
    process.exitCode = 1;
} else if (entryKind === "entry") {
    dispatchCli()
        .then((code) => {
            process.exitCode = code;
        })
        .catch((error: unknown) => {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        });
}
