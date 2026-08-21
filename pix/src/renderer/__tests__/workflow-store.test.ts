/**
 * Workflow store tests (PiX 1.4.3, stage S10).
 *
 * Acceptance: after stubbing pixApi, a snapshot fills the store indexed by
 * toolCallId (and runId); session-switch snapshots replace the mirror; upsert
 * events update by runId; get_snapshot is the session-activation catch-up.
 * The store talks to main only through window.pixApi (sendWorkflowCommand /
 * onWorkflowEvent), so the tests stub that surface in happy-dom - no Electron
 * runtime is loaded.
 *
 * Run with: npm exec vitest run src/renderer/__tests__/workflow-store.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { WorkflowRunId } from "@shared/workflow-types.js";
import type { PixApi } from "../../main/preload";
import type {
  PixCommandResult,
  WorkflowEvent,
  WorkflowViewState,
} from "@shared/types.js";
import { useWorkflowStore } from "../stores/workflow-store";

// ============================================================================
// Fixtures
// ============================================================================

function makeViewState(overrides?: Partial<WorkflowViewState>): WorkflowViewState {
  return {
    runId: WorkflowRunId("run-1"),
    toolCallId: "tc-1",
    toolName: "workflow",
    name: "audit-all",
    members: [],
    logs: [],
    status: "running",
    ...overrides,
  };
}

// ============================================================================
// Harness: stub window.pixApi
// ============================================================================

let sendWorkflowCommand: ReturnType<typeof vi.fn>;
let onWorkflowEvent: ReturnType<typeof vi.fn>;
let workflowEventCallback: ((event: WorkflowEvent) => void) | null;
const eventUnsubscribers: Array<() => void> = [];

function installPixApiMock(): void {
  workflowEventCallback = null;
  eventUnsubscribers.length = 0;
  sendWorkflowCommand = vi.fn().mockResolvedValue({ success: true });
  onWorkflowEvent = vi.fn((callback: (event: WorkflowEvent) => void) => {
    workflowEventCallback = callback;
    const unsubscribe = vi.fn();
    eventUnsubscribers.push(unsubscribe);
    return unsubscribe;
  });
  window.pixApi = { sendWorkflowCommand, onWorkflowEvent } as unknown as PixApi;
}

/** Deliver a WorkflowEvent through the currently registered onWorkflowEvent callback. */
function emit(event: WorkflowEvent): void {
  workflowEventCallback?.(event);
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
    const store = useWorkflowStore();
    const run = makeViewState({ status: "completed", stopReason: "completed" });
    sendWorkflowCommand.mockResolvedValue({ success: true, data: [run] });

    const unsubscribe = store.subscribeToEvents();

    expect(onWorkflowEvent).toHaveBeenCalledTimes(1);
    expect(sendWorkflowCommand).toHaveBeenCalledWith({ type: "get_snapshot" });
    // Subscription must be installed before the snapshot query so a push
    // arriving early can never be overwritten by a stale snapshot result.
    expect(onWorkflowEvent.mock.invocationCallOrder[0]).toBeLessThan(sendWorkflowCommand.mock.invocationCallOrder[0]);

    await vi.waitFor(() => {
      expect(store.runs).toHaveLength(1);
    });
    expect(store.runs[0].runId).toBe(run.runId);

    unsubscribe();
    expect(eventUnsubscribers[0]).toHaveBeenCalled();
  });

  it("replaces the previous subscription on re-subscribe (remount)", () => {
    const store = useWorkflowStore();
    store.subscribeToEvents();
    store.subscribeToEvents();

    expect(onWorkflowEvent).toHaveBeenCalledTimes(2);
    expect(eventUnsubscribers[0]).toHaveBeenCalled();
    expect(eventUnsubscribers[1]).not.toHaveBeenCalled();

    // Events flow only through the live (second) subscription.
    emit({ type: "upsert", run: makeViewState({ status: "completed", stopReason: "completed" }) });
    expect(store.runs).toHaveLength(1);
  });
});

// ============================================================================
// Session-activation get_snapshot hydration
// ============================================================================

