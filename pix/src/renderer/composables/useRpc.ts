import { computed, ref } from "vue";
import { useCommandsStore } from "@/stores/commands-store";
import type {
  AgentSessionEvent,
  ModelInfo,
  RpcCommand,
  RpcSessionState,
  RpcSlashCommand,
  SessionStats,
  ThinkingLevel,
  AuthStatusMap,
  TreeEntry,
  UserMessageForForking,
  ThemeInfo,
  ResourceStatus,
} from "@/types/rpc";
import type { PixApi } from "../../main/preload";

function api(): PixApi {
	if (!window.pixApi) {
		throw new Error("PiX preload API is not available.");
	}
	return window.pixApi;
}

const piStatus = ref<"stopped" | "starting" | "running" | "error">("stopped");
const sessionState = ref<RpcSessionState | null>(null);
const availableModels = ref<ModelInfo[]>([]);
const commands = ref<RpcSlashCommand[]>([]);
const sessionStats = ref<SessionStats | null>(null);
const stderr = ref("");
const lastError = ref<string | null>(null);

let eventUnsubscribers: Array<() => void> = [];

function cleanupEventListeners(): void {
	for (const cleanup of eventUnsubscribers) {
		cleanup();
	}
	eventUnsubscribers = [];
}

async function refreshState(): Promise<void> {
	try {
		const result = await api().sendCommand<RpcSessionState>({ type: "get_state" });
		if (result.success && result.data) {
			sessionState.value = result.data;
		}
	} catch (err) {
		console.error("[useRpc] Failed to get state:", err);
	}
}

async function refreshCommands(): Promise<void> {
	try {
		const result = await api().sendCommand<{ commands: RpcSlashCommand[] }>({ type: "get_commands" });
		if (result.success && result.data) {
			commands.value = result.data.commands;
			useCommandsStore().setCommands(result.data.commands);
		}
	} catch (err) {
		console.error("[useRpc] Failed to get commands:", err);
	}
}

async function refreshModels(): Promise<void> {
	try {
		const result = await api().sendCommand<{ models: ModelInfo[] }>({ type: "get_available_models" });
		if (result.success && result.data) {
			availableModels.value = result.data.models;
		}
	} catch (err) {
		console.error("[useRpc] Failed to get models:", err);
	}
}

async function refreshSessionStats(): Promise<void> {
	try {
		const result = await api().sendCommand<SessionStats>({ type: "get_session_stats" });
		if (result.success && result.data) {
			sessionStats.value = result.data;
		}
	} catch (err) {
		console.error("[useRpc] Failed to get session stats:", err);
	}
}

async function refreshSessionData(): Promise<void> {
	await Promise.all([refreshState(), refreshCommands(), refreshModels(), refreshSessionStats()]);
}

function setupEventListeners(): void {
	cleanupEventListeners();

	eventUnsubscribers.push(
		api().onPiReady(() => {
			piStatus.value = "running";
			lastError.value = null;
			void refreshSessionData();
		}),
	);

	eventUnsubscribers.push(
		api().onPiExit((data) => {
			piStatus.value = "stopped";
			stderr.value = data.stderr;
			sessionState.value = null;
		}),
	);

	eventUnsubscribers.push(
		api().onPiError((err) => {
			piStatus.value = "error";
			lastError.value = err.message;
			console.error("[useRpc] Error:", err.message);
		}),
	);

	eventUnsubscribers.push(
		api().onPiEvent((event: AgentSessionEvent) => {
			if (event.type === "agent_start") {
				if (sessionState.value) {
					sessionState.value = { ...sessionState.value, isStreaming: true };
				}
				void refreshSessionStats();
				return;
			}

			if (event.type === "agent_end") {
				if (sessionState.value) {
					sessionState.value = { ...sessionState.value, isStreaming: false };
				}
				void refreshState();
				void refreshSessionStats();
				return;
			}

			if (event.type === "message_end" || event.type === "tool_execution_end") {
				void refreshSessionStats();
				return;
			}

			if (event.type === "session_info_changed") {
				if (sessionState.value) {
					sessionState.value = { ...sessionState.value, sessionName: event.name };
				}
				return;
			}

			if (event.type === "thinking_level_changed") {
				if (sessionState.value) {
					sessionState.value = { ...sessionState.value, thinkingLevel: event.level };
				}
				return;
			}

			if (event.type === "goal_update") {
				if (sessionState.value) {
					sessionState.value = { ...sessionState.value, goal: event.goal };
				}
				return;
			}

			if (event.type === "queue_update" && sessionState.value) {
				sessionState.value = {
					...sessionState.value,
					pendingMessageCount: event.steering.length + event.followUp.length,
				};
			}
		}),
	);
}

async function sendCommand<T = unknown>(command: RpcCommand): Promise<T | null> {
	const result = await api().sendCommand<T>(command);
	if (!result.success) {
		console.error(`[useRpc] Command ${command.type} failed:`, result.error);
		lastError.value = result.error || `Command ${command.type} failed`;
		return null;
	}
	return result.data ?? null;
}

function sendCommandAsync(command: RpcCommand): void {
	api().sendCommandAsync(command);
}

