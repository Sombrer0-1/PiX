/**
 * TimelineLog - the roundtable's append-only timeline (dev plan §4.3, H41).
 *
 * Every recorded message is stored exactly once and never deleted: delivery
 * state (recorded / pending_inject / injected) belongs to SeatInbox, so this
 * module never writes `deliveryBySeat` and never calls a model. The facade
 * projects `deliveryBySeat` from `SeatInbox.snapshot()` when it emits a
 * TimelineItem over IPC.
 *
 * `append` assigns the monotonic `seq` that deliverables use as their cutoff,
 * and returns the stored record (a copy of the caller's input), so callers
 * cannot mutate what they passed in by accident.
 */

import type { TimelineItem, TimelineItemType } from "../../shared/team-types.js";

/** 入场摘要里列出的 id 上限（知识卡 + 各席最新一条）。 */
const JOIN_PACKET_MAX_INDEX = 40;

/** 入场摘要里单条记录的摘录长度；只给线索，不重放全文。 */
const JOIN_PACKET_EXCERPT_CHARS = 80;

/** 入场摘要里「最近记录」的条数。 */
const JOIN_PACKET_RECENT = 5;

/** 时间线过滤器。`threadId` 省略 = 全部；`null` = 仅主线（§4.3）。 */
export interface TimelineFilter {
  seatId?: string;
  type?: TimelineItemType;
  threadId?: string | null;
  q?: string;
}

/** 截断到 n 个字符，超出补省略号。 */
function excerpt(text: string, chars: number = JOIN_PACKET_EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= chars ? flat : `${flat.slice(0, chars)}…`;
}

/** 「发言 8 / 知识卡 2」这样的类型计数文本。 */
function formatTypeCounts(counts: Map<TimelineItemType, number>): string {
  if (counts.size === 0) {
    return "无";
  }
  return [...counts.entries()].map(([type, count]) => `${type} ${count}`).join("、");
}

export class TimelineLog {
  private readonly items: TimelineItem[] = [];
  private readonly byId = new Map<string, TimelineItem>();
  /**
   * 曾经用过的 id（含显式传入的与 `reserveIds` 预留的）。`byId` 只留最新一条的索引，
   * 不能代表「id 已用过」：重启后 replay 进来的 `m-N` 若被重新分配，就会与
   * inbox.json 里残留的 messageId 撞车，SeatInbox 按 messageId 去重 → 该席静默
   * 收不到那条消息。
   */
  private readonly usedIds = new Set<string>();
  private readonly appendListeners = new Set<(item: TimelineItem) => void>();
  private seqCounter = 0;
  private generatedIdCounter = 0;

  /**
   * 追加一条已记录消息，返回带 seq 的副本（该副本就是日志里的那条记录）。
   * `id` 省略时自动生成；`mentionIds` 省略视为 []（H41）。永不删除原文。
   */
  append(input: Omit<TimelineItem, "seq" | "id"> & { id?: string; seq?: never }): TimelineItem {
    const seq = this.seqCounter + 1;
    this.seqCounter = seq;
    const id = input.id !== undefined && input.id.length > 0 ? input.id : this.nextGeneratedId();
    const item: TimelineItem = {
      ...input,
      id,
      seq,
      mentionIds: Array.isArray(input.mentionIds) ? [...input.mentionIds] : [],
    };
    this.items.push(item);
    // 重复 id 保留最新一条的索引；原文都留在 items 里，不删（§4.3）。
    this.byId.set(id, item);
    this.usedIds.add(id);
    // 同步广播：落盘/发事件由订阅方负责（本模块不碰 persistence 与 IPC）。
    for (const listener of [...this.appendListeners]) {
      listener(item);
    }
    return item;
  }

  /**
   * 订阅「有新记录写入」（落盘 + 发 `timeline_item` 的统一出口，FR-3
   * 「已记录 = 落盘成功」）。返回退订函数；订阅面与 `SeatInbox.onChange` 同形。
   */
  onAppend(cb: (item: TimelineItem) => void): () => void {
    this.appendListeners.add(cb);
    return () => {
      this.appendListeners.delete(cb);
    };
  }

  /**
   * 预留 id（只占位，不写日志、不广播、不进 byId）：占位的是「不在时间线里、但已经
   * 占用了 id 名称空间」的消息——inbox.json 里残留的 messageId 若没被 replay 回时间线
   * （时间线写失败过、或条目只在收件箱里），自增 id 会重新分配它，而
   * `SeatInbox.enqueue` 按 messageId 去重 → 该席静默收不到那条消息（F1-2）。
   * 调用方是恢复路径：facade 的 `_hydrateLastRoundtable` 在
   * `modules.inbox.restore(meta.inbox)` 之后把快照里的 messageId 传进来一次。
   * G3 接上落盘出口、恢复路径拿到收件箱快照之前，它是纯预留入口。
   */
  reserveIds(ids: Iterable<string>): void {
    for (const id of ids) {
      this.usedIds.add(id);
    }
  }

