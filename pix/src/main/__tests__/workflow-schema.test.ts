/**
 * ObjectJsonSchema subset gate tests (S1).
 *
 * Independently verifies pix/src/main/workflow/engine/schema.ts: the
 * assertObjectJsonSchema gate accepts only object-rooted schemas built from
 * the locked key set (type/properties/required/additionalProperties/items/
 * enum/const/oneOf), recurses through properties / items /
 * additionalProperties, leaves enum/const/oneOf values unvalidated, and
 * throws WorkflowError with code UNSUPPORTED_SCHEMA (fatal by default) on
 * the first violation, with a message naming the offending path. Does not
 * depend on the worker, host or any other workflow module.
 *
 * Run with: npm exec tsx -- src/main/__tests__/workflow-schema.test.ts
 */

import { assertObjectJsonSchema } from "../workflow/engine/schema.js";
import { WorkflowError } from "../workflow/engine/engine.js";
import { createStructuredOutputTool, salvageStructuredFromText } from "../workflow/structured-output-tool.js";

// ============================================================================
// Test harness (matches plan-types.test.ts style)
// ============================================================================

let passed = 0;
let failed = 0;

function accepts(schema: unknown, message: string): void {
  try {
    assertObjectJsonSchema(schema);
    passed++;
    console.log(`  PASS: ${message}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${message} - threw ${String(error)}`);
  }
}

