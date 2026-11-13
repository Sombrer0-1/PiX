/**
 * Plan IPC adapters (PiX 1.4.0, design plan §4.9).
 *
 * Pure registration/dispatch for the plan-command IPC surface, extracted from
 * ipc-handlers.ts so plan-ipc.test.ts can register and exercise the REAL
 * production handlers in pure Node without loading the Electron runtime
 * (ipc-handlers.ts imports electron at the top level). Production
 * registerIpcHandlers / setupEventForwarding pass the real ipcMain and the
 * current window's webContents; the test passes a fake adapter.
 *
 * The other desktop adapters reuse IpcMainLike and WebContentsLike.
 */

import type { PlanController } from "@earendil-works/pix-runtime/plan/plan-controller.js";
import type { PlanEvent } from "@earendil-works/pix-runtime/shared/types";
import { executePlanCommand, isPlanCommand } from "@earendil-works/pix-runtime/plan/plan-command.js";

/** Minimal ipcMain.handle surface used by the plan IPC registration. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

/** Minimal webContents.send surface used by plan-event forwarding. */
export interface WebContentsLike {
  send(channel: string, ...args: unknown[]): void;
}

/**
 * Register the plan-command handler on an injectable ipcMain adapter.
 * Production passes the real ipcMain; plan-ipc.test.ts passes a fake adapter.
 */
export function registerPlanIpcHandlers(ipc: IpcMainLike, getPlanController: () => PlanController | null): void {
  ipc.handle("plan-command", async (_event: unknown, command: unknown) => {
    // Re-attach the plan-event forwarding subscription to the current
    // controller before every command; a session switch replaced it since the
    // previous command (see subscribePlanEventForwarding).
    planEventForwardingSync?.();
    if (!isPlanCommand(command)) {
      return { success: false, code: "invalid_plan_command", error: `Invalid plan command: ${JSON.stringify(command)}` };
    }
    const controller = getPlanController();
    if (!controller) {
      return { success: false, code: "plan_unavailable", error: "Plan controller is not available (no active session)." };
    }
    try {
      return await executePlanCommand(controller, command);
    } catch (err: unknown) {
      return { success: false, code: "plan_command_failed", error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/**
 * Re-sync hook invoked by registerPlanIpcHandlers before every plan command
 * and by the session-switching command paths (switch_session / new_session /
 * fork / clone / navigate_tree) after they replace the controller instance.
 * Each solo runtime generation owns its own PlanController (a session switch
 * replaces the instance), and forwarding is subscribed at setup time - before
 * any session exists - so the subscription must be re-attached to the current
 * controller at command time, or a replacement controller's first events would
 * have no listener. The re-sync also pushes a fresh plan_state snapshot when
 * it detects a controller change, so the renderer mirror converges without
 * waiting for the next plan command.
 */
let planEventForwardingSync: (() => void) | null = null;

/** Invoke the module-level re-sync hook (no-op when no forwarding is subscribed). */
export function resyncPlanEventForwarding(): void {
  planEventForwardingSync?.();
}

/**
 * Forward PlanController events to the renderer on the plan-event channel.
 * Returns an unsubscribe function. The webContents getter is re-evaluated per
 * event so forwarding survives window close/reopen cycles; the controller
 * subscription is re-synced by registerPlanIpcHandlers before every command.
 */
export function subscribePlanEventForwarding(
  getWebContents: () => WebContentsLike | null,
  getPlanController: () => PlanController | null,
): () => void {
  let current: PlanController | null = null;
  let currentUnsubscribe: (() => void) | null = null;
  let disposed = false;

  function sync(): void {
    if (disposed) return;
    const next = getPlanController();
    if (next === current) return;
    currentUnsubscribe?.();
    currentUnsubscribe = null;
    current = next;
    if (next) {
      currentUnsubscribe = next.onEvent((event) => {
        if (!disposed) {
          forward(event);
        }
      });
      // A controller replacement (e.g. session switch) means the replacement's
      // hydration plan_state events were emitted before the new subscription
      // existed and were dropped. Push the current snapshot immediately so the
      // renderer mirror converges to the new controller's state (applySnapshot
      // is idempotent, so a re-push over an already-current mirror is a no-op).
      forward({ type: "plan_state", snapshot: next.getSnapshot() });
    }
  }

  function forward(event: PlanEvent): void {
    const webContents = getWebContents();
    if (webContents) {
      webContents.send("plan-event", event);
    }
  }

  sync();
  planEventForwardingSync = sync;

  return () => {
    disposed = true;
    currentUnsubscribe?.();
    currentUnsubscribe = null;
    current = null;
    if (planEventForwardingSync === sync) {
      planEventForwardingSync = null;
    }
  };
}
