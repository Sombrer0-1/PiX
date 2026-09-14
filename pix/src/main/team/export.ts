/**
 * Markdown 导出与归档提示（plan §3.3 / §6.1，H8 / AC-21 / FR-11）。
 *
 * `exportRoundtableMarkdown` 只做文本：时间线原文 + 知识卡 + 未决项 + 交付物版本
 * + 成本汇总，纯函数、无 IO、不发事件。
 *
 * `archiveNotice` 是 H8 的阈值检查：`timeline.jsonl` ≥ 50MB 或条目 ≥ 20_000 时
 * **只提示**「记录已归档 / 可归档」，绝不静默丢掉用户正在看的场。
 */

import {
  TIMELINE_ARCHIVE_MAX_BYTES,
  TIMELINE_ARCHIVE_MAX_ENTRIES,
} from "./constants.js";
import { USER_SEAT_ID, type AttentionItem, type DeliverableVersion, type InboxEntry, type OpenItem, type RoundtableMetricsSnapshot, type RoundtableState, type TimelineItem } from "../../shared/team-types.js";

export interface RoundtableExportInput {
  state: RoundtableState;
  timeline: TimelineItem[];
  openItems?: OpenItem[];
  deliverables?: DeliverableVersion[];
  attention?: AttentionItem[];
  inbox?: InboxEntry[];
  metrics?: RoundtableMetricsSnapshot;
  /** 已静音的线程：导出正文里折叠成计数，不重放全文（FR-4）。 */
  mutedThreads?: string[];
  /** 已归档的场在标题下加一行「记录已归档」说明。 */
  archived?: boolean;
}

/** 时间线过滤：`mutedThreads` 里的线程在导出正文里折叠成一行计数。 */
function mutedSummary(items: TimelineItem[], muted: Set<string>): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.threadId !== undefined && muted.has(item.threadId)) {
      counts.set(item.threadId, (counts.get(item.threadId) ?? 0) + 1);
    }
  }
  if (counts.size === 0) {
    return [];
  }
  return [
    "已静音的线程（正文未展开）：",
    ...[...counts.entries()].map(([threadId, count]) => `- ${threadId}：${count} 条`),
    "",
  ];
}

/** 一条时间线记录的 Markdown 行；知识卡展开成引用块。 */
function renderItem(item: TimelineItem, seatNames: Map<string, string>): string[] {
  const from = seatNames.get(item.fromId) ?? item.fromId;
  const to = item.toId === "*" ? "全员" : seatNames.get(item.toId) ?? item.toId;
  const header = `**${from}** → ${to} · ${item.type}${item.threadId !== undefined ? ` · thread ${item.threadId}` : ""}`;
  const body = item.text.trim().length > 0 ? item.text : item.privateStub !== undefined ? "_（私密消息：正文只在目标席收件箱，此处无正文）_" : "";
  const lines = [`#### #${item.seq} ${header}`, ""];
  if (body.length > 0) {
    lines.push(body, "");
  }
  const card = item.knowledgeCard;
  if (card !== undefined) {
    lines.push(
      `> 知识卡（${card.claimKind} / ${card.confidence}）：${card.claim}`,
      ...(card.evidence.length > 0
        ? card.evidence.map((evidence) => `> - [${evidence.kind}] ${evidence.ref}${evidence.excerpt ? `: ${evidence.excerpt}` : ""}`)
        : ["> - （无依据：按观点处理）"]),
      ...(card.uncertainty !== undefined ? [`> 不确定性：${card.uncertainty}`] : []),
      "",
    );
  }
  if (item.attachments !== undefined && item.attachments.length > 0) {
    lines.push(`附件：${item.attachments.map((attachment) => attachment.name ?? attachment.path ?? "附件").join("、")}`, "");
  }
  return lines;
}

