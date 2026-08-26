#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const MANIFEST_PATH = resolve(
    import.meta.dir,
    "../../../crates/mc-shm-transport/benches/manifests/v1.json",
);

export const FROZEN_STATUS = "FROZEN";
const MAX_ERRORS = 32;

export const OS_VALUES = ["linux", "macos"] as const;
export const RUNTIME_VALUES = ["rust", "bun", "node"] as const;
export const EXPECTATION_VALUES = ["active", "omission"] as const;
export const GEOMETRY_FIELDS = [
    "slot_size",
    "slot_count",
    "arena_bytes",
    "lane_count",
] as const;
export const HOST_LIMIT_FIELDS = [
    "arena_bytes",
    "descriptors",
    "leases",
    "mappings",
    "pinned_workers",
] as const;
export const ADAPTER_CATEGORIES = [
    "decoder",
    "native-boundary",
    "recovery",
    "crash",
    "restart",
    "soak",
    "runtime-execution",
] as const;
export type AdapterCategory = (typeof ADAPTER_CATEGORIES)[number];

/** ADAPTER_INVENTORY maps each os/runtime/provider/profile tuple identity to covered adapter categories. */
export const ADAPTER_INVENTORY: Record<string, readonly AdapterCategory[]> = {};

export interface MatrixValidation {
    outcome: "unresolved" | "invalid" | "valid";
    errors: string[];
}

