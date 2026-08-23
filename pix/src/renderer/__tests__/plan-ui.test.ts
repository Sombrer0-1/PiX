/**
 * Plan UI tests (PiX 1.4.0, stage P4).
 *
 * Acceptance: the real CenterPanel mounts PlanModeToggle in the inline composer
 * and PlanPanel between the message area and the composer. Covered here:
 * toggle only arms / never fires IPC, non-empty armed submit sends ONE
 * enter_planning carrying text + attachments, failure restores the composer,
 * real mount, only-idle toggle with disable reason, three plan indicators,
 * abandon confirmation, 300ms busy progress, double-submit protection,
 * keyboard/aria, file locating, long-text expand, non-color status/risk,
 * deviations, error recovery (retry/use-session-model/concise-regenerate/
 * revision fallback) and explicit start after approval. No screenshot
 * assertions - behavior only.
 *
 * The component tree talks to main only through window.pixApi
 * (sendPlanCommand / onPlanEvent) and the mocked composables/stores, so no
 * Electron runtime is loaded; the plan store itself is real (Pinia) so the
 * PlanPanel renders real store-driven state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
// Use the pre-bundled dist entry: the ESM lib entry imports per-component CSS
// files, which a Node-side externalized import cannot load in happy-dom.
import { components as vuetifyComponents, createVuetify, directives as vuetifyDirectives } from "vuetify/dist/vuetify.js";
import type { PixApi } from "../../main/preload";
import type {
  Plan,
  PlanCommand,
  PlanDeviation,
  PlanEvent,
  PlanRuntimeSnapshot,
  PlanStep,
  PixCommandResult,
} from "@shared/types.js";
import CenterPanel from "../components/layout/CenterPanel.vue";
import PlanModeToggle from "../components/plan/PlanModeToggle.vue";
import PlanPanel from "../components/plan/PlanPanel.vue";
import PlanStepCard from "../components/plan/PlanStepCard.vue";

// ============================================================================
// Mocks (module-level, hoisted)
// ============================================================================

const rpcMock = vi.hoisted(() => ({
  state: {
    sessionState: { value: null },
    isConnected: { value: true },
    isStreaming: { value: false },
    executionEnvironment: { value: null },
    commands: { value: [] as Array<{ name: string }> },
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
// Fixtures
// ============================================================================

function makeStep(overrides?: Partial<PlanStep>): PlanStep {
  return {
    stepKey: "k1",
    stepId: "s1",
    title: "Step 1",
    description: "Do the thing",
    files: [],
    executionTarget: "parent",
    risk: "low",
    riskReason: "Low risk",
    effort: "small",
    verification: "Check the output",
    dependsOn: [],
    status: "pending",
    waitingReason: "",
    ...overrides,
  };
}

function makePlan(overrides?: Partial<Plan>): Plan {
  return {
    schemaVersion: 1,
    planId: "plan-1",
    version: 1,
    status: "awaiting_approval",
    title: "实现登录",
    summary: "实现登录流程并补充测试",
    planningModel: { provider: "anthropic", modelId: "claude-sonnet-4-6", thinkingLevel: "medium" },
    steps: [makeStep()],
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function makeSnapshot(overrides?: Partial<PlanRuntimeSnapshot>): PlanRuntimeSnapshot {
  return {
    schemaVersion: 1,
    phase: "planning",
    planId: null,
    plan: null,
    deviations: [],
    updatedAt: 3,
    ...overrides,
  };
}

function makeDeviation(overrides?: Partial<PlanDeviation>): PlanDeviation {
  return {
    type: "file_out_of_scope",
    stepId: "s1",
    toolCallId: "tc-1",
    path: "outside.txt",
    reason: "File is outside the declared scope",
    detectedAt: 4,
    ...overrides,
  };
}

// ============================================================================
// Harness: stub window.pixApi (real plan store transport)
// ============================================================================

const vuetify = createVuetify({
  components: { ...vuetifyComponents },
  directives: { ...vuetifyDirectives },
});

let sendPlanCommand: ReturnType<typeof vi.fn>;
let onPlanEvent: ReturnType<typeof vi.fn>;
let sendWorkflowCommand: ReturnType<typeof vi.fn>;
let onWorkflowEvent: ReturnType<typeof vi.fn>;
let selectChatFiles: ReturnType<typeof vi.fn>;
let planEventCallback: ((event: PlanEvent) => void) | null;
let wrapper: ReturnType<typeof mount> | undefined;

function installPixApiMock(): void {
  planEventCallback = null;
  sendPlanCommand = vi.fn().mockResolvedValue({ success: true });
  onPlanEvent = vi.fn((callback: (event: PlanEvent) => void) => {
    planEventCallback = callback;
    return () => {};
  });
  sendWorkflowCommand = vi.fn().mockResolvedValue({ success: true, data: [] });
  onWorkflowEvent = vi.fn(() => () => {});
  selectChatFiles = vi.fn().mockResolvedValue([]);
  window.pixApi = {
    sendPlanCommand,
    onPlanEvent,
    sendWorkflowCommand,
    onWorkflowEvent,
    selectChatFiles,
  } as unknown as PixApi;
}

/** Deliver a PlanEvent through the currently registered onPlanEvent callback. */
function emitPlanEvent(event: PlanEvent): void {
  planEventCallback?.(event);
}

