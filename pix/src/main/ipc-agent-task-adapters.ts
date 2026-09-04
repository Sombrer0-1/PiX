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
import type { AgentTaskInfo } from "../shared/agent-task-types.js";
import type { AgentTaskCommand, AgentTaskCommandDataV15, AgentTaskEvent, PixCommandResult } from "../shared/types.js";

const LIST_OUTPUT_PREVIEW_CHARS = 240;

function truncatePreview(text: string, maxChars: number): { text: string; truncated: boolean } {
  const chars = Array.from(text);
  if (chars.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: chars.slice(0, maxChars).join(""), truncated: true };
}

/** Renderer list payload: keep isAgentTaskInfo, drop heavy live fields when the task is not watched. */
export function toRendererTaskState(task: AgentTaskInfo, watched: boolean): AgentTaskInfo {
  if (watched) {
    return task;
  }
  const preview = truncatePreview(task.finalOutput, LIST_OUTPUT_PREVIEW_CHARS);
  const previewBytes = Buffer.byteLength(preview.text, "utf8");
  const originalBytes = Math.max(task.originalOutputBytes, preview.truncated ? previewBytes + 1 : previewBytes);
  return {
    ...task,
    finalOutput: preview.text,
    outputTruncated: task.outputTruncated || preview.truncated,
    originalOutputBytes: originalBytes,
    activities: [],
    results: task.results.map((result) => ({
      ...result,
      finalOutput: "",
      activities: [],
    })),
  };
}

export type { IpcMainLike, WebContentsLike } from "./ipc-plan-adapters.js";

// 1.5 (P1): the manual-operation commands are gone (delivery catch-up,
// auto-recovery and retention are main-process automations); the surface is
// the approval/stop pair plus queries and the diagnostics export.
// 1.5 (P3/P4): the V15 command union adds the task-center watch/transcript/log
// commands (watch_task / unwatch_task / get_transcript / get_task_log); S1
// registers them with the guard, S4 lands watch/unwatch/get_transcript dispatch
// and S6 lands get_task_log.
const VALID_AGENT_TASK_COMMAND_TYPES = new Set([
  "cancel",
  "respond_input",
  "cancel_input",
  "get_all",
  "get",
  "get_active_input_requests",
  "export_diagnostics",
  "watch_task",
  "unwatch_task",
  "get_transcript",
  "get_task_log",
]);

function isRequestUserInputResponse(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  return typeof response.id === "string" && typeof response.answers === "object" && response.answers !== null;
}

/** Structural guard with per-type required sub-fields (mirrors isPlanCommand). */
export function isAgentTaskCommand(cmd: unknown): cmd is AgentTaskCommand {
  if (typeof cmd !== "object" || cmd === null || !("type" in cmd)) return false;
  const type = (cmd as Record<string, unknown>).type;
  if (typeof type !== "string" || !VALID_AGENT_TASK_COMMAND_TYPES.has(type)) return false;

  const c = cmd as Record<string, unknown>;
  switch (type) {
    case "cancel":
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
    case "get_all":
    case "get_active_input_requests":
      return true;
    case "get":
      return typeof c.taskId === "string";
    case "export_diagnostics":
      return typeof c.taskId === "string";
    case "watch_task":
    case "unwatch_task":
    case "get_task_log":
      return typeof c.taskId === "string";
    case "get_transcript":
      // itemIndex 缺省或非负整数；cursor 缺省或 string；limit 缺省或有限正整数。
      return (
        typeof c.taskId === "string" &&
        (c.itemIndex === undefined ||
          (typeof c.itemIndex === "number" && Number.isInteger(c.itemIndex) && c.itemIndex >= 0)) &&
        (c.cursor === undefined || typeof c.cursor === "string") &&
        (c.limit === undefined || (typeof c.limit === "number" && Number.isInteger(c.limit) && c.limit > 0)) &&
        (c.tail === undefined || typeof c.tail === "boolean") &&
        (c.before === undefined || typeof c.before === "string")
      );
    default:
      return true;
  }
}

/** Map an AgentTaskService {ok,reason} result onto the existing {success,data?,error,code?} envelope. */
function agentTaskCommandResult(result: { ok: boolean; reason?: string }): PixCommandResult<undefined> {
  if (result.ok) return { success: true };
  return { success: false, code: result.reason ?? "agent_task_command_failed", error: result.reason ?? "Agent task command failed." };
}

// Perf SDD §4.5 (S5 startup gating): restoreAll runs in parallel with the
// first window, so the task queries that used to implicitly wait for it
// (get_all / get_active_input_requests / get-pending-agent-task-input-requests)
// hold on this module-level gate until the restore settles. undefined or an
// already-resolved promise is a passthrough; the wired promise never rejects
// (index.ts derives it with .catch(() => {})). The module-level gate keeps
// registerAgentTaskIpcHandlers(ipc, service) signature-free of the wiring.
let restoreGate: Promise<unknown> | undefined;

