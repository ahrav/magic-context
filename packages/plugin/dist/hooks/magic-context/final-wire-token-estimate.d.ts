import type { MessageLike } from "./tag-messages";
export interface MessageTokenEstimate {
    conversation: number;
    toolCall: number;
}
/** Describe the final three post-transform messages without serializing content. */
export declare function describeFinalWireTail(messages: readonly MessageLike[]): string;
/** Count the token-bearing fields in the message representation sent to OpenCode. */
export declare function estimateMessageTokens(message: MessageLike): MessageTokenEstimate;
export interface FinalWireTokenEstimateInput {
    messages: readonly MessageLike[];
    systemPromptTokens: number;
    providerID: string | undefined;
    modelID: string | undefined;
    agentName: string | undefined;
}
export interface FinalWireTokenEstimate {
    tokens: number;
    trusted: boolean;
    messageTokens: MessageTokenEstimate;
    systemTokens: number;
    toolDefinitionTokens: number | undefined;
}
/**
 * Telemetry-only estimate of the outgoing prompt after transform mutations.
 * System and tool definitions use the sidebar's calibrated measurements, while
 * messages are re-read from the final array. This is diagnostic data, not an
 * abort gate; provider-accurate gating is deferred to module-side Rust accounting.
 */
export declare function estimateFinalWireInputTokens(input: FinalWireTokenEstimateInput): FinalWireTokenEstimate;
//# sourceMappingURL=final-wire-token-estimate.d.ts.map