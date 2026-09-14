/**
 * 旧 Team 持久化的残留部分（plan §2.2 / §6.1）。
 *
 * 圆桌自己的落盘在 `team/persistence.ts`（`roundtables/<sha1>/…`）。本文件只保留：
 * - 工作区模式偏好（`team-state/<sha1>/mode.json`）：既有用户偏好，不丢；
 * - 旧快照路径 `teamSnapshotPath`：只给 `team/legacy-snapshot.ts` 做「有旧快照」探测，
 *   旧 team.json **永不恢复**（H14）。
 *
 * 已删除：createPersistedTeamSnapshot / persistTeamSnapshot / deletePersistedTeamSnapshot /
 * readPersistedTeamSnapshot / isRestorableTeamSnapshot / hydratePersistedTeam（旧 v1 编排语义）。
 */

import { createHash, randomUUID } from "crypto";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * 旧快照路径 `getAgentDir()/team-state/<sha1(cwd)>/team.json`。
 * 仅 `detectLegacyTeamSnapshot` 使用；圆桌不读、不写、不删这个文件。
 */
export function teamSnapshotPath(cwd: string): string {
  const cwdHash = createHash("sha1").update(cwd).digest("hex");
  return join(getAgentDir(), "team-state", cwdHash, "team.json");
}

/** The user's last-chosen workspace mode for a project, persisted per-cwd. */
export type WorkspaceMode = "team" | "solo";

export function workspaceModePath(cwd: string): string {
  const cwdHash = createHash("sha1").update(cwd).digest("hex");
  return join(getAgentDir(), "team-state", cwdHash, "mode.json");
}

/** Read the persisted workspace mode. Returns null when no preference exists. */
export async function readWorkspaceMode(cwd: string): Promise<WorkspaceMode | null> {
  try {
    const raw = await readFile(workspaceModePath(cwd), "utf-8");
    const parsed = JSON.parse(raw) as { mode?: unknown };
    return parsed.mode === "team" || parsed.mode === "solo" ? parsed.mode : null;
  } catch {
    return null;
  }
}

/** Persist the user's chosen workspace mode for a project. */
export async function writeWorkspaceMode(cwd: string, mode: WorkspaceMode): Promise<void> {
  const path = workspaceModePath(cwd);
  await mkdir(dirname(path), { recursive: true });
  // Atomic write so a crash mid-write can never leave a half-written mode.json.
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify({ mode }, null, 2), "utf-8");
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
