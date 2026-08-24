/**
 * BTW (/btw side-question) UI tests (PiX 1.5.0, stage S4B).
 *
 * Acceptance: CenterPanel.sendMessage /btw interception (hit / miss / team
 * mode bypass / usage + over-long hints), the useBtw state machine
 * (loading -> answered / failed, aborted discard, retry, close, destroy on
 * sendMessage, elapsed timer), paletteCommands merge (solo injects a local
 * builtin /btw entry and dedupes; team does not inject), and the BtwCard
 * render contract (title / footer format / retry button).
 *
 * The component tree talks to main only through window.pixApi (btwAsk /
 * btwCancel plus the plan/workflow/chat channels) and the mocked composables
 * / stores, so no Electron runtime is loaded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h, type PropType } from "vue";
import { components as vuetifyComponents, createVuetify, directives as vuetifyDirectives } from "vuetify/dist/vuetify.js";
import type { PixApi } from "../../main/preload";
import type { BtwAskResult, RpcSlashCommand } from "@shared/types.js";
import CenterPanel from "../components/layout/CenterPanel.vue";
import BtwCard from "../components/input/BtwCard.vue";
import { useBtw } from "../composables/useBtw";
import { renderMarkdown } from "../utils/markdown";

// ============================================================================
// Mocks (module-level, hoisted)
// ============================================================================

const rpcMock = vi.hoisted(() => ({
  state: {
    sessionState: { value: null },
    isConnected: { value: true },
    isStreaming: { value: false },
    executionEnvironment: { value: null },
    commands: { value: [] as RpcSlashCommand[] },
    availableModels: { value: [] as Array<{ provider: string; id: string }> },
    sendCommandAsync: vi.fn().mockResolvedValue(undefined),
    setPiSetting: vi.fn().mockResolvedValue(undefined),
    refreshState: vi.fn().mockResolvedValue(undefined),
    exportHtml: vi.fn().mockResolvedValue(null),
    exportJsonl: vi.fn().mockResolvedValue(null),
    forkSession: vi.fn().mockResolvedValue({ cancelled: false }),
    getMessages: vi.fn().mockResolvedValue([]),
    abort: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn().mockResolvedValue(null),
  },
}));

const sessionMock = vi.hoisted(() => ({
  state: {
    displayBlocks: { value: [] as Array<{ type: string }> },
    isStreaming: { value: false },
    lastRetryableError: { value: null },
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
    currentSession: { value: null },
    currentTeamSession: { value: null },
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
    teamName: { value: null },
    lastError: { value: null },
    toggleTeamMode: vi.fn().mockResolvedValue(true),
  },
}));

const settingsStoreMock = vi.hoisted(() => ({
  state: {
    settings: { value: {} },
  },
}));

vi.mock("../composables/useWorkspaceRpc", () => ({
  useWorkspaceRpc: () => ({
    sessionState: rpcMock.state.sessionState,
    isConnected: rpcMock.state.isConnected,
    isStreaming: rpcMock.state.isStreaming,
    executionEnvironment: rpcMock.state.executionEnvironment,
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
    sendCommand: rpcMock.state.sendCommand,
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

// ============================================================================
// Harness: stub window.pixApi + CommandPalette capture stub
// ============================================================================

const vuetify = createVuetify({
  components: { ...vuetifyComponents },
  directives: { ...vuetifyDirectives },
});

/** CommandPalette stub exposing the commands prop for paletteCommands asserts. */
const CommandPaletteStub = defineComponent({
  name: "CommandPalette",
  props: {
    search: { type: String, default: "" },
    commands: { type: Array as PropType<RpcSlashCommand[]>, default: () => [] },
  },
  emits: ["select", "close"],
  setup(props) {
    return () =>
      h("div", { class: "palette-stub", "data-names": props.commands.map((command) => command.name).join(",") });
  },
});

let btwAsk: ReturnType<typeof vi.fn>;
let btwCancel: ReturnType<typeof vi.fn>;
let sendPlanCommand: ReturnType<typeof vi.fn>;
let onPlanEvent: ReturnType<typeof vi.fn>;
let sendWorkflowCommand: ReturnType<typeof vi.fn>;
let onWorkflowEvent: ReturnType<typeof vi.fn>;
let selectChatFiles: ReturnType<typeof vi.fn>;
let planEventCallback: ((event: unknown) => void) | null;
let wrapper: ReturnType<typeof mount> | undefined;

