import { lstat, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ProviderError } from "./errors";
import { managedLayout } from "./generated-layout";

export interface ResolveProviderPathOptions {
    allowMissing: boolean;
    homeDirectory?: string;
    dataDirectory?: string;
    cwd?: string;
}

export async function resolveAndFenceProviderPath(
    configuredPath: string,
    options: ResolveProviderPathOptions,
): Promise<string> {
    const { home, dataDirectories } = await resolveFenceRoots(options);
    const expanded = configuredPath.startsWith("~/")
        ? join(home, configuredPath.slice(2))
        : configuredPath === "~"
          ? home
          : configuredPath;
    const absolute = isAbsolute(expanded)
        ? resolve(expanded)
        : resolve(options.cwd ?? process.cwd(), expanded);
    const canonical = await canonicalPath(absolute, options.allowMissing);
    if (dataDirectories.some((dataDirectory) => isFencedPath(canonical, home, dataDirectory))) {
        throw new ProviderError("fenced_path", `Refusing fenced path: ${canonical}`);
    }
    return canonical;
}

export async function revalidateProviderPath(
    canonicalPath: string,
    options: ResolveProviderPathOptions,
): Promise<string> {
    const revalidated = await resolveAndFenceProviderPath(canonicalPath, options);
    if (revalidated !== canonicalPath) {
        throw new ProviderError(
            "fenced_path",
            `Refusing path changed after fence check: ${canonicalPath}`,
        );
    }
    return revalidated;
}

async function resolveFenceRoots(
    options: ResolveProviderPathOptions,
): Promise<{ home: string; dataDirectories: string[] }> {
    // A relative or empty HOME is ignored like the daemon ignores it;
    // os.homedir() reads passwd and is always absolute.
    const configuredHomePath = resolve(
        options.homeDirectory ?? absoluteOrNull(process.env.HOME) ?? homedir(),
    );
    let home: string;
    try {
        home = await realpath(configuredHomePath);
    } catch (error) {
        throw fsError(configuredHomePath, error);
    }

    // Runtime storage is rooted at XDG_DATA_HOME, and the fence covers every
    // root a resolver may derive from it. The daemon and the lifecycle
    // resolver honor the value only when absolute and fall back to
    // $HOME/.local/share, so that root is always fenced. The plugin's storage
    // resolver accepts a raw value, so a relative XDG_DATA_HOME additionally
    // places storage writes in a cwd-relative tree — that root is fenced too
    // rather than trading one admitted managed tree for another. Each root is
    // canonicalized before checking paths, so a symlinked data directory is
    // checked by its real path.
    const configuredDataDirectories = options.dataDirectory
        ? [options.dataDirectory]
        : [
              absoluteOrNull(process.env.XDG_DATA_HOME) ?? join(home, ".local", "share"),
              ...(process.env.XDG_DATA_HOME && !isAbsolute(process.env.XDG_DATA_HOME)
                  ? [resolve(process.env.XDG_DATA_HOME)]
                  : []),
          ];
    const dataDirectories = await Promise.all(
        configuredDataDirectories.map((directory) => canonicalPath(resolve(directory), true)),
    );
    return { home, dataDirectories };
}

/** The env value participates only when it names an absolute path;
 *  relative and empty values are ignored rather than joined to cwd. */
function absoluteOrNull(value: string | undefined): string | null {
    if (!value || !isAbsolute(value)) return null;
    return value;
}

async function canonicalPath(path: string, allowMissing: boolean): Promise<string> {
    try {
        return await realpath(path);
    } catch (error) {
        if (!allowMissing || !isMissingError(error)) {
            throw fsError(path, error);
        }

        const suffix: string[] = [];
        let candidate = path;
        while (true) {
            try {
                const metadata = await lstat(candidate);
                if (metadata.isSymbolicLink()) {
                    const target = await readlink(candidate);
                    const resolvedTarget = resolve(dirname(candidate), target);
                    return canonicalPath(join(resolvedTarget, ...suffix), true);
                }
            } catch (candidateError) {
                if (!isMissingError(candidateError)) {
                    throw fsError(path, candidateError);
                }
            }

            const parent = dirname(candidate);
            if (parent === candidate) {
                throw fsError(path, error);
            }
            suffix.unshift(basename(candidate));
            candidate = parent;
            try {
                return join(await realpath(candidate), ...suffix);
            } catch (parentError) {
                if (!isMissingError(parentError)) {
                    throw fsError(path, parentError);
                }
            }
        }
    }
}

export function isFencedPath(
    canonicalPath: string,
    homeDirectory: string,
    dataDirectory = absoluteOrNull(process.env.XDG_DATA_HOME) ??
        join(resolve(homeDirectory), ".local", "share"),
): boolean {
    const cortexkitRoot = join(resolve(dataDirectory), managedLayout.managedSubtree);
    const relativeToCortexkit = relative(cortexkitRoot, canonicalPath);
    const insideCortexkit =
        relativeToCortexkit !== "" &&
        relativeToCortexkit !== ".." &&
        !relativeToCortexkit.startsWith(`..${sep}`) &&
        !isAbsolute(relativeToCortexkit);
    const parts = insideCortexkit ? relativeToCortexkit.split(sep) : [];
    const pathParts = canonicalPath.split(sep).filter(Boolean);
    const name = basename(canonicalPath);

    const catalogDirectoryCarveIn = pathParts.includes("catalog");
    const moduleBinCarveIn = parts.length >= 2 && parts[1] === "bin";
    const catalogJsonCarveIn = name.endsWith(".json") && name.includes("catalog");
    const rootWithoutCarveIns =
        insideCortexkit &&
        (parts[0] === managedLayout.runtimeDirectory ||
            parts[0] === managedLayout.storageSubdirectory);
    if (
        !rootWithoutCarveIns &&
        (catalogDirectoryCarveIn || moduleBinCarveIn || catalogJsonCarveIn)
    ) {
        return false;
    }

    const inFencedRoot =
        insideCortexkit &&
        [
            "plexus",
            "claustrum",
            "staging",
            managedLayout.runtimeDirectory,
            managedLayout.storageSubdirectory,
        ].includes(parts[0] ?? "");
    const fencedBasename = name.includes("binding-key") || name.endsWith(".handle");
    const plexusStore = insideCortexkit && parts[0] === "plexus" && name.startsWith("store.db");
    return inFencedRoot || fencedBasename || plexusStore;
}

function fsError(path: string, error: unknown): ProviderError {
    const message = error instanceof Error ? error.message : String(error);
    return new ProviderError("unreadable_path", `Could not read ${path}: ${message}`);
}

function isMissingError(error: unknown): boolean {
    return (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        ((error as { code?: unknown }).code === "ENOENT" ||
            (error as { code?: unknown }).code === "ENOTDIR")
    );
}
