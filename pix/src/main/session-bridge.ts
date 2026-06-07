import { existsSync, statSync } from "fs";
import { join } from "path";
import { shell } from "electron";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	completeSimple,
	getSupportedThinkingLevels,
	type Api,
	type Context,
	type ImageContent,
	type Model,
	type TextContent,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type CreateAgentSessionResult,
	type ExtensionCommandContextActions,
	type ExtensionError,
	type RequestUserInputRequest,
	type RequestUserInputResponse,
	type SessionShutdownEvent,
	type SessionStartEvent,
	createAgentSession,
	SessionManager,
	SettingsManager,
	AuthStorage,
	DefaultResourceLoader,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { McpAdapter } from "pi-mcp-adapter";
import type {
	AgentSessionEvent,
	ClipboardImage,
	GuiSettings,
	McpConfigInfo,
	McpResourceContent,
	McpResourceInfo,
	McpServerInfo,
	ModelInfo,
	RpcSessionState,
	RpcSlashCommand,
	SessionStats,
	ThinkingLevel,
	AuthStatusMap,
	TreeEntry,
	UserMessageForForking,
	ThemeInfo,
	ResourceStatus,
	ChatMessageAttachment,
} from "../shared/types.js";
import { processChatFiles } from "./chat-files.js";

interface ExitPayload {
	code: number | null;
	signal: string | null;
	stderr: string;
}

interface LifecycleEvents {
	ready: [];
	exit: [ExitPayload];
	error: [Error];
}

type LifecycleEvent = keyof LifecycleEvents;
type LifecycleListener<TEvent extends LifecycleEvent> = (...args: LifecycleEvents[TEvent]) => void;
type CommandResult = { cancelled: boolean };
type NavigateTreeOptions = {
	summarize?: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
};
type UserInputRequestListener = (request: RequestUserInputRequest) => void;
type WithSessionCallback = NonNullable<
	NonNullable<Parameters<ExtensionCommandContextActions["newSession"]>[0]>["withSession"]
>;
type PiSettingEntry = { key: string; value: unknown };
type PiSettingApplyResult = {
	reloadRuntime?: boolean;
	refreshSystemPrompt?: boolean;
	reapplyModelScope?: boolean;
};

const TAKE_HER_EYES_TIMEOUT_MS = 45_000;
const TAKE_HER_EYES_MAX_TOKENS = 2048;
const TAKE_HER_EYES_SYSTEM_PROMPT = [
	"You are takeHerEyes, a precise vision assistant for Pix.",
	"Describe the attached image(s) so a text-only model can answer the user's request.",
	"Focus on visible text, UI layout, code, error messages, charts, tables, spatial relationships, and any uncertainty.",
	"Do not invent hidden details. Prefer the user's language when it is clear.",
].join(" ");

interface AuxiliaryUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function globPatternToRegExp(pattern: string): RegExp {
	let source = "";
	for (const char of pattern.trim()) {
		if (char === "*") source += ".*";
		else if (char === "?") source += ".";
		else source += char.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
	}
	return new RegExp(`^${source}$`, "i");
}

function createEmptyAuxiliaryUsage(): AuxiliaryUsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

export class SessionBridge {
	private _session: AgentSession | null = null;
	private _sessionManager: SessionManager | null = null;
	private _authStorage: AuthStorage | null = null;
	private _mcpAdapter: McpAdapter | null = null;
	private _cwd = "";
	private _guiSettings: GuiSettings | undefined;
	private _unsubscribe: (() => void) | null = null;
	private _auxiliaryUsage = createEmptyAuxiliaryUsage();

	private _eventListeners: Array<(event: AgentSessionEvent) => void> = [];
	private _userInputRequestListeners: UserInputRequestListener[] = [];
	private _pendingUserInputRequests = new Map<
		string,
		{
			resolve: (response: RequestUserInputResponse) => void;
			reject: (error: Error) => void;
		}
	>();
	private _lifecycleListeners: {
		[TEvent in LifecycleEvent]: Array<LifecycleListener<TEvent>>;
	} = {
		ready: [],
		exit: [],
		error: [],
	};

	private _isCompacting = false;
	private _pendingMessageCount = 0;

	async start(projectDir: string, guiSettings?: GuiSettings): Promise<void> {
		this._assertProjectDirectory(projectDir);
		await this._closeCurrentSession("quit");

		this._cwd = projectDir;
		this._guiSettings = guiSettings;

		const agentDir = getAgentDir();
		this._authStorage = AuthStorage.create(join(agentDir, "auth.json"));

		const settingsManager = this._createSettingsManager(projectDir);
		const sessionDir = settingsManager.getSessionDir();
		this._sessionManager = SessionManager.continueRecent(projectDir, sessionDir);

		const result = await this._createSession(projectDir, this._sessionManager, {
			type: "session_start",
			reason: "startup",
		});
		await this._activateSession(result.session);
	}

	async dispose(): Promise<void> {
		const hadSession = await this._closeCurrentSession("quit");
		if (hadSession) {
			this._emitLifecycle("exit", { code: 0, signal: null, stderr: "" });
		}
	}

	updateGuiSettings(settings: GuiSettings): void {
		this._guiSettings = settings;
	}

	async prompt(text: string, filePaths?: string[], clipboardImages?: ClipboardImage[]): Promise<void> {
		const prepared = await this._preparePromptInput(text, filePaths, clipboardImages);
		await this._getSession().prompt(prepared.text, {
			images: prepared.images,
			displayText: prepared.displayText,
			attachments: prepared.attachments,
		});
	}

