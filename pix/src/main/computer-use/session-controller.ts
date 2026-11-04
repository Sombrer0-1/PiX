/**
 * Computer-use session controller.
 *
 * Per-generation state machine for one foreground single session: the
 * per-session toggle (persisted as a CustomEntry), the grant level
 * (none < background < foreground) with its approval prompt flow, the
 * observe/act pipelines (guards -> service readiness -> portable required
 * fields -> target guard -> grant -> lease -> backend -> screenshot budget ->
 * result assembly) and tool reconciliation against the live AgentSession
 * registry (read-back only: setActiveToolsByName silently drops unknown names).
 *
 * Coupling: depends only on the `contracts.ts` interfaces injected via
 * `deps` plus shared types - never on the concrete backend/client/guard/lease/
 * codec implementations and never on electron. The dangerous-hotkey tables and
 * the chord helpers are imported from target-guard.ts (single source);
 * only the grant policy that acts on them lives here.
 */

import { randomBytes } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	ExtensionContext,
	RequestUserInputHandler,
	RequestUserInputRequest,
	RequestUserInputResponse,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	COMPUTER_ACT_REQUIRED,
	COMPUTER_OBSERVE_REQUIRED,
	COMPUTER_TOOL_NAMES,
	COMPUTER_USE_CUSTOM_TYPE,
	COMPUTER_USE_LIMITS,
	missingRequiredFields,
	type ComputerActParams,
	type ComputerGrantLevel,
	type ComputerObserveParams,
	type ComputerObserveView,
	type ComputerToolDetails,
	type ComputerUseActivity,
	type ComputerUseErrorCode,
	type ComputerUseSessionSnapshot,
	type ResolvedComputerUseSettings,
} from "../../shared/computer-use-types.js";
import {
	ComputerUseError,
	effectiveFrame,
	errorText,
	isComputerToolName,
	type BackendObservation,
	type BackendSessionHandle,
	type ComputerBackend,
	type DesktopLease,
	type ScreenshotEncoder,
	type TargetGuard,
} from "./contracts.js";
import { chordOf, isDangerousHotkey } from "./target-guard.js";

export interface ComputerUseSessionControllerDeps {
	controllerId: string;                                     // `${genId}`
	backend: () => ComputerBackend | null;                    // null = service 不可用
	ensureReady: () => Promise<void>;                         // service 懒启动驱动；失败抛 ComputerUseError
	lease: DesktopLease;
	guard: TargetGuard;
	encode: ScreenshotEncoder;
	getSettings: () => ResolvedComputerUseSettings;
	getSession: () => AgentSession | null;                    // 本 generation 的 parent session（session_start 在 bindExtensions 中触发，此时已赋值）
	getSessionManager: () => SessionManager | null;
	isForeground: () => boolean;                              // bridge: this._generation?.genId === genId
	requestUserInput: RequestUserInputHandler;                // bridge 的 _requestUserInputForGeneration 闭包
	isPlanRestricted: () => boolean;                          // planController 处于 planning/revising
	emit: (e: ComputerUseControllerEvent) => void;            // → service
	now?: () => number;
}

export type ComputerUseControllerEvent =
	| { type: "session_state"; controllerId: string; state: ComputerUseSessionSnapshot }
	| { type: "activity"; controllerId: string; sessionId: string; activity: ComputerUseActivity };

/** CustomEntry payload. */
interface ComputerUseToggleEntryData {
	schemaVersion: 1;
	enabled: boolean;
	at: number;
}

/** Human answer labels of the grant prompt (`request_user_input` options). */
const GRANT_LABEL_SESSION = "本会话允许";
const GRANT_LABEL_ONCE = "仅本次允许";
const GRANT_LABEL_DENY = "拒绝";
const GRANT_QUESTION_ID = "computer_use_grant";

const GRANT_RANK: Readonly<Record<ComputerGrantLevel, number>> = { none: 0, background: 1, foreground: 2 };

/** Settle delay before the post-action observation. */
const POST_ACTION_SETTLE_MS = 350;

/** Encoded screenshot as attached to the tool result. */
interface CaptureImage {
	data: string;
	mimeType: string;
	width: number;
	height: number;
	bytes: number;
}

/** Result of one act execution: the backend action result, or the local wait (no driver call). */
interface ActionOutcome {
	text: string;
	effect?: string;
	deliveryMode?: "background" | "foreground" | "not_applicable" | "unknown";
	route?: string;
	evidence?: Array<{ kind: string; detail: string | null }>;
	target?: ComputerToolDetails["target"];
	driverTool?: string;
}

/** Image-retention decision for one observe call. */
interface ImagePolicy {
	wantImage: boolean;
	omitted: "non_vision_model" | "images_blocked" | "not_requested" | null;
}

/** Outcome of one observe round-trip (including the over-budget re-shot). */
interface CaptureOutcome {
	observation: BackendObservation;
	image: CaptureImage | null;
	/** Text token reason when no image is attached. */
	omittedReason: string | null;
	/** Closed-enum reason for `details.screenshot.omitted` (policy cases only). */
	omittedForDetails: "non_vision_model" | "images_blocked" | "not_requested" | null;
}

export class ComputerUseSessionController {
	readonly id: string;

	private readonly _deps: ComputerUseSessionControllerDeps;
	private readonly _now: () => number;
	private readonly _unsubscribeLease: () => void;

	private _sessionEnabled = false;
	private _grant: ComputerGrantLevel = "none";
	private _deniedThisRun = false;
	private _halted = false;
	private _activity: ComputerUseActivity | null = null;
	private _handle: BackendSessionHandle | null = null;
	private _inflight: AbortController | null = null;
	/** Aborts a pending grant prompt when the session is disabled/backgrounded (the prompt itself only sees the tool signal). */
	private _promptAbort: AbortController | null = null;
	private _chain: Promise<unknown> = Promise.resolve();
	private _disposed = false;

