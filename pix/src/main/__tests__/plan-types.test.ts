/**
 * Shared Plan contract tests (F3).
 *
 * Independently verifies pix/src/shared/plan-types.ts: the shape guards
 * (isPlanStep/isPlan/isPlanRuntimeSnapshot) against valid fixtures and
 * malformed variants (missing/wrong schemaVersion, wrong enums, NaN/negative
 * numbers, step-count bounds, optional-field types, generation/revision/
 * failure/deviation shapes), the 1.4.0 version gate (no "interrupted", no
 * task-group fields), the locked transition tables, and the guard scope
 * boundary: the guards never access the process cwd and never judge
 * DAG/workspace or cross-field conditional semantics (those live in
 * plan-controller and plan-deviation). Does not depend on the controller or
 * core implementation, so F3 runs standalone.
 *
 * Run with: npm exec tsx -- src/main/__tests__/plan-types.test.ts
 */

import {
  PLAN_ALLOWLIST,
  PLAN_MAX_STEPS,
  PLAN_MIN_STEPS,
  PLAN_SCHEMA_VERSION,
  PLAN_STEP_TRANSITIONS,
  PLAN_TRANSITIONS,
  isPlan,
  isPlanRuntimeSnapshot,
  isPlanStep,
} from "../../shared/plan-types.js";

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

function makePlanningModelInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    thinkingLevel: "high",
    ...overrides,
  };
}

function makeStepInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    stepKey: "step-1",
    stepId: "s-1",
    title: "Add auth middleware",
    description: "Add auth middleware to the API layer",
    files: [{ path: "src/auth.ts", operation: "create" }],
    executionTarget: "parent",
    risk: "medium",
    riskReason: "modifies authentication paths",
    effort: "medium",
    verification: "npm test",
    dependsOn: [],
    status: "pending",
    waitingReason: "",
    ...overrides,
  };
}

function makePlanInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId: "plan-1",
    version: 1,
    status: "awaiting_approval",
    title: "Add auth",
    summary: "Add auth middleware",
    planningModel: makePlanningModelInput(),
    steps: [makeStepInput()],
    createdAt: STARTED,
    updatedAt: STARTED,
    ...overrides,
  };
}

function makeGenerationInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    generationId: "gen-1",
    kind: "initial",
    requestedVersion: 1,
    concise: false,
    model: makePlanningModelInput(),
    startedAt: STARTED,
    ...overrides,
  };
}

function makeRevisionInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    baseVersion: 1,
    requestedVersion: 2,
    feedback: "split step 2 into two steps",
    ...overrides,
  };
}

function makeFailureInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    generationId: "gen-1",
    phase: "initial",
    code: "model_unavailable",
    message: "planning model unavailable",
    fieldErrors: [],
    retryable: true,
    occurredAt: STARTED,
    ...overrides,
  };
}

function makeDeviationInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: "file_out_of_scope",
    stepId: "s-1",
    toolCallId: "tool-1",
    path: "src/unrelated.ts",
    reason: "file not in the approved scope",
    detectedAt: STARTED,
    ...overrides,
  };
}

function makeSnapshotInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    phase: "awaiting_approval",
    planId: "plan-1",
    plan: makePlanInput(),
    deviations: [],
    updatedAt: ENDED,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

await run("contract constants match the locked values", async () => {
  assertEqual(PLAN_SCHEMA_VERSION, 1, "PLAN_SCHEMA_VERSION === 1");
  assertEqual(PLAN_MAX_STEPS, 20, "PLAN_MAX_STEPS === 20");
  assertEqual(PLAN_MIN_STEPS, 1, "PLAN_MIN_STEPS === 1");
  assertEqual(
    PLAN_ALLOWLIST.join(","),
    "read,grep,find,ls,request_user_input,submit_user_plan",
    "PLAN_ALLOWLIST is the locked planning-phase tool whitelist",
  );
});

