/** Leaf module: no imports from connection or facade code. */

const connectionToken = new WeakMap<RouteHandle, object>();

/**
 * Only `createRouteHandle` registers a connection token, so a directly
 * constructed handle never passes `belongsToConnection`.
 */
export class RouteHandle {
    readonly channel: number;
    readonly epoch: number;

    constructor(channel: number, epoch: number) {
        if (!Number.isInteger(channel) || channel <= 0 || channel > 0xffff) {
            throw new RangeError(`route channel must be an integer in 1..65535, got ${channel}`);
        }
        if (!Number.isInteger(epoch) || epoch <= 0 || epoch > 0xffff_ffff) {
            throw new RangeError(`route epoch must be an integer in 1..4294967295, got ${epoch}`);
        }
        this.channel = channel;
        this.epoch = epoch;
        Object.freeze(this);
    }
}

export function createRouteHandle(channel: number, epoch: number, token: object): RouteHandle {
    const handle = new RouteHandle(channel, epoch);
    connectionToken.set(handle, token);
    return handle;
}

export class StaleRouteHandleError extends Error {
    readonly code = "stale_route_handle";

    constructor(readonly handle: RouteHandle) {
        super(
            `route handle (${handle.channel}, ${handle.epoch}) is not live on the current connection`,
        );
        this.name = "StaleRouteHandleError";
    }
}

export function newConnectionToken(): object {
    return Object.freeze({});
}

/** True when `handle` was created for the connection identified by `token`. */
export function belongsToConnection(handle: RouteHandle, token: object): boolean {
    return connectionToken.get(handle) === token;
}

/** Throw `StaleRouteHandleError` unless `handle` belongs to `token`'s connection. */
export function assertBelongsToConnection(handle: RouteHandle, token: object): void {
    if (!belongsToConnection(handle, token)) {
        throw new StaleRouteHandleError(handle);
    }
}
