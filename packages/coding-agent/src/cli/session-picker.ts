/**
 * TUI session selector for --resume flag
 */

import { ProcessTerminal, setKeybindings, TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SessionFileHost } from "../core/session-file-host.ts";
import type { SessionInfo, SessionListProgress } from "../core/session-manager.ts";
import { SessionSelectorComponent } from "../modes/interactive/components/session-selector.ts";

type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

/** Show TUI session selector and return selected session path or null if cancelled */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
	files?: SessionFileHost,
	signal?: AbortSignal,
): Promise<string | null> {
	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal());
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		let resolved = false;
		const finish = (path: string | null) => {
			if (resolved) return;
			resolved = true;
			signal?.removeEventListener("abort", cancel);
			ui.stop();
			resolve(path);
		};
		const cancel = () => finish(null);

		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			finish,
			cancel,
			cancel,
			() => ui.requestRender(),
			{ showRenameHint: false, keybindings, deleteSession: files && ((path) => files.delete({ path })) },
		);

		ui.addChild(selector);
		ui.setFocus(selector.getSessionList());
		ui.start();
		if (signal?.aborted) cancel();
		else signal?.addEventListener("abort", cancel, { once: true });
	});
}