/** Plan commands of one type actually sent to main. */
function planCalls(type: PlanCommand["type"]): Array<[PlanCommand]> {
  return (sendPlanCommand.mock.calls as Array<[PlanCommand]>).filter(([cmd]) => cmd.type === type);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        CommandPalette: true,
        ModelSelector: true,
        ThinkingSelector: true,
        ClarificationCard: true,
        ClarificationChip: true,
        TeamDashboard: true,
        WorkerStatusBar: true,
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

beforeEach(() => {
  vi.clearAllMocks();
  rpcMock.state.sessionState.value = null;
  rpcMock.state.isConnected.value = true;
  rpcMock.state.isStreaming.value = false;
  rpcMock.state.executionEnvironment.value = null;
  sessionMock.state.displayBlocks.value = [];
  sessionMock.state.lastRetryableError.value = null;
  teamStoreMock.state.teamMode.value = false;
  projectStoreMock.state.currentProject.value = null;
  installPixApiMock();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = "";
});

// ============================================================================
// Real mount
// ============================================================================

describe("real mount", () => {
  it("mounts CenterPanel with the real PlanModeToggle and PlanPanel", async () => {
    const w = await mountAndFlush();

    // PlanModeToggle is the real component inside the composer.
    const toggle = w.findComponent(PlanModeToggle);
    expect(toggle.exists()).toBe(true);
    expect(toggle.find(".plan-mode-toggle").exists()).toBe(true);

    // PlanPanel is v-if'ed on the plan phase: hidden before the first snapshot.
    expect(w.findComponent(PlanPanel).exists()).toBe(false);

    emitPlanEvent({
      type: "plan_state",
      snapshot: makeSnapshot({ phase: "awaiting_approval", plan: makePlan() }),
    });
    await flushPromises();

    const panel = w.findComponent(PlanPanel);
    expect(panel.exists()).toBe(true);
    expect(w.find('[data-test="plan-panel"]').exists()).toBe(true);
    // The step list renders the real PlanStepCard, not a stub.
    expect(w.findAllComponents(PlanStepCard).length).toBe(1);
    expect(w.get('[data-test="plan-title"]').text()).toContain("实现登录");
    expect(w.get('[data-test="plan-status"]').text()).toBe("待批准");
    expect(w.get('[data-test="plan-version"]').text()).toBe("v1");
    expect(w.get('[data-test="plan-model"]').text()).toBe("anthropic/claude-sonnet-4-6");
    expect(w.get('[data-test="plan-summary"]').text()).toContain("实现登录流程");
  });

  it("does not render an empty PlanPanel for a new session whose snapshot has no plan", async () => {
    const w = await mountAndFlush();

    // The controller's initial snapshot is a sentinel: phase "cancelled" with
    // planId/plan null. A new session must not show a meaningless
    // "已取消" empty panel.
    emitPlanEvent({
      type: "plan_state",
      snapshot: makeSnapshot({ phase: "cancelled" }),
    });
    await flushPromises();

    expect(w.findComponent(PlanPanel).exists()).toBe(false);
  });

  it("still renders the PlanPanel for a genuinely cancelled plan", async () => {
    const w = await mountAndFlush();
    emitPlanEvent({
      type: "plan_state",
      snapshot: makeSnapshot({ phase: "cancelled", plan: makePlan({ status: "cancelled" }) }),
    });
    await flushPromises();

    expect(w.findComponent(PlanPanel).exists()).toBe(true);
    expect(w.find('[data-test="plan-panel"]').exists()).toBe(true);
    expect(w.get('[data-test="plan-status"]').text()).toBe("已取消");
  });
});

// ============================================================================
// Toggle: armed only, never IPC
// ============================================================================

describe("plan toggle", () => {
  it("clicking the toggle only arms the composer and never fires IPC", async () => {
    const w = await mountAndFlush();
    const callsBefore = sendPlanCommand.mock.calls.length;

    const toggle = w.get(".plan-mode-toggle");
    expect(toggle.attributes("role")).toBe("switch");
    expect(toggle.attributes("aria-checked")).toBe("false");
    expect(toggle.attributes("aria-label")).toContain("开启规划模式");
    await toggle.trigger("click");

    expect(toggle.attributes("aria-checked")).toBe("true");
    expect(w.get(".plan-toggle-text").text()).toBe("规划已开启");
    // Only the mount-time get_snapshot; no plan command ever fired on toggle.
    expect(sendPlanCommand.mock.calls.length).toBe(callsBefore);
    expect(rpcMock.state.sendCommandAsync).not.toHaveBeenCalled();
  });

  it("arms via keyboard Enter with switch semantics", async () => {
    const w = await mountAndFlush();
    const toggle = w.get(".plan-mode-toggle");

    await toggle.trigger("keydown", { key: "Enter" });

    expect(toggle.attributes("aria-checked")).toBe("true");
    expect(w.get(".plan-toggle-text").text()).toBe("规划已开启");
    expect(planCalls("enter_planning")).toHaveLength(0);
    expect(rpcMock.state.sendCommandAsync).not.toHaveBeenCalled();
  });

  it("is disabled while streaming with the disable reason shown", async () => {
    rpcMock.state.isStreaming.value = true;
    const w = await mountAndFlush();

    const toggle = w.get(".plan-mode-toggle");
    expect((toggle.element as HTMLButtonElement).disabled).toBe(true);
    expect(w.get(".plan-toggle-disable-reason").text()).toContain("运行中不可切换规划");

    // A disabled toggle never arms, even via keyboard.
    await toggle.trigger("keydown", { key: "Enter" });
    expect(toggle.attributes("aria-checked")).toBe("false");
  });

  it("is disabled while a plan is active with the disable reason shown", async () => {
    const w = await mountAndFlush();
    emitPlanEvent({
      type: "plan_state",
      snapshot: makeSnapshot({ phase: "awaiting_approval", plan: makePlan() }),
    });
    await flushPromises();

    const toggle = w.get(".plan-mode-toggle");
    expect((toggle.element as HTMLButtonElement).disabled).toBe(true);
    expect(w.get(".plan-toggle-disable-reason").text()).toContain("计划进行中，请先批准或放弃");
  });

  it("is disabled on planning_failed with its own disable reason", async () => {
    const w = await mountAndFlush();
    emitPlanEvent({
      type: "plan_state",
      snapshot: makeSnapshot({
        phase: "planning_failed",
        planId: "plan-1",
        failure: {
          generationId: "g-1",
          phase: "initial",
          code: "invalid_plan",
          message: "Invalid plan",
          fieldErrors: [],
          retryable: true,
          occurredAt: 5,
        },
      }),
    });
    await flushPromises();

    const toggle = w.get(".plan-mode-toggle");
    expect((toggle.element as HTMLButtonElement).disabled).toBe(true);
    expect(w.get(".plan-toggle-disable-reason").text()).toContain("规划失败，请先重试或放弃");
  });

  it("is enabled when idle with no disable reason", async () => {
    const w = await mountAndFlush();
    const toggle = w.get(".plan-mode-toggle");
    expect((toggle.element as HTMLButtonElement).disabled).toBe(false);
    expect(w.find(".plan-toggle-disable-reason").exists()).toBe(false);
  });
});

// ============================================================================
// Armed submit: one enter_planning with text + attachments
// ============================================================================

describe("armed submit", () => {
  async function armToggle(w: ReturnType<typeof mount>): Promise<void> {
    await w.get(".plan-mode-toggle").trigger("click");
  }

  async function typeText(w: ReturnType<typeof mount>, text: string): Promise<void> {
    await w.get(".composer-textarea").setValue(text);
  }

  async function addFileAttachment(w: ReturnType<typeof mount>, path: string): Promise<void> {
    selectChatFiles.mockResolvedValue([path]);
    await w.get(".composer-icon-btn").trigger("click");
    await flushPromises();
  }

  it("sends enter_planning exactly once with text and file attachment", async () => {
    const w = await mountAndFlush();
    await armToggle(w);
    await addFileAttachment(w, "C:/proj/src/a.ts");
    await typeText(w, "add tests");

    await w.get(".composer-action-btn.primary-action").trigger("click");
    await flushPromises();

    const calls = planCalls("enter_planning");
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual({
      type: "enter_planning",
      requestText: "add tests",
      filePaths: ["C:/proj/src/a.ts"],
      source: "configured",
    });
    // No ordinary prompt/steer is sent alongside.
    expect(rpcMock.state.sendCommandAsync).not.toHaveBeenCalled();
    // The optimistic user message carries text + paths; input cleared.
    expect(sessionMock.state.appendOptimisticUserMessage).toHaveBeenCalledWith("add tests", ["C:/proj/src/a.ts"]);
    expect((w.get(".composer-textarea").element as HTMLTextAreaElement).value).toBe("");
  });

  it("sends enter_planning with clipboard images when pasted", async () => {
    const w = await mountAndFlush();
    await armToggle(w);
    await typeText(w, "please plan");

    const file = new File(["fake-image"], "shot.png", { type: "image/png" });
    const pasteEvent = new Event("paste", { bubbles: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: { items: [{ type: "image/png", getAsFile: () => file }] },
    });
    w.get(".composer-textarea").element.dispatchEvent(pasteEvent);
    // FileReader resolves on a macrotask in happy-dom; give it a real tick.
    await sleep(30);
    await flushPromises();
    expect(w.findAll(".attachment-chip").length).toBe(1);

    await w.get(".composer-action-btn.primary-action").trigger("click");
    await flushPromises();

    const calls = planCalls("enter_planning");
    expect(calls).toHaveLength(1);
    const command = calls[0][0];
    expect(command.type).toBe("enter_planning");
    if (command.type === "enter_planning") {
      expect(command.requestText).toBe("please plan");
      expect(command.images).toHaveLength(1);
      expect(command.images?.[0].mimeType).toBe("image/png");
      expect(command.images?.[0].base64).not.toBe("");
    }
    expect(rpcMock.state.sendCommandAsync).not.toHaveBeenCalled();
  });

  it("does not call the plan controller for an empty submit", async () => {
    const w = await mountAndFlush();
    await armToggle(w);

    const sendBtn = w.get(".composer-action-btn.primary-action");
    expect((sendBtn.element as HTMLButtonElement).disabled).toBe(true);
    await sendBtn.trigger("click");
    await flushPromises();

    expect(planCalls("enter_planning")).toHaveLength(0);
    expect(rpcMock.state.sendCommandAsync).not.toHaveBeenCalled();
  });

  it("sends an attachment-only submit as a normal prompt while armed, never enter_planning", async () => {
    const w = await mountAndFlush();
    await armToggle(w);
    await addFileAttachment(w, "C:/proj/src/a.ts");

    // An armed attachment-only submit carries an empty requestText, which the
    // controller rejects (empty_request); it must go out as an ordinary
    // prompt instead of enter_planning (§4.9).
    await w.get(".composer-action-btn.primary-action").trigger("click");
    await flushPromises();

    expect(planCalls("enter_planning")).toHaveLength(0);
    expect(rpcMock.state.sendCommandAsync).toHaveBeenCalledWith({
      type: "prompt",
      message: "",
      filePaths: ["C:/proj/src/a.ts"],
      images: undefined,
    });
    expect(sessionMock.state.appendOptimisticUserMessage).toHaveBeenCalledWith("", ["C:/proj/src/a.ts"]);
  });

  it("sends enter_planning only once under rapid double submit", async () => {
    const w = await mountAndFlush();
    await armToggle(w);
    await typeText(w, "build it");

    let resolveSend!: (value: PixCommandResult<PlanRuntimeSnapshot | undefined>) => void;
    sendPlanCommand.mockImplementation(
      () => new Promise<PixCommandResult<PlanRuntimeSnapshot | undefined>>((resolve) => {
        resolveSend = resolve;
      }),
    );

    const sendBtn = w.get(".composer-action-btn.primary-action");
    await sendBtn.trigger("click");
    await sendBtn.trigger("click");
    resolveSend({ success: true });
    await flushPromises();

    expect(planCalls("enter_planning")).toHaveLength(1);
  });

  it("restores the composer and stays armed when enter_planning fails", async () => {
    const w = await mountAndFlush();
    await armToggle(w);
    await addFileAttachment(w, "C:/proj/src/a.ts");
    await typeText(w, "add tests");

    sendPlanCommand.mockResolvedValue({ success: false, error: "规划模型不可用" });
    await w.get(".composer-action-btn.primary-action").trigger("click");
    await flushPromises();

    // Exactly one enter_planning; no prompt fallback, no duplicate user message.
    expect(planCalls("enter_planning")).toHaveLength(1);
    expect(rpcMock.state.sendCommandAsync).not.toHaveBeenCalled();
    expect(sessionMock.state.failOptimisticUserMessage).toHaveBeenCalledWith("optimistic-1", "规划模型不可用");

    // Composer restored: text and attachment are back, armed stays on.
    expect((w.get(".composer-textarea").element as HTMLTextAreaElement).value).toBe("add tests");
    expect(w.findAll(".attachment-chip").length).toBe(1);
    expect(w.get(".plan-mode-toggle").attributes("aria-checked")).toBe("true");
  });
});

// ============================================================================
// Three plan indicators
// ============================================================================

describe("three plan indicators", () => {
  it("shows planning via the toggle, the PlanPanel and the status pill", async () => {
    const w = await mountAndFlush();
    await w.get(".plan-mode-toggle").trigger("click");

    emitPlanEvent({
      type: "plan_state",
      snapshot: makeSnapshot({ phase: "awaiting_approval", plan: makePlan() }),
    });
    await flushPromises();

    // 1. Input-area toggle.
    expect(w.get(".plan-toggle-text").text()).toBe("规划已开启");
    // 2. PlanPanel header (title + status).
    expect(w.find('[data-test="plan-panel"]').exists()).toBe(true);
    expect(w.get('[data-test="plan-status"]').text()).toBe("待批准");
    // 3. CenterPanel session status text.
    expect(w.get(".status-pill").text()).toContain("待批准");
  });

  it("reflects the executing phase in the status pill and progress", async () => {
    const w = await mountAndFlush();
    const steps = [
      makeStep({ stepId: "s1", status: "completed" }),
      makeStep({ stepId: "s2", stepKey: "k2", title: "Step 2", status: "running" }),
      makeStep({ stepId: "s3", stepKey: "k3", title: "Step 3", status: "pending" }),
    ];
    emitPlanEvent({
      type: "plan_state",
      snapshot: makeSnapshot({
        phase: "executing",
        plan: makePlan({ status: "executing", steps }),
      }),
    });
    await flushPromises();

    expect(w.get(".status-pill").text()).toContain("执行中");
    expect(w.get('[data-test="plan-status"]').text()).toBe("执行中");
    // Current running step / total steps.
    expect(w.get('[data-test="plan-progress"]').text()).toBe("2/3");
  });
});

// ============================================================================
// Abandon confirmation
// ============================================================================

describe("abandon confirmation", () => {
  it("requires confirmation before sending cancel for a plan", async () => {
    const w = await mountAndFlush();
    emitPlanEvent({
      type: "plan_state",
      snapshot: makeSnapshot({ phase: "awaiting_approval", plan: makePlan() }),
    });
    await flushPromises();

    await w.get('[data-test="plan-abandon-btn"]').trigger("click");
    expect(w.find('[data-test="plan-abandon-confirm"]').exists()).toBe(true);

    // Cancelling the confirm dialog sends nothing.
    await w.get('[data-test="plan-abandon-cancel"]').trigger("click");
    await flushPromises();
    expect(planCalls("cancel")).toHaveLength(0);
    expect(w.find('[data-test="plan-abandon-confirm"]').exists()).toBe(false);

    // Confirming sends cancel with planId + version.
    await w.get('[data-test="plan-abandon-btn"]').trigger("click");
    await w.get('[data-test="plan-abandon-confirm-btn"]').trigger("click");
    await flushPromises();
    expect(planCalls("cancel")).toHaveLength(1);
    expect(planCalls("cancel")[0][0]).toEqual({ type: "cancel", planId: "plan-1", version: 1 });
  });

  it("abandons a planning without a plan via planId + generationId", async () => {
    const w = await mountAndFlush();
    const snapshot = makeSnapshot({
      phase: "planning_failed",
      planId: "plan-1",
      generation: {
        generationId: "g-1",
        kind: "initial",
        requestedVersion: 1,
        concise: false,
        model: { provider: "anthropic", modelId: "claude-sonnet-4-6", thinkingLevel: "medium" },
        startedAt: 1,
      },
      failure: {
        generationId: "g-1",
        phase: "initial",
        code: "invalid_plan",
        message: "Invalid plan",
        fieldErrors: [],
        retryable: true,
        occurredAt: 5,
      },
    });
    sendPlanCommand.mockResolvedValue({ success: true, data: snapshot });
    emitPlanEvent({ type: "plan_state", snapshot });
    await flushPromises();

    await w.get('[data-test="plan-abandon-failure"]').trigger("click");
    await w.get('[data-test="plan-abandon-confirm-btn"]').trigger("click");
    await flushPromises();

    expect(planCalls("cancel")).toHaveLength(1);
    expect(planCalls("cancel")[0][0]).toEqual({ type: "cancel", planId: "plan-1", generationId: "g-1" });
  });
});

// ============================================================================
// 300ms busy progress + double-submit protection + explicit start
// ============================================================================

describe("approval flow", () => {
  it("approves then explicitly starts execution, in order, with 300ms progress", async () => {
    const w = await mountAndFlush();
    emitPlanEvent({
      type: "plan_state",
      snapshot: makeSnapshot({ phase: "awaiting_approval", plan: makePlan() }),
    });
    await flushPromises();

    let resolveApprove!: (value: PixCommandResult<PlanRuntimeSnapshot | undefined>) => void;
    sendPlanCommand.mockImplementation(
      (cmd: PlanCommand) =>
        new Promise<PixCommandResult<PlanRuntimeSnapshot | undefined>>((resolve) => {
          if (cmd.type === "approve") {
            resolveApprove = resolve;
          } else if (cmd.type === "start_execution") {
            resolve({ success: true });
          } else {
            resolve({ success: true });
          }
        }),
    );

    const approveBtn = w.get('[data-test="plan-approve-btn"]');
    await approveBtn.trigger("click");

    // Approve is still in flight: the button shows the busy progress state and
    // cannot be re-triggered.
    expect(approveBtn.text()).toContain("处理中");
    expect((approveBtn.element as HTMLButtonElement).disabled).toBe(true);
    await approveBtn.trigger("click");
    expect(planCalls("approve")).toHaveLength(1);

    resolveApprove({ success: true, data: makeSnapshot({ phase: "approved", plan: makePlan({ status: "approved" }) }) });
    await sleep(350);
    await flushPromises();

    // approve then start_execution, exactly once each, in that order.
    expect(planCalls("approve")).toHaveLength(1);
    expect(planCalls("start_execution")).toHaveLength(1);
    expect(sendPlanCommand.mock.calls.findIndex(([c]) => c.type === "approve")).toBeLessThan(
      sendPlanCommand.mock.calls.findIndex(([c]) => c.type === "start_execution"),
    );

    // Phase moved to approved: the explicit start button is idle again.
    const startBtn = w.get('[data-test="plan-start-btn"]');
    expect(startBtn.text()).toBe("开始执行");
    expect((startBtn.element as HTMLButtonElement).disabled).toBe(false);
  });

  it("stops at approved (read-only) and starts execution only on explicit click", async () => {
    const w = await mountAndFlush();
    emitPlanEvent({
      type: "plan_state",
      snapshot: makeSnapshot({ phase: "approved", plan: makePlan({ status: "approved" }) }),
    });
    await flushPromises();

    const startBtn = w.get('[data-test="plan-start-btn"]');
    await startBtn.trigger("click");
    await flushPromises();

    expect(planCalls("approve")).toHaveLength(0);
    expect(planCalls("start_execution")).toHaveLength(1);
    expect(planCalls("start_execution")[0][0]).toEqual({ type: "start_execution", planId: "plan-1", version: 1 });
  });

  it("keeps the paused plan actionable via continue and abandon", async () => {
    const w = await mountAndFlush();
    emitPlanEvent({
      type: "plan_state",
      snapshot: makeSnapshot({ phase: "paused", plan: makePlan({ status: "paused" }) }),
    });
    await flushPromises();

    await w.get('[data-test="plan-continue-btn"]').trigger("click");
    await flushPromises();
    expect(planCalls("continue_plan")).toHaveLength(1);
    expect(planCalls("continue_plan")[0][0]).toEqual({ type: "continue_plan", planId: "plan-1", version: 1 });
  });

  it("hides continue when a paused plan has a failed step", async () => {
    const w = await mountAndFlush();
    emitPlanEvent({
      type: "plan_state",
      snapshot: makeSnapshot({
        phase: "paused",
        plan: makePlan({
          status: "paused",
          steps: [makeStep({ status: "failed" })],
        }),
      }),
    });
    await flushPromises();
    expect(w.find('[data-test="plan-continue-btn"]').exists()).toBe(false);
  });

  it("shows a progress indicator while the plan is being generated", async () => {
    const w = await mountAndFlush();
    emitPlanEvent({
      type: "plan_state",
      snapshot: makeSnapshot({ phase: "planning", planId: "plan-1" }),
    });
    await flushPromises();

    const generating = w.find('[data-test="plan-generating"]');
    expect(generating.exists()).toBe(true);
    expect(generating.text()).toContain("正在生成计划");
  });

  it("surfaces command errors next to the panel with a dismiss action", async () => {
    const w = await mountAndFlush();
    emitPlanEvent({
      type: "plan_state",
      snapshot: makeSnapshot({ phase: "approved", plan: makePlan({ status: "approved" }) }),
    });
    await flushPromises();

    sendPlanCommand.mockResolvedValue({ success: false, error: "read_only", code: "read_only" });
    await w.get('[data-test="plan-start-btn"]').trigger("click");
    await flushPromises();

    expect(w.get('[data-test="plan-command-error"]').text()).toContain("read_only");
    await w.get('[data-test="plan-error-dismiss"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="plan-command-error"]').exists()).toBe(false);
  });
});

