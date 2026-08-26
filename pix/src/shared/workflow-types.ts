/**
 * Versioned, plain-data contract for the PiX workflow feature (pix:workflow).
 *
 * Shared by main (engine seam, workflow/ralph tools, recorder, IPC adapters),
 * renderer (workflow store, WorkflowRunPanel) and the parent-session durable
 * CustomEntry stream (WORKFLOW_RECORD_CUSTOM_TYPE), so this is a runtime leaf
 * module: no imports at all, and every value here survives structuredClone /
 * JSON round-trips.
 *
 * Guard scope: isWorkflowToolDetails / isWorkflowCommand / isWorkflowViewState
 * check JSON shape, enums and bounds and nothing else. They never touch the
 * filesystem/cwd and never judge cross-field semantics (status vs stopReason
 * consistency, member outcome grouping) - those live in the fold and the
 * panel.
 *
 * foldWorkflowRecords folds the durable record stream into per-run
 * WorkflowViewState snapshots. The enumerated fold invariants are enforced
 * per record: a record violating one is corruption and is SKIPPED (never
 * applied, never fatal to the rest of the stream). The only legal
 * "incomplete" shapes are a missing run-end or a missing member-end (an
 * interrupted prefix). Unknown kinds and unsupported schemaVersions are
 * skipped for forward compatibility.
 */

export const WORKFLOW_RECORD_CUSTOM_TYPE = "pix-workflow-v1" as const;
export const WORKFLOW_RECORD_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_TOOL_NAME = "workflow" as const;
export const RALPH_TOOL_NAME = "ralph" as const;
export const STRUCTURED_OUTPUT_TOOL_NAME = "submit_workflow_result" as const;

export type WorkflowRunId = string & { readonly __brand: "WorkflowRunId" };
export function WorkflowRunId(id: string): WorkflowRunId {
  return id as WorkflowRunId;
}

export interface WorkflowPhase {
  title: string;
  detail?: string;
  provider?: string; // display-only; engine does not execute it
  model?: string;    // display-only
}

export interface WorkflowMeta {
  name: string;          // non-empty
  description: string;   // non-empty
  whenToUse?: string;
  phases?: WorkflowPhase[];
}

export type WorkflowStopReason = "completed" | "cancelled" | "error";
export type WorkflowAgentOutcome = "completed" | "failed" | "cancelled";
export type WorkflowRunStatus =
  | "running" | "completed" | "failed" | "cancelled" | "interrupted";

/** Per-child counters for one run (every `agent()` attempt, including retries). */
export interface WorkflowChildStats {
  completed: number;
  failed: number;
  cancelled: number;
  replayed?: number; // omit when 0
}

/** Completed child identity for a tool-workflow salvage envelope. */
export interface WorkflowSalvageChild {
  seq: number;
  label: string;
  childId: string;
}

/** Pure data for tool-workflow derive (S6). Not on WorkflowResult or tool details. */
export interface WorkflowSalvage {
  completed: WorkflowSalvageChild[];
  hint: string;
}

/** One item-level child failure surfaced to the parent agent and the panel. */
export interface WorkflowChildFailure {
  label: string;
  reason: string;
  message?: string;
}

/** Inspectable child identity for a completed run (spawn or cache hit). Not salvage. */
export interface WorkflowSourceChild {
  label: string;
  childId: string;
}

export interface WorkflowResult {
  value: unknown;              // meaningful only when completed; script undefined -> null
  stopReason: WorkflowStopReason;
  error?: string;              // iff stopReason !== "completed"
  agentsStarted: number;
  childStats?: WorkflowChildStats;
  /** Failed child attempts (including retried ones); capped; omitted when empty. */
  failures?: WorkflowChildFailure[];
  /** Spawn/hit children that still have a taskId; omitted when empty. Not on tool details. */
  sources?: WorkflowSourceChild[];
}

export interface WorkflowRunInfo {
  id: WorkflowRunId;
  meta: WorkflowMeta;
}

