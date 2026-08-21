/**
 * materializeFromRealm / renderThrown / MaterializeError tests (S1).
 *
 * Independently verifies pix/src/main/workflow/engine/realm.ts against the
 * locked rejection list: root undefined returns as-is; non-finite numbers,
 * bigint, function, symbol, nested undefined, circular references, sparse
 * arrays, non-index array properties, symbol keys and exotic prototypes all
 * throw MaterializeError with the offending path; `__proto__` keys are
 * written as own data properties via defineProperty (no prototype
 * pollution); getters run normally and throwing reads wrap into
 * MaterializeError with a rendered reason; renderThrown is total (stack >
 * message > String > fixed label). Does not depend on any other module.
 *
 * Run with: npm exec tsx -- src/main/__tests__/workflow-realm.test.ts
 */

import { MaterializeError, materializeFromRealm, renderThrown } from "../workflow/engine/realm.js";

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
function capture(fn: () => unknown): unknown {
  try {
    fn();
    return NO_THROW;
  } catch (error) {
    return error;
  }
}

/** Assert materializeFromRealm(value) throws MaterializeError with a path fragment. */
function rejectsMaterialize(value: unknown, message: string, pathPart?: string): void {
  const error = capture(() => materializeFromRealm(value));
  if (error instanceof MaterializeError) {
    assert(true, `${message} (at ${error.path}: ${error.reason})`);
    if (pathPart !== undefined) {
      assert(
        error.path.includes(pathPart),
        `${message} - error path "${error.path}" includes "${pathPart}"`,
      );
    }
  } else {
    assert(false, `${message} - expected MaterializeError, got ${String(error)}`);
  }
}

// ============================================================================
// Tests
// ============================================================================

await run("root undefined returns as-is", async () => {
  assertEqual(materializeFromRealm(undefined), undefined, "root undefined returned unchanged");
});

await run("scalars pass through unchanged", async () => {
  assertEqual(materializeFromRealm(null), null, "null passes");
  assertEqual(materializeFromRealm(true), true, "true passes");
  assertEqual(materializeFromRealm(false), false, "false passes");
  assertEqual(materializeFromRealm("text"), "text", "string passes");
  assertEqual(materializeFromRealm(0), 0, "zero passes");
  assertEqual(materializeFromRealm(-1.5), -1.5, "fractional number passes");
  assertEqual(materializeFromRealm(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER, "max safe integer passes");
});

await run("plain data materializes into a deep host copy", async () => {
  const input = { a: 1, b: "x", c: { d: [1, 2, null] }, e: [true, { f: "g" }] };
  const out = materializeFromRealm(input);
  assertEqual(JSON.stringify(out), JSON.stringify(input), "deep value equal");
  assert(out !== input, "root object is a copy");
  const record = out as { c: unknown; e: unknown };
  assert(record.c !== input.c, "nested object is a copy");
  assert(record.e !== input.e, "nested array is a copy");
});

await run("shared (non-cyclic) references materialize", async () => {
  const shared = { v: 1 };
  const out = materializeFromRealm({ a: shared, b: shared }) as { a: { v: number }; b: { v: number } };
  assertEqual(out.a.v, 1, "first branch materializes");
  assertEqual(out.b.v, 1, "second branch materializes");
});

await run("object with a null prototype materializes", async () => {
  const out = materializeFromRealm(Object.create(null)) as Record<string, never>;
  assertEqual(Object.keys(out).length, 0, "Object.create(null) has a plain prototype and passes");
});

await run("non-finite numbers are rejected", async () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    rejectsMaterialize(bad, `${String(bad)} rejected`, "value");
  }
  rejectsMaterialize({ a: NaN }, "nested NaN rejected", "value.a");
});

await run("bigint / function / symbol / nested undefined are rejected", async () => {
  rejectsMaterialize(1n, "bigint rejected", "value");
  rejectsMaterialize(() => 1, "function rejected", "value");
  rejectsMaterialize(Symbol("x"), "symbol rejected", "value");
  rejectsMaterialize({ a: { b: undefined } }, "nested undefined rejected", "value.a.b");
  rejectsMaterialize([1, undefined], "undefined array element rejected", "value[1]");
});

await run("circular references are rejected", async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  rejectsMaterialize(cyclic, "direct cycle rejected", "value.self");

  const a: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  a.next = b;
  b.back = a;
  rejectsMaterialize(a, "two-node cycle rejected", "value.next.back");

  const array: unknown[] = [];
  array.push(array);
  rejectsMaterialize(array, "array cycle rejected", "value[0]");
});

await run("sparse arrays are rejected", async () => {
  const sparse = new Array(3);
  sparse[1] = "x";
  rejectsMaterialize(sparse, "hole at index 0 rejected", "value[0]");
});

await run("non-index own enumerable properties on arrays are rejected", async () => {
  const arr = [1, 2];
  (arr as unknown as { total: number }).total = 3;
  rejectsMaterialize(arr, "extra string key rejected", "value.total");

  const floatKey = [1];
  (floatKey as unknown as Record<string, unknown>)["0.5"] = 1;
  rejectsMaterialize(floatKey, "non-integer numeric key rejected", "value.0.5");
});

