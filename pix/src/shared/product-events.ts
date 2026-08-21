/**
 * Anonymous product-event schema + privacy filtering (PiX-1.4-PLAN.md §6.3 /
 * PRD §4.4).
 *
 * This is a leaf module with no imports at all. It is referenced only by main's
 * `ProductEventCollector` and its producers; the renderer only flips the
 * `enableProductAnalytics` setting through the existing settings API and never
 * reads the event log.
 *
 * Privacy contract (PRD §4.4): events never contain user prompts, code, file
 * content, full command text or model output. The recorded payload is limited
 * to a random taskId (stamped by the collector per event), version, status,
 * duration, counts, model identity and error category. `sanitizeProductEventPayload`
 * enforces this as an allowlist filter: any field outside the payload schema is
 * dropped before an event can be appended.
 *
 * Event names are segmented per release so later releases extend the union
 * without touching earlier entries. Version gate: 1.4.0 ships exactly the
 * `plan_*` set below; the 1.4.1 `agent_task_*` names are added by a later
 * stage and must not be produced or validated before then.
 */

export const PRODUCT_EVENT_SCHEMA_VERSION = 1 as const;

export const PRODUCT_EVENT_NAMES_V140 = [
  "plan_mode_entered",
  "plan_generation_started",
  "plan_generation_succeeded",
  "plan_generation_failed",
  "plan_generation_cancelled",
  "plan_revision_requested",
  "plan_approved",
  "plan_cancelled",
  "plan_execution_started",
  "plan_execution_completed",
  "plan_execution_failed",
  "plan_execution_cancelled",
] as const;

export type ProductEventNameV140 = (typeof PRODUCT_EVENT_NAMES_V140)[number];

export const PRODUCT_EVENT_NAMES_V141 = [
  "agent_task_started",
  "agent_task_backgrounded",
  "agent_task_waiting_input",
  "agent_task_completed",
  "agent_task_failed",
  "agent_task_cancelled",
] as const;

export type ProductEventNameV141 = (typeof PRODUCT_EVENT_NAMES_V141)[number];

export const PRODUCT_EVENT_NAMES_V142 = [
  "agent_task_interrupted",
  "agent_task_restored",
  "agent_task_resume_requested",
  "agent_task_resume_succeeded",
  "agent_task_resume_failed",
] as const;

export type ProductEventNameV142 = (typeof PRODUCT_EVENT_NAMES_V142)[number];

export const PRODUCT_EVENT_NAMES_V143 = [
  "workflow_started",
  "workflow_completed",
  "workflow_failed",
  "workflow_cancelled",
] as const;

export type ProductEventNameV143 = (typeof PRODUCT_EVENT_NAMES_V143)[number];
/** 1.4.1 extends the alias with the `agent_task_*` names; 1.4.2 (R2) adds interrupted/restored, (R3) the resume_* names; 1.4.3 adds the `workflow_*` names. */
export type ProductEventName =
  | ProductEventNameV140
  | ProductEventNameV141
  | ProductEventNameV142
  | ProductEventNameV143;

/** Error categories mirror PlanGenerationFailure codes (plan-types §4.1). */
export const PRODUCT_EVENT_ERROR_CATEGORIES = [
  "model_unavailable",
  "auth_unavailable",
  "timeout",
  "truncated",
  "invalid_plan",
  "cancelled",
  "internal_error",
] as const;
export type ProductEventErrorCategory = (typeof PRODUCT_EVENT_ERROR_CATEGORIES)[number];

export interface ProductEventModelId {
  provider: string;
  modelId: string;
}

/**
 * The only payload fields a product event may carry. The collector stamps the
 * random `taskId` itself, so it is not part of this schema.
 */
export interface ProductEventPayload {
  /** Plan version (版本). */
  version?: number;
  /** Plan/step status string (状态). */
  status?: string;
  /** 耗时 in milliseconds. */
  durationMs?: number;
  /** 计数 (step counts, generation counts, ...). */
  counts?: Record<string, number>;
  /** 模型标识. */
  model?: ProductEventModelId;
  /** 错误分类. */
  errorCategory?: ProductEventErrorCategory;
}

