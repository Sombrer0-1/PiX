/**
 * App-level agent task runtime (design plan §4.5, 1.4.1).
 *
 * Owns the global FIFO scheduler (default 4 running+waiting_input slots,
 * user-configurable up to 8), the
 * per-task input router (taskId+requestId+generation triple validation),
 * foreground auto-background timers, group detach semantics, Plan link
 * consumption and the bounded shutdown path. One `AgentTaskService` exists per
 * app (created by index.ts); the SDK `agent` tool and the Plan adapter
 * (SessionBridge) borrow it per submission.
 *
 * Freeze boundary: `createTaskGroup` completes preflight (agent/scope/model
 * resolution + project agent approval) while the parent generation is still
 * valid and returns only after every spec is frozen to plain data. Nothing in
 * `AgentTaskSubmissionContext` - objects or closures - is retained past that
 * boundary. `parallel` splits into one mode=single spec per item (each child
 * occupies its own global slot); `single` and `chain` are one spec each.
 *
 * Foreground contract: the caller (facade) awaits `awaitGroup`, which resolves
 * once every child is terminal (rebuilding the legacy SubagentDetails in the
 * original mode/order) or once the group detaches (direct/manual background or
 * session switch), whichever comes first. Auto-background (when enabled) only
 * flips panel presentation and never releases the parent await. Detaching
 * never restarts a task; it flips presentation, resolves the parent tool
 * await with a group handle, and auto-delivers each terminal result to the
 * parent session.
 *
 * 1.4.2 (R2) version surface: constructor opts REQUIRE {settings, events,
 * store, runId}; getAll returns AgentTaskListSnapshot; every task is persisted
 * (metadata + events.jsonl + checkpoint.json + index.json + a disk-backed
 * SessionManager transcript under <task>/sessions); restoreAll() hydrates all
 * pre-exit non-terminal tasks as interrupted at app ready; prepareShutdown()
 * freezes pre-status, bounded-aborts and writes matching runId close markers;
 * dispose is idempotent - without a prior prepareShutdown it only aborts and
 * never writes a clean marker. The named AgentTaskDelivery/AgentTaskRestoreReport
 * are the 1.4.2 contracts.
 */

import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  BUILTIN_AGENTS,
  resolveAgentsForScope,
  type AgentDefinition,
  type FileChangeSummary,
  type LoadAgentsResult,
  type ReadonlyModelRegistry,
  type RequestUserInputHandler,
  type TurnDiffSummary,
} from "@earendil-works/pi-coding-agent";
import type { ProductEventCollector } from "../product-event-collector.js";
import type { SettingsStore } from "../settings-store.js";
import type { SubagentParentRuntimeSnapshot, SubagentTaskItem } from "../subagent/types.js";
import { workspaceIdOf } from "./agent-task-identity.js";
import { AgentTaskInputRouter, type AgentTaskInputSettleReason } from "./agent-task-input.js";
import { AgentTaskScheduler } from "./agent-task-scheduler.js";
import {
  AgentTaskRuntime,
  type AgentTaskRuntimeEvent,
  type AgentTaskRuntimeResult,
} from "./agent-task-runtime.js";
import { AgentTaskResumer, type PreparedAgentTaskResume } from "./agent-task-resumer.js";
import {
  AGENT_TASK_INDEX_SCHEMA_VERSION,
  AgentTaskStore,
  TaskStorageLimitError,
  storageUsageLevel,
  type AgentTaskCloseMarker,
  type TaskBudgetReservation,
  type TaskCheckpoint,
  type TaskIndex,
  type TaskIndexEntry,
  type TaskLogEventPayload,
  type TaskMetadata,
} from "./agent-task-store.js";
import {
  AGENT_TASK_MAX_FINAL_OUTPUT_BYTES,
  AGENT_TASK_MAX_RECENT_ACTIVITIES,
  AGENT_TASK_SCHEMA_VERSION,
  DEFAULT_AUTO_BACKGROUND_MS,
  clampAgentTaskRunningSlots,
  DEFAULT_MAX_TURNS,
  type AgentTaskActivity,
  type AgentTaskDiagnosticExport,
  type AgentTaskFailureReason,
  type AgentTaskGroupHandle,
  type AgentTaskInfo,
  type AgentTaskInputRequest,
  type AgentTaskListSnapshot,
  type AgentTaskLogSnapshot,
  type AgentTaskPlanLink,
  type AgentTaskPresentation,
  type AgentTaskRecoveryIssue,
  type AgentTaskSpec,
  type AgentTaskStatus,
  type AgentTaskStopReason,
  type AgentTaskStorageStatus,
  type AgentTaskTranscriptPage,
  type AgentTaskUsage,
  type AgentDefinitionSnapshot,
  type AgentTaskItemSpec,
  type AgentTaskItemSummary,
  type ResumeDecision,
} from "../../shared/agent-task-types.js";
import {
  selectRetentionRemovals,
  type RetentionCandidate,
} from "./agent-task-retention.js";
import type { ProjectLocation } from "../../shared/project-location.js";
import type { ProductEvent, ProductEventErrorCategory, ProductEventName, ProductEventPayload } from "../../shared/product-events.js";
import {
  SUBAGENT_DETAILS_SCHEMA_VERSION,
  SUBAGENT_MAX_DESCRIPTION_CHARS,
  type SubagentAgentScope,
  type SubagentDetails,
  type SubagentFailureReason,
  type SubagentSingleResult,
} from "../../shared/subagent-types.js";
import type { AgentSessionEvent as SharedAgentSessionEvent, RequestUserInputResponse } from "../../shared/types.js";

export const MAX_PARALLEL_TASKS = 8;
export { DEFAULT_MAX_TURNS };
export const MAX_DELEGATED_PROMPT_BYTES = 64 * 1024;
export const AUTO_BACKGROUND_WARNING_LEAD_MS = 10_000;
/** Byte headroom reserved at creation/queue time for the task's transcript and logs (PRD C5). */
export const AGENT_TASK_CREATION_RESERVE_BYTES = 256 * 1024;
/** Bounded abort window of prepareShutdown (design plan §4.5). */
export const SHUTDOWN_ABORT_TIMEOUT_MS = 5_000;
const AUTO_BACKGROUND_ALLOWED_VALUES = [60_000, 120_000, 300_000] as const;
const EVENT_THROTTLE_MS = 100;
/** 1.5 (P3): per-task pending transcript queue capacity (overflow drops the oldest; the renderer's disk replay is the loss backstop). */
export const MAX_PENDING_TRANSCRIPTS = 1000;
/** 1.5 (P4): getTaskLog event cap - the snapshot keeps the newest 10000 and sets truncated. */
export const MAX_TASK_LOG_EVENTS = 10000;

// ============================================================================
// Public contract (design plan §4.5, 1.4.1)
// ============================================================================

/**
 * Borrowed only during the await of createTaskGroup; the service retains none
 * of these objects or closures past the freeze boundary.
 */
export interface AgentTaskSubmissionContext {
  parentSessionId: string;
  parentToolCallId: string;
  project: ProjectLocation;
  agentDir: string;
  loadedAgents: LoadAgentsResult | undefined; // undefined 时 preflight 必须回退 BUILTIN_AGENTS
  modelRegistry: ReadonlyModelRegistry; // 只在 preflight 借用 getAll/find/hasConfiguredAuth；不得保存
  parentRuntime: SubagentParentRuntimeSnapshot; // 值快照，不是 getter
  requestUserInput: RequestUserInputHandler; // 仅 preflight 项目 agent 授权期间借用，返回前释放
  hostDisposed: Promise<"host_disposed">; // 与 requestUserInput/父 signal 竞速，保留关闭分类
}

/**
 * Per-task workflow extras (design plan §4.6): parallel to `tasks` by index.
 * The agent tool never passes the field; only the workflow child spawner does.
 */
export interface WorkflowTaskExtra {
  /** Takes precedence over the agent definition's model (including "inherit"). */
  modelOverride?: string;
  /** Must already be a subset-legal ObjectJsonSchema; the service does no subset gate. */
  outputSchema?: unknown;
  /** Nested-session turn cap; when set, overrides the agent definition default. */
  maxTurns?: number;
}

export interface CreateTaskParams {
  mode: "single" | "parallel" | "chain"; // 保留现有模式
  agentScope: SubagentAgentScope;
  tasks: SubagentTaskItem[];
  runInBackground: boolean;
  planLink?: AgentTaskPlanLink;
  /** workflow children only; length MUST equal tasks.length (the spawner guarantees it). */
  workflowExtras?: WorkflowTaskExtra[];
}

export type AgentTaskAwaitResult =
  | { kind: "completed"; details: SubagentDetails }
  | { kind: "backgrounded"; handle: AgentTaskGroupHandle }
  | { kind: "failed"; details: SubagentDetails };

export type AgentTaskServiceEventV141 =
  | { type: "task_state"; task: AgentTaskInfo }
  | { type: "task_input"; request: AgentTaskInputRequest }
  | { type: "task_input_dismissed"; taskId: string; requestId: string; generation: number; reason: string }
  | { type: "task_activities"; taskId: string; activities: AgentTaskActivity[]; toolUseCount?: number; durationMs?: number }
  | { type: "task_output"; taskId: string; output: string; truncated: boolean }
  | { type: "task_file_change"; taskId: string; planLink?: AgentTaskPlanLink; change: FileChangeSummary; aggregate: TurnDiffSummary }; // main-only
// 1.4.2 (R2): storage_status / recovery_issue join the service event union.
// 1.5 (P1): task_removed - the retention pass deleted a terminal task record;
// the renderer mirror converges through this push.
export type AgentTaskServiceEvent =
  | AgentTaskServiceEventV141
  | { type: "storage_status"; status: AgentTaskStorageStatus }
  | { type: "recovery_issue"; issue: AgentTaskRecoveryIssue }
  | { type: "task_removed"; taskId: string }
  // 1.5 (P3): per-item transcript events for watched tasks (main-only union;
  // the adapters forward the same-shaped shared event verbatim).
  | { type: "task_transcript"; taskId: string; itemIndex: number; event: SharedAgentSessionEvent };

/** Main-only delivery content (1.4.2 named contract, design plan §4.5). */
export interface AgentTaskDelivery {
  taskId: string;
  groupId: string;
  planLink?: AgentTaskPlanLink;
  status: AgentTaskStatus;
  summary: string;
  finalOutput: string;
  errorMessage?: string;
  usage: AgentTaskUsage;
}
export type AgentTaskDeliveryContent = AgentTaskDelivery;

/** 1.4.2 (R2): restoreAll() report. 1.5 (P1) adds the auto-recovery counts. */
export interface AgentTaskRestoreReport {
  restored: number;
  interrupted: number;
  corrupted: number;
  autoResumed: number;
  autoFailed: number;
  diagnostics: string[];
}

export interface AgentTaskServiceOptions {
  settings: SettingsStore;
  events: ProductEventCollector;
  store: AgentTaskStore;
  /** Frozen at construction; prepareShutdown writes matching close markers with it. */
  runId: string;
}

// ============================================================================
// Test hooks (module-level, mirrors agent-task-runtime.ts)
// ============================================================================

export interface AgentTaskServiceTimerHandle {
  cancel: () => void;
}

export interface AgentTaskServiceTestHooks {
  /** Injectable clock for the auto-background deadline bookkeeping. */
  now?: () => number;
  /** Injectable timer factory (fake timers for short-timeout tests). */
  setTimer?: (callback: () => void, ms: number) => AgentTaskServiceTimerHandle;
  /** Injectable runtime factory (tests replace the real nested-session runtime). */
  runtimeFactory?: (spec: AgentTaskSpec, input: AgentTaskInputRouter, taskSessionDir?: string) => AgentTaskRuntime;
  /** Overrides the settings-derived auto-background delay (0 = off). */
  autoBackgroundMsOverride?: number;
  /** Overrides the per-task creation budget reservation (tests use tiny stores). */
  reserveBytesOverride?: number;
  /** 1.5 (P1): skip the post-hydration auto-recovery pass (hydration-focused tests). */
  disableAutoRecovery?: boolean;
  /** 1.5 (P1): retention window overrides (retention tests use tiny windows). */
  retentionOverride?: { keepCount?: number; keepAgeMs?: number; emergencyKeepCount?: number; undeliveredGraceMs?: number };
}

let testHooks: AgentTaskServiceTestHooks | undefined;

/**
 * Swap the service's time/timer/runtime factories. Not part of the public
 * contract; omitted in production. Returns a restore function.
 */
export function __setAgentTaskServiceHooksForTests(hooks: AgentTaskServiceTestHooks | undefined): () => void {
  const prev = testHooks;
  testHooks = hooks;
  return () => {
    testHooks = prev;
  };
}

// ============================================================================
// Internal state
// ============================================================================

interface PreflightItem {
  index: number;
  task: SubagentTaskItem;
  name: string;
  definition: AgentDefinition | undefined;
  description: string;
  modelSnapshot: Model<Api> | undefined;
  modelLabel: string | undefined;
  /** workflow schema children only: the frozen extra's outputSchema (host-defense checked). */
  outputSchema: unknown | undefined;
  /** workflow children: optional per-item maxTurns override from extras. */
  maxTurnsOverride: number | undefined;
  projectAgent: boolean;
  failure: { reason: AgentTaskFailureReason; message: string } | undefined;
}

interface GroupEntry {
  groupId: string;
  mode: "single" | "parallel" | "chain";
  agentScope: SubagentAgentScope;
  presentation: AgentTaskPresentation;
  parentSessionId: string;
  planLink?: AgentTaskPlanLink;
  taskIds: string[];
  createdAt: number;
  detached: boolean;
  /**
   * workflow children only (design plan §4.6): manual/auto backgrounding is
   * forbidden for these groups. 1.5 (P1): mirrored into every index entry so
   * hydration (and the retention exemption) survives restarts.
   */
  workflowOwned: boolean;
  autoBackgroundTimer: AutoBackgroundTimer | undefined;
  awaiters: Array<{ resolve: (result: AgentTaskAwaitResult) => void }>;
  terminalSnapshot: AgentTaskInfo[] | undefined;
}

interface AutoBackgroundTimer {
  deadlineAt: number;
  warningAt: number;
  warningActive: boolean;
  timers: AgentTaskServiceTimerHandle[];
}

interface TaskEntry {
  spec: AgentTaskSpec;
  info: AgentTaskInfo;
  runtime: AgentTaskRuntime | undefined;
  controller: AbortController | undefined;
  slotHeld: boolean;
  /** True after cancel() until the run settles; input settle must not restore running. */
  cancelRequested: boolean;
  /** 1.4.2 (R3): a resumed run is waiting for its first finalized assistant message (resume_succeeded). */
  resumedRun: boolean;
  stopReason: AgentTaskStopReason | undefined;
  /** 1.5 (P1): the owning group's workflow flag (fresh: from the group; hydrated: from the index entry). */
  workflowOwned: boolean;
  outputState: { text: string; truncated: boolean; originalBytes: number };
  throttle: {
    lastEmitAt: number;
    pendingActivities: AgentTaskActivity[];
    pendingOutput: { text: string; truncated: boolean; originalBytes: number } | undefined;
    // 1.5 (P3): throttled transcript queue; overflow drops the oldest entry.
    pendingTranscript: Array<{ itemIndex: number; event: SharedAgentSessionEvent }>;
    timer: AgentTaskServiceTimerHandle | undefined;
  };
  /** 1.4.2 (R2) persistence bookkeeping. */
  persist: TaskPersistenceState;
}

/**
 * Per-task persistence state. Writes flow through a per-task coalesced flush:
 * same-tick events/checkpoints/index updates are batched into one flush on the
 * serialized _flushTail, so "the same event's checkpoint+index land in one
 * batch" (design plan §4.7) and the index is only rewritten when an index
 * field actually changed.
 */
interface TaskPersistenceState {
  /** Whether task.json + the initial queued state were durably written. */
  initialized: boolean;
  /** Pending log payloads not yet appended (in order). */
  pendingEvents: TaskLogEventPayload[];
  /** Last known events.jsonl seq (0 = none appended yet). */
  eventSeq: number;
  /**
   * Checkpoints captured from the runtime, awaiting their flush. A queue, not
   * a single slot: every distinct finalized-message/ToolResult checkpoint must
   * be written once (design plan §4.7) even when several arrive inside the
   * same flush window.
   */
  pendingCheckpoints: TaskCheckpoint[];
  /** The last checkpoint actually written (rewritten by prepareShutdown). */
  lastCheckpoint: TaskCheckpoint | null;
  lastCheckpointSeq: number;
  hasUnclosedToolCall: boolean;
  /** Mirrors the index freeze fields (diagnostic). */
  preShutdownStatus: AgentTaskStatus | undefined;
  /** Mirrors the index stopReason freeze field. */
  preShutdownStopReason: AgentTaskStopReason | undefined;
  /** Coalescing flag: one flush per microtask per task. */
  flushScheduled: boolean;
  /** The in-memory budget reservation (released at terminal/clear). */
  reservationId: string | undefined;
  /** 1.4.2 (R3): the reservation taken by resume() (released on prepare failure / queued cancel / clear). */
  resumeReservationId: string | undefined;
  /** A storage-limit failure has already been applied (no double-fail). */
  storageFailed: boolean;
  /** Generation of the last written index (per workspace counter, see _indexGenerations). */
  indexDirty: boolean;
  /**
   * 1.4.2 (R3): resume()'s generation+1 critical-section writes are in
   * flight; a write failure inside it compensates the task back to
   * interrupted instead of finalizing it as failed (design plan §4.5).
   */
  resumePersistPending: boolean;
  /** Reason recorded by a compensated resume critical-section write failure. */
  resumePersistFailure: "storage_limit" | "internal_error" | undefined;
}

