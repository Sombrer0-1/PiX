import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import type {
	HistoryItem,
	InteractivePresentation,
	InteractiveToolDescription,
	InteractiveToolSnapshot,
	ToolDisplayStatus,
	ToolPhase,
} from "../presentation.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { buildToolHistoryBody, readSavedEditDiff, summarizeTool } from "./tool-summary.ts";

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	describe?: InteractivePresentation["describeTool"];
}

const STATUS_LABEL: Record<ToolDisplayStatus, string> = {
	queued: "Queued",
	running: "Processing",
	succeeded: "Done",
	failed: "Failed",
	cancelled: "Cancelled",
	"no-result": "No result",
	"waiting-input": "Waiting",
	background: "Background",
	interrupted: "Interrupted",
};

function statusColor(status: ToolDisplayStatus): ThemeColor {
	switch (status) {
		case "succeeded":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
		case "interrupted":
		case "no-result":
		case "waiting-input":
		case "background":
			return "warning";
		case "queued":
			return "muted";
		default:
			return "accent";
	}
}

function oneLine(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const line = value.split("\n").find((part) => part.trim());
	return line?.trim() || undefined;
}

interface CompactSegment {
	text: string;
	paint?: (text: string) => string;
}

function paintSegments(segments: CompactSegment[], maxWidth: number): string {
	let used = 0;
	let out = "";
	for (const segment of segments) {
		if (!segment.text) continue;
		const room = maxWidth - used;
		if (room <= 0) break;
		const width = visibleWidth(segment.text);
		const text = width <= room ? segment.text : truncateToWidth(segment.text, room, "…");
		out += segment.paint ? segment.paint(text) : text;
		used += visibleWidth(text);
		if (width > room) break;
	}
	return out;
}

interface CompactToolModel {
	status: ToolDisplayStatus;
	statusLabel: string;
	name: string;
	subject?: string;
	progress?: string;
	reason?: string;
	ellipsis: boolean;
	plainLabel: string;
}

class CompactToolLines implements Component {
	private model: CompactToolModel = {
		status: "queued",
		statusLabel: "Queued",
		name: "",
		ellipsis: false,
		plainLabel: "",
	};

	setModel(model: CompactToolModel): void {
		this.model = model;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const pad = Math.min(2, Math.max(0, width));
		const inner = Math.max(0, width - pad);
		const model = this.model;
		const statusLabel = model.statusLabel;
		const statusColumn = Math.max(10, visibleWidth(statusLabel));
		const statusPad = " ".repeat(Math.max(0, statusColumn - visibleWidth(statusLabel)));
		const ellipsis = model.ellipsis ? "  …" : "";
		const ellipsisWidth = visibleWidth(ellipsis);
		const segments: CompactSegment[] = [
			{ text: statusLabel, paint: (text) => theme.fg(statusColor(model.status), text) },
			{ text: statusPad },
			{ text: "  " },
			{ text: model.name, paint: (text) => theme.bold(theme.fg("toolTitle", text)) },
		];
		if (model.subject) {
			segments.push({ text: "  " }, { text: model.subject, paint: (text) => theme.fg("accent", text) });
		}
		if (model.progress) {
			segments.push({ text: "  " }, { text: model.progress, paint: (text) => theme.fg("muted", text) });
		}
		const mainWidth = model.ellipsis ? Math.max(0, inner - ellipsisWidth) : inner;
		let line = paintSegments(segments, mainWidth);
		if (model.ellipsis && visibleWidth(line) + ellipsisWidth <= inner) {
			line += theme.fg("muted", ellipsis);
		}
		const lines = [this.clipLine(pad, line, width)];
		const reason = model.reason?.trim();
		if (reason) {
			const indent = Math.min(statusColumn + 2, Math.max(0, inner - 1));
			const contentWidth = Math.max(1, inner - indent);
			const wrapped = wrapTextWithAnsi(reason, contentWidth);
			const visible = wrapped.slice(0, 3);
			if (wrapped.length > 3 && visible.length > 0) {
				const last = visible.length - 1;
				visible[last] = truncateToWidth(visible[last] ?? "", contentWidth, "…");
			}
			for (const wrappedLine of visible) {
				if (!wrappedLine.trim()) continue;
				lines.push(this.clipLine(pad, " ".repeat(indent) + theme.fg("error", wrappedLine), width));
			}
		}
		return lines;
	}

