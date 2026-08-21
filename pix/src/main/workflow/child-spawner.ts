/**
 * The workflow child seam for pix (design plan §4.6): the dsh SubagentRuntime
 * adapter. A worker child-start becomes ONE foreground single AgentTask group
 * with workflowExtras (modelOverride + outputSchema), the awaited group
 * outcome is projected onto ChildResult and the registered taskId backs
 * by-taskId cancellation.
 *
 * Locked rules:
 * - agentScope is "user" (same default as the SDK agent tool; "both" would let
 *   project agents shadow builtins and pop authorization).
 * - workflowExtras length must equal tasks.length; a mismatch fails the start
 *   BEFORE createTaskGroup (host input validation, rendered as
 *   child-start-error - not one of the three admission texts).
 * - workflow children must never background: the group is marked workflowOwned
 *   by the service (manual background() refuses), auto-background is disabled,
 *   and dispose/reap cancel by TASK id - never cancelGroup, which is a no-op on
 *   a detached group.
 * - ChildHandle.result rejects ONLY for infrastructure/preflight failures
 *   (child-failed, script sees AGENT_START); an ordinary child failure
 *   (including a queued cancel) resolves with a non-"completed" stopReason
 *   (script side gets null).
 *
 * Main process only: AgentTaskService exists only in the Electron main
 * process, so this module must never run in a worker thread.
 */

import { WorkflowError } from "./engine/engine.js";
import { WORKFLOW_APP_SHUTDOWN_CANCEL_REASON } from "./engine/child-types.js";
import type { ChildHandle, ChildResult, ChildStartRequest } from "./engine/child-types.js";
import type { AgentTaskStopReason } from "../../shared/agent-task-types.js";
import type { WorkflowParentRef } from "./engine/runtime-types.js";
import type { AgentTaskService, WorkflowTaskExtra } from "../agent-task/agent-task-service.js";
import type { SubagentTaskItem } from "../subagent/types.js";
import type { SubagentFailureReason, SubagentSingleResult } from "../../shared/subagent-types.js";

/** The host-side seam a worker run calls into for one `agent()` child. */
export interface WorkflowChildSpawner {
  start(request: ChildStartRequest, parent: WorkflowParentRef, runSignal: AbortSignal): Promise<ChildHandle>;
}

/**
 * Provider -> agent definition mapping (locked): missing and the CC/dsh
 * "spawn" alias resolve to the run default (itself defaulting to
 * "general-purpose"); "fork" is rejected (workflow children are always
 * fresh); any other non-empty trimmed string selects an agent definition by
 * name; empty / whitespace-only is invalid.
 */
export function resolveWorkflowAgentType(
  runDefault: string | undefined,
  optsProvider: string | undefined,
): { agentType: string } | { error: WorkflowError } {
  if (optsProvider === undefined) {
    return { agentType: runDefault ?? "general-purpose" };
  }
  const trimmed = optsProvider.trim();
  if (trimmed === "") {
    return { error: new WorkflowError("workflow agent provider must not be empty", "INVALID_ARGUMENT") };
  }
  if (trimmed === "spawn") {
    return { agentType: runDefault ?? "general-purpose" };
  }
  if (trimmed === "fork") {
    return {
      error: new WorkflowError(
        "workflow agent provider \"fork\" is not supported: workflow children are always fresh agents",
        "UNSUPPORTED_OPTION",
      ),
    };
  }
  return { agentType: trimmed };
}

/** dsh defaultLabel: first line, at most 48 chars (47 + ellipsis beyond). */
function defaultLabel(prompt: string): string {
  const line = prompt.split("\n", 1)[0];
  return line.length <= 48 ? line : `${line.slice(0, 47)}…`;
}

/** Preflight failure reasons that surface as child-failed (AGENT_START). */
const PREFLIGHT_FAILURE_REASONS = new Set<SubagentFailureReason | undefined>([
  "unknown_agent",
  "model_not_found",
  "model_ambiguous",
  "model_auth_unavailable",
  "model_unavailable",
  "prompt_too_large",
  "project_agent_denied",
  "invalid_parameters",
  "session_start_failed",
]);

/**
 * Mapping rule 3 (design plan §4.6): a preflight/infrastructure rejection
 * rejects the handle. `invalid_parameters` after the item actually started
 * (startedAt present) is NOT preflight — that is a schema child that ran
 * but never submitted, and must resolve so the script sees null (§5.3).
 */
function isPreflightRejection(result: SubagentSingleResult | undefined): result is SubagentSingleResult {
  if (result === undefined || result.status === "aborted") {
    return false;
  }
  if (!PREFLIGHT_FAILURE_REASONS.has(result.failureReason)) {
    return false;
  }
  if (result.failureReason === "invalid_parameters" && result.startedAt !== undefined) {
    return false;
  }
  return true;
}

function textOutput(text: string): ChildResult["output"] {
  return [{ type: "text", text }];
}

