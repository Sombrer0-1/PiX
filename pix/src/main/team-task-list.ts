import type { TeamTask, TeamTaskFileConflict, TeamTaskStatus, TeammateRole } from "../shared/types.js";
import { ROLE_TASK_CAPABILITIES } from "./team-constants.js";

/**
 * In-memory shared task list for team collaboration.
 *
 * Tasks are created by the leader (or by workers via structured output),
 * claimed by idle workers, and progress through a lifecycle:
 *   pending -> in_progress -> completed/failed/cancelled
 *   pending -> blocked (waiting on dependencies)
 *
 * Auto-claiming: idle workers call tryClaimNextTask() to pick up assigned
 * work first, then the highest-priority unblocked pending task compatible
 * with their role. Claiming is atomic: only one worker can claim a given task.
 */
const TEAM_TASK_STATUS_TRANSITIONS: Record<TeamTaskStatus, readonly TeamTaskStatus[]> = {
  pending: ["assigned", "in_progress", "blocked", "failed", "cancelled"],
  assigned: ["pending", "in_progress", "blocked", "failed", "cancelled"],
  in_progress: ["pending", "blocked", "completed", "failed", "cancelled"],
  blocked: ["pending", "assigned", "failed", "cancelled"],
  failed: ["pending", "assigned", "cancelled"],
  completed: ["cancelled"],
  cancelled: [],
};

export function canTransitionTeamTaskStatus(from: TeamTaskStatus, to: TeamTaskStatus): boolean {
  if (from === to) return true;
  return TEAM_TASK_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}


export class TeamTaskList {
  private _tasks = new Map<string, TeamTask>();

  /** Create a new task and return it. */
  create(task: Omit<TeamTask, "createdAt" | "updatedAt">): TeamTask {
    const now = Date.now();
    const full: TeamTask = {
      ...task,
      createdAt: now,
      updatedAt: now,
    };
    this._tasks.set(full.id, full);
    return { ...full };
  }

  /** Get a task by ID. */
  get(taskId: string): TeamTask | undefined {
    const t = this._tasks.get(taskId);
    return t ? { ...t } : undefined;
  }

  /**
   * Resolve a task ID or unique ID prefix to a full task ID.
   *
   * Leader-facing prompts and tool results abbreviate task IDs to 8 characters,
   * so the Leader LLM routinely passes prefixes back into tools. An exact match
   * always wins; otherwise a prefix (minimum 4 chars, to avoid accidents) must
   * match exactly one task. Returns null when unknown or ambiguous.
   */
  resolveTaskId(idOrPrefix: string): string | null {
    const token = idOrPrefix.trim();
    if (!token) return null;
    if (this._tasks.has(token)) return token;
    if (token.length < 4) return null;

    let match: string | null = null;
    for (const id of this._tasks.keys()) {
      if (!id.startsWith(token)) continue;
      if (match) return null; // ambiguous
      match = id;
    }
    return match;
  }

  /** Get all tasks, optionally filtered by status. */
  getAll(status?: TeamTaskStatus): TeamTask[] {
    const all = Array.from(this._tasks.values());
    if (status) return all.filter((t) => t.status === status).map((t) => ({ ...t }));
    return all.map((t) => ({ ...t }));
  }

  /** Return tasks whose dependencies are complete and can be started now. */
  getReadyTasks(role?: TeammateRole): TeamTask[] {
    const completedIds = this._completedTaskIds();
    const capabilities = role ? ROLE_TASK_CAPABILITIES[role] : null;
    return Array.from(this._tasks.values())
      .filter((task) => {
        if (task.status !== "pending" && task.status !== "assigned") return false;
        if (!task.blockedBy.every((depId) => completedIds.has(depId))) return false;
        if (capabilities) {
          if (task.taskType) {
            if (!capabilities.includes(task.taskType)) return false;
          } else if (role !== "coder") {
            // Untyped work is only auto-picked by the coder (see tryClaimNextTask).
            return false;
          }
        }
        return true;
      })
      .map((task) => ({ ...task }));
  }

  /** Return pending/assigned tasks that are waiting on unfinished dependencies. */
  getBlockedByDependencies(): TeamTask[] {
    const completedIds = this._completedTaskIds();
    return Array.from(this._tasks.values())
      .filter((task) => {
        if (task.status !== "pending" && task.status !== "assigned") return false;
        return task.blockedBy.some((depId) => !completedIds.has(depId));
      })
      .map((task) => ({ ...task }));
  }