// ============================================================================
// Step list: files, long text, non-color status/risk, deviations
// ============================================================================

describe("step list", () => {
  function planWithStep(step: PlanStep, extraSteps: PlanStep[] = []): Plan {
    return makePlan({ steps: [step, ...extraSteps] });
  }

  async function mountAwaiting(plan: Plan): Promise<ReturnType<typeof mount>> {
    const w = await mountAndFlush();
    emitPlanEvent({ type: "plan_state", snapshot: makeSnapshot({ phase: "awaiting_approval", plan }) });
    await flushPromises();
    return w;
  }

  it("reveals the full path when a file chip is clicked", async () => {
    const step = makeStep({
      files: [{ path: "src/features/login.ts", operation: "modify" }],
    });
    const w = await mountAwaiting(planWithStep(step));

    await w.get(".plan-step-toggle").trigger("click");
    await w.get(".plan-file-chip").trigger("click");

    expect(w.get(".plan-file-path").text()).toContain("完整路径：src/features/login.ts");
    // The chip carries the full path in its title for the file locator.
    expect(w.get(".plan-file-chip").attributes("title")).toBe("src/features/login.ts");
  });

  it("collapses long descriptions with an expand/collapse control", async () => {
    const longDescription = "很长的描述".repeat(40);
    const step = makeStep({ description: longDescription });
    const w = await mountAwaiting(planWithStep(step));

    await w.get(".plan-step-toggle").trigger("click");
    const expandBtn = w.get(".text-expand-btn");
    expect(expandBtn.text()).toBe("展开");
    expect(w.get(".plan-step-description").text()).toContain("…");

    await expandBtn.trigger("click");
    expect(w.get(".plan-step-description").text()).toContain("很长的描述".repeat(40));
    expect(w.get(".text-expand-btn").text()).toBe("收起");
  });

  it("conveys step status and risk with icon AND text, not color alone", async () => {
    const step = makeStep({ status: "failed", risk: "high", riskReason: "改动了公共模块" });
    const w = await mountAwaiting(planWithStep(step));

    await w.get(".plan-step-toggle").trigger("click");
    // Status: text label + icon element.
    expect(w.get(".plan-step-status-text").text()).toBe("失败");
    expect(w.get(".step-status-icon").find("i").exists()).toBe(true);
    // Risk: text label + icon element.
    expect(w.get(".plan-step-risk").text()).toContain("高风险");
    expect(w.get(".plan-step-risk").find("i").exists()).toBe(true);
  });

  it("marks deviations next to the step with icon and text", async () => {
    const step = makeStep({});
    const deviation = makeDeviation({ reason: "File is outside the declared scope" });
    const w = await mountAndFlush();
    emitPlanEvent({
      type: "plan_state",
      snapshot: makeSnapshot({
        phase: "awaiting_approval",
        plan: planWithStep(step),
        deviations: [deviation],
      }),
    });
    await flushPromises();

    const deviationBox = w.find(".plan-step-deviation");
    expect(deviationBox.exists()).toBe(true);
    expect(deviationBox.text()).toContain("File is outside the declared scope");
    expect(deviationBox.text()).toContain("outside.txt");
    expect(deviationBox.find("i").exists()).toBe(true);
  });

  it("offers retry next to a failed step (error next to step, with next action)", async () => {
    const step = makeStep({ status: "failed" });
    const w = await mountAwaiting(planWithStep(step));

    await w.get(".plan-step-toggle").trigger("click");
    await w.get(".plan-step-retry-btn").trigger("click");
    await flushPromises();

    expect(planCalls("retry_step")).toHaveLength(1);
    expect(planCalls("retry_step")[0][0]).toEqual({ type: "retry_step", planId: "plan-1", version: 1, stepId: "s1" });
  });
});

