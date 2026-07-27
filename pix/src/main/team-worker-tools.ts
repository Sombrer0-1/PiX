import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MessageKind, TeamTaskStatus } from "../shared/types.js";
import { ROLE_SYSTEM_PROMPTS } from "./team-constants.js";
import { mergeTeamTaskEvidence } from "./team-results.js";
import type { TeamToolHost } from "./team-tool-host.js";
import { formatAgentId, parseAgentId } from "./team-utils.js";

/**
 * Register the worker-identity system prompt extension.
 *
 * Appends a <team-worker-identity> block to every worker turn's system prompt.
 * This replaces the old one-shot initial prompt: identity in the system prompt
 * survives context compaction, costs no launch turn, and is present on every
 * turn regardless of how the turn was triggered.
 */
export function registerWorkerIdentityPrompt(host: TeamToolHost, pi: ExtensionAPI, agentId: string): void {
  pi.on("before_agent_start", (event) => {
    const team = host.getTeam();
    const worker = team?.workers.get(agentId);
    if (!team || !worker) return {};

    const identity = [
      "",
      "<team-worker-identity>",
      `You are "${worker.info.name}", the ${worker.info.role} on agent team "${team.name}".`,
      "You work autonomously: each of your turns is triggered by a delivered task assignment or teammate message. Between turns you are idle and simply wait.",
      "",
      ROLE_SYSTEM_PROMPTS[worker.info.role],
      ...(worker.info.specialization ? ["", `Your specialization on this team: ${worker.info.specialization}`] : []),
      "",
      "Team rules:",
      "- Plain assistant text is NOT visible to teammates or the leader. Use send_team_message for any communication.",
      "- A task turn must end by updating the task: call mark_task_complete (with honest evidence: changedFiles, completedScope, missingScope, verification, risks) or update_task_status with blocked/failed and a reason. Never end a task turn silently.",
      "- Use propose_task when you discover work that belongs to another role.",
      "- Report uncertainty instead of claiming completion; a reviewer will compare your evidence with the repository state.",
      "</team-worker-identity>",
      "",
    ].join("\n");

    return { systemPrompt: event.systemPrompt + "\n" + identity };
  });
}

/**
 * Register the send_team_message tool for a worker agent.
 * Called during _launchWorker as an extension factory.
 */
export function registerTeamMessagingTool(host: TeamToolHost, pi: ExtensionAPI, agentId: string): void {
  const team = host.getTeam();
  if (!team) return;

  const SEND_MSG_PARAMS = Type.Object({
    to: Type.String({
      description: 'Agent name to send to (e.g. "coder", "reviewer", "planner"), or "*" to broadcast to all teammates.',
    }),
    text: Type.String({
      description: "The message content.",
    }),
    summary: Type.Optional(Type.String({
      description: "Short one-line summary for the timeline UI.",
    })),
    kind: Type.Optional(Type.Union([
      Type.Literal("peer_message"),
      Type.Literal("broadcast"),
      Type.Literal("task_message"),
      Type.Literal("question"),
      Type.Literal("answer"),
      Type.Literal("proposal"),
      Type.Literal("objection"),
      Type.Literal("decision"),
      Type.Literal("handoff"),
      Type.Literal("review_request"),
      Type.Literal("fix_request"),
      Type.Literal("task_result"),
      Type.Literal("blocked"),
    ], {
      description: "Message priority kind. Defaults to peer_message for direct, broadcast for broadcasts.",
    })),
  });

  pi.registerTool({
    name: "send_team_message",
    label: "Send team message",
    description:
      "Send a message to another teammate or broadcast to the whole team. " +
      "Use this to communicate findings, request help, share results, or coordinate work with teammates.",
    promptSnippet: "Use send_team_message to communicate with other agents on your team.",
    promptGuidelines: [
      "Use send_team_message to share findings, ask questions, or coordinate with teammates.",
      'Use to="*" to broadcast to all teammates.',
      "Keep messages concise and actionable.",
    ],
    parameters: SEND_MSG_PARAMS,
    executionMode: "parallel" as const,
    execute: async (_toolCallId: string, params: { to: string; text: string; summary?: string; kind?: string }) => {
      // Resolve "to" short name to full agentId
      let toAgentId: string;
      if (params.to === "*") {
        toAgentId = "*";
      } else {
        toAgentId = formatAgentId(params.to, team.name);
        // Validate target exists
        if (!team.workers.has(toAgentId)) {
          const available = Array.from(team.workers.keys())
            .map((id) => parseAgentId(id)?.agentName ?? id)
            .join(", ");
          return {
            content: [{ type: "text" as const, text: `Error: Agent "${params.to}" not found in team. Available agents: ${available}` }],
            details: { from: agentId, to: toAgentId, kind: "peer_message" as const },
          };
        }
      }

      const kind = params.kind as MessageKind | undefined;
      await host.sendTeamMessage(agentId, toAgentId, params.text, params.summary, kind);

      const target = toAgentId === "*" ? "all teammates" : params.to;
      const resolvedKind = kind ?? (toAgentId === "*" ? "broadcast" : "peer_message");
      return {
        content: [{ type: "text" as const, text: `Message sent to ${target}: "${params.text.slice(0, 100)}${params.text.length > 100 ? "..." : ""}"` }],
        details: { from: agentId, to: toAgentId, kind: resolvedKind },
      };
    },
  });
}

