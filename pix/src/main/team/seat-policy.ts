/**
 * 席位工具策略 override（plan §4.6 / §5.7，H10 / H11 / H12 / H29 / H30 / H40 / AC-6）。
 *
 * 硬约束：
 * - 回调**永不返回 `undefined`**。undefined 会回落到 `inspectToolExecution`，
 *   而它在 `mode === "approval"` 时会放行 bash。
 * - **忽略 `input.mode`**，只看席位 `ToolAuthTier`。
 * - throw 由 SDK fail-closed 处理（本文件不吞异常）。
 *
 * 类型 `HostToolPolicyOverride` / `HostToolPolicyInput` / `ToolPolicyDecision`
 * 从 coding-agent 包根引用，禁止本地复制（plan §4.6）。
 */

import { basename } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import type {
  HostToolPolicyInput,
  HostToolPolicyOverride,
  ToolPolicyDecision,
} from "@earendil-works/pi-coding-agent";
import { isPathInsideCwd } from "@earendil-works/pi-coding-agent";
import type { ToolAuthTier } from "../../shared/team-types.js";
import type { WriteLeaseTable } from "./write-lease.js";

/** 席位 shell 工具名（取代内置 bash，H10）。 */
export const TEAM_BASH_TOOL_NAME = "team_bash";

/** 只读四工具：H35 的 tools 白名单与受限档路径约束都围绕它们。 */
export const READ_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

/**
 * 任意档位一律 deny 的内置 / agent / plan / workflow 工具名（H10 / H12 / H29）。
 * 席位 session 的 `excludeTools` 已排除它们，这里是双保险：即使某次
 * createAgentSession 漏配，策略层也不放行。
 */
export const SEAT_DENIED_TOOL_NAMES: ReadonlySet<string> = new Set([
  // H10：内置 shell 及其后台三件套
  "bash",
  "run_background",
  "read_output",
  "stop_process",
  // H12 / H29：会进入 solo AgentTaskScheduler 的工具
  "agent",
  "inspect_agent_task",
  "get_goal",
  "create_goal",
  "update_goal",
  // plan / workflow 工具名
  "submit_user_plan",
  "update_plan_step",
  "workflow",
  "ralph",
  "ralph-loop",
  "submit_workflow_result",
]);

/** 一次拒绝的信息：`writeEntry` 为 true 时 §5.7 要求一条系统时间线提示。 */
export interface SeatPolicyDenialInfo {
  seatId: string;
  toolName: string;
  auth: ToolAuthTier;
  reason: string;
  /** 模型可见的原始路径参数（有则带上）。 */
  path?: string;
  /** 是否属于写入口（edit / write / team_bash / 内置 shell / MCP / 未知名）。 */
  writeEntry: boolean;
}

export interface CreateSeatToolPolicyArgs {
  getAuth: (seatId: string) => ToolAuthTier;
  /** write 档不读；restricted 档的路径前缀白名单，undefined 视为空。 */
  getAllowlist: (seatId: string) => string[] | undefined;
  /** read_only 档 team_bash 的精确命令白名单。 */
  getReadonlyCommands: (seatId: string) => string[];
  /** 仅 write 档有效；restricted 档忽略（H11）。 */
  bashEnabled: (seatId: string) => boolean;
  leases: WriteLeaseTable;
  /** 席位看到的逻辑 cwd；路径解析由 leases 注入的 resolver 绑定（H31）。 */
  logicalCwd: string;
  seatId: string;
  teamToolNames: string[];
  /**
   * 同步、无 IO 的拒绝回调：S4 接成系统 TimelineItem（§5.7）。只有写入口
   * （`writeEntry`）的拒绝会触发，read/grep/find/ls 的档位拒绝不触发。
   */
  onDenied?: (info: SeatPolicyDenialInfo) => void;
}

