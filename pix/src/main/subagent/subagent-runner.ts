/**
 * Shared solo-mode subagent runner (design plan section 4.6).
 *
 * One parent session owns exactly one `SubagentRunner`. It performs the
 * scope/trust/model preflight, arbitrates a global FIFO semaphore across all
 * concurrent `agent` tool calls (at most MAX_ACTIVE_SUBAGENTS nested sessions
 * in flight), owns the nested session lifecycle (fresh in-memory session,
 * fresh settings/loader, fresh MCP adapter), streams bounded immutable
 * progress snapshots, classifies termination by a first-cause-wins state
 * machine and bounds every piece of model-visible output.
 *
 * Ownership rules:
 * - borrowed objects from the context are never disposed;
 * - fresh sessions/MCP adapters are always disposed, even on failure/abort;
 * - nested transcripts are always in-memory only.
 *
 * Every abandoned phase promise keeps a resolve/reject observer, so a late
 * rejection can never become an unhandled rejection.
 */

import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { McpAdapter } from "pi-mcp-adapter";
import {
  BUILTIN_AGENTS,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  resolveAgentsForScope,
  MAX_AGENT_TURNS as MAX_DEFINITION_AGENT_TURNS,
  type AgentDefinition,
  type AgentSession,
  type AgentSessionEvent,
  type LoadAgentsResult,
} from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_MAX_ACTIVITY_SUMMARY_CHARS,
  SUBAGENT_MAX_DESCRIPTION_CHARS,
  SUBAGENT_MAX_ERROR_MESSAGE_BYTES,
  SUBAGENT_MAX_FINAL_OUTPUT_BYTES,
  SUBAGENT_MAX_RECENT_ACTIVITIES,
  SUBAGENT_MAX_RESULTS,
  type SubagentActivity,
  type SubagentDetails,
  type SubagentFailureReason,
  type SubagentSingleResult,
  type SubagentUsage,
} from "../../shared/subagent-types.js";
import type {
  SubagentExecutionContext,
  SubagentParentRuntimeSnapshot,
  SubagentProgressEvent,
  SubagentRunParams,
  SubagentTaskItem,
} from "./types.js";

// Serialization aliases come from shared, the turn cap from core; no second
// source of truth for these numbers.
export const MAX_PARALLEL_TASKS = SUBAGENT_MAX_RESULTS;
export const MAX_ACTIVE_SUBAGENTS = 4;
export const DEFAULT_MAX_TURNS = 50;
export const MAX_AGENT_TURNS = MAX_DEFINITION_AGENT_TURNS;
export const NESTED_STARTUP_TIMEOUT_MS = 30_000;
export const ABORT_TIMEOUT_MS = 5_000;
export const NESTED_CLEANUP_TIMEOUT_MS = 2_000;
export const MAX_DELEGATED_PROMPT_BYTES = 64 * 1024;
export const MAX_TASK_OUTPUT_BYTES = SUBAGENT_MAX_FINAL_OUTPUT_BYTES;
export const MAX_TOOL_CONTENT_BYTES = 128 * 1024;
export const MAX_RECENT_ACTIVITIES = SUBAGENT_MAX_RECENT_ACTIVITIES;
export const MAX_ACTIVITY_SUMMARY_CHARS = SUBAGENT_MAX_ACTIVITY_SUMMARY_CHARS;
export const MAX_ERROR_MESSAGE_BYTES = SUBAGENT_MAX_ERROR_MESSAGE_BYTES;

/** External termination causes; the first one wins and is never overwritten. */
type TerminationCause = "parent_signal" | "host_disposed" | "max_turns";

const TEXT_UPDATE_THROTTLE_MS = 100;

/** Per-task termination coordinator (first cause wins). */
interface TaskControl {
  readonly cause: TerminationCause | undefined;
  readonly promise: Promise<TerminationCause>;
  fire: (cause: TerminationCause) => void;
  /** Synchronous hook run when a cause fires (nested abort). */
  setOnFire: (handler: (cause: TerminationCause) => void) => void;
}

/** Abortable timer used for every bounded wait. */
interface Deadline {
  readonly promise: Promise<"deadline">;
  readonly fired: boolean;
  cancel: () => void;
}

/** One preflight-resolved task of a run. */
interface PreflightItem {
  index: number;
  step: number | undefined;
  task: SubagentTaskItem;
  name: string;
  definition: AgentDefinition | undefined;
  description: string;
  modelSnapshot: Model<Api> | undefined;
  modelLabel: string | undefined;
  projectAgent: boolean;
  failure: { reason: SubagentFailureReason; message: string } | undefined;
}

/** Mutable per-run bookkeeping that feeds the immutable details snapshots. */
interface RunState {
  details: SubagentDetails;
  startedAt: number;
  parentSnapshot: SubagentParentRuntimeSnapshot;
  emitProgress: (force: boolean) => void;
}

/** Event counters the runner maintains for one task. */
interface TaskCounters {
  sequence: number;
  toolUseCount: number;
  turnCount: number;
  limitArmed: boolean;
  lastAssistantMessage: AssistantMessage | undefined;
  lastNonEmptyFinalizedText: string;
  latestStreamingText: string;
  lastPromptError: string | undefined;
  usage: SubagentUsage;
  activities: SubagentActivity[];
}

function emptyUsage(): SubagentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 };
}

function createTaskControl(): TaskControl {
  let cause: TerminationCause | undefined;
  let onFire: ((cause: TerminationCause) => void) | undefined;
  const listeners = new Set<(cause: TerminationCause) => void>();
  const promise = new Promise<TerminationCause>((resolve) => {
    listeners.add(resolve);
  });
  return {
    get cause() {
      return cause;
    },
    promise,
    fire: (next: TerminationCause) => {
      if (cause !== undefined) {
        return;
      }
      cause = next;
      onFire?.(next);
      for (const listener of listeners) {
        listener(next);
      }
    },
    setOnFire: (handler) => {
      onFire = handler;
    },
  };
}

