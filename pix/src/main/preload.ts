/**
 * Preload Script
 *
 * Exposes a typed API to the renderer process via contextBridge.
 */

import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AgentSessionEvent,
  GuiSettings,
  McpConfigInfo,
  McpResourceContent,
  McpResourceInfo,
  McpServerInfo,
  RequestUserInputRequest,
  RpcCommand,
  SessionInfo,
} from "../shared/types.js";

export interface PixApi {
  // File dialogs
  selectProject: () => Promise<string | null>;
  selectPiPath: () => Promise<string | null>;
  selectSessionFile: () => Promise<string | null>;
  selectChatFiles: () => Promise<string[]>;
  getPathForFile: (file: File) => string;

  // Pi lifecycle
  startPi: (projectDir: string) => Promise<{ success: boolean; error?: string }>;
  stopPi: () => Promise<{ success: boolean }>;

  // RPC commands
  sendCommand: <T = unknown>(command: RpcCommand) => Promise<{ success: boolean; data?: T; error?: string }>;
  sendCommandAsync: (command: RpcCommand) => void;

  // Settings
  getSettings: () => Promise<GuiSettings>;
  setSettings: (settings: Partial<GuiSettings>) => Promise<{ success: boolean }>;

  // Pi detection
  detectPi: () => Promise<{ found: boolean; path: string; note?: string }>;
  getPiStderr: () => Promise<string>;
  isPiRunning: () => Promise<boolean>;

  // Event subscriptions
  onPiEvent: (callback: (event: AgentSessionEvent) => void) => () => void;
  onPiResponse: (callback: (response: unknown) => void) => () => void;
  onPiExit: (callback: (data: { code: number | null; signal: string | null; stderr: string }) => void) => () => void;
  onPiError: (callback: (err: { message: string }) => void) => () => void;
  onPiReady: (callback: () => void) => () => void;
  onUserInputRequest: (callback: (request: RequestUserInputRequest) => void) => () => void;

  // Session management
  listSessions: (projectDir: string) => Promise<SessionInfo[]>;

  // Window controls (frameless window)
  windowMinimize: () => Promise<void>;
  windowMaximize: () => Promise<void>;
  windowClose: () => Promise<void>;
  windowIsMaximized: () => Promise<boolean>;
  onWindowMaximizeChange: (callback: (maximized: boolean) => void) => () => void;

  // Session management
  deleteSession: (sessionPath: string) => Promise<{ success: boolean; error?: string }>;

  // MCP queries
  mcpGetServers: () => Promise<McpServerInfo[]>;
  mcpGetConfig: () => Promise<McpConfigInfo>;
  mcpListResources: (serverName?: string) => Promise<McpResourceInfo[]>;
  mcpReadResource: (serverName: string | undefined, uri: string) => Promise<McpResourceContent>;
}

const api: PixApi = {
  selectProject: () => {
    console.log("[preload] selectProject() called, invoking IPC select-project");
    return ipcRenderer.invoke("select-project");
  },
  selectPiPath: () => ipcRenderer.invoke("select-pi-path"),
  selectSessionFile: () => ipcRenderer.invoke("select-session-file"),
  selectChatFiles: () => ipcRenderer.invoke("select-chat-files"),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  startPi: (projectDir: string) => ipcRenderer.invoke("start-pi", projectDir),
  stopPi: () => ipcRenderer.invoke("stop-pi"),

  sendCommand: <T = unknown>(command: RpcCommand) =>
    ipcRenderer.invoke("rpc-command", command) as Promise<{ success: boolean; data?: T; error?: string }>,
  sendCommandAsync: (command: RpcCommand) => ipcRenderer.invoke("rpc-command-async", command),

  getSettings: () => ipcRenderer.invoke("get-settings"),
  setSettings: (settings: Partial<GuiSettings>) => ipcRenderer.invoke("set-settings", settings),

  detectPi: () => ipcRenderer.invoke("detect-pi"),
  getPiStderr: () => ipcRenderer.invoke("get-pi-stderr"),
  isPiRunning: () => ipcRenderer.invoke("is-pi-running"),

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

  listSessions: (projectDir: string) => ipcRenderer.invoke("list-sessions", projectDir),

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

  // MCP queries
  mcpGetServers: () => ipcRenderer.invoke("mcp-get-servers"),
  mcpGetConfig: () => ipcRenderer.invoke("mcp-get-config"),
  mcpListResources: (serverName?: string) => ipcRenderer.invoke("mcp-list-resources", serverName),
  mcpReadResource: (serverName: string | undefined, uri: string) =>
    ipcRenderer.invoke("mcp-read-resource", serverName, uri),
};

contextBridge.exposeInMainWorld("pixApi", api);