/**
 * Set the restore gate. index.ts calls this once at startup around the IPC
 * registration; tests may reset it with undefined (passthrough, the default).
 */
export function setRestoreGate(whenRestored?: Promise<unknown>): void {
  restoreGate = whenRestored;
}

/** Await the restore gate before reading task data (undefined/resolved = passthrough). */
async function awaitRestoreGate(): Promise<void> {
  if (restoreGate !== undefined) {
    await restoreGate;
  }
}

export async function executeAgentTaskCommand(
  service: AgentTaskService,
  cmd: AgentTaskCommand,
): Promise<PixCommandResult<AgentTaskCommandDataV15<AgentTaskCommand>>> {
  switch (cmd.type) {
    case "cancel":
      return agentTaskCommandResult(await service.cancel(cmd.taskId, cmd.generation, "user_cancel"));
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
    case "get_all":
      // Perf SDD §4.5: gated on the restore so the first remount sees the
      // fully hydrated task set while createWindow already ran.
      await awaitRestoreGate();
      // 1.4.2 (R2): the full remount snapshot (tasks + recoveryIssues + storageStatuses).
      return { success: true, data: service.getAll() };
    case "get": {
      const task = service.get(cmd.taskId);
      return task
        ? { success: true, data: task }
        : { success: false, code: "not_found", error: `Agent task not found: ${cmd.taskId}` };
    }
    case "get_active_input_requests":
      // Perf SDD §4.5: same data source as the remount catch-up below - gated.
      await awaitRestoreGate();
      return { success: true, data: service.getActiveInputRequests() };
    case "export_diagnostics": {
      try {
        const data = await service.getDiagnostics(cmd.taskId);
        return { success: true, data };
      } catch (err: unknown) {
        const reason = err instanceof Error && err.message !== "" ? err.message : "agent_task_command_failed";
        return { success: false, code: reason, error: reason };
      }
    }
    case "watch_task":
      // 1.5 (P3): the only not_found mapping here - watchTask returns false
      // for an unknown task (never throws).
      return service.watchTask(cmd.taskId)
        ? { success: true }
        : { success: false, code: "not_found", error: `Agent task not found: ${cmd.taskId}` };
    case "unwatch_task":
      // Idempotent: unwatching an unknown task is still success.
      service.unwatchTask(cmd.taskId);
      return { success: true };
    case "get_transcript": {
      const itemIndex = cmd.itemIndex ?? 0;
      const limit = Math.min(Math.max(1, cmd.limit ?? 200), 1000);
      try {
        return {
          success: true,
          data: await service.getTranscriptPage(cmd.taskId, itemIndex, cmd.cursor, limit, cmd.tail === true, cmd.before),
        };
      } catch (err) {
        // 只有任务不存在才是 not_found;I/O 等其它异常保留原始信息,不吞错。
        const notFound = err instanceof Error && err.message === "not_found";
        const message = err instanceof Error && err.message !== "" ? err.message : "agent_task_command_failed";
        return notFound
          ? { success: false, code: "not_found", error: `Agent task not found: ${cmd.taskId}` }
          : { success: false, code: "agent_task_command_failed", error: message };
      }
    }
    // 1.5 (P4): get_task_log 与 get_transcript 同构 —— 只有任务不存在才是
    // not_found;其余异常保留原始 message(空则 agent_task_command_failed)。
    case "get_task_log": {
      try {
        return { success: true, data: await service.getTaskLog(cmd.taskId) };
      } catch (err) {
        const notFound = err instanceof Error && err.message === "not_found";
        const message = err instanceof Error && err.message !== "" ? err.message : "agent_task_command_failed";
        return notFound
          ? { success: false, code: "not_found", error: `Agent task not found: ${cmd.taskId}` }
          : { success: false, code: "agent_task_command_failed", error: message };
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
  // input requests after a window reload (design plan §4.9). Perf SDD §4.5:
  // gated on the restore like get_active_input_requests (same data source).
  ipc.handle("get-pending-agent-task-input-requests", async () => {
    await awaitRestoreGate();
    return service.getActiveInputRequests();
  });
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
      // 1.5 (P4): watched tasks get the file change live; planLink/aggregate
      // are main-only semantics and are stripped here (the main-side Plan
      // adapter consumption is unaffected - it subscribes to the service bus,
      // not this forwarding).
      if (service.isTaskWatched(event.taskId)) {
        webContents.send("agent-task-event", { type: "task_file_change", taskId: event.taskId, change: event.change });
      }
      return;
    }
    if (event.type === "task_state") {
      const watched = service.isTaskWatched(event.task.taskId);
      const forwarded: AgentTaskEvent = { type: "task_state", task: toRendererTaskState(event.task, watched) };
      webContents.send("agent-task-event", forwarded);
      return;
    }
    if (event.type === "task_activities" || event.type === "task_output" || event.type === "task_transcript") {
      if (!service.isTaskWatched(event.taskId)) {
        return;
      }
    }
    webContents.send("agent-task-event", event);
  });
}
