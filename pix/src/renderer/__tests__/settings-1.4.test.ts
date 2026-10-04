/**
 * Settings 1.4.x tests (stages P5, B8).
 *
 * 1.4.0 (P5): the real SettingsPage delivers plan-model / plan-thinking /
 * anonymous-analytics settings; the settings store mirrors and saves them;
 * the analytics switch stays strictly independent of install telemetry.
 * 1.4.1 (B8): autoBackgroundMs is added to GuiSettings - the settings store
 * mirrors and saves it (default 0 / off), the SettingsPage offers
 * off/60/120/300 thresholds, and the main SettingsStore migrates the
 * persisted schema 3 -> 4 idempotently without writing the optional field.
 * The 1.4.0 assertions must not regress.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
// Use the pre-bundled dist entry: the ESM lib entry imports per-component CSS
// files, which a Node-side externalized import cannot load in happy-dom.
import { components as vuetifyComponents, createVuetify, directives as vuetifyDirectives } from "vuetify/dist/vuetify.js";
import type { PixApi } from "../../main/preload";
import { SettingsStore } from "../../main/settings-store";
import type { GuiSettings, ModelInfo } from "@shared/types.js";
import { useAuthStore } from "../stores/auth-store";
import { useSettingsStore } from "../stores/settings-store";
import SettingsPage from "../pages/SettingsPage.vue";

// ============================================================================
// Mocks
// ============================================================================

// SettingsPage and the stores only talk to main through window.pixApi and the
// useWorkspaceRpc composable, so both are stubbed - no Electron runtime loads.
const rpcMock = vi.hoisted(() => ({
  state: {
    availableModels: { value: [] as ModelInfo[] },
    isConnected: { value: true },
    getPiSettings: vi.fn().mockResolvedValue({}),
    getAuthStatus: vi.fn().mockResolvedValue({}),
    getCustomProviders: vi.fn().mockResolvedValue({ providers: {} }),
    refreshModels: vi.fn().mockResolvedValue(undefined),
    refreshState: vi.fn().mockResolvedValue(undefined),
    refreshCommands: vi.fn().mockResolvedValue(undefined),
    setPiSettings: vi.fn().mockResolvedValue(undefined),
    reloadResources: vi.fn().mockResolvedValue(undefined),
    setApiKey: vi.fn().mockResolvedValue(undefined),
    removeAuth: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../composables/useWorkspaceRpc", () => ({
  useWorkspaceRpc: () => ({
    availableModels: rpcMock.state.availableModels,
    isConnected: rpcMock.state.isConnected,
    getPiSettings: rpcMock.state.getPiSettings,
    getAuthStatus: rpcMock.state.getAuthStatus,
    getCustomProviders: rpcMock.state.getCustomProviders,
    refreshModels: rpcMock.state.refreshModels,
    refreshState: rpcMock.state.refreshState,
    refreshCommands: rpcMock.state.refreshCommands,
    setPiSettings: rpcMock.state.setPiSettings,
    reloadResources: rpcMock.state.reloadResources,
    setApiKey: rpcMock.state.setApiKey,
    removeAuth: rpcMock.state.removeAuth,
  }),
}));

const navigationMock = vi.hoisted(() => ({ back: vi.fn() }));
vi.mock("vue-router", () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ back: navigationMock.back }),
}));

// ============================================================================
// Harness
// ============================================================================

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
  } as unknown as PixApi;
}

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

/** Open the 规划 section through the sidebar, as a user would. */
async function openPlanSection(page: ReturnType<typeof mount>): Promise<void> {
  const item = page.findAll(".sidebar-item").find((el) => el.text().includes("规划"));
  expect(item, "sidebar 规划 entry exists").toBeTruthy();
  await item!.trigger("click");
  await flushPromises();
}

/** Emit the selection Vuetify would emit when the user picks an item. */
async function pickSelectOption(page: ReturnType<typeof mount>, dataTest: string, value: string): Promise<void> {
  const vueSelect = page.getComponent(`[data-test="${dataTest}"]`) as VueWrapper;
  await vueSelect.vm.$emit("update:modelValue", value);
  await flushPromises();
}

