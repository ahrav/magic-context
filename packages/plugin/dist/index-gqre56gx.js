import {
  piModelRefToCanonical
} from "./index-cgyfn1s2.js";
import {
  closeQuietly,
  getRawSessionMessageCountFromDb,
  openCodeDbExists,
  withReadOnlySessionDb
} from "./index-xatxycav.js";
import {
  log
} from "./index-rjbc1j54.js";
import {
  getHarness
} from "./index-p5d8sma0.js";

// src/features/magic-context/storage-meta-session.ts
import { Buffer as Buffer2 } from "node:buffer";

// src/features/magic-context/compression-depth-storage.ts
var incrementDepthStatements = new WeakMap;
var totalDepthStatements = new WeakMap;
var maxDepthStatements = new WeakMap;
var clearDepthStatements = new WeakMap;
function getClearDepthStatement(db) {
  let stmt = clearDepthStatements.get(db);
  if (!stmt) {
    stmt = db.prepare("DELETE FROM compression_depth WHERE session_id = ?");
    clearDepthStatements.set(db, stmt);
  }
  return stmt;
}
function clearCompressionDepth(db, sessionId) {
  getClearDepthStatement(db).run(sessionId);
}
function clearCompressionDepthRange(db, sessionId, startOrdinal, endOrdinal) {
  if (endOrdinal < startOrdinal) {
    return;
  }
  db.prepare("DELETE FROM compression_depth WHERE session_id = ? AND message_ordinal BETWEEN ? AND ?").run(sessionId, startOrdinal, endOrdinal);
}

// src/features/magic-context/message-index.ts
import { createHash } from "node:crypto";

// src/shared/internal-initiator-marker.ts
var OMO_INTERNAL_INITIATOR_MARKER = "<!-- OMO_INTERNAL_INITIATOR -->";

// src/shared/system-directive.ts
var SYSTEM_DIRECTIVE_PREFIX = "[SYSTEM DIRECTIVE: MAGIC-CONTEXT";
function isSystemDirective(text) {
  return text.trimStart().startsWith(SYSTEM_DIRECTIVE_PREFIX);
}
function removeSystemReminders(text) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
}

// src/shared/commit-detection.ts
var HASH_HEX = "[0-9a-f]{7,12}";
var COMMIT_HASH_TEST_PATTERN = new RegExp(`\\b${HASH_HEX}\\b`, "i");
var COMMIT_VERB_PATTERN = /\b(?:commit(?:ted|ting|s)?|cherry-?pick(?:ed|ing|s)?|merge[ds]?|merging|rebas(?:e|ed|es|ing))\b/i;
function textMentionsRecentCommit(text) {
  return COMMIT_HASH_TEST_PATTERN.test(text) && COMMIT_VERB_PATTERN.test(text);
}
function createCommitHashExtractPattern() {
  return new RegExp(`\`?\\b(${HASH_HEX})\\b\`?`, "gi");
}

// src/shared/token-estimator.ts
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
var TOKENIZER_PACKAGE_DIRS = [
  ["@cortexkit", "opencode-magic-context"],
  ["@cortexkit", "pi-magic-context"]
];
var tokenizer;
var tokenizerLoadAttempted = false;
var tokenizerPreloadAttempted = false;
var tokenizerPoisoned = false;
var tokenizerLoadPromise;
var tokenizerWarningSent = false;
function tokenizerPackageRoots() {
  const cwd = process.cwd();
  const openCodeCache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode");
  const roots = [cwd, openCodeCache];
  const candidates = [];
  for (const root of roots) {
    for (const packageDir of TOKENIZER_PACKAGE_DIRS) {
      candidates.push(join(root, "node_modules", ...packageDir, "node_modules", "ai-tokenizer"));
    }
    candidates.push(join(root, "node_modules", "ai-tokenizer"));
  }
  let ancestor = process.argv[1] ? dirname(resolve(process.argv[1])) : cwd;
  while (true) {
    candidates.push(join(ancestor, "node_modules", "ai-tokenizer"));
    const parent = dirname(ancestor);
    if (parent === ancestor)
      break;
    ancestor = parent;
  }
  return [...new Set(candidates)];
}
function packageImportTarget(value) {
  if (typeof value === "string")
    return value;
  if (!value || typeof value !== "object")
    return;
  const conditions = value;
  return packageImportTarget(conditions.import) ?? packageImportTarget(conditions.default);
}
function findTokenizerImportPaths() {
  for (const packageRoot of tokenizerPackageRoots()) {
    const packageJsonPath = join(packageRoot, "package.json");
    if (!existsSync(packageJsonPath))
      continue;
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      const tokenizerTarget = packageImportTarget(packageJson.exports?.["."]) ?? (typeof packageJson.module === "string" ? packageJson.module : undefined) ?? (typeof packageJson.main === "string" ? packageJson.main : undefined);
      const encodingTarget = packageImportTarget(packageJson.exports?.["./encoding/claude"]);
      if (!tokenizerTarget || !encodingTarget)
        continue;
      return {
        tokenizerPath: realpathSync(join(packageRoot, tokenizerTarget)),
        encodingPath: realpathSync(join(packageRoot, encodingTarget))
      };
    } catch {}
  }
  return;
}
function constructTokenizer(tokenizerModule, claudeEncoding) {
  const typedModule = tokenizerModule;
  const Tokenizer = typedModule.default ?? typedModule.Tokenizer;
  if (!Tokenizer) {
    throw new Error("ai-tokenizer does not expose a Tokenizer constructor");
  }
  return new Tokenizer(claudeEncoding);
}
function loadTokenizer() {
  const requireFromThisModule = createRequire(import.meta.url);
  return constructTokenizer(requireFromThisModule("ai-" + "tokenizer"), requireFromThisModule("ai-tokenizer/encoding/" + "claude"));
}
async function loadTokenizerFromInstalledPackage() {
  const installedPaths = findTokenizerImportPaths();
  if (!installedPaths) {
    throw new Error("ai-tokenizer was not found under the project, runtime, or OpenCode cache node_modules roots");
  }
  const [tokenizerModule, claudeEncoding] = await Promise.all([
    import(pathToFileURL(installedPaths.tokenizerPath).href),
    import(pathToFileURL(installedPaths.encodingPath).href)
  ]);
  return constructTokenizer(tokenizerModule, claudeEncoding);
}
function warnTokenizerFallback(error) {
  if (tokenizerWarningSent)
    return;
  tokenizerWarningSent = true;
  const reason = error instanceof Error ? error.message : String(error);
  console.warn("[magic-context] ai-tokenizer is unavailable; using approximate character-based token counts for this process. Token budgets, persisted per-message counts, and protected-tail/compartment boundaries may be less accurate until restart:", reason);
}
async function preloadTokenizer() {
  if (tokenizer)
    return true;
  if (tokenizerPoisoned || tokenizerPreloadAttempted)
    return false;
  if (tokenizerLoadPromise)
    return tokenizerLoadPromise;
  tokenizerLoadPromise = (async () => {
    try {
      try {
        tokenizer = loadTokenizer();
      } catch {
        tokenizer = await loadTokenizerFromInstalledPackage();
      }
      tokenizerLoadAttempted = true;
      return true;
    } catch (error) {
      tokenizerLoadAttempted = true;
      warnTokenizerFallback(error);
      return false;
    } finally {
      tokenizerPreloadAttempted = true;
      tokenizerLoadPromise = undefined;
    }
  })();
  return tokenizerLoadPromise;
}
function getTokenizer() {
  if (tokenizer || tokenizerLoadAttempted)
    return tokenizer;
  tokenizerLoadAttempted = true;
  try {
    tokenizer = loadTokenizer();
  } catch (error) {
    warnTokenizerFallback(error);
  }
  return tokenizer;
}
function estimateTokensHeuristically(text) {
  return Math.ceil(text.length / 3.5);
}
function estimateTokens(text) {
  if (!text)
    return 0;
  const activeTokenizer = getTokenizer();
  if (!activeTokenizer)
    return estimateTokensHeuristically(text);
  try {
    return activeTokenizer.encode(text, "all").length;
  } catch (error) {
    tokenizer = undefined;
    tokenizerLoadAttempted = true;
    tokenizerPoisoned = true;
    warnTokenizerFallback(error);
    return estimateTokensHeuristically(text);
  }
}

// src/hooks/magic-context/read-session-formatting.ts
var MAX_COMMITS_PER_BLOCK = 5;
function hasMeaningfulUserText(parts) {
  for (const part of parts) {
    if (part === null || typeof part !== "object")
      continue;
    const candidate = part;
    if (candidate.type !== "text" || typeof candidate.text !== "string")
      continue;
    if (candidate.ignored === true)
      continue;
    const cleaned = removeSystemReminders(candidate.text).replace(OMO_INTERNAL_INITIATOR_MARKER, "").trim();
    if (!cleaned)
      continue;
    if (isSystemDirective(cleaned))
      continue;
    return true;
  }
  return false;
}
function extractTexts(parts) {
  const texts = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object")
      continue;
    const p = part;
    if (p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) {
      texts.push(p.text.trim());
    }
  }
  return texts;
}
function extractToolCallSummaries(parts) {
  const summaries = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object")
      continue;
    const p = part;
    if (p.type !== "tool" || typeof p.tool !== "string")
      continue;
    const state = p.state;
    if (!state || typeof state !== "object")
      continue;
    const input = state.input;
    const metadata = state.metadata;
    const description = input && typeof input.description === "string" && input.description || metadata && typeof metadata.description === "string" && metadata.description;
    if (description) {
      summaries.push(`TC: ${description}`);
      continue;
    }
    const toolName = p.tool;
    const keyArg = extractKeyArg(toolName, input);
    summaries.push(keyArg ? `TC: ${toolName}(${keyArg})` : `TC: ${toolName}`);
  }
  return summaries;
}
function extractKeyArg(_toolName, input) {
  if (!input)
    return null;
  if (typeof input.filePath === "string")
    return truncateArg(input.filePath);
  if (typeof input.path === "string")
    return truncateArg(input.path);
  if (typeof input.pattern === "string")
    return truncateArg(input.pattern);
  if (typeof input.query === "string")
    return truncateArg(input.query);
  if (typeof input.symbol === "string")
    return input.symbol;
  if (typeof input.module === "string")
    return input.module;
  if (typeof input.action === "string")
    return input.action;
  return null;
}
function truncateArg(value, maxLen = 60) {
  if (value.length <= maxLen)
    return value;
  return `${value.slice(0, maxLen)}…`;
}
function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}
function compactRole(role) {
  if (role === "assistant")
    return "A";
  if (role === "user")
    return "U";
  return role.slice(0, 1).toUpperCase() || "M";
}
function formatBlock(block) {
  const range = block.startOrdinal === block.endOrdinal ? `[${block.startOrdinal}]` : `[${block.startOrdinal}-${block.endOrdinal}]`;
  const commitSuffix = block.commitHashes.length > 0 ? ` commits: ${block.commitHashes.join(", ")}` : "";
  return `${range} ${block.role}:${commitSuffix} ${block.parts.join(" / ")}`;
}
function extractCommitHashes(text) {
  const hashes = [];
  const seen = new Set;
  for (const match of text.matchAll(createCommitHashExtractPattern())) {
    const hash = match[1]?.toLowerCase();
    if (!hash || seen.has(hash))
      continue;
    seen.add(hash);
    hashes.push(hash);
    if (hashes.length >= MAX_COMMITS_PER_BLOCK)
      break;
  }
  return hashes;
}
function compactTextForSummary(text, role) {
  const commitHashes = role === "assistant" ? extractCommitHashes(text) : [];
  if (commitHashes.length === 0 || !COMMIT_VERB_PATTERN.test(text)) {
    return { text, commitHashes };
  }
  const withoutHashes = text.replace(createCommitHashExtractPattern(), "").replace(/\(\s*\)/g, "").replace(/\s+,/g, ",").replace(/,\s*,+/g, ", ").replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
  return {
    text: withoutHashes.length > 0 ? withoutHashes : text,
    commitHashes
  };
}
function mergeCommitHashes(existing, next) {
  if (next.length === 0)
    return existing;
  const merged = [...existing];
  for (const hash of next) {
    if (merged.includes(hash))
      continue;
    merged.push(hash);
    if (merged.length >= MAX_COMMITS_PER_BLOCK)
      break;
  }
  return merged;
}

