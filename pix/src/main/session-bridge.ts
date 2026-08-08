import { createHash } from "crypto";
import { chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, isAbsolute, join, relative, resolve } from "path";
import { lockSync } from "proper-lockfile";
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
import type { TeamManager } from "./team-manager.js";
import {
	createProjectExecutionContext,
	disposeProjectExecutionContext,
	type ProjectExecutionContext,
} from "./execution-context.js";
import type {
	AgentSessionEvent,
	ClipboardImage,
	ExecutionEnvironmentInfo,
	GuiSettings,
	McpConfigInfo,
	McpResourceContent,
	McpResourceInfo,
	McpServerInfo,
	ModelInfo,
	ProjectLocation,
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
	SessionInfo,
} from "../shared/types.js";
import { type CustomProviderConfig, SENTINEL } from "../shared/custom-providers.js";
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

export type SessionBridgeRole = "single" | "team-leader";

export interface SessionBridgeOptions {
	role?: SessionBridgeRole;
	teamManager?: TeamManager;
}

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

/**
 * Extract a validated `providers` map from a parsed models.json value.
 * Returns an empty map when the value is missing, not an object, or has no
 * usable `providers` field. Malformed provider entries are skipped.
 */
function readModelsProviders(value: unknown): Record<string, CustomProviderConfig> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const providers = (value as { providers?: unknown }).providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return {};
	const result: Record<string, CustomProviderConfig> = {};
	for (const [name, provider] of Object.entries(providers as Record<string, unknown>)) {
		if (provider && typeof provider === "object" && !Array.isArray(provider)) {
			result[name] = provider as CustomProviderConfig;
		}
	}
	return result;
}

/**
 * Mask plaintext header values for IPC. Any non-empty string value is replaced
 * with SENTINEL (mirrors apiKey masking); empty values are left as-is. Header
 * keys (e.g. "Authorization") are not secret and are preserved so the UI can
 * show which headers exist.
 */
function maskHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) return headers;
	const masked: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		masked[key] = typeof value === "string" && value !== "" ? SENTINEL : value;
	}
	return masked;
}

/**
 * Resolve header values on write, mirroring the apiKey contract: SENTINEL keeps
 * the on-disk value for that key, null/empty drops the key, any other string
 * becomes the new value. Returns undefined when no headers remain (so the field
 * is dropped under the wholesale-replacement model).
 */
