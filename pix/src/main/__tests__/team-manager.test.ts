/**
 * Team Manager Unit Tests
 *
 * Tests for TeamMessageBus, TeamTaskList, and TeamProtocolManager.
 * Imports production classes from team-manager.ts.
 *
 * Run with: npx tsx src/main/__tests__/team-manager.test.ts
 */

import { randomUUID } from "crypto";
import {
  buildWorkerUnavailableOrchestrationEvents,
  buildTeamOrchestrationPrompt,
  buildTeamOrchestrationBrief,
  classifyTeamResult,
  MAX_COORDINATION_GENERATION,
  normalizeRestoredTeamTasks,
  OrchestrationEventQueue,
  planOrchestrationRetry,
  planTeamCoordination,
  processOrchestrationWakeQueue,
} from "../team-orchestration.js";
import { parseTeamTaskEvidence } from "../team-results.js";
import { TeamMessageBus } from "../team-message-bus.js";
import { TeamTaskList, canTransitionTeamTaskStatus } from "../team-task-list.js";
import { DEFAULT_WORKER_CONFIGS, PROTOCOL_MESSAGE_KINDS, ROLE_PERMISSIONS, ROLE_SYSTEM_PROMPTS } from "../team-constants.js";
import { pickTeammateColor, sanitizeAgentName, TEAMMATE_COLOR_PALETTE } from "../team-utils.js";
import {
  createPersistedTeamSnapshot,
  hydratePersistedTeam,
  isRestorableTeamSnapshot,
} from "../team-persistence.js";
import { TeamProtocolManager } from "../team-protocol-manager.js";
import type { TeamData } from "../team-runtime-types.js";
import type { OrchestrationEvent } from "../team-orchestration.js";
import type {
  TeamMessage,
  TeamTask,
  TeammateInfo,
} from "../../shared/types.js";

