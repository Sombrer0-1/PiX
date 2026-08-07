/**
 * Preload Script
 *
 * Exposes a typed API to the renderer process via contextBridge.
 */

import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AgentSessionEvent,
  ExecutionEnvironmentInfo,
  GuiSettings,
  McpConfigInfo,
  McpResourceContent,
  McpResourceInfo,
  McpServerInfo,
  ProjectLocation,
  ProjectLocationInput,
  RequestUserInputRequest,
  ResolveProjectLocationResult,
  RpcCommand,
  SessionInfo,
  TeamCommand,
  TeamEvent,
  TeamState,
  WslDistroListResult,
} from "../shared/types.js";

export interface PixApi {
  // File dialogs
  selectProject: () => Promise<string | null>;
  selectPiPath: () => Promise<string | null>;
  selectSessionFile: () => Promise<string | null>;
  selectChatFiles: () => Promise<string[]>;
  getPathForFile: (file: File) => string;

  // External links
  openExternal: (url: string) => void;

  // Pi lifecycle
  startPi: (location: ProjectLocation) => Promise<{ success: boolean; error?: string }>;
  stopPi: () => Promise<{ success: boolean }>;
  startTeamRuntime: (location: ProjectLocation) => Promise<{ success: boolean; error?: string }>;
  stopTeamRuntime: () => Promise<{ success: boolean }>;
  hasTeamSnapshot: (location: ProjectLocation) => Promise<boolean>;
  getWorkspaceMode: (location: ProjectLocation) => Promise<"team" | "solo" | null>;
  setWorkspaceMode: (location: ProjectLocation, mode: "team" | "solo") => Promise<void>;

  // Project location, distro & execution environment
  listWslDistros: () => Promise<WslDistroListResult>;
  resolveProjectLocation: (input: ProjectLocationInput) => Promise<ResolveProjectLocationResult>;
  getExecutionEnvironment: () => Promise<ExecutionEnvironmentInfo | null>;

  // RPC commands
  sendCommand: <T = unknown>(command: RpcCommand) => Promise<{ success: boolean; data?: T; error?: string }>;
  sendCommandAsync: (command: RpcCommand) => Promise<{ success: boolean; error?: string }>;

  // Settings
  getSettings: () => Promise<GuiSettings>;
  setSettings: (settings: Partial<GuiSettings>) => Promise<{ success: boolean }>;

  // Pi detection
  detectPi: () => Promise<{ found: boolean; path: string; note?: string }>;
  getPiStderr: () => Promise<string>;
  isPiRunning: () => Promise<boolean>;
  isTeamLeaderRunning: () => Promise<boolean>;

  // Event subscriptions
  onPiEvent: (callback: (event: AgentSessionEvent) => void) => () => void;
  onPiResponse: (callback: (response: unknown) => void) => () => void;
  onPiExit: (callback: (data: { code: number | null; signal: string | null; stderr: string }) => void) => () => void;
  onPiError: (callback: (err: { message: string }) => void) => () => void;
  onPiReady: (callback: () => void) => () => void;
  onUserInputRequest: (callback: (request: RequestUserInputRequest) => void) => () => void;
  onTeamLeaderEvent: (callback: (event: AgentSessionEvent) => void) => () => void;
  onTeamLeaderExit: (callback: (data: { code: number | null; signal: string | null; stderr: string }) => void) => () => void;
  onTeamLeaderError: (callback: (err: { message: string }) => void) => () => void;
  onTeamLeaderReady: (callback: () => void) => () => void;
  onTeamLeaderUserInputRequest: (callback: (request: RequestUserInputRequest) => void) => () => void;

  // Session management
  listSessions: (location: ProjectLocation) => Promise<SessionInfo[]>;
  listTeamLeaderSessions: (location: ProjectLocation) => Promise<SessionInfo[]>;

  // Window controls (frameless window)
  windowMinimize: () => Promise<void>;
  windowMaximize: () => Promise<void>;
  windowClose: () => Promise<void>;
  windowIsMaximized: () => Promise<boolean>;
  onWindowMaximizeChange: (callback: (maximized: boolean) => void) => () => void;

  // Background tasks
  getBackgroundTasks: () => Promise<Array<{ taskId: string; command: string; pid?: number; startedAt: number; status: string }>>;
  stopBackgroundTask: (taskId: string) => Promise<{ found: boolean }>;

  // Session management
  deleteSession: (sessionPath: string) => Promise<{ success: boolean; error?: string }>;

  // MCP queries
  mcpGetServers: () => Promise<McpServerInfo[]>;
  mcpGetConfig: () => Promise<McpConfigInfo>;
  mcpListResources: (serverName?: string) => Promise<McpResourceInfo[]>;
  mcpReadResource: (serverName: string | undefined, uri: string) => Promise<McpResourceContent>;

