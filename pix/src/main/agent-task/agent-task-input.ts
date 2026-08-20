/**
 * Per-task FIFO input routing + taskId/requestId/generation triple validation
 * (design plan §3, §4.5).
 *
 * Owned by AgentTaskService; the AgentTaskRuntime's requestUserInput closure
 * points at this router. The router keeps every pending request in one list
 * ordered by enqueue time - that makes the per-task FIFO a subsequence of the
 * global order, so "per-task FIFO" and "global needs-attention ordering by
 * request time" are the same structure.
 *
 * respond()/cancel() only accept the head of the matching task's FIFO and
 * require taskId + requestId + generation to match (a response additionally
 * must carry response.id === requestId). Any mismatch returns false, never an
 * error.
 *
 * Settle semantics: an entry is settled exactly once by one of
 *   - respond()  -> "answered"
 *   - cancel()   -> "cancelled"
 *   - the request's own AbortSignal firing -> "aborted" (the runtime resolves
 *     its own pending promise on the same signal; the router only clears the
 *     bookkeeping and notifies the service)
 *   - settleOnShutdown() -> "shutdown"
 * The service is notified through the constructor callbacks; it turns them
 * into task_input / task_input_dismissed service events.
 */

import type { AgentTaskInputRequest } from "../../shared/agent-task-types.js";
import type { RequestUserInputRequest, RequestUserInputResponse } from "../../shared/types.js";

export type AgentTaskInputSettleReason = "answered" | "cancelled" | "aborted" | "shutdown";

export interface AgentTaskInputSettle {
  taskId: string;
  requestId: string;
  generation: number;
  reason: AgentTaskInputSettleReason;
}

export interface AgentTaskInputRouterHandlers {
  onRequest: (request: AgentTaskInputRequest) => void;
  onSettled: (settle: AgentTaskInputSettle) => void;
}

interface PendingEntry {
  taskId: string;
  requestId: string;
  generation: number;
  request: RequestUserInputRequest;
  settled: boolean;
  removeAbortListener?: () => void;
}

export class AgentTaskInputRouter {
  private readonly _handlers: AgentTaskInputRouterHandlers;
  private readonly _pending: PendingEntry[] = [];
  private _shutdown = false;

  constructor(handlers: AgentTaskInputRouterHandlers) {
    this._handlers = handlers;
  }

  /**
   * Route one request_user_input request into the per-task FIFO and notify the
   * service. The AbortSignal settles the entry as "aborted" when it fires
   * before an answer.
   */
  enqueue(taskId: string, generation: number, request: RequestUserInputRequest, signal: AbortSignal): void {
    const entry: PendingEntry = {
      taskId,
      requestId: request.id,
      generation,
      request,
      settled: false,
    };
    this._pending.push(entry);
    this._handlers.onRequest({ taskId, requestId: request.id, generation, request });
    if (this._shutdown || signal.aborted) {
      this._settle(entry, "aborted");
      return;
    }
    const onAbort = (): void => {
      this._settle(entry, "aborted");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    entry.removeAbortListener = () => {
      signal.removeEventListener("abort", onAbort);
    };
  }

  /**
   * Deliver the user's answer to the head request of the task's FIFO. Returns
   * false when the taskId/requestId/generation triple does not match the head,
   * when the response id differs from the request id, or when the entry was
   * already settled.
   */
  respond(taskId: string, requestId: string, generation: number, response: RequestUserInputResponse): boolean {
    const entry = this._head(taskId, generation);
    if (!entry || entry.requestId !== requestId || response.id !== requestId) {
      return false;
    }
    this._settle(entry, "answered");
    return true;
  }

  /**
   * Cancel the head request of the task's FIFO; the nested tool observes a
   * cancelled response. Same triple validation as respond().
   */
  cancel(taskId: string, requestId: string, generation: number): boolean {
    const entry = this._head(taskId, generation);
    if (!entry || entry.requestId !== requestId) {
      return false;
    }
    this._settle(entry, "cancelled");
    return true;
  }

  /**
   * Settle every still-pending request as "shutdown" (app shutdown path). New
   * enqueues after this point are settled as "aborted" immediately.
   */
  settleOnShutdown(): void {
    this._shutdown = true;
    for (const entry of [...this._pending]) {
      this._settle(entry, "shutdown");
    }
  }

  /** All pending requests in global enqueue order (renderer mirror). */
  getPending(): AgentTaskInputRequest[] {
    return this._pending.map((entry) => ({
      taskId: entry.taskId,
      requestId: entry.requestId,
      generation: entry.generation,
      request: entry.request,
    }));
  }

  /** Head of the task's FIFO (oldest pending request for the task), if any. */
  private _head(taskId: string, generation: number): PendingEntry | undefined {
    return this._pending.find((entry) => entry.taskId === taskId && entry.generation === generation);
  }

  private _settle(entry: PendingEntry, reason: AgentTaskInputSettleReason): void {
    if (entry.settled) {
      return;
    }
    entry.settled = true;
    entry.removeAbortListener?.();
    const index = this._pending.indexOf(entry);
    if (index !== -1) {
      this._pending.splice(index, 1);
    }
    this._handlers.onSettled({
      taskId: entry.taskId,
      requestId: entry.requestId,
      generation: entry.generation,
      reason,
    });
  }
}
