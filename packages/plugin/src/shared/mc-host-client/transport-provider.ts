/**
 * Private client-side transport provider registry (U5, KTD2).
 *
 * The production registry is empty: TCP needs no provider object because
 * the authenticated bootstrap channel IS the selected channel on a TCP
 * selection. Non-TCP providers exist only as injected test seams through
 * the internal `McHostClientOptions.transportProviders` option. Deliberately
 * not exported from `index.ts` (R15: no supported consumer provider hooks).
 */

import { McHostCallError } from "./errors";
import {
    BoundedFrameProducer,
    type ByteBudget,
    CopyCounter,
    type FrameChannelCloseReason,
    type FrameChannelDiagnosticType,
    type FrameChannelHandlers,
    type FrameChannelStats,
    type FrameMeta,
    type FrameSendHooks,
    type FrameSendTicket,
    headerViolation,
    type InboundFrame,
    ReceiveLease,
    type SetupFrameChannel,
} from "./frame-channel";
import { type FrameType, MAX_CORRELATION, validateHeader } from "./protocol";
import {
    checkOpaqueSerialized,
    encodeNegotiateRequest,
    NEGOTIATION_VERSION,
    NegotiationError,
    type OpaqueObject,
    serializeOpaqueBounded,
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
    /**
     * Authenticated per-incarnation daemon identity from the connection
     * snapshot that negotiated this grant. Providers scoping replay state
     * (candidate watermarks) key on it, never on the reusable PID.
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
                const transport = provider.transport;
                const capabilityVersion = provider.capabilityVersion;
                // Primitive snapshots only: a non-string transport would
                // defer a provider-owned toString() into the validation
                // phase, outside this containment.
                if (typeof transport !== "string" || typeof capabilityVersion !== "number") {
                    throw new Error("non-primitive provider identity");
                }
                const parameters = provider.parameters;
                const hasParameters = parameters !== undefined;
                return {
                    transport,
                    capabilityVersion,
                    // Presence is tracked separately: a supplied value whose
                    // serialization yields `undefined` (a `toJSON` returning
                    // undefined) is an invalid opaque object, never an
                    // absent one.
                    hasParameters,
                    // Bounded serialization: an oversized provider value is
                    // rejected during traversal, never materialized in full.
                    serializedParameters: hasParameters
                        ? serializeOpaqueBounded(parameters, "parameters")
                        : undefined,
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
    "quarantined",
]);

/** The closed diagnostic-type vocabulary a provider channel may emit. */
const CHANNEL_DIAGNOSTIC_TYPES: ReadonlySet<FrameChannelDiagnosticType> = new Set([
    "write_start",
    "write_complete",
    "header",
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
 * Upper bound on segments one provider frame may carry. The ring transport
 * delivers at most two spans (wrap), so this is generous headroom; its job
 * is to cap the array allocation a provider-controlled count drives.
 */
const MAX_PROVIDER_SEGMENTS = 64;

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
    daemonId: Uint8Array,
): (args: Omit<CandidateChannelArgs, "daemonId">) => SetupFrameChannel {
    return (args) => {
        // Wrapped flush() calls settle here on channel close, matching the
        // FrameChannel contract, instead of waiting out their deadlines.
        const flushWaiters = new Set<() => void>();
        const receiveLeases = new Set<ReceiveLease>();
        // Source-lease identity: a provider delivering the same still-active
        // lease twice would get two wrappers over the same segments, where
        // releasing either detaches the shared lease and silently invalidates
        // the other caller's body.
        const activeSourceLeases = new Set<ReceiveLease>();
        const copyCounter = new CopyCounter();
        let quarantinedBytes = 0;
        // Set before the provider learns about any close, so a provider that
        // synchronously delivers a final frame from close(), or replays a
        // queued callback after retirement, is fenced out of charging the
        // frozen budget or dispatching past the owner.
        let wrapperClosed = false;
        // Single close path: EVERY channel close — provider-reported or
        // wrapper-detected — drains the flush waiters first, so no pending
        // flush outlives the close that should have settled it.
        const closeUpstream = (
            reason: FrameChannelCloseReason,
            phase: "channel" | "send",
        ): void => {
            if (wrapperClosed) return;
            wrapperClosed = true;
            for (const settle of [...flushWaiters]) settle();
            args.handlers.onClosed(reason, sanitizedProviderError(transport, phase));
        };
        const boundedSendFailure = (
            error: unknown,
            outcome: "not_sent" | "outcome_unknown",
        ): McHostCallError =>
            new McHostCallError(
                outcome,
                `transport provider ${transport} failed during send`,
                error instanceof McHostCallError &&
                    error.code !== undefined &&
                    BOUNDED_CHANNEL_CODES.has(error.code)
                    ? error.code
                    : undefined,
            );
        const upstreamDiagnostic = args.handlers.onDiagnostic;
        const handlers: FrameChannelHandlers = {
            onFrame: (frame) => {
                // A frame arriving after close — a provider close() delivering
                // synchronously, or a queued callback running after owner
                // retirement — must not charge the frozen budget or dispatch:
                // its lease is released and the delivery dropped.
                if (wrapperClosed) {
                    try {
                        const lateBody = frame.body;
                        if (lateBody instanceof ReceiveLease && !lateBody.isReleased()) {
                            lateBody.release();
                        }
                    } catch {
                        // Best-effort: the channel is already closed either way.
                    }
                    return;
                }
                // Snapshot and structurally validate the provider frame: a
                // throwing getter or malformed shape becomes one bounded
                // channel close, never an exception unwinding through the
                // provider's reader callback with provider-owned text —
                // and never a stalled published generation.
                let snapshot: InboundFrame;
                let sourceLease: ReceiveLease | null = null;
                let charged = 0;
                try {
                    const header = frame.header;
                    const len = Number(header.len);
                    const ver = Number(header.ver);
                    const ty = Number(header.ty);
                    const flags = Number(header.flags);
                    const channelId = Number(header.channel);
                    const epoch = Number(header.epoch);
                    // Correlation identity must be exact: coercing an
                    // already-rounded number above MAX_SAFE_INTEGER would
                    // key this frame to a DIFFERENT pending request once a
                    // generation's allocator reaches that range.
                    const rawCorr = header.corr;
                    if (
                        typeof rawCorr !== "bigint" &&
                        !(typeof rawCorr === "number" && Number.isSafeInteger(rawCorr))
                    ) {
                        throw new Error("inexact provider correlation");
                    }
                    const corr = BigInt(rawCorr);
                    const providerLease = frame.body;
                    if (
                        ![len, ver, ty, flags, channelId, epoch].every((field) =>
                            Number.isSafeInteger(field),
                        ) ||
                        !(providerLease instanceof ReceiveLease)
                    ) {
                        throw new Error("malformed provider frame");
                    }
                    // A lease already wrapped by an earlier delivery stays
                    // owned by its wrapper: releasing it here would detach the
                    // segments under that wrapper's caller. sourceLease stays
                    // null so the catch below cannot touch it.
                    if (activeSourceLeases.has(providerLease)) {
                        throw new Error("duplicate provider lease");
                    }
                    sourceLease = providerLease;
                    activeSourceLeases.add(providerLease);
                    // Wire widths: `validateHeader` checks flag semantics and
                    // identity rules but NOT field ranges (those live in
                    // `encodeHeader`, which an inbound frame never reaches),
                    // so an out-of-range value like `flags: 256` would pass
                    // semantic validation and dispatch.
                    if (
                        len < 0 ||
                        len > 0xffff_ffff ||
                        ver < 0 ||
                        ver > 0xff ||
                        ty < 0 ||
                        ty > 0xff ||
                        flags < 0 ||
                        flags > 0xff ||
                        channelId < 0 ||
                        channelId > 0xffff ||
                        epoch < 0 ||
                        epoch > 0xffff_ffff ||
                        corr < 0n ||
                        corr > MAX_CORRELATION
                    ) {
                        throw new Error("out-of-range provider header field");
                    }
                    const reported = Number(providerLease.byteLength);
                    if (!Number.isSafeInteger(reported) || reported > args.maxBodyLen) {
                        throw new Error("oversize provider frame");
                    }
                    // The segment count is provider-controlled and drives an
                    // allocation, so it is read once and bounded BEFORE the
                    // array exists: a lying getter could otherwise allocate
                    // gigabytes ahead of every byte-level validation and the
                    // budget charge.
                    const segmentCount = Number(providerLease.segmentCount);
                    if (
                        !Number.isSafeInteger(segmentCount) ||
                        segmentCount < 0 ||
                        segmentCount > MAX_PROVIDER_SEGMENTS
                    ) {
                        throw new Error("provider segment count exceeds the supported bound");
                    }
                    const segments = Array.from({ length: segmentCount }, (_, index) =>
                        providerLease.segment(index),
                    );
                    const segmentBytes = segments.reduce(
                        (total, segment) => total + segment.byteLength,
                        0,
                    );
                    if (segmentBytes !== reported) {
                        throw new Error("provider frame length disagrees with its bytes");
                    }
                    if (args.budget.wouldExceed(reported)) {
                        throw new Error("provider frame exceeds the aggregate cap");
                    }
                    args.budget.charge(reported);
                    charged = reported;
                    const safeHeader = {
                        len,
                        ver,
                        ty: ty as FrameType,
                        flags,
                        channel: channelId,
                        epoch,
                        corr,
                    };
                    validateHeader(safeHeader);
                    if (headerViolation(safeHeader) !== null || safeHeader.len !== reported) {
                        throw new Error("wire-invalid provider frame");
                    }
                    let safeLease: ReceiveLease;
                    safeLease = new ReceiveLease(
                        segments,
                        (outcome) => {
                            receiveLeases.delete(safeLease);
                            activeSourceLeases.delete(providerLease);
                            if (outcome === "released") {
                                if (charged > 0) args.budget.release(charged);
                            } else {
                                quarantinedBytes += charged;
                                closeUpstream("protocol_violation", "channel");
                            }
                            charged = 0;
                            args.handlers.onLeaseReleased?.();
                        },
                        copyCounter,
                        () => (providerLease.release() ? "released" : "quarantined"),
                    );
                    receiveLeases.add(safeLease);
                    snapshot = { header: safeHeader, body: safeLease };
                } catch {
                    let retained = false;
                    if (sourceLease) {
                        activeSourceLeases.delete(sourceLease);
                        // isReleased() and release() are provider-overridable
                        // and may throw; both share one containment so the
                        // rejection always reaches the sanitized close below.
                        // A lease whose state cannot even be read counts as
                        // retained: its storage may still be aliased, so the
                        // charge is quarantined rather than released.
                        try {
                            if (!sourceLease.isReleased()) sourceLease.release();
                        } catch {
                            quarantinedBytes += charged;
                            retained = true;
                        }
                    }
                    if (charged > 0 && !retained) args.budget.release(charged);
                    closeUpstream("protocol_violation", "channel");
                    return;
                }
                try {
                    args.handlers.onFrame(snapshot);
                } catch {
                    try {
                        snapshot.body.release();
                    } catch {
                        closeUpstream("protocol_violation", "channel");
                        return;
                    }
                    closeUpstream("protocol_violation", "channel");
                }
            },
            onClosed: (reason, _error) =>
                closeUpstream(
                    // A runtime reason outside the typed vocabulary is
                    // provider-controlled text; the bounded replacement
                    // keeps it out of retirement info and diagnostics.
                    CHANNEL_CLOSE_REASONS.has(reason) ? reason : "protocol_violation",
                    "channel",
                ),
            onDiagnostic: upstreamDiagnostic
                ? (type, meta) => {
                      // Snapshot to bounded primitives: provider-controlled
                      // strings or throwing getters must not reach the
                      // public diagnostics observer, which the wire doc
                      // requires to stay free of descriptor and token data.
                      if (!CHANNEL_DIAGNOSTIC_TYPES.has(type)) return;
                      let snapshot: FrameMeta;
                      try {
                          snapshot = {
                              ty: Number(meta.ty),
                              channel: Number(meta.channel),
                              epoch: Number(meta.epoch),
                              corr: BigInt(meta.corr),
                              len: Number(meta.len),
                          };
                      } catch {
                          // Diagnostics are best-effort; a malformed event
                          // is dropped, never surfaced raw.
                          return;
                      }
                      upstreamDiagnostic(type, snapshot);
                  }
                : undefined,
        };
        let channel: SetupFrameChannel;
        try {
            channel = provider.connect(descriptor, { ...args, daemonId, handlers });
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
            produce: (header, body, hooks, deadline) => {
                let published = false;
                const trackedHooks: FrameSendHooks = {
                    onPublish: () => {
                        published = true;
                        hooks?.onPublish?.();
                    },
                    ...(hooks?.onComplete ? { onComplete: hooks.onComplete } : {}),
                };
                let ticket: FrameSendTicket;
                try {
                    ticket = channel.produce(header, body, trackedHooks, deadline);
                } catch (error) {
                    const code =
                        error instanceof McHostCallError &&
                        error.code !== undefined &&
                        BOUNDED_CHANNEL_CODES.has(error.code)
                            ? error.code
                            : undefined;
                    if (!published) {
                        throw new McHostCallError(
                            "not_sent",
                            `transport provider ${transport} failed during send`,
                            code,
                        );
                    }
                    closeUpstream("write_failed", "send");
                    throw new McHostCallError(
                        "outcome_unknown",
                        `transport provider ${transport} failed during send`,
                        code,
                    );
                }
                return {
                    cancel: () => {
                        try {
                            return !published && ticket.cancel() === true;
                        } catch {
                            return false;
                        }
                    },
                };
            },
            reserve: (header, capacity, hooks) => {
                let published = false;
                const trackedHooks: FrameSendHooks = {
                    onPublish: () => {
                        published = true;
                        hooks?.onPublish?.();
                    },
                    ...(hooks?.onComplete ? { onComplete: hooks.onComplete } : {}),
                };
                let inner: BoundedFrameProducer;
                try {
                    inner = channel.reserve(header, capacity, trackedHooks);
                    if (!(inner instanceof BoundedFrameProducer)) {
                        throw new TypeError("provider returned an invalid producer");
                    }
                } catch (error) {
                    throw boundedSendFailure(error, "not_sent");
                }
                return new Proxy(inner, {
                    get(target, property) {
                        try {
                            switch (property) {
                                case "capacity":
                                case "written":
                                case "remaining":
                                    return Reflect.get(target, property, target);
                                case "view":
                                    return () => {
                                        try {
                                            return target.view();
                                        } catch (error) {
                                            try {
                                                target.abort();
                                            } catch (abortError) {
                                                void abortError;
                                            }
                                            throw boundedSendFailure(error, "not_sent");
                                        }
                                    };
                                case "advance":
                                    return (bytes: number) => {
                                        try {
                                            return target.advance(bytes);
                                        } catch (error) {
                                            try {
                                                target.abort();
                                            } catch (abortError) {
                                                void abortError;
                                            }
                                            throw boundedSendFailure(error, "not_sent");
                                        }
                                    };
                                case "write":
                                    return (bytes: Uint8Array) => {
                                        try {
                                            return target.write(bytes);
                                        } catch (error) {
                                            try {
                                                target.abort();
                                            } catch (abortError) {
                                                void abortError;
                                            }
                                            throw boundedSendFailure(error, "not_sent");
                                        }
                                    };
                                case "commit":
                                    return (exactLength: number) => {
                                        try {
                                            const ticket = target.commit(exactLength);
                                            return {
                                                cancel: () => {
                                                    try {
                                                        return (
                                                            !published && ticket.cancel() === true
                                                        );
                                                    } catch {
                                                        return false;
                                                    }
                                                },
                                            };
                                        } catch (error) {
                                            try {
                                                target.abort();
                                            } catch (abortError) {
                                                void abortError;
                                            }
                                            if (!published) {
                                                throw boundedSendFailure(error, "not_sent");
                                            }
                                            closeUpstream("write_failed", "send");
                                            throw boundedSendFailure(error, "outcome_unknown");
                                        }
                                    };
                                case "abort":
                                    return () => {
                                        try {
                                            target.abort();
                                        } catch (abortError) {
                                            void abortError;
                                        }
                                    };
                                default:
                                    return undefined;
                            }
                        } catch (error) {
                            throw boundedSendFailure(error, "not_sent");
                        }
                    },
                });
            },
            send: (frame, hooks) => {
                // Publication is tracked HERE, not trusted from the error:
                // a provider-supplied kind could claim any classification,
                // and an ordinary Error would otherwise read as `terminal`.
                let published = false;
                const trackedHooks: FrameSendHooks = {
                    onPublish: () => {
                        published = true;
                        hooks?.onPublish?.();
                    },
                    ...(hooks?.onComplete ? { onComplete: hooks.onComplete } : {}),
                };
                let ticket: FrameSendTicket;
                try {
                    ticket = channel.send(frame, trackedHooks);
                } catch (error) {
                    const code =
                        error instanceof McHostCallError &&
                        error.code !== undefined &&
                        BOUNDED_CHANNEL_CODES.has(error.code)
                            ? error.code
                            : undefined;
                    if (!published) {
                        // Proven refusal: nothing was published, so the
                        // bounded failure is replay-safe `not_sent`.
                        throw new McHostCallError(
                            "not_sent",
                            `transport provider ${transport} failed during send`,
                            code,
                        );
                    }
                    // Publication may have begun: ambiguous. Fail the
                    // channel — retirement settles pending work exactly
                    // once — and classify the throw as never replayable.
                    closeUpstream("write_failed", "send");
                    throw new McHostCallError(
                        "outcome_unknown",
                        `transport provider ${transport} failed during send`,
                        code,
                    );
                }
                // Built explicitly — never spread from the provider object,
                // whose enumerable getters could throw mid-construction
                // after the frame was already admitted.
                return {
                    cancel: () => {
                        try {
                            // Exactly `true` is proof of non-publication; a
                            // truthy non-boolean is not, and treating it as
                            // proof would let the generation settle
                            // `not_sent` (replay-eligible) for a frame the
                            // provider may still publish. Our own publish
                            // observation overrides the provider's answer:
                            // once publication began, no later `true` can
                            // unsay it.
                            return !published && ticket.cancel() === true;
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
                    closeUpstream("write_failed", "send");
                }
            },
            flush: (deadline) =>
                // Best-effort by contract and bounded locally: a provider
                // that ignores its deadline must not stall teardown, a
                // synchronous throw or rejection must not abort the close
                // path that still has to retire the generation, and channel
                // close settles the wait immediately.
                new Promise<void>((resolve) => {
                    const timer = setTimeout(settle, deadline.remainingMs());
                    function settle(): void {
                        clearTimeout(timer);
                        flushWaiters.delete(settle);
                        resolve();
                    }
                    flushWaiters.add(settle);
                    try {
                        void Promise.resolve(channel.flush(deadline)).then(settle, settle);
                    } catch {
                        settle();
                    }
                }),
            close: (error) => {
                // Fenced before the provider observes the close: a final
                // frame delivered synchronously from channel.close() must not
                // charge the frozen budget or dispatch past retirement.
                wrapperClosed = true;
                for (const lease of [...receiveLeases]) {
                    try {
                        lease.release();
                    } catch (error) {
                        void error;
                    }
                }
                // Owner close never fires onClosed (FrameChannel contract),
                // so wrapper-owned flush waiters settle here too: a
                // retiring generation must not leave them pending until
                // the shutdown deadline.
                for (const settle of [...flushWaiters]) settle();
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
            stats: () => {
                const zero: FrameChannelStats = {
                    readerHeldBytes: 0,
                    queueHeldBytes: 0,
                    queuedDataFrames: 0,
                    queuedControlFrames: 0,
                    readPaused: false,
                    activeTimers: 0,
                    activeReceiveLeases: 0,
                    quarantinedBytes: 0,
                    ownedAdapterCopies: 0,
                };
                let stats = zero;
                try {
                    // Every provider getter is read exactly once into a plain
                    // snapshot: keeping (or spreading) the live report object
                    // would re-run throwing getters outside this containment
                    // and copy arbitrary extra properties past the boundary.
                    const reported = channel.stats();
                    const snapshot: FrameChannelStats = {
                        readerHeldBytes: reported.readerHeldBytes,
                        queueHeldBytes: reported.queueHeldBytes,
                        queuedDataFrames: reported.queuedDataFrames,
                        queuedControlFrames: reported.queuedControlFrames,
                        readPaused: reported.readPaused,
                        activeTimers: reported.activeTimers,
                        activeReceiveLeases: reported.activeReceiveLeases,
                        quarantinedBytes: reported.quarantinedBytes,
                        ownedAdapterCopies: reported.ownedAdapterCopies,
                    };
                    const counts = [
                        snapshot.readerHeldBytes,
                        snapshot.queueHeldBytes,
                        snapshot.queuedDataFrames,
                        snapshot.queuedControlFrames,
                        snapshot.activeTimers,
                        snapshot.activeReceiveLeases,
                        snapshot.quarantinedBytes,
                        snapshot.ownedAdapterCopies,
                    ];
                    if (
                        counts.every((value) => Number.isSafeInteger(value) && value >= 0) &&
                        typeof snapshot.readPaused === "boolean"
                    ) {
                        stats = snapshot;
                    }
                } catch {
                    stats = zero;
                }
                return {
                    ...stats,
                    activeReceiveLeases: stats.activeReceiveLeases + receiveLeases.size,
                    quarantinedBytes: stats.quarantinedBytes + quarantinedBytes,
                    ownedAdapterCopies: stats.ownedAdapterCopies + copyCounter.copies,
                };
            },
        };
    };
}