/** Redact a tuple identity so errors never leak raw provider text. */
export function redactTupleId(identity: string): string {
    return `tuple:${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
    return (
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    );
}

function hasUnsetLeaf(value: unknown): boolean {
    if (typeof value === "string") return value.startsWith("UNSET");
    if (Array.isArray(value)) return value.some(hasUnsetLeaf);
    if (isRecord(value)) return Object.values(value).some(hasUnsetLeaf);
    return false;
}

function tupleIdentity(tuple: Record<string, unknown>): string {
    return [tuple.os, tuple.runtime, tuple.provider, tuple.profile]
        .map(String)
        .join("/");
}

function validateTupleShape(
    tuple: unknown,
    index: number,
    selectable: Set<string>,
    errors: string[],
): void {
    if (!isRecord(tuple)) {
        errors.push(`retained tuple ${index} is not an object`);
        return;
    }
    const id = redactTupleId(tupleIdentity(tuple));
    if (!OS_VALUES.includes(tuple.os as never))
        errors.push(`${id} has an os outside ${OS_VALUES.join("|")}`);
    if (!RUNTIME_VALUES.includes(tuple.runtime as never)) {
        errors.push(`${id} has a runtime outside ${RUNTIME_VALUES.join("|")}`);
    }
    if (typeof tuple.provider !== "string" || !selectable.has(tuple.provider)) {
        errors.push(`${id} names a provider outside arms.selectable`);
    }
    if (typeof tuple.profile !== "string" || tuple.profile.length === 0) {
        errors.push(`${id} has an invalid profile id`);
    }
    const geometry = tuple.descriptor_geometry;
    if (
        !isRecord(geometry) ||
        Object.keys(geometry).sort().join("\0") !==
            [...GEOMETRY_FIELDS].sort().join("\0") ||
        GEOMETRY_FIELDS.some(
            (field) =>
                !isCount(geometry[field]) || (geometry[field] as number) === 0,
        )
    ) {
        errors.push(
            `${id} descriptor_geometry must have positive ${GEOMETRY_FIELDS.join(", ")}`,
        );
    }
    const limits = tuple.host_limits;
    const validCaps = (caps: unknown): boolean =>
        isRecord(caps) &&
        Object.keys(caps).length === HOST_LIMIT_FIELDS.length &&
        HOST_LIMIT_FIELDS.every((field) => isCount(caps[field]));
    if (
        !isRecord(limits) ||
        !validCaps(limits.active) ||
        !validCaps(limits.quarantine)
    ) {
        errors.push(
            `${id} host_limits must have active and quarantine caps for ${HOST_LIMIT_FIELDS.join(", ")}`,
        );
    }
    if (!EXPECTATION_VALUES.includes(tuple.expectation as never)) {
        errors.push(
            `${id} has an expectation outside ${EXPECTATION_VALUES.join("|")}`,
        );
    } else if (tuple.expectation === "omission") {
        errors.push(
            `${id} is retained but declares omission; retained tuples must be active`,
        );
    }
    if (tuple.os === "macos" && tuple.expectation !== "active") {
        errors.push(`${id} is a retained macos tuple without active coverage`);
    }
}

/** Validation never loads the native addon, opens provider objects, or probes host capability. */
export function validateHardeningMatrix(
    raw: unknown,
    inventory: Record<string, readonly string[]> = ADAPTER_INVENTORY,
): MatrixValidation {
    if (
        !isRecord(raw) ||
        !isRecord(raw.arms) ||
        !Array.isArray(raw.arms.selectable)
    ) {
        return {
            outcome: "invalid",
            errors: ["manifest must declare arms.selectable"],
        };
    }
    const section = raw.failure_hardening;
    if (
        !isRecord(section) ||
        typeof section.status !== "string" ||
        !Array.isArray(section.retained_tuples)
    ) {
        return {
            outcome: "invalid",
            errors: [
                "failure_hardening must declare status and retained_tuples",
            ],
        };
    }
    if (section.status.startsWith("UNSET")) {
        return {
            outcome: "unresolved",
            errors: [
                "failure_hardening status is unresolved; tuple execution is blocked",
            ],
        };
    }
    if (section.status !== FROZEN_STATUS) {
        return {
            outcome: "invalid",
            errors: [
                `failure_hardening status must be ${FROZEN_STATUS} or UNSET_*`,
            ],
        };
    }
    if (section.retained_tuples.some(hasUnsetLeaf)) {
        return {
            outcome: "unresolved",
            errors: [
                "a retained tuple has an unresolved UNSET field; tuple execution is blocked",
            ],
        };
    }
    if (section.retained_tuples.length === 0) {
        return {
            outcome: "invalid",
            errors: [
                "a frozen failure_hardening matrix must retain at least one tuple",
            ],
        };
    }

    const errors: string[] = [];
    const selectable = new Set(
        raw.arms.selectable.filter(
            (arm): arm is string => typeof arm === "string",
        ),
    );
    const activePlatforms = Array.isArray(section.active_platforms)
        ? section.active_platforms
        : [];
    const identities = new Set<string>();

    if (activePlatforms.length === 0) {
        errors.push(
            "a frozen failure_hardening matrix must declare at least one active platform",
        );
    }

    for (const [index, tuple] of section.retained_tuples.entries()) {
        validateTupleShape(tuple, index, selectable, errors);
        if (!isRecord(tuple)) continue;
        const identity = tupleIdentity(tuple);
        if (identities.has(identity)) {
            errors.push(`duplicate tuple identity ${redactTupleId(identity)}`);
        }
        identities.add(identity);
        const categories = new Set(inventory[identity] ?? []);
        const missing = ADAPTER_CATEGORIES.filter(
            (category) => !categories.has(category),
        );
        if (missing.length > 0) {
            errors.push(
                `${redactTupleId(identity)} lacks adapter coverage for: ${missing.join(", ")}`,
            );
        }
    }
    for (const identity of Object.keys(inventory)) {
        if (!identities.has(identity)) {
            errors.push(
                `dead adapter mapping ${redactTupleId(identity)} references no retained tuple`,
            );
        }
    }
    for (const platform of activePlatforms) {
        const covered = section.retained_tuples.some(
            (tuple) =>
                isRecord(tuple) &&
                tuple.os === platform &&
                tuple.expectation === "active",
        );
        if (!covered) {
            errors.push(
                `claimed active platform ${String(platform)} has no retained provider`,
            );
        }
    }
    // Reverse coverage: every platform with an active retained provider
    // must be claimed, so retained coverage cannot be silently omitted
    // from the active_platforms contract.
    const retainedActivePlatforms = new Set(
        section.retained_tuples
            .filter(
                (tuple): tuple is Record<string, unknown> =>
                    isRecord(tuple) &&
                    tuple.expectation === "active" &&
                    typeof tuple.os === "string",
            )
            .map((tuple) => tuple.os as string),
    );
    for (const platform of retainedActivePlatforms) {
        if (!activePlatforms.includes(platform)) {
            errors.push(
                `retained active platform ${platform} is missing from active_platforms`,
            );
        }
    }

    if (errors.length > 0)
        return { outcome: "invalid", errors: errors.slice(0, MAX_ERRORS) };
    return { outcome: "valid", errors: [] };
}

export function validateCommittedMatrix(
    inventory: Record<string, readonly string[]> = ADAPTER_INVENTORY,
): MatrixValidation {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    } catch (error) {
        throw new Error(`could not read ${MANIFEST_PATH}: ${String(error)}`);
    }
    return validateHardeningMatrix(raw, inventory);
}

if (import.meta.main) {
    const allowUnresolved = Bun.argv.includes("--allow-unresolved");
    const result = validateCommittedMatrix();
    if (result.outcome === "valid") {
        console.log("validated shm failure-hardening matrix");
    } else if (result.outcome === "unresolved" && allowUnresolved) {
        for (const error of result.errors)
            console.error(`shm hardening matrix unresolved: ${error}`);
        console.error(
            "PROVISIONAL PHASE: tuple-specific execution is BLOCKED until " +
                "magic-context-ymc.12 freezes failure_hardening in " +
                "crates/mc-shm-transport/benches/manifests/v1.json; " +
                "hardening suites run against the provisional in-repo ring " +
                "tuple on Linux only",
        );
    } else {
        for (const error of result.errors)
            console.error(`shm hardening matrix ${result.outcome}: ${error}`);
        process.exit(1);
    }
}
