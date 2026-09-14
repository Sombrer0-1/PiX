/**
 * worker-thinking tests (PiX 1.5, stage S4C, SDD §4.1.5; roundtable S6).
 *
 * S6: the collector consumes the roundtable `TaggedSessionEvent` (keyed by
 * seatId — the roundtable seat identity — instead of the old agentId) and the
 * seat status/event buffers live in the team store. The acceptance below is
 * unchanged in substance: incremental application (the second call only
 * processes the newly appended events, without rebuilding), identity-cursor
 * rebuild and full replay (a changed events[0] reference — array reset,
 * sliding-window head truncation, same-slug roundtable rebuild — drops the
 * cached assembler and folds the current window from scratch), per-seat
 * isolation (different seatIds never touch each other's stream), and
 * thinking-block production/order (timeline order, supersede states). The
 * collector injects a Vue reactive blocks array into the framework-free
 * assembler — no component mounting.
 */

import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentSessionEvent } from "@shared/types.js";
import type { TaggedSessionEvent } from "../stores/team-store";
import { collectWorkerThinkingBlocks, MAX_CACHED_SEATS, type ThinkingBlockData } from "../utils/worker-thinking";

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
function tag(seatId: string, event: AgentSessionEvent): TaggedSessionEvent {
  return { seatId, event, timestamp: Date.now() };
}

function tagAll(seatId: string, events: AgentSessionEvent[]): TaggedSessionEvent[] {
  return events.map((event) => tag(seatId, event));
}

/** Roundtable seat id (the store keys buffers by `${slug}::${roundtableId}`). */
function seatId(slug: string): string {
  return `${slug}::rt-test`;
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
    const seat = seatId("sources");
    const first = tagAll(seat, [
      updateWithAme(makeMessage({ timestamp: 1000 }), { type: "thinking_start", contentIndex: 0 }),
      updateWithAme(makeMessage({ timestamp: 1000 }), { type: "thinking_delta", contentIndex: 0, delta: "先 " }),
      updateWithAme(makeMessage({ timestamp: 1000 }), { type: "thinking_delta", contentIndex: 0, delta: "思考" }),
    ]);

    const blocks1 = collectWorkerThinkingBlocks(seat, first);
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
      tag(seat, updateWithAme(makeMessage({ timestamp: 1000 }), { type: "thinking_delta", contentIndex: 0, delta: "中" })),
    ];
    const blocks2 = collectWorkerThinkingBlocks(seat, second);
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
    const seat = seatId("counterexample");

    // First call folds a full settled turn (4 events applied).
    const blocks1 = collectWorkerThinkingBlocks(seat, tagAll(seat, thinkingTurn(["旧思考"], 1000)));
    expect(blocks1).toHaveLength(1);
    expect(blocks1[0].content).toBe("旧思考");
    expect(blocks1[0].superseded).toBe(true);

    // A roundtable rebuild resets the store array to a shorter, different
    // prefix (new tag objects — events[0] reference changes).
    const fresh = tagAll(seat, [
      updateWithAme(makeMessage({ timestamp: 2000 }), { type: "thinking_start", contentIndex: 0 }),
      updateWithAme(makeMessage({ timestamp: 2000 }), { type: "thinking_delta", contentIndex: 0, delta: "新" }),
    ]);
    const blocks2 = collectWorkerThinkingBlocks(seat, fresh);
    expect(blocks2).toHaveLength(1);
    expect(blocks2[0].content).toBe("新");
    expect(blocks2[0].phase).toBe("streaming");
    expect(blocks2[0].superseded).toBe(false);
  });

  it("rebuilds after a same-slug roundtable reset even when the refilled buffer is not shorter (同名席位重建后旧块不串台)", () => {
    const seat = seatId("theory");

    const oldTurn = tagAll(seat, thinkingTurn(["上一场思考"], 1000));
    const blocks1 = collectWorkerThinkingBlocks(seat, oldTurn);
    expect(blocks1).toHaveLength(1);
    expect(blocks1[0].content).toBe("上一场思考");

    // resetRoundtableCollections clears the buffers, then the rebuilt
    // roundtable refills them to the same length (>= the old applied count).
    // The new tag objects make events[0] identity change — the old assembler
    // must be dropped, never incrementally polluted with the new run's deltas.
    const newTurn = tagAll(seat, thinkingTurn(["本场思考"], 2000));
    const blocks2 = collectWorkerThinkingBlocks(seat, newTurn);
    expect(blocks2).toHaveLength(1);
    expect(blocks2[0]).not.toBe(blocks1[0]);
    expect(blocks2[0].content).toBe("本场思考");
    expect(blocks2[0].superseded).toBe(true);
  });

  it("rebuilds on sliding-window head truncation and keeps incremental application alive (滑动截断后重建并继续增量)", () => {
    const seat = seatId("experiment");
    const ev = (ame: unknown) => updateWithAme(makeMessage({ timestamp: 1000 }), ame);
    const full = tagAll(seat, [
      ev({ type: "thinking_start", contentIndex: 0 }),
      ev({ type: "thinking_delta", contentIndex: 0, delta: "旧" }),
      ev({ type: "thinking_delta", contentIndex: 0, delta: "思考" }),
    ]);

    const blocks1 = collectWorkerThinkingBlocks(seat, full);
    expect(blocks1).toHaveLength(1);
    expect(blocks1[0].content).toBe("旧思考");
    expect(blocks1[0].phase).toBe("streaming");

    // team-store caps the buffer at MAX_SEAT_EVENTS with a head splice: the
    // length stops growing but events[0] is a new object. An index cursor
    // would saturate (length == applied forever, incremental application
    // stops); the identity cursor must rebuild and replay only the current
    // window — the truncated-away delta must not resurface.
    const window = full.slice(2);
    const blocks2 = collectWorkerThinkingBlocks(seat, window);
    expect(blocks2).toHaveLength(1);
    expect(blocks2[0]).not.toBe(blocks1[0]);
    expect(blocks2[0].content).toBe("思考");
    expect(blocks2[0].phase).toBe("streaming");

    // Incremental application resumes after the rebuild: the next delta lands.
    const next = [...window, tag(seat, ev({ type: "thinking_delta", contentIndex: 0, delta: "！" }))];
    const blocks3 = collectWorkerThinkingBlocks(seat, next);
    expect(blocks3).toHaveLength(1);
    expect(blocks3[0]).toBe(blocks2[0]);
    expect(blocks3[0].content).toBe("思考！");
  });
});

