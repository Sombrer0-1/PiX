/**
 * display-blocks assembler tests (PiX 1.4.x, stage P3-S3).
 *
 * Acceptance (Plan 8): live event folding (直播事件折叠), replay loading with
 * custom_message → note folding (回放装载), clear-then-fold idempotency,
 * optimistic user messages, and both seam-dedup rules (toolCallId duplicate
 * drop, triple-key message drop).
 *
 * The assembler is framework-free: tests exercise it directly without Pinia
 * or Vue mounting.
 */

import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentSessionEvent } from "@shared/types.js";
import type { DisplayBlock } from "@/types/session";
import { createDisplayBlockAssembler } from "../utils/display-blocks";

// ============================================================================
// Fixtures
// ============================================================================

function makeMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return { role: "user", content: "hello", timestamp: 1000, ...overrides };
}

function textBlocks(text: string): Array<{ type: string; text: string }> {
  return [{ type: "text", text }];
}

/** ToolCall content block as it appears inside an assistant message (extra
 * fields beyond the AgentMessage content shape; the assembler duck-types them). */
function toolCallBlock(id: string, name: string, args: unknown): { type: string; text?: string } {
  return { type: "toolCall", id, name, arguments: args } as { type: string; text?: string };
}

function msgStart(message: AgentMessage): AgentSessionEvent {
  return { type: "message_start", message };
}

function msgUpdate(message: AgentMessage): AgentSessionEvent {
  return { type: "message_update", message };
}

function msgEnd(message: AgentMessage): AgentSessionEvent {
  return { type: "message_end", message };
}

function toolStart(toolCallId: string, toolName = "bash"): AgentSessionEvent {
  return { type: "tool_execution_start", toolCallId, toolName, args: { command: "ls" } };
}

function toolEnd(toolCallId: string, toolName = "bash", result: unknown, isError = false): AgentSessionEvent {
  return { type: "tool_execution_end", toolCallId, toolName, result, isError };
}

// ============================================================================
// Live event folding
// ============================================================================

