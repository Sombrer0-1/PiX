/**
 * Terminal-task retention policy unit tests (design plan §6.3, 1.5 P1).
 *
 * Pure selection over plain-data candidates - the service integration (disk
 * deletion, index rewrite, task_removed emission, storage-full emergency
 * trigger) is covered by agent-task-recovery.test.ts / agent-task-ipc.test.ts.
 *
 * Run with: npm exec tsx -- src/main/__tests__/agent-task-retention.test.ts
 */

import {
  RETENTION_EMERGENCY_KEEP_COUNT,
  RETENTION_KEEP_AGE_MS,
  RETENTION_KEEP_COUNT,
  RETENTION_UNDELIVERED_GRACE_MS,
  isRetentionExempt,
  selectRetentionRemovals,
  type RetentionCandidate,
} from "../agent-task/agent-task-retention.js";

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
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const NOW = 10_000_000;

function candidate(overrides: Partial<RetentionCandidate> & { taskId: string }): RetentionCandidate {
  return {
    status: "completed",
    endedAt: NOW - 1000,
    planLinkState: "none",
    parentSessionId: "session-1",
    deliveredCount: 1,
    workflowOwned: false,
    ...overrides,
  };
}

{
  console.log("\n=== exemptions ===\n");
  assert(isRetentionExempt(candidate({ taskId: "a", planLinkState: "pending" }), NOW), "pending Plan link is exempt");
  assert(isRetentionExempt(candidate({ taskId: "a", workflowOwned: true }), NOW), "workflow-owned group is exempt");
  const undelivered = candidate({ taskId: "a", deliveredCount: 0 });
  assert(isRetentionExempt(undelivered, NOW), "undelivered result inside the grace window is exempt");
  assert(
    !isRetentionExempt(candidate({ taskId: "a", deliveredCount: 0, endedAt: NOW - RETENTION_UNDELIVERED_GRACE_MS - 1 }), NOW),
    "undelivered result past the grace window becomes eligible",
  );
  assert(
    !isRetentionExempt(candidate({ taskId: "a", deliveredCount: 0, parentSessionId: "" }), NOW),
    "no-parent task (nothing to deliver to) is never delivery-exempt",
  );
  assert(!isRetentionExempt(candidate({ taskId: "a" }), NOW), "delivered ordinary terminal task is eligible");
}

{
  console.log("\n=== keep window: newest KEEP_COUNT union KEEP_AGE ===\n");
  // 100 young tasks (inside the 30d floor) plus 20 ancient delivered ones:
  // the count window keeps the newest 100, the age floor keeps nothing extra,
  // so exactly the ancient twenty go.
  const tasks: RetentionCandidate[] = [];
  for (let i = 0; i < 100; i++) {
    tasks.push(candidate({ taskId: `t${String(i).padStart(3, "0")}`, endedAt: NOW - 1000 - i * 1000 }));
  }
  for (let i = 0; i < 20; i++) {
    tasks.push(candidate({ taskId: `a${String(i).padStart(3, "0")}`, endedAt: NOW - RETENTION_KEEP_AGE_MS - 10_000 - i * 1000 }));
  }
  const removals = selectRetentionRemovals(tasks, { now: NOW, emergency: false });
  assertEqual(removals.length, 20, "only the ancient twenty beyond the age floor and count window are removed");
  assert(removals.every((id) => id.startsWith("a")), "removals are exactly the ancient set");

  // Age floor union: with a single-slot count window the 15-day-old tasks
  // still survive through the 30d floor; dropping the floor removes them.
  const midAge = NOW - RETENTION_KEEP_AGE_MS / 2;
  const mixed = [
    candidate({ taskId: "old-1", endedAt: midAge }),
    candidate({ taskId: "old-2", endedAt: midAge + 1 }),
    candidate({ taskId: "new-1", endedAt: NOW - 1000 }),
  ];
  const withAge = selectRetentionRemovals(mixed, { now: NOW, emergency: false, keepCount: 1 });
  assertEqual(withAge, [], "age floor keeps the mid-age tasks even outside the count window");
  const withoutAge = selectRetentionRemovals(mixed, { now: NOW, emergency: false, keepCount: 1, keepAgeMs: 0 });
  assertEqual(withoutAge, ["old-1", "old-2"], "age floor removed -> mid-age delivered tasks go");

  // Exemptions always win, even with every window closed.
  const ancient = NOW - RETENTION_KEEP_AGE_MS - 10_000;
  const protectedSet = [
    candidate({ taskId: "pending", endedAt: ancient, planLinkState: "pending" }),
    candidate({ taskId: "workflow", endedAt: ancient, workflowOwned: true }),
    candidate({ taskId: "undelivered", endedAt: NOW - 2000, deliveredCount: 0 }),
  ];
  assertEqual(
    selectRetentionRemovals(protectedSet, { now: NOW, emergency: false, keepCount: 0, keepAgeMs: 0 }),
    [],
    "no exemption is ever deleted by the normal window",
  );
  assertEqual(
    selectRetentionRemovals(protectedSet, { now: NOW, emergency: true, emergencyKeepCount: 0 }),
    [],
    "no exemption is ever deleted in emergency mode either",
  );
}

{
  console.log("\n=== emergency mode ===\n");
  const tasks: RetentionCandidate[] = [];
  for (let i = 0; i < 30; i++) {
    tasks.push(candidate({ taskId: `e${String(i).padStart(2, "0")}`, endedAt: NOW - 1000 - i * 1000 }));
  }
  // All within the 30d age floor: normal mode keeps everything; emergency
  // ignores age and keeps only the newest EMERGENCY_KEEP_COUNT. Index 0 is the
  // NEWEST (largest endedAt), so the removals are indices 20..29.
  assertEqual(selectRetentionRemovals(tasks, { now: NOW, emergency: false }).length, 0, "normal mode keeps all young tasks");
  const emergency = selectRetentionRemovals(tasks, { now: NOW, emergency: true });
  assertEqual(emergency.length, 30 - RETENTION_EMERGENCY_KEEP_COUNT, "emergency keeps only the newest window");
  assert(emergency.every((id) => Number(id.slice(1)) >= 10), "emergency removals are the oldest ten");
}

{
  console.log("\n=== determinism ===\n");
  const tasks = [
    candidate({ taskId: "b", endedAt: 500 }),
    candidate({ taskId: "a", endedAt: 500 }),
    candidate({ taskId: "c", endedAt: 900 }),
  ];
  const first = selectRetentionRemovals(tasks, { now: NOW, emergency: false, keepCount: 1, keepAgeMs: 0 });
  const second = selectRetentionRemovals(tasks, { now: NOW, emergency: false, keepCount: 1, keepAgeMs: 0 });
  assertEqual(first, second, "selection is deterministic");
  assertEqual(first, ["a", "b"], "equal endedAt falls back to taskId ordering (oldest first)");
}

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