function renderDeliverable(deliverable: DeliverableVersion, seatNames: Map<string, string>): string[] {
  const stances = deliverable.stances ?? [];
  return [
    `### v${deliverable.version}（${deliverable.status}，author: ${deliverable.author === "system" ? "系统整理" : seatNames.get(deliverable.author) ?? deliverable.author}）`,
    "",
    `- id: ${deliverable.id}`,
    `- 截止点 cutoffSeq: ${deliverable.cutoffSeq}`,
    `- 生成时间: ${new Date(deliverable.createdAt).toISOString()}`,
    ...(deliverable.basedOnVersion !== undefined ? [`- 基于版本: v${deliverable.basedOnVersion}`] : []),
    "",
    deliverable.markdown.trim().length > 0 ? deliverable.markdown : "_（本版没有正文）_",
    "",
    "**结论与建议**",
    deliverable.sections.conclusions || "（未记录）",
    "",
    "**依据入口**",
    deliverable.sections.evidenceIndex || "（未记录：按未验证处理）",
    "",
    "**分歧与未决**",
    deliverable.sections.disagreements || "（未记录）",
    "",
    "**后续动作**",
    deliverable.sections.nextActions || "（未记录）",
    "",
    "**过程索引**",
    deliverable.sections.processIndex || "（未记录）",
    "",
    "**席位表态**",
    stances.length > 0
      ? stances.map((stance) => `- ${seatNames.get(stance.seatId) ?? stance.seatId}：${stance.stance}${stance.confidence !== undefined ? `（${stance.confidence}）` : ""}${stance.reason !== undefined ? ` - ${stance.reason}` : ""}`).join("\n")
      : "（无席位表态）",
    "",
  ];
}

