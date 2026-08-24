/**
 * AgentTaskScheduler slot-cap tests: default 4, enqueue queues the 5th,
 * raising the cap grants waiters immediately, lowering it does not preempt
 * running occupants.
 *
 * Run with: npm exec tsx -- src/main/__tests__/agent-task-scheduler.test.ts
 */

import { AgentTaskScheduler } from "../agent-task/agent-task-scheduler.js";

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
    console.error(`  FAIL: ${message} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  console.log(`\n=== ${name} ===\n`);
  try {
    await fn();
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name} threw: ${error instanceof Error ? error.stack : String(error)}`);
  }
}

await run("default cap is 4; the 5th enqueue queues", () => {
  const scheduler = new AgentTaskScheduler();
  const granted: string[] = [];
  scheduler.onSlotFree((taskId) => {
    granted.push(taskId);
  });
  assert(scheduler.enqueue("a"), "1st grant");
  assert(scheduler.enqueue("b"), "2nd grant");
  assert(scheduler.enqueue("c"), "3rd grant");
  assert(scheduler.enqueue("d"), "4th grant");
  assert(!scheduler.enqueue("e"), "5th queues");
  assertEqual(scheduler.activeCount, 4, "occupancy stays at 4");
  assertEqual(granted.join(","), "a,b,c,d", "only four grants");
  assertEqual(scheduler.getQueuePosition("e"), 1, "e is next in line");
});

await run("raising the cap to 8 immediately grants queued waiters", () => {
  const scheduler = new AgentTaskScheduler(4);
  const granted: string[] = [];
  scheduler.onSlotFree((taskId) => {
    granted.push(taskId);
  });
  for (const id of ["a", "b", "c", "d", "e", "f"]) scheduler.enqueue(id);
  assertEqual(granted.join(","), "a,b,c,d", "queued two before the raise");
  scheduler.setMaxSlots(8);
  assertEqual(scheduler.maxSlots, 8, "cap is 8");
  assertEqual(granted.join(","), "a,b,c,d,e,f", "waiters granted on raise");
  assertEqual(scheduler.activeCount, 6, "six occupants after drain");
});

await run("lowering the cap does not preempt; grants resume after drain", () => {
  const scheduler = new AgentTaskScheduler(4);
  const granted: string[] = [];
  scheduler.onSlotFree((taskId) => {
    granted.push(taskId);
  });
  for (const id of ["a", "b", "c", "d", "e"]) scheduler.enqueue(id);
  scheduler.setMaxSlots(2);
  assertEqual(scheduler.activeCount, 4, "occupants are not preempted");
  assertEqual(granted.join(","), "a,b,c,d", "queued e stays queued");
  scheduler.release();
  scheduler.release();
  assertEqual(scheduler.activeCount, 2, "occupancy drained to the new cap");
  assertEqual(granted.join(","), "a,b,c,d", "e still waiting at cap 2");
  scheduler.release();
  assertEqual(granted.join(","), "a,b,c,d,e", "e grants once occupancy is under cap");
  assertEqual(scheduler.activeCount, 2, "occupancy stays at the lowered cap");
});

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
