/**
 * Roundtable constants: timings, capacity, L2 budget defaults and the
 * `roundtables/` persistence path helpers (dev plan §4.10 / §6.1 / §6.3).
 *
 * Values locked by the plan: H1 (seat cap), H4 (release/exit timeouts),
 * H5 (L2 budget), H7 (pending_inject cap), H8 (archive notice thresholds),
 * H33 (workspace pointer layout). `ABORT_TIMEOUT_MS` carries over the value
 * from team-constants.ts.
 */

import { createHash } from "crypto";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MAX_SEATS, type RoundtableSettings } from "../../shared/team-types.js";

/** 有序队列自动放行时间（H4，`RoundtableSettings.orderedReleaseMs` 默认）。 */
export const ORDERED_RELEASE_MS = 60_000;

/** 退出协商超时（H4，`RoundtableSettings.exitRequestTimeoutMs` 默认）。 */
export const EXIT_REQUEST_TIMEOUT_MS = 120_000;

/** L2 预算默认值（H5，`RoundtableSettings.l2` 默认）。 */
export const DEFAULT_L2_BUDGET: RoundtableSettings["l2"] = {
  perSeatPerTurn: 1,
  minIntervalMs: 30_000,
  globalWindowMs: 60_000,
  globalMaxInWindow: 8,
  consecutiveFuse: 2,
};

/** 席位硬上限（H1；用户不占名额，档位上限见 ROUNDTABLE_TIER_SEATS）。 */
export const MAX_SEAT_SLOTS = MAX_SEATS;

/** 辅助槽（整理/摘要 session）上限，独立于席位槽（plan §2.1）。 */
export const MAX_AUX_SLOTS = 2;

/**
 * Ceiling (ms) for awaiting session.abort() when aborting a seat turn.
 * L3 marks a half-finished turn as "externally unfinished" when the abort
 * does not settle inside this window (plan §5.6 / §4.13).
 */
export const ABORT_TIMEOUT_MS = 5_000;

/** 健康检查判定卡死的静默时长：`lastActiveAt` 超过它即 abort 并分段续跑（§4.13）。 */
export const STUCK_MS = 30 * 60_000;

/** 每席 pending_inject 条数上限（H7）：超出时最旧的非用户/非 @ 原文合成一条 summary 仍待注入。 */
export const MAX_PENDING_INJECT_PER_SEAT = 500;

/**
 * 单次注入的溢出一行摘要最多列多少条（F2-2）：积压上千条时逐条列会撑爆
 * 小窗口模型，超出部分只报总数（原文仍在时间线）。
 */
export const OVERFLOW_SUMMARY_MAX_LINES = 20;

/** 每席待批权限上限（F3-10）：达到上限后 request_permission 直接失败，不新增注意力。 */
export const MAX_PENDING_PERMISSIONS_PER_SEAT = 10;

/**
 * 落盘失败注意力的节流窗口（F3-5）：同一个写入目标 30s 内只发一次
 * （§5.14「仍失败则注意力」，但不能因为每 200ms 一次的快照刷新而刷屏）。
 */
export const PERSIST_FAILURE_NOTICE_THROTTLE_MS = 30_000;

/**
 * file_change 事后审计的去重窗口与表的容量上限（F3-7）：同一个 (seatId, path)
 * 30s 内只报一次；表本身有界，长讨论不会随变更次数单调增长。
 */
export const FILE_CHANGE_NOTICE_WINDOW_MS = 30_000;
export const FILE_CHANGE_NOTICE_MAX_KEYS = 200;

/**
 * team_bash 单次输出上限（F4-1）：与内置 bash 的截断口径同量级（2000 行 / 50KB）。
 * 一次 `cat 大文件` / `git log -p` 无界累积会把数 MB 塞进模型上下文并让主进程内存成倍增长。
 */
export const MAX_BASH_OUTPUT_LINES = 2000;
export const MAX_BASH_OUTPUT_BYTES = 50 * 1024;

