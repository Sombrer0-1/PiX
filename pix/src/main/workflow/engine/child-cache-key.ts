/**
 * Pure cache identity for workflow child agent() results. Scope is the
 * workspace + session + meta.name triple; the content key is the prompt
 * plus a canonical JSON of the opts that change the model call. Worker
 * runtime may import this file (`./child-cache-key.js`); it must never
 * touch `node:fs` or AgentTask.
 */

import { createHash } from "node:crypto";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Recursively sort object keys by UTF-16 code units, then JSON.stringify.
 * `undefined` object fields are omitted (the key is absent). Arrays keep
 * order and have their elements canonicalized.
 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  const record = value as Record<string, unknown>;
  // Null prototype: a "__proto__" own key must not hit Object.prototype's
  // setter and vanish from the canonical form (that would collapse distinct
  // schemas onto the same cache key).
  const sorted: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(record).sort()) {
    const field = record[key];
    if (field === undefined) continue;
    sorted[key] = canonicalize(field);
  }
  return sorted;
}

/**
 * Directory-segment id for a child-cache scope. Does not include
 * scriptHash or argsHash — rewriting the orchestration script must still
 * hit unchanged agent() calls in the same session + meta.name.
 */
export function workflowCacheScopeId(workspaceId: string, sessionId: string, metaName: string): string {
  return sha256Hex(workspaceId + "\n" + sessionId + "\n" + metaName);
}

/**
 * Content-addressed key for one agent() call. Only prompt + schema /
 * provider / model / maxTurns participate. label / phase / retry / cache /
 * artifacts / providerDefault are ignored even if present on the opts object.
 */
export function workflowCacheKey(
  prompt: string,
  opts: {
    schema?: unknown;
    provider?: string;
    model?: string;
    maxTurns?: number;
  },
): string {
  return sha256Hex(
    prompt +
      "\n" +
      canonicalJSON({
        schema: opts.schema,
        provider: opts.provider,
        model: opts.model,
        maxTurns: opts.maxTurns,
      }),
  );
}