describe("live event folding", () => {
  it("folds a full user/assistant turn, aggregating tools into one work-status block", () => {
    const a = createDisplayBlockAssembler();
    a.applyEvents([
      { type: "agent_start" },
      msgStart(makeMessage({ role: "user", content: "list files", timestamp: 100 })),
      msgEnd(makeMessage({ role: "user", content: "list files", timestamp: 100 })),
      msgStart(makeMessage({ role: "assistant", content: "", timestamp: 200 })),
      { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
      { type: "tool_execution_update", toolCallId: "t1", toolName: "bash", args: {}, partialResult: "file1\n" },
      { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "file1\nfile2\n", isError: false },
      msgUpdate(makeMessage({ role: "assistant", content: "Done", timestamp: 200 })),
      msgEnd(makeMessage({ role: "assistant", content: "Done", timestamp: 200 })),
      { type: "agent_end", messages: [] },
    ]);

    const blocks = a.blocks;
    // The thinking block shown after the user message is removed when the
    // tool runs, so final blocks are: user, work-status, agent.
    expect(blocks.map((b) => b.type)).toEqual(["user-message", "work-status", "agent-message"]);

    const ws = blocks[1];
    expect(ws.type).toBe("work-status");
    if (ws.type === "work-status") {
      expect(ws.tools).toHaveLength(1);
      expect(ws.tools[0].toolCallId).toBe("t1");
      expect(ws.tools[0].result).toBe("file1\nfile2\n");
      expect(ws.isStreaming).toBe(false);
    }
    const agent = blocks[2];
    expect(agent.type).toBe("agent-message");
    if (agent.type === "agent-message") {
      expect(agent.content).toBe("Done");
      expect(agent.isStreaming).toBe(false);
    }
  });

  it("renders compaction, retry and api_error blocks and tracks lastRetryableError", () => {
    const a = createDisplayBlockAssembler();
    a.applyEvents([
      { type: "compaction_start", reason: "threshold" },
      { type: "compaction_end", reason: "threshold", result: { summary: "older context hmm" }, aborted: false, willRetry: false },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 500, errorMessage: "boom" },
      { type: "auto_retry_end", success: true, attempt: 1 },
      { type: "api_error", errorMessage: "rate limited", category: "rate_limit", httpStatus: 429, title: "请求限流", retryable: true },
    ]);

    expect(a.blocks.map((b) => b.type)).toEqual(["compaction", "compaction", "retry", "retry", "error"]);
    const error = a.blocks[a.blocks.length - 1];
    expect(a.lastRetryableError).toEqual({ blockId: error.id });

    // A later api_error with retryable=false clears it.
    a.applyEvent({ type: "api_error", errorMessage: "auth failed", category: "auth", httpStatus: 401, title: "认证失败", retryable: false });
    expect(a.lastRetryableError).toBeNull();

    // agent_start clears the retry affordance for a new turn.
    a.applyEvent({ type: "api_error", errorMessage: "overloaded", category: "overloaded", httpStatus: 529, title: "服务过载", retryable: true });
    expect(a.lastRetryableError).not.toBeNull();
    a.applyEvent({ type: "agent_start" });
    expect(a.lastRetryableError).toBeNull();
  });

  it("folds vision-status blocks for eye_model events", () => {
    const a = createDisplayBlockAssembler();
    a.applyEvent({ type: "eye_model_start", id: "eye-1", provider: "p", modelId: "m", imageCount: 2 });
    a.applyEvent({ type: "eye_model_end", id: "eye-1", provider: "p", modelId: "m", imageCount: 2, success: true });

    expect(a.blocks.map((b) => b.type)).toEqual(["vision-status"]);
    expect(a.blocks[0]).toMatchObject({ provider: "p", modelId: "m", status: "success", imageCount: 2 });
  });

  it("merges a steered teammate-message into a note when teamLeader is enabled", () => {
    const a = createDisplayBlockAssembler({ teamLeader: true });
    const note = '<teammate-message from="coder" role="tester">\nchecked the tests\n</teammate-message>';
    a.applyEvent(msgStart(makeMessage({ role: "user", content: note, timestamp: 5 })));
    a.applyEvent(msgEnd(makeMessage({ role: "user", content: note, timestamp: 5 })));

    expect(a.blocks.map((b) => b.type)).toEqual(["note"]);
    expect(a.blocks[0]).toMatchObject({ type: "note" });
  });

  it("does not expose streaming/api-error session state (assembler-local only)", () => {
    const a = createDisplayBlockAssembler();
    const events = [
      { type: "agent_start" },
      msgStart(makeMessage({ role: "user", content: "hi", timestamp: 1 })),
      msgEnd(makeMessage({ role: "user", content: "hi", timestamp: 1 })),
    ] as AgentSessionEvent[];
    a.applyEvents(events);
    // Blocks only — no isStreaming/errorMessage on the assembler surface.
    expect(Object.keys(a)).not.toContain("isStreaming");
    expect(Object.keys(a)).not.toContain("errorMessage");
  });
});

// ============================================================================
// Replay loading (loadEntries)
// ============================================================================

