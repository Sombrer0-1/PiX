/**
 * Workflow recorder (S5): projects the engine's observe-only events into
 * pix-workflow-v1 CustomEntry records and folds the in-memory record stream
 * into WorkflowViewState snapshots.
 *
 * The recorder holds no webContents and never cancels/disposes a run; IPC
 * upsert is done by subscribeWorkflowEventForwarding subscribing to the
 * recorder's fold changes (mirroring subscribePlanEventForwarding). The
 * append sink is supplied by SessionBridge as
 * `() => sessionManager.appendCustomEntry(WORKFLOW_RECORD_CUSTOM_TYPE, data)`;
 * without a sessionManager it is a no-op and the recorder never writes.
 *
 * Design principle 8: a failed append must not change execution. Any append
 * failure disables all further writes (the durable stream stays a legal
 * interrupted prefix); cancel/result/dispose are untouched. The lifecycle
 * callback (V143 product events) is the SessionBridge's binding point — the
 * engine and the tools never import the collector.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  WORKFLOW_MAX_DURABLE_LOGS,
  WORKFLOW_RECORD_CUSTOM_TYPE,
  WORKFLOW_RECORD_SCHEMA_VERSION,
  foldWorkflowRecords,
} from "../../shared/workflow-types.js";
import type {
  PixWorkflowRecord,
  WorkflowMeta,
  WorkflowRunId,
  WorkflowStopReason,
  WorkflowViewState,
} from "../../shared/workflow-types.js";
import type { WorkflowEngine } from "./engine/engine.js";

export interface WorkflowRecorder {
  start(run: { id: WorkflowRunId; meta: WorkflowMeta }, toolCallId: string, toolName: "workflow" | "ralph"): void;
  finish(runId: WorkflowRunId, stopReason: WorkflowStopReason): void;
  abandon(runId: WorkflowRunId): void;
  restore(entries: SessionEntry[]): WorkflowViewState[];
  getSnapshot(): WorkflowViewState[];
  /** Called whenever the fold changes after append/restore; subscribeWorkflowEventForwarding uses it to emit upsert/snapshot. */
  onViewChange(listener: (run: WorkflowViewState) => void): () => void;
}

export type WorkflowLifecycleEvent = "started" | "completed" | "failed" | "cancelled";
export interface WorkflowLifecyclePayload {
  status?: string;
  durationMs?: number;
  counts?: { agentsStarted?: number };
}

/** One live run this recorder currently projects. */
interface ActiveRun {
  runId: WorkflowRunId;
  name: string;
  startedAt: number;
  agentsStarted: number;
  unsubscribes: Array<() => void>;
}

/** Render a recording failure without trusting the thrown value. */
function renderRecordingError(error: unknown): string {
  try {
    return String(error);
  } catch {
    return "[unrenderable thrown value]";
  }
}