// ============================================================================
// Error recovery: no dead ends
// ============================================================================

describe("error recovery", () => {
  function failedSnapshot(overrides: {
    phase?: PlanRuntimeSnapshot["phase"];
    code?: NonNullable<PlanRuntimeSnapshot["failure"]>["code"];
    failurePhase?: "initial" | "revision";
    message?: string;
    revision?: PlanRuntimeSnapshot["revision"];
  } = {}): PlanRuntimeSnapshot {
    return makeSnapshot({
      phase: overrides.phase ?? "planning_failed",
      planId: "plan-1",
      failure: {
        generationId: "g-1",
        phase: overrides.failurePhase ?? "initial",
        code: overrides.code ?? "invalid_plan",
        message: overrides.message ?? "计划校验失败",
        fieldErrors: [],
        retryable: true,
        occurredAt: 5,
      },
      ...(overrides.revision ? { revision: overrides.revision } : {}),
      ...(overrides.phase === "revising" ? { plan: makePlan({ status: "revising" }) } : {}),
    });
  }

  it("offers retry generation, session-model retry and abandon on planning_failed", async () => {
    const snapshot = failedSnapshot();
    sendPlanCommand.mockResolvedValue({ success: true, data: snapshot });
    const w = await mountAndFlush();
    emitPlanEvent({ type: "plan_state", snapshot });
    await flushPromises();

    expect(w.get('[data-test="plan-failure"]').text()).toContain("计划校验失败");
    await w.get('[data-test="plan-retry-generation"]').trigger("click");
    await flushPromises();
    expect(planCalls("retry_generation")).toHaveLength(1);
    expect(planCalls("retry_generation")[0][0]).toEqual({ type: "retry_generation", generationId: "g-1" });

    // Each action keeps its 300ms busy window (double-submit protection); wait
    // it out before triggering the next recovery action.
    await sleep(350);
    await w.get('[data-test="plan-use-session-model"]').trigger("click");
    await flushPromises();
    expect(planCalls("use_session_model_and_retry")).toHaveLength(1);
    expect(planCalls("use_session_model_and_retry")[0][0]).toEqual({
      type: "use_session_model_and_retry",
      generationId: "g-1",
    });
  });

  it("offers concise regeneration for a truncated generation", async () => {
    const snapshot = failedSnapshot({ code: "truncated", message: "计划被截断" });
    sendPlanCommand.mockResolvedValue({ success: true, data: snapshot });
    const w = await mountAndFlush();
    emitPlanEvent({ type: "plan_state", snapshot });
    await flushPromises();

    await w.get('[data-test="plan-regenerate-concise"]').trigger("click");
    await flushPromises();
    expect(planCalls("regenerate_plan")).toHaveLength(1);
    expect(planCalls("regenerate_plan")[0][0]).toEqual({ type: "regenerate_plan", generationId: "g-1", concise: true });
  });

  it("offers retry revision and return-to-previous after a revision failure", async () => {
    const snapshot = failedSnapshot({
      phase: "revising",
      failurePhase: "revision",
      message: "修订校验失败",
      revision: { baseVersion: 1, requestedVersion: 2, feedback: "more detail" },
    });
    sendPlanCommand.mockResolvedValue({ success: true, data: snapshot });
    const w = await mountAndFlush();
    emitPlanEvent({ type: "plan_state", snapshot });
    await flushPromises();

    // Retry revision issues retry_generation (accepted by the controller from
    // phase revising) carrying the failed generation, never request_revision
    // (rejected while revising).
    await w.get('[data-test="plan-retry-revision"]').trigger("click");
    await flushPromises();
    expect(planCalls("retry_generation")).toHaveLength(1);
    expect(planCalls("retry_generation")[0][0]).toEqual({ type: "retry_generation", generationId: "g-1" });
    expect(planCalls("request_revision")).toHaveLength(0);

    // 300ms busy window guards double submission; wait it out before the next action.
    await sleep(350);
    await w.get('[data-test="plan-return-previous"]').trigger("click");
    await flushPromises();
    expect(planCalls("return_previous_version")).toHaveLength(1);
    expect(planCalls("return_previous_version")[0][0]).toEqual({
      type: "return_previous_version",
      planId: "plan-1",
      baseVersion: 1,
    });

    // Abandon during a failed revision falls back to the previous version
    // (cancel is not accepted from revising); the user can then cancel the
    // whole plan from the awaiting_approval footer.
    await sleep(350);
    await w.get('[data-test="plan-abandon-failure"]').trigger("click");
    expect(w.get('[data-test="plan-abandon-confirm"]').text()).toContain("放弃本次修订");
    await w.get('[data-test="plan-abandon-confirm-btn"]').trigger("click");
    await flushPromises();
    expect(planCalls("return_previous_version")).toHaveLength(2);
    expect(planCalls("cancel")).toHaveLength(0);
  });

  it("surfaces a revision failure that arrives without a phase change", async () => {
    // Real controller timeline: the failure plan_state update keeps
    // phase=revising and only sets failure, so the panel must react to the
    // store failure ref instead of a phase-change-triggered snapshot re-read.
    const w = await mountAndFlush();

    // 1) Revision starts: revising, no failure yet.
    emitPlanEvent({
      type: "plan_state",
      snapshot: makeSnapshot({
        phase: "revising",
        planId: "plan-1",
        plan: makePlan({ status: "revising" }),
        revision: { baseVersion: 1, requestedVersion: 2, feedback: "more detail" },
      }),
    });
    await flushPromises();
    expect(w.get('[data-test="plan-generating"]').text()).toContain("正在修订计划");
    expect(w.find('[data-test="plan-failure"]').exists()).toBe(false);

    // 2) Generation fails seconds later: phase stays revising, failure set.
    emitPlanEvent({
      type: "plan_state",
      snapshot: failedSnapshot({
        phase: "revising",
        failurePhase: "revision",
        message: "修订校验失败",
        revision: { baseVersion: 1, requestedVersion: 2, feedback: "more detail" },
      }),
    });
    await flushPromises();

    // Spinner is gone; the failure block with recovery actions appears.
    expect(w.find('[data-test="plan-generating"]').exists()).toBe(false);
    expect(w.get('[data-test="plan-failure"]').text()).toContain("修订校验失败");

    // The retry action targets the failed generation from phase revising.
    await w.get('[data-test="plan-retry-revision"]').trigger("click");
    await flushPromises();
    expect(planCalls("retry_generation")).toHaveLength(1);
    expect(planCalls("retry_generation")[0][0]).toEqual({ type: "retry_generation", generationId: "g-1" });
    expect(planCalls("request_revision")).toHaveLength(0);
  });
});

