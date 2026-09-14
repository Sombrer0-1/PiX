/**
 * RoundtableHealth —— 席位卡死检查与分段续跑（plan §4.13 / §5.14，H44）。
 *
 * 只有**真卡死**才恢复：该席正在跑一个 run（`isRunning()`）且 `lastActiveAt`
 * 超过阈值。空闲等待（等用户、等轮次）不是卡死，讨论也不会被判「失败」——
 * 恢复动作是「中断这一次生成 + 标半成品 + 带收件箱重开」，讨论照常继续。
 *
 * 本类只做判定与调度：abort/prompt 全在 SeatRunner（唯一执行点，禁止第二条
 * abort 路径）。检查间隔与时钟可注入，测试不必真的等 30 分钟。
 */

import type { AttentionItem } from "../../shared/team-types.js";
import { STUCK_MS } from "./constants.js";
import type { SeatHealthProbe } from "./seat-runner.js";

/** 默认检查间隔：卡死阈值是分钟级，检查频率不需要更高。 */
const DEFAULT_INTERVAL_MS = 60_000;

/**
 * 单次恢复的上限（F4-2）：恢复动作本身会 abort 本次生成再带收件箱重开，
 * 若 `session.prompt` 永不返回（正是卡死那类），不设上限会让 `recovering`
 * 永久留在该席、该席被永久跳过。超时视为「未恢复」。
 */
const RECOVER_TIMEOUT_MS = 60_000;

/**
 * 注意力面的最小结构视图（H44 `seat_stuck`）。与 `interrupt.ts` 的 sink 同形，
 * 便于 S4 直接把 S2d 的 AttentionBus 传进来。
 */
export interface HealthAttentionSink {
  push(item: { kind: AttentionItem["kind"]; text: string; seatId?: string; refId?: string }): unknown;
}

export interface RoundtableHealthOptions {
  /** 时钟（测试注入）。 */
  now?: () => number;
  /** 检查间隔（ms）；可注入。 */
  intervalMs?: number;
  /** 覆盖每个探针自己的 stuckMs。 */
  stuckMs?: number;
  /** 单次恢复的上限（ms）；超时视为未恢复（F4-2）。 */
  recoverTimeoutMs?: number;
  attention?: HealthAttentionSink;
  /** 每次成功触发恢复后的回调（S4 可用来发 seat_status / 落盘）。 */
  onRecovered?: (seatId: string) => void;
}

export class RoundtableHealth {
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly stuckMsOverride: number | undefined;
  private readonly recoverTimeoutMs: number;
  private readonly attention: HealthAttentionSink | null;
  private readonly onRecovered: ((seatId: string) => void) | null;
  private readonly probes = new Map<string, SeatHealthProbe>();
  /** 正在恢复的席（防止一个恢复动作被同一个间隔重复触发）。 */
  private readonly recovering = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(options: RoundtableHealthOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.stuckMsOverride = options.stuckMs;
    this.recoverTimeoutMs = options.recoverTimeoutMs ?? RECOVER_TIMEOUT_MS;
    this.attention = options.attention ?? null;
    this.onRecovered = options.onRecovered ?? null;
  }

  registerSeat(probe: SeatHealthProbe): void {
    this.probes.set(probe.seatId, probe);
  }

  unregisterSeat(seatId: string): void {
    this.probes.delete(seatId);
    this.recovering.delete(seatId);
  }

  /** 幂等启动（重复调用不叠定时器）。 */
  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.checkNow();
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

  /**
   * 立即跑一轮（测试用；也用于 start() 的定时回调）。
   *
   * 各席的恢复**并行**执行（F4-2）：串行 await 会让一个永不返回的
   * `session.prompt` 把后面的席全部堵在恢复门口。
   */
  async checkNow(): Promise<void> {
    await Promise.all([...this.probes.values()].map((probe) => this.checkSeat(probe)));
  }

  private async checkSeat(probe: SeatHealthProbe): Promise<void> {
    if (this.recovering.has(probe.seatId)) {
      return;
    }
    // 空闲等待不是卡死：只有正在跑 run 且长时间没有任何事件才算。
    if (!probe.isRunning()) {
      return;
    }
    const threshold = this.stuckMsOverride ?? probe.stuckMs ?? STUCK_MS;
    const idleMs = this.now() - probe.lastActiveAt();
    if (idleMs < threshold) {
      return;
    }
    this.recovering.add(probe.seatId);
    try {
      const recovered = await this.recoverWithTimeout(probe);
      // F4-2：只有真的执行了恢复才推 seat_stuck / 调 onRecovered。`stopped` 的
      // 席位是 no-op（false）——按旧写法会推一条「已恢复」并把它标成 exploring，
      // 与 `lifecycle=paused` 自相矛盾。
      if (!recovered) {
        console.warn(`[RoundtableHealth] seat ${probe.seatId} recover did not run (stopped or timed out)`);
        return;
      }
      this.attention?.push({
        kind: "seat_stuck",
        seatId: probe.seatId,
        text: `席位 ${probe.seatId} 已 ${formatMinutes(idleMs)} 无任何活动，判定卡死：中断本次生成并带收件箱续跑。`,
      });
      this.onRecovered?.(probe.seatId);
    } catch {
      // 恢复失败不改判讨论：下一次检查会再试（席位仍是 running 才会命中）。
    } finally {
      this.recovering.delete(probe.seatId);
    }
  }

  /** 恢复动作的超时保护：超时（或不返回）视为未恢复，`recovering` 一定会被清掉。 */
  private async recoverWithTimeout(probe: SeatHealthProbe): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.recoverTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([probe.recover(), timeout]);
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }
}

function formatMinutes(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes} 分钟`;
}