await run("isPlanStep: accepts valid steps", async () => {
  assert(isPlanStep(makeStepInput()), "valid parent-execution step accepted");

  const foreground = makeStepInput({ executionTarget: "subagent_foreground" });
  assert(isPlanStep(foreground), "subagent_foreground step accepted");

  const background = makeStepInput({ executionTarget: "subagent_background" });
  assert(isPlanStep(background), "subagent_background step accepted (1.4.0 guard is shape-only; submitPlan rejection lives in the controller)");

  const waiting = makeStepInput({
    status: "waiting_input",
    waitingReason: "user_input",
  });
  assert(isPlanStep(waiting), "waiting_input step accepted");

  const emptyFiles = makeStepInput({ files: [] });
  assert(isPlanStep(emptyFiles), "step with empty files accepted");

  const completed = makeStepInput({
    status: "completed",
    completionSummary: "auth middleware added",
    verificationResult: { status: "passed", summary: "npm test green" },
  });
  assert(isPlanStep(completed), "completed step with evidence accepted");

  const optional = makeStepInput({
    scopeNote: "no files changed by this step",
    expectedCommands: ["npm run lint"],
    completionSummary: undefined,
    verificationResult: undefined,
  });
  assert(isPlanStep(optional), "step with optional fields accepted");

  const allOperations = makeStepInput({
    files: [
      { path: "a.ts", operation: "read" },
      { path: "b.ts", operation: "create" },
      { path: "c.ts", operation: "modify" },
      { path: "d.ts", operation: "delete" },
    ],
  });
  assert(isPlanStep(allOperations), "step with all four file operations accepted");
});

await run("isPlanStep: rejects missing required fields and wrong types", async () => {
  assert(!isPlanStep(makeStepInput({ stepKey: undefined })), "missing stepKey rejected");
  assert(!isPlanStep(makeStepInput({ stepId: undefined })), "missing stepId rejected");
  assert(!isPlanStep(makeStepInput({ title: undefined })), "missing title rejected");
  assert(!isPlanStep(makeStepInput({ description: undefined })), "missing description rejected");
  assert(!isPlanStep(makeStepInput({ files: undefined })), "missing files rejected");
  assert(!isPlanStep(makeStepInput({ files: "not-an-array" })), "non-array files rejected");
  assert(!isPlanStep(makeStepInput({ files: [null] })), "null file entry rejected");
  assert(!isPlanStep(makeStepInput({ files: [{ path: "a.ts" }] })), "file missing operation rejected");
  assert(!isPlanStep(makeStepInput({ files: [{ operation: "create" }] })), "file missing path rejected");
  assert(!isPlanStep(makeStepInput({ executionTarget: undefined })), "missing executionTarget rejected");
  assert(!isPlanStep(makeStepInput({ risk: undefined })), "missing risk rejected");
  assert(!isPlanStep(makeStepInput({ riskReason: undefined })), "missing riskReason rejected");
  assert(!isPlanStep(makeStepInput({ effort: undefined })), "missing effort rejected");
  assert(!isPlanStep(makeStepInput({ verification: undefined })), "missing verification rejected");
  assert(!isPlanStep(makeStepInput({ dependsOn: undefined })), "missing dependsOn rejected");
  assert(!isPlanStep(makeStepInput({ dependsOn: [1] })), "non-string dependsOn entry rejected");
  assert(!isPlanStep(makeStepInput({ status: undefined })), "missing status rejected");
  assert(!isPlanStep(makeStepInput({ waitingReason: undefined })), "missing waitingReason rejected");
  assert(!isPlanStep(null), "null rejected");
  assert(!isPlanStep(undefined), "undefined rejected");
  assert(!isPlanStep(42), "non-object rejected");
  assert(!isPlanStep("step"), "string rejected");
});

await run("isPlanStep: rejects wrong enum values", async () => {
  assert(!isPlanStep(makeStepInput({ executionTarget: "host" })), "bad executionTarget rejected");
  assert(!isPlanStep(makeStepInput({ risk: "critical" })), "bad risk rejected");
  assert(!isPlanStep(makeStepInput({ effort: "huge" })), "bad effort rejected");
  assert(!isPlanStep(makeStepInput({ status: "finished" })), "bad status rejected");
  assert(!isPlanStep(makeStepInput({ waitingReason: "clarification" })), "bad waitingReason rejected");
  assert(
    !isPlanStep(makeStepInput({ files: [{ path: "a.ts", operation: "append" }] })),
    "bad file operation rejected",
  );
  assert(
    !isPlanStep(
      makeStepInput({ verificationResult: { status: "unknown", summary: "x" } }),
    ),
    "bad verification status rejected",
  );
});

