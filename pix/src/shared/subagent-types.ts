/**
 * Versioned, plain-data contract for solo-mode subagent progress, results and
 * activities. Shared by main (runner/tool), renderer (SubagentToolView) and the
 * parent transcript (replay), so this is a leaf module with no imports at all:
 * every value here survives structuredClone / JSON round-trips (no Error, Model,
 * AbortSignal instances, class instances or functions) and the renderer can
 * import it directly.
 *
 * Producer/consumer semantics (documented here; enforced by the guard where
 * observable):
 * - result status transitions are one-way: queued -> running ->
 *   completed|failed|aborted; terminal states are never rewritten.
 * - queued results have durationMs 0; a running snapshot uses now - startedAt.
 * - max_turns is a "failed" outcome, never a plain abort.
 * - activity summaries are bounded, single-line and never include full
 *   args/result; the runner must converge still-running activities to "failed"
 *   before a result becomes terminal, so replay never shows a forever-running
 *   nested tool.
 * - description and model are bounded by the tool schema / runner truncation;
 *   the guard rejects the observable caps (results, activities, activity
 *   summary, errorMessage, finalOutput).
 */

export const SUBAGENT_DETAILS_SCHEMA_VERSION = 1 as const;
export const SUBAGENT_MAX_RESULTS = 8;
export const SUBAGENT_MAX_DESCRIPTION_CHARS = 80;
export const SUBAGENT_MAX_FINAL_OUTPUT_BYTES = 48 * 1024;
export const SUBAGENT_MAX_RECENT_ACTIVITIES = 20;
export const SUBAGENT_MAX_ACTIVITY_SUMMARY_CHARS = 160;
export const SUBAGENT_MAX_ERROR_MESSAGE_BYTES = 4 * 1024;

// Enum tables are the single source for both the exported union types and the
// runtime validation lists, so the guard can never drift from the types.
const SUBAGENT_AGENT_SCOPES = ["user", "project", "both"] as const;
const SUBAGENT_MODES = ["single", "parallel", "chain"] as const;
const SUBAGENT_STATUSES = ["queued", "running", "completed", "failed", "aborted"] as const;
const SUBAGENT_AGENT_SOURCES = ["user", "project", "built-in", "unknown"] as const;
const SUBAGENT_ACTIVITY_STATUSES = ["running", "completed", "failed"] as const;
const SUBAGENT_FAILURE_REASONS = [
  "invalid_parameters",
  "unknown_agent",
  "tool_unavailable",
  "project_agent_denied",
  "model_unavailable",
  "model_not_found",
  "model_ambiguous",
  "model_auth_unavailable",
  "prompt_too_large",
  "max_turns",
  "api_error",
  "aborted",
  "host_disposed",
  "session_start_failed",
  "internal_error",
] as const;
/** Reasons describing a user/host-initiated stop; only legal for "aborted" results. */
const SUBAGENT_ABORT_REASONS = ["aborted", "host_disposed", "project_agent_denied"] as const;

export type SubagentAgentScope = (typeof SUBAGENT_AGENT_SCOPES)[number];
export type SubagentMode = (typeof SUBAGENT_MODES)[number];
export type SubagentStatus = (typeof SUBAGENT_STATUSES)[number];
export type SubagentAgentSource = (typeof SUBAGENT_AGENT_SOURCES)[number];
export type SubagentFailureReason = (typeof SUBAGENT_FAILURE_REASONS)[number];

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Sum of the four token fields above; same aggregation as SessionStats. */
  totalTokens: number;
  cost: number;
  turns: number;
}

export interface SubagentActivity {
  sequence: number;
  toolCallId: string;
  toolName: string;
  status: "running" | "completed" | "failed";
  /** Bounded, single-line; never includes full args/result. */
  summary?: string;
  startedAt: number;
  endedAt?: number;
}

export interface SubagentSingleResult {
  id: string;
  /** Keeps input order, 0-based. */
  index: number;
  /** Chain UI step, 1-based. */
  step?: number;
  agentName: string;
  agentSource: SubagentAgentSource;
  description: string;
  status: SubagentStatus;
  finalOutput: string;
  outputTruncated: boolean;
  originalOutputBytes: number;
  toolUseCount: number;
  activities: SubagentActivity[];
  usage: SubagentUsage;
  /** "provider/modelId" */
  model?: string;
  failureReason?: SubagentFailureReason;
  errorMessage?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs: number;
}

export interface SubagentDetails {
  schemaVersion: typeof SUBAGENT_DETAILS_SCHEMA_VERSION;
  mode: SubagentMode;
  agentScope: SubagentAgentScope;
  results: SubagentSingleResult[];
  startedAt: number;
  updatedAt: number;
  durationMs: number;
}

// ============================================================================
// Guard helpers
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isSubagentUsage(value: unknown): value is SubagentUsage {
  if (!isRecord(value)) {
    return false;
  }
  const { input, output, cacheRead, cacheWrite, totalTokens, cost, turns } = value;
  if (!isFiniteNonNegative(input) || !isFiniteNonNegative(output)) return false;
  if (!isFiniteNonNegative(cacheRead) || !isFiniteNonNegative(cacheWrite)) return false;
  if (!isFiniteNonNegative(totalTokens) || !isFiniteNonNegative(cost) || !isFiniteNonNegative(turns)) {
    return false;
  }
  return totalTokens === input + output + cacheRead + cacheWrite;
}