describe("loadEntries", () => {
  it("folds message entries in order and matches toolResult to pending tools", () => {
    const a = createDisplayBlockAssembler();
    a.loadEntries([
      { type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: makeMessage({ role: "user", content: "list files", timestamp: 100 }) },
      {
        type: "message", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:01.000Z",
        message: makeMessage({
          role: "assistant",
          content: [
            { type: "text", text: "Here you go" },
            toolCallBlock("t9", "bash", { command: "ls" }),
          ],
          timestamp: 200,
        }),
      },
      {
        type: "message", id: "e3", parentId: "e2", timestamp: "2026-01-01T00:00:02.000Z",
        message: makeMessage({
          role: "toolResult",
          toolCallId: "t9",
          toolName: "bash",
          content: [{ type: "text", text: "file1\n" }],
          isError: false,
          timestamp: 300,
        }),
      },
    ]);

    expect(a.blocks.map((b) => b.type)).toEqual(["user-message", "agent-message", "work-status"]);
    const ws = a.blocks[2];
    expect(ws.type).toBe("work-status");
    if (ws.type === "work-status") {
      expect(ws.tools).toHaveLength(1);
      expect(ws.tools[0].toolCallId).toBe("t9");
      expect(ws.tools[0].result).toEqual([{ type: "text", text: "file1\n" }]);
      expect(ws.isStreaming).toBe(false);
    }
  });

  it("folds custom_message entries into note blocks and skips display===false", () => {
    const a = createDisplayBlockAssembler();
    a.loadEntries([
      { type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: makeMessage({ role: "user", content: "before", timestamp: 100 }) },
      { type: "custom_message", timestamp: "2026-01-01T00:00:01.000Z", customType: "pix-task-resume", content: "自动恢复说明", display: true, details: { generation: 1 } },
      { type: "custom_message", timestamp: "2026-01-01T00:00:02.000Z", customType: "pi.goal_context", content: "hidden note", display: false, details: {} },
      { type: "custom_message", timestamp: "2026-01-01T00:00:03.000Z", customType: "pi.ui_note", content: "", display: true, details: { text: "目标已完成", kind: "goal_status" } },
      { type: "session", timestamp: "2026-01-01T00:00:04.000Z" },
      { type: "compaction", timestamp: "2026-01-01T00:00:05.000Z", summary: "x" },
    ]);

    expect(a.blocks.map((b) => b.type)).toEqual([
      "user-message",
      "note",
      "note",
    ]);
    expect(a.blocks[1]).toMatchObject({ type: "note", text: "自动恢复说明" });
    expect(a.blocks[2]).toMatchObject({ type: "note", text: "目标已完成" });
  });

  it("is idempotent: the same entries array refolds to identical blocks", () => {
    const a = createDisplayBlockAssembler();
    const entries = [
      { type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: makeMessage({ role: "user", content: "hi", timestamp: 100 }) },
      { type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: makeMessage({ role: "assistant", content: "answer", timestamp: 200 }) },
      { type: "custom_message", timestamp: "2026-01-01T00:00:02.000Z", customType: "pix-task-resume", content: "note", display: true, details: {} },
    ];
    a.loadEntries(entries);
    // Block ids are generated per fold; compare the fold shape only.
    const withoutIds = (blocks: unknown[]): unknown[] =>
      JSON.parse(JSON.stringify(blocks, (key, value) => (key === "id" ? undefined : value)));
    const first = withoutIds(a.blocks);
    a.loadEntries(entries);
    const second = withoutIds(a.blocks);
    expect(second).toEqual(first);
  });

  it("renders a failed assistant turn as an error block with the retry affordance on the last assistant message", () => {
    const a = createDisplayBlockAssembler();
    a.loadEntries([
      {
        type: "message", timestamp: "2026-01-01T00:00:00.000Z",
        message: makeMessage({ role: "assistant", content: [{ type: "text", text: "" }], timestamp: 100, stopReason: "error", errorMessage: "HTTP 500 status code" }),
      },
      {
        type: "message", timestamp: "2026-01-01T00:00:01.000Z",
        message: makeMessage({ role: "toolResult", toolCallId: "late", toolName: "bash", content: [{ type: "text", text: "flushed" }], isError: false, timestamp: 200 }),
      },
    ]);
    // The flush trailing toolResult must not hide the error block's retry affordance.
    expect(a.blocks.map((b) => b.type)).toEqual(["error"]);
    expect(a.lastRetryableError).toEqual({ blockId: a.blocks[0].id });
  });

  it("keeps the agent/workflow/ralph result shape on replay", () => {
    const a = createDisplayBlockAssembler();
    a.loadEntries([
      {
        type: "message", timestamp: "2026-01-01T00:00:00.000Z",
        message: makeMessage({
          role: "assistant",
          content: [toolCallBlock("sub-1", "agent", { task: "x" })],
          timestamp: 100,
        }),
      },
      {
        type: "message", timestamp: "2026-01-01T00:00:01.000Z",
        message: makeMessage({
          role: "toolResult",
          toolCallId: "sub-1",
          toolName: "agent",
          content: [{ type: "text", text: "done" }],
          details: { status: "completed" },
          isError: false,
          timestamp: 200,
        }),
      },
    ]);
    const ws = a.blocks.find((b) => b.type === "work-status");
    expect(ws?.type).toBe("work-status");
    if (ws && ws.type === "work-status") {
      expect(ws.tools[0].result).toEqual({ content: [{ type: "text", text: "done" }], details: { status: "completed" } });
    }
  });
});

