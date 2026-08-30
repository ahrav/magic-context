import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    realpathSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
    readProjectMemoryCurrentState,
    resolveProjectIdentity,
} from "../../../plugin/src/features/magic-context/memory";
import {
    applyProjectMemoryMapping,
    computeProjectMemoryMutationToken,
    recordProjectMemoryVerification,
} from "../../../plugin/src/features/magic-context/memory/storage-claim-operations";
import { APPLICABILITY_BASELINE_STREAM_KEY } from "../../../plugin/src/features/magic-context/storage-claim-applicability-schema";
import { readDreamerProjectClaims } from "../../../plugin/src/features/magic-context/dreamer/claim-manifest";
import { selectMapMemoryInputs } from "../../../plugin/src/features/magic-context/dreamer/map-memories";
import {
    getTaskScheduleState,
    seedTaskScheduleState,
    writeTaskScheduleState,
} from "../../../plugin/src/features/magic-context/dreamer/storage-task-schedule";
import { partitionVerifyScope } from "../../../plugin/src/features/magic-context/dreamer/verify-gate";
import { seedProjectMemoryClaim } from "../../../plugin/src/features/magic-context/test-claim-database";
import type { Database } from "../../../plugin/src/shared/sqlite";
import {
    DREAMER_EVAL_POOL_SCHEMA,
    type DreamerEvalScenario,
    type DreamerTaskScenario,
    type PoolDescriptor,
    type VerifyResultMode,
} from "./contract";

const CLASSIFY_MIN_POOL = 10;
const FIXTURE_MARKER = ".dreamer-eval-fixture";
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const PATH_SEGMENT_RE = /[\\/]/;

type SeederFailureReason = "fixture-drift" | "gate-mismatch";

export class DreamerEvalSeederError extends Error {
    readonly reason: SeederFailureReason;

    constructor(reason: SeederFailureReason, detail: string) {
        super(`ERROR:${reason}: ${detail}`);
        this.reason = reason;
    }
}

export interface DreamerGatePreflight {
    task: DreamerTaskScenario["task"];
    mode: VerifyResultMode | null;
    inScopeClaimIds: string[];
    skippedClaimIds: string[];
}

export interface SeedDreamerEvalTaskOptions {
    db: Database;
    scenario: DreamerEvalScenario;
    task: DreamerTaskScenario;
    /** Fresh, run-owned directory also used as the task's project directory. */
    workdir: string;
    nowMs?: number;
}

export interface SeededDreamerEvalTask {
    workdir: string;
    projectIdentity: string;
    fixtureCommitTimeMs: number;
    publicClaimIds: Record<string, string>;
    pool: PoolDescriptor;
    preflight: DreamerGatePreflight;
}

function fixtureError(detail: string): never {
    throw new DreamerEvalSeederError("fixture-drift", detail);
}

/**
 * Environment for every fixture git invocation. GIT_DIR, GIT_INDEX_FILE,
 * GIT_WORK_TREE, and GIT_OBJECT_DIRECTORY override repository discovery, so an
 * ambient value (a git hook, `git rebase --exec`, or an outer harness) would
 * redirect these writes at the surrounding repository instead of the run-owned
 * workdir. Neutralizing global and system config additionally keeps
 * `core.hooksPath` from running host scripts during the fixture commit.
 */
function fixtureGitEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const inherited: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith("GIT_")) inherited[key] = value;
    }
    return {
        ...inherited,
        GIT_CONFIG_GLOBAL: NULL_DEVICE,
        GIT_CONFIG_SYSTEM: NULL_DEVICE,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        ...overrides,
    };
}

function git(workdir: string, args: readonly string[], overrides?: NodeJS.ProcessEnv): string {
    const result = spawnSync("git", args, {
        cwd: workdir,
        encoding: "utf8",
        env: fixtureGitEnv(overrides),
    });
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
        fixtureError(`git ${args[0] ?? "command"} failed: ${detail}`);
    }
    return result.stdout.trim();
}

