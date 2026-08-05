import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
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

interface CreateSessionOptions {
	errorMessage?: string;
	failCount?: number;
	retryEnabled?: boolean;
	maxRetries?: number;
	compactionEnabled?: boolean;
}

describe("AgentSession api_error surfacing", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-api-error-test-${Date.now()}`);
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

	function createSession(options: CreateSessionOptions = {}) {
		const errorMessage = options.errorMessage ?? "overloaded_error";
		const failCount = options.failCount ?? 1;
		const retryEnabled = options.retryEnabled ?? false;
		const maxRetries = options.maxRetries ?? 3;
		const compactionEnabled = options.compactionEnabled ?? false;
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
						const msg = createAssistantMessage("", { stopReason: "error", errorMessage });
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
			retry: { enabled: retryEnabled, maxRetries, baseDelayMs: 1 },
			compaction: { enabled: compactionEnabled },
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

	function collectApiErrors(s: AgentSession) {
		const errors: { category: string; httpStatus?: number; retryable: boolean; errorMessage: string }[] = [];
		s.subscribe((event) => {
			if (event.type === "api_error") {
				errors.push({
					category: event.category,
					httpStatus: event.httpStatus,
					retryable: event.retryable,
					errorMessage: event.errorMessage,
				});
			}
		});
		return errors;
	}

	it("emits api_error when retry is disabled (previously silent)", async () => {
		const created = createSession({ failCount: 1, retryEnabled: false, errorMessage: "overloaded_error" });
		const errors = collectApiErrors(created.session);

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(1);
		expect(errors).toHaveLength(1);
		expect(errors[0].category).toBe("overloaded");
		expect(errors[0].retryable).toBe(true);
		expect(errors[0].errorMessage).toBe("overloaded_error");
		expect(created.session.isStreaming).toBe(false);
	});

	it("emits api_error with classification after retry exhaustion", async () => {
		// Realistic Anthropic 529 payload: contains "overloaded_error" so the
		// regex-based _isRetryableError classifies it as retryable, AND a leading
		// 529 status code for classifyApiError to extract.
		const created = createSession({
			failCount: 99,
			retryEnabled: true,
			maxRetries: 2,
			errorMessage: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
		});
		const errors = collectApiErrors(created.session);

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(3);
		expect(errors).toHaveLength(1);
		expect(errors[0].category).toBe("overloaded");
		expect(errors[0].httpStatus).toBe(529);
		expect(errors[0].retryable).toBe(true);
	});

	it("emits api_error for non-retryable 403 auth errors", async () => {
		const created = createSession({ failCount: 1, retryEnabled: true, errorMessage: "Mistral API error (403): Forbidden" });
		const errors = collectApiErrors(created.session);

		await created.session.prompt("Test");

		// 403 is non-retryable: no auto-retry attempts, single failed call.
		expect(created.getCallCount()).toBe(1);
		expect(errors).toHaveLength(1);
		expect(errors[0].category).toBe("auth");
		expect(errors[0].httpStatus).toBe(403);
		expect(errors[0].retryable).toBe(false);
	});

	it("emits api_error for quota errors as non-retryable", async () => {
		const created = createSession({ failCount: 1, errorMessage: "insufficient_quota" });
		const errors = collectApiErrors(created.session);

		await created.session.prompt("Test");

		expect(errors).toHaveLength(1);
		expect(errors[0].category).toBe("quota");
		expect(errors[0].retryable).toBe(false);
	});

	it("does not emit api_error for context-overflow errors (owned by compaction)", async () => {
		const created = createSession({
			failCount: 1,
			errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
			compactionEnabled: false,
		});
		const errors = collectApiErrors(created.session);

		await created.session.prompt("Test");

		expect(errors).toHaveLength(0);
	});

	it("does not emit api_error on a successful turn", async () => {
		const created = createSession({ failCount: 0 });
		const errors = collectApiErrors(created.session);

		await created.session.prompt("Test");

		expect(errors).toHaveLength(0);
	});
});

describe("AgentSession retryLastTurn", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-manual-retry-test-${Date.now()}`);
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

	it("re-runs the agent and succeeds after a failed turn", async () => {
		let callCount = 0;
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount === 1) {
						const msg = createAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = createAssistantMessage("Recovered");
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
		// Auto-retry disabled so the failed turn stays for manual retry.
		settingsManager.applyOverrides({ retry: { enabled: false, maxRetries: 3, baseDelayMs: 1 } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		await session.prompt("Test");
		expect(callCount).toBe(1);
		expect(session.isStreaming).toBe(false);

		// The failed assistant message remains in state before manual retry.
		const messagesBefore = session.agent.state.messages;
		expect(messagesBefore[messagesBefore.length - 1].role).toBe("assistant");

		await session.retryLastTurn();

		expect(callCount).toBe(2);
		expect(session.isStreaming).toBe(false);
		// The failed assistant message was removed and replaced by the success.
		const messagesAfter = session.agent.state.messages;
		const last = messagesAfter[messagesAfter.length - 1] as AssistantMessage;
		expect(last.role).toBe("assistant");
		expect(last.stopReason).not.toBe("error");
	});

	it("is a no-op when the last message is not a failed assistant response", async () => {
		let callCount = 0;
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const msg = createAssistantMessage("Success");
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settingsManager.applyOverrides({ retry: { enabled: false, maxRetries: 3, baseDelayMs: 1 } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		await session.prompt("Test");
		expect(callCount).toBe(1);

		await session.retryLastTurn();

		// No additional LLM call - last message was a success, not an error.
		expect(callCount).toBe(1);
	});

	it("restores the failed turn if the retry run rejects, so a second retry still works", async () => {
		let callCount = 0;
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount === 1) {
						const msg = createAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = createAssistantMessage("Recovered");
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
		// Auto-retry disabled so the failed turn stays for manual retry.
		settingsManager.applyOverrides({ retry: { enabled: false, maxRetries: 3, baseDelayMs: 1 } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		await session.prompt("Test");
		expect(callCount).toBe(1);

		// Engineer a non-API rejection of the retry run (e.g. a pre-run guard
		// throwing before the agent starts) so the rollback path is exercised.
		const continueOriginal = agent.continue.bind(agent);
		let rejectNext = true;
		const continueSpy = vi.spyOn(agent, "continue").mockImplementation(async () => {
			if (rejectNext) {
				rejectNext = false;
				throw new Error("continue rejected");
			}
			return continueOriginal();
		});

		await expect(session.retryLastTurn()).rejects.toThrow("continue rejected");
		continueSpy.mockRestore();

		// The failed assistant message was restored to agent state, so the
		// in-memory transcript still matches what was persisted.
		const lastAfterRejected = session.agent.state.messages[session.agent.state.messages.length - 1] as AssistantMessage;
		expect(lastAfterRejected.role).toBe("assistant");
		expect(lastAfterRejected.stopReason).toBe("error");

		// A second retry still finds the failed turn and succeeds.
		await session.retryLastTurn();
		expect(callCount).toBe(2);
		const lastAfterSuccess = session.agent.state.messages[session.agent.state.messages.length - 1] as AssistantMessage;
		expect(lastAfterSuccess.stopReason).not.toBe("error");
	});
});