export interface WorkflowAgentInfo {
  seq: number;          // 1-based
  label: string;
  phase?: string;
  childId: string;      // AgentTask taskId
}

export interface WorkflowAgentEndInfo extends WorkflowAgentInfo {
  outcome: WorkflowAgentOutcome;
  /** Human-readable failure (reason: message); omitted on completed. */
  error?: string;
}

export interface WorkflowResultInfo {
  stopReason: WorkflowStopReason;
  error?: string;
  agentsStarted: number;
  childStats?: WorkflowChildStats;
  sources?: WorkflowSourceChild[];
}

export type WorkflowErrorCode =
  | "SCRIPT_PARSE" | "META_INVALID" | "INVALID_ARGUMENT" | "UNSUPPORTED_OPTION"
  | "UNSUPPORTED_SCHEMA" | "AGENT_CAP" | "ITEM_CAP" | "AGENT_START" | "AGENT_RESULT"
  | "RESULT_UNSERIALIZABLE" | "CANCELLED";

export type WorkflowEventName =
  | "workflow/start" | "workflow/phase" | "workflow/log"
  | "workflow/agent-start" | "workflow/agent-end" | "workflow/end";

// ============================================================================
// Durable record (written as CustomEntry.data, customType "pix-workflow-v1")
// ============================================================================

export type PixWorkflowRecord =
  | {
      schemaVersion: typeof WORKFLOW_RECORD_SCHEMA_VERSION;
      kind: "run-start";
      runId: WorkflowRunId;
      toolCallId: string;
      toolName: "workflow" | "ralph";
      name: string;
    }
  | {
      schemaVersion: typeof WORKFLOW_RECORD_SCHEMA_VERSION;
      kind: "phase";
      runId: WorkflowRunId;
      title: string;
    }
  | {
      schemaVersion: typeof WORKFLOW_RECORD_SCHEMA_VERSION;
      kind: "log";
      runId: WorkflowRunId;
      message: string;
    }
  | {
      schemaVersion: typeof WORKFLOW_RECORD_SCHEMA_VERSION;
      kind: "agent-start";
      runId: WorkflowRunId;
      seq: number;
      label: string;
      phase?: string;
      childId: string;
    }
  | {
      schemaVersion: typeof WORKFLOW_RECORD_SCHEMA_VERSION;
      kind: "agent-end";
      runId: WorkflowRunId;
      seq: number;
      outcome: WorkflowAgentOutcome;
      error?: string;
    }
  | {
      schemaVersion: typeof WORKFLOW_RECORD_SCHEMA_VERSION;
      kind: "run-end";
      runId: WorkflowRunId;
      stopReason: WorkflowStopReason;
    };

export const WORKFLOW_MAX_DURABLE_LOGS = 200; // older log records are dropped; only kind "log"

// ============================================================================
// View / tool details
// ============================================================================

export interface WorkflowMemberState {
  seq: number;
  label: string;
  phase?: string;
  childId: string;
  outcome?: WorkflowAgentOutcome;
  error?: string;
}

export interface WorkflowLogLine {
  message: string;
}

export interface WorkflowViewState {
  runId: WorkflowRunId;
  toolCallId: string;
  toolName: "workflow" | "ralph";
  name: string;
  members: WorkflowMemberState[]; // append order
  logs: WorkflowLogLine[];        // cap 200
  currentPhase?: string;
  stopReason?: WorkflowStopReason;
  status: WorkflowRunStatus;      // derived, see projectWorkflowStatus
}

/** Written into AgentToolResult.details / onUpdate.partialResult.details. */
export interface WorkflowToolDetails {
  kind: "pix-workflow-run";
  schemaVersion: typeof WORKFLOW_RECORD_SCHEMA_VERSION;
  view: WorkflowViewState;
  /** Only a terminal "completed" carries it; updates and non-completed runs are null. */
  value: unknown | null;
  agentsStarted: number;
  error?: string;
}

// ============================================================================
// IPC
// ============================================================================

export type WorkflowCommand = { type: "get_snapshot" };

