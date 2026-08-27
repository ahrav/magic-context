import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import {
  formatDateTime,
  formatRelativeTime,
  getAvailableModels,
  getConfig,
  getDreamerProjects,
  getDreamRuns,
  getDreamState,
  getProjects,
  saveProjectConfig,
} from "../../lib/api";
import { describeCron } from "../../lib/cron";
import { getDreamRunTaskDetail } from "../../lib/dream-run-detail";
import { jsoncErrorMessage, parseJsonc, patchDreamerTasksJsonc } from "../../lib/jsonc";
import type {
  DreamerProject,
  DreamerProjectTask,
  DreamRun,
  DreamRunMemoryChanges,
  DreamRunTask,
  ProjectInfo,
} from "../../lib/types";
import { TASKS } from "../ConfigEditor/DreamerTasksField";
import DreamerProjectConfigPanel from "./DreamerProjectConfigPanel";
import DreamerTaskCard from "./DreamerTaskCard";

// Default cron used when ENABLING a task whose schema default is "" (disabled),
// e.g. maintain-docs. Keeps the toggle's "on" meaningful for every task. Users
// fine-tune the exact cron via the gear dialog.
const ENABLE_FALLBACK_CRON = "0 3 * * *";
const CANONICAL_TASK_NAMES = new Set(TASKS.map((task) => task.name));

function taskMeta(taskName: string): {
  label: string;
  description: string;
  defaultSchedule: string;
} {
  const meta = TASKS.find((t) => t.name === taskName);
  return {
    label: meta?.label ?? taskName,
    description: meta?.description ?? "",
    defaultSchedule: meta?.defaultSchedule ?? "",
  };
}

