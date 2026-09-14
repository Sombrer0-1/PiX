/**
 * 协议状态机：权限请求 + 退出协商（plan §4.11 / §4.12 / §5.12，H4 / H23）。
 *
 * 两条硬规则（H23）：
 * - 权限是 **记录 + 立即返回**：`requestPermission` 同步记录并返回记录本身，
 *   绝不返回「等用户批准」的 Promise。没有超时拒绝，pause/abort 也不清权限：
 *   只有 `respondPermission` 才会写回结果。
 * - 退出协商用 `ExitRequest`（team-types）：`requestedBy` 的说法在创建时入账，
 *   对方说法走 `respondExit`。超时时间由调用方给（settings.exitRequestTimeoutMs，
 *   默认 EXIT_REQUEST_TIMEOUT_MS），到点后本类把状态落成 done 并回调 `onExitDue`，
 *   由调用方执行真正的移除。
 *
 * 本类不持有 session、不发注意力、不发 IPC：那些都是 facade 的事。
 */

import { randomUUID } from "crypto";
import type { PermissionRequest } from "../shared/types.js";
import { EXIT_REQUEST_TIMEOUT_MS } from "./team/constants.js";
import type { ExitRequest } from "../shared/team-types.js";

export interface RequestPermissionInput {
  /** 发起席（写入 PermissionRequest.agentId）。 */
  seatId: string;
  /** 圆桌名/Id（写入 PermissionRequest.teamName）。 */
  roundtableName: string;
  tool: string;
  args?: Record<string, unknown>;
  /** 席位给出的理由。 */
  reason?: string;
}

export interface RequestExitInput {
  targetSeatId: string;
  requestedBy: string;
  reason: string;
  /** 缺省 EXIT_REQUEST_TIMEOUT_MS（H4：120s，可在圆桌设置里改）。 */
  timeoutMs?: number;
}

export interface TeamProtocolManagerOptions {
  /** 退出协商到点且无对方答复时回调；调用方据此执行移除并记录双方说法。 */
  onExitDue?: (request: ExitRequest) => void;
}

export class TeamProtocolManager {
  private readonly pendingPermissions = new Map<string, PermissionRequest>();
  private readonly exits = new Map<string, ExitRequest>();
  private readonly exitTimers = new Map<string, NodeJS.Timeout>();
  private readonly onExitDue: ((request: ExitRequest) => void) | null;

  constructor(options: TeamProtocolManagerOptions = {}) {
    this.onExitDue = options.onExitDue ?? null;
  }

  // -- 权限请求（H23：记录 + 立即返回，永不因超时/pause 被拒） --

  /**
   * 记录一次权限请求并**同步**返回记录。调用方拿 requestId 立刻回工具
   * `{ ok: true, requestId, submitted: true }`，结果稍后由 `respondPermission`
   * 写回该席 inbox（L1）。这里不排队任何等待者。
   */
  requestPermission(input: RequestPermissionInput): PermissionRequest {
    const now = Date.now();
    const request: PermissionRequest = {
      id: randomUUID(),
      teamName: input.roundtableName,
      agentId: input.seatId,
      tool: input.tool,
      args: input.args ?? {},
      status: "pending",
      reason: input.reason,
      createdAt: now,
      updatedAt: now,
    };
    this.pendingPermissions.set(request.id, request);
    return { ...request };
  }

  /**
   * 用户批/拒。写回结果并把记录移出待批列表，返回**更新后的记录**（facade 用它
   * 往该席 inbox 写一条 L1 结果消息）。未知 id 返回 null。
   */
  respondPermission(requestId: string, approved: boolean, reason?: string): PermissionRequest | null {
    const request = this.pendingPermissions.get(requestId);
    if (request === undefined) {
      return null;
    }
    request.status = approved ? "approved" : "rejected";
    request.reason = reason;
    request.updatedAt = Date.now();
    this.pendingPermissions.delete(requestId);
    return { ...request };
  }

  /**
   * 同席同 `(tool, args)` 的待批请求（F3-10 幂等去重）：命中时调用方直接复用既有
   * requestId，不记新记录、不发第二条注意力、不触发又一次快照落盘。
   * `argsJson` 用调用方算好的 `JSON.stringify(args ?? {})`（同一个工具调用重放时
   * 键序一致，因此可比较）。
   */
  findPendingPermission(seatId: string, tool: string, argsJson: string): PermissionRequest | null {
    for (const request of this.pendingPermissions.values()) {
      if (request.agentId !== seatId || request.tool !== tool) {
        continue;
      }
      if (JSON.stringify(request.args ?? {}) === argsJson) {
        return { ...request };
      }
    }
    return null;
  }

  /** 该席的待批权限条数（F3-10 的每席配额检查）。 */
  countPendingPermissions(seatId: string): number {
    let count = 0;
    for (const request of this.pendingPermissions.values()) {
      if (request.agentId === seatId) {
        count++;
      }
    }
    return count;
  }

  /** 当前待批权限（落盘 `PersistedRoundtable.pendingPermissions` 用）。 */
  getPendingPermissionRequests(): PermissionRequest[] {
    return [...this.pendingPermissions.values()].map((request) => ({ ...request }));
  }

  /** 崩溃恢复：把落盘的待批权限放回来（已决的不要传）。 */
  restorePermissions(requests: PermissionRequest[]): void {
    for (const request of requests) {
      if (request.status !== "pending") {
        continue;
      }
      this.pendingPermissions.set(request.id, { ...request });
    }
  }

