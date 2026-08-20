/**
 * Plan Store (PiX 1.4.0)
 *
 * Pinia mirror of the Solo Plan state owned by the main-process PlanController.
 * The renderer never mutates plan state: every change arrives as a
 * plan_state/plan_step/plan_deviation event or as the get_snapshot remount
 * catch-up, and actions map one-to-one onto the §4.9 PlanCommand IPC contract
 * through the usePlanRpc transport.
 *
 * Busy flags: isGenerating covers live generation turns (phase planning/
 * revising without a recorded failure - a failure means that generation already
 * ended, including the dormant planning state hydrated after a session close)
 * plus the in-flight window of generation commands; isApproving covers the
 * in-flight window of the approve command. Both are cleared by the next
 * plan_state snapshot, which is authoritative.
 */

import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { usePlanRpc } from "../composables/usePlanRpc";
import type {
  ClipboardImage,
  Plan,
  PlanCancelRef,
  PlanCommand,
  PlanDeviation,
  PlanEvent,
  PlanGenerationFailure,
  PlanRevisionState,
  PlanRuntimeSnapshot,
  PlanStatus,
  PlanStep,
  PixCommandResult,
} from "@shared/types.js";

type PlanCommandResult = PixCommandResult<PlanRuntimeSnapshot | undefined>;

