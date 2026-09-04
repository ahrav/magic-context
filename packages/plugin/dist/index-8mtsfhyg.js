// src/shared/jsonc-parser.ts
import { existsSync, readFileSync } from "node:fs";
function stripJsonComments(content) {
  let result = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0;index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (inLineComment) {
      if (char === `
`) {
        inLineComment = false;
        result += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    result += char;
  }
  return result;
}
function stripTrailingCommas(content) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0;index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < content.length && /\s/.test(content[lookahead] ?? "")) {
        lookahead += 1;
      }
      const next = content[lookahead];
      if (next === "}" || next === "]") {
        continue;
      }
    }
    result += char;
  }
  return result;
}
var PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function isPrototypePollutionKey(key) {
  return PROTOTYPE_POLLUTION_KEYS.has(key);
}
function sanitizeParsedJson(value, options = {}, path = []) {
  if (Array.isArray(value)) {
    return value.map((entry, index) => sanitizeParsedJson(entry, options, [...path, index]));
  }
  if (value === null || typeof value !== "object")
    return value;
  const source = value;
  const sourcePrototype = Object.getPrototypeOf(source);
  if (sourcePrototype !== null && sourcePrototype !== Object.prototype) {
    options.onRejectedKey?.([...path, "__proto__"]);
  }
  const sanitized = {};
  for (const key of Object.keys(source)) {
    if (isPrototypePollutionKey(key)) {
      options.onRejectedKey?.([...path, key]);
      continue;
    }
    Object.defineProperty(sanitized, key, {
      value: sanitizeParsedJson(source[key], options, [...path, key]),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return sanitized;
}
function parseJsonc(content, options = {}) {
  const normalized = stripTrailingCommas(stripJsonComments(content));
  return sanitizeParsedJson(JSON.parse(normalized), options);
}
function readJsoncFile(filePath) {
  try {
    return parseJsonc(readFileSync(filePath, "utf-8"));
  } catch (_error) {
    return null;
  }
}
function detectConfigFile(basePath) {
  const jsoncPath = `${basePath}.jsonc`;
  const jsonPath = `${basePath}.json`;
  if (existsSync(jsoncPath)) {
    return { format: "jsonc", path: jsoncPath };
  }
  if (existsSync(jsonPath)) {
    return { format: "json", path: jsonPath };
  }
  return { format: "none", path: jsoncPath };
}

export { stripJsonComments, isPrototypePollutionKey, parseJsonc, readJsoncFile, detectConfigFile };
