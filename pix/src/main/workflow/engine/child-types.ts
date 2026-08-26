/**
 * The child seam: what the worker init carries and what one `agent()` child
 * looks like on the host side. Child ports are implemented by the
 * child-spawner (S4); this file only fixes the shapes both sides agree on.
 */

import type { WorkflowMeta } from "../../../shared/workflow-types.js";
import type { ObjectJsonSchema } from "./schema.js";

/** Host-resolved concurrency/timing limits shipped to the worker. */
export interface WorkerLimits {
  maxConcurrentAgents: number; // >= 1, host has resolved
  maxTotalAgents: number;
  maxItemsPerCall: number;
  syncTimeoutMs: number;
}

/** The worker bootstrap payload (transferred as Worker workerData). */
export interface WorkerInit {
  meta: WorkflowMeta;
  body: string;
  args?: unknown;
  limits: WorkerLimits;
  /** pix default agent definition for `agent()` when the script omits provider. */
  runDefault?: string;
}

/** One child start request from the script (`agent(prompt, opts)` projection). */
export interface ChildStartRequest {
  prompt: string;
  schema?: ObjectJsonSchema;
  provider?: string;
  model?: string;
  /** Display label for the task card; the spawner falls back to the prompt first line. */
  label?: string;
  /** Run-level default agent definition (from WorkflowStartRequest.subagentProvider). */
  providerDefault?: string;
  /** Nested-session turn cap; schema children default to SCHEMA_CHILD_DEFAULT_MAX_TURNS. */
  maxTurns?: number;
  /** Materialized JSON values, not disk paths. */
  artifacts?: WorkflowArtifactPayload[];
}

/** One named artifact cloned onto a child start (JSON data, not a disk path). */
export interface WorkflowArtifactPayload {
  name: string;
  value: unknown;
}

/** Default maxTurns for workflow schema children when the script omits opts.maxTurns. Same as ordinary subagents (DEFAULT_MAX_TURNS). */
export const SCHEMA_CHILD_DEFAULT_MAX_TURNS = 150;

/** Default `agent()` retry count when `opts.schema` is set and `opts.retry` is omitted. */
export const DEFAULT_SCHEMA_CHILD_RETRY = 1;

/** A settled child's projection; the runtime only branches on `stopReason === "completed"`. */
export interface ChildResult {
  output: Array<{ type: "text"; text: string }>;
  structured?: unknown;
  stopReason: string;
  /** AgentTask failureReason when the child did not complete (e.g. max_turns). */
  failureReason?: string;
  /** Human-readable error copied from the nested result. */
  error?: string;
}

/** The host-side seam the worker session calls into. */
export interface ChildPort {
  startAgent(request: ChildStartRequest): Promise<ChildHandle>;
}

/**
 * Host-backed child-result cache injected into {@link WorkflowExecution}.
 * `undefined` from lookup is a miss; a hit value is the `agent()` return
 * (structured or text). Store size/IO failures are swallowed and logged
 * host-side and must never kill the script.
 */
/** A cache hit: the stored agent() return, plus the spawn taskId when the file has one. */
export interface CacheLookupHit {
  value: unknown;
  childId?: string;
}

export interface CachePort {
  lookup(key: string): Promise<CacheLookupHit | undefined>;
  store(key: string, value: unknown, childId?: string): Promise<void>;
}

/** A live child handle; `result` rejects only on infrastructure failure. */
export interface ChildHandle {
  readonly id: string;
  readonly result: Promise<ChildResult>;
  dispose(): Promise<void>;
}

/**
 * The run-cancel reason the engine's disposeAll uses on the whole-app
 * teardown path. It rides the shared child AbortSignal (`signal.reason`), so
 * the spawner can map it to the AgentTaskStopReason "app_shutdown" without a
 * seam-interface change; every other cancel reason maps to "user_cancel".
 */
export const WORKFLOW_APP_SHUTDOWN_CANCEL_REASON = "app_shutdown";
