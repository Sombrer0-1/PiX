/**
 * SeatInterruptController - L0-L3 interrupt decisions for roundtable seats
 * (dev plan §4.7 / §5.3-§5.6, H5, H32, H39).
 *
 * Decision layer only: this class holds no seat session, no timeline and no
 * inbox (H5). It decides, flips flags and publishes the accepted decision
 * through onApply; SeatRunner.apply(level) is the only place that touches the
 * seat session (abort / steer / prompt / clearQueue). Enqueueing the
 * interrupting message is the caller's job (TeamManager / tool-host) and
 * happens before or around `request()`.
 *
 * Public API frozen by S2c: S3 consumes this file and must not add a second
 * abort path.
 *
 * L2 (H5 budget, seat actors only):
 *   - per target per turn: 1 accepted L2; a "turn" ends when the controller
 *     applies a run-ending decision for that target (abort decision or
 *     shouldStopAfterTurn consumption), which is the only turn boundary the
 *     controller can observe without a session.
 *   - same target at most once per `minIntervalMs`;
 *   - at most `globalMaxInWindow` accepted L2s in the rolling
 *     `globalWindowMs` window;
 *   - two consecutive accepted L2s against the same target fuse further L2s
 *     against that target (the fuse lifts once an accepted L2 targets another
 *     seat) and raise Attention `l2_fused`.
 *   User/system requests bypass all of the above and are never counted.
 *   A run that ends without going through the controller (pause / removeSeat
 *   send L3 straight to the runner) is closed by the runner calling
 *   `clearPendingStop` (F1-3), otherwise the flag would leak into the run
 *   after resume.
 *
 * Tool batch in progress (H39): `inFlightTools(seatId) > 0` OR the injected
 * `isToolBatchInProgress` probe (SeatRunner wires the current assistant
 * message's unexecuted toolCall block / non-empty pendingToolCalls there).
 * While a batch is in progress the controller must NOT abort: it arms
 * `pendingStopAfterTurn` and publishes the L2 decision only when the loop
 * consumes the flag through `shouldStopAfterTurn` (H32).
 */

import { DEFAULT_L2_BUDGET } from "./constants.js";
import type { InterruptLevel, RoundtableSettings } from "../../shared/team-types.js";

/** Who asks for the interrupt: the user, a seat, or the system itself. */
export type InterruptActor = "user" | "seat" | "system";

export interface SeatInterruptRequest {
  targetSeatId: string;
  level: InterruptLevel;
  actor: InterruptActor;
  /** 发起席（仅 actor==="seat"，用于注意力溯源）。 */
  fromSeatId?: string;
  /** 席位 L2 必填的公开理由（§4.7 / §4.11 `send_team_message.reason`）。 */
  reason?: string;
}

export type SeatInterruptResult = { accepted: true } | { accepted: false; reason: string };

/**
 * Minimal structural view of the AttentionBus push surface (H44). Typed
 * structurally on purpose: `attention-bus.ts` (S2d) can be wired in without a
 * type-only import and without a class-identity coupling.
 */
export interface InterruptAttentionSink {
  push(item: { kind: string; text: string; seatId?: string; refId?: string }): unknown;
}

export interface SeatInterruptOptions {
  /** Time source. Injectable so the H5 windows are testable without sleeping. */
  now?: () => number;
  /** L2 budget (H5); defaults to DEFAULT_L2_BUDGET. */
  budget?: RoundtableSettings["l2"];
  /** Attention sink (H44 `l2_fused`); when absent the decision still stands. */
  attention?: InterruptAttentionSink;
  /**
   * H39 probe for the part of "tool batch in progress" a session-less
   * controller cannot see: the current assistant message carrying an
   * unexecuted toolCall block, or a non-empty pendingToolCalls set.
   * inFlightTools() is checked in addition, so omitting the probe only loses
   * the zero-count case.
   */
  isToolBatchInProgress?: (seatId: string) => boolean;
}

/** `{accepted:false}` reasons. Budget rejections also raise Attention `l2_fused`. */
export const INTERRUPT_REJECT = {
  /** 席位 L2 缺公开理由 */
  seatRequiresReason: "seat_l2_requires_reason",
  /** 席位不可对他人 L3 */
  seatCannotL3: "seat_cannot_l3",
  /** 每席每轮预算 */
  perTurn: "l2_budget_per_turn",
  /** 对同一目标的最小间隔 */
  minInterval: "l2_budget_min_interval",
  /** 全场滚动窗口预算 */
  globalWindow: "l2_budget_global_window",
  /** 同一目标连续被打的熔断 */
  fused: "l2_budget_fused",
} as const;

