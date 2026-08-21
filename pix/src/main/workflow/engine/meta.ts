/**
 * Meta validation for caller-provided workflow meta data.
 *
 * Meta arrives as plain JSON data (schema-checked by the tool layer, never
 * evaluated script text — evaluating it on the host could run getters
 * outside the worker timeout that exists to isolate model-written code).
 * Every violation is reported by name, and the engine rejects the request
 * synchronously with `META_INVALID` before anything is published.
 */

import { WorkflowError } from "./engine.js";
import type { WorkflowMeta, WorkflowPhase } from "../../../shared/workflow-types.js";

const META_KEYS = new Set(["name", "description", "whenToUse", "phases"]);
const PHASE_KEYS = new Set(["title", "detail", "provider", "model"]);

interface MetaShapeResult {
  meta?: WorkflowMeta;
  violations: string[];
}

/** Collect shape violations for a meta value (plain JSON data by the seam contract). */
function validateMetaShape(meta: unknown): MetaShapeResult {
  const violations: string[] = [];
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return { violations: ["meta must be an object"] };
  }
  const record = meta as Record<string, unknown>;

  if (typeof record.name !== "string" || record.name.length === 0) {
    violations.push("name must be a non-empty string");
  }
  if (typeof record.description !== "string" || record.description.length === 0) {
    violations.push("description must be a non-empty string");
  }
  if (record.whenToUse !== undefined && typeof record.whenToUse !== "string") {
    violations.push("whenToUse must be a string");
  }
  for (const key of Object.keys(record)) {
    if (!META_KEYS.has(key)) {
      violations.push(`unexpected key ${key}`);
    }
  }

  const phases: WorkflowPhase[] = [];
  if (record.phases !== undefined) {
    if (!Array.isArray(record.phases)) {
      violations.push("phases must be an array");
    } else {
      record.phases.forEach((phase, index) => {
        if (typeof phase !== "object" || phase === null || Array.isArray(phase)) {
          violations.push(`phases[${index}] must be an object`);
          return;
        }
        const entry = phase as Record<string, unknown>;
        for (const key of Object.keys(entry)) {
          if (!PHASE_KEYS.has(key)) {
            violations.push(`phases[${index}]: unexpected key ${key}`);
          }
        }
        if (typeof entry.title !== "string" || entry.title.length === 0) {
          violations.push(`phases[${index}].title must be a non-empty string`);
        }
        if (entry.detail !== undefined && typeof entry.detail !== "string") {
          violations.push(`phases[${index}].detail must be a string`);
        }
        if (entry.provider !== undefined && typeof entry.provider !== "string") {
          violations.push(`phases[${index}].provider must be a string`);
        }
        if (entry.model !== undefined && typeof entry.model !== "string") {
          violations.push(`phases[${index}].model must be a string`);
        }
        phases.push({
          title: entry.title as string,
          ...(entry.detail !== undefined ? { detail: entry.detail as string } : {}),
          ...(entry.provider !== undefined ? { provider: entry.provider as string } : {}),
          ...(entry.model !== undefined ? { model: entry.model as string } : {}),
        });
      });
    }
  }

  if (violations.length > 0) {
    return { violations };
  }
  const normalized: WorkflowMeta = {
    name: record.name as string,
    description: record.description as string,
  };
  if (record.whenToUse !== undefined) {
    normalized.whenToUse = record.whenToUse as string;
  }
  if (record.phases !== undefined) {
    normalized.phases = phases;
  }
  return { violations, meta: normalized };
}

/**
 * Validate a caller-provided meta value against the `WorkflowMeta` contract.
 * Returns a NORMALIZED copy (the engine never aliases the caller's object),
 * or throws `WorkflowError` with code `META_INVALID` naming EVERY violation
 * (unknown fields, missing/mistyped `name`/`description`, malformed
 * `phases`), joined by "; ".
 */
export function validateMeta(value: unknown): WorkflowMeta {
  const { meta, violations } = validateMetaShape(value);
  if (meta === undefined) {
    throw new WorkflowError(`invalid meta: ${violations.join("; ")}`, "META_INVALID");
  }
  return meta;
}
