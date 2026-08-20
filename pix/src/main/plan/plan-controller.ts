/**
 * Solo Plan state machine and execution coordinator (PiX-1.4-PLAN.md §4.3).
 *
 * Owned by SessionBridge. The controller is the single authority for the Plan
 * runtime state: generation lifecycle (enter/retry/regenerate/revision),
 * submit validation (generationId guard + validatePlanDraft), approval and
 * explicit execution start, step transitions (update_plan_step), the
 * planning/revising tool allowlist (decideToolPolicy), parent request_user_input
 * waiting and file/command deviation detection. Every transition persists a
 * full PlanRuntimeSnapshot CustomEntry and emits controller events; product
 * events go through the injected collector.
 *
 * 1.4.1 scope gates (locked): release "1.4.2" (subagent_background allowed),
 * task-group fields (waitingTaskGroupId/consumedTaskGroupId/
 * consumedTaskSummary, pendingTaskLinkReleases) with two-phase consumption,
 * session-close keeps task-linked waiting steps. 1.4.2 (R4): task-linked
 * steps hydrate as "interrupted" (non-terminal, link facts kept) instead of
 * failed, and are consumed via continuePlan with the same groupId. No task
 * persistence (1.4.2 R2).
 */

import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentExecutionMode,
  AgentSession,
  AgentSessionEvent,
  FileChangeSummary,
  HostToolPolicyInput,
  RequestUserInputHandler,
  SessionEntry,
  SessionManager,
  ToolPolicyDecision,
  TurnDiffSummary,
} from "@earendil-works/pi-coding-agent";
import type { ClipboardImage, ThinkingLevel } from "../../shared/types.js";
import type { ProjectLocation } from "../../shared/project-location.js";
import type { ProductEvent, ProductEventPayload } from "../../shared/product-events.js";
import type { ProjectExecutionContext } from "../execution-context.js";
import {
  PLAN_ALLOWLIST,
  PLAN_RUNTIME_RELEASE,
  PLAN_SCHEMA_VERSION,
  PLAN_STEP_TRANSITIONS,
  type PendingPlanTaskLinkRelease,
  type Plan,
  type PlanCancelRef,
  type PlanDeviation,
  type PlanGenerationFailure,
  type PlanGenerationState,
  type PlanRuntimeSnapshot,
  type PlanStep,
  type PlanStatus,
} from "../../shared/plan-types.js";
import type {
  PlanValidationContext,
  PlanValidationResult,
  SubmitUserPlanParams,
  UpdatePlanStepParams,
} from "./plan-deviation.js";
import {
  detectCommandDeviation,
  detectFileDeviation,
  validatePlanDraft,
  type PlanPathContext,
} from "./plan-deviation.js";
import {
  PLAN_CONTEXT_MESSAGE_TYPE,
  PLAN_CUSTOM_TYPE,
  PLAN_RETRY_MESSAGE_TYPE,
  rebuildPlanFromEntries,
  serializePlanContextMessage,
  serializePlanGenerationContext,
  serializePlanRecord,
  type RebuiltPlanRecord,
} from "./plan-persistence.js";

export type { PlanValidationContext, PlanValidationResult } from "./plan-deviation.js";

export const PLAN_GENERATION_TIMEOUT_MS = 600_000;
export const PLAN_MAX_DEVIATIONS = 50;
export const PLAN_ABORT_SETTLE_MS = 5_000;

export type PlanDisposeReason = "session_close" | "app_shutdown" | "host_disposed";
/** app_restart: crash/shutdown hydration rewrites waiting_input(agent_task) to interrupted. session_reopen: keep waiting_input. */
export type PlanTaskLinkHydration = "app_restart" | "session_reopen";

export interface PlanStepExecutionLink {
  planId: string;
  version: number;
  stepId: string;
}

/** Main-only adapter type for the planning entry; ClipboardImage comes from shared/types.ts. */
export interface PlanUserRequest {
  text: string;
  filePaths?: string[];
  images?: ClipboardImage[];
}

export type StepDelegateResult =
  | { stepId: string; status: "result"; summary: string; deviations?: PlanDeviation[]; groupId?: string }
  | { stepId: string; status: "failed"; summary: string; deviations?: PlanDeviation[]; groupId?: string }
  | { stepId: string; status: "backgrounded"; groupId: string; taskIds: string[] }; // 1.4.1 起返回；最小 link，不让 Plan 层依赖 AgentTask UI 类型

/**
 * One observable file change of a Plan-linked background task (1.4.1); the
 * SessionBridge adapter forwards the service's main-only task_file_change
 * events filtered by planLink.
 */
export interface PlanLinkedTaskFileChangeEvent {
  taskId: string;
  planId: string;
  version: number;
  stepId: string;
  change: FileChangeSummary;
  aggregate: TurnDiffSummary;
}

export type PlanControllerEvent =
  | { type: "plan_state"; snapshot: PlanRuntimeSnapshot }
  | { type: "plan_step"; planId: string; version: number; step: PlanStep }
  | { type: "plan_deviation"; deviation: PlanDeviation };

export interface PlanControllerContext {
  // borrowed; never disposed by the controller
  getSession: () => AgentSession;
  /** Persistence surface: CustomEntry only, never enters the live turn. */
  getSessionManager: () => SessionManager;
  getProjectLocation: () => ProjectLocation;
  getExecutionContext: () => ProjectExecutionContext;
  getExecutionMode: () => AgentExecutionMode;
  resolvePlanningModel: () => { model: Model<Api>; thinkingLevel: ThinkingLevel } | { error: string };
  /** Reuses SessionBridge _preparePromptInput and writes the ONE visible user message. */
  promptPlanningRequest: (request: PlanUserRequest) => Promise<void>;
  requestUserInput: RequestUserInputHandler;
  recordProductEvent: (e: ProductEvent) => void;
  /** 1.4.0: foreground only; 1.4.1 adds background delegation via AgentTaskService. */
  delegateSubagentStep?: (
    step: PlanStep,
    link: PlanStepExecutionLink,
    presentation: "foreground" | "background",
  ) => Promise<StepDelegateResult>;
  /** 1.4.1: Plan-linked background task file changes, provided by the SessionBridge adapter. */
  subscribePlanLinkedTaskEvents?: (listener: (event: PlanLinkedTaskFileChangeEvent) => void) => () => void;
  /** 1.4.1: read-only group result (two-phase consumption); the group must be terminal. */
  getPlanTaskGroupResult?: (
    groupId: string,
    link: PlanStepExecutionLink,
  ) => Promise<
    | { ok: true; status: "completed" | "failed" | "cancelled"; taskIds: string[]; summary: string }
    | { ok: false; reason: string }
  >;
  /** 1.4.1: idempotent consumption confirm (pending -> consumed on every linked task). */
  confirmPlanTaskGroupConsumed?: (groupId: string, link: PlanStepExecutionLink) => Promise<void>;
  /** 1.4.1: idempotent link release after a successful revision or overall cancel. */
  releasePlanTaskGroup?: (
    groupId: string,
    link: PlanStepExecutionLink,
    reason: "plan_revised" | "plan_cancelled",
  ) => Promise<void>;
}

/** One generation with a live model turn; settle events bind to it. */
interface LiveGeneration {
  generationId: string;
}

/** A live request_user_input tool call: toolCallId -> stepId. */
interface WaitingInputEntry {
  stepId: string;
}

const INITIAL_PHASE: PlanStatus = "cancelled";

function makeInitialSnapshot(): PlanRuntimeSnapshot {
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    phase: INITIAL_PHASE,
    planId: null,
    plan: null,
    deviations: [],
    updatedAt: Date.now(),
  };
}

function isRetryableFailure(failure: PlanGenerationFailure | undefined): failure is PlanGenerationFailure {
  return failure !== undefined && failure.retryable === true;
}

export class PlanController {
  private readonly _ctx: PlanControllerContext;
  private readonly _generationTimeoutMs: number;
  private readonly _abortSettleMs: number;
  private _disposed = false;

  private _snapshot: PlanRuntimeSnapshot;
  private _sequence = 0;

  private _listeners = new Set<(e: PlanControllerEvent) => void>();
  private _sessionUnsubscribe: (() => void) | undefined;

  /** Frozen parent model/thinking/tools captured at FIRST enter, before any switch. */
  private _frozenParent: { model: Model<Api> | undefined; thinkingLevel: ThinkingLevel } | undefined;
  private _frozenTools: string[] | undefined;

  private _liveGeneration: LiveGeneration | undefined;
  /**
   * Generation whose live turn was aborted (watchdog timeout / user cancel /
   * invalid-plan rejection) and whose late settle has not arrived yet. While
   * set, _liveGeneration is retained so a retry cannot start a new generation
   * that the stale settle would mis-attribute and kill; _onTurnSettled treats
   * the matching settle as cleanup-only (Plan 616: old generation settle/tool
   * events are diagnostic only, never overwrite a newer generation).
   */
  private _abortPendingGenerationId: string | undefined;
  /**
   * The next agent_end belongs to a turn we already aborted (generation or
   * execution). Kept across `_startGeneration` / `_resetPlanRuntime` so a
   * late settle after a newer generation started is diagnostic-only when the
   * new turn is still streaming (Plan 616). Consumed by the next settle.
   */
  private _staleSettlePending = false;
  private _watchdog: ReturnType<typeof setTimeout> | undefined;
  private _watchdogGenerationId: string | undefined;
  private _lastAssistantStopReason: string | undefined;

  private readonly _waitingInputByToolCall = new Map<string, WaitingInputEntry>();
  /** Foreground (and in-flight) Plan-linked groups awaiting consume/release. */
  private readonly _planLinkedGroups = new Map<string, { groupId: string; link: PlanStepExecutionLink }>();
  private _delegatingStepId: string | undefined;
  private _executionWatchdog: ReturnType<typeof setTimeout> | undefined;
  private _executionTurnId = 0;
  private _pendingExecutionTurnId: number | undefined;
  private _liveClearedWaiters: Array<() => void> = [];

  /** 1.4.1: Plan-linked background task file-change subscription (adapter-provided). */
  private _planLinkedTaskUnsubscribe: (() => void) | undefined;

