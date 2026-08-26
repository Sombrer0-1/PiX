/**
 * Shared agent-task contract tests (B1).
 *
 * Independently verifies pix/src/shared/agent-task-types.ts (constants,
 * transition table, isAgentTaskInfo/isAgentTaskGroupHandle invariants, the
 * 1.4.1 version gates), the §4.5 spec granularity pattern (parallel children
 * are mode=single/groupMode=parallel specs whose original order is
 * reconstructible from item.index), JSON round-trips, and the main-only
 * workspaceIdOf sha1 identity (same hashing as team-persistence.ts).
 * Does not depend on the service or runtime implementation, so B1 runs
 * standalone.
 *
 * Run with: npm exec tsx -- src/main/__tests__/agent-task-types.test.ts
 */

import { createHash } from "crypto";
import {
  AGENT_TASK_SCHEMA_VERSION,
  AGENT_TASK_DEFAULT_RUNNING_SLOTS,
  AGENT_TASK_MAX_RUNNING_SLOTS,
  clampAgentTaskRunningSlots,
  isAgentTaskRunningSlots,
  parseAgentTaskMaxConcurrent,
  AGENT_TASK_MAX_ACTIVITIES,
  AGENT_TASK_MAX_FINAL_OUTPUT_BYTES,
  AGENT_TASK_MAX_RECENT_ACTIVITIES,
  DEFAULT_AUTO_BACKGROUND_MS,
  DEFAULT_MAX_TURNS,
  AGENT_TASK_TRANSITIONS,
  isAgentTaskInfo,
  isAgentTaskGroupHandle,
  isAgentTaskItemSpec,
  type AgentTaskItemSpec,
  type AgentTaskSpec,
} from "../../shared/agent-task-types.js";
import type { ProjectLocation } from "../../shared/project-location.js";
import { workspaceIdOf } from "../agent-task/agent-task-identity.js";

// ============================================================================
// Test harness (matches subagent-types.test.ts style)
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

function makeResultInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "task-result-1",
    index: 0,
    agentName: "scout",
    agentSource: "user",
    description: "Locate auth entry points",
    status: "completed",
    finalOutput: "auth entry points: src/auth.ts",
    outputTruncated: false,
    originalOutputBytes: 30,
    toolUseCount: 1,
    activities: [makeActivityInput()],
    usage: makeUsageInput(),
    model: "provider/model-id",
    startedAt: STARTED,
    endedAt: ENDED,
    durationMs: 420,
    ...overrides,
  };
}

function makeItemSummaryInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    index: 0,
    agentName: "scout",
    agentSource: "user",
    model: { provider: "provider", modelId: "model-id" },
    maxTurns: 40,
    ...overrides,
  };
}

function makeProjectInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    path: "E:/develop/demo",
    physicalPath: "E:/develop/demo",
    name: "demo",
    environment: { kind: "windows" },
    ...overrides,
  };
}

function makePlanLinkInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    planId: "plan-1",
    version: 2,
    stepId: "step-3",
    ...overrides,
  };
}

function makeInfoInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    taskId: "task-1",
    groupId: "group-1",
    groupMode: "single",
    workspaceId: workspaceIdOf("E:/develop/demo"),
    parentSessionId: "session-1",
    parentToolCallId: "tool-call-1",
    itemSummaries: [makeItemSummaryInput()],
    thinkingLevel: "medium",
    executionMode: "approval",
    project: makeProjectInput(),
    presentation: "foreground",
    status: "completed",
    queuePosition: undefined,
    autoBackground: undefined,
    failureReason: undefined,
    errorMessage: undefined,
    description: "Locate auth entry points",
    finalOutput: "auth entry points: src/auth.ts",
    outputTruncated: false,
    originalOutputBytes: 30,
    results: [makeResultInput()],
    activities: [makeActivityInput()],
    usage: makeUsageInput(),
    toolUseCount: 1,
    createdAt: STARTED,
    startedAt: STARTED,
    updatedAt: ENDED,
    endedAt: ENDED,
    durationMs: 420,
    planLink: undefined,
    deliveredSessionIds: [],
    planLinkState: "none",
    generation: 0,
    ...overrides,
  };
}

/** N copies of the default activity; used to probe the activities cap. */
function makeActivities(count: number): unknown[] {
  return Array.from({ length: count }, (_, i) => makeActivityInput({ sequence: i + 1 }));
}

