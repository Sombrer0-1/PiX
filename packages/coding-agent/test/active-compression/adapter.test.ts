import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompressionCore, ProcessTurnInput, ProcessTurnResult } from "acp-kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createActiveCompressionExtension } from "../../src/core/active-compression/extension.ts";
import {
	ACP_STATUS_PROMPT_GUIDELINES,
	COMPRESS_PROMPT_GUIDELINES,
} from "../../src/core/active-compression/prompt.ts";
import { AcpRuntime } from "../../src/core/active-compression/runtime.ts";
import { ACP_TOOL_NAMES } from "../../src/core/active-compression/types.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { userMsg } from "../utilities.ts";

const PROVIDER_USAGE_TOKENS = 999_999;

function toolResult(
	toolName: string,
	opts: { isError?: boolean; text?: string; details?: Record<string, unknown> } = {},
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${toolName}-${Math.random().toString(16).slice(2)}`,
		toolName,
		content: [{ type: "text", text: opts.text ?? (opts.isError ? "error" : "ok") }],
		details: opts.details ?? {},
		isError: opts.isError === true,
		timestamp: Date.now(),
	};
}

function createCtx(sessionManager: SessionManager, overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		ui: {} as ExtensionContext["ui"],
		hasUI: false,
		cwd: sessionManager.getCwd(),
		sessionManager,
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: {
			id: "test",
			name: "test",
			api: "anthropic-messages",
			provider: "test",
			baseUrl: "http://localhost",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		},
		isIdle: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => ({
			tokens: PROVIDER_USAGE_TOKENS,
			contextWindow: 128000,
			percent: 90,
		}),
		compact: () => {},
		getSystemPrompt: () => "You are a test assistant.",
		...overrides,
	};
}

async function loadFactory(sessionManager: SessionManager) {
	const runtime = createExtensionRuntime();
	const eventBus = createEventBus();
	const extension = await loadExtensionFromFactory(
		createActiveCompressionExtension(() => sessionManager),
		sessionManager.getCwd(),
		eventBus,
		runtime,
		"<inline:acp>",
	);
	return { extension, runtime };
}

describe("ACP adapter", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "acp-adapter-"));
		mkdirSync(join(tempDir, "agent"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("OFF factory registers nothing", async () => {
		const sessionManager = SessionManager.inMemory(tempDir);
		expect(sessionManager.getAcp()).toBe(false);
		const { extension } = await loadFactory(sessionManager);
		expect([...extension.tools.keys()]).toEqual([]);
		expect(extension.handlers.size).toBe(0);
	});

	it("ON factory registers exactly the four ACP tool names", async () => {
		const sessionManager = SessionManager.inMemory(tempDir, { acp: true });
		const { extension } = await loadFactory(sessionManager);
		expect([...extension.tools.keys()].sort()).toEqual([...ACP_TOOL_NAMES].sort());
		expect(extension.handlers.has("context")).toBe(true);
		expect(extension.handlers.has("session_before_compact")).toBe(true);
		expect(extension.handlers.has("session_start")).toBe(true);
		expect(extension.handlers.has("session_shutdown")).toBe(true);
		expect(extension.commands.size).toBe(0);
	});

	it("illegal compress does not crash and reports isError", () => {
		const sessionManager = SessionManager.inMemory(tempDir, { acp: true });
		const runtime = new AcpRuntime(sessionManager);
		const result = runtime.applyCompressResult({ content: "not-json" }, createCtx(sessionManager));
		expect(result.isError).toBe(true);
		expect(result.details.blocksCreated).toBe(0);
		expect(result.text).toMatch(/compress failed/);
	});

	it("processContext failure returns original messages", async () => {
		const sessionManager = SessionManager.inMemory(tempDir, { acp: true });
		sessionManager.appendMessage(userMsg("hello"));
		const originals: AgentMessage[] = [userMsg("hello")];
		const core: CompressionCore = {
			processTurn: () => {
				throw new Error("kernel boom");
			},
			applyCompression: () => {
				throw new Error("unused");
			},
			defaultNodes: () => [],
			decompress: () => undefined,
			search: () => [],
			status: () => ({
				contextUsage: 0,
				tokenCount: 0,
				modelContextLimit: 128000,
				activeBlocks: 0,
				totalBlocks: 0,
				tokensCompressed: 0,
				breakdown: {},
			}),
		};
		const runtime = new AcpRuntime(sessionManager, core);
		const result = await runtime.processContext(originals, createCtx(sessionManager));
		expect(result.messages).toBe(originals);
	});

	it("tokenCount does not use getContextUsage as processTurn arbiter", async () => {
		const sessionManager = SessionManager.inMemory(tempDir, { acp: true });
		sessionManager.appendMessage(userMsg("hello"));
		const seen: number[] = [];
		const core: CompressionCore = {
			processTurn: (input: ProcessTurnInput): ProcessTurnResult => {
				seen.push(input.tokenCount);
				return { messages: input.messages, state: input.state };
			},
			applyCompression: () => {
				throw new Error("unused");
			},
			defaultNodes: () => [],
			decompress: () => undefined,
			search: () => [],
			status: () => ({
				contextUsage: 0,
				tokenCount: 0,
				modelContextLimit: 128000,
				activeBlocks: 0,
				totalBlocks: 0,
				tokensCompressed: 0,
				breakdown: {},
			}),
		};
		const runtime = new AcpRuntime(sessionManager, core);
		await runtime.processContext([userMsg("hello")], createCtx(sessionManager));
		expect(seen).toHaveLength(1);
		expect(seen[0]).not.toBe(PROVIDER_USAGE_TOKENS);
		expect(seen[0]).toBeGreaterThan(0);
	});

	it("same-turn 3 failures omit nudge from the returned array", async () => {
		const sessionManager = SessionManager.inMemory(tempDir, { acp: true });
		const user = userMsg("keep compressing");
		sessionManager.appendMessage(user);
		const fail = (): AgentMessage =>
			toolResult("compress", { isError: true, details: { blocksCreated: 0, errors: ["missing id"] } });
		const messages: AgentMessage[] = [user, fail(), fail(), fail()];
		const core: CompressionCore = {
			processTurn: (input: ProcessTurnInput): ProcessTurnResult => ({
				messages: input.messages,
				state: input.state,
				nudge: {
					shouldInject: true,
					reason: "over limit",
					compressibleRanges: [],
					contextUsage: 0.8,
					tier: null,
					breakdown: {
						usage: 0.8,
						growth: 0,
						growthReference: 0,
						effectiveThreshold: 0,
						nudgeGrowthTokens: 0,
						growthFloor: 0,
						hasPendingNudge: 1,
						overLimit: 1,
						emergencyOverride: 0,
						pendingT1: 0,
						pendingT2: 0,
						pendingT3: 0,
					},
				},
			}),
			applyCompression: () => {
				throw new Error("unused");
			},
			defaultNodes: () => [],
			decompress: () => undefined,
			search: () => [],
			status: () => ({
				contextUsage: 0,
				tokenCount: 0,
				modelContextLimit: 128000,
				activeBlocks: 0,
				totalBlocks: 0,
				tokensCompressed: 0,
				breakdown: {},
			}),
		};
		const runtime = new AcpRuntime(sessionManager, core);
		const result = await runtime.processContext(messages, createCtx(sessionManager));
		const nudge = result.messages.filter(
			(message) => message.role === "custom" && message.customType === "pix-acp-nudge",
		);
		expect(nudge).toHaveLength(0);
	});

	it("prompt guidelines cover the six required themes", () => {
		const text = [...COMPRESS_PROMPT_GUIDELINES, ...ACP_STATUS_PROMPT_GUIDELINES].join("\n");
		expect(text).toMatch(/Do not compress/);
		expect(text).toMatch(/verbatim/);
		expect(text).toMatch(/<acp>/);
		expect(text).toMatch(/historical record/);
		expect(text).toMatch(/arithmetic/);
		expect(text).toMatch(/multiple ranges/);
	});

	it("nudge is appended before the fuse trips", async () => {
		const sessionManager = SessionManager.inMemory(tempDir, { acp: true });
		const user = userMsg("compress soon");
		sessionManager.appendMessage(user);
		const messages: AgentMessage[] = [user];
		const core: CompressionCore = {
			processTurn: (input: ProcessTurnInput): ProcessTurnResult => ({
				messages: input.messages,
				state: input.state,
				nudge: {
					shouldInject: true,
					reason: "over limit",
					compressibleRanges: [],
					contextUsage: 0.8,
					tier: null,
					breakdown: {
						usage: 0.8,
						growth: 0,
						growthReference: 0,
						effectiveThreshold: 0,
						nudgeGrowthTokens: 0,
						growthFloor: 0,
						hasPendingNudge: 1,
						overLimit: 1,
						emergencyOverride: 0,
						pendingT1: 0,
						pendingT2: 0,
						pendingT3: 0,
					},
				},
			}),
			applyCompression: () => {
				throw new Error("unused");
			},
			defaultNodes: () => [],
			decompress: () => undefined,
			search: () => [],
			status: () => ({
				contextUsage: 0,
				tokenCount: 0,
				modelContextLimit: 128000,
				activeBlocks: 0,
				totalBlocks: 0,
				tokensCompressed: 0,
				breakdown: {},
			}),
		};
		const runtime = new AcpRuntime(sessionManager, core);
		const result = await runtime.processContext(messages, createCtx(sessionManager));
		expect(
			result.messages.some((message) => message.role === "custom" && message.customType === "pix-acp-nudge"),
		).toBe(true);
	});
});