async function clickSave(page: ReturnType<typeof mount>): Promise<void> {
  const saveBtn = page.findAll("button.v-btn").find((b) => b.text().includes("保存设置"));
  expect(saveBtn, "save button exists").toBeTruthy();
  await saveBtn!.trigger("click");
  await flushPromises();
}

function lastSetSettingsCall(): Partial<GuiSettings> {
  expect(setSettingsMock).toHaveBeenCalled();
  return setSettingsMock.mock.calls[setSettingsMock.mock.calls.length - 1][0] as Partial<GuiSettings>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('visualViewport', {
    addEventListener: () => {}, removeEventListener: () => {},
    width: 1024, height: 768, offsetLeft: 0, offsetTop: 0, scale: 1, pageLeft: 0, pageTop: 0,
  });
  pinia = createPinia();
  setActivePinia(pinia);
  // Restore hoisted defaults (clearAllMocks keeps implementations).
  rpcMock.state.availableModels.value = [];
  rpcMock.state.isConnected.value = true;
  rpcMock.state.getPiSettings.mockResolvedValue({});
  rpcMock.state.getAuthStatus.mockResolvedValue({});
  rpcMock.state.getCustomProviders.mockResolvedValue({ providers: {} });
  installPixApiMock();
});

afterEach(() => {
  wrapper?.unmount();
  vi.unstubAllGlobals();
  wrapper = undefined;
  document.body.innerHTML = "";
});

// ============================================================================
// Settings store mirror (1.4.0 fields)
// ============================================================================

describe("settings store (1.4.0)", () => {
  it("mirrors planModel/planThinkingLevel/enableProductAnalytics from load()", async () => {
    const store = useSettingsStore();
    getSettingsMock.mockResolvedValue({
      theme: "light",
      recentProjects: [],
      planModel: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
      planThinkingLevel: "high",
      enableProductAnalytics: true,
    });

    await store.load();

    expect(store.planModel).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-6" });
    expect(store.planThinkingLevel).toBe("high");
    expect(store.enableProductAnalytics).toBe(true);
  });

  it("defaults enableProductAnalytics to false and plan settings to inherit when absent", async () => {
    const store = useSettingsStore();
    getSettingsMock.mockResolvedValue({ theme: "light", recentProjects: [] });

    await store.load();

    expect(store.enableProductAnalytics).toBe(false);
    expect(store.planModel).toBeUndefined();
    expect(store.planThinkingLevel).toBeUndefined();
  });

  it("persists the new fields through save() and updates the mirror", async () => {
    const store = useSettingsStore();
    await store.load();

    await store.save({
      planModel: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
      planThinkingLevel: "high",
      enableProductAnalytics: true,
    });

    expect(setSettingsMock).toHaveBeenCalledWith({
      planModel: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
      planThinkingLevel: "high",
      enableProductAnalytics: true,
    });
    expect(store.planModel).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-6" });
    expect(store.planThinkingLevel).toBe("high");
    expect(store.enableProductAnalytics).toBe(true);
  });

  it("keeps WSL and default-model behavior unchanged", async () => {
    const store = useSettingsStore();
    await store.load();

    await store.saveWslSettings({ enabled: true, distro: "Ubuntu", defaultCwd: "/home" });
    await store.save({
      defaultModel: "claude-opus-4-6",
      defaultProvider: "anthropic",
      enableProductAnalytics: true,
    });

    expect(store.wslSettings).toEqual({ enabled: true, distro: "Ubuntu", defaultCwd: "/home" });
    expect(store.settings.defaultModel).toBe("claude-opus-4-6");
    expect(store.settings.defaultProvider).toBe("anthropic");
    expect(store.enableProductAnalytics).toBe(true);
  });
});

// ============================================================================
// SettingsPage plan section (real mount)
// ============================================================================

