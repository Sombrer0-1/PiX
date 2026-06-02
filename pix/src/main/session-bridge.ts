import { existsSync, statSync } from "fs";
import { join } from "path";
import { shell } from "electron";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type CreateAgentSessionResult,
	type ExtensionCommandContextActions,
	type ExtensionError,
	type SessionStartEvent,
	createAgentSession,
	SessionManager,
	SettingsManager,
	AuthStorage,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type {
	AgentSessionEvent,
	GuiSettings,
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
} from "../shared/types.js";

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
type WithSessionCallback = NonNullable<
	NonNullable<Parameters<ExtensionCommandContextActions["newSession"]>[0]>["withSession"]
>;

export class SessionBridge {
	private _session: AgentSession | null = null;
	private _sessionManager: SessionManager | null = null;
	private _authStorage: AuthStorage | null = null;
	private _cwd = "";
	private _guiSettings: GuiSettings | undefined;
	private _unsubscribe: (() => void) | null = null;

	private _eventListeners: Array<(event: AgentSessionEvent) => void> = [];
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
		this._closeCurrentSession();

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

	dispose(): void {
		const hadSession = this._closeCurrentSession();
		if (hadSession) {
			this._emitLifecycle("exit", { code: 0, signal: null, stderr: "" });
		}
	}

	async prompt(text: string): Promise<void> {
		await this._getSession().prompt(text);
	}

	async steer(text: string): Promise<void> {
		await this._getSession().steer(text);
	}

	async followUp(text: string): Promise<void> {
		await this._getSession().followUp(text);
	}

	async abort(): Promise<void> {
		await this._getSession().abort();
	}

	async newSession(parentSession?: string): Promise<CommandResult> {
		const previousSessionFile = this._session?.sessionFile;
		const sessionDir = this._sessionManager?.getSessionDir();
		this._closeCurrentSession();

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
		this._closeCurrentSession();

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
			const newSessionManager = SessionManager.create(this._cwd, sessionDir);
			newSessionManager.newSession({ parentSession: currentSessionFile });
			this._closeCurrentSession();
			this._sessionManager = newSessionManager;

			const result = await this._createSession(this._cwd, this._sessionManager, {
				type: "session_start",
				reason: "fork",
				previousSessionFile,
			});
			if (label && targetLeafId) {
				this._sessionManager.appendLabelChange(targetLeafId, label);
			}
			await this._activateSession(result.session);
			return { cancelled: false };
		}

		const forkManager = SessionManager.open(currentSessionFile, sessionDir);
		const forkedSessionPath = forkManager.createBranchedSession(targetLeafId);
		if (!forkedSessionPath) {
			throw new Error("Failed to create forked session");
		}

