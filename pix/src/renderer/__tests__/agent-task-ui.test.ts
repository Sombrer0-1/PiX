/**
 * Agent task UI tests (PiX 1.4.1 stage B7; 1.4.2 R5; 1.5 P1; 1.5 P2 stage S2;
 * 1.5 P3 stage S5; 1.5 P4 stage S7).
 *
 * P2 (S2) acceptance: the task center replaces the right-panel panel -
 * AgentTaskLauncher owns the subscribeToEvents lifecycle (mount subscribes /
 * unmount unsubscribes) and the single notification-center mount; the status
 * line opens the center; inputs render as InputCards. TaskCenterView renders
 * the locked running order (waiting_input -> running(startedAt) -> queued(
 * queuePosition) -> interrupted) and the history view (terminal + 残留 +
 * orphan issues, no duplicates); the stop button is the only row operation and
 * workflowOwned rows carry the workflow badge without a stop button;
 * TaskDetailPanel renders the summary tab with the task's InputCard;
 * AgentTaskDetail carries the spec row and the recovery issue row without
 * inline expand semantics; CenterPanel renders TaskCenterView above the
 * team/solo branches and returns to the previous view on close.
 *
 * P3 (S5) acceptance: TaskDetailPanel owns the watcher (mount watches, task
 * switch unwatches the old id, unmount unwatches); the transcript tab replays
 * disk entries then consumes live events without seams (dedup rules), :key
 * remount leaves no residue, terminal unwatch + full replay, liveDropped
 * replay and chain item tabs.
 *
 * P4 (S7) acceptance: the file-changes tab merges get_task_log history with
 * the live task_file_change buffer deduped by toolCallId (history wins, no
 * path uses the toolName:toolCallId key, direct-open receives live through the
 * parent watch); SubagentToolView folds terminal agents into one line with a
 * 查看详情 button that deep-links through openTaskCenter to the
 * earliest-created matching parentToolCallId task (button hidden when no task
 * matches). The raw-events tab was removed by product decision (get_task_log
 * stays for the file-changes history).
 *
 * Session scoping (product follow-up): the task center defaults to the
 * current session's tasks (null current session falls back to showing all);
 * the 全部 toggle is the global escape hatch; orphan recovery issues only
 * render outside the session filter; a deep link to an out-of-session task
 * auto-switches the scope to 全部; the launcher status line counts only the
 * current session and surfaces other-session active tasks via the hint row.
 *
 * The component tree talks to main only through window.pixApi
 * (sendAgentTaskCommand / onAgentTaskEvent / onAgentTaskInputRequest) and the
 * mocked stores/composables, so no Electron runtime is loaded; the agent-task
 * store itself is real (Pinia), so the components render real store-driven
 * state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { DOMWrapper } from "@vue/test-utils";
import { defineComponent, h, nextTick } from "vue";
import type { DisplayBlock } from "@/types/session";
import { createPinia, setActivePinia } from "pinia";
// Use the pre-bundled dist entry: the ESM lib entry imports per-component CSS
// files, which a Node-side externalized import cannot load in happy-dom.
import { components as vuetifyComponents, createVuetify, directives as vuetifyDirectives } from "vuetify/dist/vuetify.js";
import type { PixApi } from "../../main/preload";
import { AGENT_TASK_MAX_ACTIVITIES } from "@shared/agent-task-types.js";
import type {
  AgentTaskActivity,
  AgentTaskGroupHandle,
  AgentTaskInfo,
  AgentTaskInputRequest,
  AgentTaskLogEvent,
  AgentTaskRecoveryIssue,
  AgentTaskStorageStatus,
} from "@shared/agent-task-types.js";
import type { FileChangeSummary, SessionInfo } from "@shared/types.js";
import type { AgentMessage, AgentTaskEvent } from "@shared/types.js";
import type { SubagentDetails } from "@shared/subagent-types.js";
import { useAgentTaskStore } from "../stores/agent-task-store";
import AgentTaskLauncher from "../components/agent-task/AgentTaskLauncher.vue";
import AgentTaskDetail from "../components/agent-task/AgentTaskDetail.vue";
import AgentTaskInputCard from "../components/agent-task/AgentTaskInputCard.vue";
import AgentTaskNotificationCenter from "../components/agent-task/AgentTaskNotificationCenter.vue";
import TaskCenterView from "../components/agent-task/TaskCenterView.vue";
import TaskDetailPanel from "../components/agent-task/TaskDetailPanel.vue";
import SubagentToolView from "../components/session/SubagentToolView.vue";
import SessionView from "../components/session/SessionView.vue";
import RightPanel from "../components/layout/RightPanel.vue";
import CenterPanel from "../components/layout/CenterPanel.vue";

// ============================================================================
// Mocks (module-level, hoisted) for RightPanel / CenterPanel dependencies
// ============================================================================

const rpcMock = vi.hoisted(() => ({
  state: {
    sessionState: { value: null as null | { sessionId?: string; model?: { provider: string; id: string }; thinkingLevel?: string; sessionName?: string; messageCount?: number; goal?: unknown; isCompacting?: boolean } },
    isConnected: { value: true },
    isStreaming: { value: false },
    executionEnvironment: { value: null as null | { kind: "windows" | "wsl"; distro?: string; logicalCwd?: string } },
    lastError: { value: null as string | null },
    commands: { value: [] as Array<{ name: string }> },
    availableModels: { value: [] as Array<{ provider: string; id: string; thinkingLevelMap?: Record<string, string> }> },
    sendCommandAsync: vi.fn().mockResolvedValue(undefined),
    setPiSetting: vi.fn().mockResolvedValue(undefined),
    refreshState: vi.fn().mockResolvedValue(undefined),
    exportHtml: vi.fn().mockResolvedValue(null),
    exportJsonl: vi.fn().mockResolvedValue(null),
    forkSession: vi.fn().mockResolvedValue({ cancelled: false }),
    getMessages: vi.fn().mockResolvedValue([]),
    abort: vi.fn().mockResolvedValue(undefined),
    getBackgroundTasks: vi.fn().mockResolvedValue([]),
    stopBackgroundTask: vi.fn().mockResolvedValue(undefined),
    mcpGetServers: vi.fn().mockResolvedValue([]),
    compact: vi.fn().mockResolvedValue(undefined),
  },
}));

const sessionMock = vi.hoisted(() => ({
  state: {
    displayBlocks: { value: [] as Array<{ type: string }> },
    isStreaming: { value: false },
    lastRetryableError: { value: null as { blockId: string } | null },
    appendOptimisticUserMessage: vi.fn().mockReturnValue("optimistic-1"),
    failOptimisticUserMessage: vi.fn(),
    clearSession: vi.fn(),
    loadMessages: vi.fn(),
    getRawEventsJson: vi.fn().mockReturnValue("[]"),
  },
}));

const projectStoreMock = vi.hoisted(() => ({
  state: {
    currentProject: { value: null },
    currentSession: { value: null as SessionInfo | null },
    currentTeamSession: { value: null as SessionInfo | null },
    sessions: { value: [] as Array<{ id: string; name?: string }> },
    listSessions: vi.fn().mockResolvedValue(undefined),
    syncCurrentSession: vi.fn(),
    listTeamLeaderSessions: vi.fn().mockResolvedValue(undefined),
    syncCurrentTeamSession: vi.fn(),
  },
}));

const teamStoreMock = vi.hoisted(() => ({
  state: {
    teamMode: { value: false },
    isTeamActive: { value: false },
    isLoading: { value: false },
    pendingProtocolCount: { value: 0 },
    teamName: { value: null as string | null },
    lastError: { value: null as string | null },
    toggleTeamMode: vi.fn().mockResolvedValue(true),
  },
}));

const settingsStoreMock = vi.hoisted(() => ({
  state: {
    settings: { value: {} },
  },
}));

const planStoreMock = vi.hoisted(() => ({
  state: {
    planPhase: null as null | string,
    currentPlan: null as unknown,
  },
}));

const workflowStoreMock = vi.hoisted(() => ({
  state: {
    subscribeToEvents: vi.fn(() => () => {}),
  },
}));

vi.mock("../composables/useWorkspaceRpc", () => ({
  useWorkspaceRpc: () => ({
    sessionState: rpcMock.state.sessionState,
    isConnected: rpcMock.state.isConnected,
    isStreaming: rpcMock.state.isStreaming,
    executionEnvironment: rpcMock.state.executionEnvironment,
    lastError: rpcMock.state.lastError,
    commands: rpcMock.state.commands,
    availableModels: rpcMock.state.availableModels,
    sendCommandAsync: rpcMock.state.sendCommandAsync,
    setPiSetting: rpcMock.state.setPiSetting,
    refreshState: rpcMock.state.refreshState,
    exportHtml: rpcMock.state.exportHtml,
    exportJsonl: rpcMock.state.exportJsonl,
    forkSession: rpcMock.state.forkSession,
    getMessages: rpcMock.state.getMessages,
    abort: rpcMock.state.abort,
    getBackgroundTasks: rpcMock.state.getBackgroundTasks,
    stopBackgroundTask: rpcMock.state.stopBackgroundTask,
    mcpGetServers: rpcMock.state.mcpGetServers,
    compact: rpcMock.state.compact,
  }),
}));

vi.mock("../composables/useWorkspaceSessionStore", () => ({
  useWorkspaceSessionStore: () => ({
    displayBlocks: sessionMock.state.displayBlocks,
    isStreaming: sessionMock.state.isStreaming,
    lastRetryableError: sessionMock.state.lastRetryableError,
    appendOptimisticUserMessage: sessionMock.state.appendOptimisticUserMessage,
    failOptimisticUserMessage: sessionMock.state.failOptimisticUserMessage,
    clearSession: sessionMock.state.clearSession,
    loadMessages: sessionMock.state.loadMessages,
    getRawEventsJson: sessionMock.state.getRawEventsJson,
  }),
}));

vi.mock("../stores/project-store", () => ({
  useProjectStore: () => ({
    currentProject: projectStoreMock.state.currentProject.value,
    currentSession: projectStoreMock.state.currentSession.value,
    currentTeamSession: projectStoreMock.state.currentTeamSession.value,
    sessions: projectStoreMock.state.sessions.value,
    listSessions: projectStoreMock.state.listSessions,
    syncCurrentSession: projectStoreMock.state.syncCurrentSession,
    listTeamLeaderSessions: projectStoreMock.state.listTeamLeaderSessions,
    syncCurrentTeamSession: projectStoreMock.state.syncCurrentTeamSession,
  }),
}));

vi.mock("../stores/team-store", () => ({
  useTeamStore: () => ({
    teamMode: teamStoreMock.state.teamMode.value,
    isTeamActive: teamStoreMock.state.isTeamActive.value,
    isLoading: teamStoreMock.state.isLoading.value,
    pendingProtocolCount: teamStoreMock.state.pendingProtocolCount.value,
    teamName: teamStoreMock.state.teamName.value,
    lastError: teamStoreMock.state.lastError.value,
    toggleTeamMode: teamStoreMock.state.toggleTeamMode,
  }),
}));

vi.mock("../stores/settings-store", () => ({
  useSettingsStore: () => ({
    settings: settingsStoreMock.state.settings.value,
  }),
}));

vi.mock("../stores/plan-store", () => ({
  usePlanStore: () => ({
    planPhase: planStoreMock.state.planPhase,
    currentPlan: planStoreMock.state.currentPlan,
    subscribeToEvents: vi.fn(() => () => {}),
    enterPlanning: vi.fn().mockResolvedValue({ success: true }),
  }),
}));

vi.mock("../stores/workflow-store", () => ({
  useWorkflowStore: () => ({
    subscribeToEvents: workflowStoreMock.state.subscribeToEvents,
  }),
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// ============================================================================
// Fixtures
// ============================================================================

let taskCounter = 0;

function makeUsage(overrides?: Partial<AgentTaskInfo["usage"]>): AgentTaskInfo["usage"] {
  const input = overrides?.input ?? 100;
  const output = overrides?.output ?? 50;
  const cacheRead = overrides?.cacheRead ?? 20;
  const cacheWrite = overrides?.cacheWrite ?? 10;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: overrides?.cost ?? 0,
    turns: overrides?.turns ?? 1,
  };
}

function makeTask(overrides?: Partial<AgentTaskInfo>): AgentTaskInfo {
  taskCounter += 1;
  const id = overrides?.taskId ?? `task-${taskCounter}`;
  const now = Date.now();
  return {
    schemaVersion: 1,
    taskId: id,
    groupId: overrides?.groupId ?? `group-${taskCounter}`,
    groupMode: "single",
    workspaceId: "ws-1",
    parentSessionId: "session-1",
    parentToolCallId: "tool-call-1",
    itemSummaries: [
      { index: 0, agentName: "general-purpose", agentSource: "built-in", model: { provider: "anthropic", modelId: "claude-x" } },
    ],
    thinkingLevel: "medium",
    executionMode: "unattended",
    project: { path: "/project", physicalPath: "/project", name: "project", environment: { kind: "windows" } },
    presentation: "foreground",
    status: "queued",
    description: "Task description",
    finalOutput: "",
    outputTruncated: false,
    originalOutputBytes: 0,
    results: [],
    activities: [],
    usage: makeUsage(),
    toolUseCount: 0,
    createdAt: now,
    updatedAt: now,
    durationMs: 0,
    deliveredSessionIds: [],
    planLinkState: "none",
    generation: 0,
    ...overrides,
  };
}

/** 会话作用域测试用的最小 SessionInfo(组件只读 .id)。 */
function makeSessionInfo(id: string, name: string): SessionInfo {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd: "/project",
    name,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    firstMessage: "",
  };
}