describe("SettingsPage plan section (1.4.0)", () => {
  it("places planning controls in 规划 and analytics in 高级", async () => {
    const page = mountPage();
    await flushPromises();
    await openPlanSection(page);

    const modelSelect = page.get('[data-test="plan-model-select"]');
    expect(modelSelect.isVisible()).toBe(true);
    expect(modelSelect.text()).toContain("继承当前会话模型");

    const thinkingSelect = page.get('[data-test="plan-thinking-select"]');
    expect(thinkingSelect.isVisible()).toBe(true);
    expect(thinkingSelect.text()).toContain("继承会话默认");

    const analytics = page.get('[data-test="analytics-switch"]');
    expect(analytics.isVisible()).toBe(false);
    await page.findAll(".sidebar-item").find((el) => el.text() === "高级")!.trigger("click");
    expect(analytics.isVisible()).toBe(true);
    expect(analytics.text()).toContain("匿名使用数据");
    const checkbox = analytics.find("input");
    expect(checkbox.element.checked).toBe(false);
  });

  it("hydrates persisted plan settings on mount", async () => {
    getSettingsMock.mockResolvedValue({
      theme: "light",
      recentProjects: [],
      planModel: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
      planThinkingLevel: "high",
      enableProductAnalytics: true,
    });
    rpcMock.state.availableModels.value = [
      { provider: "anthropic", id: "claude-sonnet-4-6", contextWindow: 200000 },
    ];
    rpcMock.state.getAuthStatus.mockResolvedValue({ anthropic: { configured: true, source: "models.json" } });

    const page = mountPage();
    await flushPromises();
    await openPlanSection(page);

    expect(page.get('[data-test="plan-model-select"]').text()).toContain("anthropic/claude-sonnet-4-6");
    expect(page.get('[data-test="plan-thinking-select"]').text()).toContain("high");
    expect(page.get('[data-test="analytics-switch"]').find("input").element.checked).toBe(true);
  });

  it("saves model/thinking/analytics and never touches install telemetry", async () => {
    rpcMock.state.availableModels.value = [
      { provider: "anthropic", id: "claude-sonnet-4-6", contextWindow: 200000 },
    ];
    rpcMock.state.getAuthStatus.mockResolvedValue({ anthropic: { configured: true, source: "models.json" } });

    const page = mountPage();
    await flushPromises();
    await openPlanSection(page);

    await pickSelectOption(page, "plan-model-select", "anthropic/claude-sonnet-4-6");
    await pickSelectOption(page, "plan-thinking-select", "high");
    await page.get('[data-test="analytics-switch"]').find("input").setValue(true);
    await clickSave(page);

    const call = lastSetSettingsCall();
    expect(call.planModel).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-6" });
    expect(call.planThinkingLevel).toBe("high");
    expect(call.enableProductAnalytics).toBe(true);
    // Strict separation (Plan §7): analytics is a GuiSettings field and the
    // save payload never carries the install-telemetry flag.
    expect(call).not.toHaveProperty("enableInstallTelemetry");
  });

  it("persists undefined when the plan model and thinking stay inherited", async () => {
    const page = mountPage();
    await flushPromises();
    await openPlanSection(page);
    await clickSave(page);

    const call = lastSetSettingsCall();
    expect(call.planModel).toBeUndefined();
    expect(call.planThinkingLevel).toBeUndefined();
    expect(call.enableProductAnalytics).toBe(false);
    expect(call).not.toHaveProperty("enableInstallTelemetry");
  });

  it("offers only configured providers plus the inherit option", async () => {
    rpcMock.state.availableModels.value = [
      { provider: "anthropic", id: "claude-sonnet-4-6", contextWindow: 200000 },
      { provider: "openai", id: "gpt-5" },
    ];
    rpcMock.state.getAuthStatus.mockResolvedValue({
      anthropic: { configured: true, source: "models.json", label: "Anthropic" },
      openai: { configured: false },
    });

    const page = mountPage();
    await flushPromises();
    await openPlanSection(page);

    const items = (
      page.getComponent('[data-test="plan-model-select"]') as VueWrapper<{
        $props: { items: Array<{ title: string; value: string }> };
      }>
    ).props("items");
    const titles = items.map((item) => item.title);
    expect(titles).toContain("继承当前会话模型");
    expect(titles).toContain("anthropic/claude-sonnet-4-6");
    expect(titles).not.toContain("openai/gpt-5");
    expect(items[0].value).toBe("");
  });
});

