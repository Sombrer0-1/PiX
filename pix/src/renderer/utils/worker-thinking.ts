/**
 * Worker thinking-block collector (PiX 1.5, N13 — SDD §4.1.5).
 *
 * WorkerSessionView is an independent render chain: it does not go through
 * the display-blocks assembler / SessionView, but coalesces `message_update`
 * text on its own from the team-store raw event stream. To make worker
 * thinking blocks behave exactly like the main session, this module reuses
 * the same assembler factory per agent — with a Vue reactive blocks array
 * injected (the assembler itself stays framework-free), so the folding
 * semantics are identical by construction and the folded block objects stay
 * reactive for the ThinkingBlock component.
 */

import { reactive } from "vue";
import { createDisplayBlockAssembler, type DisplayBlockAssembler } from "./display-blocks";
import type { TaggedSessionEvent } from "../stores/team-store";
import type { DisplayBlock } from "@/types/session";

export type ThinkingBlockData = Extract<DisplayBlock, { type: "thinking" }>;

interface WorkerThinkingState {
  assembler: DisplayBlockAssembler;
  /** 上次应用时 events[0] 的引用（TaggedSessionEvent 对象即身份）。 */
  firstEventRef: TaggedSessionEvent | undefined;
  /** 已应用到组装器的事件条数（仅当引用未变化时有效）。 */
  applied: number;
}

/** Per-agent assembler instances, keyed by agentId. */
const workerStates = new Map<string, WorkerThinkingState>();

function thinkingBlocksOf(assembler: DisplayBlockAssembler): ThinkingBlockData[] {
  return assembler.blocks.filter((b): b is ThinkingBlockData => b.type === "thinking");
}

/**
 * 增量地将单个 worker 的原始事件应用到该 agent 专属的组装器实例，返回其
 * thinking 块（时间线顺序）。module 内部 Map<agentId, {assembler, firstEventRef,
 * applied}>：以身份游标判定重建——events[0] 的对象引用与上次记录不一致
 * （team-store 的 MAX_EVENTS_PER_WORKER=200 头部滑动截断、或团队重建导致的
 * 数组清空重填）时丢弃该组装器、重建并全量重放当前缓冲（≤200 条，代价可忽略），
 * 旧块不可能残留；否则只应用增量事件。组装器注入 reactive([])（先建 reactive
 * 数组再注入，参照 session-store），块对象为响应式代理，ThinkingBlock 的
 * props/内部 watch 依赖可被追踪。
 */
export function collectWorkerThinkingBlocks(
  agentId: string,
  events: readonly TaggedSessionEvent[],
): ThinkingBlockData[] {
  const state = workerStates.get(agentId);
  if (!state || events[0] !== state.firstEventRef) {
    const assembler = createDisplayBlockAssembler({ blocks: reactive<DisplayBlock[]>([]) });
    assembler.applyEvents(events.map((t) => t.event));
    workerStates.set(agentId, { assembler, firstEventRef: events[0], applied: events.length });
    return thinkingBlocksOf(assembler);
  }
  if (events.length > state.applied) {
    state.assembler.applyEvents(events.slice(state.applied).map((t) => t.event));
    state.applied = events.length;
  }
  return thinkingBlocksOf(state.assembler);
}
