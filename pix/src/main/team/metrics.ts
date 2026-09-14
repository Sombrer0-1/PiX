/**
 * RoundtableMetrics —— 成本与讨论体检 + 用户自设阈值（dev plan §3.3 / §4.9 /
 * FR-10，H17 / H18 / H19 / H20 / H43 / H44 / AC-11 / AC-22）。
 *
 * 成本口径（H17）：各席 `AgentSession.getSessionStats()` 相加 + 辅助 session
 * 用量。**不含 host SessionBridge 的空转用量**——host 不跑讨论 turn，不是参与者。
 *
 * 阈值行为（默认全关，H9）：
 * - 软预算（H19）：到达只发 Attention `soft_budget`，**不拒绝发言、不锁定、不终止**。
 * - 整理建议（H18）：`suggestWrapUp` 开启时，连续 10 分钟既无新 knowledge_card 也
 *   没有 `claimKind:"evidenced"` 的发言 → Attention `wrap_up_ready`。主信号是
 *   「证据停止流入」而不是「最近几条没有知识卡」。
 * - 硬停止：仅 `hardStop.enabled` 时生效 → Attention `hard_stop` + 回调（facade 暂停）。
 * - 无人值守保护（H20）：过了软预算 → 降速（席位 prompt 空闲至少 15s，H43）
 *   → 只探索不整理（`isWrapUpAllowed()` false，拒绝 request_wrap_up）
 *   → 再过同一软预算 1× 则暂停。硬停止仍只在 hardStop.enabled 时生效。
 */

import {
  USER_SEAT_ID,
  type AttentionItem,
  type RoundtableLifecycle,
  type RoundtableMetricsSnapshot,
  type RoundtableSettings,
  type TimelineItem,
} from "../../shared/team-types.js";

/** 无人值守降速：两次席位 prompt 之间至少空闲这么久（H20 / H43）。 */
export const UNATTENDED_MIN_IDLE_MS = 15_000;

/** 整理建议的静默窗口（H18：连续 10 分钟没有新证据）。 */
export const WRAP_UP_QUIET_MS = 10 * 60_000;

/** 默认评估间隔（时长类阈值需要定时看；事件发生时也会立即评估）。 */
export const METRICS_EVALUATE_INTERVAL_MS = 30_000;

/** 时间线里算「发言」的类型（system / private_stub 不算发言）。 */
const UTTERANCE_TYPES = new Set<TimelineItem["type"]>([
  "utterance",
  "knowledge_card",
  "question",
  "challenge",
  "thread_promo",
]);

/** 本模块需要的 session 用量面（与 §4.13 SeatSessionLike.getSessionStats 同形）。 */
export interface MetricsSessionStats {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost: number;
}

/** 一个席位的用量来源。 */
export interface MetricsSeatRuntime {
  seatId: string;
  getSessionStats(): MetricsSessionStats;
  /** 该席累计「运行中」时长（facade 记 turn 起止；缺省 0）。 */
  durationMs(): number;
}

/** 注意力面最小结构视图（H44），与 interrupt / health 的 sink 同形。 */
export interface MetricsAttentionSink {
  push(item: { kind: AttentionItem["kind"]; text: string; seatId?: string; refId?: string }): unknown;
}

export interface RoundtableMetricsDeps {
  getSeats: () => MetricsSeatRuntime[];
  getTimeline: () => TimelineItem[];
  getSettings: () => RoundtableSettings;
  getLifecycle: () => RoundtableLifecycle;
  getCreatedAt: () => number;
  /** 辅助 session（整理）用量；未在跑时返回 null。 */
  getAuxStats?: () => MetricsSessionStats | null;
  attention?: MetricsAttentionSink;
  now?: () => number;
  /** 无人值守第三段：facade 在此暂停整场（禁一切团队模型调用）。 */
  onPauseRequested?: (reason: string) => void;
  /** 硬停止：facade 在此停一切团队模型调用（整理许可由 hardStop.allowWrapUpOnStop 决定）。 */
  onHardStop?: (reason: string) => void;
  /**
   * 阈值口径（软预算 / 硬停止）：崩溃恢复后必须含落盘基线。缺省用 live snapshot。
   * 展示走 facade 的 mergeMetrics；evaluate 必须用同一套 totals，否则 UI 已消耗
   * 的成本和时长阈值仍从 0 计。
   */
  getThresholdTotals?: () => { cost: number; durationMs: number };
  intervalMs?: number;
}