// ============================================================================
// Constants and transition table
// ============================================================================

run("constants", async () => {
  assertEqual(AGENT_TASK_SCHEMA_VERSION, 1, "schema version is 1");
  assertEqual(AGENT_TASK_DEFAULT_RUNNING_SLOTS, 4, "default running slots is 4");
  assertEqual(AGENT_TASK_MAX_RUNNING_SLOTS, 8, "max running slots is 8");
  assert(isAgentTaskRunningSlots(1) && isAgentTaskRunningSlots(8), "1 and 8 are legal slot counts");
  assert(!isAgentTaskRunningSlots(0) && !isAgentTaskRunningSlots(9) && !isAgentTaskRunningSlots(1.5), "0/9/1.5 are illegal");
  assertEqual(parseAgentTaskMaxConcurrent(8), 8, "parse keeps 8");
  assertEqual(parseAgentTaskMaxConcurrent(9), undefined, "parse drops 9");
  assertEqual(clampAgentTaskRunningSlots(undefined), 4, "clamp undefined to default");
  assertEqual(clampAgentTaskRunningSlots(0), 1, "clamp 0 to 1");
  assertEqual(clampAgentTaskRunningSlots(99), 8, "clamp 99 to ceiling");
  assertEqual(AGENT_TASK_MAX_ACTIVITIES, 20, "max activities is 20");
  assertEqual(AGENT_TASK_MAX_FINAL_OUTPUT_BYTES, 48 * 1024, "max final output is 48 KiB");
  assertEqual(AGENT_TASK_MAX_RECENT_ACTIVITIES, 20, "max recent activities is 20");
  assertEqual(DEFAULT_AUTO_BACKGROUND_MS, 0, "default auto-background is off");
  assertEqual(DEFAULT_MAX_TURNS, 150, "loose default maxTurns is 150");
});

run("transition table", async () => {
  const expected: Array<[string, readonly string[]]> = [
    ["queued", ["running", "cancelled", "interrupted"]],
    ["running", ["waiting_input", "completed", "failed", "cancelled", "interrupted"]],
    ["waiting_input", ["running", "failed", "cancelled", "interrupted"]],
    ["completed", []],
    ["failed", []],
    ["cancelled", []],
    // 1.4.2 (R2): restart hydration only; the post-resume queued path and the
    // explicit user decisions arrive with R3.
    ["interrupted", ["queued", "failed", "cancelled"]],
  ];
  for (const [status, targets] of expected) {
    assertEqual(
      AGENT_TASK_TRANSITIONS[status as keyof typeof AGENT_TASK_TRANSITIONS].join(","),
      targets.join(","),
      `${status} transitions`,
    );
  }
});

// ============================================================================
// isAgentTaskInfo: valid infos across all non-terminal/terminal states
// ============================================================================

run("guard accepts valid infos", async () => {
  assert(isAgentTaskInfo(makeInfoInput()), "completed foreground info passes");

  assert(
    isAgentTaskInfo(makeInfoInput({
      status: "queued",
      queuePosition: 1,
      startedAt: undefined,
      endedAt: undefined,
      durationMs: 0,
      updatedAt: STARTED,
    })),
    "queued info with queuePosition passes",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({
      status: "running",
      endedAt: undefined,
      durationMs: 0,
      updatedAt: STARTED,
      autoBackground: { deadlineAt: ENDED + 10_000, warningAt: ENDED + 5_000, warningActive: true },
    })),
    "running info with startedAt and autoBackground passes",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({
      status: "waiting_input",
      endedAt: undefined,
      durationMs: 0,
      updatedAt: STARTED,
    })),
    "waiting_input info with startedAt passes",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({ status: "failed", failureReason: "api_error" })),
    "failed info with failureReason passes",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({ status: "cancelled" })),
    "cancelled info passes",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({
      status: "running",
      groupMode: "parallel",
      endedAt: undefined,
      durationMs: 0,
      updatedAt: STARTED,
    })),
    "parallel child info (groupMode=parallel) passes",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({
      status: "running",
      groupMode: "chain",
      endedAt: undefined,
      durationMs: 0,
      updatedAt: STARTED,
    })),
    "chain info passes",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({
      status: "running",
      presentation: "background",
      endedAt: undefined,
      durationMs: 0,
      updatedAt: STARTED,
    })),
    "background presentation is legal on a running info",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({
      status: "failed",
      failureReason: "max_turns",
      errorMessage: "turn budget exhausted",
      planLink: makePlanLinkInput(),
      planLinkState: "pending",
    })),
    "failed info with planLink pending passes",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({ generation: 2 })),
    "positive generation passes",
  );
  // Unknown extra fields are tolerated (1.4.2 runtimes write stopReason into
  // the same v1 shape; the version gate lives in the type, not the guard).
  assert(
    isAgentTaskInfo(makeInfoInput({ stopReason: "user_cancel" })),
    "unknown extra fields are tolerated",
  );
});

