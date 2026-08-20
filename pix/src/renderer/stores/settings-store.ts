/**
 * Settings Store
 *
 * Manages GUI settings and PiX configuration.
 * v2: piPath is no longer needed (direct AgentSession integration).
 */

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { DEFAULT_AUTO_BACKGROUND_MS } from "@shared/agent-task-types.js";
import type { GuiSettings, WslDistroInfo, WslSettings } from "@/types/session";
import type { PixApi } from "../../main/preload";

function api(): PixApi {
  if (!window.pixApi) {
    console.error("[settings-store] pixApi is not available; preload may have failed");
    return {
      selectProject: async () => null,
      selectPiPath: async () => null,
      selectSessionFile: async () => null,
      selectChatFiles: async () => [],
      getPathForFile: () => "",
      startPi: async () => ({ success: false }),
      stopPi: async () => ({ success: false }),
      sendCommand: async () => ({ success: false }),
      sendCommandAsync: async () => ({ success: false }),
      getSettings: async () => ({ theme: "light", recentProjects: [] }),
      setSettings: async () => ({ success: false }),
      detectPi: async () => ({ found: true, path: "direct", note: "进程内直连" }),
      getPiStderr: async () => "",
      isPiRunning: async () => false,
      onPiEvent: () => () => {},
      onPiResponse: () => () => {},
      onPiExit: () => () => {},
      onPiError: () => () => {},
      onPiReady: () => () => {},
      onUserInputRequest: () => () => {},
      listSessions: async () => [],
      listWslDistros: async () => ({ distros: [], diagnostic: "pixApi 不可用" }),
      resolveProjectLocation: async () => ({ success: false, error: "pixApi 不可用" }),
      windowMinimize: async () => {},
      windowMaximize: async () => {},
      windowClose: async () => {},
      windowIsMaximized: async () => false,
      onWindowMaximizeChange: () => () => {},
      deleteSession: async () => ({ success: false }),
      mcpGetServers: async () => [],
      mcpGetConfig: async () => ({ configPaths: [], errors: [] }),
      mcpListResources: async () => [],
      mcpReadResource: async () => ({ server: "", contents: [] }),
    } as unknown as PixApi;
  }
  return window.pixApi;
}

const DEFAULT_WSL_SETTINGS: WslSettings = { enabled: false, distro: "", defaultCwd: "/home" };

export const useSettingsStore = defineStore("settings", () => {
  const settings = ref<GuiSettings>({
    theme: "light",
    recentProjects: [],
  });
  const isLoaded = ref(false);

  // WSL defaults + distro probe state. `wslDistros`/`wslDiagnostic` are filled by
  // loadWslDistros(); an empty list with a diagnostic means WSL is unavailable.
  const wslDistros = ref<WslDistroInfo[]>([]);
  const wslDiagnostic = ref<string | null>(null);
  const wslDistrosLoaded = ref(false);

  async function load(): Promise<void> {
    try {
      const s = await api().getSettings();
      settings.value = s;
      // Ensure piPath is not undefined for backward compat
      if (!settings.value.piPath) {
        settings.value.piPath = "direct";
      }
      if (!settings.value.wsl) {
        settings.value.wsl = { ...DEFAULT_WSL_SETTINGS };
      }
      isLoaded.value = true;
    } catch {
      // Use defaults
    }
  }

  async function save(partial: Partial<GuiSettings>): Promise<void> {
    try {
      await api().setSettings(partial);
      settings.value = { ...settings.value, ...partial };
    } catch (err) {
      console.error("[settings] Failed to save settings:", err);
    }
  }

  /** Probe WSL distros via the main process. Stores the list and any diagnostic;
   * never throws so callers can use it on mount. */
  async function loadWslDistros(): Promise<void> {
    // Reset the loaded flag so consumers (e.g. ProjectOpenDialog) can show a
    // loading hint while a re-probe is in flight, not just on first mount.
    wslDistrosLoaded.value = false;
    try {
      const result = await api().listWslDistros();
      wslDistros.value = result.distros ?? [];
      wslDiagnostic.value = result.diagnostic ?? null;
    } catch (err) {
      wslDistros.value = [];
      wslDiagnostic.value = err instanceof Error ? err.message : "无法列举 WSL 发行版";
    } finally {
      wslDistrosLoaded.value = true;
    }
  }

  /** Persist global WSL defaults. Only seeds new-project dialog defaults; the
   * persisted per-project environment remains authoritative (wsl_plan §6.1). */
  async function saveWslSettings(wsl: WslSettings): Promise<void> {
    await save({ wsl });
  }

  async function detectPi(): Promise<{ found: boolean; path: string; note?: string }> {
    try {
      return await api().detectPi();
    } catch {
      return { found: true, path: "direct", note: "使用 AgentSession 进程内直连" };
    }
  }

  return {
    settings,
    isLoaded,
    load,
    save,
    detectPi,
    theme: computed(() => settings.value.theme),
    recentProjects: computed(() => settings.value.recentProjects),
    wslSettings: computed<WslSettings>(() => settings.value.wsl ?? DEFAULT_WSL_SETTINGS),
    // 1.4.0: plan-mode settings; undefined means "inherit the session model".
    planModel: computed<GuiSettings["planModel"]>(() => settings.value.planModel),
    planThinkingLevel: computed<GuiSettings["planThinkingLevel"]>(() => settings.value.planThinkingLevel),
    enableProductAnalytics: computed<boolean>(() => settings.value.enableProductAnalytics ?? false),
    // 1.4.1: auto-background threshold for foreground agent tasks;
    // 0 = off, absent = consumer default (120000).
    autoBackgroundMs: computed<number>(() => settings.value.autoBackgroundMs ?? DEFAULT_AUTO_BACKGROUND_MS),
    wslDistros,
    wslDiagnostic,
    wslDistrosLoaded,
    loadWslDistros,
    saveWslSettings,
  };
});
