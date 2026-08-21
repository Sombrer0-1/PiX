/**
 * The model-facing `workflow` tool (design plan section 4.7): runs a
 * JavaScript orchestration script that fans work out across many fresh
 * subagents and returns the script's final JSON value. The tool owns the
 * model-facing schema and the run lifecycle; parsing, execution, caps and
 * cancellation live behind the engine seam, so a hardened engine swaps in
 * without touching what the model sees.
 *
 * Locked behavior:
 * - executionMode "sequential": the run never overlaps other tools in a turn.
 * - Errors BEFORE start (missing session, META_INVALID / SCRIPT_PARSE /
 *   INVALID_ARGUMENT) and non-"completed" outcomes THROW (isError) - the
 *   agent tool's business-failure-as-success pattern does not apply here, and
 *   a partial value is never treated as success.
 * - Imports only the engine seam + runtime types + recorder + shared
 *   vocabulary: never host.ts / worker.ts / protocol.ts, never Vue/ipc/Pinia.
 * - Live onUpdate details carry the recorder's in-memory fold (same algorithm
 *   as the CustomEntry path) so live and restored views agree; the terminal
 *   stopReason is overlaid because the fold only learns it when finish()
 *   appends the run-end record, after this tool's result is computed.
 */

import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
  WORKFLOW_RECORD_SCHEMA_VERSION,
  WORKFLOW_TOOL_NAME,
  projectWorkflowStatus,
} from "../../shared/workflow-types.js";
import type {
  WorkflowResult,
  WorkflowRunId,
  WorkflowStopReason,
  WorkflowToolDetails,
  WorkflowViewState,
} from "../../shared/workflow-types.js";
// The seam vocabulary this tool depends on (S1): the engine abstraction.
// Start-time failures propagate untouched - classification is the worker
// combinators' job, not the tool's.
import type { WorkflowEngine } from "./engine/engine.js";
import type { WorkflowParentRef, WorkflowRun, WorkflowStartRequest } from "./engine/runtime-types.js";
import type { WorkflowRecorder } from "./recorder.js";

/** The host seam the workflow tool is bound to (design plan section 4.7). */
export interface WorkflowToolHost {
  engine: WorkflowEngine;
  recorder: WorkflowRecorder;
  /** Parent session for the tool call; throws when no session is active. */
  getParentRef(toolCallId: string): WorkflowParentRef;
}

/** Rendered-result ceiling: a longer output is truncated with a notice. */
const MAX_RESULT_CHARS = 50_000;

const TRUNCATION_NOTICE = "\n… [truncated]";

/** Bound the COMPLETE parent-facing text - envelope and notice included - to maxChars. */
function boundResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATION_NOTICE.length) return TRUNCATION_NOTICE.slice(0, maxChars);
  return `${text.slice(0, maxChars - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`;
}

const WorkflowParams = Type.Object({
  script: Type.String({
    minLength: 1,
    description:
      "The plain-JS workflow script body (top-level await allowed; NO `export const meta` statement; end with `return <json-value>`).",
  }),
  meta: Type.Object(
    {
      name: Type.String({ minLength: 1, description: "Short kebab-case workflow name." }),
      description: Type.String({ minLength: 1, description: "One-line description of what the workflow does." }),
      whenToUse: Type.Optional(Type.String({ description: "Optional guidance on when this workflow applies." })),
      phases: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.String({ minLength: 1, description: "The phase title phase() calls match by exact string." }),
            detail: Type.Optional(Type.String({ description: "Optional one-line description of the phase." })),
            provider: Type.Optional(Type.String({ description: "Optional provider override this phase is expected to use." })),
            model: Type.Optional(Type.String({ description: "Optional model override this phase is expected to use." })),
          }),
          { description: "Optional phase declarations matched by phase() calls." },
        ),
      ),
    },
    {
      additionalProperties: true,
      description: "The workflow identity block (plain JSON - never code); the engine white-lists the keys it validates.",
    },
  ),
  args: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          'Optional JSON input exposed to the script as the `args` global (a bare top-level array is forbidden - wrap it in a field, e.g. {"files": [...]}).',
      },
    ),
  ),
});

