/**
 * 旧 team.json 探测（dev plan §6.1 / H14）。
 *
 * 旧路径 `getAgentDir()/team-state/<sha1>/team.json` 只有两个用途：
 *   1. `detectLegacyTeamSnapshot` 判断「这个工作区有旧快照」；
 *   2. 首次打开时提示一次（事件 `legacy_snapshot_notice`，ack 写工作区级 ack.json）。
 *
 * 本模块绝不读取正文、绝不恢复、绝不删除旧文件：旧场是 v1 编排（Leader / 任务 gate）
 * 的数据，与圆桌语义不兼容。`LEGACY_SNAPSHOT_RESTORABLE` / `isLegacySnapshotRestorable`
 * 把这个决定显式暴露出来，IPC 层的「可恢复」判断不许把它当成真。
 */

import { existsSync } from "fs";
import { teamSnapshotPath } from "../team-persistence.js";

/** H14：旧 team.json 永不恢复。IPC 层任何「可恢复」判断都必须读它。 */
export const LEGACY_SNAPSHOT_RESTORABLE = false;

/** 旧快照探测：只看文件是否存在，不解析、不读取内容、不做 glob。 */
export function detectLegacyTeamSnapshot(physicalCwd: string): boolean {
  return existsSync(teamSnapshotPath(physicalCwd));
}

/** `has-legacy-team-snapshot` 之后的可恢复性判断：恒定 false（H14）。 */
export function isLegacySnapshotRestorable(): boolean {
  return LEGACY_SNAPSHOT_RESTORABLE;
}
