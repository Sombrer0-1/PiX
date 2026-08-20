/**
 * Solo-mode subagent runner facade (design plan §4.5/§4.6, PiX 1.4.1).
 *
 * One parent session owns exactly one `SubagentRunner`. Since 1.4.1 the runner
 * is a thin service facade: it no longer owns a FIFO semaphore, nested
 * sessions or an execution backend. `run()` keeps the legacy compatible
 * signature (params, signal, onProgress, onFileChange + optional options) and
 * synchronously assembles an `AgentTaskSubmissionContext` (parent session id,
 * tool call id, project, borrowed registry snapshot, parent runtime value
 * snapshot, requestUserInput and the host-disposed promise), then delegates to
 * the app-level `AgentTaskService`:
 *
 * - Direct background (run_in_background=true): createTaskGroup returns the
 *   group handle; nothing is awaited.
 * - Foreground: the facade subscribes to the group's service events within its
 *   own run scope, rebuilds throttled immutable `SubagentDetails` progress
 *   snapshots in the original mode/order, temporarily listens to the parent
 *   AbortSignal (cancelGroup(user_cancel); the listener is removed the moment
 *   the group detaches), awaits `awaitGroup`, writes the aggregated usage into
 *   the parent generation's auxiliary accumulator exactly once and returns the
 *   details (cancelled maps to the legacy aborted result semantics). A
 *   detached/backgrounded group resolves the run with the group handle instead.
 *
 * Every abandoned phase promise keeps a resolve/reject observer, so a late
 * rejection can never become an unhandled rejection.
 */

import { randomUUID } from "node:crypto";
import {
  SUBAGENT_MAX_ACTIVITY_SUMMARY_CHARS,
  SUBAGENT_MAX_DESCRIPTION_CHARS,
  SUBAGENT_MAX_ERROR_MESSAGE_BYTES,
  SUBAGENT_MAX_FINAL_OUTPUT_BYTES,
  SUBAGENT_MAX_RECENT_ACTIVITIES,
  SUBAGENT_MAX_RESULTS,
  aggregateSubagentUsage,
  type SubagentActivity,
  type SubagentDetails,
  type SubagentFailureReason,
  type SubagentSingleResult,
  type SubagentUsage,
} from "../../shared/subagent-types.js";
import type { FileChangeSummary, TurnDiffSummary } from "@earendil-works/pi-coding-agent";
import type { AgentTaskGroupHandle, AgentTaskInfo } from "../../shared/agent-task-types.js";
import type { AgentTaskService, AgentTaskSubmissionContext } from "../agent-task/agent-task-service.js";
import type {
  SubagentExecutionContext,
  SubagentProgressEvent,
  SubagentRunParams,
  SubagentTaskItem,
} from "./types.js";

// Serialization aliases come from shared; no second source of truth for these
// numbers. The execution constants are retained as exports for compatibility;
// the facade itself holds no FIFO/session/backend machinery.
export const MAX_PARALLEL_TASKS = SUBAGENT_MAX_RESULTS;
export const MAX_ACTIVE_SUBAGENTS = 4;
export const DEFAULT_MAX_TURNS = 50;
export const MAX_AGENT_TURNS = DEFAULT_MAX_TURNS;
export const NESTED_STARTUP_TIMEOUT_MS = 30_000;
export const ABORT_TIMEOUT_MS = 5_000;
export const NESTED_CLEANUP_TIMEOUT_MS = 2_000;
export const MAX_DELEGATED_PROMPT_BYTES = 64 * 1024;
export const MAX_TASK_OUTPUT_BYTES = SUBAGENT_MAX_FINAL_OUTPUT_BYTES;
export const MAX_TOOL_CONTENT_BYTES = 128 * 1024;
export const MAX_RECENT_ACTIVITIES = SUBAGENT_MAX_RECENT_ACTIVITIES;
export const MAX_ACTIVITY_SUMMARY_CHARS = SUBAGENT_MAX_ACTIVITY_SUMMARY_CHARS;
export const MAX_ERROR_MESSAGE_BYTES = SUBAGENT_MAX_ERROR_MESSAGE_BYTES;

