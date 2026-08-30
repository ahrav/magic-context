/**
 * Deterministic performance-only scale corpora: a profile fully defines an
 * ordered unlabeled document stream and its hash. Documents are yielded
 * lazily so the 1M scale never materializes, and nothing here carries or
 * accepts a relevance grade.
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";
import { type DocumentKind, SYNTHETIC_SCALES, type SyntheticProfile } from "./contract";

export const SYNTHETIC_GENERATOR_VERSION = "synthetic-generator/v1";

/** Practical per-document ceiling for the generator: schema-valid but
 *  enormous word counts would make even the first yielded document hang the
 *  consumer or exhaust memory. */
export const SYNTHETIC_MAX_WORDS_PER_DOCUMENT = 1_024;

export interface SyntheticDocument {
    id: string;
    kind: DocumentKind;
    title: string;
    body: string;
}

export function splitmix32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x9e3779b9) >>> 0;
        let z = state;
        z ^= z >>> 16;
        z = Math.imul(z, 0x21f0aaad);
        z ^= z >>> 15;
        z = Math.imul(z, 0x735a2d97);
        z ^= z >>> 15;
        return (z >>> 0) / 0x1_0000_0000;
    };
}

const WORDS = [
    "queue",
    "index",
    "vector",
    "cache",
    "commit",
    "schema",
    "shard",
    "token",
    "buffer",
    "cursor",
    "replica",
    "latency",
    "filter",
    "segment",
    "payload",
    "batch",
    "stream",
    "anchor",
    "compaction",
    "retrieval",
] as const;

export class SyntheticProfileError extends Error {}

/** Generator invariants beyond the schema: version supported by THIS
 *  generator, non-empty source distribution, coherent text-size range.
 *  Release loading calls this so an unusable profile rejects at load time
 *  instead of failing mid-scale-run in a consumer. */
export function checkSyntheticProfile(profile: SyntheticProfile): void {
    if (profile.generatorVersion !== SYNTHETIC_GENERATOR_VERSION) {
        throw new SyntheticProfileError("unsupported-generator-version");
    }
    if (!(SYNTHETIC_SCALES as readonly number[]).includes(profile.scale)) {
        throw new SyntheticProfileError("unsupported-scale");
    }
    if (profile.textSize.minWords > profile.textSize.maxWords) {
        throw new SyntheticProfileError("invalid-text-size-distribution");
    }
    if (profile.textSize.maxWords > SYNTHETIC_MAX_WORDS_PER_DOCUMENT) {
        throw new SyntheticProfileError("text-size-exceeds-generator-limit");
    }
    if (Object.keys(profile.sourceDistribution).length === 0) {
        throw new SyntheticProfileError("empty-source-distribution");
    }
    // Each weight is schema-checked positive and finite, but the SUM can
    // still overflow to Infinity, which would silently send every draw to
    // the last source kind instead of the approved distribution.
    const totalWeight = Object.values(profile.sourceDistribution).reduce(
        (sum, weight) => sum + (weight ?? 0),
        0,
    );
    if (!Number.isFinite(totalWeight)) {
        throw new SyntheticProfileError("non-finite-source-distribution");
    }
}

/** Lazily yield the profile's ordered unlabeled document stream. */
export function* iterateSyntheticDocuments(
    profile: SyntheticProfile,
): Generator<SyntheticDocument> {
    checkSyntheticProfile(profile);
    const next = splitmix32(profile.seed);
    const kinds = (Object.keys(profile.sourceDistribution) as DocumentKind[]).sort((a, b) => {
        if (a < b) return -1;
        return a > b ? 1 : 0;
    });
    const totalWeight = kinds.reduce((sum, k) => sum + (profile.sourceDistribution[k] ?? 0), 0);
    const { minWords, maxWords } = profile.textSize;
    for (let i = 0; i < profile.scale; i += 1) {
        let draw = next() * totalWeight;
        let kind: DocumentKind = kinds.at(-1) as DocumentKind;
        for (const candidate of kinds) {
            draw -= profile.sourceDistribution[candidate] ?? 0;
            if (draw <= 0) {
                kind = candidate;
                break;
            }
        }
        const wordCount = minWords + Math.floor(next() * (maxWords - minWords + 1));
        const words: string[] = [];
        for (let w = 0; w < wordCount; w += 1) {
            words.push(WORDS[Math.floor(next() * WORDS.length)]);
        }
        yield {
            id: `syn:${profile.id}:${i}`,
            kind,
            title: `synthetic ${kind} ${i}`,
            body: words.join(" "),
        };
    }
}

/** Ordered stream hash over the canonical JSON of every yielded document. */
export function syntheticStreamHash(profile: SyntheticProfile): string {
    const hash = createHash("sha256");
    for (const document of iterateSyntheticDocuments(profile)) {
        hash.update(canonicalJson(document));
        hash.update("\n");
    }
    return hash.digest("hex");
}
