/**
 * workflowCacheScopeId / workflowCacheKey / canonicalJSON tests (S2).
 *
 * Independently verifies pix/src/main/workflow/engine/child-cache-key.ts:
 * same prompt/opts produce the same key; object key order is irrelevant;
 * label / phase / retry / cache / artifacts / providerDefault are not in
 * the key; missing schema omits that field; scope is workspaceId + sessionId
 * + meta.name (no scriptHash / argsHash); the module value-imports only
 * `./` or `node:` and never `node:fs`. Does not depend on the worker, host,
 * or any other workflow module.
 *
 * Run with: npm exec tsx -- src/main/__tests__/workflow-child-cache-key.test.ts
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJSON, workflowCacheKey, workflowCacheScopeId } from "../workflow/engine/child-cache-key.js";

// ============================================================================
// Test harness (matches plan-types.test.ts style)
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(
      `  FAIL: ${message} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${name} ===\n`);
  try {
    await fn();
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name} threw unexpectedly: ${String(err)}`);
  }
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function isLowerHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

// ============================================================================
// Tests
// ============================================================================

await run("canonicalJSON sorts object keys by UTF-16 code units", async () => {
  assertEqual(canonicalJSON({ b: 1, a: 2 }), '{"a":2,"b":1}', "top-level keys sorted");
  assertEqual(
    canonicalJSON({ z: { b: 1, a: 2 }, y: 0 }),
    '{"y":0,"z":{"a":2,"b":1}}',
    "nested object keys sorted",
  );
  assertEqual(
    canonicalJSON({ arr: [{ b: 1, a: 2 }, { d: 4, c: 3 }] }),
    '{"arr":[{"a":2,"b":1},{"c":3,"d":4}]}',
    "array order preserved; element keys sorted",
  );
  assertEqual(
    canonicalJSON({ a: 1, A: 2 }),
    '{"A":2,"a":1}',
    "UTF-16: uppercase A (65) before lowercase a (97)",
  );
});

await run("canonicalJSON omits undefined fields; missing schema key is absent", async () => {
  assertEqual(
    canonicalJSON({ schema: undefined, provider: "p" }),
    '{"provider":"p"}',
    "undefined schema field is absent",
  );
  assertEqual(canonicalJSON({}), "{}", "empty object stays empty");
  assertEqual(
    canonicalJSON({ schema: { type: "object" }, provider: undefined, model: "m", maxTurns: undefined }),
    '{"model":"m","schema":{"type":"object"}}',
    "only defined cache-key fields appear, keys sorted",
  );
});

await run("same prompt/opts produce the same key", async () => {
  const opts = { schema: { type: "object", properties: { n: { type: "number" } } }, provider: "p", model: "m", maxTurns: 3 };
  const a = workflowCacheKey("review this", opts);
  const b = workflowCacheKey("review this", opts);
  assert(isLowerHex64(a), "key is lowercase sha256 hex");
  assertEqual(a, b, "identical prompt/opts => identical key");
  assertEqual(
    a,
    sha256Hex("review this\n" + canonicalJSON(opts)),
    "key is sha256(prompt + newline + canonicalJSON(opts))",
  );
});

await run("canonicalJSON preserves an own __proto__ key", async () => {
  const withProto: Record<string, unknown> = { type: "object" };
  Object.defineProperty(withProto, "__proto__", {
    value: { type: "string" },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const withoutProto = { type: "object" };
  const withJson = canonicalJSON(withProto);
  const withoutJson = canonicalJSON(withoutProto);
  assert(withJson.includes("__proto__"), "own __proto__ key survives canonicalJSON");
  assert(withJson !== withoutJson, "own __proto__ key does not collapse onto a missing-key object");
  const keyA = workflowCacheKey("p", { schema: withProto });
  const keyB = workflowCacheKey("p", { schema: withoutProto });
  assert(keyA !== keyB, "schemas that differ only by an own __proto__ key produce different cache keys");
});

await run("object key order is irrelevant", async () => {
  const schemaA = {
    type: "object",
    properties: { b: { type: "string" }, a: { type: "number" } },
    required: ["a", "b"],
  };
  const schemaB = {
    required: ["a", "b"],
    properties: { a: { type: "number" }, b: { type: "string" } },
    type: "object",
  };
  const keyA = workflowCacheKey("p", { schema: schemaA, model: "m", provider: "prov", maxTurns: 2 });
  const keyB = workflowCacheKey("p", { provider: "prov", schema: schemaB, maxTurns: 2, model: "m" });
  assertEqual(keyA, keyB, "schema and opts key order do not change the key");
});

await run("label / phase / retry / cache / artifacts / providerDefault are not in the key", async () => {
  const base = { schema: { type: "object" }, provider: "openai", model: "gpt", maxTurns: 4 };
  const withExtras = {
    ...base,
    label: "review",
    phase: "p1",
    retry: 2,
    cache: false,
    artifacts: [{ name: "x" }],
    providerDefault: "default",
  };
  assertEqual(
    workflowCacheKey("prompt", withExtras),
    workflowCacheKey("prompt", base),
    "extra fields do not participate in the key",
  );
  const otherLabel = { ...base, label: "other-label" };
  assertEqual(
    workflowCacheKey("prompt", otherLabel),
    workflowCacheKey("prompt", base),
    "different label still same key",
  );
});

await run("missing schema omits that key; different prompt or opts differ", async () => {
  const noSchema = workflowCacheKey("p", { provider: "x" });
  const withSchema = workflowCacheKey("p", { schema: { type: "object" }, provider: "x" });
  assert(noSchema !== withSchema, "present vs missing schema changes the key");
  assertEqual(
    noSchema,
    sha256Hex('p\n{"provider":"x"}'),
    "missing schema is absent from canonical JSON",
  );
  assert(
    workflowCacheKey("p1", { model: "m" }) !== workflowCacheKey("p2", { model: "m" }),
    "different prompt => different key",
  );
  assert(
    workflowCacheKey("p", { model: "a" }) !== workflowCacheKey("p", { model: "b" }),
    "different model => different key",
  );
});

await run("scopeId is sha256 of workspaceId + sessionId + meta.name", async () => {
  const id = workflowCacheScopeId("ws-1", "sess-1", "audit");
  assert(isLowerHex64(id), "scopeId is lowercase sha256 hex");
  assertEqual(id, sha256Hex("ws-1\nsess-1\naudit"), "formula is workspaceId + newline + sessionId + newline + meta.name");
  assertEqual(
    workflowCacheScopeId("ws-1", "sess-1", "audit"),
    workflowCacheScopeId("ws-1", "sess-1", "audit"),
    "same triple => same scope",
  );
  assert(
    workflowCacheScopeId("ws-1", "sess-1", "audit") !== workflowCacheScopeId("ws-1", "sess-1", "review"),
    "different meta.name => different scope",
  );
  assert(
    workflowCacheScopeId("ws-a", "sess-1", "audit") !== workflowCacheScopeId("ws-b", "sess-1", "audit"),
    "different workspaceId => different scope",
  );
  assert(
    workflowCacheScopeId("ws-1", "sess-a", "audit") !== workflowCacheScopeId("ws-1", "sess-b", "audit"),
    "different sessionId => different scope",
  );
});

await run("child-cache-key.ts uses only ./ or node: imports and never node:fs", async () => {
  const source = readFileSync(new URL("../workflow/engine/child-cache-key.ts", import.meta.url), "utf8");
  const valueFrom = /(?:^|\n)import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/g;
  let importCount = 0;
  for (const match of source.matchAll(valueFrom)) {
    importCount++;
    const spec = match[1] ?? "";
    assert(
      spec.startsWith("./") || spec.startsWith("node:"),
      `value-imports ${JSON.stringify(spec)} (must be ./ or node:)`,
    );
    assert(spec !== "node:fs", "must not import node:fs");
  }
  assert(importCount >= 1, "module has at least one value import");
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
