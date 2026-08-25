import type { MessageKind, TeammateInfo, TeammateRole, TeamTask, TeamTaskStatus, TeamTaskType } from "../shared/types.js";
import {
  formatInternalNotification,
  INTERNAL_CUSTOM_MESSAGE_TYPES,
} from "../shared/internal-notification.js";
import { parseAgentId } from "./team-utils.js";

export interface OrchestrationEvent {
  type:
    | "task_completed"
    | "task_failed"
    | "task_blocked"
    | "team_message"
    | "task_proposed"
    | "question_asked"
    | "objection_raised"
    | "plan_submitted"
    | "review_requested"
    | "fix_requested";
  taskId?: string;
  taskSubject?: string;
  taskType?: TeamTaskType;
  workerName?: string;
  workerRole?: TeammateRole;
  fromAgentId?: string;
  toAgentId?: string;
  messageKind?: MessageKind;
  messageText?: string;
  result?: string;
  attempts?: number;
  /** Internal source identity used to suppress duplicate wakes. */
  sourceId?: string;
  /** Runtime epoch that produced this event. Stale epochs are never retried. */
  runtimeEpoch?: number;
}

export interface OrchestrationRetryPlan {
  events: OrchestrationEvent[];
  attempts: number;
  delayMs: number;
  circuitOpen: boolean;
}

export const MAX_AUTO_COMPLETION_RESULT_LENGTH = 4_000;
const MAX_ORCHESTRATOR_WAKE_ATTEMPTS = 5;
export const ORCHESTRATOR_WAKE_BASE_RETRY_MS = 500;
const ORCHESTRATOR_WAKE_MAX_RETRY_MS = 10_000;
const ORCHESTRATOR_WAKE_CIRCUIT_BREAK_MS = 30_000;
export const MAX_COORDINATION_GENERATION = 3;

export type TeamResultSignal = "issues" | "passed" | "unknown";

export function planOrchestrationRetry(events: OrchestrationEvent[]): OrchestrationRetryPlan {
  const retriedEvents = events.map((event) => ({
    ...event,
    attempts: (event.attempts ?? 0) + 1,
  }));
  const attempts = retriedEvents.length
    ? Math.max(...retriedEvents.map((event) => event.attempts ?? 0))
    : 0;
  const circuitOpen = attempts >= MAX_ORCHESTRATOR_WAKE_ATTEMPTS;
  const delayMs = circuitOpen
    ? ORCHESTRATOR_WAKE_CIRCUIT_BREAK_MS
    : Math.min(
      ORCHESTRATOR_WAKE_BASE_RETRY_MS * 2 ** Math.max(0, attempts - 1),
      ORCHESTRATOR_WAKE_MAX_RETRY_MS,
    );

  return { events: retriedEvents, attempts, delayMs, circuitOpen };
}

export class OrchestrationEventQueue {
  private readonly _events: OrchestrationEvent[] = [];
  private readonly _eventKeys = new Set<string>();
  private readonly _inFlightKeys = new Set<string>();

  get length(): number {
    return this._events.length;
  }

  get hasPending(): boolean {
    return this._events.length > 0;
  }

  enqueue(event: OrchestrationEvent): boolean {
    const key = orchestrationEventKey(event);
    if (this._eventKeys.has(key)) return false;
    this._events.push({ ...event });
    this._eventKeys.add(key);
    return true;
  }

  takeAll(): OrchestrationEvent[] {
    const events = this._events.map((event) => ({ ...event }));
    this._events.length = 0;
    for (const event of events) this._inFlightKeys.add(orchestrationEventKey(event));
    return events;
  }

  requeueFront(events: OrchestrationEvent[]): void {
    const accepted: OrchestrationEvent[] = [];
    for (const event of events) {
      const key = orchestrationEventKey(event);
      if (this._inFlightKeys.has(key)) {
        this._inFlightKeys.delete(key);
        this._eventKeys.delete(key);
      }
      if (this._eventKeys.has(key)) continue;
      this._eventKeys.add(key);
      accepted.push({ ...event });
    }
    this._events.unshift(...accepted);
  }

  requeueFailed(events: OrchestrationEvent[]): OrchestrationRetryPlan {
    const retry = planOrchestrationRetry(events);
    this.requeueFront(retry.events);
    return retry;
  }

  clear(): void {
    this._events.length = 0;
    this._eventKeys.clear();
    this._inFlightKeys.clear();
  }

  /** Confirm successful processing of an in-flight event batch. */
  ack(events: OrchestrationEvent[]): void {
    for (const event of events) {
      const key = orchestrationEventKey(event);
      this._inFlightKeys.delete(key);
      this._eventKeys.delete(key);
    }
  }