  constructor(ctx: PlanControllerContext, opts?: { generationTimeoutMs?: number; abortSettleMs?: number }) {
    this._ctx = ctx;
    this._generationTimeoutMs = opts?.generationTimeoutMs ?? PLAN_GENERATION_TIMEOUT_MS;
    this._abortSettleMs = opts?.abortSettleMs ?? PLAN_ABORT_SETTLE_MS;
    this._snapshot = makeInitialSnapshot();
    if (ctx.subscribePlanLinkedTaskEvents) {
      this._planLinkedTaskUnsubscribe = ctx.subscribePlanLinkedTaskEvents((event) => {
        this._onPlanLinkedTaskFileChange(event);
      });
    }
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Enter planning. First entry requires a non-empty request; the SAME request
   * is written exactly once as the visible user message via
   * ctx.promptPlanningRequest (never duplicated as a CustomMessage). Dormant
   * planning (phase=planning after close) and planning_failed/revising
   * retries may pass undefined and are resumed with a pix-plan-retry message;
   * passing a request on a non-first entry is rejected
   * (request_only_allowed_on_first_entry).
   */
  async enterPlanning(
    request: PlanUserRequest | undefined,
    _source?: "configured" | "session",
    concise?: boolean,
  ): Promise<{ ok: boolean; generationId?: string; reason?: string }> {
    if (this._disposed) {
      return { ok: false, reason: "disposed" };
    }
    const session = this._ctx.getSession();
    if (session.isStreaming) {
      return { ok: false, reason: "session_busy" };
    }
    if (this._liveGeneration !== undefined) {
      return { ok: false, reason: "generation_in_progress" };
    }
    const phase = this._snapshot.phase;
    const firstEnter = this._snapshot.planId === null;
    const reenterFromTerminal = phase === "completed" || phase === "cancelled" || phase === "failed";
    if (firstEnter || reenterFromTerminal) {
      if (!request || typeof request.text !== "string" || request.text.trim() === "") {
        return { ok: false, reason: "empty_request" };
      }
    } else if (request && typeof request.text === "string" && request.text.trim() !== "") {
      // Retry reuses the persisted first request (pix-plan-retry message);
      // a fresh request on a non-first entry would otherwise be silently
      // dropped, so reject it explicitly.
      return { ok: false, reason: "request_only_allowed_on_first_entry" };
    } else if (phase !== "planning" && phase !== "planning_failed" && phase !== "revising") {
      return { ok: false, reason: `cannot enter planning from phase "${phase}"` };
    }

    if (reenterFromTerminal) {
      this._resetPlanRuntime();
    }
    if (firstEnter || reenterFromTerminal) {
      this._snapshot.planId = randomUUID();
      this._freezeParentSnapshot();
      this._recordEvent("plan_mode_entered", {});
    }

    const isRevision = phase === "revising";
    const resolved = this._ctx.resolvePlanningModel();
    const generationId = this._startGeneration(
      isRevision ? "revision" : "initial",
      isRevision ? this._snapshot.revision!.requestedVersion : 0,
      concise === true,
      "error" in resolved
        ? (this._snapshot.plan?.planningModel ?? this._frozenModelSnapshot())
        : this._modelSnapshot(resolved.model, resolved.thinkingLevel),
    );
    if ("error" in resolved) {
      this._failGeneration(resolved.error === "auth_unavailable" ? "auth_unavailable" : "model_unavailable", resolved.error, true);
      return { ok: true, generationId };
    }
    const prepared = await this._prepareGeneration(resolved.model, resolved.thinkingLevel);
    if (!prepared) {
      return { ok: true, generationId };
    }
    await this._launchGenerationTurn(firstEnter || reenterFromTerminal, request, concise === true);
    return { ok: true, generationId };
  }

  /** Retry a failed generation with the configured planning model. */
  async retryGeneration(generationId: string): Promise<{ ok: boolean; generationId?: string; reason?: string }> {
    return this._retryGeneration(generationId, false);
  }

  /** Retry a failed generation with the frozen first-enter parent model/thinking. */
  async useSessionModelAndRetry(generationId: string): Promise<{ ok: boolean; generationId?: string; reason?: string }> {
    return this._retryGeneration(generationId, true);
  }

  /** Regenerate with a concise prompt (truncated / over-limit plans). */
  async regeneratePlan(
    generationId: string,
    concise: boolean,
  ): Promise<{ ok: boolean; generationId?: string; reason?: string }> {
    if (generationId !== this._retryToken()) {
      return { ok: false, reason: "stale_generation" };
    }
    const phase = this._snapshot.phase;
    if (phase !== "planning" && phase !== "planning_failed" && phase !== "revising") {
      return { ok: false, reason: `cannot regenerate from phase "${phase}"` };
    }
    if (this._liveGeneration !== undefined) {
      return { ok: false, reason: "generation_in_progress" };
    }
    if (this._ctx.getSession().isStreaming) {
      return { ok: false, reason: "session_busy" };
    }
    const isRevision = phase === "revising";
    const resolved = this._ctx.resolvePlanningModel();
    const generationId2 = this._startGeneration(
      isRevision ? "revision" : "regenerate",
      isRevision ? this._snapshot.revision!.requestedVersion : 0,
      concise,
      "error" in resolved
        ? (this._snapshot.plan?.planningModel ?? this._frozenModelSnapshot())
        : this._modelSnapshot(resolved.model, resolved.thinkingLevel),
    );
    if ("error" in resolved) {
      this._failGeneration(resolved.error === "auth_unavailable" ? "auth_unavailable" : "model_unavailable", resolved.error, true);
      return { ok: true, generationId: generationId2 };
    }
    const prepared = await this._prepareGeneration(resolved.model, resolved.thinkingLevel);
    if (!prepared) {
      return { ok: true, generationId: generationId2 };
    }
    await this._launchGenerationTurn(false, undefined, concise);
    return { ok: true, generationId: generationId2 };
  }

  /**
   * Accept (or reject) the model-submitted plan. Initial failures become
   * planning_failed; revision failures keep revising + lastValidPlan and never
   * fabricate a half-valid new version.
   */
  async submitPlan(modelPlan: SubmitUserPlanParams): Promise<{
    accepted: boolean;
    snapshot: PlanRuntimeSnapshot;
    fieldErrors?: Array<{ path: string; message: string }>;
  }> {
    const generation = this._snapshot.generation;
    if (!generation || generation.generationId !== modelPlan.generationId) {
      return {
        accepted: false,
        snapshot: this._snapshot,
        fieldErrors: [{ path: "generationId", message: "stale or unknown generationId." }],
      };
    }
    if (generation.kind === "revision" && modelPlan.basedOnVersion !== this._snapshot.revision?.baseVersion) {
      return this._rejectSubmission(generation, [
        { path: "basedOnVersion", message: `revision must carry basedOnVersion=${this._snapshot.revision?.baseVersion}.` },
      ]);
    }

    const validation = await this._validateDraft(modelPlan);
    if (!validation.ok) {
      return this._rejectSubmission(generation, validation.fieldErrors);
    }

    // Accepted: build the next version atomically.
    const now = Date.now();
    const basePlan = this._snapshot.plan;
    const stepIdByKey = new Map<string, string>();
    const steps: PlanStep[] = validation.normalizedSteps!.map((draftStep) => {
      const stepId = randomUUID();
      stepIdByKey.set(draftStep.stepKey, stepId);
      return {
        stepKey: draftStep.stepKey,
        stepId,
        title: draftStep.title,
        description: draftStep.description,
        files: draftStep.files ?? [],
        scopeNote: draftStep.scopeNote,
        expectedCommands: draftStep.expectedCommands,
        executionTarget: draftStep.executionTarget,
        risk: draftStep.risk,
        riskReason: draftStep.riskReason,
        effort: draftStep.effort,
        verification: draftStep.verification,
        dependsOn: draftStep.dependsOn.map((key) => stepIdByKey.get(key) ?? "").filter((id) => id !== ""),
        status: "pending",
        waitingReason: "",
      };
    });

    const plan: Plan = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: this._snapshot.planId!,
      // 首版从 1 递增；修订候选是 requestedVersion（baseVersion + 1）。
      version: generation.kind === "revision" ? generation.requestedVersion : 1,
      status: "awaiting_approval",
      title: modelPlan.title,
      summary: modelPlan.summary,
      planningModel: generation.model,
      steps,
      createdAt: basePlan?.createdAt ?? now,
      updatedAt: now,
    };

    this._snapshot.plan = plan;
    this._snapshot.phase = "awaiting_approval";
    this._snapshot.lastValidPlan = undefined;
    this._snapshot.revision = undefined;
    this._snapshot.failure = undefined;
    this._snapshot.generation = undefined;
    this._snapshot.updatedAt = now;
    this._clearWatchdog();
    this._liveGeneration = undefined;
    this._restoreParentState();
    // 1.4.1 revision release: only a successful atomic publish of version+1
    // releases the old version's still-pending task links (plan_revised).
    // requestRevision itself never releases, so a failed revision +
    // returnToPreviousVersion restores the base with its links untouched.
    if (generation.kind === "revision" && basePlan) {
      await this._releaseTaskLinks(this._collectTaskLinkIntents(basePlan, "plan_revised"));
    }
    this._commit("plan_generation_succeeded");
    this._recordEvent("plan_generation_succeeded", {
      version: plan.version,
      status: "awaiting_approval",
      model: plan.planningModel,
    });
    return { accepted: true, snapshot: this._snapshot };
  }

  /**
   * Start a revision of the given version. The full base is saved as
   * lastValidPlan, phase/plan.status become revising; a failed revision keeps
   * this state (retry keeps requesting the same requestedVersion) until
   * returnToPreviousVersion restores the base.
   */
  async requestRevision(
    planId: string,
    version: number,
    feedback: string,
    stepKey?: string,
  ): Promise<{ ok: boolean; generationId?: string; reason?: string }> {
    const mismatch = this._versionMismatch(planId, version);
    if (mismatch) {
      return { ok: false, reason: mismatch };
    }
    if (this._disposed) {
      return { ok: false, reason: "disposed" };
    }
    if (this._snapshot.phase !== "awaiting_approval" && this._snapshot.phase !== "paused") {
      return { ok: false, reason: `cannot revise from phase "${this._snapshot.phase}"` };
    }
    if (typeof feedback !== "string" || feedback.trim() === "") {
      return { ok: false, reason: "empty_feedback" };
    }
    if (this._liveGeneration !== undefined) {
      return { ok: false, reason: "generation_in_progress" };
    }
    if (this._ctx.getSession().isStreaming) {
      return { ok: false, reason: "session_busy" };
    }
    const plan = this._snapshot.plan!;
    this._snapshot.lastValidPlan = structuredClone(plan);
    this._snapshot.revision = {
      baseVersion: version,
      requestedVersion: version + 1,
      feedback: feedback.trim(),
      stepKey,
    };
    plan.status = "revising";
    this._snapshot.phase = "revising";
    this._snapshot.failure = undefined;
    this._snapshot.updatedAt = Date.now();
    this._commit("plan_revision_requested");
    this._recordEvent("plan_revision_requested", { version: plan.version, status: "revising" });

    const resolved = this._ctx.resolvePlanningModel();
    const generationId = this._startGeneration(
      "revision",
      version + 1,
      false,
      "error" in resolved
        ? (this._snapshot.plan?.planningModel ?? this._frozenModelSnapshot())
        : this._modelSnapshot(resolved.model, resolved.thinkingLevel),
    );
    if ("error" in resolved) {
      this._failGeneration(resolved.error === "auth_unavailable" ? "auth_unavailable" : "model_unavailable", resolved.error, true);
      return { ok: true, generationId };
    }
    const prepared = await this._prepareGeneration(resolved.model, resolved.thinkingLevel);
    if (!prepared) {
      return { ok: true, generationId };
    }
    await this._launchGenerationTurn(false, undefined, false, feedback.trim(), stepKey);
    return { ok: true, generationId };
  }

  /** Explicitly fall back to the last valid version after a failed revision. */
  returnToPreviousVersion(planId: string, baseVersion: number): { ok: boolean; reason?: string } {
    if (this._disposed) {
      return { ok: false, reason: "disposed" };
    }
    const mismatch = this._versionMismatch(planId, baseVersion);
    if (mismatch) {
      return { ok: false, reason: mismatch };
    }
    if (this._snapshot.phase !== "revising" || !this._snapshot.lastValidPlan) {
      return { ok: false, reason: "not_in_revision" };
    }
    if (this._snapshot.lastValidPlan.version !== baseVersion) {
      return { ok: false, reason: "stale_version" };
    }
    if (this._liveGeneration !== undefined) {
      this._abortPendingGenerationId = this._liveGeneration.generationId;
      this._abortLiveTurn();
      // Keep _liveGeneration until the aborted turn settles so a follow-up
      // revision/enter is gated by generation_in_progress (Plan 616).
    }
    this._clearWatchdog();
    this._clearExecutionWatchdog();
    this._snapshot.generation = undefined;
    const base = structuredClone(this._snapshot.lastValidPlan);
    const restoredPhase = base.status === "paused" ? "paused" : "awaiting_approval";
    base.status = restoredPhase;
    this._snapshot.plan = base;
    this._snapshot.phase = restoredPhase;
    this._snapshot.lastValidPlan = undefined;
    this._snapshot.revision = undefined;
    this._snapshot.failure = undefined;
    this._snapshot.updatedAt = Date.now();
    this._restoreParentState();
    this._commit("plan_revision_fallback");
    return { ok: true };
  }

