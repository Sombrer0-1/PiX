import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompressionBlock, CompressionCore, ProcessTurnInput, ProcessTurnResult } from "acp-kernel";
import { createInitialState, defaultCountTokens } from "acp-kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	alignContextRawIds,
	agentMessagesToCore,
	coreMessagesToAgent,
} from "../../src/core/active-compression/messages.ts";
import { AcpRuntime } from "../../src/core/active-compression/runtime.ts";
import { AcpStateStore, sidecarPathForSessionFile } from "../../src/core/active-compression/state.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

function userMsg(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function assistantMsg(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe("ACP identity align and sidecar inherit", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "acp-align-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("does not zip custom_message onto the assistant entry id", () => {
		const sessionManager = SessionManager.inMemory(tempDir, { acp: true });
		const user = userMsg("hello");
		const userId = sessionManager.appendMessage(user);
		const customId = sessionManager.appendCustomMessageEntry("pi.ui_note", "note", false);
		const assistant = assistantMsg("reply");
		const assistantId = sessionManager.appendMessage(assistant);
		const liveCustom: AgentMessage = {
			role: "custom",
			customType: "pi.ui_note",
			content: "note",
			display: false,
			timestamp: Date.now(),
		};
		const ids = alignContextRawIds([user, liveCustom, assistant], sessionManager);
		expect(ids).toEqual([userId, customId, assistantId]);
	});

	it("skips a branch assistant dropped from agent.state on retry", () => {
		const sessionManager = SessionManager.inMemory(tempDir, { acp: true });
		const user = userMsg("hello");
		const userId = sessionManager.appendMessage(user);
		sessionManager.appendMessage(assistantMsg("overflow"));
		const ids = alignContextRawIds([user], sessionManager);
		expect(ids).toEqual([userId]);
	});

	it("aligns duplicate user texts in order; unmatched live messages keep synthetic ids", () => {
		const sessionManager = SessionManager.inMemory(tempDir, { acp: true });
		const first = sessionManager.appendMessage(userMsg("yes"));
		sessionManager.appendMessage(assistantMsg("ok"));
		const second = sessionManager.appendMessage(userMsg("yes"));
		const live: AgentMessage[] = [
			userMsg("yes"),
			{ role: "custom", customType: "ghost", content: "unpersisted", display: false, timestamp: 1 },
			userMsg("yes"),
		];
		const ids = alignContextRawIds(live, sessionManager);
		expect(ids).toEqual([first, "acp-msg-1", second]);
	});

	it("aligns toolResults by toolCallId after a dropped assistant", () => {
		const sessionManager = SessionManager.inMemory(tempDir, { acp: true });
		const userId = sessionManager.appendMessage(userMsg("run"));
		sessionManager.appendMessage(assistantMsg("calling"));
		const resultId = sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-9",
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 5,
		});
		const live: AgentMessage[] = [
			userMsg("run"),
			{
				role: "toolResult",
				toolCallId: "call-9",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 5,
			},
		];
		const ids = alignContextRawIds(live, sessionManager);
		expect(ids).toEqual([userId, resultId]);
	});

	it("inherits sidecar only when parent blocks share branch ids", () => {
		const parent = SessionManager.create(tempDir, tempDir, { acp: true });
		const userId = parent.appendMessage(userMsg("keep"));
		const parentFile = parent.getSessionFile();
		if (!parentFile) throw new Error("expected parent session file");
		const parentState = createInitialState();
		parentState.blocks.push({
			blockId: "b1",
			runId: "r1",
			tier: 1,
			summary: "parent-only summary",
			directMessageIds: [userId],
			effectiveMessageIds: [userId],
			directBlockIds: [],
			compressedTokens: 8,
			createdAt: 1,
			survivedCount: 0,
			generation: "young",
			active: true,
		});
		parentState.nextBlockId = 2;
		writeFileSync(sidecarPathForSessionFile(parentFile), `${JSON.stringify({ version: 1, state: parentState })}\n`);

		const leafId = parent.getLeafId();
		if (!leafId) throw new Error("expected leaf");
		parent.createBranchedSession(leafId);
		const forked = new AcpStateStore(parent);
		forked.loadOrInherit();
		expect(forked.getState().blocks.map((block) => block.blockId)).toEqual(["b1"]);

		const lineage = SessionManager.create(tempDir, tempDir, { parentSession: parentFile, acp: true });
		lineage.appendMessage(userMsg("brand new"));
		const lineageStore = new AcpStateStore(lineage);
		lineageStore.loadOrInherit();
		expect(lineageStore.getState().blocks).toEqual([]);
	});

	it("does not write or read sidecar while persist session is unflushed", () => {
		const session = SessionManager.create(tempDir, tempDir, { acp: true });
		expect(session.isFlushed()).toBe(false);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("expected session file path");
		const sidecar = sidecarPathForSessionFile(sessionFile);

		const store = new AcpStateStore(session);
		const live = createInitialState();
		live.blocks.push({
			blockId: "b-mem",
			runId: "r1",
			tier: 1,
			summary: "memory-only",
			directMessageIds: ["m1"],
			effectiveMessageIds: ["m1"],
			directBlockIds: [],
			compressedTokens: 8,
			createdAt: 1,
			survivedCount: 0,
			generation: "young",
			active: true,
		});
		live.nextBlockId = 2;
		store.setState(live);
		store.flush();
		expect(existsSync(sidecar)).toBe(false);

		const dirty = createInitialState();
		dirty.blocks.push({
			blockId: "b-dirty",
			runId: "r1",
			tier: 1,
			summary: "pre-placed dirty sidecar",
			directMessageIds: ["m1"],
			effectiveMessageIds: ["m1"],
			directBlockIds: [],
			compressedTokens: 8,
			createdAt: 1,
			survivedCount: 0,
			generation: "young",
			active: true,
		});
		dirty.nextBlockId = 2;
		writeFileSync(sidecar, `${JSON.stringify({ version: 1, state: dirty })}\n`);

		const loaded = new AcpStateStore(session);
		loaded.loadOrInherit();
		expect(loaded.getState().blocks.map((block) => block.blockId)).toEqual(["b-mem"]);
	});

	it("does not inherit from parent when own sidecar is corrupt", () => {
		const parent = SessionManager.create(tempDir, tempDir, { acp: true });
		const userId = parent.appendMessage(userMsg("keep"));
		const parentFile = parent.getSessionFile();
		if (!parentFile) throw new Error("expected parent session file");
		const parentState = createInitialState();
		parentState.blocks.push({
			blockId: "b1",
			runId: "r1",
			tier: 1,
			summary: "parent-only summary",
			directMessageIds: [userId],
			effectiveMessageIds: [userId],
			directBlockIds: [],
			compressedTokens: 8,
			createdAt: 1,
			survivedCount: 0,
			generation: "young",
			active: true,
		});
		parentState.nextBlockId = 2;
		writeFileSync(sidecarPathForSessionFile(parentFile), `${JSON.stringify({ version: 1, state: parentState })}\n`);
		const leafId = parent.getLeafId();
		if (!leafId) throw new Error("expected leaf");
		parent.createBranchedSession(leafId);
		const childFile = parent.getSessionFile();
		if (!childFile) throw new Error("expected child session file");
		writeFileSync(sidecarPathForSessionFile(childFile), "{not-json\n");
		const store = new AcpStateStore(parent);
		store.loadOrInherit();
		expect(store.getState().blocks).toEqual([]);
	});
});