await run("isPlanStep: validates optional field types", async () => {
  assert(!isPlanStep(makeStepInput({ scopeNote: 5 })), "non-string scopeNote rejected");
  assert(!isPlanStep(makeStepInput({ expectedCommands: "npm test" })), "non-array expectedCommands rejected");
  assert(
    !isPlanStep(makeStepInput({ expectedCommands: ["npm test", 3] })),
    "non-string expectedCommands entry rejected",
  );
  assert(!isPlanStep(makeStepInput({ completionSummary: 7 })), "non-string completionSummary rejected");
  assert(
    !isPlanStep(makeStepInput({ verificationResult: "passed" })),
    "non-object verificationResult rejected",
  );
  assert(
    !isPlanStep(makeStepInput({ verificationResult: { status: "passed" } })),
    "verificationResult missing summary rejected",
  );
  assert(
    !isPlanStep(makeStepInput({ verificationResult: { status: "failed", summary: 5 } })),
    "non-string verificationResult summary rejected",
  );
});

await run("isPlan: accepts valid plans", async () => {
  assert(isPlan(makePlanInput()), "valid awaiting_approval plan accepted");

  const single = makePlanInput({
    steps: Array.from({ length: PLAN_MAX_STEPS }, (_, i) =>
      makeStepInput({ stepKey: `step-${i}`, stepId: `s-${i}` }),
    ),
  });
  assert(isPlan(single), `plan with exactly ${PLAN_MAX_STEPS} steps accepted`);

  for (const status of ["planning", "planning_failed", "revising", "approved", "executing", "paused", "completed", "failed", "cancelled"]) {
    assert(isPlan(makePlanInput({ status })), `plan with status ${status} accepted`);
  }

  const thinkingVariants = ["off", "minimal", "low", "medium", "high", "xhigh"];
  for (const thinkingLevel of thinkingVariants) {
    assert(
      isPlan(makePlanInput({ planningModel: makePlanningModelInput({ thinkingLevel }) })),
      `planningModel thinkingLevel ${thinkingLevel} accepted`,
    );
  }
});

await run("isPlan: rejects missing/wrong schemaVersion and required fields", async () => {
  assert(!isPlan(makePlanInput({ schemaVersion: undefined })), "missing schemaVersion rejected");
  assert(!isPlan(makePlanInput({ schemaVersion: 2 })), "schemaVersion 2 rejected");
  assert(!isPlan(makePlanInput({ schemaVersion: "1" })), "string schemaVersion rejected");
  assert(!isPlan(makePlanInput({ planId: undefined })), "missing planId rejected");
  assert(!isPlan(makePlanInput({ version: undefined })), "missing version rejected");
  assert(!isPlan(makePlanInput({ status: undefined })), "missing status rejected");
  assert(!isPlan(makePlanInput({ title: undefined })), "missing title rejected");
  assert(!isPlan(makePlanInput({ summary: undefined })), "missing summary rejected");
  assert(!isPlan(makePlanInput({ planningModel: undefined })), "missing planningModel rejected");
  assert(!isPlan(makePlanInput({ steps: undefined })), "missing steps rejected");
  assert(!isPlan(makePlanInput({ steps: "not-an-array" })), "non-array steps rejected");
  assert(!isPlan(makePlanInput({ steps: [null] })), "null step entry rejected");
  assert(!isPlan(makePlanInput({ steps: [makeStepInput({ status: "bad" })] })), "invalid step entry rejected");
  assert(!isPlan(makePlanInput({ createdAt: undefined })), "missing createdAt rejected");
  assert(!isPlan(makePlanInput({ updatedAt: undefined })), "missing updatedAt rejected");
  assert(!isPlan(null), "null rejected");
  assert(!isPlan(undefined), "undefined rejected");
});

