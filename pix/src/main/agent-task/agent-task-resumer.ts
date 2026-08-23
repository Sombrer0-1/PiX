/**
 * AgentTaskResumer - safe resume preparation for interrupted agent tasks
 * (design plan §4.8, 1.4.2 R3).
 *
 * The resumer owns everything that must happen BEFORE the service may put an
 * interrupted task back into the queue:
 *   ① workspace fingerprint comparison - changes must be explicitly confirmed;
 *   ② a strict scan of the task session transcript (header/tail/mid-log)
 *      BEFORE any read/write; a tail-corrupt final line is repaired inside the
 *      service's budget reservation (full hash-named backup + atomic prefix
 *      replace) and a warning is surfaced, while an invalid header or a bad
 *      middle line rejects the resume as a recovery issue (read-only isolation).
 *      SessionManager.open's silent line-skip / empty-array behavior is never
 *      used as a corruption detector.
 *   ③ branch-truth closure: only assistant tool calls with NO ToolResult on
 *      the selected branch get exactly one compliant non-success
 *      interrupted_unknown ToolResult; calls closed by a success/failure/
 *      "Operation aborted" ToolResult and empty stopReason="aborted" assistant
 *      markers are never touched; checkpoint.openToolCalls is cross-diagnostic
 *      only; repeated prepare is idempotent (the closure entries are keyed by
 *      toolCallId and the recovery note carries the task generation).
 *   ④ one visible interruption CustomMessageEntry (the injectNote) is appended
 *      per interruption, tagged with the current generation;
 *   ⑤ priorResults are folded from the validated events log (strictly
 *      increasing item indexes, no gaps, length === activeItemIndex);
 *      continue inherits the most recently persisted itemSummary model, a
 *      switch_model decision is validated against the task's own registry;
 *   ⑥ the runtime's prepareResume loads the repaired idle session; the returned
 *      checkpoint is persisted with the OLD task generation BEFORE prepare
 *      returns (no double closure on retry), and the service then schedules
 *      generation+1 queued state -> checkpoint -> index.
 *
 * The checkpoint persisted here references the repaired/created transcript so
 * a crash between this write and the service's generation+1 writes restores as
 * interrupted with the pre-resume generation (the one-generation-lag rule of
 * §4.7). activeItemIndex === items.length rejects the resume and requires the
 * service to converge the terminal state (mark_failed). Unanswered input
 * requests in the log are settled as cancelled, idempotently. The frozen spec
 * is never rewritten.
 *
 * Main-only module: ResumeDecision / AgentTaskResumeSummary come from the
 * shared leaf; this module only consumes them.
 */

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { basename, join, posix as pathPosix } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  createProjectExecutionContext,
  disposeProjectExecutionContext,
  type ProjectExecutionContext,
} from "../execution-context.js";
import type {
  AgentTaskInfo,
  AgentTaskItemSpec,
  AgentTaskModelSnapshot,
  AgentTaskSpec,
  ResumeDecision,
} from "../../shared/agent-task-types.js";
import type { SubagentSingleResult } from "../../shared/subagent-types.js";
import type { ProjectLocation } from "../../shared/project-location.js";
import type { AgentTaskRuntime, AgentTaskRuntimeResumeSeed } from "./agent-task-runtime.js";
import {
  AgentTaskStore,
  TaskStorageLimitError,
  type TaskCheckpoint,
  type TaskLogEvent,
  type WorkspaceFingerprint,
} from "./agent-task-store.js";

/** Custom-type tag of the visible recovery-note CustomMessageEntry. */
export const RESUME_NOTE_CUSTOM_TYPE = "pix-task-resume";
/** Error text of the compliant non-success ToolResult appended per truly open call. */
export const RESUME_INTERRUPTED_TOOL_RESULT_TEXT =
  "interrupted_unknown - the tool call was interrupted before any result was produced; its outcome is unknown and must not be assumed.";
