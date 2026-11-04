/**
 * Computer-use session controller tests.
 *
 * Pure Node, no Electron, no real driver: the controller is driven through
 * fakes for ComputerBackend / DesktopLease / TargetGuard / ScreenshotEncoder
 * and a minimal AgentSession stand-in. Covers the grant state
 * machine (every approval/unattended branch), guard ordering, invalid_params,
 * the desktop lease, the post-action observation, the over-budget re-shot,
 * image policy, persistence/hydrate, reconciliation read-back, halt
 * semantics, and the two tool definitions (schema bounds from
 * COMPUTER_USE_LIMITS, no top-level oneOf/anyOf, delegation to the controller).
 *
 * Run with: npm exec tsx -- src/main/__tests__/computer-use-session-controller.test.ts
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	AgentSession,
	ExtensionContext,
	RequestUserInputRequest,
	RequestUserInputResponse,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	COMPUTER_ACT_TOOL_NAME,
	COMPUTER_OBSERVE_TOOL_NAME,
	COMPUTER_USE_CUSTOM_TYPE,
	COMPUTER_USE_LIMITS,
	type ComputerActParams,
	type ComputerObserveParams,
	type ComputerToolDetails,
	type ResolvedComputerUseSettings,
} from "../../shared/computer-use-types.js";
import {
	ComputerUseError,
	type BackendActionResult,
	type BackendImage,
	type BackendObservation,
	type BackendSessionHandle,
	type ComputerBackend,
	type DesktopLease,
	type DesktopLeaseState,
	type EncodeResult,
	type TargetGuard,
} from "../computer-use/contracts.js";
import { createComputerActTool, createComputerObserveTool } from "../computer-use/computer-tools.js";
import { ComputerUseSessionController, type ComputerUseControllerEvent } from "../computer-use/session-controller.js";

// ============================================================================
// Harness (PASS/FAIL counters, same style as todo-ipc.test.ts)
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		passed++;
		console.log(`  PASS: ${message}`);
	} else {
		failed++;
		console.error(`  FAIL: ${message}`);
	}
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
	if (actual === expected) {
		passed++;
		console.log(`  PASS: ${message}`);
	} else {
		failed++;
		console.error(`  FAIL: ${message} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a === b) {
		passed++;
		console.log(`  PASS: ${message}`);
	} else {
		failed++;
		console.error(`  FAIL: ${message} - expected ${b}, got ${a}`);
	}
}

async function run(name: string, fn: () => Promise<void>): Promise<void> {
	console.log(`\n=== ${name} ===\n`);
	try {
		await fn();
	} catch (err) {
		failed++;
		console.error(`  FAIL: ${name} threw unexpectedly: ${String(err)}`);
	}
}

/** Await `promise`, expect a ComputerUseError and return it (null on mismatch). */
async function expectComputerUseError(promise: Promise<unknown>, code: string, message: string): Promise<ComputerUseError | null> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof ComputerUseError && err.code === code) {
			passed++;
			console.log(`  PASS: ${message}`);
			return err;
		}
		failed++;
		console.error(`  FAIL: ${message} - expected ComputerUseError(${code}), got ${String(err)}`);
		return null;
	}
	failed++;
	console.error(`  FAIL: ${message} - expected a rejection, call resolved`);
	return null;
}

function textOf(result: AgentToolResult<ComputerToolDetails>): string {
	const first = result.content[0];
	return first !== undefined && first.type === "text" ? first.text : "";
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!condition() && Date.now() - start < timeoutMs) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

// ============================================================================
// Fakes
// ============================================================================

function defaultObservation(): BackendObservation {
	return {
		text: "Window 77: 3 elements.",
		image: { data: "AAAA", mimeType: "image/png", width: 1280, height: 800 },
		captureId: "c_9",
		snapshotId: "snap-9",
		target: { pid: 4242, windowId: 77, frame: "window" },
		driverTool: "get_window_state",
	};
}

class FakeBackend implements ComputerBackend {
	readonly platform = "linux-x64" as const;
	readonly openLabels: string[] = [];
	readonly closedSessions: string[] = [];
	readonly observeCalls: Array<{ params: ComputerObserveParams; maxImageDimension: number; wantImage: boolean }> = [];
	readonly actCalls: ComputerActParams[] = [];
	readonly actSignals: Array<AbortSignal | undefined> = [];
	observeImpl: (params: ComputerObserveParams, maxImageDimension: number) => Promise<BackendObservation> = async () => defaultObservation();
	actImpl: (params: ComputerActParams) => Promise<BackendActionResult> = async (params) => ({
		text: `Performed ${params.action}.`,
		driverTool: params.action,
	});

	async openSession(label: string): Promise<BackendSessionHandle> {
		this.openLabels.push(label);
		return { driverSession: label };
	}

	async closeSession(handle: BackendSessionHandle): Promise<void> {
		this.closedSessions.push(handle.driverSession);
	}

	async observe(
		_handle: BackendSessionHandle,
		params: ComputerObserveParams,
		o: { maxImageDimension: number; wantImage: boolean; signal?: AbortSignal },
	): Promise<BackendObservation> {
		this.observeCalls.push({ params, maxImageDimension: o.maxImageDimension, wantImage: o.wantImage });
		return this.observeImpl(params, o.maxImageDimension);
	}

	async act(_handle: BackendSessionHandle, params: ComputerActParams, o?: { signal?: AbortSignal }): Promise<BackendActionResult> {
		this.actCalls.push(params);
		this.actSignals.push(o?.signal);
		return this.actImpl(params);
	}

	async checkPermissions(): Promise<{ missing: string[]; degraded: string[] }> {
		return { missing: [], degraded: [] };
	}

	supports(): boolean {
		return true;
	}
}

class FakeLease implements DesktopLease {
	holderId: string | null = null;
	acquiredAt: number | null = null;
	lastUsedAt: number | null = null;

	tryAcquire(holderId: string): boolean {
		if (this.holderId !== null && this.holderId !== holderId) return false;
		this.holderId = holderId;
		this.acquiredAt = Date.now();
		this.lastUsedAt = Date.now();
		return true;
	}

	release(holderId: string): void {
		if (this.holderId === holderId) {
			this.holderId = null;
			this.acquiredAt = null;
			this.lastUsedAt = null;
		}
	}

	forceRelease(): void {
		this.holderId = null;
	}

	getState(): DesktopLeaseState {
		return { holderId: this.holderId, acquiredAt: this.acquiredAt, lastUsedAt: this.lastUsedAt };
	}

	onChange(): () => void {
		return () => {};
	}
}

class FakeGuard implements TargetGuard {
	actError: ComputerUseError | null = null;
	observeError: ComputerUseError | null = null;

	assertActAllowed(): void {
		if (this.actError) throw this.actError;
	}

	assertObserveAllowed(): void {
		if (this.observeError) throw this.observeError;
	}
}

class FakeSession {
	readonly registry: Set<string>;
	activeTools: string[] = [];
	isStreaming = false;
	abortCalls = 0;
	readonly abortResolvers: Array<() => void> = [];
	mode: "approval" | "unattended" | "read-only" = "approval";
	blockImages = false;
	readonly settingsManager = {
		getExecutionMode: (): string => this.mode,
		getBlockImages: (): boolean => this.blockImages,
	};

	constructor(registry: string[]) {
		this.registry = new Set(registry);
	}

	getActiveToolNames(): string[] {
		return [...this.activeTools];
	}

	/** Mirrors AgentSession: unknown names are silently dropped (agent-session.ts:1254-1266). */
	setActiveToolsByName(names: string[]): void {
		this.activeTools = names.filter((name) => this.registry.has(name));
	}

	abort(): Promise<void> {
		this.abortCalls++;
		return new Promise<void>((resolve) => {
			this.abortResolvers.push(resolve);
		});
	}

	resolveAborts(): void {
		while (this.abortResolvers.length > 0) {
			this.abortResolvers.shift()?.();
		}
	}
}

class FakeSessionManager {
	branch: unknown[] = [];
	readonly appended: Array<{ customType: string; data: unknown }> = [];

	appendCustomEntry(customType: string, data?: unknown): string {
		this.appended.push({ customType, data });
		return `entry-${this.appended.length}`;
	}

	getBranch(): unknown[] {
		return this.branch;
	}

	getSessionId(): string {
		return "session-1";
	}
}

class FakeUserInput {
	readonly requests: RequestUserInputRequest[] = [];
	readonly signals: Array<AbortSignal | undefined> = [];
	handler: (request: RequestUserInputRequest, signal?: AbortSignal) => Promise<RequestUserInputResponse> = async (request) => ({
		id: request.id,
		answers: { computer_use_grant: "本会话允许" },
	});

	invoke = (request: RequestUserInputRequest, signal?: AbortSignal): Promise<RequestUserInputResponse> => {
		this.requests.push(request);
		this.signals.push(signal);
		return this.handler(request, signal);
	};
}

interface HarnessOptions {
	mode?: "approval" | "unattended" | "read-only";
	globalEnabled?: boolean;
	blockImages?: boolean;
	foreground?: boolean;
	planRestricted?: boolean;
	registry?: string[];
	branch?: unknown[];
	defaultSessionEnabled?: boolean;
	noSessionManager?: boolean;
	ensureReadyError?: ComputerUseError;
	/** Extra await INSIDE ensureReady after the call counter (parks the pipeline mid-service-start). */
	ensureReadyHook?: () => Promise<void>;
	encode?: (img: BackendImage, maxBytes: number) => Promise<EncodeResult>;
	userInput?: (request: RequestUserInputRequest, signal?: AbortSignal) => Promise<RequestUserInputResponse>;
}

interface Harness {
	controller: ComputerUseSessionController;
	backend: FakeBackend;
	lease: FakeLease;
	guard: FakeGuard;
	session: FakeSession;
	manager: FakeSessionManager;
	settings: ResolvedComputerUseSettings;
	userInput: FakeUserInput;
	events: ComputerUseControllerEvent[];
	flags: { foreground: boolean; planRestricted: boolean };
	clock: { t: number };
	encoderCalls: BackendImage[];
	ensureReadyCalls: { count: number };
}

