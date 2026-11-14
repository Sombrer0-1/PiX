import assert from "node:assert";
import { describe, it } from "node:test";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import type { Component, Focusable } from "../src/tui.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class LineList implements Component {
	lines: string[] = [];
	inputs: string[] = [];
	lastWidth = 0;
	invalidations = 0;
	wantsKeyRelease = false;

	render(width: number): string[] {
		this.lastWidth = width;
		return this.lines;
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {
		this.invalidations++;
	}
}

class FocusableLines extends LineList implements Focusable {
	focused = false;
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

function openScreen(tui: TUI, component: Component): () => void {
	const close = tui.showScreen(component);
	if (close === undefined) {
		assert.fail("showScreen should return a close function");
	}
	return close;
}

function countOf(haystack: string, needle: string): number {
	let count = 0;
	let from = 0;
	while (from < haystack.length) {
		const index = haystack.indexOf(needle, from);
		if (index === -1) return count;
		count++;
		from = index + needle.length;
	}
	return count;
}

function normalBufferLines(terminal: VirtualTerminal): string[] {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.normal;
	const lines: string[] = [];
	for (let i = 0; i < buffer.length; i++) {
		const line = buffer.getLine(i);
		lines.push(line ? line.translateToString(true) : "");
	}
	return lines;
}

function includesLine(lines: string[], text: string): boolean {
	return lines.some((line) => line.includes(text));
}

describe("TUI showScreen", () => {
	it("keeps main history and restores content appended while the screen is open", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const main = new LineList();
		main.lines = ["main-a", "main-b"];
		const screen = new LineList();
		screen.lines = ["item-12"];
		tui.addChild(main);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.clearWrites();

			const close = openScreen(tui, screen);
			await terminal.waitForRender();

			const opened = terminal.getWrites();
			assert.ok(opened.includes("\x1b[?1049h"));
			assert.ok(!opened.includes("\x1b[3J"));
			assert.ok(includesLine(terminal.getViewport(), "item-12"));
			assert.ok(!includesLine(terminal.getViewport(), "main-a"));
			const normal = normalBufferLines(terminal).join("\n");
			assert.ok(normal.includes("main-a"));
			assert.ok(normal.includes("main-b"));
			assert.ok(!normal.includes("item-12"));

			main.lines = ["main-a", "main-b", "streamed"];
			tui.requestRender();
			await terminal.waitForRender();
			assert.ok(includesLine(terminal.getViewport(), "item-12"));
			assert.ok(!includesLine(terminal.getViewport(), "streamed"));
			assert.ok(!normalBufferLines(terminal).join("\n").includes("streamed"));
			assert.ok(!terminal.getWrites().includes("\x1b[3J"));

			terminal.clearWrites();
			close();
			await terminal.waitForRender();
			const restored = terminal.getWrites();
			assert.ok(restored.includes("\x1b[?1049l"));
			assert.ok(!restored.includes("\x1b[?1049h"));
			const viewport = terminal.getViewport();
			assert.ok(includesLine(viewport, "main-a"));
			assert.ok(includesLine(viewport, "main-b"));
			assert.ok(includesLine(viewport, "streamed"));
			assert.ok(!includesLine(viewport, "item-12"));
			assert.ok(!normalBufferLines(terminal).join("\n").includes("item-12"));

			terminal.clearWrites();
			close();
			await terminal.waitForRender();
			assert.strictEqual(countOf(terminal.getWrites(), "\x1b[?1049l"), 0);
			assert.ok(includesLine(terminal.getViewport(), "streamed"));
		} finally {
			tui.stop();
		}
	});