export class SeatInterruptController {
  private readonly now: () => number;
  private readonly budget: RoundtableSettings["l2"];
  private readonly attention: InterruptAttentionSink | null;
  private readonly isToolBatchInProgress: ((seatId: string) => boolean) | null;

  /** 该席进行中的工具调用 id（notifyToolStart/End 维护）。 */
  private readonly inFlight = new Map<string, Set<string>>();
  /** H32：置位后由 shouldStopAfterTurn 消费；批次中禁止 abort 时才置位。 */
  private readonly pendingStop = new Set<string>();
  /** H5 每席每轮已被打断次数（该席当前 run 结束时清零）。 */
  private readonly l2PerTurn = new Map<string, number>();
  /** H5 对同一目标最近一次被打的时间。 */
  private readonly lastL2AtByTarget = new Map<string, number>();
  /** H5 全场滚动窗口内被接受的席位 L2 时间戳（升序）。 */
  private readonly l2Window: number[] = [];
  /** H5 熔断状态：最近一次被打的目标 + 连续次数。 */
  private lastL2Target: string | null = null;
  private consecutiveHits = 0;
  private fusedTarget: string | null = null;

  private readonly applyHandlers: Array<(seatId: string, level: InterruptLevel) => void> = [];

  constructor(options: SeatInterruptOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.budget = options.budget ?? DEFAULT_L2_BUDGET;
    this.attention = options.attention ?? null;
    this.isToolBatchInProgress = options.isToolBatchInProgress ?? null;
  }

  /**
   * Decide L0-L3 for one target seat. Callers enqueue the message themselves;
   * this method never touches an inbox or a session.
   */
  request(input: SeatInterruptRequest): SeatInterruptResult {
    const target = input.targetSeatId;

    // L0: 仅 enqueue，无插话标，无执行动作（§4.7）。
    if (input.level === "L0") {
      return { accepted: true };
    }

    // 席位不可对他人 L3；L3 仅 user/system 可发。
    if (input.actor === "seat" && input.level === "L3") {
      return { accepted: false, reason: INTERRUPT_REJECT.seatCannotL3 };
    }

    if (input.actor === "seat" && input.level === "L2") {
      const reason = input.reason?.trim() ?? "";
      if (reason.length === 0) {
        return { accepted: false, reason: INTERRUPT_REJECT.seatRequiresReason };
      }
      const rejected = this.checkL2Budget(target, input.fromSeatId);
      if (rejected !== null) {
        return { accepted: false, reason: rejected };
      }
      this.recordSeatL2(target, input.fromSeatId);
    }

    // L1：席位无条件放行，不 abort、不限额。
    if (input.level === "L1") {
      this.publish(target, "L1");
      return { accepted: true };
    }

    // L2：批次中禁止 abort（H39），改置 pendingStopAfterTurn 等 H32 消费；
    // 纯生成 / 空闲时才可能 abort 当前流或直接带 inbox 重开。
    if (input.level === "L2") {
      if (this.isToolBatchActive(target)) {
        this.pendingStop.add(target);
        return { accepted: true };
      }
      this.endRun(target);
      this.publish(target, "L2");
      return { accepted: true };
    }

    // L3：abort + 停调度，未 commit 的 inbox 仍 pending（执行在 SeatRunner）。
    this.endRun(target);
    this.publish(target, "L3");
    return { accepted: true };
  }

  /**
   * Read by the Agent loop's shouldStopAfterTurn (S1 passthrough). H32 消费语义：
   * the call that returns true clears the flag, otherwise every later turn of
   * that seat would end early.
   */
  shouldStopAfterTurn(seatId: string): boolean {
    if (!this.pendingStop.has(seatId)) {
      return false;
    }
    this.pendingStop.delete(seatId);
    // 该 run 结束：批次中挂起的 L2 决策此刻落地（不 abort），新 turn 预算重新起算。
    this.endRun(seatId);
    this.publish(seatId, "L2");
    return true;
  }

  /**
   * F1-3：清掉未消费的挂起 stop 与该席本轮的 L2 预算。pause / removeSeat 直接发
   * L3，被 abort 的 run 不会再走 `shouldStopAfterTurn`，flag 不清就会泄漏到恢复
   * 后的下一个 run（该 turn 无故提前结束，还多一条「半成品」标注）。
   */
  clearPendingStop(seatId: string): void {
    this.endRun(seatId);
  }

  notifyToolStart(seatId: string, toolCallId: string): void {
    let ids = this.inFlight.get(seatId);
    if (ids === undefined) {
      ids = new Set<string>();
      this.inFlight.set(seatId, ids);
    }
    ids.add(toolCallId);
  }

