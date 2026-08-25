/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

export type CustomMessageContext = "user" | "internal";

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Internal messages are model-visible runtime signals, not user requests. */
	context?: CustomMessageContext;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
	context?: CustomMessageContext,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		...(context === undefined ? {} : { context }),
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * Pre-protocol customType values persisted without context:"internal".
 * Keep this list identical to pix INTERNAL_CUSTOM_MESSAGE_TYPES. A drift test
 * in pix/src/renderer/__tests__/display-blocks.test.ts asserts both sides.
 */
export const LEGACY_INTERNAL_CUSTOM_TYPES = new Set([
	"pix-agent-task-result",
	"pix-plan-context",
	"pix-plan-retry",
	"pix-team-notification",
]);

/**
 * Detect current and pre-protocol internal custom messages. The legacy
 * customType fallback keeps already persisted sessions model-visible as
 * internal notifications after a reload.
 */
export function isInternalCustomMessage(message: Pick<CustomMessage, "customType" | "context">): boolean {
	return message.context === "internal" || LEGACY_INTERNAL_CUSTOM_TYPES.has(message.customType);
}

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/'/g, "&apos;");
}

function wrapInternalContent(
	customType: string,
	content: string | (TextContent | ImageContent)[],
): (TextContent | ImageContent)[] {
	const prefix = `<internal-message custom-type="${escapeXmlAttribute(customType)}">\n`;
	const suffix = "\n</internal-message>";
	if (typeof content === "string") {
		return [{ type: "text", text: prefix + content + suffix }];
	}
	return [{ type: "text", text: prefix }, ...content, { type: "text", text: suffix }];
}

function contentText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** Legacy roots: opening tag paired with its closing tag, both required. */
const LEGACY_INTERNAL_NOTIFICATION_TAGS: ReadonlyArray<readonly [string, string]> = [
	["</internal-message>", "<internal-message"],
	["</task-notification>", "<task-notification"],
	["</team-notification>", "<team-notification"],
	["</plan-notification>", "<plan-notification"],
	["</workflow-result>", "<workflow-result"],
	["</orchestrator-event>", "<orchestrator-event"],
	["</teammate-message>", "<teammate-message"],
	["</worker-summary>", "<worker-summary"],
];

/**
 * Detect legacy runtime notification text stored as a user message. A text
 * only matches when the WHOLE message is a single closed envelope: it starts
 * with a reserved opening tag (followed by whitespace or ">") and ends with
 * that tag's closing tag. A user message that merely mentions the format, or
 * one that carries extra text before/after the example, is never wrapped as an
 * internal notification.
 */
function isLegacyInternalNotificationText(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0) return false;
	const lower = trimmed.toLowerCase();
	return LEGACY_INTERNAL_NOTIFICATION_TAGS.some(([closing, opening]) => {
		if (!lower.startsWith(opening) || !lower.endsWith(closing)) return false;
		const afterOpening = lower[opening.length];
		return afterOpening === undefined || afterOpening === ">" || afterOpening === "\n" || afterOpening === " " || afterOpening === "\t";
	});
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					// Skip messages excluded from context (!! prefix)
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					if (m.customType === "pi.ui_note") {
						return undefined;
					}
					const content = isInternalCustomMessage(m)
						? wrapInternalContent(m.customType, m.content)
						: typeof m.content === "string"
							? [{ type: "text" as const, text: m.content }]
							: m.content;
					return {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				case "user":
					if (isLegacyInternalNotificationText(contentText(m.content))) {
						return {
							...m,
							content: wrapInternalContent("legacy-runtime-notification", m.content),
						};
					}
					return m;
				case "assistant":
				case "toolResult":
					return m;
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		.filter((m) => m !== undefined);
}
