/**
 * MCP stdio client for the managed cua-driver child process.
 *
 * Responsibilities: child-process lifecycle (`mcp --direct` over StdioClientTransport), the MCP
 * handshake + `tools/list` cache, `tools/call` with timeout / cancellation / error classification,
 * crash detection with 1s/2s/4s backoff and a 5-minute fuse, and a pass-through outputSchema
 * validator that disables BOTH SDK callTool guards (Ajv validation of `structuredContent` and the
 * missing-structuredContent throw): either would report an already executed action as failed, which
 * invites duplicate actions — the driver is authoritative.
 *
 * State machine:
 *   idle --ensureStarted--> starting --connect + listTools ok + DRIVER_REQUIRED_TOOLS present--> ready
 *   starting --spawn failure / timeout / handshake failure--> failed (detail = stderr tail, no retry)
 *   starting --REQUIRED tools missing--> failed (detail = "driver_incompatible: missing <names>")
 *   ready --unexpected child exit / transport onclose--> crashed --backoff--> starting (automatic)
 *   crashed --3rd crash inside 5 minutes--> failed (fuse)
 *   failed --stop() + ensureStarted()--> ready (the only recovery, service.recheck_driver)
 *   any --stop()--> stopping --> idle
 *
 * Error classification order for callTool checks our own signal first, because the SDK reports both
 * abort and timeout as `McpError(-32001)`: ① cancelled (caller signal aborted or a cancelAll()),
 * ② driver_crashed (child exited / transport closed / McpError -32000), ③ timeout (McpError -32001
 * that is not a cancellation), ④ driver_error.
 *
 * Crashes reject every in-flight call and are never replayed; `onStateChange("ready")` after a
 * restart is what tells the backend that driver-side `start_session` state was lost.
 *
 * This module imports only contracts, driver-manifest constants and npm packages; it must stay free
 * of `electron` so the tests run in pure Node.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type {
	jsonSchemaValidator,
	JsonSchemaType,
	JsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import {
	ComputerUseError,
	type DriverCallOptions,
	type DriverClient,
	type DriverClientState,
	type DriverToolInputSchema,
	type DriverToolResult,
} from "./contracts.js";
import {
	DRIVER_MCP_ARGS,
	DRIVER_REQUIRED_TOOLS,
	DRIVER_TOOL_ALLOWLIST,
	DRIVER_VERSION,
	driverChildEnv,
} from "./driver-manifest.js";

const START_TIMEOUT_DEFAULT_MS = 20_000;
const CALL_TIMEOUT_DEFAULT_MS = 30_000;
/** Keep the last 64 KB of child stderr for diagnostics (never logged anywhere else). */
const STDERR_TAIL_LIMIT_BYTES = 64 * 1024;
const RESTART_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000];
const CRASH_FUSE_WINDOW_MS = 5 * 60_000;
const CRASH_FUSE_COUNT = 3;

/**
 * Fallback MCP clientInfo version (used when the service does not inject the
 * real PiX app version through `McpDriverClientOptions.clientVersion`, e.g. in
 * tests): this pure-Node module cannot call `app.getVersion()` without pulling
 * in `electron`, and the driver only logs the value.
 */
const PIX_MCP_CLIENT_VERSION = "1.4.3";

const DRIVER_UNAVAILABLE_HINT =
	"The computer-use driver is not available. Open Settings and install or repair it, then retry.";
const DRIVER_INCOMPATIBLE_HINT = `The installed driver is missing tools PiX needs; reinstall cua-driver ${DRIVER_VERSION} from Settings.`;
/**
 * Prefix of the `driver_incompatible` start failure. The error itself carries that code; the
 * detail keeps this prefix because the service maps a `failed` client state to availability
 * `driver_incompatible` from the state-detail string alone (the state carries no error object).
 */
export const DRIVER_INCOMPATIBLE_PREFIX = "driver_incompatible";
/** Detail prefix of the missing-DRIVER_REQUIRED_TOOLS start failure. */
const DRIVER_INCOMPATIBLE_MISSING_DETAIL_PREFIX = `${DRIVER_INCOMPATIBLE_PREFIX}: missing `;
const DRIVER_CRASHED_HINT = "The driver restarts automatically; observe the screen again before acting.";
/**
 * Fuse-open hint (the 3-crash failure). Must NOT promise an automatic restart:
 * the fuse branch of `_noteCrash` has just disabled them, so the crash hint's
 * "restarts automatically" wording would contradict the failure detail.
 */
