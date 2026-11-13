import type { PlanController, PlanUserRequest } from "./plan-controller.js";
import type { PlanRuntimeSnapshot } from "../shared/plan-types.js";
import type { PixCommandResult, PlanCommand } from "../shared/types.js";

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

