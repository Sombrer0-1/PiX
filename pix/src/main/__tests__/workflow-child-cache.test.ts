/**
 * WorkflowChildCache tests (S3).
 *
 * Independently verifies pix/src/main/workflow/child-cache.ts against the
 * locked host-only fs contract: store/lookup round-trip, bad JSON is a miss,
 * UTF-8 of the materialized value > 256KiB is skipped (no write), concurrent
 * different keys do not interfere, disk layout is
 * `{rootDir}/{scopeId}/children/{key}.json` with no workspaceId segment.
 * Does not depend on the worker, host, or AgentTaskStore.
 *
 * Run with: npm exec tsx -- src/main/__tests__/workflow-child-cache.test.ts
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowChildCache } from "../workflow/child-cache.js";
import { workflowCacheKey, workflowCacheScopeId } from "../workflow/engine/child-cache-key.js";

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

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message} - expected ${e}, got ${a}`);
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

// ============================================================================
// Helpers
// ============================================================================

const roots: string[] = [];
const MAX_VALUE_BYTES = 256 * 1024;

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pix-workflow-child-cache-"));
  roots.push(dir);
  return dir;
}

function filePath(root: string, scopeId: string, key: string): string {
  return join(root, scopeId, "children", `${key}.json`);
}

// ============================================================================
// Tests
// ============================================================================

await run("store/lookup round-trip and disk layout", async () => {
  const root = await makeRoot();
  const cache = new WorkflowChildCache({ rootDir: root });
  const scopeId = workflowCacheScopeId("ws-1", "sess-1", "audit");
  const key = workflowCacheKey("review this", { provider: "p", model: "m", maxTurns: 3 });
  const value = { items: [1, 2], label: "ok" };

  assertEqual(await cache.lookup(scopeId, key), undefined, "miss before store");
  assertEqual(await cache.store(scopeId, key, value), "stored", "store returns stored");
  assertDeepEqual(await cache.lookup(scopeId, key), { value }, "lookup returns stored value");

  const path = filePath(root, scopeId, key);
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as { v: number; key: string; storedAt: number; value: unknown };
  assertEqual(parsed.v, 1, "file envelope v is 1");
  assertEqual(parsed.key, key, "file envelope key matches");
  assert(typeof parsed.storedAt === "number" && Number.isFinite(parsed.storedAt), "storedAt is a finite number");
  assertDeepEqual(parsed.value, value, "file envelope value matches");

  const scopeEntries = await readdir(root);
  assertDeepEqual(scopeEntries, [scopeId], "root contains only the scopeId directory (no workspaceId segment)");
  const childrenEntries = await readdir(join(root, scopeId));
  assertDeepEqual(childrenEntries, ["children"], "scope directory contains only children/");
});

await run("optional childId round-trips; old files without it still hit", async () => {
  const root = await makeRoot();
  const cache = new WorkflowChildCache({ rootDir: root });
  const scopeId = workflowCacheScopeId("ws-1", "sess-1", "audit");
  const withId = workflowCacheKey("with-id", { model: "m" });
  const withoutId = workflowCacheKey("without-id", { model: "m" });

  assertEqual(await cache.store(scopeId, withId, { n: 1 }, "tsk_auth"), "stored", "store with childId");
  assertDeepEqual(
    await cache.lookup(scopeId, withId),
    { value: { n: 1 }, childId: "tsk_auth" },
    "lookup returns value and childId",
  );

  assertEqual(await cache.store(scopeId, withoutId, { n: 2 }), "stored", "store without childId");
  assertDeepEqual(
    await cache.lookup(scopeId, withoutId),
    { value: { n: 2 } },
    "lookup omits childId when the file has none",
  );

  await mkdir(join(root, scopeId, "children"), { recursive: true });
  const legacyKey = workflowCacheKey("legacy", { model: "m" });
  await writeFile(
    filePath(root, scopeId, legacyKey),
    JSON.stringify({ v: 1, key: legacyKey, storedAt: 1, value: "old" }),
    "utf8",
  );
  assertDeepEqual(
    await cache.lookup(scopeId, legacyKey),
    { value: "old" },
    "legacy v:1 files without childId still hit",
  );
});

await run("bad JSON and missing file are a miss, not a throw", async () => {
  const root = await makeRoot();
  const cache = new WorkflowChildCache({ rootDir: root });
  const scopeId = workflowCacheScopeId("ws-1", "sess-1", "audit");
  const key = workflowCacheKey("p", { model: "m" });
  const otherKey = workflowCacheKey("q", { model: "m" });

  assertEqual(await cache.lookup(scopeId, key), undefined, "missing file is undefined");

  await mkdir(join(root, scopeId, "children"), { recursive: true });
  await writeFile(filePath(root, scopeId, key), "{not-json", "utf8");
  assertEqual(await cache.lookup(scopeId, key), undefined, "truncated JSON is undefined");

  await writeFile(filePath(root, scopeId, otherKey), '{"v":1}', "utf8");
  assertEqual(await cache.lookup(scopeId, otherKey), undefined, "JSON missing value is undefined");

  const nullKey = workflowCacheKey("null-value", { model: "m" });
  assertEqual(await cache.store(scopeId, nullKey, null), "stored", "null value stores");
  assertDeepEqual(await cache.lookup(scopeId, nullKey), { value: null }, "stored null is a hit, not a miss");
});

await run("value UTF-8 over 256KiB is skipped and does not write", async () => {
  const root = await makeRoot();
  const cache = new WorkflowChildCache({ rootDir: root });
  const scopeId = workflowCacheScopeId("ws-1", "sess-1", "audit");
  const overKey = workflowCacheKey("over", { model: "m" });
  const exactKey = workflowCacheKey("exact", { model: "m" });

  // JSON.stringify of a string is length+2 (quotes). Repeat so payload is cap+1.
  const over = "x".repeat(MAX_VALUE_BYTES - 1);
  assert(Buffer.byteLength(JSON.stringify(over), "utf8") === MAX_VALUE_BYTES + 1, "over fixture is cap+1");
  assertEqual(await cache.store(scopeId, overKey, over), "skipped", "oversize returns skipped");
  assertEqual(await cache.lookup(scopeId, overKey), undefined, "oversize is a miss");
  const overEntries = await readdir(join(root, scopeId, "children")).catch(() => [] as string[]);
  assertDeepEqual(overEntries, [], "oversize does not write a file");

  const exact = "y".repeat(MAX_VALUE_BYTES - 2);
  assert(Buffer.byteLength(JSON.stringify(exact), "utf8") === MAX_VALUE_BYTES, "exact fixture is cap");
  assertEqual(await cache.store(scopeId, exactKey, exact), "stored", "exactly 256KiB stores");
  assertDeepEqual(await cache.lookup(scopeId, exactKey), { value: exact }, "exactly 256KiB round-trips");
});

await run("concurrent different keys are independent", async () => {
  const root = await makeRoot();
  const cache = new WorkflowChildCache({ rootDir: root });
  const scopeId = workflowCacheScopeId("ws-1", "sess-1", "audit");
  const items = Array.from({ length: 10 }, (_, i) => ({
    key: workflowCacheKey(`prompt-${i}`, { model: "m", maxTurns: i }),
    value: { i, text: `child-${i}` },
  }));

  const results = await Promise.all(items.map((item) => cache.store(scopeId, item.key, item.value)));
  assert(
    results.every((r) => r === "stored"),
    "all 10 concurrent stores return stored",
  );

  const looked = await Promise.all(items.map((item) => cache.lookup(scopeId, item.key)));
  for (let i = 0; i < items.length; i++) {
    assertDeepEqual(looked[i], { value: items[i]?.value }, `key ${i} round-trips after concurrent store`);
  }

  const names = (await readdir(join(root, scopeId, "children"))).filter((name) => name.endsWith(".json")).sort();
  const expected = items.map((item) => `${item.key}.json`).sort();
  assertDeepEqual(names, expected, "ten json files, no leftover tmp");
});

// ============================================================================

async function cleanup(): Promise<void> {
  for (const dir of roots) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

await cleanup();

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
