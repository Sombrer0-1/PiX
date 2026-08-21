/**
 * Workflow Store (PiX 1.4.3)
 *
 * Pinia mirror of the parent session's folded workflow run state owned by the
 * main-process recorder. The renderer never invents run state: every change
 * arrives as a snapshot / upsert workflow event or as the get_snapshot
 * session-activation catch-up, and the store talks to main only through the
 * useWorkflowRpc transport.
 *
 * Indexing: a run is addressable by runId (the upsert key) and by toolCallId
 * (the panel lookup key - the panel renders per tool call, so it resolves the
 * run of a toolCallId through byToolCallId). Session-switch semantics: a
 * snapshot REPLACES the mirror wholesale - the previous session's runs are
 * dropped before the new generation's folded state fills in, so stale runs
 * never survive a switch.
 */

import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useWorkflowRpc } from "../composables/useWorkflowRpc";
import type {
  WorkflowEvent,
  WorkflowViewState,
} from "@shared/types.js";

export const useWorkflowStore = defineStore("workflow", () => {
  const workflowRpc = useWorkflowRpc();

  // ==========================================================================
  // State
  // ==========================================================================

  /** Folded workflow run views, in first-appearance order (snapshot/upsert). */
  const runs = ref<WorkflowViewState[]>([]);

  /** Last error message from a workflow command. */
  const lastError = ref<string | null>(null);

  // ==========================================================================
  // Computed
  // ==========================================================================

  /** Runs indexed by runId (the upsert key). */
  const byRunId = computed(() => new Map(runs.value.map((run) => [run.runId, run])));

  /** Runs indexed by toolCallId (the panel lookup key). */
  const byToolCallId = computed(() => new Map(runs.value.map((run) => [run.toolCallId, run])));

  // ==========================================================================
  // Snapshot / event handling
  // ==========================================================================

  /**
   * Replace the mirror with an authoritative folded snapshot. A session switch
   * rebuilds the generation and resyncs via a snapshot event, so the previous
   * session's runs are cleared here (one assignment = clear-then-fill) before
   * the new snapshot fills the store.
   */
  function applySnapshot(snapshotRuns: WorkflowViewState[]): void {
    runs.value = snapshotRuns.map((run) => ({ ...run }));
  }

  /** Upsert one run; a run is identified by runId (in-place update, no dupes). */
  function applyUpsert(run: WorkflowViewState): void {
    const idx = runs.value.findIndex((existing) => existing.runId === run.runId);
    if (idx < 0) {
      runs.value = [...runs.value, run];
    } else {
      const next = runs.value.slice();
      next[idx] = run;
      runs.value = next;
    }
  }

  function handleWorkflowEvent(event: WorkflowEvent): void {
    switch (event.type) {
      case "snapshot":
        applySnapshot(event.runs);
        break;
      case "upsert":
        applyUpsert(event.run);
        break;
    }
  }

  // ==========================================================================
  // Subscription
  // ==========================================================================

  let unsubscribeWorkflowEvents: (() => void) | null = null;

  /**
   * Subscribe to workflow events from main and sync the current snapshot. Must
   * be called once on app init / panel mount. A re-subscribe (window reopen,
   * component remount) replaces the previous subscription instead of stacking a
   * second listener that would process every event twice.
   */
  function subscribeToEvents(): () => void {
    if (unsubscribeWorkflowEvents) {
      unsubscribeWorkflowEvents();
    }
    const off = workflowRpc.onWorkflowEvent((event) => {
      handleWorkflowEvent(event);
    });
    unsubscribeWorkflowEvents = () => {
      off();
      unsubscribeWorkflowEvents = null;
    };
    // Remount catch-up: query the authoritative folded snapshot AFTER the
    // subscription is live, so a push arriving before the response is never
    // overwritten by an older snapshot result. The main side serializes
    // get_snapshot against its own state, so the response is never older than
    // any already-delivered push.
    void refreshSnapshot();
    return unsubscribeWorkflowEvents;
  }

  /** Query the authoritative folded snapshot (session activation catch-up). */
  async function refreshSnapshot(): Promise<WorkflowViewState[] | null> {
    try {
      const result = await workflowRpc.sendWorkflowCommand({ type: "get_snapshot" });
      if (result.success && result.data) {
        applySnapshot(result.data);
        return result.data;
      }
      return null;
    } catch (err) {
      console.error("[workflow-store] Failed to get workflow snapshot:", err);
      return null;
    }
  }

  // ==========================================================================
  // Expose
  // ==========================================================================

  return {
    // State
    runs,
    lastError,
    // Computed
    byRunId,
    byToolCallId,
    // Subscription
    subscribeToEvents,
    refreshSnapshot,
  };
});
