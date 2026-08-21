/**
 * Shared subagent contract tests (S1).
 *
 * Independently verifies the pix/src/shared/subagent-types.ts type guard
 * (missing/wrong schemaVersion, wrong enums, NaN/negative numbers, totalTokens
 * consistency, over-limit arrays/summary/error/output), the error-schema
 * (status invariant) rejection, usage aggregation and numeric boundaries. Does
 * not depend on the runner or core implementation, so S1 runs standalone.
 *
 * Run with: npx tsx src/main/__tests__/subagent-types.test.ts
 */

import {
  SUBAGENT_DETAILS_SCHEMA_VERSION,
  SUBAGENT_MAX_RESULTS,
  SUBAGENT_MAX_FINAL_OUTPUT_BYTES,
  SUBAGENT_MAX_RECENT_ACTIVITIES,
  SUBAGENT_MAX_ACTIVITY_SUMMARY_CHARS,
  SUBAGENT_MAX_ERROR_MESSAGE_BYTES,
  aggregateSubagentUsage,
  isSubagentDetails,
  type SubagentDetails,
} from "../../shared/subagent-types.js";

// ============================================================================
// Test harness (matches execution-context.test.ts style)
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

// ============================================================================
// Fixture helpers (return unknown so malformed variants are easy to build)
// ============================================================================

const STARTED = 1_770_000_000_000;
const ENDED = 1_770_000_000_420;

function makeUsageInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    input: 10,
    output: 20,
    cacheRead: 3,
    cacheWrite: 2,
    totalTokens: 35,
    cost: 0.0012,
    turns: 1,
    ...overrides,
  };
}

function makeResultInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "run-task-1",
    index: 0,
    agentName: "scout",
    agentSource: "user",
    description: "Locate auth entry points",
    status: "completed",
    finalOutput: "auth entry points: src/auth.ts",
    outputTruncated: false,
    originalOutputBytes: 32,
    toolUseCount: 1,
    activities: [],
    usage: makeUsageInput(),
    model: "provider/model-id",
    startedAt: STARTED,
    endedAt: ENDED,
    durationMs: 420,
    ...overrides,
  };
}

function makeActivityInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    sequence: 1,
    toolCallId: "nested-tool-1",
    toolName: "grep",
    status: "completed",
    summary: "authentication",
    startedAt: STARTED,
    endedAt: ENDED,
    ...overrides,
  };
}

function makeDetailsInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: SUBAGENT_DETAILS_SCHEMA_VERSION,
    mode: "single",
    agentScope: "user",
    results: [makeResultInput()],
    startedAt: STARTED,
    updatedAt: ENDED,
    durationMs: 420,
    ...overrides,
  };
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ============================================================================
// Tests
// ============================================================================

await run("contract constants match the locked values", async () => {
  assertEqual(SUBAGENT_DETAILS_SCHEMA_VERSION, 1, "SUBAGENT_DETAILS_SCHEMA_VERSION === 1");
  assertEqual(SUBAGENT_MAX_RESULTS, 8, "SUBAGENT_MAX_RESULTS === 8");
  assertEqual(SUBAGENT_MAX_FINAL_OUTPUT_BYTES, 48 * 1024, "SUBAGENT_MAX_FINAL_OUTPUT_BYTES === 48 KiB");
  assertEqual(SUBAGENT_MAX_RECENT_ACTIVITIES, 20, "SUBAGENT_MAX_RECENT_ACTIVITIES === 20");
  assertEqual(SUBAGENT_MAX_ACTIVITY_SUMMARY_CHARS, 160, "SUBAGENT_MAX_ACTIVITY_SUMMARY_CHARS === 160");
  assertEqual(SUBAGENT_MAX_ERROR_MESSAGE_BYTES, 4 * 1024, "SUBAGENT_MAX_ERROR_MESSAGE_BYTES === 4 KiB");
});

