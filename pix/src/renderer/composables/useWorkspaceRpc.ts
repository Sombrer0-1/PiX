import { computed } from "vue";
import { useRpc } from "./useRpc";
import { useTeamLeaderRpc } from "./useTeamLeaderRpc";
import { useTeamStore } from "../stores/team-store";
import type {
  AuthStatusMap,
  ClipboardImage,
  ModelInfo,
  McpConfigInfo,
  McpResourceContent,
  McpResourceInfo,
  McpServerInfo,
  ResourceStatus,
  RpcCommand,
  RpcSessionState,
  RpcSlashCommand,
  SessionStats,
  ThemeInfo,
  ThinkingLevel,
  TreeEntry,
  UserMessageForForking,
} from "@/types/rpc";
import type { CustomProviderConfig } from "@shared/custom-providers";
import type { RoundtableMetricsSnapshot, RoundtableState } from "@shared/team-types.js";

/**
 * team 模式的 token/成本聚合（H17）：按席相加，绝不把 host 会话的用量当成整场。
 * 圆桌没有「一个」上下文窗口——每席各有自己的 session，所以不冒充上下文占用。
 */
function roundtableSessionStats(
  metrics: RoundtableMetricsSnapshot,
  roundtable: RoundtableState | null,
): SessionStats {
  // 口径（F5-5）：input / output / total 三者同源——都是 perSeat 的席位用量之和，
  // 所以「总计 = 输入 + 输出」永远成立。cost 取 `metrics.totals.cost`（含 aux 整理
  // 会话），遵循 FR-10「整场成本」，因此它比席位分项之和大，这是刻意的。
  let tokensIn = 0;
  let tokensOut = 0;
  for (const seat of Object.values(metrics.perSeat)) {
    tokensIn += seat.tokensIn;
    tokensOut += seat.tokensOut;
  }
  const utterances = metrics.totals.utterances;
  return {
    sessionFile: undefined,
    // 这一场圆桌的身份，不是任何一条席位 session。
    sessionId: roundtable?.roundtableId ?? "",
    userMessages: 0,
    assistantMessages: utterances,
    // 席位内部的工具调用不计入圆桌指标（metrics 只统计发言、token、成本、时长）。
    toolCalls: 0,
    toolResults: 0,
    totalMessages: utterances,
    tokens: {
      input: tokensIn,
      output: tokensOut,
      cacheRead: 0,
      cacheWrite: 0,
      // 分项自洽优先：total 必须是 input + output，否则同一张卡片「总计 ≠ 输入+输出」。
      total: tokensIn + tokensOut,
    },
    cost: metrics.totals.cost,
  };
}