/**
 * Shell background tools (PiX 1.4.1): the parent SessionBridge and every WSL
 * AgentTaskRuntime nested session must add these to their effective denylist;
 * explicit agent tool references fail as tool_unavailable and the all-tools
 * activation path can never re-add them. Windows runtimes keep them available.
 */
export const SHELL_BACKGROUND_TOOLS: readonly string[] = ["run_background", "read_output", "stop_process"];

const TEXT_UPDATE_THROTTLE_MS = 100;

/** Optional run options (1.4.1); the legacy four-argument call stays unchanged. */
export interface SubagentRunOptions {
  /** Parent tool call id of the submitting tool call (agent tool); synthetic when absent. */
  parentToolCallId?: string;
  /** Direct background request (run_in_background=true); the run resolves with the group handle. */
  runInBackground?: boolean;
}

/** Mutable per-run bookkeeping that feeds the immutable details snapshots. */
interface RunState {
  details: SubagentDetails;
  startedAt: number;
  emitProgress: (force: boolean) => void;
  onFileChange?: (event: { change: FileChangeSummary; aggregate: TurnDiffSummary }) => void;
  /**
   * True once the group detached (auto/manual background): the run resolves
   * with the group handle and stops rebuilding progress.
   */
  groupTaskIds: string[];
}

function emptyUsage(): SubagentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 };
}

/** Single-line, bounded result description (same rule as the tool/schema). */
function describeTask(task: SubagentTaskItem): string {
  const description = typeof task.description === "string" ? task.description : "";
  if (description.trim() !== "") {
    return description.slice(0, SUBAGENT_MAX_DESCRIPTION_CHARS);
  }
  const prompt = typeof task.prompt === "string" ? task.prompt : "";
  for (const rawLine of prompt.split("\n")) {
    const line = rawLine.trim();
    if (line !== "") {
      const singleLine = line.replace(/\s+/g, " ").trim();
      return singleLine.length > SUBAGENT_MAX_DESCRIPTION_CHARS
        ? `${singleLine.slice(0, SUBAGENT_MAX_DESCRIPTION_CHARS - 3)}...`
        : singleLine;
    }
  }
  return "";
}

export class SubagentRunner {
  private readonly _ctx: SubagentExecutionContext;
  private _disposed = false;
  private _disposePromise: Promise<void> | undefined;
  private _hostDisposedPromise: Promise<"host_disposed"> | undefined;
  private _hostDisposedResolve: ((value: "host_disposed") => void) | undefined;

  constructor(ctx: SubagentExecutionContext) {
    this._ctx = ctx;
  }

  /**
   * Synchronously assemble the borrowed submission context for one submission
   * (1.4.1). Nothing in the context is retained by the service past the
   * createTaskGroup freeze boundary; the value snapshot and closures are
   * generation-bound (a stale runner's late calls never read a replacement
   * parent session).
   */
  assembleSubmissionContext(parentToolCallId: string): AgentTaskSubmissionContext {
    return {
      parentSessionId: this._ctx.getSessionId(),
      parentToolCallId,
      project: this._ctx.getProjectLocation(),
      agentDir: this._ctx.agentDir,
      loadedAgents: this._ctx.getLoadedAgents(),
      modelRegistry: this._ctx.modelRegistry,
      parentRuntime: this._ctx.getParentRuntime(),
      requestUserInput: this._ctx.requestUserInput,
      hostDisposed: this._hostDisposed(),
    };
  }