// ============================================================================
// Per-seat isolation
// ============================================================================

describe("per-seat isolation", () => {
  it("keeps each seatId's stream independent (多席位隔离)", () => {
    const seatA = seatId("sources");
    const seatB = seatId("feasibility");
    const eventsA = tagAll(seatA, thinkingTurn(["A 的思考"], 1000));
    const eventsB = tagAll(seatB, thinkingTurn(["B 的思考"], 2000));

    const blocksA = collectWorkerThinkingBlocks(seatA, eventsA);
    expect(blocksA).toHaveLength(1);
    expect(blocksA[0].content).toBe("A 的思考");

    // Folding B's stream must not disturb A's cached assembler.
    const blocksB = collectWorkerThinkingBlocks(seatB, eventsB);
    expect(blocksB).toHaveLength(1);
    expect(blocksB[0].content).toBe("B 的思考");

    const blocksA2 = collectWorkerThinkingBlocks(seatA, eventsA);
    expect(blocksA2).toHaveLength(1);
    expect(blocksA2[0]).toBe(blocksA[0]);
    expect(blocksA2[0].content).toBe("A 的思考");
  });

  it("keys seats by the full seatId, not the slug (seatId 身份不塌陷)", () => {
    // Two rounds of the same template share the slug but not the roundtableId:
    // the store buffers are separate, so the collector's cursor must be too.
    const first = "sources::rt-one";
    const second = "sources::rt-two";
    const eventsFirst = tagAll(first, thinkingTurn(["第一场"], 1000));
    const eventsSecond = tagAll(second, thinkingTurn(["第二场"], 2000));

    expect(collectWorkerThinkingBlocks(first, eventsFirst)[0].content).toBe("第一场");
    expect(collectWorkerThinkingBlocks(second, eventsSecond)[0].content).toBe("第二场");
    expect(collectWorkerThinkingBlocks(first, eventsFirst)).toHaveLength(1);
  });
});

// ============================================================================
// Thinking block production and order
// ============================================================================

