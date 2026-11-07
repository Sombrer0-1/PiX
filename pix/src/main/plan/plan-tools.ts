/**
 * Plan SDK custom tools (PiX-1.4-PLAN.md §4.2).
 *
 * submit_user_plan: the model submits a plan draft; the host validates and
 * assigns identity/version/status (schemaVersion, planId, version, status,
 * planningModel, stepId, dependsOn as stepIds, step status pending).
 * update_plan_step: the executing model reports a step status transition.
 *
 * The TypeBox schemas stay structurally permissive (types + enums only):
 * emptiness, DAG and workspace semantics are validated by
 * validatePlanDraft / PlanController so initial failures produce structured
 * fieldErrors (planning_failed) instead of a raw tool-call error. Business
 * failures return ordinary AgentToolResult values; nothing here throws for a
 * business failure.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PlanRuntimeSnapshot } from "../../shared/plan-types.js";
import type { PlanController } from "./plan-controller.js";
import type {
  ModelSubmittedPlanStepStatus,
  SubmitUserPlanParams,
  UpdatePlanStepParams,
} from "./plan-deviation.js";

export const SUBMIT_PLAN_TOOL_NAME = "submit_user_plan";
export const UPDATE_PLAN_STEP_TOOL_NAME = "update_plan_step";

export type {
  ModelSubmittedPlanStepStatus,
  SubmitUserPlanParams,
  UpdatePlanStepParams,
} from "./plan-deviation.js";

/** Host surface for the plan tools: the owning PlanController. */
export interface PlanToolHost {
  controller: PlanController;
}

const PlanStepFileSchema = Type.Object({
  path: Type.String(),
  operation: StringEnum(["read", "create", "modify", "delete"] as const),
});

const PlanStepDraftSchema = Type.Object({
  stepKey: Type.String(),
  title: Type.String(),
  description: Type.String(),
  files: Type.Optional(Type.Array(PlanStepFileSchema)),
  scopeNote: Type.Optional(Type.String()),
  expectedCommands: Type.Optional(Type.Array(Type.String())),
  executionTarget: StringEnum(["parent", "subagent_foreground", "subagent_background"] as const),
  risk: StringEnum(["low", "medium", "high"] as const),
  riskReason: Type.String(),
  effort: StringEnum(["small", "medium", "large"] as const),
  verification: Type.String(),
  dependsOn: Type.Array(Type.String()),
});

const SubmitUserPlanParamsSchema = Type.Object({
  generationId: Type.String(),
  title: Type.String(),
  summary: Type.String(),
  steps: Type.Array(PlanStepDraftSchema),
  basedOnVersion: Type.Optional(Type.Integer({ minimum: 1 })),
});

const UpdatePlanStepParamsSchema = Type.Object({
  planId: Type.String(),
  version: Type.Integer({ minimum: 1 }),
  stepId: Type.String(),
  status: StringEnum(["running", "waiting_input", "completed", "failed"] as const),
  completionSummary: Type.Optional(Type.String()),
  verificationResult: Type.Optional(
    Type.Object({
      status: StringEnum(["passed", "failed", "not_run"] as const),
      summary: Type.String(),
    }),
  ),
  waitingReason: Type.Optional(StringEnum(["user_input"] as const)),
});

export interface SubmitPlanToolDetails {
  accepted: boolean;
  snapshot: PlanRuntimeSnapshot;
  fieldErrors?: Array<{ path: string; message: string }>;
}

export interface UpdatePlanStepToolDetails {
  accepted: boolean;
  snapshot: PlanRuntimeSnapshot;
  reason?: string;
}

const SUBMIT_PLAN_DESCRIPTION = [
  "Submit the complete plan for user approval. Use request_user_input first if a requirement needs clarification. The host validates the draft before creating a version. Wait for the user to approve and start execution.",
  "Copy generationId exactly from the current <plan_generation> context or retry message.",
  "For each step, describe the work, its risk and effort, how to verify it, and the files and commands it will touch.",
  "dependsOn lists OTHER stepKeys that must finish before this step; cycles and unknown keys are rejected.",
  "Revisions must pass basedOnVersion equal to the version the revision was requested against; first versions omit it.",
  "PlanStepFile.path is a workspace-relative logical path (no globs, no absolute paths); a trailing / declares a directory scope.",
  "expectedCommands are the exact commands the step expects to run; an empty array declares that no commands are expected.",
].join(" ");

const UPDATE_PLAN_STEP_DESCRIPTION = [
  "Report the status of the step you are executing. Use the planId, version, and stepId from the plan context.",
  "Mark a parent step running before work starts. Use waiting_input with waitingReason=user_input if you need the user's answer.",
  "Report completed with a completionSummary and a verificationResult of passed or not_run. Report failed if the step fails. The host handles skipped and cancelled.",
].join(" ");

function textContent(text: string): TextContent {
  return { type: "text", text };
}

/**
 * Create the submit_user_plan ToolDefinition bound to the owning controller.
 */
export function createSubmitUserPlanTool(
  host: PlanToolHost,
): ToolDefinition<typeof SubmitUserPlanParamsSchema, SubmitPlanToolDetails> {
  return {
    name: SUBMIT_PLAN_TOOL_NAME,
    label: "Submit User Plan",
    description: SUBMIT_PLAN_DESCRIPTION,
    promptSnippet: "Submit a complete plan draft for user approval.",
    parameters: SubmitUserPlanParamsSchema,
    async execute(_toolCallId, params): Promise<AgentToolResult<SubmitPlanToolDetails>> {
      const result = await host.controller.submitPlan(params);
      const snapshot = result.snapshot;
      let contentText: string;
      if (result.accepted) {
        const version = snapshot.plan?.version;
        contentText = `Plan accepted${version !== undefined ? ` (version ${version})` : ""}. Wait for the user to approve it and start execution.`;
      } else {
        const details = (result.fieldErrors ?? [])
          .map((error) => `${error.path}: ${error.message}`)
          .join("; ");
        contentText = `Plan rejected${details !== "" ? `: ${details}` : ""}.`;
      }
      return {
        content: [textContent(contentText)],
        details: {
          accepted: result.accepted,
          snapshot,
          fieldErrors: result.fieldErrors,
        },
      };
    },
  };
}

/**
 * Create the update_plan_step ToolDefinition bound to the owning controller.
 */
export function createUpdatePlanStepTool(
  host: PlanToolHost,
): ToolDefinition<typeof UpdatePlanStepParamsSchema, UpdatePlanStepToolDetails> {
  return {
    name: UPDATE_PLAN_STEP_TOOL_NAME,
    label: "Update Plan Step",
    description: UPDATE_PLAN_STEP_DESCRIPTION,
    promptSnippet: "Report the execution status of one plan step.",
    parameters: UpdatePlanStepParamsSchema,
    async execute(_toolCallId, params): Promise<AgentToolResult<UpdatePlanStepToolDetails>> {
      const result = await host.controller.updatePlanStep(params);
      const contentText = result.accepted
        ? `Step ${params.stepId} updated to ${params.status}.`
        : `Step update rejected: ${result.reason ?? "invalid transition"}.`;
      return {
        content: [textContent(contentText)],
        details: {
          accepted: result.accepted,
          snapshot: result.snapshot,
          reason: result.reason,
        },
      };
    },
  };
}