function makeHarness(opts: HarnessOptions = {}): Harness {
	const backend = new FakeBackend();
	const lease = new FakeLease();
	const guard = new FakeGuard();
	const session = new FakeSession(opts.registry ?? [COMPUTER_OBSERVE_TOOL_NAME, COMPUTER_ACT_TOOL_NAME]);
	session.mode = opts.mode ?? "approval";
	session.blockImages = opts.blockImages ?? false;
	const manager = new FakeSessionManager();
	manager.branch = opts.branch ?? [];
	const settings: ResolvedComputerUseSettings = {
		enabled: opts.globalEnabled ?? true,
		driverPath: null,
		maxImageDimension: 1568,
		screenshotMaxBytes: 450_000,
		keepRecentScreenshots: 3,
		defaultSessionEnabled: opts.defaultSessionEnabled ?? false,
	};
	const userInput = new FakeUserInput();
	if (opts.userInput) userInput.handler = opts.userInput;
	const events: ComputerUseControllerEvent[] = [];
	const flags = { foreground: opts.foreground ?? true, planRestricted: opts.planRestricted ?? false };
	const clock = { t: 1000 };
	const encoderCalls: BackendImage[] = [];
	const ensureReadyCalls = { count: 0 };
	const controller = new ComputerUseSessionController({
		controllerId: "1",
		backend: () => backend,
		ensureReady: async () => {
			ensureReadyCalls.count++;
			if (opts.ensureReadyHook) await opts.ensureReadyHook();
			if (opts.ensureReadyError) throw opts.ensureReadyError;
		},
		lease,
		guard,
		encode: async (img, maxBytes) => {
			encoderCalls.push(img);
			if (opts.encode) return opts.encode(img, maxBytes);
			return { ok: true, data: img.data, mimeType: img.mimeType, width: img.width, height: img.height, bytes: img.data.length };
		},
		getSettings: () => settings,
		getSession: () => (session as unknown as AgentSession),
		getSessionManager: () => (opts.noSessionManager ? null : (manager as unknown as SessionManager)),
		isForeground: () => flags.foreground,
		requestUserInput: (request, signal) => userInput.invoke(request, signal),
		isPlanRestricted: () => flags.planRestricted,
		emit: (event) => events.push(event),
		now: () => clock.t,
	});
	return { controller, backend, lease, guard, session, manager, settings, userInput, events, flags, clock, encoderCalls, ensureReadyCalls };
}

function makeCtx(input: ("text" | "image")[] = ["text", "image"]): ExtensionContext {
	return { model: { input } } as unknown as ExtensionContext;
}

function customEntry(data: unknown, id: string): unknown {
	return { type: "custom", customType: COMPUTER_USE_CUSTOM_TYPE, data, id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
}

function messageEntry(id: string): unknown {
	return { type: "message", message: { role: "user", content: "hi" }, id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
}

/** Enable the session toggle through the public path (also reconciles tools). */
function enableSession(h: Harness): void {
	h.controller.setSessionEnabled(true);
}

// ============================================================================
// Tests: grant state machine
// ============================================================================

await run("grant: approval prompts with 3 options, prompt id and session-level grant", async () => {
	const h = makeHarness();
	enableSession(h);
	const result = await h.controller.observe("obs-1", { view: "apps" }, undefined, makeCtx());
	assertEqual(h.userInput.requests.length, 1, "observe prompts once in approval mode");
	const request = h.userInput.requests[0];
	assertEqual(request.id, "computer-use-grant:obs-1", "request id is computer-use-grant:<toolCallId>");
	assertEqual(request.questions.length, 1, "one question");
	assertEqual(request.questions[0].id, "computer_use_grant", "question id");
	assertEqual(request.questions[0].header, "电脑操控", "question header");
	assertEqual(request.questions[0].options?.length, 3, "three options");
	assertDeepEqual(
		request.questions[0].options?.map((option) => option.label),
		["本会话允许", "仅本次允许", "拒绝"],
		"option labels",
	);
	assert(request.questions[0].question.includes("后台方式"), "background question wording");
	assert(request.questions[0].question.includes("观察 apps"), "question carries the action summary");
	assertEqual(h.controller.getSnapshot()?.grant, "background", "本会话允许 raises the level to background");
	assert(textOf(result).includes("[pix] snapshot_id=snap-9 capture_id=c_9 frame=desktop screenshot=1280x800 grant=background"), "observe pix line");

	await h.controller.observe("obs-2", { view: "apps" }, undefined, makeCtx());
	assertEqual(h.userInput.requests.length, 1, "an already-granted call does not prompt again");
});

await run("grant: cancelled:true with empty answers → user_denied and no second prompt", async () => {
	const h = makeHarness({
		userInput: async (request) => ({ id: request.id, answers: {}, cancelled: true }),
	});
	enableSession(h);
	const error = await expectComputerUseError(
		h.controller.observe("obs-1", { view: "apps" }, undefined, makeCtx()),
		"user_denied",
		"cancelled response is user_denied",
	);
	assert(error !== null && error.message.startsWith("[computer_use:user_denied]"), "model-visible text carries the code prefix");
	assertEqual(h.controller.getSnapshot()?.grant, "none", "cancelled response does not raise the level");

	await expectComputerUseError(h.controller.observe("obs-2", { view: "apps" }, undefined, makeCtx()), "user_denied", "deniedThisRun blocks the next call");
	assertEqual(h.userInput.requests.length, 1, "no second prompt after a denial in the same run");
});

await run("grant: cancelled:true with partial answers still → user_denied (cancelled wins)", async () => {
	const h = makeHarness({
		userInput: async (request) => ({ id: request.id, answers: { computer_use_grant: "本会话允许" }, cancelled: true }),
	});
	enableSession(h);
	await expectComputerUseError(h.controller.observe("obs-1", { view: "apps" }, undefined, makeCtx()), "user_denied", "cancelled beats a present answer");
	assertEqual(h.controller.getSnapshot()?.grant, "none", "no grant raised");
});

await run("grant: free-text answer → user_denied with the text in the detail", async () => {
	const h = makeHarness({
		userInput: async (request) => ({ id: request.id, answers: { computer_use_grant: "别动我的电脑" } }),
	});
	enableSession(h);
	const error = await expectComputerUseError(h.controller.observe("obs-1", { view: "apps" }, undefined, makeCtx()), "user_denied", "free text is a denial");
	assert(error !== null && error.detail.includes("别动我的电脑"), "free text is attached as user feedback");
});

await run("grant: requestUserInput reject + aborted signal → cancelled (deniedThisRun untouched)", async () => {
	const abort = new AbortController();
	const h = makeHarness({
		userInput: async () => {
			throw new Error("request_user_input was aborted.");
		},
	});
	enableSession(h);
	const promise = h.controller.observe("obs-1", { view: "apps" }, abort.signal, makeCtx());
	abort.abort();
	await expectComputerUseError(promise, "cancelled", "aborted prompt is cancelled");
	assert(h.userInput.signals[0] !== undefined && h.userInput.signals[0].aborted, "aborting the tool signal aborts the (merged) signal forwarded to requestUserInput");
	assertEqual(h.controller.getSnapshot()?.grant, "none", "no grant raised");

	// deniedThisRun must NOT be set: the next call prompts again and can be denied explicitly.
	h.userInput.handler = async (request) => ({ id: request.id, answers: { computer_use_grant: "拒绝" } });
	await expectComputerUseError(h.controller.observe("obs-2", { view: "apps" }, undefined, makeCtx()), "user_denied", "explicit deny after an abort");
	assertEqual(h.userInput.requests.length, 2, "the abort did not set deniedThisRun (a second prompt happened)");
});

await run("grant: requestUserInput reject without abort → cancelled with the reason in the detail", async () => {
	const h = makeHarness({
		userInput: async () => {
			throw new Error("Session closed before user input was provided.");
		},
	});
	enableSession(h);
	const error = await expectComputerUseError(h.controller.observe("obs-1", { view: "apps" }, undefined, makeCtx()), "cancelled", "queue-closed reject is cancelled");
	assert(error !== null && error.detail.includes("Session closed before user input was provided."), "detail carries the rejection reason");
	assertEqual(h.userInput.requests.length, 1, "only one prompt was attempted");
});

await run("grant: approval dangerous hotkey prompts 2 options even when already granted", async () => {
	const h = makeHarness();
	enableSession(h);
	h.userInput.handler = async (request) => ({
		id: request.id,
		answers: { computer_use_grant: request.questions[0].options?.some((option) => option.label === "本会话允许") ? "本会话允许" : "仅本次允许" },
	});
	// Raise the level to foreground first (focus_window requires foreground).
	await h.controller.act("act-grant", { action: "focus_window", pid: 4242 }, undefined, makeCtx());
	assertEqual(h.controller.getSnapshot()?.grant, "foreground", "focus_window raised the grant to foreground");
	assertEqual(h.userInput.requests[0].questions[0].options?.length, 3, "foreground act prompted with 3 options");
	assertEqual(h.userInput.requests[0].questions[0].question.includes("前台方式"), true, "foreground question wording");

	await h.controller.act("act-hotkey", { action: "hotkey", keys: ["alt", "f4"], pid: 4242 }, undefined, makeCtx());
	assertEqual(h.userInput.requests.length, 2, "dangerous hotkey prompts again despite the foreground grant");
	const options = h.userInput.requests[1].questions[0].options?.map((option) => option.label);
	assertDeepEqual(options, ["仅本次允许", "拒绝"], "dangerous prompt drops 本会话允许 (2 options)");
	assertEqual(h.userInput.requests[1].id, "computer-use-grant:act-hotkey", "dangerous prompt id");
	assertEqual(h.userInput.requests[1].questions[0].question.includes("后台方式"), true, "dangerous prompt wording");
	assertEqual(h.controller.getSnapshot()?.grant, "foreground", "仅本次允许 keeps the session level unchanged");
	assertEqual(h.backend.actCalls.length, 2, "both confirmed acts reached the backend (the hotkey needed per-call consent)");
});

await run("grant: unattended auto-raises without prompting; dangerous hotkey is blocked", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	await h.controller.act("act-1", { action: "click", pid: 4242, window_id: 77, element_token: "s1a2b3c4d:5" }, undefined, makeCtx());
	assertEqual(h.userInput.requests.length, 0, "unattended never prompts");
	assertEqual(h.controller.getSnapshot()?.grant, "background", "unattended auto-raised to the required level");

	await h.controller.act("act-2", { action: "focus_window", pid: 4242 }, undefined, makeCtx());
	assertEqual(h.controller.getSnapshot()?.grant, "foreground", "unattended auto-raised to foreground");

	const error = await expectComputerUseError(
		h.controller.act("act-3", { action: "hotkey", keys: ["alt", "f4"], pid: 4242 }, undefined, makeCtx()),
		"dangerous_action_blocked",
		"unattended dangerous hotkey is rejected",
	);
	assert(error !== null && error.hint !== undefined && error.hint.includes("invoke_menu"), "hint points at a non-hotkey route");

	// press_key with modifiers is the same chord (chordOf covers press_key + modifiers).
	await expectComputerUseError(
		h.controller.act("act-4", { action: "press_key", key: "f4", modifiers: ["alt"], pid: 4242 }, undefined, makeCtx()),
		"dangerous_action_blocked",
		"press_key+modifiers is recognised as the same dangerous chord",
	);
	await expectComputerUseError(
		h.controller.act("act-5", { action: "hotkey", keys: ["CTRL", "W"], pid: 4242 }, undefined, makeCtx()),
		"dangerous_action_blocked",
		"case-insensitive dangerous chord",
	);
	await expectComputerUseError(
		h.controller.act("act-6", { action: "hotkey", keys: ["win", "q"], pid: 4242 }, undefined, makeCtx()),
		"dangerous_action_blocked",
		"win≡cmd alias",
	);
	await h.controller.act("act-7", { action: "hotkey", keys: ["ctrl", "c"], pid: 4242 }, undefined, makeCtx());
	assertEqual(h.backend.actCalls.length, 3, "non-dangerous chords still run (click + focus_window + ctrl+c)");

	// Empty modifier/key tokens are dropped during chord normalization: "+alt+f4" cannot dodge "alt+f4".
	await expectComputerUseError(
		h.controller.act("act-8", { action: "press_key", key: "f4", modifiers: ["", "alt"], pid: 4242 }, undefined, makeCtx()),
		"dangerous_action_blocked",
		"an empty modifier token cannot dodge the alt+f4 chord",
	);
	await expectComputerUseError(
		h.controller.act("act-9", { action: "hotkey", keys: ["", "alt", "f4"], pid: 4242 }, undefined, makeCtx()),
		"dangerous_action_blocked",
		"an empty hotkey key token cannot dodge the alt+f4 chord",
	);
});

await run("grant: read-only mode is rejected defensively", async () => {
	const h = makeHarness({ mode: "read-only" });
	enableSession(h);
	await expectComputerUseError(h.controller.act("act-1", { action: "click", x: 1, y: 2 }, undefined, makeCtx()), "session_disabled", "read-only act is session_disabled");
	assertEqual(h.userInput.requests.length, 0, "no prompt in read-only mode");
	assertEqual(h.backend.actCalls.length, 0, "nothing reached the backend");
});

await run("grant: launch_app without pid stays at the background level", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	await h.controller.act("a1", { action: "launch_app", app: "notepad.exe" }, undefined, makeCtx());
	assertEqual(h.controller.getSnapshot()?.grant, "background", "launch_app without pid requires only the background level");
	assertEqual(h.userInput.requests.length, 0, "unattended never prompts");

	await h.controller.act("a2", { action: "launch_app", app: "notepad.exe", delivery: "foreground" }, undefined, makeCtx());
	assertEqual(h.controller.getSnapshot()?.grant, "foreground", "delivery=foreground still raises launch_app to foreground");
});

