/**
 * Caller must hold a write transaction.
 * Call `db.transaction(fn).immediate()` to hold the required write transaction.
 *
 * Resolution checks a full commit OID before weaker evidence.
 * Resolution checks a tree OID before a stable patch ID.
 * Multiple candidates at one level return `ambiguous` without consulting weaker evidence.
 * `patch_id` is the weakest resolution level.
 */

import type { Database } from "../../../shared/sqlite";
import {
    GIT_ANCHOR_REPRESENTATION_IDENTITY_COLUMNS,
    type GitAnchorRepresentationKind,
} from "../storage-claim-applicability-schema.ts";
import type { GitAnchorCapture } from "./git-anchor-reader.ts";

/** `GIT_OID_PROTOCOL` identifies the versioned encoding for raw Git OIDs and paths. */
export const GIT_OID_PROTOCOL = "git-oid-v1";

export interface GitAnchorRepresentationInput {
    kind: GitAnchorRepresentationKind;
    objectFormat?: "sha1" | "sha256";
    protocol: string;
    namespace?: string;
    value: string;
}

const OID_LENGTH_BY_FORMAT = { sha1: 40, sha256: 64 } as const;

function assertFullOid(value: string, objectFormat: "sha1" | "sha256", label: string): void {
    const expected = OID_LENGTH_BY_FORMAT[objectFormat];
    if (value.length !== expected || !/^[0-9a-f]+$/.test(value)) {
        throw new Error(
            `${label} must be a full ${expected}-char ${objectFormat} OID; abbreviations are rejected as persisted identities: "${value}"`,
        );
    }
}

/**
 * The returned values follow `GIT_ANCHOR_REPRESENTATION_IDENTITY_COLUMNS` after `anchor_id`.
 * The in-batch deduplication key and idempotency pre-check use these identity values.
 * The deduplication key and idempotency pre-check must use the DDL UNIQUE-constraint identity columns.
 */
function representationIdentityValues(
    representation: GitAnchorRepresentationInput,
): [string, string, string, string, string] {
    return [
        representation.kind,
        representation.objectFormat ?? "",
        representation.protocol,
        representation.namespace ?? "",
        representation.value,
    ];
}

function representationKey(representation: GitAnchorRepresentationInput): string {
    return representationIdentityValues(representation).join("\x1f");
}

