/**
 * Roundtable (Discuss) team types — the single source of truth for every
 * cross-process roundtable type and constant.
 *
 * Renderer, preload, main and tests import from this file only. `types.ts`
 * keeps its old Team shapes until S5, which re-exports this module; this file
 * must never import runtime values from `types.ts` (type-only imports avoid the
 * re-export cycle there).
 *
 * Contracts transcribed from the dev plan §4.1 / §4.2 / §4.4 / §4.10 / §4.12.
 */

import type { AgentSessionEvent, ChatMessageAttachment, PermissionRequest } from "./types.js";

/** 用户在时间线/收件箱中的固定 id，不是席位名额。 */
export const USER_SEAT_ID = "user" as const;

export type RoundtableTier = "compact" | "standard" | "deep" | "blitz";
export const ROUNDTABLE_TIER_SEATS: Record<RoundtableTier, 3 | 5 | 8 | 12> = {
  compact: 3, standard: 5, deep: 8, blitz: 12,
};
export const DEFAULT_ROUNDTABLE_TIER: RoundtableTier = "standard";
export const MIN_SEATS = 3;
export const MAX_SEATS = 12;

export type SeatRuntimeStatus =
  | "exploring" | "speaking" | "idle" | "waiting_turn" | "exited" | "error";
/** waiting_turn 仅有序模式出现。 */

export type ToolAuthTier = "read_only" | "write" | "restricted";
/** 默认 read_only。 */

/** folded = 被 H7 背压折叠进摘要（F2-1：改状态而不是删条目，否则投递态永远停在「待注入」）。 */
export type DeliveryState = "recorded" | "pending_inject" | "injected" | "folded";

export type TimelineItemType =
  | "utterance" | "knowledge_card" | "question" | "challenge"
  | "system" | "user" | "private_stub" | "thread_promo";

export type UtteranceKind = "argument" | "note" | "knowledge_card" | "question" | "explore_result" | "challenge";

/** append 时 type 必须由本映射产生，S2a/S3/S6 禁止各自发明。 */
export function timelineTypeFromUtterance(kind: UtteranceKind): TimelineItemType {
  switch (kind) {
    case "knowledge_card": return "knowledge_card";
    case "question": return "question";
    case "challenge": return "challenge";
    default: return "utterance"; // argument | note | explore_result
  }
}

export type InterruptLevel = "L0" | "L1" | "L2" | "L3";

export type RoundtableLifecycle = "inactive" | "active" | "paused" | "stopped";

/** 视角模板（可改、可重复使用，不是工种）。 */
export const PERSPECTIVE_TEMPLATES = [
  { id: "sources", label: "资料", prompt: "优先核对原始资料与出处。" },
  { id: "counterexample", label: "反例", prompt: "专门寻找能推翻当前假说的反例。" },
  { id: "theory", label: "理论", prompt: "检查概念框架、假设与推理链条。" },
  { id: "feasibility", label: "可行性", prompt: "评估工程/资源/约束上是否可做。" },
  { id: "experiment", label: "实验", prompt: "设计或解释可证伪的验证。" },
] as const;

export interface SeatConfig {
  /** 展示名（可中文）。活跃席必须唯一，不作 seatId。 */
  name: string;
  perspective: string;
  model?: string;
  auth: ToolAuthTier;
  pathAllowlist?: string[];
  readonlyCommandAllowlist?: string[];
  /** 仅 write 档有效；受限档忽略（H11） */
  bashEnabled?: boolean;
}

export interface SeatInfo extends SeatConfig {
  /** `${slug}::${roundtableId}`，见 H25 */
  seatId: string;
  slug: string;
  color: string;
  status: SeatRuntimeStatus;
  createdAt: number;
  statusChangedAt: number;
  lastSpokeAt?: number;
  lastActiveAt?: number;
  currentActivity?: string;
  error?: string;
}

/**
 * `allocateSeatSlug` / `formatSeatId` / `parseSeatId` live in the main process
 * (`pix/src/main/team/ids.ts`), not here. 模板席 slug=PERSPECTIVE_TEMPLATES.id，
 * 不走 allocateSeatSlug；中文名 slug 单测见 `__tests__/team-ids.test.ts`。
 */

export interface RoundtableSettings {
  orderedMode: boolean;
  waitForUserQuestions: boolean;          // 默认 false；true 时仅对已发出 @user 且尚未收到用户回复的席位停发新 prompt，其它席不停
  autoContinueAfterCrash: boolean;        // 默认 false
  unattendedGuard: boolean;               // 默认 false；行为见 H20
  suggestWrapUp: boolean;                 // 默认 false；触发见 H18
  softBudget?: {                          // 默认 undefined=关；见 H19
    maxCostUsd?: number;
    maxDurationMs?: number;
  };
  hardStop?: {
    enabled: boolean;                     // 默认 false
    maxCostUsd?: number;
    maxDurationMs?: number;
    allowWrapUpOnStop: boolean;           // 「停止讨论并整理」
  };
  /** 预授权的降档模型 "provider/id"；未预授权则 downgrade_models 拒绝 */
  cheaperModel?: string;
  orderedReleaseMs: number;               // 默认 60_000
  exitRequestTimeoutMs: number;           // 默认 120_000
  l2: {
    perSeatPerTurn: number;               // 1
    minIntervalMs: number;                // 30_000
    globalWindowMs: number;               // 60_000
    globalMaxInWindow: number;            // 8
    consecutiveFuse: number;              // 2
  };
}

