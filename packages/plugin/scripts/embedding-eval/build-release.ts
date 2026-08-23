/**
 * Build a labelled in-domain retrieval release from the current checkout, for
 * ranking candidate embedding models.
 *
 * The committed `fixtures/retrieval-benchmark/v1` release cannot rank models. It
 * holds 22 documents with exactly one judged relevant document per query, no
 * near-miss distractors, and a condensed-judged `nDCG@10` that returns 1.0
 * whether the answer sits at physical rank 1 or rank 10. It remains correct as a
 * deterministic behavioral regression fixture, which is what it was built for.
 *
 * This release is built for the other job, and each property answers a measured
 * defect of the v1 release:
 *
 *   - Corpus far larger than any reported cutoff, so `Recall@k` is not
 *     tautological. `Recall@50` over 22 documents was 1.0 by construction.
 *   - Several graded relevant documents per topic, so an ideal ordering exists
 *     for `nDCG` to compare a run against.
 *   - Deliberate near-miss documents, mined from real reference and name
 *     relationships in the tree rather than invented.
 *   - Complete labels by construction. Every corpus document receives a definite
 *     grade from an objective rule, so there is no unjudged pool and no
 *     incomplete-judgment correction to argue about.
 *   - Seeded, disjoint development and holdout topic splits.
 *   - No identifier twins. The v1 release named 20 of 22 gold documents after
 *     their own query.
 *
 * Scope limit: labels are structurally verifiable, so this release measures
 * identifier and symbol retrieval. It does not cover architecture rationale,
 * decisions, or temporal prose, which require human judgments. Do not read a
 * result here as a verdict on those categories.
 *
 * The release is a function of the checkout, so arms are only comparable when
 * built from the same commit. The written artifact records that commit.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../../../..");
const OUT = join(REPO, "packages/plugin/scripts/embedding-eval/release.json");

/** Corpus size cap. Must stay well above the largest reported recall cutoff. */
const MAX_DOCS = 2400;
const TOPIC_COUNT = 80;
const SEED = 0x5eed_1234;
/** A topic needs enough near misses to be discriminating, but a symbol
 *  referenced everywhere measures nothing but its own ubiquity. */
const MIN_NEAR_MISS = 2;
const MAX_NEAR_MISS = 40;

export interface ReleaseDoc {
    id: string;
    kind: "ts-symbol" | "rust-symbol" | "doc-section";
    path: string;
    text: string;
}

export interface ReleaseTopic {
    id: string;
    symbol: string;
    queryText: string;
    goldDocId: string;
    partition: "development" | "holdout";
    nearMissCount: number;
}

export interface Release {
    schemaVersion: "embedding-eval-release/v2";
    sourceCommit: string;
    seed: number;
    corpus: ReleaseDoc[];
    topics: ReleaseTopic[];
    /** Grade 2 is the document that defines the queried symbol. Grade 1 is a
     *  document that references it or shares a containment relationship with its
     *  name. Every other document is grade 0 by omission. */
    judgments: { topicId: string; docId: string; grade: 1 | 2 }[];
}

interface Candidate extends ReleaseDoc {
    defines: string | null;
    mentions: string[];
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]{3,}/g;
const TS_DECL =
    /^export (?:async )?(?:function|const|class|interface|type|enum) ([A-Za-z_][A-Za-z0-9_]*)/;
