/**
 * Roundtable S7 收尾（Plan §8 S7 / G9-U-3）——三个页面级断言的落点。
 *
 * 1. `WorkspacePage` 挂载与切模式时都走一次 `teamStore.refresh()`
 *    （圆桌 state / timeline / metrics / attention 只有这一条 pull 路径），
 *    并且切到 team 模式时「先订阅 team-event 再 refresh」——事件可能早于
 *    refresh 的返回值到达，先订阅才不会把 push 覆盖掉。
 * 2. AC-13：旧版 team.json 只提示一次。首次打开工作区弹阻塞式确认框，
 *    确认（ack 落盘）之后同一工作区不再拦截；另一个工作区仍然独立提示。
 * 3. 移交（FR-12 / H15）：`build_handoff` 绑定一版具体交付物，切前台到单人
 *    之后用 `planStore.enterPlanning({ requestText })` 进入规划——字段名是
 *    `requestText`（PlanController 的既有契约，不是 `text`）。
 *
 * 三个被测页面共用同一套 composables / store，所以共用一组 mock：team-store
 * 保持真实（Pinia，teamMode 必须可被 watch 到），RPC composable 与其余 store
 * 用桩，组件只通过 window.pixApi 与它们通信。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { Pinia } from "pinia";
import type { Component } from "vue";
// Use the pre-bundled dist entry: the ESM lib entry imports per-component CSS
// files, which a Node-side externalized import cannot load in happy-dom.
import { components as vuetifyComponents, createVuetify, directives as vuetifyDirectives } from "vuetify/dist/vuetify.js";
import type { PixApi } from "../../main/preload";
import type { ProjectInfo, ProjectLocation } from "@/types/session";
import { useTeamStore } from "../stores/team-store";
import WorkspacePage from "../pages/WorkspacePage.vue";
import HomePage from "../pages/HomePage.vue";
import CenterPanel from "../components/layout/CenterPanel.vue";
import type { DeliverableVersion } from "@shared/team-types.js";

// ============================================================================
// Mocks (module-level, hoisted)
// ============================================================================

const mocks = vi.hoisted(() => {
  /**
   * 桩 ref：`__v_isRef` 让 vue 的 watch/unref 认它是 ref（team-store 会
   * `watch(teamLeaderRpc.piStatus, ...)`，普通对象会被判成非法 watch 源）。
   */
  function fakeRef<T>(initial: T): { readonly __v_isRef: true; value: T } {
    let current = initial;
    return {
      __v_isRef: true as const,
      get value(): T {
        return current;
      },
      set value(next: T) {
        current = next;
      },
    };
  }

  return {
    fakeRef,
    /** 单人的启动/会话 RPC（HomePage 与 WorkspacePage 共用 useRpc 单例）。 */
    soloRpc: {
      isConnected: fakeRef(true),
      piStatus: fakeRef("running" as string),
      sessionState: fakeRef(null as unknown),
      lastError: fakeRef(null as string | null),
      refreshState: vi.fn().mockResolvedValue(undefined),
      refreshSessionStats: vi.fn().mockResolvedValue(undefined),
      getMessages: vi.fn().mockResolvedValue([]),
      attachToRunningSession: vi.fn().mockResolvedValue(true),
      newSession: vi.fn().mockResolvedValue({ cancelled: false }),
      startPi: vi.fn().mockResolvedValue(true),
      startRuntime: vi.fn().mockResolvedValue(true),
      abort: vi.fn().mockResolvedValue(undefined),
      sendCommandAsync: vi.fn().mockResolvedValue(undefined),
    },
    /** 宿主（团队运行环境）RPC。 */
    teamLeaderRpc: {
      isConnected: fakeRef(true),
      piStatus: fakeRef("running" as string),
      sessionState: fakeRef(null as unknown),
      lastError: fakeRef(null as string | null),
      refreshState: vi.fn().mockResolvedValue(undefined),
      refreshSessionStats: vi.fn().mockResolvedValue(undefined),
      getMessages: vi.fn().mockResolvedValue([]),
      addEvent: vi.fn(),
      startTeamRuntime: vi.fn().mockResolvedValue(true),
      stopTeamRuntime: vi.fn().mockResolvedValue(true),
      attachToRunningTeamSession: vi.fn().mockResolvedValue(false),
    },
    /** CenterPanel 的宿主会话 RPC（useWorkspaceRpc）。 */
    workspaceRpc: {
      isConnected: fakeRef(true),
      piStatus: fakeRef("running" as string),
      isStreaming: fakeRef(false),
      sessionState: fakeRef(null as unknown),
      sessionStats: fakeRef(null as unknown),
      executionEnvironment: fakeRef(null as unknown),
      lastError: fakeRef(null as string | null),
      commands: fakeRef([] as Array<{ name: string }>),
      availableModels: fakeRef([] as Array<{ provider: string; id: string }>),
      sendCommandAsync: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue(null),
      setPiSetting: vi.fn().mockResolvedValue(undefined),
      refreshState: vi.fn().mockResolvedValue(undefined),
      refreshSessionStats: vi.fn().mockResolvedValue(undefined),
      exportHtml: vi.fn().mockResolvedValue(null),
      exportJsonl: vi.fn().mockResolvedValue(null),
      forkSession: vi.fn().mockResolvedValue({ cancelled: false }),
      getMessages: vi.fn().mockResolvedValue([]),
      abort: vi.fn().mockResolvedValue(undefined),
      newSession: vi.fn().mockResolvedValue({ cancelled: false }),
      getAuthStatus: vi.fn().mockResolvedValue({}),
      getBackgroundTasks: vi.fn().mockResolvedValue([]),
    },
    workspaceSession: {
      displayBlocks: fakeRef([] as Array<{ type: string }>),
      isStreaming: fakeRef(false),
      lastRetryableError: fakeRef(null as unknown),
      appendOptimisticUserMessage: vi.fn().mockReturnValue("optimistic-1"),
      failOptimisticUserMessage: vi.fn(),
      clearSession: vi.fn(),
      loadMessages: vi.fn(),
    },
    project: {
      currentProject: fakeRef(null as ProjectInfo | null),
      currentSession: fakeRef(null as unknown),
      currentTeamSession: fakeRef(null as unknown),
      recentProjects: [] as ProjectInfo[],
      loadSettings: vi.fn().mockResolvedValue(undefined),
      openProject: vi.fn().mockResolvedValue(undefined),
      isCurrentProject: vi.fn().mockReturnValue(false),
      listSessions: vi.fn().mockResolvedValue(undefined),
      listTeamLeaderSessions: vi.fn().mockResolvedValue(undefined),
      syncCurrentSession: vi.fn(),
      syncCurrentTeamSession: vi.fn(),
      removeRecentProject: vi.fn().mockResolvedValue(undefined),
    },
    sessions: {
      clearSession: vi.fn(),
      addEvent: vi.fn(),
    },
    settings: {
      load: vi.fn().mockResolvedValue(undefined),
      detectPi: vi.fn().mockResolvedValue({ found: true, path: "direct" }),
      loadWslDistros: vi.fn().mockResolvedValue(undefined),
      wslSettings: { enabled: false, distro: "", defaultCwd: "" },
      wslDistros: [] as Array<{ name: string }>,
      wslDistrosLoaded: true,
      wslDiagnostic: null as string | null,
      /** GuiSettings 桩：CenterPanel 读 takeHerEyes 决定侧眼按钮的可用性。 */
      settings: { takeHerEyes: undefined } as Record<string, unknown>,
    },
    auth: {
      refreshStatus: vi.fn().mockResolvedValue(undefined),
    },
    plan: {
      enterPlanning: vi.fn().mockResolvedValue({ success: true }),
    },
    router: {
      push: vi.fn().mockResolvedValue(undefined),
      back: vi.fn(),
      replace: vi.fn(),
    },
  };
});

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: mocks.router.push, back: mocks.router.back, replace: mocks.router.replace }),
  useRoute: () => ({ query: {}, path: "/" }),
}));