function assistantUsage() {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantWithTools(opts: {
	text?: string;
	thinking?: string;
	toolCalls: Array<{ id: string; name: string; arguments: Record<string, string> }>;
}) {
	return {
		role: "assistant" as const,
		content: [
			...(opts.thinking !== undefined ? [{ type: "thinking" as const, thinking: opts.thinking }] : []),
			...(opts.text !== undefined ? [{ type: "text" as const, text: opts.text }] : []),
			...opts.toolCalls.map((toolCall) => ({
				type: "toolCall" as const,
				id: toolCall.id,
				name: toolCall.name,
				arguments: toolCall.arguments,
			})),
		],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "test",
		usage: assistantUsage(),
		stopReason: "toolUse" as const,
		timestamp: Date.now(),
	};
}

function toolResultMsg(toolCallId: string, toolName: string, text: string) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName,
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function tagAcp(coreText: string, ref = "m00001"): string {
	return `<acp tokens="8" type="user">${ref}</acp>\n${coreText}`;
}

describe("ACP assistant tool-call expansion", () => {
	it("expands two toolCalls without text into two tool-call cores and merges back once", () => {
		const assistant = assistantWithTools({
			toolCalls: [
				{ id: "call-a", name: "read", arguments: { path: "a.ts" } },
				{ id: "call-b", name: "read", arguments: { path: "b.ts" } },
			],
		});
		const r1 = toolResultMsg("call-a", "read", "A");
		const r2 = toolResultMsg("call-b", "read", "B");
		const originals: AgentMessage[] = [userMsg("hi"), assistant, r1, r2];
		const rawIds = ["u1", "a1", "t1", "t2"];
		const cores = agentMessagesToCore(originals, rawIds);
		const toolCalls = cores.filter((core) => core.contentType === "tool-call");
		expect(toolCalls.map((core) => core.toolCallId)).toEqual(["call-a", "call-b"]);
		expect(toolCalls.map((core) => core.id)).toEqual(["a1#tool:call-a", "a1#tool:call-b"]);
		expect(cores.filter((core) => core.role === "assistant" && core.contentType === "text")).toEqual([]);

		const back = coreMessagesToAgent(cores, originals, rawIds);
		const assistants = back.filter((message) => message.role === "assistant");
		expect(assistants).toHaveLength(1);
		const blocks = assistants[0] && assistants[0].role === "assistant" ? assistants[0].content : [];
		expect(blocks.filter((block) => block.type === "toolCall").map((block) => block.type === "toolCall" ? block.id : "")).toEqual([
			"call-a",
			"call-b",
		]);
		expect(back.filter((message) => message.role === "toolResult").map((message) => message.role === "toolResult" ? message.toolCallId : "")).toEqual([
			"call-a",
			"call-b",
		]);
	});

	it("keeps text and every toolCall when expanding text+toolCall assistants", () => {
		const assistant = assistantWithTools({
			text: "I'll read both",
			toolCalls: [
				{ id: "call-a", name: "read", arguments: { path: "a.ts" } },
				{ id: "call-b", name: "read", arguments: { path: "b.ts" } },
			],
		});
		const originals: AgentMessage[] = [assistant];
		const rawIds = ["a1"];
		const cores = agentMessagesToCore(originals, rawIds);
		expect(cores.map((core) => ({ id: core.id, contentType: core.contentType, toolCallId: core.toolCallId }))).toEqual([
			{ id: "a1", contentType: "text", toolCallId: undefined },
			{ id: "a1#tool:call-a", contentType: "tool-call", toolCallId: "call-a" },
			{ id: "a1#tool:call-b", contentType: "tool-call", toolCallId: "call-b" },
		]);

		const tagged = cores.map((core) =>
			core.contentType === "text" ? { ...core, text: tagAcp(core.text ?? "", "m00012") } : core,
		);
		const back = coreMessagesToAgent(tagged, originals, rawIds);
		expect(back).toHaveLength(1);
		const message = back[0];
		expect(message?.role).toBe("assistant");
		if (message?.role !== "assistant") throw new Error("expected assistant");
		const textBlocks = message.content.filter((block) => block.type === "text");
		const toolBlocks = message.content.filter((block) => block.type === "toolCall");
		expect(textBlocks.map((block) => (block.type === "text" ? block.text : ""))).toEqual([tagAcp("I'll read both", "m00012")]);
		expect(toolBlocks.map((block) => (block.type === "toolCall" ? block.id : ""))).toEqual(["call-a", "call-b"]);
	});
});

describe("ACP bash/summary send-view round trip", () => {
	it("returns tagged bashExecution as user text without writing kernel text into output", () => {
		const bash: AgentMessage = {
			role: "bashExecution",
			command: "ls",
			output: "foo",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 42,
		};
		const cores = agentMessagesToCore([bash], ["b1"]);
		expect(cores).toHaveLength(1);
		expect(cores[0]?.role).toBe("user");
		expect(cores[0]?.text).toContain("Ran `ls`");
		expect(cores[0]?.text).toContain("foo");
		const taggedText = tagAcp(cores[0]?.text ?? "");
		const back = coreMessagesToAgent([{ ...cores[0]!, text: taggedText }], [bash], ["b1"]);
		expect(back).toHaveLength(1);
		const message = back[0];
		expect(message?.role).toBe("user");
		if (message?.role !== "user") throw new Error("expected user");
		expect(message.content).toBe(taggedText);
		expect(message.content).toContain("<acp");
		expect(message.timestamp).toBe(42);
		expect(message).not.toHaveProperty("output");
		expect(message).not.toHaveProperty("command");
	});

	it("returns tagged branchSummary and compactionSummary as user text without writing kernel text into summary", () => {
		const branch: AgentMessage = {
			role: "branchSummary",
			summary: "branched away",
			fromId: "leaf-1",
			timestamp: 7,
		};
		const compaction: AgentMessage = {
			role: "compactionSummary",
			summary: "old history",
			tokensBefore: 99,
			timestamp: 8,
		};
		const cores = agentMessagesToCore([branch, compaction], ["br1", "cp1"]);
		expect(cores[0]?.text).toContain("branched away");
		expect(cores[1]?.text).toContain("old history");
		const tagged = [
			{ ...cores[0]!, text: tagAcp(cores[0]?.text ?? "", "m00002") },
			{ ...cores[1]!, text: tagAcp(cores[1]?.text ?? "", "m00003") },
		];
		const back = coreMessagesToAgent(tagged, [branch, compaction], ["br1", "cp1"]);
		expect(back.map((message) => message.role)).toEqual(["user", "user"]);
		for (const message of back) {
			expect(message.role).toBe("user");
			if (message.role !== "user") continue;
			expect(typeof message.content).toBe("string");
			expect(String(message.content)).toContain("<acp");
			expect(message).not.toHaveProperty("summary");
		}
		const first = back[0];
		const second = back[1];
		expect(first?.role === "user" && first.timestamp).toBe(7);
		expect(second?.role === "user" && second.timestamp).toBe(8);
	});
});

const PROVIDER_USAGE_TOKENS = 999_999;

function createCtx(sessionManager: SessionManager): ExtensionContext {
	return {
		getContextUsage: () => ({
			tokens: PROVIDER_USAGE_TOKENS,
			contextWindow: 128000,
			percent: 90,
		}),
		getSystemPrompt: () => "You are a test assistant.",
		model: { contextWindow: 128000 },
	} as ExtensionContext;
}

function coveringBlock(messageId: string, summary: string): CompressionBlock {
	return {
		blockId: "b1",
		runId: "r1",
		tier: 1,
		summary,
		directMessageIds: [messageId],
		effectiveMessageIds: [messageId],
		directBlockIds: [],
		compressedTokens: 8,
		createdAt: 1,
		survivedCount: 0,
		generation: "young",
		active: true,
	};
}

function stubCore(
	processTurn: (input: ProcessTurnInput) => ProcessTurnResult,
): CompressionCore {
	return {
		processTurn,
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
}

function injectNudge(input: ProcessTurnInput): ProcessTurnResult {
	return {
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
	};
}

function compressToolResult(opts: { isError?: boolean; blocksCreated: number }): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `call-compress-${Math.random().toString(16).slice(2)}`,
		toolName: "compress",
		content: [{ type: "text", text: opts.isError ? "error" : "ok" }],
		details: { blocksCreated: opts.blocksCreated, errors: opts.isError ? ["missing id"] : [] },
		isError: opts.isError === true,
		timestamp: Date.now(),
	};
}

