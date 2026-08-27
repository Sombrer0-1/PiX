/**
 * Agent Task Store (PiX 1.4.1; 1.4.2 R5 recovery surface; 1.5 P1 automation)
 *
 * Pinia mirror of the app-level agent task state owned by the main-process
 * AgentTaskService. The renderer never invents task state: every change
 * arrives as a task_state / task_activities / task_output /
 * task_input_dismissed / storage_status / recovery_issue / task_removed event
 * or as the get_all / get_active_input_requests remount catch-up, and actions
 * map one-to-one onto the §4.9 AgentTaskCommand IPC contract through the
 * useAgentTaskRpc transport. 1.5 (P1): the manual-operation commands are gone
 * (delivery catch-up, auto-recovery and retention run in main); the remaining
 * actions are cancel (stop a runaway task), the input approvals and the
 * diagnostics export. task_removed converges the mirror when the retention
 * pass deletes a terminal record.
 *
 * 1.4.1 grouping: waiting (waiting_input), active (running+queued as one
 * group) and recent (completed/failed/cancelled). 1.5 (P2): recentTasks is
 * replaced by the unbounded terminalTasks (endedAt desc) - the history view
 * renders the full terminal mirror and retention is the bound. 1.4.2 (R5)
 * adds the interrupted group
 * (transient: 1.5 auto-recovery resolves it right after hydration), plus the
 * recoveryIssues and storageStatuses mirrors delivered by the R2 get_all
 * snapshot / storage_status / recovery_issue events.
 *
 * The auto-background deadline is group-level: every non-terminal child of an
 * attached foreground group mirrors the same deadlineAt/warningAt/warningActive
 * (design plan §4.5). The store keeps sibling tasks consistent on each
 * task_state push: a push that carries (or drops) the shared deadline is
 * mirrored across the group's non-terminal tasks, and groupAutoBackgrounds
 * exposes one shared deadline per group. warningActive is monotonic within a
 * timer run, so an equal-deadline warning push never regresses siblings.
 *
 * 1.5 (P3/S5): the transcript channel. transcripts holds the per-task replay
 * buffer (磁盘分页条目) plus the live ring (task_transcript events with a
 * per-store monotonic seq, capped at 4000 with drop-oldest + liveDropped).
 * TaskDetailPanel owns the write side (watchTask/unwatchTask); TaskTranscriptView
 * owns the read side: it loads transcript pages through loadTranscriptPage,
 * refolds the full entries array and consumes unconsumed live events by
 * advancing consumedSeq. A terminal task_state while watched clears the local
 * flag (the panel still sends unwatch_task on unmount - idempotent double
 * insurance; main already stopped forwarding at terminal).
 *
 * 1.5 (P4/S7): the task-log channel. getTaskLog pulls the read-only events.jsonl
 * snapshot (get_task_log, main drains persist first); fileChanges buffers the
 * live task_file_change pushes per task (deduped by toolCallId, cleared by
 * task_removed) - TaskFileChanges merges the two with history priority.
 */

import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useAgentTaskRpc } from "../composables/useAgentTaskRpc";
import type {
  AgentTaskActivity,
  AgentTaskDiagnosticExport,
  AgentTaskInfo,
  AgentTaskInputRequest,
  AgentTaskRecoveryIssue,
  AgentTaskStatus,
  AgentTaskStorageStatus,
  AgentTaskTranscriptPage,
} from "@shared/agent-task-types.js";
import type {
  AgentTaskCommandDataV15,
  AgentTaskCommandV15,
  AgentTaskEvent,
  AgentSessionEvent,
  FileChangeSummary,
  PixCommandResult,
  RequestUserInputResponse,
} from "@shared/types.js";
import type { AgentTaskLogSnapshot } from "@shared/agent-task-types.js";

/** Shared auto-background deadline of one foreground task group. */
export interface GroupAutoBackground {
  deadlineAt: number;
  warningAt: number;
  warningActive: boolean;
}

const ACTIVE_STATUSES: ReadonlySet<AgentTaskInfo["status"]> = new Set(["queued", "running", "waiting_input"]);

/** Terminal statuses: main stops transcript forwarding before the terminal
 * task_state and the renderer trusts disk replay below. */
const TERMINAL_STATUSES: ReadonlySet<AgentTaskStatus> = new Set(["completed", "failed", "cancelled"]);