await run("isPlan: rejects wrong plan and planningModel fields", async () => {
  assert(!isPlan(makePlanInput({ status: "interrupted" })), "status interrupted rejected");
  assert(!isPlan(makePlanInput({ status: "done" })), "bad status rejected");
  assert(
    !isPlan(makePlanInput({ planningModel: makePlanningModelInput({ provider: 5 }) })),
    "non-string provider rejected",
  );
  assert(
    !isPlan(makePlanInput({ planningModel: makePlanningModelInput({ modelId: 5 }) })),
    "non-string modelId rejected",
  );
  assert(
    !isPlan(makePlanInput({ planningModel: makePlanningModelInput({ thinkingLevel: "ultra" }) })),
    "bad thinkingLevel rejected",
  );
});

await run("isPlan: rejects step-count bounds violations", async () => {
  assert(!isPlan(makePlanInput({ steps: [] })), "plan with zero steps rejected");
  assert(
    !isPlan(
      makePlanInput({
        steps: Array.from({ length: PLAN_MAX_STEPS + 1 }, (_, i) =>
          makeStepInput({ stepKey: `step-${i}`, stepId: `s-${i}` }),
        ),
      }),
    ),
    `plan with more than ${PLAN_MAX_STEPS} steps rejected`,
  );
  assert(
    isPlan(makePlanInput({ steps: [makeStepInput()] })),
    "plan with exactly PLAN_MIN_STEPS steps accepted",
  );
});

await run("isPlan: rejects NaN, negative and non-finite numbers", async () => {
  assert(!isPlan(makePlanInput({ version: NaN })), "NaN version rejected");
  assert(!isPlan(makePlanInput({ version: Infinity })), "Infinity version rejected");
  assert(!isPlan(makePlanInput({ version: -1 })), "negative version rejected");
  assert(!isPlan(makePlanInput({ createdAt: NaN })), "NaN createdAt rejected");
  assert(!isPlan(makePlanInput({ createdAt: Infinity })), "Infinity createdAt rejected");
  assert(!isPlan(makePlanInput({ updatedAt: -1 })), "negative updatedAt rejected");
});

await run("isPlanRuntimeSnapshot: accepts valid snapshots", async () => {
  assert(isPlanRuntimeSnapshot(makeSnapshotInput()), "valid snapshot with plan accepted");

  const prePlanning = makeSnapshotInput({ phase: "planning", planId: null, plan: null });
  assert(isPlanRuntimeSnapshot(prePlanning), "snapshot before any valid plan (planId/plan null) accepted");

  const planningFailed = makeSnapshotInput({
    phase: "planning_failed",
    planId: null,
    plan: null,
    failure: makeFailureInput(),
  });
  assert(isPlanRuntimeSnapshot(planningFailed), "planning_failed snapshot with failure accepted");

  const revising = makeSnapshotInput({
    phase: "revising",
    plan: makePlanInput(),
    lastValidPlan: makePlanInput({ version: 1 }),
    generation: makeGenerationInput({ kind: "revision", requestedVersion: 2 }),
    revision: makeRevisionInput(),
  });
  assert(isPlanRuntimeSnapshot(revising), "revising snapshot with lastValidPlan/generation/revision accepted");

  const executing = makeSnapshotInput({
    phase: "executing",
    plan: makePlanInput({ status: "executing" }),
    deviations: [makeDeviationInput()],
  });
  assert(isPlanRuntimeSnapshot(executing), "executing snapshot with a deviation accepted");

  const completed = makeSnapshotInput({
    phase: "completed",
    plan: makePlanInput({ status: "completed" }),
  });
  assert(isPlanRuntimeSnapshot(completed), "completed snapshot accepted");

  const paused = makeSnapshotInput({ phase: "paused", plan: makePlanInput({ status: "paused" }) });
  assert(isPlanRuntimeSnapshot(paused), "paused snapshot accepted");

  for (const phase of ["approved", "failed", "cancelled"]) {
    assert(isPlanRuntimeSnapshot(makeSnapshotInput({ phase })), `snapshot with phase ${phase} accepted`);
  }
});