/** plan §4.6 的策略表。返回的回调在任意输入下都给出决定，永不返回 undefined。 */
export function createSeatToolPolicy(args: CreateSeatToolPolicyArgs): HostToolPolicyOverride {
  const teamTools = new Set(args.teamToolNames);
  const leases = args.leases;

  const decide = (input: HostToolPolicyInput): ToolPolicyDecision => {
    const toolName = input.toolName;
    const auth = args.getAuth(args.seatId);

    // H29 双保险：内置 shell / agent / plan / workflow 一律 deny，与档位无关。
    // 必须先于 teamToolNames 放行判断：H29 的意义正是「即使调用方漏配 excludeTools
    // 也不放行」，因此 deny 名单永远压过 teamToolNames。正常配置下两者不相交
    // （§4.11 席位工具名不含任何一个被禁名），此处只兜住漏配。
    if (SEAT_DENIED_TOOL_NAMES.has(toolName)) {
      return refuse(
        input,
        auth,
        `Team seat policy: "${toolName}" is not available to roundtable seats. Shell commands go through team_bash with explicit leased paths.`,
      );
    }

    // 回归入口：席位工具（team_bash 除外）各自有边界检查，任意档位放行。
    if (teamTools.has(toolName) && toolName !== TEAM_BASH_TOOL_NAME) {
      return { allowed: true };
    }

    if (toolName === TEAM_BASH_TOOL_NAME) {
      return decideTeamBash(input, auth);
    }

    if (READ_TOOL_NAMES.has(toolName)) {
      return decideRead(input, auth);
    }

    if (toolName === "edit" || toolName === "write") {
      return decideMutation(input, auth);
    }

    // MCP / 扩展 / 未知名：write 档也不放行，未知写入入口默认拒绝（AC-6）。
    return refuse(
      input,
      auth,
      `Team seat policy: unknown tool "${toolName}" is denied for roundtable seats; unknown write entry points default to deny.`,
    );
  };

  function decideRead(input: HostToolPolicyInput, auth: ToolAuthTier): ToolPolicyDecision {
    const path = pathFromToolArgs(input.args);

    if (auth === "restricted") {
      // H30：受限档必须带显式 path，缺 path 视为「针对整个 cwd」→ deny。
      if (!path) {
        return refuse(
          input,
          auth,
          `Restricted seat: "${input.toolName}" requires an explicit path inside the seat path allowlist; without one it would cover the whole cwd (${args.logicalCwd}).`,
        );
      }
      // 空白条目会被解析成 cwd，等于放开整场：直接忽略，不参与前缀匹配。
      const allowlist = (args.getAllowlist(args.seatId) ?? []).filter((entry) => entry.trim().length > 0);
      const posix = input.pathContext?.pathStyle === "posix";
      const key = resolveRestrictedKey(leases.pathKeyOf(path), posix);
      if (!allowlist.some((entry) => isUnderPrefix(key, normalizePrefix(resolveRestrictedKey(leases.pathKeyOf(entry), posix))))) {
        return refuse(
          input,
          auth,
          `Restricted seat: "${path}" is outside the seat path allowlist.`,
        );
      }
    } else if (auth !== "read_only" && auth !== "write") {
      // auth 只应是三档之一。未知值（例如 meta.json 被改坏）绝不按最宽档处理。
      return refuse(
        input,
        auth,
        `Unknown seat tier "${String(auth)}": read tools are denied until the tier is corrected.`,
      );
    }

    // 只读四工具在他人持约路径上仍允许 read，但必须登记（H40）。
    if (path) leases.noteRead(args.seatId, path);
    return { allowed: true };
  }

  function decideMutation(input: HostToolPolicyInput, auth: ToolAuthTier): ToolPolicyDecision {
    const path = pathFromToolArgs(input.args);
    if (auth !== "write") {
      return refuse(
        input,
        auth,
        `Seat tier "${auth}" cannot use "${input.toolName}". Only the write tier may mutate files.`,
      );
    }
    if (!path) {
      return refuse(
        input,
        auth,
        `Write seat: "${input.toolName}" has no path argument, so no write lease can be taken.`,
      );
    }

    const outside = mutationPathDenied(input, path, args.logicalCwd);
    if (outside !== undefined) {
      return refuse(input, auth, outside, path);
    }

    // 已持约，或本调用内 acquire 成功（plan §4.6）。被拒时租约表已发
    // Attention write_conflict（H44）。
    const acquired = leases.acquire(args.seatId, path);
    if (acquired.ok) return { allowed: true };
    if ("staleRead" in acquired) {
      return refuse(
        input,
        auth,
        `Write seat: "${path}" was read before another seat took the write lease. Read it again, then retry.`,
      );
    }
    return refuse(
      input,
      auth,
      `Write seat: "${path}" is leased by ${acquired.ownerSeatId}. Wait for it to be released or ask that seat to hand it over.`,
    );
  }

  function decideTeamBash(input: HostToolPolicyInput, auth: ToolAuthTier): ToolPolicyDecision {
    // H11：受限档永不开放 team_bash，bashEnabled 被忽略（不查询）。
    if (auth === "restricted") {
      return refuse(
        input,
        auth,
        `Restricted seat: "${TEAM_BASH_TOOL_NAME}" is never allowed for this tier.`,
      );
    }

    const command = isRecord(input.args) && typeof input.args.command === "string" ? input.args.command : undefined;

    if (auth === "read_only") {
      const allowlist = args.getReadonlyCommands(args.seatId);
      if (command !== undefined && allowlist.includes(command)) return { allowed: true };
      return refuse(
        input,
        auth,
        `Read-only seat: "${TEAM_BASH_TOOL_NAME}" is limited to the seat's readonly command allowlist. Blocked ${command === undefined ? "a command-free call" : JSON.stringify(command)}.`,
      );
    }

    if (auth !== "write") {
      // 未知档位 fail-closed：只有 write 档才走下面的 shell 分支（H11 的对称面）。
      return refuse(
        input,
        auth,
        `Unknown seat tier "${String(auth)}": "${TEAM_BASH_TOOL_NAME}" is denied.`,
      );
    }

    // write 档：bashEnabled 且 paths 非空且全部已持约。禁止解析 command 文本。
    if (!args.bashEnabled(args.seatId)) {
      return refuse(input, auth, `Write seat: "${TEAM_BASH_TOOL_NAME}" is disabled for this seat.`);
    }
    const paths = pathListFromArgs(input.args);
    if (!paths || paths.length === 0) {
      return refuse(
        input,
        auth,
        `Write seat: "${TEAM_BASH_TOOL_NAME}" requires a non-empty paths list covering every file it touches.`,
      );
    }
    const unleased = paths.filter((path) => leases.ownerOf(path) !== args.seatId);
    if (unleased.length > 0) {
      return refuse(
        input,
        auth,
        `Write seat: "${TEAM_BASH_TOOL_NAME}" paths must all be leased by this seat. Not leased: ${unleased.join(", ")}.`,
        paths[0],
      );
    }
    return { allowed: true };
  }

  function refuse(
    input: HostToolPolicyInput,
    auth: ToolAuthTier,
    reason: string,
    path = pathFromToolArgs(input.args),
  ): ToolPolicyDecision {
    const writeEntry = !READ_TOOL_NAMES.has(input.toolName);
    if (writeEntry) {
      args.onDenied?.({ seatId: args.seatId, toolName: input.toolName, auth, reason, path, writeEntry });
    }
    return { allowed: false, reason };
  }

  return decide;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 取工具调用的路径参数。键名与 coding-agent `file-change.ts` 的
 * `getPathFromToolArgs` 一致（它没有从包根导出）；四个内置工具实际用的都是
 * `path`，其余键保留以兼容旧参数名。
 */
function pathFromToolArgs(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  for (const key of ["path", "file_path", "file", "target"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** team_bash 的 `paths: string[]`；缺失、非数组或含非字符串项都视为不可用。 */
function pathListFromArgs(args: unknown): string[] | undefined {
  if (!isRecord(args)) return undefined;
  const value = args.paths;
  if (!Array.isArray(value)) return undefined;
  const paths: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) return undefined;
    paths.push(entry);
  }
  return paths;
}

/** 去掉尾部分隔符，保留根 `/` 与 `C:\` 形态。 */
function normalizePrefix(key: string): string {
  let end = key.length;
  while (end > 1) {
    const ch = key[end - 1];
    if (ch !== "/" && ch !== "\\") break;
    if (key[end - 2] === ":") break;
    end--;
  }
  return key.slice(0, end);
}

/**
 * 写档路径边界（Team 永不回落到 inspectToolExecution，所以必须自己做）：
 * cwd 内、非 Windows 保留设备名、WSL 下拒绝盘符/UNC。
 */
function mutationPathDenied(input: HostToolPolicyInput, path: string, logicalCwd: string): string | undefined {
  const posix = input.pathContext?.pathStyle === "posix";
  const cwd = input.cwd.length > 0 ? input.cwd : logicalCwd;
  const leaf = basename(path).split(".")[0]?.toLowerCase();
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(leaf ?? "")) {
    return `Write seat: refusing Windows reserved device path "${path}".`;
  }
  if (posix && isWindowsStylePath(path)) {
    return `Write seat: refusing Windows-style path "${path}" in WSL. Use a Linux path.`;
  }
  if (!isPathInsideCwd(path, cwd, { posix })) {
    return `Write seat: "${path}" is outside the workspace (${cwd}). Roundtable writes stay inside the project.`;
  }
  return undefined;
}

function isWindowsStylePath(path: string): boolean {
  const trimmed = path.trim();
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  if (/^\\\\[^\\]/.test(trimmed) || trimmed.startsWith("\\\\")) return true;
  return false;
}

/**
 * 受限档判定用：本地跟 symlink（realpath），结果不写入 pathKey（H31）。
 * WSL/posix 不用 host realpath（看的是 Windows 视图）。文件不存在时保持词法 key。
 */
function resolveRestrictedKey(key: string, posix: boolean): string {
  if (posix) {
    return key;
  }
  try {
    if (!existsSync(key)) {
      return key;
    }
    return realpathSync(key);
  } catch {
    return key;
  }
}

/** `key` 等于前缀本身或落在其下；`/a/src-evil` 不算 `/a/src` 之内。 */
function isUnderPrefix(key: string, prefix: string): boolean {
  if (key === prefix) return true;
  if (prefix.endsWith("/") || prefix.endsWith("\\")) return key.startsWith(prefix);
  return key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}\\`);
}
