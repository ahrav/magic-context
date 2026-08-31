/**
 * Only the client uses this registry for transport providers.
 *
 * TCP selections use the authenticated bootstrap channel directly and need no provider object.
 * Non-TCP providers are injected only through internal `McHostClientOptions.transportProviders`.
 * This module is not exported from `index.ts`; consumers cannot register providers.
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

/* */
export const TCP_CAPABILITY_VERSION = 1;

/** Providers receive these arguments when constructing non-routable candidate channels. */
export interface CandidateChannelArgs {
    /** This budget is shared across candidate channels. */
    budget: ByteBudget;
    maxBodyLen: number;
    handlers: FrameChannelHandlers;
    /**
     * The handshake-authenticated generation supplies this per-incarnation `daemonId`.
     * Providers key candidate watermarks by `daemonId`, not reusable PIDs.
     * Providers key replay state by `daemonId`, not reusable PIDs.
     */
    daemonId: Uint8Array;
}

export interface ClientTransportProvider {
    /** The client offers this bounded lowercase transport name before TCP. */
    readonly transport: string;
    readonly capabilityVersion: number;
    /** The client forwards supplied opaque parameters verbatim in the offer. */
    readonly parameters?: OpaqueObject;
    /**
     * Providers synchronously construct non-routable candidate channels for validated grants.
     * Providers perform attachment I/O in the returned channel's `start()`.
     * Providers must enforce owner-only endpoint access, exclusive peer attachment, incarnation fencing, and stale-descriptor rejection before yielding frames.
     */
    connect(descriptor: OpaqueObject, args: CandidateChannelArgs): SetupFrameChannel;
}

/** The registry consults providers once per connection setup; the selected provider remains fixed for that connection. */
export class ClientTransportRegistry {
    private readonly offerSnapshot: readonly TransportOffer[];
    private readonly entries: readonly {
        transport: string;
        capabilityVersion: number;
        provider: ClientTransportProvider;
    }[];

    constructor(providers: readonly ClientTransportProvider[]) {
        // The constructor snapshots provider getters and `toJSON` so authenticated setup never runs provider code.
        // Synchronous provider code can hold the socket and shared flight indefinitely.
        // The constructor converts every provider exception, including `NegotiationError`, into a bounded registration error.
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
                // The constructor snapshots primitive values before validation to prevent provider-owned `toString()` from running outside containment.
                if (typeof transport !== "string" || typeof capabilityVersion !== "number") {
                    throw new Error("non-primitive provider identity");
                }
                const parameters = provider.parameters;
                const hasParameters = parameters !== undefined;
                return {
                    transport,
                    capabilityVersion,
                    // A `toJSON` result of `undefined` makes a present opaque parameter invalid, not absent.
                    // absent one.
                    hasParameters,
                    // Bounded serialization rejects oversized provider values during traversal before full materialization.
                    serializedParameters: hasParameters
                        ? serializeOpaqueBounded(parameters, "parameters")
                        : undefined,
                    provider,
                };
            });
        } catch {
            throw new Error("transport provider registration failed");
        }
        // Phase 2 raises only library-owned `NegotiationError`s with bounded codes and structural paths.
        for (const entry of raw) {
            // `tcp` is reserved for the implicit bootstrap entry because another capability version could be selected while the client continues on the v1 bootstrap channel and never activates the provider.
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
        // The constructor encodes the offer snapshot before dialing so invalid or duplicate identities, a provider named `tcp`, and excess offers cannot consume a connection setup budget or retire an authenticated generation.
        encodeNegotiateRequest({ negotiationVersion: NEGOTIATION_VERSION, offers });
        this.offerSnapshot = offers;
    }

    /* */
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
 * Provider `reason` values outside this closed vocabulary are replaced before they reach `RetirementInfo.reason`, pending-request errors, or `retired` diagnostics.
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

/** A provider channel may emit only these diagnostic types. */
const CHANNEL_DIAGNOSTIC_TYPES: ReadonlySet<FrameChannelDiagnosticType> = new Set([
    "write_start",
    "write_complete",
    "header",
]);

/**
 * Provider failures expose only `transport` and `phase`.
 * Provider failures do not retain the original message, cause, or stack.
 */
function sanitizedProviderError(
    transport: string,
    phase: "connect" | "start" | "channel" | "send" | "flush",
): Error {
    return new Error(`transport provider ${transport} failed during ${phase}`);
}

/**
 * The generation engine classifies only codes in this set and drops provider-authored codes with their messages.
 */
const BOUNDED_CHANNEL_CODES = new Set([
    "channel_closed",
    "writer_queue_full",
    "memory_cap",
    "control_capacity_exhausted",
    "protocol_violation",
]);

/**
 * This segment limit caps allocation driven by a provider-controlled count; the ring transport emits at most two wrapped spans.
 */
const MAX_PROVIDER_SEGMENTS = 64;

/**
 * The wrapper sanitizes constructor throws, `start()` rejections, and channel-detected close errors.
 * The wrapper sanitizes provider errors before they enter generation error graphs, retirement info, or diagnostics.
 * `transport` stores the registry name rather than a live provider getter.
 * Failure paths must not call provider code while reporting provider failures.
 */