function fixturePath(workdir: string, path: string): string {
    if (isAbsolute(path)) fixtureError(`fixture path must be relative: ${path}`);
    const target = resolve(workdir, path);
    const fromRoot = relative(workdir, target);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
        fixtureError(`fixture path escapes workdir: ${path}`);
    }
    // `relative` reports the platform separator, so on Windows the portable
    // spelling a manifest and `git ls-files` use (`src/file.ts`) comes back as
    // `src\file.ts`. Compare against a POSIX-normalized copy so forward slashes
    // stay canonical on every platform; `.` and `..` aliases still differ from
    // their resolved form and are still rejected.
    const canonical = sep === "/" ? fromRoot : fromRoot.split(sep).join("/");
    // Aliases of one target (`src/./a.ts`, `src/sub/../a.ts`) must not reach the
    // repository. Mapping preconditions, gold file sets, and `git ls-files`
    // compare the authored string, so two aliases would satisfy every check
    // while writing one file — the second content silently replacing the first.
    if (canonical !== path) fixtureError(`fixture path is not canonical: ${path}`);
    // The marker names the scenario that owns this workdir and is written after
    // fixture content, so a claim declaring it would have its authored content
    // silently overwritten. The commit and `assertFixtureFilesCommitted` would
    // still pass — they only check that the path is tracked and clean — leaving
    // the evaluation to run against evidence the claim never declared. A
    // descendant is reserved for a blunter reason: writing it creates the marker
    // as a directory, and the marker write then fails with a raw EISDIR outside
    // the typed fixture-drift path. Folded like the `.git` check below, because a
    // case-insensitive filesystem maps `.DREAMER-EVAL-FIXTURE` onto the same
    // name.
    const foldedCanonical = canonical.toLowerCase();
    if (foldedCanonical === FIXTURE_MARKER || foldedCanonical.startsWith(`${FIXTURE_MARKER}/`)) {
        fixtureError(`fixture path is reserved: ${path}`);
    }
    // The control directory lives inside the workdir but is not fixture
    // content: a write there steers the seeder's own git invocations, and
    // `.git/hooks` would execute during the fixture commit.
    if (fromRoot.split(PATH_SEGMENT_RE).some((segment) => segment.toLowerCase() === ".git")) {
        fixtureError(`fixture path targets the git control directory: ${path}`);
    }
    return target;
}

function fixtureFiles(workdir: string, scenario: DreamerEvalScenario): Map<string, string> {
    const files = new Map<string, string>();
    for (const claim of scenario.pool.claims) {
        for (const file of claim.fixtureFiles) {
            // Validate before keying: conflict detection must run on the path
            // that reaches disk, not on the authored spelling.
            fixturePath(workdir, file.path);
            const existing = files.get(file.path);
            if (existing !== undefined && existing !== file.content) {
                fixtureError(`fixture content conflicts for ${file.path}`);
            }
            files.set(file.path, file.content);
        }
    }
    // Windows and default macOS volumes map paths differing only in case onto
    // one file, so two such declarations would share storage and the second
    // content would replace the first. Folding refuses the ambiguity on every
    // platform rather than letting the outcome depend on the filesystem the run
    // lands on, and it gives the nesting check below the same identity rule.
    const byFoldedPath = new Map<string, string>();
    for (const path of files.keys()) {
        const folded = path.toLowerCase();
        const existing = byFoldedPath.get(folded);
        if (existing !== undefined) {
            fixtureError(`fixture paths ${existing} and ${path} differ only by case`);
        }
        byFoldedPath.set(folded, path);
    }
    // A declared file and a declared descendant of it cannot both exist. The
    // write loop would fail with EEXIST from mkdir or EISDIR from the write
    // depending on declaration order, and that raw filesystem error escapes
    // untyped — bypassing the fixture-drift path a caller matches on. Paths are
    // canonical and POSIX-normalized by fixturePath, so segment prefixes of one
    // path are exactly its ancestors.
    for (const [folded, path] of byFoldedPath) {
        const segments = folded.split("/");
        for (let index = 1; index < segments.length; index += 1) {
            const ancestor = byFoldedPath.get(segments.slice(0, index).join("/"));
            if (ancestor !== undefined) {
                fixtureError(`fixture path ${path} nests under declared file ${ancestor}`);
            }
        }
    }
    return files;
}

