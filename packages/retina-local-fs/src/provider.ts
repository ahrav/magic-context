import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { ProviderError } from "./errors";
import { resolveAndFenceProviderPath, revalidateProviderPath } from "./path-fence";

export { ProviderError } from "./errors";
export { isFencedPath } from "./path-fence";

const execFileAsync = promisify(execFile);
const SCALAR_VERSION = 1;

interface PredicateAudit {
    /** resolved_path_exists is false when the source was relative or absent at write time. */
    resolved_path_exists?: boolean;
}

export type AtomicPredicate =
    | (PredicateAudit & { kind: "file_contains"; path: string; needle: string; absent?: boolean })
    | (PredicateAudit & { kind: "path_exists"; path: string; gone?: boolean })
    | (PredicateAudit & { kind: "mtime_after"; path: string; since_ms: number })
    | (PredicateAudit & {
          kind: "git_commit_after";
          repo_path: string;
          ref?: string;
          sha: string;
      })
    | (PredicateAudit & {
          kind: "git_tag_matching";
          repo_path: string;
          pattern: string;
          above?: string;
      });

export type ProviderConfig = AtomicPredicate | { any: readonly AtomicPredicate[] };

interface PredicateScalar {
    state: unknown;
    occurrence: number;
}

export interface ProviderScalar {
    version: 1;
    predicates: Record<string, PredicateScalar>;
}

export interface ProviderEvent {
    id: string;
    kind: AtomicPredicate["kind"];
    path: string;
    predicate: AtomicPredicate;
    observed: Record<string, unknown>;
    fired_at_ms: number;
}

export interface ProviderOutput {
    events: ProviderEvent[];
    scalar: ProviderScalar;
}

interface EvaluationOptions {
    homeDirectory?: string;
    dataDirectory?: string;
    now?: () => number;
    beforePathUseForTests?: (canonicalPath: string) => void | Promise<void>;
}

interface EvaluatedPredicate {
    state: unknown;
    occurrence: number;
    events: Array<{ marker: string; observed: Record<string, unknown> }>;
}

export async function runProvider(
    input: unknown,
    options: EvaluationOptions = {},
): Promise<ProviderOutput> {
    const { config, scalar } = parseInput(input);
    const predicates = "any" in config ? config.any : [config];
    const previous = scalar?.predicates ?? {};
    const next: ProviderScalar = { version: SCALAR_VERSION, predicates: {} };
    const events: ProviderEvent[] = [];
    const firedAt = (options.now ?? Date.now)();

    for (const [index, predicate] of predicates.entries()) {
        const predicateHash = sha256(canonicalJson(predicate));
        const scalarKey = `${index}:${predicateHash}`;
        const pathOptions = {
            allowMissing: predicate.kind === "path_exists",
            homeDirectory: options.homeDirectory,
            dataDirectory: options.dataDirectory,
        };
        const canonicalPath = await resolveAndFenceProviderPath(
            "repo_path" in predicate ? predicate.repo_path : predicate.path,
            pathOptions,
        );
        let beforePathUseForTests = options.beforePathUseForTests;
        const pathAtUse = async () => {
            const beforeUse = beforePathUseForTests;
            beforePathUseForTests = undefined;
            await beforeUse?.(canonicalPath);
            return revalidateProviderPath(canonicalPath, pathOptions);
        };
        const evaluated = await evaluatePredicate(predicate, previous[scalarKey], pathAtUse);
        next.predicates[scalarKey] = {
            state: evaluated.state,
            occurrence: evaluated.occurrence,
        };

        for (const occurrence of evaluated.events) {
            events.push({
                id: sha256(`local-fs:${canonicalPath}:${predicateHash}:${occurrence.marker}`),
                kind: predicate.kind,
                path: canonicalPath,
                predicate,
                observed: occurrence.observed,
                fired_at_ms: firedAt,
            });
        }
    }

    return { events, scalar: next };
}

