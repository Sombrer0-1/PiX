import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { CoreMessage } from "acp-kernel";
import { isSummaryMessageId } from "acp-kernel";
import {
	BRANCH_SUMMARY_PREFIX,
	BRANCH_SUMMARY_SUFFIX,
	bashExecutionToText,
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import type { CompactionEntry, SessionEntry, SessionManager } from "../session-manager.ts";

const ACP_NUDGE_CUSTOM_TYPE = "pix-acp-nudge";
const ACP_SUMMARY_CUSTOM_TYPE = "pix-acp-summary";
const TOOL_CALL_ID_SUFFIX = "#tool:";

export interface ContextEntry {
	id: string;
	message: AgentMessage;
}

function messageFromContextEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "custom_message") {
		return createCustomMessage(
			entry.customType,
			entry.content,
			entry.display,
			entry.details,
			entry.timestamp,
			entry.context,
		);
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	return undefined;
}

/** Same participation rules as buildSessionContext(): message / custom_message / branch_summary, plus compaction summary. */
export function contextEntriesFromBranch(sessionManager: SessionManager): ContextEntry[] {
	const path = sessionManager.getBranch();
	let compaction: CompactionEntry | undefined;
	for (let i = path.length - 1; i >= 0; i--) {
		const entry = path[i];
		if (entry?.type === "compaction") {
			compaction = entry;
			break;
		}
	}
	const result: ContextEntry[] = [];
	const push = (entry: SessionEntry) => {
		const message = messageFromContextEntry(entry);
		if (message) result.push({ id: entry.id, message });
	};
	if (compaction) {
		result.push({
			id: compaction.id,
			message: createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp),
		});
		const compactionIdx = path.findIndex((entry) => entry.type === "compaction" && entry.id === compaction.id);
		let foundFirstKept = false;
		for (let i = 0; i < compactionIdx; i++) {
			const entry = path[i];
			if (!entry) continue;
			if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
			if (foundFirstKept) push(entry);
		}
		for (let i = compactionIdx + 1; i < path.length; i++) {
			const entry = path[i];
			if (entry) push(entry);
		}
	} else {
		for (const entry of path) push(entry);
	}
	return result;
}

/** Two messages of the same role align iff their keys are equal (role plus that role's identity fields). */
function alignmentKey(message: AgentMessage): string | undefined {
	switch (message.role) {
		case "user":
			return `user\n${textFromContent(message.content)}`;
		case "assistant":
			return `assistant\n${message.timestamp}`;
		case "toolResult":
			return `toolResult\n${message.toolCallId}`;
		case "custom":
			return `custom\n${message.customType}\n${customText(message)}`;
		case "bashExecution":
			return `bashExecution\n${message.command}\n${message.timestamp}`;
		case "branchSummary":
			return `branchSummary\n${message.fromId}\n${message.summary}`;
		case "compactionSummary":
			return `compactionSummary\n${message.summary}`;
	}
}

/** First value in the ascending list that is >= from, or undefined. */
function lowerBound(list: number[], from: number): number | undefined {
	let lo = 0;
	let hi = list.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (list[mid]! < from) lo = mid + 1;
		else hi = mid;
	}
	return lo < list.length ? list[lo] : undefined;
}

/**
 * Identity-align event.messages to buildSessionContext branch entries. Each live
 * message takes the earliest branch entry (>= the last consumed index) whose role
 * and identity fields are equal; unmatched live messages get synthetic
 * acp-msg-${index} ids without consuming branch entries, so retry-dropped
 * assistants and unpersisted messages never steal a later message's entry id.
 */