  /**
   * Rewrite the runtime epoch of every pending event to the given value.
   * Used on resume: events enqueued while the runtime was paused (after an
   * abort) carry the pre-pause epoch and would otherwise be dropped as stale
   * by the canRetry guard on their first delivery failure.
   */
  retag(runtimeEpoch: number): void {
    for (let i = 0; i < this._events.length; i++) {
      this._events[i] = { ...this._events[i], runtimeEpoch };
    }
    this._eventKeys.clear();
    for (const event of this._events) this._eventKeys.add(orchestrationEventKey(event));
  }

  snapshot(): OrchestrationEvent[] {
    return this._events.map((event) => ({ ...event }));
  }
}

export interface OrchestrationWakeSession {
  isStreaming: boolean;
  prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<unknown>;
  sendCustomMessage?: (
    message: {
      customType: string;
      content: string;
      display: boolean;
      context?: "internal";
    },
    options?: { triggerTurn?: boolean },
  ) => Promise<unknown>;
}

export interface OrchestrationWakeProcessResult {
  prompted: number;
  retried: boolean;
  deferred: boolean;
  retryDelayMs?: number;
  retryAttempts?: number;
  circuitOpen?: boolean;
}

export async function processOrchestrationWakeQueue(options: {
  queue: OrchestrationEventQueue;
  session: OrchestrationWakeSession | null;
  canProcess: () => boolean;
  buildPrompt: (events: OrchestrationEvent[]) => string;
  scheduleRetry: (delayMs: number) => void;
  canRetry?: (events: OrchestrationEvent[]) => boolean;
  onWakeFailed?: (error: unknown, retry: OrchestrationRetryPlan) => void;
}): Promise<OrchestrationWakeProcessResult> {
  const { queue, session, canProcess, buildPrompt, scheduleRetry, canRetry, onWakeFailed } = options;
  const result: OrchestrationWakeProcessResult = {
    prompted: 0,
    retried: false,
    deferred: false,
  };

  if (!session || !canProcess() || !queue.hasPending) return result;
  if (session.isStreaming) {
    scheduleRetry(ORCHESTRATOR_WAKE_BASE_RETRY_MS);
    return { ...result, deferred: true, retryDelayMs: ORCHESTRATOR_WAKE_BASE_RETRY_MS };
  }

  while (queue.hasPending && session && canProcess()) {
    if (session.isStreaming) {
      scheduleRetry(ORCHESTRATOR_WAKE_BASE_RETRY_MS);
      return { ...result, deferred: true, retryDelayMs: ORCHESTRATOR_WAKE_BASE_RETRY_MS };
    }

    const events = queue.takeAll();
    try {
      const prompt = buildPrompt(events);
      if (session.sendCustomMessage) {
        await session.sendCustomMessage(
          {
            customType: INTERNAL_CUSTOM_MESSAGE_TYPES.TEAM_NOTIFICATION,
            content: formatInternalNotification({
              notificationId: `team-orchestration:${events
                .map((event) => event.sourceId ?? event.taskId ?? event.type)
                .join(",")}`,
              source: "team",
              kind: "orchestration",
              status: "pending",
              requiresAction: true,
              result: prompt,
            }),
            display: false,
            context: "internal",
          },
          { triggerTurn: true },
        );
      } else {
        // Kept for isolated queue tests and non-Pi adapters. Production
        // AgentSession instances always provide sendCustomMessage.
        await session.prompt(prompt, { expandPromptTemplates: false });
      }
      queue.ack(events);
      result.prompted++;
    } catch (error) {
      if (canRetry && !canRetry(events)) {
        queue.ack(events);
        onWakeFailed?.(error, {
          events: [],
          attempts: 0,
          delayMs: 0,
          circuitOpen: true,
        });
        return result;
      }
      const retry = queue.requeueFailed(events);
      onWakeFailed?.(error, retry);
      scheduleRetry(retry.delayMs);
      return {
        ...result,
        retried: true,
        retryDelayMs: retry.delayMs,
        retryAttempts: retry.attempts,
        circuitOpen: retry.circuitOpen,
      };
    }
  }

  return result;
}

export function buildWorkerUnavailableOrchestrationEvents(options: {
  releasedTasks: TeamTask[];
  workerName: string;
  workerRole: TeammateRole;
  reason: string;
}): OrchestrationEvent[] {
  const { releasedTasks, workerName, workerRole, reason } = options;
  return releasedTasks.map((task) => ({
    type: "task_blocked",
    taskId: task.id,
    taskSubject: task.subject,
    taskType: task.taskType,
    workerName,
    workerRole,
    result: `Task was released and is claimable again because ${workerName} became unavailable: ${reason}`,
  }));
}

