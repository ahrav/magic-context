#!/usr/bin/env bun

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseIncidentCatalog } from "../src/incident-pool/contract";
import {
    REPO_ROOT,
    boundVerifierDigests,
    changedVerifiers,
    loadMutationEvidence,
} from "../src/incident-pool/evidence";
import {
    deriveTrustedAcceptedCommit,
    type GitRunner,
} from "./validate-incident-history";

function git(
    args: string[],
    cwd: string,
): {
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

/**
 *
 * A catalog with no accepted bindings treats every current binding as new.
 * Reject modules bound only by the accepted catalog; otherwise removing a binding exempts an executable verifier from this gate.
 */
export function assertCatalogBoundVerifierBytesUnchanged(
    acceptedDigests: Record<string, string>,
    currentDigests: Record<string, string>,
): void {
    const changed: string[] = [];
    const unbound: string[] = [];
    for (const [path, accepted] of Object.entries(acceptedDigests)) {
        const current = currentDigests[path];
        if (current === undefined) unbound.push(path);
        else if (current !== accepted) changed.push(path);
    }
    if (unbound.length > 0) {
        throw new Error(
            `catalog no longer binds accepted executable verifiers: ${unbound.sort().join(", ")}`,
        );
    }
    if (changed.length > 0) {
        throw new Error(
            `catalog-bound executable verifiers changed without recorded replay support: ${changed.sort().join(", ")}`,
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

interface TrustedVerifierState {
    mutationDigests: Record<string, string>;
    catalogBoundDigests: Record<string, string>;
}

/* */
function readVerifierState(
    worktree: string,
    repoRoot: string,
): TrustedVerifierState {
    const e2eRoot = resolve(worktree, "packages/e2e-tests");
    const catalogPath = resolve(e2eRoot, "incidents", "catalog.json");
    // A tree without catalog.json binds no executable verifiers.
    // Such a tree contributes no accepted bytes, so every current binding is new.
    // Deleting the current catalog leaves accepted bindings without counterparts.
    const catalogBoundDigests = existsSync(catalogPath)
        ? boundVerifierDigests(
              parseIncidentCatalog(
                  JSON.parse(readFileSync(catalogPath, "utf8")) as unknown,
              ),
              e2eRoot,
          )
        : {};
    return {
        mutationDigests: loadMutationEvidence(e2eRoot, repoRoot).verifierDigests,
        catalogBoundDigests,
    };
}

function loadTrustedEvidence(baseCommit: string): TrustedVerifierState {
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
    let evidence: TrustedVerifierState;
    try {
        evidence = readVerifierState(worktree, worktree);
    } catch (error) {
        // Suppress cleanup errors when evidence loading fails so they do not replace the evidence error.
        cleanupTrustedWorktree(worktree, parent);
        throw error;
    }
    // Cleanup failures propagate after evidence loads.
    const cleanupError = cleanupTrustedWorktree(worktree, parent);
    if (cleanupError) throw cleanupError;
    return evidence;
}

/* */
function cleanupTrustedWorktree(
    worktree: string,
    parent: string,
): Error | null {
    const removed = git(["worktree", "remove", "--force", worktree], REPO_ROOT);
    rmSync(parent, { recursive: true, force: true });
    if (removed.status !== 0) {
        return new Error(
            `could not remove trusted verifier worktree: ${removed.stderr.trim() || `git worktree remove exited ${removed.status}`}`,
        );
    }
    return null;
}

export function validateIncidentVerifiers(baseCommit: string): number {
    const accepted = loadTrustedEvidence(baseCommit);
    const current = readVerifierState(REPO_ROOT, REPO_ROOT);
    assertBoundVerifierBytesUnchanged(
        accepted.mutationDigests,
        current.mutationDigests,
    );
    assertCatalogBoundVerifierBytesUnchanged(
        accepted.catalogBoundDigests,
        current.catalogBoundDigests,
    );
    return (
        Object.keys(accepted.mutationDigests).length +
        Object.keys(accepted.catalogBoundDigests).length
    );
}

function main(args: string[]): void {
    const ci = args.length === 1 && args[0] === "--ci";
    const local = args.length === 2 && args[0] === "--base";
    if (!ci && !local) {
        throw new Error(
            "usage: validate-incident-verifiers.ts --ci | --base <commit>",
        );
    }
    const baseCommit = ci ? trustedCiCommit(git) : args[1]!;
    const count = validateIncidentVerifiers(baseCommit);
    console.log(
        `validated ${count} bound verifier files against ${baseCommit}`,
    );
}

if (import.meta.main) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
