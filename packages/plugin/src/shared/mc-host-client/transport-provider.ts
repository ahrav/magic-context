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
import type {
    ByteBudget,
    FrameChannelCloseReason,
    FrameChannelHandlers,
    FrameSendTicket,
    SetupFrameChannel,
} from "./frame-channel";
import {
    checkOpaqueSerialized,
    encodeNegotiateRequest,
    NEGOTIATION_VERSION,
    NegotiationError,
    type OpaqueObject,
    TRANSPORT_TCP,
    type TransportOffer,
} from "./transport-negotiation";

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
    private readonly offerSnapshot: readonly TransportOffer[];
    private readonly entries: readonly {
        transport: string;
        capabilityVersion: number;
        provider: ClientTransportProvider;
    }[];

    constructor(providers: readonly ClientTransportProvider[]) {
        // Provider-authored getters and `toJSON` run once, here — never on
        // an authenticated connection's setup path, where synchronous
        // provider code could hold the socket and shared flight
        // indefinitely and a throwing getter would escape unsanitized.
        // Phase 1 runs every provider call (getters plus serialization)
        // inside one containment: any throw — including a provider-forged
        // `NegotiationError` — becomes the bounded registration error.
        let raw: {
            transport: string;
            capabilityVersion: number;
            hasParameters: boolean;
            serializedParameters: string | undefined;
            provider: ClientTransportProvider;
        }[];
        try {
            raw = providers.map((provider) => {
                const parameters = provider.parameters;
                const hasParameters = parameters !== undefined;
                return {
                    transport: provider.transport,
                    capabilityVersion: provider.capabilityVersion,
                    // Presence is tracked separately: a supplied value whose
                    // serialization yields `undefined` (a `toJSON` returning
                    // undefined) is an invalid opaque object, never an
                    // absent one.
                    hasParameters,
                    serializedParameters: hasParameters ? JSON.stringify(parameters) : undefined,
                    provider,
                };
            });
        } catch {
            throw new Error("transport provider registration failed");
        }
        // Phase 2 validates pure data: a NegotiationError raised here is
        // ours and carries only bounded codes and structural paths.
        for (const entry of raw) {
            // "tcp" is reserved for the implicit bootstrap entry: a
            // provider advertising tcp at another capability version could
            // be validly selected by a host, and the client would then
            // continue on the v1 bootstrap channel under a version lie
            // while the provider is never activated.
            if (entry.transport === TRANSPORT_TCP) {
                throw new NegotiationError("invalid_transport_name", "transport");
            }
        }
        this.entries = raw.map((entry) => ({
            transport: entry.transport,
            capabilityVersion: entry.capabilityVersion,
            provider: entry.provider,
        }));
        const offers: TransportOffer[] = raw.map((entry) =>
            entry.hasParameters
                ? {
                      transport: entry.transport,
                      capabilityVersion: entry.capabilityVersion,
                      parameters: checkOpaqueSerialized(entry.serializedParameters, "parameters"),
                  }
                : {
                      transport: entry.transport,
                      capabilityVersion: entry.capabilityVersion,
                  },
        );
        offers.push({ transport: TRANSPORT_TCP, capabilityVersion: TCP_CAPABILITY_VERSION });
        // Static configuration errors (invalid or duplicate identities, a
        // provider named "tcp", too many offers) surface here, before any
        // dial: the encoder's closed-vocabulary rules run against the
        // snapshot so a bad registry cannot consume a connection setup
        // budget or retire a healthy authenticated generation.
        encodeNegotiateRequest({ negotiationVersion: NEGOTIATION_VERSION, offers });
        this.offerSnapshot = offers;
    }

    /** Ordered offers: installed non-TCP providers first, then the required TCP entry. */
    offers(): TransportOffer[] {
        return [...this.offerSnapshot];
    }

    find(transport: string, capabilityVersion: number): ClientTransportProvider | undefined {
        return this.entries.find(
            (entry) =>
                entry.transport === transport && entry.capabilityVersion === capabilityVersion,
        )?.provider;
    }
}