/** 阈值状态机的段位：0 正常 / 1 降速 / 2 只探索 / 3 暂停。 */
export type UnattendedStage = 0 | 1 | 2 | 3;

export class RoundtableMetrics {
  private readonly deps: RoundtableMetricsDeps;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** 软预算只提示一次（回到预算内再跨过会重新提示）。 */
  private softBudgetNotified = false;
  /** 硬停止只触发一次。 */
  private hardStopFired = false;
  /** 整理建议每个静默窗口只提一次（新证据出现后重置）。 */
  private wrapUpSuggested = false;
  /** 无人值守 pauses 只触发一次。 */
  private unattendedPaused = false;

  constructor(deps: RoundtableMetricsDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.intervalMs = deps.intervalMs ?? METRICS_EVALUATE_INTERVAL_MS;
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      this.evaluate();
    }, this.intervalMs);
    // 定时器不应该拖住进程退出。
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ------------------------------------------------------------------ 投影 --

  /** 当前快照（per-seat + totals + health 三指标）。 */
  snapshot(): RoundtableMetricsSnapshot {
    const perSeat: RoundtableMetricsSnapshot["perSeat"] = {};
    const timeline = this.deps.getTimeline();
    const utterancesBySeat = countUtterances(timeline);

    let totalUtterances = 0;
    let tokens = 0;
    let cost = 0;
    let durationMs = 0;
    for (const seat of this.deps.getSeats()) {
      const stats = safeStats(seat);
      const utterances = utterancesBySeat.get(seat.seatId) ?? 0;
      const seatDuration = Math.max(0, seat.durationMs());
      perSeat[seat.seatId] = {
        utterances,
        tokensIn: stats.tokens.input,
        tokensOut: stats.tokens.output,
        cost: stats.cost,
        durationMs: seatDuration,
      };
      totalUtterances += utterances;
      tokens += stats.tokens.input + stats.tokens.output;
      cost += stats.cost;
      durationMs += seatDuration;
    }

    // H17：辅助整理 session 计入团队成本；host 空转不算（host 根本不是席位）。
    const aux = this.deps.getAuxStats?.() ?? null;
    if (aux !== null) {
      tokens += aux.tokens.input + aux.tokens.output;
      cost += aux.cost;
    }

    const speakShare: Record<string, number> = {};
    for (const [seatId, utterances] of utterancesBySeat) {
      speakShare[seatId] = totalUtterances > 0 ? utterances / totalUtterances : 0;
    }

    const evidenceUtterances = countEvidence(timeline);
    const interrupts = countInterrupts(timeline);

    return {
      perSeat,
      totals: { utterances: totalUtterances, tokens, cost, durationMs },
      health: {
        speakShare,
        evidenceDensity: totalUtterances > 0 ? evidenceUtterances / totalUtterances : 0,
        interruptRate: totalUtterances > 0 ? interrupts / totalUtterances : 0,
      },
    };
  }

  /**
   * 当前总成本（USD）与「累计活跃时长」（ms）。
   *
   * F4-4：阈值口径必须是各席 `agent_start→agent_end` 的累计活跃时长，不能用墙钟
   * `now - createdAt`——墙钟包含暂停与关机，恢复后第一次 evaluate 就会立刻命中
   * 时间类阈值并消耗一次性 `hardStopFired` 闩锁，用户 resume 后再也拿不到硬停止
   * （AC-11 安全阀失效）。`getCreatedAt` 仍用于展示口径（证据静默的起点）。
   */
  totals(): { cost: number; durationMs: number } {
    if (this.deps.getThresholdTotals !== undefined) {
      const merged = this.deps.getThresholdTotals();
      return { cost: Math.max(0, merged.cost), durationMs: Math.max(0, merged.durationMs) };
    }
    const snapshot = this.snapshot();
    return { cost: snapshot.totals.cost, durationMs: Math.max(0, snapshot.totals.durationMs) };
  }

  // ------------------------------------------------- 阈值：软/硬/建议/保护 --

  /**
   * 评估所有用户自设阈值并（必要时）发注意力。可重复调用；每种提示只在其
   * 条件**首次成立**时发一次，条件回到正常后再跨过会重新提示。
   *
   * F4-4：`paused` 时不判定时间类阈值（累计活跃时长在暂停期间不增长，判定它
   * 只会在恢复瞬间误触发），成本类照常判定。
   */
  evaluate(): void {
    const settings = this.deps.getSettings();
    const lifecycle = this.deps.getLifecycle();
    if (lifecycle !== "active" && lifecycle !== "paused") {
      return;
    }
    const paused = lifecycle === "paused";

    const ratio = this.budgetRatio(paused);

    // H19 软预算：只提示。
    if (ratio !== null && ratio >= 1) {
      if (!this.softBudgetNotified) {
        this.softBudgetNotified = true;
        this.raise(
          "soft_budget",
          `已达软预算（成本 ${formatUsd(this.totals().cost)}，时长 ${formatMinutes(this.totals().durationMs)}）：仅提示，不拒绝发言、不锁定、不终止。`,
        );
      }
    } else if (ratio !== null && ratio < 1) {
      this.softBudgetNotified = false;
    }

    // H20 无人值守保护（只影响降速/整理/暂停，不改讨论内容）。
    const nextStage = this.computeStage(settings, ratio);
    if (settings.unattendedGuard && nextStage >= 3 && !this.unattendedPaused) {
      this.unattendedPaused = true;
      this.raise(
        "soft_budget",
        "无人值守保护：软预算再次翻倍（只探索阶段之后仍未收敛），暂停整场：不再发起任何团队模型调用。",
      );
      this.deps.onPauseRequested?.("unattended_guard");
    }

    // 硬停止：仅用户显式开启时生效（默认关，且开场已告知）。
    const hardStop = settings.hardStop;
    if (hardStop !== undefined && hardStop.enabled && !this.hardStopFired && this.hardStopReached(hardStop, paused)) {
      this.hardStopFired = true;
      const allowWrapUp = hardStop.allowWrapUpOnStop ? "已授权停止后整理一次" : "未授权停止后整理";
      this.raise(
        "hard_stop",
        `已达硬停止条件（${allowWrapUp}）：停止一切团队模型调用。`,
      );
      this.deps.onHardStop?.("hard_stop");
    }

    // H18 整理建议：证据停止流入（10 分钟内无新知识卡、也无 evidenced 发言）。
    if (settings.suggestWrapUp) {
      const quietSince = this.lastEvidenceAt();
      const quietMs = this.now() - quietSince;
      if (quietMs >= WRAP_UP_QUIET_MS) {
        if (!this.wrapUpSuggested) {
          this.wrapUpSuggested = true;
          this.raise(
            "wrap_up_ready",
            `已连续 ${formatMinutes(quietMs)} 没有新的知识卡或带依据的发言：可以整理一版交付物（不强制，讨论可继续）。`,
          );
        }
      } else {
        this.wrapUpSuggested = false;
      }
    }
  }

  /** H20/H43：>0 时 SeatRunner 两次 prompt 至少间隔该值；未启用保护时为 0。 */
  getMinIdleMs(): number {
    const settings = this.deps.getSettings();
    if (!settings.unattendedGuard) {
      return 0;
    }
    if (this.computeStage(settings, this.budgetRatio()) >= 1) {
      return UNATTENDED_MIN_IDLE_MS;
    }
    return 0;
  }

  /** 无人值守「只探索不整理」：true 时 facade 拒绝 `request_wrap_up`（H20 / §4.12c）。 */
  isWrapUpAllowed(): boolean {
    const settings = this.deps.getSettings();
    if (!settings.unattendedGuard) {
      return true;
    }
    return this.computeStage(settings, this.budgetRatio()) < 2;
  }

  /** 当前无人值守段位（测试与 UI）。 */
  unattendedStage(): UnattendedStage {
    return this.computeStage(this.deps.getSettings(), this.budgetRatio());
  }

  // ------------------------------------------------------------------ 内部 --

  /**
   * 软预算比：1 = 正好到达；未设软预算时 null。
   * `skipDuration`（F4-4）：暂停时不判定时间类阈值，只留成本类。
   */
  private budgetRatio(skipDuration = false): number | null {
    const soft = this.deps.getSettings().softBudget;
    if (soft === undefined) {
      return null;
    }
    const { cost, durationMs } = this.totals();
    let ratio = -1;
    if (soft.maxCostUsd !== undefined && soft.maxCostUsd > 0) {
      ratio = Math.max(ratio, cost / soft.maxCostUsd);
    }
    if (!skipDuration && soft.maxDurationMs !== undefined && soft.maxDurationMs > 0) {
      ratio = Math.max(ratio, durationMs / soft.maxDurationMs);
    }
    return ratio < 0 ? null : ratio;
  }

  /** 段位：>=1 降速 / >=2 只探索（拒绝整理）/ >=3 暂停；保护关时恒 0。 */
  private computeStage(settings: RoundtableSettings, ratio: number | null): UnattendedStage {
    if (!settings.unattendedGuard || ratio === null || ratio < 1) {
      return 0;
    }
    if (ratio >= 3) {
      return 3;
    }
    if (ratio >= 2) {
      return 2;
    }
    return 1;
  }

  /** 硬停止条件；`skipDuration`（F4-4）：暂停时只看成本类。 */
  private hardStopReached(
    hardStop: NonNullable<RoundtableSettings["hardStop"]>,
    skipDuration = false,
  ): boolean {
    const { cost, durationMs } = this.totals();
    if (hardStop.maxCostUsd !== undefined && hardStop.maxCostUsd > 0 && cost >= hardStop.maxCostUsd) {
      return true;
    }
    if (
      !skipDuration &&
      hardStop.maxDurationMs !== undefined &&
      hardStop.maxDurationMs > 0 &&
      durationMs >= hardStop.maxDurationMs
    ) {
      return true;
    }
    return false;
  }

  /** 最后一次「证据流入」的时间：新知识卡或 `claimKind:"evidenced"` 的发言。 */
  private lastEvidenceAt(): number {
    let latest = this.deps.getCreatedAt();
    for (const item of this.deps.getTimeline()) {
      if (item.type === "knowledge_card" || item.knowledgeCard?.claimKind === "evidenced") {
        latest = Math.max(latest, item.ts);
      }
    }
    return latest;
  }

  private raise(kind: AttentionItem["kind"], text: string): void {
    this.deps.attention?.push({ kind, text });
  }
}

