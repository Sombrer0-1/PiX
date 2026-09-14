/**
 * SeatInterruptController + TeamCapacityPool tests (S2c, plan §4.7 / §4.8,
 * H5, H32, H39, H44).
 *
 * Covers:
 *   - L0/L1: L1 无条件接受、只发布 L1 决策（绝不 abort）、不置 pendingStopAfterTurn
 *   - 席位 L2 无公开 reason 被拒；有 reason 的纯生成 L2 立即发布 abort 决策
 *   - 工具批次中（inFlightTools>0 或 H39 探针）：置 pendingStopAfterTurn，
 *     不报告 abort；flag 被消费时决策才落地
 *   - H32：shouldStopAfterTurn 只对同一次置位返回一次 true
 *   - L3：席位不可对他人 L3；user/system L3 接受并清掉挂起的 stop
 *   - H5 预算：每席每轮 1 次 / 同目标 30s 间隔 / 60s 窗口 8 次 / 同目标连续 2 次熔断
 *   - 用户 L1/L2/L3 不限额、不计入席位配额
 *   - TeamCapacityPool：12 席槽 + 2 aux 槽、pause 拦住新 acquire、resume 恢复
 *
 * Run with: npx tsx pix/src/main/__tests__/team-interrupt.test.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  INTERRUPT_REJECT,
  SeatInterruptController,
  type InterruptAttentionSink,
  type SeatInterruptOptions,
  type SeatInterruptResult,
} from "../team/interrupt.js";
import { TeamCapacityPool } from "../team/capacity-pool.js";
import type { InterruptLevel } from "../../shared/team-types.js";

// ============================================================================
// Test harness (matches team-ids.test.ts / execution-context.test.ts style)
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
    console.error(
      `  FAIL: ${message} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${name} ===\n`);
  try {
    await fn();
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name} threw unexpectedly: ${String(err)}`);
  }
}

// ============================================================================
// Fixtures
// ============================================================================

const TARGET = "theory::rt-1";
const OTHER = "feasibility::rt-1";
const ACTOR = "counterexample::rt-1";
const USER = "user";
const SEAT_REASON = "新增证据与当前前提冲突，需要重新组织";

interface Decision {
  seatId: string;
  level: InterruptLevel;
}

interface AttentionRecord {
  kind: string;
  text: string;
  seatId?: string;
  refId?: string;
}

interface TestClock {
  now: () => number;
  advance: (ms: number) => void;
}

/** Injectable time source: budget windows are exercised without sleeping. */
function makeClock(start = 1_700_000_000_000): TestClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** Structural stand-in for the S2d AttentionBus push surface. */
function makeAttention(): { items: AttentionRecord[]; sink: InterruptAttentionSink } {
  const items: AttentionRecord[] = [];
  const sink: InterruptAttentionSink = {
    push(item) {
      items.push({ kind: item.kind, text: item.text, seatId: item.seatId, refId: item.refId });
      return item;
    },
  };
  return { items, sink };
}

/** Controller + a recording onApply consumer (stands in for SeatRunner.apply). */
function makeController(options: SeatInterruptOptions = {}): {
  controller: SeatInterruptController;
  decisions: Decision[];
  off: () => void;
} {
  const decisions: Decision[] = [];
  const controller = new SeatInterruptController(options);
  const off = controller.onApply((seatId, level) => {
    decisions.push({ seatId, level });
  });
  return { controller, decisions, off };
}

function rejectionReason(result: SeatInterruptResult): string {
  return result.accepted ? "" : result.reason;
}

function levelsOf(decisions: Decision[]): string {
  return decisions.map((decision) => decision.level).join(",");
}

