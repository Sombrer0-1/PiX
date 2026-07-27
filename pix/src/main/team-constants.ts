import type { MessageKind, RolePermissionPolicy, TeammateRole, TeamTaskType, WorkerConfig } from "../shared/types.js";

/** Maximum number of messages to keep in a worker's history (main process). */
export const MAX_MESSAGE_HISTORY = 200;

/** Default team roster. Only the coder starts immediately; other roles are capabilities brought in by need. */
export const DEFAULT_WORKER_CONFIGS: WorkerConfig[] = [
  { role: "coder", mode: "core", activationPolicy: "always" },
  { role: "planner", mode: "on_demand", activationPolicy: "when_needed" },
  { role: "reviewer", mode: "on_demand", activationPolicy: "when_needed" },
  { role: "tester", mode: "on_demand", activationPolicy: "when_needed" },
  { role: "researcher", mode: "on_demand", activationPolicy: "when_needed" },
];

/** Agent name prefix for the team leader. */
export const LEADER_AGENT_NAME = "team-lead";

/** Polling interval (ms) when worker is idle, waiting for new messages. */
export const IDLE_POLL_INTERVAL_MS = 500;

/** Safety timeout for a worker turn with no observable activity. */
export const WORKER_STUCK_TURN_TIMEOUT_MS = 30 * 60_000;

/**
 * Absolute ceiling for a single worker turn, regardless of activity.
 * Inactivity-based recovery is handled by the health check
 * (WORKER_STUCK_TURN_TIMEOUT_MS); this only guards against a turn that keeps
 * producing events forever (e.g. a tool-call loop). Long legitimate
 * implementation turns must fit comfortably under it.
 */
export const WORKER_TURN_HARD_TIMEOUT_MS = 2 * 60 * 60_000;

/**
 * Safety timeout for a Leader orchestration turn. If the SDK never emits the
 * matching agent_end (turn swallowed / errored without an end event), this
 * forces _leaderTurnActive back to false so queued orchestration events are not
 * stranded forever behind the "leader turn active" guard.
 */
export const LEADER_STUCK_TURN_TIMEOUT_MS = 30 * 60_000;

/**
 * Minimum interval between orchestration stall-recovery nudges. The health
 * check inspects the team every 30s; if the leader is idle while runnable work
 * is stranded (no worker executing it), it nudges the leader. This throttle
 * keeps a genuinely-waiting-on-user leader from being re-prompted every cycle.
 */
export const ORCHESTRATION_STALL_RECOVERY_INTERVAL_MS = 3 * 60_000;

/** Which task types each role is capable of handling. */
export const ROLE_TASK_CAPABILITIES: Record<TeammateRole, TeamTaskType[]> = {
  planner: ["research", "plan", "summarize"],
  coder: ["implement", "fix", "test"],
  reviewer: ["review", "test", "audit"],
  tester: ["test", "audit"],
  researcher: ["research", "plan", "audit"],
};

/**
 * Role-specific system prompt bodies, injected into every worker turn via the
 * worker-identity extension (before_agent_start). Living in the system prompt —
 * rather than a one-shot initial user message — keeps the role identity intact
 * across context compaction and avoids burning an LLM turn at worker launch.
 */
