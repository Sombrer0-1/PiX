/**
 * ACP settings and UI tests (package F).
 *
 * Settings switch is independent of auto-compact; RightPanel hides the old
 * compact button when acp.enabled; CenterPanel shows an empty-session ACP
 * toggle (including team empty state), readonly when locked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { components as vuetifyComponents, createVuetify, directives as vuetifyDirectives } from "vuetify/dist/vuetify.js";
import type { PixApi } from "../../main/preload";
import type { GuiSettings, ModelInfo } from "@shared/types.js";
import { useSettingsStore } from "../stores/settings-store";
import SettingsPage from "../pages/SettingsPage.vue";
import RightPanel from "../components/layout/RightPanel.vue";
import CenterPanel from "../components/layout/CenterPanel.vue";

const rpcMock = vi.hoisted(() => ({
  state: {
    sessionState: {
      value: null as null | {
        sessionId?: string;
        model?: { provider: string; id: string };
        thinkingLevel?: string;
        sessionName?: string;
        messageCount?: number;
        goal?: unknown;
        isCompacting?: boolean;
        acp?: { enabled: boolean; locked: boolean };
      },
    },
    isConnected: { value: true },
    isStreaming: { value: false },
    executionEnvironment: { value: null as null | { kind: "windows" | "wsl"; distro?: string; logicalCwd?: string } },
    lastError: { value: null as string | null },
    commands: { value: [] as Array<{ name: string }> },
    availableModels: { value: [] as ModelInfo[] },
    sendCommandAsync: vi.fn().mockResolvedValue(undefined),
    setPiSetting: vi.fn().mockResolvedValue(undefined),
    setPiSettings: vi.fn().mockResolvedValue(undefined),
    refreshState: vi.fn().mockResolvedValue(undefined),
    refreshModels: vi.fn().mockResolvedValue(undefined),
    refreshCommands: vi.fn().mockResolvedValue(undefined),
    exportHtml: vi.fn().mockResolvedValue(null),
    exportJsonl: vi.fn().mockResolvedValue(null),
    forkSession: vi.fn().mockResolvedValue({ cancelled: false }),
    getMessages: vi.fn().mockResolvedValue([]),
    abort: vi.fn().mockResolvedValue(undefined),
    getBackgroundTasks: vi.fn().mockResolvedValue([]),
    stopBackgroundTask: vi.fn().mockResolvedValue(undefined),
    mcpGetServers: vi.fn().mockResolvedValue([]),
    compact: vi.fn().mockResolvedValue(undefined),
    setAcp: vi.fn().mockResolvedValue(undefined),
    getPiSettings: vi.fn().mockResolvedValue(null),
    getAuthStatus: vi.fn().mockResolvedValue({}),
    getCustomProviders: vi.fn().mockResolvedValue({ providers: {} }),
    reloadResources: vi.fn().mockResolvedValue(undefined),
    setApiKey: vi.fn().mockResolvedValue(undefined),
    removeAuth: vi.fn().mockResolvedValue(undefined),
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
    currentProject: { value: null as { name?: string } | null },
    currentSession: { value: null },
    currentTeamSession: { value: null },
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

const planStoreMock = vi.hoisted(() => ({
  state: {
    planPhase: null as null | string,
    currentPlan: null as unknown,
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
    setPiSettings: rpcMock.state.setPiSettings,
    refreshState: rpcMock.state.refreshState,
    refreshModels: rpcMock.state.refreshModels,
    refreshCommands: rpcMock.state.refreshCommands,
    exportHtml: rpcMock.state.exportHtml,
    exportJsonl: rpcMock.state.exportJsonl,
    forkSession: rpcMock.state.forkSession,
    getMessages: rpcMock.state.getMessages,
    abort: rpcMock.state.abort,
    getBackgroundTasks: rpcMock.state.getBackgroundTasks,
    stopBackgroundTask: rpcMock.state.stopBackgroundTask,
    mcpGetServers: rpcMock.state.mcpGetServers,
    compact: rpcMock.state.compact,
    setAcp: rpcMock.state.setAcp,
    getPiSettings: rpcMock.state.getPiSettings,
    getAuthStatus: rpcMock.state.getAuthStatus,
    getCustomProviders: rpcMock.state.getCustomProviders,
    reloadResources: rpcMock.state.reloadResources,
    setApiKey: rpcMock.state.setApiKey,
    removeAuth: rpcMock.state.removeAuth,
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
    subscribeToEvents: vi.fn(() => () => {}),
  }),
}));

vi.mock("vue-router", () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));

const vuetify = createVuetify({
  components: { ...vuetifyComponents },
  directives: { ...vuetifyDirectives },
});

let pinia: ReturnType<typeof createPinia>;
let getSettingsMock: ReturnType<typeof vi.fn>;
let setSettingsMock: ReturnType<typeof vi.fn>;
let wrapper: ReturnType<typeof mount> | undefined;

function installPixApiMock(settings: Partial<GuiSettings> = {}): void {
  getSettingsMock = vi.fn().mockResolvedValue({ theme: "light", recentProjects: [], ...settings });
  setSettingsMock = vi.fn().mockResolvedValue({ success: true });
  window.pixApi = {
    getSettings: getSettingsMock,
    setSettings: setSettingsMock,
    listWslDistros: vi.fn().mockResolvedValue({ distros: [], diagnostic: null }),
    sendAgentTaskCommand: vi.fn().mockResolvedValue({ success: true }),
    onAgentTaskEvent: vi.fn(() => () => {}),
    onAgentTaskInputRequest: vi.fn(() => () => {}),
    sendPlanCommand: vi.fn().mockResolvedValue({ success: true }),
    onPlanEvent: vi.fn(() => () => {}),
    sendWorkflowCommand: vi.fn().mockResolvedValue({ success: true, data: [] }),
    onWorkflowEvent: vi.fn(() => () => {}),
    selectChatFiles: vi.fn().mockResolvedValue([]),
  } as unknown as PixApi;
}

function lastSetSettingsCall(): Partial<GuiSettings> {
  expect(setSettingsMock).toHaveBeenCalled();
  return setSettingsMock.mock.calls[setSettingsMock.mock.calls.length - 1][0] as Partial<GuiSettings>;
}

beforeEach(() => {
  vi.clearAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  rpcMock.state.sessionState.value = null;
  rpcMock.state.isConnected.value = true;
  rpcMock.state.isStreaming.value = false;
  rpcMock.state.executionEnvironment.value = null;
  rpcMock.state.lastError.value = null;
  rpcMock.state.commands.value = [];
  rpcMock.state.availableModels.value = [];
  rpcMock.state.getPiSettings.mockResolvedValue(null);
  rpcMock.state.getAuthStatus.mockResolvedValue({});
  rpcMock.state.getCustomProviders.mockResolvedValue({ providers: {} });
  rpcMock.state.getBackgroundTasks.mockResolvedValue([]);
  rpcMock.state.mcpGetServers.mockResolvedValue([]);
  sessionMock.state.displayBlocks.value = [];
  sessionMock.state.lastRetryableError.value = null;
  projectStoreMock.state.currentProject.value = null;
  projectStoreMock.state.currentSession.value = null;
  projectStoreMock.state.currentTeamSession.value = null;
  projectStoreMock.state.sessions.value = [];
  teamStoreMock.state.teamMode.value = false;
  planStoreMock.state.planPhase = null;
  planStoreMock.state.currentPlan = null;
  installPixApiMock();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = "";
});

describe("SettingsPage ACP switch", () => {
  function mountPage(): ReturnType<typeof mount> {
    wrapper = mount(SettingsPage, {
      attachTo: document.body,
      global: {
        plugins: [pinia, vuetify],
        stubs: {
          McpSettings: true,
          CustomProviders: true,
        },
      },
    });
    return wrapper;
  }

  async function clickSave(page: ReturnType<typeof mount>): Promise<void> {
    const saveBtn = page.findAll("button.v-btn").find((b) => b.text().includes("保存设置"));
    expect(saveBtn, "save button exists").toBeTruthy();
    await saveBtn!.trigger("click");
    await flushPromises();
  }

  it("has 新会话默认主动压缩 independent of 自动压缩", async () => {
    const page = mountPage();
    await flushPromises();

    const acpSwitch = page.get('[data-test="default-acp-switch"]');
    expect(acpSwitch.isVisible()).toBe(true);
    expect(acpSwitch.text()).toContain("新会话默认主动压缩");

    const autoCompact = page.findAll(".v-switch").find((el) => el.text().includes("自动压缩"));
    expect(autoCompact, "自动压缩 switch exists").toBeTruthy();
    expect(autoCompact!.text()).not.toContain("新会话默认主动压缩");

    expect(acpSwitch.find("input").element.checked).toBe(false);
    expect(autoCompact!.find("input").element.checked).toBe(true);

    await acpSwitch.find("input").setValue(true);
    await flushPromises();
    expect(autoCompact!.find("input").element.checked).toBe(true);
    expect(acpSwitch.find("input").element.checked).toBe(true);

    await autoCompact!.find("input").setValue(false);
    await flushPromises();
    expect(acpSwitch.find("input").element.checked).toBe(true);

    await clickSave(page);
    const call = lastSetSettingsCall();
    expect(call.defaultAcp).toBe(true);
    expect(call).not.toHaveProperty("compactEnabled");

    const piEntries = rpcMock.state.setPiSettings.mock.calls.at(-1)?.[0] as Array<{ key: string; value: unknown }>;
    expect(piEntries.find((entry) => entry.key === "compactEnabled")?.value).toBe(false);
  });

  it("hydrates persisted defaultAcp without changing auto-compact", async () => {
    installPixApiMock({ defaultAcp: true });
    const page = mountPage();
    await flushPromises();

    expect(page.get('[data-test="default-acp-switch"]').find("input").element.checked).toBe(true);
    const autoCompact = page.findAll(".v-switch").find((el) => el.text().includes("自动压缩"));
    expect(autoCompact!.find("input").element.checked).toBe(true);
  });

  it("mirrors defaultAcp through the settings store", async () => {
    const store = useSettingsStore();
    getSettingsMock.mockResolvedValue({ theme: "light", recentProjects: [], defaultAcp: true });
    await store.load();
    expect(store.defaultAcp).toBe(true);

    await store.save({ defaultAcp: undefined });
    expect(setSettingsMock).toHaveBeenCalledWith({ defaultAcp: undefined });
  });
});

describe("RightPanel ACP compact gate", () => {
  function mountRightPanel(): ReturnType<typeof mount> {
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

  it("hides the compact button and shows an ACP badge when acp.enabled", async () => {
    rpcMock.state.sessionState.value = { acp: { enabled: true, locked: false } };
    const w = mountRightPanel();
    await flushPromises();

    expect(w.find('[data-test="compact-btn"]').exists()).toBe(false);
    expect(w.get('[data-test="acp-badge"]').text()).toContain("ACP");
  });

  it("keeps the compact button when ACP is off", async () => {
    rpcMock.state.sessionState.value = { acp: { enabled: false, locked: false } };
    const w = mountRightPanel();
    await flushPromises();

    expect(w.find('[data-test="compact-btn"]').exists()).toBe(true);
    expect(w.find('[data-test="acp-badge"]').exists()).toBe(false);
  });
});

describe("CenterPanel empty-session ACP toggle", () => {
  function mountCenterPanel(): ReturnType<typeof mount> {
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

  it("shows the ACP toggle on an empty session", async () => {
    sessionMock.state.displayBlocks.value = [];
    rpcMock.state.isConnected.value = true;
    rpcMock.state.sessionState.value = { acp: { enabled: false, locked: false } };
    const w = mountCenterPanel();
    await flushPromises();

    const toggle = w.get('[data-test="acp-session-toggle"]');
    expect(toggle.exists()).toBe(true);
    expect(toggle.text()).toContain("主动压缩");
  });

  it("is readonly when locked", async () => {
    sessionMock.state.displayBlocks.value = [];
    rpcMock.state.sessionState.value = { acp: { enabled: true, locked: true } };
    const w = mountCenterPanel();
    await flushPromises();

    const toggle = w.getComponent('[data-test="acp-session-toggle"]') as VueWrapper;
    expect(toggle.props("disabled")).toBe(true);
    expect(toggle.props("readonly")).toBe(true);
  });

  it("hides the toggle once the session has display blocks", async () => {
    sessionMock.state.displayBlocks.value = [{ type: "user-message" }];
    const w = mountCenterPanel();
    await flushPromises();

    expect(w.find('[data-test="acp-session-toggle"]').exists()).toBe(false);
  });

  it("shows the toggle in the team empty composer state", async () => {
    teamStoreMock.state.teamMode.value = true;
    sessionMock.state.displayBlocks.value = [];
    rpcMock.state.isConnected.value = true;
    rpcMock.state.sessionState.value = { acp: { enabled: false, locked: false } };
    const w = mountCenterPanel();
    await flushPromises();

    expect(w.find(".team-conversation-empty").exists()).toBe(true);
    expect(w.get('[data-test="acp-session-toggle"]').exists()).toBe(true);
  });
});
