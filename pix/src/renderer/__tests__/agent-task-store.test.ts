/**
 * Agent task store tests (PiX 1.4.1, stage B6; 1.5 P2 stage S2).
 *
 * Acceptance: waiting / running+queued / terminal grouping, group-level
 * auto-background deadline mirroring, event idempotency, active inputs,
 * task center open/close deep-link state and task_removed mirror convergence
 * (including selectedTaskId cleanup). The store talks to main only through
 * window.pixApi (sendAgentTaskCommand / onAgentTaskEvent /
 * onAgentTaskInputRequest), so the tests stub that surface in happy-dom - no
 * Electron runtime is loaded.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { PixApi } from "../../main/preload";
import type {
  AgentTaskActivity,
  AgentTaskInfo,
  AgentTaskInputRequest,
  AgentTaskRecoveryIssue,
} from "@shared/agent-task-types.js";
import type {
  AgentTaskEvent,
  PixCommandResult,
  RequestUserInputResponse,
} from "@shared/types.js";
import { useAgentTaskStore } from "../stores/agent-task-store";

// ============================================================================
// Fixtures
// ============================================================================

let taskCounter = 0;

function makeTask(overrides?: Partial<AgentTaskInfo>): AgentTaskInfo {
  taskCounter += 1;
  const id = overrides?.taskId ?? `task-${taskCounter}`;
  const now = Date.now();
  return {
    schemaVersion: 1,
    taskId: id,
    groupId: overrides?.groupId ?? `group-${taskCounter}`,
    groupMode: "single",
    workspaceId: "ws-1",
    parentSessionId: "session-1",
    parentToolCallId: "tool-call-1",
    itemSummaries: [{ index: 0, agentName: "general-purpose", agentSource: "built-in" }],
    thinkingLevel: "medium",
    executionMode: "unattended",
    project: { path: "/project", physicalPath: "/project", name: "project", environment: { kind: "windows" } },
    presentation: "foreground",
    status: "queued",
    description: "Task description",
    finalOutput: "",
    outputTruncated: false,
    originalOutputBytes: 0,
    results: [],
    activities: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
    toolUseCount: 0,
    createdAt: now,
    updatedAt: now,
    durationMs: 0,
    deliveredSessionIds: [],
    planLinkState: "none",
    generation: 0,
    ...overrides,
  };
}

function makeInputRequest(overrides?: Partial<AgentTaskInputRequest>): AgentTaskInputRequest {
  return {
    taskId: "task-1",
    requestId: "req-1",
    generation: 0,
    request: {
      id: "req-1",
      questions: [{ id: "q1", header: "Question", question: "Which option?" }],
    },
    ...overrides,
  };
}

function makeResponse(overrides?: Partial<RequestUserInputResponse>): RequestUserInputResponse {
  return {
    id: "req-1",
    answers: { q1: "option A" },
    ...overrides,
  };
}

function makeAutoBackground(overrides?: Partial<NonNullable<AgentTaskInfo["autoBackground"]>>): NonNullable<AgentTaskInfo["autoBackground"]> {
  return {
    deadlineAt: 1000,
    warningAt: 900,
    warningActive: false,
    ...overrides,
  };
}

function makeRecoveryIssue(overrides?: Partial<AgentTaskRecoveryIssue>): AgentTaskRecoveryIssue {
  return {
    taskId: "task-1",
    workspaceId: "ws-1",
    generation: 0,
    code: "tail_corrupt",
    message: "Tail is corrupt",
    recoverable: true,
    readOnly: true,
    ...overrides,
  };
}

// ============================================================================
// Harness: stub window.pixApi
// ============================================================================

let sendAgentTaskCommand: ReturnType<typeof vi.fn>;
let onAgentTaskEvent: ReturnType<typeof vi.fn>;
let onAgentTaskInputRequest: ReturnType<typeof vi.fn>;
let agentTaskEventCallback: ((event: AgentTaskEvent) => void) | null;
let inputRequestCallback: ((request: AgentTaskInputRequest) => void) | null;
const eventUnsubscribers: Array<() => void> = [];
const inputUnsubscribers: Array<() => void> = [];

function installPixApiMock(): void {
  taskCounter = 0;
  agentTaskEventCallback = null;
  inputRequestCallback = null;
  eventUnsubscribers.length = 0;
  inputUnsubscribers.length = 0;
  sendAgentTaskCommand = vi.fn().mockResolvedValue({ success: true });
  onAgentTaskEvent = vi.fn((callback: (event: AgentTaskEvent) => void) => {
    agentTaskEventCallback = callback;
    const unsubscribe = vi.fn();
    eventUnsubscribers.push(unsubscribe);
    return unsubscribe;
  });
  onAgentTaskInputRequest = vi.fn((callback: (request: AgentTaskInputRequest) => void) => {
    inputRequestCallback = callback;
    const unsubscribe = vi.fn();
    inputUnsubscribers.push(unsubscribe);
    return unsubscribe;
  });
  window.pixApi = { sendAgentTaskCommand, onAgentTaskEvent, onAgentTaskInputRequest } as unknown as PixApi;
}

/** Deliver an AgentTaskEvent through the currently registered onAgentTaskEvent callback. */
function emit(event: AgentTaskEvent): void {
  agentTaskEventCallback?.(event);
}