async function startPi(projectDir: string): Promise<boolean> {
	piStatus.value = "starting";
	lastError.value = null;
	setupEventListeners();

	try {
		const result = await api().startPi(projectDir);
		if (!result.success) {
			cleanupEventListeners();
			piStatus.value = "error";
			lastError.value = result.error || "Failed to start Pi";
			return false;
		}

		piStatus.value = "running";
		await refreshSessionData();
		return true;
	} catch (err) {
		cleanupEventListeners();
		piStatus.value = "error";
		lastError.value = err instanceof Error ? err.message : "Unknown error starting Pi";
		return false;
	}
}

async function attachToRunningSession(): Promise<boolean> {
	try {
		if (!(await api().isPiRunning())) {
			return false;
		}
		setupEventListeners();
		piStatus.value = "running";
		await refreshSessionData();
		return true;
	} catch (err) {
		lastError.value = err instanceof Error ? err.message : "Failed to attach to running Pi session";
		return false;
	}
}

async function stopPi(): Promise<void> {
	cleanupEventListeners();
	await api().stopPi();
	piStatus.value = "stopped";
	sessionState.value = null;
	sessionStats.value = null;
}

async function sendPrompt(message: string, filePaths?: string[]): Promise<void> {
	await sendCommand({ type: "prompt", message, filePaths });
}

async function abort(): Promise<void> {
	await sendCommand({ type: "abort" });
}

async function newSession(): Promise<{ cancelled: boolean } | null> {
	const result = await sendCommand<{ cancelled: boolean }>({ type: "new_session" });
	if (result && !result.cancelled) {
		await refreshSessionData();
	}
	return result;
}

async function switchSession(sessionPath: string): Promise<{ cancelled: boolean } | null> {
	const result = await sendCommand<{ cancelled: boolean }>({ type: "switch_session", sessionPath });
	if (result && !result.cancelled) {
		await refreshSessionData();
	}
	return result;
}

async function getMessages(): Promise<unknown[] | null> {
	return sendCommand<unknown[]>({ type: "get_messages" });
}

async function setModel(provider: string, modelId: string): Promise<void> {
	await sendCommand({ type: "set_model", provider, modelId });
	await api().setSettings({ defaultProvider: provider, defaultModel: modelId });
	await refreshState();
}

async function cycleModel(direction: "forward" | "backward" = "forward"): Promise<void> {
	await sendCommand({ type: "cycle_model", direction });
	await refreshState();
	const model = sessionState.value?.model;
	if (model) {
		await api().setSettings({ defaultProvider: model.provider, defaultModel: model.id });
	}
}

async function setThinkingLevel(level: ThinkingLevel): Promise<void> {
	await sendCommand({ type: "set_thinking_level", level });
	await api().setSettings({ defaultThinkingLevel: level });
	await refreshState();
}

async function setSessionName(name: string): Promise<void> {
	await sendCommand({ type: "set_session_name", name });
	await refreshState();
}

// =========================================================================
// Enhanced Model
// =========================================================================

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

// =========================================================================
// Auth
// =========================================================================

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

// =========================================================================
// Full Pi Settings
// =========================================================================

async function getPiSettings(): Promise<Record<string, unknown> | null> {
	return sendCommand<Record<string, unknown>>({ type: "get_pi_settings" });
}

async function setPiSetting(key: string, value: unknown): Promise<void> {
	await sendCommand({ type: "set_pi_setting", key, value });
}

// =========================================================================
// Session Tree / Fork
// =========================================================================

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

// =========================================================================
// Export
// =========================================================================

async function exportHtml(outputPath?: string): Promise<string | null> {
	const result = await sendCommand<{ path: string }>({ type: "export_html", outputPath });
	return result?.path ?? null;
}

async function exportJsonl(outputPath?: string): Promise<string | null> {
	const result = await sendCommand<{ path: string }>({ type: "export_jsonl", outputPath });
	return result?.path ?? null;
}

// =========================================================================
// Session Config
// =========================================================================

async function setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
	await sendCommand({ type: "set_steering_mode", mode });
}

async function setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
	await sendCommand({ type: "set_follow_up_mode", mode });
}

// =========================================================================
// Resources
// =========================================================================

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

export function useRpc() {
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
		startPi,
		attachToRunningSession,
		stopPi,
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
		// Enhanced model
		getAvailableThinkingLevels,
		supportsThinking,
		setScopedModels,
		getScopedModels,
		// Auth
		getAuthStatus,
		setApiKey,
		removeAuth,
		// Full pi settings
		getPiSettings,
		setPiSetting,
		// Session tree / fork / clone
		forkSession,
		cloneSession,
		getTree,
		getUserMessagesForForking,
		navigateTree,
		// Export
		exportHtml,
		exportJsonl,
		// Session config
		setSteeringMode,
		setFollowUpMode,
		// Resources
		reloadResources,
		getThemes,
		getResourceStatus,
	};
}

export function initRpcEvents(): void {
	if (piStatus.value === "running") {
		setupEventListeners();
	}
}

export function cleanupRpcEvents(): void {
	cleanupEventListeners();
}
