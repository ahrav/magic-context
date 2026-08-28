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

export function resolveConnectionOrigin(input: ConnectionOriginInput): ConnectionOrigin {
    if (input.injected) return "injected";
    if (input.connectionFile !== undefined) return "explicit";
    return "managed-default";
}

export function mayDemandStart(origin: ConnectionOrigin): boolean {
    return origin === "managed-default";
}