// src/hooks/magic-context/read-session-raw.ts
function isRawMessageRow(row) {
  if (row === null || typeof row !== "object")
    return false;
  const candidate = row;
  return typeof candidate.id === "string" && typeof candidate.data === "string";
}
function isRawPartRow(row) {
  if (row === null || typeof row !== "object")
    return false;
  const candidate = row;
  return typeof candidate.message_id === "string" && typeof candidate.data === "string";
}
function parseJsonRecord(value) {
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
function isRawCompactionSummaryInfo(info) {
  if (info === null || typeof info !== "object" || Array.isArray(info))
    return false;
  const candidate = info;
  return candidate.summary === true && candidate.finish === "stop";
}
function parseJsonUnknown(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function attachRawPartVersion(value, timeUpdated) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return value;
  if (typeof timeUpdated !== "number")
    return value;
  try {
    Object.defineProperty(value, "__magicContextPartUpdatedAt", {
      value: timeUpdated,
      enumerable: false,
      configurable: true
    });
  } catch {}
  return value;
}
function readRawSessionMessagesFromDb(db, sessionId) {
  const messageRows = db.prepare("SELECT id, data, time_created, time_updated FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC").all(sessionId).filter(isRawMessageRow);
  const partRows = db.prepare("SELECT message_id, data, time_updated FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC").all(sessionId).filter(isRawPartRow);
  const partsByMessageId = new Map;
  for (const part of partRows) {
    const list = partsByMessageId.get(part.message_id) ?? [];
    list.push(attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated));
    partsByMessageId.set(part.message_id, list);
  }
  const filtered = messageRows.filter((row) => !isRawCompactionSummaryInfo(parseJsonRecord(row.data)));
  return filtered.flatMap((row, index) => {
    const info = parseJsonRecord(row.data);
    if (!info)
      return [];
    const role = typeof info.role === "string" ? info.role : "unknown";
    return {
      ordinal: index + 1,
      id: row.id,
      role,
      parts: partsByMessageId.get(row.id) ?? [],
      createdAt: row.time_created ?? null,
      version: row.time_updated ?? null
    };
  });
}
function readRawSessionMessagePageFromDb(db, sessionId, afterOrdinal, limit, finalWatermark = Number.MAX_SAFE_INTEGER) {
  const remaining = Math.max(0, Math.floor(finalWatermark) - Math.floor(afterOrdinal));
  const pageSize = Math.min(Math.max(1, Math.floor(limit)), remaining);
  if (pageSize === 0)
    return [];
  const messageRows = db.prepare(`SELECT id, data, time_created, time_updated
             FROM message
             WHERE session_id = ?
               AND NOT (
                   CASE WHEN json_valid(data) = 1
                        THEN COALESCE(json_extract(data, '$.summary'), 0)
                        ELSE 0 END = 1
                   AND CASE WHEN json_valid(data) = 1
                            THEN COALESCE(json_extract(data, '$.finish'), '')
                            ELSE '' END = 'stop'
               )
             ORDER BY time_created ASC, id ASC
             LIMIT ? OFFSET ?`).all(sessionId, pageSize, Math.max(0, Math.floor(afterOrdinal))).filter(isRawMessageRow).map((row, index) => ({
    ...row,
    ordinal: Math.floor(afterOrdinal) + index + 1
  }));
  if (messageRows.length === 0)
    return [];
  const placeholders = messageRows.map(() => "?").join(", ");
  const partRows = db.prepare(`SELECT message_id, data, time_updated
             FROM part
             WHERE session_id = ? AND message_id IN (${placeholders})
             ORDER BY time_created ASC, id ASC`).all(sessionId, ...messageRows.map((row) => row.id)).filter(isRawPartRow);
  const partsByMessageId = new Map;
  for (const part of partRows) {
    const list = partsByMessageId.get(part.message_id) ?? [];
    list.push(attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated));
    partsByMessageId.set(part.message_id, list);
  }
  return messageRows.map((row) => {
    const info = parseJsonRecord(row.data);
    return {
      ordinal: row.ordinal,
      id: row.id,
      role: typeof info?.role === "string" ? info.role : "unknown",
      parts: partsByMessageId.get(row.id) ?? [],
      createdAt: row.time_created ?? null,
      version: row.time_updated ?? null
    };
  });
}
function countRawSessionMessageOrdinalsFromDb(db, sessionId) {
  const row = db.prepare(`SELECT COUNT(*) AS count
             FROM message
             WHERE session_id = ?
               AND NOT (
                   CASE WHEN json_valid(data) = 1
                        THEN COALESCE(json_extract(data, '$.summary'), 0)
                        ELSE 0 END = 1
                   AND CASE WHEN json_valid(data) = 1
                            THEN COALESCE(json_extract(data, '$.finish'), '')
                            ELSE '' END = 'stop'
               )`).get(sessionId);
  return typeof row?.count === "number" ? row.count : 0;
}
function readRawSessionMessageOrdinalPageFromDb(db, sessionId, after, limit) {
  const pageSize = Math.max(1, Math.floor(limit));
  const rows = (after ? db.prepare(`SELECT id, data, time_created
                       FROM message
                       WHERE session_id = ?
                         AND (time_created, id) > (?, ?)
                       ORDER BY time_created ASC, id ASC
                       LIMIT ?`).all(sessionId, after.timeCreated, after.id, pageSize) : db.prepare(`SELECT id, data, time_created
                       FROM message
                       WHERE session_id = ?
                       ORDER BY time_created ASC, id ASC
                       LIMIT ?`).all(sessionId, pageSize)).filter(isRawMessageRow);
  return rows.flatMap((row) => {
    if (typeof row.time_created !== "number")
      return [];
    const info = parseJsonRecord(row.data);
    return {
      id: row.id,
      timeCreated: row.time_created,
      contributesOrdinal: !isRawCompactionSummaryInfo(info),
      hasValidInfo: info !== null
    };
  });
}
function countStoredRawSessionMessagesFromDb(db, sessionId) {
  const row = db.prepare("SELECT COUNT(*) AS count FROM message WHERE session_id = ?").get(sessionId);
  return typeof row?.count === "number" ? row.count : 0;
}
function isAnchorRow(row) {
  return row !== null && typeof row === "object" && typeof row.time_created === "number" && typeof row.id === "string";
}
function readRawSessionTailFromDb(db, sessionId, baseOrdinal, anchorMessageId) {
  const anchorRow = db.prepare("SELECT time_created, id, data FROM message WHERE id = ? AND session_id = ?").get(anchorMessageId, sessionId);
  if (!isAnchorRow(anchorRow))
    return null;
  const anchorInfo = parseJsonRecord(anchorRow.data ?? "");
  if (anchorInfo?.summary === true && anchorInfo?.finish === "stop")
    return null;
  const messageRows = db.prepare(`SELECT id, data, time_created, time_updated FROM message
             WHERE session_id = ?
               AND (time_created > ? OR (time_created = ? AND id >= ?))
             ORDER BY time_created ASC, id ASC`).all(sessionId, anchorRow.time_created, anchorRow.time_created, anchorRow.id).filter(isRawMessageRow);
  const filtered = messageRows.filter((row) => {
    const info = parseJsonRecord(row.data);
    return !(info?.summary === true && info?.finish === "stop");
  });
  const ids = filtered.map((row) => row.id);
  const partsByMessageId = new Map;
  if (ids.length > 0) {
    const CHUNK = 800;
    for (let i = 0;i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const placeholders = slice.map(() => "?").join(",");
      const partRows = db.prepare(`SELECT message_id, data, time_updated FROM part WHERE session_id = ? AND message_id IN (${placeholders}) ORDER BY time_created ASC, id ASC`).all(sessionId, ...slice).filter(isRawPartRow);
      for (const part of partRows) {
        const list = partsByMessageId.get(part.message_id) ?? [];
        list.push(attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated));
        partsByMessageId.set(part.message_id, list);
      }
    }
  }
  const messages = [];
  let ord = baseOrdinal;
  for (const row of filtered) {
    const info = parseJsonRecord(row.data);
    if (!info) {
      ord += 1;
      continue;
    }
    messages.push({
      ordinal: ord,
      id: row.id,
      role: typeof info.role === "string" ? info.role : "unknown",
      parts: partsByMessageId.get(row.id) ?? [],
      createdAt: row.time_created ?? null,
      version: row.time_updated ?? null
    });
    ord += 1;
  }
  return { messages, absoluteMessageCount: Math.max(0, ord - 1) };
}
function extractInMemoryMessageViews(messages) {
  return messages.map((m) => {
    const info = m.info ?? {};
    return {
      id: typeof info.id === "string" ? info.id : "",
      role: typeof info.role === "string" ? info.role : "unknown",
      parts: Array.isArray(m.parts) ? m.parts : [],
      summary: info.summary === true ? true : undefined,
      finish: typeof info.finish === "string" ? info.finish : undefined
    };
  });
}
function buildInMemoryTailRawMessages(args) {
  const { messages, lastCompartmentEnd, anchorMessageId } = args;
  const filtered = messages.filter((m) => !(m.summary === true && m.finish === "stop"));
  if (filtered.length === 0)
    return null;
  let startIndex = 0;
  let baseOrdinal;
  let anchorFound = false;
  if (anchorMessageId) {
    const anchorIndex = filtered.findIndex((m) => m.id === anchorMessageId);
    if (anchorIndex >= 0) {
      anchorFound = true;
      startIndex = anchorIndex;
      baseOrdinal = lastCompartmentEnd;
    } else {
      baseOrdinal = Math.max(1, lastCompartmentEnd + 1);
    }
  } else {
    baseOrdinal = Math.max(1, lastCompartmentEnd + 1);
  }
  const out = [];
  let ord = baseOrdinal;
  for (let i = startIndex;i < filtered.length; i += 1) {
    const m = filtered[i];
    if (!m.id || typeof m.id !== "string") {
      ord += 1;
      continue;
    }
    out.push({
      ordinal: ord,
      id: m.id,
      role: typeof m.role === "string" ? m.role : "unknown",
      parts: m.parts ?? [],
      version: null
    });
    ord += 1;
  }
  return { messages: out, absoluteMessageCount: Math.max(0, ord - 1), anchorFound };
}
function readRawSessionMessagePartsByIdFromDb(db, sessionId, messageId) {
  const row = db.prepare("SELECT id, data, time_created, time_updated FROM message WHERE session_id = ? AND id = ?").get(sessionId, messageId);
  if (!row || !isRawMessageRow(row) || typeof row.time_created !== "number")
    return null;
  const info = parseJsonRecord(row.data);
  if (!info || isRawCompactionSummaryInfo(info))
    return null;
  const partRows = db.prepare("SELECT message_id, data, time_updated FROM part WHERE session_id = ? AND message_id = ? ORDER BY time_created ASC, id ASC").all(sessionId, messageId).filter(isRawPartRow);
  return {
    id: row.id,
    role: typeof info.role === "string" ? info.role : "unknown",
    parts: partRows.map((part) => attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated)),
    createdAt: row.time_created,
    version: row.time_updated ?? null
  };
}
function readRawSessionMessageOrdinalByIdFromDb(db, sessionId, messageId) {
  const row = db.prepare(`SELECT COUNT(candidate.id) AS ordinal
             FROM message AS target
             JOIN message AS candidate
               ON candidate.session_id = target.session_id
              AND NOT (
                  CASE WHEN json_valid(candidate.data) = 1
                       THEN COALESCE(json_extract(candidate.data, '$.summary'), 0)
                       ELSE 0 END = 1
                  AND CASE WHEN json_valid(candidate.data) = 1
                           THEN COALESCE(json_extract(candidate.data, '$.finish'), '')
                           ELSE '' END = 'stop'
              )
              AND (candidate.time_created < target.time_created
                   OR (candidate.time_created = target.time_created AND candidate.id <= target.id))
             WHERE target.session_id = ?
               AND target.id = ?
               AND NOT (
                   CASE WHEN json_valid(target.data) = 1
                        THEN COALESCE(json_extract(target.data, '$.summary'), 0)
                        ELSE 0 END = 1
                   AND CASE WHEN json_valid(target.data) = 1
                            THEN COALESCE(json_extract(target.data, '$.finish'), '')
                            ELSE '' END = 'stop'
               )`).get(sessionId, messageId);
  const ordinal = row?.ordinal;
  return typeof ordinal === "number" && ordinal > 0 ? ordinal : null;
}
function readRawSessionMessageByIdFromDb(db, sessionId, messageId) {
  const row = db.prepare("SELECT id, data, time_created, time_updated FROM message WHERE session_id = ? AND id = ?").get(sessionId, messageId);
  if (!row || !isRawMessageRow(row) || typeof row.time_created !== "number") {
    return null;
  }
  const info = parseJsonRecord(row.data);
  if (!info || isRawCompactionSummaryInfo(info)) {
    return null;
  }
  const ordinalRow = db.prepare(`SELECT COUNT(*) AS ordinal FROM message
             WHERE session_id = ?
               AND NOT (COALESCE(json_extract(data, '$.summary'), 0) = 1
                        AND COALESCE(json_extract(data, '$.finish'), '') = 'stop')
               AND (time_created < ? OR (time_created = ? AND id <= ?))`).get(sessionId, row.time_created, row.time_created, messageId);
  const ordinal = typeof ordinalRow?.ordinal === "number" ? ordinalRow.ordinal : 0;
  if (ordinal <= 0) {
    return null;
  }
  const partRows = db.prepare("SELECT message_id, data, time_updated FROM part WHERE session_id = ? AND message_id = ? ORDER BY time_created ASC, id ASC").all(sessionId, messageId).filter(isRawPartRow);
  const role = typeof info.role === "string" ? info.role : "unknown";
  return {
    ordinal,
    id: row.id,
    role,
    parts: partRows.map((part) => attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated)),
    createdAt: row.time_created,
    version: row.time_updated ?? null
  };
}

// src/shared/record-type-guard.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/shared/stable-json.ts
function stableStringify(value, seen = new WeakSet) {
  if (value === undefined)
    return "undefined";
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? String(value);
  if (seen.has(value))
    return '"[Circular]"';
  seen.add(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([a], [b]) => {
    if (a < b)
      return -1;
    if (a > b)
      return 1;
    return 0;
  });
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child, seen)}`).join(",")}}`;
}

