import { canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { vocabulary, type ContractPrimitives } from "../contract-primitives";
import type { SystemVersionTuple } from "./runner";

const SYSTEM_VERSION_TUPLE_KEYS = vocabulary<keyof SystemVersionTuple>({
    repoCommitSha: true,
    bunVersion: true,
    opencodeVersion: true,
    historianModelId: true,
    probeModelId: true,
    parserImpl: true,
    chunkTokenBudget: true,
});

// Mirrors `resolveRepoCommitSha` in runner.ts: a 40-hex HEAD, that sha plus `-dirty.` and 12 hex of the tree digest, or `unknown`. commentlint: allow(JUDGE)
const COMMIT_SHA_RE = /^(?:[0-9a-f]{40}(?:-dirty\.[0-9a-f]{12})?|unknown)$/;
/** No whitespace, so a tuple field cannot carry prose. */
export const IDENTITY_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/;

/**
 * Parses a `SystemVersionTuple` with the caller's primitives so every lane report raises its own error class.
 *
 * One implementation keeps the historian, metamorphic, and scorecard consumers accepting the same bytes.
 */
export function parseSystemVersionTuple(p: ContractPrimitives, raw: unknown, label: string): SystemVersionTuple | null {
    if (raw === null) return null;
    const value = p.record(raw, label);
    p.exact(value, SYSTEM_VERSION_TUPLE_KEYS, label);
    if (value.parserImpl !== "ts") p.fail(`${label}.parserImpl: enum-invalid`);
    return {
        repoCommitSha: p.staticId(value.repoCommitSha, `${label}.repoCommitSha`, COMMIT_SHA_RE),
        bunVersion: p.staticId(value.bunVersion, `${label}.bunVersion`, IDENTITY_TOKEN_RE),
        opencodeVersion: p.staticId(value.opencodeVersion, `${label}.opencodeVersion`, IDENTITY_TOKEN_RE),
        historianModelId: p.staticId(value.historianModelId, `${label}.historianModelId`, IDENTITY_TOKEN_RE),
        probeModelId: p.staticId(value.probeModelId, `${label}.probeModelId`, IDENTITY_TOKEN_RE),
        parserImpl: "ts",
        chunkTokenBudget: value.chunkTokenBudget === null ? null : p.integer(value.chunkTokenBudget, `${label}.chunkTokenBudget`, 1),
    };
}

/**
 * Binds a run-record score's tuple to the report that carries it.
 *
 * A run-record score reaches the scorer only after its record's system passed shape validation, so it carries
 * a tuple, and where the report names one they must agree. `parseScenarioScore` owns the raw-output seam's
 * shape, including its null tuple, so that seam has nothing to bind here.
 */
export function requireScoreSystemBinding(
    p: ContractPrimitives,
    score: { source: "run-record" | "raw-output"; system: SystemVersionTuple | null },
    reportSystem: SystemVersionTuple | null,
    label: string,
): void {
    if (score.source === "raw-output") return;
    if (score.system === null) p.fail(`${label}: system-required`);
    if (reportSystem !== null && canonicalJson(score.system) !== canonicalJson(reportSystem)) {
        p.fail(`${label}: report-system-mismatch`);
    }
}