function makeInputRequest(overrides?: Partial<AgentTaskInputRequest>): AgentTaskInputRequest {  return {
    taskId: "task-1",
    requestId: "req-1",
    generation: 0,
    request: {
      id: "req-1",
      questions: [{ id: "q1", header: "Question A", question: "Which option?" }],
    },
    ...overrides,
  };
}

function makeActivity(overrides?: Partial<AgentTaskActivity>): AgentTaskActivity {
  return {
    sequence: 1,
    toolCallId: "tc-1",
    toolName: "bash",
    status: "completed",
    summary: "ran command",
    startedAt: 1,
    endedAt: 2,
    ...overrides,
  };
}

function makeStorageStatus(overrides?: Partial<AgentTaskStorageStatus>): AgentTaskStorageStatus {
  return {
    workspaceId: "ws-1",
    usedBytes: 0,
    reservedBytes: 0,
    limitBytes: 1000,
    level: "warning",
    ...overrides,
  };
}

function makeRecoveryIssue(overrides?: Partial<AgentTaskRecoveryIssue>): AgentTaskRecoveryIssue {
  return {
    taskId: "corrupt-1",
    workspaceId: "ws-1",
    generation: 0,
    code: "mid_log_corrupt",
    message: "日志中段损坏，无法完整恢复",
    recoverable: false,
    readOnly: true,
    ...overrides,
  };
}

const GROUP_HANDLE: AgentTaskGroupHandle = {
  kind: "agent_task_group",
  groupId: "group-9",
  mode: "parallel",
  tasks: [
    { kind: "agent_task", taskId: "task-bg-1", generation: 0, status: "running", description: "scan the repo", presentation: "background" },
    { kind: "agent_task", taskId: "task-bg-2", generation: 0, status: "completed", description: "write the docs", presentation: "background" },
  ],
};

/**
 * SessionView stub: renders the display-block array as test-friendly divs so
 * transcript tests can assert the exact folded blocks (dedup / live increment /
 * replay) without mounting the real render chain in happy-dom.
 */
function blockLabel(block: DisplayBlock): string {
  switch (block.type) {
    case "user-message":
      return `user-message:${block.text}`;
    case "agent-message":
      return `agent-message:${block.content}`;
    case "note":
      return `note:${block.text}`;
    case "work-status":
      return `work-status:${block.tools.length}`;
    default:
      return block.type;
  }
}

const TranscriptSessionStub = defineComponent({
  name: "SessionView",
  props: { blocks: { type: Array, default: () => [] } },
  setup(props) {
    return () =>
      h(
        "div",
        { "data-test": "transcript-session-stub" },
        (props.blocks as DisplayBlock[]).map((block, index) =>
          h("div", { key: index, "data-test": `transcript-block-${block.type}` }, blockLabel(block)),
        ),
      );
  },
});

const FOREGROUND_DETAILS: SubagentDetails = {
  schemaVersion: 1,
  mode: "single",
  agentScope: "user",
  results: [
    {
      id: "r-1",
      index: 0,
      agentName: "general-purpose",
      agentSource: "built-in",
      description: "Do the thing",
      status: "completed",
      finalOutput: "done",
      outputTruncated: false,
      originalOutputBytes: 4,
      toolUseCount: 2,
      activities: [makeActivity()],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 0.01, turns: 1 },
      startedAt: 1,
      endedAt: 2,
      durationMs: 1000,
    },
  ],
  startedAt: 1,
  updatedAt: 2,
  durationMs: 1000,
};

// ============================================================================
// Harness: stub window.pixApi
// ============================================================================

const vuetify = createVuetify({
  components: { ...vuetifyComponents },
  directives: { ...vuetifyDirectives },
});

let sendAgentTaskCommand: ReturnType<typeof vi.fn>;
let onAgentTaskEvent: ReturnType<typeof vi.fn>;
let onAgentTaskInputRequest: ReturnType<typeof vi.fn>;
let agentTaskEventCallback: ((event: AgentTaskEvent) => void) | null;
let inputRequestCallback: ((request: AgentTaskInputRequest) => void) | null;
const eventUnsubscribers: Array<() => void> = [];
const inputUnsubscribers: Array<() => void> = [];
let wrapper: ReturnType<typeof mount> | undefined;

function installPixApiMock(): void {
  taskCounter = 0;
  agentTaskEventCallback = null;
  inputRequestCallback = null;
  eventUnsubscribers.length = 0;
  inputUnsubscribers.length = 0;
  sendAgentTaskCommand = vi.fn().mockResolvedValue({ success: true });
  onAgentTaskEvent = vi.fn((callback: (event: AgentTaskEvent) => void) => {
    agentTaskEventCallback = callback;
    const unsubscribe = vi.fn();
    eventUnsubscribers.push(unsubscribe);
    return unsubscribe;
  });
  onAgentTaskInputRequest = vi.fn((callback: (request: AgentTaskInputRequest) => void) => {
    inputRequestCallback = callback;
    const unsubscribe = vi.fn();
    inputUnsubscribers.push(unsubscribe);
    return unsubscribe;
  });
  window.pixApi = { sendAgentTaskCommand, onAgentTaskEvent, onAgentTaskInputRequest } as unknown as PixApi;
}

/** Deliver an AgentTaskEvent through the currently registered onAgentTaskEvent callback. */
function emit(event: AgentTaskEvent): void {
  agentTaskEventCallback?.(event);
}

/** Deliver an input request through the dedicated onAgentTaskInputRequest channel. */
function emitInput(request: AgentTaskInputRequest): void {
  inputRequestCallback?.(request);
}

/** Task commands of one type actually sent to main. */
function taskCalls(type: string): Array<Record<string, unknown>> {
  return (sendAgentTaskCommand.mock.calls as Array<[Record<string, unknown>]>)
    .filter(([command]) => command.type === type)
    .map(([command]) => command);
}

function installPinia(): ReturnType<typeof createPinia> {
  const pinia = createPinia();
  setActivePinia(pinia);
  return pinia;
}

beforeEach(() => {
  rpcMock.state.sessionState.value = null;
  rpcMock.state.isConnected.value = true;
  rpcMock.state.isStreaming.value = false;
  rpcMock.state.executionEnvironment.value = null;
  rpcMock.state.lastError.value = null;
  rpcMock.state.commands.value = [];
  rpcMock.state.availableModels.value = [];
  rpcMock.state.getBackgroundTasks.mockResolvedValue([]);
  rpcMock.state.mcpGetServers.mockResolvedValue([]);
  sessionMock.state.displayBlocks.value = [];
  sessionMock.state.lastRetryableError.value = null;
  projectStoreMock.state.sessions.value = [];
  projectStoreMock.state.currentProject.value = null;
  // 会话作用域测试可写 currentSession/currentTeamSession,每例复位避免泄漏。
  projectStoreMock.state.currentSession.value = null;
  projectStoreMock.state.currentTeamSession.value = null;
  teamStoreMock.state.teamMode.value = false;
  planStoreMock.state.planPhase = null;
  planStoreMock.state.currentPlan = null;
  installPixApiMock();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.useRealTimers();
});

// ============================================================================
// AgentTaskLauncher (P2: right-rail entry, sole subscribeToEvents mount point)
// ============================================================================

