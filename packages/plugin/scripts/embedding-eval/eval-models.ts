/**
 * Rank candidate embedding models over the labelled release from
 * `build-release.ts`, using PHYSICAL-rank metrics and a paired bootstrap.
 *
 * Why physical rank: the committed v1 benchmark scores condensed `nDCG@10`,
 * which re-ranks judged entries inside the cutoff window. With one judged
 * relevant document per query that returns 1.0 whether the answer sits at
 * physical rank 1 or rank 10, which is why six different models tied at a
 * perfect score. Here gain is discounted by the document's real position, so
 * moving the answer up the list changes the score. `selfCheck` proves that
 * property before any model loads; if it fails, no number below means anything.
 *
 * Why a lexical arm: on identifier queries, term matching is a strong baseline.
 * Omitting it credits an encoder for work the existing FTS lane already does.
 *
 * Why a bootstrap: a point estimate over a few dozen topics is not a result. The
 * interval decides whether a difference is separable from zero at this topic
 * count.
 *
 * The holdout partition is never read here. Seal it until a candidate is frozen.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { env, pipeline } from "@huggingface/transformers";
import type { Release, ReleaseTopic } from "./build-release";

const REPO = resolve(import.meta.dirname, "../../../..");
env.cacheDir = join(REPO, ".cache/embedding-eval-models");
env.allowLocalModels = false;

const NDCG_CUTOFF = 10;
const RECALL_CUTOFFS = [10, 50] as const;
const BOOTSTRAP_RESAMPLES = 10_000;
const BOOTSTRAP_SEED = 12_345;
const EMBED_BATCH = 48;
/** Linear gain, matching the repository's existing metric policy. */
const gain = (grade: number): number => grade;

const release = JSON.parse(
    readFileSync(join(REPO, "packages/plugin/scripts/embedding-eval/release.json"), "utf8"),
) as Release;

const gradesByTopic = new Map<string, Map<string, number>>();
for (const judgment of release.judgments) {
    let topic = gradesByTopic.get(judgment.topicId);
    if (!topic) {
        topic = new Map();
        gradesByTopic.set(judgment.topicId, topic);
    }
    topic.set(judgment.docId, judgment.grade);
}

interface TopicScores {
    ndcg: number;
    reciprocalRank: number;
    successAt1: number;
    recall: Record<number, number>;
    goldRank: number;
}

function scoreTopic(topicId: string, ranked: readonly string[]): TopicScores {
    const judged = gradesByTopic.get(topicId) ?? new Map<string, number>();

    let dcg = 0;
    for (let i = 0; i < Math.min(NDCG_CUTOFF, ranked.length); i++) {
        dcg += gain(judged.get(ranked[i]!) ?? 0) / Math.log2(i + 2);
    }
    let idcg = 0;
    for (const [i, grade] of [...judged.values()]
        .sort((a, b) => b - a)
        .slice(0, NDCG_CUTOFF)
        .entries()) {
        idcg += gain(grade) / Math.log2(i + 2);
    }

    const relevantTotal = [...judged.values()].filter((g) => g >= 1).length;
    const recall: Record<number, number> = {};
    for (const k of RECALL_CUTOFFS) {
        const hits = ranked.slice(0, k).filter((id) => (judged.get(id) ?? 0) >= 1).length;
        recall[k] = relevantTotal === 0 ? 0 : hits / relevantTotal;
    }

    const firstRelevant = ranked.findIndex((id) => (judged.get(id) ?? 0) >= 1) + 1;
    const goldRank = ranked.findIndex((id) => (judged.get(id) ?? 0) === 2) + 1;
    return {
        ndcg: idcg === 0 ? 0 : dcg / idcg,
        reciprocalRank: firstRelevant === 0 ? 0 : 1 / firstRelevant,
        successAt1: goldRank === 1 ? 1 : 0,
        recall,
        goldRank,
    };
}

/** The property the v1 metric lost: a better physical rank must score strictly
 *  better, and the ideal ordering must score exactly 1. */
