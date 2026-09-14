/**
 * OpenItemBoard —— 未决项黑板（dev plan §4.6b / FR-7 / §5.12）。
 *
 * 未决项 **不是任务**：没有派单、没有自动认领、没有完成 gate。任何人可以
 * 记一条、自愿认领一条、给出结论解决它，或者直接丢掉。席位退出时它已认领
 * 但未解决的项回到 open（`releaseOwned`，对应现网 releaseOwnedOpenTasks），
 * 别人可以接着做。
 */

import { randomUUID } from "crypto";
import type { OpenItem } from "../../shared/team-types.js";

export class OpenItemBoard {
  private readonly items = new Map<string, OpenItem>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** 记一条未决项（系统不分配、不排优先级）。 */
  open(input: { subject: string; body: string; createdBy: string }): OpenItem {
    const at = this.now();
    const item: OpenItem = {
      id: randomUUID(),
      subject: input.subject,
      body: input.body,
      status: "open",
      createdAt: at,
      updatedAt: at,
    };
    // createdBy 只用于审计；OpenItem 本体没有该字段（§4.2），这里不改形状。
    void input.createdBy;
    this.items.set(item.id, item);
    return { ...item };
  }

  /** 自愿认领（只有 open 可认领；已认领/已解决返回 null）。 */
  claim(id: string, seatId: string, note?: string): OpenItem | null {
    const item = this.items.get(id);
    if (item === undefined || item.status !== "open") {
      return null;
    }
    item.status = "claimed";
    item.claimedBy = seatId;
    if (note !== undefined && note.trim().length > 0) {
      item.claimNote = note.trim();
    }
    item.updatedAt = this.now();
    return { ...item };
  }

  /** 解决（open 或 claimed 都可以；已解决/已丢弃返回 null）；note 写入 body 末尾。 */
  resolve(id: string, seatId: string, note?: string): OpenItem | null {
    const item = this.items.get(id);
    if (item === undefined || item.status === "resolved" || item.status === "dropped") {
      return null;
    }
    item.status = "resolved";
    item.updatedAt = this.now();
    if (note !== undefined && note.trim().length > 0) {
      item.body = `${item.body}\n\n[${seatId} 结论] ${note.trim()}`;
    }
    return { ...item };
  }

  /** 丢弃（不再跟进）。 */
  drop(id: string): OpenItem | null {
    const item = this.items.get(id);
    if (item === undefined) {
      return null;
    }
    item.status = "dropped";
    item.updatedAt = this.now();
    return { ...item };
  }

  get(id: string): OpenItem | undefined {
    const item = this.items.get(id);
    return item === undefined ? undefined : { ...item };
  }

  /** 全部项，创建顺序。 */
  list(): OpenItem[] {
    return [...this.items.values()].map((item) => ({ ...item }));
  }

  /**
   * 该席认领但未解决的项回到 open（claimedBy 清空）。席位退出/被移除时调用
   * （§5.12：其它席的回合不受影响，项本身可以被别人接着做）。
   */
  releaseOwned(seatId: string): OpenItem[] {
    const released: OpenItem[] = [];
    for (const item of this.items.values()) {
      if (item.status !== "claimed" || item.claimedBy !== seatId) {
        continue;
      }
      item.status = "open";
      item.claimedBy = undefined;
      item.updatedAt = this.now();
      released.push({ ...item });
    }
    return released;
  }

  /** 崩溃恢复：用快照重建。 */
  restore(items: OpenItem[]): void {
    this.items.clear();
    for (const item of items) {
      this.items.set(item.id, { ...item });
    }
  }

  /** 落盘快照。 */
  snapshot(): OpenItem[] {
    return this.list();
  }
}
