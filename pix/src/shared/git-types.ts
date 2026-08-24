/**
 * Plain-data contract for the PiX Git workdir panel (1.5.0).
 *
 * Shared by main (git-status-service, ipc-git-adapters) and renderer
 * (useGitStatus, GitWorkdirCard), so this is a leaf module: no runtime
 * imports (not even each other between git-types and btw-types), every value
 * here survives structuredClone / JSON round-trips and the renderer can
 * import it directly.
 *
 * isProjectLocationLike is the renderer → main location structural guard
 * (narrowing, shape only, no semantics); ipc-git-adapters and the renderer do
 * not re-implement it.
 */

/** 单个变更文件行（纯元数据，无内容）。 */
export interface GitChangedFile {
  /** 仓库根相对 POSIX 路径（重命名取新路径）。 */
  path: string;
  /** 重命名时的原路径（tooltip 用）。 */
  origPath?: string;
  /** 暂存侧有改动（porcelain v2 X 列 ≠ '.'，含 staged rename）。 */
  staged: boolean;
  /** 工作区侧有改动（Y 列 ≠ '.'）。 */
  unstaged: boolean;
  /** 未跟踪（'?' 记录）。 */
  untracked: boolean;
  /** 冲突（'u' 记录）。 */
  conflict: boolean;
  /** 重命名（X 或 Y 为 R/C）。 */
  renamed: boolean;
  /** 删除（X 或 Y 为 D）。 */
  deleted: boolean;
  /** 暂存+工作区新增行合计；null = 二进制/未跟踪/冲突等不可统计。 */
  additions: number | null;
  /** 同上，删除行。 */
  deletions: number | null;
}

export interface GitUpstreamInfo {
  /** 如 "origin/master"。 */
  ref: string;
  ahead: number;
  behind: number;
}

export interface GitWorkdirCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  /** 全部已统计文件的 + 行合计（仅 complete 时精确）。 */
  additions: number;
  deletions: number;
}

export type GitErrorCode =
  | "git_not_found"     // git / wsl.exe 二进制不可用
  | "timeout"           // 单条命令超时（≤2s）
  | "execution_failed"  // 其它执行失败（exit≠0 非仓库语义、损坏等）
  | "invalid_location"; // location 结构非法

/**
 * Git 工作区快照。kind:
 *  - "repository"    : 正常数据（complete=false 表示输出超限截断）
 *  - "not-repository": 目录不在任何 Git 工作树内 → 卡片整体不显示
 *  - "unavailable"   : 采集失败 → renderer 保留上次快照并标 stale；首次则显示错误+重试
 */
export interface GitWorkdirSnapshot {
  kind: "repository" | "not-repository" | "unavailable";
  repositoryName?: string;
  /** 项目目录嵌套于父仓库内时为 true（仓库行标注"（仅限项目目录）"）。 */
  scopedToProject?: boolean;
  /** 分支名；detached / 空仓库时缺省。 */
  branch?: string;
  /** detached HEAD 短 OID（7 位）。 */
  detachedHeadOid?: string;
  /** 空仓库（unborn HEAD）。 */
  emptyRepo?: boolean;
  upstream?: GitUpstreamInfo;
  /** kind==="repository" 时存在。 */
  counts?: GitWorkdirCounts;
  /** 已按 §6.3 排序规则排好的全量列表（字节上限内）。 */
  files: GitChangedFile[];
  /** false = 输出上限触发，统计与总数不得精确呈现。 */
  complete: boolean;
  observedAt: number;
  errorCode?: GitErrorCode;
}

/**
 * Non-throwing structural narrowing of an unknown value into the renderer →
 * main location shape (path/physicalPath/name/environment). Checks the shape
 * only, never the semantics (ipc-git-adapters and the renderer do not
 * re-implement it).
 */
export function isProjectLocationLike(value: unknown): value is {
  path: string;
  physicalPath: string;
  name: string;
  environment: { kind: "windows" } | { kind: "wsl"; distro: string };
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string") return false;
  if (typeof record.physicalPath !== "string") return false;
  if (typeof record.name !== "string") return false;
  const env = record.environment;
  if (typeof env !== "object" || env === null) return false;
  const envRecord = env as Record<string, unknown>;
  if (envRecord.kind === "wsl") return typeof envRecord.distro === "string";
  return envRecord.kind === "windows";
}
