import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

type SessionWithExtensionEmitHook = {
	_emitExtensionEvent: (event: AgentEvent) => Promise<void>;
};

type SessionRetryState = {
	_retryAttempt: number;
};

interface CustomErrorSessionOptions {
	errorMessage: string;
	apiError?: AssistantMessage["apiError"];
	failCount?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
	baseDelayMs?: number;
}

describe("AgentSession retry", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-retry-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function createSession(options?: { failCount?: number; maxRetries?: number; delayAssistantMessageEndMs?: number }) {
		const failCount = options?.failCount ?? 1;
		const maxRetries = options?.maxRetries ?? 3;
		const delayAssistantMessageEndMs = options?.delayAssistantMessageEndMs ?? 0;
		let callCount = 0;

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount <= failCount) {
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "overloaded_error",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = createAssistantMessage("Success");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries, baseDelayMs: 1 } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		if (delayAssistantMessageEndMs > 0) {
			const sessionWithHook = session as unknown as SessionWithExtensionEmitHook;
			const original = sessionWithHook._emitExtensionEvent.bind(sessionWithHook);
			sessionWithHook._emitExtensionEvent = async (event: AgentEvent) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					await new Promise((resolve) => setTimeout(resolve, delayAssistantMessageEndMs));
				}
				await original(event);
			};
		}

		return { session, getCallCount: () => callCount };
	}

	it("retries after a transient error and succeeds", async () => {
		const created = createSession({ failCount: 1 });
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(events).toEqual(["start:1", "end:success=true"]);
		expect(created.session.isRetrying).toBe(false);
	});

	it("exhausts max retries and emits failure", async () => {
		const created = createSession({ failCount: 99, maxRetries: 2 });
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(3);
		expect(events).toContain("start:1");
		expect(events).toContain("start:2");
		expect(events).toContain("end:success=false");
		expect(created.session.isRetrying).toBe(false);
	});

	it("prompt waits for retry completion even when assistant message_end handling is delayed", async () => {
		const created = createSession({ failCount: 1, delayAssistantMessageEndMs: 40 });

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(created.session.isRetrying).toBe(false);
	});

	it("retries provider network_error failures", async () => {
		const created = createSession({ failCount: 0 });
		let callCount = 0;
		const streamFn = () => {
			callCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callCount === 1) {
					const msg = createAssistantMessage("", {
						stopReason: "error",
						errorMessage: "Provider finish_reason: network_error",
					});
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "error", reason: "error", error: msg });
					return;
				}

				const msg = createAssistantMessage("Recovered after retry");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		};
		created.session.dispose();

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn,
		});
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await session.prompt("Test");

		expect(callCount).toBe(2);
		expect(events).toEqual(["start:1", "end:success=true"]);
	});

	it("prompt waits for full agent loop when retry produces tool calls", async () => {
		// Regression: when auto-retry fires and the retry response includes tool_use,
		// session.prompt() must wait for the entire tool loop to finish before returning.
		// Previously, _resolveRetry() on the first successful message_end would unblock
		// waitForRetry() while the agent was still executing tools.
		let callCount = 0;
		const toolExecuted = { value: false };

		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				toolExecuted.value = true;
				return { content: [{ type: "text", text: "echoed" }], details: undefined };
			},
		};

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount === 1) {
						// First call: overloaded error
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "overloaded_error",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else if (callCount === 2) {
						// Second call (retry): text + tool_use
						const msg: AssistantMessage = {
							...createAssistantMessage("Looking that up now."),
							stopReason: "toolUse",
							content: [
								{ type: "text", text: "Looking that up now." },
								{ type: "toolCall", id: "call_1", name: "echo", arguments: { text: "hello" } },
							],
						};
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "toolUse", message: msg });
					} else {
						// Third call (after tool result): final response
						const msg = createAssistantMessage("Final answer.");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: { echo: echoTool },
		});

		await session.prompt("Test");

		// All three LLM calls must have completed
		expect(callCount).toBe(3);
		// Tool must have been executed
		expect(toolExecuted.value).toBe(true);
		// Agent must not be streaming after prompt returns
		expect(session.isStreaming).toBe(false);
		// A follow-up prompt must work (no "Agent is already processing" error)
		await session.prompt("Follow-up");
		expect(callCount).toBe(4);
	});

	function createCustomErrorSession(options: CustomErrorSessionOptions) {
		const failCount = options.failCount ?? 1;
		const maxRetries = options.maxRetries ?? 3;
		const baseDelayMs = options.baseDelayMs ?? 1;
		let callCount = 0;

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount <= failCount) {
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: options.errorMessage,
							apiError: options.apiError,
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = createAssistantMessage("Success");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settingsManager.applyOverrides({
			retry: {
				enabled: true,
				maxRetries,
				baseDelayMs,
				...(options.maxRetryDelayMs !== undefined
					? { provider: { maxRetryDelayMs: options.maxRetryDelayMs } }
					: {}),
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		return { session, getCallCount: () => callCount };
	}

	it("uses apiError.retryAfterMs for auto_retry_start and waits that delay", async () => {
		const retryAfterMs = 40;
		const created = createCustomErrorSession({
			errorMessage: "429 Too Many Requests",
			apiError: { status: 429, retryAfterMs },
		});
		const retryStarts: Extract<AgentSessionEvent, { type: "auto_retry_start" }>[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
		});

		const startedAt = Date.now();
		await created.session.prompt("Test");
		const elapsed = Date.now() - startedAt;

		expect(created.getCallCount()).toBe(2);
		expect(retryStarts).toHaveLength(1);
		expect(retryStarts[0].retryAfterMs).toBe(retryAfterMs);
		expect(retryStarts[0].delayMs).toBe(retryAfterMs);
		expect(elapsed).toBeGreaterThanOrEqual(retryAfterMs - 5);
	});

	it("does not retry when retryAfterMs exceeds provider.maxRetryDelayMs", async () => {
		const retryAfterMs = 5000;
		const created = createCustomErrorSession({
			errorMessage: "429 Too Many Requests",
			apiError: { status: 429, retryAfterMs },
			maxRetryDelayMs: 1000,
		});
		const retryStarts: Extract<AgentSessionEvent, { type: "auto_retry_start" }>[] = [];
		const apiErrors: Extract<AgentSessionEvent, { type: "api_error" }>[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
			if (event.type === "api_error") apiErrors.push(event);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(1);
		expect(retryStarts).toHaveLength(0);
		expect((created.session as unknown as SessionRetryState)._retryAttempt).toBe(0);
		expect(apiErrors).toHaveLength(1);
		expect(apiErrors[0].retryAfterMs).toBe(retryAfterMs);
		expect(apiErrors[0].autoRetried).toBe(0);
	});

	it("does not auto-retry apiError.status 400", async () => {
		const created = createCustomErrorSession({
			errorMessage: "400 Bad Request terminated",
			apiError: { status: 400 },
		});
		const retryStarts: Extract<AgentSessionEvent, { type: "auto_retry_start" }>[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(1);
		expect(retryStarts).toHaveLength(0);
	});

	it("retries apiError.status 503", async () => {
		const created = createCustomErrorSession({
			errorMessage: "503 Service Unavailable",
			apiError: { status: 503 },
		});
		const retryStarts: Extract<AgentSessionEvent, { type: "auto_retry_start" }>[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(retryStarts).toHaveLength(1);
	});

	it("does not retry apiError.status 409", async () => {
		const created = createCustomErrorSession({
			errorMessage: "409 Conflict",
			apiError: { status: 409 },
		});
		const retryStarts: Extract<AgentSessionEvent, { type: "auto_retry_start" }>[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(1);
		expect(retryStarts).toHaveLength(0);
	});

	it("still retries no-status fetch failed via message fallback", async () => {
		const created = createCustomErrorSession({
			errorMessage: "fetch failed",
		});
		const retryStarts: Extract<AgentSessionEvent, { type: "auto_retry_start" }>[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(retryStarts).toHaveLength(1);
	});

	it("sets api_error.autoRetried to maxRetries after exhausting retries", async () => {
		const created = createCustomErrorSession({
			errorMessage: "overloaded_error",
			failCount: 99,
			maxRetries: 2,
		});
		const apiErrors: Extract<AgentSessionEvent, { type: "api_error" }>[] = [];
		created.session.subscribe((event) => {
			if (event.type === "api_error") apiErrors.push(event);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(3);
		expect(apiErrors).toHaveLength(1);
		expect(apiErrors[0].autoRetried).toBe(2);
	});

	it("sets agent_end.willRetry false when Retry-After exceeds the provider cap", async () => {
		const created = createCustomErrorSession({
			errorMessage: "429 Too Many Requests",
			apiError: { status: 429, retryAfterMs: 5000 },
			maxRetryDelayMs: 1000,
		});
		const agentEnds: Extract<AgentSessionEvent, { type: "agent_end" }>[] = [];
		created.session.subscribe((event) => {
			if (event.type === "agent_end") agentEnds.push(event);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(1);
		expect(agentEnds).toHaveLength(1);
		expect(agentEnds[0].willRetry).toBe(false);
	});

	it("prefers apiError.status on api_error.httpStatus", async () => {
		const created = createCustomErrorSession({
			errorMessage: "upstream failed",
			apiError: { status: 503 },
			failCount: 99,
			maxRetries: 0,
		});
		const apiErrors: Extract<AgentSessionEvent, { type: "api_error" }>[] = [];
		created.session.subscribe((event) => {
			if (event.type === "api_error") apiErrors.push(event);
		});

		await created.session.prompt("Test");

		expect(apiErrors).toHaveLength(1);
		expect(apiErrors[0].httpStatus).toBe(503);
	});

	it("still retries status 0 via message fallback", async () => {
		const created = createCustomErrorSession({
			errorMessage: "fetch failed",
			apiError: { status: 0 },
		});
		const retryStarts: Extract<AgentSessionEvent, { type: "auto_retry_start" }>[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(retryStarts).toHaveLength(1);
	});

	it("restores the failed turn and keeps autoRetried after abortRetry", async () => {
		const created = createCustomErrorSession({
			errorMessage: "overloaded_error",
			failCount: 99,
			baseDelayMs: 50,
		});
		const apiErrors: Extract<AgentSessionEvent, { type: "api_error" }>[] = [];
		created.session.subscribe((event) => {
			if (event.type === "api_error") apiErrors.push(event);
		});

		const sawRetryStart = new Promise<void>((resolve) => {
			const unsubscribe = created.session.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = created.session.prompt("Test");
		await sawRetryStart;
		created.session.abortRetry();
		await promptPromise;

		const last = created.session.messages[created.session.messages.length - 1] as AssistantMessage;
		expect(last.role).toBe("assistant");
		expect(last.stopReason).toBe("error");
		expect(apiErrors).toHaveLength(1);
		expect(apiErrors[0].autoRetried).toBe(1);

		await created.session.retryLastTurn();
		expect(created.getCallCount()).toBeGreaterThan(1);
	});
});
