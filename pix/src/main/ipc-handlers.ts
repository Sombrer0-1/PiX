/**
 * IPC Handlers
 *
 * Bridges between renderer and main process.
 * Registers all ipcMain handlers for session control, settings, and file dialogs.
 *
 * v2: Uses SessionBridge for direct AgentSession integration (no RPC subprocess).
 */

import { existsSync, rmSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";
import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import electronUpdater from "electron-updater";
import { selectChatFiles, selectProjectDirectory, selectSessionFile } from "./file-dialogs.js";
import { resolveProjectLocation } from "./execution-context.js";
import { createGitStatusService } from "./git/git-status-service.js";
import type { SessionBridge } from "./session-bridge.js";
import type { SettingsStore } from "./settings-store.js";
import type {
  GuiSettings,
  ProjectInfo,
  ProjectLocation,
  ProjectLocationInput,
  RpcCommand,
  TeamCommand,
  ThinkingLevel,
  WslSettings,
} from "../shared/types.js";
import type { AgentTaskService } from "./agent-task/agent-task-service.js";
import { parseAgentTaskMaxConcurrent } from "../shared/agent-task-types.js";
// Plan/agent-task command registration and dispatch live in pure modules that
// do not import electron at the top level, so plan-ipc.test.ts and
// agent-task-ipc.test.ts exercise the REAL handlers with a fake adapter
// (design plan §3 IPC harness rule). These are re-exported at the bottom.
import {
  registerAgentTaskIpcHandlers,
  subscribeAgentTaskEventForwarding,
} from "./ipc-agent-task-adapters.js";
import { registerBtwIpcHandlers } from "./ipc-btw-adapters.js";
import { registerGitIpcHandlers } from "./ipc-git-adapters.js";
import {
  registerPlanIpcHandlers,
  resyncPlanEventForwarding,
  subscribePlanEventForwarding,
} from "./ipc-plan-adapters.js";
import {
  registerWorkflowIpcHandlers,
  resyncWorkflowEventForwarding,
  subscribeWorkflowEventForwarding,
} from "./ipc-workflow-adapters.js";
import type { TeamManager } from "./team-manager.js";
import { readWorkspaceMode, teamSnapshotPath, writeWorkspaceMode } from "./team-persistence.js";
import { WslDistroResolver } from "./wsl/wsl-distro.js";

const { autoUpdater } = electronUpdater;

let handlersRegistered = false;
let eventForwardingSetup = false;
let eventForwardingUnsubscribes: Array<() => void> = [];
let currentWindow: BrowserWindow | null = null;
let detachWindowStateListeners: (() => void) | null = null;

const SETTING_KEYS = new Set([
  "piPath",
  "theme",
  "recentProjects",
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "takeHerEyes",
  "wsl",
  "planModel",
  "planThinkingLevel",
  "enableProductAnalytics",
  "autoBackgroundMs",
  "agentTaskMaxConcurrent",
]);

const AUTO_BACKGROUND_MS_VALUES = new Set<number>([0, 60_000, 120_000, 300_000]);

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel);
}

function isProjectInfo(value: unknown): value is ProjectInfo {
  if (!value || typeof value !== "object") return false;
  const project = value as Record<string, unknown>;
  return (
    typeof project.path === "string" &&
    typeof project.name === "string" &&
    typeof project.lastOpened === "number" &&
    typeof project.sessionCount === "number"
  );
}

function isProjectEnvironment(value: unknown): value is ProjectLocation["environment"] {
  if (!value || typeof value !== "object") return false;
  const env = value as Record<string, unknown>;
  if (env.kind === "windows") return true;
  if (env.kind === "wsl") return typeof env.distro === "string" && env.distro.length > 0;
  return false;
}

/**
 * Runtime type guard for ProjectLocation received from the renderer. Structural
 * only; deeper validation (distro existence, directory probes) happens in
 * resolveProjectLocation / createProjectExecutionContext. physicalPath must be
 * non-empty because it is the sole hash/key input in the main process
 * (wsl_plan.md §4.8).
 */
function isProjectLocation(value: unknown): value is ProjectLocation {
  if (!value || typeof value !== "object") return false;
  const loc = value as Record<string, unknown>;
  return (
    typeof loc.path === "string" &&
    typeof loc.physicalPath === "string" &&
    loc.physicalPath.length > 0 &&
    typeof loc.name === "string" &&
    isProjectEnvironment(loc.environment)
  );
}

/**
 * Runtime type guard for ProjectLocationInput received from the renderer. The
 * resolver validates distro/version/path absoluteness and returns a structured
 * error; this guard only ensures the shape is safe to hand to it.
 */
function isProjectLocationInput(value: unknown): value is ProjectLocationInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  if (!isProjectEnvironment(input.environment)) return false;
  if (input.logicalPath !== undefined && typeof input.logicalPath !== "string") return false;
  if (input.physicalPath !== undefined && typeof input.physicalPath !== "string") return false;
  if (input.name !== undefined && typeof input.name !== "string") return false;
  return true;
}

function sanitizeTakeHerEyes(value: unknown): GuiSettings["takeHerEyes"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const result: GuiSettings["takeHerEyes"] = {
    enabled: raw.enabled === true,
  };
  if (typeof raw.provider === "string" && raw.provider.trim()) {
    result.provider = raw.provider;
  }
  if (typeof raw.modelId === "string" && raw.modelId.trim()) {
    result.modelId = raw.modelId;
  }
  return result;
}

