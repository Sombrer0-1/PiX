/**
 * The worker-side script runtime: vm hooks, concurrency slots, caps,
 * cancellation and result serialization. Constructed per run by the session;
 * `drive()` is called exactly once and NEVER rejects — every failure becomes
 * a WorkflowResult with a non-"completed" stop reason. Script values leaving
 * the realm are materialized as plain host JSON before they cross the port;
 * values entering the trusted model-written realm are passed directly (`args`
 * alone was structured-cloned as workerData, so script mutation cannot alter
 * initialization data). See realm.ts for the trust model.
 *
 * Fatal WorkflowErrors — bad hook arguments, unsupported schemas/options,
 * caps, start failures and cancellation — propagate through the combinators.
 * Only child failures and ordinary stage errors become per-item nulls. Every
 * returned promise has a rejection consumer so dropped script promises cannot
 * kill the worker. A cancelled script that never settles emits nothing; the
 * host force-settles the run within grace and terminates the thread.
 */

import * as vm from "node:vm";
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowChildFailure,
  WorkflowChildStats,
  WorkflowMeta,
  WorkflowResult,
} from "../../../shared/workflow-types.js";
import { isFatalWorkflowError, WorkflowError } from "./engine.js";
import { MaterializeError, materializeFromRealm, renderThrown } from "./realm.js";
import { assertObjectJsonSchema } from "./schema.js";
import type { ObjectJsonSchema } from "./schema.js";
import type { ChildHandle, ChildPort, ChildResult, WorkerLimits } from "./child-types.js";
import { DEFAULT_SCHEMA_CHILD_RETRY, SCHEMA_CHILD_DEFAULT_MAX_TURNS } from "./child-types.js";

/** The observers the execution reports progress through (the session posts them to the host). */
export interface ExecutionObserver {
  phase(title: string): void;
  log(message: string): void;
  agentStart(info: WorkflowAgentInfo): void;
  agentEnd(info: WorkflowAgentEndInfo): void;
}

/** The `agent()` options the script may pass; everything else rejects loud. */
const SUPPORTED_AGENT_OPTIONS = new Set(["label", "phase", "schema", "provider", "model", "retry", "maxTurns"]);
/** Deferred Claude Code options we name explicitly in the rejection message. */
const DEFERRED_AGENT_OPTIONS = new Set(["effort", "isolation", "agentType"]);

const SUPPORTED_OPTION_LIST = "label, phase, schema, provider, model, retry, maxTurns";
const MAX_AGENT_RETRY = 2;
const MAX_REPORTED_FAILURES = 32;
const MAX_CHILD_MAX_TURNS = 50;
const RETRYABLE_FAILURE_REASONS = new Set(["max_turns", "invalid_parameters", "api_error"]);

interface AgentHookOptions {
  label?: string;
  phase?: string;
  provider?: string;
  model?: string;
  schema?: ObjectJsonSchema;
  retry: number;
  maxTurns?: number;
}

type SettledOk = { ok: true; value: unknown };
type SettledFail = { ok: false; reason: string; message: string; stopReason: string };
type SettledResult = SettledOk | SettledFail;

