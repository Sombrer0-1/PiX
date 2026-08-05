/**
 * Team Store
 *
 * Pinia store that manages team state in the renderer process.
 * Subscribes to team events from the main process and maintains
 * a reactive team state snapshot.
 */

import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import { useRpc } from "../composables/useRpc";
import { useTeamLeaderRpc } from "../composables/useTeamLeaderRpc";
import { useProjectStore } from "./project-store";
import type {
  TeamState,
  TeamEvent,
  TeamHistory,
  TeammateInfo,
  TeammateStatus,
  TeammateChatMessage,
  TeamMessage,
  TeamTask,
  AgentSessionEvent,
  PermissionRequest,
  PlanApproval,
} from "@shared/types.js";

/** Wrapper for a worker's raw AgentSessionEvent, tagged with agentId. */
export interface TaggedSessionEvent {
  agentId: string;
  event: AgentSessionEvent;
  timestamp: number;
}

/** Truncate a string to maxLen characters, appending "..." if truncated. */
function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
}

/** Extract plain text from an AgentMessage content field. */
function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("");
}

export const useTeamStore = defineStore("team", () => {
  const singleRpc = useRpc();
  const teamLeaderRpc = useTeamLeaderRpc();
  const projectStore = useProjectStore();

  // ==========================================================================
  // State
  // ==========================================================================

  /** Current team state, null if no team is active. */
  const teamState = ref<TeamState | null>(null);

  /** Whether a team operation is in progress. */
  const isLoading = ref(false);

  /** Last error message from a team operation. */
  const lastError = ref<string | null>(null);

  /** Per-worker message timelines. Keyed by agentId. */
  const workerMessages = ref<Record<string, TeammateChatMessage[]>>({});

  /** Per-worker raw session events (capped at 200 per worker). Keyed by agentId. */
  const workerEvents = ref<Record<string, TaggedSessionEvent[]>>({});

  /** Rich message bus messages for the team timeline. */
  const teamMessages = ref<TeamMessage[]>([]);

  /** Shared team task list. */
  const teamTasks = ref<TeamTask[]>([]);

  /** Pending permission requests from workers. */
  const permissionRequests = ref<PermissionRequest[]>([]);

  /** Pending plan approval requests from workers. */
  const planApprovals = ref<PlanApproval[]>([]);

  /** Whether the Team Dashboard view is active (user toggled team mode on). */
  const teamMode = ref(false);

  /** Currently focused worker agent ID. null = no worker focused. */
  const focusedAgentId = ref<string | null>(null);

  /** Worker summary messages injected by the Leader (displayed in Leader chat context). */
  const workerSummaries = ref<Array<{ fromAgentId: string; summary: string; taskId?: string; timestamp: number }>>([]);

  // ==========================================================================
  // Computed
  // ==========================================================================

  /** Whether a team is currently active. */
  const isTeamActive = computed(() => teamState.value?.status === "active");

  /** Team name, or null. */
  const teamName = computed(() => teamState.value?.name ?? null);

  /** Array of teammate info objects. */
  const teammates = computed<TeammateInfo[]>(() => {
    if (!teamState.value) return [];
    return Object.values(teamState.value.teammates);
  });

  const completedTaskIds = computed(() =>
    new Set(teamTasks.value.filter((task) => task.status === "completed").map((task) => task.id)),
  );

  const readyTasks = computed(() =>
    teamTasks.value.filter((task) => {
      if (task.status !== "pending" && task.status !== "assigned") return false;
      return task.blockedBy.every((depId) => completedTaskIds.value.has(depId));
    }),
  );

  const activeTasks = computed(() => teamTasks.value.filter((task) => task.status === "in_progress"));

  const waitingTasks = computed(() =>
    teamTasks.value.filter((task) => {
      if (task.status !== "pending" && task.status !== "assigned") return false;
      return task.blockedBy.some((depId) => !completedTaskIds.value.has(depId));
    }),
  );

  const problemTasks = computed(() => teamTasks.value.filter((task) => task.status === "blocked" || task.status === "failed"));

  const doneTasks = computed(() => teamTasks.value.filter((task) => task.status === "completed"));

  /** Protocol items that need user attention (permission approvals). */
  const pendingProtocolCount = computed(() => permissionRequests.value.length + planApprovals.value.length);

  /** Per-agent current activity summary derived from the latest session event. */
  const currentActivity = computed<Record<string, string>>(() => {
    const result: Record<string, string> = {};
    for (const [agentId, events] of Object.entries(workerEvents.value)) {
      if (events.length === 0) continue;
      // Walk backwards to find the most recent meaningful event
      for (let i = events.length - 1; i >= 0; i--) {
        const tagged = events[i];
        const ev = tagged.event;
        if (ev.type === "tool_execution_start") {
          result[agentId] = ev.toolName === "bash" ? `正在运行：${truncate(String(ev.args), 60)}` : `正在使用：${ev.toolName}`;
          break;
        }
        if (ev.type === "message_update" || ev.type === "message_start") {
          const text = extractText(ev.message.content);
          if (text) {
            result[agentId] = truncate(text, 80);
            break;
          }
        }
        if (ev.type === "tool_execution_end") {
          result[agentId] = ev.isError ? `${ev.toolName} 执行出错` : `已完成：${ev.toolName}`;
          break;
        }
      }
    }
    return result;
  });

  // ==========================================================================
  // Actions
  // ==========================================================================

  /** Active team-event unsubscribe handle (the store is a singleton, so only one
   * subscription may be live at a time; a second subscribe replaces the first). */
  let unsubscribeTeamEvents: (() => void) | null = null;

  /** Subscribe to team events from main process. Must be called once on app init. */
  function subscribeToEvents(): () => void {
    // Guard against duplicate subscriptions: a re-subscribe (window reopen,
    // component remount) would otherwise register a second handler and every
    // event would be processed twice (duplicating un-deduped events/summaries).
    if (unsubscribeTeamEvents) {
      unsubscribeTeamEvents();
    }
    const off = window.pixApi.onTeamEvent((event: TeamEvent) => {
      handleTeamEvent(event);
    });
    unsubscribeTeamEvents = () => {
      off();
      unsubscribeTeamEvents = null;
    };
    return unsubscribeTeamEvents;
  }

  /** Create a new team. */
  async function createTeam(teamName?: string): Promise<boolean> {
    isLoading.value = true;
    lastError.value = null;
    try {
      const result = await window.pixApi.sendTeamCommand<TeamState>({
        type: "create_team",
        teamName,
      });
      if (result.success && result.data) {
        // Fresh team: drop any collections left over from a previous team
        // (the team_deleted event skips clearing when names differ).
        resetTeamCollections();
        teamState.value = result.data;
        // Initialize message/event stores for each worker
        for (const agentId of Object.keys(result.data.teammates)) {
          workerMessages.value[agentId] = [];
          workerEvents.value[agentId] = [];
        }
        return true;
      }
      lastError.value = result.error ?? "创建团队失败";
      return false;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return false;
    } finally {
      isLoading.value = false;
    }
  }

  /** Clear all per-team collections (messages, events, tasks, protocol state). */
  function resetTeamCollections(): void {
    workerMessages.value = {};
    workerEvents.value = {};
    teamMessages.value = [];
    teamTasks.value = [];
    workerSummaries.value = [];
    permissionRequests.value = [];
    planApprovals.value = [];
    focusedAgentId.value = null;
  }

  /** Query the current team state from main process. */
  async function fetchTeamState(): Promise<void> {
    try {
      const result = await window.pixApi.sendTeamCommand<TeamState | null>({
        type: "get_team_state",
      });
      if (result.success) {
        const next = result.data ?? null;
        // When the team identity changes (switching sessions, or no team in the
        // newly-opened session), drop the previous team's messages/tasks/events
        // so they don't bleed into — or merge with — the new session's data.
        if ((next?.name ?? null) !== (teamState.value?.name ?? null)) {
          resetTeamCollections();
        }
        // An active team discovered on mount (e.g. restored after app restart)
        // should open the team workbench without requiring a manual toggle.
        if (next?.status === "active" && !teamState.value) {
          teamMode.value = true;
        }
        // If the team is gone but teamMode is still on (e.g. leader crashed
        // while the workbench was unmounted and the watcher that would
        // auto-recover was disposed), drop out of team mode so the workspace
        // falls back to solo instead of showing a dead team UI.
        if (next === null && teamMode.value) {
          teamMode.value = false;
        }
        teamState.value = next;
      }
    } catch (err) {
      console.error("[team-store] Failed to fetch team state:", err);
    }
  }

  /**
   * Hydrate persisted history (worker chats, bus messages, tasks) into the
   * store. Called after a team is created/restored so a reopened project shows
   * the previous teammate conversations instead of empty panels. Live events
   * may race this; everything is merged and deduped by id.
   */
  async function fetchTeamHistory(): Promise<void> {
    try {
      const result = await window.pixApi.sendTeamCommand<TeamHistory | null>({
        type: "get_team_history",
      });
      if (!result.success || !result.data) return;
      const history = result.data;

      for (const [agentId, messages] of Object.entries(history.workerMessages)) {
        const existing = workerMessages.value[agentId] ?? [];
        const byId = new Map(existing.map((m) => [m.id, m]));
        for (const msg of messages) {
          if (!byId.has(msg.id)) byId.set(msg.id, msg);
        }
        workerMessages.value[agentId] = [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
      }

      const teamById = new Map(teamMessages.value.map((m) => [m.id, m]));
      for (const msg of history.teamMessages) {
        if (!teamById.has(msg.id)) teamById.set(msg.id, msg);
      }
      teamMessages.value = [...teamById.values()].sort((a, b) => a.timestamp - b.timestamp);

      const taskById = new Map(teamTasks.value.map((t) => [t.id, t]));
      for (const task of history.tasks) {
        if (!taskById.has(task.id)) taskById.set(task.id, task);
      }
      teamTasks.value = [...taskById.values()];
    } catch (err) {
      console.error("[team-store] Failed to fetch team history:", err);
    }
  }

  /** Stop the active team. */
  async function stopTeam(): Promise<boolean> {
    isLoading.value = true;
    lastError.value = null;
    try {
      const result = await window.pixApi.sendTeamCommand({ type: "stop_team" });
      if (result.success) {
        // Don't clear state here — the team_deleted event from main process
        // will clear all state atomically, avoiding a window where late events
        // re-populate already-cleared stores.
        return true;
      }
      lastError.value = result.error ?? "停止团队失败";
      return false;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return false;
    } finally {
      isLoading.value = false;
    }
  }

  /** Send a message to a specific worker. */
  async function sendMessageToWorker(agentId: string, message: string): Promise<boolean> {
    try {
      const result = await window.pixApi.sendTeamCommand({
        type: "send_message",
        agentId,
        message,
      });
      if (!result.success) {
        lastError.value = result.error ?? "发送消息失败";
        return false;
      }
      return true;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /** Abort a specific worker's current turn. Worker returns to idle. */
  async function abortWorker(agentId: string): Promise<boolean> {
    try {
      const result = await window.pixApi.sendTeamCommand({
        type: "abort_worker",
        agentId,
      });
      if (!result.success) {
        lastError.value = result.error ?? "停止成员当前任务失败";
        return false;
      }
      return true;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /** Bring a dormant/standby member into the current team work. */
  async function activateMember(agentId: string): Promise<boolean> {
    try {
      const result = await window.pixApi.sendTeamCommand({
        type: "activate_member",
        agentId,
      });
      if (!result.success) {
        lastError.value = result.error ?? "唤醒团队成员失败";
        return false;
      }
      return true;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /** Pause a member while keeping their roster identity and history. */
  async function pauseMember(agentId: string): Promise<boolean> {
    try {
      const result = await window.pixApi.sendTeamCommand({
        type: "pause_member",
        agentId,
      });
      if (!result.success) {
        lastError.value = result.error ?? "暂停团队成员失败";
        return false;
      }
      return true;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /** Clear error state. */
  function clearError(): void {
    lastError.value = null;
  }

  /** Switch the workspace between the independent single and Team runtimes. */
  async function toggleTeamMode(projectDir?: string): Promise<boolean> {
    if (isLoading.value) return false;
    if (!projectDir) {
      lastError.value = "切换模式前需要先打开项目目录";
      return false;
    }

    isLoading.value = true;
    lastError.value = null;
    try {
      if (teamMode.value) {
        await teamLeaderRpc.stopTeamRuntime();
        const started = await singleRpc.startRuntime(projectDir);
        if (!started) {
          lastError.value = singleRpc.lastError.value || "启动单人运行环境失败";
          // Solo failed to start; restore the team runtime so the workspace is
          // not left with both runtimes down while the UI still shows team mode.
          const restored = await teamLeaderRpc.startTeamRuntime(projectDir);
          if (!restored) {
            lastError.value = `${lastError.value}\n恢复团队运行环境也失败：${teamLeaderRpc.lastError.value || "未知错误"}`;
            // Both runtimes are down. Drop to solo mode so the workspace shows a
            // retryable solo error state instead of a dead team workspace. The
            // piStatus recovery watch below does not fire here because
            // stopTeamRuntime already set piStatus to "stopped" during this
            // isLoading-guarded toggle, so there is no later status change to
            // react to.
            teamMode.value = false;
          }
          return false;
        }
        teamMode.value = false;
        void window.pixApi.setWorkspaceMode(projectDir, "solo");
        focusedAgentId.value = null;
        return true;
      }

      const started = await teamLeaderRpc.startTeamRuntime(projectDir);
      if (!started) {
        lastError.value = teamLeaderRpc.lastError.value || "启动团队运行环境失败";
        // start-team-runtime stops the single runtime before starting the
        // leader, so restore ordinary mode if Team startup fails.
        const restored = await singleRpc.startRuntime(projectDir);
        if (!restored) {
          lastError.value = `${lastError.value}\n恢复单人运行环境也失败：${singleRpc.lastError.value || "未知错误"}`;
        }
        return false;
      }
      teamMode.value = true;
      void window.pixApi.setWorkspaceMode(projectDir, "team");
      return true;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return false;
    } finally {
      isLoading.value = false;
    }
  }

  // If the team leader runtime exits while the workspace is in team mode
  // (e.g. it crashed while the user was on another page and the CenterPanel
  // canUseTeamMode auto-recovery watcher had been disposed with the
  // component), recover to a functional solo workspace from the store: stop the
  // dead leader and start the single runtime. Running this in the singleton
  // store means it fires even when WorkspacePage/CenterPanel are unmounted, so
  // navigating back lands in a working solo workspace instead of a dead team
  // UI. This matters because a crash does not clear TeamManager._team, so
  // fetchTeamState still returns non-null stale state and the canUseTeamMode
  // watcher (no immediate, and disposed while away) never re-fires.
  //
  // The isLoading guard inside toggleTeamMode prevents a double switch when
  // CenterPanel's canUseTeamMode watcher fires at the same time, and also
  // blocks this callback during a normal team->solo toggle - whose
  // stopTeamRuntime also flips piStatus to "stopped" while teamMode is still
  // true. Only an unsolicited leader exit (status becomes "stopped" outside a
  // toggle) triggers recovery.
  watch(teamLeaderRpc.piStatus, (status) => {
    if (status !== "stopped" || !teamMode.value || isLoading.value) return;
    const projectDir = projectStore.currentProject?.path;
    if (projectDir) {
      void toggleTeamMode(projectDir);
    } else {
      // Team mode requires an open project, so this branch is defensive: at
      // least drop team mode so the UI does not render a dead team workspace.
      teamMode.value = false;
    }
  });

  /** Focus on a specific worker. Auto-creates event buffer if missing. */
  function focusWorker(agentId: string): void {
    focusedAgentId.value = agentId;
    // Ensure buffer exists (may not if worker was just created)
    if (!workerEvents.value[agentId]) {
      workerEvents.value[agentId] = [];
    }
  }

  /** Clear worker focus. */
  function clearFocus(): void {
    focusedAgentId.value = null;
  }

  // ==========================================================================
  // Event Handling
  // ==========================================================================

  const MAX_EVENTS_PER_WORKER = 200;

  function pickInitialFocus(team: TeamState): string | null {
    const entries = Object.entries(team.teammates);
    const preferred = entries.find(([, teammate]) => teammate.status === "running") ??
      entries.find(([, teammate]) => teammate.status === "idle" || teammate.status === "standby") ??
      entries[0];
    return preferred?.[0] ?? null;
  }

  function handleTeamEvent(event: TeamEvent): void {
    switch (event.type) {
      case "team_created":
        teamState.value = event.team;
        focusedAgentId.value = pickInitialFocus(event.team);
        // A live team should always be visible: created teams come from team
        // UI flows, and restored teams (app restart) should reopen the
        // workbench automatically.
        teamMode.value = true;
        // Hydrate persisted history so a restored team shows prior teammate
        // conversations and tasks instead of empty panels.
        void fetchTeamHistory();
        break;
      case "team_state_changed":
        teamState.value = event.team;
        break;
      case "team_deleted":
        if (teamState.value && teamState.value.name !== event.teamName) {
          break;
        }
        teamState.value = null;
        resetTeamCollections();
        teamMode.value = false;
        break;
      case "teammate_status_changed":
        if (teamState.value && teamState.value.teammates[event.agentId]) {
          teamState.value = {
            ...teamState.value,
            teammates: {
              ...teamState.value.teammates,
              [event.agentId]: {
                ...teamState.value.teammates[event.agentId],
                status: event.status,
                error: event.error,
                // Use main-process timestamp to avoid renderer clock skew
                statusChangedAt: event.timestamp ?? Date.now(),
              },
            },
          };
        }
        if (event.status === "running" && !focusedAgentId.value) {
          focusedAgentId.value = event.agentId;
        }
        break;
      case "teammate_event":
        handleTeammateEvent(event.agentId, event.event);
        break;
      case "teammate_message":
        handleTeammateMessage(event.agentId, event.message);
        break;
      case "team_message":
        handleTeamMessageEvent(event.message);
        break;
      case "task_created":
        handleTaskCreated(event.task);
        break;
      case "task_updated":
        handleTaskUpdated(event.task);
        break;
      case "task_deleted":
        handleTaskDeleted(event.taskId);
        break;
      case "protocol_permission_request":
        handlePermissionRequest(event.request);
        break;
      case "protocol_permission_response":
        handlePermissionResponse(event.requestId, event.approved, event.reason);
        break;
      case "protocol_plan_approval":
        handlePlanApprovalEvent(event.approval);
        break;
      case "protocol_plan_response":
        handlePlanResponse(event.approvalId, event.approved, event.feedback);
        break;
      case "worker_summary":
        handleWorkerSummary(event.fromAgentId, event.summary, event.taskId);
        break;
    }
  }

  const MAX_WORKER_SUMMARIES = 100;

  function handleWorkerSummary(fromAgentId: string, summary: string, taskId?: string): void {
    workerSummaries.value = [
      ...workerSummaries.value,
      { fromAgentId, summary, taskId, timestamp: Date.now() },
    ];
    if (workerSummaries.value.length > MAX_WORKER_SUMMARIES) {
      workerSummaries.value = workerSummaries.value.slice(-MAX_WORKER_SUMMARIES);
    }
  }

  function handleTeammateEvent(agentId: string, sessionEvent: AgentSessionEvent): void {
    // Skip events for agents that don't exist in current team state
    if (!teamState.value?.teammates[agentId]) return;
    const events = workerEvents.value[agentId] ?? [];
    events.push({
      agentId,
      event: sessionEvent,
      timestamp: Date.now(),
    });
    // Cap at max events per worker
    if (events.length > MAX_EVENTS_PER_WORKER) {
      events.splice(0, events.length - MAX_EVENTS_PER_WORKER);
    }
    workerEvents.value[agentId] = events;
  }

  const MAX_MESSAGES_PER_WORKER = 200;

  function handleTeammateMessage(agentId: string, message: TeammateChatMessage): void {
    // Skip messages for agents that don't exist in current team state
    if (!teamState.value?.teammates[agentId]) return;
    const messages = workerMessages.value[agentId] ?? [];
    // Deduplicate by id
    if (!messages.some((m) => m.id === message.id)) {
      messages.push(message);
      // Evict oldest messages to prevent unbounded growth
      if (messages.length > MAX_MESSAGES_PER_WORKER) {
        messages.splice(0, messages.length - MAX_MESSAGES_PER_WORKER);
      }
    }
    workerMessages.value[agentId] = messages;
  }

  const MAX_TEAM_MESSAGES = 500;

  function handleTeamMessageEvent(message: TeamMessage): void {
    if (!teamMessages.value.some((m) => m.id === message.id)) {
      teamMessages.value.push(message);
      if (teamMessages.value.length > MAX_TEAM_MESSAGES) {
        teamMessages.value.splice(0, teamMessages.value.length - MAX_TEAM_MESSAGES);
      }
    }
  }

  const MAX_TEAM_TASKS = 200;

  function handleTaskCreated(task: TeamTask): void {
    if (!teamTasks.value.some((t) => t.id === task.id)) {
      teamTasks.value.push(task);
      if (teamTasks.value.length > MAX_TEAM_TASKS) {
        teamTasks.value.splice(0, teamTasks.value.length - MAX_TEAM_TASKS);
      }
    }
  }

  function handleTaskUpdated(task: TeamTask): void {
    const idx = teamTasks.value.findIndex((t) => t.id === task.id);
    if (idx >= 0) {
      teamTasks.value[idx] = task;
    } else {
      // Task not yet in store (e.g. created before store was active) — add it
      teamTasks.value.push(task);
    }
  }

  function handleTaskDeleted(taskId: string): void {
    teamTasks.value = teamTasks.value.filter((t) => t.id !== taskId);
  }

  // ==========================================================================
  // Protocol Event Handlers (Phase 4)
  // ==========================================================================

  function handlePermissionRequest(request: PermissionRequest): void {
    // Deduplicate by id
    if (permissionRequests.value.some((r) => r.id === request.id)) return;
    permissionRequests.value = [...permissionRequests.value, request];
  }

  function handlePermissionResponse(requestId: string, approved: boolean, reason?: string): void {
    permissionRequests.value = permissionRequests.value.filter((r) => r.id !== requestId);
    // If rejected, the request is just removed. The worker gets the response via the promise.
    void approved;
    void reason;
  }

  function handlePlanApprovalEvent(approval: PlanApproval): void {
    if (planApprovals.value.some((a) => a.id === approval.id)) return;
    planApprovals.value = [...planApprovals.value, approval];
  }

  function handlePlanResponse(approvalId: string, approved: boolean, feedback?: string): void {
    planApprovals.value = planApprovals.value.filter((a) => a.id !== approvalId);
    void approved;
    void feedback;
  }

  // ==========================================================================
  // Task Actions
  // ==========================================================================

  /** Create a new task in the team's shared task list. */
  async function createTask(
    subject: string,
    description: string,
    assignTo?: string,
    blockedBy?: string[],
  ): Promise<TeamTask | null> {
    try {
      const result = await window.pixApi.sendTeamCommand<TeamTask>({
        type: "create_task",
        subject,
        description,
        assignTo,
        blockedBy,
      });
      if (result.success && result.data) {
        return result.data;
      }
      lastError.value = result.error ?? "创建任务失败";
      return null;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /** Delete a task. */
  async function deleteTask(taskId: string): Promise<boolean> {
    try {
      const result = await window.pixApi.sendTeamCommand({
        type: "delete_task",
        taskId,
      });
      if (!result.success) {
        lastError.value = result.error ?? "删除任务失败";
        return false;
      }
      return true;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  // ==========================================================================
  // Protocol Actions (Phase 4)
  // ==========================================================================

  /** Respond to a permission request (approve or reject). */
  async function respondPermission(requestId: string, approved: boolean, reason?: string): Promise<boolean> {
    try {
      const result = await window.pixApi.sendTeamCommand({
        type: "respond_permission",
        requestId,
        approved,
        reason,
      });
      if (!result.success) {
        lastError.value = result.error ?? "响应权限请求失败";
        return false;
      }
      return true;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /** Respond to a plan approval request (approve or reject). */
  async function respondPlanApproval(approvalId: string, approved: boolean, feedback?: string): Promise<boolean> {
    try {
      const result = await window.pixApi.sendTeamCommand({
        type: "respond_plan_approval",
        approvalId,
        approved,
        feedback,
      });
      if (!result.success) {
        lastError.value = result.error ?? "响应计划审批失败";
        return false;
      }
      return true;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /** Request graceful shutdown for a specific worker or all workers. */
  async function requestShutdown(agentId?: string): Promise<boolean> {
    try {
      const result = await window.pixApi.sendTeamCommand({
        type: "request_shutdown",
        agentId,
      });
      if (!result.success) {
        lastError.value = result.error ?? "请求停止成员失败";
        return false;
      }
      return true;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /** Restart a failed or shutdown worker. */
  async function restartWorker(agentId: string): Promise<boolean> {
    try {
      const result = await window.pixApi.sendTeamCommand({
        type: "restart_worker",
        agentId,
      });
      if (!result.success) {
        lastError.value = result.error ?? "重启团队成员失败";
        return false;
      }
      return true;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  // ==========================================================================
  // Expose
  // ==========================================================================

  return {
    // State
    teamState,
    isLoading,
    lastError,
    workerMessages,
    workerEvents,
    teamMessages,
    teamTasks,
    permissionRequests,
    planApprovals,
    workerSummaries,
    teamMode,
    focusedAgentId,
    // Computed
    isTeamActive,
    teamName,
    teammates,
    readyTasks,
    activeTasks,
    waitingTasks,
    problemTasks,
    doneTasks,
    pendingProtocolCount,
    currentActivity,
    // Actions
    subscribeToEvents,
    createTeam,
    fetchTeamState,
    fetchTeamHistory,
    stopTeam,
    sendMessageToWorker,
    abortWorker,
    activateMember,
    pauseMember,
    createTask,
    deleteTask,
    respondPermission,
    respondPlanApproval,
    requestShutdown,
    restartWorker,
    clearError,
    toggleTeamMode,
    focusWorker,
    clearFocus,
  };
});
