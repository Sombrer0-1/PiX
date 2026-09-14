/**
 * TeamManager —— 圆桌生命周期 facade（plan §4.12 / §4.12b / §4.12c，§5.1–§5.15）。
 *
 * 只做三件事：持有本场的全部模块实例、把 TeamCommand 落到模型/记录上、把
 * 事件与投影推给 IPC。没有 Leader 编排、没有派单、没有任务 gate、没有星型汇报。
 *
 * 分层是硬边界：
 * - 打断**决策**在 `team/interrupt.ts`，执行在 `team/seat-runner.ts`；本文件只
 *   在"该由谁被打断"这一层调用 controller，绝不自己 abort session。
 * - 投递态（已记录/待注入/已注入）只由 `SeatInbox` 改；时间线只由 `TimelineLog`
 *   追加。facade 负责把 `deliveryBySeat` 投影到 IPC 出去的 TimelineItem 上。
 * - 席位工具只经 `RoundtableToolHost`（§4.12b）回来，不直接 import 本类。
 *
 * 公开生命周期名锁定 `initialize` / `createRoundtable` / `pause` / `resume` / `stop`；
 * 已删除 `setLeaderSession` / `resumeRuntime` / `abortActiveTurns`（S5 改调用方）。
 */

import { randomUUID } from "crypto";
import { mkdir, readFile, rename, stat, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve as resolvePathNode } from "path";
import { fileURLToPath } from "node:url";
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ExecutionBackend,
  type RuntimeEnvironmentContext,
  AuthStorage,
  createActiveCompressionExtension,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent, ChatMessageAttachment } from "../shared/types.js";
import { TeamDebugLogger, summarizeText } from "./team/debug-logger.js";
import {
  MAX_SEATS,
  DEFAULT_ROUNDTABLE_TIER,
  USER_SEAT_ID,
  type AttentionItem,
  type DeliverableVersion,
  type DeliveryState,
  type ExitRequest,
  type InboxEntry,
  type InterruptLevel,
  type OpenItem,
  type PersistedRoundtable,
  type RoundtableMetricsSnapshot,
  type RoundtableSettings,
  type RoundtableState,
  type RoundtableTier,
  type SeatConfig,
  type SeatInfo,
  type SeatRuntimeStatus,
  type TeamEvent,
  type TimelineItem,
  type ToolAuthTier,
} from "../shared/team-types.js";
import type { ProjectExecutionContext } from "./execution-context.js";
import { TeamProtocolManager } from "./team-protocol-manager.js";
import { AttentionBus } from "./team/attention-bus.js";
import { TeamCapacityPool } from "./team/capacity-pool.js";
import {
  ABORT_TIMEOUT_MS,
  DEFAULT_L2_BUDGET,
  EXIT_REQUEST_TIMEOUT_MS,
  FILE_CHANGE_NOTICE_MAX_KEYS,
  FILE_CHANGE_NOTICE_WINDOW_MS,
  MAX_PENDING_PERMISSIONS_PER_SEAT,
  ORDERED_RELEASE_MS,
  PERSIST_FAILURE_NOTICE_THROTTLE_MS,
  STUCK_MS,
  roundtableFilePath,
  roundtablePresetsPath,
  roundtableSessionsDir,
  seatSessionDir,
} from "./team/constants.js";
import { DeliverableStore } from "./team/deliverable-store.js";
import { archiveNotice, exportRoundtableMarkdown } from "./team/export.js";
import { buildPlanHandoffRequest, buildSoloHandoffPrompt } from "./team/handoff.js";
import { RoundtableHealth } from "./team/health.js";
import { SeatInterruptController } from "./team/interrupt.js";
import { RoundtableMetrics, type MetricsSessionStats, type MetricsSeatRuntime } from "./team/metrics.js";
import { OpenItemBoard } from "./team/open-items.js";
import { OrderedSpeechGate } from "./team/ordered-speech.js";
import { RoundtablePersistence, resolveCrashRecoveryLifecycle } from "./team/persistence.js";
import { RoundtableRoster, defaultSeatConfigs } from "./team/roster.js";
import { SeatInbox, parseMentions } from "./team/seat-inbox.js";
import { createSeatToolPolicy, SEAT_DENIED_TOOL_NAMES } from "./team/seat-policy.js";
import { registerSeatIdentity } from "./team/seat-identity.js";
import { SeatRunner, type SeatExecutionView, type SeatSessionLike } from "./team/seat-runner.js";
import { registerSeatTools, SEAT_TOOL_NAMES } from "./team/seat-tools.js";
import { TimelineLog, type TimelineFilter } from "./team/timeline-log.js";
import { detectLegacyTeamSnapshot } from "./team/legacy-snapshot.js";
import {
  runTeamBashCommand,
  type PostSeatMessageResult,
  type RoundtableToolHost,
  type SendTeamMessageParams,
} from "./team/tool-host.js";
import { WriteLeaseTable } from "./team/write-lease.js";

/**
 * SDK 自己的 AgentSessionEvent（与 `shared/types.ts` 的同名类型结构等价但分属
 * 两套 AgentMessage 定义，交付事件时断言一次）。
 */
type SdkSessionEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];

/** 会话工厂（测试注入；生产用真实的 createAgentSession）。 */
export interface TeamManagerOptions {
  sessionFactory?: typeof createAgentSession;
}

/** 预设文件结构（plan §6.4）。 */
interface RoundtablePreset {
  name: string;
  seats: SeatConfig[];
}

/** 本场所有模块的打包（`createRoundtable` / 恢复时一次建好）。 */
interface RoundtableModules {
  roundtableId: string;
  roster: RoundtableRoster;
  timeline: TimelineLog;
  inbox: SeatInbox;
  attention: AttentionBus;
  gate: OrderedSpeechGate;
  openItems: OpenItemBoard;
  leases: WriteLeaseTable;
  interrupts: SeatInterruptController;
  capacity: TeamCapacityPool;
  deliverables: DeliverableStore;
  persistence: RoundtablePersistence;
  health: RoundtableHealth;
  metrics: RoundtableMetrics;
  protocol: TeamProtocolManager;
  offGate: () => void;
  offInbox: () => void;
  /** 时间线追加的统一出口退订（F3-2）：席位自己 append 的记录也走落盘 + 事件。 */
  offTimelineAppend: () => void;
}

/** 待整理的整理任务（aux 槽满时排队，绝不借 agent-task 槽）。 */
interface PendingWrapUp {
  deliverableId: string;
  author: "system" | string;
}

/** 默认圆桌设置（H4/H9：阈值类全部默认关）。 */
function defaultSettings(): RoundtableSettings {
  return {
    orderedMode: false,
    waitForUserQuestions: false,
    autoContinueAfterCrash: false,
    unattendedGuard: false,
    suggestWrapUp: false,
    softBudget: undefined,
    hardStop: undefined,
    cheaperModel: undefined,
    orderedReleaseMs: ORDERED_RELEASE_MS,
    exitRequestTimeoutMs: EXIT_REQUEST_TIMEOUT_MS,
    l2: { ...DEFAULT_L2_BUDGET },
  };
}

/** 合并局部设置（逐字段合并，undefined 一律表示"不改"）。 */
export function mergeRoundtableSettings(
  base: RoundtableSettings,
  partial?: Partial<RoundtableSettings>,
): RoundtableSettings {
  const next = partial ?? {};
  return {
    orderedMode: next.orderedMode ?? base.orderedMode,
    waitForUserQuestions: next.waitForUserQuestions ?? base.waitForUserQuestions,
    autoContinueAfterCrash: next.autoContinueAfterCrash ?? base.autoContinueAfterCrash,
    unattendedGuard: next.unattendedGuard ?? base.unattendedGuard,
    suggestWrapUp: next.suggestWrapUp ?? base.suggestWrapUp,
    softBudget: next.softBudget !== undefined ? { ...next.softBudget } : base.softBudget,
    hardStop: next.hardStop !== undefined ? { ...next.hardStop } : base.hardStop,
    cheaperModel: next.cheaperModel ?? base.cheaperModel,
    orderedReleaseMs: next.orderedReleaseMs ?? base.orderedReleaseMs,
    exitRequestTimeoutMs: next.exitRequestTimeoutMs ?? base.exitRequestTimeoutMs,
    l2: { ...base.l2, ...(next.l2 ?? {}) },
  };
}

/** 把合并结果写回既有 settings 对象（l2 就地更新：打断 controller 持同一对象）。 */
function applySettings(target: RoundtableSettings, merged: RoundtableSettings): void {
  target.orderedMode = merged.orderedMode;
  target.waitForUserQuestions = merged.waitForUserQuestions;
  target.autoContinueAfterCrash = merged.autoContinueAfterCrash;
  target.unattendedGuard = merged.unattendedGuard;
  target.suggestWrapUp = merged.suggestWrapUp;
  target.softBudget = merged.softBudget;
  target.hardStop = merged.hardStop;
  target.cheaperModel = merged.cheaperModel;
  target.orderedReleaseMs = merged.orderedReleaseMs;
  target.exitRequestTimeoutMs = merged.exitRequestTimeoutMs;
  Object.assign(target.l2, merged.l2);
}

export class TeamManager implements RoundtableToolHost {
  private readonly _sessionFactory: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;

  /** 工作区物理路径：落盘与 hash 的输入（WSL 下与 logical 不同，§6.1）。 */
  private _physicalCwd = "";
  /** 模型可见的逻辑 cwd：`createAgentSession({ runtimeCwd })` 的入参。 */
  private _logicalCwd = "";
  /** 从 host 借来的 execution backend（对象身份共享；本类永不 dispose）。 */
  private _executionBackend: ExecutionBackend | null = null;
  private _isWsl = false;
  private _runtimeEnvironmentOverride: Partial<RuntimeEnvironmentContext> | undefined;
  private _authStorage: AuthStorage | null = null;

  private _state: RoundtableState | null = null;
  private _modules: RoundtableModules | null = null;
  private _runners = new Map<string, SeatRunner>();
  private _sessions = new Map<string, AgentSession>();
  private _unsubscribeSeats = new Map<string, () => void>();
  /** 每席累计运行时长（metrics 的 durationMs 输入）。 */
  private _seatDurations = new Map<string, { total: number; startedAt: number | null }>();
  /**
   * 每席 session 退场时记下的用量（F4-3）：`_disposeSeatSession` 之后 `_sessions`
   * 里就查不到了，而 metrics 的 perSeat / totals 必须保留退出席位**已经花掉**的成本与
   * token——否则减席会让花掉的钱从成本表上消失（cost 类阈值也跟着回退）。
   * 与 `_seatDurations` 同构：同一席多次进场/退场按累计值叠加。
   */
  private _seatUsage = new Map<string, MetricsSessionStats>();
  /** 上次落盘的指标（崩溃恢复后累计成本不丢，H17）。 */
  private _metricsBase: RoundtableMetricsSnapshot | null = null;
  private _mutedThreads = new Set<string>();
  /** 每席上次已知的投递态（delivery_changed 的 diff 基准，AC-8）。 */
  private _deliveryStates = new Map<string, Map<string, DeliveryState>>();
  /** 辅助整理 session（计入辅助槽与团队成本，H13/H17）。 */
  private _aux: {
    jobId: string;
    session: AgentSession;
    abort: () => void;
  } | null = null;
  /** 辅助 session 的累计用量（H17：计入团队成本；host 空转不算）。 */
  private _auxUsage = { tokensIn: 0, tokensOut: 0, cost: 0 };
  /** 整理任务队列（aux 槽满时排队，不占席位槽、不借 agent-task）。 */
  private _pendingWrapUps: PendingWrapUp[] = [];
  private _eventCallbacks: Array<(event: TeamEvent) => void> = [];
  private _debugLogger = new TeamDebugLogger();
  private _disposed = false;
  /**
   * 时间线 replay 期间置位（F3-2）：replay 只补记录，不再落盘、不发事件
   * （否则每次重启都会把 timeline.jsonl 翻倍，§4.10 的 replay 语义也被破坏）。
   */
  private _replayingTimeline = false;
  /**
   * 建场之前产生的注意力（F4-7）：恢复路径上发现记录损坏时 `_modules === null`
   * （上一场的模块刚被 teardown，且不会马上装新的），此刻既没有 AttentionBus 也不
   * 会发 `attention` 事件，只 console.error 的话用户在 App 里完全看不到——Electron
   * 主进程的 console 不进 UI，而 H36 的私密正文只存在于 inbox.json。
   * 按工作区暂存，等本工作区下一次建场 / 成功恢复之后再补发（见 _flushDeferredNotices）。
   */
  private _deferredNotices: Array<{ physicalCwd: string; text: string }> = [];
  /** 落盘失败注意力的节流时间戳（key = 写入目标，F3-5）。 */
  private readonly _persistFailureAt = new Map<string, number>();
  /** file_change 事后审计的去重时间戳（key = `seatId\u0000path`，F3-7）。 */
  private readonly _fileChangeNoticeAt = new Map<string, number>();

  /**
   * 用户 settings 的 shell 配置（F4-9）：建场时读一次，`team_bash` 用它和 solo 的
   * bash 跑在同一个 shell / 前缀上（否则同一工作区里席位会「命令找不到」）。
   */
  private _shellConfig: { shellPath?: string; shellCommandPrefix?: string } = {};

  /**
   * @param options.sessionFactory 覆盖 AgentSession 工厂（测试用）。
   *   生产省略；`new TeamManager()` 使用真实 createAgentSession。
   */
  constructor(options: TeamManagerOptions = {}) {
    this._sessionFactory = options.sessionFactory ?? createAgentSession;
  }

  // ==========================================================================
  // 初始化 / 恢复
  // ==========================================================================

  /**
   * 记录 host 的 ProjectExecutionContext 与 AuthStorage（wsl_plan §4.8：borrowed
   * backend，本类永不 dispose），然后尝试恢复本工作区上一场圆桌。
   */
  async initialize(context: ProjectExecutionContext, authStorage: AuthStorage): Promise<void> {
    this._physicalCwd = context.physicalCwd;
    this._logicalCwd = context.logicalCwd;
    this._executionBackend = context.executionBackend ?? null;
    this._isWsl = context.isWsl;
    this._runtimeEnvironmentOverride = context.runtimeEnvironmentOverride;
    this._authStorage = authStorage;
    this.logTeamDebug("manager.initialize", {
      physicalCwd: context.physicalCwd,
      logicalCwd: context.logicalCwd,
      isWsl: this._isWsl,
      hasBackend: Boolean(context.executionBackend),
      hasAuthStorage: Boolean(authStorage),
    });
    await this._hydrateLastRoundtable();
  }

