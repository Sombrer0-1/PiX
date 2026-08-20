/**
 * Plan snapshot persistence (PiX-1.4-PLAN.md §6.1).
 *
 * Full `PlanRuntimeSnapshot` <-> SessionManager CustomEntry serialization and
 * rebuild. Every state transition of one PlanController appends one
 * `pix-plan-v1` CustomEntry (never enters the LLM context) with a monotonic
 * per-controller `sequence`. Rebuild scans the current branch entries,
 * validates envelope + snapshot shape and returns the highest CONTIGUOUS
 * sequence (a gap means the later entries belong to a different lineage and
 * are ignored), so planning_failed without a plan, revision base/candidate,
 * the last valid version and explicit fallbacks after failure all survive a
 * session reopen.
 *
 * Context injection uses CustomMessageEntry (customType "pix-plan-context",
 * display:false, enters the LLM context) - see serializePlanContextMessage.
 */

import type {
  Plan,
  PlanRuntimeSnapshot,
  PlanStatus,
} from "../../shared/plan-types.js";
import { PLAN_SCHEMA_VERSION, isPlanRuntimeSnapshot } from "../../shared/plan-types.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const PLAN_CUSTOM_TYPE = "pix-plan-v1";
export const PLAN_CONTEXT_MESSAGE_TYPE = "pix-plan-context";
export const PLAN_RETRY_MESSAGE_TYPE = "pix-plan-retry";

/** Envelope of one persisted plan record (the CustomEntry data payload). */
export interface PlanRecordData {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  /** Monotonic per-controller sequence; rebuild keeps the max contiguous run. */
  sequence: number;
  /** Short label of the transition that produced this record. */
  event: string;
  snapshot: PlanRuntimeSnapshot;
}

export interface RebuiltPlanRecord {
  snapshot: PlanRuntimeSnapshot;
  /** The sequence of the returned snapshot (max contiguous). */
  sequence: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Validate the envelope of one raw CustomEntry data payload. Only the envelope
 * + snapshot shape is checked here; cross-field semantics (envelope
 * consistency, lastValidPlan+revision coupling, failure generationId identity)
 * are PlanController concerns.
 */
function isPlanRecordData(value: unknown): value is PlanRecordData {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== PLAN_SCHEMA_VERSION) return false;
  if (typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence < 1) {
    return false;
  }
  if (typeof value.event !== "string") return false;
  return isPlanRuntimeSnapshot(value.snapshot);
}

/**
 * Serialize one plan transition into the envelope appended as a CustomEntry.
 * `sequence` is owned by the caller (single controller, monotonic).
 */
export function serializePlanRecord(
  snapshot: PlanRuntimeSnapshot,
  event: string,
  sequence: number,
): PlanRecordData {
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    sequence,
    event,
    snapshot: structuredClone(snapshot),
  };
}

/**
 * Rebuild the latest valid plan snapshot from the current branch entries.
 * Returns null when no valid contiguous record chain exists (no planning ever
 * happened on this branch, or the first record is missing/corrupt).
 */
export function rebuildPlanFromEntries(entries: readonly SessionEntry[]): RebuiltPlanRecord | null {
  const bySequence = new Map<number, PlanRecordData>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== PLAN_CUSTOM_TYPE) {
      continue;
    }
    const data = isPlanRecordData(entry.data) ? entry.data : null;
    if (!data) {
      continue;
    }
    // A duplicate sequence keeps the FIRST occurrence (entries are in
    // append order; a later duplicate is diagnostic noise).
    if (!bySequence.has(data.sequence)) {
      bySequence.set(data.sequence, data);
    }
  }
  if (bySequence.size === 0) {
    return null;
  }
  // Walk from sequence 1 upward; the run stops at the first gap.
  let sequence = 0;
  let snapshot: PlanRuntimeSnapshot | null = null;
  while (bySequence.has(sequence + 1)) {
    sequence += 1;
    snapshot = bySequence.get(sequence)!.snapshot;
  }
  if (sequence === 0 || snapshot === null) {
    return null;
  }
  return { snapshot: structuredClone(snapshot), sequence };
}

/**
 * Model-visible generation token. submit_user_plan requires this exact
 * generationId; pix-plan-v1 CustomEntries never enter the LLM context.
 */
export function serializePlanGenerationContext(generationId: string, concise?: boolean): string {
  const lines: string[] = [
    `<plan_generation generation_id="${generationId}">`,
    `When calling submit_user_plan you MUST pass generationId exactly as "${generationId}". Any other value is rejected as stale.`,
  ];
  if (concise === true) {
    lines.push("Regenerate the plan more concisely (fewer steps, tighter scope).");
  }
  lines.push("</plan_generation>");
  return lines.join("\n");
}

/**
 * Structured context text for the plan/execution context injection
 * (customType "pix-plan-context", display:false, enters the LLM context).
 */
export function serializePlanContextMessage(plan: Plan, phase: PlanStatus): string {
  const lines: string[] = [];
  lines.push(`<plan_context plan_id="${plan.planId}" version="${plan.version}" status="${phase}">`);
  lines.push(`Title: ${plan.title}`);
  lines.push(`Summary: ${plan.summary}`);
  lines.push("Steps:");
  for (const step of plan.steps) {
    const files = step.files.length > 0
      ? ` [files: ${step.files.map((f) => `${f.path}(${f.operation})`).join(", ")}]`
      : "";
    lines.push(`- ${step.stepKey}: ${step.title}${files}`);
  }
  lines.push("</plan_context>");
  return lines.join("\n");
}
