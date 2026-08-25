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
import { INTERNAL_CUSTOM_MESSAGE_TYPES, formatInternalNotification } from "@shared/internal-notification";
// Imported from the coding-agent source (its only top-level imports are
// type-only) rather than the package name: the dist barrel may be stale, and
// the drift check must compare live sources on both sides.
import { LEGACY_INTERNAL_CUSTOM_TYPES } from "../../../../packages/coding-agent/src/core/messages.ts";
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

  it("keeps legacy teammate notifications out of the main chat", () => {
    const a = createDisplayBlockAssembler({ teamLeader: true });
    const note = '<teammate-message from="coder" role="tester">\nchecked the tests\n</teammate-message>';
    a.applyEvent(msgStart(makeMessage({ role: "user", content: note, timestamp: 5 })));
    a.applyEvent(msgEnd(makeMessage({ role: "user", content: note, timestamp: 5 })));

    expect(a.blocks).toEqual([]);
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
  it("hides internal custom messages in both live and replay paths", () => {
    const a = createDisplayBlockAssembler();
    const message = makeMessage({
      role: "custom",
      customType: "pix-agent-task-result",
      content: '<task-notification status="completed"><result>done</result></task-notification>',
      display: false,
      context: "internal",
      timestamp: 42,
    });

    a.applyEvents([msgStart(message), msgEnd(message)]);
    expect(a.blocks).toEqual([]);

    a.loadEntries([
      {
        type: "custom_message",
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: "pix-agent-task-result",
        content: "done",
        display: false,
        context: "internal",
        details: { taskId: "task-1" },
      },
    ]);
    expect(a.blocks).toEqual([]);
  });

  it("hides legacy internal notification text stored as a user message", () => {
    const a = createDisplayBlockAssembler();
    a.loadEntries([
      {
        type: "message",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: makeMessage({
          role: "user",
          content: '<task-notification task-id="task-1"><result>done</result></task-notification>',
        }),
      },
    ]);

    expect(a.blocks).toEqual([]);
  });

  it("still renders a user message that merely mentions a reserved prefix", () => {
    const a = createDisplayBlockAssembler();
    const text = "See this format: <task-notification>please review this</task-notification> — what does it mean?";
    a.applyEvents([
      msgStart(makeMessage({ role: "user", content: text, timestamp: 9 })),
      msgEnd(makeMessage({ role: "user", content: text, timestamp: 9 })),
    ]);
    expect(a.blocks.map((b) => b.type)).toContain("user-message");
    const user = a.blocks.find((b) => b.type === "user-message");
    if (user && user.type === "user-message") {
      expect(user.text).toContain("please review this");
    }
  });

  it("hides legacy notification roots stored under a generic custom type", () => {
    const a = createDisplayBlockAssembler();
    a.loadEntries([
      {
        type: "custom_message",
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: "legacy-extension-type",
        content: '<team-notification source="team"><result>worker report</result></team-notification>',
        display: true,
      },
    ]);

    expect(a.blocks).toEqual([]);
  });

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

describe("internal notification protocol", () => {
  it("escapes fields and preserves a closed envelope under truncation", () => {
    const notification = formatInternalNotification(
      {
        notificationId: 'notice"><1',
        source: "agent-task",
        kind: "task-result",
        taskId: "task<&",
        groupId: "group-1",
        agentName: "coder",
        status: "completed",
        requiresAction: false,
        result: "结果 ".repeat(20_000),
        items: [
          {
            id: "item-1",
            index: 0,
            agentName: "coder",
            status: "completed",
            result: "done & checked",
          },
        ],
      },
      1_024,
    );

    expect(notification.startsWith("<task-notification ")).toBe(true);
    expect(notification).toContain('notification-id="notice&quot;&gt;&lt;1"');
    expect(notification).toContain('result-truncated="true"');
    expect(notification).toContain("</task-notification>");
    expect(notification).not.toContain("notice\"><1");
  });

  it("keeps result-truncated true after the compaction pass reduces long result bodies", () => {
    // A single long result plus one long item exceeds the first-pass budget
    // (result 4 KiB + item 4 KiB > maxBytes), forcing the second (compaction)
    // render pass: both the top-level result and the long item result must
    // still report truncated instead of recomputing from the shortened text.
    const notification = formatInternalNotification(
      {
        notificationId: "compact-check",
        source: "agent-task",
        kind: "task-result",
        taskId: "task-1",
        groupId: "group-1",
        status: "completed",
        requiresAction: false,
        result: "A".repeat(50_000),
        items: [
          { id: "item-1", index: 0, agentName: "coder", status: "completed", result: "B".repeat(50_000) },
        ],
      },
      4_096,
    );

    expect(notification.startsWith("<task-notification ")).toBe(true);
    expect(notification).toContain("<items>");
    expect(notification.match(/result-truncated="true"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(notification).not.toContain('result-truncated="false"');
    expect(notification).toContain("</task-notification>");
  });

  it("keeps result-truncated true when a 1024-byte budget forces compact of a 100k result", () => {
    const notification = formatInternalNotification(
      {
        notificationId: "t",
        source: "agent-task",
        kind: "k",
        result: "A".repeat(100_000),
      },
      1_024,
    );
    expect(notification).toContain('result-truncated="true"');
    expect(notification).not.toContain('result-truncated="false"');
  });

  it("keeps the pix protocol customTypes identical to the coding-agent legacy set", () => {
    // Sorted-array equality is bidirectional: a rename, removal, or addition on
    // either side fails here, so restored sessions keep being wrapped.
    expect([...LEGACY_INTERNAL_CUSTOM_TYPES].sort()).toEqual(
      Object.values(INTERNAL_CUSTOM_MESSAGE_TYPES).sort(),
    );
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

  it("merges a clipboard-image optimistic message with the real prompt", () => {
    const a = createDisplayBlockAssembler();
    const blockId = a.appendOptimisticUserMessage("see this", [], [{ mimeType: "image/png" }]);
    expect(blockId).not.toBeNull();
    const optimistic = a.blocks[0];
    expect(optimistic.type).toBe("user-message");
    if (optimistic.type === "user-message") {
      expect(optimistic.attachments).toEqual([
        { path: "clipboard-image-1", name: "clipboard-image-1.png", kind: "image" },
      ]);
    }

    a.applyEvent(msgStart(makeMessage({
      role: "user",
      content: "see this",
      timestamp: 900,
      attachments: [{ path: "clipboard-image-1", name: "clipboard-image-1.png", kind: "image" }],
    })));
    expect(a.blocks.filter((b) => b.type === "user-message")).toHaveLength(1);
    const merged = a.blocks.find((b) => b.id === blockId);
    expect(merged).toBeDefined();
    if (merged && merged.type === "user-message") {
      expect(merged.timestamp).toBe(900);
      expect(merged.attachments).toHaveLength(1);
    }
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

// ============================================================================
// Thinking blocks (PiX 1.5, S2A — SDD §4.1.2)
// ============================================================================

describe("thinking blocks (PiX 1.5)", () => {
  type ThinkingBlock = Extract<DisplayBlock, { type: "thinking" }>;

  function isThinking(block: DisplayBlock): block is ThinkingBlock {
    return block.type === "thinking";
  }

  /** Thinking content block as it appears inside an assistant message. */
  function thinkingBlock(text: string): { type: string; text?: string } {
    return { type: "thinking", thinking: text } as { type: string; text?: string };
  }

  /** message_update carrying an assistantMessageEvent (pi-ai stream event). */
  function updateWithAme(message: AgentMessage, ame: unknown): AgentSessionEvent {
    return { type: "message_update", message, assistantMessageEvent: ame };
  }

  /** Pure thinking-stream updates: the partial message carries no text block. */
  function thinkingUpdates(...ame: unknown[]): AgentSessionEvent[] {
    return ame.map((e) => updateWithAme(makeMessage({ role: "assistant", content: [], timestamp: 2 }), e));
  }

  it("reuses the placeholder block for thinking_start and appends deltas in order (占位转正)", () => {
    const a = createDisplayBlockAssembler();
    a.applyEvent(msgStart(makeMessage({ role: "user", content: "hi", timestamp: 1 })));
    const placeholder = a.blocks.find(isThinking);
    expect(placeholder?.type).toBe("thinking");

    a.applyEvents(thinkingUpdates(
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 0, delta: "先 " },
      { type: "thinking_delta", contentIndex: 0, delta: "思考" },
    ));

    const thinking = a.blocks.filter(isThinking);
    // The placeholder is promoted in place — still exactly one block, same id.
    expect(thinking).toHaveLength(1);
    expect(thinking[0].id).toBe(placeholder?.id);
    expect(thinking[0].content).toBe("先 思考");
    expect(thinking[0].phase).toBe("streaming");
    expect(thinking[0].superseded).toBe(false);
  });

  it("creates a block on the first thinking_delta when no placeholder is open (delta 追加)", () => {
    const a = createDisplayBlockAssembler();
    a.applyEvent(updateWithAme(
      makeMessage({ role: "assistant", content: [], timestamp: 2 }),
      { type: "thinking_delta", contentIndex: 0, delta: "无占位" },
    ));

    const thinking = a.blocks.filter(isThinking);
    expect(thinking).toHaveLength(1);
    expect(thinking[0].content).toBe("无占位");
    expect(thinking[0].phase).toBe("streaming");
    expect(thinking[0].superseded).toBe(false);
  });

  it("marks the block ended on thinking_end and supersedes it on the first text (thinking_end 后 supersede)", () => {
    const a = createDisplayBlockAssembler();
    a.applyEvent(msgStart(makeMessage({ role: "user", content: "hi", timestamp: 1 })));
    a.applyEvents(thinkingUpdates(
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 0, delta: "思考中" },
      { type: "thinking_end", contentIndex: 0, content: "思考中" },
    ));

    const ended = a.blocks.filter(isThinking);
    expect(ended).toHaveLength(1);
    expect(ended[0].phase).toBe("ended");
    // Not superseded yet — the next move decides.
    expect(ended[0].superseded).toBe(false);

    // First text move supersedes: the block stays in the timeline, collapsed.
    a.applyEvent(updateWithAme(
      makeMessage({ role: "assistant", content: textBlocks("回答"), timestamp: 2 }),
      { type: "text_start", contentIndex: 1 },
    ));

    const after = a.blocks.filter(isThinking);
    expect(after).toHaveLength(1);
    expect(after[0].phase).toBe("ended");
    expect(after[0].superseded).toBe(true);
    expect(after[0].content).toBe("思考中");
    expect(a.blocks.some((b) => b.type === "agent-message" && b.content === "回答")).toBe(true);
  });

  it("removes the empty placeholder when the first text arrives (空占位移除)", () => {
    const a = createDisplayBlockAssembler();
    a.applyEvent(msgStart(makeMessage({ role: "user", content: "hi", timestamp: 1 })));
    expect(a.blocks.filter(isThinking)).toHaveLength(1);

    a.applyEvent(updateWithAme(
      makeMessage({ role: "assistant", content: "direct answer", timestamp: 2 }),
      { type: "text_start", contentIndex: 0 },
    ));

    expect(a.blocks.filter(isThinking)).toHaveLength(0);
    expect(a.blocks.map((b) => b.type)).toEqual(["user-message", "agent-message"]);
  });

  it("folds multi-segment thinking into separate blocks (多段思考两块)", () => {
    const a = createDisplayBlockAssembler();
    a.applyEvent(msgStart(makeMessage({ role: "user", content: "hi", timestamp: 1 })));
    a.applyEvents(thinkingUpdates(
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 0, delta: "第一段" },
      { type: "thinking_end", contentIndex: 0, content: "第一段" },
    ));
    // Text between the segments supersedes the first block.
    a.applyEvent(updateWithAme(
      makeMessage({ role: "assistant", content: textBlocks("正文"), timestamp: 2 }),
      { type: "text_start", contentIndex: 1 },
    ));
    // Second segment opens a fresh block.
    a.applyEvents(thinkingUpdates(
      { type: "thinking_start", contentIndex: 2 },
      { type: "thinking_delta", contentIndex: 2, delta: "第二段" },
    ));

    const thinking = a.blocks.filter(isThinking);
    expect(thinking).toHaveLength(2);
    expect(thinking[0].content).toBe("第一段");
    expect(thinking[0].superseded).toBe(true);
    expect(thinking[1].content).toBe("第二段");
    expect(thinking[1].superseded).toBe(false);
    expect(thinking[1].phase).toBe("streaming");
  });

  it("backfills content from thinking_end when no deltas arrived (redacted 回填)", () => {
    const a = createDisplayBlockAssembler();
    a.applyEvent(msgStart(makeMessage({ role: "user", content: "hi", timestamp: 1 })));
    a.applyEvents(thinkingUpdates(
      { type: "thinking_start", contentIndex: 0 },
      // No thinking_delta — the safety filter redacted the segment (Anthropic
      // redacted_thinking): the final value only arrives on thinking_end.
      { type: "thinking_end", contentIndex: 0, content: "[Reasoning redacted]" },
    ));

    const thinking = a.blocks.filter(isThinking);
    expect(thinking).toHaveLength(1);
    expect(thinking[0].content).toBe("[Reasoning redacted]");
    expect(thinking[0].phase).toBe("ended");
    expect(thinking[0].superseded).toBe(false);

    // First text supersedes: the backfilled block stays in the timeline, collapsed.
    a.applyEvent(updateWithAme(
      makeMessage({ role: "assistant", content: textBlocks("回答"), timestamp: 2 }),
      { type: "text_start", contentIndex: 1 },
    ));
    const after = a.blocks.filter(isThinking);
    expect(after).toHaveLength(1);
    expect(after[0].superseded).toBe(true);
    expect(after[0].content).toBe("[Reasoning redacted]");
  });

  it("folds adjacent thinking segments into separate blocks (相邻思考段两块)", () => {
    const a = createDisplayBlockAssembler();
    a.applyEvent(msgStart(makeMessage({ role: "user", content: "hi", timestamp: 1 })));
    a.applyEvents(thinkingUpdates(
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 0, delta: "A" },
      { type: "thinking_end", contentIndex: 0, content: "A" },
      // No text/tool event between the segments — the second thinking_start
      // must supersede the ended block first, then open a fresh one.
      { type: "thinking_start", contentIndex: 1 },
      { type: "thinking_delta", contentIndex: 1, delta: "B" },
      { type: "thinking_end", contentIndex: 1, content: "B" },
    ));

    const thinking = a.blocks.filter(isThinking);
    expect(thinking).toHaveLength(2);
    expect(thinking[0].content).toBe("A");
    expect(thinking[0].phase).toBe("ended");
    expect(thinking[0].superseded).toBe(true);
    expect(thinking[1].content).toBe("B");
    expect(thinking[1].phase).toBe("ended");
    expect(thinking[1].superseded).toBe(false);

    // First text supersedes the second block too.
    a.applyEvent(updateWithAme(
      makeMessage({ role: "assistant", content: textBlocks("回答"), timestamp: 2 }),
      { type: "text_start", contentIndex: 2 },
    ));
    const after = a.blocks.filter(isThinking);
    expect(after).toHaveLength(2);
    expect(after.map((b) => b.content)).toEqual(["A", "B"]);
    expect(after[1].superseded).toBe(true);
  });

  it("supersedes via toolcall_start even when the update carries no text (无正文纯工具回合)", () => {
    const a = createDisplayBlockAssembler();
    a.applyEvent(msgStart(makeMessage({ role: "user", content: "run tool", timestamp: 1 })));
    a.applyEvents(thinkingUpdates(
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 0, delta: "工具前思考" },
      { type: "thinking_end", contentIndex: 0, content: "工具前思考" },
    ));

    // Pure tool turn: the partial message has only a toolCall block, no text.
    // The dispatch must run before the text-early-return for the supersede to fire.
    a.applyEvent(updateWithAme(
      makeMessage({ role: "assistant", content: [toolCallBlock("t1", "bash", { command: "ls" })], timestamp: 2 }),
      { type: "toolcall_start", contentIndex: 1 },
    ));
    a.applyEvent(toolStart("t1"));
    a.applyEvent(toolEnd("t1", "bash", "ok"));

    const thinking = a.blocks.filter(isThinking);
    expect(thinking).toHaveLength(1);
    expect(thinking[0].content).toBe("工具前思考");
    expect(thinking[0].phase).toBe("ended");
    expect(thinking[0].superseded).toBe(true);
  });

  it("removes the empty placeholder via toolcall_start in a pure tool turn", () => {
    const a = createDisplayBlockAssembler();
    a.applyEvent(msgStart(makeMessage({ role: "user", content: "run tool", timestamp: 1 })));
    expect(a.blocks.filter(isThinking)).toHaveLength(1);

    a.applyEvent(updateWithAme(
      makeMessage({ role: "assistant", content: [toolCallBlock("t1", "bash", { command: "ls" })], timestamp: 2 }),
      { type: "toolcall_start", contentIndex: 0 },
    ));

    expect(a.blocks.filter(isThinking)).toHaveLength(0);
  });

  it("folds replay thinking content as ended superseded blocks in content order (回放折叠)", () => {
    const a = createDisplayBlockAssembler();
    a.loadEntries([
      {
        type: "message", timestamp: "2026-01-01T00:00:00.000Z",
        message: makeMessage({
          role: "assistant",
          content: [
            thinkingBlock("第一段思考"),
            ...textBlocks("回答"),
            thinkingBlock("第二段思考"),
          ],
          timestamp: 200,
        }),
      },
    ]);

    // Content order preserved: thinking, text, thinking.
    expect(a.blocks.map((b) => b.type)).toEqual(["thinking", "agent-message", "thinking"]);
    const thinking = a.blocks.filter(isThinking);
    expect(thinking[0].content).toBe("第一段思考");
    expect(thinking[0].phase).toBe("ended");
    expect(thinking[0].superseded).toBe(true);
    expect(thinking[0].timestamp).toBe(200); // same source as the text fold
    expect(thinking[1].content).toBe("第二段思考");
    expect(thinking[1].superseded).toBe(true);
  });

  it("skips empty thinking blocks on replay — no blank placeholder blocks", () => {
    const a = createDisplayBlockAssembler();
    a.loadEntries([
      {
        type: "message", timestamp: "2026-01-01T00:00:00.000Z",
        message: makeMessage({
          role: "assistant",
          content: [thinkingBlock(""), ...textBlocks("answer")],
          timestamp: 200,
        }),
      },
    ]);

    expect(a.blocks.map((b) => b.type)).toEqual(["agent-message"]);
  });

  it("holds the §4.1.2 invariants across a full mixed turn", () => {
    const a = createDisplayBlockAssembler();
    const openCount = () => a.blocks.filter((b) => b.type === "thinking" && !b.superseded).length;

    a.applyEvent({ type: "agent_start" });
    a.applyEvent(msgStart(makeMessage({ role: "user", content: "hi", timestamp: 1 })));
    a.applyEvent(msgEnd(makeMessage({ role: "user", content: "hi", timestamp: 1 })));
    expect(openCount()).toBe(1); // the placeholder

    a.applyEvents(thinkingUpdates(
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 0, delta: "一段" },
      { type: "thinking_end", contentIndex: 0, content: "一段" },
    ));
    expect(openCount()).toBe(1);

    // First text supersedes the open block.
    a.applyEvent(updateWithAme(
      makeMessage({ role: "assistant", content: textBlocks("回答一"), timestamp: 2 }),
      { type: "text_start", contentIndex: 1 },
    ));
    a.applyEvent(updateWithAme(
      makeMessage({ role: "assistant", content: textBlocks("回答一"), timestamp: 2 }),
      { type: "text_delta", contentIndex: 1, delta: "" },
    ));
    expect(openCount()).toBe(0);

    // A later tool turn (no text) must not reopen anything.
    a.applyEvent(updateWithAme(
      makeMessage({ role: "assistant", content: [toolCallBlock("t1", "bash", {})], timestamp: 2 }),
      { type: "toolcall_start", contentIndex: 2 },
    ));
    a.applyEvent(toolStart("t1"));
    a.applyEvent(toolEnd("t1", "bash", "ok"));
    a.applyEvent({ type: "agent_end", messages: [] });
    expect(openCount()).toBe(0);

    const thinking = a.blocks.filter(isThinking);
    // Invariant 1: at most one non-superseded thinking block at any point.
    expect(openCount()).toBeLessThanOrEqual(1);
    // Invariant 2: superseded blocks always carry content.
    for (const block of thinking) {
      if (block.superseded) expect(block.content.length).toBeGreaterThan(0);
    }
    // Invariant 3: thinking never leaks into the text bubble — agent-message
    // content comes from text blocks only.
    const agent = a.blocks.find((b) => b.type === "agent-message");
    expect(agent?.type).toBe("agent-message");
    if (agent?.type === "agent-message") {
      expect(agent.content).toBe("回答一");
      expect(agent.content).not.toContain("一段");
    }
  });
});
