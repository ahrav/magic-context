import {
  isMidTurn
} from "./index-xatxycav.js";
import {
  sessionLog
} from "./index-rjbc1j54.js";
import {
  __require
} from "./index-1yh8g550.js";

// src/shared/error-message.ts
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function readString(value) {
  if (typeof value === "string" && value.length > 0)
    return value;
  if (typeof value === "number")
    return String(value);
  return;
}
function clip(value, max) {
  if (value.length <= max)
    return value;
  return `${value.slice(0, max)}…`;
}
function describeError(error) {
  const stringForm = clip(safeString(error), 400);
  if (!(error instanceof Error) && !(error && typeof error === "object")) {
    return {
      name: typeof error,
      message: "",
      stringForm,
      brief: stringForm || "<empty>"
    };
  }
  const obj = error;
  const nameFromField = readString(obj.name);
  const nameFromCtor = error?.constructor?.name;
  const name = nameFromField ?? nameFromCtor ?? "Error";
  const message = readString(obj.message) ?? "";
  const status = readString(obj.status) ?? readString(obj.statusCode);
  const code = readString(obj.code);
  let causeName;
  const cause = obj.cause;
  if (cause && typeof cause === "object") {
    const causeRecord = cause;
    causeName = readString(causeRecord.name) ?? cause.constructor?.name;
  }
  const stack = readString(obj.stack);
  const stackHead = stack ? stack.split(`
`).slice(0, 4).map((l) => l.trim()).filter((l) => l.length > 0).join(" | ") : undefined;
  const briefParts = [];
  if (name)
    briefParts.push(name);
  if (message)
    briefParts.push(`message="${clip(message, 200)}"`);
  if (status)
    briefParts.push(`status=${status}`);
  if (code)
    briefParts.push(`code=${code}`);
  if (causeName)
    briefParts.push(`cause=${causeName}`);
  if (!message && stringForm && stringForm !== name) {
    briefParts.push(`str="${clip(stringForm, 200)}"`);
  }
  const brief = briefParts.join(" ") || stringForm || name;
  return {
    name,
    message,
    ...status ? { status } : {},
    ...code ? { code } : {},
    ...causeName ? { causeName } : {},
    ...stackHead ? { stackHead } : {},
    stringForm,
    brief
  };
}
function safeString(value) {
  try {
    return String(value);
  } catch {
    return "<unstringifiable>";
  }
}