export function sanitizedCandidateFactory(
    transport: string,
    provider: ClientTransportProvider,
    descriptor: OpaqueObject,
    daemonId: Uint8Array,
): (args: Omit<CandidateChannelArgs, "daemonId">) => SetupFrameChannel {
    return (args) => {
        // Closing the channel settles pending wrapped `flush()` calls immediately.
        const flushWaiters = new Set<() => void>();
        const receiveLeases = new Set<ReceiveLease>();
        // The wrapper rejects a duplicate active source lease because releasing either wrapper invalidates the other body.
        // A duplicate active lease would create two wrappers over the same segments.
        const activeSourceLeases = new Set<ReceiveLease>();
        const copyCounter = new CopyCounter();
        let quarantinedBytes = 0;
        // The wrapper sets `wrapperClosed` before notifying the provider so close-triggered frames cannot consume budget or dispatch.
        // The provider can synchronously deliver a final frame from `close()`.
        // Provider callbacks queued before retirement cannot consume the frozen budget or dispatch past the owner.
        let wrapperClosed = false;
        // Every channel close drains `flushWaiters` before notifying the owner.
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
                // A queued provider callback can run after owner retirement.
                // Late frames cannot consume the frozen budget or dispatch.
                // Release late `ReceiveLease` bodies because they cannot reach the owner.
                if (wrapperClosed) {
                    try {
                        const lateBody = frame.body;
                        if (lateBody instanceof ReceiveLease && !lateBody.isReleased()) {
                            lateBody.release();
                        }
                    } catch {
                        // The wrapper ignores release failures because `wrapperClosed` already prevents further dispatch.
                    }
                    return;
                }
                // The wrapper converts throwing getters and malformed provider frames into a bounded channel close.
                // Provider frame validation closes the channel instead of unwinding through the reader callback.
                // The close error omits provider-owned text.
                // Frame validation prevents malformed provider frames from stalling a published generation.
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
                    // The wrapper rejects correlation IDs that are not exact safe integers.
                    // Numbers above `MAX_SAFE_INTEGER` can already be rounded before correlation.
                    // Rounding above `MAX_SAFE_INTEGER` can associate a frame with a different pending request.
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
                    if (activeSourceLeases.has(providerLease)) {
                        throw new Error("duplicate provider lease");
                    }
                    sourceLease = providerLease;
                    activeSourceLeases.add(providerLease);
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
                    CHANNEL_CLOSE_REASONS.has(reason) ? reason : "protocol_violation",
                    "channel",
                ),
            onDiagnostic: upstreamDiagnostic
                ? (type, meta) => {
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
        return {
            start: async (deadline) => {
                try {
                    await channel.start(deadline);
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
                // The wrapper tracks publication locally rather than trusting state carried by the error.
                // Provider-supplied kinds can claim any classification.
                // Without local classification, an ordinary `Error` reads as `terminal`.
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
                        // The wrapper returns replay-safe `not_sent` only when nothing was published.
                        throw new McHostCallError(
                            "not_sent",
                            `transport provider ${transport} failed during send`,
                            code,
                        );
                    }
                    // The wrapper closes the channel when publication may have begun.
                    // Retirement settles pending generation requests.
                    // The adapter throws `outcome_unknown`, which is never replayable.
                    closeUpstream("write_failed", "send");
                    throw new McHostCallError(
                        "outcome_unknown",
                        `transport provider ${transport} failed during send`,
                        code,
                    );
                }
                // The adapter does not spread `ticket` because its enumerable getters can throw after frame admission.
                return {
                    cancel: () => {
                        try {
                            // Only `ticket.cancel() === true` proves non-publication.
                            // A truthy non-boolean result does not prove non-publication.
                            // A non-boolean truthy result could mark a still-publishable frame `not_sent` and replay-eligible.
                            // A prior publication prevents any later cancel result from proving non-publication.
                            // unsay it.
                            return !published && ticket.cancel() === true;
                        } catch {
                            return false;
                        }
                    },
                };
            },
            sendControl: (header) => {
                try {
                    channel.sendControl(header);
                } catch {
                    // The adapter closes the channel and never throws across the frame-delivery callback.
                    closeUpstream("write_failed", "send");
                }
            },
            flush: (deadline) =>
                // Teardown enforces the provider deadline locally.
                // A provider that ignores its deadline must not stall teardown.
                // A synchronous throw or rejection must not abort close.
                // The wrapper settles pending flush waiters before `channel.close()`.
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
                // The adapter sets `wrapperClosed` before `channel.close()` so synchronous final frames are ignored.
                wrapperClosed = true;
                for (const lease of [...receiveLeases]) {
                    try {
                        lease.release();
                    } catch (error) {
                        void error;
                    }
                }
                for (const settle of [...flushWaiters]) settle();
                try {
                    channel.close(error);
                } catch {
                    // Prevent `channel.close()` exceptions from escaping.
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
                    // The snapshot reads each `reported` getter once.
                    // The snapshot reads only `FrameChannelStats` fields to avoid rerunning getters or copying extra properties.
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