export type WorkflowEvent =
  | { type: "snapshot"; runs: WorkflowViewState[] }
  | { type: "upsert"; run: WorkflowViewState };

// ============================================================================
// Guard helpers (private; enum tables mirror the exported unions above)
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

const WORKFLOW_STOP_REASONS = ["completed", "cancelled", "error"] as const;
const WORKFLOW_AGENT_OUTCOMES = ["completed", "failed", "cancelled"] as const;
const WORKFLOW_RUN_STATUSES = ["running", "completed", "failed", "cancelled", "interrupted"] as const;
const WORKFLOW_TOOL_NAMES = ["workflow", "ralph"] as const;

function isWorkflowMemberState(value: unknown): value is WorkflowMemberState {
  if (!isRecord(value)) return false;
  if (typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq <= 0) return false;
  if (typeof value.label !== "string") return false;
  if (value.phase !== undefined && typeof value.phase !== "string") return false;
  if (typeof value.childId !== "string" || value.childId.length === 0) return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  return value.outcome === undefined || isOneOf(value.outcome, WORKFLOW_AGENT_OUTCOMES);
}

function isWorkflowLogLine(value: unknown): value is WorkflowLogLine {
  return isRecord(value) && typeof value.message === "string";
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Non-throwing structural narrowing of an unknown value into WorkflowToolDetails.
 * Checks the kind/schemaVersion markers, the folded view state, the required
 * value field (any JSON-shaped payload) and the agent count bounds. Does not
 * judge status/stopReason consistency - the details are produced by the
 * recorder fold and consumed display-only here.
 */
export function isWorkflowToolDetails(value: unknown): value is WorkflowToolDetails {
  if (!isRecord(value)) return false;
  if (value.kind !== "pix-workflow-run") return false;
  if (value.schemaVersion !== WORKFLOW_RECORD_SCHEMA_VERSION) return false;
  if (!isWorkflowViewState(value.view)) return false;
  if (!("value" in value)) return false;
  if (typeof value.agentsStarted !== "number" || !Number.isSafeInteger(value.agentsStarted) || value.agentsStarted < 0) {
    return false;
  }
  if (value.error !== undefined && typeof value.error !== "string") return false;
  return true;
}

/**
 * Collision-free phase identity key. `undefined` maps to "missing"; an empty
 * string maps to "value:0:" - the two must be distinct identities (aligned
 * with dsh), so a phase explicitly named "" groups separately from a member
 * that carried no phase at all.
 */
export function workflowPhaseKey(phase: string | undefined): string {
  return phase === undefined ? "missing" : `value:${phase.length}:${phase}`;
}

/**
 * Derived run status from a folded view (without its status field).
 * stopReason completed/cancelled/error -> completed/cancelled/failed; a
 * missing stopReason -> running (the fold layer has no "parent turn closed"
 * signal, so restore-produced status may always be running; the panel
 * overrides: when the parent toolResult landed and
 * isError && !stopReason && !streaming -> show interrupted).
 */
export function projectWorkflowStatus(state: Omit<WorkflowViewState, "status">): WorkflowRunStatus {
  switch (state.stopReason) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "error":
      return "failed";
    default:
      return "running";
  }
}

// ============================================================================
// Fold
// ============================================================================

interface FoldRun {
  runId: WorkflowRunId;
  toolCallId: string;
  toolName: "workflow" | "ralph";
  name: string;
  members: WorkflowMemberState[];       // append order
  memberBySeq: Map<number, WorkflowMemberState>;
  logs: WorkflowLogLine[];              // cap WORKFLOW_MAX_DURABLE_LOGS
  currentPhase?: string;
  stopReason?: WorkflowStopReason;
}

function warnCorrupt(kind: unknown, reason: string): void {
  console.warn(`workflow: skipping corrupt durable record (kind ${JSON.stringify(kind)}): ${reason}`);
}

