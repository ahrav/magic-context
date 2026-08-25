#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

type CommandResult = { exit_status: number; output: string };

const e2eRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(e2eRoot, "../..");
const source = resolve(e2eRoot, "tests/rust-historian-producer.test.ts");
const oldText = "await h.mcHost.failNextBackendCall();";
const replacement = "await h.mcHost.backendSuccess();";
const decoder = new TextDecoder();

function runTest(): CommandResult {
    const result = Bun.spawnSync({
        cmd: [
            "bun",
            "test",
            "--timeout",
            "600000",
            "--max-concurrency=1",
            "tests/rust-historian-producer.test.ts",
        ],
        cwd: e2eRoot,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, MC_E2E_MODE: "rust" },
    });
    return {
        exit_status: result.exitCode,
        output: `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
    };
}

const before = readFileSync(source, "utf8");
if (before.split(oldText).length - 1 !== 1) {
    throw new Error(
        "RUST_HISTORIAN_TYPED_FAILURE: expected one mutation target",
    );
}
writeFileSync(source, before.replace(oldText, replacement));
let observedFailure: CommandResult;
try {
    observedFailure = runTest();
} finally {
    writeFileSync(source, before);
}
const revertedRerun = runTest();
if (observedFailure.exit_status === 0) {
    throw new Error(
        "RUST_HISTORIAN_TYPED_FAILURE: mutation did not redden the assertion",
    );
}
if (revertedRerun.exit_status !== 0) {
    throw new Error("RUST_HISTORIAN_TYPED_FAILURE: reverted test did not pass");
}

writeFileSync(
    resolve(e2eRoot, "mutations/rust-historian-producer.json"),
    `${JSON.stringify(
        {
            drill: "RUST-HISTORIAN-DIRECT-BACKEND",
            command:
                "MC_E2E_MODE=rust bun test --timeout 600000 --max-concurrency=1 tests/rust-historian-producer.test.ts",
            mutations: [
                {
                    name: "RUST_HISTORIAN_TYPED_FAILURE",
                    applied_diff: {
                        path: relative(repoRoot, source),
                        before: oldText,
                        after: replacement,
                        changed: true,
                    },
                    observed_failure: observedFailure,
                    reverted_rerun: { ...revertedRerun, status: "pass" },
                    adequacy_finding: null,
                },
            ],
        },
        null,
        2,
    )}\n`,
);
console.log("wrote mutations/rust-historian-producer.json");
