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
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import electronUpdater from "electron-updater";
import { selectChatFiles, selectProjectDirectory, selectSessionFile } from "./file-dialogs.js";
import type { SessionBridge } from "./session-bridge.js";
import type { SettingsStore } from "./settings-store.js";
import type { GuiSettings, ProjectInfo, RpcCommand, ThinkingLevel } from "../shared/types.js";

const { autoUpdater } = electronUpdater;

let handlersRegistered = false;
let eventForwardingSetup = false;
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
]);

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
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function registerIpcHandlers(
  win: BrowserWindow,
  sessionBridge: SessionBridge,
  settingsStore: SettingsStore
): void {
  setCurrentWindow(win);

  // Prevent duplicate registration (e.g. macOS activate)
  if (handlersRegistered) {
    console.log("[ipc-handlers] Already registered, skipping");
    return;
  }
  handlersRegistered = true;
  console.log("[ipc-handlers] registerIpcHandlers() start");

  // =========================================================================
  // File Dialogs
  // =========================================================================

  // File dialogs: resolve the calling window from event.sender so the
  // handler works after macOS window close/reopen (where the original `win`
  // captured at registration time may be destroyed).
  ipcMain.handle("select-project", async (event) => {
    console.log("[ipc-handlers] select-project handler invoked");
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    console.log("[ipc-handlers] callerWin from webContents:", !!callerWin);
    if (!callerWin) {
      console.log("[ipc-handlers] NO callerWin, returning null");
      return null;
    }
    console.log("[ipc-handlers] calling selectProjectDirectory");
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

  ipcMain.handle("start-pi", async (_event, projectDir: string) => {
    try {
      await sessionBridge.start(projectDir, settingsStore.getAll());
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("stop-pi", async () => {
    try {
      await sessionBridge.dispose();
    } catch (err) {
      console.error("[ipc] Error during session dispose:", err);
    }
    return { success: true };
  });

  // =========================================================================
  // RPC Commands dispatched directly to SessionBridge methods.
  // =========================================================================

  ipcMain.handle("rpc-command", async (_event, command: unknown) => {
    if (!isRpcCommand(command)) {
      return { success: false, error: `Invalid command: ${JSON.stringify(command)}` };
    }
    try {
      const result = await executeCommand(sessionBridge, command);
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
      await executeCommand(sessionBridge, command);
      return { success: true };
    } catch (err) {
      console.error("[ipc] Async command error:", err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // =========================================================================
  // Session listing
  // =========================================================================

  ipcMain.handle("list-sessions", async (_event, projectDir: string) => {
    try {
      const sessions = await SessionManager.list(projectDir);
      return sessions.map((session) => ({
        path: session.path,
        id: session.id,
        cwd: session.cwd || projectDir,
        name: session.name,
        created: session.created.toISOString(),
        modified: session.modified.toISOString(),
        messageCount: session.messageCount,
        firstMessage: session.firstMessage,
      }));
    } catch (err) {
      console.error("[ipc] Error listing sessions:", err);
      return [];
    }
  });

  // =========================================================================
  // Settings
  // =========================================================================

  ipcMain.handle("get-settings", () => {
    return settingsStore.getAll();
  });

  ipcMain.handle("set-settings", (_event, settings: Record<string, unknown>) => {
    settingsStore.setMany(sanitizeSettings(settings));
    sessionBridge.updateGuiSettings(settingsStore.getAll());
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
    return sessionBridge.isRunning();
  });


  // =========================================================================
  // MCP Queries
  // =========================================================================

  ipcMain.handle("mcp-get-servers", () => {
    return sessionBridge.mcpGetServers();
  });

  ipcMain.handle("mcp-get-config", () => {
    return sessionBridge.mcpGetConfig();
  });

  ipcMain.handle("mcp-list-resources", async (_event, serverName?: string) => {
    return sessionBridge.mcpListResources(serverName);
  });

  ipcMain.handle("mcp-read-resource", async (_event, serverName: string | undefined, uri: string) => {
    return sessionBridge.mcpReadResource(serverName, uri);
  });

  // =========================================================================
  // Auto Update
  // =========================================================================

  ipcMain.handle("check-for-updates", async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result) {
        return { success: true, hasUpdate: false, currentVersion: autoUpdater.currentVersion.version };
      }
      return {
        success: true,
        hasUpdate: true,
        currentVersion: autoUpdater.currentVersion.version,
        latestVersion: result.updateInfo.version,
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
      const { shell } = await import("electron");
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
      const sessionsDir = resolve(join(agentDir, "sessions"));
      if (!isPathInsideDirectory(resolved, sessionsDir)) {
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
      await bridge.prompt(cmd.message, cmd.filePaths);
      return null;
    case "steer":
      await bridge.steer(cmd.message, cmd.filePaths);
      return null;
    case "follow_up":
      await bridge.followUp(cmd.message, cmd.filePaths);
      return null;
    case "abort":
      await bridge.abort();
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
    case "switch_session":
      return bridge.switchSession(cmd.sessionPath);
    case "fork":
      return bridge.fork(cmd.entryId, cmd.position ?? "before", cmd.label);
    case "navigate_tree":
      return bridge.navigateTree(cmd.targetId, {
        summarize: cmd.summarize,
        customInstructions: cmd.customInstructions,
        replaceInstructions: cmd.replaceInstructions,
        label: cmd.label,
      });
    case "clone":
      return bridge.clone();
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
    case "new_session":
      return bridge.newSession(cmd.parentSession);

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
  sessionBridge: SessionBridge
): void {
  if (eventForwardingSetup) return;
  eventForwardingSetup = true;

  // Forward agent session events
  sessionBridge.onEvent((event) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("pi-event", event);
    }
  });

  sessionBridge.onUserInputRequest((request) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("user-input-request", request);
    }
  });

  // Lifecycle: ready
  sessionBridge.onLifecycle("ready", () => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("pi-ready");
    }
  });

  // Lifecycle: exit
  sessionBridge.onLifecycle("exit", (data) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("pi-exit", data);
    }
  });

  // Lifecycle: error
  sessionBridge.onLifecycle("error", (err) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("pi-error", { message: err.message ?? String(err) });
    }
  });
}
