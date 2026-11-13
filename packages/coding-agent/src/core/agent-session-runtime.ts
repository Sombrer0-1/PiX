import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type { ReplacedSessionContext, SessionShutdownEvent, SessionStartEvent } from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import type { SessionFileHost } from "./session-file-host.ts";
import type { MainHostSession, SessionHostIO } from "./session-host.ts";
import { SessionManager } from "./session-manager.ts";
import type { RuntimeEnvironmentContext } from "./system-prompt.ts";
import type { ExecutionBackend } from "./tools/execution-backend.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
	hostSession?: MainHostSession;
}

interface AgentSessionRuntimeOptions {
	files?: SessionFileHost;
	sessionDir?: string;
	onExit?: () => Promise<void>;
}

type WithSession = (ctx: ReplacedSessionContext) => Promise<void>;

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	/** Agent runtime cwd (logical path under the execution backend). */
	runtimeCwd?: string;
	/** Execution backend for built-in tools; preserved across session switches. */
	executionBackend?: ExecutionBackend;
	/** Explicit runtime environment override (no cwd field). */
	runtimeEnvironmentOverride?: Partial<RuntimeEnvironmentContext>;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods tear down the current runtime first, then create
 * and apply the next runtime. If creation fails, the error is propagated to the
 * caller. The caller is responsible for user-facing error handling.
 */
export class AgentSessionRuntime {
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private beforeSessionClose?: () => void;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;
	private hostSession?: MainHostSession;
	private inputController = new AbortController();
	private initialization?: Promise<void>;
	private extensionBinding?: Promise<void>;
	private closeCurrent?: Promise<void>;
	private closeProcess?: Promise<void>;
	private readonly options: AgentSessionRuntimeOptions;
	private transition = Promise.resolve();
	private exiting = false;
	private eventDelivery = true;

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
		hostSession?: MainHostSession,
		options: AgentSessionRuntimeOptions = {},
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
		this.hostSession = hostSession;
		this.options = options;
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	get files(): SessionFileHost | undefined {
		return this.options.files;
	}

	get sessionDir(): string {
		return this.session.sessionManager.getSessionDir() || this.options.sessionDir || "";
	}

	get hasOpenSession(): boolean {
		return this.closeCurrent === undefined;
	}

	get hostCommands() {
		return this.hostSession?.commands ?? [];
	}

	setHostIO(io: SessionHostIO): void {
		const lifetime = this.inputController.signal;
		const session = this.session;
		this.hostSession?.setIO?.({
			signal: lifetime,
			requestUserInput: (request, signal) =>
				io.requestUserInput(request, signal ? AbortSignal.any([signal, lifetime]) : lifetime),
			emit: (event, text) => {
				if (this.eventDelivery && this.session === session) io.emit(event, text);
			},
		});
	}

	async initializeSession(): Promise<void> {
		if (!this.exiting && !this.closeCurrent && this.hostSession?.initialize) {
			this.initialization ??= this.hostSession.initialize();
			await this.initialization;
		}
	}