const DRIVER_FUSE_OPEN_HINT = "Automatic restarts are disabled after repeated crashes; open Settings > Computer use and retry.";
const DRIVER_TIMEOUT_HINT = "The action may still be running on the desktop; observe again before acting.";
/** Model-visible budget for raw child stderr inside a start-failure detail (the full tail stays in the state detail). */
const FAILURE_DETAIL_MAX_CHARS = 2_048;

/**
 * Cap raw child stderr for the model-visible failure detail, keeping the TAIL
 * (the most recent output) and a leading ellipsis marker. Pure and exported for
 * unit tests; the caller decides the budget (default FAILURE_DETAIL_MAX_CHARS).
 */
export function capDriverFailureDetail(text: string, max: number = FAILURE_DETAIL_MAX_CHARS): string {
	if (max <= 0) return "";
	if (text.length <= max) return text;
	return `…${text.slice(-(max - 1))}`;
}

/**
 * Pass-through JSON Schema validator covering BOTH SDK guards.
 *
 * getValidator returns null on purpose. After tools/list the SDK caches one
 * validator per tool that declares an outputSchema (cacheToolMetadata) and gates
 * both callTool guards on its truthiness: a null validator skips ① the Ajv
 * validation of `structuredContent` (schema drift would fail an action that
 * already ran) and ② the "has an output schema but did not return structured
 * content" throw (a successful, side-effecting result would be misreported as
 * failed). Either failure invites a duplicate action; PiX treats
 * `structuredContent` as optional and parses it defensively — the driver is
 * authoritative. The declared jsonSchemaValidator return type does not model
 * "no validator", hence the single assertion on the null return.
 */
const PASS_THROUGH_VALIDATOR: jsonSchemaValidator = {
	getValidator<T>(_schema: JsonSchemaType): JsonSchemaValidator<T> {
		return null as unknown as JsonSchemaValidator<T>;
	},
};

export interface McpDriverClientOptions {
	executablePath: string;
	cwd: string;                    // 驱动所在目录（Windows 需同目录 helper：cua-driver-uia.exe）
	extraEnv?: Record<string, string>; // 测试注入；最终 env = { ...process.env(仅 string 值、剔除疑似凭证键), ...DRIVER_CHILD_ENV, ...extraEnv }
	args?: readonly string[];       // 测试注入；缺省 DRIVER_MCP_ARGS（["mcp","--direct"]）
	startTimeoutMs?: number;        // 默认 20_000（connect + listTools 总时长）
	defaultCallTimeoutMs?: number;  // 默认 30_000；必须显式传给 SDK（SDK 默认 60_000，protocol.js:8）
	now?: () => number;             // 测试注入（熔断窗口）
	clientVersion?: string;         // clientInfo version；缺省 PIX_MCP_CLIENT_VERSION（由 service 注入 app 版本，避免硬编码漂移）
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function chunkToText(chunk: unknown): string {
	if (typeof chunk === "string") {
		return chunk;
	}
	if (Buffer.isBuffer(chunk)) {
		return chunk.toString("utf8");
	}
	return String(chunk);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow the SDK's CallToolResult (wire data) onto the DriverToolResult contract. */
function toDriverToolResult(raw: unknown): DriverToolResult {
	const record = isRecord(raw) ? raw : {};
	const content: DriverToolResult["content"] = [];
	if (Array.isArray(record.content)) {
		for (const block of record.content) {
			if (!isRecord(block)) {
				continue;
			}
			if (block.type === "text" && typeof block.text === "string") {
				content.push({ type: "text", text: block.text });
			} else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
				content.push({ type: "image", data: block.data, mimeType: block.mimeType });
			}
		}
	}
	return {
		content,
		structuredContent: isRecord(record.structuredContent) ? record.structuredContent : undefined,
		isError: record.isError === true,
	};
}

export class McpDriverClient implements DriverClient {
	private _state: DriverClientState = "idle";
	private _stateDetail: string | undefined;
	private readonly _listeners = new Set<(state: DriverClientState, detail?: string) => void>();