await run("grant: disabling the session aborts a pending approval prompt as session_disabled", async () => {
	const h = makeHarness();
	enableSession(h);
	h.userInput.handler = () => new Promise<RequestUserInputResponse>(() => {}); // never settles while pending
	const pending = h.controller.act("a1", { action: "click", pid: 4242, window_id: 77, element_token: "s1a2b3c4d:5" }, undefined, makeCtx());
	await waitFor(() => h.userInput.requests.length === 1);
	assertEqual(h.userInput.requests.length, 1, "the prompt is pending");
	const forwarded = h.userInput.signals[0];
	assert(forwarded !== undefined && !forwarded.aborted, "the signal handed to requestUserInput is live while the prompt is pending");

	h.controller.setSessionEnabled(false);
	// The bridge dismisses its prompt entry only when the signal IT received
	// aborts: the controller-side disable must abort that (merged) signal too,
	// not just reject the local wrapper Promise.
	assertEqual(forwarded?.aborted, true, "the controller-side disable aborts the signal forwarded to requestUserInput");
	await expectComputerUseError(pending, "session_disabled", "a pending prompt rejects with session_disabled when the session is disabled");
	assertEqual(h.controller.getSnapshot()?.grant, "none", "no grant raised");
	assertEqual(h.backend.actCalls.length, 0, "the action never executed");
});

await run("grant: an answer landing after the disable never raises the grant", async () => {
	const h = makeHarness();
	enableSession(h);
	const answerBox: { resolve?: (response: RequestUserInputResponse) => void } = {};
	h.userInput.handler = () =>
		new Promise<RequestUserInputResponse>((resolve) => {
			answerBox.resolve = resolve;
		});
	const pending = h.controller.act("a1", { action: "click", pid: 4242, window_id: 77, element_token: "s1a2b3c4d:5" }, undefined, makeCtx());
	await waitFor(() => answerBox.resolve !== undefined);

	h.controller.setSessionEnabled(false);
	answerBox.resolve?.({ id: "stale", answers: { computer_use_grant: "本会话允许" } });
	await expectComputerUseError(pending, "session_disabled", "a stale 本会话允许 answer is rejected with session_disabled");
	assertEqual(h.controller.getSnapshot()?.grant, "none", "the grant was not raised by the stale answer");
	assertEqual(h.backend.actCalls.length, 0, "the action was not executed");

	// Re-enabling and asking again proves the session-level grant is still none.
	h.controller.setSessionEnabled(true);
	h.userInput.handler = async (request) => ({ id: request.id, answers: { computer_use_grant: "本会话允许" } });
	await h.controller.observe("o1", { view: "apps" }, undefined, makeCtx());
	assertEqual(h.userInput.requests.length, 2, "the next background call prompts again (the grant was never raised)");
	assertEqual(h.controller.getSnapshot()?.grant, "background", "only the fresh answer raises the grant");
});

await run("grant: 仅本次允许 at background level leaves the session grant at none", async () => {
	const h = makeHarness();
	enableSession(h);
	h.userInput.handler = async (request) => ({ id: request.id, answers: { computer_use_grant: "仅本次允许" } });
	// observe requires background: the first prompt arrives while the grant is none.
	await h.controller.observe("obs-1", { view: "apps" }, undefined, makeCtx());
	assertEqual(h.controller.getSnapshot()?.grant, "none", "仅本次允许 does not raise the session-level grant");
	assertEqual(h.backend.observeCalls.length, 1, "the one-off consent still executes the call");
	// No session-level grant -> the next background call must prompt again instead of passing silently.
	await h.controller.observe("obs-2", { view: "apps" }, undefined, makeCtx());
	assertEqual(h.userInput.requests.length, 2, "the next background-level call prompts again");
	assertEqual(h.controller.getSnapshot()?.grant, "none", "still none after a second one-off consent");
	assertEqual(h.backend.observeCalls.length, 2, "the second one-off consent also executes");
});

await run("grant: an answer landing after a GLOBAL disable is rejected by the entry re-check", async () => {
	const h = makeHarness();
	enableSession(h);
	const answerBox: { resolve?: (response: RequestUserInputResponse) => void } = {};
	h.userInput.handler = () =>
		new Promise<RequestUserInputResponse>((resolve) => {
			answerBox.resolve = resolve;
		});
	const pending = h.controller.observe("o1", { view: "apps" }, undefined, makeCtx());
	await waitFor(() => answerBox.resolve !== undefined);

	// Global off does NOT abort the pending prompt (no promptAbort fires): the
	// bridge promise resolves normally and only the _assertActive() re-check
	// after the await can stop the call (distinct from the session-disable path).
	h.settings.enabled = false;
	answerBox.resolve?.({ id: "stale", answers: { computer_use_grant: "本会话允许" } });
	await expectComputerUseError(pending, "global_disabled", "a normal answer landing after a global disable is rejected with global_disabled");
	assertEqual(h.controller.getSnapshot()?.grant, "none", "the grant was not raised by the late answer");
	assertEqual(h.backend.observeCalls.length, 0, "no observation ran");
});

await run("grant: onUserTurnStart clears deniedThisRun so a new turn prompts again", async () => {
	const h = makeHarness();
	enableSession(h);
	h.userInput.handler = async (request) => ({ id: request.id, answers: { computer_use_grant: "拒绝" } });
	await expectComputerUseError(h.controller.observe("o1", { view: "apps" }, undefined, makeCtx()), "user_denied", "explicit denial");
	await expectComputerUseError(h.controller.observe("o2", { view: "apps" }, undefined, makeCtx()), "user_denied", "deniedThisRun blocks the next call without prompting");
	assertEqual(h.userInput.requests.length, 1, "no second prompt within the denied run");

	h.controller.onUserTurnStart();
	h.userInput.handler = async (request) => ({ id: request.id, answers: { computer_use_grant: "本会话允许" } });
	await h.controller.observe("o3", { view: "apps" }, undefined, makeCtx());
	assertEqual(h.userInput.requests.length, 2, "the new user turn prompts again");
	assertEqual(h.controller.getSnapshot()?.grant, "background", "the fresh answer raises the grant");
});

// ============================================================================
// Tests: guard ordering / params / lease
// ============================================================================

