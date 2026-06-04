/**
 * Project Store
 *
 * Manages project and session list state.
 * Session list is populated by pi's SessionManager.list() via RPC or
 * by parsing session directories directly.
 */

import { defineStore } from "pinia";
import { ref } from "vue";
import type { ProjectInfo, SessionInfo } from "@/types/session";
import type { PixApi } from "../../main/preload";

function api(): PixApi {
  if (!window.pixApi) {
    console.error("[project-store] pixApi is not available");
    return {
      selectProject: async () => null,
      selectPiPath: async () => null,
      selectSessionFile: async () => null,
      selectChatFiles: async () => [],
      getPathForFile: () => "",
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
      onUserInputRequest: () => () => {},
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

function normalizePath(path: string | undefined): string {
  return (path || "").replace(/\\/g, "/").toLowerCase();
}

export const useProjectStore = defineStore("project", () => {
  const recentProjects = ref<ProjectInfo[]>([]);
  const currentProject = ref<ProjectInfo | null>(null);
  const sessions = ref<SessionInfo[]>([]);
  const currentSession = ref<SessionInfo | null>(null);
  const isLoadingSessions = ref(false);

  async function loadSettings(): Promise<void> {
    try {
      const settings = await api().getSettings();
      recentProjects.value = settings.recentProjects || [];
    } catch {
      // Settings not available yet
    }
  }

  async function openProject(dirPath: string): Promise<void> {
    const name = dirPath.split(/[/\\]/).pop() || dirPath;

    currentProject.value = {
      path: dirPath,
      name,
      lastOpened: Date.now(),
      sessionCount: 0,
    };

    // Save to recent projects
    try {
      const settings = await api().getSettings();
      const existing = (settings.recentProjects || []).findIndex((p: ProjectInfo) => p.path === dirPath);
      let updated: ProjectInfo[];
      if (existing !== -1) {
        // Remove from old position and move to front
        updated = [...settings.recentProjects];
        const [moved] = updated.splice(existing, 1);
        updated.unshift({ ...moved, lastOpened: Date.now(), name });
      } else {
        updated = [
          { path: dirPath, name, lastOpened: Date.now(), sessionCount: 0 },
          ...(settings.recentProjects || []),
        ].slice(0, 20);
      }
      await api().setSettings({ recentProjects: updated });
      recentProjects.value = updated;
    } catch {
      // Non-critical
    }

    await listSessions();
  }

  function setCurrentProject(project: ProjectInfo | null): void {
    currentProject.value = project;
  }

  async function listSessions(): Promise<void> {
    if (!currentProject.value) return;
    isLoadingSessions.value = true;
    try {
      const sessionInfos = await api().listSessions(currentProject.value.path);
      if (Array.isArray(sessionInfos)) {
        sessions.value = sessionInfos;
        if (currentProject.value) {
          currentProject.value.sessionCount = sessionInfos.length;
        }
      }
    } catch (err) {
      console.error("[project-store] Failed to list sessions:", err);
    } finally {
      isLoadingSessions.value = false;
    }
  }

  function setCurrentSession(session: SessionInfo | null): void {
    currentSession.value = session;
  }

  function syncCurrentSession(sessionFile: string | undefined, sessionId: string | undefined): SessionInfo | null {
    const normalizedSessionFile = normalizePath(sessionFile);
    const match = sessions.value.find((session) => {
      if (normalizedSessionFile && normalizePath(session.path) === normalizedSessionFile) return true;
      return !!sessionId && session.id === sessionId;
    });

    currentSession.value = match ?? null;
    return currentSession.value;
  }

  function addSession(session: SessionInfo): void {
    const existing = sessions.value.findIndex((s) => s.id === session.id);
    if (existing !== -1) {
      sessions.value[existing] = session;
    } else {
      sessions.value.unshift(session);
    }
    if (currentProject.value) {
      currentProject.value.sessionCount = sessions.value.length;
    }
  }

  return {
    recentProjects,
    currentProject,
    sessions,
    currentSession,
    isLoadingSessions,
    loadSettings,
    openProject,
    setCurrentProject,
    listSessions,
    setCurrentSession,
    syncCurrentSession,
    addSession,
  };
});
