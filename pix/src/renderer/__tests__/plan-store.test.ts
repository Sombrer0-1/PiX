/**
 * Plan store tests (PiX 1.4.0, stage P3).
 *
 * Acceptance: subscription, remount get_snapshot catch-up and repeated-event
 * idempotency. The store talks to main only through window.pixApi
 * (sendPlanCommand / onPlanEvent), so the tests stub that surface in
 * happy-dom - no Electron runtime is loaded.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { PixApi } from "../../main/preload";
import type {
  Plan,
  PlanDeviation,
  PlanEvent,
  PlanRuntimeSnapshot,
  PlanStep,
  PixCommandResult,
} from "@shared/types.js";
import { usePlanStore } from "../stores/plan-store";

// ============================================================================
// Fixtures
// ============================================================================

function makeStep(overrides?: Partial<PlanStep>): PlanStep {
  return {
    stepKey: "k1",
    stepId: "s1",
    title: "Step 1",
    description: "Do the thing",
    files: [],
    executionTarget: "parent",
    risk: "low",
    riskReason: "Low risk",
    effort: "small",
    verification: "Check the output",
    dependsOn: [],
    status: "pending",
    waitingReason: "",
    ...overrides,
  };
}

function makePlan(overrides?: Partial<Plan>): Plan {
  return {
    schemaVersion: 1,
    planId: "plan-1",
    version: 1,
    status: "awaiting_approval",
    title: "Plan title",
    summary: "Plan summary",
    planningModel: { provider: "provider", modelId: "model", thinkingLevel: "medium" },
    steps: [makeStep()],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function makeSnapshot(overrides?: Partial<PlanRuntimeSnapshot>): PlanRuntimeSnapshot {
  return {
    schemaVersion: 1,
    phase: "planning",
    planId: null,
    plan: null,
    deviations: [],
    updatedAt: 3,
    ...overrides,
  };
}

function makeDeviation(overrides?: Partial<PlanDeviation>): PlanDeviation {
  return {
    type: "file_out_of_scope",
    stepId: "s1",
    toolCallId: "tc-1",
    path: "outside.txt",
    reason: "File is outside the declared scope",
    detectedAt: 4,
    ...overrides,
  };
}

// ============================================================================
// Harness: stub window.pixApi
// ============================================================================

let sendPlanCommand: ReturnType<typeof vi.fn>;
let onPlanEvent: ReturnType<typeof vi.fn>;
let planEventCallback: ((event: PlanEvent) => void) | null;
const eventUnsubscribers: Array<() => void> = [];

function installPixApiMock(): void {
  planEventCallback = null;
  eventUnsubscribers.length = 0;
  sendPlanCommand = vi.fn().mockResolvedValue({ success: true });
  onPlanEvent = vi.fn((callback: (event: PlanEvent) => void) => {
    planEventCallback = callback;
    const unsubscribe = vi.fn();
    eventUnsubscribers.push(unsubscribe);
    return unsubscribe;
  });
  window.pixApi = { sendPlanCommand, onPlanEvent } as unknown as PixApi;
}

/** Deliver a PlanEvent through the currently registered onPlanEvent callback. */
function emit(event: PlanEvent): void {
  planEventCallback?.(event);
}

function defer<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  setActivePinia(createPinia());
  installPixApiMock();
});

// ============================================================================
// Subscription
// ============================================================================