/** Deliver an input request through the dedicated onAgentTaskInputRequest channel. */
function emitInput(request: AgentTaskInputRequest): void {
  inputRequestCallback?.(request);
}

beforeEach(() => {
  setActivePinia(createPinia());
  installPixApiMock();
});

// ============================================================================
// Subscription
// ============================================================================

describe("subscription", () => {
  it("registers both listeners, then queries get_all and get_active_input_requests after them", async () => {
    const store = useAgentTaskStore();
    sendAgentTaskCommand.mockResolvedValue({
      success: true,
      data: [makeTask({ taskId: "task-1" })],
    });

    const unsubscribe = store.subscribeToEvents();

    expect(onAgentTaskEvent).toHaveBeenCalledTimes(1);
    expect(onAgentTaskInputRequest).toHaveBeenCalledTimes(1);
    // Subscriptions must be installed before the catch-up queries so a push
    // arriving early can never be overwritten by a stale response.
    expect(onAgentTaskEvent.mock.invocationCallOrder[0]).toBeLessThan(sendAgentTaskCommand.mock.invocationCallOrder[0]);
    expect(onAgentTaskInputRequest.mock.invocationCallOrder[0]).toBeLessThan(sendAgentTaskCommand.mock.invocationCallOrder[0]);
    expect(sendAgentTaskCommand.mock.calls.map((call) => call[0].type)).toEqual([
      "get_all",
      "get_active_input_requests",
    ]);

    await vi.waitFor(() => {
      expect(store.tasks).toHaveLength(1);
      expect(store.tasks[0].taskId).toBe("task-1");
    });

    unsubscribe();
    expect(eventUnsubscribers[0]).toHaveBeenCalled();
    expect(inputUnsubscribers[0]).toHaveBeenCalled();
  });

  it("replaces the previous subscription on re-subscribe (remount)", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    store.subscribeToEvents();

    expect(onAgentTaskEvent).toHaveBeenCalledTimes(2);
    expect(onAgentTaskInputRequest).toHaveBeenCalledTimes(2);
    expect(eventUnsubscribers[0]).toHaveBeenCalled();
    expect(eventUnsubscribers[1]).not.toHaveBeenCalled();
    expect(inputUnsubscribers[0]).toHaveBeenCalled();

    // Events flow only through the live (second) subscription.
    emit({ type: "task_state", task: makeTask({ taskId: "task-1", status: "running", startedAt: 1 }) });
    expect(store.tasks).toHaveLength(1);
  });
});

// ============================================================================
// Grouping: waiting / running+queued / recent
// ============================================================================