function installPixApiMock(): void {
  planEventCallback = null;
  btwAsk = vi.fn().mockResolvedValue({ status: "answered", answer: "ok" });
  btwCancel = vi.fn();
  sendPlanCommand = vi.fn().mockResolvedValue({ success: true });
  onPlanEvent = vi.fn((callback: (event: unknown) => void) => {
    planEventCallback = callback;
    return () => {};
  });
  sendWorkflowCommand = vi.fn().mockResolvedValue({ success: true, data: [] });
  onWorkflowEvent = vi.fn(() => () => {});
  selectChatFiles = vi.fn().mockResolvedValue([]);
  window.pixApi = {
    btwAsk,
    btwCancel,
    sendPlanCommand,
    onPlanEvent,
    sendWorkflowCommand,
    onWorkflowEvent,
    selectChatFiles,
  } as unknown as PixApi;
}

/** Make the current btwAsk mock hold its resolution until the test resolves it. */
function deferBtwAsk(): { resolve: (result: BtwAskResult) => void } {
  const deferred: { resolve: (result: BtwAskResult) => void } = { resolve: () => {} };
  btwAsk.mockImplementation(
    () => new Promise<BtwAskResult>((resolve) => {
      deferred.resolve = resolve;
    }),
  );
  return deferred;
}

function mountPanel(): ReturnType<typeof mount> {
  const pinia = createPinia();
  setActivePinia(pinia);
  wrapper = mount(CenterPanel, {
    attachTo: document.body,
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
        CommandPalette: CommandPaletteStub,
        ModelSelector: true,
        ThinkingSelector: true,
        ClarificationCard: true,
        ClarificationChip: true,
        TeamDashboard: true,
        WorkerStatusBar: true,
        TaskCenterView: true,
        PlanModeToggle: true,
        PlanPanel: true,
      },
    },
  });
  return wrapper;
}

async function mountAndFlush(): Promise<ReturnType<typeof mount>> {
  const w = mountPanel();
  await flushPromises();
  return w;
}

async function typeAndSubmit(w: ReturnType<typeof mount>, text: string): Promise<void> {
  await w.get(".composer-textarea").setValue(text);
  await w.get(".composer-textarea").trigger("keydown", { key: "Enter" });
}

async function clickSend(w: ReturnType<typeof mount>): Promise<void> {
  await w.get(".composer-action-btn.primary-action").trigger("click");
  await flushPromises();
}

/** Command names as rendered by the CommandPalette stub. */
function paletteNames(w: ReturnType<typeof mount>): string[] {
  const el = w.get(".palette-stub");
  return (el.attributes("data-names") ?? "").split(",").filter((name) => name !== "");
}

beforeEach(() => {
  vi.clearAllMocks();
  rpcMock.state.sessionState.value = null;
  rpcMock.state.isConnected.value = true;
  rpcMock.state.isStreaming.value = false;
  rpcMock.state.executionEnvironment.value = null;
  rpcMock.state.commands.value = [];
  sessionMock.state.displayBlocks.value = [];
  sessionMock.state.lastRetryableError.value = null;
  teamStoreMock.state.teamMode.value = false;
  projectStoreMock.state.currentProject.value = null;
  installPixApiMock();
  // 重置 useBtw 模块级单例到无卡状态（close 会调一次 btwCancel，清掉该次调用）。
  useBtw().close();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = "";
});

// ============================================================================
// useBtw state machine
// ============================================================================

