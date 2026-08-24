import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  Show,
} from "solid-js";
import { getConfig, getProjectConfigs, saveConfig, saveProjectConfig } from "../../lib/api";
import { jsoncErrorMessage, parseJsonc } from "../../lib/jsonc";
import { getEffectiveModelIds } from "../../lib/model-ids";
import { invoke } from "../../lib/platform";
import type { OpencodeInstallState, ProjectConfigEntry } from "../../lib/types";
import { configSaveBlocker } from "./config-save-guard";
import type { DreamTaskConfig } from "./DreamerTasksField";
import DreamerTasksField from "./DreamerTasksField";
import ModelSelect from "./ModelSelect";
import PerModelField from "./PerModelField";

// ── JSONC helpers ───────────────────────────────────────────

const CONFIG_TAB_STORAGE_KEY = "magic-context-dashboard.config-tab";
const MAGIC_CONTEXT_SCHEMA_URL =
  "https://raw.githubusercontent.com/ahrav/magic-context/main/assets/magic-context.schema.json";
const USER_DEFAULT_CONFIG = `{
  "$schema": "${MAGIC_CONTEXT_SCHEMA_URL}",
  "enabled": true
}`;

type ConfigTarget = "user" | "projects";

function loadConfigTarget(): ConfigTarget {
  try {
    return localStorage.getItem(CONFIG_TAB_STORAGE_KEY) === "projects" ? "projects" : "user";
  } catch {
    return "user";
  }
}

interface ParsedConfigContent {
  value: Record<string, unknown>;
  error: string | null;
}

function parseConfigContent(text: string): ParsedConfigContent {
  try {
    return { value: parseJsonc(text), error: null };
  } catch (error) {
    return { value: {}, error: jsoncErrorMessage(error) };
  }
}

/** Pretty-print config as JSONC (plain JSON with 2-space indent). */
function toJsonc(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, null, 2);
}

// ── Config field definitions ────────────────────────────────

interface FieldDef {
  key: string;
  label: string;
  type: "boolean" | "number" | "string" | "select";
  options?: string[];
  description: string;
  section: string;
  defaultValue?: boolean | number | string;
}

const FIELD_DEFS: FieldDef[] = [
  // General
  {
    key: "enabled",
    label: "Enabled",
    type: "boolean",
    description: "Enable the magic-context plugin",
    section: "General",
  },
  {
    key: "allow_home_project",
    label: "Allow Home Directory Sessions",
    type: "boolean",
    description:
      "Allow sessions started exactly from your home directory to use a durable Magic Context project identity. User-level only.",
    section: "General",
  },
  {
    key: "language",
    label: "Output Language",
    type: "string",
    description:
      "Optional user-level output language for Magic Context generated prose and guidance, as a 2-letter ISO 639-1 code (e.g. tr, es, de, ja). Leave blank to keep today's behavior.",
    section: "General",
  },
  {
    key: "toast_duration_ms",
    label: "Toast Duration (ms)",
    type: "number",
    description: "How long Magic Context TUI toasts stay visible.",
    section: "General",
  },
  // Mural
  {
    key: "mural.enabled",
    label: "Mural Enabled",
    type: "boolean",
    description:
      "Render a deterministic image of project memories that did not fit the context budget.",
    section: "Mural",
  },
  {
    key: "mural.model",
    label: "Cue Compressor Model",
    type: "string",
    description:
      "Model used to compress each memory into a mural cue. The mural image itself is rendered deterministically.",
    section: "Mural",
  },
  // Thresholds
  // cache_ttl and execute_threshold_percentage are rendered as custom PerModelField components
  // Tags & cleanup
  {
    key: "protected_tags",
    label: "Protected Tags",
    type: "number",
    description: "Number of recent tags protected from drops.",
    section: "Tags & Cleanup",
  },
  {
    key: "clear_reasoning_age",
    label: "Clear Reasoning Age",
    type: "number",
    description: "Tag age after which reasoning blocks are cleared.",
    section: "Tags & Cleanup",
  },
  // Historian
  {
    key: "history_budget_percentage",
    label: "History Budget %",
    type: "number",
    description: "Fraction of context limit reserved for rendered history (0.0–1.0).",
    section: "Historian",
  },
  {
    key: "historian_timeout_ms",
    label: "Historian Timeout (ms)",
    type: "number",
    description: "Max wait time for a historian run before timeout.",
    section: "Historian",
  },
  // Memory
  {
    key: "memory.enabled",
    label: "Memory Enabled",
    type: "boolean",
    description: "Enable cross-session project memory.",
    section: "Memory",
  },
  {
    key: "memory.injection_budget_tokens",
    label: "Injection Budget (tokens)",
    type: "number",
    description: "Max tokens for memory injection into session history.",
    section: "Memory",
  },
  {
    key: "memory.auto_promote",
    label: "Auto Promote",
    type: "boolean",
    description: "Automatically promote session facts to project memory.",
    section: "Memory",
  },
  {
    key: "memory.retrieval_count_promotion_threshold",
    label: "Retrieval Count Promotion Threshold",
    type: "number",
    description:
      "Minimum ctx_search retrieval count before a session fact is auto-promoted to project memory.",
    section: "Memory",
  },
];

// These fields are valid only in trusted user configuration. They remain in the
// schema coverage manifest because the user form renders them, but project forms
// must not present controls for settings the runtime strips from repositories.
const USER_ONLY_FORM_FIELDS = new Set(["language", "allow_home_project", "mural.model"]);

// ── Nested value access helpers ─────────────────────────────

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const clone = structuredClone(obj);
  const parts = path.split(".");
  let current: Record<string, unknown> = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null || typeof current[parts[i]] !== "object") {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
  return clone;
}

/**
 * Normalize a `fallback_models` value to a string array.
 *
 * The plugin's `AgentOverrideConfigSchema` accepts `fallback_models` as
 * either a string (single model) or `string[]` (chain). When stored as a
 * bare string, the dashboard's old `as string[]` cast caused two visible
 * bugs:
 *   1. The chip list iterated the string per-character ("o", "p", "e", ...).
 *   2. The "Add fallback" dropdown filter ran `String.prototype.includes(m)`
 *      against every available model, substring-matching aggressively (any
 *      model containing "o" or "/" would be filtered out), leaving the
 *      dropdown empty with "No models found".
 *
 * This helper coerces both shapes to a real array so all consumers can
 * treat the value uniformly. Returns an empty array for `undefined`,
 * `null`, or other unexpected shapes.
 */
function readFallbackModels(formData: Record<string, unknown>, path: string): string[] {
  const raw = getNestedValue(formData, path);
  if (typeof raw === "string") return raw.length > 0 ? [raw] : [];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  return [];
}

// ── Section icons ───────────────────────────────────────────

const SECTION_ICONS: Record<string, string> = {
  General: "⚙️",
  Mural: "🖼️",
  Thresholds: "⚡",
  "Tags & Cleanup": "🏷️",
  Historian: "📜",
  Memory: "🧠",
};

// Fields that should use range sliders (percentage or threshold values)
const RANGE_SLIDER_FIELDS = new Set([
  "history_budget_percentage",
  "protected_tags",
  "clear_reasoning_age",
  "historian_timeout_ms",
  "memory.injection_budget_tokens",
]);

// ── ConfigForm component ────────────────────────────────────