function prepareFixtureRepository(
    workdir: string,
    scenario: DreamerEvalScenario,
    task: DreamerTaskScenario,
    nowMs: number,
): number {
    // Only probe a repository the workdir itself owns. `git rev-parse` walks
    // parent directories, so an unprobed nested workdir resolves the
    // surrounding repository's HEAD and reports drift that does not exist.
    if (existsSync(join(workdir, ".git"))) {
        const existingHead = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
            cwd: workdir,
            stdio: "ignore",
            env: fixtureGitEnv(),
        });
        if (existingHead.status === 0) fixtureError("workdir already contains a commit");
    }

    git(workdir, ["init", "--quiet"]);
    const files = fixtureFiles(workdir, scenario);
    for (const [path, content] of files) {
        const target = fixturePath(workdir, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
    }
    writeFileSync(join(workdir, FIXTURE_MARKER), `${scenario.id}\n`);

    const verificationTimes = task.preconditions.verifications.map((entry) => entry.verifiedAt);
    const firstVerification = Math.min(...verificationTimes);
    const commitTimeMs = Number.isFinite(firstVerification) ? firstVerification - 2_000 : nowMs - 2_000;
    if (commitTimeMs <= 0) fixtureError("verification timestamps leave no positive fixture commit time");
    const commitDate = new Date(commitTimeMs).toISOString();
    // Every path here was explicitly authored and has to be committed for the
    // evaluation to run, so a fixture-local .gitignore must not suppress one:
    // without --force `git add` exits nonzero on an ignored path.
    git(workdir, ["add", "--force", "--", FIXTURE_MARKER, ...files.keys()]);
    git(
        workdir,
        [
            "-c",
            "user.name=Dreamer Eval",
            "-c",
            "user.email=dreamer-eval@example.invalid",
            "commit",
            "--quiet",
            "--no-gpg-sign",
            "-m",
            `fixture: ${scenario.id}`,
        ],
        {
            GIT_AUTHOR_DATE: commitDate,
            GIT_COMMITTER_DATE: commitDate,
        },
    );
    const committedAtMs = Number(git(workdir, ["show", "-s", "--format=%ct", "HEAD"])) * 1_000;
    assertFixtureFilesCommitted(workdir, [...files.keys()]);
    for (const verification of task.preconditions.verifications) {
        if (verification.verifiedAt <= committedAtMs + 1_000) {
            fixtureError(
                `verification timestamp for ${verification.claimId} must be more than one second after fixture commit`,
            );
        }
    }
    return committedAtMs;
}

export function assertFixtureFilesCommitted(workdir: string, paths: readonly string[]): void {
    for (const path of paths) {
        fixturePath(workdir, path);
        const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", path], {
            cwd: workdir,
            stdio: "ignore",
            env: fixtureGitEnv(),
        });
        const status = git(workdir, ["status", "--porcelain", "--", path]);
        if (tracked.status !== 0 || status !== "") {
            fixtureError(`fixture file is not committed: ${path}`);
        }
    }
}

function sorted(values: readonly string[]): string[] {
    return [...values].sort((left, right) => left.localeCompare(right));
}

function assertExpectedSet(
    label: string,
    actual: readonly string[],
    expected: readonly string[],
): void {
    if (JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(expected))) {
        throw new DreamerEvalSeederError(
            "gate-mismatch",
            `${label}: expected [${sorted(expected).join(", ")}], got [${sorted(actual).join(", ")}]`,
        );
    }
}

export async function preflightDreamerEvalTask(args: {
    db: Database;
    projectIdentity: string;
    workdir: string;
    task: DreamerTaskScenario;
    publicClaimIds: Readonly<Record<string, string>>;
    nowMs?: number;
}): Promise<DreamerGatePreflight> {
    const logicalByPublic = new Map(
        Object.entries(args.publicClaimIds).map(([logical, publicId]) => [publicId, logical]),
    );
    let actualPublicIds: string[];
    let mode: VerifyResultMode | null = null;
    if (args.task.task === "verify" || args.task.task === "verify-broad") {
        const gate = await partitionVerifyScope({
            db: args.db,
            projectIdentity: args.projectIdentity,
            projectDirectory: args.workdir,
            forceBroad: args.task.task === "verify-broad",
            ...(args.nowMs === undefined ? {} : { now: args.nowMs }),
        });
        actualPublicIds = gate.inScopeIds;
        mode = gate.mode;
    } else if (args.task.task === "map-memories") {
        actualPublicIds = selectMapMemoryInputs(
            args.db,
            args.projectIdentity,
            args.workdir,
        ).map((claim) => claim.publicClaimId);
    } else {
        const hygiene = readDreamerProjectClaims(args.db, args.projectIdentity, "hygiene");
        actualPublicIds = hygiene.length >= CLASSIFY_MIN_POOL
            ? hygiene.map((claim) => claim.publicClaimId)
            : [];
    }

    const unknown = actualPublicIds.filter((publicId) => !logicalByPublic.has(publicId));
    if (unknown.length > 0) {
        throw new DreamerEvalSeederError(
            "gate-mismatch",
            `production gate selected unknown public claims: ${unknown.join(", ")}`,
        );
    }
    const inScope = actualPublicIds.map((publicId) => logicalByPublic.get(publicId)!);
    const inScopeSet = new Set(inScope);
    const skipped = Object.keys(args.publicClaimIds).filter((claimId) => !inScopeSet.has(claimId));
    assertExpectedSet("in-scope claims", inScope, args.task.expectedInScopeClaimIds);
    assertExpectedSet("skipped claims", skipped, args.task.expectedSkippedClaimIds);
    // The scenario contract pins a mode for every task: a verify mode for
    // verify, "broad" for verify-broad, and null for map and classify. A gate
    // that returns the expected candidates under the wrong mode still
    // invalidates the experiment, because mode decides what a later cycle
    // re-sweeps.
    if (mode !== args.task.expectedResultMode) {
        throw new DreamerEvalSeederError(
            "gate-mismatch",
            `result mode: expected ${args.task.expectedResultMode ?? "none"}, got ${mode ?? "none"}`,
        );
    }
    return {
        task: args.task.task,
        mode,
        inScopeClaimIds: inScope,
        skippedClaimIds: skipped,
    };
}