export function useWorkspaceRpc() {
  const teamStore = useTeamStore();
  const singleRpc = useRpc();
  const teamLeaderRpc = useTeamLeaderRpc();
  const activeRpc = computed(() => (teamStore.teamMode ? teamLeaderRpc : singleRpc));

  return {
    piStatus: computed(() => activeRpc.value.piStatus.value),
    sessionState: computed<RpcSessionState | null>(() => activeRpc.value.sessionState.value),
    availableModels: computed<ModelInfo[]>(() => activeRpc.value.availableModels.value),
    commands: computed<RpcSlashCommand[]>(() => activeRpc.value.commands.value),
    sessionStats: computed<SessionStats | null>(() =>
      teamStore.teamMode
        ? roundtableSessionStats(teamStore.metrics, teamStore.roundtable)
        : singleRpc.sessionStats.value,
    ),
    stderr: computed(() => activeRpc.value.stderr.value),
    lastError: computed(() => activeRpc.value.lastError.value),
    isRunning: computed(() => activeRpc.value.isRunning.value),
    isStreaming: computed(() => activeRpc.value.isStreaming.value),
    executionEnvironment: computed(() => activeRpc.value.executionEnvironment.value),
    isConnected: computed(() => activeRpc.value.isConnected.value),
    getBackgroundTasks: () => activeRpc.value.getBackgroundTasks(),
    stopBackgroundTask: (taskId: string) => activeRpc.value.stopBackgroundTask(taskId),
    mcpGetServers: (): Promise<McpServerInfo[]> => activeRpc.value.mcpGetServers(),
    mcpGetConfig: (): Promise<McpConfigInfo> => activeRpc.value.mcpGetConfig(),
    mcpListResources: (serverName?: string): Promise<McpResourceInfo[]> => activeRpc.value.mcpListResources(serverName),
    mcpReadResource: (serverName: string | undefined, uri: string): Promise<McpResourceContent> =>
      activeRpc.value.mcpReadResource(serverName, uri),
    sendCommand: <T = unknown>(command: RpcCommand): Promise<T | null> => activeRpc.value.sendCommand<T>(command),
    sendCommandAsync: (command: RpcCommand): Promise<void> => activeRpc.value.sendCommandAsync(command),
    sendPrompt: (message: string, filePaths?: string[], images?: ClipboardImage[]): Promise<void> =>
      activeRpc.value.sendPrompt(message, filePaths, images),
    abort: (): Promise<void> => activeRpc.value.abort(),
    abortRetry: (): Promise<void> => activeRpc.value.abortRetry(),
    newSession: (): Promise<{ cancelled: boolean } | null> => activeRpc.value.newSession(),
    switchSession: (sessionPath: string): Promise<{ cancelled: boolean } | null> => activeRpc.value.switchSession(sessionPath),
    getMessages: (): Promise<unknown[] | null> => activeRpc.value.getMessages(),
    setModel: (provider: string, modelId: string): Promise<void> => activeRpc.value.setModel(provider, modelId),
    cycleModel: (direction: "forward" | "backward" = "forward"): Promise<void> => activeRpc.value.cycleModel(direction),
    setThinkingLevel: (level: ThinkingLevel): Promise<void> => activeRpc.value.setThinkingLevel(level),
    setSessionName: (name: string): Promise<void> => activeRpc.value.setSessionName(name),
    refreshState: (): Promise<void> => activeRpc.value.refreshState(),
    refreshCommands: (): Promise<void> => activeRpc.value.refreshCommands(),
    refreshModels: (): Promise<void> => activeRpc.value.refreshModels(),
    refreshSessionStats: (): Promise<void> => activeRpc.value.refreshSessionStats(),
    scheduleSessionStatsRefresh: (): void => activeRpc.value.scheduleSessionStatsRefresh(),
    getAvailableThinkingLevels: (): Promise<ThinkingLevel[] | null> => activeRpc.value.getAvailableThinkingLevels(),
    supportsThinking: (): Promise<boolean | null> => activeRpc.value.supportsThinking(),
    setScopedModels: (patterns: string[]): Promise<void> => activeRpc.value.setScopedModels(patterns),
    getScopedModels: (): Promise<ModelInfo[] | null> => activeRpc.value.getScopedModels(),
    getAuthStatus: (): Promise<AuthStatusMap | null> => activeRpc.value.getAuthStatus(),
    setApiKey: (provider: string, key: string): Promise<void> => activeRpc.value.setApiKey(provider, key),
    getCustomProviders: () => activeRpc.value.getCustomProviders(),
    setCustomProviders: (providers: Record<string, CustomProviderConfig>) => activeRpc.value.setCustomProviders(providers),
    removeAuth: (provider: string): Promise<void> => activeRpc.value.removeAuth(provider),
    getPiSettings: (): Promise<Record<string, unknown> | null> => activeRpc.value.getPiSettings(),
    setPiSetting: (key: string, value: unknown): Promise<void> => activeRpc.value.setPiSetting(key, value),
    setPiSettings: (entries: Array<{ key: string; value: unknown }>): Promise<void> => activeRpc.value.setPiSettings(entries),
    forkSession: (entryId: string, position: "before" | "at" = "before", label?: string): Promise<{ cancelled: boolean } | null> =>
      activeRpc.value.forkSession(entryId, position, label),
    cloneSession: (): Promise<{ cancelled: boolean } | null> => activeRpc.value.cloneSession(),
    getTree: (): Promise<TreeEntry[] | null> => activeRpc.value.getTree(),
    getUserMessagesForForking: (): Promise<UserMessageForForking[] | null> => activeRpc.value.getUserMessagesForForking(),
    navigateTree: (
      targetId: string,
      options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
    ): Promise<{ cancelled: boolean } | null> => activeRpc.value.navigateTree(targetId, options),
    exportHtml: (outputPath?: string): Promise<string | null> => activeRpc.value.exportHtml(outputPath),
    exportJsonl: (outputPath?: string): Promise<string | null> => activeRpc.value.exportJsonl(outputPath),
    setSteeringMode: (mode: "all" | "one-at-a-time"): Promise<void> => activeRpc.value.setSteeringMode(mode),
    setFollowUpMode: (mode: "all" | "one-at-a-time"): Promise<void> => activeRpc.value.setFollowUpMode(mode),
    compact: (customInstructions?: string): Promise<void> => activeRpc.value.compact(customInstructions),
    setAcp: (enabled: boolean): Promise<void> => activeRpc.value.setAcp(enabled),
    reloadResources: (): Promise<void> => activeRpc.value.reloadResources(),
    getThemes: (): Promise<ThemeInfo[] | null> => activeRpc.value.getThemes(),
    getResourceStatus: (): Promise<ResourceStatus | null> => activeRpc.value.getResourceStatus(),
  };
}