/**
 * Fold a durable record stream into one WorkflowViewState per run, in order
 * of each run's first run-start. Enforces the fold invariants per record:
 * violations are corruption and the offending record is skipped; a missing
 * run-end or member-end is a legal interrupted prefix; unknown kinds and
 * unsupported schemaVersions are skipped (forward compatibility). Logs keep
 * only the latest WORKFLOW_MAX_DURABLE_LOGS records. Never throws on
 * arbitrary input.
 */
export function foldWorkflowRecords(records: PixWorkflowRecord[]): WorkflowViewState[] {
  const runs = new Map<string, FoldRun>();
  for (const record of records) {
    foldOne(runs, record);
  }
  return [...runs.values()].map(projectRun);
}

function foldOne(runs: Map<string, FoldRun>, record: PixWorkflowRecord): void {
  if (!isRecord(record)) {
    warnCorrupt(typeof record, "record is not an object");
    return;
  }
  if (record.schemaVersion !== WORKFLOW_RECORD_SCHEMA_VERSION) {
    warnCorrupt(record.kind, `unsupported schemaVersion ${String(record.schemaVersion)}`);
    return;
  }
  const kind = record.kind;
  switch (kind) {
    case "run-start": {
      if (typeof record.runId !== "string" || record.runId.length === 0) {
        warnCorrupt(record.kind, "runId must be a non-empty string");
        return;
      }
      if (typeof record.toolCallId !== "string") {
        warnCorrupt(record.kind, "toolCallId must be a string");
        return;
      }
      if (!isOneOf(record.toolName, WORKFLOW_TOOL_NAMES)) {
        warnCorrupt(record.kind, `unknown toolName ${String(record.toolName)}`);
        return;
      }
      if (typeof record.name !== "string" || record.name.length === 0) {
        warnCorrupt(record.kind, "name must be a non-empty string");
        return;
      }
      if (runs.has(record.runId)) {
        warnCorrupt(record.kind, `runId ${JSON.stringify(record.runId)} already started`);
        return;
      }
      runs.set(record.runId, {
        runId: record.runId as WorkflowRunId,
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        name: record.name,
        members: [],
        memberBySeq: new Map(),
        logs: [],
      });
      return;
    }
    case "phase": {
      const run = findOpenRun(runs, record);
      if (run === null) return;
      if (typeof record.title !== "string") {
        warnCorrupt(record.kind, "title must be a string");
        return;
      }
      run.currentPhase = record.title;
      return;
    }
    case "log": {
      const run = findOpenRun(runs, record);
      if (run === null) return;
      if (typeof record.message !== "string") {
        warnCorrupt(record.kind, "message must be a string");
        return;
      }
      run.logs.push({ message: record.message });
      if (run.logs.length > WORKFLOW_MAX_DURABLE_LOGS) {
        run.logs.shift();
      }
      return;
    }
    case "agent-start": {
      const run = findOpenRun(runs, record);
      if (run === null) return;
      if (!Number.isSafeInteger(record.seq) || record.seq <= 0) {
        warnCorrupt(record.kind, "seq must be a positive safe integer");
        return;
      }
      if (typeof record.label !== "string") {
        warnCorrupt(record.kind, "label must be a string");
        return;
      }
      if (record.phase !== undefined && typeof record.phase !== "string") {
        warnCorrupt(record.kind, "phase must be a string when present");
        return;
      }
      if (typeof record.childId !== "string" || record.childId.length === 0) {
        warnCorrupt(record.kind, "childId must be a non-empty string");
        return;
      }
      if (run.memberBySeq.has(record.seq)) {
        warnCorrupt(record.kind, `seq ${record.seq} already started in this run`);
        return;
      }
      const member: WorkflowMemberState = {
        seq: record.seq,
        label: record.label,
        childId: record.childId,
      };
      if (record.phase !== undefined) {
        member.phase = record.phase;
      }
      run.members.push(member);
      run.memberBySeq.set(record.seq, member);
      return;
    }
    case "agent-end": {
      const run = findOpenRun(runs, record);
      if (run === null) return;
      if (!Number.isSafeInteger(record.seq) || record.seq <= 0) {
        warnCorrupt(record.kind, "seq must be a positive safe integer");
        return;
      }
      if (!isOneOf(record.outcome, WORKFLOW_AGENT_OUTCOMES)) {
        warnCorrupt(record.kind, `unknown outcome ${String(record.outcome)}`);
        return;
      }
      const member = run.memberBySeq.get(record.seq);
      if (member === undefined) {
        warnCorrupt(record.kind, `seq ${record.seq} has no matching agent-start`);
        return;
      }
      if (member.outcome !== undefined) {
        warnCorrupt(record.kind, `seq ${record.seq} already ended`);
        return;
      }
      member.outcome = record.outcome;
      if (typeof record.error === "string" && record.error.length > 0) {
        member.error = record.error;
      }
      return;
    }
    case "run-end": {
      const run = findOpenRun(runs, record);
      if (run === null) return;
      if (!isOneOf(record.stopReason, WORKFLOW_STOP_REASONS)) {
        warnCorrupt(record.kind, `unknown stopReason ${String(record.stopReason)}`);
        return;
      }
      if (run.members.some((member) => member.outcome === undefined)) {
        warnCorrupt(record.kind, "run-end with open members");
        return;
      }
      run.stopReason = record.stopReason;
      return;
    }
    default:
      warnCorrupt(kind, "unknown kind");
      return;
  }
}