  /** Return incomplete dependency IDs for a task. */
  getOpenDependencies(taskId: string): string[] {
    const task = this._tasks.get(taskId);
    if (!task) return [];
    const completedIds = this._completedTaskIds();
    return task.blockedBy.filter((depId) => !completedIds.has(depId));
  }

  /**
   * Try to claim the next available task for the given agent.
   * A task is claimable if:
   *   - status === "assigned" and ownerAgentId matches agentId, or
   *   - status === "pending", no owner, and the role can handle taskType
   *   - all blockedBy tasks are completed
   *
   * Returns the claimed task (with status updated to in_progress), or null.
   *
   * Claiming is synchronous. Node runs this method without interleaving until
   * it returns; the lock only protects accidental re-entrant calls inside the
   * same call stack. It is not a cross-method async mutex.
   */
  private _claimLock = false;

  tryClaimNextTask(agentId: string, role?: TeammateRole): TeamTask | null {
    if (this._claimLock) return null;
    this._claimLock = true;
    try {
      // Invariant: a worker may own at most one in_progress task at a time.
      // Without this, a worker could end up holding two active tasks and
      // mark_task_complete would record its result against the wrong one.
      for (const t of this._tasks.values()) {
        if (t.status === "in_progress" && t.ownerAgentId === agentId) return null;
      }

      // Single pass: collect completed IDs and find the best claimable candidate.
      const completedIds = new Set<string>();
      let best: TeamTask | null = null;

      for (const t of this._tasks.values()) {
        if (t.status === "completed") {
          completedIds.add(t.id);
        }
      }

      const capabilities = role ? ROLE_TASK_CAPABILITIES[role] : null;
      const canHandleTaskType = (t: TeamTask): boolean => {
        if (t.taskType) return !capabilities || capabilities.includes(t.taskType);
        // Untyped tasks are only auto-claimed by the coder (or when no role is
        // given), since the coder is the only role with full write/build tools
        // and cannot be stranded on implementation work. Other roles must be
        // assigned untyped work explicitly by the leader via assignTask.
        return !role || role === "coder";
      };

      // Find the best candidate: explicit assignment wins, then compatible
      // unassigned pending work. This preserves leader intent while keeping
      // the documented auto-claim workflow alive.
      for (const t of this._tasks.values()) {
        if (t.status !== "assigned" && t.status !== "pending") continue;
        if (t.status === "assigned" && t.ownerAgentId !== agentId) continue;
        if (t.status === "pending" && t.ownerAgentId && t.ownerAgentId !== agentId) continue;
        if (t.status === "pending" && !canHandleTaskType(t)) continue;
        if (!t.blockedBy.every((depId) => completedIds.has(depId))) continue;

        const bestIsAssignedToMe = best?.status === "assigned" && best.ownerAgentId === agentId;
        const tIsAssignedToMe = t.status === "assigned" && t.ownerAgentId === agentId;
        if (
          !best ||
          (tIsAssignedToMe && !bestIsAssignedToMe) ||
          (tIsAssignedToMe === bestIsAssignedToMe && (
            t.blocks.length > best.blocks.length ||
            (t.blocks.length === best.blocks.length && t.createdAt < best.createdAt)
          ))
        ) {
          best = t;
        }
      }

      if (!best) return null;

      best.status = "in_progress";
      best.ownerAgentId = agentId;
      best.updatedAt = Date.now();
      return { ...best };
    } finally {
      this._claimLock = false;
    }
  }

  /**
   * Claim a specific task by ID for the given agent.
   * Returns the claimed task if it was assigned to the agent, or pending and
   * unowned, and all deps are resolved; otherwise null.
   */
  claimTask(taskId: string, agentId: string): TeamTask | null {
    const task = this._tasks.get(taskId);
    if (!task) return null;
    if (task.status !== "assigned" && task.status !== "pending") return null;
    if (task.status === "assigned" && task.ownerAgentId !== agentId) return null;
    if (task.status === "pending" && task.ownerAgentId && task.ownerAgentId !== agentId) return null;

    // Invariant: a worker may own at most one in_progress task at a time.
    for (const t of this._tasks.values()) {
      if (t.id !== taskId && t.status === "in_progress" && t.ownerAgentId === agentId) return null;
    }

    const completedIds = new Set(
      Array.from(this._tasks.values())
        .filter((t) => t.status === "completed")
        .map((t) => t.id),
    );
    if (!task.blockedBy.every((depId) => completedIds.has(depId))) return null;

    task.status = "in_progress";
    task.ownerAgentId = agentId;
    task.updatedAt = Date.now();
    return { ...task };
  }

