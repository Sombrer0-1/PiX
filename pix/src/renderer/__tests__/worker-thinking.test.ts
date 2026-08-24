/**
 * worker-thinking tests (PiX 1.5, stage S4C, SDD §4.1.5).
 *
 * Acceptance: incremental application (the second call only processes the
 * newly appended events, without rebuilding), identity-cursor rebuild and full
 * replay (a changed events[0] reference — array reset, sliding-window head
 * truncation, same-name team rebuild — drops the cached assembler and folds
 * the current window from scratch), per-agent isolation (different agentIds
 * never touch each other's stream), and thinking-block production/order
 * (timeline order, supersede states). The collector injects a Vue reactive
 * blocks array into the framework-free assembler — no component mounting.
 */

import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentSessionEvent } from "@shared/types.js";
import type { DisplayBlock } from "@/types/session";
import type { TaggedSessionEvent } from "../stores/team-store";
import { collectWorkerThinkingBlocks, type ThinkingBlockData } from "../utils/worker-thinking";

function makeMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return { role: "assistant", content: [], timestamp: 1000, ...overrides };
}

/** message_update carrying an assistantMessageEvent (pi-ai stream event). */
function updateWithAme(message: AgentMessage, ame: unknown): AgentSessionEvent {
  return { type: "message_update", message, assistantMessageEvent: ame };
}

function textContent(text: string): Array<{ type: string; text: string }> {
  return [{ type: "text", text }];
}

/** Wrap one raw event into the team-store tagged shape (object reference = identity). */
function tag(agentId: string, event: AgentSessionEvent): TaggedSessionEvent {
  return { agentId, event, timestamp: Date.now() };
}

function tagAll(agentId: string, events: AgentSessionEvent[]): TaggedSessionEvent[] {
  return events.map((event) => tag(agentId, event));
}

/** One settled thinking turn: start + deltas + end, then the first text supersedes. */
function thinkingTurn(deltas: string[], timestamp: number, text = "正文"): AgentSessionEvent[] {
  const message = makeMessage({ content: textContent(text), timestamp });
  return [
    updateWithAme(message, { type: "thinking_start", contentIndex: 0 }),
    ...deltas.map((delta) => updateWithAme(message, { type: "thinking_delta", contentIndex: 0, delta })),
    updateWithAme(message, { type: "thinking_end", contentIndex: 0, content: deltas.join("") }),
    updateWithAme(message, { type: "text_start", contentIndex: 0 }),
  ];
}

// ============================================================================
// Incremental application
// ============================================================================

describe("incremental application", () => {
  it("applies only the newly appended events on the second call (增量应用)", () => {
    const agentId = "inc-agent";
    const first = tagAll(agentId, [
      updateWithAme(makeMessage({ timestamp: 1000 }), { type: "thinking_start", contentIndex: 0 }),
      updateWithAme(makeMessage({ timestamp: 1000 }), { type: "thinking_delta", contentIndex: 0, delta: "先 " }),
      updateWithAme(makeMessage({ timestamp: 1000 }), { type: "thinking_delta", contentIndex: 0, delta: "思考" }),
    ]);

    const blocks1 = collectWorkerThinkingBlocks(agentId, first);
    expect(blocks1).toHaveLength(1);
    expect(blocks1[0].content).toBe("先 思考");
    expect(blocks1[0].phase).toBe("streaming");
    expect(blocks1[0].superseded).toBe(false);

    // The same array plus one appended delta (same tag object references, so
    // events[0] identity is unchanged). Re-applying the earlier events would
    // duplicate the content; the block object must also survive the call
    // unchanged (no rebuild).
    const second = [
      ...first,
      tag(agentId, updateWithAme(makeMessage({ timestamp: 1000 }), { type: "thinking_delta", contentIndex: 0, delta: "中" })),
    ];
    const blocks2 = collectWorkerThinkingBlocks(agentId, second);
    expect(blocks2).toHaveLength(1);
    expect(blocks2[0]).toBe(blocks1[0]);
    expect(blocks2[0].content).toBe("先 思考中");
  });
});

// ============================================================================
// Rebuild and full replay (identity cursor)
// ============================================================================

