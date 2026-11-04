/**
 * Model-context screenshot retention.
 *
 * Keeps only the newest computer-use screenshots in the messages handed to the
 * model and replaces older ones with a one-line text placeholder, so a long
 * desktop session does not resend stale pixels on every turn. Invoked from the
 * computer-use extension `context` handler (emitContext clones the messages
 * before the chain runs; this function is pure and never mutates its input).
 *
 * Only `toolResult` messages of the two PiX computer tools are touched - user
 * uploads and other tools' images are left alone. Removals beyond `keepRecent`
 * are rounded down to a multiple of `chunk`, so a given screenshot is rewritten
 * at most once instead of every turn (fewer provider prefix-cache
 * invalidations). Message count, order and tool_call/toolResult pairing never
 * change; removed images become text items in place.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isComputerToolName, type ScreenshotRetentionPolicy } from "./contracts.js";

export const SCREENSHOT_PLACEHOLDER_PREFIX = "[earlier computer screenshot removed to save context";

/** Pure. Returns the same array instance when nothing changes. */
export function applyScreenshotRetention(messages: AgentMessage[], policy: ScreenshotRetentionPolicy): AgentMessage[] {
	const keepRecent = Math.max(0, Math.floor(policy.keepRecent) || 0);
	const chunk = Math.max(1, Math.floor(policy.chunk) || 1);

	// Oldest -> newest positions of computer-tool screenshots (other messages and
	// other content types are never candidates).
	const screenshots: Array<{ messageIndex: number; itemIndex: number }> = [];
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const message = messages[messageIndex];
		if (message.role !== "toolResult" || !isComputerToolName(message.toolName)) continue;
		for (let itemIndex = 0; itemIndex < message.content.length; itemIndex++) {
			if (message.content[itemIndex].type === "image") screenshots.push({ messageIndex, itemIndex });
		}
	}

	// n <= keepRecent + chunk - 1 stays untouched: removals come in chunks of `chunk`.
	const excess = screenshots.length - keepRecent;
	const removeCount = excess <= 0 ? 0 : Math.min(screenshots.length, Math.floor(excess / chunk) * chunk);
	if (removeCount === 0) return messages;

	const removalByMessage = new Map<number, Set<number>>();
	for (let index = 0; index < removeCount; index++) {
		const { messageIndex, itemIndex } = screenshots[index];
		let itemIndexes = removalByMessage.get(messageIndex);
		if (itemIndexes === undefined) {
			itemIndexes = new Set<number>();
			removalByMessage.set(messageIndex, itemIndexes);
		}
		itemIndexes.add(itemIndex);
	}

	return messages.map((message, messageIndex) => {
		const itemIndexes = removalByMessage.get(messageIndex);
		if (itemIndexes === undefined || message.role !== "toolResult") return message;
		const captureId = readCaptureId(message.details);
		return {
			...message,
			content: message.content.map((item, itemIndex) =>
				item.type === "image" && itemIndexes.has(itemIndex) ? screenshotPlaceholder(captureId) : item,
			),
		};
	});
}

/** captureId lives on the message details; anything malformed reads as n/a. */
function readCaptureId(details: unknown): string | null {
	if (typeof details !== "object" || details === null) return null;
	const value = (details as { captureId?: unknown }).captureId;
	return typeof value === "string" && value.length > 0 ? value : null;
}

function screenshotPlaceholder(captureId: string | null): { type: "text"; text: string } {
	return { type: "text", text: `${SCREENSHOT_PLACEHOLDER_PREFIX}; capture_id=${captureId ?? "n/a"}]` };
}