	private clipLine(pad: number, line: string, width: number): string {
		const combined = " ".repeat(pad) + line;
		const gap = width - visibleWidth(combined);
		return gap > 0 ? combined + " ".repeat(gap) : combined;
	}
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<number, { data: string; mimeType: string; sourceData: string }> = new Map();
	private imageConversions = new Set<string>();
	private hideComponent = false;
	private readonly describeFn?: InteractivePresentation["describeTool"];
	private readonly compactView = new CompactToolLines();
	private readonly describedSpacer = new Spacer(1);
	private readonly hiddenDetail = new Container();
	private detailActivated = false;
	private settledWithoutResult = false;
	private finishPhase?: "failed" | "cancelled" | "no-result";
	private finishDiagnostic?: string;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.describeFn = options.describe;
		this.ui = ui;
		this.cwd = cwd;

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.selfRenderContainer = new Container();

		if (this.describeFn) {
			this.addChild(this.compactView);
		} else {
			this.addChild(new Spacer(1));
			if (this.hasRendererDefinition()) {
				this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
			} else {
				this.addChild(this.contentText);
			}
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private visibleShell(): Component {
		if (!this.hasRendererDefinition()) return this.contentText;
		return this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
	}

	private clearVisibleShell(): void {
		if (!this.hasRendererDefinition()) {
			this.contentText.setText("");
			return;
		}
		const shell = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
		shell.clear();
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete && !(this.describeFn && this.hasSavedEditDiff()),
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private hasSavedEditDiff(): boolean {
		return (
			this.toolName === "edit" &&
			!this.isPartial &&
			!!this.result &&
			!this.result.isError &&
			readSavedEditDiff(this.result.details) !== undefined
		);
	}

	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
		return new Text(theme.fg("toolOutput", output), 0, 0);
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		if (this.settledWithoutResult && isPartial) return;
		if (!isPartial) {
			this.settledWithoutResult = false;
			this.finishPhase = undefined;
			this.finishDiagnostic = undefined;
		}
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	finishWithoutResult(phase: "failed" | "cancelled" | "no-result", diagnostic?: string): void {
		if (this.result && !this.isPartial && !this.settledWithoutResult) return;
		this.finishPhase = phase;
		this.finishDiagnostic = diagnostic;
		this.settledWithoutResult = true;
		this.isPartial = false;
		this.updateDisplay();
	}

	refreshPresentation(): void {
		this.updateDisplay();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (const [index, converted] of this.convertedImages) {
			const current = imageBlocks[index];
			if (!current || current.data !== converted.sourceData) this.convertedImages.delete(index);
		}
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img?.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			const cached = this.convertedImages.get(i);
			if (cached?.sourceData === img.data) continue;
			const key = `${i}:${img.data}`;
			if (this.imageConversions.has(key)) continue;

			const sourceData = img.data;
			const sourceMime = img.mimeType;
			this.imageConversions.add(key);
			convertToPng(sourceData, sourceMime).then((converted) => {
				this.imageConversions.delete(key);
				const current = this.result?.content.filter((block) => block.type === "image")[i];
				if (!current || current.data !== sourceData || current.mimeType !== sourceMime) return;
				if (converted) {
					this.convertedImages.set(i, { data: converted.data, mimeType: converted.mimeType, sourceData });
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		if (expanded) this.detailActivated = true;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}
		return super.render(width);
	}

	getHistoryItem(id: string): HistoryItem {
		const model = this.buildCompactModel();
		const snapshot = this.snapshot();
		const hasDetail = model.ellipsis || model.reason || model.extraDetail;
		return {
			id,
			kind: "tool",
			label: model.plainLabel,
			detail: hasDetail
				? () => buildToolHistoryBody(snapshot, model.extraDetail?.()) ?? model.reason ?? ""
				: undefined,
		};
	}

	private updateDisplay(): void {
		if (this.describeFn) {
			this.updateDescribedDisplay();
			return;
		}
		this.updateStandardDisplay();
	}

	private updateDescribedDisplay(): void {
		if (this.expanded) this.detailActivated = true;
		this.removeChild(this.compactView);
		this.removeChild(this.describedSpacer);
		if (this.expanded) {
			this.hiddenDetail.clear();
			this.attachVisibleShell();
			this.updateStandardDisplay();
			return;
		}
		this.detachVisibleShell();
		this.clearVisibleShell();
		this.clearMountedImages();
		if (this.detailActivated) this.syncHiddenRenderers();
		this.compactView.setModel(this.buildCompactModel());
		this.addChild(this.compactView);
		this.hideComponent = false;
	}

	private attachVisibleShell(): void {
		if (!this.children.includes(this.describedSpacer)) this.addChild(this.describedSpacer);
		const shell = this.visibleShell();
		if (!this.children.includes(shell)) this.addChild(shell);
	}

	private detachVisibleShell(): void {
		this.removeChild(this.contentBox);
		this.removeChild(this.contentText);
		this.removeChild(this.selfRenderContainer);
	}

	private syncHiddenRenderers(): void {
		if (!this.hasRendererDefinition()) return;
		this.renderInto(this.hiddenDetail);
	}

	private updateStandardDisplay(): void {
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
			}
			hasContent = this.renderInto(renderContainer);
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		this.mountImages();

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private renderInto(target: { clear(): void; addChild(component: Component): void }): boolean {
		target.clear();
		let hasContent = false;
		const callRenderer = this.getCallRenderer();
		if (!callRenderer) {
			target.addChild(this.createCallFallback());
			hasContent = true;
		} else {
			try {
				const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
				this.callRendererComponent = component;
				target.addChild(component);
				hasContent = true;
			} catch {
				this.callRendererComponent = undefined;
				target.addChild(this.createCallFallback());
				hasContent = true;
			}
		}

		if (this.result) {
			const resultRenderer = this.getResultRenderer();
			if (!resultRenderer) {
				const component = this.createResultFallback();
				if (component) {
					target.addChild(component);
					hasContent = true;
				}
			} else {
				try {
					const component = resultRenderer(
						{ content: this.result.content as any, details: this.result.details },
						{ expanded: this.expanded, isPartial: this.isPartial },
						theme,
						this.getRenderContext(this.resultRendererComponent),
					);
					this.resultRendererComponent = component;
					target.addChild(component);
					hasContent = true;
				} catch {
					this.resultRendererComponent = undefined;
					const component = this.createResultFallback();
					if (component) {
						target.addChild(component);
						hasContent = true;
					}
				}
			}
		}
		return hasContent;
	}

	private clearMountedImages(): void {
		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];
	}

	private mountImages(): void {
		this.clearMountedImages();
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		const caps = getCapabilities();
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img || !caps.images || !this.showImages || !img.data || !img.mimeType) continue;
			const converted = this.convertedImages.get(i);
			const imageData = converted && converted.sourceData === img.data ? converted.data : img.data;
			const imageMimeType = converted && converted.sourceData === img.data ? converted.mimeType : img.mimeType;
			if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

			const spacer = new Spacer(1);
			this.addChild(spacer);
			this.imageSpacers.push(spacer);
			const imageComponent = new Image(
				imageData,
				imageMimeType,
				{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
				{ maxWidthCells: this.imageWidthCells },
			);
			this.imageComponents.push(imageComponent);
			this.addChild(imageComponent);
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}

	private currentPhase(): ToolPhase {
		if (this.settledWithoutResult && this.finishPhase) return this.finishPhase;
		if (this.result && !this.isPartial) return this.result.isError ? "failed" : "succeeded";
		if (this.executionStarted || (this.result !== undefined && this.isPartial)) return "running";
		return "queued";
	}

	private snapshot(): InteractiveToolSnapshot {
		const result = this.result;
		return {
			toolCallId: this.toolCallId,
			toolName: this.toolName,
			args: this.args,
			phase: this.currentPhase(),
			result: result ? { content: result.content, details: result.details, isError: result.isError } : undefined,
		};
	}

	private buildCompactModel(): CompactToolModel & { extraDetail?: InteractiveToolDescription["details"] } {
		const snapshot = this.snapshot();
		const described: InteractiveToolDescription | undefined = this.describeFn?.(snapshot);
		const summary = summarizeTool(snapshot);
		const status = described?.status ?? summary.status ?? snapshot.phase;
		const subject = oneLine(described?.subject || summary.subject);
		const progress = oneLine(described?.progress || summary.progress);
		const toolError = snapshot.result?.isError ? getRenderedTextOutput(snapshot.result, false).trim() : "";
		const diagnostic =
			described?.diagnostic || (this.settledWithoutResult ? this.finishDiagnostic : undefined) || summary.diagnostic;
		const reason = toolError || diagnostic?.trim() || "";
		const statusLabel = STATUS_LABEL[status];
		const plainLabel = [statusLabel, this.toolName, subject, progress, oneLine(reason)]
			.filter((part): part is string => Boolean(part))
			.join("  ");
		const args = this.args;
		const hasArgs = !!args && typeof args === "object" && Object.keys(args as Record<string, unknown>).length > 0;
		const hasResult =
			!!snapshot.result &&
			(getRenderedTextOutput(snapshot.result, false).trim().length > 0 ||
				snapshot.result.content.some((block) => block.type === "image"));
		return {
			status,
			statusLabel,
			name: this.toolName,
			subject,
			progress,
			reason: reason || undefined,
			ellipsis: hasArgs || hasResult,
			plainLabel,
			extraDetail: described?.details,
		};
	}
}