vi.mock("../composables/useRpc", () => ({
  useRpc: () => mocks.soloRpc,
}));

vi.mock("../composables/useTeamLeaderRpc", () => ({
  useTeamLeaderRpc: () => mocks.teamLeaderRpc,
}));

vi.mock("../composables/useWorkspaceRpc", () => ({
  useWorkspaceRpc: () => mocks.workspaceRpc,
}));

vi.mock("../composables/useWorkspaceSessionStore", () => ({
  useWorkspaceSessionStore: () => mocks.workspaceSession,
}));

vi.mock("../stores/project-store", () => ({
  useProjectStore: () => ({
    currentProject: mocks.project.currentProject.value,
    currentSession: mocks.project.currentSession.value,
    currentTeamSession: mocks.project.currentTeamSession.value,
    recentProjects: mocks.project.recentProjects,
    loadSettings: mocks.project.loadSettings,
    openProject: mocks.project.openProject,
    isCurrentProject: mocks.project.isCurrentProject,
    listSessions: mocks.project.listSessions,
    listTeamLeaderSessions: mocks.project.listTeamLeaderSessions,
    syncCurrentSession: mocks.project.syncCurrentSession,
    syncCurrentTeamSession: mocks.project.syncCurrentTeamSession,
    removeRecentProject: mocks.project.removeRecentProject,
  }),
}));

