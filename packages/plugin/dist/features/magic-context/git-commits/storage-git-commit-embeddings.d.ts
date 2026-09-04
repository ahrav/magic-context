/**
 * Embedding storage for git commits.
 *
 * Mirrors the memory-embedding storage layout but keyed by commit SHA rather
 * than memory id. Embeddings are byte-equivalent to memory embeddings (Float32
 * serialized via Float32Array.buffer), so the same cosine-similarity helpers
 * apply without conversion.
 */
import type { Database } from "../../../shared/sqlite";
import type { VectorLoadObserver } from "../search-trace";
/** `CommitEmbeddingCandidate` carries `committedAtMs` so ranking can complete
 *  before metadata hydration. */
export interface CommitEmbeddingCandidate {
    vector: Float32Array;
    committedAtMs: number;
}
export declare function saveCommitEmbedding(db: Database, sha: string, embedding: Float32Array, modelId: string): void;
export declare function hasCommitEmbedding(db: Database, sha: string, modelId: string): boolean;
/** The join to `git_commits` drops embeddings whose commit row is gone, so an
 *  orphan vector can never reach ranking. */
export declare function loadProjectCommitEmbeddings(db: Database, projectPath: string, modelId: string, onVectorLoad?: VectorLoadObserver): Map<string, CommitEmbeddingCandidate>;
/**
 * Commits with no embedding row for `modelId`, newest first.
 *
 * A commit created with an empty message carries no embeddable text: the host
 * rejects an empty item, and one rejected item fails every page of the batch's
 * application group. Because such a row is never embeddable, selecting it makes
 * the newest batch fail forever and the drain — which stops as soon as a batch
 * embeds nothing — never reaches the commits behind it. Excluding it in the
 * selection is what retires it: it is permanently not work, so it never enters
 * a batch and never blocks one. The same applies to text above a provider's
 * per-item byte cap.
 */
export declare function loadUnembeddedCommits(db: Database, projectPath: string, modelId: string, limit: number, maxInputBytes?: number): Array<{
    sha: string;
    message: string;
}>;
export declare function countEmbeddedCommits(db: Database, projectPath: string, modelId: string): number;
//# sourceMappingURL=storage-git-commit-embeddings.d.ts.map