async function evaluatePredicate(
    predicate: AtomicPredicate,
    previous: PredicateScalar | undefined,
    pathAtUse: () => Promise<string>,
): Promise<EvaluatedPredicate> {
    switch (predicate.kind) {
        case "file_contains": {
            const content = await readUtf8(await pathAtUse());
            const contains = content.includes(predicate.needle);
            return evaluateBooleanState(
                contains,
                predicate.absent ? !contains : contains,
                previous,
                { contains },
            );
        }
        case "path_exists": {
            const exists = await pathExists(await pathAtUse());
            return evaluateBooleanState(exists, predicate.gone ? !exists : exists, previous, {
                exists,
            });
        }
        case "mtime_after": {
            const metadata = await readableStat(await pathAtUse());
            const mtimeMs = metadata.mtimeMs;
            const changed = previous?.state !== mtimeMs;
            return {
                state: mtimeMs,
                occurrence: previous?.occurrence ?? 0,
                events:
                    mtimeMs > predicate.since_ms && changed
                        ? [{ marker: String(mtimeMs), observed: { mtime_ms: mtimeMs } }]
                        : [],
            };
        }
        case "git_commit_after": {
            const currentSha = await git(pathAtUse, [
                "rev-parse",
                "--verify",
                `${predicate.ref ?? "HEAD"}^{commit}`,
            ]);
            const baseSha = await git(pathAtUse, [
                "rev-parse",
                "--verify",
                `${predicate.sha}^{commit}`,
            ]);
            const isAfter =
                currentSha !== baseSha && (await gitIsAncestor(pathAtUse, baseSha, currentSha));
            return {
                state: currentSha,
                occurrence: previous?.occurrence ?? 0,
                events:
                    isAfter && previous?.state !== currentSha
                        ? [
                              {
                                  marker: currentSha,
                                  observed: {
                                      sha: currentSha,
                                      ref: predicate.ref ?? "HEAD",
                                      after_sha: predicate.sha,
                                  },
                              },
                          ]
                        : [],
            };
        }
        case "git_tag_matching": {
            const tagsOutput = await git(pathAtUse, ["tag", "--list", predicate.pattern]);
            const above = predicate.above ? parseSemver(predicate.above) : undefined;
            const tags = tagsOutput
                .split("\n")
                .filter(Boolean)
                .filter((tag) => {
                    if (!above) {
                        return true;
                    }
                    const version = tryParseSemver(tag);
                    return version !== null && compareSemver(version, above) > 0;
                })
                .sort();
            const previousTags = Array.isArray(previous?.state)
                ? previous.state.filter((tag): tag is string => typeof tag === "string")
                : [];
            const prior = new Set(previousTags);
            return {
                state: tags,
                occurrence: previous?.occurrence ?? 0,
                events: tags
                    .filter((tag) => !prior.has(tag))
                    .map((tag) => ({ marker: tag, observed: { tag } })),
            };
        }
    }
}

function evaluateBooleanState(
    state: boolean,
    matches: boolean,
    previous: PredicateScalar | undefined,
    observed: Record<string, unknown>,
): EvaluatedPredicate {
    const transitioned = previous === undefined || previous.state !== state;
    const occurrence =
        matches && transitioned ? (previous?.occurrence ?? 0) + 1 : (previous?.occurrence ?? 0);
    return {
        state,
        occurrence,
        events: matches && transitioned ? [{ marker: `${state}:${occurrence}`, observed }] : [],
    };
}

async function readUtf8(path: string): Promise<string> {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        throw fsError(path, error);
    }
}

async function readableStat(path: string): Promise<Awaited<ReturnType<typeof stat>>> {
    try {
        await access(path, constants.R_OK);
        return await stat(path);
    } catch (error) {
        throw fsError(path, error);
    }
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if (isMissingError(error)) {
            return false;
        }
        throw fsError(path, error);
    }
}

function fsError(path: string, error: unknown): ProviderError {
    const message = error instanceof Error ? error.message : String(error);
    return new ProviderError("unreadable_path", `Could not read ${path}: ${message}`);
}

function isMissingError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
    );
}

async function git(pathAtUse: () => Promise<string>, args: string[]): Promise<string> {
    const repoPath = await pathAtUse();
    try {
        const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
            encoding: "utf8",
            env: {
                PATH: process.env.PATH,
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_SYSTEM: "/dev/null",
                GIT_TERMINAL_PROMPT: "0",
            },
        });
        return stdout.trim();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ProviderError("git_error", `Could not inspect ${repoPath}: ${message}`);
    }
}

