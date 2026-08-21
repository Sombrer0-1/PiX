/**
 * validateMeta tests (S1).
 *
 * Independently verifies pix/src/main/workflow/engine/meta.ts: valid meta
 * normalizes into a fresh copy (never aliasing the caller's object, only
 * whitelisted keys, optional fields preserved), and invalid meta throws
 * WorkflowError with code META_INVALID whose message enumerates EVERY
 * violation (the plan's example `{ name: "", description: "x", extra: 1 }`
 * yields "invalid meta: name must be a non-empty string; unexpected key
 * extra"). Does not depend on the worker, host or any other workflow module.
 *
 * Run with: npm exec tsx -- src/main/__tests__/workflow-meta.test.ts
 */

import { validateMeta } from "../workflow/engine/meta.js";
import { WorkflowError } from "../workflow/engine/engine.js";
import type { WorkflowMeta } from "../../shared/workflow-types.js";

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

const NO_THROW = Symbol("no-throw");

/** Run fn and return the thrown value, or NO_THROW when it did not throw. */
function capture(fn: () => void): unknown {
  try {
    fn();
    return NO_THROW;
  } catch (error) {
    return error;
  }
}

// ============================================================================
// Tests
// ============================================================================

await run("valid minimal meta normalizes", async () => {
  const out = validateMeta({ name: "audit", description: "Audit packages" });
  assertEqual(typeof out, "object", "returns an object");
  assertEqual(out.name, "audit", "name preserved");
  assertEqual(out.description, "Audit packages", "description preserved");
  assert(!("whenToUse" in out), "absent whenToUse stays absent");
  assert(!("phases" in out), "absent phases stays absent");
});

await run("valid full meta normalizes and preserves optional fields", async () => {
  const out = validateMeta({
    name: "audit",
    description: "Audit packages",
    whenToUse: "multi-file audits",
    phases: [
      { title: "scan", detail: "list packages" },
      { title: "deep", provider: "general-purpose", model: "claude" },
    ],
  });
  assertEqual(out.whenToUse, "multi-file audits", "whenToUse preserved");
  assertEqual(out.phases?.length, 2, "phases preserved");
  assertEqual(out.phases?.[0].title, "scan", "phase title preserved");
  assertEqual(out.phases?.[0].detail, "list packages", "phase detail preserved");
  assertEqual(out.phases?.[1].provider, "general-purpose", "phase provider preserved");
  assertEqual(out.phases?.[1].model, "claude", "phase model preserved");
  assertEqual(out.phases?.[1].detail, undefined, "absent phase detail stays absent");
});

await run("validateMeta returns a normalized copy, never aliasing the caller", async () => {
  const input: WorkflowMeta = {
    name: "audit",
    description: "Audit packages",
    phases: [{ title: "scan", detail: "list packages" }],
  };
  const out = validateMeta(input);
  assert(out !== input, "returned meta is not the caller's object");
  assert(out.phases !== undefined && out.phases !== input.phases, "phases array is copied");
  assert(
    out.phases !== undefined && out.phases[0] !== input.phases?.[0],
    "phase entries are copied",
  );

  input.phases![0].title = "mutated";
  assertEqual(out.phases![0].title, "scan", "caller mutation does not leak into the copy");

  const again = validateMeta(input);
  assert(again !== out, "each call returns a fresh object");
});

await run("plan example: invalid meta names every violation", async () => {
  const error = capture(() => validateMeta({ name: "", description: "x", extra: 1 }));
  assert(error !== NO_THROW, "validateMeta throws on invalid meta");
  assert(error instanceof WorkflowError, "thrown value is a WorkflowError");
  if (error instanceof WorkflowError) {
    assertEqual(error.code, "META_INVALID", "code is META_INVALID");
    assertEqual(
      error.message,
      "invalid meta: name must be a non-empty string; unexpected key extra",
      "message matches the plan example exactly",
    );
  }
});

await run("multiple violations are all enumerated, joined by '; '", async () => {
  const error = capture(() => validateMeta({ name: 5, description: "", whenToUse: 7, phases: "x", extra: 1 }));
  assert(error instanceof WorkflowError, "throws a WorkflowError");
  if (error instanceof WorkflowError) {
    assert(error.message.startsWith("invalid meta: "), "message has the invalid meta prefix");
    const parts = error.message.slice("invalid meta: ".length).split("; ");
    assertEqual(parts.length, 5, "all 5 violations enumerated");
    for (const expected of [
      "name must be a non-empty string",
      "description must be a non-empty string",
      "whenToUse must be a string",
      "phases must be an array",
      "unexpected key extra",
    ]) {
      assert(error.message.includes(expected), `message includes "${expected}"`);
    }
  }
});