describe("grouping", () => {
  it("splits the mirror into waiting, active (running+queued) and recent groups", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();

    emit({ type: "task_state", task: makeTask({ taskId: "wait-1", status: "waiting_input", startedAt: 1 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "run-1", status: "running", startedAt: 1 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "queue-1", status: "queued", queuePosition: 2 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "done-1", status: "completed", endedAt: 5 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "fail-1", status: "failed", endedAt: 6, failureReason: "api_error", errorMessage: "boom" }) });
    emit({ type: "task_state", task: makeTask({ taskId: "cancel-1", status: "cancelled", endedAt: 7 }) });

    expect(store.waitingTasks.map((t) => t.taskId)).toEqual(["wait-1"]);
    expect(store.activeTasks.map((t) => t.taskId)).toEqual(["run-1", "queue-1"]);
    expect(store.terminalTasks.map((t) => t.taskId)).toEqual(["cancel-1", "fail-1", "done-1"]);
    expect(store.tasks).toHaveLength(6);
  });

  it("preserves event arrival order (事件到达顺序) inside waiting and active groups", () => {
    // Contract: the mirror keeps event arrival order. applyTaskState only
    // appends new tasks, never re-sorts; activeTasks/waitingTasks are plain
    // filters of the mirror. createdAt-ascending order exists only on the
    // main-process get_all path (remount catch-up), so the fixture below
    // deliberately emits createdAt 20, 10, 30 and asserts the arrival
    // sequence [b, a, c] - not [a, b, c].
    const store = useAgentTaskStore();
    store.subscribeToEvents();

    emit({ type: "task_state", task: makeTask({ taskId: "b", status: "running", startedAt: 1, createdAt: 20 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "a", status: "running", startedAt: 1, createdAt: 10 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "c", status: "queued", queuePosition: 1, createdAt: 30 }) });

    expect(store.activeTasks.map((t) => t.taskId)).toEqual(["b", "a", "c"]);
  });

  it("terminalTasks keeps the full terminal mirror, most recently ended first (no 20-cap)", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();

    for (let i = 0; i < 25; i += 1) {
      emit({
        type: "task_state",
        task: makeTask({ taskId: `done-${i}`, status: "completed", endedAt: i }),
      });
    }

    expect(store.terminalTasks).toHaveLength(25);
    expect(store.terminalTasks[0].taskId).toBe("done-24");
    // 1.5 (P2): the cap is gone - the history view renders the full mirror and
    // the retention pass is the bound.
    expect(store.tasks).toHaveLength(25);
  });

  it("terminalTasks excludes running/queued/waiting_input/interrupted tasks", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();

    emit({ type: "task_state", task: makeTask({ taskId: "run-1", status: "running", startedAt: 1 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "queue-1", status: "queued", queuePosition: 1 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "wait-1", status: "waiting_input", startedAt: 1 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "int-1", status: "interrupted" }) });
    emit({ type: "task_state", task: makeTask({ taskId: "done-1", status: "completed", endedAt: 5 }) });

    expect(store.terminalTasks.map((t) => t.taskId)).toEqual(["done-1"]);
  });

  it("tracks the selected task", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    emit({ type: "task_state", task: makeTask({ taskId: "task-1", status: "running", startedAt: 1 }) });

    expect(store.selectedTaskId).toBeNull();
    expect(store.selectedTask).toBeNull();

    store.selectTask("task-1");
    expect(store.selectedTaskId).toBe("task-1");
    expect(store.selectedTask?.taskId).toBe("task-1");

    store.selectTask(null);
    expect(store.selectedTask).toBeNull();
  });
});

// ============================================================================
// Task center open/close (1.5 P2): the only entry / exit of the center view
// ============================================================================

describe("task center", () => {
  it("openTaskCenter() opens without changing the selection", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    emit({ type: "task_state", task: makeTask({ taskId: "task-1", status: "running", startedAt: 1 }) });

    expect(store.centerOpen).toBe(false);
    store.openTaskCenter();
    expect(store.centerOpen).toBe(true);
    expect(store.selectedTaskId).toBeNull();

    store.closeTaskCenter();
    expect(store.centerOpen).toBe(false);
  });

  it("openTaskCenter(taskId) opens already focused on the task (deep link)", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    emit({ type: "task_state", task: makeTask({ taskId: "task-1", status: "completed", endedAt: 5 }) });

    store.openTaskCenter("task-1");
    expect(store.centerOpen).toBe(true);
    expect(store.selectedTaskId).toBe("task-1");
    expect(store.selectedTask?.taskId).toBe("task-1");
  });

  it("closeTaskCenter does not clear the selection (reopening keeps this task focused)", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    emit({ type: "task_state", task: makeTask({ taskId: "task-1", status: "running", startedAt: 1 }) });

    store.openTaskCenter("task-1");
    store.closeTaskCenter();
    expect(store.centerOpen).toBe(false);
    expect(store.selectedTaskId).toBe("task-1");
  });
});

// ============================================================================
// Group-level auto-background deadline mirroring
// ============================================================================