export interface TeamOrchestrationBrief {
  eventCount: number;
  eventTypes: Record<string, number>;
  focus: string[];
  recommendedActions: string[];
  riskSignals: string[];
  readyTaskCount: number;
  dependencyBlockedTaskCount: number;
  activeWorkerCount: number;
  availableWorkerCount: number;
}

export interface TeamOrchestrationPromptContext {
  allTasks: TeamTask[];
  readyTasks: TeamTask[];
  dependencyBlockedTasks: TeamTask[];
  workers: TeammateInfo[];
  getOpenDependencies?: (task: TeamTask) => string[];
}

export function buildTeamOrchestrationBrief(
  events: OrchestrationEvent[],
  context: TeamOrchestrationPromptContext,
): TeamOrchestrationBrief {
  const eventTypes: Record<string, number> = {};
  const focus = new Set<string>();
  const recommendedActions = new Set<string>();
  const riskSignals = new Set<string>();

  for (const event of events) {
    eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
    if (event.taskSubject) focus.add(`Task: ${event.taskSubject}`);
    if (event.workerName) focus.add(`Worker: ${event.workerName}${event.workerRole ? ` (${event.workerRole})` : ""}`);

    if (event.type === "task_completed") {
      const policy = planTeamCoordination({ taskType: event.taskType, result: event.result });
      recommendedActions.add(policy.leaderInstruction);
      if (policy.needsReview) recommendedActions.add("Create or confirm a reviewer/tester gate for the completed implementation work.");
      if (policy.needsFix) recommendedActions.add("Create a focused fix task for the review/test issues.");
    }

    if (event.type === "task_failed" || event.type === "task_blocked") {
      riskSignals.add(`${event.taskSubject ?? "A task"} is ${event.type === "task_failed" ? "failed" : "blocked"}.`);
      recommendedActions.add("Reassign, split, or create research/planning work before letting the task disappear.");
    }

    if (event.type === "question_asked") {
      recommendedActions.add("Answer the worker question or route it to the teammate best able to unblock it.");
    }
    if (event.type === "objection_raised") {
      riskSignals.add("A teammate raised an objection that may invalidate the current plan.");
      recommendedActions.add("Resolve the objection before continuing dependent work.");
    }
    if (event.type === "plan_submitted") {
      recommendedActions.add("First review the submitted worker plan with respond_to_plan_approval. Approve it only if the scope, files, risks, and verification are credible; otherwise reject it with concrete feedback.");
    }
    if (event.type === "review_requested") {
      recommendedActions.add("Assign a reviewer/tester and include the implementation evidence packet.");
    }
    if (event.type === "fix_requested") {
      recommendedActions.add("Create a focused fix task with the reported issue as scope.");
    }
  }

  const activeWorkerCount = context.workers.filter((worker) => worker.status === "running").length;
  const availableWorkerCount = context.workers.filter((worker) =>
    worker.status === "idle" || worker.status === "standby" || worker.status === "dormant",
  ).length;

  if (context.readyTasks.length > 0 && availableWorkerCount > 0) {
    recommendedActions.add("Assign ready independent tasks so teammates can proceed in parallel.");
  }
  if (context.dependencyBlockedTasks.length > 0) {
    riskSignals.add(`${context.dependencyBlockedTasks.length} task(s) are waiting on dependencies.`);
  }
  if (context.allTasks.some((task) => task.status === "failed" || task.status === "blocked")) {
    riskSignals.add("There are blocked or failed tasks requiring leader triage.");
  }
  if (
    context.allTasks.length > 0 &&
    context.allTasks.every((task) => task.status === "completed" || task.status === "cancelled")
  ) {
    recommendedActions.add("Summarize completed work, verification, decisions, and residual risk to the user.");
  }

  if (recommendedActions.size === 0) {
    recommendedActions.add("Inspect the event batch and decide the smallest useful next coordination step.");
  }

  return {
    eventCount: events.length,
    eventTypes,
    focus: [...focus],
    recommendedActions: [...recommendedActions],
    riskSignals: [...riskSignals],
    readyTaskCount: context.readyTasks.length,
    dependencyBlockedTaskCount: context.dependencyBlockedTasks.length,
    activeWorkerCount,
    availableWorkerCount,
  };
}

