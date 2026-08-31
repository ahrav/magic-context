/**
 */

export function coercePinKeyFilesValue(value: unknown): Record<string, unknown> | undefined {
    if (typeof value === "boolean") {
        return { enabled: value };
    }
    if (typeof value === "object" && value !== null) {
        return { ...(value as Record<string, unknown>) };
    }
    return undefined;
}

/**
 */
export function migrateExperimentalPinKeyFilesForDoctor(
    mcConfig: Record<string, unknown>,
): boolean {
    const experimental = mcConfig.experimental as Record<string, unknown> | undefined;
    if (!experimental || !("pin_key_files" in experimental)) {
        return false;
    }

    const dreamer = (mcConfig.dreamer as Record<string, unknown> | undefined) ?? {};
    const oldPKF = experimental.pin_key_files;
    const existingPKF = dreamer.pin_key_files;

    if (existingPKF === undefined) {
        const coerced = coercePinKeyFilesValue(oldPKF);
        if (coerced !== undefined) {
            dreamer.pin_key_files = coerced;
        }
    } else if (
        typeof oldPKF === "object" &&
        oldPKF !== null &&
        typeof existingPKF === "object" &&
        existingPKF !== null
    ) {
        dreamer.pin_key_files = {
            ...(oldPKF as Record<string, unknown>),
            ...(existingPKF as Record<string, unknown>),
        };
    } else if (typeof oldPKF === "object" && oldPKF !== null) {
        dreamer.pin_key_files = {
            ...(oldPKF as Record<string, unknown>),
            enabled: Boolean(existingPKF),
        };
    }

    mcConfig.dreamer = dreamer;
    delete experimental.pin_key_files;
    if (Object.keys(experimental).length === 0) {
        delete mcConfig.experimental;
    }
    return true;
}
