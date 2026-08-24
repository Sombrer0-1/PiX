/**
 * The worker-thread engine: validates and pre-parses each start request,
 * spawns one Worker per run and owns the live-run registry `disposeAll()`
 * cancels and bounded-disposes. Invalid requests throw synchronously from
 * `start()` BEFORE anything is published (design principle 2); once a run is
 * returned, every failure resolves through `result.stopReason` instead.
 */

import { randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import * as vm from "node:vm";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_TASK_MAX_RUNNING_SLOTS } from "../../../shared/agent-task-types.js";
import { WorkflowRunId } from "../../../shared/workflow-types.js";
import { WorkflowEngine, WorkflowError } from "./engine.js";
import { WORKFLOW_APP_SHUTDOWN_CANCEL_REASON } from "./child-types.js";
import type { WorkflowEngineConfig, WorkflowRun, WorkflowStartRequest } from "./runtime-types.js";
import { validateMeta } from "./meta.js";
import type { WorkerInit, WorkerLimits } from "./child-types.js";
import { WorkerRun } from "./host.js";
import type { WorkflowChildSpawner } from "../child-spawner.js";

/** A body that still carries the Claude Code-style meta header (meta rides the request as data here). */
const META_STATEMENT = /^\s*export\s+const\s+meta\b/;

/** Config defaults per design plan §4.2. */
interface ResolvedConfig {
  maxConcurrentAgents: number; // 0 = auto
  maxTotalAgents: number;
  maxItemsPerCall: number;
  syncTimeoutMs: number;
  disposeGraceMs: number;
}

function defaultConfig(config: WorkflowEngineConfig | undefined): ResolvedConfig {
  return {
    maxConcurrentAgents: config?.maxConcurrentAgents ?? 0,
    maxTotalAgents: config?.maxTotalAgents ?? 1000,
    maxItemsPerCall: config?.maxItemsPerCall ?? 4096,
    syncTimeoutMs: config?.syncTimeoutMs ?? 5000,
    disposeGraceMs: config?.disposeGraceMs ?? 5000,
  };
}

/**
 * Parse-check the body with the SAME wrapper the worker-side runtime
 * compiles, so `start()` keeps the seam's synchronous SCRIPT_PARSE throw.
 * A body opening with `export const meta` gets a pointed message instead of
 * the wrapper's bare SyntaxError — the model's likeliest authoring slip.
 */
function assertBodyParses(body: string, name: string): void {
  if (META_STATEMENT.test(body)) {
    throw new WorkflowError(
      "workflow meta rides the `meta` request field, not the script: remove the `export const meta = {...}` statement from the body",
      "SCRIPT_PARSE",
    );
  }
  try {
    // Parse only — the script object is discarded, nothing executes.
    void new vm.Script(`(async () => {\n${body}\n})()`, { filename: `workflow:${name}`, lineOffset: -1 });
  } catch (error: unknown) {
    throw new WorkflowError(`workflow script does not parse: ${String(error)}`, "SCRIPT_PARSE", { cause: error });
  }
}

/** Resolve one run's total-child cap against the engine deployment ceiling. */
function resolveMaxTotalAgents(requested: number | undefined, ceiling: number): number {
  if (requested === undefined) return ceiling;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new WorkflowError("workflow maxTotalAgents must be a positive safe integer", "INVALID_ARGUMENT");
  }
  if (requested > ceiling) {
    throw new WorkflowError(
      `workflow maxTotalAgents ${requested} exceeds the engine ceiling ${ceiling}`,
      "INVALID_ARGUMENT",
    );
  }
  return requested;
}

/**
 * Resolve the per-run concurrency ceiling: 0 (the default) auto-resolves off
 * the machine's parallelism, and the RESOLVED value is always clamped into
 * [1, AGENT_TASK_MAX_RUNNING_SLOTS] — workflow children share the AgentTask
 * scheduler's four running slots, so a higher ceiling would only queue.
 */
function resolveMaxConcurrentAgents(requested: number | undefined): number {
  if (requested === undefined || requested === 0) {
    return Math.min(AGENT_TASK_MAX_RUNNING_SLOTS, Math.max(1, availableParallelism() - 2));
  }
  return Math.min(AGENT_TASK_MAX_RUNNING_SLOTS, Math.max(1, Math.floor(requested)));
}

/**
 * Rewrite an `app.asar` path segment into `app.asar.unpacked`, covering both
 * the `/` and `\` separators. Electron cannot load a Worker entry from inside
 * the asar archive, and ESM relative imports from an unpacked file stay on
 * the real filesystem (they do not re-enter the asar). package.json
 * `build.asarUnpack` therefore unpacks the whole `workflow/engine/` directory
 * — not just worker.js — including a colocated `{"type":"module"}`
 * package.json so the unpacked `.js` is still treated as ESM, and the entry
 * is redirected there.
 */
export function rewriteAsarWorkerPath(entry: string): string {
  return entry.replace(/[\\/]app\.asar[\\/]/, `${sep}app.asar.unpacked${sep}`);
}

/**
 * Resolve the worker entry. In the compiled build this module sits next to
 * worker.js under dist/main — locked: resolve relative to the COMPILED
 * file — and the asar rewrite may redirect it into app.asar.unpacked. When
 * this module itself runs unbuilt (tsx, e.g. the engine tests), the spawn
 * still clears execArgv, so tsx's loader is NOT inherited by the worker:
 * a data: bootstrap installs it in-thread and imports the sibling worker.ts
 * (the same URL the tests spawn directly). The PRODUCTION path never uses a
 * source-tsx bootstrap.
 */
