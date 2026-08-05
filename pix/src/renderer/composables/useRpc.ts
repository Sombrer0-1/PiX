import { computed, ref } from "vue";
import type {
  AgentSessionEvent,
  AuthStatusMap,
  ClipboardImage,
  GuiSettings,
  McpConfigInfo,
  McpResourceContent,
  McpResourceInfo,
  McpServerInfo,
  ModelInfo,
  RequestUserInputRequest,
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
import type { PixApi } from "../../main/preload";

type CommandResponse<T = unknown> = { success: boolean; data?: T; error?: string };
type LifecycleExit = { code: number | null; signal: string | null; stderr: string };

export interface RpcTransport {
  sendCommand: <T = unknown>(command: RpcCommand) => Promise<CommandResponse<T>>;
  sendCommandAsync: (command: RpcCommand) => Promise<{ success: boolean; error?: string }>;
  startRuntime: (projectDir: string) => Promise<{ success: boolean; error?: string }>;
  stopRuntime: () => Promise<{ success: boolean }>;
  isRuntimeRunning: () => Promise<boolean>;
  onEvent: (callback: (event: AgentSessionEvent) => void) => () => void;
  onReady: (callback: () => void) => () => void;
  onExit: (callback: (data: LifecycleExit) => void) => () => void;
  onError: (callback: (err: { message: string }) => void) => () => void;
  onUserInputRequest: (callback: (request: RequestUserInputRequest) => void) => () => void;
  getBackgroundTasks: () => Promise<Array<{ taskId: string; command: string; pid?: number; startedAt: number; status: string }>>;
  stopBackgroundTask: (taskId: string) => Promise<{ found: boolean }>;
  mcpGetServers: () => Promise<McpServerInfo[]>;
  mcpGetConfig: () => Promise<McpConfigInfo>;
  mcpListResources: (serverName?: string) => Promise<McpResourceInfo[]>;
  mcpReadResource: (serverName: string | undefined, uri: string) => Promise<McpResourceContent>;
  setGuiSettings: (settings: Partial<GuiSettings>) => Promise<{ success: boolean }>;
}

function api(): PixApi {
  if (!window.pixApi) {
    throw new Error("PiX 预加载 API 不可用。");
  }
  return window.pixApi;
}

function createSingleTransport(): RpcTransport {
  return {
    sendCommand: <T = unknown>(command: RpcCommand) => api().sendCommand<T>(command),
    sendCommandAsync: (command: RpcCommand) => api().sendCommandAsync(command),
    startRuntime: (projectDir: string) => api().startPi(projectDir),
    stopRuntime: () => api().stopPi(),
    isRuntimeRunning: () => api().isPiRunning(),
    onEvent: (callback) => api().onPiEvent(callback),
    onReady: (callback) => api().onPiReady(callback),
    onExit: (callback) => api().onPiExit(callback),
    onError: (callback) => api().onPiError(callback),
    onUserInputRequest: (callback) => api().onUserInputRequest(callback),
    getBackgroundTasks: () => api().getBackgroundTasks(),
    stopBackgroundTask: (taskId: string) => api().stopBackgroundTask(taskId),
    mcpGetServers: () => api().mcpGetServers(),
    mcpGetConfig: () => api().mcpGetConfig(),
    mcpListResources: (serverName?: string) => api().mcpListResources(serverName),
    mcpReadResource: (serverName: string | undefined, uri: string) => api().mcpReadResource(serverName, uri),
    setGuiSettings: (settings) => api().setSettings(settings),
  };
}

export function createRpcClient(transport: RpcTransport, label: string) {
  const piStatus = ref<"stopped" | "starting" | "running" | "error">("stopped");
  const sessionState = ref<RpcSessionState | null>(null);
  const availableModels = ref<ModelInfo[]>([]);
  const commands = ref<RpcSlashCommand[]>([]);
  const sessionStats = ref<SessionStats | null>(null);
  const stderr = ref("");
  const lastError = ref<string | null>(null);
  let eventUnsubscribers: Array<() => void> = [];

  function cleanupEventListeners(): void {
    for (const cleanup of eventUnsubscribers) cleanup();
    eventUnsubscribers = [];
  }

  async function refreshState(): Promise<void> {
    try {
      const result = await transport.sendCommand<RpcSessionState>({ type: "get_state" });
      if (result.success && result.data) sessionState.value = result.data;
    } catch (err) {
      console.error(`[${label}] Failed to get state:`, err);
    }
  }

  async function refreshCommands(): Promise<void> {
    try {
      const result = await transport.sendCommand<{ commands: RpcSlashCommand[] }>({ type: "get_commands" });
      if (result.success && result.data) {
        commands.value = result.data.commands;
      }
    } catch (err) {
      console.error(`[${label}] Failed to get commands:`, err);
    }
  }

  async function refreshModels(): Promise<void> {
    try {
      const result = await transport.sendCommand<{ models: ModelInfo[] }>({ type: "get_available_models" });
      if (result.success && result.data) availableModels.value = result.data.models;
    } catch (err) {
      console.error(`[${label}] Failed to get models:`, err);
    }
  }

  async function refreshSessionStats(): Promise<void> {
    try {
      const result = await transport.sendCommand<SessionStats>({ type: "get_session_stats" });
      if (result.success && result.data) sessionStats.value = result.data;
    } catch (err) {
      console.error(`[${label}] Failed to get session stats:`, err);
    }
  }

  async function refreshSessionData(): Promise<void> {
    await Promise.all([refreshState(), refreshCommands(), refreshModels(), refreshSessionStats()]);
  }

  function setupEventListeners(): void {
    cleanupEventListeners();

    eventUnsubscribers.push(
      transport.onReady(() => {
        piStatus.value = "running";
        lastError.value = null;
        void refreshSessionData();
      }),
      transport.onExit((data) => {
        piStatus.value = "stopped";
        stderr.value = data.stderr;
        sessionState.value = null;
      }),
      transport.onError((err) => {
        piStatus.value = "error";
        lastError.value = err.message;
        console.error(`[${label}] Error:`, err.message);
      }),
      transport.onEvent((event) => {
        if (event.type === "agent_start") {
          if (sessionState.value) sessionState.value = { ...sessionState.value, isStreaming: true };
          void refreshSessionStats();
          return;
        }
        if (event.type === "agent_end") {
          if (sessionState.value) sessionState.value = { ...sessionState.value, isStreaming: false };
          void refreshState();
          void refreshSessionStats();
          return;
        }
        if (event.type === "message_end" || event.type === "tool_execution_end" || event.type === "eye_model_end") {
          void refreshSessionStats();
          return;
        }
        if (event.type === "session_info_changed" && sessionState.value) {
          sessionState.value = { ...sessionState.value, sessionName: event.name };
          return;
        }
        if (event.type === "thinking_level_changed" && sessionState.value) {
          sessionState.value = { ...sessionState.value, thinkingLevel: event.level };
          return;
        }
        if (event.type === "goal_update" && sessionState.value) {
          sessionState.value = { ...sessionState.value, goal: event.goal };
          return;
        }
        if (event.type === "queue_update" && sessionState.value) {
          sessionState.value = {
            ...sessionState.value,
            pendingMessageCount: event.steering.length + event.followUp.length,
          };
          return;
        }
        if (event.type === "compaction_start" && sessionState.value) {
          sessionState.value = { ...sessionState.value, isCompacting: true };
          return;
        }
        if (event.type === "compaction_end" && sessionState.value) {
          sessionState.value = { ...sessionState.value, isCompacting: false };
          void refreshSessionStats();
          void refreshState();
        }
      }),
    );
  }

  async function sendCommand<T = unknown>(command: RpcCommand): Promise<T | null> {
    const result = await transport.sendCommand<T>(command);
    if (!result.success) {
      console.error(`[${label}] Command ${command.type} failed:`, result.error);
      lastError.value = result.error || `命令 ${command.type} 执行失败`;
      return null;
    }
    return result.data ?? null;
  }

  async function sendCommandOrThrow<T = unknown>(command: RpcCommand): Promise<T | null> {
    const result = await transport.sendCommand<T>(command);
    if (!result.success) {
      const message = result.error || `命令 ${command.type} 执行失败`;
      console.error(`[${label}] Command ${command.type} failed:`, message);
      lastError.value = message;
      throw new Error(message);
    }
    return result.data ?? null;
  }

  async function sendCommandAsync(command: RpcCommand): Promise<void> {
    const result = await transport.sendCommandAsync(command);
    if (!result.success) {
      const message = result.error || `命令 ${command.type} 执行失败`;
      console.error(`[${label}] Async command ${command.type} failed:`, message);
      lastError.value = message;
      throw new Error(message);
    }
  }

  async function startRuntime(projectDir: string): Promise<boolean> {
    piStatus.value = "starting";
    lastError.value = null;
    setupEventListeners();
    try {
      const result = await transport.startRuntime(projectDir);
      if (!result.success) {
        cleanupEventListeners();
        piStatus.value = "error";
        lastError.value = result.error || "启动运行环境失败";
        return false;
      }
      piStatus.value = "running";
      await refreshSessionData();
      return true;
    } catch (err) {
      cleanupEventListeners();
      piStatus.value = "error";
      lastError.value = err instanceof Error ? err.message : "启动运行环境时发生未知错误";
      return false;
    }
  }

  async function attachToRunningSession(): Promise<boolean> {
    try {
      if (!(await transport.isRuntimeRunning())) return false;
      setupEventListeners();
      piStatus.value = "running";
      await refreshSessionData();
      return true;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : "连接到运行中的会话失败";
      return false;
    }
  }

  async function stopRuntime(): Promise<void> {
    cleanupEventListeners();
    try {
      await transport.stopRuntime();
    } finally {
      piStatus.value = "stopped";
      sessionState.value = null;
      sessionStats.value = null;
    }
  }

  async function sendPrompt(message: string, filePaths?: string[], images?: ClipboardImage[]): Promise<void> {
    await sendCommandOrThrow({ type: "prompt", message, filePaths, images });
  }

  async function abort(): Promise<void> {
    await sendCommand({ type: "abort" });
  }

  async function newSession(): Promise<{ cancelled: boolean } | null> {
    const result = await sendCommand<{ cancelled: boolean }>({ type: "new_session" });
    if (result && !result.cancelled) await refreshSessionData();
    return result;
  }

  async function switchSession(sessionPath: string): Promise<{ cancelled: boolean } | null> {
    const result = await sendCommand<{ cancelled: boolean }>({ type: "switch_session", sessionPath });
    if (result && !result.cancelled) await refreshSessionData();
    return result;
  }

  async function getMessages(): Promise<unknown[] | null> {
    return sendCommand<unknown[]>({ type: "get_messages" });
  }

  async function setModel(provider: string, modelId: string): Promise<void> {
    await sendCommand({ type: "set_model", provider, modelId });
    await transport.setGuiSettings({ defaultProvider: provider, defaultModel: modelId });
    await refreshState();
  }

  async function cycleModel(direction: "forward" | "backward" = "forward"): Promise<void> {
    await sendCommand({ type: "cycle_model", direction });
    await refreshState();
    const model = sessionState.value?.model;
    if (model) await transport.setGuiSettings({ defaultProvider: model.provider, defaultModel: model.id });
  }

  async function setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await sendCommand({ type: "set_thinking_level", level });
    await transport.setGuiSettings({ defaultThinkingLevel: level });
    await refreshState();
  }

  async function setSessionName(name: string): Promise<void> {
    await sendCommand({ type: "set_session_name", name });
    await refreshState();
  }

  async function getAvailableThinkingLevels(): Promise<ThinkingLevel[] | null> {
    return sendCommand<ThinkingLevel[]>({ type: "get_available_thinking_levels" });
  }

  async function supportsThinking(): Promise<boolean | null> {
    return sendCommand<boolean>({ type: "supports_thinking" });
  }

  async function setScopedModels(patterns: string[]): Promise<void> {
    await sendCommand({ type: "set_scoped_models", patterns });
  }

  async function getScopedModels(): Promise<ModelInfo[] | null> {
    return sendCommand<ModelInfo[]>({ type: "get_scoped_models" });
  }

  async function getAuthStatus(): Promise<AuthStatusMap | null> {
    return sendCommand<AuthStatusMap>({ type: "get_auth_status" });
  }

  async function setApiKey(provider: string, key: string): Promise<void> {
    await sendCommand({ type: "set_api_key", provider, key });
    await Promise.all([refreshModels(), refreshState()]);
  }

  async function removeAuth(provider: string): Promise<void> {
    await sendCommand({ type: "remove_auth", provider });
    await Promise.all([refreshModels(), refreshState()]);
  }

  async function getPiSettings(): Promise<Record<string, unknown> | null> {
    return sendCommand<Record<string, unknown>>({ type: "get_pi_settings" });
  }

  async function setPiSetting(key: string, value: unknown): Promise<void> {
    await sendCommandOrThrow({ type: "set_pi_setting", key, value });
  }

  async function setPiSettings(entries: Array<{ key: string; value: unknown }>): Promise<void> {
    await sendCommandOrThrow({ type: "set_pi_settings", entries });
  }

  async function forkSession(entryId: string, position: "before" | "at" = "before", label?: string): Promise<{ cancelled: boolean } | null> {
    return sendCommand<{ cancelled: boolean }>({ type: "fork", entryId, position, label });
  }

  async function cloneSession(): Promise<{ cancelled: boolean } | null> {
    return sendCommand<{ cancelled: boolean }>({ type: "clone" });
  }

  async function getTree(): Promise<TreeEntry[] | null> {
    return sendCommand<TreeEntry[]>({ type: "get_tree" });
  }

  async function getUserMessagesForForking(): Promise<UserMessageForForking[] | null> {
    return sendCommand<UserMessageForForking[]>({ type: "get_user_messages_for_forking" });
  }

  async function navigateTree(
    targetId: string,
    options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
  ): Promise<{ cancelled: boolean } | null> {
    return sendCommand<{ cancelled: boolean }>({ type: "navigate_tree", ...options, targetId });
  }

  async function exportHtml(outputPath?: string): Promise<string | null> {
    const result = await sendCommand<{ path: string }>({ type: "export_html", outputPath });
    return result?.path ?? null;
  }

  async function exportJsonl(outputPath?: string): Promise<string | null> {
    const result = await sendCommand<{ path: string }>({ type: "export_jsonl", outputPath });
    return result?.path ?? null;
  }

  async function setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await sendCommand({ type: "set_steering_mode", mode });
  }

  async function compact(customInstructions?: string): Promise<void> {
    await sendCommandOrThrow({ type: "compact", customInstructions });
    await refreshSessionStats();
    await refreshState();
  }

  async function setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await sendCommand({ type: "set_follow_up_mode", mode });
  }

  async function reloadResources(): Promise<void> {
    await sendCommand({ type: "reload_resources" });
    await Promise.all([refreshCommands(), refreshModels(), refreshState()]);
  }

  async function getThemes(): Promise<ThemeInfo[] | null> {
    return sendCommand<ThemeInfo[]>({ type: "get_themes" });
  }

  async function getResourceStatus(): Promise<ResourceStatus | null> {
    return sendCommand<ResourceStatus>({ type: "get_resource_status" });
  }

  return {
    piStatus: computed(() => piStatus.value),
    sessionState: computed(() => sessionState.value),
    availableModels: computed(() => availableModels.value),
    commands: computed(() => commands.value),
    sessionStats: computed(() => sessionStats.value),
    stderr: computed(() => stderr.value),
    lastError: computed(() => lastError.value),
    isRunning: computed(() => piStatus.value === "running"),
    isStreaming: computed(() => sessionState.value?.isStreaming ?? false),
    isConnected: computed(() => piStatus.value === "running"),
    getBackgroundTasks: transport.getBackgroundTasks,
    stopBackgroundTask: transport.stopBackgroundTask,
    mcpGetServers: transport.mcpGetServers,
    mcpGetConfig: transport.mcpGetConfig,
    mcpListResources: transport.mcpListResources,
    mcpReadResource: transport.mcpReadResource,
    startRuntime,
    attachToRunningSession,
    stopRuntime,
    sendCommand,
    sendCommandAsync,
    sendPrompt,
    abort,
    newSession,
    switchSession,
    getMessages,
    setModel,
    cycleModel,
    setThinkingLevel,
    setSessionName,
    refreshState,
    refreshCommands,
    refreshModels,
    refreshSessionStats,
    getAvailableThinkingLevels,
    supportsThinking,
    setScopedModels,
    getScopedModels,
    getAuthStatus,
    setApiKey,
    removeAuth,
    getPiSettings,
    setPiSetting,
    setPiSettings,
    forkSession,
    cloneSession,
    getTree,
    getUserMessagesForForking,
    navigateTree,
    exportHtml,
    exportJsonl,
    setSteeringMode,
    setFollowUpMode,
    compact,
    reloadResources,
    getThemes,
    getResourceStatus,
  };
}

const singleClient = createRpcClient(createSingleTransport(), "useRpc");

export function useRpc() {
  return {
    ...singleClient,
    // Keep the public single-mode API used by HomePage and existing callers.
    startPi: singleClient.startRuntime,
    stopPi: singleClient.stopRuntime,
  };
}

export function initRpcEvents(): void {
  if (singleClient.isRunning.value) {
    // A running session was started before the renderer mounted.
    void singleClient.attachToRunningSession();
  }
}

export function cleanupRpcEvents(): void {
  // The generic client owns its subscriptions and cleans them up on stop.
}
