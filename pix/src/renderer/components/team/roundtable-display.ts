/**
 * roundtable-display - pure projections shared by the S6 roundtable surfaces.
 *
 * The renderer holds a window of the timeline pushed by the main process, so
 * the group chat collapses a long session the same way `TimelineLog.overflowWindow`
 * does (newest `cap` items visible, the count of hidden older ones) - `src/main`
 * is not importable from the renderer, and the *semantics* are what the UI needs
 * (FR-2 / FR-6 / AC-8: 原文零丢失，过载可显示整理中并可展开).
 *
 * Everything here is framework-free so the components stay thin and the display
 * rules (delivery three-state, seat status, attention kinds, cost/health
 * formatting) are testable without mounting anything.
 */

import {
  USER_SEAT_ID,
  type AttentionItem,
  type DeliveryState,
  type InterruptLevel,
  type RoundtableMetricsSnapshot,
  type SeatInfo,
  type SeatRuntimeStatus,
  type TimelineItem,
  type TimelineItemType,
  type ToolAuthTier,
} from "@shared/team-types.js";

/** Items older than this collapse behind 「整理中 N 条」 (long-session render). */
export const TIMELINE_OVERFLOW_CAP = 60;

export interface OverflowWindow<T> {
  /** Number of older items hidden behind the collapse affordance. */
  collapsed: number;
  /** Newest `cap` items (rendered). */
  visible: T[];
  /** Hidden older items, oldest first (rendered after expanding). */
  hidden: T[];
}

/**
 * Newest-`cap` window over a seq-ordered timeline. Mirrors the main-process
 * semantics: nothing is dropped, expansion re-renders the hidden prefix.
 */
export function overflowWindow<T>(items: readonly T[], cap: number = TIMELINE_OVERFLOW_CAP): OverflowWindow<T> {
  if (cap <= 0 || items.length <= cap) {
    return { collapsed: 0, visible: [...items], hidden: [] };
  }
  return {
    collapsed: items.length - cap,
    visible: items.slice(items.length - cap),
    hidden: items.slice(0, items.length - cap),
  };
}

// ============================================================================
// Delivery three states (AC-8: 已记录 / 待注入 / 已注入)
// ============================================================================

/**
 * Fixed display order: recorded（落盘）→ pending_inject（待注入）→ injected（已注入）
 * → folded（被 H7 背压折叠进摘要；终态，排在最后）。
 */
export const DELIVERY_STATE_ORDER: DeliveryState[] = ["recorded", "pending_inject", "injected", "folded"];

export function deliveryStateLabel(state: DeliveryState): string {
  switch (state) {
    case "recorded": return "已记录";
    case "pending_inject": return "待注入";
    case "injected": return "已注入";
    case "folded": return "已折叠";
  }
}

export function deliveryStateIcon(state: DeliveryState): string {
  switch (state) {
    case "recorded": return "mdi-content-save-outline";
    case "pending_inject": return "mdi-tray-arrow-down";
    case "injected": return "mdi-check-circle-outline";
    case "folded": return "mdi-archive-arrow-down-outline";
  }
}

export function deliveryStateTone(state: DeliveryState): "grey" | "amber" | "blue" {
  switch (state) {
    case "recorded": return "grey";
    case "pending_inject": return "amber";
    case "injected": return "blue";
    // 折叠是中性事实（正文仍在时间线，只是不再逐条注入），不占用警示色。
    case "folded": return "grey";
  }
}

/** Delivery rows of one item, ordered for display; empty delivery = 已记录 only. */
export function deliveryRows(item: TimelineItem): Array<{ seatId: string; state: DeliveryState }> {
  const bySeat = item.deliveryBySeat ?? {};
  const rows = Object.entries(bySeat).map(([seatId, state]) => ({ seatId, state }));
  rows.sort((a, b) => DELIVERY_STATE_ORDER.indexOf(a.state) - DELIVERY_STATE_ORDER.indexOf(b.state) || a.seatId.localeCompare(b.seatId));
  return rows;
}

// ============================================================================
// Timeline item labels
// ============================================================================

export function timelineTypeLabel(type: TimelineItemType): string {
  switch (type) {
    case "utterance": return "发言";
    case "knowledge_card": return "知识卡";
    case "question": return "提问";
    case "challenge": return "质疑";
    case "system": return "系统";
    case "user": return "用户";
    case "private_stub": return "私密";
    case "thread_promo": return "结论上浮";
  }
}

export function timelineTypeIcon(type: TimelineItemType): string {
  switch (type) {
    case "utterance": return "mdi-message-text-outline";
    case "knowledge_card": return "mdi-card-text-outline";
    case "question": return "mdi-help-circle-outline";
    case "challenge": return "mdi-sword-cross";
    case "system": return "mdi-information-outline";
    case "user": return "mdi-account-outline";
    case "private_stub": return "mdi-lock-outline";
    case "thread_promo": return "mdi-arrow-up-bold-circle-outline";
  }
}

