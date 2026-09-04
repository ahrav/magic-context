import {
  log
} from "./index-rjbc1j54.js";
import {
  getDataDir
} from "./index-p5d8sma0.js";

// src/hooks/magic-context/read-session-db.ts
import { existsSync } from "node:fs";
import { join } from "node:path";

// src/shared/sqlite.ts
function detectSqliteRuntime() {
  const hasBunVersion = typeof process !== "undefined" && typeof process.versions?.bun === "string";
  const hasBunGlobal = typeof globalThis !== "undefined" && typeof globalThis.Bun !== "undefined";
  return hasBunVersion || hasBunGlobal ? "Bun" : "Node.js";
}
var bunSpec = "bun:" + "sqlite";
var nodeSpec = "node:" + "sqlite";
async function importSqliteModule(specifier) {
  return await import(specifier);
}
function isModuleNotFoundError(error, specifier) {
  const candidate = error;
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const name = typeof candidate?.name === "string" ? candidate.name : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  const details = `${code} ${name} ${message}`.toLowerCase();
  const mentionsSpecifier = details.includes(specifier.toLowerCase());
  if (!mentionsSpecifier)
    return false;
  return code === "ERR_MODULE_NOT_FOUND" || code === "ERR_UNKNOWN_BUILTIN_MODULE" || code === "MODULE_NOT_FOUND" || name === "ResolveMessage" || details.includes("module not found") || details.includes("cannot find module") || details.includes("cannot find package") || details.includes("no such built-in module");
}