  notifyToolEnd(seatId: string, toolCallId: string): void {
    const ids = this.inFlight.get(seatId);
    if (ids === undefined) {
      return;
    }
    ids.delete(toolCallId);
    if (ids.size === 0) {
      this.inFlight.delete(seatId);
    }
  }

  inFlightTools(seatId: string): number {
    return this.inFlight.get(seatId)?.size ?? 0;
  }

  /**
   * Decision for an accepted L1/L2/L3. SeatRunner.apply(seatId, level) executes
   * it against that seat's session. Returns the unsubscribe function (S3 must
   * call it from SeatRunner.stop()).
   */
  onApply(cb: (seatId: string, level: InterruptLevel) => void): () => void {
    this.applyHandlers.push(cb);
    return () => {
      const index = this.applyHandlers.indexOf(cb);
      if (index >= 0) {
        this.applyHandlers.splice(index, 1);
      }
    };
  }

  /** H39：in-flight 计数或注入的批次探针任一成立即视为工具批次进行中。 */
  private isToolBatchActive(seatId: string): boolean {
    if (this.inFlightTools(seatId) > 0) {
      return true;
    }
    return this.isToolBatchInProgress !== null && this.isToolBatchInProgress(seatId);
  }

  /**
   * H5 seat-actor budget. Returns the rejection reason, or null when the L2 may
   * be accepted. Every rejection raises Attention `l2_fused` (H44).
   */
  private checkL2Budget(target: string, fromSeatId: string | undefined): string | null {
    const at = this.now();

    if (this.fusedTarget === target) {
      this.raiseFused(target, fromSeatId, `L2 熔断：${target} 连续被打 ${this.consecutiveHits} 次，暂停新的 L2`);
      return INTERRUPT_REJECT.fused;
    }

    const usedThisTurn = this.l2PerTurn.get(target) ?? 0;
    if (usedThisTurn >= this.budget.perSeatPerTurn) {
      this.raiseFused(
        target,
        fromSeatId,
        `L2 预算：${target} 本轮已被打断 ${usedThisTurn} 次（上限 ${this.budget.perSeatPerTurn}）`,
      );
      return INTERRUPT_REJECT.perTurn;
    }

    const lastAt = this.lastL2AtByTarget.get(target);
    if (lastAt !== undefined && at - lastAt < this.budget.minIntervalMs) {
      this.raiseFused(
        target,
        fromSeatId,
        `L2 预算：距上次打断 ${target} 不足 ${this.budget.minIntervalMs}ms`,
      );
      return INTERRUPT_REJECT.minInterval;
    }

    this.pruneWindow(at);
    if (this.l2Window.length >= this.budget.globalMaxInWindow) {
      this.raiseFused(
        target,
        fromSeatId,
        `L2 预算：${this.budget.globalWindowMs}ms 滚动窗口内已达 ${this.budget.globalMaxInWindow} 次`,
      );
      return INTERRUPT_REJECT.globalWindow;
    }

    return null;
  }

  /** Bookkeeping for an accepted seat L2 (H5 windows + consecutive-hit fuse). */
  private recordSeatL2(target: string, fromSeatId: string | undefined): void {
    const at = this.now();
    this.l2Window.push(at);
    this.lastL2AtByTarget.set(target, at);
    this.l2PerTurn.set(target, (this.l2PerTurn.get(target) ?? 0) + 1);

    if (this.lastL2Target === target) {
      this.consecutiveHits++;
    } else {
      // 换目标 = 连续计数重置，对旧目标的熔断随之解除。
      this.lastL2Target = target;
      this.consecutiveHits = 1;
      this.fusedTarget = null;
    }
    if (this.consecutiveHits >= this.budget.consecutiveFuse) {
      this.fusedTarget = target;
      this.raiseFused(
        target,
        fromSeatId,
        `L2 熔断：${target} 连续被打 ${this.consecutiveHits} 次，暂停新的 L2`,
      );
    }
  }

  /** Run end of one seat: per-turn L2 budget restarts, a leftover stop flag cannot leak. */
  private endRun(seatId: string): void {
    this.l2PerTurn.delete(seatId);
    this.pendingStop.delete(seatId);
  }

  private pruneWindow(at: number): void {
    const oldest = at - this.budget.globalWindowMs;
    while (this.l2Window.length > 0 && this.l2Window[0]! <= oldest) {
      this.l2Window.shift();
    }
  }

  private raiseFused(target: string, fromSeatId: string | undefined, text: string): void {
    this.attention?.push({
      kind: "l2_fused",
      text,
      seatId: target,
      refId: fromSeatId,
    });
  }

  private publish(seatId: string, level: InterruptLevel): void {
    for (const handler of [...this.applyHandlers]) {
      handler(seatId, level);
    }
  }
}
