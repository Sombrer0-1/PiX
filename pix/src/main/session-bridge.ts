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
	type ToolResultMessage,
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
	type ToolDefinition,
	createAgentSession,
	SessionManager,
	SettingsManager,
	AuthStorage,
	DefaultResourceLoader,
	ModelRegistry,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { McpAdapter } from "pi-mcp-adapter";
import { aggregateSubagentUsage, isSubagentDetails } from "../shared/subagent-types.js";
import type { SubagentExecutionContext, SubagentToolHost } from "./subagent/types.js";
import { SHELL_BACKGROUND_TOOLS, SubagentRunner } from "./subagent/subagent-runner.js";
import { createSubagentToolDefinition, SUBAGENT_TOOL_NAME } from "./subagent/subagent-tool.js";
import { PlanController } from "./plan/plan-controller.js";
import type {
  PlanControllerContext,
  PlanDisposeReason,
  PlanLinkedTaskFileChangeEvent,
  PlanStepExecutionLink,
  PlanTaskLinkHydration,
  PlanUserRequest,
  StepDelegateResult,
} from "./plan/plan-controller.js";
import { detectFileDeviation, type PlanPathContext } from "./plan/plan-deviation.js";
import { createSubmitUserPlanTool, createUpdatePlanStepTool } from "./plan/plan-tools.js";
import type { AgentTaskDeliveryContent, AgentTaskService, AgentTaskSubmissionContext } from "./agent-task/agent-task-service.js";
import { workspaceIdOf } from "./agent-task/agent-task-identity.js";
import type { AgentTaskPlanLink } from "../shared/agent-task-types.js";
import type { PlanDeviation, PlanStep } from "../shared/plan-types.js";
import type { ProductEvent } from "../shared/product-events.js";
import type { ProductEventCollector } from "./product-event-collector.js";
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
	RequestUserInputDismissal,
	RequestUserInputDismissalReason,
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
	/** App-level anonymous product-event collector (1.4.0); injected by index.ts. */
	productEventCollector?: ProductEventCollector;
	/** App-level agent task service (1.4.1); injected by index.ts. */
	agentTaskService?: AgentTaskService;
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

/**
 * One queued/active/terminal user-input request in the bridge FIFO. Only the
 * queue head becomes active and is ever visible to the renderer; queued items
 * are invisible and never emit a dismissal.
 */
interface UserInputEntry {
	request: RequestUserInputRequest;
	/** Generation captured at enqueue; guards stale callbacks after replacement. */
	generation: number;
	signal: AbortSignal | undefined;
	state: "queued" | "active" | "terminal";
	resolve: (response: RequestUserInputResponse) => void;
	reject: (error: Error) => void;
	removeSignalListener: (() => void) | undefined;
}

/**
 * Solo-only runtime candidate generation. Created before the parent session,
 * owned by the bridge, never shared with extensions. `agentDir` is resolved
 * exactly once per generation and used uniformly for auth storage, the model
 * registry, the parent loader/session and the runner context; a replaced old
 * generation never reads a new value (design plan section 4.9).
 */
interface RuntimeGeneration {
	/** Non-reusable generation id; parent and runner closures both capture it. */
	readonly genId: number;
	readonly agentDir: string;
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	/** Generation-bound auxiliary accumulator (history rebuild + live usage). */
	readonly auxiliaryUsage: AuxiliaryUsageTotals;
	/** Parent session of this generation; closed over by getParentRuntime. */
	session: AgentSession | null;
	readonly runner: SubagentRunner;
	readonly mcpAdapter: McpAdapter;
	/** Solo Plan state machine of this generation (PiX 1.4.0). */
	readonly planController: PlanController;
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
	private _productEventCollector: ProductEventCollector | undefined;
	/** App-level agent task service (1.4.1); owned by index.ts, borrowed. */
	private _agentTaskService: AgentTaskService | undefined;
	/** First activate in this process is app_restart; later session switches are session_reopen. */
	private _planTaskLinkHydration: PlanTaskLinkHydration = "app_restart";
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
	private _userInputDismissedListeners: Array<(event: RequestUserInputDismissal) => void> = [];
	private _userInputQueue: UserInputEntry[] = [];
	private _activeUserInputEntry: UserInputEntry | null = null;
	private _userInputQueueClosing = false;
	/** Monotonic, non-reusable user-input generation counter. */
	private _userInputGeneration = 0;
	/** Solo runtime generation (registry/agentDir/runner/accumulator ownership). */
	private _generation: RuntimeGeneration | null = null;
	private _lifecycleListeners: {
		[TEvent in LifecycleEvent]: Array<LifecycleListener<TEvent>>;
	} = {
		ready: [],
		exit: [],
		error: [],
	};

	private _isCompacting = false;
	private _pendingMessageCount = 0;
	/** Per-session once-flag for the collector's valid-Solo-session baseline. */
	private _validSoloSessionRecorded = false;
	/**
	 * 1.4.2 (R4): whole-app shutdown flag set by index.ts cleanup only. A
	 * "quit" close is an app_shutdown ONLY when this is set; stop-pi / project
	 * switch (start) / team-mode switch keep session_close semantics so
	 * task-linked waiting steps survive as waiting_input+paused while the app
	 * level task service keeps running them.
	 */
	private _appShuttingDown = false;
	/** Unsubscribe of the active Solo session's delivery sink (1.4.2). */
	private _deliverySinkUnsubscribe: (() => void) | null = null;