	private readonly _executablePath: string;
	private readonly _cwd: string;
	private readonly _args: readonly string[];
	private readonly _extraEnv: Record<string, string>;
	private readonly _startTimeoutMs: number;
	private readonly _defaultCallTimeoutMs: number;
	private readonly _now: () => number;
	private readonly _clientVersion: string;

	private _client: Client | null = null;
	private _transport: StdioClientTransport | null = null;
	/** Bumped by every start attempt and by stop(); stale attempts must not touch state any more. */
	private _generation = 0;

	private _toolNames: ReadonlySet<string> = new Set<string>();
	private _toolSchemas = new Map<string, DriverToolInputSchema>();

	private _stderrChunks: string[] = [];
	private _stderrBytes = 0;

	private readonly _inFlight = new Set<AbortController>();

	/** "The client will reach ready (or fail)" promise handed to every ensureStarted() waiter. */
	private _gate: Deferred<void> | null = null;
	/** True only while a `_runStart` attempt is in flight (the gate also covers the backoff wait). */
	private _startAttemptActive = false;
	private _restartTimer: NodeJS.Timeout | null = null;
	private _crashTimes: number[] = [];
	private _failure: ComputerUseError | null = null;
	/** Full stderr tail behind a capped start failure; consumed by the failed-state transition. */
	private _startFailureStateDetail: string | undefined;

	constructor(opts: McpDriverClientOptions) {
		this._executablePath = opts.executablePath;
		this._cwd = opts.cwd;
		this._args = opts.args ?? DRIVER_MCP_ARGS;
		this._extraEnv = opts.extraEnv ?? {};
		this._startTimeoutMs = opts.startTimeoutMs ?? START_TIMEOUT_DEFAULT_MS;
		this._defaultCallTimeoutMs = opts.defaultCallTimeoutMs ?? CALL_TIMEOUT_DEFAULT_MS;
		this._now = opts.now ?? Date.now;
		this._clientVersion = opts.clientVersion ?? PIX_MCP_CLIENT_VERSION;
	}

	get state(): DriverClientState {
		return this._state;
	}

	onStateChange(listener: (state: DriverClientState, detail?: string) => void): () => void {
		this._listeners.add(listener);
		return () => {
			this._listeners.delete(listener);
		};
	}

	/**
	 * Idempotent. Resolves once the child answered `tools/list` and exposes every
	 * `DRIVER_REQUIRED_TOOLS` entry; rejects `ComputerUseError("unavailable" | "driver_incompatible")`.
	 * While `crashed` it waits for the automatic backoff restart; while `failed` it rejects until
	 * `stop()` resets the client.
	 */
	async ensureStarted(): Promise<void> {
		switch (this._state) {
			case "ready":
				return;
			case "failed":
				throw this._failure ?? new ComputerUseError("unavailable", "driver failed to start");
			case "stopping":
				throw new ComputerUseError("unavailable", "driver is stopping", DRIVER_UNAVAILABLE_HINT);
			case "crashed":
			case "starting":
				return this._ensureGate().promise;
			default:
				return this._beginStart();
		}
	}

	listToolNames(): ReadonlySet<string> {
		return this._toolNames;
	}

	getToolInputSchema(name: string): DriverToolInputSchema | null {
		return this._toolSchemas.get(name) ?? null;
	}

	async callTool(name: string, args: Record<string, unknown>, opts?: DriverCallOptions): Promise<DriverToolResult> {
		if (!DRIVER_TOOL_ALLOWLIST.includes(name)) {
			// Programming error, not a model-visible ComputerUseError.
			throw new Error(`driver tool "${name}" is not in DRIVER_TOOL_ALLOWLIST; refusing to call it (§9.1-7)`);
		}
		if (this._state !== "ready") {
			throw new ComputerUseError("unavailable", `driver is ${this._state}; cannot call "${name}"`, DRIVER_UNAVAILABLE_HINT);
		}
		if (!this._toolNames.has(name)) {
			throw new ComputerUseError(
				"unsupported_on_platform",
				`driver does not expose tool "${name}" on ${process.platform}/${process.arch}`,
			);
		}
		const client = this._client;
		if (!client) {
			throw new ComputerUseError("unavailable", `driver connection is not available; cannot call "${name}"`);
		}
		const timeoutMs = opts?.timeoutMs ?? this._defaultCallTimeoutMs;
		const internal = new AbortController();
		const callerSignal = opts?.signal;
		const forwardAbort = (): void => {
			internal.abort(callerSignal?.reason);
		};
		if (callerSignal) {
			if (callerSignal.aborted) {
				forwardAbort();
			} else {
				callerSignal.addEventListener("abort", forwardAbort, { once: true });
			}
		}
		this._inFlight.add(internal);
		try {
			const raw: unknown = await client.callTool(
				{ name, arguments: args },
				undefined,
				{ signal: internal.signal, timeout: timeoutMs },
			);
			return toDriverToolResult(raw);
		} catch (error) {
			throw this._classifyCallError(name, error, internal, callerSignal, timeoutMs);
		} finally {
			callerSignal?.removeEventListener("abort", forwardAbort);
			this._inFlight.delete(internal);
		}
	}

