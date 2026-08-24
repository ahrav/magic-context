/**
 * Private client-side transport provider registry (U5, KTD2).
 *
 * The production registry is empty: TCP needs no provider object because
 * the authenticated bootstrap channel IS the selected channel on a TCP
 * selection. Non-TCP providers exist only as injected test seams through
 * the internal `SubcClientOptions.transportProviders` option. Deliberately
 * not exported from `index.ts` (R15: no supported consumer provider hooks).
 */

import { SubcCallError } from "./errors";
import type { ByteBudget, FrameChannelHandlers, SetupFrameChannel } from "./frame-channel";
import { type OpaqueObject, TRANSPORT_TCP, type TransportOffer } from "./transport-negotiation";

/** The TCP capability version this client offers and accepts. */
export const TCP_CAPABILITY_VERSION = 1;

/** Construction arguments for one non-routable candidate channel. */
export interface CandidateChannelArgs {
    /** Shared aggregate byte budget (KTD7). */
    budget: ByteBudget;
    maxBodyLen: number;
    handlers: FrameChannelHandlers;
}

export interface ClientTransportProvider {
    /** Bounded lowercase transport name (wire doc 7.7.1), offered before TCP. */
    readonly transport: string;
    readonly capabilityVersion: number;
    /** Optional opaque offer parameters forwarded verbatim in the offer. */
    readonly parameters?: OpaqueObject;
    /**
     * Synchronously construct one non-routable candidate channel for a
     * validated grant `descriptor`; attachment I/O belongs in the returned
     * channel's `start()`. KTD9: implementations must enforce owner-only
     * endpoint access, exclusive peer attachment, incarnation fencing, and
     * stale-descriptor rejection before the channel yields frames.
     */
    connect(descriptor: OpaqueObject, args: CandidateChannelArgs): SetupFrameChannel;
}

/** Ordered provider set consulted once per connection setup (KTD5: selection is sticky). */
export class ClientTransportRegistry {
    constructor(private readonly providers: readonly ClientTransportProvider[]) {}

    /** Ordered offers: installed non-TCP providers first, then the required TCP entry. */
    offers(): TransportOffer[] {
        const offers: TransportOffer[] = this.providers.map((provider) =>
            provider.parameters === undefined
                ? {
                      transport: provider.transport,
                      capabilityVersion: provider.capabilityVersion,
                  }
                : {
                      transport: provider.transport,
                      capabilityVersion: provider.capabilityVersion,
                      parameters: provider.parameters,
                  },
        );
        offers.push({ transport: TRANSPORT_TCP, capabilityVersion: TCP_CAPABILITY_VERSION });
        return offers;
    }

    find(transport: string, capabilityVersion: number): ClientTransportProvider | undefined {
        return this.providers.find(
            (provider) =>
                provider.transport === transport &&
                provider.capabilityVersion === capabilityVersion,
        );
    }
}

/**
 * R14 provider boundary: replace a provider-owned failure with a bounded
 * error carrying only the already-validated transport name and a fixed
 * phase word. The original message, cause chain, and stack are dropped
 * because provider code may reference descriptors, tokens, or endpoints.
 */
function sanitizedProviderError(
    transport: string,
    phase: "connect" | "start" | "channel" | "send" | "flush",
): Error {
    return new Error(`transport provider ${transport} failed during ${phase}`);
}

/**
 * Channel-operation codes the generation engine classifies by. Anything
 * outside this set is provider-authored and dropped with the message.
 */
const BOUNDED_CHANNEL_CODES = new Set([
    "channel_closed",
    "writer_queue_full",
    "memory_cap",
    "control_capacity_exhausted",
    "protocol_violation",
]);

/**
 * Sanitize one provider channel-operation failure. The engine's replay and
 * admission logic reads `SubcCallError` kind and code, so those bounded
 * fields survive (code only when it names a known channel outcome); the
 * message, cause chain, and stack are always replaced because provider
 * code may reference descriptors, tokens, or endpoints (R14).
 */
function sanitizedChannelFailure(
    transport: string,
    phase: "send" | "flush",
    error: unknown,
): Error {
    if (error instanceof SubcCallError) {
        return new SubcCallError(
            error.kind,
            `transport provider ${transport} failed during ${phase}`,
            error.code !== undefined && BOUNDED_CHANNEL_CODES.has(error.code)
                ? error.code
                : undefined,
        );
    }
    return sanitizedProviderError(transport, phase);
}

/**
 * Wrap a provider's candidate construction so every provider-originated
 * error surface — constructor throw, `start()` rejection, channel-detected
 * close errors — is sanitized per R14 before it can enter generation error
 * graphs, retirement info, or diagnostics.
 */
export function sanitizedCandidateFactory(
    provider: ClientTransportProvider,
    descriptor: OpaqueObject,
): (args: CandidateChannelArgs) => SetupFrameChannel {
    return (args) => {
        const handlers: FrameChannelHandlers = {
            onFrame: args.handlers.onFrame,
            onClosed: (reason, _error) =>
                args.handlers.onClosed(
                    reason,
                    sanitizedProviderError(provider.transport, "channel"),
                ),
            onDiagnostic: args.handlers.onDiagnostic,
        };
        let channel: SetupFrameChannel;
        try {
            channel = provider.connect(descriptor, { ...args, handlers });
        } catch {
            throw sanitizedProviderError(provider.transport, "connect");
        }
        // Every provider-reachable failure surface is sanitized: send,
        // sendControl, and flush forward through the same bounded-error
        // policy as connect and start.
        return {
            start: async (deadline) => {
                try {
                    return await channel.start(deadline);
                } catch {
                    throw sanitizedProviderError(provider.transport, "start");
                }
            },
            beginFrames: () => {
                try {
                    channel.beginFrames();
                } catch {
                    throw sanitizedProviderError(provider.transport, "channel");
                }
            },
            send: (frame, hooks) => {
                try {
                    return channel.send(frame, hooks);
                } catch (error) {
                    throw sanitizedChannelFailure(provider.transport, "send", error);
                }
            },
            sendControl: (header) => {
                try {
                    channel.sendControl(header);
                } catch (error) {
                    throw sanitizedChannelFailure(provider.transport, "send", error);
                }
            },
            flush: async (deadline) => {
                try {
                    return await channel.flush(deadline);
                } catch (error) {
                    throw sanitizedChannelFailure(provider.transport, "flush", error);
                }
            },
            close: (error) => {
                try {
                    channel.close(error);
                } catch {
                    // Swallowed: close runs inside generation retirement,
                    // after retirement state is set but before its promise
                    // resolves — a provider throw here would leave the
                    // retirement unresolved and the facade's active slot
                    // stuck. The channel is being abandoned either way.
                }
            },
            isClosed: () => channel.isClosed(),
            stats: () => channel.stats(),
        };
    };
}