vi.mock("../stores/session-store", () => ({
  useSessionStore: () => ({
    displayBlocks: { value: [] as Array<{ type: string }> },
    isStreaming: { value: false },
    clearSession: mocks.sessions.clearSession,
    addEvent: mocks.sessions.addEvent,
  }),
  useTeamLeaderSessionStore: () => ({
    displayBlocks: { value: [] as Array<{ type: string }> },
    isStreaming: { value: false },
    clearSession: mocks.sessions.clearSession,
    addEvent: mocks.sessions.addEvent,
  }),
}));

vi.mock("../stores/settings-store", () => ({
  useSettingsStore: () => ({
    load: mocks.settings.load,
    detectPi: mocks.settings.detectPi,
    loadWslDistros: mocks.settings.loadWslDistros,
    wslSettings: mocks.settings.wslSettings,
    wslDistros: mocks.settings.wslDistros,
    wslDistrosLoaded: mocks.settings.wslDistrosLoaded,
    wslDiagnostic: mocks.settings.wslDiagnostic,
    settings: mocks.settings.settings,
  }),
}));

vi.mock("../stores/auth-store", () => ({
  useAuthStore: () => ({ refreshStatus: mocks.auth.refreshStatus }),
}));

vi.mock("../stores/plan-store", () => ({
  usePlanStore: () => ({
    planPhase: null,
    currentPlan: null,
    subscribeToEvents: vi.fn(() => () => {}),
    enterPlanning: mocks.plan.enterPlanning,
  }),
}));

// ============================================================================
// window.pixApi stub + trace
// ============================================================================

const vuetify = createVuetify({
  components: { ...vuetifyComponents },
  directives: { ...vuetifyDirectives },
});

const HANDOFF_TEXT = "## 结论\n\n方向可行，先做最小验证。";

/** 事件顺序证据：订阅与命令都进同一条 trace，才能断言「先订阅再 refresh」。 */
let trace: string[];
let sendTeamCommand: ReturnType<typeof vi.fn>;
let onTeamEvent: ReturnType<typeof vi.fn>;
let setWorkspaceMode: ReturnType<typeof vi.fn>;
let ackLegacyTeamSnapshot: ReturnType<typeof vi.fn>;
let hasLegacyTeamSnapshot: ReturnType<typeof vi.fn>;

function makeDeliverable(): DeliverableVersion {
  return {
    id: "d-1",
    version: 1,
    revision: 1,
    cutoffSeq: 12,
    createdAt: 5000,
    author: "sources::rt-test",
    status: "ready",
    markdown: "# 结论\n\n- 方向可行",
    stances: [],
    sections: {
      conclusions: "方向可行",
      evidenceIndex: "见 #3",
      disagreements: "",
      nextActions: "做最小验证",
      processIndex: "",
    },
  };
}

