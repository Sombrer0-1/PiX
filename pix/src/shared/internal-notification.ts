/**
 * Model-visible, UI-hidden notifications exchanged between PiX child runtimes
 * and their parent agent.
 *
 * The provider message protocol currently has no notification role. These
 * notifications therefore remain custom messages inside the application and
 * are rendered as a bounded, explicit envelope before they cross the LLM
 * boundary.
 */

export const INTERNAL_NOTIFICATION_SCHEMA_VERSION = 1 as const;
export const DEFAULT_INTERNAL_NOTIFICATION_MAX_BYTES = 32 * 1024;
const DEFAULT_RESULT_MAX_BYTES = 16 * 1024;
const DEFAULT_ITEM_RESULT_MAX_BYTES = 4 * 1024;
const DEFAULT_TEXT_MAX_BYTES = 8 * 1024;

/**
 * Live protocol customType values. Must stay identical to coding-agent
 * LEGACY_INTERNAL_CUSTOM_TYPES so restored sessions without context:"internal"
 * are still wrapped by convertToLlm. Drift is asserted in
 * pix/src/renderer/__tests__/display-blocks.test.ts.
 */
export const INTERNAL_CUSTOM_MESSAGE_TYPES = {
  TASK_RESULT: "pix-agent-task-result",
  PLAN_CONTEXT: "pix-plan-context",
  PLAN_RETRY: "pix-plan-retry",
  TEAM_NOTIFICATION: "pix-team-notification",
} as const;

export function isInternalCustomMessageType(value: unknown): value is (typeof INTERNAL_CUSTOM_MESSAGE_TYPES)[keyof typeof INTERNAL_CUSTOM_MESSAGE_TYPES] {
  return typeof value === "string" && Object.values(INTERNAL_CUSTOM_MESSAGE_TYPES).includes(
    value as (typeof INTERNAL_CUSTOM_MESSAGE_TYPES)[keyof typeof INTERNAL_CUSTOM_MESSAGE_TYPES],
  );
}

export type InternalNotificationSource = "agent-task" | "team" | "plan" | "workflow";

export interface InternalNotificationUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  turns: number;
}

export interface InternalNotificationItem {
  id?: string;
  index?: number;
  step?: number;
  agentName?: string;
  agentSource?: string;
  status: string;
  result?: string;
  error?: string;
  usage?: InternalNotificationUsage;
}

export interface InternalNotification {
  notificationId: string;
  source: InternalNotificationSource;
  kind: string;
  taskId?: string;
  groupId?: string;
  agentName?: string;
  status?: string;
  requiresAction?: boolean;
  result?: string;
  error?: string;
  usage?: InternalNotificationUsage;
  planLink?: {
    planId: string;
    version: number;
    stepId: string;
  };
  items?: InternalNotificationItem[];
}

export type InternalNotificationRootTag =
  | "task-notification"
  | "team-notification"
  | "plan-notification"
  | "workflow-result";

