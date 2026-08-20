/**
 * AgentTask IPC adapters (PiX 1.4.1, design plan §4.9).
 *
 * Pure registration/dispatch for the agent-task-command IPC surface, extracted
 * from ipc-handlers.ts so agent-task-ipc.test.ts can register and exercise the
 * REAL production handlers in pure Node without loading the Electron runtime
 * (ipc-handlers.ts imports electron at the top level). Production
 * registerIpcHandlers / setupEventForwarding pass the real ipcMain and the
 * current window's webContents; the test passes a fake adapter.
 *
 * Every command targets the app-level AgentTaskService (one per app, created
 * by index.ts); all mutation/delivery commands carry taskId+generation and the
 * service rejects stale generations with reason "stale_generation", which the
 * handler surfaces as the envelope code. The registration functions below are
 * pure: they take the injectable IpcMainLike / WebContentsLike adapter so
 * agent-task-ipc.test.ts can register the real handlers in pure Node without
 * loading the Electron runtime (same rule as the plan adapters).
 */

import { isFiniteNonNegativeNumber, type IpcMainLike, type WebContentsLike } from "./ipc-plan-adapters.js";
import type { AgentTaskService } from "./agent-task/agent-task-service.js";
import type { AgentTaskCommand, AgentTaskCommandDataV142, PixCommandResult } from "../shared/types.js";

export type { IpcMainLike, WebContentsLike } from "./ipc-plan-adapters.js";

const VALID_AGENT_TASK_COMMAND_TYPES = new Set([
  "cancel",
  "background",
  "foreground",
  "continue_foreground_wait",
  "respond_input",
  "cancel_input",
  "send_to_session",
  "clear",
  "get_all",
  "get_active_input_requests",
  // 1.4.2 (R3) recovery commands
  "clear_all_terminal",
  "export_diagnostics",
  "resume",
  "mark_failed",
  "get_resume_summary",
]);

function isRequestUserInputResponse(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  return typeof response.id === "string" && typeof response.answers === "object" && response.answers !== null;
}

/** Structural guard for ResumeDecision (continue / switch_model). */
function isResumeDecision(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const decision = value as Record<string, unknown>;
  if (decision.action === "continue") {
    return typeof decision.confirmWorkspaceChanges === "boolean";
  }
  if (decision.action === "switch_model") {
    return (
      typeof decision.provider === "string" &&
      typeof decision.modelId === "string" &&
      typeof decision.confirmWorkspaceChanges === "boolean"
    );
  }
  return false;
}

/** Structural guard with per-type required sub-fields (mirrors isPlanCommand). */
export function isAgentTaskCommand(cmd: unknown): cmd is AgentTaskCommand {
  if (typeof cmd !== "object" || cmd === null || !("type" in cmd)) return false;
  const type = (cmd as Record<string, unknown>).type;
  if (typeof type !== "string" || !VALID_AGENT_TASK_COMMAND_TYPES.has(type)) return false;

  const c = cmd as Record<string, unknown>;
  switch (type) {
    case "cancel":
    case "background":
    case "foreground":
    case "continue_foreground_wait":
      return typeof c.taskId === "string" && isFiniteNonNegativeNumber(c.generation);
    case "respond_input":
      return (
        typeof c.taskId === "string" &&
        typeof c.requestId === "string" &&
        isFiniteNonNegativeNumber(c.generation) &&
        isRequestUserInputResponse(c.response)
      );
    case "cancel_input":
      return typeof c.taskId === "string" && typeof c.requestId === "string" && isFiniteNonNegativeNumber(c.generation);
    case "send_to_session":
      return (
        typeof c.taskId === "string" &&
        isFiniteNonNegativeNumber(c.generation) &&
        typeof c.targetSessionId === "string" &&
        (c.confirmDuplicate === undefined || typeof c.confirmDuplicate === "boolean")
      );
    case "clear":
      return typeof c.taskId === "string" && isFiniteNonNegativeNumber(c.generation) && typeof c.confirmDataLoss === "boolean";
    case "get_all":
    case "get_active_input_requests":
      return true;
    case "clear_all_terminal":
      return (
        typeof c.confirm === "boolean" &&
        (c.workspaceId === undefined || typeof c.workspaceId === "string")
      );
    case "export_diagnostics":
      return typeof c.taskId === "string";
    case "resume":
      return typeof c.taskId === "string" && isFiniteNonNegativeNumber(c.generation) && isResumeDecision(c.decision);
    case "mark_failed":
    case "get_resume_summary":
      return typeof c.taskId === "string" && isFiniteNonNegativeNumber(c.generation);
    default:
      return true;
  }
}

/** Map an AgentTaskService {ok,reason} result onto the existing {success,data?,error,code?} envelope. */
function agentTaskCommandResult(result: { ok: boolean; reason?: string }): PixCommandResult<undefined> {
  if (result.ok) return { success: true };
  return { success: false, code: result.reason ?? "agent_task_command_failed", error: result.reason ?? "Agent task command failed." };
}