export interface ProductEvent {
  schemaVersion: typeof PRODUCT_EVENT_SCHEMA_VERSION;
  name: ProductEventName;
  payload: ProductEventPayload;
}

// ============================================================================
// Guard & sanitize helpers
// ============================================================================

const MAX_PAYLOAD_STRING_CHARS = 64;
const MAX_MODEL_PROVIDER_CHARS = 128;
const MAX_MODEL_ID_CHARS = 256;
const MAX_COUNTS_ENTRIES = 16;
const MAX_COUNTS_KEY_CHARS = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function isErrorCategory(value: unknown): value is ProductEventErrorCategory {
  return isOneOf(value, PRODUCT_EVENT_ERROR_CATEGORIES);
}

function isCounts(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_COUNTS_ENTRIES) return false;
  return entries.every(
    (entry) => entry[0].length > 0 && entry[0].length <= MAX_COUNTS_KEY_CHARS && isFiniteNonNegative(entry[1]),
  );
}

function isModelId(value: unknown): value is ProductEventModelId {
  if (!isRecord(value)) return false;
  return (
    typeof value.provider === "string" &&
    value.provider.length > 0 &&
    value.provider.length <= MAX_MODEL_PROVIDER_CHARS &&
    typeof value.modelId === "string" &&
    value.modelId.length > 0 &&
    value.modelId.length <= MAX_MODEL_ID_CHARS
  );
}

function isProductEventPayload(value: unknown): value is ProductEventPayload {
  if (!isRecord(value)) return false;
  const { version, status, durationMs, counts, model, errorCategory } = value;
  if (version !== undefined && !(isFiniteNonNegative(version) && Number.isInteger(version))) return false;
  if (status !== undefined && typeof status !== "string") return false;
  if (durationMs !== undefined && !isFiniteNonNegative(durationMs)) return false;
  if (counts !== undefined && !isCounts(counts)) return false;
  if (model !== undefined && !isModelId(model)) return false;
  if (errorCategory !== undefined && !isErrorCategory(errorCategory)) return false;
  return true;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Non-throwing structural narrowing of an unknown value into ProductEvent.
 * Validates schemaVersion, the version-gated event name union and the payload
 * shape. Unknown extra fields are ignored (the sanitizer is the write-side
 * privacy filter).
 */
export function isProductEvent(value: unknown): value is ProductEvent {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== PRODUCT_EVENT_SCHEMA_VERSION) return false;
  if (
    !isOneOf(value.name, [
      ...PRODUCT_EVENT_NAMES_V140,
      ...PRODUCT_EVENT_NAMES_V141,
      ...PRODUCT_EVENT_NAMES_V142,
      ...PRODUCT_EVENT_NAMES_V143,
    ])
  ) {
    return false;
  }
  return isProductEventPayload(value.payload);
}

/**
 * Privacy filter. Returns a new payload containing only allowlisted fields
 * with valid shapes and bounded sizes; anything else - prompt text, code, file
 * content, command text, model output, unknown keys - is dropped. Never throws
 * and never mutates its input.
 */
export function sanitizeProductEventPayload(value: unknown): ProductEventPayload {
  if (!isRecord(value)) return {};
  const out: ProductEventPayload = {};
  if (isFiniteNonNegative(value.version) && Number.isInteger(value.version)) {
    out.version = value.version;
  }
  if (
    typeof value.status === "string" &&
    value.status.length > 0 &&
    value.status.length <= MAX_PAYLOAD_STRING_CHARS
  ) {
    out.status = value.status;
  }
  if (isFiniteNonNegative(value.durationMs)) {
    out.durationMs = value.durationMs;
  }
  if (isCounts(value.counts)) {
    out.counts = value.counts;
  }
  if (isModelId(value.model)) {
    out.model = { provider: value.model.provider, modelId: value.model.modelId };
  }
  if (isErrorCategory(value.errorCategory)) {
    out.errorCategory = value.errorCategory;
  }
  return out;
}