	it("redraws only changed screen lines and clips to the terminal height", async () => {
		const terminal = new LoggingVirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const main = new LineList();
		main.lines = ["main"];
		const screen = new LineList();
		screen.lines = ["keep", "old", "r2", "r3", "r4", "r5", "r6"];
		tui.addChild(main);
		tui.start();
		try {
			await terminal.waitForRender();
			openScreen(tui, screen);
			await terminal.waitForRender();

			const viewport = terminal.getViewport();
			assert.strictEqual(viewport.length, 5);
			assert.ok(viewport[0]?.includes("keep"));
			assert.ok(viewport[4]?.includes("r4"));
			assert.ok(!includesLine(viewport, "r5"));
			assert.ok(!includesLine(viewport, "r6"));
			assert.ok(!terminal.getWrites().includes("\x1b[3J"));
			assert.strictEqual(screen.lastWidth, 20);

			terminal.clearWrites();
			screen.lines = ["keep", "new", "r2", "r3", "r4", "r5"];
			tui.requestRender();
			await terminal.waitForRender();
			const writes = terminal.getWrites();
			assert.ok(writes.includes("new"));
			assert.ok(!writes.includes("keep"));
			assert.ok(!writes.includes("\x1b[3J"));
			assert.ok(terminal.getViewport()[0]?.includes("keep"));
			assert.ok(terminal.getViewport()[1]?.includes("new"));
		} finally {
			tui.stop();
		}
	});