interface RenderedText {
  text: string;
  truncated: boolean;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function truncateUtf8(value: string, maxBytes: number): RenderedText {
  if (maxBytes <= 0) {
    return { text: "", truncated: value.length > 0 };
  }
  if (utf8ByteLength(value) <= maxBytes) {
    return { text: value, truncated: false };
  }

  const bytes = new TextEncoder().encode(value).subarray(0, maxBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let length = bytes.length; length >= 0; length--) {
    try {
      return { text: decoder.decode(bytes.subarray(0, length)), truncated: true };
    } catch {
      // The cut ended inside a UTF-8 sequence. Remove one more byte.
    }
  }
  return { text: "", truncated: true };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function attribute(value: string | number | boolean | undefined, maxBytes = DEFAULT_TEXT_MAX_BYTES): string | undefined {
  if (value === undefined) return undefined;
  const bounded = truncateUtf8(String(value), maxBytes).text;
  return escapeXml(bounded);
}

function element(tag: string, value: string | undefined, maxBytes = DEFAULT_TEXT_MAX_BYTES): string | undefined {
  if (value === undefined) return undefined;
  const bounded = truncateUtf8(value, maxBytes).text;
  return `<${tag}>${escapeXml(bounded)}</${tag}>`;
}

function usageElement(usage: InternalNotificationUsage | undefined): string | undefined {
  if (usage === undefined) return undefined;
  return [
    `<usage`,
    ` input="${attribute(usage.input)}"`,
    ` output="${attribute(usage.output)}"`,
    ` cache-read="${attribute(usage.cacheRead)}"`,
    ` cache-write="${attribute(usage.cacheWrite)}"`,
    ` total="${attribute(usage.totalTokens)}"`,
    ` cost="${attribute(usage.cost)}"`,
    ` turns="${attribute(usage.turns)}"`,
    `/>`,
  ].join("");
}

export function internalNotificationRootTag(source: InternalNotificationSource): InternalNotificationRootTag {
  switch (source) {
    case "agent-task":
      return "task-notification";
    case "team":
      return "team-notification";
    case "plan":
      return "plan-notification";
    case "workflow":
      return "workflow-result";
  }
}

function renderItem(item: InternalNotificationItem, resultMaxBytes: number, forceTruncated = false): string {
  const result = item.result === undefined ? undefined : truncateUtf8(item.result, resultMaxBytes);
  const attrs = [
    ["id", attribute(item.id)],
    ["index", attribute(item.index)],
    ["step", attribute(item.step)],
    ["agent-name", attribute(item.agentName)],
    ["agent-source", attribute(item.agentSource)],
    ["status", attribute(item.status)],
    ["result-truncated", attribute((result?.truncated ?? false) || forceTruncated)],
  ]
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => ` ${key}="${value}"`)
    .join("");

  return [
    `<subagent-result${attrs}>`,
    element("result", result?.text),
    element("error", item.error),
    usageElement(item.usage),
    "</subagent-result>",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/**
 * Truncation facts the compaction pass already applied: the recursive render
 * reports them instead of recomputing them from the already-shortened text.
 */
interface RenderTruncation {
  resultTruncated?: boolean;
  itemTruncated?: boolean[];
}

function renderNotification(
  notification: InternalNotification,
  maxBytes: number,
  allowCompaction = true,
  truncation: RenderTruncation = {},
): string {
  const root = internalNotificationRootTag(notification.source);
  const result = notification.result === undefined
    ? undefined
    : truncateUtf8(notification.result, Math.min(DEFAULT_RESULT_MAX_BYTES, maxBytes));
  const itemResultMaxBytes = notification.items?.length
    ? Math.min(DEFAULT_ITEM_RESULT_MAX_BYTES, Math.max(256, Math.floor(DEFAULT_RESULT_MAX_BYTES / notification.items.length)))
    : DEFAULT_ITEM_RESULT_MAX_BYTES;
  const attrs = [
    ["version", attribute(INTERNAL_NOTIFICATION_SCHEMA_VERSION)],
    ["notification-id", attribute(notification.notificationId)],
    ["source", attribute(notification.source)],
    ["kind", attribute(notification.kind)],
    ["task-id", attribute(notification.taskId)],
    ["group-id", attribute(notification.groupId)],
    ["agent-name", attribute(notification.agentName)],
    ["status", attribute(notification.status)],
    ["requires-action", attribute(notification.requiresAction ?? false)],
    ["result-truncated", attribute((result?.truncated ?? false) || (truncation.resultTruncated ?? false))],
  ]
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => ` ${key}="${value}"`)
    .join("");

  const lines = [
    `<${root}${attrs}>`,
    element("task-id", notification.taskId),
    element("group-id", notification.groupId),
    element("agent-name", notification.agentName),
    element("status", notification.status),
    notification.planLink === undefined
      ? undefined
      : `<plan-link plan-id="${attribute(notification.planLink.planId)}" version="${attribute(notification.planLink.version)}" step-id="${attribute(notification.planLink.stepId)}"/>`,
    element("result", result?.text, Math.min(DEFAULT_RESULT_MAX_BYTES, maxBytes)),
    element("error", notification.error),
    usageElement(notification.usage),
    notification.items === undefined || notification.items.length === 0
      ? undefined
      : [
          "<items>",
          ...notification.items.map((item, index) =>
            renderItem(item, itemResultMaxBytes, truncation.itemTruncated?.[index] ?? false),
          ),
          "</items>",
        ].join("\n"),
    "</" + root + ">",
  ].filter((line): line is string => line !== undefined);

  const rendered = lines.join("\n");
  if (utf8ByteLength(rendered) <= maxBytes) {
    return rendered;
  }

  // Keep the protocol valid even when metadata and several child results are
  // larger than the normal budget. The second pass drops long result bodies
  // before ever truncating the envelope itself. Truncation facts are carried
  // into the recursive render so result-truncated still reports true instead
  // of being recomputed from the already-shortened text.
  const compactResult = notification.result === undefined ? undefined : truncateUtf8(notification.result, 512);
  const compactError = notification.error === undefined ? undefined : truncateUtf8(notification.error, 256);
  const compactItems = notification.items?.map((item) => ({
    ...item,
    result: item.result === undefined ? undefined : truncateUtf8(item.result, 256).text,
    error: item.error === undefined ? undefined : truncateUtf8(item.error, 256).text,
  }));
  const compact = {
    ...notification,
    result: compactResult?.text,
    error: compactError?.text,
    items: compactItems,
  };
  const compactTruncation: RenderTruncation = {
    resultTruncated: compactResult?.truncated ?? false,
    itemTruncated: (notification.items ?? []).map((item) =>
      item.result !== undefined && truncateUtf8(item.result, 256).truncated,
    ),
  };
  const compactRendered = allowCompaction ? renderNotification(compact, maxBytes, false, compactTruncation) : rendered;
  if (allowCompaction && utf8ByteLength(compactRendered) <= maxBytes) {
    return compactRendered;
  }

  // All user-controlled values have bounded fields above, so this fallback
  // should only be reachable if a future field is added without a bound.
  const fallbackAttrs = [
    ["version", attribute(INTERNAL_NOTIFICATION_SCHEMA_VERSION, 128)],
    ["notification-id", attribute(notification.notificationId, 128)],
    ["source", attribute(notification.source, 128)],
    ["kind", attribute(notification.kind, 128)],
    ["task-id", attribute(notification.taskId, 128)],
    ["group-id", attribute(notification.groupId, 128)],
    ["requires-action", attribute(notification.requiresAction ?? false, 128)],
    ["result-truncated", "true"],
  ]
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => ` ${key}="${value}"`)
    .join("");
  return [
    `<${root}${fallbackAttrs}>`,
    `<status>${escapeXml(truncateUtf8(notification.status ?? "unknown", 128).text)}</status>`,
    `</${root}>`,
  ].join("\n");
}

/**
 * Serialize a model-facing internal notification. The result is always a
 * complete envelope; only result/error payload fields are reduced under
 * pressure, never the opening or closing protocol tags.
 */
export function formatInternalNotification(
  notification: InternalNotification,
  maxBytes = DEFAULT_INTERNAL_NOTIFICATION_MAX_BYTES,
): string {
  return renderNotification(notification, Math.max(1024, maxBytes));
}
