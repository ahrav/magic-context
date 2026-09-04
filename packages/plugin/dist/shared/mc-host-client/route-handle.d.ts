/** Leaf module: no imports from connection or facade code. */
/**
 * Only `createRouteHandle` registers a connection token, so a directly
 * constructed handle never passes `belongsToConnection`.
 */
export declare class RouteHandle {
    readonly channel: number;
    readonly epoch: number;
    constructor(channel: number, epoch: number);
}
export declare function createRouteHandle(channel: number, epoch: number, token: object): RouteHandle;
export declare class StaleRouteHandleError extends Error {
    readonly handle: RouteHandle;
    readonly code = "stale_route_handle";
    constructor(handle: RouteHandle);
}
export declare function newConnectionToken(): object;
/** True when `handle` was created for the connection identified by `token`. */
export declare function belongsToConnection(handle: RouteHandle, token: object): boolean;
/** Throw `StaleRouteHandleError` unless `handle` belongs to `token`'s connection. */
export declare function assertBelongsToConnection(handle: RouteHandle, token: object): void;
//# sourceMappingURL=route-handle.d.ts.map