async function gitIsAncestor(
    pathAtUse: () => Promise<string>,
    ancestor: string,
    descendant: string,
): Promise<boolean> {
    const repoPath = await pathAtUse();
    try {
        await execFileAsync(
            "git",
            ["-C", repoPath, "merge-base", "--is-ancestor", ancestor, descendant],
            {
                env: {
                    PATH: process.env.PATH,
                    GIT_CONFIG_GLOBAL: "/dev/null",
                    GIT_CONFIG_NOSYSTEM: "1",
                    GIT_CONFIG_SYSTEM: "/dev/null",
                    GIT_TERMINAL_PROMPT: "0",
                },
            },
        );
        return true;
    } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === 1) {
            return false;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new ProviderError(
            "git_error",
            `Could not compare commits in ${repoPath}: ${message}`,
        );
    }
}

interface Semver {
    major: number;
    minor: number;
    patch: number;
    prerelease: Array<number | string>;
}

function parseSemver(value: string): Semver {
    const match =
        /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
            value,
        );
    if (!match) {
        throw new ProviderError("invalid_config", `Invalid semantic version: ${value}`);
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4]
            ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
            : [],
    };
}

function tryParseSemver(value: string): Semver | null {
    try {
        return parseSemver(value);
    } catch {
        return null;
    }
}

function compareSemver(left: Semver, right: Semver): number {
    for (const key of ["major", "minor", "patch"] as const) {
        if (left[key] !== right[key]) {
            return left[key] - right[key];
        }
    }
    if (left.prerelease.length === 0 || right.prerelease.length === 0) {
        return left.prerelease.length === right.prerelease.length
            ? 0
            : left.prerelease.length === 0
              ? 1
              : -1;
    }
    const length = Math.max(left.prerelease.length, right.prerelease.length);
    for (let index = 0; index < length; index += 1) {
        const leftPart = left.prerelease[index];
        const rightPart = right.prerelease[index];
        if (leftPart === undefined || rightPart === undefined) {
            return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
        }
        if (leftPart === rightPart) {
            continue;
        }
        if (typeof leftPart === "number" && typeof rightPart === "number") {
            return leftPart - rightPart;
        }
        if (typeof leftPart === "number") {
            return -1;
        }
        if (typeof rightPart === "number") {
            return 1;
        }
        return leftPart.localeCompare(rightPart);
    }
    return 0;
}

export type ProviderConfigValidation =
    | { success: true; config: ProviderConfig }
    | { success: false; reason: string };