function sanitizeWslSettings(value: unknown): WslSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  return {
    enabled: raw.enabled === true,
    distro: typeof raw.distro === "string" ? raw.distro : "",
    defaultCwd: typeof raw.defaultCwd === "string" ? raw.defaultCwd : "/home",
  };
}

function sanitizeSettings(settings: Record<string, unknown>): Partial<GuiSettings> {
  const sanitized: Partial<GuiSettings> = {};

  for (const key of Object.keys(settings)) {
    if (!SETTING_KEYS.has(key)) {
      console.warn(`[ipc] Ignoring unknown setting key: ${key}`);
    }
  }

  if (Object.hasOwn(settings, "piPath")) {
    const value = settings.piPath;
    if (value === undefined || typeof value === "string") {
      sanitized.piPath = value;
    }
  }
  if (settings.theme === "light") {
    sanitized.theme = "light";
  }
  if (Array.isArray(settings.recentProjects) && settings.recentProjects.every(isProjectInfo)) {
    sanitized.recentProjects = settings.recentProjects;
  }
  if (Object.hasOwn(settings, "defaultProvider")) {
    const value = settings.defaultProvider;
    if (value === undefined || typeof value === "string") {
      sanitized.defaultProvider = value;
    }
  }
  if (Object.hasOwn(settings, "defaultModel")) {
    const value = settings.defaultModel;
    if (value === undefined || typeof value === "string") {
      sanitized.defaultModel = value;
    }
  }
  if (Object.hasOwn(settings, "defaultThinkingLevel")) {
    const value = settings.defaultThinkingLevel;
    if (value === undefined || isThinkingLevel(value)) {
      sanitized.defaultThinkingLevel = value;
    }
  }
  if (Object.hasOwn(settings, "takeHerEyes")) {
    const value = settings.takeHerEyes;
    if (value === undefined) {
      sanitized.takeHerEyes = undefined;
    } else {
      const cleaned = sanitizeTakeHerEyes(value);
      if (cleaned) sanitized.takeHerEyes = cleaned;
    }
  }
  if (Object.hasOwn(settings, "wsl")) {
    const value = settings.wsl;
    if (value === undefined) {
      sanitized.wsl = undefined;
    } else {
      const cleaned = sanitizeWslSettings(value);
      if (cleaned) sanitized.wsl = cleaned;
    }
  }
  if (Object.hasOwn(settings, "planModel")) {
    const value = settings.planModel;
    if (value === undefined) {
      sanitized.planModel = undefined;
    } else if (value && typeof value === "object") {
      const raw = value as Record<string, unknown>;
      if (typeof raw.provider === "string" && raw.provider.trim() && typeof raw.modelId === "string" && raw.modelId.trim()) {
        sanitized.planModel = { provider: raw.provider, modelId: raw.modelId };
      }
    }
  }
  if (Object.hasOwn(settings, "planThinkingLevel")) {
    const value = settings.planThinkingLevel;
    if (value === undefined || isThinkingLevel(value)) {
      sanitized.planThinkingLevel = value;
    }
  }
  if (Object.hasOwn(settings, "enableProductAnalytics")) {
    const value = settings.enableProductAnalytics;
    if (value === undefined || typeof value === "boolean") {
      sanitized.enableProductAnalytics = value;
    }
  }
  if (Object.hasOwn(settings, "autoBackgroundMs")) {
    const value = settings.autoBackgroundMs;
    if (value === undefined) {
      sanitized.autoBackgroundMs = undefined;
    } else if (typeof value === "number" && AUTO_BACKGROUND_MS_VALUES.has(value)) {
      sanitized.autoBackgroundMs = value;
    }
  }
  if (Object.hasOwn(settings, "agentTaskMaxConcurrent")) {
    const value = settings.agentTaskMaxConcurrent;
    if (value === undefined) {
      sanitized.agentTaskMaxConcurrent = undefined;
    } else {
      const parsed = parseAgentTaskMaxConcurrent(value);
      if (parsed !== undefined) {
        sanitized.agentTaskMaxConcurrent = parsed;
      }
    }
  }

  return sanitized;
}

function getUsableWindow(win: BrowserWindow | null | undefined): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

function getWindowFromEvent(event: IpcMainInvokeEvent): BrowserWindow | null {
  return getUsableWindow(BrowserWindow.fromWebContents(event.sender)) ?? getUsableWindow(currentWindow);
}

function sendWindowMaximizeChange(win: BrowserWindow, maximized: boolean): void {
  if (!win.isDestroyed()) {
    win.webContents.send("window-maximize-change", maximized);
  }
}

function setCurrentWindow(win: BrowserWindow): void {
  currentWindow = win;
  detachWindowStateListeners?.();

  const onMaximize = () => sendWindowMaximizeChange(win, true);
	const onUnmaximize = () => sendWindowMaximizeChange(win, false);
	const onClosed = () => {
		if (currentWindow === win) {
			currentWindow = null;
			detachWindowStateListeners = null;
		}
	};

  win.on("maximize", onMaximize);
  win.on("unmaximize", onUnmaximize);
  win.on("closed", onClosed);
  detachWindowStateListeners = () => {
    win.off("maximize", onMaximize);
    win.off("unmaximize", onUnmaximize);
    win.off("closed", onClosed);
  };
}