	async steer(text: string, filePaths?: string[], clipboardImages?: ClipboardImage[]): Promise<void> {
		const prepared = await this._preparePromptInput(text, filePaths, clipboardImages);
		await this._getSession().steer(prepared.text, {
			images: prepared.images,
			displayText: prepared.displayText,
			attachments: prepared.attachments,
		});
	}

	async followUp(text: string, filePaths?: string[], clipboardImages?: ClipboardImage[]): Promise<void> {
		const prepared = await this._preparePromptInput(text, filePaths, clipboardImages);
		await this._getSession().followUp(prepared.text, {
			images: prepared.images,
			displayText: prepared.displayText,
			attachments: prepared.attachments,
		});
	}

	async abort(): Promise<void> {
		await this._getSession().abort();
	}

	async newSession(parentSession?: string): Promise<CommandResult> {
		const previousSessionFile = this._session?.sessionFile;
		const sessionDir = this._sessionManager?.getSessionDir();
		await this._closeCurrentSession("new");

		this._sessionManager = SessionManager.create(this._cwd, sessionDir);
		if (parentSession) {
			this._sessionManager.newSession({ parentSession });
		}

		const result = await this._createSession(this._cwd, this._sessionManager, {
			type: "session_start",
			reason: "new",
			previousSessionFile,
		});
		await this._activateSession(result.session);
		return { cancelled: false };
	}

	async switchSession(sessionPath: string): Promise<CommandResult> {
		const previousSessionFile = this._session?.sessionFile;
		await this._closeCurrentSession("resume", sessionPath);

		this._sessionManager = SessionManager.open(sessionPath, undefined, this._cwd);
		this._cwd = this._sessionManager.getCwd();
		const result = await this._createSession(this._cwd, this._sessionManager, {
			type: "session_start",
			reason: "resume",
			previousSessionFile,
		});
		await this._activateSession(result.session);
		return { cancelled: false };
	}

	async fork(entryId: string, position: "before" | "at" = "before", label?: string): Promise<CommandResult> {
		const session = this._getSession();
		const sessionManager = session.sessionManager;
		if (!sessionManager.isPersisted()) {
			throw new Error("Cannot fork: session is not persisted");
		}

		const selectedEntry = sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		let targetLeafId: string | null;
		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
		}

		const previousSessionFile = session.sessionFile;
		const currentSessionFile = session.sessionFile;
		if (!currentSessionFile) {
			throw new Error("Persisted session is missing a session file");
		}

		const sessionDir = sessionManager.getSessionDir();
		if (!targetLeafId) {
			if (label) {
				sessionManager.appendLabelChange(selectedEntry.id, label);
			}
			const newSessionManager = SessionManager.create(this._cwd, sessionDir);
			newSessionManager.newSession({ parentSession: currentSessionFile });
			await this._closeCurrentSession("fork");
			this._sessionManager = newSessionManager;

			const result = await this._createSession(this._cwd, this._sessionManager, {
				type: "session_start",
				reason: "fork",
				previousSessionFile,
			});
			await this._activateSession(result.session);
			return { cancelled: false };
		}

		const forkManager = SessionManager.open(currentSessionFile, sessionDir);
		const forkedSessionPath = forkManager.createBranchedSession(targetLeafId);
		if (!forkedSessionPath) {
			throw new Error("Failed to create forked session");
		}

		await this._closeCurrentSession("fork", forkedSessionPath);
		this._sessionManager = SessionManager.open(forkedSessionPath, sessionDir);
		if (label) {
			this._sessionManager.appendLabelChange(targetLeafId, label);
		}

