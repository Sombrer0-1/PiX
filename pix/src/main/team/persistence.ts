/**
 * RoundtablePersistence - 圆桌落盘（dev plan §4.10 / §5.11 / §6.1–6.3，H8 / H14 / H33 / H36）。
 *
 * 布局（相对路径段全部来自 `team/constants.ts`，默认经其路径 helper 落在
 * `getAgentDir()/roundtables/<sha1(physicalCwd)>/`）：
 *
 *   current.json              活跃场指针 { roundtableId }（H33，工作区级）
 *   ack.json                  工作区级 legacy 提示 ack（H14，不依赖 roundtableId）
 *   <roundtableId>/meta.json  名册、设置、lifecycle、hostSessionId + 没有独立文件的
 *                             mutedThreads / pendingPermissions / pendingExits
 *   <roundtableId>/timeline.jsonl    仅追加；不在 snapshot 本体里，load 时单独 replay
 *   <roundtableId>/attention.jsonl   同上
 *   <roundtableId>/inbox.json / open-items.json / leases.json / deliverables.json / metrics.json
 *   archive/<roundtableId>/   stop 后整目录移入；归档名直接来自 roundtableId，
 *                             任何地方都不用 `existsSync` + "*" 通配（H33）
 *
 * 崩溃恢复（§5.11）：`loadLatest` 只返回「落盘时的样子」，hydrate 由调用方决定
 * （见 `resolveCrashRecoveryLifecycle`：除 `settings.autoContinueAfterCrash` 外一律
 * 回到 "paused"）。已 injected 的 inbox 条目按原状态回来，绝不变成 pending（H36/AC-12）；
 * 进行中的生成不做持久化，所以不会恢复。
 *
 * 写失败：重试一次（§5.14）；仍失败则把错误上抛给调用方，同时内存里的快照保留，
 * 下一次 `flush()` / `saveSnapshot()` 尽力再写。
 */

import { createHash, randomUUID } from "crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type {
  AttentionItem,
  DeliverableVersion,
  InboxEntry,
  OpenItem,
  PersistedRoundtable,
  RoundtableLifecycle,
  RoundtableMetricsSnapshot,
  RoundtableState,
  TimelineItem,
  WriteLease,
} from "../../shared/team-types.js";
import {
  ROUNDTABLE_ACK_FILE,
  ROUNDTABLE_ARCHIVE_DIR,
  ROUNDTABLE_CURRENT_FILE,
  ROUNDTABLE_FILES,
  roundtablesDir,
  type RoundtableFileName,
} from "./constants.js";

/** 快照合并窗口（§4.10 允许 debounce ≤200ms；UI 新鲜度靠这个上限保证）。 */
export const SNAPSHOT_DEBOUNCE_MS = 200;

/** 单次写尝试次数：首次 + 重试一次（§5.14）。 */
const WRITE_ATTEMPTS = 2;

/**
 * meta.json 本体：§4.10 要求的元信息 + 三个没有独立文件的快照字段。
 * timeline / attention 故意不在这里——它们是 append-only 的 JSONL，单独 replay。
 */
interface RoundtableMetaFile {
  version: 2;
  roundtableId: string;
  physicalCwd: string;
  savedAt: number;
  state: RoundtableState;
  mutedThreads: string[];
  pendingPermissions: PersistedRoundtable["pendingPermissions"];
  pendingExits: PersistedRoundtable["pendingExits"];
  /** 已确认的注意力 id（F4-5）；旧快照缺失时按 `[]` 恢复。 */
  attentionAcks: string[];
}

/**
 * 崩溃恢复的 hydrate 目标（§5.11）：落盘的 lifecycle 是 "active" | "paused" 时，
 * `autoContinueAfterCrash`（H9 默认关）为真则继续，否则一律回到 "paused"（先给
 * 用户一条「确认后继续」的注意力，ack 后再 resume）。已 stopped / inactive 的场
 * 不复活。
 */
export function resolveCrashRecoveryLifecycle(meta: PersistedRoundtable): RoundtableLifecycle {
  const lifecycle = meta.state.lifecycle;
  if (lifecycle !== "active" && lifecycle !== "paused") {
    return lifecycle;
  }
  return meta.state.settings.autoContinueAfterCrash ? "active" : "paused";
}