describe("subscription", () => {
  it("registers one event listener, then queries get_snapshot after it", async () => {
    const store = usePlanStore();
    const snapshot = makeSnapshot({ phase: "awaiting_approval", plan: makePlan() });
    sendPlanCommand.mockResolvedValue({ success: true, data: snapshot });

    const unsubscribe = store.subscribeToEvents();

    expect(onPlanEvent).toHaveBeenCalledTimes(1);
    expect(sendPlanCommand).toHaveBeenCalledWith({ type: "get_snapshot" });
    // Subscription must be installed before the snapshot query so a push
    // arriving early can never be overwritten by a stale snapshot result.
    expect(onPlanEvent.mock.invocationCallOrder[0]).toBeLessThan(sendPlanCommand.mock.invocationCallOrder[0]);

    await vi.waitFor(() => {
      expect(store.currentPlan?.planId).toBe("plan-1");
    });
    expect(store.planPhase).toBe("awaiting_approval");
    expect(store.deviations).toEqual([]);

    unsubscribe();
    expect(eventUnsubscribers[0]).toHaveBeenCalled();
  });

  it("replaces the previous subscription on re-subscribe (remount)", () => {
    const store = usePlanStore();
    store.subscribeToEvents();
    store.subscribeToEvents();

    expect(onPlanEvent).toHaveBeenCalledTimes(2);
    expect(eventUnsubscribers[0]).toHaveBeenCalled();
    expect(eventUnsubscribers[1]).not.toHaveBeenCalled();

    // Events flow only through the live (second) subscription.
    emit({ type: "plan_state", snapshot: makeSnapshot({ phase: "approved", plan: makePlan() }) });
    expect(store.planPhase).toBe("approved");
  });

  it("delivers plan_state events to the mirror", () => {
    const store = usePlanStore();
    store.subscribeToEvents();

    emit({ type: "plan_state", snapshot: makeSnapshot({ phase: "awaiting_approval", plan: makePlan() }) });

    expect(store.planPhase).toBe("awaiting_approval");
    expect(store.currentPlan?.planId).toBe("plan-1");
    expect(store.currentPlan?.steps).toHaveLength(1);
    expect(store.deviations).toEqual([]);
  });
});

// ============================================================================
// Remount get_snapshot catch-up
// ============================================================================

describe("remount get_snapshot", () => {
  it("hydrates the mirror from the get_snapshot response", async () => {
    const store = usePlanStore();
    const snapshot = makeSnapshot({ phase: "paused", plan: makePlan({ status: "paused" }) });
    sendPlanCommand.mockResolvedValue({ success: true, data: snapshot });

    await store.refreshSnapshot();

    expect(sendPlanCommand).toHaveBeenCalledWith({ type: "get_snapshot" });
    expect(store.planPhase).toBe("paused");
    expect(store.currentPlan?.status).toBe("paused");
  });

  it("keeps a push received before the snapshot response, then applies the newer snapshot", async () => {
    const store = usePlanStore();
    const pending = defer<PixCommandResult<PlanRuntimeSnapshot | undefined>>();
    sendPlanCommand.mockReturnValue(pending.promise);

    store.subscribeToEvents();

    // A push arrives while get_snapshot is still in flight.
    emit({ type: "plan_state", snapshot: makeSnapshot({ phase: "planning", plan: makePlan() }) });
    expect(store.planPhase).toBe("planning");

    // The response reflects equal-or-newer controller state and wins.
    const newer = makeSnapshot({ phase: "awaiting_approval", plan: makePlan() });
    pending.resolve({ success: true, data: newer });
    await vi.waitFor(() => {
      expect(store.planPhase).toBe("awaiting_approval");
    });

    // A push arriving after the response wins over it (events carry full snapshots).
    emit({ type: "plan_state", snapshot: makeSnapshot({ phase: "executing", plan: makePlan() }) });
    expect(store.planPhase).toBe("executing");
  });

  it("does not touch the mirror when get_snapshot fails", async () => {
    const store = usePlanStore();
    store.subscribeToEvents();

    // Hydrate the mirror first (as a mounted panel would) so the failure path
    // is exercised against real state, not the store's initial null defaults.
    emit({ type: "plan_state", snapshot: makeSnapshot({ phase: "executing", plan: makePlan() }) });
    expect(store.planPhase).toBe("executing");
    expect(store.currentPlan?.planId).toBe("plan-1");

    sendPlanCommand.mockResolvedValue({ success: false, code: "plan_unavailable", error: "No active session." });

    const result = await store.refreshSnapshot();

    expect(result).toBeNull();
    // The hydrated mirror must survive the failed refresh (returns null, no throw).
    expect(store.planPhase).toBe("executing");
    expect(store.currentPlan?.planId).toBe("plan-1");
  });
});

// ============================================================================
// Repeated-event idempotency
// ============================================================================