/** Fixed hash for workspace files that are missing at fingerprint time (mirrors the runtime). */
const FINGERPRINT_MISSING_SENTINEL = "PIX-MISSING";
const GIT_DIRTY_SUMMARY_MAX_CHARS = 8192;
const GIT_HOST_TIMEOUT_MS = 5000;
const FINGERPRINT_BASH_TIMEOUT_SECONDS = 30;
const HEAD_SHA_RE = /^[0-9a-f]{40}$/;

/** Why prepareResume failed (stable reason codes, surfaced as envelope codes). */
const RUNTIME_REASON_CODES = new Set(["model_not_found", "model_auth_unavailable", "invalid_checkpoint"]);

export interface PreparedAgentTaskResume {
  taskId: string;
  generation: number; // task 当前 generation + 1
  activeItemIndex: number;
  effectiveModel: AgentTaskModelSnapshot; // service 在 queued state event 中同步写入对应 itemSummary
  checkpoint: TaskCheckpoint; // 已由 resumer 以旧 generation 持久化；service 入队时复制为 generation+1 再写
  runtime: AgentTaskRuntime; // 已 prepare、尚未占槽/触发模型；仅 main 内部传递
}

interface BranchAnalysis {
  openToolCalls: Array<{ toolCallId: string; toolName: string; startedAt: number }>;
  lastFinalizedEntryId: string | undefined;
  /** The recovery note of THIS interruption (customType + generation match). */
  noteAppended: boolean;
}

/** POSIX single-quote escaping for shell embedding (safe for arbitrary paths). */
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Bounded child-process exec for the host git fingerprint read. */
function runExecFile(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const child = execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise(stdout);
    });
    void child;
  });
}

/** Structural view of the assistant/tool-result message fields the resumer needs. */
interface BranchMessageLike {
  role?: string;
  content?: Array<{ type?: string; id?: string; name?: string; [key: string]: unknown }>;
  toolCallId?: string;
}

/**
 * Walk the selected branch (root -> leaf) and classify tool calls by the real
 * entries: every assistant tool use WITHOUT any ToolResult on the branch is
 * open (the empty stopReason="aborted" assistant marker contributes no calls);
 * any ToolResult - success, failure or "Operation aborted" - closes its call.
 * This is the branch truth; checkpoint.openToolCalls is never consulted here.
 */
function analyzeBranch(entries: SessionEntry[], generation: number): BranchAnalysis {
  const open = new Map<string, { toolCallId: string; toolName: string; startedAt: number }>();
  let lastFinalizedEntryId: string | undefined;
  let noteAppended = false;
  for (const entry of entries) {
    if (entry.type === "custom_message") {
      const details = entry.details as { generation?: number } | undefined;
      if (entry.customType === RESUME_NOTE_CUSTOM_TYPE && details?.generation === generation) {
        noteAppended = true;
      }
      continue;
    }
    if (entry.type !== "message") {
      continue;
    }
    const message = entry.message as unknown as BranchMessageLike;
    if (message.role === "assistant") {
      lastFinalizedEntryId = entry.id;
      for (const block of message.content ?? []) {
        if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
          open.set(block.id, { toolCallId: block.id, toolName: block.name, startedAt: new Date(entry.timestamp).getTime() });
        }
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      open.delete(message.toolCallId);
    }
  }
  return {
    openToolCalls: [...open.values()],
    lastFinalizedEntryId,
    noteAppended,
  };
}

/** One compliant non-success ToolResult closing a truly open call. */
function makeInterruptedToolResult(toolCallId: string, toolName: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: RESUME_INTERRUPTED_TOOL_RESULT_TEXT }],
    isError: true,
    timestamp: Date.now(),
  };
}

