import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Container, getKeybindings, setKeybindings, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { RequestUserInputHandler, RequestUserInputRequest } from "../src/core/request-user-input-tool.ts";
import { queueHostInput } from "../src/modes/host-input-queue.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { SessionHistory } from "../src/modes/interactive/components/session-history.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import type { HistoryItem } from "../src/modes/interactive/presentation.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const proto = InteractiveMode.prototype as unknown as {
	setupKeyHandlers(this: HistoryHost): void;
	setupEditorSubmitHandler(this: HistoryHost): void;
	setupExtensionShortcuts(this: HistoryHost, runner: { getShortcuts(): Map<string, { handler(): void }> }): void;
	openSessionHistory(this: HistoryHost): void;
	addMessageToChat(this: HistoryHost, message: AgentMessage): void;
	handleEvent(this: HistoryHost, event: AgentSessionEvent): Promise<void>;
	renderSessionContext(
		this: HistoryHost,
		context: { messages: AgentMessage[]; thinkingLevel: "off"; model: null },
	): void;
	collectHistoryItems(this: HistoryHost): HistoryItem[];
	presentHostInput(this: HistoryHost, request: RequestUserInputRequest): Promise<unknown>;
	resetPixSession(this: HistoryHost): void;
};

interface HistoryHost {
	presentationFactory: () => { acceptHostEvent(): undefined; describeTool(): undefined };
	presentation: { acceptHostEvent(): undefined; describeTool(): undefined };
	ui: TUI;
	defaultEditor: CustomEditor;
	editor: CustomEditor;
	editorContainer: Container;
	extensionSelector?: unknown;
	extensionInput?: unknown;
	extensionEditor?: unknown;
	chatContainer: Container;
	noticeContainer: Container;
	keybindings: KeybindingsManager;
	pendingTools: Map<string, { getHistoryItem(id: string): HistoryItem }>;
	hideThinkingBlock: boolean;
	toolOutputExpanded: boolean;
	isInitialized: boolean;
	isShuttingDown: boolean;
	showStatus: ReturnType<typeof vi.fn>;
	footer: { invalidate(): void };
	settingsManager: {
		getShowImages(): boolean;
		getImageWidthCells(): number;
		getCodeBlockIndent(): number;
		setHideThinkingBlock(value: boolean): void;
	};
	sessionManager: { getCwd(): string };
	session: { prompt: ReturnType<typeof vi.fn>; retryAttempt: number; abortCompaction(): void };
	getRegisteredToolDefinition(): undefined;
	pix?: { history?: SessionHistory; historyHint?: string };
}

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason,
		timestamp: Date.now(),
	};
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function plain(lines: readonly string[]): string {
	return stripAnsi(lines.join("\n"));
}

function selectedRow(lines: readonly string[]): number {
	return plain(lines)
		.split("\n")
		.findIndex((line) => line.includes(">"));
}

describe("session history keys", () => {
	beforeAll(() => initTheme("dark"));

	test("keeps ctrl+r on both history and session rename", () => {
		const plainKeys = new KeybindingsManager();
		expect(plainKeys.getKeys("app.history.open")).toEqual([]);
		expect(plainKeys.matches("\x12", "app.session.rename")).toBe(true);

		const historyKeys = new KeybindingsManager({}, undefined, { history: true });
		expect(historyKeys.getKeys("app.history.open")).toContain("ctrl+r");
		expect(historyKeys.matches("\x12", "app.history.open")).toBe(true);
		expect(historyKeys.matches("\x12", "app.session.rename")).toBe(true);

		const shared = new KeybindingsManager(
			{ "app.session.rename": "ctrl+r", "app.history.open": "ctrl+r" },
			undefined,
			{ history: true },
		);
		expect(shared.matches("\x12", "app.history.open")).toBe(true);
		expect(shared.matches("\x12", "app.session.rename")).toBe(true);
	});
});