function installPixApiMock(): void {
  trace = [];
  sendTeamCommand = vi.fn((command: { type: string }) => {
    trace.push(command.type);
    if (command.type === "get_deliverables") return Promise.resolve({ success: true, data: [makeDeliverable()] });
    if (command.type === "build_handoff") return Promise.resolve({ success: true, data: { text: HANDOFF_TEXT } });
    return Promise.resolve({ success: true, data: null });
  });
  onTeamEvent = vi.fn(() => {
    trace.push("subscribe:team-event");
    return () => {};
  });
  setWorkspaceMode = vi.fn().mockResolvedValue(undefined);
  // 主进程侧 `has-legacy-team-snapshot` 的真实契约：ack 落盘之前探针为 true，
  // 落盘（重启/换会话也算数）之后为 false。按契约打桩，别让渲染层自己的
  // 会话内缓存成为「只提示一次」的唯一判据——缓存被删掉是行为不变的清理，
  // 那种改动不该让主用例变红（缓存本身由下面的专属用例负责钉住）。
  const ackedWorkspaces = new Set<string>();
  ackLegacyTeamSnapshot = vi.fn(async (location: ProjectLocation) => {
    ackedWorkspaces.add(location.physicalPath);
    return { success: true };
  });
  hasLegacyTeamSnapshot = vi.fn(async (location: ProjectLocation) => !ackedWorkspaces.has(location.physicalPath));
  window.pixApi = {
    sendTeamCommand,
    onTeamEvent,
    setWorkspaceMode,
    ackLegacyTeamSnapshot,
    hasLegacyTeamSnapshot,
    // 工作区探测：测试里默认都是「没有可恢复的圆桌快照、上次是单人」，
    // 这样启动路径不进团队运行环境，只走单人分支。
    hasTeamSnapshot: vi.fn().mockResolvedValue(false),
    getWorkspaceMode: vi.fn().mockResolvedValue("solo"),
    isTeamLeaderRunning: vi.fn().mockResolvedValue(false),
    resolveProjectLocation: vi.fn().mockResolvedValue({ success: false, error: "unused" }),
    selectChatFiles: vi.fn().mockResolvedValue([]),
    onTeamLeaderEvent: vi.fn(() => () => {}),
    onTeamLeaderUserInputRequest: vi.fn(() => () => {}),
    onTeamLeaderUserInputDismissed: vi.fn(() => () => {}),
    getTeamLeaderPendingUserInputRequest: vi.fn().mockResolvedValue(null),
    onPiEvent: vi.fn(() => () => {}),
    onUserInputRequest: vi.fn(() => () => {}),
    onUserInputDismissed: vi.fn(() => () => {}),
    getPendingUserInputRequest: vi.fn().mockResolvedValue(null),
    sendAgentTaskCommand: vi.fn().mockResolvedValue({ success: true }),
    onAgentTaskEvent: vi.fn(() => () => {}),
    onAgentTaskInputRequest: vi.fn(() => () => {}),
    sendPlanCommand: vi.fn().mockResolvedValue({ success: true }),
    onPlanEvent: vi.fn(() => () => {}),
    sendWorkflowCommand: vi.fn().mockResolvedValue({ success: true, data: [] }),
    onWorkflowEvent: vi.fn(() => () => {}),
    btwAsk: vi.fn().mockResolvedValue({ status: "error", errorMessage: "unused" }),
  } as unknown as PixApi;
}

// ============================================================================
// Helpers
// ============================================================================

function makeProject(name: string, physicalPath: string): ProjectInfo {
  return {
    path: physicalPath,
    physicalPath,
    name,
    environment: { kind: "windows" },
    lastOpened: 1,
    sessionCount: 0,
  };
}

/** TeamCommand 类型序列（refresh 的四个读命令都在里面）。 */
function teamCommandTypes(): string[] {
  return (sendTeamCommand.mock.calls as Array<[{ type: string }]>).map(([command]) => command.type);
}

/**
 * HomePage 的旧快照确认框是否真的在屏幕上。VOverlay 用 v-show 收起内容，
 * 关掉的 dialog 仍然留在 DOM 里（`display:none` 在 `.v-overlay__content` 上），
 * 所以只能看可见性，不能看存在性。
 */
function legacyDialogShown(): boolean {
  const card = document.body.querySelector('[data-test="legacy-snapshot-dialog"]');
  return card !== null && new DOMWrapper(card).isVisible();
}

function makePinia(): Pinia {
  const pinia = createPinia();
  setActivePinia(pinia);
  return pinia;
}

function mountPage(
  component: Component,
  pinia: Pinia,
  options: { stubs?: Record<string, boolean>; props?: Record<string, unknown> } = {},
) {
  return mount(component, {
    attachTo: document.body,
    props: options.props,
    global: { plugins: [pinia, vuetify], stubs: options.stubs },
  });
}

/** 点 teleport 到 body 里的内容（VDialog / VMenu）。 */
async function clickByText(selector: string, text: string): Promise<void> {
  const node = [...document.body.querySelectorAll(selector)].find((el) => (el.textContent ?? "").includes(text));
  expect(node, `missing ${selector} containing ${text}`).toBeTruthy();
  await new DOMWrapper(node as Element).trigger("click");
}