function insertRepresentation(
    db: Database,
    anchorId: number,
    projectId: number,
    representation: GitAnchorRepresentationInput,
    nowMs: number,
): void {
    if (representation.kind === "commit_oid" || representation.kind === "tree_oid") {
        if (representation.objectFormat === undefined) {
            throw new Error(`${representation.kind} representation requires an objectFormat`);
        }
        assertFullOid(representation.value, representation.objectFormat, representation.kind);
    }
    db.prepare(
        `INSERT INTO git_anchor_representations
            (anchor_id, project_id, kind, object_format, protocol, namespace, value, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        anchorId,
        projectId,
        representation.kind,
        representation.objectFormat ?? "",
        representation.protocol,
        representation.namespace ?? "",
        representation.value,
        nowMs,
    );
}

export interface CreateGitAnchorInput {
    projectId: number;
    representations: GitAnchorRepresentationInput[];
}

/** Caller must hold a write transaction; the function returns the new anchor ID. */
export function createGitAnchorInCurrentTransaction(
    db: Database,
    input: CreateGitAnchorInput,
): number {
    const nowMs = Date.now();
    const result = db
        .prepare("INSERT INTO git_anchors (project_id, created_at) VALUES (?, ?)")
        .run(input.projectId, nowMs);
    const anchorId = Number(result.lastInsertRowid);
    if (!Number.isSafeInteger(anchorId) || anchorId <= 0) {
        throw new Error(
            `git anchor insert did not produce a safe row id: ${String(result.lastInsertRowid)}`,
        );
    }
    const seen = new Set<string>();
    for (const representation of input.representations) {
        const key = representationKey(representation);
        if (seen.has(key)) continue;
        seen.add(key);
        insertRepresentation(db, anchorId, input.projectId, representation, nowMs);
    }
    return anchorId;
}

/**
 * Caller must hold a write transaction; the function appends representations to an existing anchor.
 * The function skips existing representation rows, making repeated calls idempotent.
 * project id derives from the anchor row.
 */
export function appendGitAnchorRepresentationsInCurrentTransaction(
    db: Database,
    anchorId: number,
    representations: GitAnchorRepresentationInput[],
): void {
    const anchor = db.prepare("SELECT project_id FROM git_anchors WHERE id = ?").get(anchorId) as
        | { project_id: number }
        | undefined;
    if (anchor === undefined) {
        throw new Error(`git anchor ${anchorId} does not exist`);
    }
    const nowMs = Date.now();
    const existsStmt = db.prepare(
        `SELECT 1 FROM git_anchor_representations
         WHERE ${GIT_ANCHOR_REPRESENTATION_IDENTITY_COLUMNS.map((column) => `${column} = ?`).join(" AND ")}`,
    );
    const seen = new Set<string>();
    for (const representation of representations) {
        const key = representationKey(representation);
        if (seen.has(key)) continue;
        seen.add(key);
        const exists = existsStmt.get(anchorId, ...representationIdentityValues(representation));
        if (exists !== undefined && exists !== null) continue;
        insertRepresentation(db, anchorId, anchor.project_id, representation, nowMs);
    }
}

/**
 */
export function anchorRepresentationsFromCapture(
    capture: GitAnchorCapture,
): GitAnchorRepresentationInput[] {
    assertFullOid(capture.commitOid, capture.objectFormat, "commit_oid");
    assertFullOid(capture.treeOid, capture.objectFormat, "tree_oid");
    const representations: GitAnchorRepresentationInput[] = [
        {
            kind: "commit_oid",
            objectFormat: capture.objectFormat,
            protocol: GIT_OID_PROTOCOL,
            value: capture.commitOid,
        },
        {
            kind: "tree_oid",
            objectFormat: capture.objectFormat,
            protocol: GIT_OID_PROTOCOL,
            value: capture.treeOid,
        },
    ];
    if (capture.stablePatchId !== null) {
        representations.push({
            kind: "patch_id",
            protocol: capture.patchIdProtocol,
            value: capture.stablePatchId,
        });
    }
    for (const path of capture.changedPaths) {
        representations.push({ kind: "path", protocol: GIT_OID_PROTOCOL, value: path });
    }
    return representations;
}

export type GitAnchorResolution =
    | { status: "resolved"; anchorId: number }
    | { status: "ambiguous"; kind: GitAnchorRepresentationKind; candidates: number[] }
    | { status: "unresolved" };

export interface ResolveGitAnchorInput {
    projectId: number;
    capture?: GitAnchorCapture;
    representations?: GitAnchorRepresentationInput[];
}

const RESOLUTION_LEVELS: readonly GitAnchorRepresentationKind[] = [
    "commit_oid",
    "tree_oid",
    "patch_id",
];

export function resolveGitAnchor(db: Database, input: ResolveGitAnchorInput): GitAnchorResolution {
    const evidence = [
        ...(input.capture !== undefined ? anchorRepresentationsFromCapture(input.capture) : []),
        ...(input.representations ?? []),
    ];
    const candidateStmt = db.prepare(
        `SELECT DISTINCT anchor_id FROM git_anchor_representations
         WHERE project_id = ? AND kind = ? AND object_format = ? AND protocol = ? AND value = ?`,
    );
    for (const kind of RESOLUTION_LEVELS) {
        const level = evidence.filter((representation) => representation.kind === kind);
        if (level.length === 0) continue;
        const candidates = new Set<number>();
        for (const representation of level) {
            const rows = candidateStmt.all(
                input.projectId,
                kind,
                representation.objectFormat ?? "",
                representation.protocol,
                representation.value,
            ) as Array<{ anchor_id: number }>;
            for (const row of rows) candidates.add(row.anchor_id);
        }
        if (candidates.size === 1) {
            return { status: "resolved", anchorId: candidates.values().next().value as number };
        }
        if (candidates.size > 1) {
            return { status: "ambiguous", kind, candidates: [...candidates].sort((a, b) => a - b) };
        }
    }
    return { status: "unresolved" };
}