describe("useBtw state machine", () => {
  it("ask sets loading and forwards the question to btwAsk", () => {
    const btw = useBtw();
    deferBtwAsk();
    btw.ask("问题");
    expect(btw.card.value.kind).toBe("loading");
    expect(btw.card.value.question).toBe("问题");
    expect(btwAsk).toHaveBeenCalledWith("问题");
  });

  it("loading -> answered on success with the answer text", async () => {
    const btw = useBtw();
    const deferred = deferBtwAsk();
    btw.ask("问题");
    expect(btw.card.value.kind).toBe("loading");
    deferred.resolve({ status: "answered", answer: "回答" });
    await flushPromises();
    expect(btw.card.value.kind).toBe("answered");
    expect(btw.card.value.answer).toBe("回答");
    expect(btw.card.value.settledAt).toBeGreaterThan(0);
  });

  it("loading -> failed on an error status with the localized message", async () => {
    const btw = useBtw();
    const deferred = deferBtwAsk();
    btw.ask("问题");
    deferred.resolve({ status: "error", errorMessage: "模型未配置授权" });
    await flushPromises();
    expect(btw.card.value.kind).toBe("failed");
    expect(btw.card.value.errorMessage).toBe("模型未配置授权");
  });

  it("loading -> failed on a rejected btwAsk", async () => {
    const btw = useBtw();
    btwAsk.mockRejectedValue(new Error("网络错误"));
    btw.ask("问题");
    await flushPromises();
    expect(btw.card.value.kind).toBe("failed");
    expect(btw.card.value.errorMessage).toBe("网络错误");
  });

  it("discards an aborted result from an older generation", async () => {
    const btw = useBtw();
    const first = deferBtwAsk();
    btw.ask("第一个问题");
    const second = deferBtwAsk();
    btw.ask("第二个问题");
    // 旧代先回 aborted：不得覆盖新代的 loading 状态。
    first.resolve({ status: "aborted" });
    await flushPromises();
    expect(btw.card.value.kind).toBe("loading");
    expect(btw.card.value.question).toBe("第二个问题");
    second.resolve({ status: "answered", answer: "新回答" });
    await flushPromises();
    expect(btw.card.value.kind).toBe("answered");
    expect(btw.card.value.answer).toBe("新回答");
  });

  it("maps an aborted result with a matching generation to idle", async () => {
    const btw = useBtw();
    const deferred = deferBtwAsk();
    btw.ask("问题");
    deferred.resolve({ status: "aborted" });
    await flushPromises();
    expect(btw.card.value.kind).toBe("idle");
  });

  it("retry resends card.question from failed", async () => {
    const btw = useBtw();
    const deferred = deferBtwAsk();
    btw.ask("问题");
    deferred.resolve({ status: "error", errorMessage: "超时" });
    await flushPromises();
    expect(btw.card.value.kind).toBe("failed");

    const retryDeferred = deferBtwAsk();
    btw.retry();
    expect(btw.card.value.kind).toBe("loading");
    expect(btw.card.value.question).toBe("问题");
    retryDeferred.resolve({ status: "answered", answer: "重试成功" });
    await flushPromises();
    expect(btw.card.value.kind).toBe("answered");
    expect(btwAsk).toHaveBeenCalledTimes(2);
    expect(btwAsk).toHaveBeenLastCalledWith("问题");
  });

  it("retry also works from answered", async () => {
    const btw = useBtw();
    const deferred = deferBtwAsk();
    btw.ask("问题");
    deferred.resolve({ status: "answered", answer: "回答" });
    await flushPromises();

    const retryDeferred = deferBtwAsk();
    btw.retry();
    expect(btw.card.value.kind).toBe("loading");
    expect(btwAsk).toHaveBeenLastCalledWith("问题");
    retryDeferred.resolve({ status: "answered", answer: "再问" });
    await flushPromises();
    expect(btw.card.value.kind).toBe("answered");
  });

  it("retry is a no-op from loading and usage", () => {
    const btw = useBtw();
    deferBtwAsk();
    btw.ask("问题");
    const calls = btwAsk.mock.calls.length;
    btw.retry();
    expect(btwAsk.mock.calls.length).toBe(calls);

    btw.showUsage("用法：/btw <问题>");
    btw.retry();
    expect(btwAsk.mock.calls.length).toBe(calls);
  });

  it("close cancels the in-flight request and returns to idle", async () => {
    const btw = useBtw();
    deferBtwAsk();
    btw.ask("问题");
    expect(btw.card.value.kind).toBe("loading");
    btw.close();
    expect(btwCancel).toHaveBeenCalledTimes(1);
    expect(btw.card.value.kind).toBe("idle");
    await flushPromises();
    expect(btw.card.value.kind).toBe("idle");
  });

  it("destroy behaves like close", () => {
    const btw = useBtw();
    deferBtwAsk();
    btw.ask("问题");
    btw.destroy();
    expect(btwCancel).toHaveBeenCalledTimes(1);
    expect(btw.card.value.kind).toBe("idle");
  });

  it("showUsage renders a usage card with the hint message", () => {
    const btw = useBtw();
    btw.showUsage("用法：/btw <问题>");
    expect(btw.card.value.kind).toBe("usage");
    expect(btw.card.value.errorMessage).toBe("用法：/btw <问题>");
  });

  it("showUsage cancels an in-flight request before replacing the card", () => {
    const btw = useBtw();
    deferBtwAsk();
    btw.ask("问题");
    expect(btwCancel).not.toHaveBeenCalled();
    btw.showUsage("用法：/btw <问题>");
    expect(btwCancel).toHaveBeenCalledTimes(1);
    expect(btw.card.value.kind).toBe("usage");
  });

  it("showUsage does not cancel when no card is active", () => {
    const btw = useBtw();
    btw.showUsage("用法：/btw <问题>");
    expect(btwCancel).not.toHaveBeenCalled();
    expect(btw.card.value.kind).toBe("usage");
  });

  it("elapsedMs ticks every 100ms while loading and freezes on settle", async () => {
    vi.useFakeTimers();
    const btw = useBtw();
    const deferred = deferBtwAsk();
    btw.ask("问题");
    vi.advanceTimersByTime(350);
    expect(btw.elapsedMs.value).toBe(300);
    deferred.resolve({ status: "answered", answer: "回答" });
    await vi.advanceTimersByTimeAsync(0);
    expect(btw.card.value.kind).toBe("answered");
    vi.advanceTimersByTime(1000);
    expect(btw.elapsedMs.value).toBe(300); // 定格
  });
});