  /** awaiting_approval -> approved; restores the parent model/tools, never auto-executes. */
  async approve(planId: string, version: number): Promise<{ ok: boolean; reason?: string }> {
    if (this._disposed) {
      return { ok: false, reason: "disposed" };
    }
    const mismatch = this._versionMismatch(planId, version);
    if (mismatch) {
      return { ok: false, reason: mismatch };
    }
    if (this._snapshot.phase !== "awaiting_approval") {
      return { ok: false, reason: `cannot approve from phase "${this._snapshot.phase}"` };
    }
    if (this._ctx.getSession().isStreaming) {
      return { ok: false, reason: "session_busy" };
    }
    this._snapshot.phase = "approved";
    this._snapshot.plan!.status = "approved";
    this._snapshot.updatedAt = Date.now();
    this._restoreParentState();
    this._commit("plan_approved");
    this._recordEvent("plan_approved", { version, status: "approved" });
    return { ok: true };
  }

  /** approved/paused -> executing; read-only rejects and keeps the state. */
  async startExecution(planId: string, version: number): Promise<{ ok: boolean; reason?: string }> {
    if (this._disposed) {
      return { ok: false, reason: "disposed" };
    }
    const mismatch = this._versionMismatch(planId, version);
    if (mismatch) {
      return { ok: false, reason: mismatch };
    }
    if (this._snapshot.phase !== "approved" && this._snapshot.phase !== "paused") {
      return { ok: false, reason: `cannot start execution from phase "${this._snapshot.phase}"` };
    }
    if (this._ctx.getSession().isStreaming) {
      return { ok: false, reason: "session_busy" };
    }
    const mode = this._ctx.getExecutionMode();
    if (mode === "read-only") {
      return { ok: false, reason: "read_only" };
    }
    // 1.4.1/1.4.2: a waiting background task step (waiting_input or hydrated
    // interrupted) must go through continuePlan; startExecution must never
    // bypass the two-phase consumption.
    const plan = this._snapshot.plan!;
    if (
      plan.steps.some(
        (step) =>
          (step.status === "waiting_input" || step.status === "interrupted") &&
          step.waitingReason === "agent_task",
      )
    ) {
      return { ok: false, reason: "background_task_waiting" };
    }
    if (plan.steps.some((step) => step.status === "failed")) {
      return { ok: false, reason: "failed_step_pending" };
    }
    return this._advanceExecution(version, true);
  }

  /** Cancel a plan (valid version) or an in-flight generation (no valid plan). */
  async cancel(ref: PlanCancelRef): Promise<{ ok: boolean; reason?: string }> {
    if (this._disposed) {
      return { ok: false, reason: "disposed" };
    }
    if ("generationId" in ref) {
      if (this._snapshot.planId !== null && ref.planId !== this._snapshot.planId) {
        return { ok: false, reason: "stale_plan" };
      }
      if (ref.generationId !== this._retryToken()) {
        return { ok: false, reason: "stale_generation" };
      }
      if (this._snapshot.plan !== null) {
        return { ok: false, reason: "plan_exists" };
      }
      // No valid plan yet: cancel the generation.
      this._clearWatchdog();
      const generation = this._snapshot.generation;
      // Keep the live marker: the aborted turn's settle is still in flight
      // and must be attributed to THIS generation (cleanup only), never to a
      // newer generation started after the cancel.
      this._abortPendingGenerationId = generation?.generationId ?? ref.generationId;
      this._snapshot.failure = {
        generationId: generation?.generationId ?? ref.generationId,
        phase: generation?.kind === "revision" ? "revision" : "initial",
        code: "cancelled",
        message: "The plan generation was cancelled by the user.",
        fieldErrors: [],
        retryable: false,
        occurredAt: Date.now(),
      };
      this._snapshot.generation = undefined;
      this._snapshot.phase = "cancelled";
      this._snapshot.updatedAt = Date.now();
      this._abortLiveTurn();
      this._restoreParentState();
      this._commit("plan_generation_cancelled");
      this._recordEvent("plan_generation_cancelled", {});
      await this._awaitLiveCleared(this._abortSettleMs);
      return { ok: true };
    }
    // Valid plan: overall cancel.
    const mismatch = this._versionMismatch(ref.planId, ref.version);
    if (mismatch) {
      return { ok: false, reason: mismatch };
    }
    const phase = this._snapshot.phase;
    if (
      phase !== "awaiting_approval" &&
      phase !== "approved" &&
      phase !== "paused" &&
      phase !== "executing" &&
      phase !== "revising"
    ) {
      return { ok: false, reason: `cannot cancel from phase "${phase}"` };
    }
    const plan = this._snapshot.plan!;
    // 1.4.1: an overall user cancel releases the still-pending task links
    // (plan_cancelled) so cleanup protection is lifted; consumed groups stay
    // consumed (cancelled is NOT a release path). The intents are collected
    // BEFORE the step fields are cleared below.
    const releaseIntents = this._collectTaskLinkIntents(plan, "plan_cancelled");
    this._clearWatchdog();
    this._clearExecutionWatchdog();
    // Symmetric with the generation-id cancel path: keep the live marker so
    // the aborted turn's settle is cleanup-only, and wait until that settle
    // (or the bounded timeout) before returning. Clearing both here would let
    // enterPlanning start a new generation whose first agent_end is the old
    // turn's late settle (Plan 616).
    if (this._liveGeneration !== undefined) {
      this._abortPendingGenerationId = this._liveGeneration.generationId;
    }
    this._abortLiveTurn();
    this._snapshot.phase = "cancelled";
    plan.status = "cancelled";
    for (const step of plan.steps) {
      if (step.status !== "completed" && step.status !== "skipped" && step.status !== "cancelled") {
        step.status = "cancelled";
        step.waitingReason = "";
        step.waitingTaskGroupId = undefined;
      }
    }
    this._snapshot.updatedAt = Date.now();
    this._restoreParentState();
    await this._releaseTaskLinks(releaseIntents);
    this._planLinkedGroups.clear();
    this._commit("plan_cancelled");
    this._recordEvent(phase === "executing" ? "plan_execution_cancelled" : "plan_cancelled", {
      version: ref.version,
      status: "cancelled",
    });
    await this._awaitLiveCleared(this._abortSettleMs);
    return { ok: true };
  }

  /** Re-run a failed step (failed -> running special case); read-only rejects. */
  async retryStep(planId: string, version: number, stepId: string): Promise<{ ok: boolean; reason?: string }> {
    if (this._disposed) {
      return { ok: false, reason: "disposed" };
    }
    const mismatch = this._versionMismatch(planId, version);
    if (mismatch) {
      return { ok: false, reason: mismatch };
    }
    if (this._snapshot.phase !== "paused" && this._snapshot.phase !== "executing") {
      return { ok: false, reason: `cannot retry a step from phase "${this._snapshot.phase}"` };
    }
    if (this._ctx.getSession().isStreaming) {
      return { ok: false, reason: "session_busy" };
    }
    const mode = this._ctx.getExecutionMode();
    if (mode === "read-only") {
      return { ok: false, reason: "read_only" };
    }
    const plan = this._snapshot.plan!;
    const step = plan.steps.find((candidate) => candidate.stepId === stepId);
    if (!step) {
      return { ok: false, reason: "unknown_step" };
    }
    if (step.status !== "failed") {
      return { ok: false, reason: "step_not_failed" };
    }
    if (
      plan.steps.some(
        (candidate) =>
          candidate.status === "running" ||
          candidate.status === "waiting_input" ||
          candidate.status === "interrupted", // 1.4.2 (R4): hydrated task-linked step still owns its group
      )
    ) {
      return { ok: false, reason: "another_step_active" };
    }
    step.status = "running";
    step.waitingReason = "";
    this._snapshot.phase = "executing";
    plan.status = "executing";
    this._snapshot.updatedAt = Date.now();
    this._commit("plan_step_running");
    this._bindSessionEvents();
    if (step.executionTarget === "parent") {
      await this._triggerExecutionTurn(step);
    } else {
      await this._delegateStep(step);
    }
    return { ok: true };
  }

  /**
   * Skip a pending step (sync, no turn). Only legal while executing/paused:
   * skipping before execution (awaiting_approval/approved) would leave the
   * plan in approved with no runnable step (startExecution would return
   * no_runnable_step forever), and the completion criteria only apply to the
   * executing/paused phases. Rejected when other steps depend on it.
   */
  skipStep(planId: string, version: number, stepId: string): { ok: boolean; reason?: string } {
    if (this._disposed) {
      return { ok: false, reason: "disposed" };
    }
    const mismatch = this._versionMismatch(planId, version);
    if (mismatch) {
      return { ok: false, reason: mismatch };
    }
    const phase = this._snapshot.phase;
    if (phase !== "executing" && phase !== "paused") {
      return { ok: false, reason: `cannot skip from phase "${phase}"` };
    }
    const plan = this._snapshot.plan!;
    const step = plan.steps.find((candidate) => candidate.stepId === stepId);
    if (!step) {
      return { ok: false, reason: "unknown_step" };
    }
    if (step.status !== "pending") {
      return { ok: false, reason: "step_not_pending" };
    }
    const dependent = plan.steps.find((candidate) => candidate.dependsOn.includes(stepId));
    if (dependent) {
      return { ok: false, reason: `step "${stepId}" has dependent step "${dependent.stepId}"; revise the plan instead` };
    }
    step.status = "skipped";
    step.waitingReason = "";
    this._snapshot.updatedAt = Date.now();
    this._commit("plan_step_skipped");
    this._checkCompletionAfterHostTransition();
    return { ok: true };
  }

  /**
   * paused -> executing; picks the next runnable step and triggers a parent
   * turn. 1.4.1: a waiting background task step is consumed first (two-phase
   * consumption - read + validate the group result, persist the consumed fact,
   * then confirm); without a waiting task it advances normally.
   */
  async continuePlan(planId: string, version: number): Promise<{ ok: boolean; reason?: string }> {
    if (this._disposed) {
      return { ok: false, reason: "disposed" };
    }
    const mismatch = this._versionMismatch(planId, version);
    if (mismatch) {
      return { ok: false, reason: mismatch };
    }
    if (this._snapshot.phase !== "paused") {
      return { ok: false, reason: `cannot continue from phase "${this._snapshot.phase}"` };
    }
    if (this._ctx.getSession().isStreaming) {
      return { ok: false, reason: "session_busy" };
    }
    const mode = this._ctx.getExecutionMode();
    if (mode === "read-only") {
      return { ok: false, reason: "read_only" };
    }
    const plan = this._snapshot.plan!;
    // 1.4.2 (R4): a hydrated task-linked step is "interrupted" (same link
    // facts); both statuses are consumed the same way with the same groupId.
    const waitingStep = plan.steps.find(
      (step) =>
        (step.status === "waiting_input" || step.status === "interrupted") &&
        step.waitingReason === "agent_task" &&
        step.waitingTaskGroupId !== undefined,
    );
    if (waitingStep) {
      return this._consumeWaitingTaskStep(waitingStep, plan, version);
    }
    const verifying = plan.steps.find(
      (step) => step.status === "running" && typeof step.consumedTaskGroupId === "string" && step.consumedTaskGroupId !== "",
    );
    if (verifying) {
      this._snapshot.phase = "executing";
      plan.status = "executing";
      this._snapshot.updatedAt = Date.now();
      this._bindSessionEvents();
      this._commit("plan_execution_resumed");
      await this._triggerTaskResultVerificationTurn(verifying, verifying.consumedTaskSummary ?? "");
      return { ok: true };
    }
    if (plan.steps.some((step) => step.status === "failed")) {
      return { ok: false, reason: "failed_step_pending" };
    }
    return this._advanceExecution(version, false);
  }