describe("AgentTaskLauncher", () => {
  function mountLauncher(): { w: ReturnType<typeof mount>; store: ReturnType<typeof useAgentTaskStore> } {
    const pinia = installPinia();
    const store = useAgentTaskStore();
    wrapper = mount(AgentTaskLauncher, {
      props: { sessionNames: { "session-1": "会话一" } },
      global: { plugins: [pinia, vuetify] },
    });
    return { w: wrapper, store };
  }

  it("subscribes on mount and unsubscribes on unmount (subscribeToEvents migration)", async () => {
    const { w, store } = mountLauncher();
    await flushPromises();

    // AgentTaskPanel 删除后 Launcher 是唯一订阅点:挂载即订阅 + 重挂载补偿查询。
    expect(onAgentTaskEvent).toHaveBeenCalledTimes(1);
    expect(onAgentTaskInputRequest).toHaveBeenCalledTimes(1);
    expect(sendAgentTaskCommand.mock.calls.map((call) => (call[0] as Record<string, unknown>).type)).toEqual([
      "get_all",
      "get_active_input_requests",
    ]);

    // 事件驱动镜像更新(input request 同样生效)。
    emit({ type: "task_state", task: makeTask({ taskId: "run-1", status: "running", startedAt: 1 }) });
    emitInput(makeInputRequest({ taskId: "run-1", requestId: "req-1" }));
    await nextTick();
    expect(store.tasks.map((t) => t.taskId)).toEqual(["run-1"]);
    expect(store.activeInputRequests).toHaveLength(1);

    w.unmount();
    expect(eventUnsubscribers[0]).toHaveBeenCalled();
    expect(inputUnsubscribers[0]).toHaveBeenCalled();
  });

  it("shows 「N 运行中 · M 等待输入」 and opens the task center on click", async () => {
    const { w, store } = mountLauncher();
    await flushPromises();

    emit({ type: "task_state", task: makeTask({ taskId: "run-1", status: "running", startedAt: 1 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "run-2", status: "running", startedAt: 2 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "w-1", status: "waiting_input", startedAt: 3 }) });
    await nextTick();

    expect(w.find('[data-test="agent-task-status-text"]').text()).toBe("2 运行中 · 1 等待输入");
    await w.get('[data-test="agent-task-status-line"]').trigger("click");
    expect(store.centerOpen).toBe(true);
  });

  it("session scoping: counts only the current session; other-session hint row deep-links", async () => {
    projectStoreMock.state.currentSession.value = makeSessionInfo("session-1", "会话一");
    const { w, store } = mountLauncher();
    await flushPromises();

    emit({ type: "task_state", task: makeTask({ taskId: "mine-run", status: "running", startedAt: 1 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "other-run", status: "running", startedAt: 2, parentSessionId: "session-2" }) });
    emit({ type: "task_state", task: makeTask({ taskId: "other-wait", status: "waiting_input", startedAt: 3, parentSessionId: "session-2" }) });
    emit({ type: "task_state", task: makeTask({ taskId: "other-done", status: "completed", endedAt: 4, parentSessionId: "session-2" }) });
    await nextTick();

    // 计数只含当前会话;提示行显示其他会话活跃任务数(终态不计入)。
    expect(w.find('[data-test="agent-task-status-text"]').text()).toBe("1 运行中 · 0 等待输入");
    const hint = w.get('[data-test="agent-task-launcher-other-sessions"]');
    expect(hint.text()).toBe("+2 个其他会话任务");

    // 提示行深链:优先 waiting_input 任务,openTaskCenter 携带其 id(中心切「全部」并定位)。
    await hint.trigger("click");
    expect(store.centerOpen).toBe(true);
    expect(store.selectedTaskId).toBe("other-wait");
  });

  it("session scoping: null current session falls back to global counts (no hint row)", async () => {
    const { w } = mountLauncher();
    await flushPromises();

    emit({ type: "task_state", task: makeTask({ taskId: "run-1", status: "running", startedAt: 1, parentSessionId: "session-2" }) });
    await nextTick();

    expect(w.find('[data-test="agent-task-status-text"]').text()).toBe("1 运行中 · 0 等待输入");
    expect(w.find('[data-test="agent-task-launcher-other-sessions"]').exists()).toBe(false);
  });

  it("renders active input requests as InputCard directly", async () => {
    const { w } = mountLauncher();
    await flushPromises();

    emitInput(makeInputRequest({ taskId: "task-1", requestId: "req-1" }));
    await nextTick();

    expect(w.find('[data-test="agent-task-launcher-inputs"]').exists()).toBe(true);
    expect(w.findAll('[data-test="agent-task-input-card"]')).toHaveLength(1);
    expect(w.find('[data-test="agent-task-input-key"]').text()).toContain("task-1");
  });

  it("mounts the notification center (the single app-wide mount point)", async () => {
    const { w } = mountLauncher();
    await flushPromises();
    expect(w.find('[data-test="agent-task-notification-center"]').exists()).toBe(true);
  });

  it("shows storage warning and full banners as passive notices (no clear entry)", async () => {
    const { w } = mountLauncher();
    await flushPromises();

    emit({ type: "storage_status", status: makeStorageStatus({ usedBytes: 800, reservedBytes: 0, limitBytes: 1000, level: "warning" }) });
    await nextTick();
    expect(w.get('[data-test="agent-task-storage-warning"]').text()).toContain("80%");
    expect(w.get('[data-test="agent-task-storage-warning"]').text()).toContain("自动回收");

    emit({ type: "storage_status", status: makeStorageStatus({ usedBytes: 1000, reservedBytes: 0, limitBytes: 1000, level: "full" }) });
    await nextTick();
    expect(w.get('[data-test="agent-task-storage-full"]').text()).toContain("紧急自动回收已触发");
    expect(taskCalls("clear_all_terminal")).toHaveLength(0);
  });
});

// ============================================================================
// TaskCenterView (P2: master-detail center view)
// ============================================================================

describe("TaskCenterView", () => {
  function mountCenter(): { w: ReturnType<typeof mount>; store: ReturnType<typeof useAgentTaskStore> } {
    const pinia = installPinia();
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    wrapper = mount(TaskCenterView, {
      props: { sessionNames: { "session-1": "会话一" } },
      global: { plugins: [pinia, vuetify] },
    });
    return { w: wrapper, store };
  }

  function rowIds(w: ReturnType<typeof mount>): string[] {
    return w.findAll('[data-test^="task-center-row-"]').map((row) =>
      (row.attributes("data-test") as string).replace("task-center-row-", ""),
    );
  }

  it("运行列表仅 queued/running/waiting_input + 瞬态 interrupted，排序锁死", async () => {
    const { w } = mountCenter();
    await flushPromises();

    emit({ type: "task_state", task: makeTask({ taskId: "run-b", status: "running", startedAt: 10 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "run-a", status: "running", startedAt: 5 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "q-2", status: "queued", queuePosition: 2 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "q-1", status: "queued", queuePosition: 1 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "w-2", status: "waiting_input", startedAt: 9 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "w-1", status: "waiting_input", startedAt: 3 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "int-1", status: "interrupted", updatedAt: 99 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "done-1", status: "completed", endedAt: 5 }) });
    await nextTick();

    // waiting_input 置顶 → running(startedAt 升序) → queued(queuePosition 升序) → interrupted 殿后
    expect(rowIds(w)).toEqual(["w-1", "w-2", "run-a", "run-b", "q-1", "q-2", "int-1"]);
    // 终态不进入运行列表
    expect(w.find('[data-test="task-center-row-done-1"]').exists()).toBe(false);

    // 行内样本文本:状态文字非纯颜色
    const runRow = w.get('[data-test="task-center-row-run-a"]');
    expect(runRow.find('[data-test="task-center-status-text"]').text()).toBe("运行中");
    expect(runRow.find('[data-test="task-center-source"]').text()).toContain("来源 会话一");
    expect(runRow.find('[data-test="task-center-model"]').text()).toContain("anthropic/claude-x");
    const queueRow = w.get('[data-test="task-center-row-q-1"]');
    expect(queueRow.find('[data-test="task-center-status-text"]').text()).toBe("排队中");
    expect(queueRow.find('[data-test="task-center-queue"]').text()).toBe("队列 #1");
  });

  it("历史 = 终态(endedAt 降序) + 中断残留(行标注残留) + 无镜像 issue 不重复", async () => {
    const { w } = mountCenter();
    await flushPromises();

    emit({ type: "task_state", task: makeTask({ taskId: "done-2", status: "completed", endedAt: 2 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "done-1", status: "completed", endedAt: 5 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "fail-1", status: "failed", endedAt: 9, failureReason: "resume_blocked" }) });
    emit({ type: "task_state", task: makeTask({ taskId: "int-1", status: "interrupted", updatedAt: 3 }) });
    // 无镜像 issue:taskId 在 tasks 镜像中不存在 → 出现
    emit({ type: "recovery_issue", issue: makeRecoveryIssue({ taskId: "corrupt-orphan", code: "unknown_schema", message: "未知 schema 版本", readOnly: true }) });
    // 有镜像 issue:与 fail-1 同 taskId → 不重复列出
    emit({ type: "recovery_issue", issue: makeRecoveryIssue({ taskId: "fail-1", code: "unknown_schema", message: "未知 schema 版本", readOnly: true }) });
    await nextTick();

    await w.get('[data-test="task-center-tab-history"]').trigger("click");
    await nextTick();

    expect(rowIds(w)).toEqual(["fail-1", "done-1", "done-2", "int-1"]);
    const residualRow = w.get('[data-test="task-center-row-int-1"]');
    expect(residualRow.find('[data-test="task-center-residual-badge"]').text()).toBe("残留");

    expect(w.find('[data-test="task-center-issue-corrupt-orphan"]').exists()).toBe(true);
    expect(w.find('[data-test="task-center-issue-fail-1"]').exists()).toBe(false);

    // issue 行只读 + 导出诊断,无清理按钮(行内唯一按钮是导出)
    const issueRow = w.get('[data-test="task-center-issue-corrupt-orphan"]');
    expect(issueRow.find('[data-test="task-center-issue-code"]').text()).toBe("未知 schema 版本");
    expect(issueRow.find('[data-test="task-center-issue-readonly"]').text()).toBe("只读");
    expect(issueRow.findAll("button")).toHaveLength(1);
    expect(issueRow.find('[data-test="task-center-issue-export-btn"]').exists()).toBe(true);
    expect(taskCalls("clear")).toHaveLength(0);
  });

  it("深链:openTaskCenter(终态任务)自动切历史视图并高亮;waiting_input 切运行视图", async () => {
    const { w, store } = mountCenter();
    await flushPromises();

    emit({ type: "task_state", task: makeTask({ taskId: "done-1", status: "completed", endedAt: 5 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "wait-1", status: "waiting_input", startedAt: 1 }) });
    await nextTick();

    store.openTaskCenter("done-1");
    await nextTick();
    expect(w.get('[data-test="task-center-tab-history"]').classes()).toContain("active");
    expect(w.get('[data-test="task-center-row-done-1"]').classes()).toContain("selected");

    store.openTaskCenter("wait-1");
    await nextTick();
    expect(w.get('[data-test="task-center-tab-running"]').classes()).toContain("active");
    expect(w.get('[data-test="task-center-row-wait-1"]').classes()).toContain("selected");
  });

  it("会话作用域:默认只显示当前会话任务,「全部」切换后显示其他会话;孤儿 issue 仅在全部作用域", async () => {
    projectStoreMock.state.currentSession.value = makeSessionInfo("session-1", "会话一");
    const { w } = mountCenter();
    await flushPromises();

    emit({ type: "task_state", task: makeTask({ taskId: "mine-run", status: "running", startedAt: 1 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "other-run", status: "running", startedAt: 2, parentSessionId: "session-2" }) });
    emit({ type: "task_state", task: makeTask({ taskId: "mine-done", status: "completed", endedAt: 5 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "other-done", status: "completed", endedAt: 6, parentSessionId: "session-2" }) });
    emit({ type: "recovery_issue", issue: makeRecoveryIssue({ taskId: "corrupt-orphan", code: "unknown_schema", message: "未知 schema 版本", readOnly: true }) });
    await nextTick();

    // 默认「当前会话」:运行/历史只含 session-1;孤儿 issue 无 parentSessionId 可归属,不显示。
    expect(w.get('[data-test="task-center-scope-session"]').classes()).toContain("active");
    expect(rowIds(w)).toEqual(["mine-run"]);
    expect(w.find('[data-test="task-center-row-other-run"]').exists()).toBe(false);
    expect(w.get('[data-test="task-center-tab-running"]').text()).toContain("1");

    await w.get('[data-test="task-center-tab-history"]').trigger("click");
    await nextTick();
    expect(rowIds(w)).toEqual(["mine-done"]);
    expect(w.find('[data-test="task-center-row-other-done"]').exists()).toBe(false);
    expect(w.find('[data-test="task-center-issue-corrupt-orphan"]').exists()).toBe(false);

    // 「全部」作用域:其他会话任务进入运行/历史;孤儿 issue 恢复显示。
    await w.get('[data-test="task-center-scope-all"]').trigger("click");
    await nextTick();
    expect(w.get('[data-test="task-center-scope-all"]').classes()).toContain("active");
    expect(rowIds(w)).toEqual(["other-done", "mine-done"]);
    expect(w.find('[data-test="task-center-issue-corrupt-orphan"]').exists()).toBe(true);

    await w.get('[data-test="task-center-tab-running"]').trigger("click");
    await nextTick();
    expect(rowIds(w)).toEqual(["mine-run", "other-run"]);
  });

  it("深链其他会话任务:作用域自动切「全部」并定位(单向,不回切)", async () => {
    projectStoreMock.state.currentSession.value = makeSessionInfo("session-1", "会话一");
    const { w, store } = mountCenter();
    await flushPromises();

    emit({ type: "task_state", task: makeTask({ taskId: "other-run", status: "running", startedAt: 2, parentSessionId: "session-2" }) });
    emit({ type: "task_state", task: makeTask({ taskId: "mine-run", status: "running", startedAt: 1 }) });
    await nextTick();

    // 深链其他会话任务 → 作用域自动切「全部」,行可见且选中。
    store.openTaskCenter("other-run");
    await nextTick();
    expect(w.get('[data-test="task-center-scope-all"]').classes()).toContain("active");
    expect(w.get('[data-test="task-center-row-other-run"]').classes()).toContain("selected");

    // 单向:随后选中当前会话任务不把作用域切回「当前会话」。
    store.selectTask("mine-run");
    await nextTick();
    expect(w.get('[data-test="task-center-scope-all"]').classes()).toContain("active");
    expect(w.get('[data-test="task-center-row-mine-run"]').classes()).toContain("selected");
  });

  it("停止按钮是唯一操作且 workflowOwned 行无停止按钮 + workflow 徽标", async () => {
    const { w } = mountCenter();
    await flushPromises();

    emit({ type: "task_state", task: makeTask({ taskId: "run-1", status: "running", startedAt: 1 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "wf-1", status: "running", startedAt: 2, workflowOwned: true }) });
    await nextTick();

    const runRow = w.get('[data-test="task-center-row-run-1"]');
    expect(runRow.find('[data-test="task-center-cancel-btn"]').exists()).toBe(true);
    // 行内唯一操作:行主体按钮 + 取消按钮
    expect(runRow.findAll("button")).toHaveLength(2);

    const wfRow = w.get('[data-test="task-center-row-wf-1"]');
    expect(wfRow.find('[data-test="task-center-workflow-badge"]').text()).toBe("workflow");
    expect(wfRow.find('[data-test="task-center-cancel-btn"]').exists()).toBe(false);
    expect(wfRow.findAll("button")).toHaveLength(1);

    await runRow.find('[data-test="task-center-cancel-btn"]').trigger("click");
    await flushPromises();
    const calls = taskCalls("cancel");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ taskId: "run-1" });
  });

  it("lastError 在任务中心顶部横幅展示", async () => {
    const { w } = mountCenter();
    await flushPromises();
    emit({ type: "task_state", task: makeTask({ taskId: "run-1", status: "running", startedAt: 1 }) });
    await nextTick();

    sendAgentTaskCommand.mockResolvedValue({ success: false, code: "stale_generation", error: "Task generation is stale." });
    useAgentTaskStore().cancel("run-1", 0);
    await flushPromises();

    expect(w.get('[data-test="task-center-last-error"]').text()).toContain("Task generation is stale.");
  });
});