	constructor(options: SessionBridgeOptions = {}) {
		this._role = options.role ?? "single";
		this._teamManager = this._role === "team-leader" ? options.teamManager ?? null : null;
		this._productEventCollector = options.productEventCollector;
		this._agentTaskService = options.agentTaskService;
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

	/**
	 * 1.4.2 (R4): mark the bridge for whole-app shutdown (index.ts cleanup).
	 * Only this path maps a "quit" close to PlanDisposeReason app_shutdown;
	 * user-initiated stops (stop-pi / project switch / team-mode switch) stay
	 * session_close so task-linked waiting steps keep waiting_input+paused.
	 */
	markAppShuttingDown(): void {
		this._appShuttingDown = true;
	}

	/** Solo Plan controller of the current generation (null for team-leader). */
	getPlanController(): PlanController | null {
		return this._generation?.planController ?? null;
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
		if (typeof text === "string" && text.trim() !== "") {
			this._recordValidSoloSessionOnce();
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
				const session = this._session;
				session.modelRegistry.refresh();
				const currentModel = session.model;
				if (currentModel) {
					const refreshedModel = session.modelRegistry.find(currentModel.provider, currentModel.id);
					if (refreshedModel) {
						session.agent.state.model = refreshedModel;
					}
				}
				this._applyEnabledModelScope(session);
				schemaError = session.modelRegistry.getError() ?? undefined;
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

	onUserInputDismissed(listener: (event: RequestUserInputDismissal) => void): () => void {
		this._userInputDismissedListeners.push(listener);
		return () => {
			const idx = this._userInputDismissedListeners.indexOf(listener);
			if (idx !== -1) this._userInputDismissedListeners.splice(idx, 1);
		};
	}

	/**
	 * Return the active request as a plain defensive snapshot; null when no
	 * request is active. Queued items are never visible to the renderer.
	 */
	getActiveUserInputRequest(): RequestUserInputRequest | null {
		const active = this._activeUserInputEntry;
		if (!active || active.state !== "active" || active.generation !== this._userInputGeneration) {
			return null;
		}
		return {
			id: active.request.id,
			questions: active.request.questions.map((question) => ({
				id: question.id,
				header: question.header,
				question: question.question,
				options: question.options?.map((option) => ({ ...option })),
			})),
		};
	}

	/**
	 * Settle the current generation's active request. Returns true when the id
	 * matches the active request, removing the signal listener, resolving the
	 * promise and then pumping the queue. A response never emits a dismissal.
	 * Late/unknown ids return false as a normal race outcome - never an error.
	 */
	respondUserInput(response: RequestUserInputResponse): boolean {
		const active = this._activeUserInputEntry;
		if (
			!active ||
			active.state !== "active" ||
			active.request.id !== response.id ||
			active.generation !== this._userInputGeneration
		) {
			return false;
		}
		active.state = "terminal";
		active.removeSignalListener?.();
		active.removeSignalListener = undefined;
		this._activeUserInputEntry = null;
		active.resolve(response);
		this._pumpUserInputQueue();
		return true;
	}

	private _getSession(): AgentSession {
		if (!this._session) {
			throw new Error("Session not started. Call start() first.");
		}
		return this._session;
	}

	/**
	 * Enqueue a user-input request into the bridge FIFO (parent, project trust
	 * and nested tool approval all share this queue). The generation captured
	 * at enqueue time guards stale callbacks: a provider calling back after the
	 * generation was replaced is rejected without any request/dismissal emit.
	 * The same immediate rejection applies while the queue is closing, when the
	 * signal is already aborted, or when the id duplicates an active/queued
	 * item.
	 */
	private _requestUserInputForGeneration(
		generation: number,
		request: RequestUserInputRequest,
		signal?: AbortSignal,
	): Promise<RequestUserInputResponse> {
		return new Promise((resolve, reject) => {
			if (generation !== this._userInputGeneration) {
				reject(new Error("request_user_input was aborted."));
				return;
			}
			if (this._userInputQueueClosing) {
				reject(new Error("Session closed before user input was provided."));
				return;
			}
			if (signal?.aborted) {
				reject(new Error("request_user_input was aborted."));
				return;
			}
			if (this._hasUserInputId(request.id)) {
				reject(new Error(`Duplicate user input request id: ${request.id}`));
				return;
			}

			const entry: UserInputEntry = {
				request,
				generation,
				signal,
				state: "queued",
				resolve,
				reject,
				removeSignalListener: undefined,
			};
			// Observe the signal from enqueue time: a queued abort removes and
			// rejects only itself (never displayed, so no dismissal); an active
			// abort dismisses exactly once and pumps the next request.
			if (signal && !signal.aborted) {
				const onAbort = () => {
					if (entry.state === "queued") {
						this._removeQueuedUserInput(entry);
						entry.state = "terminal";
						entry.reject(new Error("request_user_input was aborted."));
					} else if (entry.state === "active") {
						this._abortActiveUserInput(this._userInputQueueClosing ? "session_closed" : "aborted");
					}
				};
				signal.addEventListener("abort", onAbort, { once: true });
				entry.removeSignalListener = () => signal.removeEventListener("abort", onAbort);
			}
			this._userInputQueue.push(entry);
			this._pumpUserInputQueue();
		});
	}

	private _hasUserInputId(id: string): boolean {
		if (this._activeUserInputEntry?.request.id === id) {
			return true;
		}
		return this._userInputQueue.some((entry) => entry.request.id === id);
	}

	private _removeQueuedUserInput(entry: UserInputEntry): void {
		const index = this._userInputQueue.indexOf(entry);
		if (index !== -1) {
			this._userInputQueue.splice(index, 1);
		}
	}

	/** Promote the queue head to active and emit its request (never queued items). */
	private _pumpUserInputQueue(): void {
		if (this._userInputQueueClosing || this._activeUserInputEntry) {
			return;
		}
		const entry = this._userInputQueue.shift();
		if (!entry) {
			return;
		}
		if (entry.state !== "queued" || entry.generation !== this._userInputGeneration) {
			// Defensive: an entry aborted while queued or belonging to a stale
			// generation must never reach the renderer; it gets no dismissal.
			if (entry.state === "queued") {
				entry.state = "terminal";
				entry.removeSignalListener?.();
				entry.removeSignalListener = undefined;
				entry.reject(new Error("request_user_input was aborted."));
			}
			this._pumpUserInputQueue();
			return;
		}
		entry.state = "active";
		this._activeUserInputEntry = entry;
		for (const listener of this._userInputRequestListeners) {
			try {
				listener(entry.request);
			} catch (err) {
				console.error("[SessionBridge] User input request listener error:", err);
			}
		}
	}

	/**
	 * Active signal abort: mark terminal, emit the dismissal exactly once,
	 * reject, then pump the next request. After the queue is marked closing the
	 * dismissal is "session_closed" so a close-driven abort is never misjudged
	 * as a user denial.
	 */
	private _abortActiveUserInput(reason: RequestUserInputDismissalReason): void {
		const active = this._activeUserInputEntry;
		if (!active || active.state !== "active") {
			return;
		}
		this._settleUserInputTerminal(active, reason, new Error("request_user_input was aborted."));
		this._pumpUserInputQueue();
	}

	/** Terminal settle of a displayed request: exactly-once dismissal + reject. */
	private _settleUserInputTerminal(
		entry: UserInputEntry,
		reason: RequestUserInputDismissalReason,
		error: Error,
	): void {
		if (entry.state === "terminal") {
			return;
		}
		entry.state = "terminal";
		entry.removeSignalListener?.();
		entry.removeSignalListener = undefined;
		if (this._activeUserInputEntry === entry) {
			this._activeUserInputEntry = null;
		}
		this._emitUserInputDismissal(entry.request.id, reason);
		entry.reject(error);
	}

	/** Mark the queue closing and invalidate the current generation. */
	private _markUserInputQueueClosing(): void {
		this._userInputQueueClosing = true;
		this._userInputGeneration++;
	}

	/**
	 * Settle every pending entry after the queue is marked closing: the
	 * displayed request gets an exactly-once "session_closed" dismissal, queued
	 * requests are rejected without a dismissal (they were never displayed).
	 * Never pumps afterwards; only a new generation reopens the queue.
	 */
	private _settleClosedUserInputQueue(): void {
		const active = this._activeUserInputEntry;
		if (active && active.state === "active") {
			this._settleUserInputTerminal(
				active,
				"session_closed",
				new Error("Session closed before user input was provided."),
			);
		}
		const queued = this._userInputQueue.splice(0);
		for (const entry of queued) {
			if (entry.state === "queued") {
				entry.state = "terminal";
				entry.removeSignalListener?.();
				entry.removeSignalListener = undefined;
				entry.reject(new Error("Session closed before user input was provided."));
			}
		}
	}

	private _emitUserInputDismissal(id: string, reason: RequestUserInputDismissalReason): void {
		const event: RequestUserInputDismissal = { id, reason };
		for (const listener of this._userInputDismissedListeners) {
			try {
				listener(event);
			} catch (err) {
				console.error("[SessionBridge] User input dismissal listener error:", err);
			}
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
		const isSolo = this._role === "single";
		// Resolved exactly once per candidate generation and used uniformly for
		// auth storage, model registry, loader, parent session and runner
		// context; a replaced old generation never reads a new value (4.9).
		const agentDir = getAgentDir();
		// WSL mode disables Windows-side stdio MCP (decided by context.isWsl, not
		// by backend existence). HTTP/SSE remain configurable (wsl_plan.md §4.10).
		const mcpAdapter = new McpAdapter({
			allowStdio: context?.isWsl ? false : true,
		});
		this._mcpAdapter = mcpAdapter;

		// Each candidate parent session gets a non-reusable generation. Both the
		// parent createAgentSession requestUserInput closure and the runner's
		// closure capture this value; a stale provider callback after a
		// replacement is rejected by the generation guard. The new generation
		// reopens the queue.
		const genId = ++this._userInputGeneration;
		this._userInputQueueClosing = false;

		let parentSessionRef: AgentSession | null = null;
		try {
			if (isSolo) {
				// Solo runtime: the generation owns its auth storage and model
				// registry; the SAME registry identity is later handed to the
				// parent createAgentSession and the runner (the parent must
				// never get an SDK-created second registry).
				const generationAuthStorage = AuthStorage.create(join(agentDir, "auth.json"));
				this._authStorage = generationAuthStorage;
				const generationModelRegistry = ModelRegistry.create(generationAuthStorage, join(agentDir, "models.json"));

				const resourceLoader = new DefaultResourceLoader({
					cwd,
					agentDir,
					settingsManager,
					extensionFactories: [
						(pi) => { mcpAdapter.register(pi); },
						(pi) => { this._teamManager?.registerLeaderTools(pi); },
					],
				});
				await resourceLoader.reload();

				// Construct the runner/host BEFORE creating the parent session;
				// the SDK custom tool is mounted as one entry of customTools.
				// SDK custom tools are written after extension tools in
				// AgentSession._refreshToolRegistry(), so the effective parent
				// agent is deterministically <sdk:agent> (design plan 4.8).
				const auxiliaryAccumulator = createEmptyAuxiliaryUsage();
				const runnerContext: SubagentExecutionContext = {
					physicalCwd: cwd,
					logicalCwd: this._logicalCwd || cwd,
					agentDir,
					executionBackend: context?.executionBackend,
					runtimeEnvironmentOverride: context?.runtimeEnvironmentOverride,
					authStorage: generationAuthStorage,
					modelRegistry: generationModelRegistry,
					isWsl: context?.isWsl ?? false,
					getLoadedAgents: () => resourceLoader.getAgents?.(),
					getParentRuntime: () => {
						// Closes over this candidate generation's own parent
						// session; a stale runner's late calls must never
						// inherit a replacement session's state.
						const parent = parentSessionRef;
						return {
							model: parent?.model,
							thinkingLevel: parent?.thinkingLevel ?? "off",
							executionMode: parent?.settingsManager.getExecutionMode() ?? "approval",
							verificationGate: parent?.settingsManager.getVerificationGateEnabled() ?? false,
						};
					},
					requestUserInput: (request, signal) => this._requestUserInputForGeneration(genId, request, signal),
					recordAuxiliaryUsage: (usage) => {
						// Generation-bound accumulator: old generations never
						// write usage into a replacement session through the
						// replaceable _auxiliaryUsage field.
						auxiliaryAccumulator.input += usage.input;
						auxiliaryAccumulator.output += usage.output;
						auxiliaryAccumulator.cacheRead += usage.cacheRead;
						auxiliaryAccumulator.cacheWrite += usage.cacheWrite;
						auxiliaryAccumulator.cost += usage.cost;
					},
					// 1.4.1 service facade surface: the app-level service and the
					// synchronous submission-context pieces (lazy session id so a
					// stale runner's late calls never read a replacement parent).
					getTaskService: () => this._agentTaskService,
					getSessionId: () => parentSessionRef?.sessionId ?? "",
					getProjectLocation: () => this._planExecutionContext().location,
				};
				const runner = new SubagentRunner(runnerContext);
				const host: SubagentToolHost = {
					getRunner: () => runner,
					getTaskService: () => this._agentTaskService!,
					getSubmissionContext: (toolCallId: string) => runner.assembleSubmissionContext(toolCallId),
				};

				// Solo Plan state machine (PiX 1.4.0). Created before the parent
				// session so its tools can be mounted; the session reference is
				// resolved lazily via parentSessionRef (set right after
				// createAgentSession). The planning-model resolution reads the
				// configured planModel setting and falls back to the current
				// session model; useSessionModelAndRetry uses the controller's
				// frozen first-enter snapshot instead.
				const planController = new PlanController({
					getSession: () => parentSessionRef!,
					getSessionManager: () => this._sessionManager!,
					getProjectLocation: () => this._planExecutionContext().location,
					getExecutionContext: () => this._planExecutionContext(),
					getExecutionMode: () => parentSessionRef?.settingsManager.getExecutionMode() ?? "approval",
					resolvePlanningModel: () => {
						const cfg = this._guiSettings?.planModel;
						const session = parentSessionRef;
						if (cfg) {
							if (!session) return { error: "no active session" };
							const model = session.modelRegistry.find(cfg.provider, cfg.modelId);
							if (!model) {
								return { error: `plan model not found: ${cfg.provider}/${cfg.modelId}` };
							}
							if (!session.modelRegistry.hasConfiguredAuth(model)) {
								return { error: `no configured credentials for ${cfg.provider}/${cfg.modelId}` };
							}
							return { model, thinkingLevel: this._guiSettings?.planThinkingLevel ?? session.thinkingLevel };
						}
						if (!session) return { error: "no active session" };
						const model = session.model;
						if (!model) return { error: "the session has no active model" };
						return { model, thinkingLevel: session.thinkingLevel };
					},
					promptPlanningRequest: async (request: PlanUserRequest) => {
						this._recordValidSoloSessionOnce();
						const prepared = await this._preparePromptInput(request.text, request.filePaths, request.images);
						const session = parentSessionRef;
						if (!session) throw new Error("No active session.");
						await session.prompt(prepared.text, {
							images: prepared.images,
							displayText: prepared.displayText,
							attachments: prepared.attachments,
						});
					},
					requestUserInput: (request, signal) => this._requestUserInputForGeneration(genId, request, signal),
					recordProductEvent: (e: ProductEvent) => {
						this._productEventCollector?.record(e);
					},
					delegateSubagentStep: (step, link, presentation) => this._delegatePlanStep(step, link, presentation),
					// 1.4.1 Plan-linked background task surface (SessionBridge adapter).
					subscribePlanLinkedTaskEvents: (listener) => this._subscribePlanLinkedTaskEvents(listener),
					getPlanTaskGroupResult: async (groupId, link) => {
						const service = this._agentTaskService;
						if (!service) {
							return { ok: false, reason: "task_service_unavailable" };
						}
						return service.getPlanTaskGroupResult(groupId, link);
					},
					confirmPlanTaskGroupConsumed: async (groupId, link) => {
						const service = this._agentTaskService;
						if (!service) {
							return;
						}
						await service.confirmPlanTaskGroupConsumed(groupId, link);
					},
					releasePlanTaskGroup: async (groupId, link, reason) => {
						const service = this._agentTaskService;
						if (!service) {
							return;
						}
						await service.releasePlanTaskGroup(groupId, link, reason);
					},
				});
				const generation: RuntimeGeneration = {
					genId,
					agentDir,
					authStorage: generationAuthStorage,
					modelRegistry: generationModelRegistry,
					auxiliaryUsage: auxiliaryAccumulator,
					session: null,
					runner,
					mcpAdapter,
					planController,
				};
				this._generation = generation;

				const result = await createAgentSession({
					cwd,
					// bootstrap uses physical cwd (above); the Agent runtime uses the
					// logical cwd via runtimeCwd. When no context is injected these are
					// equal and Windows behavior is byte-identical (wsl_plan.md §4.1).
					runtimeCwd: this._logicalCwd || cwd,
					agentDir,
					executionBackend: context?.executionBackend,
					runtimeEnvironmentOverride: context?.runtimeEnvironmentOverride,
					sessionManager,
					settingsManager,
					resourceLoader,
					authStorage: generationAuthStorage,
					modelRegistry: generationModelRegistry,
					// 1.4.1 WSL Shell tool isolation: the parent SessionBridge
					// denylists run_background/read_output/stop_process under WSL
					// (Windows keeps them available); WSL AgentTaskRuntime nested
					// sessions apply the same denylist.
					excludeTools: context?.isWsl === true ? [...SHELL_BACKGROUND_TOOLS] : undefined,
					// The typed cast only widens the generic parameters; the tool
					// definition itself is a full ToolDefinition.
					customTools: [
						createSubagentToolDefinition(host) as ToolDefinition,
						createSubmitUserPlanTool({ controller: planController }) as ToolDefinition,
						createUpdatePlanStepTool({ controller: planController }) as ToolDefinition,
					],
					// Authoritative host tool policy during planning/revising;
					// survives extension reloads (PiX 1.4.0 F1).
					hostToolPolicyOverride: (input) => planController.decideToolPolicy(input),
					sessionStartEvent,
					requestUserInput: (request, signal) => this._requestUserInputForGeneration(genId, request, signal),
				});
				parentSessionRef = result.session;
				generation.session = result.session;
				this._applyEnabledModelScope(result.session);
				return result;
			}

			// Team-leader: no subagent ModelRegistry/runner/custom tool; the
			// existing path stays unchanged (only the user-input closure now
			// binds the generation for the shared FIFO/dismissal lifecycle).
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				extensionFactories: [
					(pi) => { mcpAdapter.register(pi); },
					(pi) => { this._teamManager?.registerLeaderTools(pi); },
				],
			});
			await resourceLoader.reload();

			const result = await createAgentSession({
				cwd,
				runtimeCwd: this._logicalCwd || cwd,
				executionBackend: context?.executionBackend,
				runtimeEnvironmentOverride: context?.runtimeEnvironmentOverride,
				sessionManager,
				settingsManager,
				resourceLoader,
				authStorage: this._authStorage ?? undefined,
				// 1.4.1 WSL Shell tool isolation applies to the leader session too.
				excludeTools: context?.isWsl === true ? [...SHELL_BACKGROUND_TOOLS] : undefined,
				sessionStartEvent,
				requestUserInput: (request, signal) => this._requestUserInputForGeneration(genId, request, signal),
			});
			// Team-leader keeps no generation record; retain the created session
			// in the candidate ref so a later bind/activate failure still
			// disposes it (design plan 4.9).
			parentSessionRef = result.session;
			this._applyEnabledModelScope(result.session);
			return result;
		} catch (err) {
			// Candidate create failure: dispose the created runner/session/MCP,
			// close this generation's input queue and clear bridge fields -
			// not just null the references (design plan 4.9).
			await this._disposeCandidateRuntime(parentSessionRef);
			throw err;
		}
	}

	/**
	 * Dispose the candidate runtime after a create/bind/activate failure: close
	 * this generation's input queue first (marks closing + invalidates the
	 * generation), then dispose runner, session and MCP, and clear the bridge
	 * fields. candidateSession is the team-leader candidate, which keeps no
	 * generation record; it is skipped when identical to the generation's own
	 * session so solo behavior is unchanged.
	 */
	private async _disposeCandidateRuntime(candidateSession?: AgentSession | null): Promise<void> {
		const generation = this._generation;
		this._generation = null;
		this._markUserInputQueueClosing();
		this._settleClosedUserInputQueue();
		if (generation) {
			try {
				await generation.planController.dispose("host_disposed");
			} catch (err) {
				console.error("[SessionBridge] Error during plan controller dispose:", err);
			}
			try {
				await generation.runner.dispose();
			} catch (err) {
				console.error("[SessionBridge] Error during subagent runner dispose:", err);
			}
			if (generation.session) {
				try {
					await generation.session.dispose();
				} catch (err) {
					console.error("[SessionBridge] Error during candidate session dispose:", err);
				}
			}
		}
		if (candidateSession && candidateSession !== generation?.session) {
			try {
				await candidateSession.dispose();
			} catch (err) {
				console.error("[SessionBridge] Error during candidate session dispose:", err);
			}
		}
		const mcpAdapter = generation?.mcpAdapter ?? this._mcpAdapter;
		if (mcpAdapter) {
			try {
				await mcpAdapter.dispose();
			} catch (err) {
				console.error("[SessionBridge] Error during candidate MCP adapter dispose:", err);
			}
		}
		this._mcpAdapter = null;
		this._authStorage = null;
	}

	private async _activateSession(session: AgentSession): Promise<void> {
		this._session = session;
		this._setupEventSubscription(session);
		// 1.4.2 (R4): the active Solo session becomes the delivery sink for
		// send_to_session (design plan §4.5); closed on _closeCurrentSession.
		this._registerDeliverySink(session);
		try {
			await this._bindExtensions();
		} catch (err) {
			// Activation (bind) failure: dispose the created runner/session/MCP,
			// close this generation's input queue and clear bridge fields.
			this._session = null;
			this._unsubscribe?.();
			this._unsubscribe = null;
			await this._disposeCandidateRuntime(session);
			throw err;
		}
		// Wire the Leader session to TeamManager so worker summaries can be injected
		if (this._teamManager) {
			this._teamManager.setLeaderSession(session);
		}
		// The stats reference points at this generation's accumulator so history
		// rebuild and live usage of the same generation write the same object.
		this._auxiliaryUsage = this._generation?.auxiliaryUsage ?? createEmptyAuxiliaryUsage();
		this._rebuildAuxiliaryUsageFromHistory(session);
		// Plan rebuild: the controller hydrates the persisted snapshot of the
		// current branch (dormant planning/revising + A8 executing normalization
		// + 1.4.1 task-link intent replay/confirm).
		if (this._generation) {
			await this._generation.planController.restoreFromHistory(session.sessionManager.getEntries(), {
				taskLinkHydration: this._planTaskLinkHydration,
			});
			this._planTaskLinkHydration = "session_reopen";
		}
		this._emitLifecycle("ready");
	}

	/**
	 * Plan delegation adapter (PiX 1.4.1): the subagent step's self-contained
	 * prompt is built from the step contract and submitted to the app-level
	 * AgentTaskService with the explicit PlanStepExecutionLink (never a guessed
	 * project agent, never a second model call, never inferred from the
	 * prompt). The adapter forces runInBackground from the controller's
	 * executionTarget; the parent model never assembles the parameter itself.
	 * Observable nested file changes run through detectFileDeviation bound to
	 * the current link; deviations travel with the StepDelegateResult back to
	 * the controller.
	 */
	private async _delegatePlanStep(
		step: PlanStep,
		link: PlanStepExecutionLink,
		presentation: "foreground" | "background",
	): Promise<StepDelegateResult> {
		const service = this._agentTaskService;
		const generation = this._generation;
		if (!service || !generation) {
			return {
				stepId: step.stepId,
				status: "failed",
				summary: "The agent task service is not available; the step cannot be delegated.",
			};
		}
		const execution = this._planExecutionContext();
		const pathContext: PlanPathContext = {
			logicalCwd: execution.logicalCwd,
			isWsl: execution.isWsl,
			executionBackend: execution.executionBackend,
		};
		const planLink: AgentTaskPlanLink = { planId: link.planId, version: link.version, stepId: link.stepId };
		const prompt = this._buildPlanStepPrompt(step, link);
		const context = generation.runner.assembleSubmissionContext(`plan-step-${link.planId}-${link.stepId}`);
		const group = await service.createTaskGroup(
			{
				mode: "single",
				agentScope: "user",
				tasks: [{ subagent_type: "general-purpose", prompt, description: step.title }],
				runInBackground: presentation === "background",
				planLink,
			},
			context,
			presentation,
			undefined,
		);
		if (presentation === "background") {
			// Minimal link only: the Plan layer never depends on AgentTask UI types.
			return {
				stepId: step.stepId,
				status: "backgrounded",
				groupId: group.groupId,
				taskIds: group.tasks.map((task) => task.taskId),
			};
		}
		const deviations: PlanDeviation[] = [];
		const detectionPromises: Array<Promise<void>> = [];
		const taskIds = new Set(group.tasks.map((task) => task.taskId));
		const unsubscribe = service.onEvent((event) => {
			if (event.type !== "task_file_change" || !taskIds.has(event.taskId)) {
				return;
			}
			detectionPromises.push(
				detectFileDeviation(event.change, step, pathContext)
					.then((deviation) => {
						if (deviation) {
							deviations.push(deviation);
						}
					})
					.catch(() => {
						// Deviation detection is best-effort; a failed probe never
						// fails the delegation.
					}),
			);
		});
		try {
			const awaited = await service.awaitGroup(group.groupId);
			if (awaited.kind === "backgrounded") {
				// The foreground group detached while awaiting (manual/auto
				// background): surface the group handle to the controller.
				return {
					stepId: step.stepId,
					status: "backgrounded",
					groupId: awaited.handle.groupId,
					taskIds: awaited.handle.tasks.map((task) => task.taskId),
				};
			}
			await Promise.allSettled(detectionPromises);
			const result = awaited.details.results[0];
			if (result?.status === "completed") {
				return {
					stepId: step.stepId,
					status: "result",
					summary: result.finalOutput !== "" ? result.finalOutput : "The subagent completed without producing text.",
					deviations,
					groupId: group.groupId,
				};
			}
			return {
				stepId: step.stepId,
				status: "failed",
				summary: result?.errorMessage ?? result?.finalOutput ?? "The subagent failed.",
				deviations,
				groupId: group.groupId,
			};
		} finally {
			unsubscribe();
		}
	}

	/**
	 * 1.4.1 Plan-linked task file-change subscription adapter: forwards the
	 * service's main-only task_file_change events carrying a planLink to the
	 * PlanController for background-step deviation detection.
	 */
	private _subscribePlanLinkedTaskEvents(listener: (event: PlanLinkedTaskFileChangeEvent) => void): () => void {
		const service = this._agentTaskService;
		if (!service) {
			return () => {};
		}
		return service.onEvent((event) => {
			if (event.type !== "task_file_change" || !event.planLink) {
				return;
			}
			listener({
				taskId: event.taskId,
				planId: event.planLink.planId,
				version: event.planLink.version,
				stepId: event.planLink.stepId,
				change: event.change,
				aggregate: event.aggregate,
			});
		});
	}

	/**
	 * 1.4.2 (R4): register the active Solo session as the result delivery sink
	 * (design plan §4.5: "当前打开的 Solo SessionBridge 按 sessionId+workspaceId
	 * 注册 sink"). The sink injects the structured result as a custom message
	 * with triggerTurn:false; the target must still be this open session AND
	 * idle - it never steers/follows-up/triggers a model turn. A busy or
	 * vanished session surfaces target_session_busy / target_session_not_open
	 * through the sendResultToSession envelope.
	 */
	private _registerDeliverySink(session: AgentSession): void {
		const service = this._agentTaskService;
		if (!service || this._role !== "single") {
			return;
		}
		this._deliverySinkUnsubscribe?.();
		this._deliverySinkUnsubscribe = null;
		const sessionId = session.sessionId;
		const workspaceId = workspaceIdOf(this._planExecutionContext().location.physicalPath);
		this._deliverySinkUnsubscribe = service.registerSessionDeliverySink(
			sessionId,
			workspaceId,
			async (content) => {
				const current = this._session;
				if (!current || current.sessionId !== sessionId) {
					throw new Error("target_session_not_open");
				}
				if (current.isStreaming) {
					throw new Error("target_session_busy");
				}
				await current.sendCustomMessage(
					{
						customType: "pix-agent-task-result",
						content: this._formatDeliveryContent(content),
						display: true,
					},
					{ triggerTurn: false },
				);
			},
		);
	}

	/** Human-readable chat text for one delivered task result. */
	private _formatDeliveryContent(content: AgentTaskDeliveryContent): string {
		const lines: string[] = [];
		lines.push(`Agent task ${content.taskId} finished.`);
		if (content.planLink) {
			lines.push(`Plan step ${content.planLink.stepId} (plan ${content.planLink.planId}, version ${content.planLink.version}).`);
		}
		if (content.summary !== "") {
			lines.push(content.summary);
		}
		if (content.finalOutput !== "") {
			lines.push(content.finalOutput);
		}
		return lines.join("\n");
	}

	/** Self-contained single-task prompt for a delegated plan step. */
	private _buildPlanStepPrompt(step: PlanStep, link: PlanStepExecutionLink): string {
		const lines: string[] = [];
		lines.push(`<plan_step_execution plan_id="${link.planId}" version="${link.version}" step_id="${link.stepId}">`);
		lines.push(`Title: ${step.title}`);
		lines.push(`Description: ${step.description}`);
		if (step.scopeNote) {
			lines.push(`Scope note: ${step.scopeNote}`);
		}
		if (step.files.length > 0) {
			lines.push(
				`Declared files (workspace-relative; work only inside this scope): ${step.files
					.map((file) => `${file.path} (${file.operation})`)
					.join(", ")}`,
			);
		}
		if (step.expectedCommands && step.expectedCommands.length > 0) {
			lines.push(`Expected commands: ${step.expectedCommands.join(" | ")}`);
		}
		lines.push(`Verification required: ${step.verification}`);
		lines.push(`Risk: ${step.risk} - ${step.riskReason}`);
		lines.push("Work only within the declared scope. Report what you changed and how it was verified.");
		lines.push("</plan_step_execution>");
		return lines.join("\n");
	}

	/** Execution context with a defensive fallback for the Plan validation surface. */
	private _planExecutionContext(): ProjectExecutionContext {
		return this._executionContext ?? {
			location: this._coerceLocation(this._physicalCwd),
			logicalCwd: this._logicalCwd || this._physicalCwd,
			physicalCwd: this._physicalCwd,
			isWsl: false,
		};
	}

	/** Count each Solo session once for the valid-sessions baseline (content never recorded). */
	private _recordValidSoloSessionOnce(): void {
		if (this._validSoloSessionRecorded) {
			return;
		}
		this._validSoloSessionRecorded = true;
		this._productEventCollector?.recordValidSoloSession();
	}

	/**
	 * Rebuild subagent usage for a resumed parent session by scanning persisted
	 * agent tool result messages. Only messages that pass the shared type guard
	 * are aggregated; live terminal tasks keep reporting through the runner.
	 * Both write the same generation-bound accumulator.
	 */
	private _rebuildAuxiliaryUsageFromHistory(session: AgentSession): void {
		const accumulator = this._generation?.auxiliaryUsage;
		if (!accumulator) {
			return;
		}
		for (const message of session.messages) {
			if (message.role !== "toolResult") {
				continue;
			}
			const toolMessage = message as ToolResultMessage;
			if (toolMessage.toolName !== SUBAGENT_TOOL_NAME || !isSubagentDetails(toolMessage.details)) {
				continue;
			}
			const usage = aggregateSubagentUsage(toolMessage.details);
			accumulator.input += usage.input;
			accumulator.output += usage.output;
			accumulator.cacheRead += usage.cacheRead;
			accumulator.cacheWrite += usage.cacheWrite;
			accumulator.cost += usage.cost;
		}
	}

	private async _closeCurrentSession(
		reason: SessionShutdownEvent["reason"],
		targetSessionFile?: string,
	): Promise<boolean> {
		const session = this._session;
		const mcpAdapter = this._mcpAdapter;
		const generation = this._generation;
		this._generation = null;
		// 1.4.2 (R4): unregister the delivery sink FIRST so an in-flight
		// send_to_session never injects into a closing session; the result
		// stays in the panel (design plan §5.4).
		this._deliverySinkUnsubscribe?.();
		this._deliverySinkUnsubscribe = null;
		// 1.4.1 session switch/close: detach this session's still-foreground
		// groups FIRST (they continue in the app service as backgrounded and
		// the facade's parent-signal listeners are removed), so the parent
		// signal below never misclassifies a session switch as user_cancel.
		if (this._agentTaskService && session) {
			try {
				this._agentTaskService.detachForegroundGroupsForSession(session.sessionId);
			} catch (err) {
				console.warn("[SessionBridge] Error during foreground group detach:", err);
			}
		}
		// 1.4.2 (R4): yield one macrotask after the detach and BEFORE the plan
		// dispose so the awaitGroup continuations (delegation adapter ->
		// controller _delegateStep) flush first. A foreground Plan delegation
		// then persists waiting_input(agent_task) + Plan paused before the
		// session_close dispose, instead of being caught mid-delegation and
		// written failed; the detached facade also removes its parent-signal
		// listener in that same continuation, so the dispose abort never fires
		// onAbort -> cancelGroup against a just-backgrounded group.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		// Plan close matrix: session/app semantics map to PlanDisposeReason;
		// dispose runs BEFORE the session manager is nulled so the final
		// snapshot can still be persisted. Never auto-approves/executes.
		// 1.4.2 (R4): "quit" alone is not an app shutdown - stop-pi, project
		// switch (start) and team-mode switch all close with "quit" while the
		// app and the app-level task service keep running; only index.ts
		// cleanup marks _appShuttingDown.
		const planDisposeReason: PlanDisposeReason = this._appShuttingDown ? "app_shutdown" : "session_close";
		const planDisposePromise = generation?.planController
			? generation.planController.dispose(planDisposeReason)
			: undefined;
		this._unsubscribe?.();
		this._unsubscribe = null;
		this._teamManager?.setLeaderSession(null);
		this._session = null;
		this._sessionManager = null;
		this._isCompacting = false;
		this._pendingMessageCount = 0;
		this._mcpAdapter = null;
		this._auxiliaryUsage = createEmptyAuxiliaryUsage();

		// Mark the input queue closing and invalidate the generation FIRST.
		// Bridge-level request/dismissal listeners must stay so IPC can still
		// receive the close events (design plan section 4.9).
		this._markUserInputQueueClosing();
		// Call but do not await runner.dispose(): its synchronous prefix writes
		// host_disposed and aborts queued/active tasks. Any abort it triggers on
		// the displayed request now emits "session_closed" exactly once, never
		// "aborted" - a close-driven approval rejection is never misjudged as a
		// user denial.
		const runnerPromise = generation ? generation.runner.dispose() : undefined;
		// The bridge then dismisses the displayed request and rejects the
		// remaining user-input; queued items were never displayed so they get
		// no dismissal. Never pump afterwards.
		this._settleClosedUserInputQueue();

		const awaitCleanups = async (): Promise<void> => {
			if (planDisposePromise) {
				try {
					await planDisposePromise;
				} catch (err) {
					console.error("[SessionBridge] Error during plan controller dispose:", err);
				}
			}
			if (runnerPromise) {
				try {
					await runnerPromise;
				} catch (err) {
					console.error("[SessionBridge] Error during subagent runner dispose:", err);
				}
			}
		};

		if (!session) {
			await awaitCleanups();
			return false;
		}

		// Finally await the plan/runner cleanup, then dispose the parent
		// session and the parent MCP IN THAT ORDER. The UI never waits up to
		// 5s for the runner to settle before the session closes.
		await awaitCleanups();
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
