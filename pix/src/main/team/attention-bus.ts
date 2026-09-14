/**
 * AttentionBus —— 用户注意力面（dev plan §4.6b / FR-8，H44）。
 *
 * 只收「用户必须看」的事件（被 @、权限、写冲突、席位异常/卡死、软预算、
 * 整理建议、硬停止、可取用的阶段稿、退出协商）。**不按观点质量过滤**，也不
 * 承担讨论内容的展示——普通发言留在时间线（§2.4）。
 *
 * 本类只存条目：推送、确认、列出、恢复。谁推什么由 H44 的生产者决定；facade
 * 负责把新条目落盘（attention.jsonl）并转发 `attention` 事件。
 */

import { randomUUID } from "crypto";
import type { AttentionItem } from "../../shared/team-types.js";

/** push 入参：id / ts / acked 由本类补齐（可显式给 id 做幂等）。 */
export type AttentionPushInput = Omit<AttentionItem, "id" | "ts" | "acked"> & {
  id?: string;
  ts?: number;
};

export class AttentionBus {
  private readonly items = new Map<string, AttentionItem>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** 追加一条注意力条目；未确认。重复 id 不覆盖已有条目。 */
  push(item: AttentionPushInput): AttentionItem {
    const id = item.id !== undefined && item.id.length > 0 ? item.id : randomUUID();
    const existing = this.items.get(id);
    if (existing !== undefined) {
      return { ...existing };
    }
    const created: AttentionItem = {
      id,
      ts: item.ts ?? this.now(),
      kind: item.kind,
      text: item.text,
      seatId: item.seatId,
      refId: item.refId,
      // F5-4：`action` 是显式构造的字段，这里不漏拷贝，否则「确认后 resume」的提示
      // 到了渲染层就成了普通提示，永远不触发恢复命令。
      action: item.action,
      acked: false,
    };
    this.items.set(id, created);
    return { ...created };
  }

  /** 用户确认（UI 点掉）。未知 id 是 no-op。 */
  ack(id: string): void {
    const item = this.items.get(id);
    if (item !== undefined) {
      item.acked = true;
    }
  }

  /** 按时间列出；`unackedOnly` 只回未确认的（注意力面默认视图）。 */
  list(unackedOnly = false): AttentionItem[] {
    const all = [...this.items.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    return (unackedOnly ? all.filter((item) => !item.acked) : all).map((item) => ({ ...item }));
  }

  /** 崩溃恢复：放回落盘的条目（保持 id / acked）。 */
  restore(items: AttentionItem[]): void {
    this.items.clear();
    for (const item of items) {
      this.items.set(item.id, { ...item });
    }
  }
}
