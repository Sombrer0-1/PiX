/**
 * Versioned agent-task persistence store (design plan section 4.7; 1.4.2 R1).
 *
 * Scope of this file (1.4.2 R1):
 * - directory layout under <root>/<workspaceId>/{index.json,index.prev.json,
 *   close-marker.json,<taskId>/{task.json,events.jsonl,checkpoint.json,sessions/}}
 * - atomic tmp+rename writes; a new index write first preserves the last
 *   known-valid generation as index.prev.json, and a corrupt current
 *   generation falls back to it
 * - a single-write queue that allocates the monotonic event seq and
 *   serializes all mutations
 * - strict JSONL corruption detection: a final entry without a trailing
 *   newline - the crash-truncation signature - is tail_corrupt and repaired
 *   transactionally (hash-named, immutable .bak backup first, then atomic
 *   replacement with the valid prefix; the transaction is idempotent and
 *   re-runnable at any point); a bad line in the middle (mid_log_corrupt) or
 *   an invalid session header isolates the task read-only
 * - per-task / per-workspace byte budgets with reservations, plus the 80%
 *   warning level for the UI
 * - runId close-marker write/consume (clean / crash / stale_marker)
 *
 * restoreAll, checkpoint write-amplification control and the workspace
 * fingerprint *write* side are 1.4.2 R2; this file only needs the
 * checkpoint.json read/write structure. Diagnostics use
 * AgentTaskRecoveryIssueCode from the shared leaf (1.4.2 R1); the store never
 * depends on AgentSession or any runtime type - every value here is plain
 * data that survives JSON round-trips.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  AGENT_TASK_SCHEMA_VERSION,
  isAgentTaskInfo,
  type AgentTaskActivity,
  type AgentTaskInfo,
  type AgentTaskInputRequest,
  type AgentTaskPlanLink,
  type AgentTaskPresentation,
  type AgentTaskRecoveryIssueCode,
  type AgentTaskSpec,
  type AgentTaskStatus,
  type AgentTaskStopReason,
  type AgentTaskUsage,
} from "../../shared/agent-task-types.js";
import type { SubagentSingleResult } from "../../shared/subagent-types.js";

export const AGENT_TASK_DEFAULT_MAX_TASK_BYTES = 25 * 1024 * 1024; // PRD C5
export const AGENT_TASK_DEFAULT_MAX_WORKSPACE_BYTES = 500 * 1024 * 1024; // PRD C5
export const AGENT_TASK_INDEX_SCHEMA_VERSION = 1;
export const AGENT_TASK_CLOSE_MARKER_SCHEMA_VERSION = 1;
/** Workspace budget ratio above which the task panel shows a storage warning. */
export const AGENT_TASK_STORAGE_WARNING_RATIO = 0.8;
/** Atomic-write rename retries (Windows EPERM when a concurrent reader holds the target). */
const ATOMIC_RENAME_RETRIES = 5;
const ATOMIC_RENAME_RETRY_DELAY_MS = 10;

// ============================================================================
// Store contract types (design plan section 4.7, verbatim shape)
// ============================================================================

export interface TaskIndexEntry {
  taskId: string;
  workspaceId: string;
  parentSessionId: string;
  parentToolCallId: string;
  groupId: string;
  planLink?: AgentTaskPlanLink;
  status: AgentTaskStatus;
  lastCheckpointSeq: number;
  hasUnclosedToolCall: boolean;
  stopReason?: AgentTaskStopReason;
  preShutdownStatus?: AgentTaskStatus;
  updatedAt: number;
  schemaVersion: number;
  lastWriterRunId: string;
}
export interface TaskIndex {
  schemaVersion: number;
  workspaceId: string;
  generation: number;
  lastWriterRunId: string;
  tasks: TaskIndexEntry[];
}
export interface TaskMetadata {
  schemaVersion: number;
  spec: AgentTaskSpec;
  initialInfo: AgentTaskInfo;
}
export type TaskLogEventPayload =
  | { type: "state"; from: AgentTaskStatus; to: AgentTaskStatus; info: AgentTaskInfo; reason?: string }
  | { type: "activity"; activity: AgentTaskActivity }
  | { type: "output"; text: string; truncated: boolean }
  | { type: "item_result"; result: SubagentSingleResult }
  | { type: "usage"; usage: AgentTaskUsage }
  | { type: "presentation"; presentation: AgentTaskPresentation }
  | { type: "delivery"; targetSessionId: string; deliveredAt: number }
  | { type: "plan_consumed"; planLink: AgentTaskPlanLink; consumedAt: number }
  | { type: "plan_released"; planLink: AgentTaskPlanLink; reason: "plan_revised" | "plan_cancelled"; releasedAt: number }
  | { type: "input_requested"; request: AgentTaskInputRequest }
  | { type: "input_settled"; requestId: string; generation: number; outcome: "answered" | "cancelled" | "shutdown" }
  | { type: "diagnostic"; code: string; message: string };
export type TaskLogEvent = TaskLogEventPayload & { seq: number; ts: number };
export interface OpenToolCall {
  toolCallId: string;
  toolName: string;
  startedAt: number;
}
export interface TaskCheckpoint {
  taskId: string;
  generation: number;
  seq: number;
  activeItemIndex: number; // 当前/下一 item；允许等于 items.length 表示所有 item 已完成
  sessionFileName: string | null; // item 间/首 item 尚未建 session 时为 null
  sessionLeafId: string | null;
  lastFinalizedEntryId?: string;
  openToolCalls: OpenToolCall[];
  workspaceFingerprint: WorkspaceFingerprint;
  ts: number;
}
export interface WorkspaceFingerprint {
  isGit: boolean;
  head?: string;
  dirtySummary?: string;
  observedFileHashes: Record<string, string>;
}
export interface TaskStorageDiagnostic {
  code: AgentTaskRecoveryIssueCode;
  message: string;
  recoverable: boolean;
}
export interface TaskReadResult {
  metadata: TaskMetadata | null;
  events: TaskLogEvent[];
  checkpoint: TaskCheckpoint | null;
  diagnostics: TaskStorageDiagnostic[];
}
export interface SessionTranscriptInspection {
  kind: "valid" | "tail_corrupt" | "invalid";
  lastValidByteOffset: number;
  diagnostics: TaskStorageDiagnostic[];
}
export interface TaskBudgetReservation {
  reservationId: string;
  workspaceId: string;
  taskId: string;
  reservedBytes: number;
}
export interface AgentTaskCloseMarker {
  schemaVersion: 1;
  runId: string;
  closedAt: number;
}
export interface CloseDiagnosis {
  kind: "clean" | "crash" | "stale_marker";
  marker?: AgentTaskCloseMarker;
}

/** Thrown when a write would push a task or workspace past its byte budget. */
export class TaskStorageLimitError extends Error {
  readonly code = "storage_limit" as const;
  constructor(message: string) {
    super(message);
    this.name = "TaskStorageLimitError";
  }
}