await run("isPlanRuntimeSnapshot: rejects missing/wrong schemaVersion and required fields", async () => {
  assert(!isPlanRuntimeSnapshot(makeSnapshotInput({ schemaVersion: undefined })), "missing schemaVersion rejected");
  assert(!isPlanRuntimeSnapshot(makeSnapshotInput({ schemaVersion: 2 })), "schemaVersion 2 rejected");
  assert(!isPlanRuntimeSnapshot(makeSnapshotInput({ phase: undefined })), "missing phase rejected");
  assert(!isPlanRuntimeSnapshot(makeSnapshotInput({ planId: undefined })), "missing planId rejected");
  assert(!isPlanRuntimeSnapshot(makeSnapshotInput({ plan: undefined })), "missing plan rejected");
  assert(!isPlanRuntimeSnapshot(makeSnapshotInput({ deviations: undefined })), "missing deviations rejected");
  assert(!isPlanRuntimeSnapshot(makeSnapshotInput({ deviations: "x" })), "non-array deviations rejected");
  assert(!isPlanRuntimeSnapshot(makeSnapshotInput({ updatedAt: undefined })), "missing updatedAt rejected");
  assert(!isPlanRuntimeSnapshot(null), "null rejected");
  assert(!isPlanRuntimeSnapshot(undefined), "undefined rejected");
  assert(!isPlanRuntimeSnapshot(42), "non-object rejected");
});

await run("isPlanRuntimeSnapshot: rejects wrong phase/planId/plan and non-finite numbers", async () => {
  assert(!isPlanRuntimeSnapshot(makeSnapshotInput({ phase: "done" })), "bad phase rejected");
  assert(!isPlanRuntimeSnapshot(makeSnapshotInput({ planId: 5 })), "non-string non-null planId rejected");
  assert(
    !isPlanRuntimeSnapshot(makeSnapshotInput({ plan: makePlanInput({ schemaVersion: 2 }) })),
    "plan with wrong schemaVersion rejected inside snapshot",
  );
  assert(
    !isPlanRuntimeSnapshot(makeSnapshotInput({ plan: { schemaVersion: 1, steps: [] } })),
    "structurally invalid plan rejected inside snapshot",
  );
  assert(
    !isPlanRuntimeSnapshot(makeSnapshotInput({ lastValidPlan: { schemaVersion: 1 } })),
    "invalid lastValidPlan rejected",
  );
  assert(
    !isPlanRuntimeSnapshot(makeSnapshotInput({ deviations: [makeDeviationInput({ type: "network_call" })] })),
    "bad deviation type rejected",
  );
  assert(
    !isPlanRuntimeSnapshot(makeSnapshotInput({ deviations: [makeDeviationInput({ detectedAt: NaN })] })),
    "NaN deviation detectedAt rejected",
  );
  assert(
    !isPlanRuntimeSnapshot(makeSnapshotInput({ deviations: [makeDeviationInput({ path: 5 })] })),
    "non-string deviation path rejected",
  );
  assert(!isPlanRuntimeSnapshot(makeSnapshotInput({ updatedAt: NaN })), "NaN updatedAt rejected");
  assert(!isPlanRuntimeSnapshot(makeSnapshotInput({ updatedAt: Infinity })), "Infinity updatedAt rejected");
});