	async bindExtensions(bindings: Parameters<AgentSession["bindExtensions"]>[0]): Promise<void> {
		this.extensionBinding = this.session.bindExtensions(bindings);
		await this.extensionBinding;
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	setBeforeSessionClose(beforeSessionClose?: () => void): void {
		this.beforeSessionClose = beforeSessionClose;
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private teardownCurrent(
		reason: SessionShutdownEvent["reason"],
		targetSessionFile?: string,
		deletePath?: string,
	): Promise<void> {
		if (this.closeCurrent) return this.closeCurrent;
		const session = this.session;
		const hostSession = this.hostSession;
		const sessionManager = session.sessionManager;
		this.closeCurrent = (async () => {
			this.eventDelivery = reason === "quit";
			this.inputController.abort();
			try {
				if (hostSession) {
					this.beforeSessionClose?.();
					await this.extensionBinding?.catch(() => {});
					await this.initialization?.catch(() => {});
					this.beforeSessionInvalidate?.();
					try {
						await hostSession.close({ reason, targetSessionFile });
					} finally {
						await session.dispose({ reason, targetSessionFile });
					}
				} else {
					await emitSessionShutdownEvent(session.extensionRunner, {
						type: "session_shutdown",
						reason,
						targetSessionFile,
					});
					this.beforeSessionInvalidate?.();
					await session.dispose({ emitSessionShutdown: false });
				}
				if (deletePath) await this.files?.delete({ path: deletePath, active: sessionManager });
			} finally {
				this.eventDelivery = false;
				await this.files?.release(sessionManager);
			}
		})();
		return this.closeCurrent;
	}

	private apply(result: CreateAgentSessionRuntimeResult): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
		this.hostSession = result.hostSession;
		this.inputController = new AbortController();
		this.eventDelivery = true;
		this.initialization = undefined;
		this.extensionBinding = undefined;
		this.closeCurrent = undefined;
	}

	private async finishSessionReplacement(): Promise<void> {
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
	}

	private withCurrentSession(withSession?: WithSession): (() => Promise<void>) | undefined {
		if (!withSession) return undefined;
		const context = this.session.createReplacedSessionContext();
		return () => withSession(context);
	}

	private queueTransition<T>(operation: () => Promise<T>): Promise<T> {
		if (!this.files) return operation();
		const result = this.transition.then(() => {
			if (this.exiting) throw new Error("The session runtime is closing");
			return operation();
		});
		this.transition = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async replaceSession(
		sessionManager: SessionManager,
		reason: "new" | "resume" | "fork",
		options?: {
			setup?: (sessionManager: SessionManager) => Promise<void>;
			deletePath?: string;
		},
	): Promise<void> {
		const previousSessionFile = this.session.sessionFile;
		try {
			assertSessionCwdExists(sessionManager, this.cwd);
			await this.teardownCurrent(reason, sessionManager.getSessionFile(), options?.deletePath);
			this.apply(
				await this.createRuntime({
					cwd: sessionManager.getCwd(),
					...(!this.files && {
						runtimeCwd: this.services.runtimeCwd,
						executionBackend: this.services.executionBackend,
						runtimeEnvironmentOverride: this.services.runtimeEnvironmentOverride,
					}),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason, previousSessionFile },
				}),
			);
		} catch (error) {
			await this.files?.release(sessionManager);
			throw error;
		}

		try {
			if (this.exiting) throw new Error("The session runtime is closing");
			if (options?.setup) {
				await options.setup(sessionManager);
				this.session.agent.state.messages = sessionManager.buildSessionContext().messages;
			}
			await this.finishSessionReplacement();
		} catch (error) {
			await this.teardownCurrent("quit");
			throw error;
		}
	}

	async switchSession(
		sessionPath: string,
		options?: { cwdOverride?: string; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }> {
		const { result, withSession } = await this.queueTransition(async () => {
			const result = await this.switchSessionFile(sessionPath, options?.cwdOverride);
			return { result, withSession: result.cancelled ? undefined : this.withCurrentSession(options?.withSession) };
		});
		await withSession?.();
		return result;
	}

	private async switchSessionFile(sessionPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		if (this.files && this.isCurrentFile(sessionPath)) return { cancelled: true };
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const sessionManager = this.files
			? await this.files.open({ path: resolvePath(sessionPath, this.cwd), ...this.fileContext(), cwdOverride })
			: SessionManager.open(sessionPath, undefined, cwdOverride);
		await this.replaceSession(sessionManager, "resume");
		return { cancelled: false };
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const { result, withSession } = await this.queueTransition(async () => {
			const result = await this.newSessionFile(options);
			return { result, withSession: result.cancelled ? undefined : this.withCurrentSession(options?.withSession) };
		});
		await withSession?.();
		return result;
	}

	private async newSessionFile(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		deletePath?: string;
	}): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const parent = this.session.sessionManager;
		const sessionManager = this.files
			? await this.files.create({
					...this.fileContext(),
					parentSession: options?.parentSession,
					parent,
					persist: parent.isPersisted(),
				})
			: SessionManager.create(this.cwd, parent.getSessionDir());
		if (!this.files && options?.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}
		await this.replaceSession(sessionManager, "new", options);
		return { cancelled: false };
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const { result, withSession } = await this.queueTransition(async () => {
			const result = await this.forkSessionFile(entryId, position);
			return { result, withSession: result.cancelled ? undefined : this.withCurrentSession(options?.withSession) };
		});
		await withSession?.();
		return result;
	}