/** 忠实于记录的 Markdown 导出（AC-21）。 */
export function exportRoundtableMarkdown(input: RoundtableExportInput): string {
  const { state } = input;
  const seatNames = new Map<string, string>(Object.values(state.seats).map((seat) => [seat.seatId, seat.name]));
  seatNames.set(USER_SEAT_ID, "用户");

  const mainLine = (input.timeline ?? []).filter((item) => item.threadId === undefined);
  const threaded = (input.timeline ?? []).filter((item) => item.threadId !== undefined);

  const lines: string[] = [
    `# 圆桌记录：${state.name}`,
    "",
    `- roundtableId: ${state.roundtableId}`,
    `- 状态: ${state.lifecycle}`,
    `- 档位/席位: ${state.tier} / ${Object.keys(state.seats).length}`,
    `- 创建时间: ${new Date(state.createdAt).toISOString()}`,
    `- 有序模式: ${state.orderedMode ? "开" : "关"}`,
    ...(input.archived === true ? ["- 记录已归档（本场已停止，记录为只读包）"] : []),
    "",
    "## 席位",
    "",
    ...Object.values(state.seats).map((seat) =>
      `- ${seat.name}（${seat.seatId}）· 视角：${seat.perspective} · 授权：${seat.auth} · 模型：${seat.model ?? "默认"} · 状态：${seat.status}`,
    ),
    "",
    "## 时间线",
    "",
  ];

  if (input.timeline === undefined || input.timeline.length === 0) {
    lines.push("（无记录）", "");
  } else {
    const muted = new Set(input.mutedThreads ?? []);
    lines.push(...mutedSummary(input.timeline, muted));
    for (const item of mainLine) {
      lines.push(...renderItem(item, seatNames));
    }
    // F4-8：静音线程折叠成计数行（上面的 mutedSummary），不重放全文——否则
    // 与文件头与入参注释声明的契约自相矛盾。
    const audible = threaded.filter((item) => item.threadId === undefined || !muted.has(item.threadId));
    if (audible.length > 0) {
      lines.push("## 线程", "");
      for (const item of audible) {
        lines.push(...renderItem(item, seatNames));
      }
    }
  }

  lines.push("## 未决项", "");
  const openItems = input.openItems ?? [];
  lines.push(
    ...(openItems.length > 0
      ? openItems.map((item) => `- [${item.status}] ${item.subject}${item.claimedBy !== undefined ? `（由 ${seatNames.get(item.claimedBy) ?? item.claimedBy} 认领）` : ""} · ${item.body}`)
      : ["（无）"]),
    "",
  );

  lines.push("## 交付物", "");
  const deliverables = input.deliverables ?? [];
  lines.push(...(deliverables.length > 0 ? deliverables.flatMap((deliverable) => renderDeliverable(deliverable, seatNames)) : ["（本场尚未整理）", ""]));

  if (input.metrics !== undefined) {
    const metrics = input.metrics;
    lines.push(
      "## 成本与体检",
      "",
      `- 发言总数: ${metrics.totals.utterances}`,
      `- token 合计: ${metrics.totals.tokens}`,
      `- 成本合计: ${metrics.totals.cost}`,
      `- 时长合计(ms): ${metrics.totals.durationMs}`,
      `- 证据密度: ${metrics.health.evidenceDensity}`,
      `- 打断率: ${metrics.health.interruptRate}`,
      "",
    );
    for (const [seatId, seat] of Object.entries(metrics.perSeat)) {
      lines.push(`- ${seatNames.get(seatId) ?? seatId}：发言 ${seat.utterances} · token ${seat.tokensIn}+${seat.tokensOut} · 成本 ${seat.cost}`);
    }
    lines.push("");
  }

  const attention = input.attention ?? [];
  if (attention.length > 0) {
    lines.push(
      "## 注意力面",
      "",
      ...attention.map((item) => `- [${item.acked ? "已确认" : "未确认"}] ${item.kind}${item.seatId !== undefined ? ` (${seatNames.get(item.seatId) ?? item.seatId})` : ""}：${item.text}`),
      "",
    );
  }

  const inbox = input.inbox ?? [];
  if (inbox.length > 0) {
    const pending = inbox.filter((entry) => entry.state === "pending_inject").length;
    const injected = inbox.filter((entry) => entry.state === "injected").length;
    const folded = inbox.filter((entry) => entry.state === "folded").length;
    lines.push(
      "## 投递状态",
      "",
      `- 待注入: ${pending}`,
      `- 已注入: ${injected}`,
      ...(folded > 0 ? [`- 已折叠: ${folded}`] : []),
      "",
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** H8 归档提示（只提示，不删不丢）。 */
export interface ArchiveNotice {
  /** 触发阈值的原因。 */
  reason: "bytes" | "entries";
  bytes: number;
  entries: number;
  text: string;
}

/**
 * `timeline.jsonl` 达到归档阈值时返回提示文本；未达到返回 null。
 * 调用方把 text 放进注意力面/UI，**不得**因此静默丢弃仍在看的场。
 */
export function archiveNotice(input: { timelineBytes: number; timelineEntries: number }): ArchiveNotice | null {
  const bytes = Number.isFinite(input.timelineBytes) ? input.timelineBytes : 0;
  const entries = Number.isFinite(input.timelineEntries) ? input.timelineEntries : 0;
  if (bytes >= TIMELINE_ARCHIVE_MAX_BYTES) {
    return {
      reason: "bytes",
      bytes,
      entries,
      text: `本场记录已达 ${Math.round(bytes / (1024 * 1024))}MB（阈值 ${Math.round(TIMELINE_ARCHIVE_MAX_BYTES / (1024 * 1024))}MB）：可归档为只读包，记录不会自动删除。`,
    };
  }
  if (entries >= TIMELINE_ARCHIVE_MAX_ENTRIES) {
    return {
      reason: "entries",
      bytes,
      entries,
      text: `本场记录已达 ${entries} 条（阈值 ${TIMELINE_ARCHIVE_MAX_ENTRIES}）：可归档为只读包，记录不会自动删除。`,
    };
  }
  return null;
}