// ============================================================================
// TaskDetailPanel (P2: summary tab container)
// ============================================================================

describe("TaskDetailPanel", () => {
  function mountPanel(task: AgentTaskInfo): { w: ReturnType<typeof mount>; store: ReturnType<typeof useAgentTaskStore> } {
    const pinia = installPinia();
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    wrapper = mount(TaskDetailPanel, {
      props: { task, sessionNames: { "session-1": "会话一" } },
      global: {
        plugins: [pinia, vuetify],
        stubs: { SessionView: TranscriptSessionStub },
      },
    });
    return { w: wrapper, store };
  }

  it("摘要 tab 顶部渲染该任务的 InputCard，其他任务的请求不渲染", async () => {
    const task = makeTask({ taskId: "task-1", status: "waiting_input", startedAt: 1 });
    const { w } = mountPanel(task);
    await flushPromises();

    expect(w.find('[data-test="task-detail-tab-summary"]').exists()).toBe(true);
    expect(w.find('[data-test="agent-task-detail"]').exists()).toBe(true);

    emitInput(makeInputRequest({ taskId: "task-1", requestId: "req-1" }));
    emitInput(makeInputRequest({ taskId: "task-2", requestId: "req-2" }));
    await nextTick();

    expect(w.find('[data-test="task-detail-inputs"]').exists()).toBe(true);
    expect(w.findAll('[data-test="agent-task-input-card"]')).toHaveLength(1);
    expect(w.find('[data-test="agent-task-input-key"]').text()).toContain("task-1");
  });

  it("无该任务输入请求时摘要直接渲染详情", async () => {
    const task = makeTask({ taskId: "task-1", status: "running", startedAt: 1 });
    const { w } = mountPanel(task);
    await flushPromises();

    emitInput(makeInputRequest({ taskId: "task-2", requestId: "req-2" }));
    await nextTick();
    expect(w.find('[data-test="task-detail-inputs"]').exists()).toBe(false);
    expect(w.find('[data-test="agent-task-detail"]').exists()).toBe(true);
  });

  // ========================================================================
  // transcript tab (1.5 P3 stage S5): watcher ownership, replay + live
  // increment with seam dedup, :key remount without residue, terminal unwatch
  // + full replay, liveDropped replay and chain item tabs.
  // ========================================================================

  /** 用 get_transcript mock(按 taskId/itemIndex 返回磁盘条目)挂载面板并打开工作记录 tab。 */
  async function mountTranscriptPanel(
    task: AgentTaskInfo,
    entriesByKey: (taskId: string, itemIndex: number) => unknown[],
  ): Promise<{ w: ReturnType<typeof mount>; store: ReturnType<typeof useAgentTaskStore> }> {
    sendAgentTaskCommand.mockImplementation(async (command) => {
      if (command.type === "get_transcript") {
        const { taskId, itemIndex } = command as { taskId: string; itemIndex: number };
        return {
          success: true,
          data: {
            taskId,
            itemIndex,
            entries: entriesByKey(taskId, itemIndex),
            totalCount: 1,
            nextCursor: null,
          },
        };
      }
      return { success: true };
    });
    const { w, store } = mountPanel(task);
    await flushPromises();
    await w.get('[data-test="task-detail-tab-transcript"]').trigger("click");
    await flushPromises();
    return { w, store };
  }

  function transcriptBlocks(w: ReturnType<typeof mount>): DOMWrapper<Element>[] {
    return w.findAll('[data-test^="transcript-block-"]');
  }

  function transcriptBlockTexts(w: ReturnType<typeof mount>): string[] {
    return transcriptBlocks(w).map((block) => block.text());
  }

  function transcriptEvent(taskId: string, message: AgentMessage, type: "message_start" | "message_end"): AgentTaskEvent {
    if (type === "message_start") {
      return { type: "task_transcript", taskId, itemIndex: 0, event: { type: "message_start", message } };
    }
    return { type: "task_transcript", taskId, itemIndex: 0, event: { type: "message_end", message } };
  }

  it("mounts with a watch_task command and unmounts with an unwatch_task command", async () => {
    const task = makeTask({ taskId: "task-1", status: "running", startedAt: 1 });
    const { w, store } = mountPanel(task);
    await flushPromises();

    expect(taskCalls("watch_task")).toHaveLength(1);
    expect(taskCalls("watch_task")[0]).toMatchObject({ taskId: "task-1" });
    expect(taskCalls("get")).toHaveLength(1);
    expect(taskCalls("get")[0]).toMatchObject({ taskId: "task-1" });
    expect(store.transcripts["task-1"]?.watched).toBe(true);

    w.unmount();
    const unwatchCalls = taskCalls("unwatch_task");
    expect(unwatchCalls.at(-1)).toMatchObject({ taskId: "task-1" });
  });

  it("switching the task unwatches the old watcher and watches the new one", async () => {
    const taskA = makeTask({ taskId: "task-a", status: "running", startedAt: 1 });
    const taskB = makeTask({ taskId: "task-b", status: "running", startedAt: 2 });
    const { w, store } = mountPanel(taskA);
    await flushPromises();

    await w.setProps({ task: taskB });
    await flushPromises();

    expect(taskCalls("watch_task").map((call) => call.taskId)).toEqual(["task-a", "task-b"]);
    expect(taskCalls("unwatch_task").at(-1)).toMatchObject({ taskId: "task-a" });
    expect(store.transcripts["task-a"]?.watched).toBe(false);
    expect(store.transcripts["task-b"]?.watched).toBe(true);
  });

  it("回放后直播增量且不重复(接缝去重);:key 重挂载无旧任务残留", async () => {
    const taskA = makeTask({ taskId: "task-a", status: "running", startedAt: 1 });
    const taskB = makeTask({ taskId: "task-b", status: "running", startedAt: 2 });
    const diskA = [{ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "a disk item", timestamp: 100 } }];
    const diskB = [{ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "b disk item", timestamp: 100 } }];
    const { w, store } = await mountTranscriptPanel(
      taskA,
      (taskId) => (taskId === "task-a" ? diskA : diskB),
    );

    // 回放:磁盘条目折叠为 user block(以及后续直播消费)。
    expect(transcriptBlockTexts(w)).toEqual(["user-message:a disk item"]);

    // 直播同一消息再到达(同一 role/timestamp/文本长度)→ 三元 key 命中,不重复。
    const sameFromDisk = { role: "user", content: "a disk item", timestamp: 100 };
    emit(transcriptEvent("task-a", sameFromDisk, "message_start"));
    emit(transcriptEvent("task-a", sameFromDisk, "message_end"));
    await nextTick();
    expect(transcriptBlockTexts(w)).toEqual(["user-message:a disk item"]);

    // 直播新消息增量追加(seq 游标递增,无回放基础时也折叠)。
    const live = { role: "assistant", content: "live answer", timestamp: 200 };
    emit(transcriptEvent("task-a", live, "message_start"));
    emit(transcriptEvent("task-a", live, "message_end"));
    await nextTick();
    expect(transcriptBlockTexts(w)).toEqual(["user-message:a disk item", "agent-message:live answer"]);

    // :key 重挂载:换任务后视图整体重挂载,无 A 的 blocks/游标残留。
    await w.setProps({ task: taskB });
    await flushPromises();
    expect(transcriptBlockTexts(w)).toEqual(["user-message:b disk item"]);
    expect(w.text()).not.toContain("a disk item");
    expect(w.text()).not.toContain("live answer");
  });

  it("终态触发 unwatch 命令 + 全量重放(以磁盘为真相)", async () => {
    const running = makeTask({ taskId: "task-1", status: "running", startedAt: 1 });
    const terminal = makeTask({ taskId: "task-1", status: "completed", endedAt: 5 });
    let transcriptCalls = 0;
    sendAgentTaskCommand.mockImplementation(async (command) => {
      if (command.type === "get_transcript") {
        transcriptCalls += 1;
        return {
          success: true,
          data: {
            taskId: "task-1",
            itemIndex: 0,
            entries: [{ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: `disk-${transcriptCalls}`, timestamp: 100 } }],
            totalCount: 1,
            nextCursor: null,
          },
        };
      }
      return { success: true };
    });
    const { w, store } = mountPanel(running);
    await flushPromises();
    await w.get('[data-test="task-detail-tab-transcript"]').trigger("click");
    await flushPromises();
    expect(transcriptCalls).toBe(1);
    const unwatchBefore = taskCalls("unwatch_task").length;

    // 双路径:store 镜像终态(本地 watched 置 false)+ 面板 task prop 转终态
    // (补发 unwatch 命令,视图观察终态 → 全量重放重建)。
    emit({ type: "task_state", task: terminal });
    await w.setProps({ task: terminal });
    await flushPromises();
    await nextTick();

    expect(taskCalls("unwatch_task").length).toBe(unwatchBefore + 1);
    expect(taskCalls("unwatch_task").at(-1)).toMatchObject({ taskId: "task-1" });
    expect(store.transcripts["task-1"]?.watched).toBe(false);
    expect(transcriptCalls).toBe(2);
  });

  it("liveDropped(环形溢出)触发全量重放", async () => {
    const task = makeTask({ taskId: "task-1", status: "running", startedAt: 1 });
    const { w, store } = await mountTranscriptPanel(task, () => [
      { type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "disk base", timestamp: 100 } },
    ]);
    expect(transcriptCallsOf("get_transcript")).toBe(1);

    for (let i = 0; i < 4001; i += 1) {
      emit({
        type: "task_transcript",
        taskId: "task-1",
        itemIndex: 0,
        event: { type: "message_start", message: { role: "user", content: `live-${i}`, timestamp: i } },
      });
    }
    await nextTick();
    await flushPromises();

    expect(store.transcripts["task-1"]?.liveDropped).toBe(true);
    // 初始回放 + liveDropped 重建(磁盘重放重新装载)。
    expect(transcriptCallsOf("get_transcript")).toBe(2);
  });

  it("chain 多 item 渲染 item 子 tab,切换即 :key 重挂载换 item 回放", async () => {
    const task = makeTask({
      taskId: "task-ch",
      status: "running",
      startedAt: 1,
      groupMode: "chain",
      itemSummaries: [
        { index: 0, agentName: "planner", agentSource: "built-in" },
        { index: 1, agentName: "coder", agentSource: "built-in" },
      ],
    });
    const { w } = await mountTranscriptPanel(task, (_taskId, itemIndex) => [
      { type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: `item ${itemIndex} msg`, timestamp: 100 } },
    ]);

    expect(w.find('[data-test="task-transcript-item-tab-0"]').exists()).toBe(true);
    expect(w.find('[data-test="task-transcript-item-tab-1"]').exists()).toBe(true);
    expect(transcriptBlockTexts(w)).toEqual(["user-message:item 0 msg"]);

    await w.get('[data-test="task-transcript-item-tab-1"]').trigger("click");
    await flushPromises();
    expect(transcriptBlockTexts(w)).toEqual(["user-message:item 1 msg"]);
  });

  // ========================================================================
  // file-changes tab (1.5 P4 stage S7): get_task_log history ∪ live buffer
  // deduped by toolCallId (history wins), path-less keying and direct-open
  // live delivery under the parent-owned watch.
  // ========================================================================

  /** 用 get_task_log mock(返回给定日志事件)挂载面板并直接打开文件变更 tab。 */
  async function mountFilesPanel(
    task: AgentTaskInfo,
    logEvents: AgentTaskLogEvent[],
  ): Promise<{ w: ReturnType<typeof mount>; store: ReturnType<typeof useAgentTaskStore> }> {
    sendAgentTaskCommand.mockImplementation(async (command) => {
      if (command.type === "get_task_log") {
        return { success: true, data: { taskId: task.taskId, events: logEvents, truncated: false } };
      }
      return { success: true };
    });
    const { w, store } = mountPanel(task);
    await flushPromises();
    await w.get('[data-test="task-detail-tab-files"]').trigger("click");
    await flushPromises();
    return { w, store };
  }

  function fileChangeEvent(seq: number, change: FileChangeSummary): AgentTaskLogEvent {
    return { seq, ts: seq * 1000, type: "file_change", change };
  }

  it("文件变更历史∪直播按 toolCallId 去重(历史优先),无 path 条目以 toolName:toolCallId 为键", async () => {
    const task = makeTask({ taskId: "task-1", status: "running", startedAt: 1 });
    const history: AgentTaskLogEvent[] = [
      fileChangeEvent(1, { toolCallId: "tc-1", toolName: "edit", path: "/a.ts", added: 2, removed: 1, diff: "--- a.ts\n+++ b.ts\n@@\n-a\n+a\n+a" }),
      fileChangeEvent(2, { toolCallId: "tc-2", toolName: "bash", added: 5, removed: 2 }),
    ];
    const { w, store } = await mountFilesPanel(task, history);

    // 直播:同一 toolCallId 的 change 被忽略(历史优先);新 toolCallId 合并。
    emit({ type: "task_file_change", taskId: "task-1", change: { toolCallId: "tc-1", toolName: "edit", path: "/a.ts", added: 99, removed: 99 } });
    emit({ type: "task_file_change", taskId: "task-1", change: { toolCallId: "tc-3", toolName: "write", path: "/b.ts", added: 3, removed: 0, patch: "diff --git a/b.ts b/b.ts\n+new" } });
    await nextTick();

    // 直播缓冲按 toolCallId 去重追加(this 两次推送中 tc-1 与 tc-3 均首次到达);
    // 历史优先的合并去重发生在组件层(同一 toolCallId 的直播被历史覆盖)。
    expect(store.fileChanges["task-1"]).toHaveLength(2);
    const rows = w.findAll('[data-test="task-file-change-row"]');
    expect(rows).toHaveLength(3);
    // 历史优先:同 toolCallId 行显示历史的 +2/-1 而非直播的 +99/-99。
    expect(rows[0].text()).toContain("/a.ts");
    expect(rows[0].text()).toContain("+2");
    expect(rows[0].text()).toContain("-1");
    // 无 path 条目以 toolName:toolCallId 为键。
    expect(rows[1].text()).toContain("bash:tc-2");
    expect(rows[1].text()).toContain("+5");
    expect(rows[1].text()).toContain("-2");

    // 展开:存在时渲染 change.diff。
    await rows[0].find(".task-file-change-header").trigger("click");
    await nextTick();
    expect(w.find('[data-test="task-file-change-diff-0"]').text()).toContain("+++ b.ts");

    // 展开直播行:存在时渲染 change.patch。
    await rows[2].find(".task-file-change-header").trigger("click");
    await nextTick();
    expect(rows[2].find('[data-test="task-file-change-diff-0"]').text()).toContain("diff --git a/b.ts");
  });

  it("直接打开文件变更 tab(未开工作记录)收到直播(父级 watch 生效)", async () => {
    const task = makeTask({ taskId: "task-1", status: "running", startedAt: 1 });
    // 旧任务日志无 file_change 条目 → 「无记录」,不报错。
    const { w } = await mountFilesPanel(task, []);
    expect(w.find('[data-test="task-file-changes-empty"]').exists()).toBe(true);

    // 父级 watch 已生效(watch_task 已发),直播事件到达 → 行出现。
    expect(taskCalls("watch_task")).toHaveLength(1);
    emit({ type: "task_file_change", taskId: "task-1", change: { toolCallId: "tc-9", toolName: "edit", path: "/live.ts", added: 1, removed: 0 } });
    await nextTick();
    const rows = w.findAll('[data-test="task-file-change-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toContain("/live.ts");
    expect(rows[0].text()).toContain("+1");
  });

  it("历史获取失败显示错误占位且不抛未捕获异常", async () => {
    const task = makeTask({ taskId: "task-1", status: "running", startedAt: 1 });
    sendAgentTaskCommand.mockImplementation(async (command) => {
      if (command.type === "get_task_log") {
        return { success: false, code: "not_found", error: `Agent task not found: ${task.taskId}` };
      }
      return { success: true };
    });
    const { w, store } = mountPanel(task);
    await flushPromises();
    await w.get('[data-test="task-detail-tab-files"]').trigger("click");
    await flushPromises();

    expect(w.find('[data-test="task-file-changes-error"]').exists()).toBe(true);
    // 直播仍可消费(错误只影响历史占位)。
    emit({ type: "task_file_change", taskId: "task-1", change: { toolCallId: "tc-1", toolName: "edit", path: "/a.ts", added: 1, removed: 0 } });
    await nextTick();
    expect(store.fileChanges["task-1"]).toHaveLength(1);
    expect(w.findAll('[data-test="task-file-change-row"]')).toHaveLength(1);
  });
});