		const result = await this._createSession(this._cwd, this._sessionManager, {
			type: "session_start",
			reason: "fork",
			previousSessionFile,
		});
		await this._activateSession(result.session);
		return { cancelled: false };
	}

	async navigateTree(targetId: string, options?: NavigateTreeOptions): Promise<CommandResult> {
		const result = await this._getSession().navigateTree(targetId, {
			summarize: options?.summarize,
			customInstructions: options?.customInstructions,
			replaceInstructions: options?.replaceInstructions,
			label: options?.label,
		});
		return { cancelled: result.cancelled };
	}

	async clone(): Promise<CommandResult> {
		const session = this._getSession();
		const leafEntry = session.sessionManager.getLeafEntry();
		if (!leafEntry) {
			throw new Error("Nothing to clone yet");
		}
		return this.fork(leafEntry.id, "at");
	}

	async getTree(): Promise<TreeEntry[]> {
		const session = this._getSession();
		const sessionTree = session.sessionManager.getTree();

		function convert(node: typeof sessionTree[0]): TreeEntry {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const entry = node.entry as any;
			let messagePreview: string | undefined;
			if (entry.type === "message" && entry.message) {
				const content = entry.message.content;
				messagePreview = typeof content === "string"
					? content.slice(0, 200)
					: "[content]";
			}
			return {
				id: entry.id as string,
				parentId: entry.parentId as string | null,
				type: entry.type as string,
				timestamp: entry.timestamp as string,
				label: node.label,
				labelTimestamp: node.labelTimestamp,
				messagePreview,
				children: node.children.map(convert),
			};
		}

		return sessionTree.map(convert);
	}

	async getUserMessagesForForking(): Promise<UserMessageForForking[]> {
		return this._getSession().getUserMessagesForForking();
	}

	async exportToHtml(outputPath?: string): Promise<string> {
		return this._getSession().exportToHtml(outputPath);
	}

	async exportToJsonl(outputPath?: string): Promise<string> {
		return this._getSession().exportToJsonl(outputPath);
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		const session = this._getSession();
		const model = session.modelRegistry.find(provider, modelId);
		if (!model) {
			throw new Error(`Model not found: ${provider}/${modelId}`);
		}
		await session.setModel(model);
	}

	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<void> {
		await this._getSession().cycleModel(direction);
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this._getSession().setThinkingLevel(level);
	}

	cycleThinkingLevel(): void {
		this._getSession().cycleThinkingLevel();
	}

	getAvailableThinkingLevels(): ThinkingLevel[] {
		return this._getSession().getAvailableThinkingLevels();
	}

	supportsThinking(): boolean {
		return this._getSession().supportsThinking();
	}

	async setScopedModels(patterns: string[]): Promise<void> {
		const session = this._getSession();
		const allModels = session.modelRegistry.getAvailable();
		const regexes = patterns.map((pattern) => pattern.trim()).filter(Boolean).map(globPatternToRegExp);
		const matching = allModels.filter((m: Model<Api>) => {
			const id = `${m.provider}/${m.id}`;
			return regexes.some((regex) => regex.test(id) || regex.test(m.id));
		});
		session.setScopedModels(matching.map((m: Model<Api>) => ({ model: m })));
	}

	getScopedModels(): ModelInfo[] {
		return this._getSession().scopedModels.map((m) => ({
			provider: m.model.provider,
			id: m.model.id,
			contextWindow: m.model.contextWindow,
			reasoning: m.model.reasoning,
			thinkingLevels: getSupportedThinkingLevels(m.model) as ThinkingLevel[],
			input: m.model.input,
		}));
	}

	// =========================================================================
	// Auth
	// =========================================================================

	getAuthStatus(): AuthStatusMap {
		const status: AuthStatusMap = {};
		try {
			const session = this._getSession();
			const allModels = session.modelRegistry.getAll();
			const providers = new Set(allModels.map((m: Model<Api>) => m.provider));
			for (const provider of providers) {
				const authStatus = session.modelRegistry.getProviderAuthStatus(provider);
				status[provider] = {
					provider,
					configured: authStatus.configured,
					source: authStatus.source,
					label: authStatus.label,
				};
			}
		} catch {
			// Return empty status map if session not ready
		}
		return status;
	}

	setApiKey(provider: string, key: string): void {
		if (!this._authStorage) {
			throw new Error("Auth storage not initialized. Start a session first.");
		}
		this._authStorage.set(provider, { type: "api_key", key });
		const session = this._getSession();
		session.modelRegistry.refresh();
		this._applyEnabledModelScope(session);
	}

	removeAuth(provider: string): void {
		if (!this._authStorage) {
			throw new Error("Auth storage not initialized. Start a session first.");
		}
		this._authStorage.remove(provider);
		const session = this._getSession();
		session.modelRegistry.refresh();
		this._applyEnabledModelScope(session);
	}

	// =========================================================================
	// Full Pi Settings (from SettingsManager)
	// =========================================================================

	getPiSettings(): Record<string, unknown> {
		const sm = this._getSession().settingsManager;
		return sm.getGlobalSettings() as unknown as Record<string, unknown>;
	}

	async setPiSetting(key: string, value: unknown): Promise<void> {
		await this.setPiSettings([{ key, value }]);
	}

	async setPiSettings(entries: PiSettingEntry[]): Promise<void> {
		const session = this._getSession();
		let reloadRuntime = false;
		let refreshSystemPrompt = false;
		let reapplyModelScope = false;

		for (const entry of entries) {
			const result = this._applyPiSetting(entry.key, entry.value);
			reloadRuntime ||= result.reloadRuntime === true;
			refreshSystemPrompt ||= result.refreshSystemPrompt === true;
			reapplyModelScope ||= result.reapplyModelScope === true;
		}

		if (reloadRuntime) {
			await session.reload();
			reapplyModelScope = true;
		} else if (refreshSystemPrompt) {
			session.refreshSystemPrompt();
		}

		if (reapplyModelScope) {
			this._applyEnabledModelScope(session);
		}
	}

	private _applyPiSetting(key: string, value: unknown): PiSettingApplyResult {
		const sm = this._getSession().settingsManager;
		const session = this._getSession();

		switch (key) {
			case "defaultProvider": sm.setDefaultProvider(value as string); return {};
			case "defaultModel": sm.setDefaultModel(value as string); return {};
			case "defaultThinkingLevel": sm.setDefaultThinkingLevel(value as ThinkingLevel); return {};
			case "transport": sm.setTransport(value as "auto" | "sse" | "websocket"); return {};
			case "steeringMode": session.setSteeringMode(value as "all" | "one-at-a-time"); return {};
			case "followUpMode": session.setFollowUpMode(value as "all" | "one-at-a-time"); return {};
			case "theme": sm.setTheme(value as string); return {};
			case "hideThinkingBlock": sm.setHideThinkingBlock(value as boolean); return {};
			case "shellPath":
				sm.setShellPath(value as string | undefined);
				return { reloadRuntime: true };
			case "quietStartup": sm.setQuietStartup(value as boolean); return {};
			case "shellCommandPrefix": sm.setShellCommandPrefix(value as string | undefined); return { reloadRuntime: true };
			case "npmCommand": sm.setNpmCommand(value as string[] | undefined); return { reloadRuntime: true };
			case "collapseChangelog": sm.setCollapseChangelog(value as boolean); return {};
			case "enableInstallTelemetry": sm.setEnableInstallTelemetry(value as boolean); return {};
			case "compactEnabled": sm.setCompactionEnabled(value as boolean); return {};
			case "compactionReserveTokens": return {};
			case "compactionKeepRecentTokens": return {};
			case "retryEnabled": sm.setRetryEnabled(value as boolean); return {};
			case "executionMode":
				sm.setExecutionMode(
					value === "unattended" || value === "read-only" ? value : "approval",
				);
				return { refreshSystemPrompt: true };
			case "verificationGate":
				sm.setVerificationGateEnabled(value as boolean);
				return { refreshSystemPrompt: true };
			case "enableSkillCommands": sm.setEnableSkillCommands(value as boolean); return { reloadRuntime: true };
			case "showImages": sm.setShowImages(value as boolean); return {};
			case "imageWidthCells": sm.setImageWidthCells(value as number); return {};
			case "autoResizeImages": sm.setImageAutoResize(value as boolean); return { reloadRuntime: true };
			case "blockImages": sm.setBlockImages(value as boolean); return {};
			case "clearOnShrink": sm.setClearOnShrink(value as boolean); return {};
			case "showTerminalProgress": sm.setShowTerminalProgress(value as boolean); return {};
			case "sessionDir": return {};
			case "httpIdleTimeoutMs": sm.setHttpIdleTimeoutMs(value as number); return {};
			case "enabledModels":
				sm.setEnabledModels(value as string[] | undefined);
				return { reapplyModelScope: true };
			case "extensionPaths": sm.setExtensionPaths(Array.isArray(value) ? value as string[] : []); return { reloadRuntime: true };
			case "skillPaths": sm.setSkillPaths(Array.isArray(value) ? value as string[] : []); return { reloadRuntime: true };
			case "promptTemplatePaths": sm.setPromptTemplatePaths(Array.isArray(value) ? value as string[] : []); return { reloadRuntime: true };
			case "themePaths": sm.setThemePaths(Array.isArray(value) ? value as string[] : []); return { reloadRuntime: true };
			case "packages":
				sm.setPackages(value as Array<{ source: string; extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[] }>);
				return { reloadRuntime: true };
			case "doubleEscapeAction": sm.setDoubleEscapeAction(value as "fork" | "tree" | "none"); return {};
			case "treeFilterMode": sm.setTreeFilterMode(value as "default" | "no-tools" | "user-only" | "labeled-only" | "all"); return {};
			case "showHardwareCursor": sm.setShowHardwareCursor(value as boolean); return {};
			case "editorPaddingX": sm.setEditorPaddingX(value as number); return {};
			case "autocompleteMaxVisible": sm.setAutocompleteMaxVisible(value as number); return {};
			case "warnings": sm.setWarnings(value as { anthropicExtraUsage?: boolean }); return {};
			default:
				throw new Error(`Unknown setting key: ${key}`);
		}
	}

	async compact(customInstructions?: string): Promise<void> {
		await this._getSession().compact(customInstructions);
	}

	setSessionName(name: string): void {
		this._getSession().setSessionName(name);
	}

	getLastAssistantText(): string | undefined {
		return this._getSession().getLastAssistantText();
	}

	getState(): RpcSessionState {
		const session = this._getSession();
		const model = session.model;
		return {
			model: model ? { provider: model.provider, id: model.id } : undefined,
			thinkingLevel: session.thinkingLevel,
			isStreaming: session.isStreaming,
			isCompacting: this._isCompacting,
			executionMode: session.settingsManager.getExecutionMode(),
			steeringMode: session.steeringMode,
			followUpMode: session.followUpMode,
			sessionFile: session.sessionManager.getSessionFile() ?? undefined,
			sessionId: session.sessionId,
			sessionName: session.sessionManager.getSessionName() ?? undefined,
			autoCompactionEnabled: session.settingsManager.getCompactionEnabled(),
			messageCount: session.messages.length,
			pendingMessageCount: this._pendingMessageCount,
			blockImages: session.settingsManager.getBlockImages(),
			goal: session.goal,
		};
	}

	getBackgroundTasks(): Array<{ taskId: string; command: string; pid?: number; startedAt: number; status: string }> {
		return this._getSession().backgroundTaskRegistry.getRunning().map((t) => ({
			taskId: t.taskId,
			command: t.command,
			pid: t.pid,
			startedAt: t.startedAt,
			status: t.status,
		}));
	}

	stopBackgroundTask(taskId: string): { found: boolean } {
		const result = this._getSession().backgroundTaskRegistry.stop(taskId);
		return { found: result.found };
	}

	getSessionStats(): SessionStats {
		const stats = this._getSession().getSessionStats();
		const tokens = {
			input: stats.tokens.input + this._auxiliaryUsage.input,
			output: stats.tokens.output + this._auxiliaryUsage.output,
			cacheRead: stats.tokens.cacheRead + this._auxiliaryUsage.cacheRead,
			cacheWrite: stats.tokens.cacheWrite + this._auxiliaryUsage.cacheWrite,
		};
		return {
			sessionFile: stats.sessionFile,
			sessionId: stats.sessionId,
			userMessages: stats.userMessages,
			assistantMessages: stats.assistantMessages,
			toolCalls: stats.toolCalls,
			toolResults: stats.toolResults,
			totalMessages: stats.totalMessages,
			tokens: {
				...tokens,
				total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
			},
			cost: stats.cost + this._auxiliaryUsage.cost,
			contextUsage: stats.contextUsage,
		};
	}

	getAvailableModels(): ModelInfo[] {
		const session = this._getSession();
		const scopedModels = session.scopedModels;
		const models = scopedModels.length > 0
			? scopedModels.map((scoped) => scoped.model)
			: session.modelRegistry.getAvailable();
		return models.map((model: Model<Api>) => ({
				provider: model.provider,
				id: model.id,
				contextWindow: model.contextWindow,
				reasoning: model.reasoning,
				thinkingLevels: getSupportedThinkingLevels(model) as ThinkingLevel[],
				input: model.input,
			}));
	}

	async getCommands(): Promise<RpcSlashCommand[]> {
		try {
			const session = this._getSession();
			const builtInCommands: RpcSlashCommand[] = [
				{
					name: "goal",
					description: "创建、查看、暂停、恢复或完成持续目标",
					source: "builtin",
					sourceInfo: { path: "<builtin:goal>" },
				},
			];

			const extensionCommands: RpcSlashCommand[] = session.extensionRunner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: {
					path: command.sourceInfo?.path,
				},
			}));

			const promptTemplates: RpcSlashCommand[] = session.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: {
					path: template.sourceInfo?.path,
				},
			}));

			const skills: RpcSlashCommand[] = session.resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: {
					path: skill.sourceInfo?.path,
				},
			}));

			return [...builtInCommands, ...extensionCommands, ...promptTemplates, ...skills].map((command) => ({
					name: command.name,
					description: command.description,
					source: command.source,
					sourceInfo: {
						path: command.sourceInfo?.path,
					},
				}));
		} catch (err) {
			console.error("[SessionBridge] Error getting commands:", err);
			return [];
		}
	}

	getMessages(): AgentMessage[] {
		return this._getSession().messages;
	}

	isRunning(): boolean {
		return this._session !== null;
	}

	isStreaming(): boolean {
		return this._session?.isStreaming ?? false;
	}

	getStderr(): string {
		return "";
	}

	// =========================================================================
	// Session Config
	// =========================================================================

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this._getSession().setSteeringMode(mode);
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this._getSession().setFollowUpMode(mode);
	}

	setAutoCompact(enabled: boolean): void {
		this._getSession().setAutoCompactionEnabled(enabled);
	}

	// =========================================================================
	// Resource Management
	// =========================================================================

	async reloadResources(): Promise<void> {
		await this._getSession().reload();
	}

	getThemes(): ThemeInfo[] {
		try {
			const rl = this._getSession().resourceLoader;
			const themesResult = rl.getThemes();
			return themesResult.themes.map((t) => ({
				name: t.name ?? "Unknown",
				path: t.sourceInfo?.path,
				source: (t.sourceInfo?.scope === "user" || t.sourceInfo?.path) ? "custom" as const : "builtin" as const,
			}));
		} catch {
			return [];
		}
	}

	getResourceStatus(): ResourceStatus {
		try {
			const rl = this._getSession().resourceLoader;
			const extensions = rl.getExtensions();
			return {
				extensions: { loaded: extensions.extensions.length, errors: extensions.errors.map((e) => e.error.toString()) },
				skills: { loaded: rl.getSkills().skills.length },
				prompts: { loaded: rl.getPrompts().prompts.length },
				themes: { loaded: rl.getThemes().themes.length },
			};
		} catch {
			return {
				extensions: { loaded: 0, errors: [] },
				skills: { loaded: 0 },
				prompts: { loaded: 0 },
				themes: { loaded: 0 },
			};
		}
	}
	// =========================================================================
	// MCP Queries
	// =========================================================================

	mcpGetServers(): McpServerInfo[] {
		return this._mcpAdapter?.getServers() ?? [];
	}

	mcpGetConfig(): McpConfigInfo {
		return this._mcpAdapter?.getConfigInfo() ?? { configPaths: [], errors: [] };
	}

	async mcpListResources(serverName?: string): Promise<McpResourceInfo[]> {
		if (!this._mcpAdapter) return [];
		const { results, errors } = await this._mcpAdapter.listResources(serverName);
		return results.map((r) => ({ server: r.server, resources: r.resources }));
	}

	async mcpReadResource(serverName: string | undefined, uri: string): Promise<McpResourceContent> {
		if (!this._mcpAdapter) throw new Error("MCP adapter not available");
		return this._mcpAdapter.readResource(serverName, uri);
	}

	// =========================================================================
	// Event subscriptions
	// =========================================================================

	onEvent(listener: (event: AgentSessionEvent) => void): () => void {
		this._eventListeners.push(listener);
		return () => {
			const idx = this._eventListeners.indexOf(listener);
			if (idx !== -1) this._eventListeners.splice(idx, 1);
		};
	}

	onLifecycle<TEvent extends LifecycleEvent>(event: TEvent, listener: LifecycleListener<TEvent>): () => void {
		this._lifecycleListeners[event].push(listener);
		return () => {
			const arr = this._lifecycleListeners[event];
			const idx = arr.indexOf(listener);
			if (idx !== -1) arr.splice(idx, 1);
		};
	}

	onUserInputRequest(listener: UserInputRequestListener): () => void {
		this._userInputRequestListeners.push(listener);
		return () => {
			const idx = this._userInputRequestListeners.indexOf(listener);
			if (idx !== -1) this._userInputRequestListeners.splice(idx, 1);
		};
	}

	respondUserInput(response: RequestUserInputResponse): void {
		const pending = this._pendingUserInputRequests.get(response.id);
		if (!pending) {
			throw new Error(`No pending user input request: ${response.id}`);
		}
		this._pendingUserInputRequests.delete(response.id);
		pending.resolve(response);
	}

	private _getSession(): AgentSession {
		if (!this._session) {
			throw new Error("Session not started. Call start() first.");
		}
		return this._session;
	}

	private _requestUserInput(
		request: RequestUserInputRequest,
		signal?: AbortSignal,
	): Promise<RequestUserInputResponse> {
		if (signal?.aborted) {
			return Promise.reject(new Error("request_user_input was aborted."));
		}

		return new Promise((resolve, reject) => {
			const cleanup = () => {
				signal?.removeEventListener("abort", onAbort);
				this._pendingUserInputRequests.delete(request.id);
			};
			const onAbort = () => {
				cleanup();
				reject(new Error("request_user_input was aborted."));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this._pendingUserInputRequests.set(request.id, {
				resolve: (response) => {
					cleanup();
					resolve(response);
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			});

			for (const listener of this._userInputRequestListeners) {
				try {
					listener(request);
				} catch (err) {
					console.error("[SessionBridge] User input request listener error:", err);
				}
			}
		});
	}

	private _rejectPendingUserInputRequests(error: Error): void {
		const requests = Array.from(this._pendingUserInputRequests.values());
		this._pendingUserInputRequests.clear();
		for (const pending of requests) {
			pending.reject(error);
		}
	}

	private async _preparePromptInput(
		text: string,
		filePaths?: readonly string[],
		clipboardImages?: ClipboardImage[],
	): Promise<{
		text: string;
		images?: ImageContent[];
		displayText?: string;
		attachments?: ChatMessageAttachment[];
	}> {
		const session = this._getSession();
		const allImages: ImageContent[] = [];
		const allAttachments: ChatMessageAttachment[] = [];
		const parts: string[] = [];

		// Process file paths
		if (filePaths && filePaths.length > 0) {
			const processed = await processChatFiles(filePaths, this._cwd, {
				autoResizeImages: session.settingsManager.getImageAutoResize(),
			});
			if (processed.text) parts.push(processed.text);
			allImages.push(...processed.images);
			allAttachments.push(...processed.attachments);
		}

		// Process clipboard images
		if (clipboardImages && clipboardImages.length > 0) {
			for (let i = 0; i < clipboardImages.length; i++) {
				const img = clipboardImages[i];
				allImages.push({
					type: "image",
					mimeType: img.mimeType,
					data: img.base64,
				});
				allAttachments.push({
					path: `clipboard-image-${i + 1}`,
					name: `clipboard-image-${i + 1}.${img.mimeType.split("/")[1] || "png"}`,
					kind: "image",
				});
			}
		}

		if (text) parts.push(text);

		if (session.settingsManager.getBlockImages()) {
			return {
				text: parts.join(""),
				images: undefined,
				displayText: text,
				attachments: allAttachments,
			};
		}

		const visualContext = await this._tryTakeHerEyes(text, allImages, allAttachments);
		if (visualContext) {
			parts.push(visualContext);
			return {
				text: parts.join(""),
				images: undefined,
				displayText: text,
				attachments: allAttachments,
			};
		}

		return {
			text: parts.join(""),
			images: allImages.length > 0 ? allImages : undefined,
			displayText: text,
			attachments: allAttachments,
		};
	}

	private async _tryTakeHerEyes(
		userText: string,
		images: ImageContent[],
		attachments: ChatMessageAttachment[],
	): Promise<string | null> {
		if (images.length === 0) return null;

		const session = this._getSession();
		if (session.settingsManager.getBlockImages()) return null;
		const mainModel = session.model;
		if (!mainModel) return null;
		if (mainModel.input.includes("image")) return null;

		const config = this._guiSettings?.takeHerEyes;
		if (!config?.enabled || !config.provider || !config.modelId) return null;

		const eyeModel = session.modelRegistry.find(config.provider, config.modelId);
		if (!eyeModel || !eyeModel.input.includes("image")) return null;
		if (!session.modelRegistry.hasConfiguredAuth(eyeModel)) return null;

		const operationId = `eye_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
		let emittedStart = false;
		const emitEnd = (success: boolean, errorMessage?: string): void => {
			if (!emittedStart) return;
			this._emitSessionEvent({
				type: "eye_model_end",
				id: operationId,
				provider: eyeModel.provider,
				modelId: eyeModel.id,
				imageCount: images.length,
				success,
				errorMessage,
			});
			emittedStart = false;
		};

		try {
			const auth = await session.modelRegistry.getApiKeyAndHeaders(eyeModel);
			if (!auth.ok) {
				console.warn(`[takeHerEyes] Auth unavailable for ${eyeModel.provider}/${eyeModel.id}: ${auth.error}`);
				return null;
			}

			this._emitSessionEvent({
				type: "eye_model_start",
				id: operationId,
				provider: eyeModel.provider,
				modelId: eyeModel.id,
				imageCount: images.length,
			});
			emittedStart = true;

			const response = await completeSimple(eyeModel, this._createEyeContext(userText, images, attachments), {
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens: TAKE_HER_EYES_MAX_TOKENS,
				timeoutMs: TAKE_HER_EYES_TIMEOUT_MS,
				maxRetries: 0,
			});
			this._recordAuxiliaryUsage(response.usage);

			if (response.stopReason === "error") {
				const errorMessage = response.errorMessage ?? "unknown error";
				console.warn(`[takeHerEyes] Vision model failed: ${errorMessage}`);
				emitEnd(false, errorMessage);
				return null;
			}

			const description = response.content
				.filter((block): block is TextContent => block.type === "text")
				.map((block) => block.text.trim())
				.filter(Boolean)
				.join("\n")
				.trim();

			if (!description) {
				emitEnd(false, "Vision model returned no text.");
				return null;
			}
			emitEnd(true);
			return this._formatVisualContext(description, eyeModel, images.length);
		} catch (error) {
			emitEnd(false, error instanceof Error ? error.message : String(error));
			console.warn("[takeHerEyes] Vision preprocessing failed:", error);
			return null;
		}
	}

	private _createEyeContext(
		userText: string,
		images: ImageContent[],
		attachments: ChatMessageAttachment[],
	): Context {
		const imageNames = attachments
			.filter((attachment) => attachment.kind === "image")
			.map((attachment, index) => `Image ${index + 1}: ${attachment.name} (${attachment.path})`);
		const prompt = [
			userText
				? `User request:\n${userText}`
				: "User request:\nDescribe the attached image(s) accurately.",
			imageNames.length > 0 ? `Attached image order:\n${imageNames.join("\n")}` : "",
			"Return a concise but complete visual context for another model. Label details by image number when multiple images are attached.",
		].filter(Boolean).join("\n\n");

		const content: Array<TextContent | ImageContent> = [
			{ type: "text", text: prompt },
			...images,
		];

		return {
			systemPrompt: TAKE_HER_EYES_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content,
					timestamp: Date.now(),
				},
			],
		};
	}

	private _formatVisualContext(description: string, eyeModel: Model<Api>, imageCount: number): string {
		return [
			"",
			`<visual_context generated_by="takeHerEyes" model="${eyeModel.provider}/${eyeModel.id}" image_count="${imageCount}">`,
			"The user attached image(s), but the current main model cannot view images directly.",
			"A separate vision model produced the following description. Use it as visual evidence and preserve uncertainty.",
			description,
			"</visual_context>",
			"",
		].join("\n");
	}

	private _recordAuxiliaryUsage(usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: { total: number };
	}): void {
		this._auxiliaryUsage.input += usage.input;
		this._auxiliaryUsage.output += usage.output;
		this._auxiliaryUsage.cacheRead += usage.cacheRead;
		this._auxiliaryUsage.cacheWrite += usage.cacheWrite;
		this._auxiliaryUsage.cost += usage.cost.total;
	}

	private _applyEnabledModelScope(session: AgentSession): void {
		const patterns = session.settingsManager.getEnabledModels()?.map((pattern) => pattern.trim()).filter(Boolean);
		if (!patterns || patterns.length === 0) {
			session.setScopedModels([]);
			return;
		}
		session.setScopedModels(this._resolveScopedModels(session, patterns));
	}

	private _resolveScopedModels(
		session: AgentSession,
		patterns: string[],
	): Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> {
		const availableModels = session.modelRegistry.getAvailable();
		const scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> = [];
		const seen = new Set<string>();

		for (const rawPattern of patterns) {
			const { pattern, thinkingLevel } = this._parseScopedModelPattern(rawPattern);
			if (!pattern) continue;

			const hasGlob = pattern.includes("*") || pattern.includes("?");
			const regex = hasGlob ? globPatternToRegExp(pattern) : undefined;
			const patternLower = pattern.toLowerCase();

			for (const model of availableModels) {
				const fullId = `${model.provider}/${model.id}`;
				const matches = regex
					? regex.test(fullId) || regex.test(model.id)
					: fullId.toLowerCase() === patternLower || model.id.toLowerCase() === patternLower;
				if (!matches) continue;

				const key = `${model.provider}/${model.id}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const supportedThinking = getSupportedThinkingLevels(model) as ThinkingLevel[];
				scopedModels.push({
					model,
					thinkingLevel: thinkingLevel && supportedThinking.includes(thinkingLevel) ? thinkingLevel : undefined,
				});
			}
		}

		return scopedModels;
	}

	private _parseScopedModelPattern(rawPattern: string): { pattern: string; thinkingLevel?: ThinkingLevel } {
		const trimmed = rawPattern.trim();
		const colonIndex = trimmed.lastIndexOf(":");
		if (colonIndex === -1) return { pattern: trimmed };

		const suffix = trimmed.slice(colonIndex + 1);
		if (this._isThinkingLevel(suffix)) {
			return {
				pattern: trimmed.slice(0, colonIndex),
				thinkingLevel: suffix,
			};
		}
		return { pattern: trimmed };
	}

	private _isThinkingLevel(value: string): value is ThinkingLevel {
		return value === "off" ||
			value === "minimal" ||
			value === "low" ||
			value === "medium" ||
			value === "high" ||
			value === "xhigh";
	}

	private async _createSession(
		cwd: string,
		sessionManager: SessionManager,
		sessionStartEvent: SessionStartEvent,
	): Promise<CreateAgentSessionResult> {
		const settingsManager = this._createSettingsManager(cwd);
		const mcpAdapter = new McpAdapter();
		this._mcpAdapter = mcpAdapter;
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: getAgentDir(),
			settingsManager,
			extensionFactories: [(pi) => { mcpAdapter.register(pi); }],
		});
		await resourceLoader.reload();

		const result = await createAgentSession({
			cwd,
			sessionManager,
			settingsManager,
			resourceLoader,
			authStorage: this._authStorage ?? undefined,
			sessionStartEvent,
			requestUserInput: (request, signal) => this._requestUserInput(request, signal),
		});
		this._applyEnabledModelScope(result.session);
		return result;
	}

	private async _activateSession(session: AgentSession): Promise<void> {
		this._session = session;
		this._auxiliaryUsage = createEmptyAuxiliaryUsage();
		this._setupEventSubscription(session);
		await this._bindExtensions();
		this._emitLifecycle("ready");
	}

	private async _closeCurrentSession(
		reason: SessionShutdownEvent["reason"],
		targetSessionFile?: string,
	): Promise<boolean> {
		const session = this._session;
		const mcpAdapter = this._mcpAdapter;
		this._unsubscribe?.();
		this._unsubscribe = null;
		this._session = null;
		this._sessionManager = null;
		this._isCompacting = false;
		this._pendingMessageCount = 0;
		this._mcpAdapter = null;
		this._rejectPendingUserInputRequests(new Error("Session closed before user input was provided."));

		if (!session) {
			return false;
		}

		try {
			await session.dispose({ reason, targetSessionFile });
		} catch (err) {
			console.error("[SessionBridge] Error during session dispose:", err);
		}
		try {
			await mcpAdapter?.dispose();
		} catch (err) {
			console.error("[SessionBridge] Error during MCP adapter dispose:", err);
		}
		return true;
	}

	private _createSettingsManager(cwd: string): SettingsManager {
		const settingsManager = SettingsManager.create(cwd);
		const overrides: Parameters<SettingsManager["applyOverrides"]>[0] = {};

		if (this._guiSettings?.defaultProvider) {
			overrides.defaultProvider = this._guiSettings.defaultProvider;
		}
		if (this._guiSettings?.defaultModel) {
			overrides.defaultModel = this._guiSettings.defaultModel;
		}
		if (this._guiSettings?.defaultThinkingLevel) {
			overrides.defaultThinkingLevel = this._guiSettings.defaultThinkingLevel;
		}

		settingsManager.applyOverrides(overrides);
		return settingsManager;
	}

	private async _bindExtensions(): Promise<void> {
		const commandContextActions: ExtensionCommandContextActions = {
			waitForIdle: () => this._getSession().agent.waitForIdle(),
			newSession: async (options) => {
				const result = await this.newSession(options?.parentSession);
				await this._runWithReplacementContext(options?.withSession);
				return result;
			},
			fork: async (entryId, options) => {
				const result = await this.fork(entryId, options?.position ?? "before");
				await this._runWithReplacementContext(options?.withSession);
				return result;
			},
			navigateTree: async (targetId, options) => {
				const result = await this._getSession().navigateTree(targetId, {
					summarize: options?.summarize,
					customInstructions: options?.customInstructions,
					replaceInstructions: options?.replaceInstructions,
					label: options?.label,
				});
				return { cancelled: result.cancelled };
			},
			switchSession: async (sessionPath, options) => {
				const result = await this.switchSession(sessionPath);
				await this._runWithReplacementContext(options?.withSession);
				return result;
			},
			reload: async () => {
				await this._getSession().reload();
			},
		};

		await this._getSession().bindExtensions({
			commandContextActions,
			onError: (error) => {
				this._emitLifecycle("error", new Error(this._formatExtensionError(error)));
			},
		});
	}

	private async _runWithReplacementContext(
		withSession: WithSessionCallback | undefined,
	): Promise<void> {
		if (withSession) {
			await withSession(this._getSession().createReplacedSessionContext());
		}
	}

	private _setupEventSubscription(session: AgentSession): void {
		this._isCompacting = false;
		this._pendingMessageCount = 0;

		this._unsubscribe = session.subscribe((event) => {
			const sessionEvent = event as AgentSessionEvent;
			this._emitSessionEvent(sessionEvent);
		});
	}

	private _emitSessionEvent(event: AgentSessionEvent): void {
		this._updateTrackedState(event);

		for (const listener of this._eventListeners) {
			try {
				listener(event);
			} catch (err) {
				console.error("[SessionBridge] Event listener error:", err);
			}
		}
	}

	private _updateTrackedState(event: AgentSessionEvent): void {
		switch (event.type) {
			case "compaction_start":
				this._isCompacting = true;
				break;
			case "compaction_end":
				this._isCompacting = false;
				break;
			case "queue_update":
				this._pendingMessageCount = (event.steering?.length ?? 0) + (event.followUp?.length ?? 0);
				break;
		}
	}

	private _assertProjectDirectory(projectDir: string): void {
		if (!projectDir) {
			throw new Error("Project directory is required.");
		}
		if (!existsSync(projectDir)) {
			throw new Error(`Project directory does not exist: ${projectDir}`);
		}
		if (!statSync(projectDir).isDirectory()) {
			throw new Error(`Project path is not a directory: ${projectDir}`);
		}
	}

	private _formatExtensionError(error: ExtensionError): string {
		return `${error.extensionPath} (${error.event}): ${error.error}`;
	}

	private _emitLifecycle<TEvent extends LifecycleEvent>(event: TEvent, ...args: LifecycleEvents[TEvent]): void {
		for (const listener of this._lifecycleListeners[event]) {
			try {
				listener(...args);
			} catch (err) {
				console.error(`[SessionBridge] Lifecycle listener error (${event}):`, err);
			}
		}
	}
}