function isPathInsideDirectory(candidatePath: string, directoryPath: string): boolean {
  const relativePath = relative(directoryPath, candidatePath);
  // Strictly INSIDE the directory: reject the directory itself (relativePath === "")
  // and any path outside it or on a different drive root. Mirrors
  // SessionBridge._assertSessionPathInNamespace, which throws on rel === "".
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

export function registerIpcHandlers(
  win: BrowserWindow,
  singleSessionBridge: SessionBridge,
  teamLeaderSessionBridge: SessionBridge,
  settingsStore: SettingsStore,
  teamManager: TeamManager,
  agentTaskService: AgentTaskService,
): void {
  setCurrentWindow(win);

  // Prevent duplicate registration (e.g. macOS activate)
  if (handlersRegistered) {
    return;
  }
  handlersRegistered = true;

  // =========================================================================
  // File Dialogs
  // =========================================================================

  // File dialogs: resolve the calling window from event.sender so the
  // handler works after macOS window close/reopen (where the original `win`
  // captured at registration time may be destroyed).
  ipcMain.handle("select-project", async (event) => {
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    if (!callerWin) {
      return null;
    }
    return selectProjectDirectory(callerWin);
  });

  // select-pi-path is kept for backward compat, but now just opens a file dialog
  // since pi path configuration is no longer needed
  ipcMain.handle("select-pi-path", async () => {
    return null; // No longer needed with direct integration.
  });

  ipcMain.handle("select-session-file", async (event) => {
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    if (!callerWin) return null;
    return selectSessionFile(callerWin);
  });

  ipcMain.handle("select-chat-files", async (event) => {
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    if (!callerWin) return [];
    return selectChatFiles(callerWin);
  });

  // =========================================================================
  // Session Lifecycle
  // =========================================================================

  async function disposeTeamRuntime(preserveSnapshot: boolean): Promise<void> {
    try {
      if (teamManager.hasActiveTeam()) {
        await teamManager.stopTeam({ deleteSnapshot: !preserveSnapshot });
      }
    } finally {
      // Always detach the leader bridge even if worker shutdown reports an
      // error; otherwise the old mode can keep receiving commands/events.
      await teamLeaderSessionBridge.dispose();
    }
  }

  ipcMain.handle("start-pi", async (_event, location: unknown) => {
    if (!isProjectLocation(location)) {
      return { success: false, error: "Invalid project location." };
    }
    try {
      // Starting the single runtime is also a mode switch. Preserve any team
      // snapshot so it can be restored when Team mode is entered again.
      await disposeTeamRuntime(true);
      await singleSessionBridge.start(location, settingsStore.getAll());
      // start() created a fresh PlanController; re-attach the plan-event
      // forwarding so the mirror converges without waiting for the next
      // plan command.
      resyncPlanEventForwarding();
      resyncWorkflowEventForwarding();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("stop-pi", async () => {
    try {
      await singleSessionBridge.dispose();
    } catch (err) {
      console.error("[ipc] Error during single session dispose:", err);
    }
    resyncPlanEventForwarding();
    resyncWorkflowEventForwarding();
    return { success: true };
  });

  ipcMain.handle("start-team-runtime", async (_event, location: unknown) => {
    if (!isProjectLocation(location)) {
      return { success: false, error: "Invalid project location." };
    }
    try {
      // A workspace has one active mode. Clear any previous Team runtime and
      // stop the single runtime before bringing up the independent leader.
      await disposeTeamRuntime(true);
      await singleSessionBridge.dispose();
      resyncPlanEventForwarding();
      resyncWorkflowEventForwarding();
      await teamLeaderSessionBridge.start(location, settingsStore.getAll());
      // TeamManager.initialize takes the borrowed leader context (S8); the
      // leader SessionBridge owns the backend and TeamManager never disposes it
      // (wsl_plan.md §4.8).
      const context = teamLeaderSessionBridge.getExecutionContext();
      if (!context) {
        throw new Error("TeamManager initialization failed: execution context unavailable");
      }
      const authStorage = teamLeaderSessionBridge.getAuthStorage();
      if (!authStorage) {
        throw new Error("TeamManager initialization failed: auth storage unavailable");
      }
      await teamManager.initialize(context, authStorage);
      return { success: true };
    } catch (err: unknown) {
      try {
        if (teamManager.hasActiveTeam()) {
          await teamManager.stopTeam({ deleteSnapshot: false });
        }
      } catch (stopErr) {
        console.error("[ipc] TeamManager rollback failed:", stopErr);
      }
      try {
        await teamLeaderSessionBridge.dispose();
      } catch (disposeErr) {
        console.error("[ipc] Team leader rollback failed:", disposeErr);
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("stop-team-runtime", async () => {
    try {
      // Preserve the snapshot. Explicit stop_team remains the disband action.
      await disposeTeamRuntime(true);
    } catch (err) {
      console.error("[ipc] Error during team leader session dispose:", err);
    }
    return { success: true };
  });

  ipcMain.handle("has-team-snapshot", (_event, location: unknown) => {
    // Snapshot existence is keyed by the physical cwd hash (team-persistence.ts);
    // the logical path never participates in the key (wsl_plan.md §4.8).
    if (!isProjectLocation(location)) return false;
    return existsSync(teamSnapshotPath(location.physicalPath));
  });

  ipcMain.handle("get-workspace-mode", async (_event, location: unknown) => {
    if (!isProjectLocation(location)) return null;
    return readWorkspaceMode(location.physicalPath);
  });

  ipcMain.handle("set-workspace-mode", async (_event, location: unknown, mode: "team" | "solo") => {
    if (!isProjectLocation(location)) return;
    if (mode !== "team" && mode !== "solo") return;
    await writeWorkspaceMode(location.physicalPath, mode);
  });

  // =========================================================================
  // Project location, distro & execution environment
  // =========================================================================

  ipcMain.handle("list-wsl-distros", async () => {
    try {
      const resolver = new WslDistroResolver();
      const distros = await resolver.list();
      // v1 accepts only WSL2 (version 2) distros (wsl_plan §4.4 / §1.5). Filter
      // at the source so both the open-project dialog and the global settings
      // page only ever offer v2 distros; a v1-only host surfaces a diagnostic
      // instead of a selectable-but-failing list (wsl_plan §5.1 step 2).
      const v2Distros = distros.filter((d) => d.version === 2);
      if (v2Distros.length === 0) {
        const diagnostic =
          distros.length === 0
            ? "No WSL2 distros found. Install WSL2 and at least one distro (e.g. `wsl --install -d Ubuntu`), then ensure it is version 2."
            : "Found WSL distros, but none are version 2. Convert or reinstall a distro as version 2 (e.g. `wsl --set-version <Distro> 2`).";
        return { distros: v2Distros, diagnostic };
      }
      return { distros: v2Distros };
    } catch (err: unknown) {
      return {
        distros: [],
        diagnostic: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle("resolve-project-location", async (_event, input: unknown) => {
    if (!isProjectLocationInput(input)) {
      return { success: false, error: "Invalid project location input." };
    }
    try {
      const location = await resolveProjectLocation(input);
      return { success: true, location };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("get-execution-environment", () => {
    // The workspace has one active mode. Prefer the team leader environment
    // when a team runtime is active; otherwise report the single runtime.
    return (
      teamLeaderSessionBridge.getExecutionEnvironment() ??
      singleSessionBridge.getExecutionEnvironment()
    );
  });

  // =========================================================================
  // RPC Commands dispatched directly to SessionBridge methods.
  // =========================================================================

  ipcMain.handle("rpc-command", async (_event, command: unknown) => {
    if (!isRpcCommand(command)) {
      return { success: false, error: `Invalid command: ${JSON.stringify(command)}` };
    }
    try {
      const result = await executeCommand(singleSessionBridge, command);
      return { success: true, data: result };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("rpc-command-async", async (_event, command: unknown) => {
    if (!isRpcCommand(command)) {
      console.error("[ipc] Invalid async command:", command);
      return { success: false, error: `Invalid command: ${JSON.stringify(command)}` };
    }
    try {
      await executeCommand(singleSessionBridge, command);
      return { success: true };
    } catch (err) {
      console.error("[ipc] Async command error:", err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // =========================================================================
  // Plan Commands (PiX 1.4.0; always routed through the singleSessionBridge
  // PlanController, design plan §3)
  // =========================================================================

  registerPlanIpcHandlers(ipcMain, () => singleSessionBridge.getPlanController());

  // =========================================================================
  // Workflow Commands (PiX 1.4.3; recorder of the current solo generation,
  // design plan §3)
  // =========================================================================

  registerWorkflowIpcHandlers(ipcMain, () => singleSessionBridge.getWorkflowRecorder());

  // =========================================================================
  // Agent Task Commands (PiX 1.4.1; app-level AgentTaskService, design plan §3)
  // =========================================================================

  registerAgentTaskIpcHandlers(ipcMain, agentTaskService);

  // =========================================================================
  // Git Workdir Commands (PiX 1.5.0; read-only git status + open folder,
  // design plan §4.3.4)
  // =========================================================================

  const gitStatusService = createGitStatusService();
  registerGitIpcHandlers(ipcMain, {
    getStatus: (location) => gitStatusService.getStatus(location as ProjectLocation),
    openFolder: async (location) => {
      // The isProjectLocationLike guard already ran in ipc-git-adapters, so
      // physicalPath is only read for locations that passed it.
      const loc = location as ProjectLocation;
      const result = await shell.openPath(loc.physicalPath);
      if (result) {
        console.warn("[ipc] Failed to open project folder:", result);
        return { success: false, error: result };
      }
      return { success: true };
    },
  });

  // =========================================================================
  // Side-question (/btw) Commands (PiX 1.5.0; design plan §4.2.4)
  // =========================================================================

  registerBtwIpcHandlers(ipcMain, {
    ask: (question) => singleSessionBridge.askSideQuestion(question),
    cancel: () => singleSessionBridge.cancelSideQuestion(),
  });

  // =========================================================================
  // Team Commands
  // =========================================================================

  ipcMain.handle("team-command", async (_event, command: unknown) => {
    if (!isTeamCommand(command)) {
      return { success: false, code: "invalid_team_command", error: `Invalid team command: ${JSON.stringify(command)}` };
    }
    try {
      const result = await executeTeamCommand(teamManager, command);
      return { success: true, data: result };
    } catch (err: unknown) {
      return { success: false, code: "team_command_failed", error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("team-leader-command", async (_event, command: unknown) => {
    if (!isRpcCommand(command)) {
      return { success: false, error: `Invalid command: ${JSON.stringify(command)}` };
    }
    try {
      const result = await executeCommand(teamLeaderSessionBridge, command);
      return { success: true, data: result };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("team-leader-command-async", async (_event, command: unknown) => {
    if (!isRpcCommand(command)) {
      return { success: false, error: `Invalid command: ${JSON.stringify(command)}` };
    }
    try {
      await executeCommand(teamLeaderSessionBridge, command);
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // =========================================================================
  // Active user-input snapshot (remount catch-up)
  // =========================================================================

  ipcMain.handle("get-pending-user-input-request", () => {
    return singleSessionBridge.getActiveUserInputRequest();
  });

  ipcMain.handle("get-team-leader-pending-user-input-request", () => {
    return teamLeaderSessionBridge.getActiveUserInputRequest();
  });

  // =========================================================================
  // Session listing
  // =========================================================================

  ipcMain.handle("list-sessions", async (_event, location: unknown) => {
    if (!isProjectLocation(location)) return [];
    try {
      // Route through SessionBridge so SessionInfo.cwd is translated back to
      // the logical path in WSL mode (wsl_plan.md §4.8). The bridge lists from
      // disk and does not require an active session.
      return await singleSessionBridge.listSessions(location);
    } catch (err) {
      console.error("[ipc] Error listing sessions:", err);
      return [];
    }
  });

  ipcMain.handle("list-team-leader-sessions", async (_event, location: unknown) => {
    if (!isProjectLocation(location)) return [];
    try {
      return await teamLeaderSessionBridge.listSessions(location);
    } catch (err) {
      console.error("[ipc] Error listing team leader sessions:", err);
      return [];
    }
  });

  // =========================================================================
  // Settings
  // =========================================================================

  ipcMain.handle("get-settings", () => {
    return settingsStore.getAll();
  });

  ipcMain.handle("set-settings", (_event, settings: unknown) => {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return { success: false, error: "invalid_settings" };
    }
    settingsStore.setMany(sanitizeSettings(settings as Record<string, unknown>));
    const nextSettings = settingsStore.getAll();
    singleSessionBridge.updateGuiSettings(nextSettings);
    teamLeaderSessionBridge.updateGuiSettings(nextSettings);
    agentTaskService.syncMaxConcurrentSlotsFromSettings();
    return { success: true };
  });

  // =========================================================================
  // Pi Detection (simplified; always "found" with direct integration)
  // =========================================================================

  ipcMain.handle("detect-pi", () => {
    return { found: true, path: "direct", note: "Using direct AgentSession integration (no external pi binary)" };
  });

  ipcMain.handle("get-pi-stderr", () => {
    return ""; // No subprocess, no stderr
  });

  ipcMain.handle("is-pi-running", () => {
    return singleSessionBridge.isRunning();
  });

  ipcMain.handle("is-team-leader-running", () => {
    return teamLeaderSessionBridge.isRunning();
  });

  ipcMain.handle("get-background-tasks", () => {
    return singleSessionBridge.getBackgroundTasks();
  });

  ipcMain.handle("stop-background-task", (_event, taskId: string) => {
    return singleSessionBridge.stopBackgroundTask(taskId);
  });

  ipcMain.handle("get-team-leader-background-tasks", () => {
    return teamLeaderSessionBridge.getBackgroundTasks();
  });

  ipcMain.handle("stop-team-leader-background-task", (_event, taskId: string) => {
    return teamLeaderSessionBridge.stopBackgroundTask(taskId);
  });


  // =========================================================================
  // MCP Queries
  // =========================================================================

  ipcMain.handle("mcp-get-servers", () => {
    return singleSessionBridge.mcpGetServers();
  });

  ipcMain.handle("mcp-get-config", () => {
    return singleSessionBridge.mcpGetConfig();
  });

  ipcMain.handle("mcp-list-resources", async (_event, serverName?: string) => {
    return singleSessionBridge.mcpListResources(serverName);
  });

  ipcMain.handle("mcp-read-resource", async (_event, serverName: string | undefined, uri: string) => {
    return singleSessionBridge.mcpReadResource(serverName, uri);
  });

  ipcMain.handle("team-leader-mcp-get-servers", () => {
    return teamLeaderSessionBridge.mcpGetServers();
  });

  ipcMain.handle("team-leader-mcp-get-config", () => {
    return teamLeaderSessionBridge.mcpGetConfig();
  });

  ipcMain.handle("team-leader-mcp-list-resources", async (_event, serverName?: string) => {
    return teamLeaderSessionBridge.mcpListResources(serverName);
  });

  ipcMain.handle("team-leader-mcp-read-resource", async (_event, serverName: string | undefined, uri: string) => {
    return teamLeaderSessionBridge.mcpReadResource(serverName, uri);
  });

  // =========================================================================
  // Auto Update
  // =========================================================================

  ipcMain.handle("check-for-updates", async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      const currentVersion = autoUpdater.currentVersion.version;
      if (!result) {
        return { success: true, hasUpdate: false, currentVersion };
      }
      const latestVersion = result.updateInfo.version;
      return {
        success: true,
        hasUpdate: latestVersion !== currentVersion,
        currentVersion,
        latestVersion,
        releaseNotes: result.updateInfo.releaseNotes,
        releaseDate: result.updateInfo.releaseDate,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("download-update", async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("install-update", () => {
    autoUpdater.quitAndInstall();
  });

  // =========================================================================
  // External Links
  // =========================================================================

  ipcMain.handle("open-external", async (_event, url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
        await shell.openExternal(url);
      }
    } catch (err) {
      console.error("[ipc] Failed to open external URL:", url, err);
    }
  });

  // =========================================================================
  // Window Controls (frameless window)
  // =========================================================================

  ipcMain.handle("window-minimize", (event) => {
    getWindowFromEvent(event)?.minimize();
  });

  ipcMain.handle("window-maximize", (event) => {
    const targetWin = getWindowFromEvent(event);
    if (!targetWin) return;
    if (targetWin.isMaximized()) {
      targetWin.unmaximize();
    } else {
      targetWin.maximize();
    }
  });

  ipcMain.handle("window-close", (event) => {
    getWindowFromEvent(event)?.close();
  });

  ipcMain.handle("window-is-maximized", (event) => {
    return getWindowFromEvent(event)?.isMaximized() ?? false;
  });

  // =========================================================================
  // Session Management (delete, pin)
  // =========================================================================

  ipcMain.handle("delete-session", async (_event, sessionPath: string) => {
    try {
      const resolved = resolve(sessionPath);
      // Guard: only delete session files, never arbitrary paths
      const agentDir = resolve(getAgentDir());
      const sessionDirs = [
        resolve(join(agentDir, "sessions")),
        resolve(join(agentDir, "team-leader-sessions")),
      ];
      if (!sessionDirs.some((sessionDir) => isPathInsideDirectory(resolved, sessionDir))) {
        return { success: false, error: "Invalid session path" };
      }
      if (existsSync(resolved)) {
        rmSync(resolved, { recursive: true, force: true });
        return { success: true };
      }
      return { success: false, error: "Session file not found" };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

// ===========================================================================
// Command Dispatch
// ===========================================================================

function isRpcCommand(cmd: unknown): cmd is RpcCommand {
  return (
    typeof cmd === "object" &&
    cmd !== null &&
    "type" in cmd &&
    typeof (cmd as Record<string, unknown>).type === "string"
  );
}

async function executeCommand(bridge: SessionBridge, cmd: RpcCommand): Promise<unknown> {
  switch (cmd.type) {
    // Prompting
    case "prompt":
      await bridge.prompt(cmd.message, cmd.filePaths, cmd.images);
      return null;
    case "steer":
      await bridge.steer(cmd.message, cmd.filePaths, cmd.images);
      return null;
    case "follow_up":
      await bridge.followUp(cmd.message, cmd.filePaths, cmd.images);
      return null;
    case "abort":
      await bridge.abort();
      return null;
    case "retry":
      await bridge.retry();
      return null;
    case "abort_retry":
      bridge.abortRetry();
      return null;
    case "respond_user_input":
      bridge.respondUserInput(cmd.response);
      return null;

    // State
    case "get_state":
      return bridge.getState();

    // Model
    case "set_model":
      await bridge.setModel(cmd.provider, cmd.modelId);
      return null;
    case "cycle_model":
      await bridge.cycleModel(cmd.direction ?? "forward");
      return null;
    case "get_available_models":
      return { models: bridge.getAvailableModels() };
    case "get_available_thinking_levels":
      return bridge.getAvailableThinkingLevels();
    case "supports_thinking":
      return bridge.supportsThinking();
    case "set_scoped_models":
      await bridge.setScopedModels(cmd.patterns);
      return null;
    case "get_scoped_models":
      return bridge.getScopedModels();

    // Thinking
    case "set_thinking_level":
      bridge.setThinkingLevel(cmd.level);
      return null;
    case "cycle_thinking_level":
      bridge.cycleThinkingLevel();
      return null;

    // Compaction
    case "compact":
      await bridge.compact(cmd.customInstructions);
      return null;

    // Session
    case "get_session_stats":
      return bridge.getSessionStats();
    case "switch_session": {
      const result = await bridge.switchSession(cmd.sessionPath);
      // The switch replaced the PlanController instance; re-sync the
      // plan-event forwarding so the renderer mirror converges to the new
      // session's plan (the re-sync pushes a fresh snapshot on change).
      resyncPlanEventForwarding();
      resyncWorkflowEventForwarding();
      return result;
    }
    case "fork": {
      const result = await bridge.fork(cmd.entryId, cmd.position ?? "before", cmd.label);
      resyncPlanEventForwarding();
      resyncWorkflowEventForwarding();
      return result;
    }
    case "navigate_tree": {
      const result = await bridge.navigateTree(cmd.targetId, {
        summarize: cmd.summarize,
        customInstructions: cmd.customInstructions,
        replaceInstructions: cmd.replaceInstructions,
        label: cmd.label,
      });
      resyncPlanEventForwarding();
      resyncWorkflowEventForwarding();
      return result;
    }
    case "clone": {
      const result = await bridge.clone();
      resyncPlanEventForwarding();
      resyncWorkflowEventForwarding();
      return result;
    }
    case "get_last_assistant_text":
      return bridge.getLastAssistantText();
    case "set_session_name":
      bridge.setSessionName(cmd.name);
      return null;
    case "get_tree":
      return bridge.getTree();
    case "get_user_messages_for_forking":
      return bridge.getUserMessagesForForking();
    case "set_steering_mode":
      bridge.setSteeringMode(cmd.mode);
      return null;
    case "set_follow_up_mode":
      bridge.setFollowUpMode(cmd.mode);
      return null;

    // Messages
    case "get_messages":
      return bridge.getMessages();

    // Commands
    case "get_commands":
      return { commands: await bridge.getCommands() };

    // Session management (new)
    case "new_session": {
      const result = await bridge.newSession(cmd.parentSession);
      // Like switch_session/fork/clone: the new session owns a fresh
      // PlanController, so re-sync plan-event forwarding to it.
      resyncPlanEventForwarding();
      resyncWorkflowEventForwarding();
      return result;
    }

    // Export
    case "export_html":
      return { path: await bridge.exportToHtml(cmd.outputPath) };
    case "export_jsonl":
      return { path: await bridge.exportToJsonl(cmd.outputPath) };

    // Auth
    case "set_api_key":
      bridge.setApiKey(cmd.provider, cmd.key);
      return null;
    case "remove_auth":
      bridge.removeAuth(cmd.provider);
      return null;
    case "get_auth_status":
      return bridge.getAuthStatus();
    case "get_custom_providers":
      return bridge.getCustomProviders();
    case "set_custom_providers":
      return bridge.setCustomProviders(cmd.providers);

    // Settings (full pi settings)
    case "get_pi_settings":
      return bridge.getPiSettings();
    case "set_pi_setting":
      await bridge.setPiSetting(cmd.key, cmd.value);
      return null;
    case "set_pi_settings":
      await bridge.setPiSettings(cmd.entries);
      return null;

    // Resources
    case "reload_resources":
      await bridge.reloadResources();
      return null;
    case "get_themes":
      return bridge.getThemes();
    case "get_resource_status":
      return bridge.getResourceStatus();

    default:
      throw new Error(`Unknown command type: ${(cmd as { type: string }).type}`);
  }
}

// ===========================================================================
// Event Forwarding
// ===========================================================================

/**
 * Set up event forwarding from SessionBridge to renderer.
 *
 * Uses a getter for the current window so that forwarding survives
 * window close/reopen cycles on macOS (where the app stays alive
 * after all windows close and `activate` creates a new window).
 */
export function setupEventForwarding(
  getWin: () => BrowserWindow | null,
  singleSessionBridge: SessionBridge,
  teamLeaderSessionBridge: SessionBridge,
  teamManager: TeamManager,
  agentTaskService: AgentTaskService,
): void {
  if (eventForwardingSetup) return;
  eventForwardingSetup = true;

  // Forward TeamManager worker/task/protocol events independently from the
  // leader AgentSession event stream.
  eventForwardingUnsubscribes.push(teamManager.onEvent((event) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("team-event", event);
    }
  }));

  // Forward ordinary session events.
  eventForwardingUnsubscribes.push(singleSessionBridge.onEvent((event) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("pi-event", event);
    }
  }));

  eventForwardingUnsubscribes.push(singleSessionBridge.onUserInputRequest((request) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("user-input-request", request);
    }
  }));

  // Dismissals forward on their own channels, preserving the bridge's event
  // order (a dismissal always precedes the following request). ipc-handlers
  // never generates dismissals and never maintains UI state.
  eventForwardingUnsubscribes.push(singleSessionBridge.onUserInputDismissed((event) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("user-input-dismissed", event);
    }
  }));

  // Lifecycle: ready
  eventForwardingUnsubscribes.push(singleSessionBridge.onLifecycle("ready", () => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("pi-ready");
    }
  }));

  // Lifecycle: exit
  eventForwardingUnsubscribes.push(singleSessionBridge.onLifecycle("exit", (data) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("pi-exit", data);
    }
  }));

  // Lifecycle: error
  eventForwardingUnsubscribes.push(singleSessionBridge.onLifecycle("error", (err) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("pi-error", { message: err.message ?? String(err) });
    }
  }));

  // Forward PlanController events (PiX 1.4.0) on the dedicated plan-event
  // channel. The controller instance is re-resolved per event because each
  // solo runtime generation owns its own PlanController.
  eventForwardingUnsubscribes.push(
    subscribePlanEventForwarding(
      () => {
        const win = getWin();
        return win && !win.isDestroyed() ? win.webContents : null;
      },
      () => singleSessionBridge.getPlanController(),
    ),
  );

  // Forward WorkflowRecorder fold changes (PiX 1.4.3) on the dedicated
  // workflow-event channel. Like the PlanController, each solo runtime
  // generation owns its own recorder, so the subscription is re-synced to
  // the current instance (command-time hook + the session-switching paths
  // via resyncWorkflowEventForwarding). The entry stream for the recorder's
  // restore fallback is injected here: the adapter never imports
  // SessionBridge, and the bridge restores the same entries at generation
  // activation (plan §2.3), so a swapped-instance resync re-folding them is
  // idempotent (the recorder dedups restored records).
  eventForwardingUnsubscribes.push(
    subscribeWorkflowEventForwarding(
      () => {
        const win = getWin();
        return win && !win.isDestroyed() ? win.webContents : null;
      },
      () => singleSessionBridge.getWorkflowRecorder(),
      () => singleSessionBridge.getSessionWorkflowEntries(),
    ),
  );

  // Forward AgentTaskService events (PiX 1.4.1) on the dedicated agent-task
  // channels. The service is app-level and stable for the process lifetime, so
  // one subscription at setup time is enough (unlike the per-session
  // PlanController, which needs the command-time re-sync hook).
  eventForwardingUnsubscribes.push(
    subscribeAgentTaskEventForwarding(
      () => {
        const win = getWin();
        return win && !win.isDestroyed() ? win.webContents : null;
      },
      agentTaskService,
    ),
  );

  // Forward Team leader AgentSession events on dedicated channels.
  eventForwardingUnsubscribes.push(teamLeaderSessionBridge.onEvent((event) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("team-leader-event", event);
    }
  }));

  eventForwardingUnsubscribes.push(teamLeaderSessionBridge.onUserInputRequest((request) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("team-leader-user-input-request", request);
    }
  }));

  eventForwardingUnsubscribes.push(teamLeaderSessionBridge.onUserInputDismissed((event) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("team-leader-user-input-dismissed", event);
    }
  }));

  eventForwardingUnsubscribes.push(teamLeaderSessionBridge.onLifecycle("ready", () => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("team-leader-ready");
    }
  }));

  eventForwardingUnsubscribes.push(teamLeaderSessionBridge.onLifecycle("exit", (data) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("team-leader-exit", data);
    }
  }));

  eventForwardingUnsubscribes.push(teamLeaderSessionBridge.onLifecycle("error", (err) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("team-leader-error", { message: err.message ?? String(err) });
    }
  }));
}

export function teardownEventForwarding(): void {
  for (const unsubscribe of eventForwardingUnsubscribes.splice(0)) {
    try {
      unsubscribe();
    } catch (err) {
      console.error("[ipc] Error tearing down event forwarding:", err);
    }
  }
  eventForwardingSetup = false;
}

// ===========================================================================
// Team Command Dispatch
// ===========================================================================

const VALID_TEAM_COMMAND_TYPES = new Set([
  "create_team",
  "get_team_state",
  "get_team_history",
  "stop_team",
  "send_message",
  "abort_worker",
  "activate_member",
  "pause_member",
  "create_task",
  "delete_task",
  "request_shutdown",
  "respond_permission",
  "respond_plan_approval",
  "restart_worker",
]);

function isTeamCommand(cmd: unknown): cmd is TeamCommand {
  if (typeof cmd !== "object" || cmd === null || !("type" in cmd)) return false;
  const type = (cmd as Record<string, unknown>).type;
  if (typeof type !== "string" || !VALID_TEAM_COMMAND_TYPES.has(type)) return false;

  // Validate required sub-fields per command type
  const c = cmd as Record<string, unknown>;
  switch (type) {
    case "send_message":
      return typeof c.agentId === "string" && typeof c.message === "string";
    case "abort_worker":
    case "activate_member":
    case "pause_member":
      return typeof c.agentId === "string";
    case "create_task":
      return typeof c.subject === "string" && typeof c.description === "string";
    case "delete_task":
      return typeof c.taskId === "string";
    case "request_shutdown":
      return true; // agentId is optional (all workers if omitted)
    case "respond_permission":
      return typeof c.requestId === "string" && typeof c.approved === "boolean";
    case "respond_plan_approval":
      return typeof c.approvalId === "string" && typeof c.approved === "boolean";
    case "restart_worker":
      return typeof c.agentId === "string";
    default:
      return true;
  }
}

async function executeTeamCommand(teamManager: TeamManager, cmd: TeamCommand): Promise<unknown> {
  switch (cmd.type) {
    case "create_team":
      return teamManager.createTeam(cmd.teamName);
    case "get_team_state":
      return teamManager.getTeamState();
    case "get_team_history":
      return teamManager.getTeamHistory();
    case "stop_team":
      await teamManager.stopTeam();
      return null;
    case "send_message":
      await teamManager.sendMessageToWorker(cmd.agentId, cmd.message);
      return null;
    case "abort_worker":
      teamManager.resumeRuntime("renderer_abort_worker");
      await teamManager.abortWorker(cmd.agentId);
      return null;
    case "activate_member":
      teamManager.resumeRuntime("renderer_activate_member");
      await teamManager.activateMember(cmd.agentId);
      return null;
    case "pause_member":
      teamManager.resumeRuntime("renderer_pause_member");
      await teamManager.pauseMember(cmd.agentId);
      return null;
    case "create_task":
      teamManager.resumeRuntime("renderer_create_task");
      return teamManager.createTask(cmd.subject, cmd.description, cmd.assignTo, cmd.blockedBy, cmd.taskType);
    case "delete_task":
      teamManager.resumeRuntime("renderer_delete_task");
      teamManager.deleteTask(cmd.taskId);
      return null;
    case "request_shutdown":
      teamManager.resumeRuntime("renderer_request_shutdown");
      return teamManager.requestShutdown(cmd.agentId);
    case "respond_permission":
      teamManager.resumeRuntime("renderer_respond_permission");
      teamManager.respondPermission(cmd.requestId, cmd.approved, cmd.reason);
      return null;
    case "respond_plan_approval":
      teamManager.resumeRuntime("renderer_respond_plan_approval");
      teamManager.respondPlanApproval(cmd.approvalId, cmd.approved, cmd.feedback);
      return null;
    case "restart_worker":
      teamManager.resumeRuntime("renderer_restart_worker");
      await teamManager.restartWorker(cmd.agentId);
      return null;
    default:
      throw new Error(`Unknown team command type: ${(cmd as { type: string }).type}`);
  }
}

// Re-export the pure plan/agent-task IPC adapters (see ipc-plan-adapters.ts /
// ipc-agent-task-adapters.ts) so callers that import the registration
// functions, event-forwarding subscriptions or adapter types from
// ipc-handlers keep working.
export {
  executePlanCommand,
  isPlanCommand,
  registerPlanIpcHandlers,
  resyncPlanEventForwarding,
  subscribePlanEventForwarding,
  type IpcMainLike,
  type WebContentsLike,
} from "./ipc-plan-adapters.js";

export {
  executeAgentTaskCommand,
  isAgentTaskCommand,
  registerAgentTaskIpcHandlers,
  subscribeAgentTaskEventForwarding,
} from "./ipc-agent-task-adapters.js";

export {
  executeWorkflowCommand,
  registerWorkflowIpcHandlers,
  resyncWorkflowEventForwarding,
  subscribeWorkflowEventForwarding,
} from "./ipc-workflow-adapters.js";