// ============================================================================
// CenterPanel /btw interception
// ============================================================================

describe("CenterPanel /btw interception", () => {
  it("intercepts a solo /btw line: no prompt, no optimistic message, card loading", async () => {
    const w = await mountAndFlush();
    const deferred = deferBtwAsk();
    await typeAndSubmit(w, "/btw 这个项目的架构如何？");
    await flushPromises();

    expect(rpcMock.state.sendCommandAsync).not.toHaveBeenCalled();
    expect(sessionMock.state.appendOptimisticUserMessage).not.toHaveBeenCalled();
    expect((w.get(".composer-textarea").element as HTMLTextAreaElement).value).toBe("");
    expect(btwAsk).toHaveBeenCalledWith("这个项目的架构如何？");
    expect(useBtw().card.value.kind).toBe("loading");
    expect(useBtw().card.value.question).toBe("这个项目的架构如何？");

    deferred.resolve({ status: "answered", answer: "项目使用分层架构。" });
    await flushPromises();
    expect(useBtw().card.value.kind).toBe("answered");
    expect(w.get(".btw-title-question").text()).toBe("这个项目的架构如何？");
  });

  it("clears attachments on interception", async () => {
    const w = await mountAndFlush();
    selectChatFiles.mockResolvedValue(["C:/proj/a.ts"]);
    await w.get(".composer-icon-btn").trigger("click");
    await flushPromises();
    expect(w.findAll(".attachment-chip").length).toBe(1);

    await typeAndSubmit(w, "/btw 问题");
    await flushPromises();
    expect(w.findAll(".attachment-chip").length).toBe(0);
    expect(btwAsk).toHaveBeenCalledWith("问题");
  });

  it("is case-sensitive: /BTW is not intercepted", async () => {
    const w = await mountAndFlush();
    await typeAndSubmit(w, "/BTW 大写命令");
    await flushPromises();
    expect(btwAsk).not.toHaveBeenCalled();
    expect(rpcMock.state.sendCommandAsync).toHaveBeenCalledWith({
      type: "prompt",
      message: "/BTW 大写命令",
      filePaths: undefined,
      images: undefined,
    });
  });

  it("does not intercept in team mode: /btw goes through the normal prompt path", async () => {
    teamStoreMock.state.teamMode.value = true;
    const w = await mountAndFlush();
    await typeAndSubmit(w, "/btw 团队问题");
    await flushPromises();
    expect(btwAsk).not.toHaveBeenCalled();
    expect(rpcMock.state.sendCommandAsync).toHaveBeenCalledWith({
      type: "prompt",
      message: "/btw 团队问题",
      filePaths: undefined,
      images: undefined,
    });
    expect(sessionMock.state.appendOptimisticUserMessage).toHaveBeenCalledWith("/btw 团队问题", undefined);
  });

  it("shows the usage card for a bare /btw without sending a request", async () => {
    const w = await mountAndFlush();
    await w.get(".composer-textarea").setValue("/btw");
    await clickSend(w);
    expect(btwAsk).not.toHaveBeenCalled();
    expect(useBtw().card.value.kind).toBe("usage");
    expect(useBtw().card.value.errorMessage).toBe("用法：/btw <问题>");
    expect(rpcMock.state.sendCommandAsync).not.toHaveBeenCalled();
  });

  it("shows the usage card for an over-long question", async () => {
    const w = await mountAndFlush();
    const longQuestion = "问".repeat(1001);
    await w.get(".composer-textarea").setValue(`/btw ${longQuestion}`);
    await clickSend(w);
    expect(btwAsk).not.toHaveBeenCalled();
    expect(useBtw().card.value.kind).toBe("usage");
    expect(useBtw().card.value.errorMessage).toBe("问题过长（≤1000 字符）");
  });

  it("accepts a 1000-character question", async () => {
    const w = await mountAndFlush();
    deferBtwAsk();
    const question = "问".repeat(1000);
    await w.get(".composer-textarea").setValue(`/btw ${question}`);
    await clickSend(w);
    expect(btwAsk).toHaveBeenCalledWith(question);
    expect(useBtw().card.value.kind).toBe("loading");
  });

  it("counts code points, not UTF-16 units: a 501-emoji question (1002 units) is accepted", async () => {
    const w = await mountAndFlush();
    deferBtwAsk();
    const question = "😀".repeat(501);
    await w.get(".composer-textarea").setValue(`/btw ${question}`);
    await clickSend(w);
    expect(btwAsk).toHaveBeenCalledWith(question);
    expect(useBtw().card.value.kind).toBe("loading");
  });

  it("trims trailing whitespace before counting: 1000 chars plus a trailing space is accepted", async () => {
    const w = await mountAndFlush();
    deferBtwAsk();
    // sendMessage 入口已对整行 trim，尾随空格不会计入码点数，恰好 1000 字符不会被误拒。
    const question = "问".repeat(1000);
    await w.get(".composer-textarea").setValue(`/btw ${question} `);
    await clickSend(w);
    expect(btwAsk).toHaveBeenCalledWith(question);
    expect(useBtw().card.value.kind).toBe("loading");
  });

  it("destroy() aborts an in-flight card when a normal message is sent", async () => {
    const w = await mountAndFlush();
    deferBtwAsk();
    useBtw().ask("进行中的侧问");
    expect(useBtw().card.value.kind).toBe("loading");

    await typeAndSubmit(w, "正常消息");
    await flushPromises();
    expect(btwCancel).toHaveBeenCalledTimes(1);
    expect(useBtw().card.value.kind).toBe("idle");
    expect(rpcMock.state.sendCommandAsync).toHaveBeenCalledWith({
      type: "prompt",
      message: "正常消息",
      filePaths: undefined,
      images: undefined,
    });
    expect(sessionMock.state.appendOptimisticUserMessage).toHaveBeenCalled();
  });

  it("renders BtwCard in the composer only while a card is active", async () => {
    const w = await mountAndFlush();
    expect(w.findComponent(BtwCard).exists()).toBe(false);

    const deferred = deferBtwAsk();
    await typeAndSubmit(w, "/btw 你好");
    await flushPromises();
    expect(w.findComponent(BtwCard).exists()).toBe(true);
    expect(w.get(".btw-title-question").text()).toBe("你好");

    deferred.resolve({ status: "answered", answer: "回答" });
    await flushPromises();
    await w.get(".btw-close").trigger("click");
    expect(btwCancel).toHaveBeenCalledTimes(1);
    expect(w.findComponent(BtwCard).exists()).toBe(false);
  });

  it("restores focus to the main textarea when the card is closed with Escape", async () => {
    const w = await mountAndFlush();
    deferBtwAsk();
    await typeAndSubmit(w, "/btw 问题");
    await flushPromises();

    const cardEl = w.get(".btw-card").element as HTMLElement;
    cardEl.focus();
    expect(document.activeElement).toBe(cardEl);

    await w.get(".btw-card").trigger("keydown", { key: "Escape" });
    expect(useBtw().card.value.kind).toBe("idle");
    expect(document.activeElement).toBe(w.get(".composer-textarea").element);
  });

  it("restores focus to the main textarea when the card is closed via the × button", async () => {
    const w = await mountAndFlush();
    const deferred = deferBtwAsk();
    await typeAndSubmit(w, "/btw 问题");
    await flushPromises();
    deferred.resolve({ status: "answered", answer: "回答" });
    await flushPromises();

    const cardEl = w.get(".btw-card").element as HTMLElement;
    cardEl.focus();
    expect(document.activeElement).toBe(cardEl);

    await w.get(".btw-close").trigger("click");
    expect(useBtw().card.value.kind).toBe("idle");
    expect(document.activeElement).toBe(w.get(".composer-textarea").element);
  });
});

