import { migrateDreamerV2 } from "@magic-context/core/config/migrate-dreamer-v2";

/**
 * On-disk Dreamer v2 migration for doctor. Runs the shared in-memory
 * migration (the same one every config load applies) and grafts its result
 * onto the comment-json-parsed config object, so the doctor persists exactly
 * the shape the runtime resolves — one migration definition schedules the
 * canonical task set for both paths.
 *
 * Mutates in place and returns true when it changed `mcConfig.dreamer`.
 * comment-json attaches comments as non-enumerable symbol properties on the
 * objects that carry them, so the graft rewrites each existing object's keys
 * recursively instead of replacing the objects: comments on the dreamer
 * block, the tasks record, and individual task entries all survive the
 * rewrite.
 *
 * Run AFTER the experimental→dreamer migration so a relocated
 * dreamer.user_memories / dreamer.pin_key_files is folded into the tasks
 * record.
 */
export function migrateDreamerV2ForDoctor(mcConfig: Record<string, unknown>): boolean {
    const migrated = migrateDreamerV2(mcConfig, []);
    // The shared migration returns its input by identity for every no-op,
    // including a dreamer that is not a plain object.
    if (migrated === mcConfig) return false;

    graftInPlace(
        mcConfig.dreamer as Record<string, unknown>,
        migrated.dreamer as Record<string, unknown>,
    );
    return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rewrite `target`'s enumerable keys to match `source`, recursing where both
 *  sides hold plain objects so nested object identities (and their symbol
 *  comment properties) are preserved. */
function graftInPlace(target: Record<string, unknown>, source: Record<string, unknown>): void {
    for (const key of Object.keys(target)) {
        if (!Object.hasOwn(source, key)) delete target[key];
    }
    for (const [key, value] of Object.entries(source)) {
        const existing = target[key];
        if (isPlainObject(existing) && isPlainObject(value)) {
            graftInPlace(existing, value);
        } else {
            target[key] = value;
        }
    }
}
