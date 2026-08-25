#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
    compareWithAcceptedSnapshot,
    splitLedgerLines,
    validateIncidentHistory,
    type HistorySnapshot,
    type IncidentHistoryState,
} from "../src/incident-pool/history";

export const E2E_ROOT = resolve(import.meta.dir, "..");
export const REPO_ROOT = resolve(E2E_ROOT, "../..");
export const INCIDENTS_DIR = resolve(E2E_ROOT, "incidents");
const INCIDENT_FILES = [
    "source-inventory.json",
    "catalog.json",
    "adjudications.jsonl",
    "emergency-redactions.jsonl",
] as const;
const SHA_RE = /^[0-9a-f]{40}$/;
const ZERO_SHA = "0".repeat(40);

function readIncidentFile(dir: string, name: string): string {
    const path = resolve(dir, name);
    try {
        return readFileSync(path, "utf8");
    } catch (error) {
        throw new Error(`could not read ${path}: ${String(error)}`);
    }
}

export function loadHistorySnapshot(
    dir: string,
    baseLabel: string,
): HistorySnapshot {
    return {
        baseLabel,
        inventoryText: readIncidentFile(dir, "source-inventory.json"),
        catalogText: readIncidentFile(dir, "catalog.json"),
        adjudicationLines: splitLedgerLines(
            readIncidentFile(dir, "adjudications.jsonl"),
        ),
        redactionLines: splitLedgerLines(
            readIncidentFile(dir, "emergency-redactions.jsonl"),
        ),
    };
}

export function validateIncidentDirectory(
    dir: string = INCIDENTS_DIR,
): IncidentHistoryState {
    return validateIncidentHistory(loadHistorySnapshot(dir, "working"));
}

export function validateAgainstAcceptedDirectory(
    acceptedDir: string,
    baseLabel: string,
    candidateDir: string = INCIDENTS_DIR,
): IncidentHistoryState {
    const accepted = loadHistorySnapshot(acceptedDir, baseLabel);
    const candidate = loadHistorySnapshot(candidateDir, baseLabel);
    return compareWithAcceptedSnapshot(accepted, candidate).candidate;
}

export interface GitCommandResult {
    status: number;
    stdout: string;
    stderr: string;
}

export type GitRunner = (args: string[], cwd: string) => GitCommandResult;

const defaultGitRunner: GitRunner = (args, cwd) => {
    const result = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    return {
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? result.error?.message ?? "",
    };
};

