/**
 * Filesystem boundary guard shared by recovery and promotion staging.
 *
 * Both flows must materialize privacy-sensitive bytes only in directories
 * with no version-control ancestor, so an interrupted run can never leave
 * committable content inside a worktree. This module is a leaf: importing it
 * creates no edge between recovery and promotion.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** True when any ancestor directory (including `path` itself) contains `.git`. */
export function hasGitAncestor(path: string): boolean {
    let current = resolve(path);
    for (;;) {
        if (existsSync(join(current, ".git"))) return true;
        const parent = dirname(current);
        if (parent === current) return false;
        current = parent;
    }
}
