import { homedir } from "node:os";
import { join } from "node:path";

export function getOpenCodeDatabasePath(): string {
    const dataHome = process.env.XDG_DATA_HOME?.trim();
    return join(dataHome || join(homedir(), ".local", "share"), "opencode", "opencode.db");
}

/* */
export function projectPathToPiSessionSlug(
    projectPath: string,
    platform: NodeJS.Platform = process.platform,
): string {
    const separators = platform === "win32" ? /[:\\/]+/g : /\/+/g;
    const trimmed = projectPath.replace(/^[\\/]+|[\\/]+$/g, "");
    const slug = trimmed.replace(separators, "-");
    return `--${slug}--`;
}
