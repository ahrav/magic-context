import {
  modelRefLookupOrder
} from "./index-cgyfn1s2.js";
import {
  sessionLog
} from "./index-rjbc1j54.js";
import {
  getDataDir,
  getHarness,
  getMagicContextStorageDir
} from "./index-p5d8sma0.js";

// src/shared/models-dev-cache.ts
import { mkdirSync, readFileSync as readFileSync2, renameSync, writeFileSync } from "node:fs";
import { join as join2 } from "node:path";

// src/shared/storage-permissions.ts
var enforcePrivateStoragePermissions = true;
function setStoragePrivatePermissionEnforcement(enforce) {
  enforcePrivateStoragePermissions = enforce;
}
function shouldEnforcePrivateStoragePermissions() {
  return enforcePrivateStoragePermissions;
}

// src/shared/window-geometry.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
var WINDOW_OVERLAY_SCHEMA = "fusiform-window-overlay/v1";
var PROMPT_WALL_MARGIN = 4096;
var PI_OUTPUT_FLOOR = 4096;
var OPENCODE_OUTPUT_CAP = 32000;
var MIN_PLAUSIBLE_CONTEXT_LIMIT = 1024;
var OUTPUT_RESERVE_CAP_RATIO = 0.25;
var PROVIDER_GEOMETRY = {
  anthropic: "shared_truncating",
  xai: "shared_truncating",
  google: "separate",
  "google-antigravity": "separate"
};
var GRADES = new Set([
  "provider_asserted_runtime",
  "measured",
  "provider_asserted_doc",
  "catalog",
  "unknown"
]);
var UNITS = new Set(["provider", "estimate"]);
var BOUNDARIES = new Set(["Observed", "Asserted", "Corrected"]);
var UNKNOWN_REASONS = new Set([
  "placeholder_output_equals_context",
  "placeholder_zero",
  "never_measured",
  "not_single_valued_at_key",
  "retracted"
]);
var NUMERIC_FACT_KEYS = new Set([
  "window.advertised",
  "window.enforced",
  "output.advertised",
  "output.enforced",
  "output.default"
]);
var configuredOverlayPath;
var loadedOverlayPath;
var loadedOverlay;
var geometryClampLogSeen = new Set;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFinitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function scalarizeFact(value) {
  if (value.kind === "stated")
    return isFinitePositive(value.value) ? value.value : undefined;
  if (value.kind === "bracket") {
    return isFinitePositive(value.at_least) ? value.at_least : undefined;
  }
  return;
}
function parseFactValue(value) {
  if (!isRecord(value) || typeof value.kind !== "string")
    return;
  if (value.kind === "stated") {
    if ((typeof value.value !== "number" || !Number.isFinite(value.value)) && typeof value.value !== "string") {
      return;
    }
    return { kind: "stated", value: value.value };
  }
  if (value.kind === "bracket") {
    const atLeast = value.at_least;
    const below = value.below;
    if (atLeast === undefined && below === undefined)
      return { kind: "bracket" };
    if (atLeast !== undefined && !isFinitePositive(atLeast))
      return;
    if (below !== undefined && !isFinitePositive(below))
      return;
    if (isFinitePositive(atLeast) && isFinitePositive(below) && below <= atLeast) {
      return;
    }
    return {
      kind: "bracket",
      ...isFinitePositive(atLeast) ? { at_least: atLeast } : {},
      ...isFinitePositive(below) ? { below } : {}
    };
  }
  if (value.kind === "unknown" && UNKNOWN_REASONS.has(value.why)) {
    return { kind: "unknown", why: value.why };
  }
  return;
}
function parseFact(key, value) {
  if (!isRecord(value))
    return;
  const parsedValue = parseFactValue(value.value);
  if (!parsedValue || !GRADES.has(value.grade) || !UNITS.has(value.units) || !BOUNDARIES.has(value.boundary) || typeof value.source_ref !== "string" || value.source_ref.length === 0 || typeof value.observed_at !== "string" || value.observed_at.length === 0) {
    return;
  }
  if (NUMERIC_FACT_KEYS.has(key) && parsedValue.kind === "stated" && !isFinitePositive(parsedValue.value)) {
    return;
  }
  if (key === "geometry" && parsedValue.kind === "stated" && !["shared_upfront", "shared_truncating", "separate"].includes(String(parsedValue.value))) {
    return;
  }
  return {
    ...value,
    value: parsedValue,
    grade: value.grade,
    units: value.units,
    boundary: value.boundary,
    source_ref: value.source_ref,
    observed_at: value.observed_at
  };
}
function parseWindowOverlay(value) {
  if (!isRecord(value)) {
    return { badCells: 0, refusal: "overlay root is not an object" };
  }
  if (value.schema !== WINDOW_OVERLAY_SCHEMA) {
    return {
      badCells: 0,
      refusal: `unrecognized schema ${JSON.stringify(value.schema)}`
    };
  }
  if (typeof value.generated_at !== "string" || !Array.isArray(value.minted_provider_ids) || !value.minted_provider_ids.every((id) => typeof id === "string" && id.length > 0) || !Array.isArray(value.cells)) {
    return { badCells: 0, refusal: "invalid v1 envelope" };
  }
  const cells = [];
  let badCells = 0;
  for (const rawCell of value.cells) {
    if (!isRecord(rawCell) || typeof rawCell.provider_id !== "string" || rawCell.provider_id.length === 0 || typeof rawCell.model_id !== "string" || rawCell.model_id.length === 0 || !isRecord(rawCell.facts)) {
      badCells++;
      continue;
    }
    const facts = {};
    let valid = true;
    for (const [key, rawFact] of Object.entries(rawCell.facts)) {
      const fact = parseFact(key, rawFact);
      if (!fact) {
        valid = false;
        break;
      }
      facts[key] = fact;
    }
    if (!valid) {
      badCells++;
      continue;
    }
    cells.push({
      provider_id: rawCell.provider_id,
      model_id: rawCell.model_id,
      facts
    });
  }
  return {
    overlay: {
      schema: WINDOW_OVERLAY_SCHEMA,
      generated_at: value.generated_at,
      minted_provider_ids: [...value.minted_provider_ids],
      cells
    },
    badCells
  };
}
function defaultWindowOverlayPath() {
  return join(getDataDir(), "fusiform", "window-overlay.json");
}
function readWindowOverlayFile(path, log = (message) => sessionLog("global", message)) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT")
      return;
    log(`window-overlay: unable to read ${path}; overlay ignored`);
    return;
  }
  let decoded;
  try {
    decoded = JSON.parse(raw);
  } catch {
    log(`window-overlay: invalid JSON in ${path}; overlay ignored`);
    return;
  }
  const parsed = parseWindowOverlay(decoded);
  if (parsed.refusal) {
    log(`window-overlay: ${parsed.refusal} in ${path}; entire overlay ignored`);
    return;
  }
  if (parsed.badCells > 0) {
    log(`window-overlay: skipped ${parsed.badCells} invalid cell(s) from ${path}`);
  }
  return parsed.overlay;
}
function setWindowOverlayPath(path) {
  configuredOverlayPath = path;
  loadedOverlayPath = undefined;
  loadedOverlay = undefined;
}
function getWindowOverlay() {
  const path = configuredOverlayPath ?? defaultWindowOverlayPath();
  if (loadedOverlayPath === path && loadedOverlay !== undefined) {
    return loadedOverlay ?? undefined;
  }
  loadedOverlayPath = path;
  loadedOverlay = readWindowOverlayFile(path) ?? null;
  return loadedOverlay ?? undefined;
}
function resolveWindowOverlayFacts(providerID, modelID, overlay = getWindowOverlay()) {
  if (!overlay)
    return;
  const modelRefs = modelRefLookupOrder(`${providerID}/${modelID}`);
  const providerCandidates = new Set(modelRefs.map((ref) => ref.slice(0, ref.indexOf("/"))));
  const modelCandidates = new Set([
    modelID,
    ...modelRefs.map((ref) => ref.slice(ref.indexOf("/") + 1))
  ]);
  const colon = modelID.lastIndexOf(":");
  if (colon > 0)
    modelCandidates.add(modelID.slice(0, colon));
  const wildcardFacts = {};
  const specificFacts = {};
  for (const cell of overlay.cells) {
    if (!providerCandidates.has(cell.provider_id))
      continue;
    if (cell.model_id === "*")
      Object.assign(wildcardFacts, cell.facts);
    else if (modelCandidates.has(cell.model_id))
      Object.assign(specificFacts, cell.facts);
  }
  const facts = { ...wildcardFacts, ...specificFacts };
  return Object.keys(facts).length > 0 ? { facts } : undefined;
}
function numericOverlayFact(overlay, key) {
  const fact = overlay?.facts[key];
  return fact ? scalarizeFact(fact.value) : undefined;
}
function overlayGeometry(overlay) {
  const fact = overlay?.facts.geometry;
  if (fact === undefined)
    return;
  if (fact.value.kind === "unknown")
    return { kind: "unknown" };
  if (fact.value.kind !== "stated")
    return;
  const value = fact.value.value;
  return value === "shared_upfront" || value === "shared_truncating" || value === "separate" ? { kind: "stated", value } : undefined;
}
function placeholderFilteredOutput(output, context) {
  if (!isFinitePositive(output))
    return;
  if (isFinitePositive(context) && output >= context)
    return;
  return output;
}
function mergePositive(overlayValue, providerValue) {
  return isFinitePositive(providerValue) ? providerValue : overlayValue;
}
function logGeometryClampOnce(key, message, log) {
  if (geometryClampLogSeen.has(key))
    return;
  geometryClampLogSeen.add(key);
  (log ?? ((entry) => sessionLog("global", `window-geometry: ${entry}`)))(message);
}
function deriveWindowGeometry(providerID, modelID, catalogLimit, options = {}) {
  if (!catalogLimit && !options.providerLimit)
    return;
  const providerLimit = options.providerLimit;
  const catalogContext = isFinitePositive(catalogLimit?.context) ? catalogLimit.context : undefined;
  const advertised = numericOverlayFact(options.overlay, "window.advertised");
  const enforced = numericOverlayFact(options.overlay, "window.enforced");
  let softContext = mergePositive(enforced ?? advertised ?? catalogContext, providerLimit?.context);
  let hardContext = mergePositive(enforced ?? softContext, providerLimit?.context);
  if (isFinitePositive(options.contextCap)) {
    softContext = isFinitePositive(softContext) ? Math.min(softContext, options.contextCap) : options.contextCap;
    hardContext = isFinitePositive(hardContext) ? Math.min(hardContext, options.contextCap) : options.contextCap;
  }
  const input = mergePositive(isFinitePositive(catalogLimit?.input) ? catalogLimit.input : undefined, providerLimit?.input);
  if (!isFinitePositive(softContext) && !isFinitePositive(input))
    return;
  const catalogOutput = options.overlay === undefined && options.providerLimit === undefined ? isFinitePositive(catalogLimit?.output) ? catalogLimit.output : undefined : placeholderFilteredOutput(catalogLimit?.output, softContext);
  const overlayOutput = placeholderFilteredOutput(numericOverlayFact(options.overlay, "output.enforced") ?? numericOverlayFact(options.overlay, "output.default") ?? numericOverlayFact(options.overlay, "output.advertised"), softContext);
  const providerOutput = placeholderFilteredOutput(providerLimit?.output, softContext);
  const output = providerOutput ?? overlayOutput ?? catalogOutput;
  const geometryFact = overlayGeometry(options.overlay);
  const geometry = geometryFact?.kind === "stated" ? geometryFact.value : geometryFact?.kind === "unknown" ? "shared_upfront" : PROVIDER_GEOMETRY[providerID] ?? "shared_upfront";
  const geometryOverride = geometryFact?.kind === "stated" ? geometryFact.value : undefined;
  const preCarvedInput = isFinitePositive(input) && (!isFinitePositive(softContext) || input < softContext);
  const outputReserveOverride = typeof options.outputReserveOverride === "number" && Number.isFinite(options.outputReserveOverride) && options.outputReserveOverride >= 0 ? options.outputReserveOverride : undefined;
  let derivationWindow = softContext ?? input;
  let usableSoft;
  let softReserve = 0;
  let reserveSource = "none";
  if (outputReserveOverride !== undefined) {
    const reserveWindow = preCarvedInput ? input : softContext ?? input;
    if (!isFinitePositive(reserveWindow))
      return;
    derivationWindow = reserveWindow;
    softReserve = outputReserveOverride;
    reserveSource = "output_config";
    const floor = Math.max(MIN_PLAUSIBLE_CONTEXT_LIMIT, reserveWindow * 0.5);
    const flooredReserve = Math.min(softReserve, Math.max(0, reserveWindow - floor));
    if (flooredReserve < softReserve) {
      logGeometryClampOnce(`soft-floor|${providerID}/${modelID}|${softReserve}|${flooredReserve}`, `output reserve clamped by the half-window floor for ${providerID}/${modelID}: reserve ${softReserve} → ${flooredReserve}`, options.log);
    }
    softReserve = flooredReserve;
    usableSoft = Math.floor(reserveWindow - softReserve);
  } else if (preCarvedInput) {
    usableSoft = input;
    if (isFinitePositive(softContext)) {
      softReserve = Math.max(0, softContext - input);
      reserveSource = "output_catalog";
    }
  } else if (isFinitePositive(softContext)) {
    if (geometry === "separate" && (options.overlay === undefined || options.harness === "pi" || geometryOverride !== undefined)) {
      softReserve = 0;
      reserveSource = "none";
    } else {
      softReserve = output ?? 0;
      reserveSource = output === undefined ? "none" : "output_catalog";
      const cap = softContext * OUTPUT_RESERVE_CAP_RATIO;
      softReserve = Math.min(softReserve, options.harness === "pi" || options.overlay === undefined ? cap : Math.min(cap, OPENCODE_OUTPUT_CAP));
    }
    const floor = Math.max(MIN_PLAUSIBLE_CONTEXT_LIMIT, softContext * 0.5);
    const flooredReserve = Math.min(softReserve, Math.max(0, softContext - floor));
    if (flooredReserve < softReserve) {
      logGeometryClampOnce(`soft-floor|${providerID}/${modelID}|${softReserve}|${flooredReserve}`, `output reserve clamped by the half-window floor for ${providerID}/${modelID}: reserve ${softReserve} → ${flooredReserve} (catalog context/output pair is contradictory)`, options.log);
    }
    softReserve = flooredReserve;
    usableSoft = Math.floor(softContext - softReserve);
  } else {
    usableSoft = input;
  }
  const hardWindow = hardContext ?? softContext ?? input;
  if (!isFinitePositive(hardWindow))
    return;
  let usableHard;
  if (geometry === "separate") {
    usableHard = hardWindow;
  } else if (geometry === "shared_truncating") {
    usableHard = hardWindow - PROMPT_WALL_MARGIN;
  } else if (options.harness === "pi" && providerID !== "openai-codex") {
    usableHard = hardWindow - PI_OUTPUT_FLOOR;
  } else if (options.harness === "pi") {
    usableHard = hardWindow - (output ?? OPENCODE_OUTPUT_CAP);
  } else {
    const requestedOutput = Math.min(output ?? OPENCODE_OUTPUT_CAP, OPENCODE_OUTPUT_CAP);
    usableHard = hardWindow - requestedOutput;
  }
  usableHard = Math.max(MIN_PLAUSIBLE_CONTEXT_LIMIT, Math.floor(usableHard));
  if (usableHard < usableSoft) {
    logGeometryClampOnce(`${providerID}/${modelID}|${usableSoft}|${usableHard}`, `usable hard limit clamped for ${providerID}/${modelID}: ${usableHard} → ${usableSoft} (overlay/provider inversion)`, options.log);
    usableHard = usableSoft;
  }
  const resolvedWindow = derivationWindow ?? usableSoft;
  return {
    usableSoft,
    usableHard,
    geometry,
    derivation: {
      window: Math.floor(resolvedWindow),
      reserve: Math.floor(Math.max(0, resolvedWindow - usableSoft)),
      reserveSource,
      geometry
    }
  };
}
function formatWindowDerivationLine(inputTokens, result) {
  const percentage = result.usableSoft > 0 ? inputTokens / result.usableSoft * 100 : 0;
  const reserveLabel = result.derivation.reserveSource === "wall_margin" ? "wall margin" : result.derivation.reserveSource === "none" ? "reserve" : "output reserve";
  return `Context: ${formatCompactTokens(inputTokens)} / ${formatCompactTokens(result.usableSoft)} usable (${percentage.toFixed(1)}%) — window ${formatCompactTokens(result.derivation.window)} − ${formatCompactTokens(result.derivation.reserve)} ${reserveLabel} [${result.geometry}]`;
}
function formatCompactTokens(value) {
  if (Math.abs(value) >= 1e6) {
    return `${(value / 1e6).toFixed(1).replace(/\.0$/, "")}m`;
  }
  if (Math.abs(value) >= 1000) {
    return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return Math.round(value).toLocaleString();
}

// src/shared/models-dev-cache.ts
var MIN_SANE_LIMIT = 20000;
var MAX_SANE_LIMIT = 3000000;
function isSaneLimit(limit) {
  return typeof limit === "number" && limit >= MIN_SANE_LIMIT && limit <= MAX_SANE_LIMIT;
}
var SEPARATE_OUTPUT_QUOTA_PROVIDERS = new Set(["google", "google-antigravity"]);
var MIN_PLAUSIBLE_CONTEXT_LIMIT2 = 1024;
var OUTPUT_RESERVE_CAP_RATIO2 = 0.25;
var outputReserveConfig;
var reserveClampLogSeen = new Set;
var apiCache = null;
var apiLoadedAt = 0;
var persistSeedLoaded = false;
function persistFilePath() {
  return join2(getMagicContextStorageDir(), `model-context-limits-${getHarness()}.json`);
}
function loadPersistedApiCacheOnce() {
  if (persistSeedLoaded || apiCache !== null)
    return;
  persistSeedLoaded = true;
  try {
    const raw = readFileSync2(persistFilePath(), "utf-8");
    const obj = JSON.parse(raw);
    const map = new Map;
    for (const [key, persisted] of Object.entries(obj)) {
      const limit = typeof persisted === "number" ? persisted : persisted.limit;
      const contextLimit = typeof persisted === "number" ? undefined : persisted.contextLimit;
      const inputLimit = typeof persisted === "number" ? undefined : persisted.inputLimit;
      const outputLimit = typeof persisted === "number" ? undefined : persisted.outputLimit;
      const vision = typeof persisted === "number" ? false : persisted.vision === true;
      if (isSaneLimit(contextLimit) || isSaneLimit(limit)) {
        map.set(key, {
          limit: isSaneLimit(limit) ? limit : undefined,
          contextLimit: isSaneLimit(contextLimit) ? contextLimit : undefined,
          inputLimit: isSaneLimit(inputLimit) ? inputLimit : undefined,
          outputLimit: isFinitePositive2(outputLimit) ? outputLimit : undefined,
          vision
        });
      }
    }
    if (map.size > 0) {
      apiCache = map;
      sessionLog("global", `models-dev-cache: seeded ${map.size} entries from persisted cache (cold start)`);
    }
  } catch {}
}
function persistApiCache() {
  if (!apiCache)
    return;
  const obj = {};
  for (const [key, value] of apiCache) {
    if (isSaneLimit(value.limit)) {
      obj[key] = {
        limit: value.limit,
        contextLimit: isSaneLimit(value.contextLimit) ? value.contextLimit : undefined,
        inputLimit: isSaneLimit(value.inputLimit) ? value.inputLimit : undefined,
        outputLimit: isFinitePositive2(value.outputLimit) ? value.outputLimit : undefined,
        vision: value.vision === true
      };
    }
  }
  try {
    const dir = getMagicContextStorageDir();
    mkdirSync(dir, { recursive: true });
    const target = persistFilePath();
    const tmp = `${target}.${process.pid}.tmp`;
    if (shouldEnforcePrivateStoragePermissions()) {
      writeFileSync(tmp, JSON.stringify(obj), { encoding: "utf-8", mode: 384 });
    } else {
      writeFileSync(tmp, JSON.stringify(obj), { encoding: "utf-8" });
    }
    renameSync(tmp, target);
  } catch {}
}
function isFinitePositive2(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function modelKeyLookupOrder(providerID, modelID) {
  const candidates = [...modelRefLookupOrder(`${providerID}/${modelID}`), modelID];
  const colon = modelID.lastIndexOf(":");
  if (colon > 0) {
    const bareModel = modelID.slice(0, colon);
    candidates.push(...modelRefLookupOrder(`${providerID}/${bareModel}`), bareModel);
  }
  return [...new Set(candidates)];
}
function resolveOutputReserve(providerID, modelID, config = outputReserveConfig) {
  if (typeof config === "number")
    return Number.isFinite(config) && config >= 0 ? config : undefined;
  if (!config)
    return;
  for (const candidate of modelKeyLookupOrder(providerID, modelID)) {
    const value = config[candidate];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      return value;
  }
  return Number.isFinite(config.default) && config.default >= 0 ? config.default : undefined;
}
function logReserveClampOnce(key, message) {
  if (reserveClampLogSeen.has(key))
    return;
  reserveClampLogSeen.add(key);
  sessionLog("global", `models-dev-cache: ${message}`);
}
function setOutputReserveConfig(config) {
  outputReserveConfig = config;
}
function resolveLimit(limit, providerID, modelID, reserveConfig = outputReserveConfig) {
  if (!limit)
    return;
  const context = isFinitePositive2(limit.context) ? limit.context : undefined;
  const input = isFinitePositive2(limit.input) ? limit.input : undefined;
  if (input !== undefined && (context === undefined || input < context))
    return input;
  if (context === undefined)
    return;
  const configuredReserve = resolveOutputReserve(providerID, modelID, reserveConfig);
  let reserve;
  if (configuredReserve !== undefined) {
    reserve = configuredReserve;
  } else if (SEPARATE_OUTPUT_QUOTA_PROVIDERS.has(providerID)) {
    reserve = 0;
  } else {
    const output = isFinitePositive2(limit.output) ? limit.output : 0;
    const cap = context * OUTPUT_RESERVE_CAP_RATIO2;
    reserve = Math.min(output, cap);
    if (output > cap) {
      logReserveClampOnce(`cap|${providerID}/${modelID}|${context}|${output}`, `output reserve capped at 25% for ${providerID}/${modelID}: ${output} → ${cap}`);
    }
  }
  const floor = Math.max(MIN_PLAUSIBLE_CONTEXT_LIMIT2, context * 0.5);
  const maxReserve = Math.max(0, context - floor);
  if (reserve > maxReserve) {
    logReserveClampOnce(`floor|${providerID}/${modelID}|${context}|${reserve}`, `output reserve clamped for ${providerID}/${modelID}: ${reserve} → ${maxReserve} (usable floor ${floor})`);
    reserve = maxReserve;
  }
  return Math.floor(context - reserve);
}
function setCachedModelMetadata(cache, key, model) {
  const contextLimit = model?.limit?.context;
  const inputLimit = model?.limit?.input;
  const outputLimit = model?.limit?.output;
  const rawLimit = isSaneLimit(contextLimit) ? contextLimit : isSaneLimit(inputLimit) ? inputLimit : undefined;
  if (rawLimit === undefined)
    return;
  const values = [model?.capabilities, model?.modalities, model?.input, model?.attachment];
  const vision = values.some((value2) => JSON.stringify(value2 ?? "").toLowerCase().includes("image") || JSON.stringify(value2 ?? "").toLowerCase().includes("vision"));
  const value = {
    limit: rawLimit,
    contextLimit: isSaneLimit(contextLimit) ? contextLimit : undefined,
    inputLimit: isSaneLimit(inputLimit) ? inputLimit : undefined,
    outputLimit: isFinitePositive2(outputLimit) ? outputLimit : undefined,
    vision
  };
  cache.set(key, value);
  const modes = model?.experimental?.modes;
  if (modes && typeof modes === "object") {
    for (const mode of Object.keys(modes)) {
      cache.set(`${key}-${mode}`, value);
    }
  }
}
async function refreshModelLimitsFromApi(client, options) {
  const attempts = Math.max(1, (options?.retries ?? 0) + 1);
  const delayMs = options?.retryDelayMs ?? 1000;
  for (let attempt = 1;attempt <= attempts; attempt++) {
    const ok = await refreshModelLimitsOnce(client);
    if (ok)
      return;
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
var authRewarmDone = false;
async function refreshModelLimitsAfterAuthOnce(client) {
  if (authRewarmDone)
    return;
  authRewarmDone = true;
  const ok = await refreshModelLimitsOnce(client);
  if (!ok)
    authRewarmDone = false;
}
async function refreshModelLimitsOnce(client) {
  try {
    const result = await client.config.providers();
    const data = result.data;
    const providers = data?.providers;
    if (!Array.isArray(providers) || providers.length === 0) {
      sessionLog("global", "models-dev-cache: API refresh returned no providers payload (will retry if attempts remain)");
      return false;
    }
    const map = new Map;
    for (const entry of providers) {
      const p = entry;
      if (!p?.id || !p.models || typeof p.models !== "object")
        continue;
      for (const [modelId, model] of Object.entries(p.models)) {
        setCachedModelMetadata(map, `${p.id}/${modelId}`, model);
      }
    }
    const previousSize = apiCache?.size ?? null;
    apiCache = map;
    apiLoadedAt = Date.now();
    persistApiCache();
    if (previousSize === null) {
      sessionLog("global", `models-dev-cache: API layer loaded ${map.size} model metadata entries`);
    } else if (previousSize !== map.size) {
      sessionLog("global", `models-dev-cache: API layer loaded ${map.size} model metadata entries (was ${previousSize})`);
    }
    return true;
  } catch (error) {
    sessionLog("global", "models-dev-cache: API refresh failed:", error instanceof Error ? error.message : String(error));
    return false;
  }
}
function getSdkWindowGeometry(providerID, modelID, detectedContextLimit, options) {
  loadPersistedApiCacheOnce();
  const metadata = lookupMetadataWithTagFallback(apiCache, providerID, modelID);
  if (!metadata)
    return;
  const rawContext = metadata.contextLimit ?? metadata.limit;
  const promptOnlyDetected = options?.detectedLimitProvenance === "prompt_only" && isFinitePositive2(detectedContextLimit) ? detectedContextLimit : undefined;
  const result = deriveWindowGeometry(providerID, modelID, {
    context: rawContext,
    input: metadata.inputLimit,
    output: metadata.outputLimit
  }, {
    overlay: resolveWindowOverlayFacts(providerID, modelID, getWindowOverlay()),
    outputReserveOverride: resolveOutputReserve(providerID, modelID),
    harness: options?.harness ?? "opencode",
    contextCap: promptOnlyDetected === undefined && isFinitePositive2(detectedContextLimit) ? detectedContextLimit : undefined
  });
  if (!result || promptOnlyDetected === undefined)
    return result;
  const usableSoft = promptOnlyDetected;
  return {
    ...result,
    usableSoft,
    usableHard: Math.max(usableSoft, Math.min(result.usableHard, promptOnlyDetected))
  };
}
function getSdkContextLimit(providerID, modelID, detectedContextLimit, options) {
  if (options?.reservation !== "none") {
    return getSdkWindowGeometry(providerID, modelID, detectedContextLimit, {
      detectedLimitProvenance: options?.detectedLimitProvenance
    })?.usableSoft;
  }
  loadPersistedApiCacheOnce();
  const metadata = lookupMetadataWithTagFallback(apiCache, providerID, modelID);
  if (!metadata)
    return;
  const rawContext = metadata.contextLimit ?? metadata.limit;
  const promptOnlyDetected = options?.detectedLimitProvenance === "prompt_only" && isFinitePositive2(detectedContextLimit) ? detectedContextLimit : undefined;
  const context = promptOnlyDetected === undefined && isFinitePositive2(detectedContextLimit) && isFinitePositive2(rawContext) ? Math.min(rawContext, detectedContextLimit) : promptOnlyDetected === undefined && isFinitePositive2(detectedContextLimit) ? detectedContextLimit : rawContext;
  const inputCandidates = [metadata.inputLimit, promptOnlyDetected].filter(isFinitePositive2);
  const input = inputCandidates.length > 0 ? Math.min(...inputCandidates) : undefined;
  return resolveLimit({
    context,
    input,
    output: metadata.outputLimit
  }, providerID, modelID, options?.reservation === "none" ? 0 : undefined);
}
function modelSupportsVision(providerID, modelID) {
  loadPersistedApiCacheOnce();
  if (!apiCache)
    return false;
  const exact = apiCache.get(`${providerID}/${modelID}`);
  if (exact?.vision === true)
    return true;
  const colon = modelID.lastIndexOf(":");
  return colon > 0 ? apiCache.get(`${providerID}/${modelID.slice(0, colon)}`)?.vision === true : false;
}
function lookupMetadataWithTagFallback(cache, providerID, modelID) {
  if (!cache)
    return;
  const exact = cache.get(`${providerID}/${modelID}`);
  if (exact)
    return exact;
  const colonIdx = modelID.lastIndexOf(":");
  if (colonIdx > 0) {
    return cache.get(`${providerID}/${modelID.slice(0, colonIdx)}`);
  }
  return;
}

// src/hooks/magic-context/derive-budgets.ts
var TRIGGER_BUDGET_PERCENTAGE = 0.05;
var TRIGGER_BUDGET_MIN = 5000;
var TRIGGER_BUDGET_MAX = 50000;
var HISTORIAN_CHUNK_PERCENTAGE = 0.25;
var HISTORIAN_CHUNK_MIN = 8000;
var HISTORIAN_CHUNK_MAX = 50000;
var DEFAULT_HISTORIAN_CONTEXT_FALLBACK = 128000;
function deriveTriggerBudget(mainContextLimit, executeThresholdPercentage) {
  if (!Number.isFinite(mainContextLimit) || mainContextLimit <= 0) {
    return TRIGGER_BUDGET_MIN;
  }
  const thresholdFraction = Math.max(0, executeThresholdPercentage) / 100;
  const usable = mainContextLimit * thresholdFraction;
  const derived = Math.round(usable * TRIGGER_BUDGET_PERCENTAGE);
  return Math.max(TRIGGER_BUDGET_MIN, Math.min(TRIGGER_BUDGET_MAX, derived));
}
function deriveHistorianChunkTokens(historianContextLimit) {
  if (!Number.isFinite(historianContextLimit) || historianContextLimit <= 0) {
    return HISTORIAN_CHUNK_MIN;
  }
  const derived = Math.round(historianContextLimit * HISTORIAN_CHUNK_PERCENTAGE);
  return Math.max(HISTORIAN_CHUNK_MIN, Math.min(HISTORIAN_CHUNK_MAX, derived));
}
function resolveHistorianContextLimit(historianModelOverride) {
  if (typeof historianModelOverride === "string" && historianModelOverride.includes("/")) {
    const [providerID, ...rest] = historianModelOverride.split("/");
    const modelID = rest.join("/");
    if (providerID && modelID) {
      const limit = getSdkContextLimit(providerID, modelID);
      if (typeof limit === "number" && limit > 0)
        return limit;
    }
    return DEFAULT_HISTORIAN_CONTEXT_FALLBACK;
  }
  if (typeof historianModelOverride === "string" && historianModelOverride.trim() !== "") {
    console.warn(`[magic-context] historian.model "${historianModelOverride}" lacks provider prefix ("provider/model-id"); using the default context limit for chunk-budget derivation.`);
  }
  return DEFAULT_HISTORIAN_CONTEXT_FALLBACK;
}

export { setStoragePrivatePermissionEnforcement, shouldEnforcePrivateStoragePermissions, setWindowOverlayPath, formatWindowDerivationLine, isSaneLimit, setOutputReserveConfig, refreshModelLimitsFromApi, refreshModelLimitsAfterAuthOnce, getSdkWindowGeometry, getSdkContextLimit, modelSupportsVision, deriveTriggerBudget, deriveHistorianChunkTokens, resolveHistorianContextLimit };