/** Bounded recovery note written as a visible CustomMessageEntry (the injectNote). */
function buildInjectNote(task: AgentTaskInfo, item: AgentTaskItemSpec, itemIndex: number, itemCount: number): string {
  const taskLabel = task.description !== "" ? task.description : task.taskId;
  return [
    `Recovery note for interrupted agent task "${taskLabel}".`,
    `Resuming step ${itemIndex + 1} of ${itemCount}: ${item.description}.`,
    "The previous run was interrupted mid-execution. Tool calls that never produced a result were closed with an interrupted_unknown error result; their outcome is unknown. Verify the current workspace state before acting and do not assume any interrupted call completed.",
  ].join("\n");
}

// ============================================================================
// Execution-context factories (internal test injection, mirrors the runtime)
// ============================================================================

type CreateContextFn = (location: ProjectLocation) => Promise<ProjectExecutionContext>;
type DisposeContextFn = (context: ProjectExecutionContext | null) => Promise<void>;

let createContextImpl: CreateContextFn = createProjectExecutionContext;
let disposeContextImpl: DisposeContextFn = disposeProjectExecutionContext;

/**
 * Internal injection point for tests: swaps the resumer's execution-context
 * factories (workspace fingerprint reads / environment checks) so tests can
 * assert resume decisions without a real backend. Not part of the public
 * contract; omitted in production. Returns a restore function.
 */
export function __setAgentTaskResumerContextFactoriesForTests(
  create: CreateContextFn,
  dispose: DisposeContextFn,
): () => void {
  const prevCreate = createContextImpl;
  const prevDispose = disposeContextImpl;
  createContextImpl = create;
  disposeContextImpl = dispose;
  return () => {
    createContextImpl = prevCreate;
    disposeContextImpl = prevDispose;
  };
}

export class AgentTaskResumer {
  private readonly _store: AgentTaskStore;
  private readonly _runtimeFactory: (spec: AgentTaskSpec, taskSessionDir: string) => AgentTaskRuntime;

  constructor(opts: { store: AgentTaskStore; runtimeFactory: (spec: AgentTaskSpec, taskSessionDir: string) => AgentTaskRuntime }) {
    this._store = opts.store;
    this._runtimeFactory = opts.runtimeFactory;
  }