function createDeadline(ms: number): Deadline {
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => {
      fired = true;
      resolve("deadline");
    }, ms);
  });
  return {
    promise,
    get fired() {
      return fired;
    },
    cancel: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Bounded wait for a dispose-style promise: the original promise keeps its
 * resolve/reject observers, so a late settlement can never become an
 * unhandled rejection.
 */
function disposeBounded(promise: Promise<unknown>, label: string): Promise<void> {
  const deadline = createDeadline(NESTED_CLEANUP_TIMEOUT_MS);
  const outcome = Promise.race([promise, deadline.promise]);
  return outcome.then((value) => {
    deadline.cancel();
    if (value !== "deadline") {
      return;
    }
    console.warn(`[SubagentRunner] ${label} did not finish within ${NESTED_CLEANUP_TIMEOUT_MS}ms`);
  });
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** UTF-8-safe truncation; never splits a multi-byte character. */
function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean; originalBytes: number } {
  const originalBytes = utf8ByteLength(text);
  if (originalBytes <= maxBytes) {
    return { text, truncated: false, originalBytes };
  }
  let slice = Buffer.from(text, "utf-8").subarray(0, maxBytes);
  while (slice.length > 0 && (slice[slice.length - 1] & 0xc0) === 0x80) {
    slice = slice.subarray(0, slice.length - 1);
  }
  if (slice.length > 0 && (slice[slice.length - 1] & 0x80) !== 0) {
    slice = slice.subarray(0, slice.length - 1);
  }
  return { text: slice.toString("utf-8"), truncated: true, originalBytes };
}

function boundedErrorMessage(message: string): string {
  return truncateUtf8(message, MAX_ERROR_MESSAGE_BYTES).text;
}

/** Single-line, bounded activity summary; never includes full args/result. */
function summarizeActivity(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  const candidate = record.command ?? record.path ?? record.file_path ?? record.filename ?? record.pattern;
  if (typeof candidate !== "string" || candidate.trim() === "") {
    return undefined;
  }
  const singleLine = candidate.replace(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_ACTIVITY_SUMMARY_CHARS) {
    return singleLine;
  }
  return `${singleLine.slice(0, MAX_ACTIVITY_SUMMARY_CHARS - 3)}...`;
}

/** Concatenate all text blocks of an assistant message in original order. */
function assistantText(message: AssistantMessage | undefined): string {
  if (!message) {
    return "";
  }
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") {
      text += block.text;
    }
  }
  return text;
}

function accumulateUsage(target: SubagentUsage, usage: Usage | undefined): void {
  if (!usage) {
    return;
  }
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.cost += usage.cost.total;
  target.totalTokens += usage.totalTokens;
}

export class SubagentRunner {
  private readonly _ctx: SubagentExecutionContext;
  private _disposed = false;
  private _disposePromise: Promise<void> | undefined;
  private _activeCount = 0;
  private readonly _waiters: Array<{ resolve: () => void; remove: () => void }> = [];
  private readonly _inFlight = new Set<Promise<unknown>>();
  private readonly _hostDisposeListeners = new Set<() => void>();
  private _hostDisposedPromise: Promise<"host_disposed"> | undefined;
  private _hostDisposedResolve: ((value: "host_disposed") => void) | undefined;

  constructor(ctx: SubagentExecutionContext) {
    this._ctx = ctx;
  }

  /**
   * Run one tool invocation. Preflight (agent resolution, prompt bounds, model
   * resolution, project trust) happens before any nested session is created;
   * invalid items never occupy a slot.
   */
  async run(
    params: SubagentRunParams,
    signal: AbortSignal | undefined,
    onProgress?: (event: SubagentProgressEvent) => void,
  ): Promise<SubagentDetails> {
    const runPromise = this._runInner(params, signal, onProgress);
    this._inFlight.add(runPromise);
    try {
      return await runPromise;
    } finally {
      this._inFlight.delete(runPromise);
    }
  }

  private async _runInner(
    params: SubagentRunParams,
    signal: AbortSignal | undefined,
    onProgress?: (event: SubagentProgressEvent) => void,
  ): Promise<SubagentDetails> {
    const startedAt = Date.now();
    const runState: RunState = {
      startedAt,
      parentSnapshot: this._ctx.getParentRuntime(),
      details: {
        schemaVersion: 1,
        mode: params.mode,
        agentScope: params.agentScope,
        results: [],
        startedAt,
        updatedAt: startedAt,
        durationMs: 0,
      },
      emitProgress: () => {},
    };
    runState.emitProgress = createProgressEmitter(runState, onProgress);

    if (this._disposed) {
      runState.details.results.push(this._makeRunAbortedResult(0, "host_disposed", "Subagent runner is disposed."));
      runState.emitProgress(true);
      return this._finalize(runState);
    }
    if (params.tasks.length === 0 || params.tasks.length > MAX_PARALLEL_TASKS) {
      runState.details.results.push(
        this._makeFailedResult(0, "invalid_parameters", `Expected 1..${MAX_PARALLEL_TASKS} tasks, got ${params.tasks.length}.`),
      );
      runState.emitProgress(true);
      return this._finalize(runState);
    }

    // 1. Side-effect-free resolution plan (no sessions for invalid items).
    //    The loaded-agent catalog is snapshotted exactly once per run.
    const loaded = this._ctx.getLoadedAgents();
    const items = this._preflight(params, runState, loaded);
    runState.emitProgress(true);

    // 2. Project trust: one approval request for all actually-selected
    //    project definitions of this run.
    const approval = await this._resolveProjectApproval(items, signal, loaded);
    if (approval.kind === "cause") {
      this._abortAllQueued(items, runState, approval.cause, "The subagent run was interrupted.");
      runState.emitProgress(true);
      return this._finalize(runState);
    }
    if (approval.kind === "denied") {
      const continueRun = this._applyDenial(items, runState);
      runState.emitProgress(true);
      if (!continueRun) {
        return this._finalize(runState);
      }
    }

    // 3. Per-mode orchestration. Results keep input order; chain executes
    //    strictly sequentially.
    if (params.mode === "chain") {
      await this._runChain(items, runState, signal);
    } else {
      await Promise.all(
        items
          .filter((item) => runState.details.results[item.index].status === "queued")
          .map((item) => this._runTask(item, runState, signal)),
      );
    }

    return this._finalize(runState);
  }

