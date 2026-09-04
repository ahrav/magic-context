import {
  readJsoncFile
} from "./index-8mtsfhyg.js";
import {
  waitForSafeNotificationTarget
} from "./index-98b2185h.js";
import {
  log
} from "./index-rjbc1j54.js";
import {
  __require
} from "./index-1yh8g550.js";

// src/plugin/conflict-warning-hook.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir as homedir3, platform } from "node:os";
import { join as join3 } from "node:path";

// src/shared/conflict-detector.ts
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";

// src/shared/opencode-config-dir.ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";
function getCliConfigDir() {
  const envConfigDir = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (envConfigDir) {
    return resolve(envConfigDir);
  }
  if (process.platform === "win32") {
    return join(homedir(), ".config", "opencode");
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
}
function getOpenCodeConfigDir(_options) {
  return getCliConfigDir();
}
function getOpenCodeConfigPaths(options) {
  const configDir = getOpenCodeConfigDir(options);
  return {
    configDir,
    configJson: join(configDir, "opencode.json"),
    configJsonc: join(configDir, "opencode.jsonc"),
    packageJson: join(configDir, "package.json"),
    omoConfig: join(configDir, "magic-context.jsonc")
  };
}

// src/shared/conflict-detector.ts
function detectConflicts(directory, options) {
  const compactionEnabled = options?.compactionEnabled ?? true;
  const conflicts = {
    compactionAuto: false,
    compactionPrune: false,
    dcpPlugin: false,
    omoPreemptiveCompaction: false,
    omoContextWindowMonitor: false,
    omoAnthropicRecovery: false
  };
  const reasons = [];
  let compactionResult = options?.resolvedCompaction ?? checkCompaction(directory);
  if (process.env.OPENCODE_DISABLE_AUTOCOMPACT) {
    compactionResult = { auto: false, prune: false };
  }
  if (compactionEnabled && compactionResult.auto) {
    conflicts.compactionAuto = true;
    reasons.push(options?.resolvedCompaction ? "OpenCode auto-compaction is enabled (compaction.auto=true) (resolved config)" : "OpenCode auto-compaction is enabled (compaction.auto=true)");
  }
  if (compactionEnabled && compactionResult.prune) {
    conflicts.compactionPrune = true;
    reasons.push(options?.resolvedCompaction ? "OpenCode prune is enabled (compaction.prune=true) (resolved config)" : "OpenCode prune is enabled (compaction.prune=true)");
  }
  const dcpFound = checkDcpPlugin(directory);
  if (dcpFound) {
    conflicts.dcpPlugin = true;
    reasons.push("opencode-dcp plugin is installed — it conflicts with Magic Context's context management");
  }
  const omoResult = checkOmoHooks(directory);
  if (omoResult.preemptiveCompaction) {
    conflicts.omoPreemptiveCompaction = true;
    reasons.push("oh-my-opencode preemptive-compaction hook is active — it triggers compaction that conflicts with historian");
  }
  if (omoResult.contextWindowMonitor) {
    conflicts.omoContextWindowMonitor = true;
    reasons.push("oh-my-opencode context-window-monitor hook is active — it injects usage warnings that overlap with Magic Context nudges");
  }
  if (omoResult.anthropicRecovery) {
    conflicts.omoAnthropicRecovery = true;
    reasons.push("oh-my-opencode anthropic-context-window-limit-recovery hook is active — it triggers emergency compaction that bypasses historian");
  }
  return {
    hasConflict: reasons.length > 0,
    reasons,
    conflicts,
    nativeCompaction: { auto: compactionResult.auto, prune: compactionResult.prune }
  };
}
async function resolveCompactionForBoot(client, timeoutMs = 2000) {
  try {
    const result = await Promise.race([
      client.config.get(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("config.get() timed out")), timeoutMs))
    ]);
    const compaction = result?.data?.compaction;
    if (typeof compaction?.auto !== "boolean" || typeof compaction?.prune !== "boolean") {
      log(`[magic-context] conflict-detector: resolved config carried no explicit compaction block (${JSON.stringify(compaction) ?? "absent"}); falling back to file-based detection`);
      return null;
    }
    return { auto: compaction.auto, prune: compaction.prune };
  } catch {
    return null;
  }
}
function checkCompaction(directory) {
  if (process.env.OPENCODE_DISABLE_AUTOCOMPACT) {
    return { auto: false, prune: false };
  }
  const projectResult = readProjectCompaction(directory);
  if (projectResult.resolved)
    return projectResult;
  const userResult = readUserCompaction();
  if (userResult.resolved)
    return userResult;
  return { auto: true, prune: false };
}
function readProjectCompaction(directory) {
  const dotOcJsonc = join2(directory, ".opencode", "opencode.jsonc");
  const dotOcJson = join2(directory, ".opencode", "opencode.json");
  const dotOcConfig = readJsoncFile(dotOcJsonc) ?? readJsoncFile(dotOcJson);
  if (dotOcConfig?.compaction) {
    const c = dotOcConfig.compaction;
    if (c.auto !== undefined || c.prune !== undefined) {
      return { auto: c.auto === true, prune: c.prune === true, resolved: true };
    }
  }
  const rootJsonc = join2(directory, "opencode.jsonc");
  const rootJson = join2(directory, "opencode.json");
  const rootConfig = readJsoncFile(rootJsonc) ?? readJsoncFile(rootJson);
  if (rootConfig?.compaction) {
    const c = rootConfig.compaction;
    if (c.auto !== undefined || c.prune !== undefined) {
      return { auto: c.auto === true, prune: c.prune === true, resolved: true };
    }
  }
  return { auto: false, prune: false, resolved: false };
}
function readUserCompaction() {
  try {
    const paths = getOpenCodeConfigPaths({ binary: "opencode" });
    const config = readJsoncFile(paths.configJsonc) ?? readJsoncFile(paths.configJson);
    if (config?.compaction) {
      const c = config.compaction;
      if (c.auto !== undefined || c.prune !== undefined) {
        return { auto: c.auto === true, prune: c.prune === true, resolved: true };
      }
    }
  } catch {}
  return { auto: false, prune: false, resolved: false };
}
var DCP_PACKAGE_NAMES = new Set(["@tarquinen/opencode-dcp"]);
function checkDcpPlugin(directory) {
  const plugins = collectPluginEntries(directory);
  return plugins.some((p) => matchesPackageName(p, DCP_PACKAGE_NAMES));
}
function matchesPackageName(entry, canonicalNames) {
  if (entry.startsWith("file:") || entry.startsWith("http:") || entry.startsWith("https:") || entry.startsWith("/") || entry.startsWith("./") || entry.startsWith("../")) {
    return false;
  }
  const lastAt = entry.lastIndexOf("@");
  const nameOnly = lastAt > 0 ? entry.slice(0, lastAt) : entry;
  return canonicalNames.has(nameOnly);
}
function extractPluginName(entry) {
  if (typeof entry === "string")
    return entry;
  if (Array.isArray(entry) && typeof entry[0] === "string")
    return entry[0];
  return null;
}
function collectPluginEntries(directory) {
  const plugins = [];
  const pushFrom = (entries) => {
    if (!entries)
      return;
    for (const entry of entries) {
      const name = extractPluginName(entry);
      if (name)
        plugins.push(name);
    }
  };
  for (const configPath of [
    join2(directory, ".opencode", "opencode.jsonc"),
    join2(directory, ".opencode", "opencode.json"),
    join2(directory, "opencode.jsonc"),
    join2(directory, "opencode.json")
  ]) {
    const config = readJsoncFile(configPath);
    pushFrom(config?.plugin);
  }
  try {
    const paths = getOpenCodeConfigPaths({ binary: "opencode" });
    for (const configPath of [paths.configJsonc, paths.configJson]) {
      const config = readJsoncFile(configPath);
      pushFrom(config?.plugin);
    }
  } catch {}
  return plugins;
}
var OMO_PACKAGE_NAMES = new Set(["oh-my-opencode", "oh-my-openagent"]);
function checkOmoHooks(directory) {
  const result = {
    preemptiveCompaction: false,
    contextWindowMonitor: false,
    anthropicRecovery: false
  };
  const plugins = collectPluginEntries(directory);
  const hasOmo = plugins.some((p) => matchesPackageName(p, OMO_PACKAGE_NAMES));
  if (!hasOmo)
    return result;
  const disabledHooks = readOmoDisabledHooks(directory);
  result.preemptiveCompaction = !disabledHooks.has("preemptive-compaction");
  result.contextWindowMonitor = !disabledHooks.has("context-window-monitor");
  result.anthropicRecovery = !disabledHooks.has("anthropic-context-window-limit-recovery");
  return result;
}
function readOmoDisabledHooks(directory) {
  const disabled = new Set;
  const configNames = [
    "oh-my-opencode.jsonc",
    "oh-my-opencode.json",
    "oh-my-openagent.jsonc",
    "oh-my-openagent.json"
  ];
  try {
    const paths = getOpenCodeConfigPaths({ binary: "opencode" });
    for (const name of configNames) {
      const configPath = join2(paths.configDir, name);
      const config = readJsoncFile(configPath);
      if (config?.disabled_hooks) {
        for (const hook of config.disabled_hooks) {
          disabled.add(hook);
        }
      }
    }
  } catch {}
  for (const name of configNames) {
    const config = readJsoncFile(join2(directory, name));
    if (config?.disabled_hooks) {
      for (const hook of config.disabled_hooks) {
        disabled.add(hook);
      }
    }
  }
  const homeDir = process.env.HOME || homedir2();
  const omoHomeDir = join2(homeDir, ".omo");
  for (const name of ["omo.jsonc", "omo.json"]) {
    const config = readJsoncFile(join2(omoHomeDir, name));
    if (config?.["[opencode]"]?.disabled_hooks) {
      for (const hook of config["[opencode]"].disabled_hooks) {
        disabled.add(hook);
      }
    }
  }
  for (const name of ["omo.jsonc", "omo.json"]) {
    const config = readJsoncFile(join2(directory, ".omo", name));
    if (config?.["[opencode]"]?.disabled_hooks) {
      for (const hook of config["[opencode]"].disabled_hooks) {
        disabled.add(hook);
      }
    }
  }
  return disabled;
}
function formatConflictShort(result) {
  if (!result.hasConflict)
    return "";
  const lines = [
    "⚠️ Magic Context is disabled due to conflicting configuration:",
    "",
    ...result.reasons.map((r) => `• ${r}`),
    "",
    "Fix: run `npx @cortexkit/opencode-magic-context@latest doctor`"
  ];
  return lines.join(`
`);
}