  // -- 退出协商（§5.12：自愿立即；他人请退出等到超时后执行） --

  /**
   * 发起退出协商。`requestedBy` 的说法立即入账。
   * - 自己请自己退出（自愿）→ 立即 `done`，不排定时器。
   * - 同一目标已有 pending 协商 → 追加说法并复用，不排第二个定时器。
   */
  requestExit(input: RequestExitInput): ExitRequest {
    if (input.targetSeatId === input.requestedBy) {
      return this.createExit(input, "done");
    }
    const existing = this.findPendingByTarget(input.targetSeatId);
    if (existing !== null) {
      if (!existing.statements.some((statement) => statement.fromId === input.requestedBy)) {
        existing.statements.push({ fromId: input.requestedBy, text: input.reason });
      }
      return { ...existing, statements: existing.statements.map((statement) => ({ ...statement })) };
    }
    return this.createExit(input, "pending");
  }

  /**
   * 对方答复（TeamCommand `respond_exit`）。
   * accept === true → 协商通过，状态 `done`，定时器取消（调用方据此移除该席）；
   * accept === false → `cancelled`，席位留下；
   * 省略 → 只追加说法，协商继续等到超时。
   */
  respondExit(requestId: string, statement: string, accept?: boolean): ExitRequest | null {
    const request = this.exits.get(requestId);
    if (request === undefined || request.status !== "pending") {
      return null;
    }
    request.statements.push({ fromId: request.targetSeatId, text: statement });
    if (accept !== undefined) {
      this.clearExitTimer(requestId);
      request.status = accept ? "done" : "cancelled";
    }
    return this.snapshot(request);
  }

  /** 到点执行（调用方在定时器回调/超时判定里调用，或由本类的定时器触发）。 */
  resolveExitTimeout(requestId: string): ExitRequest | null {
    const request = this.exits.get(requestId);
    if (request === undefined || request.status !== "pending") {
      return null;
    }
    this.clearExitTimer(requestId);
    request.status = "done";
    return this.snapshot(request);
  }

  /** 主动取消（例如目标席已因别的原因退出）。 */
  cancelExit(requestId: string): ExitRequest | null {
    const request = this.exits.get(requestId);
    if (request === undefined) {
      return null;
    }
    this.clearExitTimer(requestId);
    if (request.status === "pending") {
      request.status = "cancelled";
    }
    return this.snapshot(request);
  }

  /** 未决退出协商（落盘 `PersistedRoundtable.pendingExits` 用）。 */
  getPendingExits(): ExitRequest[] {
    return [...this.exits.values()]
      .filter((request) => request.status === "pending")
      .map((request) => this.snapshot(request));
  }

  /**
   * 崩溃恢复：把落盘的未决协商放回来。**不自动重新计时**——退出协商的时长是
   * 调用方给的（`ExitRequest` 里没有时长字段），恢复后的场默认 paused，重新计时
   * 什么时候开始由调用方决定：`resolveExitTimeout(id)` 立即执行，或再次
   * `requestExit(...)` 复用同一条协商（同一目标不会新建）。
   */
  restoreExits(requests: ExitRequest[]): void {
    for (const request of requests) {
      if (request.status !== "pending") {
        continue;
      }
      this.exits.set(request.id, this.snapshot(request));
    }
  }

  /**
   * 整场结束时的清理（stop / dispose）。**pause 禁止调用**：权限必须活过暂停
   * （H23），未决退出协商同理。
   */
  clearAll(): void {
    for (const timer of this.exitTimers.values()) {
      clearTimeout(timer);
    }
    this.exitTimers.clear();
    this.pendingPermissions.clear();
    this.exits.clear();
  }

  private createExit(input: RequestExitInput, status: ExitRequest["status"]): ExitRequest {
    const request: ExitRequest = {
      id: randomUUID(),
      targetSeatId: input.targetSeatId,
      requestedBy: input.requestedBy,
      requestedAt: Date.now(),
      statements: [{ fromId: input.requestedBy, text: input.reason }],
      status,
    };
    this.exits.set(request.id, request);
    if (status === "pending") {
      this.scheduleExitTimeout(request, input.timeoutMs ?? EXIT_REQUEST_TIMEOUT_MS);
    }
    return this.snapshot(request);
  }

  private scheduleExitTimeout(request: ExitRequest, timeoutMs: number): void {
    const timer = setTimeout(() => {
      this.exitTimers.delete(request.id);
      const due = this.resolveExitTimeout(request.id);
      if (due !== null) {
        this.onExitDue?.(due);
      }
    }, timeoutMs);
    // 协商超时不应该拖住进程退出。
    timer.unref?.();
    this.exitTimers.set(request.id, timer);
  }

  private clearExitTimer(requestId: string): void {
    const timer = this.exitTimers.get(requestId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.exitTimers.delete(requestId);
    }
  }

  private findPendingByTarget(targetSeatId: string): ExitRequest | null {
    for (const request of this.exits.values()) {
      if (request.status === "pending" && request.targetSeatId === targetSeatId) {
        return request;
      }
    }
    return null;
  }

  private snapshot(request: ExitRequest): ExitRequest {
    return { ...request, statements: request.statements.map((statement) => ({ ...statement })) };
  }
}