class SqliteRuntimeUnavailableError extends Error {
  runtime;
  specifier;
  constructor(runtime, specifier, cause) {
    const requirement = specifier === nodeSpec ? "Requires Node.js >= 24, or Bun with bun:sqlite — this Bun build lacks node:sqlite." : "Requires Bun with bun:sqlite, or Node.js >= 24 — this Bun build lacks bun:sqlite.";
    super(`Magic Context detected ${runtime}, but could not load ${specifier}. ${requirement}`, { cause });
    this.name = "SqliteRuntimeUnavailableError";
    this.runtime = runtime;
    this.specifier = specifier;
  }
}
async function loadSqliteModule(runtime = detectSqliteRuntime(), importer = importSqliteModule) {
  const specifier = runtime === "Bun" ? bunSpec : nodeSpec;
  try {
    return await importer(specifier);
  } catch (error) {
    if (isModuleNotFoundError(error, specifier)) {
      throw new SqliteRuntimeUnavailableError(runtime, specifier, error);
    }
    throw error;
  }
}
var detectedRuntime = detectSqliteRuntime();
var isBun = detectedRuntime === "Bun";
var sqliteModule = await loadSqliteModule(detectedRuntime);
var DatabaseImpl = isBun ? sqliteModule.Database : buildNodeSqliteDatabaseClass(sqliteModule.DatabaseSync);
function buildNodeSqliteDatabaseClass(DatabaseSync) {
  const SAVEPOINT = "mc_tx_sp";

  class NodeSqliteDatabase extends DatabaseSync {
    constructor(filename, options) {
      const translated = { ...options };
      if (options && "readonly" in options) {
        translated.readOnly = options.readonly;
        delete translated.readonly;
      }
      super(typeof filename === "string" ? filename : ":memory:", translated);
    }
    prepare(sql) {
      const stmt = super.prepare(sql);
      for (const method of ["run", "get", "all"]) {
        const original = stmt[method].bind(stmt);
        stmt[method] = (...args) => args.length === 1 && Array.isArray(args[0]) ? original(...args[0]) : original(...args);
      }
      return stmt;
    }
    transaction(fn) {
      const self = this;
      const execute = (mode, receiver, args) => {
        const nested = self.isTransaction === true;
        self.exec(nested ? `SAVEPOINT ${SAVEPOINT}` : `BEGIN${mode ? ` ${mode}` : ""}`);
        try {
          const result = fn.apply(receiver, args);
          self.exec(nested ? `RELEASE ${SAVEPOINT}` : "COMMIT");
          return result;
        } catch (error) {
          if (self.isTransaction === true) {
            if (nested) {
              try {
                self.exec("ROLLBACK TO mc_tx_sp");
                if (self.isTransaction === true)
                  self.exec("RELEASE mc_tx_sp");
              } catch {}
            } else {
              try {
                self.exec("ROLLBACK");
              } catch {}
            }
          }
          throw error;
        }
      };
      const wrapped = function(...args) {
        return execute("", this, args);
      };
      wrapped.default = function(...args) {
        return execute("", this, args);
      };
      wrapped.deferred = function(...args) {
        return execute("DEFERRED", this, args);
      };
      wrapped.immediate = function(...args) {
        return execute("IMMEDIATE", this, args);
      };
      wrapped.exclusive = function(...args) {
        return execute("EXCLUSIVE", this, args);
      };
      return wrapped;
    }
  }
  return NodeSqliteDatabase;
}
var Database = DatabaseImpl;
var privilegeDepth = new WeakMap;
function isInTransaction(db) {
  const candidate = db;
  return candidate.inTransaction === true || candidate.isTransaction === true;
}
function withPrivilegedWriter(db, operation) {
  const previousDepth = privilegeDepth.get(db) ?? 0;
  const nested = isInTransaction(db);
  const savepoint = "mc_privilege_scope";
  if (nested) {
    db.exec(`SAVEPOINT ${savepoint}`);
  } else {
    db.exec("BEGIN IMMEDIATE");
  }
  privilegeDepth.set(db, previousDepth + 1);
  try {
    db.prepare("INSERT INTO context_privilege_state(id, enabled) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET enabled = 1").run();
    const result = operation();
    if (previousDepth === 0) {
      db.prepare("UPDATE context_privilege_state SET enabled = 0 WHERE id = 1").run();
    }
    if (nested) {
      db.exec(`RELEASE ${savepoint}`);
    } else {
      db.exec("COMMIT");
    }
    if (previousDepth > 0)
      privilegeDepth.set(db, previousDepth);
    else
      privilegeDepth.delete(db);
    return result;
  } catch (error) {
    try {
      if (nested) {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      } else {
        db.exec("ROLLBACK");
      }
    } finally {
      if (previousDepth > 0)
        privilegeDepth.set(db, previousDepth);
      else
        privilegeDepth.delete(db);
    }
    throw error;
  }
}
var SQLITE_WAL_RESET_SAFE_MIN_VERSION = "3.47.1";
var MIN_SUPPORTED_NODE_VERSION = "24.15.0";
var MIN_SUPPORTED_BUN_VERSION = "1.3.14";
var SQLITE_SOURCE_ID_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [0-9a-f]{40,64}$/;
function readSqliteEngineIdentity(db) {
  const row = db.prepare("SELECT sqlite_version() AS version, sqlite_source_id() AS source_id").get();
  return { sqliteVersion: String(row.version), sqliteSourceId: String(row.source_id) };
}
function probeSqliteEngineIdentityOffPath() {
  const probe = new Database(":memory:");
  try {
    return readSqliteEngineIdentity(probe);
  } finally {
    probe.close();
  }
}
function parseDottedVersion(version) {
  const match = version.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match)
    return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}
