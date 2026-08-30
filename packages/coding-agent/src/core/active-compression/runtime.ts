import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	blockById,
	buildStatusReport,
	collectBlockContent,
	createCore,
	defaultConfig,
	defaultCountTokens,
	parseBlockIdArg,
	parseCompressArgs,
	prune,
	renderNudgeText,
} from "acp-kernel";
import type { CompressionCore, Config, CoreMessage, NudgeDecision } from "acp-kernel";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionContext } from "../extensions/types.ts";
import { assertValidSessionId, type SessionManager } from "../session-manager.ts";
import {
	agentMessagesToCore,
	alignContextRawIds,
	contextEntriesFromBranch,
	coreMessagesToAgent,
	createNudgeMessage,
	isNudgeMessage,
} from "./messages.ts";
import { AcpStateStore } from "./state.ts";
import {
	ACP_NUDGE_FAIL_LIMIT,
	ACP_TOOL_NAMES,
	type AcpStatusToolArgs,
	type CompressToolArgs,
	type DecompressToolArgs,
	type SearchContextToolArgs,
} from "./types.ts";

export interface CompressApplyDetails {
	blocksCreated: number;
	tokensCompressed: number;
	errors: string[];
	noop?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compressFailFromToolResult(message: AgentMessage): boolean {
	if (message.role !== "toolResult" || message.toolName !== "compress") return false;
	if (message.isError) return true;
	if (!isRecord(message.details)) return false;
	if (message.details.noop === true) return true;
	if (message.details.blocksCreated === 0) return true;
	return false;
}

function compressSuccessFromToolResult(message: AgentMessage): boolean {
	if (message.role !== "toolResult" || message.toolName !== "compress") return false;
	if (message.isError) return false;
	if (!isRecord(message.details)) return false;
	return typeof message.details.blocksCreated === "number" && message.details.blocksCreated > 0;
}

function outcomesSinceLastUser(messages: AgentMessage[]): { fails: number } {
	let lastUser = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") {
			lastUser = i;
			break;
		}
	}
	const slice = lastUser >= 0 ? messages.slice(lastUser + 1) : messages;
	let fails = 0;
	for (const message of slice) {
		if (compressSuccessFromToolResult(message)) {
			fails = 0;
			continue;
		}
		if (compressFailFromToolResult(message)) fails++;
	}
	return { fails };
}

export class AcpRuntime {
	private readonly core: CompressionCore;
	private readonly store: AcpStateStore;
	private sourceCores: CoreMessage[] = [];
	private failTurnKey = "";
	private failCount = 0;
	private lastCompress: CompressApplyDetails = { blocksCreated: 0, tokensCompressed: 0, errors: [] };

	private readonly sessionManager: SessionManager;

	constructor(
		sessionManager: SessionManager,
		core?: CompressionCore,
	) {
		this.sessionManager = sessionManager;
		this.core = core ?? createCore();
		this.store = new AcpStateStore(sessionManager);
	}

	lastCompressDetails(): CompressApplyDetails {
		return this.lastCompress;
	}

	load(): void {
		this.store.loadOrInherit();
	}

	flush(): void {
		this.store.flush();
	}

