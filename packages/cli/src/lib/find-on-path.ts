import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 *
 *
 * Minimal environments may not provide `which`.
 * Calling `execFileSync("which", ...)` fails before lookup when `which` is unavailable.
 * `process.env.PATH` and `delimiter` avoid an external lookup tool.
 *
 * Behavior notes:
 * On POSIX, `findOnPath` accepts only executable regular files.
 * On POSIX, a symlink qualifies when its target is an executable regular file.
 * On POSIX, `accessSync` evaluates execute permission for the calling process.
 *
 */
export function findOnPath(binary: string): string | null {
    const PATH = process.env.PATH;
    if (typeof PATH !== "string" || PATH.length === 0) return null;

    const isWindows = process.platform === "win32";
    const dirs = PATH.split(delimiter);

    const candidates = isWindows
        ? [`${binary}.exe`, `${binary}.cmd`, `${binary}.bat`, `${binary}.com`]
        : [binary];

    for (const dir of dirs) {
        if (!dir) continue; // empty PATH segments (rare but valid)
        for (const candidate of candidates) {
            const fullPath = join(dir, candidate);
            if (isExecutableFile(fullPath, isWindows)) return fullPath;
        }
    }
    return null;
}

export function isExecutableFile(path: string, isWindows = process.platform === "win32"): boolean {
    try {
        if (!existsSync(path)) return false;
        // `statSync` follows symlinks, so a symlink passes the regular-file check when its target is a regular file.
        const st = statSync(path);
        if (!st.isFile()) return false;
        if (isWindows) {
            // Windows skips execute-permission checks.
            return true;
        }
        accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}
