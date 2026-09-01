#!/usr/bin/env bun
/**
 *
 * The fixture comes from real Git repositories, not project-identity test hooks.
 * An independent Git probe collects expected values.
 * The script verifies the TypeScript resolver before writing or byte-comparing the fixture.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
    __resetProjectIdentityForTests,
    resolveProjectIdentityStrict,
} from "../src/features/magic-context/memory/project-identity";

const repoRoot = resolve(dirname(import.meta.dir), "../..");
const fixturePath = join(repoRoot, "docs/specs/git-dedup-goldens.json");
const fixedEnvironment = {
    ...process.env,
    GIT_AUTHOR_NAME: "Magic Context Golden",
    GIT_AUTHOR_EMAIL: "magic-context-golden@example.invalid",
    GIT_COMMITTER_NAME: "Magic Context Golden",
    GIT_COMMITTER_EMAIL: "magic-context-golden@example.invalid",
    LC_ALL: "C",
    LANG: "C",
};

function git(args: string[], cwd?: string, date = "2000-01-01T00:00:00Z"): string {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: {
            ...fixedEnvironment,
            GIT_AUTHOR_DATE: date,
            GIT_COMMITTER_DATE: date,
        },
        stdio: ["ignore", "pipe", "pipe"],
    }) as string;
}

function makeDirectory(parent: string, name: string): string {
    const directory = join(parent, name);
    mkdirSync(directory, { recursive: true });
    return directory;
}

function initRepository(directory: string): void {
    git(["init", "-q", "-b", "main"], directory);
}

function commitFile(
    directory: string,
    file: string,
    contents: string,
    message: string,
    date: string,
): string {
    const filePath = join(directory, file);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
    git(["add", "--", file], directory);
    git(["commit", "-q", "-m", message], directory, date);
    return git(["rev-parse", "HEAD"], directory).trim();
}

function makeRepository(
    parent: string,
    name: string,
    file: string,
    contents: string,
    date = "2000-01-01T00:00:00Z",
): { directory: string; root: string } {
    const directory = makeDirectory(parent, name);
    initRepository(directory);
    const root = commitFile(directory, file, contents, `initial ${name}`, date);
    return { directory, root };
}

function cloneRepository(source: string, destination: string): void {
    git(["clone", "-q", "--no-hardlinks", source, destination]);
}

function visibleGitMetadata(directory: string): boolean {
    const walk = (start: string): boolean => {
        let current = start;
        while (true) {
            if (existsSync(join(current, ".git"))) return true;
            const parent = dirname(current);
            if (parent === current) return false;
            current = parent;
        }
    };

    if (walk(resolve(directory))) return true;
    try {
        const realDirectory = realpathSync.native(resolve(directory));
        return realDirectory !== resolve(directory) && walk(realDirectory);
    } catch {
        return false;
    }
}

function independentExpectedAnchor(directory: string): string {
    // independentExpectedAnchor uses Git rather than resolveProjectIdentityStrict so resolver checks compare against Git.
    if (!visibleGitMetadata(directory)) return "NONE";
    try {
        const roots = git(["rev-list", "--max-parents=0", "HEAD"], directory)
            .split("\n")
            .map((line) => line.trim().slice(0, 64))
            .filter((line) => /^[0-9a-f]{7,64}$/.test(line))
            .sort();
        return roots[0] ? `git:${roots[0]}` : "NONE";
    } catch {
        return "NONE";
    }
}

type Golden = { case: string; expected_anchor: string };
type GeneratedCase = Golden & { directory: string };

function makeCases(tempRoot: string): GeneratedCase[] {
    const cases: GeneratedCase[] = [];
    const add = (caseName: string, directory: string, expectedAnchor?: string) => {
        const independentAnchor = independentExpectedAnchor(directory);
        if (expectedAnchor !== undefined && expectedAnchor !== independentAnchor) {
            throw new Error(
                `independent git oracle mismatch for ${caseName}: expected ${expectedAnchor}, got ${independentAnchor}`,
            );
        }
        cases.push({
            case: caseName,
            expected_anchor: expectedAnchor ?? independentAnchor,
            directory,
        });
    };

    const ordinary = makeRepository(tempRoot, "ordinary", "README.md", "ordinary repository\n");
    add("ordinary-repository", ordinary.directory);

    const nonGit = makeDirectory(tempRoot, "non-git");
    add("non-git-directory", nonGit, "NONE");

    const empty = makeDirectory(tempRoot, "empty");
    initRepository(empty);
    add("empty-repository", empty);

    const graftedA = makeRepository(tempRoot, "grafted-a", "a.txt", "history A\n");
    const graftedB = makeRepository(tempRoot, "grafted-b", "b.txt", "history B\n", "2000-01-02T00:00:00Z");
    git(["remote", "add", "other", graftedB.directory], graftedA.directory);
    git(["fetch", "-q", "other", "main"], graftedA.directory);
    git(
        ["merge", "-q", "--no-edit", "--allow-unrelated-histories", "other/main"],
        graftedA.directory,
        "2000-01-03T00:00:00Z",
    );
    add("grafted-history-lexmin-root", graftedA.directory);

    const shallowSource = makeDirectory(tempRoot, "shallow-source");
    initRepository(shallowSource);
    commitFile(shallowSource, "history.txt", "one\n", "first", "2000-01-04T00:00:00Z");
    commitFile(shallowSource, "history.txt", "one\ntwo\n", "second", "2000-01-05T00:00:00Z");
    const shallowTip = commitFile(
        shallowSource,
        "history.txt",
        "one\ntwo\nthree\n",
        "third",
        "2000-01-06T00:00:00Z",
    );
    const shallow = join(tempRoot, "shallow-clone");
    git(["clone", "-q", "--depth", "1", "--branch", "main", pathToFileURL(shallowSource).href, shallow]);
    const shallowExpected = `git:${shallowTip}`;
    add("shallow-clone-sees-shallow-tip-as-root", shallow, shallowExpected);

    const parent = makeRepository(tempRoot, "submodule-parent", "parent.txt", "parent\n");
    const submodule = makeRepository(tempRoot, "submodule-source", "sub.txt", "submodule\n");
    git(
        ["-c", "protocol.file.allow=always", "submodule", "add", "-q", submodule.directory, "vendor/sub"],
        parent.directory,
    );
    git(["commit", "-q", "-m", "add submodule"], parent.directory, "2000-01-07T00:00:00Z");
    add("submodule-uses-its-own-root", join(parent.directory, "vendor/sub"), `git:${submodule.root}`);

    const worktreeSource = makeRepository(tempRoot, "worktree-source", "worktree.txt", "main\n");
    const worktree = join(tempRoot, "linked-worktree");
    git(["worktree", "add", "-q", "--detach", worktree, "main"], worktreeSource.directory);
    add("worktree-shares-main-checkout-anchor", worktree, `git:${worktreeSource.root}`);

    const bareSource = makeRepository(tempRoot, "bare-source", "bare.txt", "bare\n");
    const bare = join(tempRoot, "bare-repository.git");
    git(["clone", "-q", "--bare", bareSource.directory, bare]);
    // A bare repository has no `.git` entry for the resolver's stat-walk fast path.
    // The linked worktree is the resolvable form of the same repository.
    add("bare-repository-direct-path-is-none", bare, "NONE");
    const bareWorktree = join(tempRoot, "bare-linked-worktree");
    git(["--git-dir", bare, "worktree", "add", "-q", "--detach", bareWorktree, "main"]);
    add("bare-repository-linked-worktree", bareWorktree, `git:${bareSource.root}`);

    const trailing = `${ordinary.directory}/`;
    add("trailing-slash-is-path-invariant", trailing, `git:${ordinary.root}`);
    const symlinkParent = makeDirectory(tempRoot, "symlink-parent");
    const symlink = join(symlinkParent, "ordinary-link");
    symlinkSync(ordinary.directory, symlink, "dir");
    add("symlink-is-path-invariant", symlink, `git:${ordinary.root}`);

    const forkOriginal = makeRepository(tempRoot, "fork-original", "fork.txt", "shared history\n");
    const fork = join(tempRoot, "fork-copy");
    cloneRepository(forkOriginal.directory, fork);
    add("fork-original-anchor", forkOriginal.directory, `git:${forkOriginal.root}`);
    add("fork-sharing-history-anchor", fork, `git:${forkOriginal.root}`);

    const vendorOriginal = makeRepository(tempRoot, "vendor-original", "library.txt", "library history\n");
    const vendor = join(tempRoot, "vendored-copy");
    cloneRepository(vendorOriginal.directory, vendor);
    mkdirSync(join(vendor, "vendor", "library"), { recursive: true });
    writeFileSync(join(vendor, "vendor", "library", "README.md"), "vendored working tree\n");
    add("vendor-original-anchor", vendorOriginal.directory, `git:${vendorOriginal.root}`);
    add("vendored-copy-with-intact-git-anchor", vendor, `git:${vendorOriginal.root}`);

    const monorepo = makeRepository(tempRoot, "monorepo", "packages/one/README.md", "one\n");
    commitFile(monorepo.directory, "packages/two/README.md", "two\n", "add second package", "2000-01-08T00:00:00Z");
    const monorepoSplit = join(tempRoot, "monorepo-split");
    cloneRepository(monorepo.directory, monorepoSplit);
    rmSync(join(monorepoSplit, "packages/two"), { recursive: true, force: true });
    add("monorepo-original-anchor", monorepo.directory, `git:${monorepo.root}`);
    add("monorepo-split-preserving-root-anchor", monorepoSplit, `git:${monorepo.root}`);

    const ponder = makeRepository(tempRoot, "ponder", "notes.txt", "ponder history\n");
    const ponderBackup = join(tempRoot, "ponderbak");
    cloneRepository(ponder.directory, ponderBackup);
    add("ponder-anchor", ponder.directory, `git:${ponder.root}`);
    add("ponder-backup-copy-anchor", ponderBackup, `git:${ponder.root}`);

    const sharedHistory = makeRepository(tempRoot, "shared-early-history", "README.md", "shared root\n");
    const pi = join(tempRoot, "pi");
    const piMono = join(tempRoot, "pi-mono");
    cloneRepository(sharedHistory.directory, pi);
    cloneRepository(sharedHistory.directory, piMono);
    commitFile(pi, "pi.txt", "pi divergence\n", "pi divergence", "2000-01-09T00:00:00Z");
    commitFile(piMono, "pi-mono.txt", "pi-mono divergence\n", "pi-mono divergence", "2000-01-10T00:00:00Z");
    add("pi-shared-early-history-anchor", pi, `git:${sharedHistory.root}`);
    add("pi-mono-shared-early-history-anchor", piMono, `git:${sharedHistory.root}`);

    return cases;
}

function validateFixtureShape(value: unknown): Golden[] {
    if (!Array.isArray(value)) throw new Error("git-dedup-goldens.json must be an array");
    return value.map((entry, index) => {
        if (
            entry === null ||
            typeof entry !== "object" ||
            typeof (entry as { case?: unknown }).case !== "string" ||
            typeof (entry as { expected_anchor?: unknown }).expected_anchor !== "string"
        ) {
            throw new Error(`invalid golden entry at index ${index}`);
        }
        return entry as Golden;
    });
}

function validateResolver(cases: GeneratedCase[], fixture: Golden[]): void {
    if (fixture.length !== cases.length) {
        throw new Error(`fixture has ${fixture.length} cases; generator produced ${cases.length}`);
    }
    for (const [index, generated] of cases.entries()) {
        const golden = fixture[index];
        if (golden.case !== generated.case || golden.expected_anchor !== generated.expected_anchor) {
            throw new Error(
                `fixture mismatch for ${generated.case}: expected ${generated.expected_anchor}, found ${golden.case}/${golden.expected_anchor}`,
            );
        }
        __resetProjectIdentityForTests();
        let actual = "NONE";
        try {
            actual = resolveProjectIdentityStrict(generated.directory);
        } catch {
            // NONE is the specified representation for every strict derivation failure.
        }
        if (actual !== golden.expected_anchor) {
            throw new Error(
                `TypeScript resolver mismatch for ${generated.case}: expected ${golden.expected_anchor}, got ${actual}`,
            );
        }
    }
}

const tempRoot = mkdtempSync(join(tmpdir(), "mc-git-dedup-goldens-"));
try {
    const generatedCases = makeCases(tempRoot);
    const generatedFixture: Golden[] = generatedCases.map(({ case: caseName, expected_anchor }) => ({
        case: caseName,
        expected_anchor,
    }));
    const generatedBytes = `${JSON.stringify(generatedFixture, null, 2)}\n`;

    if (existsSync(fixturePath)) {
        const existingBytes = Bun.file(fixturePath).text();
        const existing = validateFixtureShape(JSON.parse(await existingBytes));
        if (`${JSON.stringify(existing, null, 2)}\n` !== generatedBytes) {
            throw new Error(`${fixturePath} is stale; run this generator intentionally to refresh it`);
        }
        validateResolver(generatedCases, existing);
    } else {
        validateResolver(generatedCases, generatedFixture);
        mkdirSync(dirname(fixturePath), { recursive: true });
        writeFileSync(fixturePath, generatedBytes);
    }

    // The regeneration gate validates the resolver independently of fixture creation.
    validateResolver(generatedCases, generatedFixture);
    console.log(`git-dedup-goldens: validated ${generatedFixture.length} cases`);
} finally {
    __resetProjectIdentityForTests();
    rmSync(tempRoot, { recursive: true, force: true });
}

// The spec's `Fixture content pin` must equal the SHA-256 of the generated fixture.
import { createHash as __pinHash } from "node:crypto";
import { readFileSync as __pinRead } from "node:fs";
{
    const fixtureBytes = __pinRead(fixturePath);
    const actual = __pinHash("sha256").update(fixtureBytes).digest("hex");
    const specPath = join(dirname(fixturePath), "git-dedup-heuristic.md");
    const spec = __pinRead(specPath, "utf-8");
    if (!spec.includes(actual)) {
        console.error(
            `PIN MISMATCH: fixture sha256 ${actual} is not present in ${specPath}.\n` +
                "Update the 'Fixture content pin' section in the same commit as this regeneration.",
        );
        process.exit(1);
    }
    console.log(`pin verified: ${actual.slice(0, 16)}… present in spec`);
}