/** 源码级检查前先去掉注释：注释里提到某个名字不算依赖。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function readOwnSource(relativePath: string): string {
  return stripComments(readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8"));
}

// ============================================================================
// SeatInterruptController
// ============================================================================

await run("L0/L1：无条件接受、不 abort、不置 pendingStopAfterTurn", async () => {
  const clock = makeClock();
  const attention = makeAttention();
  const { controller, decisions } = makeController({ now: clock.now, attention: attention.sink });

  for (let i = 1; i <= 20; i++) {
    const result = controller.request({ targetSeatId: TARGET, level: "L1", actor: "seat", fromSeatId: ACTOR });
    assert(result.accepted === true, `席位 L1 第 ${i} 次无条件接受（不限额）`);
  }
  assert(
    controller.request({ targetSeatId: TARGET, level: "L1", actor: USER }).accepted === true,
    "用户 L1 接受",
  );

  assertEqual(decisions.length, 21, "每次接受的 L1 都发布一条决策（SeatRunner 据此 steer）");
  assertEqual(levelsOf(decisions), "L1,L1,L1,L1,L1,L1,L1,L1,L1,L1,L1,L1,L1,L1,L1,L1,L1,L1,L1,L1,L1", "L1 只发布 L1 决策");
  assert(
    decisions.every((decision) => decision.level === "L1"),
    "L1 不产生任何 abort 决策（没有 L2/L3）",
  );
  assert(
    decisions.every((decision) => decision.seatId === TARGET),
    "决策目标席是 request 的 targetSeatId",
  );
  assertEqual(controller.shouldStopAfterTurn(TARGET), false, "L1 不置 pendingStopAfterTurn");
  assertEqual(attention.items.length, 0, "L1 不产生注意力条目");
  assertEqual(controller.inFlightTools(TARGET), 0, "L1 不改变 in-flight 计数");

  assert(
    controller.request({ targetSeatId: TARGET, level: "L0", actor: "seat", fromSeatId: ACTOR }).accepted === true,
    "L0 接受（仅 enqueue，无插话标）",
  );
  assertEqual(decisions.length, 21, "L0 不发布执行决策");
});

await run("席位 L2：缺公开理由被拒；有理由的纯生成 L2 立即发布 abort 决策", async () => {
  const clock = makeClock();
  const attention = makeAttention();
  const { controller, decisions } = makeController({ now: clock.now, attention: attention.sink });

  const missing = controller.request({ targetSeatId: TARGET, level: "L2", actor: "seat", fromSeatId: ACTOR });
  assert(missing.accepted === false, "无 reason 的席位 L2 被拒绝");
  assertEqual(rejectionReason(missing), INTERRUPT_REJECT.seatRequiresReason, "拒绝原因 = seat_l2_requires_reason");

  const blank = controller.request({ targetSeatId: TARGET, level: "L2", actor: "seat", fromSeatId: ACTOR, reason: "   " });
  assert(blank.accepted === false, "空白 reason 同样被拒绝");

  assertEqual(decisions.length, 0, "被拒的 L2 不发布决策");
  assertEqual(attention.items.length, 0, "缺理由不是预算问题，不进注意力面");

  const accepted = controller.request({
    targetSeatId: TARGET,
    level: "L2",
    actor: "seat",
    fromSeatId: ACTOR,
    reason: SEAT_REASON,
  });
  assert(accepted.accepted === true, "有 reason 的席位 L2 接受");
  assertEqual(decisions.length, 1, "纯生成（无工具批次）立即发布决策");
  assertEqual(decisions[0]?.seatId, TARGET, "决策目标席");
  assertEqual(decisions[0]?.level, "L2", "决策级别 L2（SeatRunner 走 abort + 重开）");
  assertEqual(controller.shouldStopAfterTurn(TARGET), false, "无工具批次时不置 pendingStopAfterTurn");
});

await run("工具批次中 L2：置 pendingStopAfterTurn、不报告 abort", async () => {
  const clock = makeClock();
  const attention = makeAttention();
  const { controller, decisions } = makeController({ now: clock.now, attention: attention.sink });

  controller.notifyToolStart(TARGET, "tc-1");
  assertEqual(controller.inFlightTools(TARGET), 1, "notifyToolStart 后 in-flight = 1");

  const result = controller.request({
    targetSeatId: TARGET,
    level: "L2",
    actor: "seat",
    fromSeatId: ACTOR,
    reason: SEAT_REASON,
  });
  assert(result.accepted === true, "批次中的 L2 接受");
  assertEqual(decisions.length, 0, "批次中不报告 abort（不发布 L2 决策）");
  assertEqual(controller.shouldStopAfterTurn(TARGET), true, "批次中改置 pendingStopAfterTurn（H39）");
  assertEqual(decisions.length, 1, "flag 被消费时决策才落地");
  assertEqual(decisions[0]?.seatId, TARGET, "落地决策的目标席");
  assertEqual(decisions[0]?.level, "L2", "落地决策的级别");

  controller.notifyToolEnd(TARGET, "tc-1");
  assertEqual(controller.inFlightTools(TARGET), 0, "notifyToolEnd 后 in-flight = 0");
  controller.notifyToolEnd(TARGET, "unknown-tool-call");
  assertEqual(controller.inFlightTools(TARGET), 0, "未知 toolCallId 的 end 不影响计数");
});

await run("H39：toolCall 块存在但 in-flight 计数为 0 时也不 abort", async () => {
  const clock = makeClock();
  // SeatRunner 接的是 session.agent.state：streamingMessage 里的未执行 toolCall / pendingToolCalls。
  const streamingToolCall = new Set<string>([TARGET]);
  const { controller, decisions } = makeController({
    now: clock.now,
    isToolBatchInProgress: (seatId) => streamingToolCall.has(seatId),
  });

  assertEqual(controller.inFlightTools(TARGET), 0, "in-flight 计数为 0");
  const result = controller.request({
    targetSeatId: TARGET,
    level: "L2",
    actor: "user",
  });
  assert(result.accepted === true, "计数为 0 但探针报告批次 → 仍接受");
  assertEqual(decisions.length, 0, "有未执行的 toolCall 块 → 不 abort");
  assertEqual(controller.shouldStopAfterTurn(TARGET), true, "改走 shouldStopAfterTurn");
  assertEqual(decisions.length, 1, "消费后决策落地");
});

await run("H32：shouldStopAfterTurn 只生效一次（消费语义），后续 run 可再置位", async () => {
  const clock = makeClock();
  const { controller, decisions } = makeController({ now: clock.now });

  controller.notifyToolStart(TARGET, "tc-1");
  controller.request({ targetSeatId: TARGET, level: "L2", actor: "seat", fromSeatId: ACTOR, reason: SEAT_REASON });

  assertEqual(controller.shouldStopAfterTurn(TARGET), true, "第一次读取返回 true");
  assertEqual(controller.shouldStopAfterTurn(TARGET), false, "紧随其后的第二次返回 false（flag 已消费）");
  assertEqual(controller.shouldStopAfterTurn(TARGET), false, "后续 turn 也不会提前结束");
  assertEqual(decisions.length, 1, "决策只落地一次");
  assertEqual(controller.shouldStopAfterTurn(OTHER), false, "未置位的席始终返回 false");

  // 同一次 run 内不能重复打断（每席每轮预算），越过间隔后新 run 可以再置位。
  clock.advance(31_000);
  controller.notifyToolStart(TARGET, "tc-2");
  const again = controller.request({
    targetSeatId: TARGET,
    level: "L2",
    actor: "seat",
    fromSeatId: ACTOR,
    reason: SEAT_REASON,
  });
  assert(again.accepted === true, "新 run 的批次 L2 接受");
  assertEqual(controller.shouldStopAfterTurn(TARGET), true, "flag 不是一次性：新 run 可再置位");
  assertEqual(controller.shouldStopAfterTurn(TARGET), false, "新 run 的 flag 同样只生效一次");
  assertEqual(decisions.length, 2, "两次置位各落地一条决策");
});

await run("F1-3：clearPendingStop 清掉绕过 controller 的 L3 留下的挂起 stop", async () => {
  const clock = makeClock();
  const { controller, decisions } = makeController({ now: clock.now });

  // 工具批次中置位（H39 → pendingStop，不 abort、不 publish）。
  controller.notifyToolStart(TARGET, "tc-1");
  const accepted = controller.request({
    targetSeatId: TARGET,
    level: "L2",
    actor: "seat",
    fromSeatId: ACTOR,
    reason: SEAT_REASON,
  });
  assert(accepted.accepted === true, "批次中的 L2 被接受（挂起 stop）");
  assertEqual(decisions.length, 0, "挂起而不是消费（没有 abort 决策）");

  // pause / removeSeat 直接发 L3（不经过 controller）时，runner 用 clearPendingStop 收尾：
  // 被 abort 的 run 不会再调 shouldStopAfterTurn，flag 不清就会泄漏到恢复后的下一个 run。
  controller.clearPendingStop(TARGET);
  assertEqual(controller.shouldStopAfterTurn(TARGET), false, "clearPendingStop 之后 shouldStopAfterTurn 不返回 true");
  assertEqual(decisions.length, 0, "被清掉的挂起决策不落地");

  // 清过之后仍可重新置位（清的是 flag，不是这套机制）。
  clock.advance(31_000);
  controller.notifyToolStart(TARGET, "tc-2");
  controller.request({ targetSeatId: TARGET, level: "L2", actor: "seat", fromSeatId: ACTOR, reason: SEAT_REASON });
  assertEqual(controller.shouldStopAfterTurn(TARGET), true, "重新置位照常生效（H32 消费语义不变）");
  assertEqual(decisions.length, 1, "消费时决策才落地");
});

await run("L3：席位拒绝、user/system 接受并清掉挂起的 stop", async () => {
  const clock = makeClock();
  const { controller, decisions, off } = makeController({ now: clock.now });

  const seatL3 = controller.request({ targetSeatId: TARGET, level: "L3", actor: "seat", fromSeatId: ACTOR });
  assert(seatL3.accepted === false, "席位不能对他人 L3");
  assertEqual(rejectionReason(seatL3), INTERRUPT_REJECT.seatCannotL3, "拒绝原因 = seat_cannot_l3");
  assertEqual(decisions.length, 0, "被拒的 L3 不发布决策");

  controller.notifyToolStart(TARGET, "tc-1");
  controller.request({ targetSeatId: TARGET, level: "L2", actor: "seat", fromSeatId: ACTOR, reason: SEAT_REASON });
  assertEqual(decisions.length, 0, "批次中先挂起一个 L2 决策（未落地）");
  controller.notifyToolEnd(TARGET, "tc-1");

  const userL3 = controller.request({ targetSeatId: TARGET, level: "L3", actor: USER });
  assert(userL3.accepted === true, "用户 L3 接受");
  assertEqual(levelsOf(decisions), "L3", "只发布 L3（挂起的 L2 决策不落地）");
  assertEqual(decisions[0]?.seatId, TARGET, "L3 目标席");
  assertEqual(controller.shouldStopAfterTurn(TARGET), false, "L3 清掉 pendingStopAfterTurn，不泄漏到下一个 run");

  const systemL3 = controller.request({ targetSeatId: OTHER, level: "L3", actor: "system" });
  assert(systemL3.accepted === true, "system L3 接受");
  assertEqual(levelsOf(decisions), "L3,L3", "两条 L3 决策");

  off();
  controller.request({ targetSeatId: OTHER, level: "L3", actor: USER });
  assertEqual(decisions.length, 2, "onApply 退订后不再收到决策（SeatRunner.stop 用）");
});

await run("H5 预算：每席每轮 1 次", async () => {
  const clock = makeClock();
  const attention = makeAttention();
  const { controller, decisions } = makeController({ now: clock.now, attention: attention.sink });

  controller.notifyToolStart(TARGET, "tc-1"); // 批次中：本轮不会结束
  const first = controller.request({
    targetSeatId: TARGET,
    level: "L2",
    actor: "seat",
    fromSeatId: ACTOR,
    reason: SEAT_REASON,
  });
  assert(first.accepted === true, "本轮第一次 L2 接受");

  // 越过 minIntervalMs，证明被挡住的是「每席每轮」而不是间隔规则。
  clock.advance(31_000);
  const second = controller.request({
    targetSeatId: TARGET,
    level: "L2",
    actor: "seat",
    fromSeatId: ACTOR,
    reason: SEAT_REASON,
  });
  assert(second.accepted === false, "同一轮内第二次 L2 被拒");
  assertEqual(rejectionReason(second), INTERRUPT_REJECT.perTurn, "拒绝原因 = l2_budget_per_turn");
  assertEqual(decisions.length, 0, "被拒的 L2 不发布决策");
  assertEqual(attention.items.length, 1, "预算拒绝产出 1 条注意力");
  assertEqual(attention.items[0]?.kind, "l2_fused", "注意力 kind = l2_fused");
  assertEqual(attention.items[0]?.seatId, TARGET, "注意力指向被打的席");
});

await run("H5 预算：对同一目标最小间隔 30s", async () => {
  const clock = makeClock();
  const { controller, decisions } = makeController({ now: clock.now });

  const first = controller.request({
    targetSeatId: TARGET,
    level: "L2",
    actor: "seat",
    fromSeatId: ACTOR,
    reason: SEAT_REASON,
  });
  assert(first.accepted === true, "首次 L2 接受（本轮结束，每轮预算清零）");

  clock.advance(10_000);
  const tooSoon = controller.request({
    targetSeatId: TARGET,
    level: "L2",
    actor: "seat",
    fromSeatId: ACTOR,
    reason: SEAT_REASON,
  });
  assert(tooSoon.accepted === false, "10s 内再次打断同一席被拒");
  assertEqual(rejectionReason(tooSoon), INTERRUPT_REJECT.minInterval, "拒绝原因 = l2_budget_min_interval");

  clock.advance(21_000); // 距上次打断 31s
  const later = controller.request({
    targetSeatId: TARGET,
    level: "L2",
    actor: "seat",
    fromSeatId: ACTOR,
    reason: SEAT_REASON,
  });
  assert(later.accepted === true, "31s 后同一席可再次被打断");
  assertEqual(decisions.length, 2, "两次接受各发布一条决策");
});

await run("H5 预算：60s 滚动窗口最多 8 次 L2", async () => {
  const clock = makeClock();
  const attention = makeAttention();
  const { controller, decisions } = makeController({ now: clock.now, attention: attention.sink });

  let accepted = 0;
  for (let i = 0; i < 8; i++) {
    const result = controller.request({
      targetSeatId: `seat-${i}::rt-1`,
      level: "L2",
      actor: "seat",
      fromSeatId: ACTOR,
      reason: SEAT_REASON,
    });
    if (result.accepted) accepted++;
    clock.advance(5_000); // 8 次全部落在 60s 窗口内
  }
  assertEqual(accepted, 8, "窗口内前 8 次全部接受");

  const ninth = controller.request({
    targetSeatId: "seat-9::rt-1",
    level: "L2",
    actor: "seat",
    fromSeatId: ACTOR,
    reason: SEAT_REASON,
  });
  assert(ninth.accepted === false, "第 9 次被全场滚动窗口拒绝");
  assertEqual(rejectionReason(ninth), INTERRUPT_REJECT.globalWindow, "拒绝原因 = l2_budget_global_window");
  assertEqual(decisions.length, 8, "8 次接受 = 8 条决策，被拒的不发布");
  assertEqual(attention.items.length, 1, "窗口耗尽产出 1 条 l2_fused 注意力");

  clock.advance(61_000); // 旧时间戳全部滑出窗口
  const afterWindow = controller.request({
    targetSeatId: "seat-9::rt-1",
    level: "L2",
    actor: "seat",
    fromSeatId: ACTOR,
    reason: SEAT_REASON,
  });
  assert(afterWindow.accepted === true, "窗口滑出后恢复接受");
  assertEqual(decisions.length, 9, "恢复后新增一条决策");
});

await run("H5 预算：同一目标连续 2 次被打 → 熔断（换目标后解除）", async () => {
  const clock = makeClock();
  const attention = makeAttention();
  const { controller, decisions } = makeController({ now: clock.now, attention: attention.sink });

  const first = controller.request({
    targetSeatId: TARGET,
    level: "L2",
    actor: "seat",
    fromSeatId: ACTOR,
    reason: SEAT_REASON,
  });
  assert(first.accepted === true, "第一次打断接受");

  clock.advance(31_000);
  const second = controller.request({
    targetSeatId: TARGET,
    level: "L2",
    actor: "seat",
    fromSeatId: ACTOR,
    reason: SEAT_REASON,
  });
  assert(second.accepted === true, "连续第二次打断仍接受（它触发熔断）");
  assert(
    attention.items.some((item) => item.kind === "l2_fused"),
    "熔断进注意力面 l2_fused",
  );

  clock.advance(31_000);
  const third = controller.request({
    targetSeatId: TARGET,
    level: "L2",
    actor: "seat",
    fromSeatId: ACTOR,
    reason: SEAT_REASON,
  });
  assert(third.accepted === false, "熔断后针对该席的新 L2 被拒");
  assertEqual(rejectionReason(third), INTERRUPT_REJECT.fused, "拒绝原因 = l2_budget_fused");
  assertEqual(decisions.length, 2, "被熔断的 L2 不发布决策");

  clock.advance(1_000);
  const otherTarget = controller.request({
    targetSeatId: OTHER,
    level: "L2",
    actor: "seat",
    fromSeatId: ACTOR,
    reason: SEAT_REASON,
  });
  assert(otherTarget.accepted === true, "换目标打断一次（连续计数重置）");

  clock.advance(31_000);
  const lifted = controller.request({
    targetSeatId: TARGET,
    level: "L2",
    actor: "seat",
    fromSeatId: ACTOR,
    reason: SEAT_REASON,
  });
  assert(lifted.accepted === true, "换过目标后对原目标的熔断解除");
  assertEqual(decisions.length, 4, "四次接受的决策数");
  assertEqual(attention.items.length, 2, "熔断触发 + 熔断拒绝各一条注意力");
  assert(
    attention.items.every((item) => item.kind === "l2_fused"),
    "注意力条目都是 l2_fused",
  );
});

await run("用户 L1/L2/L3 不限额、不排队、不计入席位配额", async () => {
  const clock = makeClock();
  const attention = makeAttention();
  const { controller, decisions } = makeController({ now: clock.now, attention: attention.sink });

  for (let i = 1; i <= 20; i++) {
    const result = controller.request({ targetSeatId: TARGET, level: "L2", actor: USER });
    assert(result.accepted === true, `用户 L2 第 ${i} 次接受（不限额）`);
  }
  assertEqual(decisions.length, 20, "每次用户 L2 都发布决策");
  assertEqual(levelsOf(decisions), "L2,L2,L2,L2,L2,L2,L2,L2,L2,L2,L2,L2,L2,L2,L2,L2,L2,L2,L2,L2", "全部是 L2 决策");
  assertEqual(attention.items.length, 0, "用户 L2 不触发熔断");

  const afterUser = controller.request({
    targetSeatId: TARGET,
    level: "L2",
    actor: "seat",
    fromSeatId: ACTOR,
    reason: SEAT_REASON,
  });
  assert(afterUser.accepted === true, "用户 L2 之后席位 L2 仍可用（用户不占席位配额）");

  assert(
    controller.request({ targetSeatId: TARGET, level: "L1", actor: USER }).accepted === true,
    "用户 L1 接受",
  );
  assert(
    controller.request({ targetSeatId: TARGET, level: "L3", actor: USER }).accepted === true,
    "用户 L3 接受",
  );
  assertEqual(decisions.length, 23, "用户 L1/L3 各发布一条决策");
});

await run("SeatInterruptController：不持有 session / timeline / inbox", async () => {
  const code = readOwnSource("../team/interrupt.ts");
  assert(
    !code.includes("timeline-log") && !code.includes("seat-inbox"),
    "interrupt.ts 不 import timeline / inbox 模块",
  );
  assert(
    !code.includes("runtimeCwd") && !code.includes(".abort(") && !code.includes("clearQueue"),
    "interrupt.ts 不触碰 session 执行面（abort / clearQueue / cwd 都在 SeatRunner.apply）",
  );
});

await run("SeatInterruptController：attention 依赖可省略（S2d 接线前也能决策）", async () => {
  const clock = makeClock();
  const { controller, decisions } = makeController({ now: clock.now });

  const first = controller.request({
    targetSeatId: TARGET,
    level: "L2",
    actor: "seat",
    fromSeatId: ACTOR,
    reason: SEAT_REASON,
  });
  assert(first.accepted === true, "无 attention sink 时接受正常");

  clock.advance(1_000);
  let threw = false;
  let rejected = false;
  try {
    const tooSoon = controller.request({
      targetSeatId: TARGET,
      level: "L2",
      actor: "seat",
      fromSeatId: ACTOR,
      reason: SEAT_REASON,
    });
    rejected = tooSoon.accepted === false;
  } catch {
    threw = true;
  }
  assert(!threw, "无 attention sink 时预算拒绝不抛错");
  assert(rejected, "预算拒绝仍然生效");
  assertEqual(decisions.length, 1, "只有接受的那次发布决策");
});

// ============================================================================
// TeamCapacityPool
// ============================================================================

await run("TeamCapacityPool：12 席槽 + 2 aux 槽，第 13 席被拒", async () => {
  const pool = new TeamCapacityPool();

  const seatIds = Array.from({ length: 12 }, (_, index) => `seat-${index + 1}::rt-1`);
  for (const [index, seatId] of seatIds.entries()) {
    assert(pool.acquireSeat(seatId) === true, `第 ${index + 1} 席拿到槽`);
  }
  assert(pool.acquireSeat("seat-13::rt-1") === false, "第 13 席被拒");
  assert(pool.acquireSeat(seatIds[0] ?? "seat-1::rt-1") === true, "已持槽席重复 acquire 幂等成功");
  assert(pool.acquireSeat("seat-13::rt-1") === false, "满槽时新席仍被拒");

  pool.releaseSeat(seatIds[0] ?? "seat-1::rt-1");
  assert(pool.acquireSeat("seat-13::rt-1") === true, "释放一槽后可再拿");
  pool.releaseSeat("unknown-seat::rt-1");
  assert(pool.acquireSeat("seat-14::rt-1") === false, "释放未知席不解锁槽位");

  assert(pool.acquireAux("job-1") === true, "第 1 个 aux 拿到槽");
  assert(pool.acquireAux("job-2") === true, "第 2 个 aux 拿到槽（独立于席位槽）");
  assert(pool.acquireAux("job-3") === false, "第 3 个 aux 被拒");
  assert(pool.acquireAux("job-1") === true, "同一 job 重复 acquire 幂等成功");
  pool.releaseAux("job-1");
  assert(pool.acquireAux("job-3") === true, "释放 aux 后可再拿");
});

await run("TeamCapacityPool：pause 拦住一切新 acquire，resume 恢复且不丢已持槽", async () => {
  const pool = new TeamCapacityPool(2, 1);

  assert(pool.acquireSeat("a::rt-1") === true, "自定义 2 席槽：第 1 席拿到");
  assert(pool.acquireAux("job-1") === true, "自定义 1 aux 槽：第 1 个拿到");

  pool.pause();
  assert(pool.acquireSeat("b::rt-1") === false, "暂停时新席拿不到槽");
  assert(pool.acquireSeat("a::rt-1") === false, "暂停时已持槽席的重复 acquire 也失败");
  assert(pool.acquireAux("job-2") === false, "暂停时 aux 也拿不到");

  pool.resume();
  assert(pool.acquireSeat("b::rt-1") === true, "resume 后恢复发放");
  assert(pool.acquireSeat("c::rt-1") === false, "resume 后第 3 席仍被拒（pause 没有释放已持槽）");
  assert(pool.acquireAux("job-2") === false, "resume 后 aux 仍被 job-1 占满");

  pool.releaseSeat("a::rt-1");
  assert(pool.acquireSeat("c::rt-1") === true, "释放后第 3 席可拿");
  pool.releaseAux("job-1");
  assert(pool.acquireAux("job-2") === true, "释放后 aux 可拿");

  pool.pause();
  pool.pause();
  pool.resume();
  assert(pool.acquireSeat("d::rt-1") === false, "2 席槽已满：pause/resume 幂等且不扩容");
});

await run("TeamCapacityPool：独立于 agent-task（源码级）", async () => {
  const code = readOwnSource("../team/capacity-pool.ts");
  assert(!code.includes("agent-task"), "capacity-pool.ts 不 import ../agent-task 的 clamp/常量");
  assert(!code.includes("AgentTaskScheduler"), "capacity-pool.ts 不使用 AgentTaskScheduler");
  assert(!code.includes("import"), "capacity-pool.ts 无任何 import（零依赖）");
});

// ============================================================================

console.log("\n=== Summary ===\n");
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