// ============================================================================
// Settings store mirror (1.4.1 field)
// ============================================================================

describe("settings store (1.4.1 autoBackgroundMs)", () => {
  it("mirrors autoBackgroundMs from load()", async () => {
    const store = useSettingsStore();
    getSettingsMock.mockResolvedValue({
      theme: "light",
      recentProjects: [],
      autoBackgroundMs: 60_000,
    });

    await store.load();

    expect(store.autoBackgroundMs).toBe(60_000);
  });

  it("defaults autoBackgroundMs to 0 when absent", async () => {
    const store = useSettingsStore();
    getSettingsMock.mockResolvedValue({ theme: "light", recentProjects: [] });

    await store.load();

    expect(store.autoBackgroundMs).toBe(0);
  });

  it("persists autoBackgroundMs through save() and updates the mirror", async () => {
    const store = useSettingsStore();
    await store.load();

    await store.save({ autoBackgroundMs: 0 });

    expect(setSettingsMock).toHaveBeenCalledWith({ autoBackgroundMs: 0 });
    expect(store.autoBackgroundMs).toBe(0);
  });
});

describe("settings store (agentTaskMaxConcurrent)", () => {
  it("defaults agentTaskMaxConcurrent to 4 when absent", async () => {
    const store = useSettingsStore();
    getSettingsMock.mockResolvedValue({ theme: "light", recentProjects: [] });

    await store.load();

    expect(store.agentTaskMaxConcurrent).toBe(4);
  });

  it("mirrors agentTaskMaxConcurrent from load()", async () => {
    const store = useSettingsStore();
    getSettingsMock.mockResolvedValue({
      theme: "light",
      recentProjects: [],
      agentTaskMaxConcurrent: 8,
    });

    await store.load();

    expect(store.agentTaskMaxConcurrent).toBe(8);
  });

  it("persists agentTaskMaxConcurrent through save() and updates the mirror", async () => {
    const store = useSettingsStore();
    await store.load();

    await store.save({ agentTaskMaxConcurrent: 6 });

    expect(setSettingsMock).toHaveBeenCalledWith({ agentTaskMaxConcurrent: 6 });
    expect(store.agentTaskMaxConcurrent).toBe(6);
  });
});

// ============================================================================
// SettingsPage auto-background control (1.4.1, real mount)
// ============================================================================

/** Emit the numeric selection Vuetify would emit for the auto-background select. */
async function pickAutoBackground(page: ReturnType<typeof mount>, value: number): Promise<void> {
  const vueSelect = (page.getComponent('[data-test="auto-background-select"]') as VueWrapper) as VueWrapper;
  await vueSelect.vm.$emit("update:modelValue", value);
  await flushPromises();
}

describe("SettingsPage auto background (1.4.1)", () => {
  it("offers off/60/120/300 thresholds and defaults to 关闭 when absent", async () => {
    const page = mountPage();
    await flushPromises();
    await openPlanSection(page);

    const select = page.get('[data-test="auto-background-select"]');
    expect(select.isVisible()).toBe(true);
    expect(select.text()).toContain("关闭");

    const items = (
      (page.getComponent('[data-test="auto-background-select"]') as VueWrapper) as VueWrapper<{
        $props: { items: Array<{ title: string; value: number }> };
      }>
    ).props("items");
    expect(items.map((item) => item.value)).toEqual([0, 60_000, 120_000, 300_000]);
    expect(items.map((item) => item.title)).toEqual(["关闭", "1 分钟", "2 分钟", "5 分钟"]);
  });

  it("hydrates a persisted threshold on mount", async () => {
    getSettingsMock.mockResolvedValue({
      theme: "light",
      recentProjects: [],
      autoBackgroundMs: 300_000,
    });

    const page = mountPage();
    await flushPromises();
    await openPlanSection(page);

    expect(page.get('[data-test="auto-background-select"]').text()).toContain("5 分钟");
  });

  it("saves the selected threshold, including off", async () => {
    const page = mountPage();
    await flushPromises();
    await openPlanSection(page);

    // After the first save the button reads 已保存！ for 2 s, so locate it by
    // its .settings-actions container instead of the text label.
    const saveBtn = () => page.find(".settings-actions button.v-btn");

    await pickAutoBackground(page, 300_000);
    await saveBtn().trigger("click");
    await flushPromises();
    expect(lastSetSettingsCall().autoBackgroundMs).toBe(300_000);

    await pickAutoBackground(page, 0);
    await saveBtn().trigger("click");
    await flushPromises();
    expect(lastSetSettingsCall().autoBackgroundMs).toBe(0);
  });
});

