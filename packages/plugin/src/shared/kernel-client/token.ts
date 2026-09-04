import type { MutationToken, ReadRow } from "./wire";

/**
 * Mutation tokens keyed by `(project_root, object_id)`. A token is the
 * `known_as_of` the object was last read at; `kernel.commit` rejects a token
 * once any change event for that object lands past it, so the cache holds the
 * newest value seen per object and never invents one.
 */
export class TokenCache {
    private readonly tokens = new Map<string, Map<string, number>>();
    private readonly knownAsOf = new Map<string, number>();

    private bucket(projectRoot: string): Map<string, number> {
        let bucket = this.tokens.get(projectRoot);
        if (!bucket) {
            bucket = new Map();
            this.tokens.set(projectRoot, bucket);
        }
        return bucket;
    }

    /** Mints a token per row and advances the project's `known_as_of`. */
    remember(projectRoot: string, rows: readonly ReadRow[], knownAsOf: number): void {
        const bucket = this.bucket(projectRoot);
        for (const row of rows) this.rememberToken(bucket, row.token);
        this.advance(projectRoot, knownAsOf);
    }

    /** Commit receipts hand back tokens at the commit's sequence. */
    rememberTokens(projectRoot: string, tokens: readonly MutationToken[], knownAsOf: number): void {
        const bucket = this.bucket(projectRoot);
        for (const token of tokens) this.rememberToken(bucket, token);
        this.advance(projectRoot, knownAsOf);
    }

    private rememberToken(bucket: Map<string, number>, token: MutationToken): void {
        const existing = bucket.get(token.object_id);
        if (existing === undefined || token.known_as_of > existing) {
            bucket.set(token.object_id, token.known_as_of);
        }
    }

    private advance(projectRoot: string, knownAsOf: number): void {
        const existing = this.knownAsOf.get(projectRoot);
        if (existing === undefined || knownAsOf > existing) {
            this.knownAsOf.set(projectRoot, knownAsOf);
        }
    }

    get(projectRoot: string, objectId: string): MutationToken | undefined {
        const knownAsOf = this.tokens.get(projectRoot)?.get(objectId);
        return knownAsOf === undefined
            ? undefined
            : { object_id: objectId, known_as_of: knownAsOf };
    }

    /** The newest snapshot position read for the project, if any. */
    knownAsOfFor(projectRoot: string): number | undefined {
        return this.knownAsOf.get(projectRoot);
    }

    /** Drops every token and the cached `known_as_of` for one project. */
    dropProject(projectRoot: string): void {
        this.tokens.delete(projectRoot);
        this.knownAsOf.delete(projectRoot);
    }

    size(projectRoot: string): number {
        return this.tokens.get(projectRoot)?.size ?? 0;
    }
}