describe("thinking block production", () => {
  it("returns multiple segments in timeline order with supersede states (thinking 块产出与顺序)", () => {
    const seat = seatId("theory");
    const events = tagAll(seat, [
      ...thinkingTurn(["第一段"], 1000, "第一段正文"),
      ...thinkingTurn(["第二段"], 2000, "第二段正文"),
    ]);

    const blocks = collectWorkerThinkingBlocks(seat, events);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b: ThinkingBlockData) => b.content)).toEqual(["第一段", "第二段"]);
    // Both turns settled: the first text of each turn superseded its block.
    expect(blocks.every((b) => b.phase === "ended" && b.superseded)).toBe(true);
    // Timeline order: first segment's timestamp is earlier.
    expect(blocks[0].timestamp).toBeLessThan(blocks[1].timestamp);
  });

  it("yields no blocks when the stream carries no thinking (无思考流)", () => {
    const seat = seatId("experiment");
    const blocks = collectWorkerThinkingBlocks(seat, tagAll(seat, [
      updateWithAme(makeMessage({ content: textContent("只有正文"), timestamp: 1000 }), { type: "text_start", contentIndex: 0 }),
    ]));
    expect(blocks).toHaveLength(0);
  });
});

// ============================================================================
// Cache bound (LRU)
// ============================================================================

describe("cache bound", () => {
  /**
   * The cache is keyed by seatId, which embeds the roundtableId: without a cap
   * every roundtable ever opened leaks one entry per seat. Eviction is observed
   * through the identity cursor — an evicted seat rebuilds on its next call and
   * therefore returns a NEW block object, while a cached seat returns the same
   * object (the streams below are reused by reference, so a cached seat is a
   * pure incremental hit).
   */
  function seatStreams(count: number, prefix: string): Array<{ seat: string; events: TaggedSessionEvent[] }> {
    return Array.from({ length: count }, (_, i) => {
      const seat = `${prefix}-${i}::${prefix}`;
      return { seat, events: tagAll(seat, thinkingTurn([`思考 ${seat}`], 1000)) };
    });
  }

  it("caps the cached seats and evicts the least recently used one (缓存上限与 LRU 淘汰)", () => {
    const filled = seatStreams(MAX_CACHED_SEATS + 1, "cap").map(({ seat, events }) => ({
      seat,
      events,
      block: collectWorkerThinkingBlocks(seat, events)[0],
    }));

    // One key past the cap: the first-inserted seat was evicted — its next call
    // misses the cursor, rebuilds, and folds the same content into a new block.
    const oldest = filled[0];
    const rebuilt = collectWorkerThinkingBlocks(oldest.seat, oldest.events);
    expect(rebuilt[0]).not.toBe(oldest.block);
    expect(rebuilt[0].content).toBe(`思考 ${oldest.seat}`);

    // The most recently used seat is still cached (same block object).
    const newest = filled[filled.length - 1];
    expect(collectWorkerThinkingBlocks(newest.seat, newest.events)[0]).toBe(newest.block);
  });

  it("refreshes recency on a hit — a touched seat survives eviction (命中刷新 LRU 位)", () => {
    const filled = seatStreams(MAX_CACHED_SEATS, "touch").map(({ seat, events }) => ({
      seat,
      events,
      block: collectWorkerThinkingBlocks(seat, events)[0],
    }));

    // A hit on the oldest key refreshes its LRU position.
    const touched = filled[0];
    expect(collectWorkerThinkingBlocks(touched.seat, touched.events)[0]).toBe(touched.block);

    // The next insert must evict the now-oldest key (the second one): the
    // touched seat stays cached, that untouched neighbour does not.
    const fresh = seatStreams(1, "touch-fresh")[0];
    expect(collectWorkerThinkingBlocks(fresh.seat, fresh.events)).toHaveLength(1);

    expect(collectWorkerThinkingBlocks(touched.seat, touched.events)[0]).toBe(touched.block);
    const victim = filled[1];
    expect(collectWorkerThinkingBlocks(victim.seat, victim.events)[0]).not.toBe(victim.block);
    const repaired = collectWorkerThinkingBlocks(victim.seat, victim.events)[0];
    expect(repaired.content).toBe(`思考 ${victim.seat}`);
  });
});