	constructor(deps: ComputerUseSessionControllerDeps) {
		this._deps = deps;
		this.id = deps.controllerId;
		this._now = deps.now ?? Date.now;
		this._unsubscribeLease = deps.lease.onChange(() => this._emitSessionState());
	}

	// =========================================================================
	// Session toggle / reconciliation
	// =========================================================================

	/** Read latest valid CustomEntry on sessionManager.getBranch(); none → defaultSessionEnabled for brand-new sessions else false. Cheap; called on session_start / session_tree / before_agent_start. */
	hydrate(): void {
		this._sessionEnabled = this._readSessionEnabled();
		this._emitSessionState();
	}

	isSessionEnabled(): boolean {
		return this._sessionEnabled;
	}

	/** Persist CustomEntry; disabling also revokes grants + releases lease + aborts in-flight; then reconcileTools(). */
	setSessionEnabled(enabled: boolean): void {
		if (this._sessionEnabled !== enabled) {
			this._sessionEnabled = enabled;
			const data: ComputerUseToggleEntryData = { schemaVersion: 1, enabled, at: this._now() };
			this._deps.getSessionManager()?.appendCustomEntry(COMPUTER_USE_CUSTOM_TYPE, data);
		}
		if (!enabled) {
			this._teardownAuthorization();
		}
		this.reconcileTools();
		this._emitSessionState();
	}

	/**
	 * Desired = global on && session on && foreground && mode !== "read-only" && !planRestricted && availability not in {disabled, unsupported_platform}.
	 * Computes next = getActiveToolNames() ± COMPUTER_TOOL_NAMES and calls session.setActiveToolsByName(next) only when it differs.
	 * setActiveToolsByName silently drops names not in the registry (agent-session.ts:1254–1266), so the snapshot's toolsActive is
	 * always read back from getActiveToolNames(). Enabling while streaming is deferred to the next before_agent_start; disabling
	 * applies immediately (the execute guard is authoritative either way).
	 */
	reconcileTools(): void {
		const session = this._deps.getSession();
		if (!session) return;
		const current = session.getActiveToolNames();
		const hasAny = COMPUTER_TOOL_NAMES.some((name) => current.includes(name));
		if (this._computeInactiveReason() === undefined) {
			const missing = COMPUTER_TOOL_NAMES.filter((name) => !current.includes(name));
			// Enabling while a turn is streaming is deferred to the next before_agent_start.
			if (missing.length > 0 && !session.isStreaming) {
				session.setActiveToolsByName([...current, ...missing]);
			}
		} else if (hasAny) {
			session.setActiveToolsByName(current.filter((name) => !isComputerToolName(name)));
		}
		this._emitSessionState();
	}

	// =========================================================================
	// Tool entrypoints (only computer-tools.ts calls these)
	// =========================================================================