  /**
   * Run one tool invocation (legacy compatible signature). Preflight (agent
   * resolution, prompt bounds, model resolution, project trust) happens inside
   * the service's createTaskGroup before any nested session is created; invalid
   * items never occupy a slot. Foreground runs resolve with the rebuilt
   * SubagentDetails; direct/auto/manual background resolves with the group
   * handle.
   */
  async run(
    params: SubagentRunParams,
    signal: AbortSignal | undefined,
    onProgress?: (event: SubagentProgressEvent) => void,
    onFileChange?: (event: { change: FileChangeSummary; aggregate: TurnDiffSummary }) => void,
    options?: SubagentRunOptions,
  ): Promise<SubagentDetails | AgentTaskGroupHandle> {
    const startedAt = Date.now();
    const details: SubagentDetails = {
      schemaVersion: 1,
      mode: params.mode,
      agentScope: params.agentScope,
      results: [],
      startedAt,
      updatedAt: startedAt,
      durationMs: 0,
    };
    const runState: RunState = {
      details,
      startedAt,
      emitProgress: () => {},
      onFileChange,
      groupTaskIds: [],
    };
    runState.emitProgress = createProgressEmitter(runState, onProgress);

    if (this._disposed) {
      details.results.push(this._makeRunAbortedResult(0, "host_disposed", "Subagent runner is disposed."));
      runState.emitProgress(true);
      return this._finalize(runState);
    }
    if (params.tasks.length === 0 || params.tasks.length > MAX_PARALLEL_TASKS) {
      details.results.push(
        this._makeFailedResult(0, "invalid_parameters", `Expected 1..${MAX_PARALLEL_TASKS} tasks, got ${params.tasks.length}.`),
      );
      runState.emitProgress(true);
      return this._finalize(runState);
    }

    // 1. Placeholders in the original mode/order; preflight failures inside
    //    the service resolve as failed results through the awaited details.
    for (const [index, task] of params.tasks.entries()) {
      details.results.push(this._makePlaceholderResult(params.mode, index, task));
    }
    runState.emitProgress(true);

    const service = this._ctx.getTaskService();
    if (!service) {
      details.results[0]!.status = "failed";
      details.results[0]!.failureReason = "internal_error";
      details.results[0]!.errorMessage = boundedErrorMessage("The agent task service is not available.");
      details.results[0]!.endedAt = Date.now();
      details.results[0]!.durationMs = 0;
      runState.emitProgress(true);
      return this._finalize(runState);
    }

    // 2. Freeze the submission (preflight) through the app service; the parent
    //    context never crosses this boundary.
    const context = this.assembleSubmissionContext(options?.parentToolCallId ?? `runner-${randomUUID()}`);
    const group = await service.createTaskGroup(
      {
        mode: params.mode,
        agentScope: params.agentScope,
        tasks: params.tasks,
        runInBackground: options?.runInBackground === true,
      },
      context,
      "foreground",
      signal,
    );
    runState.groupTaskIds = group.tasks.map((task) => task.taskId);

    // 3. Direct background: the preflight is done and the handle is returned;
    //    no progress/usage/signal bookkeeping is attached.
    if (options?.runInBackground === true) {
      return group;
    }

    // 4. Sync the current group state (the initial queued/running task_state
    //    events are emitted inside createTaskGroup, before the subscription
    //    below), then subscribe to the group's task events for progress +
    //    file_change forwarding, temporarily bridge the parent signal to
    //    cancelGroup(user_cancel), then await the group.
    // 1.4.2 (R2): getAll returns the AgentTaskListSnapshot.
    for (const info of service.getAll().tasks) {
      if (runState.groupTaskIds.includes(info.taskId)) {
        this._applyTaskState(runState, info);
      }
    }
    runState.emitProgress(true);
    const unsubscribe = service.onEvent((event) => {
      if (event.type === "task_state" && runState.groupTaskIds.includes(event.task.taskId)) {
        this._applyTaskState(runState, event.task);
        runState.emitProgress(false);
      } else if (event.type === "task_activities" && runState.groupTaskIds.includes(event.taskId)) {
        this._applyLiveActivities(runState, event.taskId, event.activities);
        runState.emitProgress(false);
      } else if (event.type === "task_output" && runState.groupTaskIds.includes(event.taskId)) {
        this._applyLiveOutput(runState, event.taskId, event.output, event.truncated);
        runState.emitProgress(false);
      } else if (event.type === "task_file_change" && runState.groupTaskIds.includes(event.taskId)) {
        onFileChange?.({ change: event.change, aggregate: event.aggregate });
      }
    });
    let removeSignalListener: (() => void) | undefined;
    const onAbort = (): void => {
      // The parent tool promise ended: cancel the still-foreground group. Once
      // the group detaches, awaitGroup resolves and this listener is removed,
      // so switching sessions / ending the parent tool Promise never cancels a
      // backgrounded task.
      void service.cancelGroup(group.groupId, "user_cancel");
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        removeSignalListener = () => signal.removeEventListener("abort", onAbort);
      }
    }
    try {
      const result = await service.awaitGroup(group.groupId);
      if (result.kind === "backgrounded") {
        // Detached (auto/manual background): resolve the single tool await with
        // the group handle; the tasks keep running in the service.
        runState.emitProgress(true);
        return result.handle;
      }
      const finished = result.details;
      // 5. Usage ownership: the service keeps task-level usage; the facade
      //    writes the aggregated SubagentDetails usage into the parent
      //    generation's auxiliary accumulator exactly once per still-foreground
      //    group (backgrounded groups never write back into a possibly
      //    destroyed parent generation).
      this._ctx.recordAuxiliaryUsage(aggregateSubagentUsage(finished));
      runState.details = finished;
      runState.emitProgress(true);
      return finished;
    } finally {
      unsubscribe();
      if (removeSignalListener) {
        removeSignalListener();
      }
    }
  }

  /**
   * Idempotent. The synchronous front half marks host_disposed (the submission
   * context's hostDisposed promise resolves, racing in-flight preflight
   * approvals as host_disposed, never as a user denial); in-flight task groups
   * keep running in the app service. The returned promise settles once every
   * abandoned facade promise has settled.
   */
  dispose(): Promise<void> {
    if (!this._disposed) {
      this._disposed = true;
      this._hostDisposedResolve?.("host_disposed");
    }
    if (!this._disposePromise) {
      this._disposePromise = Promise.resolve();
    }
    return this._disposePromise;
  }

  /** Resolves once when the host disposes the runner (first dispose only). */
  private _hostDisposed(): Promise<"host_disposed"> {
    if (!this._hostDisposedPromise) {
      this._hostDisposedPromise = new Promise<"host_disposed">((resolve) => {
        this._hostDisposedResolve = resolve;
      });
    }
    return this._hostDisposedPromise;
  }

  // =========================================================================
  // Progress rebuilding (foreground, facade run scope)
  // =========================================================================

  /**
   * Apply one task_state into the run's progress snapshot, rebuilding the
   * placeholders in the original mode/order: terminal tasks are replaced by
   * their frozen results; running/queued tasks mirror status, bounded output
   * and activities. The emitter throttles the emitted snapshots.
   */
  private _applyTaskState(runState: RunState, info: AgentTaskInfo): void {
    const indexes = info.itemSummaries.map((summary) => summary.index);
    if (isTerminal(info.status)) {
      for (const result of info.results) {
        const existing = runState.details.results.findIndex((candidate) => candidate.index === result.index);
        if (existing !== -1) {
          runState.details.results[existing] = structuredClone(result);
        } else {
          runState.details.results.push(structuredClone(result));
        }
      }
      return;
    }
    for (const index of indexes) {
      const result = runState.details.results[index];
      if (!result) {
        continue;
      }
      if (info.status === "queued") {
        result.status = "queued";
        continue;
      }
      // running / waiting_input: a running placeholder with the bounded live
      // counters (chain shows the first unfinished step as running).
      result.status = "running";
      result.finalOutput = info.finalOutput;
      result.outputTruncated = info.outputTruncated;
      result.originalOutputBytes = info.originalOutputBytes;
      result.toolUseCount = info.toolUseCount;
      result.activities = info.activities.slice(-MAX_RECENT_ACTIVITIES) as SubagentActivity[];
      result.usage = { ...info.usage };
      if (result.startedAt === undefined && info.startedAt !== undefined) {
        result.startedAt = info.startedAt;
      }
      if (info.startedAt !== undefined) {
        result.durationMs = Math.max(0, info.updatedAt - info.startedAt);
      }
    }
  }

  private _indexesForGroupTask(runState: RunState, taskId: string): number[] {
    const idx = runState.groupTaskIds.indexOf(taskId);
    if (idx === -1) {
      return [];
    }
    if (runState.groupTaskIds.length === 1) {
      return runState.details.results.map((_, index) => index);
    }
    return [idx];
  }

  private _applyLiveActivities(runState: RunState, taskId: string, activities: AgentTaskInfo["activities"]): void {
    const sliced = activities.slice(-MAX_RECENT_ACTIVITIES) as SubagentActivity[];
    for (const index of this._indexesForGroupTask(runState, taskId)) {
      const result = runState.details.results[index];
      if (!result || result.status === "completed" || result.status === "failed" || result.status === "aborted") {
        continue;
      }
      result.activities = sliced;
    }
  }

  private _applyLiveOutput(runState: RunState, taskId: string, output: string, truncated: boolean): void {
    for (const index of this._indexesForGroupTask(runState, taskId)) {
      const result = runState.details.results[index];
      if (!result || result.status === "completed" || result.status === "failed" || result.status === "aborted") {
        continue;
      }
      result.finalOutput = output;
      result.outputTruncated = truncated;
    }
  }

  // =========================================================================
  // Result helpers
  // =========================================================================

  private _makePlaceholderResult(mode: SubagentRunParams["mode"], index: number, task: SubagentTaskItem): SubagentSingleResult {
    return {
      id: randomUUID(),
      index,
      step: mode === "chain" ? index + 1 : undefined,
      agentName: typeof task.subagent_type === "string" && task.subagent_type.trim() !== ""
        ? task.subagent_type.trim()
        : "general-purpose",
      agentSource: "unknown",
      description: describeTask(task),
      status: "queued",
      finalOutput: "",
      outputTruncated: false,
      originalOutputBytes: 0,
      toolUseCount: 0,
      activities: [],
      usage: emptyUsage(),
      durationMs: 0,
    };
  }

  private _makeFailedResult(index: number, reason: SubagentFailureReason, message: string): SubagentSingleResult {
    return {
      id: randomUUID(),
      index,
      agentName: "general-purpose",
      agentSource: "unknown",
      description: "",
      status: "failed",
      finalOutput: "",
      outputTruncated: false,
      originalOutputBytes: 0,
      toolUseCount: 0,
      activities: [],
      usage: emptyUsage(),
      failureReason: reason,
      errorMessage: boundedErrorMessage(message),
      endedAt: Date.now(),
      durationMs: 0,
    };
  }

  private _makeRunAbortedResult(index: number, reason: SubagentFailureReason, message: string): SubagentSingleResult {
    return {
      id: randomUUID(),
      index,
      agentName: "general-purpose",
      agentSource: "unknown",
      description: "",
      status: "aborted",
      finalOutput: "",
      outputTruncated: false,
      originalOutputBytes: 0,
      toolUseCount: 0,
      activities: [],
      usage: emptyUsage(),
      failureReason: reason,
      errorMessage: boundedErrorMessage(message),
      endedAt: Date.now(),
      durationMs: 0,
    };
  }

  private _finalize(runState: RunState): SubagentDetails {
    const now = Date.now();
    runState.details.updatedAt = now;
    runState.details.durationMs = now - runState.startedAt;
    runState.emitProgress(true);
    // Immutable snapshot: the caller must not observe internal mutations.
    return structuredClone(runState.details);
  }
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** UTF-8-safe bounded error text, capped at the shared error-message limit. */
function boundedErrorMessage(message: string): string {
  const maxBytes = MAX_ERROR_MESSAGE_BYTES;
  const originalBytes = new TextEncoder().encode(message).length;
  if (originalBytes <= maxBytes) {
    return message;
  }
  let slice = Buffer.from(message, "utf-8").subarray(0, maxBytes);
  while (slice.length > 0 && (slice[slice.length - 1] & 0xc0) === 0x80) {
    slice = slice.subarray(0, slice.length - 1);
  }
  if (slice.length > 0 && (slice[slice.length - 1] & 0x80) !== 0) {
    slice = slice.subarray(0, slice.length - 1);
  }
  return slice.toString("utf-8");
}

/**
 * Progress emitter with a text-update throttle: status transitions and
 * terminal updates are immediate, high-frequency text updates at most
 * 10 per second. Every snapshot is an immutable copy.
 */
function createProgressEmitter(
  runState: RunState,
  onProgress: ((event: SubagentProgressEvent) => void) | undefined,
): (force: boolean) => void {
  let lastEmitAt = 0;
  return (force: boolean) => {
    const now = Date.now();
    if (!force && now - lastEmitAt < TEXT_UPDATE_THROTTLE_MS) {
      return;
    }
    lastEmitAt = now;
    runState.details.updatedAt = now;
    runState.details.durationMs = now - runState.startedAt;
    onProgress?.({ details: structuredClone(runState.details) });
  };
}