	/** Abort every in-flight call (emergency stop); each rejects `cancelled`. */
	cancelAll(): void {
		this._cancelInFlight();
	}

	/** `any --> stopping --> idle`; the only way out of `failed`. */
	async stop(): Promise<void> {
		this._generation += 1;
		if (this._restartTimer) {
			clearTimeout(this._restartTimer);
			this._restartTimer = null;
		}
		this._cancelInFlight();
		const gate = this._gate;
		this._gate = null;
		this._startAttemptActive = false;
		const client = this._client;
		const transport = this._transport;
		this._client = null;
		this._transport = null;
		if (this._state !== "idle") {
			this._setState("stopping");
		}
		await this._closeConnection(client, transport);
		this._clearToolCache();
		this._crashTimes = [];
		this._failure = null;
		this._startFailureStateDetail = undefined;
		this._stderrChunks = [];
		this._stderrBytes = 0;
		this._setState("idle");
		gate?.reject(new ComputerUseError("unavailable", "driver was stopped before it became ready"));
	}

	// ---------------- start / restart ----------------

	private _beginStart(): Promise<void> {
		if (this._startAttemptActive) {
			return this._ensureGate().promise;
		}
		const gate = this._ensureGate();
		this._startAttemptActive = true;
		const generation = ++this._generation;
		this._setState("starting");
		void this._runStart(generation).then(
			() => {
				this._startAttemptActive = false;
				if (generation !== this._generation) {
					// Superseded by stop() or a newer attempt: settle the waiters, keep the state.
					gate.resolve();
					return;
				}
				this._gate = null;
				gate.resolve();
			},
			(error: unknown) => {
				this._startAttemptActive = false;
				const failure = error instanceof ComputerUseError
					? error
					: new ComputerUseError("unavailable", error instanceof Error ? error.message : String(error));
				if (generation !== this._generation) {
					gate.reject(failure);
					return;
				}
				this._failure = failure;
				this._gate = null;
				// The state detail keeps the FULL stderr tail: only the error
				// handed to the model is capped; the service truncates this itself.
				this._setState("failed", this._startFailureStateDetail ?? failure.detail);
				this._startFailureStateDetail = undefined;
				gate.reject(failure);
			},
		);
		return gate.promise;
	}

