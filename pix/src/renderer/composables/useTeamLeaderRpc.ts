import { createRpcClient, type RpcTransport } from "./useRpc";
import type { PixApi } from "../../main/preload";
import type { RpcCommand } from "@/types/rpc";
import type { ProjectLocation } from "@/types/session";

function api(): PixApi {
  if (!window.pixApi) {
    throw new Error("PiX 预加载 API 不可用。");
  }
  return window.pixApi;
}

const teamLeaderTransport: RpcTransport = {
  sendCommand: <T = unknown>(command: RpcCommand) => api().sendTeamLeaderCommand<T>(command),
  sendCommandAsync: (command) => api().sendTeamLeaderCommandAsync(command),
  startRuntime: (location: ProjectLocation) => api().startTeamRuntime(location),
  stopRuntime: () => api().stopTeamRuntime(),
  isRuntimeRunning: () => api().isTeamLeaderRunning(),
  onEvent: (callback) => api().onTeamLeaderEvent(callback),
  onReady: (callback) => api().onTeamLeaderReady(callback),
  onExit: (callback) => api().onTeamLeaderExit(callback),
  onError: (callback) => api().onTeamLeaderError(callback),
  onUserInputRequest: (callback) => api().onTeamLeaderUserInputRequest(callback),
  getBackgroundTasks: () => api().getTeamLeaderBackgroundTasks(),
  stopBackgroundTask: (taskId: string) => api().stopTeamLeaderBackgroundTask(taskId),
  mcpGetServers: () => api().teamLeaderMcpGetServers(),
  mcpGetConfig: () => api().teamLeaderMcpGetConfig(),
  mcpListResources: (serverName?: string) => api().teamLeaderMcpListResources(serverName),
  mcpReadResource: (serverName: string | undefined, uri: string) => api().teamLeaderMcpReadResource(serverName, uri),
  setGuiSettings: (settings) => api().setSettings(settings),
  getExecutionEnvironment: () => api().getExecutionEnvironment(),
};

const teamLeaderClient = createRpcClient(teamLeaderTransport, "useTeamLeaderRpc");

/**
 * Host runtime transport — **not** a discussion engine.
 *
 * The host SessionBridge only starts/stops the team runtime and reports its
 * own session state (dev plan §9: the host is not a discussion participant).
 * The discussion goes through `useTeamStore()` → `TeamCommand`; the composer
 * must never send `prompt` / `steer` here. `sendPrompt` stays on the shared
 * client for the solo transport only.
 */
export function useTeamLeaderRpc() {
  return {
    ...teamLeaderClient,
    startTeamRuntime: teamLeaderClient.startRuntime,
    attachToRunningTeamSession: teamLeaderClient.attachToRunningSession,
    stopTeamRuntime: teamLeaderClient.stopRuntime,
  };
}
