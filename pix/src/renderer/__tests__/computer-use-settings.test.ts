/**
 * Computer-use settings persistence tests.
 *
 * The main SettingsStore persists GuiSettings.computerUse with the
 * same optional-field semantics as planModel/defaultAcp: setMany writes the
 * value when present, deletes the key on explicit undefined, and neither
 * defaultSettings nor migrate() ever write it (absent = disabled defaults,
 * applied by resolveComputerUseSettings on the read path). Each case uses a
 * fresh temp cwd, mirroring settings-1.4.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { isReactive } from "vue";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
// Use the pre-bundled dist entry (same as settings-1.4.test.ts): the ESM lib
// entry imports per-component CSS files that happy-dom cannot load.
import { components as vuetifyComponents, createVuetify, directives as vuetifyDirectives } from "vuetify/dist/vuetify.js";
import type { PixApi } from "../../main/preload";
import type { GuiSettings, ModelInfo } from "@shared/types.js";
import { SettingsStore } from "../../main/settings-store";
import { resolveComputerUseSettings } from "@shared/computer-use-types.js";
import SettingsPage from "../pages/SettingsPage.vue";

// ============================================================================
// SettingsPage save-path mocks (same surface as settings-1.4.test.ts)
// ============================================================================

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
  }),
}));

const navigationMock = vi.hoisted(() => ({ back: vi.fn() }));
vi.mock("vue-router", () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ back: navigationMock.back }),
}));

/** Fresh store in its own temp dir; the caller removes `cwd` when done. */
function createStore(): { cwd: string; settingsFile: string; store: SettingsStore } {
  const cwd = mkdtempSync(join(tmpdir(), "pix-settings-computer-use-"));
  return { cwd, settingsFile: join(cwd, "pix-settings.json"), store: new SettingsStore({ cwd }) };
}

function readRaw(settingsFile: string): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsFile, "utf-8")) as Record<string, unknown>;
}

describe("main SettingsStore computerUse", () => {
  it("keeps computerUse absent by default (resolves to disabled defaults) at schemaVersion 4", () => {
    const { cwd, settingsFile, store } = createStore();

    expect(store.get("computerUse")).toBeUndefined();
    expect(store.getAll().computerUse).toBeUndefined();
    expect(store.get("schemaVersion")).toBe(4);
    expect("computerUse" in readRaw(settingsFile)).toBe(false);
    expect(readRaw(settingsFile).schemaVersion).toBe(4);

    const resolved = resolveComputerUseSettings(store.get("computerUse"));
    expect(resolved.enabled).toBe(false);
    expect(resolved.maxImageDimension).toBe(1568);

    rmSync(cwd, { recursive: true, force: true });
  });

  it("persists computerUse through setMany and a new instance re-reads it", () => {
    const { cwd, settingsFile, store } = createStore();
    const value = {
      enabled: true,
      driverPath: "C:\\tools\\cua-driver\\cua-driver.exe",
      maxImageDimension: 1568,
      screenshotMaxBytes: 450_000,
      keepRecentScreenshots: 3,
      defaultSessionEnabled: false,
    };

    store.setMany({ computerUse: value });

    expect(store.get("computerUse")?.enabled).toBe(true);
    expect(store.getAll().computerUse).toEqual(value);
    expect(readRaw(settingsFile).computerUse).toEqual(value);
    expect(store.get("schemaVersion")).toBe(4);

    const reopened = new SettingsStore({ cwd });
    expect(reopened.get("computerUse")).toEqual(value);
    expect(reopened.getAll().computerUse?.enabled).toBe(true);
    expect(reopened.get("schemaVersion")).toBe(4);

    rmSync(cwd, { recursive: true, force: true });
  });

  it("overwrites the object wholesale and clears it on explicit undefined", () => {
    const { cwd, settingsFile, store } = createStore();

    store.setMany({ computerUse: { enabled: true, maxImageDimension: 2560 } });
    store.setMany({ computerUse: { enabled: false } });

    expect(store.get("computerUse")).toEqual({ enabled: false });

    store.setMany({ computerUse: undefined });

    expect(store.get("computerUse")).toBeUndefined();
    expect("computerUse" in store.getAll()).toBe(false);
    expect("computerUse" in readRaw(settingsFile)).toBe(false);
    expect(store.get("schemaVersion")).toBe(4);

    const reopened = new SettingsStore({ cwd });
    expect(reopened.get("computerUse")).toBeUndefined();
    expect(reopened.get("schemaVersion")).toBe(4);

    rmSync(cwd, { recursive: true, force: true });
  });

  it("stores the raw user value and applies clamping only on the resolve read path", () => {
    const { cwd, store } = createStore();

    store.setMany({ computerUse: { enabled: true, maxImageDimension: 99_999, keepRecentScreenshots: 0 } });

    expect(store.get("computerUse")).toEqual({ enabled: true, maxImageDimension: 99_999, keepRecentScreenshots: 0 });

    const resolved = resolveComputerUseSettings(store.get("computerUse"));
    expect(resolved.enabled).toBe(true);
    expect(resolved.maxImageDimension).toBe(2560);
    expect(resolved.keepRecentScreenshots).toBe(1);

    rmSync(cwd, { recursive: true, force: true });
  });
});