export function resolveWorkerEntry(): string | URL {
  if (import.meta.url.endsWith(".ts")) {
    const workerEntry = new URL("./worker.ts", import.meta.url);
    const tsxEsmApiEntry = import.meta.resolve("tsx/esm/api");
    const tsxCjsApiEntry = import.meta.resolve("tsx/cjs/api");
    const bootstrap = [
      `import { register as registerEsm } from ${JSON.stringify(tsxEsmApiEntry)}`,
      `import { register as registerCjs } from ${JSON.stringify(tsxCjsApiEntry)}`,
      "registerCjs()",
      "registerEsm()",
      `await import(${JSON.stringify(workerEntry.href)})`,
    ].join("\n");
    return new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`);
  }
  return rewriteAsarWorkerPath(fileURLToPath(new URL("./worker.js", import.meta.url)));
}

/**
 * The worker-thread engine service. `start()` validates the script up front
 * (meta + a host-side body parse + argument clone) and returns a
 * {@link WorkflowRun} whose `result` never rejects; the `workflow/*` events
 * fire around the run per the seam contract.
 */
export class WorkerThreadWorkflowEngine extends WorkflowEngine {
  private readonly config: ResolvedConfig;
  private readonly live = new Map<WorkflowRunId, WorkerRun>();

  constructor(
    private readonly spawner: WorkflowChildSpawner,
    config?: WorkflowEngineConfig,
  ) {
    super(config);
    this.config = defaultConfig(config);
  }

  /**
   * Validate and execute a workflow script in a fresh worker thread. Throws
   * synchronously for a request that cannot begin (META_INVALID, SCRIPT_PARSE,
   * INVALID_ARGUMENT, or the args structured-clone failure rethrown as-is);
   * nothing is published before those checks pass.
   * @param request - the script body, its meta data and `args`, the parent
   *   agent, and an optional cancel signal.
   * @returns the live run (its `result` resolves when the script settles).
   */
  start(request: WorkflowStartRequest): WorkflowRun {
    const meta = validateMeta(request.meta);
    assertBodyParses(request.script, meta.name);
    const maxTotalAgents = resolveMaxTotalAgents(request.maxTotalAgents, this.config.maxTotalAgents);
    // Mirror workerData's structured clone so a clone failure throws out of
    // start() synchronously, before anything is published.
    const args = request.args === undefined ? undefined : structuredClone(request.args);
    const id = WorkflowRunId(randomUUID());
    const info = { id, meta };
    const limits: WorkerLimits = {
      maxConcurrentAgents: resolveMaxConcurrentAgents(this.config.maxConcurrentAgents),
      maxTotalAgents,
      maxItemsPerCall: this.config.maxItemsPerCall,
      syncTimeoutMs: this.config.syncTimeoutMs,
    };
    const init: WorkerInit = {
      meta,
      body: request.script,
      ...args !== undefined ? { args } : {},
      limits,
      ...request.subagentProvider !== undefined ? { runDefault: request.subagentProvider } : {},
    };
    const run = new WorkerRun(
      this.spawner,
      request.parent,
      id,
      meta,
      init,
      resolveWorkerEntry(),
      this.config.disposeGraceMs,
      {
        phase: (title) => {
          this.emit("workflow/phase", info, title);
        },
        log: (message) => {
          this.emit("workflow/log", info, message);
        },
        agentStart: (agent) => {
          this.emit("workflow/agent-start", info, agent);
        },
        agentEnd: (agent) => {
          this.emit("workflow/agent-end", info, agent);
        },
      },
      request.signal,
    );
    this.live.set(id, run);
    this.emit("workflow/start", info);
    // `workflow/end` fires as the (never-rejecting) result settles, with the
    // outcome DATA only — the value stays with the run's holder. The live
    // registry entry leaves once the run is terminal: disposeAll only owns
    // UNSETTLED runs, so a finished run must not linger here for the rest of
    // the session (long-lived sessions would grow the map linearly).
    void run.result.then((settled) => {
      this.live.delete(id);
      this.emit("workflow/end", info, {
        stopReason: settled.stopReason,
        ...settled.error !== undefined ? { error: settled.error } : {},
        agentsStarted: settled.agentsStarted,
        ...settled.childStats !== undefined ? { childStats: settled.childStats } : {},
      });
    });
    return run;
  }

  /**
   * Cancel + bounded-dispose every live run. Each run's dispose is itself
   * bounded by disposeGraceMs and guarantees the worker's terminate() is
   * issued, so this resolves after every registered child's cancellation has
   * settled or the grace elapsed. Idempotent.
   * @param appShuttingDown - true on the whole-app teardown path (bridge
   *   `_appShuttingDown`): cancelled children record the AgentTaskStopReason
   *   "app_shutdown" instead of "user_cancel", so recovery after restart
   *   shows them as interrupted like every other shutdown-cancelled task.
   */
  async disposeAll(appShuttingDown = false): Promise<void> {
    const reason = appShuttingDown ? WORKFLOW_APP_SHUTDOWN_CANCEL_REASON : "session closing";
    const runs = [...this.live.values()];
    for (const run of runs) {
      run.cancel(reason);
    }
    await Promise.all(runs.map((run) => run.dispose()));
  }
}
