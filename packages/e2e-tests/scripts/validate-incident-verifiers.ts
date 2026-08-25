#!/usr/bin/env bun

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    REPO_ROOT,
    changedVerifiers,
    loadMutationEvidence,
} from "../src/incident-pool/evidence";
import {
    deriveTrustedAcceptedCommit,
    type GitRunner,
} from "./validate-incident-history";

function git(args: string[], cwd: string): {
    status: number;
    stdout: string;
    stderr: string;
} {
    const result = Bun.spawnSync({
        cmd: ["git", ...args],
        cwd,
        stdout: "pipe",
        stderr: "pipe",
    });
    return {
        status: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
    };
}

export function assertBoundVerifierBytesUnchanged(
    acceptedDigests: Record<string, string>,
    currentDigests: Record<string, string>,
): void {
    const changed = changedVerifiers(acceptedDigests, currentDigests);
    if (changed.length > 0) {
        throw new Error(
            `bound verifiers changed without recorded mutation replay support: ${changed.join(", ")}`,
        );
    }
}

function trustedCiCommit(gitRunner: GitRunner): string {
    const eventName = process.env.GITHUB_EVENT_NAME;
    const eventPath = process.env.GITHUB_EVENT_PATH;
    const githubSha = process.env.GITHUB_SHA;
    const githubRef = process.env.GITHUB_REF;
    if (!eventName || !eventPath || !githubSha || !githubRef) {
        throw new Error(
            "trusted verifier CI validation requires GitHub event environment",
        );
    }
    let event: unknown;
    try {
        event = JSON.parse(readFileSync(eventPath, "utf8")) as unknown;
    } catch {
        throw new Error("could not read trusted GitHub event payload");
    }
    return deriveTrustedAcceptedCommit({
        eventName,
        event,
        githubSha,
        githubRef,
        githubRefProtected: process.env.GITHUB_REF_PROTECTED ?? "false",
        repoRoot: REPO_ROOT,
        git: gitRunner,
    });
}

function loadTrustedEvidence(baseCommit: string) {
    const parent = mkdtempSync(join(tmpdir(), "incident-verifier-base-"));
    const worktree = join(parent, "tree");
    const added = git(
        ["worktree", "add", "--detach", worktree, baseCommit],
        REPO_ROOT,
    );
    if (added.status !== 0) {
        rmSync(parent, { recursive: true, force: true });
        throw new Error(
            `could not create trusted verifier worktree: ${added.stderr.trim() || `git worktree add exited ${added.status}`}`,
        );
    }
    try {
        return loadMutationEvidence(
            resolve(worktree, "packages/e2e-tests"),
            worktree,
        );
    } finally {
        const removed = git(
            ["worktree", "remove", "--force", worktree],
            REPO_ROOT,
        );
        rmSync(parent, { recursive: true, force: true });
        if (removed.status !== 0) {
            throw new Error(
                `could not remove trusted verifier worktree: ${removed.stderr.trim() || `git worktree remove exited ${removed.status}`}`,
            );
        }
    }
}

export function validateIncidentVerifiers(baseCommit: string): number {
    const accepted = loadTrustedEvidence(baseCommit);
    const current = loadMutationEvidence();
    assertBoundVerifierBytesUnchanged(
        accepted.verifierDigests,
        current.verifierDigests,
    );
    return Object.keys(accepted.verifierDigests).length;
}

function main(args: string[]): void {
    const ci = args.length === 1 && args[0] === "--ci";
    const local = args.length === 2 && args[0] === "--base";
    if (!ci && !local) {
        throw new Error("usage: validate-incident-verifiers.ts --ci | --base <commit>");
    }
    const baseCommit = ci ? trustedCiCommit(git) : args[1]!;
    const count = validateIncidentVerifiers(baseCommit);
    console.log(`validated ${count} bound verifier files against ${baseCommit}`);
}

if (import.meta.main) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