export function createWorkflowRecorder(opts: {
  append: (data: PixWorkflowRecord) => void;
  engine: WorkflowEngine;
  /** SessionBridge binding: record V143 at run-start / run-end; engine and tools must NOT import the collector. */
  onLifecycle?: (event: WorkflowLifecycleEvent, payload: WorkflowLifecyclePayload) => void;
}): WorkflowRecorder {
  const active = new Map<WorkflowRunId, ActiveRun>();
  // The in-memory mirror of the durable stream; folded with the same
  // algorithm as the CustomEntry path so live and restored views agree.
  const records: PixWorkflowRecord[] = [];
  const viewListeners = new Set<(run: WorkflowViewState) => void>();
  // Any append failure disables every later write (never re-armed).
  let disabled = false;

  function emitView(run: WorkflowViewState): void {
    for (const listener of [...viewListeners]) {
      try {
        listener(run);
      } catch (error) {
        console.warn(`workflow: view-change listener threw: ${renderRecordingError(error)}`);
      }
    }
  }

  function fireLifecycle(event: WorkflowLifecycleEvent, payload: WorkflowLifecyclePayload): void {
    try {
      opts.onLifecycle?.(event, payload);
    } catch (error) {
      console.warn(`workflow: onLifecycle (${event}) threw: ${renderRecordingError(error)}`);
    }
  }

  /** Persist one record; on failure warn, disable all further writes and report false. */
  function appendOne(record: PixWorkflowRecord): boolean {
    if (disabled) return false;
    try {
      opts.append(record);
    } catch (error) {
      disabled = true;
      console.warn(`workflow: disabled durable record after ${record.kind} append failed: ${renderRecordingError(error)}`);
      return false;
    }
    records.push(record);
    const run = foldWorkflowRecords(records).find((view) => view.runId === record.runId);
    if (run !== undefined) {
      emitView(run);
    }
    return true;
  }

  /** Persisted log-kind records for the run; the durable cap counts only kind "log". */
  function persistedLogCount(runId: WorkflowRunId): number {
    let count = 0;
    for (const record of records) {
      if (record.kind === "log" && record.runId === runId) count++;
    }
    return count;
  }

  /**
   * Subscribe the six observe-only events, filtered to this run. run-start is
   * written by start() right after the engine's emit and is never re-written
   * here; run-end is written only by finish() and never on workflow/end.
   */
  function subscribeRun(runId: WorkflowRunId): Array<() => void> {
    const unsubscribes: Array<() => void> = [];
    unsubscribes.push(
      opts.engine.on("workflow/start", (info) => {
        void info;
      }),
    );
    unsubscribes.push(
      opts.engine.on("workflow/phase", (info, title) => {
        if (info.id !== runId || disabled) return;
        if (typeof title === "string" && title.length > 0) {
          appendOne({ schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION, kind: "phase", runId, title });
        }
      }),
    );
    unsubscribes.push(
      opts.engine.on("workflow/log", (info, message) => {
        if (info.id !== runId || disabled) return;
        if (typeof message !== "string") return;
        if (persistedLogCount(runId) >= WORKFLOW_MAX_DURABLE_LOGS) return;
        appendOne({ schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION, kind: "log", runId, message });
      }),
    );
    unsubscribes.push(
      opts.engine.on("workflow/agent-start", (info, agent) => {
        if (info.id !== runId || disabled) return;
        const record: Extract<PixWorkflowRecord, { kind: "agent-start" }> = {
          schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION,
          kind: "agent-start",
          runId,
          seq: agent.seq,
          label: agent.label,
          ...(agent.phase === undefined ? {} : { phase: agent.phase }),
          childId: agent.childId,
        };
        if (appendOne(record)) {
          const entry = active.get(runId);
          if (entry !== undefined) entry.agentsStarted++;
        }
      }),
    );
    unsubscribes.push(
      opts.engine.on("workflow/agent-end", (info, agent) => {
        // Relies on the host still emitting pairing ends after cancel; the
        // recorder never synthesizes an end.
        if (info.id !== runId || disabled) return;
        appendOne({
          schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION,
          kind: "agent-end",
          runId,
          seq: agent.seq,
          outcome: agent.outcome,
          ...(typeof agent.error === "string" && agent.error.length > 0 ? { error: agent.error } : {}),
        });
      }),
    );
    unsubscribes.push(
      opts.engine.on("workflow/end", (info, result) => {
        // run-end is written only by finish(), after dispose has returned.
        void info;
        void result;
      }),
    );
    return unsubscribes;
  }

  return {
    start(run, toolCallId, toolName) {
      if (disabled) return;
      const runId = run.id;
      const record: PixWorkflowRecord = {
        schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION,
        kind: "run-start",
        runId,
        toolCallId,
        toolName,
        name: run.meta.name,
      };
      // Only on success enter active + subscribe + lifecycle; a failed first
      // append keeps the recorder out of active and it never writes again.
      if (!appendOne(record)) return;
      const entry: ActiveRun = {
        runId,
        name: run.meta.name,
        startedAt: Date.now(),
        agentsStarted: 0,
        unsubscribes: subscribeRun(runId),
      };
      active.set(runId, entry);
      fireLifecycle("started", { status: run.meta.name });
    },

    finish(runId, stopReason) {
      const entry = active.get(runId);
      if (entry === undefined) return;
      // The tool calls this after dispose has returned, so the run's event
      // stream is quiescent; run-end is the terminal durable record.
      if (!disabled) {
        appendOne({ schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION, kind: "run-end", runId, stopReason });
      }
      active.delete(runId);
      for (const unsubscribe of entry.unsubscribes) unsubscribe();
      const lifecycle: WorkflowLifecycleEvent =
        stopReason === "completed" ? "completed" : stopReason === "cancelled" ? "cancelled" : "failed";
      fireLifecycle(lifecycle, {
        status: entry.name,
        durationMs: Date.now() - entry.startedAt,
        counts: { agentsStarted: entry.agentsStarted },
      });
    },

    abandon(runId) {
      // Only leaves the table + unsubscribes; no terminal record, no lifecycle.
      const entry = active.get(runId);
      if (entry === undefined) return;
      active.delete(runId);
      for (const unsubscribe of entry.unsubscribes) unsubscribe();
    },

    restore(entries) {
      // Fold ONLY CustomEntry items whose customType is pix-workflow-v1;
      // other customTypes are ignored. Unknown kinds are skipped by the fold,
      // never fatal for the segment.
      const restored: PixWorkflowRecord[] = [];
      for (const entry of entries) {
        if (entry.type !== "custom" || entry.customType !== WORKFLOW_RECORD_CUSTOM_TYPE) continue;
        if (entry.data === undefined) continue;
        restored.push(entry.data as PixWorkflowRecord);
      }
      // Merge into the in-memory mirror (dedup by serialized record, so a
      // bridge-activation restore followed by the adapter's instance-swap
      // restore is idempotent). Without the merge, getSnapshot() would stay
      // empty and every same-instance resync re-push would wipe the restored
      // runs from the renderer mirror — interrupted runs would never survive
      // a session switch.
      const seen = new Set(records.map((record) => JSON.stringify(record)));
      for (const record of restored) {
        const key = JSON.stringify(record);
        if (seen.has(key)) continue;
        seen.add(key);
        records.push(record);
      }
      const runs = foldWorkflowRecords(records);
      for (const run of runs) {
        emitView(run);
      }
      return runs;
    },

    getSnapshot() {
      return foldWorkflowRecords(records);
    },

    onViewChange(listener) {
      viewListeners.add(listener);
      return () => {
        viewListeners.delete(listener);
      };
    },
  };
}