describe("SettingsPage concurrent slots slider", () => {
  it("defaults to 4 and is a 1–8 discrete slider", async () => {
    const page = mountPage();
    await flushPromises();
    await openPlanSection(page);

    const slider = page.getComponent('[data-test="agent-task-max-concurrent-slider"]') as VueWrapper<{
      $props: { min: number; max: number; step: number; modelValue: number };
    }>;
    expect(slider.props("min")).toBe(1);
    expect(slider.props("max")).toBe(8);
    expect(slider.props("step")).toBe(1);
    expect(slider.props("modelValue")).toBe(4);
  });

  it("hydrates a persisted cap on mount", async () => {
    getSettingsMock.mockResolvedValue({
      theme: "light",
      recentProjects: [],
      agentTaskMaxConcurrent: 8,
    });

    const page = mountPage();
    await flushPromises();
    await openPlanSection(page);

    const slider = page.getComponent('[data-test="agent-task-max-concurrent-slider"]') as VueWrapper<{
      $props: { modelValue: number };
    }>;
    expect(slider.props("modelValue")).toBe(8);
  });

  it("saves the chosen cap", async () => {
    const page = mountPage();
    await flushPromises();
    await openPlanSection(page);

    const slider = page.getComponent('[data-test="agent-task-max-concurrent-slider"]') as VueWrapper;
    await slider.vm.$emit("update:modelValue", 6);
    await flushPromises();

    const saveBtn = page.find(".settings-actions button.v-btn");
    await saveBtn.trigger("click");
    await flushPromises();
    expect(lastSetSettingsCall().agentTaskMaxConcurrent).toBe(6);
  });
});

describe("SettingsPage concurrent slots slider", () => {
  it("defaults to 4 and is a 1–8 discrete slider", async () => {
    const page = mountPage();
    await flushPromises();
    await openPlanSection(page);

    const slider = page.getComponent('[data-test="agent-task-max-concurrent-slider"]') as VueWrapper<{
      $props: { min: number; max: number; step: number; modelValue: number };
    }>;
    expect(slider.props("min")).toBe(1);
    expect(slider.props("max")).toBe(8);
    expect(slider.props("step")).toBe(1);
    expect(slider.props("modelValue")).toBe(4);
  });

  it("hydrates a persisted cap on mount", async () => {
    getSettingsMock.mockResolvedValue({
      theme: "light",
      recentProjects: [],
      agentTaskMaxConcurrent: 8,
    });

    const page = mountPage();
    await flushPromises();
    await openPlanSection(page);

    const slider = page.getComponent('[data-test="agent-task-max-concurrent-slider"]') as VueWrapper<{
      $props: { modelValue: number };
    }>;
    expect(slider.props("modelValue")).toBe(8);
  });

  it("saves the chosen cap", async () => {
    const page = mountPage();
    await flushPromises();
    await openPlanSection(page);

    const slider = page.getComponent('[data-test="agent-task-max-concurrent-slider"]') as VueWrapper;
    await slider.vm.$emit("update:modelValue", 6);
    await flushPromises();

    const saveBtn = page.find(".settings-actions button.v-btn");
    await saveBtn.trigger("click");
    await flushPromises();
    expect(lastSetSettingsCall().agentTaskMaxConcurrent).toBe(6);
  });
});

// ============================================================================
// Main SettingsStore migration (schema 3 -> 4, 1.4.1)
// ============================================================================

