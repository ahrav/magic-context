import { createEffect, createResource, createSignal, For, Show } from "solid-js";

import {
  bulkArchiveMemories,
  claimMutationTarget,
  enumerateMemoryProjects,
  formatRelativeTime,
  getMemories,
  getMemoryStats,
  reviseMemoryCategory,
  reviseMemoryContent,
  setMemoryLifecycle,
  truncate,
} from "../../lib/api";
import { ask } from "../../lib/platform";
import type { ClaimLifecycleState, ClaimMemory } from "../../lib/types";
import FilterSelect from "../shared/FilterSelect";
import {
  type ClaimDraft,
  reconcileClaimSelection,
  reconcileDraft,
  type SelectionEntry,
  selectionState,
  selectionTargets,
  toggleClaimSelection,
  toggleClaimsSelection,
} from "./claim-selection";
import MemoryDetail from "./MemoryDetail";

interface MemoryBrowserProps {
  project?: { identity: string; label: string };
}

function operationKey(action: string): string {
  return `dashboard:${action}:${crypto.randomUUID()}`;
}

function statusPillClass(status: ClaimLifecycleState): string {
  if (status === "active") return "green";
  if (status === "retired") return "red";
  return "gray";
}

function importanceBand(importance: number): { label: string; cls: string } {
  if (importance >= 80) return { label: "critical", cls: "red" };
  if (importance >= 60) return { label: "high", cls: "amber" };
  if (importance >= 40) return { label: "medium", cls: "blue" };
  return { label: "low", cls: "gray" };
}