// ============================================================================
// isAgentTaskInfo: 1.4.1 version gates
// ============================================================================

run("guard enforces 1.4.2 version gates", async () => {
  assert(!isAgentTaskInfo(makeInfoInput({ schemaVersion: 2 })), "schemaVersion 2 rejected");
  assert(
    isAgentTaskInfo(makeInfoInput({
      status: "interrupted",
      presentation: "background",
      startedAt: undefined,
      endedAt: undefined,
      durationMs: 0,
      updatedAt: STARTED,
    })),
    "interrupted status accepted in 1.4.2 (R2)",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({ status: "interrupted", presentation: "background", startedAt: undefined, endedAt: undefined, durationMs: 0, updatedAt: STARTED, stopReason: "app_shutdown" })),
    "interrupted info carries the R2 stopReason recovery field",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({
      status: "interrupted",
      presentation: "background",
      startedAt: undefined,
      endedAt: undefined,
      durationMs: 0,
      updatedAt: STARTED,
      lastCheckpointSeq: 7,
      hasUnclosedToolCall: true,
    })),
    "interrupted info carries the R2 checkpoint recovery fields",
  );
  assert(!isAgentTaskInfo(makeInfoInput({ status: "interrupted", queuePosition: 1 })), "interrupted clears queuePosition");
  assert(!isAgentTaskInfo(makeInfoInput({ status: "interrupted", autoBackground: { deadlineAt: 1, warningAt: 0, warningActive: false } })), "interrupted clears autoBackground");
  assert(!isAgentTaskInfo(makeInfoInput({ status: "bogus" })), "unknown status rejected");
  assert(
    isAgentTaskInfo(makeInfoInput({ status: "failed", failureReason: "storage_limit" })),
    "storage_limit failure reason accepted in 1.4.2 (R2)",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({ status: "failed", failureReason: "user_decision" })),
    "user_decision failure reason accepted in 1.4.2 (R2)",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ status: "failed", failureReason: "storage_exceeded" })),
    "unknown failure reason rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ status: "running", lastCheckpointSeq: -1 })),
    "negative lastCheckpointSeq rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ status: "running", hasUnclosedToolCall: "yes" as unknown as boolean })),
    "non-boolean hasUnclosedToolCall rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ status: "running", stopReason: "user_forced" })),
    "unknown stopReason rejected",
  );
  assert(!isAgentTaskInfo(makeInfoInput({ presentation: "sidecar" })), "unknown presentation rejected");
  assert(!isAgentTaskInfo(makeInfoInput({ groupMode: "fanout" })), "unknown groupMode rejected");
  assert(!isAgentTaskInfo(makeInfoInput({ executionMode: "solo" })), "unknown executionMode rejected");
  assert(!isAgentTaskInfo(makeInfoInput({ thinkingLevel: "extreme" })), "unknown thinkingLevel rejected");
});

// ============================================================================
// isAgentTaskInfo: status/timestamp invariants
// ============================================================================