/**
 * Register task management tools for a worker agent.
 * Provides mark_task_complete and update_task_status so workers can
 * report task progress.
 */
export function registerTeamTaskTool(host: TeamToolHost, pi: ExtensionAPI, agentId: string): void {
  const team = host.getTeam();
  if (!team) return;

  // mark_task_complete marks the worker's current task as completed.
  const MARK_COMPLETE_PARAMS = Type.Object({
    result: Type.String({
      description: "A brief summary of what was accomplished or the outcome of the task.",
    }),
    changedFiles: Type.Optional(Type.Array(Type.String(), {
      description: "Files or important paths changed by this task.",
    })),
    completedScope: Type.Optional(Type.Array(Type.String(), {
      description: "Scope items that are complete.",
    })),
    missingScope: Type.Optional(Type.Array(Type.String(), {
      description: "Scope items not completed, uncertain, or intentionally deferred.",
    })),
    verification: Type.Optional(Type.Array(Type.String(), {
      description: "Verification performed, including commands, tests, or manual checks.",
    })),
    risks: Type.Optional(Type.Array(Type.String(), {
      description: "Known risks, assumptions, or fragile areas.",
    })),
    followUps: Type.Optional(Type.Array(Type.String(), {
      description: "Suggested follow-up work.",
    })),
    confidence: Type.Optional(Type.Union([
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
    ], {
      description: "Your confidence that the task is complete.",
    })),
  });

  pi.registerTool({
    name: "mark_task_complete",
    label: "Mark task complete",
    description:
      "Mark your current assigned task as completed. " +
      "Provide a result summary describing what was accomplished.",
    promptSnippet: "Use mark_task_complete when you finish your assigned task.",
    promptGuidelines: [
      "Call mark_task_complete after finishing your assigned task.",
      "Provide a clear result summary and fill the evidence fields honestly.",
      "Use missingScope and risks when any part of the assigned scope is incomplete or uncertain.",
    ],
    parameters: MARK_COMPLETE_PARAMS,
    executionMode: "parallel" as const,
    execute: async (_toolCallId: string, params: {
      result: string;
      changedFiles?: string[];
      completedScope?: string[];
      missingScope?: string[];
      verification?: string[];
      risks?: string[];
      followUps?: string[];
      confidence?: "low" | "medium" | "high";
    }) => {
      // Find the task owned by this agent
      const tasks = team.taskList.getAll("in_progress");
      const myTask = tasks.find((t) => t.ownerAgentId === agentId);

      if (!myTask) {
        return {
          content: [{ type: "text" as const, text: "No in-progress task found assigned to you." }],
          details: { taskId: "none", status: "completed" as const },
        };
      }

      const evidence = mergeTeamTaskEvidence(params.result, {
        changedFiles: params.changedFiles,
        completedScope: params.completedScope,
        missingScope: params.missingScope,
        verification: params.verification,
        risks: params.risks,
        followUps: params.followUps,
        confidence: params.confidence,
      });
      const handoff = host.createTaskHandoff(myTask, agentId, params.result, evidence);
      const completedTask = host.updateTask(myTask.id, {
        status: "completed",
        result: params.result,
        evidence,
        handoff,
        gateState: host.completionGateState(myTask, params.result),
      });
      // Emit worker summary for renderer UI.
      const workerInfo = team.workers.get(agentId)?.info;
      const workerName = workerInfo?.name ?? parseAgentId(agentId)?.agentName ?? agentId;
      const workerRole = workerInfo?.role ?? "coder";
      host.emitWorkerCompletionSummary(agentId, completedTask, workerName, workerRole, params.result);
      host.coordinateAfterTaskCompletion(completedTask, agentId, params.result);

      return {
        content: [{ type: "text" as const, text: `Task "${myTask.subject}" marked as completed.` }],
        details: { taskId: myTask.id, status: "completed" as const },
      };
    },
  });

  // update_task_status allows workers to report partial progress or failure.
  const UPDATE_STATUS_PARAMS = Type.Object({
    status: Type.Union([
      Type.Literal("in_progress"),
      Type.Literal("blocked"),
      Type.Literal("failed"),
    ], {
      description: "New status for your current task.",
    }),
    result: Type.Optional(Type.String({
      description: "Updated result or reason for the status change (e.g. failure reason, blocking dependency).",
    })),
  });

  pi.registerTool({
    name: "update_task_status",
    label: "Update task status",
    description:
      "Update the status of your current assigned task. " +
      "Use this to report blocking issues or failures.",
    promptSnippet: "Use update_task_status to report task progress or blocking issues.",
    promptGuidelines: [
      "Use update_task_status if you cannot complete a task (blocked or failed).",
      "Provide a clear reason when marking a task as blocked or failed.",
    ],
    parameters: UPDATE_STATUS_PARAMS,
    executionMode: "parallel" as const,
    execute: async (_toolCallId: string, params: { status: string; result?: string }) => {
      const tasks = team.taskList.getAll("in_progress");
      const myTask = tasks.find((t) => t.ownerAgentId === agentId);

      if (!myTask) {
        return {
          content: [{ type: "text" as const, text: "No in-progress task found assigned to you." }],
          details: { taskId: "none", status: "blocked" as const },
        };
      }

      const newStatus = params.status as TeamTaskStatus;
      host.updateTask(myTask.id, { status: newStatus, result: params.result });

      // Wake LeaderOrchestrator on failed/blocked so Leader can decide next step
      if (newStatus === "failed" || newStatus === "blocked") {
        const workerInfo = team.workers.get(agentId)?.info;
        host.wakeLeaderForOrchestration({
          type: newStatus === "failed" ? "task_failed" : "task_blocked",
          taskId: myTask.id,
          taskSubject: myTask.subject,
          taskType: myTask.taskType,
          workerName: workerInfo?.name ?? parseAgentId(agentId)?.agentName ?? agentId,
          workerRole: workerInfo?.role ?? "coder",
          result: params.result,
        });
      }

      return {
        content: [{ type: "text" as const, text: `Task "${myTask.subject}" status updated to ${newStatus}.` }],
        details: { taskId: myTask.id, status: newStatus },
      };
    },
  });

  // list_team_tasks gives workers read-only visibility into the shared task
  // graph (mirrors Claude Code's TaskList tool for teammates): coordination
  // awareness without granting task-creation authority.
  pi.registerTool({
    name: "list_team_tasks",
    label: "List team tasks",
    description:
      "List the team's shared task list: status, owner, type, and dependencies of every task. " +
      "Use this to understand what the team is working on before coordinating or proposing work.",
    promptSnippet: "Use list_team_tasks to see the team's current task graph.",
    promptGuidelines: [
      "Check list_team_tasks before proposing work that may already be planned or owned.",
      "Use it to see which tasks block yours and who owns them.",
    ],
    parameters: Type.Object({}),
    executionMode: "parallel" as const,
    execute: async () => {
      const t = host.getTeam();
      if (!t) {
        return {
          content: [{ type: "text" as const, text: "No active team." }],
          details: { taskCount: 0 },
        };
      }
      const tasks = t.taskList.getAll();
      if (tasks.length === 0) {
        return {
          content: [{ type: "text" as const, text: "The team task list is empty." }],
          details: { taskCount: 0 },
        };
      }
      const lines = tasks.map((task) => {
        const owner = task.ownerAgentId ? parseAgentId(task.ownerAgentId)?.agentName ?? task.ownerAgentId : "unassigned";
        const deps = task.blockedBy.length ? ` blockedBy=${task.blockedBy.map((id) => id.slice(0, 8)).join(",")}` : "";
        return `- [${task.status}] ${task.subject} (${task.id.slice(0, 8)}) [${task.taskType ?? "general"}] -> ${owner}${deps}`;
      });
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { taskCount: tasks.length },
      };
    },
  });

  // propose_task lets workers propose a new task for the leader to create.
  const PROPOSE_TASK_PARAMS = Type.Object({
    subject: Type.String({
      description: "Short task title.",
    }),
    description: Type.String({
      description: "Detailed task description.",
    }),
    taskType: Type.Optional(Type.Union([
      Type.Literal("research"),
      Type.Literal("plan"),
      Type.Literal("implement"),
      Type.Literal("fix"),
      Type.Literal("review"),
      Type.Literal("test"),
      Type.Literal("summarize"),
      Type.Literal("audit"),
    ], { description: "Suggested task type for role-based assignment." })),
    assignToRole: Type.Optional(Type.Union([
      Type.Literal("planner"),
      Type.Literal("coder"),
      Type.Literal("reviewer"),
      Type.Literal("tester"),
      Type.Literal("researcher"),
    ], { description: "Suggested role to assign this task to." })),
  });

  const workerInfo = team.workers.get(agentId)?.info;
  const proposeWorkerName = workerInfo?.name ?? parseAgentId(agentId)?.agentName ?? agentId;
  const proposeWorkerRole = workerInfo?.role ?? "coder";

  pi.registerTool({
    name: "propose_task",
    label: "Propose task",
    description:
      "Propose a new task for the team leader to create. " +
      "Use this when you identify work that needs to be done by another teammate. " +
      "The leader will review your proposal and decide whether to create the task.",
    promptSnippet: "Use propose_task to suggest work for other teammates.",
    promptGuidelines: [
      "Use propose_task when you identify work that another teammate should handle.",
      "Provide a clear subject and description.",
      "Suggest a taskType and assignToRole if appropriate.",
    ],
    parameters: PROPOSE_TASK_PARAMS,
    executionMode: "parallel" as const,
    execute: async (_toolCallId: string, params: {
      subject: string;
      description: string;
      taskType?: string;
      assignToRole?: string;
    }) => {
      const proposal = [
        `<task-proposal from="${proposeWorkerName}" role="${proposeWorkerRole}">`,
        `Subject: ${params.subject}`,
        `Description: ${params.description}`,
        params.taskType ? `Type: ${params.taskType}` : "",
        params.assignToRole ? `Suggested role: ${params.assignToRole}` : "",
        `</task-proposal>`,
      ].filter(Boolean).join("\n");

      await host.sendTeamMessage(agentId, team.leadAgentId, proposal, `Task proposal: ${params.subject}`, "proposal");

      return {
        content: [{ type: "text" as const, text: `Task proposal sent to leader: "${params.subject}"` }],
        details: { subject: params.subject, taskType: params.taskType, assignToRole: params.assignToRole },
      };
    },
  });
}