export function buildTeamOrchestrationPrompt(events: OrchestrationEvent[], context: TeamOrchestrationPromptContext): string {
  const lines: string[] = ["<orchestrator-event>", ""];
  const brief = buildTeamOrchestrationBrief(events, context);

  for (const event of events) {
    lines.push(`EVENT: ${event.type}`);
    if (event.workerName) {
      lines.push(`Worker: ${event.workerName}${event.workerRole ? ` (role: ${event.workerRole})` : ""}`);
    }
    if (event.taskSubject) {
      lines.push(`Task: "${event.taskSubject}"${event.taskType ? ` [${event.taskType}]` : ""}`);
    }
    if (event.messageKind) {
      const target = event.toAgentId === "*" ? "all" : event.toAgentId;
      lines.push(`Message kind: ${event.messageKind}`);
      lines.push(`Route: ${event.fromAgentId ?? "unknown"} -> ${target ?? "unknown"}`);
    }
    if (event.messageText) lines.push(`Message: ${event.messageText}`);
    if (event.result) lines.push(`Result: ${event.result}`);
    lines.push("");
  }

  lines.push("Coordination brief:");
  lines.push(`- Events: ${brief.eventCount} (${Object.entries(brief.eventTypes).map(([type, count]) => `${type}=${count}`).join(", ") || "none"})`);
  lines.push(`- Workers: active=${brief.activeWorkerCount}, available=${brief.availableWorkerCount}`);
  lines.push(`- Ready tasks: ${brief.readyTaskCount}; dependency-blocked tasks: ${brief.dependencyBlockedTaskCount}`);
  if (brief.focus.length > 0) {
    lines.push("- Focus:");
    for (const item of brief.focus) lines.push(`  - ${item}`);
  }
  if (brief.riskSignals.length > 0) {
    lines.push("- Risk signals:");
    for (const item of brief.riskSignals) lines.push(`  - ${item}`);
  }
  lines.push("- Recommended next actions:");
  for (const item of brief.recommendedActions) lines.push(`  - ${item}`);
  lines.push("");

  if (context.allTasks.length > 0) {
    lines.push("Current tasks:");
    for (const task of context.allTasks) {
      const owner = task.ownerAgentId ? parseAgentId(task.ownerAgentId)?.agentName ?? task.ownerAgentId : "unassigned";
      const openDeps = context.getOpenDependencies?.(task) ?? [];
      const gate = task.gateState && task.gateState.gate !== "none" ? ` gate=${task.gateState.gate}/${task.gateState.status}` : "";
      const evidence = task.evidence ? ` evidence=${task.evidence.changedFiles.length} files, ${task.evidence.verification.length} checks, ${task.evidence.missingScope.length} missing` : "";
      const conflicts = task.fileConflicts?.length ? ` conflicts=${task.fileConflicts.map((conflict) => `${conflict.withSubject}:${conflict.files.join("|")}`).join(";")}` : "";
      lines.push(`- [${task.status}] ${task.subject} (${owner})${task.taskType ? ` [${task.taskType}]` : ""}${gate}${evidence}${conflicts}${openDeps.length ? ` blockedBy=${openDeps.map((id) => id.slice(0, 8)).join(",")}` : ""}`);
    }
    lines.push("");
  }

  if (context.readyTasks.length > 0) {
    lines.push("Ready tasks that can run now:");
    for (const task of context.readyTasks) {
      const owner = task.ownerAgentId ? parseAgentId(task.ownerAgentId)?.agentName ?? task.ownerAgentId : "unassigned";
      lines.push(`- ${task.subject} (${owner})${task.taskType ? ` [${task.taskType}]` : ""}`);
    }
    lines.push("");
  }

  if (context.dependencyBlockedTasks.length > 0) {
    lines.push("Tasks waiting on dependencies:");
    for (const task of context.dependencyBlockedTasks) {
      const openDeps = context.getOpenDependencies?.(task) ?? task.blockedBy;
      lines.push(`- ${task.subject}: waiting for ${openDeps.map((id) => id.slice(0, 8)).join(", ")}`);
    }
    lines.push("");
  }

  lines.push("Workers:");
  for (const worker of context.workers) {
    lines.push(`- ${worker.name} (${worker.role}): ${worker.status}`);
  }
  lines.push("");

  lines.push("ACTION REQUIRED: Decide the smallest useful next coordination step.");
  lines.push("- If this batch contains plan_submitted, handle that first with respond_to_plan_approval. Do not implement, scaffold, or edit files before resolving the pending plan.");
  lines.push("- If independent work remains, create or assign multiple ready tasks so teammates can proceed in parallel.");
  lines.push("- If a worker asked a question, proposed work, raised an objection, or requested review/fix, answer or route it explicitly.");
  lines.push("- If a worker submitted a plan, inspect it as the Leader and use respond_to_plan_approval to approve or reject it; do not ask the user unless the plan needs a product decision.");
  lines.push("- If implementation completed, create review/test/audit tasks unless the task was intentionally trivial.");
  lines.push("- If review/test found issues, create focused fix tasks with dependencies instead of restarting the whole workflow.");
  lines.push("- If all meaningful work and verification are complete, summarize decisions, changes, verification, and residual risk to the user.");
  lines.push("- If blocked, reassign, create a research task, or ask the user for the missing decision.");
  lines.push("</orchestrator-event>");

  return lines.join("\n");
}