  /**
   * Authoritative resume preparation (design plan §4.8). On success the
   * checkpoint (old generation) is already persisted; the runtime is prepared
   * but occupies no slot and triggered no model turn. On failure nothing is
   * modified beyond idempotent closure entries / input settlements and the
   * task stays interrupted.
   */
  async prepare(
    task: AgentTaskInfo,
    checkpoint: TaskCheckpoint,
    decision: ResumeDecision,
  ): Promise<{ ok: true; prepared: PreparedAgentTaskResume } | { ok: false; reason: string }> {
    // --- ① structural validation -------------------------------------------
    if (!Number.isInteger(checkpoint.activeItemIndex) || checkpoint.activeItemIndex < 0) {
      return { ok: false, reason: "invalid_checkpoint" };
    }
    const read = await this._store.readTask(task.workspaceId, task.taskId);
    const spec = read.metadata?.spec;
    if (!spec) {
      return { ok: false, reason: "record_unreadable" };
    }
    if (checkpoint.activeItemIndex > spec.items.length) {
      return { ok: false, reason: "invalid_checkpoint" };
    }
    if (checkpoint.activeItemIndex === spec.items.length) {
      // Every item already finished; the task must converge to a terminal
      // state instead of starting a new round.
      return { ok: false, reason: "task_completed" };
    }
    const item = spec.items[checkpoint.activeItemIndex];
    if (item.resolution !== "ready") {
      return { ok: false, reason: "task_not_runnable" };
    }
    if (checkpoint.sessionFileName === null) {
      if (checkpoint.sessionLeafId !== null || checkpoint.openToolCalls.length > 0) {
        return { ok: false, reason: "invalid_checkpoint" };
      }
    }

    // --- ③ priorResults folded from the validated events log ---------------
    const priorResults = this._foldPriorResults(read.events, checkpoint.activeItemIndex);
    if (priorResults === null) {
      return { ok: false, reason: "invalid_results" };
    }

    // --- ① workspace environment + fingerprint comparison -------------------
    let context: ProjectExecutionContext | null = null;
    try {
      try {
        context = await createContextImpl(task.project);
      } catch {
        return { ok: false, reason: "workspace_unavailable" };
      }
      if (!context.isWsl && !existsSync(context.physicalCwd)) {
        return { ok: false, reason: "workspace_unavailable" };
      }
      const changes = await this._compareFingerprint(context, checkpoint.workspaceFingerprint);
      if (changes.length > 0 && decision.confirmWorkspaceChanges !== true) {
        return { ok: false, reason: "workspace_changed" };
      }
    } catch (error) {
      // WSL fingerprint reads can fail mid-comparison (bash timeout / distro
      // crash, git read failure): normalize to the {ok:false;reason} contract
      // with a structured diagnosis instead of leaking the raw internal error
      // through the resume path (plan §5.6: unavailable workspace refuses the
      // resume with an actionable diagnosis).
      console.warn(`[AgentTaskResumer] prepare: workspace fingerprint comparison failed for task ${task.taskId}:`, error);
      return { ok: false, reason: "workspace_unavailable" };
    } finally {
      if (context !== null) {
        await disposeContextImpl(context).catch(() => {});
      }
    }

    // --- ②③④ strict scan + repair + idempotent closure + visible note ------
    // The service reserved budget before calling prepare, so a repair that
    // cannot fit its peak (backup + prefix) fails here without touching any
    // original file. SessionManager.open only ever runs after the strict scan
    // blessed the file (its silent line-skip is never used as a corruption
    // detector). Between items (sessionFileName null) the next item's session
    // does not exist yet: create it (header + note, flushed through
    // SessionManager.open) so the prepared checkpoint always references an
    // existing file.
    let lastSeq = read.events.length > 0 ? read.events[read.events.length - 1].seq : 0;
    let sessionFileName: string | null = checkpoint.sessionFileName;
    let sessionLeafId: string | null = checkpoint.sessionLeafId;
    let lastFinalizedEntryId: string | undefined = checkpoint.lastFinalizedEntryId;
    let manager: SessionManager;
    /** Absolute path of the session file just created for the next item (null otherwise). */
    let createdSessionPath: string | null = null;

    if (checkpoint.sessionFileName !== null) {
      if (!this._isSessionBasename(checkpoint.sessionFileName)) {
        return { ok: false, reason: "invalid_checkpoint" };
      }
      const inspection = await this._store.inspectSessionTranscript(task.workspaceId, task.taskId, checkpoint.sessionFileName);
      if (inspection.kind === "invalid") {
        const code = inspection.diagnostics[0]?.code === "mid_log_corrupt" ? "mid_log_corrupt" : "session_header_corrupt";
        return { ok: false, reason: code };
      }
      if (inspection.kind === "tail_corrupt") {
        let repair: { ok: true; preservedFileName: string } | { ok: false; reason: "storage_limit" | "stale_inspection"; message: string };
        try {
          repair = await this._store.repairSessionTranscriptTail(task.workspaceId, task.taskId, checkpoint.sessionFileName, inspection);
        } catch (error) {
          return { ok: false, reason: this._prepareFailureReason(error) };
        }
        if (!repair.ok) {
          return { ok: false, reason: repair.reason === "storage_limit" ? "storage_limit" : "stale_inspection" };
        }
      }
      try {
        manager = this._openSession(task, checkpoint.sessionFileName);
      } catch (error) {
        return { ok: false, reason: this._prepareFailureReason(error) };
      }
      // ② leaf verification: the checkpoint leaf must exist in the opened
      // transcript (a tail repair only drops the truncated final line, never a
      // checkpointed leaf).
      if (checkpoint.sessionLeafId !== null && manager.getEntry(checkpoint.sessionLeafId) === undefined) {
        return { ok: false, reason: "invalid_checkpoint" };
      }
      const analysis = analyzeBranch(manager.getBranch(), task.generation);
      // ③④ idempotent: a truly open call gets exactly one interrupted_unknown
      // ToolResult; calls already closed by any ToolResult and the empty
      // aborted assistant marker are never touched. The recovery note carries
      // the current generation, so a retried prepare never double-appends.
      if (!analysis.noteAppended) {
        for (const open of analysis.openToolCalls) {
          manager.appendMessage(makeInterruptedToolResult(open.toolCallId, open.toolName));
        }
        manager.appendCustomMessageEntry(
          RESUME_NOTE_CUSTOM_TYPE,
          buildInjectNote(task, item, checkpoint.activeItemIndex, spec.items.length),
          true,
          { generation: task.generation },
        );
      }
      sessionLeafId = manager.getLeafId();
      lastFinalizedEntryId = analysis.lastFinalizedEntryId ?? lastFinalizedEntryId;
    } else {
      let created: { manager: SessionManager; fileName: string; leafId: string; path: string };
      try {
        created = this._createSessionForNextItem(task, checkpoint.activeItemIndex, item);
      } catch (error) {
        return { ok: false, reason: this._prepareFailureReason(error) };
      }
      manager = created.manager;
      sessionFileName = created.fileName;
      sessionLeafId = created.leafId;
      createdSessionPath = created.path;
    }

    // A session created for the next item is only referenced by the checkpoint
    // persisted at the end of prepare: any failure between the creation and
    // that write (appendEvent persist error, switch_model rejection,
    // prepareResume failure, writeCheckpoint failure) would otherwise leave the
    // file as a permanent orphan - never checkpoint-referenced, never GC'd,
    // counting into the workspace usage. Remove it on every non-success exit;
    // only the process-kill window between the creation and the checkpoint
    // write cannot be closed inside the process.
    let preparedOk = false;
    try {
      // --- ⑥ unanswered input requests settle as cancelled, idempotently -----
      for (const requestId of this._unsettledInputRequestIds(read.events)) {
        const written = await this._store.appendEvent(task.workspaceId, task.taskId, {
          type: "input_settled",
          requestId,
          generation: task.generation,
          outcome: "cancelled",
        });
        lastSeq = written.seq;
      }

      // --- ⑤ effective model --------------------------------------------------
      let effectiveModel: AgentTaskModelSnapshot;
      if (decision.action === "switch_model") {
        const validated = this._validateModelChoice(spec, decision.provider, decision.modelId);
        if (validated !== null) {
          return { ok: false, reason: validated };
        }
        effectiveModel = { provider: decision.provider, modelId: decision.modelId };
      } else {
        effectiveModel = task.itemSummaries[checkpoint.activeItemIndex]?.model ?? {
          provider: item.model.provider,
          modelId: item.model.modelId,
        };
      }

      // --- ⑥ runtime.prepareResume (opens the repaired/created idle session) --
      const taskSessionDir = this._store.getTaskSessionDir(task.workspaceId, task.taskId);
      let runtime: AgentTaskRuntime;
      try {
        runtime = this._runtimeFactory(spec, taskSessionDir);
      } catch {
        return { ok: false, reason: "internal_error" };
      }
      const seed: AgentTaskRuntimeResumeSeed = {
        checkpoint: {
          ...checkpoint,
          generation: task.generation, // normalized pre-resume generation (one-behind compensation)
          sessionFileName,
          sessionLeafId,
          lastFinalizedEntryId,
        },
        decision,
        effectiveModel,
        injectNote: buildInjectNote(task, item, checkpoint.activeItemIndex, spec.items.length),
        priorResults,
      };
      let preparedCheckpoint: TaskCheckpoint;
      try {
        preparedCheckpoint = await runtime.prepareResume(seed);
      } catch (error) {
        await runtime.dispose().catch(() => {});
        const message = error instanceof Error ? error.message : "";
        const reason = RUNTIME_REASON_CODES.has(message) ? message : "session_start_failed";
        return { ok: false, reason };
      }

      // --- ⑦ persist the repaired checkpoint (old generation) BEFORE returning
      // (a crash after this write restores as interrupted at the same
      // generation; the next prepare is idempotent).
      const stamped: TaskCheckpoint = {
        ...preparedCheckpoint,
        generation: task.generation,
        seq: lastSeq,
        ts: Date.now(),
      };
      try {
        await this._store.writeCheckpoint(task.workspaceId, task.taskId, stamped);
      } catch (error) {
        await runtime.dispose().catch(() => {});
        return { ok: false, reason: error instanceof TaskStorageLimitError ? "storage_limit" : "internal_error" };
      }

      preparedOk = true;
      return {
        ok: true,
        prepared: {
          taskId: task.taskId,
          generation: task.generation + 1,
          activeItemIndex: checkpoint.activeItemIndex,
          effectiveModel,
          checkpoint: stamped,
          runtime,
        },
      };
    } catch (error) {
      // 1.4.2 (R3): every unexpected failure (appendEvent storage/repair
      // failures, fs errors) normalizes to the {ok:false;reason} contract of
      // §4.8 instead of leaking through the service's resume path. The task
      // stays interrupted; the finally below removes a created next-item
      // session file that is not yet checkpoint-referenced.
      return { ok: false, reason: this._prepareFailureReason(error) };
    } finally {
      if (!preparedOk && createdSessionPath !== null) {
        await rm(createdSessionPath, { force: true }).catch(() => {});
      }
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  /**
   * Normalize an unexpected prepare failure into the stable §4.8 reason
   * codes: TaskStorageLimitError (repair peak over budget) and budget
   * messages map to "storage_limit", a mid-log-corrupt append refusal maps to
   * "mid_log_corrupt" (read-only isolation), everything else (fs errors while
   * opening/creating the session) to "internal_error".
   */
  private _prepareFailureReason(error: unknown): string {
    if (error instanceof TaskStorageLimitError) {
      return "storage_limit";
    }
    const message = error instanceof Error ? error.message : "";
    if (message.includes("mid_log_corrupt")) {
      return "mid_log_corrupt";
    }
    if (message.includes("storage") || message.includes("budget")) {
      return "storage_limit";
    }
    return "internal_error";
  }

  /** Session file names must be plain basenames inside <task>/sessions/. */
  private _isSessionBasename(fileName: string): boolean {
    return fileName !== "" && fileName !== "." && fileName !== ".." && !fileName.includes("/") && !fileName.includes("\\") && !fileName.includes("\0");
  }

  /** SessionManager.open over the task sessions dir (strict scan already blessed the file). */
  private _openSession(task: AgentTaskInfo, sessionFileName: string): SessionManager {
    const taskSessionDir = this._store.getTaskSessionDir(task.workspaceId, task.taskId);
    return SessionManager.open(join(taskSessionDir, sessionFileName), taskSessionDir, task.project.physicalPath);
  }

  /**
   * Create the next item's idle session file for a between-items checkpoint:
   * writes the header, opens it (flushed), appends the recovery note and
   * returns the manager + file name + leaf id + absolute path. SessionManager's
   * own entries are used for every append - the session is never
   * hand-assembled. A failure while opening/appending removes the just-created
   * file (it is referenced by nothing yet), so no orphan session survives.
   */
  private _createSessionForNextItem(
    task: AgentTaskInfo,
    itemIndex: number,
    item: AgentTaskItemSpec,
  ): { manager: SessionManager; fileName: string; leafId: string; path: string } {
    const taskSessionDir = this._store.getTaskSessionDir(task.workspaceId, task.taskId);
    mkdirSync(taskSessionDir, { recursive: true });
    const sessionId = randomUUID();
    const timestamp = new Date().toISOString();
    const fileName = `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
    const path = join(taskSessionDir, fileName);
    // Header + flush via open() so every append lands on disk immediately (a
    // SessionManager.create-only session defers the file until the first
    // assistant message, which would leave the checkpoint referencing a file
    // that does not exist yet).
    writeFileSync(
      path,
      `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd: task.project.physicalPath })}\n`,
      "utf-8",
    );
    try {
      const manager = SessionManager.open(path, taskSessionDir, task.project.physicalPath);
      const noteEntryId = manager.appendCustomMessageEntry(
        RESUME_NOTE_CUSTOM_TYPE,
        buildInjectNote(task, item, itemIndex, task.itemSummaries.length),
        true,
        { generation: task.generation },
      );
      return { manager, fileName, leafId: noteEntryId, path };
    } catch (error) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Best-effort removal must not mask the original failure.
      }
      throw error;
    }
  }

  /** Strictly increasing, gap-free item results with length === activeItemIndex. */
  private _foldPriorResults(events: TaskLogEvent[], activeItemIndex: number): SubagentSingleResult[] | null {
    const results: SubagentSingleResult[] = [];
    for (const event of events) {
      if (event.type === "item_result") {
        results.push(event.result);
      }
    }
    if (results.length > activeItemIndex) {
      results.length = activeItemIndex;
    }
    for (let i = 0; i < results.length; i++) {
      if (results[i].index !== i) {
        return null;
      }
    }
    if (results.length !== activeItemIndex) {
      return null;
    }
    return results;
  }

  /** input_requested events without a later input_settled for the same requestId. */
  private _unsettledInputRequestIds(events: TaskLogEvent[]): string[] {
    const requested = new Map<string, boolean>();
    for (const event of events) {
      if (event.type === "input_requested") {
        requested.set(event.request.requestId, false);
      } else if (event.type === "input_settled") {
        requested.set(event.requestId, true);
      }
    }
    return [...requested.entries()].filter(([, settled]) => !settled).map(([requestId]) => requestId);
  }

  /** Validate a switch_model choice against the task's own registry (mirrors the runtime). */
  private _validateModelChoice(spec: AgentTaskSpec, provider: string, modelId: string): string | null {
    let authStorage;
    let registry;
    try {
      authStorage = AuthStorage.create(join(spec.agentDir, "auth.json"));
      registry = ModelRegistry.create(authStorage, join(spec.agentDir, "models.json"));
    } catch {
      return "internal_error";
    }
    const model = registry.find(provider, modelId);
    if (!model) {
      return "model_not_found";
    }
    if (!registry.hasConfiguredAuth(model)) {
      return "model_auth_unavailable";
    }
    return null;
  }

  /** Workspace-relative paths whose current hash / git state differs from the checkpoint. */
  private async _compareFingerprint(context: ProjectExecutionContext, expected: WorkspaceFingerprint): Promise<string[]> {
    const changes: string[] = [];
    const relPaths = Object.keys(expected.observedFileHashes);
    if (relPaths.length > 0) {
      const current = await this._readCurrentHashes(context, relPaths);
      for (const rel of relPaths) {
        if (current.get(rel) !== expected.observedFileHashes[rel]) {
          changes.push(rel);
        }
      }
    }
    if (expected.isGit) {
      const git = await this._readGitState(context);
      if (expected.head !== undefined && git.head !== expected.head) {
        changes.push("git:head");
      }
      if (expected.dirtySummary !== undefined && git.dirtySummary !== expected.dirtySummary) {
        changes.push("git:working-tree");
      }
    }
    return changes;
  }

  /** sha256 (or the missing sentinel) of every observed path, backend-aware. */
  private async _readCurrentHashes(context: ProjectExecutionContext, relPaths: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (context.isWsl && context.executionBackend?.bash) {
      const quoted = relPaths.map((rel) => shellSingleQuote(pathPosix.join(context.logicalCwd, rel))).join(" ");
      const script = `for p in ${quoted}; do if [ -f "$p" ]; then sha256sum "$p"; else printf 'PIX_MISS %s\\n' "$p"; fi; done`;
      let output = "";
      await context.executionBackend.bash.exec(script, context.logicalCwd, {
        onData: (data: Buffer) => {
          output += data.toString("utf-8");
        },
        timeout: FINGERPRINT_BASH_TIMEOUT_SECONDS,
      });
      const absToRel = new Map(relPaths.map((rel) => [pathPosix.join(context.logicalCwd, rel), rel]));
      for (const line of output.split("\n")) {
        const trimmed = line.trimEnd();
        if (trimmed === "") continue;
        const hashMatch = /^([0-9a-f]{64}) {2}(.+)$/.exec(trimmed);
        const missMatch = /^PIX_MISS (.+)$/.exec(trimmed);
        const abs = hashMatch ? hashMatch[2] : missMatch ? missMatch[1] : undefined;
        if (abs !== undefined) {
          const rel = absToRel.get(abs);
          if (rel !== undefined) {
            out.set(rel, hashMatch ? hashMatch[1] : FINGERPRINT_MISSING_SENTINEL);
          }
        }
      }
      return out;
    }
    for (const rel of relPaths) {
      out.set(rel, await this._hashHostFile(join(context.logicalCwd, rel)));
    }
    return out;
  }

  private async _hashHostFile(absolutePath: string): Promise<string> {
    try {
      const data = await readFile(absolutePath);
      return createHash("sha256").update(data).digest("hex");
    } catch {
      return FINGERPRINT_MISSING_SENTINEL;
    }
  }

  /** Best-effort git state; a missing/broken git binary yields no git fingerprint. */
  private async _readGitState(context: ProjectExecutionContext): Promise<{ head?: string; dirtySummary?: string }> {
    if (context.isWsl && context.executionBackend?.bash) {
      const quotedCwd = shellSingleQuote(context.logicalCwd);
      const script = `git -C ${quotedCwd} rev-parse HEAD 2>/dev/null; printf '\\nPIX_GIT\\n'; git -C ${quotedCwd} status --porcelain 2>/dev/null | head -c ${GIT_DIRTY_SUMMARY_MAX_CHARS}`;
      let output = "";
      await context.executionBackend.bash.exec(script, context.logicalCwd, {
        onData: (data: Buffer) => {
          output += data.toString("utf-8");
        },
        timeout: FINGERPRINT_BASH_TIMEOUT_SECONDS,
      });
      const lines = output.split("\n");
      const gitIndex = lines.findIndex((line) => line.trimEnd() === "PIX_GIT");
      const headLines = gitIndex >= 0 ? lines.slice(0, gitIndex).map((line) => line.trimEnd()).filter((line) => line !== "") : [];
      const dirtyLines = gitIndex >= 0 ? lines.slice(gitIndex + 1).map((line) => line.trimEnd()).filter((line) => line !== "") : [];
      const head = headLines.length > 0 && HEAD_SHA_RE.test(headLines[headLines.length - 1]) ? headLines[headLines.length - 1] : undefined;
      const dirtySummary = dirtyLines.length > 0 ? dirtyLines.join("\n").slice(0, GIT_DIRTY_SUMMARY_MAX_CHARS) : undefined;
      return { head, dirtySummary };
    }
    let head: string | undefined;
    try {
      const out = (await runExecFile("git", ["-C", context.logicalCwd, "rev-parse", "HEAD"], GIT_HOST_TIMEOUT_MS)).trim();
      if (HEAD_SHA_RE.test(out)) {
        head = out;
      }
    } catch {
      head = undefined;
    }
    let dirtySummary: string | undefined;
    try {
      const out = (await runExecFile("git", ["-C", context.logicalCwd, "status", "--porcelain"], GIT_HOST_TIMEOUT_MS)).trimEnd();
      dirtySummary = out === "" ? undefined : out.slice(0, GIT_DIRTY_SUMMARY_MAX_CHARS);
    } catch {
      dirtySummary = undefined;
    }
    return { head, dirtySummary };
  }
}