// ============================================================================
// Optimistic user messages
// ============================================================================

describe("optimistic user messages", () => {
  it("appends an optimistic block and merges the real message by fingerprint", () => {
    const a = createDisplayBlockAssembler();
    const blockId = a.appendOptimisticUserMessage("hello world", []);
    expect(blockId).not.toBeNull();
    expect(a.blocks.map((b) => b.type)).toEqual(["user-message"]);
    const optimistic = a.blocks[0];
    expect(optimistic.id).toBe(blockId);

    a.applyEvent(msgStart(makeMessage({ role: "user", content: "hello world", timestamp: 500 })));
    const merged = a.blocks.find((b) => b.id === blockId);
    expect(merged).toBeDefined();
    if (merged && merged.type === "user-message") {
      // Real message replaces the optimistic timestamp and keeps a single block.
      expect(merged.timestamp).toBe(500);
    }
    expect(a.blocks.filter((b) => b.type === "user-message")).toHaveLength(1);
  });

  it("removes the optimistic block (and its separator) and appends an error block on failure", () => {
    const a = createDisplayBlockAssembler();
    const blockId = a.appendOptimisticUserMessage("do it");
    expect(blockId).not.toBeNull();
    a.failOptimisticUserMessage(blockId, "发送失败: 网络错误");
    expect(a.blocks.map((b) => b.type)).toEqual(["error"]);
    expect(a.blocks[0]).toMatchObject({ type: "error", message: "发送失败: 网络错误", source: "发送" });
  });

  it("returns null for an empty message with no files", () => {
    const a = createDisplayBlockAssembler();
    expect(a.appendOptimisticUserMessage("   ")).toBeNull();
    expect(a.blocks).toHaveLength(0);
  });
});

// ============================================================================
// Seam dedup rules
// ============================================================================