const RS_DECL = /^\s*pub (?:async )?(?:fn|struct|enum|trait) ([A-Za-z_][A-Za-z0-9_]*)/;

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        if (["node_modules", "target", "dist", "build", "coverage"].includes(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

/** Text of the comment block immediately above `line`, so a symbol document
 *  carries its own prose rather than bare syntax. */
function precedingComment(lines: string[], line: number): string {
    const collected: string[] = [];
    for (let i = line - 1; i >= 0 && i >= line - 14; i--) {
        const text = lines[i]!.trim();
        const isComment =
            text.startsWith("//") ||
            text.startsWith("/*") ||
            text.startsWith("*") ||
            text.endsWith("*/");
        if (isComment) {
            collected.unshift(text.replace(/^\/\*+|^\*+\/?|^\/\/+|\*\/$/g, "").trim());
            if (text.startsWith("/*")) break;
            continue;
        }
        if (text === "") continue;
        break;
    }
    return collected.filter(Boolean).join(" ");
}

function markdownSections(rel: string, lines: string[], seq: () => number): Candidate[] {
    const docs: Candidate[] = [];
    let heading: string | null = null;
    let body: string[] = [];
    const flush = (): void => {
        if (heading && body.join("").trim().length > 80) {
            const text = `${heading}\n${body.join(" ").trim()}`.slice(0, 1200);
            docs.push({
                id: `md:${rel}#${seq()}`,
                defines: null,
                kind: "doc-section",
                path: rel,
                text,
                mentions: [...new Set(text.match(IDENT) ?? [])],
            });
        }
        body = [];
    };
    for (const line of lines) {
        if (/^#{2,4} /.test(line)) {
            flush();
            heading = line.replace(/^#+\s*/, "");
        } else if (heading) body.push(line);
    }
    flush();
    return docs;
}

function buildCandidates(): Candidate[] {
    const docs: Candidate[] = [];
    let counter = 0;
    const seq = (): number => counter++;

    for (const file of walk(REPO)) {
        const rel = relative(REPO, file);
        const isTs = rel.endsWith(".ts") && !/\.test\.|\.d\.ts$/.test(rel);
        const isRs = rel.endsWith(".rs");
        const isMd = rel.startsWith("docs/") && rel.endsWith(".md");
        if (!isTs && !isRs && !isMd) continue;
        if (statSync(file).size > 900_000) continue;

        const lines = readFileSync(file, "utf8").split("\n");
        if (isMd) {
            docs.push(...markdownSections(rel, lines, seq));
            continue;
        }

        const decl = isTs ? TS_DECL : RS_DECL;
        for (const [i, line] of lines.entries()) {
            const name = line.match(decl)?.[1];
            if (!name) continue;
            const text = `${precedingComment(lines, i)}\n${lines
                .slice(i, Math.min(lines.length, i + 18))
                .join("\n")}`
                .trim()
                .slice(0, 1400);
            docs.push({
                id: `${isTs ? "ts" : "rs"}:${rel}:${name}`,
                defines: name,
                kind: isTs ? "ts-symbol" : "rust-symbol",
                path: rel,
                text,
                mentions: [...new Set(text.match(IDENT) ?? [])],
            });
        }
    }
    return docs;
}

/** Deterministic PRNG so a release is reproducible from seed plus commit. */
function rng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0;
        return state / 0x1_0000_0000;
    };
}

function shuffle<T>(items: readonly T[], next: () => number): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
}

/** Grade 1 relationship: `doc` names something that contains, or is contained
 *  by, the queried symbol. Short names are excluded because a three-character
 *  containment match is coincidence, not relatedness. */
function nameRelated(doc: Candidate, symbol: string): boolean {
    if (doc.defines === null || doc.defines === symbol || doc.defines.length < 5) return false;
    return doc.defines.includes(symbol) || symbol.includes(doc.defines);
}

function assertReleaseIsUsable(release: Release): void {
    const byTopic = new Map<string, number[]>();
    for (const j of release.judgments) {
        const list = byTopic.get(j.topicId) ?? [];
        list.push(j.grade);
        byTopic.set(j.topicId, list);
    }
    const problems: string[] = [];
    const maxRecallCutoff = 50;
    if (release.corpus.length <= maxRecallCutoff) {
        problems.push(
            `corpus of ${release.corpus.length} does not exceed the ${maxRecallCutoff} recall cutoff, so recall is tautological`,
        );
    }
    for (const topic of release.topics) {
        const gradesFor = byTopic.get(topic.id) ?? [];
        const twos = gradesFor.filter((g) => g === 2).length;
        const ones = gradesFor.filter((g) => g === 1).length;
        if (twos !== 1) problems.push(`${topic.id}: ${twos} grade-2 documents, want exactly 1`);
        if (ones < 1) problems.push(`${topic.id}: no grade-1 near miss, so the topic is trivial`);
        const gold = release.corpus.find((d) => d.id === topic.goldDocId);
        if (!gold) problems.push(`${topic.id}: gold document missing from the corpus`);
        else if (gold.text.includes(topic.queryText)) {
            problems.push(`${topic.id}: query text appears verbatim in the gold document`);
        }
        if (topic.goldDocId.includes(topic.id)) {
            problems.push(`${topic.id}: identifier twin, the gold id encodes the topic id`);
        }
    }
    if (problems.length > 0) {
        for (const problem of problems.slice(0, 12)) console.error(`INVARIANT: ${problem}`);
        throw new Error(
            `${problems.length} release invariant violations; this release cannot rank arms`,
        );
    }
}

