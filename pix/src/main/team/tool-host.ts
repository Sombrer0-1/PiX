/**
 * RoundtableToolHost —— 席位工具到 facade 的唯一接缝（plan §4.12b / §2.4）。
 *
 * 席位工具（seat-tools.ts）不直接 import TeamManager：它们只拿这个接口，
 * 由 S4 的 facade 实现。接口形状与 plan §4.12b 逐字一致，只做两处必要的
 * 承载扩展（下面都有注释）：
 *
 * - `postSeatMessage` 的返回值多一个可选 `queued`：H28 的有序门收下 argument
 *   后 `send_team_message` 要立刻回 `{ ok: true, queued: true, messageId }`，
 *   这个标记只能由 host 传出来。
 * - `runTeamBash` 的实现在本文件（`runTeamBashCommand`），因为它的唯一硬约束
 *   是「cwd = SeatExecutionView.getCwd()，backend = host executionBackend，
 *   永不读 session.runtimeCwd」（H34）。facade 只负责把自己的 backend 传进来。
 */

import type { BashOperations, ExecutionBackend } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import {
  type KnowledgeCard,
  type OpenItem,
  type RoundtableState,
  type TimelineItem,
  type TimelineItemType,
  type UtteranceKind,
} from "../../shared/team-types.js";
import { MAX_BASH_OUTPUT_BYTES, MAX_BASH_OUTPUT_LINES } from "./constants.js";
import type { SeatExecutionView } from "./seat-runner.js";

/** `send_team_message` 的参数（plan §4.11）。 */
export interface SendTeamMessageParams {
  /** 展示名、seatId、"*" 或 "user"（H21：由 seat-tools 解析成 seatId / "*" / USER_SEAT_ID）。 */
  to: string;
  text: string;
  summary?: string;
  /** 缺省 note。 */
  utteranceKind?: UtteranceKind;
  /**
   * `timelineTypeFromUtterance(utteranceKind ?? "note")` 的结果。映射只有
   * team-types.ts 一份（§4.1），由 seat-tools 算好；host 直接用，禁止另发明。
   */
  type: TimelineItemType;
  replyToId?: string;
  basedOnId?: string;
  /** 缺省 L1；L2 必须带 reason。 */
  interrupt?: "L1" | "L2";
  reason?: string;
  threadId?: string;
  knowledgeCard?: KnowledgeCard;
  /**
   * H21 的 `@` 解析结果（seat-tools 用 seat-inbox 的 `parseMentions` 算好，
   * 与 `to` 取并集）。facade 不得自己再写一份解析。
   */
  mentionIds: string[];
}

/** H28：`queued: true` = 有序门已收下 argument（已记录时间线，尚未进 inbox）。 */
export type PostSeatMessageResult =
  | { ok: true; messageId: string; queued?: boolean }
  | { ok: false; error: string };

/**
 * 席位工具可以调用的 facade 面（plan §4.12b）。
 * `requestPermission` 同步返回 submitted：禁止返回待批 Promise（H23）。
 */
