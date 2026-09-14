/**
 * 本场路径写归属表（plan §4.6 / §5.8，H31 / H40 / H44）。
 *
 * pathKey 只来自构造注入的 `resolvePathKey`（H31：`backend.paths.resolvePath(input,
 * logicalCwd)`，无 backend 时用 coding-agent `resolveToCwd`）。本文件禁止
 * `path.resolve` / `getMutationKey` / `realpath`，也禁止异步解析：Windows 盘符、
 * WSL、`@`、`~` 下它们会与真实文件不一致。
 *
 * 本表不做任何 IO。被拒的 acquire 只通过同步 `onConflict` 回调暴露给调用方
 * （H44 -> Attention kind "write_conflict"，§5.8「拒绝 + 注意力」），落盘与 UI
 * 由调用方负责。solo session 没有这份 override，不经过本表。
 */

import type { WriteLease } from "../../shared/team-types.js";

/** acquire 的三种结果（plan §4.6）。 */
export type WriteLeaseAcquireResult =
  | { ok: true; lease: WriteLease }
  | { ok: false; ownerSeatId: string }
  | { ok: false; staleRead: true };

/** 一次被拒 acquire 的信息，调用方据此构造 Attention（H44 / §5.8）。 */
export interface WriteConflictInfo {
  /** 调用方传入的原始路径（模型可见输入，未规范化）。 */
  path: string;
  /** 注入解析器给出的 pathKey，唯一规范身份。 */
  pathKey: string;
  /** 申请被拒的席位。 */
  requestedBy: string;
  /** 当前持约席；持有者已释放的 staleRead 场景下为 undefined。 */
  ownerSeatId?: string;
  /** true 表示该席读过的那份副本已过期，必须先重新 read（H40）。 */
  staleRead?: boolean;
}

export type WriteConflictSink = (info: WriteConflictInfo) => void;

export class WriteLeaseTable {
  /** 唯一的路径规范化入口：注入的解析器（H31）。 */
  private readonly resolvePathKey: (input: string) => string;
  /** pathKey -> 租约。 */
  private readonly leases = new Map<string, WriteLease>();
  /** seatId -> 该席持有的 pathKey（release(seatId) 用）。 */
  private readonly ownedKeys = new Map<string, Set<string>>();
  /** seatId -> 该席已过期（读过但未重新 read）的 pathKey。 */
  private readonly staleReads = new Map<string, Set<string>>();
  /** pathKey -> 读过它的席位；持约者取得写权后这些席位的副本即可能过期（H40）。 */
  private readonly readers = new Map<string, Set<string>>();

  /** H44 钩子：任一 acquire 被拒时同步触发，调用方据此发 Attention write_conflict。 */
  onConflict?: WriteConflictSink;

  constructor(resolvePathKey: (input: string) => string, onConflict?: WriteConflictSink) {
    this.resolvePathKey = resolvePathKey;
    this.onConflict = onConflict;
  }

  /** 输入路径的规范 key。除注入的解析器外没有第二条解析路径（H31）。 */
  pathKeyOf(input: string): string {
    return this.resolvePathKey(input);
  }

  /** 当前持约席，未持约返回 undefined。 */
  ownerOf(path: string): string | undefined {
    return this.leases.get(this.pathKeyOf(path))?.ownerSeatId;
  }

  /**
   * 申请写权：空闲或自己已持有 → ok；他人持有 → ownerSeatId；
   * 自己读过该 key 且读后被他人取得写权 → staleRead（须重新 read，H40）。
   */
  acquire(seatId: string, path: string): WriteLeaseAcquireResult {
    const pathKey = this.pathKeyOf(path);
    const existing = this.leases.get(pathKey);

    if (existing && existing.ownerSeatId === seatId) {
      this.clearStale(seatId, pathKey);
      return { ok: true, lease: existing };
    }

    if (this.isStale(seatId, pathKey)) {
      // 该席的副本可能过期：即使持约者已释放，也必须先重新 read（H40）。
      this.refuse({ path, pathKey, requestedBy: seatId, ownerSeatId: existing?.ownerSeatId, staleRead: true });
      return { ok: false, staleRead: true };
    }

    if (existing) {
      this.refuse({ path, pathKey, requestedBy: seatId, ownerSeatId: existing.ownerSeatId });
      return { ok: false, ownerSeatId: existing.ownerSeatId };
    }

    const lease: WriteLease = { pathKey, ownerSeatId: seatId, acquiredAt: Date.now() };
    this.leases.set(pathKey, lease);
    this.ownedKeysOf(seatId).add(pathKey);
    this.clearStale(seatId, pathKey);
    // 该席取得写权后，其它读过该 key 的席位不能再照着旧副本写。
    const readers = this.readers.get(pathKey);
    if (readers) {
      for (const reader of readers) {
        if (reader !== seatId) this.staleReadsOf(reader).add(pathKey);
      }
    }
    return { ok: true, lease };
  }

