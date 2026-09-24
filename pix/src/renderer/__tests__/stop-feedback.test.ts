/**
 * Stop-button immediate feedback tests (SDD R2, §3.2).
 *
 * Contract: stopRequested is an optimistic flag local to createRpcClient —
 * set the moment abort/abort_retry is sent (even if the command itself fails;
 * lifecycle events own the clear), cleared by agent_end / compaction_end /
 * stopRuntime and at session boundaries (newSession/switchSession), because
 * backgrounded old sessions no longer forward agent_end to the renderer.
 * CenterPanel composes it into stopPending for the spinner; template-level
 * behavior is covered by typecheck + manual testing.
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, RpcCommand } from "@shared/types.js";
import { createRpcClient, type RpcTransport } from "../composables/useRpc";

// ============================================================================
// Fixtures
// ============================================================================

const agentEnd: AgentSessionEvent = { type: "agent_end", messages: [] };
const compactionEnd: AgentSessionEvent = {
  type: "compaction_end",
  reason: "manual",
  aborted: false,
  willRetry: false,
};

interface Harness {
  client: ReturnType<typeof createRpcClient>;
  sendCommand: ReturnType<typeof createSendCommandMock>;
  emit: (event: AgentSessionEvent) => void;
}

function createSendCommandMock() {
  return vi.fn(async (_command: RpcCommand): Promise<{ success: boolean; data?: unknown; error?: string }> => ({
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

/** Attach a client so its event listeners are installed and sessionState is
 *  populated (the compaction_end branch only lands when a session exists). */
async function attachedHarness(): Promise<Harness> {
  const harness = createHarness();
  const attached = await harness.client.attachToRunningSession();
  expect(attached).toBe(true);
  return harness;
}

// ============================================================================
// Tests
// ============================================================================

describe("stop-button immediate feedback (R2)", () => {
  it("abort() sets stopRequested optimistically", async () => {
    const harness = await attachedHarness();
    expect(harness.client.stopRequested.value).toBe(false);

    await harness.client.abort();

    expect(harness.client.stopRequested.value).toBe(true);
  });

  it("abortRetry() sets stopRequested optimistically", async () => {
    const harness = await attachedHarness();

    await harness.client.abortRetry();

    expect(harness.client.stopRequested.value).toBe(true);
  });

  it("stays set even when the abort command itself fails", async () => {
    const harness = await attachedHarness();
    harness.sendCommand.mockResolvedValueOnce({ success: false, error: "boom" });

    await harness.client.abort();

    expect(harness.client.stopRequested.value).toBe(true);
  });

  it("agent_end clears stopRequested", async () => {
    const harness = await attachedHarness();
    await harness.client.abort();

    harness.emit(agentEnd);

    expect(harness.client.stopRequested.value).toBe(false);
  });

  it("compaction_end clears stopRequested", async () => {
    const harness = await attachedHarness();
    await harness.client.abort();

    harness.emit(compactionEnd);

    expect(harness.client.stopRequested.value).toBe(false);
  });

  it("stopRuntime clears stopRequested", async () => {
    const harness = await attachedHarness();
    await harness.client.abort();

    await harness.client.stopRuntime();

    expect(harness.client.stopRequested.value).toBe(false);
  });

  it("newSession clears stopRequested (session boundary)", async () => {
    const harness = await attachedHarness();
    await harness.client.abort();

    await harness.client.newSession();

    expect(harness.client.stopRequested.value).toBe(false);
  });

  it("switchSession clears stopRequested (session boundary)", async () => {
    const harness = await attachedHarness();
    await harness.client.abort();

    await harness.client.switchSession("C:\\tmp\\session.jsonl");

    expect(harness.client.stopRequested.value).toBe(false);
  });
});
