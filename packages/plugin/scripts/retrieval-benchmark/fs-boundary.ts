/**
 *
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/* */
export function hasGitAncestor(path: string): boolean {
    let current = resolve(path);
    for (;;) {
        if (existsSync(join(current, ".git"))) return true;
        const parent = dirname(current);
        if (parent === current) return false;
        current = parent;
    }
}