type WorkflowParamsStatic = Static<typeof WorkflowParams>;

/**
 * The script-authoring contract, embedded in the tool description. This IS the
 * model-facing spec: the meta block, the hooks and their exact semantics, the
 * supported schema subset, the rejected options, and the runtime constraints
 * (no fs/network/timers/Node API; foreground until the script ends).
 */
const DESCRIPTION = [
  "Run a JavaScript workflow script that orchestrates subagents at scale. Use this for work that fans out across many independent pieces - an audit over many files, a migration, multi-angle research, adversarial verification of findings - where you write the orchestration as a script instead of delegating turn by turn.",
  "",
  "The workflow's identity rides the `meta` parameter as JSON: required `name` (short kebab-case) and `description` strings, optional `whenToUse` string and `phases` array (`{title, detail?, provider?, model?}`). The `script` parameter is the plain JavaScript body ONLY (NOT TypeScript, and NO `export const meta` statement - meta is a parameter, not code), running with top-level await; end with `return <value>` - the value must be JSON-serializable and is this tool's result.",
  "",
  "Script-body hooks:",
  "- `agent(prompt, opts?): Promise<any>` - run one subagent to completion. Without `opts.schema` it resolves to the child's final text; with `opts.schema` (an object-rooted JSON Schema using ONLY type/properties/required/additionalProperties/items/enum/const/oneOf - nested nodes may be object, string, array, number, integer, or boolean; no pattern/format/numeric bounds) it resolves to the validated object. Resolves `null` when the child fails (filter with `.filter(Boolean)` and compare length to the input). Other opts: `label` (display), `phase` (progress group), independent `provider`/`model` LLM target overrides (`provider` is an agent definition name such as general-purpose, NOT an LLM vendor; `model` is a model id; either may be provided alone), `retry` (0-2; default 1 when `schema` is set, else 0; retries max_turns / missing structured submit / api_error and counts against the total-agent cap), `maxTurns` (1-50 nested LLM turns per child, not the workflow script; schema children default to 12). Anything else (`effort`/`isolation`/`agentType`) is rejected loudly.",
  "- `settled(prompt, opts?): Promise<{ok:true,value}|{ok:false,reason,message,stopReason}>` - same as agent() but never collapses a failure to null, so you can tell a real failure from a legitimate JSON null.",
  "- `stats(): {completed, failed, cancelled}` - running child-attempt counts (every retry is one attempt).",
  "- `pipeline(items, ...stages, opts?): Promise<any[]>` - run each item through the stages independently with NO barrier between stages (prefer this for multi-stage work). Each stage receives `(prev, item, index)`. An ordinary stage throw drops that ITEM to `null` and skips its remaining stages. Optional last argument `{ retry: 0-2 }` re-runs only items that resolved `null` (successes are not restarted).",
  "- `parallel(thunks, opts?): Promise<any[]>` - run zero-argument functions concurrently and await ALL of them (a barrier; use only when a stage genuinely needs every prior result together). A throwing thunk resolves to `null`. Optional second argument `{ retry: 0-2 }` re-runs only thunks that resolved `null`.",
  "- `phase(title)` - start a progress phase; `log(message)` - narrate progress; `args` - the tool call's `args` input, verbatim.",
  "",
  "Keep schema tasks small (few fields; issues as string arrays). Consume results only after filtering nulls and checking `out.length === items.length` or `stats().failed === 0`. Prefer `pipeline(items, stage, { retry: 1 })` so only failed items re-run. A finished workflow script is not checkpointed: to continue only failures after the tool returns, pass those labels/files into a new call.",
  "",
  "Misused hooks (bad arguments, unknown options, unsupported schemas, tripped caps) throw errors that ALWAYS kill the script - they never dissolve into a per-item `null`.",
  "",
  "Constraints: concurrency and total-agent caps apply; no filesystem, network, timers, or Node.js APIs are provided - the agents do the work, the script only coordinates them. The run executes in the foreground: this call returns when the whole script finishes.",
].join("\n");