export interface RoundtableToolHost {
  getState(): RoundtableState | null;
  isRuntimeActive(): boolean;
  postSeatMessage(fromSeatId: string, params: SendTeamMessageParams): Promise<PostSeatMessageResult>;
  claimWritePaths(
    seatId: string,
    paths: string[],
  ): { ok: true; acquired: string[] } | { ok: false; conflicts: Array<{ path: string; ownerSeatId: string }> };
  releaseWritePaths(seatId: string, paths?: string[]): void;
  openItem(seatId: string, subject: string, body: string): OpenItem;
  claimOpenItem(seatId: string, id: string, note?: string): OpenItem | null;
  resolveOpenItem(seatId: string, id: string, note?: string): OpenItem | null;
  promoteThread(seatId: string, threadId: string, conclusion: string): TimelineItem;
  requestPeerExplore(fromSeatId: string, to: string, ask: string, scope?: string): Promise<void>;
  /**
   * 唯一权限生产者（H1/H23）：实现方在这里**同步**记录 pending 权限、发一条
   * Attention kind="permission" 与 `protocol_permission_request` 事件，然后返回
   * `{ requestId, submitted: true }`。禁止返回等待用户的 Promise。
   */
  requestPermission(
    seatId: string,
    tool: string,
    args: Record<string, unknown>,
    reason?: string,
  ): { requestId: string; submitted: true };
  requestExit(fromSeatId: string, targetSeatId: string | undefined, reason: string): Promise<void>;
  runTeamBash(
    seatId: string,
    command: string,
    paths: string[] | undefined,
    timeout: number | undefined,
    signal: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  /**
   * 形参顺序与 facade 实现、IPC 命令（`stance_on_deliverable` 的 `{id, seatId}`）
   * 对齐：**交付物 id 在前，席位 id 在后**。两者同为 string，顺序写错类型系统抓不到，
   * 而运行时会把 seatId 当成交付物 id（setStance 找不到该版）。
   *
   * `expectedRevision` 是调用方读到的 CAS 令牌。席位/用户路径必须带上；缺省只给
   * 内部首次 publish（drafting → ready）。
   */
  reviseDeliverable(
    id: string,
    markdown: string,
    actor: string,
    expectedRevision?: number,
  ): { ok: true } | { ok: false; conflict: true; currentVersion: number; currentRevision: number };
  stanceOnDeliverable(
    id: string,
    seatId: string,
    stance: "support" | "oppose" | "conditional",
    reason?: string,
    confidence?: "low" | "medium" | "high",
  ): { ok: true } | { ok: false; error: string };
}

/** `runTeamBash` 需要的输入：cwd 视图 + host 的 execution backend + 用户的 shell 设置。 */
export interface TeamBashContext {
  /** 席位 cwd 视图（H34）。cwd 只从这里来。 */
  exec: SeatExecutionView;
  /** host 的 executionBackend（对象身份与 host 相同）；缺省走本地 shell。 */
  backend?: Pick<ExecutionBackend, "bash"> | undefined;
  /**
   * 用户 `settings.shellPath`（F4-9）：solo 的 bash 用 `createLocalBashOperations({ shellPath })`，
   * 席位 team_bash 必须跑在同一个 shell 上，否则同一工作区里命令找不到 / 语法不兼容。
   * 只对本地 shell 分支生效；有 execution backend 时后端自己决定 shell。
   */
  shellPath?: string | undefined;
  /**
   * 用户 `settings.shellCommandPrefix`（F4-9）：与 `agent-session.ts` 的
   * `_executeBash` 同语义——拼在命令前、换行分隔。
   */
  shellCommandPrefix?: string | undefined;
  /** 测试注入：替换本地 shell 工厂（默认 `createLocalBashOperations`）。 */
  localBash?: ((shellPath?: string) => BashOperations) | undefined;
}

/**
 * `team_bash` 的执行本体（H10 / H34）：
 * cwd 取 `exec.getCwd()`（`executionBackend.getCwd?.() ?? logicalCwd`），
 * 后端取 host 的 `executionBackend.bash`，缺省时用 coding-agent 的本地 shell。
 * 绝不读 `session.runtimeCwd`（私有字段，无公开 getter）。
 *
 * `paths` 只服务于 policy 层的租约校验（S2b 已在校验阶段拦掉未持约的调用），
 * 执行阶段不再解析路径，因此本函数不接收它。
 *
 * 输出有上限（F4-1）：超过 `MAX_BASH_OUTPUT_BYTES` / `MAX_BASH_OUTPUT_LINES` 即截断，
 * 返回值长度因此有界（模型最多看到 50KB + 一行说明）。
 */
export async function runTeamBashCommand(
  context: TeamBashContext,
  command: string,
  timeoutSeconds: number | undefined,
  signal: AbortSignal | undefined,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const localBash = context.localBash ?? ((shellPath?: string) => createLocalBashOperations({ shellPath }));
  const bash: BashOperations = context.backend?.bash ?? localBash(context.shellPath);
  const cwd = context.exec.getCwd();
  // 与 agent-session.ts 的 _executeBash 同一写法：前缀在前、换行分隔。
  const prefix = context.shellCommandPrefix;
  const resolvedCommand = prefix !== undefined && prefix.length > 0 ? `${prefix}\n${command}` : command;

  // backend 的 onData 是 stdout+stderr 合并的单通道，没有分离通道：
  // 合并输出放 stdout，stderr 恒为空串（调用方/UI 不要指望它非空）。
  const output = new BoundedBashOutput();
  try {
    const result = await bash.exec(resolvedCommand, cwd, {
      onData: (data: Buffer) => {
        output.append(data);
      },
      signal,
      timeout: timeoutSeconds,
    });
    return { stdout: output.text(), stderr: "", exitCode: result.exitCode };
  } catch (err) {
    // timeout / abort 也要保留已产出的部分输出（F4-1）：只回一句「aborted」时
    // 席位无从判断命令跑到哪一步、要不要重试。
    const partial = output.text();
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(partial.length > 0 ? `${message}\n${partial}` : message);
  }
}

/** 截断说明：模型据此知道要看原文必须缩小命令范围。 */
const BASH_TRUNCATION_NOTICE = "…（输出已截断，原命令可缩小范围重跑）";

/**
 * `team_bash` 的输出累积器（F4-1）：字节 + 行双预算，超限后**只保留放得下的前缀**
 * 并停止累积。返回值因此有界，不会把 `chunks` 整块留下（一个 data 事件本身可能远超上限）。
 */
class BoundedBashOutput {
  private readonly parts: string[] = [];
  private bytes = 0;
  private lines = 0;
  private truncated = false;