describe("SessionHistory", () => {
	beforeAll(() => initTheme("dark"));

	test("pages the list and detail, keeps a live item, and follows resize", () => {
		const items: Array<{ id: string; kind: HistoryItem["kind"]; label: string; detail?: () => string }> = Array.from(
			{ length: 12 },
			(_, index) => ({
				id: `item-${index}`,
				kind: "user",
				label: `label-${index}`,
				detail: () => (index === 3 ? `LINE0-${"abcdefghijklmnopqrstuvwxyz"}\nLINE1-tail` : `body-${index}`),
			}),
		);
		const rows = 6;
		const history = new SessionHistory({
			getItems: () => items,
			getRows: () => rows,
			keybindings: new KeybindingsManager({}, undefined, { history: true }),
			onClose: () => {},
		});

		const first = history.render(24);
		expect(plain(first)).toContain("> label-11");
		expect(plain(first)).toContain("Enter details");
		expect(selectedRow(first)).toBe(4);

		history.handleInput("\x1b[H");
		history.handleInput("\x1b[B");
		history.handleInput("\x1b[B");
		const parked = history.render(24);
		const parkedRow = selectedRow(parked);
		expect(plain(parked)).toContain("> label-2");

		items.push({ id: "extra", kind: "assistant", label: "extra", detail: () => "extra-body" });
		const appended = history.render(24);
		expect(plain(appended)).toContain("> label-2");
		expect(plain(appended)).not.toContain("> extra");
		expect(selectedRow(appended)).toBe(parkedRow);

		history.handleInput("\x1b[F");
		expect(plain(history.render(24))).toContain("> extra");
		history.handleInput("\x1b[5~");
		expect(plain(history.render(24))).not.toContain("> extra");

		history.handleInput("\x1b[H");
		for (let step = 0; step < 3; step++) history.handleInput("\x1b[B");
		history.handleInput("\r");
		const detail = plain(history.render(10));
		expect(detail.split("\n")[0]).toContain("LINE0-");
		expect(detail).toContain("Esc back");
		history.handleInput("\x1b[B");
		history.handleInput("\x1b[B");
		expect(plain(history.render(10)).split("\n")[0]).not.toContain("abcdefghijklmnopqrstuvwxyz");

		const wide = plain(history.render(80));
		expect(wide.split("\n")[0]).toContain("LINE0-abcdefghijklmnopqrstuvwxyz");

		const long = Array.from({ length: 8 }, (_, index) => `row-${index}`).join("\n");
		const shrinking = items.find((item) => item.id === "item-3");
		if (shrinking) shrinking.detail = () => long;
		history.handleInput("\x1b[F");
		expect(plain(history.render(40))).toContain("row-7");
		shrinking!.detail = () => "row-0\nrow-1";
		const clamped = plain(history.render(16));
		expect(clamped).toContain("row-1");
		expect(clamped).not.toContain("row-7");

		items.splice(
			items.findIndex((item) => item.id === "item-3"),
			1,
		);
		const nearest = plain(history.render(24));
		expect(nearest).toContain("Esc close");
		expect(nearest).not.toContain("row-1");
		expect(nearest).toMatch(/> label-/);
	});

	test("one row still shows the selection and the exit hint", () => {
		const history = new SessionHistory({
			getItems: () => [{ id: "only", kind: "error", label: "Error: boom", detail: () => "boom details" }],
			getRows: () => 1,
			keybindings: new KeybindingsManager(),
			onClose: () => {},
		});
		const line = plain(history.render(18));
		expect(line).toContain("Error");
		expect(line).toContain("Esc");
	});

	test("renders terminal sequences in history as plain text content", () => {
		const modeChange = "\x1b[?1049l";
		const control = "\x07";
		const history = new SessionHistory({
			getItems: () => [
				{
					id: "tool",
					kind: "tool",
					label: `${modeChange}Tool`,
					detail: () => `one${control}\r\n\ttwo${modeChange}`,
				},
			],
			getRows: () => 5,
			keybindings: new KeybindingsManager(),
			onClose: () => {},
		});
		expect(history.render(40).join("\n")).not.toContain(modeChange);
		history.handleInput("\r");
		const details = history.render(40).slice(0, 2);
		expect(details).toEqual(["one", "   two"]);
	});
});