export interface RoundtablePersistenceOptions {
  /** 工作区物理路径（WSL 下与 logicalCwd 不同：持久化用 physical，见 §6.1）。 */
  physicalCwd: string;
  /** 本实例绑定的场（H2：同一工作区同一时刻只有一场；跨场用新实例）。 */
  roundtableId: string;
  /** 只给测试注入：替换 getAgentDir() 当根目录，布局与真实目录同构。 */
  rootDir?: string;
  /** 快照合并窗口，默认 SNAPSHOT_DEBOUNCE_MS。 */
  debounceMs?: number;
}

interface SnapshotWaiter {
  resolve: () => void;
  reject: (err: unknown) => void;
}

export class RoundtablePersistence {
  private readonly physicalCwd: string;
  private readonly roundtableId: string;
  private readonly rootDir: string | undefined;
  private readonly debounceMs: number;

  /**
   * 归档后不再写盘（F4-6）：`archive()` 只搬目录，之后任何 `saveSnapshot` /
   * append 都会用 mkdir 把活跃目录原地重建，留下一个永不消费的 ghost 目录
   * （触发路径：`stop()` 归档后 `dispose()` 仍 `_persistNow`）。
   */
  private archived = false;

  /** 还没落盘的快照（覆盖式合并）；写失败时保留，等下一次尽力再写（§5.14）。 */
  private pendingSnapshot: PersistedRoundtable | null = null;
  private readonly snapshotWaiters: SnapshotWaiter[] = [];
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  /** 每个文件的写队列：同一文件的 JSONL 追加必须保持调用顺序。 */
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(options: RoundtablePersistenceOptions) {
    this.physicalCwd = options.physicalCwd;
    this.roundtableId = options.roundtableId;
    this.rootDir = options.rootDir;
    this.debounceMs = options.debounceMs ?? SNAPSHOT_DEBOUNCE_MS;
  }

  /** 追加一条时间线记录（JSONL，一行一条）。原文只追加，永不改写、永不删除（§4.3）。 */
  appendTimeline(item: TimelineItem): Promise<void> {
    if (this.archived) {
      return Promise.resolve();
    }
    return this.appendJsonl(this.file(ROUNDTABLE_FILES.timeline), item);
  }

  /** 追加一条注意力记录（attention.jsonl 与 timeline.jsonl 一样单独 replay）。 */
  appendAttention(item: AttentionItem): Promise<void> {
    if (this.archived) {
      return Promise.resolve();
    }
    return this.appendJsonl(this.file(ROUNDTABLE_FILES.attention), item);
  }

  /**
   * 落盘一次快照。窗口内的多次调用合并成一次写（最后一次的状态胜出），返回的 promise
   * 在该状态写完后 resolve。写失败：重试一次后 reject，内存里的状态不丢。
   */
  saveSnapshot(state: PersistedRoundtable): Promise<void> {
    if (this.archived) {
      // 归档场是只读包（§6.3）：写盘只会重建活跃目录、留下 ghost（F4-6）。
      return Promise.resolve();
    }
    if (state.roundtableId !== this.roundtableId) {
      const rejected = Promise.reject(
        new Error(
          `roundtable persistence instance is bound to ${this.roundtableId}, got snapshot for ${state.roundtableId}`,
        ),
      );
      // 同下：调用方可能不 await，先标记为已处理。
      rejected.catch(() => {});
      return rejected;
    }
    this.pendingSnapshot = state;
    const promise = new Promise<void>((resolve, reject) => {
      this.snapshotWaiters.push({ resolve, reject });
    });
    // 调用方可能不 await（事件回调里直接 fire）；先标记为已处理，避免主进程 unhandledRejection。
    promise.catch(() => {});
    this.scheduleFlush();
    return promise;
  }

  /** 立刻把挂起的快照写盘（stop / 归档 / 进程退出前调用）。 */
  flush(): Promise<void> {
    this.cancelFlushTimer();
    return this.enqueueFlush();
  }