function selfCheck(): void {
    const topic = release.topics[0]!;
    const judged = gradesByTopic.get(topic.id)!;
    const unjudged = release.corpus.map((d) => d.id).filter((id) => !judged.has(id));

    const scores = [1, 2, 3, NDCG_CUTOFF].map((position) => {
        const order = [...unjudged];
        order.splice(position - 1, 0, topic.goldDocId);
        return scoreTopic(topic.id, order).ndcg;
    });
    for (let i = 1; i < scores.length; i++) {
        if (!(scores[i]! < scores[i - 1]!)) {
            throw new Error(
                `self-check failed: physical nDCG did not decrease as the answer moved down: ${scores
                    .map((s) => s.toFixed(4))
                    .join(" ")}`,
            );
        }
    }

    const ideal = [...judged.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const perfect = scoreTopic(topic.id, [...ideal, ...unjudged]).ndcg;
    if (Math.abs(perfect - 1) > 1e-9) {
        throw new Error(`self-check failed: ideal ordering scored ${perfect}, want 1`);
    }
    console.log(
        `self-check ok: ideal=1.0000 rank1=${scores[0]!.toFixed(4)} rank2=${scores[1]!.toFixed(4)} ` +
            `rank3=${scores[2]!.toFixed(4)} rank${NDCG_CUTOFF}=${scores[3]!.toFixed(4)} (strictly decreasing)`,
    );
}

// --------------------------------------------------------------------- arms

type Pooling = "mean" | "cls";

/** Each model's own documented contract. Wrong pooling or a missing purpose
 *  prefix still produces plausible vectors and a quietly wrong score, so this
 *  table is the load-bearing part of the file. */
interface Recipe {
    label: string;
    model: string;
    pooling: Pooling;
    queryPrefix: string;
    docPrefix: string;
    /** Emitted dimensions. Below native means Matryoshka prefix truncation. */
    dims: number;
    /** Nomic v1.5 layer-normalizes the full vector before truncation. Order is
     *  layer-norm, then slice, then L2. */
    layerNorm?: boolean;
}

const RECIPES: readonly Recipe[] = [
    {
        label: "minilm-mean-384",
        model: "Xenova/all-MiniLM-L6-v2",
        pooling: "mean",
        queryPrefix: "",
        docPrefix: "",
        dims: 384,
    },
    {
        label: "bge-small-cls-384",
        model: "Xenova/bge-small-en-v1.5",
        pooling: "cls",
        queryPrefix: "Represent this sentence for searching relevant passages: ",
        docPrefix: "",
        dims: 384,
    },
    {
        label: "arctic-m-cls-256",
        model: "Snowflake/snowflake-arctic-embed-m-v1.5",
        pooling: "cls",
        queryPrefix: "Represent this sentence for searching relevant passages: ",
        docPrefix: "",
        dims: 256,
    },
    {
        label: "arctic-m-cls-768",
        model: "Snowflake/snowflake-arctic-embed-m-v1.5",
        pooling: "cls",
        queryPrefix: "Represent this sentence for searching relevant passages: ",
        docPrefix: "",
        dims: 768,
    },
    {
        label: "nomic-mean-512",
        model: "nomic-ai/nomic-embed-text-v1.5",
        pooling: "mean",
        queryPrefix: "search_query: ",
        docPrefix: "search_document: ",
        dims: 512,
        layerNorm: true,
    },
    {
        label: "gte-modernbert-cls-768",
        model: "Alibaba-NLP/gte-modernbert-base",
        pooling: "cls",
        queryPrefix: "",
        docPrefix: "",
        dims: 768,
    },
];

const BASELINE_LABEL = "minilm-mean-384";

function postprocess(raw: Float32Array, recipe: Recipe): Float32Array {
    let vector = raw;
    if (recipe.layerNorm) {
        let mean = 0;
        for (const x of vector) mean += x;
        mean /= vector.length;
        let variance = 0;
        for (const x of vector) variance += (x - mean) ** 2;
        variance /= vector.length;
        const denominator = Math.sqrt(variance + 1e-12);
        vector = Float32Array.from(vector, (x) => (x - mean) / denominator);
    }
    if (recipe.dims < vector.length) vector = vector.slice(0, recipe.dims);
    let norm = 0;
    for (const x of vector) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    return Float32Array.from(vector, (x) => x / norm);
}

// ------------------------------------------------------------------ lexical

/** Split on non-word characters, then also emit `snake_case` parts, so an
 *  identifier query can match a document that spells the name differently. */
const tokenize = (text: string): string[] =>
    (text.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
        .flatMap((token) => [token, ...token.split("_")])
        .filter(Boolean);

function bm25Ranker(): (query: string) => string[] {
    const k1 = 1.2;
    const b = 0.75;
    const docTokens = release.corpus.map((doc) => tokenize(doc.text));
    const documentFrequency = new Map<string, number>();
    for (const tokens of docTokens) {
        for (const token of new Set(tokens)) {
            documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
        }
    }
    const n = docTokens.length;
    const averageLength = docTokens.reduce((sum, tokens) => sum + tokens.length, 0) / n;
    const termFrequency = docTokens.map((tokens) => {
        const counts = new Map<string, number>();
        for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
        return counts;
    });

    return (query: string): string[] => {
        const terms = tokenize(query);
        const scored = release.corpus.map((doc, i) => {
            let score = 0;
            const length = docTokens[i]!.length;
            for (const term of terms) {
                const frequency = termFrequency[i]!.get(term);
                if (!frequency) continue;
                const df = documentFrequency.get(term) ?? 0;
                const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
                score +=
                    idf *
                    ((frequency * (k1 + 1)) /
                        (frequency + k1 * (1 - b + (b * length) / averageLength)));
            }
            return { id: doc.id, score };
        });
        scored.sort((a, c) => c.score - a.score || a.id.localeCompare(c.id));
        return scored.map((entry) => entry.id);
    };
}

// ---------------------------------------------------------------------- run

interface ArmResult {
    label: string;
    ndcg: number;
    mrr: number;
    successAt1: number;
    recallAt10: number;
    recallAt50: number;
    goldRanks: Map<string, number>;
    perTopicNdcg: Map<string, number>;
    elapsedMs: number;
}

function aggregate(
    label: string,
    perTopic: Map<string, TopicScores>,
    elapsedMs: number,
): ArmResult {
    const list = [...perTopic.values()];
    const mean = (pick: (scores: TopicScores) => number): number =>
        list.reduce((sum, scores) => sum + pick(scores), 0) / list.length;
    return {
        label,
        ndcg: mean((s) => s.ndcg),
        mrr: mean((s) => s.reciprocalRank),
        successAt1: mean((s) => s.successAt1),
        recallAt10: mean((s) => s.recall[10]!),
        recallAt50: mean((s) => s.recall[50]!),
        goldRanks: new Map([...perTopic].map(([id, s]) => [id, s.goldRank])),
        perTopicNdcg: new Map([...perTopic].map(([id, s]) => [id, s.ndcg])),
        elapsedMs,
    };
}

function rankByCosine(query: Float32Array, docVectors: readonly Float32Array[]): string[] {
    const scored = release.corpus.map((doc, i) => {
        const vector = docVectors[i]!;
        let dot = 0;
        for (let k = 0; k < query.length; k++) dot += query[k]! * vector[k]!;
        return { id: doc.id, score: dot };
    });
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return scored.map((entry) => entry.id);
}

async function runDense(recipe: Recipe, topics: readonly ReleaseTopic[]): Promise<ArmResult> {
    // biome-ignore lint/suspicious/noExplicitAny: local pipeline shape only
    const extractor: any = await pipeline("feature-extraction", recipe.model, { dtype: "fp32" });
    const embed = async (texts: readonly string[]): Promise<Float32Array[]> => {
        const vectors: Float32Array[] = [];
        for (let i = 0; i < texts.length; i += EMBED_BATCH) {
            const batch = texts.slice(i, i + EMBED_BATCH);
            const output = await extractor(batch, { pooling: recipe.pooling, normalize: false });
            const flat = Float32Array.from(output.data as ArrayLike<number>);
            const native = flat.length / batch.length;
            if (!Number.isInteger(native)) throw new Error(`ragged output from ${recipe.model}`);
            for (let k = 0; k < batch.length; k++) {
                vectors.push(postprocess(flat.slice(k * native, (k + 1) * native), recipe));
            }
        }
        return vectors;
    };

    const start = performance.now();
    const docVectors = await embed(release.corpus.map((doc) => `${recipe.docPrefix}${doc.text}`));
    const queryVectors = await embed(
        topics.map((topic) => `${recipe.queryPrefix}${topic.queryText}`),
    );
    const elapsedMs = performance.now() - start;

    const perTopic = new Map<string, TopicScores>();
    for (const [i, topic] of topics.entries()) {
        perTopic.set(topic.id, scoreTopic(topic.id, rankByCosine(queryVectors[i]!, docVectors)));
    }
    return aggregate(recipe.label, perTopic, elapsedMs);
}

/** Paired bootstrap over topics. Reports the interval, not a verdict. */
function pairedInterval(
    candidate: ArmResult,
    baseline: ArmResult,
): { mean: number; low: number; high: number } {
    const deltas = [...baseline.perTopicNdcg.keys()].map(
        (topicId) => (candidate.perTopicNdcg.get(topicId) ?? 0) - baseline.perTopicNdcg.get(topicId)!,
    );
    let state = BOOTSTRAP_SEED >>> 0;
    const nextRandom = (): number => {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0;
        return state / 0x1_0000_0000;
    };
    const means: number[] = [];
    for (let resample = 0; resample < BOOTSTRAP_RESAMPLES; resample++) {
        let sum = 0;
        for (let i = 0; i < deltas.length; i++) {
            sum += deltas[Math.floor(nextRandom() * deltas.length)]!;
        }
        means.push(sum / deltas.length);
    }
    means.sort((a, b) => a - b);
    return {
        mean: deltas.reduce((a, b) => a + b, 0) / deltas.length,
        low: means[Math.floor(0.025 * BOOTSTRAP_RESAMPLES)]!,
        high: means[Math.floor(0.975 * BOOTSTRAP_RESAMPLES)]!,
    };
}

async function main(): Promise<void> {
    selfCheck();
    const development = release.topics.filter((topic) => topic.partition === "development");
    const sealed = release.topics.length - development.length;
    console.log(
        `release ${release.sourceCommit.slice(0, 8)}: ${release.corpus.length} documents, ` +
            `${development.length} development topics, ${sealed} holdout topics sealed`,
    );

    const results: ArmResult[] = [];
    const blocked: { label: string; reason: string }[] = [];

    const bm25 = bm25Ranker();
    const lexicalStart = performance.now();
    const lexicalScores = new Map<string, TopicScores>();
    for (const topic of development) {
        lexicalScores.set(topic.id, scoreTopic(topic.id, bm25(topic.queryText)));
    }
    results.push(
        aggregate("bm25-lexical (control)", lexicalScores, performance.now() - lexicalStart),
    );

    for (const recipe of RECIPES) {
        try {
            results.push(await runDense(recipe, development));
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            blocked.push({ label: recipe.label, reason: reason.split("\n")[0]!.slice(0, 160) });
        }
    }

    const baseline = results.find((result) => result.label === BASELINE_LABEL);
    if (!baseline) throw new Error(`baseline arm ${BASELINE_LABEL} did not complete`);

    console.log(`\n${"=".repeat(112)}`);
    console.log(
        `DEVELOPMENT RESULTS  ${development.length} topics, ${release.corpus.length} documents, baseline ${BASELINE_LABEL}`,
    );
    console.log("=".repeat(112));
    console.log(
        "arm".padEnd(26) +
            "nDCG@10".padStart(9) +
            "delta".padStart(9) +
            "95% CI".padStart(20) +
            "MRR".padStart(8) +
            "S@1".padStart(7) +
            "R@10".padStart(7) +
            "R@50".padStart(7) +
            "sec".padStart(8),
    );
    for (const result of [...results].sort((a, b) => b.ndcg - a.ndcg)) {
        let delta = "—";
        let interval = "—";
        if (result !== baseline) {
            const bounds = pairedInterval(result, baseline);
            delta = (bounds.mean >= 0 ? "+" : "") + bounds.mean.toFixed(4);
            interval = `[${bounds.low.toFixed(4)}, ${bounds.high.toFixed(4)}]`;
        }
        console.log(
            result.label.padEnd(26) +
                result.ndcg.toFixed(4).padStart(9) +
                delta.padStart(9) +
                interval.padStart(20) +
                result.mrr.toFixed(4).padStart(8) +
                result.successAt1.toFixed(3).padStart(7) +
                result.recallAt10.toFixed(3).padStart(7) +
                result.recallAt50.toFixed(3).padStart(7) +
                (result.elapsedMs / 1000).toFixed(1).padStart(8),
        );
    }

    if (blocked.length > 0) {
        console.log("\nBLOCKED (recorded, never scored as a loss)");
        for (const entry of blocked) console.log(`  ${entry.label}: ${entry.reason}`);
    }

    const spread =
        Math.max(...results.map((r) => r.ndcg)) - Math.min(...results.map((r) => r.ndcg));
    console.log(`\nnDCG@10 spread across arms: ${spread.toFixed(4)}`);
    console.log(
        spread < 1e-6
            ? "VERDICT: degenerate release, arms are indistinguishable. Do not proceed."
            : "VERDICT: the release resolves arms. Holdout remains sealed.",
    );
}

await main();