describe("InteractiveMode session history", () => {
	let previousKeybindings: ReturnType<typeof getKeybindings>;
	let keybindings: KeybindingsManager;
	let terminal: VirtualTerminal;
	let ui: TUI;
	let editor: CustomEditor;
	let host: HistoryHost;

	beforeAll(() => initTheme("dark"));

	beforeEach(() => {
		previousKeybindings = getKeybindings();
		keybindings = new KeybindingsManager({}, undefined, { history: true });
		setKeybindings(keybindings);
		terminal = new VirtualTerminal(80, 12);
		ui = new TUI(terminal);
		editor = new CustomEditor(ui, getEditorTheme(), keybindings);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const presentation = { acceptHostEvent: () => undefined, describeTool: () => undefined };
		host = {
			presentationFactory: () => presentation,
			presentation,
			ui,
			defaultEditor: editor,
			editor,
			editorContainer,
			chatContainer: new Container(),
			noticeContainer: new Container(),
			keybindings,
			pendingTools: new Map(),
			hideThinkingBlock: false,
			toolOutputExpanded: false,
			isInitialized: true,
			isShuttingDown: false,
			showStatus: vi.fn(),
			footer: { invalidate: vi.fn() },
			settingsManager: {
				getShowImages: () => false,
				getImageWidthCells: () => 60,
				getCodeBlockIndent: () => 2,
				setHideThinkingBlock: (value: boolean) => {
					host.hideThinkingBlock = value;
				},
			},
			sessionManager: { getCwd: () => process.cwd() },
			session: { prompt: vi.fn(), retryAttempt: 0, abortCompaction: vi.fn() },
			getRegisteredToolDefinition: () => undefined,
		};
		Object.setPrototypeOf(host, InteractiveMode.prototype);
		ui.addChild(editorContainer);
		ui.setFocus(editor);
		ui.start();
		proto.setupKeyHandlers.call(host);
	});

	afterEach(() => {
		ui.stop();
		setKeybindings(previousKeybindings);
	});

	test("updates one history item, then restores the draft and focus after cancel", async () => {
		const message = assistant([{ type: "text", text: "alpha" }]);
		await proto.handleEvent.call(host, { type: "message_start", message });
		const history = openBoundHistory();
		history.handleInput("\r");
		expect(plain(history.render(40))).toContain("alpha");

		message.content = [{ type: "text", text: "alpha beta" }];
		await proto.handleEvent.call(host, {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " beta", partial: message },
		});
		const updated = plain(history.render(40));
		expect(updated).toContain("alpha beta");
		expect(updated).toContain("Esc back");

		await proto.handleEvent.call(host, { type: "message_end", message });
		expect(plain(history.render(40))).toContain("alpha beta");
		expect(proto.collectHistoryItems.call(host).some((item) => item.id.endsWith(":text:0"))).toBe(true);
		history.handleInput("\x1b");

		editor.setText("draft");
		editor.handleInput("\x1b[D");
		editor.handleInput("\x12");
		await vi.waitFor(() => expect(terminal.getViewport().join("\n")).toContain("Esc close"));
		terminal.sendInput("\x03");
		await vi.waitFor(() => expect(terminal.getViewport().join("\n")).not.toContain("Esc close"));
		expect(editor.getText()).toBe("draft");
		expect(editor.focused).toBe(true);
		editor.handleInput("X");
		expect(editor.getText()).toBe("drafXt");

		const pending = proto.presentHostInput.call(host, {
			id: "approval",
			purpose: "tool_approval",
			questions: [{ id: "allow", header: "Approve", question: "Allow the tool?", options: [{ label: "Yes" }] }],
		});
		await vi.waitFor(() => expect(plain(host.noticeContainer.render(80))).toContain("Waiting for approval"));
		expect(host.pix?.history).toBeDefined();
		terminal.sendInput("\x1b");
		await pending;
		expect(editor.getText()).toBe("drafXt");
		expect(editor.focused).toBe(true);
		expect(plain(host.noticeContainer.render(80))).not.toContain("Waiting for approval");
	});

	test("a queued input request does not replace the current dialog", async () => {
		const queued = queueHostInput(((request) =>
			proto.presentHostInput.call(host, request)) as RequestUserInputHandler);
		const first = queued({
			id: "first",
			purpose: "tool_approval",
			questions: [{ id: "allow", header: "Approve", question: "Allow the tool?", options: [{ label: "Yes" }] }],
		});
		const second = queued({
			id: "second",
			questions: [{ id: "name", header: "Input", question: "What next?", options: [{ label: "Stay" }] }],
		});
		await vi.waitFor(() => expect(plain(host.noticeContainer.render(80))).toContain("Waiting for approval"));
		expect(plain(host.editorContainer.render(80))).toContain("Allow the tool?");
		expect(plain(host.editorContainer.render(80))).not.toContain("What next?");
		terminal.sendInput("\x1b");
		await first;
		await vi.waitFor(() => expect(plain(host.noticeContainer.render(80))).toContain("Waiting for input"));
		expect(plain(host.editorContainer.render(80))).toContain("What next?");
		terminal.sendInput("\x1b");
		await second;
		expect(editor.focused).toBe(true);
	});

	test("uses final tool identities and keeps assistant abort text local to the display", async () => {
		const partial = assistant([{ type: "toolCall", id: "provider-partial", name: "read", arguments: {} }]);
		await proto.handleEvent.call(host, { type: "message_start", message: partial });
		await proto.handleEvent.call(host, {
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{", partial },
		});
		expect(host.pendingTools.size).toBe(0);

		const message = assistant(
			[{ type: "toolCall", id: "provider-final", name: "read", arguments: { path: "final.ts" } }],
			"aborted",
		);
		message.errorMessage = "Provider cancelled the response";
		await proto.handleEvent.call(host, { type: "message_end", message });
		await proto.handleEvent.call(host, { type: "turn_end", message, toolResults: [] });

		const tools = proto.collectHistoryItems.call(host).filter((item) => item.kind === "tool");
		expect(tools).toHaveLength(1);
		expect(tools[0]?.id).toContain("provider-final");
		expect(tools[0]?.label).toContain("Cancelled");
		expect(message.errorMessage).toBe("Provider cancelled the response");
	});

	test("slash history clears the command and a blocked screen stays on the status line", () => {
		proto.setupEditorSubmitHandler.call(host);
		editor.setText("/pix:history");
		editor.handleInput("\r");
		expect(editor.getText()).toBe("");
		expect(host.pix?.history).toBeDefined();

		ui.stop();
		host.showStatus.mockClear();
		proto.openSessionHistory.call(host);
		expect(host.showStatus).toHaveBeenCalledWith("Session history is unavailable");
	});

	test("an extension key keeps the command hint and does not open history", () => {
		proto.setupExtensionShortcuts.call(host, {
			getShortcuts: () => new Map([["ctrl+r", { handler: () => {} }]]),
		});
		expect(plain(host.noticeContainer.render(40))).toContain("Use /pix:history");
		editor.setText("draft");
		editor.onExtensionShortcut = () => true;
		editor.handleInput("\x12");
		expect(host.pix?.history).toBeUndefined();
		expect(editor.getText()).toBe("draft");
	});

	test("approval focus ignores a history request and live tools stay separate from historical misses", async () => {
		host.extensionSelector = {};
		proto.openSessionHistory.call(host);
		expect(host.pix?.history).toBeUndefined();
		host.extensionSelector = undefined;

		const liveMessage = assistant([], "toolUse");
		await proto.handleEvent.call(host, { type: "message_start", message: liveMessage });
		liveMessage.content = [{ type: "toolCall", id: "live-1", name: "slow_tool", arguments: { q: 1 } }];
		await proto.handleEvent.call(host, {
			type: "tool_execution_start",
			toolCallId: "live-1",
			toolName: "slow_tool",
			args: { q: 1 },
		});
		const live = host.pendingTools.get("live-1");
		expect(live).toBeDefined();
		const before = host.chatContainer.children.length;
		proto.addMessageToChat.call(host, userMessage("hello history"));
		expect(host.session.prompt).not.toHaveBeenCalled();
		expect(host.chatContainer.children.length).toBeGreaterThan(before);

		const history = openBoundHistory();
		const promptCalls = host.session.prompt.mock.calls.length;
		const childCount = host.chatContainer.children.length;
		history.handleInput("\x1b[6~");
		history.handleInput("\r");
		history.render(40);
		expect(host.session.prompt.mock.calls.length).toBe(promptCalls);
		expect(host.chatContainer.children.length).toBe(childCount);

		const old = assistant([{ type: "toolCall", id: "old-1", name: "slow_tool", arguments: {} }], "stop");
		host.chatContainer.clear();
		proto.renderSessionContext.call(host, { messages: [old], thinkingLevel: "off", model: null });
		expect(host.pendingTools.has("old-1")).toBe(false);
		expect(host.pendingTools.get("live-1")).toBe(live);
		const away = proto.collectHistoryItems.call(host);
		expect(away.some((item) => item.id.includes("old-1"))).toBe(true);
		expect(away.some((item) => item.id.includes("live-1"))).toBe(false);

		host.chatContainer.clear();
		proto.renderSessionContext.call(host, { messages: [liveMessage], thinkingLevel: "off", model: null });
		expect(host.chatContainer.children.includes(live as never)).toBe(true);
		expect(host.pendingTools.get("live-1")).toBe(live);
		await proto.handleEvent.call(host, {
			type: "tool_execution_end",
			toolCallId: "live-1",
			toolName: "slow_tool",
			result: { content: [{ type: "text", text: "LIVE_DONE" }], details: undefined },
			isError: false,
		});
		expect(live?.getHistoryItem("live-1").detail?.()).toContain("LIVE_DONE");

		const kept = host.pix?.history;
		expect(kept).toBeDefined();
		proto.resetPixSession.call(host);
		expect(host.pix?.history).toBeUndefined();
		expect(host.pix?.history).not.toBe(kept);
	});

	function openBoundHistory(): SessionHistory {
		proto.openSessionHistory.call(host);
		const history = host.pix?.history;
		if (!history) throw new Error("history did not open");
		return history;
	}
});