await run("isPlanRuntimeSnapshot: validates generation/revision/failure shapes", async () => {
  assert(
    !isPlanRuntimeSnapshot(makeSnapshotInput({ generation: makeGenerationInput({ kind: "bogus" }) })),
    "bad generation kind rejected",
  );
  assert(
    !isPlanRuntimeSnapshot(makeSnapshotInput({ generation: makeGenerationInput({ concise: "yes" }) })),
    "non-boolean generation concise rejected",
  );
  assert(
    !isPlanRuntimeSnapshot(
      makeSnapshotInput({ generation: makeGenerationInput({ model: makePlanningModelInput({ thinkingLevel: "ultra" }) }) }),
    ),
    "bad generation model thinkingLevel rejected",
  );
  assert(
    !isPlanRuntimeSnapshot(makeSnapshotInput({ generation: makeGenerationInput({ startedAt: -1 }) })),
    "negative generation startedAt rejected",
  );
  assert(
    !isPlanRuntimeSnapshot(makeSnapshotInput({ revision: makeRevisionInput({ feedback: 5 }) })),
    "non-string revision feedback rejected",
  );
  assert(
    !isPlanRuntimeSnapshot(makeSnapshotInput({ revision: makeRevisionInput({ stepKey: 5 }) })),
    "non-string revision stepKey rejected",
  );
  assert(
    !isPlanRuntimeSnapshot(makeSnapshotInput({ revision: makeRevisionInput({ baseVersion: NaN }) })),
    "NaN revision baseVersion rejected",
  );
  assert(
    !isPlanRuntimeSnapshot(makeSnapshotInput({ failure: makeFailureInput({ phase: "planning" }) })),
    "bad failure phase rejected",
  );
  assert(
    !isPlanRuntimeSnapshot(makeSnapshotInput({ failure: makeFailureInput({ code: "bogus" }) })),
    "bad failure code rejected",
  );
  assert(
    !isPlanRuntimeSnapshot(makeSnapshotInput({ failure: makeFailureInput({ fieldErrors: [{ path: 1, message: "x" }] }) })),
    "bad failure fieldErrors entry rejected",
  );
  assert(
    !isPlanRuntimeSnapshot(makeSnapshotInput({ failure: makeFailureInput({ retryable: "yes" }) })),
    "non-boolean failure retryable rejected",
  );
  assert(
    !isPlanRuntimeSnapshot(makeSnapshotInput({ failure: makeFailureInput({ occurredAt: Infinity }) })),
    "Infinity failure occurredAt rejected",
  );
});

await run("guards never access the process cwd", async () => {
  const originalCwd = process.cwd;
  process.cwd = () => {
    throw new Error("guards must not call process.cwd");
  };
  try {
    assert(isPlanStep(makeStepInput()), "isPlanStep accepts valid input with cwd stubbed to throw");
    assert(isPlan(makePlanInput()), "isPlan accepts valid input with cwd stubbed to throw");
    assert(
      isPlanRuntimeSnapshot(makeSnapshotInput()),
      "isPlanRuntimeSnapshot accepts valid input with cwd stubbed to throw",
    );
    assert(
      !isPlan(makePlanInput({ steps: [] })),
      "isPlan rejections also avoid cwd with cwd stubbed to throw",
    );
    assert(
      !isPlanRuntimeSnapshot(makeSnapshotInput({ phase: "bogus" })),
      "isPlanRuntimeSnapshot rejections also avoid cwd with cwd stubbed to throw",
    );
  } finally {
    process.cwd = originalCwd;
  }
  assertEqual(process.cwd(), originalCwd(), "process.cwd restored after the stubbed window");
});

await run("DAG and workspace semantics are not inside the guards", async () => {
  const cyclic = makePlanInput({
    steps: [
      makeStepInput({ stepKey: "a", stepId: "s-1", dependsOn: ["s-2"] }),
      makeStepInput({ stepKey: "b", stepId: "s-2", dependsOn: ["s-1"] }),
    ],
  });
  assert(isPlan(cyclic), "cyclic dependsOn DAG accepted (DAG validation lives in plan-controller)");

  const dangling = makePlanInput({
    steps: [makeStepInput({ dependsOn: ["missing-step-id"] })],
  });
  assert(isPlan(dangling), "dependsOn referencing unknown stepId accepted (DAG validation lives in plan-controller)");

  const duplicateKeys = makePlanInput({
    steps: [
      makeStepInput({ stepKey: "same", stepId: "s-1" }),
      makeStepInput({ stepKey: "same", stepId: "s-2" }),
    ],
  });
  assert(isPlan(duplicateKeys), "duplicate stepKey accepted (uniqueness validation lives in plan-controller)");

  const outsidePaths = makePlanInput({
    steps: [
      makeStepInput({
        files: [
          { path: "C:\\Windows\\System32\\x.dll", operation: "modify" },
          { path: "../../../outside", operation: "delete" },
        ],
      }),
    ],
  });
  assert(isPlan(outsidePaths), "file paths outside any workspace accepted (workspace/cwd semantics live in plan-deviation)");

  const emptyFilesNoNote = makePlanInput({ steps: [makeStepInput({ files: [] })] });
  assert(isPlan(emptyFilesNoNote), "empty files without scopeNote accepted (files/scopeNote coupling lives in plan-controller)");
});

