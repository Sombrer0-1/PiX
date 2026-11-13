/**
 * Terminal-task retention policy (design plan §6.3, 1.5 P1).
 *
 * Pure selection over plain-data candidates: the service feeds every terminal
 * task of one workspace, this module decides which records the automatic
 * retention may delete. Deletion itself (disk + index + mirror + task_removed)
 * stays in AgentTaskService so it stays serialized with the persistence flush
 * queue.
 *
 * Keep set = the newest RETENTION_KEEP_COUNT terminal tasks UNION everything
 * younger than RETENTION_KEEP_AGE_MS. Emergency mode (storage level "full")
 * drops the age window and keeps only the newest
 * RETENTION_EMERGENCY_KEEP_COUNT. Exemptions always win:
 * - pending Plan links (the Plan two-phase consumption still needs the result);
 * - workflow-owned groups (the workflow engine owns their lifecycle);
 * - terminal results never delivered to their non-empty parent session, within
 *   RETENTION_UNDELIVERED_GRACE_MS of endedAt - the delivery catch-up may not
 *   have run yet (sink registered after the task finished). The grace clock is
 *   the durable endedAt, never an in-flight delivery promise.
 */

export const RETENTION_KEEP_COUNT = 100;
export const RETENTION_KEEP_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const RETENTION_UNDELIVERED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const RETENTION_EMERGENCY_KEEP_COUNT = 20;

export interface RetentionCandidate {
  taskId: string;
  status: "completed" | "failed" | "cancelled";
  endedAt: number;
  planLinkState: "none" | "pending" | "consumed" | "released";
  parentSessionId: string;
  deliveredCount: number;
  workflowOwned: boolean;
}

export interface RetentionSelectionOptions {
  now: number;
  /** Storage level "full" keeps only the newest emergency window. */
  emergency: boolean;
  /** Test-injectable window overrides; defaults are the exported constants. */
  keepCount?: number;
  keepAgeMs?: number;
  emergencyKeepCount?: number;
  undeliveredGraceMs?: number;
}

/** True when the candidate must never be auto-deleted. */
export function isRetentionExempt(candidate: RetentionCandidate, now: number, graceMs: number = RETENTION_UNDELIVERED_GRACE_MS): boolean {
  if (candidate.planLinkState === "pending") return true;
  if (candidate.workflowOwned) return true;
  if (candidate.parentSessionId !== "" && candidate.deliveredCount === 0) {
    return now - candidate.endedAt < graceMs;
  }
  return false;
}

/**
 * TaskIds the retention pass may delete, oldest first (stable: equal endedAt
 * falls back to taskId ordering so runs are deterministic).
 */
export function selectRetentionRemovals(candidates: RetentionCandidate[], options: RetentionSelectionOptions): string[] {
  const keepCount = options.emergency
    ? options.emergencyKeepCount ?? RETENTION_EMERGENCY_KEEP_COUNT
    : options.keepCount ?? RETENTION_KEEP_COUNT;
  const keepAgeMs = options.keepAgeMs ?? RETENTION_KEEP_AGE_MS;
  const graceMs = options.undeliveredGraceMs ?? RETENTION_UNDELIVERED_GRACE_MS;
  const eligible = candidates.filter((candidate) => !isRetentionExempt(candidate, options.now, graceMs));
  const byRecency = eligible.slice().sort((a, b) => (a.endedAt === b.endedAt ? (a.taskId < b.taskId ? -1 : 1) : a.endedAt - b.endedAt));
  const kept = new Set<string>();
  for (const candidate of byRecency.slice(Math.max(0, byRecency.length - keepCount))) {
    kept.add(candidate.taskId);
  }
  if (!options.emergency) {
    const ageFloor = options.now - keepAgeMs;
    for (const candidate of byRecency) {
      if (candidate.endedAt >= ageFloor) {
        kept.add(candidate.taskId);
      }
    }
  }
  return byRecency.filter((candidate) => !kept.has(candidate.taskId)).map((candidate) => candidate.taskId);
}