function ConfigForm(props: {
  content: string;
  exists: boolean;
  readError?: string | null;
  onSave: (content: string) => void | Promise<void>;
  saveStatus: string | null;
  models: string[];
  opencodeInstallState: OpencodeInstallState;
  /** "user" or "project". Project configs are untrusted repository input: the
   *  runtime strips embedding endpoint/provider from them, and the Test
   *  Connection probe refuses project scope (it would expand the repo's
   *  {env:}/{file:} tokens and contact its endpoint, a secret-exfil vector).
   *  So the embedding column is hidden for project scope. Defaults to "user". */
  scope?: "user" | "project";
}) {
  const [showRaw, setShowRaw] = createSignal(false);
  const [rawEdit, setRawEdit] = createSignal<string | null>(null);
  const [formData, setFormData] = createSignal<Record<string, unknown>>({});
  const [embeddingTestResult, setEmbeddingTestResult] = createSignal<{
    ok: boolean;
    message: string;
  } | null>(null);
  const isUserScope = () => (props.scope ?? "user") === "user";

  /**
   * Structured outcome returned by the Rust probe (mirrors the `EmbeddingProbeOutcome`
   * enum in `src-tauri/src/embedding_probe.rs`, serialized via serde with
   * `tag = "kind"` + `rename_all = "snake_case"`). Each variant carries the
   * fields needed to render provider-specific guidance instead of a raw
   * HTTP status.
   */
  type EmbeddingProbeOutcome =
    | { kind: "ok"; status: number; dimensions: number | null }
    | { kind: "auth_failed"; status: number; preview: string }
    | { kind: "endpoint_unsupported"; status: number; preview: string }
    | { kind: "http_error"; status: number; preview: string }
    | { kind: "network_error"; message: string }
    | { kind: "timeout"; timeout_ms: number }
    | { kind: "invalid_scheme"; endpoint: string }
    | { kind: "unresolved_token"; field: string; token: string }
    | { kind: "blocked_sensitive_file"; field: string; token: string; reason: string }
    | { kind: "scope_not_allowed"; scope: string };

  /** Render the probe outcome as `{ ok, message }` for the inline UI. The
   *  wording mirrors doctor's output so a user who runs both tools sees
   *  consistent guidance. */
  function formatProbeOutcome(outcome: EmbeddingProbeOutcome): {
    ok: boolean;
    message: string;
  } {
    switch (outcome.kind) {
      case "ok":
        return {
          ok: true,
          message: `✓ Connected (${outcome.status}, ${outcome.dimensions ?? "?"}-dim vectors)`,
        };
      case "auth_failed":
        return {
          ok: false,
          message: `Credentials rejected (${outcome.status}) — check your API key`,
        };
      case "endpoint_unsupported":
        return {
          ok: false,
          message: `Endpoint does not support embeddings (${outcome.status}) — provider may not offer an embeddings API or the URL points at the wrong route`,
        };
      case "http_error":
        return {
          ok: false,
          message: `HTTP ${outcome.status}: ${outcome.preview.slice(0, 120)}`,
        };
      case "network_error":
        return { ok: false, message: `Connection failed: ${outcome.message}` };
      case "timeout":
        return {
          ok: false,
          message: `Endpoint did not respond within ${outcome.timeout_ms}ms — check URL and network`,
        };
      case "invalid_scheme":
        return {
          ok: false,
          message: `Endpoint must start with http:// or https:// (got: ${outcome.endpoint})`,
        };
      case "unresolved_token": {
        // Message depends on the token kind: a {file:} token failed because the
        // file is missing/unreadable; an {env:} token failed because the var is
        // not exported into this GUI process (the classic "launch from a
        // terminal" case). The old wording assumed env for both, which was wrong
        // and confusing for the recommended {file:~/...key} pattern.
        const isFile = outcome.token.startsWith("{file:");
        const detail = isFile
          ? "the file it points to could not be read (check the path exists and is readable)"
          : "the environment variable is not set in this process. Launch the app from a terminal where your shell exports it, or run `doctor` to validate from the shell";
        return {
          ok: false,
          message: `${outcome.field} references ${outcome.token}, but ${detail}.`,
        };
      }
      case "blocked_sensitive_file":
        return {
          ok: false,
          message: `${outcome.field} references ${outcome.token}, which resolves to a credential location (${outcome.reason}). Refusing to read it for an endpoint test. Point this at your embedding API key, not a credential file.`,
        };
      case "scope_not_allowed":
        return {
          ok: false,
          message: `Test Connection is only available for user-level config. Project config cannot set an embedding endpoint (the runtime ignores it), so there is nothing to test here.`,
        };
    }
  }
  const models = () => props.models;
  const showManualModelHint = () =>
    props.opencodeInstallState === "desktop" || models().length === 0;
  // The "Desktop detected" wording is only accurate when detection actually
  // reported a Desktop-only install. An empty model list with the CLI present
  // (e.g. `opencode models` returned nothing) gets the neutral phrasing.
  const manualModelHint = () => (
    <Show when={showManualModelHint()}>
      <span
        class="config-field-desc"
        style={{ color: "var(--text-muted)", "font-style": "italic" }}
      >
        {props.opencodeInstallState === "desktop"
          ? "OpenCode Desktop detected, CLI not installed. Type a model id manually, or install the OpenCode CLI to auto-populate models."
          : "No models found. Type a model id manually, or install/configure the OpenCode CLI to auto-populate models."}
      </span>
    </Show>
  );

  const parsedState = createMemo(() => parseConfigContent(props.content));
  const parsed = createMemo(() => parsedState().value);
  createEffect(() => {
    const next = parsedState();
    if (!next.error) {
      setFormData(next.value);
    }
  });

  // Structured saves merge form fields into the parsed file. If reading or
  // parsing failed, saving the fallback object would erase secrets and unknown settings.
  const structuredSaveBlocker = createMemo(() =>
    configSaveBlocker({
      exists: props.exists,
      readError: props.readError,
      parseError: parsedState().error,
    }),
  );
  const saveMessage = () => structuredSaveBlocker() ?? props.saveStatus;

  const hasChanges = createMemo(() => {
    return !structuredSaveBlocker() && JSON.stringify(formData()) !== JSON.stringify(parsed());
  });

  // Section order: Tags & Cleanup goes last (rendered after agent cards)
  const SECTION_ORDER: Record<string, number> = {
    General: 0,
    Mural: 1,
    Thresholds: 2,
    Historian: 3,
    Memory: 4,
    "Tags & Cleanup": 99,
  };

  const sections = createMemo(() => {
    const groups: Record<string, FieldDef[]> = {};
    for (const field of FIELD_DEFS) {
      if (!groups[field.section]) groups[field.section] = [];
      groups[field.section].push(field);
    }
    return Object.entries(groups).sort(
      ([a], [b]) => (SECTION_ORDER[a] ?? 50) - (SECTION_ORDER[b] ?? 50),
    );
  });

  const fieldsForScope = (fields: FieldDef[]) =>
    isUserScope() ? fields : fields.filter((field) => !USER_ONLY_FORM_FIELDS.has(field.key));

  const handleFieldChange = (key: string, value: unknown) => {
    const updated = setNestedValue(formData(), key, value);
    setFormData(updated);
  };

  const handleFormSave = () => {
    if (structuredSaveBlocker()) {
      return;
    }

    // Merge form data with original to preserve unknown keys
    const original = parsed();
    const merged = { ...original, ...formData() };
    // Deep merge for nested objects so we don't blow away sub-keys the form
    // doesn't currently expose. The shallow `...formData()` above would
    // otherwise replace the whole sub-tree. A legacy top-level `experimental`
    // block (if any) is preserved by the shallow spread and relocated by the
    // plugin's config migration on next load.
    for (const key of [
      "embedding",
      "memory",
      "sqlite",
      "system_prompt_injection",
      "caveman_text_compression",
      "mural",
      "prompt_surface",
      "storage",
      "compaction",
      "pi",
    ]) {
      if (typeof formData()[key] === "object" && formData()[key] != null) {
        merged[key] = {
          ...((original[key] as Record<string, unknown>) ?? {}),
          ...(formData()[key] as Record<string, unknown>),
        };
      }
    }
    props.onSave(toJsonc(merged));
  };

  const handleRawSave = () => {
    const content = rawEdit();
    if (content != null) {
      props.onSave(content);
      setRawEdit(null);
      const next = parseConfigContent(content);
      if (!next.error) {
        setFormData(next.value);
      }
    }
  };

  // Range slider helpers
  const getRangeConfig = (
    fieldKey: string,
  ): { min: number; max: number; step: number; suffix: string; defaultValue: number } => {
    switch (fieldKey) {
      case "execute_threshold_percentage":
        return { min: 20, max: 90, step: 1, suffix: "%", defaultValue: 65 };
      case "history_budget_percentage":
        return { min: 0.05, max: 0.5, step: 0.01, suffix: "", defaultValue: 0.15 };
      case "protected_tags":
        return { min: 1, max: 100, step: 1, suffix: "", defaultValue: 20 };
      case "clear_reasoning_age":
        return { min: 10, max: 200, step: 5, suffix: "", defaultValue: 50 };
      case "historian_timeout_ms":
        return { min: 60000, max: 600000, step: 30000, suffix: " ms", defaultValue: 300000 };
      case "memory.injection_budget_tokens":
        return { min: 500, max: 20000, step: 500, suffix: " tokens", defaultValue: 4000 };
      default:
        return { min: 0, max: 100, step: 1, suffix: "", defaultValue: 0 };
    }
  };

  const renderField = (field: FieldDef): JSX.Element => {
    const value = () => {
      const formVal = getNestedValue(formData(), field.key);
      return formVal !== undefined ? formVal : getNestedValue(parsed(), field.key);
    };
    const scalarValue = () => {
      const v = value();
      if (v != null && typeof v === "object" && !Array.isArray(v)) {
        const obj = v as Record<string, unknown>;
        return obj.default !== undefined ? obj.default : undefined;
      }
      return v;
    };
    const isObjectValue = () => {
      const v = value();
      return v != null && typeof v === "object" && !Array.isArray(v);
    };
    const booleanValue = () => {
      const v = value();
      if (typeof v === "boolean") return v;
      return (field.defaultValue as boolean | undefined) ?? true;
    };
    const isRangeSlider =
      field.type === "number" && RANGE_SLIDER_FIELDS.has(field.key) && !isObjectValue();

    return (
      <div class="config-field">
        <div class="config-field-header">
          <span class="config-field-label">{field.label}</span>
          <span class="config-field-key">{field.key}</span>
        </div>
        <span class="config-field-desc">{field.description}</span>
        {field.type === "boolean" ? (
          <label class="toggle-switch">
            <input
              type="checkbox"
              checked={booleanValue()}
              onChange={(e) => handleFieldChange(field.key, e.currentTarget.checked)}
            />
            <span class="toggle-slider" />
            <span class="toggle-label">{booleanValue() ? "Enabled" : "Disabled"}</span>
          </label>
        ) : field.type === "select" ? (
          <select
            class="config-input"
            value={String(value() ?? "")}
            onChange={(e) => handleFieldChange(field.key, e.currentTarget.value)}
          >
            <For each={field.options ?? []}>{(opt) => <option value={opt}>{opt}</option>}</For>
          </select>
        ) : isRangeSlider ? (
          <div class="range-slider-container">
            <input
              class="range-slider"
              type="range"
              min={getRangeConfig(field.key).min}
              max={getRangeConfig(field.key).max}
              step={getRangeConfig(field.key).step}
              value={
                scalarValue() != null
                  ? Number(scalarValue())
                  : getRangeConfig(field.key).defaultValue
              }
              onInput={(e) => handleFieldChange(field.key, Number(e.currentTarget.value))}
            />
            <span class="range-slider-value">
              {scalarValue() != null
                ? Number(scalarValue())
                : getRangeConfig(field.key).defaultValue}
              {getRangeConfig(field.key).suffix}
            </span>
          </div>
        ) : field.type === "number" ? (
          <input
            class="config-input"
            type="number"
            value={value() != null ? String(value()) : ""}
            placeholder="default"
            onInput={(e) => {
              const v = e.currentTarget.value;
              handleFieldChange(field.key, v ? Number(v) : undefined);
            }}
          />
        ) : (
          <input
            class="config-input"
            type="text"
            value={typeof value() === "object" ? JSON.stringify(value()) : String(value() ?? "")}
            placeholder="default"
            onInput={(e) => {
              const next = e.currentTarget.value;
              handleFieldChange(
                field.key,
                field.key === "language" && next.trim() === "" ? undefined : next,
              );
            }}
          />
        )}
      </div>
    );
  };

  return (
    <div>
      {/* Sticky Action Bar */}
      <div class="config-action-bar">
        <div class="tab-pills" style={{ margin: "0" }}>
          <button
            type="button"
            class={`tab-pill ${!showRaw() ? "active" : ""}`}
            onClick={() => setShowRaw(false)}
          >
            Form
          </button>
          <button
            type="button"
            class={`tab-pill ${showRaw() ? "active" : ""}`}
            onClick={() => {
              setShowRaw(true);
              setRawEdit(null);
            }}
          >
            Raw JSONC
          </button>
        </div>
        <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
          <Show when={saveMessage()}>
            {(message) => (
              <span
                style={{
                  "font-size": "12px",
                  color: message().startsWith("✓") ? "var(--green)" : "var(--red)",
                }}
              >
                {message()}
              </span>
            )}
          </Show>
          <button
            type="button"
            class="btn primary sm"
            disabled={!hasChanges()}
            onClick={handleFormSave}
            style={{
              opacity: hasChanges() ? 1 : 0.4,
              cursor: hasChanges() ? "pointer" : "default",
            }}
          >
            Save Changes
          </button>
        </div>
      </div>

      <Show
        when={!showRaw()}
        fallback={
          <div>
            <Show
              when={rawEdit() != null}
              fallback={
                <div>
                  <pre class="config-pre">{props.content || "// Empty config"}</pre>
                  <div style={{ "margin-top": "12px" }}>
                    <button type="button" class="btn sm" onClick={() => setRawEdit(props.content)}>
                      Edit
                    </button>
                  </div>
                </div>
              }
            >
              <textarea
                class="code-editor"
                style={{ "min-height": "calc(100vh - 340px)" }}
                value={rawEdit() ?? ""}
                onInput={(e) => setRawEdit(e.currentTarget.value)}
              />
              <div style={{ display: "flex", gap: "8px", "margin-top": "12px" }}>
                <button type="button" class="btn primary sm" onClick={handleRawSave}>
                  Save
                </button>
                <button type="button" class="btn sm" onClick={() => setRawEdit(null)}>
                  Cancel
                </button>
              </div>
            </Show>
          </div>
        }
      >
        <div class="config-grid">
          <For each={sections().filter(([name]) => name !== "Tags & Cleanup")}>
            {([sectionName, fields]) => {
              const isFullWidth = sectionName === "Historian" || sectionName === "Memory";
              return (
                <>
                  <div class={`config-card ${isFullWidth ? "full-width" : ""}`}>
                    <div class="config-card-header">
                      <span class="config-card-icon">{SECTION_ICONS[sectionName] || "📋"}</span>
                      <span class="config-card-title">{sectionName}</span>
                    </div>
                    {sectionName === "Memory" ? (
                      (() => {
                        const embeddingProvider = () => {
                          const v = getNestedValue(formData(), "embedding.provider");
                          return (v as string) || "local";
                        };
                        const isRemote = () => embeddingProvider() === "openai-compatible";
                        const localDtype = () =>
                          String(getNestedValue(formData(), "embedding.local_dtype") ?? "fp32");
                        return (
                          <div class="config-card-two-col">
                            {/* Left: Memory settings */}
                            <div class="config-card-content">
                              <For each={fieldsForScope(fields)}>{renderField}</For>
                            </div>
                            {/* Right: Embedding settings. Hidden for project
                                configs: the runtime strips embedding
                                endpoint/provider from untrusted project config,
                                and Test Connection on a project would be a
                                secret-exfil vector (expands the repo's tokens +
                                contacts its endpoint). Project memory toggles
                                live in the left column above. */}
                            <Show when={(props.scope ?? "user") !== "project"}>
                              <div class="config-card-content">
                                {/* Provider */}
                                <div class="config-field">
                                  <div class="config-field-header">
                                    <span class="config-field-label">Embedding Provider</span>
                                    <span class="config-field-key">embedding.provider</span>
                                  </div>
                                  <span class="config-field-desc">
                                    Provider for memory semantic search
                                  </span>
                                  <div style={{ display: "flex", gap: "6px" }}>
                                    <For each={["local", "openai-compatible", "off"] as const}>
                                      {(opt) => (
                                        <button
                                          class={`btn sm ${embeddingProvider() === opt ? "primary" : ""}`}
                                          onClick={() =>
                                            handleFieldChange("embedding.provider", opt)
                                          }
                                          type="button"
                                        >
                                          {opt === "local"
                                            ? "Local"
                                            : opt === "openai-compatible"
                                              ? "OpenAI Compatible"
                                              : "Off"}
                                        </button>
                                      )}
                                    </For>
                                  </div>
                                  <Show when={embeddingProvider() === "local"}>
                                    <span
                                      class="config-field-desc"
                                      style={{
                                        "margin-top": "4px",
                                        color: "var(--text-muted)",
                                        "font-style": "italic",
                                      }}
                                    >
                                      Uses Xenova/bge-small-en-v1.5 locally — no configuration needed
                                    </span>
                                  </Show>
                                  <Show when={embeddingProvider() === "local"}>
                                    <div class="config-field">
                                      <div class="config-field-header">
                                        <span class="config-field-label">Model dtype</span>
                                        <span class="config-field-key">embedding.local_dtype</span>
                                      </div>
                                      <span class="config-field-desc">
                                        ONNX dtype for the local embedding model. The default fp32
                                        keeps today's behavior; quantized choices use less memory.
                                      </span>
                                      <select
                                        class="config-input"
                                        value={localDtype()}
                                        onChange={(e) =>
                                          handleFieldChange(
                                            "embedding.local_dtype",
                                            e.currentTarget.value === "fp32"
                                              ? undefined
                                              : e.currentTarget.value,
                                          )
                                        }
                                      >
                                        <For
                                          each={[
                                            "auto",
                                            "fp32",
                                            "fp16",
                                            "q8",
                                            "int8",
                                            "uint8",
                                            "q4",
                                            "bnb4",
                                            "q4f16",
                                            "q2",
                                            "q2f16",
                                            "q1",
                                            "q1f16",
                                          ]}
                                        >
                                          {(dtype) => <option value={dtype}>{dtype}</option>}
                                        </For>
                                      </select>
                                    </div>
                                  </Show>
                                </div>

                                {/* Remote-only fields */}
                                <Show when={isRemote()}>
                                  <div class="config-field">
                                    <div class="config-field-header">
                                      <span class="config-field-label">Model</span>
                                      <span class="config-field-key">embedding.model</span>
                                    </div>
                                    <span class="config-field-desc">
                                      Embedding model name (e.g., text-embedding-3-small)
                                    </span>
                                    <input
                                      class="config-input"
                                      type="text"
                                      value={String(
                                        getNestedValue(formData(), "embedding.model") ?? "",
                                      )}
                                      placeholder="text-embedding-3-small"
                                      onInput={(e) =>
                                        handleFieldChange(
                                          "embedding.model",
                                          e.currentTarget.value || undefined,
                                        )
                                      }
                                    />
                                  </div>

                                  <div class="config-field">
                                    <div class="config-field-header">
                                      <span class="config-field-label">Endpoint</span>
                                      <span class="config-field-key">embedding.endpoint</span>
                                    </div>
                                    <span class="config-field-desc">API endpoint URL</span>
                                    <input
                                      class="config-input"
                                      type="text"
                                      value={String(
                                        getNestedValue(formData(), "embedding.endpoint") ?? "",
                                      )}
                                      placeholder="https://api.openai.com/v1"
                                      onInput={(e) =>
                                        handleFieldChange(
                                          "embedding.endpoint",
                                          e.currentTarget.value || undefined,
                                        )
                                      }
                                    />
                                  </div>

                                  <div class="config-field">
                                    <div class="config-field-header">
                                      <span class="config-field-label">API Key</span>
                                      <span class="config-field-key">embedding.api_key</span>
                                    </div>
                                    <span class="config-field-desc">
                                      Authentication key for the embedding API
                                    </span>
                                    <input
                                      class="config-input"
                                      type="password"
                                      value={String(
                                        getNestedValue(formData(), "embedding.api_key") ?? "",
                                      )}
                                      placeholder="sk-..."
                                      onInput={(e) =>
                                        handleFieldChange(
                                          "embedding.api_key",
                                          e.currentTarget.value || undefined,
                                        )
                                      }
                                    />
                                  </div>

                                  <div>
                                    <button
                                      type="button"
                                      class="btn sm"
                                      onClick={async () => {
                                        const endpoint = String(
                                          getNestedValue(formData(), "embedding.endpoint") ?? "",
                                        ).trim();
                                        const model = String(
                                          getNestedValue(formData(), "embedding.model") ?? "",
                                        ).trim();
                                        const apiKey = String(
                                          getNestedValue(formData(), "embedding.api_key") ?? "",
                                        ).trim();
                                        const inputType = String(
                                          getNestedValue(formData(), "embedding.input_type") ?? "",
                                        ).trim();
                                        const truncate = String(
                                          getNestedValue(formData(), "embedding.truncate") ?? "",
                                        ).trim();
                                        if (!endpoint || !model) {
                                          setEmbeddingTestResult({
                                            ok: false,
                                            message: "Endpoint and model are required",
                                          });
                                          return;
                                        }
                                        setEmbeddingTestResult({
                                          ok: false,
                                          message: "Testing...",
                                        });
                                        try {
                                          // Rust returns the structured outcome directly (not
                                          // `Result<T, String>` anymore). Any thrown error from
                                          // `invoke` itself is a tauri infrastructure failure
                                          // (e.g., command not registered) rather than a probe
                                          // classification — we surface that unchanged.
                                          const outcome = await invoke<EmbeddingProbeOutcome>(
                                            "test_embedding_endpoint",
                                            {
                                              endpoint,
                                              model,
                                              apiKey: apiKey || null,
                                              inputType: inputType || null,
                                              truncate: truncate || null,
                                              // Backend trust boundary: only "user"
                                              // scope expands tokens + probes. The
                                              // button is hidden for projects, but
                                              // send the scope so the backend can
                                              // refuse regardless.
                                              source: props.scope ?? "user",
                                            },
                                          );
                                          setEmbeddingTestResult(formatProbeOutcome(outcome));
                                        } catch (e: unknown) {
                                          setEmbeddingTestResult({
                                            ok: false,
                                            message: String(
                                              (e as { message?: string })?.message ?? e,
                                            ),
                                          });
                                        }
                                      }}
                                    >
                                      ⚡ Test Connection
                                    </button>
                                    <Show when={embeddingTestResult()}>
                                      <span
                                        style={{
                                          "margin-left": "10px",
                                          "font-size": "12px",
                                          color: embeddingTestResult()?.ok
                                            ? "var(--green)"
                                            : "var(--red)",
                                        }}
                                      >
                                        {embeddingTestResult()?.message}
                                      </span>
                                    </Show>
                                  </div>
                                </Show>
                              </div>
                            </Show>
                          </div>
                        );
                      })()
                    ) : sectionName === "Historian" ? (
                      <div class="config-card-two-col">
                        <Show when={isUserScope()}>
                          {/* Historian model selection is user-level only; project configs may
                               still tune the scheduling and history settings shown on the right. */}
                          <div class="config-card-content">
                            <div class="config-field">
                              <div class="config-field-header">
                                <span class="config-field-label">Model</span>
                              </div>
                              <span class="config-field-desc">
                                Primary model for historian agent
                              </span>
                              {manualModelHint()}
                              <ModelSelect
                                models={models() ?? []}
                                value={
                                  getNestedValue(formData(), "historian.model") as
                                    | string
                                    | undefined
                                }
                                onChange={(v) =>
                                  handleFieldChange("historian.model", v || undefined)
                                }
                                placeholder="— Use fallback chain —"
                              />
                            </div>
                            <div class="config-field">
                              <div class="config-field-header">
                                <span class="config-field-label">Fallback Models</span>
                              </div>
                              <span class="config-field-desc">Models to try if primary fails</span>
                              <div class="model-chain-list">
                                <Show
                                  when={
                                    readFallbackModels(formData(), "historian.fallback_models")
                                      .length > 0
                                  }
                                  fallback={
                                    <span class="model-chain-empty">
                                      Using built-in fallback chain
                                    </span>
                                  }
                                >
                                  <For
                                    each={readFallbackModels(
                                      formData(),
                                      "historian.fallback_models",
                                    )}
                                  >
                                    {(model, index) => (
                                      <div class="model-chain-item">
                                        <span class="mono" style={{ flex: 1 }}>
                                          {model}
                                        </span>
                                        <button
                                          type="button"
                                          class="btn sm danger"
                                          onClick={() => {
                                            const current = readFallbackModels(
                                              formData(),
                                              "historian.fallback_models",
                                            );
                                            const next = current.filter((_, i) => i !== index());
                                            handleFieldChange(
                                              "historian.fallback_models",
                                              next.length > 0 ? next : undefined,
                                            );
                                          }}
                                        >
                                          ✕
                                        </button>
                                      </div>
                                    )}
                                  </For>
                                </Show>
                              </div>
                              <div class="model-chain-add">
                                <ModelSelect
                                  models={(models() ?? []).filter(
                                    (m) =>
                                      !readFallbackModels(
                                        formData(),
                                        "historian.fallback_models",
                                      ).includes(m),
                                  )}
                                  value={undefined}
                                  onChange={(v) => {
                                    if (v) {
                                      const current = readFallbackModels(
                                        formData(),
                                        "historian.fallback_models",
                                      );
                                      handleFieldChange("historian.fallback_models", [
                                        ...current,
                                        v,
                                      ]);
                                    }
                                  }}
                                  placeholder="— Add fallback model —"
                                />
                              </div>
                            </div>
                          </div>
                        </Show>
                        {/* Right: Settings sliders */}
                        <div class="config-card-content">
                          <For each={fieldsForScope(fields)}>{renderField}</For>

                          {/* Commit Cluster Trigger */}
                          {(() => {
                            const commitCluster = () =>
                              (getNestedValue(formData(), "commit_cluster_trigger") as
                                | { enabled?: boolean; min_clusters?: number }
                                | undefined) ?? {};
                            const enabled = () => commitCluster().enabled ?? true;
                            const minClusters = () => commitCluster().min_clusters ?? 3;
                            return (
                              <>
                                <div class="config-field">
                                  <div class="config-field-header">
                                    <span class="config-field-label">Commit Cluster Trigger</span>
                                    <span class="config-field-key">
                                      commit_cluster_trigger.enabled
                                    </span>
                                  </div>
                                  <span class="config-field-desc">
                                    Fire historian when enough git commit clusters accumulate in the
                                    unsummarized conversation tail. A commit cluster is a distinct
                                    work phase where the agent made git commits, separated by
                                    meaningful user turns.
                                  </span>
                                  <label class="toggle-switch">
                                    <input
                                      type="checkbox"
                                      checked={enabled()}
                                      onChange={(e) =>
                                        handleFieldChange("commit_cluster_trigger", {
                                          ...commitCluster(),
                                          enabled: e.currentTarget.checked,
                                        })
                                      }
                                    />
                                    <span class="toggle-slider" />
                                    <span class="toggle-label">
                                      {enabled() ? "Enabled" : "Disabled"}
                                    </span>
                                  </label>
                                </div>

                                <Show when={enabled()}>
                                  <div class="config-field">
                                    <div class="config-field-header">
                                      <span class="config-field-label">Min Clusters</span>
                                      <span class="config-field-key">
                                        commit_cluster_trigger.min_clusters
                                      </span>
                                    </div>
                                    <span class="config-field-desc">
                                      Minimum number of commit clusters required to trigger
                                      historian
                                    </span>
                                    <input
                                      class="config-input"
                                      type="number"
                                      min={1}
                                      value={minClusters()}
                                      onInput={(e) => {
                                        const v = e.currentTarget.value;
                                        handleFieldChange("commit_cluster_trigger", {
                                          ...commitCluster(),
                                          min_clusters: v ? Math.max(1, Number(v)) : 3,
                                        });
                                      }}
                                    />
                                  </div>
                                </Show>
                              </>
                            );
                          })()}
                        </div>
                      </div>
                    ) : (
                      <div class="config-card-content">
                        <For each={fieldsForScope(fields)}>{renderField}</For>
                      </div>
                    )}
                  </div>
                  {/* Thresholds card — right of General */}
                  {sectionName === "General" && (
                    <div class="config-card">
                      <div class="config-card-header">
                        <span class="config-card-icon">⚡</span>
                        <span class="config-card-title">Thresholds</span>
                      </div>
                      <div class="config-card-content">
                        <PerModelField
                          label="Cache TTL"
                          configKey="cache_ttl"
                          description="How long to wait before executing queued operations."
                          value={
                            getNestedValue(formData(), "cache_ttl") ??
                            getNestedValue(parsed(), "cache_ttl")
                          }
                          onChange={(v) => handleFieldChange("cache_ttl", v)}
                          models={models() ?? []}
                          inputType="text"
                          defaultPlaceholder="5m"
                          textOptions={[{ value: "never", label: "Never (keep warm)" }]}
                        />
                        <PerModelField
                          label="Execute Threshold %"
                          configKey="execute_threshold_percentage"
                          description="Context usage percentage (20–90) at which queued drops execute. The safe-window cap is 90%."
                          value={
                            getNestedValue(formData(), "execute_threshold_percentage") ??
                            getNestedValue(parsed(), "execute_threshold_percentage")
                          }
                          onChange={(v) => handleFieldChange("execute_threshold_percentage", v)}
                          models={models() ?? []}
                          inputType="slider"
                          sliderConfig={{
                            min: 20,
                            max: 90,
                            step: 1,
                            suffix: "%",
                            defaultValue: 65,
                          }}
                          defaultPlaceholder="65"
                        />
                        <PerModelField
                          label="Execute Threshold (tokens)"
                          configKey="execute_threshold_tokens"
                          description="Optional absolute-tokens threshold. When set for a model, overrides the percentage above. Per-model map only (use 'default' key for a fallback across all unlisted models). Clamped to 90% × context_limit at runtime."
                          value={
                            getNestedValue(formData(), "execute_threshold_tokens") ??
                            getNestedValue(parsed(), "execute_threshold_tokens")
                          }
                          onChange={(v) => handleFieldChange("execute_threshold_tokens", v)}
                          models={models() ?? []}
                          inputType="text"
                          alwaysObject
                          numericText
                          defaultPlaceholder="150000"
                        />
                        <Show when={isUserScope()}>
                          <PerModelField
                            label="Output Reserve"
                            configKey="output_reserve"
                            description="Reserve output tokens from the shared context window. Set 0 to disable the reservation. User-level only."
                            value={
                              getNestedValue(formData(), "output_reserve") ??
                              getNestedValue(parsed(), "output_reserve")
                            }
                            onChange={(v) => handleFieldChange("output_reserve", v)}
                            models={models() ?? []}
                            inputType="text"
                            numericText
                            defaultPlaceholder="16384"
                          />
                        </Show>
                      </div>
                    </div>
                  )}
                </>
              );
            }}
          </For>

          {/* Prompt surface is editable in both scopes for routing. Override text
              is shown but locked for project config because the runtime removes
              those user-only fields before merging repository settings. */}
          {(() => {
            const promptSurface = () =>
              (getNestedValue(formData(), "prompt_surface") as
                | Record<string, unknown>
                | undefined) ?? {};
            const userScope = () => (props.scope ?? "user") === "user";
            const [modelsDraft, setModelsDraft] = createSignal<string | undefined>();
            const [toolsDraft, setToolsDraft] = createSignal<string | undefined>();
            const defaultPreset = () => (promptSurface().default === "light" ? "light" : "full");
            const modelsJson = () =>
              JSON.stringify(
                (promptSurface().models as Record<string, unknown> | undefined) ?? {},
                null,
                2,
              );
            const toolsJson = () =>
              JSON.stringify(
                (promptSurface().tool_descriptions as Record<string, unknown> | undefined) ?? {},
                null,
                2,
              );
            const modelsEditorValue = () => modelsDraft() ?? modelsJson();
            const toolsEditorValue = () => toolsDraft() ?? toolsJson();
            const parseObject = (text: string): Record<string, unknown> | undefined => {
              try {
                const value = parseJsonc(text);
                return value && typeof value === "object" && !Array.isArray(value)
                  ? (value as Record<string, unknown>)
                  : undefined;
              } catch {
                return undefined;
              }
            };
            const setPromptSurface = (patch: Record<string, unknown>) =>
              handleFieldChange("prompt_surface", { ...promptSurface(), ...patch });

            return (
              <div class="config-card full-width">
                <div class="config-card-header">
                  <span class="config-card-icon">🪄</span>
                  <span class="config-card-title">Prompt Surface</span>
                </div>
                <div class="config-card-content">
                  <div
                    class="config-field-desc"
                    style={{ "margin-bottom": "8px", opacity: "0.85" }}
                  >
                    Choose the built-in full or light preset. Model routes use the literal
                    provider/model or provider/* form and are case-sensitive; additional slashes in
                    model IDs are preserved. Guidance and tool-description overrides are user-only.
                  </div>
                  <div class="config-field">
                    <div class="config-field-header">
                      <span class="config-field-label">Default preset</span>
                      <span class="config-field-key">prompt_surface.default</span>
                    </div>
                    <select
                      class="config-input"
                      value={defaultPreset()}
                      onChange={(e) => setPromptSurface({ default: e.currentTarget.value })}
                    >
                      <option value="full">full</option>
                      <option value="light">light</option>
                    </select>
                  </div>
                  <div class="config-field">
                    <div class="config-field-header">
                      <span class="config-field-label">Model routes</span>
                      <span class="config-field-key">prompt_surface.models</span>
                    </div>
                    <span class="config-field-desc">
                      JSON object of provider/model or provider/* keys to full or light. Leave empty
                      for default routing.
                    </span>
                    <textarea
                      class="code-editor"
                      rows={4}
                      value={modelsEditorValue()}
                      onInput={(e) => {
                        const value = e.currentTarget.value;
                        setModelsDraft(value);
                        const next = parseObject(value);
                        if (next) {
                          setPromptSurface({ models: next });
                          setModelsDraft(undefined);
                        }
                      }}
                    />
                  </div>
                  <Show when={userScope()}>
                    <div class="config-field">
                      <div class="config-field-header">
                        <span class="config-field-label">Guidance override path</span>
                        <span class="config-field-key">prompt_surface.guidance_override_path</span>
                      </div>
                      <span class="config-field-desc">
                        User-only path to a complete primary guidance section. Relative paths
                        resolve from the user config file.
                      </span>
                      <input
                        class="config-input"
                        type="text"
                        disabled={!userScope()}
                        value={String(promptSurface().guidance_override_path ?? "")}
                        placeholder={userScope() ? "path/to/guidance.md" : "user config only"}
                        onInput={(e) =>
                          setPromptSurface({
                            guidance_override_path: e.currentTarget.value || undefined,
                          })
                        }
                      />
                    </div>
                  </Show>
                  <Show when={userScope()}>
                    <div class="config-field">
                      <div class="config-field-header">
                        <span class="config-field-label">Tool-description overrides</span>
                        <span class="config-field-key">prompt_surface.tool_descriptions</span>
                      </div>
                      <span class="config-field-desc">
                        User-only JSON object keyed by tool ID. Only top-level descriptions change;
                        IDs, parameter schemas, and parameter descriptions remain fixed.
                      </span>
                      <textarea
                        class="code-editor"
                        rows={4}
                        disabled={!userScope()}
                        value={toolsEditorValue()}
                        onInput={(e) => {
                          const value = e.currentTarget.value;
                          setToolsDraft(value);
                          const next = parseObject(value);
                          if (next) {
                            setPromptSurface({ tool_descriptions: next });
                            setToolsDraft(undefined);
                          }
                        }}
                      />
                    </div>
                  </Show>
                </div>
              </div>
            );
          })()}

          {/* ── Agent Configuration Cards ───────────────────────── */}

          {/* Dreamer Card */}
          <div class="config-card full-width">
            <div class="config-card-header">
              <span class="config-card-icon">🌙</span>
              <span class="config-card-title">DREAMER</span>
            </div>
            <div class="config-card-two-col">
              {/* Left: Enabled, Schedule, Inject Docs */}
              <div class="config-card-content">
                <div class="config-field">
                  <div class="config-field-header">
                    <span class="config-field-label">Dreamer agent enabled</span>
                  </div>
                  <span class="config-field-desc">
                    Controls whether the Dreamer hidden agent is registered. To keep manual
                    /ctx-dream but disable automatic runs, leave enabled and set Schedule to empty.
                  </span>
                  <label class="toggle-switch">
                    <input
                      type="checkbox"
                      checked={getNestedValue(formData(), "dreamer.disable") !== true}
                      onChange={(e) => {
                        handleFieldChange("dreamer.disable", !e.currentTarget.checked);
                        handleFieldChange("dreamer.enabled", undefined);
                      }}
                    />
                    <span class="toggle-slider" />
                    <span class="toggle-label">
                      {getNestedValue(formData(), "dreamer.disable") !== true
                        ? "Enabled"
                        : "Disabled"}
                    </span>
                  </label>
                </div>

                <div class="config-field">
                  <div class="config-field-header">
                    <span class="config-field-label">Inject Docs</span>
                  </div>
                  <span class="config-field-desc">
                    Inject ARCHITECTURE.md and STRUCTURE.md into agent context
                  </span>
                  <label class="toggle-switch">
                    <input
                      type="checkbox"
                      checked={
                        (getNestedValue(formData(), "dreamer.inject_docs") as boolean) ?? true
                      }
                      onChange={(e) =>
                        handleFieldChange("dreamer.inject_docs", e.currentTarget.checked)
                      }
                    />
                    <span class="toggle-slider" />
                    <span class="toggle-label">
                      {((getNestedValue(formData(), "dreamer.inject_docs") as boolean) ?? true)
                        ? "Enabled"
                        : "Disabled"}
                    </span>
                  </label>
                </div>
              </div>

              {/* Right: Model + Fallbacks */}
              <div class="config-card-content">
                <div class="config-field">
                  <div class="config-field-header">
                    <span class="config-field-label">Model</span>
                  </div>
                  <span class="config-field-desc">Primary model for dreamer agent</span>
                  {manualModelHint()}
                  <ModelSelect
                    models={models() ?? []}
                    value={getNestedValue(formData(), "dreamer.model") as string | undefined}
                    onChange={(v) => handleFieldChange("dreamer.model", v || undefined)}
                    placeholder="— Use fallback chain —"
                  />
                </div>

                <div class="config-field">
                  <div class="config-field-header">
                    <span class="config-field-label">Fallback Models</span>
                  </div>
                  <span class="config-field-desc">Models to try if primary fails</span>
                  <div class="model-chain-list">
                    <Show
                      when={readFallbackModels(formData(), "dreamer.fallback_models").length > 0}
                      fallback={
                        <span class="model-chain-empty">Using built-in fallback chain</span>
                      }
                    >
                      <For each={readFallbackModels(formData(), "dreamer.fallback_models")}>
                        {(model, index) => (
                          <div class="model-chain-item">
                            <span class="mono" style={{ flex: 1 }}>
                              {model}
                            </span>
                            <button
                              type="button"
                              class="btn sm danger"
                              onClick={() => {
                                const current = readFallbackModels(
                                  formData(),
                                  "dreamer.fallback_models",
                                );
                                const updated = current.filter((_, i) => i !== index());
                                handleFieldChange(
                                  "dreamer.fallback_models",
                                  updated.length > 0 ? updated : undefined,
                                );
                              }}
                            >
                              ✕
                            </button>
                          </div>
                        )}
                      </For>
                    </Show>
                  </div>
                  <div class="model-chain-add">
                    <ModelSelect
                      models={(models() ?? []).filter(
                        (m) =>
                          !readFallbackModels(formData(), "dreamer.fallback_models").includes(m),
                      )}
                      value={undefined}
                      onChange={(v) => {
                        if (v) {
                          const current = readFallbackModels(formData(), "dreamer.fallback_models");
                          handleFieldChange("dreamer.fallback_models", [...current, v]);
                        }
                      }}
                      placeholder="— Add fallback model —"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Dreamer v2 per-task schedules. Replaces the retired v1 single
                schedule window + user_memories / pin_key_files blocks: each
                canonical task has its own cron schedule, optional model override,
                and task-specific params. */}
            <div class="config-field">
              <div class="config-field-header">
                <span class="config-field-label">Task schedules</span>
                <span class="config-field-key">dreamer.tasks</span>
              </div>
              <span class="config-field-desc">
                Each dreamer task runs on its own cron schedule. “Disabled” turns a task off while
                keeping manual /ctx-dream available. Leave models empty to inherit the dreamer model
                above.
              </span>
              <DreamerTasksField
                value={
                  getNestedValue(formData(), "dreamer.tasks") as
                    | Record<string, DreamTaskConfig>
                    | undefined
                }
                onChange={(tasks) => handleFieldChange("dreamer.tasks", tasks)}
                models={models() ?? []}
              />
            </div>
          </div>

          {/* Sidekick Card */}
          <div class="config-card">
            <div class="config-card-header">
              <span class="config-card-icon">🤖</span>
              <span class="config-card-title">SIDEKICK</span>
            </div>
            <div class="config-card-content">
              {/* Enabled Toggle */}
              <div class="config-field">
                <div class="config-field-header">
                  <span class="config-field-label">Sidekick agent enabled</span>
                </div>
                <span class="config-field-desc">
                  Controls whether the Sidekick hidden agent is registered for /ctx-aug.
                </span>
                <label class="toggle-switch">
                  <input
                    type="checkbox"
                    checked={getNestedValue(formData(), "sidekick.disable") !== true}
                    onChange={(e) => {
                      handleFieldChange("sidekick.disable", !e.currentTarget.checked);
                      handleFieldChange("sidekick.enabled", undefined);
                    }}
                  />
                  <span class="toggle-slider" />
                  <span class="toggle-label">
                    {getNestedValue(formData(), "sidekick.disable") !== true
                      ? "Enabled"
                      : "Disabled"}
                  </span>
                </label>
              </div>

              {/* Model Select */}
              <div class="config-field">
                <div class="config-field-header">
                  <span class="config-field-label">Model</span>
                </div>
                <span class="config-field-desc">Primary model for sidekick agent</span>
                {manualModelHint()}
                <ModelSelect
                  models={models() ?? []}
                  value={getNestedValue(formData(), "sidekick.model") as string | undefined}
                  onChange={(v) => handleFieldChange("sidekick.model", v || undefined)}
                  placeholder="— Use fallback chain —"
                />
              </div>

              {/* Timeout */}
              <div class="config-field">
                <div class="config-field-header">
                  <span class="config-field-label">Timeout (ms)</span>
                </div>
                <span class="config-field-desc">Max wait time for sidekick response</span>
                <input
                  class="config-input"
                  type="number"
                  value={
                    getNestedValue(formData(), "sidekick.timeout_ms") != null
                      ? String(getNestedValue(formData(), "sidekick.timeout_ms"))
                      : ""
                  }
                  placeholder="30000"
                  onInput={(e) => {
                    const v = e.currentTarget.value;
                    handleFieldChange("sidekick.timeout_ms", v ? Number(v) : undefined);
                  }}
                />
              </div>

              {/* Fallback Models */}
              <div class="config-field">
                <div class="config-field-header">
                  <span class="config-field-label">Fallback Models</span>
                </div>
                <span class="config-field-desc">Models to try if primary fails</span>
                <div class="model-chain-list">
                  <Show
                    when={readFallbackModels(formData(), "sidekick.fallback_models").length > 0}
                    fallback={<span class="model-chain-empty">Using built-in fallback chain</span>}
                  >
                    <For each={readFallbackModels(formData(), "sidekick.fallback_models")}>
                      {(model, index) => (
                        <div class="model-chain-item">
                          <span class="mono" style={{ flex: 1 }}>
                            {model}
                          </span>
                          <button
                            type="button"
                            class="btn sm danger"
                            onClick={() => {
                              const current = readFallbackModels(
                                formData(),
                                "sidekick.fallback_models",
                              );
                              const updated = current.filter((_, i) => i !== index());
                              handleFieldChange(
                                "sidekick.fallback_models",
                                updated.length > 0 ? updated : undefined,
                              );
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
                <div class="model-chain-add">
                  <ModelSelect
                    models={(models() ?? []).filter(
                      (m) =>
                        !readFallbackModels(formData(), "sidekick.fallback_models").includes(m),
                    )}
                    value={undefined}
                    onChange={(v) => {
                      if (v) {
                        const current = readFallbackModels(formData(), "sidekick.fallback_models");
                        handleFieldChange("sidekick.fallback_models", [...current, v]);
                      }
                    }}
                    placeholder="— Add fallback model —"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Tags & Cleanup — placed right after Sidekick so it fills the empty
              right column of the grid (Sidekick is a regular-width card and was
              otherwise leaving its right slot empty). Tags & Cleanup is also a
              regular-width card, so the two pair naturally on one row before the
              full-width Experimental card closes the form. */}
          {(() => {
            const tagsFields = sections().find(([name]) => name === "Tags & Cleanup");
            if (!tagsFields) return null;
            return (
              <div class="config-card">
                <div class="config-card-header">
                  <span class="config-card-icon">🏷️</span>
                  <span class="config-card-title">Tags & Cleanup</span>
                </div>
                <div class="config-card-content">
                  <For each={tagsFields[1]}>{renderField}</For>
                </div>
              </div>
            );
          })()}

          {/* History & Recall — features graduated out of `experimental.*` in
              v0.22.0. temporal_awareness is top-level; auto_search and
              git_commit_indexing live under `memory.*`; caveman is top-level.
              Full-width, rendered late. Each feature is a master toggle; child
              controls only appear when the feature is on. */}
          {(() => {
            // temporal_awareness — top-level boolean (default ON)
            const temporalAwareness = () => {
              const v = getNestedValue(formData(), "temporal_awareness");
              return v == null ? true : Boolean(v);
            };

            // memory.git_commit_indexing — { enabled, since_days, max_commits }
            const gitCommit = () =>
              (getNestedValue(formData(), "memory.git_commit_indexing") as
                | { enabled?: boolean; since_days?: number; max_commits?: number }
                | undefined) ?? {};
            const gitCommitEnabled = () => Boolean(gitCommit().enabled);
            const gitCommitSinceDays = () => gitCommit().since_days ?? 365;
            const gitCommitMaxCommits = () => gitCommit().max_commits ?? 2000;
            const setGitCommit = (patch: Record<string, unknown>) =>
              handleFieldChange("memory.git_commit_indexing", { ...gitCommit(), ...patch });

            // memory.auto_search — { enabled, score_threshold, min_prompt_chars } (default ON)
            const autoSearch = () =>
              (getNestedValue(formData(), "memory.auto_search") as
                | { enabled?: boolean; score_threshold?: number; min_prompt_chars?: number }
                | undefined) ?? {};
            const autoSearchEnabled = () => {
              const v = autoSearch().enabled;
              return v == null ? true : Boolean(v);
            };
            const autoSearchScoreThreshold = () => autoSearch().score_threshold ?? 0.55;
            const autoSearchMinChars = () => autoSearch().min_prompt_chars ?? 20;
            const setAutoSearch = (patch: Record<string, unknown>) =>
              handleFieldChange("memory.auto_search", { ...autoSearch(), ...patch });

            // caveman_text_compression — top-level { enabled, min_chars }
            const caveman = () =>
              (getNestedValue(formData(), "caveman_text_compression") as
                | { enabled?: boolean; min_chars?: number }
                | undefined) ?? {};
            const cavemanEnabled = () => Boolean(caveman().enabled);
            const cavemanMinChars = () => caveman().min_chars ?? 500;
            const setCaveman = (patch: Record<string, unknown>) =>
              handleFieldChange("caveman_text_compression", { ...caveman(), ...patch });

            return (
              <div class="config-card full-width">
                <div class="config-card-header">
                  <span class="config-card-icon">🔮</span>
                  <span class="config-card-title">History &amp; Recall</span>
                </div>
                <div class="config-card-content">
                  <div
                    class="config-field-desc"
                    style={{ "margin-bottom": "8px", opacity: "0.85" }}
                  >
                    Recall and history features. Temporal awareness and auto-search are on by
                    default; the rest are opt-in.
                  </div>

                  {/* Temporal awareness */}
                  <div class="config-field">
                    <div class="config-field-header">
                      <span class="config-field-label">Temporal Awareness</span>
                      <span class="config-field-key">temporal_awareness</span>
                    </div>
                    <span class="config-field-desc">
                      Inject elapsed-time markers (e.g. <code>+12m</code>, <code>+3d 4h</code>)
                      between user messages with &gt;5 min gaps, and add <code>start-date</code>/
                      <code>end-date</code> attributes on rendered compartments. Helps the agent
                      reason about session pacing across long-running and multi-day sessions. On by
                      default.
                    </span>
                    <label class="toggle-switch">
                      <input
                        type="checkbox"
                        checked={temporalAwareness()}
                        onChange={(e) =>
                          handleFieldChange("temporal_awareness", e.currentTarget.checked)
                        }
                      />
                      <span class="toggle-slider" />
                      <span class="toggle-label">
                        {temporalAwareness() ? "Enabled" : "Disabled"}
                      </span>
                    </label>
                  </div>

                  {/* Auto search */}
                  <div class="config-field">
                    <div class="config-field-header">
                      <span class="config-field-label">Auto Search Hint</span>
                      <span class="config-field-key">memory.auto_search.enabled</span>
                    </div>
                    <span class="config-field-desc">
                      On each new user message, run <code>ctx_search</code> in the background and
                      append a compact <code>&lt;ctx-search-hint&gt;</code> block of vague fragments
                      when the top hit clears the score threshold. Does NOT inject full content —
                      just nudges the agent to run <code>ctx_search</code> for the real result if
                      relevant. Adds one embedding round-trip per new user turn. On by default.
                    </span>
                    <label class="toggle-switch">
                      <input
                        type="checkbox"
                        checked={autoSearchEnabled()}
                        onChange={(e) => setAutoSearch({ enabled: e.currentTarget.checked })}
                      />
                      <span class="toggle-slider" />
                      <span class="toggle-label">
                        {autoSearchEnabled() ? "Enabled" : "Disabled"}
                      </span>
                    </label>
                  </div>

                  <Show when={autoSearchEnabled()}>
                    <div class="config-field">
                      <div class="config-field-header">
                        <span class="config-field-label">Score Threshold</span>
                        <span class="config-field-key">memory.auto_search.score_threshold</span>
                      </div>
                      <span class="config-field-desc">
                        Minimum top-hit score for the hint to fire. Higher = fewer but more relevant
                        hints. Range 0.30–0.95, default 0.55.
                      </span>
                      <input
                        class="config-input"
                        type="number"
                        min={0.3}
                        max={0.95}
                        step={0.05}
                        value={autoSearchScoreThreshold()}
                        onInput={(e) => {
                          const v = e.currentTarget.value;
                          setAutoSearch({
                            score_threshold: v ? Math.max(0.3, Math.min(0.95, Number(v))) : 0.55,
                          });
                        }}
                      />
                    </div>
                    <div class="config-field">
                      <div class="config-field-header">
                        <span class="config-field-label">Min Prompt Chars</span>
                        <span class="config-field-key">memory.auto_search.min_prompt_chars</span>
                      </div>
                      <span class="config-field-desc">
                        Skip the hint when a user message is shorter than this. Avoids embedding
                        cost on trivial replies. Range 5–500, default 20.
                      </span>
                      <input
                        class="config-input"
                        type="number"
                        min={5}
                        max={500}
                        value={autoSearchMinChars()}
                        onInput={(e) => {
                          const v = e.currentTarget.value;
                          setAutoSearch({
                            min_prompt_chars: v ? Math.max(5, Math.min(500, Number(v))) : 20,
                          });
                        }}
                      />
                    </div>
                  </Show>

                  {/* Git commit indexing */}
                  <div class="config-field">
                    <div class="config-field-header">
                      <span class="config-field-label">Git Commit Indexing</span>
                      <span class="config-field-key">memory.git_commit_indexing.enabled</span>
                    </div>
                    <span class="config-field-desc">
                      Index <code>HEAD</code> non-merge commits into <code>ctx_search</code> as a
                      4th source alongside memories, facts, and message history. Useful for agents
                      recalling regressions, prior fixes, and decisions without running{" "}
                      <code>git log</code> manually. Off by default.
                    </span>
                    <label class="toggle-switch">
                      <input
                        type="checkbox"
                        checked={gitCommitEnabled()}
                        onChange={(e) => setGitCommit({ enabled: e.currentTarget.checked })}
                      />
                      <span class="toggle-slider" />
                      <span class="toggle-label">
                        {gitCommitEnabled() ? "Enabled" : "Disabled"}
                      </span>
                    </label>
                  </div>

                  <Show when={gitCommitEnabled()}>
                    <div class="config-field">
                      <div class="config-field-header">
                        <span class="config-field-label">History Window (days)</span>
                        <span class="config-field-key">memory.git_commit_indexing.since_days</span>
                      </div>
                      <span class="config-field-desc">
                        Days of HEAD history to index. Older commits are excluded from search. Range
                        7–3650, default 365.
                      </span>
                      <input
                        class="config-input"
                        type="number"
                        min={7}
                        max={3650}
                        value={gitCommitSinceDays()}
                        onInput={(e) => {
                          const v = e.currentTarget.value;
                          setGitCommit({
                            since_days: v ? Math.max(7, Math.min(3650, Number(v))) : 365,
                          });
                        }}
                      />
                    </div>
                    <div class="config-field">
                      <div class="config-field-header">
                        <span class="config-field-label">Max Commits</span>
                        <span class="config-field-key">memory.git_commit_indexing.max_commits</span>
                      </div>
                      <span class="config-field-desc">
                        Maximum commits kept per project. Oldest evicted when the cap is reached.
                        Range 100–20000, default 2000.
                      </span>
                      <input
                        class="config-input"
                        type="number"
                        min={100}
                        max={20000}
                        value={gitCommitMaxCommits()}
                        onInput={(e) => {
                          const v = e.currentTarget.value;
                          setGitCommit({
                            max_commits: v ? Math.max(100, Math.min(20000, Number(v))) : 2000,
                          });
                        }}
                      />
                    </div>
                  </Show>

                  {/* Caveman text compression */}
                  <div class="config-field">
                    <div class="config-field-header">
                      <span class="config-field-label">Caveman Text Compression</span>
                      <span class="config-field-key">caveman_text_compression.enabled</span>
                    </div>
                    <span class="config-field-desc">
                      Age-tiered compression for long user/assistant text parts. Active for primary
                      sessions when enabled; subagents are excluded because their context is curated
                      by the parent. Outside the protected tail, oldest 20% of eligible tags get
                      ultra compression, next 20% full, next 20% lite, newest 40% untouched. Always
                      compresses from the original source, so depth shifts are equivalent to
                      compressing the original text directly. Off by default.
                    </span>
                    <label class="toggle-switch">
                      <input
                        type="checkbox"
                        checked={cavemanEnabled()}
                        onChange={(e) => setCaveman({ enabled: e.currentTarget.checked })}
                      />
                      <span class="toggle-slider" />
                      <span class="toggle-label">{cavemanEnabled() ? "Enabled" : "Disabled"}</span>
                    </label>
                  </div>

                  <Show when={cavemanEnabled()}>
                    <div class="config-field">
                      <div class="config-field-header">
                        <span class="config-field-label">Min Chars</span>
                        <span class="config-field-key">caveman_text_compression.min_chars</span>
                      </div>
                      <span class="config-field-desc">
                        Text parts shorter than this are left untouched. Range 100–10000, default
                        500.
                      </span>
                      <input
                        class="config-input"
                        type="number"
                        min={100}
                        max={10000}
                        step={50}
                        value={cavemanMinChars()}
                        onInput={(e) => {
                          const v = e.currentTarget.value;
                          setCaveman({
                            min_chars: v ? Math.max(100, Math.min(10000, Number(v))) : 500,
                          });
                        }}
                      />
                    </div>
                  </Show>
                </div>
              </div>
            );
          })()}

          {/* Advanced — power-user / debug knobs. Full-width, rendered last. */}
          {(() => {
            const autoUpdate = () => {
              const v = getNestedValue(formData(), "auto_update");
              return v == null ? true : Boolean(v);
            };
            const keepSubagents = () => Boolean(getNestedValue(formData(), "keep_subagents"));
            const todowrite = () =>
              (getNestedValue(formData(), "todowrite") as
                | { enabled?: boolean; overlay?: boolean }
                | undefined) ?? {};
            const todowriteEnabled = () => todowrite().enabled ?? true;
            const todowriteOverlay = () => todowrite().overlay ?? true;
            const setTodowrite = (patch: Record<string, unknown>) =>
              handleFieldChange("todowrite", { ...todowrite(), ...patch });
            const smartDrops = () => Boolean(getNestedValue(formData(), "smart_drops"));
            const sqlite = () =>
              (getNestedValue(formData(), "sqlite") as
                | { cache_size_mb?: number; mmap_size_mb?: number }
                | undefined) ?? {};
            const sqliteCacheMb = () => sqlite().cache_size_mb ?? 64;
            const sqliteMmapMb = () => sqlite().mmap_size_mb ?? 0;
            const setSqlite = (patch: Record<string, unknown>) =>
              handleFieldChange("sqlite", { ...sqlite(), ...patch });
            const systemPromptInjectionEnabled = () => {
              const v = getNestedValue(formData(), "system_prompt_injection.enabled");
              return v == null ? true : Boolean(v);
            };
            const compactionEnabled = () => {
              const v = getNestedValue(formData(), "compaction.enabled");
              return v == null ? true : Boolean(v);
            };
            const storagePrivatePermissions = () => {
              const v = getNestedValue(formData(), "storage.enforce_private_permissions");
              return v == null ? true : Boolean(v);
            };
            const piExtensions = () => {
              const value = getNestedValue(formData(), "pi.subagent_extensions");
              return Array.isArray(value)
                ? value.filter((entry): entry is string => typeof entry === "string")
                : [];
            };
            const piExtensionsText = () => piExtensions().join("\n");

            return (
              <div class="config-card full-width">
                <div class="config-card-header">
                  <span class="config-card-icon">🛠️</span>
                  <span class="config-card-title">Advanced</span>
                </div>
                <div class="config-card-content">
                  <div
                    class="config-field-desc"
                    style={{ "margin-bottom": "8px", opacity: "0.85" }}
                  >
                    Power-user and debug settings. Most users never need these.
                  </div>

                  <Show when={isUserScope()}>
                    {/* Auto update */}
                    <div class="config-field">
                      <div class="config-field-header">
                        <span class="config-field-label">Auto Update</span>
                        <span class="config-field-key">auto_update</span>
                      </div>
                      <span class="config-field-desc">
                        Automatically self-update the OpenCode plugin to the latest published
                        version on startup. On by default. (User-config only — project configs
                        cannot change it.)
                      </span>
                      <label class="toggle-switch">
                        <input
                          type="checkbox"
                          checked={autoUpdate()}
                          onChange={(e) =>
                            handleFieldChange("auto_update", e.currentTarget.checked)
                          }
                        />
                        <span class="toggle-slider" />
                        <span class="toggle-label">{autoUpdate() ? "Enabled" : "Disabled"}</span>
                      </label>
                    </div>
                  </Show>

                  {/* Keep subagents */}
                  <div class="config-field">
                    <div class="config-field-header">
                      <span class="config-field-label">Keep Subagent Sessions</span>
                      <span class="config-field-key">keep_subagents</span>
                    </div>
                    <span class="config-field-desc">
                      Retain the child sessions magic-context spawns for its own agents (historian,
                      dreamer, sidekick, memory migration, key-files, user-memory). By default these
                      are deleted on success; enable this to keep their full transcript and token
                      usage for debugging. Kept sessions accumulate until cleared. Off by default.
                    </span>
                    <label class="toggle-switch">
                      <input
                        type="checkbox"
                        checked={keepSubagents()}
                        onChange={(e) =>
                          handleFieldChange("keep_subagents", e.currentTarget.checked)
                        }
                      />
                      <span class="toggle-slider" />
                      <span class="toggle-label">{keepSubagents() ? "Enabled" : "Disabled"}</span>
                    </label>
                  </div>

                  {/* Pi todowrite */}
                  <div class="config-field">
                    <div class="config-field-header">
                      <span class="config-field-label">Pi Todowrite Tool</span>
                      <span class="config-field-key">todowrite.enabled</span>
                    </div>
                    <span class="config-field-desc">
                      Register Magic Context&apos;s Pi <code>todowrite</code> task-list tool.
                      Disable this if you use another Pi todo extension. OpenCode has its own
                      built-in todowrite, so this setting only affects Pi. Requires /reload or
                      restart after changing.
                    </span>
                    <label class="toggle-switch">
                      <input
                        type="checkbox"
                        checked={todowriteEnabled()}
                        onChange={(e) => setTodowrite({ enabled: e.currentTarget.checked })}
                      />
                      <span class="toggle-slider" />
                      <span class="toggle-label">
                        {todowriteEnabled() ? "Enabled" : "Disabled"}
                      </span>
                    </label>
                  </div>

                  <Show when={todowriteEnabled()}>
                    <div class="config-field">
                      <div class="config-field-header">
                        <span class="config-field-label">Pi Todo Overlay</span>
                        <span class="config-field-key">todowrite.overlay</span>
                      </div>
                      <span class="config-field-desc">
                        Show the persistent todo overlay above the editor while tasks are active.
                        The /todos command and tool remain available when only the overlay is off.
                      </span>
                      <label class="toggle-switch">
                        <input
                          type="checkbox"
                          checked={todowriteOverlay()}
                          onChange={(e) => setTodowrite({ overlay: e.currentTarget.checked })}
                        />
                        <span class="toggle-slider" />
                        <span class="toggle-label">
                          {todowriteOverlay() ? "Enabled" : "Disabled"}
                        </span>
                      </label>
                    </div>
                  </Show>

                  <Show when={isUserScope()}>
                    <div class="config-field">
                      <div class="config-field-header">
                        <span class="config-field-label">Compaction Management</span>
                        <span class="config-field-key">compaction.enabled</span>
                      </div>
                      <span class="config-field-desc">
                        Let Magic Context manage the context window. Turn this off to keep memory
                        and search features while native compaction (or nothing) owns the window.
                        Requires a restart and applies only to user configuration.
                      </span>
                      <label class="toggle-switch">
                        <input
                          type="checkbox"
                          checked={compactionEnabled()}
                          onChange={(e) =>
                            handleFieldChange("compaction.enabled", e.currentTarget.checked)
                          }
                        />
                        <span class="toggle-slider" />
                        <span class="toggle-label">
                          {compactionEnabled() ? "Enabled" : "Disabled"}
                        </span>
                      </label>
                    </div>
                    <div class="config-field">
                      <div class="config-field-header">
                        <span class="config-field-label">Private Storage Permissions</span>
                        <span class="config-field-key">storage.enforce_private_permissions</span>
                      </div>
                      <span class="config-field-desc">
                        Keep Magic Context directories owner-only (0700) and files owner-only
                        (0600). Disable only when a trusted group manages permissions externally.
                      </span>
                      <label class="toggle-switch">
                        <input
                          type="checkbox"
                          checked={storagePrivatePermissions()}
                          onChange={(e) =>
                            handleFieldChange(
                              "storage.enforce_private_permissions",
                              e.currentTarget.checked,
                            )
                          }
                        />
                        <span class="toggle-slider" />
                        <span class="toggle-label">
                          {storagePrivatePermissions() ? "Enabled" : "Disabled"}
                        </span>
                      </label>
                    </div>
                    <div class="config-field">
                      <div class="config-field-header">
                        <span class="config-field-label">Pi Subagent Extensions</span>
                        <span class="config-field-key">pi.subagent_extensions</span>
                      </div>
                      <span class="config-field-desc">
                        Optional user-level allowlist for extensions loaded by Pi subagent children.
                        Enter one extension path or package per line.
                      </span>
                      <textarea
                        class="code-editor"
                        rows={4}
                        value={piExtensionsText()}
                        placeholder="extensions/my-tools.ts"
                        onInput={(e) => {
                          const entries = e.currentTarget.value
                            .split("\n")
                            .map((entry) => entry.trim())
                            .filter(Boolean);
                          handleFieldChange(
                            "pi.subagent_extensions",
                            entries.length > 0 ? entries : undefined,
                          );
                        }}
                      />
                    </div>
                  </Show>

                  {/* Smart drops */}
                  <div class="config-field">
                    <div class="config-field-header">
                      <span class="config-field-label">Smart Drops</span>
                      <span class="config-field-key">smart_drops</span>
                    </div>
                    <span class="config-field-desc">
                      Experimental: content-aware reclaim of provably-superseded tool output, on top
                      of the existing auto-drop. Drops superseded todowrite, spent ctx_reduce, and
                      zero-value status outputs, and compresses older edits to a file while keeping
                      the newest. Only acts on passes already busting the cache, so it never causes
                      a cache bust on its own. Off by default while cache stability is being proven.
                    </span>
                    <label class="toggle-switch">
                      <input
                        type="checkbox"
                        checked={smartDrops()}
                        onChange={(e) => handleFieldChange("smart_drops", e.currentTarget.checked)}
                      />
                      <span class="toggle-slider" />
                      <span class="toggle-label">{smartDrops() ? "Enabled" : "Disabled"}</span>
                    </label>
                  </div>

                  {/* System prompt injection */}
                  <div class="config-field">
                    <div class="config-field-header">
                      <span class="config-field-label">System Prompt Injection</span>
                      <span class="config-field-key">system_prompt_injection.enabled</span>
                    </div>
                    <span class="config-field-desc">
                      Inject the magic-context guidance text into the system prompt. On by default.
                      Disabling it stops the guidance block entirely. To exclude only specific
                      custom agents, set <code>system_prompt_injection.skip_signatures</code> (a
                      substring list) in the raw editor.
                    </span>
                    <label class="toggle-switch">
                      <input
                        type="checkbox"
                        checked={systemPromptInjectionEnabled()}
                        onChange={(e) =>
                          handleFieldChange(
                            "system_prompt_injection.enabled",
                            e.currentTarget.checked,
                          )
                        }
                      />
                      <span class="toggle-slider" />
                      <span class="toggle-label">
                        {systemPromptInjectionEnabled() ? "Enabled" : "Disabled"}
                      </span>
                    </label>
                  </div>

                  <Show when={isUserScope()}>
                    {/* SQLite tuning */}
                    <div class="config-field">
                      <div class="config-field-header">
                        <span class="config-field-label">SQLite Cache (MB)</span>
                        <span class="config-field-key">sqlite.cache_size_mb</span>
                      </div>
                      <span class="config-field-desc">
                        Per-connection page-cache size in MB. Higher reduces disk reads on large
                        databases at the cost of memory. Range 8–1024, default 64.
                      </span>
                      <input
                        class="config-input"
                        type="number"
                        min={8}
                        max={1024}
                        value={sqliteCacheMb()}
                        onInput={(e) => {
                          const v = e.currentTarget.value;
                          setSqlite({
                            cache_size_mb: v ? Math.max(8, Math.min(1024, Number(v))) : 64,
                          });
                        }}
                      />
                    </div>
                    <div class="config-field">
                      <div class="config-field-header">
                        <span class="config-field-label">SQLite mmap (MB)</span>
                        <span class="config-field-key">sqlite.mmap_size_mb</span>
                      </div>
                      <span class="config-field-desc">
                        Memory-mapped I/O size in MB. 0 disables mmap. Can speed up large reads on
                        some filesystems. Range 0–4096, default 0.
                      </span>
                      <input
                        class="config-input"
                        type="number"
                        min={0}
                        max={4096}
                        value={sqliteMmapMb()}
                        onInput={(e) => {
                          const v = e.currentTarget.value;
                          setSqlite({
                            mmap_size_mb: v ? Math.max(0, Math.min(4096, Number(v))) : 0,
                          });
                        }}
                      />
                    </div>
                  </Show>
                </div>
              </div>
            );
          })()}
        </div>
      </Show>
    </div>
  );
}

// ── ProjectConfigDetail ─────────────────────────────────────

function ProjectConfigDetail(props: {
  entry: ProjectConfigEntry;
  onBack: () => void;
  models: string[];
  opencodeInstallState: OpencodeInstallState;
}) {
  const configPath = () => props.entry.config_path;

  const [config] = createResource(
    () => configPath(),
    async () => getConfig("project", props.entry.worktree),
  );

  const projectReadBlocker = createMemo(() =>
    configSaveBlocker({
      exists: config()?.exists ?? false,
      readError: config()?.error,
    }),
  );
  const [saveStatus, setSaveStatus] = createSignal<string | null>(null);

  const handleSave = async (content: string) => {
    try {
      await saveProjectConfig(props.entry.worktree, content);
      setSaveStatus("✓ Saved");
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      setSaveStatus(`✕ Error: ${err}`);
      setTimeout(() => setSaveStatus(null), 4000);
    }
  };

  return (
    <div>
      <div
        style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "12px" }}
      >
        <button type="button" class="btn sm" onClick={props.onBack}>
          ← Back
        </button>
        <span style={{ "font-weight": "600" }}>{props.entry.project_name}</span>
      </div>
      <table class="kv-table" style={{ "margin-bottom": "12px" }}>
        <tbody>
          <tr>
            <td>Path</td>
            <td style={{ "word-break": "break-all" }}>{configPath()}</td>
          </tr>
          <tr>
            <td>Worktree</td>
            <td style={{ "word-break": "break-all" }}>{props.entry.worktree}</td>
          </tr>
        </tbody>
      </table>
      <Show when={config()} fallback={<div class="empty-state">Loading...</div>}>
        <Show
          when={projectReadBlocker()}
          fallback={
            <ConfigForm
              content={config()?.content ?? ""}
              exists={config()?.exists ?? true}
              readError={config()?.error}
              onSave={handleSave}
              saveStatus={saveStatus()}
              models={props.models}
              opencodeInstallState={props.opencodeInstallState}
              scope="project"
            />
          }
        >
          {(message) => <div class="empty-state">{message()}</div>}
        </Show>
      </Show>
    </div>
  );
}

// ── Main ConfigEditor ───────────────────────────────────────

export default function ConfigEditor(props: {
  models: string[];
  piModels: string[];
  opencodeInstallState: OpencodeInstallState;
}) {
  const [configTarget, setConfigTarget] = createSignal<ConfigTarget>(loadConfigTarget());
  const [userConfig, { refetch: refetchUser }] = createResource(() => getConfig("user"));
  const [projectConfigs, { refetch: refetchProjects }] = createResource(getProjectConfigs);
  const [saveStatus, setSaveStatus] = createSignal<string | null>(null);
  const [selectedProject, setSelectedProject] = createSignal<ProjectConfigEntry | null>(null);
  const userReadBlocker = createMemo(() =>
    configSaveBlocker({
      exists: userConfig()?.exists ?? false,
      readError: userConfig()?.error,
    }),
  );

  const effectiveModels = createMemo(() => getEffectiveModelIds(props.piModels, props.models));

  const selectConfigTarget = (next: ConfigTarget) => {
    setConfigTarget(next);
    setSaveStatus(null);
    if (next === "projects") {
      setSelectedProject(null);
      return;
    }
    try {
      localStorage.setItem(CONFIG_TAB_STORAGE_KEY, next);
    } catch {
      // Ignore localStorage failures; in-memory tab selection still works.
    }
    refetchUser();
  };

  const handleUserSave = async (content: string) => {
    try {
      await saveConfig("user", content);
      refetchUser();
      setSaveStatus("✓ Saved");
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      setSaveStatus(`✕ Error: ${err}`);
      setTimeout(() => setSaveStatus(null), 4000);
    }
  };

  const handleCreateUserDefaults = async () => {
    await handleUserSave(USER_DEFAULT_CONFIG);
  };

  return (
    <>
      <div class="section-header">
        <h1 class="section-title">Configuration</h1>
        <div class="section-actions">
          <button
            type="button"
            class="btn sm"
            onClick={() => {
              refetchUser();
              refetchProjects();
            }}
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      <div class="tab-pills">
        <button
          type="button"
          class={`tab-pill ${configTarget() === "user" ? "active" : ""}`}
          onClick={() => selectConfigTarget("user")}
        >
          User Config
        </button>
        <button
          type="button"
          class={`tab-pill ${configTarget() === "projects" ? "active" : ""}`}
          onClick={() => selectConfigTarget("projects")}
        >
          Project Configs
          <Show when={(projectConfigs() ?? []).length > 0}>
            <span class="category-count" style={{ "margin-left": "4px" }}>
              ({projectConfigs()?.length})
            </span>
          </Show>
        </button>
      </div>

      <div class="scroll-area">
        <Show when={configTarget() !== "projects"}>
          <Show
            when={!userConfig.loading}
            fallback={<div class="empty-state">Loading config...</div>}
          >
            <div style={{ "margin-bottom": "8px" }}>
              <table class="kv-table">
                <tbody>
                  <tr>
                    <td>Path</td>
                    <td style={{ "word-break": "break-all" }}>{userConfig()?.path ?? "—"}</td>
                  </tr>
                </tbody>
              </table>
              <p style={{ "font-size": "11px", color: "var(--text-muted)", margin: "4px 0 0" }}>
                Shared CortexKit user config (OpenCode and Pi)
              </p>
            </div>
            <Show
              when={userConfig()?.exists}
              fallback={
                <div class="empty-state">
                  <span class="empty-state-icon">⚙️</span>
                  <span>No user config found at {userConfig()?.path}</span>
                  <span style={{ "font-size": "11px" }}>
                    Run <code>npx @cortexkit/magic-context setup</code> or create with defaults
                  </span>
                  <button type="button" class="btn" onClick={handleCreateUserDefaults}>
                    Create with defaults
                  </button>
                  <Show when={saveStatus()}>
                    <span style={{ "font-size": "11px" }}>{saveStatus()}</span>
                  </Show>
                </div>
              }
            >
              <Show
                when={userReadBlocker()}
                fallback={
                  <ConfigForm
                    content={userConfig()?.content ?? ""}
                    exists={userConfig()?.exists ?? true}
                    readError={userConfig()?.error}
                    onSave={handleUserSave}
                    saveStatus={saveStatus()}
                    models={effectiveModels()}
                    opencodeInstallState={props.opencodeInstallState}
                    scope="user"
                  />
                }
              >
                {(message) => <div class="empty-state">{message()}</div>}
              </Show>
            </Show>
          </Show>
        </Show>

        <Show when={configTarget() === "projects"}>
          <Show
            when={selectedProject()}
            fallback={
              (projectConfigs() ?? []).length > 0 ? (
                <div class="list-gap">
                  <For each={projectConfigs() ?? []}>
                    {(entry) => (
                      <button
                        type="button"
                        class="card"
                        style={{ cursor: "pointer", "text-align": "left", width: "100%" }}
                        onClick={() => setSelectedProject(entry)}
                      >
                        <div class="card-title">
                          <span class="pill blue">project</span>
                          <span style={{ "margin-left": "8px", "font-weight": "600" }}>
                            {entry.project_name}
                          </span>
                        </div>
                        <div class="card-meta">
                          <span>{entry.worktree}</span>
                          <span>·</span>
                          <span>.cortexkit/magic-context.jsonc</span>
                        </div>
                      </button>
                    )}
                  </For>
                </div>
              ) : (
                <div class="empty-state">
                  <span class="empty-state-icon">📁</span>
                  <span>No project-level configs found</span>
                  <span style={{ "font-size": "11px" }}>
                    Create <code>.cortexkit/magic-context.jsonc</code> in a project to add
                    project-specific overrides
                  </span>
                </div>
              )
            }
          >
            {(proj) => (
              <ProjectConfigDetail
                entry={proj()}
                onBack={() => setSelectedProject(null)}
                models={effectiveModels()}
                opencodeInstallState={props.opencodeInstallState}
              />
            )}
          </Show>
        </Show>
      </div>
    </>
  );
}
