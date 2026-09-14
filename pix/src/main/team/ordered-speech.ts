/**
 * OrderedSpeechGate —— 有序模式的长论证排队（dev plan §4.5 / §5.15，H3 / H4 / H27 / H28 / H41）。
 *
 * 有序模式打开后**只有** `utteranceKind: "argument"` 进队列：`admit` 立即返回
 * `{ ok: false, queued: true, waitMs, position }`，绝不阻塞 `send_team_message`。
 * 调用方仍须先 `timeline.append`（已记录），放行时 `onReleased` 才 inbox + L1（H28）；
 * 知识卡 / 短补充 / 提问 / 探索回灌 / 用户消息一律直接放行（H3）。
 *
 * 权威源是 `RoundtableSettings.orderedMode`：本类只经构造注入的 getter 读取，自己
 * **不存** `enabled`（H27）。关掉有序模式时 facade 调 `reset()` 按排队键放行等待中的
 * argument（投递零丢失）并清掉 `waiting_turn`（§5.15）。
 *
 * 排队键（计划锁定，H41 读 `mentionIds`）：被 @ 的席位的响应优先 → `now - lastSpokeAt`
 * 最大 → 先到先发（无内容评判）。每条排队项在 `orderedReleaseMs` 后自动放行（H4 的
 * 可感知上限）；同一时刻到期的多条按排队键依次放行。`now` 可注入，测试改时钟即可，
 * 不需要真的等。
 */

import type { UtteranceKind } from "../../shared/team-types.js";

/** `admit` 的入参（H41：mentionIds 必填，可空数组）。 */
export interface OrderedSpeechAdmitInput {
  messageId: string;
  fromId: string;
  utteranceKind: UtteranceKind;
  mentionIds: string[];
}

export type OrderedSpeechAdmitResult =
  | { ok: true }
  | { ok: false; queued: true; waitMs: number; position: number };

/** 队列投影（facade 据此投影 `waiting_turn`：谁在等、排第几、还要等多久）。 */
export interface OrderedSpeechWaitingEntry {
  messageId: string;
  seatId: string;
  /** 1 起算；1 = 下一个放行。 */
  position: number;
  /** 距该条自动放行还剩多少毫秒（H4 上限的剩余量）。 */
  waitMs: number;
}

/** 队列里的一条待放行 argument。 */
interface QueuedArgument {
  messageId: string;
  fromId: string;
  /**
   * 入队那一刻该席正被 @（一次性消费，F2-4）：本条的排队首键。用完即弃，
   * 不让「被 @ 过」变成整场永久的队列优先权。
   */
  respondsToMention: boolean;
  /** 入队序号（FIFO 兜底键）。 */
  arrival: number;
  /** 该条自己的自动放行截止时间（H4）。 */
  deadline: number;
}

export class OrderedSpeechGate {
  private readonly getEnabled: () => boolean;
  private readonly getReleaseMs: () => number;
  private readonly getLastSpokeAt: (seatId: string) => number | undefined;
  private readonly now: () => number;