await run("cross-field conditional semantics are not inside the guards", async () => {
  assert(
    isPlanStep(makeStepInput({ status: "pending", waitingReason: "agent_task" })),
    "pending step with non-empty waitingReason accepted (conditional-field semantics live in plan-controller)",
  );
  assert(
    isPlanStep(makeStepInput({ status: "waiting_input", waitingReason: "" })),
    "waiting_input with empty waitingReason accepted (conditional-field semantics live in plan-controller)",
  );
  assert(
    isPlanStep(makeStepInput({ status: "completed", completionSummary: undefined, verificationResult: undefined })),
    "completed step without completionSummary/verificationResult accepted (conditional-field semantics live in plan-controller)",
  );
  assert(
    isPlanStep(makeStepInput({ status: "completed", completionSummary: "done", verificationResult: { status: "failed", summary: "x" } })),
    "completed step with failed verificationResult accepted (conditional-field semantics live in plan-controller)",
  );
  const inconsistentEnvelope = makeSnapshotInput({
    phase: "awaiting_approval",
    plan: makePlanInput({ status: "completed" }),
  });
  assert(
    isPlanRuntimeSnapshot(inconsistentEnvelope),
    "snapshot whose plan.status disagrees with phase accepted (envelope consistency lives in plan-controller)",
  );
});

await run("version gate: interrupted step status accepted (1.4.2 R4), PlanStatus unaffected, task-group fields tolerated, unknown schema rejected", async () => {
  assert(isPlanStep(makeStepInput({ status: "interrupted" })), "interrupted step status accepted (1.4.2 R4)");
  assert(!isPlan(makePlanInput({ status: "interrupted" })), "plan with interrupted status rejected (PlanStatus has no interrupted)");
  assert(
    Object.prototype.hasOwnProperty.call(PLAN_STEP_TRANSITIONS, "interrupted"),
    "PLAN_STEP_TRANSITIONS has interrupted key (1.4.2 R4)",
  );
  assert(
    !Object.keys(PLAN_TRANSITIONS).some((k) => PLAN_TRANSITIONS[k as keyof typeof PLAN_TRANSITIONS].includes("interrupted")),
    "PLAN_TRANSITIONS targets contain no interrupted in 1.4.0",
  );
  assert(
    isPlanStep(makeStepInput({ waitingTaskGroupId: "g-1", consumedTaskGroupId: "g-1", consumedTaskSummary: "done" })),
    "unknown 1.4.1 task-group fields tolerated by the 1.4.0 guard",
  );
  assert(
    isPlanRuntimeSnapshot(makeSnapshotInput({ pendingTaskLinkReleases: [] })),
    "unknown 1.4.1 pendingTaskLinkReleases tolerated by the 1.4.0 snapshot guard",
  );
});

await run("PLAN_TRANSITIONS: covers every status with valid targets", async () => {
  const statuses = Object.keys(PLAN_TRANSITIONS);
  assertEqual(statuses.length, 10, "PLAN_TRANSITIONS covers all 10 PlanStatus values");
  for (const [from, targets] of Object.entries(PLAN_TRANSITIONS)) {
    assert(!targets.includes(from), `${from} does not transition to itself`);
    for (const target of targets) {
      assert(statuses.includes(target), `${from} -> ${target} is a known PlanStatus`);
    }
  }
  assertEqual(PLAN_TRANSITIONS.completed.length, 0, "completed is terminal (no outgoing transitions)");
  assertEqual(PLAN_TRANSITIONS.failed.length, 0, "failed is terminal (no outgoing transitions)");
  assertEqual(PLAN_TRANSITIONS.cancelled.length, 0, "cancelled is terminal (no outgoing transitions)");
});

await run("PLAN_TRANSITIONS: matches the locked table exactly", async () => {
  assertEqual(
    JSON.stringify(PLAN_TRANSITIONS),
    JSON.stringify({
      planning: ["awaiting_approval", "planning_failed", "cancelled"],
      planning_failed: ["planning", "cancelled"],
      awaiting_approval: ["revising", "approved", "cancelled"],
      revising: ["awaiting_approval", "cancelled"],
      approved: ["executing", "cancelled"],
      executing: ["paused", "completed", "failed", "cancelled"],
      paused: ["executing", "completed", "revising", "failed", "cancelled"],
      completed: [],
      failed: [],
      cancelled: [],
    }),
    "PLAN_TRANSITIONS matches the §4.1 locked table",
  );
});

