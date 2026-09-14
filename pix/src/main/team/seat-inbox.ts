/**
 * SeatInbox - per-seat delivery state machine (dev plan §4.4, H7 / H21 / H36 / H37 / H41 / H42).
 *
 * 三态：recorded（只在时间线）→ pending_inject（已在收件箱等待该席下一次模型
 * 调用）→ injected（已进入某次模型请求）。本模块是唯一把条目标成 injected 的
 * 地方：`packForNextCall` 只挑选，`commitInjected` 才改状态。
 *
 * 私密消息的正文只在 `InboxEntry.text` 里（H36）。时间线上的 private_stub 文本
 * 保持空串，所以调用方 enqueue 时必须传入带正文的那一份副本：
 *
 *   const stub = timeline.append({ ... , type: "private_stub", text: "" });
 *   inbox.enqueue({ ...stub, text: body }, [toId]);
 *
 * `parseMentions` 是 H21 `@` 解析的唯一实现；S3 的 SeatRunner 从这里导入，
 * 不要在 seat-runner.ts 里再写一份。
 */

import {
  USER_SEAT_ID,
  type InboxEntry,
  type PackedContext,
  type SeatInfo,
  type TimelineItem,
} from "../../shared/team-types.js";
import { MAX_PENDING_INJECT_PER_SEAT, OVERFLOW_SUMMARY_MAX_LINES } from "./constants.js";
import { parseSeatId } from "./ids.js";

/** 注入优先级：user > mention > normal（§4.4 步骤 2）。 */
const PRIORITY_RANK: Record<InboxEntry["priority"], number> = {
  user: 0,
  mention: 1,
  normal: 2,
};

/** packed 摘要行里每条被省略消息的摘录长度。 */
const OVERFLOW_EXCERPT_CHARS = 80;

/** 折叠摘要是合成的收件箱条目，用这个前缀与时间线 id 区分。 */
const FOLD_SUMMARY_PREFIX = "fold:";

/** 每次 packForNextCall 的 callId 都不同（进程内单调）。 */
let callCounter = 0;

/**
 * H21 `@` 解析：独立 token，`@user` / `@用户` → USER_SEAT_ID；否则大小写不敏感
 * 匹配展示名或 seatId 的 slug 段。未匹配的 `@foo` 当普通文本，不产生任何 id。
 * 结果去重，按首次出现顺序返回。
 */
export function parseMentions(text: string, roster: SeatInfo[]): string[] {
  // 每次调用新建正则：带 /g 的模块级正则会在 matchAll 之间残留 lastIndex。
  const pattern = /@([\p{L}\p{N}_-]+)/gu;

  const byHandle = new Map<string, string>();
  for (const seat of roster) {
    addHandle(byHandle, seat.name, seat.seatId);
    addHandle(byHandle, seat.slug, seat.seatId);
    const parsed = parseSeatId(seat.seatId);
    if (parsed !== null) {
      addHandle(byHandle, parsed.slug, seat.seatId);
    }
  }

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const handle = (match[1] ?? "").toLowerCase();
    if (handle.length === 0) {
      continue;
    }
    const target = handle === "user" || handle === "用户" ? USER_SEAT_ID : byHandle.get(handle);
    if (target === undefined || seen.has(target)) {
      continue;
    }
    seen.add(target);
    resolved.push(target);
  }
  return resolved;
}

/** 注册一个 handle（大小写不敏感）。先注册的席位优先，重复注册不覆盖。 */
function addHandle(byHandle: Map<string, string>, handle: string | undefined, seatId: string): void {
  if (handle === undefined) {
    return;
  }
  const key = handle.trim().toLowerCase();
  if (key.length === 0 || byHandle.has(key)) {
    return;
  }
  byHandle.set(key, seatId);
}

/** H6：按字符/4 估算 token，向上取整。 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 该条消息是否算「用户消息」（优先级 user）。 */
function isUserMessage(item: TimelineItem): boolean {
  return item.fromId === USER_SEAT_ID || item.type === "user";
}

/** user > mention > normal，同级内时间从新到旧（§4.4 步骤 2）。 */
function orderForInjection(entries: InboxEntry[]): InboxEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const rank = PRIORITY_RANK[a.entry.priority] - PRIORITY_RANK[b.entry.priority];
      if (rank !== 0) {
        return rank;
      }
      if (a.entry.enqueuedAt !== b.entry.enqueuedAt) {
        return b.entry.enqueuedAt - a.entry.enqueuedAt;
      }
      // 同一毫秒：后进收件箱的算更新。
      return b.index - a.index;
    })
    .map((indexed) => indexed.entry);
}