	it("close only affects the screen it opened", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const main = new LineList();
		main.lines = ["main"];
		const first = new LineList();
		first.lines = ["first-screen"];
		const second = new LineList();
		second.lines = ["second-screen"];
		tui.addChild(main);
		tui.start();
		try {
			await terminal.waitForRender();
			const closeFirst = openScreen(tui, first);
			assert.strictEqual(tui.showScreen(second), undefined);
			await terminal.waitForRender();
			assert.strictEqual(countOf(terminal.getWrites(), "\x1b[?1049h"), 1);
			assert.ok(includesLine(terminal.getViewport(), "first-screen"));

			closeFirst();
			await terminal.waitForRender();
			closeFirst();
			const closeSecond = openScreen(tui, second);
			await terminal.waitForRender();
			assert.ok(includesLine(terminal.getViewport(), "second-screen"));

			terminal.clearWrites();
			closeFirst();
			await terminal.waitForRender();
			assert.strictEqual(countOf(terminal.getWrites(), "\x1b[?1049l"), 0);
			assert.ok(includesLine(terminal.getViewport(), "second-screen"));

			closeSecond();
			await terminal.waitForRender();
			assert.ok(includesLine(terminal.getViewport(), "main"));
			assert.ok(!includesLine(terminal.getViewport(), "second-screen"));
		} finally {
			tui.stop();
		}
	});

	it("uses the existing resize path after the screen closes", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const main = new LineList();
		main.lines = ["main-a"];
		const screen = new LineList();
		screen.lines = ["item-12"];
		tui.addChild(main);
		tui.start();
		try {
			await terminal.waitForRender();
			const close = openScreen(tui, screen);
			await terminal.waitForRender();
			const redraws = tui.fullRedraws;
			terminal.clearWrites();

			main.lines = ["main-a", "streamed"];
			terminal.resize(55, 12);
			await terminal.waitForRender();
			assert.strictEqual(tui.fullRedraws, redraws);
			assert.strictEqual(screen.lastWidth, 55);
			assert.ok(includesLine(terminal.getViewport(), "item-12"));
			assert.ok(!includesLine(terminal.getViewport(), "streamed"));
			assert.ok(!terminal.getWrites().includes("\x1b[3J"));

			close();
			await terminal.waitForRender();
			assert.ok(tui.fullRedraws > redraws);
			assert.ok(terminal.getWrites().includes("\x1b[3J"));
			const viewport = terminal.getViewport();
			assert.strictEqual(viewport.length, 12);
			assert.ok(includesLine(viewport, "main-a"));
			assert.ok(includesLine(viewport, "streamed"));
			assert.ok(!includesLine(viewport, "item-12"));
		} finally {
			tui.stop();
		}
	});

	it("setFocus closes the screen and a later close does not move focus", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const main = new LineList();
		main.lines = ["main-a"];
		const editor = new FocusableLines();
		editor.lines = ["editor"];
		const input = new FocusableLines();
		input.lines = ["input"];
		const screen = new LineList();
		screen.lines = ["item-12"];
		tui.addChild(main);
		tui.addChild(editor);
		tui.addChild(input);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			const close = openScreen(tui, screen);
			await terminal.waitForRender();
			assert.strictEqual(editor.focused, true);
			assert.ok(includesLine(terminal.getViewport(), "item-12"));

			main.lines = ["main-a", "streamed"];
			tui.setFocus(input);
			await terminal.waitForRender();
			assert.strictEqual(input.focused, true);
			assert.strictEqual(editor.focused, false);
			const viewport = terminal.getViewport();
			assert.ok(includesLine(viewport, "main-a"));
			assert.ok(includesLine(viewport, "streamed"));
			assert.ok(includesLine(viewport, "input"));
			assert.ok(!includesLine(viewport, "item-12"));

			terminal.clearWrites();
			close();
			await terminal.waitForRender();
			assert.strictEqual(input.focused, true);
			assert.strictEqual(editor.focused, false);
			assert.strictEqual(countOf(terminal.getWrites(), "\x1b[?1049l"), 0);
			assert.ok(includesLine(terminal.getViewport(), "input"));
			assert.ok(!includesLine(terminal.getViewport(), "item-12"));
		} finally {
			tui.stop();
		}
	});

	it("returns undefined when a visible capturing overlay exists", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const main = new LineList();
		main.lines = ["main"];
		const editor = new FocusableLines();
		const overlay = new FocusableLines();
		overlay.lines = ["overlay"];
		tui.addChild(main);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			tui.showOverlay(overlay);
			await terminal.waitForRender();
			terminal.clearWrites();

			assert.strictEqual(tui.showScreen(new LineList()), undefined);
			await terminal.waitForRender();
			assert.strictEqual(overlay.focused, true);
			assert.strictEqual(editor.focused, false);
			assert.ok(!terminal.getWrites().includes("\x1b[?1049h"));
			assert.ok(includesLine(terminal.getViewport(), "overlay"));
		} finally {
			tui.stop();
		}
	});

	it("keeps the screen when a non-capturing overlay is shown", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const main = new LineList();
		main.lines = ["main"];
		const editor = new FocusableLines();
		editor.lines = ["editor"];
		const overlay = new FocusableLines();
		overlay.lines = ["overlay"];
		const screen = new LineList();
		screen.lines = ["item-12"];
		tui.addChild(main);
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			const close = openScreen(tui, screen);
			await terminal.waitForRender();
			tui.showOverlay(overlay, { nonCapturing: true });
			await terminal.waitForRender();

			assert.strictEqual(editor.focused, true);
			assert.strictEqual(overlay.focused, false);
			assert.ok(includesLine(terminal.getViewport(), "item-12"));
			assert.ok(!includesLine(terminal.getViewport(), "overlay"));
			terminal.sendInput("k");
			assert.deepStrictEqual(screen.inputs, ["k"]);
			assert.deepStrictEqual(editor.inputs, []);
			assert.deepStrictEqual(overlay.inputs, []);

			close();
			await terminal.waitForRender();
			assert.ok(includesLine(terminal.getViewport(), "main"));
		} finally {
			tui.stop();
		}
	});

	it("closes the screen when a capturing overlay takes focus", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const main = new LineList();
		main.lines = ["main-a"];
		const editor = new FocusableLines();
		editor.lines = ["editor"];
		const overlay = new FocusableLines();
		overlay.lines = ["overlay"];
		const screen = new LineList();
		screen.lines = ["item-12"];
		tui.addChild(main);
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			const close = openScreen(tui, screen);
			await terminal.waitForRender();
			tui.showOverlay(overlay);
			await terminal.waitForRender();

			assert.strictEqual(overlay.focused, true);
			assert.strictEqual(editor.focused, false);
			const viewport = terminal.getViewport();
			assert.ok(includesLine(viewport, "overlay"));
			assert.ok(includesLine(viewport, "main-a"));
			assert.ok(!includesLine(viewport, "item-12"));

			close();
			await terminal.waitForRender();
			assert.strictEqual(overlay.focused, true);
			assert.ok(!includesLine(terminal.getViewport(), "item-12"));
		} finally {
			tui.stop();
		}
	});

	it("routes keys to the screen and then back to the focused component", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const editor = new FocusableLines();
		editor.lines = ["editor"];
		const screen = new LineList();
		screen.lines = ["item-12"];
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			const close = openScreen(tui, screen);
			await terminal.waitForRender();
			assert.strictEqual(editor.focused, true);

			let consumed = "";
			tui.addInputListener((data) => {
				if (data === "x") {
					consumed = data;
					return { consume: true };
				}
				return undefined;
			});
			terminal.sendInput("x");
			assert.strictEqual(consumed, "x");
			assert.deepStrictEqual(screen.inputs, []);
			assert.deepStrictEqual(editor.inputs, []);

			terminal.sendInput("\x1b[97;1:3u");
			assert.deepStrictEqual(screen.inputs, []);
			screen.wantsKeyRelease = true;
			terminal.sendInput("\x1b[97;1:3u");
			terminal.sendInput("a");
			assert.deepStrictEqual(screen.inputs, ["\x1b[97;1:3u", "a"]);
			assert.deepStrictEqual(editor.inputs, []);

			close();
			await terminal.waitForRender();
			terminal.sendInput("b");
			assert.deepStrictEqual(editor.inputs, ["b"]);
			assert.deepStrictEqual(screen.inputs, ["\x1b[97;1:3u", "a"]);
			assert.strictEqual(editor.focused, true);
		} finally {
			tui.stop();
		}
	});

	it("leaves the alternate screen before stop cleanup", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const main = new LineList();
		main.lines = ["main-a", "main-b"];
		const screen = new LineList();
		screen.lines = ["item-12"];
		tui.addChild(main);
		tui.start();
		await terminal.waitForRender();
		const close = openScreen(tui, screen);
		await terminal.waitForRender();
		terminal.clearWrites();

		tui.stop();
		await terminal.flush();
		const writes = terminal.getWrites();
		const leave = writes.indexOf("\x1b[?1049l");
		assert.ok(leave !== -1);
		assert.ok(writes.indexOf("\r\n", leave) > leave);
		assert.ok(includesLine(normalBufferLines(terminal), "main-a"));
		assert.ok(!includesLine(normalBufferLines(terminal), "item-12"));
		assert.strictEqual(tui.showScreen(screen), undefined);

		terminal.clearWrites();
		close();
		assert.strictEqual(countOf(terminal.getWrites(), "\x1b[?1049l"), 0);
	});

	it("defers requestRender(true) until the screen closes", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const main = new LineList();
		main.lines = ["kept"];
		const screen = new LineList();
		screen.lines = ["page"];
		tui.addChild(main);
		tui.start();
		try {
			await terminal.waitForRender();
			const close = openScreen(tui, screen);
			await terminal.waitForRender();
			const redraws = tui.fullRedraws;
			terminal.clearWrites();

			main.lines = ["kept", "streamed"];
			screen.lines = ["page-2"];
			tui.requestRender(true);
			await terminal.waitForRender();
			assert.strictEqual(tui.fullRedraws, redraws);
			assert.ok(!terminal.getWrites().includes("\x1b[3J"));
			assert.ok(!terminal.getWrites().includes("\x1b[2J"));
			assert.ok(includesLine(terminal.getViewport(), "page-2"));
			assert.ok(!includesLine(terminal.getViewport(), "streamed"));
			assert.ok(!normalBufferLines(terminal).join("\n").includes("streamed"));

			terminal.clearWrites();
			close();
			await terminal.waitForRender();
			assert.ok(tui.fullRedraws > redraws);
			assert.ok(terminal.getWrites().includes("\x1b[3J"));
			const viewport = terminal.getViewport();
			assert.ok(includesLine(viewport, "kept"));
			assert.ok(includesLine(viewport, "streamed"));
			assert.ok(!includesLine(viewport, "page-2"));
		} finally {
			tui.stop();
		}
	});

	it("forwards invalidate to the active screen only", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const main = new LineList();
		main.lines = ["main"];
		const screen = new LineList();
		screen.lines = ["item-12"];
		tui.addChild(main);
		tui.start();
		try {
			await terminal.waitForRender();
			const close = openScreen(tui, screen);
			await terminal.waitForRender();
			tui.invalidate();
			assert.strictEqual(screen.invalidations, 1);
			assert.strictEqual(main.invalidations, 1);

			close();
			await terminal.waitForRender();
			tui.invalidate();
			assert.strictEqual(screen.invalidations, 1);
			assert.strictEqual(main.invalidations, 2);
		} finally {
			tui.stop();
		}
	});
});
