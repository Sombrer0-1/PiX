/**
 * The model-facing `ralph` tool (design plan section 4.7): a fixed,
 * deployment-owned Ralph loop. Every round starts a fresh structured-output
 * child via agent(..., { schema: reportSchema }); only a bounded structured
 * report crosses rounds. The model supplies the immutable objective and an
 * optional round cap - it cannot alter the loop, the provider route, the
 * schema, or the handoff validation.
 *
 * Locked behavior:
 * - RALPH_META / RALPH_SCRIPT are ported faithfully from dsh (the script still
 *   uses agent(..., { schema: reportSchema })). maxTotalAgents = maxRounds and
 *   subagentProvider is passed to the engine (pix default "general-purpose",
 *   not dsh's "spawn"; the pix ceiling is 64 rounds, not dsh's 256).
 * - Errors BEFORE start (missing session, empty objective, round cap above the
 *   deployment ceiling) and non-"completed" outcomes THROW (isError); a
 *   round-failed terminal value is an error, never a partial success.
 * - Tool-side readReport / readRunResult enforce the EXACT key set
 *   "blocker,evidence,nextSteps,status,summary" with string equality after
 *   trim; the handoff is never silently truncated - an oversized report
 *   rejects instead.
 * - The rendering envelope matches dsh; content returned to the model stays
 *   English (Chinese UI labels belong to the panel only).
 * - Imports only the engine seam + runtime types + recorder + shared
 *   vocabulary: never host.ts / worker.ts / protocol.ts.
 */

import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
  RALPH_TOOL_NAME,
  WORKFLOW_RECORD_SCHEMA_VERSION,
  projectWorkflowStatus,
} from "../../shared/workflow-types.js";
import type {
  WorkflowResult,
  WorkflowRunId,
  WorkflowStopReason,
  WorkflowToolDetails,
  WorkflowViewState,
} from "../../shared/workflow-types.js";
import type { WorkflowRun } from "./engine/runtime-types.js";
import type { WorkflowRecorder } from "./recorder.js";
import type { WorkflowToolHost } from "./tool-workflow.js";

/** Deployment policy for the fixed Ralph workflow (design plan section 4.7). */
export interface RalphToolConfig {
  /** Fresh child provider used for every round (default "general-purpose", not dsh's "spawn"). */
  subagentProvider?: string;
  /** Default and deployment ceiling for one call's round count (default 64; dsh's 256 is too heavy for desktop - pix tightens). */
  maxRounds?: number;
  /** Maximum serialized characters in one structured handoff (default 16384). */
  maxHandoffChars?: number;
  /** Maximum characters in a successful parent-facing terminal text (default 16384). */
  maxResultChars?: number;
}

interface ResolvedConfig {
  readonly subagentProvider: string;
  readonly maxRounds: number;
  readonly maxHandoffChars: number;
  readonly maxResultChars: number;
}

type RalphRoundStatus = "continue" | "complete" | "blocked";

interface RalphRoundReport {
  readonly status: RalphRoundStatus;
  readonly summary: string;
  readonly evidence: string[];
  readonly nextSteps: string[];
  readonly blocker: string;
}

type RalphRunStatus = "complete" | "blocked" | "budget-limited";

interface RalphRunResult {
  readonly status: RalphRunStatus;
  readonly roundsStarted: number;
  readonly report: RalphRoundReport;
}

interface RalphRoundFailure {
  readonly status: "round-failed";
  readonly roundsStarted: number;
  readonly lastReport?: RalphRoundReport;
}

type RalphTerminalResult = RalphRunResult | RalphRoundFailure;

interface RalphCallArgs {
  objective: string;
  maxRounds?: number;
}

/** Fixed identity block, ported from dsh unchanged. */
const RALPH_META = {
  name: "ralph-loop",
  description: "Iterate toward one objective with a fresh child and bounded structured handoff per round.",
  phases: [{ title: "Fresh-agent rounds", detail: "One clean child context per Ralph round." }],
};

/**
 * Fixed, deployment-owned orchestration, ported from dsh unchanged. The model
 * supplies data only; it cannot alter the loop, provider route, schema, or
 * handoff validation. The script still uses agent(..., { schema: reportSchema }).
 */