  private readonly queue: QueuedArgument[] = [];
  private readonly listeners = new Set<(messageId: string, fromId: string) => void>();
  /**
   * 被 @ 过、还没用掉优先权的席位（H41 有序首键读 mentionIds）。只在有序模式 + argument
   * 时登记，且在该席下一次入队时一次性消费（F2-4），`reset()` 清空。
   */
  private readonly mentionedSeats = new Set<string>();
  private arrival = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    getEnabled: () => boolean,
    getReleaseMs: () => number,
    getLastSpokeAt: (seatId: string) => number | undefined = () => undefined,
    now: () => number = () => Date.now(),
  ) {
    this.getEnabled = getEnabled;
    this.getReleaseMs = getReleaseMs;
    this.getLastSpokeAt = getLastSpokeAt;
    this.now = now;
  }

  /**
   * 收下一条发言。有序模式开且 kind 为 `argument` → 入队并**立即**返回
   * `{ ok: false, queued: true, waitMs, position }`（H28：不阻塞、不改投递态，调用方
   * 仍须先 append 时间线）；其它 kind / 有序模式关 → `{ ok: true }`（直接投递）。
   * `mentionIds` 里的席位标记为「被 @」——它自己随后排队的 argument 因此优先放行
   * 一次（F2-4：只在有序模式 + argument 时记录，且入队即消费）。
   */
  admit(item: OrderedSpeechAdmitInput): OrderedSpeechAdmitResult {
    if (!this.getEnabled() || item.utteranceKind !== "argument") {
      return { ok: true };
    }
    for (const seatId of item.mentionIds) {
      this.mentionedSeats.add(seatId);
    }
    const at = this.now();
    const releaseMs = Math.max(0, this.getReleaseMs());
    // 已经到期的先放行：位置与剩余等待按放行后的队列算。
    this.releaseDue(at);
    // 一次性消费：本条入队时用掉本席的「被 @」标记，下一条回到普通排队键。
    const respondsToMention = this.mentionedSeats.delete(item.fromId);
    const entry: QueuedArgument = {
      messageId: item.messageId,
      fromId: item.fromId,
      respondsToMention,
      arrival: ++this.arrival,
      deadline: at + releaseMs,
    };
    this.queue.push(entry);
    this.armTimer(at);
    const position = this.ordered(at).findIndex((candidate) => candidate.messageId === entry.messageId);
    return {
      ok: false,
      queued: true,
      waitMs: Math.max(0, entry.deadline - at),
      position: position < 0 ? this.queue.length : position + 1,
    };
  }

  /** 放行订阅（facade 在此 inbox.enqueue + L1 + 清 waiting_turn）。返回退订函数。 */
  onReleased(cb: (messageId: string, fromId: string) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** 当前等待队列，按排队键排序（`position: 1` 是下一个放行的）。 */
  waiting(): OrderedSpeechWaitingEntry[] {
    const at = this.now();
    return this.ordered(at).map((entry, index) => ({
      messageId: entry.messageId,
      seatId: entry.fromId,
      position: index + 1,
      waitMs: Math.max(0, entry.deadline - at),
    }));
  }

  /** 某席是否正在等待发言（facade 投影 `waiting_turn` 用）。 */
  isWaiting(seatId: string): boolean {
    return this.queue.some((entry) => entry.fromId === seatId);
  }

  /** 当前排队条数。 */
  size(): number {
    return this.queue.length;
  }

  /**
   * 关掉有序模式时调用（§5.15「等待发言状态消失」）：按排队键依次放行所有仍在等待的
   * argument，`onReleased` → inbox + L1（投递零丢失）；原文早就在时间线里。
   * 同时清空 `mentionedSeats`（F2-4：关模式即失效，重开不继承旧的 @ 优先）。
   */
  reset(): void {
    const at = this.now();
    this.mentionedSeats.clear();
    for (const entry of this.ordered(at)) {
      const index = this.queue.indexOf(entry);
      if (index >= 0) {
        this.queue.splice(index, 1);
      }
      this.notify(entry);
    }
    this.armTimer(at);
  }

  /** 到点的按排队键依次放行（H4：每条等待不超过 orderedReleaseMs）。 */
  private releaseDue(at: number): void {
    for (const entry of this.ordered(at)) {
      if (entry.deadline > at) {
        continue;
      }
      const index = this.queue.indexOf(entry);
      if (index >= 0) {
        this.queue.splice(index, 1);
      }
      this.notify(entry);
    }
    this.armTimer(at);
  }

  private notify(entry: QueuedArgument): void {
    for (const listener of [...this.listeners]) {
      listener(entry.messageId, entry.fromId);
    }
  }

  /** 排队键：入队时被 @ 的席位优先 → 最久未发言优先 → 先到先发。 */
  private ordered(at: number): QueuedArgument[] {
    return [...this.queue].sort((a, b) => {
      const mentionRank = Number(b.respondsToMention) - Number(a.respondsToMention);
      if (mentionRank !== 0) {
        return mentionRank;
      }
      const silenceA = at - (this.getLastSpokeAt(a.fromId) ?? 0);
      const silenceB = at - (this.getLastSpokeAt(b.fromId) ?? 0);
      if (silenceA !== silenceB) {
        return silenceB - silenceA;
      }
      return a.arrival - b.arrival;
    });
  }

  /** 定时器只负责「到点放行」；延时按注入时钟算，排队定时器不拖住进程退出。 */
  private armTimer(at: number): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) {
      return;
    }
    const earliest = this.queue.reduce((min, entry) => Math.min(min, entry.deadline), Number.POSITIVE_INFINITY);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.releaseDue(this.now());
    }, Math.max(0, earliest - at));
    this.timer.unref?.();
  }
}