// ============================================================================
// Keyboard / aria (composer, toggles, step cards)
// ============================================================================

describe("keyboard and aria", () => {
  it("submits the composer with Enter and sends a normal prompt when not armed", async () => {
    const w = await mountAndFlush();
    await w.get(".composer-textarea").setValue("hello");
    await w.get(".composer-textarea").trigger("keydown", { key: "Enter" });
    await flushPromises();

    expect(rpcMock.state.sendCommandAsync).toHaveBeenCalledWith({
      type: "prompt",
      message: "hello",
      filePaths: undefined,
      images: undefined,
    });
    expect(planCalls("enter_planning")).toHaveLength(0);
  });

  it("exposes aria-expanded on the step toggle and expandable sections", async () => {
    const w = await mountAndFlush();
    emitPlanEvent({
      type: "plan_state",
      snapshot: makeSnapshot({
        phase: "awaiting_approval",
        plan: makePlan({ steps: [makeStep({ description: "x".repeat(200) })] }),
      }),
    });
    await flushPromises();

    const stepToggle = w.get(".plan-step-toggle");
    expect(stepToggle.attributes("aria-expanded")).toBe("false");
    await stepToggle.trigger("click");
    expect(stepToggle.attributes("aria-expanded")).toBe("true");
    expect(stepToggle.attributes("aria-controls")).toBe("plan-step-body-s1");
  });

  it("keeps the panel actions as focusable buttons with accessible labels", async () => {
    const w = await mountAndFlush();
    emitPlanEvent({
      type: "plan_state",
      snapshot: makeSnapshot({ phase: "awaiting_approval", plan: makePlan() }),
    });
    await flushPromises();

    for (const selector of [
      '[data-test="plan-approve-btn"]',
      '[data-test="plan-revise-btn"]',
      '[data-test="plan-abandon-btn"]',
    ]) {
      const btn = w.get(selector);
      expect((btn.element as HTMLButtonElement).tagName).toBe("BUTTON");
      expect(btn.text().trim().length).toBeGreaterThan(0);
    }
    expect(w.get('[data-test="plan-panel"]').attributes("aria-label")).toContain("计划面板");
  });
});