  /**
   * 崩溃/重启恢复（§4.10 / §5.11 / AC-12）：
   * - 有落盘的场 → 名册/视角/设置/收件箱/未决项/交付物/指标回来，时间线与注意力
   *   replay；默认回到 `paused`（`autoContinueAfterCrash` 才继续），并发一条
   *   「确认后继续」的注意力；
   * - 已 injected 的收件箱条目绝不重新变回待注入；
   * - 旧 `team.json` **永不**是恢复来源，只产生一次性 `legacy_snapshot_notice`。
   */
  private async _hydrateLastRoundtable(): Promise<void> {
    if (this._physicalCwd.length === 0) {
      return;
    }
    const physicalCwd = this._physicalCwd;
    // F3-3：换场（本项目重新 initialize / 新工作区的第一场）之前先把上一场的
    // session / runner / 定时器 / 订阅收干净，否则每次 team ↔ solo 往返都会泄漏。
    // 放在这里而不是只放在 install 前：没有可恢复的场时也要停掉旧场。
    if (this._modules !== null) {
      await this._teardownModules();
    }
    // 只用指针读「本工作区最近一场」：实例的 roundtableId 与 loadLatest 无关。
    const probe = new RoundtablePersistence({ physicalCwd, roundtableId: "bootstrap" });
    let loaded: Awaited<ReturnType<RoundtablePersistence["loadLatest"]>>;
    try {
      loaded = await probe.loadLatest(physicalCwd);
    } catch (err) {
      // F4-7：记录损坏与「没有可恢复的场」必须分开——损坏时 loadLatest 抛错，
      // 这里说出来，绝不按空集合静默恢复（H36 私密正文的唯一载体在 inbox.json）。
      console.error("[TeamManager] roundtable records are corrupted:", err);
      // 此刻上一场的模块已经拆掉（`_teardownModules` 故意不清 `_modules`，但 session /
      // 定时器全没了，投进旧 bus 只会写进一个不会再显示的场），所以不直接
      // `_raiseAttention`：按工作区暂存，等本工作区下一场圆桌建起来、渲染层已经认下
      // 它之后再由 `_flushDeferredNotices()` 补发，否则这条提示在 App 里永远不可见。
      const detail = err instanceof Error ? err.message : String(err);
      const text = `圆桌记录损坏：${detail}。上一场未恢复，原文件保留未改（修好后重启可再试）。`;
      // 同一个损坏的工作区会被反复 initialize（失败一次就再来一次），提示本身是幂等
      // 的：不重复暂存，否则补发时用户会看到一叠一模一样的卡片。
      if (!this._deferredNotices.some((notice) => notice.physicalCwd === physicalCwd && notice.text === text)) {
        this._deferredNotices.push({ physicalCwd, text });
      }
      this._emit({ type: "record_corrupt_notice", text });
      // 上面的 teardown 已经把上一场的模块拆了：这里把引用也清掉，否则
      // `getState()` / `hasActiveTeam()` 会继续报一个已经拆掉的场。
      this._state = null;
      this._modules = null;
      this._emitState();
      return;
    }
    if (loaded !== null) {
      const { meta } = loaded;
      const settings = mergeRoundtableSettings(defaultSettings(), meta.state.settings);
      const modules = this._installModules(meta.state.roundtableId, meta.state.tier, settings);
      modules.roster.restore(meta.state.seats);
      this._mutedThreads = new Set(meta.mutedThreads);
      this._replayingTimeline = true;
      try {
        for (const item of loaded.timeline) {
          // replay：只补记录，不改投递态、不发事件；seq 由日志按文件顺序重排。
          const { seq: _replayedSeq, ...rest } = item;
          void _replayedSeq;
          modules.timeline.append(rest);
        }
      } finally {
        this._replayingTimeline = false;
      }
      modules.attention.restore(loaded.attention);
      // F4-5：已确认状态不在 attention.jsonl 里，靠快照本体重放；否则重启后
      // 已处理过的权限卡会带着失效按钮（requestId 已不在 pendingPermissions）回来。
      for (const id of meta.attentionAcks) {
        modules.attention.ack(id);
      }
      modules.inbox.restore(meta.inbox);
      // F1-2 的 id 唯一性半边：inbox.json 里的 messageId 即使没被 replay 回时间线
      // （时间线写失败过、或条目只在收件箱里），也必须占用 id 名称空间——否则
      // nextGeneratedId 会重新分配它，SeatInbox.enqueue 按 messageId 去重会让该席
      // 静默收不到那条消息。
      modules.timeline.reserveIds(meta.inbox.map((entry) => entry.messageId));
      modules.openItems.restore(meta.openItems);
      modules.leases.restore(meta.leases);
      modules.deliverables.restore(meta.deliverables);
      modules.protocol.restorePermissions(meta.pendingPermissions);
      modules.protocol.restoreExits(meta.pendingExits);
      this._metricsBase = meta.metrics;
      this._deliveryStates.clear();

      const lifecycle = resolveCrashRecoveryLifecycle(meta);
      this._state = {
        roundtableId: meta.state.roundtableId,
        name: meta.state.name,
        lifecycle,
        createdAt: meta.state.createdAt,
        tier: meta.state.tier,
        settings,
        seats: modules.roster.snapshot(),
        orderedMode: settings.orderedMode,
        hostSessionId: meta.state.hostSessionId,
      };
      this._debugLogger.start(physicalCwd, meta.state.name, "restore_roundtable");
      this.logTeamDebug("roundtable.restored", {
        roundtableId: meta.state.roundtableId,
        lifecycle,
        seats: modules.roster.size,
        timeline: loaded.timeline.length,
        attention: loaded.attention.length,
        inbox: meta.inbox.length,
      });

      if (lifecycle === "paused") {
        // 暂停态：不建 session、不发模型调用；确认后 resume 再开始。
        // F5-4 / §5.11：这条提示的「知道了」必须真的恢复整场，否则用户以为恢复
        // 失败、lifecycle 永远停在 paused（renderer 见 action==="resume" 补发命令）。
        this._raiseAttention({
          kind: "seat_error",
          text: "重启后发现上一场圆桌：已恢复到「暂停」，确认后继续（不会自动消耗模型调用）。",
          refId: meta.state.roundtableId,
          action: "resume",
        });
      }
      // 与 createRoundtable 同一起点：时长类阈值（软预算 / 硬停止）必须有定时评估，
      // 否则恢复回来的场只有在下一次消息时才被评估。
      this._metrics?.start();
      this._emitState();
      // 建场之前的注意力（F4-7 的记录损坏）在这一刻才有人看：渲染层刚认下这场圆桌。
      this._flushDeferredNotices();
      if (lifecycle === "active") {
        // autoContinueAfterCrash（H9 默认关）：用户已授权自动继续。
        void this._startAllSeats();
      }
      return;
    }

    // 本工作区没有可恢复的场：上面的 teardown 已经把上一场（可能是另一个工作区的）
    // 的 session / runner / 定时器全拆了，但 `_state` 还留着它的记录 → 不清理的话
    // 换工作区后 `getState()` / `hasActiveTeam()` 会继续报一个所有 session 都已
    // dispose 的僵尸场（实测：A 场 pause → initialize 到空工作区 B，getState() 仍
    // 返回 A 的 roundtableId 且 hasActiveTeam() 为 true）。F4-7 的 catch 分支同理。
    if (this._modules !== null || this._state !== null) {
      this._state = null;
      this._modules = null;
      this._emitState();
    }
    await this._emitLegacyNoticeIfNeeded();
  }

  /** 旧快照只在「存在且用户还没确认过」时提示一次（H14 / AC-13）。 */
  private async _emitLegacyNoticeIfNeeded(): Promise<void> {
    if (!detectLegacyTeamSnapshot(this._physicalCwd)) {
      return;
    }
    const ack = await this._legacyAck();
    if (ack) {
      return;
    }
    this._emit({ type: "legacy_snapshot_notice" });
  }

  private async _legacyAck(): Promise<boolean> {
    const probe = new RoundtablePersistence({ physicalCwd: this._physicalCwd, roundtableId: "bootstrap" });
    const ack = await probe
      .readAck(this._physicalCwd)
      .catch((): { legacySnapshotNoticeAck?: boolean } => ({}));
    return ack.legacySnapshotNoticeAck === true;
  }

  // ==========================================================================
  // 读投影
  // ==========================================================================

  getState(): RoundtableState | null {
    const state = this._state;
    if (state === null || this._modules === null) {
      return null;
    }
    return {
      ...state,
      // seats 以名册为权威（roster 是唯一改状态的地方）。
      seats: this._modules.roster.snapshot(),
      settings: { ...state.settings, l2: state.settings.l2 },
    };
  }

  /** 圆桌存在且不是已停止（active / paused 都算有活跃场）。 */
  hasActiveTeam(): boolean {
    const lifecycle = this._state?.lifecycle;
    return lifecycle === "active" || lifecycle === "paused";
  }

  /** 运行时是否在跑（paused / stopped 都不是）。工具与消息以此为准。 */
  isRuntimeActive(): boolean {
    return this._state?.lifecycle === "active";
  }

  getTimeline(filter?: TimelineFilter): TimelineItem[] {
    const modules = this._modules;
    if (modules === null) {
      return [];
    }
    return modules.timeline.list(filter).map((item) => this._projectItem(item));
  }

  getAttention(): AttentionItem[] {
    return this._modules?.attention.list() ?? [];
  }

  getOpenItems(): OpenItem[] {
    return this._modules?.openItems.list() ?? [];
  }

  getInbox(seatId?: string): InboxEntry[] {
    const entries = this._modules?.inbox.snapshot() ?? [];
    return seatId === undefined ? entries : entries.filter((entry) => entry.seatId === seatId);
  }

  getDeliverables(): DeliverableVersion[] {
    return this._modules?.deliverables.list() ?? [];
  }

  /** 指标 = 落盘基线（崩溃前的累计）+ 当前 session 用量（H17）。 */
  getMetrics(): RoundtableMetricsSnapshot {
    const live = this._modules?.metrics.snapshot() ?? emptyMetrics();
    return mergeMetrics(this._metricsBase, live);
  }

  // ==========================================================================
  // 新建圆桌（§5.1）
  // ==========================================================================

  /**
   * 建一场新圆桌并开跑：生成 roundtableId（H26）→ 落盘 meta + current.json →
   * 建名册/时间线/各模块 → 启动 N 个只读政策席位 → 写开场系统消息（议题 + 附件，
   * 硬停止开启时必须在此告知）→ 各席第一轮 prompt（并行）。
   */
  async createRoundtable(input: {
    name?: string;
    tier?: RoundtableTier;
    seats?: SeatConfig[];
    topic: string;
    attachments?: ChatMessageAttachment[];
    settings?: Partial<RoundtableSettings>;
  }): Promise<RoundtableState> {
    this._assertReady();
    const existing = this._state;
    if (existing !== null && existing.lifecycle !== "stopped") {
      throw new Error("已有活跃圆桌：先 stop()（会归档当前场）再新建。");
    }

    const tier = input.tier ?? DEFAULT_ROUNDTABLE_TIER;
    const settings = mergeRoundtableSettings(defaultSettings(), input.settings);
    const roundtableId = `rt-${randomUUID()}`;
    const name = (input.name ?? input.topic).trim().slice(0, 80) || "圆桌讨论";
    const configs = input.seats ?? defaultSeatConfigs(tier);

    // 上一场的一切必须先收干净：session / runner / 定时器 / 订阅（F3-3）。
    if (this._modules !== null) {
      await this._teardownModules();
    }
    const modules = this._installModules(roundtableId, tier, settings);
    const seats = modules.roster.createFrom(configs);
    this._mutedThreads.clear();
    this._metricsBase = null;
    this._state = {
      roundtableId,
      name,
      lifecycle: "active",
      createdAt: Date.now(),
      tier,
      settings,
      seats: modules.roster.snapshot(),
      orderedMode: settings.orderedMode,
    };
    this._debugLogger.start(this._physicalCwd, name, "create_roundtable");
    this.logTeamDebug("roundtable.create", {
      roundtableId,
      name,
      tier,
      seats: seats.map((seat) => ({ seatId: seat.seatId, name: seat.name, auth: seat.auth })),
      hardStop: settings.hardStop ?? null,
    });

    await modules.persistence.writeCurrentPointer(roundtableId);
    this._persistNow();
    this._emit({ type: "roundtable_created", state: this.getState()! });
    this._emitState();
    // 建场之前的注意力（F4-7 的记录损坏）在这一刻才有人看：必须晚于
    // `roundtable_created`，否则渲染层认下新场时会把早发的条目一起清掉。
    this._flushDeferredNotices();

    // 席位 session 并行创建；失败只影响该席（§5.14 第一行）。
    await Promise.all(seats.map((seat) => this._startSeat(seat.seatId)));

    // 开场系统消息：议题 + 附件名（+ 硬停止预告，AC-11）。落盘与事件由
    // timeline.onAppend 的统一出口负责（F3-2），这里只 append。
    const opening = this._appendSystem(this._buildOpeningText(input), "*");

    // 各席第一次 prompt：议题 + 本席视角 + 空时间线（并行；投递走收件箱）。
    for (const seat of seats) {
      if (!modules.roster.isActive(seat.seatId)) {
        continue;
      }
      modules.inbox.enqueue({ ...opening, text: buildOpeningBrief(opening.text, seat) }, [seat.seatId]);
    }
    this._metrics?.start();
    this._metrics?.evaluate();
    return this.getState()!;
  }

  private _buildOpeningText(input: { topic: string; attachments?: ChatMessageAttachment[] }): string {
    const attachments = input.attachments ?? [];
    const names = attachments.map((attachment) => attachment.name || attachment.path);
    const settings = this._state?.settings;
    const hardStop = settings?.hardStop;
    const lines = [
      "圆桌讨论开始。",
      "",
      `议题：${input.topic.trim()}`,
      // F3-8：材料要能被席位真的读到（read 需要路径），只列名字进不了任何席位上下文。
      ...(names.length > 0
        ? ["", `抛出的材料（${names.length} 个）：${names.join("、")}`, ...attachmentLines(attachments)]
        : []),
    ];
    if (hardStop !== undefined && hardStop.enabled) {
      // AC-11：硬停止必须在开场告知，并说明是否授权「停止讨论并整理」。
      const limits = [
        ...(hardStop.maxCostUsd !== undefined ? [`成本上限 ${hardStop.maxCostUsd} USD`] : []),
        ...(hardStop.maxDurationMs !== undefined ? [`时长上限 ${Math.round(hardStop.maxDurationMs / 60_000)} 分钟`] : []),
      ];
      lines.push(
        "",
        `【硬停止已开启】到达${limits.length > 0 ? limits.join("、") : "用户设定的条件"}后，系统会停止一切团队模型调用；${
          hardStop.allowWrapUpOnStop
            ? "已授权「停止讨论并整理」：停止后允许进行一次整理调用（计入团队成本并公告）。"
            : "未授权整理：停止后不会自动整理，只能取走已有记录与稿件。"
        }`,
      );
    }
    return lines.join("\n");
  }

  // ==========================================================================
  // 用户输入与运行时控制
  // ==========================================================================