describe("repeated-event idempotency", () => {
  it("applies the same plan_state twice without duplicating state", () => {
    const store = usePlanStore();
    store.subscribeToEvents();

    const deviation = makeDeviation();
    const snapshot = makeSnapshot({ phase: "approved", plan: makePlan(), deviations: [deviation] });
    emit({ type: "plan_state", snapshot });
    emit({ type: "plan_state", snapshot });

    expect(store.planPhase).toBe("approved");
    expect(store.currentPlan).toEqual(snapshot.plan);
    expect(store.deviations).toEqual([deviation]);
  });

  it("deduplicates repeated plan_deviation events", () => {
    const store = usePlanStore();
    store.subscribeToEvents();

    const deviation = makeDeviation();
    emit({ type: "plan_deviation", deviation });
    emit({ type: "plan_deviation", deviation });

    expect(store.deviations).toHaveLength(1);
    expect(store.deviations[0].toolCallId).toBe("tc-1");
  });

  it("applies the same plan_step event twice idempotently", () => {
    const store = usePlanStore();
    store.subscribeToEvents();
    emit({ type: "plan_state", snapshot: makeSnapshot({ phase: "executing", plan: makePlan() }) });

    const step = makeStep({ status: "running" });
    const event: PlanEvent = { type: "plan_step", planId: "plan-1", version: 1, step };
    emit(event);
    emit(event);

    expect(store.currentPlan?.steps).toHaveLength(1);
    expect(store.currentPlan?.steps[0].status).toBe("running");
  });

  it("replaces deviations wholesale when plan_state carries the authoritative list", () => {
    const store = usePlanStore();
    store.subscribeToEvents();

    const first = makeDeviation();
    const second = makeDeviation({ toolCallId: "tc-2", path: "other.txt" });
    emit({ type: "plan_deviation", deviation: first });
    emit({ type: "plan_deviation", deviation: second });
    expect(store.deviations).toHaveLength(2);

    // The controller snapshot only carries the first deviation.
    emit({ type: "plan_state", snapshot: makeSnapshot({ phase: "executing", plan: makePlan(), deviations: [first] }) });
    expect(store.deviations).toEqual([first]);
  });

  it("ignores plan_step events for a stale plan/version", () => {
    const store = usePlanStore();
    store.subscribeToEvents();
    emit({ type: "plan_state", snapshot: makeSnapshot({ phase: "executing", plan: makePlan() }) });

    emit({ type: "plan_step", planId: "plan-9", version: 2, step: makeStep({ status: "completed" }) });

    expect(store.currentPlan?.steps[0].status).toBe("pending");
  });
});

// ============================================================================
// Command actions
// ============================================================================