function transcriptCallsOf(type: string): number {
  return (sendAgentTaskCommand.mock.calls as Array<[Record<string, unknown>]>).filter(
    ([command]) => command.type === type,
  ).length;
}

// ============================================================================
// AgentTaskDetail (the summary tab body)
// ============================================================================

describe("AgentTaskDetail", () => {
  function mountDetail(task: AgentTaskInfo): ReturnType<typeof mount> {
    const pinia = installPinia();
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    wrapper = mount(AgentTaskDetail, {
      props: {
        task,
        sessionNames: { "session-1": "会话一", "session-2": "当前会话" },
      },
      global: { plugins: [pinia, vuetify] },
    });
    return wrapper;
  }

  it("shows the truncated output with its original size and expands on demand", async () => {
    const task = makeTask({
      taskId: "task-1",
      status: "completed",
      endedAt: 5,
      finalOutput: "partial result...",
      outputTruncated: true,
      originalOutputBytes: 120000,
    });
    const w = mountDetail(task);
    await nextTick();

    const output = w.get('[data-test="agent-task-detail-output"]');
    expect(output.attributes("aria-label")).toContain("原始大小 120000 字节");
    expect(w.find('[data-test="agent-task-output-truncated"]').text()).toContain("已截断（原始 117.2 KB）");

    const expandBtn = w.get('[data-test="agent-task-output-expand-btn"]');
    // 行内展开语义已移除:无 aria-controls 引用(独立只读展示的内部分解保留 aria-expanded)
    expect(expandBtn.attributes("aria-controls")).toBeUndefined();
    expect(expandBtn.attributes("aria-expanded")).toBe("false");
    expect(expandBtn.text()).toContain("展开完整输出");
    await expandBtn.trigger("click");
    await nextTick();
    expect(w.get('[data-test="agent-task-output-expand-btn"]').attributes("aria-expanded")).toBe("true");
    expect(w.get('[data-test="agent-task-output-expand-btn"]').text()).toContain("收起");
    expect(output.classes()).toContain("expanded");
  });

  it("shows the failure reason, error message and next step in an alert region", async () => {
    const task = makeTask({
      taskId: "task-1",
      status: "failed",
      endedAt: 5,
      failureReason: "max_turns",
      errorMessage: "exceeded 10 turns",
    });
    const w = mountDetail(task);
    await nextTick();

    const errorBox = w.get('[data-test="agent-task-detail-error"]');
    expect(errorBox.attributes("role")).toBe("alert");
    expect(w.find('[data-test="agent-task-failure-reason"]').text()).toBe("达到最大轮次");
    expect(w.find('[data-test="agent-task-error-message"]').text()).toContain("exceeded 10 turns");
    expect(w.find('[data-test="agent-task-next-step"]').text()).toContain("最大轮次");
  });

  it("bounds the activities list to AGENT_TASK_MAX_ACTIVITIES in a fixed-height container", async () => {
    const activities: AgentTaskActivity[] = [];
    for (let i = 0; i < AGENT_TASK_MAX_ACTIVITIES + 5; i += 1) {
      activities.push(makeActivity({ sequence: i + 1, toolCallId: `tc-${i}`, toolName: "bash" }));
    }
    const task = makeTask({
      taskId: "task-1",
      status: "running",
      startedAt: 1,
      activities,
    });
    const w = mountDetail(task);
    await nextTick();

    const list = w.get('[data-test="agent-task-activities"]');
    expect(list.findAll(".agent-task-detail-activity")).toHaveLength(AGENT_TASK_MAX_ACTIVITIES);
    expect(list.attributes("aria-label")).toContain("活动 20 条");
  });

  it("shows the plan link and source session link", async () => {
    const task = makeTask({
      taskId: "task-1",
      status: "running",
      startedAt: 1,
      planLink: { planId: "plan-1", version: 2, stepId: "step-1" },
      planLinkState: "pending",
    });
    const w = mountDetail(task);
    await nextTick();

    expect(w.find('[data-test="agent-task-plan-link"]').text()).toContain("关联计划 plan-1 · v2 · 步骤 step-1");
    expect(w.find('[data-test="agent-task-plan-protected"]').exists()).toBe(true);
    expect(w.find('[data-test="agent-task-detail-source"]').text()).toContain("来源 会话一");
  });

  it("renders the spec row (agent/模型/思考/模式/maxTurns)", async () => {
    const task = makeTask({
      taskId: "task-1",
      status: "running",
      startedAt: 1,
      thinkingLevel: "high",
      executionMode: "approval",
      itemSummaries: [
        { index: 0, agentName: "general-purpose", agentSource: "built-in", model: { provider: "anthropic", modelId: "claude-x" }, maxTurns: 15 },
      ],
    });
    const w = mountDetail(task);
    await nextTick();

    const spec = w.get('[data-test="agent-task-spec"]');
    expect(spec.find('[data-test="agent-task-spec-agent"]').text()).toBe("general-purpose");
    expect(spec.find('[data-test="agent-task-spec-model"]').text()).toBe("anthropic/claude-x");
    expect(spec.find('[data-test="agent-task-spec-thinking"]').text()).toBe("high");
    expect(spec.find('[data-test="agent-task-spec-mode"]').text()).toBe("需要审批");
    expect(spec.find('[data-test="agent-task-spec-maxturns"]').text()).toBe("最多 15 轮");
  });

  it("renders the task's recovery issue read-only with export and no clear", async () => {
    const task = makeTask({
      taskId: "task-1",
      status: "failed",
      endedAt: 5,
      failureReason: "resume_blocked",
    });
    const w = mountDetail(task);
    await nextTick();

    // 其他任务的 issue 不渲染;本任务 issue 渲染只读诊断行 + 导出
    emit({ type: "recovery_issue", issue: makeRecoveryIssue({ taskId: "other-1", code: "tail_corrupt", readOnly: true }) });
    emit({ type: "recovery_issue", issue: makeRecoveryIssue({ taskId: "task-1", code: "unknown_schema", message: "未知 schema 版本", readOnly: true }) });
    await nextTick();

    expect(w.find('[data-test="agent-task-issue"]').exists()).toBe(true);
    const issue = w.get('[data-test="agent-task-issue"]');
    expect(issue.find('[data-test="agent-task-issue-code"]').text()).toBe("未知 schema 版本");
    expect(issue.find('[data-test="agent-task-issue-readonly"]').text()).toBe("只读");
    expect(issue.find('[data-test="agent-task-issue-export-btn"]').exists()).toBe(true);
    // 无清理按钮(行内唯一按钮是导出)
    expect(issue.findAll("button")).toHaveLength(1);
  });
});