  /**
   * 释放一条路径；不带 path 时释放该席全部租约（removeSeat / 退出 / 暂停）。
   * 同时清掉该席的读标记（F2-5）：`readers`/`staleReads` 只增不减会让内存随
   * 读过的路径数单调增长，还为已退出的席位继续维护状态。
   */
  release(seatId: string, path?: string): void {
    if (path === undefined) {
      const owned = this.ownedKeys.get(seatId);
      if (owned) {
        for (const pathKey of owned) this.leases.delete(pathKey);
        owned.clear();
      }
      // 退席即退场：过期读标记整条丢掉，读者登记从每个 pathKey 上摘掉。
      this.staleReads.delete(seatId);
      for (const [pathKey, readers] of this.readers) {
        readers.delete(seatId);
        if (readers.size === 0) this.readers.delete(pathKey);
      }
      return;
    }

    const pathKey = this.pathKeyOf(path);
    // 释放某条路径也顺手清掉该 key 上的过期读标记（席位可能仍在场，其它 key 不动）。
    // 口径（F2-5 仲裁）：**不**清该席在其它 key 上的过期标记——它可能仍持着那些 key
    // 的租约，清掉就等于放开「拿旧副本写」的 H40 拦截；整席退场走上面的无 path 分支。
    this.staleReads.get(seatId)?.delete(pathKey);
    const lease = this.leases.get(pathKey);
    if (!lease || lease.ownerSeatId !== seatId) return;
    this.leases.delete(pathKey);
    this.ownedKeys.get(seatId)?.delete(pathKey);
  }

  /**
   * 非持约席 read 已租约路径时调用（H40）：该席随后的 acquire/write 会直到
   * 「持约者 release 且该席重新 read」前被拒。read 到无人持约的路径（含持约者
   * 释放后的重新 read）副本是最新的，因此清除该席在该 key 上的旧标记。
   */
  noteRead(seatId: string, path: string): void {
    const pathKey = this.pathKeyOf(path);
    readersOf(this.readers, pathKey).add(seatId);

    const owner = this.leases.get(pathKey)?.ownerSeatId;
    if (owner === undefined || owner === seatId) {
      this.clearStale(seatId, pathKey);
      return;
    }
    this.staleReadsOf(seatId).add(pathKey);
  }

  /** 当前全部租约（§4.10 leases.json 快照，按 pathKey 稳定排序）。 */
  list(): WriteLease[] {
    return [...this.leases.values()]
      .map((lease) => ({ ...lease }))
      .sort((a, b) => (a.pathKey < b.pathKey ? -1 : a.pathKey > b.pathKey ? 1 : 0));
  }

  /**
   * 用快照重建（崩溃恢复）。替换当前内容。读标记不落盘，恢复后由调用方按需
   * 重新 noteRead。
   */
  restore(leases: WriteLease[]): void {
    this.leases.clear();
    this.ownedKeys.clear();
    this.staleReads.clear();
    this.readers.clear();
    for (const lease of leases) {
      this.leases.set(lease.pathKey, { ...lease });
      this.ownedKeysOf(lease.ownerSeatId).add(lease.pathKey);
    }
  }

  private ownedKeysOf(seatId: string): Set<string> {
    let keys = this.ownedKeys.get(seatId);
    if (!keys) {
      keys = new Set<string>();
      this.ownedKeys.set(seatId, keys);
    }
    return keys;
  }

  private staleReadsOf(seatId: string): Set<string> {
    let keys = this.staleReads.get(seatId);
    if (!keys) {
      keys = new Set<string>();
      this.staleReads.set(seatId, keys);
    }
    return keys;
  }

  private isStale(seatId: string, pathKey: string): boolean {
    return this.staleReads.get(seatId)?.has(pathKey) === true;
  }

  private clearStale(seatId: string, pathKey: string): void {
    this.staleReads.get(seatId)?.delete(pathKey);
  }

  private refuse(info: WriteConflictInfo): void {
    this.onConflict?.(info);
  }
}

function readersOf(map: Map<string, Set<string>>, pathKey: string): Set<string> {
  let readers = map.get(pathKey);
  if (!readers) {
    readers = new Set<string>();
    map.set(pathKey, readers);
  }
  return readers;
}