await run("guards: 全局 → 会话 → 前台 → halted → plan", async () => {
	const h = makeHarness({ globalEnabled: false, foreground: false, planRestricted: true });
	await expectComputerUseError(h.controller.observe("o1", { view: "apps" }, undefined, makeCtx()), "global_disabled", "global switch first");

	h.settings.enabled = true;
	await expectComputerUseError(h.controller.observe("o2", { view: "apps" }, undefined, makeCtx()), "session_disabled", "session switch second");

	enableSession(h);
	await expectComputerUseError(h.controller.observe("o3", { view: "apps" }, undefined, makeCtx()), "not_foreground", "foreground third");

	h.flags.foreground = true;
	h.controller.halt();
	const halted = await expectComputerUseError(h.controller.observe("o4", { view: "apps" }, undefined, makeCtx()), "halted", "halted fourth");
	assert(halted !== null && halted.detail.includes("emergency stop"), "halted detail");
	h.session.resolveAborts();

	h.controller.onUserTurnStart();
	const plan = await expectComputerUseError(h.controller.observe("o5", { view: "apps" }, undefined, makeCtx()), "unavailable", "plan restriction fifth");
	assert(plan !== null && plan.detail.includes("plan mode"), "plan detail mentions plan mode");
	assertEqual(h.backend.observeCalls.length, 0, "no backend call while guarded");
});

await run("params: missingRequiredFields drives invalid_params with the alternatives", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	const actError = await expectComputerUseError(
		h.controller.act("a1", { action: "invoke_menu", pid: 1 }, undefined, makeCtx()),
		"invalid_params",
		"invoke_menu without window_id/menu_path is invalid_params",
	);
	assert(actError !== null && actError.detail.includes("pid + window_id + menu_path"), "act error lists the required group");

	const observeError = await expectComputerUseError(
		h.controller.observe("o1", { view: "zoom", pid: 1, window_id: 2 }, undefined, makeCtx()),
		"invalid_params",
		"zoom without region is invalid_params",
	);
	assert(observeError !== null && observeError.detail.includes("pid + window_id + region"), "observe error lists the required group");
	assertEqual(h.backend.actCalls.length + h.backend.observeCalls.length, 0, "invalid params never reach the backend");
});

await run("act: wait never starts the driver; missing fields are checked before ensureReady", async () => {
	// (a) wait is fully local: it succeeds even when ensureReady would reject
	// (e.g. missing OS permissions would otherwise fail as permission_required).
	const h = makeHarness({
		mode: "unattended",
		ensureReadyError: new ComputerUseError("permission_required", "screen recording permission is missing."),
	});
	enableSession(h);
	const waited = await h.controller.act("a1", { action: "wait", duration_ms: 0 }, undefined, makeCtx());
	assert(textOf(waited).includes("Waited 0 ms."), "wait succeeds while ensureReady would reject");
	assertEqual(h.ensureReadyCalls.count, 0, "wait never calls ensureReady");
	assertEqual(h.backend.actCalls.length, 0, "wait stays local");

	// (b) invalid params are rejected before the driver is started (no launch side effect).
	await expectComputerUseError(
		h.controller.act("a2", { action: "click" }, undefined, makeCtx()),
		"invalid_params",
		"click without token/coordinates is invalid_params",
	);
	assertEqual(h.ensureReadyCalls.count, 0, "invalid params never call ensureReady");
	assertEqual(h.backend.openLabels.length, 0, "invalid params never open a driver session");
});

await run("observe: missing fields and guard rejections are checked before ensureReady", async () => {
	// ensureReadyError makes any ensureReady call surface as permission_required,
	// so the assertions below prove the checks stayed local (mirrors the act-side
	// test above; ensureReady has driver-launch side effects).
	const h = makeHarness({
		mode: "unattended",
		ensureReadyError: new ComputerUseError("permission_required", "screen recording permission is missing."),
	});
	enableSession(h);
	await expectComputerUseError(
		h.controller.observe("o1", { view: "zoom", pid: 1, window_id: 2 }, undefined, makeCtx()),
		"invalid_params",
		"zoom without region is invalid_params",
	);
	assertEqual(h.ensureReadyCalls.count, 0, "invalid observe params never call ensureReady");
	assertEqual(h.backend.openLabels.length, 0, "invalid observe params never open a driver session");

	h.guard.observeError = new ComputerUseError(
		"self_target",
		"PiX window is focused; observing would capture PiX.",
		"Call computer_observe with pid/window_id of the target window instead.",
	);
	await expectComputerUseError(
		h.controller.observe("o2", { view: "window", pid: 1, window_id: 2 }, undefined, makeCtx()),
		"self_target",
		"the PiX-pid guard rejection is self_target",
	);
	assertEqual(h.ensureReadyCalls.count, 0, "a guard rejection never calls ensureReady");
	assertEqual(h.backend.observeCalls.length, 0, "nothing reached the backend after a guard rejection");
});

await run("lease: desktop_busy on conflict, wait needs no lease and no driver call", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	h.lease.holderId = "other-controller";

	await expectComputerUseError(
		h.controller.act("a1", { action: "click", pid: 1, window_id: 2, element_token: "s1a2b3c4d:5" }, undefined, makeCtx()),
		"desktop_busy",
		"another holder → desktop_busy",
	);
	assertEqual(h.backend.actCalls.length, 0, "backend.act not called on desktop_busy");

	const waited = await h.controller.act("a2", { action: "wait", duration_ms: 1 }, undefined, makeCtx());
	assert(textOf(waited).includes("Waited 1 ms."), "wait returns the local text");
	assertEqual(h.backend.actCalls.length, 0, "wait does not call the driver");
	assertEqual(h.lease.holderId, "other-controller", "wait does not touch the lease");
	assertEqual(waited.details?.action, "wait", "wait details carry the action");

	// wait has required level "none": no prompt even in approval mode.
	const approval = makeHarness();
	enableSession(approval);
	const waited2 = await approval.controller.act("a3", { action: "wait", duration_ms: 0 }, undefined, makeCtx());
	assertEqual(approval.userInput.requests.length, 0, "wait never prompts");
	assert(textOf(waited2).includes("Waited 0 ms."), "zero-duration wait");
});

await run("authorization window: state changes during ensureReady abort the pipeline before the lease", async () => {
	// The per-call aborter + the post-await state recheck must cover
	// the ensureReady await - a background/disable/dispose that lands while the
	// service is starting may not be followed by a lease takeover or a backend
	// call once the await resolves.
	let releaseActReady: () => void = () => {};
	const actGate = new Promise<void>((resolve) => {
		releaseActReady = resolve;
	});
	const actHarness = makeHarness({ mode: "unattended", ensureReadyHook: () => actGate });
	enableSession(actHarness);
	const pendingAct = actHarness.controller.act("a1", { action: "click", pid: 1, window_id: 2, element_token: "s1a2b3c4d:5" }, undefined, makeCtx());
	await waitFor(() => actHarness.ensureReadyCalls.count === 1);
	actHarness.flags.foreground = false;
	actHarness.controller.onBackgrounded();
	releaseActReady();
	await expectComputerUseError(pendingAct, "not_foreground", "an act parked in ensureReady fails with not_foreground after backgrounding");
	assertEqual(actHarness.backend.actCalls.length, 0, "no backend act after backgrounding during ensureReady");
	assertEqual(actHarness.lease.holderId, null, "no lease taken after backgrounding during ensureReady");
	assertEqual(actHarness.backend.openLabels.length, 0, "no driver session opened");

	let releaseObserveReady: () => void = () => {};
	const observeGate = new Promise<void>((resolve) => {
		releaseObserveReady = resolve;
	});
	const observeHarness = makeHarness({ mode: "unattended", ensureReadyHook: () => observeGate });
	enableSession(observeHarness);
	const pendingObserve = observeHarness.controller.observe("o1", { view: "window", pid: 4242, window_id: 77 }, undefined, makeCtx());
	await waitFor(() => observeHarness.ensureReadyCalls.count === 1);
	observeHarness.flags.foreground = false;
	observeHarness.controller.onBackgrounded();
	releaseObserveReady();
	await expectComputerUseError(pendingObserve, "not_foreground", "an observe parked in ensureReady fails with not_foreground after backgrounding");
	assertEqual(observeHarness.backend.observeCalls.length, 0, "no backend observe after backgrounding during ensureReady");

	let releaseDisposeReady: () => void = () => {};
	const disposeGate = new Promise<void>((resolve) => {
		releaseDisposeReady = resolve;
	});
	const disposeHarness = makeHarness({ mode: "unattended", ensureReadyHook: () => disposeGate });
	enableSession(disposeHarness);
	const pendingDispose = disposeHarness.controller.act("d1", { action: "click", pid: 1, window_id: 2, element_token: "s1a2b3c4d:5" }, undefined, makeCtx());
	await waitFor(() => disposeHarness.ensureReadyCalls.count === 1);
	void disposeHarness.controller.dispose();
	releaseDisposeReady();
	await expectComputerUseError(pendingDispose, "unavailable", "an act parked in ensureReady fails after dispose");
	assertEqual(disposeHarness.backend.actCalls.length, 0, "no backend act after dispose during ensureReady");
	assertEqual(disposeHarness.lease.holderId, null, "no lease taken after dispose during ensureReady");
});

// ============================================================================
// Tests: examples and pipelines
// ============================================================================

await run("act: click with element_token assembles the result skeleton", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	h.backend.actImpl = async () => ({ text: "Clicked element s1a2b3c4d:5.", effect: "unverifiable", driverTool: "click" });
	const result = await h.controller.act("t1", { action: "click", pid: 4242, window_id: 77, element_token: "s1a2b3c4d:5" }, undefined, makeCtx());
	assertEqual(result.content.length, 2, "text + image content");
	assertEqual(result.content[1].type, "image", "second content block is the post-action screenshot");
	const text = textOf(result);
	assert(text.includes("[pix] capture_id=c_9 frame=window screenshot=1280x800 grant=background effect=unverifiable"), `pix line matches the locked skeleton (got: ${text})`);
	assertEqual(result.details?.kind, "act", "details.kind");
	assertEqual(result.details?.action, "click", "details.action");
	assertDeepEqual(result.details?.target, { pid: 4242, windowId: 77, frame: "window" }, "details.target");
	assertEqual(result.details?.captureId, "c_9", "details.captureId from the post-action observation");
	assertEqual(result.details?.snapshotId, "snap-9", "details.snapshotId from the post-action observation");
	assertDeepEqual(result.details?.screenshot, { width: 1280, height: 800, mimeType: "image/png", bytes: 4 }, "details.screenshot");
	assertEqual(result.details?.grant, "background", "details.grant");
	assertEqual(result.details?.driverTool, "click", "details.driverTool");
	assert(typeof result.details?.durationMs === "number" && result.details.durationMs >= 0, "details.durationMs");
	assertEqual(h.backend.actCalls.length, 1, "one act call reached the backend");
	assertEqual(h.backend.observeCalls.length, 1, "exactly one post-action observation");
	assertEqual(h.backend.observeCalls[0].params.view, "window", "post-action observation uses the window view");
	assertEqual(h.backend.observeCalls[0].params.pid, 4242, "post-action observation targets the same pid");
	assertEqual(h.backend.observeCalls[0].params.window_id, 77, "post-action observation targets the same window");
});