await run("isSubagentDetails: accepts valid details snapshots", async () => {
  assert(isSubagentDetails(makeDetailsInput()), "valid completed single result accepted");

  const queued = makeDetailsInput({
    results: [makeResultInput({ status: "queued", endedAt: undefined, durationMs: 0 })],
  });
  assert(isSubagentDetails(queued), "queued result (no endedAt, durationMs 0) accepted");

  const running = makeDetailsInput({
    results: [
      makeResultInput({
        status: "running",
        startedAt: STARTED,
        endedAt: undefined,
        durationMs: 250,
        activities: [makeActivityInput({ status: "running", endedAt: undefined })],
      }),
    ],
  });
  assert(isSubagentDetails(running), "running result with running activity accepted");

  const aborted = makeDetailsInput({
    results: [makeResultInput({ status: "aborted", failureReason: "aborted", endedAt: ENDED, durationMs: 10 })],
  });
  assert(isSubagentDetails(aborted), "aborted result with allowed reason accepted");

  const parallel = makeDetailsInput({
    mode: "parallel",
    results: [
      makeResultInput({ index: 0, id: "task-0" }),
      makeResultInput({ index: 1, id: "task-1" }),
    ],
  });
  assert(isSubagentDetails(parallel), "parallel details with two results accepted");
});

await run("isSubagentDetails: rejects missing/wrong schemaVersion and missing required fields", async () => {
  assert(!isSubagentDetails(makeDetailsInput({ schemaVersion: undefined })), "missing schemaVersion rejected");
  assert(!isSubagentDetails(makeDetailsInput({ schemaVersion: 2 })), "schemaVersion 2 rejected");
  assert(!isSubagentDetails(makeDetailsInput({ schemaVersion: "1" })), "string schemaVersion rejected");
  assert(!isSubagentDetails(makeDetailsInput({ mode: undefined })), "missing mode rejected");
  assert(!isSubagentDetails(makeDetailsInput({ agentScope: undefined })), "missing agentScope rejected");
  assert(!isSubagentDetails(makeDetailsInput({ results: undefined })), "missing results rejected");
  assert(!isSubagentDetails(makeDetailsInput({ results: "not-an-array" })), "non-array results rejected");
  assert(!isSubagentDetails(makeDetailsInput({ startedAt: undefined })), "missing startedAt rejected");
  assert(!isSubagentDetails(makeDetailsInput({ updatedAt: undefined })), "missing updatedAt rejected");
  assert(!isSubagentDetails(makeDetailsInput({ durationMs: undefined })), "missing durationMs rejected");
  assert(!isSubagentDetails(null), "null rejected");
  assert(!isSubagentDetails(undefined), "undefined rejected");
  assert(!isSubagentDetails(42), "non-object rejected");

  assert(
    !isSubagentDetails(makeDetailsInput({ results: [makeResultInput({ id: undefined })] })),
    "result missing id rejected",
  );
  assert(
    !isSubagentDetails(makeDetailsInput({ results: [makeResultInput({ usage: undefined })] })),
    "result missing usage rejected",
  );
  assert(
    !isSubagentDetails(makeDetailsInput({ results: [makeResultInput({ activities: undefined })] })),
    "result missing activities rejected",
  );
  assert(
    !isSubagentDetails(makeDetailsInput({ results: [makeResultInput({ durationMs: undefined })] })),
    "result missing durationMs rejected",
  );
  assert(
    !isSubagentDetails(makeDetailsInput({ results: [makeResultInput({ outputTruncated: undefined })] })),
    "result missing outputTruncated rejected",
  );
});

await run("isSubagentDetails: rejects wrong enum values", async () => {
  assert(!isSubagentDetails(makeDetailsInput({ mode: "parallelx" })), "bad mode rejected");
  assert(!isSubagentDetails(makeDetailsInput({ agentScope: "users" })), "bad agentScope rejected");
  assert(
    !isSubagentDetails(makeDetailsInput({ results: [makeResultInput({ status: "finished" })] })),
    "bad result status rejected",
  );
  assert(
    !isSubagentDetails(makeDetailsInput({ results: [makeResultInput({ agentSource: "builtin" })] })),
    "bad agentSource rejected",
  );
  assert(
    !isSubagentDetails(
      makeDetailsInput({ results: [makeResultInput({ activities: [makeActivityInput({ status: "done" })] })] }),
    ),
    "bad activity status rejected",
  );
  assert(
    !isSubagentDetails(
      makeDetailsInput({ results: [makeResultInput({ status: "failed", failureReason: "bogus", endedAt: ENDED })] }),
    ),
    "unknown failureReason rejected",
  );
});

