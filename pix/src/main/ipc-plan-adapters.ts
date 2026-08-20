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
 * The IpcMainLike / WebContentsLike adapter types and the shared
 * isFiniteNonNegativeNumber helper live here and are reused by the agent-task
 * adapters (ipc-agent-task-adapters.ts).
 */

import type { PlanController, PlanControllerEvent, PlanUserRequest } from "./plan/plan-controller.js";
import type { PixCommandResult, PlanCommand, PlanRuntimeSnapshot } from "../shared/types.js";

/** Minimal ipcMain.handle surface used by the plan IPC registration. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

/** Minimal webContents.send surface used by plan-event forwarding. */
export interface WebContentsLike {
  send(channel: string, ...args: unknown[]): void;
}

export function isFiniteNonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const VALID_PLAN_COMMAND_TYPES = new Set([
  "enter_planning",
  "retry_generation",
  "use_session_model_and_retry",
  "regenerate_plan",
  "request_revision",
  "return_previous_version",
  "approve",
  "start_execution",
  "cancel",
  "retry_step",
  "skip_step",
  "continue_plan",
  "get_snapshot",
]);

/** Structural guard with per-type required sub-fields (mirrors isTeamCommand). */
export function isPlanCommand(cmd: unknown): cmd is PlanCommand {
  if (typeof cmd !== "object" || cmd === null || !("type" in cmd)) return false;
  const type = (cmd as Record<string, unknown>).type;
  if (typeof type !== "string" || !VALID_PLAN_COMMAND_TYPES.has(type)) return false;

  const c = cmd as Record<string, unknown>;
  switch (type) {
    case "enter_planning":
      if (c.requestText !== undefined && typeof c.requestText !== "string") return false;
      if (c.filePaths !== undefined && !Array.isArray(c.filePaths)) return false;
      if (c.images !== undefined && !Array.isArray(c.images)) return false;
      // First armed entry requires a non-empty requestText; only a dormant
      // retry may omit it, and then it must not carry attachments (§4.9).
      if (c.requestText === undefined && (c.filePaths !== undefined || c.images !== undefined)) return false;
      if (c.source !== undefined && c.source !== "configured" && c.source !== "session") return false;
      return true;
    case "retry_generation":
    case "use_session_model_and_retry":
      return typeof c.generationId === "string";
    case "regenerate_plan":
      return typeof c.generationId === "string" && typeof c.concise === "boolean";
    case "request_revision":
      return (
        typeof c.planId === "string" &&
        isFiniteNonNegativeNumber(c.version) &&
        typeof c.feedback === "string" &&
        (c.stepKey === undefined || typeof c.stepKey === "string")
      );
    case "return_previous_version":
      return typeof c.planId === "string" && isFiniteNonNegativeNumber(c.baseVersion);
    case "approve":
    case "start_execution":
    case "continue_plan":
      return typeof c.planId === "string" && isFiniteNonNegativeNumber(c.version);
    case "cancel":
      // PlanCancelRef: { planId; generationId } (no valid plan yet) or { planId; version }.
      return typeof c.planId === "string" && (typeof c.generationId === "string" || isFiniteNonNegativeNumber(c.version));
    case "retry_step":
    case "skip_step":
      return typeof c.planId === "string" && isFiniteNonNegativeNumber(c.version) && typeof c.stepId === "string";
    case "get_snapshot":
      return true;
    default:
      return true;
  }
}

/** Map a PlanController result onto the existing {success,data?,error,code?} envelope. */
function planCommandResult(result: { ok: boolean; reason?: string }): PixCommandResult<undefined> {
  if (result.ok) return { success: true };
  return { success: false, code: result.reason ?? "plan_command_failed", error: result.reason ?? "Plan command failed." };
}

export async function executePlanCommand(
  controller: PlanController,
  cmd: PlanCommand,
): Promise<PixCommandResult<PlanRuntimeSnapshot | undefined>> {
  switch (cmd.type) {
    case "enter_planning": {
      const request: PlanUserRequest | undefined =
        cmd.requestText !== undefined
          ? { text: cmd.requestText, filePaths: cmd.filePaths, images: cmd.images }
          : undefined;
      return planCommandResult(await controller.enterPlanning(request, cmd.source));
    }
    case "retry_generation":
      return planCommandResult(await controller.retryGeneration(cmd.generationId));
    case "use_session_model_and_retry":
      return planCommandResult(await controller.useSessionModelAndRetry(cmd.generationId));
    case "regenerate_plan":
      return planCommandResult(await controller.regeneratePlan(cmd.generationId, cmd.concise));
    case "request_revision":
      return planCommandResult(await controller.requestRevision(cmd.planId, cmd.version, cmd.feedback, cmd.stepKey));
    case "return_previous_version":
      return planCommandResult(controller.returnToPreviousVersion(cmd.planId, cmd.baseVersion));
    case "approve":
      return planCommandResult(await controller.approve(cmd.planId, cmd.version));
    case "start_execution":
      return planCommandResult(await controller.startExecution(cmd.planId, cmd.version));
    case "cancel":
      return planCommandResult(await controller.cancel(cmd));
    case "retry_step":
      return planCommandResult(await controller.retryStep(cmd.planId, cmd.version, cmd.stepId));
    case "skip_step":
      return planCommandResult(controller.skipStep(cmd.planId, cmd.version, cmd.stepId));
    case "continue_plan":
      return planCommandResult(await controller.continuePlan(cmd.planId, cmd.version));
    case "get_snapshot":
      return { success: true, data: controller.getSnapshot() };
    default:
      return { success: false, code: "unknown_plan_command", error: `Unknown plan command type: ${(cmd as { type: string }).type}` };
  }
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

  function forward(event: PlanControllerEvent): void {
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
