import type { AssistantMessage, AssistantMessageEvent, ThinkingContent } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { HistoryItem } from "../presentation.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export type AssistantFrame =
	| { type: "start" }
	| { type: "update"; event: AssistantMessageEvent }
	| { type: "end"; errorMessage?: string };

function firstNonEmptyLine(text: string): string {
	const line = text.split("\n").find((part) => part.trim());
	return line?.trim() ?? "";
}

function lastNonEmptyLine(text: string): string {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line?.trim()) return line.trim();
	}
	return "";
}

class PreviewLine implements Component {
	private plain = "";
	private paint: (text: string) => string = (text) => text;
	private paddingX: number;

	constructor(paddingX: number) {
		this.paddingX = paddingX;
	}

	setPlain(plain: string, paint: (text: string) => string): void {
		this.plain = plain;
		this.paint = paint;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const pad = Math.min(this.paddingX, Math.max(0, width));
		const inner = Math.max(0, width - pad);
		const clipped = truncateToWidth(this.plain, inner, "…");
		const line = " ".repeat(pad) + this.paint(clipped);
		const gap = width - visibleWidth(line);
		return [gap > 0 ? line + " ".repeat(gap) : line];
	}
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private readonly progressive: boolean;
	private streaming = false;
	private localErrorMessage?: string;
	private readonly settledThinking = new Set<number>();
	private readonly thinkingLines = new Map<number, PreviewLine>();
	private readonly textBlocks = new Map<number, Markdown>();
	private pixLabel?: Text;
	private errorText?: Text;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		options?: { progressive?: boolean },
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme ?? getMarkdownTheme();
		this.hiddenThinkingLabel = hiddenThinkingLabel ?? "Thinking...";
		this.progressive = options?.progressive === true;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (!this.lastMessage) return;
		if (this.progressive) this.applyProgressive();
		else this.renderClassic(this.lastMessage);
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (!this.lastMessage) return;
		if (this.progressive) this.applyProgressive();
		else this.renderClassic(this.lastMessage);
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (!this.lastMessage) return;
		if (this.progressive) this.applyProgressive();
		else this.renderClassic(this.lastMessage);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, frame?: AssistantFrame): void {
		this.lastMessage = message;
		if (!this.progressive) {
			this.renderClassic(message);
			return;
		}
		this.consumeFrame(message, frame);
		this.applyProgressive();
	}

	getHistoryItems(messageId: string): readonly HistoryItem[] {
		const message = this.lastMessage;
		if (!message) return [];
		const items: HistoryItem[] = [];
		const hasToolCalls = message.content.some((block) => block.type === "toolCall");
		for (let index = 0; index < message.content.length; index++) {
			const block = message.content[index];
			if (!block || block.type === "toolCall") continue;
			if (block.type === "thinking") {
				const label = this.thinkingLabel(block, index);
				if (!label) continue;
				const detail = this.thinkingDetail(block);
				items.push({
					id: `${messageId}:thinking:${index}`,
					kind: "thinking",
					label,
					detail,
				});
				continue;
			}
			if (!block.text.trim()) continue;
			const settled = !this.progressive || !this.streaming;
			items.push({
				id: `${messageId}:text:${index}`,
				kind: "assistant",
				label: settled && !hasToolCalls ? "Answer" : firstNonEmptyLine(block.text) || "Answer",
				detail: () => block.text,
			});
		}
		const errorLine = this.progressive ? this.resolveErrorLine(message) : this.classicErrorLine(message);
		if (errorLine && !hasToolCalls) {
			items.push({
				id: `${messageId}:error:0`,
				kind: "error",
				label: firstNonEmptyLine(errorLine) || errorLine,
				detail: () => errorLine,
			});
		}
		return items;
	}

	private consumeFrame(message: AssistantMessage, frame: AssistantFrame | undefined): void {
		if (!frame) {
			this.streaming = false;
			this.localErrorMessage = undefined;
			this.settleAllThinking(message);
			return;
		}
		if (frame.type === "start") {
			this.streaming = true;
			this.localErrorMessage = undefined;
			this.settledThinking.clear();
			this.settleThinkingFollowedByOutput(message);
			return;
		}
		if (frame.type === "end") {
			this.streaming = false;
			this.localErrorMessage = frame.errorMessage || undefined;
			this.settleAllThinking(message);
			return;
		}
		this.streaming = true;
		const event = frame.event;
		if (event.type === "thinking_end") this.settledThinking.add(event.contentIndex);
		if (
			event.type === "text_start" ||
			event.type === "text_delta" ||
			event.type === "text_end" ||
			event.type === "toolcall_start" ||
			event.type === "toolcall_delta" ||
			event.type === "toolcall_end"
		) {
			this.settleThinkingBefore(event.contentIndex);
		}
		this.settleThinkingFollowedByOutput(message);
	}

	private settleAllThinking(message: AssistantMessage): void {
		for (let index = 0; index < message.content.length; index++) {
			if (message.content[index]?.type === "thinking") this.settledThinking.add(index);
		}
	}

	private settleThinkingBefore(index: number): void {
		const message = this.lastMessage;
		if (!message) return;
		for (let i = 0; i < message.content.length && i < index; i++) {
			if (message.content[i]?.type === "thinking") this.settledThinking.add(i);
		}
	}

	private settleThinkingFollowedByOutput(message: AssistantMessage): void {
		let seenLater = false;
		for (let index = message.content.length - 1; index >= 0; index--) {
			const block = message.content[index];
			if (!block) continue;
			if (block.type === "toolCall" || (block.type === "text" && block.text.trim())) {
				seenLater = true;
				continue;
			}
			if (block.type === "thinking" && seenLater) this.settledThinking.add(index);
		}
	}

	private thinkingLabel(content: ThinkingContent, index: number): string | undefined {
		if (this.hideThinkingBlock) return this.hiddenThinkingLabel;
		if (content.redacted) return content.thinking.trim() || "Reasoning unavailable";
		const open = this.progressive && this.streaming && !this.settledThinking.has(index);
		if (open) {
			const recent = lastNonEmptyLine(content.thinking);
			return recent ? `Thinking… ${recent}` : "Thinking…";
		}
		return firstNonEmptyLine(content.thinking) || undefined;
	}

	private thinkingDetail(content: ThinkingContent): (() => string) | undefined {
		if (content.redacted) {
			const hint = content.thinking.trim() || "Reasoning unavailable";
			return () => hint;
		}
		if (!content.thinking.trim()) return undefined;
		const body = content.thinking;
		return () => body;
	}

	private paintThinking(text: string): string {
		return theme.italic(theme.fg("thinkingText", text));
	}

	private applyProgressive(): void {
		const message = this.lastMessage;
		if (!message) return;
		this.contentContainer.clear();
		const keepThinking = new Set<number>();
		const keepText = new Set<number>();
		let hasVisible = false;
		let hasText = false;
		for (let index = 0; index < message.content.length; index++) {
			const block = message.content[index];
			if (block?.type === "thinking" && this.thinkingLabel(block, index)) hasVisible = true;
			if (block?.type === "text" && block.text.trim()) {
				hasVisible = true;
				hasText = true;
			}
		}
		const errorLine = this.resolveErrorLine(message);
		const hasToolCalls = message.content.some((block) => block.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (errorLine && !hasToolCalls) hasVisible = true;
		if (hasVisible) this.contentContainer.addChild(new Spacer(1));

		let labelPlaced = false;
		let thinkingShown = false;
		for (let index = 0; index < message.content.length; index++) {
			const block = message.content[index];
			if (!block) continue;
			if (block.type === "thinking") {
				const label = this.thinkingLabel(block, index);
				if (!label) continue;
				keepThinking.add(index);
				let preview = this.thinkingLines.get(index);
				if (!preview) {
					preview = new PreviewLine(2);
					this.thinkingLines.set(index, preview);
				}
				preview.setPlain(label, (text) => this.paintThinking(text));
				this.contentContainer.addChild(preview);
				thinkingShown = true;
				continue;
			}
			if (block.type !== "text" || !block.text.trim()) continue;
			if (thinkingShown && !labelPlaced) this.contentContainer.addChild(new Spacer(1));
			if (!labelPlaced) {
				if (!this.pixLabel) this.pixLabel = new Text("", 0, 0);
				this.pixLabel.setText(theme.bold(theme.fg("accent", "PiX")));
				this.contentContainer.addChild(this.pixLabel);
				labelPlaced = true;
			}
			keepText.add(index);
			let markdown = this.textBlocks.get(index);
			if (!markdown) {
				markdown = new Markdown(block.text.trim(), 1, 0, this.markdownTheme);
				this.textBlocks.set(index, markdown);
			} else {
				markdown.setText(block.text.trim());
			}
			this.contentContainer.addChild(markdown);
		}
		for (const index of this.thinkingLines.keys()) {
			if (!keepThinking.has(index)) this.thinkingLines.delete(index);
		}
		for (const index of this.textBlocks.keys()) {
			if (!keepText.has(index)) this.textBlocks.delete(index);
		}
		if (!hasText) this.pixLabel = undefined;
		if (errorLine && !hasToolCalls) {
			this.contentContainer.addChild(new Spacer(1));
			if (!this.errorText) this.errorText = new Text("", 1, 0);
			this.errorText.setText(theme.fg("error", errorLine));
			this.contentContainer.addChild(this.errorText);
		}
	}

	private resolveErrorLine(message: AssistantMessage): string | undefined {
		const local = this.localErrorMessage;
		if (message.stopReason === "aborted") {
			const messageText = local ?? message.errorMessage;
			return messageText && messageText !== "Request was aborted" ? messageText : "Operation aborted";
		}
		if (message.stopReason === "error") return `Error: ${local ?? message.errorMessage ?? "Unknown error"}`;
		if (local) return `Error: ${local}`;
		return undefined;
	}

	private classicErrorLine(message: AssistantMessage): string | undefined {
		if (message.stopReason === "aborted") {
			return message.errorMessage && message.errorMessage !== "Request was aborted"
				? message.errorMessage
				: "Operation aborted";
		}
		if (message.stopReason === "error") return `Error: ${message.errorMessage || "Unknown error"}`;
		return undefined;
	}

	private renderClassic(message: AssistantMessage): void {
		this.lastMessage = message;
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(new Markdown(content.text.trim(), 1, 0, this.markdownTheme));
			} else if (content.type === "thinking" && content.thinking.trim()) {
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// Show static thinking label when hidden
					this.contentContainer.addChild(
						new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), 1, 0),
					);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				} else {
					// Thinking traces in thinkingText color, italic
					this.contentContainer.addChild(
						new Markdown(content.thinking.trim(), 1, 0, this.markdownTheme, {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						}),
					);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		// Check if aborted - show after partial content
		// But only if there are no tool calls (tool execution components will show the error)
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				if (hasVisibleContent) {
					this.contentContainer.addChild(new Spacer(1));
				} else {
					this.contentContainer.addChild(new Spacer(1));
				}
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
			}
		}
	}
}