describe("auto-background deadline mirroring", () => {
  it("mirrors a task_state deadline onto non-terminal siblings of the same group", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();

    emit({ type: "task_state", task: makeTask({ taskId: "a", groupId: "g1", status: "running", startedAt: 1 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "b", groupId: "g1", status: "queued", queuePosition: 1 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "c", groupId: "g2", status: "queued", queuePosition: 1 }) });

    emit({
      type: "task_state",
      task: makeTask({ taskId: "a", groupId: "g1", status: "running", startedAt: 1, autoBackground: makeAutoBackground() }),
    });

    expect(store.tasks.find((t) => t.taskId === "a")?.autoBackground).toEqual(makeAutoBackground());
    expect(store.tasks.find((t) => t.taskId === "b")?.autoBackground).toEqual(makeAutoBackground());
    // Other groups are untouched.
    expect(store.tasks.find((t) => t.taskId === "c")?.autoBackground).toBeUndefined();
  });

  it("shares the warning flag across the group and never regresses it", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();

    emit({
      type: "task_state",
      task: makeTask({ taskId: "a", groupId: "g1", status: "running", startedAt: 1, autoBackground: makeAutoBackground() }),
    });
    emit({
      type: "task_state",
      task: makeTask({ taskId: "b", groupId: "g1", status: "queued", queuePosition: 1, autoBackground: makeAutoBackground() }),
    });
    expect(store.tasks.find((t) => t.taskId === "b")?.autoBackground?.warningActive).toBe(false);

    // The warning fires on one child; the whole group shares it.
    emit({
      type: "task_state",
      task: makeTask({
        taskId: "a",
        groupId: "g1",
        status: "running",
        startedAt: 1,
        autoBackground: makeAutoBackground({ warningActive: true }),
      }),
    });
    expect(store.tasks.find((t) => t.taskId === "a")?.autoBackground?.warningActive).toBe(true);
    expect(store.tasks.find((t) => t.taskId === "b")?.autoBackground?.warningActive).toBe(true);

    // An out-of-order equal-deadline push without the warning must not regress it.
    emit({
      type: "task_state",
      task: makeTask({ taskId: "b", groupId: "g1", status: "queued", queuePosition: 1, autoBackground: makeAutoBackground() }),
    });
    expect(store.tasks.find((t) => t.taskId === "b")?.autoBackground?.warningActive).toBe(true);
  });

  it("does not clear sibling deadlines when a terminal child completes", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();

    emit({
      type: "task_state",
      task: makeTask({ taskId: "a", groupId: "g1", status: "running", startedAt: 1, autoBackground: makeAutoBackground() }),
    });
    emit({
      type: "task_state",
      task: makeTask({ taskId: "b", groupId: "g1", status: "queued", queuePosition: 1, autoBackground: makeAutoBackground() }),
    });

    // Terminal task_state drops autoBackground (invariant) and must not clear
    // the still-running siblings' shared deadline.
    emit({ type: "task_state", task: makeTask({ taskId: "b", groupId: "g1", status: "completed", endedAt: 5 }) });
    expect(store.tasks.find((t) => t.taskId === "a")?.autoBackground).toEqual(makeAutoBackground());
  });

  it("clears the deadline across the group when a non-terminal task drops it (timer cancelled)", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();

    emit({
      type: "task_state",
      task: makeTask({ taskId: "a", groupId: "g1", status: "running", startedAt: 1, autoBackground: makeAutoBackground() }),
    });
    emit({
      type: "task_state",
      task: makeTask({ taskId: "b", groupId: "g1", status: "queued", queuePosition: 1, autoBackground: makeAutoBackground() }),
    });

    // continueForegroundWait cancelled the group timer: the push for one child
    // carries no deadline, so every non-terminal sibling loses it too.
    emit({ type: "task_state", task: makeTask({ taskId: "a", groupId: "g1", status: "running", startedAt: 1 }) });
    expect(store.tasks.find((t) => t.taskId === "a")?.autoBackground).toBeUndefined();
    expect(store.tasks.find((t) => t.taskId === "b")?.autoBackground).toBeUndefined();
  });

  it("exposes one shared deadline per group through groupAutoBackgrounds", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();

    emit({
      type: "task_state",
      task: makeTask({ taskId: "a", groupId: "g1", status: "running", startedAt: 1, autoBackground: makeAutoBackground() }),
    });
    emit({
      type: "task_state",
      task: makeTask({ taskId: "b", groupId: "g1", status: "queued", queuePosition: 1, autoBackground: makeAutoBackground() }),
    });
    emit({
      type: "task_state",
      task: makeTask({
        taskId: "c",
        groupId: "g2",
        status: "running",
        startedAt: 1,
        autoBackground: makeAutoBackground({ deadlineAt: 2000, warningAt: 1900 }),
      }),
    });

    expect(store.groupAutoBackgrounds.get("g1")).toEqual(makeAutoBackground());
    expect(store.groupAutoBackgrounds.get("g2")).toEqual(makeAutoBackground({ deadlineAt: 2000, warningAt: 1900 }));
    expect(store.groupAutoBackgrounds.size).toBe(2);

    // The group timer is cancelled: the group disappears from the map.
    emit({ type: "task_state", task: makeTask({ taskId: "a", groupId: "g1", status: "running", startedAt: 1 }) });
    expect(store.groupAutoBackgrounds.has("g1")).toBe(false);
    expect(store.groupAutoBackgrounds.has("g2")).toBe(true);
  });
});