describe("ACP send-view tokenCount after prune", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "acp-prune-token-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("tokenCount uses pruned send view, not uncovered tree or getContextUsage", async () => {
		const sessionManager = SessionManager.inMemory(tempDir, { acp: true });
		const user = userMsg("hi");
		sessionManager.appendMessage(user);
		const longText = "x".repeat(20000);
		const assistant = assistantMsg(longText);
		const assistantId = sessionManager.appendMessage(assistant);

		const state = createInitialState();
		state.blocks.push(coveringBlock(assistantId, "short summary"));
		state.nextBlockId = 2;
		const store = new AcpStateStore(sessionManager);
		store.setState(state);
		store.flush();

		const seen: number[] = [];
		const runtime = new AcpRuntime(
			sessionManager,
			stubCore((input) => {
				seen.push(input.tokenCount);
				return { messages: input.messages, state: input.state };
			}),
		);
		runtime.load();
		await runtime.processContext([user, assistant], createCtx(sessionManager));

		const unpruned = defaultCountTokens(`hi${longText}You are a test assistant.`);
		expect(seen).toHaveLength(1);
		expect(seen[0]).not.toBe(PROVIDER_USAGE_TOKENS);
		expect(seen[0]).toBeGreaterThan(0);
		expect(seen[0]).toBeLessThan(unpruned / 2);
	});
});