interface DeliverySinkEntry {
  workspaceId: string;
  sink: (content: AgentTaskDeliveryContent) => Promise<void>;
}

function emptyTaskUsage(): AgentTaskUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 };
}

function isTerminalStatus(status: AgentTaskInfo["status"]): status is "completed" | "failed" | "cancelled" {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Bounded single-line result description (mirrors subagent-tool.describeTask). */
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

function mapFailureCategory(reason: AgentTaskFailureReason | undefined): ProductEventErrorCategory {
  switch (reason) {
    case "model_unavailable":
    case "model_not_found":
    case "model_ambiguous":
      return "model_unavailable";
    case "model_auth_unavailable":
      return "auth_unavailable";
    default:
      return "internal_error";
  }
}

export class AgentTaskService {
  private readonly _settings: SettingsStore;
  private readonly _events: ProductEventCollector;
  private readonly _store: AgentTaskStore;
  private readonly _runId: string;
  private readonly _scheduler = new AgentTaskScheduler();
  private readonly _input: AgentTaskInputRouter;
  private readonly _tasks = new Map<string, TaskEntry>();
  private readonly _groups = new Map<string, GroupEntry>();
  private readonly _listeners = new Set<(event: AgentTaskServiceEvent) => void>();
  private readonly _deliverySinks = new Map<string, DeliverySinkEntry>();
  private readonly _inFlight = new Set<Promise<unknown>>();
  private readonly _recoveryIssues = new Map<string, AgentTaskRecoveryIssue>();
  private readonly _storageStatuses = new Map<string, AgentTaskStorageStatus>();
  private readonly _indexGenerations = new Map<string, number>();
  /** 1.4.2 (R3): per-task resume mutex (one resume request in flight per task). */
  private readonly _resumeLocks = new Set<string>();
  /** 1.5 (P3): per-task transcript watcher count (counting; 1-window app, no per-webContents distinction). */
  private readonly _watchers = new Map<string, number>();
  private readonly _resumer: AgentTaskResumer;
  private _disposed = false;
  private _disposePromise: Promise<void> | undefined;
  private _preparedShutdown = false;
  /** Serialized persistence drain: every scheduled flush chains here in order. */
  private _flushTail: Promise<void> = Promise.resolve();

  constructor(opts: AgentTaskServiceOptions) {
    this._settings = opts.settings;
    this._events = opts.events;
    this._store = opts.store;
    this._runId = opts.runId;
    this._input = new AgentTaskInputRouter({
      onRequest: (request) => this._onInputRequest(request),
      onSettled: (settle) => this._onInputSettled(settle),
    });
    this._scheduler.onSlotFree((taskId) => this._startTask(taskId));
    this._scheduler.setMaxSlots(this._readMaxConcurrentSlots());
    this._resumer = new AgentTaskResumer({
      store: this._store,
      runtimeFactory: (spec, taskSessionDir) => this._createRuntime(spec, taskSessionDir),
    });
  }

  /** Current AgentTask running-slot ceiling (1–8). */
  getMaxConcurrentSlots(): number {
    return this._scheduler.maxSlots;
  }

  /**
   * Re-read `agentTaskMaxConcurrent` from settings and apply it. Raising the
   * cap grants queued tasks immediately; lowering it only stops new grants.
   */
  syncMaxConcurrentSlotsFromSettings(): void {
    this._scheduler.setMaxSlots(this._readMaxConcurrentSlots());
  }

  private _readMaxConcurrentSlots(): number {
    const raw = (this._settings as unknown as { get: (key: string) => unknown }).get("agentTaskMaxConcurrent");
    return clampAgentTaskRunningSlots(raw);
  }

  // =========================================================================
  // Group creation / awaiting
  // =========================================================================

  /**
   * Preflight (agent/scope/model resolution + project agent approval) then
   * freeze every spec before returning. Tasks with at least one ready item are
   * enqueued into the global FIFO; fully rejected specs become stable terminal
   * failed tasks without ever occupying a slot; a lost approval race
   * (parent signal / host disposed) creates the whole group as cancelled.
   */
  async createTaskGroup(
    params: CreateTaskParams,
    parent: AgentTaskSubmissionContext,
    presentation: AgentTaskPresentation,
    signal?: AbortSignal,
  ): Promise<AgentTaskGroupHandle> {
    const now = this._now();
    const effectivePresentation: AgentTaskPresentation = params.runInBackground ? "background" : presentation;
    // Workflow extras are the spawner's per-index parallel array; they only
    // take effect when they cover every task (the spawner guarantees it). A
    // mismatched array is ignored like an absent one.
    const workflowOwned = params.workflowExtras != null && params.workflowExtras.length === params.tasks.length;
    const items = this._preflight(params, parent);
    const approval = await this._resolveProjectApproval(items, parent, signal);

    const groupId = randomUUID();
    const group: GroupEntry = {
      groupId,
      mode: params.mode,
      agentScope: params.agentScope,
      presentation: effectivePresentation,
      parentSessionId: parent.parentSessionId,
      planLink: params.planLink ? { ...params.planLink } : undefined,
      taskIds: [],
      createdAt: now,
      // Direct background releases the parent await immediately (lane B).
      detached: effectivePresentation === "background",
      workflowOwned,
      autoBackgroundTimer: undefined,
      awaiters: [],
      terminalSnapshot: undefined,
    };
    this._groups.set(groupId, group);

    // Build one spec per runnable unit: parallel splits per item (each child
    // takes its own slot), single/chain stay whole. Denial marks the denied
    // project items rejected (chain denial atomically rejects every item so
    // nothing executes); a lost race leaves the items ready but aborts the
    // whole group before any enqueue.
    const specs = this._buildSpecs(params, parent, groupId, items, now, approval);

    // 1. Create every entry first so the group is fully known before any
    //    enqueue/timer logic runs.
    for (const spec of specs) {
      group.taskIds.push(spec.taskId);
      this._createTaskEntry(spec, effectivePresentation);
    }

    // 1b. 1.4.2: reserve budget and durably initialize each task (metadata +
    // initial queued state + initial checkpoint + index) before it can be
    // enqueued. A storage-limit reservation failure finalizes exactly that
    // task as failed(storage_limit) and never touches the original files.
    for (const spec of specs) {
      const outcome = await this._initializeTaskPersistence(spec.taskId);
      if (outcome === "storage_limit") {
        this._finalizeTaskStorageLimit(spec.taskId);
      } else if (outcome === "internal_error") {
        this._finalizeTaskInternalError(spec.taskId);
      }
    }

    // 2. Enqueue runnable tasks / finalize non-runnable ones. Non-runnable
    //    groups (all items rejected / lost race) never start a timer.
    for (const spec of specs) {
      const entry = this._tasks.get(spec.taskId)!;
      if (approval.kind === "cause") {
        // The whole group aborts before any task enqueues; first cause wins.
        this._finalizeTaskRaceAborted(spec.taskId, approval.cause);
      } else if (entry.info.status === "failed") {
        // Already finalized by the storage-limit/internal-error persistence
        // path; nothing to enqueue.
      } else if (!entry.spec.items.some((item) => item.resolution === "ready")) {
        this._finalizeTaskPreflightFailed(spec.taskId);
      } else {
        this._recordProductEvent("agent_task_started", {
          status: "queued",
          counts: { tasks: 1 },
          model: this._firstItemModel(entry.info),
        });
        this._scheduler.enqueue(spec.taskId);
      }
    }

    // 3. Start the group-level auto-background timer (still-attached
    //    foreground only). Expiry only flips panel presentation; it never
    //    detaches or resolves the parent await. Workflow-owned groups are
    //    exempt (design plan §4.6).
    const hasNonTerminal = group.taskIds.some((taskId) => {
      const entry = this._tasks.get(taskId);
      return entry !== undefined && !isTerminalStatus(entry.info.status);
    });
    if (effectivePresentation === "foreground" && hasNonTerminal && !workflowOwned) {
      this._startAutoBackgroundTimer(group);
    }

    // 4. Emit the final initial state for every child (queued snapshots carry
    //    queuePosition + the mirrored autoBackground deadline).
    for (const taskId of group.taskIds) {
      this._emitTaskState(taskId);
    }
    this._refreshQueuePositions();
    this._checkGroupTerminal(groupId);
    return this._buildGroupHandle(group);
  }

  /**
   * Wait for the group: a still-attached group resolves when every child is
   * terminal (details rebuilt in original mode/order) or when it detaches
   * (direct/manual background or session switch), whichever comes first; a
   * detached group resolves immediately with its handle.
   */
  async awaitGroup(groupId: string): Promise<AgentTaskAwaitResult> {
    const group = this._groups.get(groupId);
    if (!group) {
      throw new Error(`Unknown agent task group "${groupId}".`);
    }
    if (group.detached) {
      return { kind: "backgrounded", handle: this._buildGroupHandle(group) };
    }
    if (group.terminalSnapshot) {
      return this._buildAwaitResult(group);
    }
    return new Promise((resolve) => {
      group.awaiters.push({ resolve });
    });
  }

  // =========================================================================
  // Task commands (renderer-driven; every command carries taskId+generation)
  // =========================================================================

  async cancel(taskId: string, generation: number, reason: AgentTaskStopReason): Promise<{ ok: boolean; reason?: string }> {
    const entry = this._tasks.get(taskId);
    if (!entry) return { ok: false, reason: "not_found" };
    if (entry.info.generation !== generation) return { ok: false, reason: "stale_generation" };
    if (this._disposed) return { ok: false, reason: "service_disposed" };
    if (isTerminalStatus(entry.info.status)) return { ok: false, reason: "already_terminal" };
    if (entry.info.status === "interrupted") {
      // Restored tasks have no live runtime; they are cleared or resumed, not cancelled.
      return { ok: false, reason: "task_not_active" };
    }
    entry.stopReason = reason;
    entry.cancelRequested = true;
    if (entry.info.status === "queued") {
      // Queued abort removes the waiter immediately; it never occupies a slot.
      this._scheduler.dequeue(taskId);
      this._finalizeTaskCancelled(taskId);
      this._refreshQueuePositions();
      this._checkGroupTerminal(entry.info.groupId);
      return { ok: true };
    }
    // running / waiting_input: abort the runtime; its run settles as cancelled.
    entry.controller?.abort();
    entry.runtime?.abort();
    return { ok: true };
  }

  async cancelGroup(groupId: string, reason: AgentTaskStopReason): Promise<void> {
    const group = this._groups.get(groupId);
    if (!group) return;
    // 1.4.2 (R4): a detached group has backgrounded and keeps running in the
    // app service. The parent-signal path (facade onAbort -> cancelGroup)
    // must never cancel it: the session switch / parent tool promise end is
    // not a user_cancel. The facade removes its listener in the awaitGroup
    // continuation's finally, and this guard closes the microtask window
    // before the removal lands. Explicit per-task IPC cancel (user action on
    // a background task) still goes through cancel() and is unaffected.
    if (group.detached) {
      return;
    }
    const entries = group.taskIds
      .map((taskId) => this._tasks.get(taskId))
      .filter((entry): entry is TaskEntry => entry !== undefined);
    await Promise.all(entries.map((entry) => this.cancel(entry.info.taskId, entry.info.generation, reason)));
  }

  /** Detach every still-attached group of the given parent session (session switch/close path). */
  detachForegroundGroupsForSession(parentSessionId: string): AgentTaskGroupHandle[] {
    const handles: AgentTaskGroupHandle[] = [];
    for (const group of this._groups.values()) {
      if (group.parentSessionId === parentSessionId && !group.detached && !group.terminalSnapshot) {
        this._detachGroup(group);
        handles.push(this._buildGroupHandle(group));
      }
    }
    return handles;
  }

  /** Deliver the user's answer; the response id must equal the request id. */
  respondInput(taskId: string, requestId: string, generation: number, response: RequestUserInputResponse): boolean {
    const entry = this._tasks.get(taskId);
    if (!entry || entry.info.generation !== generation) return false;
    if (!this._input.respond(taskId, requestId, generation, response)) return false;
    entry.runtime?.resolveInput(requestId, response);
    return true;
  }

  cancelInput(taskId: string, requestId: string, generation: number): boolean {
    const entry = this._tasks.get(taskId);
    if (!entry || entry.info.generation !== generation) return false;
    if (!this._input.cancel(taskId, requestId, generation)) return false;
    entry.runtime?.cancelInput(requestId);
    return true;
  }

  /**
   * Deliver the structured task result to a Solo session sink registered for
   * the same workspace. The sink injects into a streaming parent via followUp
   * and starts a turn when idle. Default: once per task per target session;
   * a repeat requires confirmDuplicate.
   */
  async sendResultToSession(
    taskId: string,
    generation: number,
    targetSessionId: string,
    confirmDuplicate?: boolean,
  ): Promise<{ ok: boolean; reason?: string }> {
    const entry = this._tasks.get(taskId);
    if (!entry) return { ok: false, reason: "not_found" };
    if (entry.info.generation !== generation) return { ok: false, reason: "stale_generation" };
    const sink = this._deliverySinks.get(targetSessionId);
    if (!sink) return { ok: false, reason: "target_session_not_open" };
    if (sink.workspaceId !== entry.info.workspaceId) return { ok: false, reason: "workspace_mismatch" };
    if (entry.info.deliveredSessionIds.includes(targetSessionId) && confirmDuplicate !== true) {
      return { ok: false, reason: "duplicate_delivery" };
    }
    const content: AgentTaskDeliveryContent = {
      taskId: entry.info.taskId,
      groupId: entry.info.groupId,
      planLink: entry.info.planLink,
      status: entry.info.status,
      summary: this._resultSummary(entry.info),
      finalOutput: entry.info.finalOutput,
      errorMessage: entry.info.errorMessage,
      usage: { ...entry.info.usage },
    };
    try {
      await sink.sink(content);
    } catch (error) {
      const message = error instanceof Error && error.message !== "" ? error.message : "delivery_failed";
      return { ok: false, reason: message };
    }
    entry.info.deliveredSessionIds.push(targetSessionId);
    entry.info.updatedAt = this._now();
    entry.persist.pendingEvents.push({ type: "delivery", targetSessionId, deliveredAt: this._now() });
    this._schedulePersist(taskId);
    this._emitTaskState(taskId);
    return { ok: true };
  }

  /**
   * 1.5 (P1): the single deletion primitive for the retention pass - deletes
   * the on-disk record (index, log, checkpoint, transcript), drops any recovery
   * issue, removes the in-memory entry and notifies the renderer through
   * task_removed. Runs only from the serialized retention pass, after the
   * task's pending persistence flushes have drained.
   */
  private async _deleteTaskRecord(entry: TaskEntry): Promise<void> {
    const workspaceId = entry.info.workspaceId;
    await this._store.deleteTask(workspaceId, entry.info.taskId);
    this._recoveryIssues.delete(entry.info.taskId);
    this._removeTask(entry);
    // The persistent index must forget the deleted task, otherwise a restart
    // re-surfaces it as a "recovery data corrupt" record (an index entry whose
    // task.json no longer exists).
    const nextGeneration = await this._store.removeFromIndex(workspaceId, entry.info.taskId, this._runId);
    if (nextGeneration !== undefined) {
      this._indexGenerations.set(workspaceId, nextGeneration);
    }
    this._emitServiceEvent({ type: "task_removed", taskId: entry.info.taskId });
  }

  /**
   * Export diagnostics for a task record (schema/seq/error position/status
   * metadata only - never prompt/code/tool output). Works for recovery-corrupt
   * records too (they have no in-memory entry but the record exists on disk).
   */
  async getDiagnostics(taskId: string): Promise<AgentTaskDiagnosticExport> {
    const entry = this._tasks.get(taskId);
    const issue = entry === undefined ? this._recoveryIssues.get(taskId) : undefined;
    if (entry === undefined && issue === undefined) {
      throw new Error("not_found");
    }
    const workspaceId = entry?.info.workspaceId ?? issue!.workspaceId;
    const read = await this._store.readTask(workspaceId, taskId);
    const info = entry?.info;
    const content = JSON.stringify(
      {
        schemaVersion: AGENT_TASK_SCHEMA_VERSION,
        exportedAt: Date.now(),
        taskId,
        workspaceId,
        metadataSchemaVersion: read.metadata?.schemaVersion,
        status: info?.status,
        generation: info?.generation,
        lastCheckpointSeq: info?.lastCheckpointSeq,
        diagnostics: read.diagnostics,
        // Events are metadata only: seq/type/ts, never payload content.
        events: read.events.map((event) => ({ seq: event.seq, ts: event.ts, type: event.type })),
        checkpoint:
          read.checkpoint === null
            ? null
            : {
                seq: read.checkpoint.seq,
                generation: read.checkpoint.generation,
                activeItemIndex: read.checkpoint.activeItemIndex,
                sessionFileName: read.checkpoint.sessionFileName,
                sessionLeafId: read.checkpoint.sessionLeafId,
                openToolCalls: read.checkpoint.openToolCalls,
                fingerprintSummary: {
                  isGit: read.checkpoint.workspaceFingerprint.isGit,
                  observedPathCount: Object.keys(read.checkpoint.workspaceFingerprint.observedFileHashes).length,
                },
              },
      },
      null,
      2,
    );
    return { fileName: `agent-task-${taskId}.diagnostics.json`, content };
  }

  /**
   * 1.4.2 (R3): safe resume. One in-flight request per task (mutex); the
   * storage budget is reserved BEFORE AgentTaskResumer.prepare touches the
   * transcript, so a budget failure never modifies it; prepare/enqueue
   * failures release the reservation and keep (or compensate back to)
   * interrupted. Only after the generation+1 queued state event -> generation+1
   * checkpoint -> index writes landed is the prepared runtime handed to the
   * global FIFO; on slot grant the SAME runtime runs (its resume seed triggers
   * the fixed RESUME_TURN_MESSAGE turn).
   */
  async resume(taskId: string, generation: number, decision: ResumeDecision): Promise<{ ok: boolean; reason?: string }> {
    const entry = this._tasks.get(taskId);
    if (!entry) return { ok: false, reason: "not_found" };
    if (entry.info.generation !== generation) return { ok: false, reason: "stale_generation" };
    if (this._disposed) return { ok: false, reason: "service_disposed" };
    if (entry.info.status !== "interrupted") return { ok: false, reason: "task_not_interrupted" };
    if (this._resumeLocks.has(taskId)) return { ok: false, reason: "resume_in_progress" };
    const checkpoint = entry.persist.lastCheckpoint;
    if (checkpoint === null) return { ok: false, reason: "checkpoint_unavailable" };

    this._resumeLocks.add(taskId);
    this._recordProductEvent("agent_task_resume_requested", { status: "requested" });
    let reservation: TaskBudgetReservation | undefined;
    try {
      // Reserve the budget FIRST: the resumer's repair peaks and the
      // queued-state/checkpoint writes must fit before any transcript write.
      const reserveBytes = testHooks?.reserveBytesOverride ?? AGENT_TASK_CREATION_RESERVE_BYTES;
      try {
        reservation = await this._store.reserveBudget(entry.info.workspaceId, entry.info.taskId, reserveBytes);
      } catch (err) {
        if (err instanceof TaskStorageLimitError) {
          this._recordProductEvent("agent_task_resume_failed", { status: "failed", errorCategory: "internal_error" });
          return { ok: false, reason: "storage_limit" };
        }
        console.error("[AgentTaskService] resume budget reservation failed:", err);
        this._recordProductEvent("agent_task_resume_failed", { status: "failed", errorCategory: "internal_error" });
        return { ok: false, reason: "internal_error" };
      }

      let outcome: { ok: true; prepared: PreparedAgentTaskResume } | { ok: false; reason: string };
      try {
        outcome = await this._resumer.prepare(entry.info, checkpoint, decision);
      } catch (err) {
        // Defense in depth: prepare normalizes every known failure to the
        // {ok:false;reason} contract; anything else must not break the
        // service's own return contract.
        console.error("[AgentTaskService] resume prepare threw:", err);
        outcome = { ok: false, reason: "internal_error" };
      }
      if (!outcome.ok) {
        this._store.releaseBudget(reservation.reservationId);
        if (outcome.reason === "mid_log_corrupt") {
          // events.jsonl mid-log corruption: the record is read-only until
          // cleared; surface it as a recovery issue instead of a terminal
          // failure (design plan §5.5-4).
          this._emitRecoveryIssue({
            taskId: entry.info.taskId,
            workspaceId: entry.info.workspaceId,
            generation: entry.info.generation,
            code: "mid_log_corrupt",
            message: "the task events log is mid-log corrupt; resume is blocked until the record is cleared",
            recoverable: false,
            readOnly: true,
            updatedAt: Date.now(),
          });
        }
        this._recordProductEvent("agent_task_resume_failed", { status: "failed", errorCategory: "internal_error" });
        return { ok: false, reason: outcome.reason };
      }
      const prepared = outcome.prepared;
      entry.persist.resumeReservationId = reservation.reservationId;
      reservation = undefined; // handed to the entry; released on cancel/clear

      // Serialized persistence critical section: generation+1 queued state
      // event (with the effectiveModel written into the corresponding
      // itemSummary) -> generation+1 checkpoint -> index. A write failure in
      // this window compensates the task back to interrupted (never a terminal
      // failed) and is reported through persist.resumePersistFailure.
      const from = entry.info.status;
      entry.info.generation = prepared.generation;
      const summary = entry.info.itemSummaries[prepared.activeItemIndex];
      if (summary !== undefined) {
        summary.model = { provider: prepared.effectiveModel.provider, modelId: prepared.effectiveModel.modelId };
      }
      entry.info.status = "queued";
      entry.info.updatedAt = this._now();
      this._logStateEvent(entry, from, "queued", "resume prepared");
      entry.persist.pendingCheckpoints.push({ ...prepared.checkpoint, generation: entry.info.generation });
      // 1.5 (P3): the resumed item's session file is FINAL (the seed's
      // sessionFileName, overriding any file the resumer created for the next
      // item). The runtime cannot emit item_session before run() attaches its
      // event channel, so the service persists the mapping from the prepared
      // checkpoint - the same fact the runtime reports at item start.
      if (prepared.checkpoint.sessionFileName !== null) {
        entry.persist.pendingEvents.push({
          type: "item_session",
          itemIndex: prepared.activeItemIndex,
          sessionFileName: prepared.checkpoint.sessionFileName,
        });
      }
      entry.persist.indexDirty = true;
      entry.persist.resumePersistPending = true;
      try {
        this._schedulePersist(taskId);
        await this._drainPersist();
      } finally {
        entry.persist.resumePersistPending = false;
      }
      const persistFailure = entry.persist.resumePersistFailure;
      entry.persist.resumePersistFailure = undefined;
      if (entry.info.status !== "queued") {
        // A concurrent cancel finalized the task, or the persistence flush
        // compensated a failed critical-section write back to interrupted;
        // either way the prepared runtime must not leak and the reservation
        // goes back.
        this._releaseResumeReservation(entry);
        await prepared.runtime.dispose().catch(() => {});
        this._recordProductEvent("agent_task_resume_failed", { status: "failed", errorCategory: "internal_error" });
        return { ok: false, reason: persistFailure ?? entry.info.failureReason ?? "persist_failed" };
      }

      entry.runtime = prepared.runtime;
      entry.resumedRun = true;
      // 1.5 (P3): resume handoff - a watcher that subscribed during the
      // interrupted/queued phase must keep the stream once the slot grants the
      // run (the count is also applied at the _startTask creation point).
      if ((this._watchers.get(taskId) ?? 0) > 0) {
        entry.runtime.setTranscriptForwarding(true);
      }
      this._emitTaskState(taskId);
      this._scheduler.enqueue(taskId);
      this._refreshQueuePositions();
      this._checkGroupTerminal(entry.info.groupId);
      return { ok: true };
    } finally {
      if (reservation !== undefined) {
        this._store.releaseBudget(reservation.reservationId);
      }
      this._resumeLocks.delete(taskId);
    }
  }

  /**
   * 1.4.2 (R3) manual mark-failed became the 1.5 (P1) internal convergence for
   * interrupted tasks the auto-recovery pass could not resume: failed with the
   * dedicated resume_blocked code (never user_decision - no user decided) and
   * the concrete resume failure reason in the message. The failed result is
   * auto-delivered to the parent session like any terminal background task.
   */
  async markFailed(
    taskId: string,
    generation: number,
    reason: "user_decision" | "resume_blocked",
    message?: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const entry = this._tasks.get(taskId);
    if (!entry) return { ok: false, reason: "not_found" };
    if (entry.info.generation !== generation) return { ok: false, reason: "stale_generation" };
    if (this._disposed) return { ok: false, reason: "service_disposed" };
    if (entry.info.status !== "interrupted") return { ok: false, reason: "task_not_interrupted" };
    const now = this._now();
    const from = entry.info.status;
    entry.info.status = "failed";
    entry.info.failureReason = reason;
    entry.info.errorMessage =
      message ??
      (reason === "resume_blocked"
        ? "The interrupted task could not be resumed automatically after restart."
        : "The task was marked failed by the user.");
    entry.info.endedAt = now;
    entry.info.durationMs = Math.max(0, now - (entry.info.startedAt ?? now));
    entry.info.autoBackground = undefined;
    entry.info.queuePosition = undefined;
    entry.info.updatedAt = now;
    this._logStateEvent(entry, from, "failed", reason);
    entry.persist.indexDirty = true;
    this._schedulePersist(taskId);
    this._emitTaskState(taskId);
    this._recordProductEvent("agent_task_failed", {
      status: "failed",
      durationMs: entry.info.durationMs,
      errorCategory: "internal_error",
      model: this._firstItemModel(entry.info),
    });
    this._checkGroupTerminal(entry.info.groupId);
    this._maybeAutoDeliver(entry);
    return { ok: true };
  }

  // =========================================================================
  // Plan link callbacks (main-only, consumed by the Plan adapter)
  // =========================================================================

  async getPlanTaskGroupResult(
    groupId: string,
    link: AgentTaskPlanLink,
  ): Promise<{ ok: true; status: "completed" | "failed" | "cancelled"; taskIds: string[]; summary: string } | { ok: false; reason: string }> {
    const group = this._groups.get(groupId);
    if (!group) return { ok: false, reason: "group_not_found" };
    if (!group.planLink || !this._linksEqual(group.planLink, link)) return { ok: false, reason: "link_mismatch" };
    if (!group.terminalSnapshot) return { ok: false, reason: "group_not_terminal" };
    const infos = group.terminalSnapshot;
    let status: "completed" | "failed" | "cancelled";
    if (infos.every((info) => info.status === "completed")) {
      status = "completed";
    } else if (infos.some((info) => info.status === "failed")) {
      status = "failed";
    } else {
      status = "cancelled";
    }
    // The summary must list every taskId/status; partial success is never hidden.
    const summary = infos.map((info) => `${info.taskId}: ${info.status}`).join("; ");
    return { ok: true, status, taskIds: infos.map((info) => info.taskId), summary };
  }

  /** Idempotent Plan result consumption: pending -> consumed on every linked task. */
  async confirmPlanTaskGroupConsumed(groupId: string, link: AgentTaskPlanLink): Promise<void> {
    this._applyPlanLinkTransition(groupId, link, "consumed");
  }

  /** Idempotent Plan release (revision/cancel): pending -> released on every linked task. */
  async releasePlanTaskGroup(groupId: string, link: AgentTaskPlanLink, reason: "plan_revised" | "plan_cancelled"): Promise<void> {
    this._applyPlanLinkTransition(groupId, link, "released", reason);
  }

  // =========================================================================
  // Query surface
  // =========================================================================

  /** 1.4.2 (R2): get_all returns the full remount snapshot (tasks + recovery issues + storage statuses). */
  getAll(workspaceId?: string): AgentTaskListSnapshot {
    const tasks = [...this._tasks.values()].map((entry) => entry.info);
    const filtered = workspaceId === undefined ? tasks : tasks.filter((info) => info.workspaceId === workspaceId);
    filtered.sort((a, b) => a.createdAt - b.createdAt);
    const recoveryIssues = [...this._recoveryIssues.values()]
      .filter((issue) => workspaceId === undefined || issue.workspaceId === workspaceId)
      .sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
    const storageStatuses = [...this._storageStatuses.values()].filter(
      (status) => workspaceId === undefined || status.workspaceId === workspaceId,
    );
    return {
      tasks: filtered.map((info) => structuredClone(info)),
      recoveryIssues: recoveryIssues.map((issue) => structuredClone(issue)),
      storageStatuses: storageStatuses.map((status) => structuredClone(status)),
    };
  }

  getActiveInputRequests(): AgentTaskInputRequest[] {
    return this._input.getPending();
  }

  /**
   * 1.5 (P3): register a transcript watcher (counting; TaskDetailPanel is the
   * single owner). Unknown tasks return false without throwing. The 0->1
   * transition enables the runtime's live forwarding when a runtime already
   * exists; a later runtime creation (_startTask / resume handoff) re-applies
   * the current count so a queued-phase subscription never misses the stream.
   */
  watchTask(taskId: string): boolean {
    const entry = this._tasks.get(taskId);
    if (!entry) {
      return false;
    }
    const prev = this._watchers.get(taskId) ?? 0;
    this._watchers.set(taskId, prev + 1);
    if (prev === 0) {
      entry.runtime?.setTranscriptForwarding(true);
    }
    return true;
  }

  /** 1.5 (P3): release one watcher reference; an unknown task is an idempotent no-op (success). */
  unwatchTask(taskId: string): void {
    const prev = this._watchers.get(taskId) ?? 0;
    if (prev <= 1) {
      this._watchers.delete(taskId);
    } else {
      this._watchers.set(taskId, prev - 1);
    }
    if (prev === 1) {
      this._tasks.get(taskId)?.runtime?.setTranscriptForwarding(false);
    }
  }

  /** 1.5 (P3): adapters query - does the task hold at least one watcher? */
  isTaskWatched(taskId: string): boolean {
    return (this._watchers.get(taskId) ?? 0) > 0;
  }

  /**
   * 1.5 (P3): 宽松读取任务 transcript 页(design plan §4.3/§4.5)。任务不在
   * 镜像时抛 Error("not_found");item->session 文件映射由任务日志的
   * item_session 条目回放构建(后写覆盖先写),无条目的旧任务走降级路径
   * (单文件直映/字典序序数);读文件异常向上抛原始错误(getTaskLog 属 S6)。
   */
  async getTranscriptPage(
    taskId: string,
    itemIndex: number,
    cursor: string | undefined,
    limit: number,
  ): Promise<AgentTaskTranscriptPage> {
    const entry = this._tasks.get(taskId);
    if (!entry) {
      throw new Error("not_found");
    }
    // The mapping must reflect the latest flush (a runtime item_session emitted
    // in the same tick would otherwise be missed by the log replay below).
    await this._drainPersist();
    const read = await this._store.readTask(entry.info.workspaceId, taskId);
    const mapping = new Map<number, string>();
    for (const event of read.events) {
      if (event.type === "item_session") {
        mapping.set(event.itemIndex, event.sessionFileName);
      }
    }
    let sessionFileName: string | undefined;
    if (mapping.size > 0) {
      sessionFileName = mapping.get(itemIndex);
    } else {
      // Legacy task without item_session entries: one file maps every item;
      // several files fall back to the lexicographic ordinal (best effort, no
      // migration - orphan files are a known historical limitation).
      const files = await this._store.listSessionFiles(entry.info.workspaceId, taskId);
      if (files.length === 1) {
        sessionFileName = files[0];
      } else if (files.length > 1) {
        sessionFileName = files[itemIndex];
      }
    }
    if (sessionFileName === undefined) {
      // No mapping and no file to fall back on: an honest empty page.
      return { taskId, itemIndex, entries: [], totalCount: 0, nextCursor: null };
    }
    const page = await this._store.readTranscriptPage(entry.info.workspaceId, taskId, sessionFileName, cursor, limit);
    return { taskId, itemIndex, ...page };
  }

  /**
   * 1.5 (P4): 任务事件日志快照(design plan §4.2/§4.5)。任务不在镜像时抛
   * Error("not_found");内部先 await _drainPersist() 保证终态后立即读取也能
   * 看到已 flush 的尾部(事件/checkpoint 排队在串行 flush 队列上),再 readTask。
   * 超过 MAX_TASK_LOG_EVENTS 条时只保留最新 10000 条并置 truncated=true。
   */
  async getTaskLog(taskId: string): Promise<AgentTaskLogSnapshot> {
    const entry = this._tasks.get(taskId);
    if (!entry) {
      throw new Error("not_found");
    }
    await this._drainPersist();
    const read = await this._store.readTask(entry.info.workspaceId, taskId);
    const truncated = read.events.length > MAX_TASK_LOG_EVENTS;
    const events = truncated ? read.events.slice(-MAX_TASK_LOG_EVENTS) : read.events;
    return { taskId, events, truncated };
  }

  registerSessionDeliverySink(
    sessionId: string,
    workspaceId: string,
    sink: (content: AgentTaskDeliveryContent) => Promise<void>,
  ): () => void {
    this._deliverySinks.set(sessionId, { workspaceId, sink });
    // 1.5 (P1): the manual send-to-session fallback is gone; a session sink
    // coming up is the one moment an undelivered terminal result can finally
    // land, so catch up right here (sendResultToSession deduplicates through
    // deliveredSessionIds, making the scan idempotent).
    this._deliverPendingTerminalTasks(sessionId, workspaceId);
    return () => {
      if (this._deliverySinks.get(sessionId)?.sink === sink) {
        this._deliverySinks.delete(sessionId);
      }
    };
  }

  onEvent(listener: (event: AgentTaskServiceEvent) => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /**
   * Idempotent bounded shutdown. After a prior prepareShutdown it only
   * releases service resources; without one (emergency cleanup) it freezes
   * every non-terminal task's pre-status in memory, aborts, and NEVER writes a
   * clean marker - the abort-induced late "cancelled" settles are suppressed
   * by _finalizeTask, so the on-disk state stays the pre-exit non-terminal
   * facts and restore hydrates them as interrupted (1.4.2).
   */
  async dispose(reason: AgentTaskStopReason): Promise<void> {
    if (this._disposePromise) {
      await this._disposePromise;
      return;
    }
    this._disposed = true;
    this._disposePromise = this._disposeImpl(reason);
    await this._disposePromise;
  }

  private async _disposeImpl(reason: AgentTaskStopReason): Promise<void> {
    for (const group of this._groups.values()) {
      this._cancelAutoBackgroundTimer(group);
    }
    for (const entry of this._tasks.values()) {
      if (!isTerminalStatus(entry.info.status)) {
        if (entry.persist.preShutdownStatus === undefined) {
          entry.persist.preShutdownStatus = entry.info.status;
          entry.persist.preShutdownStopReason = reason;
          entry.info.stopReason = reason;
        }
        if (entry.info.status === "queued") {
          this._scheduler.dequeue(entry.info.taskId);
          // 1.4.2 (R3): a prepared (resumed) queued runtime never started; it
          // must not leak its open session/backend at shutdown. The dispose is
          // tracked in _inFlight so this dispose's own aggregation waits for
          // it (exit cleanup is never truncated).
          if (entry.runtime !== undefined) {
            this._trackInFlight(entry.runtime.dispose().catch(() => {}));
            entry.runtime = undefined;
          }
          this._releaseResumeReservation(entry);
        } else {
          entry.controller?.abort();
          entry.runtime?.abort();
        }
      }
    }
    // 1.4.2: settle pending inputs only AFTER the freeze loop so the emergency
    // dispose path freezes the true pre-exit status (waiting_input, not the
    // settle-induced running); the _onInputSettled guard keeps the settle from
    // rewriting the frozen fact.
    this._input.settleOnShutdown();
    // Flush whatever was queued before the freeze (never write markers here).
    await this._drainPersist();
    await Promise.allSettled([...this._inFlight]);
  }

  /**
   * 1.4.2: freeze every non-terminal task's preShutdownStatus + app_shutdown,
   * persist the frozen facts (index/checkpoint with this run's runId), abort
   * with a 5s bound, then write matching close markers for every workspace.
   * The bounded abort's late "cancelled" never overwrites the frozen facts
   * (see _finalizeTask).
   */
  async prepareShutdown(): Promise<void> {
    if (this._preparedShutdown || this._disposed) {
      return;
    }
    this._preparedShutdown = true;
    const frozen: TaskEntry[] = [];
    for (const entry of this._tasks.values()) {
      if (!isTerminalStatus(entry.info.status) && entry.persist.preShutdownStatus === undefined) {
        entry.persist.preShutdownStatus = entry.info.status;
        entry.persist.preShutdownStopReason = "app_shutdown";
        entry.info.stopReason = "app_shutdown";
        entry.persist.indexDirty = true;
        // Rewrite the last checkpoint with a fresh timestamp (design plan §4.5:
        // "persist pre-status -> ... -> 写 index/checkpoint").
        if (entry.persist.lastCheckpoint !== null) {
          entry.persist.pendingCheckpoints.push({
            ...entry.persist.lastCheckpoint,
            ts: Date.now(),
          });
        }
        this._schedulePersist(entry.info.taskId);
        frozen.push(entry);
      }
    }
    await this._drainPersist();

    // Bounded abort: queued tasks are removed immediately; running/waiting_input
    // get up to SHUTDOWN_ABORT_TIMEOUT_MS to settle. A prepared (resumed)
    // queued runtime never started and must not leak its open session/backend.
    for (const entry of frozen) {
      if (entry.info.status === "queued") {
        this._scheduler.dequeue(entry.info.taskId);
        if (entry.runtime !== undefined) {
          // 1.4.2 (R3): a prepared (resumed) queued runtime never started; its
          // dispose is tracked in _inFlight so the bounded-abort wait below
          // covers it (exit cleanup is never truncated).
          this._trackInFlight(entry.runtime.dispose().catch(() => {}));
          entry.runtime = undefined;
        }
        this._releaseResumeReservation(entry);
      } else {
        entry.controller?.abort();
        entry.runtime?.abort();
      }
    }
    if (this._inFlight.size > 0) {
      const deadline = new Promise<"deadline">((resolve) => {
        setTimeout(() => resolve("deadline"), SHUTDOWN_ABORT_TIMEOUT_MS);
      });
      await Promise.race([Promise.allSettled([...this._inFlight]), deadline]);
    }

    // Matching runId close markers for every workspace the service knows.
    const workspaceIds = new Set<string>();
    for (const entry of this._tasks.values()) {
      workspaceIds.add(entry.info.workspaceId);
    }
    const marker: AgentTaskCloseMarker = { schemaVersion: 1, runId: this._runId, closedAt: Date.now() };
    for (const workspaceId of workspaceIds) {
      await this._store.writeCloseMarker(workspaceId, marker);
    }
    await this._drainPersist();
  }

  // =========================================================================
  // Preflight
  // =========================================================================

  private _preflight(params: CreateTaskParams, parent: AgentTaskSubmissionContext): PreflightItem[] {
    const definitions = resolveAgentsForScope(parent.loadedAgents?.agents ?? [...BUILTIN_AGENTS], params.agentScope);
    // Workflow extras are the spawner's per-index parallel array; they only
    // take effect when they cover every task (the spawner guarantees it).
    const workflowOwned = params.workflowExtras != null && params.workflowExtras.length === params.tasks.length;
    const items: PreflightItem[] = [];
    for (const [index, task] of params.tasks.entries()) {
      const requested = typeof task.subagent_type === "string" ? task.subagent_type.trim() : undefined;
      const name = requested && requested !== "" ? requested : "general-purpose";
      const definition = definitions.find((candidate) => candidate.name === name);
      const extra = workflowOwned ? params.workflowExtras![index] : undefined;
      const outputSchema = extra?.outputSchema;
      const maxTurnsOverride =
        extra?.maxTurns !== undefined && Number.isSafeInteger(extra.maxTurns) && extra.maxTurns >= 1
          ? extra.maxTurns
          : undefined;

      let failure: { reason: AgentTaskFailureReason; message: string } | undefined;
      let modelSnapshot: Model<Api> | undefined;
      let modelLabel: string | undefined;

      if (!definition) {
        const known = definitions.map((candidate) => candidate.name).filter((name) => name.length > 0);
        const knownList = known.length > 0 ? known.slice(0, 20).join(", ") : "(none)";
        failure = {
          reason: "unknown_agent",
          message: `Unknown agent "${name}". Known user-scope agents: ${knownList}. provider is an agent definition name, not an LLM vendor; omit it to use the run default.`,
        };
      } else if (typeof task.prompt !== "string" || task.prompt.trim() === "") {
        failure = { reason: "prompt_too_large", message: "The delegated prompt must not be empty." };
      } else if (utf8ByteLength(task.prompt) > MAX_DELEGATED_PROMPT_BYTES) {
        failure = {
          reason: "prompt_too_large",
          message: `The delegated prompt exceeds ${MAX_DELEGATED_PROMPT_BYTES} bytes.`,
        };
      } else if (
        // Host defense (design plan §4.6): the worker's subset gate already
        // ran, so only the plain-object shape is re-checked here; a violation
        // rejects the item (child-failed), never a "model retry".
        outputSchema !== undefined &&
        (typeof outputSchema !== "object" || outputSchema === null || Array.isArray(outputSchema))
      ) {
        failure = { reason: "invalid_parameters", message: "The workflow outputSchema must be a plain object." };
      } else {
        // Resolution key (locked): the per-item modelOverride takes precedence
        // over the definition's model (including "inherit" / default-inherit).
        const modelSpec = extra?.modelOverride ?? definition.model;
        const resolved = this._resolveModel(definition, parent.parentRuntime, parent.modelRegistry, modelSpec);
        if (resolved.failure) {
          failure = resolved.failure;
        } else {
          modelSnapshot = resolved.model;
          modelLabel = resolved.label;
        }
      }

      items.push({
        index,
        task,
        name,
        definition,
        description: describeTask(task),
        modelSnapshot,
        modelLabel,
        outputSchema,
        maxTurnsOverride,
        projectAgent: definition?.source === "project",
        failure,
      });

      // Chain keeps input order atomically: the first pre-parsed failure
      // terminates the plan (its failed result is appended, no later item).
      if (params.mode === "chain" && failure) {
        break;
      }
    }
    return items;
  }

  /**
   * Model resolution via the borrowed ReadonlyModelRegistry; nothing is
   * retained. The resolution key is the caller-chosen spec: the workflow
   * modelOverride when present, otherwise the definition's model (including
   * "inherit" / default-inherit).
   */
  private _resolveModel(
    definition: AgentDefinition,
    snapshot: SubagentParentRuntimeSnapshot,
    registry: ReadonlyModelRegistry,
    spec: string | undefined,
  ): {
    model: Model<Api> | undefined;
    label: string | undefined;
    failure: { reason: AgentTaskFailureReason; message: string } | undefined;
  } {
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

    let model: Model<Api> | undefined;
    let label: string | undefined;
    let failure: { reason: AgentTaskFailureReason; message: string } | undefined;

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

  // =========================================================================
  // Project trust (three-way race, first cause wins)
  // =========================================================================

  private async _resolveProjectApproval(
    items: PreflightItem[],
    parent: AgentTaskSubmissionContext,
    signal: AbortSignal | undefined,
  ): Promise<{ kind: "approved" } | { kind: "denied" } | { kind: "cause"; cause: "parent_signal" | "host_disposed" }> {
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

    const projectAgentsDir = parent.loadedAgents?.projectAgentsDir ?? `${parent.project.physicalPath}/.pi/agents`;
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
      const response = await Promise.race([parent.requestUserInput(request, signal), parent.hostDisposed, signalCause]);
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

  // =========================================================================
  // Spec freezing
  // =========================================================================

  private _buildSpecs(
    params: CreateTaskParams,
    parent: AgentTaskSubmissionContext,
    groupId: string,
    items: PreflightItem[],
    now: number,
    approval: { kind: "approved" } | { kind: "denied" } | { kind: "cause"; cause: "parent_signal" | "host_disposed" },
  ): AgentTaskSpec[] {
    const mode = params.mode === "parallel" ? "single" : params.mode;
    if (params.mode === "parallel") {
      return items.map((item) => this._buildSpec(params, parent, groupId, "single", [item], now, approval));
    }
    return [this._buildSpec(params, parent, groupId, mode, items, now, approval)];
  }

  private _buildSpec(
    params: CreateTaskParams,
    parent: AgentTaskSubmissionContext,
    groupId: string,
    mode: "single" | "chain",
    items: PreflightItem[],
    now: number,
    approval: { kind: "approved" } | { kind: "denied" } | { kind: "cause"; cause: "parent_signal" | "host_disposed" },
  ): AgentTaskSpec {
    const itemSpecs: AgentTaskItemSpec[] = [];
    if (approval.kind === "cause") {
      // The race was lost; the items stay "ready" (preflight passed) but the
      // group aborts before any enqueue and synthesizes aborted results.
      for (const item of items) {
        itemSpecs.push(this._toItemSpec(item, undefined));
      }
    } else {
      const chainDenied = approval.kind === "denied" && params.mode === "chain";
      for (const item of items) {
        const denied = approval.kind === "denied" && item.projectAgent && !item.failure;
        if (denied || item.failure) {
          // Chain denial is atomic: every item is rejected so nothing executes.
          const rejection = chainDenied
            ? {
                failureReason: "project_agent_denied" as AgentTaskFailureReason,
                errorMessage: denied
                  ? "Project agent was not approved by the user."
                  : "The chain was not started because a project agent was denied.",
              }
            : denied
              ? { failureReason: "project_agent_denied" as AgentTaskFailureReason, errorMessage: "Project agent was not approved by the user." }
              : { failureReason: item.failure!.reason, errorMessage: item.failure!.message };
          itemSpecs.push(this._toItemSpec(item, rejection));
        } else {
          itemSpecs.push(this._toItemSpec(item, undefined));
        }
      }
    }
    return {
      schemaVersion: AGENT_TASK_SCHEMA_VERSION,
      taskId: randomUUID(),
      groupId,
      groupMode: params.mode,
      mode,
      items: itemSpecs,
      agentScope: params.agentScope,
      thinkingLevel: parent.parentRuntime.thinkingLevel,
      executionMode: parent.parentRuntime.executionMode,
      verificationGate: parent.parentRuntime.verificationGate,
      project: structuredClone(parent.project),
      workspaceId: workspaceIdOf(parent.project.physicalPath),
      agentDir: parent.agentDir,
      parentSessionId: parent.parentSessionId,
      parentToolCallId: parent.parentToolCallId,
      planLink: params.planLink ? structuredClone(params.planLink) : undefined,
      createdAt: now,
    };
  }

  private _toItemSpec(item: PreflightItem, rejection: { failureReason: AgentTaskFailureReason; errorMessage: string } | undefined): AgentTaskItemSpec {
    if (rejection) {
      return {
        resolution: "rejected",
        index: item.index,
        prompt: typeof item.task.prompt === "string" ? item.task.prompt : "",
        description: item.description,
        requestedAgentName: item.name,
        failureReason: rejection.failureReason,
        errorMessage: rejection.errorMessage,
      };
    }
    const definition = item.definition!;
    // The frozen item model IS the resolved modelOverride (resolution already
    // applied in preflight); the optional outputSchema is written only when a
    // workflow schema child requested it, so the baseline shape is unchanged.
    return {
      resolution: "ready",
      index: item.index,
      prompt: item.task.prompt,
      description: item.description,
      agent: this._snapshotAgentDefinition(definition),
      model: { provider: item.modelSnapshot!.provider, modelId: item.modelSnapshot!.id },
      maxTurns: item.maxTurnsOverride ?? definition.maxTurns ?? DEFAULT_MAX_TURNS,
      ...(item.outputSchema !== undefined ? { outputSchema: item.outputSchema } : {}),
    };
  }

  private _snapshotAgentDefinition(definition: AgentDefinition): AgentDefinitionSnapshot {
    return {
      name: definition.name,
      description: definition.description,
      systemPrompt: definition.systemPrompt,
      tools: definition.tools ? [...definition.tools] : undefined,
      disallowedTools: definition.disallowedTools ? [...definition.disallowedTools] : undefined,
      maxTurns: definition.maxTurns,
      color: definition.color,
      source: definition.source,
      filePath: definition.filePath,
      baseDir: definition.baseDir,
    };
  }

  // =========================================================================
  // Task lifecycle
  // =========================================================================

  private _createTaskEntry(spec: AgentTaskSpec, presentation: AgentTaskPresentation): TaskEntry {
    const now = this._now();
    // 1.5 (S1): the workflow-owned flag is known at group creation; mirror it
    // into the initial AgentTaskInfo (later hydrated from the index entry).
    const workflowOwned = this._groups.get(spec.groupId)?.workflowOwned ?? false;
    const info: AgentTaskInfo = {
      schemaVersion: AGENT_TASK_SCHEMA_VERSION,
      taskId: spec.taskId,
      groupId: spec.groupId,
      groupMode: spec.groupMode,
      workspaceId: spec.workspaceId,
      parentSessionId: spec.parentSessionId,
      parentToolCallId: spec.parentToolCallId,
      itemSummaries: spec.items.map((item) => this._itemSummary(item)),
      thinkingLevel: spec.thinkingLevel,
      executionMode: spec.executionMode,
      project: structuredClone(spec.project),
      presentation,
      status: "queued",
      description: spec.items[0]?.description ?? "",
      finalOutput: "",
      outputTruncated: false,
      originalOutputBytes: 0,
      results: [],
      activities: [],
      usage: emptyTaskUsage(),
      toolUseCount: 0,
      createdAt: now,
      updatedAt: now,
      durationMs: 0,
      planLink: spec.planLink ? structuredClone(spec.planLink) : undefined,
      deliveredSessionIds: [],
      planLinkState: spec.planLink ? "pending" : "none",
      generation: 0,
      workflowOwned,
    };
    const entry: TaskEntry = {
      spec,
      info,
      runtime: undefined,
      controller: undefined,
      slotHeld: false,
      cancelRequested: false,
      resumedRun: false,
      stopReason: undefined,
      workflowOwned,
      outputState: { text: "", truncated: false, originalBytes: 0 },
      throttle: { lastEmitAt: 0, pendingActivities: [], pendingOutput: undefined, pendingTranscript: [], timer: undefined },
      persist: {
        initialized: false,
        pendingEvents: [],
        eventSeq: 0,
        pendingCheckpoints: [],
        lastCheckpoint: null,
        lastCheckpointSeq: 0,
        hasUnclosedToolCall: false,
        preShutdownStatus: undefined,
        preShutdownStopReason: undefined,
        flushScheduled: false,
        reservationId: undefined,
        resumeReservationId: undefined,
        storageFailed: false,
        indexDirty: false,
        resumePersistPending: false,
        resumePersistFailure: undefined,
      },
    };
    this._tasks.set(spec.taskId, entry);
    return entry;
  }

  private _itemSummary(item: AgentTaskItemSpec): AgentTaskItemSummary {
    if (item.resolution === "ready") {
      return {
        index: item.index,
        agentName: item.agent.name,
        agentSource: item.agent.source,
        model: { provider: item.model.provider, modelId: item.model.modelId },
        maxTurns: item.maxTurns,
      };
    }
    return {
      index: item.index,
      agentName: item.requestedAgentName ?? "general-purpose",
      agentSource: "unknown",
    };
  }

  /** Slot grant listener: starts the runtime of a newly granted task. */
  private _startTask(taskId: string): void {
    const entry = this._tasks.get(taskId);
    if (entry?.slotHeld) {
      return;
    }
    if (!entry || entry.info.status !== "queued") {
      this._scheduler.release();
      return;
    }
    entry.slotHeld = true;
    const now = this._now();
    const from = entry.info.status;
    entry.info.status = "running";
    entry.info.startedAt = now;
    entry.info.updatedAt = now;
    entry.info.queuePosition = undefined;
    this._logStateEvent(entry, from, "running", "slot grant");
    entry.persist.indexDirty = true;
    this._schedulePersist(taskId);
    const controller = new AbortController();
    entry.controller = controller;
    // 1.4.2 (R3): a resumed task already carries its prepared runtime (the
    // idle session was built by prepareResume before the queued state landed);
    // only fresh tasks create a runtime here.
    entry.runtime = entry.runtime ?? this._createRuntime(entry.spec);
    // 1.5 (P3): a watcher subscribed while the task was queued must see the
    // stream from the first emitted event - initialize the (possibly fresh)
    // runtime's forwarding state from the current watcher count (idempotent
    // for the resume handoff, which already applied it).
    if ((this._watchers.get(taskId) ?? 0) > 0) {
      entry.runtime.setTranscriptForwarding(true);
    }
    const runPromise = entry.runtime.run(controller.signal, (event) => this._onRuntimeEvent(taskId, event));
    this._inFlight.add(runPromise);
    runPromise.then(
      (result) => {
        this._inFlight.delete(runPromise);
        this._finalizeTask(taskId, result);
      },
      (error: unknown) => {
        this._inFlight.delete(runPromise);
        this._finalizeTask(taskId, undefined, error);
      },
    );
    this._emitTaskState(taskId);
  }

  private _createRuntime(spec: AgentTaskSpec, taskSessionDir?: string): AgentTaskRuntime {
    const dir = taskSessionDir ?? this._store.getTaskSessionDir(spec.workspaceId, spec.taskId);
    if (testHooks?.runtimeFactory) {
      return testHooks.runtimeFactory(spec, this._input, dir);
    }
    return new AgentTaskRuntime({ spec, input: this._input, taskSessionDir: dir });
  }

  private _onRuntimeEvent(taskId: string, event: AgentTaskRuntimeEvent): void {
    const entry = this._tasks.get(taskId);
    if (!entry || isTerminalStatus(entry.info.status)) {
      return;
    }
    switch (event.type) {
      case "activity": {
        entry.info.activities.push(event.activity);
        if (entry.info.activities.length > AGENT_TASK_MAX_RECENT_ACTIVITIES) {
          entry.info.activities = entry.info.activities.slice(-AGENT_TASK_MAX_RECENT_ACTIVITIES);
        }
        if (event.activity.status === "running") {
          entry.info.toolUseCount += 1;
        }
        const now = this._now();
        if (entry.info.startedAt !== undefined) {
          entry.info.durationMs = Math.max(0, now - entry.info.startedAt);
        }
        entry.info.updatedAt = now;
        entry.throttle.pendingActivities.push(event.activity);
        this._scheduleThrottleFlush(taskId);
        // 1.4.2: the log is the recovery source; appends are never throttled.
        entry.persist.pendingEvents.push({ type: "activity", activity: event.activity });
        this._schedulePersist(taskId);
        break;
      }
      case "output": {
        entry.info.finalOutput = event.text;
        entry.info.outputTruncated = event.truncated;
        entry.info.originalOutputBytes = event.originalBytes;
        entry.outputState = { text: event.text, truncated: event.truncated, originalBytes: event.originalBytes };
        entry.throttle.pendingOutput = { text: event.text, truncated: event.truncated, originalBytes: event.originalBytes };
        this._scheduleThrottleFlush(taskId);
        entry.persist.pendingEvents.push({ type: "output", text: event.text, truncated: event.truncated });
        this._schedulePersist(taskId);
        break;
      }
      case "checkpoint": {
        // 1.4.2: every finalized-message/tool-result checkpoint is persisted
        // without any time throttling (PRD safety point); the index is only
        // rewritten when the open-call flag actually changed (its leaf seq is
        // covered by the checkpoint batch itself).
        entry.persist.pendingCheckpoints.push(event.checkpoint);
        const unclosed = event.checkpoint.openToolCalls.length > 0;
        if (entry.persist.hasUnclosedToolCall !== unclosed) {
          entry.persist.hasUnclosedToolCall = unclosed;
          entry.persist.indexDirty = true;
        }
        entry.info.hasUnclosedToolCall = unclosed;
        this._schedulePersist(taskId);
        break;
      }
      case "file_change": {
        // main-only: forwarded verbatim to Plan deviation adapters, never
        // throttled and never forwarded across IPC.
        this._emitServiceEvent({
          type: "task_file_change",
          taskId,
          planLink: entry.info.planLink,
          change: event.change,
          aggregate: event.aggregate,
        });
        // 1.5 (P4): persist the single change (never the turn aggregate -
        // TurnDiffSummary.changes accumulates in-turn, per-event aggregates
        // would duplicate O(k^2); the renderer aggregates from the stream).
        entry.persist.pendingEvents.push({ type: "file_change", change: event.change });
        this._schedulePersist(taskId);
        break;
      }
      case "nested_transcript": {
        // 1.5 (P3): live transcript - only watched tasks buffer; the 100ms
        // throttle coalesces the stream. The runtime's nested_transcript.event
        // is the coding-agent mirror union; the single allowed conversion seam
        // (design plan §2.3) lands it on the shared union here - the two
        // unions carry the same members, only the agents' source packages
        // differ.
        if ((this._watchers.get(taskId) ?? 0) <= 0) {
          break;
        }
        const pending = entry.throttle.pendingTranscript;
        const next: { itemIndex: number; event: SharedAgentSessionEvent } = {
          itemIndex: event.itemIndex,
          event: event.event as unknown as SharedAgentSessionEvent,
        };
        const tail = pending[pending.length - 1];
        // Streaming text is a full snapshot: a trailing message_update is
        // replaced in place (intermediate states are lossless). The merge is
        // scoped to the same item so a chain's item boundary cannot swallow an
        // update from the next item.
        if (tail !== undefined && tail.itemIndex === next.itemIndex && tail.event.type === "message_update" && next.event.type === "message_update") {
          tail.event = next.event;
        } else {
          pending.push(next);
          if (pending.length > MAX_PENDING_TRANSCRIPTS) {
            // Capacity overflow drops the OLDEST entry (the renderer's
            // terminal/overflow disk replay is the backstop).
            pending.splice(0, pending.length - MAX_PENDING_TRANSCRIPTS);
          }
        }
        this._scheduleThrottleFlush(taskId);
        break;
      }
      case "item_session": {
        // 1.5 (P3): item->session-file binding is written to the task log
        // immediately (same rule as activity: never throttled, watcher-
        // independent - the mapping is a recovery fact, not a live view).
        entry.persist.pendingEvents.push({ type: "item_session", itemIndex: event.itemIndex, sessionFileName: event.sessionFileName });
        this._schedulePersist(taskId);
        break;
      }
      case "item_result": {
        // 1.4.2 (R3): the folded resume prefix - completed items are persisted
        // as they end so a later interrupted state can rebuild priorResults.
        entry.persist.pendingEvents.push({ type: "item_result", result: event.result });
        this._schedulePersist(taskId);
        break;
      }
      case "assistant_finalized": {
        // 1.4.2 (R3): a new finalized model assistant message after a resume
        // is the resume success criterion.
        if (entry.resumedRun) {
          entry.resumedRun = false;
          this._recordProductEvent("agent_task_resume_succeeded", { status: "succeeded" });
        }
        break;
      }
    }
  }

  /**
   * Normalize a settled run (or an unexpected run rejection) into the task's
   * terminal state, emit the final task_state + product event, free the slot
   * and resolve the group awaiters when the group became terminal.
   */
  private _finalizeTask(taskId: string, result: AgentTaskRuntimeResult | undefined, error?: unknown): void {
    const entry = this._tasks.get(taskId);
    if (!entry || isTerminalStatus(entry.info.status)) {
      return;
    }
    // 1.4.2: a terminal settle arriving after prepareShutdown/dispose froze the
    // task (the bounded abort's late "cancelled") never overwrites the frozen
    // pre-status fact. The slot is still released so scheduler bookkeeping
    // stays consistent; nothing is persisted and no task_state is emitted.
    if (entry.persist.preShutdownStatus !== undefined) {
      this._releaseSlot(entry);
      return;
    }
    const now = this._now();
    if (result) {
      entry.info.status = result.status;
      entry.info.failureReason = result.failureReason;
      entry.info.results = result.results;
      entry.info.activities = result.activities;
      entry.info.usage = result.usage;
      entry.info.toolUseCount = result.results.reduce((sum, item) => sum + item.toolUseCount, 0);
      entry.info.finalOutput = result.finalOutput;
      // Truncation bookkeeping came from the final forced output event; fall
      // back to a fresh computation when the result text differs (defensive).
      if (entry.outputState.text !== result.finalOutput) {
        const originalBytes = utf8ByteLength(result.finalOutput);
        entry.info.outputTruncated = originalBytes > AGENT_TASK_MAX_FINAL_OUTPUT_BYTES;
        entry.info.originalOutputBytes = originalBytes;
      }
      if (result.status === "failed") {
        const firstFailed = result.results.find((item) => item.status === "failed");
        entry.info.errorMessage = firstFailed?.errorMessage;
      }
    } else {
      // Unexpected internal failure: never reject; a bounded structured result.
      const message = error instanceof Error ? error.message : String(error);
      entry.info.status = "failed";
      entry.info.failureReason = "internal_error";
      entry.info.errorMessage = message;
      entry.info.results = entry.spec.items.map((item) =>
        this._makeSynthItemResult(entry.spec, item, "failed", "internal_error", message, now),
      );
    }
    this._applyTerminalBookkeeping(entry, now);
  }

  /** All-rejected spec: stable failed task, never occupies a slot. */
  private _finalizeTaskPreflightFailed(taskId: string): void {
    const entry = this._tasks.get(taskId);
    if (!entry || isTerminalStatus(entry.info.status)) {
      return;
    }
    const now = this._now();
    const firstRejected = entry.spec.items[0];
    if (firstRejected.resolution !== "rejected") {
      return;
    }
    entry.info.status = "failed";
    entry.info.failureReason = firstRejected.failureReason;
    entry.info.errorMessage = firstRejected.errorMessage;
    entry.info.results = [this._makeRejectedResult(entry.spec, firstRejected, now)];
    this._applyTerminalBookkeeping(entry, now);
  }

  /** Lost approval race: whole group cancelled before any enqueue. */
  private _finalizeTaskRaceAborted(taskId: string, cause: "parent_signal" | "host_disposed"): void {
    const entry = this._tasks.get(taskId);
    if (!entry || isTerminalStatus(entry.info.status)) {
      return;
    }
    const now = this._now();
    const reason: SubagentFailureReason = cause === "host_disposed" ? "host_disposed" : "aborted";
    const message = cause === "host_disposed" ? "The agent task service was disposed." : "The subagent run was interrupted.";
    // 1.4.2: a host-disposed cancellation happened during app shutdown; the
    // stopReason lets restore hydrate it as interrupted (only user_cancel
    // keeps cancelled).
    if (cause === "host_disposed" && entry.stopReason === undefined) {
      entry.stopReason = "app_shutdown";
    }
    if (cause === "parent_signal" && entry.stopReason === undefined) {
      entry.stopReason = "user_cancel";
    }
    entry.info.status = "cancelled";
    entry.info.results = entry.spec.items.map((item) => this._makeSynthItemResult(entry.spec, item, "aborted", reason, message, now));
    this._applyTerminalBookkeeping(entry, now);
  }

  /** Queued abort: removed from the queue immediately, never occupies a slot. */
  private _finalizeTaskCancelled(taskId: string): void {
    const entry = this._tasks.get(taskId);
    if (!entry || isTerminalStatus(entry.info.status)) {
      return;
    }
    const now = this._now();
    entry.info.status = "cancelled";
    entry.info.results = entry.spec.items.map((item) =>
      this._makeSynthItemResult(entry.spec, item, "aborted", "aborted", "The agent task was cancelled while queued.", now),
    );
    this._applyTerminalBookkeeping(entry, now);
    // 1.4.2 (R3): a prepared (resumed) queued runtime never started; it must be
    // disposed and its reservation released instead of leaking the open
    // session/backend (fresh queued tasks have no runtime here).
    if (entry.runtime !== undefined) {
      void entry.runtime.dispose().catch(() => {});
      entry.runtime = undefined;
    }
    this._releaseResumeReservation(entry);
  }

  private _applyTerminalBookkeeping(entry: TaskEntry, now: number): void {
    const from = entry.info.status;
    entry.info.endedAt = now;
    entry.info.durationMs = Math.max(0, now - (entry.info.startedAt ?? now));
    entry.info.autoBackground = undefined;
    entry.info.queuePosition = undefined;
    entry.info.updatedAt = now;
    // 1.4.2: terminal facts (status + stopReason diagnostic) persist with the
    // state event; the log then carries a complete recoverable history.
    entry.info.stopReason = entry.stopReason;
    this._logStateEvent(entry, from, entry.info.status, entry.stopReason);
    entry.persist.indexDirty = true;
    this._schedulePersist(entry.info.taskId);
    // 1.5 (P3): terminal convergence - the remaining transcript events flush
    // BEFORE the terminal task_state (once the renderer observes the terminal
    // state it replays from disk, so dropping the last live events is lossless
    // by design); watchers are cleared and the live runtime's forwarding is
    // switched off (an already-cleared runtime - entry.runtime undefined -
    // needs nothing).
    this._flushThrottle(entry.info.taskId);
    if ((this._watchers.get(entry.info.taskId) ?? 0) > 0) {
      entry.runtime?.setTranscriptForwarding(false);
    }
    this._watchers.delete(entry.info.taskId);
    this._emitTaskState(entry.info.taskId);
    this._recordTaskTerminalEvent(entry.info);
    this._releaseSlot(entry);
    this._releaseResumeReservation(entry);
    this._checkGroupTerminal(entry.info.groupId);
    this._maybeAutoDeliver(entry);
    // 1.5 (P1): every terminal transition is a retention point; the pass is
    // serialized behind the flush queue and its own exemptions (pending Plan,
    // undelivered-within-grace) protect freshly finished tasks.
    this._scheduleRetention(entry.info.workspaceId);
  }

  /** Frees a held slot exactly once; terminal/aborted runs always release it. */
  private _releaseSlot(entry: TaskEntry): void {
    if (entry.slotHeld) {
      entry.slotHeld = false;
      this._scheduler.release();
      this._refreshQueuePositions();
    }
  }

  /** 1.4.2: storage-limit failure keeps the readable tail and never silently continues. */
  private _finalizeTaskStorageLimit(taskId: string): void {
    const entry = this._tasks.get(taskId);
    if (!entry || isTerminalStatus(entry.info.status)) {
      return;
    }
    const now = this._now();
    const message = "The task exceeded its storage budget; the readable tail was preserved.";
    entry.info.status = "failed";
    entry.info.failureReason = "storage_limit";
    entry.info.errorMessage = message;
    entry.info.results = entry.spec.items.map((item) =>
      this._makeSynthItemResult(entry.spec, item, "failed", "storage_limit" as SubagentFailureReason, message, now),
    );
    entry.persist.storageFailed = true;
    this._applyTerminalBookkeeping(entry, now);
  }

  /** 1.4.2: unexpected persistence failure at creation (never enqueued). */
  private _finalizeTaskInternalError(taskId: string): void {
    const entry = this._tasks.get(taskId);
    if (!entry || isTerminalStatus(entry.info.status)) {
      return;
    }
    const now = this._now();
    const message = "The task could not be initialized for persistence.";
    entry.info.status = "failed";
    entry.info.failureReason = "internal_error";
    entry.info.errorMessage = message;
    entry.info.results = entry.spec.items.map((item) =>
      this._makeSynthItemResult(entry.spec, item, "failed", "internal_error", message, now),
    );
    this._applyTerminalBookkeeping(entry, now);
  }

  // =========================================================================
  // 1.4.2 (R2) persistence
  // =========================================================================

  /**
   * Reserve the creation budget and durably initialize the task (metadata +
   * initial queued state event + initial checkpoint + index) before it can be
   * enqueued. Returns "ok", "storage_limit" (budget exhausted: nothing was
   * written, caller finalizes failed(storage_limit)) or "internal_error".
   */
  private async _initializeTaskPersistence(taskId: string): Promise<"ok" | "storage_limit" | "internal_error"> {
    const entry = this._tasks.get(taskId);
    if (!entry) {
      return "internal_error";
    }
    const reserveBytes = testHooks?.reserveBytesOverride ?? AGENT_TASK_CREATION_RESERVE_BYTES;
    try {
      const reservation = await this._store.reserveBudget(entry.info.workspaceId, entry.info.taskId, reserveBytes);
      entry.persist.reservationId = reservation.reservationId;
    } catch (err) {
      if (err instanceof TaskStorageLimitError) {
        return "storage_limit";
      }
      console.error("[AgentTaskService] budget reservation failed:", err);
      return "internal_error";
    }
    const initialCheckpoint: TaskCheckpoint = {
      taskId: entry.info.taskId,
      generation: entry.info.generation,
      seq: 0, // stamped with the log seq at write time
      activeItemIndex: 0,
      sessionFileName: null,
      sessionLeafId: null,
      openToolCalls: [],
      workspaceFingerprint: { isGit: false, observedFileHashes: {} },
      ts: this._now(),
    };
    entry.persist.pendingCheckpoints.push(initialCheckpoint);
    this._logStateEvent(entry, "queued", "queued", "created");
    entry.persist.indexDirty = true;
    this._schedulePersist(taskId);
    await this._drainPersist();
    return entry.persist.storageFailed ? "storage_limit" : "ok";
  }

  /** Queue a log state event with the current (already-transitioned) info snapshot. */
  private _logStateEvent(entry: TaskEntry, from: AgentTaskStatus, to: AgentTaskStatus, reason?: string): void {
    entry.persist.pendingEvents.push({
      type: "state",
      from,
      to,
      info: structuredClone(entry.info),
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /**
   * Coalesced per-task persistence scheduling: same-tick events/checkpoints
   * merge into one flush, and every flush chains onto the serialized
   * _flushTail so prepareShutdown/dispose can drain in order.
   */
  private _schedulePersist(taskId: string): void {
    const entry = this._tasks.get(taskId);
    if (!entry || entry.persist.flushScheduled) {
      return;
    }
    entry.persist.flushScheduled = true;
    this._flushTail = this._flushTail.then(
      () => this._runPersistFlush(taskId),
      () => this._runPersistFlush(taskId),
    );
  }

  private async _runPersistFlush(taskId: string): Promise<void> {
    const entry = this._tasks.get(taskId);
    if (!entry) {
      return;
    }
    entry.persist.flushScheduled = false;
    try {
      await this._flushPersist(taskId);
    } catch (err) {
      console.error("[AgentTaskService] persistence flush failed:", err);
    }
  }

  private async _drainPersist(): Promise<void> {
    // Keep draining until the tail is quiescent: a flush that fails (storage
    // limit) schedules its own follow-up index write from inside its body, so
    // the tail can grow while a plain single await is in flight.
    for (;;) {
      const tail = this._flushTail;
      await tail;
      if (this._flushTail === tail) {
        return;
      }
    }
  }

  /**
   * One flush batch: append pending log events (store-allocated seqs), write
   * every pending checkpoint (each seq = current log position) and rewrite
   * the workspace index when an index field changed. A budget exhaustion anywhere
   * flushes the readable tail and fails the task with storage_limit instead of
   * silently continuing; the index write (not budget-checked) always records
   * the failure.
   */
  private async _flushPersist(taskId: string): Promise<void> {
    const entry = this._tasks.get(taskId);
    if (!entry) {
      return;
    }
    const persist = entry.persist;
    if (!persist.initialized) {
      const metadata: TaskMetadata = {
        schemaVersion: AGENT_TASK_SCHEMA_VERSION,
        spec: entry.spec,
        initialInfo: structuredClone(entry.info),
      };
      try {
        await this._store.writeMetadata(entry.info.workspaceId, entry.info.taskId, metadata);
        persist.initialized = true;
      } catch (err) {
        if (err instanceof TaskStorageLimitError) {
          this._failOnStorageLimit(entry, err.message);
          return;
        }
        console.error("[AgentTaskService] metadata write failed:", err);
        this._failOnPersistError(entry, err);
        return;
      }
    }
    const pendingEvents = persist.pendingEvents;
    persist.pendingEvents = [];
    for (const payload of pendingEvents) {
      try {
        const written = await this._store.appendEvent(entry.info.workspaceId, entry.info.taskId, payload);
        persist.eventSeq = written.seq;
      } catch (err) {
        if (err instanceof TaskStorageLimitError) {
          this._failOnStorageLimit(entry, err.message);
          return;
        }
        console.error("[AgentTaskService] event append failed:", err);
        this._failOnPersistError(entry, err);
        return;
      }
    }
    // Every queued checkpoint is written once (design plan §4.7: no time
    // throttling may merge away a finalized-message/ToolResult safety point).
    // The queue is drained up front so a checkpoint arriving during one of
    // the awaits lands in the fresh array and triggers its own next flush.
    const pendingCheckpoints = persist.pendingCheckpoints;
    if (pendingCheckpoints.length > 0) {
      persist.pendingCheckpoints = [];
      for (const cp of pendingCheckpoints) {
        const stamped: TaskCheckpoint = { ...cp, seq: persist.eventSeq, ts: Date.now() };
        try {
          await this._store.writeCheckpoint(entry.info.workspaceId, entry.info.taskId, stamped);
          persist.lastCheckpoint = stamped;
          persist.lastCheckpointSeq = stamped.seq;
          entry.info.lastCheckpointSeq = stamped.seq;
          // The leaf seq is an index field: the batch always carries the index.
          persist.indexDirty = true;
        } catch (err) {
          if (err instanceof TaskStorageLimitError) {
            this._failOnStorageLimit(entry, err.message);
            return;
          }
          console.error("[AgentTaskService] checkpoint write failed:", err);
          this._failOnPersistError(entry, err);
          return;
        }
      }
    }
    if (persist.indexDirty) {
      persist.indexDirty = false;
      try {
        await this._writeIndexForWorkspace(entry.info.workspaceId);
      } catch (err) {
        console.error("[AgentTaskService] index write failed:", err);
      }
    }
    // The storage-status refresh scans disk; it never blocks the flush itself
    // (a slow dirSize must not delay later checkpoints/events).
    this._scheduleStorageRefresh(entry.info.workspaceId);
  }

  /** 1.4.2 (R3): release the resume() reservation exactly once. */
  private _releaseResumeReservation(entry: TaskEntry): void {
    if (entry.persist.resumeReservationId !== undefined) {
      this._store.releaseBudget(entry.persist.resumeReservationId);
      entry.persist.resumeReservationId = undefined;
    }
  }

  /**
   * Track a fire-and-forget promise in _inFlight so dispose()'s
   * Promise.allSettled aggregation and prepareShutdown's bounded wait cover it
   * (e.g. the dispose of a prepared-but-never-started resumed runtime); the
   * entry removes itself on settlement so the set stays bounded.
   */
  private _trackInFlight(promise: Promise<unknown>): void {
    this._inFlight.add(promise);
    promise.then(
      () => this._inFlight.delete(promise),
      () => this._inFlight.delete(promise),
    );
  }

  /** Serialized, fire-and-forget storage-status refresh (level changes emit events). */
  private _scheduleStorageRefresh(workspaceId: string): void {
    this._flushTail = this._flushTail.then(
      () => this._refreshStorageStatus(workspaceId),
      () => this._refreshStorageStatus(workspaceId),
    );
  }

  /** Storage-limit failure: keep the readable tail, never silently continue. */
  private _failOnStorageLimit(entry: TaskEntry, message: string): void {
    const persist = entry.persist;
    persist.pendingEvents = [];
    persist.pendingCheckpoints = [];
    // 1.4.2 (R3): inside resume()'s generation+1 critical section a storage
    // failure must not finalize the task - the reservation is released by the
    // resume() caller and the in-memory state compensates back to interrupted
    // (design plan §4.5 / §5.5-4).
    if (persist.resumePersistPending && entry.info.status === "queued") {
      persist.resumePersistFailure = "storage_limit";
      this._compensateResumePersistFailure(entry);
      this._scheduleIndexWrite(entry.info.workspaceId);
      return;
    }
    if (persist.preShutdownStatus !== undefined) {
      this._scheduleIndexWrite(entry.info.workspaceId);
      return;
    }
    if (!isTerminalStatus(entry.info.status) && !persist.storageFailed) {
      persist.storageFailed = true;
      if (entry.info.status === "queued") {
        this._scheduler.dequeue(entry.info.taskId);
      }
      const now = this._now();
      const failureMessage = message !== "" ? message : "The task exceeded its storage budget.";
      entry.info.status = "failed";
      entry.info.failureReason = "storage_limit";
      entry.info.errorMessage = failureMessage;
      entry.info.endedAt = now;
      entry.info.durationMs = Math.max(0, now - (entry.info.startedAt ?? now));
      entry.info.autoBackground = undefined;
      entry.info.queuePosition = undefined;
      entry.info.updatedAt = now;
      entry.info.results = entry.spec.items.map((item) =>
        this._makeSynthItemResult(entry.spec, item, "failed", "storage_limit" as SubagentFailureReason, failureMessage, now),
      );
      this._emitTaskState(entry.info.taskId);
      this._recordTaskTerminalEvent(entry.info);
      this._releaseSlot(entry);
      this._releaseResumeReservation(entry);
      entry.controller?.abort();
      entry.runtime?.abort();
      this._checkGroupTerminal(entry.info.groupId);
    }
    // The index write is not budget-checked; always record the current state
    // through the serialized tail (never fire-and-forget past concurrent
    // writes - Windows rename needs a quiescent target).
    this._scheduleIndexWrite(entry.info.workspaceId);
  }

  /** Serialized index-only write (used by the storage-limit failure path). */
  private _scheduleIndexWrite(workspaceId: string): void {
    this._flushTail = this._flushTail.then(
      () => this._writeIndexForWorkspace(workspaceId).catch((err: unknown) => {
        console.error("[AgentTaskService] storage-limit index write failed:", err);
      }),
      () => this._writeIndexForWorkspace(workspaceId).catch((err: unknown) => {
        console.error("[AgentTaskService] storage-limit index write failed:", err);
      }),
    );
  }

  /** Unexpected persistence failure: fail the task with internal_error. */
  private _failOnPersistError(entry: TaskEntry, error: unknown): void {
    const persist = entry.persist;
    persist.pendingEvents = [];
    persist.pendingCheckpoints = [];
    // 1.4.2 (R3): inside resume()'s generation+1 critical section a write
    // failure must not finalize the task; the in-memory state compensates
    // back to interrupted (design plan §4.5 / §5.5-4). A mid-log-corrupt
    // events.jsonl additionally isolates the record read-only via a recovery
    // issue.
    if (persist.resumePersistPending && entry.info.status === "queued") {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("mid_log_corrupt")) {
        this._emitRecoveryIssue({
          taskId: entry.info.taskId,
          workspaceId: entry.info.workspaceId,
          generation: entry.info.generation,
          code: "mid_log_corrupt",
          message: message !== "" ? message : "the task events log is mid-log corrupt; the task is read-only",
          recoverable: false,
          readOnly: true,
          updatedAt: Date.now(),
        });
      }
      persist.resumePersistFailure = "internal_error";
      this._compensateResumePersistFailure(entry);
      this._scheduleIndexWrite(entry.info.workspaceId);
      return;
    }
    if (persist.preShutdownStatus !== undefined) {
      return;
    }
    if (!isTerminalStatus(entry.info.status)) {
      if (entry.info.status === "queued") {
        this._scheduler.dequeue(entry.info.taskId);
      }
      const now = this._now();
      const message = error instanceof Error && error.message !== "" ? error.message : "Task persistence failed.";
      entry.info.status = "failed";
      entry.info.failureReason = "internal_error";
      entry.info.errorMessage = message;
      entry.info.endedAt = now;
      entry.info.durationMs = Math.max(0, now - (entry.info.startedAt ?? now));
      entry.info.autoBackground = undefined;
      entry.info.queuePosition = undefined;
      entry.info.updatedAt = now;
      this._emitTaskState(entry.info.taskId);
      this._recordTaskTerminalEvent(entry.info);
      this._releaseSlot(entry);
      this._releaseResumeReservation(entry);
      entry.controller?.abort();
      entry.runtime?.abort();
      this._checkGroupTerminal(entry.info.groupId);
    }
  }

  /**
   * 1.4.2 (R3): compensate a failed resume critical-section write back to
   * interrupted - no terminal failed event, no failure reason, no synthesized
   * results (design plan §4.5 / §5.5-4). The generation stays at the prepared
   * value (the prepare succeeded; the disk log may already carry the queued
   * state event, and the one-generation-lag rule tolerates a lagging
   * checkpoint). The prepared runtime is disposed by the resume() caller.
   */
  private _compensateResumePersistFailure(entry: TaskEntry): void {
    entry.info.status = "interrupted";
    entry.info.updatedAt = this._now();
    entry.info.autoBackground = undefined;
    entry.info.queuePosition = undefined;
    entry.info.stopReason = entry.info.stopReason ?? "app_shutdown";
    this._emitTaskState(entry.info.taskId);
  }

  /** Assemble and atomically write the full workspace index (unchecked by budget). */
  private async _writeIndexForWorkspace(workspaceId: string): Promise<void> {
    const generation = (this._indexGenerations.get(workspaceId) ?? 0) + 1;
    this._indexGenerations.set(workspaceId, generation);
    const tasks = [...this._tasks.values()]
      .filter((entry) => entry.info.workspaceId === workspaceId)
      .map((entry) => this._indexEntryFor(entry));
    const index: TaskIndex = {
      schemaVersion: AGENT_TASK_INDEX_SCHEMA_VERSION,
      workspaceId,
      generation,
      lastWriterRunId: this._runId,
      tasks,
    };
    await this._store.writeIndex(workspaceId, index);
  }

  private _indexEntryFor(entry: TaskEntry): TaskIndexEntry {
    return {
      taskId: entry.info.taskId,
      workspaceId: entry.info.workspaceId,
      parentSessionId: entry.info.parentSessionId,
      parentToolCallId: entry.info.parentToolCallId,
      groupId: entry.info.groupId,
      planLink: entry.info.planLink ? { ...entry.info.planLink } : undefined,
      status: entry.info.status,
      lastCheckpointSeq: entry.persist.lastCheckpointSeq,
      hasUnclosedToolCall: entry.persist.hasUnclosedToolCall,
      stopReason: entry.persist.preShutdownStopReason ?? entry.info.stopReason,
      preShutdownStatus: entry.persist.preShutdownStatus,
      updatedAt: entry.info.updatedAt,
      schemaVersion: AGENT_TASK_SCHEMA_VERSION,
      lastWriterRunId: this._runId,
      // 1.5 (P1): persisted so hydration rebuilds the group flag (retention
      // exemption and the background/delivery guards survive restarts).
      workflowOwned: entry.workflowOwned,
    };
  }

  /** Emit a storage_status event only when the workspace usage level changed. */
  private async _refreshStorageStatus(workspaceId: string): Promise<void> {
    const usage = await this._store.getWorkspaceUsage(workspaceId);
    const level = storageUsageLevel(usage);
    const status: AgentTaskStorageStatus = {
      workspaceId,
      usedBytes: usage.usedBytes,
      reservedBytes: usage.reservedBytes,
      limitBytes: usage.limitBytes,
      level,
    };
    const prev = this._storageStatuses.get(workspaceId);
    this._storageStatuses.set(workspaceId, status);
    if (!prev || prev.level !== level) {
      this._emitServiceEvent({ type: "storage_status", status });
      // 1.5 (P1): reaching "full" activates the emergency retention window.
      // Only the ok/warning -> full transition triggers (a pass that lands
      // still-full cannot retrigger itself).
      if (level === "full" && prev?.level !== "full") {
        this._scheduleRetention(workspaceId);
      }
    }
  }

  // =========================================================================
  // 1.4.2 (R2) restore
  // =========================================================================

  /**
   * Load every workspace and hydrate every task (design plan §5.5): matching
   * runId markers diagnose a clean shutdown and are consumed immediately, a
   * stale marker is removed, no marker means a crash. Every pre-exit
   * non-terminal task becomes interrupted (presentation=background, the
   * original parent tool promise no longer exists); only explicit user_cancel
   * keeps cancelled. Corrupted records surface as recovery issues and never
   * forge an AgentTaskInfo.
   */
  async restoreAll(): Promise<AgentTaskRestoreReport> {
    const report: AgentTaskRestoreReport = { restored: 0, interrupted: 0, corrupted: 0, autoResumed: 0, autoFailed: 0, diagnostics: [] };
    const workspaces = await this._store.listWorkspaces();
    for (const workspaceId of workspaces) {
      const index = await this._store.readIndex(workspaceId);
      if (!index) {
        // A fresh workspace has no index (all tasks cleared); an unreadable
        // pair cannot enumerate its tasks without forging ids.
        report.diagnostics.push(`workspace ${workspaceId}: no readable index`);
        await this._refreshStorageStatus(workspaceId);
        continue;
      }
      // Seed the per-workspace generation counter from the disk index so the
      // first post-restart write keeps incrementing instead of restarting at 1
      // (readIndex already applied the index.prev fallback, so the seeded
      // value is the last known-valid generation).
      this._indexGenerations.set(workspaceId, index.generation);
      const diagnosis = await this._store.consumeCloseMarker(workspaceId, index.lastWriterRunId);
      report.diagnostics.push(`workspace ${workspaceId}: ${diagnosis.kind} shutdown`);
      // 1.4.2 (R3): hydrate into group buckets so every group's GroupEntry can
      // be rebuilt below (design plan §5.5-5 keeps the original waitingTaskGroupId
      // for two-phase Plan consumption after restart).
      const hydratedByGroup = new Map<string, TaskEntry[]>();
      for (const indexEntry of index.tasks) {
        const hydrated = await this._hydrateTask(workspaceId, indexEntry);
        if (hydrated === null) {
          report.corrupted++;
          continue;
        }
        report.restored++;
        if (hydrated.interruptedNow) {
          report.interrupted++;
        }
        const groupTasks = hydratedByGroup.get(hydrated.entry.info.groupId);
        if (groupTasks === undefined) {
          hydratedByGroup.set(hydrated.entry.info.groupId, [hydrated.entry]);
        } else {
          groupTasks.push(hydrated.entry);
        }
      }
      for (const [groupId, entries] of hydratedByGroup) {
        this._rebuildGroupEntry(groupId, entries);
      }
      await this._refreshStorageStatus(workspaceId);
    }
    // 1.5 (P1): no task may linger in interrupted waiting for a user decision
    // - the auto-recovery pass resumes what it safely can and converges the
    // rest to failed(resume_blocked). Retention then trims the terminal
    // history per the keep policy (both strictly after hydration settled).
    if (!testHooks?.disableAutoRecovery) {
      await this._autoRecoverInterruptedTasks(report);
    }
    const workspaceIds = [...this._storageStatuses.keys()];
    for (const workspaceId of workspaceIds) {
      this._scheduleRetention(workspaceId);
    }
    return report;
  }

  /**
   * 1.5 (P1) design plan §6.2: after hydration, every interrupted task gets an
   * automatic decision through the SAME resume machinery a user decision used
   * to trigger - fixed decision {continue, confirmWorkspaceChanges:false}
   * (never auto-confirming workspace changes). A failed resume (workspace
   * changed, corrupt transcript, model unavailable, storage) converges to
   * failed(resume_blocked) with the concrete reason, auto-delivered like any
   * terminal background task; recovery issues (e.g. mid_log_corrupt) stay
   * visible alongside. Sequential on purpose: each resume reserves budget and
   * enqueues, so a burst must not interleave.
   */
  private async _autoRecoverInterruptedTasks(report: AgentTaskRestoreReport): Promise<void> {
    const interrupted = [...this._tasks.values()].filter((entry) => entry.info.status === "interrupted");
    for (const entry of interrupted) {
      const taskId = entry.info.taskId;
      const generation = entry.info.generation;
      const result = await this.resume(taskId, generation, { action: "continue", confirmWorkspaceChanges: false });
      if (result.ok) {
        report.autoResumed++;
        continue;
      }
      const message = `Automatic resume after restart failed (${result.reason ?? "unknown"}). The task was converged to failed; see the recovery issue or diagnostics for details.`;
      const failed = await this.markFailed(taskId, generation, "resume_blocked", message);
      if (failed.ok) {
        report.autoFailed++;
      }
    }
  }

  /**
   * Rebuild one task's in-memory entry from metadata + events.jsonl +
   * checkpoint + index entry. Returns null (with a recovery issue emitted)
   * when the record cannot be restored reliably.
   */
  private async _hydrateTask(
    workspaceId: string,
    indexEntry: TaskIndexEntry,
  ): Promise<{ entry: TaskEntry; interruptedNow: boolean } | null> {
    const read = await this._store.readTask(workspaceId, indexEntry.taskId);
    const generation = read.checkpoint?.generation ?? 0;

    if (!read.metadata) {
      const diagnostic = read.diagnostics.find((d) => d.code === "migration_failed" || d.code === "unknown_schema");
      this._emitRecoveryIssue({
        taskId: indexEntry.taskId,
        workspaceId,
        generation,
        code: diagnostic?.code ?? "migration_failed",
        message: diagnostic?.message ?? "task metadata is unreadable; the task is read-only",
        recoverable: false,
        readOnly: true,
        updatedAt: Date.now(),
      });
      return null;
    }
    const midCorrupt = read.diagnostics.find((d) => d.code === "mid_log_corrupt");
    if (midCorrupt) {
      // A bad line in the middle of the log means the record cannot be
      // replayed reliably; it is read-only until cleared (mid-log isolation).
      this._emitRecoveryIssue({
        taskId: indexEntry.taskId,
        workspaceId,
        generation,
        code: "mid_log_corrupt",
        message: midCorrupt.message,
        recoverable: false,
        readOnly: true,
        updatedAt: Date.now(),
      });
      return null;
    }
    for (const diagnostic of read.diagnostics) {
      // tail_corrupt is repairable at the next append and never blocks display.
      if (diagnostic.code === "tail_corrupt") {
        this._emitRecoveryIssue({
          taskId: indexEntry.taskId,
          workspaceId,
          generation,
          code: "tail_corrupt",
          message: diagnostic.message,
          recoverable: true,
          readOnly: false,
          updatedAt: Date.now(),
        });
      } else {
        this._emitRecoveryIssue({
          taskId: indexEntry.taskId,
          workspaceId,
          generation,
          code: diagnostic.code,
          message: diagnostic.message,
          recoverable: diagnostic.recoverable,
          readOnly: true,
          updatedAt: Date.now(),
        });
      }
    }

    const info = this._rebuildInfoFromLog(read.metadata.spec, read.metadata.initialInfo, read.events, indexEntry);
    // 1.5 (S1): the workflow-owned flag is read back from the persisted index
    // entry (the log replay may predate the field; the index is authoritative).
    info.workflowOwned = indexEntry.workflowOwned === true;
    // 1.4.2 (R3): the checkpoint generation must equal the folded task
    // generation (from the state events) or lag it by exactly one - the crash
    // window between a resume's queued state event and its generation+1
    // checkpoint write. Anything else (ahead, or more than one behind) is
    // corruption: no guessing, the task surfaces read-only.
    if (read.checkpoint !== null && read.checkpoint.generation !== info.generation) {
      if (read.checkpoint.generation !== info.generation - 1) {
        this._emitRecoveryIssue({
          taskId: indexEntry.taskId,
          workspaceId,
          generation: info.generation,
          code: "index_corrupt",
          message: `checkpoint generation ${read.checkpoint.generation} is not the folded task generation ${info.generation} (or one behind); refusing to guess`,
          recoverable: false,
          readOnly: true,
          updatedAt: Date.now(),
        });
        return null;
      }
      // One generation behind: hydrate at the folded generation (the state
      // event is authoritative); the checkpoint stays the pre-resume one and
      // the next prepare normalizes it.
    }
    let interruptedNow = false;
    if (info.status !== "completed" && info.status !== "failed") {
      // queued/running/waiting_input, and cancelled without an explicit
      // user_cancel stopReason (shutdown-cancelled): hydrated as interrupted.
      if (!(info.status === "cancelled" && info.stopReason === "user_cancel")) {
        info.status = "interrupted";
        info.presentation = "background";
        info.autoBackground = undefined;
        info.queuePosition = undefined;
        info.stopReason = info.stopReason ?? "app_shutdown";
        interruptedNow = true;
      }
    }
    const lastSeq = read.events.length > 0 ? read.events[read.events.length - 1].seq : 0;
    const entry: TaskEntry = {
      spec: structuredClone(read.metadata.spec),
      info,
      runtime: undefined,
      controller: undefined,
      slotHeld: false,
      cancelRequested: false,
      resumedRun: false,
      stopReason: info.stopReason,
      workflowOwned: indexEntry.workflowOwned === true,
      outputState: { text: info.finalOutput, truncated: info.outputTruncated, originalBytes: info.originalOutputBytes },
      throttle: { lastEmitAt: 0, pendingActivities: [], pendingOutput: undefined, pendingTranscript: [], timer: undefined },
      persist: {
        initialized: true,
        pendingEvents: [],
        eventSeq: lastSeq,
        pendingCheckpoints: [],
        lastCheckpoint: read.checkpoint,
        lastCheckpointSeq: indexEntry.lastCheckpointSeq,
        hasUnclosedToolCall: indexEntry.hasUnclosedToolCall,
        preShutdownStatus: undefined,
        preShutdownStopReason: undefined,
        flushScheduled: false,
        reservationId: undefined,
        resumeReservationId: undefined,
        storageFailed: false,
        indexDirty: false,
        resumePersistPending: false,
        resumePersistFailure: undefined,
      },
    };
    this._tasks.set(entry.info.taskId, entry);
    this._emitTaskState(entry.info.taskId);
    this._recordProductEvent("agent_task_restored", { status: "restored", counts: { tasks: 1 } });
    if (interruptedNow) {
      this._recordProductEvent("agent_task_interrupted", { status: "interrupted", counts: { tasks: 1 } });
    }
    return { entry, interruptedNow };
  }

  /**
   * 1.4.2 (R3): rebuild one group's GroupEntry from its hydrated tasks so the
   * Plan adapter's two-phase consumption (getPlanTaskGroupResult / confirm /
   * release, design plan §5.5-5) works after a restart. All children of one
   * group share the same frozen spec facts (groupMode/agentScope/parentSession/
   * planLink); restored tasks hydrate as background and their group counts as
   * detached (the original parent tool await no longer exists). The terminal
   * snapshot is formed immediately when every child is already terminal.
   */
  private _rebuildGroupEntry(groupId: string, entries: TaskEntry[]): void {
    const first = entries[0];
    const spec = first.spec;
    const group: GroupEntry = {
      groupId,
      mode: spec.groupMode,
      agentScope: spec.agentScope,
      presentation: "background",
      parentSessionId: spec.parentSessionId,
      planLink: spec.planLink ? { ...spec.planLink } : undefined,
      taskIds: entries.map((entry) => entry.info.taskId),
      createdAt: Math.min(...entries.map((entry) => entry.info.createdAt)),
      detached: true,
      // 1.5 (P1): the workflow-owned flag now survives restarts through the
      // persisted index entry, so workflow groups keep their retention
      // exemption and delivery-guard semantics after hydration.
      workflowOwned: entries.some((entry) => entry.workflowOwned),
      autoBackgroundTimer: undefined,
      awaiters: [],
      terminalSnapshot: undefined,
    };
    this._groups.set(groupId, group);
    this._checkGroupTerminal(groupId);
  }

  /**
   * Rebuild the AgentTaskInfo from the log: the LAST state event carries a
   * full info snapshot (post-transition); events after it are replayed onto
   * that base. Status reconciliation is terminal-first: a terminal state in
   * the log is authoritative even when the index is stale (the crash window
   * between event append and index rewrite), while the index entry stays
   * authoritative only when IT is terminal and the log is not (the storage
   * budget can drop a terminal event; the index write is never budget-checked).
   */
  private _rebuildInfoFromLog(
    spec: AgentTaskSpec,
    initialInfo: AgentTaskInfo,
    events: TaskLogEventPayload[],
    indexEntry: TaskIndexEntry,
  ): AgentTaskInfo {
    let base: AgentTaskInfo;
    const stateIndexes: number[] = [];
    for (let i = 0; i < events.length; i++) {
      if (events[i].type === "state") {
        stateIndexes.push(i);
      }
    }
    const lastStateIndex = stateIndexes.length > 0 ? stateIndexes[stateIndexes.length - 1] : -1;
    if (lastStateIndex >= 0) {
      const lastState = events[lastStateIndex] as Extract<TaskLogEventPayload, { type: "state" }>;
      base = structuredClone(lastState.info);
      for (const event of events.slice(lastStateIndex + 1)) {
        switch (event.type) {
          case "activity":
            if (base.activities.length < AGENT_TASK_MAX_RECENT_ACTIVITIES) {
              base.activities.push(event.activity);
            }
            break;
          case "output":
            base.finalOutput = event.text;
            base.outputTruncated = event.truncated;
            break;
          case "item_result":
            base.results.push(event.result);
            break;
          case "usage":
            base.usage = event.usage;
            break;
          case "presentation":
            base.presentation = event.presentation;
            break;
          case "delivery":
            if (!base.deliveredSessionIds.includes(event.targetSessionId)) {
              base.deliveredSessionIds.push(event.targetSessionId);
            }
            break;
          case "plan_consumed":
            base.planLinkState = "consumed";
            break;
          case "plan_released":
            base.planLinkState = "released";
            break;
          default:
            break;
        }
      }
    } else {
      base = structuredClone(initialInfo);
    }
    void spec;
    const logTerminal = isTerminalStatus(base.status);
    const indexTerminal = isTerminalStatus(indexEntry.status);
    if (indexTerminal && !logTerminal) {
      // The log lost its terminal event (storage budget failure): the index
      // (never budget-checked) supplies the terminal status. The terminal
      // invariants (§4.4) the lost event would have carried are synthesized
      // here so the hydrated info always passes isAgentTaskInfo: endedAt,
      // cleared autoBackground/queuePosition, and a failureReason for failed.
      base.status = indexEntry.status;
      base.endedAt = indexEntry.updatedAt || base.updatedAt;
      base.autoBackground = undefined;
      base.queuePosition = undefined;
      if (base.status === "failed" && base.failureReason === undefined) {
        base.failureReason = "internal_error";
        base.errorMessage = "task log tail was lost (storage limit); original failure reason unavailable";
      }
    }
    // Otherwise the log replayed status stands: a terminal log state is
    // trusted over a stale non-terminal index, and equal/non-terminal cases
    // need no override.
    base.lastCheckpointSeq = indexEntry.lastCheckpointSeq;
    base.hasUnclosedToolCall = indexEntry.hasUnclosedToolCall;
    base.stopReason = indexEntry.stopReason ?? base.stopReason;
    return base;
  }

  private _emitRecoveryIssue(issue: AgentTaskRecoveryIssue): void {
    this._recoveryIssues.set(issue.taskId, issue);
    this._emitServiceEvent({ type: "recovery_issue", issue });
  }

  // =========================================================================
  // Result synthesis (never-run tasks)
  // =========================================================================

  private _makeRejectedResult(spec: AgentTaskSpec, item: AgentTaskItemSpec, now: number): SubagentSingleResult {
    if (item.resolution !== "rejected") {
      throw new Error("Internal error: rejected result requires a rejected item.");
    }
    // A rejected item's reason comes from the 1.4.1 subagent set, a subset of
    // SubagentFailureReason.
    return this._makeSynthItemResult(spec, item, "failed", item.failureReason as SubagentFailureReason, item.errorMessage, now);
  }

  private _makeSynthItemResult(
    spec: AgentTaskSpec,
    item: AgentTaskItemSpec,
    status: "failed" | "aborted",
    failureReason: SubagentFailureReason,
    errorMessage: string,
    now: number,
  ): SubagentSingleResult {
    return {
      id: randomUUID(),
      index: item.index,
      step: spec.mode === "chain" ? item.index + 1 : undefined,
      agentName: item.resolution === "ready" ? item.agent.name : item.requestedAgentName ?? "general-purpose",
      agentSource: item.resolution === "ready" ? item.agent.source : "unknown",
      description: item.description,
      status,
      finalOutput: "",
      outputTruncated: false,
      originalOutputBytes: 0,
      toolUseCount: 0,
      activities: [],
      usage: emptyTaskUsage(),
      model: item.resolution === "ready" ? `${item.model.provider}/${item.model.modelId}` : undefined,
      failureReason,
      errorMessage,
      endedAt: now,
      durationMs: 0,
    };
  }

  // =========================================================================
  // Group orchestration (detach / auto-background / awaiters)
  // =========================================================================

  private _detachGroup(group: GroupEntry): void {
    if (group.detached || group.terminalSnapshot) {
      return;
    }
    group.detached = true;
    this._cancelAutoBackgroundTimer(group);
    this._flipGroupPresentation(group, "background");
    this._recordProductEvent("agent_task_backgrounded", {
      status: "background",
      counts: { tasks: group.taskIds.length },
    });
    this._resolveGroupAwaiters(group, { kind: "backgrounded", handle: this._buildGroupHandle(group) });
  }

  /** Display-only presentation switch for still-attached children. */
  private _flipGroupPresentation(group: GroupEntry, presentation: AgentTaskPresentation): void {
    for (const taskId of group.taskIds) {
      const entry = this._tasks.get(taskId);
      if (entry && !isTerminalStatus(entry.info.status)) {
        entry.info.presentation = presentation;
        entry.info.updatedAt = this._now();
        entry.persist.pendingEvents.push({ type: "presentation", presentation });
        this._schedulePersist(taskId);
        this._emitTaskState(taskId);
      }
    }
  }

  /** Foreground-only, group-level; every child mirrors the same deadline. */
  private _startAutoBackgroundTimer(group: GroupEntry): void {
    if (group.presentation !== "foreground" || group.detached || group.terminalSnapshot) {
      return;
    }
    const ms = this._resolveAutoBackgroundMs();
    if (ms <= 0) {
      return;
    }
    const now = this._now();
    const deadlineAt = now + ms;
    const warningAt = deadlineAt - AUTO_BACKGROUND_WARNING_LEAD_MS;
    const timers: AgentTaskServiceTimerHandle[] = [];
    group.autoBackgroundTimer = { deadlineAt, warningAt, warningActive: false, timers };
    for (const taskId of group.taskIds) {
      const entry = this._tasks.get(taskId);
      if (entry && !isTerminalStatus(entry.info.status)) {
        entry.info.autoBackground = { deadlineAt, warningAt, warningActive: false };
      }
    }
    if (warningAt > now) {
      timers.push(this._setTimer(() => this._fireAutoBackgroundWarning(group), warningAt - now));
    } else {
      this._fireAutoBackgroundWarning(group);
    }
    timers.push(this._setTimer(() => this._autoBackgroundNow(group), deadlineAt - now));
  }

  private _fireAutoBackgroundWarning(group: GroupEntry): void {
    const timer = group.autoBackgroundTimer;
    if (!timer || timer.warningActive) {
      return;
    }
    timer.warningActive = true;
    for (const taskId of group.taskIds) {
      const entry = this._tasks.get(taskId);
      if (entry && entry.info.autoBackground && !isTerminalStatus(entry.info.status)) {
        entry.info.autoBackground = { ...entry.info.autoBackground, warningActive: true };
        this._emitTaskState(taskId);
      }
    }
  }

  /**
   * UI-only auto-background: flip panel presentation, keep the parent await.
   * Manual background() / session detach still take the lane-B path.
   */
  private _autoBackgroundNow(group: GroupEntry): void {
    if (group.detached || group.terminalSnapshot) {
      this._cancelAutoBackgroundTimer(group);
      return;
    }
    this._flipGroupPresentation(group, "background");
    this._cancelAutoBackgroundTimer(group);
  }

  /** Cancels the group timer and clears the mirrored autoBackground fields. */
  private _cancelAutoBackgroundTimer(group: GroupEntry): void {
    const timer = group.autoBackgroundTimer;
    if (!timer) {
      return;
    }
    group.autoBackgroundTimer = undefined;
    for (const handle of timer.timers) {
      handle.cancel();
    }
    for (const taskId of group.taskIds) {
      const entry = this._tasks.get(taskId);
      if (entry && entry.info.autoBackground) {
        entry.info.autoBackground = undefined;
      }
    }
  }

  private _resolveAutoBackgroundMs(): number {
    if (testHooks?.autoBackgroundMsOverride !== undefined) {
      return testHooks.autoBackgroundMsOverride;
    }
    // B8 adds autoBackgroundMs to GuiSettings; read it defensively until then.
    const raw = (this._settings as unknown as { get: (key: string) => unknown }).get("autoBackgroundMs");
    if (typeof raw === "number") {
      if (raw === 0) {
        return 0;
      }
      const allowed = AUTO_BACKGROUND_ALLOWED_VALUES.find((value) => value === raw);
      if (allowed !== undefined) {
        return allowed;
      }
    }
    return DEFAULT_AUTO_BACKGROUND_MS;
  }

  private _checkGroupTerminal(groupId: string): void {
    const group = this._groups.get(groupId);
    // 1.4.2 (R3): the detached guard was dropped - a detached group (manual/
    // auto background, or a restored group) must still form its terminal
    // snapshot so the Plan adapter's two-phase consumption can read the
    // group result after every child finished. Awaiters were already resolved
    // at detach time, so forming the snapshot never re-resolves anyone.
    if (!group || group.terminalSnapshot !== undefined) {
      return;
    }
    const allTerminal = group.taskIds.every((taskId) => {
      const entry = this._tasks.get(taskId);
      return entry !== undefined && isTerminalStatus(entry.info.status);
    });
    if (!allTerminal) {
      return;
    }
    group.terminalSnapshot = group.taskIds.map((taskId) => structuredClone(this._tasks.get(taskId)!.info));
    // A terminal group must not keep an auto-background timer running.
    this._cancelAutoBackgroundTimer(group);
    this._resolveGroupAwaiters(group, this._buildAwaitResult(group));
  }

  private _buildAwaitResult(group: GroupEntry): AgentTaskAwaitResult {
    const infos = group.terminalSnapshot ?? [];
    const details = this._rebuildDetails(group, infos);
    const allCompleted = infos.length > 0 && infos.every((info) => info.status === "completed");
    return allCompleted ? { kind: "completed", details } : { kind: "failed", details };
  }

  /** Rebuild the legacy SubagentDetails in the original mode/order. */
  private _rebuildDetails(group: GroupEntry, infos: AgentTaskInfo[]): SubagentDetails {
    const results: SubagentSingleResult[] = [];
    for (const info of infos) {
      results.push(...info.results);
    }
    const now = this._now();
    return {
      schemaVersion: SUBAGENT_DETAILS_SCHEMA_VERSION,
      mode: group.mode,
      agentScope: group.agentScope,
      results,
      startedAt: group.createdAt,
      updatedAt: infos.reduce((max, info) => Math.max(max, info.updatedAt), group.createdAt),
      durationMs: Math.max(0, now - group.createdAt),
    };
  }

  private _resolveGroupAwaiters(group: GroupEntry, result: AgentTaskAwaitResult): void {
    const awaiters = group.awaiters.splice(0);
    for (const awaiter of awaiters) {
      awaiter.resolve(result);
    }
  }

  private _buildGroupHandle(group: GroupEntry): AgentTaskGroupHandle {
    return {
      kind: "agent_task_group",
      groupId: group.groupId,
      mode: group.mode,
      tasks: group.taskIds
        .map((taskId) => this._tasks.get(taskId))
        .filter((entry): entry is TaskEntry => entry !== undefined)
        .map((entry) => ({
          kind: "agent_task",
          taskId: entry.info.taskId,
          generation: entry.info.generation,
          status: entry.info.status,
          description: entry.info.description,
          presentation: entry.info.presentation,
        })),
    };
  }

  // =========================================================================
  // Input routing
  // =========================================================================

  private _onInputRequest(request: AgentTaskInputRequest): void {
    const entry = this._tasks.get(request.taskId);
    if (!entry || isTerminalStatus(entry.info.status)) {
      return;
    }
    // 1.4.2: a request arriving after the shutdown freeze (same guard as
    // _onInputSettled) must never rewrite the frozen pre-status to
    // waiting_input - the input itself is still recorded and surfaced, but the
    // task status stays frozen.
    if (entry.info.status === "running" && entry.persist.preShutdownStatus === undefined) {
      const from = entry.info.status;
      entry.info.status = "waiting_input";
      entry.info.updatedAt = this._now();
      this._logStateEvent(entry, from, "waiting_input", "input requested");
      entry.persist.indexDirty = true;
      this._schedulePersist(request.taskId);
      this._emitTaskState(request.taskId);
      this._recordProductEvent("agent_task_waiting_input", { status: "waiting_input" });
    }
    entry.persist.pendingEvents.push({ type: "input_requested", request });
    this._schedulePersist(request.taskId);
    this._emitServiceEvent({ type: "task_input", request });
  }

  private _onInputSettled(settle: { taskId: string; requestId: string; generation: number; reason: AgentTaskInputSettleReason }): void {
    const entry = this._tasks.get(settle.taskId);
    // 1.4.2: the shutdown settle (bounded abort / settleOnShutdown) of a
    // waiting_input task must never rewrite the frozen preShutdownStatus fact
    // (same guard as _finalizeTask): no status change, no state event, no
    // index rewrite. The input_settled log record + dismissal below still
    // happen (they describe the input, not the task status).
    if (
      entry &&
      entry.info.status === "waiting_input" &&
      !isTerminalStatus(entry.info.status) &&
      entry.persist.preShutdownStatus === undefined &&
      !entry.cancelRequested
    ) {
      // 1.4.2: while another request for the SAME task is still pending, the
      // task stays in waiting_input; only the last settle returns it to
      // running (the router removed the settled entry before this callback).
      const stillPending = this._input
        .getPending()
        .some((request) => request.taskId === settle.taskId && request.generation === settle.generation);
      if (!stillPending) {
        const from = entry.info.status;
        entry.info.status = "running";
        entry.info.updatedAt = this._now();
        this._logStateEvent(entry, from, "running", "input settled");
        entry.persist.indexDirty = true;
        this._schedulePersist(settle.taskId);
        this._emitTaskState(settle.taskId);
      }
    }
    const outcome: "answered" | "cancelled" | "shutdown" =
      settle.reason === "answered" ? "answered" : settle.reason === "shutdown" ? "shutdown" : "cancelled";
    if (entry) {
      entry.persist.pendingEvents.push({ type: "input_settled", requestId: settle.requestId, generation: settle.generation, outcome });
      this._schedulePersist(settle.taskId);
    }
    this._emitServiceEvent({
      type: "task_input_dismissed",
      taskId: settle.taskId,
      requestId: settle.requestId,
      generation: settle.generation,
      reason: settle.reason,
    });
  }

  // =========================================================================
  // Plan link transitions
  // =========================================================================

  private _applyPlanLinkTransition(
    groupId: string,
    link: AgentTaskPlanLink,
    target: "consumed" | "released",
    releaseReason?: "plan_revised" | "plan_cancelled",
  ): void {
    const group = this._groups.get(groupId);
    if (!group) {
      return; // Idempotent: an already-cleared group is a no-op.
    }
    if (!group.planLink || !this._linksEqual(group.planLink, link)) {
      throw new Error(`Plan link mismatch for group "${groupId}".`);
    }
    for (const taskId of group.taskIds) {
      const entry = this._tasks.get(taskId);
      if (entry && entry.info.planLinkState === "pending") {
        entry.info.planLinkState = target;
        entry.info.updatedAt = this._now();
        if (target === "consumed") {
          entry.persist.pendingEvents.push({ type: "plan_consumed", planLink: { ...link }, consumedAt: this._now() });
        } else if (releaseReason !== undefined) {
          entry.persist.pendingEvents.push({
            type: "plan_released",
            planLink: { ...link },
            reason: releaseReason,
            releasedAt: this._now(),
          });
        }
        this._schedulePersist(taskId);
        this._emitTaskState(taskId);
      }
    }
  }

  private _linksEqual(a: AgentTaskPlanLink, b: AgentTaskPlanLink): boolean {
    return a.planId === b.planId && a.version === b.version && a.stepId === b.stepId;
  }

  // =========================================================================
  // Delivery + clearing
  // =========================================================================

  /**
   * Shared auto-delivery eligibility (design plan §6.1): terminal, detached
   * group, not workflow-owned, not Plan-linked, a non-empty parent session,
   * same workspace, not already delivered there.
   */
  private _isAutoDeliverable(entry: TaskEntry, targetSessionId: string, workspaceId: string): boolean {
    if (!isTerminalStatus(entry.info.status)) return false;
    if (entry.info.workspaceId !== workspaceId) return false;
    if (entry.info.parentSessionId !== targetSessionId) return false;
    if (entry.info.parentSessionId === "") return false;
    if (entry.info.deliveredSessionIds.includes(targetSessionId)) return false;
    const group = this._groups.get(entry.info.groupId);
    if (!group || !group.detached || group.workflowOwned) return false;
    if (entry.info.planLink) return false;
    return true;
  }

  /**
   * 1.5 (P1): deliver every still-undelivered terminal result of the session
   * that just opened a sink (the task finished while no sink existed).
   */
  private _deliverPendingTerminalTasks(sessionId: string, workspaceId: string): void {
    for (const entry of this._tasks.values()) {
      if (!this._isAutoDeliverable(entry, sessionId, workspaceId)) continue;
      void this.sendResultToSession(entry.info.taskId, entry.info.generation, sessionId).then((result) => {
        if (!result.ok && result.reason !== "target_session_not_open" && result.reason !== "duplicate_delivery") {
          console.warn("[AgentTaskService] delivery catch-up failed:", result.reason);
        }
      });
    }
  }

  private _resultSummary(info: AgentTaskInfo): string {
    const statuses = info.results
      .map((result) => `${result.agentName} [${result.status}${result.failureReason ? ` (${result.failureReason})` : ""}]`)
      .join("; ");
    return statuses !== "" ? statuses : info.status;
  }

  /**
   * Lane B: after the parent await was released with a handle, inject each
   * terminal result into the parent session. Foreground awaits (including
   * UI-only auto-background) already return SubagentDetails. Plan-linked and
   * workflow-owned groups have their own consumers.
   */
  private _maybeAutoDeliver(entry: TaskEntry): void {
    if (entry.info.parentSessionId === "") {
      return;
    }
    if (!this._isAutoDeliverable(entry, entry.info.parentSessionId, entry.info.workspaceId)) {
      return;
    }
    void this.sendResultToSession(entry.info.taskId, entry.info.generation, entry.info.parentSessionId).then((result) => {
      if (!result.ok && result.reason !== "target_session_not_open" && result.reason !== "duplicate_delivery") {
        console.warn("[AgentTaskService] auto-delivery failed:", result.reason);
      }
    });
  }

  private _removeTask(entry: TaskEntry): void {
    if (entry.persist.reservationId !== undefined) {
      this._store.releaseBudget(entry.persist.reservationId);
      entry.persist.reservationId = undefined;
    }
    this._releaseResumeReservation(entry);
    this._tasks.delete(entry.info.taskId);
    const group = this._groups.get(entry.info.groupId);
    if (group) {
      const index = group.taskIds.indexOf(entry.info.taskId);
      if (index !== -1) {
        group.taskIds.splice(index, 1);
      }
      if (group.taskIds.length === 0) {
        this._cancelAutoBackgroundTimer(group);
        this._groups.delete(group.groupId);
      }
    }
  }

  // =========================================================================
  // 1.5 (P1) retention (design plan §6.3)
  // =========================================================================

  /**
   * Serialize one retention pass onto the persistence flush queue: it runs
   * strictly after the workspace's pending flushes, so a task's terminal state
   * event is durably written before its record could be deleted. The pass
   * never schedules itself (its own storage refresh cannot retrigger it).
   */
  private _scheduleRetention(workspaceId: string): void {
    this._flushTail = this._flushTail.then(
      () => this._runRetentionForWorkspace(workspaceId).catch((err: unknown) => {
        console.error("[AgentTaskService] retention pass failed:", err);
      }),
      () => this._runRetentionForWorkspace(workspaceId).catch((err: unknown) => {
        console.error("[AgentTaskService] retention pass failed:", err);
      }),
    );
  }

  private async _runRetentionForWorkspace(workspaceId: string): Promise<void> {
    const emergency = this._storageStatuses.get(workspaceId)?.level === "full";
    const candidates: RetentionCandidate[] = [];
    for (const entry of this._tasks.values()) {
      if (entry.info.workspaceId !== workspaceId || !isTerminalStatus(entry.info.status)) {
        continue;
      }
      candidates.push({
        taskId: entry.info.taskId,
        status: entry.info.status,
        endedAt: entry.info.endedAt ?? entry.info.updatedAt,
        planLinkState: entry.info.planLinkState,
        parentSessionId: entry.info.parentSessionId,
        deliveredCount: entry.info.deliveredSessionIds.length,
        workflowOwned: entry.workflowOwned,
      });
    }
    const removals = selectRetentionRemovals(candidates, {
      now: this._now(),
      emergency,
      ...(testHooks?.retentionOverride ?? {}),
    });
    if (removals.length === 0) {
      return;
    }
    for (const taskId of removals) {
      const entry = this._tasks.get(taskId);
      if (!entry || !isTerminalStatus(entry.info.status)) {
        continue; //状态在快照之后变化:以当前为准,永不删非终态
      }
      try {
        await this._deleteTaskRecord(entry);
      } catch (err) {
        console.error(`[AgentTaskService] retention delete failed for task ${taskId}:`, err);
      }
    }
    await this._refreshStorageStatus(workspaceId);
  }

  // =========================================================================
  // Event emission + throttle
  // =========================================================================

  private _emitTaskState(taskId: string): void {
    const entry = this._tasks.get(taskId);
    if (!entry) {
      return;
    }
    this._emitServiceEvent({ type: "task_state", task: structuredClone(entry.info) });
  }

  private _emitServiceEvent(event: AgentTaskServiceEvent): void {
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch {
        // A listener must never break the service.
      }
    }
  }

  /** Bounded 100ms throttle: task_activities/task_output merge before emission. */
  private _scheduleThrottleFlush(taskId: string): void {
    const entry = this._tasks.get(taskId);
    if (!entry || entry.throttle.timer) {
      return;
    }
    const now = this._now();
    if (now - entry.throttle.lastEmitAt >= EVENT_THROTTLE_MS) {
      this._flushThrottle(taskId);
      return;
    }
    entry.throttle.timer = this._setTimer(() => {
      const current = this._tasks.get(taskId);
      if (current) {
        current.throttle.timer = undefined;
      }
      this._flushThrottle(taskId);
    }, EVENT_THROTTLE_MS - (now - entry.throttle.lastEmitAt));
  }

  private _flushThrottle(taskId: string): void {
    const entry = this._tasks.get(taskId);
    if (!entry) {
      return;
    }
    if (entry.throttle.timer) {
      entry.throttle.timer.cancel();
      entry.throttle.timer = undefined;
    }
    const activities = entry.throttle.pendingActivities;
    const output = entry.throttle.pendingOutput;
    const transcripts = entry.throttle.pendingTranscript;
    entry.throttle.pendingActivities = [];
    entry.throttle.pendingOutput = undefined;
    entry.throttle.pendingTranscript = [];
    const now = this._now();
    entry.throttle.lastEmitAt = now;
    if (entry.info.startedAt !== undefined && !isTerminalStatus(entry.info.status)) {
      entry.info.durationMs = Math.max(0, now - entry.info.startedAt);
      entry.info.updatedAt = now;
    }
    if (activities.length > 0) {
      this._emitServiceEvent({
        type: "task_activities",
        taskId,
        activities,
        toolUseCount: entry.info.toolUseCount,
        durationMs: entry.info.durationMs,
      });
    }
    if (output) {
      this._emitServiceEvent({ type: "task_output", taskId, output: output.text, truncated: output.truncated });
    }
    // 1.5 (P3): one task_transcript per buffered entry, in arrival order.
    for (const pending of transcripts) {
      this._emitServiceEvent({ type: "task_transcript", taskId, itemIndex: pending.itemIndex, event: pending.event });
    }
  }

  private _refreshQueuePositions(): void {
    for (const entry of this._tasks.values()) {
      if (entry.info.status !== "queued") {
        continue;
      }
      const position = this._scheduler.getQueuePosition(entry.info.taskId);
      if (entry.info.queuePosition !== position) {
        entry.info.queuePosition = position;
        entry.info.updatedAt = this._now();
        this._emitTaskState(entry.info.taskId);
      }
    }
  }

  // =========================================================================
  // Time + product events
  // =========================================================================

  private _now(): number {
    return testHooks?.now ? testHooks.now() : Date.now();
  }

  private _setTimer(callback: () => void, ms: number): AgentTaskServiceTimerHandle {
    if (testHooks?.setTimer) {
      return testHooks.setTimer(callback, ms);
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      if (!cancelled) {
        callback();
      }
    }, ms);
    return {
      cancel: () => {
        cancelled = true;
        clearTimeout(handle);
      },
    };
  }

  private _recordTaskTerminalEvent(info: AgentTaskInfo): void {
    switch (info.status) {
      case "completed":
        this._recordProductEvent("agent_task_completed", {
          status: "completed",
          durationMs: info.durationMs,
          counts: { turns: info.usage.turns },
          model: this._firstItemModel(info),
        });
        break;
      case "failed":
        this._recordProductEvent("agent_task_failed", {
          status: "failed",
          durationMs: info.durationMs,
          errorCategory: mapFailureCategory(info.failureReason),
          model: this._firstItemModel(info),
        });
        break;
      case "cancelled":
        this._recordProductEvent("agent_task_cancelled", { status: "cancelled", durationMs: info.durationMs });
        break;
      default:
        break;
    }
  }

  private _firstItemModel(info: AgentTaskInfo): { provider: string; modelId: string } | undefined {
    const model = info.itemSummaries[0]?.model;
    return model ? { provider: model.provider, modelId: model.modelId } : undefined;
  }

  private _recordProductEvent(name: ProductEventName, payload: ProductEventPayload): void {
    const event: ProductEvent = { schemaVersion: 1, name, payload };
    this._events.record(event);
  }
}
