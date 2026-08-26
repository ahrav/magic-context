import { createEffect, createSignal, For, on, Show } from "solid-js";
import { formatTimestamp } from "../../lib/api";
import type { ClaimMemory } from "../../lib/types";
import FilterSelect from "../shared/FilterSelect";
import { SHARE_CATEGORY_OPTIONS } from "../WorkspacesPanel/workspace-staging";

interface Props {
  memory: ClaimMemory;
  draft: string;
  revisionAdvanced: boolean;
  onDraftChange: (content: string) => void;
  onDiscardDraft: () => void;
  onClose: () => void;
  onLifecycleChange: (memory: ClaimMemory, state: "active" | "archived") => Promise<boolean>;
  onContentChange: (memory: ClaimMemory, content: string) => Promise<boolean>;
  onCategoryChange: (memory: ClaimMemory, category: string) => Promise<boolean>;
}

export default function MemoryDetail(props: Props) {
  const [editing, setEditing] = createSignal(false);

  // The parent renders this panel through a non-keyed `Show`, whose child
  // callback re-runs only on falsy<->truthy transitions of its condition. This
  // instance therefore survives a change of focused claim, so the editor has to
  // close itself or clicking a second claim would open straight into an edit
  // box holding the first claim's draft. Keyed on the public claim id rather
  // than the object, so a refetch of the same claim leaves an open editor
  // alone.
  createEffect(
    on(
      () => props.memory.publicClaimId,
      () => setEditing(false),
      { defer: true },
    ),
  );

  const handleSave = async () => {
    if (await props.onContentChange(props.memory, props.draft)) setEditing(false);
  };

  return (
    <div class="slide-panel-overlay">
      <button
        type="button"
        class="slide-panel-backdrop"
        onClick={props.onClose}
        style={{
          background: "transparent",
          border: "none",
          position: "absolute",
          inset: 0,
          cursor: "pointer",
        }}
        aria-label="Close panel"
      />
      <div class="slide-panel">
        <div
          style={{
            display: "flex",
            "justify-content": "space-between",
            "align-items": "center",
            "margin-bottom": "16px",
          }}
        >
          <h2 style={{ "font-size": "15px", "font-weight": "600" }}>
            {props.memory.publicClaimId}
          </h2>
          <button type="button" class="btn sm" onClick={props.onClose}>
            ✕ Close
          </button>
        </div>

        <Show when={props.revisionAdvanced}>
          <div
            class="card"
            style={{ padding: "8px", "margin-bottom": "12px", color: "var(--warning)" }}
          >
            Claim advanced while this draft was open. Draft preserved. Review before saving.
          </div>
        </Show>

        <table class="kv-table" style={{ "margin-bottom": "16px" }}>
          <tbody>
            <tr>
              <td>Category</td>
              <td>
                <FilterSelect
                  compact
                  value={props.memory.category}
                  onChange={(category) => void props.onCategoryChange(props.memory, category)}
                  options={SHARE_CATEGORY_OPTIONS}
                />
              </td>
            </tr>
            <tr>
              <td>Lifecycle</td>
              <td>
                <FilterSelect
                  compact
                  value={props.memory.lifecycleState}
                  onChange={(state) =>
                    void props.onLifecycleChange(props.memory, state as "active" | "archived")
                  }
                  options={[
                    { value: "active", label: "active" },
                    { value: "archived", label: "archived" },
                  ]}
                />
              </td>
            </tr>
            <tr>
              <td>Revision</td>
              <td>{props.memory.revision}</td>
            </tr>
            <tr>
              <td>Project</td>
              <td style={{ "word-break": "break-all" }}>{props.memory.projectIdentity}</td>
            </tr>
            <tr>
              <td>Maturity</td>
              <td>{props.memory.policy.effectiveMaturity}</td>
            </tr>
            <tr>
              <td>Origin</td>
              <td>{props.memory.policy.originTaint}</td>
            </tr>
            <tr>
              <td>Importance</td>
              <td>{props.memory.importance} / 100</td>
            </tr>
            <tr>
              <td>Scope</td>
              <td>
                {props.memory.memoryScope} · {props.memory.sharing}
              </td>
            </tr>
          </tbody>
        </table>

        <div style={{ "margin-bottom": "16px" }}>
          <Show
            when={editing()}
            fallback={
              <div>
                <div
                  style={{
                    background: "var(--bg-base)",
                    border: "1px solid var(--border)",
                    "border-radius": "var(--radius-md)",
                    padding: "12px",
                    "font-family": "var(--mono-font)",
                    "font-size": "12px",
                    "line-height": "1.6",
                    "white-space": "pre-wrap",
                    "word-break": "break-word",
                    "max-height": "200px",
                    "overflow-y": "auto",
                  }}
                >
                  {props.memory.content}
                </div>
                <button
                  type="button"
                  class="btn sm"
                  style={{ "margin-top": "8px" }}
                  onClick={() => setEditing(true)}
                >
                  Edit Content
                </button>
              </div>
            }
          >
            <textarea
              class="code-editor"
              style={{ "min-height": "150px" }}
              value={props.draft}
              onInput={(event) => props.onDraftChange(event.currentTarget.value)}
            />
            <div style={{ display: "flex", gap: "8px", "margin-top": "8px" }}>
              <button type="button" class="btn primary sm" onClick={handleSave}>
                Save
              </button>
              <button
                type="button"
                class="btn sm"
                onClick={() => {
                  props.onDiscardDraft();
                  setEditing(false);
                }}
              >
                Discard Draft
              </button>
            </div>
          </Show>
        </div>

        <div class="category-header">Evidence</div>
        <div style={{ "margin-bottom": "16px", "font-size": "12px" }}>
          <For each={props.memory.evidenceLabels}>
            {(evidence) => (
              <div>
                {evidence.sourceTrustClass} · {evidence.extractor} · {evidence.independenceKey}
              </div>
            )}
          </For>
        </div>

        <div class="category-header">Telemetry</div>
        <table class="kv-table" style={{ "margin-bottom": "16px" }}>
          <tbody>
            <tr>
              <td>Seen</td>
              <td>{props.memory.telemetry.seenCount} times</td>
            </tr>
            <tr>
              <td>Retrieved</td>
              <td>{props.memory.telemetry.retrievalCount} times</td>
            </tr>
            <tr>
              <td>Revision created</td>
              <td>{formatTimestamp(props.memory.revisionCreatedAt)}</td>
            </tr>
          </tbody>
        </table>

        <div
          style={{
            display: "flex",
            gap: "8px",
            "padding-top": "12px",
            "border-top": "1px solid var(--border)",
          }}
        >
          <Show when={props.memory.lifecycleState !== "archived"}>
            <button
              type="button"
              class="btn sm"
              onClick={() => void props.onLifecycleChange(props.memory, "archived")}
            >
              Archive
            </button>
          </Show>
          <Show when={props.memory.lifecycleState === "archived"}>
            <button
              type="button"
              class="btn sm"
              onClick={() => void props.onLifecycleChange(props.memory, "active")}
            >
              Restore
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