/** Live-event ring cap (Plan 4.8: 溢出丢最旧并置 liveDropped=true). */
const TRANSCRIPT_LIVE_EVENTS_LIMIT = 4000;

/**
 * Per-task transcript buffer (Plan 4.8, S5). byItem accumulates the full
 * disk-replay entries page by page (never incrementally appended - the view
 * refolds the whole array through assembler.loadEntries); liveEvents is the
 * per-task ring of task_transcript pushes with a monotonic seq. consumedSeq is
 * the view-side consumption cursor: the view advances it (filtered by
 * itemIndex) and the store only appends.
 */
export interface TaskTranscriptState {
  byItem: Record<
    number,
    {
      entries: unknown[];
      totalCount: number;
      nextCursor: string | null;
      prevCursor: string | null;
      loading: boolean;
      loadingOlder: boolean;
    }
  >;
  /** 直播事件环形缓冲:per-task 单调递增 seq(溢出丢最旧并置 liveDropped=true)。 */
  liveEvents: Array<{ seq: number; itemIndex: number; event: AgentSessionEvent }>;
  liveDropped: boolean;
  watched: boolean;
  /** 消费游标:已被视图确认消费的最大 seq(视图按 itemIndex 过滤后推进)。 */
  consumedSeq: number;
}

export const useAgentTaskStore = defineStore("agent-task", () => {
  const taskRpc = useAgentTaskRpc();

  // ==========================================================================
  // State
  // ==========================================================================

  /** Task mirror, in service order (get_all sorts by createdAt ascending). */
  const tasks = ref<AgentTaskInfo[]>([]);

  /** Pending input requests, in service order (newest appended last). */
  const activeInputRequests = ref<AgentTaskInputRequest[]>([]);

  /** 1.4.2 (R2/R5): tasks whose on-disk record could not be fully restored. */
  const recoveryIssues = ref<AgentTaskRecoveryIssue[]>([]);

  /** 1.4.2 (R2/R5): per-workspace storage accounting (warning >= 80%, full at limit). */
  const storageStatuses = ref<AgentTaskStorageStatus[]>([]);

  /** Task currently expanded/selected by the task center; null = none. */
  const selectedTaskId = ref<string | null>(null);

  /** 1.5 (P2): whether the task center view owns the center area (transient UI state, not persisted). */
  const centerOpen = ref(false);

  /** 1.5 (P3): per-task transcript buffers (disk replay pages + live event ring). */
  const transcripts = ref<Record<string, TaskTranscriptState>>({});

  /**
   * 1.5 (P4): live file-change buffer per task (task_file_change pushes)。
   * 按 toolCallId 去重(live 追加);task_removed 时清理对应项。历史(磁盘)由
   * TaskFileChanges 经 get_task_log 拉取,并与本缓冲按 toolCallId 合并(历史优先)。
   */
  const fileChanges = ref<Record<string, FileChangeSummary[]>>({});

  /** Last error message from an agent-task command. */
  const lastError = ref<string | null>(null);

  /**
   * Bulk-hydration marker: incremented BEFORE every successful get_all bulk
   * replace of the task mirror. Consumers (AgentTaskNotificationCenter) use it
   * to treat a bulk snapshot as the notification baseline instead of emitting
   * stale transition notifications for every restored task on remount/restart.
   */
  const bulkHydrationVersion = ref(0);

  // ==========================================================================
  // Computed
  // ==========================================================================

  /** Tasks waiting for user input (need handling). */
  const waitingTasks = computed(() => tasks.value.filter((t) => t.status === "waiting_input"));

  /**
   * 1.4.2: interrupted tasks (pre-exit non-terminal states hydrated after a
   * restart). Rendered between "需要处理" and "进行中"; never part of the
   * recent group, never shows running progress.
   */
  const interruptedTasks = computed(() => tasks.value.filter((t) => t.status === "interrupted"));

  /** Running + queued tasks, one group (in progress). */
  const activeTasks = computed(() =>
    tasks.value.filter((t) => t.status === "running" || t.status === "queued"),
  );

  /**
   * 1.5 (P2): full terminal mirror (completed|failed|cancelled, endedAt desc),
   * replaces the recentTasks 20-entry cap - the history view renders the full
   * mirror and the retention pass is the bound.
   */
  const terminalTasks = computed(() => {
    return tasks.value
      .filter((t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled")
      .slice()
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  });

  /** The task selected via selectedTaskId, if still mirrored. */
  const selectedTask = computed(() => tasks.value.find((t) => t.taskId === selectedTaskId.value) ?? null);

  /** Storage statuses at the 80% warning threshold (PRD C5). */
  const storageWarnings = computed(() => storageStatuses.value.filter((s) => s.level === "warning"));

  /** Storage statuses at the hard limit (new launches refused in main). */
  const storageFulls = computed(() => storageStatuses.value.filter((s) => s.level === "full"));

  /**
   * Group-level auto-background deadlines. One shared deadline per foreground
   * group: when children disagree (out-of-order pushes), the newest deadline
   * wins and, on equal deadlines, the warningActive=true push wins (the
   * warning is monotonic within a timer run).
   */
  const groupAutoBackgrounds = computed(() => {
    const groups = new Map<string, GroupAutoBackground>();
    for (const task of tasks.value) {
      const mirror = task.autoBackground;
      if (!mirror) continue;
      const current = groups.get(task.groupId);
      if (
        !current ||
        mirror.deadlineAt > current.deadlineAt ||
        (mirror.deadlineAt === current.deadlineAt && mirror.warningActive && !current.warningActive)
      ) {
        groups.set(task.groupId, { ...mirror });
      }
    }
    return groups;
  });

  // ==========================================================================
  // Event handling
  // ==========================================================================

  /** True while the task belongs to the status set the group timer covers. */
  function isTimerAttached(task: AgentTaskInfo): boolean {
    return ACTIVE_STATUSES.has(task.status);
  }

  /**
   * Mirror the auto-background deadline across the group. A push carrying the
   * deadline propagates it to non-terminal siblings that lack it or hold an
   * older/equal-deadline value; the warning flag only ever moves forward. A
   * push that drops the deadline clears it on every non-terminal sibling only
   * when the pushed task is itself non-terminal (timer cancelled, e.g.
   * continueForegroundWait or detach), because the timer is group-level and no
   * attached group mixes children with and without it. A terminal task drops
   * its own field by invariant while the group timer stays attached, so it
   * never clears siblings.
   */
  function mirrorGroupAutoBackground(updated: AgentTaskInfo, currentTasks: AgentTaskInfo[]): AgentTaskInfo[] {
    const mirror = updated.autoBackground;
    const propagateRemoval = mirror === undefined && isTimerAttached(updated);
    let changed = false;
    const next = currentTasks.map((task) => {
      if (task.taskId === updated.taskId) return task;
      if (task.groupId !== updated.groupId) return task;
      if (!isTimerAttached(task)) return task;
      if (mirror) {
        const existing = task.autoBackground;
        if (
          existing &&
          existing.deadlineAt === mirror.deadlineAt &&
          existing.warningAt === mirror.warningAt &&
          !(mirror.warningActive && !existing.warningActive)
        ) {
          return task;
        }
        changed = true;
        return {
          ...task,
          autoBackground: {
            deadlineAt: mirror.deadlineAt,
            warningAt: mirror.warningAt,
            warningActive: existing?.warningActive || mirror.warningActive,
          },
        };
      }
      if (!propagateRemoval || task.autoBackground === undefined) return task;
      changed = true;
      const cleared: AgentTaskInfo = { ...task };
      delete cleared.autoBackground;
      return cleared;
    });
    return changed ? next : currentTasks;
  }

  function replaceTaskAt(idx: number, nextTask: AgentTaskInfo): void {
    tasks.value[idx] = nextTask;
  }

  /** Upsert a task_state push, keeping the mirror in service order. */
  function applyTaskState(task: AgentTaskInfo): void {
    const idx = tasks.value.findIndex((t) => t.taskId === task.taskId);
    let incoming = task;
    if (idx >= 0) {
      const previousBg = tasks.value[idx].autoBackground;
      const incomingBg = task.autoBackground;
      if (
        previousBg &&
        incomingBg &&
        previousBg.deadlineAt === incomingBg.deadlineAt &&
        previousBg.warningAt === incomingBg.warningAt &&
        previousBg.warningActive &&
        !incomingBg.warningActive
      ) {
        incoming = { ...task, autoBackground: { ...incomingBg, warningActive: true } };
      }
    }
    if (idx >= 0) {
      replaceTaskAt(idx, incoming);
      const mirrored = mirrorGroupAutoBackground(incoming, tasks.value);
      if (mirrored !== tasks.value) {
        for (let i = 0; i < tasks.value.length; i++) {
          if (tasks.value[i] !== mirrored[i]) {
            tasks.value[i] = mirrored[i];
          }
        }
      }
      return;
    }
    tasks.value.push(incoming);
    const mirrored = mirrorGroupAutoBackground(incoming, tasks.value);
    if (mirrored !== tasks.value) {
      for (let i = 0; i < tasks.value.length; i++) {
        if (tasks.value[i] !== mirrored[i]) {
          tasks.value[i] = mirrored[i];
        }
      }
    }
  }

  /** Replace a task's activity list wholesale (bounded throttle merges in main). */
  function applyActivities(
    taskId: string,
    activities: AgentTaskActivity[],
    extras?: { toolUseCount?: number; durationMs?: number },
  ): void {
    const idx = tasks.value.findIndex((t) => t.taskId === taskId);
    if (idx < 0) return;
    replaceTaskAt(idx, {
      ...tasks.value[idx],
      activities,
      ...(extras?.toolUseCount !== undefined ? { toolUseCount: extras.toolUseCount } : {}),
      ...(extras?.durationMs !== undefined ? { durationMs: extras.durationMs } : {}),
    });
  }

  /** Replace a task's final output wholesale (bounded throttle merges in main). */
  function applyOutput(taskId: string, output: string, truncated: boolean): void {
    const idx = tasks.value.findIndex((t) => t.taskId === taskId);
    if (idx < 0) return;
    replaceTaskAt(idx, { ...tasks.value[idx], finalOutput: output, outputTruncated: truncated });
  }

  /** Append an input request push; duplicates by taskId+requestId+generation are ignored. */
  function applyInputRequest(request: AgentTaskInputRequest): void {
    const exists = activeInputRequests.value.some(
      (r) => r.taskId === request.taskId && r.requestId === request.requestId && r.generation === request.generation,
    );
    if (exists) return;
    activeInputRequests.value = [...activeInputRequests.value, request];
  }

  /** Remove a settled input request by its triple key; repeat dismissals are no-ops. */
  function dismissInputRequest(taskId: string, requestId: string, generation: number): void {
    const next = activeInputRequests.value.filter(
      (r) => !(r.taskId === taskId && r.requestId === requestId && r.generation === generation),
    );
    if (next.length === activeInputRequests.value.length) return;
    activeInputRequests.value = next;
  }

  /** Upsert a per-workspace storage status push. */
  function applyStorageStatus(status: AgentTaskStorageStatus): void {
    const idx = storageStatuses.value.findIndex((s) => s.workspaceId === status.workspaceId);
    const next = storageStatuses.value.slice();
    if (idx >= 0) {
      next[idx] = status;
    } else {
      next.push(status);
    }
    storageStatuses.value = next;
  }

  /** Upsert a recovery issue push (read-only diagnostic mirror, never forged into tasks). */
  function applyRecoveryIssue(issue: AgentTaskRecoveryIssue): void {
    const idx = recoveryIssues.value.findIndex((i) => i.taskId === issue.taskId);
    const next = recoveryIssues.value.slice();
    if (idx >= 0) {
      next[idx] = issue;
    } else {
      next.push(issue);
    }
    recoveryIssues.value = next;
  }

  /** Append a live file change push (按 toolCallId 去重;重复的 live 追加被忽略)。 */
  function appendFileChange(taskId: string, change: FileChangeSummary): void {
    const list = fileChanges.value[taskId] ?? [];
    if (list.some((item) => item.toolCallId === change.toolCallId)) return;
    fileChanges.value = { ...fileChanges.value, [taskId]: [...list, change] };
  }

  function handleAgentTaskEvent(event: AgentTaskEvent): void {
    switch (event.type) {
      case "task_state":
        applyTaskState(event.task);
        // 终态收敛(双保险):main 在终态 task_state 之前已 flush 并清 watcher;
        // 本地 watched 同样置 false(TaskDetailPanel 卸载时仍发 unwatch,幂等)。
        if (TERMINAL_STATUSES.has(event.task.status)) {
          const state = transcripts.value[event.task.taskId];
          if (state) {
            state.watched = false;
          }
        }
        break;
      case "task_activities":
        applyActivities(event.taskId, event.activities, {
          toolUseCount: event.toolUseCount,
          durationMs: event.durationMs,
        });
        break;
      case "task_output":
        applyOutput(event.taskId, event.output, event.truncated);
        break;
      case "task_input_dismissed":
        dismissInputRequest(event.taskId, event.requestId, event.generation);
        break;
      case "storage_status":
        applyStorageStatus(event.status);
        break;
      case "recovery_issue":
        applyRecoveryIssue(event.issue);
        break;
      case "task_transcript":
        appendTranscriptEvent(event.taskId, event.itemIndex, event.event);
        break;
      case "task_file_change":
        appendFileChange(event.taskId, event.change);
        break;
      case "task_removed":
        removeTaskFromMirror(event.taskId);
        break;
    }
  }

  // ==========================================================================
  // Subscription
  // ==========================================================================

  let unsubscribeEvents: (() => void) | null = null;

  /**
   * Subscribe to task events from main and sync the mirrors. Must be called
   * once on app init / panel mount. A re-subscribe (window reopen, component
   * remount) replaces the previous subscription instead of stacking a second
   * listener that would process every event twice.
   */
  function subscribeToEvents(): () => void {
    if (unsubscribeEvents) {
      unsubscribeEvents();
    }
    const offEvent = taskRpc.onAgentTaskEvent((event) => {
      handleAgentTaskEvent(event);
    });
    const offInput = taskRpc.onAgentTaskInputRequest((request) => {
      applyInputRequest(request);
    });
    unsubscribeEvents = () => {
      offEvent();
      offInput();
      unsubscribeEvents = null;
    };
    // Remount catch-up: query the authoritative mirrors AFTER the subscription
    // is live, so a push arriving before the response is never overwritten by
    // an older snapshot result. The service serializes commands against its
    // own state, so the response is never older than any already-delivered
    // push.
    void refreshTasks();
    void refreshActiveInputRequests();
    return unsubscribeEvents;
  }

  /**
   * Query the authoritative task list (remount catch-up). 1.4.2 (R2) get_all
   * returns an AgentTaskListSnapshot carrying tasks + recoveryIssues +
   * storageStatuses; the plain-array branch is kept for the 1.4.1-era test
   * stub shape so older store tests keep exercising the same mirror.
   */
  async function refreshTasks(): Promise<AgentTaskInfo[] | null> {
    try {
      const result = await taskRpc.sendAgentTaskCommand({ type: "get_all" });
      if (result.success && result.data) {
        // Advance the marker BEFORE the mirror replacement so a tasks watcher
        // observing the batch sees the new version and treats it as baseline.
        bulkHydrationVersion.value += 1;
        if (Array.isArray(result.data)) {
          tasks.value = result.data;
        } else {
          tasks.value = result.data.tasks;
          recoveryIssues.value = result.data.recoveryIssues ?? [];
          storageStatuses.value = result.data.storageStatuses ?? [];
        }
        return tasks.value.slice();
      }
      return null;
    } catch (err) {
      console.error("[agent-task-store] Failed to get tasks:", err);
      return null;
    }
  }

  /** Query the authoritative pending input requests (remount catch-up). */
  async function refreshActiveInputRequests(): Promise<AgentTaskInputRequest[] | null> {
    try {
      const result = await taskRpc.sendAgentTaskCommand({ type: "get_active_input_requests" });
      if (result.success && result.data) {
        activeInputRequests.value = result.data;
        return result.data;
      }
      return null;
    } catch (err) {
      console.error("[agent-task-store] Failed to get active input requests:", err);
      return null;
    }
  }

  // ==========================================================================
  // Commands
  // ==========================================================================

  /**
   * Send an agent-task command through the preload API. Every command carries
   * taskId+generation (stale responses are rejected in main, never here). The
   * mirror is updated by events only; the retention pass announces deletions
   * through task_removed.
   */
  async function runCommand<C extends AgentTaskCommandV15>(
    command: C,
  ): Promise<PixCommandResult<AgentTaskCommandDataV15<C>>> {
    try {
      const result = await taskRpc.sendAgentTaskCommand(command);
      if (result.success) {
        lastError.value = null;
      } else {
        lastError.value = result.error ?? `任务命令 ${command.type} 执行失败`;
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError.value = message;
      return { success: false, error: message, code: "agent_task_command_failed" };
    }
  }

  /** Stop a queued/running/waiting task (the only task-level user control). */
  function cancel(taskId: string, generation: number): Promise<PixCommandResult<undefined>> {
    return runCommand({ type: "cancel", taskId, generation });
  }

  function respondInput(
    taskId: string,
    requestId: string,
    generation: number,
    response: RequestUserInputResponse,
  ): Promise<PixCommandResult<undefined>> {
    return runCommand({ type: "respond_input", taskId, requestId, generation, response });
  }

  function cancelInput(taskId: string, requestId: string, generation: number): Promise<PixCommandResult<undefined>> {
    return runCommand({ type: "cancel_input", taskId, requestId, generation });
  }

  /**
   * Remove a deleted task from every mirror it appears in. 1.5 (P1): the
   * retention pass deletes terminal records in main and announces each one
   * through the task_removed push. Idempotent: the task may already be gone
   * (a remount get_all refresh arrived first). 1.5 (P2): also clears
   * selectedTaskId when the deleted task was the selected one (the task center
   * falls back to its empty detail placeholder). 1.5 (P3): drops the task's
   * transcript buffer with it (liveEvents/entries are per-task); 1.5 (P4):
   * the file-changes live buffer is dropped the same way.
   */
  function removeTaskFromMirror(taskId: string): void {
    tasks.value = tasks.value.filter((t) => t.taskId !== taskId);
    activeInputRequests.value = activeInputRequests.value.filter((r) => r.taskId !== taskId);
    recoveryIssues.value = recoveryIssues.value.filter((i) => i.taskId !== taskId);
    if (selectedTaskId.value === taskId) {
      selectedTaskId.value = null;
    }
    if (transcripts.value[taskId]) {
      const next = { ...transcripts.value };
      delete next[taskId];
      transcripts.value = next;
    }
    if (fileChanges.value[taskId]) {
      const next = { ...fileChanges.value };
      delete next[taskId];
      fileChanges.value = next;
    }
  }

  /** Export a task's diagnostic payload (retained for debugging). */
  function exportDiagnostics(taskId: string): Promise<PixCommandResult<AgentTaskDiagnosticExport>> {
    return runCommand({ type: "export_diagnostics", taskId });
  }

  /** Select the task the task center should expand; null clears the selection. */
  function selectTask(taskId: string | null): void {
    selectedTaskId.value = taskId;
  }

  /**
   * 1.5 (P2): the only entry into the task center. taskId is optional - with
   * it the center opens already focused on the task (terminal tasks flip the
   * TaskCenterView to the history view); without it the center just opens.
   */
  function openTaskCenter(taskId?: string): void {
    centerOpen.value = true;
    if (taskId !== undefined) {
      selectedTaskId.value = taskId;
    }
  }

  function closeTaskCenter(): void {
    centerOpen.value = false;
  }

  function clearError(): void {
    lastError.value = null;
  }

  // ==========================================================================
  // Transcript channel (1.5 P3/S5): TaskDetailPanel owns the write side
  // (watch/unwatch), TaskTranscriptView owns the read side (pages + live ring).
  // ==========================================================================

  /** Per-store monotonic seq for live transcript events. */
  let transcriptSeq = 0;

  function ensureTranscriptState(taskId: string): TaskTranscriptState {
    let state = transcripts.value[taskId];
    if (!state) {
      state = {
        byItem: {},
        liveEvents: [],
        liveDropped: false,
        watched: false,
        consumedSeq: 0,
      };
      transcripts.value = { ...transcripts.value, [taskId]: state };
    }
    return state;
  }

  function ensureTranscriptItem(
    state: TaskTranscriptState,
    itemIndex: number,
  ): TaskTranscriptState["byItem"][number] {
    let item = state.byItem[itemIndex];
    if (!item) {
      item = { entries: [], totalCount: 0, nextCursor: null, prevCursor: null, loading: false, loadingOlder: false };
      state.byItem = { ...state.byItem, [itemIndex]: item };
    }
    return item;
  }

  /** Push a live transcript event onto the ring (drop-oldest at the cap). */
  function appendTranscriptEvent(taskId: string, itemIndex: number, event: AgentSessionEvent): void {
    const state = ensureTranscriptState(taskId);
    const seq = transcriptSeq;
    transcriptSeq += 1;
    state.liveEvents.push({ seq, itemIndex, event });
    if (state.liveEvents.length > TRANSCRIPT_LIVE_EVENTS_LIMIT) {
      state.liveEvents.splice(0, state.liveEvents.length - TRANSCRIPT_LIVE_EVENTS_LIMIT);
      state.liveDropped = true;
    }
  }

  /**
   * Register a task watcher (发命令 + 本地 watched=true). TaskDetailPanel is
   * the sole owner; the work-record and file-changes tabs both consume this
   * subscription. Idempotent: main counts and repeats are no-ops.
   */
  async function watchTask(taskId: string): Promise<void> {
    const state = ensureTranscriptState(taskId);
    state.watched = true;
    await runCommand({ type: "watch_task", taskId });
  }

  /** Release the task watcher (发命令 + watched=false). Idempotent; unknown
   * tasks still return success in main. */
  function unwatchTask(taskId: string): void {
    const state = transcripts.value[taskId];
    if (state) {
      state.watched = false;
    }
    void runCommand({ type: "unwatch_task", taskId });
  }

  /**
   * Load (or re-load, disk as truth) one item's transcript pages. Drains
   * get_transcript from the head until nextCursor is null and replaces the
   * item's entries with the full array; the caller (TaskTranscriptView)
   * refolds the whole array through assembler.loadEntries - the assembler has
   * no append semantics. A failed drain keeps the previous cache instead of
   * regressing it to empty (the lastError banner surfaces the failure).
   */
  async function loadTranscriptPage(taskId: string, itemIndex = 0): Promise<void> {
    const state = ensureTranscriptState(taskId);
    const item = ensureTranscriptItem(state, itemIndex);
    if (item.loading) return;
    item.loading = true;
    try {
      const result: PixCommandResult<AgentTaskTranscriptPage> = await runCommand({
        type: "get_transcript",
        taskId,
        itemIndex,
        tail: true,
        limit: 80,
      });
      if (!result.success || !result.data) return;
      item.entries = result.data.entries;
      item.totalCount = result.data.totalCount;
      item.nextCursor = result.data.nextCursor;
      item.prevCursor = result.data.prevCursor ?? null;
    } finally {
      item.loading = false;
    }
  }

  async function loadOlderTranscriptPage(taskId: string, itemIndex = 0): Promise<boolean> {
    const state = ensureTranscriptState(taskId);
    const item = ensureTranscriptItem(state, itemIndex);
    if (item.loading || item.loadingOlder || !item.prevCursor) return false;
    item.loadingOlder = true;
    try {
      const result: PixCommandResult<AgentTaskTranscriptPage> = await runCommand({
        type: "get_transcript",
        taskId,
        itemIndex,
        before: item.prevCursor,
        limit: 80,
      });
      if (!result.success || !result.data || result.data.entries.length === 0) {
        item.prevCursor = null;
        return false;
      }
      item.entries = result.data.entries.concat(item.entries);
      item.prevCursor = result.data.prevCursor ?? null;
      return true;
    } finally {
      item.loadingOlder = false;
    }
  }

  /** Replace one task with a full service snapshot (selected-task catch-up). */
  async function hydrateSelectedTask(taskId: string): Promise<void> {
    const result: PixCommandResult<AgentTaskInfo> = await runCommand({ type: "get", taskId });
    if (!result.success || !result.data) return;
    applyTaskState(result.data);
  }

  // ==========================================================================
  // 任务日志通道 (1.5 P4/S7):get_task_log 只读快照,服务端先 drain persist,
  // 供 TaskFileChanges(历史 file_change)消费。
  // ==========================================================================

  /** 拉取任务事件日志(events.jsonl)只读快照;失败经 lastError 上报,不抛出。 */
  function getTaskLog(taskId: string): Promise<PixCommandResult<AgentTaskLogSnapshot>> {
    return runCommand({ type: "get_task_log", taskId });
  }

  // ==========================================================================
  // Expose
  // ==========================================================================

  return {
    // State
    tasks,
    activeInputRequests,
    recoveryIssues,
    storageStatuses,
    selectedTaskId,
    centerOpen,
    lastError,
    transcripts,
    fileChanges,
    // Computed
    waitingTasks,
    interruptedTasks,
    activeTasks,
    terminalTasks,
    storageWarnings,
    storageFulls,
    groupAutoBackgrounds,
    selectedTask,
    // Subscription
    subscribeToEvents,
    refreshTasks,
    refreshActiveInputRequests,
    bulkHydrationVersion,
    // Actions (map agent-task-command)
    cancel,
    respondInput,
    cancelInput,
    exportDiagnostics,
    selectTask,
    openTaskCenter,
    closeTaskCenter,
    clearError,
    hydrateSelectedTask,
    // Transcript channel
    watchTask,
    unwatchTask,
    loadTranscriptPage,
    loadOlderTranscriptPage,
    // Task log channel (P4)
    getTaskLog,
  };
});