function build(): Release {
    const all = buildCandidates();
    console.log(`scanned ${all.length} candidate documents`);

    // A symbol is usable as a topic only when exactly one document defines it,
    // so the grade-2 answer is unambiguous.
    const definers = new Map<string, Candidate[]>();
    for (const doc of all) {
        if (!doc.defines) continue;
        const list = definers.get(doc.defines) ?? [];
        list.push(doc);
        definers.set(doc.defines, list);
    }

    const nearMissesOf = (symbol: string): Candidate[] =>
        all.filter(
            (d) => (d.defines !== symbol && d.mentions.includes(symbol)) || nameRelated(d, symbol),
        );

    const next = rng(SEED);
    const usable = [...definers.entries()].filter(([, docs]) => docs.length === 1);
    const chosen = shuffle(usable, next)
        .filter(([symbol]) => {
            const near = nearMissesOf(symbol).length;
            return near >= MIN_NEAR_MISS && near <= MAX_NEAR_MISS;
        })
        .slice(0, TOPIC_COUNT);
    if (chosen.length < TOPIC_COUNT) {
        throw new Error(`only ${chosen.length} discriminating topics available, want ${TOPIC_COUNT}`);
    }

    const keep = new Map<string, Candidate>();
    const topics: ReleaseTopic[] = [];
    for (const [index, [symbol, docs]] of chosen.entries()) {
        const gold = docs[0]!;
        keep.set(gold.id, gold);
        const near = nearMissesOf(symbol);
        for (const doc of near) keep.set(doc.id, doc);
        topics.push({
            id: `t-${index}`,
            symbol,
            queryText: `where is ${symbol} defined`,
            goldDocId: gold.id,
            partition: index % 2 === 0 ? "development" : "holdout",
            nearMissCount: near.length,
        });
    }
    // Filler raises the corpus past the recall cutoff and makes the ranking task
    // a realistic search rather than a 100-document sort.
    for (const doc of shuffle(all, next)) {
        if (keep.size >= MAX_DOCS) break;
        keep.set(doc.id, doc);
    }
    const corpus = [...keep.values()];

    const judgments: Release["judgments"] = [];
    for (const topic of topics) {
        for (const doc of corpus) {
            if (doc.id === topic.goldDocId) {
                judgments.push({ topicId: topic.id, docId: doc.id, grade: 2 });
            } else if (doc.mentions.includes(topic.symbol) || nameRelated(doc, topic.symbol)) {
                judgments.push({ topicId: topic.id, docId: doc.id, grade: 1 });
            }
        }
    }

    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: REPO,
        encoding: "utf8",
    }).trim();

    const release: Release = {
        schemaVersion: "embedding-eval-release/v2",
        sourceCommit,
        seed: SEED,
        corpus: corpus.map(({ id, kind, path, text }) => ({ id, kind, path, text })),
        topics,
        judgments,
    };
    assertReleaseIsUsable(release);
    return release;
}

const release = build();
const judgedPerTopic = release.topics.map(
    (t) => release.judgments.filter((j) => j.topicId === t.id).length,
);
const devCount = release.topics.filter((t) => t.partition === "development").length;
const kinds = release.corpus.reduce<Record<string, number>>((acc, doc) => {
    acc[doc.kind] = (acc[doc.kind] ?? 0) + 1;
    return acc;
}, {});
console.log(
    `release ok at ${release.sourceCommit.slice(0, 8)}: ${release.corpus.length} documents ` +
        `${JSON.stringify(kinds)}, ${release.topics.length} topics ` +
        `(${devCount} development / ${release.topics.length - devCount} holdout), ` +
        `${release.judgments.length} judgments, judged per topic min=${Math.min(...judgedPerTopic)} ` +
        `max=${Math.max(...judgedPerTopic)} mean=${(judgedPerTopic.reduce((a, b) => a + b, 0) / judgedPerTopic.length).toFixed(1)}`,
);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(release));
console.log(`wrote ${relative(REPO, OUT)}`);
