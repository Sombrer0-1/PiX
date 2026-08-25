import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage, CustomMessageContext } from "../types.ts";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	excludeFromContext?: boolean;
}

export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
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

declare module "../types.ts" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

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

export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					const content = m.context === "internal"
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
					return undefined;
			}
		})
		.filter((m): m is Message => m !== undefined);
}