export const usePlanStore = defineStore("plan", () => {
  const planRpc = usePlanRpc();

  // ==========================================================================
  // State
  // ==========================================================================

  /** Current displayed plan version (snapshot.plan); null before one exists. */
  const currentPlan = ref<Plan | null>(null);

  /** Current plan phase (snapshot.phase); null before the first snapshot. */
  const planPhase = ref<PlanStatus | null>(null);

  /** Detected plan deviations (snapshot.deviations plus live pushes). */
  const deviations = ref<PlanDeviation[]>([]);

  /** Last error message from a plan command. */
  const lastError = ref<string | null>(null);

  /** Last authoritative snapshot; kept for phase/failure derivations. */
  const latestSnapshot = ref<PlanRuntimeSnapshot | null>(null);

  /** Latest generation failure (snapshot.failure). A dedicated ref so a
   * failure-only plan_state update is reactive even when planPhase is
   * unchanged (e.g. a revision failure keeps phase=revising). */
  const failure = ref<PlanGenerationFailure | null>(null);

  /** Active revision context (snapshot.revision); undefined when not revising. */
  const revision = ref<PlanRevisionState | undefined>(undefined);

  /** A generation command is in flight (before its plan_state event arrives). */
  const generationPending = ref(false);

  /** The approve command is in flight. */
  const approvalPending = ref(false);

  // ==========================================================================
  // Computed
  // ==========================================================================

  const isGenerating = computed(
    () =>
      generationPending.value ||
      ((planPhase.value === "planning" || planPhase.value === "revising") &&
        latestSnapshot.value?.failure === undefined),
  );

  const isApproving = computed(() => approvalPending.value);

  // ==========================================================================
  // Snapshot / event handling
  // ==========================================================================

  /** Replace the mirrored state with an authoritative controller snapshot. */
  function applySnapshot(snapshot: PlanRuntimeSnapshot): void {
    latestSnapshot.value = snapshot;
    currentPlan.value = snapshot.plan ?? null;
    planPhase.value = snapshot.phase;
    deviations.value = snapshot.deviations;
    failure.value = snapshot.failure ?? null;
    revision.value = snapshot.revision;
    generationPending.value = false;
    approvalPending.value = false;
  }

  /** Apply a plan_step push to the current plan version (idempotent). */
  function applyStepEvent(planId: string, version: number, step: PlanStep): void {
    const plan = currentPlan.value;
    // Late pushes for a previous plan/version must not mutate the mirror
    // (§4.9 stale-response protection); the next plan_state is authoritative.
    if (!plan || plan.planId !== planId || plan.version !== version) return;
    const idx = plan.steps.findIndex((s) => s.stepId === step.stepId);
    if (idx < 0) return;
    const steps = plan.steps.slice();
    steps[idx] = step;
    currentPlan.value = { ...plan, steps };
  }

  /** Append a deviation push; duplicate pushes are ignored (idempotent). */
  function applyDeviationEvent(deviation: PlanDeviation): void {
    if (deviations.value.some((d) => d.toolCallId === deviation.toolCallId)) return;
    deviations.value = [...deviations.value, deviation];
  }

  function handlePlanEvent(event: PlanEvent): void {
    switch (event.type) {
      case "plan_state":
        applySnapshot(event.snapshot);
        break;
      case "plan_step":
        applyStepEvent(event.planId, event.version, event.step);
        break;
      case "plan_deviation":
        applyDeviationEvent(event.deviation);
        break;
    }
  }

  // ==========================================================================
  // Subscription
  // ==========================================================================

  let unsubscribePlanEvents: (() => void) | null = null;

  /**
   * Subscribe to plan events from main and sync the current snapshot. Must be
   * called once on app init / panel mount. A re-subscribe (window reopen,
   * component remount) replaces the previous subscription instead of stacking
   * a second listener that would process every event twice.
   */
  function subscribeToEvents(): () => void {
    if (unsubscribePlanEvents) {
      unsubscribePlanEvents();
    }
    const off = planRpc.onPlanEvent((event) => {
      handlePlanEvent(event);
    });
    unsubscribePlanEvents = () => {
      off();
      unsubscribePlanEvents = null;
    };
    // Remount catch-up: query the authoritative snapshot AFTER the
    // subscription is live, so a push arriving before the response is never
    // overwritten by an older snapshot result. The controller serializes
    // get_snapshot against its own state, so the response is never older than
    // any already-delivered push.
    void refreshSnapshot();
    return unsubscribePlanEvents;
  }

  /** Query the authoritative controller snapshot (remount catch-up). */
  async function refreshSnapshot(): Promise<PlanRuntimeSnapshot | null> {
    try {
      const result = await planRpc.sendPlanCommand({ type: "get_snapshot" });
      if (result.success && result.data) {
        applySnapshot(result.data);
        return result.data;
      }
      return null;
    } catch (err) {
      console.error("[plan-store] Failed to get plan snapshot:", err);
      return null;
    }
  }

  // ==========================================================================
  // Commands
  // ==========================================================================

  /**
   * Send a plan command through the preload API and mirror the returned
   * snapshot if the command carries one. Busy flags bracket the in-flight
   * window and are also cleared by the next plan_state event; phase-derived
   * isGenerating keeps the flag true across the whole live generation.
   */
  async function runCommand(
    command: PlanCommand,
    busy?: { generation?: boolean; approval?: boolean },
  ): Promise<PlanCommandResult> {
    if (busy?.generation) generationPending.value = true;
    if (busy?.approval) approvalPending.value = true;
    try {
      const result = await planRpc.sendPlanCommand(command);
      if (result.success) {
        lastError.value = null;
        if (result.data) applySnapshot(result.data);
      } else {
        lastError.value = result.error ?? `计划命令 ${command.type} 执行失败`;
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError.value = message;
      return { success: false, error: message, code: "plan_command_failed" };
    } finally {
      if (busy?.generation) generationPending.value = false;
      if (busy?.approval) approvalPending.value = false;
    }
  }

  /** Enter planning with a user request (first armed submit) or resume a dormant turn. */
  function enterPlanning(options?: {
    requestText?: string;
    filePaths?: string[];
    images?: ClipboardImage[];
    source?: "configured" | "session";
  }): Promise<PlanCommandResult> {
    return runCommand({ type: "enter_planning", ...options }, { generation: true });
  }

  function retryGeneration(generationId: string): Promise<PlanCommandResult> {
    return runCommand({ type: "retry_generation", generationId }, { generation: true });
  }

  function useSessionModelAndRetry(generationId: string): Promise<PlanCommandResult> {
    return runCommand({ type: "use_session_model_and_retry", generationId }, { generation: true });
  }

  function regeneratePlan(generationId: string, concise: boolean): Promise<PlanCommandResult> {
    return runCommand({ type: "regenerate_plan", generationId, concise }, { generation: true });
  }

  function requestRevision(
    planId: string,
    version: number,
    feedback: string,
    stepKey?: string,
  ): Promise<PlanCommandResult> {
    return runCommand({ type: "request_revision", planId, version, feedback, stepKey }, { generation: true });
  }

  function returnPreviousVersion(planId: string, baseVersion: number): Promise<PlanCommandResult> {
    return runCommand({ type: "return_previous_version", planId, baseVersion });
  }

  function approve(planId: string, version: number): Promise<PlanCommandResult> {
    return runCommand({ type: "approve", planId, version }, { approval: true });
  }

  function startExecution(planId: string, version: number): Promise<PlanCommandResult> {
    return runCommand({ type: "start_execution", planId, version });
  }

  function cancel(ref: PlanCancelRef): Promise<PlanCommandResult> {
    return runCommand({ type: "cancel", ...ref });
  }

  function retryStep(planId: string, version: number, stepId: string): Promise<PlanCommandResult> {
    return runCommand({ type: "retry_step", planId, version, stepId });
  }

  function skipStep(planId: string, version: number, stepId: string): Promise<PlanCommandResult> {
    return runCommand({ type: "skip_step", planId, version, stepId });
  }

  function continuePlan(planId: string, version: number): Promise<PlanCommandResult> {
    return runCommand({ type: "continue_plan", planId, version });
  }

  function clearError(): void {
    lastError.value = null;
  }

  // ==========================================================================
  // Expose
  // ==========================================================================

  return {
    // State
    currentPlan,
    planPhase,
    deviations,
    lastError,
    failure,
    revision,
    latestSnapshot,
    // Computed
    isGenerating,
    isApproving,
    // Subscription
    subscribeToEvents,
    refreshSnapshot,
    // Actions (map plan-command)
    enterPlanning,
    retryGeneration,
    useSessionModelAndRetry,
    regeneratePlan,
    requestRevision,
    returnPreviousVersion,
    approve,
    startExecution,
    cancel,
    retryStep,
    skipStep,
    continuePlan,
    clearError,
  };
});