  /**
   * 用户消息（广播 / @ / 私密），立即记录并进入目标席收件箱（§5.1 步骤 5）。
   * 私密：正文**只**存进 `InboxEntry.text`，时间线留 `private_stub`（H36 / AC-20）。
   */
  async postUserMessage(input: {
    to: string;
    text: string;
    private?: boolean;
    interrupt?: InterruptLevel;
    attachments?: ChatMessageAttachment[];
  }): Promise<TimelineItem> {
    this._assertCanRecord("post_user_message");
    const modules = this._modules!;
    const body = input.text;
    const mentions = parseMentions(body, modules.roster.list());

    if (input.private === true) {
      if (input.to === "*" || !modules.roster.isActive(input.to)) {
        throw new Error("私密消息只能发给单个席位。");
      }
      const stub = modules.timeline.append({
        ts: Date.now(),
        type: "private_stub",
        fromId: USER_SEAT_ID,
        toId: input.to,
        text: "",
        summary: `私密消息 → ${modules.roster.get(input.to)?.name ?? input.to}`,
        privateStub: { fromId: USER_SEAT_ID, toId: input.to },
        mentionIds: [input.to],
      });
      // H36：正文的唯一载体是 InboxEntry.text（落盘在 inbox.json）。落盘与事件由
      // timeline.onAppend 的统一出口负责（F3-2）。
      modules.inbox.enqueue({ ...stub, text: body }, [input.to]);
      this._nudge([input.to], input.interrupt ?? "L1", "user");
      this._persistSoon();
      this._metrics?.evaluate();
      return this._projectItem(stub);
    }

    const targets = input.to === "*"
      ? modules.roster.activeIds()
      : modules.roster.isActive(input.to)
        ? [input.to]
        : [];
    if (input.to !== "*" && targets.length === 0) {
      throw new Error(`找不到收件席 "${input.to}"。`);
    }
    const mentionIds = input.to !== "*" && input.to !== USER_SEAT_ID
      ? [input.to, ...mentions.filter((id) => id !== input.to)]
      : mentions;

    const item = modules.timeline.append({
      ts: Date.now(),
      type: "user",
      fromId: USER_SEAT_ID,
      toId: input.to,
      text: body,
      summary: firstLine(body),
      attachments: input.attachments,
      mentionIds,
    });
    // F3-8：附件只挂在时间线上永远进不了席位上下文（附件-only 还会注入空块），
    // 所以把附件行并进注入正文；时间线条目仍保留 attachments 字段。
    const files = attachmentLines(input.attachments ?? []);
    const inboxText = files.length > 0 ? `${body}\n\n${files.join("\n")}` : body;
    modules.inbox.enqueue({ ...item, text: inboxText }, targets);
    this._nudge(targets, input.interrupt ?? "L1", "user");
    this._persistSoon();
    this.logTeamDebug("user.message", {
      to: input.to,
      private: false,
      text: summarizeText(body),
      mentionIds,
      targets,
    });
    this._metrics?.evaluate();
    return this._projectItem(item);
  }

  /**
   * 有序模式开关（H27：只写 settings）。关掉时按排队键放行等待中的 argument
   * （投递不丢）、并清掉所有 `waiting_turn`（§5.15）。
   */
  setOrderedMode(on: boolean): void {
    const state = this._state;
    if (state === null || this._modules === null || state.lifecycle === "stopped") {
      return;
    }
    state.settings.orderedMode = on;
    this._onOrderedModeChanged(on);
    this.logTeamDebug("ordered_mode.set", { on });
    this._emitState();
    this._persistSoon();
  }

  /**
   * 暂停（§5.10 / AC-10）：不再发起任何团队模型调用（席位 turn、压缩、摘要、
   * 整理全部停），abort 正在跑的席位，取消 aux。**不清** pendingPermissions
   * （H23），也**不丢**未 commit 的收件箱条目（投递态只在 commitInjected 前进）。
   */
  async pause(): Promise<void> {
    const state = this._state;
    const modules = this._modules;
    if (state === null || modules === null || state.lifecycle === "stopped" || state.lifecycle === "paused") {
      return;
    }
    state.lifecycle = "paused";
    // 容量池先停：新的 prompt 一律拿不到席位槽（§4.8）。
    modules.capacity.pause();
    this.logTeamDebug("roundtable.pause", { seats: modules.roster.size });
    for (const [seatId, runner] of this._runners) {
      // L3 现在是「直接执行」的控制面（F1-1），但一个不回话的 abort 仍可能拖住
      // apply：加超时兜底，保证 pause 自身在 ABORT_TIMEOUT_MS 内返回（§5.10 暂停
      // 语义要求暂停立刻生效，之后不再有团队模型调用）。
      await Promise.race([
        runner.apply("L3").catch(() => {}),
        this._sleep(ABORT_TIMEOUT_MS),
      ]);
      this._sessions.get(seatId)?.abortCompaction();
    }
    this._abortAux();
    // 写归属在暂停时结束（§4.2：租约覆盖到显式释放或席位退出/暂停）。
    for (const seat of modules.roster.all()) {
      modules.leases.release(seat.seatId);
    }
    this._setSeatStatusesForPause();
    this._emitState();
    await this._flush();
  }

  /** 恢复（用户确认后继续）：重新调度席位并带上仍待注入的收件箱。 */
  resume(reason: string): void {
    const state = this._state;
    const modules = this._modules;
    if (state === null || modules === null || state.lifecycle !== "paused") {
      return;
    }
    state.lifecycle = "active";
    modules.capacity.resume();
    this.logTeamDebug("roundtable.resume", { reason });
    // 已有 runner 解除停调度；恢复后没有 session 的席位（崩溃恢复）一并补建。
    for (const runner of this._runners.values()) {
      runner.resume();
    }
    void this._startAllSeats();
    this._emitState();
    this._persistSoon();
  }

  /**
   * 停止并归档（§5.10 / §6.3）。`wrapUp` 只在 `hardStop.allowWrapUpOnStop` 时
   * 允许那一次整理调用（AC-11）；停止后记录保留为只读。
   */
  async stop(options: { wrapUp?: boolean } = {}): Promise<void> {
    const state = this._state;
    const modules = this._modules;
    if (state === null || modules === null || state.lifecycle === "stopped") {
      return;
    }
    const wrapUp = options.wrapUp === true && state.settings.hardStop?.allowWrapUpOnStop === true;
    // 第一步就是暂停：先禁掉一切团队模型调用，再决定是否授权一次整理。
    await this.pause();
    state.lifecycle = "stopped";
    this.logTeamDebug("roundtable.stop", { wrapUp, roundtableId: state.roundtableId });

    if (wrapUp && this._modules !== null) {
      // AC-11：授权过的那一次整理调用（整场已暂停，绕过 aux 容量池）。
      try {
        await this._performWrapUp("system", true);
        const latest = this._modules.deliverables.latest();
        if (latest !== undefined) {
          this._appendSystem(`硬停止后按授权整理了一次：交付物 v${latest.version}（截止 seq=${latest.cutoffSeq}），计入团队成本。`, "*");
        }
      } catch (err) {
        console.warn("[TeamManager] wrap-up on stop failed:", err);
      }
    }

    // 拆模块（停定时器 / 退订 / dispose session）之前先把最终态写盘并推给 UI：
    // 拆掉之后 `_persistNow()` 已经不写盘，最终态就进不了归档目录（F3-3）。
    this._persistNow();
    await this._flush();
    this._emitState();
    await this._teardownModules();
    await modules.persistence.archive(state.roundtableId).catch((err) => {
      console.warn("[TeamManager] Failed to archive roundtable:", err);
    });
    this._debugLogger.stop("roundtable_stopped");
  }

  /** 进程退出（index.ts 仍调此名）。保留快照，不归档：重启可恢复。 */
  async dispose(): Promise<void> {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._persistNow();
    await this._flush();
    await this._teardownModules();
    this._debugLogger.stop("dispose");
    this._eventCallbacks.length = 0;
    this.logTeamDebug("manager.dispose", {});
  }

  // ==========================================================================
  // 席位管理（§5.12 / FR-1）
  // ==========================================================================

  /** 加席：不打断其它席的回合；入场给摘要 + 索引，并在主线公布（AC-14）。 */
  async addSeat(config: SeatConfig): Promise<SeatInfo> {
    this._assertCanRecord("add_seat");
    const modules = this._modules!;
    const state = this._state!;
    if (modules.roster.size >= MAX_SEATS) {
      throw new Error(`席位已达上限 ${MAX_SEATS}。`);
    }
    const seat = modules.roster.add(config);
    state.seats = modules.roster.snapshot();
    this.logTeamDebug("seat.add", { seatId: seat.seatId, name: seat.name, auth: seat.auth });

    const packet = modules.timeline.buildJoinPacket();
    const announcement = modules.timeline.append({
      ts: Date.now(),
      type: "system",
      fromId: USER_SEAT_ID,
      toId: "*",
      text: `席位「${seat.name}」加入圆桌（视角：${seat.perspective}）。当前主线概况：\n${packet.summary}`,
      summary: `席位加入：${seat.name}`,
      mentionIds: [],
    });

    await this._startSeat(seat.seatId);
    // 新席的入场简报只发给它自己：全员看得见主线公告，不必被别人的行动打断。
    modules.inbox.enqueue(
      { ...announcement, text: buildJoinBrief(seat, packet) },
      [seat.seatId],
    );
    this._emit({ type: "seat_status", seatId: seat.seatId, status: seat.status });
    this._emitState();
    this._persistSoon();
    return seat;
  }

  /**
   * 减席（§5.12）：该席 L3 + 未决项回到未决 + 释放写租约；**其它席的回合不动**。
   * 席位记录保留（状态 exited），时间线里的引用仍然有效。
   */
  async removeSeat(seatId: string, requestedBy: "user" | "self" | "peer"): Promise<void> {
    this._assertCanRecord("remove_seat");
    const modules = this._modules!;
    const state = this._state!;
    const seat = modules.roster.get(seatId);
    if (seat === undefined || seat.status === "exited") {
      return;
    }
    this.logTeamDebug("seat.remove", { seatId, requestedBy });

    const runner = this._runners.get(seatId);
    if (runner !== undefined) {
      await runner.apply("L3").catch(() => {});
      await runner.stop().catch(() => {});
      this._runners.delete(seatId);
    }
    await this._disposeSeatSession(seatId);
    modules.health.unregisterSeat(seatId);
    modules.capacity.releaseSeat(seatId);
    modules.leases.release(seatId);
    modules.roster.remove(seatId);
    state.seats = modules.roster.snapshot();

    const released = modules.openItems.releaseOwned(seatId);
    for (const item of released) {
      this._emit({ type: "open_item", item });
    }
    this._appendSystem(
      `席位「${seat.name}」退出（${requestedBy}）。${released.length > 0 ? `其认领的 ${released.length} 条未决项回到未决，任何人都可以接着做。` : ""}`,
      "*",
    );
    this._emit({ type: "seat_status", seatId, status: "exited" });
    this._emitState();
    this._persistSoon();
  }

  /** 改授权（讨论中可改；受限档的路径白名单一起换）。升到 write 必须重建 session（tools 白名单开场定死）。 */
  async updateSeatAuth(seatId: string, auth: ToolAuthTier, pathAllowlist?: string[]): Promise<void> {
    this._assertCanRecord("update_seat_auth");
    const modules = this._modules!;
    const previous = modules.roster.get(seatId);
    if (previous === null || previous === undefined) {
      throw new Error(`席位 ${seatId} 不存在。`);
    }
    const prevAuth = previous.auth;
    const updated = modules.roster.updateAuth(seatId, auth, pathAllowlist);
    if (updated === null) {
      throw new Error(`席位 ${seatId} 不存在。`);
    }
    this._state!.seats = modules.roster.snapshot();
    this._emit({ type: "seat_status", seatId, status: updated.status });
    this._emitState();
    this._persistSoon();

    const session = this._sessions.get(seatId);
    if (prevAuth === "write" && auth !== "write" && session !== undefined) {
      session.setActiveToolsByName(seatToolAllowlist(auth));
      return;
    }
    if (prevAuth !== "write" && auth === "write") {
      await this._rebuildSeatSession(seatId);
    }
  }

  /** 升到 write 档：continueRecent 重建该席 session，保留对话与时长，不碰 inbox/leases。 */
  private async _rebuildSeatSession(seatId: string): Promise<void> {
    const modules = this._modules;
    if (modules === null) {
      return;
    }
    const runner = this._runners.get(seatId);
    if (runner !== undefined) {
      await runner.apply("L3");
      await runner.stop();
      this._runners.delete(seatId);
    }
    modules.health.unregisterSeat(seatId);
    // 同一份 session 文件马上 continueRecent：用量留在 live stats 里，不能再累进 _seatUsage。
    await this._disposeSeatSession(seatId, { rememberUsage: false });
    await this._startSeat(seatId, { resume: true });
    this._runners.get(seatId)?.resume();
  }

  /** 唤醒某席：有 pending 就让它开一轮；没有就发一条系统提示（§5.14）。 */
  async wakeSeat(seatId: string): Promise<void> {
    this._assertCanRecord("wake_seat");
    const modules = this._modules!;
    const runner = this._runners.get(seatId);
    if (runner === undefined) {
      throw new Error(`席位 ${seatId} 没有运行中的 session。`);
    }
    if (modules.inbox.pending(seatId).length > 0) {
      runner.resume();
    } else {
      runner.wake();
    }
    this._persistSoon();
  }

  /** 线程静音（只看与否；主线永远全员可见，FR-4）。 */
  muteThread(threadId: string, muted: boolean): void {
    if (muted) {
      this._mutedThreads.add(threadId);
    } else {
      this._mutedThreads.delete(threadId);
    }
    this._persistSoon();
  }

  /**
   * 降档续跑（H24）：必须 `settings.cheaperModel` 预授权。
   * 只写 `session.agent.state.model` + `sessionManager.appendModelChange`，
   * **禁止** `session.setModel()`（会污染 solo 的全局默认模型）。累计成本不重置。
   */
  async downgradeModels(model: string): Promise<void> {
    this._assertCanRecord("downgrade_models");
    const state = this._state!;
    const modules = this._modules!;
    const preset = state.settings.cheaperModel;
    if (preset === undefined || preset !== model) {
      throw new Error("downgrade_models 需要圆桌设置里预授权的 cheaperModel 且必须一致。");
    }
    const applied: string[] = [];
    for (const [seatId, session] of this._sessions) {
      const resolved = resolveModelSpec(session, model);
      if (resolved === undefined) {
        continue;
      }
      session.agent.state.model = resolved;
      session.sessionManager.appendModelChange(resolved.provider, resolved.id);
      modules.roster.setModel(seatId, `${resolved.provider}/${resolved.id}`);
      applied.push(seatId);
    }
    state.seats = modules.roster.snapshot();
    if (applied.length > 0) {
      this._appendSystem(
        `降档续跑：${applied.length} 个席位切换到 ${model}（已用消耗不重置）。`,
        "*",
      );
    }
    this.logTeamDebug("models.downgraded", { model, seats: applied });
    this._emitState();
    this._persistSoon();
  }