  /**
   * 1.4.1 two-phase consumption of a backgrounded task group. Phase one reads
   * and validates the group result (must be terminal; otherwise the plan stays
   * paused - no deadlock); phase two persists the consumed fact (clearing the
   * waiting fields and writing consumedTaskGroupId+consumedTaskSummary in one
   * snapshot) BEFORE the idempotent confirm, so a crash between the two writes
   * hydrates from consumedTaskGroupId and re-confirms. cancelled is consumed,
   * never released; only a successful revision or overall cancel releases.
   */
  private async _consumeWaitingTaskStep(step: PlanStep, plan: Plan, version: number): Promise<{ ok: boolean; reason?: string }> {
    const getResult = this._ctx.getPlanTaskGroupResult;
    if (!getResult) {
      return { ok: false, reason: "task_service_unavailable" };
    }
    const link: PlanStepExecutionLink = { planId: plan.planId, version: plan.version, stepId: step.stepId };
    const groupId = step.waitingTaskGroupId!;
    const result = await getResult(groupId, link);
    if (!result.ok) {
      // e.g. group_not_terminal: keep the paused/waiting state; the user can
      // continue again later.
      return { ok: false, reason: result.reason };
    }
    const now = Date.now();
    step.waitingReason = "";
    step.waitingTaskGroupId = undefined;
    step.consumedTaskGroupId = groupId;
    step.consumedTaskSummary = result.summary;
    if (result.status === "completed") {
      step.status = "running";
      plan.status = "executing";
      this._snapshot.phase = "executing";
      this._snapshot.updatedAt = now;
      this._commitStep(plan, step, "plan_step_running");
      await this._confirmConsumed(groupId, link);
      this._bindSessionEvents();
      // The parent model verifies the completed task's work and calls
      // update_plan_step(completed|failed) itself.
      await this._triggerTaskResultVerificationTurn(step, result.summary);
      return { ok: true };
    }
    // failed or cancelled: the step fails, the plan stays paused; the UI offers
    // retry step / re-plan / abort plan. cancelled still goes through the
    // consumption confirm (cancelled is NOT a link release).
    step.status = "failed";
    plan.status = "paused";
    this._snapshot.phase = "paused";
    this._snapshot.updatedAt = now;
    this._commitStep(plan, step, "plan_step_failed");
    await this._confirmConsumed(groupId, link);
    this._recordEvent("plan_execution_failed", { version, status: "paused" });
    return { ok: true };
  }

  private async _confirmConsumed(groupId: string, link: PlanStepExecutionLink): Promise<void> {
    const confirm = this._ctx.confirmPlanTaskGroupConsumed;
    if (!confirm) {
      return;
    }
    try {
      await confirm(groupId, link);
    } catch (err) {
      // The persisted consumed fact survives; hydration re-confirms idempotently.
      console.warn("[PlanController] task group consumption confirm failed:", err);
    }
  }

  /** Inject the completed background task's result into the parent turn for verification. */
  private async _triggerTaskResultVerificationTurn(step: PlanStep, summary: string): Promise<void> {
    const content = [
      `The background task group for plan step "${step.stepKey}" (${step.title}) completed.`,
      "",
      `Result summary:`,
      summary,
      "",
      "Verify the task's work against the step's verification criteria, then call update_plan_step with completed (non-empty completionSummary + non-failed verificationResult) or failed.",
    ].join("\n");
    this._armExecutionTurn();
    await this._ctx.getSession().sendCustomMessage(
      { customType: "pix-plan-context", content, display: false },
      { triggerTurn: true },
    );
  }

  /**
   * Host tool policy override: authoritative during planning/revising
   * (allowlist allowed, everything else denied); undefined otherwise so the
   * built-in execution-mode policy applies unchanged.
   */
  decideToolPolicy(input: HostToolPolicyInput): ToolPolicyDecision | undefined {
    const phase = this._snapshot.phase;
    if (phase !== "planning" && phase !== "revising") {
      return undefined;
    }
    if (PLAN_ALLOWLIST.includes(input.toolName)) {
      return { allowed: true };
    }
    return { allowed: false, reason: "plan_generation_restricted" };
  }

  getSnapshot(): PlanRuntimeSnapshot {
    return structuredClone(this._snapshot);
  }

