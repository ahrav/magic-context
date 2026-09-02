#!/usr/bin/env bun

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isWithin } from "../../plugin/src/features/magic-context/memory/verification-paths";
import { canonicalFingerprint } from "../../plugin/scripts/retrieval-benchmark/canonical-json";
import { detectOverflow } from "../../plugin/src/features/magic-context/overflow-detection";
import manifestJson from "../pools/paired-delta-manifest.json";
import policyJson from "../pools/paired-delta-policy.json";
import { ballastProse } from "../src/ballast";
import { compareCodeUnits } from "../src/code-unit-order";
import { PromptTimeoutError, TestHarness, type TestHarnessOptions } from "../src/harness";
import { MagicContextRpcClient } from "../../plugin/src/shared/rpc-client";
import { storageSubtreePath } from "../../plugin/src/shared/data-path";
import { CHARS_PER_TOKEN } from "../src/ballast";
import { goldEvidencePrompt } from "../src/oracle-arms/gold-evidence";
import {
    liveModelSpawnOptions,
    mcOffOptions,
    naiveCompactionOptions,
} from "../src/oracle-arms/presets";
import { scriptedCtxSearchTurnDetailed } from "../src/oracle-arms/scripted-ctx-search";
import {
    seedGoldMemories,
    type GoldMemoryRow,
} from "../src/oracle-arms/seed-gold-memories";
import { parsePolicyOwnerDocument } from "../src/prospective-holdout/contract";
import { pairedFactsFingerprint } from "../src/prospective-holdout/report";
import {
    MIN_BOOTSTRAP_RESAMPLES,
    estimateFamilyDeltas,
    type FamilyDeltaAnalysis,
    type FamilyDeltaObservation,
    type FamilyNoiseFloor,
} from "../src/paired-delta/estimator";
import { PLUGIN_BUNDLE_ENTRY, pluginEntryPath } from "../src/opencode-runner/spawn";
import { assertFrozenPool, buildPairedDeltaRegistry } from "../src/paired-delta/registry";
import { claimsCompletion } from "../src/paired-delta/completion-claim";
import { validSuccess } from "../src/paired-delta/scoring";
import {
    buildCalibrationRecord,
    buildPairedDeltaReport,
    calibrationNoiseFloors,
    publishCalibrationRecord,
    publishPairedDeltaReport,
    readCalibrationRecord,
} from "../src/paired-delta/report";
import {
    FileRolloutStore,
    LATE_DISPOSAL_GRACE_MS,
    ProviderUnavailableError,
    RolloutRecordsInvalidError,
    RolloutStorePublishConflictError,
    runPairedDelta,
    tokenCostUsd,
    verifyDualMockResolution,
    type PairedDeltaRunResult,
    type RolloutHandle,
    type RolloutObservation,
    type RolloutRecord,
    type RunnerDependencies,
    type TokenPrices,
} from "../src/paired-delta/runner";
import {
    ARM_IDS,
    PRIMARY_ARM_IDS,
    parsePairedDeltaManifest,
    parsePairedDeltaPolicy,
    parseScenarioDeclaration,
    r3PromptEvidence,
    type ArmId,
    type PairedDeltaPolicy,
    type ScenarioDeclaration,
} from "../src/paired-delta/contract";
import {
    r1QueryLeaksAnswer,
    r1WireDelivered,
} from "../src/paired-delta/scenarios/support";
import { stableStringify } from "../../plugin/src/shared/stable-json";
import { COMPARTMENT_AWAIT_TIMED_OUT_MARKER } from "../../plugin/src/hooks/magic-context/transform-compartment-phase";
import { CALIBRATION_SCOPE } from "../src/paired-delta/calibration-scope";

type LiveMode = "calibration" | "weekly" | "release";
type Mode = "smoke" | LiveMode;

interface CliArgs {
    mode: Mode;
    recordsPath: string;
    reportPath: string;
    calibrationRecordPath: string;
    resume: boolean;
    maxCostUsd: number | null;
    deadlineMinutes: number;
}

/** A caller keyed off the exit code has to be able to tell a budget stop from a state that forbids the obvious retry: `harness-unreclaimed` means a live harness may still be running, and `invalid-stored-records` means the records file needs inspection before any `--resume` can be trusted. commentlint: allow(JUDGE) */
const SMOKE_EXPECTED_ROLLOUTS = 11;

const EXIT_CODES: Record<PairedDeltaRunResult["status"], number> = {
    completed: 0,
    "cost-cap-reached": 1,
    "deadline-reached": 1,
    "invalid-stored-records": 2,
    "harness-unreclaimed": 3,
    /** Distinct from the budget stops because a resume that simply continues would admit arms against a `spentUsd` the failed record understates; the operator has to see the estimate stood in for a measurement. Distinct from `INSUFFICIENT_EVIDENCE_EXIT` because the workflow keys its checkpoint save on this code alone. commentlint: allow(JUDGE) */
    "usage-unmeasured": 6,
};

/** A malformed records file reached the top level as an unhandled rejection and exited 1 — the same code a cost or deadline stop uses — so automation could read a file that needs inspection as a resumable budget stop and retry it forever. Returning null asks the caller to stop after the dedicated code is set. commentlint: allow(JUDGE) */
async function runOrReportInvalidRecords(
    run: () => Promise<PairedDeltaRunResult>,
    /** Called for a publication that lost its lock: unlike a malformed file, that error follows a paid rollout whose record is not in the file, so the caller records the refusal to resume before the shared exit code is set. commentlint: allow(JUDGE) */
    onPublishConflict: () => void = () => {},
): Promise<PairedDeltaRunResult | null> {
    try {
        return await run();
    } catch (error) {
        /** A publication that lost its lock is classified with a malformed file, not with a budget stop: both mean the records path has to be inspected before any resume, and the generic code is the one automation is entitled to retry. commentlint: allow(JUDGE) */
        const inspectable = error instanceof RolloutRecordsInvalidError ||
            error instanceof RolloutStorePublishConflictError;
        if (!inspectable) throw error;
        if (error instanceof RolloutStorePublishConflictError) onPublishConflict();
        console.error(`paired-delta: ${(error as Error).message}`);
        process.exitCode = EXIT_CODES["invalid-stored-records"];
        return null;
    }
}

/** Names the filesystem type so two different non-regular entries at one path do not hash alike. commentlint: allow(JUDGE) */
function entryKind(entry: Stats): string {
    if (entry.isDirectory()) return "directory";
    if (entry.isFIFO()) return "fifo";
    if (entry.isSocket()) return "socket";
    if (entry.isBlockDevice()) return "block-device";
    if (entry.isCharacterDevice()) return "character-device";
    return "unknown";
}

function parseArgs(argv: string[]): CliArgs {
    let mode: Mode | null = null;
    let recordsPath: string | null = null;
    let reportPath: string | null = null;
    /** Relative to this file, not the working directory: the CLI runs from the repository root, where a bare `artifacts/` is unignored and its contents would enter the implementation digest. */
    const artifacts = resolve(import.meta.dir, "../artifacts");
    let calibrationRecordPath: string | null = null;
    let resume = false;
    let maxCostUsd: number | null = null;
    let deadlineMinutes: number | null = null;
    const selectMode = (next: Mode): void => {
        if (mode !== null) throw new Error("select exactly one paired-delta mode");
        mode = next;
    };
    const value = (flag: string, index: number): string => {
        const candidate = argv[index];
        if (!candidate || candidate.startsWith("-")) throw new Error(`${flag} requires a value`);
        return candidate;
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === "--smoke") selectMode("smoke");
        else if (arg === "--calibration") selectMode("calibration");
        else if (arg === "--weekly") selectMode("weekly");
        else if (arg === "--release") selectMode("release");
        else if (arg === "--resume") resume = true;
        else if (arg === "--records") recordsPath = value(arg, ++index);
        else if (arg === "--report") reportPath = value(arg, ++index);
        else if (arg === "--calibration-record") {
            calibrationRecordPath = value(arg, ++index);
        } else if (arg === "--max-cost-usd") maxCostUsd = Number(value(arg, ++index));
        else if (arg === "--deadline-minutes") deadlineMinutes = Number(value(arg, ++index));
        else throw new Error(`unknown argument: ${arg}`);
    }
    if (mode === null) {
        throw new Error("select --smoke, --calibration, --weekly, or --release");
    }
    const selected: Mode = mode;
    if (maxCostUsd !== null && (!Number.isFinite(maxCostUsd) || maxCostUsd < 0)) {
        throw new Error("--max-cost-usd expects a non-negative number");
    }
    /** The smoke lane runs against mocks in CI, so it keeps a short deadline; a live dispatch runs under the workflow's own step timeout. */
    const deadline = deadlineMinutes ?? (selected === "smoke" ? 5 : 290);
    if (!Number.isFinite(deadline) || deadline <= 0) {
        throw new Error("--deadline-minutes expects a positive number");
    }
    const stem = selected === "smoke" ? "paired-delta-smoke" : `paired-delta-${selected}`;
    const destinations = {
        records: resolve(recordsPath ?? join(artifacts, `${stem}-records.json`)),
        report: resolve(reportPath ?? join(artifacts, `${stem}-report.json`)),
        calibration: resolve(
            calibrationRecordPath ?? join(artifacts, "paired-delta-calibration.json"),
        ),
    };
    /** Publishing is atomic per path, so a shared destination silently replaces one artifact with another and the loss surfaces only on the next resume or weekly run. */
    if (new Set(Object.values(destinations)).size !== 3) {
        throw new Error(
            "paired-delta records, report, and calibration destinations must be distinct",
        );
    }
    return {
        mode: selected,
        recordsPath: destinations.records,
        reportPath: destinations.report,
        calibrationRecordPath: destinations.calibration,
        resume,
        maxCostUsd: selected === "smoke" ? maxCostUsd ?? 100 : maxCostUsd,
        deadlineMinutes: deadline,
    };
}

/** Returns the worktree-relative POSIX path, or null when the target sits outside the worktree and cannot appear in its status. `isWithin` owns the boundary test, which several e2e modules already share. commentlint: allow(JUDGE) */
function relativeTo(root: string, target: string): string | null {
    const rooted = resolve(root);
    const path = resolve(target);
    if (path === rooted || !isWithin(rooted, path)) return null;
    /** `relative` returns the platform separator, while a git pathspec always takes `/`. commentlint: allow(JUDGE) */
    return relative(rooted, path).split(sep).join("/");
}

/** A resume must not skip coordinates recorded by a different checkout: `bindingMatches` compares `repoCommit`, so a constant would let a post-change run report success without executing the changed code. commentlint: allow(JUDGE) */
/**
 * Digest the declared calibration scope from the worktree, so the binding changes when the running
 * system does and not when an unrelated commit lands.
 *
 * Tracked contents come from each path's git tree or blob object, which is content-addressed, and
 * uncommitted changes inside the scope are hashed on top so a dirty checkout is distinguished.
 */
function scopeDigest(): string {
    const root = worktreeRoot();
    const git = gitAt(root);
    const parts: Uint8Array[] = [];
    /** `rev-parse HEAD:<path>` names the tree or blob object, so unrelated commits do not move it. One invocation for the whole scope; a failure re-resolves per path only to name the untracked one. */
    const objects = Bun.spawnSync(
        ["git", "rev-parse", ...CALIBRATION_SCOPE.map((path) => `HEAD:${path}`)],
        { cwd: root },
    );
    if (objects.exitCode !== 0) {
        const untracked = CALIBRATION_SCOPE.find((path) =>
            Bun.spawnSync(["git", "rev-parse", `HEAD:${path}`], { cwd: root }).exitCode !== 0);
        throw new Error(`paired-delta calibration scope path is not tracked: ${untracked ?? "<unknown>"}`);
    }
    const objectIds = objects.stdout.toString().trim().split("\n");
    if (objectIds.length !== CALIBRATION_SCOPE.length) {
        throw new Error("paired-delta calibration scope resolved to an unexpected object count");
    }
    CALIBRATION_SCOPE.forEach((path, index) => {
        parts.push(Buffer.from(`${path}\0`, "utf8"));
        parts.push(Buffer.from(objectIds[index]!, "utf8"));
    });
    /** One pathspec-bearing invocation per command rather than one per path: the digest needs the whole scope's state, not per-path attribution. */
    const pathspecs = ["--", ...CALIBRATION_SCOPE];
    parts.push(Buffer.from(git(["status", "--porcelain", "--untracked-files=all", ...pathspecs]), "utf8"));
    parts.push(Buffer.from(git(["diff", "--binary", "HEAD", ...pathspecs]), "utf8"));
    /** `status` names an untracked file without its bytes and `diff HEAD` omits it, so scoped code importing a new file would keep one digest across edits. */
    for (const untracked of git([
        "ls-files", "--others", "--exclude-standard", "-z", ...pathspecs,
    ]).split("\0").filter(Boolean)) {
        parts.push(Buffer.from(`${untracked}\n`, "utf8"));
        try {
            const absolute = resolve(root, untracked);
            const entry = lstatSync(absolute);
            if (entry.isSymbolicLink()) {
                parts.push(Buffer.from(`<symlink>${readlinkSync(absolute)}`, "utf8"));
            } else if (!entry.isFile()) {
                parts.push(Buffer.from(`<non-file>${entryKind(entry)}`, "utf8"));
            } else {
                parts.push(readFileSync(absolute));
            }
        } catch {
            parts.push(Buffer.from("<unreadable>", "utf8"));
        }
    }
    parts.push(...executingSystemParts(root));
    return Bun.hash(Buffer.concat(parts)).toString(16);
}