describe("rebuild on identity change", () => {
  it("drops the cached assembler and replays from scratch when the array shrinks (数组重置后重建全量重放)", () => {
    const agentId = "reset-agent";

    // First call folds a full settled turn (4 events applied).
    const blocks1 = collectWorkerThinkingBlocks(agentId, tagAll(agentId, thinkingTurn(["旧思考"], 1000)));
    expect(blocks1).toHaveLength(1);
    expect(blocks1[0].content).toBe("旧思考");
    expect(blocks1[0].superseded).toBe(true);

    // A team rebuild resets the store array to a shorter, different prefix
    // (new tag objects — events[0] reference changes).
    const fresh = tagAll(agentId, [
      updateWithAme(makeMessage({ timestamp: 2000 }), { type: "thinking_start", contentIndex: 0 }),
      updateWithAme(makeMessage({ timestamp: 2000 }), { type: "thinking_delta", contentIndex: 0, delta: "新" }),
    ]);
    const blocks2 = collectWorkerThinkingBlocks(agentId, fresh);
    expect(blocks2).toHaveLength(1);
    expect(blocks2[0].content).toBe("新");
    expect(blocks2[0].phase).toBe("streaming");
    expect(blocks2[0].superseded).toBe(false);
  });

  it("rebuilds after a same-name team reset even when the refilled buffer is not shorter (同名团队重建后旧块不串台)", () => {
    const agentId = "coder::TeamT";

    const oldTurn = tagAll(agentId, thinkingTurn(["旧团队思考"], 1000));
    const blocks1 = collectWorkerThinkingBlocks(agentId, oldTurn);
    expect(blocks1).toHaveLength(1);
    expect(blocks1[0].content).toBe("旧团队思考");

    // resetTeamCollections clears the buffer, then the rebuilt team refills it
    // to the same length (>= the old applied count). The new tag objects make
    // events[0] identity change — the old assembler must be dropped, never
    // incrementally polluted with the new team's deltas.
    const newTurn = tagAll(agentId, thinkingTurn(["新团队思考"], 2000));
    const blocks2 = collectWorkerThinkingBlocks(agentId, newTurn);
    expect(blocks2).toHaveLength(1);
    expect(blocks2[0]).not.toBe(blocks1[0]);
    expect(blocks2[0].content).toBe("新团队思考");
    expect(blocks2[0].superseded).toBe(true);
  });

  it("rebuilds on sliding-window head truncation and keeps incremental application alive (滑动截断后重建并继续增量)", () => {
    const agentId = "slide-agent";
    const ev = (ame: unknown) => updateWithAme(makeMessage({ timestamp: 1000 }), ame);
    const full = tagAll(agentId, [
      ev({ type: "thinking_start", contentIndex: 0 }),
      ev({ type: "thinking_delta", contentIndex: 0, delta: "旧" }),
      ev({ type: "thinking_delta", contentIndex: 0, delta: "思考" }),
    ]);

    const blocks1 = collectWorkerThinkingBlocks(agentId, full);
    expect(blocks1).toHaveLength(1);
    expect(blocks1[0].content).toBe("旧思考");
    expect(blocks1[0].phase).toBe("streaming");

    // team-store caps the buffer at MAX_EVENTS_PER_WORKER with a head splice:
    // the length stops growing but events[0] is a new object. An index cursor
    // would saturate (length == applied forever, incremental application
    // stops); the identity cursor must rebuild and replay only the current
    // window — the truncated-away delta must not resurface.
    const window = full.slice(2);
    const blocks2 = collectWorkerThinkingBlocks(agentId, window);
    expect(blocks2).toHaveLength(1);
    expect(blocks2[0]).not.toBe(blocks1[0]);
    expect(blocks2[0].content).toBe("思考");
    expect(blocks2[0].phase).toBe("streaming");

    // Incremental application resumes after the rebuild: the next delta lands.
    const next = [...window, tag(agentId, ev({ type: "thinking_delta", contentIndex: 0, delta: "！" }))];
    const blocks3 = collectWorkerThinkingBlocks(agentId, next);
    expect(blocks3).toHaveLength(1);
    expect(blocks3[0]).toBe(blocks2[0]);
    expect(blocks3[0].content).toBe("思考！");
  });
});

// ============================================================================
// Per-agent isolation
// ============================================================================

describe("per-agent isolation", () => {
  it("keeps each agentId's stream independent (多 agent 隔离)", () => {
    const eventsA = tagAll("iso-a", thinkingTurn(["A 的思考"], 1000));
    const eventsB = tagAll("iso-b", thinkingTurn(["B 的思考"], 2000));

    const blocksA = collectWorkerThinkingBlocks("iso-a", eventsA);
    expect(blocksA).toHaveLength(1);
    expect(blocksA[0].content).toBe("A 的思考");

    // Folding B's stream must not disturb A's cached assembler.
    const blocksB = collectWorkerThinkingBlocks("iso-b", eventsB);
    expect(blocksB).toHaveLength(1);
    expect(blocksB[0].content).toBe("B 的思考");

    const blocksA2 = collectWorkerThinkingBlocks("iso-a", eventsA);
    expect(blocksA2).toHaveLength(1);
    expect(blocksA2[0]).toBe(blocksA[0]);
    expect(blocksA2[0].content).toBe("A 的思考");
  });
});

// ============================================================================
// Thinking block production and order
// ============================================================================

describe("thinking block production", () => {
  it("returns multiple segments in timeline order with supersede states (thinking 块产出与顺序)", () => {
    const events = tagAll("order-agent", [
      ...thinkingTurn(["第一段"], 1000, "第一段正文"),
      ...thinkingTurn(["第二段"], 2000, "第二段正文"),
    ]);

    const blocks = collectWorkerThinkingBlocks("order-agent", events);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b: ThinkingBlockData) => b.content)).toEqual(["第一段", "第二段"]);
    // Both turns settled: the first text of each turn superseded its block.
    expect(blocks.every((b) => b.phase === "ended" && b.superseded)).toBe(true);
    // Timeline order: first segment's timestamp is earlier.
    expect(blocks[0].timestamp).toBeLessThan(blocks[1].timestamp);
  });

  it("yields no blocks when the stream carries no thinking (无思考流)", () => {
    const blocks = collectWorkerThinkingBlocks("plain-agent", tagAll("plain-agent", [
      updateWithAme(makeMessage({ content: textContent("只有正文"), timestamp: 1000 }), { type: "text_start", contentIndex: 0 }),
    ]));
    expect(blocks).toHaveLength(0);
  });
});
