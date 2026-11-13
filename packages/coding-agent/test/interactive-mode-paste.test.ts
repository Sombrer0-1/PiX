import {
	type Component,
	Container,
	Editor,
	type EditorComponent,
	getKeybindings,
	setKeybindings,
	TUI,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { EditorFactory } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";
import { readClipboardText } from "../src/utils/clipboard.ts";
import { readClipboardImage } from "../src/utils/clipboard-image.ts";
import { isWSL } from "../src/utils/wsl.ts";

vi.mock("../src/utils/clipboard.ts", () => ({ readClipboardText: vi.fn() }));
vi.mock("../src/utils/clipboard-image.ts", () => ({ readClipboardImage: vi.fn() }));

function pasteDraft(editor: EditorComponent): string {
	const draft = Array.from({ length: 12 }, (_, i) => `draft line ${i + 1}`).join("\n");
	editor.handleInput(`\x1b[200~${draft}\x1b[201~`);
	expect(editor.getText()).toMatch(/^\[paste #/);
	return draft;
}

function submitDraft(editor: EditorComponent): string | undefined {
	let submitted: string | undefined;
	editor.onSubmit = (text) => {
		submitted = text;
	};
	editor.handleInput("\r");
	return submitted;
}

type CustomUIFactory = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	close: (result: string) => void,
) => Component;

describe("InteractiveMode clipboard paste", () => {
	let keybindings: KeybindingsManager;
	let previousKeybindings: ReturnType<typeof getKeybindings>;
	let ui: TUI;

	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		previousKeybindings = getKeybindings();
		keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		ui = new TUI(new VirtualTerminal());
	});
	afterEach(() => setKeybindings(previousKeybindings));

	test("pastes plain text at the cursor when the clipboard has no image", async () => {
		vi.mocked(readClipboardImage).mockResolvedValue(null);
		vi.mocked(readClipboardText).mockResolvedValue("first\r\nsecond");
		const editor = new CustomEditor(ui, getEditorTheme(), keybindings);
		const host = { ui, defaultEditor: editor, editor, isBashMode: false };
		const mode = InteractiveMode.prototype as unknown as {
			setupKeyHandlers(this: typeof host): void;
			handleClipboardPaste(this: typeof host): Promise<void>;
		};
		Object.assign(host, { handleClipboardPaste: mode.handleClipboardPaste });
		mode.setupKeyHandlers.call(host);

		for (const key of process.platform === "win32" || (process.platform === "linux" && isWSL())
			? ["\x16", "\x1bv"]
			: ["\x16"]) {
			editor.setText("before after");
			editor.handleInput("\x1b[H");
			editor.handleInput(key);
			await vi.waitFor(() => expect(editor.getText()).toBe("first\nsecondbefore after"));
		}
	});

	test("preserves pasted drafts when switching between editors", () => {
		const defaultEditor = new CustomEditor(ui, getEditorTheme(), keybindings);
		const host = {
			ui,
			keybindings,
			defaultEditor,
			editor: defaultEditor as EditorComponent,
			editorContainer: new Container(),
		};
		const mode = InteractiveMode.prototype as unknown as {
			setCustomEditorComponent(this: typeof host, factory: EditorFactory | undefined): void;
		};

		const draft = pasteDraft(host.editor);
		mode.setCustomEditorComponent.call(host, (tui, theme) => new Editor(tui, theme));
		expect(submitDraft(host.editor)).toBe(draft);

		const nextDraft = pasteDraft(host.editor);
		mode.setCustomEditorComponent.call(host, undefined);
		expect(submitDraft(host.editor)).toBe(nextDraft);
	});

	test("preserves a pasted draft when closing custom UI", async () => {
		const editor = new Editor(ui, getEditorTheme());
		const host = { ui, keybindings, editor, editorContainer: new Container() };
		const mode = InteractiveMode.prototype as unknown as {
			showExtensionCustom(this: typeof host, factory: CustomUIFactory): Promise<string>;
		};
		const draft = pasteDraft(editor);
		const component: Component = { render: () => [], invalidate() {} };
		let close: ((result: string) => void) | undefined;
		const opened = mode.showExtensionCustom.call(host, (_tui, _theme, _keys, done) => {
			close = done;
			return component;
		});
		await vi.waitFor(() => expect(host.editorContainer.children[0]).toBe(component));
		if (!close) throw new Error("Custom UI did not open");
		close("closed");
		await opened;

		expect(submitDraft(editor)).toBe(draft);
	});

	test("preserves a pasted draft when restoring queued messages", () => {
		const editor = new Editor(ui, getEditorTheme());
		const host = {
			editor,
			clearAllQueues: () => ({ steering: [], followUp: ["queued message"] }),
			updatePendingMessagesDisplay() {},
		};
		const mode = InteractiveMode.prototype as unknown as {
			restoreQueuedMessagesToEditor(this: typeof host): number;
		};

		const draft = pasteDraft(editor);
		mode.restoreQueuedMessagesToEditor.call(host);
		expect(submitDraft(editor)).toBe(`queued message\n\n${draft}`);
	});
});
