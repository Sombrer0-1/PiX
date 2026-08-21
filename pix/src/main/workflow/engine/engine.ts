/**
 * The workflow seam: the engine abstraction, the error vocabulary and the
 * isolated observer bus. Host-only (main process): the engine never imports
 * Vue / ipc / Pinia, and tools import only this file plus runtime-types —
 * never host.ts / worker.ts / protocol.ts.
 */

import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowErrorCode,
  WorkflowEventName,
  WorkflowResultInfo,
  WorkflowRunInfo,
} from "../../../shared/workflow-types.js";
import { renderThrown } from "./realm.js";
import type { WorkflowEngineConfig, WorkflowRun, WorkflowStartRequest } from "./runtime-types.js";

/**
 * The observe-only event surface a run publishes. Every payload is a
 * snapshot (id + meta, never a live run): listeners observe, they do not
 * steer. `workflow/end` carries the result minus `value`.
 */
export type WorkflowEventListener = {
  "workflow/start": (info: WorkflowRunInfo) => void;
  "workflow/phase": (info: WorkflowRunInfo, title: string) => void;
  "workflow/log": (info: WorkflowRunInfo, message: string) => void;
  "workflow/agent-start": (info: WorkflowRunInfo, agent: WorkflowAgentInfo) => void;
  "workflow/agent-end": (info: WorkflowRunInfo, agent: WorkflowAgentEndInfo) => void;
  "workflow/end": (info: WorkflowRunInfo, result: WorkflowResultInfo) => void;
};

/**
 * The one error type the workflow feature throws. `fatal` drives the script
 * combinators: a fatal error kills the run, a non-fatal one is absorbed by
 * `parallel()` / `pipeline()` as a `null` item. Defaults to fatal (every
 * current code is fatal; the flag exists so host callers can opt items into
 * null-absorption).
 */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly fatal: boolean;

  constructor(message: string, code: WorkflowErrorCode, options?: ErrorOptions & { fatal?: boolean }) {
    super(message, options);
    this.name = "WorkflowError";
    this.code = code;
    this.fatal = options?.fatal ?? true;
  }
}

/**
 * Whether a thrown value is a host-realm fatal WorkflowError. Must use the
 * host `instanceof` — a script realm cannot forge a WorkflowError the host
 * will recognize.
 */
export function isFatalWorkflowError(error: unknown): boolean {
  return error instanceof WorkflowError && error.fatal;
}

/**
 * The engine seam. One instance owns many live runs; `start()` publishes a
 * holder-owned run whose events are observe-only snapshots. `disposeAll()`
 * cancels and bounded-disposes every unsettled run; only when the engine
 * instance is replaced/unloaded (a session close) are runs not returned yet
 * revoked — a returned run stays valid regardless.
 */
export abstract class WorkflowEngine {
  private readonly listenerSets = new Map<WorkflowEventName, Set<WorkflowEventListener[WorkflowEventName]>>();

  constructor(_config?: WorkflowEngineConfig) {
    // Config resolution (defaults, clamps) is the concrete engine's job.
  }

  abstract start(request: WorkflowStartRequest): WorkflowRun;

  /** Cancel + bounded-dispose all unsettled runs; idempotent. */
  abstract disposeAll(): Promise<void>;

  on<K extends WorkflowEventName>(name: K, listener: WorkflowEventListener[K]): () => void {
    let set = this.listenerSets.get(name);
    if (set === undefined) {
      set = new Set<WorkflowEventListener[WorkflowEventName]>();
      this.listenerSets.set(name, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /**
   * Per-listener isolation: one throwing observer never breaks the bus, and
   * a returned thenable's rejection is only console.warn'ed.
   */
  protected emit<K extends WorkflowEventName>(name: K, ...args: Parameters<WorkflowEventListener[K]>): void {
    const set = this.listenerSets.get(name);
    if (set === undefined) return;
    for (const listener of [...set]) {
      try {
        const result = (listener as (...payload: unknown[]) => unknown)(...args);
        if (
          result !== null &&
          typeof result === "object" &&
          typeof (result as { then?: unknown }).then === "function"
        ) {
          void Promise.resolve(result).catch((error: unknown) => {
            console.warn(`workflow: listener for ${name} rejected: ${renderThrown(error)}`);
          });
        }
      } catch (error) {
        console.warn(`workflow: listener for ${name} threw: ${renderThrown(error)}`);
      }
    }
  }
}
