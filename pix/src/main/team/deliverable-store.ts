/**
 * DeliverableStore —— 版本化交付物（dev plan §4.9 / §5.9，AC-4 / AC-5 / AC-19）。
 *
 * 每次整理钉一个时间线截止点（`cutoffSeq`），出一个独立版本；截止点之后的新
 * 发现进下一版。**版本一旦有后继（更高版本 / `basedOnVersion` 指向它），它的
 * markdown 就不再被改写**：更新返回冲突与当前最新版本号，由调用方基于该版另开
 * 新版本（冲突对用户可见，AC-19）。同一最新版的多次修订（席位轮番改稿）按修订链
 * 记录，不静默丢失来源；并发修订用每版的 `revision` 做乐观 CAS（F2-3）：拿旧
 * revision 来的写入返回冲突与当前 revision，由调用方重投。
 *
 * 本类不产文本、不调用模型：正文由调用方（aux session 或指定席主笔）写好，
 * 经 `updateMarkdown` 写入。
 */

import { randomUUID } from "crypto";
import type { DeliverableVersion } from "../../shared/team-types.js";

/** 空 sections（新建版本时占位，主笔随后填）。 */
const EMPTY_SECTIONS: DeliverableVersion["sections"] = {
  conclusions: "",
  evidenceIndex: "",
  disagreements: "",
  nextActions: "",
  processIndex: "",
};

export interface DeliverableStoreOptions {
  /** 当前时间线最大 seq（钉截止点用；缺省 0）。 */
  getCutoffSeq: () => number;
  now?: () => number;
}

/** 一次修订记录（谁在什么时候把哪一版改到了第几修订），供 UI 展示修订链。 */
export interface DeliverableRevision {
  version: number;
  /** 写入后该版的 revision（成功一次 +1），CAS 的审计锚点。 */
  revision: number;
  actor: string;
  /** 本次写入的正文长度（只记长度，不存正文）。 */
  chars: number;
  at: number;
}

/** `updateMarkdown` 的结果：冲突时带上当前最新版本号与它的 revision，调用方据此重试。 */
export type UpdateMarkdownResult =
  | { ok: true }
  | { ok: false; conflict: true; currentVersion: number; currentRevision: number };

export class DeliverableStore {
  private readonly versions: DeliverableVersion[] = [];
  private readonly revisions: DeliverableRevision[] = [];
  private readonly getCutoffSeq: () => number;
  private readonly now: () => number;