// ============================================================================
// Test Helpers
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
    console.error(`  FAIL: ${message} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn: () => void, message: string): void {
  try {
    fn();
    failed++;
    console.error(`  FAIL: ${message} - expected throw`);
  } catch {
    passed++;
    console.log(`  PASS: ${message}`);
  }
}

// ============================================================================
// Tests
// ============================================================================

console.log("\n=== TeamMessageBus Tests ===\n");

// Test 1: Send and consume direct message
{
  const bus = new TeamMessageBus();
  const msg: TeamMessage = {
    id: "1",
    teamName: "test",
    fromAgentId: "leader",
    toAgentId: "worker-1",
    text: "Hello",
    timestamp: Date.now(),
    read: false,
    delivered: false,
    summary: "Hello",
    kind: "leader_message",
    fromRole: "leader",
  };
  bus.send(msg);
  assertEqual(bus.size(), 1, "Bus has 1 message after send");
  const consumed = bus.consumeNext("worker-1");
  assert(consumed !== null, "Consumed message is not null");
  assertEqual(consumed?.text, "Hello", "Consumed message text matches");
  assertEqual(bus.size(), 0, "Bus is empty after consume");
}

// Test 2: Priority ordering
{
  const bus = new TeamMessageBus();
  const now = Date.now();
  bus.send({ id: "1", teamName: "t", fromAgentId: "a", toAgentId: "w", text: "low", timestamp: now, read: false, delivered: false, summary: "", kind: "task_message", fromRole: "leader" });
  bus.send({ id: "2", teamName: "t", fromAgentId: "a", toAgentId: "w", text: "high", timestamp: now, read: false, delivered: false, summary: "", kind: "shutdown", fromRole: "leader" });
  bus.send({ id: "3", teamName: "t", fromAgentId: "a", toAgentId: "w", text: "mid", timestamp: now, read: false, delivered: false, summary: "", kind: "leader_message", fromRole: "leader" });

  const first = bus.consumeNext("w");
  assertEqual(first?.text, "high", "Shutdown has highest priority");
  const second = bus.consumeNext("w");
  assertEqual(second?.text, "mid", "Leader message has second priority");
  const third = bus.consumeNext("w");
  assertEqual(third?.text, "low", "Task message has lowest priority");
}

// Test 3: Broadcast
{
  const bus = new TeamMessageBus();
  bus.send({ id: "b1", teamName: "t", fromAgentId: "leader", toAgentId: "*", text: "broadcast", timestamp: Date.now(), read: false, delivered: false, summary: "", kind: "broadcast", fromRole: "leader" });

  const msg1 = bus.consumeNext("worker-1");
  assert(msg1 !== null, "Worker-1 gets broadcast");
  assertEqual(msg1?.text, "broadcast", "Broadcast text matches");

  const msg2 = bus.consumeNext("worker-2");
  assert(msg2 !== null, "Worker-2 gets broadcast");
  assertEqual(msg2?.text, "broadcast", "Broadcast text matches for worker-2");

  // Should not deliver again
  const msg3 = bus.consumeNext("worker-1");
  assert(msg3 === null, "Broadcast not delivered twice to same agent");
}

// Test 4: Mixed queues
{
  const bus = new TeamMessageBus();
  const now = Date.now();
  bus.send({ id: "d1", teamName: "t", fromAgentId: "a", toAgentId: "w", text: "direct", timestamp: now, read: false, delivered: false, summary: "", kind: "peer_message", fromRole: "coder" });
  bus.send({ id: "b1", teamName: "t", fromAgentId: "a", toAgentId: "*", text: "broadcast", timestamp: now, read: false, delivered: false, summary: "", kind: "broadcast", fromRole: "leader" });

  const all = bus.peek("w");
  assertEqual(all.length, 2, "peek() returns both direct and broadcast");
}

// Test 4b: pruneBroadcasts removes fully-delivered broadcasts
{
  const bus = new TeamMessageBus();
  bus.send({ id: "bp1", teamName: "t", fromAgentId: "leader", toAgentId: "*", text: "prune-me", timestamp: Date.now(), read: false, delivered: false, summary: "", kind: "broadcast", fromRole: "leader" });

  // Both workers consume it
  bus.consumeNext("w1");
  bus.consumeNext("w2");

  // Prune should remove it since all active agents consumed it
  const pruned = bus.pruneBroadcasts(["w1", "w2"]);
  assertEqual(pruned, 1, "Fully-delivered broadcast is pruned");
  assertEqual(bus.size(), 0, "Bus is empty after prune");
}

// Test 4c: snapshot and restore pending bus messages
{
  const bus = new TeamMessageBus();
  bus.send({ id: "s1", teamName: "t", fromAgentId: "leader", toAgentId: "w1", text: "direct", timestamp: Date.now(), read: false, delivered: false, summary: "", kind: "leader_message", fromRole: "leader" });
  bus.send({ id: "s2", teamName: "t", fromAgentId: "leader", toAgentId: "*", text: "broadcast", timestamp: Date.now(), read: false, delivered: false, summary: "", kind: "broadcast", fromRole: "leader" });
  bus.consumeNext("w2");

  const restored = new TeamMessageBus();
  restored.restore(bus.snapshot());
  assertEqual(restored.consumeNext("w1")?.text, "direct", "Restored direct message is delivered");
  assert(restored.consumeNext("w2") === null, "Restored delivered broadcast is not redelivered to same worker");
  assertEqual(restored.consumeNext("w3")?.text, "broadcast", "Restored broadcast remains available to new worker");
}

// Test 4d: messages are not delivered back to their sender
{
  const bus = new TeamMessageBus();
  bus.send({ id: "self-direct", teamName: "t", fromAgentId: "w1", toAgentId: "w1", text: "self", timestamp: Date.now(), read: false, delivered: false, summary: "", kind: "answer", fromRole: "coder" });
  assert(bus.consumeNext("w1") === null, "Direct self-message is ignored");

  bus.send({ id: "self-broadcast", teamName: "t", fromAgentId: "w1", toAgentId: "*", text: "broadcast", timestamp: Date.now(), read: false, delivered: false, summary: "", kind: "broadcast", fromRole: "coder" });
  assert(bus.consumeNext("w1") === null, "Broadcast is not delivered back to sender");
  assertEqual(bus.consumeNext("w2")?.text, "broadcast", "Broadcast is still delivered to other workers");
}

console.log("\n=== TeamTaskList Tests ===\n");

// Test 4e: abort clears pending mailboxes but preserves the timeline
{
  const bus = new TeamMessageBus();
  const pending: TeamMessage = {
    id: "pending-after-abort",
    teamName: "t",
    fromAgentId: "leader",
    toAgentId: "worker",
    text: "pending",
    timestamp: Date.now(),
    read: false,
    delivered: false,
    summary: "pending",
    kind: "leader_message",
    fromRole: "leader",
  };
  const historyOnly: TeamMessage = {
    ...pending,
    id: "history-only",
    toAgentId: "leader",
    fromAgentId: "worker",
    fromRole: "coder",
  };
  bus.send(pending);
  bus.recordHistoryOnly(historyOnly);
  assertEqual(bus.size(), 1, "History-only Leader message does not enter a worker mailbox");
  assertEqual(bus.clearPending(), 1, "Abort clears pending mailbox entries");
  assertEqual(bus.size(), 0, "Pending mailbox is empty after clearPending");
  assertEqual(bus.history().length, 2, "clearPending preserves both timeline messages");
}

// Test 5: Create and get task
{
  const taskList = new TeamTaskList();
  const task = taskList.create({
    id: "t1",
    teamName: "test",
    subject: "Test task",
    description: "Do something",
    status: "pending",
    blockedBy: [],
    blocks: [],
  });
  assertEqual(task.subject, "Test task", "Task subject matches");
  assertEqual(taskList.size(), 1, "TaskList has 1 task");
  const retrieved = taskList.get("t1");
  assert(retrieved !== undefined, "Can retrieve task by ID");
}

// Test 6: Auto-claim
{
  const taskList = new TeamTaskList();
  taskList.create({ id: "t1", teamName: "test", subject: "Task 1", description: "", status: "pending", blockedBy: [], blocks: [] });
  taskList.create({ id: "t2", teamName: "test", subject: "Task 2", description: "", status: "pending", blockedBy: [], blocks: [] });

  const claimed1 = taskList.tryClaimNextTask("worker-1");
  assert(claimed1 !== null, "Worker-1 claims a task");
  assertEqual(claimed1?.status, "in_progress", "Claimed task is in_progress");
  assertEqual(claimed1?.ownerAgentId, "worker-1", "Claimed task has correct owner");

  const claimed2 = taskList.tryClaimNextTask("worker-2");
  assert(claimed2 !== null, "Worker-2 claims the other task");
  assert(claimed1?.id !== claimed2?.id, "Workers claim different tasks");

  const claimed3 = taskList.tryClaimNextTask("worker-3");
  assert(claimed3 === null, "No more tasks to claim");
}

// Test 7: Blocked tasks
{
  const taskList = new TeamTaskList();
  taskList.create({ id: "t1", teamName: "test", subject: "Dep", description: "", status: "pending", blockedBy: [], blocks: ["t2"] });
  taskList.create({ id: "t2", teamName: "test", subject: "Blocked", description: "", status: "pending", blockedBy: ["t1"], blocks: [] });

  const claimed = taskList.tryClaimNextTask("w");
  assertEqual(claimed?.id, "t1", "Claims the unblocked task first");

  // t2 should still be blocked
  const claimed2 = taskList.tryClaimNextTask("w2");
  assert(claimed2 === null, "Blocked task cannot be claimed");

  // Complete t1
  taskList.update("t1", { status: "completed" });
  const claimed3 = taskList.tryClaimNextTask("w3");
  assertEqual(claimed3?.id, "t2", "After dep completed, blocked task is claimable");
}

// Test 8: Update and delete
{
  const taskList = new TeamTaskList();
  taskList.create({ id: "t1", teamName: "test", subject: "Task", description: "", status: "pending", blockedBy: [], blocks: [] });
  taskList.claimTask("t1", "worker-1");
  taskList.update("t1", { status: "completed", result: "Done" });
  const updated = taskList.get("t1");
  assertEqual(updated?.status, "completed", "Task status updated");
  assertEqual(updated?.result, "Done", "Task result updated");

  taskList.delete("t1");
  assertEqual(taskList.size(), 0, "Task deleted");
}

// Test 9: claimTask specific task
{
  const taskList = new TeamTaskList();
  taskList.create({ id: "ct1", teamName: "test", subject: "Claim me", description: "", status: "pending", blockedBy: [], blocks: [] });

  const claimed = taskList.claimTask("ct1", "w1");
  assert(claimed !== null, "Specific task claimed");
  assertEqual(claimed?.ownerAgentId, "w1", "Correct owner set");

  // Try to claim the same task again
  const doubleClaim = taskList.claimTask("ct1", "w2");
  assert(doubleClaim === null, "Cannot claim already-claimed task");
}

// Test 10: release open tasks owned by unavailable workers
{
  const taskList = new TeamTaskList();
  taskList.create({ id: "assigned", teamName: "test", subject: "Assigned", description: "", status: "pending", blockedBy: [], blocks: [] });
  taskList.update("assigned", { status: "assigned", ownerAgentId: "w1" });
  taskList.create({ id: "active", teamName: "test", subject: "Active", description: "", status: "pending", blockedBy: [], blocks: [] });
  taskList.claimTask("active", "w1");
  taskList.create({ id: "other", teamName: "test", subject: "Other", description: "", status: "pending", blockedBy: [], blocks: [] });
  taskList.claimTask("other", "w2");

  const released = taskList.releaseOwnedOpenTasks("w1", "worker stopped");
  assertEqual(released.length, 2, "Owned assigned and in-progress tasks are released");
  assertEqual(taskList.get("assigned")?.status, "pending", "Assigned task returns to pending");
  assertEqual(taskList.get("assigned")?.ownerAgentId, undefined, "Assigned task owner is cleared");
  assertEqual(taskList.get("active")?.status, "pending", "In-progress task returns to pending");
  assertEqual(taskList.get("active")?.result, "worker stopped", "Release reason is recorded");
  assertEqual(taskList.get("other")?.status, "in_progress", "Other worker task is untouched");

  const releaseEvents = buildWorkerUnavailableOrchestrationEvents({
    releasedTasks: released,
    workerName: "coder",
    workerRole: "coder",
    reason: "worker stopped",
  });
  assertEqual(releaseEvents.length, 2, "Released tasks produce leader wake events");
  assertEqual(releaseEvents[0]?.type, "task_blocked", "Released task wake event is task_blocked");
  assertEqual(releaseEvents[0]?.workerName, "coder", "Released task wake event includes worker name");
  assert(releaseEvents[0]?.result?.includes("claimable again") === true, "Released task wake event explains reclaimability");
}

// Test 11: ready and dependency-blocked task views
{
  const taskList = new TeamTaskList();
  taskList.create({ id: "dep", teamName: "test", subject: "Dependency", description: "", status: "pending", blockedBy: [], blocks: ["child"] });
  taskList.create({ id: "child", teamName: "test", subject: "Child", description: "", status: "pending", blockedBy: ["dep"], blocks: [] });
  taskList.create({ id: "free", teamName: "test", subject: "Free", description: "", status: "pending", blockedBy: [], blocks: [] });

  const readyBefore = taskList.getReadyTasks();
  assert(readyBefore.some((t) => t.id === "dep"), "Dependency task is ready");
  assert(readyBefore.some((t) => t.id === "free"), "Independent task is ready");
  assert(!readyBefore.some((t) => t.id === "child"), "Dependent task is not ready");

  const blockedBefore = taskList.getBlockedByDependencies();
  assertEqual(blockedBefore.length, 1, "One task is dependency-blocked");
  assertEqual(blockedBefore[0]?.id, "child", "Child task is dependency-blocked");
  assertEqual(taskList.getOpenDependencies("child")[0], "dep", "Open dependency is reported");

  taskList.claimTask("dep", "w-dep");
  taskList.update("dep", { status: "completed" });
  const readyAfter = taskList.getReadyTasks();
  assert(readyAfter.some((t) => t.id === "child"), "Dependent task becomes ready after dependency completes");
  assertEqual(taskList.getOpenDependencies("child").length, 0, "Open dependencies clear after completion");
}

// Test 12: ready task role filtering
{
  const taskList = new TeamTaskList();
  taskList.create({ id: "review", teamName: "test", subject: "Review", description: "", status: "pending", taskType: "review", blockedBy: [], blocks: [] });
  taskList.create({ id: "code", teamName: "test", subject: "Code", description: "", status: "pending", taskType: "implement", blockedBy: [], blocks: [] });

  const coderReady = taskList.getReadyTasks("coder");
  assert(coderReady.some((t) => t.id === "code"), "Coder sees implement task as ready");
  assert(!coderReady.some((t) => t.id === "review"), "Coder does not see review task as ready");

  const reviewerReady = taskList.getReadyTasks("reviewer");
  assert(reviewerReady.some((t) => t.id === "review"), "Reviewer sees review task as ready");
  assert(!reviewerReady.some((t) => t.id === "code"), "Reviewer does not see implement task as ready");
}

// Test 12a: assigned dependency-blocked tasks cannot be claimed early
{
  const taskList = new TeamTaskList();
  taskList.create({ id: "dep", teamName: "test", subject: "Dependency", description: "", status: "pending", blockedBy: [], blocks: ["child"] });
  taskList.create({ id: "child", teamName: "test", subject: "Child", description: "", status: "assigned", ownerAgentId: "w-child", blockedBy: ["dep"], blocks: [] });

  const earlyClaim = taskList.claimTask("child", "w-child");
  assert(earlyClaim === null, "Assigned task with open dependencies cannot be claimed");

  taskList.claimTask("dep", "w-dep");
  taskList.update("dep", { status: "completed" });
  const readyClaim = taskList.claimTask("child", "w-child");
  assertEqual(readyClaim?.id, "child", "Assigned task becomes claimable after dependency completes");
}

// Test 12b: result classification for coordinator gates
{
  assertEqual(classifyTeamResult("Review passed. No issues found."), "passed", "Passed review is classified as passed");
  assertEqual(classifyTeamResult("No bugs found. Everything is working correctly."), "passed", "Negated bug reports are classified as passed");
  assertEqual(classifyTeamResult("Found one issue: missing parser error handling."), "issues", "Issue-bearing review is classified as issues");
  assertEqual(classifyTeamResult("The implementation did not pass the tests."), "issues", "Negated pass reports are classified as issues");
  assertEqual(classifyTeamResult("Missing scope: none reported. Risks: none."), "unknown", "Neutral evidence fields do not imply issues");
  assertEqual(classifyTeamResult("Implemented tokenizer and parser scaffolding."), "unknown", "Plain implementation summary is classified as unknown");
}

// Test 13: structured task evidence parsing
{
  const evidence = parseTeamTaskEvidence([
    "Summary: Implemented tokenizer scaffolding",
    "Changed files: src/token.cpp, src/token.h",
    "Completed scope:",
    "- Token enum",
    "- Lexer shell",
    "Missing scope:",
    "- Parser integration",
    "Verification: npm run build, manual smoke test",
    "Risks: lexer errors are not exhaustive",
    "Follow-ups: add parser tests",
    "Confidence: medium",
  ].join("\n"));

  assertEqual(evidence.summary, "Implemented tokenizer scaffolding", "Evidence summary is parsed");
  assertEqual(evidence.changedFiles.length, 2, "Changed files are parsed");
  assert(evidence.completedScope.includes("Token enum"), "Completed scope bullets are parsed");
  assert(evidence.missingScope.includes("Parser integration"), "Missing scope bullets are parsed");
  assertEqual(evidence.verification.length, 2, "Inline verification list is parsed");
  assertEqual(evidence.confidence, "medium", "Confidence is parsed");
}

// Test 14: coordination policy for automatic team gates
{
  const implementPolicy = planTeamCoordination({ taskType: "implement", result: "Implemented the parser." });
  assertEqual(implementPolicy.needsReview, true, "Implement tasks require a review gate");
  assertEqual(implementPolicy.needsFix, false, "Implement tasks do not directly create fix gates");

  const existingReviewPolicy = planTeamCoordination(
    { taskType: "implement", result: "Implemented the parser." },
    { hasReviewChild: true },
  );
  assertEqual(existingReviewPolicy.needsReview, false, "Existing review gates are not duplicated");

  const cleanReviewPolicy = planTeamCoordination({ taskType: "review", result: "No bugs found. Looks good." });
  assertEqual(cleanReviewPolicy.needsFix, false, "Passing reviews do not create fix gates");

  const issueReviewPolicy = planTeamCoordination({ taskType: "review", result: "Found one issue: missing validation." });
  assertEqual(issueReviewPolicy.needsFix, true, "Issue-bearing reviews create fix gates");

  const fixPolicy = planTeamCoordination({ taskType: "fix", result: "Fixed validation." });
  assertEqual(fixPolicy.needsReview, true, "Fix tasks require a follow-up review gate");
}

// Test 15: orchestration brief summarizes decisions
{
  const now = Date.now();
  const workers: TeammateInfo[] = [
    {
      agentId: "coder::team",
      name: "coder",
      role: "coder",
      status: "idle",
      createdAt: now,
      statusChangedAt: now,
    },
  ];
  const readyTask: TeamTask = {
    id: "ready",
    teamName: "test",
    subject: "Implement parser",
    description: "",
    taskType: "implement",
    status: "pending",
    blockedBy: [],
    blocks: [],
    createdAt: now,
    updatedAt: now,
  };
  const events: OrchestrationEvent[] = [{
    type: "task_completed",
    taskSubject: "Implement lexer",
    taskType: "implement",
    workerName: "coder",
    workerRole: "coder",
    result: "Implemented lexer.",
  }];

  const brief = buildTeamOrchestrationBrief(events, {
    allTasks: [readyTask],
    readyTasks: [readyTask],
    dependencyBlockedTasks: [],
    workers,
  });

  assertEqual(brief.eventTypes.task_completed, 1, "Brief counts event types");
  assert(brief.recommendedActions.some((action) => action.includes("review")), "Brief recommends review after implementation");
  assert(brief.recommendedActions.some((action) => action.includes("parallel")), "Brief recommends parallel assignment when ready work exists");
  assertEqual(brief.availableWorkerCount, 1, "Brief counts available workers");

  const issueBrief = buildTeamOrchestrationBrief([{
    type: "task_completed",
    taskSubject: "Review parser",
    taskType: "review",
    result: "Found one issue: missing parser tests.",
  }], {
    allTasks: [],
    readyTasks: [],
    dependencyBlockedTasks: [],
    workers,
  });
  assert(issueBrief.recommendedActions.some((action) => action.includes("fix")), "Brief recommends fix after issue-bearing review");

  const blockedTask: TeamTask = {
    id: "blocked-task",
    teamName: "test",
    subject: "Wire parser",
    description: "",
    taskType: "implement",
    status: "pending",
    blockedBy: ["ready"],
    blocks: [],
    createdAt: now,
    updatedAt: now,
  };
  const prompt = buildTeamOrchestrationPrompt(events, {
    allTasks: [readyTask, blockedTask],
    readyTasks: [readyTask],
    dependencyBlockedTasks: [blockedTask],
    workers,
    getOpenDependencies: (task) => task.id === "blocked-task" ? ["ready"] : [],
  });
  assert(prompt.includes("Coordination brief:"), "Prompt includes structured coordination brief");
  assert(prompt.includes("Ready tasks that can run now:"), "Prompt includes ready task section");
  assert(prompt.includes("Tasks waiting on dependencies:"), "Prompt includes dependency-blocked section");
  assert(prompt.includes("ACTION REQUIRED"), "Prompt includes leader action guidance");
  assert(prompt.includes("handle that first with respond_to_plan_approval"), "Prompt prioritizes pending plan approvals");
}

// Test 15b: plan approvals are limited to implementation roles
{
  assert(ROLE_PERMISSIONS.coder.allowedTools.includes("submit_plan"), "Coder can submit implementation plans for approval");
  assert(!ROLE_PERMISSIONS.planner.allowedTools.includes("submit_plan"), "Planner planning deliverables do not use approval protocol");
  assert(!ROLE_PERMISSIONS.researcher.allowedTools.includes("submit_plan"), "Researcher deliverables do not use approval protocol");
  assert(!ROLE_PERMISSIONS.reviewer.allowedTools.includes("submit_plan"), "Reviewer does not use implementation approval protocol");
  assert(!ROLE_PERMISSIONS.tester.allowedTools.includes("submit_plan"), "Tester does not use implementation approval protocol");
}

// Test 16: orchestration event queue retry behavior
{
  const queue = new OrchestrationEventQueue();
  queue.enqueue({ type: "task_completed", taskSubject: "A" });
  queue.enqueue({ type: "question_asked", taskSubject: "B" });
  assertEqual(queue.length, 2, "Queue tracks pending events");

  const batch = queue.takeAll();
  assertEqual(batch.length, 2, "Queue drains a full batch");
  assertEqual(queue.length, 0, "Queue is empty after drain");
  assertEqual(batch[0]?.taskSubject, "A", "Queue preserves FIFO ordering");

  const retry = queue.requeueFailed(batch);
  assertEqual(retry.attempts, 1, "Retry increments attempts");
  assertEqual(retry.delayMs, 500, "First retry uses base delay");
  assertEqual(queue.snapshot()[0]?.attempts, 1, "Requeued event stores attempt count");

  const secondBatch = queue.takeAll();
  const secondRetry = planOrchestrationRetry(secondBatch);
  assertEqual(secondRetry.attempts, 2, "Retry plan increments existing attempts");
  assertEqual(secondRetry.delayMs, 1000, "Second retry backs off");

  queue.clear();
  assertEqual(queue.hasPending, false, "Queue clear removes pending events");
}

// Test 16b: orchestration wakes deduplicate by source and epoch
{
  const queue = new OrchestrationEventQueue();
  const event: OrchestrationEvent = {
    type: "team_message",
    sourceId: "message-1",
    runtimeEpoch: 7,
    messageKind: "question",
  };
  assertEqual(queue.enqueue(event), true, "First orchestration event is accepted");
  assertEqual(queue.enqueue(event), false, "Duplicate orchestration event is ignored");
  assertEqual(queue.length, 1, "Duplicate wake does not grow the queue");
  queue.clear();
  assertEqual(queue.enqueue({ ...event, runtimeEpoch: 8 }), true, "A new runtime epoch is accepted");
}

// Test 17: orchestration wake runtime with fake leader session
{
  const queue = new OrchestrationEventQueue();
  queue.enqueue({ type: "task_completed", taskSubject: "Implementation", taskType: "implement" });
  const prompts: string[] = [];
  const scheduled: number[] = [];
  const result = await processOrchestrationWakeQueue({
    queue,
    session: {
      isStreaming: false,
      prompt: async (text: string) => { prompts.push(text); },
    },
    canProcess: () => true,
    buildPrompt: (events) => `prompt:${events.map((event) => event.type).join(",")}`,
    scheduleRetry: (delayMs) => { scheduled.push(delayMs); },
  });
  assertEqual(result.prompted, 1, "Wake runtime prompts leader once on success");
  assertEqual(prompts[0], "prompt:task_completed", "Wake runtime uses prompt builder output");
  assertEqual(queue.hasPending, false, "Wake runtime drains queue on success");
  assertEqual(scheduled.length, 0, "Wake runtime does not schedule retry on success");

  queue.enqueue({ type: "question_asked", taskSubject: "Question" });
  const failed = await processOrchestrationWakeQueue({
    queue,
    session: {
      isStreaming: false,
      prompt: async () => { throw new Error("model unavailable"); },
    },
    canProcess: () => true,
    buildPrompt: () => "will fail",
    scheduleRetry: (delayMs) => { scheduled.push(delayMs); },
  });
  assertEqual(failed.retried, true, "Wake runtime requeues failed prompt batches");
  assertEqual(failed.retryDelayMs, 500, "Wake runtime reports retry delay");
  assertEqual(queue.snapshot()[0]?.attempts, 1, "Wake runtime stores retry attempts on failed events");

  const streamingQueue = new OrchestrationEventQueue();
  streamingQueue.enqueue({ type: "task_blocked", taskSubject: "Blocked" });
  const streamingScheduled: number[] = [];
  const streaming = await processOrchestrationWakeQueue({
    queue: streamingQueue,
    session: {
      isStreaming: true,
      prompt: async () => { throw new Error("should not prompt while streaming"); },
    },
    canProcess: () => true,
    buildPrompt: () => "unused",
    scheduleRetry: (delayMs) => { streamingScheduled.push(delayMs); },
  });
  assertEqual(streaming.deferred, true, "Wake runtime defers while leader is streaming");
  assertEqual(streamingQueue.hasPending, true, "Streaming deferral keeps events queued");
  assertEqual(streamingScheduled[0], 500, "Streaming deferral schedules base retry");
}

// Test 17b: a stale wake batch is dropped instead of requeued after abort
{
  const queue = new OrchestrationEventQueue();
  queue.enqueue({ type: "team_message", sourceId: "stale", runtimeEpoch: 1 });
  const scheduled: number[] = [];
  const result = await processOrchestrationWakeQueue({
    queue,
    session: {
      isStreaming: false,
      prompt: async () => { throw new Error("aborted"); },
    },
    canProcess: () => true,
    canRetry: () => false,
    buildPrompt: () => "stale",
    scheduleRetry: (delayMs) => scheduled.push(delayMs),
  });
  assertEqual(result.retried, false, "Stale wake is not retried");
  assertEqual(queue.hasPending, false, "Stale wake is removed from the queue");
  assertEqual(scheduled.length, 0, "Stale wake does not schedule another prompt");
}

// Test 17c: automatic review/fix follow-ups have a bounded generation
{
  assertEqual(MAX_COORDINATION_GENERATION, 3, "Coordination generation has a bounded safety limit");
  assert(MAX_COORDINATION_GENERATION > 0, "Coordination limit preserves the normal review/fix workflow");
}

// Test 18: task status transition policy
{
  assertEqual(canTransitionTeamTaskStatus("pending", "assigned"), true, "Pending tasks can be assigned");
  assertEqual(canTransitionTeamTaskStatus("assigned", "in_progress"), true, "Assigned tasks can be claimed");
  assertEqual(canTransitionTeamTaskStatus("in_progress", "completed"), true, "In-progress tasks can complete");
  assertEqual(canTransitionTeamTaskStatus("in_progress", "pending"), true, "In-progress tasks can be released");
  assertEqual(canTransitionTeamTaskStatus("pending", "completed"), false, "Pending tasks cannot bypass work and complete");
  assertEqual(canTransitionTeamTaskStatus("completed", "in_progress"), false, "Completed tasks cannot reopen implicitly");

  const taskList = new TeamTaskList();
  taskList.create({ id: "invalid", teamName: "test", subject: "Invalid", description: "", status: "pending", blockedBy: [], blocks: [] });
  assertThrows(() => taskList.update("invalid", { status: "completed" }), "TaskList rejects invalid status transitions");
}

// Test 19: restored task normalization
{
  const now = Date.now();
  const restored = normalizeRestoredTeamTasks([
    {
      id: "active",
      teamName: "test",
      subject: "Active",
      description: "",
      status: "in_progress",
      ownerAgentId: "w1",
      blockedBy: [],
      blocks: [],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "missing-owner",
      teamName: "test",
      subject: "Missing owner",
      description: "",
      status: "assigned",
      ownerAgentId: "gone",
      blockedBy: [],
      blocks: [],
      createdAt: now,
      updatedAt: now,
    },
  ], ["w1"]);

  assertEqual(restored[0]?.status, "assigned", "In-progress restored tasks downgrade to assigned");
  assertEqual(restored[0]?.ownerAgentId, "w1", "Known worker ownership is preserved on restore");
  assertEqual(restored[1]?.status, "pending", "Tasks owned by missing workers are released on restore");
  assertEqual(restored[1]?.ownerAgentId, undefined, "Missing worker ownership is cleared on restore");
}

// Test 20: task context, handoff, and gate state persistence
{
  const taskList = new TeamTaskList();
  taskList.create({ id: "ctx1", teamName: "test", subject: "Context task", description: "", status: "pending", blockedBy: [], blocks: [] });
  const evidence = parseTeamTaskEvidence("Summary: Done\nChanged files: src/a.ts\nConfidence: high");
  taskList.update("ctx1", {
    evidence,
    contextPack: {
      taskId: "ctx1",
      generatedAt: 1,
      objective: "Context task",
      assignedScope: "Do context work",
      dependencyEvidence: [],
      relevantRisks: ["risk"],
      touchedFiles: ["src/a.ts"],
      openQuestions: [],
      coordinationHints: ["review evidence"],
    },
    handoff: {
      taskId: "ctx1",
      createdAt: 2,
      workerAgentId: "coder@test",
      summary: "Done",
      evidence,
    },
    gateState: {
      gate: "implementation",
      status: "passed",
      updatedAt: 3,
    },
    fileConflicts: [{
      withTaskId: "ctx2",
      withSubject: "Other task",
      files: ["src/a.ts"],
      severity: "warning",
      reason: "Concurrent open tasks reference the same touched file.",
    }],
  });

  const updated = taskList.get("ctx1");
  assertEqual(updated?.contextPack?.touchedFiles[0], "src/a.ts", "Context pack is persisted on task");
  assertEqual(updated?.contextPack?.coordinationHints?.[0], "review evidence", "Coordination hints are persisted on task");
  assertEqual(updated?.handoff?.workerAgentId, "coder@test", "Handoff packet is persisted on task");
  assertEqual(updated?.gateState?.status, "passed", "Gate state is persisted on task");
  assertEqual(updated?.fileConflicts?.[0]?.files[0], "src/a.ts", "File conflicts are persisted on task");
}

// Test 21: team snapshot hydration restores runtime-safe state
{
  const now = Date.now();
  const taskList = new TeamTaskList();
  taskList.create({
    id: "restore-task",
    teamName: "restore",
    subject: "Restore task",
    description: "",
    status: "pending",
    blockedBy: [],
    blocks: [],
  });
  taskList.update("restore-task", { status: "assigned", ownerAgentId: "coder@restore" });
  taskList.update("restore-task", { status: "in_progress" });

  const team: TeamData = {
    name: "restore",
    status: "active",
    leadAgentId: "leader@restore",
    workers: new Map([
      ["coder@restore", {
        info: {
          agentId: "coder@restore",
          name: "coder",
          role: "coder",
          status: "running",
          mode: "core",
          activationPolicy: "always",
          createdAt: now,
          lastActiveAt: now,
          statusChangedAt: now,
        },
        session: null,
        mcpAdapter: null,
        lifecycleAbortController: null,
        workAbortController: null,
        runner: null,
        messageHistory: [{ id: "m1", role: "assistant", content: "done", timestamp: now }],
      }],
      ["reviewer@restore", {
        info: {
          agentId: "reviewer@restore",
          name: "reviewer",
          role: "reviewer",
          status: "shutdown",
          mode: "on_demand",
          activationPolicy: "when_needed",
          createdAt: now,
          lastActiveAt: now,
          statusChangedAt: now,
        },
        session: null,
        mcpAdapter: null,
        lifecycleAbortController: null,
        workAbortController: null,
        runner: null,
        messageHistory: [],
      }],
    ]),
    bus: new TeamMessageBus(),
    taskList,
    protocolManager: new TeamProtocolManager(),
    createdAt: now,
  };

  const snapshot = createPersistedTeamSnapshot("cwd", team);
  assertEqual(isRestorableTeamSnapshot(snapshot, "cwd"), true, "Current snapshot is restorable");
  assertEqual(isRestorableTeamSnapshot({ ...snapshot, cwd: "other" }, "cwd"), false, "Snapshot cwd mismatch is rejected");

  const hydrated = hydratePersistedTeam(snapshot);
  assertEqual(hydrated.workers.get("coder@restore")?.info.status, "idle", "Running worker restores as idle");
  assertEqual(hydrated.workers.get("reviewer@restore")?.info.status, "dormant", "On-demand shutdown worker restores dormant");
  assertEqual(hydrated.taskList.get("restore-task")?.status, "assigned", "In-progress restored task becomes assigned");
  assertEqual(hydrated.workers.get("coder@restore")?.messageHistory[0]?.content, "done", "Worker message history is restored");
}

console.log("\n=== Task ID Prefix Resolution Tests ===\n");

// Test 22: resolveTaskId accepts full IDs and unique prefixes
{
  const taskList = new TeamTaskList();
  taskList.create({ id: "abcd1234-1111-2222-3333-444455556666", teamName: "t", subject: "A", description: "", status: "pending", blockedBy: [], blocks: [] });
  taskList.create({ id: "abzz9999-1111-2222-3333-444455556666", teamName: "t", subject: "B", description: "", status: "pending", blockedBy: [], blocks: [] });

  assertEqual(
    taskList.resolveTaskId("abcd1234-1111-2222-3333-444455556666"),
    "abcd1234-1111-2222-3333-444455556666",
    "Full task ID resolves to itself",
  );
  assertEqual(taskList.resolveTaskId("abcd1234"), "abcd1234-1111-2222-3333-444455556666", "8-char prefix resolves uniquely");
  assertEqual(taskList.resolveTaskId("ab"), null, "Too-short prefix is rejected");
  assertEqual(taskList.resolveTaskId("abcd"), "abcd1234-1111-2222-3333-444455556666", "4-char unique prefix resolves");
  assertEqual(taskList.resolveTaskId("nope1234"), null, "Unknown prefix returns null");

  taskList.create({ id: "abcd9999-1111-2222-3333-444455556666", teamName: "t", subject: "C", description: "", status: "pending", blockedBy: [], blocks: [] });
  assertEqual(taskList.resolveTaskId("abcd"), null, "Ambiguous prefix returns null");
  assertEqual(taskList.resolveTaskId("abcd1234"), "abcd1234-1111-2222-3333-444455556666", "Longer prefix disambiguates");
}

// Test 23: plan approval responds to unique ID prefixes
{
  const pm = new TeamProtocolManager();
  const { approval, promise } = pm.requestPlanApproval("coder::t", "t", "Plan body", ["src/a.ts"]);

  const responded = pm.respondPlanApproval(approval.id.slice(0, 8), true, "ok");
  assert(responded !== null, "Plan approval resolves an 8-char ID prefix");
  assertEqual(responded?.status, "approved", "Prefix-resolved approval is approved");
  const result = await promise;
  assertEqual(result.approved, true, "Prefix-resolved approval resolves the worker promise");
  assertEqual(pm.getPendingPlanApprovals().length, 0, "Approved plan is removed from pending list");

  const missing = pm.respondPlanApproval("zzzz9999", true);
  assert(missing === null, "Unknown plan approval prefix is rejected");
}

console.log("\n=== Roster & Prompt Config Tests ===\n");

// Test 24: default roster covers all five roles; system prompts exist for each
{
  const roles = DEFAULT_WORKER_CONFIGS.map((config) => config.role);
  for (const role of ["coder", "planner", "reviewer", "tester", "researcher"] as const) {
    assert(roles.includes(role), `Default roster includes ${role}`);
    assert(ROLE_SYSTEM_PROMPTS[role].length > 0, `System prompt exists for ${role}`);
  }
  const alwaysOn = DEFAULT_WORKER_CONFIGS.filter((config) => config.activationPolicy === "always");
  assertEqual(alwaysOn.length, 1, "Only the coder is always-on");
  assertEqual(alwaysOn[0]?.role, "coder", "Always-on worker is the coder");
}

console.log("\n=== Spawn Helpers & Shutdown Protocol Tests ===\n");

// Test 25: agent name sanitization for LLM-provided teammate names
{
  assertEqual(sanitizeAgentName("Coder UI"), "coder-ui", "Spaces become dashes, lowercased");
  assertEqual(sanitizeAgentName("  api--Coder!!  "), "api-coder", "Symbols collapse and trim");
  assertEqual(sanitizeAgentName("///"), "", "Unusable names return empty (caller falls back to role)");
  assertEqual(sanitizeAgentName("a".repeat(50)).length, 32, "Names are capped at 32 chars");
}

// Test 26: teammate color palette assignment wraps deterministically
{
  assertEqual(pickTeammateColor(0), TEAMMATE_COLOR_PALETTE[0], "First teammate gets first palette color");
  assertEqual(
    pickTeammateColor(TEAMMATE_COLOR_PALETTE.length),
    TEAMMATE_COLOR_PALETTE[0],
    "Palette wraps around",
  );
  assertEqual(pickTeammateColor(3), TEAMMATE_COLOR_PALETTE[3], "Index maps directly within palette");
}

// Test 27: shutdown requests are model-delivered, not runtime-intercepted
{
  assert(!PROTOCOL_MESSAGE_KINDS.has("shutdown"), "shutdown is delivered to the worker model as a decision turn");
  assert(PROTOCOL_MESSAGE_KINDS.has("permission_request"), "permission_request stays runtime-intercepted");

  const pm = new TeamProtocolManager();
  const { promise } = pm.requestShutdown("coder::t");
  const request = pm.respondShutdown("coder::t", false, "critical work in flight");
  assertEqual(request?.state, "rejected", "Worker rejection is recorded");
  assertEqual(request?.reason, "critical work in flight", "Rejection reason is preserved");
  const confirmed = await promise;
  assertEqual(confirmed, false, "Leader promise resolves with the rejection");

  const missing = pm.respondShutdown("coder::t", true);
  assert(missing === null, "Responding after resolution reports no pending request");
}

console.log("\n=== Summary ===\n");
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