await run("observe: snapshot_id and capture_id in the pix line and details", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	h.backend.observeImpl = async () => ({
		text: "Tree.",
		image: null,
		captureId: "cap-42",
		snapshotId: "snap-42",
		target: { pid: 4242, windowId: 77, frame: "window" },
		driverTool: "get_window_state",
	});
	const result = await h.controller.observe("o1", { view: "window", pid: 4242, window_id: 77, screenshot: false }, undefined, makeCtx());
	const text = textOf(result);
	assert(
		text.includes("[pix] snapshot_id=snap-42 capture_id=cap-42 frame=window screenshot=omitted:not_requested grant=background"),
		`pix line carries snapshot_id and capture_id (got: ${text})`,
	);
	assertEqual(result.details?.snapshotId, "snap-42", "details.snapshotId");
	assertEqual(result.details?.captureId, "cap-42", "details.captureId");

	h.backend.observeImpl = async () => ({ text: "Apps.", image: null, driverTool: "list_apps" });
	const bare = await h.controller.observe("o2", { view: "apps" }, undefined, makeCtx());
	assert(textOf(bare).includes("[pix] snapshot_id=none capture_id=none frame=desktop"), "absent ids render as none");
});

await run("observe: tree truncation note", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	h.backend.observeImpl = async () => ({
		text: "Tree.",
		image: null,
		captureId: "c_1",
		snapshotId: "s_1",
		tree: {
			truncated: true,
			truncationReason: "element_cap",
			complete: false,
			totalElements: 120,
			returnedElements: 40,
			filteredElements: 0,
		},
		driverTool: "get_window_state",
	});
	const result = await h.controller.observe("o1", { view: "window", pid: 4242, window_id: 77, screenshot: false }, undefined, makeCtx());
	assert(
		textOf(result).includes("[pix] tree truncated (element_cap): returned 40/120 elements; use query or max_elements to narrow."),
		"tree truncated note appended",
	);
});

await run("observe: verify note includes status, samples and predicate reasons", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	h.backend.observeImpl = async () => ({
		text: "Verified.",
		image: null,
		captureId: "c_v",
		verify: {
			status: "unsatisfied",
			stable: false,
			samples: 2,
			elapsedMs: 15,
			predicates: [
				{ index: 0, status: "unknown", unknownReason: "window_not_found", observed: '{"a":1}' },
				{ index: 1, status: "satisfied", unknownReason: null, observed: null },
			],
		},
		driverTool: "verify_state",
	});
	const result = await h.controller.observe(
		"o1",
		{ view: "verify", pid: 4242, window_id: 77, expect: [{ window: { exists: true } }], screenshot: false },
		undefined,
		makeCtx(),
	);
	const text = textOf(result);
	assert(
		text.includes('[pix] verify status=unsatisfied stable=false samples=2 predicate[0] unknown (window_not_found) observed={"a":1} predicate[1] satisfied'),
		`verify note includes predicates and observed (got: ${text})`,
	);
});

await run("act: delivery / route / evidence are surfaced in the pix line and notes", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	h.backend.actImpl = async () => ({
		text: "Clicked.",
		effect: "unverifiable",
		deliveryMode: "foreground",
		route: "uia",
		evidence: [
			{ kind: "window_state", detail: "title changed" },
			{ kind: "screenshot", detail: null },
		],
		driverTool: "click",
	});
	const result = await h.controller.act("a1", { action: "click", pid: 4242, window_id: 77, element_token: "s1a2b3c4d:5" }, undefined, makeCtx());
	const text = textOf(result);
	assert(
		text.includes("[pix] capture_id=c_9 frame=window screenshot=1280x800 grant=background delivery=foreground route=uia effect=unverifiable"),
		`act pix line carries delivery/route (got: ${text})`,
	);
	assert(text.includes("[pix] evidence: window_state title changed"), "evidence with detail");
	assert(text.includes("[pix] evidence: screenshot"), "evidence without detail");
});

await run("act: invoke_menu unverified effect adds the popup note", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	h.backend.actImpl = async () => ({ text: "Opened.", effect: "unverifiable", driverTool: "invoke_menu" });
	const result = await h.controller.act(
		"a1",
		{ action: "invoke_menu", pid: 4242, window_id: 77, menu_path: ["File", "Save"] },
		undefined,
		makeCtx(),
	);
	assert(
		textOf(result).includes('[pix] menu popups are separate windows; call computer_observe view="windows" and observe the popup by pid/window_id, or view="desktop".'),
		"invoke_menu popup note",
	);
});

await run("act: background suspected_noop adds the foreground-retry note", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	h.backend.actImpl = async () => ({
		text: "Typed.",
		effect: "suspected_noop",
		deliveryMode: "background",
		driverTool: "type_text",
	});
	const result = await h.controller.act("a1", { action: "type_text", text: "hi", pid: 4242 }, undefined, makeCtx());
	assert(
		textOf(result).includes('[pix] background input was not confirmed; re-observe, then retry the same action with delivery="foreground" if it had no effect.'),
		"background retry note",
	);
});

await run("act: unconfirmed drag adds the selection fallback note", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	h.backend.actImpl = async () => ({
		text: "Dragged.",
		effect: "unverifiable",
		deliveryMode: "foreground",
		driverTool: "drag",
	});
	const result = await h.controller.act(
		"a1",
		{ action: "drag", x: 1, y: 2, to_x: 3, to_y: 4, pid: 4242, window_id: 77 },
		undefined,
		makeCtx(),
	);
	assert(
		textOf(result).includes("[pix] drag selection was not confirmed; if no selection appears, use keyboard selection or click+shift-click."),
		"drag selection fallback note",
	);
});

await run("params: verify element.exists=false is rejected before the service starts", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	const error = await expectComputerUseError(
		h.controller.observe(
			"o1",
			{ view: "verify", pid: 4242, window_id: 77, expect: [{ element: { selector: { role: "button" }, exists: false } }] },
			undefined,
			makeCtx(),
		),
		"invalid_params",
		"element.exists=false is invalid_params",
	);
	assert(error !== null && error.hint !== undefined && error.hint.includes("Remove the false expectation"), "hint explains the alternative");
	assertEqual(h.ensureReadyCalls.count, 0, "the service is never started");
	assertEqual(h.backend.observeCalls.length, 0, "the backend/driver is never called");
});

await run("act: type_text with PiX focused -> self_target from the guard", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	h.guard.actError = new ComputerUseError(
		"self_target",
		"PiX window is focused; typing would go into PiX.",
		"Call computer_act action=focus_window with the target pid first, or pass pid/window_id.",
	);
	const error = await expectComputerUseError(
		h.controller.act("t2", { action: "type_text", text: "hi" }, undefined, makeCtx()),
		"self_target",
		"guard rejection propagates",
	);
	assertEqual(
		error?.message,
		"[computer_use:self_target] PiX window is focused; typing would go into PiX.\nHint: Call computer_act action=focus_window with the target pid first, or pass pid/window_id.",
		"error.message is the model-visible text",
	);
	assertEqual(h.backend.actCalls.length, 0, "no backend call after a self_target rejection");
	assertEqual(h.lease.holderId, null, "no lease taken after a self_target rejection");
	assertEqual(h.userInput.requests.length, 0, "guard runs before the grant prompt");
});

await run("act: unattended alt+f4 -> dangerous_action_blocked with the code prefix", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	const error = await expectComputerUseError(
		h.controller.act("t3", { action: "hotkey", keys: ["alt", "f4"], pid: 4242 }, undefined, makeCtx()),
		"dangerous_action_blocked",
		"unattended dangerous hotkey",
	);
	assert(error !== null && error.message.startsWith("[computer_use:dangerous_action_blocked]"), "message prefix");
	assertEqual(h.backend.actCalls.length, 0, "the driver is never asked to run the hotkey");
});

await run("act: observe_after=false skips the post-observation; a failed post-observation only annotates", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	h.backend.actImpl = async () => ({ text: "Pressed Enter.", driverTool: "press_key" });
	const result = await h.controller.act("a1", { action: "press_key", key: "enter", pid: 4242 }, undefined, makeCtx());
	assertEqual(h.backend.observeCalls.length, 1, "post-observation runs by default");
	assert(textOf(result).includes("Pressed Enter."), "action text first");

	const noObs = await h.controller.act("a2", { action: "press_key", key: "enter", pid: 4242, observe_after: false }, undefined, makeCtx());
	assertEqual(h.backend.observeCalls.length, 1, "observe_after=false skips the post-observation");
	assert(textOf(noObs).includes("frame=window screenshot=omitted:not_requested"), "no-screenshot token without an observation");

	h.backend.observeImpl = async () => {
		throw new ComputerUseError("stale_reference", "stale window");
	};
	const failed = await h.controller.act("a3", { action: "press_key", key: "enter", pid: 4242 }, undefined, makeCtx());
	assertEqual(failed.details?.kind, "act", "act still succeeds");
	assert(textOf(failed).includes("post-action observation failed (stale_reference)"), "text annotates the failed post-observation");
	assertDeepEqual(failed.details?.target, { pid: 4242, frame: "window" }, "target falls back to the act params");
});