/** Flatten a child's final text output blocks to one string (the non-schema `agent()` result). */
function outputText(blocks: Array<{ type: "text"; text: string }>): string {
  return blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function formatChildError(reason: string | undefined, message: string | undefined): string {
  if (reason !== undefined && message !== undefined && message.length > 0) {
    return `${reason}: ${message}`;
  }
  if (message !== undefined && message.length > 0) return message;
  return reason ?? "failed";
}

/** A short display label derived from the prompt when the script passes none. */
function defaultLabel(prompt: string): string {
  const newline = prompt.indexOf("\n");
  const line = newline === -1 ? prompt : prompt.slice(0, newline);
  return line.length <= 48 ? line : `${line.slice(0, 47)}…`;
}

/**
 * One live script execution inside the worker. `drive()` is called exactly
 * once and never rejects; the host owns cancellation and cleanup of any
 * dropped child work.
 */
export class WorkflowExecution {
  /** 1-based count of `agent()` calls started (the `agentsStarted` result field). */
  private started = 0;
  private activeSlots = 0;
  private readonly slotWaiters: { resolve(): void; reject(error: unknown): void }[] = [];
  private cancelReason: string | undefined;
  private cancelError: WorkflowError | undefined;
  private currentPhase: string | undefined;
  private readonly childStats: WorkflowChildStats = { completed: 0, failed: 0, cancelled: 0 };
  private readonly failures: WorkflowChildFailure[] = [];
  private readonly context: vm.Context;
  private readonly compiled: vm.Script;

  constructor(
    meta: WorkflowMeta,
    body: string,
    args: unknown,
    private readonly limits: WorkerLimits,
    private readonly observer: ExecutionObserver,
    private readonly children: ChildPort,
    private readonly runDefault?: string,
  ) {
    // Compile FIRST: a body syntax error must throw out of the constructor
    // before any realm state exists. The host pre-parses the identical
    // wrapper, so under one Node version this throw is unreachable in
    // production — the session still maps it to an error result defensively.
    // lineOffset compensates for the wrapper line, so stack traces carry the
    // script's own line numbers.
    try {
      this.compiled = new vm.Script(`(async () => {\n${body}\n})()`, {
        filename: `workflow:${meta.name}`,
        lineOffset: -1,
      });
    } catch (error: unknown) {
      throw new WorkflowError(`workflow script does not parse: ${String(error)}`, "SCRIPT_PARSE", { cause: error });
    }

    this.context = vm.createContext({}, { name: `workflow:${meta.name}` });

    const globals: Record<string, unknown> = {
      agent: (prompt: unknown, opts?: unknown) => this.contain(this.agent(prompt, opts)),
      settled: (prompt: unknown, opts?: unknown) => this.contain(this.settled(prompt, opts)),
      stats: () => this.stats(),
      parallel: (thunks: unknown, opts?: unknown) => this.contain(this.parallel(thunks, opts)),
      pipeline: (items: unknown, ...stages: unknown[]) => this.contain(this.pipeline(items, stages)),
      phase: (title: unknown) => {
        this.phase(title);
      },
      log: (message: unknown) => {
        this.log(message);
      },
      // workerData already performed the real cross-thread structured clone.
      args,
    };
    for (const [key, value] of Object.entries(globals)) {
      // Freeze the hook functions so a script cannot observe/replace the
      // closing over `this`; `args` stays a plain data value. A script
      // overwriting its own globals only sabotages itself.
      (this.context as Record<string, unknown>)[key] = typeof value === "function" ? Object.freeze(value) : value;
    }
  }

  /**
   * Whether the run has been cancelled. A METHOD, not an inline property
   * read: `cancel()` mutates `cancelReason` concurrently (the session's
   * message handler), and an inline read after an `await` gets narrowed by
   * control flow into an always-false comparison.
   */
  private isCancelled(): boolean {
    return this.cancelReason !== undefined;
  }

  /**
   * Shared hook entry guard: after {@link cancel}, EVERY hook throws
   * `CANCELLED` at its next call — cancellation is the next HOOK boundary,
   * not just the next `agent()`, so a script that caught one cancelled
   * rejection cannot keep emitting progress through `phase`/`log` or enter a
   * combinator.
   */
  private throwIfCancelled(): void {
    if (this.isCancelled()) throw this.cancelledError();
  }

  /**
   * Cancel the run: waiting `agent()` slots reject and every future hook call
   * throws `CANCELLED` — the script dies at its next await. A script that
   * never settles anyway (parked on a promise no hook owns) is the HOST's
   * problem: its grace timer force-settles the run and terminates the
   * worker. Idempotent; the first reason wins.
   * @param reason - human-readable cause carried on the CANCELLED error. The
   * host independently aborts the signal shared by every child.
   */
  cancel(reason: string): void {
    if (this.cancelReason !== undefined) return;
    this.cancelReason = reason;
    this.cancelError = new WorkflowError(`workflow run cancelled: ${this.cancelReason}`, "CANCELLED");
    for (const waiter of this.slotWaiters.splice(0)) waiter.reject(this.cancelledError());
  }

  /**
   * Run the script to settlement. Resolves — never rejects — with the run's
   * {@link WorkflowResult}: the materialized return value on `completed`, the
   * failure message on `error`, and `cancelled` when the script died of
   * cancellation. This method only chooses the result; the session publishes
   * it and the host owns terminal child cancellation.
   * @returns the settled outcome — this promise NEVER rejects (the seam's
   * `result`-never-rejects contract); every failure maps to a variant.
   */
  async drive(): Promise<WorkflowResult> {
    try {
      // Cancelled before the body ever ran (an already-aborted start signal,
      // relayed by the host before its `go`): the script must not execute at
      // all, let alone report `completed`.
      if (this.isCancelled()) throw this.cancelledError();
      // The vm timeout only guards the INITIAL SYNCHRONOUS slice: an async
      // body that yields past its first await runs without a wall-clock cap
      // (the host's grace timer owns unbounded scripts).
      const scriptPromise = this.compiled.runInContext(this.context, { timeout: this.limits.syncTimeoutMs }) as Promise<unknown>;
      const raw: unknown = await this.contain(Promise.resolve(scriptPromise));
      // Cancelled while the body ran: a script that settled without touching
      // another hook (or without any) must still report `cancelled` — the
      // holder asked for cancellation and `completed` would be a lie.
      if (this.isCancelled()) throw this.cancelledError();
      const value = raw === undefined ? null : this.materializeResult(raw);
      return { value, stopReason: "completed", agentsStarted: this.started, ...this.resultExtras() };
    } catch (error: unknown) {
      // Any failure after cancel() reports `cancelled` with the canonical
      // reason — the reject path mirrors the resolve path's post-settle check.
      if (this.isCancelled()) {
        return {
          value: null,
          stopReason: "cancelled",
          error: this.cancelledError().message,
          agentsStarted: this.started,
          ...this.resultExtras(),
        };
      }
      // renderThrown is total (thrown values of any realm), so this arm
      // cannot throw — drive() resolving is the `result` never-rejects
      // contract.
      return {
        value: null,
        stopReason: "error",
        error: renderThrown(error),
        agentsStarted: this.started,
        ...this.resultExtras(),
      };
    }
  }

  /**
   * Attach a no-op rejection consumer WITHOUT changing what the caller
   * receives: if the script drops the promise (no await), cancellation cannot
   * become an unhandled rejection (which would kill the worker thread); if
   * the script does await it, it still observes the rejection.
   */
  private contain<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => {
      /* consumed: a dropped hook promise must not surface an unhandled rejection */
    });
    return promise;
  }

  private cancelledError(): WorkflowError {
    // cancel() arms cancelError before any caller can observe isCancelled()
    // === true; the fallback guards the type, not a reachable path.
    return this.cancelError ?? new WorkflowError("workflow run cancelled", "CANCELLED");
  }

  /** Materialize the script's return value; violations become RESULT_UNSERIALIZABLE. */
  private materializeResult(raw: unknown): unknown {
    try {
      return materializeFromRealm(raw, "workflow result");
    } catch (error: unknown) {
      // materializeFromRealm only throws MaterializeError; the guard keeps
      // the arm narrow rather than swallowing foreign errors.
      if (!(error instanceof MaterializeError)) throw error;
      throw new WorkflowError(
        `the workflow's return value is not plain JSON data — ${error.message}. Return only JSON-serializable objects/arrays/scalars.`,
        "RESULT_UNSERIALIZABLE",
        { cause: error },
      );
    }
  }

  /**
   * Acquire one concurrency slot (FIFO). Cancellation rejects QUEUED waiters
   * (see {@link cancel}); the callers guard their own entry and post-acquire
   * windows, so no cancelled-precheck is duplicated here.
   */
  private acquireSlot(): Promise<void> {
    if (this.activeSlots < this.limits.maxConcurrentAgents) {
      this.activeSlots += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.slotWaiters.push({
        resolve: () => {
          this.activeSlots += 1;
          resolve();
        },
        reject,
      });
    });
  }

  private releaseSlot(): void {
    this.activeSlots -= 1;
    const next = this.slotWaiters.shift();
    if (next) next.resolve();
  }

  private resultExtras(): { childStats: WorkflowChildStats; failures?: WorkflowChildFailure[] } {
    return {
      childStats: { ...this.childStats },
      ...(this.failures.length > 0 ? { failures: this.failures.slice() } : {}),
    };
  }

  /** Snapshot of child outcomes; scripts compare lengths before consuming nulls. */
  private stats(): WorkflowChildStats {
    this.throwIfCancelled();
    return { ...this.childStats };
  }

  /** Tagged `agent()` result: `{ ok, value }` or `{ ok: false, reason, message, stopReason }`. */
  private async settled(rawPrompt: unknown, rawOpts: unknown): Promise<SettledResult> {
    return this.runSettled(rawPrompt, rawOpts);
  }

  /** The `agent(prompt, opts)` hook. Failures still resolve `null` (CC contract). */
  private async agent(rawPrompt: unknown, rawOpts: unknown): Promise<unknown> {
    const settled = await this.runSettled(rawPrompt, rawOpts);
    return settled.ok ? settled.value : null;
  }

  private async runSettled(rawPrompt: unknown, rawOpts: unknown): Promise<SettledResult> {
    this.throwIfCancelled();
    if (typeof rawPrompt !== "string" || rawPrompt.length === 0) {
      throw new WorkflowError("agent() requires a non-empty prompt string", "INVALID_ARGUMENT");
    }
    const opts = this.readAgentOptions(rawOpts);
    const label = opts.label ?? defaultLabel(rawPrompt);
    const phase = opts.phase ?? this.currentPhase;

    await this.acquireSlot();
    try {
      this.throwIfCancelled();
      let lastFail: SettledFail | undefined;
      for (let attempt = 0; attempt <= opts.retry; attempt++) {
        if (this.started >= this.limits.maxTotalAgents) {
          if (attempt === 0) {
            throw new WorkflowError(
              `this run reached its total agent cap (${this.limits.maxTotalAgents}) — a runaway-loop backstop; raise the applicable maxTotalAgents limit if the scale is intentional`,
              "AGENT_CAP",
            );
          }
          this.log(`agent "${label}" retry skipped: total agent cap (${this.limits.maxTotalAgents})`);
          break;
        }
        this.started += 1;
        const seq = this.started;
        if (attempt > 0) {
          this.log(
            `agent "${label}" retry ${attempt}/${opts.retry} after ${lastFail?.reason ?? "failure"}: ${lastFail?.message ?? ""}`.trim(),
          );
        }
        const settled = await this.runOneChild(rawPrompt, opts, seq, label, phase);
        if (settled.ok) {
          return settled;
        }
        lastFail = settled;
        if (attempt < opts.retry && RETRYABLE_FAILURE_REASONS.has(settled.reason)) {
          continue;
        }
        break;
      }
      return lastFail ?? { ok: false, reason: "failed", message: "child failed", stopReason: "failed" };
    } finally {
      this.releaseSlot();
    }
  }

  private async runOneChild(
    prompt: string,
    opts: AgentHookOptions,
    seq: number,
    label: string,
    phase: string | undefined,
  ): Promise<SettledResult> {
    let run: ChildHandle;
    try {
      run = await this.children.startAgent({
        prompt,
        label,
        ...this.runDefault !== undefined ? { providerDefault: this.runDefault } : {},
        ...opts.schema !== undefined ? { schema: opts.schema } : {},
        ...opts.provider !== undefined ? { provider: opts.provider } : {},
        ...opts.model !== undefined ? { model: opts.model } : {},
        ...this.childMaxTurns(opts) !== undefined ? { maxTurns: this.childMaxTurns(opts) } : {},
      });
    } catch (error: unknown) {
      if (this.isCancelled()) throw this.cancelledError();
      throw new WorkflowError(`agent() could not start a child: ${renderThrown(error)}`, "AGENT_START", { cause: error });
    }
    if (this.isCancelled()) {
      await run.dispose();
      throw this.cancelledError();
    }
    const info: WorkflowAgentInfo = { seq, label, ...phase !== undefined ? { phase } : {}, childId: run.id };
    this.observer.agentStart(info);
    try {
      let result: ChildResult;
      try {
        result = await run.result;
      } catch (error: unknown) {
        if (this.isCancelled()) {
          this.noteChildEnd(info, "cancelled");
          throw this.cancelledError();
        }
        const message = renderThrown(error);
        this.noteChildEnd(info, "failed", "AGENT_RESULT", message);
        throw new WorkflowError(`child agent run failed: ${message}`, "AGENT_RESULT", { cause: error });
      }
      if (result.stopReason === "completed") {
        if (opts.schema !== undefined && result.structured === undefined) {
          const reason = result.failureReason ?? "invalid_parameters";
          const message = result.error ?? "completed without a structured submit";
          this.noteChildEnd(info, "failed", reason, message);
          this.log(`agent "${label}" ended failed (${reason}: ${message})`);
          return { ok: false, reason, message, stopReason: result.stopReason };
        }
        this.noteChildEnd(info, "completed");
        return { ok: true, value: opts.schema !== undefined ? result.structured : outputText(result.output) };
      }
      if (this.isCancelled()) {
        this.noteChildEnd(info, "cancelled", result.failureReason, result.error);
        throw this.cancelledError();
      }
      const reason = result.failureReason ?? result.stopReason;
      const message = result.error ?? `ended ${result.stopReason}`;
      this.noteChildEnd(info, "failed", reason, message);
      this.log(`agent "${label}" ended failed (${reason}: ${message})`);
      return { ok: false, reason, message, stopReason: result.stopReason };
    } finally {
      await run.dispose();
    }
  }

  private childMaxTurns(opts: AgentHookOptions): number | undefined {
    if (opts.maxTurns !== undefined) return opts.maxTurns;
    if (opts.schema !== undefined) return SCHEMA_CHILD_DEFAULT_MAX_TURNS;
    return undefined;
  }

  private noteChildEnd(
    info: WorkflowAgentInfo,
    outcome: "completed" | "failed" | "cancelled",
    reason?: string,
    message?: string,
  ): void {
    this.childStats[outcome] += 1;
    const error =
      outcome === "completed" || (reason === undefined && (message === undefined || message.length === 0))
        ? undefined
        : formatChildError(reason, message);
    this.observer.agentEnd(error !== undefined ? { ...info, outcome, error } : { ...info, outcome });
    if (outcome === "failed") {
      const failure: WorkflowChildFailure = {
        label: info.label,
        reason: reason ?? "failed",
        ...(message !== undefined && message.length > 0 ? { message } : {}),
      };
      if (this.failures.length < MAX_REPORTED_FAILURES) {
        this.failures.push(failure);
      }
    }
  }

  /** Materialize + validate the `agent()` options bag from the realm. */
  private readAgentOptions(rawOpts: unknown): AgentHookOptions {
    if (rawOpts === undefined) return { retry: 0 };
    let opts: unknown;
    try {
      opts = materializeFromRealm(rawOpts, "agent() options");
    } catch (error: unknown) {
      if (!(error instanceof MaterializeError)) throw error;
      throw new WorkflowError(`agent() options must be plain JSON data — ${error.message}`, "INVALID_ARGUMENT", { cause: error });
    }
    if (typeof opts !== "object" || opts === null || Array.isArray(opts)) {
      throw new WorkflowError("agent() options must be an object", "INVALID_ARGUMENT");
    }
    const record = opts as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (SUPPORTED_AGENT_OPTIONS.has(key)) continue;
      if (DEFERRED_AGENT_OPTIONS.has(key)) {
        throw new WorkflowError(
          `agent() option "${key}" is deferred and not supported by this engine (supported: ${SUPPORTED_OPTION_LIST})`,
          "UNSUPPORTED_OPTION",
        );
      }
      throw new WorkflowError(
        `agent() option "${key}" is not recognized (supported: ${SUPPORTED_OPTION_LIST})`,
        "UNSUPPORTED_OPTION",
      );
    }
    for (const key of ["label", "phase", "provider", "model"] as const) {
      if (record[key] !== undefined && typeof record[key] !== "string") {
        throw new WorkflowError(`agent() option "${key}" must be a string`, "INVALID_ARGUMENT");
      }
    }
    let retry: number | undefined;
    if (record.retry !== undefined) {
      retry = this.readRetryCount(record.retry, "agent()");
    }
    let maxTurns: number | undefined;
    if (record.maxTurns !== undefined) {
      if (
        typeof record.maxTurns !== "number" ||
        !Number.isSafeInteger(record.maxTurns) ||
        record.maxTurns < 1 ||
        record.maxTurns > MAX_CHILD_MAX_TURNS
      ) {
        throw new WorkflowError(
          `agent() option "maxTurns" must be an integer between 1 and ${MAX_CHILD_MAX_TURNS}`,
          "INVALID_ARGUMENT",
        );
      }
      maxTurns = record.maxTurns;
    }
    let schema: ObjectJsonSchema | undefined;
    if (record.schema !== undefined) {
      assertObjectJsonSchema(record.schema);
      schema = record.schema;
    }
    return {
      retry: retry ?? (schema !== undefined ? DEFAULT_SCHEMA_CHILD_RETRY : 0),
      ...record.label !== undefined ? { label: record.label as string } : {},
      ...record.phase !== undefined ? { phase: record.phase as string } : {},
      ...record.provider !== undefined ? { provider: record.provider as string } : {},
      ...record.model !== undefined ? { model: record.model as string } : {},
      ...schema !== undefined ? { schema } : {},
      ...maxTurns !== undefined ? { maxTurns } : {},
    };
  }

  /** Integer 0–MAX_AGENT_RETRY used by `agent()`, `pipeline()`, and `parallel()`. */
  private readRetryCount(raw: unknown, hook: string): number {
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > MAX_AGENT_RETRY) {
      throw new WorkflowError(
        `${hook} option "retry" must be an integer between 0 and ${MAX_AGENT_RETRY}`,
        "INVALID_ARGUMENT",
      );
    }
    return raw;
  }

  /**
   * Peel a trailing `{ retry }` options bag. A last function/array/scalar stays
   * a stage or is rejected by the caller; only a plain object is options.
   */
  private peelRetryOption(rawArgs: unknown[], hook: string): { args: unknown[]; retry: number } {
    if (rawArgs.length === 0) return { args: rawArgs, retry: 0 };
    const last = rawArgs[rawArgs.length - 1];
    if (typeof last !== "object" || last === null || Array.isArray(last)) {
      return { args: rawArgs, retry: 0 };
    }
    let opts: unknown;
    try {
      opts = materializeFromRealm(last, `${hook} options`);
    } catch (error: unknown) {
      if (!(error instanceof MaterializeError)) throw error;
      throw new WorkflowError(`${hook} options must be plain JSON data — ${error.message}`, "INVALID_ARGUMENT", {
        cause: error,
      });
    }
    if (typeof opts !== "object" || opts === null || Array.isArray(opts)) {
      throw new WorkflowError(`${hook} options must be an object`, "INVALID_ARGUMENT");
    }
    const record = opts as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key === "retry") continue;
      throw new WorkflowError(
        `${hook} option "${key}" is not recognized (supported: retry)`,
        "UNSUPPORTED_OPTION",
      );
    }
    const retry = record.retry !== undefined ? this.readRetryCount(record.retry, hook) : 0;
    return { args: rawArgs.slice(0, -1), retry };
  }

  private readCombinatorRetry(rawOpts: unknown, hook: string): number {
    if (rawOpts === undefined) return 0;
    return this.peelRetryOption([rawOpts], hook).retry;
  }

  private async retryNullItems(
    results: unknown[],
    retry: number,
    hook: string,
    rerun: (index: number) => Promise<unknown>,
  ): Promise<unknown[]> {
    for (let attempt = 0; attempt < retry; attempt++) {
      const failed: number[] = [];
      for (let index = 0; index < results.length; index++) {
        if (results[index] === null) failed.push(index);
      }
      if (failed.length === 0) break;
      this.log(`${hook} retry ${attempt + 1}/${retry}: ${failed.length} item(s)`);
      const again = await Promise.all(failed.map((index) => rerun(index)));
      for (let i = 0; i < failed.length; i++) {
        results[failed[i]!] = again[i];
      }
    }
    return results;
  }

  /** The `parallel(thunks, opts?)` hook: each thunk caught → `null`; fatal errors propagate. */
  private async parallel(rawThunks: unknown, rawOpts?: unknown): Promise<unknown[]> {
    this.throwIfCancelled();
    if (!Array.isArray(rawThunks)) {
      throw new WorkflowError("parallel() requires an array of zero-argument functions", "INVALID_ARGUMENT");
    }
    this.assertItemCap(rawThunks.length, "parallel()");
    const retry = this.readCombinatorRetry(rawOpts, "parallel()");
    const thunks = rawThunks.map((thunk, index) => {
      if (typeof thunk !== "function") {
        throw new WorkflowError(`parallel() item ${index} is not a function`, "INVALID_ARGUMENT");
      }
      return thunk as () => unknown;
    });
    const runThunk = async (index: number): Promise<unknown> => {
      try {
        return await thunks[index]!();
      } catch (error: unknown) {
        // Hook failures are WorkflowErrors built OUTSIDE the script's realm;
        // fatality is recognized by `instanceof` against this realm's class —
        // a script-built object can never pass it, so fatality cannot be
        // forged (nor accidentally dissolved).
        if (isFatalWorkflowError(error)) throw error;
        this.log(`parallel item ${index} failed: ${renderThrown(error)}`);
        return null;
      }
    };
    const results = await Promise.all(thunks.map((_, index) => runThunk(index)));
    return this.retryNullItems(results, retry, "parallel()", runThunk);
  }

  /** The `pipeline(items, ...stages, opts?)` hook: per-item stage chains, NO cross-stage barrier. */
  private async pipeline(rawItems: unknown, rawStages: unknown[]): Promise<unknown[]> {
    this.throwIfCancelled();
    if (!Array.isArray(rawItems)) {
      throw new WorkflowError("pipeline() requires an items array", "INVALID_ARGUMENT");
    }
    this.assertItemCap(rawItems.length, "pipeline()");
    const { args: stageArgs, retry } = this.peelRetryOption(rawStages, "pipeline()");
    if (stageArgs.length === 0) {
      throw new WorkflowError("pipeline() requires at least one stage function", "INVALID_ARGUMENT");
    }
    const stages = stageArgs.map((stage, index) => {
      if (typeof stage !== "function") {
        throw new WorkflowError(`pipeline() stage ${index} is not a function`, "INVALID_ARGUMENT");
      }
      return stage as (previous: unknown, item: unknown, index: number) => unknown;
    });
    const runItem = async (index: number): Promise<unknown> => {
      let value: unknown = rawItems[index];
      try {
        for (const stage of stages) {
          value = await stage(value, rawItems[index], index);
        }
        return value;
      } catch (error: unknown) {
        // An ordinary stage throw drops the ITEM to null and skips its
        // remaining stages; a fatal WorkflowError (see parallel()) kills the
        // whole script.
        if (isFatalWorkflowError(error)) throw error;
        this.log(`pipeline item ${index} failed: ${renderThrown(error)}`);
        return null;
      }
    };
    const results = await Promise.all(rawItems.map((_, index) => runItem(index)));
    return this.retryNullItems(results, retry, "pipeline()", runItem);
  }

  private assertItemCap(length: number, hook: string): void {
    if (length > this.limits.maxItemsPerCall) {
      throw new WorkflowError(
        `${hook} received ${length} items — over the per-call cap (${this.limits.maxItemsPerCall}); split the work or raise maxItemsPerCall in the engine config`,
        "ITEM_CAP",
      );
    }
  }

  /** The `phase(title)` hook: sets the current label for subsequent `agent()` calls and notifies observers. */
  private phase(title: unknown): void {
    this.throwIfCancelled();
    if (typeof title !== "string" || title.length === 0) {
      throw new WorkflowError("phase() requires a non-empty title string", "INVALID_ARGUMENT");
    }
    this.currentPhase = title;
    this.observer.phase(title);
  }

  /** The `log(message)` hook: narration to observers. */
  private log(message: unknown): void {
    this.throwIfCancelled();
    if (typeof message !== "string") {
      throw new WorkflowError("log() requires a message string", "INVALID_ARGUMENT");
    }
    this.observer.log(message);
  }
}
