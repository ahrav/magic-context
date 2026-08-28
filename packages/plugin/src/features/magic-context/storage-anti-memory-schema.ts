/** Revision-bound payload for rejected-approach claims. */

import type { Database } from "../../shared/sqlite";
import { ANTI_MEMORY_CATEGORY } from "./memory/constants.ts";

export const ANTI_MEMORY_TABLES = ["claim_anti_memory_revision_payloads"] as const;

export function createAntiMemorySchema(db: Database): void {
    // Interpolation is a compile-time constant, not caller input.
    // pi-lens-ignore: sql-injection
    db.exec(`
    CREATE TABLE claim_anti_memory_revision_payloads (
        revision_id INTEGER PRIMARY KEY,
        claim_id INTEGER NOT NULL,
        trigger TEXT NOT NULL CHECK (length(trim(trigger)) > 0),
        rejected_strategy TEXT NOT NULL CHECK (length(trim(rejected_strategy)) > 0),
        rejection_reason TEXT NOT NULL CHECK (length(trim(rejection_reason)) > 0),
        safer_alternative TEXT CHECK (
            safer_alternative IS NULL OR length(trim(safer_alternative)) > 0
        ),
        preconditions TEXT CHECK (preconditions IS NULL OR length(trim(preconditions)) > 0),
        attempted_approach TEXT CHECK (
            attempted_approach IS NULL OR length(trim(attempted_approach)) > 0
        ),
        observed_failure TEXT CHECK (
            observed_failure IS NULL OR length(trim(observed_failure)) > 0
        ),
        root_cause TEXT CHECK (root_cause IS NULL OR length(trim(root_cause)) > 0),
        recovery TEXT CHECK (recovery IS NULL OR length(trim(recovery)) > 0),
        non_applicable_when TEXT CHECK (
            non_applicable_when IS NULL OR length(trim(non_applicable_when)) > 0
        ),
        created_at INTEGER NOT NULL,
        FOREIGN KEY (claim_id, revision_id)
            REFERENCES claim_revisions(claim_id, id) ON DELETE RESTRICT
    );

    CREATE TRIGGER claim_anti_memory_payloads_append_only_update
    BEFORE UPDATE ON claim_anti_memory_revision_payloads
    BEGIN SELECT RAISE(ABORT, 'claim_anti_memory_revision_payloads is append-only: updates are not allowed'); END;
    CREATE TRIGGER claim_anti_memory_payloads_append_only_delete
    BEFORE DELETE ON claim_anti_memory_revision_payloads
    BEGIN SELECT RAISE(ABORT, 'claim_anti_memory_revision_payloads is append-only: deletes are not allowed'); END;
    CREATE TRIGGER claim_anti_memory_payloads_append_only_insert_collision
    BEFORE INSERT ON claim_anti_memory_revision_payloads
    WHEN EXISTS (
        SELECT 1 FROM claim_anti_memory_revision_payloads WHERE revision_id = NEW.revision_id
    )
    BEGIN SELECT RAISE(ABORT, 'claim_anti_memory_revision_payloads is append-only: key collisions cannot replace rows'); END;

    CREATE TRIGGER claim_anti_memory_payloads_category_guard
    BEFORE INSERT ON claim_anti_memory_revision_payloads
    WHEN (
        SELECT category FROM claim_memory_revision_attributes
        WHERE revision_id = NEW.revision_id
    ) IS NOT '${ANTI_MEMORY_CATEGORY}'
    BEGIN SELECT RAISE(ABORT, 'claim_anti_memory_revision_payloads requires a rejected-approach revision'); END;
    `);
}