export async function executeAgentTaskCommand(
  service: AgentTaskService,
  cmd: AgentTaskCommand,
): Promise<PixCommandResult<AgentTaskCommandDataV142<AgentTaskCommand>>> {
  switch (cmd.type) {
    case "cancel":
      return agentTaskCommandResult(await service.cancel(cmd.taskId, cmd.generation, "user_cancel"));
    case "background":
      return agentTaskCommandResult(service.background(cmd.taskId, cmd.generation));
    case "foreground":
      return agentTaskCommandResult(service.foreground(cmd.taskId, cmd.generation));
    case "continue_foreground_wait":
      return agentTaskCommandResult(service.continueForegroundWait(cmd.taskId, cmd.generation));
    case "respond_input": {
      const accepted = service.respondInput(cmd.taskId, cmd.requestId, cmd.generation, cmd.response);
      if (!accepted) {
        return {
          success: false,
          code: "task_input_not_found",
          error: "Task input request not found: the taskId/requestId/generation triple did not match a pending request.",
        };
      }
      return { success: true };
    }
    case "cancel_input": {
      const accepted = service.cancelInput(cmd.taskId, cmd.requestId, cmd.generation);
      if (!accepted) {
        return {
          success: false,
          code: "task_input_not_found",
          error: "Task input request not found: the taskId/requestId/generation triple did not match a pending request.",
        };
      }
      return { success: true };
    }
    case "send_to_session":
      return agentTaskCommandResult(
        await service.sendResultToSession(cmd.taskId, cmd.generation, cmd.targetSessionId, cmd.confirmDuplicate),
      );
    case "clear":
      return agentTaskCommandResult(await service.clearTask(cmd.taskId, cmd.generation, cmd.confirmDataLoss));
    case "get_all":
      // 1.4.2 (R2): the full remount snapshot (tasks + recoveryIssues + storageStatuses).
      return { success: true, data: service.getAll() };
    case "get_active_input_requests":
      return { success: true, data: service.getActiveInputRequests() };
    // 1.4.2 (R3) recovery commands
    case "clear_all_terminal": {
      const result = await service.clearAllTerminal(cmd.workspaceId, cmd.confirm);
      if (result.ok) {
        return { success: true, data: result.data };
      }
      return {
        success: false,
        code: result.reason ?? "agent_task_command_failed",
        error: result.reason ?? "Agent task command failed.",
      };
    }
    case "export_diagnostics": {
      const data = await service.getDiagnostics(cmd.taskId);
      return { success: true, data };
    }
    case "resume": {
      // The service normalizes every known resume failure to {ok:false}; an
      // unexpected throw must still surface as a structured envelope instead
      // of rejecting the IPC handler.
      try {
        return agentTaskCommandResult(await service.resume(cmd.taskId, cmd.generation, cmd.decision));
      } catch (err: unknown) {
        const reason = err instanceof Error && err.message !== "" ? err.message : "agent_task_resume_failed";
        return { success: false, code: reason, error: reason };
      }
    }
    case "mark_failed":
      return agentTaskCommandResult(await service.markFailed(cmd.taskId, cmd.generation, "user_decision"));
    case "get_resume_summary": {
      try {
        const data = await service.getResumeSummary(cmd.taskId, cmd.generation);
        return { success: true, data };
      } catch (err: unknown) {
        const reason = err instanceof Error && err.message !== "" ? err.message : "agent_task_command_failed";
        return { success: false, code: reason, error: reason };
      }
    }
    default:
      return {
        success: false,
        code: "unknown_agent_task_command",
        error: `Unknown agent task command type: ${(cmd as { type: string }).type}`,
      };
  }
}

/**
 * Register the agent-task-command handler and the pending-input remount
 * catch-up on an injectable ipcMain adapter. Production passes the real
 * ipcMain; agent-task-ipc.test.ts passes a fake adapter.
 */
export function registerAgentTaskIpcHandlers(ipc: IpcMainLike, service: AgentTaskService): void {
  ipc.handle("agent-task-command", async (_event: unknown, command: unknown) => {
    if (!isAgentTaskCommand(command)) {
      return {
        success: false,
        code: "invalid_agent_task_command",
        error: `Invalid agent task command: ${JSON.stringify(command)}`,
      };
    }
    try {
      return await executeAgentTaskCommand(service, command);
    } catch (err: unknown) {
      return { success: false, code: "agent_task_command_failed", error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Remount catch-up: the renderer store re-subscribes and replays the active
  // input requests after a window reload (design plan §4.9).
  ipc.handle("get-pending-agent-task-input-requests", () => service.getActiveInputRequests());
}

/**
 * Forward AgentTaskService events to the renderer on the dedicated channels:
 * input requests travel on agent-task-input-request only (never on the
 * ordinary event stream); renderable task events travel on agent-task-event;
 * the main-only task_file_change event is consumed inside main by the Plan
 * adapter and never crosses IPC (design plan §3, §4.9). The service already
 * applies the bounded 100ms throttle to task_activities/task_output before
 * emitting (§4.5), so the forwarding layer adds no second throttle.
 */
export function subscribeAgentTaskEventForwarding(
  getWebContents: () => WebContentsLike | null,
  service: AgentTaskService,
): () => void {
  return service.onEvent((event) => {
    const webContents = getWebContents();
    if (!webContents) {
      return;
    }
    if (event.type === "task_input") {
      webContents.send("agent-task-input-request", event.request);
      return;
    }
    if (event.type === "task_file_change") {
      // main-only: consumed by the Plan deviation adapter inside main.
      return;
    }
    // task_state / task_input_dismissed / task_activities / task_output and
    // the 1.4.2 (R2) storage_status / recovery_issue events share the exact
    // AgentTaskEvent shape (§4.9).
    webContents.send("agent-task-event", event);
  });
}