  /** Update a task's fields. Returns the updated task, or undefined if not found. */
  update(taskId: string, changes: Partial<Pick<TeamTask, "status" | "result" | "evidence" | "contextPack" | "handoff" | "gateState" | "fileConflicts" | "ownerAgentId" | "subject" | "description" | "blocks">>): TeamTask | undefined {
    const task = this._tasks.get(taskId);
    if (!task) return undefined;
    if (changes.status !== undefined && !canTransitionTeamTaskStatus(task.status, changes.status)) {
      throw new Error(`Invalid task status transition: ${task.status} -> ${changes.status}.`);
    }
    if (changes.status !== undefined) task.status = changes.status;
    if (changes.result !== undefined) task.result = changes.result;
    if (changes.evidence !== undefined) task.evidence = changes.evidence;
    if (changes.contextPack !== undefined) task.contextPack = changes.contextPack;
    if (changes.handoff !== undefined) task.handoff = changes.handoff;
    if (changes.gateState !== undefined) task.gateState = changes.gateState;
    if (changes.fileConflicts !== undefined) task.fileConflicts = changes.fileConflicts;
    if ("ownerAgentId" in changes) task.ownerAgentId = changes.ownerAgentId;
    if (changes.subject !== undefined) task.subject = changes.subject;
    if (changes.description !== undefined) task.description = changes.description;
    if (changes.blocks !== undefined) task.blocks = changes.blocks;
    task.updatedAt = Date.now();
    return { ...task };
  }

  /** Release assigned or in-progress tasks owned by an unavailable worker. */
  releaseOwnedOpenTasks(agentId: string, result?: string): TeamTask[] {
    const released: TeamTask[] = [];
    for (const task of this._tasks.values()) {
      if (task.ownerAgentId !== agentId) continue;
      if (task.status !== "assigned" && task.status !== "in_progress") continue;
      if (!canTransitionTeamTaskStatus(task.status, "pending")) continue;

      task.status = "pending";
      task.ownerAgentId = undefined;
      // Preserve any result the worker already wrote; only fall back to the
      // release note when the task has no result yet. Overwriting would discard
      // genuine progress (and desync result from the untouched evidence ledger).
      if (result !== undefined && !task.result) task.result = result;
      task.updatedAt = Date.now();
      released.push({ ...task });
    }
    return released;
  }

  /** Delete a task by ID. Returns true if it existed. */
  delete(taskId: string): boolean {
    // Also remove from any blocks/blockedBy lists
    this._tasks.delete(taskId);
    for (const t of this._tasks.values()) {
      t.blockedBy = t.blockedBy.filter((id) => id !== taskId);
      t.blocks = t.blocks.filter((id) => id !== taskId);
    }
    return true;
  }

  /** Clear all tasks. */
  clearAll(): void {
    this._tasks.clear();
  }

  /** Replace all tasks from a persisted snapshot. */
  replaceAll(tasks: TeamTask[]): void {
    this._tasks.clear();
    for (const task of tasks) {
      this._tasks.set(task.id, { ...task });
    }
  }

  /** Update derived file-conflict metadata without rebuilding the task map. */
  setFileConflicts(conflictsByTaskId: Map<string, TeamTaskFileConflict[]>): boolean {
    let changed = false;
    for (const task of this._tasks.values()) {
      const next = conflictsByTaskId.get(task.id) ?? [];
      const current = task.fileConflicts ?? [];
      if (!sameFileConflicts(current, next)) {
        task.fileConflicts = next.length ? next.map((conflict) => ({ ...conflict, files: [...conflict.files] })) : undefined;
        changed = true;
      }
    }
    return changed;
  }

  /** Total task count. */
  size(): number {
    return this._tasks.size;
  }

  private _completedTaskIds(): Set<string> {
    return new Set(
      Array.from(this._tasks.values())
        .filter((task) => task.status === "completed")
        .map((task) => task.id),
    );
  }
}

function sameFileConflicts(a: TeamTaskFileConflict[], b: TeamTaskFileConflict[]): boolean {
  if (a.length !== b.length) return false;
  const normalize = (items: TeamTaskFileConflict[]) =>
    items.map((item) => ({
      ...item,
      files: [...item.files].sort(),
    })).sort((left, right) => left.withTaskId.localeCompare(right.withTaskId));
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