export const ROLE_SYSTEM_PROMPTS: Record<TeammateRole, string> = {
	planner:
		"Your role: **planner**. When assigned a task, analyze it, break it into steps, create execution plans, " +
		"and communicate your findings clearly. " +
		"Use read-only tools (glob, grep, read) to understand the codebase before planning. " +
		"Ask questions, raise objections, and propose follow-up tasks when the plan needs team discussion. " +
		"Deliver planning tasks with mark_task_complete and send_team_message; do not request execution approval for a planning deliverable.",
	coder:
		"Your role: **coder**. When assigned a task, implement code changes based on the assigned scope and any plans from the planner. " +
		"You have access to edit, write, bash, and other tools. " +
		"Ask clarifying questions, send handoffs, and request review or fixes through send_team_message when needed.",
	reviewer:
		"Your role: **reviewer**. When assigned a task or given code to review, " +
		"examine files for correctness, style issues, potential bugs, and security concerns. " +
		"Start by auditing the worker's evidence ledger against the assigned scope and repository state, " +
		"especially for missing modules, unwired files, placeholder code, and unsupported completion claims. " +
		"Provide actionable feedback with specific file paths and line numbers. " +
		"Send review_request, fix_request, objection, or decision messages when the team needs to act on findings.",
	tester:
		"Your role: **tester**. When assigned a task, run or design verification, " +
		"inspect failures, and report reproducible results. Do NOT modify source code unless explicitly asked. " +
		"Send blocked, objection, or fix_request messages when verification uncovers work for another teammate.",
	researcher:
		"Your role: **researcher**. When assigned a task, investigate the codebase, " +
		"collect facts, identify constraints, and report concise findings for the team. " +
		"Ask questions and raise objections when facts contradict the current direction. " +
		"Deliver research/plan tasks with mark_task_complete and send_team_message; do not request execution approval for a research deliverable.",
};

/**
 * Protocol message kinds intercepted by the WorkerRunner and never delivered
 * to the LLM context. Note that "shutdown" is NOT here: shutdown requests are
 * delivered to the worker model as a decision turn (respond_to_shutdown), so
 * the model can accept or reject with a reason.
 */
export const PROTOCOL_MESSAGE_KINDS = new Set<MessageKind>([
  "shutdown_response",
  "permission_request",
  "permission_response",
  "plan_approval",
]);

/** Role-based permission policies. Tool names must match SDK built-in names (lowercase). */
export const ROLE_PERMISSIONS: Record<TeammateRole, RolePermissionPolicy> = {
  planner: {
    allowedTools: [
      "read", "grep", "ls", "find",
      "send_team_message", "mark_task_complete", "update_task_status",
      "request_permission", "propose_task",
    ],
    deniedTools: ["edit", "write", "bash"],
  },
  coder: {
    allowedTools: [
      "read", "grep", "ls", "find",
      "edit", "write", "bash",
      "send_team_message", "mark_task_complete", "update_task_status",
      "submit_plan", "request_permission", "propose_task",
    ],
    deniedTools: [],
  },
  reviewer: {
    allowedTools: [
      "read", "grep", "ls", "find",
      "bash", // for running tests
      "send_team_message", "mark_task_complete", "update_task_status",
      "request_permission", "propose_task",
    ],
    deniedTools: ["edit", "write"],
  },
  tester: {
    allowedTools: [
      "read", "grep", "ls", "find", "bash",
      "send_team_message", "mark_task_complete", "update_task_status",
      "request_permission", "propose_task",
    ],
    deniedTools: ["edit", "write"],
  },
  researcher: {
    allowedTools: [
      "read", "grep", "ls", "find",
      "send_team_message", "mark_task_complete", "update_task_status",
      "request_permission", "propose_task",
    ],
    deniedTools: ["edit", "write", "bash"],
  },
};

/**
 * Timeout (ms) for graceful shutdown negotiation. The shutdown request is
 * delivered to the worker LLM as a decision turn (the model calls
 * respond_to_shutdown), so the window must cover a full model turn.
 */
export const SHUTDOWN_TIMEOUT_MS = 120_000;

/**
 * Timeout (ms) for plan approvals and permission requests. Plan approvals wait
 * on the Leader LLM (which may be mid-turn with a queue); permission requests
 * wait on a human who may have stepped away. Two minutes proved far too tight —
 * a timeout rejects the request and typically wastes the worker's whole task,
 * so give both a generous window. A worker blocked on a request produces no
 * session events, so the health check's inactivity abort still bounds the
 * worst case.
 */
export const PROTOCOL_TIMEOUT_MS = 600_000;