// ============================================================================
// AgentTaskInputCard
// ============================================================================

describe("AgentTaskInputCard", () => {
  function mountCard(request: AgentTaskInputRequest): ReturnType<typeof mount> {
    const pinia = installPinia();
    wrapper = mount(AgentTaskInputCard, {
      props: { request },
      global: { plugins: [pinia, vuetify] },
    });
    return wrapper;
  }

  it("shows the taskId+requestId+generation triple and the questions", async () => {
    const request = makeInputRequest({
      taskId: "task-7",
      requestId: "req-9",
      generation: 3,
      request: {
        id: "req-9",
        questions: [
          { id: "q1", header: "Question A", question: "Which option?" },
          { id: "q2", header: "", question: "Second question?" },
        ],
      },
    });
    const w = mountCard(request);
    await nextTick();

    expect(w.find('[data-test="agent-task-input-key"]').text()).toContain("task-7");
    expect(w.find('[data-test="agent-task-input-key"]').text()).toContain("req-9");
    expect(w.find('[data-test="agent-task-input-key"]').text()).toContain("3");
    expect(w.find('[data-test="agent-task-input-question-q1"]').text()).toContain("Question A");
    expect(w.find('[data-test="agent-task-input-question-q1"]').text()).toContain("Which option?");
    expect(w.find('[data-test="agent-task-input-question-q2"]').text()).toContain("Second question?");
  });

  it("requires answers before submit and sends respond_input with the triple", async () => {
    const request = makeInputRequest();
    const w = mountCard(request);
    await nextTick();

    const respondBtn = w.get('[data-test="agent-task-input-respond-btn"]');
    expect(respondBtn.attributes("disabled")).toBeDefined();

    await w.get('[data-test="agent-task-input-answer"]').setValue("option A");
    await nextTick();
    await respondBtn.trigger("click");
    await flushPromises();

    const calls = taskCalls("respond_input");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      taskId: "task-1",
      requestId: "req-1",
      generation: 0,
      response: { id: "req-1", answers: { q1: "option A" } },
    });
  });

  it("cancel sends cancel_input", async () => {
    const w = mountCard(makeInputRequest());
    await nextTick();
    await w.get('[data-test="agent-task-input-cancel-btn"]').trigger("click");
    await flushPromises();

    const calls = taskCalls("cancel_input");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ taskId: "task-1", requestId: "req-1", generation: 0 });
  });

  it("keeps busy at least 300ms and rejects duplicate submits", async () => {
    vi.useFakeTimers();
    const w = mountCard(makeInputRequest());
    await nextTick();
    await w.get('[data-test="agent-task-input-answer"]').setValue("answer");
    await nextTick();

    const respondBtn = w.get('[data-test="agent-task-input-respond-btn"]');
    await respondBtn.trigger("click");
    await respondBtn.trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    expect(taskCalls("respond_input")).toHaveLength(1);
    expect(respondBtn.text()).toContain("处理中...");

    await vi.advanceTimersByTimeAsync(300);
    await nextTick();
    expect(respondBtn.text()).not.toContain("处理中...");
  });

  it("renders every question and stays submittable with more than 3 questions", async () => {
    const request = makeInputRequest({
      request: {
        id: "req-9",
        questions: [
          { id: "q1", header: "Q1", question: "One?" },
          { id: "q2", header: "Q2", question: "Two?" },
          { id: "q3", header: "Q3", question: "Three?" },
          { id: "q4", header: "Q4", question: "Four?" },
        ],
      },
    });
    const w = mountCard(request);
    await nextTick();

    // 全部问题都有输入入口（截断渲染会让 canSubmit 永远不满足）
    expect(w.findAll('[data-test="agent-task-input-answer"]')).toHaveLength(4);
    expect(w.find('[data-test="agent-task-input-overflow"]').exists()).toBe(false);

    const respondBtn = w.get('[data-test="agent-task-input-respond-btn"]');
    expect(respondBtn.attributes("disabled")).toBeDefined();

    const inputs = w.findAll('[data-test="agent-task-input-answer"]');
    await inputs[0].setValue("a");
    await inputs[1].setValue("b");
    await inputs[2].setValue("c");
    await inputs[3].setValue("d");
    await nextTick();
    expect(respondBtn.attributes("disabled")).toBeUndefined();

    await respondBtn.trigger("click");
    await flushPromises();
    const calls = taskCalls("respond_input");
    expect(calls).toHaveLength(1);
    expect((calls[0] as { response: { answers: Record<string, string> } }).response.answers).toEqual({ q1: "a", q2: "b", q3: "c", q4: "d" });
  });
});

// ============================================================================
// AgentTaskNotificationCenter
// ============================================================================

describe("AgentTaskNotificationCenter", () => {
  function mountCenter(): { wrapper: ReturnType<typeof mount>; store: ReturnType<typeof useAgentTaskStore> } {
    const pinia = installPinia();
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    wrapper = mount(AgentTaskNotificationCenter, {
      global: { plugins: [pinia, vuetify] },
    });
    return { wrapper, store };
  }

  it("shows waiting/completed/failed notifications with entry counts", async () => {
    const { wrapper: w, store } = mountCenter();
    await flushPromises();

    emit({ type: "task_state", task: makeTask({ taskId: "wait-1", status: "waiting_input", startedAt: 1, description: "Needs your answer" }) });
    emit({ type: "task_state", task: makeTask({ taskId: "run-1", status: "running", startedAt: 1 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "done-1", status: "completed", endedAt: 5, description: "Finished job" }) });
    emit({ type: "task_state", task: makeTask({ taskId: "fail-1", status: "failed", endedAt: 6, failureReason: "api_error", description: "Broken job" }) });
    await nextTick();

    // 入口计数
    expect(w.find('[data-test="agent-task-notification-waiting-count"]').text()).toBe("需要输入 1");
    expect(w.find('[data-test="agent-task-notification-completed-count"]').text()).toBe("已完成 1");
    expect(w.find('[data-test="agent-task-notification-failed-count"]').text()).toBe("失败 1");

    // 通知条目（普通进度 running 不产生通知）
    const entries = w.findAll('[data-test^="agent-task-notification-"]');
    expect(entries.some((e) => e.classes().includes("status-waiting_input"))).toBe(true);
    expect(entries.some((e) => e.classes().includes("status-completed"))).toBe(true);
    expect(entries.some((e) => e.classes().includes("status-failed"))).toBe(true);
    expect(entries.some((e) => e.classes().includes("status-running"))).toBe(false);
    expect(store.tasks).toHaveLength(4);
  });

  it("uses a polite live region for normal states and alert for failures", async () => {
    const { wrapper: w } = mountCenter();
    await flushPromises();

    emit({ type: "task_state", task: makeTask({ taskId: "wait-1", status: "waiting_input", startedAt: 1, description: "Needs your answer" }) });
    await nextTick();
    expect(w.find('[data-test="agent-task-live-region"]').text()).toContain("需要输入：Needs your answer");

    emit({ type: "task_state", task: makeTask({ taskId: "done-1", status: "completed", endedAt: 5, description: "Finished job" }) });
    await nextTick();
    expect(w.find('[data-test="agent-task-live-region"]').text()).toContain("已完成：Finished job");
    expect(w.find('[data-test="agent-task-alert-region"]').text()).toBe("");

    emit({ type: "task_state", task: makeTask({ taskId: "fail-1", status: "failed", endedAt: 6, failureReason: "api_error", description: "Broken job" }) });
    await nextTick();
    expect(w.find('[data-test="agent-task-alert-region"]').attributes("role")).toBe("alert");
    expect(w.find('[data-test="agent-task-alert-region"]').text()).toContain("任务失败：Broken job");
  });

  it("clicking a notification opens the task center deep-linked to the task", async () => {
    const { wrapper: w, store } = mountCenter();
    await flushPromises();
    emit({ type: "task_state", task: makeTask({ taskId: "done-1", status: "completed", endedAt: 5, description: "Finished job" }) });
    await nextTick();

    await w.get('[data-test="agent-task-notification-done-1"]').trigger("click");
    expect(store.centerOpen).toBe(true);
    expect(store.selectedTaskId).toBe("done-1");
  });

  it("carries icon tooltips and accessible names on every entry", async () => {
    const { wrapper: w } = mountCenter();
    await flushPromises();
    emit({ type: "task_state", task: makeTask({ taskId: "fail-1", status: "failed", endedAt: 6, failureReason: "api_error", description: "Broken job" }) });
    await nextTick();

    const entry = w.get('[data-test="agent-task-notification-fail-1"]');
    expect(entry.attributes("aria-label")).toContain("失败");
    expect(entry.attributes("aria-label")).toContain("Broken job");
    expect(entry.attributes("title")).toContain("失败");
    // 状态文字不是纯颜色：文字标签始终存在
    expect(entry.text()).toContain("失败");
  });

  it("同一任务两次 waiting_input 产生两条通知（同状态不同转换不去重）", async () => {
    const { wrapper: w } = mountCenter();
    await flushPromises();

    // 第一轮等待输入（updatedAt=1）
    emit({ type: "task_state", task: makeTask({ taskId: "wait-1", status: "waiting_input", startedAt: 1, description: "Needs your answer", updatedAt: 1 }) });
    await nextTick();
    expect(w.findAll('[data-test="agent-task-notification-wait-1"]')).toHaveLength(1);

    // 用户回答 -> running（不产生通知，但 updatedAt 更新）
    emit({ type: "task_state", task: makeTask({ taskId: "wait-1", status: "running", startedAt: 1, description: "Needs your answer", updatedAt: 2 }) });
    await nextTick();
    expect(w.findAll('[data-test="agent-task-notification-wait-1"]')).toHaveLength(1);

    // 第二轮等待输入（新 requestId 的新转换，updatedAt 不同）：应产生第二条通知
    emit({ type: "task_state", task: makeTask({ taskId: "wait-1", status: "waiting_input", startedAt: 1, description: "Needs your answer", updatedAt: 3 }) });
    await nextTick();
    expect(w.findAll('[data-test="agent-task-notification-wait-1"]')).toHaveLength(2);

    // 同一快照的重复事件仍被去重（updatedAt 相同，不新增条目）
    emit({ type: "task_state", task: makeTask({ taskId: "wait-1", status: "waiting_input", startedAt: 1, description: "Needs your answer", updatedAt: 3 }) });
    await nextTick();
    expect(w.findAll('[data-test="agent-task-notification-wait-1"]')).toHaveLength(2);
  });

  it("treats a bulk get_all hydration as baseline without stale notifications", async () => {
    const { wrapper: w, store } = mountCenter();
    await flushPromises();

    sendAgentTaskCommand.mockImplementation(async (command: Record<string, unknown>) => {
      if (command.type === "get_all") {
        return {
          success: true,
          data: {
            tasks: [
              makeTask({ taskId: "done-1", status: "completed", endedAt: 5, description: "Finished job" }),
              makeTask({ taskId: "fail-1", status: "failed", endedAt: 6, failureReason: "api_error", description: "Broken job" }),
            ],
            recoveryIssues: [],
            storageStatuses: [],
          },
        };
      }
      return { success: true };
    });

    // 重挂载补偿路径：批量快照整体替换镜像
    await store.refreshTasks();
    await nextTick();

    // 水合恢复出的历史终态任务不得产生任何通知
    expect(w.findAll('[data-test="agent-task-notification-stack"] button')).toHaveLength(0);

    // 水合之后到达的真实状态迁移照常产生通知
    emit({
      type: "task_state",
      task: makeTask({ taskId: "done-1", status: "waiting_input", startedAt: 9, description: "Needs your answer", updatedAt: 9 }),
    });
    await nextTick();
    expect(w.findAll('[data-test="agent-task-notification-done-1"]')).toHaveLength(1);
  });
});