export interface SeatInboxOptions {
  /**
   * 广播（targets 含 "*"）时用来展开「所有活跃席」（H1/§4.4：除发送方外）。
   * 不给则退化为收件箱已知的席位；facade 也可以直接传已解析好的 targets。
   */
  getActiveSeatIds?: () => string[];
}

export class SeatInbox {
  private readonly seats = new Map<string, InboxEntry[]>();
  private readonly listeners = new Set<(seatId: string) => void>();
  private readonly getActiveSeatIds?: () => string[];
  private foldCounter = 0;

  constructor(options?: SeatInboxOptions) {
    this.getActiveSeatIds = options?.getActiveSeatIds;
  }

  /**
   * 落盘后调用：每个目标席插入一条 pending_inject，正文拷进 InboxEntry.text。
   * "*" = 除发送方外的活跃席（H1）；发送方与 USER_SEAT_ID 永不进收件箱。
   * 含 mentionIds 的被点名席 priority="mention"，用户消息 priority="user"（H21/H41）。
   * 同一 messageId 在同一席只保留一条。
   */
  enqueue(item: TimelineItem, targets: string[]): void {
    const resolved = this.resolveTargets(item, targets);
    const touched: string[] = [];
    for (const seatId of resolved) {
      const entries = this.seatEntries(seatId);
      if (entries.some((entry) => entry.messageId === item.id)) {
        continue;
      }
      entries.push({
        messageId: item.id,
        seatId,
        state: "pending_inject",
        // 公开消息是 TimelineItem.text 的副本；私密消息这里是唯一落盘载体（H36）。
        text: item.text,
        enqueuedAt: Date.now(),
        priority: isUserMessage(item) ? "user" : item.mentionIds.includes(seatId) ? "mention" : "normal",
        // 来源随条目走：注入时必须能标出「谁说的」（F1-4 / H16 溯源）。
        fromId: item.fromId,
        type: item.type,
      });
      this.applyBackpressure(seatId);
      touched.push(seatId);
    }
    for (const seatId of touched) {
      this.notify(seatId);
    }
  }

  /**
   * 只挑选，不改 state（H37）：user > mention > normal，同级从新到旧，装不下的原文
   * 留 pending、最多贡献一行 summary。callId 每次都是新的。
   */
  packForNextCall(seatId: string, budgetTokens: number): PackedContext {
    const callId = `call-${++callCounter}`;
    const budget = Number.isFinite(budgetTokens) ? Math.max(0, budgetTokens) : 0;
    const ordered = orderForInjection(this.pending(seatId));

    const blocks: PackedContext["blocks"] = [];
    const injectedIds: string[] = [];
    const notFitting: InboxEntry[] = [];
    let usedTokens = 0;
    for (const entry of ordered) {
      const cost = estimateTokens(entry.text);
      if (usedTokens + cost <= budget) {
        usedTokens += cost;
        blocks.push({
          messageId: entry.messageId,
          text: entry.text,
          mode: "original",
          fromId: entry.fromId,
          type: entry.type,
        });
        injectedIds.push(entry.messageId);
        continue;
      }
      // 装不下：原文留 pending，本 call 只追加一行摘要（§4.4 步骤 4）。
      notFitting.push(entry);
    }
    if (notFitting.length > 0) {
      // 摘要块汇总多条，来源标签沿用触发溢出的那一条（块的 messageId 也是它）；
      // 私密条目只可能属于本席，标成私密会把同块里其它席的正文一起冒认成用户，
      // 所以这里退回「用户」标签——正文本身仍逐条列出各自的 messageId。
      const source = notFitting[0]!;
      // F2-2：摘要块也占预算。没有剩余预算就不发（原文仍 pending）；有剩余就按
      // 剩余预算截断，否则积压上千条时单次注入文本没有上界。
      const remaining = budget - usedTokens;
      if (remaining > 0) {
        const text = truncateToBudget(buildOverflowSummary(notFitting), remaining);
        usedTokens += estimateTokens(text);
        blocks.push({
          messageId: source.messageId,
          text,
          mode: "summary",
          fromId: source.fromId,
          type: source.type === "private_stub" ? "user" : source.type,
        });
      }
    }

    const injected = new Set(injectedIds);
    return {
      callId,
      blocks,
      injectedIds,
      // pack 不动状态，所以「没装进去的」就是此刻仍然 pending 的那些。
      stillPendingIds: ordered.filter((entry) => !injected.has(entry.messageId)).map((entry) => entry.messageId),
    };
  }

