/**
 * Private client-side transport provider registry (U5, KTD2).
 *
 * The production registry is empty: TCP needs no provider object because
 * the authenticated bootstrap channel IS the selected channel on a TCP
 * selection. Non-TCP providers exist only as injected test seams through
 * the internal `McHostClientOptions.transportProviders` option. Deliberately
 * not exported from `index.ts` (R15: no supported consumer provider hooks).
 */
import { type ByteBudget, type FrameChannelHandlers, type SetupFrameChannel } from "./frame-channel";
import { type OpaqueObject, type TransportOffer } from "./transport-negotiation";
/** The TCP capability version this client offers and accepts. */
export declare const TCP_CAPABILITY_VERSION = 1;
/** Construction arguments for one non-routable candidate channel. */
export interface CandidateChannelArgs {
    /** Shared aggregate byte budget (KTD7). */
    budget: ByteBudget;
    maxBodyLen: number;
    handlers: FrameChannelHandlers;
    /**
     * Authenticated per-incarnation daemon identity, copied from the
     * generation whose handshake proved it and which negotiated this grant.
     * Providers scoping replay state (candidate watermarks) key on it, never
     * on the reusable PID.
     */
    daemonId: Uint8Array;
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
export declare class ClientTransportRegistry {
    private readonly offerSnapshot;
    private readonly entries;
    constructor(providers: readonly ClientTransportProvider[]);
    /** Ordered offers: installed non-TCP providers first, then the required TCP entry. */
    offers(): TransportOffer[];
    find(transport: string, capabilityVersion: number): ClientTransportProvider | undefined;
}
/**
 * Wrap a provider's candidate construction so every provider-originated
 * error surface — constructor throw, `start()` rejection, channel-detected
 * close errors — is sanitized per R14 before it can enter generation error
 * graphs, retirement info, or diagnostics. `transport` is the cached
 * registry name, never a live provider getter: failure paths must not
 * re-enter provider code to describe a provider failure.
 */
export declare function sanitizedCandidateFactory(transport: string, provider: ClientTransportProvider, descriptor: OpaqueObject, daemonId: Uint8Array): (args: Omit<CandidateChannelArgs, "daemonId">) => SetupFrameChannel;
//# sourceMappingURL=transport-provider.d.ts.map