await run("observe: over_budget re-shoots at 0.75× long edge (768 → 576) but not at 600", async () => {
	// Case A: long edge 768 → re-shot long edge 576.
	const a = makeHarness({
		mode: "unattended",
		encode: async (img, maxBytes) =>
			img.width >= 768
				? { ok: false, reason: "over_budget", bytes: maxBytes + 1 }
				: { ok: true, data: img.data, mimeType: img.mimeType, width: img.width, height: img.height, bytes: img.data.length },
	});
	enableSession(a);
	a.backend.observeImpl = async (_params, maxImageDimension) => {
		const scale = maxImageDimension < 768 ? 0.75 : 1;
		return {
			text: "Observed.",
			image: { data: "B".repeat(20), mimeType: "image/png", width: Math.round(768 * scale), height: Math.round(600 * scale) },
			captureId: `c_${a.backend.observeCalls.length}`,
			driverTool: "get_window_state",
		};
	};
	const shot = await a.controller.observe("o1", { view: "window", pid: 4242, window_id: 77 }, undefined, makeCtx());
	assertEqual(a.backend.observeCalls.length, 2, "over budget triggers exactly one re-shot");
	assertEqual(a.backend.observeCalls[0].maxImageDimension, 1568, "first shot uses the settings long edge");
	assertEqual(a.backend.observeCalls[1].maxImageDimension, 576, "re-shot long edge is 0.75 × 768 = 576");
	assertEqual(shot.details?.screenshot?.width, 576, "re-shot image is the attached one");
	assert(textOf(shot).includes("screenshot=576x450"), "pix line reports the re-shot dimensions");

	// Case B: long edge 600 → 0.75× = 450 is below reshotMinImageDimension → no re-shot.
	const b = makeHarness({
		mode: "unattended",
		encode: async () => ({ ok: false, reason: "over_budget", bytes: 999_999 }),
	});
	enableSession(b);
	b.backend.observeImpl = async () => ({
		text: "Observed.",
		image: { data: "C".repeat(20), mimeType: "image/png", width: 600, height: 400 },
		captureId: "c_1",
		driverTool: "get_window_state",
	});
	const missed = await b.controller.observe("o1", { view: "window", pid: 4242, window_id: 77 }, undefined, makeCtx());
	assertEqual(b.backend.observeCalls.length, 1, "600 long edge does not re-shoot");
	assertEqual(missed.details?.screenshot, undefined, "no screenshot details after an unrecoverable over-budget image");
	assert(textOf(missed).includes("screenshot=omitted:over_byte_budget"), "text notes the byte budget");
	assertEqual(missed.content.length, 1, "no image content block");

	// Case C: the re-shot itself throws - the observation must still succeed with
	// the first text and degrade to the no-image path (omittedReason over_byte_budget).
	const c = makeHarness({
		mode: "unattended",
		encode: async () => ({ ok: false, reason: "over_budget", bytes: 999_999 }),
	});
	enableSession(c);
	let observeCalls = 0;
	c.backend.observeImpl = async () => {
		observeCalls++;
		if (observeCalls === 1) {
			return {
				text: "First observation text.",
				image: { data: "D".repeat(20), mimeType: "image/png", width: 1280, height: 800 },
				captureId: "c_first",
				driverTool: "get_window_state",
			};
		}
		throw new ComputerUseError("driver_error", "the re-shot exploded");
	};
	const degraded = await c.controller.observe("o1", { view: "window", pid: 4242, window_id: 77 }, undefined, makeCtx());
	assertEqual(c.backend.observeCalls.length, 2, "the re-shot was attempted exactly once");
	assert(textOf(degraded).includes("First observation text."), "the first observation text survives a failed re-shot");
	assert(textOf(degraded).includes("screenshot=omitted:over_byte_budget"), "pix line reports the byte budget omission");
	assertEqual(degraded.content.length, 1, "no image content block");
	assertEqual(degraded.details?.screenshot, undefined, "no screenshot details");
	assertEqual(degraded.details?.captureId, "c_first", "captureId comes from the surviving first observation");
});

await run("observe: image policy — non-vision, blocked images, screenshot:false", async () => {
	const nonVision = makeHarness({ mode: "unattended" });
	enableSession(nonVision);
	const result = await nonVision.controller.observe("o1", { view: "window", pid: 4242, window_id: 77 }, undefined, makeCtx(["text"]));
	assertEqual(nonVision.backend.observeCalls[0].wantImage, false, "non-vision model never requests an image");
	assertEqual(result.details?.screenshot?.omitted, "non_vision_model", "details.screenshot.omitted");
	assert(textOf(result).includes("screenshot=omitted:non_vision_model"), "pix line omitted token");
	assert(textOf(result).includes("does not accept image input"), "hint about element_token");
	assertEqual(result.content.length, 1, "no image block for a non-vision model");

	const blocked = makeHarness({ mode: "unattended", blockImages: true });
	enableSession(blocked);
	const blockedResult = await blocked.controller.observe("o1", { view: "window", pid: 4242, window_id: 77 }, undefined, makeCtx());
	assertEqual(blocked.backend.observeCalls[0].wantImage, false, "blockImages suppresses the request");
	assertEqual(blockedResult.details?.screenshot?.omitted, "images_blocked", "blocked reason recorded");

	const notRequested = makeHarness({ mode: "unattended" });
	enableSession(notRequested);
	const plain = await notRequested.controller.observe("o1", { view: "apps", screenshot: false }, undefined, makeCtx());
	assertEqual(notRequested.backend.observeCalls[0].wantImage, false, "screenshot:false suppresses the request");
	assertEqual(plain.details?.screenshot?.omitted, "not_requested", "not_requested reason recorded");
});

// ============================================================================
// Tests: persistence, reconcile, lifecycle
// ============================================================================

await run("hydrate: latest valid CustomEntry, unknown schemaVersion ignored, brand-new default", async () => {
	const latest = makeHarness({
		branch: [
			messageEntry("m1"),
			customEntry({ schemaVersion: 1, enabled: true, at: 1 }, "c1"),
			messageEntry("m2"),
			customEntry({ schemaVersion: 2, enabled: false, at: 2 }, "c2"),
		],
	});
	latest.controller.hydrate();
	assertEqual(latest.controller.isSessionEnabled(), true, "unknown schemaVersion entries are ignored");
	assertEqual(latest.controller.getSnapshot()?.sessionEnabled, true, "snapshot mirrors the hydrated value");

	const disabled = makeHarness({
		branch: [messageEntry("m1"), customEntry({ schemaVersion: 1, enabled: true, at: 1 }, "c1"), customEntry({ schemaVersion: 1, enabled: false, at: 2 }, "c2")],
	});
	disabled.controller.hydrate();
	assertEqual(disabled.controller.isSessionEnabled(), false, "the LAST valid entry wins");

	const brandNew = makeHarness({ branch: [], defaultSessionEnabled: true });
	brandNew.controller.hydrate();
	assertEqual(brandNew.controller.isSessionEnabled(), true, "brand-new session takes defaultSessionEnabled");

	const used = makeHarness({ branch: [messageEntry("m1")], defaultSessionEnabled: true });
	used.controller.hydrate();
	assertEqual(used.controller.isSessionEnabled(), false, "a used session without an entry is false");

	const noManager = makeHarness({ defaultSessionEnabled: true, noSessionManager: true });
	noManager.controller.hydrate();
	assertEqual(noManager.controller.isSessionEnabled(), true, "no session manager falls back to the default");
	assertEqual(noManager.controller.getSnapshot(), null, "no session manager → no snapshot");
});

await run("setSessionEnabled: persists the toggle entry and disabling revokes + reconciles immediately", async () => {
	const h = makeHarness();
	enableSession(h);
	assertEqual(h.manager.appended.length, 1, "enabling appends one CustomEntry");
	assertEqual(h.manager.appended[0].customType, COMPUTER_USE_CUSTOM_TYPE, "customType is pix-computer-use-v1");
	assertDeepEqual(h.manager.appended[0].data, { schemaVersion: 1, enabled: true, at: 1000 }, "entry data shape");
	assertDeepEqual(h.session.activeTools, [COMPUTER_OBSERVE_TOOL_NAME, COMPUTER_ACT_TOOL_NAME], "tools activated on enable");
	assertEqual(h.controller.getSnapshot()?.toolsActive, true, "snapshot reads toolsActive back");

	// Grant + lease, then disable.
	await h.controller.observe("o1", { view: "apps" }, undefined, makeCtx());
	assertEqual(h.controller.getSnapshot()?.grant, "background", "grant raised before disabling");
	await h.controller.act("a1", { action: "click", pid: 1, window_id: 2, element_token: "s1a2b3c4d:5" }, undefined, makeCtx());
	assertEqual(h.lease.holderId, "1", "lease held by the controller");

	h.controller.setSessionEnabled(false);
	assertEqual(h.manager.appended.length, 2, "disabling appends an entry");
	assertDeepEqual(h.manager.appended[1].data, { schemaVersion: 1, enabled: false, at: 1000 }, "disabled entry data");
	assertEqual(h.controller.getSnapshot()?.grant, "none", "disabling revokes grants");
	assertEqual(h.lease.holderId, null, "disabling releases the lease");
	assertEqual(h.session.activeTools.length, 0, "disabling removes the tools immediately");
	assertEqual(h.controller.getSnapshot()?.toolsActive, false, "toolsActive reads back false");
	assertEqual(h.controller.getSnapshot()?.inactiveReason, "session_disabled", "inactiveReason is session_disabled");
});

await run("reconcileTools: reads back getActiveToolNames and defers enabling while streaming", async () => {
	const h = makeHarness({ registry: [COMPUTER_OBSERVE_TOOL_NAME] });
	enableSession(h);
	assertDeepEqual(h.session.activeTools, [COMPUTER_OBSERVE_TOOL_NAME], "the registry silently dropped computer_act");
	assertEqual(h.controller.getSnapshot()?.toolsActive, false, "toolsActive is read back, never assumed");

	h.session.registry.add(COMPUTER_ACT_TOOL_NAME);
	h.controller.reconcileTools();
	assertEqual(h.controller.getSnapshot()?.toolsActive, true, "both tools active once the registry carries them");

	// Disable + enable while streaming: enabling is deferred to the next turn.
	h.session.activeTools = [];
	h.session.isStreaming = true;
	h.controller.reconcileTools();
	assertEqual(h.session.activeTools.length, 0, "enabling while streaming is deferred");

	h.session.isStreaming = false;
	h.controller.reconcileTools();
	assertEqual(h.session.activeTools.length, 2, "the next reconcile (before_agent_start) applies it");

	// Disabling applies immediately even while streaming.
	h.session.isStreaming = true;
	h.controller.setSessionEnabled(false);
	assertEqual(h.session.activeTools.length, 0, "disabling applies immediately while streaming");
});