export function interruptLabel(level: InterruptLevel | undefined): string {
  switch (level) {
    case "L0": return "静默";
    case "L1": return "插话";
    case "L2": return "打断";
    case "L3": return "中止";
    default: return "";
  }
}

export function isUserItem(item: TimelineItem): boolean {
  return item.fromId === USER_SEAT_ID;
}

/** `to` target label: 全员 / 用户 / seat display name. */
export function targetLabel(toId: string, seats: Record<string, SeatInfo> | undefined): string {
  if (toId === "*") return "全员";
  if (toId === USER_SEAT_ID) return "用户";
  return seatLabel(toId, seats);
}

/** seatId → 展示名（含已退出席位）；未知 id 回退到 slug 段。 */
export function seatLabel(seatId: string, seats: Record<string, SeatInfo> | undefined): string {
  if (seatId === USER_SEAT_ID) return "用户";
  const seat = seats?.[seatId];
  if (seat !== undefined) return seat.name;
  const separator = seatId.indexOf("::");
  return separator > 0 ? seatId.slice(0, separator) : seatId;
}

export function seatColor(seatId: string, seats: Record<string, SeatInfo> | undefined): string {
  if (seatId === USER_SEAT_ID) return "#2563eb";
  return seats?.[seatId]?.color ?? "#7d859a";
}

/** Perspective: 席位详情卡的第一行（视角/授权/状态）。 */
export function seatStatusLabel(status: SeatRuntimeStatus): string {
  switch (status) {
    case "exploring": return "探索中";
    case "speaking": return "发言中";
    case "idle": return "空闲";
    case "waiting_turn": return "等待发言";
    case "exited": return "已退出";
    case "error": return "异常";
  }
}

export function seatStatusTone(status: SeatRuntimeStatus): "green" | "blue" | "amber" | "grey" | "red" {
  switch (status) {
    case "exploring": return "blue";
    case "speaking": return "green";
    case "idle": return "grey";
    case "waiting_turn": return "amber";
    case "exited": return "grey";
    case "error": return "red";
  }
}

export function seatStatusDot(status: SeatRuntimeStatus): string {
  switch (status) {
    case "exploring": return "#2563eb";
    case "speaking": return "var(--pix-success)";
    case "idle": return "var(--pix-text-muted)";
    case "waiting_turn": return "var(--pix-warning)";
    case "exited": return "var(--pix-border)";
    case "error": return "var(--pix-error)";
  }
}

export function authTierLabel(auth: ToolAuthTier): string {
  switch (auth) {
    case "read_only": return "只读";
    case "write": return "可写";
    case "restricted": return "受限";
  }
}

export function attentionKindLabel(kind: AttentionItem["kind"]): string {
  switch (kind) {
    case "user_mentioned": return "@用户";
    case "permission": return "待批权限";
    case "write_conflict": return "写冲突";
    case "seat_error": return "席位异常";
    case "seat_stuck": return "席位卡死";
    case "soft_budget": return "预算提示";
    case "wrap_up_ready": return "可以整理";
    case "hard_stop": return "硬停止";
    case "deliverable_ready": return "稿可取用";
    case "exit_request": return "退出协商";
    case "l2_fused": return "打断熔断";
  }
}

export function attentionKindIcon(kind: AttentionItem["kind"]): string {
  switch (kind) {
    case "user_mentioned": return "mdi-at";
    case "permission": return "mdi-shield-alert-outline";
    case "write_conflict": return "mdi-file-lock-outline";
    case "seat_error": return "mdi-alert-circle-outline";
    case "seat_stuck": return "mdi-timer-alert-outline";
    case "soft_budget": return "mdi-cash-clock";
    case "wrap_up_ready": return "mdi-clipboard-text-outline";
    case "hard_stop": return "mdi-stop-circle-outline";
    case "deliverable_ready": return "mdi-package-variant-closed";
    case "exit_request": return "mdi-logout";
    case "l2_fused": return "mdi-call-split";
  }
}

// ============================================================================
// Cost / health formatting (FR-10 / AC-22 / PRD §11.12)
// ============================================================================

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 秒";
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分`;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours} 小时 ${minutes} 分`;
}

/** 0–1 share (or 0–100 percent) → 「42%」. */
export function formatShare(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  const percent = value <= 1 ? value * 100 : value;
  return `${Math.round(percent)}%`;
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export interface HealthReadout {
  /** 发言分布：每席 share（0–1），按占比降序。 */
  speakShare: Array<{ seatId: string; share: number }>;
  /** 证据密度 0–1。 */
  evidenceDensity: number;
  /** 打断率 0–1。 */
  interruptRate: number;
}

/** 讨论体检三指标（AC-22 / PRD §11.12）—— CostStrip 的唯一数据来源。 */
export function healthReadout(metrics: RoundtableMetricsSnapshot): HealthReadout {
  const speakShare = Object.entries(metrics.health.speakShare)
    .map(([seatId, share]) => ({ seatId, share }))
    .sort((a, b) => b.share - a.share);
  return {
    speakShare,
    evidenceDensity: metrics.health.evidenceDensity,
    interruptRate: metrics.health.interruptRate,
  };
}