function textContent(text: string): TextContent {
  return { type: "text", text };
}

/** Render a thrown value without trusting it. */
function renderThrown(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "[unrenderable thrown value]";
  }
}

/** A non-`completed` stop reason means the script did not finish cleanly. */
function stopReasonError(result: WorkflowResult): string | undefined {
  switch (result.stopReason) {
    case "completed":
      return undefined;
    case "cancelled":
      return `workflow run was cancelled${result.error !== undefined ? ` (${result.error})` : ""}`;
    case "error":
      return `workflow run failed: ${result.error ?? "unknown error"}`;
    default:
      // Defensive: WorkflowStopReason is a closed union; a future variant
      // fails loudly here instead of being silently treated as success.
      return `workflow run ended abnormally (${renderThrown(result.stopReason)})`;
  }
}

/** Render the run's outcome text: counts, item failures, then the JSON value (capped). */
function renderResult(name: string, result: WorkflowResult, maxChars: number): string {
  const rendered = JSON.stringify(result.value, null, 2) ?? "null";
  const started = result.agentsStarted;
  const stats = result.childStats;
  const failed = stats?.failed ?? 0;
  const cancelled = stats?.cancelled ?? 0;
  const ok = stats?.completed ?? 0;
  const countLabel =
    failed > 0 || cancelled > 0
      ? `${started} agent${started === 1 ? "" : "s"}, ${ok} ok / ${failed} failed${cancelled > 0 ? ` / ${cancelled} cancelled` : ""}`
      : `${started} agent${started === 1 ? "" : "s"}`;
  const lines = [`workflow "${name}" completed (${countLabel}).`];
  const failures = result.failures ?? [];
  if (failures.length > 0) {
    lines.push("Failures:");
    for (const failure of failures) {
      const detail = failure.message !== undefined && failure.message.length > 0 ? `${failure.reason}: ${failure.message}` : failure.reason;
      lines.push(`- ${failure.label}: ${detail}`);
    }
  }
  lines.push("Return value:", rendered);
  return boundResult(lines.join("\n"), maxChars);
}

/** Extra payload only the workflow/end event carries. */
interface UpdateExtras {
  agentsStarted?: number;
  /** Terminal overlay for the workflow/end event; undefined while running. */
  terminalStopReason?: WorkflowStopReason;
  /** workflow/end payload error, surfaced only on terminal updates. */
  error?: string;
}

/**
 * Push one live update. The view always comes from the recorder's in-memory
 * fold (same algorithm as the CustomEntry path); the terminal stopReason is
 * overlaid for the workflow/end event because the fold only learns it when
 * finish() appends the run-end record. Updates never carry the value.
 */
function pushUpdate(
  onUpdate: AgentToolUpdateCallback<WorkflowToolDetails> | undefined,
  recorder: WorkflowRecorder,
  runId: WorkflowRunId,
  statusLine: string,
  extras?: UpdateExtras,
): void {
  if (onUpdate === undefined) return;
  const folded = recorder.getSnapshot().find((run) => run.runId === runId);
  if (folded === undefined) return;
  const view =
    extras?.terminalStopReason === undefined
      ? folded
      : {
          ...folded,
          stopReason: extras.terminalStopReason,
          status: projectWorkflowStatus({ ...folded, stopReason: extras.terminalStopReason }),
        };
  const details: WorkflowToolDetails = {
    kind: "pix-workflow-run",
    schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION,
    view,
    value: null,
    agentsStarted: extras?.agentsStarted ?? folded.members.length,
  };
  if (extras?.error !== undefined) {
    details.error = extras.error;
  }
  onUpdate({ content: [textContent(statusLine)], details });
}