run("guard enforces status/timestamp invariants", async () => {
  assert(
    !isAgentTaskInfo(makeInfoInput({ status: "completed", queuePosition: 2 })),
    "queuePosition on a terminal status rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ status: "running", queuePosition: 2 })),
    "queuePosition on a non-queued status rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ status: "queued", queuePosition: -1 })),
    "negative queuePosition rejected",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({ status: "queued", queuePosition: 0, startedAt: undefined, endedAt: undefined, durationMs: 0, updatedAt: STARTED })),
    "queuePosition 0 on queued passes",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ status: "running", startedAt: undefined, endedAt: undefined })),
    "running without startedAt rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ status: "waiting_input", startedAt: undefined, endedAt: undefined })),
    "waiting_input without startedAt rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ status: "completed", endedAt: undefined })),
    "terminal status without endedAt rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ status: "cancelled", endedAt: undefined })),
    "cancelled without endedAt rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ status: "completed", autoBackground: { deadlineAt: ENDED + 10_000, warningAt: ENDED + 5_000, warningActive: false } })),
    "terminal status with autoBackground rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ status: "failed", queuePosition: 1 })),
    "terminal status with queuePosition rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ status: "running", endedAt: undefined, autoBackground: { deadlineAt: ENDED + 10_000, warningAt: ENDED + 10_000, warningActive: false } })),
    "autoBackground with warningAt >= deadlineAt rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ status: "running", endedAt: undefined, autoBackground: { deadlineAt: ENDED + 10_000, warningAt: ENDED + 5_000, warningActive: "yes" } })),
    "autoBackground with non-boolean warningActive rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ endedAt: STARTED - 1 })),
    "endedAt before startedAt rejected",
  );
  assert(!isAgentTaskInfo(makeInfoInput({ createdAt: -1 })), "negative createdAt rejected");
  assert(!isAgentTaskInfo(makeInfoInput({ updatedAt: Number.NaN })), "NaN updatedAt rejected");
  assert(!isAgentTaskInfo(makeInfoInput({ durationMs: Number.POSITIVE_INFINITY })), "infinite durationMs rejected");
  assert(!isAgentTaskInfo(makeInfoInput({ generation: -1 })), "negative generation rejected");
  assert(!isAgentTaskInfo(makeInfoInput({ generation: 1.5 })), "fractional generation rejected");
  assert(
    !isAgentTaskInfo(makeInfoInput({ status: "completed", failureReason: "api_error" })),
    "failureReason on a non-failed status rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ status: "failed", failureReason: undefined })),
    "failed without failureReason rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ status: "failed", failureReason: "not-a-reason" })),
    "unknown failureReason rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ errorMessage: 42 })),
    "non-string errorMessage rejected",
  );
  assert(!isAgentTaskInfo(makeInfoInput({ taskId: undefined })), "missing taskId rejected");
});

// ============================================================================
// isAgentTaskInfo: caps and nested shapes
// ============================================================================

run("guard enforces caps and nested shapes", async () => {
  assert(
    !isAgentTaskInfo(makeInfoInput({ activities: makeActivities(AGENT_TASK_MAX_ACTIVITIES + 1) })),
    "activities over the 20 cap rejected",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({ activities: makeActivities(AGENT_TASK_MAX_ACTIVITIES) })),
    "activities at the 20 cap pass",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ finalOutput: "a".repeat(AGENT_TASK_MAX_FINAL_OUTPUT_BYTES + 1) })),
    "finalOutput over 48 KiB rejected",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({ finalOutput: "a".repeat(AGENT_TASK_MAX_FINAL_OUTPUT_BYTES), originalOutputBytes: AGENT_TASK_MAX_FINAL_OUTPUT_BYTES })),
    "finalOutput at exactly 48 KiB passes",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ finalOutput: "short output", outputTruncated: true, originalOutputBytes: 0 })),
    "truncated output without pre-truncation size rejected",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({ finalOutput: "short output", outputTruncated: true, originalOutputBytes: 65_536 })),
    "truncated output with originalOutputBytes passes",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ usage: makeUsageInput({ totalTokens: 99 }) })),
    "usage with inconsistent totalTokens rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ itemSummaries: [makeItemSummaryInput({ agentSource: "cyborg" })] })),
    "item summary with unknown agentSource rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ itemSummaries: [makeItemSummaryInput({ model: { provider: "provider" } })] })),
    "item summary model without modelId rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ itemSummaries: [makeItemSummaryInput({ maxTurns: -1 })] })),
    "item summary with negative maxTurns rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ project: makeProjectInput({ physicalPath: undefined }) })),
    "project without physicalPath rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ project: makeProjectInput({ environment: { kind: "wsl" } }) })),
    "wsl project without distro rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ project: makeProjectInput({ environment: { kind: "mac" } }) })),
    "unknown project environment rejected",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({ project: makeProjectInput({ environment: { kind: "wsl", distro: "Ubuntu" } }) })),
    "wsl project with distro passes",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ results: makeResultInput() })),
    "results that are not an array rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ results: [makeResultInput({ status: "banana" })] })),
    "result with unknown status rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ results: [makeResultInput({ id: undefined })] })),
    "result without id rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ results: [makeResultInput({ usage: makeUsageInput({ totalTokens: 7 }) })] })),
    "result with inconsistent usage rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ activities: [makeActivityInput({ status: "running" })] })),
    "running activity with endedAt rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ activities: [makeActivityInput({ status: "failed", endedAt: undefined })] })),
    "failed activity without endedAt rejected",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({ activities: [makeActivityInput({ status: "running", endedAt: undefined })] })),
    "running activity without endedAt passes",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ deliveredSessionIds: ["session-2", 3] })),
    "non-string deliveredSessionIds entry rejected",
  );
});

