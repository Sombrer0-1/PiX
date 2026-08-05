import type { MessageKind, TeamMessage } from "../shared/types.js";

/** Maximum number of messages kept in the append-only timeline history. */
const MAX_BUS_HISTORY = 1000;

/** Priority ordering for message consumption. Lower number = higher priority. */
const MESSAGE_PRIORITY_ORDER: Record<MessageKind, number> = {
  shutdown: 0,
  shutdown_response: 0,
  permission_request: 1,
  permission_response: 1,
  plan_approval: 1,
  leader_message: 2,
  question: 2,
  fix_request: 2,
  review_request: 2,
  objection: 2,
  answer: 3,
  proposal: 3,
  decision: 3,
  handoff: 3,
  peer_message: 4,
  task_message: 4,
  task_result: 4,
  blocked: 4,
  broadcast: 5,
  worker_summary: 6,
};

/** Compare two messages by priority (lower order wins), ties broken by timestamp. */
function comparePriority(a: Pick<TeamMessage, "kind" | "timestamp">, b: Pick<TeamMessage, "kind" | "timestamp">): number {
  const pa = MESSAGE_PRIORITY_ORDER[a.kind];
  const pb = MESSAGE_PRIORITY_ORDER[b.kind];
  if (pa !== pb) return pa - pb;
  return a.timestamp - b.timestamp;
}

/**
 * In-memory message bus for agent team communication.
 *
 * Each agent has a dedicated queue. Broadcasts go to a shared queue
 * with per-agent delivery tracking. Messages are consumed in priority order.
 *
 * This is a pull-based design: workers call consumeNext() in their idle loop.
 * Future upgrade path: replace internals with file-system mailbox (Claude Code style).
 */
export class TeamMessageBus {
  private _queues = new Map<string, TeamMessage[]>();
  private _broadcasts: TeamMessage[] = [];
  private _deliveredBroadcasts = new Map<string, Set<string>>();
  /**
   * Append-only timeline of every message sent through the bus, capped at
   * MAX_BUS_HISTORY. Unlike _queues/_broadcasts (which only retain undelivered
   * messages), this survives consumption so the renderer can rebuild the full
   * team timeline after a restore.
   */
  private _history: TeamMessage[] = [];

  /** Send a message. Routes to a specific agent queue or the broadcast queue. */
  send(message: TeamMessage): void {
    if (message.toAgentId === message.fromAgentId) return;

    this._recordHistory(message);

    if (message.toAgentId === "*") {
      this._broadcasts.push(message);
      this._markBroadcastDelivered(message.fromAgentId, message.id);
    } else {
      let queue = this._queues.get(message.toAgentId);
      if (!queue) {
        queue = [];
        this._queues.set(message.toAgentId, queue);
      }
      queue.push(message);
    }
  }

  /** Record a message in the durable timeline without creating a mailbox item. */
  recordHistoryOnly(message: TeamMessage): void {
    if (message.toAgentId === message.fromAgentId) return;
    this._recordHistory(message);
  }

  /**
   * Read and remove the highest-priority pending message for the given agent.
   * Merges the agent's dedicated queue with undelivered broadcasts,
   * sorts by (priority ASC, timestamp ASC), returns the top message.
   * Returns null if no messages are pending.
   */
  consumeNext(agentId: string): TeamMessage | null {
    const dedicated = this._queues.get(agentId) ?? [];
    const delivered = this._deliveredBroadcasts.get(agentId);

    // Scan for the single highest-priority message without allocating merged/sorted arrays.
    // Priority: lower MESSAGE_PRIORITY_ORDER value wins; ties broken by timestamp.
    let best: TeamMessage | null = null;
    let bestIsDedicated = false;

    // Check dedicated queue
    for (const msg of dedicated) {
      if (!best || comparePriority(msg, best) < 0) {
        best = msg;
        bestIsDedicated = true;
      }
    }

    // Check undelivered broadcasts
    for (const msg of this._broadcasts) {
      if (delivered?.has(msg.id)) continue;
      if (msg.fromAgentId === agentId) {
        this._markBroadcastDelivered(agentId, msg.id);
        continue;
      }
      if (!best || comparePriority(msg, best) < 0) {
        best = msg;
        bestIsDedicated = false;
      }
    }

    if (!best) return null;

    // Remove from the source queue
    if (bestIsDedicated) {
      const idx = dedicated.indexOf(best);
      if (idx >= 0) dedicated.splice(idx, 1);
    } else {
      // Mark broadcast as delivered for this agent
      if (!delivered) {
        this._deliveredBroadcasts.set(agentId, new Set([best.id]));
      } else {
        delivered.add(best.id);
      }
    }

    return best;
  }