  constructor(options: DeliverableStoreOptions) {
    this.getCutoffSeq = options.getCutoffSeq;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 新建一版：钉 `cutoffSeq = 当前 lastSeq`，`version = max+1`，状态 drafting。
   * 正文由主笔随后经 `updateMarkdown` 写入（写入后状态变 ready）。
   */
  create(input: { author: "system" | string; basedOnVersion?: number }): DeliverableVersion {
    const version = this.versions.reduce((max, current) => Math.max(max, current.version), 0) + 1;
    const deliverable: DeliverableVersion = {
      id: randomUUID(),
      version,
      // 修订计数从 1 起：调用方拿到的 revision 就是这一版的 CAS 令牌（F2-3）。
      revision: 1,
      cutoffSeq: Math.max(0, this.getCutoffSeq()),
      createdAt: this.now(),
      author: input.author,
      basedOnVersion: input.basedOnVersion,
      status: "drafting",
      markdown: "",
      stances: [],
      sections: { ...EMPTY_SECTIONS },
    };
    this.versions.push(deliverable);
    return clone(deliverable);
  }

  /**
   * 写入/修订正文。只在「该版仍是最新一版（没有后继版本）」时成功；已经有后继
   * 版本（`basedOnVersion` / 更高版本）时返回冲突与当前最新版本号，调用方必须
   * 基于该版另开新版本——已钉版本的 markdown 不再被改写（AC-19 / §4.9）。
   *
   * `expectedRevision` 是调用方读到的该版 revision（F2-3 乐观 CAS）：对最新版的
   * 并发修订，后写者不再是静默覆盖，而是拿到 `conflict` + 当前 `currentRevision`，
   * 必须基于新 revision 重投。缺省（`undefined`）只为内部路径保留。
   */
  updateMarkdown(
    id: string,
    markdown: string,
    actor: string,
    expectedRevision?: number,
  ): UpdateMarkdownResult {
    const target = this.versions.find((deliverable) => deliverable.id === id);
    const newest = this.newest();
    if (target === undefined || newest === undefined) {
      return {
        ok: false,
        conflict: true,
        currentVersion: newest?.version ?? 0,
        currentRevision: newest?.revision ?? 0,
      };
    }
    // 并发修订：先写者的 revision 已经前进，后写者必须基于新 revision 再来（AC-19）。
    if (expectedRevision !== undefined && target.revision !== expectedRevision) {
      return {
        ok: false,
        conflict: true,
        currentVersion: newest.version,
        currentRevision: newest.revision,
      };
    }
    // 已有 **ready** 后继：不能再改它。drafting 后继不挡住本版的首次 publish
    // （连点两次整理时先建的那版必须能写完），但会冻结已 ready 版本的再修订。
    const readySuccessor = this.versions.find(
      (deliverable) =>
        deliverable.id !== target.id &&
        deliverable.status === "ready" &&
        (deliverable.version > target.version || deliverable.basedOnVersion === target.version),
    );
    const draftingSuccessor = this.versions.find(
      (deliverable) =>
        deliverable.id !== target.id &&
        deliverable.status === "drafting" &&
        (deliverable.version > target.version || deliverable.basedOnVersion === target.version),
    );
    const firstPublish = target.status === "drafting";
    if (target.status === "superseded" || (!firstPublish && (readySuccessor !== undefined || draftingSuccessor !== undefined))) {
      return {
        ok: false,
        conflict: true,
        currentVersion: newest.version,
        currentRevision: newest.revision,
      };
    }
    target.markdown = markdown;
    target.revision = target.revision + 1;
    target.sections = fillSections(markdown, target.sections);
    // 首次 publish 时若已经有更高 version 的 ready，本版保存正文但标 superseded。
    target.status = firstPublish && readySuccessor !== undefined ? "superseded" : "ready";
    if (target.status === "ready") {
      for (const deliverable of this.versions) {
        if (deliverable.id !== target.id && deliverable.version < target.version && deliverable.status === "ready") {
          deliverable.status = "superseded";
        }
      }
    }
    this.revisions.push({
      version: target.version,
      revision: target.revision,
      actor,
      chars: markdown.length,
      at: this.now(),
    });
    return { ok: true };
  }

  /**
   * 席位表态（同一席重复表态覆盖上一次）。`stance: "absent"` 由整理收尾的调用方给
   * 未表态席位补缺席记录（§4.9「缺席席位 `stance: "absent"`」，UI / 移交据此区分
   * 「反对」与「没投」）。
   */
  setStance(
    id: string,
    seatId: string,
    stance: "support" | "oppose" | "conditional" | "absent",
    reason?: string,
    confidence?: "low" | "medium" | "high",
  ): { ok: true } | { ok: false; error: string } {
    const target = this.versions.find((deliverable) => deliverable.id === id);
    if (target === undefined) {
      return { ok: false, error: `交付物 ${id} 不存在。` };
    }
    const stances = target.stances ?? [];
    const existing = stances.find((entry) => entry.seatId === seatId);
    if (existing !== undefined) {
      existing.stance = stance;
      existing.reason = reason;
      existing.confidence = confidence;
    } else {
      stances.push({ seatId, stance, reason, confidence });
    }
    target.stances = stances;
    return { ok: true };
  }

  /** 版本列表，从旧到新。 */
  list(): DeliverableVersion[] {
    return [...this.versions].sort((a, b) => a.version - b.version).map(clone);
  }

  get(id: string): DeliverableVersion | undefined {
    const found = this.versions.find((deliverable) => deliverable.id === id);
    return found === undefined ? undefined : clone(found);
  }

  /** 最新一版（没有版本时 undefined）。 */
  latest(): DeliverableVersion | undefined {
    return this.newest() === undefined ? undefined : clone(this.newest()!);
  }

  /** 修订链（版本 / 作者 / 时间）。 */
  revisionLog(): DeliverableRevision[] {
    return this.revisions.map((revision) => ({ ...revision }));
  }

  /** 崩溃恢复：放回落盘的版本（保持 id / version / 状态）。 */
  restore(versions: DeliverableVersion[]): void {
    this.versions.length = 0;
    for (const deliverable of versions) {
      // 旧 deliverables.json 没有 revision 字段（F2-3 之后才有）：补 1，别让 CAS
      // 拿 undefined 去比。
      const revision = Number.isFinite(deliverable.revision) ? deliverable.revision : 1;
      this.versions.push(clone({ ...deliverable, revision }));
    }
  }

  private newest(): DeliverableVersion | undefined {
    return this.versions.reduce<DeliverableVersion | undefined>(
      (latest, current) => (latest === undefined || current.version > latest.version ? current : latest),
      undefined,
    );
  }
}

function clone(deliverable: DeliverableVersion): DeliverableVersion {
  return {
    ...deliverable,
    stances: (deliverable.stances ?? []).map((stance) => ({ ...stance })),
    sections: { ...deliverable.sections },
  };
}

/**
 * 正文写完后按 Markdown 标题回填 sections（主笔按 §4.9 的小节结构输出时命中）。
 * 认不出的小节保持原值——绝不从正文猜结论（AC-5：不许伪造追溯）。
 */
function fillSections(markdown: string, current: DeliverableVersion["sections"]): DeliverableVersion["sections"] {
  const sections = { ...current };
  const headings = [
    { key: "conclusions", patterns: ["结论", "conclusion"] },
    { key: "evidenceIndex", patterns: ["依据", "evidence"] },
    { key: "disagreements", patterns: ["分歧", "未决", "disagree"] },
    { key: "nextActions", patterns: ["后续", "next action", "next step"] },
    { key: "processIndex", patterns: ["过程", "process", "index"] },
  ] as const;
  const lines = markdown.split("\n");
  for (const heading of headings) {
    let titleIndex = -1;
    let titleLevel = Number.POSITIVE_INFINITY;
    for (let index = 0; index < lines.length; index++) {
      const match = /^(#{1,6})\s*(.+)$/.exec(lines[index] ?? "");
      if (match === null) {
        continue;
      }
      const title = (match[2] ?? "").toLowerCase();
      if (heading.patterns.some((pattern) => title.includes(pattern))) {
        titleIndex = index;
        titleLevel = (match[1] ?? "").length;
        break;
      }
    }
    if (titleIndex < 0) {
      continue;
    }
    const body: string[] = [];
    for (let index = titleIndex + 1; index < lines.length; index++) {
      const match = /^(#{1,6})\s+.+$/.exec(lines[index] ?? "");
      if (match !== null && (match[1] ?? "").length <= titleLevel) {
        break;
      }
      body.push(lines[index] ?? "");
    }
    const text = body.join("\n").trim();
    if (text.length > 0) {
      sections[heading.key] = text;
    }
  }
  return sections;
}