  // Auto update
  checkForUpdates: () => Promise<{
    success: boolean;
    hasUpdate?: boolean;
    currentVersion?: string;
    latestVersion?: string;
    releaseNotes?: string;
    releaseDate?: string;
    error?: string;
  }>;
  downloadUpdate: () => Promise<{ success: boolean; error?: string }>;
  installUpdate: () => void;

  // Team commands
  sendTeamCommand: <T = unknown>(command: TeamCommand) => Promise<{ success: boolean; data?: T; error?: string; code?: string }>;
  sendTeamLeaderCommand: <T = unknown>(command: RpcCommand) => Promise<{ success: boolean; data?: T; error?: string }>;
  sendTeamLeaderCommandAsync: (command: RpcCommand) => Promise<{ success: boolean; error?: string }>;
  onTeamEvent: (callback: (event: TeamEvent) => void) => () => void;

  // Team leader background tasks and MCP queries
  getTeamLeaderBackgroundTasks: () => Promise<Array<{ taskId: string; command: string; pid?: number; startedAt: number; status: string }>>;
  stopTeamLeaderBackgroundTask: (taskId: string) => Promise<{ found: boolean }>;
  teamLeaderMcpGetServers: () => Promise<McpServerInfo[]>;
  teamLeaderMcpGetConfig: () => Promise<McpConfigInfo>;
  teamLeaderMcpListResources: (serverName?: string) => Promise<McpResourceInfo[]>;
  teamLeaderMcpReadResource: (serverName: string | undefined, uri: string) => Promise<McpResourceContent>;
}