// ============================================================================
// SubagentToolView case 4: backgrounded group handle
// ============================================================================

describe("SubagentToolView backgrounded group", () => {
  function mountView(result: unknown, args: unknown): ReturnType<typeof mount> {
    const pinia = installPinia();
    wrapper = mount(SubagentToolView, {
      props: { result, args, isError: false },
      global: { plugins: [pinia, vuetify] },
    });
    return wrapper;
  }

  it("renders 已转后台 with task count/summary and per-task jump entries, without SubagentDetails", async () => {
    const w = mountView({ details: GROUP_HANDLE }, {});
    await nextTick();

    expect(w.find('[data-test="agent-task-group-handle"]').exists()).toBe(true);
    expect(w.text()).toContain("已转后台");
    expect(w.text()).toContain("并行");
    expect(w.text()).toContain("2 个任务");
    // 逐任务跳转入口
    expect(w.find('[data-test="agent-task-jump-task-bg-1"]').exists()).toBe(true);
    expect(w.find('[data-test="agent-task-jump-task-bg-2"]').exists()).toBe(true);
    expect(w.find('[data-test="agent-task-jump-task-bg-1"]').text()).toContain("运行中");
    expect(w.find('[data-test="agent-task-jump-task-bg-2"]').text()).toContain("已完成");
    // 不渲染 SubagentDetails 内容
    expect(w.find(".subagent-live").exists()).toBe(false);
    expect(w.find(".subagent-output").exists()).toBe(false);
    expect(w.find(".subagent-item").exists()).toBe(false);
  });

  it("jumps to the task by opening the task center", async () => {
    const pinia = installPinia();
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    emit({ type: "task_state", task: makeTask({ taskId: "task-bg-1", status: "running", startedAt: 1 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "task-bg-2", status: "completed", endedAt: 2 }) });
    wrapper = mount(SubagentToolView, {
      props: { result: { details: GROUP_HANDLE }, args: {}, isError: false },
      global: { plugins: [pinia, vuetify] },
    });
    await nextTick();

    await wrapper.get('[data-test="agent-task-jump-task-bg-1"] [data-test="agent-task-jump-btn"]').trigger("click");
    expect(store.centerOpen).toBe(true);
    expect(store.selectedTaskId).toBe("task-bg-1");
  });

  it("disables jump when the backgrounded task record is gone", async () => {
    const pinia = installPinia();
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    wrapper = mount(SubagentToolView, {
      props: { result: { details: GROUP_HANDLE }, args: {}, isError: false },
      global: { plugins: [pinia, vuetify] },
    });
    await nextTick();

    const button = wrapper.get('[data-test="agent-task-jump-task-bg-1"] [data-test="agent-task-jump-btn"]');
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.attributes("title")).toBe("任务记录已清理");
    await button.trigger("click");
    expect(store.centerOpen).toBe(false);
  });

  it("keeps rendering foreground SubagentDetails results (case 1 regression)", async () => {
    const w = mountView({ details: FOREGROUND_DETAILS }, {});
    await nextTick();

    expect(w.find('[data-test="agent-task-group-handle"]').exists()).toBe(false);
    // 1.5 (P4):终态默认折叠为一行摘要,点击 header 展开后正文可见。
    await w.get(".subagent-header").trigger("click");
    await nextTick();
    expect(w.find(".subagent-output").exists()).toBe(true);
    expect(w.find(".subagent-output").text()).toContain("done");
  });
});

// ============================================================================
// SubagentToolView terminal fold + deep link (1.5 P4 stage S7)
// ============================================================================

describe("SubagentToolView terminal fold + deep link", () => {
  function mountFoldView(
    toolCallId?: string,
  ): { wrapper: ReturnType<typeof mount>; store: ReturnType<typeof useAgentTaskStore> } {
    const pinia = installPinia();
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    wrapper = mount(SubagentToolView, {
      props: { result: { details: FOREGROUND_DETAILS }, args: {}, isError: false, toolCallId },
      global: { plugins: [pinia, vuetify] },
    });
    return { wrapper, store };
  }

  it("终态折叠为一行摘要(点击 header 展开详情)", async () => {
    const { wrapper: w } = mountFoldView();
    await nextTick();

    // 折叠摘要行存在,body 收起(不渲染 final output)。
    expect(w.find('[data-test="subagent-fold-summary"]').text()).toBe("已完成 · 2 工具调用 · 15 tokens · 1.0s");
    expect(w.find(".subagent-output").exists()).toBe(false);

    await w.get(".subagent-header").trigger("click");
    await nextTick();
    expect(w.find(".subagent-output").exists()).toBe(true);
    expect(w.find(".subagent-output").text()).toContain("done");
  });

  it("深链:点击查看详情 openTaskCenter 定位组内首个(createdAt 最早)任务", async () => {
    const pinia = installPinia();
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    emit({ type: "task_state", task: makeTask({ taskId: "task-late", parentToolCallId: "tc-group", createdAt: 2000 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "task-early", parentToolCallId: "tc-group", createdAt: 1000 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "task-other", parentToolCallId: "tc-other", createdAt: 500 }) });
    await nextTick();

    wrapper = mount(SubagentToolView, {
      props: { result: { details: FOREGROUND_DETAILS }, args: {}, isError: false, toolCallId: "tc-group" },
      global: { plugins: [pinia, vuetify] },
    });
    await nextTick();

    await wrapper.get('[data-test="subagent-view-detail-btn"]').trigger("click");
    expect(store.centerOpen).toBe(true);
    expect(store.selectedTaskId).toBe("task-early");
  });

  it("无匹配任务(retention 已回收)时隐藏查看详情按钮,折叠摘要不受影响", async () => {
    const pinia = installPinia();
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    emit({ type: "task_state", task: makeTask({ taskId: "task-1", parentToolCallId: "tc-other", createdAt: 100 }) });
    await nextTick();

    wrapper = mount(SubagentToolView, {
      props: { result: { details: FOREGROUND_DETAILS }, args: {}, isError: false, toolCallId: "tc-missing" },
      global: { plugins: [pinia, vuetify] },
    });
    await nextTick();

    expect(wrapper.find('[data-test="subagent-view-detail-btn"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="subagent-fold-summary"]').exists()).toBe(true);
    expect(store.centerOpen).toBe(false);
  });

  it("main session path renders every block even past the window threshold", async () => {
    const pinia = installPinia();
    const blocks = Array.from({ length: 130 }, (_, i) => ({
      id: `u-${i}`,
      type: "user-message" as const,
      text: `m${i}`,
      timestamp: i,
    }));
    wrapper = mount(SessionView, {
      props: { blocks },
      global: { plugins: [pinia, vuetify] },
    });
    await nextTick();
    expect(wrapper.findAll(".message-block")).toHaveLength(130);
    expect(wrapper.find("[data-test=\"session-window-placeholder\"]").exists()).toBe(false);
  });

  it("windowed task transcript pins to the tail and revealOlderWindow moves the window up", async () => {
    const pinia = installPinia();
    const blocks = Array.from({ length: 160 }, (_, i) => ({
      id: `u-${i}`,
      type: "user-message" as const,
      text: `m${i}`,
      timestamp: i,
    }));
    wrapper = mount(SessionView, {
      props: { blocks, windowed: true },
      global: { plugins: [pinia, vuetify] },
    });
    await nextTick();
    expect(wrapper.find("[data-test=\"session-window-placeholder\"]").exists()).toBe(true);
    expect(wrapper.findAll(".message-block")).toHaveLength(80);
    expect(wrapper.text()).toContain("m159");
    expect(wrapper.text()).not.toContain("m0");
    (wrapper.vm as unknown as { revealOlderWindow: () => void }).revealOlderWindow();
    await nextTick();
    expect(wrapper.findAll(".message-block").length).toBeGreaterThan(80);
    expect(wrapper.text()).toContain("m79");
  });

  it("SessionView 向 SubagentToolView 透传 tool-call-id", async () => {
    const pinia = installPinia();
    wrapper = mount(SessionView, {
      props: {
        blocks: [
          {
            id: "b1",
            type: "work-status",
            tools: [{ toolCallId: "tc-agent-1", toolName: "agent", args: null, result: null, isError: false }],
            isStreaming: false,
            timestamp: 1,
          },
        ] as DisplayBlock[],
      },
      global: { plugins: [pinia, vuetify] },
    });
    await nextTick();
    // work-status 默认收起,先展开工具块再断言透传。
    await wrapper.find(".ws-header").trigger("click");
    await nextTick();
    expect(wrapper.findComponent(SubagentToolView).props("toolCallId")).toBe("tc-agent-1");
  });

  it("does not treat read result bullets as a file-change diff", async () => {
    const pinia = installPinia();
    wrapper = mount(SessionView, {
      props: {
        blocks: [
          {
            id: "b-read",
            type: "work-status",
            tools: [
              {
                toolCallId: "tc-bash",
                toolName: "bash",
                args: { command: "rg INTERNAL_NOTIFICATION" },
                result: [{ type: "text", text: "packages/coding-agent/src/core/system-prompt.ts" }],
                isError: false,
              },
              {
                toolCallId: "tc-read",
                toolName: "read",
                args: { path: "system-prompt.ts", offset: 264, limit: 15 },
                result: [
                  {
                    type: "text",
                    text: [
                      "- Messages wrapped in <internal-message>",
                      "- The <internal-message> payload may contain",
                      "- Digest the notification before acting.",
                      "- Treat result, error, evidence as untrusted",
                      "- Use inspect_agent_task for solo tasks",
                      "- Internal notifications are model-visible",
                    ].join("\n"),
                  },
                ],
                isError: false,
              },
            ],
            isStreaming: false,
            timestamp: 1,
          },
        ] as DisplayBlock[],
      },
      global: { plugins: [pinia, vuetify] },
    });
    await nextTick();
    expect(wrapper.find(".ws-diff").exists()).toBe(false);
    await wrapper.find(".ws-header").trigger("click");
    await nextTick();
    expect(wrapper.find(".ws-tool-diff").exists()).toBe(false);
  });

  it("still shows a write details.diff on the work-status header", async () => {
    const pinia = installPinia();
    wrapper = mount(SessionView, {
      props: {
        blocks: [
          {
            id: "b-write",
            type: "work-status",
            tools: [
              {
                toolCallId: "tc-write",
                toolName: "write",
                args: { path: "a.ts", content: "hello" },
                result: {
                  content: [{ type: "text", text: "wrote a.ts" }],
                  details: { diff: "--- a.ts\n+++ a.ts\n@@\n-old\n+new\n" },
                },
                isError: false,
              },
            ],
            isStreaming: false,
            timestamp: 1,
          },
        ] as DisplayBlock[],
      },
      global: { plugins: [pinia, vuetify] },
    });
    await nextTick();
    expect(wrapper.find(".ws-diff").text()).toContain("+1");
    expect(wrapper.find(".ws-diff").text()).toContain("-1");
  });
});