const RALPH_SCRIPT = String.raw`
const reportSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['continue', 'complete', 'blocked'] },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
    blocker: { type: 'string' },
  },
  required: ['status', 'summary', 'evidence', 'nextSteps', 'blocker'],
  additionalProperties: false,
}

function normalizedText(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function normalizedList(value) {
  return Array.isArray(value) && value.every(normalizedText)
}

function validateReport(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('Ralph child returned no structured round report')
  }
  if (!normalizedText(report.summary)) {
    throw new Error('Ralph round report summary must be non-empty and normalized')
  }
  if (!normalizedList(report.evidence) || !normalizedList(report.nextSteps)) {
    throw new Error('Ralph round report evidence and nextSteps must contain only non-empty normalized strings')
  }
  if (typeof report.blocker !== 'string' || report.blocker !== report.blocker.trim()) {
    throw new Error('Ralph round report blocker must be a normalized string')
  }
  switch (report.status) {
    case 'continue':
      if (report.nextSteps.length === 0 || report.blocker !== '') {
        throw new Error('a continuing Ralph report needs nextSteps and an empty blocker')
      }
      break
    case 'complete':
      if (report.evidence.length === 0 || report.nextSteps.length !== 0 || report.blocker !== '') {
        throw new Error('a complete Ralph report needs evidence, no nextSteps, and an empty blocker')
      }
      break
    case 'blocked':
      if (!normalizedText(report.blocker)) {
        throw new Error('a blocked Ralph report needs a concrete blocker')
      }
      break
    default:
      throw new Error('Ralph round report status is invalid')
  }
  const serialized = JSON.stringify(report)
  if (serialized.length > args.maxHandoffChars) {
    throw new Error('Ralph round report exceeds maxHandoffChars (' + serialized.length + ' > ' + args.maxHandoffChars + ')')
  }
  return report
}

let previous
phase('Fresh-agent rounds')
for (let round = 1; round <= args.maxRounds; round += 1) {
  const prior = previous === undefined ? '(none — this is the first round)' : JSON.stringify(previous)
  const prompt = [
    'You are one fresh worker in a foreground Ralph loop. You receive no parent conversation and no prior child session. Do not call the ralph tool: this round already is its worker.',
    'Immutable objective:\n' + args.objective,
    'Ralph round: ' + round + ' of ' + args.maxRounds + '.',
    'The shared workspace and its current working tree are the long-term memory and source of truth. Inspect them before acting, preserve existing work, perform concrete in-scope work, and verify what you change. Treat the previous report only as a bounded handoff; confirm it against the workspace.',
    'Previous structured handoff:\n' + prior,
    'Return one report with exact normalized strings. Use status continue with at least one nextSteps entry while useful work remains; complete only with concrete evidence and no nextSteps; blocked only when no meaningful progress is possible without human input or an external-state change. blocker must be empty unless blocked.',
  ].join('\n\n')
  const rawReport = await agent(prompt, {
    label: 'Ralph round ' + round,
    phase: 'Fresh-agent rounds',
    schema: reportSchema,
  })
  if (rawReport === null) {
    return { status: 'round-failed', roundsStarted: round, lastReport: previous ?? null }
  }
  const report = validateReport(rawReport)
  if (report.status === 'complete') return { status: 'complete', roundsStarted: round, report }
  if (report.status === 'blocked') return { status: 'blocked', roundsStarted: round, report }
  previous = report
}
return { status: 'budget-limited', roundsStarted: args.maxRounds, report: previous }
`;

const DESCRIPTION =
  "Run a foreground fresh-agent Ralph loop toward one immutable objective. "
  + "Use only when the direct human explicitly asks for Ralph or fresh-agent iteration. Each round "
  + "opens a new child with no parent conversation or prior child session; the shared workspace is "
  + "long-term memory, and only a bounded structured report crosses rounds. The call returns when "
  + "a worker reports completion or a concrete blocker, or at the round limit. Ordinary long-running same-session work "
  + "belongs to goal tools.";