await run("non-canonical numeric string keys on arrays are rejected", async () => {
  // Number("01") === 1 is in range for a length-2 array, but "01" is not a
  // canonical array index: JSON.stringify would silently drop the property.
  const zeroOne = [1, 2];
  (zeroOne as unknown as Record<string, unknown>)["01"] = "x";
  rejectsMaterialize(zeroOne, "non-canonical index '01' rejected", "value.01");

  const expForm = [1, 2];
  (expForm as unknown as Record<string, unknown>)["1e0"] = "x";
  rejectsMaterialize(expForm, "non-canonical index '1e0' rejected", "value.1e0");

  const hexForm = [1, 2];
  (hexForm as unknown as Record<string, unknown>)["0x1"] = "x";
  rejectsMaterialize(hexForm, "non-canonical index '0x1' rejected", "value.0x1");

  // Canonical indices still pass.
  assertEqual(JSON.stringify(materializeFromRealm(["a", "b"])), '["a","b"]', "canonical indices accepted");
});

await run("symbol keys are rejected on objects and arrays", async () => {
  rejectsMaterialize({ [Symbol("k")]: 1 }, "symbol key on object rejected", "value");
  const arr: unknown[] = [1];
  (arr as unknown as Record<symbol, unknown>)[Symbol("k")] = 1;
  rejectsMaterialize(arr, "symbol key on array rejected", "value");
});

await run("exotic prototypes are rejected", async () => {
  rejectsMaterialize(new Date(), "Date rejected", "value");
  rejectsMaterialize(new Map(), "Map rejected", "value");
  rejectsMaterialize(new Set(), "Set rejected", "value");
  class Example {
    x = 1;
  }
  rejectsMaterialize(new Example(), "class instance rejected", "value");
  rejectsMaterialize({ nested: new Date() }, "nested Date rejected", "value.nested");
});

await run("__proto__ key is copied as an own data property, never a prototype mutation", async () => {
  const source: Record<string, unknown> = {};
  Object.defineProperty(source, "__proto__", {
    value: { polluted: true },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  source.keep = "yes";

  const out = materializeFromRealm(source) as Record<string, unknown>;
  assert(
    Object.prototype.hasOwnProperty.call(out, "__proto__"),
    "__proto__ becomes an own property of the copy",
  );
  assert(
    (out["__proto__"] as Record<string, unknown> | undefined)?.polluted === true,
    "__proto__ value copied as data",
  );
  assert(Object.getPrototypeOf(out) === Object.prototype, "copy prototype is unchanged");
  assert(
    !Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"),
    "Object.prototype is not polluted",
  );
  assertEqual(out.keep, "yes", "sibling keys still copy");
});

await run("getters run normally; throwing reads wrap into MaterializeError", async () => {
  const getter = { get answer() { return 42; } };
  assertEqual((materializeFromRealm(getter) as Record<string, unknown>).answer, 42, "working getter value materializes");

  const throwing = {
    get boom(): never {
      throw new Error("kaboom");
    },
  };
  const error = capture(() => materializeFromRealm(throwing));
  if (error instanceof MaterializeError) {
    assert(error.reason.startsWith("reading the value threw: "), "reason has the reading-the-value prefix");
    assert(error.reason.includes("kaboom"), "reason contains the original error text");
  } else {
    assert(false, `expected MaterializeError, got ${String(error)}`);
  }
});

await run("MaterializeError carries path and reason", async () => {
  const error = capture(() => materializeFromRealm({ a: 1n }));
  if (error instanceof MaterializeError) {
    assertEqual(error.path, "value.a", "path is value.a");
    assert(error.reason.includes("bigint"), "reason names the problem");
    assertEqual(error.message, `${error.path}: ${error.reason}`, "message is path + reason");
    assertEqual(error.name, "MaterializeError", "name is MaterializeError");
  } else {
    assert(false, `expected MaterializeError, got ${String(error)}`);
  }
});

await run("renderThrown prefers stack, then message, then String", async () => {
  const err = new Error("boom");
  assert(renderThrown(err).startsWith("Error: boom"), "stack preferred over message");

  assertEqual(renderThrown({ message: "boom" }), "boom", "message used when no stack");
  assertEqual(renderThrown(42), "42", "String fallback for numbers");
  assertEqual(renderThrown(null), "null", "String fallback for null");
  assertEqual(renderThrown(undefined), "undefined", "String fallback for undefined");
  assertEqual(renderThrown(Symbol("x")), "Symbol(x)", "String fallback for symbols");
});

await run("renderThrown is total: throwing accessors fall back to the fixed label", async () => {
  const hostile = {
    get stack(): never {
      throw new Error("stack accessor threw");
    },
    get message(): never {
      throw new Error("message accessor threw");
    },
  };
  assertEqual(renderThrown(hostile), "[unrenderable thrown value]", "fixed label returned");
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