export type TaskStorageUsageLevel = "ok" | "warning" | "full";

/**
 * Workspace storage level for the task panel (PRD C5): "warning" once the
 * committed bytes (used + reserved) reach 80% of the limit, "full" once they
 * reach the limit.
 */
export function storageUsageLevel(usage: { usedBytes: number; reservedBytes: number; limitBytes: number }): TaskStorageUsageLevel {
  const committed = usage.usedBytes + usage.reservedBytes;
  if (committed >= usage.limitBytes) return "full";
  if (committed >= usage.limitBytes * AGENT_TASK_STORAGE_WARNING_RATIO) return "warning";
  return "ok";
}

// ============================================================================
// Structural guards (plain-data shape checks; no semantic validation)
// ============================================================================

// 1.4.2 (R2): "interrupted" is a legal persisted status (restart hydration and
// the pre-shutdown freeze in the index entry).
const STORE_STATUSES = ["queued", "running", "waiting_input", "completed", "failed", "cancelled", "interrupted"] as const;
const STORE_PRESENTATIONS = ["foreground", "background"] as const;
const STORE_STOP_REASONS = ["user_cancel", "app_shutdown"] as const;
const STORE_SUBAGENT_STATUSES = ["queued", "running", "completed", "failed", "aborted"] as const;
const STORE_ACTIVITY_STATUSES = ["running", "completed", "failed"] as const;
const STORE_INPUT_OUTCOMES = ["answered", "cancelled", "shutdown"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function isPlanLink(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.planId === "string" &&
    isFiniteNonNegative(value.version) &&
    typeof value.stepId === "string"
  );
}

function isSessionHeaderLine(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.type === "session" &&
    typeof value.id === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.cwd === "string"
  );
}

function isSessionEntryLine(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.type === "string" &&
    typeof value.id === "string" &&
    (value.parentId === null || typeof value.parentId === "string") &&
    typeof value.timestamp === "string"
  );
}

function isOpenToolCall(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string" &&
    isFiniteNonNegative(value.startedAt)
  );
}

function isWorkspaceFingerprint(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.isGit !== "boolean") return false;
  if (value.head !== undefined && typeof value.head !== "string") return false;
  if (value.dirtySummary !== undefined && typeof value.dirtySummary !== "string") return false;
  if (!isRecord(value.observedFileHashes)) return false;
  return Object.values(value.observedFileHashes).every((hash) => typeof hash === "string");
}

function isAgentTaskSpec(value: unknown): value is AgentTaskSpec {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== AGENT_TASK_SCHEMA_VERSION) return false;
  if (typeof value.taskId !== "string" || typeof value.groupId !== "string") return false;
  if (!isOneOf(value.groupMode, ["single", "parallel", "chain"])) return false;
  if (!isOneOf(value.mode, ["single", "chain"])) return false;
  if (!Array.isArray(value.items)) return false;
  if (typeof value.workspaceId !== "string") return false;
  if (typeof value.parentSessionId !== "string" || typeof value.parentToolCallId !== "string") return false;
  return true;
}

function isTaskMetadata(value: unknown): value is TaskMetadata {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== AGENT_TASK_SCHEMA_VERSION) return false;
  if (!isAgentTaskSpec(value.spec)) return false;
  if (!isAgentTaskInfo(value.initialInfo)) return false;
  return (
    value.spec.taskId === value.initialInfo.taskId &&
    value.spec.workspaceId === value.initialInfo.workspaceId
  );
}

function isTaskIndexEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.taskId !== "string" || typeof value.workspaceId !== "string") return false;
  if (typeof value.parentSessionId !== "string" || typeof value.parentToolCallId !== "string") return false;
  if (typeof value.groupId !== "string") return false;
  if (value.planLink !== undefined && !isPlanLink(value.planLink)) return false;
  if (!isOneOf(value.status, STORE_STATUSES)) return false;
  if (typeof value.lastCheckpointSeq !== "number" || !Number.isInteger(value.lastCheckpointSeq) || value.lastCheckpointSeq < 0) {
    return false;
  }
  if (typeof value.hasUnclosedToolCall !== "boolean") return false;
  if (value.stopReason !== undefined && !isOneOf(value.stopReason, STORE_STOP_REASONS)) return false;
  if (value.preShutdownStatus !== undefined && !isOneOf(value.preShutdownStatus, STORE_STATUSES)) return false;
  if (!isFiniteNonNegative(value.updatedAt)) return false;
  if (typeof value.schemaVersion !== "number") return false;
  if (typeof value.lastWriterRunId !== "string") return false;
  return true;
}

function isTaskIndex(value: unknown): value is TaskIndex {
  if (!isRecord(value)) return false;
  if (typeof value.schemaVersion !== "number") return false;
  if (typeof value.workspaceId !== "string") return false;
  if (typeof value.generation !== "number" || !Number.isInteger(value.generation) || value.generation < 0) return false;
  if (typeof value.lastWriterRunId !== "string") return false;
  if (!Array.isArray(value.tasks)) return false;
  return value.tasks.every(isTaskIndexEntry);
}

function isTaskCheckpoint(value: unknown): value is TaskCheckpoint {
  if (!isRecord(value)) return false;
  if (typeof value.taskId !== "string") return false;
  if (typeof value.generation !== "number" || !Number.isInteger(value.generation) || value.generation < 0) return false;
  if (typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq < 0) return false;
  if (typeof value.activeItemIndex !== "number" || !Number.isInteger(value.activeItemIndex) || value.activeItemIndex < 0) {
    return false;
  }
  if (value.sessionFileName !== null && typeof value.sessionFileName !== "string") return false;
  if (value.sessionLeafId !== null && typeof value.sessionLeafId !== "string") return false;
  if (value.lastFinalizedEntryId !== undefined && typeof value.lastFinalizedEntryId !== "string") return false;
  if (!Array.isArray(value.openToolCalls) || !value.openToolCalls.every(isOpenToolCall)) return false;
  if (!isWorkspaceFingerprint(value.workspaceFingerprint)) return false;
  if (!isFiniteNonNegative(value.ts)) return false;
  return true;
}

function isAgentTaskCloseMarker(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === AGENT_TASK_CLOSE_MARKER_SCHEMA_VERSION &&
    typeof value.runId === "string" &&
    isFiniteNonNegative(value.closedAt)
  );
}