export interface TeamCoordinationPolicy {
  signal: TeamResultSignal;
  needsReview: boolean;
  needsFix: boolean;
  leaderInstruction: string;
}

export function normalizeRestoredTeamTasks(tasks: TeamTask[], workerAgentIds: Iterable<string>): TeamTask[] {
  const knownWorkers = new Set(workerAgentIds);
  return tasks.map((task) => {
    const restored: TeamTask = {
      ...task,
      blockedBy: [...task.blockedBy],
      blocks: [...task.blocks],
    };

    if (restored.status === "in_progress") {
      restored.status = "assigned";
    }

    if (restored.status === "assigned" && (!restored.ownerAgentId || !knownWorkers.has(restored.ownerAgentId))) {
      restored.status = "pending";
      restored.result = restored.result ?? "Released during restore because the previous worker is unavailable.";
      delete restored.ownerAgentId;
    }

    return restored;
  });
}

export function planTeamCoordination(
  task: Pick<TeamTask, "taskType"> & { result?: string },
  existing: { hasReviewChild?: boolean; hasFixChild?: boolean } = {},
): TeamCoordinationPolicy {
  const signal = classifyTeamResult(task.result);
  const implementationLike = task.taskType === "implement" || task.taskType === "fix";
  const reviewLike = task.taskType === "review" || task.taskType === "test" || task.taskType === "audit";
  const needsReview = implementationLike && !existing.hasReviewChild;
  const needsFix = reviewLike && signal === "issues" && !existing.hasFixChild;

  const leaderInstruction = needsReview
    ? "Create or wait for an independent review before treating this work as accepted."
    : needsFix
      ? "Create a fix task for the reported issues before accepting this work."
      : signal === "passed"
        ? "No automatic follow-up is required; decide whether the overall user task is ready to summarize."
        : "Inspect the task result and decide the next team action.";

  return { signal, needsReview, needsFix, leaderInstruction };
}

export function classifyTeamResult(result?: string): TeamResultSignal {
  const text = (result ?? "").toLowerCase().replace(/\s+/g, " ");
  if (!text.trim()) return "unknown";

  const evidenceNeutralText = text
    .replace(/\bmissing\s+scope\s*:\s*(?:none|no|n\/a|not applicable|empty|\[\]|nothing)(?:\s+reported)?\b/g, " ")
    .replace(/\brisk(?:s)?\s*:\s*(?:none|no|n\/a|not applicable|empty|\[\]|nothing)(?:\s+reported)?\b/g, " ");
  const noIssues = /\b(?:no|zero|without|none)\s+(?:\w+\s+){0,3}(?:bugs?|issues?|problems?|errors?|failures?|regressions?|risks?|missing\s+scope)\b|\b(?:bugs?|issues?|problems?|errors?|failures?|regressions?|risks?)\s+(?:were\s+|are\s+)?(?:not\s+)?found\b/.test(text);
  const negatedPass = /\b(?:did\s+not|does\s+not|do\s+not|didn't|doesn't|don't|cannot|can't|not)\s+pass(?:ed|es)?\b|\btests?\s+(?:did\s+not|do\s+not|don't|failed|fail)\b/.test(text);
  const negative = negatedPass ||
    /\b(?:fail(?:ed|ure|ing)?|errors?|bugs?|issues?|problems?|incorrect|broken|missing|regression|risks?|fix(?:ed|es|ing)?\s+needed|needs?\s+fix)\b/.test(evidenceNeutralText);
  const positive = noIssues ||
    /\b(?:looks?\s+good|approved|pass(?:ed|es)?|success(?:ful)?|ok|okay|working\s+correctly)\b/.test(text);

  if (negative && !noIssues) return "issues";
  if (positive) return "passed";
  return "unknown";
}

function orchestrationEventKey(event: OrchestrationEvent): string {
  return [
    event.runtimeEpoch ?? 0,
    event.type,
    event.sourceId ?? event.taskId ?? event.fromAgentId ?? "",
    event.messageKind ?? "",
  ].join("|");
}