export interface TimelineItem {
  id: string;
  seq: number;                            // 单调递增，交付物 cutoff 用
  ts: number;
  type: TimelineItemType;
  fromId: string;                         // USER_SEAT_ID 或 seatId
  toId: string;                           // seatId | "*" | USER_SEAT_ID
  text: string;                           // 私密 stub 为空串
  summary: string;
  utteranceKind?: UtteranceKind;
  threadId?: string;                      // 缺省=主线
  replyToId?: string;
  basedOnId?: string;                     // 基于哪条发现
  knowledgeCard?: KnowledgeCard;
  interrupt?: InterruptLevel;
  privateStub?: { fromId: string; toId: string };
  deliveryBySeat?: Record<string, DeliveryState>;
  attachments?: ChatMessageAttachment[];
  mentionIds: string[];                   // H41；无 @ 则为 []
}

export interface KnowledgeCard {
  claim: string;
  claimKind: "evidenced" | "opinion";
  confidence: "low" | "medium" | "high";
  evidence: Array<{
    kind: "path" | "command" | "url" | "timeline";
    ref: string;
    excerpt?: string;
  }>;
  method?: string;
  uncertainty?: string;
}

export interface InboxEntry {
  messageId: string;                      // = TimelineItem.id
  seatId: string;
  state: DeliveryState;                   // recorded 仅时间线；inbox 里实际是 pending_inject | injected
  text: string;                           // 注入正文。公开消息=TimelineItem.text 副本；私密=唯一落盘载体（H36）
  enqueuedAt: number;
  injectedAt?: number;
  injectedInCallId?: string;
  priority: "user" | "mention" | "normal";
  fromId: string;                         // 发送方（渲染来源标签用；旧快照缺省 "unknown"）
  type: TimelineItemType;                 // 来源类型（旧快照缺省 "system"）
}

export interface AttentionItem {
  id: string;
  ts: number;
  kind:
    | "user_mentioned"
    | "permission"
    | "write_conflict"
    | "seat_error"
    | "seat_stuck"
    | "soft_budget"
    | "wrap_up_ready"
    | "hard_stop"
    | "deliverable_ready"
    | "exit_request"
    | "l2_fused";
  seatId?: string;
  refId?: string;
  text: string;
  acked: boolean;
  /**
   * 需要用户确认后执行的恢复动作（F5-4）：崩溃恢复的「确认后继续」提示带
   * `"resume"`，renderer 在 ack 之后补发一条 `resume` 命令。缺省=纯提示。
   */
  action?: "resume";
}

export interface OpenItem {
  id: string;
  subject: string;
  body: string;
  status: "open" | "claimed" | "resolved" | "dropped";
  claimedBy?: string;                     // 自愿认领，系统不自动领
  claimNote?: string;                     // claim_open_item.note
  createdAt: number;
  updatedAt: number;
}

export interface WriteLease {
  pathKey: string;                        // 规范化绝对路径
  ownerSeatId: string;
  acquiredAt: number;
  /** 覆盖该写者获准期间对该路径的 read-modify 过程，直到显式释放或席位退出/暂停 */
}

export interface DeliverableVersion {
  id: string;
  version: number;                        // 从 1 递增
  /** 该版的修订计数：create 时 1，每次成功 updateMarkdown +1（F2-3 的 CAS 令牌）。 */
  revision: number;
  cutoffSeq: number;
  createdAt: number;
  author: "system" | string;              // seatId 或 system
  basedOnVersion?: number;
  status: "drafting" | "ready" | "superseded";
  markdown: string;
  stances?: Array<{
    seatId: string;
    stance: "support" | "oppose" | "conditional" | "absent";
    reason?: string;
    confidence?: "low" | "medium" | "high";
  }>;
  sections: {
    conclusions: string;
    evidenceIndex: string;
    disagreements: string;
    nextActions: string;
    processIndex: string;
  };
}

export interface RoundtableState {
  roundtableId: string;                   // H26，create 时生成
  name: string;
  lifecycle: RoundtableLifecycle;
  createdAt: number;
  tier: RoundtableTier;
  settings: RoundtableSettings;           // orderedMode 权威源（H27）
  seats: Record<string, SeatInfo>;
  /** 投影自 settings.orderedMode，只读 */
  orderedMode: boolean;
  hostSessionId?: string;
}

export interface RoundtableMetricsSnapshot {
  perSeat: Record<string, {
    utterances: number;
    tokensIn: number;
    tokensOut: number;
    cost: number;
    durationMs: number;
  }>;
  totals: { utterances: number; tokens: number; cost: number; durationMs: number };
  health: {
    speakShare: Record<string, number>;   // 发言分布 0–1
    evidenceDensity: number;              // 知识卡或带 evidence 的发言 / 总发言
    interruptRate: number;                // L2+L3 / 发言
  };
}