// src/hooks/magic-context/read-session-true-raw-tokens.ts
function completedToolArcCrossesBoundary(invOrdinal, resOrdinal, boundary) {
  return invOrdinal < boundary && boundary <= resOrdinal;
}
var MAX_MESSAGE_CACHE_ENTRIES = 1e5;
var MAX_MESSAGE_CACHE_KEY_BYTES = 64 * 1024 * 1024;
var FNV1A_32_OFFSET = 2166136261;
var FNV1A_32_PRIME = 16777619;
var messageEstimateCache = new Map;
var messageEstimateCacheBytes = 0;
var EMPTY_BREAKDOWN = {
  text: 0,
  reasoning: 0,
  toolInput: 0,
  toolOutput: 0,
  image: 0,
  other: 0,
  total: 0
};
function addBreakdown(target, kind, value) {
  if (kind === "total")
    return;
  const safeValue = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  target[kind] += safeValue;
  target.total += safeValue;
}
function estimateStructured(value) {
  if (typeof value === "string")
    return estimateTokens(value);
  if (value === undefined || value === null)
    return 0;
  return estimateTokens(stableStringify(value));
}
function firstStringField(record, fields) {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0)
      return value;
  }
  return null;
}
function stringValue(value) {
  if (typeof value === "string")
    return value;
  if (value === undefined || value === null)
    return "";
  return stableStringify(value);
}
function textFromToolResultContent(content) {
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    const pieces = [];
    for (const entry of content) {
      if (typeof entry === "string") {
        pieces.push(entry);
      } else if (isRecord(entry)) {
        const text = firstStringField(entry, ["text", "content", "value"]);
        pieces.push(text ?? stableStringify(entry));
      } else if (entry !== null && entry !== undefined) {
        pieces.push(String(entry));
      }
    }
    return pieces.join(`
`);
  }
  return stringValue(content);
}
function looksImageLike(part) {
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  const mime = typeof part.mime === "string" ? part.mime.toLowerCase() : "";
  const mediaType = typeof part.mediaType === "string" ? part.mediaType.toLowerCase() : "";
  return type.includes("image") || mime.startsWith("image/") || mediaType.startsWith("image/") || part.image_url !== undefined || part.imageUrl !== undefined || part.image !== undefined;
}
function defaultImageTokenHeuristic(part) {
  if (isRecord(part)) {
    const width = part.width;
    const height = part.height;
    if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
      return Math.max(256, Math.min(4096, Math.ceil(width * height / 750)));
    }
  }
  return 1024;
}
function partType(part) {
  return typeof part.type === "string" ? part.type : "";
}
function hasOwn(record, key) {
  return Object.hasOwn(record, key);
}
function recursiveByteLength(value) {
  if (value === null || value === undefined)
    return 0;
  if (typeof value === "string")
    return value.length;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).length;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + recursiveByteLength(item), value.length);
  }
  if (isRecord(value)) {
    let total = Object.keys(value).length;
    for (const [key, child] of Object.entries(value)) {
      total += key.length + recursiveByteLength(child);
    }
    return total;
  }
  return String(value).length;
}
function updateFnv1a32(hash, text) {
  let next = hash;
  for (let index = 0;index < text.length; index += 1) {
    next ^= text.charCodeAt(index);
    next = Math.imul(next, FNV1A_32_PRIME) >>> 0;
  }
  return next;
}
function contentStringsHash(fields) {
  let hash = FNV1A_32_OFFSET;
  for (const field of fields) {
    hash = updateFnv1a32(hash, `${field.length}:`);
    hash = updateFnv1a32(hash, field);
    hash = updateFnv1a32(hash, "\x00");
  }
  return hash.toString(16).padStart(8, "0");
}
function rawPartVersion(part) {
  return part.__magicContextPartUpdatedAt ?? part.updated_at ?? part.updatedAt ?? part.version ?? part.revision ?? "";
}
function callIdFromPart(part) {
  const direct = firstStringField(part, ["callID", "callId", "toolCallId", "tool_call_id", "id"]);
  if (direct)
    return direct;
  const state = isRecord(part.state) ? part.state : null;
  return state ? firstStringField(state, ["callID", "callId", "toolCallId", "tool_call_id", "id"]) ?? "" : "";
}
function toolSignalFromPart(part) {
  if (!isRecord(part))
    return null;
  const type = partType(part);
  const state = isRecord(part.state) ? part.state : null;
  const callId = callIdFromPart(part);
  if (!callId && type !== "tool")
    return null;
  if (type === "tool") {
    const hasInput = state !== null && hasOwn(state, "input");
    const outputKey = state ? hasOwn(state, "output") ? "output" : hasOwn(state, "error") ? "error" : hasOwn(state, "result") ? "result" : null : null;
    const hasOutput = outputKey !== null;
    const outputValue = outputKey && state ? state[outputKey] : undefined;
    const providerExecuted = part.providerExecuted === true;
    const openInvocation = !providerExecuted && !hasOutput;
    return {
      callId,
      hasInput: hasInput || openInvocation,
      hasOutput,
      inputText: hasInput && state ? stringValue(state.input) : "",
      outputText: hasOutput ? stringValue(outputValue) : ""
    };
  }
  if (type === "tool-invocation") {
    const args = part.args ?? part.input;
    return {
      callId,
      hasInput: args !== undefined,
      hasOutput: false,
      inputText: args !== undefined ? stringValue(args) : "",
      outputText: ""
    };
  }
  if (type === "tool_use") {
    const input = part.input;
    return {
      callId,
      hasInput: input !== undefined,
      hasOutput: false,
      inputText: input !== undefined ? stringValue(input) : "",
      outputText: ""
    };
  }
  if (type === "tool_result") {
    const content = part.content ?? part.output ?? part.result;
    return {
      callId,
      hasInput: false,
      hasOutput: content !== undefined,
      inputText: "",
      outputText: content !== undefined ? textFromToolResultContent(content) : ""
    };
  }
  return null;
}
function partCheapFingerprint(part) {
  if (!isRecord(part))
    return `${typeof part}:${recursiveByteLength(part)}`;
  const version = rawPartVersion(part);
  const type = typeof part.type === "string" ? part.type : "";
  return `${type}:${String(version)}:${recursiveByteLength(part)}`;
}
function messageCacheKey(message, options) {
  const namespace = "cacheNamespace" in options ? options.cacheNamespace : "estimate";
  const cheapFingerprint = message.parts.map(partCheapFingerprint).join("|");
  return [
    namespace,
    options.providerShapeVersion,
    message.id || `ordinal:${message.ordinal}`,
    message.role,
    message.parts.length,
    cheapFingerprint
  ].join("\x00");
}
function setCachedEstimate(key, breakdown) {
  const keyEstimateBytes = key.length * 2 + 64;
  const existing = messageEstimateCache.get(key);
  if (existing)
    messageEstimateCacheBytes -= existing.keyEstimateBytes;
  messageEstimateCache.set(key, { breakdown, keyEstimateBytes });
  messageEstimateCacheBytes += keyEstimateBytes;
  while (messageEstimateCache.size > MAX_MESSAGE_CACHE_ENTRIES || messageEstimateCacheBytes > MAX_MESSAGE_CACHE_KEY_BYTES) {
    const first = messageEstimateCache.keys().next().value;
    if (typeof first !== "string")
      break;
    const removed = messageEstimateCache.get(first);
    if (removed)
      messageEstimateCacheBytes -= removed.keyEstimateBytes;
    messageEstimateCache.delete(first);
  }
}
function cloneBreakdown(value) {
  return { ...value };
}
function estimateNonToolPart(part, options, breakdown) {
  if (!isRecord(part)) {
    if (part !== null && part !== undefined)
      addBreakdown(breakdown, "other", estimateStructured(part));
    return true;
  }
  const type = partType(part);
  if (type === "step-start" || type === "step-finish" || type === "meta" && Object.keys(part).length <= 1) {
    return true;
  }
  if (type === "text") {
    const text = firstStringField(part, ["text", "content"]);
    if (text)
      addBreakdown(breakdown, "text", estimateTokens(text));
    return true;
  }
  if (type === "reasoning" || type === "thinking" || type === "redacted_thinking") {
    const text = firstStringField(part, ["thinking", "text", "content", "reasoning"]);
    if (text) {
      addBreakdown(breakdown, "reasoning", estimateTokens(text));
    } else {
      addBreakdown(breakdown, "other", estimateStructured(part));
    }
    return true;
  }
  const reasoningText = firstStringField(part, ["thinking", "reasoning"]);
  if (reasoningText && type.length === 0) {
    addBreakdown(breakdown, "reasoning", estimateTokens(reasoningText));
    return true;
  }
  if (looksImageLike(part)) {
    addBreakdown(breakdown, "image", options.imageTokenHeuristic?.(part) ?? defaultImageTokenHeuristic(part));
    const altText = firstStringField(part, ["alt", "text", "description"]);
    if (altText)
      addBreakdown(breakdown, "text", estimateTokens(altText));
    return true;
  }
  if (type.includes("file") || type === "source") {
    const content = firstStringField(part, ["content", "text", "source"]);
    if (content)
      addBreakdown(breakdown, "text", estimateTokens(content));
    else
      addBreakdown(breakdown, "other", estimateStructured(part));
    return true;
  }
  return false;
}
function estimateTrueRawMessageTokens(message, options) {
  const breakdown = cloneBreakdown(EMPTY_BREAKDOWN);
  const countedInput = new Set;
  const countedOutput = new Set;
  let ordinalToolIndex = 0;
  for (const part of message.parts) {
    const signal = toolSignalFromPart(part);
    if (signal) {
      const localKey = `${signal.callId || "tool"}:${message.ordinal}:${ordinalToolIndex}`;
      ordinalToolIndex += 1;
      if (signal.hasInput) {
        const key = `${signal.callId}:input:${message.ordinal}`;
        if (!countedInput.has(key)) {
          countedInput.add(key);
          addBreakdown(breakdown, "toolInput", estimateTokens(signal.inputText));
        }
      }
      if (signal.hasOutput) {
        const key = `${signal.callId}:output:${message.ordinal}:${localKey}`;
        if (!countedOutput.has(key)) {
          countedOutput.add(key);
          addBreakdown(breakdown, "toolOutput", estimateTokens(signal.outputText));
        }
      }
      continue;
    }
    if (!estimateNonToolPart(part, options, breakdown)) {
      addBreakdown(breakdown, "other", estimateStructured(part));
    }
  }
  return breakdown;
}
function buildToolArcs(messages) {
  const openQueues = new Map;
  const arcs = [];
  for (const message of messages) {
    for (const part of message.parts) {
      const signal = toolSignalFromPart(part);
      if (!signal || signal.callId.length === 0)
        continue;
      if (signal.hasInput && signal.hasOutput) {
        arcs.push({
          callId: signal.callId,
          invOrdinal: message.ordinal,
          resOrdinal: message.ordinal
        });
        continue;
      }
      if (signal.hasInput) {
        const queue = openQueues.get(signal.callId) ?? [];
        queue.push(message.ordinal);
        openQueues.set(signal.callId, queue);
        continue;
      }
      if (signal.hasOutput) {
        const queue = openQueues.get(signal.callId) ?? [];
        const invOrdinal = queue.shift();
        if (queue.length === 0)
          openQueues.delete(signal.callId);
        else
          openQueues.set(signal.callId, queue);
        if (invOrdinal !== undefined) {
          arcs.push({ callId: signal.callId, invOrdinal, resOrdinal: message.ordinal });
        }
      }
    }
  }
  for (const [callId, queue] of openQueues) {
    for (const invOrdinal of queue) {
      arcs.push({ callId, invOrdinal, resOrdinal: null });
    }
  }
  return arcs.sort((a, b) => a.invOrdinal - b.invOrdinal || (a.resOrdinal ?? Number.MAX_SAFE_INTEGER) - (b.resOrdinal ?? Number.MAX_SAFE_INTEGER));
}
function fenceBoundaryForToolArcs(candidate, arcs, lastCompartmentEndOrdinal, recentOpenArcCutoff) {
  let boundary = candidate;
  for (const arc of arcs) {
    if (arc.resOrdinal !== null) {
      if (completedToolArcCrossesBoundary(arc.invOrdinal, arc.resOrdinal, boundary)) {
        boundary = arc.resOrdinal + 1;
      }
      continue;
    }
    if (arc.invOrdinal < recentOpenArcCutoff)
      continue;
    if (arc.invOrdinal >= lastCompartmentEndOrdinal + 1 && arc.invOrdinal < boundary) {
      return arc.invOrdinal;
    }
    if (arc.invOrdinal >= boundary) {
      return arc.invOrdinal;
    }
  }
  return boundary;
}
function tokenForMessage(message, options) {
  const key = messageCacheKey(message, options);
  const cached = messageEstimateCache.get(key);
  if (cached)
    return cloneBreakdown(cached.breakdown);
  const breakdown = estimateTrueRawMessageTokens(message, options);
  setCachedEstimate(key, breakdown);
  return cloneBreakdown(breakdown);
}
function buildTrueRawTokenIndex(sessionId, messages, options) {
  const ordered = [...messages].sort((a, b) => a.ordinal - b.ordinal);
  const sliceCount = ordered.length;
  const firstOrdinal = ordered.length > 0 ? ordered[0].ordinal : 1;
  const terminalOrdinal = ordered.length > 0 ? ordered[ordered.length - 1].ordinal : 0;
  const rawMessageCount = Math.max(sliceCount, terminalOrdinal, options.absoluteMessageCount ?? sliceCount);
  const ordinalSpan = terminalOrdinal >= firstOrdinal ? terminalOrdinal - firstOrdinal + 1 : 0;
  const tokensByOrdinal = new Map;
  const idsByOrdinal = new Map;
  const prefix = new Array(ordinalSpan + 1).fill(0);
  for (const message of ordered) {
    const stored = options.storedTotalForMessage?.(message);
    const total = stored !== undefined && stored !== null ? stored : tokenForMessage(message, options).total;
    tokensByOrdinal.set(message.ordinal, total);
    idsByOrdinal.set(message.ordinal, message.id);
    const relative = message.ordinal - firstOrdinal + 1;
    if (relative >= 1 && relative <= ordinalSpan) {
      prefix[relative] = total;
    }
  }
  for (let k = 1;k <= ordinalSpan; k += 1) {
    prefix[k] += prefix[k - 1];
  }
  const ordinalToIndex = (ordinal) => Math.max(0, Math.min(ordinalSpan, ordinal - firstOrdinal));
  return {
    sessionId,
    providerShapeVersion: options.providerShapeVersion,
    rawMessageCount,
    tokenForOrdinal(ordinal) {
      return tokensByOrdinal.get(ordinal) ?? 0;
    },
    messageIdAtOrdinal(ordinal) {
      return idsByOrdinal.get(ordinal) ?? null;
    },
    suffixTokensFromOrdinal(ordinal) {
      if (ordinal <= firstOrdinal)
        return prefix[ordinalSpan];
      if (ordinal > terminalOrdinal)
        return 0;
      return prefix[ordinalSpan] - prefix[ordinalToIndex(ordinal)];
    },
    rangeTokens(startInclusive, endExclusive) {
      const start = Math.max(firstOrdinal, startInclusive);
      const end = Math.max(start, Math.min(terminalOrdinal + 1, endExclusive));
      return prefix[end - firstOrdinal] - prefix[start - firstOrdinal];
    },
    findSuffixStartForTokens(tokens) {
      if (!Number.isFinite(tokens) || tokens <= 0)
        return terminalOrdinal + 1;
      const target = Math.max(0, Math.floor(tokens));
      const total = prefix[ordinalSpan];
      if (total < target)
        return firstOrdinal;
      const cut = total - target;
      let lo = 0;
      let hi = ordinalSpan;
      let best = 0;
      while (lo <= hi) {
        const mid = lo + hi >> 1;
        if (prefix[mid] <= cut) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return firstOrdinal + best;
    },
    findHeadEndForCap(startInclusive, endExclusive, capTokens) {
      const start = Math.max(firstOrdinal, Math.min(terminalOrdinal + 1, startInclusive));
      const end = Math.max(start, Math.min(terminalOrdinal + 1, endExclusive));
      if (!Number.isFinite(capTokens) || capTokens <= 0)
        return start;
      const startIndex = start - firstOrdinal;
      const endIndex = end - firstOrdinal;
      const cut = prefix[startIndex] + Math.floor(capTokens);
      let lo = startIndex + 1;
      let hi = endIndex;
      let bestEndIndex = startIndex;
      while (lo <= hi) {
        const mid = lo + hi >> 1;
        if (prefix[mid] <= cut) {
          bestEndIndex = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      let bestEnd = firstOrdinal + bestEndIndex;
      if (bestEnd === start && start < end)
        bestEnd = start + 1;
      return Math.min(bestEnd, end);
    }
  };
}
function partContentFingerprint(part) {
  if (!isRecord(part))
    return `${typeof part}:${recursiveByteLength(part)}`;
  const tool = toolSignalFromPart(part);
  if (tool) {
    return contentStringsHash([tool.inputText, tool.outputText]);
  }
  const text = firstStringField(part, ["text", "thinking", "reasoning", "content", "url"]) ?? "";
  return contentStringsHash([text]);
}
function computeRawRangeFingerprint(messages, startInclusive, endExclusive) {
  const pieces = [];
  for (const message of messages) {
    if (message.ordinal < startInclusive || message.ordinal >= endExclusive)
      continue;
    const partFingerprint = message.parts.map(partContentFingerprint).join(",");
    pieces.push(`${message.ordinal}:${message.id}:${message.parts.length}:${partFingerprint}`);
  }
  return pieces.join("|");
}
function invalidateTrueRawTokenCache(args) {
  const sessionNeedle = args.sessionId ? `${args.sessionId}` : null;
  const messageNeedle = args.messageId ? `\x00${args.messageId}\x00` : null;
  for (const [key, value] of messageEstimateCache) {
    const sessionMatches = sessionNeedle === null || key.includes(sessionNeedle);
    const messageMatches = messageNeedle === null || key.includes(messageNeedle);
    if (sessionMatches && messageMatches) {
      messageEstimateCache.delete(key);
      messageEstimateCacheBytes -= value.keyEstimateBytes;
    }
  }
  args.reason;
}

// src/hooks/magic-context/tag-content-primitives.ts
var encoder = new TextEncoder;
var TAG_PREFIX_REGEX = /^(?:§\d+§\s*)+/;
var MALFORMED_TAG_PREFIX_REGEX = /^(?:§\d+">§(?:\d+§)?\s*)+/;
var DANGLING_TAG_GLOBAL_REGEX = /\u00a7\d+(?!\.\d)[^\s\u00a7\w.]?/g;
var DANGLING_TAG_PREFIX_REGEX = /^(?:\u00a7\d+(?!\.\d)[^\s\u00a7\w.]?\s*)+/;
var COMPLETE_TAG_PAIR_GLOBAL_REGEX = /\u00a7\d+\u00a7/g;
var MALFORMED_TAG_GLOBAL_REGEX = /\u00a7\d+">(?:\u00a7(?:\d+\u00a7)?)?/g;
var STRAY_SECTION_CHAR_REGEX = /\u00a7/g;
function stripWellFormedLeadingTagPrefix(value) {
  return value.replace(/^(\u00a7\d+\u00a7\s*)+/, "");
}
function stripCompleteTagPairsGlobally(value) {
  return value.replace(COMPLETE_TAG_PAIR_GLOBAL_REGEX, "");
}
function stripMalformedTagNotationGlobally(value) {
  return value.replace(MALFORMED_TAG_GLOBAL_REGEX, "");
}
function stripDanglingTagNotationGlobally(value) {
  return value.replace(DANGLING_TAG_GLOBAL_REGEX, "");
}
function stripTagSectionCharacters(value) {
  return value.replace(STRAY_SECTION_CHAR_REGEX, "");
}
function stripPersistedAssistantText(value) {
  let text = stripWellFormedLeadingTagPrefix(value);
  text = stripCompleteTagPairsGlobally(text);
  text = stripMalformedTagNotationGlobally(text);
  text = stripDanglingTagNotationGlobally(text);
  text = stripTagSectionCharacters(text);
  return text.trim();
}
function byteSize(value) {
  return encoder.encode(value).length;
}
function stripTagPrefix(value) {
  let stripped = value;
  for (let pass = 0;pass < 8; pass++) {
    const prev = stripped;
    stripped = stripped.replace(MALFORMED_TAG_PREFIX_REGEX, "");
    stripped = stripped.replace(TAG_PREFIX_REGEX, "");
    stripped = stripped.replace(DANGLING_TAG_PREFIX_REGEX, "");
    if (stripped === prev)
      break;
  }
  return stripped;
}
function peelLeadingMcTagNotation(value) {
  const body = stripTagPrefix(value);
  if (body === value)
    return { tagPrefix: "", body };
  return { tagPrefix: value.slice(0, value.length - body.length), body };
}
function prependTag(tagId, value) {
  const stripped = stripTagPrefix(value);
  return `§${tagId}§ ${stripped}`;
}
function isThinkingPart(part) {
  if (part === null || typeof part !== "object")
    return false;
  const candidate = part;
  return candidate.type === "thinking" || candidate.type === "reasoning";
}

// src/hooks/magic-context/tag-part-guards.ts
function isTextPart(part) {
  if (part === null || typeof part !== "object")
    return false;
  const p = part;
  return p.type === "text" && typeof p.text === "string";
}
function isToolPartWithOutput(part) {
  if (part === null || typeof part !== "object")
    return false;
  const p = part;
  if (p.type !== "tool" || typeof p.callID !== "string")
    return false;
  if (p.state === null || typeof p.state !== "object")
    return false;
  return typeof p.state.output === "string";
}
function isFilePart(part) {
  if (part === null || typeof part !== "object")
    return false;
  const p = part;
  return p.type === "file" && typeof p.url === "string";
}
function buildFileSourceContent(parts) {
  const content = parts.filter(isTextPart).map((part) => stripTagPrefix(part.text)).join(`
`).trim();
  return content.length > 0 ? content : null;
}

// src/hooks/magic-context/edit-marker.ts
var TRUNCATION_SENTINEL = "...[truncated]";
var EDIT_REGION_HINT_LEN = 40;
var PATH_KEYS = new Set(["filePath", "file_path", "path"]);
var DIFF_KEYS = new Set(["oldString", "newString", "content", "old_string", "new_string"]);
function safeSlice(str, maxLen) {
  if (str.length <= maxLen)
    return str;
  const lastCharCode = str.charCodeAt(maxLen - 1);
  if (lastCharCode >= 55296 && lastCharCode <= 56319) {
    return str.slice(0, maxLen - 1);
  }
  return str.slice(0, maxLen);
}
function isEditTool(name) {
  return name === "edit" || name === "write";
}
function applyEditMarkerToInput(input) {
  for (const key of Object.keys(input)) {
    if (PATH_KEYS.has(key))
      continue;
    const value = input[key];
    if (typeof value !== "string" || !DIFF_KEYS.has(key))
      continue;
    if (value.endsWith(TRUNCATION_SENTINEL))
      continue;
    input[key] = value.length > EDIT_REGION_HINT_LEN ? `${safeSlice(value, EDIT_REGION_HINT_LEN)}${TRUNCATION_SENTINEL}` : value;
  }
}

// src/hooks/magic-context/tool-drop-target.ts
var DROP_PREFIX = "[dropped";
var IGNORE_PART_TYPES = new Set([
  "thinking",
  "reasoning",
  "redacted_thinking",
  "meta",
  "step-start",
  "step-finish"
]);
function isToolCallId(value) {
  return typeof value === "string" && value.length > 0;
}
function getToolContent(part) {
  if (!isRecord(part))
    return;
  if (part.type === "tool" && isRecord(part.state)) {
    return typeof part.state.output === "string" ? part.state.output : undefined;
  }
  if (part.type === "tool_result") {
    return typeof part.content === "string" ? part.content : undefined;
  }
  return;
}
function setToolContent(part, content) {
  if (!isRecord(part))
    return;
  if (part.type === "tool" && isRecord(part.state)) {
    part.state.output = content;
    return;
  }
  if (part.type === "tool_result") {
    part.content = content;
  }
}
function clonePart(part) {
  if (part === null || typeof part !== "object")
    return part;
  try {
    return structuredClone(part);
  } catch {
    try {
      return JSON.parse(JSON.stringify(part));
    } catch {
      return part;
    }
  }
}
function clampCloneInPlace(occurrence, clamp) {
  const clone = clonePart(occurrence.part);
  clamp(clone);
  const parts = occurrence.message.parts;
  const index = parts.indexOf(occurrence.part);
  if (index >= 0)
    parts[index] = clone;
}
function truncateToolPart(part, tagId) {
  if (!isRecord(part))
    return;
  const sentinel = `[dropped §${tagId}§]`;
  if (part.type === "tool" && isRecord(part.state)) {
    const state = part.state;
    state.output = sentinel;
    if (isRecord(state.input)) {
      const inputSize = estimateInputSize(state.input);
      if (inputSize > 500) {
        truncateInputValues(state.input);
      }
    }
    return;
  }
  if (part.type === "tool_result") {
    part.content = sentinel;
    return;
  }
  if (part.type === "tool-invocation" && isRecord(part.args)) {
    const inputSize = estimateInputSize(part.args);
    if (inputSize > 500) {
      truncateInputValues(part.args);
    }
    return;
  }
  if (part.type === "tool_use" && isRecord(part.input)) {
    const inputSize = estimateInputSize(part.input);
    if (inputSize > 500) {
      truncateInputValues(part.input);
    }
  }
}
function estimateInputSize(input) {
  try {
    return JSON.stringify(input).length;
  } catch {
    return 0;
  }
}
function editMarkerToolPart(part, tagId) {
  if (!isRecord(part))
    return;
  const sentinel = `[dropped §${tagId}§]`;
  if (part.type === "tool" && isRecord(part.state)) {
    part.state.output = sentinel;
    if (isRecord(part.state.input))
      applyEditMarkerToInput(part.state.input);
    return;
  }
  if (part.type === "tool_result") {
    part.content = sentinel;
    return;
  }
  if (part.type === "tool-invocation" && isRecord(part.args)) {
    applyEditMarkerToInput(part.args);
    return;
  }
  if (part.type === "tool_use" && isRecord(part.input)) {
    applyEditMarkerToInput(part.input);
  }
}
function readToolPartInput(part) {
  if (!isRecord(part))
    return null;
  if (part.type === "tool" && isRecord(part.state) && isRecord(part.state.input)) {
    return part.state.input;
  }
  if (part.type === "tool-invocation" && isRecord(part.args))
    return part.args;
  if (part.type === "tool_use" && isRecord(part.input))
    return part.input;
  return null;
}
var TRUNCATION_SENTINEL2 = "...[truncated]";
function safeSlice2(str, maxLen) {
  if (str.length <= maxLen)
    return str;
  const lastCharCode = str.charCodeAt(maxLen - 1);
  if (lastCharCode >= 55296 && lastCharCode <= 56319) {
    return str.slice(0, maxLen - 1);
  }
  return str.slice(0, maxLen);
}
function truncateInputValues(input) {
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (typeof value === "string") {
      if (value.endsWith(TRUNCATION_SENTINEL2) || value === "[object]" || /^\[\d+ items\]$/.test(value))
        continue;
      input[key] = value.length > 5 ? `${safeSlice2(value, 5)}${TRUNCATION_SENTINEL2}` : value;
    } else if (Array.isArray(value)) {
      input[key] = `[${value.length} items]`;
    } else if (value !== null && typeof value === "object") {
      input[key] = "[object]";
    }
  }
}
function hasMeaningfulPart(part) {
  if (!isRecord(part))
    return false;
  const type = part.type;
  if (type === "text") {
    if (typeof part.text !== "string")
      return false;
    return stripTagPrefix(part.text).trim().length > 0;
  }
  if (typeof type !== "string")
    return false;
  if (IGNORE_PART_TYPES.has(type))
    return false;
  return true;
}
function clearThinkingParts(thinkingParts) {
  for (const part of thinkingParts) {
    if (part.thinking !== undefined)
      part.thinking = "[cleared]";
    if (part.text !== undefined)
      part.text = "[cleared]";
  }
}
function partHasCompletedResult(part) {
  if (!isRecord(part))
    return false;
  if (part.type === "tool") {
    if (!isRecord(part.state))
      return false;
    return typeof part.state.output === "string" || part.state.status === "error";
  }
  return part.type === "tool_result";
}
function extractToolCallObservation(part) {
  if (!isRecord(part))
    return null;
  if (part.type === "tool" && isToolCallId(part.callID)) {
    return { callId: part.callID, kind: "result" };
  }
  if (part.type === "tool-invocation" && isToolCallId(part.callID)) {
    return { callId: part.callID, kind: "invocation" };
  }
  if (part.type === "tool_use" && isToolCallId(part.id)) {
    return { callId: part.id, kind: "invocation" };
  }
  if (part.type === "tool_result" && isToolCallId(part.tool_use_id)) {
    return { callId: part.tool_use_id, kind: "result" };
  }
  return null;
}
function isDropContent(content) {
  return content.startsWith(DROP_PREFIX);
}

class ToolMutationBatch {
  partsToRemove = new Set;
  affectedMessages = new Set;
  messages;
  constructor(messages) {
    this.messages = messages;
  }
  markForRemoval(occurrence) {
    this.partsToRemove.add(occurrence.part);
    this.affectedMessages.add(occurrence.message);
  }
  finalize() {
    if (this.partsToRemove.size === 0)
      return;
    for (const message of this.affectedMessages) {
      message.parts = message.parts.filter((p) => !this.partsToRemove.has(p));
    }
    for (let i = this.messages.length - 1;i >= 0; i -= 1) {
      if (!this.messages[i].parts.some(hasMeaningfulPart)) {
        this.messages.splice(i, 1);
      }
    }
    this.partsToRemove.clear();
    this.affectedMessages.clear();
  }
}
function createToolDropTarget(compositeKey, thinkingParts, index, batch, tagId) {
  const drop = () => {
    const entry = index.get(compositeKey);
    if (!entry || entry.occurrences.length === 0)
      return "absent";
    if (!entry.hasResult)
      return "incomplete";
    for (const occurrence of entry.occurrences) {
      batch.markForRemoval(occurrence);
    }
    clearThinkingParts(thinkingParts);
    index.delete(compositeKey);
    return "removed";
  };
  const truncate = () => {
    const entry = index.get(compositeKey);
    if (!entry || entry.occurrences.length === 0)
      return "absent";
    if (!entry.hasResult)
      return "incomplete";
    for (const occurrence of entry.occurrences) {
      clampCloneInPlace(occurrence, (part) => truncateToolPart(part, tagId));
    }
    clearThinkingParts(thinkingParts);
    return "truncated";
  };
  const editMarker = () => {
    const entry = index.get(compositeKey);
    if (!entry || entry.occurrences.length === 0)
      return "absent";
    if (!entry.hasResult)
      return "incomplete";
    for (const occurrence of entry.occurrences) {
      clampCloneInPlace(occurrence, (part) => editMarkerToolPart(part, tagId));
    }
    clearThinkingParts(thinkingParts);
    return "truncated";
  };
  return {
    setContent: (content) => {
      if (isDropContent(content)) {
        drop();
        return true;
      }
      const entry = index.get(compositeKey);
      if (!entry)
        return false;
      let changed = false;
      for (const occurrence of entry.occurrences) {
        if (occurrence.kind !== "result")
          continue;
        const prevContent = getToolContent(occurrence.part);
        if (prevContent !== content) {
          setToolContent(occurrence.part, content);
          changed = true;
        }
      }
      return changed;
    },
    drop,
    truncate,
    editMarker,
    canDrop: () => {
      const entry = index.get(compositeKey);
      return !!entry && entry.occurrences.length > 0 && entry.hasResult;
    },
    readInput: () => {
      const entry = index.get(compositeKey);
      if (!entry)
        return null;
      for (const occurrence of entry.occurrences) {
        if (occurrence.kind !== "invocation")
          continue;
        const input = readToolPartInput(occurrence.part);
        if (input)
          return input;
      }
      for (const occurrence of entry.occurrences) {
        const input = readToolPartInput(occurrence.part);
        if (input)
          return input;
      }
      return null;
    }
  };
}

// src/hooks/magic-context/read-session-chunk.ts
var BLOCK_TOKEN_MEMO_MAX = 2048;
var blockTokenMemo = new Map;
function estimateBlockTokens(blockText) {
  const cached = blockTokenMemo.get(blockText);
  if (cached !== undefined) {
    blockTokenMemo.delete(blockText);
    blockTokenMemo.set(blockText, cached);
    return cached;
  }
  const count = estimateTokens(blockText);
  if (blockTokenMemo.size >= BLOCK_TOKEN_MEMO_MAX) {
    const oldest = blockTokenMemo.keys().next().value;
    if (oldest !== undefined)
      blockTokenMemo.delete(oldest);
  }
  blockTokenMemo.set(blockText, count);
  return count;
}
var activeRawMessageCache = null;
var activeAbsoluteCountCache = null;
var sessionProviders = new Map;
function setRawMessageProvider(sessionId, provider) {
  sessionProviders.set(sessionId, provider);
  return () => {
    const current = sessionProviders.get(sessionId);
    if (current === provider)
      sessionProviders.delete(sessionId);
  };
}
function cleanUserText(text) {
  return removeSystemReminders(text).replace(OMO_INTERNAL_INITIATOR_MARKER, "").trim();
}
function withRawSessionMessageCache(fn) {
  const outerCache = activeRawMessageCache;
  if (!outerCache) {
    activeRawMessageCache = new Map;
    activeAbsoluteCountCache = new Map;
  }
  try {
    return fn();
  } finally {
    if (!outerCache) {
      activeRawMessageCache = null;
      activeAbsoluteCountCache = null;
    }
  }
}
function readRawSessionMessages(sessionId) {
  if (activeRawMessageCache) {
    const cached = activeRawMessageCache.get(sessionId);
    if (cached) {
      return cached;
    }
    const messages = readRawSessionMessagesFromSource(sessionId);
    activeRawMessageCache.set(sessionId, messages);
    return messages;
  }
  return readRawSessionMessagesFromSource(sessionId);
}
function readRawSessionMessagePage(sessionId, afterOrdinal, limit, finalWatermark) {
  const provider = sessionProviders.get(sessionId);
  if (provider?.readMessagePage) {
    return provider.readMessagePage(afterOrdinal, limit, finalWatermark);
  }
  if (provider) {
    return provider.readMessages().filter((message) => message.ordinal > afterOrdinal && message.ordinal <= finalWatermark).slice(0, limit);
  }
  if (!openCodeDbExists())
    return [];
  return withReadOnlySessionDb((db) => readRawSessionMessagePageFromDb(db, sessionId, afterOrdinal, limit, finalWatermark));
}
function getRawSessionMessageOrdinalCount(sessionId) {
  const provider = sessionProviders.get(sessionId);
  if (provider) {
    if (provider.getMessageCount)
      return provider.getMessageCount();
    return provider.readMessages().length;
  }
  if (!openCodeDbExists())
    return 0;
  return withReadOnlySessionDb((db) => countRawSessionMessageOrdinalsFromDb(db, sessionId));
}
readRawSessionMessages.readPage = readRawSessionMessagePage;
readRawSessionMessages.getCount = getRawSessionMessageOrdinalCount;
function primeTailRawMessageCache(args) {
  const { sessionId, lastCompartmentEnd, anchorMessageId } = args;
  if (!activeRawMessageCache)
    return false;
  if (activeRawMessageCache.has(sessionId))
    return false;
  if (sessionProviders.has(sessionId))
    return false;
  if (!openCodeDbExists())
    return false;
  if (lastCompartmentEnd < 1 || !anchorMessageId)
    return false;
  const result = withReadOnlySessionDb((db) => readRawSessionTailFromDb(db, sessionId, lastCompartmentEnd, anchorMessageId));
  if (!result)
    return false;
  activeRawMessageCache.set(sessionId, result.messages);
  activeAbsoluteCountCache?.set(sessionId, result.absoluteMessageCount);
  return true;
}
function getCachedAbsoluteMessageCount(sessionId) {
  return activeAbsoluteCountCache?.get(sessionId) ?? null;
}
function primeInMemoryTailRawMessageCache(args) {
  const { sessionId, messages, absoluteMessageCount } = args;
  if (!activeRawMessageCache)
    return false;
  if (activeRawMessageCache.has(sessionId))
    return false;
  if (sessionProviders.has(sessionId))
    return false;
  activeRawMessageCache.set(sessionId, messages);
  activeAbsoluteCountCache?.set(sessionId, absoluteMessageCount);
  return true;
}
function readRawSessionMessageOrdinalPage(sessionId, after, limit) {
  const provider = sessionProviders.get(sessionId);
  if (provider?.readMessageOrdinalPage)
    return provider.readMessageOrdinalPage(after, limit);
  if (provider) {
    const rows = provider.readMessages().map((message) => ({
      id: message.id,
      timeCreated: message.createdAt ?? message.ordinal,
      contributesOrdinal: true,
      hasValidInfo: true
    })).filter((row) => !after || row.timeCreated > after.timeCreated || row.timeCreated === after.timeCreated && row.id > after.id).sort((left, right) => left.timeCreated - right.timeCreated || left.id.localeCompare(right.id));
    return rows.slice(0, Math.max(1, Math.floor(limit)));
  }
  if (!openCodeDbExists())
    return [];
  return withReadOnlySessionDb((db) => readRawSessionMessageOrdinalPageFromDb(db, sessionId, after, limit));
}
function getRawSessionStoredMessageCount(sessionId) {
  const provider = sessionProviders.get(sessionId);
  if (provider?.getStoredMessageCount)
    return provider.getStoredMessageCount();
  if (provider)
    return provider.readMessages().length;
  if (!openCodeDbExists())
    return 0;
  return withReadOnlySessionDb((db) => countStoredRawSessionMessagesFromDb(db, sessionId));
}
function readRawSessionMessagePartsById(sessionId, messageId) {
  const provider = sessionProviders.get(sessionId);
  if (provider?.readMessagePartsById)
    return provider.readMessagePartsById(messageId);
  if (provider?.readMessageById)
    return provider.readMessageById(messageId);
  if (provider) {
    return provider.readMessages().find((message) => message.id === messageId) ?? null;
  }
  if (!openCodeDbExists())
    return null;
  return withReadOnlySessionDb((db) => readRawSessionMessagePartsByIdFromDb(db, sessionId, messageId));
}
function readRawSessionMessageOrdinalById(sessionId, messageId) {
  const provider = sessionProviders.get(sessionId);
  if (provider?.readMessageOrdinalById) {
    return provider.readMessageOrdinalById(messageId);
  }
  if (provider?.readMessageIdOrdinals) {
    return provider.readMessageIdOrdinals().get(messageId) ?? null;
  }
  if (provider?.readMessageOrdinalPage) {
    let after = null;
    let ordinal = 0;
    while (true) {
      const page = provider.readMessageOrdinalPage(after, 500);
      if (page.length === 0)
        return null;
      for (const entry of page) {
        if (entry.contributesOrdinal)
          ordinal += 1;
        if (entry.id === messageId)
          return entry.contributesOrdinal ? ordinal : null;
      }
      const last = page.at(-1);
      if (!last || page.length < 500)
        return null;
      after = { timeCreated: last.timeCreated, id: last.id };
    }
  }
  if (provider?.readMessageById) {
    return provider.readMessageById(messageId)?.ordinal ?? null;
  }
  if (provider) {
    return provider.readMessages().find((message) => message.id === messageId)?.ordinal ?? null;
  }
  if (!openCodeDbExists())
    return null;
  return withReadOnlySessionDb((db) => readRawSessionMessageOrdinalByIdFromDb(db, sessionId, messageId));
}
function readRawSessionMessageById(sessionId, messageId) {
  const provider = sessionProviders.get(sessionId);
  if (provider?.readMessageById) {
    return provider.readMessageById(messageId);
  }
  if (provider) {
    return provider.readMessages().find((message) => message.id === messageId) ?? null;
  }
  if (!openCodeDbExists())
    return null;
  return withReadOnlySessionDb((db) => readRawSessionMessageByIdFromDb(db, sessionId, messageId));
}
function readRawSessionMessagesFromSource(sessionId) {
  const provider = sessionProviders.get(sessionId);
  if (provider)
    return provider.readMessages();
  if (!openCodeDbExists())
    return [];
  return withReadOnlySessionDb((db) => readRawSessionMessagesFromDb(db, sessionId));
}
function getRawSessionMessageCount(sessionId) {
  const provider = sessionProviders.get(sessionId);
  if (provider) {
    if (provider.getMessageCount)
      return provider.getMessageCount();
    return provider.readMessages().length;
  }
  if (!openCodeDbExists())
    return 0;
  return withReadOnlySessionDb((db) => getRawSessionMessageCountFromDb(db, sessionId));
}
function getRawSessionTagKeysThrough(sessionId, upToMessageIndex) {
  const messages = readRawSessionMessages(sessionId);
  const messageFileKeys = new Set;
  const toolObservations = new Map;
  const unpairedInvocations = new Map;
  for (const message of messages) {
    if (message.ordinal > upToMessageIndex)
      break;
    for (const [partIndex, part] of message.parts.entries()) {
      if (isTextPart(part)) {
        messageFileKeys.add(`${message.id}:p${partIndex}`);
        continue;
      }
      if (isFilePart(part)) {
        messageFileKeys.add(`${message.id}:file${partIndex}`);
        continue;
      }
      const obs = extractToolCallObservation(part);
      if (!obs)
        continue;
      let ownerMsgId;
      if (obs.kind === "invocation") {
        ownerMsgId = message.id;
        const queue = unpairedInvocations.get(obs.callId) ?? [];
        queue.push(message.id);
        unpairedInvocations.set(obs.callId, queue);
      } else {
        const queue = unpairedInvocations.get(obs.callId);
        if (queue && queue.length > 0) {
          const popped = queue.shift();
          if (queue.length === 0)
            unpairedInvocations.delete(obs.callId);
          ownerMsgId = popped ?? message.id;
        } else {
          ownerMsgId = message.id;
        }
      }
      const owners = toolObservations.get(obs.callId) ?? new Set;
      owners.add(ownerMsgId);
      toolObservations.set(obs.callId, owners);
    }
  }
  return { messageFileKeys, toolObservations };
}
var PROTECTED_TAIL_USER_TURNS = 5;
function getLegacyProtectedTailStartOrdinal(sessionId) {
  const messages = readRawSessionMessages(sessionId);
  const userOrdinals = messages.filter((m) => m.role === "user" && hasMeaningfulUserText(m.parts)).map((m) => m.ordinal);
  if (userOrdinals.length < PROTECTED_TAIL_USER_TURNS) {
    return 1;
  }
  return userOrdinals[userOrdinals.length - PROTECTED_TAIL_USER_TURNS];
}
function readSessionChunk(sessionId, tokenBudget, offset = 1, eligibleEndOrdinal) {
  const messages = readRawSessionMessages(sessionId);
  const totalMessageCount = getCachedAbsoluteMessageCount(sessionId) ?? messages.length;
  const startOrdinal = Math.max(1, offset);
  const lines = [];
  const lineMeta = [];
  const flushedToolOnlyBlocks = [];
  let totalTokens = 0;
  let messagesProcessed = 0;
  let lastOrdinal = startOrdinal - 1;
  let highestScannedOrdinal = startOrdinal - 1;
  let lastMessageId = "";
  let firstMessageId = "";
  let currentBlock = null;
  let pendingNoiseMeta = [];
  let commitClusters = 0;
  let lastFlushedRole = "";
  function recordFilteredNoise(meta) {
    pendingNoiseMeta.push(meta);
    if (!currentBlock) {
      highestScannedOrdinal = Math.max(highestScannedOrdinal, meta.ordinal);
    }
  }
  function flushCurrentBlock() {
    if (!currentBlock)
      return true;
    const blockText = formatBlock(currentBlock);
    const blockTokens = estimateBlockTokens(blockText);
    if (totalTokens + blockTokens > tokenBudget && totalTokens > 0) {
      return false;
    }
    if (currentBlock.role === "A" && currentBlock.commitHashes.length > 0 && lastFlushedRole !== "A") {
      commitClusters++;
    }
    lastFlushedRole = currentBlock.role;
    if (!firstMessageId)
      firstMessageId = currentBlock.meta[0]?.messageId ?? "";
    lastOrdinal = currentBlock.meta[currentBlock.meta.length - 1]?.ordinal ?? currentBlock.endOrdinal;
    highestScannedOrdinal = Math.max(highestScannedOrdinal, lastOrdinal);
    lastMessageId = currentBlock.meta[currentBlock.meta.length - 1]?.messageId ?? "";
    messagesProcessed += currentBlock.meta.length;
    lines.push(blockText);
    lineMeta.push(...currentBlock.meta);
    totalTokens += blockTokens;
    if (currentBlock.isToolOnly) {
      flushedToolOnlyBlocks.push({
        start: currentBlock.startOrdinal,
        end: currentBlock.endOrdinal
      });
    }
    currentBlock = null;
    return true;
  }
  for (const msg of messages) {
    if (eligibleEndOrdinal !== undefined && msg.ordinal >= eligibleEndOrdinal)
      break;
    if (msg.ordinal < startOrdinal)
      continue;
    const meta = { ordinal: msg.ordinal, messageId: msg.id };
    if (msg.role === "user" && !hasMeaningfulUserText(msg.parts)) {
      const tcSummaries = extractToolCallSummaries(msg.parts);
      if (tcSummaries.length === 0) {
        recordFilteredNoise(meta);
        continue;
      }
      const tcText = tcSummaries.join(" / ");
      if (currentBlock && currentBlock.role === "A") {
        currentBlock.endOrdinal = msg.ordinal;
        currentBlock.parts.push(tcText);
        currentBlock.meta.push(...pendingNoiseMeta, meta);
        pendingNoiseMeta = [];
      } else {
        if (!flushCurrentBlock())
          break;
        currentBlock = {
          role: "A",
          startOrdinal: pendingNoiseMeta[0]?.ordinal ?? msg.ordinal,
          endOrdinal: msg.ordinal,
          parts: [tcText],
          meta: [...pendingNoiseMeta, meta],
          commitHashes: [],
          isToolOnly: true
        };
        pendingNoiseMeta = [];
      }
      continue;
    }
    const role = compactRole(msg.role);
    const textParts = extractTexts(msg.parts).map((t) => msg.role === "user" ? cleanUserText(t) : t).map(normalizeText).filter((value) => value.length > 0);
    const toolSummaries = textParts.length === 0 ? extractToolCallSummaries(msg.parts) : [];
    const allParts = [...textParts, ...toolSummaries];
    const compacted = compactTextForSummary(allParts.join(" / "), msg.role);
    const text = compacted.text;
    if (!text) {
      recordFilteredNoise(meta);
      continue;
    }
    const msgHasNarrative = textParts.length > 0;
    if (currentBlock && currentBlock.role === role) {
      currentBlock.endOrdinal = msg.ordinal;
      currentBlock.parts.push(text);
      currentBlock.meta.push(...pendingNoiseMeta, meta);
      currentBlock.commitHashes = mergeCommitHashes(currentBlock.commitHashes, compacted.commitHashes);
      if (msgHasNarrative)
        currentBlock.isToolOnly = false;
      pendingNoiseMeta = [];
      continue;
    }
    if (!flushCurrentBlock())
      break;
    currentBlock = {
      role,
      startOrdinal: pendingNoiseMeta[0]?.ordinal ?? msg.ordinal,
      endOrdinal: msg.ordinal,
      parts: [text],
      meta: [...pendingNoiseMeta, meta],
      commitHashes: [...compacted.commitHashes],
      isToolOnly: !msgHasNarrative
    };
    pendingNoiseMeta = [];
  }
  if (flushCurrentBlock() && pendingNoiseMeta.length > 0) {
    highestScannedOrdinal = Math.max(highestScannedOrdinal, pendingNoiseMeta[pendingNoiseMeta.length - 1]?.ordinal ?? highestScannedOrdinal);
  }
  const toolOnlyRanges = [];
  for (const range of flushedToolOnlyBlocks) {
    const last = toolOnlyRanges[toolOnlyRanges.length - 1];
    if (last && range.start === last.end + 1) {
      last.end = range.end;
    } else {
      toolOnlyRanges.push({ start: range.start, end: range.end });
    }
  }
  const completedToolArcs = buildToolArcs(messages).flatMap((arc) => arc.resOrdinal === null ? [] : [{ start: arc.invOrdinal, end: arc.resOrdinal }]);
  return {
    startIndex: startOrdinal,
    endIndex: lastOrdinal,
    startMessageId: firstMessageId,
    endMessageId: lastMessageId,
    messageCount: messagesProcessed,
    tokenEstimate: totalTokens,
    hasMore: Math.max(lastOrdinal, highestScannedOrdinal) < (eligibleEndOrdinal !== undefined ? Math.min(eligibleEndOrdinal - 1, totalMessageCount) : totalMessageCount),
    text: lines.join(`
`),
    lines: lineMeta,
    commitClusterCount: commitClusters,
    toolOnlyRanges,
    completedToolArcs
  };
}

// src/features/magic-context/message-index.ts
var MESSAGE_HISTORY_ORPHAN_SWEEP_BATCH_SIZE = 200;
var MESSAGE_HISTORY_ORPHAN_SAFETY_AGE_MS = 24 * 60 * 60 * 1000;
var MESSAGE_HISTORY_ORPHAN_SWEEP_COOLDOWN_MS = 10 * 60 * 1000;
var MESSAGE_HISTORY_ORPHAN_UNAVAILABLE_REPROBE_MS = 24 * 60 * 60 * 1000;
var lastIndexedStatements = new WeakMap;
var insertMessageStatements = new WeakMap;
var upsertProgressStatements = new WeakMap;
var upsertDirtyFloorStatements = new WeakMap;
var deleteFtsStatements = new WeakMap;
var deleteFtsRangeStatements = new WeakMap;
var deleteIndexStatements = new WeakMap;
var countIndexedMessageStatements = new WeakMap;
var getMessageSourceStatements = new WeakMap;
var upsertMessageSourceStatements = new WeakMap;
var deleteMessageSourceStatements = new WeakMap;
var deleteMessageSourceRangeStatements = new WeakMap;
var deleteMessageFtsStatements = new WeakMap;
function normalizeIndexText(text) {
  return text.replace(/\s+/g, " ").trim();
}
function getLastIndexedStatement(db) {
  let stmt = lastIndexedStatements.get(db);
  if (!stmt) {
    stmt = db.prepare("SELECT last_indexed_ordinal, dirty_floor_ordinal FROM message_history_index WHERE session_id = ?");
    lastIndexedStatements.set(db, stmt);
  }
  return stmt;
}
function getInsertMessageStatement(db) {
  let stmt = insertMessageStatements.get(db);
  if (!stmt) {
    stmt = db.prepare("INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)");
    insertMessageStatements.set(db, stmt);
  }
  return stmt;
}
function getUpsertProgressStatement(db) {
  let stmt = upsertProgressStatements.get(db);
  if (!stmt) {
    stmt = db.prepare("INSERT INTO message_history_index (session_id, last_indexed_ordinal, dirty_floor_ordinal, updated_at, harness) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET last_indexed_ordinal = excluded.last_indexed_ordinal, dirty_floor_ordinal = excluded.dirty_floor_ordinal, updated_at = excluded.updated_at");
    upsertProgressStatements.set(db, stmt);
  }
  return stmt;
}
function getUpsertDirtyFloorStatement(db) {
  let stmt = upsertDirtyFloorStatements.get(db);
  if (!stmt) {
    stmt = db.prepare("INSERT INTO message_history_index (session_id, last_indexed_ordinal, dirty_floor_ordinal, updated_at, harness) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET last_indexed_ordinal = MAX(message_history_index.last_indexed_ordinal, excluded.last_indexed_ordinal), dirty_floor_ordinal = CASE WHEN message_history_index.dirty_floor_ordinal <= 0 THEN excluded.dirty_floor_ordinal WHEN excluded.dirty_floor_ordinal <= 0 THEN message_history_index.dirty_floor_ordinal ELSE MIN(message_history_index.dirty_floor_ordinal, excluded.dirty_floor_ordinal) END, updated_at = excluded.updated_at");
    upsertDirtyFloorStatements.set(db, stmt);
  }
  return stmt;
}
function getDeleteFtsStatement(db) {
  let stmt = deleteFtsStatements.get(db);
  if (!stmt) {
    stmt = db.prepare("DELETE FROM message_history_fts WHERE session_id = ?");
    deleteFtsStatements.set(db, stmt);
  }
  return stmt;
}
function getDeleteFtsRangeStatement(db) {
  let stmt = deleteFtsRangeStatements.get(db);
  if (!stmt) {
    stmt = db.prepare("DELETE FROM message_history_fts WHERE session_id = ? AND CAST(message_ordinal AS INTEGER) BETWEEN ? AND ?");
    deleteFtsRangeStatements.set(db, stmt);
  }
  return stmt;
}
function getDeleteIndexStatement(db) {
  let stmt = deleteIndexStatements.get(db);
  if (!stmt) {
    stmt = db.prepare("DELETE FROM message_history_index WHERE session_id = ?");
    deleteIndexStatements.set(db, stmt);
  }
  return stmt;
}
function getCountIndexedMessageStatement(db) {
  let stmt = countIndexedMessageStatements.get(db);
  if (!stmt) {
    stmt = db.prepare("SELECT COUNT(*) AS count FROM message_history_fts WHERE session_id = ? AND message_id = ?");
    countIndexedMessageStatements.set(db, stmt);
  }
  return stmt;
}
function getMessageSourceStatement(db) {
  let stmt = getMessageSourceStatements.get(db);
  if (!stmt) {
    stmt = db.prepare("SELECT message_ordinal, source_version, normalized_content_hash, role FROM message_history_source WHERE session_id = ? AND message_id = ?");
    getMessageSourceStatements.set(db, stmt);
  }
  return stmt;
}
function getUpsertMessageSourceStatement(db) {
  let stmt = upsertMessageSourceStatements.get(db);
  if (!stmt) {
    stmt = db.prepare(`INSERT INTO message_history_source (
                 session_id, message_id, message_ordinal, source_version,
                 normalized_content_hash, role, harness, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id, message_id) DO UPDATE SET
                 message_ordinal = excluded.message_ordinal,
                 source_version = excluded.source_version,
                 normalized_content_hash = excluded.normalized_content_hash,
                 role = excluded.role,
                 harness = excluded.harness,
                 updated_at = excluded.updated_at`);
    upsertMessageSourceStatements.set(db, stmt);
  }
  return stmt;
}
function getDeleteMessageSourceStatement(db) {
  let stmt = deleteMessageSourceStatements.get(db);
  if (!stmt) {
    stmt = db.prepare("DELETE FROM message_history_source WHERE session_id = ?");
    deleteMessageSourceStatements.set(db, stmt);
  }
  return stmt;
}
function getDeleteMessageSourceRangeStatement(db) {
  let stmt = deleteMessageSourceRangeStatements.get(db);
  if (!stmt) {
    stmt = db.prepare("DELETE FROM message_history_source WHERE session_id = ? AND message_ordinal BETWEEN ? AND ?");
    deleteMessageSourceRangeStatements.set(db, stmt);
  }
  return stmt;
}
function getDeleteMessageFtsStatement(db) {
  let stmt = deleteMessageFtsStatements.get(db);
  if (!stmt) {
    stmt = db.prepare("DELETE FROM message_history_fts WHERE session_id = ? AND message_id = ?");
    deleteMessageFtsStatements.set(db, stmt);
  }
  return stmt;
}
function normalizeSourceVersion(version) {
  if (typeof version === "number")
    return `number:${version}`;
  if (typeof version === "string")
    return `string:${version}`;
  return "null";
}
function getMessageSourceSnapshot(message) {
  const content = getIndexableContent(message.role, message.parts);
  return {
    ordinal: message.ordinal,
    sourceVersion: normalizeSourceVersion(message.version),
    contentHash: createHash("sha256").update(content).digest("hex"),
    role: message.role,
    content
  };
}
function getMessageIndexSourceIdentity(message) {
  const source = getMessageSourceSnapshot(message);
  return JSON.stringify([source.ordinal, source.sourceVersion, source.contentHash, source.role]);
}
function isMessageIndexSourceCurrent(db, sessionId, message) {
  const source = getMessageSourceSnapshot(message);
  const row = getMessageSourceStatement(db).get(sessionId, message.id);
  return row?.message_ordinal === source.ordinal && row.source_version === source.sourceVersion && row.normalized_content_hash === source.contentHash && row.role === source.role;
}
function setMessageSource(db, sessionId, message, now) {
  const source = getMessageSourceSnapshot(message);
  getUpsertMessageSourceStatement(db).run(sessionId, message.id, source.ordinal, source.sourceVersion, source.contentHash, source.role, getHarness(), now);
  return source.content;
}
function getLastIndexedOrdinal(db, sessionId) {
  const row = getLastIndexedStatement(db).get(sessionId);
  return typeof row?.last_indexed_ordinal === "number" ? row.last_indexed_ordinal : 0;
}
function getIndexedMessageCorpusSize(db, sessionId, maxOrdinal) {
  const watermark = getLastIndexedOrdinal(db, sessionId);
  return maxOrdinal === null ? watermark : Math.min(watermark, Math.max(0, maxOrdinal));
}
function getDirtyIndexFloor(db, sessionId) {
  const row = getLastIndexedStatement(db).get(sessionId);
  return typeof row?.dirty_floor_ordinal === "number" && row.dirty_floor_ordinal > 0 ? row.dirty_floor_ordinal : null;
}
function markMessageIndexDirty(db, sessionId, floorOrdinal) {
  const dirtyFloor = Math.max(1, Math.floor(floorOrdinal));
  getUpsertDirtyFloorStatement(db).run(sessionId, getLastIndexedOrdinal(db, sessionId), dirtyFloor, Date.now(), getHarness());
}
function isMessageAlreadyIndexed(db, sessionId, messageId) {
  const row = getCountIndexedMessageStatement(db).get(sessionId, messageId);
  return (typeof row?.count === "number" ? row.count : 0) > 0;
}
function setIndexProgress(db, sessionId, watermark, dirtyFloor, now) {
  getUpsertProgressStatement(db).run(sessionId, Math.max(0, Math.floor(watermark)), dirtyFloor ?? 0, now, getHarness());
}
function getMessageIndexReconciliationStartOrdinal(db, sessionId) {
  const watermark = getLastIndexedOrdinal(db, sessionId);
  const dirtyFloor = getDirtyIndexFloor(db, sessionId);
  return dirtyFloor === null ? watermark : Math.min(watermark, dirtyFloor - 1);
}
function isMessageIndexReconciledThrough(db, sessionId, finalWatermark) {
  const dirtyFloor = getDirtyIndexFloor(db, sessionId);
  return getLastIndexedOrdinal(db, sessionId) >= finalWatermark && dirtyFloor === null;
}
function deleteIndexedMessage(db, sessionId, messageId) {
  const row = getCountIndexedMessageStatement(db).get(sessionId, messageId);
  const count = typeof row?.count === "number" ? row.count : 0;
  clearIndexedMessages(db, sessionId);
  return count;
}
function clearIndexedMessages(db, sessionId) {
  db.transaction(() => {
    getDeleteFtsStatement(db).run(sessionId);
    getDeleteMessageSourceStatement(db).run(sessionId);
    getDeleteIndexStatement(db).run(sessionId);
    clearCompressionDepth(db, sessionId);
  })();
}
function getIndexableContent(role, parts) {
  if (role === "user") {
    if (!hasMeaningfulUserText(parts)) {
      return "";
    }
    return extractTexts(parts).map(cleanUserText).map(normalizeIndexText).filter((text) => text.length > 0).join(" / ");
  }
  if (role === "assistant") {
    return extractTexts(parts).map(removeSystemReminders).map(normalizeIndexText).filter((text) => text.length > 0).join(" / ");
  }
  return "";
}
function indexSingleMessageInTransaction(db, sessionId, message, now, dirtyFloorBeforeAttempt) {
  const currentWatermark = getLastIndexedOrdinal(db, sessionId);
  const dirtyFloor = getDirtyIndexFloor(db, sessionId);
  if (message.ordinal <= currentWatermark) {
    if (isMessageIndexSourceCurrent(db, sessionId, message)) {
      return false;
    }
    getDeleteMessageFtsStatement(db).run(sessionId, message.id);
    const content2 = setMessageSource(db, sessionId, message, now);
    if (content2.length > 0 && (message.role === "user" || message.role === "assistant")) {
      getInsertMessageStatement(db).run(sessionId, message.ordinal, message.id, message.role, content2);
    }
    setIndexProgress(db, sessionId, currentWatermark, dirtyFloorBeforeAttempt === message.ordinal ? null : dirtyFloorBeforeAttempt, now);
    return true;
  }
  if (message.ordinal !== currentWatermark + 1 || dirtyFloor !== null && dirtyFloor !== message.ordinal) {
    return false;
  }
  const content = setMessageSource(db, sessionId, message, now);
  let inserted = false;
  if (content.length > 0 && (message.role === "user" || message.role === "assistant") && !isMessageAlreadyIndexed(db, sessionId, message.id)) {
    getInsertMessageStatement(db).run(sessionId, message.ordinal, message.id, message.role, content);
    inserted = true;
  }
  setIndexProgress(db, sessionId, message.ordinal, dirtyFloorBeforeAttempt === message.ordinal ? null : dirtyFloorBeforeAttempt, now);
  return inserted;
}
function indexSingleMessage(db, sessionId, message) {
  const currentWatermark = getLastIndexedOrdinal(db, sessionId);
  if (message.ordinal <= currentWatermark && isMessageIndexSourceCurrent(db, sessionId, message)) {
    return false;
  }
  const dirtyFloorBeforeAttempt = getDirtyIndexFloor(db, sessionId);
  markMessageIndexDirty(db, sessionId, Math.min(message.ordinal, currentWatermark + 1));
  db.exec("BEGIN IMMEDIATE");
  let committed = false;
  try {
    const result = indexSingleMessageInTransaction(db, sessionId, message, Date.now(), dirtyFloorBeforeAttempt);
    db.exec("COMMIT");
    committed = true;
    return result;
  } finally {
    if (!committed) {
      try {
        db.exec("ROLLBACK");
      } catch {}
    }
  }
}
function indexMessagesAfterOrdinal(db, sessionId, messages, _lastIndexedOrdinal, finalWatermark = messages.length) {
  const now = Date.now();
  let inserted = 0;
  db.exec("BEGIN IMMEDIATE");
  let committed = false;
  try {
    const currentWatermark = getLastIndexedOrdinal(db, sessionId);
    const dirtyFloor = getDirtyIndexFloor(db, sessionId);
    const effectiveWatermark = dirtyFloor === null ? currentWatermark : Math.min(currentWatermark, Math.max(0, dirtyFloor - 1));
    if (dirtyFloor !== null && dirtyFloor <= finalWatermark) {
      getDeleteFtsRangeStatement(db).run(sessionId, dirtyFloor, finalWatermark);
      getDeleteMessageSourceRangeStatement(db).run(sessionId, dirtyFloor, finalWatermark);
    }
    const messagesByOrdinal = new Map;
    for (const message of messages) {
      if (message.ordinal > effectiveWatermark && message.ordinal <= finalWatermark) {
        messagesByOrdinal.set(message.ordinal, message);
      }
    }
    let coveredWatermark = effectiveWatermark;
    while (coveredWatermark < finalWatermark && messagesByOrdinal.has(coveredWatermark + 1)) {
      coveredWatermark += 1;
    }
    for (let ordinal = effectiveWatermark + 1;ordinal <= coveredWatermark; ordinal++) {
      const message = messagesByOrdinal.get(ordinal);
      if (!message)
        continue;
      const content = setMessageSource(db, sessionId, message, now);
      if (content.length === 0 || message.role !== "user" && message.role !== "assistant" || isMessageAlreadyIndexed(db, sessionId, message.id)) {
        continue;
      }
      getInsertMessageStatement(db).run(sessionId, message.ordinal, message.id, message.role, content);
      inserted += 1;
    }
    const missingFloor = coveredWatermark < finalWatermark ? coveredWatermark + 1 : null;
    const preservedFloor = dirtyFloor !== null && dirtyFloor > finalWatermark ? dirtyFloor : null;
    const nextDirtyFloor = missingFloor === null ? preservedFloor : preservedFloor === null ? missingFloor : Math.min(missingFloor, preservedFloor);
    setIndexProgress(db, sessionId, coveredWatermark, nextDirtyFloor, now);
    db.exec("COMMIT");
    committed = true;
  } finally {
    if (!committed) {
      try {
        db.exec("ROLLBACK");
      } catch {}
    }
  }
  return inserted;
}
function getMessageHistoryOrphanSweepState(db) {
  return db.prepare("SELECT cursor_session_id, last_swept_at FROM message_history_orphan_sweep WHERE harness = 'opencode'").get() ?? {};
}
function persistMessageHistoryOrphanSweepState(db, cursor, lastSweptAt) {
  db.prepare(`INSERT INTO message_history_orphan_sweep (harness, cursor_session_id, last_swept_at)
         VALUES ('opencode', ?, ?)
         ON CONFLICT(harness) DO UPDATE SET
             cursor_session_id = excluded.cursor_session_id,
             last_swept_at = excluded.last_swept_at`).run(cursor, lastSweptAt);
}
function sweepOrphanedOpenCodeMessageIndexes(db, openReadableOpenCodeDb, options = {}) {
  const now = options.now ?? Date.now();
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? MESSAGE_HISTORY_ORPHAN_SWEEP_BATCH_SIZE));
  const safetyAgeMs = Math.max(0, options.safetyAgeMs ?? MESSAGE_HISTORY_ORPHAN_SAFETY_AGE_MS);
  const cooldownMs = Math.max(0, options.cooldownMs ?? MESSAGE_HISTORY_ORPHAN_SWEEP_COOLDOWN_MS);
  const unavailableReprobeMs = Math.max(cooldownMs, options.unavailableReprobeMs ?? MESSAGE_HISTORY_ORPHAN_UNAVAILABLE_REPROBE_MS);
  const state = getMessageHistoryOrphanSweepState(db);
  const cursor = typeof state.cursor_session_id === "string" ? state.cursor_session_id : "";
  if (typeof state.last_swept_at === "number" && state.last_swept_at + cooldownMs > now) {
    return { status: "cooldown", scanned: 0, deleted: 0, cursor };
  }
  let openCodeDb = null;
  try {
    openCodeDb = openReadableOpenCodeDb();
  } catch {
    openCodeDb = null;
  }
  if (!openCodeDb) {
    persistMessageHistoryOrphanSweepState(db, cursor, now + unavailableReprobeMs - cooldownMs);
    return { status: "source_unavailable", scanned: 0, deleted: 0, cursor };
  }
  try {
    const cutoff = now - safetyAgeMs;
    const candidates = db.prepare(`SELECT session_id
                 FROM message_history_index
                 WHERE harness = 'opencode'
                   AND updated_at <= ?
                   AND session_id > ?
                 ORDER BY session_id ASC
                 LIMIT ?`).all(cutoff, cursor, batchSize);
    const sessionExists = openCodeDb.prepare("SELECT 1 FROM session WHERE id = ? LIMIT 1");
    const missingSessionIds = candidates.filter((candidate) => !sessionExists.get(candidate.session_id)).map((candidate) => candidate.session_id);
    const nextCursor = candidates.length < batchSize ? "" : candidates[candidates.length - 1]?.session_id ?? cursor;
    const completedAt = candidates.length < batchSize ? now : null;
    db.exec("BEGIN IMMEDIATE");
    let committed = false;
    let deleted = 0;
    try {
      const stillEligible = db.prepare("SELECT 1 FROM message_history_index WHERE session_id = ? AND harness = 'opencode' AND updated_at <= ?");
      for (const sessionId of missingSessionIds) {
        if (!stillEligible.get(sessionId, cutoff))
          continue;
        getDeleteFtsStatement(db).run(sessionId);
        getDeleteMessageSourceStatement(db).run(sessionId);
        const result = db.prepare("DELETE FROM message_history_index WHERE session_id = ? AND harness = 'opencode' AND updated_at <= ?").run(sessionId, cutoff);
        if (result.changes === 1)
          deleted += 1;
      }
      persistMessageHistoryOrphanSweepState(db, nextCursor, completedAt);
      db.exec("COMMIT");
      committed = true;
    } finally {
      if (!committed) {
        try {
          db.exec("ROLLBACK");
        } catch {}
      }
    }
    return {
      status: "swept",
      scanned: candidates.length,
      deleted,
      cursor: nextCursor
    };
  } finally {
    closeQuietly(openCodeDb);
  }
}

// src/features/magic-context/resolve-subagent-fallback.ts
function resolveIsSubagentFromOpenCodeDb(sessionId) {
  try {
    return withReadOnlySessionDb((openCodeDb) => {
      const row = openCodeDb.prepare("SELECT parent_id FROM session WHERE id = ?").get(sessionId);
      if (!row)
        return null;
      return typeof row.parent_id === "string" && row.parent_id.length > 0;
    });
  } catch (error) {
    log(`[magic-context] resolveIsSubagentFromOpenCodeDb failed for ${sessionId}:`, error);
    return null;
  }
}

// src/features/magic-context/storage-meta-shared.ts
import { Buffer } from "node:buffer";
var SESSION_META_SELECT_COLUMNS = [
  "session_id",
  "last_response_time",
  "cache_ttl",
  "counter",
  "last_nudge_tokens",
  "last_nudge_band",
  "last_transform_error",
  "is_subagent",
  "last_context_percentage",
  "last_input_tokens",
  "observed_safe_input_tokens",
  "cache_alert_sent",
  "times_execute_threshold_reached",
  "compartment_in_progress",
  "system_prompt_hash",
  "system_prompt_tokens",
  "conversation_tokens",
  "tool_call_tokens",
  "cleared_reasoning_through_tag",
  "tool_reclaim_watermark",
  "last_todo_state",
  "cached_m0_bytes",
  "cached_m0_mural_data_url",
  "cached_m0_mural_hash",
  "cached_m1_bytes",
  "cached_m0_claim_format_epoch",
  "cached_m0_claim_snapshot_vector",
  "cached_m0_rendered_revision_locators",
  "cached_m0_project_memory_epoch",
  "cached_m0_workspace_fingerprint",
  "cached_m0_project_user_profile_version",
  "cached_m0_max_compartment_seq",
  "cached_m0_max_mutation_id",
  "cached_m0_project_docs_hash",
  "cached_m0_materialized_at",
  "cached_m0_session_facts_version",
  "cached_m0_upgrade_state",
  "cached_m0_system_hash",
  "cached_m0_tool_set_hash",
  "cached_m0_model_key",
  "cached_m0_project_identity",
  "last_observed_model_key",
  "last_usage_context_limit",
  "prior_boundary_ordinal",
  "protected_tail_policy_version",
  "protected_tail_drain_window_started_at",
  "protected_tail_drain_tokens",
  "recovery_no_eligible_head_count",
  "force_emergency_bypass_window_start",
  "force_emergency_bypass_used",
  "emergency_drain_active",
  "historian_drain_failure_at",
  "upgrade_reminded_at",
  "upgrade_reminder_last_sent_at",
  "upgrade_reminder_count",
  "pi_stable_id_scheme"
];
var META_COLUMNS = {
  lastResponseTime: "last_response_time",
  cacheTtl: "cache_ttl",
  counter: "counter",
  lastNudgeTokens: "last_nudge_tokens",
  lastNudgeBand: "last_nudge_band",
  lastTransformError: "last_transform_error",
  isSubagent: "is_subagent",
  lastContextPercentage: "last_context_percentage",
  lastInputTokens: "last_input_tokens",
  observedSafeInputTokens: "observed_safe_input_tokens",
  cacheAlertSent: "cache_alert_sent",
  timesExecuteThresholdReached: "times_execute_threshold_reached",
  compartmentInProgress: "compartment_in_progress",
  systemPromptHash: "system_prompt_hash",
  systemPromptTokens: "system_prompt_tokens",
  conversationTokens: "conversation_tokens",
  toolCallTokens: "tool_call_tokens",
  clearedReasoningThroughTag: "cleared_reasoning_through_tag",
  toolReclaimWatermark: "tool_reclaim_watermark",
  lastTodoState: "last_todo_state",
  cachedM0Bytes: "cached_m0_bytes",
  cachedM0MuralDataUrl: "cached_m0_mural_data_url",
  cachedM0MuralHash: "cached_m0_mural_hash",
  cachedM1Bytes: "cached_m1_bytes",
  cachedM0ClaimFormatEpoch: "cached_m0_claim_format_epoch",
  cachedM0ClaimSnapshotVector: "cached_m0_claim_snapshot_vector",
  cachedM0RenderedRevisionLocators: "cached_m0_rendered_revision_locators",
  cachedM0ProjectMemoryEpoch: "cached_m0_project_memory_epoch",
  cachedM0WorkspaceFingerprint: "cached_m0_workspace_fingerprint",
  cachedM0ProjectUserProfileVersion: "cached_m0_project_user_profile_version",
  cachedM0MaxCompartmentSeq: "cached_m0_max_compartment_seq",
  cachedM0MaxMutationId: "cached_m0_max_mutation_id",
  cachedM0ProjectDocsHash: "cached_m0_project_docs_hash",
  cachedM0MaterializedAt: "cached_m0_materialized_at",
  cachedM0SessionFactsVersion: "cached_m0_session_facts_version",
  cachedM0UpgradeState: "cached_m0_upgrade_state",
  cachedM0SystemHash: "cached_m0_system_hash",
  cachedM0ToolSetHash: "cached_m0_tool_set_hash",
  cachedM0ModelKey: "cached_m0_model_key",
  cachedM0ProjectIdentity: "cached_m0_project_identity",
  lastObservedModelKey: "last_observed_model_key",
  lastUsageContextLimit: "last_usage_context_limit",
  priorBoundaryOrdinal: "prior_boundary_ordinal",
  protectedTailPolicyVersion: "protected_tail_policy_version",
  protectedTailDrainWindowStartedAt: "protected_tail_drain_window_started_at",
  protectedTailDrainTokens: "protected_tail_drain_tokens",
  recoveryNoEligibleHeadCount: "recovery_no_eligible_head_count",
  forceEmergencyBypassWindowStart: "force_emergency_bypass_window_start",
  forceEmergencyBypassUsed: "force_emergency_bypass_used",
  emergencyDrainActive: "emergency_drain_active",
  historianDrainFailureAt: "historian_drain_failure_at",
  upgradeRemindedAt: "upgrade_reminded_at",
  upgradeReminderLastSentAt: "upgrade_reminder_last_sent_at",
  upgradeReminderCount: "upgrade_reminder_count",
  piStableIdScheme: "pi_stable_id_scheme"
};
var BOOLEAN_META_KEYS = new Set(["isSubagent", "compartmentInProgress", "cacheAlertSent"]);
var NULL_BIND_META_KEYS = new Set([
  "cachedM0Bytes",
  "cachedM0MuralDataUrl",
  "cachedM0MuralHash",
  "cachedM1Bytes",
  "cachedM0ClaimFormatEpoch",
  "cachedM0ClaimSnapshotVector",
  "cachedM0RenderedRevisionLocators",
  "cachedM0ProjectMemoryEpoch",
  "cachedM0WorkspaceFingerprint",
  "cachedM0ProjectUserProfileVersion",
  "cachedM0MaxCompartmentSeq",
  "cachedM0MaxMutationId",
  "cachedM0ProjectDocsHash",
  "cachedM0MaterializedAt",
  "cachedM0SessionFactsVersion",
  "cachedM0UpgradeState",
  "cachedM0ProjectIdentity",
  "lastObservedModelKey",
  "upgradeRemindedAt",
  "upgradeReminderLastSentAt",
  "piStableIdScheme"
]);
function isStringOrNull(value) {
  return value === null || typeof value === "string";
}
function isNumberOrNull(value) {
  return value === null || typeof value === "number";
}
function isBlobOrNull(value) {
  return value === null || Buffer.isBuffer(value) || value instanceof Uint8Array;
}
function toBufferOrNull(value) {
  if (value === null)
    return null;
  if (Buffer.isBuffer(value))
    return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
function isSessionMetaRow(row) {
  if (row === null || typeof row !== "object")
    return false;
  const r = row;
  return typeof r.session_id === "string" && typeof r.last_response_time === "number" && isStringOrNull(r.cache_ttl) && typeof r.counter === "number" && typeof r.last_nudge_tokens === "number" && isStringOrNull(r.last_nudge_band) && isStringOrNull(r.last_transform_error) && typeof r.is_subagent === "number" && typeof r.last_context_percentage === "number" && typeof r.last_input_tokens === "number" && isNumberOrNull(r.observed_safe_input_tokens) && isNumberOrNull(r.cache_alert_sent) && isNumberOrNull(r.times_execute_threshold_reached) && isNumberOrNull(r.compartment_in_progress) && (r.system_prompt_hash === null || typeof r.system_prompt_hash === "string" || typeof r.system_prompt_hash === "number") && isNumberOrNull(r.system_prompt_tokens) && isNumberOrNull(r.conversation_tokens) && isNumberOrNull(r.tool_call_tokens) && isNumberOrNull(r.cleared_reasoning_through_tag) && isStringOrNull(r.last_todo_state) && isBlobOrNull(r.cached_m0_bytes) && isStringOrNull(r.cached_m0_mural_data_url) && isStringOrNull(r.cached_m0_mural_hash) && isBlobOrNull(r.cached_m1_bytes) && isNumberOrNull(r.cached_m0_claim_format_epoch) && isStringOrNull(r.cached_m0_claim_snapshot_vector) && isStringOrNull(r.cached_m0_rendered_revision_locators) && isNumberOrNull(r.cached_m0_project_memory_epoch) && isStringOrNull(r.cached_m0_workspace_fingerprint) && isNumberOrNull(r.cached_m0_project_user_profile_version) && isNumberOrNull(r.cached_m0_max_compartment_seq) && isNumberOrNull(r.cached_m0_max_mutation_id) && isStringOrNull(r.cached_m0_project_docs_hash) && isNumberOrNull(r.cached_m0_materialized_at) && isNumberOrNull(r.cached_m0_session_facts_version) && isStringOrNull(r.cached_m0_upgrade_state) && isStringOrNull(r.cached_m0_system_hash) && isStringOrNull(r.cached_m0_tool_set_hash) && isStringOrNull(r.cached_m0_model_key) && isStringOrNull(r.cached_m0_project_identity) && isStringOrNull(r.last_observed_model_key) && isNumberOrNull(r.last_usage_context_limit) && isNumberOrNull(r.prior_boundary_ordinal) && isNumberOrNull(r.protected_tail_policy_version) && isNumberOrNull(r.protected_tail_drain_window_started_at) && isNumberOrNull(r.protected_tail_drain_tokens) && isNumberOrNull(r.recovery_no_eligible_head_count) && isNumberOrNull(r.force_emergency_bypass_window_start) && isNumberOrNull(r.force_emergency_bypass_used) && isNumberOrNull(r.upgrade_reminded_at) && isNumberOrNull(r.upgrade_reminder_last_sent_at) && isNumberOrNull(r.upgrade_reminder_count) && isNumberOrNull(r.pi_stable_id_scheme) && isNumberOrNull(r.tool_reclaim_watermark);
}
function getDefaultSessionMeta(sessionId) {
  return {
    sessionId,
    lastResponseTime: 0,
    cacheTtl: "5m",
    counter: 0,
    lastNudgeTokens: 0,
    lastNudgeBand: null,
    lastTransformError: null,
    isSubagent: false,
    lastContextPercentage: 0,
    lastInputTokens: 0,
    observedSafeInputTokens: 0,
    cacheAlertSent: false,
    timesExecuteThresholdReached: 0,
    compartmentInProgress: false,
    systemPromptHash: "",
    systemPromptTokens: 0,
    conversationTokens: 0,
    toolCallTokens: 0,
    clearedReasoningThroughTag: 0,
    toolReclaimWatermark: 0,
    lastTodoState: "",
    cachedM0Bytes: null,
    cachedM0MuralDataUrl: null,
    cachedM0MuralHash: null,
    cachedM1Bytes: null,
    cachedM0ClaimFormatEpoch: null,
    cachedM0ClaimSnapshotVector: null,
    cachedM0RenderedRevisionLocators: null,
    cachedM0ProjectMemoryEpoch: null,
    cachedM0WorkspaceFingerprint: null,
    cachedM0ProjectUserProfileVersion: null,
    cachedM0MaxCompartmentSeq: null,
    cachedM0MaxMutationId: null,
    cachedM0ProjectDocsHash: null,
    cachedM0MaterializedAt: null,
    cachedM0SessionFactsVersion: null,
    cachedM0UpgradeState: null,
    cachedM0SystemHash: null,
    cachedM0ToolSetHash: null,
    cachedM0ModelKey: null,
    cachedM0ProjectIdentity: null,
    lastObservedModelKey: null,
    lastUsageContextLimit: 0,
    priorBoundaryOrdinal: 1,
    protectedTailPolicyVersion: 0,
    protectedTailDrainWindowStartedAt: 0,
    protectedTailDrainTokens: 0,
    recoveryNoEligibleHeadCount: 0,
    forceEmergencyBypassWindowStart: 0,
    forceEmergencyBypassUsed: 0,
    upgradeRemindedAt: null,
    upgradeReminderLastSentAt: null,
    upgradeReminderCount: 0,
    piStableIdScheme: null
  };
}
function ensureSessionMetaRow(db, sessionId) {
  const defaults = getDefaultSessionMeta(sessionId);
  db.prepare("INSERT OR IGNORE INTO session_meta (session_id, harness, last_response_time, cache_ttl, counter, last_nudge_tokens, last_nudge_band, last_transform_error, is_subagent, last_context_percentage, last_input_tokens, observed_safe_input_tokens, cache_alert_sent, times_execute_threshold_reached, compartment_in_progress, system_prompt_hash, cleared_reasoning_through_tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(sessionId, getHarness(), defaults.lastResponseTime, defaults.cacheTtl, defaults.counter, defaults.lastNudgeTokens, defaults.lastNudgeBand ?? "", defaults.lastTransformError ?? "", defaults.isSubagent ? 1 : 0, defaults.lastContextPercentage, defaults.lastInputTokens, defaults.observedSafeInputTokens, defaults.cacheAlertSent ? 1 : 0, defaults.timesExecuteThresholdReached, defaults.compartmentInProgress ? 1 : 0, defaults.systemPromptHash ?? "", defaults.clearedReasoningThroughTag);
}
function toSessionMeta(row) {
  const nudgeBandRaw = typeof row.last_nudge_band === "string" ? row.last_nudge_band : "";
  const transformErrorRaw = typeof row.last_transform_error === "string" ? row.last_transform_error : "";
  const cacheTtlRaw = typeof row.cache_ttl === "string" && row.cache_ttl.length > 0 ? row.cache_ttl : "5m";
  const systemPromptHashRaw = row.system_prompt_hash == null ? "" : row.system_prompt_hash;
  const lastTodoStateRaw = typeof row.last_todo_state === "string" ? row.last_todo_state : "";
  const numOrZero = (value) => typeof value === "number" ? value : 0;
  const numOrNull = (value) => typeof value === "number" ? value : null;
  const stringOrNull = (value) => typeof value === "string" ? value : null;
  return {
    sessionId: row.session_id,
    lastResponseTime: row.last_response_time,
    cacheTtl: cacheTtlRaw,
    counter: row.counter,
    lastNudgeTokens: row.last_nudge_tokens,
    lastNudgeBand: nudgeBandRaw.length > 0 ? nudgeBandRaw : null,
    lastTransformError: transformErrorRaw.length > 0 ? transformErrorRaw : null,
    isSubagent: row.is_subagent === 1,
    lastContextPercentage: row.last_context_percentage,
    lastInputTokens: row.last_input_tokens,
    observedSafeInputTokens: numOrZero(row.observed_safe_input_tokens),
    cacheAlertSent: numOrZero(row.cache_alert_sent) === 1,
    timesExecuteThresholdReached: numOrZero(row.times_execute_threshold_reached),
    compartmentInProgress: row.compartment_in_progress === 1,
    systemPromptHash: String(systemPromptHashRaw),
    systemPromptTokens: numOrZero(row.system_prompt_tokens),
    conversationTokens: numOrZero(row.conversation_tokens),
    toolCallTokens: numOrZero(row.tool_call_tokens),
    clearedReasoningThroughTag: numOrZero(row.cleared_reasoning_through_tag),
    toolReclaimWatermark: numOrZero(row.tool_reclaim_watermark),
    lastTodoState: lastTodoStateRaw,
    cachedM0Bytes: toBufferOrNull(row.cached_m0_bytes),
    cachedM0MuralDataUrl: stringOrNull(row.cached_m0_mural_data_url),
    cachedM0MuralHash: stringOrNull(row.cached_m0_mural_hash),
    cachedM1Bytes: toBufferOrNull(row.cached_m1_bytes),
    cachedM0ClaimFormatEpoch: numOrNull(row.cached_m0_claim_format_epoch),
    cachedM0ClaimSnapshotVector: stringOrNull(row.cached_m0_claim_snapshot_vector),
    cachedM0RenderedRevisionLocators: stringOrNull(row.cached_m0_rendered_revision_locators),
    cachedM0ProjectMemoryEpoch: numOrNull(row.cached_m0_project_memory_epoch),
    cachedM0WorkspaceFingerprint: stringOrNull(row.cached_m0_workspace_fingerprint),
    cachedM0ProjectUserProfileVersion: numOrNull(row.cached_m0_project_user_profile_version),
    cachedM0MaxCompartmentSeq: numOrNull(row.cached_m0_max_compartment_seq),
    cachedM0MaxMutationId: numOrNull(row.cached_m0_max_mutation_id),
    cachedM0ProjectDocsHash: stringOrNull(row.cached_m0_project_docs_hash),
    cachedM0MaterializedAt: numOrNull(row.cached_m0_materialized_at),
    cachedM0SessionFactsVersion: numOrNull(row.cached_m0_session_facts_version),
    cachedM0UpgradeState: stringOrNull(row.cached_m0_upgrade_state),
    cachedM0SystemHash: stringOrNull(row.cached_m0_system_hash),
    cachedM0ToolSetHash: stringOrNull(row.cached_m0_tool_set_hash),
    cachedM0ModelKey: stringOrNull(row.cached_m0_model_key),
    cachedM0ProjectIdentity: stringOrNull(row.cached_m0_project_identity),
    lastObservedModelKey: stringOrNull(row.last_observed_model_key),
    lastUsageContextLimit: numOrZero(row.last_usage_context_limit),
    priorBoundaryOrdinal: Math.max(1, numOrZero(row.prior_boundary_ordinal) || 1),
    protectedTailPolicyVersion: numOrZero(row.protected_tail_policy_version),
    protectedTailDrainWindowStartedAt: numOrZero(row.protected_tail_drain_window_started_at),
    protectedTailDrainTokens: numOrZero(row.protected_tail_drain_tokens),
    recoveryNoEligibleHeadCount: numOrZero(row.recovery_no_eligible_head_count),
    forceEmergencyBypassWindowStart: numOrZero(row.force_emergency_bypass_window_start),
    forceEmergencyBypassUsed: numOrZero(row.force_emergency_bypass_used),
    upgradeRemindedAt: numOrNull(row.upgrade_reminded_at),
    upgradeReminderLastSentAt: numOrNull(row.upgrade_reminder_last_sent_at),
    upgradeReminderCount: numOrZero(row.upgrade_reminder_count),
    piStableIdScheme: numOrNull(row.pi_stable_id_scheme)
  };
}
function persistCachedM0(db, sessionId, payload) {
  ensureSessionMetaRow(db, sessionId);
  db.prepare(`UPDATE session_meta SET
            cached_m0_bytes = ?,
            cached_m0_mural_data_url = ?,
            cached_m0_mural_hash = ?,
            cached_m0_claim_format_epoch = ?,
            cached_m0_claim_snapshot_vector = ?,
            cached_m0_rendered_revision_locators = ?,
            cached_m0_project_memory_epoch = ?,
            cached_m0_workspace_fingerprint = ?,
            cached_m0_project_user_profile_version = ?,
            cached_m0_max_compartment_seq = ?,
            cached_m0_max_mutation_id = ?,
            cached_m1_bytes = ?,
            cached_m0_project_docs_hash = ?,
            cached_m0_materialized_at = ?,
            cached_m0_session_facts_version = ?,
            cached_m0_upgrade_state = ?,
            cached_m0_system_hash = ?,
            cached_m0_model_key = ?,
            cached_m0_project_identity = ?
         WHERE session_id = ?`).run(Buffer.from(payload.m0Bytes), payload.muralDataUrl ?? null, payload.muralHash ?? null, payload.claimFormatEpoch ?? null, payload.claimSnapshotVector ?? null, payload.renderedRevisionLocators ?? null, payload.projectMemoryEpoch ?? null, payload.workspaceFingerprint ?? null, payload.projectUserProfileVersion, payload.maxCompartmentSeq, payload.maxMutationId, payload.m1Bytes ? Buffer.from(payload.m1Bytes) : null, payload.projectDocsHash, payload.materializedAt, payload.sessionFactsVersion, payload.upgradeState, payload.systemHash ?? "", payload.modelKey ? piModelRefToCanonical(payload.modelKey) : "", payload.projectIdentity ?? null, sessionId);
}
function clearCachedM0M1(db, sessionId) {
  ensureSessionMetaRow(db, sessionId);
  const existingColumns = new Set(db.prepare("PRAGMA table_info(session_meta)").all().map((column) => column.name));
  const clears = [
    ["cached_m0_bytes", null],
    ["cached_m0_mural_data_url", null],
    ["cached_m0_mural_hash", null],
    ["cached_m1_bytes", null],
    ["cached_m0_claim_format_epoch", null],
    ["cached_m0_claim_snapshot_vector", null],
    ["cached_m0_rendered_revision_locators", null],
    ["cached_m0_project_memory_epoch", null],
    ["cached_m0_workspace_fingerprint", null],
    ["cached_m0_project_user_profile_version", null],
    ["cached_m0_max_compartment_seq", null],
    ["cached_m0_max_mutation_id", null],
    ["cached_m0_project_docs_hash", null],
    ["cached_m0_materialized_at", null],
    ["cached_m0_session_facts_version", null],
    ["cached_m0_upgrade_state", null],
    ["cached_m0_system_hash", null],
    ["cached_m0_tool_set_hash", null],
    ["cached_m0_model_key", null],
    ["cached_m0_project_identity", null],
    ["cached_m0_last_baseline_end_message_id", null],
    ["memory_block_cache", ""],
    ["memory_block_count", 0],
    ["memory_block_ids", ""]
  ];
  const setClauses = [];
  const values = [];
  for (const [column, value] of clears) {
    if (!existingColumns.has(column))
      continue;
    setClauses.push(`${column} = ?`);
    values.push(value);
  }
  if (setClauses.length === 0)
    return;
  db.prepare(`UPDATE session_meta SET ${setClauses.join(", ")} WHERE session_id = ?`).run(...values, sessionId);
}

// src/features/magic-context/storage-meta-session.ts
var SESSION_META_FALLBACK_SELECTS = {
  cache_ttl: "'5m' AS cache_ttl",
  last_nudge_band: "'' AS last_nudge_band",
  last_transform_error: "'' AS last_transform_error",
  system_prompt_hash: "'' AS system_prompt_hash",
  last_todo_state: "'' AS last_todo_state",
  tool_reclaim_watermark: "0 AS tool_reclaim_watermark",
  cached_m0_bytes: "NULL AS cached_m0_bytes",
  cached_m0_mural_data_url: "NULL AS cached_m0_mural_data_url",
  cached_m0_mural_hash: "NULL AS cached_m0_mural_hash",
  cached_m1_bytes: "NULL AS cached_m1_bytes",
  cached_m0_claim_format_epoch: "NULL AS cached_m0_claim_format_epoch",
  cached_m0_claim_snapshot_vector: "NULL AS cached_m0_claim_snapshot_vector",
  cached_m0_rendered_revision_locators: "NULL AS cached_m0_rendered_revision_locators",
  cached_m0_project_memory_epoch: "NULL AS cached_m0_project_memory_epoch",
  cached_m0_project_user_profile_version: "NULL AS cached_m0_project_user_profile_version",
  cached_m0_max_compartment_seq: "NULL AS cached_m0_max_compartment_seq",
  cached_m0_max_mutation_id: "NULL AS cached_m0_max_mutation_id",
  cached_m0_project_docs_hash: "NULL AS cached_m0_project_docs_hash",
  cached_m0_materialized_at: "NULL AS cached_m0_materialized_at",
  cached_m0_session_facts_version: "NULL AS cached_m0_session_facts_version",
  cached_m0_upgrade_state: "NULL AS cached_m0_upgrade_state",
  cached_m0_system_hash: "NULL AS cached_m0_system_hash",
  cached_m0_tool_set_hash: "NULL AS cached_m0_tool_set_hash",
  cached_m0_model_key: "NULL AS cached_m0_model_key",
  cached_m0_project_identity: "NULL AS cached_m0_project_identity",
  last_observed_model_key: "NULL AS last_observed_model_key",
  upgrade_reminded_at: "NULL AS upgrade_reminded_at",
  upgrade_reminder_last_sent_at: "NULL AS upgrade_reminder_last_sent_at",
  upgrade_reminder_count: "0 AS upgrade_reminder_count"
};
var sessionMetaSelectColumnsCache = new WeakMap;
var sessionMetaSelectStatementCache = new WeakMap;
function getSessionMetaSelectStatement(db) {
  const cached = sessionMetaSelectStatementCache.get(db);
  if (cached !== undefined)
    return cached;
  const statement = db.prepare(`SELECT ${getSessionMetaSelectColumns(db)} FROM session_meta WHERE session_id = ?`);
  sessionMetaSelectStatementCache.set(db, statement);
  return statement;
}
function getSessionMetaSelectColumns(db) {
  const cached = sessionMetaSelectColumnsCache.get(db);
  if (cached !== undefined)
    return cached;
  const existingColumns = new Set(db.prepare("PRAGMA table_info(session_meta)").all().map((column) => column.name));
  const projection = SESSION_META_SELECT_COLUMNS.map((column) => {
    if (existingColumns.has(column))
      return column;
    return SESSION_META_FALLBACK_SELECTS[column] ?? `0 AS ${column}`;
  }).join(", ");
  sessionMetaSelectColumnsCache.set(db, projection);
  return projection;
}
function getOrCreateSessionMeta(db, sessionId) {
  const result = getSessionMetaSelectStatement(db).get(sessionId);
  if (isSessionMetaRow(result)) {
    return toSessionMeta(result);
  }
  const defaults = getDefaultSessionMeta(sessionId);
  const fallbackSubagent = getHarness() === "opencode" ? resolveIsSubagentFromOpenCodeDb(sessionId) : null;
  if (fallbackSubagent === true) {
    defaults.isSubagent = true;
  }
  ensureSessionMetaRow(db, sessionId);
  if (fallbackSubagent === true) {
    db.prepare("UPDATE session_meta SET is_subagent = 1 WHERE session_id = ?").run(sessionId);
  }
  return defaults;
}
function updateSessionMeta(db, sessionId, updates) {
  const setClauses = [];
  const values = [];
  for (const [key, column] of Object.entries(META_COLUMNS)) {
    const value = updates[key];
    if (value === undefined)
      continue;
    if (value === null) {
      setClauses.push(`${column} = ?`);
      values.push(NULL_BIND_META_KEYS.has(key) ? null : "");
    } else if ((key === "cachedM0Bytes" || key === "cachedM1Bytes") && value instanceof Uint8Array) {
      setClauses.push(`${column} = ?`);
      values.push(Buffer2.from(value.buffer, value.byteOffset, value.byteLength));
    } else if (BOOLEAN_META_KEYS.has(key)) {
      setClauses.push(`${column} = ?`);
      values.push(value ? 1 : 0);
    } else if (typeof value === "string" || typeof value === "number") {
      setClauses.push(`${column} = ?`);
      values.push(key === "lastObservedModelKey" && typeof value === "string" ? piModelRefToCanonical(value) : value);
    }
  }
  if (setClauses.length === 0) {
    return;
  }
  db.transaction(() => {
    ensureSessionMetaRow(db, sessionId);
    db.prepare(`UPDATE session_meta SET ${setClauses.join(", ")} WHERE session_id = ?`).run(...values, sessionId);
  })();
}
function advanceToolReclaimWatermark(db, sessionId, maxTagNumber) {
  if (maxTagNumber <= 0)
    return;
  db.transaction(() => {
    ensureSessionMetaRow(db, sessionId);
    db.prepare("UPDATE session_meta SET tool_reclaim_watermark = MAX(COALESCE(tool_reclaim_watermark, 0), ?) WHERE session_id = ?").run(maxTagNumber, sessionId);
  })();
}
function markSessionCleanupPending(db, sessionId) {
  db.prepare(`INSERT INTO pending_session_cleanup (session_id, harness, requested_at, last_attempt_at)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT(session_id) DO UPDATE SET
             harness = excluded.harness,
             requested_at = MIN(pending_session_cleanup.requested_at, excluded.requested_at)`).run(sessionId, getHarness(), Date.now());
}
function retryPendingSessionCleanups(db, limit = 200) {
  const rows = db.prepare("SELECT session_id FROM pending_session_cleanup ORDER BY requested_at ASC, session_id ASC LIMIT ?").all(Math.max(1, Math.floor(limit)));
  const failedSessionIds = [];
  let cleared = 0;
  for (const row of rows) {
    try {
      db.prepare("UPDATE pending_session_cleanup SET last_attempt_at = ? WHERE session_id = ?").run(Date.now(), row.session_id);
      clearSession(db, row.session_id);
      cleared += 1;
    } catch {
      failedSessionIds.push(row.session_id);
    }
  }
  return { attempted: rows.length, cleared, failedSessionIds };
}
function clearSession(db, sessionId) {
  db.transaction(() => {
    db.prepare("DELETE FROM pending_ops WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM source_contents WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM tags WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM session_meta WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM session_projects WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM compartment_chunk_embeddings WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
    clearCompressionDepth(db, sessionId);
    db.prepare("DELETE FROM session_facts WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM compartment_state_lease WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM notes WHERE session_id = ? AND type = 'session'").run(sessionId);
    db.prepare("DELETE FROM recomp_compartments WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM recomp_facts WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM user_memory_candidates WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM primer_candidates WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM m0_mutation_log WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM compartment_events WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM subagent_invocations WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM historian_runs WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM plugin_messages WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM transform_decisions WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM synapse_batch_ledger WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM embedding_measurement_corpus WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM pending_session_cleanup WHERE session_id = ?").run(sessionId);
    clearIndexedMessages(db, sessionId);
  })();
}

export { textMentionsRecentCommit, preloadTokenizer, estimateTokens, hasMeaningfulUserText, extractTexts, extractToolCallSummaries, normalizeText, stableStringify, clearCompressionDepth, clearCompressionDepthRange, ensureSessionMetaRow, persistCachedM0, clearCachedM0M1, isRawCompactionSummaryInfo, extractInMemoryMessageViews, buildInMemoryTailRawMessages, isRecord, completedToolArcCrossesBoundary, estimateTrueRawMessageTokens, buildToolArcs, fenceBoundaryForToolArcs, buildTrueRawTokenIndex, computeRawRangeFingerprint, invalidateTrueRawTokenCache, stripPersistedAssistantText, byteSize, stripTagPrefix, peelLeadingMcTagNotation, prependTag, isThinkingPart, isTextPart, isToolPartWithOutput, isFilePart, buildFileSourceContent, isEditTool, partHasCompletedResult, extractToolCallObservation, ToolMutationBatch, createToolDropTarget, setRawMessageProvider, cleanUserText, withRawSessionMessageCache, readRawSessionMessages, primeTailRawMessageCache, getCachedAbsoluteMessageCount, primeInMemoryTailRawMessageCache, readRawSessionMessageOrdinalPage, getRawSessionStoredMessageCount, readRawSessionMessagePartsById, readRawSessionMessageOrdinalById, readRawSessionMessageById, getRawSessionMessageCount, getRawSessionTagKeysThrough, getLegacyProtectedTailStartOrdinal, readSessionChunk, getMessageIndexSourceIdentity, isMessageIndexSourceCurrent, getLastIndexedOrdinal, getIndexedMessageCorpusSize, getMessageIndexReconciliationStartOrdinal, isMessageIndexReconciledThrough, deleteIndexedMessage, clearIndexedMessages, indexSingleMessage, indexMessagesAfterOrdinal, sweepOrphanedOpenCodeMessageIndexes, getOrCreateSessionMeta, updateSessionMeta, advanceToolReclaimWatermark, markSessionCleanupPending, retryPendingSessionCleanups, clearSession };
