import { type Component, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import type { HistoryItem } from "../presentation.ts";
import { theme } from "../theme/theme.ts";

interface VisualLine {
	logical: number;
	fragment: number;
	text: string;
}

/**
 * Alternate-screen reader for the current session.
 * Selection and body position stay on this instance across renders.
 */
export class SessionHistory implements Component {
	private readonly getItems: () => readonly HistoryItem[];
	private readonly getRows: () => number;
	private readonly keybindings: KeybindingsManager;
	private readonly onClose: () => void;

	private items: readonly HistoryItem[] = [];
	private primed = false;
	private selectedId: string | undefined;
	private selectedIndex = 0;
	private selectedOffset = 0;
	private snapEnd = false;
	private detailOpen = false;
	private windowStart = 0;
	private lastWidth = 80;
	private anchorItemId: string | undefined;
	private anchorLogical = 0;
	private anchorFragment = 0;

	constructor(options: {
		getItems: () => readonly HistoryItem[];
		getRows: () => number;
		keybindings: KeybindingsManager;
		onClose: () => void;
	}) {
		this.getItems = options.getItems;
		this.getRows = options.getRows;
		this.keybindings = options.keybindings;
		this.onClose = options.onClose;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		this.reconcile(this.getItems());
		if (this.keybindings.matches(data, "app.history.open") || matchesKey(data, "ctrl+c")) {
			this.onClose();
			return;
		}
		const cancel = this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "escape");
		if (cancel) {
			if (this.detailOpen && !matchesKey(data, "ctrl+c")) {
				this.detailOpen = false;
				return;
			}
			this.onClose();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			if (this.detailOpen) {
				this.detailOpen = false;
				return;
			}
			const item = this.items[this.selectedIndex];
			if (item?.detail) {
				this.detailOpen = true;
				if (this.anchorItemId !== item.id) {
					this.anchorItemId = item.id;
					this.anchorLogical = 0;
					this.anchorFragment = 0;
				}
			}
			return;
		}

		const pageSize = this.pageSize();
		if (this.detailOpen) {
			const item = this.items[this.selectedIndex];
			const text = item?.detail?.() ?? "";
			if (this.keybindings.matches(data, "tui.select.up")) this.shiftDetail(text, -1);
			else if (this.keybindings.matches(data, "tui.select.down")) this.shiftDetail(text, 1);
			else if (this.keybindings.matches(data, "tui.select.pageUp")) this.shiftDetail(text, -pageSize);
			else if (this.keybindings.matches(data, "tui.select.pageDown")) this.shiftDetail(text, pageSize);
			else if (matchesKey(data, "home")) this.shiftDetail(text, Number.NEGATIVE_INFINITY);
			else if (matchesKey(data, "end")) this.shiftDetail(text, Number.POSITIVE_INFINITY);
			return;
		}

		if (this.items.length === 0) return;
		if (this.keybindings.matches(data, "tui.select.up")) this.moveList(this.selectedIndex - 1, pageSize);
		else if (this.keybindings.matches(data, "tui.select.down")) this.moveList(this.selectedIndex + 1, pageSize);
		else if (this.keybindings.matches(data, "tui.select.pageUp"))
			this.moveList(this.selectedIndex - pageSize, pageSize);
		else if (this.keybindings.matches(data, "tui.select.pageDown"))
			this.moveList(this.selectedIndex + pageSize, pageSize);
		else if (matchesKey(data, "home")) this.moveList(0, pageSize);
		else if (matchesKey(data, "end")) this.moveList(this.items.length - 1, pageSize);
	}

	render(width: number): string[] {
		const rows = Math.max(1, this.getRows());
		const inner = Math.max(1, width);
		this.lastWidth = inner;
		this.reconcile(this.getItems());
		const hint = this.detailOpen
			? "Esc back · PgUp/PgDn"
			: this.items[this.selectedIndex]?.detail
				? "Esc close  Enter details"
				: "Esc close";
		if (rows === 1) {
			return [clipLine(this.primaryLine(inner, hint), inner)];
		}
		const bodyRows = rows - 1;
		const body =
			this.items.length === 0
				? [clipLine("No session history", inner)]
				: this.detailOpen
					? this.renderDetail(inner, bodyRows)
					: this.renderList(inner, bodyRows);
		const lines = body.slice(0, bodyRows);
		while (lines.length < bodyRows) lines.push("");
		lines.push(paint(hint, inner, "dim"));
		return lines.slice(0, rows);
	}

	private pageSize(): number {
		const rows = Math.max(1, this.getRows());
		return rows >= 2 ? rows - 1 : 1;
	}

	private reconcile(items: readonly HistoryItem[]): void {
		this.items = items;
		if (items.length === 0) {
			this.selectedId = undefined;
			this.selectedIndex = 0;
			this.detailOpen = false;
			return;
		}
		if (!this.primed) {
			this.primed = true;
			this.selectedIndex = items.length - 1;
			this.selectedId = items[this.selectedIndex]?.id;
			this.snapEnd = true;
			this.detailOpen = false;
			return;
		}
		if (!this.selectedId || !items.some((item) => item.id === this.selectedId)) {
			const index = Math.min(Math.max(this.selectedIndex, 0), items.length - 1);
			this.selectedIndex = index;
			this.selectedId = items[index]?.id;
			this.detailOpen = false;
			return;
		}
		this.selectedIndex = items.findIndex((item) => item.id === this.selectedId);
	}

	private moveList(next: number, pageSize: number): void {
		if (this.items.length === 0) return;
		const index = Math.max(0, Math.min(this.items.length - 1, next));
		this.selectedIndex = index;
		this.selectedId = this.items[index]?.id;
		this.reveal(pageSize);
	}

	private reveal(pageSize: number): void {
		const count = this.items.length;
		if (count === 0) return;
		const page = Math.max(1, pageSize);
		if (this.snapEnd) {
			this.selectedOffset = Math.min(this.selectedIndex, page - 1);
			this.snapEnd = false;
		}
		let start = this.selectedIndex - this.selectedOffset;
		if (this.selectedIndex < start) start = this.selectedIndex;
		if (this.selectedIndex >= start + page) start = this.selectedIndex - page + 1;
		const maxStart = Math.max(0, count - page);
		if (start > maxStart) start = maxStart;
		if (start < 0) start = 0;
		this.windowStart = start;
		this.selectedOffset = this.selectedIndex - start;
	}

	private renderList(width: number, bodyRows: number): string[] {
		this.reveal(bodyRows);
		const lines: string[] = [];
		const page = Math.max(1, bodyRows);
		for (let row = 0; row < page && this.windowStart + row < this.items.length; row++) {
			const item = this.items[this.windowStart + row];
			if (!item) break;
			const selected = item.id === this.selectedId;
			const prefix = selected ? "> " : "  ";
			lines.push(
				paint(`${prefix}${historyText(item.label).replaceAll("\n", " ")}`, width, selected ? "accent" : undefined),
			);
		}
		if (lines.length === 0) lines.push(clipLine("No session history", width));
		return lines;
	}

	private renderDetail(width: number, bodyRows: number): string[] {
		const item = this.items[this.selectedIndex];
		const text = item?.detail?.() ?? "";
		const visual = visualLines(text, width);
		const start = this.clampAnchor(visual);
		const lines: string[] = [];
		const page = Math.max(1, bodyRows);
		for (let row = 0; row < page && start + row < visual.length; row++) {
			lines.push(clipLine(visual[start + row]?.text ?? "", width));
		}
		if (lines.length === 0) lines.push("");
		return lines;
	}

	private primaryLine(width: number, hint: string): string {
		if (this.items.length === 0) return clipLine(`No session history  ${hint}`, width);
		const item = this.items[this.selectedIndex];
		const label = historyText(item?.label ?? "").replaceAll("\n", " ");
		return clipLine(`${label}  ${hint}`, width);
	}

	private shiftDetail(text: string, delta: number): void {
		const visual = visualLines(text, this.lastWidth);
		if (visual.length === 0) {
			this.anchorLogical = 0;
			this.anchorFragment = 0;
			return;
		}
		const current = this.clampAnchor(visual);
		let next = current;
		if (delta === Number.NEGATIVE_INFINITY) next = 0;
		else if (delta === Number.POSITIVE_INFINITY) next = visual.length - 1;
		else next = Math.max(0, Math.min(visual.length - 1, current + delta));
		const line = visual[next];
		if (!line) return;
		this.anchorItemId = this.selectedId;
		this.anchorLogical = line.logical;
		this.anchorFragment = line.fragment;
	}

	private clampAnchor(visual: readonly VisualLine[]): number {
		if (visual.length === 0) {
			this.anchorLogical = 0;
			this.anchorFragment = 0;
			return 0;
		}
		if (this.anchorItemId !== this.selectedId) {
			this.anchorItemId = this.selectedId;
			this.anchorLogical = 0;
			this.anchorFragment = 0;
		}
		const maxLogical = visual[visual.length - 1]?.logical ?? 0;
		if (this.anchorLogical > maxLogical) this.anchorLogical = maxLogical;
		if (this.anchorLogical < 0) this.anchorLogical = 0;
		const same = visual.filter((line) => line.logical === this.anchorLogical);
		const maxFragment = Math.max(0, same.length - 1);
		if (this.anchorFragment > maxFragment) this.anchorFragment = maxFragment;
		if (this.anchorFragment < 0) this.anchorFragment = 0;
		const index = visual.findIndex(
			(line) => line.logical === this.anchorLogical && line.fragment === this.anchorFragment,
		);
		return index === -1 ? 0 : index;
	}
}

function visualLines(text: string, width: number): VisualLine[] {
	const inner = Math.max(1, width);
	const lines = historyText(text).split("\n");
	const visual: VisualLine[] = [];
	for (let logical = 0; logical < lines.length; logical++) {
		const wrapped = wrapTextWithAnsi(lines[logical] ?? "", inner);
		const pieces = wrapped.length > 0 ? wrapped : [""];
		for (let fragment = 0; fragment < pieces.length; fragment++) {
			visual.push({ logical, fragment, text: pieces[fragment] ?? "" });
		}
	}
	return visual;
}

function historyText(text: string): string {
	return stripAnsi(text)
		.replace(/\r\n?/g, "\n")
		.replaceAll("\t", "   ")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

function clipLine(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width), "");
}

function paint(text: string, width: number, color: "accent" | "dim" | undefined): string {
	const fitted = clipLine(text, width);
	if (color === "accent") return theme.fg("accent", fitted);
	if (color === "dim") return theme.fg("dim", fitted);
	return fitted;
}