function projectionFiles(
    claim: ReturnType<typeof readDreamerProjectClaims>[number],
): string[] {
    const baseline = claim.applicability.find(
        (assertion) => assertion.streamKey === APPLICABILITY_BASELINE_STREAM_KEY,
    );
    if (baseline?.pathsState !== "known") return [];
    return sorted(
        baseline.paths.flatMap((path) => (path.kind === "exact" ? [path.value] : [])),
    );
}

export function readDreamerEvalPoolDescriptor(args: {
    db: Database;
    scenario: DreamerEvalScenario;
    publicClaimIds: Readonly<Record<string, string>>;
}): PoolDescriptor {
    const currentState = readProjectMemoryCurrentState(args.db, {
        publicClaimIds: Object.values(args.publicClaimIds),
        surface: "explicit_search",
        lifecycleStates: ["active", "archived", "retired"],
    });
    if (currentState.status !== "ok") fixtureError("claims current-state projection is stale");
    const snapshotByPublicId = new Map(
        currentState.items.map((claim) => [claim.publicClaimId, claim]),
    );
    return {
        schema: DREAMER_EVAL_POOL_SCHEMA,
        scenarioId: args.scenario.id,
        claims: args.scenario.pool.claims.map((row) => {
            const snapshot = snapshotByPublicId.get(args.publicClaimIds[row.id]!);
            if (!snapshot) return fixtureError(`seeded claim ${row.id} is absent from projection`);
            return {
                claimId: row.id,
                publicClaimId: snapshot.publicClaimId,
                revisionLocator: snapshot.revisionLocator,
                content: snapshot.content,
                category: snapshot.category,
                importance: snapshot.importance,
                memoryScope: snapshot.memoryScope,
                sharing: snapshot.sharing,
                lifecycleState: snapshot.lifecycleState,
                files: projectionFiles(snapshot),
                verificationOutcome: snapshot.verification.latestOutcome,
            };
        }),
    };
}