/* */
export function validateProviderConfig(input: unknown): ProviderConfigValidation {
    try {
        return { success: true, config: parseConfig(input) };
    } catch (error) {
        return {
            success: false,
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}

function parseInput(input: unknown): { config: ProviderConfig; scalar: ProviderScalar | null } {
    const request = requireObject(input, "request");
    requireOnlyKeys(request, ["scalar", "config"], "request");
    if (!("scalar" in request) || !("config" in request)) {
        invalid("Request must contain scalar and config");
    }
    return {
        config: parseConfig(request.config),
        scalar: parseScalar(request.scalar),
    };
}

function parseConfig(value: unknown): ProviderConfig {
    const config = requireObject(value, "config");
    if ("any" in config) {
        requireOnlyKeys(config, ["any"], "compound config");
        if (!Array.isArray(config.any) || config.any.length < 1 || config.any.length > 4) {
            invalid("config.any must contain between 1 and 4 predicates");
        }
        return { any: config.any.map(parseAtomicPredicate) };
    }
    return parseAtomicPredicate(config);
}

function parseAtomicPredicate(value: unknown): AtomicPredicate {
    const predicate = requireObject(value, "predicate");
    if (typeof predicate.kind !== "string") {
        invalid("predicate.kind must be a string");
    }
    switch (predicate.kind) {
        case "file_contains":
            requireOnlyKeys(
                predicate,
                ["kind", "path", "needle", "absent", "resolved_path_exists"],
                predicate.kind,
            );
            return {
                kind: predicate.kind,
                path: requireString(predicate.path, "path"),
                needle: requireString(predicate.needle, "needle", true),
                ...(optionalBoolean(predicate.absent, "absent") === undefined
                    ? {}
                    : { absent: predicate.absent as boolean }),
                ...predicateAudit(predicate),
            };
        case "path_exists":
            requireOnlyKeys(
                predicate,
                ["kind", "path", "gone", "resolved_path_exists"],
                predicate.kind,
            );
            return {
                kind: predicate.kind,
                path: requireString(predicate.path, "path"),
                ...(optionalBoolean(predicate.gone, "gone") === undefined
                    ? {}
                    : { gone: predicate.gone as boolean }),
                ...predicateAudit(predicate),
            };
        case "mtime_after":
            requireOnlyKeys(
                predicate,
                ["kind", "path", "since_ms", "resolved_path_exists"],
                predicate.kind,
            );
            return {
                kind: predicate.kind,
                path: requireString(predicate.path, "path"),
                since_ms: requireFiniteNumber(predicate.since_ms, "since_ms"),
                ...predicateAudit(predicate),
            };
        case "git_commit_after":
            requireOnlyKeys(
                predicate,
                ["kind", "repo_path", "ref", "sha", "resolved_path_exists"],
                predicate.kind,
            );
            return {
                kind: predicate.kind,
                repo_path: requireString(predicate.repo_path, "repo_path"),
                sha: requireString(predicate.sha, "sha"),
                ...(predicate.ref === undefined
                    ? {}
                    : { ref: requireString(predicate.ref, "ref") }),
                ...predicateAudit(predicate),
            };
        case "git_tag_matching": {
            requireOnlyKeys(
                predicate,
                ["kind", "repo_path", "pattern", "above", "resolved_path_exists"],
                predicate.kind,
            );
            const above =
                predicate.above === undefined ? undefined : requireString(predicate.above, "above");
            if (above !== undefined) {
                parseSemver(above);
            }
            return {
                kind: predicate.kind,
                repo_path: requireString(predicate.repo_path, "repo_path"),
                pattern: requireString(predicate.pattern, "pattern"),
                ...(above === undefined ? {} : { above }),
                ...predicateAudit(predicate),
            };
        }
        default:
            invalid(`Unsupported predicate kind: ${predicate.kind}`);
    }
}

function parseScalar(value: unknown): ProviderScalar | null {
    if (value === null) {
        return null;
    }
    const scalar = requireObject(value, "scalar");
    requireOnlyKeys(scalar, ["version", "predicates"], "scalar");
    if (scalar.version !== SCALAR_VERSION) {
        invalid(`scalar.version must be ${SCALAR_VERSION}`);
    }
    const predicates = requireObject(scalar.predicates, "scalar.predicates");
    const parsed: Record<string, PredicateScalar> = {};
    for (const [key, raw] of Object.entries(predicates)) {
        const entry = requireObject(raw, `scalar.predicates.${key}`);
        requireOnlyKeys(entry, ["state", "occurrence"], `scalar.predicates.${key}`);
        if (!("state" in entry)) {
            invalid(`scalar.predicates.${key}.state is required`);
        }
        if (!Number.isSafeInteger(entry.occurrence) || (entry.occurrence as number) < 0) {
            invalid(`scalar.predicates.${key}.occurrence must be a non-negative integer`);
        }
        parsed[key] = { state: entry.state, occurrence: entry.occurrence as number };
    }
    return { version: SCALAR_VERSION, predicates: parsed };
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        invalid(`${field} must be an object`);
    }
    return value as Record<string, unknown>;
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: string[], field: string): void {
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
        invalid(`${field} contains unknown field(s): ${unknown.join(", ")}`);
    }
}

function requireString(value: unknown, field: string, allowEmpty = false): string {
    if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
        invalid(`${field} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
    }
    return value as string;
}

function predicateAudit(
    predicate: Record<string, unknown>,
): Pick<AtomicPredicate, "resolved_path_exists"> {
    const exists = optionalBoolean(predicate.resolved_path_exists, "resolved_path_exists");
    return exists === undefined ? {} : { resolved_path_exists: exists };
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
    if (value !== undefined && typeof value !== "boolean") {
        invalid(`${field} must be a boolean`);
    }
    return value as boolean | undefined;
}

function requireFiniteNumber(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        invalid(`${field} must be a finite number`);
    }
    return value;
}

function invalid(message: string): never {
    throw new ProviderError("invalid_config", message);
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (typeof value === "object" && value !== null) {
        return `{${Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}
