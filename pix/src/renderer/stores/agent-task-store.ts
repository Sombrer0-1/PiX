/**
 * Agent Task Store (PiX 1.4.1; 1.4.2 R5 adds the recovery surface)
 *
 * Pinia mirror of the app-level agent task state owned by the main-process
 * AgentTaskService. The renderer never invents task state: every change
 * arrives as a task_state / task_activities / task_output /
 * task_input_dismissed / storage_status / recovery_issue event or as the
 * get_all / get_active_input_requests remount catch-up, and actions map
 * one-to-one onto the §4.9 AgentTaskCommand IPC contract through the
 * useAgentTaskRpc transport. The one exception: main emits no event when
 * clear / clear_all_terminal delete a task, so a successful clear rewrites
 * the mirror (removes the task) as a supplement to the event flow.
 *
 * 1.4.1 grouping: waiting (waiting_input), active (running+queued as one
 * group) and recent (completed/failed/cancelled, bounded by
 * AGENT_TASK_MAX_RECENT_ACTIVITIES). 1.4.2 (R5) adds the interrupted group
 * (restart hydration), plus the recoveryIssues and storageStatuses mirrors
 * delivered by the R2 get_all snapshot / storage_status / recovery_issue
 * events, and the recovery command actions (get_resume_summary, resume,
 * mark_failed, clear_all_terminal, export_diagnostics).
 *
 * The auto-background deadline is group-level: every non-terminal child of an
 * attached foreground group mirrors the same deadlineAt/warningAt/warningActive
 * (design plan §4.5). The store keeps sibling tasks consistent on each
 * task_state push: a push that carries (or drops) the shared deadline is
 * mirrored across the group's non-terminal tasks, and groupAutoBackgrounds
 * exposes one shared deadline per group. warningActive is monotonic within a
 * timer run, so an equal-deadline warning push never regresses siblings.
 */

import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useAgentTaskRpc } from "../composables/useAgentTaskRpc";
import { AGENT_TASK_MAX_RECENT_ACTIVITIES } from "@shared/agent-task-types.js";
import type {
  AgentTaskActivity,
  AgentTaskClearAllResult,
  AgentTaskDiagnosticExport,
  AgentTaskInfo,
  AgentTaskInputRequest,
  AgentTaskRecoveryIssue,
  AgentTaskResumeSummary,
  AgentTaskStorageStatus,
  ResumeDecision,
} from "@shared/agent-task-types.js";
import type {
  AgentTaskCommandDataV142,
  AgentTaskCommandV142,
  AgentTaskEvent,
  PixCommandResult,
  RequestUserInputResponse,
} from "@shared/types.js";

/** Shared auto-background deadline of one foreground task group. */
export interface GroupAutoBackground {
  deadlineAt: number;
  warningAt: number;
  warningActive: boolean;
}