// ============================================================================
// isAgentTaskInfo: planLink/planLinkState consistency
// ============================================================================

run("guard enforces planLink/planLinkState consistency", async () => {
  assert(
    !isAgentTaskInfo(makeInfoInput({ planLink: makePlanLinkInput(), planLinkState: "none" })),
    "planLink present with planLinkState none rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ planLink: undefined, planLinkState: "pending" })),
    "planLink absent with planLinkState pending rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ planLink: undefined, planLinkState: "consumed" })),
    "planLink absent with planLinkState consumed rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ planLink: makePlanLinkInput(), planLinkState: "bogus" })),
    "unknown planLinkState rejected",
  );
  assert(
    !isAgentTaskInfo(makeInfoInput({ planLink: makePlanLinkInput({ version: -1 }), planLinkState: "pending" })),
    "plan link with negative version rejected",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({ planLink: makePlanLinkInput(), planLinkState: "pending" })),
    "planLink pending passes",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({ planLink: makePlanLinkInput(), planLinkState: "consumed" })),
    "planLink consumed passes",
  );
  assert(
    isAgentTaskInfo(makeInfoInput({ planLink: makePlanLinkInput(), planLinkState: "released" })),
    "planLink released passes",
  );
});

// ============================================================================
// isAgentTaskGroupHandle
// ============================================================================

run("isAgentTaskGroupHandle", async () => {
  const handle = {
    kind: "agent_task_group",
    groupId: "group-1",
    mode: "parallel",
    tasks: [
      { kind: "agent_task", taskId: "task-1", generation: 0, status: "queued", description: "one", presentation: "foreground" },
      { kind: "agent_task", taskId: "task-2", generation: 1, status: "running", description: "two", presentation: "background" },
    ],
  };
  assert(isAgentTaskGroupHandle(handle), "valid parallel group handle passes");
  assert(
    isAgentTaskGroupHandle({ ...handle, mode: "chain", tasks: [handle.tasks[0]] }),
    "chain group handle passes",
  );
  assert(
    isAgentTaskGroupHandle({ ...handle, mode: "single", tasks: [handle.tasks[0]] }),
    "single group handle passes",
  );
  assert(!isAgentTaskGroupHandle({ ...handle, kind: "agent_task" }), "wrong kind rejected");
  assert(!isAgentTaskGroupHandle({ ...handle, mode: "fanout" }), "unknown group mode rejected");
  assert(!isAgentTaskGroupHandle({ ...handle, groupId: undefined }), "missing groupId rejected");
  assert(
    isAgentTaskGroupHandle({ ...handle, tasks: [{ ...handle.tasks[0], status: "interrupted" }] }),
    "task with 1.4.2 interrupted status accepted",
  );
  assert(
    !isAgentTaskGroupHandle({ ...handle, tasks: [{ ...handle.tasks[0], generation: 0.5 }] }),
    "task with fractional generation rejected",
  );
  assert(
    !isAgentTaskGroupHandle({ ...handle, tasks: [{ ...handle.tasks[0], presentation: "sidecar" }] }),
    "task with unknown presentation rejected",
  );
  assert(!isAgentTaskGroupHandle({ ...handle, tasks: "tasks" }), "non-array tasks rejected");
});

// ============================================================================
// isAgentTaskItemSpec: ready/rejected variants + the optional workflow
// outputSchema (absent legal; present must be a plain object) and the
// optional appendSystemPrompt (absent legal; present must be a string).
// ============================================================================

