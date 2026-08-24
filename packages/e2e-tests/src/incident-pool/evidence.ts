/**
 * Source-inventory scanning and committed verifier-evidence normalization (U3).
 *
 * Three responsibilities, all fail-closed:
 *
 * 1. Normalize the two committed mutation-artifact shapes (`mutations[].name`
 *    and `mutation_records[].id`) into one evidence view without rewriting the
 *    raw artifacts, link every record to the verifier it challenged, and
 *    derive the accepted 13-artifact/21-record snapshot from a live file scan.
 * 2. Scan the named incident sources (audit A/G headings and embedded claims,
 *    parity H2 claims, the thinking-block adjudication, the Pi declared-red
 *    synthesis suite, and the bead-recorded provenance mismatches) into stable
 *    source-item/source-claim identities with content digests, and compare
 *    them one-to-one with the committed inventory.
 * 3. Enforce the ownership matrix: every executable claim is owned by an
 *    executable catalog variant whose driver/verifier binding names a scenario
 *    module — `live` bindings must resolve to real exports, `declared`
 *    bindings must name a module that does not exist yet (landing the module
 *    forces the flip to `live`), and a bare Bun test can never satisfy a
 *    binding.
 *
 * A verifier change gates on mutation replay (R14): `changedVerifiers` names
 * the verifiers whose bytes drifted, `mutationRecordsBoundTo` yields the
 * records to replay serially, and `assertMutationReplayResults` fails unless
 * every bound crafted mutation still produced the expected red result.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
    IncidentCatalog,
    IncidentVariant,
    SourceInventory,
} from "./contract";
import { EXECUTABLE_LANES } from "./contract";
import { rowDigest } from "./history";

export const E2E_ROOT = resolve(import.meta.dir, "..", "..");
export const REPO_ROOT = resolve(E2E_ROOT, "..", "..");

export const EXPECTED_MUTATION_ARTIFACTS = 13;
export const EXPECTED_MUTATION_RECORDS = 21;

export const AUDIT_SOURCE_PATH = "docs/AUDIT-KNOWN-ISSUES.md";
export const AUDITOR_SOURCE_PATH = "AUDITOR.md";
export const PARITY_SOURCE_PATH = "packages/e2e-tests/parity-findings-s2.md";
export const THINKING_BLOCK_SOURCE_PATH =
    "packages/e2e-tests/mutations/thinking-block-adjudication.md";
export const PI_TODO_SOURCE_PATH =
    "packages/e2e-tests/tests/pi-todo-synthesis.test.ts";
export const BEAD_SOURCE_PATH = "bead:magic-context-x4l.9";

/** Task-level provenance-mismatch wording recorded from `magic-context-x4l.9`;
 *  neither claim has a demonstrated incident in the named sources, so both are
 *  `unsupported` adjudication-only inventory (AE3). */
export const WRONG_DREAMER_ARCHIVAL_WORDING =
    "wrong Dreamer archival: bead wording and verify-prompt.ts risk language allege the Dreamer archives the wrong memory, with no demonstrated incident in the named sources";
export const HISTORIAN_INCONSISTENT_STATE_WORDING =
    "historian inconsistent-state claim: bead wording beside A28 alleges the historian leaves inconsistent state, with no demonstrated failure attached";