// ============================================================================
// paletteCommands merge
// ============================================================================

describe("palette commands", () => {
  it("injects a builtin /btw entry first in solo mode and dedupes", async () => {
    rpcMock.state.commands.value = [
      { name: "compact", description: "压缩", source: "builtin", sourceInfo: {} },
      { name: "btw", description: "remote btw", source: "extension", sourceInfo: {} },
    ];
    const w = await mountAndFlush();
    await w.get(".composer-textarea").setValue("/");

    const names = paletteNames(w);
    expect(names[0]).toBe("btw");
    expect(names).toContain("compact");
    expect(names.filter((name) => name === "btw")).toHaveLength(1);

    const commands = w.findComponent(CommandPaletteStub).props("commands") as RpcSlashCommand[];
    const btwEntry = commands.find((command) => command.name === "btw");
    expect(btwEntry?.source).toBe("builtin");
    expect(btwEntry?.description).toBe("不打断主流程的快速提问");
  });

  it("does not inject /btw in team mode", async () => {
    rpcMock.state.commands.value = [
      { name: "compact", source: "builtin", sourceInfo: {} },
      { name: "btw", source: "extension", sourceInfo: {} },
    ];
    teamStoreMock.state.teamMode.value = true;
    const w = await mountAndFlush();
    await w.get(".composer-textarea").setValue("/");

    const names = paletteNames(w);
    expect(names).toEqual(["compact", "btw"]);
    const commands = w.findComponent(CommandPaletteStub).props("commands") as RpcSlashCommand[];
    expect(commands.find((command) => command.name === "btw")?.source).toBe("extension");
  });

  it("injects /btw when the remote list has no btw entry", async () => {
    rpcMock.state.commands.value = [{ name: "compact", source: "builtin", sourceInfo: {} }];
    const w = await mountAndFlush();
    await w.get(".composer-textarea").setValue("/");
    expect(paletteNames(w)).toEqual(["btw", "compact"]);
  });
});