  /**
   * 读回最近一次落盘的场：meta + 单独 replay 的 timeline / attention。
   * 没有活跃场指针、指针指向已归档或已删除的场、meta.json 缺失 → null
   * （调用方据此走「没有可恢复的场」）。
   * **损坏**（JSON 读不出来）时抛错，绝不静默按空集合恢复（F4-7）。
   */
  async loadLatest(
    physicalCwd: string,
  ): Promise<{ meta: PersistedRoundtable; timeline: TimelineItem[]; attention: AttentionItem[] } | null> {
    const roundtableId = await this.readCurrentPointerFrom(physicalCwd);
    if (roundtableId === null) {
      return null;
    }

    const dir = this.roundtableDir(physicalCwd, roundtableId);
    const meta = await this.readJsonFile<RoundtableMetaFile>(join(dir, ROUNDTABLE_FILES.meta));
    if (meta === null || meta.roundtableId !== roundtableId) {
      return null;
    }

    const [timeline, attention, inbox, openItems, leases, deliverables, metrics] = await Promise.all([
      this.readJsonl<TimelineItem>(join(dir, ROUNDTABLE_FILES.timeline)),
      this.readJsonl<AttentionItem>(join(dir, ROUNDTABLE_FILES.attention)),
      this.readJsonFile<InboxEntry[]>(join(dir, ROUNDTABLE_FILES.inbox)),
      this.readJsonFile<OpenItem[]>(join(dir, ROUNDTABLE_FILES.openItems)),
      this.readJsonFile<WriteLease[]>(join(dir, ROUNDTABLE_FILES.leases)),
      this.readJsonFile<DeliverableVersion[]>(join(dir, ROUNDTABLE_FILES.deliverables)),
      this.readJsonFile<RoundtableMetricsSnapshot>(join(dir, ROUNDTABLE_FILES.metrics)),
    ]);

    return {
      meta: {
        version: 2,
        roundtableId,
        physicalCwd: meta.physicalCwd,
        savedAt: meta.savedAt,
        state: meta.state,
        inbox: inbox ?? [],
        openItems: openItems ?? [],
        leases: leases ?? [],
        deliverables: deliverables ?? [],
        mutedThreads: meta.mutedThreads ?? [],
        metrics: metrics ?? emptyMetrics(),
        pendingPermissions: meta.pendingPermissions ?? [],
        pendingExits: meta.pendingExits ?? [],
        attentionAcks: meta.attentionAcks ?? [],
      },
      timeline,
      attention,
    };
  }

  /**
   * stop 后把整场目录移入 `archive/<roundtableId>/`（H33）。搬走前先把挂起的快照写进
   * 活跃目录，否则合并窗口会在新位置重建旧目录。归档后活跃场指针不再指向它（指针只指
   * 活跃/暂停场）。归档名就是 roundtableId，不使用 `existsSync` + "*" 通配。
   */
  async archive(roundtableId: string): Promise<void> {
    await this.flush();
    const from = this.roundtableDir(this.physicalCwd, roundtableId);
    const to = this.archiveDir(this.physicalCwd, roundtableId);
    await mkdir(dirname(to), { recursive: true });
    // roundtableId 唯一，同名归档只可能是上次异常中断的残留；先清掉再整体搬入。
    await rm(to, { recursive: true, force: true });
    await rename(from, to);
    // 搬完即置位：此后任何 saveSnapshot / append 都不再碰活跃目录（F4-6）。
    this.archived = true;
    if ((await this.readCurrentPointer()) === roundtableId) {
      await this.writeCurrentPointer(null);
    }
  }

  /** 活跃场指针（H33）：`{ roundtableId }`；null = 清空（stop / 归档后）。 */
  async writeCurrentPointer(roundtableId: string | null): Promise<void> {
    const path = this.currentPointerPath(this.physicalCwd);
    if (roundtableId === null) {
      await rm(path, { force: true });
      return;
    }
    await this.writeWithRetry(path, JSON.stringify({ roundtableId }, null, 2));
  }

  /** 当前活跃场 id；没有指针文件或内容损坏 → null。 */
  readCurrentPointer(): Promise<string | null> {
    return this.readCurrentPointerFrom(this.physicalCwd);
  }

  /**
   * 工作区级 legacy 提示 ack（H14）：路径是 `roundtables/<sha1(physicalCwd)>/ack.json`，
   * 与任何 roundtableId 无关，换场 / 归档 / 无活跃场时都读同一份。
   */
  async readAck(physicalCwd: string): Promise<{ legacySnapshotNoticeAck?: boolean }> {
    // ack.json 是工作区级**提示标志**，不是某一场的记录：读不出来按「还没确认」处理。
    // F4-7 对记录文件（inbox / deliverables / open-items / meta）的严格语义不适用于它——
    // 那里损坏意味着数据丢失，这里损坏只意味着提示会再出现一次。
    const parsed = await this.readJsonFile<{ legacySnapshotNoticeAck?: unknown }>(
      this.ackPath(physicalCwd),
    ).catch((): null => null);
    if (parsed === null || typeof parsed.legacySnapshotNoticeAck !== "boolean") {
      return {};
    }
    return { legacySnapshotNoticeAck: parsed.legacySnapshotNoticeAck };
  }