beforeEach(() => {
  vi.clearAllMocks();
  installPixApiMock();
  mocks.project.currentProject.value = null;
  mocks.project.recentProjects.length = 0;
  mocks.soloRpc.isConnected.value = true;
  mocks.workspaceRpc.isConnected.value = true;
  mocks.workspaceSession.displayBlocks.value = [];
  // happy-dom 没有 visualViewport；VOverlay 的 connected 策略会读它。
  vi.stubGlobal("visualViewport", {
    addEventListener: () => {},
    removeEventListener: () => {},
    width: 1024,
    height: 768,
    offsetLeft: 0,
    offsetTop: 0,
    scale: 1,
    pageLeft: 0,
    pageTop: 0,
  });
  vi.stubGlobal("alert", vi.fn());
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

// ============================================================================
// ① WorkspacePage：挂载 / 切模式都要拉一次圆桌状态
// ============================================================================

describe("WorkspacePage 圆桌拉取（Plan §8 S7）", () => {
  it("挂载时已是 team 模式则走一次 refresh()（四个读命令）", async () => {
    const pinia = makePinia();
    const store = useTeamStore();
    store.teamMode = true;

    const w = mountPage(WorkspacePage, pinia, { stubs: { AppLayout: true } });
    await flushPromises();

    // 事件可能在订阅前丢掉，state/timeline/metrics/attention 只能 pull 回来。
    expect(teamCommandTypes()).toEqual(["get_state", "get_timeline", "get_metrics", "get_attention"]);
    // team 模式必须挂着 team-event 监听，否则后续 push 全部丢失。
    expect(onTeamEvent).toHaveBeenCalled();
    w.unmount();
  });

  it("切到 team 模式时先订阅 team-event 再 refresh()", async () => {
    const pinia = makePinia();
    const store = useTeamStore();
    const w = mountPage(WorkspacePage, pinia, { stubs: { AppLayout: true } });
    await flushPromises();
    expect(store.teamMode).toBe(false);
    expect(teamCommandTypes()).toEqual([]);
    // solo 挂载不订阅 team-event：监听只属于前台是团队的那段时间。
    expect(onTeamEvent).not.toHaveBeenCalled();

    // 顶栏「团队」按钮 / 左栏「新建团队会话」走的就是这条 watch 路径。
    store.teamMode = true;
    await flushPromises();

    expect(trace).toContain("subscribe:team-event");
    expect(trace).toContain("get_state");
    // 先订阅：refresh 的返回值到达时监听已经挂上，push 不会被快照覆盖。
    expect(trace.indexOf("subscribe:team-event")).toBeLessThan(trace.indexOf("get_state"));
    w.unmount();
  });
});

// ============================================================================
// ② AC-13：旧版 team.json 只提示一次
// ============================================================================

describe("AC-13 旧快照提示只弹一次（HomePage）", () => {
  it("首次打开弹一次、确认 ack 后同一工作区不再拦，另一个工作区仍然提示", async () => {
    mocks.project.recentProjects.push(makeProject("proj-a", "E:/proj-a"), makeProject("proj-b", "E:/proj-b"));
    const pinia = makePinia();
    const w = mountPage(HomePage, pinia, { stubs: { "router-link": true } });
    await flushPromises();

    // 打开 A：旧快照存在 → 阻塞式提示，先不开工作区。
    await w.findAll(".project-list-item")[0].trigger("click");
    await flushPromises();
    expect(legacyDialogShown()).toBe(true);
    expect(mocks.soloRpc.startPi).not.toHaveBeenCalled();

    // 确认：ack 落盘 + 继续打开（单人）。
    await clickByText(".legacy-dialog-actions button", "知道了");
    await flushPromises();
    expect(ackLegacyTeamSnapshot).toHaveBeenCalledWith(expect.objectContaining({ physicalPath: "E:/proj-a" }));
    expect(legacyDialogShown()).toBe(false);
    expect(mocks.soloRpc.startPi).toHaveBeenCalledTimes(1);
    expect(mocks.router.push).toHaveBeenCalledWith("/workspace");

    // 再打开 A：ack 已落盘，探针按主进程契约回 false → 不再拦（一次性提示）。
    hasLegacyTeamSnapshot.mockClear();
    await w.findAll(".project-list-item")[0].trigger("click");
    await flushPromises();
    expect(hasLegacyTeamSnapshot).toHaveBeenCalledWith(expect.objectContaining({ physicalPath: "E:/proj-a" }));
    expect(legacyDialogShown()).toBe(false);
    expect(mocks.soloRpc.startPi).toHaveBeenCalledTimes(2);
    expect(ackLegacyTeamSnapshot).toHaveBeenCalledTimes(1);

    // 另一个工作区是另一条 ack 记录：仍然要提示（不是「一辈子只提示一次」）。
    await w.findAll(".project-list-item")[1].trigger("click");
    await flushPromises();
    expect(legacyDialogShown()).toBe(true);
    expect(mocks.soloRpc.startPi).toHaveBeenCalledTimes(2);

    w.unmount();
  });

  it("主进程还没观察到 ack 时，同一会话的渲染层缓存挡住重复弹框（删缓存需同步改这条）", async () => {
    mocks.project.recentProjects.push(makeProject("proj-a", "E:/proj-a"));
    // 探针一直说「没确认过」：此时不重复弹框只可能来自 HomePage 自己的会话内记名表。
    // 这条用例钉的就是那个缓存层（ack 写盘与下一次探针之间总有窗口）；主进程侧的
    // 权威判定由上面的用例覆盖。缓存被删掉的话这条会红，改测试时别误判成产品回归。
    hasLegacyTeamSnapshot.mockResolvedValue(true);
    const pinia = makePinia();
    const w = mountPage(HomePage, pinia, { stubs: { "router-link": true } });
    await flushPromises();

    await w.findAll(".project-list-item")[0].trigger("click");
    await flushPromises();
    expect(legacyDialogShown()).toBe(true);

    await clickByText(".legacy-dialog-actions button", "知道了");
    await flushPromises();
    expect(legacyDialogShown()).toBe(false);
    expect(mocks.soloRpc.startPi).toHaveBeenCalledTimes(1);

    await w.findAll(".project-list-item")[0].trigger("click");
    await flushPromises();
    expect(legacyDialogShown()).toBe(false);
    expect(mocks.soloRpc.startPi).toHaveBeenCalledTimes(2);
    expect(ackLegacyTeamSnapshot).toHaveBeenCalledTimes(1);

    w.unmount();
  });
});

// ============================================================================
// ③ 移交 → enterPlanning({ requestText })
// ============================================================================

describe("移交（FR-12 / H15）", () => {
  it("绑定一版具体交付物，切前台后以 requestText 进入规划", async () => {
    const pinia = makePinia();
    const store = useTeamStore();
    store.teamMode = true;
    await store.refreshDeliverables();
    mocks.project.currentProject.value = makeProject("proj-a", "E:/proj-a");

    const w = mountPage(CenterPanel, pinia, {
      props: {
        pendingUserInput: null,
        currentQuestionIndex: 0,
        currentAnswer: "",
        currentQuestion: null,
        totalQuestions: 0,
        answeredSummary: [],
      },
      stubs: {
        SessionView: true,
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
    });
    await flushPromises();

    await w.find(".handoff-action").trigger("click");
    await flushPromises();
    await clickByText(".v-list-item", "进入规划");
    await flushPromises();

    // 移交绑定的是那一版交付物，不是「当前讨论」。
    const buildHandoff = (sendTeamCommand.mock.calls as Array<[{ type: string }]>)
      .map(([command]) => command)
      .find((command) => command.type === "build_handoff");
    expect(buildHandoff).toEqual({ type: "build_handoff", deliverableId: "d-1", target: "plan" });

    // 字段名必须是 requestText（PlanController 既有契约）；改叫 text 会红。
    expect(mocks.plan.enterPlanning).toHaveBeenCalledTimes(1);
    const [options] = mocks.plan.enterPlanning.mock.calls[0] as [Record<string, unknown>];
    expect(options).toEqual({ requestText: HANDOFF_TEXT, source: "configured" });

    // 进规划前已经切前台到单人：圆桌记录留在盘上，规划跑在单人运行环境里。
    expect(store.teamMode).toBe(false);
    expect(setWorkspaceMode).toHaveBeenCalledWith(expect.objectContaining({ physicalPath: "E:/proj-a" }), "solo");

    w.unmount();
  });
});