	private async _runStart(generation: number): Promise<void> {
		const deadline = Date.now() + this._startTimeoutMs;
		// Parent env minus credential-looking keys: the runtime-downloaded driver
		// is a third-party binary and must never see ANTHROPIC_API_KEY / *_TOKEN
		// style secrets. DRIVER_CHILD_ENV and the (test) extraEnv layer on top of
		// the filtered result and always survive.
		const env: Record<string, string> = {
			...driverChildEnv(),
			...this._extraEnv,
		};
		const transport = new StdioClientTransport({
			command: this._executablePath,
			args: [...this._args],
			cwd: this._cwd,
			env,
			stderr: "pipe",
		});
		this._stderrChunks = [];
		this._stderrBytes = 0;
		const stderr = transport.stderr;
		if (stderr) {
			stderr.on("data", (chunk: unknown) => {
				this._appendStderr(chunkToText(chunk));
			});
		}
		transport.onclose = () => {
			this._handleTransportClose(transport);
		};
		const client = new Client(
			{ name: "pix", version: this._clientVersion },
			{ jsonSchemaValidator: PASS_THROUGH_VALIDATOR },
		);
		this._client = client;
		this._transport = transport;
		try {
			await client.connect(transport, { timeout: this._remainingStartMs(deadline) });
			this._assertCurrent(generation);
			const listed = await client.listTools(undefined, { timeout: this._remainingStartMs(deadline) });
			this._assertCurrent(generation);
			const names = new Set(listed.tools.map((tool) => tool.name));
			const missing = DRIVER_REQUIRED_TOOLS.filter((name) => !names.has(name));
			if (missing.length > 0) {
				// A tools/list surface without the required tools IS an incompatible
				// driver (not a transport-level "unavailable").
				throw new ComputerUseError(
					"driver_incompatible",
					`${DRIVER_INCOMPATIBLE_MISSING_DETAIL_PREFIX}${missing.join(", ")}`,
					DRIVER_INCOMPATIBLE_HINT,
				);
			}
			this._toolNames = names;
			this._toolSchemas = new Map(listed.tools.map((tool) => [tool.name, {
				required: [...(tool.inputSchema.required ?? [])],
				properties: new Set(Object.keys(tool.inputSchema.properties ?? {})),
			}]));
			this._setState("ready");
		} catch (error) {
			if (this._client === client) {
				this._client = null;
				this._transport = null;
				this._clearToolCache();
			}
			await this._closeConnection(client, transport);
			throw this._toStartFailure(error);
		}
	}

	/** Throws when this start attempt was superseded by stop() or a newer attempt. */
	private _assertCurrent(generation: number): void {
		if (generation !== this._generation) {
			throw new ComputerUseError("unavailable", "driver start was superseded by a newer start or stop");
		}
	}

	private _remainingStartMs(deadline: number): number {
		return Math.max(1, Math.floor(deadline - Date.now()));
	}

	/**
	 * Maps a non-ComputerUseError start failure onto the model-visible error.
	 * The error detail (which becomes error.message) carries only
	 * FAILURE_DETAIL_MAX_CHARS of the stderr tail; the full tail is preserved in
	 * `_startFailureStateDetail` so the `failed` state detail still has everything
	 * for the service-side truncation.
	 */
	private _toStartFailure(error: unknown): ComputerUseError {
		if (error instanceof ComputerUseError) {
			this._startFailureStateDetail = undefined;
			return error;
		}
		const message = error instanceof Error ? error.message : String(error);
		const tail = this._stderrTail();
		if (tail.length === 0) {
			this._startFailureStateDetail = undefined;
			return new ComputerUseError("unavailable", message, DRIVER_UNAVAILABLE_HINT);
		}
		this._startFailureStateDetail = tail;
		return new ComputerUseError("unavailable", capDriverFailureDetail(tail), DRIVER_UNAVAILABLE_HINT);
	}

	/** Close one connection; only releases the current pointers when they still belong to it. */
	private async _closeConnection(client: Client | null, transport: StdioClientTransport | null): Promise<void> {
		if (client === null && transport === null) {
			return;
		}
		if (this._client === client) {
			this._client = null;
		}
		if (this._transport === transport) {
			this._transport = null;
		}
		if (client) {
			try {
				await client.close();
			} catch (error) {
				console.warn(`[ComputerUse] closing the driver connection failed: ${String(error)}`);
			}
		} else if (transport) {
			try {
				await transport.close();
			} catch (error) {
				console.warn(`[ComputerUse] closing the driver transport failed: ${String(error)}`);
			}
		}
	}

	// ---------------- crash handling ----------------

	private _handleTransportClose(transport: StdioClientTransport): void {
		if (this._transport !== transport) {
			return; // stale transport from a previous generation, or a stop that already cleared it
		}
		if (this._state !== "ready") {
			return; // a start-phase exit is handled by _runStart
		}
		this._noteCrash();
	}