  /** 主线 + 线程；filter 只影响返回集，不改变日志。 */
  list(filter?: TimelineFilter): TimelineItem[] {
    if (filter === undefined) {
      return [...this.items];
    }
    const query = filter.q !== undefined ? filter.q.trim().toLowerCase() : "";
    return this.items.filter((item) => {
      if (filter.seatId !== undefined && !involvesSeat(item, filter.seatId)) {
        return false;
      }
      if (filter.type !== undefined && item.type !== filter.type) {
        return false;
      }
      if (filter.threadId !== undefined) {
        const threadId = item.threadId ?? null;
        if (threadId !== filter.threadId) {
          return false;
        }
      }
      if (query.length > 0 && !matchesQuery(item, query)) {
        return false;
      }
      return true;
    });
  }

  getById(id: string): TimelineItem | undefined {
    return this.byId.get(id);
  }

  /** 下一条 append 将使用的 seq。 */
  nextSeq(): number {
    return this.seqCounter + 1;
  }

  /** 已分配的最大 seq（交付物 cutoff）；空日志为 0。 */
  lastSeq(): number {
    return this.seqCounter;
  }

  /**
   * 新席入场：主线摘要文本 + 知识卡 / 关键结论 id 列表。
   * 只给计数、分布与截断摘录，不重放全文。
   */
  buildJoinPacket(): { summary: string; index: Array<{ id: string; title: string }> } {
    const mainLine = this.items.filter((item) => item.threadId === undefined);
    const typeCounts = new Map<TimelineItemType, number>();
    const perSeat = new Map<string, number>();
    for (const item of mainLine) {
      typeCounts.set(item.type, (typeCounts.get(item.type) ?? 0) + 1);
      perSeat.set(item.fromId, (perSeat.get(item.fromId) ?? 0) + 1);
    }

    const lines: string[] = [];
    lines.push(
      `主线 ${mainLine.length} 条记录（${formatTypeCounts(typeCounts)}），线程 ${this.items.length - mainLine.length} 条。`,
    );
    if (perSeat.size > 0) {
      const distribution = [...perSeat.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([fromId, count]) => `${fromId} ${count} 条`);
      lines.push(`发言分布：${distribution.join("；")}。`);
    }
    const recent = mainLine.slice(-JOIN_PACKET_RECENT);
    if (recent.length > 0) {
      lines.push("最近记录：");
      for (const item of recent) {
        lines.push(`- [${item.type}] ${item.fromId}: ${excerpt(item.summary || item.text) || "（无摘要）"}`);
      }
    }

    return { summary: lines.join("\n"), index: this.buildJoinIndex() };
  }

  /** 过载展示：只保留最新 visibleCap 条，其余折叠计数（原文仍可 getById）。 */
  overflowWindow(visibleCap: number): { collapsed: number; items: TimelineItem[] } {
    const cap = Number.isFinite(visibleCap) ? Math.max(0, Math.floor(visibleCap)) : 0;
    if (this.items.length <= cap) {
      return { collapsed: 0, items: [...this.items] };
    }
    const start = this.items.length - cap;
    return { collapsed: start, items: this.items.slice(start) };
  }

  /**
   * 入场索引：知识卡（主线与线程都算结论）在前，然后是主线各席最新一条。
   * 标题截断，所以它不是全文重放。
   */
  private buildJoinIndex(): Array<{ id: string; title: string }> {
    const index: Array<{ id: string; title: string }> = [];
    const included = new Set<string>();
    const push = (item: TimelineItem, title: string): void => {
      if (included.has(item.id) || index.length >= JOIN_PACKET_MAX_INDEX) {
        return;
      }
      included.add(item.id);
      index.push({ id: item.id, title: excerpt(title) });
    };

    for (const item of this.items) {
      if (item.type !== "knowledge_card" && item.knowledgeCard === undefined) {
        continue;
      }
      push(item, item.knowledgeCard?.claim ?? (item.summary || item.text));
    }

    const latestBySeat = new Map<string, TimelineItem>();
    for (const item of this.items) {
      if (item.threadId !== undefined) {
        continue;
      }
      const previous = latestBySeat.get(item.fromId);
      if (previous === undefined || item.seq > previous.seq) {
        latestBySeat.set(item.fromId, item);
      }
    }
    for (const item of [...latestBySeat.values()].sort((a, b) => a.seq - b.seq)) {
      push(item, `[${item.fromId}] ${item.summary || item.text}`);
    }
    return index;
  }

  /** 自动 id：不与任何用过的 id 冲突（含 replay 回来的显式 id），日志内唯一。 */
  private nextGeneratedId(): string {
    let id: string;
    do {
      this.generatedIdCounter++;
      id = `m-${this.generatedIdCounter}`;
    } while (this.usedIds.has(id));
    return id;
  }
}

/** 该席参与过这条记录：发送方、接收方或被 @（H41）。 */
function involvesSeat(item: TimelineItem, seatId: string): boolean {
  if (item.fromId === seatId || item.toId === seatId) {
    return true;
  }
  if (item.mentionIds.includes(seatId)) {
    return true;
  }
  return item.privateStub?.toId === seatId;
}

/** 搜索：正文、摘录、知识卡的 claim 与 evidence 引用，大小写不敏感。 */
function matchesQuery(item: TimelineItem, query: string): boolean {
  const haystacks = [item.text, item.summary, item.knowledgeCard?.claim ?? ""];
  for (const evidence of item.knowledgeCard?.evidence ?? []) {
    haystacks.push(evidence.ref, evidence.excerpt ?? "");
  }
  return haystacks.some((value) => value.toLowerCase().includes(query));
}