export function alignContextRawIds(messages: AgentMessage[], sessionManager: SessionManager): string[] {
	const entries = contextEntriesFromBranch(sessionManager);
	const buckets = new Map<string, number[]>();
	for (let index = 0; index < entries.length; index++) {
		const key = alignmentKey(entries[index]!.message);
		if (key === undefined) continue;
		const bucket = buckets.get(key);
		if (bucket) bucket.push(index);
		else buckets.set(key, [index]);
	}
	const ids: string[] = [];
	let i = 0;
	for (let index = 0; index < messages.length; index++) {
		const live = messages[index];
		const key = live ? alignmentKey(live) : undefined;
		const matchedIndex = key !== undefined ? lowerBound(buckets.get(key) ?? [], i) : undefined;
		if (matchedIndex !== undefined) {
			ids.push(entries[matchedIndex]!.id);
			i = matchedIndex + 1;
		} else {
			ids.push(`acp-msg-${index}`);
		}
	}
	return ids;
}

export function branchContextIds(sessionManager: SessionManager): Set<string> {
	return new Set(contextEntriesFromBranch(sessionManager).map((entry) => entry.id));
}

function textFromContent(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function toolCallCoreId(entryId: string, toolCallId: string): string {
	return `${entryId}${TOOL_CALL_ID_SUFFIX}${toolCallId}`;
}

function sourceRawId(coreId: string): string {
	const idx = coreId.indexOf(TOOL_CALL_ID_SUFFIX);
	return idx === -1 ? coreId : coreId.slice(0, idx);
}

function assistantToCores(message: AssistantMessage, id: string): CoreMessage[] {
	const cores: CoreMessage[] = [];
	const toolCalls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
	const thinking = message.content.find((block) => block.type === "thinking");
	const hasText = message.content.some((block) => block.type === "text");
	const text = message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	if (hasText) {
		cores.push({ id, role: "assistant", contentType: "text", text });
	} else if (thinking && thinking.type === "thinking") {
		cores.push({ id, role: "assistant", contentType: "reasoning", text: thinking.thinking });
	}
	for (const toolCall of toolCalls) {
		cores.push({
			id: toolCallCoreId(id, toolCall.id),
			role: "assistant",
			contentType: "tool-call",
			text: JSON.stringify(toolCall.arguments),
			toolName: toolCall.name,
			toolCallId: toolCall.id,
		});
	}
	if (cores.length === 0) {
		cores.push({ id, role: "assistant", contentType: "text", text: "" });
	}
	return cores;
}

function customText(message: Extract<AgentMessage, { role: "custom" }>): string {
	if (typeof message.content === "string") return message.content;
	return textFromContent(message.content);
}

export function agentMessageToCore(message: AgentMessage, id: string): CoreMessage[] {
	switch (message.role) {
		case "user":
			return [{ id, role: "user", contentType: "text", text: textFromContent(message.content) }];
		case "assistant":
			return assistantToCores(message, id);
		case "toolResult":
			return [
				{
					id,
					role: "tool",
					contentType: "tool-result",
					text: textFromContent(message.content),
					toolName: message.toolName,
					toolCallId: message.toolCallId,
				},
			];
		case "custom":
			return [
				{
					id,
					role: "user",
					contentType: "text",
					text: customText(message),
				},
			];
		case "bashExecution":
			return [{ id, role: "user", contentType: "text", text: bashExecutionToText(message) }];
		case "branchSummary":
			return [
				{
					id,
					role: "user",
					contentType: "text",
					text: BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX,
				},
			];
		case "compactionSummary":
			return [
				{
					id,
					role: "user",
					contentType: "text",
					text: COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX,
				},
			];
	}
}

export function agentMessagesToCore(messages: AgentMessage[], rawIds: string[]): CoreMessage[] {
	const cores: CoreMessage[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (!message) continue;
		cores.push(...agentMessageToCore(message, rawIds[index] ?? `acp-msg-${index}`));
	}
	return cores;
}

function applyCoreTextToAgent(message: AgentMessage, core: CoreMessage): AgentMessage {
	const text = core.text ?? "";
	if (message.role === "user") {
		if (typeof message.content === "string") {
			return { ...message, content: text };
		}
		const images = message.content.filter((block): block is ImageContent => block.type === "image");
		return { ...message, content: [{ type: "text", text }, ...images] };
	}
	if (message.role === "assistant") {
		const assistant = message as AssistantMessage;
		if (core.contentType === "tool-call") {
			// Tool-call cores carry the <acp> ref tag in core.text, but an AgentMessage
			// tool call is structured arguments with no free-text slot, so the tag is
			// dropped here by design. Refs still reach the model via the paired
			// tool-result text, keeping compress boundaries citable.
			return assistant;
		}
		let replaced = false;
		const nextContent = assistant.content.map((block) => {
			if (block.type === "text") {
				replaced = true;
				return { ...block, text };
			}
			if (block.type === "thinking" && core.contentType === "reasoning") {
				replaced = true;
				return { ...block, thinking: text };
			}
			return block;
		});
		if (!replaced && core.contentType === "text") {
			return { ...assistant, content: [{ type: "text", text }, ...nextContent] };
		}
		return { ...assistant, content: nextContent };
	}
	if (message.role === "toolResult") {
		const result = message as ToolResultMessage;
		const images = result.content.filter((block): block is ImageContent => block.type === "image");
		return { ...result, content: [{ type: "text", text }, ...images] };
	}
	if (message.role === "custom") {
		if (typeof message.content === "string") {
			return { ...message, content: text };
		}
		const images = message.content.filter((block): block is ImageContent => block.type === "image");
		return { ...message, content: [{ type: "text", text }, ...images] };
	}
	if (message.role === "bashExecution" || message.role === "branchSummary" || message.role === "compactionSummary") {
		return {
			role: "user",
			content: text,
			timestamp: message.timestamp,
		};
	}
	return message;
}

function mergeAssistantFromCores(original: AssistantMessage, cores: CoreMessage[]): AssistantMessage {
	let next: AssistantMessage = original;
	for (const core of cores) {
		if (core.contentType === "tool-call") continue;
		next = applyCoreTextToAgent(next, core) as AssistantMessage;
	}
	return next;
}

function summaryAgentMessage(core: CoreMessage): AgentMessage {
	return {
		role: "custom",
		customType: ACP_SUMMARY_CUSTOM_TYPE,
		content: core.text ?? "",
		display: false,
		timestamp: Date.now(),
	};
}

export function coreMessagesToAgent(cores: CoreMessage[], originals: AgentMessage[], rawIds: string[]): AgentMessage[] {
	const byId = new Map<string, AgentMessage>();
	for (let i = 0; i < originals.length; i++) {
		const id = rawIds[i];
		const original = originals[i];
		if (id && original) byId.set(id, original);
	}
	const result: AgentMessage[] = [];
	const emittedAssistants = new Set<string>();
	for (let i = 0; i < cores.length; i++) {
		const core = cores[i];
		if (!core) continue;
		if (isSummaryMessageId(core.id)) {
			result.push(summaryAgentMessage(core));
			continue;
		}
		const original = byId.get(sourceRawId(core.id));
		if (!original) {
			result.push(summaryAgentMessage(core));
			continue;
		}
		if (original.role === "assistant") {
			const sourceId = sourceRawId(core.id);
			if (emittedAssistants.has(sourceId)) continue;
			emittedAssistants.add(sourceId);
			const group: CoreMessage[] = [core];
			while (i + 1 < cores.length) {
				const next = cores[i + 1];
				if (!next || sourceRawId(next.id) !== sourceId) break;
				group.push(next);
				i++;
			}
			result.push(mergeAssistantFromCores(original, group));
			continue;
		}
		result.push(applyCoreTextToAgent(original, core));
	}
	return result;
}

export function createNudgeMessage(text: string): AgentMessage {
	return {
		role: "custom",
		customType: ACP_NUDGE_CUSTOM_TYPE,
		content: text,
		display: false,
		timestamp: Date.now(),
	};
}

export function isNudgeMessage(message: AgentMessage): boolean {
	return message.role === "custom" && message.customType === ACP_NUDGE_CUSTOM_TYPE;
}