function resolveHeaders(
	incoming: Record<string, string> | undefined,
	disk: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!incoming) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(incoming)) {
		if (value === SENTINEL) {
			const diskValue = disk?.[key];
			if (typeof diskValue === "string" && diskValue !== "") {
				resolved[key] = diskValue;
			}
			// No on-disk value to restore: drop the key.
		} else if (typeof value === "string" && value !== "") {
			resolved[key] = value;
		}
		// null or empty string: drop the key.
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export class SessionBridge {
	private readonly _role: SessionBridgeRole;
	private _session: AgentSession | null = null;
	private _sessionManager: SessionManager | null = null;
	private _authStorage: AuthStorage | null = null;
	private _mcpAdapter: McpAdapter | null = null;
	/** Physical/host cwd: bootstrap (settings/resource/session), IO, hash key. */
	private _physicalCwd = "";
	/** Logical/runtime cwd: model-visible, passed to createAgentSession as runtimeCwd. */
	private _logicalCwd = "";
	/** Sole-owned execution context (backend lifecycle). Borrowed refs must not dispose. */
	private _executionContext: ProjectExecutionContext | null = null;
	private _guiSettings: GuiSettings | undefined;
	private _teamManager: TeamManager | null = null;
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

	constructor(options: SessionBridgeOptions = {}) {
		this._role = options.role ?? "single";
		this._teamManager = this._role === "team-leader" ? options.teamManager ?? null : null;
	}

	async start(location: ProjectLocation | string, guiSettings?: GuiSettings): Promise<void> {
		const projectLocation = this._coerceLocation(location);
		this._assertProjectDirectory(projectLocation);

		// Create + warm the candidate context FIRST. On failure the previous
		// runtime is left untouched (wsl_plan.md §4.8). For Windows this is a
		// trivial no-backend context; for WSL it validates the distro, `test -d`
		// the logical cwd, and warms the backend before we touch the old session.
		const candidateContext = await createProjectExecutionContext(projectLocation);

		// Candidate succeeded: stop the old runtime and take over the new context.
		const previousContext = this._executionContext;
		await this._closeCurrentSession("quit");
		await disposeProjectExecutionContext(previousContext);

		this._executionContext = candidateContext;
		this._physicalCwd = candidateContext.physicalCwd;
		this._logicalCwd = candidateContext.logicalCwd;
		this._guiSettings = guiSettings;

		const agentDir = getAgentDir();
		this._authStorage = AuthStorage.create(join(agentDir, "auth.json"));

		const settingsManager = this._createSettingsManager(this._physicalCwd);
		const sessionDir = this._getSessionDir(this._physicalCwd, settingsManager.getSessionDir());
		this._sessionManager = SessionManager.continueRecent(this._physicalCwd, sessionDir);

		try {
			const result = await this._createSession(this._physicalCwd, this._sessionManager, {
				type: "session_start",
				reason: "startup",
			});
			await this._activateSession(result.session);
		} catch (err) {
			// AgentSession init failure: release the candidate and enter
			// stopped/error. Do not fake-recover the previous runtime.
			this._executionContext = null;
			this._sessionManager = null;
			this._mcpAdapter = null;
			this._physicalCwd = "";
			this._logicalCwd = "";
			await disposeProjectExecutionContext(candidateContext);
			throw err;
		}
	}

	async dispose(): Promise<void> {
		const hadSession = await this._closeCurrentSession("quit");
		const previousContext = this._executionContext;
		this._executionContext = null;
		this._physicalCwd = "";
		this._logicalCwd = "";
		// SessionBridge is the sole owner of the context/backend; release it here.
		// Borrowed references (Team workers) never dispose.
		await disposeProjectExecutionContext(previousContext);
		if (hadSession) {
			this._emitLifecycle("exit", { code: 0, signal: null, stderr: "" });
		}
	}

	/** Alias for dispose() to match the §4.8 SessionBridge contract. */
	async stop(): Promise<void> {
		await this.dispose();
	}

	/** Get the current working directory (empty if no session started). */
	getCwd(): string {
		return this._physicalCwd;
	}

	/** Get the auth storage instance (null if no session started). */
	getAuthStorage(): AuthStorage | null {
		return this._authStorage;
	}

	/** Active project location, or null if no session started. */
	getLocation(): ProjectLocation | null {
		return this._executionContext?.location ?? null;
	}

	/**
	 * Borrowed execution context; callers must not dispose it. Null if no session
	 * is started. TeamManager reuses the leader backend object identity from here
	 * (wsl_plan.md §4.8).
	 */
	getExecutionContext(): ProjectExecutionContext | null {
		return this._executionContext;
	}

	/** Execution environment of the active session, or null if not started. */
	getExecutionEnvironment(): ExecutionEnvironmentInfo | null {
		const context = this._executionContext;
		if (!context) return null;
		const env = context.location.environment;
		if (env.kind === "wsl") {
			return {
				kind: "wsl",
				distro: env.distro,
				logicalCwd: context.logicalCwd,
				ready: true,
			};
		}
		return { kind: "windows", logicalCwd: context.logicalCwd };
	}

	/** List persisted sessions in this bridge's session namespace. */
	async listSessions(location: ProjectLocation | string): Promise<SessionInfo[]> {
		const projectLocation = this._coerceLocation(location);
		this._assertProjectDirectory(projectLocation);
		const physicalPath = projectLocation.physicalPath;
		const settingsManager = this._createSettingsManager(physicalPath);
		const sessionDir = this._getSessionDir(physicalPath, settingsManager.getSessionDir());
		const sessions = await SessionManager.list(physicalPath, sessionDir);
		// SessionInfo.cwd is model-visible: translate the stored physical cwd back
		// to logical in WSL mode. SessionInfo.path is the physical JSONL path and
		// is not shown to the model (wsl_plan.md §4.8).
		const displayPath = this._executionContext?.executionBackend?.paths.displayPath;
		return sessions.map((session) => ({
			path: session.path,
			id: session.id,
			cwd: this._toLogicalCwd(session.cwd, projectLocation, displayPath),
			name: session.name,
			created: session.created.toISOString(),
			modified: session.modified.toISOString(),
			messageCount: session.messageCount,
			firstMessage: session.firstMessage,
		}));
	}

	updateGuiSettings(settings: GuiSettings): void {
		this._guiSettings = settings;
	}

	async prompt(text: string, filePaths?: string[], clipboardImages?: ClipboardImage[]): Promise<void> {
		if (this._role === "team-leader") {
			this._teamManager?.resumeRuntime("leader_prompt");
		}
		const prepared = await this._preparePromptInput(text, filePaths, clipboardImages);
		await this._getSession().prompt(prepared.text, {
			images: prepared.images,
			displayText: prepared.displayText,
			attachments: prepared.attachments,
		});
	}

	async steer(text: string, filePaths?: string[], clipboardImages?: ClipboardImage[]): Promise<void> {
		if (this._role === "team-leader") {
			this._teamManager?.resumeRuntime("leader_steer");
		}
		const prepared = await this._preparePromptInput(text, filePaths, clipboardImages);
		await this._getSession().steer(prepared.text, {
			images: prepared.images,
			displayText: prepared.displayText,
			attachments: prepared.attachments,
		});
	}

	async followUp(text: string, filePaths?: string[], clipboardImages?: ClipboardImage[]): Promise<void> {
		if (this._role === "team-leader") {
			this._teamManager?.resumeRuntime("leader_follow_up");
		}
		const prepared = await this._preparePromptInput(text, filePaths, clipboardImages);
		await this._getSession().followUp(prepared.text, {
			images: prepared.images,
			displayText: prepared.displayText,
			attachments: prepared.attachments,
		});
	}

	async abort(): Promise<void> {
		const session = this._getSession();
		if (this._role === "team-leader") {
			await this._teamManager?.abortActiveTurns();
			// Team abort is a runtime boundary: queued Leader steering/follow-up
			// messages belong to the invalidated epoch and must not run on resume.
			session.clearQueue();
		}
		await session.abort();
	}

	/** Manually retry the last failed turn (user-initiated, bypasses auto-retry setting). */
	async retry(): Promise<void> {
		if (this._role === "team-leader") {
			this._teamManager?.resumeRuntime("leader_retry");
		}
		await this._getSession().retryLastTurn();
	}

	async newSession(parentSession?: string): Promise<CommandResult> {
		const previousSessionFile = this._session?.sessionFile;
		const sessionDir = this._sessionManager?.getSessionDir();
		await this._closeCurrentSession("new");

		this._sessionManager = SessionManager.create(this._physicalCwd, sessionDir);
		if (parentSession) {
			this._sessionManager.newSession({ parentSession });
		}

		const result = await this._createSession(this._physicalCwd, this._sessionManager, {
			type: "session_start",
			reason: "new",
			previousSessionFile,
		});
		await this._activateSession(result.session);
		return { cancelled: false };
	}

	async switchSession(sessionPath: string): Promise<CommandResult> {
		const currentSessionManager = this._sessionManager;
		if (!currentSessionManager) {
			throw new Error("No active session.");
		}
		this._assertSessionPathInNamespace(sessionPath, currentSessionManager.getSessionDir());
		const previousSessionFile = this._session?.sessionFile;
		await this._closeCurrentSession("resume", sessionPath);

		this._sessionManager = SessionManager.open(sessionPath, currentSessionManager.getSessionDir(), this._physicalCwd);
		// switchSession only replaces the session manager; the context (and thus
		// _physicalCwd/_logicalCwd/backend) is immutable for the session lifetime.
		// A distro/cwd change requires stop + start (wsl_plan.md §4.8).
		const result = await this._createSession(this._physicalCwd, this._sessionManager, {
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
			const newSessionManager = SessionManager.create(this._physicalCwd, sessionDir);
			newSessionManager.newSession({ parentSession: currentSessionFile });
			await this._closeCurrentSession("fork");
			this._sessionManager = newSessionManager;

			const result = await this._createSession(this._physicalCwd, this._sessionManager, {
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

		const result = await this._createSession(this._physicalCwd, this._sessionManager, {
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
				thinkingLevelMap: m.model.thinkingLevelMap,
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
		if (this._readModelsProviderNames().has(provider)) {
			throw new Error("该 provider 的凭证请在「自定义模型」分区管理");
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
		if (this._readModelsProviderNames().has(provider)) {
			throw new Error("该 provider 的凭证请在「自定义模型」分区管理");
		}
		this._authStorage.remove(provider);
		const session = this._getSession();
		session.modelRegistry.refresh();
		this._applyEnabledModelScope(session);
	}

	/**
	 * Read models.json providers for the settings UI. Pure file read; does not
	 * require an active session. Each provider's plaintext apiKey is replaced
	 * with SENTINEL before crossing IPC (undefined when never set). Header
	 * VALUES (provider- and model-level) are likewise masked: any non-empty
	 * string becomes SENTINEL so plaintext tokens in headers like
	 * Authorization/x-api-key never reach the renderer. When a session is
	 * active, schemaError carries the registry's last load error. The disk read
	 * is serialized under the models.json lock so a concurrent setCustomProviders
	 * write cannot expose a half-written file.
	 */
	getCustomProviders(): { providers: Record<string, CustomProviderConfig>; schemaError?: string } {
		let providers: Record<string, CustomProviderConfig> = {};
		let schemaError: string | undefined;
		try {
			const src = this.withModelsLock(() => {
				const modelsPath = join(getAgentDir(), "models.json");
				if (!existsSync(modelsPath)) return {} as Record<string, CustomProviderConfig>;
				const raw = readFileSync(modelsPath, "utf-8");
				const parsed: unknown = JSON.parse(raw);
				return readModelsProviders(parsed);
			});
			for (const [name, provider] of Object.entries(src)) {
				const masked: CustomProviderConfig = { ...provider };
				if (typeof masked.apiKey === "string" && masked.apiKey !== "") {
					masked.apiKey = SENTINEL;
				} else {
					delete masked.apiKey;
				}
				masked.headers = maskHeaders(masked.headers);
				if (masked.models) {
					masked.models = masked.models.map((model) => ({
						...model,
						headers: maskHeaders(model.headers),
					}));
				}
				providers[name] = masked;
			}
		} catch (err) {
			providers = {};
			schemaError = `models.json 解析失败: ${err instanceof Error ? err.message : String(err)}`;
		}
		if (schemaError === undefined && this._session) {
			schemaError = this._session.modelRegistry.getError() ?? undefined;
		}
		return { providers, schemaError };
	}

	/**
	 * Write models.json providers from the settings UI. `providers` is wholly
	 * replaced by `incoming`; top-level non-providers fields are preserved.
	 * apiKey resolution: SENTINEL keeps the on-disk value, null clears the
	 * field, any other string becomes the new key. Header VALUES follow the
	 * same contract (SENTINEL keeps the on-disk value for that key, null/empty
	 * drops the key, other string is the new value), applied to provider-level
	 * and each model's headers. The read-modify-write is serialized under the
	 * models.json lock (mirrors auth-storage's acquireLockSyncWithRetry) so two
	 * writers cannot interleave. The write is atomic (temp file + rename,
	 * created mode 0600) and followed by chmod 0600. When a session is active
	 * the leader registry is refreshed and its schema error returned. Team
	 * workers hold independent registries that are NOT refreshed here, so
	 * workersStale is set when team mode is active to let the UI prompt a
	 * restart.
	 */
	setCustomProviders(incoming: Record<string, CustomProviderConfig>): {
		success: boolean;
		schemaError?: string;
		sessionActive: boolean;
		workersStale?: boolean;
		error?: string;
	} {
		const teamActive = this._role === "team-leader" && (this._teamManager?.hasActiveTeam() ?? false);
		try {
			this.withModelsLock(() => {
				const modelsPath = join(getAgentDir(), "models.json");
				// Read current disk state; preserve top-level non-providers fields.
				let diskData: Record<string, unknown> = {};
				if (existsSync(modelsPath)) {
					const raw = readFileSync(modelsPath, "utf-8");
					const parsed: unknown = JSON.parse(raw);
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
						diskData = parsed as Record<string, unknown>;
					}
				}
				const diskProviders = readModelsProviders(diskData);

				// providers are wholly replaced by incoming; resolve apiKey/headers per protocol.
				const merged: Record<string, CustomProviderConfig> = {};
				for (const [name, incomingProvider] of Object.entries(incoming)) {
					const resolved: CustomProviderConfig = { ...incomingProvider };
					// Normalize baseUrl: trim + strip trailing slashes (opencode trims only
					// trailing slashes; we also trim whitespace). Double-safety with the UI.
					if (typeof resolved.baseUrl === "string") {
						resolved.baseUrl = resolved.baseUrl.trim().replace(/\/+$/, "");
					}
					const incomingApiKey = (incomingProvider as { apiKey?: string | null }).apiKey;
					if (incomingApiKey === SENTINEL) {
						const diskApiKey = diskProviders[name]?.apiKey;
						if (typeof diskApiKey === "string" && diskApiKey !== "") {
							resolved.apiKey = diskApiKey;
						} else {
							delete resolved.apiKey;
						}
					} else if (incomingApiKey === null) {
						delete resolved.apiKey;
					} else if (typeof incomingApiKey === "string") {
						resolved.apiKey = incomingApiKey;
					} else {
						delete resolved.apiKey;
					}
					// Resolve provider-level headers (SENTINEL keeps on-disk, null/empty drops).
					const diskProvider = diskProviders[name];
					const resolvedHeaders = resolveHeaders(incomingProvider.headers, diskProvider?.headers);
					if (resolvedHeaders) {
						resolved.headers = resolvedHeaders;
					} else {
						delete resolved.headers;
					}
					// Resolve each model's headers against the matching on-disk model.
					if (resolved.models) {
						resolved.models = resolved.models.map((model) => {
							const diskModel = diskProvider?.models?.find((m) => m.id === model.id);
						const resolvedModel = { ...model };
						// The UI does not expose model-level headers; when the incoming model
						// carries none, preserve the on-disk headers instead of dropping them
						// (don't destroy data the UI cannot represent).
						const resolvedModelHeaders = model.headers
							? resolveHeaders(model.headers, diskModel?.headers)
							: diskModel?.headers;
							if (resolvedModelHeaders) {
								resolvedModel.headers = resolvedModelHeaders;
							} else {
								delete resolvedModel.headers;
							}
							return resolvedModel;
						});
					}
					merged[name] = resolved;
				}

				// Atomic write: temp file (mode 0600) -> rename -> chmod 0600.
				const output: Record<string, unknown> = { ...diskData, providers: merged };
				const json = JSON.stringify(output, null, 2);
				const tmpPath = `${modelsPath}.tmp`;
				try {
					writeFileSync(tmpPath, json, { encoding: "utf-8", mode: 0o600 });
					renameSync(tmpPath, modelsPath);
				} finally {
					// Clean up a leftover temp file if the rename failed; a no-op on
					// success (rename removes the source). Guard ENOENT for the race-free path.
					try {
						if (existsSync(tmpPath)) {
							unlinkSync(tmpPath);
						}
					} catch {
						// Best-effort cleanup; ignore if the file is already gone.
					}
				}
				try {
					chmodSync(modelsPath, 0o600);
				} catch {
					// chmod is best-effort (no-op on Windows; some filesystems reject it).
				}
			});

			let schemaError: string | undefined;
			let sessionActive: boolean;
			if (this._session) {
				this._session.modelRegistry.refresh();
				schemaError = this._session.modelRegistry.getError() ?? undefined;
				sessionActive = true;
			} else {
				sessionActive = false;
			}
			return { success: true, schemaError, sessionActive, workersStale: teamActive };
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
				sessionActive: this._session != null,
				workersStale: false,
			};
		}
	}

	/**
	 * Read the set of provider names defined in models.json. Used to block
	 * setApiKey/removeAuth from touching providers whose credentials must be
	 * managed in the custom-providers partition (prevents auth.json from
	 * silently overriding models.json apiKey, which would leak real keys to a
	 * proxy URL in the override-builtin-provider scenario). The read is taken
	 * under the models.json lock so a mid-write read cannot fail open (a
	 * half-written file would otherwise throw, the catch would return an empty
	 * set, and the auth guard would let auth.json override a models.json key).
	 */
	private _readModelsProviderNames(): Set<string> {
		try {
			return this.withModelsLock(() => {
				const modelsPath = join(getAgentDir(), "models.json");
				if (!existsSync(modelsPath)) return new Set<string>();
				const raw = readFileSync(modelsPath, "utf-8");
				const parsed: unknown = JSON.parse(raw);
				return new Set(Object.keys(readModelsProviders(parsed)));
			});
		} catch {
			return new Set();
		}
	}

	/**
	 * Serialize a critical section against the models.json lockfile. Mirrors
	 * auth-storage's acquireLockSyncWithRetry: lockSync with realpath:false,
	 * retry on ELOCKED, release in finally. Stays synchronous because every
	 * caller (getCustomProviders / setCustomProviders / _readModelsProviderNames)
	 * is itself a synchronous IPC handler. lockSync on a missing file only
	 * creates the .lock sidecar, so callers still own their existsSync branch.
	 */
	private withModelsLock<T>(fn: () => T): T {
		const modelsPath = join(getAgentDir(), "models.json");
		let release: (() => void) | undefined;
		try {
			release = this._acquireModelsLockSync(modelsPath);
			return fn();
		} finally {
			if (release) {
				try {
					release();
				} catch {
					// Ignore unlock errors (lock may have been compromised).
				}
			}
		}
	}

	private _acquireModelsLockSync(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire models.json lock");
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
				thinkingLevelMap: model.thinkingLevelMap,
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
			const processed = await processChatFiles(filePaths, this._physicalCwd, {
				autoResizeImages: session.settingsManager.getImageAutoResize(),
				// WSL: translate physical attachment paths to logical so the model
				// never sees UNC/drive letters; also skips macOS NFD probing.
				displayPath: this._executionContext?.executionBackend?.paths.displayPath,
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

	private _getSessionDir(cwd: string, defaultSessionDir: string | undefined): string | undefined {
		if (this._role === "single") return defaultSessionDir;
		const cwdHash = createHash("sha1").update(cwd).digest("hex");
		return join(getAgentDir(), "team-leader-sessions", cwdHash);
	}

	private _assertSessionPathInNamespace(sessionPath: string, sessionDir: string): void {
		const candidatePath = resolve(sessionPath);
		const namespacePath = resolve(sessionDir);
		const relativePath = relative(namespacePath, candidatePath);
		if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
			throw new Error("Session path is outside the active session namespace.");
		}
	}

	private async _createSession(
		cwd: string,
		sessionManager: SessionManager,
		sessionStartEvent: SessionStartEvent,
	): Promise<CreateAgentSessionResult> {
		const settingsManager = this._createSettingsManager(cwd);
		const context = this._executionContext;
		// WSL mode disables Windows-side stdio MCP (decided by context.isWsl, not
		// by backend existence). HTTP/SSE remain configurable (wsl_plan.md §4.10).
		const mcpAdapter = new McpAdapter({
			allowStdio: context?.isWsl ? false : true,
		});
		this._mcpAdapter = mcpAdapter;
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: getAgentDir(),
			settingsManager,
			extensionFactories: [
				(pi) => { mcpAdapter.register(pi); },
				(pi) => { this._teamManager?.registerLeaderTools(pi); },
			],
		});
		await resourceLoader.reload();

		const result = await createAgentSession({
			cwd,
			// bootstrap uses physical cwd (above); the Agent runtime uses the
			// logical cwd via runtimeCwd. When no context is injected these are
			// equal and Windows behavior is byte-identical (wsl_plan.md §4.1).
			runtimeCwd: this._logicalCwd || cwd,
			executionBackend: context?.executionBackend,
			runtimeEnvironmentOverride: context?.runtimeEnvironmentOverride,
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
		// Wire the Leader session to TeamManager so worker summaries can be injected
		if (this._teamManager) {
			this._teamManager.setLeaderSession(session);
		}
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
		this._teamManager?.setLeaderSession(null);
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

	/**
	 * Accept either a ProjectLocation or a legacy Windows path string. String
	 * inputs are treated as Windows projects (preserving existing callers in
	 * ipc-handlers until S9 migrates them to ProjectLocation).
	 */
	private _coerceLocation(location: ProjectLocation | string): ProjectLocation {
		if (typeof location === "string") {
			return {
				path: location,
				physicalPath: location,
				name: basename(location),
				environment: { kind: "windows" },
			};
		}
		return location;
	}

	/**
	 * Translate a session's stored cwd into the model-visible logical cwd.
	 * Stored cwd is physical; under WSL it is converted via the active backend's
	 * displayPath, or falls back to the location's logical path when no backend
	 * is active. Windows returns the path unchanged.
	 */
	private _toLogicalCwd(
		storedCwd: string | undefined,
		location: ProjectLocation,
		displayPath?: (physical: string) => string,
	): string {
		const physical = storedCwd || location.physicalPath;
		if (displayPath) return displayPath(physical);
		if (location.environment.kind === "wsl") return location.path;
		return physical;
	}

	private _assertProjectDirectory(location: ProjectLocation): void {
		const physicalPath = location.physicalPath;
		if (!physicalPath) {
			throw new Error("Project directory is required.");
		}
		// Check the host-visible physical path, but report the model-visible
		// logical path so WSL diagnostics never leak UNC/drive letters (§9.1).
		if (!existsSync(physicalPath)) {
			throw new Error(`Project directory does not exist: ${location.path}`);
		}
		if (!statSync(physicalPath).isDirectory()) {
			throw new Error(`Project path is not a directory: ${location.path}`);
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