run("isAgentTaskItemSpec", async () => {
  const ready = {
    resolution: "ready",
    index: 0,
    prompt: "do the thing",
    description: "A ready item",
    agent: {
      name: "general-purpose",
      description: "General purpose",
      systemPrompt: "You are a general purpose agent.",
      source: "built-in",
    },
    model: { provider: "provider", modelId: "model-id" },
    maxTurns: 40,
  };
  const rejected = {
    resolution: "rejected",
    index: 1,
    prompt: "do the thing",
    description: "A rejected item",
    requestedAgentName: "no-such-agent",
    failureReason: "unknown_agent",
    errorMessage: "Unknown agent \"no-such-agent\".",
  };

  assert(isAgentTaskItemSpec(ready), "ready item without outputSchema passes");
  assert(isAgentTaskItemSpec(rejected), "rejected item passes");
  assert(
    isAgentTaskItemSpec({ ...ready, outputSchema: { type: "object", properties: { a: { type: "object" } } } }),
    "ready item with a plain-object outputSchema passes",
  );
  assert(isAgentTaskItemSpec({ ...ready, outputSchema: {} }), "empty plain-object outputSchema passes");
  assert(!isAgentTaskItemSpec({ ...ready, outputSchema: "object" }), "string outputSchema rejected");
  assert(!isAgentTaskItemSpec({ ...ready, outputSchema: 42 }), "numeric outputSchema rejected");
  assert(!isAgentTaskItemSpec({ ...ready, outputSchema: ["a"] }), "array outputSchema rejected");
  assert(!isAgentTaskItemSpec({ ...ready, outputSchema: null }), "null outputSchema rejected");
  assert(isAgentTaskItemSpec({ ...ready, outputSchema: undefined }), "explicit undefined outputSchema is absent (legal)");
  assert(
    isAgentTaskItemSpec({ ...ready, appendSystemPrompt: "## Workflow artifacts" }),
    "ready item with string appendSystemPrompt passes",
  );
  assert(
    isAgentTaskItemSpec({ ...ready, appendSystemPrompt: undefined }),
    "explicit undefined appendSystemPrompt is absent (legal)",
  );
  assert(!isAgentTaskItemSpec({ ...ready, appendSystemPrompt: 42 }), "numeric appendSystemPrompt rejected");
  assert(!isAgentTaskItemSpec({ ...ready, appendSystemPrompt: { text: "x" } }), "object appendSystemPrompt rejected");
  assert(
    isAgentTaskItemSpec({ ...ready, extraUnknown: true }),
    "unknown fields ignored so old snapshots restore",
  );
  assert(!isAgentTaskItemSpec({ resolution: "ready", index: 0, prompt: "p", description: "d", maxTurns: 40 }), "missing agent rejected");
  assert(!isAgentTaskItemSpec({ ...ready, resolution: "bogus" }), "unknown resolution rejected");
  assert(!isAgentTaskItemSpec({ ...rejected, failureReason: "bogus" }), "unknown rejected failureReason rejected");
  assert(!isAgentTaskItemSpec({ ...rejected, errorMessage: 42 }), "non-string rejected errorMessage rejected");

  // The workflow extras outputSchema / appendSystemPrompt are plain data: JSON round-trip preserves them.
  const withSchema = { ...ready, outputSchema: { type: "object", required: ["answer"] } };
  const roundTripped = JSON.parse(JSON.stringify(withSchema)) as unknown;
  assert(isAgentTaskItemSpec(roundTripped), "ready item with outputSchema survives JSON round-trip");
  assertEqual(
    JSON.stringify(roundTripped),
    JSON.stringify(withSchema),
    "round-trip preserves the exact outputSchema shape",
  );
  const withAppend = { ...ready, appendSystemPrompt: "## Workflow artifacts\n### reviews\n```json\n{\"a\":1}\n```" };
  const appendRoundTripped = JSON.parse(JSON.stringify(withAppend)) as unknown;
  assert(isAgentTaskItemSpec(appendRoundTripped), "ready item with appendSystemPrompt survives JSON round-trip");
  assertEqual(
    JSON.stringify(appendRoundTripped),
    JSON.stringify(withAppend),
    "round-trip preserves the exact appendSystemPrompt string",
  );

  // A workflow ready item (outputSchema) inside a stored info's itemSummaries
  // shape is unaffected; results with the structured field stay legal for the
  // stored-result guard.
  assert(
    isAgentTaskInfo(makeInfoInput({ results: [makeResultInput({ structured: { answer: 42 } })] })),
    "info whose result carries the workflow structured field passes",
  );
});