/** Subscribe the six observe-only engine events, filtered to this run. */
function subscribeRunUpdates(
  host: WorkflowToolHost,
  run: WorkflowRun,
  onUpdate: AgentToolUpdateCallback<WorkflowToolDetails> | undefined,
): Array<() => void> {
  const name = run.meta.name;
  const unsubscribes: Array<() => void> = [];
  unsubscribes.push(
    host.engine.on("workflow/phase", (info, title) => {
      if (info.id !== run.id || title.length === 0) return;
      pushUpdate(onUpdate, host.recorder, run.id, `workflow "${name}" phase: ${title}`);
    }),
  );
  unsubscribes.push(
    host.engine.on("workflow/log", (info, message) => {
      if (info.id !== run.id) return;
      pushUpdate(onUpdate, host.recorder, run.id, `workflow "${name}" log: ${message}`);
    }),
  );
  unsubscribes.push(
    host.engine.on("workflow/agent-start", (info, agent) => {
      if (info.id !== run.id) return;
      pushUpdate(onUpdate, host.recorder, run.id, `workflow "${name}" agent ${agent.seq} (${agent.label}) started`);
    }),
  );
  unsubscribes.push(
    host.engine.on("workflow/agent-end", (info, agent) => {
      if (info.id !== run.id) return;
      pushUpdate(
        onUpdate,
        host.recorder,
        run.id,
        agent.outcome === "failed" && agent.error !== undefined
          ? `workflow "${name}" agent ${agent.seq} (${agent.label}) failed (${agent.error})`
          : `workflow "${name}" agent ${agent.seq} (${agent.label}) ${agent.outcome}`,
      );
    }),
  );
  unsubscribes.push(
    host.engine.on("workflow/end", (info, result) => {
      if (info.id !== run.id) return;
      // Terminal live state: the fold carries no run-end yet, so the
      // stopReason is overlaid (the same projection the panel derives for a
      // finished run). The value stays null in updates; the final result
      // carries it.
      pushUpdate(onUpdate, host.recorder, run.id, `workflow "${name}" finished (${result.stopReason})`, {
        agentsStarted: result.agentsStarted,
        error: result.error,
        terminalStopReason: result.stopReason,
      });
    }),
  );
  return unsubscribes;
}

/** Assemble the final details for a completed run. */
function completedDetails(
  run: WorkflowRun,
  toolCallId: string,
  result: WorkflowResult,
  recorder: WorkflowRecorder,
): WorkflowToolDetails {
  const folded = recorder.getSnapshot().find((view) => view.runId === run.id);
  // The fold only ever misses a run when its recording is disabled; the
  // fallback still gives the panel a valid identity block.
  const fallback: WorkflowViewState = {
    runId: run.id,
    toolCallId,
    toolName: WORKFLOW_TOOL_NAME,
    name: run.meta.name,
    members: [],
    logs: [],
    status: "running",
  };
  const base = folded ?? fallback;
  return {
    kind: "pix-workflow-run",
    schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION,
    // The fold learns the terminal stopReason only when finish() appends the
    // run-end record, which happens after this result is computed - overlay it
    // so the panel sees a completed run on replay.
    view: {
      ...base,
      stopReason: result.stopReason,
      status: projectWorkflowStatus({ ...base, stopReason: result.stopReason }),
    },
    value: result.value,
    agentsStarted: result.agentsStarted,
  };
}

/**
 * Create the `workflow` ToolDefinition bound to the host seam (design plan
 * section 4.7). The execute lifecycle is shared with the ralph tool: parent
 * ref, start (synchronous failures throw), recorder.start, abort bridge,
 * observe-only event updates, await result, dispose + finish with abandon as
 * the fallback, and a throw for every non-"completed" stop reason.
 */
