import type { SharedMemoryTerminalClass } from "./types";

const NATIVE_STARTUP_REASONS: Readonly<Record<string, SharedMemoryTerminalClass>> = {
    missing_addon: "missing_addon",
    unsupported_platform: "setup_failure",
    missing_manifest: "setup_failure",
    wrong_platform_payload: "setup_failure",
    missing_checksum: "setup_failure",
    checksum_mismatch: "setup_failure",
    debug_build: "setup_failure",
    wrong_platform_binary: "setup_failure",
    capability_unavailable: "setup_failure",
};

function errorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
}

/** Maps bounded transport failures without importing native addon loading code. */
export function classifySharedMemoryFailure(error: unknown): SharedMemoryTerminalClass {
    if (error instanceof Error && error.name === "NativeStartupError") {
        const reason = (error as Error & { reason?: unknown }).reason;
        const classification =
            typeof reason === "string" ? NATIVE_STARTUP_REASONS[reason] : undefined;
        if (classification !== undefined) return classification;
    }
    const message = error instanceof Error ? error.message : "";
    const code = errorCode(error);
    if (/identity mismatch/i.test(message)) return "identity_mismatch";
    if (code === "memory_cap" || /(?:capacity|resource).*(?:exhaust|limit)/i.test(message)) {
        return "resource_exhaustion";
    }
    if (
        code === "ECONNRESET" ||
        code === "EPIPE" ||
        /unexpected eof|peer.*(?:died|closed)/i.test(message)
    ) {
        return "peer_death";
    }
    return "setup_failure";
}
