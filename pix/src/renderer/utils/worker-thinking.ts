/**
 * Seat thinking-block collector (PiX 1.5, N13 — SDD §4.1.5; roundtable S6).
 *
 * WorkerSessionView is an independent render chain: it does not go through
 * the display-blocks assembler / SessionView, but coalesces `message_update`
 * text on its own from the team-store raw event stream (keyed by seatId, the
 * roundtable seat identity). To make seat thinking blocks behave exactly like
 * the main session, this module reuses the same assembler factory per seat —
 * with a Vue reactive blocks array injected (the assembler itself stays
 * framework-free), so the folding semantics are identical by construction and
 * the folded block objects stay reactive for the ThinkingBlock component.
 */

import { reactive } from "vue";
import { createDisplayBlockAssembler, type DisplayBlockAssembler } from "./display-blocks";
import type { TaggedSessionEvent } from "../stores/team-store";
import type { DisplayBlock } from "@/types/session";

export type ThinkingBlockData = Extract<DisplayBlock, { type: "thinking" }>;

interface SeatThinkingState {
  assembler: DisplayBlockAssembler;
  /** 上次应用时 events[0] 的引用（TaggedSessionEvent 对象即身份）。 */
  firstEventRef: TaggedSessionEvent | undefined;
  /** 已应用到组装器的事件条数（仅当引用未变化时有效）。 */
  applied: number;
}

/**
 * 每个席位组装器实例的 LRU 上限（插入序 Map 实现 LRU，不引入 LRU 库，
 * 与 markdown 渲染缓存同一做法）。
 *
 * 键含 roundtableId（`<slug>::<roundtableId>`），无上限时每开一场圆桌就永久
 * 留下 N 个键，每个键还持有最多 MAX_SEAT_EVENTS 条事件折叠出的 blocks。
 * 64 个键足够覆盖一场圆桌（≤12 席）加前几场的席位。
 */
export const MAX_CACHED_SEATS = 64;

/** Per-seat assembler instances, keyed by seatId (LRU, capped by MAX_CACHED_SEATS). */
const seatStates = new Map<string, SeatThinkingState>();

/**
 * LRU 读取：命中后 delete + 重新插入移到尾部，使 `keys().next()` 始终是
 * 最久未用键。淘汰是透明的——被淘汰的席位下次调用时身份游标必然不匹配，
 * 走与「圆桌重建」相同的全量重放路径，不会残留旧块。
 */
function getState(seatId: string): SeatThinkingState | undefined {
  const state = seatStates.get(seatId);
  if (state === undefined) return undefined;
  seatStates.delete(seatId);
  seatStates.set(seatId, state);
  return state;
}

function setState(seatId: string, state: SeatThinkingState): void {
  // delete + set：重建同一席位时把它移到尾部（视为最近使用）。
  seatStates.delete(seatId);
  seatStates.set(seatId, state);
  if (seatStates.size > MAX_CACHED_SEATS) {
    // Map 按插入序迭代：首个键即最久未用键（刚插入的键必在尾部，不会被淘汰）。
    const oldest = seatStates.keys().next().value;
    if (oldest !== undefined) seatStates.delete(oldest);
  }
}

function thinkingBlocksOf(assembler: DisplayBlockAssembler): ThinkingBlockData[] {
  return assembler.blocks.filter((b): b is ThinkingBlockData => b.type === "thinking");
}

/**
 * 增量地将单个席位的原始事件应用到该席位专属的组装器实例，返回其
 * thinking 块（时间线顺序）。module 内部 Map<seatId, {assembler, firstEventRef,
 * applied}>：以身份游标判定重建——events[0] 的对象引用与上次记录不一致
 * （team-store 的 MAX_SEAT_EVENTS=200 头部滑动截断、或圆桌重建导致的
 * 数组清空重填）时丢弃该组装器、重建并全量重放当前缓冲（≤200 条，代价可忽略），
 * 旧块不可能残留；否则只应用增量事件。组装器注入 reactive([])（先建 reactive
 * 数组再注入，参照 session-store），块对象为响应式代理，ThinkingBlock 的
 * props/内部 watch 依赖可被追踪。缓存按 MAX_CACHED_SEATS 做 LRU 淘汰，被淘汰
 * 的席位走同一条重建路径。
 */
export function collectWorkerThinkingBlocks(
  seatId: string,
  events: readonly TaggedSessionEvent[],
): ThinkingBlockData[] {
  const state = getState(seatId);
  if (!state || events[0] !== state.firstEventRef) {
    const assembler = createDisplayBlockAssembler({ blocks: reactive<DisplayBlock[]>([]) });
    assembler.applyEvents(events.map((t) => t.event));
    setState(seatId, { assembler, firstEventRef: events[0], applied: events.length });
    return thinkingBlocksOf(assembler);
  }
  if (events.length > state.applied) {
    state.assembler.applyEvents(events.slice(state.applied).map((t) => t.event));
    state.applied = events.length;
  }
  return thinkingBlocksOf(state.assembler);
}