await run("non-object meta is rejected", async () => {
  for (const bad of [null, undefined, "audit", 42, [], true]) {
    const error = capture(() => validateMeta(bad));
    assert(error instanceof WorkflowError, `meta ${JSON.stringify(bad)} throws`);
    if (error instanceof WorkflowError) {
      assertEqual(error.code, "META_INVALID", `code is META_INVALID for ${JSON.stringify(bad)}`);
      assert(error.message.includes("meta must be an object"), "message names the object requirement");
    }
  }
});

await run("name/description/whenToUse shape violations are named", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ description: "x" }, "name must be a non-empty string"],
    [{ name: 5, description: "x" }, "name must be a non-empty string"],
    [{ name: "a" }, "description must be a non-empty string"],
    [{ name: "a", description: [] }, "description must be a non-empty string"],
    [{ name: "a", description: "x", whenToUse: 5 }, "whenToUse must be a string"],
  ];
  for (const [meta, expected] of cases) {
    const error = capture(() => validateMeta(meta));
    assert(error instanceof WorkflowError, `meta ${JSON.stringify(meta)} throws`);
    if (error instanceof WorkflowError) {
      assert(error.message.includes(expected), `message includes "${expected}"`);
    }
  }
});

await run("phases entry violations are all enumerated", async () => {
  const error = capture(() =>
    validateMeta({
      name: "n",
      description: "d",
      phases: [{ title: "" }, 5, { title: "ok", detail: 1, provider: 2, model: 3, extra: true }],
    }),
  );
  assert(error instanceof WorkflowError, "throws a WorkflowError");
  if (error instanceof WorkflowError) {
    const parts = error.message.slice("invalid meta: ".length).split("; ");
    assertEqual(parts.length, 6, "all 6 phase violations enumerated");
    for (const expected of [
      "phases[0].title must be a non-empty string",
      "phases[1] must be an object",
      "phases[2]: unexpected key extra",
      "phases[2].detail must be a string",
      "phases[2].provider must be a string",
      "phases[2].model must be a string",
    ]) {
      assert(error.message.includes(expected), `message includes "${expected}"`);
    }
  }
});

await run("phases non-array and nested non-object entries are named", async () => {
  const notArray = capture(() => validateMeta({ name: "n", description: "d", phases: { title: "x" } }));
  assert(notArray instanceof WorkflowError, "phases object throws");
  if (notArray instanceof WorkflowError) {
    assert(notArray.message.includes("phases must be an array"), "message names phases array requirement");
  }

  const nullEntry = capture(() => validateMeta({ name: "n", description: "d", phases: [null] }));
  assert(nullEntry instanceof WorkflowError, "null phase entry throws");
  if (nullEntry instanceof WorkflowError) {
    assert(nullEntry.message.includes("phases[0] must be an object"), "message names the entry index");
  }

  const stringEntry = capture(() => validateMeta({ name: "n", description: "d", phases: ["scan"] }));
  assert(stringEntry instanceof WorkflowError, "string phase entry throws");
  if (stringEntry instanceof WorkflowError) {
    assert(stringEntry.message.includes("phases[0] must be an object"), "message names the entry index");
  }
});

await run("whitelist: unexpected top-level and phase keys are rejected", async () => {
  const top = capture(() => validateMeta({ name: "n", description: "d", icon: "x" }));
  assert(top instanceof WorkflowError, "unknown top-level key throws");
  if (top instanceof WorkflowError) {
    assert(top.message.includes("unexpected key icon"), "message names the unknown key");
  }

  const phase = capture(() =>
    validateMeta({ name: "n", description: "d", phases: [{ title: "t", color: "red" }] }),
  );
  assert(phase instanceof WorkflowError, "unknown phase key throws");
  if (phase instanceof WorkflowError) {
    assert(phase.message.includes("phases[0]: unexpected key color"), "message names the phase key");
  }
});

await run("valid meta survives unknown keys ONLY when they are not violations", async () => {
  // Sanity: an entirely valid meta round-trips without touching unknown keys.
  const out = validateMeta({ name: "a", description: "b" });
  assertEqual(JSON.stringify(out), JSON.stringify({ name: "a", description: "b" }), "exact whitelisted projection");
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