// ============================================================================
// SettingsPage save path (regression): the computerUse value handed to
// window.pixApi.setSettings must be a plain object. The form ref's deep
// reactive proxy cannot cross the contextBridge (structuredClone throws
// DataCloneError), so the save path converts the form value with toPlain.
// ============================================================================

const vuetify = createVuetify({
  components: { ...vuetifyComponents },
  directives: { ...vuetifyDirectives },
});

let pageWrapper: ReturnType<typeof mount> | undefined;
let setSettingsMock: ReturnType<typeof vi.fn>;

function installPixApiMock(settings: Partial<GuiSettings> = {}): void {
  setSettingsMock = vi.fn().mockResolvedValue({ success: true });
  window.pixApi = {
    getSettings: vi.fn().mockResolvedValue({ theme: "light", recentProjects: [], ...settings }),
    setSettings: setSettingsMock,
    listWslDistros: vi.fn().mockResolvedValue({ distros: [], diagnostic: null }),
    // ComputerUseSettings onMounted → computer-use store.start() 走到的 IPC 表面。
    sendComputerUseCommand: vi.fn().mockResolvedValue({ success: true, data: null }),
    onComputerUseEvent: vi.fn(() => () => {}),
  } as unknown as PixApi;
}

describe("SettingsPage computerUse save payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    setActivePinia(createPinia());
    rpcMock.state.availableModels.value = [];
    rpcMock.state.isConnected.value = true;
    rpcMock.state.getPiSettings.mockResolvedValue({});
    rpcMock.state.getAuthStatus.mockResolvedValue({});
    rpcMock.state.getCustomProviders.mockResolvedValue({ providers: {} });
    installPixApiMock();
  });

  afterEach(() => {
    pageWrapper?.unmount();
    pageWrapper = undefined;
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("saves computerUse as a plain object that survives structuredClone over IPC", async () => {
    installPixApiMock({ computerUse: { enabled: true, maxImageDimension: 2048 } });
    pageWrapper = mount(SettingsPage, {
      attachTo: document.body,
      global: {
        plugins: [createPinia(), vuetify],
        stubs: { McpSettings: true, CustomProviders: true },
      },
    });
    await flushPromises();

    const saveBtn = pageWrapper.findAll("button.v-btn").find((b) => b.text().includes("保存设置"));
    expect(saveBtn, "save button exists").toBeTruthy();
    await saveBtn!.trigger("click");
    await flushPromises();

    expect(setSettingsMock).toHaveBeenCalled();
    const payload = setSettingsMock.mock.calls[setSettingsMock.mock.calls.length - 1][0] as Partial<GuiSettings>;
    expect(payload.computerUse).toEqual({ enabled: true, maxImageDimension: 2048 });
    // 负载里不得是 reactive Proxy：深层 Proxy 过 contextBridge 的
    // structuredClone 会抛 DataCloneError；toPlain 必须剥离 Proxy，
    // 使负载可直接结构化克隆。
    expect(isReactive(payload.computerUse)).toBe(false);
    expect(() => structuredClone(payload)).not.toThrow();
  });
});