	/** Serialised through one internal promise chain per controller. Throw ComputerUseError → isError tool result whose text = error.message. */
	observe(
		toolCallId: string,
		p: ComputerObserveParams,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<ComputerToolDetails>> {
		return this._serialize(() => this._observe(toolCallId, p, signal, ctx));
	}

	act(
		toolCallId: string,
		p: ComputerActParams,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<ComputerToolDetails>> {
		return this._serialize(() => this._act(toolCallId, p, signal, ctx));
	}

	// =========================================================================
	// Grants / lifecycle
	// =========================================================================

	revokeGrants(): void {
		if (this._grant === "none") return;
		this._grant = "none";
		this._emitSessionState();
	}

	/**
	 * Emergency stop: synchronous part = revoke, abort in-flight (internal AbortController), release lease, halted=true, emit;
	 * then fire-and-forget `void session.abort().catch(log)` - AgentSession.abort() is async and awaits waitForIdle
	 * (agent-session.ts:2303–2308), so halt() must never await it (would deadlock when reached from inside a tool call).
	 */
	halt(): void {
		this.revokeGrants();
		this._abortInflight();
		this._releaseLease();
		this._halted = true;
		this.reconcileTools();
		this._emitSessionState();
		const session = this._deps.getSession();
		if (session) {
			void session.abort().catch((err: unknown) => {
				console.warn(`[ComputerUse] session.abort during halt failed: ${errorText(err)}`);
			});
		}
	}

	/** Clear halted + deniedThisRun; called from before_agent_start (a new user prompt). */
	onUserTurnStart(): void {
		this._halted = false;
		this._deniedThisRun = false;
		this._emitSessionState();
	}

	onBackgrounded(): void {
		this._teardownAuthorization();
		this.reconcileTools();
		this._emitSessionState();
	}

	onForegrounded(): void {
		this.hydrate();
		this.reconcileTools();
	}

	getSnapshot(): ComputerUseSessionSnapshot | null {
		const session = this._deps.getSession();
		const manager = this._deps.getSessionManager();
		if (!session || !manager) return null;
		return {
			sessionId: manager.getSessionId(),
			sessionEnabled: this._sessionEnabled,
			grant: this._grant,
			holdsLease: this._deps.lease.getState().holderId === this.id,
			halted: this._halted,
			toolsActive: COMPUTER_TOOL_NAMES.every((name) => session.getActiveToolNames().includes(name)),
			inactiveReason: this._computeInactiveReason(),
			activity: this._activity,
		};
	}

	/** end_session on backend (errors swallowed), release lease, drop listeners. Idempotent. */
	async dispose(): Promise<void> {
		if (this._disposed) return;
		this._disposed = true;
		this._unsubscribeLease();
		this._abortInflight();
		this._releaseLease();
		this._grant = "none";
		const handle = this._handle;
		this._handle = null;
		const backend = this._deps.backend();
		if (handle && backend) {
			try {
				await backend.closeSession(handle);
			} catch (err: unknown) {
				console.warn(`[ComputerUse] end_session during dispose failed: ${errorText(err)}`);
			}
		}
	}

	// =========================================================================
	// Observe pipeline
	// =========================================================================

	private async _observe(
		toolCallId: string,
		p: ComputerObserveParams,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<ComputerToolDetails>> {
		const startedAt = this._now();
		const session = this._assertActive();
		const activity = this._beginActivity(toolCallId, "observe", observeSummary(p));
		try {
			// Portable required fields and guards run before the service is started,
			// mirroring _act: ensureReady has side effects (driver launch + permission
			// checks), so an invalid call must fail locally instead.
			const missing = missingRequiredFields(p, COMPUTER_OBSERVE_REQUIRED[p.view]);
			if (missing !== null) {
				throw new ComputerUseError(
					"invalid_params",
					`computer_observe view="${p.view}" is missing required parameters. Provide ${formatAlternatives(missing)}.`,
				);
			}
			if (p.view === "verify") {
				for (const [index, expectation] of (p.expect ?? []).entries()) {
					if ((expectation.element === undefined) === (expectation.window === undefined)) {
						throw new ComputerUseError("invalid_params",
							`expect[${index}] must contain exactly one of element or window. Put window and element conditions in separate expect items.`);
					}
					const element = expectation.element;
					if (element !== undefined && (!element.selector.role?.trim() && !element.selector.label_contains?.trim())) {
						throw new ComputerUseError("invalid_params", `expect[${index}].element.selector needs a non-empty role or label_contains.`);
					}
					if (expectation.window !== undefined && expectation.window.exists === undefined) {
						throw new ComputerUseError("invalid_params", `expect[${index}].window needs exists.`);
					}
				}
			}
			// The driver cannot prove absence, so element.exists=false is rejected
			// before the service starts instead of surfacing as a driver_error.
			if (p.view === "verify" && (p.expect ?? []).some((expectation) => expectation.element?.exists === false)) {
				throw new ComputerUseError(
					"invalid_params",
					"computer_verify element.exists=false is not supported: the driver cannot prove absence. Use exists=true or value_equals.",
					"Remove the false expectation or assert a concrete value/state instead.",
				);
			}
			this._deps.guard.assertObserveAllowed(p);
			// The per-call aborter starts BEFORE the service wait: while ensureReady
			// is pending the call must be abortable (backgrounded / disabled /
			// disposed), and the state that can change during that await is
			// re-checked right after it - the entry guards alone are stale by then.
			const call = this._beginCall(signal);
			try {
				const backend = await this._ensureService();
				this._assertActive();
				await this._ensureGrant(toolCallId, "background", false, observeSummary(p), signal);
				const policy = this._imagePolicy(ctx, session, p.screenshot !== false);
				const handle = await this._ensureHandle(backend);
				const capture = await this._capture(backend, handle, p, policy, call.signal);
				const frame = frameForObserveView(p.view);
				const pixLine = `[pix] snapshot_id=${capture.observation.snapshotId ?? "none"} capture_id=${capture.observation.captureId ?? "none"} frame=${frame} screenshot=${screenshotToken(capture)} grant=${this._grant}${capture.observation.zoom ? " from_zoom=true" : ""}`;
				const notes = observeNotes(capture.observation);
				const hint = screenshotHint(capture);
				if (hint !== undefined) notes.push(hint);
				const text = composeText(capture.observation.text, undefined, pixLine, notes);
				const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
				if (capture.image) {
					content.push({ type: "image", data: capture.image.data, mimeType: capture.image.mimeType });
				}
				const details: ComputerToolDetails = {
					kind: "observe",
					view: p.view,
					target: capture.observation.target ?? observeTarget(p),
					captureId: capture.observation.captureId,
					snapshotId: capture.observation.snapshotId,
					screenshot: screenshotDetails(capture),
					grant: this._grant,
					durationMs: this._now() - startedAt,
					driverTool: capture.observation.driverTool,
				};
				this._finishActivity(activity, "succeeded");
				return { content, details };
			} finally {
				call.release();
			}
		} catch (err: unknown) {
			throw this._failActivity(activity, err);
		}
	}

	// =========================================================================
	// Act pipeline
	// =========================================================================

	private async _act(
		toolCallId: string,
		p: ComputerActParams,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<ComputerToolDetails>> {
		const startedAt = this._now();
		const session = this._assertActive();
		const summary = actSummary(p);
		const activity = this._beginActivity(toolCallId, "act", summary);
		try {
			// Portable required fields and guards run before the service is started:
			// ensureReady has side effects (driver launch + permission checks), so an
			// invalid call must fail locally instead. wait additionally stays local
			// end to end (no driver, no lease).
			const missing = missingRequiredFields(p, COMPUTER_ACT_REQUIRED[p.action]);
			if (missing !== null) {
				throw new ComputerUseError(
					"invalid_params",
					`computer_act action="${p.action}" is missing required parameters. Provide ${formatAlternatives(missing)}.`,
				);
			}
			this._deps.guard.assertActAllowed(p);
			// Same as _observe: the aborter covers the whole post-guard pipeline
			// (grant prompt + service wait), and the entry guards are re-run after
			// the service wait because the world can change while it pends.
			const call = this._beginCall(signal);
			try {
				await this._ensureGrant(toolCallId, requiredGrantForAct(p), isDangerousAct(p), summary, signal);
				const backend: ComputerBackend | null = p.action === "wait" ? null : await this._ensureService();
				if (backend !== null) this._assertActive();
				const actionResult = await this._executeAction(backend, p, call.signal);
				const capture = backend === null ? null : await this._observeAfterAction(backend, p, ctx, session, call.signal);
				const frame = capture ? frameForObserveView(capture.params.view) : effectiveFrame(p);
				const screenshot = capture ? screenshotToken(capture.outcome) : "omitted:not_requested";
				const effectSuffix = actionResult.effect !== undefined ? ` effect=${actionResult.effect}` : "";
				const deliverySuffix = actionResult.deliveryMode !== undefined ? ` delivery=${actionResult.deliveryMode}` : "";
				const routeSuffix = actionResult.route !== undefined ? ` route=${actionResult.route}` : "";
				const pixLine = `[pix] capture_id=${capture?.outcome.observation.captureId ?? "none"} frame=${frame} screenshot=${screenshot} grant=${this._grant}${deliverySuffix}${routeSuffix}${effectSuffix}${capture?.outcome.observation.zoom ? " from_zoom=true" : ""}`;
				const notes = capture ? [capture.note, screenshotHint(capture.outcome)] : [];
				notes.push(...actNotes(p, actionResult));
				const text = composeText(
					actionResult.text,
					capture?.outcome.observation.text,
					pixLine,
					notes.filter((note): note is string => note !== undefined),
				);
				const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
				if (capture?.outcome.image) {
					content.push({ type: "image", data: capture.outcome.image.data, mimeType: capture.outcome.image.mimeType });
				}
				const details: ComputerToolDetails = {
					kind: "act",
					action: p.action,
					target: capture?.outcome.observation.target ?? actionResult.target ?? actTarget(p),
					captureId: capture?.outcome.observation.captureId,
					snapshotId: capture?.outcome.observation.snapshotId,
					screenshot: capture ? screenshotDetails(capture.outcome) : undefined,
					grant: this._grant,
					durationMs: this._now() - startedAt,
					driverTool: actionResult.driverTool,
				};
				this._finishActivity(activity, "succeeded");
				return { content, details };
			} finally {
				call.release();
			}
		} catch (err: unknown) {
			throw this._failActivity(activity, err);
		}
	}

	/** wait is local (no driver call, no lease); every other action goes to the backend. */
	private async _executeAction(backend: ComputerBackend | null, p: ComputerActParams, signal: AbortSignal): Promise<ActionOutcome> {
		if (p.action === "wait") {
			const ms = Math.min(Math.max(p.duration_ms ?? 0, 0), COMPUTER_USE_LIMITS.waitMaxMs);
			await abortableSleep(ms, signal);
			if (signal.aborted) {
				throw new ComputerUseError("cancelled", "The wait was aborted before it finished.", "Re-run the request after the current operation stops.");
			}
			return { text: `Waited ${ms} ms.` };
		}
		if (backend === null) {
			// Unreachable from _act (only wait skips _ensureService); guards the type narrowing.
			throw serviceUnavailableError();
		}
		if (!this._deps.lease.tryAcquire(this.id)) {
			throw new ComputerUseError(
				"desktop_busy",
				"Another session holds the desktop lease.",
				"Wait for the other session to finish or ask the user to stop it, then retry.",
			);
		}
		const handle = await this._ensureHandle(backend);
		// The grant prompt hands focus to PiX (the approval card is rendered in the
		// main window), so the entry guard at _act is stale by the time the driver is
		// called: re-run the same guard right before handing the action to the driver.
		this._deps.guard.assertActAllowed(p);
		try {
			return await backend.act(handle, p, { signal });
		} catch (err: unknown) {
			const error = asComputerUseError(err);
			if (error.code === "cancelled" || error.code === "driver_crashed") {
				throw new ComputerUseError(
					error.code,
					`${error.detail} The action may have been partially executed and the state is unknown; call computer_observe before deciding whether to retry.`,
					error.hint,
				);
			}
			throw error;
		}
	}

	/**
	 * After a successful action: settle 350ms, then observe the same target (window view when pid+window_id
	 * are known, desktop otherwise). A failed post-observation never fails the action - it only annotates
	 * the text with a note.
	 */
	private async _observeAfterAction(
		backend: ComputerBackend,
		p: ComputerActParams,
		ctx: ExtensionContext,
		session: AgentSession,
		signal: AbortSignal,
	): Promise<{ outcome: CaptureOutcome; params: ComputerObserveParams; note: string | undefined } | null> {
		if (p.action === "wait" || p.observe_after === false) return null;
		await abortableSleep(POST_ACTION_SETTLE_MS, signal);
		const params: ComputerObserveParams =
			p.pid !== undefined && p.window_id !== undefined
				? { view: "window", pid: p.pid, window_id: p.window_id }
				: { view: "desktop" };
		try {
			const handle = await this._ensureHandle(backend);
			const policy = this._imagePolicy(ctx, session, true);
			const outcome = await this._capture(backend, handle, params, policy, signal, p.from_zoom === true);
			return { outcome, params, note: undefined };
		} catch (err: unknown) {
			const code = err instanceof ComputerUseError ? err.code : "driver_error";
			return {
				outcome: { observation: { text: "", image: null, driverTool: "" }, image: null, omittedReason: "unavailable", omittedForDetails: null },
				params,
				note: `[pix] post-action observation failed (${code}); call computer_observe to refresh the target state.`,
			};
		}
	}

	// =========================================================================
	// Guards / service / backend session
	// =========================================================================

	/** 守卫顺序：全局开 → 会话开 → 前台 → 非 halted → 非 plan 限制。 */
	private _assertActive(): AgentSession {
		if (this._disposed) {
			throw new ComputerUseError("unavailable", "The computer-use controller was disposed.", "The session was replaced or closed; retry from the live session.");
		}
		const settings = this._deps.getSettings();
		if (!settings.enabled) {
			throw new ComputerUseError("global_disabled", "Computer use is disabled.", "Enable it under Settings > Computer use.");
		}
		if (!this._sessionEnabled) {
			throw new ComputerUseError("session_disabled", "Computer use is disabled for this session.", "Turn on the computer-use toggle next to the composer.");
		}
		if (!this._deps.isForeground()) {
			throw new ComputerUseError("not_foreground", "Computer use is only available in the foreground session.", "Switch back to this session to continue.");
		}
		if (this._halted) {
			throw new ComputerUseError("halted", "Computer use is halted after the emergency stop.", "Send a new message to resume after reviewing the desktop state.");
		}
		if (this._deps.isPlanRestricted()) {
			throw new ComputerUseError("unavailable", "Computer use is unavailable while plan mode is planning or revising.", "Finish or exit plan mode first.");
		}
		const session = this._deps.getSession();
		if (!session) {
			throw sessionNotReadyError();
		}
		return session;
	}

	private async _ensureService(): Promise<ComputerBackend> {
		await this._deps.ensureReady();
		const backend = this._deps.backend();
		if (!backend) {
			throw serviceUnavailableError();
		}
		return backend;
	}

	private async _ensureHandle(backend: ComputerBackend): Promise<BackendSessionHandle> {
		if (this._handle) return this._handle;
		const label = `pix-${this.id}-${randomBytes(4).toString("hex")}`;
		this._handle = await backend.openSession(label);
		return this._handle;
	}

	// =========================================================================
	// Grant state machine
	// =========================================================================

	private async _ensureGrant(
		toolCallId: string,
		required: ComputerGrantLevel,
		dangerous: boolean,
		summary: string,
		signal: AbortSignal | undefined,
	): Promise<void> {
		const session = this._deps.getSession();
		if (!session) {
			throw sessionNotReadyError();
		}
		const mode = session.settingsManager.getExecutionMode();
		if (mode === "read-only") {
			// Defensive: core policy already rejects non-read tools and reconcile leaves the tools inactive.
			throw new ComputerUseError("session_disabled", "Computer use is disabled in read-only mode.", "Switch the execution mode to approval or unattended.");
		}
		if (mode === "unattended") {
			if (dangerous) {
				throw new ComputerUseError(
					"dangerous_action_blocked",
					`Refusing a dangerous hotkey in unattended mode: ${summary}.`,
					'No user is watching to confirm it. Use a non-hotkey route (computer_act action="invoke_menu", set_value, or clicking a window control) instead.',
				);
			}
			this._raiseGrant(required);
			return;
		}
		// approval mode
		const needsPrompt = dangerous || GRANT_RANK[required] > GRANT_RANK[this._grant];
		if (!needsPrompt) return;
		if (this._deniedThisRun) {
			throw new ComputerUseError(
				"user_denied",
				"The user already denied computer-use permission for this run.",
				"Stop the task and ask the user how to proceed.",
			);
		}
		const request: RequestUserInputRequest = {
			id: `computer-use-grant:${toolCallId}`,
			questions: [
				{
					id: GRANT_QUESTION_ID,
					header: "电脑操控",
					question: `Agent 请求以${required === "foreground" ? "前台" : "后台"}方式操作你的电脑：${summary}`,
					options: dangerous
						? [{ label: GRANT_LABEL_ONCE }, { label: GRANT_LABEL_DENY }]
						: [{ label: GRANT_LABEL_SESSION }, { label: GRANT_LABEL_ONCE }, { label: GRANT_LABEL_DENY }],
				},
			],
		};
		// The pending prompt is abortable from BOTH sources: the tool-call signal
		// and the controller side (session toggle off / backgrounded). The bridge
		// only dismisses its prompt entry when the signal IT received aborts, so
		// requestUserInput must see one merged signal that forwards both (hand-
		// rolled: AbortSignal.any is too new to rely on); the local wrapper
		// Promise below additionally rejects on the controller-side source.
		const promptAbort = new AbortController();
		this._promptAbort = promptAbort;
		const merged = new AbortController();
		const onToolAbort = (): void => {
			promptAbort.abort();
			merged.abort(signal?.reason);
		};
		const onControllerAbortSignal = (): void => merged.abort();
		if (signal) {
			if (signal.aborted) onToolAbort();
			else signal.addEventListener("abort", onToolAbort, { once: true });
		}
		if (promptAbort.signal.aborted) onControllerAbortSignal();
		else promptAbort.signal.addEventListener("abort", onControllerAbortSignal, { once: true });
		let response: RequestUserInputResponse;
		try {
			response = await new Promise<RequestUserInputResponse>((resolve, reject) => {
				void this._deps.requestUserInput(request, merged.signal).then(resolve, reject);
				const onControllerAbort = (): void => reject(new Error("The computer-use permission prompt was aborted because the session was disabled or backgrounded."));
				if (promptAbort.signal.aborted) onControllerAbort();
				else promptAbort.signal.addEventListener("abort", onControllerAbort, { once: true });
			});
		} catch (err: unknown) {
			// Rule 1: a rejected prompt is always `cancelled` (never user_denied).
			if (signal?.aborted) {
				throw new ComputerUseError("cancelled", "The computer-use permission prompt was aborted.", "Re-run the request after the current operation stops.");
			}
			// The controller aborted the pending prompt (session toggle off / backgrounded):
			// a stale answer must not raise the grant or run the action.
			if (promptAbort.signal.aborted) {
				throw new ComputerUseError("session_disabled", "Computer use is disabled for this session.", "Turn on the computer-use toggle next to the composer.");
			}
			const reason = errorText(err);
			throw new ComputerUseError("cancelled", `The computer-use permission prompt closed before an answer: ${reason}`, "Ask the user to keep the session open while the prompt is pending.");
		} finally {
			if (signal) signal.removeEventListener("abort", onToolAbort);
			promptAbort.signal.removeEventListener("abort", onControllerAbortSignal);
			if (this._promptAbort === promptAbort) this._promptAbort = null;
		}
		// The answer may have raced the disable (resolve before the abort won): re-run the
		// entry guards before acting on it - a disabled session rejects with session_disabled.
		this._assertActive();
		// Rule 2: check `cancelled` before reading any answers.
		if (response.cancelled === true) {
			this._deniedThisRun = true;
			this._emitSessionState();
			throw new ComputerUseError("user_denied", "The user skipped the computer-use permission prompt.", "Stop the task and ask the user how to proceed.");
		}
		// Rule 3: label text decides.
		const answers = response.answers ?? {};
		const answer = (answers[GRANT_QUESTION_ID] ?? "").trim();
		if (answer === GRANT_LABEL_SESSION) {
			this._raiseGrant(required);
			return;
		}
		if (answer === GRANT_LABEL_ONCE) return;
		this._deniedThisRun = true;
		this._emitSessionState();
		const feedback = answer.length > 0 && answer !== GRANT_LABEL_DENY ? ` User feedback: ${answer}` : "";
		throw new ComputerUseError("user_denied", `The user denied the computer-use request.${feedback}`, "Stop the task and ask the user how to proceed.");
	}

	private _raiseGrant(required: ComputerGrantLevel): void {
		if (GRANT_RANK[required] <= GRANT_RANK[this._grant]) return;
		this._grant = required;
		this._emitSessionState();
	}

	// =========================================================================
	// Capture (observe + screenshot budget)
	// =========================================================================

	private async _capture(
		backend: ComputerBackend,
		handle: BackendSessionHandle,
		params: ComputerObserveParams,
		policy: ImagePolicy,
		signal: AbortSignal,
		preserveZoom = false,
	): Promise<CaptureOutcome> {
		const settings = this._deps.getSettings();
		let observation = await backend.observe(handle, params, {
			maxImageDimension: settings.maxImageDimension,
			wantImage: policy.wantImage,
			signal,
			preserveZoom,
		});
		if (!policy.wantImage || !observation.image) {
			return {
				observation,
				image: null,
				omittedReason: policy.omitted ?? (policy.wantImage ? "unavailable" : "not_requested"),
				omittedForDetails: policy.omitted,
			};
		}
		let encoded = await this._deps.encode(observation.image, settings.screenshotMaxBytes);
		if (!encoded.ok) {
			const reshotDimension = reshotDimensionFor(Math.max(observation.image.width, observation.image.height));
			if (reshotDimension !== null) {
				// A failed re-shot must not fail the observation: keep the first observation
				// and fall through to the no-image degradation (omittedReason over_byte_budget).
				try {
					const reshot = await backend.observe(handle, params, { maxImageDimension: reshotDimension, wantImage: true, signal, preserveZoom });
					if (reshot.image) {
						observation = reshot;
						encoded = await this._deps.encode(reshot.image, settings.screenshotMaxBytes);
					}
				} catch (err: unknown) {
					if (signal.aborted) throw err;
					// Otherwise swallow: `encoded` stays not-ok, the first observation survives.
				}
			}
		}
		if (encoded.ok) {
			return {
				observation,
				image: { data: encoded.data, mimeType: encoded.mimeType, width: encoded.width, height: encoded.height, bytes: encoded.bytes },
				omittedReason: null,
				omittedForDetails: null,
			};
		}
		return { observation, image: null, omittedReason: "over_byte_budget", omittedForDetails: null };
	}

	/**
	 * wantImage = screenshot !== false && model.input.includes("image") && !getBlockImages() (settings-manager.ts:1039).
	 * Non-vision / blocked / not requested are degradations, not errors: details.screenshot.omitted records the reason.
	 */
	private _imagePolicy(ctx: ExtensionContext, session: AgentSession, requested: boolean): ImagePolicy {
		if (!requested) return { wantImage: false, omitted: "not_requested" };
		const model = ctx.model;
		if (!model || !model.input.includes("image")) return { wantImage: false, omitted: "non_vision_model" };
		if (session.settingsManager.getBlockImages()) return { wantImage: false, omitted: "images_blocked" };
		return { wantImage: true, omitted: null };
	}

	// =========================================================================
	// Session state / activity / emit
	// =========================================================================

	private _computeInactiveReason(): ComputerUseSessionSnapshot["inactiveReason"] {
		const settings = this._deps.getSettings();
		if (!settings.enabled) return "global_disabled";
		if (!this._sessionEnabled) return "session_disabled";
		if (!this._deps.isForeground()) return "unavailable";
		const session = this._deps.getSession();
		if (!session) return "unavailable";
		const mode = session.settingsManager.getExecutionMode();
		if (mode === "read-only") return "read_only_mode";
		if (this._deps.isPlanRestricted()) return "plan_mode";
		if (this._deps.backend() === null) return "unavailable";
		return undefined;
	}

	private _readSessionEnabled(): boolean {
		const settings = this._deps.getSettings();
		const manager = this._deps.getSessionManager();
		if (!manager) return settings.defaultSessionEnabled;
		const branch = manager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "custom" || entry.customType !== COMPUTER_USE_CUSTOM_TYPE) continue;
			const data = entry.data;
			if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
			const record = data as Record<string, unknown>;
			if (record.schemaVersion !== 1) continue; // unknown schemaVersion → ignore this entry
			return record.enabled === true;
		}
		const brandNew = !branch.some((entry) => entry.type === "message");
		return brandNew ? settings.defaultSessionEnabled : false;
	}

	private _beginActivity(toolCallId: string, tool: "observe" | "act", summary: string): ComputerUseActivity {
		const activity: ComputerUseActivity = { toolCallId, tool, summary, startedAt: this._now(), state: "running" };
		this._activity = activity;
		this._emit({ type: "activity", controllerId: this.id, sessionId: this._sessionId(), activity: { ...activity } });
		this._emitSessionState();
		return activity;
	}

	private _finishActivity(activity: ComputerUseActivity, state: ComputerUseActivity["state"], errorCode?: ComputerUseErrorCode): void {
		activity.state = state;
		if (errorCode !== undefined) activity.errorCode = errorCode;
		this._activity = { ...activity };
		this._emit({ type: "activity", controllerId: this.id, sessionId: this._sessionId(), activity: { ...activity } });
		this._emitSessionState();
	}

	/** Normalise a pipeline failure into a ComputerUseError, finish the activity and rethrow. */
	private _failActivity(activity: ComputerUseActivity, err: unknown): unknown {
		const error = asComputerUseError(err);
		if (error.code === "driver_crashed") this._handle = null;
		this._finishActivity(activity, error.code === "cancelled" ? "cancelled" : "failed", error.code);
		return error;
	}

	private _sessionId(): string {
		return this._deps.getSessionManager()?.getSessionId() ?? "";
	}

	private _emitSessionState(): void {
		if (this._disposed) return;
		const state = this.getSnapshot();
		if (!state) return;
		this._emit({ type: "session_state", controllerId: this.id, state });
	}

	private _emit(event: ComputerUseControllerEvent): void {
		if (this._disposed) return;
		try {
			this._deps.emit(event);
		} catch (err: unknown) {
			console.warn(`[ComputerUse] controller event listener failed: ${errorText(err)}`);
		}
	}

	// =========================================================================
	// Serialisation / abort plumbing
	// =========================================================================

	private _serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this._chain.then(fn);
		this._chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Per-call aborter chained to the caller's signal; `halt`/background/dispose abort it. */
	private _beginCall(signal: AbortSignal | undefined): { signal: AbortSignal; release: () => void } {
		const inflight = new AbortController();
		this._inflight = inflight;
		if (!signal) {
			return {
				signal: inflight.signal,
				release: () => {
					if (this._inflight === inflight) this._inflight = null;
				},
			};
		}
		const onAbort = (): void => inflight.abort((signal as AbortSignal).reason);
		if (signal.aborted) inflight.abort(signal.reason);
		else signal.addEventListener("abort", onAbort, { once: true });
		return {
			signal: inflight.signal,
			release: () => {
				signal.removeEventListener("abort", onAbort);
				if (this._inflight === inflight) this._inflight = null;
			},
		};
	}

	private _abortInflight(): void {
		this._inflight?.abort();
	}

	/** Abort every pending grant prompt (session toggle off / backgrounded); they reject with `session_disabled`. */
	private _abortPendingPrompts(): void {
		this._promptAbort?.abort();
		this._promptAbort = null;
	}

	/** Revoke grants and abort in-flight work and pending prompts, then release the lease. */
	private _teardownAuthorization(): void {
		this.revokeGrants();
		this._abortInflight();
		this._abortPendingPrompts();
		this._releaseLease();
	}

	private _releaseLease(): void {
		if (this._deps.lease.getState().holderId === this.id) {
			this._deps.lease.release(this.id);
		}
	}
}

// ============================================================================
// Pure helpers (module-private by design)
// ============================================================================

/** Grant required by an act call: none < background < foreground. */
function requiredGrantForAct(p: ComputerActParams): ComputerGrantLevel {
	if (p.action === "wait") return "none";
	if (p.delivery === "foreground") return "foreground";
	if (p.action === "launch_app") return "background";
	if (p.action === "focus_window" || p.action === "invoke_menu") return "foreground";
	if (effectiveFrame(p) === "desktop" && p.pid === undefined) return "foreground";
	return "background";
}

function frameForObserveView(view: ComputerObserveView): "window" | "desktop" {
	return view === "window" || view === "zoom" || view === "verify" ? "window" : "desktop";
}

function observeTarget(p: ComputerObserveParams): ComputerToolDetails["target"] {
	return {
		...(p.pid !== undefined ? { pid: p.pid } : {}),
		...(p.window_id !== undefined ? { windowId: p.window_id } : {}),
		frame: frameForObserveView(p.view),
	};
}

function actTarget(p: ComputerActParams): ComputerToolDetails["target"] {
	return {
		...(p.pid !== undefined ? { pid: p.pid } : {}),
		...(p.window_id !== undefined ? { windowId: p.window_id } : {}),
		frame: effectiveFrame(p),
	};
}

/** Re-shot long edge: max(reshotMinImageDimension, floor(longEdge × 0.75)), skipped when 0.75× falls below the floor or does not shrink. */
function reshotDimensionFor(longEdge: number): number | null {
	const target = Math.floor(longEdge * 0.75);
	if (target >= COMPUTER_USE_LIMITS.reshotMinImageDimension && target < longEdge) {
		return Math.max(COMPUTER_USE_LIMITS.reshotMinImageDimension, target);
	}
	return null;
}

function isDangerousAct(p: ComputerActParams): boolean {
	const chord = chordOf(p);
	return chord !== null && isDangerousHotkey(chord);
}

function formatAlternatives(groups: ReadonlyArray<ReadonlyArray<string>>): string {
	return groups.map((group) => (group.length === 0 ? "(no additional fields)" : group.join(" + "))).join(", or ");
}

function asComputerUseError(err: unknown): ComputerUseError {
	if (err instanceof ComputerUseError) return err;
	return new ComputerUseError("driver_error", errorText(err));
}

function serviceUnavailableError(): ComputerUseError {
	return new ComputerUseError("unavailable", "The computer-use service is not available.", "Check the computer-use settings and retry.");
}

function sessionNotReadyError(): ComputerUseError {
	return new ComputerUseError("unavailable", "The session is not ready yet.", "Retry after the session finishes starting.");
}

function screenshotToken(capture: CaptureOutcome): string {
	if (capture.image) return `${capture.image.width}x${capture.image.height}`;
	return `omitted:${capture.omittedReason ?? "unavailable"}`;
}

function screenshotDetails(capture: CaptureOutcome): ComputerToolDetails["screenshot"] {
	if (capture.image) {
		return { width: capture.image.width, height: capture.image.height, mimeType: capture.image.mimeType, bytes: capture.image.bytes };
	}
	if (capture.omittedForDetails) {
		return { width: 0, height: 0, mimeType: "", bytes: 0, omitted: capture.omittedForDetails };
	}
	return undefined;
}

function screenshotHint(capture: CaptureOutcome): string | undefined {
	if (capture.image) return undefined;
	switch (capture.omittedReason) {
		case "non_vision_model":
			return "The current model does not accept image input; rely on element_token handles from the accessibility tree instead of coordinates.";
		case "images_blocked":
			return "Image input is blocked in settings, so no screenshot is attached; rely on element_token handles.";
		case "over_byte_budget":
			return "The screenshot exceeded the byte budget even after a re-shot at a smaller long edge; use the accessibility tree and element_token handles.";
		default:
			return undefined;
	}
}

/** Tree-coverage and verify annotations appended after the driver text. */
function observeNotes(observation: BackendObservation): string[] {
	const notes: string[] = [];
	const tree = observation.tree;
	if (tree?.truncated === true) {
		const reason = tree.truncationReason ?? "unknown reason";
		const returned = tree.returnedElements ?? "?";
		const total = tree.totalElements ?? "?";
		notes.push(`[pix] tree truncated (${reason}): returned ${returned}/${total} elements; use query or max_elements to narrow.`);
	}
	const verify = observation.verify;
	if (verify !== undefined) {
		let note = `[pix] verify status=${verify.status} stable=${verify.stable} samples=${verify.samples}`;
		for (const predicate of verify.predicates.slice(0, 8)) {
			note += ` predicate[${predicate.index}] ${predicate.status}`;
			if (predicate.status === "unknown" && predicate.unknownReason !== null) note += ` (${predicate.unknownReason})`;
			if (predicate.observed !== null) note += ` observed=${predicate.observed}`;
		}
		notes.push(note);
	}
	return notes;
}

/** Actions whose background delivery can silently no-op (foreground retry is the fallback). */
const BACKGROUND_CONFIRMABLE_ACTIONS: ReadonlySet<ComputerActParams["action"]> = new Set([
	"type_text", "click", "double_click", "right_click", "scroll", "drag", "press_key", "hotkey",
]);

/** Evidence and delivery/effect annotations appended after the action text. */
function actNotes(p: ComputerActParams, result: ActionOutcome): string[] {
	const notes: string[] = [];
	if (result.evidence !== undefined) {
		for (const item of result.evidence.slice(0, 4)) {
			const detail = item.detail === null ? "" : ` ${truncateNoteDetail(item.detail)}`;
			notes.push(`[pix] evidence: ${item.kind}${detail}`);
		}
	}
	if (p.action === "invoke_menu" && (result.effect === undefined || result.effect === "unverifiable" || result.effect === "suspected_noop")) {
		notes.push('[pix] menu popups are separate windows; call computer_observe view="windows" and observe the popup by pid/window_id, or view="desktop".');
	}
	if (
		result.deliveryMode === "background"
		&& (result.effect === "suspected_noop" || result.effect === "unverifiable")
		&& BACKGROUND_CONFIRMABLE_ACTIONS.has(p.action)
	) {
		notes.push('[pix] background input was not confirmed; re-observe, then retry the same action with delivery="foreground" if it had no effect.');
	}
	if (p.action === "drag" && result.effect !== "confirmed") {
		notes.push("[pix] drag selection was not confirmed; if no selection appears, use keyboard selection or click+shift-click.");
	}
	return notes;
}

function truncateNoteDetail(detail: string): string {
	return detail.length > 200 ? detail.slice(0, 200) : detail;
}

/** "<driver text, truncated>\n\n[<post text>]\n\n[pix] ...\n\n[notes]" (fixed skeleton). */
function composeText(driverText: string, postText: string | undefined, pixLine: string, notes: readonly string[]): string {
	const parts = [truncateObservationText(driverText.trim())];
	if (postText !== undefined && postText.trim().length > 0) parts.push(truncateObservationText(postText.trim()));
	parts.push(pixLine);
	for (const note of notes) {
		if (note.length > 0) parts.push(note);
	}
	return parts.filter((part) => part.length > 0).join("\n\n");
}

function truncateObservationText(text: string): string {
	const max = COMPUTER_USE_LIMITS.observationTextMaxChars;
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n[truncated]`;
}

function observeSummary(p: ComputerObserveParams): string {
	const target = p.pid !== undefined ? ` · pid ${p.pid}` : "";
	return `观察 ${p.view}${target}`;
}

function actSummary(p: ComputerActParams): string {
	switch (p.action) {
		case "click":
		case "double_click":
		case "right_click":
		case "move_cursor":
			return `${actionWord(p.action)} ${p.element_token ?? `${p.x ?? "?"},${p.y ?? "?"}`}`;
		case "type_text":
			return `输入文本（${(p.text ?? "").length} 字符）`;
		case "press_key":
			return `按键 ${[...(p.modifiers ?? []), p.key ?? ""].filter((key) => key.length > 0).join("+")}`;
		case "hotkey":
			return `热键 ${(p.keys ?? []).join("+")}`;
		case "scroll":
			return `滚动 ${p.direction ?? ""} ${p.amount ?? "?"}`;
		case "drag":
			return `拖拽 (${p.x ?? "?"},${p.y ?? "?"}) → (${p.to_x ?? "?"},${p.to_y ?? "?"})`;
		case "set_value":
			return `设置控件值 ${p.element_token ?? ""}`;
		case "invoke_menu":
			return `打开菜单 ${(p.menu_path ?? []).join(" > ")}`;
		case "launch_app":
			return `启动应用 ${p.app ?? ""}`;
		case "focus_window":
			return `聚焦窗口 pid ${p.pid ?? "?"}`;
		case "wait":
			return `等待 ${p.duration_ms ?? 0}ms`;
		default:
			return p.action;
	}
}

function actionWord(action: ComputerActParams["action"]): string {
	switch (action) {
		case "click":
			return "点击";
		case "double_click":
			return "双击";
		case "right_click":
			return "右键点击";
		default:
			return "移动光标到";
	}
}

/** Local wait: resolves early when the call is aborted (the caller then throws `cancelled`). */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0 || signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