// src/plugin/conflict-warning-hook.ts
var CONFLICT_WARNING_MARKER = "⚠️ Magic Context is disabled due to conflicting configuration:";
var SCHEMA_FENCE_MARKER = "⚠️ Magic Context is disabled — database is newer than this version";
var ENABLED_MARKER = "✨ Magic Context is now enabled";
var ANNOUNCEMENT_MARKER = "✨ Magic Context — what's new in";
function getDesktopStatePath() {
  const os = platform();
  const home = homedir3();
  if (os === "darwin") {
    return join3(home, "Library", "Application Support", "ai.opencode.desktop", "opencode.global.dat");
  }
  if (os === "linux") {
    const xdgConfig = process.env.XDG_CONFIG_HOME || join3(home, ".config");
    return join3(xdgConfig, "ai.opencode.desktop", "opencode.global.dat");
  }
  if (os === "win32") {
    const appData = process.env.APPDATA || join3(home, "AppData", "Roaming");
    return join3(appData, "ai.opencode.desktop", "opencode.global.dat");
  }
  return null;
}
function readDesktopState(directory) {
  const statePath = getDesktopStatePath();
  if (!statePath || !existsSync(statePath)) {
    log(`[magic-context] conflict-warning: Desktop state file not found at ${statePath}`);
    return { sessionId: null, sidecarUrl: null };
  }
  try {
    const raw = readFileSync(statePath, "utf-8");
    const state = JSON.parse(raw);
    let sidecarUrl = null;
    const serverStr = state.server;
    if (typeof serverStr === "string") {
      try {
        const serverState = JSON.parse(serverStr);
        if (typeof serverState.currentSidecarUrl === "string") {
          sidecarUrl = serverState.currentSidecarUrl;
        }
      } catch {}
    }
    let sessionId = null;
    const layoutPage = state["layout.page"];
    if (typeof layoutPage === "string") {
      const parsed = JSON.parse(layoutPage);
      const lastProjectSession = parsed.lastProjectSession;
      if (lastProjectSession) {
        const entry = lastProjectSession[directory];
        sessionId = entry?.id ?? null;
      }
    }
    return { sessionId, sidecarUrl };
  } catch (error) {
    log(`[magic-context] conflict-warning: failed to read Desktop state: ${error instanceof Error ? error.message : String(error)}`);
    return { sessionId: null, sidecarUrl: null };
  }
}
var cachedDesktopStateByDir = new Map;
function getDesktopState(directory) {
  let cached = cachedDesktopStateByDir.get(directory);
  if (!cached) {
    cached = readDesktopState(directory);
    cachedDesktopStateByDir.set(directory, cached);
  }
  return cached;
}
async function deleteMessage(serverUrl, sessionId, messageId) {
  const auth = getServerAuth();
  const url = `${serverUrl}/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`;
  try {
    const response = await fetch(url, {
      method: "DELETE",
      headers: auth ? { Authorization: auth } : {},
      signal: AbortSignal.timeout(1e4)
    });
    if (!response.ok) {
      log(`[magic-context] conflict-warning: DELETE failed status=${response.status} url=${url}`);
      return false;
    }
    return true;
  } catch (error) {
    log(`[magic-context] conflict-warning: DELETE error (url=${serverUrl}): ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
function getServerAuth() {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password)
    return;
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}
async function getSessionMessages(client, sessionId) {
  try {
    const c = client;
    if (typeof c.session?.messages === "function") {
      const result = await c.session.messages({
        path: { id: sessionId },
        query: { limit: 50 }
      });
      return result?.data ?? [];
    }
  } catch (error) {
    log(`[magic-context] conflict-warning: failed to read messages: ${error instanceof Error ? error.message : String(error)}`);
  }
  return [];
}
async function sendConflictWarning(client, directory, conflictResult) {
  const { sessionId } = getDesktopState(directory);
  if (!sessionId) {
    log("[magic-context] conflict-warning: could not find active session for Desktop warning");
    return;
  }
  if (await waitForSafeNotificationTarget(client, sessionId) === "skip")
    return;
  const warningText = formatConflictShort(conflictResult);
  log(`[magic-context] sending conflict warning to session ${sessionId}: ${conflictResult.reasons.join(", ")}`);
  try {
    const c = client;
    const promptInput = {
      path: { id: sessionId },
      body: {
        noReply: true,
        parts: [
          {
            type: "text",
            text: warningText,
            ignored: true
          }
        ]
      }
    };
    if (typeof c.session?.prompt === "function") {
      await Promise.resolve(c.session.prompt(promptInput));
    } else if (typeof c.session?.promptAsync === "function") {
      await c.session.promptAsync(promptInput);
    } else {
      log("[magic-context] conflict-warning: session prompt API unavailable");
    }
  } catch (error) {
    log(`[magic-context] conflict-warning: failed to send: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function cleanupConflictWarnings(client, directory, serverUrl) {
  const { sessionId } = getDesktopState(directory);
  if (!sessionId) {
    log("[magic-context] cleanup: no active Desktop session found");
    return;
  }
  const messages = await getSessionMessages(client, sessionId);
  if (messages.length === 0)
    return;
  const warningMessageIds = [];
  for (let i = messages.length - 1;i >= 0; i--) {
    const msg = messages[i];
    const msgId = msg.info?.id;
    const msgRole = msg.info?.role;
    if (!msgId || msgRole !== "user")
      break;
    const parts = msg.parts ?? [];
    const isWarning = parts.length > 0 && parts.every((p) => p.ignored === true && p.type === "text" && typeof p.text === "string" && p.text.startsWith(CONFLICT_WARNING_MARKER));
    if (isWarning) {
      warningMessageIds.push(msgId);
    } else {
      break;
    }
  }
  if (warningMessageIds.length === 0) {
    await cleanupEnabledMessages(messages, serverUrl, sessionId);
    return;
  }
  if (!serverUrl) {
    log("[magic-context] cleanup: no serverUrl provided, cannot delete messages");
    return;
  }
  log(`[magic-context] cleaning up ${warningMessageIds.length} conflict warning message(s) from session ${sessionId}`);
  for (const messageId of warningMessageIds) {
    const ok = await deleteMessage(serverUrl, sessionId, messageId);
    if (ok) {
      log(`[magic-context] deleted conflict warning message ${messageId}`);
    }
  }
  if (await waitForSafeNotificationTarget(client, sessionId) === "skip")
    return;
  const enabledText = `${ENABLED_MARKER}. Enjoy! ✨`;
  try {
    const c = client;
    const promptInput = {
      path: { id: sessionId },
      body: {
        noReply: true,
        parts: [{ type: "text", text: enabledText, ignored: true }]
      }
    };
    if (typeof c.session?.prompt === "function") {
      await Promise.resolve(c.session.prompt(promptInput));
    } else if (typeof c.session?.promptAsync === "function") {
      await c.session.promptAsync(promptInput);
    }
  } catch {}
  setTimeout(async () => {
    try {
      const freshMessages = await getSessionMessages(client, sessionId);
      for (let i = freshMessages.length - 1;i >= 0; i--) {
        const msg = freshMessages[i];
        const msgId = msg.info?.id;
        const msgRole = msg.info?.role;
        if (!msgId || msgRole !== "user")
          break;
        const parts = msg.parts ?? [];
        const isEnabled = parts.length > 0 && parts.every((p) => p.ignored === true && p.type === "text" && typeof p.text === "string" && p.text.startsWith(ENABLED_MARKER));
        if (isEnabled) {
          await deleteMessage(serverUrl, sessionId, msgId);
        } else {
          break;
        }
      }
    } catch {}
  }, 1000);
}
async function cleanupEnabledMessages(messages, serverUrl, sessionId) {
  if (!serverUrl)
    return;
  for (let i = messages.length - 1;i >= 0; i--) {
    const msg = messages[i];
    const msgId = msg.info?.id;
    const msgRole = msg.info?.role;
    if (!msgId || msgRole !== "user")
      break;
    const parts = msg.parts ?? [];
    const isEnabled = parts.length > 0 && parts.every((p) => p.ignored === true && p.type === "text" && typeof p.text === "string" && p.text.startsWith(ENABLED_MARKER));
    if (isEnabled) {
      await deleteMessage(serverUrl, sessionId, msgId);
    } else {
      break;
    }
  }
}
async function sendSchemaFenceWarning(client, directory, detail) {
  const { sessionId } = getDesktopState(directory);
  if (!sessionId)
    return;
  if (await waitForSafeNotificationTarget(client, sessionId) === "skip")
    return;
  const text = [
    `${SCHEMA_FENCE_MARKER}`,
    "",
    `The shared Magic Context database was upgraded to schema v${detail.persistedVersion} by a`,
    `newer build (OpenCode and Pi share one database). This build only supports`,
    `up to v${detail.supportedVersion}, so it has fail-closed to avoid corrupting the cache.`,
    "",
    "This usually means a pinned or stale plugin is sharing the database with a",
    "newer instance. Update or unpin Magic Context on this harness (or update",
    "OpenCode/Pi) to the latest version, then restart. The fastest fix is:",
    "",
    "  npx @cortexkit/magic-context@latest doctor --force",
    "",
    "Your data is safe; nothing is disabled permanently."
  ].join(`
`);
  try {
    const c = client;
    const promptInput = {
      path: { id: sessionId },
      body: { noReply: true, parts: [{ type: "text", text, ignored: true }] }
    };
    if (typeof c.session?.prompt === "function") {
      await Promise.resolve(c.session.prompt(promptInput));
    } else if (typeof c.session?.promptAsync === "function") {
      await c.session.promptAsync(promptInput);
    }
  } catch {
    return;
  }
}
async function sendStartupAnnouncement(client, directory, version, features, footer, markSeen) {
  if (!version || features.length === 0)
    return;
  const { sessionId } = getDesktopState(directory);
  if (!sessionId) {
    return;
  }
  const { isTuiConnected } = await import("./rpc-notifications-1ffm755w.js");
  if (isTuiConnected(sessionId) || isTuiConnected())
    return;
  if (await waitForSafeNotificationTarget(client, sessionId) === "skip")
    return;
  const bullets = features.map((line) => `  • ${line}`).join(`
`);
  const sections = [`${ANNOUNCEMENT_MARKER} v${version}:`, "", bullets];
  if (footer && footer.trim().length > 0) {
    sections.push("", footer);
  }
  const text = sections.join(`
`);
  log(`[magic-context] sending startup announcement for v${version} to session ${sessionId}`);
  try {
    const c = client;
    const promptInput = {
      path: { id: sessionId },
      body: {
        noReply: true,
        parts: [{ type: "text", text, ignored: true }]
      }
    };
    if (typeof c.session?.prompt === "function") {
      await Promise.resolve(c.session.prompt(promptInput));
    } else if (typeof c.session?.promptAsync === "function") {
      await c.session.promptAsync(promptInput);
    } else {
      log("[magic-context] announcement: session prompt API unavailable");
      return;
    }
  } catch (error) {
    log(`[magic-context] announcement: failed to send: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  markSeen(version);
}

export { detectConflicts, resolveCompactionForBoot, sendConflictWarning, cleanupConflictWarnings, sendSchemaFenceWarning, sendStartupAnnouncement };