/**
 * Register protocol tools for a worker agent.
 * Provides request_permission and, for implementers, submit_plan so workers
 * can request approval through the team protocol.
 */
export function registerTeamProtocolTool(host: TeamToolHost, pi: ExtensionAPI, agentId: string): void {
  const team = host.getTeam();
  if (!team) return;

  const worker = team.workers.get(agentId);
  const role = worker?.info.role ?? "coder";

  // request_permission asks for approval of a restricted operation.
  const REQUEST_PERM_PARAMS = Type.Object({
    tool: Type.String({
      description: "The name of the tool you want to use (e.g. 'Edit', 'Write', 'Bash').",
    }),
    reason: Type.String({
      description: "Why you need to use this tool. Explain what you're trying to accomplish.",
    }),
  });

  pi.registerTool({
    name: "request_permission",
    label: "Request permission",
    description:
      "Request user approval before using a restricted tool. " +
      "Use this when you need to perform an operation that may require elevated permissions.",
    promptSnippet: "Use request_permission to ask for approval before restricted operations.",
    promptGuidelines: [
      "Use request_permission before attempting restricted operations.",
      "Provide a clear reason explaining what you need to do.",
      "Wait for the response before proceeding.",
    ],
    parameters: REQUEST_PERM_PARAMS,
    executionMode: "parallel" as const,
    execute: async (_toolCallId: string, params: { tool: string; reason: string }, signal?: AbortSignal) => {
      // Check role permissions first
      if (!team.protocolManager.isToolAllowed(role, params.tool)) {
        return {
          content: [{
            type: "text" as const,
            text: `Permission denied: role "${role}" is not allowed to use "${params.tool}". Allowed tools: ${team.protocolManager.getRolePermissions(role).allowedTools.join(", ")}`,
          }],
          details: { tool: params.tool, approved: false, reason: "Role restriction" },
        };
      }

      // Create permission request and wait for user response (with timeout + abort)
      const result = await host.requestPermission(agentId, params.tool, { reason: params.reason }, signal);

      return {
        content: [{
          type: "text" as const,
          text: result.approved
            ? `Permission approved for ${params.tool}.${result.reason ? ` Note: ${result.reason}` : ""}`
            : `Permission rejected for ${params.tool}.${result.reason ? ` Reason: ${result.reason}` : ""}`,
        }],
        details: { tool: params.tool, approved: result.approved, reason: result.reason },
      };
    },
  });

  // respond_to_shutdown: the worker LLM decides whether to accept a graceful
  // shutdown (mirrors Claude Code's negotiated shutdown, where the request is
  // passed to the model instead of being auto-confirmed by the runtime).
  const RESPOND_SHUTDOWN_PARAMS = Type.Object({
    approve: Type.Boolean({
      description: "true to accept the shutdown, false to reject it and keep working.",
    }),
    reason: Type.Optional(Type.String({
      description: "Why you accept or reject (e.g. unfinished critical work).",
    })),
  });

  pi.registerTool({
    name: "respond_to_shutdown",
    label: "Respond to shutdown request",
    description:
      "Respond to a pending shutdown request from the team leader. " +
      "Approve when your work is complete or safely handed off; reject with a reason when critical work would be lost.",
    promptSnippet: "Use respond_to_shutdown to accept or reject a shutdown request.",
    promptGuidelines: [
      "Approve shutdown when you have no unfinished critical work.",
      "Reject with a concrete reason if shutting down now would lose work; then finish or hand off quickly.",
    ],
    parameters: RESPOND_SHUTDOWN_PARAMS,
    executionMode: "parallel" as const,
    execute: async (_toolCallId: string, params: { approve: boolean; reason?: string }) => {
      const accepted = host.respondShutdown(agentId, params.approve, params.reason);
      if (!accepted) {
        return {
          content: [{
            type: "text" as const,
            text: "No pending shutdown request found (it may have timed out or been cancelled). Continue working normally.",
          }],
          details: { approve: params.approve, reason: params.reason, accepted: false },
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: params.approve
            ? "Shutdown approved. This session will be terminated shortly; do not start new work."
            : `Shutdown rejected${params.reason ? `: ${params.reason}` : ""}. Finish or hand off the blocking work, then expect another shutdown request.`,
        }],
        details: { approve: params.approve, reason: params.reason, accepted: true },
      };
    },
  });

  if (role !== "coder") {
    return;
  }

  // submit_plan asks the Leader to approve a coder's implementation plan before execution.
  const SUBMIT_PLAN_PARAMS = Type.Object({
    plan: Type.String({
      description: "The plan you want to execute. Describe what changes you'll make.",
    }),
    files: Type.Array(Type.String(), {
      description: "List of files you plan to modify.",
    }),
  });

  pi.registerTool({
    name: "submit_plan",
    label: "Submit plan",
    description:
      "Submit a coder implementation plan for Leader approval before making code changes. " +
      "Use this before executing high-risk or complex implementation operations.",
    promptSnippet: "Use submit_plan to get Leader approval before making significant changes.",
    promptGuidelines: [
      "Use submit_plan before making significant code changes.",
      "Describe your plan clearly and list all files you'll modify.",
      "Wait for approval before proceeding with the changes.",
    ],
    parameters: SUBMIT_PLAN_PARAMS,
    executionMode: "parallel" as const,
    execute: async (_toolCallId: string, params: { plan: string; files: string[] }, signal?: AbortSignal) => {
      const result = await host.requestPlanApproval(agentId, params.plan, params.files, signal);

      return {
        content: [{
          type: "text" as const,
          text: result.approved
            ? `Plan approved.${result.feedback ? ` Feedback: ${result.feedback}` : ""} Proceed with execution.`
            : `Plan not approved.${result.feedback ? ` Feedback: ${result.feedback}` : ""} Stop this turn, do not make code changes, and report blocked status to the Leader.`,
        }],
        details: { approved: result.approved, feedback: result.feedback },
      };
    },
  });
}