describe("command actions", () => {
  it("maps every plan command onto the IPC contract", async () => {
    const store = usePlanStore();

    await store.enterPlanning({ requestText: "build it", source: "configured" });
    expect(sendPlanCommand).toHaveBeenCalledWith({ type: "enter_planning", requestText: "build it", source: "configured" });

    await store.retryGeneration("g-1");
    expect(sendPlanCommand).toHaveBeenCalledWith({ type: "retry_generation", generationId: "g-1" });

    await store.useSessionModelAndRetry("g-1");
    expect(sendPlanCommand).toHaveBeenCalledWith({ type: "use_session_model_and_retry", generationId: "g-1" });

    await store.regeneratePlan("g-1", true);
    expect(sendPlanCommand).toHaveBeenCalledWith({ type: "regenerate_plan", generationId: "g-1", concise: true });

    await store.requestRevision("plan-1", 1, "more detail", "s1");
    expect(sendPlanCommand).toHaveBeenCalledWith({
      type: "request_revision",
      planId: "plan-1",
      version: 1,
      feedback: "more detail",
      stepKey: "s1",
    });

    await store.returnPreviousVersion("plan-1", 1);
    expect(sendPlanCommand).toHaveBeenCalledWith({ type: "return_previous_version", planId: "plan-1", baseVersion: 1 });

    await store.approve("plan-1", 1);
    expect(sendPlanCommand).toHaveBeenCalledWith({ type: "approve", planId: "plan-1", version: 1 });

    await store.startExecution("plan-1", 1);
    expect(sendPlanCommand).toHaveBeenCalledWith({ type: "start_execution", planId: "plan-1", version: 1 });

    await store.cancel({ planId: "plan-1", version: 1 });
    expect(sendPlanCommand).toHaveBeenCalledWith({ type: "cancel", planId: "plan-1", version: 1 });

    await store.cancel({ planId: "plan-1", generationId: "g-1" });
    expect(sendPlanCommand).toHaveBeenCalledWith({ type: "cancel", planId: "plan-1", generationId: "g-1" });

    await store.retryStep("plan-1", 1, "s1");
    expect(sendPlanCommand).toHaveBeenCalledWith({ type: "retry_step", planId: "plan-1", version: 1, stepId: "s1" });

    await store.skipStep("plan-1", 1, "s1");
    expect(sendPlanCommand).toHaveBeenCalledWith({ type: "skip_step", planId: "plan-1", version: 1, stepId: "s1" });

    await store.continuePlan("plan-1", 1);
    expect(sendPlanCommand).toHaveBeenCalledWith({ type: "continue_plan", planId: "plan-1", version: 1 });
  });

  it("tracks isGenerating across the generation command and its plan_state events", async () => {
    const store = usePlanStore();
    store.subscribeToEvents();

    const pending = defer<PixCommandResult<PlanRuntimeSnapshot | undefined>>();
    sendPlanCommand.mockReturnValue(pending.promise);

    const command = store.enterPlanning({ requestText: "build it" });
    expect(store.isGenerating).toBe(true);

    pending.resolve({ success: true });
    await command;
    // Phase not updated yet (no plan_state): the in-flight flag has settled.
    expect(store.isGenerating).toBe(false);

    // Live planning turn: derived from the phase.
    emit({ type: "plan_state", snapshot: makeSnapshot({ phase: "planning", planId: "plan-1" }) });
    expect(store.isGenerating).toBe(true);

    // Generation ended in failure: no longer generating.
    emit({
      type: "plan_state",
      snapshot: makeSnapshot({
        phase: "planning_failed",
        planId: "plan-1",
        failure: {
          generationId: "g-1",
          phase: "initial",
          code: "invalid_plan",
          message: "Invalid plan",
          fieldErrors: [],
          retryable: true,
          occurredAt: 5,
        },
      }),
    });
    expect(store.isGenerating).toBe(false);

    // Revision turn is also a live generation.
    emit({ type: "plan_state", snapshot: makeSnapshot({ phase: "revising", plan: makePlan() }) });
    expect(store.isGenerating).toBe(true);
    emit({ type: "plan_state", snapshot: makeSnapshot({ phase: "awaiting_approval", plan: makePlan() }) });
    expect(store.isGenerating).toBe(false);
  });

  it("does not report generation for a dormant planning snapshot with a failure", () => {
    const store = usePlanStore();
    store.subscribeToEvents();

    emit({
      type: "plan_state",
      snapshot: makeSnapshot({
        phase: "planning",
        planId: "plan-1",
        failure: {
          generationId: "g-1",
          phase: "initial",
          code: "cancelled",
          message: "Interrupted",
          fieldErrors: [],
          retryable: true,
          occurredAt: 5,
        },
      }),
    });

    expect(store.planPhase).toBe("planning");
    expect(store.isGenerating).toBe(false);
  });

  it("tracks isApproving while approve is in flight", async () => {
    const store = usePlanStore();

    const pending = defer<PixCommandResult<PlanRuntimeSnapshot | undefined>>();
    sendPlanCommand.mockReturnValue(pending.promise);

    const command = store.approve("plan-1", 1);
    expect(store.isApproving).toBe(true);

    pending.resolve({ success: true });
    await command;
    expect(store.isApproving).toBe(false);
  });

  it("surfaces command failures in lastError and clears busy flags", async () => {
    const store = usePlanStore();
    sendPlanCommand.mockResolvedValue({ success: false, code: "stale_version", error: "Plan version is stale." });

    const result = await store.approve("plan-1", 1);

    expect(result.success).toBe(false);
    expect(store.lastError).toBe("Plan version is stale.");
    expect(store.isApproving).toBe(false);
    expect(store.isGenerating).toBe(false);
  });

  it("applies a snapshot carried by a command response and clears lastError on success", async () => {
    const store = usePlanStore();
    sendPlanCommand.mockResolvedValue({ success: false, code: "stale_version", error: "Plan version is stale." });
    await store.approve("plan-1", 1);
    expect(store.lastError).toBe("Plan version is stale.");

    const snapshot = makeSnapshot({ phase: "approved", plan: makePlan() });
    sendPlanCommand.mockResolvedValue({ success: true, data: snapshot });
    const result = await store.refreshSnapshot();

    expect(result).toEqual(snapshot);
    expect(store.planPhase).toBe("approved");
  });

  it("exposes clearError", async () => {
    const store = usePlanStore();
    sendPlanCommand.mockResolvedValue({ success: false, code: "x", error: "boom" });
    await store.approve("plan-1", 1);
    expect(store.lastError).toBe("boom");
    store.clearError();
    expect(store.lastError).toBeNull();
  });
});
