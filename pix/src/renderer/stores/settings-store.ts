/**
 * Settings Store
 *
 * Manages GUI settings and PiX configuration.
 * v2: piPath is no longer needed (direct AgentSession integration).
 */

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { GuiSettings } from "@/types/session";
import type { PixApi } from "../../main/preload";

function api(): PixApi {
  if (!window.pixApi) {
    console.error("[settings-store] pixApi is not available; preload may have failed");
    return {
      selectProject: async () => null,
      selectPiPath: async () => null,
      selectSessionFile: async () => null,
      startPi: async () => ({ success: false }),
      stopPi: async () => ({ success: false }),
      sendCommand: async () => ({ success: false }),
      sendCommandAsync: () => {},
      getSettings: async () => ({ theme: "light", recentProjects: [] }),
      setSettings: async () => ({ success: false }),
      detectPi: async () => ({ found: true, path: "direct", note: "Direct integration" }),
      getPiStderr: async () => "",
      isPiRunning: async () => false,
      onPiEvent: () => () => {},
      onPiResponse: () => () => {},
      onPiExit: () => () => {},
      onPiError: () => () => {},
      onPiReady: () => () => {},
      listSessions: async () => [],
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
    } as PixApi;
  }
  return window.pixApi;
}

export const useSettingsStore = defineStore("settings", () => {
  const settings = ref<GuiSettings>({
    theme: "light",
    recentProjects: [],
  });
  const isLoaded = ref(false);

  async function load(): Promise<void> {
    try {
      const s = await api().getSettings();
      settings.value = s;
      // Ensure piPath is not undefined for backward compat
      if (!settings.value.piPath) {
        settings.value.piPath = "direct";
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

  async function detectPi(): Promise<{ found: boolean; path: string; note?: string }> {
    try {
      return await api().detectPi();
    } catch {
      return { found: true, path: "direct", note: "Using direct AgentSession integration" };
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
  };
});