// ============================================================================
// Event idempotency
// ============================================================================

describe("event idempotency", () => {
  it("applies the same task_state twice without duplicating the mirror", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();

    const task = makeTask({ taskId: "task-1", status: "running", startedAt: 1 });
    emit({ type: "task_state", task });
    emit({ type: "task_state", task });

    expect(store.tasks).toHaveLength(1);
    expect(store.tasks[0]).toEqual(task);
  });

  it("replaces activities wholesale; repeated pushes are idempotent", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    emit({ type: "task_state", task: makeTask({ taskId: "task-1", status: "running", startedAt: 1 }) });

    const activities: AgentTaskActivity[] = [
      { sequence: 1, toolCallId: "tc-1", toolName: "bash", status: "completed", summary: "ok", startedAt: 1, endedAt: 2 },
    ];
    emit({ type: "task_activities", taskId: "task-1", activities });
    emit({ type: "task_activities", taskId: "task-1", activities });

    expect(store.tasks[0].activities).toEqual(activities);
    expect(store.tasks[0].activities).toHaveLength(1);

    // A newer merged batch replaces the older one wholesale.
    const newer: AgentTaskActivity[] = [...activities, { sequence: 2, toolCallId: "tc-2", toolName: "read", status: "running", startedAt: 3 }];
    emit({ type: "task_activities", taskId: "task-1", activities: newer });
    expect(store.tasks[0].activities).toEqual(newer);
  });

  it("replaces the output wholesale; repeated pushes are idempotent", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    emit({ type: "task_state", task: makeTask({ taskId: "task-1", status: "running", startedAt: 1 }) });

    emit({ type: "task_output", taskId: "task-1", output: "hello", truncated: false });
    emit({ type: "task_output", taskId: "task-1", output: "hello", truncated: false });

    expect(store.tasks[0].finalOutput).toBe("hello");
    expect(store.tasks[0].outputTruncated).toBe(false);
  });

  it("ignores events for unknown tasks instead of inventing state", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();

    emit({ type: "task_activities", taskId: "ghost", activities: [] });
    emit({ type: "task_output", taskId: "ghost", output: "x", truncated: false });

    expect(store.tasks).toHaveLength(0);
  });

  it("deduplicates repeated input requests by taskId+requestId+generation", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();

    const request = makeInputRequest();
    emitInput(request);
    emitInput(request);
    emitInput(makeInputRequest({ requestId: "req-1", generation: 1 }));

    expect(store.activeInputRequests).toHaveLength(2);
  });

  it("makes repeat dismissals no-ops", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    emitInput(makeInputRequest());

    emit({ type: "task_input_dismissed", taskId: "task-1", requestId: "req-1", generation: 0, reason: "aborted" });
    emit({ type: "task_input_dismissed", taskId: "task-1", requestId: "req-1", generation: 0, reason: "aborted" });

    expect(store.activeInputRequests).toHaveLength(0);
  });
});

// ============================================================================
// Active input requests
// ============================================================================

describe("active input requests", () => {
  it("appends input requests from the dedicated channel in arrival order", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();

    emitInput(makeInputRequest({ taskId: "task-1", requestId: "req-1" }));
    emitInput(makeInputRequest({ taskId: "task-2", requestId: "req-2" }));

    expect(store.activeInputRequests.map((r) => r.taskId)).toEqual(["task-1", "task-2"]);
  });

  it("removes a dismissed request only when the triple key matches", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    emitInput(makeInputRequest({ taskId: "task-1", requestId: "req-1", generation: 0 }));

    // Wrong requestId / generation: still pending.
    emit({ type: "task_input_dismissed", taskId: "task-1", requestId: "req-2", generation: 0, reason: "aborted" });
    emit({ type: "task_input_dismissed", taskId: "task-1", requestId: "req-1", generation: 1, reason: "aborted" });
    expect(store.activeInputRequests).toHaveLength(1);

    emit({ type: "task_input_dismissed", taskId: "task-1", requestId: "req-1", generation: 0, reason: "answered" });
    expect(store.activeInputRequests).toHaveLength(0);
  });

  it("hydrates active inputs from get_active_input_requests on remount", async () => {
    const store = useAgentTaskStore();
    sendAgentTaskCommand.mockResolvedValue({
      success: true,
      data: [
        makeInputRequest({ taskId: "task-1", requestId: "req-1" }),
        makeInputRequest({ taskId: "task-2", requestId: "req-2" }),
      ],
    });

    await store.refreshActiveInputRequests();

    expect(sendAgentTaskCommand).toHaveBeenCalledWith({ type: "get_active_input_requests" });
    expect(store.activeInputRequests).toHaveLength(2);
  });
});

