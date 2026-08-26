/**
 * Single-task execution runtime for app-level agent tasks (design plan §4.6).
 *
 * One task = one runtime; at any time at most one live nested AgentSession.
 * `single` runs exactly one item; `chain` runs the items strictly in order
 * inside the same scheduling slot, creating and releasing a nested session per
 * item. 1.4.1 uses an in-memory SessionManager; 1.4.2 (R2) switches to a
 * disk-backed SessionManager (SessionManager.create over the store's
 * <task>/sessions dir) whenever the service passes a taskSessionDir, emits a
 * checkpoint after every finalized assistant message, complete tool result and
 * key state transition (item start/end), and maintains an incremental
 * workspace fingerprint. Without a taskSessionDir the runtime keeps the
 * in-memory behavior and emits no checkpoints (existing tests).
 *
 * Ownership: the runtime creates its own ProjectExecutionContext from the
 * frozen spec's ProjectLocation (never the parent bridge's context, which the
 * parent disposes on switch/stop), its own AuthStorage and ModelRegistry, and
 * fresh SettingsManager/DefaultResourceLoader/McpAdapter per nested session.
 * All owned dependencies are released when the runtime ends; dispose() is
 * bounded and idempotent.
 *
 * Permission snapshot: the loader reloads first, then spec.executionMode and
 * spec.verificationGate are applied; createAgentSession fixes
 * extensionProviderPolicy:"read-only" and excludes the `agent` tool plus the
 * item's disallowedTools, limiting the tool set to the item's tools.
 * Backgrounding/resume never re-reads the parent execution mode and never
 * elevates project agent authorization.
 *
 * Events: activity/output/file_change are normalized and forwarded through
 * AgentTaskRuntimeEvent. The nested file_change branch forwards edit/write
 * changes verbatim (the legacy SubagentRunner default:break dropped them; here
 * they reach AgentTaskService / Plan deviation detection).
 *
 * User input: the requestUserInput closure points at the AgentTaskInputRouter
 * (enqueue per §4.5; the router is created by AgentTaskService in B3). The
 * runtime owns the pending response promises; the service delivers answers
 * through resolveInput()/cancelInput() so the nested request_user_input tool
 * can await them. This module only type-imports ./agent-task-input.js
 * (missing until B3; type-only imports are erased at transform time).
 *
 * 1.4.1 version gates: in-memory SessionManager only; no checkpoint /
 * persistSessionFile / prepareResume / AgentTaskRuntimeResumeSeed; no import of
 * the 1.4.2 agent-task-store.ts; AgentTaskRuntimeEvent has no checkpoint /
 * assistant_finalized members.
 *
 * 1.4.2 (R3) resume: prepareResume(seed) validates the effective model against
 * the runtime's OWN registry, opens (or, defensively, creates) the repaired
 * session transcript and creates the idle nested AgentSession WITHOUT
 * triggering a turn or occupying a slot. run() then starts at the seed's
 * activeItemIndex, seeds the results with the folded priorResults (chain
 * {previous} and final aggregation stay intact) and prompts the fixed
 * RESUME_TURN_MESSAGE with expandPromptTemplates:false - the original item
 * prompt and the recovery note are already part of the transcript and are never
 * re-injected. The runtime's checkpoint/input generation follows the resumed
 * task generation (seed checkpoint generation + 1). The assistant_finalized
 * event carries the leaf entry id of each newly finalized model assistant
 * message (the resume success criterion); the item_result event carries each
 * completed item's SubagentSingleResult so the service can persist the folded
 * resume prefix.
 */

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join, posix as pathPosix, resolve, win32 as pathWin32 } from "node:path";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { McpAdapter } from "pi-mcp-adapter";
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  MAX_AGENT_TURNS as MAX_DEFINITION_AGENT_TURNS,
  SessionManager,
  SettingsManager,
  createAgentSession,
  isPathInsideCwd,
  type AgentSession,
  type AgentSessionEvent,
  type ExecutionBackend,
  type FileChangeSummary,
  type ToolDefinition,
  type TurnDiffSummary,
} from "@earendil-works/pi-coding-agent";
import { createProjectExecutionContext, disposeProjectExecutionContext, type ProjectExecutionContext } from "../execution-context.js";
import type { ProjectLocation } from "../../shared/project-location.js";
import { SHELL_BACKGROUND_TOOLS } from "../subagent/subagent-runner.js";
import type { ObjectJsonSchema } from "../workflow/engine/schema.js";
import {
  createStructuredOutputTool,
  salvageStructuredFromText,
  schemaChildCompletionPrompt,
  SCHEMA_CHILD_EARLY_STOP_NUDGE,
  SCHEMA_CHILD_LAST_TURN_NUDGE,
  SCHEMA_CHILD_SUBMIT_RECOVERIES,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from "../workflow/structured-output-tool.js";
import type { AgentTaskInputRouter } from "./agent-task-input.js";
import {
  DEFAULT_MAX_TURNS,
  type AgentTaskActivity,
  type AgentTaskFailureReason,
  type AgentTaskItemSpec,
  type AgentTaskModelSnapshot,
  type AgentTaskSpec,
  type AgentTaskUsage,
  type ResumeDecision,
} from "../../shared/agent-task-types.js";
import type {
  OpenToolCall,
  TaskCheckpoint,
  WorkspaceFingerprint,
} from "./agent-task-store.js";
import {
  SUBAGENT_MAX_ACTIVITY_SUMMARY_CHARS,
  SUBAGENT_MAX_ERROR_MESSAGE_BYTES,
  SUBAGENT_MAX_FINAL_OUTPUT_BYTES,
  SUBAGENT_MAX_RECENT_ACTIVITIES,
  type SubagentActivity,
  type SubagentFailureReason,
  type SubagentSingleResult,
  type SubagentStatus,
  type SubagentUsage,
} from "../../shared/subagent-types.js";
import type { RequestUserInputRequest, RequestUserInputResponse } from "../../shared/types.js";

export { DEFAULT_MAX_TURNS };
export const MAX_AGENT_TURNS = MAX_DEFINITION_AGENT_TURNS;
export const NESTED_STARTUP_TIMEOUT_MS = 30_000;
export const ABORT_TIMEOUT_MS = 5_000;
export const NESTED_CLEANUP_TIMEOUT_MS = 2_000;
export const MAX_DELEGATED_PROMPT_BYTES = 64 * 1024;
export const MAX_TASK_OUTPUT_BYTES = SUBAGENT_MAX_FINAL_OUTPUT_BYTES;
export const MAX_RECENT_ACTIVITIES = SUBAGENT_MAX_RECENT_ACTIVITIES;
export const MAX_ACTIVITY_SUMMARY_CHARS = SUBAGENT_MAX_ACTIVITY_SUMMARY_CHARS;
export const MAX_ERROR_MESSAGE_BYTES = SUBAGENT_MAX_ERROR_MESSAGE_BYTES;

/**
 * 1.4.1 tasks always run on generation 0; generation threading arrives with
 * resumption (1.4.2 R2/R3).
 */
const RUNTIME_TASK_GENERATION = 0;

/**
 * The fixed, visible resume-turn user message (design plan §4.8): the recovery
 * note was already injected into the transcript by the resumer, so this message
 * never repeats the original item prompt or the note.
 */
export const RESUME_TURN_MESSAGE =
  "Continue the interrupted task from the recovery note. Re-check current workspace state and do not repeat completed or result-unknown tool calls.";

const TEXT_UPDATE_THROTTLE_MS = 100;

/**
 * 1.5 (P3): nested-session event types forwarded for live transcript viewing.
 * The whitelist mirrors upstream §5.2: compaction/api_error/retry/vision are
 * deliberately excluded (the task transcript does not chase full session-event
 * parity; an accepted trade-off).
 */
const TRANSCRIPT_FORWARD_WHITELIST = new Set<AgentSessionEvent["type"]>([
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "file_change",
]);

/** Workspace-fingerprint tool allowlist (design plan §4.7); bash is excluded. */
const FINGERPRINT_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);
/** Tool arg fields that may carry a workspace path. */
const FINGERPRINT_PATH_FIELDS = ["path", "file_path", "filename"] as const;
/** Fixed hash for observed paths that are missing/deleted at fingerprint time. */
export const FINGERPRINT_MISSING_SENTINEL = "PIX-MISSING";
const FINGERPRINT_BASH_TIMEOUT_SECONDS = 30;
const GIT_DIRTY_SUMMARY_MAX_CHARS = 8192;
const GIT_HOST_TIMEOUT_MS = 5000;

/** Why a checkpoint is being emitted; decides the leaf capture semantics. */
type CheckpointReason = "item_start" | "message" | "tool_result" | "item_end";

const HEAD_SHA_RE = /^[0-9a-f]{40}$/;

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

/** External termination causes; the first one wins and is never overwritten. */
type TerminationCause = "signal" | "abort" | "disposed" | "max_turns" | "structured_complete";

/** Per-task termination coordinator (first cause wins). */
interface TaskControl {
  readonly cause: TerminationCause | undefined;
  readonly promise: Promise<TerminationCause>;
  fire: (cause: TerminationCause) => void;
  /** Synchronous hook run when a cause fires (nested abort). */
  setOnFire: (handler: (cause: TerminationCause) => void) => void;
}

/** Abortable timer used for every bounded wait. */
interface Deadline {
  readonly promise: Promise<"deadline">;
  readonly fired: boolean;
  cancel: () => void;
}

/** Mutable per-run bookkeeping that feeds the task-level result. */
interface TaskRunState {
  results: SubagentSingleResult[];
  /** Task-global activity sequence (chain items share the counter). */
  sequence: number;
  lastOutputEmitAt: number;
  onEvent: (e: AgentTaskRuntimeEvent) => void;
}

/** Event counters maintained for one nested session. */
interface ItemCounters {
  toolUseCount: number;
  turnCount: number;
  limitArmed: boolean;
  lastAssistantMessage: AssistantMessage | undefined;
  lastNonEmptyFinalizedText: string;
  latestStreamingText: string;
  lastPromptError: string | undefined;
  usage: SubagentUsage;
  activities: SubagentActivity[];
  schemaNudgeSent: boolean;
}

function emptyUsage(): SubagentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 };
}