function isVersionAtLeast(candidate, floor) {
  const left = parseDottedVersion(candidate);
  const right = parseDottedVersion(floor);
  if (!left || !right)
    return false;
  for (let index = 0;index < 3; index += 1) {
    if (left[index] !== right[index])
      return left[index] > right[index];
  }
  return true;
}
function evaluateSqliteRuntimeGate(input) {
  const reasons = [];
  const runtimeFloor = input.runtime === "Bun" ? MIN_SUPPORTED_BUN_VERSION : MIN_SUPPORTED_NODE_VERSION;
  if (!isVersionAtLeast(input.runtimeVersion, runtimeFloor)) {
    reasons.push(`${input.runtime} ${input.runtimeVersion} is below the supported floor ${runtimeFloor}`);
  }
  if (!isVersionAtLeast(input.sqliteVersion, SQLITE_WAL_RESET_SAFE_MIN_VERSION)) {
    reasons.push(`SQLite ${input.sqliteVersion} predates the WAL-reset fix in ${SQLITE_WAL_RESET_SAFE_MIN_VERSION}`);
  }
  if (!SQLITE_SOURCE_ID_PATTERN.test(input.sqliteSourceId)) {
    reasons.push(`sqlite_source_id() '${input.sqliteSourceId}' is not a recognized SQLite source identity`);
  }
  return { ok: reasons.length === 0, reasons };
}
function collectSqliteRuntimeGateInput() {
  const runtime = detectSqliteRuntime();
  const runtimeVersion = runtime === "Bun" ? process.versions.bun ?? "0.0.0" : process.versions.node ?? "0.0.0";
  return { runtime, runtimeVersion, ...probeSqliteEngineIdentityOffPath() };
}
function verifySqliteConnectionContract(db, expectations) {
  const violations = [];
  const foreignKeys = Number(db.prepare("PRAGMA foreign_keys").get().foreign_keys);
  if (foreignKeys !== 1)
    violations.push("foreign_keys is disabled");
  const journalMode = String(db.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
  if (expectations.expectWal && journalMode !== "wal") {
    violations.push(`journal_mode is '${journalMode}', expected 'wal'`);
  }
  const busyTimeoutMs = Number(db.prepare("PRAGMA busy_timeout").get().timeout);
  const minBusyTimeoutMs = expectations.minBusyTimeoutMs ?? 1;
  if (!Number.isFinite(busyTimeoutMs) || busyTimeoutMs < minBusyTimeoutMs) {
    violations.push(`busy_timeout ${busyTimeoutMs}ms is below the required ${minBusyTimeoutMs}ms`);
  }
  const synchronous = Number(db.prepare("PRAGMA synchronous").get().synchronous);
  const allowedSynchronous = expectations.allowedSynchronous ?? [1, 2, 3];
  if (!allowedSynchronous.includes(synchronous)) {
    violations.push(`synchronous mode ${synchronous} is not in the declared set [${allowedSynchronous.join(", ")}]`);
  }
  return violations;
}

// src/shared/sqlite-helpers.ts
function closeQuietly(db) {
  if (!db)
    return;
  try {
    db.close();
  } catch {}
}

// src/hooks/magic-context/read-session-db.ts
function getOpenCodeDbPath() {
  return join(getDataDir(), "opencode", "opencode.db");
}
function openCodeDbExists() {
  return existsSync(getOpenCodeDbPath());
}
var cachedReadOnlyDb = null;
function closeCachedReadOnlyDb() {
  if (!cachedReadOnlyDb) {
    return;
  }
  try {
    closeQuietly(cachedReadOnlyDb.db);
  } catch (error) {
    log("[magic-context] failed to close cached OpenCode read-only DB:", error);
  } finally {
    cachedReadOnlyDb = null;
  }
}
function getReadOnlySessionDb() {
  const dbPath = getOpenCodeDbPath();
  if (cachedReadOnlyDb?.path === dbPath) {
    return cachedReadOnlyDb.db;
  }
  closeCachedReadOnlyDb();
  const db = new Database(dbPath, { readonly: true });
  cachedReadOnlyDb = { path: dbPath, db };
  return db;
}
function withReadOnlySessionDb(fn) {
  return fn(getReadOnlySessionDb());
}
function getRawSessionMessageCountFromDb(db, sessionId) {
  const row = db.prepare(`SELECT COUNT(*) as count FROM message WHERE session_id = ?
             AND NOT (COALESCE(json_extract(data, '$.summary'), 0) = 1
                      AND COALESCE(json_extract(data, '$.finish'), '') = 'stop')`).get(sessionId);
  return typeof row?.count === "number" ? row.count : 0;
}
function isMidTurn(_deps, sessionId) {
  try {
    return withReadOnlySessionDb((db) => isMidTurnFromOpenCodeDb(db, sessionId));
  } catch (error) {
    log("[magic-context] failed to inspect OpenCode mid-turn state:", error);
    return false;
  }
}
function isMidTurnFromOpenCodeDb(db, sessionId) {
  const latestAssistant = db.prepare(`SELECT id,
                    json_extract(data, '$.finish') as finish,
                    time_created as timeCreated
             FROM message
             WHERE session_id = ?
               AND json_extract(data, '$.role') = 'assistant'
             ORDER BY time_created DESC
             LIMIT 1`).get(sessionId);
  if (typeof latestAssistant?.id !== "string")
    return false;
  if (hasNewerRealUserMessage(db, sessionId, latestAssistant.timeCreated))
    return false;
  if (latestAssistant.finish === "tool-calls")
    return true;
  const partRows = db.prepare("SELECT data FROM part WHERE session_id = ? AND message_id = ?").all(sessionId, latestAssistant.id);
  return partRows.some((row) => {
    if (typeof row.data !== "string" || row.data.length === 0)
      return false;
    try {
      const part = JSON.parse(row.data);
      return part.type === "tool" && part.providerExecuted !== true;
    } catch {
      return false;
    }
  });
}
function hasNewerRealUserMessage(db, sessionId, latestAssistantTimeCreated) {
  if (typeof latestAssistantTimeCreated !== "number")
    return false;
  const row = db.prepare(`SELECT 1 as one
             FROM message m
             WHERE m.session_id = ?
               AND m.time_created > ?
               AND json_extract(m.data, '$.role') = 'user'
               AND NOT (
                 EXISTS (SELECT 1 FROM part p WHERE p.message_id = m.id)
                 AND NOT EXISTS (
                   SELECT 1 FROM part p
                   WHERE p.message_id = m.id
                     AND COALESCE(json_extract(p.data, '$.synthetic'), 0) NOT IN (1, 'true')
                     AND json_extract(p.data, '$.metadata.marker.kind') IS NULL
                     AND COALESCE(json_extract(p.data, '$.ignored'), 0) NOT IN (1, 'true')
                 )
               )
             LIMIT 1`).get(sessionId, latestAssistantTimeCreated);
  return row?.one === 1;
}
function getMessageTimesFromOpenCodeDb(sessionId, messageIds) {
  const result = new Map;
  if (messageIds.length === 0)
    return result;
  try {
    withReadOnlySessionDb((db) => {
      const placeholders = messageIds.map(() => "?").join(",");
      const rows = db.prepare(`SELECT id, time_created FROM message WHERE session_id = ? AND id IN (${placeholders})`).all(sessionId, ...messageIds);
      for (const row of rows) {
        if (typeof row.id === "string" && typeof row.time_created === "number") {
          result.set(row.id, row.time_created);
        }
      }
    });
  } catch (error) {
    log("[magic-context] failed to resolve message times from OpenCode DB:", error);
  }
  return result;
}
function findLastAssistantModelFromOpenCodeDb(sessionId) {
  try {
    return withReadOnlySessionDb((db) => {
      const row = db.prepare(`SELECT json_extract(data, '$.providerID') as providerID,
                            json_extract(data, '$.modelID') as modelID,
                            json_extract(data, '$.agent') as agent
                     FROM message
                     WHERE session_id = ?
                       AND json_extract(data, '$.role') = 'assistant'
                       AND json_extract(data, '$.providerID') IS NOT NULL
                       AND json_extract(data, '$.modelID') IS NOT NULL
                     ORDER BY time_created DESC
                     LIMIT 1`).get(sessionId);
      if (!row || typeof row.providerID !== "string" || typeof row.modelID !== "string") {
        return null;
      }
      const agent = typeof row.agent === "string" && row.agent.length > 0 ? row.agent : undefined;
      return {
        providerID: row.providerID,
        modelID: row.modelID,
        ...agent ? { agent } : {}
      };
    });
  } catch (error) {
    log("[magic-context] failed to recover live model from OpenCode DB:", error);
    return null;
  }
}

export { Database, isInTransaction, withPrivilegedWriter, evaluateSqliteRuntimeGate, collectSqliteRuntimeGateInput, verifySqliteConnectionContract, closeQuietly, openCodeDbExists, withReadOnlySessionDb, getRawSessionMessageCountFromDb, isMidTurn, getMessageTimesFromOpenCodeDb, findLastAssistantModelFromOpenCodeDb };