const api: PixApi = {
  selectProject: () => ipcRenderer.invoke("select-project"),
  selectPiPath: () => ipcRenderer.invoke("select-pi-path"),
  selectSessionFile: () => ipcRenderer.invoke("select-session-file"),
  selectChatFiles: () => ipcRenderer.invoke("select-chat-files"),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),

  startPi: (location: ProjectLocation) => ipcRenderer.invoke("start-pi", location),
  stopPi: () => ipcRenderer.invoke("stop-pi"),
  startTeamRuntime: (location: ProjectLocation) => ipcRenderer.invoke("start-team-runtime", location),
  stopTeamRuntime: () => ipcRenderer.invoke("stop-team-runtime"),
  hasTeamSnapshot: (location: ProjectLocation) => ipcRenderer.invoke("has-team-snapshot", location),
  getWorkspaceMode: (location: ProjectLocation) => ipcRenderer.invoke("get-workspace-mode", location),
  setWorkspaceMode: (location: ProjectLocation, mode: "team" | "solo") => ipcRenderer.invoke("set-workspace-mode", location, mode),
  listWslDistros: () => ipcRenderer.invoke("list-wsl-distros"),
  resolveProjectLocation: (input: ProjectLocationInput) => ipcRenderer.invoke("resolve-project-location", input),
  getExecutionEnvironment: () => ipcRenderer.invoke("get-execution-environment"),

  sendCommand: <T = unknown>(command: RpcCommand) =>
    ipcRenderer.invoke("rpc-command", command) as Promise<{ success: boolean; data?: T; error?: string }>,
  sendCommandAsync: (command: RpcCommand) =>
    ipcRenderer.invoke("rpc-command-async", command) as Promise<{ success: boolean; error?: string }>,

  getSettings: () => ipcRenderer.invoke("get-settings"),
  setSettings: (settings: Partial<GuiSettings>) => ipcRenderer.invoke("set-settings", settings),

  detectPi: () => ipcRenderer.invoke("detect-pi"),
  getPiStderr: () => ipcRenderer.invoke("get-pi-stderr"),
  isPiRunning: () => ipcRenderer.invoke("is-pi-running"),
  isTeamLeaderRunning: () => ipcRenderer.invoke("is-team-leader-running"),

  onPiEvent: (callback: (event: AgentSessionEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: AgentSessionEvent) => callback(data);
    ipcRenderer.on("pi-event", handler);
    return () => ipcRenderer.removeListener("pi-event", handler);
  },
  onPiResponse: (callback: (response: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on("pi-response", handler);
    return () => ipcRenderer.removeListener("pi-response", handler);
  },
  onPiExit: (callback: (data: { code: number | null; signal: string | null; stderr: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { code: number | null; signal: string | null; stderr: string }) => callback(data);
    ipcRenderer.on("pi-exit", handler);
    return () => ipcRenderer.removeListener("pi-exit", handler);
  },
  onPiError: (callback: (err: { message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { message: string }) => callback(data);
    ipcRenderer.on("pi-error", handler);
    return () => ipcRenderer.removeListener("pi-error", handler);
  },
  onPiReady: (callback: () => void) => {
    ipcRenderer.on("pi-ready", callback);
    return () => ipcRenderer.removeListener("pi-ready", callback);
  },
  onUserInputRequest: (callback: (request: RequestUserInputRequest) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: RequestUserInputRequest) => callback(data);
    ipcRenderer.on("user-input-request", handler);
    return () => ipcRenderer.removeListener("user-input-request", handler);
  },
  onTeamLeaderEvent: (callback: (event: AgentSessionEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: AgentSessionEvent) => callback(data);
    ipcRenderer.on("team-leader-event", handler);
    return () => ipcRenderer.removeListener("team-leader-event", handler);
  },
  onTeamLeaderExit: (callback: (data: { code: number | null; signal: string | null; stderr: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { code: number | null; signal: string | null; stderr: string }) => callback(data);
    ipcRenderer.on("team-leader-exit", handler);
    return () => ipcRenderer.removeListener("team-leader-exit", handler);
  },
  onTeamLeaderError: (callback: (err: { message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { message: string }) => callback(data);
    ipcRenderer.on("team-leader-error", handler);
    return () => ipcRenderer.removeListener("team-leader-error", handler);
  },
  onTeamLeaderReady: (callback: () => void) => {
    ipcRenderer.on("team-leader-ready", callback);
    return () => ipcRenderer.removeListener("team-leader-ready", callback);
  },
  onTeamLeaderUserInputRequest: (callback: (request: RequestUserInputRequest) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: RequestUserInputRequest) => callback(data);
    ipcRenderer.on("team-leader-user-input-request", handler);
    return () => ipcRenderer.removeListener("team-leader-user-input-request", handler);
  },

  listSessions: (location: ProjectLocation) => ipcRenderer.invoke("list-sessions", location),
  listTeamLeaderSessions: (location: ProjectLocation) => ipcRenderer.invoke("list-team-leader-sessions", location),

  // Window controls
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximize: () => ipcRenderer.invoke("window-maximize"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  onWindowMaximizeChange: (callback: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) => callback(maximized);
    ipcRenderer.on("window-maximize-change", handler);
    return () => ipcRenderer.removeListener("window-maximize-change", handler);
  },

  deleteSession: (sessionPath: string) =>
    ipcRenderer.invoke("delete-session", sessionPath) as Promise<{ success: boolean; error?: string }>,

  getBackgroundTasks: () =>
    ipcRenderer.invoke("get-background-tasks") as Promise<Array<{ taskId: string; command: string; pid?: number; startedAt: number; status: string }>>,

  stopBackgroundTask: (taskId: string) =>
    ipcRenderer.invoke("stop-background-task", taskId) as Promise<{ found: boolean }>,

  // MCP queries
  mcpGetServers: () => ipcRenderer.invoke("mcp-get-servers"),
  mcpGetConfig: () => ipcRenderer.invoke("mcp-get-config"),
  mcpListResources: (serverName?: string) => ipcRenderer.invoke("mcp-list-resources", serverName),
  mcpReadResource: (serverName: string | undefined, uri: string) =>
    ipcRenderer.invoke("mcp-read-resource", serverName, uri),

  // Auto update
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),

  // Team commands
  sendTeamCommand: <T = unknown>(command: TeamCommand) =>
    ipcRenderer.invoke("team-command", command) as Promise<{ success: boolean; data?: T; error?: string; code?: string }>,
  onTeamEvent: (callback: (event: TeamEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: TeamEvent) => callback(data);
    ipcRenderer.on("team-event", handler);
    return () => ipcRenderer.removeListener("team-event", handler);
  },
  sendTeamLeaderCommand: <T = unknown>(command: RpcCommand) =>
    ipcRenderer.invoke("team-leader-command", command) as Promise<{ success: boolean; data?: T; error?: string }>,
  sendTeamLeaderCommandAsync: (command: RpcCommand) =>
    ipcRenderer.invoke("team-leader-command-async", command) as Promise<{ success: boolean; error?: string }>,
  getTeamLeaderBackgroundTasks: () =>
    ipcRenderer.invoke("get-team-leader-background-tasks") as Promise<Array<{ taskId: string; command: string; pid?: number; startedAt: number; status: string }>>,
  stopTeamLeaderBackgroundTask: (taskId: string) =>
    ipcRenderer.invoke("stop-team-leader-background-task", taskId) as Promise<{ found: boolean }>,
  teamLeaderMcpGetServers: () => ipcRenderer.invoke("team-leader-mcp-get-servers"),
  teamLeaderMcpGetConfig: () => ipcRenderer.invoke("team-leader-mcp-get-config"),
  teamLeaderMcpListResources: (serverName?: string) => ipcRenderer.invoke("team-leader-mcp-list-resources", serverName),
  teamLeaderMcpReadResource: (serverName: string | undefined, uri: string) =>
    ipcRenderer.invoke("team-leader-mcp-read-resource", serverName, uri),
};

contextBridge.exposeInMainWorld("pixApi", api);