  /**
   * 退出协商（§5.12 / H4）：先记录说法，再决定取消还是执行移除。
   * 超时路径（`settings.exitRequestTimeoutMs`，默认 120s）走同一条应用逻辑。
   */
  async respondExit(requestId: string, statement: string, accept?: boolean): Promise<void> {
    this._assertCanRecord("respond_exit");
    const modules = this._modules!;
    const request = modules.protocol.respondExit(requestId, statement, accept);
    if (request === null) {
      return;
    }
    this._emit({ type: "exit_request", request });
    if (request.status === "done") {
      await this._applyExit(request, "peer");
    }
    this._persistSoon();
  }

  /** 退出协商到点/通过后的实际移除：双方说法入时间线，然后 removeSeat。 */
  private async _applyExit(request: ExitRequest, requestedBy: "self" | "peer"): Promise<void> {
    const modules = this._modules;
    // F3-4：协商的 120s 定时器可能在 stop/dispose 之后才到点，这条路径必须在
    // 已停止的场上变成 no-op（否则 _appendSystem 会用 mkdir 重建刚被归档的目录）。
    const state = this._state;
    if (modules === null || state === null || state.lifecycle === "stopped") {
      return;
    }
    const statements = request.statements
      .map((statement) => `- ${seatLabel(modules.roster, statement.fromId)}：${statement.text}`)
      .join("\n");
    this._appendSystem(
      `退出协商完成：${seatLabel(modules.roster, request.requestedBy)} 请 ${seatLabel(modules.roster, request.targetSeatId)} 退出。双方说法：\n${statements}`,
      "*",
    );
    await this.removeSeat(request.targetSeatId, requestedBy);
  }

  // ==========================================================================
  // 交付物与移交（§4.9 / §4.12c / §4.15）
  // ==========================================================================

  /**
   * 整理（§4.12c）：钉截止点 → 取 aux 槽（满则排队，绝不借 agent-task 槽）→
   * 系统整理跑短命 aux session，用户指定主笔则向该席 L1 注入写作请求。
   * 无人值守「只探索不整理」时直接拒绝。
   */
  async requestWrapUp(author: "system" | string = "system"): Promise<DeliverableVersion> {
    this._assertActive("request_wrap_up");
    const modules = this._modules!;
    if (!modules.metrics.isWrapUpAllowed()) {
      throw new Error("无人值守保护：当前只探索不整理，request_wrap_up 已被拒绝。");
    }
    return this._performWrapUp(author, false);
  }

  /**
   * 整理的实际执行。`force` 只给 `stop({wrapUp:true})` 用：那是 AC-11 授权过的
   * 唯一一次整理调用，此时整场已经暂停，所以绕过 aux 容量池（不排队、不占席位槽）。
   */
  private async _performWrapUp(author: "system" | string, force: boolean): Promise<DeliverableVersion> {
    const modules = this._modules!;
    const deliverable = modules.deliverables.create({ author });
    this.logTeamDebug("wrapup.create", {
      deliverableId: deliverable.id,
      version: deliverable.version,
      cutoffSeq: deliverable.cutoffSeq,
      author,
    });
    this._emit({ type: "deliverable", item: deliverable });

    const jobId = `wrapup:${deliverable.id}`;
    if (!force) {
      if (!modules.capacity.acquireAux(jobId)) {
        // aux 槽满：排队（不占席位槽、不借 agent-task），当前 aux 结束后继续。
        this._pendingWrapUps.push({ deliverableId: deliverable.id, author });
        this.logTeamDebug("wrapup.queued", { deliverableId: deliverable.id });
        this._persistSoon();
        return deliverable;
      }
    }
    try {
      await this._runWrapUp(deliverable, author);
    } finally {
      if (!force) {
        modules.capacity.releaseAux(jobId);
      }
      void this._drainWrapUpQueue();
    }
    this._persistSoon();
    return modules.deliverables.get(deliverable.id) ?? deliverable;
  }

  /** 一个整理任务的执行：系统起草（aux session）或指定席主笔（L1 注入）。 */
  private async _runWrapUp(deliverable: DeliverableVersion, author: "system" | string): Promise<void> {
    const modules = this._modules;
    if (modules === null) {
      return;
    }
    if (author !== "system" && modules.roster.isActive(author)) {
      const seat = modules.roster.get(author)!;
      const item = this._appendSystem(buildSeatWrapUpRequest(deliverable, seat.name), author);
      modules.inbox.enqueue(item, [author]);
      this._nudge([author], "L1", "system");
      return;
    }
    const text = await this._draftWithAuxSession(deliverable);
    // F3-6：aux 起草失败或被 pause/stop 取消时返回空串；空稿绝不能标 ready
    // （AC-5：面板与注意力都会宣称可取用、可移交），本版留在 drafting 等重新整理。
    if (text.trim().length === 0) {
      this._raiseAttention({
        kind: "seat_error",
        text: "整理未产出正文，本版保持整理中；可重新整理。",
      });
      return;
    }
    // F2-3：系统起草同样走 CAS——带着本版 revision 写，期间被别人改过就放弃覆盖。
    const result = modules.deliverables.updateMarkdown(deliverable.id, text, "system", deliverable.revision);
    if (!result.ok) {
      console.warn("[TeamManager] wrap-up markdown rejected:", result.currentVersion, result.currentRevision);
      this._raiseAttention({
        kind: "seat_error",
        text: `整理写回冲突（当前 v${result.currentVersion} / revision ${result.currentRevision}）：请基于最新版另开一版。`,
      });
      return;
    }
    const updated = modules.deliverables.get(deliverable.id);
    if (updated !== undefined) {
      this._emit({ type: "deliverable", item: updated });
      this._announceDeliverableReady(updated);
    }
  }

  /** 短命 aux session 起草（无写工具、无 team_bash，计入辅助槽与团队成本）。 */
  private async _draftWithAuxSession(deliverable: DeliverableVersion): Promise<string> {
    const modules = this._modules;
    if (modules === null || this._authStorage === null) {
      return "";
    }
    const sessionDir = join(roundtableSessionsDir(modules.roundtableId), "aux");
    const sessionManager = SessionManager.create(this._physicalCwd, sessionDir);
    const settingsManager = SettingsManager.create(this._physicalCwd);
    const resourceLoader = new DefaultResourceLoader({
      cwd: this._physicalCwd,
      agentDir: getAgentDir(),
      settingsManager,
      extensionFactories: [createActiveCompressionExtension(() => sessionManager)],
    });
    await resourceLoader.reload();

    const session = (await this._sessionFactory({
      cwd: this._physicalCwd,
      runtimeCwd: this._logicalCwd,
      executionBackend: this._executionBackend ?? undefined,
      runtimeEnvironmentOverride: this._runtimeEnvironmentOverride,
      sessionManager,
      settingsManager,
      resourceLoader,
      authStorage: this._authStorage,
      sessionStartEvent: { type: "session_start", reason: "new" },
      enableBuiltInEnhancementTools: false,
      // 整理者：只读四工具，没有写工具、没有 team_bash、没有席位工具。
      tools: ["read", "grep", "find", "ls"],
      excludeTools: [...SEAT_DENIED_TOOL_NAMES],
    })).session;

    const jobId = `wrapup:${deliverable.id}`;
    const abort = (): void => {
      void session.abort().catch(() => {});
    };
    this._aux = { jobId, session, abort };
    try {
      await session.prompt(buildWrapUpDigest(modules, deliverable));
      const text = session.getLastAssistantText() ?? "";
      this._accumulateAuxUsage(session);
      return text;
    } catch (err) {
      this._accumulateAuxUsage(session);
      console.warn("[TeamManager] aux wrap-up session failed:", err);
      return "";
    } finally {
      this._aux = null;
      await session.dispose({ reason: "quit" }).catch(() => {});
    }
  }

  /** aux 结束/取消时把用量并入累计（H17：辅助 session 计入团队成本）。 */
  private _accumulateAuxUsage(session: AgentSession): void {
    const stats = statsOf(session);
    this._auxUsage = {
      tokensIn: this._auxUsage.tokensIn + stats.tokens.input,
      tokensOut: this._auxUsage.tokensOut + stats.tokens.output,
      cost: this._auxUsage.cost + stats.cost,
    };
  }

  private _abortAux(): void {
    const aux = this._aux;
    if (aux !== null) {
      this._accumulateAuxUsage(aux.session);
      aux.abort();
      this._modules?.capacity.releaseAux(aux.jobId);
      this._aux = null;
    }
    this._pendingWrapUps.length = 0;
  }

  /** aux 槽空出来后继续排队的整理任务。 */
  private async _drainWrapUpQueue(): Promise<void> {
    const modules = this._modules;
    if (modules === null || this._state?.lifecycle !== "active") {
      return;
    }
    const next = this._pendingWrapUps.shift();
    if (next === undefined) {
      return;
    }
    const jobId = `wrapup:${next.deliverableId}`;
    if (!modules.capacity.acquireAux(jobId)) {
      this._pendingWrapUps.unshift(next);
      return;
    }
    try {
      const deliverable = modules.deliverables.get(next.deliverableId) ?? null;
      if (deliverable !== null) {
        await this._runWrapUp(deliverable, next.author);
      }
    } finally {
      modules.capacity.releaseAux(jobId);
      void this._drainWrapUpQueue();
    }
  }

  reviseDeliverable(
    id: string,
    markdown: string,
    actor: string,
    expectedRevision?: number,
  ): { ok: true } | { ok: false; conflict: true; currentVersion: number; currentRevision: number } {
    const modules = this._modules;
    if (modules === null) {
      return { ok: false, conflict: true, currentVersion: 0, currentRevision: 0 };
    }
    const current = modules.deliverables.get(id);
    const wasDrafting = current?.status === "drafting";
    if (current !== undefined && current.status === "drafting" && actor !== current.author && actor !== "system") {
      return {
        ok: false,
        conflict: true,
        currentVersion: current.version,
        currentRevision: current.revision,
      };
    }
    // 席位/用户必须带自己读到的 revision。缺省只允许 drafting 的首次 publish（aux / 主笔）。
    const token = expectedRevision ?? (current?.status === "drafting" ? current.revision : undefined);
    if (token === undefined) {
      const newest = modules.deliverables.latest();
      return {
        ok: false,
        conflict: true,
        currentVersion: newest?.version ?? 0,
        currentRevision: newest?.revision ?? 0,
      };
    }
    const result = modules.deliverables.updateMarkdown(id, markdown, actor, token);
    if (result.ok) {
      const updated = modules.deliverables.get(id);
      if (updated !== undefined) {
        this._emit({ type: "deliverable", item: updated });
        if (wasDrafting && updated.status === "ready") {
          this._announceDeliverableReady(updated);
        }
      }
      this._persistSoon();
    }
    return result;
  }

  private _announceDeliverableReady(deliverable: DeliverableVersion): void {
    if (deliverable.status !== "ready") {
      return;
    }
    this._raiseAttention({
      kind: "deliverable_ready",
      refId: deliverable.id,
      text: `交付物 v${deliverable.version} 已就绪（截止 seq=${deliverable.cutoffSeq}）：可取用、可修订、可移交。`,
    });
  }

  stanceOnDeliverable(
    id: string,
    seatId: string,
    stance: "support" | "oppose" | "conditional",
    reason?: string,
    confidence?: "low" | "medium" | "high",
  ): { ok: true } | { ok: false; error: string } {
    const modules = this._modules;
    if (modules === null) {
      return { ok: false, error: "当前没有活跃圆桌。" };
    }
    const result = modules.deliverables.setStance(id, seatId, stance, reason, confidence);
    if (result.ok) {
      const updated = modules.deliverables.get(id);
      if (updated !== undefined) {
        this._emit({ type: "deliverable", item: updated });
      }
      this._persistSoon();
    }
    return result;
  }

  /** Markdown 导出（AC-21）+ H8 归档提示（只提示，不静默丢场）。 */
  async exportMarkdown(): Promise<string> {
    const modules = this._modules;
    if (modules === null || this._state === null) {
      throw new Error("没有圆桌可导出。");
    }
    const state = this.getState()!;
    const timeline = modules.timeline.list();
    const notice = archiveNotice({
      timelineBytes: await this._timelineFileSize(modules.roundtableId),
      timelineEntries: timeline.length,
    });
    if (notice !== null) {
      this._appendSystem(notice.text, "*");
    }
    const markdown = exportRoundtableMarkdown({
      state,
      timeline,
      openItems: modules.openItems.list(),
      deliverables: modules.deliverables.list(),
      attention: modules.attention.list(),
      inbox: modules.inbox.snapshot(),
      metrics: this.getMetrics(),
      mutedThreads: [...this._mutedThreads],
      archived: state.lifecycle === "stopped",
    });
    return notice === null ? markdown : `> ${notice.text}\n\n${markdown}`;
  }

  /** 移交 payload（§4.15）：绑具体交付物版本；只产文本，不碰 solo。 */
  async buildHandoff(deliverableId: string, target: "solo" | "plan"): Promise<{ text: string }> {
    const modules = this._modules;
    const state = this._state;
    if (modules === null || state === null) {
      throw new Error("没有圆桌可移交。");
    }
    const deliverable = modules.deliverables.get(deliverableId);
    if (deliverable === undefined) {
      throw new Error(`交付物 ${deliverableId} 不存在。`);
    }
    const input = { state: this.getState()!, deliverable };
    return target === "plan"
      ? { text: buildPlanHandoffRequest(input).requestText }
      : { text: buildSoloHandoffPrompt(input) };
  }

  // ==========================================================================
  // 注意力 / 设置 / 预设 / 事件
  // ==========================================================================

  ackAttention(id: string): void {
    this._modules?.attention.ack(id);
    this._persistNow();
  }

  /** 用户批/拒权限：写回该席 inbox（L1），不复活已 abort 的 tool call（H23）。 */
  respondPermission(requestId: string, approved: boolean, reason?: string): void {
    const modules = this._modules;
    if (modules === null) {
      return;
    }
    const request = modules.protocol.respondPermission(requestId, approved, reason);
    if (request === null) {
      return;
    }
    this.logTeamDebug("permission.responded", { requestId, approved, reason, seatId: request.agentId });
    const item = this._appendSystem(
      `权限${approved ? "已批准" : "已拒绝"}：${request.tool}${reason !== undefined && reason.length > 0 ? `（${reason}）` : ""}`,
      request.agentId,
    );
    if (modules.roster.isActive(request.agentId)) {
      modules.inbox.enqueue(item, [request.agentId]);
      this._nudge([request.agentId], "L1", "user");
    }
    this._persistSoon();
  }