  onEvent(listener: (e: PlanControllerEvent) => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /**
   * Restore the persisted state on session reopen. Applies the hydration
   * rules: dormant planning/revising keeps generation + retryable cancelled
   * failure (no live turn); an executing plan / running or waiting_input step
   * hydrates to paused + failed (parent-directly-executed steps) EXCEPT
   * task-linked steps (agent_task + waitingTaskGroupId), which hydrate
   * directly to paused + "interrupted" keeping the link facts (1.4.2 R4) and
   * survive for the same-app reopened session / restarted app. After the
   * synchronous normalization, un-finished pendingTaskLinkReleases intents
   * are replayed idempotently and consumed groups are re-confirmed from the
   * persisted consumedTaskGroupId. Never auto-approves or auto-executes.
   */
  async restoreFromHistory(
    entries: readonly SessionEntry[],
    opts?: { taskLinkHydration?: PlanTaskLinkHydration },
  ): Promise<void> {
    const rebuilt = rebuildPlanFromEntries(entries);
    if (rebuilt) {
      await this._hydrate(rebuilt, opts?.taskLinkHydration ?? "app_restart");
    }
  }

  /**
   * Dispose: abort the live turn, apply the close matrix (planning/revising
   * keep their retryable state; awaiting_approval/approved stay; running /
   * waiting_input steps become failed with Plan paused), persist. Never
   * auto-approves or auto-executes. 1.4.1/1.4.2 close matrix: a task-linked
   * waiting step (waiting_input + agent_task) survives `session_close` as
   * paused/waiting (the same-app reopened session continues it); 1.4.2
   * `app_shutdown` / `host_disposed` write it as non-terminal "interrupted"
   * keeping waitingReason=agent_task + waitingTaskGroupId, so the first
   * hydration after restart reads the recoverable link directly - never
   * failed first and rewritten, and completed/failed/cancelled are never
   * rewritten.
   */
  async dispose(reason: PlanDisposeReason): Promise<void> {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._clearWatchdog();
    this._liveGeneration = undefined;
    if (this._sessionUnsubscribe) {
      this._sessionUnsubscribe();
      this._sessionUnsubscribe = undefined;
    }
    if (this._planLinkedTaskUnsubscribe) {
      this._planLinkedTaskUnsubscribe();
      this._planLinkedTaskUnsubscribe = undefined;
    }
    this._abortLiveTurn();

    const phase = this._snapshot.phase;
    if (phase === "planning" || phase === "revising") {
      // 关闭后的生成水合：保留 phase + generation；保存 retryable cancelled failure。
      const generation = this._snapshot.generation;
      if (generation && !this._snapshot.failure) {
        this._snapshot.failure = {
          generationId: generation.generationId,
          phase: generation.kind === "revision" ? "revision" : "initial",
          code: "cancelled",
          message: "The plan generation was interrupted by session close; retry to continue.",
          fieldErrors: [],
          retryable: true,
          occurredAt: Date.now(),
        };
        this._snapshot.updatedAt = Date.now();
        this._commit("plan_generation_cancelled");
      }
      return;
    }
    if (phase === "awaiting_approval" || phase === "approved") {
      return;
    }
    if (phase === "executing" || phase === "paused") {
      const plan = this._snapshot.plan!;
      let changed = false;
      for (const step of plan.steps) {
        if (step.status === "running" || step.status === "waiting_input") {
          if (step.waitingReason === "agent_task" && typeof step.waitingTaskGroupId === "string") {
            if (reason === "session_close") {
              // 1.4.1: the detached background group keeps running in the app
              // service; the waiting step survives for the same-app reopened
              // session. Never rewritten to failed by a session switch.
              continue;
            }
            // 1.4.2 (R4): app shutdown keeps the task-linked step non-terminal
            // as "interrupted" with the recoverable link facts, so the first
            // hydration after restart reads it directly. Never failed first
            // and rewritten, never clears the waiting fields.
            step.status = "interrupted";
            changed = true;
            continue;
          }
          if (typeof step.consumedTaskGroupId === "string" && step.consumedTaskGroupId !== "") {
            continue;
          }
          step.status = "failed";
          step.waitingReason = "";
          step.waitingTaskGroupId = undefined;
          changed = true;
        }
      }
      if (changed || phase === "executing") {
        plan.status = "paused";
        this._snapshot.phase = "paused";
        this._snapshot.updatedAt = Date.now();
        this._commit("plan_execution_failed");
      }
    }
  }

  // =========================================================================
  // update_plan_step (model tool path)
  // =========================================================================

  /**
   * Validate and apply a model-submitted step transition. planId+version must
   * match the current version, the transition must be legal, and completed
   * requires a non-empty completionSummary plus a non-failed
   * verificationResult (no delegation path bypasses this gate).
   */
  async updatePlanStep(params: UpdatePlanStepParams): Promise<{
    accepted: boolean;
    snapshot: PlanRuntimeSnapshot;
    reason?: string;
  }> {
    if (this._disposed) {
      return { accepted: false, snapshot: this._snapshot, reason: "disposed" };
    }
    const mismatch = this._versionMismatch(params.planId, params.version);
    if (mismatch) {
      return { accepted: false, snapshot: this._snapshot, reason: mismatch };
    }
    if (this._snapshot.phase !== "executing") {
      return { accepted: false, snapshot: this._snapshot, reason: `plan is not executing (phase "${this._snapshot.phase}")` };
    }
    const plan = this._snapshot.plan!;
    const step = plan.steps.find((candidate) => candidate.stepId === params.stepId);
    if (!step) {
      return { accepted: false, snapshot: this._snapshot, reason: "unknown_step" };
    }
    const allowed = PLAN_STEP_TRANSITIONS[step.status];
    if (!allowed.includes(params.status)) {
      return {
        accepted: false,
        snapshot: this._snapshot,
        reason: `invalid transition ${step.status} -> ${params.status}`,
      };
    }
    if (params.status !== "waiting_input" && params.waitingReason !== undefined && params.waitingReason !== "") {
      return { accepted: false, snapshot: this._snapshot, reason: "waitingReason is only valid for waiting_input" };
    }
    if (params.status === "waiting_input") {
      if (params.waitingReason !== "user_input") {
        // 1.4.1: waitingReason="agent_task" is host-managed (backgrounded task
        // delegation); the executing model can only submit user_input.
        return {
          accepted: false,
          snapshot: this._snapshot,
          reason: 'waiting_input requires waitingReason="user_input"',
        };
      }
      step.status = "waiting_input";
      step.waitingReason = "user_input";
      this._commitStep(plan, step, "plan_step_waiting_input");
      return { accepted: true, snapshot: this._snapshot };
    }
    if (params.status === "running") {
      const done = new Set(
        plan.steps.filter((s) => s.status === "completed" || s.status === "skipped").map((s) => s.stepId),
      );
      const unsatisfied = step.dependsOn.filter((dependency) => !done.has(dependency));
      if (unsatisfied.length > 0) {
        return { accepted: false, snapshot: this._snapshot, reason: "step dependencies are not all completed" };
      }
      if (plan.steps.some((candidate) => candidate.status === "running")) {
        return { accepted: false, snapshot: this._snapshot, reason: "another step is already running" };
      }
      step.status = "running";
      step.waitingReason = "";
      this._commitStep(plan, step, "plan_step_running");
      return { accepted: true, snapshot: this._snapshot };
    }
    if (params.status === "completed") {
      const summary = typeof params.completionSummary === "string" ? params.completionSummary.trim() : "";
      const verification = params.verificationResult;
      if (summary === "") {
        return { accepted: false, snapshot: this._snapshot, reason: "completed requires a non-empty completionSummary" };
      }
      if (!verification || verification.status === "failed") {
        return {
          accepted: false,
          snapshot: this._snapshot,
          reason: "completed requires a verificationResult that is not failed",
        };
      }
      step.status = "completed";
      step.waitingReason = "";
      step.completionSummary = summary;
      step.verificationResult = { status: verification.status, summary: verification.summary };
      this._commitStep(plan, step, "plan_step_completed");
      void this._confirmLinkedGroup(step, plan);
      this._afterStepCompleted();
      return { accepted: true, snapshot: this._snapshot };
    }
    // failed
    step.status = "failed";
    step.waitingReason = "";
    if (typeof params.completionSummary === "string" && params.completionSummary !== "") {
      step.completionSummary = params.completionSummary;
    }
    this._commitStep(plan, step, "plan_step_failed");
    void this._confirmLinkedGroup(step, plan);
    this._afterStepFailed();
    return { accepted: true, snapshot: this._snapshot };
  }

  // =========================================================================
  // Generation internals
  // =========================================================================

  private async _retryGeneration(
    generationId: string,
    useFrozenModel: boolean,
  ): Promise<{ ok: boolean; generationId?: string; reason?: string }> {
    if (generationId !== this._retryToken()) {
      return { ok: false, reason: "stale_generation" };
    }
    const phase = this._snapshot.phase;
    if (phase !== "planning" && phase !== "planning_failed" && phase !== "revising") {
      return { ok: false, reason: `cannot retry from phase "${phase}"` };
    }
    if (this._liveGeneration !== undefined) {
      return { ok: false, reason: "generation_in_progress" };
    }
    if (this._ctx.getSession().isStreaming) {
      return { ok: false, reason: "session_busy" };
    }
    const isRevision = phase === "revising";
    const requestedVersion = isRevision ? this._snapshot.revision!.requestedVersion : 0;
    const kind = isRevision ? "revision" : "initial";
    if (useFrozenModel) {
      const frozen = this._frozenParent;
      if (!frozen?.model) {
        const generationId2 = this._startGeneration(
          kind,
          requestedVersion,
          false,
          this._snapshot.plan?.planningModel ?? this._frozenModelSnapshot(),
        );
        this._failGeneration("model_unavailable", "The parent session has no frozen model snapshot.", true);
        return { ok: true, generationId: generationId2 };
      }
      const generationId2 = this._startGeneration(
        kind,
        requestedVersion,
        false,
        this._modelSnapshot(frozen.model, frozen.thinkingLevel),
      );
      const prepared = await this._prepareGeneration(frozen.model, frozen.thinkingLevel);
      if (!prepared) {
        return { ok: true, generationId: generationId2 };
      }
      await this._launchGenerationTurn(false);
      return { ok: true, generationId: generationId2 };
    }
    const resolved = this._ctx.resolvePlanningModel();
    const generationId2 = this._startGeneration(
      kind,
      requestedVersion,
      false,
      "error" in resolved
        ? (this._snapshot.plan?.planningModel ?? this._frozenModelSnapshot())
        : this._modelSnapshot(resolved.model, resolved.thinkingLevel),
    );
    if ("error" in resolved) {
      this._failGeneration(resolved.error === "auth_unavailable" ? "auth_unavailable" : "model_unavailable", resolved.error, true);
      return { ok: true, generationId: generationId2 };
    }
    const prepared = await this._prepareGeneration(resolved.model, resolved.thinkingLevel);
    if (!prepared) {
      return { ok: true, generationId: generationId2 };
    }
    await this._launchGenerationTurn(false);
    return { ok: true, generationId: generationId2 };
  }

  /**
   * Begin a new generation: assign state, switch the tool surface, arm the
   * watchdog. The caller passes the ACTUAL execution model (the resolved
   * planning model / frozen parent model) so generation.model, plan.planningModel
   * and the plan_generation_started payload always record the model the turn
   * really runs on.
   */
  private _startGeneration(
    kind: PlanGenerationState["kind"],
    requestedVersion: number,
    concise: boolean,
    model: PlanGenerationState["model"],
  ): string {
    const generationId = randomUUID();
    this._snapshot.generation = {
      generationId,
      kind,
      requestedVersion,
      concise,
      model,
      startedAt: Date.now(),
    };
    this._snapshot.failure = undefined;
    // A stale abort marker never leaks into a new generation: the marker is
    // only meaningful while the aborted turn's late settle is still pending
    // (and _liveGeneration is retained), which _startGeneration's callers
    // already reject.
    this._abortPendingGenerationId = undefined;
    if (kind === "revision") {
      this._snapshot.phase = "revising";
      if (this._snapshot.plan) {
        this._snapshot.plan.status = "revising";
      }
    } else if (this._snapshot.phase !== "planning") {
      this._snapshot.phase = "planning";
      if (this._snapshot.plan) {
        this._snapshot.plan.status = "planning";
      }
    }
    this._snapshot.updatedAt = Date.now();
    this._liveGeneration = { generationId };
    this._lastAssistantStopReason = undefined;
    this._armWatchdog(generationId);
    this._bindSessionEvents();
    this._commit("plan_generation_started");
    this._recordEvent("plan_generation_started", {
      version: requestedVersion,
      status: this._snapshot.phase,
      model: this._snapshot.generation.model,
    });
    return generationId;
  }

  private _resetPlanRuntime(): void {
    this._clearWatchdog();
    this._clearExecutionWatchdog();
    this._liveGeneration = undefined;
    this._abortPendingGenerationId = undefined;
    // Do not clear _staleSettlePending: an aborted turn's settle may still be
    // in flight when the user re-enters planning from a terminal phase.
    this._waitingInputByToolCall.clear();
    this._planLinkedGroups.clear();
    this._delegatingStepId = undefined;
    this._snapshot = makeInitialSnapshot();
  }

  /**
   * Inject the live generationId into model-visible context, then start the
   * planning turn. Failures restore generation state instead of hanging live.
   */
  private async _launchGenerationTurn(
    firstEnter: boolean,
    request?: PlanUserRequest,
    concise?: boolean,
    feedback?: string,
    stepKey?: string,
  ): Promise<void> {
    try {
      await this._injectGenerationContext();
      if (firstEnter && request) {
        await this._ctx.promptPlanningRequest(request);
      } else {
        await this._sendRetryMessage(concise === true, feedback, stepKey);
      }
    } catch (err) {
      this._failGeneration("internal_error", err instanceof Error ? err.message : String(err), true);
    }
  }

  private async _injectGenerationContext(): Promise<void> {
    const generation = this._snapshot.generation;
    if (!generation) {
      return;
    }
    await this._ctx.getSession().sendCustomMessage(
      {
        customType: PLAN_CONTEXT_MESSAGE_TYPE,
        content: serializePlanGenerationContext(generation.generationId, generation.concise),
        display: false,
      },
      { triggerTurn: false },
    );
  }

  private _frozenModelSnapshot(): PlanGenerationState["model"] {
    const frozen = this._frozenParent;
    if (frozen?.model) {
      return { provider: frozen.model.provider, modelId: frozen.model.id, thinkingLevel: frozen.thinkingLevel };
    }
    return { provider: "unknown", modelId: "unknown", thinkingLevel: "off" };
  }

  /** Snapshot record of the ACTUAL execution model (resolved planning model or frozen parent model). */
  private _modelSnapshot(model: Model<Api>, thinkingLevel: ThinkingLevel): PlanGenerationState["model"] {
    return { provider: model.provider, modelId: model.id, thinkingLevel };
  }

  /** Apply the planning model/thinking and the allowlist tool surface. */
  private async _prepareGeneration(model: Model<Api>, thinkingLevel: ThinkingLevel): Promise<boolean> {
    const session = this._ctx.getSession();
    try {
      session.setActiveToolsByName([...PLAN_ALLOWLIST]);
      await session.setModel(model);
      session.setThinkingLevel(thinkingLevel);
    } catch (err) {
      console.warn("[PlanController] failed to apply planning model/tools:", err);
      this._failGeneration("internal_error", err instanceof Error ? err.message : String(err), true);
      return false;
    }
    return true;
  }

  /** Record a retry turn: pix-plan-retry CustomMessage, never repeating the original request text. */
  private async _sendRetryMessage(concise?: boolean, feedback?: string, stepKey?: string): Promise<void> {
    const parts: string[] = [];
    const generationId = this._snapshot.generation?.generationId;
    if (generationId) {
      parts.push(`When calling submit_user_plan you MUST pass generationId exactly as "${generationId}".`);
    }
    if (feedback !== undefined) {
      parts.push(`Revision feedback: ${feedback}`);
      if (stepKey !== undefined) {
        parts.push(`Target step: ${stepKey}`);
      }
    } else {
      parts.push(
        concise === true
          ? "The previous plan generation was not usable. Regenerate the plan from the existing context, more concisely (fewer steps, tighter scope)."
          : "The previous plan generation did not complete. Regenerate the plan from the existing conversation context using the plan tools.",
      );
    }
    await this._ctx.getSession().sendCustomMessage(
      { customType: PLAN_RETRY_MESSAGE_TYPE, content: parts.join("\n"), display: false },
      { triggerTurn: true },
    );
  }

  /** Validation failure handling for submitPlan (initial vs revision). */
  private _rejectSubmission(
    generation: PlanGenerationState,
    fieldErrors: Array<{ path: string; message: string }>,
  ): { accepted: false; snapshot: PlanRuntimeSnapshot; fieldErrors: Array<{ path: string; message: string }> } {
    const isRevision = generation.kind === "revision";
    this._snapshot.failure = {
      generationId: generation.generationId,
      phase: isRevision ? "revision" : "initial",
      code: "invalid_plan",
      message: fieldErrors.map((error) => `${error.path}: ${error.message}`).join("; "),
      fieldErrors,
      retryable: true,
      occurredAt: Date.now(),
    };
    this._snapshot.generation = undefined;
    if (!isRevision) {
      this._snapshot.phase = "planning_failed";
    }
    // Revision keeps revising + lastValidPlan; no half-valid version exists.
    this._snapshot.updatedAt = Date.now();
    // The submitting turn may still be streaming: keep the live marker and
    // record the abort so the turn's late settle is attributed to THIS
    // generation (cleanup only, the failure snapshot is already written)
    // and never kills a newer generation started before the settle arrives.
    this._abortPendingGenerationId = generation.generationId;
    this._abortLiveTurn();
    this._clearWatchdog();
    // Symmetric with _failGeneration: the generation is over, hand the parent
    // tool surface back so the session is never stuck on the planning
    // allowlist after a rejected submission. The abort marker above still
    // keeps the submitting turn's late settle attributed to THIS generation;
    // _restoreParentState only affects the NEXT turn's surface.
    this._restoreParentState();
    this._commit("plan_generation_failed");
    this._recordEvent("plan_generation_failed", {
      status: isRevision ? "revising" : "planning_failed",
      errorCategory: "invalid_plan",
    });
    return { accepted: false, snapshot: structuredClone(this._snapshot), fieldErrors };
  }

  private async _validateDraft(draft: SubmitUserPlanParams): Promise<PlanValidationResult> {
    const context: PlanValidationContext = {
      project: this._ctx.getProjectLocation(),
      logicalCwd: this._ctx.getExecutionContext().logicalCwd,
      executionBackend: this._ctx.getExecutionContext().executionBackend,
      release: PLAN_RUNTIME_RELEASE,
    };
    return validatePlanDraft(draft, context);
  }

  /** Record a generation failure (model resolution, timeout, truncated, invalid plan, internal). */
  private _failGeneration(code: PlanGenerationFailure["code"], message: string, retryable: boolean): void {
    const generation = this._snapshot.generation;
    const isRevision = generation?.kind === "revision";
    this._snapshot.failure = {
      generationId: generation?.generationId ?? "",
      phase: isRevision ? "revision" : "initial",
      code,
      message,
      fieldErrors: [],
      retryable,
      occurredAt: Date.now(),
    };
    this._snapshot.generation = undefined;
    if (!isRevision) {
      this._snapshot.phase = "planning_failed";
    }
    this._snapshot.updatedAt = Date.now();
    if (this._abortPendingGenerationId === undefined) {
      // The live turn was aborted (watchdog timeout / cancel): keep the live
      // marker until the aborted turn's late settle arrives so it is
      // attributed to THIS generation (cleanup only) and never touches a
      // newer generation; the failure snapshot is already written here.
      this._liveGeneration = undefined;
    }
    this._clearWatchdog();
    // The generation is over: hand the parent tool surface back so the
    // session is never stuck on the planning allowlist after a failure.
    this._restoreParentState();
    this._commit("plan_generation_failed");
    this._recordEvent("plan_generation_failed", {
      status: isRevision ? "revising" : "planning_failed",
      errorCategory: code,
    });
  }

  private _retryToken(): string | undefined {
    if (this._snapshot.generation) {
      return this._snapshot.generation.generationId;
    }
    const failure = this._snapshot.failure;
    if (isRetryableFailure(failure)) {
      return failure.generationId;
    }
    return undefined;
  }

  private _freezeParentSnapshot(): void {
    const session = this._ctx.getSession();
    this._frozenParent = { model: session.model, thinkingLevel: session.thinkingLevel };
    this._frozenTools = [...session.getActiveToolNames()];
  }

  private _restoreParentState(): void {
    const session = this._ctx.getSession();
    if (this._frozenTools) {
      try {
        session.setActiveToolsByName(this._frozenTools);
      } catch (err) {
        console.warn("[PlanController] failed to restore parent tool surface:", err);
      }
    }
    if (this._frozenParent) {
      const frozen = this._frozenParent;
      if (frozen.model) {
        void session.setModel(frozen.model).catch((err) => {
          console.warn("[PlanController] failed to restore parent model:", err);
        });
      }
      session.setThinkingLevel(frozen.thinkingLevel);
    }
  }

  /**
   * 1.4.1: collect the pending task-link release intents of a plan (steps with
   * a still-waiting background task group). Callers collect BEFORE any step
   * field is cleared, then hand the intents to _releaseTaskLinks.
   */
  private _collectTaskLinkIntents(plan: Plan, reason: "plan_revised" | "plan_cancelled"): PendingPlanTaskLinkRelease[] {
    const intents: PendingPlanTaskLinkRelease[] = [];
    const seen = new Set<string>();
    for (const step of plan.steps) {
      if (typeof step.waitingTaskGroupId === "string" && step.waitingTaskGroupId !== "") {
        seen.add(step.waitingTaskGroupId);
        intents.push({
          groupId: step.waitingTaskGroupId,
          link: { planId: plan.planId, version: plan.version, stepId: step.stepId },
          reason,
        });
      }
    }
    for (const tracked of this._planLinkedGroups.values()) {
      if (seen.has(tracked.groupId)) {
        continue;
      }
      seen.add(tracked.groupId);
      intents.push({ groupId: tracked.groupId, link: tracked.link, reason });
    }
    return intents;
  }

  /**
   * 1.4.1 revision/cancel link release. Only a successful revision publish or
   * an explicit user cancel reaches this path: the controller first writes the
   * `pendingTaskLinkReleases` intent into the SAME snapshot, then calls the
   * idempotent service release, then clears the intent. A failure keeps the
   * intent so hydration replays it (release only lifts cleanup protection;
   * running tasks are never cancelled and results are never injected into a
   * new version).
   */
  private async _releaseTaskLinks(intents: PendingPlanTaskLinkRelease[]): Promise<void> {
    const release = this._ctx.releasePlanTaskGroup;
    if (intents.length === 0 || !release) {
      return;
    }
    this._snapshot.pendingTaskLinkReleases = intents;
    this._snapshot.updatedAt = Date.now();
    this._commit("plan_link_release_pending");
    for (const intent of intents) {
      try {
        await release(intent.groupId, intent.link, intent.reason);
      } catch (err) {
        // Keep the intent for the hydration replay; the release is idempotent.
        console.warn("[PlanController] task link release failed:", err);
        return;
      }
    }
    this._snapshot.pendingTaskLinkReleases = undefined;
    this._snapshot.updatedAt = Date.now();
    this._commit("plan_link_release_done");
  }

  // =========================================================================
  // Execution advancement
  // =========================================================================

  /** Enter executing, pick the next runnable step, inject its context and trigger the parent turn. */
  private async _advanceExecution(version: number, isStart: boolean): Promise<{ ok: boolean; reason?: string }> {
    const plan = this._snapshot.plan!;
    if (plan.steps.some((step) => step.status === "failed")) {
      return { ok: false, reason: "failed_step_pending" };
    }
    const next = this._pickNextStep();
    if (!next) {
      return { ok: false, reason: "no_runnable_step" };
    }
    this._snapshot.phase = "executing";
    plan.status = "executing";
    this._snapshot.updatedAt = Date.now();
    this._bindSessionEvents();
    this._commit(isStart ? "plan_execution_started" : "plan_execution_resumed");
    if (isStart) {
      this._recordEvent("plan_execution_started", { version, status: "executing" });
    }
    if (next.executionTarget === "parent") {
      await this._triggerExecutionTurn(next);
      return { ok: true };
    }
    await this._delegateStep(next);
    return { ok: true };
  }

  private _pickNextStep(): PlanStep | undefined {
    const plan = this._snapshot.plan!;
    if (plan.steps.some((step) => step.status === "failed")) {
      return undefined;
    }
    if (plan.steps.some((step) => step.status === "running" || step.status === "waiting_input")) {
      return undefined;
    }
    const done = new Set(
      plan.steps.filter((step) => step.status === "completed" || step.status === "skipped").map((step) => step.stepId),
    );
    return plan.steps.find(
      (step) => step.status === "pending" && step.dependsOn.every((dependency) => done.has(dependency)),
    );
  }

  /** Inject the parent execution context for one step and trigger a turn. */
  private async _triggerExecutionTurn(step: PlanStep): Promise<void> {
    const plan = this._snapshot.plan!;
    const files = step.files.length > 0
      ? `\nDeclared files: ${step.files.map((f) => `${f.path} (${f.operation})`).join(", ")}`
      : "";
    const commands = step.expectedCommands && step.expectedCommands.length > 0
      ? `\nExpected commands: ${step.expectedCommands.join(" | ")}`
      : "";
    const scopeNote = step.scopeNote ? `\nScope note: ${step.scopeNote}` : "";
    const content = [
      serializePlanContextMessage(plan, "executing"),
      "",
      `Execute plan step "${step.stepKey}" (${step.title}):`,
      step.description,
      files,
      commands,
      scopeNote,
      `\nVerification required: ${step.verification}`,
      `Risk: ${step.risk} - ${step.riskReason}`,
      "",
      step.status === "running"
        ? "This step is already running. Continue the work, then call update_plan_step with completed (non-empty completionSummary and a non-failed verificationResult) or failed. Do not call running again."
        : "Protocol: call update_plan_step with status running before executing, then report completed (with a non-empty completionSummary and a non-failed verificationResult) or failed afterwards.",
    ].join("\n");
    this._armExecutionTurn();
    await this._ctx.getSession().sendCustomMessage(
      { customType: "pix-plan-context", content, display: false },
      { triggerTurn: true },
    );
  }

  /**
   * Delegate a subagent step (1.4.0: foreground; 1.4.1: foreground +
   * background) and inject the result into the parent turn. A backgrounded
   * delegation puts the step into waiting_input(agent_task), records
   * waitingTaskGroupId and pauses the top-level plan; the parent model never
   * sees the group handle directly and the adapter forces executionTarget.
   */
  private async _delegateStep(step: PlanStep): Promise<void> {
    const delegate = this._ctx.delegateSubagentStep;
    const plan = this._snapshot.plan!;
    if (!delegate) {
      step.status = "failed";
      step.waitingReason = "";
      step.waitingTaskGroupId = undefined;
      this._commitStep(plan, step, "plan_step_failed");
      this._afterStepFailed();
      return;
    }
    step.status = "running";
    step.waitingReason = "";
    this._commitStep(plan, step, "plan_step_running");
    this._invalidateExecutionTurns();
    const link: PlanStepExecutionLink = { planId: plan.planId, version: plan.version, stepId: step.stepId };
    this._delegatingStepId = step.stepId;
    const presentation: "foreground" | "background" = step.executionTarget === "subagent_background" ? "background" : "foreground";
    try {
      const result = await delegate(step, link, presentation);
      if (this._disposed || this._snapshot.phase !== "executing" || this._snapshot.plan?.version !== plan.version) {
        return; // cancelled/revised while delegating; the result is discarded.
      }
      if (result.status === "backgrounded") {
        this._registerPlanLinkedGroup(result.groupId, link);
        // The group runs in the app service; the step waits for the user's
        // continuePlan (two-phase consumption) and the plan pauses.
        step.status = "waiting_input";
        step.waitingReason = "agent_task";
        step.waitingTaskGroupId = result.groupId;
        plan.status = "paused";
        this._snapshot.phase = "paused";
        this._snapshot.updatedAt = Date.now();
        this._commitStep(plan, step, "plan_step_waiting_input");
        return;
      }
      if (result.groupId) {
        this._registerPlanLinkedGroup(result.groupId, link);
      }
      const deviations = result.deviations ?? [];
      for (const deviation of deviations) {
        this._recordDeviation(deviation);
      }
      const content = [
        `The subagent finished plan step "${step.stepKey}" (${step.title}).`,
        "",
        `Result: ${result.status === "result" ? "completed" : "failed"}`,
        result.summary,
        deviations.length > 0
          ? `\nDeviations detected:\n${deviations.map((d) => `- ${d.type}: ${d.path ?? d.command ?? ""} (${d.reason})`).join("\n")}`
          : "",
        "",
        "Verify the subagent's work against the step's verification criteria, then call update_plan_step with completed (non-empty completionSummary + non-failed verificationResult) or failed.",
      ].join("\n");
      this._armExecutionTurn();
      await this._ctx.getSession().sendCustomMessage(
        { customType: "pix-plan-context", content, display: false },
        { triggerTurn: true },
      );
    } catch (err) {
      console.warn("[PlanController] subagent delegation failed:", err);
      if (!this._disposed && this._snapshot.phase === "executing" && this._snapshot.plan?.version === plan.version) {
        step.status = "failed";
        step.waitingReason = "";
        this._commitStep(plan, step, "plan_step_failed");
        this._afterStepFailed();
      }
    } finally {
      this._delegatingStepId = undefined;
    }
  }

  /** After a step completed: completion check, else inject the next step. */
  private _afterStepCompleted(): void {
    if (this._snapshot.phase !== "executing") {
      return;
    }
    const plan = this._snapshot.plan!;
    const allDone = plan.steps.every((step) => step.status === "completed" || step.status === "skipped");
    if (allDone) {
      this._snapshot.phase = "completed";
      plan.status = "completed";
      this._snapshot.updatedAt = Date.now();
      this._clearExecutionWatchdog();
      this._pendingExecutionTurnId = undefined;
      this._commit("plan_execution_completed");
      this._recordEvent("plan_execution_completed", { version: plan.version, status: "completed" });
      return;
    }
    if (plan.steps.some((step) => step.status === "failed")) {
      return; // a failed step already paused the plan; no auto-advance.
    }
    const next = this._pickNextStep();
    if (next) {
      if (next.executionTarget === "parent") {
        void this._triggerExecutionTurn(next).catch((err) => {
          console.warn("[PlanController] failed to inject next step:", err);
        });
      } else {
        void this._delegateStep(next).catch((err) => {
          console.warn("[PlanController] failed to delegate next step:", err);
        });
      }
    }
  }

  /** After a step failed: pause the plan (never auto-advance past a failure). */
  private _afterStepFailed(): void {
    if (this._snapshot.phase !== "executing") {
      return;
    }
    const plan = this._snapshot.plan!;
    plan.status = "paused";
    this._snapshot.phase = "paused";
    this._snapshot.updatedAt = Date.now();
    this._clearExecutionWatchdog();
    this._pendingExecutionTurnId = undefined;
    this._commit("plan_execution_failed");
    this._recordEvent("plan_execution_failed", { version: plan.version, status: "paused" });
  }

  /** Completion check after a host-driven transition (skipStep). */
  private _checkCompletionAfterHostTransition(): void {
    const plan = this._snapshot.plan;
    if (!plan) {
      return;
    }
    const allDone = plan.steps.every((step) => step.status === "completed" || step.status === "skipped");
    if (allDone && (this._snapshot.phase === "executing" || this._snapshot.phase === "paused")) {
      this._snapshot.phase = "completed";
      plan.status = "completed";
      this._snapshot.updatedAt = Date.now();
      this._clearExecutionWatchdog();
      this._pendingExecutionTurnId = undefined;
      this._commit("plan_execution_completed");
      this._recordEvent("plan_execution_completed", { version: plan.version, status: "completed" });
    }
  }

  // =========================================================================
  // Session events
  // =========================================================================

  private _bindSessionEvents(): void {
    if (this._sessionUnsubscribe) {
      return;
    }
    this._sessionUnsubscribe = this._ctx.getSession().subscribe((event) => {
      this._onSessionEvent(event);
    });
  }

  private _onSessionEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "tool_execution_start":
        this._onToolExecutionStart(event.toolCallId, event.toolName, event.args);
        break;
      case "tool_execution_end":
        this._onToolExecutionEnd(event.toolCallId);
        break;
      case "message_end":
        this._onMessageEnd(event);
        break;
      case "agent_end":
        this._onTurnSettled();
        break;
      case "file_change":
        this._onFileChange(event.change);
        break;
      default:
        break;
    }
  }

  private _onToolExecutionStart(toolCallId: string, toolName: string, args: unknown): void {
    if (this._snapshot.phase === "executing" && toolName === "request_user_input") {
      const plan = this._snapshot.plan!;
      const running = plan.steps.find((step) => step.status === "running");
      const waiting = plan.steps.find(
        (step) => step.status === "waiting_input" && step.waitingReason === "user_input",
      );
      const target = running ?? waiting;
      if (target) {
        if (target.status !== "waiting_input") {
          target.status = "waiting_input";
          target.waitingReason = "user_input";
          this._commitStep(plan, target, "plan_step_waiting_input");
        }
        this._waitingInputByToolCall.set(toolCallId, { stepId: target.stepId });
      }
      return;
    }
    if (this._snapshot.phase === "executing" && toolName === "bash") {
      const plan = this._snapshot.plan!;
      const running = plan.steps.find((step) => step.status === "running");
      if (running) {
        const command = (args as { command?: unknown } | null | undefined)?.command;
        if (typeof command === "string" && command !== "") {
          const deviation = detectCommandDeviation(toolCallId, command, running);
          if (deviation) {
            this._recordDeviation(deviation);
          }
        }
      }
    }
  }

  private _onToolExecutionEnd(toolCallId: string): void {
    const entry = this._waitingInputByToolCall.get(toolCallId);
    if (entry === undefined) {
      return;
    }
    this._waitingInputByToolCall.delete(toolCallId);
    const plan = this._snapshot.plan;
    if (!plan) {
      return;
    }
    const step = plan.steps.find((candidate) => candidate.stepId === entry.stepId);
    if (step && step.status === "waiting_input" && step.waitingReason === "user_input") {
      step.status = "running";
      step.waitingReason = "";
      this._commitStep(plan, step, "plan_step_running");
    }
  }

  private _onMessageEnd(event: Extract<AgentSessionEvent, { type: "message_end" }>): void {
    if (event.message.role !== "assistant") {
      return;
    }
    this._lastAssistantStopReason = (event.message as { stopReason?: string }).stopReason ?? undefined;
  }

  private _onTurnSettled(): void {
    const live = this._liveGeneration;
    const stale = this._staleSettlePending;
    const abortId = this._abortPendingGenerationId;
    if (stale) {
      this._staleSettlePending = false;
      this._notifyLiveCleared();
    }
    if (!live) {
      if (!stale) {
        this._notifyLiveCleared();
      }
      this._abortPendingGenerationId = undefined;
      this._onExecutionTurnSettled();
      return;
    }
    // A late settle of a generation whose live turn was aborted (watchdog
    // timeout / user cancel / invalid-plan rejection) only cleans up the live
    // fields: the failure/cancelled snapshot was already written by the abort
    // path, so the settle must never fail a newer generation (Plan 616: old
    // generation settle/tool events are diagnostic only).
    if (abortId === live.generationId) {
      this._liveGeneration = undefined;
      this._abortPendingGenerationId = undefined;
      this._clearWatchdog();
      this._restoreParentState();
      if (!stale) {
        this._notifyLiveCleared();
      }
      return;
    }
    // Plan-path cancel / execution abort may have started a newer generation
    // before this aborted turn's agent_end arrived. While that new turn is
    // still streaming, this settle cannot be its end.
    if (stale && abortId !== live.generationId && this._ctx.getSession().isStreaming) {
      this._abortPendingGenerationId = undefined;
      return;
    }
    this._liveGeneration = undefined;
    this._clearWatchdog();
    if (!stale) {
      this._notifyLiveCleared();
    }
    const generation = this._snapshot.generation;
    if (!generation || generation.generationId !== live.generationId) {
      return; // a newer generation replaced this one; diagnostic only.
    }
    const stopReason = this._lastAssistantStopReason;
    const code: PlanGenerationFailure["code"] =
      stopReason === "length" ? "truncated" : "invalid_plan";
    this._failGeneration(
      code,
      code === "truncated"
        ? "The plan generation was truncated before a complete plan was submitted."
        : "The turn settled without an accepted plan submission.",
      true,
    );
  }

  private _onExecutionTurnSettled(): void {
    if (this._snapshot.phase !== "executing") {
      return;
    }
    const pending = this._pendingExecutionTurnId;
    this._pendingExecutionTurnId = undefined;
    this._clearExecutionWatchdog();
    const plan = this._snapshot.plan;
    if (!plan) {
      return;
    }
    for (const step of plan.steps) {
      if (step.status === "waiting_input" && step.waitingReason === "user_input") {
        step.status = "running";
        step.waitingReason = "";
        this._commitStep(plan, step, "plan_step_running");
      }
    }
    if (this._delegatingStepId !== undefined) {
      return;
    }
    if (pending === undefined || pending !== this._executionTurnId) {
      return;
    }
    const running = plan.steps.find((step) => step.status === "running");
    if (!running) {
      return;
    }
    running.status = "failed";
    running.waitingReason = "";
    this._commitStep(plan, running, "plan_step_failed");
    this._afterStepFailed();
  }

  private _onFileChange(change: FileChangeSummary): void {
    if (this._snapshot.phase !== "executing") {
      return;
    }
    const plan = this._snapshot.plan!;
    const running = plan.steps.find((step) => step.status === "running");
    if (!running) {
      return; // no current step; not judged.
    }
    const context = this._executionPathContext();
    void detectFileDeviation(change, running, context).then((deviation) => {
      if (deviation) {
        this._recordDeviation(deviation);
      }
    }).catch((err) => {
      console.warn("[PlanController] file deviation detection failed:", err);
    });
  }

  private _executionPathContext(): PlanPathContext {
    const execution = this._ctx.getExecutionContext();
    return {
      logicalCwd: execution.logicalCwd,
      isWsl: execution.isWsl,
      executionBackend: execution.executionBackend,
    };
  }

  private _recordDeviation(deviation: PlanDeviation): void {
    this._snapshot.deviations.push(deviation);
    if (this._snapshot.deviations.length > PLAN_MAX_DEVIATIONS) {
      this._snapshot.deviations.splice(0, this._snapshot.deviations.length - PLAN_MAX_DEVIATIONS);
    }
    this._snapshot.updatedAt = Date.now();
    this._commit("plan_deviation");
    for (const listener of this._listeners) {
      try {
        listener({ type: "plan_deviation", deviation });
      } catch (err) {
        console.warn("[PlanController] plan_deviation listener error:", err);
      }
    }
  }

  // =========================================================================
  // Watchdog
  // =========================================================================

  private _armWatchdog(generationId: string): void {
    this._clearWatchdog();
    this._watchdogGenerationId = generationId;
    // unref: the watchdog must never keep the host process alive on its own.
    this._watchdog = setTimeout(() => {
      if (this._disposed || this._watchdogGenerationId !== generationId) {
        return;
      }
      this._watchdogGenerationId = undefined;
      this._watchdog = undefined;
      // Keep the live marker: the aborted turn's settle is still in flight
      // and must be attributed to THIS generation (cleanup only), never to a
      // newer generation started after the timeout.
      this._abortPendingGenerationId = generationId;
      this._abortLiveTurn();
      this._failGeneration("timeout", `The plan generation timed out after ${this._generationTimeoutMs}ms.`, true);
      void this._awaitLiveCleared(PLAN_ABORT_SETTLE_MS);
    }, this._generationTimeoutMs);
    this._watchdog.unref?.();
  }

  private _clearWatchdog(): void {
    if (this._watchdog) {
      clearTimeout(this._watchdog);
      this._watchdog = undefined;
    }
    this._watchdogGenerationId = undefined;
  }

  private _abortLiveTurn(): void {
    if (this._liveGeneration !== undefined || this._ctx.getSession().isStreaming) {
      this._staleSettlePending = true;
    }
    try {
      void this._ctx.getSession().abort().catch(() => {});
    } catch {
      // abort is best-effort during disposal.
    }
  }

  private _notifyLiveCleared(): void {
    const waiters = this._liveClearedWaiters;
    this._liveClearedWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  private async _awaitLiveCleared(timeoutMs: number): Promise<void> {
    if (this._liveGeneration === undefined && !this._ctx.getSession().isStreaming) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this._liveGeneration = undefined;
        // Keep _abortPendingGenerationId / _staleSettlePending: a settle that
        // arrives after a newer generation started must still be diagnostic.
        this._notifyLiveCleared();
        resolve();
      }, timeoutMs);
      this._liveClearedWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private _armExecutionTurn(): void {
    this._executionTurnId += 1;
    this._pendingExecutionTurnId = this._executionTurnId;
    this._armExecutionWatchdog();
  }

  private _invalidateExecutionTurns(): void {
    this._executionTurnId += 1;
    this._pendingExecutionTurnId = undefined;
    this._clearExecutionWatchdog();
  }

  private _armExecutionWatchdog(): void {
    this._clearExecutionWatchdog();
    const turnId = this._executionTurnId;
    this._executionWatchdog = setTimeout(() => {
      if (this._disposed || this._executionTurnId !== turnId) {
        return;
      }
      this._executionWatchdog = undefined;
      this._pendingExecutionTurnId = undefined;
      this._abortLiveTurn();
      if (this._snapshot.phase !== "executing") {
        return;
      }
      const plan = this._snapshot.plan;
      if (!plan) {
        return;
      }
      const running = plan.steps.find(
        (step) =>
          step.status === "running" ||
          (step.status === "waiting_input" && step.waitingReason === "user_input"),
      );
      if (!running) {
        return;
      }
      running.status = "failed";
      running.waitingReason = "";
      this._commitStep(plan, running, "plan_step_failed");
      this._afterStepFailed();
    }, this._generationTimeoutMs);
    this._executionWatchdog.unref?.();
  }

  private _clearExecutionWatchdog(): void {
    if (this._executionWatchdog) {
      clearTimeout(this._executionWatchdog);
      this._executionWatchdog = undefined;
    }
  }

  private _registerPlanLinkedGroup(groupId: string, link: PlanStepExecutionLink): void {
    this._planLinkedGroups.set(groupId, { groupId, link });
  }

  private async _confirmLinkedGroup(step: PlanStep, plan: Plan): Promise<void> {
    const tracked = [...this._planLinkedGroups.values()].find((entry) => entry.link.stepId === step.stepId);
    const groupId = step.consumedTaskGroupId || tracked?.groupId;
    if (!groupId) {
      return;
    }
    const confirm = this._ctx.confirmPlanTaskGroupConsumed;
    if (confirm) {
      try {
        await confirm(groupId, { planId: plan.planId, version: plan.version, stepId: step.stepId });
      } catch (err) {
        console.warn("[PlanController] plan-linked group confirm failed:", err);
      }
    }
    this._planLinkedGroups.delete(groupId);
  }

  // =========================================================================
  // Snapshot / persistence / events
  // =========================================================================

  private _versionMismatch(planId: string, version: number): string | undefined {
    if (this._snapshot.planId !== planId) {
      return "stale_plan";
    }
    if (this._snapshot.plan === null || this._snapshot.plan.version !== version) {
      return "stale_version";
    }
    return undefined;
  }

  /** Persist the current snapshot, bump the sequence and notify listeners. */
  private _commit(event: string): void {
    this._snapshot.updatedAt = Date.now();
    this._sequence += 1;
    try {
      this._ctx.getSessionManager().appendCustomEntry(
        PLAN_CUSTOM_TYPE,
        serializePlanRecord(this._snapshot, event, this._sequence),
      );
    } catch (err) {
      console.warn("[PlanController] failed to persist plan record:", err);
    }
    const snapshot = structuredClone(this._snapshot);
    for (const listener of this._listeners) {
      try {
        listener({ type: "plan_state", snapshot });
      } catch (err) {
        console.warn("[PlanController] plan_state listener error:", err);
      }
    }
  }

  /** Persist + emit a step-level event. */
  private _commitStep(plan: Plan, step: PlanStep, event: string): void {
    this._commit(event);
    for (const listener of this._listeners) {
      try {
        listener({ type: "plan_step", planId: plan.planId, version: plan.version, step: structuredClone(step) });
      } catch (err) {
        console.warn("[PlanController] plan_step listener error:", err);
      }
    }
  }

  private _recordEvent(name: string, payload: ProductEventPayload): void {
    try {
      this._ctx.recordProductEvent({ schemaVersion: 1, name: name as ProductEvent["name"], payload });
    } catch (err) {
      console.warn("[PlanController] product event record failed:", err);
    }
  }

  // =========================================================================
  // Hydration
  // =========================================================================

  private async _hydrate(rebuilt: RebuiltPlanRecord, hydration: PlanTaskLinkHydration): Promise<void> {
    this._snapshot = structuredClone(rebuilt.snapshot);
    this._sequence = rebuilt.sequence;
    this._liveGeneration = undefined;
    // A hydrated controller starts with no in-flight turn: no abort marker
    // may survive into the reopened session.
    this._abortPendingGenerationId = undefined;
    this._staleSettlePending = false;
    this._clearWatchdog();
    this._waitingInputByToolCall.clear();
    // The frozen parent model/thinking/tools is controller-private state and
    // died with the previous controller instance. A hydrated plan session
    // (planId !== null) must re-freeze the CURRENT (already restored) parent
    // state so approve/submitPlan/_failGeneration/cancel can hand the parent
    // tool surface and model back, and useSessionModelAndRetry finds a frozen
    // model instead of misreporting model_unavailable. restoreFromHistory is
    // called by SessionBridge only after the session exists (getSession()
    // available).
    if (this._snapshot.planId !== null) {
      this._freezeParentSnapshot();
    }

    const snapshot = this._snapshot;
    // 关闭后的生成水合: a planning/revising snapshot with a generation but no
    // failure becomes a retryable cancelled failure (the generation is a retry
    // credential, never a live turn).
    if (
      (snapshot.phase === "planning" || snapshot.phase === "revising") &&
      snapshot.generation !== undefined &&
      snapshot.failure === undefined
    ) {
      snapshot.failure = {
        generationId: snapshot.generation.generationId,
        phase: snapshot.generation.kind === "revision" ? "revision" : "initial",
        code: "cancelled",
        message: "The plan generation was interrupted; retry to continue.",
        fieldErrors: [],
        retryable: true,
        occurredAt: Date.now(),
      };
      this._commit("plan_hydrated");
    }
    // A8 hydration: an executing plan / running or waiting_input step becomes
    // paused + failed (parent-directly-executed steps). 1.4.2 (R4): task-linked
    // steps (agent_task + waitingTaskGroupId) hydrate directly to
    // "interrupted" and keep waitingReason=agent_task + waitingTaskGroupId as
    // the only stable association to consume the same group after recovery -
    // never failed first and rewritten; the same-app reopened session /
    // restarted app resumes them via continuePlan.
    if (
      snapshot.phase === "executing" ||
      (snapshot.plan !== null && snapshot.plan.steps.some((s) => s.status === "running" || s.status === "waiting_input"))
    ) {
      const plan = snapshot.plan;
      if (plan) {
        let changed = false;
        for (const step of plan.steps) {
          if (step.status === "running" || step.status === "waiting_input") {
            if (step.waitingReason === "agent_task" && typeof step.waitingTaskGroupId === "string") {
              if (hydration === "session_reopen") {
                changed = true;
                continue;
              }
              step.status = "interrupted";
              changed = true;
              continue;
            }
            if (typeof step.consumedTaskGroupId === "string" && step.consumedTaskGroupId !== "") {
              changed = true;
              continue;
            }
            step.status = "failed";
            step.waitingReason = "";
            changed = true;
          }
        }
        plan.status = "paused";
        snapshot.phase = "paused";
        if (changed) {
          this._commit("plan_hydrated");
        }
      } else {
        this._commit("plan_hydrated");
      }
    }
    // 1.4.1 replay: unfinished pendingTaskLinkReleases intents are replayed
    // idempotently (then cleared) and consumed groups are re-confirmed from
    // the persisted consumedTaskGroupId, so a crash between the two writes is
    // recovered; tasks stay protected until confirm/release.
    await this._replayTaskLinkIntents();
    this._checkCompletionAfterHostTransition();
  }

  /**
   * 1.4.1 hydration replay of task-link compensation intents: re-run any
   * persisted pendingTaskLinkReleases (release is idempotent) then clear them,
   * and re-confirm consumption for steps with a persisted consumedTaskGroupId.
   */
  private async _replayTaskLinkIntents(): Promise<void> {
    const release = this._ctx.releasePlanTaskGroup;
    const snapshot = this._snapshot;
    const intents = snapshot.pendingTaskLinkReleases ?? [];
    if (intents.length > 0 && release) {
      for (const intent of intents) {
        try {
          await release(intent.groupId, intent.link, intent.reason);
        } catch (err) {
          // Keep the intent so the next hydration replays it again.
          console.warn("[PlanController] task link release replay failed:", err);
          return;
        }
      }
      snapshot.pendingTaskLinkReleases = undefined;
      snapshot.updatedAt = Date.now();
      this._commit("plan_link_release_done");
    }
    const confirm = this._ctx.confirmPlanTaskGroupConsumed;
    const plan = snapshot.plan;
    if (plan && confirm) {
      for (const step of plan.steps) {
        if (typeof step.consumedTaskGroupId === "string" && step.consumedTaskGroupId !== "") {
          try {
            await confirm(step.consumedTaskGroupId, { planId: plan.planId, version: plan.version, stepId: step.stepId });
          } catch (err) {
            console.warn("[PlanController] task group consumption confirm replay failed:", err);
          }
        }
      }
    }
  }

  // =========================================================================
  // 1.4.1 Plan-linked task file changes (background deviation detection)
  // =========================================================================

  private _onPlanLinkedTaskFileChange(event: PlanLinkedTaskFileChangeEvent): void {
    const plan = this._snapshot.plan;
    if (!plan || plan.planId !== event.planId || plan.version !== event.version) {
      return; // stale link from an older revision; diagnostic only.
    }
    const step = plan.steps.find((candidate) => candidate.stepId === event.stepId);
    if (!step) {
      return;
    }
    if (
      step.status === "completed" ||
      step.status === "failed" ||
      step.status === "skipped" ||
      step.status === "cancelled"
    ) {
      return; // terminal steps are never judged by late events.
    }
    if (step.executionTarget === "subagent_foreground" && step.status === "running") {
      return;
    }
    void detectFileDeviation(event.change, step, this._executionPathContext())
      .then((deviation) => {
        if (deviation) {
          this._recordDeviation(deviation);
        }
      })
      .catch((err) => {
        console.warn("[PlanController] task file deviation detection failed:", err);
      });
  }
}