	private async forkSessionFile(
		entryId: string,
		position: "before" | "at",
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.session.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		if (this.files) {
			const target = await this.files.branch({
				...this.fileContext(),
				source: this.session.sessionManager,
				leafId: targetLeafId,
			});
			await this.replaceSession(target, "fork");
			return { cancelled: false, selectedText };
		}

		let sessionManager = this.session.sessionManager;
		if (this.session.sessionManager.isPersisted()) {
			const currentSessionFile = this.session.sessionFile;
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			const sessionDir = this.session.sessionManager.getSessionDir();
			if (!targetLeafId) {
				sessionManager = SessionManager.create(this.cwd, sessionDir);
				sessionManager.newSession({ parentSession: currentSessionFile });
			} else {
				sessionManager = SessionManager.open(currentSessionFile, sessionDir);
				if (!sessionManager.createBranchedSession(targetLeafId)) throw new Error("Failed to create forked session");
			}
		} else if (!targetLeafId) {
			sessionManager.newSession({ parentSession: this.session.sessionFile });
		} else {
			sessionManager.createBranchedSession(targetLeafId);
		}
		await this.replaceSession(sessionManager, "fork");
		return { cancelled: false, selectedText };
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		return this.queueTransition(() => this.importSessionFile(inputPath, cwdOverride));
	}

	private async importSessionFile(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath, this.files ? this.cwd : undefined);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}
		if (this.files) {
			const beforeResult = await this.emitBeforeSwitch("resume", resolvedPath);
			if (beforeResult.cancelled) return beforeResult;
			const target = await this.files.import({ ...this.fileContext(), sourcePath: resolvedPath, cwdOverride });
			await this.replaceSession(target, "resume");
			return { cancelled: false };
		}

		const sessionDir = this.session.sessionManager.getSessionDir();
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		const destinationPath = join(sessionDir, basename(resolvedPath));
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		if (resolve(destinationPath) !== resolvedPath) {
			copyFileSync(resolvedPath, destinationPath);
		}

		const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
		await this.replaceSession(sessionManager, "resume");
		return { cancelled: false };
	}

	private fileContext() {
		return { cwd: this.cwd, sessionDir: this.sessionDir };
	}

	private isCurrentFile(path: string): boolean {
		const manager = this.session.sessionManager;
		const resolvedPath = resolvePath(path, this.cwd);
		return this.files?.isCurrent?.(resolvedPath, manager) ?? resolvedPath === manager.getSessionFile();
	}

	async renameSessionFile(path: string, name: string): Promise<void> {
		return this.queueTransition(async () => {
			if (this.files && !this.isCurrentFile(path))
				await this.files.rename({ path: resolvePath(path, this.cwd), name });
			else if (this.files) this.session.setSessionName(name);
			else SessionManager.open(path).appendSessionInfo(name);
		});
	}

	async deleteSessionFile(path: string): Promise<void> {
		return this.queueTransition(async () => {
			if (!this.files) throw new Error("Session file host is unavailable");
			const resolvedPath = resolvePath(path, this.cwd);
			if (!this.isCurrentFile(resolvedPath)) await this.files.delete({ path: resolvedPath });
			else if ((await this.newSessionFile({ deletePath: resolvedPath })).cancelled)
				throw new Error("Session deletion cancelled");
		});
	}

	dispose(): Promise<void> {
		this.exiting = true;
		this.inputController.abort();
		this.beforeSessionClose?.();
		this.closeProcess ??= (async () => {
			try {
				await this.transition;
				await this.teardownCurrent("quit");
			} finally {
				await this.options.onExit?.();
			}
		})();
		return this.closeProcess;
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		runtimeCwd?: string;
		executionBackend?: ExecutionBackend;
		runtimeEnvironmentOverride?: Partial<RuntimeEnvironmentContext>;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	},
	hostOptions?: AgentSessionRuntimeOptions,
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const result = await createRuntime(options);
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
		result.hostSession,
		hostOptions,
	);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