export function createWorkflowToolDefinition(host: WorkflowToolHost): ToolDefinition<typeof WorkflowParams, WorkflowToolDetails> {
  return {
    name: WORKFLOW_TOOL_NAME,
    label: "Workflow",
    description: DESCRIPTION,
    promptSnippet: "Run a JavaScript workflow script that orchestrates subagents at scale.",
    promptGuidelines: [
      "Use the workflow tool ONLY when the user explicitly asks for multi-subagent orchestration: you write a JavaScript script that fans work out across many subagents with phases and structured results.",
      "For one or two delegations, prefer the agent tool.",
      "Ralph is a separate tool; use it only when the user explicitly asks for fresh-agent iteration.",
      "Keep each child prompt and schema small; split heavy reports across stages or extra agent() calls. Filter nulls and compare counts before treating the return value as complete.",
      "opts.provider is an agent definition name (general-purpose, ...), not an LLM vendor. opts.model is the model id. Omit provider to use the run default.",
    ],
    parameters: WorkflowParams,
    executionMode: "sequential",
    async execute(
      toolCallId: string,
      params: WorkflowParamsStatic,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<WorkflowToolDetails> | undefined,
    ): Promise<AgentToolResult<WorkflowToolDetails>> {
      // Missing parent session: the host throws and the failure surfaces as
      // an isError result.
      const parent = host.getParentRef(toolCallId);
      const request: WorkflowStartRequest = {
        script: params.script,
        meta: params.meta,
        ...(params.args !== undefined ? { args: params.args } : {}),
        parent,
        signal,
      };
      // Bridge the tool's abort signal onto the run with the plan-locked
      // reason. The listener registers BEFORE engine.start so it fires ahead
      // of the engine's own signal listener: cancel() is first-write-wins,
      // and this ordering is what makes "parent step aborted" the effective
      // reason instead of the engine's generic one. The signal also enters
      // the engine directly as a safety net for implementations that would
      // ignore a bridged cancel.
      let startedRun: WorkflowRun | undefined;
      const onAbort = (): void => {
        startedRun?.cancel("parent step aborted");
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      // Meta/body validation failures (META_INVALID / SCRIPT_PARSE /
      // INVALID_ARGUMENT) throw synchronously before any run is published;
      // the agent loop turns the throw into an isError result and the model
      // sees the violation list.
      let run: WorkflowRun;
      try {
        run = host.engine.start(request);
      } catch (error) {
        signal?.removeEventListener("abort", onAbort);
        throw error;
      }
      startedRun = run;

      // Publish the durable run record and subscribe the live fold.
      host.recorder.start(run, toolCallId, WORKFLOW_TOOL_NAME);

      const unsubscribes = subscribeRunUpdates(host, run, onUpdate);

      let result: WorkflowResult | undefined;
      try {
        result = await run.result;
        const errorMessage = stopReasonError(result);
        if (errorMessage !== undefined) {
          // A non-"completed" stop reason means the script did not finish
          // cleanly: report the reason, never treat a partial value as
          // success.
          throw new Error(errorMessage);
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        try {
          // Keep the member listeners alive through disposal: the host may
          // synthesize cancelled member endings while reaching quiescence.
          await run.dispose();
          for (const unsubscribe of unsubscribes) unsubscribe();
          if (result === undefined) {
            // WorkflowRun.result never rejects by contract; this guards a
            // contract-violating engine.
            throw new Error("workflow run settled without a result");
          }
          host.recorder.finish(run.id, result.stopReason);
        } finally {
          // Fallback: if dispose or finish threw, leave no dangling run
          // record in the recorder.
          host.recorder.abandon(run.id);
        }
      }
      // Success path only: dispose() has flushed the host's stranded
      // agent-end synthesis and finish() has appended the run-end record, so
      // the fold is FINAL here. Computing the details snapshot after teardown
      // keeps a member whose ending landed after workflow/end (a discarded
      // script promise racing the exit sweep) from being frozen as running in
      // the persisted panel state.
      const settled = result as WorkflowResult;
      const content = textContent(renderResult(run.meta.name, settled, MAX_RESULT_CHARS));
      return { content: [content], details: completedDetails(run, toolCallId, settled, host.recorder) };
    },
  };
}