function sha256(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

export function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Mutation evidence normalization (R11, KTD5).
// ---------------------------------------------------------------------------

export interface MutationEvidenceRecord {
    /** Normalized unique evidence id (`ev-<slug>`). */
    evidenceId: string;
    /** Matching inventory claim id (`claim-mutation-<slug>`). */
    claimId: string;
    /** Artifact path relative to the e2e package root. */
    artifactPath: string;
    /** The raw `mutations[].name` or `mutation_records[].id` value. */
    rawName: string;
    shape: "mutations" | "mutation_records";
    /** Repo-relative path of the verifier this mutation challenged. */
    verifierPath: string;
    /** Committed replay command for the R14 contributor gate. */
    replayCommand: string;
    /** Digest of the raw record object, for drift detection. */
    recordDigest: string;
}

export interface MutationEvidenceArtifact {
    path: string;
    contentDigest: string;
    records: MutationEvidenceRecord[];
}

export interface EvidenceView {
    artifacts: MutationEvidenceArtifact[];
    records: MutationEvidenceRecord[];
    /** Repo-relative verifier path -> sha256 of its current bytes. */
    verifierDigests: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${label} must be a non-empty string`);
    }
    return value;
}

const E2E_TEST_PATH_RE = /(?:^|[\s'"])((?:tests|scripts)\/[\w./-]+\.ts)/;

/** Resolve the verifier a `mutations[]`-shaped record challenged from the
 *  artifact's committed run command. */
function verifierFromCommand(command: string, label: string): string {
    if (command.startsWith("cargo test -p mc-module")) {
        return "crates/mc-module/src/differential_goldens.rs";
    }
    const match = command.match(E2E_TEST_PATH_RE);
    if (!match)
        throw new Error(
            `${label}: cannot resolve a verifier from command ${JSON.stringify(command)}`,
        );
    return `packages/e2e-tests/${match[1]}`;
}

/** Resolve the verifier a `mutation_records[]`-shaped record challenged: the
 *  candidate test file (from the reverted-rerun command) that contains the
 *  record's `must_fail` test id. */
function verifierFromMustFail(
    repoRoot: string,
    rerunCommand: string,
    mustFail: string,
    label: string,
): string {
    const candidates = [
        ...rerunCommand.matchAll(/tests\/[\w./-]+\.test\.ts/g),
    ].map((m) => m[0]);
    if (candidates.length === 0) {
        throw new Error(`${label}: reverted_rerun_command names no test files`);
    }
    for (const candidate of candidates) {
        const path = resolve(repoRoot, "packages/e2e-tests", candidate);
        if (existsSync(path) && readFileSync(path, "utf8").includes(mustFail)) {
            return `packages/e2e-tests/${candidate}`;
        }
    }
    throw new Error(
        `${label}: no candidate test file contains must_fail id ${mustFail}`,
    );
}

export function loadMutationEvidence(
    e2eRoot: string = E2E_ROOT,
    repoRoot: string = REPO_ROOT,
): EvidenceView {
    const mutationsDir = resolve(e2eRoot, "mutations");
    const files = readdirSync(mutationsDir)
        .filter((name) => name.endsWith(".json"))
        .sort();

    const artifacts: MutationEvidenceArtifact[] = [];
    const evidenceIds = new Set<string>();
    for (const file of files) {
        const artifactPath = `mutations/${file}`;
        const text = readFileSync(resolve(mutationsDir, file), "utf8");
        let raw: unknown;
        try {
            raw = JSON.parse(text) as unknown;
        } catch (error) {
            throw new Error(
                `${artifactPath} is not valid JSON: ${String(error)}`,
            );
        }
        if (!isRecord(raw))
            throw new Error(`${artifactPath} must be a JSON object`);

        const records: MutationEvidenceRecord[] = [];
        if (Array.isArray(raw.mutations)) {
            const command = requireString(
                raw.command,
                `${artifactPath}.command`,
            );
            for (const [index, rawRecord] of raw.mutations.entries()) {
                const label = `${artifactPath}.mutations[${index}]`;
                if (!isRecord(rawRecord))
                    throw new Error(`${label} must be an object`);
                const name = requireString(rawRecord.name, `${label}.name`);
                records.push({
                    evidenceId: `ev-${slugify(name)}`,
                    claimId: `claim-mutation-${slugify(name)}`,
                    artifactPath,
                    rawName: name,
                    shape: "mutations",
                    verifierPath: verifierFromCommand(command, label),
                    replayCommand: command,
                    recordDigest: rowDigest(rawRecord),
                });
            }
        } else if (Array.isArray(raw.mutation_records)) {
            for (const [index, rawRecord] of raw.mutation_records.entries()) {
                const label = `${artifactPath}.mutation_records[${index}]`;
                if (!isRecord(rawRecord))
                    throw new Error(`${label} must be an object`);
                const id = requireString(rawRecord.id, `${label}.id`);
                const mustFail = requireString(
                    rawRecord.must_fail,
                    `${label}.must_fail`,
                );
                const rerun = requireString(
                    rawRecord.reverted_rerun_command,
                    `${label}.reverted_rerun_command`,
                );
                records.push({
                    evidenceId: `ev-${slugify(id)}`,
                    claimId: `claim-mutation-${slugify(id)}`,
                    artifactPath,
                    rawName: id,
                    shape: "mutation_records",
                    verifierPath: verifierFromMustFail(
                        repoRoot,
                        rerun,
                        mustFail,
                        label,
                    ),
                    replayCommand: rerun,
                    recordDigest: rowDigest(rawRecord),
                });
            }
        } else {
            throw new Error(
                `${artifactPath}: unknown mutation artifact shape (expected mutations[] or mutation_records[])`,
            );
        }

        if (records.length === 0)
            throw new Error(
                `${artifactPath}: artifact contains no mutation records`,
            );
        for (const record of records) {
            if (evidenceIds.has(record.evidenceId)) {
                throw new Error(
                    `duplicate normalized evidence id ${record.evidenceId} (${record.artifactPath})`,
                );
            }
            evidenceIds.add(record.evidenceId);
        }
        artifacts.push({
            path: artifactPath,
            contentDigest: sha256(text),
            records,
        });
    }

    const records = artifacts.flatMap((artifact) => artifact.records);
    const verifierDigests: Record<string, string> = {};
    for (const record of records) {
        if (record.verifierPath in verifierDigests) continue;
        const path = resolve(repoRoot, record.verifierPath);
        if (!existsSync(path)) {
            throw new Error(
                `evidence record ${record.evidenceId} links a missing verifier ${record.verifierPath}`,
            );
        }
        verifierDigests[record.verifierPath] = sha256(
            readFileSync(path, "utf8"),
        );
    }
    return { artifacts, records, verifierDigests };
}

/** Assert the accepted mutation snapshot (R11): 13 JSON artifacts, 21 records. */
export function assertEvidenceSnapshot(view: EvidenceView): void {
    if (view.artifacts.length !== EXPECTED_MUTATION_ARTIFACTS) {
        throw new Error(
            `expected ${EXPECTED_MUTATION_ARTIFACTS} mutation artifacts, found ${view.artifacts.length}`,
        );
    }
    if (view.records.length !== EXPECTED_MUTATION_RECORDS) {
        throw new Error(
            `expected ${EXPECTED_MUTATION_RECORDS} mutation records, found ${view.records.length}`,
        );
    }
}

// ---------------------------------------------------------------------------
// Source scanning (R1): stable item/claim identities plus content digests.
// ---------------------------------------------------------------------------

export interface ScannedClaim {
    id: string;
    digest: string;
}

export interface ScannedItem {
    id: string;
    sourcePath: string;
    digest: string;
    claims: ScannedClaim[];
}

const AUDIT_HEADING_RE = /^#{2,3} (A\d+b?|G\d+)[.:] /;
const ANY_HEADING_RE = /^#{2,3} /;

/** One claim per A/G heading, embedded `> **...**` note, and deferred-fix
 *  bullet, in document order, digesting each claim's own text block. */
export function scanAuditClaims(text: string): ScannedClaim[] {
    const lines = text.split("\n");
    const claims: Array<{ line: number; claim: ScannedClaim }> = [];

    for (let i = 0; i < lines.length; i++) {
        const heading = lines[i]!.match(AUDIT_HEADING_RE);
        if (heading) {
            let end = i + 1;
            while (end < lines.length && !ANY_HEADING_RE.test(lines[end]!))
                end++;
            claims.push({
                line: i,
                claim: {
                    id: `claim-audit-${heading[1]!.toLowerCase()}`,
                    digest: sha256(lines.slice(i, end).join("\n")),
                },
            });
            continue;
        }
        if (
            /^> \*\*/.test(lines[i]!) &&
            (i === 0 || !lines[i - 1]!.startsWith(">"))
        ) {
            let end = i + 1;
            while (end < lines.length && lines[end]!.startsWith(">")) end++;
            const block = lines.slice(i, end).join("\n");
            const lead = block.match(/^> \*\*([^*]+?):?\*\*/);
            if (!lead)
                throw new Error(
                    `audit blockquote note at line ${i + 1} lacks a bold lead`,
                );
            claims.push({
                line: i,
                claim: {
                    id: `claim-audit-note-${slugify(lead[1]!)}`,
                    digest: sha256(block),
                },
            });
        }
    }

    const deferredStart = lines.findIndex((line) =>
        line.startsWith("## Deferred low-priority fixes"),
    );
    if (deferredStart === -1)
        throw new Error("audit source lost its deferred-fixes section");
    let deferredEnd = deferredStart + 1;
    while (
        deferredEnd < lines.length &&
        !ANY_HEADING_RE.test(lines[deferredEnd]!)
    )
        deferredEnd++;
    for (let i = deferredStart; i < deferredEnd; i++) {
        if (!/^- \*\*/.test(lines[i]!)) continue;
        let end = i + 1;
        while (end < deferredEnd && !/^- \*\*/.test(lines[end]!)) end++;
        const block = lines.slice(i, end).join("\n").replace(/\n+$/, "");
        const lead = block.match(/^- \*\*([^*]+?)\*\*/);
        if (!lead)
            throw new Error(
                `audit deferred bullet at line ${i + 1} lacks a bold lead`,
            );
        claims.push({
            line: i,
            claim: {
                id: `claim-audit-fix-${slugify(lead[1]!)}`,
                digest: sha256(block),
            },
        });
    }

    claims.sort((a, b) => a.line - b.line);
    return claims.map((entry) => entry.claim);
}

/** One claim per H2 verdict entry in `parity-findings-s2.md`. */
export function scanParityClaims(text: string): ScannedClaim[] {
    const lines = text.split("\n");
    const claims: ScannedClaim[] = [];
    for (let i = 0; i < lines.length; i++) {
        const heading = lines[i]!.match(/^## (.+)$/);
        if (!heading) continue;
        let end = i + 1;
        while (end < lines.length && !/^## /.test(lines[end]!)) end++;
        const title = heading[1]!.split("—")[0]!.trim();
        claims.push({
            id: `claim-parity-${slugify(title)}`,
            digest: sha256(lines.slice(i, end).join("\n")),
        });
    }
    return claims;
}

/** Enumerate every named source into stable items/claims with digests. */
export function scanSources(
    repoRoot: string = REPO_ROOT,
    e2eRoot: string = E2E_ROOT,
): ScannedItem[] {
    const readSource = (repoRelative: string): string =>
        readFileSync(resolve(repoRoot, repoRelative), "utf8");

    const auditText = readSource(AUDIT_SOURCE_PATH);
    const auditorText = readSource(AUDITOR_SOURCE_PATH);
    const parityText = readSource(PARITY_SOURCE_PATH);
    const thinkingText = readSource(THINKING_BLOCK_SOURCE_PATH);
    const piTodoText = readSource(PI_TODO_SOURCE_PATH);

    const items: ScannedItem[] = [
        {
            id: "src-audit-known-issues",
            sourcePath: AUDIT_SOURCE_PATH,
            digest: sha256(auditText),
            claims: scanAuditClaims(auditText),
        },
        // R1: AUDITOR.md is an audit guide, not a findings ledger — exactly one
        // guide-level row and no finding claims.
        {
            id: "src-auditor-guide",
            sourcePath: AUDITOR_SOURCE_PATH,
            digest: sha256(auditorText),
            claims: [],
        },
        {
            id: "src-parity-findings-s2",
            sourcePath: PARITY_SOURCE_PATH,
            digest: sha256(parityText),
            claims: scanParityClaims(parityText),
        },
        {
            id: "src-thinking-block-adjudication",
            sourcePath: THINKING_BLOCK_SOURCE_PATH,
            digest: sha256(thinkingText),
            claims: [
                {
                    id: "claim-thinking-block-flake",
                    digest: sha256(thinkingText),
                },
            ],
        },
        {
            id: "src-pi-todo-declared-red-suite",
            sourcePath: PI_TODO_SOURCE_PATH,
            digest: sha256(piTodoText),
            claims: [
                {
                    id: "claim-pi-todo-synthesis-gap",
                    digest: sha256(piTodoText),
                },
            ],
        },
        {
            id: "src-bead-magic-context-x4l-9",
            sourcePath: BEAD_SOURCE_PATH,
            digest: sha256(
                `${WRONG_DREAMER_ARCHIVAL_WORDING}\n${HISTORIAN_INCONSISTENT_STATE_WORDING}`,
            ),
            claims: [
                {
                    id: "claim-bead-wrong-dreamer-archival",
                    digest: sha256(WRONG_DREAMER_ARCHIVAL_WORDING),
                },
                {
                    id: "claim-bead-historian-inconsistent-state",
                    digest: sha256(HISTORIAN_INCONSISTENT_STATE_WORDING),
                },
            ],
        },
    ];

    const view = loadMutationEvidence(e2eRoot, repoRoot);
    for (const artifact of view.artifacts) {
        items.push({
            id: `src-mutation-${slugify(artifact.path.replace(/^mutations\//, "").replace(/\.json$/, ""))}`,
            sourcePath: `packages/e2e-tests/${artifact.path}`,
            digest: artifact.contentDigest,
            claims: artifact.records.map((record) => ({
                id: record.claimId,
                digest: record.recordDigest,
            })),
        });
    }
    return items;
}

/** Compare the committed inventory with a live source scan, one-to-one. */
export function verifySourceCompleteness(
    inventory: SourceInventory,
    scanned: ScannedItem[],
): void {
    const inventoryItems = new Map(
        inventory.items.map((item) => [item.id, item] as const),
    );
    for (const item of scanned) {
        const committed = inventoryItems.get(item.id);
        if (!committed)
            throw new Error(`source item missing from inventory: ${item.id}`);
        if (committed.source_path !== item.sourcePath) {
            throw new Error(
                `source item ${item.id} path drifted: ${committed.source_path} != ${item.sourcePath}`,
            );
        }
        if (committed.content_digest !== item.digest) {
            throw new Error(
                `source item ${item.id} content drifted from its accepted digest`,
            );
        }
        const committedClaims = new Map(
            committed.claims.map((claim) => [claim.id, claim] as const),
        );
        for (const claim of item.claims) {
            const committedClaim = committedClaims.get(claim.id);
            if (!committedClaim)
                throw new Error(
                    `source claim missing from inventory: ${claim.id}`,
                );
            if (committedClaim.content_digest !== claim.digest) {
                throw new Error(
                    `source claim ${claim.id} content drifted from its accepted digest`,
                );
            }
        }
        for (const claimId of committedClaims.keys()) {
            if (!item.claims.some((claim) => claim.id === claimId)) {
                throw new Error(
                    `inventory claim ${claimId} has no live source counterpart`,
                );
            }
        }
        if (committed.claims.length !== item.claims.length) {
            throw new Error(`source item ${item.id} claim count drifted`);
        }
    }
    for (const itemId of inventoryItems.keys()) {
        if (!scanned.some((item) => item.id === itemId)) {
            throw new Error(
                `inventory item ${itemId} has no live source counterpart`,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Ownership matrix (U3 approach 4): every executable disposition has a
// registry-callable owner; bindings are scenario modules, never bare tests.
// ---------------------------------------------------------------------------

const EXECUTABLE_DISPOSITIONS = new Set([
    "executable_accepted_behavior",
    "executable_fixed_regression",
    "executable_known_defect",
]);

const SCENARIO_BINDING_RE =
    /^(src\/incident-pool\/scenarios\/[\w-]+\.ts)#([A-Za-z][A-Za-z0-9]*)$/;

function parseBinding(
    reference: string,
    label: string,
): { path: string; symbol: string } {
    const match = reference.match(SCENARIO_BINDING_RE);
    if (!match) {
        throw new Error(
            `${label}: binding ${JSON.stringify(reference)} must be a scenario module reference ` +
                "(src/incident-pool/scenarios/<module>.ts#<export>); an existing Bun test alone cannot satisfy an executable binding",
        );
    }
    return { path: match[1]!, symbol: match[2]! };
}

function checkBindingLiveness(
    e2eRoot: string,
    variantId: string,
    status: "declared" | "live",
    reference: string,
): void {
    const { path, symbol } = parseBinding(reference, `variant ${variantId}`);
    const absolute = resolve(e2eRoot, path);
    if (status === "declared") {
        if (existsSync(absolute)) {
            throw new Error(
                `variant ${variantId}: binding_status is declared but ${path} exists; flip the binding to live`,
            );
        }
        return;
    }
    if (!existsSync(absolute)) {
        throw new Error(
            `variant ${variantId}: live binding names a missing module ${path}`,
        );
    }
    const moduleText = readFileSync(absolute, "utf8");
    const exportRe = new RegExp(
        `export (?:async )?(?:function|const) ${symbol}\\b`,
    );
    if (!exportRe.test(moduleText)) {
        throw new Error(
            `variant ${variantId}: live binding ${path} does not export ${symbol}`,
        );
    }
}

export function verifyOwnershipMatrix(
    inventory: SourceInventory,
    catalog: IncidentCatalog,
    e2eRoot: string = E2E_ROOT,
): void {
    const executableVariantsByClaim = new Map<string, IncidentVariant[]>();
    for (const family of catalog.families) {
        for (const variant of family.variants) {
            if (!EXECUTABLE_LANES.includes(variant.lane)) continue;
            for (const claimId of variant.source_claims) {
                const list = executableVariantsByClaim.get(claimId) ?? [];
                list.push(variant);
                executableVariantsByClaim.set(claimId, list);
            }
        }
    }

    for (const item of inventory.items) {
        for (const claim of item.claims) {
            const owners = executableVariantsByClaim.get(claim.id) ?? [];
            if (EXECUTABLE_DISPOSITIONS.has(claim.disposition)) {
                if (claim.family_links.length === 0 || owners.length === 0) {
                    throw new Error(
                        `executable claim ${claim.id} has no owner in the implementation matrix (no executable variant references it)`,
                    );
                }
            } else if (
                claim.disposition === "unsupported" &&
                owners.length > 0
            ) {
                // AE3: unsupported provenance-mismatch claims stay adjudication-only.
                throw new Error(
                    `unsupported claim ${claim.id} must not have an executable target`,
                );
            }
        }
    }

    for (const family of catalog.families) {
        for (const variant of family.variants) {
            const binding = variant.verifier_binding;
            if (binding === null) continue;
            checkBindingLiveness(
                e2eRoot,
                variant.id,
                binding.binding_status,
                binding.driver,
            );
            checkBindingLiveness(
                e2eRoot,
                variant.id,
                binding.binding_status,
                binding.verifier,
            );
        }
    }
}

/** Cross-check that inventory mutation claims and live evidence records agree. */
export function crossCheckEvidenceInventory(
    inventory: SourceInventory,
    view: EvidenceView,
): void {
    const evidenceClaims = new Set(
        view.records.map((record) => record.claimId),
    );
    const inventoryClaims = new Set(
        inventory.items
            .filter((item) => item.id.startsWith("src-mutation-"))
            .flatMap((item) => item.claims.map((claim) => claim.id)),
    );
    for (const claimId of evidenceClaims) {
        if (!inventoryClaims.has(claimId))
            throw new Error(
                `mutation record ${claimId} missing from inventory`,
            );
    }
    for (const claimId of inventoryClaims) {
        if (!evidenceClaims.has(claimId))
            throw new Error(
                `inventory mutation claim ${claimId} has no live record`,
            );
    }
    if (inventoryClaims.size !== EXPECTED_MUTATION_RECORDS) {
        throw new Error(
            `inventory carries ${inventoryClaims.size} mutation claims; expected ${EXPECTED_MUTATION_RECORDS}`,
        );
    }
}

// ---------------------------------------------------------------------------
// Verifier-change mutation replay gate (R14).
// ---------------------------------------------------------------------------

/** Verifier paths whose bytes drifted from the accepted digests. */
export function changedVerifiers(
    acceptedDigests: Record<string, string>,
    currentDigests: Record<string, string>,
): string[] {
    const changed: string[] = [];
    const paths = new Set([
        ...Object.keys(acceptedDigests),
        ...Object.keys(currentDigests),
    ]);
    for (const path of paths) {
        if (acceptedDigests[path] !== currentDigests[path]) changed.push(path);
    }
    return changed.sort();
}

export function mutationRecordsBoundTo(
    view: EvidenceView,
    verifierPath: string,
): MutationEvidenceRecord[] {
    return view.records.filter(
        (record) => record.verifierPath === verifierPath,
    );
}

/**
 * Contributor gate: after replaying a changed verifier's bound mutations
 * serially, every bound record must have produced the expected red result.
 * `true` means the crafted invalid state was rejected (the mutated run failed
 * as committed); anything else fails the gate.
 */
export function assertMutationReplayResults(
    view: EvidenceView,
    verifierPath: string,
    replayProducedExpectedRed: Record<string, boolean>,
): void {
    const bound = mutationRecordsBoundTo(view, verifierPath);
    if (bound.length === 0)
        throw new Error(
            `no mutation records are bound to verifier ${verifierPath}`,
        );
    const failures: string[] = [];
    for (const record of bound) {
        if (replayProducedExpectedRed[record.evidenceId] !== true)
            failures.push(record.evidenceId);
    }
    if (failures.length > 0) {
        throw new Error(
            `changed verifier ${verifierPath} failed mutation replay: ${failures.join(", ")} did not produce the expected red result`,
        );
    }
}

// ---------------------------------------------------------------------------
// One-stop validation for the committed repository state.
// ---------------------------------------------------------------------------

export function validateEvidenceAndSources(
    inventory: SourceInventory,
    catalog: IncidentCatalog,
    repoRoot: string = REPO_ROOT,
    e2eRoot: string = E2E_ROOT,
): EvidenceView {
    const view = loadMutationEvidence(e2eRoot, repoRoot);
    assertEvidenceSnapshot(view);
    verifySourceCompleteness(inventory, scanSources(repoRoot, e2eRoot));
    crossCheckEvidenceInventory(inventory, view);
    verifyOwnershipMatrix(inventory, catalog, e2eRoot);
    return view;
}