function rejects(schema: unknown, message: string): void {
  try {
    assertObjectJsonSchema(schema);
    failed++;
    console.error(`  FAIL: ${message} - unexpectedly accepted`);
  } catch (error) {
    if (error instanceof WorkflowError && error.code === "UNSUPPORTED_SCHEMA") {
      passed++;
      console.log(`  PASS: ${message}`);
    } else {
      failed++;
      console.error(
        `  FAIL: ${message} - expected WorkflowError UNSUPPORTED_SCHEMA, got ${String(error)}`,
      );
    }
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
// Tests
// ============================================================================

await run("accepts the minimal object-rooted schema", async () => {
  accepts({ type: "object" }, "empty object schema accepted");
});

await run("accepts a full schema within the subset", async () => {
  accepts(
    {
      type: "object",
      properties: {
        name: { type: "object" },
        age: {
          type: "object",
          properties: { value: { type: "object" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
      required: ["name"],
      additionalProperties: true,
      items: { type: "object" },
      enum: [1, "a", null, { deep: [true] }],
      const: { anything: [1, 2] },
      oneOf: ["unvalidated", { opaque: 5 }],
    },
    "full subset schema accepted",
  );
  accepts(
    { type: "object", items: [{ type: "object" }, { type: "object" }] },
    "items as an array of schemas accepted",
  );
  accepts(
    { type: "object", additionalProperties: { type: "object", properties: { x: { type: "object" } } } },
    "additionalProperties as a nested schema accepted",
  );
  accepts(
    { type: "object", required: [] },
    "empty required array accepted",
  );
});

await run("rejects non-object roots", async () => {
  for (const bad of [null, undefined, "object", 42, [], true]) {
    rejects(bad, `root ${JSON.stringify(bad)} rejected`);
  }
});

await run("rejects a missing or wrong type", async () => {
  rejects({ properties: {} }, "missing type rejected");
  rejects({ type: "string" }, "non-object type rejected at the root");
  rejects({ type: "array" }, "array type rejected at the root");
});

await run("accepts nested string and array nodes (ralph reportSchema subset)", async () => {
  accepts(
    {
      type: "object",
      properties: {
        status: { type: "string", enum: ["continue", "complete", "blocked"] },
        summary: { type: "string" },
        evidence: { type: "array", items: { type: "string" } },
        nextSteps: { type: "array", items: { type: "string" } },
        blocker: { type: "string" },
      },
      required: ["status", "summary", "evidence", "nextSteps", "blocker"],
      additionalProperties: false,
    },
    "ralph-shaped reportSchema accepted",
  );
  accepts(
    {
      type: "object",
      properties: {
        n: { type: "number" },
        i: { type: "integer" },
        ok: { type: "boolean" },
      },
    },
    "nested number/integer/boolean types accepted",
  );
  rejects(
    { type: "object", properties: { n: { type: "null" } } },
    "nested null type rejected",
  );
});

await run("rejects keys outside the subset", async () => {
  rejects({ type: "object", title: "x" }, "title rejected at root");
  rejects({ type: "object", anyOf: [] }, "anyOf rejected at root");
  rejects({ type: "object", properties: { x: { type: "object", title: "y" } } }, "title rejected nested");
  rejects({ type: "object", items: { type: "object", minimum: 0 } }, "minimum rejected in items");
  rejects(
    { type: "object", additionalProperties: { type: "object", anyOf: [] } },
    "anyOf rejected in additionalProperties",
  );
});

await run("rejects malformed structural fields", async () => {
  rejects({ type: "object", properties: [] }, "properties array rejected");
  rejects({ type: "object", properties: "x" }, "properties string rejected");
  rejects({ type: "object", properties: { a: 5 } }, "non-schema property value rejected");
  rejects({ type: "object", properties: { a: { type: "object" }, b: null } }, "null property value rejected");
  rejects({ type: "object", required: "name" }, "required string rejected");
  rejects({ type: "object", required: [1] }, "non-string required item rejected");
  rejects({ type: "object", additionalProperties: "yes" }, "string additionalProperties rejected");
  rejects({ type: "object", additionalProperties: 5 }, "numeric additionalProperties rejected");
  rejects({ type: "object", items: "x" }, "string items rejected");
  rejects({ type: "object", items: [{ type: "object" }, 5] }, "non-schema array item rejected");
});

await run("violation messages name the offending path", async () => {
  const cases: Array<[unknown, string]> = [
    [{ type: "object", title: "x" }, "schema: key \"title\""],
    [{ type: "object", properties: { a: { type: "object", title: "x" } } }, "schema.properties.a: key \"title\""],
    [{ type: "object", properties: { a: 5 } }, "schema.properties.a must be an object"],
    [{ type: "object", items: [{ type: "object" }, 5] }, "schema.items[1] must be an object"],
    [{ type: "object", additionalProperties: { type: "object", anyOf: [] } }, "schema.additionalProperties: key \"anyOf\""],
    [{ type: "string" }, "schema.type must be \"object\""],
    [{ type: "object", required: [1] }, "schema.required must be an array of strings"],
  ];
  for (const [schema, expected] of cases) {
    try {
      assertObjectJsonSchema(schema);
      failed++;
      console.error(`  FAIL: ${JSON.stringify(schema)} - unexpectedly accepted`);
    } catch (error) {
      if (error instanceof WorkflowError && error.code === "UNSUPPORTED_SCHEMA") {
        if (error.message.includes(expected)) {
          passed++;
          console.log(`  PASS: message names "${expected}"`);
        } else {
          failed++;
          console.error(`  FAIL: message "${error.message}" does not include "${expected}"`);
        }
      } else {
        failed++;
        console.error(`  FAIL: expected WorkflowError UNSUPPORTED_SCHEMA, got ${String(error)}`);
      }
    }
  }
});

await run("UNSUPPORTED_SCHEMA is a default-fatal WorkflowError", async () => {
  let caught: unknown;
  try {
    assertObjectJsonSchema({ type: "object", effort: "high" });
  } catch (error) {
    caught = error;
  }
  if (caught instanceof WorkflowError) {
    assert(caught.code === "UNSUPPORTED_SCHEMA", `code is UNSUPPORTED_SCHEMA, got ${caught.code}`);
    assert(caught.fatal, "misuse options stay fatal");
  } else {
    assert(false, `expected WorkflowError, got ${String(caught)}`);
  }
});

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

// ============================================================================
// Capture validator (layer 2): required-field semantics
// ============================================================================

await run("capture: ralph-shaped string/array values validate; wrong types are rejected", async () => {
  const tool = createStructuredOutputTool({
    type: "object",
    properties: {
      status: { type: "string", enum: ["continue", "complete", "blocked"] },
      summary: { type: "string" },
      evidence: { type: "array", items: { type: "string" } },
      nextSteps: { type: "array", items: { type: "string" } },
      blocker: { type: "string" },
    },
    required: ["status", "summary", "evidence", "nextSteps", "blocker"],
    additionalProperties: false,
  });
  const valid = {
    status: "complete",
    summary: "done",
    evidence: ["a"],
    nextSteps: ["b"],
    blocker: "none",
  };
  const ok = await tool.execute("ralph-ok", valid as never);
  const okText = (ok.content[0] as { text: string }).text;
  if (okText.includes("Structured result submitted.") && (ok.details as { structured?: unknown }).structured !== undefined) {
    passed++;
    console.log("  PASS: ralph-shaped object is accepted");
  } else {
    failed++;
    console.error(`  FAIL: ralph-shaped object is accepted - got ${okText}`);
  }

  if (
    tool.description.includes('"status"') &&
    tool.description.includes('"evidence"') &&
    Array.isArray(tool.promptGuidelines) &&
    tool.promptGuidelines.some((line) => line.includes("MUST call submit_workflow_result"))
  ) {
    passed++;
    console.log("  PASS: tool description and guidelines advertise the schema and completion contract");
  } else {
    failed++;
    console.error("  FAIL: tool description and guidelines advertise the schema and completion contract");
  }

  const advertised = tool.parameters as { properties?: Record<string, unknown> };
  if (advertised.properties !== undefined && advertised.properties.status !== undefined) {
    passed++;
    console.log("  PASS: tool parameters advertise nested schema properties to the model");
  } else {
    failed++;
    console.error(`  FAIL: tool parameters advertise nested schema properties - got ${JSON.stringify(advertised.properties)}`);
  }

  const bad = await tool.execute("ralph-bad", {
    status: "complete",
    summary: "done",
    evidence: "not-an-array",
    nextSteps: [],
    blocker: "none",
  } as never);
  const badText = (bad.content[0] as { text: string }).text;
  if (badText.includes("must be an array")) {
    passed++;
    console.log("  PASS: non-array evidence is rejected");
  } else {
    failed++;
    console.error(`  FAIL: non-array evidence is rejected - got ${badText}`);
  }
});

await run("capture: required uses own properties, never the prototype chain", async () => {
  const tool = createStructuredOutputTool({
    type: "object",
    properties: { name: { type: "object" } },
    required: ["name", "toString"],
    additionalProperties: false,
  });
  // "toString" lives on Object.prototype: an `in`-based check would accept
  // this submission without the field being present.
  const result = await tool.execute("call_1", { name: {} } as never);
  const text = (result.content[0] as { text: string }).text;
  if (text.includes("missing the required field") && text.includes("toString")) {
    passed++;
    console.log("  PASS: prototype member cannot masquerade as a required field");
  } else {
    failed++;
    console.error(`  FAIL: prototype member cannot masquerade as a required field - got ${text}`);
  }

  // Same flaw class on the schema side: a submitted extra field named like a
  // prototype member of `properties` must still be rejected under
  // additionalProperties:false.
  const strictTool = createStructuredOutputTool({
    type: "object",
    properties: { name: { type: "object" } },
    required: ["name"],
    additionalProperties: false,
  });
  const strictResult = await strictTool.execute("call_2", { name: {}, toString: "x" } as never);
  const strictText = (strictResult.content[0] as { text: string }).text;
  if (strictText.includes("unexpected field") && strictText.includes("toString")) {
    passed++;
    console.log("  PASS: additionalProperties:false rejects prototype-named extra fields");
  } else {
    failed++;
    console.error(`  FAIL: additionalProperties:false rejects prototype-named extra fields - got ${strictText}`);
  }
});

await run("capture: nested number/integer/boolean values validate", async () => {
  const tool = createStructuredOutputTool({
    type: "object",
    properties: {
      n: { type: "number" },
      i: { type: "integer" },
      ok: { type: "boolean" },
    },
    required: ["n", "i", "ok"],
    additionalProperties: false,
  });
  const ok = await tool.execute("num-ok", { n: 1.5, i: 2, ok: true } as never);
  const okText = (ok.content[0] as { text: string }).text;
  if (okText.includes("Structured result submitted.")) {
    passed++;
    console.log("  PASS: number/integer/boolean object is accepted");
  } else {
    failed++;
    console.error(`  FAIL: number/integer/boolean object is accepted - got ${okText}`);
  }

  const nan = await tool.execute("num-nan", { n: Number.NaN, i: 2, ok: true } as never);
  const nanText = (nan.content[0] as { text: string }).text;
  if (nanText.includes("finite number")) {
    passed++;
    console.log("  PASS: NaN is rejected as a number");
  } else {
    failed++;
    console.error(`  FAIL: NaN is rejected as a number - got ${nanText}`);
  }

  const frac = await tool.execute("num-frac", { n: 1, i: 1.5, ok: true } as never);
  const fracText = (frac.content[0] as { text: string }).text;
  if (fracText.includes("must be an integer")) {
    passed++;
    console.log("  PASS: fractional integer is rejected");
  } else {
    failed++;
    console.error(`  FAIL: fractional integer is rejected - got ${fracText}`);
  }

  const bool = await tool.execute("num-bool", { n: 1, i: 2, ok: "yes" } as never);
  const boolText = (bool.content[0] as { text: string }).text;
  if (boolText.includes("must be a boolean")) {
    passed++;
    console.log("  PASS: string boolean is rejected");
  } else {
    failed++;
    console.error(`  FAIL: string boolean is rejected - got ${boolText}`);
  }
});

await run("salvage: schema-valid JSON text (raw, fenced, or wrapped) is accepted", async () => {
  const schema = {
    type: "object" as const,
    properties: { status: { type: "string" as const } },
    required: ["status"],
    additionalProperties: false,
  };
  const expected = { status: "ok" };
  const cases: Array<[string, string]> = [
    [JSON.stringify(expected), "raw JSON"],
    ["```json\n" + JSON.stringify(expected) + "\n```", "fenced JSON"],
    ["here is the result:\n" + JSON.stringify(expected) + "\n", "JSON wrapped in prose"],
  ];
  for (const [text, label] of cases) {
    const salvaged = salvageStructuredFromText(schema, text);
    if (JSON.stringify(salvaged) === JSON.stringify(expected)) {
      passed++;
      console.log(`  PASS: salvage accepts ${label}`);
    } else {
      failed++;
      console.error(`  FAIL: salvage accepts ${label} - got ${JSON.stringify(salvaged)}`);
    }
  }
  const rejected = salvageStructuredFromText(schema, "work done, no submit");
  if (rejected === undefined) {
    passed++;
    console.log("  PASS: salvage rejects non-JSON prose");
  } else {
    failed++;
    console.error(`  FAIL: salvage rejects non-JSON prose - got ${JSON.stringify(rejected)}`);
  }
  const extra = salvageStructuredFromText(schema, JSON.stringify({ status: "ok", extra: 1 }));
  if (extra === undefined) {
    passed++;
    console.log("  PASS: salvage rejects schema-invalid JSON");
  } else {
    failed++;
    console.error(`  FAIL: salvage rejects schema-invalid JSON - got ${JSON.stringify(extra)}`);
  }
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