await run("isSubagentDetails: rejects NaN, negative and non-finite numbers", async () => {
  assert(
    !isSubagentDetails(makeDetailsInput({ results: [makeResultInput({ usage: makeUsageInput({ input: NaN }) })] })),
    "NaN input usage rejected",
  );
  assert(
    !isSubagentDetails(makeDetailsInput({ results: [makeResultInput({ usage: makeUsageInput({ totalTokens: NaN }) })] })),
    "NaN totalTokens rejected",
  );
  assert(
    !isSubagentDetails(makeDetailsInput({ results: [makeResultInput({ usage: makeUsageInput({ cost: -0.01 }) })] })),
    "negative cost rejected",
  );
  assert(
    !isSubagentDetails(makeDetailsInput({ results: [makeResultInput({ usage: makeUsageInput({ turns: -1 }) })] })),
    "negative turns rejected",
  );
  assert(!isSubagentDetails(makeDetailsInput({ startedAt: NaN })), "NaN details startedAt rejected");
  assert(!isSubagentDetails(makeDetailsInput({ durationMs: Infinity })), "Infinity durationMs rejected");
  assert(
    !isSubagentDetails(makeDetailsInput({ results: [makeResultInput({ index: -1 })] })),
    "negative index rejected",
  );
  assert(
    !isSubagentDetails(makeDetailsInput({ results: [makeResultInput({ originalOutputBytes: Infinity })] })),
    "Infinity originalOutputBytes rejected",
  );
  assert(
    !isSubagentDetails(
      makeDetailsInput({ results: [makeResultInput({ activities: [makeActivityInput({ sequence: NaN })] })] }),
    ),
    "NaN activity sequence rejected",
  );
  assert(
    !isSubagentDetails(makeDetailsInput({ results: [makeResultInput({ durationMs: -1 })] })),
    "negative result durationMs rejected",
  );
});

await run("isSubagentDetails: rejects totalTokens not equal to the four token fields sum", async () => {
  const mismatch = makeDetailsInput({
    results: [makeResultInput({ usage: makeUsageInput({ totalTokens: 999 }) })],
  });
  assert(!isSubagentDetails(mismatch), "totalTokens != input+output+cacheRead+cacheWrite rejected");

  const consistent = makeDetailsInput({
    results: [
      makeResultInput({
        usage: makeUsageInput({ input: 5, output: 5, cacheRead: 1, cacheWrite: 1, totalTokens: 12 }),
      }),
    ],
  });
  assert(isSubagentDetails(consistent), "consistent totalTokens accepted");
});

