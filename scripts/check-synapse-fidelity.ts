import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SYNAPSE_SOURCE =
    "packages/plugin/src/features/magic-context/memory/embedding-synapse.ts";
export const RUST_POLICY_SOURCE = "crates/mc-host/tests/support/perf_measurement.rs";

type Policy = {
    initialPollMs: number;
    pollMultiplier: number;
    pollFloorMs: number;
    queueFullAttempts: number;
    otherAttempts: number;
    fallbackBaseMs: number;
    fallbackExponentCap: number;
    fallbackCeilingMs: number;
};

function capture(source: string, pattern: RegExp, name: string): number {
    const value = pattern.exec(source)?.[1];
    if (value === undefined) {
        throw new Error(`missing ${name}`);
    }
    return Number(value.replaceAll("_", ""));
}

function typescriptPolicy(source: string): Policy {
    const retry =
        /classified\.code\s*===\s*"queue_full"\s*\?\s*SYNAPSE_QUEUE_FULL_MAX_ATTEMPTS\s*-\s*1\s*:\s*(\d+);/.exec(
            source,
        );
    const fallback =
        /Math\.min\(([\d_]+),\s*([\d_]+)\s*\*\s*2\s*\*\*\s*Math\.min\(attempt,\s*(\d+)\)\)/.exec(
            source,
        );
    if (retry === null || fallback === null) {
        throw new Error("missing retry split or fallback ladder");
    }
    return {
        initialPollMs: capture(
            source,
            /SYNAPSE_POLL_INITIAL_DELAY_MS\s*=\s*([\d_]+);/,
            "initial poll delay",
        ),
        pollMultiplier: capture(
            source,
            /SYNAPSE_POLL_DELAY_MULTIPLIER\s*=\s*([\d.]+);/,
            "poll multiplier",
        ),
        pollFloorMs: capture(
            source,
            /SYNAPSE_POLL_MIN_DELAY_MS\s*=\s*([\d_]+);/,
            "poll floor",
        ),
        queueFullAttempts: capture(
            source,
            /SYNAPSE_QUEUE_FULL_MAX_ATTEMPTS\s*=\s*([\d_]+);/,
            "queue-full cap",
        ),
        otherAttempts: Number(retry[1]) + 1,
        fallbackCeilingMs: Number(fallback[1].replaceAll("_", "")),
        fallbackBaseMs: Number(fallback[2].replaceAll("_", "")),
        fallbackExponentCap: Number(fallback[3]),
    };
}

function rustPolicy(source: string): Policy {
    return {
        initialPollMs: capture(
            source,
            /first_poll_delay_ms[\s\S]*?([\d.]+)\s*\+\s*self\.unit\(\)/,
            "Rust initial poll delay",
        ),
        pollMultiplier: capture(
            source,
            /POLL_DELAY_MULTIPLIER:\s*f64\s*=\s*([\d.]+);/,
            "Rust poll multiplier",
        ),
        pollFloorMs: capture(
            source,
            /POLL_MIN_DELAY_MS:\s*u64\s*=\s*([\d_]+);/,
            "Rust poll floor",
        ),
        queueFullAttempts: capture(
            source,
            /QUEUE_FULL_MAX_ATTEMPTS:\s*u32\s*=\s*([\d_]+);/,
            "Rust queue-full cap",
        ),
        otherAttempts: capture(
            source,
            /OTHER_MAX_ATTEMPTS:\s*u32\s*=\s*([\d_]+);/,
            "Rust other-attempt cap",
        ),
        fallbackBaseMs: capture(
            source,
            /fallback_base_ms[\s\S]*?([\d_]+)u64\s*\.saturating_mul/,
            "Rust fallback base",
        ),
        fallbackExponentCap: capture(
            source,
            /fallback_base_ms[\s\S]*?attempt\.min\(([\d_]+)\)/,
            "Rust fallback exponent cap",
        ),
        fallbackCeilingMs: capture(
            source,
            /fallback_base_ms[\s\S]*?\.clamp\(1,\s*([\d_]+)\)/,
            "Rust fallback ceiling",
        ),
    };
}

export function fidelityDrift(tsSource: string, rustSource: string): string[] {
    let plugin: Policy;
    let harness: Policy;
    try {
        plugin = typescriptPolicy(tsSource);
        harness = rustPolicy(rustSource);
    } catch (error) {
        return [error instanceof Error ? error.message : String(error)];
    }
    return (Object.keys(plugin) as (keyof Policy)[]).filter(
        (key) => plugin[key] !== harness[key],
    );
}

export function checkSynapseFidelity(root = process.cwd()): void {
    const tsSource = readFileSync(join(root, SYNAPSE_SOURCE), "utf8");
    const rustSource = readFileSync(join(root, RUST_POLICY_SOURCE), "utf8");
    const drift = fidelityDrift(tsSource, rustSource);
    if (drift.length > 0) {
        throw new Error(`Synapse TS-to-Rust fidelity drift: ${drift.join(", ")}`);
    }
}

if (import.meta.main) {
    checkSynapseFidelity();
    console.log("checked Synapse TS-to-Rust fidelity policy");
}
