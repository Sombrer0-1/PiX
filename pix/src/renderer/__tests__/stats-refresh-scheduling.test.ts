/**
 * Stats refresh scheduling tests (PiX perf SDD stage S4, §4.4).
 *
 * Contract: message_end / tool_execution_end / eye_model_end use a leading +
 * trailing debounce (500ms): the first call after a quiet gap fires immediately,
 * later calls in the window collapse into one trailing refresh; agent_end
 * cancels the pending timer and refreshes immediately (no double fire);
 * cleanup cancels the pending timer. Debounce state lives inside each
 * createRpcClient closure, so every test builds its own client.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, RpcCommand } from "@shared/types.js";
import { createRpcClient, STATS_REFRESH_DEBOUNCE_MS, type RpcTransport } from "../composables/useRpc";

// ============================================================================
// Fixtures
// ============================================================================

const messageEnd: AgentSessionEvent = { type: "message_end", message: { role: "assistant", content: "done" } };
const toolExecutionEnd: AgentSessionEvent = {
  type: "tool_execution_end",
  toolCallId: "tool-1",
  toolName: "bash",
  result: "",
  isError: false,
};
const eyeModelEnd: AgentSessionEvent = {
  type: "eye_model_end",
  provider: "openai",
  modelId: "gpt-4o",
  imageCount: 1,
  success: true,
};
const agentEnd: AgentSessionEvent = { type: "agent_end", messages: [] };

interface Harness {
  client: ReturnType<typeof createRpcClient>;
  sendCommand: ReturnType<typeof createSendCommandMock>;
  emit: (event: AgentSessionEvent) => void;
}

function createSendCommandMock() {
  return vi.fn(async (_command: RpcCommand): Promise<{ success: boolean; data?: unknown }> => ({
    success: true,
    data: {},
  }));
}

function createHarness(): Harness {
  const sendCommand = createSendCommandMock();
  let eventCallback: ((event: AgentSessionEvent) => void) | null = null;
  const transport: RpcTransport = {
    sendCommand: sendCommand as unknown as RpcTransport["sendCommand"],
    sendCommandAsync: async () => ({ success: true }),
    startRuntime: async () => ({ success: true }),
    stopRuntime: async () => ({ success: true }),
    isRuntimeRunning: async () => true,
    onEvent: (callback) => {
      eventCallback = callback;
      return () => {
        eventCallback = null;
      };
    },
    onReady: () => () => {},
    onExit: () => () => {},
    onError: () => () => {},
    onUserInputRequest: () => () => {},
    getBackgroundTasks: async () => [],
    stopBackgroundTask: async () => ({ found: true }),
    mcpGetServers: async () => [],
    mcpGetConfig: async () => ({ configPaths: [], errors: [] }),
    mcpListResources: async () => [],
    mcpReadResource: async () => ({ server: "", contents: [] }),
    setGuiSettings: async () => ({ success: true }),
    getExecutionEnvironment: async () => null,
  };
  const client = createRpcClient(transport, "test");
  return {
    client,
    sendCommand,
    emit: (event) => eventCallback?.(event),
  };
}

/** Attach a client so its event listeners are installed, then drop the
 *  refreshSessionData traffic so tests count only event-triggered stats. */
async function attachedHarness(): Promise<Harness> {
  const harness = createHarness();
  const attached = await harness.client.attachToRunningSession();
  expect(attached).toBe(true);
  harness.sendCommand.mockClear();
  return harness;
}

function statsCallCount(harness: Harness): number {
  return harness.sendCommand.mock.calls.filter(([command]) => command.type === "get_session_stats").length;
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("stats refresh scheduling (S4 §4.4)", () => {
  it("pins the debounce window to 500ms", () => {
    expect(STATS_REFRESH_DEBOUNCE_MS).toBe(500);
  });

  it("leading fire plus trailing coalescing inside the window", async () => {
    const harness = await attachedHarness();

    harness.emit(messageEnd);
    // First call after a quiet gap fires immediately.
    expect(statsCallCount(harness)).toBe(1);

    harness.emit(toolExecutionEnd);
    await vi.advanceTimersByTimeAsync(200);
    harness.emit(eyeModelEnd);
    await vi.advanceTimersByTimeAsync(100);
    // Still inside the trailing window: no second call yet.
    expect(statsCallCount(harness)).toBe(1);

    await vi.advanceTimersByTimeAsync(STATS_REFRESH_DEBOUNCE_MS);
    expect(statsCallCount(harness)).toBe(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(statsCallCount(harness)).toBe(2);
  });

  it("fires immediately again after the window has elapsed", async () => {
    const harness = await attachedHarness();

    harness.emit(messageEnd);
    await vi.advanceTimersByTimeAsync(STATS_REFRESH_DEBOUNCE_MS);
    expect(statsCallCount(harness)).toBe(1);

    harness.emit(toolExecutionEnd);
    expect(statsCallCount(harness)).toBe(2);

    await vi.advanceTimersByTimeAsync(STATS_REFRESH_DEBOUNCE_MS * 2);
    expect(statsCallCount(harness)).toBe(2);
  });

  it("agent_end flushes immediately and cancels the pending trailing timer", async () => {
    const harness = await attachedHarness();

    harness.emit(messageEnd);
    expect(statsCallCount(harness)).toBe(1);
    harness.emit(toolExecutionEnd);
    await vi.advanceTimersByTimeAsync(300);
    expect(statsCallCount(harness)).toBe(1);

    harness.emit(agentEnd);
    expect(statsCallCount(harness)).toBe(2);

    await vi.advanceTimersByTimeAsync(STATS_REFRESH_DEBOUNCE_MS * 2);
    expect(statsCallCount(harness)).toBe(2);
  });

  it("agent_end without a pending schedule still refreshes exactly once", async () => {
    const harness = await attachedHarness();

    harness.emit(agentEnd);
    expect(statsCallCount(harness)).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(statsCallCount(harness)).toBe(1);
  });

  it("stopRuntime cancels a pending trailing stats refresh timer", async () => {
    const harness = await attachedHarness();

    harness.emit(messageEnd);
    expect(statsCallCount(harness)).toBe(1);
    harness.emit(toolExecutionEnd);
    await harness.client.stopRuntime();
    await vi.advanceTimersByTimeAsync(STATS_REFRESH_DEBOUNCE_MS * 2);
    expect(statsCallCount(harness)).toBe(1);
  });

  it("agent_start keeps its direct (non-debounced) stats refresh", async () => {
    const harness = await attachedHarness();

    harness.emit({ type: "agent_start" });
    expect(statsCallCount(harness)).toBe(1);

    await vi.advanceTimersByTimeAsync(STATS_REFRESH_DEBOUNCE_MS * 2);
    expect(statsCallCount(harness)).toBe(1);
  });
});