export async function seedDreamerEvalTask(
    options: SeedDreamerEvalTaskOptions,
): Promise<SeededDreamerEvalTask> {
    const workdir = realpathSync(options.workdir);
    const nowMs = options.nowMs ?? Date.now();
    const fixtureCommitTimeMs = prepareFixtureRepository(
        workdir,
        options.scenario,
        options.task,
        nowMs,
    );
    const projectIdentity = resolveProjectIdentity(workdir);
    const publicClaimIds: Record<string, string> = {};
    for (const row of options.scenario.pool.claims) {
        const claim = seedProjectMemoryClaim(options.db, {
            projectIdentity,
            category: row.category,
            content: row.content,
            importance: row.importance,
            memoryScope: row.memoryScope,
            sharing: row.sharing,
            operationKey: `dreamer-eval:${options.scenario.id}:${options.task.task}:${row.id}`,
            provenance: { sourceTrustClass: "explicit_user" },
        });
        publicClaimIds[row.id] = claim.publicClaimId;
    }
    if (new Set(Object.values(publicClaimIds)).size !== options.scenario.pool.claims.length) {
        fixtureError("normalized claim dedup collapsed seeded rows");
    }

    for (const mapping of options.task.preconditions.mappings) {
        const publicClaimId = publicClaimIds[mapping.claimId];
        if (!publicClaimId) fixtureError(`mapping references unknown claim ${mapping.claimId}`);
        const claim = options.scenario.pool.claims.find((entry) => entry.id === mapping.claimId);
        if (!claim) fixtureError(`mapping references missing pool row ${mapping.claimId}`);
        for (const path of mapping.files) {
            if (!claim.fixtureFiles.some((fixture) => fixture.path === path)) {
                fixtureError(`mapping for ${mapping.claimId} references undeclared fixture ${path}`);
            }
        }
        const snapshot = readProjectMemoryCurrentState(options.db, {
            publicClaimIds: [publicClaimId],
            surface: "explicit_search",
        });
        const current = snapshot.status === "ok" ? snapshot.items[0] : undefined;
        if (!current) fixtureError(`mapped claim ${mapping.claimId} is not readable`);
        const result = applyProjectMemoryMapping(
            options.db,
            {
                producer: "dreamer-eval-seeder",
                operationKey: `map:${options.scenario.id}:${options.task.task}:${mapping.claimId}`,
            },
            {
                token: computeProjectMemoryMutationToken(options.db, publicClaimId),
                revisionLocator: current.revisionLocator,
                paths: { state: "known", exact: mapping.files },
                knownFrom: fixtureCommitTimeMs,
                nowMs: fixtureCommitTimeMs,
            },
        );
        if (result.outcome !== "applied" && result.outcome !== "noop") {
            fixtureError(`mapping ${mapping.claimId} returned ${result.outcome}`);
        }
    }

    for (const verification of options.task.preconditions.verifications) {
        const publicClaimId = publicClaimIds[verification.claimId];
        if (!publicClaimId) fixtureError(`verification references unknown claim ${verification.claimId}`);
        const snapshot = readProjectMemoryCurrentState(options.db, {
            publicClaimIds: [publicClaimId],
            surface: "explicit_search",
        });
        const current = snapshot.status === "ok" ? snapshot.items[0] : undefined;
        if (!current) fixtureError(`verified claim ${verification.claimId} is not readable`);
        const result = recordProjectMemoryVerification(
            options.db,
            {
                producer: "dreamer-eval-seeder",
                operationKey: `verify:${options.scenario.id}:${options.task.task}:${verification.claimId}`,
            },
            {
                token: computeProjectMemoryMutationToken(options.db, publicClaimId),
                revisionLocator: current.revisionLocator,
                outcome: verification.outcome,
                verifier: "dreamer-eval-seeder",
                nowMs: verification.verifiedAt,
            },
        );
        if (result.outcome !== "applied") {
            fixtureError(`verification ${verification.claimId} returned ${result.outcome}`);
        }
    }

    if (options.task.task === "verify-broad") {
        const verificationTimes = options.task.preconditions.verifications.map(
            (entry) => entry.verifiedAt,
        );
        if (verificationTimes.length === 0) fixtureError("verify-broad requires seeded verification history");
        // partitionVerifyScope keeps a claim whose verifiedAt precedes the broad
        // cycle start, so the watermark must sit after every seeded
        // verification. A watermark below them filters the verified claims out
        // and collapses broad scope onto the never-verified set that
        // incremental already selects, which is the one behavior broad exists
        // to differ on.
        const lastBroadRunAt = Math.max(...verificationTimes) + 1;
        if (lastBroadRunAt <= 0) fixtureError("verify-broad watermark must be positive");
        seedTaskScheduleState(
            options.db,
            projectIdentity,
            "verify-broad",
            null,
            null,
            "0 3 * * 0",
        );
        const state = getTaskScheduleState(options.db, projectIdentity, "verify-broad");
        if (!state) fixtureError("verify-broad schedule row was not created");
        writeTaskScheduleState(options.db, { ...state, lastBroadRunAt });
    }

    const pool = readDreamerEvalPoolDescriptor({
        db: options.db,
        scenario: options.scenario,
        publicClaimIds,
    });
    const preflight = await preflightDreamerEvalTask({
        db: options.db,
        projectIdentity,
        workdir,
        task: options.task,
        publicClaimIds,
        nowMs,
    });
    return {
        workdir,
        projectIdentity,
        fixtureCommitTimeMs,
        publicClaimIds,
        pool,
        preflight,
    };
}