await run("halt: synchronous, calls session.abort without awaiting, revokes and releases", async () => {
	const h = makeHarness();
	enableSession(h);
	await h.controller.observe("o1", { view: "apps" }, undefined, makeCtx());
	await h.controller.act("a1", { action: "click", pid: 1, window_id: 2, element_token: "s1a2b3c4d:5" }, undefined, makeCtx());
	assertEqual(h.lease.holderId, "1", "lease acquired before halt");

	h.controller.halt();
	// The abort promise is still pending: halt fired it without awaiting.
	assertEqual(h.session.abortCalls, 1, "session.abort was called exactly once");
	assertEqual(h.session.abortResolvers.length, 1, "the abort promise was not awaited (still pending)");
	assertEqual(h.controller.getSnapshot()?.halted, true, "halted flag is set synchronously");
	assertEqual(h.controller.getSnapshot()?.grant, "none", "halt revokes grants");
	assertEqual(h.lease.holderId, null, "halt releases the lease");
	// `halted` is not part of the reconcile target state: the tools stay mounted and
	// every call is refused by the execute guard until the next user prompt.
	assertEqual(h.session.activeTools.length, 2, "halt keeps the tools mounted; the execute guard is authoritative");

	await expectComputerUseError(h.controller.observe("o2", { view: "apps" }, undefined, makeCtx()), "halted", "calls are halted");
	h.controller.onUserTurnStart();
	assertEqual(h.controller.getSnapshot()?.halted, false, "onUserTurnStart clears halted");
	h.session.resolveAborts();
	await Promise.resolve();

	await h.controller.observe("o3", { view: "apps" }, undefined, makeCtx());
	assertEqual(h.lease.holderId, null, "observe never takes the lease");
});

await run("backgrounding: revoke + release + reconcile; foregrounding: hydrate + reconcile", async () => {
	const h = makeHarness({ branch: [customEntry({ schemaVersion: 1, enabled: true, at: 1 }, "c1")] });
	h.controller.hydrate();
	enableSession(h);
	await h.controller.observe("o1", { view: "apps" }, undefined, makeCtx());
	await h.controller.act("a1", { action: "click", pid: 1, window_id: 2, element_token: "s1a2b3c4d:5" }, undefined, makeCtx());
	assertEqual(h.lease.holderId, "1", "lease held before backgrounding");

	h.flags.foreground = false;
	h.controller.onBackgrounded();
	assertEqual(h.controller.getSnapshot()?.grant, "none", "backgrounding revokes grants");
	assertEqual(h.lease.holderId, null, "backgrounding releases the lease");
	assertEqual(h.session.activeTools.length, 0, "backgrounding deactivates the tools");
	await expectComputerUseError(h.controller.observe("o2", { view: "apps" }, undefined, makeCtx()), "not_foreground", "background calls are rejected");

	h.flags.foreground = true;
	h.controller.onForegrounded();
	assertEqual(h.controller.isSessionEnabled(), true, "foregrounding re-hydrates from the branch");
	assertEqual(h.session.activeTools.length, 2, "foregrounding reactivates the tools");
});

await run("revokeGrants: level drops to none and the next call prompts again", async () => {
	const h = makeHarness();
	enableSession(h);
	await h.controller.observe("o1", { view: "apps" }, undefined, makeCtx());
	assertEqual(h.controller.getSnapshot()?.grant, "background", "granted");
	h.controller.revokeGrants();
	assertEqual(h.controller.getSnapshot()?.grant, "none", "revoked");
	await h.controller.observe("o2", { view: "apps" }, undefined, makeCtx());
	assertEqual(h.userInput.requests.length, 2, "the next call prompts again after a revoke");
});

await run("dispose: end_session with the opened label, release, idempotent", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	await h.controller.observe("o1", { view: "apps" }, undefined, makeCtx());
	await h.controller.act("a1", { action: "click", pid: 1, window_id: 2, element_token: "s1a2b3c4d:5" }, undefined, makeCtx());
	assertEqual(h.backend.openLabels.length, 1, "one driver session opened lazily");
	assert(/^pix-1-[0-9a-f]{8}$/.test(h.backend.openLabels[0]), `driver session label is pix-<genId>-<8hex> (got ${h.backend.openLabels[0]})`);

	await h.controller.dispose();
	assertEqual(h.backend.closedSessions.length, 1, "dispose ends the driver session");
	assertEqual(h.backend.closedSessions[0], h.backend.openLabels[0], "the same session handle is closed");
	assertEqual(h.lease.holderId, null, "dispose releases the lease");
	await h.controller.dispose();
	assertEqual(h.backend.closedSessions.length, 1, "dispose is idempotent");
});

await run("activity events: running → succeeded, and failed with the error code", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	await h.controller.observe("o1", { view: "apps" }, undefined, makeCtx());
	const activities = h.events.filter((event) => event.type === "activity");
	assertEqual(activities.length, 2, "one running + one terminal activity event");
	assertEqual(activities[0].type === "activity" ? activities[0].activity.state : "", "running", "first activity is running");
	assertEqual(activities[1].type === "activity" ? activities[1].activity.state : "", "succeeded", "second activity is succeeded");
	assertEqual(activities[0].type === "activity" ? activities[0].activity.tool : "", "observe", "activity tool");
	assertEqual(activities[0].type === "activity" ? activities[0].sessionId : "", "session-1", "activity carries the session id");
	assert(activities[0].type === "activity" && activities[0].activity.summary.includes("apps"), "activity summary is human readable");
	assert(h.events.some((event) => event.type === "session_state" && event.controllerId === "1"), "session_state events are emitted");

	const failing = makeHarness({ mode: "unattended" });
	enableSession(failing);
	failing.guard.observeError = new ComputerUseError("self_target", "no");
	await expectComputerUseError(failing.controller.observe("o2", { view: "window", pid: 1, window_id: 2 }, undefined, makeCtx()), "self_target", "guard failure");
	const failedEvent = failing.events.filter((event) => event.type === "activity").at(-1);
	assertEqual(failedEvent?.type === "activity" ? failedEvent.activity.state : "", "failed", "failure marks the activity failed");
	assertEqual(failedEvent?.type === "activity" ? failedEvent.activity.errorCode : "", "self_target", "activity carries the error code");
});

await run("abort plumbing: halt aborts an in-flight act with cancelled semantics", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	h.backend.actImpl = async () => {
		const signal = h.backend.actSignals[0];
		return new Promise<BackendActionResult>((_resolve, reject) => {
			signal?.addEventListener("abort", () => reject(new ComputerUseError("cancelled", "call aborted")), { once: true });
		});
	};
	const pending = h.controller.act("a1", { action: "click", pid: 1, window_id: 2, element_token: "s1a2b3c4d:5", observe_after: false }, undefined, makeCtx());
	await waitFor(() => h.backend.actSignals.length === 1);
	assertEqual(h.backend.actSignals.length, 1, "the act reached the backend before halt");
	h.controller.halt();
	h.session.resolveAborts();
	const error = await expectComputerUseError(pending, "cancelled", "in-flight act is cancelled by halt");
	assert(error !== null && error.detail.includes("may have been partially executed"), "cancelled detail warns about partial execution");
	assertEqual(h.lease.holderId, null, "lease released by halt");
});

await run("abort plumbing: halt interrupts a local wait with cancelled semantics", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	const pending = h.controller.act("a1", { action: "wait", duration_ms: COMPUTER_USE_LIMITS.waitMaxMs }, undefined, makeCtx());
	await waitFor(() => h.events.some((event) => event.type === "activity"));

	h.controller.halt();
	h.session.resolveAborts();
	const error = await expectComputerUseError(pending, "cancelled", "a halt-interrupted wait rejects with cancelled");
	assert(error !== null && error.detail.includes("aborted before it finished"), "wait cancellation detail");
	const last = h.events.filter((event) => event.type === "activity").at(-1);
	assertEqual(last?.type === "activity" ? last.activity.state : "", "cancelled", "the activity ends in state cancelled");
	assertEqual(h.backend.actCalls.length, 0, "wait never reached the backend");
});

await run("act: driver_crashed warns about partial execution and reopens the driver session", async () => {
	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	await h.controller.act("a1", { action: "press_key", key: "enter", pid: 4242, observe_after: false }, undefined, makeCtx());
	assertEqual(h.backend.openLabels.length, 1, "one driver session opened");

	h.backend.actImpl = async () => {
		throw new ComputerUseError("driver_crashed", "driver process exited unexpectedly");
	};
	const error = await expectComputerUseError(
		h.controller.act("a2", { action: "press_key", key: "enter", pid: 4242, observe_after: false }, undefined, makeCtx()),
		"driver_crashed",
		"driver_crashed propagates",
	);
	assert(error !== null && error.detail.includes("may have been partially executed"), "detail warns the action may have been partially executed");
	assertEqual(h.backend.openLabels.length, 1, "no extra session opened while crashing");

	// The crash drops the backend handle: the next act goes through start_session again.
	h.backend.actImpl = async (params) => ({ text: `Performed ${params.action}.`, driverTool: params.action });
	await h.controller.act("a3", { action: "press_key", key: "enter", pid: 4242, observe_after: false }, undefined, makeCtx());
	assertEqual(h.backend.openLabels.length, 2, "the next act reopens a driver session");
});

// ============================================================================
// Tests: tool definitions
// ============================================================================

