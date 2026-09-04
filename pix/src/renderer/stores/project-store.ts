/**
 * Project Store
 *
 * Manages project and session list state.
 * Session list is populated by pi's SessionManager.list() via RPC or
 * by parsing session directories directly.
 */

import { defineStore } from "pinia";
import { ref } from "vue";
import { toPlain } from "../utils/plain";
import type { ProjectInfo, ProjectLocation, SessionInfo } from "@/types/session";
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
      listTeamLeaderSessions: async () => [],
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

function normalizePath(path: string | undefined): string {
  return (path || "").replace(/\\/g, "/").toLowerCase();
}

/**
 * Stable identity key for a project. Windows paths are case-normalized
 * (win32 is case-insensitive); WSL projects keep their POSIX logical path
 * case-sensitive and are namespaced by distro. Uses `path` (logical) which
 * equals `physicalPath` for Windows. See wsl_plan §4.3/§7.4.
 */
function projectKey(p: ProjectLocation): string {
  if (p.environment.kind === "wsl") {
    return `wsl:${p.environment.distro}:${p.path}`;
  }
  return `win:${p.path.toLowerCase()}`;
}

export const useProjectStore = defineStore("project", () => {
  const recentProjects = ref<ProjectInfo[]>([]);
  const currentProject = ref<ProjectInfo | null>(null);
  const sessions = ref<SessionInfo[]>([]);
  const currentSession = ref<SessionInfo | null>(null);
  const teamSessions = ref<SessionInfo[]>([]);
  const currentTeamSession = ref<SessionInfo | null>(null);
  const isLoadingSessions = ref(false);
  const isLoadingTeamSessions = ref(false);

  async function loadSettings(): Promise<void> {
    try {
      const settings = await api().getSettings();
      recentProjects.value = settings.recentProjects || [];
    } catch {
      // Settings not available yet
    }
  }

  async function openProject(location: ProjectLocation, options: { loadSessions?: boolean } = {}): Promise<void> {
    const key = projectKey(location);
    currentProject.value = {
      ...location,
      lastOpened: Date.now(),
      sessionCount: 0,
    };

    // Save to recent projects. The read-modify-write chain has no data
    // dependency on the session list fetch, so both run in parallel;
    // getSettings→setSettings itself stays serial (read-modify-write order).
    const recentProjectsChain = (async () => {
      try {
        const settings = await api().getSettings();
        const existing = (settings.recentProjects || []).findIndex((p: ProjectInfo) => projectKey(p) === key);
        let updated: ProjectInfo[];
        if (existing !== -1) {
          // Remove from old position and move to front; preserve known sessionCount.
          updated = [...settings.recentProjects];
          const [moved] = updated.splice(existing, 1);
          updated.unshift({ ...location, lastOpened: Date.now(), sessionCount: moved.sessionCount ?? 0 });
        } else {
          updated = [
            { ...location, lastOpened: Date.now(), sessionCount: 0 },
            ...(settings.recentProjects || []),
          ].slice(0, 20);
        }
        await api().setSettings({ recentProjects: updated });
        recentProjects.value = updated;
      } catch {
        // Non-critical
      }
    })();

    if (options.loadSessions === false) {
      sessions.value = [];
      currentSession.value = null;
      teamSessions.value = [];
      currentTeamSession.value = null;
      await recentProjectsChain;
      return;
    }
    teamSessions.value = [];
    currentTeamSession.value = null;
    // recentProjects is a read-modify-write of the same settings array that
    // listSessions later patches (sessionCount). Running them in parallel let
    // the slower writer clobber the other's fields. Settings RMW first, then
    // the session scan updates sessionCount on top.
    await recentProjectsChain;
    await listSessions();
  }

  /** Whether `location` refers to the currently open project (by identity key). */
  function isCurrentProject(location: ProjectLocation): boolean {
    return currentProject.value ? projectKey(currentProject.value) === projectKey(location) : false;
  }

  async function removeRecentProject(project: ProjectLocation): Promise<void> {
    const key = projectKey(project);
    const next = recentProjects.value.filter((p) => projectKey(p) !== key);
    recentProjects.value = next;
    try {
      const settings = await api().getSettings();
      const latest = (settings.recentProjects || []).filter((p: ProjectInfo) => projectKey(p) !== key);
      await api().setSettings({ recentProjects: latest });
      recentProjects.value = latest;
    } catch (err) {
      console.error("[project-store] Failed to remove recent project:", err);
      await loadSettings();
    }
  }

  function setCurrentProject(project: ProjectInfo | null): void {
    currentProject.value = project;
  }

  async function syncRecentProjectSessionCount(project: ProjectLocation, sessionCount: number): Promise<void> {
    const key = projectKey(project);
    try {
      const settings = await api().getSettings();
      const projects = settings.recentProjects || [];
      const existing = projects.findIndex((p: ProjectInfo) => projectKey(p) === key);
      if (existing === -1 || projects[existing]?.sessionCount === sessionCount) {
        if (existing !== -1) recentProjects.value = projects;
        return;
      }
      const updated = [...projects];
      updated[existing] = { ...updated[existing], sessionCount };
      await api().setSettings({ recentProjects: updated });
      recentProjects.value = updated;
    } catch {
      // Non-critical; the session list itself is still current.
    }
  }

  async function listSessions(): Promise<void> {
    const project = currentProject.value;
    if (!project) return;
    isLoadingSessions.value = true;
    try {
      // currentProject is a Vue reactive proxy; strip reactivity before IPC.
      const sessionInfos = await api().listSessions(toPlain(project));
      if (Array.isArray(sessionInfos)) {
        if (currentProject.value && projectKey(currentProject.value) !== projectKey(project)) return;
        sessions.value = sessionInfos;
        // `project` is the captured currentProject at call time and the
        // identity guard above confirms it is still current.
        project.sessionCount = sessionInfos.length;
        await syncRecentProjectSessionCount(project, sessionInfos.length);
      }
    } catch (err) {
      console.error("[project-store] Failed to list sessions:", err);
    } finally {
      isLoadingSessions.value = false;
    }
  }

  async function listTeamLeaderSessions(): Promise<void> {
    const project = currentProject.value;
    if (!project) return;
    isLoadingTeamSessions.value = true;
    try {
      // currentProject is a Vue reactive proxy; strip reactivity before IPC.
      const sessionInfos = await api().listTeamLeaderSessions(toPlain(project));
      if (Array.isArray(sessionInfos)) {
        if (currentProject.value && projectKey(currentProject.value) !== projectKey(project)) return;
        teamSessions.value = sessionInfos;
      }
    } catch (err) {
      console.error("[project-store] Failed to list team leader sessions:", err);
    } finally {
      isLoadingTeamSessions.value = false;
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

  function setCurrentTeamSession(session: SessionInfo | null): void {
    currentTeamSession.value = session;
  }

  function syncCurrentTeamSession(sessionFile: string | undefined, sessionId: string | undefined): SessionInfo | null {
    const normalizedSessionFile = normalizePath(sessionFile);
    const match = teamSessions.value.find((session) => {
      if (normalizedSessionFile && normalizePath(session.path) === normalizedSessionFile) return true;
      return !!sessionId && session.id === sessionId;
    });

    currentTeamSession.value = match ?? null;
    return currentTeamSession.value;
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
    teamSessions,
    currentTeamSession,
    isLoadingSessions,
    isLoadingTeamSessions,
    loadSettings,
    openProject,
    isCurrentProject,
    setCurrentProject,
    listSessions,
    listTeamLeaderSessions,
    removeRecentProject,
    setCurrentSession,
    syncCurrentSession,
    setCurrentTeamSession,
    syncCurrentTeamSession,
    addSession,
  };
});