		this._closeCurrentSession();
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
		const matching = allModels.filter((m: Model<Api>) => {
			const id = `${m.provider}/${m.id}`;
			return patterns.some((pattern) => {
				const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$", "i");
				return regex.test(id) || regex.test(m.id);
			});
		});
		session.setScopedModels(matching.map((m: Model<Api>) => ({ model: m })));
	}

	getScopedModels(): ModelInfo[] {
		return this._getSession().scopedModels.map((m) => ({
			provider: m.model.provider,
			id: m.model.id,
			contextWindow: m.model.contextWindow,
			reasoning: m.model.reasoning,
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
	}

	removeAuth(provider: string): void {
		if (!this._authStorage) {
			throw new Error("Auth storage not initialized. Start a session first.");
		}
		this._authStorage.remove(provider);
	}

	// =========================================================================
	// Full Pi Settings (from SettingsManager)
	// =========================================================================

	getPiSettings(): Record<string, unknown> {
		const sm = this._getSession().settingsManager;
		return sm.getGlobalSettings() as unknown as Record<string, unknown>;
	}

	setPiSetting(key: string, value: unknown): void {
		const sm = this._getSession().settingsManager;
		const session = this._getSession();

		switch (key) {
			case "defaultProvider": return sm.setDefaultProvider(value as string);
			case "defaultModel": return sm.setDefaultModel(value as string);
			case "defaultThinkingLevel": return sm.setDefaultThinkingLevel(value as ThinkingLevel);
			case "transport": return sm.setTransport(value as "auto" | "sse" | "websocket");
			case "steeringMode": session.setSteeringMode(value as "all" | "one-at-a-time"); return;
			case "followUpMode": session.setFollowUpMode(value as "all" | "one-at-a-time"); return;
			case "theme": return sm.setTheme(value as string);
			case "hideThinkingBlock": return sm.setHideThinkingBlock(value as boolean);
			case "shellPath": return sm.setShellPath(value as string | undefined);
			case "quietStartup": return sm.setQuietStartup(value as boolean);
			case "shellCommandPrefix": return sm.setShellCommandPrefix(value as string | undefined);
			case "npmCommand": return sm.setNpmCommand(value as string[] | undefined);
			case "collapseChangelog": return sm.setCollapseChangelog(value as boolean);
			case "enableInstallTelemetry": return sm.setEnableInstallTelemetry(value as boolean);
			case "compactEnabled": return sm.setCompactionEnabled(value as boolean);
			case "compactionReserveTokens": return;
			case "compactionKeepRecentTokens": return;
			case "retryEnabled": return sm.setRetryEnabled(value as boolean);
			case "enableSkillCommands": return sm.setEnableSkillCommands(value as boolean);
			case "showImages": return sm.setShowImages(value as boolean);
			case "imageWidthCells": return sm.setImageWidthCells(value as number);
			case "autoResizeImages": return sm.setImageAutoResize(value as boolean);
			case "blockImages": return sm.setBlockImages(value as boolean);
			case "clearOnShrink": return sm.setClearOnShrink(value as boolean);
			case "showTerminalProgress": return sm.setShowTerminalProgress(value as boolean);
			case "sessionDir": return;
			case "httpIdleTimeoutMs": return sm.setHttpIdleTimeoutMs(value as number);
			case "enabledModels": return sm.setEnabledModels(value as string[] | undefined);
			case "extensionPaths": return sm.setExtensionPaths(value as string[]);
			case "skillPaths": return sm.setSkillPaths(value as string[]);
			case "promptTemplatePaths": return sm.setPromptTemplatePaths(value as string[]);
			case "themePaths": return sm.setThemePaths(value as string[]);
			case "packages": return sm.setPackages(value as Array<{ source: string; extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[] }>);
			case "doubleEscapeAction": return sm.setDoubleEscapeAction(value as "fork" | "tree" | "none");
			case "treeFilterMode": return sm.setTreeFilterMode(value as "default" | "no-tools" | "user-only" | "labeled-only" | "all");
			case "showHardwareCursor": return sm.setShowHardwareCursor(value as boolean);
			case "editorPaddingX": return sm.setEditorPaddingX(value as number);
			case "autocompleteMaxVisible": return sm.setAutocompleteMaxVisible(value as number);
			case "warnings": return sm.setWarnings(value as { anthropicExtraUsage?: boolean });
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
			steeringMode: session.steeringMode,
			followUpMode: session.followUpMode,
			sessionFile: session.sessionManager.getSessionFile() ?? undefined,
			sessionId: session.sessionId,
			sessionName: session.sessionManager.getSessionName() ?? undefined,
			autoCompactionEnabled: session.settingsManager.getCompactionEnabled(),
			messageCount: session.messages.length,
			pendingMessageCount: this._pendingMessageCount,
		};
	}

	getSessionStats(): SessionStats {
		const stats = this._getSession().getSessionStats();
		return {
			sessionFile: stats.sessionFile,
			sessionId: stats.sessionId,
			userMessages: stats.userMessages,
			assistantMessages: stats.assistantMessages,
			toolCalls: stats.toolCalls,
			toolResults: stats.toolResults,
			totalMessages: stats.totalMessages,
			tokens: stats.tokens,
			cost: stats.cost,
		};
	}

	getAvailableModels(): ModelInfo[] {
		return this._getSession()
			.modelRegistry.getAvailable()
			.map((model: Model<Api>) => ({
				provider: model.provider,
				id: model.id,
				contextWindow: model.contextWindow,
				reasoning: model.reasoning,
			}));
	}

	async getCommands(): Promise<RpcSlashCommand[]> {
		try {
			const session = this._getSession();
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

			return [...extensionCommands, ...promptTemplates, ...skills].map((command) => ({
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

	private _getSession(): AgentSession {
		if (!this._session) {
			throw new Error("Session not started. Call start() first.");
		}
		return this._session;
	}

	private async _createSession(
		cwd: string,
		sessionManager: SessionManager,
		sessionStartEvent: SessionStartEvent,
	): Promise<CreateAgentSessionResult> {
		return createAgentSession({
			cwd,
			sessionManager,
			settingsManager: this._createSettingsManager(cwd),
			authStorage: this._authStorage ?? undefined,
			sessionStartEvent,
		});
	}

	private async _activateSession(session: AgentSession): Promise<void> {
		this._session = session;
		this._setupEventSubscription();
		await this._bindExtensions();
		this._emitLifecycle("ready");
	}

	private _closeCurrentSession(): boolean {
		const session = this._session;
		this._unsubscribe?.();
		this._unsubscribe = null;
		this._session = null;
		this._sessionManager = null;
		this._isCompacting = false;
		this._pendingMessageCount = 0;

		if (!session) {
			return false;
		}

		try {
			session.dispose();
		} catch (err) {
			console.error("[SessionBridge] Error during session dispose:", err);
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

	private _setupEventSubscription(): void {
		this._isCompacting = false;
		this._pendingMessageCount = 0;

		this._unsubscribe = this._session!.subscribe((event) => {
			const sessionEvent = event as AgentSessionEvent;
			this._updateTrackedState(sessionEvent);

			for (const listener of this._eventListeners) {
				try {
					listener(sessionEvent);
				} catch (err) {
					console.error("[SessionBridge] Event listener error:", err);
				}
			}
		});
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
