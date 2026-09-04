export interface LoggerDiagnostics {
    swallowedWriteCount: number;
    lastErrorMessage: string | null;
    lastErrorTime: string | null;
}
export declare function log(message: string, data?: unknown): void;
export declare function sessionLog(sessionId: string, message: string, data?: unknown): void;
export declare function getLoggerDiagnostics(): LoggerDiagnostics;
/** Flush buffered log entries immediately. Primarily useful to diagnostic readers and tests. */
export declare function flushLogger(): void;
/**
 * Resolve the current log file path. The path is harness-aware (see
 * {@link getMagicContextLogPath}) and re-evaluated on every call, so callers
 * who format diagnostic output with this value always see the path the next
 * flush will actually use.
 */
export declare function getLogFilePath(): string;
//# sourceMappingURL=logger.d.ts.map