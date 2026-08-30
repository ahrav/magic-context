import type { SharedMemoryTerminalClass } from "./types";

function errorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
}

/** Maps bounded transport failures without importing native addon loading code. */
export function classifySharedMemoryFailure(error: unknown): SharedMemoryTerminalClass {
    if (error instanceof Error && error.name === "NativeStartupError") {
        const reason = (error as Error & { reason?: unknown }).reason;
        if (typeof reason === "string") {
            return reason === "missing_addon" ? "missing_addon" : "setup_failure";
        }
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