/** Look up a run for a member/phase/log/end record; skips records without a
 * prior run-start and records arriving after the run already ended. */
function findOpenRun(runs: Map<string, FoldRun>, record: { runId: unknown }): FoldRun | null {
  if (typeof record.runId !== "string") {
    warnCorrupt("unknown", "runId must be a string");
    return null;
  }
  const run = runs.get(record.runId);
  if (run === undefined) {
    warnCorrupt("unknown", `runId ${JSON.stringify(record.runId)} has no run-start`);
    return null;
  }
  if (run.stopReason !== undefined) {
    warnCorrupt("unknown", `runId ${JSON.stringify(record.runId)} already ended`);
    return null;
  }
  return run;
}

function projectRun(run: FoldRun): WorkflowViewState {
  const state: Omit<WorkflowViewState, "status"> = {
    runId: run.runId,
    toolCallId: run.toolCallId,
    toolName: run.toolName,
    name: run.name,
    members: run.members.map((member) => ({ ...member })),
    logs: run.logs.map((line) => ({ ...line })),
  };
  if (run.currentPhase !== undefined) {
    state.currentPhase = run.currentPhase;
  }
  if (run.stopReason !== undefined) {
    state.stopReason = run.stopReason;
  }
  return { ...state, status: projectWorkflowStatus(state) };
}

/**
 * Non-throwing structural narrowing of an unknown value into WorkflowCommand.
 */
export function isWorkflowCommand(value: unknown): value is WorkflowCommand {
  return isRecord(value) && value.type === "get_snapshot";
}

/**
 * Non-throwing structural narrowing of an unknown value into WorkflowViewState.
 * Checks JSON shape, enums and bounds only; status/stopReason consistency and
 * member outcome grouping are fold/panel semantics, not checked here.
 */
export function isWorkflowViewState(value: unknown): value is WorkflowViewState {
  if (!isRecord(value)) return false;
  if (typeof value.runId !== "string" || value.runId.length === 0) return false;
  if (typeof value.toolCallId !== "string") return false;
  if (!isOneOf(value.toolName, WORKFLOW_TOOL_NAMES)) return false;
  if (typeof value.name !== "string") return false;
  if (!Array.isArray(value.members) || !value.members.every(isWorkflowMemberState)) return false;
  if (!Array.isArray(value.logs) || !value.logs.every(isWorkflowLogLine)) return false;
  if (value.currentPhase !== undefined && typeof value.currentPhase !== "string") return false;
  if (value.stopReason !== undefined && !isOneOf(value.stopReason, WORKFLOW_STOP_REASONS)) return false;
  return isOneOf(value.status, WORKFLOW_RUN_STATUSES);
}