function isSubagentActivity(value: unknown): value is SubagentActivity {
  if (!isRecord(value)) {
    return false;
  }
  const { sequence, toolCallId, toolName, status, summary, startedAt, endedAt } = value;
  if (!isFiniteNonNegative(sequence)) return false;
  if (typeof toolCallId !== "string" || typeof toolName !== "string") return false;
  if (!isOneOf(status, SUBAGENT_ACTIVITY_STATUSES)) return false;
  if (summary !== undefined && typeof summary !== "string") return false;
  if (summary !== undefined && summary.length > SUBAGENT_MAX_ACTIVITY_SUMMARY_CHARS) return false;
  if (!isFiniteNonNegative(startedAt)) return false;
  if (endedAt !== undefined && !isFiniteNonNegative(endedAt)) return false;
  // running activities have no endedAt; completed/failed must have endedAt.
  if (status === "running") {
    if (endedAt !== undefined) return false;
  } else if (endedAt === undefined) {
    return false;
  }
  return true;
}

function isSubagentSingleResult(value: unknown): value is SubagentSingleResult {
  if (!isRecord(value)) {
    return false;
  }
  const {
    id,
    index,
    step,
    agentName,
    agentSource,
    description,
    status,
    finalOutput,
    outputTruncated,
    originalOutputBytes,
    toolUseCount,
    activities,
    usage,
    model,
    failureReason,
    errorMessage,
    startedAt,
    endedAt,
    durationMs,
  } = value;

  if (typeof id !== "string" || typeof agentName !== "string") return false;
  if (typeof description !== "string" || typeof finalOutput !== "string") return false;
  if (utf8ByteLength(finalOutput) > SUBAGENT_MAX_FINAL_OUTPUT_BYTES) return false;
  if (typeof outputTruncated !== "boolean") return false;
  if (!isFiniteNonNegative(index) || !isFiniteNonNegative(originalOutputBytes)) return false;
  if (!isFiniteNonNegative(toolUseCount) || !isFiniteNonNegative(durationMs)) return false;
  if (step !== undefined && !isFiniteNonNegative(step)) return false;
  if (!isOneOf(agentSource, SUBAGENT_AGENT_SOURCES)) return false;
  if (!isOneOf(status, SUBAGENT_STATUSES)) return false;
  if (!Array.isArray(activities) || activities.length > SUBAGENT_MAX_RECENT_ACTIVITIES) return false;
  if (!activities.every(isSubagentActivity)) return false;
  if (!isSubagentUsage(usage)) return false;
  if (model !== undefined && typeof model !== "string") return false;
  if (errorMessage !== undefined) {
    if (typeof errorMessage !== "string") return false;
    if (utf8ByteLength(errorMessage) > SUBAGENT_MAX_ERROR_MESSAGE_BYTES) return false;
  }
  if (startedAt !== undefined && !isFiniteNonNegative(startedAt)) return false;
  if (endedAt !== undefined && !isFiniteNonNegative(endedAt)) return false;

  // Status invariants.
  if (status === "queued" || status === "running") {
    if (endedAt !== undefined) return false;
  } else if (endedAt === undefined) {
    return false;
  }
  if (status === "running" && startedAt === undefined) return false;
  if (status === "failed") {
    if (!isOneOf(failureReason, SUBAGENT_FAILURE_REASONS)) return false;
    if (isOneOf(failureReason, SUBAGENT_ABORT_REASONS)) return false;
  }
  if (status === "aborted" && failureReason !== undefined && !isOneOf(failureReason, SUBAGENT_ABORT_REASONS)) {
    return false;
  }
  if (status === "completed" && failureReason !== undefined) return false;

  return true;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Non-throwing structural narrowing of an unknown value into SubagentDetails.
 * Validates schemaVersion, enums, required fields, finite non-negative counts
 * and timestamps, totalTokens consistency with the four token fields, the
 * observable status invariants, and the contract caps for results, activities,
 * activity summary, errorMessage and finalOutput.
 */
export function isSubagentDetails(value: unknown): value is SubagentDetails {
  if (!isRecord(value)) {
    return false;
  }
  if (value.schemaVersion !== SUBAGENT_DETAILS_SCHEMA_VERSION) return false;
  if (!isOneOf(value.mode, SUBAGENT_MODES)) return false;
  if (!isOneOf(value.agentScope, SUBAGENT_AGENT_SCOPES)) return false;
  if (!Array.isArray(value.results)) return false;
  if (value.results.length > SUBAGENT_MAX_RESULTS) return false;
  if (!value.results.every(isSubagentSingleResult)) return false;
  if (!isFiniteNonNegative(value.startedAt)) return false;
  if (!isFiniteNonNegative(value.updatedAt)) return false;
  if (!isFiniteNonNegative(value.durationMs)) return false;
  return true;
}

/**
 * Sums the usage of all results in a details object that already passed
 * isSubagentDetails and recomputes totalTokens from the four summed token
 * fields; an externally supplied aggregate value is never trusted.
 */
export function aggregateSubagentUsage(details: SubagentDetails): SubagentUsage {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let turns = 0;
  for (const result of details.results) {
    input += result.usage.input;
    output += result.usage.output;
    cacheRead += result.usage.cacheRead;
    cacheWrite += result.usage.cacheWrite;
    cost += result.usage.cost;
    turns += result.usage.turns;
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost,
    turns,
  };
}