await run("isSubagentDetails: rejects over-limit results, activities, summary, error and output", async () => {
  const manyResults = makeDetailsInput({
    mode: "parallel",
    results: Array.from({ length: SUBAGENT_MAX_RESULTS + 1 }, (_, i) =>
      makeResultInput({ id: `task-${i}`, index: i }),
    ),
  });
  assert(!isSubagentDetails(manyResults), `more than ${SUBAGENT_MAX_RESULTS} results rejected`);

  const atLimitResults = makeDetailsInput({
    mode: "parallel",
    results: Array.from({ length: SUBAGENT_MAX_RESULTS }, (_, i) =>
      makeResultInput({ id: `task-${i}`, index: i }),
    ),
  });
  assert(isSubagentDetails(atLimitResults), `${SUBAGENT_MAX_RESULTS} results accepted`);

  const manyActivities = makeDetailsInput({
    results: [
      makeResultInput({
        activities: Array.from({ length: SUBAGENT_MAX_RECENT_ACTIVITIES + 1 }, (_, i) =>
          makeActivityInput({ sequence: i + 1 }),
        ),
      }),
    ],
  });
  assert(!isSubagentDetails(manyActivities), `more than ${SUBAGENT_MAX_RECENT_ACTIVITIES} activities rejected`);

  const atLimitActivities = makeDetailsInput({
    results: [
      makeResultInput({
        activities: Array.from({ length: SUBAGENT_MAX_RECENT_ACTIVITIES }, (_, i) =>
          makeActivityInput({ sequence: i + 1 }),
        ),
      }),
    ],
  });
  assert(isSubagentDetails(atLimitActivities), `${SUBAGENT_MAX_RECENT_ACTIVITIES} activities accepted`);

  const longSummary = makeDetailsInput({
    results: [makeResultInput({ activities: [makeActivityInput({ summary: "a".repeat(SUBAGENT_MAX_ACTIVITY_SUMMARY_CHARS + 1) })] })],
  });
  assert(!isSubagentDetails(longSummary), `summary longer than ${SUBAGENT_MAX_ACTIVITY_SUMMARY_CHARS} chars rejected`);

  const atLimitSummary = makeDetailsInput({
    results: [makeResultInput({ activities: [makeActivityInput({ summary: "a".repeat(SUBAGENT_MAX_ACTIVITY_SUMMARY_CHARS) })] })],
  });
  assert(isSubagentDetails(atLimitSummary), `${SUBAGENT_MAX_ACTIVITY_SUMMARY_CHARS}-char summary accepted`);

  const cjkSummary = makeDetailsInput({
    results: [makeResultInput({ activities: [makeActivityInput({ summary: "你".repeat(SUBAGENT_MAX_ACTIVITY_SUMMARY_CHARS) })] })],
  });
  assert(isSubagentDetails(cjkSummary), "summary cap counts chars, not UTF-8 bytes");

  const longOutput = makeDetailsInput({
    results: [makeResultInput({ finalOutput: "a".repeat(SUBAGENT_MAX_FINAL_OUTPUT_BYTES + 1) })],
  });
  assert(!isSubagentDetails(longOutput), `finalOutput longer than ${SUBAGENT_MAX_FINAL_OUTPUT_BYTES} bytes rejected`);

  const atLimitOutput = makeDetailsInput({
    results: [makeResultInput({ finalOutput: "a".repeat(SUBAGENT_MAX_FINAL_OUTPUT_BYTES) })],
  });
  assert(isSubagentDetails(atLimitOutput), `${SUBAGENT_MAX_FINAL_OUTPUT_BYTES}-byte finalOutput accepted`);

  const multibyteOutput = makeDetailsInput({
    results: [makeResultInput({ finalOutput: "你".repeat(SUBAGENT_MAX_FINAL_OUTPUT_BYTES) })],
  });
  assert(!isSubagentDetails(multibyteOutput), "finalOutput cap counts UTF-8 bytes (multibyte exceeds)");

  const longError = makeDetailsInput({
    results: [
      makeResultInput({
        status: "failed",
        failureReason: "api_error",
        endedAt: ENDED,
        errorMessage: "e".repeat(SUBAGENT_MAX_ERROR_MESSAGE_BYTES + 1),
      }),
    ],
  });
  assert(!isSubagentDetails(longError), `errorMessage longer than ${SUBAGENT_MAX_ERROR_MESSAGE_BYTES} bytes rejected`);

  const atLimitError = makeDetailsInput({
    results: [
      makeResultInput({
        status: "failed",
        failureReason: "api_error",
        endedAt: ENDED,
        errorMessage: "e".repeat(SUBAGENT_MAX_ERROR_MESSAGE_BYTES),
      }),
    ],
  });
  assert(isSubagentDetails(atLimitError), `${SUBAGENT_MAX_ERROR_MESSAGE_BYTES}-byte errorMessage accepted`);

  const multibyteError = makeDetailsInput({
    results: [
      makeResultInput({
        status: "failed",
        failureReason: "api_error",
        endedAt: ENDED,
        errorMessage: "你".repeat(Math.ceil(SUBAGENT_MAX_ERROR_MESSAGE_BYTES / 3)),
      }),
    ],
  });
  assert(!isSubagentDetails(multibyteError), "errorMessage cap counts UTF-8 bytes (multibyte exceeds)");
});

