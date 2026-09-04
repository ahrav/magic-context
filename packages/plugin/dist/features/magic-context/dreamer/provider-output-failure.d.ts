/** A provider transport failure that arrived as an ordinary assistant completion. */
export declare class DreamerProviderOutputFailureError extends Error {
    readonly fingerprint: string;
    readonly outputTokens: number;
    readonly reasoningTokens: number;
    readonly transient = true;
    constructor(fingerprint: string, outputTokens: number, reasoningTokens: number, responseText: string);
}
/**
 * OpenCode can serialize a provider outage as a successful `finish=stop` assistant
 * message. Only classify that shape after manifest validation has already failed:
 * a real manifest remains authoritative regardless of its token counts.
 */
export declare function providerOutputFailureFromInvalidManifest(messages: unknown, responseText: string): DreamerProviderOutputFailureError | null;
//# sourceMappingURL=provider-output-failure.d.ts.map