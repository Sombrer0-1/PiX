/**
 * Agent task UI tests (PiX 1.4.1 stage B7; PiX 1.4.2 stage R5 recovery/cleanup).
 *
 * B7 acceptance: waiting/completed/failed notification placement and counts,
 * alert/polite live regions, icon tooltips/accessible names, 300ms busy state
 * and duplicate-submit protection, source/model/cost/queue/slot text, truncated
 * original size + expand, keyboard/aria, group/parent jump, same-workspace
 * result sending, clear confirmation, bounded DOM/stable containers at 500
 * tasks, and WSL hiding the Shell background card. No screenshot assertions.
 *
 * R5 acceptance: interrupted group order (after 需要处理, before 进行中),
 * summary before confirmation, 300ms loading / duplicate-submit protection,
 * workspace/model decisions, 80%/full storage status, recovery issues shown
 * read-only with export/clear entries, single-task clear for interrupted,
 * running tasks refusing clear, clear-all-terminal never deleting
 * interrupted/corrupt records (protectedTaskIds shown), and Plan protection
 * (pending-link tasks cannot be cleared). No screenshot assertions.
 *
 * The component tree talks to main only through window.pixApi
 * (sendAgentTaskCommand / onAgentTaskEvent / onAgentTaskInputRequest) and the
 * mocked stores/composables, so no Electron runtime is loaded; the agent-task
 * store itself is real (Pinia), so the components render real store-driven
 * state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
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
  AgentTaskRecoveryIssue,
  AgentTaskResumeSummary,
  AgentTaskStorageStatus,
} from "@shared/agent-task-types.js";
import type { AgentTaskEvent } from "@shared/types.js";
import type { SubagentDetails } from "@shared/subagent-types.js";
import { useAgentTaskStore } from "../stores/agent-task-store";
import AgentTaskPanel from "../components/agent-task/AgentTaskPanel.vue";
import AgentTaskDetail from "../components/agent-task/AgentTaskDetail.vue";
import AgentTaskInputCard from "../components/agent-task/AgentTaskInputCard.vue";
import AgentTaskNotificationCenter from "../components/agent-task/AgentTaskNotificationCenter.vue";
import SubagentToolView from "../components/session/SubagentToolView.vue";
import RightPanel from "../components/layout/RightPanel.vue";

// ============================================================================
// Mocks (module-level, hoisted) for RightPanel dependencies
// ============================================================================

const rpcMock = vi.hoisted(() => ({
  state: {
    sessionState: { value: null as null | { sessionId?: string; model?: { provider: string; id: string }; thinkingLevel?: string; sessionName?: string; messageCount?: number; goal?: unknown; isCompacting?: boolean } },
    isConnected: { value: true },
    isStreaming: { value: false },
    executionEnvironment: { value: null as null | { kind: "windows" | "wsl"; distro?: string; logicalCwd?: string } },
    lastError: { value: null as string | null },
    getBackgroundTasks: vi.fn().mockResolvedValue([]),
    stopBackgroundTask: vi.fn().mockResolvedValue(undefined),
    mcpGetServers: vi.fn().mockResolvedValue([]),
    compact: vi.fn().mockResolvedValue(undefined),
  },
}));

const projectStoreMock = vi.hoisted(() => ({
  state: {
    currentProject: { value: null },
    currentSession: { value: null },
    currentTeamSession: { value: null },
    sessions: { value: [] as Array<{ id: string; name?: string }> },
  },
}));

const teamStoreMock = vi.hoisted(() => ({
  state: {
    teamMode: { value: false },
  },
}));

vi.mock("../composables/useWorkspaceRpc", () => ({
  useWorkspaceRpc: () => ({
    sessionState: rpcMock.state.sessionState,
    isConnected: rpcMock.state.isConnected,
    isStreaming: rpcMock.state.isStreaming,
    executionEnvironment: rpcMock.state.executionEnvironment,
    lastError: rpcMock.state.lastError,
    getBackgroundTasks: rpcMock.state.getBackgroundTasks,
    stopBackgroundTask: rpcMock.state.stopBackgroundTask,
    mcpGetServers: rpcMock.state.mcpGetServers,
    compact: rpcMock.state.compact,
  }),
}));

vi.mock("../stores/project-store", () => ({
  useProjectStore: () => ({
    currentProject: projectStoreMock.state.currentProject.value,
    currentSession: projectStoreMock.state.currentSession.value,
    currentTeamSession: projectStoreMock.state.currentTeamSession.value,
    sessions: projectStoreMock.state.sessions.value,
  }),
}));

vi.mock("../stores/team-store", () => ({
  useTeamStore: () => ({
    teamMode: teamStoreMock.state.teamMode.value,
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

function makeInputRequest(overrides?: Partial<AgentTaskInputRequest>): AgentTaskInputRequest {
  return {
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

function makeResumeSummary(overrides?: Partial<AgentTaskResumeSummary>): AgentTaskResumeSummary {
  return {
    taskId: "task-1",
    generation: 0,
    openToolCalls: [],
    modelChanged: false,
    environmentChanged: false,
    workspaceChanges: [],
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
let wrapper: ReturnType<typeof mount> | undefined;

function installPixApiMock(): void {
  taskCounter = 0;
  agentTaskEventCallback = null;
  inputRequestCallback = null;
  sendAgentTaskCommand = vi.fn().mockResolvedValue({ success: true });
  onAgentTaskEvent = vi.fn((callback: (event: AgentTaskEvent) => void) => {
    agentTaskEventCallback = callback;
    return () => {};
  });
  onAgentTaskInputRequest = vi.fn((callback: (request: AgentTaskInputRequest) => void) => {
    inputRequestCallback = callback;
    return () => {};
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

function mountPanel(): ReturnType<typeof mount> {
  const pinia = createPinia();
  setActivePinia(pinia);
  wrapper = mount(AgentTaskPanel, {
    props: { currentSessionId: "session-1", sessionNames: { "session-1": "会话一" } },
    global: { plugins: [pinia, vuetify] },
  });
  return wrapper;
}

beforeEach(() => {
  rpcMock.state.sessionState.value = null;
  rpcMock.state.isConnected.value = true;
  rpcMock.state.isStreaming.value = false;
  rpcMock.state.executionEnvironment.value = null;
  rpcMock.state.lastError.value = null;
  rpcMock.state.getBackgroundTasks.mockResolvedValue([]);
  rpcMock.state.mcpGetServers.mockResolvedValue([]);
  projectStoreMock.state.sessions.value = [];
  teamStoreMock.state.teamMode.value = false;
  installPixApiMock();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.useRealTimers();
});

// ============================================================================
// AgentTaskPanel
// ============================================================================

describe("AgentTaskPanel", () => {
  it("renders three groups with stable status text and source/model/cost/queue/slot meta", async () => {
    const w = mountPanel();
    await flushPromises();

    emit({ type: "task_state", task: makeTask({ taskId: "wait-1", status: "waiting_input", startedAt: 1 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "queue-1", status: "queued", queuePosition: 2, description: "Queued task" }) });
    emit({ type: "task_state", task: makeTask({ taskId: "run-1", status: "running", startedAt: 1, description: "Running task" }) });
    emit({ type: "task_state", task: makeTask({ taskId: "done-1", status: "completed", endedAt: 5, description: "Done task", usage: makeUsage({ cost: 1.23 }) }) });
    await nextTick();

    expect(w.find('[data-test="agent-task-counts"]').text()).toContain("需要处理 1");
    expect(w.find('[data-test="agent-task-counts"]').text()).toContain("进行中 2");
    expect(w.find('[data-test="agent-task-counts"]').text()).toContain("最近 1");

    const waitRow = w.find('[data-test="agent-task-row-wait-1"]');
    expect(waitRow.find('[data-test="agent-task-status-text"]').text()).toBe("等待输入");
    // waiting_input 占槽提示
    expect(waitRow.find('[data-test="agent-task-slot"]').text()).toBe("占用槽位");

    const queueRow = w.find('[data-test="agent-task-row-queue-1"]');
    expect(queueRow.find('[data-test="agent-task-status-text"]').text()).toBe("排队中");
    expect(queueRow.find('[data-test="agent-task-queue"]').text()).toBe("队列 #2");
    expect(queueRow.find('[data-test="agent-task-agent"]').text()).toBe("general-purpose");

    const doneRow = w.find('[data-test="agent-task-row-done-1"]');
    expect(doneRow.find('[data-test="agent-task-status-text"]').text()).toBe("已完成");
    // 来源/模型/成本文字
    expect(doneRow.find('[data-test="agent-task-source"]').text()).toContain("来源 会话一");
    expect(doneRow.find('[data-test="agent-task-model"]').text()).toContain("模型 anthropic/claude-x");
    expect(doneRow.find('[data-test="agent-task-cost"]').text()).toBe("费用 $1.23");
  });

  it("clear requires a second confirmation and sends confirmDataLoss", async () => {
    const w = mountPanel();
    await flushPromises();
    emit({ type: "task_state", task: makeTask({ taskId: "done-1", status: "completed", endedAt: 5 }) });
    await nextTick();

    // 清除 -> 确认对话框出现（挂载期的 get_all/get_active_input_requests 不算）
    await w.find('[data-test="agent-task-clear-btn"]').trigger("click");
    await nextTick();
    expect(w.find('[data-test="agent-task-clear-confirm"]').exists()).toBe(true);
    expect(taskCalls("clear")).toHaveLength(0);

    // 取消 -> 不发命令
    await w.find('[data-test="agent-task-clear-cancel-btn"]').trigger("click");
    await nextTick();
    expect(w.find('[data-test="agent-task-clear-confirm"]').exists()).toBe(false);
    expect(taskCalls("clear")).toHaveLength(0);

    // 再次清除并确认 -> clear 带 confirmDataLoss: true
    await w.find('[data-test="agent-task-clear-btn"]').trigger("click");
    await nextTick();
    await w.find('[data-test="agent-task-clear-confirm-btn"]').trigger("click");
    await flushPromises();
    const calls = taskCalls("clear");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ taskId: "done-1", generation: 0, confirmDataLoss: true });
  });

  it("keeps the DOM bounded and the containers stable at 500 tasks", async () => {
    const w = mountPanel();
    await flushPromises();

    for (let i = 0; i < 300; i += 1) {
      emit({ type: "task_state", task: makeTask({ taskId: `w-${i}`, status: "waiting_input", startedAt: 1 }) });
    }
    for (let i = 0; i < 150; i += 1) {
      emit({ type: "task_state", task: makeTask({ taskId: `a-${i}`, status: i % 2 === 0 ? "running" : "queued", startedAt: 1, queuePosition: i }) });
    }
    for (let i = 0; i < 60; i += 1) {
      emit({ type: "task_state", task: makeTask({ taskId: `d-${i}`, status: "completed", endedAt: i }) });
    }
    await nextTick();

    // 增量渲染：进行中/需要处理只渲染前 50 行并提供溢出计数；最近完成由 store 封顶 20。
    expect(w.findAll('[data-test^="agent-task-row-"]')).toHaveLength(50 + 50 + 20);
    expect(w.find('[data-test="agent-task-waiting-overflow"]').text()).toContain("还有 250 个任务未显示");
    expect(w.find('[data-test="agent-task-active-overflow"]').text()).toContain("还有 100 个任务未显示");
    expect(w.find('[data-test="agent-task-counts"]').text()).toContain("需要处理 300");
    expect(w.find('[data-test="agent-task-counts"]').text()).toContain("进行中 150");
    expect(w.find('[data-test="agent-task-counts"]').text()).toContain("最近 20");
    // 稳定容器：固定高度滚动列表（增量渲染 + 窗口化，不做虚拟滚动库）。
    const lists = w.findAll(".agent-task-group-list");
    expect(lists.length).toBeGreaterThanOrEqual(2);
    for (const list of lists) {
      expect(list.classes()).toContain("agent-task-group-list");
    }
    expect(w.findAll('[data-test^="agent-task-row-"]').length).toBeLessThan(130);
  });

  it("keeps busy state at least 300ms and rejects duplicate submits", async () => {
    vi.useFakeTimers();
    const w = mountPanel();
    emit({ type: "task_state", task: makeTask({ taskId: "wait-1", status: "waiting_input", startedAt: 1 }) });
    await nextTick();

    const btn = w.find('[data-test="agent-task-cancel-btn"]');
    expect(btn.exists()).toBe(true);
    await btn.trigger("click");
    await btn.trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    // 防重复：两次点击只发一次 cancel。
    expect(taskCalls("cancel")).toHaveLength(1);
    expect(btn.text()).toContain("处理中...");

    await vi.advanceTimersByTimeAsync(300);
    await nextTick();
    expect(btn.text()).not.toContain("处理中...");
  });

  it("exposes keyboard/aria semantics: semantic buttons, aria-expanded and tooltips", async () => {
    const w = mountPanel();
    await flushPromises();
    emit({ type: "task_state", task: makeTask({ taskId: "task-1", status: "running", startedAt: 1, description: "Meta task" }) });
    await nextTick();

    // 面板折叠按钮：语义按钮 + aria-expanded + aria-controls
    const toggle = w.get('[data-test="agent-task-panel-toggle"]');
    expect(toggle.element.tagName).toBe("BUTTON");
    expect(toggle.attributes("aria-expanded")).toBe("true");
    expect(toggle.attributes("aria-controls")).toBe("agent-task-panel-body");
    await toggle.trigger("click");
    await nextTick();
    expect(toggle.attributes("aria-expanded")).toBe("false");

    // 通知选中自动展开面板
    useAgentTaskStore().selectTask("task-1");
    await nextTick();
    expect(toggle.attributes("aria-expanded")).toBe("true");

    // 行主体：语义按钮 + aria-expanded + aria-controls + 图标 tooltip（title 含状态与 agent）
    const rowMain = w.get('[data-test="agent-task-row-task-1"] .agent-task-row-main');
    expect(rowMain.element.tagName).toBe("BUTTON");
    // 经通知选中后行已展开
    expect(rowMain.attributes("aria-expanded")).toBe("true");
    expect(rowMain.attributes("aria-controls")).toBe("agent-task-detail-task-1");
    expect(rowMain.attributes("title")).toContain("运行中");
    expect(rowMain.attributes("title")).toContain("general-purpose");
    expect(w.find('[data-test="agent-task-detail"]').exists()).toBe(true);

    // 点击收起（原生 button，键盘可聚焦/触发）
    await rowMain.trigger("click");
    await nextTick();
    expect(w.get('[data-test="agent-task-row-task-1"] .agent-task-row-main').attributes("aria-expanded")).toBe("false");
    expect(w.find('[data-test="agent-task-detail"]').exists()).toBe(false);

    // 再次点击重新展开详情
    await w.get('[data-test="agent-task-row-task-1"] .agent-task-row-main').trigger("click");
    await nextTick();
    expect(w.get('[data-test="agent-task-row-task-1"] .agent-task-row-main').attributes("aria-expanded")).toBe("true");
    expect(w.find('[data-test="agent-task-detail"]').exists()).toBe(true);
  });
});

// ============================================================================
// AgentTaskPanel recovery/cleanup (1.4.2 R5)
// ============================================================================

describe("AgentTaskPanel recovery/cleanup (1.4.2 R5)", () => {
  it("renders the interrupted group between 需要处理 and 进行中, with resume/mark-failed/clear row actions", async () => {
    const w = mountPanel();
    await flushPromises();

    emit({ type: "task_state", task: makeTask({ taskId: "wait-1", status: "waiting_input", startedAt: 1 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "int-1", status: "interrupted", description: "Interrupted task" }) });
    emit({ type: "task_state", task: makeTask({ taskId: "run-1", status: "running", startedAt: 1 }) });
    await nextTick();

    // 计数与分组顺序：已中断在「需要处理」之后、「进行中」之前
    expect(w.find('[data-test="agent-task-counts"]').text()).toContain("已中断 1");
    const waiting = w.get('[data-test="agent-task-group-waiting"]').element;
    const interrupted = w.get('[data-test="agent-task-group-interrupted"]').element;
    const active = w.get('[data-test="agent-task-group-active"]').element;
    expect(waiting.compareDocumentPosition(interrupted) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(interrupted.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const intRow = w.get('[data-test="agent-task-row-int-1"]');
    expect(intRow.find('[data-test="agent-task-status-text"]').text()).toBe("已中断");
    expect(intRow.find(".agent-task-desc").text()).toContain("Interrupted task");
    // 行内操作：续接 / 标记失败 / 清除；不显示运行中进度
    expect(intRow.find('[data-test="agent-task-row-resume-btn"]').exists()).toBe(true);
    expect(intRow.find('[data-test="agent-task-row-mark-failed-btn"]').exists()).toBe(true);
    expect(intRow.find('[data-test="agent-task-clear-btn"]').exists()).toBe(true);
    expect(intRow.find('[data-test="agent-task-slot"]').exists()).toBe(false);
    // 中断任务不混入最近完成
    expect(w.find('[data-test="agent-task-group-recent"]').exists()).toBe(false);
  });

  it("shows the 80% warning and the full-storage banner with a cleanup entry", async () => {
    const w = mountPanel();
    await flushPromises();

    emit({ type: "storage_status", status: makeStorageStatus({ usedBytes: 800, reservedBytes: 0, limitBytes: 1000, level: "warning" }) });
    await nextTick();
    const warning = w.get('[data-test="agent-task-storage-warning"]');
    expect(warning.text()).toContain("80%");
    expect(warning.text()).toContain("建议清理");

    emit({ type: "storage_status", status: makeStorageStatus({ usedBytes: 1000, reservedBytes: 0, limitBytes: 1000, level: "full" }) });
    await nextTick();
    const full = w.get('[data-test="agent-task-storage-full"]');
    expect(full.text()).toContain("无法启动新任务");
    // 超限拒绝启动 + 清理入口：打开所有终态清理确认
    await full.get('[data-test="agent-task-storage-clean-btn"]').trigger("click");
    await nextTick();
    expect(w.find('[data-test="agent-task-clear-all-confirm"]').exists()).toBe(true);
  });

  it("renders recovery issues read-only with export and clear entries", async () => {
    vi.useFakeTimers();
    const w = mountPanel();
    await flushPromises();

    emit({
      type: "recovery_issue",
      issue: makeRecoveryIssue({ taskId: "corrupt-1", code: "unknown_schema", message: "未知 schema 版本，只读展示", readOnly: true }),
    });
    await nextTick();

    const issueRow = w.get('[data-test="agent-task-issue-corrupt-1"]');
    expect(issueRow.find('[data-test="agent-task-issue-code"]').text()).toBe("未知 schema 版本");
    expect(issueRow.find('[data-test="agent-task-issue-readonly"]').text()).toBe("只读");
    // 只读诊断：没有续接/运行控件，不影响其他任务行
    expect(issueRow.find('[data-test="agent-task-row-resume-btn"]').exists()).toBe(false);
    expect(issueRow.find('[data-test="agent-task-resume-btn"]').exists()).toBe(false);

    // 导出诊断（300ms 忙碌期内防重复）
    await issueRow.get('[data-test="agent-task-issue-export-btn"]').trigger("click");
    await issueRow.get('[data-test="agent-task-issue-export-btn"]').trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();
    let calls = taskCalls("export_diagnostics");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ taskId: "corrupt-1" });
    await vi.advanceTimersByTimeAsync(300);
    await nextTick();

    // 清理 -> 二次确认 -> clear 命令（confirmDataLoss）
    await issueRow.get('[data-test="agent-task-issue-clear-btn"]').trigger("click");
    await nextTick();
    expect(w.find('[data-test="agent-task-clear-confirm"]').exists()).toBe(true);
    await w.get('[data-test="agent-task-clear-confirm-btn"]').trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();
    calls = taskCalls("clear");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ taskId: "corrupt-1", generation: 0, confirmDataLoss: true });
  });

  it("clears an interrupted task after confirmation (single-task cleanup)", async () => {
    const w = mountPanel();
    await flushPromises();
    emit({ type: "task_state", task: makeTask({ taskId: "int-1", status: "interrupted", description: "Interrupted task" }) });
    await nextTick();

    await w.get('[data-test="agent-task-row-int-1"] [data-test="agent-task-clear-btn"]').trigger("click");
    await nextTick();
    expect(w.find('[data-test="agent-task-clear-confirm"]').exists()).toBe(true);
    await w.get('[data-test="agent-task-clear-confirm-btn"]').trigger("click");
    await flushPromises();
    const calls = taskCalls("clear");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ taskId: "int-1", generation: 0, confirmDataLoss: true });
  });

  it("refuses to clear running/queued/waiting_input tasks", async () => {
    const w = mountPanel();
    await flushPromises();
    emit({ type: "task_state", task: makeTask({ taskId: "run-1", status: "running", startedAt: 1 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "queue-1", status: "queued", queuePosition: 1 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "wait-1", status: "waiting_input", startedAt: 1 }) });
    await nextTick();

    // 运行中/排队/等待输入行没有清除按钮，也不会发出 clear
    for (const id of ["run-1", "queue-1", "wait-1"]) {
      expect(w.find(`[data-test="agent-task-row-${id}"] [data-test="agent-task-clear-btn"]`).exists()).toBe(false);
    }
    expect(taskCalls("clear")).toHaveLength(0);
  });

  it("protects pending-link tasks from clearing (Plan protection)", async () => {
    const w = mountPanel();
    await flushPromises();
    emit({
      type: "task_state",
      task: makeTask({
        taskId: "done-1",
        status: "completed",
        endedAt: 5,
        planLink: { planId: "plan-1", version: 1, stepId: "step-1" },
        planLinkState: "pending",
      }),
    });
    await nextTick();

    const clearBtn = w.get('[data-test="agent-task-row-done-1"] [data-test="agent-task-clear-btn"]');
    expect(clearBtn.attributes("disabled")).toBeDefined();
    expect(clearBtn.attributes("title")).toContain("计划尚未消费结果");
    await clearBtn.trigger("click");
    await nextTick();
    // 不打开确认、不发命令
    expect(w.find('[data-test="agent-task-clear-confirm"]').exists()).toBe(false);
    expect(taskCalls("clear")).toHaveLength(0);
  });

  it("clear-all terminal never deletes interrupted/corrupt records and reports protectedTaskIds", async () => {
    const w = mountPanel();
    await flushPromises();
    emit({ type: "task_state", task: makeTask({ taskId: "done-1", status: "completed", endedAt: 5 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "int-1", status: "interrupted" }) });
    await nextTick();

    await w.get('[data-test="agent-task-clear-all-btn"]').trigger("click");
    await nextTick();
    expect(w.find('[data-test="agent-task-clear-all-confirm"]').text()).toContain("已中断与恢复数据损坏记录不会被删除");

    sendAgentTaskCommand.mockResolvedValue({
      success: true,
      data: { cleared: 1, protectedTaskIds: ["int-1", "corrupt-1"] },
    });
    await w.get('[data-test="agent-task-clear-all-confirm-btn"]').trigger("click");
    await flushPromises();

    const calls = taskCalls("clear_all_terminal");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ confirm: true });

    // 明示未删除的记录：已中断与损坏记录出现在保护列表中
    const result = w.get('[data-test="agent-task-clear-all-result"]');
    expect(result.text()).toContain("已清理 1 个任务");
    const protectedText = result.find('[data-test="agent-task-clear-all-protected"]').text();
    expect(protectedText).toContain("int-1");
    expect(protectedText).toContain("corrupt-1");
  });

  it("marks an interrupted task failed from the row action", async () => {
    const w = mountPanel();
    await flushPromises();
    emit({ type: "task_state", task: makeTask({ taskId: "int-1", status: "interrupted" }) });
    await nextTick();

    await w.get('[data-test="agent-task-row-int-1"] [data-test="agent-task-row-mark-failed-btn"]').trigger("click");
    await flushPromises();
    const calls = taskCalls("mark_failed");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ taskId: "int-1", generation: 0 });
  });

  it("row resume expands the detail and starts summary-before-confirm exactly once", async () => {
    vi.useFakeTimers();
    const w = mountPanel();
    emit({ type: "task_state", task: makeTask({ taskId: "int-1", status: "interrupted", description: "Interrupted" }) });
    await nextTick();

    sendAgentTaskCommand.mockResolvedValue({
      success: true,
      data: makeResumeSummary({ openToolCalls: [{ toolCallId: "tc-1", toolName: "bash", startedAt: 100 }] }),
    });

    // 双击防重复：只取一次摘要
    await w.get('[data-test="agent-task-row-resume-btn"]').trigger("click");
    await w.get('[data-test="agent-task-row-resume-btn"]').trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    const calls = taskCalls("get_resume_summary");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ taskId: "int-1", generation: 0 });
    // 详情展开且摘要先于确认：确认面板出现，但 resume 尚未发出
    expect(w.find('[data-test="agent-task-detail"]').exists()).toBe(true);
    expect(w.find('[data-test="agent-task-resume-summary"]').text()).toContain("bash");
    expect(w.find('[data-test="agent-task-resume-confirm"]').exists()).toBe(true);
    expect(taskCalls("resume")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(300);
    await nextTick();
  });

  it("consumes the one-time resume intent: expanding later does not auto-trigger the resume flow", async () => {
    vi.useFakeTimers();
    const w = mountPanel();
    emit({ type: "task_state", task: makeTask({ taskId: "int-1", status: "interrupted" }) });
    await nextTick();

    sendAgentTaskCommand.mockResolvedValue({ success: true, data: makeResumeSummary() });
    // 行内「续接」→ 详情挂载消费意图并自动开始「摘要→确认」流程
    await w.get('[data-test="agent-task-row-resume-btn"]').trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();
    expect(taskCalls("get_resume_summary")).toHaveLength(1);
    expect(w.find('[data-test="agent-task-resume-confirm"]').exists()).toBe(true);

    // 取消并收起详情（意图已消费：仅展开查看不再自动重新触发续接流程）
    await vi.advanceTimersByTimeAsync(300);
    await nextTick();
    await w.get('[data-test="agent-task-resume-cancel-btn"]').trigger("click");
    await nextTick();
    useAgentTaskStore().selectTask(null);
    await nextTick();
    expect(w.find('[data-test="agent-task-detail"]').exists()).toBe(false);

    useAgentTaskStore().selectTask("int-1");
    await nextTick();
    expect(w.find('[data-test="agent-task-detail"]').exists()).toBe(true);
    expect(w.find('[data-test="agent-task-resume-summary"]').exists()).toBe(false);
    expect(w.find('[data-test="agent-task-resume-confirm"]').exists()).toBe(false);
    expect(taskCalls("get_resume_summary")).toHaveLength(1);

    // 用户再次主动点「续接」仍然可用（重新赋值意图）
    await w.get('[data-test="agent-task-row-resume-btn"]').trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();
    expect(taskCalls("get_resume_summary")).toHaveLength(2);
    expect(w.find('[data-test="agent-task-resume-confirm"]').exists()).toBe(true);

    await vi.advanceTimersByTimeAsync(300);
    await nextTick();
  });
});

// ============================================================================
// AgentTaskDetail
// ============================================================================

describe("AgentTaskDetail", () => {
  function mountDetail(task: AgentTaskInfo, extraProps?: Record<string, unknown>): ReturnType<typeof mount> {
    const pinia = createPinia();
    setActivePinia(pinia);
    wrapper = mount(AgentTaskDetail, {
      props: {
        id: `agent-task-detail-${task.taskId}`,
        task,
        currentSessionId: "session-2",
        currentProjectPhysicalPath: "/project",
        sessionNames: { "session-1": "会话一", "session-2": "当前会话" },
        ...extraProps,
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
    // 固定高度滚动容器（有界活动列表）
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
    expect(w.find('[data-test="agent-task-detail-source"]').text()).toContain("来源 会话一");
  });

  it("sends the result to the source and the current same-workspace sessions", async () => {
    vi.useFakeTimers();
    const task = makeTask({
      taskId: "task-1",
      status: "completed",
      endedAt: 5,
      finalOutput: "the result",
      parentSessionId: "session-1",
    });
    const w = mountDetail(task);
    await nextTick();

    // 发送到来源会话
    await w.get('[data-test="agent-task-send-source-btn"]').trigger("click");
    await vi.advanceTimersByTimeAsync(300);
    await nextTick();
    let calls = taskCalls("send_to_session");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ taskId: "task-1", generation: 0, targetSessionId: "session-1" });

    // 发送到当前会话（同 workspace，与来源不同）
    await w.get('[data-test="agent-task-send-current-btn"]').trigger("click");
    await vi.advanceTimersByTimeAsync(300);
    await nextTick();
    calls = taskCalls("send_to_session");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ taskId: "task-1", generation: 0, targetSessionId: "session-2" });
  });

  it("requires confirmation before a duplicate delivery to the same session", async () => {
    const task = makeTask({
      taskId: "task-1",
      status: "completed",
      endedAt: 5,
      finalOutput: "the result",
      deliveredSessionIds: ["session-1"],
    });
    const w = mountDetail(task);
    await nextTick();

    // 已发送过的目标：点击进入二次确认
    await w.get('[data-test="agent-task-send-source-btn"]').trigger("click");
    await nextTick();
    expect(w.find('[data-test="agent-task-send-confirm"]').exists()).toBe(true);
    expect(sendAgentTaskCommand).not.toHaveBeenCalled();

    // 取消 -> 不发命令
    await w.get('[data-test="agent-task-send-cancel-btn"]').trigger("click");
    await nextTick();
    expect(sendAgentTaskCommand).not.toHaveBeenCalled();

    // 再次点击并确认 -> confirmDuplicate: true
    await w.get('[data-test="agent-task-send-source-btn"]').trigger("click");
    await nextTick();
    await w.get('[data-test="agent-task-send-confirm-btn"]').trigger("click");
    await flushPromises();
    const calls = taskCalls("send_to_session");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ taskId: "task-1", generation: 0, targetSessionId: "session-1", confirmDuplicate: true });
  });

  it("keeps send busy at least 300ms and rejects duplicate submits", async () => {
    vi.useFakeTimers();
    const task = makeTask({
      taskId: "task-1",
      status: "completed",
      endedAt: 5,
      finalOutput: "the result",
    });
    const w = mountDetail(task);
    await nextTick();

    const btn = w.get('[data-test="agent-task-send-source-btn"]');
    await btn.trigger("click");
    await btn.trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    expect(taskCalls("send_to_session")).toHaveLength(1);
    expect(btn.text()).toContain("处理中...");

    await vi.advanceTimersByTimeAsync(300);
    await nextTick();
    expect(btn.text()).not.toContain("处理中...");
  });

  it("emits clear for the panel to open its second confirmation", async () => {
    const task = makeTask({ taskId: "task-1", status: "completed", endedAt: 5 });
    const w = mountDetail(task);
    await nextTick();

    await w.get('[data-test="agent-task-detail-clear-btn"]').trigger("click");
    const events = w.emitted("clear");
    expect(events).toBeTruthy();
    expect((events as Array<Array<AgentTaskInfo>>)[0][0].taskId).toBe("task-1");
  });

  it("refuses to clear a running task from the detail", async () => {
    const task = makeTask({ taskId: "run-1", status: "running", startedAt: 1 });
    const w = mountDetail(task);
    await nextTick();

    const clearBtn = w.get('[data-test="agent-task-detail-clear-btn"]');
    expect(clearBtn.attributes("disabled")).toBeDefined();
    await clearBtn.trigger("click");
    expect(w.emitted("clear")).toBeFalsy();
    expect(taskCalls("clear")).toHaveLength(0);
  });

  it("shows the Plan protection hint and disables clear for pending-link tasks", async () => {
    const task = makeTask({
      taskId: "done-1",
      status: "completed",
      endedAt: 5,
      planLink: { planId: "plan-1", version: 1, stepId: "step-1" },
      planLinkState: "pending",
    });
    const w = mountDetail(task);
    await nextTick();

    expect(w.find('[data-test="agent-task-plan-protected"]').exists()).toBe(true);
    expect(w.find('[data-test="agent-task-plan-protected"]').text()).toContain("清理被保护");
    const clearBtn = w.get('[data-test="agent-task-detail-clear-btn"]');
    expect(clearBtn.attributes("disabled")).toBeDefined();
    expect(clearBtn.attributes("title")).toContain("计划尚未消费结果");
    await clearBtn.trigger("click");
    expect(w.emitted("clear")).toBeFalsy();
  });
});

// ============================================================================
// AgentTaskDetail recovery (1.4.2 R5)
// ============================================================================

describe("AgentTaskDetail recovery (1.4.2 R5)", () => {
  function mountInterruptedDetail(taskId = "int-1"): ReturnType<typeof mount> {
    const pinia = createPinia();
    setActivePinia(pinia);
    wrapper = mount(AgentTaskDetail, {
      props: {
        id: `agent-task-detail-${taskId}`,
        task: makeTask({ taskId, status: "interrupted", description: "Interrupted task" }),
        currentSessionId: "session-2",
        sessionNames: { "session-1": "会话一" },
      },
      global: { plugins: [pinia, vuetify] },
    });
    return wrapper;
  }

  it("keeps summary busy at least 300ms and rejects duplicate submits", async () => {
    vi.useFakeTimers();
    const w = mountInterruptedDetail();
    await nextTick();

    sendAgentTaskCommand.mockResolvedValue({ success: true, data: makeResumeSummary() });
    const summaryBtn = w.get('[data-test="agent-task-summary-btn"]');
    await summaryBtn.trigger("click");
    await summaryBtn.trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    expect(taskCalls("get_resume_summary")).toHaveLength(1);
    expect(summaryBtn.text()).toContain("处理中...");
    expect(w.find('[data-test="agent-task-resume-summary"]').exists()).toBe(true);

    await vi.advanceTimersByTimeAsync(300);
    await nextTick();
    expect(summaryBtn.text()).not.toContain("处理中...");
  });

  it("shows the summary before any resume decision and requires workspace confirmation", async () => {
    vi.useFakeTimers();
    const w = mountInterruptedDetail();
    await nextTick();

    sendAgentTaskCommand.mockResolvedValue({
      success: true,
      data: makeResumeSummary({
        workspaceChanges: ["src/app.ts（已修改）", "README.md（已删除）"],
        modelChanged: true,
      }),
    });
    await w.get('[data-test="agent-task-resume-btn"]').trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    // 摘要先于确认：先取得摘要，resume 尚未发出
    expect(taskCalls("get_resume_summary")).toHaveLength(1);
    expect(taskCalls("resume")).toHaveLength(0);

    const summaryBox = w.get('[data-test="agent-task-resume-summary"]');
    expect(summaryBox.find('[data-test="agent-task-summary-workspace-changes"]').text()).toContain("src/app.ts");
    expect(summaryBox.find('[data-test="agent-task-summary-model-changed"]').exists()).toBe(true);

    // 未确认工作区变化：确认按钮禁用，点击不会发 resume
    const confirmBtn = w.get('[data-test="agent-task-resume-confirm-btn"]');
    expect(confirmBtn.attributes("disabled")).toBeDefined();
    await confirmBtn.trigger("click");
    expect(taskCalls("resume")).toHaveLength(0);

    // 300ms 忙碌结束；勾选确认后发起 continue 决策
    await vi.advanceTimersByTimeAsync(300);
    await nextTick();
    await w.get('[data-test="agent-task-confirm-workspace"]').setValue(true);
    await nextTick();
    await w.get('[data-test="agent-task-resume-confirm-btn"]').trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    const resumeCalls = taskCalls("resume");
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0]).toMatchObject({
      taskId: "int-1",
      generation: 0,
      decision: { action: "continue", confirmWorkspaceChanges: true },
    });
    // 调用顺序：摘要一定在 resume 之前
    const summaryIndex = sendAgentTaskCommand.mock.calls.findIndex(([c]) => c.type === "get_resume_summary");
    const resumeIndex = sendAgentTaskCommand.mock.calls.findIndex(([c]) => c.type === "resume");
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(resumeIndex).toBeGreaterThan(summaryIndex);
  });

  it("lets the user pick a new model before resuming (switch_model decision)", async () => {
    vi.useFakeTimers();
    const w = mountInterruptedDetail();
    await nextTick();

    sendAgentTaskCommand.mockResolvedValue({
      success: true,
      data: makeResumeSummary({ modelChanged: true }),
    });
    await w.get('[data-test="agent-task-resume-btn"]').trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    // 模型决策：默认沿用原模型，不显示模型输入
    expect(w.find('[data-test="agent-task-model-inputs"]').exists()).toBe(false);
    await w.get('[data-test="agent-task-model-switch"]').setValue("switch");
    await nextTick();
    expect(w.find('[data-test="agent-task-model-inputs"]').exists()).toBe(true);

    // 模型输入为空：确认按钮禁用（不静默替换）
    expect(w.get('[data-test="agent-task-resume-confirm-btn"]').attributes("disabled")).toBeDefined();

    await w.get('[data-test="agent-task-model-provider"]').setValue("openai");
    await w.get('[data-test="agent-task-model-id"]').setValue("gpt-4o");
    await nextTick();
    await vi.advanceTimersByTimeAsync(300);
    await nextTick();

    await w.get('[data-test="agent-task-resume-confirm-btn"]').trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    const resumeCalls = taskCalls("resume");
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0]).toMatchObject({
      taskId: "int-1",
      generation: 0,
      decision: { action: "switch_model", provider: "openai", modelId: "gpt-4o", confirmWorkspaceChanges: false },
    });
  });

  it("marks an interrupted task failed on user decision", async () => {
    const w = mountInterruptedDetail();
    await nextTick();

    await w.get('[data-test="agent-task-mark-failed-btn"]').trigger("click");
    await flushPromises();
    const calls = taskCalls("mark_failed");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ taskId: "int-1", generation: 0 });
  });

  it("shows the resume failure reason in the recovery error region when main rejects the resume", async () => {
    vi.useFakeTimers();
    const w = mountInterruptedDetail();
    await nextTick();

    sendAgentTaskCommand.mockResolvedValue({ success: true, data: makeResumeSummary() });
    await w.get('[data-test="agent-task-resume-btn"]').trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    // main 拒绝 resume（如 storage_limit / workspace_unavailable）：原因必须展示，任务保持 interrupted 可重试
    await vi.advanceTimersByTimeAsync(300);
    await nextTick();
    sendAgentTaskCommand.mockResolvedValue({ success: false, error: "存储空间不足，无法续接", code: "storage_limit" });
    await w.get('[data-test="agent-task-resume-confirm-btn"]').trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    const resumeCalls = taskCalls("resume");
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0]).toMatchObject({
      taskId: "int-1",
      generation: 0,
      decision: { action: "continue", confirmWorkspaceChanges: false },
    });
    // runRecoveryBusy 在最小忙碌时长结束后才返回结果：错误原因随后展示
    await vi.advanceTimersByTimeAsync(300);
    await nextTick();
    const err = w.get('[data-test="agent-task-summary-error"]');
    expect(err.attributes("role")).toBe("alert");
    expect(err.text()).toContain("存储空间不足，无法续接");
    // 失败后对话框保留，可再次确认重试
    expect(w.find('[data-test="agent-task-resume-confirm"]').exists()).toBe(true);
  });
});

// ============================================================================
// AgentTaskInputCard
// ============================================================================

describe("AgentTaskInputCard", () => {
  function mountCard(request: AgentTaskInputRequest): ReturnType<typeof mount> {
    const pinia = createPinia();
    setActivePinia(pinia);
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
          { id: "q1", question: "One?" },
          { id: "q2", question: "Two?" },
          { id: "q3", question: "Three?" },
          { id: "q4", question: "Four?" },
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
    expect(calls[0].response.answers).toEqual({ q1: "a", q2: "b", q3: "c", q4: "d" });
  });
});

// ============================================================================
// AgentTaskNotificationCenter
// ============================================================================

describe("AgentTaskNotificationCenter", () => {
  function mountCenter(): { wrapper: ReturnType<typeof mount>; store: ReturnType<typeof useAgentTaskStore> } {
    const pinia = createPinia();
    setActivePinia(pinia);
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

  it("clicking a notification selects and expands the task", async () => {
    const { wrapper: w, store } = mountCenter();
    await flushPromises();
    emit({ type: "task_state", task: makeTask({ taskId: "done-1", status: "completed", endedAt: 5, description: "Finished job" }) });
    await nextTick();

    await w.get('[data-test="agent-task-notification-done-1"]').trigger("click");
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
    const pinia = createPinia();
    setActivePinia(pinia);
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

  it("jumps to the task by selecting it in the agent-task store", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAgentTaskStore();
    wrapper = mount(SubagentToolView, {
      props: { result: { details: GROUP_HANDLE }, args: {}, isError: false },
      global: { plugins: [pinia, vuetify] },
    });
    await nextTick();

    await wrapper.get('[data-test="agent-task-jump-task-bg-1"] [data-test="agent-task-jump-btn"]').trigger("click");
    expect(store.selectedTaskId).toBe("task-bg-1");
  });

  it("keeps rendering foreground SubagentDetails results (case 1 regression)", async () => {
    const w = mountView({ details: FOREGROUND_DETAILS }, {});
    await nextTick();

    expect(w.find('[data-test="agent-task-group-handle"]').exists()).toBe(false);
    expect(w.find(".subagent-output").exists()).toBe(true);
    expect(w.find(".subagent-output").text()).toContain("done");
  });
});

// ============================================================================
// RightPanel integration: AgentTask entry, notification placement, WSL hiding
// ============================================================================

describe("RightPanel integration", () => {
  function mountRightPanel(): ReturnType<typeof mount> {
    const pinia = createPinia();
    setActivePinia(pinia);
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

  it("mounts the Agent task entry with the notification center above the Shell background card", async () => {
    rpcMock.state.sessionState.value = { sessionId: "session-1" };
    rpcMock.state.getBackgroundTasks.mockResolvedValue([
      { taskId: "bg-1", command: "npm run build", startedAt: Date.now() - 5000, status: "running" },
    ]);
    const w = mountRightPanel();
    await flushPromises();

    // AgentTask 入口/面板/通知中心已挂载
    expect(w.find('[data-test="agent-task-panel"]').exists()).toBe(true);
    expect(w.find('[data-test="agent-task-notification-center"]').exists()).toBe(true);

    // 通知中心位于 Shell 后台任务卡片上方
    const notification = w.find('[data-test="agent-task-notification-center"]').element;
    const shellList = w.find(".bg-task-list").element;
    const position = notification.compareDocumentPosition(shellList);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 面板可以展示真实 store 状态（来源会话名来自 projectStore.sessions）
    emit({ type: "task_state", task: makeTask({ taskId: "run-1", status: "running", startedAt: 1 }) });
    await nextTick();
    expect(w.find('[data-test="agent-task-row-run-1"]').exists()).toBe(true);
    expect(w.find('[data-test="agent-task-row-run-1"]').find('[data-test="agent-task-source"]').text()).toContain("来源 session-1");
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
    expect(w.find('[data-test="agent-task-panel"]').exists()).toBe(true);
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
    expect(w.find('[data-test="agent-task-panel"]').exists()).toBe(true);
  });
});