  /** Peek at all pending messages for an agent (non-destructive). */
  peek(agentId: string): TeamMessage[] {
    const dedicated = this._queues.get(agentId) ?? [];
    const delivered = this._deliveredBroadcasts.get(agentId);
    const pendingBroadcasts = delivered
      ? this._broadcasts.filter((m) => !delivered.has(m.id) && m.fromAgentId !== agentId)
      : this._broadcasts.filter((m) => m.fromAgentId !== agentId);
    return [...dedicated, ...pendingBroadcasts];
  }

  /** Clear all messages for a specific agent. */
  clearAgent(agentId: string): void {
    this._queues.delete(agentId);
    this._deliveredBroadcasts.delete(agentId);
  }

  /** Clear pending mailbox messages while preserving the append-only history. */
  clearPending(): number {
    const removed = this.size();
    this._queues.clear();
    this._broadcasts.length = 0;
    this._deliveredBroadcasts.clear();
    return removed;
  }

  /** Clear all messages for the entire team. */
  clearAll(): void {
    this._queues.clear();
    this._broadcasts.length = 0;
    this._deliveredBroadcasts.clear();
    this._history.length = 0;
  }

  /** Append-only timeline of all messages sent (for renderer hydration after restore). */
  history(): TeamMessage[] {
    return this._history.map((msg) => ({ ...msg }));
  }

  private _recordHistory(message: TeamMessage): void {
    this._history.push({ ...message });
    if (this._history.length > MAX_BUS_HISTORY) {
      this._history.splice(0, this._history.length - MAX_BUS_HISTORY);
    }
  }

  /** Snapshot pending messages for persistence. */
  snapshot(): {
    queues: Array<[string, TeamMessage[]]>;
    broadcasts: TeamMessage[];
    deliveredBroadcasts: Array<[string, string[]]>;
    history: TeamMessage[];
  } {
    return {
      queues: Array.from(this._queues.entries()).map(([agentId, queue]) => [agentId, queue.map((msg) => ({ ...msg }))]),
      broadcasts: this._broadcasts.map((msg) => ({ ...msg })),
      deliveredBroadcasts: Array.from(this._deliveredBroadcasts.entries()).map(([agentId, delivered]) => [agentId, Array.from(delivered)]),
      history: this.history(),
    };
  }

  /** Restore pending messages from a persisted snapshot. */
  restore(snapshot?: {
    queues?: Array<[string, TeamMessage[]]>;
    broadcasts?: TeamMessage[];
    deliveredBroadcasts?: Array<[string, string[]]>;
    history?: TeamMessage[];
  }): void {
    this.clearAll();
    for (const [agentId, queue] of snapshot?.queues ?? []) {
      this._queues.set(agentId, queue.map((msg) => ({ ...msg })));
    }
    this._broadcasts = (snapshot?.broadcasts ?? []).map((msg) => ({ ...msg }));
    for (const [agentId, delivered] of snapshot?.deliveredBroadcasts ?? []) {
      this._deliveredBroadcasts.set(agentId, new Set(delivered));
    }
    this._history = (snapshot?.history ?? []).map((msg) => ({ ...msg })).slice(-MAX_BUS_HISTORY);
  }

  /** Total pending message count (diagnostic). */
  size(): number {
    let count = this._broadcasts.length;
    for (const queue of this._queues.values()) {
      count += queue.length;
    }
    return count;
  }

  private _markBroadcastDelivered(agentId: string, messageId: string): void {
    let delivered = this._deliveredBroadcasts.get(agentId);
    if (!delivered) {
      delivered = new Set<string>();
      this._deliveredBroadcasts.set(agentId, delivered);
    }
    delivered.add(messageId);
  }

  /**
   * Prune fully-delivered broadcasts from the broadcast array.
   * A broadcast is fully delivered when every active agent has consumed it.
   * Call this periodically (e.g. after each consume, or on a timer) to prevent
   * unbounded growth of the _broadcasts array.
   */
  pruneBroadcasts(activeAgentIds: string[]): number {
    if (activeAgentIds.length === 0) {
      const removed = this._broadcasts.length;
      this._broadcasts.length = 0;
      return removed;
    }
    const before = this._broadcasts.length;
    this._broadcasts = this._broadcasts.filter((m) => {
      // A broadcast is fully delivered if every active agent has it in their delivered set
      return !activeAgentIds.every((agentId) => {
        const delivered = this._deliveredBroadcasts.get(agentId);
        return delivered?.has(m.id) ?? false;
      });
    });
    return before - this._broadcasts.length;
  }
}
