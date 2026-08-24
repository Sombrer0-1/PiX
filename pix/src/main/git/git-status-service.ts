/**
 * Git workdir status service (PiX 1.5.0, SDD §4.3.3).
 *
 * Orchestrates four read-only git commands against the project directory and
 * produces a GitWorkdirSnapshot (pure metadata: no file contents, no diff
 * text, no commit history; git stderr is never exposed beyond a stable
 * errorCode):
 *
 *   1. rev-parse --show-toplevel            -> repository detection + scope
 *   2. status --porcelain=v2 --branch -z    -> branch/upstream + changed files
 *   3. diff --cached --numstat -z           -> staged-side line counts
 *   4. diff --numstat -z                    -> worktree-side line counts
 *
 * Parsing follows the git official formats (verified against the porcelain v2
 * / numstat docs): with -z, porcelain v2 header lines are terminated by NUL
 * (newer git) or LF (older git), records are NUL-terminated with
 * space-separated fields, and a rename/copy record's origPath follows the
 * record as a bare NUL-separated field. numstat -z records are
 * "added\tremoved\tpath\0" with "-" counts for binary files. Paths are
 * repo-root-relative POSIX, taken verbatim (-z mode has no quoting, no
 * re-decoding; newline bytes in paths are preserved — LF splitting applies
 * only to header chunks). Truncated output is parsed as far as complete
 * records go; the incomplete trailing record is dropped.
 */

import { existsSync } from "node:fs";
import { isProjectLocationLike } from "../../shared/types.js";
import type {
  GitChangedFile,
  GitErrorCode,
  GitWorkdirCounts,
  GitWorkdirSnapshot,
  ProjectLocation,
} from "../../shared/types.js";
import { createGitCommandRunner } from "./git-command.js";
import type { GitCommandOutput, GitRunnerEnvironment } from "./git-command.js";

