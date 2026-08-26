import { Database } from "bun:sqlite";
import { formatRevisionLocator } from "../../plugin/src/features/magic-context/memory/claim-operation-contract";
import {
	computeProjectMemoryMutationToken,
	recordProjectMemoryVerification,
} from "../../plugin/src/features/magic-context/memory/storage-claim-operations";
import { Database as PluginDatabase } from "../../plugin/src/shared/sqlite";

export function openTestDb(
	path: string,
	options?: { readonly?: boolean; readwrite?: boolean },
): Database & PluginDatabase {
	const db = new Database(path, options);
	db.exec("PRAGMA busy_timeout=5000");
	// SAFETY: E2E executes in Bun, so PluginDatabase selects bun:sqlite. commentlint: allow(JUDGE)
	return db as Database & PluginDatabase;
}

export function promoteMemoryToVerified(
	dbPath: string,
	contentLike: string,
): string {
	const db = new PluginDatabase(dbPath);
	db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
	try {
		const row = db
			.prepare(
				`SELECT claim_public_ids.public_id AS publicClaimId
				   FROM claims
				   JOIN claim_public_ids ON claim_public_ids.claim_id = claims.id
				   JOIN claim_revisions ON claim_revisions.id = claims.current_revision_id
				  WHERE claim_revisions.content LIKE ?
				  ORDER BY claims.id DESC LIMIT 1`,
			)
			.get(`%${contentLike}%`) as { publicClaimId: string } | null;
		if (!row)
			throw new Error(`no project-memory claim matching "${contentLike}" found`);
		const token = computeProjectMemoryMutationToken(db, row.publicClaimId);
		const result = recordProjectMemoryVerification(
			db,
			{
				producer: "e2e-verification",
				operationKey: `verify:${row.publicClaimId}:${crypto.randomUUID()}`,
			},
			{
				token,
				revisionLocator: formatRevisionLocator(token),
				outcome: "verified",
				verifier: "e2e-harness",
			},
		);
		if (result.outcome !== "applied") {
			throw new Error(`project-memory verification returned ${result.outcome}`);
		}
		return row.publicClaimId;
	} finally {
		db.close();
	}
}