/** Validate defaults even when a caller invokes createRalphToolDefinition without a config. */
function resolveConfig(config: RalphToolConfig | undefined): ResolvedConfig {
  const subagentProvider = config?.subagentProvider ?? "general-purpose";
  const maxRounds = config?.maxRounds ?? 64;
  const maxHandoffChars = config?.maxHandoffChars ?? 16_384;
  const maxResultChars = config?.maxResultChars ?? 16_384;
  if (subagentProvider.length === 0 || subagentProvider !== subagentProvider.trim()) {
    throw new TypeError("subagentProvider must be a non-empty normalized string");
  }
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
    throw new TypeError("maxRounds must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxHandoffChars) || maxHandoffChars < 1) {
    throw new TypeError("maxHandoffChars must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxResultChars) || maxResultChars < 1) {
    throw new TypeError("maxResultChars must be a positive safe integer");
  }
  return { subagentProvider, maxRounds, maxHandoffChars, maxResultChars };
}

/** Resolve one model-selected cap against the deployment ceiling. */
function resolveMaxRounds(requested: number | undefined, ceiling: number): number {
  const value = requested ?? ceiling;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Ralph maxRounds must be a positive safe integer");
  }
  if (value > ceiling) {
    throw new TypeError(`Ralph maxRounds ${value} exceeds the deployment ceiling ${ceiling}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function normalizedList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(normalizedText);
}

/** Defensively decode the fixed script's report across the engine boundary. */
function readReport(value: unknown, expectedStatus: RalphRoundStatus, maxChars: number): RalphRoundReport {
  if (!isRecord(value)
    || Object.keys(value).sort().join(",") !== "blocker,evidence,nextSteps,status,summary"
    || value["status"] !== expectedStatus) {
    throw new Error("Ralph workflow returned a malformed round report");
  }
  const summary = value["summary"];
  const evidence = value["evidence"];
  const nextSteps = value["nextSteps"];
  const blocker = value["blocker"];
  if (!normalizedText(summary)
    || !normalizedList(evidence)
    || !normalizedList(nextSteps)
    || typeof blocker !== "string"
    || blocker !== blocker.trim()) {
    throw new Error("Ralph workflow returned a malformed round report");
  }
  const report: RalphRoundReport = { status: expectedStatus, summary, evidence, nextSteps, blocker };
  if (expectedStatus === "continue" && (report.nextSteps.length === 0 || report.blocker !== "")) {
    throw new Error("Ralph workflow returned an invalid continuing report");
  }
  if (expectedStatus === "complete"
    && (report.evidence.length === 0 || report.nextSteps.length !== 0 || report.blocker !== "")) {
    throw new Error("Ralph workflow returned an invalid completion report");
  }
  if (expectedStatus === "blocked" && !normalizedText(report.blocker)) {
    throw new Error("Ralph workflow returned an invalid blocked report");
  }
  const chars = JSON.stringify(report).length;
  if (chars > maxChars) {
    throw new Error(`Ralph workflow returned an oversized handoff (${chars} > ${maxChars})`);
  }
  return report;
}

/** Defensively decode the fixed script's terminal value. */
function readRunResult(value: unknown, maxRounds: number, maxHandoffChars: number): RalphTerminalResult {
  if (!isRecord(value)) {
    throw new Error("Ralph workflow returned a malformed terminal result");
  }
  const roundsStartedValue = value["roundsStarted"];
  if (typeof roundsStartedValue !== "number"
    || !Number.isSafeInteger(roundsStartedValue)
    || roundsStartedValue < 1
    || roundsStartedValue > maxRounds) {
    throw new Error("Ralph workflow returned a malformed terminal result");
  }
  const roundsStarted = roundsStartedValue;
  switch (value["status"]) {
    case "complete":
      if (Object.keys(value).sort().join(",") !== "report,roundsStarted,status") {
        throw new Error("Ralph workflow returned a malformed terminal result");
      }
      return { status: "complete", roundsStarted, report: readReport(value["report"], "complete", maxHandoffChars) };
    case "blocked":
      if (Object.keys(value).sort().join(",") !== "report,roundsStarted,status") {
        throw new Error("Ralph workflow returned a malformed terminal result");
      }
      return { status: "blocked", roundsStarted, report: readReport(value["report"], "blocked", maxHandoffChars) };
    case "budget-limited":
      if (Object.keys(value).sort().join(",") !== "report,roundsStarted,status") {
        throw new Error("Ralph workflow returned a malformed terminal result");
      }
      if (roundsStarted !== maxRounds) {
        throw new Error("Ralph workflow returned budget-limited before the round limit");
      }
      return { status: "budget-limited", roundsStarted, report: readReport(value["report"], "continue", maxHandoffChars) };
    case "round-failed": {
      if (Object.keys(value).sort().join(",") !== "lastReport,roundsStarted,status") {
        throw new Error("Ralph workflow returned a malformed terminal result");
      }
      if (roundsStarted === 1) {
        if (value["lastReport"] !== null) {
          throw new Error("Ralph workflow returned an invalid first-round failure");
        }
        return { status: "round-failed", roundsStarted };
      }
      if (value["lastReport"] === null) {
        throw new Error("Ralph workflow returned a round failure without its last handoff");
      }
      return {
        status: "round-failed",
        roundsStarted,
        lastReport: readReport(value["lastReport"], "continue", maxHandoffChars),
      };
    }
    default:
      throw new Error("Ralph workflow returned an unknown terminal status");
  }
}

/** Render a thrown value without trusting it. */
function renderThrown(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "[unrenderable thrown value]";
  }
}

/** A non-`completed` stop reason means the loop did not finish cleanly. */
function stopReasonError(result: WorkflowResult): string | undefined {
  switch (result.stopReason) {
    case "completed":
      return undefined;
    case "cancelled":
      return `Ralph workflow was cancelled${result.error === undefined ? "" : ` (${result.error})`}`;
    case "error":
      return `Ralph workflow failed: ${result.error ?? "unknown error"}`;
    default:
      // Defensive: WorkflowStopReason is a closed union; a future variant
      // fails loudly here instead of being silently treated as success.
      return `Ralph workflow ended abnormally (${renderThrown(result.stopReason)})`;
  }
}

const TRUNCATION_NOTICE = "\n… [truncated]";

/** Bound complete parent-facing text, including its envelope and truncation marker. */
function boundResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATION_NOTICE.length) return TRUNCATION_NOTICE.slice(0, maxChars);
  return `${text.slice(0, maxChars - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`;
}

/** Render the fixed terminal envelope without presenting self-report as certification. */
function renderResult(result: RalphRunResult, maxChars: number): string {
  const rounds = `${result.roundsStarted} round${result.roundsStarted === 1 ? "" : "s"}`;
  let text: string;
  if (result.status === "complete") {
    text = `Ralph worker reported completion after ${rounds}.\nFinal report:\n${JSON.stringify(result.report, null, 2)}`;
  } else if (result.status === "blocked") {
    text = `Ralph worker reported a blocker after ${rounds}.\nFinal report:\n${JSON.stringify(result.report, null, 2)}`;
  } else {
    text = `Ralph reached its ${rounds} limit; the worker reported work remaining.\nFinal report:\n${JSON.stringify(result.report, null, 2)}`;
  }
  return boundResult(text, maxChars);
}

/** Render an ordinary child failure with the most recent durable handoff. */
function renderRoundFailure(result: RalphRoundFailure, maxChars: number): string {
  const header = `Ralph round ${result.roundsStarted} child failed before producing a structured report.`;
  const text = result.lastReport === undefined
    ? `${header}\nNo previous handoff was available.`
    : `${header}\nLast successful handoff:\n${JSON.stringify(result.lastReport, null, 2)}`;
  return boundResult(text, maxChars);
}

const RalphParams = Type.Object({
  objective: Type.String({
    minLength: 1,
    description: "The immutable completion objective for every fresh Ralph round.",
  }),
  maxRounds: Type.Optional(
    Type.Number({
      description: "Optional positive safe-integer round cap, bounded by the deployment ceiling.",
    }),
  ),
});

type RalphParamsStatic = Static<typeof RalphParams>;

function textContent(text: string): TextContent {
  return { type: "text", text };
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
      pushUpdate(onUpdate, host.recorder, run.id, `ralph "${name}" phase: ${title}`);
    }),
  );
  unsubscribes.push(
    host.engine.on("workflow/log", (info, message) => {
      if (info.id !== run.id) return;
      pushUpdate(onUpdate, host.recorder, run.id, `ralph "${name}" log: ${message}`);
    }),
  );
  unsubscribes.push(
    host.engine.on("workflow/agent-start", (info, agent) => {
      if (info.id !== run.id) return;
      pushUpdate(onUpdate, host.recorder, run.id, `ralph "${name}" agent ${agent.seq} (${agent.label}) started`);
    }),
  );
  unsubscribes.push(
    host.engine.on("workflow/agent-end", (info, agent) => {
      if (info.id !== run.id) return;
      pushUpdate(onUpdate, host.recorder, run.id, `ralph "${name}" agent ${agent.seq} (${agent.label}) ${agent.outcome}`);
    }),
  );
  unsubscribes.push(
    host.engine.on("workflow/end", (info, result) => {
      if (info.id !== run.id) return;
      // Terminal live state: the fold carries no run-end yet, so the
      // stopReason is overlaid (the same projection the panel derives for a
      // finished run). The value stays null in updates; the final result
      // carries it.
      pushUpdate(onUpdate, host.recorder, run.id, `ralph "${name}" finished (${result.stopReason})`, {
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
    toolName: RALPH_TOOL_NAME,
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
 * Create the `ralph` ToolDefinition bound to the host seam (design plan
 * section 4.7). The execute lifecycle is shared with the workflow tool: parent
 * ref, start (synchronous failures throw), recorder.start, abort bridge,
 * observe-only event updates, await result, dispose + finish with abandon as
 * the fallback, and a throw for every non-"completed" stop reason and for a
 * round-failed terminal value.
 */
export function createRalphToolDefinition(
  host: WorkflowToolHost,
  config?: RalphToolConfig,
): ToolDefinition<typeof RalphParams, WorkflowToolDetails> {
  const resolved = resolveConfig(config);
  return {
    name: RALPH_TOOL_NAME,
    label: "Ralph",
    description: DESCRIPTION,
    promptSnippet: "Run a foreground fresh-agent Ralph loop toward one immutable objective.",
    promptGuidelines: [
      "Use the ralph tool ONLY when the direct human explicitly asks for a Ralph loop or fresh-agent iterative execution.",
      "Each Ralph round starts a fresh child with no conversation seed and uses the shared workspace as durable memory; completion and blockers are worker reports, not independent evaluation.",
      "Use same-session goal tools for ordinary long-running objectives, and plain subagents or workflows for bounded delegation and fan-out.",
    ],
    parameters: RalphParams,
    executionMode: "sequential",
    async execute(
      toolCallId: string,
      params: RalphParamsStatic,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<WorkflowToolDetails> | undefined,
    ): Promise<AgentToolResult<WorkflowToolDetails>> {
      // Missing parent session: the host throws and the failure surfaces as
      // an isError result.
      const parent = host.getParentRef(toolCallId);
      const objective = params.objective.trim();
      if (objective.length === 0) {
        throw new Error("Ralph objective must be a non-empty string");
      }
      const maxRounds = resolveMaxRounds(params.maxRounds, resolved.maxRounds);
      // requireFreshProvider (pix port): every pix nested session is fresh by
      // construction - the runtime layer excludes agent/workflow/ralph from
      // schema children - and structured output comes from this plan's capture
      // tool. There is no dsh capabilities.outputSchema flag to probe, so this
      // tool never refuses to start; the provider name itself was validated by
      // resolveConfig.
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
      let run: WorkflowRun;
      try {
        run = host.engine.start({
          script: RALPH_SCRIPT,
          meta: RALPH_META,
          args: { objective, maxRounds, maxHandoffChars: resolved.maxHandoffChars },
          subagentProvider: resolved.subagentProvider,
          maxTotalAgents: maxRounds,
          parent,
          signal,
        });
      } catch (error) {
        signal?.removeEventListener("abort", onAbort);
        throw error;
      }
      startedRun = run;

      // Publish the durable run record and subscribe the live fold.
      host.recorder.start(run, toolCallId, RALPH_TOOL_NAME);

      const unsubscribes = subscribeRunUpdates(host, run, onUpdate);

      let result: WorkflowResult | undefined;
      let terminal: RalphTerminalResult | undefined;
      try {
        result = await run.result;
        const errorMessage = stopReasonError(result);
        if (errorMessage !== undefined) {
          // A non-"completed" stop reason means the loop did not finish
          // cleanly: report the reason, never treat a partial value as
          // success.
          throw new Error(errorMessage);
        }
        terminal = readRunResult(result.value, maxRounds, resolved.maxHandoffChars);
        if (terminal.status === "round-failed") {
          // A child died before producing a structured report: the loop has no
          // round result to continue from, so this is an error for the model.
          throw new Error(renderRoundFailure(terminal, resolved.maxResultChars));
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
      const outcome = terminal as RalphRunResult;
      const content = textContent(renderResult(outcome, resolved.maxResultChars));
      return { content: [content], details: completedDetails(run, toolCallId, settled, host.recorder) };
    },
  };
}
