/**
 * Preload Script
 *
 * Exposes a typed API to the renderer process via contextBridge.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { AgentSessionEvent, GuiSettings, RpcCommand, SessionInfo } from "../shared/types.js";

export interface PixApi {
  // File dialogs
  selectProject: () => Promise<string | null>;
  selectPiPath: () => Promise<string | null>;
  selectSessionFile: () => Promise<string | null>;

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

  // Session management
  listSessions: (projectDir: string) => Promise<SessionInfo[]>;
}

const api: PixApi = {
  selectProject: () => {
    console.log("[preload] selectProject() called, invoking IPC select-project");
    return ipcRenderer.invoke("select-project");
  },
  selectPiPath: () => ipcRenderer.invoke("select-pi-path"),
  selectSessionFile: () => ipcRenderer.invoke("select-session-file"),

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

  listSessions: (projectDir: string) => ipcRenderer.invoke("list-sessions", projectDir),
};

contextBridge.exposeInMainWorld("pixApi", api);