// ============================================================================
// Remount catch-up
// ============================================================================

describe("remount catch-up", () => {
  it("hydrates the mirror from get_all and keeps the service order", async () => {
    const store = useAgentTaskStore();
    const older = makeTask({ taskId: "task-1", status: "completed", endedAt: 2, createdAt: 1 });
    const newer = makeTask({ taskId: "task-2", status: "running", startedAt: 3, createdAt: 2 });
    sendAgentTaskCommand.mockResolvedValue({ success: true, data: [older, newer] });

    await store.refreshTasks();

    expect(sendAgentTaskCommand).toHaveBeenCalledWith({ type: "get_all" });
    expect(store.tasks.map((t) => t.taskId)).toEqual(["task-1", "task-2"]);
  });

  it("does not touch the mirrors when the catch-up queries fail", async () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    emit({ type: "task_state", task: makeTask({ taskId: "task-1", status: "running", startedAt: 1 }) });
    emitInput(makeInputRequest({ taskId: "task-1", requestId: "req-1" }));

    sendAgentTaskCommand.mockResolvedValue({ success: false, code: "x", error: "boom" });
    await store.refreshTasks();
    await store.refreshActiveInputRequests();

    expect(store.tasks).toHaveLength(1);
    expect(store.activeInputRequests).toHaveLength(1);
  });
});

// ============================================================================
// Command actions
// ============================================================================

describe("command actions", () => {
  it("maps every action onto the AgentTaskCommand contract", async () => {
    const store = useAgentTaskStore();

    await store.cancel("task-1", 0);
    expect(sendAgentTaskCommand).toHaveBeenCalledWith({ type: "cancel", taskId: "task-1", generation: 0 });

    await store.respondInput("task-1", "req-1", 0, makeResponse());
    expect(sendAgentTaskCommand).toHaveBeenCalledWith({
      type: "respond_input",
      taskId: "task-1",
      requestId: "req-1",
      generation: 0,
      response: makeResponse(),
    });

    await store.cancelInput("task-1", "req-1", 0);
    expect(sendAgentTaskCommand).toHaveBeenCalledWith({ type: "cancel_input", taskId: "task-1", requestId: "req-1", generation: 0 });

    await store.exportDiagnostics("task-1");
    expect(sendAgentTaskCommand).toHaveBeenCalledWith({ type: "export_diagnostics", taskId: "task-1" });

    // 1.5 (P1): the manual-operation commands (background / foreground /
    // continue_foreground_wait / send_to_session / clear / clear_all_terminal /
    // resume / mark_failed / get_resume_summary) are gone from the store.
    const storeActions = Object.keys(store);
    for (const removed of [
      "background",
      "foreground",
      "continueForegroundWait",
      "sendToSession",
      "clearTask",
      "clearAllTerminal",
      "getResumeSummary",
      "resume",
      "markFailed",
    ]) {
      expect(storeActions, `removed action ${removed}`).not.toContain(removed);
    }
  });

  it("surfaces command failures in lastError", async () => {
    const store = useAgentTaskStore();
    sendAgentTaskCommand.mockResolvedValue({ success: false, code: "stale_generation", error: "Task generation is stale." });

    const result = await store.cancel("task-1", 0);

    expect(result.success).toBe(false);
    expect(store.lastError).toBe("Task generation is stale.");
    store.clearError();
    expect(store.lastError).toBeNull();
  });

  it("returns the envelope and clears lastError on success", async () => {
    const store = useAgentTaskStore();
    sendAgentTaskCommand.mockResolvedValue({ success: false, code: "x", error: "boom" });
    await store.cancel("task-1", 0);
    expect(store.lastError).toBe("boom");

    const response: PixCommandResult<undefined> = { success: true };
    sendAgentTaskCommand.mockResolvedValue(response);
    const result = await store.cancel("task-1", 0);

    expect(result).toEqual(response);
    expect(store.lastError).toBeNull();
  });
});

// ============================================================================
// task_removed mirror convergence (1.5 P1): the retention pass deletes
// terminal records in main and announces each one through a task_removed
// push; the renderer converges every mirror off that event.
// ============================================================================