/** §4.4 — SeatInbox.packForNextCall 的返回值（已是模型可读文本）。 */
export interface PackedContext {
  callId: string;
  /**
   * 按顺序拼进 prompt 的块（已是模型可读文本）。每块带来源标签：`fromId`/`type`
   * 来自对应时间线条目，渲染时据此写「[用户] / [系统] / [席位 x]」，避免席位把
   * 自己的发言伪装成用户或系统指令（H16 / FR-15）。
   */
  blocks: Array<{
    messageId: string;
    text: string;
    mode: "original" | "summary";
    fromId: string;
    type: TimelineItemType;
  }>;
  injectedIds: string[];      // 仅 original 且计入已注入
  stillPendingIds: string[];
}

/** §4.10 — 退出协商请求。 */
export interface ExitRequest {
  id: string;
  targetSeatId: string;
  requestedBy: string;
  requestedAt: number;
  statements: Array<{ fromId: string; text: string }>;
  status: "pending" | "done" | "cancelled";
}

/** §4.10 — 快照本体；timeline.jsonl / attention.jsonl 单独 replay。 */
export interface PersistedRoundtable {
  version: 2;
  roundtableId: string;
  physicalCwd: string;
  savedAt: number;
  state: RoundtableState;
  inbox: InboxEntry[];
  openItems: OpenItem[];
  leases: WriteLease[];
  deliverables: DeliverableVersion[];
  mutedThreads: string[];
  metrics: RoundtableMetricsSnapshot;
  pendingPermissions: PermissionRequest[];
  pendingExits: ExitRequest[];
  /**
   * 已确认的注意力条目 id（F4-5）。attention.jsonl 只在 push 时追加（写入时恒
   * false），不落 acked 的话重启后所有已处理条目会以未处理态回来——已决定过的
   * 权限卡重新变成可点按钮（requestId 已不在 pendingPermissions）= 死按钮。
   * 旧快照缺省 `[]`，向后兼容。
   */
  attentionAcks: string[];
}

export type TeamCommand =
  | { type: "create_roundtable"; topic: string; name?: string; tier?: RoundtableTier; seats?: SeatConfig[]; settings?: Partial<RoundtableSettings>; attachments?: ChatMessageAttachment[] }
  | { type: "get_state" }
  | { type: "get_timeline"; filter?: { seatId?: string; type?: TimelineItemType; threadId?: string | null; q?: string } }
  | { type: "get_attention" }
  | { type: "get_open_items" }
  | { type: "get_deliverables" }
  | { type: "get_metrics" }
  | { type: "post_user_message"; to: string; text: string; private?: boolean; interrupt?: InterruptLevel; attachments?: ChatMessageAttachment[] }
  | { type: "set_ordered_mode"; on: boolean }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop"; wrapUp?: boolean }
  | { type: "add_seat"; config: SeatConfig }
  | { type: "remove_seat"; seatId: string; requestedBy: "user" | "self" | "peer" }
  | { type: "update_seat_auth"; seatId: string; auth: ToolAuthTier; pathAllowlist?: string[] }
  | { type: "wake_seat"; seatId: string }
  | { type: "mute_thread"; threadId: string; muted: boolean }
  | { type: "request_wrap_up"; author?: "system" | string }
  | { type: "revise_deliverable"; id: string; markdown: string; expectedRevision?: number }
  | { type: "stance_on_deliverable"; id: string; seatId?: string; stance: "support" | "oppose" | "conditional"; reason?: string; confidence?: "low" | "medium" | "high" }
  | { type: "export_markdown" }
  | { type: "build_handoff"; deliverableId: string; target: "solo" | "plan" }
  | { type: "get_inbox"; seatId?: string }
  | { type: "ack_attention"; id: string }
  | { type: "respond_permission"; requestId: string; approved: boolean; reason?: string }
  | { type: "respond_exit"; requestId: string; statement: string; accept?: boolean }
  | { type: "set_settings"; settings: Partial<RoundtableSettings> }
  | { type: "downgrade_models"; model: string }
  | { type: "list_presets" }
  | { type: "save_preset"; name: string; seats: SeatConfig[] }
  | { type: "delete_preset"; name: string };

export type TeamEvent =
  | { type: "roundtable_created"; state: RoundtableState }
  | { type: "roundtable_state"; state: RoundtableState }
  | { type: "timeline_item"; item: TimelineItem }
  | { type: "seat_status"; seatId: string; status: SeatRuntimeStatus; activity?: string; error?: string }
  | { type: "seat_event"; seatId: string; event: AgentSessionEvent }
  | { type: "attention"; item: AttentionItem }
  | { type: "open_item"; item: OpenItem }
  | { type: "deliverable"; item: DeliverableVersion }
  | { type: "delivery_changed"; messageId: string; seatId: string; state: DeliveryState }
  | { type: "metrics"; snapshot: RoundtableMetricsSnapshot }
  | { type: "legacy_snapshot_notice" }
  | { type: "record_corrupt_notice"; text: string }
  | { type: "protocol_permission_request"; request: PermissionRequest }
  | { type: "exit_request"; request: ExitRequest };