  /** 改圆桌设置。l2 预算就地更新（打断 controller 持有同一对象，H5 可实时改）。 */
  setSettings(settings: Partial<RoundtableSettings>): void {
    const state = this._state;
    const modules = this._modules;
    if (state === null || modules === null || state.lifecycle === "stopped") {
      return;
    }
    applySettings(state.settings, mergeRoundtableSettings(state.settings, settings));
    this._onOrderedModeChanged(state.settings.orderedMode);
    this.logTeamDebug("settings.set", { settings });
    this._emitState();
    this._persistSoon();
  }

  /** 预设（plan §6.4）：存在 `getAgentDir()/roundtable-presets.json`，不属于工作区 hash。 */
  async listPresets(): Promise<RoundtablePreset[]> {
    return readPresets();
  }

  async savePreset(name: string, seats: SeatConfig[]): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      throw new Error("预设名不能为空。");
    }
    const presets = await readPresets();
    const next = presets.filter((preset) => preset.name !== trimmed);
    next.push({ name: trimmed, seats: seats.map((seat) => ({ ...seat })) });
    await writePresets(next);
  }

  async deletePreset(name: string): Promise<void> {
    const presets = await readPresets();
    await writePresets(presets.filter((preset) => preset.name !== name));
  }

  /** 订阅圆桌事件（IPC 转发）。多个订阅者；返回退订函数。 */
  onEvent(callback: (event: TeamEvent) => void): () => void {
    this._eventCallbacks.push(callback);
    return () => {
      const index = this._eventCallbacks.indexOf(callback);
      if (index >= 0) {
        this._eventCallbacks.splice(index, 1);
      }
    };
  }

  logTeamDebug(event: string, payload: unknown = {}): void {
    this._debugLogger.log(event, {
      roundtableId: this._state?.roundtableId,
      lifecycle: this._state?.lifecycle,
      seats: this._modules?.roster.size,
      ...(
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? payload as Record<string, unknown>
          : { value: payload }
      ),
    });
  }

  // ==========================================================================
  // RoundtableToolHost（§4.12b：席位工具的唯一接缝）
  // ==========================================================================

  /**
   * 席位发言：`timeline.append`（已记录）→ 有序门。
   * - 门收下 argument（H28）：工具立刻得到 `queued: true`，投递在放行时发生，
   *   该席状态投影为 `waiting_turn`；
   * - 否则立即 inbox + L1，并广播投递态变化。
   */
  async postSeatMessage(fromSeatId: string, params: SendTeamMessageParams): Promise<PostSeatMessageResult> {
    const modules = this._modules;
    const state = this._state;
    if (modules === null || state === null) {
      return { ok: false, error: "当前没有活跃圆桌。" };
    }
    if (!modules.roster.isActive(fromSeatId)) {
      return { ok: false, error: `席位 ${fromSeatId} 不在圆桌上（可能已退出）。` };
    }
    if (params.to !== "*" && params.to !== USER_SEAT_ID && !modules.roster.isActive(params.to)) {
      return { ok: false, error: `找不到收件席 "${params.to}"。` };
    }

    const item = modules.timeline.append({
      ts: Date.now(),
      type: params.type,
      fromId: fromSeatId,
      toId: params.to,
      text: params.text,
      summary: params.summary ?? firstLine(params.text),
      utteranceKind: params.utteranceKind,
      threadId: params.threadId,
      replyToId: params.replyToId,
      basedOnId: params.basedOnId,
      knowledgeCard: params.knowledgeCard,
      interrupt: params.interrupt ?? "L1",
      mentionIds: params.mentionIds,
    });
    modules.roster.markSpoke(fromSeatId);
    modules.roster.touch(fromSeatId);
    // 落盘 + 事件由 timeline.onAppend 的统一出口负责（F3-2）。
    // 状态由该席 run 的事件驱动（不发消息改状态），这里只更新发言时间。

    // H44：公开消息 @ 到用户（或直接发给用户）→ 注意力面（H21 的 mentionIds）。
    if (item.mentionIds.includes(USER_SEAT_ID) || item.toId === USER_SEAT_ID) {
      this._raiseAttention({
        kind: "user_mentioned",
        seatId: fromSeatId,
        refId: item.id,
        text: `${seatLabel(modules.roster, fromSeatId)} 在讨论中点名了用户：${firstLine(params.text)}`,
      });
    }

    const admission = modules.gate.admit({
      messageId: item.id,
      fromId: fromSeatId,
      utteranceKind: item.utteranceKind ?? "note",
      mentionIds: item.mentionIds,
    });
    if (!admission.ok) {
      // 已记录、未投递（H28）：放行由 gate.onReleased 触发。
      this._setSeatStatus(fromSeatId, "waiting_turn");
      this.logTeamDebug("seat.message.queued", {
        seatId: fromSeatId,
        messageId: item.id,
        position: admission.position,
        waitMs: admission.waitMs,
      });
      return { ok: true, messageId: item.id, queued: true };
    }

    const targets = this._messageTargets(item.toId);
    modules.inbox.enqueue(item, targets);
    this._nudge(targets, params.interrupt ?? "L1", "seat", fromSeatId, params.reason);
    this._persistSoon();
    this._metrics?.evaluate();
    return { ok: true, messageId: item.id };
  }

  claimWritePaths(
    seatId: string,
    paths: string[],
  ): { ok: true; acquired: string[] } | { ok: false; conflicts: Array<{ path: string; ownerSeatId: string }> } {
    const modules = this._modules;
    if (modules === null) {
      return { ok: false, conflicts: [] };
    }
    const acquired: string[] = [];
    const conflicts: Array<{ path: string; ownerSeatId: string }> = [];
    if (modules.roster.get(seatId)?.auth !== "write") {
      return { ok: false, conflicts: paths.map((path) => ({ path, ownerSeatId: "" })) };
    }
    for (const path of paths) {
      const result = modules.leases.acquire(seatId, path);
      if (result.ok) {
        acquired.push(path);
        continue;
      }
      conflicts.push({ path, ownerSeatId: modules.leases.ownerOf(path) ?? "" });
    }
    if (conflicts.length === 0) {
      return { ok: true, acquired };
    }
    return { ok: false, conflicts };
  }

  releaseWritePaths(seatId: string, paths?: string[]): void {
    const modules = this._modules;
    if (modules === null) {
      return;
    }
    if (paths === undefined) {
      modules.leases.release(seatId);
      return;
    }
    for (const path of paths) {
      modules.leases.release(seatId, path);
    }
  }

  openItem(seatId: string, subject: string, body: string): OpenItem {
    const modules = this._modules;
    if (modules === null) {
      throw new Error("当前没有活跃圆桌。");
    }
    const item = modules.openItems.open({ subject, body, createdBy: seatId });
    this._emit({ type: "open_item", item });
    this._persistSoon();
    return item;
  }

  claimOpenItem(seatId: string, id: string, note?: string): OpenItem | null {
    const modules = this._modules;
    if (modules === null) {
      return null;
    }
    const item = modules.openItems.claim(id, seatId, note);
    if (item !== null) {
      this._emit({ type: "open_item", item });
      this._persistSoon();
    }
    return item;
  }

  resolveOpenItem(seatId: string, id: string, note?: string): OpenItem | null {
    const modules = this._modules;
    if (modules === null) {
      return null;
    }
    const item = modules.openItems.resolve(id, seatId, note);
    if (item !== null) {
      this._emit({ type: "open_item", item });
      this._persistSoon();
    }
    return item;
  }

  /** 线程结论上浮到主线（FR-4）：主线记录 + 全员可见。 */
  promoteThread(seatId: string, threadId: string, conclusion: string): TimelineItem {
    const modules = this._modules;
    if (modules === null) {
      throw new Error("当前没有活跃圆桌。");
    }
    const item = modules.timeline.append({
      ts: Date.now(),
      type: "thread_promo",
      fromId: seatId,
      toId: "*",
      text: conclusion,
      summary: `线程 ${threadId} 结论上浮：${firstLine(conclusion)}`,
      mentionIds: [],
    });
    modules.inbox.enqueue(item, modules.roster.activeIds());
    this._nudge(modules.roster.activeIds(), "L0", "seat", seatId);
    this._persistSoon();
    return item;
  }

  /** 对等请求（不派单）：发一条公开的 question 给目标席。 */
  async requestPeerExplore(fromSeatId: string, to: string, ask: string, scope?: string): Promise<void> {
    const modules = this._modules;
    if (modules === null) {
      throw new Error("当前没有活跃圆桌。");
    }
    const target = to === "*" ? "*" : modules.roster.isActive(to) ? to : null;
    if (target === null || target === USER_SEAT_ID) {
      throw new Error(`对等请求的目标必须是席位："${to}"。`);
    }
    const text = scope === undefined || scope.trim().length === 0
      ? ask
      : `${ask}\n\n建议范围：${scope}`;
    const result = await this.postSeatMessage(fromSeatId, {
      to: target,
      text,
      summary: `对等请求：${firstLine(ask)}`,
      utteranceKind: "question",
      type: "question",
      interrupt: "L1",
      mentionIds: target === "*" ? [] : [target],
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
  }

  /**
   * 唯一权限生产者（H1/H23）：同步记录 + 立即返回 submitted；注意力面 + 协议事件
   * 同刻发出。**禁止**返回等待用户的 Promise。
   */
  requestPermission(
    seatId: string,
    tool: string,
    args: Record<string, unknown>,
    reason?: string,
  ): { requestId: string; submitted: true } {
    const modules = this._modules;
    if (modules === null || this._state === null) {
      throw new Error("当前没有活跃圆桌。");
    }
    // F3-10：同席同 (tool,args) 幂等（不新增记录/注意力/落盘），每席 pending 有上限
    // （否则循环调用或被诱导的席位可以无限刷注意力面与 meta.json）。
    const argsJson = JSON.stringify(args ?? {});
    const existing = modules.protocol.findPendingPermission(seatId, tool, argsJson);
    if (existing !== null) {
      this.logTeamDebug("permission.deduped", { seatId, tool, requestId: existing.id });
      return { requestId: existing.id, submitted: true };
    }
    if (modules.protocol.countPendingPermissions(seatId) >= MAX_PENDING_PERMISSIONS_PER_SEAT) {
      throw new Error(
        `本席待批权限已达上限 ${MAX_PENDING_PERMISSIONS_PER_SEAT}：等用户答复后再申请，或改用已有请求。`,
      );
    }
    const request = modules.protocol.requestPermission({
      seatId,
      roundtableName: this._state.name,
      tool,
      args,
      reason,
    });
    this.logTeamDebug("permission.request", { seatId, tool, requestId: request.id, reason });
    this._emit({ type: "protocol_permission_request", request });
    this._raiseAttention({
      kind: "permission",
      seatId,
      refId: request.id,
      text: `${seatLabel(modules.roster, seatId)} 请求权限：${tool}${reason !== undefined ? `（${reason}）` : ""}`,
    });
    this._persistSoon();
    return { requestId: request.id, submitted: true };
  }

  /**
   * 退出请求（§5.12）：自己请自己退出立即执行；请他人退出只开启协商
   * （`settings.exitRequestTimeoutMs` 到点后按请求执行并记录双方说法）。
   */
  async requestExit(fromSeatId: string, targetSeatId: string | undefined, reason: string): Promise<void> {
    const modules = this._modules;
    if (modules === null) {
      throw new Error("当前没有活跃圆桌。");
    }
    const target = targetSeatId === undefined || targetSeatId === fromSeatId ? fromSeatId : targetSeatId;
    if (!modules.roster.isActive(target)) {
      throw new Error(`席位 ${target} 不在圆桌上。`);
    }
    const request = modules.protocol.requestExit({
      targetSeatId: target,
      requestedBy: fromSeatId,
      reason,
      timeoutMs: this._state?.settings.exitRequestTimeoutMs,
    });
    this.logTeamDebug("exit.request", {
      requestId: request.id,
      targetSeatId: target,
      requestedBy: fromSeatId,
      status: request.status,
    });
    this._emit({ type: "exit_request", request });
    this._raiseAttention({
      kind: "exit_request",
      seatId: target,
      refId: request.id,
      text: target === fromSeatId
        ? `${seatLabel(modules.roster, fromSeatId)} 自愿退出：${reason}`
        : `${seatLabel(modules.roster, fromSeatId)} 请 ${seatLabel(modules.roster, target)} 退出：${reason}`,
    });
    if (request.status === "done") {
      await this._applyExit(request, "self");
    }
    this._persistSoon();
  }

  /** team_bash：cwd 只来自 `SeatExecutionView.getCwd()`，backend 为 host 的对象身份。 */
  async runTeamBash(
    _seatId: string,
    command: string,
    _paths: string[] | undefined,
    timeout: number | undefined,
    signal: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    // paths 只服务于 policy 的租约校验（S2b 已在放行前查过），执行阶段不再解析。
    return runTeamBashCommand(
      {
        exec: this._seatExecView(),
        backend: this._executionBackend ?? undefined,
        // F4-9：与 solo 的 bash 跑在同一个 shell 上（settings 在建场时读一次）。
        shellPath: this._shellConfig.shellPath,
        shellCommandPrefix: this._shellConfig.shellCommandPrefix,
      },
      command,
      timeout,
      signal,
    );
  }

  /** 本场指标实例（未建场时为 null）。 */
  private get _metrics(): RoundtableMetrics | null {
    return this._modules?.metrics ?? null;
  }

  // ==========================================================================
  // 内部：模块装配
  // ==========================================================================

  /** 建齐本场全部模块并接好注意力/投递/放行三条订阅（一场一次）。 */
  private _installModules(
    roundtableId: string,
    tier: RoundtableTier,
    settings: RoundtableSettings,
  ): RoundtableModules {
    const roster = new RoundtableRoster(roundtableId, tier);
    const timeline = new TimelineLog();
    const inbox = new SeatInbox({ getActiveSeatIds: () => roster.activeIds() });
    const attention = new AttentionBus();
    // F4-9：席位 team_bash 必须和 solo 的 bash 用同一个 shell（settings 只在这里读
    // 一次，`runTeamBash` 直接用；不在每次调用时重新读盘）。
    const settingsManager = SettingsManager.create(this._physicalCwd);
    this._shellConfig = {
      shellPath: settingsManager.getShellPath(),
      shellCommandPrefix: settingsManager.getShellCommandPrefix(),
    };
    const gate = new OrderedSpeechGate(
      () => this._state?.settings.orderedMode === true,
      () => this._state?.settings.orderedReleaseMs ?? ORDERED_RELEASE_MS,
      (seatId) => roster.get(seatId)?.lastSpokeAt,
    );
    const openItems = new OpenItemBoard();
    const leases = new WriteLeaseTable(
      (input) => this._seatExecView().resolvePath(input),
      (info) => {
        this._raiseAttention({
          kind: "write_conflict",
          seatId: info.requestedBy,
          refId: info.ownerSeatId,
          text: info.staleRead === true
            ? `写冲突：${seatLabel(roster, info.requestedBy)} 想写 ${info.path}，但它读到的副本已被别的席位改写，必须先重新 read。`
            : `写冲突：${info.path} 已租给 ${info.ownerSeatId === undefined ? "他人" : seatLabel(roster, info.ownerSeatId)}，${seatLabel(roster, info.requestedBy)} 的申请被拒绝。`,
        });
      },
    );
    const capacity = new TeamCapacityPool();
    const deliverables = new DeliverableStore({ getCutoffSeq: () => timeline.lastSeq() });
    const persistence = new RoundtablePersistence({ physicalCwd: this._physicalCwd, roundtableId });
    const protocol = new TeamProtocolManager({
      onExitDue: (request) => {
        // 超时路径与 respondExit 应用方式一致：记录双方说法后执行移除。
        this.logTeamDebug("exit.timeout", { requestId: request.id, targetSeatId: request.targetSeatId });
        this._emit({ type: "exit_request", request });
        // F3-4：定时器可能在 stop/dispose 之后才到点；applyExit 自身已守 lifecycle，
        // 这里再兜住 Promise（否则主进程会吃到 unhandledRejection）。
        void this._applyExit(request, "peer").catch((err) => {
          console.warn("[TeamManager] exit timeout apply failed:", err);
        });
      },
    });
    /**
     * 三个生产者模块只 push、不落盘也不发事件（F3-1）：把它们的 attention 参数
     * 统一收口到 `_raiseAttention`（push + `attention` 事件 + attention.jsonl）。
     * 直接接裸 AttentionBus 会让 l2_fused / seat_stuck / soft_budget / wrap_up_ready
     * / hard_stop 五类既不实时到渲染层、也不落盘（FR-8 / §4.6b / H44）。
     * `modules.attention` 仍是裸 bus：facade 自己用它做 push/ack/list/restore。
     */
    const attentionSink = {
      push: (item: { kind: AttentionItem["kind"]; text: string; seatId?: string; refId?: string }) =>
        this._raiseAttention(item),
    };
    const interrupts = new SeatInterruptController({
      attention: attentionSink,
      budget: settings.l2,
      isToolBatchInProgress: (seatId) => this._runners.get(seatId)?.isToolBatchInProgress() ?? false,
    });
    const health = new RoundtableHealth({
      attention: attentionSink,
      onRecovered: (seatId) => {
        this._setSeatStatus(seatId, "exploring", { currentActivity: "卡死恢复：分段续跑" });
      },
    });
    const metrics = new RoundtableMetrics({
      getSeats: () => this._metricsSeats(),
      getTimeline: () => timeline.list(),
      getSettings: () => settings,
      getLifecycle: () => this._state?.lifecycle ?? "inactive",
      getCreatedAt: () => this._state?.createdAt ?? Date.now(),
      getAuxStats: () => this._auxStats(),
      attention: attentionSink,
      onPauseRequested: () => {
        void this.pause();
      },
      onHardStop: () => {
        void this.pause();
      },
      getThresholdTotals: () => {
        const snapshot = this.getMetrics();
        return { cost: snapshot.totals.cost, durationMs: snapshot.totals.durationMs };
      },
    });

    const offGate = gate.onReleased((messageId) => {
      this._onArgumentReleased(messageId);
    });
    const offInbox = inbox.onChange((seatId) => {
      this._syncDelivery(seatId);
      this._persistSoon();
    });
    // F3-2：时间线的落盘 + 事件只有一个出口。SeatRunner 直接持有的 TimelineLog
    // （唤醒提示、半成品标注）也由此进 timeline.jsonl 并发 timeline_item。
    const offTimelineAppend = timeline.onAppend((item) => {
      if (this._replayingTimeline) {
        return;
      }
      this._appendTimelinePersist(item);
      this._emitTimeline(item);
    });

    this._modules = {
      roundtableId,
      roster,
      timeline,
      inbox,
      attention,
      gate,
      openItems,
      leases,
      interrupts,
      capacity,
      deliverables,
      persistence,
      health,
      metrics,
      protocol,
      offGate,
      offInbox,
      offTimelineAppend,
    };
    this._runners.clear();
    this._sessions.clear();
    this._unsubscribeSeats.clear();
    this._seatDurations.clear();
    this._seatUsage.clear();
    this._deliveryStates.clear();
    this._auxUsage = { tokensIn: 0, tokensOut: 0, cost: 0 };
    this._pendingWrapUps.length = 0;
    health.start();
    return this._modules;
  }

  // ==========================================================================
  // 内部：席位 session 与事件
  // ==========================================================================

  /** 启动所有还没有 runner 的活跃席（恢复后 resume 用）。 */
  private async _startAllSeats(): Promise<void> {
    const modules = this._modules;
    if (modules === null) {
      return;
    }
    await Promise.all(modules.roster.list().map((seat) => this._startSeat(seat.seatId)));
    for (const seat of modules.roster.list()) {
      this._runners.get(seat.seatId)?.resume();
    }
  }

  /**
   * 建立一席的 AgentSession + SeatRunner（plan §4.13 / §6.3）。
   * 失败只把该席标成 error 并发 `seat_error`：圆桌其余部分继续（§5.14 第一行）。
   */
  private async _startSeat(seatId: string, options: { resume?: boolean } = {}): Promise<void> {
    const modules = this._modules;
    const state = this._state;
    if (modules === null || state === null || this._runners.has(seatId)) {
      return;
    }
    const seat = modules.roster.get(seatId);
    if (seat === undefined || seat.status === "exited") {
      return;
    }
    try {
      const session = await this._createSeatSession(seat, options.resume === true);
      if (this._modules !== modules) {
        // 建 session 期间圆桌已经换场：把刚建的 session 收干净。
        await session.dispose({ reason: "quit" }).catch(() => {});
        return;
      }
      const runner = new SeatRunner({
        seatId,
        // SDK 的 AgentSessionEvent 与 shared/types 的 AgentSessionEvent 结构等价但
        // 分属两套 AgentMessage 定义（历史原因），这里按既有做法断言一次。
        session: session as unknown as SeatSessionLike,
        exec: this._seatExecView(),
        inbox: modules.inbox,
        timeline: modules.timeline,
        interrupts: modules.interrupts,
        capacity: modules.capacity,
        host: this,
        stuckMs: STUCK_MS,
        // H20/H43：无人值守降速由 metrics 决定（S3 只留了注入点）。
        getMinIdleMs: () => this._metrics?.getMinIdleMs() ?? 0,
      });
      runner.start();
      this._sessions.set(seatId, session);
      this._runners.set(seatId, runner);
      if (!this._seatDurations.has(seatId)) {
        this._seatDurations.set(seatId, { total: 0, startedAt: null });
      } else {
        const duration = this._seatDurations.get(seatId)!;
        duration.startedAt = null;
      }
      this._unsubscribeSeats.set(
        seatId,
        session.subscribe((event) => {
          this._onSeatEvent(seatId, event);
        }),
      );
      modules.health.registerSeat(runner);
      modules.capacity.acquireSeat(seatId);
      this._setSeatStatus(seatId, "idle");
      this.logTeamDebug("seat.session.created", {
        seatId,
        slug: seat.slug,
        auth: seat.auth,
        sessionDir: seatSessionDir(modules.roundtableId, seat.slug),
      });
    } catch (err) {
      this._markSeatError(seatId, err);
    }
  }

  /** 席位 createAgentSession 的全部入参（plan §4.13：一条都不能少）。 */
  private async _createSeatSession(seat: SeatInfo, resume = false): Promise<AgentSession> {
    if (this._authStorage === null || this._modules === null) {
      throw new Error("TeamManager not initialized.");
    }
    const agentDir = getAgentDir();
    const sessionDir = seatSessionDir(this._modules.roundtableId, seat.slug);
    const sessionManager = resume
      ? SessionManager.continueRecent(this._physicalCwd, sessionDir)
      : SessionManager.create(this._physicalCwd, sessionDir);
    const settingsManager = SettingsManager.create(this._physicalCwd);
    const resourceLoader = new DefaultResourceLoader({
      cwd: this._physicalCwd,
      agentDir,
      settingsManager,
      extensionFactories: [
        (pi) => {
          registerSeatIdentity(this, pi, seat.seatId);
        },
        createActiveCompressionExtension(() => sessionManager),
      ],
    });
    await resourceLoader.reload();

    const result = await this._sessionFactory({
      cwd: this._physicalCwd,
      // H34：runtimeCwd 用逻辑 cwd；席位读不到 session 的私有 _runtimeCwd。
      runtimeCwd: this._logicalCwd,
      executionBackend: this._executionBackend ?? undefined,
      runtimeEnvironmentOverride: this._runtimeEnvironmentOverride,
      sessionManager,
      settingsManager,
      resourceLoader,
      authStorage: this._authStorage,
      sessionStartEvent: { type: "session_start", reason: resume ? "resume" : "new" },
      // H29/H35：增强工具关掉，tools 白名单必须含只读四工具 + 席位工具。
      enableBuiltInEnhancementTools: false,
      shouldStopAfterTurn: () => this._modules?.interrupts.shouldStopAfterTurn(seat.seatId) ?? false,
      tools: seatToolAllowlist(seat.auth),
      excludeTools: [...SEAT_DENIED_TOOL_NAMES],
      customTools: registerSeatTools({ seatId: seat.seatId, host: this }),
      // §4.6：永不 undefined；忽略 input.mode，只看席位档位。
      hostToolPolicyOverride: createSeatToolPolicy({
        getAuth: (targetSeatId) => this._modules?.roster.get(targetSeatId)?.auth ?? "restricted",
        getAllowlist: (targetSeatId) => this._modules?.roster.get(targetSeatId)?.pathAllowlist,
        getReadonlyCommands: (targetSeatId) => this._modules?.roster.get(targetSeatId)?.readonlyCommandAllowlist ?? [],
        bashEnabled: (targetSeatId) => this._modules?.roster.get(targetSeatId)?.bashEnabled === true,
        leases: this._modules.leases,
        logicalCwd: this._logicalCwd,
        seatId: seat.seatId,
        teamToolNames: [...SEAT_TOOL_NAMES],
        // §5.7：被拒的写入在时间线上留一条系统提示。
        onDenied: (info) => {
          this._onPolicyDenied(info);
        },
      }),
    });

    // 席位模型（可选）走 H24 的赋值路径，绝不 setModel()。
    const modelSpec = seat.model?.trim();
    if (modelSpec !== undefined && modelSpec.length > 0) {
      const resolved = resolveModelSpec(result.session, modelSpec);
      if (resolved !== undefined) {
        result.session.agent.state.model = resolved;
        result.session.sessionManager.appendModelChange(resolved.provider, resolved.id);
      } else {
        console.warn(`[TeamManager] Seat ${seat.seatId} model "${modelSpec}" not found; using default`);
      }
    }
    return result.session;
  }

  /** 席位 session 事件：转发 `seat_event` + 状态/活动投影 + 统计（K / AC-22）。 */
  private _onSeatEvent(seatId: string, event: SdkSessionEvent): void {
    const modules = this._modules;
    if (modules === null) {
      return;
    }
    this._emit({ type: "seat_event", seatId, event: event as unknown as AgentSessionEvent });
    modules.roster.touch(seatId);
    switch (event.type) {
      case "agent_start": {
        const duration = this._seatDurations.get(seatId) ?? { total: 0, startedAt: null };
        duration.startedAt = Date.now();
        this._seatDurations.set(seatId, duration);
        this._setSeatStatus(seatId, "speaking");
        break;
      }
      case "tool_execution_start":
        this._setSeatStatus(seatId, "exploring", { currentActivity: event.toolName });
        break;
      case "agent_end": {
        this._finishSeatDuration(seatId);
        this._setSeatStatus(seatId, "idle");
        this._persistSoon();
        this._emit({ type: "metrics", snapshot: this.getMetrics() });
        this._metrics?.evaluate();
        break;
      }
      case "api_error": {
        if (event.retryable === false) {
          this._markSeatError(seatId, event.errorMessage);
        }
        break;
      }
      case "file_change": {
        // §4.6 末段：落到未持约路径 → Attention write_conflict（事后审计，不代替事前 deny）。
        this._reportUnleasedFileChange(seatId, event.change?.path);
        break;
      }
      default:
        break;
    }
  }

  /**
   * §4.6 末段的事后审计：席位在未持约路径上产生了文件变更就报一条 `write_conflict`。
   * 事前 deny 挡不住 team_bash 之类的旁路，所以这条路径必须存在；去重按
   * `(seatId, path)` 30 秒一次，表有界（F3-7）。
   */
  private _reportUnleasedFileChange(seatId: string, path: string | undefined): void {
    const modules = this._modules;
    if (modules === null || path === undefined || path.length === 0) {
      return;
    }
    if (modules.leases.ownerOf(path) === seatId) {
      return;
    }
    const key = `${seatId}\u0000${path}`;
    const now = Date.now();
    if (now - (this._fileChangeNoticeAt.get(key) ?? 0) < FILE_CHANGE_NOTICE_WINDOW_MS) {
      return;
    }
    if (this._fileChangeNoticeAt.size >= FILE_CHANGE_NOTICE_MAX_KEYS) {
      const oldest = this._fileChangeNoticeAt.keys().next().value;
      if (oldest !== undefined) {
        this._fileChangeNoticeAt.delete(oldest);
      }
    }
    this._fileChangeNoticeAt.set(key, now);
    this.logTeamDebug("seat.file_change.unleased", { seatId, path });
    this._raiseAttention({
      kind: "write_conflict",
      seatId,
      text: `席位在未持约路径上产生了文件变更：${path}`,
    });
  }

  private _finishSeatDuration(seatId: string): void {
    const duration = this._seatDurations.get(seatId);
    if (duration === undefined || duration.startedAt === null) {
      return;
    }
    duration.total += Date.now() - duration.startedAt;
    duration.startedAt = null;
  }

  /** 席位不可用（session 创建失败 / 崩溃）：该席 error + 注意力；圆桌继续。 */
  private _markSeatError(seatId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const modules = this._modules;
    this.logTeamDebug("seat.error", { seatId, error });
    this._setSeatStatus(seatId, "error", { error: message });
    this._raiseAttention({
      kind: "seat_error",
      seatId,
      text: `席位 ${seatLabel(modules?.roster ?? null, seatId)} 出错（${message}）：其余席位继续讨论，可 wake_seat 或重新加入。`,
    });
    this._persistSoon();
  }

  private async _disposeSeatSession(seatId: string, options: { rememberUsage?: boolean } = {}): Promise<void> {
    const unsubscribe = this._unsubscribeSeats.get(seatId);
    if (unsubscribe !== undefined) {
      unsubscribe();
      this._unsubscribeSeats.delete(seatId);
    }
    this._finishSeatDuration(seatId);
    const session = this._sessions.get(seatId);
    this._sessions.delete(seatId);
    if (session !== undefined) {
      // 先记用量再 dispose（F4-3）：退出席位已产生的消耗要留在成本表上。
      // 升档重建走 continueRecent，同一份 transcript 的用量会回到 live session，不能再累加。
      if (options.rememberUsage !== false) {
        this._rememberSeatUsage(seatId, session);
      }
      await session.dispose({ reason: "quit" }).catch(() => {});
    }
  }

  /** 累计记下该席 session 的用量（同一席多次进场/退场与 `_seatDurations` 同构叠加）。 */
  private _rememberSeatUsage(seatId: string, session: AgentSession): void {
    const stats = statsOf(session);
    const previous = this._seatUsage.get(seatId);
    this._seatUsage.set(seatId, {
      tokens: {
        input: (previous?.tokens.input ?? 0) + stats.tokens.input,
        output: (previous?.tokens.output ?? 0) + stats.tokens.output,
        cacheRead: (previous?.tokens.cacheRead ?? 0) + stats.tokens.cacheRead,
        cacheWrite: (previous?.tokens.cacheWrite ?? 0) + stats.tokens.cacheWrite,
      },
      cost: (previous?.cost ?? 0) + stats.cost,
    });
  }

  private async _teardownSeats(): Promise<void> {
    for (const [seatId, runner] of [...this._runners]) {
      await runner.stop().catch(() => {});
      this._runners.delete(seatId);
    }
    for (const seatId of [...this._sessions.keys()]) {
      await this._disposeSeatSession(seatId);
    }
  }

  /**
   * 把本场的一切收干净（F3-3）：停健康检查与指标定时器、退订三条订阅、dispose
   * 全部席位 session + runner、清掉协议定时器（退出协商的 120s 定时器在整场拆掉
   * 之后不该再触发，F3-4）。换场（initialize / createRoundtable）与 stop / dispose
   * 都走这里，否则 team ↔ solo 往返每次都会泄漏 session 与定时器，旧场的迟到事件
   * 还会写进新场。
   *
   * 故意**不**清 `this._modules`：stop() 之后 `getState()` / `getDeliverables()` /
   * `getAttention()` / `exportMarkdown()` 仍要以只读方式可读（停止后记录保留），
   * 清掉会让 stopped 场变成空视图。换场路径紧接着就会装上新的模块实例。
   */
  private async _teardownModules(): Promise<void> {
    const modules = this._modules;
    if (modules === null) {
      return;
    }
    modules.metrics.stop();
    modules.health.stop();
    modules.protocol.clearAll();
    modules.offGate();
    modules.offInbox();
    modules.offTimelineAppend();
    this._abortAux();
    await this._teardownSeats();
  }

  // ==========================================================================
  // 内部：投递 / 状态 / 事件
  // ==========================================================================

  /** 一条 argument 被有序门放行：投递 + L1 + 清 waiting_turn（H28）。 */
  private _onArgumentReleased(messageId: string): void {
    const modules = this._modules;
    if (modules === null) {
      return;
    }
    const item = modules.timeline.getById(messageId);
    if (item === undefined) {
      return;
    }
    const targets = this._messageTargets(item.toId);
    modules.inbox.enqueue(item, targets);
    this._clearWaitingTurn(item.fromId);
    this._nudge(targets, "L1", "seat", item.fromId);
    this.logTeamDebug("ordered.released", { messageId, fromId: item.fromId, targets });
    this._persistSoon();
  }

  /** 消息目标席：`*` 展开为活跃席；user 没有收件箱。 */
  private _messageTargets(toId: string): string[] {
    const modules = this._modules;
    if (modules === null) {
      return [];
    }
    if (toId === USER_SEAT_ID) {
      return [];
    }
    if (toId === "*") {
      // @ 的席位在收件箱里优先级更高（priority 由 SeatInbox 按 mentionIds 算）。
      return modules.roster.activeIds();
    }
    return [toId];
  }

  /** 打断决策（执行在 SeatRunner；本类只决定"谁被打断"）。 */
  private _nudge(
    targets: string[],
    level: InterruptLevel,
    actor: "user" | "seat" | "system",
    fromSeatId?: string,
    reason?: string,
  ): void {
    const modules = this._modules;
    if (modules === null || this._state?.lifecycle !== "active") {
      // 暂停/停止期间不发起任何团队模型调用（§5.10）。
      return;
    }
    for (const target of targets) {
      if (target === USER_SEAT_ID || !modules.roster.isActive(target)) {
        continue;
      }
      const result = modules.interrupts.request({ targetSeatId: target, level, actor, fromSeatId, reason });
      if (!result.accepted) {
        this.logTeamDebug("interrupt.rejected", { target, level, actor, reason: result.reason });
      }
    }
  }

  /** 席位状态投影 + `seat_status` 事件。 */
  private _setSeatStatus(seatId: string, status: SeatRuntimeStatus, extra: { currentActivity?: string; error?: string } = {}): void {
    const modules = this._modules;
    if (modules === null) {
      return;
    }
    const seat = modules.roster.get(seatId);
    if (seat === undefined || seat.status === "exited") {
      return;
    }
    if (seat.status === status && extra.error === undefined && extra.currentActivity === undefined) {
      return;
    }
    modules.roster.setStatus(seatId, status, extra);
    if (this._state !== null) {
      this._state.seats = modules.roster.snapshot();
    }
    this._emit({ type: "seat_status", seatId, status, activity: extra.currentActivity, error: extra.error });
    this._persistSoon();
  }

  /**
   * 有序模式变化：关掉时按排队键放行等待中的 argument（投递不丢）并清掉所有
   * `waiting_turn`（§5.15）；`RoundtableState.orderedMode` 只是 settings 的投影（H27）。
   */
  private _onOrderedModeChanged(on: boolean): void {
    const modules = this._modules;
    const state = this._state;
    if (modules === null || state === null) {
      return;
    }
    state.orderedMode = on;
    if (on) {
      return;
    }
    modules.gate.reset();
    for (const seat of modules.roster.list()) {
      if (seat.status === "waiting_turn") {
        this._clearWaitingTurn(seat.seatId);
      }
    }
  }

  /** 放行/退出/关有序模式后清掉 waiting_turn（§4.1 / §5.15）。 */
  private _clearWaitingTurn(seatId: string): void {
    const modules = this._modules;
    const seat = modules?.roster.get(seatId);
    if (modules === null || seat === undefined || seat.status !== "waiting_turn") {
      return;
    }
    const streaming = this._sessions.get(seatId)?.isStreaming === true;
    this._setSeatStatus(seatId, streaming ? "speaking" : "idle");
  }

  private _setSeatStatusesForPause(): void {
    const modules = this._modules;
    if (modules === null) {
      return;
    }
    for (const seat of modules.roster.list()) {
      if (seat.status === "waiting_turn" || seat.status === "speaking" || seat.status === "exploring") {
        this._setSeatStatus(seat.seatId, "idle");
      }
    }
  }

  /** 投递态 diff → `delivery_changed`（AC-8：UI 不必轮询）。 */
  private _syncDelivery(seatId: string): void {
    const modules = this._modules;
    if (modules === null) {
      return;
    }
    const previous = this._deliveryStates.get(seatId) ?? new Map<string, DeliveryState>();
    const next = new Map<string, DeliveryState>();
    for (const entry of modules.inbox.snapshot()) {
      if (entry.seatId === seatId) {
        next.set(entry.messageId, entry.state);
      }
    }
    for (const [messageId, state] of next) {
      if (previous.get(messageId) !== state) {
        this._emit({ type: "delivery_changed", messageId, seatId, state });
      }
    }
    this._deliveryStates.set(seatId, next);
  }

  /** 时间线条目投影：IPC 出去的 TimelineItem 必须带 deliveryBySeat（§4.3）。 */
  private _projectItem(item: TimelineItem): TimelineItem {
    const modules = this._modules;
    const deliveryBySeat: Record<string, DeliveryState> = {};
    if (modules !== null) {
      for (const entry of modules.inbox.snapshot()) {
        if (entry.messageId === item.id) {
          deliveryBySeat[entry.seatId] = entry.state;
        }
      }
    }
    return { ...item, deliveryBySeat };
  }

  /**
   * 追加一条 system 时间线记录（开场/公告/系统提示都走这里）。落盘与事件由
   * `timeline.onAppend` 的统一出口负责（F3-2）——jsonl 是「已记录」的唯一长期
   * 载体（§4.10），所以这里不再各自调 persist/emit。
   */
  private _appendSystem(text: string, toId: string): TimelineItem {
    const modules = this._modules!;
    return modules.timeline.append({
      ts: Date.now(),
      type: "system",
      fromId: USER_SEAT_ID,
      toId,
      text,
      summary: firstLine(text),
      mentionIds: toId === "*" || toId === USER_SEAT_ID ? [] : [toId],
    });
  }

  private _appendTimelinePersist(item: TimelineItem): void {
    const modules = this._modules;
    if (modules === null) {
      return;
    }
    void modules.persistence.appendTimeline(item).catch((err) => {
      this._raisePersistFailure("timeline.jsonl", err);
    });
  }

  private _emitTimeline(item: TimelineItem): void {
    this._emit({ type: "timeline_item", item: this._projectItem(item) });
  }

  /** 计时兜底（pause 的 L3 超时）：不拖住进程退出，也不需要外部时钟。 */
  private _sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  private _emit(event: TeamEvent): void {
    for (const callback of [...this._eventCallbacks]) {
      try {
        callback(event);
      } catch (err) {
        console.error("[TeamManager] Event callback error:", err);
      }
    }
  }

  private _emitState(): void {
    const state = this.getState();
    if (state !== null) {
      this._emit({ type: "roundtable_state", state });
    }
  }

  /**
   * 注意力面：真实 AttentionBus + `attention` 事件 + attention.jsonl 落盘（H44）。
   * `action` 必须原样透传（F5-4）：它不在快照本体里，只靠 `attention` 事件与
   * `get_attention` 投影到渲染层，renderer 据此在 ack 之后补发 `resume`。
   */
  private _raiseAttention(item: {
    kind: AttentionItem["kind"];
    text: string;
    seatId?: string;
    refId?: string;
    action?: AttentionItem["action"];
  }): AttentionItem {
    const modules = this._modules;
    if (modules === null) {
      // 建场之前（例如 legacy 提示）没有注意力面：忽略即可。**用户可见的提示不能
      // 指望这条路径**——它只返回一个没人接收的合成条目（F4-7 的损坏提示因此改为
      // 走 `_deferredNotices` + `_flushDeferredNotices()`）。
      return {
        id: "",
        ts: Date.now(),
        kind: item.kind,
        text: item.text,
        seatId: item.seatId,
        refId: item.refId,
        action: item.action,
        acked: false,
      };
    }
    const created = modules.attention.push(item);
    this._emit({ type: "attention", item: created });
    void modules.persistence.appendAttention(created).catch(() => {});
    this._persistSoon();
    return created;
  }

  /**
   * 补发建场之前暂存的注意力（F4-7）。必须在 `roundtable_created` / `roundtable_state`
   * 之后调用：渲染层收到建场事件会清空上一场的投影（`attentionItems`），早于它的
   * `attention` 事件会被那次清空抹掉，用户依旧看不到。
   * 只补发当前工作区的条目：暂存发生在 `initialize` 之后，若期间换过工作区，把别的
   * 工作区的损坏提示显示在这一场里会误导用户。
   */
  private _flushDeferredNotices(): void {
    if (this._modules === null || this._state === null || this._deferredNotices.length === 0) {
      return;
    }
    const physicalCwd = this._physicalCwd;
    const pending = this._deferredNotices.filter((notice) => notice.physicalCwd === physicalCwd);
    if (pending.length === 0) {
      return;
    }
    this._deferredNotices = this._deferredNotices.filter((notice) => notice.physicalCwd !== physicalCwd);
    for (const notice of pending) {
      this._raiseAttention({ kind: "seat_error", text: notice.text });
    }
  }

  /** §5.7：被策略拒绝的写入在时间线上留一条系统提示（模型侧另有工具错误）。 */
  private _onPolicyDenied(info: {
    seatId: string;
    toolName: string;
    reason: string;
    path?: string;
  }): void {
    const modules = this._modules;
    if (modules === null) {
      return;
    }
    this._appendSystem(
      `席位「${seatLabel(modules.roster, info.seatId)}」的写入被拒绝：${info.toolName}${info.path !== undefined ? ` → ${info.path}` : ""}。${info.reason}`,
      info.seatId,
    );
  }

  // ==========================================================================
  // 内部：持久化 / 路径 / 断言
  // ==========================================================================

  private _snapshot(): PersistedRoundtable | null {
    const modules = this._modules;
    const state = this._state;
    if (modules === null || state === null) {
      return null;
    }
    return {
      version: 2,
      roundtableId: state.roundtableId,
      physicalCwd: this._physicalCwd,
      savedAt: Date.now(),
      state: this.getState()!,
      inbox: modules.inbox.snapshot(),
      openItems: modules.openItems.list(),
      leases: modules.leases.list(),
      deliverables: modules.deliverables.list(),
      mutedThreads: [...this._mutedThreads],
      metrics: this.getMetrics(),
      pendingPermissions: modules.protocol.getPendingPermissionRequests(),
      pendingExits: modules.protocol.getPendingExits(),
      // F4-5：attention.jsonl 只在 push 时追加（写入时恒 false），已确认状态只能
      // 走快照本体，否则重启后已处理条目复活（权限卡变成死按钮）。
      attentionAcks: modules.attention
        .list()
        .filter((item) => item.acked)
        .map((item) => item.id),
    };
  }

  /** 增量落盘（合并窗口在 RoundtablePersistence 内，≤200ms）。 */
  private _persistSoon(): void {
    const snapshot = this._snapshot();
    const modules = this._modules;
    if (snapshot === null || modules === null) {
      return;
    }
    void modules.persistence.saveSnapshot(snapshot).catch((err) => {
      this._raisePersistFailure("snapshot", err);
    });
  }

  private _persistNow(): void {
    this._persistSoon();
  }

  /**
   * §5.14：jsonl / 快照写失败（persistence 内部已重试一次）→ 发一条注意力，
   * 内存里已记录的不丢但用户必须知道「这些记录重启后会消失」。同一个写入目标
   * 30 秒内只发一次，否则 200ms 一次的快照刷新会把注意力面刷爆（F3-5）。
   */
  private _raisePersistFailure(what: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[TeamManager] roundtable persist failed (${what}):`, err);
    const now = Date.now();
    if (now - (this._persistFailureAt.get(what) ?? 0) < PERSIST_FAILURE_NOTICE_THROTTLE_MS) {
      return;
    }
    this._persistFailureAt.set(what, now);
    this._raiseAttention({
      kind: "seat_error",
      text: `圆桌记录落盘失败（${what}）：${message}`,
    });
  }

  private async _flush(): Promise<void> {
    await this._modules?.persistence.flush().catch(() => {});
  }

  private async _timelineFileSize(roundtableId: string): Promise<number> {
    try {
      const info = await stat(roundtableFilePath(this._physicalCwd, roundtableId, "timeline.jsonl"));
      return info.size;
    } catch {
      return 0;
    }
  }

  /** 席位 cwd 视图（H34）：logicalCwd + backend.getCwd + backend.paths.resolvePath。 */
  private _seatExecView(): SeatExecutionView {
    const logicalCwd = this._logicalCwd;
    const backend = this._executionBackend;
    return {
      logicalCwd,
      getCwd: () => backend?.getCwd?.() ?? logicalCwd,
      resolvePath: (input) => backend?.paths.resolvePath(input, logicalCwd) ?? localResolvePath(input, logicalCwd),
    };
  }

  /**
   * metrics 的席位口径（F4-3）：**exited 也计入**，避免分子分母 population 不一致——
   * `speakShare` / `evidenceDensity` / `interruptRate` 的分子来自覆盖全时间线的统计，
   * 分母若在这里过滤掉退出席位，移除一席后 `speakShare` 之和就会 >1（`formatShare`
   * 把 3.0 当 3%），退出席位在时间线里的发言仍在但该行显示 0 条。
   * 渲染层对 `status === "exited"` 的行单独标注（G6 的 F6-12）。
   * 退出席位的**消耗也保留**（`_seatUsage`，F4-3）：perSeat / totals 都不会因为减席回退。
   */
  private _metricsSeats(): MetricsSeatRuntime[] {
    const modules = this._modules;
    if (modules === null) {
      return [];
    }
    return modules.roster.all().map((seat) => ({
      seatId: seat.seatId,
      getSessionStats: () => {
        const session = this._sessions.get(seat.seatId);
        if (session !== undefined) {
          return session.getSessionStats();
        }
        // 退出席位（session 已 dispose）：返回退场那一刻记下的用量，不能归零——
        // 否则 perSeat 显示「有时长、没成本」的混合行，totals.cost 还会随减席回退（F4-3）。
        const remembered = this._seatUsage.get(seat.seatId);
        if (remembered !== undefined) {
          return remembered;
        }
        return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
      },
      durationMs: () => this._seatDurationMs(seat.seatId),
    }));
  }

  private _seatDurationMs(seatId: string): number {
    const duration = this._seatDurations.get(seatId);
    if (duration === undefined) {
      return 0;
    }
    return duration.total + (duration.startedAt === null ? 0 : Date.now() - duration.startedAt);
  }

  /** 辅助 session 用量（运行中的 aux + 已结束的累计）。 */
  private _auxStats(): MetricsSessionStats | null {
    const aux = this._aux;
    const base = this._auxUsage;
    const live = aux === null ? null : statsOf(aux.session);
    if (aux === null && base.tokensIn === 0 && base.tokensOut === 0 && base.cost === 0) {
      return null;
    }
    return {
      tokens: {
        input: base.tokensIn + (live?.tokens.input ?? 0),
        output: base.tokensOut + (live?.tokens.output ?? 0),
        cacheRead: live?.tokens.cacheRead ?? 0,
        cacheWrite: live?.tokens.cacheWrite ?? 0,
      },
      cost: base.cost + (live?.cost ?? 0),
    };
  }

  private _assertReady(): void {
    if (this._physicalCwd.length === 0) {
      throw new Error("TeamManager not initialized. Start a project session first.");
    }
  }

  /** 允许 active / paused（记录不产生模型调用；暂停由容量池挡住）。 */
  private _assertCanRecord(operation: string): void {
    this._assertReady();
    const lifecycle = this._state?.lifecycle;
    if (lifecycle === undefined || lifecycle === "stopped" || lifecycle === "inactive") {
      throw new Error(`当前没有活跃圆桌；${operation} 需要先 createRoundtable。`);
    }
  }

  private _assertActive(operation: string): void {
    this._assertCanRecord(operation);
    if (this._state?.lifecycle !== "active") {
      throw new Error(`圆桌已暂停；${operation} 需要先 resume。`);
    }
  }
}

// ============================================================================
// 模块级工具函数
// ============================================================================

/** 席位 tools 白名单（H35）：只读四工具 + 席位工具；write 档再加 edit/write。 */
export function seatToolAllowlist(auth: ToolAuthTier): string[] {
  const tools = ["read", "grep", "find", "ls", ...SEAT_TOOL_NAMES];
  if (auth === "write") {
    tools.push("edit", "write");
  }
  return tools;
}

/** `provider/id` 或裸 id 解析成模型对象（找不到返回 undefined，绝不抛）。 */
function resolveModelSpec(
  session: AgentSession,
  spec: string,
): NonNullable<AgentSession["model"]> | undefined {
  const slash = spec.indexOf("/");
  if (slash > 0) {
    return session.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
  }
  return session.modelRegistry.getAvailable().find((candidate) => candidate.id === spec);
}

function statsOf(session: AgentSession): MetricsSessionStats {
  try {
    const stats = session.getSessionStats();
    return {
      tokens: {
        input: stats.tokens.input,
        output: stats.tokens.output,
        cacheRead: stats.tokens.cacheRead,
        cacheWrite: stats.tokens.cacheWrite,
      },
      cost: stats.cost,
    };
  } catch {
    return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
  }
}

function emptyMetrics(): RoundtableMetricsSnapshot {
  return {
    perSeat: {},
    totals: { utterances: 0, tokens: 0, cost: 0, durationMs: 0 },
    health: { speakShare: {}, evidenceDensity: 0, interruptRate: 0 },
  };
}

/** 落盘基线 + 当前用量（崩溃前的累计成本不丢）。 */
function mergeMetrics(
  base: RoundtableMetricsSnapshot | null,
  live: RoundtableMetricsSnapshot,
): RoundtableMetricsSnapshot {
  if (base === null) {
    return live;
  }
  const perSeat: RoundtableMetricsSnapshot["perSeat"] = {};
  const seatIds = new Set([...Object.keys(base.perSeat), ...Object.keys(live.perSeat)]);
  let tokens = 0;
  let cost = 0;
  let durationMs = 0;
  let utterances = 0;
  for (const seatId of seatIds) {
    const before = base.perSeat[seatId] ?? { utterances: 0, tokensIn: 0, tokensOut: 0, cost: 0, durationMs: 0 };
    const after = live.perSeat[seatId] ?? { utterances: 0, tokensIn: 0, tokensOut: 0, cost: 0, durationMs: 0 };
    const merged = {
      // 发言数来自时间线 replay，本身已是累计值。
      utterances: Math.max(before.utterances, after.utterances),
      tokensIn: before.tokensIn + after.tokensIn,
      tokensOut: before.tokensOut + after.tokensOut,
      cost: before.cost + after.cost,
      durationMs: before.durationMs + after.durationMs,
    };
    perSeat[seatId] = merged;
    tokens += merged.tokensIn + merged.tokensOut;
    cost += merged.cost;
    durationMs += merged.durationMs;
    utterances += merged.utterances;
  }
  // 席位槽之外的用量（辅助整理 session）只出现在 totals 里：按差值保留。
  const baseAux = outsideSeatTotals(base);
  const liveAux = outsideSeatTotals(live);
  return {
    perSeat,
    totals: {
      utterances,
      tokens: tokens + baseAux.tokens + liveAux.tokens,
      cost: cost + baseAux.cost + liveAux.cost,
      durationMs: durationMs + baseAux.durationMs + liveAux.durationMs,
    },
    health: live.health,
  };
}

/** totals 里不属于任何席位的部分（aux session 用量）。 */
function outsideSeatTotals(snapshot: RoundtableMetricsSnapshot): { tokens: number; cost: number; durationMs: number } {
  let seatTokens = 0;
  let seatCost = 0;
  let seatDuration = 0;
  for (const seat of Object.values(snapshot.perSeat)) {
    seatTokens += seat.tokensIn + seat.tokensOut;
    seatCost += seat.cost;
    seatDuration += seat.durationMs;
  }
  return {
    tokens: Math.max(0, snapshot.totals.tokens - seatTokens),
    cost: Math.max(0, snapshot.totals.cost - seatCost),
    durationMs: Math.max(0, snapshot.totals.durationMs - seatDuration),
  };
}

/** 席位展示名（找不到就退回 id）。 */
function seatLabel(roster: RoundtableRoster | null, seatId: string): string {
  return roster?.get(seatId)?.name ?? seatId;
}

/**
 * 抛材料的附件行（F3-8 / FR-9）：进注入正文的一行一条，模型据此用 read 打开。
 * 时间线条目本身仍保留 `attachments` 字段，不改时间线形状。
 */
function attachmentLines(attachments: ChatMessageAttachment[]): string[] {
  return attachments.map((attachment) => {
    const label = attachment.name.length > 0 ? attachment.name : attachment.path;
    return `[附件] ${label}（${attachment.path.length > 0 ? attachment.path : attachment.kind}）`;
  });
}

/** 开场简报：议题 + 本席视角 + 空时间线（§5.1 步骤 4，各席起点相同但不共享历史）。 */
function buildOpeningBrief(openingText: string, seat: SeatInfo): string {
  return [
    openingText,
    "",
    `你是本场席位「${seat.name}」，视角：${seat.perspective}。`,
    "讨论刚开始，时间线里还没有别人的发言：请直接从你的视角出发说第一轮判断，用 send_team_message 公开发言。",
  ].join("\n");
}

/** 新席入场简报：摘要 + 知识卡/关键结论索引，不重放全文（AC-14）。 */
function buildJoinBrief(seat: SeatInfo, packet: { summary: string; index: Array<{ id: string; title: string }> }): string {
  return [
    `席位「${seat.name}」入场（视角：${seat.perspective}）。`,
    "",
    "主线摘要：",
    packet.summary,
    "",
    "知识卡 / 关键结论索引（需要细节时用 read 或直接问相关席位，不必重读全部记录）：",
    ...(packet.index.length > 0 ? packet.index.map((entry) => `- ${entry.id}: ${entry.title}`) : ["- （暂时没有）"]),
    "",
    "接着讨论：用 send_team_message 公开发言；对齐结论前先看上面的索引。",
  ].join("\n");
}

/** 指定席主笔的写作请求（L1 注入，§4.12c 第 3 步）。 */
function buildSeatWrapUpRequest(deliverable: DeliverableVersion, seatName: string): string {
  return [
    `请你作为主笔整理一版交付物（席位「${seatName}」）。`,
    "",
    `- 交付物 id: ${deliverable.id}`,
    `- 版本: v${deliverable.version}`,
    `- revision（CAS 令牌，revise_deliverable 必须带上）: ${deliverable.revision}`,
    `- 截止点 cutoffSeq: ${deliverable.cutoffSeq}（只整理这条之前的内容，之后的新发现留给下一版）`,
    "",
    "请把这个版本的完整 Markdown 用 revise_deliverable 写回（id 用上面的 id）。必须包含这些小节：",
    "## 结论与建议（带置信度）",
    "## 依据入口（时间线 id / 知识卡 id；追溯不到就标「未验证」，禁止伪造来源）",
    "## 分歧与未决",
    "## 后续动作",
    "## 过程索引（关键转折）",
  ].join("\n");
}

/** 系统整理的 prompt：截止点之前的时间线摘要 + 知识卡索引（§4.12c）。 */
function buildWrapUpDigest(modules: RoundtableModules, deliverable: DeliverableVersion): string {
  const packet = modules.timeline.buildJoinPacket();
  const deliverables = modules.deliverables.list();
  return [
    "你是一轮圆桌讨论的整理者（不是讨论参与者，不要发起新的讨论）。",
    "",
    `整理范围：截止 seq=${deliverable.cutoffSeq} 之前的记录，版本 v${deliverable.version}。`,
    "",
    "讨论摘要：",
    packet.summary,
    "",
    "知识卡 / 关键结论索引：",
    ...(packet.index.length > 0 ? packet.index.map((entry) => `- ${entry.id}: ${entry.title}`) : ["- （无）"]),
    "",
    "已整理过的版本：",
    ...(deliverables.length > 0 ? deliverables.map((item) => `- v${item.version}（${item.author}）`) : ["- （无）"]),
    "",
    "请只输出 Markdown 正文，必须包含这些小节：",
    "## 结论与建议（每条带置信度）",
    "## 依据入口（时间线 id / 知识卡 id；追溯不到的条目标「未验证」，禁止伪造来源）",
    "## 分歧与未决",
    "## 后续动作",
    "## 过程索引",
  ].join("\n");
}

function firstLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`;
}

/** 预设读取（文件缺失/损坏都返回空数组；不因预设文件坏了打不开圆桌）。 */
async function readPresets(): Promise<RoundtablePreset[]> {
  try {
    const raw = await readFile(roundtablePresetsPath(), "utf-8");
    const parsed = JSON.parse(raw) as { presets?: unknown } | unknown[];
    const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.presets) ? parsed.presets : [];
    return entries
      .filter((entry): entry is RoundtablePreset =>
        typeof entry === "object" && entry !== null &&
        typeof (entry as RoundtablePreset).name === "string" &&
        Array.isArray((entry as RoundtablePreset).seats))
      .map((entry) => ({ name: entry.name, seats: entry.seats.map((seat) => ({ ...seat })) }));
  } catch {
    return [];
  }
}

/** 预设写入（原子写：临时文件 + rename）。 */
async function writePresets(presets: RoundtablePreset[]): Promise<void> {
  const path = roundtablePresetsPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify({ version: 1, presets }, null, 2), "utf-8");
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * 无 backend 时的路径解析（H31 允许的回退）：与 coding-agent
 * `resolvePath(input, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true })`
 * 同语义。有 backend（WSL）时永远走 `backend.paths.resolvePath`。
 *
 * F3-9 / S5：工具侧的 `resolvePath` 走 `normalizePath`，其中 `/^file:\/\//` 会经
 * `fileURLToPath` 变成平台路径。这里少了这一步，策略层与执行层的 pathKey 就是两个
 * 不同字符串（`file:///C:/...` vs `C:\...`），受限档白名单与写租约都能被 `file:///`
 * 前缀绕过。分支顺序照抄 `packages/coding-agent/src/utils/paths.ts`：unicode 空格
 * → 去 `@` 前缀 → `~` 展开 → `file://` → 绝对/相对 resolve。禁止异步解析与
 * `realpath`（H31）。
 */
function localResolvePath(input: string, cwd: string): string {
  const normalized = input
    .replace(/[  -   　]/g, " ")
    .replace(/^@/, "");
  const home = homedir();
  if (normalized === "~") {
    return home;
  }
  if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
    return join(home, normalized.slice(2));
  }
  const target = /^file:\/\//.test(normalized) ? fileURLToPath(normalized) : normalized;
  return isAbsolute(target) ? resolvePathNode(target) : resolvePathNode(cwd, target);
}