  /**
   * 唯一的 pending_inject → injected transition。仅在 prompt() / sendCustomMessage
   * 成功之后调用（H37）。没列进来的条目保持 pending_inject。
   */
  commitInjected(seatId: string, injectedIds: string[], callId: string): void {
    const entries = this.seats.get(seatId);
    if (entries === undefined || injectedIds.length === 0) {
      return;
    }
    const wanted = new Set(injectedIds);
    const now = Date.now();
    let changed = false;
    for (const entry of entries) {
      if (!wanted.has(entry.messageId) || entry.state !== "pending_inject") {
        continue;
      }
      entry.state = "injected";
      entry.injectedAt = now;
      entry.injectedInCallId = callId;
      changed = true;
    }
    if (changed) {
      this.notify(seatId);
    }
  }

  /** 订阅投递状态变化（enqueue / commitInjected）。返回退订函数（H42）。 */
  onChange(cb: (seatId: string) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * 恢复落盘的收件箱：已 injected 的 id 不得再当 pending，私密条目带 text 回来。
   * 同 (seatId, messageId) 只保留优先的一条；restore 不发 onChange（hydrate 时无 runner），
   * 也不做 H7 折叠（折叠只发生在 enqueue）。
   */
  restore(entries: InboxEntry[]): void {
    for (const entry of entries) {
      const seatEntries = this.seatEntries(entry.seatId);
      const existing = seatEntries.find((candidate) => candidate.messageId === entry.messageId);
      if (existing === undefined) {
        seatEntries.push(withSourceDefaults(entry));
        continue;
      }
      // 交付状态只能前进：已 injected 的 id 绝不回退成 pending（AC-12 / §4.10）。
      // folded 同理（F2-1）：折叠过的条目恢复后仍是 folded，不得重新变成 pending。
      if (existing.state !== "injected" && entry.state === "injected") {
        existing.state = "injected";
        existing.injectedAt = entry.injectedAt;
        existing.injectedInCallId = entry.injectedInCallId;
        continue;
      }
      if (existing.state === "pending_inject" && entry.state === "folded") {
        existing.state = "folded";
      }
    }
  }

  /** 全部席位的收件箱条目（落盘用），按席位与到达顺序。 */
  snapshot(): InboxEntry[] {
    const all: InboxEntry[] = [];
    for (const entries of this.seats.values()) {
      for (const entry of entries) {
        all.push({ ...entry });
      }
    }
    return all;
  }

  /** 某席仍待注入的条目，按到达顺序（旧 → 新）。 */
  pending(seatId: string): InboxEntry[] {
    const entries = this.seats.get(seatId);
    if (entries === undefined) {
      return [];
    }
    return entries.filter((entry) => entry.state === "pending_inject").map((entry) => ({ ...entry }));
  }

  /**
   * H7 背压：pending_inject 超过 MAX_PENDING_INJECT_PER_SEAT 时，把最旧的
   * 非用户、非 @ 原文合成一条 summary 仍待注入；时间线原文不删，用户/@ 永不折叠。
   * 被折叠的条目只改 state 为 `folded`（F2-1）：删条目会让 facade 的投递态 diff
   * 看不到这次变化，渲染层就永远停在「待注入」。
   */
  private applyBackpressure(seatId: string): void {
    const entries = this.seatEntries(seatId);
    const pendingCount = entries.filter((entry) => entry.state === "pending_inject").length;
    const excess = pendingCount - MAX_PENDING_INJECT_PER_SEAT;
    if (excess <= 0) {
      return;
    }
    const foldable = entries.filter(
      (entry) => entry.state === "pending_inject" && entry.priority === "normal",
    );
    // 折 k 条为 1 条，净减 k-1；k < 2 不解决超限。
    const foldCount = Math.min(excess + 1, foldable.length);
    if (foldCount < 2) {
      return;
    }
    const folded = foldable.slice(0, foldCount);
    const foldedIds = new Set(folded.map((entry) => entry.messageId));
    const summary = this.makeFoldSummary(seatId, folded);

    const next: InboxEntry[] = [];
    let inserted = false;
    for (const entry of entries) {
      if (foldedIds.has(entry.messageId)) {
        // 保留正文与位置，只把状态推进到 folded（可落盘、可审计、可恢复）。
        entry.state = "folded";
        if (!inserted) {
          next.push(summary);
          inserted = true;
        }
      }
      next.push(entry);
    }
    this.seats.set(seatId, next);
  }

  /** 折叠出的 summary 条目：仍是 pending_inject，priority=normal，正文是一行摘录集。 */
  private makeFoldSummary(seatId: string, folded: InboxEntry[]): InboxEntry {
    this.foldCounter++;
    const lines = folded.map((entry) => {
      const flat = entry.text.replace(/\s+/g, " ").trim();
      const body = flat.length <= OVERFLOW_EXCERPT_CHARS ? flat : `${flat.slice(0, OVERFLOW_EXCERPT_CHARS)}…`;
      return `- ${entry.messageId}: ${body || "（无正文）"}`;
    });
    return {
      // 合成条目没有时间线原文，用固定前缀避免与 messageId 撞车。
      messageId: `${FOLD_SUMMARY_PREFIX}${seatId}:${this.foldCounter}`,
      seatId,
      state: "pending_inject",
      text: [`（收件箱背压：${folded.length} 条较早的普通消息已折叠为摘要，原文见时间线）`, ...lines].join("\n"),
      // 沿用被折叠条目的最早时间，打包时的相对新旧顺序不变。
      enqueuedAt: folded[0]?.enqueuedAt ?? Date.now(),
      priority: "normal",
      // 折叠只发生在 priority=normal 的席位上，来源照抄最旧那条（摘要仍是席位文本）。
      fromId: folded[0]?.fromId ?? "unknown",
      type: folded[0]?.type ?? "system",
    };
  }

  /** 目标席解析：展开 "*"，去掉发送方与用户（用户不是 LLM 席位，没有收件箱）。 */
  private resolveTargets(item: TimelineItem, targets: string[]): string[] {
    const candidates = targets.length > 0 ? targets : [item.toId];
    const resolved: string[] = [];
    const seen = new Set<string>();
    const add = (seatId: string): void => {
      if (seatId.length === 0 || seatId === USER_SEAT_ID || seatId === item.fromId || seen.has(seatId)) {
        return;
      }
      seen.add(seatId);
      resolved.push(seatId);
    };
    for (const target of candidates) {
      if (target === "*") {
        for (const seatId of this.activeSeatIds()) {
          add(seatId);
        }
        continue;
      }
      add(target);
    }
    return resolved;
  }

  private activeSeatIds(): string[] {
    const active = this.getActiveSeatIds?.();
    return active ?? [...this.seats.keys()];
  }

  private seatEntries(seatId: string): InboxEntry[] {
    const existing = this.seats.get(seatId);
    if (existing !== undefined) {
      return existing;
    }
    const created: InboxEntry[] = [];
    this.seats.set(seatId, created);
    return created;
  }

  private notify(seatId: string): void {
    for (const listener of [...this.listeners]) {
      listener(seatId);
    }
  }
}

/**
 * 旧快照兜底（F1-4）：来源字段是后加的，旧 `inbox.json` 里没有；缺省成
 * 「未知发送方 + system」而不是缺字段，渲染层不必再判 undefined。
 */
function withSourceDefaults(entry: InboxEntry): InboxEntry {
  return {
    ...entry,
    fromId: typeof entry.fromId === "string" && entry.fromId.length > 0 ? entry.fromId : "unknown",
    type: entry.type ?? "system",
  };
}

/** 装不下的条目合成一行摘要（不进 injectedIds，原文仍 pending）。F2-2：行数有上限。 */
function buildOverflowSummary(entries: InboxEntry[]): string {
  const listed = entries.slice(0, OVERFLOW_SUMMARY_MAX_LINES);
  const lines = listed.map((entry) => {
    const flat = entry.text.replace(/\s+/g, " ").trim();
    const body = flat.length <= OVERFLOW_EXCERPT_CHARS ? flat : `${flat.slice(0, OVERFLOW_EXCERPT_CHARS)}…`;
    return `- ${entry.messageId}（${entry.priority}）：${body || "（无正文）"}`;
  });
  if (entries.length > listed.length) {
    lines.push(`- 另有 ${entries.length - listed.length} 条未列出（原文在时间线可查）`);
  }
  return [
    `以下 ${entries.length} 条超出本次上下文预算，仍待下次注入，原文在时间线可查：`,
    ...lines,
  ].join("\n");
}

/**
 * F2-2：把块文本压进 `remainingTokens` 预算。`estimateTokens` 是 ceil(len/4)，
 * 因此长度上限取 remainingTokens * 4 字符即可保证估算值不超过剩余预算。
 */
function truncateToBudget(text: string, remainingTokens: number): string {
  const maxChars = remainingTokens * 4;
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