	private _noteCrash(): void {
		const now = this._now();
		this._crashTimes = this._crashTimes.filter((time) => now - time < CRASH_FUSE_WINDOW_MS);
		this._crashTimes.push(now);
		const crashes = this._crashTimes.length;
		const minutes = CRASH_FUSE_WINDOW_MS / 60_000;
		this._clearToolCache();
		this._setState("crashed", `driver process exited unexpectedly (crash ${crashes} in the last ${minutes} minutes)`);
		if (crashes >= CRASH_FUSE_COUNT) {
			// crashed --> failed: the fuse opens, no further automatic restart. The
			// hint must say so: DRIVER_CRASHED_HINT would promise the very
			// restarts this detail just disabled.
			const detail = `driver crashed ${crashes} times within ${minutes} minutes; automatic restarts are disabled until the driver is restarted manually`;
			const failure = new ComputerUseError("unavailable", detail, DRIVER_FUSE_OPEN_HINT);
			this._failure = failure;
			this._setState("failed", detail);
			const gate = this._gate;
			this._gate = null;
			gate?.reject(failure);
			return;
		}
		this._ensureGate(); // ensureStarted() during the backoff waits for the restart
		this._scheduleRestart(RESTART_BACKOFF_MS[Math.min(crashes - 1, RESTART_BACKOFF_MS.length - 1)]);
	}

	private _scheduleRestart(delayMs: number): void {
		if (this._restartTimer) {
			clearTimeout(this._restartTimer);
		}
		this._restartTimer = setTimeout(() => {
			this._restartTimer = null;
			if (this._state !== "crashed") {
				return; // a deliberate stop has already moved the state out of `crashed`
			}
			void this._beginStart().catch(() => {
				// The failure is already recorded as state "failed".
			});
		}, delayMs);
	}

	// ---------------- call error classification ----------------

	private _classifyCallError(
		name: string,
		error: unknown,
		internal: AbortController,
		callerSignal: AbortSignal | undefined,
		timeoutMs: number,
	): ComputerUseError {
		// ① our own cancellation: the SDK reports aborts as McpError(-32001) too (protocol.js:685/713),
		// so the signal must be inspected before the MCP error code.
		if (callerSignal?.aborted || internal.signal.aborted) {
			return new ComputerUseError(
				"cancelled",
				`call "${name}" was cancelled; the desktop may be in an unknown state, observe again before acting`,
			);
		}
		// ② child exited / transport closed / ConnectionClosed
		if (
			this._transport?.pid == null
			|| (error instanceof McpError && error.code === ErrorCode.ConnectionClosed)
		) {
			return new ComputerUseError(
				"driver_crashed",
				`call "${name}" did not complete: the driver process exited (the action is not replayed; its result is unknown)`,
				DRIVER_CRASHED_HINT,
			);
		}
		// ③ SDK request timeout
		if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
			return new ComputerUseError("timeout", `call "${name}" timed out after ${timeoutMs}ms`, DRIVER_TIMEOUT_HINT);
		}
		// ④ everything else
		return new ComputerUseError(
			"driver_error",
			`call "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	private _cancelInFlight(): void {
		for (const controller of [...this._inFlight]) {
			controller.abort(new Error("computer use cancelled the in-flight driver call"));
		}
	}

	// ---------------- helpers ----------------

	private _ensureGate(): Deferred<void> {
		if (!this._gate) {
			const gate = createDeferred<void>();
			// An automatic restart nobody awaits must not surface as an unhandled rejection.
			gate.promise.catch(() => {});
			this._gate = gate;
		}
		return this._gate;
	}

	private _clearToolCache(): void {
		this._toolNames = new Set<string>();
		this._toolSchemas.clear();
	}

	private _appendStderr(text: string): void {
		if (text.length === 0) {
			return;
		}
		this._stderrChunks.push(text);
		this._stderrBytes += Buffer.byteLength(text);
		while (this._stderrBytes > STDERR_TAIL_LIMIT_BYTES && this._stderrChunks.length > 1) {
			const removed = this._stderrChunks.shift();
			if (removed === undefined) {
				break;
			}
			this._stderrBytes -= Buffer.byteLength(removed);
		}
	}

	private _stderrTail(): string {
		const text = this._stderrChunks.join("");
		return text.length > STDERR_TAIL_LIMIT_BYTES ? text.slice(-STDERR_TAIL_LIMIT_BYTES) : text;
	}

	private _setState(state: DriverClientState, detail?: string): void {
		if (this._state === state && this._stateDetail === detail) {
			return;
		}
		this._state = state;
		this._stateDetail = detail;
		for (const listener of [...this._listeners]) {
			try {
				listener(state, detail);
			} catch (error) {
				console.warn(`[ComputerUse] driver state listener failed: ${String(error)}`);
			}
		}
	}
}