await run("PLAN_STEP_TRANSITIONS: covers every status with valid targets", async () => {
  const statuses = Object.keys(PLAN_STEP_TRANSITIONS);
  assertEqual(statuses.length, 8, "PLAN_STEP_TRANSITIONS covers all 8 PlanStepStatus values (incl. interrupted, 1.4.2 R4)");
  for (const [from, targets] of Object.entries(PLAN_STEP_TRANSITIONS)) {
    assert(!targets.includes(from), `step status ${from} does not transition to itself`);
    for (const target of targets) {
      assert(statuses.includes(target), `step status ${from} -> ${target} is a known PlanStepStatus`);
    }
  }
  assertEqual(PLAN_STEP_TRANSITIONS.completed.length, 0, "completed step is terminal");
  assertEqual(PLAN_STEP_TRANSITIONS.failed.length, 0, "failed step is terminal (retry is a controller special-case)");
  assertEqual(PLAN_STEP_TRANSITIONS.skipped.length, 0, "skipped step is terminal");
  assertEqual(PLAN_STEP_TRANSITIONS.cancelled.length, 0, "cancelled step is terminal");
});

await run("PLAN_STEP_TRANSITIONS: matches the locked table exactly", async () => {
  assertEqual(
    JSON.stringify(PLAN_STEP_TRANSITIONS),
    JSON.stringify({
      pending: ["running", "skipped", "cancelled"],
      running: ["waiting_input", "interrupted", "completed", "failed", "cancelled"],
      waiting_input: ["running", "interrupted", "failed", "cancelled"],
      interrupted: ["running", "failed", "cancelled"],
      completed: [],
      failed: [],
      skipped: [],
      cancelled: [],
    }),
    "PLAN_STEP_TRANSITIONS matches the §4.1 locked table (incl. 1.4.2 R4 interrupted)",
  );
});

await run("guards never throw on arbitrary input", async () => {
  const inputs: unknown[] = [
    null,
    undefined,
    0,
    "plan",
    [],
    Symbol("x"),
    makeStepInput({ files: [null] }),
    makeStepInput({ verificationResult: [null] }),
    makePlanInput({ steps: [null] }),
    makePlanInput({ planningModel: null }),
    makeSnapshotInput({ plan: [null] }),
    makeSnapshotInput({ deviations: [null] }),
    makeSnapshotInput({ generation: null }),
    makeSnapshotInput({ revision: null }),
    makeSnapshotInput({ failure: null }),
  ];
  for (const input of inputs) {
    let threw = false;
    try {
      isPlanStep(input);
      isPlan(input);
      isPlanRuntimeSnapshot(input);
    } catch {
      threw = true;
    }
    assert(!threw, `guards do not throw (input type ${typeof input})`);
  }

  const cyclicArray: unknown[] = [];
  cyclicArray.push(cyclicArray);
  let threw = false;
  try {
    isPlan(makePlanInput({ steps: cyclicArray }));
  } catch {
    threw = true;
  }
  assert(!threw, "isPlan does not throw on cyclic steps array");

  const cyclicStep: Record<string, unknown> = { ...(makeStepInput() as Record<string, unknown>) };
  cyclicStep.files = [cyclicStep];
  threw = false;
  try {
    isPlanStep(cyclicStep);
  } catch {
    threw = true;
  }
  assert(!threw, "isPlanStep does not throw on cyclic file entry");

  const cyclicSnapshot: Record<string, unknown> = { ...(makeSnapshotInput() as Record<string, unknown>) };
  cyclicSnapshot.plan = cyclicSnapshot;
  threw = false;
  try {
    isPlanRuntimeSnapshot(cyclicSnapshot);
  } catch {
    threw = true;
  }
  assert(!threw, "isPlanRuntimeSnapshot does not throw on cyclic plan reference");
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
