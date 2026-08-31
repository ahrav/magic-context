import { describe, expect, test } from "bun:test";
import {
    drainNotifications,
    isTuiConnected,
    type NotificationSink,
    pushNotification,
    registerNotificationSink,
} from "./rpc-notifications";

describe("rpc notifications", () => {
    test("keeps messages queued until the client acks their id", () => {
        const initial = drainNotifications(Number.MAX_SAFE_INTEGER);
        expect(initial).toEqual([]);

        pushNotification("one", { ok: true }, "ses_1");
        const firstPoll = drainNotifications();
        expect(firstPoll).toHaveLength(1);
        expect(firstPoll[0].type).toBe("one");

        const retryPoll = drainNotifications();
        expect(retryPoll.map((m) => m.id)).toEqual(firstPoll.map((m) => m.id));

        const lastReceivedId = Math.max(...firstPoll.map((m) => m.id));
        expect(drainNotifications(lastReceivedId)).toEqual([]);
    });

    test("scopes drain to the requesting session; other sessions' items survive", () => {
        drainNotifications(Number.MAX_SAFE_INTEGER);

        pushNotification("for-a", { action: "show-upgrade-dialog" }, "ses_A");
        pushNotification("for-b", { action: "show-upgrade-dialog" }, "ses_B");
        pushNotification("global", { action: "show-status-dialog" });

        // Session A sees only its own item + the global one, never ses_B's.
        const aPoll = drainNotifications(0, "ses_A");
        expect(aPoll.map((m) => m.type).sort()).toEqual(["for-a", "global"]);

        // Acking session A must NOT prune session B's still-unseen notification.
        const ackId = Math.max(...aPoll.map((m) => m.id));
        drainNotifications(ackId, "ses_A");
        const bPoll = drainNotifications(0, "ses_B");
        expect(bPoll.map((m) => m.type)).toContain("for-b");
    });

    test("session-less drain (legacy client) still receives all items", () => {
        drainNotifications(Number.MAX_SAFE_INTEGER);
        pushNotification("x", { ok: true }, "ses_1");
        pushNotification("y", { ok: true }, "ses_2");
        const poll = drainNotifications(0);
        expect(poll.map((m) => m.type).sort()).toEqual(["x", "y"]);
    });

    test("isTuiConnected reflects live WS sinks per-session", () => {
        // isTuiConnected returns false for every session and globally when no sinks are registered.
        expect(isTuiConnected("ses_anything")).toBe(false);
        expect(isTuiConnected()).toBe(false);

        // A live sink for session A makes isTuiConnected true only for session A and globally.
        const unregister = registerNotificationSink({ sessionId: "ses_A", send: () => {} });
        expect(isTuiConnected("ses_A")).toBe(true);
        expect(isTuiConnected("ses_B")).toBe(false);
        expect(isTuiConnected()).toBe(true);

        // Unregistering the sink makes isTuiConnected return false for session A and globally.
        unregister();
        expect(isTuiConnected("ses_A")).toBe(false);
        expect(isTuiConnected()).toBe(false);
    });

    test("a modern session-less sink is global-only", () => {
        const received: string[] = [];
        const unregister = registerNotificationSink({
            sessionId: undefined,
            protocol: 2,
            send: (notification) => received.push(notification.type),
        });
        expect(isTuiConnected("ses_whatever")).toBe(false);
        expect(isTuiConnected()).toBe(true);

        pushNotification("scoped", { ok: true }, "ses_whatever");
        pushNotification("global", { ok: true });
        expect(received).toEqual(["global"]);
        unregister();
    });

    test("a legacy session-less sink retains broad compatibility", () => {
        const unregister = registerNotificationSink({ sessionId: undefined, send: () => {} });
        expect(isTuiConnected("ses_whatever")).toBe(true);
        unregister();
    });

    test("pushNotification fans out live to a matching sink and skips a foreign session", () => {
        drainNotifications(Number.MAX_SAFE_INTEGER);
        const received: string[] = [];
        const sink: NotificationSink = {
            sessionId: "ses_live",
            send: (n) => received.push(n.type),
        };
        const unregister = registerNotificationSink(sink);

        pushNotification("for-live", { action: "show-status-dialog" }, "ses_live");
        pushNotification("for-other", { action: "show-status-dialog" }, "ses_other");
        pushNotification("global", { action: "show-status-dialog" });

        // The sink sees its own session + global, never the foreign session.
        expect(received.sort()).toEqual(["for-live", "global"]);
        unregister();
    });

    test("a dead sink (throwing send) does not block delivery to other sinks", () => {
        drainNotifications(Number.MAX_SAFE_INTEGER);
        const live: string[] = [];
        const unregDead = registerNotificationSink({
            sessionId: undefined,
            send: () => {
                throw new Error("socket dead");
            },
        });
        const unregLive = registerNotificationSink({
            sessionId: undefined,
            send: (n) => live.push(n.type),
        });
        // pushNotification must not throw, and the live sink must receive the notification.
        expect(() => pushNotification("resilient", { ok: true })).not.toThrow();
        expect(live).toEqual(["resilient"]);
        unregDead();
        unregLive();
    });

    test("queue-cap eviction is session-fair: a noisy session cannot evict another session's newest unseen item", () => {
        drainNotifications(Number.MAX_SAFE_INTEGER);
        pushNotification("quiet-dialog", { action: "show-upgrade-dialog" }, "ses_quiet");
        for (let i = 0; i < 200; i += 1) {
            pushNotification("noise", { i }, "ses_noisy");
        }
        const quietPoll = drainNotifications(0, "ses_quiet");
        expect(quietPoll.some((m) => m.type === "quiet-dialog")).toBe(true);
        expect(drainNotifications(0)).toHaveLength(100);
    });

    test("queue cap remains global across more than one hundred sessions", () => {
        drainNotifications(Number.MAX_SAFE_INTEGER);
        for (let i = 0; i < 250; i += 1) {
            pushNotification("one-per-session", { i }, `ses_${i}`);
        }
        expect(drainNotifications(0)).toHaveLength(100);
    });
});