describe("task_removed mirror convergence", () => {
  it("removes the deleted task and its input requests / recovery issue / selection from the mirrors", async () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    emit({ type: "task_state", task: makeTask({ taskId: "done-1", status: "completed", endedAt: 5 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "run-1", status: "running", startedAt: 6 }) });
    emitInput(makeInputRequest({ taskId: "done-1", requestId: "req-1" }));
    emit({ type: "recovery_issue", issue: makeRecoveryIssue({ taskId: "done-1" }) });
    emit({ type: "recovery_issue", issue: makeRecoveryIssue({ taskId: "other-1" }) });
    store.openTaskCenter("done-1");

    emit({ type: "task_removed", taskId: "done-1" });

    expect(store.tasks.map((t) => t.taskId)).toEqual(["run-1"]);
    expect(store.activeInputRequests).toHaveLength(0);
    expect(store.recoveryIssues.map((i) => i.taskId)).toEqual(["other-1"]);
    // 1.5 (P2): the deleted selected task loses the selection (empty detail placeholder).
    expect(store.selectedTaskId).toBeNull();
    expect(store.selectedTask).toBeNull();
  });

  it("keeps the selection when the removed task is not the selected one", async () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    emit({ type: "task_state", task: makeTask({ taskId: "done-1", status: "completed", endedAt: 5 }) });
    emit({ type: "task_state", task: makeTask({ taskId: "run-1", status: "running", startedAt: 6 }) });
    store.selectTask("run-1");

    emit({ type: "task_removed", taskId: "done-1" });

    expect(store.selectedTaskId).toBe("run-1");
  });

  it("is idempotent when the removed task is already gone from the mirror", async () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    emit({ type: "task_state", task: makeTask({ taskId: "run-1", status: "running", startedAt: 1 }) });

    emit({ type: "task_removed", taskId: "never-known" });
    emit({ type: "task_removed", taskId: "run-1" });
    emit({ type: "task_removed", taskId: "run-1" });

    expect(store.tasks).toHaveLength(0);
  });
});

// ============================================================================
// Transcript channel (1.5 P3 stage S5): watch/unwatch commands, per-task
// transcript buffer (disk paging + live ring with seq cursor), terminal
// watched clear and task_removed cleanup.
// ============================================================================

