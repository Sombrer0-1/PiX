/**
 * Global FIFO scheduler for app-level agent tasks (design plan §3, §4.5).
 *
 * At most AGENT_TASK_MAX_RUNNING_SLOTS (4) tasks occupy a running slot at the
 * same time; `running` and `waiting_input` both hold a slot, `queued` tasks do
 * not. Every runnable task spec is enqueued independently - parallel children
 * each take their own slot, a chain occupies exactly one.
 *
 * Owned by AgentTaskService. The scheduler itself has no notion of task
 * status: the service is the single authority for status transitions. It
 * enqueues tasks, starts them when the onSlotFree listener fires with their
 * taskId (the listener fires synchronously both for immediate grants and for
 * grants that follow a release), and calls release() exactly once per task
 * that actually held a slot and reached a terminal state. Aborting a queued
 * task removes the waiter immediately so it never consumes a future slot.
 *
 * All operations are synchronous, which eliminates the same-tick grant/abort
 * race of an async semaphore: a grant and the listener that starts the task
 * happen inside one call stack, so a dequeue can never observe a half-granted
 * waiter.
 */

import { AGENT_TASK_MAX_RUNNING_SLOTS } from "../../shared/agent-task-types.js";

/** One queued task waiting for a slot. */
interface Waiter {
  taskId: string;
}

export class AgentTaskScheduler {
  private _activeCount = 0;
  private readonly _waiters: Waiter[] = [];
  private readonly _slotFreeListeners = new Set<(taskId: string) => void>();

  /** Number of tasks currently holding a slot (running + waiting_input). */
  get activeCount(): number {
    return this._activeCount;
  }

  /**
   * Subscribe to slot grants. The callback is invoked synchronously with the
   * granted taskId, both when enqueue() grants an immediately-free slot and
   * when release() hands the next queued waiter its slot. Returns an
   * unsubscribe function.
   */
  onSlotFree(cb: (taskId: string) => void): () => void {
    this._slotFreeListeners.add(cb);
    return () => {
      this._slotFreeListeners.delete(cb);
    };
  }

  /**
   * Enqueue one task. Returns true when a slot was immediately available (the
   * task holds a slot from this call on); false when the task is queued and
   * waits for a future release(). In both cases the onSlotFree listeners fire
   * for this taskId.
   */
  enqueue(taskId: string): boolean {
    if (this._activeCount < AGENT_TASK_MAX_RUNNING_SLOTS) {
      this._activeCount++;
      this._grant(taskId);
      return true;
    }
    this._waiters.push({ taskId });
    return false;
  }

  /**
   * Remove a queued task (queued abort). The task never occupies a slot.
   * No-op when the task is not currently waiting (already granted/running or
   * unknown); the synchronous grant/start flow makes a half-granted waiter
   * unobservable.
   */
  dequeue(taskId: string): void {
    const index = this._waiters.findIndex((waiter) => waiter.taskId === taskId);
    if (index === -1) {
      return;
    }
    this._waiters.splice(index, 1);
  }

  /**
   * Free one running slot and grant it to the next queued task, if any. Must
   * be called exactly once per task that held a slot and reached a terminal
   * state. The granted waiter takes over the freed slot, so activeCount stays
   * constant across a release-with-waiter.
   */
  release(): void {
    this._activeCount = Math.max(0, this._activeCount - 1);
    const next = this._waiters.shift();
    if (next) {
      this._activeCount++;
      this._grant(next.taskId);
    }
  }

  /**
   * 1-based position of a queued task in the waiting line (1 = next to run);
   * undefined when the task is not queued.
   */
  getQueuePosition(taskId: string): number | undefined {
    const index = this._waiters.findIndex((waiter) => waiter.taskId === taskId);
    return index === -1 ? undefined : index + 1;
  }

  private _grant(taskId: string): void {
    for (const cb of this._slotFreeListeners) {
      try {
        cb(taskId);
      } catch {
        // A listener must never break the scheduler's slot bookkeeping.
      }
    }
  }
}