function runGit(
    git: GitRunner,
    cwd: string,
    args: string[],
    label: string,
): string {
    const result = git(args, cwd);
    if (result.status !== 0) {
        throw new Error(
            `${label} failed (git ${args.join(" ")}): ${result.stderr.trim() || `exit ${result.status}`}`,
        );
    }
    return result.stdout.trim();
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function stringField(
    value: Record<string, unknown>,
    field: string,
    label: string,
): string {
    const result = value[field];
    if (typeof result !== "string" || result.length === 0) {
        throw new Error(`${label}.${field} must be a non-empty string`);
    }
    return result;
}

function trustedSha(value: unknown, label: string): string {
    if (
        typeof value !== "string" ||
        !SHA_RE.test(value) ||
        value === ZERO_SHA
    ) {
        throw new Error(`${label} must be a non-zero 40-character commit SHA`);
    }
    return value;
}

function fetchTrustedCommit(
    git: GitRunner,
    repoRoot: string,
    sha: string,
): void {
    runGit(
        git,
        repoRoot,
        ["fetch", "--no-tags", "--force", "origin", sha],
        "trusted-base fetch",
    );
    const shallow = runGit(
        git,
        repoRoot,
        ["rev-parse", "--is-shallow-repository"],
        "shallow-checkout probe",
    );
    if (shallow === "true") {
        runGit(
            git,
            repoRoot,
            ["fetch", "--no-tags", "--unshallow", "origin"],
            "trusted history fetch",
        );
    }
    runGit(
        git,
        repoRoot,
        ["cat-file", "-e", `${sha}^{commit}`],
        "trusted-base commit check",
    );
}

export interface TrustedBaseInput {
    eventName: string;
    event: unknown;
    githubSha: string;
    githubRef: string;
    githubRefProtected: string;
    repoRoot?: string;
    git?: GitRunner;
}

export function deriveTrustedAcceptedCommit(input: TrustedBaseInput): string {
    const repoRoot = resolve(input.repoRoot ?? REPO_ROOT);
    const git = input.git ?? defaultGitRunner;
    const event = record(input.event, "GitHub event payload");
    const githubSha = trustedSha(input.githubSha, "GITHUB_SHA");
    const head = trustedSha(
        runGit(git, repoRoot, ["rev-parse", "HEAD"], "checked-out commit"),
        "checked-out commit",
    );
    if (head !== githubSha) {
        throw new Error("GITHUB_SHA does not match the checked-out commit");
    }

    let accepted: string;
    if (input.eventName === "pull_request") {
        const pullRequest = record(event.pull_request, "pull_request");
        const base = record(pullRequest.base, "pull_request.base");
        accepted = trustedSha(base.sha, "pull_request.base.sha");
    } else if (input.eventName === "push") {
        if (input.githubRefProtected !== "true") {
            throw new Error("push event ref is not marked protected");
        }
        const eventRef = stringField(event, "ref", "push event");
        if (eventRef !== input.githubRef) {
            throw new Error("push event ref does not match GITHUB_REF");
        }
        const repository = record(event.repository, "push event.repository");
        const defaultBranch = stringField(
            repository,
            "default_branch",
            "push event.repository",
        );
        if (eventRef !== `refs/heads/${defaultBranch}`) {
            throw new Error(
                "push event is not for the protected default branch",
            );
        }
        const after = trustedSha(event.after, "push event.after");
        if (after !== head) {
            throw new Error(
                "push event.after does not match the checked-out commit",
            );
        }
        accepted = trustedSha(event.before, "push event.before");
    } else {
        throw new Error(
            `unsupported GitHub event ${JSON.stringify(input.eventName)}`,
        );
    }

    fetchTrustedCommit(git, repoRoot, accepted);
    const relation = git(
        ["merge-base", "--is-ancestor", accepted, head],
        repoRoot,
    );
    if (relation.status !== 0) {
        throw new Error("trusted accepted commit is not an ancestor of HEAD");
    }
    if (input.eventName === "pull_request") {
        const parents = runGit(
            git,
            repoRoot,
            ["rev-list", "--parents", "-n", "1", head],
            "pull-request merge relation",
        ).split(/\s+/);
        if (parents.length < 3 || parents[1] !== accepted) {
            throw new Error(
                "checked-out pull-request commit is not a merge commit rooted at the event base",
            );
        }
    }
    return accepted;
}

export function loadHistorySnapshotFromGit(
    repoRoot: string,
    commit: string,
    git: GitRunner,
): HistorySnapshot {
    const incidentDir = "packages/e2e-tests/incidents";
    const tree = git(
        ["ls-tree", "-r", "--name-only", commit, "--", incidentDir],
        repoRoot,
    );
    if (tree.status !== 0) {
        throw new Error(
            `could not inspect trusted incident baseline: ${tree.stderr.trim() || `git ls-tree exited ${tree.status}`}`,
        );
    }
    const listed = tree.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (listed.length === 0) {
        return {
            baseLabel: commit,
            inventoryText: JSON.stringify({
                schema: "incident-source-inventory/v1",
                items: [],
            }),
            catalogText: JSON.stringify({
                schema: "incident-catalog/v1",
                families: [],
            }),
            adjudicationLines: [],
            redactionLines: [],
        };
    }

    const text = new Map<string, string>();
    const missing = INCIDENT_FILES.filter(
        (name) => !listed.includes(`${incidentDir}/${name}`),
    );
    if (missing.length > 0) {
        throw new Error(
            `trusted baseline has only part of incident history: missing ${missing.join(", ")}`,
        );
    }
    for (const name of INCIDENT_FILES) {
        const path = `${incidentDir}/${name}`;
        const result = git(["show", `${commit}:${path}`], repoRoot);
        if (result.status !== 0) {
            throw new Error(
                `could not read trusted incident file ${path}: ${result.stderr.trim() || `git show exited ${result.status}`}`,
            );
        }
        text.set(name, result.stdout);
    }
    return {
        baseLabel: commit,
        inventoryText: text.get("source-inventory.json")!,
        catalogText: text.get("catalog.json")!,
        adjudicationLines: splitLedgerLines(text.get("adjudications.jsonl")!),
        redactionLines: splitLedgerLines(
            text.get("emergency-redactions.jsonl")!,
        ),
    };
}

export interface TrustedCiEnvironment {
    [key: string]: string | undefined;
    GITHUB_EVENT_NAME?: string;
    GITHUB_EVENT_PATH?: string;
    GITHUB_SHA?: string;
    GITHUB_REF?: string;
    GITHUB_REF_PROTECTED?: string;
}

export function validateAgainstTrustedCiBase(
    env: TrustedCiEnvironment = process.env,
    repoRoot: string = REPO_ROOT,
    candidateDir: string = INCIDENTS_DIR,
    git: GitRunner = defaultGitRunner,
): { state: IncidentHistoryState; acceptedCommit: string } {
    const eventName = env.GITHUB_EVENT_NAME;
    const eventPath = env.GITHUB_EVENT_PATH;
    const githubSha = env.GITHUB_SHA;
    const githubRef = env.GITHUB_REF;
    if (!eventName || !eventPath || !githubSha || !githubRef) {
        throw new Error(
            "trusted CI validation requires GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_SHA, and GITHUB_REF",
        );
    }
    let event: unknown;
    try {
        event = JSON.parse(readFileSync(eventPath, "utf8")) as unknown;
    } catch (error) {
        throw new Error(
            `could not read trusted GitHub event payload: ${String(error)}`,
        );
    }
    const acceptedCommit = deriveTrustedAcceptedCommit({
        eventName,
        event,
        githubSha,
        githubRef,
        githubRefProtected: env.GITHUB_REF_PROTECTED ?? "false",
        repoRoot,
        git,
    });
    const accepted = loadHistorySnapshotFromGit(repoRoot, acceptedCommit, git);
    const candidate = loadHistorySnapshot(candidateDir, acceptedCommit);
    return {
        state: compareWithAcceptedSnapshot(accepted, candidate).candidate,
        acceptedCommit,
    };
}

interface LocalCliArgs {
    mode: "local";
    dir: string;
    accepted: string | null;
    base: string;
}

interface CiCliArgs {
    mode: "ci";
}

export type IncidentHistoryCliArgs = LocalCliArgs | CiCliArgs;

export function parseIncidentHistoryArgs(
    args: string[],
): IncidentHistoryCliArgs {
    if (args.includes("--ci")) {
        if (args.length !== 1 || args[0] !== "--ci") {
            throw new Error(
                "--ci accepts no caller-supplied directory, accepted snapshot, or base override",
            );
        }
        return { mode: "ci" };
    }
    let dir = INCIDENTS_DIR;
    let accepted: string | null = null;
    let base = "accepted";
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--dir") {
            const value = args[++index];
            if (!value) throw new Error("--dir requires a directory");
            dir = resolve(value);
        } else if (arg === "--accepted") {
            const value = args[++index];
            if (!value) throw new Error("--accepted requires a directory");
            accepted = resolve(value);
        } else if (arg === "--base") {
            const value = args[++index];
            if (!value) throw new Error("--base requires a label");
            base = value;
        } else if (arg === "--help" || arg === "-h") {
            console.log(
                "Usage: validate-incident-history.ts [--ci] | [--dir <incidents-dir>] [--accepted <snapshot-dir>] [--base <label>]",
            );
            process.exit(0);
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    return { mode: "local", dir, accepted, base };
}

function counts(state: IncidentHistoryState): string {
    const claims = state.inventory.items.reduce(
        (total, item) => total + item.claims.length,
        0,
    );
    const variants = state.catalog.families.reduce(
        (total, family) => total + family.variants.length,
        0,
    );
    return (
        `${state.inventory.items.length} source items, ${claims} claims, ` +
        `${state.catalog.families.length} families, ${variants} variants, ` +
        `${state.events.length} adjudications, ${state.redactions.length} redactions`
    );
}

if (import.meta.main) {
    try {
        const args = parseIncidentHistoryArgs(Bun.argv.slice(2));
        if (args.mode === "ci") {
            const { state, acceptedCommit } = validateAgainstTrustedCiBase();
            console.log(
                `validated incident history against trusted commit ${acceptedCommit}: ${counts(state)}`,
            );
        } else {
            const state = args.accepted
                ? validateAgainstAcceptedDirectory(
                      args.accepted,
                      args.base,
                      args.dir,
                  )
                : validateIncidentDirectory(args.dir);
            console.log(
                `validated incident history: ${counts(state)}` +
                    (args.accepted
                        ? " (accepted-snapshot comparison passed)"
                        : ""),
            );
        }
    } catch (error) {
        console.error(
            `incident history validation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
    }
}