/** 每个席位的公开发言条数（system / private_stub 不算）。 */
function countUtterances(timeline: TimelineItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of timeline) {
    if (item.fromId === USER_SEAT_ID || !UTTERANCE_TYPES.has(item.type)) {
      continue;
    }
    counts.set(item.fromId, (counts.get(item.fromId) ?? 0) + 1);
  }
  return counts;
}

/** 证据密度分子：知识卡，或带 `claimKind:"evidenced"` 依据的发言。 */
function countEvidence(timeline: TimelineItem[]): number {
  let count = 0;
  for (const item of timeline) {
    if (item.fromId === USER_SEAT_ID || !UTTERANCE_TYPES.has(item.type)) {
      continue;
    }
    if (item.type === "knowledge_card" || item.knowledgeCard?.claimKind === "evidenced") {
      count++;
    }
  }
  return count;
}

/** 打断率分子：L2 + L3（记在时间线条目上的请求等级）。 */
function countInterrupts(timeline: TimelineItem[]): number {
  let count = 0;
  for (const item of timeline) {
    if (item.interrupt === "L2" || item.interrupt === "L3") {
      count++;
    }
  }
  return count;
}

/** 席位的用量读取永不因 session 报错打断体检（§5.14：异常不终止讨论）。 */
function safeStats(seat: MetricsSeatRuntime): MetricsSessionStats {
  try {
    const stats = seat.getSessionStats();
    return {
      tokens: {
        input: numberOrZero(stats.tokens?.input),
        output: numberOrZero(stats.tokens?.output),
        cacheRead: numberOrZero(stats.tokens?.cacheRead),
        cacheWrite: numberOrZero(stats.tokens?.cacheWrite),
      },
      cost: numberOrZero(stats.cost),
    };
  } catch {
    return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatUsd(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

function formatMinutes(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))} 分钟`;
}