describe("transcript channel", () => {
  it("watchTask sends watch_task and marks the task watched locally", async () => {
    const store = useAgentTaskStore();

    await store.watchTask("task-1");

    expect(sendAgentTaskCommand).toHaveBeenCalledWith({ type: "watch_task", taskId: "task-1" });
    expect(store.transcripts["task-1"]?.watched).toBe(true);
  });

  it("unwatchTask sends unwatch_task and clears the local watched flag", async () => {
    const store = useAgentTaskStore();
    await store.watchTask("task-1");

    store.unwatchTask("task-1");

    expect(sendAgentTaskCommand).toHaveBeenCalledWith({ type: "unwatch_task", taskId: "task-1" });
    expect(store.transcripts["task-1"]?.watched).toBe(false);
  });

  it("loadTranscriptPage drains pages until nextCursor is null and accumulates the full entries", async () => {
    const store = useAgentTaskStore();
    let page = 0;
    sendAgentTaskCommand.mockImplementation(async (command: Record<string, unknown>) => {
      if (command.type === "get_transcript") {
        page += 1;
        return page === 1
          ? { success: true, data: { taskId: "task-1", itemIndex: 0, entries: [{ n: 1 }, { n: 2 }], totalCount: 3, nextCursor: "c1" } }
          : { success: true, data: { taskId: "task-1", itemIndex: 0, entries: [{ n: 3 }], totalCount: 3, nextCursor: null } };
      }
      return { success: true };
    });

    await store.loadTranscriptPage("task-1");

    expect(page).toBe(2);
    const transcriptCalls = sendAgentTaskCommand.mock.calls
      .filter(([command]) => (command as { type: string }).type === "get_transcript")
      .map(([command]) => command as { type: string; taskId: string; itemIndex: number; cursor?: string });
    expect(transcriptCalls.map((call) => call.cursor)).toEqual([undefined, "c1"]);
    const item = store.transcripts["task-1"]?.byItem[0];
    expect(item?.entries).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(item?.totalCount).toBe(3);
    expect(item?.nextCursor).toBeNull();
    expect(item?.loading).toBe(false);
  });

  it("marks byItem.loading while the paging command is in flight", async () => {
    const store = useAgentTaskStore();
    let resolvePage: ((value: unknown) => void) | undefined;
    sendAgentTaskCommand.mockImplementation(
      () => new Promise((resolve) => { resolvePage = resolve; }),
    );

    const pending = store.loadTranscriptPage("task-1");

    expect(store.transcripts["task-1"]?.byItem[0]?.loading).toBe(true);
    resolvePage?.({
      success: true,
      data: { taskId: "task-1", itemIndex: 0, entries: [{ n: 1 }], totalCount: 1, nextCursor: null },
    });
    await pending;
    const item = store.transcripts["task-1"]?.byItem[0];
    expect(item?.loading).toBe(false);
    expect(item?.entries).toHaveLength(1);
  });

  it("keeps the previous entries when a re-drain fails (disk replay failure is not a regression)", async () => {
    const store = useAgentTaskStore();
    let fail = false;
    sendAgentTaskCommand.mockImplementation(async (command: Record<string, unknown>) => {
      if (command.type === "get_transcript") {
        if (fail) return { success: false, code: "agent_task_command_failed", error: "io" };
        return { success: true, data: { taskId: "task-1", itemIndex: 0, entries: [{ n: 1 }], totalCount: 1, nextCursor: null } };
      }
      return { success: true };
    });

    await store.loadTranscriptPage("task-1");
    expect(store.transcripts["task-1"]?.byItem[0]?.entries).toHaveLength(1);

    fail = true;
    await store.loadTranscriptPage("task-1");
    expect(store.transcripts["task-1"]?.byItem[0]?.entries).toHaveLength(1);
    expect(store.lastError).toBe("io");
  });

  it("accumulates task_transcript pushes with a monotonic seq per task", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();

    emit({ type: "task_transcript", taskId: "task-1", itemIndex: 0, event: { type: "turn_start" } });
    emit({ type: "task_transcript", taskId: "task-2", itemIndex: 1, event: { type: "turn_start" } });
    emit({ type: "task_transcript", taskId: "task-1", itemIndex: 0, event: { type: "turn_end", message: { role: "assistant", content: "x" }, toolResults: [] } });

    expect(store.transcripts["task-1"]?.liveEvents.map((entry) => entry.seq)).toEqual([0, 2]);
    expect(store.transcripts["task-2"]?.liveEvents.map((entry) => entry.seq)).toEqual([1]);
    // 初始 consumedSeq 为 0(未消费)。
    expect(store.transcripts["task-1"]?.consumedSeq).toBe(0);
  });

  it("caps the live ring at 4000 (drop oldest, liveDropped=true)", () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();

    for (let i = 0; i < 4001; i += 1) {
      emit({ type: "task_transcript", taskId: "task-1", itemIndex: i % 2, event: { type: "turn_start" } });
    }

    const state = store.transcripts["task-1"];
    expect(state?.liveEvents).toHaveLength(4000);
    expect(state?.liveEvents[0].seq).toBe(1);
    expect(state?.liveEvents[3999].seq).toBe(4000);
    expect(state?.liveDropped).toBe(true);
    // 未 watch 的任务不置 watched。
    expect(state?.watched).toBe(false);
  });

  it("a terminal task_state while watched clears the local watched flag", async () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    await store.watchTask("task-1");
    expect(store.transcripts["task-1"]?.watched).toBe(true);

    emit({ type: "task_state", task: makeTask({ taskId: "task-1", status: "completed", endedAt: 5 }) });
    expect(store.transcripts["task-1"]?.watched).toBe(false);

    // 非终态 push 不误清。
    await store.watchTask("task-1");
    emit({ type: "task_state", task: makeTask({ taskId: "task-1", status: "running", startedAt: 6 }) });
    expect(store.transcripts["task-1"]?.watched).toBe(true);
  });

  it("task_removed clears transcripts[taskId] and the selection", async () => {
    const store = useAgentTaskStore();
    store.subscribeToEvents();
    emit({ type: "task_state", task: makeTask({ taskId: "task-1", status: "running", startedAt: 1 }) });
    await store.watchTask("task-1");
    emit({ type: "task_transcript", taskId: "task-1", itemIndex: 0, event: { type: "turn_start" } });
    store.openTaskCenter("task-1");

    emit({ type: "task_removed", taskId: "task-1" });

    expect(store.transcripts["task-1"]).toBeUndefined();
    expect(store.selectedTaskId).toBeNull();
    // 幂等:重复删除不重建缓存。
    emit({ type: "task_removed", taskId: "task-1" });
    expect(store.transcripts["task-1"]).toBeUndefined();
  });
});