/** Nested-session system prompt: base, agent.systemPrompt, extraAppend?, schemaPrompt last. */
function nestedSystemPromptOverride(item: AgentTaskItemSpec & { resolution: "ready" }): (base: string[]) => string[] {
  return (base) => {
    const parts = [...base, item.agent.systemPrompt];
    if (item.appendSystemPrompt !== undefined) {
      parts.push(item.appendSystemPrompt);
    }
    if (item.outputSchema !== undefined) {
      parts.push(schemaChildCompletionPrompt(item.outputSchema as ObjectJsonSchema));
    }
    return parts;
  };
}

function createTaskControl(): TaskControl {
  let cause: TerminationCause | undefined;
  let onFire: ((cause: TerminationCause) => void) | undefined;
  const listeners = new Set<(cause: TerminationCause) => void>();
  const promise = new Promise<TerminationCause>((resolve) => {
    listeners.add(resolve);
  });
  return {
    get cause() {
      return cause;
    },
    promise,
    fire: (next: TerminationCause) => {
      if (cause !== undefined) {
        return;
      }
      cause = next;
      onFire?.(next);
      for (const listener of listeners) {
        listener(next);
      }
    },
    setOnFire: (handler) => {
      onFire = handler;
    },
  };
}

function createDeadline(ms: number): Deadline {
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => {
      fired = true;
      resolve("deadline");
    }, ms);
  });
  return {
    promise,
    get fired() {
      return fired;
    },
    cancel: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Bounded wait for a dispose-style promise: the original promise keeps its
 * resolve/reject observers, so a late settlement can never become an
 * unhandled rejection.
 */
function disposeBounded(promise: Promise<unknown>, label: string): Promise<void> {
  const deadline = createDeadline(NESTED_CLEANUP_TIMEOUT_MS);
  const outcome = Promise.race([promise, deadline.promise]);
  return outcome.then((value) => {
    deadline.cancel();
    if (value !== "deadline") {
      return;
    }
    console.warn(`[AgentTaskRuntime] ${label} did not finish within ${NESTED_CLEANUP_TIMEOUT_MS}ms`);
  });
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** UTF-8-safe truncation; never splits a multi-byte character. */
function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean; originalBytes: number } {
  const originalBytes = utf8ByteLength(text);
  if (originalBytes <= maxBytes) {
    return { text, truncated: false, originalBytes };
  }
  let slice = Buffer.from(text, "utf-8").subarray(0, maxBytes);
  while (slice.length > 0 && (slice[slice.length - 1] & 0xc0) === 0x80) {
    slice = slice.subarray(0, slice.length - 1);
  }
  if (slice.length > 0 && (slice[slice.length - 1] & 0x80) !== 0) {
    slice = slice.subarray(0, slice.length - 1);
  }
  return { text: slice.toString("utf-8"), truncated: true, originalBytes };
}

function boundedErrorMessage(message: string): string {
  return truncateUtf8(message, MAX_ERROR_MESSAGE_BYTES).text;
}

/** Single-line, bounded activity summary; never includes full args/result. */
function summarizeActivity(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  const candidate = record.command ?? record.path ?? record.file_path ?? record.filename ?? record.pattern;
  if (typeof candidate !== "string" || candidate.trim() === "") {
    return undefined;
  }
  const singleLine = candidate.replace(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_ACTIVITY_SUMMARY_CHARS) {
    return singleLine;
  }
  return `${singleLine.slice(0, MAX_ACTIVITY_SUMMARY_CHARS - 3)}...`;
}

/** Concatenate all text blocks of an assistant message in original order. */
function assistantText(message: AssistantMessage | undefined): string {
  if (!message) {
    return "";
  }
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") {
      text += block.text;
    }
  }
  return text;
}

function accumulateUsage(target: SubagentUsage, usage: Usage | undefined): void {
  if (!usage) {
    return;
  }
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.cost += usage.cost.total;
  target.totalTokens += usage.totalTokens;
}

// ============================================================================
// Execution-context factories (internal test injection)
// ============================================================================

type CreateContextFn = (location: ProjectLocation) => Promise<ProjectExecutionContext>;
type DisposeContextFn = (context: ProjectExecutionContext | null) => Promise<void>;

let createContextImpl: CreateContextFn = createProjectExecutionContext;
let disposeContextImpl: DisposeContextFn = disposeProjectExecutionContext;

/**
 * Internal injection point for tests (mirrors ProjectExecutionContextHooks /
 * WslExecutionBackendHooks): swaps the runtime's execution-context factories so
 * tests can assert that a runtime creates and disposes exactly its own backend.
 * Not part of the public contract; omitted in production. Returns a restore
 * function.
 */