/**
 * The closed channel close-reason vocabulary. A provider channel's runtime
 * `reason` outside this set is provider-controlled text and is replaced:
 * it would otherwise become `RetirementInfo.reason`, pending-request error
 * messages, and the `retired` diagnostics event.
 */
const CHANNEL_CLOSE_REASONS: ReadonlySet<FrameChannelCloseReason> = new Set([
    "socket_error",
    "eof",
    "truncated_frame",
    "socket_closed",
    "socket_timeout",
    "protocol_violation",
    "role_violation",
    "frame_deadline",
    "write_failed",
    "control_capacity_exhausted",
]);

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
 * graphs, retirement info, or diagnostics. `transport` is the cached
 * registry name, never a live provider getter: failure paths must not
 * re-enter provider code to describe a provider failure.
 */
export function sanitizedCandidateFactory(
    transport: string,
    provider: ClientTransportProvider,
    descriptor: OpaqueObject,
): (args: CandidateChannelArgs) => SetupFrameChannel {
    return (args) => {
        const handlers: FrameChannelHandlers = {
            onFrame: args.handlers.onFrame,
            onClosed: (reason, _error) =>
                args.handlers.onClosed(
                    // A runtime reason outside the typed vocabulary is
                    // provider-controlled text; the bounded replacement
                    // keeps it out of retirement info and diagnostics.
                    CHANNEL_CLOSE_REASONS.has(reason) ? reason : "protocol_violation",
                    sanitizedProviderError(transport, "channel"),
                ),
            onDiagnostic: args.handlers.onDiagnostic,
        };
        let channel: SetupFrameChannel;
        try {
            channel = provider.connect(descriptor, { ...args, handlers });
        } catch {
            throw sanitizedProviderError(transport, "connect");
        }
        // Every provider-reachable failure surface is sanitized: send,
        // sendControl, and flush forward through the same bounded-error
        // policy as connect and start.
        return {
            start: async (deadline) => {
                try {
                    const result = await channel.start(deadline);
                    // Plain snapshot: the provider result's getters must not
                    // carry deferred provider code past this boundary, where
                    // a later read would escape unsanitized.
                    return { daemonVer: String(result.daemonVer) };
                } catch {
                    throw sanitizedProviderError(transport, "start");
                }
            },
            beginFrames: () => {
                try {
                    channel.beginFrames();
                } catch {
                    throw sanitizedProviderError(transport, "channel");
                }
            },
            send: (frame, hooks) => {
                let ticket: FrameSendTicket;
                try {
                    ticket = channel.send(frame, hooks);
                } catch (error) {
                    throw sanitizedChannelFailure(transport, "send", error);
                }
                // Built explicitly — never spread from the provider object,
                // whose enumerable getters could throw mid-construction
                // after the frame was already admitted.
                return {
                    cancel: () => {
                        try {
                            return ticket.cancel();
                        } catch {
                            // A throwing provider ticket must not disrupt
                            // pending-entry settlement; `false` is the
                            // "possible send" answer, which the generation
                            // now honors by settling `outcome_unknown`
                            // (never replay-eligible `not_sent`).
                            return false;
                        }
                    },
                };
            },
            sendControl: (header) => {
                try {
                    channel.sendControl(header);
                } catch {
                    // Generation control paths (a Pong answered inside frame
                    // dispatch) do not catch here, so a throw would unwind
                    // through the provider's own onFrame callback. Control
                    // emission failure IS channel failure: surface it as one
                    // close — retirement is idempotent — never an exception
                    // across the frame-delivery callback.
                    args.handlers.onClosed(
                        "write_failed",
                        sanitizedProviderError(transport, "send"),
                    );
                }
            },
            flush: (deadline) =>
                // Best-effort by contract and bounded locally: a provider
                // that ignores its deadline must not stall teardown, and a
                // synchronous throw or rejection must not abort the close
                // path that still has to retire the generation.
                new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, deadline.remainingMs());
                    const settle = (): void => {
                        clearTimeout(timer);
                        resolve();
                    };
                    try {
                        void Promise.resolve(channel.flush(deadline)).then(settle, settle);
                    } catch {
                        settle();
                    }
                }),
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
