#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const MANIFEST_PATH = resolve(
    import.meta.dir,
    "../../../crates/mc-shm-transport/benches/manifests/v1.json",
);

export interface MatrixValidation {
    outcome: "invalid" | "valid";
    errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates that the benchmark manifest names only the fixed ring transport. */
export function validateHardeningMatrix(raw: unknown): MatrixValidation {
    if (!isRecord(raw) || !isRecord(raw.arms)) {
        return { outcome: "invalid", errors: ["manifest must declare arms"] };
    }

    const transport = raw.arms.transport;
    if (
        !Array.isArray(transport) ||
        transport.length !== 1 ||
        transport[0] !== "ring"
    ) {
        return {
            outcome: "invalid",
            errors: ["arms.transport must contain only ring"],
        };
    }

    const errors: string[] = [];
    if ("selectable" in raw.arms) {
        errors.push("arms.selectable is obsolete for the fixed ring transport");
    }
    if ("failure_hardening" in raw) {
        errors.push("failure_hardening retained tuples are obsolete");
    }
    return errors.length === 0
        ? { outcome: "valid", errors: [] }
        : { outcome: "invalid", errors };
}

export function validateCommittedMatrix(): MatrixValidation {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    } catch (error) {
        throw new Error(`could not read ${MANIFEST_PATH}: ${String(error)}`);
    }
    return validateHardeningMatrix(raw);
}

if (import.meta.main) {
    const result = validateCommittedMatrix();
    if (result.outcome === "valid") {
        console.log("validated fixed ring transport manifest");
    } else {
        for (const error of result.errors) {
            console.error(`fixed ring manifest invalid: ${error}`);
        }
        process.exitCode = 1;
    }
}