  append(data: Buffer): void {
    if (this.truncated) {
      return;
    }
    const text = data.toString("utf8");
    const nextBytes = this.bytes + Buffer.byteLength(text, "utf8");
    const nextLines = this.lines + countNewlines(text);
    if (nextBytes <= MAX_BASH_OUTPUT_BYTES && nextLines <= MAX_BASH_OUTPUT_LINES) {
      this.parts.push(text);
      this.bytes = nextBytes;
      this.lines = nextLines;
      return;
    }
    this.truncated = true;
    const kept = clipToBudget(data, MAX_BASH_OUTPUT_BYTES - this.bytes, MAX_BASH_OUTPUT_LINES - this.lines);
    if (kept.length > 0) {
      this.parts.push(kept);
    }
  }

  /** stdout 正文；截断时末尾补一行说明。 */
  text(): string {
    const body = this.parts.join("");
    return this.truncated ? `${body}\n${BASH_TRUNCATION_NOTICE}` : body;
  }
}

/** 按「剩余字节 + 剩余行」双预算裁前缀（多字节字符不会被切坏到抛错）。 */
function clipToBudget(data: Buffer, remainingBytes: number, remainingLines: number): string {
  if (remainingBytes <= 0 || remainingLines <= 0) {
    return "";
  }
  const lineBound = indexAfterNthNewline(data, remainingLines);
  const lineClipped = lineBound === null ? data : data.subarray(0, lineBound);
  return lineClipped.subarray(0, remainingBytes).toString("utf8");
}

/** 第 n 个换行之后的字节偏移；不足 n 个换行时返回 null。 */
function indexAfterNthNewline(data: Buffer, count: number): number | null {
  let index = -1;
  for (let seen = 0; seen < count; seen++) {
    index = data.indexOf(0x0a, index + 1);
    if (index < 0) {
      return null;
    }
  }
  return index + 1;
}

function countNewlines(text: string): number {
  let count = 0;
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    count++;
  }
  return count;
}