export function __setAgentTaskRuntimeContextFactoriesForTests(
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

// ============================================================================
// Public contract (design plan §4.6, 1.4.1)
// ============================================================================

export type AgentTaskRuntimeEventV141 =
  | { type: "activity"; activity: AgentTaskActivity }
  | { type: "output"; text: string; truncated: boolean; originalBytes: number }
  | { type: "file_change"; change: FileChangeSummary; aggregate: TurnDiffSummary };
// 1.4.2 (R2): checkpoint events carry the disk-session leaf/fingerprint state
// for the service to persist. (R3) adds assistant_finalized (the leaf entry id
// of each newly finalized model assistant message; the resume success
// criterion) and item_result (the completed item's result, persisted as the
// folded resume prefix).
export type AgentTaskRuntimeEvent =
  | AgentTaskRuntimeEventV141
  | { type: "checkpoint"; checkpoint: TaskCheckpoint }
  | { type: "assistant_finalized"; entryId: string }
  | { type: "item_result"; result: SubagentSingleResult }
  // 1.5 (P3): transcript live forwarding + item->session-file binding.
  // nested_transcript streams whitelisted nested session events through the
  // service throttle queue; item_session maps an item to its session file in
  // the task log (the service persists it, getTranscriptPage replays it).
  | { type: "nested_transcript"; itemIndex: number; event: AgentSessionEvent } // coding-agent 类型
  | { type: "item_session"; itemIndex: number; sessionFileName: string };

/**
 * 1.4.2 (R3): resume seed handed to prepareResume (design plan §4.6). The
 * checkpoint already points at the repaired/created transcript leaf; the
 * runtime opens it, creates the idle nested AgentSession and returns a
 * checkpoint without sending a model turn or writing the store.
 */
export interface AgentTaskRuntimeResumeSeed {
  checkpoint: TaskCheckpoint;
  decision: ResumeDecision;
  /** 已校验的当前 item 模型；continue 继承最近持久化 summary，switch_model 使用本次选择 */
  effectiveModel: AgentTaskModelSnapshot;
  /** 恢复说明；已在 transcript 中作为可见 CustomMessageEntry 写入，不得重复注入 */
  injectNote: string;
  /** 从 events/info 折叠出的已终态前缀，保留 chain {previous} 与最终聚合 */
  priorResults: SubagentSingleResult[];
}

export interface AgentTaskRuntimeResult {
  status: "completed" | "failed" | "cancelled";
  failureReason?: AgentTaskFailureReason;
  finalOutput: string;
  results: SubagentSingleResult[];
  usage: AgentTaskUsage;
  activities: AgentTaskActivity[];
}

export class AgentTaskRuntime {
  private readonly _spec: AgentTaskSpec;
  private readonly _input: AgentTaskInputRouter;
  private readonly _taskSessionDir: string | undefined;

  private _disposed = false;
  private _abortRequested = false;
  private _disposePromise: Promise<void> | undefined;
  private _control: TaskControl | undefined;
  private _authStorage: AuthStorage | undefined;
  private _modelRegistry: ModelRegistry | undefined;
  private _context: ProjectExecutionContext | undefined;
  private _contextDisposed = false;
  private readonly _pendingInputs = new Map<string, { resolve: (response: RequestUserInputResponse) => void }>();
  private readonly _inFlight = new Set<Promise<unknown>>();

  // 1.4.2 (R2) persistence state. Only active when a taskSessionDir was given
  // (the service passes the store's <task>/sessions dir); without one the
  // runtime keeps the 1.4.1 in-memory behavior and emits no checkpoints.
  private _sessionManager: SessionManager | undefined;
  private _activeItemIndex = 0;
  private _lastFinalizedEntryId: string | undefined;
  private readonly _openToolCalls = new Map<string, OpenToolCall>();
  /** Workspace-relative logical path -> absolute logical path observed since the last fingerprint refresh. */
  private _observedSinceCheckpoint = new Map<string, string>();
  /** Workspace-relative logical path -> last computed sha256 (or missing sentinel). */
  private readonly _fingerprintCache = new Map<string, string>();
  private _fingerprint: WorkspaceFingerprint = { isGit: false, observedFileHashes: {} };
  /** Serializes fingerprint refreshes + checkpoint emissions so writes stay ordered. */
  private _fingerprintChain: Promise<void> = Promise.resolve();
  /** The run() callback; checkpoint events are delivered through it. */
  private _runOnEvent: ((event: AgentTaskRuntimeEvent) => void) | undefined;

  // 1.5 (P3): nested-transcript live forwarding master switch.
  private _transcriptForwarding = false;

  // 1.4.2 (R3) resume state (only set by prepareResume).
  private _resumeSeed: AgentTaskRuntimeResumeSeed | undefined;
  /** The idle nested AgentSession created by prepareResume, consumed by run(). */
  private _preparedSession: AgentSession | undefined;
  /** The MCP adapter of the prepared session (disposed with it). */
  private _preparedMcpAdapter: McpAdapter | undefined;
  /** Checkpoint/input generation: RUNTIME_TASK_GENERATION normally, seed + 1 after prepareResume. */
  private _taskGeneration = RUNTIME_TASK_GENERATION;

  constructor(opts: { spec: AgentTaskSpec; input: AgentTaskInputRouter; taskSessionDir?: string }) {
    this._spec = opts.spec;
    this._input = opts.input;
    this._taskSessionDir = opts.taskSessionDir;
  }

  async run(signal: AbortSignal, onEvent: (e: AgentTaskRuntimeEvent) => void): Promise<AgentTaskRuntimeResult> {
    this._runOnEvent = onEvent;
    const runPromise = this._runInner(signal, onEvent);
    this._inFlight.add(runPromise);
    try {
      return await runPromise;
    } finally {
      this._inFlight.delete(runPromise);
    }
  }

  /** Cancel the current run (user cancel); settles as status "cancelled". */
  abort(): void {
    if (this._control) {
      this._control.fire("abort");
    } else {
      this._abortRequested = true;
    }
  }

  /**
   * Idempotent, bounded cleanup: cancels the run, settles pending user-input
   * waits as cancelled and releases the runtime's own ProjectExecutionContext
   * (nested session + MCP are released by the run itself). Returns a promise
   * that settles once every in-flight run has finished cleaning up.
   */
  dispose(): Promise<void> {
    if (!this._disposed) {
      this._disposed = true;
      this._control?.fire("disposed");
      for (const [requestId, pending] of this._pendingInputs) {
        this._pendingInputs.delete(requestId);
        pending.resolve({ id: requestId, answers: {}, cancelled: true });
      }
    }
    if (!this._disposePromise) {
      this._disposePromise = Promise.allSettled([...this._inFlight]).then(async () => {
        // A prepared-but-never-run resume session (prepare succeeded, the task
        // was cancelled/disposed while queued, or the resumed run converged to
        // a terminal state before consuming it) must not leak its open session
        // and backend.
        await this._disposePreparedResume();
        await this._disposeContext();
      });
    }
    return this._disposePromise;
  }

  /**
   * 1.4.2 (R3): prepare a resume without occupying a scheduling slot or
   * triggering a model turn (design plan §4.6/§4.8). Validates the effective
   * model against the runtime's OWN registry, opens the repaired transcript
   * leaf (the resumer guarantees a non-null sessionFileName in the seed) and
   * creates the idle nested AgentSession over it. Returns a checkpoint pointing
   * at the opened transcript's latest leaf; AgentTaskResumer.prepare persists
   * it with the OLD task generation before the runtime may be handed to the
   * service. Throws with a stable code message on failure; the resumer maps
   * the message onto its prepare reason.
   */
  async prepareResume(seed: AgentTaskRuntimeResumeSeed): Promise<TaskCheckpoint> {
    if (this._taskSessionDir === undefined) {
      throw new Error("resume requires a disk-backed task session dir");
    }
    if (this._resumeSeed !== undefined || this._preparedSession !== undefined) {
      throw new Error("internal_error");
    }
    const checkpoint = seed.checkpoint;
    if (
      !Number.isInteger(checkpoint.activeItemIndex) ||
      checkpoint.activeItemIndex < 0 ||
      checkpoint.activeItemIndex >= this._spec.items.length
    ) {
      throw new Error("invalid_checkpoint");
    }
    const item = this._spec.items[checkpoint.activeItemIndex];
    if (item.resolution !== "ready") {
      throw new Error("invalid_checkpoint");
    }
    if (checkpoint.sessionFileName === null) {
      // The resumer always creates the next item's session before building the
      // seed (§4.8 ②); a null file here is a broken seed.
      throw new Error("invalid_checkpoint");
    }
    this._resumeSeed = seed;
    // Checkpoint/input generation follows the RESUMED task generation (the
    // seed checkpoint carries the pre-resume generation by contract).
    this._taskGeneration = checkpoint.generation + 1;
    this._activeItemIndex = checkpoint.activeItemIndex;
    this._lastFinalizedEntryId = checkpoint.lastFinalizedEntryId;
    // Seed the fingerprint state so incremental refreshes stay relative to the
    // pre-crash checkpoint (unchanged observed paths are never re-hashed).
    this._fingerprint = structuredClone(checkpoint.workspaceFingerprint);
    this._fingerprintCache.clear();
    for (const [rel, hash] of Object.entries(checkpoint.workspaceFingerprint.observedFileHashes)) {
      this._fingerprintCache.set(rel, hash);
    }

    // Own environment: the runtime's own execution context + dependencies
    // (never borrowed from the parent bridge).
    this._context = await createContextImpl(this._spec.project);
    this._ensureOwnedDependencies();
    // Defensive model re-resolution against the runtime's OWN registry: the
    // effective model must still resolve and be authenticated (fail closed,
    // never silently substituting another model).
    const effectiveModel = this._resolveModelOrThrow(seed.effectiveModel.provider, seed.effectiveModel.modelId);

    // Open the repaired transcript (the resumer ran the strict scan + repair
    // before building the seed, so SessionManager.open's silent-skip behavior
    // is never used as a corruption detector).
    const sessionPath = join(this._taskSessionDir, checkpoint.sessionFileName);
    this._sessionManager = SessionManager.open(sessionPath, this._taskSessionDir, this._context.physicalCwd);

    // Mirror the startup dependency block of _runItem: loader reload first,
    // then the frozen execution snapshot, then createAgentSession.
    const settingsManager = SettingsManager.create(this._context.physicalCwd, this._spec.agentDir);
    const mcpAdapter = new McpAdapter({ allowStdio: !this._context.isWsl });
    const loader = new DefaultResourceLoader({
      cwd: this._context.physicalCwd,
      agentDir: this._spec.agentDir,
      settingsManager,
      appendSystemPromptOverride: nestedSystemPromptOverride(item),
      extensionFactories: [
        (pi) => {
          mcpAdapter.register(pi);
        },
      ],
    });
    try {
      await loader.reload();
      settingsManager.applyOverrides({
        execution: {
          mode: this._spec.executionMode,
          verificationGate: this._spec.verificationGate,
        },
      });
      const isWsl = this._spec.project.environment.kind === "wsl";
      // Workflow schema children (design plan §4.6): the capture tool is
      // injected alongside the session, workflow/ralph are excluded like
      // agent, and a tools allowlist must merge submit_workflow_result into
      // itself or the allowlist would hide the custom tool. The item's
      // outputSchema is already subset-gated by the worker, so the cast is
      // the frozen contract.
      const schemaChild = item.outputSchema !== undefined;
      const tools = schemaChild && item.agent.tools !== undefined
        ? [...new Set([...item.agent.tools, STRUCTURED_OUTPUT_TOOL_NAME])]
        : item.agent.tools;
      const created = await createAgentSession({
        cwd: this._context.physicalCwd,
        runtimeCwd: this._context.logicalCwd,
        agentDir: this._spec.agentDir,
        executionBackend: this._context.executionBackend,
        runtimeEnvironmentOverride: this._context.runtimeEnvironmentOverride,
        authStorage: this._authStorage,
        modelRegistry: this._modelRegistry,
        model: effectiveModel,
        thinkingLevel: this._spec.thinkingLevel,
        sessionManager: this._sessionManager,
        settingsManager,
        resourceLoader: loader,
        extensionProviderPolicy: "read-only",
        excludeTools: [
          "agent",
          // Plan §7: workflow/ralph are excluded from WORKFLOW children only;
          // ordinary agent-tool children keep today's baseline (an extension
          // may legitimately register tools with those names).
          ...(schemaChild ? ["workflow", "ralph"] : []),
          ...(item.agent.disallowedTools ?? []),
          ...(isWsl ? [...SHELL_BACKGROUND_TOOLS] : []),
        ],
        tools,
        customTools: schemaChild
          ? [createStructuredOutputTool(item.outputSchema as ObjectJsonSchema) as ToolDefinition]
          : undefined,
        requestUserInput: (request, signal) => this._requestUserInput(request, signal),
      });
      this._preparedSession = created.session;
      this._preparedMcpAdapter = mcpAdapter;
      await this._preparedSession.bindExtensions({});
    } catch (error) {
      // A prepared-but-failed resume must not leak its MCP adapter / backend;
      // an already-created session stays in _preparedSession and is disposed by
      // runtime.dispose() (the resumer disposes the runtime on failure).
      this._preparedMcpAdapter = undefined;
      await disposeBounded(
        mcpAdapter.dispose().catch(() => {}),
        "Prepared MCP adapter dispose",
      );
      this._resumeSeed = undefined;
      throw error;
    }

    const leaf = this._sessionManager.getLeafId();
    return {
      taskId: this._spec.taskId,
      generation: checkpoint.generation, // old generation; the resumer persists it, the service bumps it
      seq: checkpoint.seq, // stamped with the log seq by the resumer at write time
      activeItemIndex: checkpoint.activeItemIndex,
      sessionFileName: this._currentSessionFileName(),
      sessionLeafId: leaf,
      lastFinalizedEntryId: this._lastFinalizedEntryId,
      openToolCalls: [],
      workspaceFingerprint: this._fingerprint,
      ts: Date.now(),
    };
  }

  /**
   * Deliver the user's answer to a pending request_user_input wait
   * (AgentTaskService.respondInput wiring, B3). Returns false when the
   * requestId is unknown (already answered, cancelled or never routed).
   */
  resolveInput(requestId: string, response: RequestUserInputResponse): boolean {
    const pending = this._pendingInputs.get(requestId);
    if (!pending) {
      return false;
    }
    this._pendingInputs.delete(requestId);
    pending.resolve(response);
    return true;
  }

  /**
   * Cancel a pending request_user_input wait (AgentTaskService.cancelInput
   * wiring, B3); the nested tool sees a cancelled response. Returns false when
   * the requestId is unknown.
   */
  cancelInput(requestId: string): boolean {
    const pending = this._pendingInputs.get(requestId);
    if (!pending) {
      return false;
    }
    this._pendingInputs.delete(requestId);
    pending.resolve({ id: requestId, answers: {}, cancelled: true });
    return true;
  }

  /**
   * 1.5 (P3): master switch for nested-transcript live forwarding (zero
   * subscriptions keep zero overhead; nothing is produced while disabled).
   * The service turns it on when a watcher's count goes 0->1, off on 1->0 and
   * at terminal convergence. item_session is NOT gated by this switch (always
   * reported; the service decides its own persistence).
   */
  setTranscriptForwarding(enabled: boolean): void {
    this._transcriptForwarding = enabled;
  }

  // =========================================================================
  // Run orchestration
  // =========================================================================

  private async _runInner(signal: AbortSignal, onEvent: (e: AgentTaskRuntimeEvent) => void): Promise<AgentTaskRuntimeResult> {
    const startedAt = Date.now();
    const control = createTaskControl();
    this._control = control;
    if (this._abortRequested) {
      control.fire("abort");
    } else if (this._disposed) {
      control.fire("disposed");
    } else if (signal.aborted) {
      control.fire("signal");
    }

    let removeSignalListener: (() => void) | undefined;
    if (signal) {
      const onAbort = (): void => control.fire("signal");
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        removeSignalListener = () => signal.removeEventListener("abort", onAbort);
      }
    }

    const state: TaskRunState = { results: [], sequence: 0, lastOutputEmitAt: 0, onEvent };
    try {
      if (this._spec.items.length === 0) {
        state.results.push(this._makeFailedRunResult("invalid_parameters", "The task has no items."));
        return this._finalize(state);
      }
      // 1.4.2 (R3): a resumed run starts at the seed's activeItemIndex and
      // seeds the completed prefix (chain {previous} and the final aggregation
      // stay intact through the seeded results).
      const startIndex = this._resumeSeed !== undefined ? this._resumeSeed.checkpoint.activeItemIndex : 0;
      if (this._resumeSeed !== undefined) {
        state.results.push(...this._resumeSeed.priorResults.map((result) => structuredClone(result)));
      }
      for (const [itemIndex, item] of this._spec.items.entries()) {
        if (itemIndex < startIndex) {
          continue;
        }
        this._activeItemIndex = itemIndex;
        this._openToolCalls.clear();
        if (control.cause !== undefined) {
          // Cancelled between items: the next item never starts; its aborted
          // placeholder terminates the result prefix (chain semantics).
          const placeholder = this._makeItemResult(item);
          this._markAborted(placeholder, control.cause, this._causeMessage(control.cause));
          state.results.push(placeholder);
          break;
        }
        if (item.resolution === "rejected") {
          // Frozen preflight failure: no session, no provider call.
          state.results.push(this._makeRejectedResult(item));
          if (this._spec.mode === "chain") {
            break;
          }
          continue;
        }
        // 1.4.2 (R3): a failed/aborted item in the folded prefix means the
        // chain had already broken before the crash; the run converges to the
        // terminal state without starting the next item (no model turn).
        if (itemIndex === startIndex && state.results.some((r) => r.status === "failed" || r.status === "aborted")) {
          break;
        }
        const result = this._makeItemResult(item);
        state.results.push(result);
        const previousOutput = state.results.length >= 2 ? state.results[state.results.length - 2].finalOutput : undefined;
        await this._runItem(item, result, previousOutput, control, state);
        if (this._spec.mode === "chain" && (result.status === "failed" || result.status === "aborted")) {
          // Chain stops at the failed/aborted step; not-started later items
          // never enter the results array.
          break;
        }
      }
    } catch (error) {
      // Belt-and-braces: an unexpected internal failure must never reject the
      // run; classify it as a bounded structured failure.
      this._failCurrentResult(state, error);
    } finally {
      if (removeSignalListener) {
        removeSignalListener();
      }
      // 1.4.2: every queued checkpoint must reach the service before the run
      // settles (the service persists them in its own queue); the fingerprint
      // refresh needs the still-alive backend, so it runs before the release.
      await this._fingerprintChain;
      // 1.4.2 (R3): the last item's session manager stays alive until every
      // queued checkpoint (including the final message's leaf) has been
      // emitted; only after the chain drains is it released.
      this._sessionManager = undefined;
      // Runtime end: a prepared-but-unconsumed resume session (the folded
      // prefix already contains a failed/aborted item, or a cause fired before
      // the resume item started) must not leak its open session and MCP
      // backend; the nested dispose runs before the shared context is released
      // (same order as dispose()).
      await this._disposePreparedResume();
      // Runtime end: release the runtime's own backend/context exactly once.
      await this._disposeContext();
    }
    return this._finalize(state);
  }

  private _finalize(state: TaskRunState): AgentTaskRuntimeResult {
    const anyAborted = state.results.some((result) => result.status === "aborted");
    const firstFailed = state.results.find((result) => result.status === "failed");
    let status: AgentTaskRuntimeResult["status"];
    let failureReason: AgentTaskFailureReason | undefined;
    if (anyAborted) {
      status = "cancelled";
    } else if (firstFailed) {
      status = "failed";
      // Failed results only ever carry reasons from the AgentTaskFailureReason
      // set; the wider SubagentFailureReason union is a leftover of the shared
      // subagent contract.
      failureReason = firstFailed.failureReason as AgentTaskFailureReason | undefined;
    } else {
      status = "completed";
    }
    const last = state.results[state.results.length - 1];
    const usage = this._aggregateUsage(state.results);
    const activities = this._mergeActivities(state.results);
    return {
      status,
      failureReason,
      finalOutput: last ? last.finalOutput : "",
      results: [...state.results],
      usage,
      activities,
    };
  }

  /** One item of a chain/single task; never rejects. */
  private async _runItem(
    item: AgentTaskItemSpec & { resolution: "ready" },
    result: SubagentSingleResult,
    previousOutput: string | undefined,
    control: TaskControl,
    state: TaskRunState,
  ): Promise<void> {
    const nestedRef: { current: AgentSession | undefined } = { current: undefined };
    const mcpAdapterRef: { current: McpAdapter | undefined } = { current: undefined };
    const unsubscribeRef: { current: (() => void) | undefined } = { current: undefined };
    control.setOnFire(() => {
      nestedRef.current?.agent.abort();
    });

    // 1.4.1 WSL Shell tool isolation: an agent definition that EXPLICITLY lists
    // a shell background tool fails as tool_unavailable before any session
    // starts; the all-tools path can never re-add them (they are denylisted at
    // createAgentSession below). Windows runtimes keep them available.
    const isWsl = this._spec.project.environment.kind === "wsl";
    if (isWsl && item.agent.tools !== undefined) {
      const denied = item.agent.tools.filter((name) => SHELL_BACKGROUND_TOOLS.includes(name));
      if (denied.length > 0) {
        result.status = "failed";
        result.failureReason = "tool_unavailable";
        result.errorMessage = boundedErrorMessage(`Requested tool(s) not available: ${denied.join(", ")}.`);
        result.endedAt = Date.now();
        result.durationMs = 0;
        return;
      }
    }

    // 1.4.2 (R3): a resumed item prompts the fixed RESUME_TURN_MESSAGE (the
    // original item prompt and the recovery note are already part of the
    // transcript); a fresh item uses the chain prompt with {previous}
    // substitution.
    const resumePath = this._resumeSeed !== undefined && item.index === this._resumeSeed.checkpoint.activeItemIndex;
    const promptText = resumePath ? RESUME_TURN_MESSAGE : this._chainPrompt(item, previousOutput, result);
    if (promptText === null) {
      return;
    }
    result.status = "running";
    result.startedAt = Date.now();

    const counters: ItemCounters = {
      toolUseCount: 0,
      turnCount: 0,
      limitArmed: false,
      lastAssistantMessage: undefined,
      lastNonEmptyFinalizedText: "",
      latestStreamingText: "",
      lastPromptError: undefined,
      usage: emptyUsage(),
      activities: [],
      schemaNudgeSent: false,
    };
    const maxTurns = item.maxTurns ?? DEFAULT_MAX_TURNS;

    try {
      // Defensive model re-resolution against the runtime's OWN registry: the
      // service froze the spec after preflight, so a ready item should resolve;
      // a registry/hardware change since then fails closed, never silently
      // substituting another model. A resumed item resolves the seed's
      // effectiveModel (continue inherits the persisted summary, switch_model
      // the user's explicit choice) the same way.
      const model = resumePath
        ? this._resolveItemModel(this._resumeSeed!.effectiveModel.provider, this._resumeSeed!.effectiveModel.modelId, result)
        : this._resolveItemModel(item.model.provider, item.model.modelId, result);
      if (!model) {
        result.endedAt = Date.now();
        result.durationMs = Math.max(0, result.endedAt - result.startedAt);
        return;
      }

      // 1.4.2 (R3): a resumed item skips the startup race - prepareResume
      // already created the idle nested session and its MCP adapter; the slot
      // grant only attaches them to this item's cleanup scope.
      let startupOutcome: "ok" | "abandoned" | "startup_error" | "deadline" | TerminationCause;
      let startupError: string | undefined;
      if (resumePath) {
        nestedRef.current = this._preparedSession;
        mcpAdapterRef.current = this._preparedMcpAdapter;
        this._preparedSession = undefined;
        this._preparedMcpAdapter = undefined;
        startupOutcome = "ok";
      } else {
        // Fresh dependencies + a single startup deadline spanning context
        // creation, reload, createAgentSession and bindExtensions.
        const deadline = createDeadline(NESTED_STARTUP_TIMEOUT_MS);
        const startupFn = async (): Promise<boolean> => {
          // The runtime's own execution context, created once per runtime from
          // the frozen spec (never borrowed from the parent bridge).
          if (!this._context) {
            this._context = await createContextImpl(this._spec.project);
          }
          if (deadline.fired || control.cause) {
            return false;
          }
          const settingsManager = SettingsManager.create(this._context.physicalCwd, this._spec.agentDir);
          // 1.4.2 (R2): a task session dir turns the transcript persistent
          // (SessionManager.create with the store's <task>/sessions dir); without
          // one the runtime keeps the 1.4.1 in-memory behavior.
          const sessionManager =
            this._taskSessionDir !== undefined
              ? SessionManager.create(this._context.physicalCwd, this._taskSessionDir)
              : SessionManager.inMemory(this._context.physicalCwd);
          this._sessionManager = this._taskSessionDir !== undefined ? sessionManager : undefined;
          mcpAdapterRef.current = new McpAdapter({ allowStdio: !this._context.isWsl });
          const loader = new DefaultResourceLoader({
            cwd: this._context.physicalCwd,
            agentDir: this._spec.agentDir,
            settingsManager,
            appendSystemPromptOverride: nestedSystemPromptOverride(item),
            extensionFactories: [
              (pi) => {
                mcpAdapterRef.current!.register(pi);
              },
            ],
          });
          try {
            await loader.reload();
            if (deadline.fired || control.cause) {
              return false;
            }
            // Apply the frozen execution snapshot AFTER reload so reload does
            // not overwrite the override.
            settingsManager.applyOverrides({
              execution: {
                mode: this._spec.executionMode,
                verificationGate: this._spec.verificationGate,
              },
            });
            // Workflow schema children (design plan §4.6): the capture tool is
            // injected alongside the session, workflow/ralph are excluded
            // like agent, and a tools allowlist must merge
            // submit_workflow_result into itself or the allowlist would hide
            // the custom tool.
            const schemaChild = item.outputSchema !== undefined;
            const tools = schemaChild && item.agent.tools !== undefined
              ? [...new Set([...item.agent.tools, STRUCTURED_OUTPUT_TOOL_NAME])]
              : item.agent.tools;
            const created = await createAgentSession({
              cwd: this._context.physicalCwd,
              runtimeCwd: this._context.logicalCwd,
              agentDir: this._spec.agentDir,
              executionBackend: this._context.executionBackend,
              runtimeEnvironmentOverride: this._context.runtimeEnvironmentOverride,
              authStorage: this._authStorage,
              modelRegistry: this._modelRegistry,
              model,
              thinkingLevel: this._spec.thinkingLevel,
              sessionManager,
              settingsManager,
              resourceLoader: loader,
              extensionProviderPolicy: "read-only",
              excludeTools: [
                "agent",
                // Plan §7: workflow/ralph are excluded from WORKFLOW children
                // only; ordinary agent-tool children keep today's baseline.
                ...(schemaChild ? ["workflow", "ralph"] : []),
                ...(item.agent.disallowedTools ?? []),
                ...(isWsl ? [...SHELL_BACKGROUND_TOOLS] : []),
              ],
              tools,
              customTools: schemaChild
                ? [createStructuredOutputTool(item.outputSchema as ObjectJsonSchema) as ToolDefinition]
                : undefined,
              requestUserInput: (request, signal) => this._requestUserInput(request, signal),
            });
            if (deadline.fired || control.cause) {
              // The session must not leak when the deadline/cause won the race.
              await created.session.dispose({
                killTrackedDetachedChildren: false,
                extensionShutdownTimeoutMs: NESTED_CLEANUP_TIMEOUT_MS,
              });
              return false;
            }
            nestedRef.current = created.session;
            await nestedRef.current.bindExtensions({});
            return !deadline.fired && control.cause === undefined;
          } finally {
            deadline.cancel();
          }
        };

        // A rejection during reload/create/bind is a session-start failure, never
        // an internal one: label the outcome so the state machine below
        // classifies it (signal/abort/dispose still win when they arrived first).
        startupOutcome = await Promise.race([
          startupFn().then(
            (ok): "ok" | "abandoned" => (ok ? "ok" : "abandoned"),
            (error: unknown): "startup_error" => {
              startupError = error instanceof Error ? error.message : String(error);
              return "startup_error";
            },
          ),
          deadline.promise,
          control.promise,
        ]);
        deadline.cancel();
      }

      if (startupOutcome !== "ok") {
        // Startup deadline / startup error / external cause: the prompt never
        // starts. The external cause keeps first-cause priority.
        if (control.cause) {
          this._markAborted(result, control.cause, `${this._causeMessage(control.cause)} (during startup)`);
        } else {
          result.status = "failed";
          result.failureReason = "session_start_failed";
          result.errorMessage = boundedErrorMessage(
            startupOutcome === "startup_error" && startupError !== undefined
              ? `The nested session failed to start: ${startupError}`
              : `The nested session did not start within ${NESTED_STARTUP_TIMEOUT_MS}ms.`,
          );
        }
        result.endedAt = Date.now();
        result.durationMs = Math.max(0, result.endedAt - (result.startedAt ?? result.endedAt));
        return;
      }

      // 1.4.2: checkpoint the freshly created item session (file set, no leaf
      // yet) before the prompt starts. Guarded like item_end/message/tool_result:
      // without a taskSessionDir the runtime keeps the in-memory behavior and
      // emits no checkpoints (module contract, header comment).
      if (this._taskSessionDir !== undefined) {
        this._queueCheckpoint("item_start");
      }
      // 1.5 (P3): report the item->session-file binding for the task log. The
      // file name is final once the SessionManager is ready (its content may
      // still flush later; the file name is what maps); a resumed item re-uses
      // the prepared session, so the file is the seed's sessionFileName. An
      // in-memory session (no taskSessionDir) has no file to map - skip.
      const itemSessionFileName = this._currentSessionFileName();
      if (itemSessionFileName !== null) {
        state.onEvent({ type: "item_session", itemIndex: this._activeItemIndex, sessionFileName: itemSessionFileName });
      }

      // Tool activation: undefined means all registered non-denylisted tools;
      // an explicit list must all be registered, otherwise the item fails
      // before the prompt starts.
      if (item.agent.tools === undefined) {
        nestedRef.current!.setActiveToolsByName(nestedRef.current!.getAllTools().map((tool) => tool.name));
      } else {
        const registered = new Set(nestedRef.current!.getAllTools().map((tool) => tool.name));
        const missing = item.agent.tools.filter((name) => !registered.has(name));
        if (missing.length > 0) {
          result.status = "failed";
          result.failureReason = "tool_unavailable";
          result.errorMessage = boundedErrorMessage(`Requested tool(s) not available: ${missing.join(", ")}.`);
          result.endedAt = Date.now();
          result.durationMs = Math.max(0, result.endedAt - result.startedAt!);
          return;
        }
      }

      // Event subscription.
      unsubscribeRef.current = nestedRef.current!.subscribe((event) => {
        this._onNestedEvent(
          event,
          state,
          control,
          counters,
          maxTurns,
          result,
          nestedRef.current,
          item.outputSchema !== undefined,
        );
      });

      // The full run promise; never start an unassociated waitForIdle race.
      // 1.4.2 (R3): the resume turn uses the fixed message with template
      // expansion disabled; the recovery note and the original item prompt are
      // already part of the transcript and are never re-injected.
      await this._awaitNestedPrompt(
        nestedRef.current!,
        promptText,
        control,
        counters,
        resumePath ? { expandPromptTemplates: false } : undefined,
      );

      const outputSchema = item.outputSchema as ObjectJsonSchema | undefined;
      if (outputSchema !== undefined && nestedRef.current !== undefined) {
        this._trySalvageStructured(outputSchema, result, control, counters);
        let recoveries = 0;
        while (
          result.structured === undefined &&
          control.cause === undefined &&
          counters.lastPromptError === undefined &&
          counters.turnCount < maxTurns &&
          recoveries < SCHEMA_CHILD_SUBMIT_RECOVERIES
        ) {
          recoveries++;
          await this._awaitNestedPrompt(
            nestedRef.current,
            SCHEMA_CHILD_EARLY_STOP_NUDGE,
            control,
            counters,
            { expandPromptTemplates: false },
          );
          this._trySalvageStructured(outputSchema, result, control, counters);
        }
      }

      // Terminal classification.
      this._classifyTerminal(result, control, counters, maxTurns, item.outputSchema !== undefined);
      // Final output event (forced): the service's finalOutput must reflect the
      // terminal text, which may differ from the last streamed update.
      state.onEvent({
        type: "output",
        text: result.finalOutput,
        truncated: result.outputTruncated,
        originalBytes: result.originalOutputBytes,
      });
    } catch (error) {
      // Unexpected internal failure: never reject the item; convert it to a
      // bounded structured failure.
      const now = Date.now();
      result.status = "failed";
      result.failureReason = "internal_error";
      result.errorMessage = boundedErrorMessage(error instanceof Error ? error.message : String(error));
      result.endedAt = now;
      result.durationMs = Math.max(0, now - (result.startedAt ?? now));
      result.activities = this._convergeActivities(counters, now);
    } finally {
      // Fixed cleanup order: listener removal, unsubscribe, nested dispose,
      // MCP dispose. Both disposes are independent; neither failure nor timeout
      // skips the other.
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }
      if (nestedRef.current) {
        await disposeBounded(
          nestedRef.current
            .dispose({
              killTrackedDetachedChildren: false,
              extensionShutdownTimeoutMs: NESTED_CLEANUP_TIMEOUT_MS,
            })
            .catch((error: unknown) => {
              console.error("[AgentTaskRuntime] Nested session dispose failed:", error);
            }),
          "Nested session dispose",
        );
      }
      if (mcpAdapterRef.current) {
        await disposeBounded(
          mcpAdapterRef.current.dispose().catch((error: unknown) => {
            console.error("[AgentTaskRuntime] MCP adapter dispose failed:", error);
          }),
          "MCP adapter dispose",
        );
      }
      // Cross-function writes (_classifyTerminal / _markAborted) are not
      // visible to control-flow analysis, which has narrowed result.status to
      // "failed" | "running" from assignments in this method. Re-read as the
      // full SubagentStatus so the aborted skip (S2) type-checks.
      const itemStatus = result.status as SubagentStatus;
      const aborted =
        this._disposed ||
        itemStatus === "aborted" ||
        (control.cause !== undefined && control.cause !== "max_turns" && control.cause !== "structured_complete");
      if (aborted) {
        return;
      }
      // 1.4.2: the item's session is closed; the checkpoint advances the item
      // boundary (sessionFileName=null, next activeItemIndex) so a crash
      // between items resumes from a fresh session for the next item. The
      // session manager itself stays alive until the whole fingerprint chain
      // drains at run end: the checkpoints queued by this item (including the
      // final message's leaf) still need it.
      if (this._taskSessionDir !== undefined) {
        this._activeItemIndex = this._activeItemIndex + 1;
        this._queueCheckpoint("item_end");
      }
      // 1.4.2 (R3): persist the completed item's result as the folded resume
      // prefix (only items that actually entered the run reach this point;
      // frozen preflight rejections never advance activeItemIndex).
      state.onEvent({ type: "item_result", result: { ...result } });
    }
  }

  // =========================================================================
  // Owned dependencies
  // =========================================================================

  private _ensureOwnedDependencies(): void {
    if (!this._authStorage) {
      this._authStorage = AuthStorage.create(join(this._spec.agentDir, "auth.json"));
    }
    if (!this._modelRegistry) {
      this._modelRegistry = ModelRegistry.create(this._authStorage, join(this._spec.agentDir, "models.json"));
    }
  }

  private async _disposeContext(): Promise<void> {
    if (this._contextDisposed) {
      return;
    }
    this._contextDisposed = true;
    await disposeContextImpl(this._context ?? null);
    this._context = undefined;
  }

  /**
   * Release a prepared-but-unconsumed resume session and its MCP adapter
   * (idempotent; no-op once consumed by a run or disposed). Called by both
   * dispose() and the run's end: the resumed run breaks before consuming the
   * prepared session when the folded prefix already contains a failed/aborted
   * item (or a cause fired before the resume item started), and that session
   * must not leak its open transcript / stdio MCP children until the app exits.
   */
  private async _disposePreparedResume(): Promise<void> {
    if (this._preparedSession) {
      const session = this._preparedSession;
      this._preparedSession = undefined;
      await disposeBounded(
        session
          .dispose({
            killTrackedDetachedChildren: false,
            extensionShutdownTimeoutMs: NESTED_CLEANUP_TIMEOUT_MS,
          })
          .catch((error: unknown) => {
            console.error("[AgentTaskRuntime] Prepared session dispose failed:", error);
          }),
        "Prepared session dispose",
      );
    }
    if (this._preparedMcpAdapter) {
      const adapter = this._preparedMcpAdapter;
      this._preparedMcpAdapter = undefined;
      await disposeBounded(
        adapter.dispose().catch((error: unknown) => {
          console.error("[AgentTaskRuntime] Prepared MCP adapter dispose failed:", error);
        }),
        "Prepared MCP adapter dispose",
      );
    }
  }

  /**
   * Defensive model resolution against the runtime's own registry (created from
   * spec.agentDir, never the parent's). Marks the result failed and returns
   * undefined when the model snapshot (the frozen item model or, for a resume,
   * the seed's effectiveModel) is no longer resolvable or authenticated.
   */
  private _resolveItemModel(
    provider: string,
    modelId: string,
    result: SubagentSingleResult,
  ): Model<Api> | undefined {
    this._ensureOwnedDependencies();
    const model = this._modelRegistry!.find(provider, modelId);
    if (!model) {
      result.status = "failed";
      result.failureReason = "model_not_found";
      result.errorMessage = boundedErrorMessage(`Model "${provider}/${modelId}" was not found.`);
      return undefined;
    }
    if (!this._modelRegistry!.hasConfiguredAuth(model)) {
      result.status = "failed";
      result.failureReason = "model_auth_unavailable";
      result.errorMessage = boundedErrorMessage(`No configured credentials for ${provider}/${modelId}.`);
      return undefined;
    }
    // Detached deep-copy snapshot: no nested reference is shared with the
    // registry item; identity is not inherited.
    return structuredClone(model);
  }

  /** prepareResume variant: throws a stable code message instead of marking a result. */
  private _resolveModelOrThrow(provider: string, modelId: string): Model<Api> {
    this._ensureOwnedDependencies();
    const model = this._modelRegistry!.find(provider, modelId);
    if (!model) {
      throw new Error(`model_not_found: Model "${provider}/${modelId}" was not found.`);
    }
    if (!this._modelRegistry!.hasConfiguredAuth(model)) {
      throw new Error(`model_auth_unavailable: No configured credentials for ${provider}/${modelId}.`);
    }
    return structuredClone(model);
  }

  // =========================================================================
  // User input routing
  // =========================================================================

  /**
   * The nested session's requestUserInput closure: routes the request into the
   * AgentTaskInputRouter and returns a promise that resolves when the service
   * delivers the answer (resolveInput/cancelInput) or the nested signal aborts.
   */
  private _requestUserInput(request: RequestUserInputRequest, signal?: AbortSignal): Promise<RequestUserInputResponse> {
    return new Promise<RequestUserInputResponse>((resolve) => {
      this._pendingInputs.set(request.id, { resolve });
      // The routed generation follows the task's current generation (0 for
      // fresh tasks, the resumed generation after prepareResume) so the
      // service's taskId+requestId+generation triple validation matches.
      this._input.enqueue(this._spec.taskId, this._taskGeneration, request, signal ?? new AbortController().signal);
      if (signal) {
        const onAbort = (): void => {
          if (this._pendingInputs.delete(request.id)) {
            resolve({ id: request.id, answers: {}, cancelled: true });
          }
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }
    });
  }

  // =========================================================================
  // Event normalization (extracted from SubagentRunner._onNestedEvent)
  // =========================================================================

  private _onNestedEvent(
    event: AgentSessionEvent,
    state: TaskRunState,
    control: TaskControl,
    counters: ItemCounters,
    maxTurns: number,
    result: SubagentSingleResult,
    nested: AgentSession | undefined,
    schemaChild: boolean,
  ): void {
    // 1.5 (P3): live transcript forwarding sits at the very top (before the
    // switch) so the original per-case logic stays untouched. Gate = the
    // forwarding switch AND the whitelist; the payload is forwarded by
    // reference (no clone - structured clone happens at the service send
    // boundary); itemIndex is the runtime's current item index (same source as
    // the checkpoint activeItemIndex).
    if (this._transcriptForwarding && TRANSCRIPT_FORWARD_WHITELIST.has(event.type)) {
      this._runOnEvent?.({ type: "nested_transcript", itemIndex: this._activeItemIndex, event });
    }
    switch (event.type) {
      case "message_update": {
        if (event.message.role === "assistant") {
          counters.latestStreamingText = assistantText(event.message as AssistantMessage);
          this._emitOutput(state, counters, false);
        }
        break;
      }
      case "message_end": {
        if (event.message.role === "assistant") {
          const message = event.message as AssistantMessage;
          counters.lastAssistantMessage = message;
          const text = assistantText(message);
          if (text !== "") {
            counters.lastNonEmptyFinalizedText = text;
          }
          accumulateUsage(counters.usage, message.usage);
          this._emitOutput(state, counters, true);
          // 1.4.2: every finalized assistant message gets its own checkpoint
          // before the next event is handled (never time-throttled).
          if (this._sessionManager) {
            this._queueCheckpoint("message");
          }
        }
        break;
      }
      case "tool_execution_start": {
        counters.toolUseCount++;
        const activity: AgentTaskActivity = {
          sequence: ++state.sequence,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: "running",
          summary: summarizeActivity(event.args),
          startedAt: Date.now(),
        };
        counters.activities.push(activity);
        state.onEvent({ type: "activity", activity });
        // 1.4.2: track open tool calls and observe the structured path args of
        // read/grep/find/ls/edit/write for the workspace fingerprint.
        if (this._sessionManager) {
          this._openToolCalls.set(event.toolCallId, {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            startedAt: Date.now(),
          });
          this._observeToolPaths(event.toolName, event.args);
        }
        break;
      }
      case "tool_execution_end": {
        const activity = counters.activities.find((candidate) => candidate.toolCallId === event.toolCallId);
        if (activity && activity.status === "running") {
          activity.status = event.isError ? "failed" : "completed";
          activity.endedAt = Date.now();
          state.onEvent({ type: "activity", activity });
        }
        // Workflow schema children (design plan §4.6): a successful
        // submit_workflow_result carries the capture-validated object in its
        // details; _classifyTerminal decides completion on its presence. The
        // no-schema path never injects the tool, so the field never appears
        // there.
        if (event.toolName === STRUCTURED_OUTPUT_TOOL_NAME && !event.isError) {
          const details = (event.result as { details?: unknown } | undefined)?.details;
          result.structured =
            typeof details === "object" && details !== null && !Array.isArray(details)
              ? (details as Record<string, unknown>).structured
              : undefined;
          // terminate:true only stops the loop when EVERY tool in the batch
          // terminates. Abort the nested session here so a mixed batch cannot
          // keep running until max_turns and mask a successful capture.
          if (result.structured !== undefined) {
            control.fire("structured_complete");
          }
        }
        // 1.4.2: a complete tool result is a checkpoint safety point.
        if (this._sessionManager) {
          this._openToolCalls.delete(event.toolCallId);
          this._queueCheckpoint("tool_result");
        }
        break;
      }
      case "turn_end": {
        counters.turnCount++;
        if (counters.turnCount >= maxTurns) {
          // Only arm the limit here; abort happens on a NEW turn_start proving
          // the loop really intends another turn.
          counters.limitArmed = true;
        }
        if (
          schemaChild &&
          result.structured === undefined &&
          control.cause === undefined &&
          !counters.schemaNudgeSent &&
          maxTurns >= 2 &&
          counters.turnCount === maxTurns - 1 &&
          nested !== undefined
        ) {
          counters.schemaNudgeSent = true;
          nested.agent.followUp({
            role: "user",
            content: [{ type: "text", text: SCHEMA_CHILD_LAST_TURN_NUDGE }],
            timestamp: Date.now(),
          });
        }
        break;
      }
      case "turn_start": {
        if (counters.limitArmed) {
          counters.limitArmed = false;
          control.fire("max_turns");
        }
        break;
      }
      case "file_change": {
        // Forward observable nested edits verbatim so AgentTaskService / Plan
        // deviation detection can consume them (the legacy SubagentRunner
        // default:break dropped these; the runtime must forward them).
        state.onEvent({ type: "file_change", change: event.change, aggregate: event.aggregate });
        break;
      }
      default:
        break;
    }
  }

  /** Streaming output events; high-frequency text updates at most 10 per second. */
  private _emitOutput(state: TaskRunState, counters: ItemCounters, force: boolean): void {
    const now = Date.now();
    if (!force && now - state.lastOutputEmitAt < TEXT_UPDATE_THROTTLE_MS) {
      return;
    }
    state.lastOutputEmitAt = now;
    const truncated = truncateUtf8(counters.latestStreamingText, MAX_TASK_OUTPUT_BYTES);
    state.onEvent({
      type: "output",
      text: truncated.text,
      truncated: truncated.truncated,
      originalBytes: truncated.originalBytes,
    });
  }

  // =========================================================================
  // 1.4.2 (R2): disk-session checkpoints + incremental workspace fingerprint
  // =========================================================================

  /**
   * Queue one checkpoint emission. The emission runs on the serialized
   * fingerprint chain AFTER the current synchronous event processing (the
   * nested session appends the finalized message/toolResult entry right after
   * emitting its event), so the captured leaf is the entry the event produced.
   * The checkpoint seq is stamped by the service at write time (the event-log
   * seq); the workspace fingerprint is refreshed incrementally (only paths
   * observed since the previous refresh are re-hashed; unchanged paths reuse
   * their cached hash).
   */
  private _queueCheckpoint(reason: CheckpointReason): void {
    const taskId = this._spec.taskId;
    const activeItemIndex = this._activeItemIndex;
    const sessionFileName = reason === "item_end" ? null : this._currentSessionFileName();
    // 1.4.2 (R3): capture the item's OWN session manager at queue time. The
    // emission runs later on the serialized fingerprint chain, by which time a
    // later item's startup may have replaced this._sessionManager (or the run
    // may have released it); the leaf must always come from the session the
    // checkpoint belongs to, never from the next item's manager.
    const manager = this._sessionManager;
    const capturedOpenToolCalls = [...this._openToolCalls.values()];
    const capturedLastFinalizedEntryId = this._lastFinalizedEntryId;
    const capturedLeafId = reason === "item_end" ? null : (manager?.getLeafId() ?? null);
    const emit = (): void => {
      if (this._disposed || this._contextDisposed) {
        return;
      }
      const leafId =
        reason === "item_end"
          ? null
          : reason === "message"
            ? (manager?.getLeafId() ?? capturedLeafId)
            : capturedLeafId;
      this._runOnEvent?.({
        type: "checkpoint",
        checkpoint: {
          taskId,
          generation: this._taskGeneration,
          seq: 0, // stamped by the service with the event-log seq at write time
          activeItemIndex,
          sessionFileName,
          sessionLeafId: leafId,
          lastFinalizedEntryId:
            reason === "item_end" || reason === "message"
              ? (this._lastFinalizedEntryId ?? capturedLastFinalizedEntryId)
              : capturedLastFinalizedEntryId,
          openToolCalls: capturedOpenToolCalls,
          workspaceFingerprint: structuredClone(this._fingerprint),
          ts: Date.now(),
        },
      });
    };
    this._fingerprintChain = this._fingerprintChain.then(async () => {
      try {
        await this._refreshFingerprint();
      } catch (err) {
        // A fingerprint failure must never break the task run; the cached
        // fingerprint (possibly stale) is kept.
        console.warn("[AgentTaskRuntime] workspace fingerprint refresh failed:", err);
      }
      if (reason === "message" && !this._disposed && !this._contextDisposed) {
        const leaf = manager?.getLeafId();
        if (leaf !== null && leaf !== undefined) {
          this._lastFinalizedEntryId = leaf;
          // 1.4.2 (R3): the leaf entry id of each newly finalized model
          // assistant message is the resume success criterion.
          this._runOnEvent?.({ type: "assistant_finalized", entryId: leaf });
        }
      }
      emit();
    });
  }

  private _currentSessionFileName(): string | null {
    const file = this._sessionManager?.getSessionFile();
    return file === undefined || file === "" ? null : basename(file);
  }

  /** Collect workspace-relative logical paths from the structured tool args. */
  private _observeToolPaths(toolName: string, args: unknown): void {
    if (!FINGERPRINT_TOOLS.has(toolName)) {
      return;
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return;
    }
    const context = this._context;
    if (!context) {
      return;
    }
    const pathApi = context.isWsl ? pathPosix : pathWin32;
    const record = args as Record<string, unknown>;
    for (const field of FINGERPRINT_PATH_FIELDS) {
      const raw = record[field];
      if (typeof raw !== "string" || raw.trim() === "") {
        continue;
      }
      const absolute = this._resolveLogicalPath(raw, context);
      if (absolute === undefined || !isPathInsideCwd(absolute, context.logicalCwd, { posix: context.isWsl })) {
        continue;
      }
      const rel = pathApi.relative(context.logicalCwd, absolute);
      if (rel === "" || rel.startsWith("..") || pathApi.isAbsolute(rel)) {
        continue;
      }
      this._observedSinceCheckpoint.set(rel, absolute);
    }
  }

  private _resolveLogicalPath(input: string, context: ProjectExecutionContext): string | undefined {
    const paths = context.executionBackend?.paths;
    if (paths) {
      try {
        return paths.resolvePath(input, context.logicalCwd);
      } catch {
        return undefined;
      }
    }
    return pathWin32.resolve(context.logicalCwd, input);
  }

  /**
   * Incremental fingerprint refresh: only the paths observed since the last
   * refresh are re-hashed; every unchanged observed path reuses its cached
   * hash. WSL hashes all newly observed files AND reads the git state in ONE
   * backend bash invocation (no per-path wsl.exe roundtrips). Windows uses the
   * host filesystem plus a bounded git read.
   */
  private async _refreshFingerprint(): Promise<void> {
    const observed = this._observedSinceCheckpoint;
    this._observedSinceCheckpoint = new Map();
    if (observed.size === 0) {
      return;
    }
    const context = this._context;
    if (!context) {
      return;
    }
    if (context.isWsl && context.executionBackend?.bash) {
      await this._refreshFingerprintViaBash(observed, context.executionBackend);
    } else {
      await this._refreshFingerprintViaHost(observed);
    }
  }

  private async _refreshFingerprintViaBash(observed: Map<string, string>, backend: ExecutionBackend): Promise<void> {
    const context = this._context!;
    const bash = backend.bash!;
    const quotedPaths = [...observed.values()].map(shellSingleQuote).join(" ");
    const quotedCwd = shellSingleQuote(context.logicalCwd);
    const script =
      `for p in ${quotedPaths}; do ` +
      `if [ -f "$p" ]; then sha256sum "$p"; else printf 'PIX_MISS %s\\n' "$p"; fi; done; ` +
      `printf '\\nPIX_GIT\\n'; ` +
      `git -C ${quotedCwd} rev-parse HEAD 2>/dev/null; ` +
      `git -C ${quotedCwd} status --porcelain 2>/dev/null | head -c ${GIT_DIRTY_SUMMARY_MAX_CHARS}`;
    let output = "";
    await bash.exec(script, context.logicalCwd, {
      onData: (data: Buffer) => {
        output += data.toString("utf-8");
      },
      timeout: FINGERPRINT_BASH_TIMEOUT_SECONDS,
    });
    this._applyFingerprintBashOutput(observed, output);
  }

  private _applyFingerprintBashOutput(observed: Map<string, string>, output: string): void {
    const absToRel = new Map<string, string>();
    for (const [rel, abs] of observed) {
      absToRel.set(abs, rel);
    }
    const hashes: Record<string, string> = {};
    const gitLines: string[] = [];
    let inGit = false;
    for (const rawLine of output.split("\n")) {
      const line = rawLine.trimEnd();
      if (line === "") {
        continue;
      }
      if (line === "PIX_GIT") {
        inGit = true;
        continue;
      }
      if (!inGit) {
        const hashMatch = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
        const missMatch = /^PIX_MISS (.+)$/.exec(line);
        const abs = hashMatch ? hashMatch[2] : missMatch ? missMatch[1] : undefined;
        if (abs !== undefined) {
          const rel = absToRel.get(abs);
          if (rel !== undefined) {
            hashes[rel] = hashMatch ? hashMatch[1] : FINGERPRINT_MISSING_SENTINEL;
          }
        }
        continue;
      }
      gitLines.push(line);
    }
    for (const [rel, hash] of Object.entries(hashes)) {
      this._fingerprintCache.set(rel, hash);
    }
    this._applyGitFingerprint(gitLines);
    this._fingerprint.observedFileHashes = Object.fromEntries(this._fingerprintCache);
  }

  private async _refreshFingerprintViaHost(observed: Map<string, string>): Promise<void> {
    for (const [rel, abs] of observed) {
      this._fingerprintCache.set(rel, await this._hashHostFile(abs));
    }
    const git = await this._readHostGitState();
    this._fingerprint.isGit = git.head !== undefined || git.dirtySummary !== undefined;
    if (git.head !== undefined) {
      this._fingerprint.head = git.head;
    } else {
      delete this._fingerprint.head;
    }
    if (git.dirtySummary !== undefined) {
      this._fingerprint.dirtySummary = git.dirtySummary;
    } else {
      delete this._fingerprint.dirtySummary;
    }
    this._fingerprint.observedFileHashes = Object.fromEntries(this._fingerprintCache);
  }

  private async _hashHostFile(absolutePath: string): Promise<string> {
    try {
      const data = await readFile(absolutePath);
      return createHash("sha256").update(data).digest("hex");
    } catch {
      return FINGERPRINT_MISSING_SENTINEL;
    }
  }

  /** Best-effort host git state; a missing/broken git binary yields no git fingerprint. */
  private async _readHostGitState(): Promise<{ head?: string; dirtySummary?: string }> {
    const context = this._context!;
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

  /**
   * The first git line is HEAD when it looks like a full sha; an empty repo
   * (rev-parse fails, status still lists untracked files) treats all lines as
   * the dirty summary.
   */
  private _applyGitFingerprint(gitLines: string[]): void {
    let head: string | undefined;
    let dirtyLines: string[];
    if (gitLines.length > 0 && HEAD_SHA_RE.test(gitLines[0])) {
      head = gitLines[0];
      dirtyLines = gitLines.slice(1);
    } else {
      dirtyLines = gitLines;
    }
    this._fingerprint.isGit = head !== undefined || dirtyLines.length > 0;
    if (head !== undefined) {
      this._fingerprint.head = head;
    } else {
      delete this._fingerprint.head;
    }
    const dirty = dirtyLines.join("\n").slice(0, GIT_DIRTY_SUMMARY_MAX_CHARS);
    if (dirty !== "") {
      this._fingerprint.dirtySummary = dirty;
    } else {
      delete this._fingerprint.dirtySummary;
    }
  }

  // =========================================================================
  // Terminal classification (extracted from SubagentRunner)
  // =========================================================================

  /**
   * Await one nested `prompt()` against the item abort control. A fired cause
   * aborts the session; if the prompt still has not settled by ABORT_TIMEOUT_MS
   * the original promise keeps a rejection consumer so it cannot surface later.
   */
  private async _awaitNestedPrompt(
    nested: AgentSession,
    text: string,
    control: TaskControl,
    counters: ItemCounters,
    options?: { expandPromptTemplates?: boolean },
  ): Promise<void> {
    if (control.cause !== undefined) return;
    const promptPromise = nested.prompt(text, options);
    const settle = promptPromise.then(
      () => true,
      (error: unknown) => {
        counters.lastPromptError = error instanceof Error ? error.message : String(error);
        return false;
      },
    );
    const firstOutcome = await Promise.race([settle, control.promise]);
    if (firstOutcome !== true) {
      const abortDeadline = createDeadline(ABORT_TIMEOUT_MS);
      const outcome = await Promise.race([settle, abortDeadline.promise]);
      abortDeadline.cancel();
      if (outcome !== true) {
        promptPromise.catch(() => {});
      }
    }
  }

  /**
   * Accept a schema-valid JSON object from the child's text when it never
   * called submit_workflow_result. Skipped on user cancel so an abort cannot
   * be rewritten as a successful capture.
   */
  private _trySalvageStructured(
    schema: ObjectJsonSchema,
    result: SubagentSingleResult,
    control: TaskControl,
    counters: ItemCounters,
  ): void {
    if (result.structured !== undefined) return;
    if (control.cause === "signal" || control.cause === "abort" || control.cause === "disposed") return;
    const text =
      counters.lastNonEmptyFinalizedText !== ""
        ? counters.lastNonEmptyFinalizedText
        : assistantText(counters.lastAssistantMessage);
    const salvaged = salvageStructuredFromText(schema, text);
    if (salvaged !== undefined) {
      result.structured = salvaged;
    }
  }

  private _classifyTerminal(
    result: SubagentSingleResult,
    control: TaskControl,
    counters: ItemCounters,
    maxTurns: number,
    structuredRequired: boolean,
  ): void {
    const now = Date.now();
    const cause = control.cause;
    const last = counters.lastAssistantMessage;

    // Terminal text: the terminal message wins when non-empty; otherwise, on
    // abort/maxTurns/API error fall back to the last non-empty text (finalized
    // first, then the latest streaming text) so a synthetic empty aborted
    // message cannot erase completed work.
    const terminalText = assistantText(last);
    let finalText: string;
    if (terminalText !== "") {
      finalText = terminalText;
    } else if (cause !== undefined || last?.stopReason === "aborted" || last?.stopReason === "error") {
      finalText = counters.lastNonEmptyFinalizedText !== "" ? counters.lastNonEmptyFinalizedText : counters.latestStreamingText;
    } else {
      finalText = "";
    }

    const capturedStructured = structuredRequired ? result.structured : undefined;
    const userCancelled = cause === "signal" || cause === "abort" || cause === "disposed";
    if (capturedStructured !== undefined && !userCancelled) {
      // A successful capture is the completion criterion. max_turns and the
      // host abort after submit must not mask it (mixed tool batches do not
      // honor terminate:true unless every call in the batch terminates).
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(capturedStructured);
      } catch {
        serialized = undefined;
      }
      if (serialized === undefined) {
        result.status = "failed";
        result.failureReason = "invalid_parameters";
        result.errorMessage = boundedErrorMessage("The submitted structured result is not JSON-serializable.");
      } else {
        result.status = "completed";
        result.failureReason = undefined;
        result.errorMessage = undefined;
        finalText = serialized;
      }
    } else if (cause !== undefined) {
      if (cause === "max_turns") {
        result.status = "failed";
        result.failureReason = "max_turns";
        result.errorMessage = boundedErrorMessage(`The agent exceeded its turn limit (${maxTurns}).`);
      } else if (cause === "structured_complete") {
        // Capture recorded no structured value (should not happen); treat as
        // a missing submit rather than a user abort.
        result.status = "failed";
        result.failureReason = "invalid_parameters";
        result.errorMessage = boundedErrorMessage(
          "The workflow child did not submit the structured result (missing submit_workflow_result tool call).",
        );
      } else {
        result.status = "aborted";
        result.failureReason = "aborted";
        result.errorMessage = boundedErrorMessage(this._causeMessage(cause));
      }
    } else if (counters.lastPromptError !== undefined) {
      result.status = "failed";
      result.failureReason = "internal_error";
      result.errorMessage = boundedErrorMessage(counters.lastPromptError);
    } else if (last?.stopReason === "error") {
      result.status = "failed";
      result.failureReason = "api_error";
      result.errorMessage = boundedErrorMessage(last.errorMessage ?? "The nested agent reported an API error.");
    } else if (last?.stopReason === "aborted") {
      result.status = "aborted";
      result.failureReason = "aborted";
      result.errorMessage = boundedErrorMessage("The nested agent was aborted.");
    } else if (structuredRequired) {
      result.status = "failed";
      result.failureReason = "invalid_parameters";
      result.errorMessage = boundedErrorMessage(
        "The workflow child did not submit the structured result (missing submit_workflow_result tool call).",
      );
    } else {
      result.status = "completed";
    }

    const truncated = truncateUtf8(finalText, MAX_TASK_OUTPUT_BYTES);
    result.finalOutput = truncated.text;
    result.outputTruncated = truncated.truncated;
    result.originalOutputBytes = truncated.originalBytes;
    result.toolUseCount = counters.toolUseCount;
    result.activities = this._convergeActivities(counters, now);
    counters.usage.turns = counters.turnCount;
    result.usage = { ...counters.usage };
    result.endedAt = now;
    result.durationMs = Math.max(0, now - (result.startedAt ?? now));
  }

  /** Keep the most-recent activities and fail any still-running one. */
  private _convergeActivities(counters: ItemCounters, now: number): SubagentActivity[] {
    const converged: SubagentActivity[] = counters.activities.map((activity) =>
      activity.status === "running" ? { ...activity, status: "failed", endedAt: now } : activity,
    );
    return converged.slice(-MAX_RECENT_ACTIVITIES);
  }

  // =========================================================================
  // Result helpers
  // =========================================================================

  private _causeMessage(cause: TerminationCause): string {
    switch (cause) {
      case "signal":
        return "The agent task was cancelled.";
      case "abort":
        return "The agent task was aborted.";
      case "disposed":
        return "The agent task runtime was disposed.";
      case "max_turns":
        return "The agent exceeded its turn limit.";
      case "structured_complete":
        return "The workflow child submitted its structured result.";
    }
  }

  private _chainPrompt(
    item: AgentTaskItemSpec & { resolution: "ready" },
    previousOutput: string | undefined,
    result: SubagentSingleResult,
  ): string | null {
    if (previousOutput === undefined) {
      // First step (and every single-mode item): {previous} is the empty
      // string.
      return item.prompt.replaceAll("{previous}", "");
    }
    const prompt = item.prompt.replaceAll("{previous}", previousOutput);
    if (utf8ByteLength(prompt) > MAX_DELEGATED_PROMPT_BYTES) {
      result.status = "failed";
      result.failureReason = "prompt_too_large";
      result.errorMessage = boundedErrorMessage(
        `The delegated prompt with {previous} substitution exceeds ${MAX_DELEGATED_PROMPT_BYTES} bytes.`,
      );
      result.endedAt = Date.now();
      result.durationMs = 0;
      return null;
    }
    return prompt;
  }

  /** Frozen preflight failure: no session was ever created for this item. */
  private _makeRejectedResult(item: AgentTaskItemSpec & { resolution: "rejected" }): SubagentSingleResult {
    const result = this._makeItemResult(item);
    result.status = "failed";
    // A rejected item's reason comes from the 1.4.1 subagent set (project
    // denial, unknown agent, model failures, ...), which is a subset of
    // SubagentFailureReason.
    result.failureReason = item.failureReason as SubagentFailureReason;
    result.errorMessage = boundedErrorMessage(item.errorMessage);
    result.endedAt = Date.now();
    result.durationMs = 0;
    return result;
  }

  private _makeItemResult(item: AgentTaskItemSpec): SubagentSingleResult {
    return {
      id: randomUUID(),
      index: item.index,
      step: this._spec.mode === "chain" ? item.index + 1 : undefined,
      agentName: item.resolution === "ready" ? item.agent.name : item.requestedAgentName ?? "general-purpose",
      agentSource: item.resolution === "ready" ? item.agent.source : "unknown",
      description: item.description,
      status: "queued",
      finalOutput: "",
      outputTruncated: false,
      originalOutputBytes: 0,
      toolUseCount: 0,
      activities: [],
      usage: emptyUsage(),
      model: item.resolution === "ready" ? `${item.model.provider}/${item.model.modelId}` : undefined,
      durationMs: 0,
    };
  }

  /** Run-level failure with no item context (empty spec / unexpected error). */
  private _makeFailedRunResult(reason: "invalid_parameters" | "internal_error", message: string): SubagentSingleResult {
    return {
      id: randomUUID(),
      index: 0,
      agentName: "general-purpose",
      agentSource: "unknown",
      description: "",
      status: "failed",
      finalOutput: "",
      outputTruncated: false,
      originalOutputBytes: 0,
      toolUseCount: 0,
      activities: [],
      usage: emptyUsage(),
      failureReason: reason,
      errorMessage: boundedErrorMessage(message),
      endedAt: Date.now(),
      durationMs: 0,
    };
  }

  private _markAborted(result: SubagentSingleResult, cause: TerminationCause, message: string): void {
    result.status = "aborted";
    result.failureReason = "aborted";
    result.errorMessage = boundedErrorMessage(message);
    result.endedAt = Date.now();
    result.durationMs = result.startedAt === undefined ? 0 : Math.max(0, result.endedAt - result.startedAt);
    // Converge any still-running activity to failed.
    for (const activity of result.activities) {
      if (activity.status === "running") {
        activity.status = "failed";
        activity.endedAt = result.endedAt;
      }
    }
  }

  /** Convert an unexpected run-level failure into a bounded failed result. */
  private _failCurrentResult(state: TaskRunState, error: unknown): void {
    const now = Date.now();
    const current = state.results[state.results.length - 1];
    if (current && (current.status === "queued" || current.status === "running")) {
      current.status = "failed";
      current.failureReason = "internal_error";
      current.errorMessage = boundedErrorMessage(error instanceof Error ? error.message : String(error));
      current.endedAt = now;
      current.durationMs = Math.max(0, now - (current.startedAt ?? now));
      for (const activity of current.activities) {
        if (activity.status === "running") {
          activity.status = "failed";
          activity.endedAt = now;
        }
      }
      return;
    }
    state.results.push(this._makeFailedRunResult("internal_error", error instanceof Error ? error.message : String(error)));
  }

  private _aggregateUsage(results: SubagentSingleResult[]): AgentTaskUsage {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;
    let turns = 0;
    for (const result of results) {
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

  private _mergeActivities(results: SubagentSingleResult[]): AgentTaskActivity[] {
    const merged: AgentTaskActivity[] = [];
    for (const result of results) {
      merged.push(...result.activities);
    }
    return merged.slice(-MAX_RECENT_ACTIVITIES);
  }
}