/**
 * Create the AgentTask-backed child spawner. The service is borrowed, never
 * owned; the spawner keeps no reference to any submission context past
 * createTaskGroup (the parent context is only valid during that call).
 */
export function createAgentTaskChildSpawner(service: AgentTaskService): WorkflowChildSpawner {
  return {
    async start(request: ChildStartRequest, parent: WorkflowParentRef, runSignal: AbortSignal): Promise<ChildHandle> {
      const resolvedAgent = resolveWorkflowAgentType(request.providerDefault, request.provider);
      if ("error" in resolvedAgent) {
        throw resolvedAgent.error;
      }

      // Single-item group by construction; the extras array parallels the
      // tasks array 1:1. A mismatch is host input validation: it fails the
      // start before createTaskGroup (no ChildStarted yet).
      const tasks: SubagentTaskItem[] = [
        {
          prompt: request.prompt,
          description: request.label ?? defaultLabel(request.prompt),
          subagent_type: resolvedAgent.agentType,
        },
      ];
      const extras: WorkflowTaskExtra[] = [{
        modelOverride: request.model,
        outputSchema: request.schema,
        ...(request.maxTurns !== undefined ? { maxTurns: request.maxTurns } : {}),
      }];
      if (extras.length !== tasks.length) {
        throw new WorkflowError(
          `workflow child start failed: workflowExtras length (${extras.length}) does not match tasks length (${tasks.length})`,
          "INVALID_ARGUMENT",
        );
      }

      // createTaskGroup always returns a handle (a preflight-rejected spec
      // becomes an already-terminated failed task), so the host can post
      // child-started right after this resolves.
      const handle = await service.createTaskGroup(
        {
          mode: "single",
          agentScope: "user",
          tasks,
          runInBackground: false,
          workflowExtras: extras,
        },
        parent.getSubmissionContext(),
        "foreground",
        runSignal,
      );
      const task = handle.tasks[0];
      const taskId = task.taskId;
      const generation = task.generation;

      const result = (async (): Promise<ChildResult> => {
        const awaited = await service.awaitGroup(handle.groupId);
        // Mapping by priority (design plan §4.6):
        // 1. backgrounded: never legal for workflow children.
        if (awaited.kind === "backgrounded") {
          throw new WorkflowError("workflow child was detached", "AGENT_START");
        }
        const first = awaited.details.results[0];
        // 3. preflight rejection (incl. an illegal modelOverride): child-failed.
        if (awaited.kind === "failed" && isPreflightRejection(first)) {
          throw new WorkflowError(
            `workflow child failed to start: ${first.errorMessage ?? first.failureReason}`,
            "AGENT_START",
          );
        }
        // 4. child failure / queued cancel: resolve; the script side gets null.
        if (awaited.kind === "failed") {
          return {
            output: textOutput(first?.finalOutput ?? ""),
            stopReason: first?.status === "aborted" ? "cancelled" : "failed",
            ...(first?.failureReason !== undefined ? { failureReason: first.failureReason } : {}),
            ...(first?.errorMessage !== undefined && first.errorMessage.length > 0
              ? { error: first.errorMessage }
              : {}),
          };
        }
        // 5./6. completed: text, or the capture-validated structured object.
        if (request.schema === undefined) {
          return { output: textOutput(first?.finalOutput ?? ""), stopReason: "completed" };
        }
        const structured = first?.structured;
        let serialized: string | undefined;
        try {
          serialized = JSON.stringify(structured);
        } catch {
          serialized = undefined;
        }
        if (serialized === undefined) {
          // Re-parsing + subset-asserting is NOT authoritative; the capture
          // object is the projection source. A projection failure is an
          // infrastructure failure (child-failed).
          throw new WorkflowError("workflow child completed without a serializable structured result", "AGENT_RESULT");
        }
        return { output: textOutput(serialized), structured, stopReason: "completed" };
      })();
      // The mapped outcome must never surface as an unhandled rejection.
      void result.catch(() => {});

      return {
        id: taskId,
        result,
        dispose: async () => {
          try {
            // By-taskId cancel (never cancelGroup: a detached group would make
            // it a no-op). Must not throw. The stop reason maps the shared run
            // signal's abort reason: the engine's disposeAll cancels with
            // WORKFLOW_APP_SHUTDOWN_CANCEL_REASON on whole-app teardown, and
            // that must surface as "app_shutdown" (recovery shows interrupted,
            // consistent with every other shutdown-cancelled task) - anything
            // else is an ordinary user_cancel.
            const stopReason: AgentTaskStopReason =
              runSignal.reason === WORKFLOW_APP_SHUTDOWN_CANCEL_REASON ? "app_shutdown" : "user_cancel";
            await service.cancel(taskId, generation, stopReason);
          } catch {
            // The child may already be terminal; cancellation is best-effort.
          }
        },
      };
    },
  };
}