describe("seam dedup", () => {
  it("rule 1: drops a tool_execution_start whose toolCallId already exists in a work-status block", () => {
    const a = createDisplayBlockAssembler();
    // Disk replay folded a tool already completed.
    a.loadEntries([
      {
        type: "message", timestamp: "2026-01-01T00:00:00.000Z",
        message: makeMessage({
          role: "assistant",
          content: [toolCallBlock("t1", "bash", {})],
          timestamp: 100,
        }),
      },
      {
        type: "message", timestamp: "2026-01-01T00:00:01.000Z",
        message: makeMessage({ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 200 }),
      },
    ]);
    const wsBefore = a.blocks.filter((b) => b.type === "work-status");
    expect(wsBefore).toHaveLength(1);

    // The live re-replay of the same start is dropped — no duplicate tool row.
    a.applyEvent(toolStart("t1"));
    const wsAfter = a.blocks.filter((b) => b.type === "work-status");
    expect(wsAfter).toHaveLength(1);
    if (wsAfter[0].type === "work-status") {
      expect(wsAfter[0].tools.filter((t) => t.toolCallId === "t1")).toHaveLength(1);
    }
  });

  it("rule 1: also dedupes two identical live tool_execution_start events", () => {
    const a = createDisplayBlockAssembler();
    a.applyEvents([toolStart("t2"), toolStart("t2"), toolEnd("t2", "bash", "ok")]);
    const ws = a.blocks.find((b) => b.type === "work-status");
    expect(ws?.type).toBe("work-status");
    if (ws && ws.type === "work-status") {
      expect(ws.tools).toHaveLength(1);
      expect(ws.tools[0].toolCallId).toBe("t2");
    }
  });

  it("rule 2: drops live message events whose triple key was folded from disk", () => {
    const a = createDisplayBlockAssembler();
    a.loadEntries([
      { type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: makeMessage({ role: "user", content: "from disk", timestamp: 100 }) },
      {
        type: "message", timestamp: "2026-01-01T00:00:01.000Z",
        message: makeMessage({ role: "assistant", content: "answer from disk", timestamp: 200 }),
      },
    ]);
    const before = JSON.parse(JSON.stringify(a.blocks));

    const sameUser = makeMessage({ role: "user", content: "from disk", timestamp: 100 });
    const sameAssistant = makeMessage({ role: "assistant", content: "answer from disk", timestamp: 200 });
    // start / update / end for both messages all carry the disk triple key.
    a.applyEvents([
      msgStart(sameUser),
      msgUpdate(sameUser),
      msgEnd(sameUser),
      msgStart(sameAssistant),
      msgUpdate(sameAssistant),
      msgEnd(sameAssistant),
    ]);
    expect(JSON.parse(JSON.stringify(a.blocks))).toEqual(before);
  });

  it("rule 2: a live message_end records the key so a redelivered end is dropped", () => {
    const a = createDisplayBlockAssembler();
    const userMsg = makeMessage({ role: "user", content: "hi", timestamp: 42 });
    a.applyEvents([msgStart(userMsg), msgEnd(userMsg)]);
    const before = JSON.parse(JSON.stringify(a.blocks));
    // A redelivered end (e.g. watch rewind) folds nothing and adds no key state change.
    a.applyEvent(msgEnd(userMsg));
    expect(JSON.parse(JSON.stringify(a.blocks))).toEqual(before);
  });

  it("rule 2: a duplicating live custom message matching a loaded custom_message entry is dropped", () => {
    const a = createDisplayBlockAssembler();
    a.loadEntries([
      { type: "custom_message", timestamp: "2026-01-01T00:00:00.000Z", customType: "pix-task-resume", content: "resume note", display: true, details: {} },
    ]);
    const before = JSON.parse(JSON.stringify(a.blocks));
    const sameTs = new Date("2026-01-01T00:00:00.000Z").getTime();
    a.applyEvent(msgStart(makeMessage({ role: "custom", customType: "pix-task-resume", content: "resume note", display: true, timestamp: sameTs })));
    a.applyEvent(msgEnd(makeMessage({ role: "custom", customType: "pix-task-resume", content: "resume note", display: true, timestamp: sameTs })));
    expect(JSON.parse(JSON.stringify(a.blocks))).toEqual(before);
  });

  it("rule 2: a live message with a different timestamp folds normally after a load", () => {
    const a = createDisplayBlockAssembler();
    a.loadEntries([
      { type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: makeMessage({ role: "user", content: "old", timestamp: 100 }) },
    ]);
    const countBefore = a.blocks.length;
    a.applyEvent(msgStart(makeMessage({ role: "user", content: "new message", timestamp: 999 })));
    a.applyEvent(msgEnd(makeMessage({ role: "user", content: "new message", timestamp: 999 })));
    expect(a.blocks.length).toBeGreaterThan(countBefore);
    expect(a.blocks.some((b) => b.type === "user-message" && b.timestamp === 999)).toBe(true);
  });

  it("injected blocks array is mutated in place and exposed as readonly blocks", () => {
    const blocks: DisplayBlock[] = [];
    const a = createDisplayBlockAssembler({ blocks });
    a.applyEvents([msgStart(makeMessage({ role: "user", content: "hi", timestamp: 1 }))]);
    // user-message + thinking (thinking follows a live user message)
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("user-message");
    expect(a.blocks).toBe(blocks);
  });
});
