import {
  getMagicContextLogPath
} from "./index-p5d8sma0.js";

// src/shared/logger.ts
import * as fs from "node:fs";
import * as path from "node:path";
var isTestEnv = false;
var buffer = [];
var flushTimer = null;
var FLUSH_INTERVAL_MS = 500;
var BUFFER_SIZE_LIMIT = 50;
var swallowedWriteCount = 0;
var lastErrorMessage = null;
var lastErrorTime = null;
function recordSwallowedWrite(error) {
  try {
    swallowedWriteCount++;
    lastErrorMessage = error instanceof Error ? error.message : String(error);
    lastErrorTime = new Date().toISOString();
  } catch {}
}
function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0)
    return;
  const data = buffer.join("");
  buffer = [];
  try {
    const logFile = getMagicContextLogPath();
    ensureDir(logFile);
    fs.appendFileSync(logFile, data);
  } catch (error) {
    recordSwallowedWrite(error);
  }
}
function scheduleFlush() {
  if (flushTimer)
    return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_INTERVAL_MS);
}
function log(message, data) {
  if (isTestEnv)
    return;
  try {
    const timestamp = new Date().toISOString();
    const serialized = data === undefined ? "" : data instanceof Error ? ` ${data.message}${data.stack ? `
${data.stack}` : ""}` : ` ${JSON.stringify(data)}`;
    buffer.push(`[${timestamp}] ${message}${serialized}
`);
    if (buffer.length >= BUFFER_SIZE_LIMIT) {
      flush();
    } else {
      scheduleFlush();
    }
  } catch {}
}
function sessionLog(sessionId, message, data) {
  log(`[magic-context][${sessionId}] ${message}`, data);
}
function getLoggerDiagnostics() {
  return {
    swallowedWriteCount,
    lastErrorMessage,
    lastErrorTime
  };
}
if (!isTestEnv) {
  process.on("exit", flush);
}

export { log, sessionLog, getLoggerDiagnostics };