  async writeAck(physicalCwd: string, ack: { legacySnapshotNoticeAck?: boolean }): Promise<void> {
    const path = this.ackPath(physicalCwd);
    // 合并写：ack.json 是工作区级共享文件，写一个标志不能抹掉别的字段。
    // 旧内容不可读（损坏）时按空对象继续：这是**写路径**，目标就是把标志写进去；
    // 读不出来就让 `ack-legacy-team-snapshot` 永久失败，用户只能手删 ack.json 才能脱困。
    const existing = await this.readJsonFile<Record<string, unknown>>(path).catch((): null => null);
    const merged: Record<string, unknown> = { ...(existing ?? {}) };
    if (ack.legacySnapshotNoticeAck !== undefined) {
      merged.legacySnapshotNoticeAck = ack.legacySnapshotNoticeAck;
    }
    await this.writeWithRetry(path, JSON.stringify(merged, null, 2));
  }

  private scheduleFlush(): void {
    if (this.snapshotTimer !== null) {
      // 窗口已经开着：不延后，最长延迟 = debounceMs。
      return;
    }
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      // 等待者已经拿到各自的 promise，这里的错误由它们上抛。
      void this.enqueueFlush().catch(() => {});
    }, this.debounceMs);
  }

  private cancelFlushTimer(): void {
    if (this.snapshotTimer === null) {
      return;
    }
    clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
  }

  /** 串行化 flush：并发调用里后一个只会补写新的状态。 */
  private enqueueFlush(): Promise<void> {
    const run = this.flushChain.then(
      () => this.writePendingSnapshot(),
      () => this.writePendingSnapshot(),
    );
    this.flushChain = run.catch(() => {});
    return run;
  }

  private async writePendingSnapshot(): Promise<void> {
    const state = this.pendingSnapshot;
    if (state === null) {
      return;
    }
    this.pendingSnapshot = null;
    const waiters = this.snapshotWaiters.splice(0, this.snapshotWaiters.length);
    try {
      await this.writeSnapshot(state);
    } catch (err) {
      // 不丢内存里的最新状态（§5.14 尽力再 flush）：写失败时把它放回去，错误上抛。
      if (this.pendingSnapshot === null) {
        this.pendingSnapshot = state;
      }
      for (const waiter of waiters) {
        waiter.reject(err);
      }
      throw err;
    }
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  private async writeSnapshot(state: PersistedRoundtable): Promise<void> {
    const meta: RoundtableMetaFile = {
      version: 2,
      roundtableId: state.roundtableId,
      physicalCwd: state.physicalCwd,
      savedAt: state.savedAt,
      state: state.state,
      mutedThreads: [...state.mutedThreads],
      pendingPermissions: state.pendingPermissions.map((request) => ({ ...request })),
      pendingExits: state.pendingExits.map((request) => ({ ...request })),
      // 兜底 `?? []`：快照可能来自本次改动之前构造的对象（旧测试夹具 / 旧调用方）。
      attentionAcks: [...(state.attentionAcks ?? [])],
    };
    await mkdir(this.roundtableDir(this.physicalCwd, state.roundtableId), { recursive: true });
    await Promise.all([
      this.writeJsonFile(this.file(ROUNDTABLE_FILES.meta), meta),
      this.writeJsonFile(this.file(ROUNDTABLE_FILES.inbox), state.inbox),
      this.writeJsonFile(this.file(ROUNDTABLE_FILES.openItems), state.openItems),
      this.writeJsonFile(this.file(ROUNDTABLE_FILES.leases), state.leases),
      this.writeJsonFile(this.file(ROUNDTABLE_FILES.deliverables), state.deliverables),
      this.writeJsonFile(this.file(ROUNDTABLE_FILES.metrics), state.metrics),
    ]);
  }

  private writeJsonFile(path: string, value: unknown): Promise<void> {
    return this.writeWithRetry(path, JSON.stringify(value, null, 2));
  }

  /** 原子写（临时文件 + rename）：失败重试一次，仍失败抛给调用方（§5.14）。 */
  private async writeWithRetry(path: string, text: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const tmp = `${path}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(tmp, text, "utf-8");
        await rename(tmp, path);
        return;
      } catch (err) {
        lastError = err;
        await rm(tmp, { force: true }).catch(() => {});
      }
    }
    throw toError(lastError);
  }

  /** JSONL 追加：一行一条，同一文件内按调用顺序串行。 */
  private appendJsonl(path: string, value: unknown): Promise<void> {
    const line = `${JSON.stringify(value)}\n`;
    return this.chainWrite(path, async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
        try {
          await mkdir(dirname(path), { recursive: true });
          await appendFile(path, line, "utf-8");
          return;
        } catch (err) {
          lastError = err;
        }
      }
      throw toError(lastError);
    });
  }

  private chainWrite(path: string, task: () => Promise<void>): Promise<void> {
    const previous = this.writeChains.get(path) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.writeChains.set(
      path,
      run.catch(() => {}),
    );
    return run;
  }

  /** JSONL replay：按文件顺序；空行与半写坏行跳过（崩在半行上不该炸恢复）。 */
  private async readJsonl<T>(path: string): Promise<T[]> {
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      return [];
    }
    const items: T[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        items.push(JSON.parse(trimmed) as T);
      } catch {
        // 半写坏行：跳过，后面还有好行。
      }
    }
    return items;
  }

  /**
   * 读一个 JSON 文件。**只有「文件不存在」返回 null**（F4-7）：读失败与
   * `JSON.parse` 失败都抛错——把损坏当成空集合会让恢复静默退化（空收件箱 /
   * 空交付物 / 空未决项，H36 的私密正文唯一载体随之消失且不报任何错）。
   */
  private async readJsonFile<T>(path: string): Promise<T | null> {
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch (err) {
      if (isNotFound(err)) {
        return null;
      }
      throw new Error(`roundtable file is unreadable: ${path} (${describeError(err)})`);
    }
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new Error(`roundtable file is corrupted: ${path} (${describeError(err)})`);
    }
  }

  private async readCurrentPointerFrom(physicalCwd: string): Promise<string | null> {
    let parsed: { roundtableId?: unknown } | null;
    try {
      parsed = await this.readJsonFile<{ roundtableId?: unknown }>(this.currentPointerPath(physicalCwd));
    } catch {
      // 指针只是指路牌（archive() 也读它）：指针损坏 ≠ 某个场的记录损坏，
      // 按「没有可恢复的场」处理，让用户能重新建场。
      return null;
    }
    if (parsed === null || typeof parsed.roundtableId !== "string" || parsed.roundtableId.length === 0) {
      return null;
    }
    return parsed.roundtableId;
  }

  /** `roundtables/<sha1(physicalCwd)>`：默认走 constants.ts 的 helper，注入 rootDir 时同构替换。 */
  private workspaceRoot(physicalCwd: string): string {
    if (this.rootDir === undefined) {
      return roundtablesDir(physicalCwd);
    }
    return join(this.rootDir, "roundtables", createHash("sha1").update(physicalCwd).digest("hex"));
  }

  private roundtableDir(physicalCwd: string, roundtableId: string): string {
    return join(this.workspaceRoot(physicalCwd), roundtableId);
  }

  private archiveDir(physicalCwd: string, roundtableId: string): string {
    return join(this.workspaceRoot(physicalCwd), ROUNDTABLE_ARCHIVE_DIR, roundtableId);
  }

  private currentPointerPath(physicalCwd: string): string {
    return join(this.workspaceRoot(physicalCwd), ROUNDTABLE_CURRENT_FILE);
  }

  private ackPath(physicalCwd: string): string {
    return join(this.workspaceRoot(physicalCwd), ROUNDTABLE_ACK_FILE);
  }

  /** 本实例绑定的场里的一个文件。 */
  private file(fileName: RoundtableFileName): string {
    return join(this.roundtableDir(this.physicalCwd, this.roundtableId), fileName);
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** 「文件不存在」与其它读失败必须分开（F4-7）。 */
function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** metrics.json 缺失/损坏时的空指标：不因此丢掉名册、收件箱等恢复内容。 */
function emptyMetrics(): RoundtableMetricsSnapshot {
  return {
    perSeat: {},
    totals: { utterances: 0, tokens: 0, cost: 0, durationMs: 0 },
    health: { speakShare: {}, evidenceDensity: 0, interruptRate: 0 },
  };
}