// ============================================================================
// BtwCard render contract
// ============================================================================

describe("BtwCard render contract", () => {
  function mountCard(): ReturnType<typeof mount> {
    return mount(BtwCard);
  }

  it("renders the title with the /btw prefix and the question while loading", () => {
    deferBtwAsk();
    useBtw().ask("你好");
    const w = mountCard();
    expect(w.get(".btw-title-prefix").text()).toBe("/btw");
    expect(w.get(".btw-title-question").text()).toBe("你好");
    expect(w.get(".btw-loading").text()).toContain("正在回答...");
    w.unmount();
  });

  it("renders the markdown answer body", async () => {
    const deferred = deferBtwAsk();
    useBtw().ask("问题");
    deferred.resolve({ status: "answered", answer: "**加粗** 与 `code`" });
    await flushPromises();
    const w = mountCard();
    expect(w.get(".btw-markdown").html()).toContain("<strong>加粗</strong>");
    w.unmount();
  });

  it("renders the failure message with a retry button that resends", async () => {
    const deferred = deferBtwAsk();
    useBtw().ask("问题");
    deferred.resolve({ status: "error", errorMessage: "模型未配置授权" });
    await flushPromises();
    const w = mountCard();
    expect(w.get(".btw-error").text()).toBe("模型未配置授权");

    deferBtwAsk();
    await w.get(".btw-retry").trigger("click");
    expect(useBtw().card.value.kind).toBe("loading");
    expect(btwAsk).toHaveBeenLastCalledWith("问题");
    w.unmount();
  });

  it("renders the usage hint without retry or footer", () => {
    useBtw().showUsage("用法：/btw <问题>");
    const w = mountCard();
    expect(w.get(".btw-usage").text()).toBe("用法：/btw <问题>");
    expect(w.find(".btw-retry").exists()).toBe(false);
    expect(w.find(".btw-footer").exists()).toBe(false);
    w.unmount();
  });

  it("shows the footer with the frozen elapsed seconds", async () => {
    vi.useFakeTimers();
    const deferred = deferBtwAsk();
    useBtw().ask("问题");
    vi.advanceTimersByTime(1500);
    deferred.resolve({ status: "answered", answer: "回答" });
    await vi.advanceTimersByTimeAsync(0);
    const w = mountCard();
    expect(w.get(".btw-footer").text()).toBe("基于当前会话上下文 · 未使用工具 · 1.5s");
    w.unmount();
  });

  it("closes on Escape from the card content", async () => {
    deferBtwAsk();
    useBtw().ask("问题");
    const w = mountCard();
    await w.trigger("keydown", { key: "Escape" });
    expect(btwCancel).toHaveBeenCalledTimes(1);
    expect(useBtw().card.value.kind).toBe("idle");
    w.unmount();
  });

  it("emits closed on Escape so the host can return focus", async () => {
    deferBtwAsk();
    useBtw().ask("问题");
    const w = mountCard();
    await w.trigger("keydown", { key: "Escape" });
    expect(w.emitted("closed")).toHaveLength(1);
    w.unmount();
  });

  it("emits closed when the × button is clicked", async () => {
    const deferred = deferBtwAsk();
    useBtw().ask("问题");
    deferred.resolve({ status: "answered", answer: "回答" });
    await flushPromises();
    const w = mountCard();
    await w.get(".btw-close").trigger("click");
    expect(w.emitted("closed")).toHaveLength(1);
    w.unmount();
  });

  it("renders code blocks without the copy button in the answered body", async () => {
    const deferred = deferBtwAsk();
    useBtw().ask("问题");
    deferred.resolve({ status: "answered", answer: "```ts\nconst a = 1;\n```" });
    await flushPromises();
    const w = mountCard();
    const html = w.get(".btw-markdown").html();
    expect(html).toContain("code-block");
    expect(html).not.toContain("code-copy-btn");
    w.unmount();
  });

  it("renderMarkdown keeps injecting the copy button by default for SessionView callers", () => {
    const html = renderMarkdown("```ts\nconst a = 1;\n```");
    expect(html).toContain("code-copy-btn");
  });

  it("scrolls the body with arrow keys", async () => {
    const deferred = deferBtwAsk();
    useBtw().ask("问题");
    deferred.resolve({ status: "answered", answer: "回答" });
    await flushPromises();
    const w = mountCard();
    const body = w.get(".btw-body");
    const original = body.element.scrollTop;
    await w.trigger("keydown", { key: "ArrowDown" });
    expect(body.element.scrollTop).toBeGreaterThan(original);
    await w.trigger("keydown", { key: "ArrowUp" });
    expect(body.element.scrollTop).toBeLessThanOrEqual(original + 1);
    w.unmount();
  });
});