describe("main SettingsStore migration (1.4.1)", () => {
  it("migrates schemaVersion 3 -> 4 idempotently without writing autoBackgroundMs", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pix-settings-3to4-"));
    const settingsFile = join(cwd, "pix-settings.json");
    writeFileSync(
      settingsFile,
      JSON.stringify({
        schemaVersion: 3,
        theme: "dark",
        enableProductAnalytics: true,
        recentProjects: [],
      }),
      "utf-8",
    );

    const store = new SettingsStore({ cwd });
    expect(store.get("schemaVersion")).toBe(4);
    expect(store.get("theme")).toBe("dark");
    expect(store.get("enableProductAnalytics")).toBe(true);

    const raw = JSON.parse(readFileSync(settingsFile, "utf-8")) as Record<string, unknown>;
    expect(raw.schemaVersion).toBe(4);
    expect("autoBackgroundMs" in raw).toBe(false);

    const beforeReload = readFileSync(settingsFile, "utf-8");
    const store2 = new SettingsStore({ cwd });
    expect(store2.get("schemaVersion")).toBe(4);
    expect(readFileSync(settingsFile, "utf-8")).toBe(beforeReload);

    rmSync(cwd, { recursive: true, force: true });
  });

  it("steps a legacy (no schemaVersion) store through 2 -> 3 -> 4 in one load", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pix-settings-legacy4-"));
    const realProject = mkdtempSync(join(tmpdir(), "pix-legacy4-project-"));
    const settingsFile = join(cwd, "pix-settings.json");
    writeFileSync(
      settingsFile,
      JSON.stringify({
        theme: "light",
        recentProjects: [{ path: realProject, name: "p", lastOpened: 1, sessionCount: 0 }],
      }),
      "utf-8",
    );

    const store = new SettingsStore({ cwd });
    const all = store.getAll();
    expect(all.schemaVersion).toBe(4);
    expect(all.enableProductAnalytics).toBe(false);
    expect(all.wsl).toBeDefined();
    expect(all.recentProjects[0]?.physicalPath).toBe(realProject);
    expect(all.autoBackgroundMs).toBeUndefined();

    rmSync(cwd, { recursive: true, force: true });
    rmSync(realProject, { recursive: true, force: true });
  });

  it("setMany persists, overwrites and clears autoBackgroundMs", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pix-settings-setmany-"));
    const store = new SettingsStore({ cwd });

    store.setMany({ autoBackgroundMs: 60_000 });
    expect(store.get("autoBackgroundMs")).toBe(60_000);

    store.setMany({ autoBackgroundMs: 0 });
    expect(store.get("autoBackgroundMs")).toBe(0);

    store.setMany({ autoBackgroundMs: undefined });
    expect(store.get("autoBackgroundMs")).toBeUndefined();

    rmSync(cwd, { recursive: true, force: true });
  });

  it("setMany persists, overwrites and clears agentTaskMaxConcurrent", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pix-settings-concurrent-"));
    const store = new SettingsStore({ cwd });

    store.setMany({ agentTaskMaxConcurrent: 8 });
    expect(store.get("agentTaskMaxConcurrent")).toBe(8);

    store.setMany({ agentTaskMaxConcurrent: 1 });
    expect(store.get("agentTaskMaxConcurrent")).toBe(1);

    store.setMany({ agentTaskMaxConcurrent: undefined });
    expect(store.get("agentTaskMaxConcurrent")).toBeUndefined();

    rmSync(cwd, { recursive: true, force: true });
  });
});


