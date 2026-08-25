import { describe, expect, test } from "bun:test";
import { SubcCallError } from "./errors";
import {
    BoundedFrameProducer,
    ByteBudget,
    CopyCounter,
    type FrameChannelCloseReason,
    type FrameChannelHandlers,
    type ProducerFrameHeader,
    ReceiveLease,
    type SetupFrameChannel,
} from "./frame-channel";
import { FrameType, PROTOCOL_VERSION } from "./protocol";
import { type ClientTransportProvider, sanitizedCandidateFactory } from "./transport-provider";

function fakeProviderChannel(overrides: Partial<SetupFrameChannel>): SetupFrameChannel {
    return {
        start: async () => ({ daemonVer: "fake" }),
        beginFrames: () => {},
        produce: () => ({ cancel: () => true }),
        reserve: () => {
            throw new Error("reserve unused");
        },
        send: () => ({ cancel: () => true }),
        sendControl: () => {},
        flush: async () => {},
        close: () => {},
        isClosed: () => false,
        stats: () => ({
            readerHeldBytes: 0,
            queueHeldBytes: 0,
            queuedDataFrames: 0,
            queuedControlFrames: 0,
            readPaused: false,
            activeTimers: 0,
            activeReceiveLeases: 0,
            quarantinedBytes: 0,
            ownedAdapterCopies: 0,
        }),
        ...overrides,
    };
}

function wrap(
    channel: SetupFrameChannel,
    budget = new ByteBudget(1024),
    onFrame: FrameChannelHandlers["onFrame"] = () => {},
) {
    const closes: { reason: FrameChannelCloseReason; error: unknown }[] = [];
    let captured: FrameChannelHandlers | undefined;
    const provider: ClientTransportProvider = {
        transport: "fake",
        capabilityVersion: 1,
        connect: (_descriptor, args) => {
            captured = args.handlers;
            return channel;
        },
    };
    const wrapped = sanitizedCandidateFactory(
        "fake",
        provider,
        {},
    )({
        budget,
        maxBodyLen: 1024,
        handlers: {
            onFrame,
            onClosed: (reason, error) => closes.push({ reason, error }),
        },
    });
    const handlers = captured;
    if (!handlers) throw new Error("provider connect never ran");
    return { wrapped, closes, handlers, budget };
}

const producerHeader: ProducerFrameHeader = {
    ver: PROTOCOL_VERSION,
    ty: FrameType.Request,
    flags: 0,
    channel: 7,
    epoch: 1,
    corr: 1n,
};