/** 归档提示阈值（H8）：timeline.jsonl ≥ 50MB 或条目 ≥ 20_000，只提示不丢原文。 */
export const TIMELINE_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
export const TIMELINE_ARCHIVE_MAX_ENTRIES = 20_000;

/** 单场目录内的文件名（plan §4.10）。 */
export const ROUNDTABLE_FILES = {
  meta: "meta.json",
  timeline: "timeline.jsonl",
  inbox: "inbox.json",
  attention: "attention.jsonl",
  openItems: "open-items.json",
  leases: "leases.json",
  deliverables: "deliverables.json",
  metrics: "metrics.json",
} as const;

export type RoundtableFileName = (typeof ROUNDTABLE_FILES)[keyof typeof ROUNDTABLE_FILES];

/** 归档子目录名；归档场放 `archive/<roundtableId>/`（H33）。 */
export const ROUNDTABLE_ARCHIVE_DIR = "archive";

/** 工作区级活跃场指针文件名（H33）。 */
export const ROUNDTABLE_CURRENT_FILE = "current.json";

/** 工作区级 legacy 提示 ack 文件名（H14，不依赖 roundtableId）。 */
export const ROUNDTABLE_ACK_FILE = "ack.json";

/** 席位 session 目录名（plan §6.3；不再用 team-sessions）。 */
export const ROUNDTABLE_SESSIONS_DIR = "roundtable-sessions";

/** 用户自定义席位预设文件名（plan §6.4，不属于工作区 hash）。 */
export const ROUNDTABLE_PRESETS_FILE = "roundtable-presets.json";

function sha1Hex(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

/**
 * Workspace-scoped roundtable root: `roundtables/<sha1(physicalCwd)>/`.
 * Holds current.json, ack.json, live roundtable directories and archive/.
 */
export function roundtablesDir(physicalCwd: string): string {
  return join(getAgentDir(), "roundtables", sha1Hex(physicalCwd));
}

/** One roundtable's directory: `roundtables/<sha1(physicalCwd)>/<roundtableId>/`. */
export function roundtableDir(physicalCwd: string, roundtableId: string): string {
  return join(roundtablesDir(physicalCwd), roundtableId);
}

/** Path of one named file inside a roundtable directory. */
export function roundtableFilePath(
  physicalCwd: string,
  roundtableId: string,
  fileName: RoundtableFileName,
): string {
  return join(roundtableDir(physicalCwd, roundtableId), fileName);
}

/** Archived roundtable directory: `roundtables/<sha1(physicalCwd)>/archive/<roundtableId>/`. */
export function roundtableArchiveDir(physicalCwd: string, roundtableId: string): string {
  return join(roundtablesDir(physicalCwd), ROUNDTABLE_ARCHIVE_DIR, roundtableId);
}

/** Active-roundtable pointer file (H33). */
export function roundtableCurrentPointerPath(physicalCwd: string): string {
  return join(roundtablesDir(physicalCwd), ROUNDTABLE_CURRENT_FILE);
}

/** Workspace-level legacy-notice ack file (H14). */
export function roundtableAckPath(physicalCwd: string): string {
  return join(roundtablesDir(physicalCwd), ROUNDTABLE_ACK_FILE);
}

/** Session parent directory of one roundtable: `<agentDir>/roundtable-sessions/<roundtableId>/` (§6.3). */
export function roundtableSessionsDir(roundtableId: string): string {
  return join(getAgentDir(), ROUNDTABLE_SESSIONS_DIR, roundtableId);
}

/** Session directory of one seat: slug, not display name (H25/§6.3). */
export function seatSessionDir(roundtableId: string, slug: string): string {
  return join(roundtableSessionsDir(roundtableId), slug);
}

/** User preset file path (plan §6.4). */
export function roundtablePresetsPath(): string {
  return join(getAgentDir(), ROUNDTABLE_PRESETS_FILE);
}
