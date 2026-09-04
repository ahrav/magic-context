import { type ProducerIdentity } from "../../features/magic-context/memory/storage-claim-operations";
import type { Database } from "../../shared/sqlite";
import { type CtxMemoryArgs } from "./types";
export type CtxMemoryHarness = "opencode" | "pi";
export interface CtxMemoryCallIdentity {
    harness: CtxMemoryHarness;
    sessionId: string;
    toolCallId: string;
    projectIdentity: string;
}
export interface CtxMemoryProducerIdentity extends ProducerIdentity {
    requestScope: string;
}
/** Tool-call identity is the durable operation key; actions add no live-row suffix. */
export declare function createCtxMemoryProducerIdentity(identity: CtxMemoryCallIdentity): CtxMemoryProducerIdentity;
export interface ExecuteCtxMemoryClaimActionArgs {
    db: Database;
    args: CtxMemoryArgs;
    projectIdentity: string;
    identity: CtxMemoryCallIdentity;
    actor: string;
}
export declare function assertCtxMemoryWriteShape(args: CtxMemoryArgs): void;
export interface CtxMemoryClaimCommit {
    response: string;
    producer: string;
    operationKey: string;
    requestDigest: string;
    resultJson: string;
}
export declare function executeCtxMemoryClaimAction(input: ExecuteCtxMemoryClaimActionArgs): string;
export declare function executeCtxMemoryClaimActionWithCommit(input: ExecuteCtxMemoryClaimActionArgs): CtxMemoryClaimCommit;
//# sourceMappingURL=claim-actions.d.ts.map