function isTaskLogEventPayload(value: unknown): value is TaskLogEventPayload {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "state": {
      if (!isOneOf(value.from, STORE_STATUSES) || !isOneOf(value.to, STORE_STATUSES)) return false;
      if (!isAgentTaskInfo(value.info)) return false;
      return value.reason === undefined || typeof value.reason === "string";
    }
    case "activity": {
      const activity = value.activity;
      if (!isRecord(activity)) return false;
      return (
        isFiniteNonNegative(activity.sequence) &&
        typeof activity.toolCallId === "string" &&
        typeof activity.toolName === "string" &&
        isOneOf(activity.status, STORE_ACTIVITY_STATUSES)
      );
    }
    case "output":
      return typeof value.text === "string" && typeof value.truncated === "boolean";
    case "item_result": {
      const result = value.result;
      if (!isRecord(result)) return false;
      return (
        typeof result.id === "string" &&
        typeof result.agentName === "string" &&
        isOneOf(result.status, STORE_SUBAGENT_STATUSES) &&
        typeof result.finalOutput === "string"
      );
    }
    case "usage": {
      const usage = value.usage;
      if (!isRecord(usage)) return false;
      return (
        isFiniteNonNegative(usage.input) &&
        isFiniteNonNegative(usage.output) &&
        isFiniteNonNegative(usage.totalTokens)
      );
    }
    case "presentation":
      return isOneOf(value.presentation, STORE_PRESENTATIONS);
    case "delivery":
      return typeof value.targetSessionId === "string" && isFiniteNonNegative(value.deliveredAt);
    case "plan_consumed":
      return isPlanLink(value.planLink) && isFiniteNonNegative(value.consumedAt);
    case "plan_released": {
      if (!isPlanLink(value.planLink)) return false;
      if (!isOneOf(value.reason, ["plan_revised", "plan_cancelled"])) return false;
      return isFiniteNonNegative(value.releasedAt);
    }
    case "input_requested": {
      const request = value.request;
      if (!isRecord(request)) return false;
      return (
        typeof request.taskId === "string" &&
        typeof request.requestId === "string" &&
        isFiniteNonNegative(request.generation) &&
        isRecord(request.request)
      );
    }
    case "input_settled":
      return (
        typeof value.requestId === "string" &&
        isFiniteNonNegative(value.generation) &&
        isOneOf(value.outcome, STORE_INPUT_OUTCOMES)
      );
    case "diagnostic":
      return typeof value.code === "string" && typeof value.message === "string";
    default:
      return false;
  }
}

function isTaskLogEvent(value: unknown): value is TaskLogEvent {
  if (!isRecord(value)) return false;
  if (typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq < 1) return false;
  if (!isFiniteNonNegative(value.ts)) return false;
  return isTaskLogEventPayload(value);
}

// ============================================================================
// Task metadata migration framework (R1 ships the first on-disk schema v1)
// ============================================================================

export type TaskMetadataMigrationOutcome =
  | { ok: true; metadata: TaskMetadata }
  | { ok: false; code: "unknown_schema" | "migration_failed"; message: string };

/**
 * Versioned conversion of a stored TaskMetadata into a valid current-shape
 * value. R1 ships the first on-disk schema (AGENT_TASK_SCHEMA_VERSION = 1) and
 * no older formats, so the chain is the v1 identity plus a strict structural
 * validation. A version with no registered migration path is "unknown_schema"
 * (read-only, never modified); a record that cannot be converted into a valid
 * current shape is "migration_failed". Both outcomes leave the original file
 * untouched - migration never rewrites storage.
 */
export function migrateTaskMetadata(raw: unknown): TaskMetadataMigrationOutcome {
  if (!isRecord(raw) || typeof raw.schemaVersion !== "number") {
    return { ok: false, code: "unknown_schema", message: "task metadata has no numeric schemaVersion (read-only, file preserved)" };
  }
  if (raw.schemaVersion === AGENT_TASK_SCHEMA_VERSION) {
    if (isTaskMetadata(raw)) {
      return { ok: true, metadata: raw };
    }
    return {
      ok: false,
      code: "migration_failed",
      message: `task metadata schema v${AGENT_TASK_SCHEMA_VERSION} failed migration to a valid current shape (original file preserved)`,
    };
  }
  return {
    ok: false,
    code: "unknown_schema",
    message: `unknown task metadata schemaVersion ${raw.schemaVersion} (read-only, file preserved)`,
  };
}

// ============================================================================
// AgentTaskStore
// ============================================================================

interface JsonlCoreScan {
  kind: "valid" | "tail_corrupt" | "invalid";
  lastValidByteOffset: number;
  diagnostics: TaskStorageDiagnostic[];
  lineCount: number;
  /** True when the buffer is empty or its last byte is a newline. */
  endsWithNewline: boolean;
}

interface EventsFileScan {
  kind: "valid" | "tail_corrupt" | "invalid";
  events: TaskLogEvent[];
  lastSeq: number;
  lastValidByteOffset: number;
  diagnostics: TaskStorageDiagnostic[];
  endsWithNewline: boolean;
}

type JsonlTailRepairResult =
  | { ok: true; preservedFileName: string }
  | { ok: false; reason: "storage_limit"; message: string };

export class AgentTaskStore {
  private readonly _rootDir: string;
  private readonly _maxTaskBytes: number;
  private readonly _maxWorkspaceBytes: number;
  private _writeTail: Promise<void> = Promise.resolve();
  private readonly _reservations = new Map<string, TaskBudgetReservation>();
  /** Cached recursive directory sizes; invalidated on overwrite, incremented on append. */
  private readonly _usedBytesCache = new Map<string, number>();

  constructor(opts: { rootDir: string; maxTaskBytes: number; maxWorkspaceBytes: number }) {
    this._rootDir = opts.rootDir;
    this._maxTaskBytes = opts.maxTaskBytes;
    this._maxWorkspaceBytes = opts.maxWorkspaceBytes;
  }

  // --------------------------------------------------------------------------
  // Single-write queue: all mutations and all reads that touch disk are
  // serialized here, so seq allocation, repairs and usage scans are atomic
  // with respect to each other.
  // --------------------------------------------------------------------------

  private _enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._writeTail.then(fn, fn);
    this._writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // --------------------------------------------------------------------------
  // Path helpers and safety
  // --------------------------------------------------------------------------

  private static _assertSafeComponent(name: string, kind: string): void {
    if (
      name.length === 0 ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes("\0")
    ) {
      throw new Error(`invalid ${kind}: ${JSON.stringify(name)}`);
    }
  }

  private _workspaceDir(workspaceId: string): string {
    return join(this._rootDir, workspaceId);
  }

  private _taskDir(workspaceId: string, taskId: string): string {
    return join(this._workspaceDir(workspaceId), taskId);
  }

  /**
   * Resolves a session transcript inside <task>/sessions/ and rejects any
   * file name that escapes the directory (absolute paths, "..", separators).
   */
  private _sessionTranscriptPath(workspaceId: string, taskId: string, sessionFileName: string): string {
    AgentTaskStore._assertSafeComponent(workspaceId, "workspaceId");
    AgentTaskStore._assertSafeComponent(taskId, "taskId");
    const sessionsDir = resolve(join(this._rootDir, workspaceId, taskId, "sessions"));
    const resolved = resolve(sessionsDir, sessionFileName);
    if (basename(resolved) !== sessionFileName || !resolved.startsWith(sessionsDir + sep)) {
      throw new Error(`session transcript file name must be a basename inside the task sessions directory: ${JSON.stringify(sessionFileName)}`);
    }
    return resolved;
  }