describe("ACP fuse counts fails after the last success", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "acp-fuse-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("fail-success-fail x3 omits pix-acp-nudge", async () => {
		const sessionManager = SessionManager.inMemory(tempDir, { acp: true });
		const user = userMsg("keep compressing");
		sessionManager.appendMessage(user);
		const fail = (): AgentMessage => compressToolResult({ isError: true, blocksCreated: 0 });
		const success = (): AgentMessage => compressToolResult({ blocksCreated: 1 });
		const messages: AgentMessage[] = [user, fail(), success(), fail(), fail(), fail()];
		const runtime = new AcpRuntime(sessionManager, stubCore(injectNudge));
		const result = await runtime.processContext(messages, createCtx(sessionManager));
		const nudge = result.messages.filter(
			(message) => message.role === "custom" && message.customType === "pix-acp-nudge",
		);
		expect(nudge).toHaveLength(0);
	});
});

describe("ACP decompress path confinement", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "acp-decompress-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("rejects block ids that are not bN before writing", async () => {
		const sessionManager = SessionManager.inMemory(tempDir, { acp: true });
		const runtime = new AcpRuntime(sessionManager);
		await expect(runtime.decompress({ blockId: "../out" })).rejects.toThrow(/invalid block id/);
		const escaped = join(tmpdir(), "out.txt");
		expect(existsSync(escaped)).toBe(false);
	});

	it("writes under os.tmpdir()/pix-acp/<sessionId>/", async () => {
		const sessionManager = SessionManager.inMemory(tempDir, { acp: true });
		const user = userMsg("keep");
		const userId = sessionManager.appendMessage(user);
		const state = createInitialState();
		state.blocks.push(coveringBlock(userId, "kept summary"));
		state.nextBlockId = 2;
		const store = new AcpStateStore(sessionManager);
		store.setState(state);
		store.flush();
		const runtime = new AcpRuntime(sessionManager);
		runtime.load();
		const filePath = await runtime.decompress({ blockId: "b1" });
		const expected = resolve(tmpdir(), "pix-acp", sessionManager.getSessionId(), "b1.txt");
		expect(filePath).toBe(expected);
		expect(existsSync(filePath)).toBe(true);
	});
});
