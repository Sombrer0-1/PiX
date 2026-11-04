/**
 * Computer-use IPC adapters (PiX 1.5.0).
 *
 * Pure registration/dispatch for the computer-use-command IPC surface, cloned
 * from ipc-todo-adapters.ts so computer-use-ipc.test.ts can register and
 * exercise the REAL production handlers in pure Node without loading the
 * Electron runtime (ipc-handlers.ts imports electron at the top level).
 * Production registerIpcHandlers / setupEventForwarding pass the real ipcMain
 * and the current window's webContents; the test passes a fake adapter. The
 * IpcMainLike / WebContentsLike adapter types live in ipc-plan-adapters.ts and
 * are reused here.
 *
 * Unlike the per-generation Plan/Todo controllers, the ComputerUseService is
 * app-level and stable for the process lifetime, so the event-forwarding
 * subscription is created once at setup time and released together with the
 * other forwarding subscriptions (no command-time re-sync hook).
 */

import type { ComputerUseEvent } from "../shared/computer-use-types.js";
import { isComputerUseCommand } from "../shared/computer-use-types.js";
import type { ComputerUseService } from "./computer-use/computer-use-service.js";
import type { IpcMainLike, WebContentsLike } from "./ipc-plan-adapters.js";

/**
 * Register the computer-use-command handler on an injectable ipcMain adapter.
 * Production passes the real ipcMain; computer-use-ipc.test.ts passes a fake
 * adapter. Failure envelope codes: invalid command, missing service, or a
 * throwing service.
 */
export function registerComputerUseIpcHandlers(ipc: IpcMainLike, getService: () => ComputerUseService | null): void {
	ipc.handle("computer-use-command", async (_event: unknown, command: unknown) => {
		if (!isComputerUseCommand(command)) {
			// JSON.stringify itself can throw (BigInt values, circular references) and would
			// blow up the failure envelope it is building - fall back to a type-only description.
			let error: string;
			try {
				error = `Invalid computer use command: ${JSON.stringify(command)}`;
			} catch {
				error = `Invalid computer use command (unrecognizable payload of type ${typeof command})`;
			}
			return { success: false, code: "invalid_computer_use_command", error };
		}
		const service = getService();
		if (!service) {
			return { success: false, code: "computer_use_unavailable", error: "Computer use service is not available." };
		}
		try {
			return await service.execute(command);
		} catch (err: unknown) {
			return { success: false, code: "computer_use_command_failed", error: err instanceof Error ? err.message : String(err) };
		}
	});
}

/**
 * Forward ComputerUseService events to the renderer on the computer-use-event
 * channel. Returns an unsubscribe function. The webContents getter is
 * re-evaluated per event so forwarding survives window close/reopen cycles;
 * a missing/destroyed webContents drops the event.
 */
export function subscribeComputerUseEventForwarding(
	service: ComputerUseService,
	getWebContents: () => WebContentsLike | null,
): () => void {
	return service.onEvent((event: ComputerUseEvent) => {
		const webContents = getWebContents();
		if (webContents) {
			webContents.send("computer-use-event", event);
		}
	});
}
