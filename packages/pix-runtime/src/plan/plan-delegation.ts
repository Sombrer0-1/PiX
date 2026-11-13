import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { workspaceIdOf } from "../agent-task/agent-task-identity.js";
import type { AgentTaskService } from "../agent-task/agent-task-service.js";
import type { ProjectExecutionContext } from "../execution-context.js";
import type { PlanDeviation, PlanStep } from "../shared/plan-types.js";
import type { SubagentRunner } from "../subagent/subagent-runner.js";
import type { PlanControllerContext, PlanStepExecutionLink, StepDelegateResult } from "./plan-controller.js";
import { detectFileDeviation } from "./plan-deviation.js";

function buildPlanStepPrompt(step: PlanStep, link: PlanStepExecutionLink): string {
  const lines = [
    `<plan_step_execution plan_id="${link.planId}" version="${link.version}" step_id="${link.stepId}">`,
    `Title: ${step.title}`,
    `Description: ${step.description}`,
  ];
  if (step.scopeNote) lines.push(`Scope note: ${step.scopeNote}`);
  if (step.files.length > 0) {
    lines.push(`Declared files (workspace-relative; work only inside this scope): ${step.files
      .map((file) => `${file.path} (${file.operation})`).join(", ")}`);
  }
  if (step.expectedCommands?.length) lines.push(`Expected commands: ${step.expectedCommands.join(" | ")}`);
  lines.push(
    `Verification required: ${step.verification}`,
    `Risk: ${step.risk} - ${step.riskReason}`,
    "Work only within the declared scope. Report what you changed and how it was verified.",
    "</plan_step_execution>",
  );
  return lines.join("\n");
}

export function createPlanDelegation(
  service: AgentTaskService,
  runner: Pick<SubagentRunner, "assembleSubmissionContext">,
  execution: ProjectExecutionContext,
  sessionManager: Pick<SessionManager, "getSessionId">,
  foregroundOnly: boolean,
) {
  const workspaceId = workspaceIdOf(execution.physicalCwd);
  const hasGroup = (groupId: string): boolean => service.hasSessionTaskGroup(groupId, sessionManager.getSessionId(), workspaceId);
  const active = new Map<Promise<StepDelegateResult>, { link: PlanStepExecutionLink; controller: AbortController; taskIds: string[] }>();
  let closed = false;
  async function waitForDelegations(planId?: string, version?: number): Promise<void> {
    const delegations = [...active].filter(([, { link }]) => planId === undefined || (link.planId === planId && link.version === version));
    if (foregroundOnly) {
      for (const [, { controller }] of delegations) controller.abort();
      await service.cancelAndWait(delegations.flatMap(([, { taskIds }]) => taskIds));
    }
    await Promise.allSettled(delegations.map(([pending]) => pending));
  }
  const controllerOptions = {
    delegateSubagentStep(step, link, requestedPresentation) {
      const presentation = foregroundOnly ? "foreground" : requestedPresentation;
      const controller = new AbortController();
      const taskIds: string[] = [];
      const pending = (async (): Promise<StepDelegateResult> => {
        if (closed) return { stepId: step.stepId, status: "failed", summary: "The session is closing." };
        const context = runner.assembleSubmissionContext(`plan-step-${link.planId}-${link.stepId}`);
        const deviations: PlanDeviation[] = [];
        const detection: Promise<void>[] = [];
        const unsubscribe = presentation === "foreground" ? service.onEvent((event) => {
          if (event.type !== "task_file_change" ||
            event.planLink?.planId !== link.planId || event.planLink.version !== link.version || event.planLink.stepId !== link.stepId ||
            !hasGroup(service.get(event.taskId)?.groupId ?? "")) return;
          detection.push(detectFileDeviation(event.change, step, execution).then((deviation) => {
            if (deviation) deviations.push(deviation);
          }).catch(() => {}));
        }) : undefined;
        try {
          const group = await service.createTaskGroup({
            mode: "single",
            agentScope: "user",
            tasks: [{ subagent_type: "general-purpose", prompt: buildPlanStepPrompt(step, link), description: step.title }],
            runInBackground: presentation === "background",
            planLink: link,
          }, context, presentation, foregroundOnly ? controller.signal : undefined);
          taskIds.push(...group.tasks.map((task) => task.taskId));
          if (presentation === "background") {
            return { stepId: step.stepId, status: "backgrounded", groupId: group.groupId, taskIds };
          }
          if (controller.signal.aborted) {
            await service.cancelAndWait(taskIds);
            await service.releasePlanTaskGroup(group.groupId, link, "plan_cancelled");
          }
          const awaited = await service.awaitGroup(group.groupId);
          if (awaited.kind === "backgrounded") {
            return { stepId: step.stepId, status: "backgrounded", groupId: group.groupId, taskIds };
          }
          await Promise.allSettled(detection);
          const result = awaited.details.results[0];
          if (result?.status === "completed") {
            return {
              stepId: step.stepId,
              status: "result",
              summary: result.finalOutput || "The subagent completed without producing text.",
              deviations,
              groupId: group.groupId,
            };
          }
          return {
            stepId: step.stepId,
            status: "failed",
            summary: result?.errorMessage ?? result?.finalOutput ?? "The subagent failed.",
            deviations,
            groupId: group.groupId,
          };
        } finally {
          unsubscribe?.();
          await Promise.allSettled(detection);
        }
      })();
      active.set(pending, { link, controller, taskIds });
      void pending.then(() => active.delete(pending), () => active.delete(pending));
      return pending;
    },
    cancelPlanDelegation: foregroundOnly ? waitForDelegations : undefined,
    subscribePlanLinkedTaskEvents(listener) {
      return service.onEvent((event) => {
        if (event.type !== "task_file_change" || !event.planLink || !hasGroup(service.get(event.taskId)?.groupId ?? "")) return;
        listener({ taskId: event.taskId, ...event.planLink, change: event.change, aggregate: event.aggregate });
      });
    },
    getPlanTaskGroupResult: async (groupId, link) => !foregroundOnly || hasGroup(groupId)
      ? service.getPlanTaskGroupResult(groupId, link)
      : { ok: false, reason: "group_not_found" },
    confirmPlanTaskGroupConsumed: async (groupId, link) => {
      if (!foregroundOnly || hasGroup(groupId)) await service.confirmPlanTaskGroupConsumed(groupId, link);
    },
    releasePlanTaskGroup: async (groupId, link, reason) => {
      if (!foregroundOnly || hasGroup(groupId)) await service.releasePlanTaskGroup(groupId, link, reason);
    },
  } satisfies Pick<PlanControllerContext,
    "delegateSubagentStep" | "cancelPlanDelegation" | "subscribePlanLinkedTaskEvents" | "getPlanTaskGroupResult" |
    "confirmPlanTaskGroupConsumed" | "releasePlanTaskGroup">;
  return {
    controllerOptions,
    async close(): Promise<void> {
      closed = true;
      await waitForDelegations();
    },
  };
}
