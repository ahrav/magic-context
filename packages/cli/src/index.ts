#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dispatchCli } from "./dispatch";

/**
 * Whether this module is the process entry point, and whether that is knowable.
 *
 * `unresolved` is deliberately distinct from `module`. Treating an
 * unresolvable path as "not the entry" makes the CLI exit 0 having printed
 * nothing, which is indistinguishable from success to whoever ran the binary.
 */
type EntryKind = "entry" | "module" | "unresolved";

function classifyEntry(): EntryKind {
    const entry = process.argv[1];
    if (entry === undefined) return "module";
    const self = fileURLToPath(import.meta.url);
    // Direct invocation of this exact path needs no syscall and cannot throw.
    if (entry === self) return "entry";
    try {
        // Resolve both sides so an npm-style bin symlink resolves to this file
        // instead of looking like an unrelated module.
        return realpathSync.native(entry) === realpathSync.native(self) ? "entry" : "module";
    } catch {
        return "unresolved";
    }
}

const entryKind = classifyEntry();

if (entryKind === "unresolved") {
    // Neither side of the comparison resolved, so entry-ness is undecidable —
    // an unreadable or already-removed bin path reaches here. Report it rather
    // than exiting 0 with no output.
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