// ============================================================================
// JSON round-trips
// ============================================================================

run("JSON round-trips", async () => {
  const info = makeInfoInput();
  const roundTripped = JSON.parse(JSON.stringify(info)) as unknown;
  assert(isAgentTaskInfo(roundTripped), "info survives JSON round-trip");
  assertEqual(
    JSON.stringify(roundTripped),
    JSON.stringify(info),
    "round-trip preserves the exact JSON shape",
  );
  const structured = structuredClone(info) as unknown;
  assert(isAgentTaskInfo(structured), "info survives structuredClone");
  assertEqual(JSON.stringify(structured), JSON.stringify(info), "clone preserves the exact JSON shape");

  const handle = {
    kind: "agent_task_group",
    groupId: "group-1",
    mode: "single",
    tasks: [
      { kind: "agent_task", taskId: "task-1", generation: 0, status: "completed", description: "one", presentation: "foreground" },
    ],
  };
  const handleRoundTripped = JSON.parse(JSON.stringify(handle)) as unknown;
  assert(isAgentTaskGroupHandle(handleRoundTripped), "group handle survives JSON round-trip");
  assertEqual(JSON.stringify(handleRoundTripped), JSON.stringify(handle), "handle round-trip preserves shape");
});

// ============================================================================
// §4.5 spec granularity: parallel children, chain, single
// ============================================================================

run("spec granularity (§4.5)", async () => {
  const project: ProjectLocation = {
    path: "E:/develop/demo",
    physicalPath: "E:/develop/demo",
    name: "demo",
    environment: { kind: "windows" },
  };
  const base: Omit<AgentTaskSpec, "taskId" | "groupMode" | "mode" | "items"> = {
    schemaVersion: 1 as const,
    groupId: "group-parallel-1",
    agentScope: "user" as const,
    thinkingLevel: "medium" as const,
    executionMode: "approval" as const,
    verificationGate: false,
    project,
    workspaceId: workspaceIdOf(project.physicalPath),
    agentDir: "E:/develop/pi/pix",
    parentSessionId: "session-1",
    parentToolCallId: "tool-call-1",
    createdAt: STARTED,
  };

  // Parallel group of three items -> one mode=single spec per item, each
  // preserving the original item.index.
  const parallelPrompts = ["task alpha", "task beta", "task gamma"];
  const parallelSpecs: AgentTaskSpec[] = parallelPrompts.map((prompt, index): AgentTaskSpec => {
    const item: AgentTaskItemSpec = {
      resolution: "ready",
      index,
      prompt,
      description: `step ${index}`,
      agent: {
        name: "general-purpose",
        description: "General purpose",
        systemPrompt: "You are a general purpose agent.",
        source: "built-in",
      },
      model: { provider: "provider", modelId: "model-id" },
      maxTurns: 40,
    };
    return {
      ...base,
      taskId: `task-p-${index}`,
      groupMode: "parallel",
      mode: "single",
      items: [item],
    };
  });

  for (let i = 0; i < parallelSpecs.length; i++) {
    assertEqual(parallelSpecs[i].mode, "single", `parallel child ${i} has mode=single`);
    assertEqual(parallelSpecs[i].groupMode, "parallel", `parallel child ${i} has groupMode=parallel`);
    assertEqual(parallelSpecs[i].items.length, 1, `parallel child ${i} carries exactly one item`);
    assertEqual(parallelSpecs[i].items[0].index, i, `parallel child ${i} preserves the original index`);
  }
  const reconstructOrder = [...parallelSpecs]
    .sort((a, b) => a.items[0].index - b.items[0].index)
    .map((spec) => spec.items[0].prompt);
  assertEqual(reconstructOrder.join("|"), parallelPrompts.join("|"), "original parallel order reconstructs from item.index");

  // Chain group -> one spec executing the whole chain in original order.
  const chainSteps = ["step one", "step two", "step three"];
  const chainSpec: AgentTaskSpec = {
    ...base,
    taskId: "task-chain-1",
    groupId: "group-chain-1",
    groupMode: "chain",
    mode: "chain",
    items: chainSteps.map((prompt, index): AgentTaskItemSpec => ({
      resolution: "ready",
      index,
      prompt,
      description: `chain step ${index + 1}`,
      agent: {
        name: "general-purpose",
        description: "General purpose",
        systemPrompt: "You are a general purpose agent.",
        source: "built-in",
      },
      model: { provider: "provider", modelId: "model-id" },
      maxTurns: 40,
    })),
  };
  assertEqual(chainSpec.mode, "chain", "chain spec has mode=chain");
  assertEqual(chainSpec.groupMode, "chain", "chain spec has groupMode=chain");
  assertEqual(chainSpec.items.length, 3, "chain spec keeps all steps in one spec");
  assertEqual(
    chainSpec.items.map((item) => item.prompt).join("|"),
    chainSteps.join("|"),
    "chain spec preserves step order",
  );

  // Single group -> one mode=single spec.
  const singleSpec: AgentTaskSpec = {
    ...base,
    taskId: "task-single-1",
    groupId: "group-single-1",
    groupMode: "single",
    mode: "single",
    items: [{
      resolution: "ready",
      index: 0,
      prompt: "single prompt",
      description: "single task",
      agent: {
        name: "general-purpose",
        description: "General purpose",
        systemPrompt: "You are a general purpose agent.",
        source: "built-in",
      },
      model: { provider: "provider", modelId: "model-id" },
      maxTurns: 40,
    }],
  };
  assertEqual(singleSpec.mode, "single", "single spec has mode=single");
  assertEqual(singleSpec.groupMode, "single", "single spec has groupMode=single");
  assertEqual(singleSpec.items.length, 1, "single spec carries exactly one item");

  // Rejected item variant (preflight failure keeps its slot/order).
  const rejectedItem: AgentTaskItemSpec = {
    resolution: "rejected",
    index: 2,
    prompt: "task gamma",
    description: "step 2",
    requestedAgentName: "unavailable-agent",
    failureReason: "unknown_agent",
    errorMessage: "no such agent",
  };
  assertEqual(rejectedItem.resolution, "rejected", "rejected item keeps its resolution");
  assertEqual(rejectedItem.index, 2, "rejected item keeps the original index");

  // Specs are plain data: JSON round-trip preserves mode/groupMode/items order.
  const chainRoundTripped = JSON.parse(JSON.stringify(chainSpec)) as AgentTaskSpec;
  assertEqual(chainRoundTripped.mode, "chain", "chain spec survives JSON round-trip");
  assertEqual(chainRoundTripped.items.length, 3, "chain spec items survive JSON round-trip");
  assertEqual(
    chainRoundTripped.items.map((item) => item.index).join(","),
    "0,1,2",
    "chain spec item order survives JSON round-trip",
  );
});