	async processContext(
		messages: AgentMessage[],
		ctx: ExtensionContext,
	): Promise<{ messages: AgentMessage[] }> {
		this.updateFuse(messages);
		const rawIds = alignContextRawIds(messages, this.sessionManager);
		const coreMessages = agentMessagesToCore(messages, rawIds);
		this.sourceCores = coreMessages;
		const pruned = prune(coreMessages, this.store.getState());
		const tokenCount = this.estimateSendViewTokens(pruned, ctx);
		const usage = ctx.getContextUsage();
		if (usage) {
			console.log(
				`[acp] send-view tokens=${tokenCount} contextWindow=${ctx.model?.contextWindow ?? 0} providerUsage=${usage.tokens}`,
			);
		}
		try {
			const result = this.core.processTurn({
				messages: coreMessages,
				state: this.store.getState(),
				config: this.buildConfig(ctx),
				tokenCount,
			});
			this.store.setState(result.state);
			this.store.flush();
			const converted = coreMessagesToAgent(result.messages, messages, rawIds);
			return { messages: this.appendNudge(converted, result.nudge) };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`[acp] processTurn failed: ${message}`);
			return { messages };
		}
	}

	applyCompressResult(args: CompressToolArgs, ctx: ExtensionContext): {
		text: string;
		isError: boolean;
		details: CompressApplyDetails;
	} {
		const parsed = parseCompressArgs(args);
		if (!parsed.diagnostics.ok || parsed.ranges.length === 0) {
			const details: CompressApplyDetails = {
				blocksCreated: 0,
				tokensCompressed: 0,
				errors: [parsed.diagnostics.kind],
				noop: true,
			};
			this.lastCompress = details;
			return { text: `compress failed: ${parsed.diagnostics.kind}`, isError: true, details };
		}
		try {
			const cores = this.coresForTools();
			const applied = this.core.applyCompression({
				ranges: parsed.ranges,
				messages: cores,
				state: this.store.getState(),
				config: this.buildConfig(ctx),
			});
			this.store.setState(applied.state);
			this.store.flush();
			const details: CompressApplyDetails = {
				blocksCreated: applied.result.blocksCreated,
				tokensCompressed: applied.result.tokensCompressed,
				errors: applied.result.errors,
				noop: applied.result.blocksCreated === 0,
			};
			this.lastCompress = details;
			if (applied.result.blocksCreated === 0) {
				const reason = applied.result.errors.join("; ") || "noop";
				return { text: `compress failed: ${reason}`, isError: true, details };
			}
			const warnings = applied.result.warnings.length > 0 ? `\n${applied.result.warnings.join("\n")}` : "";
			return {
				text: `Compressed ${applied.result.blocksCreated} block(s), ${applied.result.tokensCompressed} tokens.${warnings}`,
				isError: false,
				details,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const details: CompressApplyDetails = {
				blocksCreated: 0,
				tokensCompressed: 0,
				errors: [message],
				noop: true,
			};
			this.lastCompress = details;
			return { text: `compress failed: ${message}`, isError: true, details };
		}
	}

	async applyCompress(args: CompressToolArgs, ctx: ExtensionContext): Promise<string> {
		const result = this.applyCompressResult(args, ctx);
		if (result.isError) throw new Error(result.text);
		return result.text;
	}

	async decompress(args: DecompressToolArgs): Promise<string> {
		const blockId = parseBlockIdArg(args.blockId);
		if (!blockId) {
			throw new Error(`decompress failed: invalid block id ${args.blockId}`);
		}
		const state = this.store.getState();
		const block = this.core.decompress(blockId, state) ?? blockById(state, blockId);
		if (!block) {
			throw new Error(`decompress failed: block ${args.blockId} not found`);
		}
		const collected = collectBlockContent(state, block, this.coresForTools(), { full: args.full === true });
		const body = collected.text.length > 0 ? collected.text : block.summary;
		if (args.inline === true) {
			return body;
		}
		const sessionId = this.sessionManager.getSessionId();
		assertValidSessionId(sessionId);
		if (sessionId.includes("..")) {
			throw new Error("decompress failed: invalid session id");
		}
		const safeBlockId = parseBlockIdArg(block.blockId);
		if (!safeBlockId || !/^b\d+$/.test(safeBlockId)) {
			throw new Error(`decompress failed: invalid block id ${block.blockId}`);
		}
		const dir = resolve(tmpdir(), "pix-acp", sessionId);
		const filePath = resolve(dir, `${safeBlockId}.txt`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(filePath, body, "utf-8");
		return filePath;
	}

	async search(args: SearchContextToolArgs): Promise<string> {
		const hits = this.core.search(args.query, this.store.getState());
		if (hits.length === 0) {
			return "No matching compressed blocks.";
		}
		return hits
			.map((block) => `${block.blockId} t${block.tier}: ${block.topic ?? "(no topic)"}\n${block.summary}`)
			.join("\n\n");
	}

	async status(args: AcpStatusToolArgs): Promise<string> {
		const scope = args.scope === "uncompressed" ? "uncompressed" : "compressed";
		return buildStatusReport(this.store.getState(), this.coresForTools(), defaultCountTokens, {
			scope,
			view: args.view === "messages" ? "messages" : "ranges",
		});
	}

	private coresForTools(): CoreMessage[] {
		if (this.sourceCores.length > 0) return this.sourceCores;
		const entries = contextEntriesFromBranch(this.sessionManager);
		return agentMessagesToCore(
			entries.map((entry) => entry.message),
			entries.map((entry) => entry.id),
		);
	}

	private estimateSendViewTokens(coreMessages: CoreMessage[], ctx: ExtensionContext): number {
		// Newline separators keep message boundaries from fusing into one token run.
		const parts: string[] = [];
		for (const message of coreMessages) {
			if (message.text) parts.push(message.text);
		}
		const systemPrompt = ctx.getSystemPrompt?.() ?? "";
		if (systemPrompt) parts.push(systemPrompt);
		return defaultCountTokens(parts.join("\n"));
	}

	private buildConfig(ctx: ExtensionContext): Config {
		const window = ctx.model?.contextWindow ?? 128000;
		return defaultConfig(window, { protectedTools: [...ACP_TOOL_NAMES] });
	}

	private currentTurnKey(): string {
		const branch = this.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry?.type === "message" && entry.message.role === "user") {
				return entry.id;
			}
		}
		return this.sessionManager.getSessionId();
	}

	private updateFuse(messages: AgentMessage[]): void {
		const key = this.currentTurnKey();
		if (key !== this.failTurnKey) {
			this.failTurnKey = key;
			this.failCount = 0;
		}
		this.failCount = outcomesSinceLastUser(messages).fails;
	}

	private appendNudge(messages: AgentMessage[], nudge: NudgeDecision | undefined): AgentMessage[] {
		if (!nudge?.shouldInject) return messages;
		if (this.failCount >= ACP_NUDGE_FAIL_LIMIT) return messages;
		const rendered = renderNudgeText(nudge);
		if (messages.some(isNudgeMessage)) return messages;
		return [...messages, createNudgeMessage(rendered.text)];
	}
}