describe("sanitized provider channel", () => {
    test("reserve returns an explicitly built producer that forwards at commit", () => {
        const providerWrites: number[][] = [];
        let committedLength: number | null = null;
        const { wrapped } = wrap(
            fakeProviderChannel({
                reserve: (_header, capacity, hooks) =>
                    new BoundedFrameProducer(
                        [new Uint8Array(new ArrayBuffer(capacity))],
                        capacity,
                        (segments, exactLength) => ({
                            publish: () => {
                                committedLength = exactLength;
                                providerWrites.push(Array.from(segments[0] ?? []));
                                hooks?.onPublish?.();
                                return { cancel: () => false };
                            },
                        }),
                        () => {},
                        false,
                    ),
            }),
        );
        const producer = wrapped.reserve(producerHeader, 4);
        producer.write(Buffer.from([1, 2, 3, 4]));
        const ticket = producer.commit(4);
        expect(committedLength).toBe(4);
        expect(providerWrites).toEqual([[1, 2, 3, 4]]);
        expect(ticket.cancel()).toBe(false);
    });

    test("reserve failures surface bounded errors, never provider text", () => {
        const { wrapped } = wrap(
            fakeProviderChannel({
                reserve: () => {
                    throw new Error("secret descriptor");
                },
            }),
        );
        let thrown: unknown;
        try {
            wrapped.reserve(producerHeader, 4);
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(SubcCallError);
        expect(String(thrown)).not.toContain("secret");
    });

    test("commit failures through reserve stay bounded and abort the reservation", () => {
        let abortCalls = 0;
        const { wrapped } = wrap(
            fakeProviderChannel({
                reserve: (_header, capacity) =>
                    new BoundedFrameProducer(
                        [new Uint8Array(new ArrayBuffer(capacity))],
                        capacity,
                        () => ({
                            publish: () => {
                                throw new Error("secret publish failure");
                            },
                        }),
                        () => {
                            abortCalls++;
                        },
                        false,
                    ),
            }),
        );
        const producer = wrapped.reserve(producerHeader, 2);
        producer.write(Buffer.from([1, 2]));
        let thrown: unknown;
        try {
            producer.commit(2);
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(SubcCallError);
        expect((thrown as SubcCallError).kind).toBe("not_sent");
        expect(String(thrown)).not.toContain("secret");
        expect(abortCalls).toBe(1);
    });

    test("stats sanitizes throwing and non-numeric provider reports", () => {
        const throwing = wrap(
            fakeProviderChannel({
                stats: () => {
                    throw new Error("secret stats");
                },
            }),
        );
        expect(throwing.wrapped.stats()).toEqual({
            readerHeldBytes: 0,
            queueHeldBytes: 0,
            queuedDataFrames: 0,
            queuedControlFrames: 0,
            readPaused: false,
            activeTimers: 0,
            activeReceiveLeases: 0,
            quarantinedBytes: 0,
            ownedAdapterCopies: 0,
        });
        const corrupt = wrap(
            fakeProviderChannel({
                stats: () =>
                    ({
                        readerHeldBytes: "evil",
                        queueHeldBytes: 1,
                        queuedDataFrames: 1,
                        queuedControlFrames: 1,
                        readPaused: false,
                        activeTimers: 1,
                        activeReceiveLeases: 1,
                        quarantinedBytes: 1,
                        ownedAdapterCopies: 1,
                    }) as any,
            }),
        );
        expect(corrupt.wrapped.stats().readerHeldBytes).toBe(0);
        expect(corrupt.wrapped.stats().queueHeldBytes).toBe(0);
    });

    test("quarantined source release retains the budget charge", () => {
        const budget = new ByteBudget(1024);
        const { handlers, wrapped, closes } = wrap(fakeProviderChannel({}), budget);
        const segment = new Uint8Array(new ArrayBuffer(5));
        const sourceLease = new ReceiveLease(
            [segment],
            () => {},
            new CopyCounter(),
            () => {
                throw new Error("detach failed");
            },
        );
        // len disagrees with the lease bytes, so validation fails AFTER the
        // aggregate charge; the quarantined source must keep that charge.
        handlers.onFrame({
            header: {
                len: 3,
                ver: PROTOCOL_VERSION,
                ty: FrameType.Response,
                flags: 0,
                channel: 7,
                epoch: 1,
                corr: 1n,
            },
            body: sourceLease,
        });
        expect(closes.map((entry) => entry.reason)).toEqual(["protocol_violation"]);
        expect(budget.used).toBe(5);
        expect(wrapped.stats().quarantinedBytes).toBe(5);
    });

    test("a throwing isReleased on the rejected source lease is contained as quarantined", () => {
        const budget = new ByteBudget(1024);
        const { handlers, wrapped, closes } = wrap(fakeProviderChannel({}), budget);
        const segment = new Uint8Array(new ArrayBuffer(5));
        // isReleased() is provider-overridable: a throw during the rejection
        // path must not unwind the provider's reader callback, and the lease
        // whose state cannot be read keeps its charge quarantined.
        const sourceLease = new (class extends ReceiveLease {
            override isReleased(): boolean {
                throw new Error("state unavailable");
            }
        })(
            [segment],
            () => {},
            new CopyCounter(),
            () => "released",
        );
        expect(() =>
            handlers.onFrame({
                header: {
                    len: 3,
                    ver: PROTOCOL_VERSION,
                    ty: FrameType.Response,
                    flags: 0,
                    channel: 7,
                    epoch: 1,
                    corr: 1n,
                },
                body: sourceLease,
            }),
        ).not.toThrow();
        expect(closes.map((entry) => entry.reason)).toEqual(["protocol_violation"]);
        expect(budget.used).toBe(5);
        expect(wrapped.stats().quarantinedBytes).toBe(5);
    });

    test("a duplicate still-active source lease is rejected without touching the original", () => {
        const budget = new ByteBudget(1024);
        const dispatched: unknown[] = [];
        const { handlers, closes } = wrap(fakeProviderChannel({}), budget, (frame) =>
            dispatched.push(frame),
        );
        const segment = new Uint8Array(new ArrayBuffer(5));
        const sourceLease = new ReceiveLease(
            [segment],
            () => {},
            new CopyCounter(),
            () => "released",
        );
        const frame = {
            header: {
                len: 5,
                ver: PROTOCOL_VERSION,
                ty: FrameType.Response,
                flags: 0,
                channel: 7,
                epoch: 1,
                corr: 1n,
            },
            body: sourceLease,
        };
        handlers.onFrame(frame);
        expect(dispatched.length).toBe(1);
        // Same still-active lease delivered again: two wrappers over the same
        // segments would let either release detach the other's body.
        handlers.onFrame(frame);
        expect(dispatched.length).toBe(1);
        expect(closes.map((entry) => entry.reason)).toEqual(["protocol_violation"]);
        // The rejection must not release the lease the first wrapper owns.
        expect(sourceLease.isReleased()).toBe(false);
        expect(budget.used).toBe(5);
    });

    test("a hostile segment count is rejected before any allocation or charge", () => {
        const budget = new ByteBudget(1024);
        const dispatched: unknown[] = [];
        const { handlers, closes } = wrap(fakeProviderChannel({}), budget, (frame) =>
            dispatched.push(frame),
        );
        const segment = new Uint8Array(new ArrayBuffer(5));
        const lease = new ReceiveLease(
            [segment],
            () => {},
            new CopyCounter(),
            () => "released",
        );
        Object.defineProperty(lease, "segmentCount", { get: () => 2 ** 40 });
        handlers.onFrame({
            header: {
                len: 5,
                ver: PROTOCOL_VERSION,
                ty: FrameType.Response,
                flags: 0,
                channel: 7,
                epoch: 1,
                corr: 1n,
            },
            body: lease,
        });
        expect(dispatched).toEqual([]);
        expect(closes.map((entry) => entry.reason)).toEqual(["protocol_violation"]);
        expect(budget.used).toBe(0);
        expect(lease.isReleased()).toBe(true);
    });

    test("frames delivered after close are dropped without charging the frozen budget", () => {
        const budget = new ByteBudget(1024);
        const dispatched: unknown[] = [];
        const { handlers, wrapped, closes } = wrap(fakeProviderChannel({}), budget, (frame) =>
            dispatched.push(frame),
        );
        // Retirement order: the owner freezes and zeroes the budget, then
        // closes the channel; a late provider frame must not re-charge it.
        budget.freeze();
        wrapped.close(undefined);
        const segment = new Uint8Array(new ArrayBuffer(5));
        const lateLease = new ReceiveLease(
            [segment],
            () => {},
            new CopyCounter(),
            () => "released",
        );
        handlers.onFrame({
            header: {
                len: 5,
                ver: PROTOCOL_VERSION,
                ty: FrameType.Response,
                flags: 0,
                channel: 7,
                epoch: 1,
                corr: 1n,
            },
            body: lateLease,
        });
        expect(dispatched).toEqual([]);
        expect(closes).toEqual([]);
        expect(budget.used).toBe(0);
        expect(lateLease.isReleased()).toBe(true);
    });
});