await run("isSubagentDetails: enforces status invariants", async () => {
  const runningWithEnded = makeDetailsInput({
    results: [makeResultInput({ status: "running", startedAt: STARTED, endedAt: ENDED })],
  });
  assert(!isSubagentDetails(runningWithEnded), "running with endedAt rejected");

  const queuedWithEnded = makeDetailsInput({
    results: [makeResultInput({ status: "queued", endedAt: ENDED, durationMs: 0 })],
  });
  assert(!isSubagentDetails(queuedWithEnded), "queued with endedAt rejected");

  const runningNoStarted = makeDetailsInput({
    results: [makeResultInput({ status: "running", startedAt: undefined, endedAt: undefined })],
  });
  assert(!isSubagentDetails(runningNoStarted), "running without startedAt rejected");

  const completedNoEnded = makeDetailsInput({
    results: [makeResultInput({ status: "completed", endedAt: undefined })],
  });
  assert(!isSubagentDetails(completedNoEnded), "completed without endedAt rejected");

  const failedNoEnded = makeDetailsInput({
    results: [makeResultInput({ status: "failed", failureReason: "api_error", endedAt: undefined })],
  });
  assert(!isSubagentDetails(failedNoEnded), "failed without endedAt rejected");

  const failedNoReason = makeDetailsInput({
    results: [makeResultInput({ status: "failed", failureReason: undefined, endedAt: ENDED })],
  });
  assert(!isSubagentDetails(failedNoReason), "failed without failureReason rejected");

  const failedAbortReason = makeDetailsInput({
    results: [makeResultInput({ status: "failed", failureReason: "aborted", endedAt: ENDED })],
  });
  assert(!isSubagentDetails(failedAbortReason), "failed with aborted reason rejected");

  const failedHostDisposed = makeDetailsInput({
    results: [makeResultInput({ status: "failed", failureReason: "host_disposed", endedAt: ENDED })],
  });
  assert(!isSubagentDetails(failedHostDisposed), "failed with host_disposed reason rejected");

  const failedMaxTurns = makeDetailsInput({
    results: [makeResultInput({ status: "failed", failureReason: "max_turns", endedAt: ENDED })],
  });
  assert(isSubagentDetails(failedMaxTurns), "failed with max_turns accepted (not a plain abort)");

  const abortedBadReason = makeDetailsInput({
    results: [makeResultInput({ status: "aborted", failureReason: "api_error", endedAt: ENDED })],
  });
  assert(!isSubagentDetails(abortedBadReason), "aborted with non-abort reason rejected");

  const abortedProjectDenied = makeDetailsInput({
    results: [makeResultInput({ status: "aborted", failureReason: "project_agent_denied", endedAt: ENDED })],
  });
  assert(isSubagentDetails(abortedProjectDenied), "aborted with project_agent_denied accepted");

  const completedWithReason = makeDetailsInput({
    results: [makeResultInput({ status: "completed", failureReason: "api_error" })],
  });
  assert(!isSubagentDetails(completedWithReason), "completed with failureReason rejected");

  const activityRunningEnded = makeDetailsInput({
    results: [makeResultInput({ activities: [makeActivityInput({ status: "running", endedAt: ENDED })] })],
  });
  assert(!isSubagentDetails(activityRunningEnded), "running activity with endedAt rejected");

  const activityCompletedNoEnded = makeDetailsInput({
    results: [makeResultInput({ activities: [makeActivityInput({ status: "completed", endedAt: undefined })] })],
  });
  assert(!isSubagentDetails(activityCompletedNoEnded), "completed activity without endedAt rejected");

  const activityFailedNoEnded = makeDetailsInput({
    results: [makeResultInput({ activities: [makeActivityInput({ status: "failed", endedAt: undefined })] })],
  });
  assert(!isSubagentDetails(activityFailedNoEnded), "failed activity without endedAt rejected");
});

await run("isSubagentDetails: workflow structured field (absent legal; present JSON-clonable)", async () => {
  assert(
    isSubagentDetails(makeDetailsInput({ results: [makeResultInput()] })),
    "result without structured accepted (absent is legal)",
  );
  assert(
    isSubagentDetails(
      makeDetailsInput({ results: [makeResultInput({ structured: { answer: 42, nested: { list: [1, 2, 3] } } })] }),
    ),
    "plain-object structured value accepted",
  );
  assert(
    isSubagentDetails(makeDetailsInput({ results: [makeResultInput({ structured: null })] })),
    "null structured value accepted",
  );
  assert(
    isSubagentDetails(makeDetailsInput({ results: [makeResultInput({ structured: [1, "a", true] })] })),
    "array structured value accepted",
  );
  assert(
    isSubagentDetails(makeDetailsInput({ results: [makeResultInput({ structured: undefined })] })),
    "explicit undefined structured treated as absent",
  );
  assert(
    !isSubagentDetails(makeDetailsInput({ results: [makeResultInput({ structured: (() => 1) as unknown })] })),
    "function structured value rejected (not JSON-clonable)",
  );
  assert(
    !isSubagentDetails(makeDetailsInput({ results: [makeResultInput({ structured: Symbol("x") as unknown })] })),
    "symbol structured value rejected (not JSON-clonable)",
  );
  // The structured field is plain data: it survives a JSON round-trip.
  const withStructured = makeDetailsInput({ results: [makeResultInput({ structured: { answer: 42 } })] });
  const roundTripped = JSON.parse(JSON.stringify(withStructured)) as unknown;
  assert(isSubagentDetails(roundTripped), "structured survives JSON round-trip");
  assertEqual(
    JSON.stringify(roundTripped),
    JSON.stringify(withStructured),
    "round-trip preserves the exact structured shape",
  );
});