await run("tools: names, labels, sequential mode and no top-level oneOf/anyOf", async () => {
	const h = makeHarness();
	const observe = createComputerObserveTool(h.controller);
	const act = createComputerActTool(h.controller);
	assertEqual(observe.name, COMPUTER_OBSERVE_TOOL_NAME, "observe tool name");
	assertEqual(act.name, COMPUTER_ACT_TOOL_NAME, "act tool name");
	assertEqual(observe.label, "观察电脑", "observe label");
	assertEqual(act.label, "操作电脑", "act label");
	assertEqual(observe.executionMode, "sequential", "observe is sequential");
	assertEqual(act.executionMode, "sequential", "act is sequential");
	assert(observe.promptSnippet !== undefined && !observe.promptSnippet.includes("\n"), "observe promptSnippet is one line");
	assert(act.promptSnippet !== undefined && !act.promptSnippet.includes("\n"), "act promptSnippet is one line");
	assert((observe.promptGuidelines?.length ?? 0) <= 6 && (observe.promptGuidelines?.length ?? 0) > 0, "observe guidelines 1-6");
	assert((act.promptGuidelines?.length ?? 0) <= 6 && (act.promptGuidelines?.length ?? 0) > 0, "act guidelines 1-6");

	for (const [name, tool] of [["observe", observe], ["act", act]] as const) {
		const schema = tool.parameters as unknown as { type?: string; oneOf?: unknown; anyOf?: unknown; properties: Record<string, Record<string, unknown>> };
		assertEqual(schema.oneOf, undefined, `${name} schema has no top-level oneOf`);
		assertEqual(schema.anyOf, undefined, `${name} schema has no top-level anyOf`);
		assertEqual(schema.type, "object", `${name} schema is a flat object`);
	}

	const observeSchema = observe.parameters as unknown as { properties: Record<string, Record<string, unknown>> };
	assertDeepEqual(
		Object.keys(observeSchema.properties).sort(),
		["view", "pid", "window_id", "query", "max_elements", "screenshot", "region", "expect", "on_screen_only"].sort(),
		"observe schema fields match §4.1 ComputerObserveParams exactly",
	);
	assertDeepEqual(observeSchema.properties.view.enum, ["apps", "windows", "window", "desktop", "zoom", "verify"], "view enum matches §4.1");
	assertDeepEqual(Object.keys(observeSchema.properties.region.properties as object).sort(), ["x1", "y1", "x2", "y2"].sort(), "region fields match §4.1");
	assertEqual(observeSchema.properties.query.maxLength, COMPUTER_USE_LIMITS.queryMaxChars, "query maxLength from COMPUTER_USE_LIMITS");
	assertEqual(observeSchema.properties.max_elements.maximum, COMPUTER_USE_LIMITS.maxElements.max, "max_elements maximum from COMPUTER_USE_LIMITS");
	assertEqual(observeSchema.properties.expect.minItems, COMPUTER_USE_LIMITS.verifyExpect.min, "expect minItems from COMPUTER_USE_LIMITS");
	assertEqual(observeSchema.properties.expect.maxItems, COMPUTER_USE_LIMITS.verifyExpect.max, "expect maxItems from COMPUTER_USE_LIMITS");

	const actSchema = act.parameters as unknown as { properties: Record<string, Record<string, unknown>> };
	assertDeepEqual(
		Object.keys(actSchema.properties).sort(),
		[
			"action", "frame", "pid", "window_id", "element_token", "capture_id", "x", "y", "to_x", "to_y", "from_zoom",
			"text", "key", "modifiers", "keys", "direction", "amount", "value", "menu_path", "app", "urls", "duration_ms",
			"delivery", "observe_after",
		].sort(),
		"act schema fields match §4.1 ComputerActParams exactly",
	);
	assertDeepEqual(
		actSchema.properties.action.enum,
		["click", "double_click", "right_click", "type_text", "press_key", "hotkey", "scroll", "drag", "move_cursor", "set_value", "invoke_menu", "launch_app", "focus_window", "wait"],
		"action enum matches §4.1",
	);
	assertDeepEqual(actSchema.properties.frame.enum, ["window", "desktop"], "frame enum matches §4.1");
	assertDeepEqual(actSchema.properties.direction.enum, ["up", "down", "left", "right"], "direction enum matches §4.1");
	assertDeepEqual(actSchema.properties.delivery.enum, ["background", "foreground"], "delivery enum matches §4.1");
	assertEqual(actSchema.properties.text.maxLength, COMPUTER_USE_LIMITS.typeTextMaxChars, "text maxLength from COMPUTER_USE_LIMITS");
	assertEqual(actSchema.properties.key.maxLength, COMPUTER_USE_LIMITS.keyMaxChars, "key maxLength from COMPUTER_USE_LIMITS");
	assertEqual(actSchema.properties.value.maxLength, COMPUTER_USE_LIMITS.valueMaxChars, "value maxLength from COMPUTER_USE_LIMITS");
	assertEqual(actSchema.properties.app.maxLength, COMPUTER_USE_LIMITS.appNameMaxChars, "app maxLength from COMPUTER_USE_LIMITS");
	assertEqual(actSchema.properties.amount.minimum, COMPUTER_USE_LIMITS.scrollAmount.min, "amount minimum from COMPUTER_USE_LIMITS");
	assertEqual(actSchema.properties.amount.maximum, COMPUTER_USE_LIMITS.scrollAmount.max, "amount maximum from COMPUTER_USE_LIMITS");
	assertEqual(actSchema.properties.modifiers.maxItems, COMPUTER_USE_LIMITS.modifiers.max, "modifiers maxItems from COMPUTER_USE_LIMITS");
	assertEqual(actSchema.properties.keys.minItems, COMPUTER_USE_LIMITS.hotkeyKeys.min, "keys minItems from COMPUTER_USE_LIMITS");
	assertEqual(actSchema.properties.keys.maxItems, COMPUTER_USE_LIMITS.hotkeyKeys.max, "keys maxItems from COMPUTER_USE_LIMITS");
	assertEqual(actSchema.properties.key.minLength, 1, "key minLength 1 (an empty key is rejected by the schema)");
	assertEqual((actSchema.properties.modifiers.items as Record<string, unknown>).minLength, 1, "modifiers item minLength 1 (an empty token is rejected)");
	assertEqual((actSchema.properties.keys.items as Record<string, unknown>).minLength, 1, "keys item minLength 1 (an empty token is rejected)");
	assertEqual(actSchema.properties.menu_path.minItems, COMPUTER_USE_LIMITS.menuPath.min, "menu_path minItems from COMPUTER_USE_LIMITS");
	assertEqual(actSchema.properties.menu_path.maxItems, COMPUTER_USE_LIMITS.menuPath.max, "menu_path maxItems from COMPUTER_USE_LIMITS");
	assertEqual((actSchema.properties.menu_path.items as Record<string, unknown>).maxLength, COMPUTER_USE_LIMITS.menuPath.itemMaxChars, "menu_path itemMaxChars");
	assertEqual(actSchema.properties.urls.maxItems, COMPUTER_USE_LIMITS.urls.max, "urls maxItems from COMPUTER_USE_LIMITS");
	assertEqual((actSchema.properties.urls.items as Record<string, unknown>).maxLength, COMPUTER_USE_LIMITS.urls.itemMaxChars, "urls itemMaxChars");
	assertEqual(actSchema.properties.duration_ms.maximum, COMPUTER_USE_LIMITS.waitMaxMs, "duration_ms maximum from COMPUTER_USE_LIMITS");
	assertEqual(actSchema.properties.element_token.pattern, "^s[0-9a-f]{8}:[0-9]+$", "element_token pattern");

	assert(observe.description.includes("window: pid + window_id"), "observe description lists per-view required fields");
	assert(act.description.includes("invoke_menu: pid + window_id + menu_path"), "act description lists per-action required fields");
	for (const keyword of ["element_token", "stale_reference", "untrusted", "background", "frame", "PiX"]) {
		assert(act.description.includes(keyword), `act description covers "${keyword}"`);
	}
	for (const keyword of ["element_token", "capture_id", "untrusted", "PiX"]) {
		assert(observe.description.includes(keyword), `observe description covers "${keyword}"`);
	}
	for (const keyword of ["snapshot_id", "truncated", "popup", "verify"]) {
		assert(observe.description.includes(keyword), `observe description covers "${keyword}"`);
	}
	for (const keyword of ["background_unavailable", "suspected_noop", "separate windows", "foreground"]) {
		assert(act.description.includes(keyword), `act description covers "${keyword}"`);
	}
	const deliveryDescription = String(actSchema.properties.delivery.description);
	assert(deliveryDescription.includes("default background"), "delivery description states the background default");
	assert(
		deliveryDescription.includes("Use foreground for WinUI/UWP typing and keys"),
		"delivery description directs WinUI/UWP keyboard input to foreground",
	);
	const elementSchema = (observeSchema.properties.expect.items as { properties: Record<string, { properties: Record<string, { description?: string }> }> })
		.properties.element;
	assert(
		String(elementSchema.properties.exists.description).includes("false"),
		"verify exists description states false is rejected",
	);
});

await run("tools: execute delegates to the controller (no policy, no error swallowing)", async () => {
	const blocked = makeHarness({ globalEnabled: false });
	const observe = createComputerObserveTool(blocked.controller);
	const error = await expectComputerUseError(observe.execute("tc-1", { view: "apps" }, undefined, undefined, makeCtx()), "global_disabled", "tool surfaces the controller error");
	assert(error !== null && error.message.startsWith("[computer_use:global_disabled]"), "the thrown ComputerUseError message is untouched (the agent loop renders it)");

	const h = makeHarness({ mode: "unattended" });
	enableSession(h);
	const act = createComputerActTool(h.controller);
	const result = await act.execute("tc-2", { action: "press_key", key: "enter", pid: 4242, observe_after: false }, undefined, undefined, makeCtx());
	assertEqual(result.details?.kind, "act", "tool result details come from the controller");
	assertEqual(h.backend.actCalls.length, 1, "tool reached the backend through the controller");
});

await run("guards: the act guard is re-checked after the grant prompt (post-approval focus re-check)", async () => {
	// The approval card is rendered in the PiX main window, so a prompt that the
	// user answers gives PiX focus. An entry-only guard would then hand the action
	// to the driver with PiX focused (e.g. alt+f4 once "仅本次允许" is clicked).
	const h = makeHarness();
	enableSession(h);
	h.userInput.handler = async (request) => {
		h.guard.actError = new ComputerUseError(
			"self_target",
			"PiX window is focused; typing would go into PiX.",
			"Call computer_act action=focus_window with the target pid first, or pass pid/window_id.",
		);
		return { id: request.id, answers: { computer_use_grant: "仅本次允许" } };
	};
	await expectComputerUseError(
		h.controller.act("t1", { action: "type_text", text: "hi" }, undefined, makeCtx()),
		"self_target",
		"the post-grant guard rejection propagates",
	);
	assertEqual(h.userInput.requests.length, 1, "the grant prompt did appear (the entry guard passed)");
	assertEqual(h.backend.actCalls.length, 0, "the driver is never asked to run the action once the re-check rejects");
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
	process.exit(1);
}