/**
 * The non-git inputs that execute rollouts or read the ledger, shared by both bindings.
 *
 * Excluding a system input lets the records binding combine coordinates from different session or ledger implementations.
 * Cached process-wide because both bindings are derived several times per dispatch and these inputs do not change while the runner executes.
 */
function executingSystemParts(root: string): Uint8Array[] {
    return (executingSystemPartsCache ??= [
        ...loadedBundleParts(root),
        ...resolvedRuntimeParts(),
        ...installedDependencyParts(),
        ...hostRuntimeParts(),
    ]);
}

let executingSystemPartsCache: Uint8Array[] | null = null;

/**
 * Bun version, revision, and executable bytes bind runs to the same host runtime.
 *
 * A direct calibration runs on the host's Bun, which loads this module and its SQLite driver.
 */
function hostRuntimeParts(): Uint8Array[] {
    const parts = [
        Buffer.from(`${process.execPath}\0`, "utf8"),
        Buffer.from(`${Bun.version}\0${Bun.revision}\0`, "utf8"),
    ];
    try {
        parts.push(readFileSync(process.execPath));
    } catch {
        parts.push(Buffer.from("<unreadable>", "utf8"));
    }
    return parts;
}

/**
 * The OpenCode executable the harness will launch.
 *
 * A direct invocation resolves a bare `opencode` from `PATH`, so the workflow's pinned version says
 * nothing about it. Without this, a calibration on one binary and a weekly run on another share a
 * binding, and native compaction and the session ledger — both of which the measurement reads — are
 * that binary's behaviour.
 */
function resolvedRuntimeParts(): Uint8Array[] {
    const entry = Bun.which("opencode");
    if (entry === null) return [Buffer.from("<opencode-unresolved>", "utf8")];
    const parts = [Buffer.from(`${entry}\0`, "utf8")];
    const version = Bun.spawnSync([entry, "--version"]);
    parts.push(Buffer.from(
        version.exitCode === 0 ? version.stdout.toString().trim() : "<version-unavailable>",
        "utf8",
    ));
    try {
        /** The bytes, not only the reported version: a rebuilt binary can report the same string. */
        parts.push(readFileSync(entry));
    } catch {
        parts.push(Buffer.from("<unreadable>", "utf8"));
    }
    return parts;
}

/**
 * The installed bytes of the modules that execute rollouts and read the ledger.
 *
 * `bun.lock` and the manifests record what an install *should* produce; `node_modules` is ignored, so
 * no git-based digest sees what it actually produced. The SDK here supplies the session, prompt, and
 * message APIs the measurement is made of, so a calibration against a stale or locally patched
 * install must not share a binding with a weekly run against a different one.
 */