export interface GitStatusService {
  getStatus(location: ProjectLocation): Promise<GitWorkdirSnapshot>;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** 创建 Git 状态采集服务（只读；错误只透传稳定 errorCode，不透传 stderr 原文）。 */
export function createGitStatusService(options?: {
  timeoutMs?: number;        // 默认 2000
  maxOutputBytes?: number;   // 默认 1 MiB
  /** 测试缝：默认 createGitCommandRunner；tsx 测试注入 fake runner。 */
  createRunner?: typeof createGitCommandRunner;
}): GitStatusService {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const createRunner = options?.createRunner ?? createGitCommandRunner;

  return {
    async getStatus(location: ProjectLocation): Promise<GitWorkdirSnapshot> {
      const observedAt = Date.now();

      // 1. location 结构非法（守卫只验结构不验语义）。
      if (!isProjectLocationLike(location)) {
        return unavailable("invalid_location", observedAt);
      }

      // 2. Windows 侧 cwd 存在性预检（#14）：项目目录被删/改名时 spawn 以
      //    ENOENT 抛错（与 git 二进制缺失同码，runner 无法区分），此处廉价
      //    判定并归为 invalid_location；WSL 侧 cwd 由 wsl.exe --cd 处理（失败
      //    走 exitCode ≠ 0 → execution_failed，不误报），维持现状不做预检。
      if (location.environment.kind === "windows" && !existsSync(location.physicalPath)) {
        return unavailable("invalid_location", observedAt);
      }
      // 一次快照一个 runner（cwd 恒定，run 只传 git 参数）。
      const env: GitRunnerEnvironment =
        location.environment.kind === "wsl"
          ? { kind: "wsl", distro: location.environment.distro }
          : { kind: "windows" };
      const runner = createRunner(
        env,
        { logical: location.path, physical: location.physicalPath },
        { timeoutMs, maxStdoutBytes: maxOutputBytes },
      );

      // 3. 仓库探测：toplevel、嵌套 scope、repositoryName。
      const toplevelResult = await runner.run(["rev-parse", "--show-toplevel"]);
      if (toplevelResult.notFound) return unavailable("git_not_found", observedAt);
      if (toplevelResult.timedOut) return unavailable("timeout", observedAt);
      if (toplevelResult.exitCode !== 0) {
        if (containsIgnoreCase(toplevelResult.stderr, "not a git repository")) {
          return { kind: "not-repository", files: [], complete: true, observedAt };
        }
        // WSL 发行版内 git 缺失：exitCode 127 或 stderr 含 command not found
        // （runner 不猜，判定放服务层）。
        if (toplevelResult.exitCode === 127 || containsIgnoreCase(toplevelResult.stderr, "command not found")) {
          return unavailable("git_not_found", observedAt);
        }
        return unavailable("execution_failed", observedAt);
      }
      const toplevel = firstLine(toplevelResult.stdout).trim();
      if (!toplevel) return unavailable("execution_failed", observedAt);
      // projectRoot：WSL 取 location.path（posix 语义、严格字符串比较）；
      // Windows 取 location.physicalPath（win32 语义：两侧统一斜杠方向且
      // 大小写不敏感后再比较——git 在 Windows 输出的 toplevel 为正斜杠形式）。
      const scopedToProject =
        env.kind === "wsl" ? toplevel !== location.path : !pathsEqualWin32(toplevel, location.physicalPath);
      const repositoryName = basenamePosix(toplevel);

      // 4. status（porcelain v2, -z）。全局前缀由 runner 注入，勿重复。
      const statusResult = await runner.run([
        "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--", ".",
      ]);
      if (statusResult.notFound) return unavailable("git_not_found", observedAt);
      if (statusResult.timedOut) return unavailable("timeout", observedAt);
      if (statusResult.exitCode !== 0) return unavailable("execution_failed", observedAt);
      // truncated → complete:false 后仍解析已收集部分（残缺尾部记录丢弃）。
      let complete = !statusResult.truncated;
      const parsed = parseStatusOutput(statusResult.stdout);

      // 5. 行数统计：暂存侧 + 工作区侧（--no-renames 使 numstat 每条记录恰
      //    一个路径；重命名的旧路径记录按 origPath 反查归并进新路径文件）。
      const cachedResult = await runner.run([
        "diff", "--cached", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--", ".",
      ]);
      if (cachedResult.notFound) return unavailable("git_not_found", observedAt);
      if (cachedResult.timedOut) return unavailable("timeout", observedAt);
      if (cachedResult.exitCode !== 0) return unavailable("execution_failed", observedAt);
      if (cachedResult.truncated) complete = false;

      const worktreeResult = await runner.run([
        "diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--", ".",
      ]);
      if (worktreeResult.notFound) return unavailable("git_not_found", observedAt);
      if (worktreeResult.timedOut) return unavailable("timeout", observedAt);
      if (worktreeResult.exitCode !== 0) return unavailable("execution_failed", observedAt);
      if (worktreeResult.truncated) complete = false;

      // 6. 文件表：status 记录 → flags；numstat → 行数（同名合计、旧路径经
      //    origPath 归并）。
      const files = buildFiles(parsed.records);
      applyNumstat(files, cachedResult.stdout);
      applyNumstat(files, worktreeResult.stdout);
      const sortedFiles = [...files.values()].sort(compareFiles);

      // 8. observedAt 固定为快照采集时刻。
      // 9. 空仓库（unborn HEAD）且无任何改动：emptyRepo:true（renderer 显示
      //    「(空仓库)」）。unborn HEAD 下已暂存/未跟踪记录仍由第 4/5 步正常
      //    产出，files/counts 恒用真实聚合，不因 emptyRepo 抹除。
      const emptyRepo =
        (parsed.headers.oid === "(initial)" || parsed.headers.head === "(unknown)") &&
        sortedFiles.length === 0;
      const snapshot: GitWorkdirSnapshot = {
        kind: "repository",
        repositoryName,
        scopedToProject,
        files: sortedFiles,
        complete,
        observedAt,
      };
      if (parsed.headers.head === "(detached)") {
        if (parsed.headers.oid !== undefined && parsed.headers.oid !== "(initial)") {
          snapshot.detachedHeadOid = parsed.headers.oid.slice(0, 7);
        }
      } else if (!emptyRepo && parsed.headers.head !== undefined) {
        snapshot.branch = parsed.headers.head;
      }
      if (parsed.headers.upstream !== undefined) {
        snapshot.upstream = {
          ref: parsed.headers.upstream,
          ahead: parsed.headers.ahead ?? 0,
          behind: parsed.headers.behind ?? 0,
        };
      }
      if (emptyRepo) snapshot.emptyRepo = true;
      snapshot.counts = aggregateCounts(sortedFiles);
      return snapshot;
    },
  };
}

function unavailable(errorCode: GitErrorCode, observedAt: number): GitWorkdirSnapshot {
  return { kind: "unavailable", files: [], complete: false, observedAt, errorCode };
}

function containsIgnoreCase(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function firstLine(text: string): string {
  const nl = text.indexOf("\n");
  return nl < 0 ? text : text.slice(0, nl);
}

function pathsEqualWin32(a: string, b: string): boolean {
  return a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
}

/** 仓库根 basename（兼容正斜杠/反斜杠两种形式）。 */
function basenamePosix(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const sep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return sep < 0 ? trimmed : trimmed.slice(sep + 1);
}

// ============================================================================
// porcelain v2 (-z) 解析
// ============================================================================

interface StatusHeaders {
  oid?: string;
  head?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

interface StatusRecord {
  kind: "changed" | "unmerged" | "untracked";
  xy: string;
  /** 仓库根相对 POSIX 路径（重命名取新路径）。 */
  path: string;
  /** type "2"（rename/copy）记录尾随的 origPath 字段。 */
  origPath?: string;
  isRename: boolean;
}

function parseStatusOutput(stdout: string): { headers: StatusHeaders; records: StatusRecord[] } {
  const headers: StatusHeaders = {};
  const records: StatusRecord[] = [];
  // -z 格式：头行以 NUL（新 git）或 LF（旧 git）终止；记录以 NUL 终止；
  // 重命名记录的 origPath 是记录后的裸 NUL 字段。split 后末元素要么是结尾
  // NUL 产生的空串、要么是截断产生的残缺尾部记录——一律丢弃。
  const chunks = stdout.split("\0");
  chunks.pop();
  for (const chunk of chunks) {
    if (chunk.startsWith("# ")) {
      // 仅头行 chunk 做 LF 切分（兼容旧 git 的 LF 头行终止；旧 git 下首个
      // 记录与 LF 头行同 chunk）。其余 chunk 整体作为记录或 origPath 处理：
      // 路径本就是末字段的空格 join，保留换行字节无损（-z 无 quoting、不做
      // 二次解码，文件名可含换行字节，按原样接收）。
      for (const line of chunk.split(/\r?\n/)) {
        if (line.startsWith("# ")) {
          applyHeader(headers, line.slice(2));
        } else {
          handleStatusLine(line, records);
        }
      }
      continue;
    }
    handleStatusLine(chunk, records);
  }
  return { headers, records };
}

/** 处理一条非头行内容：记录（"1 "/"2 "/"u "/"? " 前缀）或裸 origPath 字段。 */
function handleStatusLine(line: string, records: StatusRecord[]): void {
  if (line.length === 0) return;
  const type = line.slice(0, 2);
  if (type === "1 " || type === "2 " || type === "u " || type === "? ") {
    records.push(parseStatusRecord(line));
    return;
  }
  // 裸路径 = 上一条 rename/copy 记录的 origPath 字段。
  const last = records[records.length - 1];
  if (last !== undefined && last.isRename && last.origPath === undefined) {
    last.origPath = line;
  }
}

function applyHeader(headers: StatusHeaders, body: string): void {
  const space = body.indexOf(" ");
  const key = space < 0 ? body : body.slice(0, space);
  const value = space < 0 ? "" : body.slice(space + 1);
  switch (key) {
    case "branch.oid":
      headers.oid = value;
      break;
    case "branch.head":
      headers.head = value;
      break;
    case "branch.upstream":
      headers.upstream = value;
      break;
    case "branch.ab": {
      const match = /^\+(\d+) -(\d+)$/.exec(value);
      if (match) {
        headers.ahead = Number(match[1]);
        headers.behind = Number(match[2]);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * 记录字段以空格分隔（-z 只改变记录终止符与 origPath 分隔），路径为末字段、
 * 可能含空格，按索引切片。字段布局以 git-status(1) porcelain v2 官方格式为准
 * （已对照本机 git 2.54 实测输出）：
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>            → path 在字段 7
 *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> → path 在字段 8
 *   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>  → path 在字段 9
 */
function parseStatusRecord(line: string): StatusRecord {
  const type = line[0];
  const rest = line.slice(2);
  if (type === "?") {
    return { kind: "untracked", xy: "", path: rest, isRename: false };
  }
  const fields = rest.split(" ");
  const xy = fields[0] ?? "";
  if (type === "1") {
    return { kind: "changed", xy, path: fields.slice(7).join(" "), isRename: false };
  }
  if (type === "2") {
    return { kind: "changed", xy, path: fields.slice(8).join(" "), isRename: true };
  }
  if (type === "u") {
    return { kind: "unmerged", xy, path: fields.slice(9).join(" "), isRename: false };
  }
  return { kind: "changed", xy: "", path: "", isRename: false };
}

// ============================================================================
// numstat (-z) 解析与文件表组装
// ============================================================================

function buildFiles(records: StatusRecord[]): Map<string, GitChangedFile> {
  const files = new Map<string, GitChangedFile>();
  for (const record of records) {
    if (record.path.length === 0) continue;
    let file = files.get(record.path);
    if (file === undefined) {
      file = {
        path: record.path,
        staged: false,
        unstaged: false,
        untracked: false,
        conflict: false,
        renamed: false,
        deleted: false,
        additions: null,
        deletions: null,
      };
      files.set(record.path, file);
    }
    if (record.kind === "untracked") {
      file.untracked = true;
      continue;
    }
    if (record.kind === "unmerged") {
      file.conflict = true;
      continue;
    }
    // 按 X/Y 列映射：X≠'.'→staged，Y≠'.'→unstaged，含 R/C→renamed，含 D→deleted。
    if (record.xy[0] !== undefined && record.xy[0] !== ".") file.staged = true;
    if (record.xy[1] !== undefined && record.xy[1] !== ".") file.unstaged = true;
    if (record.xy.includes("R") || record.xy.includes("C")) file.renamed = true;
    if (record.xy.includes("D")) file.deleted = true;
    if (record.origPath !== undefined) file.origPath = record.origPath;
  }
  return files;
}

/**
 * numstat 记录：added TAB removed TAB path NUL；二进制计数为 "-" → null。
 * 按 path 累加进 status 已知路径；path 未命中文件表时按 origPath 反查归并
 * ——重命名的旧路径记录（--no-renames 下 numstat 输出旧路径 0/-M 记录，
 * porcelain 只列新路径）经 origPath 归并进新路径文件的 deletions，避免总
 * 删除行数被低估。冲突文件即使出现在 numstat 中（实测 git 2.54 对未合并
 * 路径会输出 0/0 或冲突内容计数）也不参与——SDD §4.3.3：冲突行不参与
 * numstat，行数保持 null。
 */
function applyNumstat(files: Map<string, GitChangedFile>, stdout: string): void {
  const chunks = stdout.split("\0");
  chunks.pop(); // 结尾 NUL 的空串或截断残缺记录，一律丢弃
  for (const chunk of chunks) {
    const parts = chunk.split("\t");
    if (parts.length < 3) continue;
    const added = parseNumstatCount(parts[0]!);
    const deleted = parseNumstatCount(parts[1]!);
    const path = parts.slice(2).join("\t");
    let file = files.get(path);
    if (file === undefined) {
      // 旧路径记录：遍历文件表找 origPath === path 的重命名文件归并（表小，
      // 直接迭代；origPath 只存在于 type 2 记录，命中唯一）。
      for (const candidate of files.values()) {
        if (candidate.origPath === path) {
          file = candidate;
          break;
        }
      }
    }
    if (file === undefined || file.conflict) continue;
    if (added !== null) file.additions = (file.additions ?? 0) + added;
    if (deleted !== null) file.deletions = (file.deletions ?? 0) + deleted;
  }
}

function parseNumstatCount(value: string): number | null {
  if (value === "-") return null;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

// ============================================================================
// 汇总与排序（§6.3：冲突 > 未跟踪 > 已修改（staged/unstaged 任一）> 已删除 >
// 重命名；同级 path 字典序。分组优先级取该文件可归属的最高组）
// ============================================================================

function aggregateCounts(files: GitChangedFile[]): GitWorkdirCounts {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicts = 0;
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    if (file.staged) staged++;
    if (file.unstaged) unstaged++;
    if (file.untracked) untracked++;
    if (file.conflict) conflicts++;
    if (file.additions !== null) additions += file.additions;
    if (file.deletions !== null) deletions += file.deletions;
  }
  return { staged, unstaged, untracked, conflicts, additions, deletions };
}

function fileGroupPriority(file: GitChangedFile): number {
  if (file.conflict) return 0;
  if (file.untracked) return 1;
  if (file.staged || file.unstaged) return 2;
  if (file.deleted && !file.renamed) return 3;
  if (file.renamed) return 4;
  return 5;
}

function compareFiles(a: GitChangedFile, b: GitChangedFile): number {
  const ga = fileGroupPriority(a);
  const gb = fileGroupPriority(b);
  if (ga !== gb) return ga - gb;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