// src/hooks/magic-context/send-session-notification.ts
var MAX_QUEUED_IGNORED_NOTIFICATIONS = 16;
var queuedIgnoredNotifications = new Map;
var flushingIgnoredNotifications = new Set;
var midTurnDetector = (sessionId) => isMidTurn(undefined, sessionId);
function queueIgnoredNotification(notification) {
  const queued = queuedIgnoredNotifications.get(notification.sessionId) ?? [];
  queued.push(notification);
  if (queued.length > MAX_QUEUED_IGNORED_NOTIFICATIONS) {
    queued.splice(0, queued.length - MAX_QUEUED_IGNORED_NOTIFICATIONS);
    sessionLog(notification.sessionId, `ignored notification queue full; dropped oldest entries (kept newest ${MAX_QUEUED_IGNORED_NOTIFICATIONS})`);
  }
  queuedIgnoredNotifications.set(notification.sessionId, queued);
}
async function trySendTuiToast(sessionId, text, params, forcePersist) {
  if (forcePersist)
    return false;
  const title = extractToastTitle(text);
  const message = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  const toastVariant = inferToastVariant(text);
  const duration = params.toastDurationMs ?? 5000;
  const { isTuiConnected: checkTui } = await import("./rpc-notifications-1ffm755w.js");
  if (!checkTui(sessionId))
    return false;
  try {
    const { pushNotification } = await import("./rpc-notifications-1ffm755w.js");
    pushNotification("toast", {
      title,
      message,
      variant: toastVariant,
      duration
    }, sessionId);
    return true;
  } catch {
    sessionLog(sessionId, "TUI RPC toast enqueue failed, falling back to ignored message");
    return false;
  }
}
var __ignoredNotificationTest = {
  pendingTexts(sessionId) {
    return (queuedIgnoredNotifications.get(sessionId) ?? []).map((item) => item.text);
  },
  reset() {
    queuedIgnoredNotifications.clear();
    flushingIgnoredNotifications.clear();
    midTurnDetector = (sessionId) => isMidTurn(undefined, sessionId);
  },
  setMidTurnDetector(detector) {
    midTurnDetector = detector;
  }
};
function hasNotificationSessionClient(client) {
  if (client === null || typeof client !== "object")
    return false;
  const candidate = client;
  if (candidate.session === undefined)
    return true;
  if (candidate.session === null || typeof candidate.session !== "object")
    return false;
  const session = candidate.session;
  return (session.prompt === undefined || typeof session.prompt === "function") && (session.promptAsync === undefined || typeof session.promptAsync === "function");
}
function inferToastVariant(text) {
  const lower = text.toLowerCase();
  if (lower.includes("error") || lower.includes("failed") || lower.includes("alert"))
    return "error";
  if (lower.includes("warning") || lower.includes("⚠"))
    return "warning";
  if (lower.includes("complete") || lower.includes("success") || lower.includes("✓") || lower.includes("finished"))
    return "success";
  return "info";
}
function extractToastTitle(text) {
  const headingMatch = text.match(/^#+\s+(.+)/m);
  if (headingMatch)
    return headingMatch[1].trim();
  const firstLine = text.split(`
`)[0].trim();
  if (firstLine.length <= 80)
    return firstLine;
  return "Magic Context";
}
async function sendIgnoredMessageNow(client, sessionId, text, params, forcePersist) {
  if (midTurnDetector(sessionId)) {
    queueIgnoredNotification({ client, sessionId, text, params, forcePersist });
    return "queued";
  }
  const { waitForSafeNotificationTarget } = await import("./safe-notification-target-ezdgdstq.js");
  if (await waitForSafeNotificationTarget(client, sessionId) === "skip") {
    sessionLog(sessionId, "notification skipped (session not titled yet)");
    return "skipped";
  }
  if (midTurnDetector(sessionId)) {
    queueIgnoredNotification({ client, sessionId, text, params, forcePersist });
    return "queued";
  }
  if (!hasNotificationSessionClient(client)) {
    sessionLog(sessionId, "session prompt API unavailable for notification");
    return "failed";
  }
  const c = client;
  let agent = params.agent || undefined;
  let variant = params.variant || undefined;
  let model = params.providerId && params.modelId ? { providerID: params.providerId, modelID: params.modelId } : undefined;
  if (!agent || !model || !variant) {
    try {
      const { resolvePromptContext } = await import("./prompt-context-29qkb28f.js");
      const resolved = await resolvePromptContext(client, sessionId);
      if (resolved) {
        agent = agent ?? resolved.agent;
        model = model ?? resolved.model;
        variant = variant ?? resolved.variant;
      }
    } catch {}
  }
  if (midTurnDetector(sessionId)) {
    queueIgnoredNotification({ client, sessionId, text, params, forcePersist });
    return "queued";
  }
  const input = {
    path: { id: sessionId },
    body: {
      noReply: true,
      agent,
      model,
      variant,
      parts: [
        {
          type: "text",
          text,
          ignored: true
        }
      ]
    }
  };
  try {
    if (typeof c.session?.prompt === "function") {
      await Promise.resolve(c.session.prompt(input));
      return "sent";
    }
    if (typeof c.session?.promptAsync === "function") {
      await c.session.promptAsync(input);
      return "sent";
    }
    sessionLog(sessionId, "session prompt API unavailable for notification");
    return "failed";
  } catch (error) {
    const msg = getErrorMessage(error);
    sessionLog(sessionId, "failed to send notification:", msg);
    return "failed";
  }
}
async function sendIgnoredMessage(client, sessionId, text, params, forcePersist = false) {
  if (await trySendTuiToast(sessionId, text, params, forcePersist))
    return "sent";
  if (midTurnDetector(sessionId)) {
    queueIgnoredNotification({ client, sessionId, text, params, forcePersist });
    return "queued";
  }
  return sendIgnoredMessageNow(client, sessionId, text, params, forcePersist);
}
async function flushIgnoredMessages(sessionId) {
  if (flushingIgnoredNotifications.has(sessionId) || midTurnDetector(sessionId))
    return;
  const queued = queuedIgnoredNotifications.get(sessionId);
  if (!queued || queued.length === 0)
    return;
  queuedIgnoredNotifications.delete(sessionId);
  flushingIgnoredNotifications.add(sessionId);
  try {
    for (const notification of queued) {
      const disposition = await sendIgnoredMessage(notification.client, notification.sessionId, notification.text, notification.params, notification.forcePersist);
      if (disposition === "queued") {
        for (const remaining of queued.slice(queued.indexOf(notification) + 1)) {
          queueIgnoredNotification(remaining);
        }
        break;
      }
    }
  } finally {
    flushingIgnoredNotifications.delete(sessionId);
  }
}
function clearIgnoredMessages(sessionId) {
  queuedIgnoredNotifications.delete(sessionId);
  flushingIgnoredNotifications.delete(sessionId);
}
async function sendUserPrompt(client, sessionId, text) {
  if (!hasNotificationSessionClient(client)) {
    sessionLog(sessionId, "session prompt API unavailable for user prompt");
    return;
  }
  const c = client;
  const input = {
    path: { id: sessionId },
    body: {
      parts: [{ type: "text", text }]
    }
  };
  try {
    if (typeof c.session?.promptAsync === "function") {
      await c.session.promptAsync(input);
    } else if (typeof c.session?.prompt === "function") {
      await Promise.resolve(c.session.prompt(input));
    } else {
      sessionLog(sessionId, "session prompt API unavailable for user prompt");
    }
  } catch (error) {
    const msg = getErrorMessage(error);
    sessionLog(sessionId, "failed to send user prompt:", msg);
  }
}

export { getErrorMessage, describeError, MAX_QUEUED_IGNORED_NOTIFICATIONS, __ignoredNotificationTest, sendIgnoredMessage, flushIgnoredMessages, clearIgnoredMessages, sendUserPrompt };