const ACTIVE_STATUSES: ReadonlySet<AgentTaskInfo["status"]> = new Set(["queued", "running", "waiting_input"]);

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

  /** Task currently expanded/selected by the panel; null = none. */
  const selectedTaskId = ref<string | null>(null);

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

  /** Most recently ended terminal tasks, bounded by AGENT_TASK_MAX_RECENT_ACTIVITIES. */
  const recentTasks = computed(() => {
    const recent = tasks.value
      .filter((t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled")
      .slice()
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    return recent.slice(0, AGENT_TASK_MAX_RECENT_ACTIVITIES);
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
        // The warning is monotonic within a timer run: an equal-deadline push
        // arriving after the warning fired must not regress it on this task.
        incoming = { ...task, autoBackground: { ...incomingBg, warningActive: true } };
      }
    }
    const next = tasks.value.slice();
    if (idx >= 0) {
      next[idx] = incoming;
    } else {
      next.push(incoming);
    }
    tasks.value = mirrorGroupAutoBackground(incoming, next);
  }

  /** Replace a task's activity list wholesale (bounded throttle merges in main). */
  function applyActivities(taskId: string, activities: AgentTaskActivity[]): void {
    const idx = tasks.value.findIndex((t) => t.taskId === taskId);
    if (idx < 0) return;
    const next = tasks.value.slice();
    next[idx] = { ...next[idx], activities };
    tasks.value = next;
  }

  /** Replace a task's final output wholesale (bounded throttle merges in main). */
  function applyOutput(taskId: string, output: string, truncated: boolean): void {
    const idx = tasks.value.findIndex((t) => t.taskId === taskId);
    if (idx < 0) return;
    const next = tasks.value.slice();
    next[idx] = { ...next[idx], finalOutput: output, outputTruncated: truncated };
    tasks.value = next;
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

  function handleAgentTaskEvent(event: AgentTaskEvent): void {
    switch (event.type) {
      case "task_state":
        applyTaskState(event.task);
        break;
      case "task_activities":
        applyActivities(event.taskId, event.activities);
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
   * mirror is updated by events; the only command side effects that rewrite
   * the mirror are the clear/clear_all_terminal success deletions below (main
   * removes the record without emitting any task event).
   */
  async function runCommand<C extends AgentTaskCommandV142>(
    command: C,
  ): Promise<PixCommandResult<AgentTaskCommandDataV142<C>>> {
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

  function cancel(taskId: string, generation: number): Promise<PixCommandResult<undefined>> {
    return runCommand({ type: "cancel", taskId, generation });
  }

  function background(taskId: string, generation: number): Promise<PixCommandResult<undefined>> {
    return runCommand({ type: "background", taskId, generation });
  }

  function foreground(taskId: string, generation: number): Promise<PixCommandResult<undefined>> {
    return runCommand({ type: "foreground", taskId, generation });
  }

  function continueForegroundWait(taskId: string, generation: number): Promise<PixCommandResult<undefined>> {
    return runCommand({ type: "continue_foreground_wait", taskId, generation });
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

  function sendToSession(
    taskId: string,
    generation: number,
    targetSessionId: string,
    confirmDuplicate?: boolean,
  ): Promise<PixCommandResult<undefined>> {
    return runCommand({ type: "send_to_session", taskId, generation, targetSessionId, confirmDuplicate });
  }

  /** Terminal statuses that clear_all_terminal removes (main's semantics). */
  function isTerminalStatus(status: AgentTaskInfo["status"]): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
  }

  /**
   * Remove a deleted task from every mirror it appears in. Main deletes the
   * on-disk record and in-memory entry of a cleared task without emitting any
   * task event (the AgentTaskEventV142 union has no removal type), so a
   * successful clear must converge the mirror here. Idempotent: the task may
   * already be gone (a remount get_all refresh arrived first), and a task
   * whose record only existed as a recovery issue has no task entry at all.
   */
  function removeTaskFromMirror(taskId: string): void {
    tasks.value = tasks.value.filter((t) => t.taskId !== taskId);
    activeInputRequests.value = activeInputRequests.value.filter((r) => r.taskId !== taskId);
    recoveryIssues.value = recoveryIssues.value.filter((i) => i.taskId !== taskId);
  }

  function clearTask(taskId: string, generation: number, confirmDataLoss: boolean): Promise<PixCommandResult<undefined>> {
    return runCommand({ type: "clear", taskId, generation, confirmDataLoss }).then((result) => {
      // Main emits no removal event for clear; converge the mirror on success.
      if (result.success) removeTaskFromMirror(taskId);
      return result;
    });
  }

  // ---- 1.4.2 (R3/R5) recovery commands -------------------------------------

  /** Fetch the resume summary; shown to the user BEFORE any resume decision. */
  function getResumeSummary(taskId: string, generation: number): Promise<PixCommandResult<AgentTaskResumeSummary>> {
    return runCommand({ type: "get_resume_summary", taskId, generation });
  }

  /** Resume an interrupted task with the user's explicit workspace/model decision. */
  function resume(taskId: string, generation: number, decision: ResumeDecision): Promise<PixCommandResult<undefined>> {
    return runCommand({ type: "resume", taskId, generation, decision });
  }

  /** Mark an interrupted task failed (user decision). */
  function markFailed(taskId: string, generation: number): Promise<PixCommandResult<undefined>> {
    return runCommand({ type: "mark_failed", taskId, generation });
  }

  /** Clear all terminal tasks (interrupted/corrupt records stay protected). */
  function clearAllTerminal(
    workspaceId: string | undefined,
    confirm: boolean,
  ): Promise<PixCommandResult<AgentTaskClearAllResult>> {
    return runCommand({ type: "clear_all_terminal", workspaceId, confirm }).then((result) => {
      if (result.success && result.data) {
        // Main returns only the cleared count plus protectedTaskIds and emits
        // no removal events, so the mirror converges to main's semantics:
        // terminal tasks of the workspace that are not protected are deleted;
        // everything else (other workspaces, protected tasks, non-terminal
        // tasks) stays.
        const protectedIds = new Set(result.data.protectedTaskIds);
        const workspaceMatch = (t: { workspaceId: string }): boolean =>
          workspaceId === undefined || t.workspaceId === workspaceId;
        tasks.value = tasks.value.filter(
          (t) => !workspaceMatch(t) || protectedIds.has(t.taskId) || !isTerminalStatus(t.status),
        );
        // Corrupt records have no task entry; they surface as recovery issues
        // and are returned as protected ids, so only those stay.
        recoveryIssues.value = recoveryIssues.value.filter((i) => !workspaceMatch(i) || protectedIds.has(i.taskId));
      }
      return result;
    });
  }

  /** Export a recovery issue's diagnostic payload. */
  function exportDiagnostics(taskId: string): Promise<PixCommandResult<AgentTaskDiagnosticExport>> {
    return runCommand({ type: "export_diagnostics", taskId });
  }

  /** Select the task the panel should expand; null clears the selection. */
  function selectTask(taskId: string | null): void {
    selectedTaskId.value = taskId;
  }

  function clearError(): void {
    lastError.value = null;
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
    lastError,
    // Computed
    waitingTasks,
    interruptedTasks,
    activeTasks,
    recentTasks,
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
    background,
    foreground,
    continueForegroundWait,
    respondInput,
    cancelInput,
    sendToSession,
    clearTask,
    getResumeSummary,
    resume,
    markFailed,
    clearAllTerminal,
    exportDiagnostics,
    selectTask,
    clearError,
  };
});