type ProjectRunGroup = {
  project: ProjectInfo | undefined;
  projectPath: string;
  runs: DreamRun[];
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatTaskLabel(name: string): string {
  // The registry/dream-run task name is "evaluate-smart-notes"; show it tidily.
  return name === "evaluate-smart-notes" ? "smart notes" : name;
}

// Show input/output directly rather than a single "total". The total summed
// cache_read across every agentic turn, which re-counts the same cached prefix
// once per turn (~95-98% of the figure) and read as absurd usage (millions).
// input + output are the meaningful fresh-token figures; the hover tooltip
// still carries the full breakdown including cache_read/write.
function formatTaskTokens(task: DreamRunTask): string {
  if (!task.tokens) return "—";
  return `input: ${task.tokens.input.toLocaleString()} · output: ${task.tokens.output.toLocaleString()}`;
}

function formatTaskBacklog(task: DreamRunTask): string {
  const backlog = task.backlog;
  if (!backlog) return "—";
  return `${backlog.pendingAtEnd}/${backlog.totalAtEnd} pending · −${backlog.processed} (start ${backlog.pendingAtStart})`;
}

function formatTaskOutput(task: DreamRunTask, run: DreamRun): string {
  // Task name from the dream-run row is "evaluate-smart-notes" (registry
  // canonical). Matching "smart-notes" here never fired, so smart-note runs fell
  // back to the "N chars" branch instead of the surfaced/pending counts.
  if (task.name === "evaluate-smart-notes") {
    return `${run.smart_notes_surfaced} surfaced, ${run.smart_notes_pending} pending`;
  }
  return `${task.resultChars.toLocaleString()} chars`;
}

function getProjectLabel(project: ProjectInfo | undefined, projectPath: string): string {
  if (project) return project.label;
  if (projectPath.startsWith("git:")) return `${projectPath.slice(0, 14)}…`;
  const segments = projectPath.split("/").filter(Boolean);
  return segments.length > 0 ? (segments[segments.length - 1] ?? "") : projectPath;
}

function hasMemoryChanges(changes: DreamRunMemoryChanges | null): changes is DreamRunMemoryChanges {
  if (!changes) return false;
  return Object.values(changes).some((value) => (value ?? 0) > 0);
}

/** A broad verification cycle may be split across scheduled runs. Older runs
 * record a failed status while still banking processed memories, which is a
 * resumable warning rather than a task failure. */
function isResumableBroadFailure(task: DreamerProjectTask): boolean {
  if (task.task !== "verify-broad" || task.last_status !== "failed") return false;
  const progress = task.last_error?.match(/(?:processed|verified)\s+(\d+)/i);
  return Number(progress?.[1] ?? 0) > 0;
}

interface DreamerPanelProps {
  /** When set, the panel is scoped to one project: the global header + stat
   *  banner are hidden (the ProjectDetail shell owns the breadcrumb), the card
   *  grid + run history are filtered to this project, and its single card opens
   *  expanded. */
  project?: { identity: string; label: string };
}

export default function DreamerPanel(props: DreamerPanelProps = {}) {
  const embedded = () => props.project != null;
  const [dreamerProjects, { refetch: refetchDreamerProjects }] = createResource(getDreamerProjects);
  const [state, { refetch: refetchState }] = createResource(getDreamState);
  const [projects] = createResource(getProjects);
  const [models] = createResource(getAvailableModels);
  const [runs, { refetch: refetchRuns }] = createResource(() =>
    getDreamRuns(props.project?.identity ?? undefined, 50),
  );
  const [expandedProjects, setExpandedProjects] = createSignal<Set<string>>(new Set());
  // Which project cards are expanded (task list), and which has the gear dialog open.
  const [expandedCards, setExpandedCards] = createSignal<Set<string>>(new Set());
  const [configProject, setConfigProject] = createSignal<DreamerProject | null>(null);
  // Per-task in-flight toggle keys ("<identity>::<task>") + a transient error.
  const [togglingTasks, setTogglingTasks] = createSignal<Set<string>>(new Set());
  const [toggleError, setToggleError] = createSignal<string | null>(null);

  // Flip one task on/off by writing ONLY that task's schedule into the project's
  // magic-context.jsonc (a partial override the plugin deep-merges over global):
  // enable → its default cron (or a sane fallback for default-disabled tasks),
  // disable → "". Preserves comments + every other key via the JSONC patch.
  const toggleTask = async (project: DreamerProject, taskName: string, enable: boolean) => {
    const wt = project.worktree;
    if (!wt) return;
    const key = `${project.identity}::${taskName}`;
    setTogglingTasks((prev) => new Set(prev).add(key));
    setToggleError(null);
    try {
      const file = await getConfig("project", wt);
      const text = file.content ?? "";
      const parsed = text.trim() === "" ? {} : parseJsonc(text);
      const dreamer =
        parsed.dreamer && typeof parsed.dreamer === "object" && !Array.isArray(parsed.dreamer)
          ? (parsed.dreamer as Record<string, unknown>)
          : {};
      const tasks =
        dreamer.tasks && typeof dreamer.tasks === "object" && !Array.isArray(dreamer.tasks)
          ? { ...(dreamer.tasks as Record<string, Record<string, unknown>>) }
          : {};
      const existing =
        tasks[taskName] && typeof tasks[taskName] === "object" ? { ...tasks[taskName] } : {};
      if (enable) {
        const def = taskMeta(taskName).defaultSchedule;
        // Reuse a previously-configured cron if present; else the schema default;
        // else a sane nightly fallback (default-disabled tasks like maintain-docs).
        const prior = typeof existing.schedule === "string" ? existing.schedule : "";
        existing.schedule = prior !== "" ? prior : def !== "" ? def : ENABLE_FALLBACK_CRON;
      } else {
        existing.schedule = "";
      }
      tasks[taskName] = existing;
      const nextConfig = patchDreamerTasksJsonc(text, tasks);
      await saveProjectConfig(wt, nextConfig);
      refetchDreamerProjects();
    } catch (err) {
      setToggleError(`Couldn't update ${taskName}: ${jsoncErrorMessage(err)}`);
      setTimeout(() => setToggleError(null), 6000);
    } finally {
      setTogglingTasks((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const refreshAll = () => {
    refetchDreamerProjects();
    refetchState();
    refetchRuns();
  };

  const leaseState = () => {
    const s = state() ?? [];
    const leaseEntry = s.find((e) => e.key === "dreaming_lease_holder");
    const lastRunEntry = s.find((e) => e.key === "last_dream_at");
    return {
      leaseHolder: leaseEntry?.value ?? "none",
      lastRunTime: lastRunEntry?.value ?? null,
    };
  };

  // Project cards: every tracked project with at least one canonical task,
  // sorted by name. Enabled tasks (schedule set) come first within a card.
  // When embedded, scope to the one project this detail view is about.
  // Schedule-state rows can outlive a retired registry task. The dashboard must
  // follow the plugin registry rather than showing a stale toggle from storage.
  const visibleTasks = (p: DreamerProject) =>
    p.tasks.filter((task) => CANONICAL_TASK_NAMES.has(task.task));
  const isTaskEnabled = (t: DreamerProjectTask) => (t.schedule ?? "").trim() !== "";

  const cards = createMemo<DreamerProject[]>(() => {
    const all = [...(dreamerProjects() ?? [])].sort((a, b) => a.label.localeCompare(b.label));
    const locked = props.project?.identity;
    const scoped = locked ? all.filter((p) => p.identity === locked) : all;
    return scoped.filter((p) => visibleTasks(p).length > 0);
  });
  const enabledTasks = (p: DreamerProject) => visibleTasks(p).filter(isTaskEnabled);

  // Traffic-light for a task's last run: green ok, red failed, gray never-run /
  // disabled. Amber = scheduled+enabled but not yet run, or retrying.
  type Light = "green" | "amber" | "red" | "gray";
  const taskLight = (t: DreamerProjectTask): Light => {
    if (isResumableBroadFailure(t)) return "amber";
    if (t.last_status === "failed") return "red";
    if (t.last_status === "completed") return "green";
    if (t.last_status === "skipped") return "gray";
    if (isTaskEnabled(t) && t.last_run_at == null) return "amber";
    return "gray";
  };

  // Card-level health: red if any enabled task last failed, amber if any enabled
  // task hasn't run yet, green if all enabled tasks succeeded, gray if none on.
  const cardHealth = (p: DreamerProject): Light => {
    const on = enabledTasks(p);
    if (on.length === 0) return "gray";
    if (on.some((t) => t.last_status === "failed" && !isResumableBroadFailure(t))) return "red";
    if (on.some(isResumableBroadFailure)) return "amber";
    if (on.some((t) => t.last_run_at == null && t.last_status == null)) return "amber";
    if (on.some((t) => t.last_status === "completed")) return "green";
    return "gray";
  };

  const failedCount = (p: DreamerProject) =>
    p.tasks.filter((t) => t.last_status === "failed" && !isResumableBroadFailure(t)).length;

  const toggleCard = (identity: string) => {
    setExpandedCards((previous) => {
      const next = new Set(previous);
      if (next.has(identity)) next.delete(identity);
      else next.add(identity);
      return next;
    });
  };
  // Embedded (single-project) view: the one card is open by default unless the
  // user explicitly collapsed it.
  const [collapsedEmbeddedCard, setCollapsedEmbeddedCard] = createSignal(false);
  const isCardExpanded = (identity: string) => {
    if (embedded()) return !collapsedEmbeddedCard();
    return expandedCards().has(identity);
  };
  const toggleCardOrEmbedded = (identity: string) => {
    if (embedded()) {
      setCollapsedEmbeddedCard((v) => !v);
      return;
    }
    toggleCard(identity);
  };

  const lightTitle = (t: DreamerProjectTask): string => {
    const when = t.last_run_at != null ? formatRelativeTime(t.last_run_at) : "never run";
    const status = isResumableBroadFailure(t)
      ? "resumable"
      : (t.last_status ?? (isTaskEnabled(t) ? "pending" : "disabled"));
    const err = t.last_error ? ` — ${t.last_error}` : "";
    return `${status} · ${when}${err}`;
  };
  const latestRecordedRun = createMemo(() => {
    const allRuns = runs() ?? [];
    return allRuns.length > 0 ? allRuns[0] : null;
  });

  const groupedRuns = createMemo<ProjectRunGroup[]>(() => {
    const projectMap = new Map((projects() ?? []).map((project) => [project.identity, project]));
    const groups = new Map<string, DreamRun[]>();

    for (const run of runs() ?? []) {
      const existing = groups.get(run.project_path);
      if (existing) {
        existing.push(run);
      } else {
        groups.set(run.project_path, [run]);
      }
    }

    return [...groups.entries()]
      .map(([projectPath, projectRuns]) => ({
        projectPath,
        project: projectMap.get(projectPath),
        runs: projectRuns.sort((left, right) => right.finished_at - left.finished_at),
      }))
      .sort((left, right) => (right.runs[0]?.finished_at ?? 0) - (left.runs[0]?.finished_at ?? 0));
  });

  // Embedded (single-project) run history: a flat, newest-first list of runs.
  // One run records one task (recordRun is per-task), so this reads as a table
  // of task executions, mirroring the historian-runs table.
  const flatRuns = createMemo<DreamRun[]>(() =>
    [...(runs() ?? [])].sort((a, b) => b.finished_at - a.finished_at),
  );

  const toggleProject = (projectPath: string) => {
    setExpandedProjects((previous) => {
      const next = new Set(previous);
      if (next.has(projectPath)) {
        next.delete(projectPath);
      } else {
        next.add(projectPath);
      }
      return next;
    });
  };

  const isExpanded = (projectPath: string) => expandedProjects().has(projectPath);

  return (
    <>
      <Show when={!embedded()}>
        <div class="section-header">
          <h1 class="section-title">Dreamer</h1>
          <div class="section-actions">
            <button type="button" class="btn sm" onClick={refreshAll}>
              ↻ Refresh
            </button>
          </div>
        </div>

        <div style={{ padding: "0 20px 12px" }}>
          <div class="stat-banner">
            <div class="stat-item">
              <span class="stat-label">State</span>
              <span class="stat-value">
                {leaseState().leaseHolder === "none" ? "idle" : "running"}
              </span>
            </div>
            <div class="stat-item">
              <span class="stat-label">Lease</span>
              <span class="stat-value">{leaseState().leaseHolder}</span>
            </div>
            <Show when={leaseState().lastRunTime}>
              <div class="stat-item">
                <span class="stat-label">Last Run</span>
                <span class="stat-value">
                  {(() => {
                    const v = leaseState().lastRunTime;
                    if (!v) return "—";
                    const n = Number(v);
                    return !Number.isNaN(n) && n > 1e12
                      ? `${formatRelativeTime(n)} · ${formatDateTime(n)}`
                      : v;
                  })()}
                </span>
              </div>
            </Show>
            <Show when={!leaseState().lastRunTime && latestRecordedRun()}>
              <div class="stat-item">
                <span class="stat-label">Last Run</span>
                <span class="stat-value">{`${formatRelativeTime(latestRecordedRun()?.finished_at ?? 0)} · ${formatDateTime(latestRecordedRun()?.finished_at ?? 0)}`}</span>
              </div>
            </Show>
            <div class="stat-item">
              <span class="stat-label">Tracked</span>
              <span class="stat-value">{cards().length} projects</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">Scheduled</span>
              <span class="stat-value">
                {cards().reduce((n, p) => n + enabledTasks(p).length, 0)} tasks
              </span>
            </div>
          </div>
        </div>
      </Show>

      <div class="scroll-area">
        {/* Single-project (embedded) view: no "Tracked Projects" header, no card
            container, no collapse — the task list is always visible. The panel is
            only ever rendered embedded (the global all-projects Dreamer route was
            removed when each project got its own detail page), so the non-embedded
            grid below is a vestigial fallback. */}
        <Show when={embedded()}>
          <For each={cards()}>
            {(project) => (
              <div class="dreamer-embedded">
                <div class="dreamer-embedded-head">
                  <span class={`status-dot ${cardHealth(project)}`} />
                  <span class="pill blue">{enabledTasks(project).length} on</span>
                  <Show when={failedCount(project) > 0}>
                    <span class="pill red">{failedCount(project)} failed</span>
                  </Show>
                  <span
                    class={`pill ${project.has_project_config ? "indigo" : "gray"}`}
                    title={
                      project.has_project_config
                        ? "This project has its own dreamer config"
                        : "Inherits the global dreamer config"
                    }
                  >
                    {project.has_project_config ? "per-project" : "inherited"}
                  </span>
                  <span class="mono dreamer-project-identity" title={project.identity}>
                    {project.worktree ?? project.identity}
                  </span>
                  <button
                    type="button"
                    class="dreamer-gear"
                    title="Configure dreamer for this project (model, exact cron)"
                    disabled={!project.worktree}
                    onClick={() => setConfigProject(project)}
                  >
                    ⚙
                  </button>
                </div>

                <Show when={toggleError()}>
                  {(message) => <div class="dreamer-toggle-error">{message()}</div>}
                </Show>

                <div class="dreamer-task-card-grid">
                  <For each={visibleTasks(project)}>
                    {(task) => {
                      const meta = taskMeta(task.task);
                      const enabled = isTaskEnabled(task);
                      const nextDue = () => {
                        if (!enabled || task.next_due_at == null) return null;
                        return task.next_due_at > Date.now()
                          ? formatRelativeTime(task.next_due_at)
                          : "overdue";
                      };
                      return (
                        <DreamerTaskCard
                          taskName={task.task}
                          label={meta.label}
                          description={meta.description}
                          scheduleText={enabled ? describeCron(task.schedule ?? "") : "Disabled"}
                          nextDueText={nextDue()}
                          enabled={enabled}
                          iconTint={!enabled ? "gray" : taskLight(task) === "red" ? "red" : "green"}
                          light={taskLight(task)}
                          lastError={isResumableBroadFailure(task) ? null : task.last_error}
                          resumable={isResumableBroadFailure(task)}
                          canToggle={project.worktree != null}
                          busy={togglingTasks().has(`${project.identity}::${task.task}`)}
                          onToggle={(enable) => void toggleTask(project, task.task, enable)}
                        />
                      );
                    }}
                  </For>
                </div>
              </div>
            )}
          </For>
        </Show>

        <Show when={!embedded() && cards().length > 0}>
          <div class="category-header">
            Tracked Projects <span class="category-count">({cards().length})</span>
          </div>
          <div class="dreamer-project-grid">
            <For each={cards()}>
              {(project) => (
                <div class="card dreamer-project-card">
                  <div class="dreamer-project-head">
                    <button
                      type="button"
                      class="dreamer-project-toggle"
                      onClick={() => toggleCardOrEmbedded(project.identity)}
                    >
                      <span class={`status-dot ${cardHealth(project)}`} />
                      <span class="dreamer-project-name">{project.label}</span>
                      <span class="pill blue">{enabledTasks(project).length} on</span>
                      <Show when={failedCount(project) > 0}>
                        <span class="pill red">{failedCount(project)} failed</span>
                      </Show>
                      <span class="dreamer-project-chevron">
                        {isCardExpanded(project.identity) ? "▾" : "▸"}
                      </span>
                    </button>
                    <button
                      type="button"
                      class="dreamer-gear"
                      title="Configure dreamer for this project"
                      disabled={!project.worktree}
                      onClick={() => setConfigProject(project)}
                    >
                      ⚙
                    </button>
                  </div>
                  <div class="dreamer-project-sub">
                    <span
                      class={`pill ${project.has_project_config ? "indigo" : "gray"}`}
                      title={
                        project.has_project_config
                          ? "This project has its own dreamer config"
                          : "Inherits the global dreamer config"
                      }
                    >
                      {project.has_project_config ? "per-project" : "inherited"}
                    </span>
                    <span class="mono dreamer-project-identity" title={project.identity}>
                      {project.worktree ?? project.identity}
                    </span>
                  </div>

                  <Show when={isCardExpanded(project.identity)}>
                    <div class="dreamer-task-list">
                      <For each={visibleTasks(project)}>
                        {(task) => (
                          <div class="dreamer-task-line">
                            <span
                              class={`status-dot ${taskLight(task)}`}
                              title={lightTitle(task)}
                            />
                            <span class="dreamer-task-name">{formatTaskLabel(task.task)}</span>
                            <span class="dreamer-task-sched">
                              {isTaskEnabled(task) ? describeCron(task.schedule ?? "") : "disabled"}
                            </span>
                            <Show when={isTaskEnabled(task) && task.next_due_at != null}>
                              <span class="dreamer-task-next">
                                {(task.next_due_at ?? 0) > Date.now()
                                  ? `· ${formatRelativeTime(task.next_due_at ?? 0)}`
                                  : "· overdue"}
                              </span>
                            </Show>
                            <Show when={isResumableBroadFailure(task)}>
                              <span class="dreamer-task-next">· resumable</span>
                            </Show>
                            <Show when={task.last_error && !isResumableBroadFailure(task)}>
                              <span class="dreamer-task-err" title={task.last_error ?? ""}>
                                {task.last_error}
                              </span>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show
          when={!runs.loading}
          fallback={<div class="empty-state">Loading dream history...</div>}
        >
          <Show
            when={(runs() ?? []).length > 0}
            fallback={
              <div class="empty-state">
                <span class="empty-state-icon">🌙</span>
                <span>No dream runs yet</span>
                <span style={{ "font-size": "11px" }}>
                  Run the dreamer to start building project history.
                </span>
              </div>
            }
          >
            {/* Embedded (single-project): flat run table, one row per task
                execution (recordRun is per-task), mirroring the historian-runs
                table. Click a row with memory changes to expand which memories
                changed. */}
            <Show when={embedded()}>
              <div class="category-header">
                Run History <span class="category-count">({flatRuns().length})</span>
              </div>
              <table class="kv-table dream-run-flat-table">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Task</th>
                    <th>Status</th>
                    <th>Duration</th>
                    <th>Output</th>
                    <th>Tokens</th>
                    <th>Backlog</th>
                    <th>Memory</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={flatRuns()}>
                    {(run) => {
                      const task = () => run.tasks_json[0];
                      const taskDetail = () => {
                        const current = task();
                        return current
                          ? getDreamRunTaskDetail(current, run.tasks_failed)
                          : { text: undefined, tone: "neutral" as const };
                      };
                      const memChanged = () => hasMemoryChanges(run.memory_changes_json);
                      const memSummary = () => {
                        const c = run.memory_changes_json;
                        if (!c) return "—";
                        const parts: string[] = [];
                        if ((c.written ?? 0) > 0) parts.push(`+${c.written}`);
                        if ((c.merged ?? 0) > 0) parts.push(`⤳${c.merged}`);
                        if ((c.archived ?? 0) > 0) parts.push(`⊘${c.archived}`);
                        if ((c.deleted ?? 0) > 0) parts.push(`✕${c.deleted}`);
                        return parts.length > 0 ? parts.join(" ") : "—";
                      };
                      return (
                        <>
                          <tr class="dream-run-flat-row">
                            <td>{formatDateTime(run.started_at)}</td>
                            <td>{task() ? formatTaskLabel(task().name) : "—"}</td>
                            <td>
                              <span
                                class={`dream-run-status ${run.tasks_failed > 0 ? "error" : "success"}`}
                              >
                                {run.tasks_failed > 0 ? "failed" : "completed"}
                              </span>
                            </td>
                            <td>{formatDuration(run.finished_at - run.started_at)}</td>
                            <td>{task() ? formatTaskOutput(task(), run) : "—"}</td>
                            <td
                              title={
                                task()?.tokens
                                  ? `input ${task().tokens?.input.toLocaleString()} · output ${task().tokens?.output.toLocaleString()} · cache ${task().tokens?.cache_read.toLocaleString()}/${task().tokens?.cache_write.toLocaleString()}`
                                  : undefined
                              }
                            >
                              {task() ? formatTaskTokens(task()) : "—"}
                            </td>
                            <td>{task() ? formatTaskBacklog(task()) : "—"}</td>
                            <td>
                              <Show when={memChanged()} fallback="—">
                                <span class="dream-run-flat-mem">{memSummary()}</span>
                              </Show>
                            </td>
                            <td
                              class={`dream-run-task-detail ${taskDetail().tone}`}
                              title={taskDetail().text ?? ""}
                            >
                              {taskDetail().text ?? "—"}
                            </td>
                          </tr>
                        </>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </Show>

            <Show when={!embedded()}>
              <div class="category-header">
                Run History <span class="category-count">({groupedRuns().length})</span>
              </div>
              <div class="list-gap">
                <For each={groupedRuns()}>
                  {(group) => {
                    const latestRun = () => group.runs[0];
                    const latestDuration = () => {
                      const run = latestRun();
                      return run ? formatDuration(run.finished_at - run.started_at) : "—";
                    };

                    return (
                      <div class="card dream-run-card">
                        <button
                          type="button"
                          class="dream-run-header"
                          onClick={() => toggleProject(group.projectPath)}
                        >
                          <div>
                            <div class="dream-run-title-row">
                              <span class="card-title" style={{ margin: 0 }}>
                                {getProjectLabel(group.project, group.projectPath)}
                              </span>
                              <span class="pill blue">
                                {group.runs.length} run{group.runs.length === 1 ? "" : "s"}
                              </span>
                            </div>
                            <div class="card-meta" style={{ "margin-top": "4px" }}>
                              <span>Last run: {formatRelativeTime(latestRun()?.finished_at)}</span>
                              <span>·</span>
                              <span>{formatDateTime(latestRun()?.finished_at)}</span>
                              <span>·</span>
                              <span>Duration: {latestDuration()}</span>
                              <Show
                                when={
                                  group.projectPath !==
                                  getProjectLabel(group.project, group.projectPath)
                                }
                              >
                                <span>·</span>
                                <span class="mono">{group.projectPath}</span>
                              </Show>
                            </div>
                          </div>
                          <span class="dream-run-chevron">
                            {isExpanded(group.projectPath) ? "▾" : "▸"}
                          </span>
                        </button>

                        <Show when={isExpanded(group.projectPath)}>
                          <div class="dream-run-history">
                            <For each={group.runs}>
                              {(run) => (
                                <section class="dream-run-detail">
                                  <div class="dream-run-detail-header">
                                    <div>
                                      <div class="dream-run-detail-title">
                                        {formatRelativeTime(run.finished_at)}
                                      </div>
                                      <div class="card-meta">
                                        <span>{formatDateTime(run.finished_at)}</span>
                                        <span>·</span>
                                        <span>
                                          {formatDuration(run.finished_at - run.started_at)}
                                        </span>
                                        <span>·</span>
                                        <span>{run.tasks_succeeded} succeeded</span>
                                        <Show when={run.tasks_failed > 0}>
                                          <span style={{ color: "var(--red)" }}>
                                            {run.tasks_failed} failed
                                          </span>
                                        </Show>
                                      </div>
                                    </div>
                                    <span class={`pill ${run.tasks_failed > 0 ? "red" : "green"}`}>
                                      {run.tasks_failed > 0 ? "issues" : "ok"}
                                    </span>
                                  </div>

                                  <table class="dream-run-table">
                                    <thead>
                                      <tr>
                                        <th>Task</th>
                                        <th>Duration</th>
                                        <th>Output</th>
                                        <th>Tokens</th>
                                        <th>Backlog</th>
                                        <th>Status</th>
                                        <th>Detail</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      <For each={run.tasks_json}>
                                        {(task) => {
                                          const detail = getDreamRunTaskDetail(
                                            task,
                                            run.tasks_failed,
                                          );
                                          return (
                                            <tr>
                                              <td>{formatTaskLabel(task.name)}</td>
                                              <td class="mono">
                                                {formatDuration(task.durationMs)}
                                              </td>
                                              <td class="mono">{formatTaskOutput(task, run)}</td>
                                              <td
                                                class="mono"
                                                title={
                                                  task.tokens
                                                    ? `input ${task.tokens.input.toLocaleString()} · output ${task.tokens.output.toLocaleString()} · cache ${task.tokens.cache_read.toLocaleString()}/${task.tokens.cache_write.toLocaleString()}`
                                                    : undefined
                                                }
                                              >
                                                {formatTaskTokens(task)}
                                              </td>
                                              <td>{formatTaskBacklog(task)}</td>
                                              <td>
                                                <span
                                                  class={`dream-run-status ${detail.tone === "error" ? "error" : "success"}`}
                                                >
                                                  {detail.tone === "error" ? "✕" : "✓"}
                                                </span>
                                              </td>
                                              <td
                                                class={`dream-run-task-detail ${detail.tone}`}
                                                title={detail.text ?? ""}
                                              >
                                                {detail.text ?? "—"}
                                              </td>
                                            </tr>
                                          );
                                        }}
                                      </For>
                                    </tbody>
                                  </table>

                                  <Show when={hasMemoryChanges(run.memory_changes_json)}>
                                    <div class="dream-run-memory-section">
                                      <div class="dream-run-memory-title">Memory Changes</div>
                                      <div class="dream-run-memory-grid">
                                        <Show when={(run.memory_changes_json?.written ?? 0) > 0}>
                                          <div class="dream-run-memory-pill">
                                            <span>written</span>
                                            <strong>{run.memory_changes_json?.written}</strong>
                                          </div>
                                        </Show>
                                        <Show when={(run.memory_changes_json?.deleted ?? 0) > 0}>
                                          <div class="dream-run-memory-pill">
                                            <span>deleted</span>
                                            <strong>{run.memory_changes_json?.deleted}</strong>
                                          </div>
                                        </Show>
                                        <Show when={(run.memory_changes_json?.archived ?? 0) > 0}>
                                          <div class="dream-run-memory-pill">
                                            <span>archived</span>
                                            <strong>{run.memory_changes_json?.archived}</strong>
                                          </div>
                                        </Show>
                                        <Show when={(run.memory_changes_json?.merged ?? 0) > 0}>
                                          <div class="dream-run-memory-pill">
                                            <span>merged</span>
                                            <strong>{run.memory_changes_json?.merged}</strong>
                                          </div>
                                        </Show>
                                      </div>
                                    </div>
                                  </Show>
                                </section>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>
          </Show>
        </Show>

        <Show
          when={cards().length === 0 && (state() ?? []).length === 0 && (runs() ?? []).length === 0}
        >
          <div class="empty-state">
            <span class="empty-state-icon">🌙</span>
            <span>No dreamer activity</span>
            <span style={{ "font-size": "11px" }}>
              Enable the dreamer and schedule tasks, or run <code>/ctx-dream</code> in your session.
            </span>
          </div>
        </Show>
      </div>

      <Show when={configProject()}>
        {(project) => (
          <DreamerProjectConfigPanel
            project={project()}
            models={models() ?? []}
            onClose={() => setConfigProject(null)}
            onSaved={() => refetchDreamerProjects()}
          />
        )}
      </Show>
    </>
  );
}
