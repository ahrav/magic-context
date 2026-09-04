/**
 * `resolveConnectionOrigin` uses configuration inputs, not resolved paths;
 * any configured path, including a canonical path, is `explicit`.
 * `mayDemandStart` permits only `managed-default` provenance.
 */
export type ConnectionOrigin = "managed-default" | "explicit" | "injected";
export interface ConnectionOriginInput {
    connectionFile?: string | undefined;
    injected?: boolean;
}
export declare function resolveConnectionOrigin(input: ConnectionOriginInput): ConnectionOrigin;
export declare function mayDemandStart(origin: ConnectionOrigin): boolean;
//# sourceMappingURL=ownership.d.ts.map