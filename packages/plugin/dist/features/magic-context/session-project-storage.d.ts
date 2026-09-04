import type { Database } from "../../shared/sqlite";
/**
 * Persist the immutable session→project binding resolved from the host session.
 * Chunk backfills use this mapping as the project-scope authority: without it, a
 * project-wide drain cannot safely distinguish same-process sessions from other
 * projects and must not stamp arbitrary compartments with its own identity.
 */
export declare function recordSessionProjectIdentity(db: Database, sessionId: string, projectPath: string | undefined): void;
/**
 * Idempotent project-scoped heal for historical chunk rows whose stored project
 * stamp disagrees with the recorded owner. The WHERE clause is scoped to rows
 * that either currently sit under this project or truly belong to it, so normal
 * registration/backfill paths can run it cheaply without scanning unrelated
 * project partitions for every tick.
 */
export declare function repairMisScopedCompartmentChunkEmbeddingsForProject(db: Database, projectPath: string): number;
//# sourceMappingURL=session-project-storage.d.ts.map