  // --------------------------------------------------------------------------
  // Low-level file helpers
  // --------------------------------------------------------------------------

  private static async _fileExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private static async _readJsonObject(path: string): Promise<unknown | null> {
    try {
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private static async _atomicWriteJson(path: string, value: unknown): Promise<void> {
    await AgentTaskStore._atomicWriteBuffer(path, Buffer.from(JSON.stringify(value, null, 2), "utf-8"));
  }

  /**
   * Renames tmp onto path, retrying briefly: Windows rename to an existing
   * target fails with EPERM while a concurrent reader holds the file open.
   * Shared by every atomic replacement in this file (including the tail
   * repair transaction), so all of them behave the same way under transient
   * EPERM. Throws the last error after ATOMIC_RENAME_RETRIES attempts.
   */
  private static async _atomicRenameWithRetry(tmp: string, path: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < ATOMIC_RENAME_RETRIES; attempt++) {
      try {
        await rename(tmp, path);
        return;
      } catch (err) {
        lastError = err;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, ATOMIC_RENAME_RETRY_DELAY_MS));
      }
    }
    throw lastError;
  }

  /** tmp + rename so a crash can never leave a half-written target file. */
  private static async _atomicWriteBuffer(path: string, buffer: Buffer): Promise<void> {
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, buffer);
      await AgentTaskStore._atomicRenameWithRetry(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  private _wsUsedKey(workspaceId: string): string {
    return `ws:${workspaceId}`;
  }

  private _taskUsedKey(workspaceId: string, taskId: string): string {
    return `task:${workspaceId}/${taskId}`;
  }

  private async _dirSizeCached(dir: string, cacheKey: string): Promise<number> {
    const cached = this._usedBytesCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const size = await AgentTaskStore._dirSize(dir);
    this._usedBytesCache.set(cacheKey, size);
    return size;
  }

  private _addUsedBytes(cacheKey: string, delta: number): void {
    const cached = this._usedBytesCache.get(cacheKey);
    if (cached !== undefined) {
      this._usedBytesCache.set(cacheKey, cached + delta);
    }
  }

  private _invalidateUsedBytes(workspaceId: string, taskId?: string): void {
    this._usedBytesCache.delete(this._wsUsedKey(workspaceId));
    if (taskId !== undefined) {
      this._usedBytesCache.delete(this._taskUsedKey(workspaceId, taskId));
    }
  }

  /** Recursive byte count of a directory tree; missing dirs count as 0. */
  private static async _dirSize(dir: string): Promise<number> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let total = 0;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await AgentTaskStore._dirSize(path);
      } else if (entry.isFile()) {
        const info = await stat(path).catch(() => null);
        if (info !== null) total += info.size;
      }
      // Symlinks are not followed.
    }
    return total;
  }

  // --------------------------------------------------------------------------
  // Strict JSONL scanning (shared by events.jsonl and session transcripts)
  // --------------------------------------------------------------------------

  /**
   * Line-by-line structural scan of a JSONL buffer. Every complete
   * newline-terminated line must parse as JSON and pass validateLine; the
   * first failing complete line makes the file "invalid" (mid_log_corrupt, or
   * session_header_corrupt for line 0). A final line without a trailing
   * newline is the crash-truncation signature and makes the file
   * "tail_corrupt" with lastValidByteOffset pointing just past the last
   * complete newline-terminated line (the repair prefix, which ends with
   * "\n") - even when the partial line's content happens to parse. Treating
   * that shape as "valid" would let a later append concatenate onto the same
   * line and turn a benign truncated write into an unrecoverable
   * mid_log_corrupt on the next scan (the plan requires the valid prefix to
   * end with a newline and forbids joining new JSON to a half-written line).
   */
  private static _scanJsonlCore(
    buffer: Buffer,
    validateLine: (value: unknown, index: number) => boolean,
    badLineCode: (index: number) => AgentTaskRecoveryIssueCode,
  ): JsonlCoreScan {
    const newlineIndexes: number[] = [];
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] === 0x0a) newlineIndexes.push(i);
    }
    const lines: Array<{ start: number; end: number; complete: boolean }> = [];
    let start = 0;
    for (const newline of newlineIndexes) {
      lines.push({ start, end: newline, complete: true });
      start = newline + 1;
    }
    if (start < buffer.length) {
      lines.push({ start, end: buffer.length, complete: false });
    }
    const lastCompleteLineEnd = newlineIndexes.length > 0 ? newlineIndexes[newlineIndexes.length - 1] + 1 : 0;
    const endsWithNewline = buffer.length === 0 || buffer[buffer.length - 1] === 0x0a;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const text = buffer.toString("utf8", line.start, line.end);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const ok = parsed !== null && validateLine(parsed, i);
      if (line.complete) {
        if (ok) continue;
        // Lines before the first bad line are complete and valid; the recoverable
        // prefix ends just past the newline of the line before it (or 0).
        const lastValidOffset = i > 0 ? newlineIndexes[i - 1] + 1 : 0;
        return {
          kind: "invalid",
          lastValidByteOffset: lastValidOffset,
          diagnostics: [
            {
              code: badLineCode(i),
              message: `corrupt line ${i + 1}: not a structurally valid JSON record`,
              recoverable: false,
            },
          ],
          lineCount: lines.length,
          endsWithNewline,
        };
      }
      // Final partial line (no trailing newline): the crash-truncation
      // signature. Even when its content parses, it is not a complete
      // newline-terminated record; classifying it as "valid" would let the
      // next append concatenate onto the same line and turn the file into an
      // unrecoverable mid_log_corrupt. Report tail_corrupt so the append path
      // repairs (backup + atomic prefix replace) before writing anything new.
      return {
        kind: "tail_corrupt",
        lastValidByteOffset: lastCompleteLineEnd,
        diagnostics: [
          {
            code: "tail_corrupt",
            message: `final entry lacks a trailing newline (truncated write); valid content ends at byte ${lastCompleteLineEnd}`,
            recoverable: true,
          },
        ],
        lineCount: lines.length,
        endsWithNewline,
      };
    }
    return { kind: "valid", lastValidByteOffset: buffer.length, diagnostics: [], lineCount: lines.length, endsWithNewline };
  }

  private static _scanEventsFile(filePath: string): Promise<EventsFileScan> {
    return AgentTaskStore._readFileSafe(filePath).then((buffer) => {
      if (buffer === null) {
        return { kind: "valid" as const, events: [], lastSeq: 0, lastValidByteOffset: 0, diagnostics: [], endsWithNewline: true };
      }
      const core = AgentTaskStore._scanJsonlCore(buffer, (value) => isTaskLogEvent(value), () => "mid_log_corrupt");
      const events = AgentTaskStore._parseEventsFromPrefix(buffer, core.lastValidByteOffset);
      const lastSeq = events.length > 0 ? events[events.length - 1].seq : 0;
      return {
        kind: core.kind,
        events,
        lastSeq,
        lastValidByteOffset: core.lastValidByteOffset,
        diagnostics: core.diagnostics,
        endsWithNewline: core.endsWithNewline,
      };
    });
  }

  private static _parseEventsFromPrefix(buffer: Buffer, byteOffset: number): TaskLogEvent[] {
    if (byteOffset <= 0) return [];
    const text = buffer.toString("utf8", 0, byteOffset);
    const events: TaskLogEvent[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (isTaskLogEvent(parsed)) events.push(parsed);
    }
    return events;
  }

  /**
   * Strict session-transcript scan: line 0 must be a valid session header,
   * every complete line a structurally valid entry. Empty files, truncated
   * headers and bad complete lines are "invalid"; only a truncated final
   * *entry* line is "tail_corrupt".
   */
  private static _scanSessionBuffer(buffer: Buffer): JsonlCoreScan {
    const core = AgentTaskStore._scanJsonlCore(
      buffer,
      (value, index) => (index === 0 ? isSessionHeaderLine(value) : isSessionEntryLine(value)),
      (index) => (index === 0 ? "session_header_corrupt" : "mid_log_corrupt"),
    );
    if (core.kind === "valid" && core.lineCount === 0) {
      return {
        kind: "invalid",
        lastValidByteOffset: 0,
        diagnostics: [
          { code: "session_header_corrupt", message: "session transcript is empty (no session header)", recoverable: false },
        ],
        lineCount: 0,
        endsWithNewline: core.endsWithNewline,
      };
    }
    if (core.kind === "tail_corrupt" && core.lastValidByteOffset === 0) {
      return {
        kind: "invalid",
        lastValidByteOffset: 0,
        diagnostics: [
          { code: "session_header_corrupt", message: "session transcript header is itself truncated", recoverable: false },
        ],
        lineCount: core.lineCount,
        endsWithNewline: core.endsWithNewline,
      };
    }
    return core;
  }

  private static async _readFileSafe(path: string): Promise<Buffer | null> {
    try {
      return await readFile(path);
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Budget accounting
  // --------------------------------------------------------------------------

  private _reservedFor(workspaceId: string, taskId?: string): number {
    let total = 0;
    for (const reservation of this._reservations.values()) {
      if (reservation.workspaceId !== workspaceId) continue;
      if (taskId !== undefined && reservation.taskId !== taskId) continue;
      total += reservation.reservedBytes;
    }
    return total;
  }

  private async _reserveBudgetImpl(workspaceId: string, taskId: string, requestedBytes: number): Promise<TaskBudgetReservation> {
    if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 0) {
      throw new Error(`invalid requestedBytes: ${requestedBytes}`);
    }
    const wsUsed = await this._dirSizeCached(this._workspaceDir(workspaceId), this._wsUsedKey(workspaceId));
    const wsReserved = this._reservedFor(workspaceId);
    if (wsUsed + wsReserved + requestedBytes > this._maxWorkspaceBytes) {
      throw new TaskStorageLimitError(
        `workspace storage budget exceeded: used ${wsUsed} + reserved ${wsReserved} + requested ${requestedBytes} > limit ${this._maxWorkspaceBytes}`,
      );
    }
    const taskUsed = await this._dirSizeCached(this._taskDir(workspaceId, taskId), this._taskUsedKey(workspaceId, taskId));
    const taskReserved = this._reservedFor(workspaceId, taskId);
    if (taskUsed + taskReserved + requestedBytes > this._maxTaskBytes) {
      throw new TaskStorageLimitError(
        `task storage budget exceeded: used ${taskUsed} + reserved ${taskReserved} + requested ${requestedBytes} > limit ${this._maxTaskBytes}`,
      );
    }
    const reservation: TaskBudgetReservation = {
      reservationId: randomUUID(),
      workspaceId,
      taskId,
      reservedBytes: requestedBytes,
    };
    this._reservations.set(reservation.reservationId, reservation);
    return reservation;
  }

  private async _checkWriteBudgetImpl(workspaceId: string, taskId: string, additionalBytes: number): Promise<void> {
    const wsUsed = await this._dirSizeCached(this._workspaceDir(workspaceId), this._wsUsedKey(workspaceId));
    const wsReserved = this._reservedFor(workspaceId);
    if (wsUsed + wsReserved + additionalBytes > this._maxWorkspaceBytes) {
      throw new TaskStorageLimitError(
        `workspace storage budget exceeded: used ${wsUsed} + reserved ${wsReserved} + additional ${additionalBytes} > limit ${this._maxWorkspaceBytes}`,
      );
    }
    const taskUsed = await this._dirSizeCached(this._taskDir(workspaceId, taskId), this._taskUsedKey(workspaceId, taskId));
    const taskReserved = this._reservedFor(workspaceId, taskId);
    if (taskUsed + taskReserved + additionalBytes > this._maxTaskBytes) {
      throw new TaskStorageLimitError(
        `task storage budget exceeded: used ${taskUsed} + reserved ${taskReserved} + additional ${additionalBytes} > limit ${this._maxTaskBytes}`,
      );
    }
  }

  /**
   * Writes consume the task's own reservations first, so the committed figure
   * (used + reserved) stays flat while a task spends the headroom it reserved
   * at creation/queue time.
   */
  private _consumeReservationImpl(workspaceId: string, taskId: string, bytes: number): void {
    let remaining = bytes;
    for (const [id, reservation] of this._reservations) {
      if (reservation.workspaceId !== workspaceId || reservation.taskId !== taskId) continue;
      const take = Math.min(reservation.reservedBytes, remaining);
      reservation.reservedBytes -= take;
      remaining -= take;
      if (reservation.reservedBytes === 0) this._reservations.delete(id);
      if (remaining === 0) break;
    }
  }

  // --------------------------------------------------------------------------
  // Idempotent JSONL tail repair transaction
  // --------------------------------------------------------------------------

  /**
   * Tail repair for events.jsonl / session transcripts. Transaction order:
   * 1) reserve the peak budget (full original for the .bak backup + the valid
   *    prefix for the temp file that coexists with the original until rename);
   *    on storage_limit nothing is modified.
   * 2) preserve the full original bytes as <name>.corrupt-<sha256>.bak in the
   *    same directory (deterministic, immutable, atomic write); an existing
   *    backup is verified by hash and reused idempotently.
   * 3) atomically replace the working file with the valid prefix [0,
   *    lastValidByteOffset), which ends with "\n".
   * A crash between 2 and 3 leaves the backup behind; retrying the same
   * repair reuses it and completes the transaction. Backups are never
   * deleted.
   */
  private async _repairJsonlTailImpl(
    workspaceId: string,
    taskId: string,
    filePath: string,
    fileName: string,
    scan: { kind: "tail_corrupt"; lastValidByteOffset: number },
  ): Promise<JsonlTailRepairResult> {
    const bytes = await readFile(filePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const preservedName = `${fileName}.corrupt-${sha256}.bak`;
    const preservedPath = join(dirname(filePath), preservedName);
    const prefix = bytes.subarray(0, scan.lastValidByteOffset);
    const peakBytes = bytes.byteLength + prefix.byteLength;

    let reservation: TaskBudgetReservation | null = null;
    try {
      reservation = await this._reserveBudgetImpl(workspaceId, taskId, peakBytes);
    } catch (err) {
      if (err instanceof TaskStorageLimitError) {
        return { ok: false, reason: "storage_limit", message: err.message };
      }
      throw err;
    }
    try {
      const existing = await AgentTaskStore._readFileSafe(preservedPath);
      if (existing === null) {
        await AgentTaskStore._atomicWriteBuffer(preservedPath, bytes);
      } else if (createHash("sha256").update(existing).digest("hex") !== sha256) {
        throw new Error(`backup ${preservedName} exists with mismatched content; refusing to modify it`);
      }
      // Atomic replace of the working file with the valid prefix. The rename
      // goes through the same EPERM retry as every other atomic write here
      // (Windows concurrent readers hold the target open briefly).
      const tmp = `${filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, prefix);
        await AgentTaskStore._atomicRenameWithRetry(tmp, filePath);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      return { ok: true, preservedFileName: preservedName };
    } finally {
      this.releaseBudget(reservation.reservationId);
    }
  }

  // --------------------------------------------------------------------------
  // Public API (design plan section 4.7)
  // --------------------------------------------------------------------------

  async listWorkspaces(): Promise<string[]> {
    return this._enqueue(async () => {
      let entries;
      try {
        entries = await readdir(this._rootDir, { withFileTypes: true });
      } catch {
        return [];
      }
      return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort();
    });
  }

  async initWorkspace(workspaceId: string): Promise<void> {
    AgentTaskStore._assertSafeComponent(workspaceId, "workspaceId");
    return this._enqueue(async () => {
      await mkdir(this._workspaceDir(workspaceId), { recursive: true });
    });
  }

  async writeMetadata(workspaceId: string, taskId: string, metadata: TaskMetadata): Promise<void> {
    AgentTaskStore._assertSafeComponent(workspaceId, "workspaceId");
    AgentTaskStore._assertSafeComponent(taskId, "taskId");
    return this._enqueue(() => this._writeMetadataImpl(workspaceId, taskId, metadata));
  }

  private async _writeMetadataImpl(workspaceId: string, taskId: string, metadata: TaskMetadata): Promise<void> {
    if (!isTaskMetadata(metadata)) throw new Error("invalid TaskMetadata");
    if (metadata.spec.taskId !== taskId) throw new Error("metadata spec.taskId does not match taskId");
    if (metadata.spec.workspaceId !== workspaceId) throw new Error("metadata spec.workspaceId does not match workspaceId");
    const taskDir = this._taskDir(workspaceId, taskId);
    await mkdir(taskDir, { recursive: true });
    const path = join(taskDir, "task.json");
    const additional = Buffer.byteLength(JSON.stringify(metadata, null, 2), "utf-8");
    await this._checkWriteBudgetImpl(workspaceId, taskId, additional);
    await AgentTaskStore._atomicWriteJson(path, metadata);
    this._consumeReservationImpl(workspaceId, taskId, additional);
    this._invalidateUsedBytes(workspaceId, taskId);
  }

  /**
   * Appends one event; the store assigns the monotonic seq inside the
   * single-write queue. A tail-corrupt events.jsonl is repaired (backup +
   * atomic prefix replace) before the append; a mid-corrupt log is left
   * untouched and the append is refused.
   */
  async appendEvent(workspaceId: string, taskId: string, event: TaskLogEventPayload): Promise<TaskLogEvent> {
    AgentTaskStore._assertSafeComponent(workspaceId, "workspaceId");
    AgentTaskStore._assertSafeComponent(taskId, "taskId");
    return this._enqueue(() => this._appendEventImpl(workspaceId, taskId, event));
  }

  private async _appendEventImpl(workspaceId: string, taskId: string, event: TaskLogEventPayload): Promise<TaskLogEvent> {
    if (!isTaskLogEventPayload(event)) throw new Error("invalid TaskLogEventPayload");
    const taskDir = this._taskDir(workspaceId, taskId);
    await mkdir(taskDir, { recursive: true });
    const eventsPath = join(taskDir, "events.jsonl");
    const scan = await AgentTaskStore._scanEventsFile(eventsPath);
    if (scan.kind === "invalid") {
      throw new Error(`cannot append to events.jsonl: ${scan.diagnostics.map((d) => d.code).join(", ")} (recovery-corrupt task)`);
    }
    if (scan.kind === "tail_corrupt") {
      const repair = await this._repairJsonlTailImpl(workspaceId, taskId, eventsPath, "events.jsonl", {
        kind: "tail_corrupt",
        lastValidByteOffset: scan.lastValidByteOffset,
      });
      if (!repair.ok) {
        throw new TaskStorageLimitError(repair.message);
      }
    }
    // Defense in depth: the scan above classifies every non-empty valid file
    // as newline-terminated (a parseable no-newline tail is tail_corrupt and
    // repaired above), so this guard is a no-op today. If the on-disk state
    // ever disagrees (external writer, future scan change), a bare append
    // would concatenate onto the last line and turn the log into an
    // unrecoverable mid_log_corrupt on the next scan - normalize first.
    if (scan.kind === "valid" && !scan.endsWithNewline) {
      await appendFile(eventsPath, "\n", "utf-8");
    }
    const seq = scan.lastSeq + 1;
    const full: TaskLogEvent = { ...event, seq, ts: Date.now() };
    const line = `${JSON.stringify(full)}\n`;
    const additional = Buffer.byteLength(line, "utf-8");
    await this._checkWriteBudgetImpl(workspaceId, taskId, additional);
    await appendFile(eventsPath, line, "utf-8");
    this._consumeReservationImpl(workspaceId, taskId, additional);
    this._addUsedBytes(this._wsUsedKey(workspaceId), additional);
    this._addUsedBytes(this._taskUsedKey(workspaceId, taskId), additional);
    return full;
  }

  async writeCheckpoint(workspaceId: string, taskId: string, cp: TaskCheckpoint): Promise<void> {
    AgentTaskStore._assertSafeComponent(workspaceId, "workspaceId");
    AgentTaskStore._assertSafeComponent(taskId, "taskId");
    return this._enqueue(() => this._writeCheckpointImpl(workspaceId, taskId, cp));
  }

  private async _writeCheckpointImpl(workspaceId: string, taskId: string, cp: TaskCheckpoint): Promise<void> {
    if (!isTaskCheckpoint(cp)) throw new Error("invalid TaskCheckpoint");
    if (cp.taskId !== taskId) throw new Error("checkpoint taskId does not match taskId");
    const taskDir = this._taskDir(workspaceId, taskId);
    await mkdir(taskDir, { recursive: true });
    const path = join(taskDir, "checkpoint.json");
    const additional = Buffer.byteLength(JSON.stringify(cp, null, 2), "utf-8");
    await this._checkWriteBudgetImpl(workspaceId, taskId, additional);
    await AgentTaskStore._atomicWriteJson(path, cp);
    this._consumeReservationImpl(workspaceId, taskId, additional);
    this._invalidateUsedBytes(workspaceId, taskId);
  }

  /** Corrupt current generation falls back to the previous known-valid one. */
  async readIndex(workspaceId: string): Promise<TaskIndex | null> {
    AgentTaskStore._assertSafeComponent(workspaceId, "workspaceId");
    return this._enqueue(() => this._readIndexImpl(workspaceId));
  }

  private async _readIndexImpl(workspaceId: string): Promise<TaskIndex | null> {
    const wsDir = this._workspaceDir(workspaceId);
    const current = await AgentTaskStore._readJsonObject(join(wsDir, "index.json"));
    if (isTaskIndex(current)) return current;
    const prev = await AgentTaskStore._readJsonObject(join(wsDir, "index.prev.json"));
    if (isTaskIndex(prev)) return prev;
    return null;
  }

  /** Before replacing the current index, the last known-valid one is preserved as index.prev.json. */
  async writeIndex(workspaceId: string, index: TaskIndex): Promise<void> {
    AgentTaskStore._assertSafeComponent(workspaceId, "workspaceId");
    return this._enqueue(() => this._writeIndexImpl(workspaceId, index));
  }

  private async _writeIndexImpl(workspaceId: string, index: TaskIndex): Promise<void> {
    if (!isTaskIndex(index)) throw new Error("invalid TaskIndex");
    if (index.workspaceId !== workspaceId) throw new Error("index.workspaceId does not match workspaceId");
    const wsDir = this._workspaceDir(workspaceId);
    await mkdir(wsDir, { recursive: true });
    const indexPath = join(wsDir, "index.json");
    const prevPath = join(wsDir, "index.prev.json");
    const current = await AgentTaskStore._readJsonObject(indexPath);
    if (isTaskIndex(current)) {
      await AgentTaskStore._atomicWriteJson(prevPath, current);
    }
    await AgentTaskStore._atomicWriteJson(indexPath, index);
    this._invalidateUsedBytes(workspaceId);
  }

  async readTask(workspaceId: string, taskId: string): Promise<TaskReadResult> {
    AgentTaskStore._assertSafeComponent(workspaceId, "workspaceId");
    AgentTaskStore._assertSafeComponent(taskId, "taskId");
    return this._enqueue(() => this._readTaskImpl(workspaceId, taskId));
  }

  private async _readTaskImpl(workspaceId: string, taskId: string): Promise<TaskReadResult> {
    const taskDir = this._taskDir(workspaceId, taskId);
    const diagnostics: TaskStorageDiagnostic[] = [];

    let metadata: TaskMetadata | null = null;
    const metadataPath = join(taskDir, "task.json");
    const metadataRaw = await AgentTaskStore._readJsonObject(metadataPath);
    if (metadataRaw !== null) {
      const migration = migrateTaskMetadata(metadataRaw);
      if (migration.ok) {
        metadata = migration.metadata;
      } else {
        diagnostics.push({ code: migration.code, message: migration.message, recoverable: false });
      }
    } else if (await AgentTaskStore._fileExists(metadataPath)) {
      // The file exists but cannot even be parsed: the schema version is
      // unknowable, so the record cannot be migrated into a valid shape.
      diagnostics.push({
        code: "migration_failed",
        message: "task.json is unreadable and cannot be migrated to a valid current shape (original file preserved)",
        recoverable: false,
      });
    }

    const eventsScan = await AgentTaskStore._scanEventsFile(join(taskDir, "events.jsonl"));
    diagnostics.push(...eventsScan.diagnostics);

    let checkpoint: TaskCheckpoint | null = null;
    const cpPath = join(taskDir, "checkpoint.json");
    const cpRaw = await AgentTaskStore._readJsonObject(cpPath);
    if (cpRaw !== null) {
      if (isTaskCheckpoint(cpRaw)) {
        checkpoint = cpRaw;
      } else {
        diagnostics.push({
          code: "migration_failed",
          message: "checkpoint.json failed migration to a valid current shape (original file preserved)",
          recoverable: false,
        });
      }
    } else if (await AgentTaskStore._fileExists(cpPath)) {
      diagnostics.push({
        code: "migration_failed",
        message: "checkpoint.json is unreadable (original file preserved)",
        recoverable: false,
      });
    }

    // An unreadable index pair marks the whole workspace's tasks recovery-
    // corrupt; a missing index pair (fresh workspace) is not corruption.
    const wsDir = this._workspaceDir(workspaceId);
    const indexExists =
      (await AgentTaskStore._fileExists(join(wsDir, "index.json"))) ||
      (await AgentTaskStore._fileExists(join(wsDir, "index.prev.json")));
    if (indexExists && (await this._readIndexImpl(workspaceId)) === null) {
      diagnostics.push({
        code: "index_corrupt",
        message: "workspace index.json and index.prev.json are both unreadable; cannot fall back to a known-valid generation",
        recoverable: false,
      });
    }

    return { metadata, events: eventsScan.events, checkpoint, diagnostics };
  }

  /**
   * Reserves byte budget ahead of queueing a task (PRD C5). The reservation
   * is in-memory admission control on top of the real disk usage; the hard
   * limits are still enforced on every write.
   */
  async reserveBudget(workspaceId: string, taskId: string, requestedBytes: number): Promise<TaskBudgetReservation> {
    AgentTaskStore._assertSafeComponent(workspaceId, "workspaceId");
    AgentTaskStore._assertSafeComponent(taskId, "taskId");
    return this._enqueue(() => this._reserveBudgetImpl(workspaceId, taskId, requestedBytes));
  }

  releaseBudget(reservationId: string): void {
    this._reservations.delete(reservationId);
  }

  async writeCloseMarker(workspaceId: string, marker: AgentTaskCloseMarker): Promise<void> {
    AgentTaskStore._assertSafeComponent(workspaceId, "workspaceId");
    return this._enqueue(() => this._writeCloseMarkerImpl(workspaceId, marker));
  }

  private async _writeCloseMarkerImpl(workspaceId: string, marker: AgentTaskCloseMarker): Promise<void> {
    if (!isAgentTaskCloseMarker(marker)) throw new Error("invalid AgentTaskCloseMarker");
    const wsDir = this._workspaceDir(workspaceId);
    await mkdir(wsDir, { recursive: true });
    await AgentTaskStore._atomicWriteJson(join(wsDir, "close-marker.json"), marker);
  }

  /**
   * Consumes the workspace close marker: matching runId -> "clean"; missing
   * marker -> "crash"; non-matching or unreadable marker -> "stale_marker".
   * The marker file is removed in every case except "crash" so a stale marker
   * can never leak into a later run's diagnosis.
   */
  async consumeCloseMarker(workspaceId: string, expectedRunId: string): Promise<CloseDiagnosis> {
    AgentTaskStore._assertSafeComponent(workspaceId, "workspaceId");
    return this._enqueue(async () => {
      const markerPath = join(this._workspaceDir(workspaceId), "close-marker.json");
      const raw = await AgentTaskStore._readJsonObject(markerPath);
      if (raw === null) {
        if (await AgentTaskStore._fileExists(markerPath)) {
          // A marker file exists but cannot be read: it is unusable for
          // diagnosis, so remove it and report stale.
          await rm(markerPath, { force: true });
          return { kind: "stale_marker" };
        }
        return { kind: "crash" };
      }
      const marker = isAgentTaskCloseMarker(raw) ? (raw as AgentTaskCloseMarker) : null;
      await rm(markerPath, { force: true });
      if (marker === null) return { kind: "stale_marker" };
      if (marker.runId === expectedRunId) return { kind: "clean", marker };
      return { kind: "stale_marker", marker };
    });
  }

  async deleteTask(workspaceId: string, taskId: string): Promise<void> {
    AgentTaskStore._assertSafeComponent(workspaceId, "workspaceId");
    AgentTaskStore._assertSafeComponent(taskId, "taskId");
    return this._enqueue(async () => {
      await rm(this._taskDir(workspaceId, taskId), { recursive: true, force: true });
      this._invalidateUsedBytes(workspaceId, taskId);
      // Drop the deleted task's reservations; its usage is gone with the files.
      for (const [id, reservation] of this._reservations) {
        if (reservation.workspaceId === workspaceId && reservation.taskId === taskId) {
          this._reservations.delete(id);
        }
      }
    });
  }

  /**
   * Remove one taskId from the workspace index (1.4.2 clear paths). Reads the
   * current generation (index.json, falling back to index.prev.json like
   * readIndex), filters the task out and rewrites it through the same atomic
   * write + previous-generation-preservation path as writeIndex, so the
   * single-write queue and the index.prev fallback semantics stay intact.
   * Returns the new generation, or undefined when the index pair is unreadable
   * or the task is not listed (nothing was written - a later full index write
   * still repairs the workspace).
   */
  async removeFromIndex(workspaceId: string, taskId: string, lastWriterRunId?: string): Promise<number | undefined> {
    AgentTaskStore._assertSafeComponent(workspaceId, "workspaceId");
    AgentTaskStore._assertSafeComponent(taskId, "taskId");
    return this._enqueue(async () => {
      const wsDir = this._workspaceDir(workspaceId);
      const current = await AgentTaskStore._readJsonObject(join(wsDir, "index.json"));
      const prev = await AgentTaskStore._readJsonObject(join(wsDir, "index.prev.json"));
      const base = isTaskIndex(current) ? current : isTaskIndex(prev) ? prev : null;
      if (base === null || !base.tasks.some((entry) => entry.taskId === taskId)) {
        return undefined;
      }
      const next: TaskIndex = {
        schemaVersion: base.schemaVersion,
        workspaceId,
        generation: base.generation + 1,
        lastWriterRunId: lastWriterRunId ?? base.lastWriterRunId,
        tasks: base.tasks.filter((entry) => entry.taskId !== taskId),
      };
      await this._writeIndexImpl(workspaceId, next);
      return next.generation;
    });
  }

  async getWorkspaceUsage(workspaceId: string): Promise<{ usedBytes: number; reservedBytes: number; limitBytes: number }> {
    AgentTaskStore._assertSafeComponent(workspaceId, "workspaceId");
    return this._enqueue(async () => {
      const usedBytes = await this._dirSizeCached(this._workspaceDir(workspaceId), this._wsUsedKey(workspaceId));
      const reservedBytes = this._reservedFor(workspaceId);
      return { usedBytes, reservedBytes, limitBytes: this._maxWorkspaceBytes };
    });
  }

  getTaskSessionDir(workspaceId: string, taskId: string): string {
    AgentTaskStore._assertSafeComponent(workspaceId, "workspaceId");
    AgentTaskStore._assertSafeComponent(taskId, "taskId");
    return join(this._rootDir, workspaceId, taskId, "sessions");
  }

  /** Strict line-by-line/header inspection; never modifies the original file. */
  async inspectSessionTranscript(workspaceId: string, taskId: string, sessionFileName: string): Promise<SessionTranscriptInspection> {
    const sessionPath = this._sessionTranscriptPath(workspaceId, taskId, sessionFileName);
    return this._enqueue(async () => {
      const buffer = await AgentTaskStore._readFileSafe(sessionPath);
      if (buffer === null) {
        return {
          kind: "invalid",
          lastValidByteOffset: 0,
          diagnostics: [
            { code: "session_header_corrupt", message: `session transcript file is missing: ${sessionFileName}`, recoverable: false },
          ],
        };
      }
      const scan = AgentTaskStore._scanSessionBuffer(buffer);
      return { kind: scan.kind, lastValidByteOffset: scan.lastValidByteOffset, diagnostics: scan.diagnostics };
    });
  }

  /**
   * Repairs a tail-corrupt session transcript: preserves the full original as
   * a hash-named .bak, then atomically replaces the working file with the
   * valid prefix. Only a tail_corrupt inspection is accepted; the inspection
   * is re-validated against the current file, so retrying the transaction at
   * any point is idempotent. On storage_limit nothing is modified.
   */
  async repairSessionTranscriptTail(
    workspaceId: string,
    taskId: string,
    sessionFileName: string,
    inspection: SessionTranscriptInspection,
  ): Promise<{ ok: true; preservedFileName: string } | { ok: false; reason: "storage_limit" | "stale_inspection"; message: string }> {
    const sessionPath = this._sessionTranscriptPath(workspaceId, taskId, sessionFileName);
    return this._enqueue(async () => {
      if (inspection.kind !== "tail_corrupt") {
        return { ok: false, reason: "stale_inspection", message: "repairSessionTranscriptTail only accepts a tail_corrupt inspection" };
      }
      const buffer = await AgentTaskStore._readFileSafe(sessionPath);
      if (buffer === null) {
        return { ok: false, reason: "stale_inspection", message: `session transcript file is missing: ${sessionFileName}` };
      }
      const current = AgentTaskStore._scanSessionBuffer(buffer);
      if (current.kind !== "tail_corrupt" || current.lastValidByteOffset !== inspection.lastValidByteOffset) {
        return { ok: false, reason: "stale_inspection", message: "session transcript changed since the inspection was taken" };
      }
      return this._repairJsonlTailImpl(workspaceId, taskId, sessionPath, sessionFileName, {
        kind: "tail_corrupt",
        lastValidByteOffset: current.lastValidByteOffset,
      });
    });
  }
}