// ============================================================================
// workspaceIdOf: sha1(physicalPath) like team-persistence.ts
// ============================================================================

run("workspaceIdOf", async () => {
  // Literal pins: UTF-8 string input, lowercase hex output (40 chars), same
  // hashing as team-persistence.ts teamSnapshotPath/workspaceModePath.
  assertEqual(
    workspaceIdOf("C:/projects/demo"),
    "e3a7b99dd92c8fafbe98d4c977385004b9921793",
    "windows path hash matches the pinned sha1",
  );
  assertEqual(
    workspaceIdOf("E:/develop/pi/pix"),
    "dbee86ebaac9f2b2862d92b7e1ce528a9d538438",
    "second windows path hash matches the pinned sha1",
  );
  assertEqual(
    workspaceIdOf("/home/user/项目 demo"),
    "23e22e432f1e7757b07db1ec85b918f32a049d2a",
    "non-ascii path hash matches the pinned utf8 sha1",
  );

  // Contract equivalence with team-persistence hashing (sha1 of the raw path
  // string, hex digest).
  for (const path of ["C:/projects/demo", "E:/develop/pi/pix", "/home/user/项目 demo", "D:/a b c/demo"]) {
    assertEqual(
      workspaceIdOf(path),
      createHash("sha1").update(path).digest("hex"),
      `workspaceIdOf matches createHash sha1 hex for ${path}`,
    );
  }

  assertEqual(workspaceIdOf("C:/projects/demo"), workspaceIdOf("C:/projects/demo"), "workspaceIdOf is deterministic");
  assert(workspaceIdOf("C:/projects/demo") !== workspaceIdOf("C:/projects/other"), "distinct paths yield distinct ids");
  assert(/^[0-9a-f]{40}$/.test(workspaceIdOf("C:/projects/demo")), "workspace id is 40 lowercase hex chars");
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