await run("isSubagentDetails: never throws on arbitrary input", async () => {
  const inputs: unknown[] = [
    null,
    undefined,
    0,
    "details",
    [],
    Symbol("x"),
    { schemaVersion: 1, mode: "single", agentScope: "user", results: [null] },
    { schemaVersion: 1, mode: "single", agentScope: "user", results: ["x"] },
    { schemaVersion: 1, mode: "single", agentScope: "user", results: [{}] },
    { schemaVersion: 1, mode: "single", agentScope: "user", results: [{ usage: [] }] },
  ];
  for (const input of inputs) {
    let threw = false;
    try {
      isSubagentDetails(input);
    } catch {
      threw = true;
    }
    assert(!threw, `isSubagentDetails does not throw (input type ${typeof input})`);
  }

  const cyclicArray: unknown[] = [];
  cyclicArray.push(cyclicArray);
  let threw = false;
  try {
    isSubagentDetails({ schemaVersion: 1, mode: "single", agentScope: "user", results: cyclicArray });
  } catch {
    threw = true;
  }
  assert(!threw, "isSubagentDetails does not throw on cyclic results array");

  const cyclicRecord: Record<string, unknown> = {};
  cyclicRecord.self = cyclicRecord;
  threw = false;
  try {
    isSubagentDetails({ schemaVersion: 1, mode: "single", agentScope: "user", results: [cyclicRecord] });
  } catch {
    threw = true;
  }
  assert(!threw, "isSubagentDetails does not throw on cyclic result object");
});

await run("aggregateSubagentUsage: sums per-result usage and recomputes totalTokens", async () => {
  const input = makeDetailsInput({
    mode: "parallel",
    results: [
      makeResultInput({
        index: 0,
        usage: makeUsageInput({ input: 10, output: 20, cacheRead: 3, cacheWrite: 2, totalTokens: 35, cost: 0.5, turns: 1 }),
      }),
      makeResultInput({
        index: 1,
        usage: makeUsageInput({ input: 100, output: 50, cacheRead: 7, cacheWrite: 5, totalTokens: 162, cost: 0.25, turns: 2 }),
      }),
      makeResultInput({
        index: 2,
        usage: makeUsageInput({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 }),
      }),
    ],
  });
  assert(isSubagentDetails(input), "aggregate input passes the guard");
  const details = input as SubagentDetails;
  const aggregated = aggregateSubagentUsage(details);

  assertEqual(aggregated.input, 110, "aggregated input is the per-result sum");
  assertEqual(aggregated.output, 70, "aggregated output is the per-result sum");
  assertEqual(aggregated.cacheRead, 10, "aggregated cacheRead is the per-result sum");
  assertEqual(aggregated.cacheWrite, 7, "aggregated cacheWrite is the per-result sum");
  assertEqual(aggregated.totalTokens, 197, "totalTokens recomputed from the four summed token fields");
  assertEqual(aggregated.cost, 0.75, "aggregated cost is the per-result sum");
  assertEqual(aggregated.turns, 3, "aggregated turns is the per-result sum");

  const singleAggregated = aggregateSubagentUsage(makeDetailsInput() as SubagentDetails);
  assertEqual(singleAggregated.totalTokens, 35, "single-result aggregate matches its usage totalTokens");
  assertEqual(singleAggregated.input, 10, "single-result aggregate matches its usage input");
  assertEqual(singleAggregated.cost, 0.0012, "single-result aggregate matches its usage cost");

  const emptyAggregated = aggregateSubagentUsage(makeDetailsInput({ results: [] }) as SubagentDetails);
  assertEqual(emptyAggregated.totalTokens, 0, "empty results aggregate to zero");
  assertEqual(emptyAggregated.turns, 0, "empty results aggregate turns to zero");
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