  /**
   * Idempotent. The synchronous front half marks host_disposed, stops
   * accepting new tasks and aborts queued/active tasks; the returned promise
   * waits for the bounded cleanup of every in-flight run/task.
   */
  dispose(): Promise<void> {
    if (!this._disposed) {
      this._disposed = true;
      this._hostDisposedResolve?.("host_disposed");
      for (const listener of this._hostDisposeListeners) {
        try {
          listener();
        } catch {
          // Dispose must never throw from a listener.
        }
      }
    }
    if (!this._disposePromise) {
      this._disposePromise = Promise.allSettled([...this._inFlight]).then(() => undefined);
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
  // Preflight
  // =========================================================================

  private _preflight(params: SubagentRunParams, runState: RunState, loaded: LoadAgentsResult | undefined): PreflightItem[] {
    const definitions = resolveAgentsForScope(loaded?.agents ?? [...BUILTIN_AGENTS], params.agentScope);
    const items: PreflightItem[] = [];

    for (const [index, task] of params.tasks.entries()) {
      // Defensive normalization: non-string fields must never throw; they flow
      // into the structured failed result path instead.
      const requested = typeof task.subagent_type === "string" ? task.subagent_type.trim() : undefined;
      const name = requested && requested !== "" ? requested : "general-purpose";
      const definition = definitions.find((candidate) => candidate.name === name);

      let failure: { reason: SubagentFailureReason; message: string } | undefined;
      let modelSnapshot: Model<Api> | undefined;
      let modelLabel: string | undefined;

      if (!definition) {
        failure = { reason: "unknown_agent", message: `Unknown agent "${name}".` };
      } else if (typeof task.prompt !== "string" || task.prompt.trim() === "") {
        failure = { reason: "prompt_too_large", message: "The delegated prompt must not be empty." };
      } else if (utf8ByteLength(task.prompt) > MAX_DELEGATED_PROMPT_BYTES) {
        failure = {
          reason: "prompt_too_large",
          message: `The delegated prompt exceeds ${MAX_DELEGATED_PROMPT_BYTES} bytes.`,
        };
      } else {
        const resolved = this._resolveModel(definition, runState.parentSnapshot);
        if (resolved.failure) {
          failure = resolved.failure;
        } else {
          modelSnapshot = resolved.model;
          modelLabel = resolved.label;
        }
      }

      items.push({
        index,
        step: params.mode === "chain" ? index + 1 : undefined,
        task,
        name,
        definition,
        description: this._describeTask(task),
        modelSnapshot,
        modelLabel,
        projectAgent: definition?.source === "project",
        failure,
      });

      // Chain keeps input order atomically: the first pre-parsed failure
      // terminates the plan (its failed result is appended, no later item).
      if (params.mode === "chain" && failure) {
        break;
      }
    }

    // Create the result placeholders in input order, then mark failures.
    for (const item of items) {
      runState.details.results.push(this._makePlaceholderResult(item));
    }
    for (const item of items) {
      if (item.failure) {
        const result = runState.details.results[item.index];
        result.status = "failed";
        result.failureReason = item.failure.reason;
        result.errorMessage = boundedErrorMessage(item.failure.message);
        result.endedAt = Date.now();
        result.durationMs = 0;
      }
    }
    return items;
  }

  private _resolveModel(
    definition: AgentDefinition,
    snapshot: SubagentParentRuntimeSnapshot,
  ): {
    model: Model<Api> | undefined;
    label: string | undefined;
    failure: { reason: SubagentFailureReason; message: string } | undefined;
  } {
    const spec = definition.model;
    const isInherit = spec === undefined || spec === "inherit";
    if (isInherit) {
      const parentModel = snapshot.model;
      if (!parentModel) {
        return {
          model: undefined,
          label: undefined,
          failure: { reason: "model_unavailable", message: "The parent session has no active model." },
        };
      }
      return { model: structuredClone(parentModel), label: `${parentModel.provider}/${parentModel.id}`, failure: undefined };
    }

    const registry = this._ctx.modelRegistry;
    let model: Model<Api> | undefined;
    let label: string | undefined;
    let failure: { reason: SubagentFailureReason; message: string } | undefined;

    const slashIndex = spec.indexOf("/");
    if (slashIndex !== -1) {
      // Split at the FIRST "/" only; the remainder (which may itself contain
      // "/") is the full modelId.
      const provider = spec.slice(0, slashIndex);
      const modelId = spec.slice(slashIndex + 1);
      if (provider === "" || modelId === "") {
        failure = { reason: "model_not_found", message: `Model "${spec}" is not a valid provider/modelId.` };
      } else {
        model = registry.find(provider, modelId);
        label = spec;
        if (!model) {
          failure = { reason: "model_not_found", message: `Model "${spec}" was not found.` };
        }
      }
    } else {
      // Bare id: exact match on the full model.id over getAll() (never
      // getAvailable(), which would misreport auth as not found).
      const matches = registry.getAll().filter((candidate) => candidate.id === spec);
      if (matches.length === 0) {
        failure = { reason: "model_not_found", message: `Model "${spec}" was not found.` };
      } else if (matches.length > 1) {
        failure = {
          reason: "model_ambiguous",
          message: `Model id "${spec}" is ambiguous across providers; use provider/modelId instead.`,
        };
      } else {
        model = matches[0];
        label = `${model.provider}/${model.id}`;
      }
    }

    if (model && !failure) {
      if (!registry.hasConfiguredAuth(model)) {
        return {
          model: undefined,
          label: undefined,
          failure: {
            reason: "model_auth_unavailable",
            message: `No configured credentials for ${model.provider}/${model.id}.`,
          },
        };
      }
      // Detached deep-copy snapshot: no nested reference is shared with the
      // parent active model or the registry item; identity is not inherited.
      return { model: structuredClone(model), label, failure: undefined };
    }
    return { model: undefined, label, failure };
  }

  /** Result description: caller description, else a prompt preview. */
  private _describeTask(task: SubagentTaskItem): string {
    // Type-short-circuit non-string fields instead of throwing; the preflight
    // failure path already handles a non-string prompt structurally.
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

  // =========================================================================
  // Project trust
  // =========================================================================

  private async _resolveProjectApproval(
    items: PreflightItem[],
    signal: AbortSignal | undefined,
    loaded: LoadAgentsResult | undefined,
  ): Promise<{ kind: "approved" } | { kind: "denied" } | { kind: "cause"; cause: TerminationCause }> {
    const projectItems = items.filter((item) => item.projectAgent && !item.failure);
    if (projectItems.length === 0) {
      return { kind: "approved" };
    }
    if (signal?.aborted) {
      return { kind: "cause", cause: "parent_signal" };
    }
    if (this._disposed) {
      return { kind: "cause", cause: "host_disposed" };
    }

    const projectAgentsDir = loaded?.projectAgentsDir ?? `${this._ctx.physicalCwd}/.pi/agents`;
    const names = projectItems.map((item) => item.name).join(", ");
    const request = {
      id: randomUUID(),
      questions: [
        {
          id: "allow_project_agents",
          header: "允许项目 Agent",
          question: `是否允许运行以下项目自定义 agent：${names}？项目 agents 目录：${projectAgentsDir}`,
          options: [
            { label: "允许", description: "允许这些项目 agent 本次运行。" },
            { label: "拒绝", description: "拒绝这些项目 agent 本次运行。" },
          ],
        },
      ],
    };

    // The approval awaits the handler, host dispose and the parent signal
    // itself: an interruption is classified by the first cause, never as a
    // user denial.
    let removeSignalListener: (() => void) | undefined;
    const signalCause = new Promise<"parent_signal">((resolve) => {
      if (signal) {
        if (signal.aborted) {
          resolve("parent_signal");
        } else {
          const onAbort = (): void => resolve("parent_signal");
          signal.addEventListener("abort", onAbort, { once: true });
          removeSignalListener = () => signal.removeEventListener("abort", onAbort);
        }
      }
    });
    try {
      const response = await Promise.race([
        this._ctx.requestUserInput(request, signal),
        this._hostDisposed().then(() => "host_disposed" as const),
        signalCause,
      ]);
      if (response === "host_disposed") {
        return { kind: "cause", cause: "host_disposed" };
      }
      if (response === "parent_signal") {
        return { kind: "cause", cause: "parent_signal" };
      }
      if (this._disposed) {
        return { kind: "cause", cause: "host_disposed" };
      }
      if (response.cancelled === true || response.answers.allow_project_agents !== "允许") {
        return { kind: "denied" };
      }
      return { kind: "approved" };
    } catch {
      // The approval promise was interrupted (parent signal / host dispose);
      // classify by the first cause, never as a user denial.
      if (this._disposed) {
        return { kind: "cause", cause: "host_disposed" };
      }
      if (signal?.aborted) {
        return { kind: "cause", cause: "parent_signal" };
      }
      return { kind: "denied" };
    } finally {
      removeSignalListener?.();
    }
  }

  /**
   * User denial semantics per mode. Returns true when execution should
   * continue (parallel with remaining user/built-in items), false when the
   * run terminates here (single and chain).
   */
  private _applyDenial(items: PreflightItem[], runState: RunState): boolean {
    if (runState.details.mode === "chain") {
      // Atomic chain: terminate before starting any step with the first
      // project step's denied result; earlier steps never execute and no
      // other placeholder stays in the results array.
      const firstProject = items.find((item) => item.projectAgent);
      if (firstProject) {
        const deniedIndex = firstProject.index;
        this._markAborted(
          runState.details.results[deniedIndex],
          "project_agent_denied",
          "Project agent was not approved by the user.",
        );
        runState.details.results = runState.details.results.filter((_, index) => index === deniedIndex);
      }
      return false;
    }
    if (runState.details.mode === "single") {
      const item = items[0];
      if (item?.projectAgent) {
        this._markAborted(
          runState.details.results[item.index],
          "project_agent_denied",
          "Project agent was not approved by the user.",
        );
      }
      return false;
    }
    // parallel: only project items are aborted; user/built-in items continue.
    for (const item of items) {
      if (item.projectAgent) {
        this._markAborted(
          runState.details.results[item.index],
          "project_agent_denied",
          "Project agent was not approved by the user.",
        );
      }
    }
    return runState.details.results.some((result) => result.status === "queued");
  }

  /** Run-level termination (parent signal / host dispose) aborts everything. */
  private _abortAllQueued(items: PreflightItem[], runState: RunState, cause: TerminationCause, message: string): void {
    const reason: SubagentFailureReason = cause === "host_disposed" ? "host_disposed" : "aborted";
    for (const item of items) {
      const result = runState.details.results[item.index];
      if (result.status === "queued" || result.status === "running") {
        this._markAborted(result, reason, message);
      }
    }
  }

  private _markAborted(result: SubagentSingleResult, reason: SubagentFailureReason, message: string): void {
    result.status = "aborted";
    result.failureReason = reason;
    result.errorMessage = boundedErrorMessage(message);
    result.endedAt = Date.now();
    result.durationMs = result.startedAt === undefined ? 0 : Math.max(0, result.endedAt - result.startedAt);
    // Converge any still-running activity to failed.
    for (const activity of result.activities) {
      if (activity.status === "running") {
        activity.status = "failed";
        activity.endedAt = result.endedAt;
      }
    }
  }

  // =========================================================================
  // Chain orchestration
  // =========================================================================

  private async _runChain(items: PreflightItem[], runState: RunState, signal: AbortSignal | undefined): Promise<void> {
    let previousOutput: string | undefined;
    for (const item of items) {
      const result = runState.details.results[item.index];
      if (result.status !== "queued") {
        // Preflight failures and denied project steps are already terminal.
        continue;
      }
      // Step 1 replaces {previous} with the empty string; later steps replace
      // ALL placeholders with the previous step's truncated finalOutput.
      const prompt =
        previousOutput === undefined
          ? item.task.prompt.replaceAll("{previous}", "")
          : item.task.prompt.replaceAll("{previous}", previousOutput);
      if (utf8ByteLength(prompt) > MAX_DELEGATED_PROMPT_BYTES) {
        result.status = "failed";
        result.failureReason = "prompt_too_large";
        result.errorMessage = boundedErrorMessage(
          `The delegated prompt with {previous} substitution exceeds ${MAX_DELEGATED_PROMPT_BYTES} bytes.`,
        );
        result.endedAt = Date.now();
        result.durationMs = 0;
        // Not-started later steps never enter the results array (same as the
        // runtime failure branch below).
        runState.details.results = runState.details.results.slice(0, item.index + 1);
        runState.emitProgress(true);
        break;
      }
      await this._runTask(item, runState, signal, prompt, item.index + 1);
      const afterRun = runState.details.results[item.index];
      if (afterRun.status === "failed" || afterRun.status === "aborted") {
        // Chain stops at the failed/aborted step; not-started later items
        // never enter the results array.
        runState.details.results = runState.details.results.slice(0, item.index + 1);
        break;
      }
      previousOutput = afterRun.finalOutput;
    }
  }

  // =========================================================================
  // runSingle: fixed lifecycle
  // =========================================================================

  private async _runTask(
    item: PreflightItem,
    runState: RunState,
    parentSignal: AbortSignal | undefined,
    promptOverride?: string,
    step?: number,
  ): Promise<void> {
    const result = runState.details.results[item.index];
    if (step !== undefined) {
      item.step = step;
      result.step = step;
    }

    const control = createTaskControl();
    const nestedRef: { current: AgentSession | undefined } = { current: undefined };
    const mcpAdapterRef: { current: McpAdapter | undefined } = { current: undefined };
    const unsubscribeRef: { current: (() => void) | undefined } = { current: undefined };
    control.setOnFire(() => {
      nestedRef.current?.agent.abort();
    });

    // Termination wiring: parent signal and host dispose are the two external
    // causes available before the prompt starts.
    let removeSignalListener: (() => void) | undefined;
    if (parentSignal) {
      const onAbort = (): void => control.fire("parent_signal");
      if (parentSignal.aborted) {
        onAbort();
      } else {
        parentSignal.addEventListener("abort", onAbort, { once: true });
        removeSignalListener = () => parentSignal.removeEventListener("abort", onAbort);
      }
    }
    const hostDisposeListener = (): void => control.fire("host_disposed");
    this._hostDisposeListeners.add(hostDisposeListener);

    let usageRecorded = false;
    const counters: TaskCounters = {
      sequence: 0,
      toolUseCount: 0,
      turnCount: 0,
      limitArmed: false,
      lastAssistantMessage: undefined,
      lastNonEmptyFinalizedText: "",
      latestStreamingText: "",
      lastPromptError: undefined,
      usage: emptyUsage(),
      activities: [],
    };
    const maxTurns = item.definition?.maxTurns ?? DEFAULT_MAX_TURNS;
    // True only once the task truly holds a semaphore slot; the finally below
    // releases exactly once, and never for a task that only queued and aborted
    // (its slot.remove() already removed the waiter or released a same-tick grant).
    const slotHeldRef: { current: boolean } = { current: false };

    const taskPromise = (async () => {
      try {
        await this._runTaskBody(item, runState, parentSignal, control, promptOverride, maxTurns, result, counters, nestedRef, mcpAdapterRef, unsubscribeRef, slotHeldRef);
      } catch (error) {
        // Unexpected internal failure: never reject the run; convert it to a
        // bounded structured failure.
        const now = Date.now();
        result.status = "failed";
        result.failureReason = "internal_error";
        result.errorMessage = boundedErrorMessage(error instanceof Error ? error.message : String(error));
        result.endedAt = now;
        result.durationMs = Math.max(0, now - (result.startedAt ?? now));
        this._syncRunningProgress(result, counters);
        runState.emitProgress(true);
      }
    })();

    this._inFlight.add(taskPromise);
    try {
      await taskPromise;
    } finally {
      this._inFlight.delete(taskPromise);
      // Fixed cleanup order: listener removal, unsubscribe, usage exactly
      // once, nested dispose, MCP dispose, registry removal, slot release.
      if (removeSignalListener) {
        removeSignalListener();
      }
      this._hostDisposeListeners.delete(hostDisposeListener);
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }
      if (
        !usageRecorded &&
        (result.status === "completed" || result.status === "failed" || result.status === "aborted")
      ) {
        usageRecorded = true;
        this._ctx.recordAuxiliaryUsage(counters.usage);
      }
      // Both disposes are independent; neither failure nor timeout skips the
      // other.
      if (nestedRef.current) {
        await disposeBounded(
          nestedRef.current
            .dispose({
              killTrackedDetachedChildren: false,
              extensionShutdownTimeoutMs: NESTED_CLEANUP_TIMEOUT_MS,
            })
            .catch((error: unknown) => {
              console.error("[SubagentRunner] Nested session dispose failed:", error);
            }),
          "Nested session dispose",
        );
      }
      if (mcpAdapterRef.current) {
        await disposeBounded(
          mcpAdapterRef.current.dispose().catch((error: unknown) => {
            console.error("[SubagentRunner] MCP adapter dispose failed:", error);
          }),
          "MCP adapter dispose",
        );
      }
      if (slotHeldRef.current) {
        this._releaseSlot();
      }
    }
  }

  /** The body of one runSingle task; never rejects. */
  private async _runTaskBody(
    item: PreflightItem,
    runState: RunState,
    parentSignal: AbortSignal | undefined,
    control: TaskControl,
    promptOverride: string | undefined,
    maxTurns: number,
    result: SubagentSingleResult,
    counters: TaskCounters,
    nestedRef: { current: AgentSession | undefined },
    mcpAdapterRef: { current: McpAdapter | undefined },
    unsubscribeRef: { current: (() => void) | undefined },
    slotHeldRef: { current: boolean },
  ): Promise<void> {
      // 1. FIFO slot acquisition; a queued abort removes the queued item.
      const slot = this._acquireSlot();
      const gotSlot = await Promise.race([slot.promise.then(() => true), control.promise.then(() => false)]);
      if (!gotSlot) {
        slot.remove();
        result.status = "aborted";
        result.failureReason = control.cause === "host_disposed" ? "host_disposed" : "aborted";
        result.errorMessage = boundedErrorMessage(
          control.cause === "host_disposed"
            ? "Subagent runner was disposed."
            : "The subagent task was aborted while queued.",
        );
        result.endedAt = Date.now();
        result.durationMs = 0;
        runState.emitProgress(true);
        return;
      }
      slotHeldRef.current = true;
      result.status = "running";
      result.startedAt = Date.now();
      this._syncRunningProgress(result, counters);
      runState.emitProgress(true);

      // 2. Fresh dependencies + a single startup deadline spanning reload
      //    and bindExtensions (never recomputed per phase).
      const deadline = createDeadline(NESTED_STARTUP_TIMEOUT_MS);
      const startupFn = async (): Promise<boolean> => {
        const settingsManager = SettingsManager.create(this._ctx.physicalCwd, this._ctx.agentDir);
        const sessionManager = SessionManager.inMemory(this._ctx.physicalCwd);
        mcpAdapterRef.current = new McpAdapter({ allowStdio: !this._ctx.isWsl });
        const loader = new DefaultResourceLoader({
          cwd: this._ctx.physicalCwd,
          agentDir: this._ctx.agentDir,
          settingsManager,
          appendSystemPromptOverride: (base) => [...base, item.definition!.systemPrompt],
          extensionFactories: [
            (pi) => {
              mcpAdapterRef.current!.register(pi);
            },
          ],
        });
        try {
          await loader.reload();
          if (deadline.fired || control.cause) {
            return false;
          }
          // Apply the parent execution snapshot AFTER reload so reload does
          // not overwrite the override.
          settingsManager.applyOverrides({
            execution: {
              mode: runState.parentSnapshot.executionMode,
              verificationGate: runState.parentSnapshot.verificationGate,
            },
          });
          const created = await createAgentSession({
            cwd: this._ctx.physicalCwd,
            runtimeCwd: this._ctx.logicalCwd,
            agentDir: this._ctx.agentDir,
            executionBackend: this._ctx.executionBackend,
            runtimeEnvironmentOverride: this._ctx.runtimeEnvironmentOverride,
            authStorage: this._ctx.authStorage,
            modelRegistry: this._ctx.modelRegistry,
            model: item.modelSnapshot,
            thinkingLevel: runState.parentSnapshot.thinkingLevel,
            sessionManager,
            settingsManager,
            resourceLoader: loader,
            extensionProviderPolicy: "read-only",
            excludeTools: ["agent", ...(item.definition?.disallowedTools ?? [])],
            tools: item.definition?.tools,
            requestUserInput: this._ctx.requestUserInput,
          });
          if (deadline.fired || control.cause) {
            // The session must not leak when the deadline/cause won the race.
            await created.session.dispose({
              killTrackedDetachedChildren: false,
              extensionShutdownTimeoutMs: NESTED_CLEANUP_TIMEOUT_MS,
            });
            return false;
          }
          nestedRef.current = created.session;
          await nestedRef.current.bindExtensions({});
          return !deadline.fired && control.cause === undefined;
        } finally {
          deadline.cancel();
        }
      };

      // A rejection during reload/create/bind is a session-start failure, never
      // an internal one: label the outcome so the state machine below classifies
      // it (parent abort/host dispose still win when they arrived earlier).
      let startupError: string | undefined;
      const startupOutcome = await Promise.race([
        startupFn().then(
          (ok): "ok" | "abandoned" => (ok ? "ok" : "abandoned"),
          (error: unknown): "startup_error" => {
            startupError = error instanceof Error ? error.message : String(error);
            return "startup_error";
          },
        ),
        deadline.promise,
        control.promise,
      ]);
      deadline.cancel();

      if (startupOutcome !== "ok") {
        // Startup deadline / startup error / external cause: the prompt never
        // starts. The external cause keeps first-cause priority.
        if (control.cause) {
          result.status = "aborted";
          result.failureReason = control.cause === "host_disposed" ? "host_disposed" : "aborted";
          result.errorMessage = boundedErrorMessage(
            control.cause === "host_disposed"
              ? "Subagent runner was disposed."
              : "The subagent task was aborted during startup.",
          );
        } else {
          result.status = "failed";
          result.failureReason = "session_start_failed";
          result.errorMessage = boundedErrorMessage(
            startupOutcome === "startup_error" && startupError !== undefined
              ? `The nested session failed to start: ${startupError}`
              : `The nested session did not start within ${NESTED_STARTUP_TIMEOUT_MS}ms.`,
          );
        }
        result.endedAt = Date.now();
        result.durationMs = Math.max(0, result.endedAt - (result.startedAt ?? result.endedAt));
        runState.emitProgress(true);
        return;
      }

      // 3. Tool activation.
      const definition = item.definition!;
      if (definition.tools === undefined) {
        // All registered non-denylisted tools; never the SDK default four.
        nestedRef.current!.setActiveToolsByName(nestedRef.current!.getAllTools().map((tool) => tool.name));
      } else {
        const registered = new Set(nestedRef.current!.getAllTools().map((tool) => tool.name));
        const missing = definition.tools.filter((name) => !registered.has(name));
        if (missing.length > 0) {
          result.status = "failed";
          result.failureReason = "tool_unavailable";
          result.errorMessage = boundedErrorMessage(`Requested tool(s) not available: ${missing.join(", ")}.`);
          result.endedAt = Date.now();
          result.durationMs = Math.max(0, result.endedAt - result.startedAt!);
          runState.emitProgress(true);
          return;
        }
      }

      // 4. Progress subscription.
      unsubscribeRef.current = nestedRef.current!.subscribe((event) => {
        this._onNestedEvent(event, runState, control, counters, maxTurns, result);
      });

      // 5. The full run promise; never start an unassociated waitForIdle race.
      const promptText = promptOverride ?? item.task.prompt;
      const promptPromise = nestedRef.current!.prompt(promptText);
      const settle = promptPromise.then(
        () => true,
        (error: unknown) => {
          counters.lastPromptError = error instanceof Error ? error.message : String(error);
          return false;
        },
      );
      const firstOutcome = await Promise.race([settle, control.promise]);
      if (firstOutcome !== true) {
        // A cause fired; the synchronous abort already happened via control.
        const abortDeadline = createDeadline(ABORT_TIMEOUT_MS);
        const outcome = await Promise.race([settle, abortDeadline.promise]);
        abortDeadline.cancel();
        if (outcome !== true) {
          // Enter cleanup; the original prompt promise keeps its observers.
          promptPromise.catch(() => {});
        }
      }

      // 6. Terminal classification.
      this._classifyTerminal(result, control, counters, maxTurns);
      runState.emitProgress(true);
  }

  private _classifyTerminal(
    result: SubagentSingleResult,
    control: TaskControl,
    counters: TaskCounters,
    maxTurns: number,
  ): void {
    const now = Date.now();
    const cause = control.cause;
    const last = counters.lastAssistantMessage;

    // Terminal text: the terminal message wins when non-empty; otherwise, on
    // abort/maxTurns/API error fall back to the last non-empty text (finalized
    // first, then the latest streaming text) so a synthetic empty aborted
    // message cannot erase completed work.
    const terminalText = assistantText(last);
    let finalText: string;
    if (terminalText !== "") {
      finalText = terminalText;
    } else if (cause !== undefined || last?.stopReason === "aborted" || last?.stopReason === "error") {
      finalText = counters.lastNonEmptyFinalizedText !== "" ? counters.lastNonEmptyFinalizedText : counters.latestStreamingText;
    } else {
      finalText = "";
    }

    if (cause !== undefined) {
      if (cause === "max_turns") {
        result.status = "failed";
        result.failureReason = "max_turns";
        result.errorMessage = boundedErrorMessage(`The agent exceeded its turn limit (${maxTurns}).`);
      } else {
        result.status = "aborted";
        result.failureReason = cause === "host_disposed" ? "host_disposed" : "aborted";
        result.errorMessage = boundedErrorMessage(
          cause === "host_disposed" ? "Subagent runner was disposed." : "The subagent task was aborted.",
        );
      }
    } else if (counters.lastPromptError !== undefined) {
      result.status = "failed";
      result.failureReason = "internal_error";
      result.errorMessage = boundedErrorMessage(counters.lastPromptError);
    } else if (last?.stopReason === "error") {
      result.status = "failed";
      result.failureReason = "api_error";
      result.errorMessage = boundedErrorMessage(last.errorMessage ?? "The nested agent reported an API error.");
    } else if (last?.stopReason === "aborted") {
      result.status = "aborted";
      result.failureReason = "aborted";
      result.errorMessage = boundedErrorMessage("The nested agent was aborted.");
    } else {
      result.status = "completed";
    }

    const truncated = truncateUtf8(finalText, MAX_TASK_OUTPUT_BYTES);
    result.finalOutput = truncated.text;
    result.outputTruncated = truncated.truncated;
    result.originalOutputBytes = truncated.originalBytes;
    result.toolUseCount = counters.toolUseCount;
    result.activities = this._convergeActivities(counters.activities, now);
    counters.usage.turns = counters.turnCount;
    result.usage = { ...counters.usage };
    result.endedAt = now;
    result.durationMs = Math.max(0, now - (result.startedAt ?? now));
  }

  /** Keep the most-recent activities and fail any still-running one. */
  private _convergeActivities(activities: SubagentActivity[], now: number): SubagentActivity[] {
    const converged: SubagentActivity[] = activities.map((activity) =>
      activity.status === "running" ? { ...activity, status: "failed", endedAt: now } : activity,
    );
    return converged.slice(-MAX_RECENT_ACTIVITIES);
  }

  /**
   * Sync the bounded live counters into the result before every running
   * progress emit, so snapshots carry activities/tool-use/streaming
   * text/usage/duration instead of placeholder values. Terminal-only fields
   * (status, failureReason, errorMessage, endedAt) are never written here;
   * a running snapshot still carries no endedAt.
   */
  private _syncRunningProgress(result: SubagentSingleResult, counters: TaskCounters): void {
    const truncated = truncateUtf8(counters.latestStreamingText, MAX_TASK_OUTPUT_BYTES);
    result.finalOutput = truncated.text;
    result.outputTruncated = truncated.truncated;
    result.originalOutputBytes = truncated.originalBytes;
    result.toolUseCount = counters.toolUseCount;
    result.activities = counters.activities.slice(-MAX_RECENT_ACTIVITIES);
    result.usage = { ...counters.usage, turns: counters.turnCount };
    if (result.startedAt !== undefined) {
      result.durationMs = Math.max(0, Date.now() - result.startedAt);
    }
  }

  private _onNestedEvent(
    event: AgentSessionEvent,
    runState: RunState,
    control: TaskControl,
    counters: TaskCounters,
    maxTurns: number,
    result: SubagentSingleResult,
  ): void {
    // Every emission first syncs the live counters into the result; the
    // throttle/force cadence still lives in the run-level emitter.
    const emit = (force: boolean): void => {
      this._syncRunningProgress(result, counters);
      runState.emitProgress(force);
    };
    switch (event.type) {
      case "message_update": {
        if (event.message.role === "assistant") {
          counters.latestStreamingText = assistantText(event.message as AssistantMessage);
          emit(false);
        }
        break;
      }
      case "message_end": {
        if (event.message.role === "assistant") {
          const message = event.message as AssistantMessage;
          counters.lastAssistantMessage = message;
          const text = assistantText(message);
          if (text !== "") {
            counters.lastNonEmptyFinalizedText = text;
          }
          accumulateUsage(counters.usage, message.usage);
          emit(true);
        }
        break;
      }
      case "tool_execution_start": {
        counters.toolUseCount++;
        counters.activities.push({
          sequence: ++counters.sequence,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: "running",
          summary: summarizeActivity(event.args),
          startedAt: Date.now(),
        });
        emit(true);
        break;
      }
      case "tool_execution_end": {
        const activity = counters.activities.find((candidate) => candidate.toolCallId === event.toolCallId);
        if (activity && activity.status === "running") {
          activity.status = event.isError ? "failed" : "completed";
          activity.endedAt = Date.now();
        }
        emit(true);
        break;
      }
      case "turn_end": {
        counters.turnCount++;
        if (counters.turnCount >= maxTurns) {
          // Only arm the limit here; abort happens on a NEW turn_start proving
          // the loop really intends another turn.
          counters.limitArmed = true;
        }
        emit(false);
        break;
      }
      case "turn_start": {
        if (counters.limitArmed) {
          counters.limitArmed = false;
          control.fire("max_turns");
        }
        emit(false);
        break;
      }
      case "agent_end": {
        emit(false);
        break;
      }
      default:
        break;
    }
  }

  // =========================================================================
  // FIFO semaphore
  // =========================================================================

  private _acquireSlot(): { promise: Promise<void>; remove: () => void } {
    if (this._activeCount < MAX_ACTIVE_SUBAGENTS) {
      this._activeCount++;
      // Even an immediately granted slot must be releasable: the abort race
      // may settle on the control side before the slot promise.
      return {
        promise: Promise.resolve(),
        remove: () => {
          this._releaseSlot();
        },
      };
    }
    let granted = false;
    let waiter: { resolve: () => void; remove: () => void };
    const promise = new Promise<void>((resolve) => {
      waiter = {
        resolve: () => {
          granted = true;
          this._activeCount++;
          resolve();
        },
        remove: () => {
          if (granted) {
            // The slot was already granted in the same tick as the abort;
            // release it so the semaphore can never leak.
            this._releaseSlot();
            return;
          }
          const index = this._waiters.indexOf(waiter);
          if (index !== -1) {
            this._waiters.splice(index, 1);
          }
        },
      };
      this._waiters.push(waiter);
    });
    return {
      promise,
      remove: () => {
        waiter.remove();
      },
    };
  }

  private _releaseSlot(): void {
    this._activeCount = Math.max(0, this._activeCount - 1);
    const next = this._waiters.shift();
    if (next) {
      next.resolve();
    }
  }

  // =========================================================================
  // Result helpers
  // =========================================================================

  private _makePlaceholderResult(item: PreflightItem): SubagentSingleResult {
    return {
      id: randomUUID(),
      index: item.index,
      step: item.step,
      agentName: item.name,
      agentSource: item.definition?.source ?? "unknown",
      description: item.description,
      status: "queued",
      finalOutput: "",
      outputTruncated: false,
      originalOutputBytes: 0,
      toolUseCount: 0,
      activities: [],
      usage: emptyUsage(),
      model: item.modelLabel,
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