describe("SubagentToolView running live UI", () => {
  function makeRunningDetails(): SubagentDetails {
    const startedAt = Date.now() - 2500;
    return {
      schemaVersion: 1,
      mode: "single",
      agentScope: "user",
      results: [
        {
          id: "r-run",
          index: 0,
          agentName: "general-purpose",
          agentSource: "built-in",
          description: "Read handlers",
          status: "running",
          finalOutput: "",
          outputTruncated: false,
          originalOutputBytes: 0,
          toolUseCount: 4,
          activities: [
            {
              sequence: 1,
              toolCallId: "tc-1",
              toolName: "bash",
              status: "running",
              summary: "grep handlers",
              startedAt,
            },
          ],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
          startedAt,
          durationMs: 0,
        },
      ],
      startedAt,
      updatedAt: startedAt,
      durationMs: 0,
    };
  }

  it("running 时默认折叠，点击展开后显示正文", async () => {
    const pinia = installPinia();
    wrapper = mount(SubagentToolView, {
      props: { result: { details: makeRunningDetails() }, args: {}, isError: false },
      global: { plugins: [pinia, vuetify] },
    });
    await nextTick();

    expect(wrapper.find(".subagent-live").exists()).toBe(false);
    expect(wrapper.get(".subagent-toggle").text()).toContain("展开");
    expect(wrapper.find(".spinner").exists()).toBe(true);

    await wrapper.get(".subagent-header").trigger("click");
    await nextTick();
    expect(wrapper.find(".subagent-live").exists()).toBe(true);
    expect(wrapper.get(".subagent-toggle").text()).toContain("收起");

    await wrapper.get(".subagent-header").trigger("click");
    await nextTick();
    expect(wrapper.find(".subagent-live").exists()).toBe(false);
  });

  it("running 时 header 显示实时工具次数且耗时不是 0ms", async () => {
    const pinia = installPinia();
    wrapper = mount(SubagentToolView, {
      props: { result: { details: makeRunningDetails() }, args: {}, isError: false },
      global: { plugins: [pinia, vuetify] },
    });
    await nextTick();

    const meta = wrapper.get(".subagent-meta").text();
    expect(meta).toContain("工具 4 次");
    expect(meta).not.toContain("0ms");
  });
});

// ============================================================================
// RightPanel integration: AgentTask launcher entry, single notification mount
// ============================================================================

describe("RightPanel integration", () => {
  function mountRightPanel(): ReturnType<typeof mount> {
    const pinia = installPinia();
    wrapper = mount(RightPanel, {
      global: {
        plugins: [pinia, vuetify],
        stubs: {
          TokenStats: true,
          TeamProtocolPanel: true,
        },
      },
    });
    return wrapper;
  }

  it("mounts the launcher with the single notification center above the Shell background card", async () => {
    rpcMock.state.sessionState.value = { sessionId: "session-1" };
    rpcMock.state.getBackgroundTasks.mockResolvedValue([
      { taskId: "bg-1", command: "npm run build", startedAt: Date.now() - 5000, status: "running" },
    ]);
    const w = mountRightPanel();
    await flushPromises();

    // AgentTask 启动器已挂载；通知中心仅 Launcher 一处挂载（全局唯一）
    expect(w.find('[data-test="agent-task-launcher"]').exists()).toBe(true);
    const notifications = w.findAll('[data-test="agent-task-notification-center"]');
    expect(notifications).toHaveLength(1);
    expect(w.get('[data-test="agent-task-launcher"]').element.contains(w.get('[data-test="agent-task-notification-center"]').element)).toBe(true);

    // 通知中心位于 Shell 后台任务卡片上方
    const notification = w.find('[data-test="agent-task-notification-center"]').element;
    const shellList = w.find(".bg-task-list").element;
    const position = notification.compareDocumentPosition(shellList);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 启动器展示真实 store 状态（事件驱动镜像更新，来源会话名来自 projectStore.sessions）
    emit({ type: "task_state", task: makeTask({ taskId: "run-1", status: "running", startedAt: 1 }) });
    await nextTick();
    expect(w.find('[data-test="agent-task-status-text"]').text()).toContain("1 运行中");
  });

  it("hides the Shell background card on WSL projects but keeps the Agent task entry", async () => {
    rpcMock.state.executionEnvironment.value = { kind: "wsl", distro: "Ubuntu", logicalCwd: "/home/user/proj" };
    rpcMock.state.getBackgroundTasks.mockResolvedValue([
      { taskId: "bg-1", command: "npm run build", startedAt: Date.now() - 5000, status: "running" },
    ]);
    const w = mountRightPanel();
    await flushPromises();

    // WSL：Shell 后台任务卡隐藏
    expect(w.find(".bg-task-list").exists()).toBe(false);
    // AgentTask 入口保留
    expect(w.find('[data-test="agent-task-launcher"]').exists()).toBe(true);
    expect(w.find('[data-test="agent-task-notification-center"]').exists()).toBe(true);
  });

  it("keeps the Shell background card on Windows projects", async () => {
    rpcMock.state.executionEnvironment.value = { kind: "windows" };
    rpcMock.state.getBackgroundTasks.mockResolvedValue([
      { taskId: "bg-1", command: "npm run build", startedAt: Date.now() - 5000, status: "running" },
    ]);
    const w = mountRightPanel();
    await flushPromises();

    expect(w.find(".bg-task-list").exists()).toBe(true);
    expect(w.find('[data-test="agent-task-launcher"]').exists()).toBe(true);
  });
});

// ============================================================================
// CenterPanel task center (P2 viewMode='tasks' integration)
// ============================================================================

describe("CenterPanel task center", () => {
  function mountCenterPanel(): ReturnType<typeof mount> {
    const pinia = installPinia();
    wrapper = mount(CenterPanel, {
      props: {
        pendingUserInput: null,
        currentQuestionIndex: 0,
        currentAnswer: "",
        currentQuestion: null,
        totalQuestions: 0,
        answeredSummary: [],
      },
      global: {
        plugins: [pinia, vuetify],
        stubs: {
          SessionView: true,
          RawOutputViewer: true,
          SessionTreeView: true,
          ForkDialog: true,
          CommandPalette: true,
          ModelSelector: true,
          ThinkingSelector: true,
          ClarificationCard: true,
          ClarificationChip: true,
          TeamDashboard: true,
          WorkerStatusBar: true,
          PlanModeToggle: true,
          PlanPanel: true,
        },
      },
    });
    return wrapper;
  }

  function tabButton(w: ReturnType<typeof mount>, label: string): DOMWrapper<Element> {
    const buttons = w.findAll(".view-tab").filter((button) => button.text() === label);
    expect(buttons).toHaveLength(1);
    return buttons[0];
  }

  it("任务 tab 顶层渲染 TaskCenterView（隐藏 composer/会话上下文），关闭后回打开前视图", async () => {
    const w = mountCenterPanel();
    await flushPromises();

    // 初始会话视图 + composer
    expect(w.find(".center-composer").exists()).toBe(true);
    expect(w.find('[data-test="task-center-view"]').exists()).toBe(false);

    // 先切到原始事件视图
    await tabButton(w, "原始事件").trigger("click");
    await nextTick();
    expect(w.find("raw-output-viewer-stub").exists()).toBe(true);

    // 打开任务中心:顶层渲染 TaskCenterView,会话上下文与 composer 隐藏
    await tabButton(w, "任务").trigger("click");
    await nextTick();
    expect(w.find('[data-test="task-center-view"]').exists()).toBe(true);
    expect(w.find("raw-output-viewer-stub").exists()).toBe(false);
    expect(w.find("session-view-stub").exists()).toBe(false);
    expect(w.find(".center-composer").exists()).toBe(false);
    expect(tabButton(w, "任务").classes()).toContain("active");

    // 关闭:点击既有 tab 回打开前的原始事件视图
    await tabButton(w, "原始事件").trigger("click");
    await nextTick();
    expect(w.find('[data-test="task-center-view"]').exists()).toBe(false);
    expect(w.find("raw-output-viewer-stub").exists()).toBe(true);
    expect(w.find(".center-composer").exists()).toBe(true);
  });

  it("team 模式下打开中心渲染 TaskCenterView 不落 RawOutputViewer，关闭后回 team split 视图", async () => {
    teamStoreMock.state.teamMode.value = true;
    const w = mountCenterPanel();
    await flushPromises();

    expect(w.find(".team-middle").exists()).toBe(true);
    expect(w.find('[data-test="task-center-view"]').exists()).toBe(false);

    useAgentTaskStore().openTaskCenter();
    await nextTick();
    expect(w.find('[data-test="task-center-view"]').exists()).toBe(true);
    expect(w.find("raw-output-viewer-stub").exists()).toBe(false);
    expect(w.find("session-view-stub").exists()).toBe(false);
    expect(w.find(".team-middle").exists()).toBe(false);
    expect(w.find(".center-composer").exists()).toBe(false);

    await tabButton(w, "会话").trigger("click");
    await nextTick();
    expect(w.find('[data-test="task-center-view"]').exists()).toBe(false);
    expect(w.find(".team-middle").exists()).toBe(true);
    expect(w.find("raw-output-viewer-stub").exists()).toBe(false);
  });
});
