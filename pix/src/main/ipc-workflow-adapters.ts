/**
 * Workflow IPC adapters (PiX 1.4.3, design plan §4.9).
 *
 * Pure registration/dispatch for the workflow-command / workflow-event IPC
 * surface, extracted from ipc-handlers.ts so workflow-ipc.test.ts can
 * register and exercise the REAL production handlers in pure Node without
 * loading the Electron runtime (ipc-handlers.ts imports electron at the top
 * level). Production registerIpcHandlers / setupEventForwarding pass the
 * real ipcMain and the current window's webContents; the test passes a fake
 * adapter.
 *
 * The IpcMainLike / WebContentsLike adapter types and the shared
 * isFiniteNonNegativeNumber helper live in ipc-plan-adapters.ts and are
 * reused by the agent-task adapters and here. The adapter never imports
 * SessionBridge: the recorder instance and the parent-session entry stream
 * (getEntries) are injected by ipc-handlers.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { PixCommandResult } from "../shared/types.js";
import {
  isWorkflowCommand,
  type WorkflowCommand,
  type WorkflowEvent,
  type WorkflowViewState,
} from "../shared/workflow-types.js";
import type { WorkflowRecorder } from "./workflow/recorder.js";
import type { IpcMainLike, WebContentsLike } from "./ipc-plan-adapters.js";

/**
 * Dispatch one WorkflowCommand against the current generation's recorder.
 * The only valid command is get_snapshot. With no recorder (no active solo
 * generation) an empty snapshot is a legitimate state, not an error
 * (design plan §4.9: get_snapshot -> recorder.getSnapshot(); no generation
 * -> []).
 */
export async function executeWorkflowCommand(
  recorder: WorkflowRecorder | null,
  cmd: WorkflowCommand,
): Promise<PixCommandResult<WorkflowViewState[]>> {
  if (!recorder) {
    return { success: true, data: [] };
  }
  try {
    switch (cmd.type) {
      case "get_snapshot":
        return { success: true, data: recorder.getSnapshot() };
      default:
        return {
          success: false,
          code: "unknown_workflow_command",
          error: `Unknown workflow command type: ${(cmd as { type: string }).type}`,
        };
    }
  } catch (err: unknown) {
    return { success: false, code: "workflow_command_failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Register the workflow-command handler on an injectable ipcMain adapter.
 * Production passes the real ipcMain; workflow-ipc.test.ts passes a fake
 * adapter.
 */
export function registerWorkflowIpcHandlers(
  ipc: IpcMainLike,
  getRecorder: () => WorkflowRecorder | null,
): void {
  ipc.handle("workflow-command", async (_event: unknown, command: unknown) => {
    // Re-sync the workflow-event forwarding subscription before every
    // command; a session switch replaced the recorder instance since the
    // previous command (see subscribeWorkflowEventForwarding).
    workflowEventForwardingSync?.();
    if (!isWorkflowCommand(command)) {
      return {
        success: false,
        code: "invalid_workflow_command",
        error: `Invalid workflow command: ${JSON.stringify(command)}`,
      };
    }
    return await executeWorkflowCommand(getRecorder(), command);
  });
}

/**
 * Re-sync hook invoked by registerWorkflowIpcHandlers before every workflow
 * command and by the session-switching command paths (switch_session /
 * new_session / fork / clone / navigate_tree) after they replace the
 * recorder instance. Each solo runtime generation owns its own
 * WorkflowRecorder (a session switch replaces the instance), and forwarding
 * is subscribed at setup time - before any session exists - so the
 * subscription must be re-attached to the current recorder at command time.
 * Every re-sync ends with one snapshot push so the renderer mirror
 * converges without waiting for the next event: same instance -> re-push
 * (no restore), swapped instance -> restore(getEntries()) then push, no
 * recorder -> push runs: [].
 */
let workflowEventForwardingSync: (() => void) | null = null;

/** Invoke the module-level re-sync hook (no-op when no forwarding is subscribed). */
export function resyncWorkflowEventForwarding(): void {
  workflowEventForwardingSync?.();
}

/**
 * Forward WorkflowRecorder fold changes to the renderer on the
 * workflow-event channel. Returns an unsubscribe function. The webContents
 * getter is re-evaluated per event so forwarding survives window
 * close/reopen cycles; the recorder subscription is re-synced by
 * registerWorkflowIpcHandlers before every command and by
 * resyncWorkflowEventForwarding after generation switches. The parent
 * session's entry stream (getEntries) is injected by ipc-handlers - the
 * adapter never imports SessionBridge.
 */
export function subscribeWorkflowEventForwarding(
  getWebContents: () => WebContentsLike | null,
  getRecorder: () => WorkflowRecorder | null,
  getEntries: () => SessionEntry[],
): () => void {
  let current: WorkflowRecorder | null = null;
  let currentUnsubscribe: (() => void) | null = null;
  let disposed = false;

  function sync(): void {
    if (disposed) return;
    const next = getRecorder();
    if (next !== current) {
      currentUnsubscribe?.();
      currentUnsubscribe = null;
      current = next;
      if (next) {
        // A recorder replacement (e.g. session switch) starts empty; fold
        // the parent session's pix-workflow-v1 CustomEntries back in so
        // interrupted-prefix runs survive the switch (restore is
        // idempotent). The folded runs are the snapshot payload; the live
        // upsert subscription attaches only after restore, so restored runs
        // arrive exactly once, via the snapshot.
        const runs = next.restore(getEntries());
        currentUnsubscribe = next.onViewChange((run) => {
          if (!disposed) {
            forward({ type: "upsert", run });
          }
        });
        forward({ type: "snapshot", runs });
        return;
      }
    }
    // Every other re-sync also ends with one snapshot push: same instance ->
    // the recorder's current fold (no restore; applySnapshot is idempotent),
    // no recorder -> empty runs.
    forward({ type: "snapshot", runs: next ? next.getSnapshot() : [] });
  }

  function forward(event: WorkflowEvent): void {
    const webContents = getWebContents();
    if (webContents) {
      webContents.send("workflow-event", event);
    }
  }

  sync();
  workflowEventForwardingSync = sync;

  return () => {
    disposed = true;
    currentUnsubscribe?.();
    currentUnsubscribe = null;
    current = null;
    if (workflowEventForwardingSync === sync) {
      workflowEventForwardingSync = null;
    }
  };
}
