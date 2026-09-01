/** The workflow keys its calibration cache on a `hashFiles` glob of this same set, and `calibration-scope.test.ts` holds the two lists equal: a path added here without the workflow would otherwise restore a cached record the runner rejects. commentlint: allow(JUDGE) */
export const CALIBRATION_SCOPE = [
    "packages/plugin/src",
    /** `canonicalFingerprint` lives here, and every fingerprint in the record and report is its output. commentlint: allow(JUDGE) */
    "packages/plugin/scripts/retrieval-benchmark",
    /** The whole e2e source tree rather than the lane's own directories. A transitive-import audit of the runner reaches 322 modules, including `prospective-holdout`, `atomic-publish`, `code-unit-order`, `contract-primitives`, `test-db`, `mock-provider`, and the harness primitives, so an enumerated list of directories was already incomplete and would drift again with the next import. Over-triggering costs one re-calibration; under-triggering publishes noise measured against different code. commentlint: allow(JUDGE) */
    "packages/e2e-tests/src",
    "packages/e2e-tests/scripts/run-paired-delta.ts",
    "packages/e2e-tests/pools",
    /** A dependency or build-script change installs a different SDK or builds a different plugin without touching a source file. commentlint: allow(JUDGE) */
    "bun.lock",
    "package.json",
    "packages/plugin/package.json",
    "packages/e2e-tests/package.json",
    /** Pins the OpenCode version and its digest, and native compaction, prompt routing, and the session ledger are all part of the measured behaviour. commentlint: allow(JUDGE) */
    ".github/workflows/paired-delta-eval.yml",
] as const;

/** The workflow that keys its calibration cache on this scope, relative to the repository root. commentlint: allow(JUDGE) */
export const CALIBRATION_WORKFLOW_PATH = ".github/workflows/paired-delta-eval.yml";