describe("session-activation get_snapshot", () => {
  it("hydrates the store from the snapshot, indexed by toolCallId and runId", async () => {
    const store = useWorkflowStore();
    const runA = makeViewState({ runId: WorkflowRunId("run-a"), toolCallId: "tc-a", name: "audit" });
    const runB = makeViewState({
      runId: WorkflowRunId("run-b"),
      toolCallId: "tc-b",
      toolName: "ralph",
      name: "ralph-1",
      status: "completed",
      stopReason: "completed",
    });
    sendWorkflowCommand.mockResolvedValue({ success: true, data: [runA, runB] });

    await store.refreshSnapshot();

    expect(sendWorkflowCommand).toHaveBeenCalledWith({ type: "get_snapshot" });
    expect(store.runs).toHaveLength(2);
    expect(store.byToolCallId.get("tc-a")).toEqual(runA);
    expect(store.byToolCallId.get("tc-b")).toEqual(runB);
    expect(store.byRunId.get(WorkflowRunId("run-b"))).toEqual(runB);
  });

  it("clears the store when the snapshot is empty (new session without runs)", async () => {
    const store = useWorkflowStore();
    store.subscribeToEvents();
    emit({ type: "upsert", run: makeViewState() });
    expect(store.runs).toHaveLength(1);

    sendWorkflowCommand.mockResolvedValue({ success: true, data: [] });
    const result = await store.refreshSnapshot();

    expect(result).toEqual([]);
    expect(store.runs).toHaveLength(0);
  });

  it("keeps a push received before the snapshot response, then applies the newer snapshot", async () => {
    const store = useWorkflowStore();
    const pending = defer<PixCommandResult<WorkflowViewState[]>>();
    sendWorkflowCommand.mockReturnValue(pending.promise);

    store.subscribeToEvents();

    // A push arrives while get_snapshot is still in flight.
    emit({ type: "upsert", run: makeViewState({ runId: WorkflowRunId("run-a"), toolCallId: "tc-a" }) });
    expect(store.byToolCallId.get("tc-a")).toBeDefined();

    // The response reflects equal-or-newer controller state and wins.
    const newer = makeViewState({ status: "completed", stopReason: "completed" });
    pending.resolve({ success: true, data: [newer] });
    await vi.waitFor(() => {
      expect(store.runs).toHaveLength(1);
    });
    expect(store.runs[0].runId).toBe(newer.runId);
    expect(store.byToolCallId.get("tc-1")).toEqual(newer);

    // A push arriving after the response wins over it (events carry full views).
    emit({ type: "upsert", run: makeViewState({ runId: WorkflowRunId("run-c"), toolCallId: "tc-c" }) });
    expect(store.byToolCallId.get("tc-c")).toBeDefined();
  });

  it("does not touch the mirror when get_snapshot fails", async () => {
    const store = useWorkflowStore();
    store.subscribeToEvents();

    // Hydrate the mirror first (as a mounted panel would) so the failure path
    // is exercised against real state, not the store's initial empty default.
    emit({ type: "upsert", run: makeViewState() });
    expect(store.runs).toHaveLength(1);

    sendWorkflowCommand.mockResolvedValue({ success: false, code: "workflow_unavailable", error: "No active session." });

    const result = await store.refreshSnapshot();

    expect(result).toBeNull();
    // The hydrated mirror must survive the failed refresh (returns null, no throw).
    expect(store.runs).toHaveLength(1);
  });
});

// ============================================================================
// Snapshot / upsert events
// ============================================================================

describe("snapshot / upsert events", () => {
  it("appends an upsert for an unknown run", () => {
    const store = useWorkflowStore();
    store.subscribeToEvents();

    emit({ type: "upsert", run: makeViewState() });
    emit({ type: "upsert", run: makeViewState({ runId: WorkflowRunId("run-2"), toolCallId: "tc-2" }) });

    expect(store.runs).toHaveLength(2);
    expect(store.byRunId.get(WorkflowRunId("run-2"))?.toolCallId).toBe("tc-2");
  });

  it("updates an upsert by runId without duplicating the run", () => {
    const store = useWorkflowStore();
    store.subscribeToEvents();

    emit({ type: "upsert", run: makeViewState({ members: [{ seq: 1, label: "child", childId: "task-1" }] }) });
    const completed = makeViewState({ status: "completed", stopReason: "completed" });
    emit({ type: "upsert", run: completed });

    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toEqual(completed);
    // Both indexes resolve to the single updated run.
    expect(store.byRunId.get(WorkflowRunId("run-1"))).toEqual(completed);
    expect(store.byToolCallId.get("tc-1")).toEqual(completed);
  });

  it("replaces the mirror wholesale on a snapshot event (session switch clears first)", () => {
    const store = useWorkflowStore();
    store.subscribeToEvents();

    // Previous session's runs.
    emit({ type: "upsert", run: makeViewState({ runId: WorkflowRunId("old-1"), toolCallId: "old-tc-1" }) });
    emit({ type: "upsert", run: makeViewState({ runId: WorkflowRunId("old-2"), toolCallId: "old-tc-2" }) });
    expect(store.runs).toHaveLength(2);

    // Session switch: the new generation's snapshot fills a cleared store.
    const fresh = makeViewState({ runId: WorkflowRunId("new-1"), toolCallId: "new-tc-1", name: "fresh" });
    emit({ type: "snapshot", runs: [fresh] });

    expect(store.runs).toHaveLength(1);
    expect(store.byToolCallId.get("new-tc-1")).toEqual(fresh);
    expect(store.byToolCallId.get("old-tc-1")).toBeUndefined();
    expect(store.byRunId.get(WorkflowRunId("old-1"))).toBeUndefined();
  });

  it("clears the mirror when a snapshot event carries no runs", () => {
    const store = useWorkflowStore();
    store.subscribeToEvents();

    emit({ type: "upsert", run: makeViewState() });
    expect(store.runs).toHaveLength(1);

    emit({ type: "snapshot", runs: [] });

    expect(store.runs).toHaveLength(0);
    expect(store.byRunId.get(WorkflowRunId("run-1"))).toBeUndefined();
    expect(store.byToolCallId.get("tc-1")).toBeUndefined();
  });
});