export default function MemoryBrowser(props: MemoryBrowserProps = {}) {
  const [projectFilter, setProjectFilter] = createSignal("");
  const [lifecycleFilter, setLifecycleFilter] = createSignal<ClaimLifecycleState | "">("");
  const [categoryFilter, setCategoryFilter] = createSignal("");
  const [searchQuery, setSearchQuery] = createSignal("");
  const [visibleClaims, setVisibleClaims] = createSignal<ClaimMemory[]>([]);
  const [selected, setSelected] = createSignal<Map<string, SelectionEntry>>(new Map());
  const [focusedClaim, setFocusedClaim] = createSignal<ClaimMemory | null>(null);
  const [drafts, setDrafts] = createSignal<Map<string, ClaimDraft>>(new Map());
  const [error, setError] = createSignal<string | null>(null);

  const [projects] = createResource(enumerateMemoryProjects);
  const fetchParams = () => ({
    project: props.project?.identity ?? (projectFilter() || undefined),
    lifecycle: lifecycleFilter() || undefined,
    category: categoryFilter() || undefined,
    search: searchQuery() || undefined,
    limit: 200,
    offset: 0,
  });
  const [memories, { refetch: refetchMemories }] = createResource(fetchParams, getMemories);
  // The source stays an OBJECT so it is never nullish: Solid treats a
  // `undefined`/`null`/`false` source as a disabled resource and skips the
  // fetcher entirely, which would leave stats unloaded on a project-less mount
  // while the claim list above still fetches. An absent project is a `project:
  // undefined` field, which `getMemoryStats` sends as `null` for global stats.
  const [stats, { refetch: refetchStats }] = createResource(
    () => ({ project: props.project?.identity ?? (projectFilter() || undefined) }),
    getMemoryStats,
  );

  createEffect(() => {
    const result = memories();
    if (!result) return;
    if (result.outcome === "stale") {
      setError(result.staleReasons.join("; ") || "Claim snapshot changed during refresh");
      return;
    }
    setVisibleClaims(result.claims);
    setSelected((previous) => reconcileClaimSelection(previous, result.claims));
    setFocusedClaim((previous) => {
      if (!previous) return null;
      return (
        result.claims.find((claim) => claim.publicClaimId === previous.publicClaimId) ?? previous
      );
    });
    setDrafts((previous) => {
      const next = new Map(previous);
      for (const [publicClaimId, draft] of previous) {
        const claim = result.claims.find((item) => item.publicClaimId === publicClaimId);
        const reconciled = reconcileDraft(draft, claim);
        if (reconciled) next.set(publicClaimId, reconciled);
      }
      return next;
    });
  });

  const groupedClaims = () => {
    const groups = new Map<string, ClaimMemory[]>();
    for (const claim of visibleClaims()) {
      const group = groups.get(claim.category) ?? [];
      group.push(claim);
      groups.set(claim.category, group);
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  };

  const focus = (claim: ClaimMemory) => {
    setFocusedClaim(claim);
    setDrafts((previous) => {
      if (previous.has(claim.publicClaimId)) return previous;
      const next = new Map(previous);
      next.set(claim.publicClaimId, {
        publicClaimId: claim.publicClaimId,
        revisionLocator: claim.revisionLocator,
        text: claim.content,
        revisionAdvanced: false,
      });
      return next;
    });
  };

  const refresh = () => {
    void refetchMemories();
    void refetchStats();
  };

  const handleMutation = async (
    action: () => Promise<{ outcome: string; refreshedClaims: ClaimMemory[] }>,
    failure: string,
  ): Promise<boolean> => {
    try {
      setError(null);
      const response = await action();
      if (response.outcome === "stale") {
        setError("Claim changed before this edit committed. Review refreshed content and retry.");
        refresh();
        return false;
      }
      refresh();
      return true;
    } catch (cause: unknown) {
      setError(`${failure}: ${cause instanceof Error ? cause.message : String(cause)}`);
      return false;
    }
  };

  const handleLifecycleChange = (claim: ClaimMemory, state: "active" | "archived") =>
    handleMutation(
      () => setMemoryLifecycle(claimMutationTarget(claim), operationKey("lifecycle"), state),
      "Failed to update lifecycle",
    );

  const handleContentChange = async (claim: ClaimMemory, content: string) => {
    const saved = await handleMutation(
      () => reviseMemoryContent(claimMutationTarget(claim), operationKey("content"), content),
      "Failed to update content",
    );
    if (saved) {
      setDrafts((previous) => {
        const next = new Map(previous);
        next.delete(claim.publicClaimId);
        return next;
      });
    }
    return saved;
  };

  const handleCategoryChange = (claim: ClaimMemory, category: string) =>
    handleMutation(
      () => reviseMemoryCategory(claimMutationTarget(claim), operationKey("category"), category),
      "Failed to update category",
    );

  const handleBulkArchive = async () => {
    if (selected().size === 0) return;
    let targets: ReturnType<typeof selectionTargets>;
    try {
      targets = selectionTargets(selected());
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    const confirmed = await ask(
      `Archive ${targets.length} memor${targets.length === 1 ? "y" : "ies"}?`,
      { title: "Confirm Archive", kind: "warning" },
    );
    if (!confirmed) return;
    const archived = await handleMutation(
      () => bulkArchiveMemories(targets, operationKey("bulk-archive")),
      "Failed to archive memories",
    );
    if (archived) setSelected(new Map());
  };

  const selectedCount = () => selected().size;
  const staleSelectedCount = () => [...selected().values()].filter((entry) => entry.stale).length;
  const allVisibleState = () => selectionState(selected(), visibleClaims());
  const draftForFocused = () => {
    const claim = focusedClaim();
    return claim ? drafts().get(claim.publicClaimId) : undefined;
  };

  return (
    <>
      <Show when={error()}>
        {(message) => (
          <div style={{ padding: "8px 20px" }}>
            <div class="card" style={{ color: "var(--error-text, #ef4444)", padding: "8px 12px" }}>
              {message()}
            </div>
          </div>
        )}
      </Show>

      <Show when={props.project == null}>
        <div class="section-header">
          <h1 class="section-title">Memories</h1>
          <Show when={stats()}>
            {(value) => (
              <span style={{ "font-size": "12px", color: "var(--text-secondary)" }}>
                {value().active} active · {value().archived} archived · {value().retired} retired
              </span>
            )}
          </Show>
        </div>
      </Show>

      <div class="filter-bar">
        <Show when={props.project == null}>
          <FilterSelect
            value={projectFilter()}
            onChange={setProjectFilter}
            placeholder="All projects"
            align="left"
            options={[
              { value: "", label: "All projects" },
              ...(projects() ?? []).map((project) => ({
                value: project.identity,
                label: project.displayName,
              })),
            ]}
          />
        </Show>
        <input
          class="search-input"
          type="text"
          placeholder="Search memories..."
          value={searchQuery()}
          onInput={(event) => setSearchQuery(event.currentTarget.value)}
        />
        <FilterSelect
          value={lifecycleFilter()}
          onChange={(value) => setLifecycleFilter(value as ClaimLifecycleState | "")}
          placeholder="All lifecycle states"
          options={[
            { value: "", label: "All lifecycle states" },
            { value: "active", label: "Active" },
            { value: "archived", label: "Archived" },
            { value: "retired", label: "Retired" },
          ]}
        />
        <FilterSelect
          value={categoryFilter()}
          onChange={setCategoryFilter}
          placeholder="All categories"
          options={[
            { value: "", label: "All categories" },
            ...(stats()?.categories ?? []).map((category) => ({
              value: category.category,
              label: `${category.category} (${category.count})`,
            })),
          ]}
        />
      </div>

      <Show when={selectedCount() > 0}>
        <div class="bulk-action-bar">
          <div class="bulk-action-left">
            <TriStateCheckbox
              state={allVisibleState()}
              onToggle={() =>
                setSelected((previous) => toggleClaimsSelection(previous, visibleClaims()))
              }
              ariaLabel="Toggle all visible memories"
            />
            <span class="bulk-action-count">
              {selectedCount()} selected
              <Show when={staleSelectedCount() > 0}> · {staleSelectedCount()} stale</Show>
            </span>
          </div>
          <div class="bulk-action-right">
            <button type="button" class="btn sm" onClick={handleBulkArchive}>
              Archive
            </button>
            <button type="button" class="btn sm ghost" onClick={() => setSelected(new Map())}>
              Clear
            </button>
          </div>
        </div>
      </Show>

      <div class="scroll-area">
        <Show
          when={!memories.loading}
          fallback={<div class="empty-state">Loading memories...</div>}
        >
          <Show
            when={visibleClaims().length > 0}
            fallback={<div class="empty-state">No memories found</div>}
          >
            <div class="list-gap">
              <For each={groupedClaims()}>
                {([category, claims]) => (
                  <>
                    <div class="category-header">
                      <TriStateCheckbox
                        state={selectionState(selected(), claims)}
                        onToggle={() =>
                          setSelected((previous) => toggleClaimsSelection(previous, claims))
                        }
                        ariaLabel={`Toggle all in ${category}`}
                      />
                      <span>{category}</span>
                      <span class="category-count">({claims.length})</span>
                      <span class="category-divider" />
                    </div>
                    <For each={claims}>
                      {(claim) => (
                        <button
                          type="button"
                          class="card memory-card"
                          classList={{ selected: selected().has(claim.publicClaimId) }}
                          onClick={() => focus(claim)}
                          style={{ width: "100%", "text-align": "left" }}
                        >
                          <span class="memory-card-checkbox">
                            <input
                              type="checkbox"
                              checked={selected().has(claim.publicClaimId)}
                              onChange={() =>
                                setSelected((previous) => toggleClaimSelection(previous, claim))
                              }
                              onClick={(event) => event.stopPropagation()}
                              aria-label={`Select memory ${claim.publicClaimId}`}
                            />
                          </span>
                          <div class="memory-card-body">
                            <div class="card-title">
                              <span
                                class="mono"
                                style={{ color: "var(--text-muted)", "margin-right": "6px" }}
                              >
                                {claim.publicClaimId.slice(0, 12)}…
                              </span>
                              {truncate(claim.content, 100)}
                            </div>
                            <div class="card-meta">
                              <span class={`pill ${statusPillClass(claim.lifecycleState)}`}>
                                {claim.lifecycleState}
                              </span>
                              <span class="pill blue">{claim.policy.effectiveMaturity}</span>
                              <Show when={claim.policy.explicitLabel}>
                                {(label) => <span class="pill amber">{label()}</span>}
                              </Show>
                              <span
                                class={`pill ${importanceBand(claim.importance).cls}`}
                                title={importanceBand(claim.importance).label}
                              >
                                imp {claim.importance}
                              </span>
                              <span>seen {claim.telemetry.seenCount}×</span>
                              <span>retrieved {claim.telemetry.retrievalCount}×</span>
                              <span>{formatRelativeTime(claim.revisionCreatedAt)}</span>
                            </div>
                          </div>
                        </button>
                      )}
                    </For>
                  </>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>

      <Show when={focusedClaim()}>
        {(claim) => (
          <MemoryDetail
            memory={claim()}
            draft={draftForFocused()?.text ?? claim().content}
            revisionAdvanced={draftForFocused()?.revisionAdvanced ?? false}
            onDraftChange={(text) =>
              setDrafts((previous) => {
                const next = new Map(previous);
                const current = next.get(claim().publicClaimId);
                next.set(claim().publicClaimId, {
                  publicClaimId: claim().publicClaimId,
                  revisionLocator: current?.revisionLocator ?? claim().revisionLocator,
                  text,
                  revisionAdvanced: current?.revisionAdvanced ?? false,
                });
                return next;
              })
            }
            onDiscardDraft={() =>
              setDrafts((previous) => {
                const next = new Map(previous);
                next.set(claim().publicClaimId, {
                  publicClaimId: claim().publicClaimId,
                  revisionLocator: claim().revisionLocator,
                  text: claim().content,
                  revisionAdvanced: false,
                });
                return next;
              })
            }
            onClose={() => setFocusedClaim(null)}
            onLifecycleChange={handleLifecycleChange}
            onContentChange={handleContentChange}
            onCategoryChange={handleCategoryChange}
          />
        )}
      </Show>
    </>
  );
}

interface TriStateCheckboxProps {
  state: "none" | "some" | "all";
  onToggle: () => void;
  ariaLabel: string;
}

function TriStateCheckbox(props: TriStateCheckboxProps) {
  let ref: HTMLInputElement | undefined;
  createEffect(() => {
    if (ref) ref.indeterminate = props.state === "some";
  });
  return (
    <input
      ref={ref}
      type="checkbox"
      class="tri-checkbox"
      checked={props.state === "all"}
      onChange={props.onToggle}
      onClick={(event) => event.stopPropagation()}
      aria-label={props.ariaLabel}
    />
  );
}