describe("settings rebuild persistence and navigation", () => {
  it("retains edits made while a GUI save is pending and submits Agent values from the same snapshot", async () => {
    const page = mountPage();
    await flushPromises();
    await openPlanSection(page);
    await pickAutoBackground(page, 120_000);
    let finishSave!: (value: { success: boolean }) => void;
    setSettingsMock.mockReturnValueOnce(new Promise(resolve => { finishSave = resolve; }));
    await page.get('.settings-actions button.v-btn').trigger('click');
    await flushPromises();
    expect(lastSetSettingsCall().autoBackgroundMs).toBe(120_000);
    await pickAutoBackground(page, 300_000);
    await pickSelectOption(page, 'execution-mode-select', 'read-only');
    finishSave({ success: true });
    await flushPromises();
    expect(page.get('.save-feedback').text()).toBe('有未保存的修改');
    const entries = rpcMock.state.setPiSettings.mock.calls.at(-1)?.[0] as Array<{ key: string; value: unknown }>;
    expect(entries.find(entry => entry.key === 'executionMode')?.value).toBe('approval');
    await clickSave(page);
    expect(lastSetSettingsCall().autoBackgroundMs).toBe(300_000);
    const retry = rpcMock.state.setPiSettings.mock.calls.at(-1)?.[0] as Array<{ key: string; value: unknown }>;
    expect(retry.find(entry => entry.key === 'executionMode')?.value).toBe('read-only');
    expect(page.get('.save-feedback').text()).toBe('已保存');
  });

  it("resets category scrolling and confirms leaving a dirty form", async () => {
    const page = mountPage();
    await flushPromises();
    await openPlanSection(page);
    await pickAutoBackground(page, 120_000);
    const scroll = page.get<HTMLElement>('.settings-scroll').element;
    scroll.scrollTop = 600;
    await page.findAll('.sidebar-item').find(item => item.text() === '常规')!.trigger('click');
    await flushPromises();
    expect(scroll.scrollTop).toBe(0);
    await page.get('.sidebar-back').trigger('click');
    await flushPromises();
    expect(navigationMock.back).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('放弃未保存的修改？');
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '继续编辑')!.click();
    await flushPromises();
    expect(navigationMock.back).not.toHaveBeenCalled();
    expect(page.get('.save-feedback').text()).toBe('有未保存的修改');
    await page.get('.sidebar-back').trigger('click');
    await flushPromises();
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '放弃并返回')!.click();
    await flushPromises();
    expect(navigationMock.back).toHaveBeenCalledTimes(1);
  });

  it("shows independently edited provider drafts in the footer and leave confirmation", async () => {
    const page = mountPage();
    await flushPromises();
    await page.findAll('.sidebar-item').find(item => item.text() === '自定义提供商')!.trigger('click');
    await page.getComponent({ name: 'CustomProviders' }).vm.$emit('dirty-change', true);
    await flushPromises();
    expect(page.get('.save-feedback').text()).toBe('有未保存的修改');
    await page.get('.sidebar-back').trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('放弃未保存的修改？');
    expect(navigationMock.back).not.toHaveBeenCalled();
  });

  it("requires confirmation to delete a stored API key", async () => {
    rpcMock.state.getAuthStatus.mockResolvedValue({ openai: { configured: true, source: 'stored' } });
    const page = mountPage();
    await flushPromises();
    await page.findAll('.sidebar-item').find(item => item.text() === '认证')!.trigger('click');
    await flushPromises();
    await page.get('.auth-provider-row').trigger('click');
    await page.findAll('.auth-edit-row button').find(button => button.text() === '删除')!.trigger('click');
    await flushPromises();
    expect(rpcMock.state.removeAuth).not.toHaveBeenCalled();
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '取消')!.click();
    await flushPromises();
    expect(rpcMock.state.removeAuth).not.toHaveBeenCalled();
    await page.findAll('.auth-edit-row button').find(button => button.text() === '删除')!.trigger('click');
    await flushPromises();
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '确认删除')!.click();
    await flushPromises();
    expect(rpcMock.state.removeAuth).toHaveBeenCalledWith('openai');
  });

  it("disables eye model activation when image input is blocked", async () => {
    rpcMock.state.getPiSettings.mockResolvedValue({ images: { blockImages: true } });
    const page = mountPage();
    await flushPromises();
    expect(page.get<HTMLInputElement>('#setting-takeHerEyesEnabled').element.disabled).toBe(true);
  });

  it("blocks saving after a GUI read failure and restores persisted values on retry", async () => {
    getSettingsMock.mockRejectedValueOnce(new Error("读取应用设置失败"));
    const page = mountPage();
    await flushPromises();
    expect(page.text()).toContain("读取应用设置失败");
    expect(page.get('.settings-panels').attributes('inert')).toBeDefined();
    const saveButton = page.findAll('button.v-btn').find(button => button.text().includes('保存设置'))!;
    expect(saveButton.attributes('disabled')).toBeDefined();
    expect(rpcMock.state.getPiSettings).not.toHaveBeenCalled();
    getSettingsMock.mockResolvedValue({ theme: "light", recentProjects: [], autoBackgroundMs: 120_000 });
    await page.get('.inline-retry').trigger('click');
    await flushPromises();
    await openPlanSection(page);
    expect((page.getComponent('[data-test="auto-background-select"]') as VueWrapper<{ $props: { modelValue: string | number; disabled?: boolean } }>).props('modelValue')).toBe(120_000);
    expect(page.get('.settings-panels').attributes('inert')).toBeUndefined();
    expect(saveButton.attributes('disabled')).toBeUndefined();
  });

  it("filters navigation by setting keywords without discarding edited values", async () => {
    const page = mountPage();
    await flushPromises();
    await openPlanSection(page);
    await pickAutoBackground(page, 120_000);
    await page.get('input[aria-label="搜索设置"]').setValue("WSL");
    expect(page.findAll(".sidebar-item").map(item => item.text())).toEqual(["执行环境"]);
    await clickSave(page);
    expect(lastSetSettingsCall().autoBackgroundMs).toBe(120_000);
  });

  it("preserves the conversation model while saving unrelated settings", async () => {
    installPixApiMock({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-6" });
    const page = mountPage();
    await flushPromises();
    expect(page.find('#setting-defaultModel').exists()).toBe(false);
    await clickSave(page);
    expect(lastSetSettingsCall().defaultProvider).toBe("anthropic");
    expect(lastSetSettingsCall().defaultModel).toBe("claude-sonnet-4-6");
  });

  it("retains edited values and dirty feedback when the GUI write fails", async () => {
    setSettingsMock.mockResolvedValue({ success: false });
    const page = mountPage();
    await flushPromises();
    await openPlanSection(page);
    await pickAutoBackground(page, 120_000);
    await clickSave(page);
    expect(page.get('.save-feedback').text()).toContain("保存应用设置失败");
    expect((page.getComponent('[data-test="auto-background-select"]') as VueWrapper<{ $props: { modelValue: string | number; disabled?: boolean } }>).props('modelValue')).toBe(120_000);
    expect(rpcMock.state.setPiSettings).not.toHaveBeenCalled();
    setSettingsMock.mockResolvedValue({ success: true });
    await clickSave(page);
    expect(page.get('.save-feedback').text()).toBe("已保存");
  });

  it("keeps Agent controls unavailable on a failed read and supports retry", async () => {
    rpcMock.state.getPiSettings.mockResolvedValue(null);
    const page = mountPage();
    await flushPromises();
    expect(page.text()).toContain("读取 Agent 配置失败");
    expect((page.getComponent('[data-test="execution-mode-select"]') as VueWrapper<{ $props: { modelValue: string | number; disabled?: boolean } }>).props('disabled')).toBe(true);
    rpcMock.state.getPiSettings.mockResolvedValue({ execution: { mode: "read-only" } });
    await page.get('.inline-retry').trigger('click');
    await flushPromises();
    expect((page.getComponent('[data-test="execution-mode-select"]') as VueWrapper<{ $props: { modelValue: string | number; disabled?: boolean } }>).props('disabled')).toBe(false);
    expect((page.getComponent('[data-test="execution-mode-select"]') as VueWrapper<{ $props: { modelValue: string | number; disabled?: boolean } }>).props('modelValue')).toBe('read-only');
  });

  it("shows Agent save errors while retaining the draft for retry", async () => {
    rpcMock.state.setPiSettings.mockRejectedValueOnce(new Error("写入 Agent 设置失败"));
    const page = mountPage();
    await flushPromises();
    await (page.getComponent('[data-test="execution-mode-select"]') as VueWrapper).vm.$emit('update:modelValue', 'read-only');
    await clickSave(page);
    expect(page.get('.save-feedback').text()).toContain("写入 Agent 设置失败");
    expect((page.getComponent('[data-test="execution-mode-select"]') as VueWrapper<{ $props: { modelValue: string | number; disabled?: boolean } }>).props('modelValue')).toBe('read-only');
    await clickSave(page);
    expect(page.get('.save-feedback').text()).toBe("已保存");
  });
});