function installedDependencyParts(): Uint8Array[] {
    const parts: Uint8Array[] = [];
    for (const { specifier, importedFrom } of MEASUREMENT_RUNTIME_MODULES) {
        parts.push(Buffer.from(`${specifier}\0`, "utf8"));
        try {
            /** Resolved from the importing directory so the digest names the installation that run will load, not a hoisted copy elsewhere. */
            const entry = Bun.resolveSync(specifier, importedFrom());
            parts.push(Buffer.from(`${entry}\0`, "utf8"));
            /** The whole installed package, not the entry: the SDK entry is a re-export of sibling modules, so a patched client module leaves the entry bytes unchanged. */
            const root = installedPackageRoot(entry, specifier);
            for (const file of bundleFiles(root)) {
                parts.push(Buffer.from(`${relative(root, file)}\0`, "utf8"));
                /** The bytes, not the declared version: a locally patched install keeps its version string. */
                parts.push(fileDigestParts(file));
            }
        } catch (error) {
            /** Thrown, not folded into the digest: a stable error string would leave both bindings unchanged while a linked package's bytes moved. A live run that cannot name what it loads cannot bind to it. commentlint: allow(JUDGE) */
            throw new Error(
                `paired-delta cannot digest the installed ${specifier}: ` +
                `${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
            );
        }
    }
    return parts;
}

/**
 * The modules whose behaviour the measurement is made of, rather than every installed dependency.
 *
 * Each is resolved from the directory that imports it at runtime. The SDK is imported by this
 * script. `@opencode-ai/plugin` is imported by the plugin bundle, which the build leaves `--external`,
 * so the bundle bytes do not change when that installed package does even though it supplies the
 * `tool` implementation that registers `ctx_search`. commentlint: allow(JUDGE)
 */
const MEASUREMENT_RUNTIME_MODULES: readonly { specifier: string; importedFrom: () => string }[] = [
    { specifier: "@opencode-ai/sdk", importedFrom: () => import.meta.dir },
    { specifier: "@opencode-ai/plugin", importedFrom: () => dirname(pluginEntryPath()) },
];

/** Walks up from the resolved entry to the nearest directory whose `package.json` names the specifier. `Bun.resolveSync` returns the real path, so a `bun link`-ed or `file:` package sits outside any `node_modules`; matching the manifest name rather than the path finds its root too, and the whole tree is then hashed like an ordinary install. commentlint: allow(JUDGE) */
function installedPackageRoot(entry: string, specifier: string): string {
    for (let directory = dirname(entry); directory !== dirname(directory); directory = dirname(directory)) {
        const manifest = join(directory, "package.json");
        if (!existsSync(manifest)) continue;
        try {
            const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
            if (name === specifier) return directory;
        } catch {
            /** A manifest that does not parse is not this package's; keep walking. */
        }
    }
    throw new Error(`no package.json naming ${specifier} above ${entry}`);
}

/**
 * The bytes of the plugin bundle the harness will load.
 *
 * `pluginEntryPath` prefers an existing `dist` build, which is ignored, so no git-based digest can
 * see it — `--exclude-standard` skips ignored paths by design. The build runs `bun build
 * --splitting`, so the entry imports sibling chunk files and OpenCode executes those too; hashing
 * the entry alone kept one digest across a stale or edited chunk. The whole output directory is
 * hashed, which also covers the agent and config files the plugin reads from beside its code. A
 * source entry is tracked and reaches both bindings through git, so only its own bytes are added. commentlint: allow(JUDGE)
 */
function loadedBundleParts(root: string): Uint8Array[] {
    const entry = pluginEntryPath();
    const parts: Uint8Array[] = [Buffer.from(`${relative(root, entry)}\0`, "utf8")];
    const files = entry === PLUGIN_BUNDLE_ENTRY ? bundleFiles(dirname(entry)) : [entry];
    for (const file of files) {
        parts.push(Buffer.from(`${relative(root, file)}\0`, "utf8"));
        parts.push(fileDigestParts(file));
    }
    return parts;
}

/** Every regular file and symlink under the directory in code-unit order, so the digest is independent of enumeration order. A symlink is hashed as its target text by `fileDigestParts`, matching the untracked-file walk: a `bun link`-ed package retargeted at identical bytes must still move the digest. commentlint: allow(JUDGE) */
function bundleFiles(directory: string): string[] {
    return readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() || entry.isSymbolicLink())
        .map((entry) => join(entry.parentPath, entry.name))
        .sort(compareCodeUnits);
}

/** The bytes a path contributes to a digest: a symlink's target text, a regular file's contents, or a marker for anything unreadable. */
function fileDigestParts(absolute: string): Uint8Array {
    try {
        const entry = lstatSync(absolute);
        if (entry.isSymbolicLink()) return Buffer.from(`<symlink>${readlinkSync(absolute)}`, "utf8");
        if (!entry.isFile()) return Buffer.from(`<non-file>${entryKind(entry)}`, "utf8");
        return readFileSync(absolute);
    } catch {
        return Buffer.from("<unreadable>", "utf8");
    }
}

function worktreeRoot(): string {
    const started = resolve(import.meta.dir, "..");
    return gitAt(started)(["rev-parse", "--show-toplevel"]).trim();
}

function gitAt(cwd: string): (args: string[]) => string {
    return (args: string[]): string => {
        const run = Bun.spawnSync(["git", ...args], { cwd });
        if (run.exitCode !== 0) {
            throw new Error(`paired-delta cannot read the worktree: git ${args.join(" ")}`);
        }
        return run.stdout.toString();
    };
}

/** The harness drives the installed OpenCode binary, so the same checkout can produce different rollouts under a different release. `bindingMatches` compares this alongside `repoCommit`, which pins the repository but says nothing about the binary under it, so a resume across an OpenCode upgrade reuses coordinates the new release may no longer reproduce. commentlint: allow(JUDGE) */
function openCodeVersion(): string {
    /** `Bun.spawnSync` throws on an unresolvable executable rather than returning an `ENOENT` result, so a bare `opencode` on a runner that has not installed it yet escapes as a raw spawn failure and the exit-code branch below never runs. Resolving first turns that into this lane's own error. commentlint: allow(JUDGE) */
    const entry = Bun.which("opencode");
    if (entry === null) {
        throw new Error("cannot resolve OpenCode version: opencode is not on PATH");
    }
    const result = Bun.spawnSync([entry, "--version"], {
        stdout: "pipe",
        stderr: "pipe",
    });
    if (result.exitCode !== 0) {
        /** The binary resolved but would not report a version, and the reason is only in the captured stderr: without it the operator sees a bare refusal and cannot tell a broken install from a permission error. commentlint: allow(JUDGE) */
        throw new Error(
            `cannot resolve OpenCode version: ${entry} --version exited ${result.exitCode}` +
            `${stderrDetail(result.stderr)}`,
        );
    }
    return result.stdout.toString().trim();
}

function stderrDetail(stderr: Uint8Array | null): string {
    const text = stderr === null ? "" : Buffer.from(stderr).toString().trim();
    return text === "" ? "" : `: ${text.slice(-2000)}`;
}

function recordsRepoCommit(ownedPaths: readonly string[]): string {
    /** Run from the worktree root: `git ls-files --others` and the paths `git status` prints are both relative to the working directory, so a package-local cwd would miss a change made anywhere else in the repository. commentlint: allow(JUDGE) */
    const root = worktreeRoot();
    const git = gitAt(root);
    const commit = git(["rev-parse", "HEAD"]).trim();
    /** The runner writes its own records file, so hashing it would change the binding on every run and reject every completed coordinate the resume exists to reuse. commentlint: allow(JUDGE) */
    /** The store's lock file sits beside the records file and a killed run leaves it behind, so it is runner-owned output too: hashing it would reject every completed record on the resume that is about to reclaim it. commentlint: allow(JUDGE) */
    /** `publishJsonAtomically` writes through `${path}.tmp-<hex>` before renaming, so a run killed mid-write leaves one behind; the lock is a directory the next run reclaims. Both are runner-owned output, and hashing either would reject every stored coordinate. commentlint: allow(JUDGE) */
    /** A reclaimer renames a judged lock to `<lock>.reclaimed-<nonce>` and deliberately leaves it when neither restoration succeeds, so it is runner-owned residue like the lock itself; hashing it would derive a different binding than the run that wrote the records and reject every coordinate the resume exists to reuse. commentlint: allow(JUDGE) */
    const relative = (path: string): string | null => relativeTo(root, path);
    /** The exact paths are excluded as literals because they come from `--records`: a value carrying pathspec metacharacters — `artifacts/run[1].json` — would otherwise exclude unrelated matching paths, dropping their changes from the status, the diff, and the untracked hash, so a resume could reuse records produced against different working code. commentlint: allow(JUDGE) */
    const exact = ownedPaths.flatMap((path) => [path, `${path}.lock`, unmeasuredMarkerPath(path)])
        .map(relative)
        .filter((path): path is string => path !== null)
        .map((path) => `:(exclude,literal)${path}`);
    /** The suffix families need pattern meaning, so they cannot be literal; the caller-supplied prefix is escaped instead, leaving only the trailing `*` as a wildcard. commentlint: allow(JUDGE) */
    const escapeGlob = (path: string): string => path.replace(/[\\[\]*?]/g, "\\$&");
    const globbed = ownedPaths
        .flatMap((path) => [".lock.reclaimed-", ".tmp-"].map((suffix) => `${path}${suffix}`))
        .map((owned) => {
            const prefix = relative(owned);
            return prefix === null ? null : `:(exclude)${escapeGlob(prefix)}*`;
        })
        .filter((path): path is string => path !== null);
    const scope = [".", ...exact, ...globbed];
    const status = git([
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        ...scope,
    ]).trim();
    const bundle = executingSystemParts(root);
    /** A clean tree still has to account for the ignored bundle, so the digest is unconditional. */
    if (status === "") {
        return `${commit}-runtime-${Bun.hash(Buffer.concat(bundle)).toString(16)}`;
    }
    /** An uncommitted worktree shares its parent's commit, so the digest covers the working content itself: paths and status codes alone stay identical when a file's bytes change, and a resume would reuse records written before the edit. commentlint: allow(JUDGE) */
    const untracked = git(["ls-files", "--others", "--exclude-standard", "-z", "--", ...scope])
        .split("\0")
        .filter(Boolean);
    /** Untracked contents are hashed as raw bytes: decoding to UTF-8 first maps distinct binary payloads onto the same replacement character, and `git status` cannot tell them apart either while `git diff HEAD` omits untracked files entirely. commentlint: allow(JUDGE) */
    const parts: Uint8Array[] = [
        ...bundle,
        Buffer.from(status, "utf8"),
        /** `--binary` because a plain diff reduces a modified binary file to a stable `Binary files … differ` line, so its bytes could change while the digest did not. commentlint: allow(JUDGE) */
        Buffer.from(git(["diff", "--binary", "HEAD", "--", ...scope]), "utf8"),
    ];
    for (const path of untracked) {
        parts.push(Buffer.from(`${path}\n`, "utf8"));
        try {
            const absolute = resolve(root, path);
            /** A symlink's worktree identity is the text it points at, not the bytes it resolves to: following it left the digest unchanged when the same path was retargeted at another module with identical contents, so a resume could reuse records produced against different working code. `lstat` because `readFileSync` and `statSync` both dereference. commentlint: allow(JUDGE) */
            const entry = lstatSync(absolute);
            if (entry.isSymbolicLink()) {
                parts.push(Buffer.from(`<symlink>${readlinkSync(absolute)}`, "utf8"));
            } else if (!entry.isFile()) {
                /** Only a regular file has contents to hash. Opening anything else can block indefinitely — a named pipe waits for a writer — and this runs before the experiment starts, so its deadline cannot interrupt it. The type is recorded so the entry still changes the digest. commentlint: allow(JUDGE) */
                parts.push(Buffer.from(`<non-file>${entryKind(entry)}`, "utf8"));
            } else {
                parts.push(readFileSync(absolute));
            }
        } catch {
            /** An unreadable path still changes the digest through its own name. commentlint: allow(JUDGE) */
            parts.push(Buffer.from("<unreadable>", "utf8"));
        }
    }
    return `${commit}-dirty-${Bun.hash(Buffer.concat(parts)).toString(16)}`;
}

function fixtureScenario(
    scenarioId: string,
    title: string,
): ScenarioDeclaration {
    /** The declaration goes through `parseScenarioDeclaration` so the smoke exercises a scenario the paired-delta contract accepts: the evidence turn precedes the R1 insertion point, no turn from that point on repeats the answer, and one R2 claim carries it. commentlint: allow(JUDGE) */
    return parseScenarioDeclaration({
        scenarioId,
        familyId: "fam-smoke",
        title,
        expectedAnswer: "smoke-id-17",
        answerMatch: "case-insensitive",
        checks: ["check-smoke-outcome"],
        criticalCheckIds: ["check-smoke-outcome"],
        turnScript: [
            { id: "turn-smoke-evidence", role: "user", content: "Remember smoke-id-17." },
            { id: "turn-smoke-filler", role: "user", content: "Acknowledge the note." },
            { id: "turn-smoke-probe", role: "user", content: "Return the smoke identifier." },
        ],
        interventions: {
            r1: {
                insertAfterTurnId: "turn-smoke-filler",
                locatorIds: ["mem-smoke"],
            },
            r2: {
                memories: [{
                    claim: "The smoke identifier is smoke-id-17",
                    evidence: "turn-smoke-evidence",
                }],
            },
        },
        absencePrecondition: {
            evidenceTurnId: "turn-smoke-evidence",
            minimumBallastBytes: 4096 * 4,
        },
        modelContextLimit: 4096,
        restartArms: [],
        verifier: () => [],
    });
}

const SCENARIOS = [
    fixtureScenario("var-smoke-provider-error", "Provider error classification"),
    fixtureScenario("var-smoke-failing-verifier", "Failure-gated oracle replay"),
];

function smokeObservation(
    scenario: ScenarioDeclaration,
    armId: ArmId,
    baseScriptFingerprint: string,
    intervention: RolloutObservation["intervention"],
): RolloutObservation {
    const passed = armId !== "mc-on";
    return {
        checks: [{ id: "check-smoke-outcome", passed }],
        claimedDone: true,
        absencePreconditionHeld: true,
        armIdentityMatches: true,
        echoedProviderId: "mock-live",
        echoedModelId: "mock-snapshot-2026-08-31",
        usage: { input: 1000, output: 100, cacheCreation: 100, cacheRead: 100 },
        turns: scenario.turnScript.length,
        baseScriptFingerprint,
        intervention,
    };
}

/**
 * The runner's status stays `completed` through a provider-unavailable cell, a malformed
 * classification, and a ladder that never fired, because none of those are run failures. A
 * smoke gate has to assert the classifications themselves, or a regression that stops
 * scheduling the regret arms — or misreads either scripted error — still exits zero.
 *
 * A resumed run rehydrates instead of re-executing, so only the counts that survive a resume
 * are asserted then.
 */
function smokeExpectationDrift(
    summary: {
        rolloutCount: number;
        providerCalls: Record<string, number>;
        completeRegretLadders: number;
        partialRegretLadders: number;
        exclusionCounts: PairedDeltaRunResult["exclusionCounts"];
        invalidStoredCoordinates: readonly unknown[];
    },
    args: CliArgs,
): string[] {
    const drift: string[] = [];
    /** Keys are sorted before comparing: `exclusionCounts` and `providerCalls` are built in iteration order, so a change in arm scheduling or route resolution would otherwise report drift for identical content. `stableStringify` is the shared implementation of that ordering, so a fix to its edge cases reaches this comparison too. commentlint: allow(JUDGE) */
    const canonical = stableStringify;
    const expect = (label: string, actual: unknown, expected: unknown): void => {
        const shown = canonical(actual);
        const wanted = canonical(expected);
        if (shown !== wanted) drift.push(`${label}: expected ${wanted}, observed ${shown}`);
    };
    expect("rolloutCount", summary.rolloutCount, SMOKE_EXPECTED_ROLLOUTS);
    expect("invalidStoredCoordinates", summary.invalidStoredCoordinates.length, 0);
    /** `smokeObservation` fails mc-on's critical check in both scenarios, so both fire the ladder. `var-smoke-provider-error` loses only mc-off, leaving r1/r2/r3 to complete one full ladder; `var-smoke-failing-verifier` loses r2, so its ladder carries retrieval and stops. commentlint: allow(JUDGE) */
    expect("completeRegretLadders", summary.completeRegretLadders, 1);
    expect("partialRegretLadders", summary.partialRegretLadders, 1);
    expect("exclusionCounts", summary.exclusionCounts, {
        "mc-off": { "provider-unavailable": 1 },
        r2: { "provider-unavailable": 1 },
    });
    if (!args.resume) {
        /** Both routes must resolve independently, so each is prompted exactly once. commentlint: allow(JUDGE) */
        expect("providerCalls", summary.providerCalls, { "mock-anthropic": 1, "mock-live": 1 });
    }
    return drift;
}

async function runSmoke(args: CliArgs): Promise<void> {
    const providerCalls = new Map<string, number>();
    await verifyDualMockResolution({
        liveProviderId: "mock-live",
        liveModelId: "mock-snapshot-2026-08-31",
        modelContextLimit: 4096,
        async sendPrompt(route) {
            providerCalls.set(route.providerId, (providerCalls.get(route.providerId) ?? 0) + 1);
            return {
                ...route,
                contextLimit: route.providerId === "mock-live" ? 4096 : 200_000,
            };
        },
    });

    const result = await runOrReportInvalidRecords(() => runPairedDelta(
        {
            scenarios: SCENARIOS,
            poolManifestFingerprint: "smoke-pool-v1",
            repoCommit: recordsRepoCommit([args.recordsPath, args.reportPath, args.calibrationRecordPath]),
            /** The smoke lane answers prompts from an in-process mock and never launches the installed binary, so it pins a literal beside its other mock identities rather than binding to whatever release happens to be on PATH. commentlint: allow(JUDGE) */
            openCodeVersion: "mock-opencode",
            pinnedProviderId: "mock-live",
            pinnedSnapshotId: "mock-snapshot-2026-08-31",
            replicateCount: 1,
            deskCostCeilingUsd: 0.01,
            maxCostUsd: args.maxCostUsd ?? 100,
            deadlineEpochMs: Date.now() + args.deadlineMinutes * 60_000,
            pricesPerMillionTokens: {
                input: 3,
                output: 15,
                cacheCreation: 3.75,
                cacheRead: 0.3,
            },
            resume: args.resume,
            store: new FileRolloutStore(args.recordsPath),
        },
        {
            now: Date.now,
            async createRollout({
                scenario,
                coordinate,
                baseScriptFingerprint,
                intervention,
            }) {
                return {
                    async prepare() {},
                    async run() {
                        if (
                            scenario.scenarioId === "var-smoke-provider-error" &&
                            coordinate.armId === "mc-off"
                        ) {
                            throw new ProviderUnavailableError("scripted mock provider error");
                        }
                        if (
                            scenario.scenarioId === "var-smoke-failing-verifier" &&
                            coordinate.armId === "r2"
                        ) {
                            throw new ProviderUnavailableError("scripted mock R2 error");
                        }
                        return smokeObservation(
                            scenario,
                            coordinate.armId,
                            baseScriptFingerprint,
                            intervention,
                        );
                    },
                    async dispose() {},
                };
            },
        },
    ));
    if (result === null) return;

    const summary = {
        status: result.status,
        recordsPath: args.recordsPath,
        rolloutCount: result.records.length,
        providerCalls: Object.fromEntries(providerCalls),
        invalidStoredCoordinates: result.invalidStoredCoordinates,
        completeRegretLadders: result.coordinates.filter(({ regret }) =>
            regret?.retrieval !== undefined &&
            regret.formation !== undefined &&
            regret.representation !== undefined).length,
        partialRegretLadders: result.coordinates.filter(({ regret }) =>
            regret !== null &&
            (regret.formation === undefined || regret.representation === undefined)).length,
        exclusionCounts: result.exclusionCounts,
    };
    console.log(JSON.stringify(summary, null, 2));
    const drift = smokeExpectationDrift(summary, args);
    for (const line of drift) console.error(`smoke expectation: ${line}`);
    /** A non-completed status outranks drift, because `harness-unreclaimed` means a live harness may still be running and a caller keyed on that code must not lose it: drift gets its own code only when the status itself reports success. commentlint: allow(JUDGE) */
    if (result.status !== "completed") {
        process.exitCode = EXIT_CODES[result.status];
        return;
    }
    if (drift.length > 0) {
        process.exitCode = 4;
        return;
    }
    process.exitCode = EXIT_CODES[result.status];
}


function scenarioIdsForMode(
    manifest: ReturnType<typeof parsePairedDeltaManifest>,
    mode: LiveMode,
): Set<string> {
    return new Set(
        manifest.scenarios
            .filter(({ runModes }) => runModes.includes(mode))
            .map(({ scenarioId }) => scenarioId),
    );
}

const POLICY_OWNER = "magic-context-x4l.14";

/**
 * Paths whose contents decide whether calibration evidence still describes the running system.
 *
 * Binding calibration to the commit broke the schedule: any later commit on the default branch, an
 * unrelated documentation change included, invalidated the record and left weekly and release
 * refusing until someone re-dispatched calibration at that exact revision. A declared scope keeps
 * the binding meaningful — a plugin, harness, oracle, or lane change still invalidates it — without
 * tying it to commits that cannot affect the measurement. The workflow's cache key hashes the same
 * globs, so a scope change misses the cache rather than restoring a record the runner will reject.
 */

function lanePolicy(document: ReturnType<typeof parsePolicyOwnerDocument>): PairedDeltaPolicy {
    if (document.status !== "ready" || document.policy === null) {
        throw new Error("paired-delta policy is not ready");
    }
    return parsePairedDeltaPolicy(document.policy);
}

function mergeHarnessOptions(
    live: TestHarnessOptions,
    arm: TestHarnessOptions,
    modelContextLimit: number,
): TestHarnessOptions {
    return {
        ...live,
        ...arm,
        modelContextLimit,
        openCodeConfigExtra: {
            ...(live.openCodeConfigExtra ?? {}),
            ...(arm.openCodeConfigExtra ?? {}),
            provider: live.openCodeConfigExtra?.provider,
        },
    };
}

interface PromptResult {
    /** The assistant message the prompt produced, which the session ledger must later list. */
    messageId: string;
    providerId: string;
    modelId: string;
    usage: RolloutObservation["usage"];
    text: string;
    error: unknown;
}

function parsePromptResult(raw: unknown): PromptResult {
    const data = (raw as { data?: unknown } | null)?.data as {
        info?: {
            id?: unknown;
            providerID?: unknown;
            modelID?: unknown;
            error?: unknown;
            tokens?: {
                input?: unknown;
                output?: unknown;
                cache?: { write?: unknown; read?: unknown };
            };
        };
        parts?: Array<{ type?: unknown; text?: unknown }>;
    } | undefined;
    const info = data?.info;
    if (
        typeof info?.id !== "string" ||
        info.id === "" ||
        typeof info.providerID !== "string" ||
        typeof info.modelID !== "string" ||
        typeof info.tokens?.input !== "number" ||
        typeof info.tokens.output !== "number" ||
        typeof info.tokens.cache?.write !== "number" ||
        typeof info.tokens.cache.read !== "number"
    ) {
        throw new Error("live prompt returned malformed assistant metadata");
    }
    return {
        messageId: info.id,
        providerId: info.providerID,
        modelId: info.modelID,
        usage: {
            input: info.tokens.input,
            output: info.tokens.output,
            cacheCreation: info.tokens.cache.write,
            cacheRead: info.tokens.cache.read,
        },
        text: (data?.parts ?? [])
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text as string)
            .join("\n"),
        /** A successful assistant turn carries `error: null`, matching the plugin's own readers, so absence is tested against null rather than undefined. */
        error: info.error ?? null,
    };
}

function armOptions(
    apiKey: string,
    providerId: string,
    modelId: string,
    scenario: ScenarioDeclaration,
    armId: ArmId,
    /** Pinned per rollout so `historianAbandoned` reads this rollout's diagnostics and no other's. */
    logPath: string,
): TestHarnessOptions {
    const live = liveModelSpawnOptions({
        apiKey,
        providerBlock: {
            [providerId]: {
                api: "@ai-sdk/anthropic",
                name: "Pinned Anthropic",
                /** `api` does not name the package OpenCode loads for a configured provider; the package README's live recipe and the dreamer runner both declare it. */
                npm: "@ai-sdk/anthropic",
                env: ["ANTHROPIC_API_KEY"],
                models: {
                    [modelId]: {
                        name: modelId,
                        limit: { context: scenario.modelContextLimit },
                    },
                },
            },
        },
    });
    live.extraEnv = { ...live.extraEnv, MAGIC_CONTEXT_LOG_PATH: logPath };
    const arm = armId === "mc-off"
        ? mcOffOptions()
        : armId === "compaction"
            ? naiveCompactionOptions()
            /**
             * The historian deletes its child session on success, which erases the only record of a
             * model call the cap has to charge and the identity gate has to route-check. Retaining
             * the child keeps it in the session tree the rollout prices from; it changes cleanup,
             * not compaction behaviour.
             */
            : { magicContextConfig: { keep_subagents: true } };
    return mergeHarnessOptions(live, arm, scenario.modelContextLimit);
}

interface SessionUsage {
    usage: RolloutObservation["usage"];
    offPinRoute: { providerId: string; modelId: string } | null;
    /** Fixture-served assistant entries seen. R1 schedules exactly `SCRIPTED_ORACLE_MOCK_ENTRIES`; a shortfall is a scripted turn that did not land, and the ledger is not an R1 ledger. */
    mockEntries: number;
    /** `{ id, parentID }` of every fixture-served assistant entry, so the caller can tie each one to the scripted turn rather than count them: a missing scripted row and a stray live child on the fixture cancel in a count. */
    mockRows: { id: string; parentId: string | null }[];
    /** Ids of every priced assistant entry, so the caller can check that each response it was handed is in the ledger it is charging from. */
    messageIds: Set<string>;
}

const ZERO_USAGE = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

/** `scriptedCtxSearchTurn` drives one tool-use response and one follow-up, both served by the fixture provider. */
const SCRIPTED_ORACLE_MOCK_ENTRIES = 2;

/**
 * Whether the fixture-served ledger rows are exactly the scripted turn's.
 *
 * Both rows of the scripted turn descend from the one user message that turn sent, so they share the
 * closing assistant message's `parentID`. Requiring every fixture row to carry that parent, and
 * exactly the scheduled number of them, ties the rows to the turn: a count alone lets a missing
 * scripted row and a stray live child that routed to the fixture cancel out. An arm without a
 * scripted turn must have no fixture rows at all. commentlint: allow(JUDGE)
 */
function scriptedRowsMatch(
    mockRows: SessionUsage["mockRows"],
    scriptedTurnText: string | undefined,
    scriptedAssistantMessageId: string | null,
): boolean {
    if (scriptedTurnText === undefined) return mockRows.length === 0;
    if (scriptedAssistantMessageId === null) return false;
    const closing = mockRows.find(({ id }) => id === scriptedAssistantMessageId);
    if (closing === undefined || closing.parentId === null) return false;
    return mockRows.length === SCRIPTED_ORACLE_MOCK_ENTRIES &&
        mockRows.every(({ parentId }) => parentId === closing.parentId);
}

/** Bounds the quiescence wait. Generous enough for a historian retry to land, short enough that a stuck session fails rather than holding the run. */
const LEDGER_SETTLE_ATTEMPTS = 12;
const LEDGER_SETTLE_INTERVAL_MS = 500;

/**
 * The failure path's budget, sized to leave room inside `LATE_DISPOSAL_GRACE_MS` for the reads.
 *
 * Half the grace goes to sleeping and half to the API calls between sleeps. Exceeding the grace is
 * safe — the runner falls back to the worst-case bound — but it would discard the measurement on
 * every failure, and the historian's retry tree is exactly what the bound cannot cover.
 */
const LEDGER_SETTLE_ATTEMPTS_ON_FAILURE = Math.max(
    2,
    Math.floor(LATE_DISPOSAL_GRACE_MS / 2 / LEDGER_SETTLE_INTERVAL_MS),
);

/** How long the failure read waits for an interrupted prompt before pricing without its row. Sized so one ledger read still fits inside the grace after the wait. */
const IN_FLIGHT_PROMPT_WAIT_MS = Math.floor(LATE_DISPOSAL_GRACE_MS / 2);

function addUsage(
    left: RolloutObservation["usage"],
    right: RolloutObservation["usage"],
): RolloutObservation["usage"] {
    const sum = {
        input: left.input + right.input,
        output: left.output + right.output,
        cacheCreation: left.cacheCreation + right.cacheCreation,
        cacheRead: left.cacheRead + right.cacheRead,
    };
    /** Each row is a safe integer; their sum need not be. An unsafe aggregate would be nulled downstream and priced from the estimate with the cell still completed, so it is a ledger the rollout cannot be priced from. commentlint: allow(JUDGE) */
    if (!Object.values(sum).every((count) => Number.isSafeInteger(count))) {
        throw new Error("live paired-delta session ledger totals exceed the safe integer range");
    }
    return sum;
}

interface LedgerMessage {
    id?: unknown;
    parentID?: unknown;
    role?: unknown;
    providerID?: unknown;
    modelID?: unknown;
    tokens?: {
        input?: unknown;
        output?: unknown;
        cache?: { write?: unknown; read?: unknown };
    };
}

/**
 * Rows of a session's message ledger.
 *
 * A missing or non-array `data` is treated as a failure rather than an empty ledger: read as zero it
 * would publish a completed cell with no spend and hide an off-pin historian or compaction call, so
 * the rollout would look cheap and clean precisely when the ledger could not be read.
 */
function ledgerEntries(payload: unknown): LedgerMessage[] {
    const rows = (payload as { data?: unknown } | null)?.data;
    if (!Array.isArray(rows)) {
        throw new Error("live paired-delta received no session ledger to price the rollout from");
    }
    return rows
        .map((row) => {
            const info = (row as { info?: LedgerMessage } | null)?.info;
            /** A row with no `info` object is a malformed ledger, not a message to skip: dropped, it takes a billed call and its route with it. */
            if (info === null || info === undefined || typeof info !== "object") {
                throw new Error("live paired-delta session ledger has a row with no message");
            }
            return info;
        })
        /** A user turn carries no route and nothing to price; an assistant turn missing its route is an incomplete ledger, so it is rejected rather than filtered away with the user rows. */
        .filter((info) => info.role !== "user")
        .map((info) => {
            if (typeof info.providerID !== "string" || info.providerID === "") {
                throw new Error(
                    "live paired-delta session ledger has an assistant entry with no route",
                );
            }
            return info;
        });
}

/**
 * Total the model calls OpenCode itself recorded for a session and its children, rather than only the prompts this runner issued.
 *
 * Native compaction on the `compaction` arm and the historian on the plugin arms both call a model
 * without appearing among the authored responses, so a reducer over those responses understated
 * `usage`, and therefore `costUsd`, `spentUsd`, and the reserve the cap checks before the next arm.
 * Reading OpenCode's own ledger also removes any dependence on the plugin recording its own
 * accounting, which it does on a best-effort path.
 *
 * The mock-served R1 oracle turn is not billed, because pricing it as live spend would overstate
 * the cap. Every other call is billed whatever route served it, including a fallback to another
 * snapshot, which is real money the cap has to see; the route is reported separately so the
 * runner's identity comparison still excludes the cell.
 */
/**
 * Whether the plugin gave up waiting for a historian and resumed the parent with it still running.
 *
 * `awaitCompartmentRun` logs this exact line when its `historianTimeoutMs` race elapses, which is the
 * one moment a background call can outlive the response. Quiescence cannot be inferred from the
 * ledger in that case: an in-flight request adds no row while it runs, so any finite stable interval
 * can elapse mid-call. This is the explicit signal, so the cell is rejected rather than priced from a
 * ledger that is still being written. The signal is best-effort on the plugin side — the logger drops
 * lines under `NODE_ENV=test` and swallows append errors — so its absence is only evidence when the
 * log shows the plugin was writing for this session at all.
 */
function historianState(
    logPath: string,
    sessionId: string,
    pluginBacked: boolean,
): "clear" | "abandoned" | "unobservable" {
    /** With the plugin disabled there is no historian to abandon and no log to expect. */
    if (!pluginBacked) return "clear";
    if (!existsSync(logPath)) return "unobservable";
    const lines = readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.includes(`[${sessionId}]`));
    /** The plugin logs every transform pass for a session it processed, so a session with no lines at all is diagnostics that were never written — silenced by `NODE_ENV=test`, or a swallowed append error — not a session with nothing to report. The marker cannot be trusted absent from a log that was never written. commentlint: allow(JUDGE) */
    if (lines.length === 0) return "unobservable";
    return lines.some((line) => line.includes(COMPARTMENT_AWAIT_TIMED_OUT_MARKER))
        ? "abandoned"
        : "clear";
}

/**
 * Whether the plugin has dropped any log write in this process.
 *
 * The logger clears its buffer before `appendFileSync` and swallows the error, so a disk-full or
 * permission failure can discard exactly the flush carrying the timeout marker while every earlier
 * line for the session survives. The dropped count is exposed over the plugin's local RPC, so a
 * clean-looking log is trusted only when the plugin confirms it dropped nothing. Unreachable RPC
 * reads as dropped: the check exists to fail closed. commentlint: allow(JUDGE)
 */
async function pluginDroppedLogWrites(harness: TestHarness, sessionId: string): Promise<boolean> {
    try {
        const client = new MagicContextRpcClient(
            storageSubtreePath(harness.opencode.env.dataDir),
            harness.opencode.env.workdir,
        );
        const detail = await client.call<{
            error?: unknown;
            loggerDiagnostics?: { swallowedWriteCount?: unknown };
        }>("status-detail", { sessionId, directory: harness.opencode.env.workdir });
        if (detail.error !== undefined) return true;
        const swallowed = detail.loggerDiagnostics?.swallowedWriteCount;
        return typeof swallowed !== "number" || swallowed > 0;
    } catch {
        return true;
    }
}

/**
 * Read the ledger until two consecutive passes agree, so a call still running is not missed.
 *
 * The plugin resumes the parent prompt when the historian exceeds its pressure wait, so a child call
 * can finish or retry after the final parent response. Nothing in the schema exposes an in-flight
 * invocation — `recordChildInvocation` writes one row with a terminal status when the call ends — so
 * quiescence is observed rather than queried.
 *
 * Scored rollouts reject an incomplete ledger because in-flight calls can change billed usage.
 * Failed rollouts charge it: each row is a call the provider already billed, the runner takes the larger of this and its worst-case bound, and rejecting would fall back to a bound the historian's retry tree exceeds. commentlint: allow(JUDGE)
 */
async function settledSessionUsage(
    harness: TestHarness,
    sessionId: string,
    pinned: { providerId: string; modelId: string },
    expectedMockEntries: number,
    logPath: string,
    /** Whether the arm runs the plugin, and so can have a historian and must have written its log. */
    pluginBacked: boolean,
    settle: {
        /** Smaller on the failure path, which runs inside `LATE_DISPOSAL_GRACE_MS`; a settle that outlasts the grace is cut off every time and measures nothing. */
        attempts: number;
        incomplete: "reject" | "charge";
    } = { attempts: LEDGER_SETTLE_ATTEMPTS, incomplete: "reject" },
): Promise<SessionUsage & { settled: boolean }> {
    let previous: string | null = null;
    let last: SessionUsage | null = null;
    let state: ReturnType<typeof historianState> = "unobservable";
    for (let attempt = 0; attempt < settle.attempts; attempt++) {
        /** Checked every pass, not once: the plugin buffers its log for 500 ms, so the marker — or the first line for the session — can appear after the first read. */
        state = historianState(logPath, sessionId, pluginBacked);
        if (state === "abandoned" && settle.incomplete === "reject") {
            throw new Error(
                "live paired-delta cannot price this rollout: the plugin resumed the parent with " +
                "a historian still running, so the ledger is incomplete by construction",
            );
        }
        const reading = await sessionUsage(harness, sessionId, pinned, expectedMockEntries);
        const signature = JSON.stringify(reading);
        /** Two agreeing reads settle only a ledger whose historian is known clear: a running historian can append rows after them, and an unobservable log cannot say one is not running. Charged incomplete ledgers wait for all attempts. commentlint: allow(JUDGE) */
        if (signature === previous && state === "clear") {
            /** A clean log is only evidence when nothing was dropped from it; a swallowed flush could be the marker. Checked once, at the point of trusting the log, rather than every pass. commentlint: allow(JUDGE) */
            if (pluginBacked && await pluginDroppedLogWrites(harness, sessionId)) {
                state = "unobservable";
                previous = signature;
                last = reading;
                await Bun.sleep(LEDGER_SETTLE_INTERVAL_MS);
                continue;
            }
            return { ...reading, settled: true };
        }
        previous = signature;
        last = reading;
        await Bun.sleep(LEDGER_SETTLE_INTERVAL_MS);
    }
    /** What landed is charged, and the caller is told it is not the whole bill: an abandoned or unobservable historian may still be running, and a clear ledger that never repeated itself was still moving. commentlint: allow(JUDGE) */
    if (settle.incomplete === "charge" && last !== null) return { ...last, settled: false };
    if (state === "unobservable") {
        throw new Error(
            "live paired-delta cannot price this rollout: the plugin wrote no diagnostics for the " +
            `session at ${logPath}, so an abandoned historian cannot be ruled out`,
        );
    }
    throw new Error(
        `live paired-delta session ledger did not settle within ` +
        `${settle.attempts} reads; a background call may still be running`,
    );
}

async function sessionUsage(
    harness: TestHarness,
    sessionId: string,
    pinned: { providerId: string; modelId: string },
    /** How many fixture-served entries the arm scheduled. R1's scripted `ctx_search` turn makes exactly two: the tool-use response and its follow-up. */
    expectedMockEntries: number,
): Promise<SessionUsage> {
    let usage = ZERO_USAGE;
    let offPinRoute: SessionUsage["offPinRoute"] = null;
    let mockEntries = 0;
    const mockRows: SessionUsage["mockRows"] = [];
    const messageIds = new Set<string>();
    let frontier = [sessionId];
    const seen = new Set<string>();
    while (frontier.length > 0) {
        const level = frontier.filter((id) => !seen.has(id));
        for (const id of level) seen.add(id);
        /** Siblings are independent, and this runs on the paid critical path, so a level is fetched at once rather than one session per round trip. */
        const fetched = await Promise.all(level.map(async (id) => ({
            messages: await harness.client.session.messages({ path: { id } }),
            children: await harness.client.session.children({ path: { id } }),
        })));
        frontier = [];
        for (const { messages, children } of fetched) {
        for (const info of ledgerEntries(messages)) {
            /** An assistant entry without an id cannot be reconciled against the responses the rollout received, so the ledger is incomplete rather than merely anonymous. */
            if (typeof info.id !== "string" || info.id === "") {
                throw new Error("live paired-delta session ledger has an assistant entry with no id");
            }
            messageIds.add(info.id);
            const route = {
                providerId: info.providerID as string,
                modelId: typeof info.modelID === "string" ? info.modelID : "",
            };
            const tokens = info.tokens;
            /** An assistant entry names a route, so absent counters are an incomplete ledger rather than a message with nothing to price. */
            /** Safe non-negative integers, not merely numbers: a `NaN`, negative, or fractional counter would price to a value `completedRecord` nulls and replaces with the estimate while the status stays `completed`, admitting later arms against it. commentlint: allow(JUDGE) */
            if (
                ![tokens?.input, tokens?.output, tokens?.cache?.write, tokens?.cache?.read]
                    .every((count) => Number.isSafeInteger(count) && (count as number) >= 0)
            ) {
                throw new Error(
                    `live paired-delta session ledger entry from ${route.providerId} carries ` +
                    "malformed token counters",
                );
            }
            const counters = tokens as {
                input: number;
                output: number;
                cache: { write: number; read: number };
            };
            const spent = {
                input: counters.input,
                output: counters.output,
                cacheCreation: counters.cache.write,
                cacheRead: counters.cache.read,
            };
            /**
             * Only R1's scripted `ctx_search` turn is served by the fixture provider by design.
             * A blanket exemption would let a historian or native-compaction child call that
             * accidentally routed to the mock pass the identity gate and enter the experiment as
             * live evidence, since the authored-response scan cannot see a child call.
             */
            if (route.providerId === "mock-anthropic") {
                mockEntries += 1;
                mockRows.push({
                    id: info.id,
                    parentId: typeof info.parentID === "string" ? info.parentID : null,
                });
                /** Counted rather than allowed by arm: an extra fixture-served entry — a historian or compaction call that routed to the mock — is an identity failure even on R1. */
                if (mockEntries > expectedMockEntries && offPinRoute === null) {
                    offPinRoute = route;
                }
                continue;
            }
            if (route.providerId !== pinned.providerId || route.modelId !== pinned.modelId) {
                if (offPinRoute === null) offPinRoute = route;
                /**
                 * The cell's evidence is rejected, but the call was billed, so it is charged: a
                 * fallback to another snapshot is real money and the cap has to see it.
                 */
                usage = addUsage(usage, spent);
                continue;
            }
            usage = addUsage(usage, spent);
        }
        const rows = (children as { data?: unknown }).data;
        if (!Array.isArray(rows)) {
            throw new Error("live paired-delta could not enumerate the session's children");
        }
        for (const child of rows) {
            const childId = (child as { id?: unknown } | null)?.id;
            /** A child without a usable id may hold a billed historian call, so a partial session tree is a failure rather than a smaller walk. */
            if (typeof childId !== "string" || childId === "") {
                throw new Error("live paired-delta session tree has a child with no id");
            }
            frontier.push(childId);
        }
        }
    }
    return { usage, offPinRoute, mockEntries, mockRows, messageIds };
}

/**
 * A row the plugin wrote for this session, which the harness cannot have precreated.
 *
 * `spawnOpencode` initializes `context.db` before the server starts for every arm without native
 * compaction, so file existence proves only that the schema was installed. `session_meta` is keyed
 * by a session id generated at runtime and written by the tagger as the plugin processes the
 * session, so its presence is evidence the treatment actually ran.
 */
/**
 * Whether the plugin ran for this session, and — when the arm's intervention is memory — delivered it.
 *
 * A `session_meta` row proves the plugin saw the session, not that anything reached the prompt.
 * `memory_block_ids` can include project memory from earlier turns; required seeded locators prove delivery.
 */
function pluginProcessedSession(
    harness: TestHarness,
    sessionId: string,
    /** The seeded revision locators the arm must have rendered, or `null` when the arm's intervention is not the seeded memory set. */
    requiredLocators: readonly string[] | null,
): boolean {
    if (!harness.hasContextDb()) return false;
    try {
        const row = harness.contextDb()
            .prepare("SELECT memory_block_ids FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { memory_block_ids: string | null } | null;
        if (row === null) return false;
        if (requiredLocators === null) return true;
        /** An empty requirement is a seeding that produced nothing, not an intervention that needs no evidence. */
        if (requiredLocators.length === 0) return false;
        const rendered = parseRenderedLocators(row.memory_block_ids);
        return requiredLocators.every((locator) => rendered.has(locator));
    } catch {
        return false;
    }
}

/** Absent or non-array `memory_block_ids` yields no locators, so required locator checks fail. */
function parseRenderedLocators(raw: string | null): Set<string> {
    if (raw === null) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
}

function configMatchesArm(
    harness: TestHarness,
    armId: ArmId,
    providerId: string,
    modelId: string,
    modelContextLimit: number,
    apiKey: string,
): boolean {
    const text = readFileSync(join(harness.opencode.env.configDir, "opencode.json"), "utf8");
    /**
     * Thrown rather than reported as a mismatch: the recipe references the credential through
     * `env: ["ANTHROPIC_API_KEY"]`, so finding it inlined means a live secret was persisted to the
     * harness workdir. Folded into `arm-identity-mismatch` it would have looked like config drift in
     * the exclusion counts, with nothing pointing at the credential.
     */
    if (text.includes(apiKey)) {
        throw new Error(
            "live paired-delta found the provider credential in the on-disk config; " +
            "the spawn recipe must reference it through the environment",
        );
    }
    const config = JSON.parse(text) as {
        plugin?: unknown;
        compaction?: unknown;
        provider?: Record<string, {
            models?: Record<string, { limit?: { context?: number } }>;
        }>;
    };
    const providersMatch =
        config.provider?.["mock-anthropic"] !== undefined &&
        config.provider?.[providerId]?.models?.[modelId]?.limit?.context === modelContextLimit;
    if (!providersMatch) return false;
    if (armId === "mc-off") return Array.isArray(config.plugin) && config.plugin.length === 0;
    if (armId === "compaction") {
        return canonicalFingerprint(config.compaction) === canonicalFingerprint(
            naiveCompactionOptions().openCodeConfigExtra?.compaction,
        );
    }
    return Array.isArray(config.plugin) && config.plugin.length > 0;
}

/**
 * A live handle must account for what it billed. `usageOnFailure` is optional on the runner's
 * interface because the scripted and mock handles bill nothing, so for them the estimate is exact;
 * a live handle without it would price every failure from a bound the historian's retry tree can
 * exceed, and the runner cannot tell the two apart at runtime. commentlint: allow(JUDGE)
 */
type LiveRolloutHandle = RolloutHandle & Required<Pick<RolloutHandle, "usageOnFailure">>;

export function createLiveDependencies(input: {
    apiKey: string;
    providerId: string;
    modelId: string;
}): RunnerDependencies {
    return {
        now: Date.now,
        async createRollout({
            scenario,
            coordinate,
            baseScriptFingerprint: expectedFingerprint,
            intervention,
        }): Promise<LiveRolloutHandle> {
            /** Resolved from this file, matching `resolvePaths`, so the log never lands in the repository root where it would enter the implementation digest. */
            const logPath = resolve(
                import.meta.dir,
                "../artifacts/live-logs",
                `${coordinate.scenarioId}-${coordinate.armId}-${coordinate.replicateIndex}.log`,
            );
            mkdirSync(dirname(logPath), { recursive: true });
            const harnessOptions = armOptions(
                input.apiKey,
                input.providerId,
                input.modelId,
                scenario,
                coordinate.armId,
                logPath,
            );
            let harness = await TestHarness.create(harnessOptions);
            let seeded: ReturnType<typeof seedGoldMemories> = [];
            let scriptedTurnText: string | undefined;
            /** The assistant message that closed the scripted turn; its ledger `parentID` identifies the fixture-served rows that belong to it. */
            let scriptedAssistantMessageId: string | null = null;
            /** Captured so the failure path can price the session the rollout was using. */
            let activeSessionId: string | undefined;
            /** Set by the failure read. The runner's deadline rejects a race, not the rollout, so without this the turn loop would keep issuing paid prompts after the failed record was priced. */
            let abortRequested = false;
            /** The prompt currently awaiting the provider, if any, so the failure read can wait for its row rather than price around it. */
            let inFlight: Promise<unknown> | null = null;
            const trackedPrompt = async <T,>(work: () => Promise<T>): Promise<T> => {
                if (abortRequested) {
                    throw new Error("live paired-delta rollout aborted after its failure accounting began");
                }
                const promise = work();
                inFlight = promise;
                try {
                    return await promise;
                } catch (error) {
                    /** The harness's own timer loses the race but does not stop the request; the SDK call it abandoned is what the provider is still billing, so that is what stays in flight. commentlint: allow(JUDGE) */
                    if (error instanceof PromptTimeoutError) inFlight = error.pending;
                    throw error;
                } finally {
                    if (inFlight === promise) inFlight = null;
                }
            };
            /** The declaration names the point the evidence must already be buried by, so the ballast is keyed to it rather than to a literal turn id. */
            const burialTurnId = scenario.interventions.r1.insertAfterTurnId;
            /** R2 supplies the gold as memory and R3 supplies the same content in the prompt, so the seeded row carries the declared claim alone; a second labelled copy of the evidence would make `R3 - R2` measure duplicated content as well as representation. */
            const seedOracleMemories = async (): Promise<typeof seeded> => {
                /** `seedGoldMemories` requires `context.db` to exist; the plugin creates it after the server reports ready. */
                await harness.waitFor(() => harness.hasContextDb(), {
                    label: "context.db created",
                });
                const rows: GoldMemoryRow[] = scenario.interventions.r2.memories.map(
                    ({ claim }) => ({ category: "PROJECT_RULES", content: claim }),
                );
                return seedGoldMemories({
                    workdir: harness.opencode.env.workdir,
                    dbPath: harness.contextDbPath(),
                    rows,
                    verification: coordinate.armId === "r1" ? "candidate" : "verified",
                });
            };
            const locatorIds = (): string[] =>
                seeded.map(({ publicClaimId }) => publicClaimId);
            return {
                async prepare() {
                    if (coordinate.armId !== "r1" && coordinate.armId !== "r2") return;
                    seeded = await seedOracleMemories();
                    if (coordinate.armId !== "r1") return;
                    /**
                     * A resolved id that contains the answer would reveal the gold in the model-visible query, and `seedGoldMemories` resolves a repeated row onto the same claim, so a new id needs a new database.
                     * Reseeding rather than excluding keeps the sample: exclusion is input-dependent and removes R1 observations only for scenarios with short answers, biasing the retrieval rung.
                     */
                    for (
                        let attempt = 1;
                        r1QueryLeaksAnswer(scenario, locatorIds());
                        attempt++
                    ) {
                        if (attempt > R1_RESEED_ATTEMPTS) {
                            throw new Error(
                                `paired-delta r1 locator ids revealed the answer for ` +
                                `${scenario.scenarioId} across ${R1_RESEED_ATTEMPTS} reseeds`,
                            );
                        }
                        await harness.dispose();
                        harness = await TestHarness.create(harnessOptions);
                        seeded = await seedOracleMemories();
                    }
                },
                async run(): Promise<RolloutObservation> {
                    const sessionId = await harness.createSession();
                    activeSessionId = sessionId;
                    const responses: PromptResult[] = [];
                    let ballastBytes = 0;
                    let ballastTokens = 0;
                    for (const turn of scenario.turnScript) {
                        if (turn.role !== "user") {
                            throw new Error("live paired-delta supports authored user turns only");
                        }
                        let content = turn.content;
                        if (turn.id === burialTurnId) {
                            /** The authored floor is bytes and the window is tokens, so the burial turn carries whichever demand is larger once converted. */
                            ballastTokens = Math.max(
                                Math.ceil(
                                    scenario.absencePrecondition.minimumBallastBytes / CHARS_PER_TOKEN,
                                ),
                                scenario.modelContextLimit + 1,
                            );
                            const ballast = ballastProse(ballastTokens);
                            ballastBytes = Buffer.byteLength(ballast);
                            content = `${content}\n\n${ballast}`;
                        }
                        if (
                            coordinate.armId === "r3" &&
                            turn.id === scenario.turnScript.at(-1)?.id
                        ) {
                            content = `${goldEvidencePrompt([{
                                label: scenario.scenarioId,
                                content: r3PromptEvidence(scenario),
                            }])}\n\n${content}`;
                        }
                        const response = parsePromptResult(await trackedPrompt(() => harness.sendPrompt(
                            sessionId,
                            content,
                            {
                                providerID: input.providerId,
                                modelID: input.modelId,
                            },
                        )));
                        if (response.error != null) {
                            const tolerated = coordinate.armId === "mc-off" &&
                                detectOverflow(response.error).isOverflow;
                            if (!tolerated) {
                                throw new ProviderUnavailableError(
                                    "live provider returned an error",
                                );
                            }
                        }
                        responses.push(response);
                        if (
                            coordinate.armId === "r1" &&
                            turn.id === scenario.interventions.r1.insertAfterTurnId
                        ) {
                            const scripted = await trackedPrompt(() => scriptedCtxSearchTurnDetailed(
                                harness,
                                sessionId,
                                seeded,
                            ));
                            scriptedTurnText = scripted.text;
                            scriptedAssistantMessageId = scripted.assistantMessageId;
                        }
                    }
                    const last = responses.at(-1);
                    if (!last) throw new Error("scenario produced no live prompts");
                    const ledger = await settledSessionUsage(
                        harness,
                        sessionId,
                        { providerId: input.providerId, modelId: input.modelId },
                        scriptedTurnText === undefined ? 0 : SCRIPTED_ORACLE_MOCK_ENTRIES,
                        logPath,
                        PLUGIN_BACKED_ARMS.includes(coordinate.armId),
                    );
                    /** Every response the rollout was handed was billed, so a settled ledger that omits one is charging from an incomplete record and may also be hiding that response's route. */
                    const unlisted = responses.filter(({ messageId }) => !ledger.messageIds.has(messageId));
                    if (unlisted.length > 0) {
                        throw new Error(
                            `live paired-delta session ledger omits ${unlisted.length} authored ` +
                            `response(s) the rollout received: ${unlisted.map(({ messageId }) => messageId).join(", ")}`,
                        );
                    }
                    /**
                     * The runner compares one echoed route against the pin, so the offending turn is reported rather than the final one.
                     * A rollout whose earlier turns were served by a fallback provider or snapshot produced its outcome, and its persisted memory, partly off the pin.
                     */
                    const offPin = responses.find(({ providerId, modelId }) =>
                        providerId !== input.providerId || modelId !== input.modelId) ??
                        ledger.offPinRoute ??
                        last;
                    const resolvedLocatorIds = locatorIds();
                    const checks = await scenario.verifier({
                        armId: coordinate.armId,
                        workspacePath: harness.opencode.env.workdir,
                        ...(scriptedTurnText === undefined ? {} : { scriptedTurnText }),
                        resolvedLocatorIds,
                    });
                    const evidenceIndex = scenario.turnScript.findIndex(
                        ({ id }) => id === scenario.absencePrecondition.evidenceTurnId,
                    );
                    const burialIndex = scenario.turnScript.findIndex(
                        ({ id }) => id === burialTurnId,
                    );
                    const structuralAbsence =
                        evidenceIndex >= 0 &&
                        evidenceIndex < burialIndex &&
                        ballastBytes >= scenario.absencePrecondition.minimumBallastBytes &&
                        ballastTokens > scenario.modelContextLimit;
                    /**
                     * The precondition establishes that the authored evidence was displaced from the model's ordinary context, which the ballast does for every arm alike.
                     * It deliberately says nothing about the treatment's memory: persisting that evidence is the mechanism `mc-on` exists to measure, so requiring its absence excluded exactly the rollouts where the treatment worked.
                     * Pre-run contamination is not reachable either, because every rollout builds a fresh harness and database, and only R1 and R2 seed one.
                     */
                    const absencePreconditionHeld = structuralAbsence;
                    /**
                     * An undelivered search turn leaves an arm that is not R1, and the observation carries no separate validity channel, so the gate folds into arm identity.
                     * `prepare` reseeds until the locator query is non-leaking, so the leak test here only catches a reseed loop that stopped honoring its own contract.
                     */
                    const r1Valid = coordinate.armId !== "r1" ||
                        (
                            r1WireDelivered(scenario, {
                                armId: coordinate.armId,
                                workspacePath: harness.opencode.env.workdir,
                                ...(scriptedTurnText === undefined ? {} : { scriptedTurnText }),
                                resolvedLocatorIds,
                            }) &&
                            !r1QueryLeaksAnswer(scenario, resolvedLocatorIds)
                        );
                    const armIdentityMatches =
                        configMatchesArm(
                            harness,
                            coordinate.armId,
                            input.providerId,
                            input.modelId,
                            scenario.modelContextLimit,
                            input.apiKey,
                        ) &&
                        scriptedRowsMatch(ledger.mockRows, scriptedTurnText, scriptedAssistantMessageId) &&
                        (
                            coordinate.armId !== "compaction" ||
                            !harness.hasContextDb()
                        ) &&
                        (
                            !PLUGIN_BACKED_ARMS.includes(coordinate.armId) ||
                            pluginProcessedSession(
                                harness,
                                sessionId,
                                coordinate.armId === "r2"
                                    ? seeded.map(({ revisionLocator }) => revisionLocator)
                                    : null,
                            )
                        ) &&
                        r1Valid;
                    return {
                        checks,
                        /** The probe turn is the last authored turn, and an earlier turn can acknowledge the authored rule without producing the answer. */
                        claimedDone: claimsCompletion(last.text),
                        absencePreconditionHeld,
                        armIdentityMatches,
                        echoedProviderId: offPin.providerId,
                        echoedModelId: offPin.modelId,
                        usage: ledger.usage,
                        turns: scenario.turnScript.length +
                            (scriptedTurnText === undefined ? 0 : 1),
                        baseScriptFingerprint: expectedFingerprint,
                        intervention,
                    };
                },
                /**
                 * The ledger after a failure, so calls the rollout already billed are charged.
                 *
                 * `worstCaseUsd` bounds authored and oracle calls, but the historian's retry tree —
                 * up to three provider attempts at each of several call sites, plus a fallback-model
                 * chain whose length is configuration — cannot be bounded from constants in this
                 * package. Measuring is the only sound answer, and the runner takes whichever of the
                 * bound and the measurement is larger.
                 */
                async usageOnFailure() {
                    abortRequested = true;
                    /** No session means no prompt was sent: `prepare` and `createSession` run before the first provider call, so a failure there billed nothing, and reading the ledger for an empty id would report that nothing as unmeasured. commentlint: allow(JUDGE) */
                    if (activeSessionId === undefined) return { usage: ZERO_USAGE, settled: true };
                    /** A prompt the deadline interrupted is still being billed. Its row lands when the provider answers, so the read waits for it inside the grace; one that outlasts the wait leaves the ledger unsettled by construction. commentlint: allow(JUDGE) */
                    const startedAt = Date.now();
                    const landed = inFlight === null || await Promise.race([
                        inFlight.then(() => true, () => true),
                        Bun.sleep(IN_FLIGHT_PROMPT_WAIT_MS).then(() => false),
                    ]);
                    /** The settle window shrinks by however long the wait took, so the whole read still returns inside the grace the runner allows it rather than being cut off with nothing. */
                    const remainingMs = LATE_DISPOSAL_GRACE_MS - (Date.now() - startedAt);
                    const attempts = Math.max(
                        1,
                        Math.min(
                            LEDGER_SETTLE_ATTEMPTS_ON_FAILURE,
                            Math.floor(remainingMs / 2 / LEDGER_SETTLE_INTERVAL_MS),
                        ),
                    );
                    /** The same settle path as a scored rollout, charging rather than rejecting an incomplete ledger: a single snapshot misses an abandoned historian's retries, and a rejection falls back to the four-call bound those retries exceed. */
                    const { usage, settled } = await settledSessionUsage(
                        harness,
                        activeSessionId,
                        { providerId: input.providerId, modelId: input.modelId },
                        scriptedTurnText === undefined ? 0 : SCRIPTED_ORACLE_MOCK_ENTRIES,
                        logPath,
                        PLUGIN_BACKED_ARMS.includes(coordinate.armId),
                        { attempts: landed ? attempts : 1, incomplete: "charge" },
                    );
                    return { usage, settled: settled && landed };
                },
                async dispose() {
                    await harness.dispose();
                },
            };
        },
    };
}

function buildAnalysis(
    result: PairedDeltaRunResult,
    scenarios: readonly ScenarioDeclaration[],
    policy: PairedDeltaPolicy,
    policyFingerprint: string,
    poolManifestFingerprint: string,
    pinnedSnapshotId: string,
    noiseFloors: readonly FamilyNoiseFloor[],
): { analysis: FamilyDeltaAnalysis; refusedRegretLadders: Record<string, number> } {
    const byId = new Map(scenarios.map((scenario) => [scenario.scenarioId, scenario]));
    const observations: FamilyDeltaObservation[] = [];
    /** A refused ladder leaves the cell `completed`, so it carries no `reasonCode` and would otherwise be indistinguishable from a run that scheduled no regret arms. */
    const refusedRegretLadders: Record<string, number> = {};
    for (const coordinate of result.coordinates) {
        const scenario = byId.get(coordinate.scenarioId);
        if (!scenario) continue;
        const coordinateId = `${coordinate.scenarioId}:${coordinate.replicateIndex}`;
        if (PRIMARY_ARM_IDS.every((armId) =>
            coordinate.cells[armId]?.cell.runHealth === "completed")) {
            for (const [baseline, endpoint] of [
                ["mc-off", "mc-on-vs-mc-off"],
                ["compaction", "mc-on-vs-compaction"],
            ] as const) {
                observations.push({
                    coordinateId,
                    familyId: scenario.familyId,
                    endpoint,
                    delta:
                        validSuccess(coordinate.cells["mc-on"]!) -
                        validSuccess(coordinate.cells[baseline]!),
                    runHealth: "completed",
                });
            }
        }
        const regret = coordinate.regret;
        if (regret?.refusedReason) {
            refusedRegretLadders[regret.refusedReason] =
                (refusedRegretLadders[regret.refusedReason] ?? 0) + 1;
        }
        if (regret && !regret.refusedReason) {
            for (const endpoint of ["retrieval", "formation", "representation"] as const) {
                const delta = regret[endpoint];
                if (delta === undefined) continue;
                observations.push({
                    coordinateId,
                    familyId: scenario.familyId,
                    endpoint,
                    delta,
                    runHealth: "completed",
                });
            }
        }
    }
    /**
     * The live lane analyses its own rollout records, not prospective release-over-release pairs, so it binds the empty paired-fact set rather than fabricating release roles the experiment never had.
     * Provenance for this analysis is the pool manifest, the pinned snapshot, and the policy fingerprint, all of which the binding already carries.
     */
    const lane = {
        poolManifestFingerprint,
        pinnedSnapshotId,
        policyFingerprint,
        pairedFactsFingerprint: pairedFactsFingerprint(LIVE_LANE_PAIRS),
    };
    if (observations.length === 0) {
        return {
            refusedRegretLadders,
            analysis: {
            ...lane,
            bootstrapSeed: BOOTSTRAP_SEED,
            bootstrapResamples: policy.bootstrapResamples,
            minimumAnalyzableFamilyCount: policy.minimumAnalyzableFamilyCount,
            analyzableFamilyCount: 0,
            evidenceSufficient: false,
            endpoints: [],
            liveRegret: [],
            providerMixedRegret: [],
            rawRegretRecords: [],
            },
        };
    }
    return {
        refusedRegretLadders,
        analysis: estimateFamilyDeltas({
        observations,
        minimumAnalyzableFamilyCount: policy.minimumAnalyzableFamilyCount,
        bootstrapSeed: BOOTSTRAP_SEED,
        bootstrapResamples: policy.bootstrapResamples,
        lane,
        noiseFloors,
        }),
    };
}

const BOOTSTRAP_SEED = 20260831;

/** The one endpoint `buildAnalysis` estimates. A policy naming another is rejected rather than silently estimating this one. */
const SUPPORTED_ENDPOINT = "paired-valid-success-delta";

/** `armOptions` keys the provider block dynamically but always supplies the Anthropic adapter and `ANTHROPIC_API_KEY`. */
const SUPPORTED_PROVIDER = "anthropic";

/**
 * Arms `armOptions` runs with the plugin enabled, so each needs runtime evidence that it ran.
 *
 * R2 is the sharp case: the harness precreates the database, so seeding succeeds whether or not a
 * plugin is there to inject the memory, and the resulting failure would have entered the formation
 * and representation deltas as completed evidence.
 */
const PLUGIN_BACKED_ARMS: readonly ArmId[] = ["mc-on", "r1", "r2", "r3"];

/** Bound on R1 database reseeds. Each attempt draws fresh 32-hex ids, so exhausting the bound is a contract failure rather than bad luck, and it is reported as one. */
const R1_RESEED_ATTEMPTS = 8;

/** A run that completes without meeting its evidence gate exits with its own code: a calibration would otherwise be cached and rejected by every later dispatch, and a weekly or release dispatch would report green with nothing to monitor. */
const INSUFFICIENT_EVIDENCE_EXIT = 5;

/** The live lane derives its deltas from rollout records, so it publishes no prospective paired-case facts. */
const LIVE_LANE_PAIRS = [] as const;

function flattenExclusions(result: PairedDeltaRunResult) {
    return ARM_IDS.flatMap((armId) =>
        Object.entries(result.exclusionCounts[armId] ?? {}).map(
            ([reasonCode, count]) => ({
                armId,
                reasonCode: reasonCode as keyof typeof result.exclusionCounts[typeof armId],
                count,
            }),
        ),
    ) as Parameters<typeof buildPairedDeltaReport>[0]["exclusions"];
}

function secondaryMetrics(records: readonly RolloutRecord[]) {
    const byArm = new Map<ArmId, RolloutRecord[]>();
    for (const record of records) {
        const rows = byArm.get(record.armId) ?? [];
        rows.push(record);
        byArm.set(record.armId, rows);
    }
    const metric = (
        value: (record: RolloutRecord) => number,
    ): Partial<Record<ArmId, number>> => Object.fromEntries(
        [...byArm].map(([armId, rows]) => [
            armId,
            rows.reduce((sum, row) => sum + value(row), 0),
        ]),
    );
    return {
        /**
         * The token, wall-clock, and turn totals are the surviving attempts only.
         *
         * `FileRolloutStore.put` replaces a retried coordinate's record, and the replacement keeps
         * `priorAttemptsCostUsd` but no prior usage, duration, or turn count. So `spentUsd` includes
         * every attempt while these do not, and an arm with retried failures would otherwise look
         * cheaper and faster than it was. Recovering them needs prior-attempt counters in the record,
         * which changes the file schema a resume reads.
         */
        /**
         * Denominated on completed cells only. An excluded record carries `invalidSuccess: false`
         * because no response was assessable, so counting it diluted the rate: one false claim
         * among ten attempts, nine of them provider-unavailable, published as 10% rather than 100%
         * of what could be scored — and differential infrastructure failure then reads as an arm
         * being less prone to false success claims.
         */
        invalidSuccessRateByArm: Object.fromEntries(
            [...byArm]
                .map(([armId, rows]) => [
                    armId,
                    rows.filter(({ cell }) => cell.runHealth === "completed"),
                ] as const)
                .filter(([, scorable]) => scorable.length > 0)
                .map(([armId, scorable]) => [
                    armId,
                    scorable.filter(({ cell }) => cell.invalidSuccess).length / scorable.length,
                ]),
        ),
        finalAttemptTokensByArm: metric(({ usage }) =>
            usage.input + usage.output + usage.cacheCreation + usage.cacheRead),
        finalAttemptWallClockMsByArm: metric(({ wallClockMs }) => wallClockMs),
        finalAttemptTurnsByArm: metric(({ turns }) => turns),
    };
}

function deskCostCeilingUsd(
    scenarios: readonly ScenarioDeclaration[],
    prices: TokenPrices,
): number {
    /** Every counter at the context limit, so the ceiling prices each turn at the highest rate `tokenCostUsd` can charge for that many tokens. */
    const contextLimitUsd = (limit: number): number => tokenCostUsd(
        { input: limit, output: limit, cacheCreation: limit, cacheRead: limit },
        prices,
    );
    const worstUsd = Math.max(
        0.01,
        ...scenarios.map(({ turnScript, modelContextLimit }) =>
            (turnScript.length + 1) * contextLimitUsd(modelContextLimit)),
    );
    return Math.ceil(worstUsd * 2 * 100) / 100;
}

/**
 * Every condition a live dispatch requires before it may spend, in one place.
 *
 * Kept as ordered imperative checks rather than a declarative table: each carries a message naming
 * the declared value, the implemented value, and the remedy, and several compare a record against
 * the manifest and policy together, which a per-field table cannot express. Grouping them here
 * gives the single enumeration a reader needs without flattening the diagnostics.
 */
/**
 * Written beside the records file when a run ends with `usage-unmeasured`, and refused on the next
 * start at the same path.
 *
 * The status itself lives only in the process that produced it. The records file carries the
 * failed attempt priced from its estimate and nothing that says the estimate stood in for a
 * measurement, so a later invocation that finds the file and resumes would admit arms against a
 * `spentUsd` the run refused to continue from. The marker travels with the records — the workflow
 * caches both under one key — so any checkpoint chain that can restore the records also restores
 * the refusal. commentlint: allow(JUDGE)
 */
function unmeasuredMarkerPath(recordsPath: string): string {
    return `${recordsPath}.unmeasured`;
}

async function runLive(args: CliArgs): Promise<void> {
    const mode = args.mode as LiveMode;
    const marker = unmeasuredMarkerPath(args.recordsPath);
    if (existsSync(marker)) {
        console.error(
            `paired-delta refuses to run against ${args.recordsPath}: a previous attempt ended with ` +
            `unmeasured usage (${marker}). Inspect the archived records, then remove the marker or ` +
            "point --records at a fresh path.",
        );
        process.exitCode = EXIT_CODES["usage-unmeasured"];
        return;
    }
    /**
     * The marker shares the records directory, so a directory that stops accepting writes mid-run
     * would lose the marker and the record together. Proving the directory writable here does not
     * prevent that, but it does refuse the far more common case — a path that was never writable —
     * before any provider call, so the refusal path is exercised where it can still be cheap. A
     * mid-run loss of the directory is reported on stderr by the marker write itself. commentlint: allow(JUDGE)
     */
    mkdirSync(dirname(args.recordsPath), { recursive: true });
    const probe = `${marker}.probe-${process.pid}`;
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    const apiKey = process.env.PAIRED_DELTA_ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new Error("live paired-delta mode requires PAIRED_DELTA_ANTHROPIC_API_KEY");
    }
    const policyDocument = parsePolicyOwnerDocument(policyJson, POLICY_OWNER);
    if (policyDocument.policyFingerprint === null) {
        throw new Error("paired-delta policy is not ready");
    }
    const policy = lanePolicy(policyDocument);
    const manifest = parsePairedDeltaManifest(manifestJson);
    const manifestFingerprint = canonicalFingerprint(manifest);
    if (manifestFingerprint !== policy.poolManifestFingerprint) {
        throw new Error("paired-delta policy does not bind the current pool manifest");
    }
    /** The report binds the whole policy fingerprint, so executing one entry of a longer matrix would publish coverage the run never had. */
    if (policy.modelMatrix.length !== 1) {
        throw new Error(
            `paired-delta live lane executes exactly one model; the policy declares ` +
            `${policy.modelMatrix.length}`,
        );
    }
    const model = policy.modelMatrix[0];
    if (!model || !/-\d{8}$/.test(model.modelId)) {
        throw new Error("paired-delta policy requires a dated model snapshot");
    }
    /** `buildAnalysis` computes one endpoint unconditionally, so a policy naming a different one would publish a fingerprint claiming an estimator this lane does not implement. */
    if (policy.endpoint !== SUPPORTED_ENDPOINT) {
        throw new Error(
            `paired-delta lane implements ${SUPPORTED_ENDPOINT}; the policy declares ` +
            `${policy.endpoint}`,
        );
    }
    /** The report is fingerprinted to the policy, so an override above the preregistered budget would publish as though it executed a cap it exceeded. */
    if (args.maxCostUsd !== null && args.maxCostUsd > policy.costBudgetUsd[mode]) {
        throw new Error(
            `--max-cost-usd ${args.maxCostUsd} exceeds the ${mode} policy budget ` +
            `${policy.costBudgetUsd[mode]}; an override may only lower it`,
        );
    }
    /** `spawnOpencode` selects a different transform pipeline under `MC_E2E_MODE`, and neither that selection nor the Rust host is in the calibration scope, so a mode other than the default would share a binding with evidence measured against different code. */
    const harnessMode = process.env.MC_E2E_MODE;
    if (harnessMode !== undefined && harnessMode !== "" && harnessMode !== "ts") {
        throw new Error(
            `paired-delta live lane runs the OpenCode pipeline; MC_E2E_MODE is ${harnessMode}`,
        );
    }
    /** The provider block is keyed by the declared id but backed by the Anthropic SDK and credential, so another id would echo a provider the run never used. */
    if (model.providerId !== SUPPORTED_PROVIDER) {
        throw new Error(
            `paired-delta live lane serves ${SUPPORTED_PROVIDER} only; the policy declares ` +
            `${model.providerId}`,
        );
    }
    /** The estimator runs only after the experiment, so its own floor is checked before the budget is spent. */
    if (policy.bootstrapResamples < MIN_BOOTSTRAP_RESAMPLES) {
        throw new Error(
            `paired-delta policy declares bootstrapResamples ` +
            `${policy.bootstrapResamples}; the estimator requires at least ` +
            `${MIN_BOOTSTRAP_RESAMPLES}`,
        );
    }
    /**
     * Calibration evidence is validated before the first provider call rather than after the experiment.
     * A weekly or release dispatch with a missing or unbound record would otherwise spend its whole budget and then discard the result.
     */
    const implementationDigest = scopeDigest();
    /** Built before the calibration block, which needs family membership to check the per-family cohort. */
    const manifestFamilies = [...buildPairedDeltaRegistry().values()]
        .map(({ declaration }) => ({
            scenarioId: declaration.scenarioId,
            familyId: declaration.familyId,
        }));
    let noiseFloors: FamilyNoiseFloor[] = [];
    /** Carried into the records binding and the report, so a dispatch cannot mix coordinates measured under two calibration artifacts. */
    let calibrationFingerprint: string | null = null;
    if (mode !== "calibration") {
        if (!existsSync(args.calibrationRecordPath)) {
            throw new Error(
                `paired-delta ${mode} mode requires a calibration record at ` +
                args.calibrationRecordPath,
            );
        }
        const calibration = readCalibrationRecord(args.calibrationRecordPath);
        /** Binding is checked first: a stale record's `poolSize` could otherwise raise a cohort complaint that points at re-authoring the pool when the record simply does not describe this run. */
        if (
            calibration.poolManifestFingerprint !== manifestFingerprint ||
            calibration.pinnedSnapshotId !== model.modelId ||
            calibration.policyFingerprint !== policyDocument.policyFingerprint ||
            calibration.implementationDigest !== implementationDigest ||
            !calibration.validForPoolSizing
        ) {
            throw new Error("paired-delta calibration record does not bind this run");
        }
        /**
         * The calibrated size is a decision, and a cohort below it cannot support the preregistered
         * detectable delta, so the dispatch refuses before spending rather than publishing an
         * underpowered directional verdict. Widening the cohort means re-authoring the frozen pool
         * or the policy's replicate count, neither of which the runner may do at dispatch time.
         */
        const selected = scenarioIdsForMode(manifest, mode);
        const cohort = selected.size * policy.replicateCount;
        const perFamily = Math.ceil(
            calibration.decisions.poolSize / calibration.decisions.familyCount,
        );
        /**
         * Per family, not only in total: `derivePoolSize` derives a per-family requirement from the
         * worst variance, so an overrepresented family would otherwise cover an underpowered one.
         */
        const byFamily = new Map<string, number>();
        for (const { scenarioId, familyId } of manifestFamilies) {
            if (!selected.has(scenarioId)) continue;
            byFamily.set(familyId, (byFamily.get(familyId) ?? 0) + policy.replicateCount);
        }
        const short = [...byFamily]
            .filter(([, coordinates]) => coordinates < perFamily)
            .sort(([left], [right]) => left.localeCompare(right));
        if (short.length > 0) {
            throw new Error(
                `paired-delta ${mode} families below the calibrated ${perFamily} coordinates ` +
                `each: ${short.map(([familyId, n]) => `${familyId}=${n}`).join(", ")}; the ` +
                `calibrated pool size is ${calibration.decisions.poolSize} for a ` +
                `${policy.targetMinimumDetectableDelta} detectable delta at the measured variance`,
            );
        }
        if (cohort < calibration.decisions.poolSize) {
            throw new Error(
                `paired-delta ${mode} cohort of ${cohort} coordinates is below the calibrated ` +
                `${calibration.decisions.poolSize} (${perFamily} per family for a ` +
                `${policy.targetMinimumDetectableDelta} detectable delta at the measured ` +
                `variance); the pool supplies ${scenarioIdsForMode(manifest, mode).size} ` +
                `scenarios at replicateCount ${policy.replicateCount}. Raise the pool or the ` +
                "replicate count in the policy, or lower the target delta; re-calibrating alone " +
                "will not close a gap this large",
            );
        }
        noiseFloors = calibrationNoiseFloors(calibration);
        calibrationFingerprint = calibration.recordFingerprint;
        /** The policy fingerprint proves the record names this policy, not that it honoured its depth or target: the reader recomputes the pool size against the record's own copies of both. */
        if (
            calibration.decisions.replicateCount !== policy.replicateCount ||
            calibration.targetMinimumDetectableDelta !== policy.targetMinimumDetectableDelta
        ) {
            throw new Error(
                "paired-delta calibration record declares a different replicate depth or target " +
                "delta than the policy",
            );
        }
        /** Depth is validated for the keys present, so the key set itself has to be the calibration pool's. */
        const calibrationScenarios = scenarioIdsForMode(manifest, "calibration");
        const calibrationScenarioFamilies = new Set(
            manifestFamilies
                .filter(({ scenarioId }) => calibrationScenarios.has(scenarioId))
                .map(({ familyId }) => familyId),
        );
        const measuredScenarios = new Set(Object.keys(calibration.scenarioDepth));
        if (
            measuredScenarios.size !== calibrationScenarios.size ||
            [...calibrationScenarios].some((scenarioId) => !measuredScenarios.has(scenarioId))
        ) {
            throw new Error(
                "paired-delta calibration record does not cover the calibration pool's scenarios",
            );
        }
        /**
         * Each series has to hold exactly the observations its own declared depths imply.
         *
         * `arithmeticallyReachable` floors the variance at `1/n`, so an inflated `observationCount`
         * buys a smaller admissible variance and a correspondingly smaller derived pool — a record can
         * claim a hundred observations of a five-scenario pilot and size the lane down to whatever the
         * live cohort clears. The depths are already checked per scenario, so their family sums are the
         * count each family's series must report.
         */
        const observationsByFamily = new Map<string, number>();
        for (const { scenarioId, familyId } of manifestFamilies) {
            if (!calibrationScenarios.has(scenarioId)) continue;
            const depth = calibration.scenarioDepth[scenarioId] ?? 0;
            observationsByFamily.set(familyId, (observationsByFamily.get(familyId) ?? 0) + depth);
        }
        const miscounted = calibration.familyNoise
            .filter(({ familyId, observationCount }) =>
                observationCount !== observationsByFamily.get(familyId))
            .map(({ familyId, endpoint }) => `${familyId}/${endpoint}`)
            .sort(compareCodeUnits);
        if (miscounted.length > 0) {
            throw new Error(
                "paired-delta calibration record series do not match their scenario depths: " +
                miscounted.join(", "),
            );
        }
        /** Every family this dispatch runs must have a calibrated floor: `estimateFamilyDeltas` labels an uncalibrated family `no-noise-floor` and keeps going, so a scenario tagged for weekly or release without a calibration sibling would spend budget on a family whose deltas the gate cannot compare. */
        const dispatchedFamilies = new Set(
            manifestFamilies
                .filter(({ scenarioId }) => scenarioIdsForMode(manifest, mode).has(scenarioId))
                .map(({ familyId }) => familyId),
        );
        const uncalibrated = [...dispatchedFamilies]
            .filter((familyId) => !calibrationScenarioFamilies.has(familyId))
            .sort(compareCodeUnits);
        if (uncalibrated.length > 0) {
            throw new Error(
                `paired-delta ${mode} dispatches families the calibration pool never measured: ` +
                uncalibrated.join(", "),
            );
        }
        /** The record's own family set, not only its declared count: a record binding this policy could still have measured a different selection. */
        const measuredFamilies = new Set(calibration.familyNoise.map(({ familyId }) => familyId));
        const expected = calibrationScenarioFamilies;
        if (
            measuredFamilies.size !== expected.size ||
            [...expected].some((familyId) => !measuredFamilies.has(familyId))
        ) {
            throw new Error(
                "paired-delta calibration record does not cover the calibration pool's families",
            );
        }
    }
    const registry = buildPairedDeltaRegistry();
    /**
     * The manifest fingerprint is stamped into every record, the calibration binding, and the
     * report, so a changed scenario or verifier executed against a stale manifest publishes
     * evidence attributed to a pool that was never run. The unit suite asserts this too, but a
     * direct paid invocation does not go through it.
     */
    assertFrozenPool(registry, manifest);
    const selectedIds = scenarioIdsForMode(manifest, mode);
    const scenarios = [...registry.values()]
        .map(({ declaration }) => declaration)
        .filter(({ scenarioId }) => selectedIds.has(scenarioId));
    /** `evidenceSufficient` counts distinct families, so a mode selecting fewer than the minimum can never satisfy it however well the run goes. */
    const selectedFamilies = new Set(scenarios.map(({ familyId }) => familyId));
    if (selectedFamilies.size < policy.minimumAnalyzableFamilyCount) {
        throw new Error(
            `paired-delta ${mode} selects ${selectedFamilies.size} families but the policy ` +
            `requires ${policy.minimumAnalyzableFamilyCount}`,
        );
    }
    // The fingerprinted policy documents the executed configuration, so the
    // context limit it pins must match what the scenarios actually request.
    for (const scenario of scenarios) {
        /** Rejected here rather than mid-rollout: the throw inside `run` lands after earlier user turns have already billed, and records every arm as a harness failure. */
        const authored = scenario.turnScript.find(({ role }) => role !== "user");
        if (authored) {
            throw new Error(
                `paired-delta live lane replays authored user turns only; ` +
                `${scenario.scenarioId} declares a ${authored.role} turn (${authored.id})`,
            );
        }
        if (scenario.modelContextLimit !== model.contextLimit) {
            throw new Error(
                `paired-delta policy pins contextLimit ${model.contextLimit} but ` +
                `${scenario.scenarioId} declares ${scenario.modelContextLimit}`,
            );
        }
    }
    /**
     * Written whenever the run leaves `runPairedDelta` by any path but a returned result.
     *
     * A throw after a provider call — a record publication that lost its disk or lock, a store
     * conflict, anything the runner does not classify — leaves the records file without the paid
     * coordinate while the always-on cache save keeps the older file, so a rerun would resume and
     * repeat or admit calls against spend the checkpoint never restored. The marker makes that path
     * refuse the same way an unmeasured record does. commentlint: allow(JUDGE)
     */
    const writeUnmeasuredMarker = (status: string, spentUsd: number | null): void => {
        const body = `${JSON.stringify({
            status,
            recordsPath: args.recordsPath,
            spentUsd,
            writtenAt: new Date().toISOString(),
        }, null, 2)}\n`;
        try {
            writeFileSync(marker, body);
        } catch (error) {
            /** The refusal could not be persisted beside the records, so it is left where the run's own output goes; a checkpoint saved from this attempt is not safe to resume, and the operator has to see that in the log. commentlint: allow(JUDGE) */
            console.error(
                `paired-delta could not write ${marker} (${error instanceof Error ? error.message : String(error)}); ` +
                `do not resume ${args.recordsPath}: ${body.trim()}`,
            );
        }
    };
    let result: PairedDeltaRunResult | null = null;
    /** Set once `runOrReportInvalidRecords` has classified and reported an error itself; those are pre-rollout validation failures that already refuse resume with their own code and must not also be marked unmeasured, which would hide the actual record problem on the next attempt. commentlint: allow(JUDGE) */
    let handled = false;
    try {
        result = await runOrReportInvalidRecords(() => runPairedDelta(
            {
                scenarios,
                poolManifestFingerprint: manifestFingerprint,
                repoCommit: `${recordsRepoCommit([
                    args.recordsPath,
                    args.reportPath,
                    args.calibrationRecordPath,
                ])}${calibrationFingerprint === null ? "" : `-cal-${calibrationFingerprint}`}`,
                openCodeVersion: openCodeVersion(),
                pinnedProviderId: model.providerId,
                pinnedSnapshotId: model.modelId,
                replicateCount: policy.replicateCount,
                deskCostCeilingUsd: deskCostCeilingUsd(
                    scenarios,
                    policy.pricesPerMillionTokens,
                ),
                maxCostUsd: args.maxCostUsd ?? policy.costBudgetUsd[mode],
                deadlineEpochMs: Date.now() + args.deadlineMinutes * 60_000,
                pricesPerMillionTokens: policy.pricesPerMillionTokens,
                resume: args.resume,
                store: new FileRolloutStore(args.recordsPath),
            },
            createLiveDependencies({
                apiKey,
                providerId: model.providerId,
                modelId: model.modelId,
            }),
        ), () => writeUnmeasuredMarker("publish-conflict", null));
        handled = result === null;
    } finally {
        /** A returned result, even a failed one, has published every record it paid for, and a handled validation failure ran no rollout; only an escape has spent without recording. commentlint: allow(JUDGE) */
        if (result === null && !handled) writeUnmeasuredMarker("run-escaped", null);
    }
    if (result === null) return;
    /** Written before any report or calibration work, which can throw — an unwritable `--report` destination, a malformed record — and would otherwise leave the records file unmarked for the always-on cache save. commentlint: allow(JUDGE) */
    if (result.usageUnmeasured) writeUnmeasuredMarker(result.status, result.spentUsd);
    const scenarioFamilies = new Map(
        scenarios.map(({ scenarioId, familyId }) => [scenarioId, familyId]),
    );
    let calibrationValidForSizing = true;
    if (mode === "calibration") {
        const calibration = buildCalibrationRecord({
            records: result.records,
            scenarioFamilies,
            runStatus: result.status,
            poolManifestFingerprint: manifestFingerprint,
            pinnedSnapshotId: model.modelId,
            policyFingerprint: policyDocument.policyFingerprint,
            implementationDigest,
            targetMinimumDetectableDelta: policy.targetMinimumDetectableDelta,
            decisions: {
                /** The families this run measured, not the policy's floor: the reader requires the recorded count to equal the measured set, so a pool wider than the floor would make its own artifact unreadable. */
                familyCount: new Set(scenarios.map(({ familyId }) => familyId)).size,
                replicateCount: policy.replicateCount,
                cadence: "weekly-and-release",
            },
        });
        publishCalibrationRecord(calibration, args.calibrationRecordPath);
        noiseFloors = calibrationNoiseFloors(calibration);
        calibrationValidForSizing = calibration.validForPoolSizing;
    }
    const plannedCoordinates = scenarios.length * policy.replicateCount;
    const healthyCoordinates = result.coordinates.filter(({ cells }) =>
        PRIMARY_ARM_IDS.every((armId) => cells[armId]?.cell.runHealth === "completed")).length;
    const { analysis, refusedRegretLadders } = buildAnalysis(
        result,
        scenarios,
        policy,
        policyDocument.policyFingerprint,
        manifestFingerprint,
        model.modelId,
        noiseFloors,
    );
    /**
     * Decided before publication, because the workflow archives the report even when the step
     * fails: an artifact claiming `evidenceSufficient` while the dispatch exited on a shortfall is
     * the one output nobody re-reads the logs to correct.
     */
    const evidenceComplete = mode === "calibration"
        ? calibrationValidForSizing
        : analysis.evidenceSufficient && healthyCoordinates >= plannedCoordinates;
    const report = buildPairedDeltaReport({
        poolManifestFingerprint: manifestFingerprint,
        pinnedSnapshotId: model.modelId,
        policyDocument: policyJson,
        implementationDigest,
        pairs: LIVE_LANE_PAIRS,
        analysis,
        exclusions: flattenExclusions(result),
        secondaryMetrics: secondaryMetrics(result.records),
        limitations: [
            /**
             * The gate compares generated ballast against `modelContextLimit`, which is the limit
             * configured in the harness's provider block rather than the snapshot's own window. On
             * `mc-off`, with the plugin and native compaction both disabled, nothing enforces it, so
             * the provider can still receive the evidence turn. Stated here because the report is
             * read on its own, and the delta is only interpretable with this caveat attached.
             */
            "absence-precondition-basis=configured-context-limit: the gate proves the burial " +
            "turn's ballast exceeds the configured limit and follows the evidence turn, not that " +
            "the evidence left the provider-visible context",
        ],
        runSummary: {
            status: result.status,
            spentUsd: result.spentUsd,
            observedCostRollouts: result.observedCostRollouts,
            estimatedCostRollouts: result.estimatedCostRollouts,
            refusedRegretLadders,
            plannedCoordinates,
            healthyCoordinates,
            evidenceComplete,
            calibrationFingerprint,
        },
    });
    publishPairedDeltaReport(report, args.reportPath);
    console.log(JSON.stringify({
        status: result.status,
        reportPath: args.reportPath,
        recordsPath: args.recordsPath,
        calibrationRecordPath:
            mode === "calibration" ? args.calibrationRecordPath : null,
        spentUsd: result.spentUsd,
        analyzableFamilyCount: analysis.analyzableFamilyCount,
        evidenceSufficient: analysis.evidenceSufficient,
        plannedCoordinates,
        healthyCoordinates,
        refusedRegretLadders,
        validForPoolSizing: mode === "calibration" ? calibrationValidForSizing : null,
    }, null, 2));
    /** A non-completed status outranks the calibration verdict, because the caller keyed on `harness-unreclaimed` must not lose it. */
    if (result.status !== "completed") {
        process.exitCode = EXIT_CODES[result.status];
        return;
    }
    if (!evidenceComplete && mode === "calibration") {
        console.error(
            "paired-delta calibration completed without evidence valid for pool sizing",
        );
        process.exitCode = INSUFFICIENT_EVIDENCE_EXIT;
        return;
    }
    /** A weekly or release dispatch whose cells were all excluded still completes, so the preregistered evidence gate decides the exit rather than the run status alone. */
    if (mode !== "calibration" && !analysis.evidenceSufficient) {
        console.error(
            `paired-delta ${mode} completed without sufficient evidence: ` +
            `${analysis.analyzableFamilyCount} of ` +
            `${policy.minimumAnalyzableFamilyCount} families analyzable`,
        );
        process.exitCode = INSUFFICIENT_EVIDENCE_EXIT;
        return;
    }
    /**
     * Family representation is not the preregistered gate. `all-primary-arms-completed` covers
     * every planned coordinate, so one healthy replicate per family would otherwise pass while
     * the rest of the matrix failed.
     */
    if (mode !== "calibration" && healthyCoordinates < plannedCoordinates) {
        console.error(
            `paired-delta ${mode} completed ${healthyCoordinates} of ` +
            `${plannedCoordinates} planned primary coordinates`,
        );
        process.exitCode = INSUFFICIENT_EVIDENCE_EXIT;
        return;
    }
    process.exitCode = EXIT_CODES[result.status];
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.mode === "smoke") await runSmoke(args);
    else await runLive(args);
}

/** Guarded so a test can import the module's helpers without launching a dispatch. */
if (import.meta.main) await main();
