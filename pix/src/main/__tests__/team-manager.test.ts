/**
 * TeamManager facade 测试（S4，plan §4.12 / §4.12b / §4.12c，§5.1–§5.15）。
 *
 * 覆盖验收点：
 *   - 默认标准档 5 席、5 个互异 seatId、每席有颜色（附录 A / H25）
 *   - 开场系统消息带议题与附件名；hardStop 开启时必须在开场告知（AC-11）
 *   - 两席可同时 running（自由并行，没有串行门，FR-6）
 *   - pause 不发任何模型调用、但保留 pending 权限与未 commit 的收件箱条目（AC-10 / H23）
 *   - 重启恢复：名册 / 未决项 / 交付物回来，默认暂停，已 injected 不再变 pending（AC-12）
 *   - 增减席：重名抛错；被移除席的未决项回到 open（AC-14）
 *   - 有序模式：argument 已记录 + 报告 queued + 席位 waiting_turn + 放行后投递（H28）
 *   - 私密消息：时间线正文为空 + privateStub，正文只在 InboxEntry.text（H36 / AC-20）
 *   - 移交 payload 带交付物版本（AC-19）
 *   - 席位 createAgentSession 入参：runtimeCwd=logical、enhancement 关、tools 含只读四工具
 *   - WSL：席位与 host 共用同一个 executionBackend 对象、exec.getCwd()=logical、hash=physical
 *   - metrics 把 H20 的 getMinIdleMs 接进 SeatRunner（H43）
 *   - H44 注意力面每个 kind 都有生产者
 *
 * Run with: npx tsx pix/src/main/__tests__/team-manager.test.ts
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix as pathPosix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AuthStorage,
  createAgentSession,
  getAgentDir,
  type AgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ExecutionBackend,
} from "@earendil-works/pi-coding-agent";
import {
  USER_SEAT_ID,
  type AttentionItem,
  type ExitRequest,
  type InboxEntry,
  type RoundtableSettings,
  type RoundtableState,
  type TeamEvent,
  type TimelineItem,
} from "../../shared/team-types.js";
import type { AgentSessionEvent } from "../../shared/types.js";
import { TeamManager } from "../team-manager.js";
import type { ProjectExecutionContext } from "../execution-context.js";
import { archiveNotice } from "../team/export.js";
import { buildPlanHandoffRequest, buildSoloHandoffPrompt } from "../team/handoff.js";
import { RoundtableHealth } from "../team/health.js";
import { RoundtableMetrics } from "../team/metrics.js";
import { registerSeatTools } from "../team/seat-tools.js";
import type { SeatExecutionView, SeatHealthProbe } from "../team/seat-runner.js";
import {
  DEFAULT_L2_BUDGET,
  EXIT_REQUEST_TIMEOUT_MS,
  MAX_PENDING_PERMISSIONS_PER_SEAT,
  ORDERED_RELEASE_MS,
  STUCK_MS,
  roundtableFilePath,
} from "../team/constants.js";

// ============================================================================
// Harness（与 team-ids / team-inbox / team-seat-runner 同一风格）
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(haystack: string, needle: string, message: string): void {
  assert(haystack.includes(needle), message);
}

async function assertRejects(fn: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await fn();
    failed++;
    console.error(`  FAIL: ${message} - expected throw`);
  } catch {
    passed++;
    console.log(`  PASS: ${message}`);
  }
}

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${name} ===\n`);
  try {
    await fn();
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name} threw unexpectedly: ${String(err)}`);
  }
}

/** 让独立 promise 链（runner 串行链、facade 的 fire-and-forget）跑完。 */
async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** 工具 execute 的 extension context 占位（与 team-seat-runner.test.ts 同写法）。 */
const NO_EXTENSION_CONTEXT = {} as never;

// ============================================================================
// 隔离：agent 目录 + 工作区
// ============================================================================

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pix-team-manager-agent-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const WORKSPACES: string[] = [];

function makeWorkspace(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pix-team-manager-${name}-`));
  WORKSPACES.push(dir);
  return dir;
}

function sha1Hex(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

// ============================================================================
// Fake session（无 runtimeCwd 字段：H34 的会话面根本没有它）
// ============================================================================

interface FakeAgentState {
  isStreaming: boolean;
  model?: { id: string; provider: string; contextWindow: number };
  streamingMessage?: { content: Array<{ type: string; text?: string }> };
  pendingToolCalls: ReadonlySet<string>;
}

interface FakeSession {
  session: AgentSession;
  prompts: string[];
  calls: string[];
  state: FakeAgentState;
  emit(event: AgentSessionEvent): void;
}

/**
 * 席位 fake：prompt 立刻 resolve（好让 commitInjected 发生），但 `isStreaming`
 * 保持 true —— 模拟"这个 run 一直在跑"。于是新消息只会留在 pending（投递三态
 * 的中间态），这正是 pause / 私密 / 有序模式测试需要的场景。
 */
function createSeatFake(): FakeSession {
  const prompts: string[] = [];
  const calls: string[] = [];
  const subscribers = new Set<(event: AgentSessionEvent) => void>();
  const state: FakeAgentState = {
    isStreaming: false,
    model: { id: "fake-model", provider: "fake", contextWindow: 200_000 },
    streamingMessage: undefined,
    pendingToolCalls: new Set<string>(),
  };
  const session = {
    prompt: async (text: string): Promise<void> => {
      calls.push("prompt");
      prompts.push(text);
      state.isStreaming = true;
      for (const subscriber of [...subscribers]) {
        subscriber({ type: "agent_start" });
      }
    },
    abort: async (): Promise<void> => {
      calls.push("abort");
      state.isStreaming = false;
      for (const subscriber of [...subscribers]) {
        subscriber({ type: "agent_end", messages: [] });
      }
    },
    abortCompaction: (): void => {
      calls.push("abortCompaction");
    },
    clearQueue: (): { steering: string[]; followUp: string[] } => {
      calls.push("clearQueue");
      return { steering: [], followUp: [] };
    },
    sendCustomMessage: async (): Promise<unknown> => {
      calls.push("sendCustomMessage");
      return undefined;
    },
    subscribe: (fn: (event: AgentSessionEvent) => void): (() => void) => {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    getSessionStats: () => ({
      tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
      cost: 0.01,
    }),
    model: { id: "fake-model", provider: "fake", contextWindow: 200_000 },
    modelRegistry: { find: () => undefined, getAvailable: () => [] },
    sessionManager: { appendModelChange: () => "model-change" },
    dispose: async (): Promise<void> => {
      calls.push("dispose");
    },
    getLastAssistantText: (): string | undefined => undefined,
    agent: {
      steeringMode: "one-at-a-time",
      waitForIdle: async (): Promise<void> => undefined,
      state,
    },
  };
  return {
    session: session as unknown as AgentSession,
    prompts,
    calls,
    state,
    emit: (event) => {
      for (const subscriber of [...subscribers]) {
        subscriber(event);
      }
    },
  };
}

/**
 * 整理用 aux fake：prompt 立刻给出正文（模拟一次短命整理调用）。
 * 与席位 fake 同口径记录 `calls`（T-4）：pause 的「零模型调用」断言必须把
 * 整理会话算进去，否则 aux 偷跑一次 prompt 也看不出来。
 */
function createAuxFake(markdown: string): FakeSession {
  const prompts: string[] = [];
  const calls: string[] = [];
  const state: FakeAgentState = {
    isStreaming: false,
    model: { id: "fake-model", provider: "fake", contextWindow: 200_000 },
    streamingMessage: undefined,
    pendingToolCalls: new Set<string>(),
  };
  const session = {
    prompt: async (text: string): Promise<void> => {
      calls.push("prompt");
      prompts.push(text);
      state.isStreaming = true;
    },
    abort: async (): Promise<void> => {
      calls.push("abort");
      state.isStreaming = false;
    },
    abortCompaction: (): void => {
      calls.push("abortCompaction");
    },
    clearQueue: () => {
      calls.push("clearQueue");
      return { steering: [], followUp: [] };
    },
    sendCustomMessage: async (): Promise<unknown> => {
      calls.push("sendCustomMessage");
      return undefined;
    },
    subscribe: () => () => undefined,
    getSessionStats: () => ({
      tokens: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0 },
      cost: 0.002,
    }),
    model: { id: "fake-model", provider: "fake", contextWindow: 200_000 },
    modelRegistry: { find: () => undefined, getAvailable: () => [] },
    sessionManager: { appendModelChange: () => "model-change" },
    dispose: async (): Promise<void> => undefined,
    getLastAssistantText: (): string | undefined => markdown,
    agent: {
      steeringMode: "one-at-a-time",
      waitForIdle: async (): Promise<void> => undefined,
      state,
    },
  };
  return {
    session: session as unknown as AgentSession,
    prompts,
    calls,
    state,
    // aux session 不上报事件（`subscribe` 是 no-op），emit 只需存在。
    emit: (): void => undefined,
  };
}

const AUX_MARKDOWN = [
  "## 结论与建议",
  "采用方案 A（置信度：中）。",
  "## 依据入口",
  "- 时间线 #3：反例席给出的边界条件",
  "## 分歧与未决",
  "- 理论席认为需要更多实验",
  "## 后续动作",
  "- 做一次对照实验",
  "## 过程索引",
  "- 转折点：#3",
].join("\n");

// ============================================================================
// Manager fixture
// ============================================================================

/** 测试用的私有面（与旧 team-manager.test.ts 的 TeamManagerTestAccess 同思路）。 */
interface TeamManagerTestAccess {
  _physicalCwd: string;
  _logicalCwd: string;
  _executionBackend: ExecutionBackend | null;
  _isWsl: boolean;
  _state: RoundtableState | null;
  _seatExecView(): SeatExecutionView;
  _runners: Map<string, unknown>;
  _sessions: Map<string, unknown>;
  _modules: {
    attention: { list(unackedOnly?: boolean): AttentionItem[] };
    health: unknown;
    metrics: RoundtableMetrics;
    protocol: {
      getPendingPermissionRequests(): Array<{ id: string }>;
      countPendingPermissions(seatId: string): number;
    };
    roster: { activeIds(): string[] };
    persistence: {
      appendTimeline(item: TimelineItem): Promise<void>;
      saveSnapshot(snapshot: unknown): Promise<void>;
    };
  } | null;
  _onSeatEvent(seatId: string, event: AgentSessionEvent): void;
  _applyExit(request: ExitRequest, requestedBy: "self" | "peer"): Promise<void>;
}

interface ManagerFixture {
  manager: TeamManager;
  workspace: string;
  captured: CreateAgentSessionOptions[];
  seats: FakeSession[];
  /** 整理/摘要 aux session 的 fake（T-4：`modelCalls` 与 pause 断言都要看得见它们）。 */
  auxes: FakeSession[];
}

function buildWindowsContext(physicalCwd: string): ProjectExecutionContext {
  return {
    location: { path: physicalCwd, physicalPath: physicalCwd, name: "win", environment: { kind: "windows" } },
    logicalCwd: physicalCwd,
    physicalCwd,
    isWsl: false,
  };
}

function buildWslContext(physicalCwd: string, backend: ExecutionBackend): ProjectExecutionContext {
  return {
    location: {
      path: "/home/u/repo",
      physicalPath: physicalCwd,
      name: "repo",
      environment: { kind: "wsl", distro: "Ubuntu-22.04" },
    },
    logicalCwd: "/home/u/repo",
    physicalCwd,
    executionBackend: backend,
    runtimeEnvironmentOverride: { platform: "linux", osName: "WSL2 (Ubuntu-22.04)" },
    isWsl: true,
  };
}

/**
 * 建一个 manager + 一个临时工作区。会话工厂按"有无 customTools"区分席位与 aux：
 * 席位拿到会记录 prompt 的 fake，aux 拿到会立刻产出整理正文的 fake。
 */
async function makeFixture(
  name: string,
  options: { context?: ProjectExecutionContext; failOnSeatIndex?: number } = {},
): Promise<ManagerFixture> {
  const workspace = makeWorkspace(name);
  const context = options.context ?? buildWindowsContext(workspace);
  const captured: CreateAgentSessionOptions[] = [];
  const seats: FakeSession[] = [];
  const auxes: FakeSession[] = [];
  const factory = async (sessionOptions: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
    captured.push(sessionOptions);
    const isAux = (sessionOptions.customTools ?? []).length === 0;
    if (isAux) {
      const aux = createAuxFake(AUX_MARKDOWN);
      auxes.push(aux);
      return { session: aux.session } as unknown as CreateAgentSessionResult;
    }
    if (options.failOnSeatIndex !== undefined && seats.length === options.failOnSeatIndex) {
      seats.push(createSeatFake());
      throw new Error("session create failed (test)");
    }
    const fake = createSeatFake();
    seats.push(fake);
    return { session: fake.session } as unknown as CreateAgentSessionResult;
  };
  const manager = new TeamManager({ sessionFactory: factory as typeof createAgentSession });
  await manager.initialize(context, AuthStorage.inMemory());
  return { manager, workspace, captured, seats, auxes };
}

function access(manager: TeamManager): TeamManagerTestAccess {
  return manager as unknown as TeamManagerTestAccess;
}

/** 落盘实例（测试用来把合并窗口里的快照 flush 到磁盘）。 */
function persistenceOf(manager: TeamManager): { flush(): Promise<void> } {
  return (manager as unknown as { _modules: { persistence: { flush(): Promise<void> } } })._modules.persistence;
}

/** 事件收集器。 */
function collectEvents(manager: TeamManager): Array<{ type: string }> {
  const events: Array<{ type: string }> = [];
  manager.onEvent((event) => {
    events.push(event);
  });
  return events;
}

function seatIds(state: RoundtableState): string[] {
  return Object.keys(state.seats);
}

/** 未退出席位（state.seats 保留已退出席位的记录）。 */
function activeSeatIds(state: RoundtableState): string[] {
  return Object.values(state.seats).filter((seat) => seat.status !== "exited").map((seat) => seat.seatId);
}

/** 席位与 aux（整理/摘要）fake 上的模型层调用总数（prompt + steer）。 */
function modelCalls(fixture: ManagerFixture): number {
  return [...fixture.seats, ...fixture.auxes].reduce(
    (sum, fake) => sum + fake.calls.filter((call) => call === "prompt" || call === "sendCustomMessage").length,
    0,
  );
}

function timelineOf(manager: TeamManager): TimelineItem[] {
  return manager.getTimeline();
}

function inboxEntry(manager: TeamManager, seatId: string, messageId: string): InboxEntry | undefined {
  return manager.getInbox(seatId).find((entry) => entry.messageId === messageId);
}

// ============================================================================
// 1. 默认标准圆桌
// ============================================================================

await run("createRoundtable：默认标准档 5 席、互异 seatId、颜色、开场消息与首轮 prompt", async () => {
  const fixture = await makeFixture("standard");
  const { manager } = fixture;
  const events = collectEvents(manager);
  const state = await manager.createRoundtable({
    topic: "评估把检索层换成向量索引",
    attachments: [{ path: "bench.md", name: "bench.md", kind: "file" }],
  });
  await settle();

  assertEqual(seatIds(state).length, 5, "默认标准档有 5 个席位");
  const ids = seatIds(state);
  assertEqual(new Set(ids).size, 5, "5 个 seatId 互不相同");
  const seats = Object.values(state.seats);
  assert(seats.every((seat) => seat.seatId.includes("::") && seat.seatId.endsWith(state.roundtableId)), "seatId = slug::roundtableId");
  assert(state.roundtableId.startsWith("rt-"), "roundtableId 由 create 生成（H26）");
  assert(seats.every((seat) => typeof seat.color === "string" && seat.color.length > 0), "每个席位都有颜色");
  assertEqual(new Set(seats.map((seat) => seat.color)).size, 5, "5 个席位颜色互不相同");
  assert(seats.every((seat) => seat.auth === "read_only"), "默认授权是只读");
  assertEqual(new Set(seats.map((seat) => seat.slug)).size, 5, "slug 互不相同");
  assertEqual(state.lifecycle, "active", "新建后 lifecycle = active");
  assertEqual(manager.hasActiveTeam(), true, "hasActiveTeam() 为真");
  assertEqual(manager.isRuntimeActive(), true, "isRuntimeActive() 为真");
  assert(events.some((event) => event.type === "roundtable_created"), "发出 roundtable_created");

  const opening = timelineOf(manager).find((item) => item.type === "system" && item.toId === "*");
  assert(opening !== undefined, "开场系统消息已写入时间线");
  assertIncludes(opening?.text ?? "", "评估把检索层换成向量索引", "开场消息带议题");
  assertIncludes(opening?.text ?? "", "bench.md", "开场消息带附件名");

  // 每席第一轮 prompt：议题 + 本席视角（视角在系统提示与开场简报里各有一份）。
  const prompted = fixture.seats.filter((fake) => fake.prompts.length >= 1);
  assertEqual(prompted.length, 5, "5 个席位都拿到了第一轮 prompt");
  const allPrompts = fixture.seats.flatMap((fake) => fake.prompts).join("\n");
  for (const label of ["资料", "反例", "理论", "可行性", "实验"]) {
    assertIncludes(allPrompts, label, `第一轮 prompt 覆盖席位视角：${label}`);
  }
  assertIncludes(allPrompts, "评估把检索层换成向量索引", "第一轮 prompt 带议题");

  // 自由并行：两席同时处于 speaking（没有串行门）。
  const speaking = Object.values(manager.getState()!.seats).filter((seat) => seat.status === "speaking");
  assert(speaking.length >= 2, `至少两席同时 running（实际 ${speaking.length}）`);

  await manager.dispose();
});

// ============================================================================
// 2. hardStop 开场告知（AC-11）
// ============================================================================

await run("createRoundtable：hardStop 开启时开场消息必须预告", async () => {
  const fixture = await makeFixture("hardstop");
  const { manager } = fixture;
  await manager.createRoundtable({
    topic: "硬停止预告",
    settings: { hardStop: { enabled: true, maxCostUsd: 5, allowWrapUpOnStop: true } },
  });
  await settle();
  const opening = timelineOf(manager).find((item) => item.type === "system" && item.toId === "*");
  assertIncludes(opening?.text ?? "", "硬停止已开启", "开场消息预告硬停止");
  assertIncludes(opening?.text ?? "", "已授权「停止讨论并整理」", "开场消息说明是否授权停止后整理");
  await manager.dispose();
});

// ============================================================================
// 2b. 档位默认席（附录 A / H25）：compact = 模板前三个；deep = 模板 + 占位席
// ============================================================================

await run("档位：compact 取模板前三个；deep 的占位席 slug 走 allocateSeatSlug", async () => {
  const compact = await makeFixture("tier-compact");
  const compactState = await compact.manager.createRoundtable({ topic: "精简档", tier: "compact" });
  await settle();
  assertEqual(seatIds(compactState).length, 3, "compact = 3 席");
  assertEqual(
    Object.values(compactState.seats).map((seat) => seat.slug).join(","),
    "sources,counterexample,theory",
    "compact 取模板前三个（默认席 slug = 模板 id）",
  );
  assertEqual(
    new Set(Object.values(compactState.seats).map((seat) => seat.color)).size,
    3,
    "颜色确定性分配且互不相同",
  );
  await compact.manager.dispose();

  const deep = await makeFixture("tier-deep");
  const deepState = await deep.manager.createRoundtable({ topic: "深度档", tier: "deep" });
  await settle();
  const deepSeats = Object.values(deepState.seats);
  assertEqual(deepSeats.length, 8, "deep = 8 席");
  const slugs = deepSeats.map((seat) => seat.slug);
  assertEqual(new Set(slugs).size, 8, "8 个 slug 互不相同");
  assertEqual(slugs.slice(0, 5).join(","), "sources,counterexample,theory,feasibility,experiment", "前五席取模板");
  assertEqual(slugs.slice(5).join(","), "1,2,3", "占位席「视角 N」→ slug N（H25：不得喂中文给 sanitizeAgentName）");
  assert(deepSeats.slice(5).every((seat) => seat.seatId === `${seat.slug}::${deepState.roundtableId}`), "占位席 seatId = slug::roundtableId");
  await deep.manager.dispose();
});

// ============================================================================
// 3. pause：无模型调用、权限不丢、未 commit 的收件箱不丢
// ============================================================================

await run("pause：停一切团队模型调用，保留 pending 权限与未 commit 的收件箱", async () => {
  const fixture = await makeFixture("pause");
  const { manager } = fixture;
  await manager.createRoundtable({ topic: "暂停测试" });
  await settle();
  const state = manager.getState()!;
  const [seatA] = seatIds(state);

  const permission = manager.requestPermission(seatA!, "edit", { path: "src/a.ts" }, "需要改动验证");
  assertEqual(permission.submitted, true, "request_permission 立即返回 submitted（H23）");
  assertEqual(
    access(manager)._modules?.protocol.getPendingPermissionRequests().length,
    1,
    "权限请求记录在待批列表",
  );

  // 席位正在跑（isStreaming=true）且用户选 L0（只记录不插话）：
  // 消息只进待注入，既不 steer 也不 prompt，因此不会被 commit。
  const userMessage = await manager.postUserMessage({ to: seatA!, text: "先别急着下结论", interrupt: "L0" });
  const pendingEntry = inboxEntry(manager, seatA!, userMessage.id);
  assertEqual(pendingEntry?.state, "pending_inject", "用户消息进入待注入（未 commit）");
  const callsBefore = modelCalls(fixture);

  await manager.pause();
  await settle();
  assertEqual(modelCalls(fixture), callsBefore, "pause 之后没有任何新的模型调用（prompt / steer / 整理）");
  assertEqual(manager.getState()!.lifecycle, "paused", "lifecycle = paused");
  // T-4：§5.10「压缩也停」此前全仓零断言。每个在册席位的 session 都要被取消压缩，
  // 否则暂停期间后台压缩仍在烧 token（AC-10）。
  const compactionAborts = fixture.seats.filter((fake) => fake.calls.includes("abortCompaction")).length;
  assertEqual(fixture.seats.length, 5, "前提：暂停时 5 个席位都有会话");
  assertEqual(compactionAborts, fixture.seats.length, "pause 对每个席位会话调 abortCompaction（AC-10）");
  assertEqual(manager.isRuntimeActive(), false, "暂停后 isRuntimeActive() 为假");
  assertEqual(manager.hasActiveTeam(), true, "暂停仍算有活跃场（可恢复）");

  // 未 commit 的收件箱条目必须原样留着（H23）。
  const afterPause = inboxEntry(manager, seatA!, userMessage.id);
  assertEqual(afterPause?.state, "pending_inject", "暂停不丢未 commit 的收件箱条目");
  assertEqual(afterPause?.text, "先别急着下结论", "暂停保留条目正文");

  // 守卫不止 runner 的停调度：唤醒一个已暂停的席位也拿不到席位槽（§4.8 / §5.10）。
  const callsBeforeWake = modelCalls(fixture);
  await manager.wakeSeat(seatA!);
  await settle();
  assertEqual(modelCalls(fixture), callsBeforeWake, "暂停期间 wakeSeat 也拿不到席位槽（零模型调用）");
  assertEqual(inboxEntry(manager, seatA!, userMessage.id)?.state, "pending_inject", "唤醒不把未 commit 的条目变成已注入");

  // 权限不丢：暂停后仍能批，并且结果写回该席收件箱（L1）。
  manager.respondPermission(permission.requestId, true, "同意");
  const permissionEcho = manager.getInbox(seatA!).find((entry) => entry.text.includes("权限已批准"));
  assert(permissionEcho !== undefined, "暂停后权限仍可批准，结果写回该席收件箱");
  assertEqual(manager.getAttention().filter((item) => item.kind === "permission").length, 1, "权限进入注意力面");

  // 恢复后继续（不新开一场）。
  manager.resume("test");
  await settle();
  assertEqual(manager.getState()!.lifecycle, "active", "resume 回到 active");
  assertEqual(manager.getState()!.roundtableId, state.roundtableId, "resume 不换场");
  await manager.dispose();
});

await run("T-4：modelCalls 覆盖 aux 整理会话（整理 prompt 计入总量）", async () => {
  // 「pause 之后零模型调用」只有在 modelCalls 看得见 aux 时才成立：整理走的是
  // 短命 aux session，不是席位。旧写法只统计 fixture.seats，aux 偷跑一次 prompt
  // 也不会让任何断言变红——这条用例就是那次偷跑的探针。
  const fixture = await makeFixture("aux-calls");
  const { manager } = fixture;
  await manager.createRoundtable({ topic: "整理调用可见性" });
  await settle();
  assertEqual(fixture.auxes.length, 0, "未整理前没有 aux session");
  const before = modelCalls(fixture);

  await manager.requestWrapUp("system");
  await settle();
  assertEqual(fixture.auxes.length, 1, "系统整理创建了一个 aux session");
  assertEqual(modelCalls(fixture) - before, 1, "整理的那次 prompt 被计入 modelCalls（退回只统计席位时这里恒为 0）");
  assertEqual(
    fixture.auxes[0]!.calls.filter((call) => call === "prompt").length,
    1,
    "aux fake 与席位 fake 同口径记录 calls",
  );
  await manager.dispose();
});

// ============================================================================
// 4. 重启恢复（AC-12 / §5.11）
// ============================================================================

await run("重启：恢复名册/未决项/交付物，默认暂停，已 injected 不再变 pending", async () => {
  const fixture = await makeFixture("restart");
  const { manager } = fixture;
  const state = await manager.createRoundtable({ topic: "重启恢复测试" });
  await settle();
  const ids = seatIds(state);
  const [seatA, seatB] = ids;

  const openItem = manager.openItem(seatB!, "是否要引入缓存", "反例席提出需要数据支撑");
  const claimed = manager.claimOpenItem(seatB!, openItem.id);
  assertEqual(claimed?.status, "claimed", "未决项可被自愿认领");
  const deliverable = await manager.requestWrapUp("system");
  assertEqual(deliverable.version, 1, "整理产出 v1");

  // 让一条席位消息被 commit（injected）：席位 fake 的 prompt 会 resolve 后 commit。
  await manager.postSeatMessage(seatA!, {
    to: seatB!,
    text: "这条会进入收件箱",
    type: "utterance",
    utteranceKind: "note",
    interrupt: "L1",
    mentionIds: [seatB!],
  });
  await settle();
  const injected = manager.getInbox(seatB!).filter((entry) => entry.state === "injected");
  assert(injected.length >= 1, "有一条已注入的收件箱条目用于重启检查");
  const injectedId = injected[0]!.messageId;
  const timelineCount = timelineOf(manager).length;

  await manager.dispose();

  const second = await makeFixture("restart-2", { context: buildWindowsContext(fixture.workspace) });
  const restored = second.manager;
  assert(restored.getState() !== null, "重启后恢复了场");
  const restoredState = restored.getState()!;
  assertEqual(restoredState.roundtableId, state.roundtableId, "恢复同一个 roundtableId");
  assertEqual(restoredState.lifecycle, "paused", "默认恢复到暂停（先确认再消耗）");
  assertEqual(seatIds(restoredState).length, 5, "名册与视角恢复");
  assertEqual(restored.getOpenItems().length, 1, "未决项恢复");
  assertEqual(restored.getOpenItems()[0]?.subject, "是否要引入缓存", "未决项内容恢复");
  assertEqual(restored.getOpenItems()[0]?.status, "claimed", "未决项的认领状态恢复");
  assertEqual(restored.getDeliverables().length, 1, "交付物版本恢复");
  assertEqual(restored.getDeliverables()[0]?.version, 1, "交付物版本号恢复");
  assertIncludes(restored.getDeliverables()[0]?.markdown ?? "", "采用方案 A", "交付物正文恢复");
  assertEqual(timelineOf(restored).length, timelineCount, "时间线 replay（条数一致）");

  const restoredEntry = inboxEntry(restored, seatB!, injectedId);
  assertEqual(restoredEntry?.state, "injected", "已 injected 的条目不再变回待注入（AC-12）");
  assertEqual(restored.getAttention().some((item) => item.text.includes("确认后继续")), true, "恢复后请用户确认");
  // F5-4（G10 补线 2）：这条提示必须带 action=resume，renderer 才会在 ack 之后补发
  // resume 命令；只在 facade 上写而 AttentionBus.push 漏拷贝字段的话这里就红。
  assertEqual(
    restored.getAttention().find((item) => item.text.includes("确认后继续"))?.action,
    "resume",
    "确认后继续带 action=resume（G10 补线 2 / F5-4）",
  );

  await restored.dispose();
});

// ============================================================================
// 5. 增减席（AC-14 / §5.12）
// ============================================================================

await run("addSeat / removeSeat：重名抛错、未决项回 open、其它席不受影响", async () => {
  const fixture = await makeFixture("seats");
  const { manager } = fixture;
  await manager.createRoundtable({ topic: "增减席测试" });
  await settle();
  const ids = seatIds(manager.getState()!);
  const [seatA, seatB] = ids;

  const added = await manager.addSeat({ name: "成本", perspective: "盯住实现与运维成本。", auth: "read_only" });
  await settle();
  assertEqual(activeSeatIds(manager.getState()!).length, 6, "加席后 6 个活跃席位");
  assert(added.seatId.includes("::"), "新席有 seatId");
  assertEqual(typeof added.color, "string", "新席有颜色");
  const announcement = timelineOf(manager).find((item) => item.type === "system" && item.text.includes("加入圆桌"));
  assert(announcement !== undefined, "加席在主线公布（AC-14）");
  assertIncludes(announcement?.text ?? "", "主线", "入场公布带主线摘要");

  await assertRejects(
    () => manager.addSeat({ name: added.name, perspective: "重名", auth: "read_only" }),
    "重名展示名抛错（H25）",
  );

  const item = manager.openItem(seatB!, "谁能验证这一点", "需要一个可复现的实验");
  assertEqual(manager.claimOpenItem(seatB!, item.id)?.status, "claimed", "席位认领未决项");
  await manager.removeSeat(seatB!, "user");
  await settle();
  assertEqual(manager.getState()!.seats[seatB!]?.status, "exited", "被移除席状态 exited");
  const releasedItem = manager.getOpenItems().find((candidate) => candidate.id === item.id);
  assertEqual(releasedItem?.status, "open", "被移除席的未决项回到 open");
  assertEqual(releasedItem?.claimedBy, undefined, "认领者被清空");
  assertEqual(manager.getState()!.seats[seatA!]?.status !== "exited", true, "其它席仍在名册上");
  assertEqual(activeSeatIds(manager.getState()!).length, 5, "移除后活跃席回到 5");
  await manager.dispose();
});

// ============================================================================
// 6. 有序模式（H28 / §5.15）
// ============================================================================

await run("setOrderedMode：argument 已记录、报告 queued、席位 waiting_turn、放行后投递", async () => {
  const fixture = await makeFixture("ordered");
  const { manager } = fixture;
  await manager.createRoundtable({
    topic: "有序模式测试",
    settings: { orderedMode: true, orderedReleaseMs: 60 },
  });
  await settle();
  const ids = seatIds(manager.getState()!);
  const [seatA, seatB] = ids;

  // H28 / §4.5：有序模式下 argument 一律「先记录 + 进门队列」——没有「发言棒空闲就直接放行」
  // 的快路径（PRD FR-6 明确不做全局唯一说话棒）。工具立即拿到 queued，投递在放行时发生。
  const first = await manager.postSeatMessage(seatA!, {
    to: seatB!,
    text: "第一条长论证",
    type: "utterance",
    utteranceKind: "argument",
    interrupt: "L1",
    mentionIds: [seatB!],
  });
  assert(first.ok === true && first.queued === true, "有序模式下 argument 一律进队列并报告 queued（H28）");
  const firstId = first.ok ? first.messageId : "";
  assertEqual(manager.getState()!.seats[seatA!]?.status, "waiting_turn", "排队席状态投影为 waiting_turn");

  const queued = await manager.postSeatMessage(seatB!, {
    to: seatA!,
    text: "第二条长论证",
    type: "utterance",
    utteranceKind: "argument",
    interrupt: "L1",
    mentionIds: [seatA!],
  });
  assert(queued.ok === true && queued.queued === true, "第二条 argument 被有序门收下并报告 queued（H28）");
  const queuedId = queued.ok ? queued.messageId : "";

  const recorded = timelineOf(manager).find((item) => item.id === queuedId);
  assert(recorded !== undefined, "排队的 argument 已经落进时间线（已记录）");
  assertEqual(inboxEntry(manager, seatA!, queuedId), undefined, "排队期间尚未进入目标席收件箱");
  assertEqual(manager.getState()!.seats[seatB!]?.status, "waiting_turn", "排队席状态投影为 waiting_turn");

  // 知识卡不进有序队列（FR-6：知识卡 / 短补充 / 提问 / 探索回灌都不排队）。
  const card = await manager.postSeatMessage(seatA!, {
    to: "*",
    text: "带依据的发现",
    type: "knowledge_card",
    utteranceKind: "knowledge_card",
    interrupt: "L1",
    mentionIds: [],
    knowledgeCard: {
      claim: "向量索引在该规模下更快",
      claimKind: "evidenced",
      confidence: "medium",
      evidence: [{ kind: "path", ref: "bench.md" }],
    },
  });
  assert(card.ok === true && card.queued !== true, "知识卡不进入有序队列，直接投递");

  await sleep(320);
  await settle();
  const delivered = inboxEntry(manager, seatA!, queuedId);
  assert(delivered !== undefined, "到点后 argument 被投递（onReleased → inbox）");
  assertEqual(delivered?.text, "第二条长论证", "投递的是原文");
  assertEqual(inboxEntry(manager, seatB!, firstId)?.text, "第一条长论证", "排队的每条 argument 都在放行时投递");
  assertEqual(manager.getState()!.seats[seatB!]?.status !== "waiting_turn", true, "放行后清掉 waiting_turn");
  assertEqual(manager.getState()!.seats[seatA!]?.status !== "waiting_turn", true, "另一席的 waiting_turn 也清掉");

  manager.setOrderedMode(false);
  assertEqual(manager.getState()!.orderedMode, false, "setOrderedMode 只写 settings（H27）");
  await manager.dispose();
});

// ============================================================================
// 7. 私密消息（H36 / AC-20）
// ============================================================================

await run("postUserMessage(private)：时间线只有 stub，正文只在 InboxEntry.text", async () => {
  const fixture = await makeFixture("private");
  const { manager } = fixture;
  await manager.createRoundtable({ topic: "私密消息测试" });
  await settle();
  const [seatA] = seatIds(manager.getState()!);

  const stub = await manager.postUserMessage({ to: seatA!, text: "只给资料席看的正文", private: true });
  assertEqual(stub.type, "private_stub", "时间线类型是 private_stub");
  assertEqual(stub.text, "", "stub 的时间线正文为空串");
  assertEqual(stub.privateStub?.toId, seatA!, "stub 记录了收件席");
  const entry = inboxEntry(manager, seatA!, stub.id);
  assertEqual(entry?.text, "只给资料席看的正文", "正文只在 InboxEntry.text");
  assertEqual(entry?.priority, "user", "用户私密消息优先级为 user");
  assertEqual(timelineOf(manager).some((item) => item.text.includes("只给资料席看的正文")), false, "时间线里找不到私密正文");
  assertEqual(manager.getInbox(seatA!).filter((e) => e.messageId === stub.id).length, 1, "只有目标席收到这一条");

  await assertRejects(
    async () => manager.postUserMessage({ to: "*", text: "私密广播", private: true }),
    "私密消息不能广播",
  );
  await manager.dispose();
});

// ============================================================================
// 8. 移交（§4.15 / AC-19）
// ============================================================================

await run("buildHandoff：payload 绑定具体交付物版本", async () => {
  const fixture = await makeFixture("handoff");
  const { manager } = fixture;
  await manager.createRoundtable({ topic: "移交测试" });
  await settle();
  const ids0 = seatIds(manager.getState()!)[0]!;
  const deliverable = await manager.requestWrapUp("system");
  assertIncludes(deliverable.markdown, "采用方案 A", "系统整理写回正文");

  const solo = await manager.buildHandoff(deliverable.id, "solo");
  assertIncludes(solo.text, `v${deliverable.version}`, "solo 移交带交付物版本");
  assertIncludes(solo.text, `cutoffSeq=${deliverable.cutoffSeq}`, "solo 移交带截止点");
  assertIncludes(solo.text, "采用方案 A", "solo 移交带正文");
  const plan = await manager.buildHandoff(deliverable.id, "plan");
  assertIncludes(plan.text, `v${deliverable.version}`, "plan 移交带交付物版本");

  // handoff.ts 只产文本（H15：Plan 字段名是 requestText，不是 request.text）。
  const handoffInput = { state: manager.getState()!, deliverable };
  const planPayload = buildPlanHandoffRequest(handoffInput);
  assertEqual(Object.keys(planPayload).join(","), "requestText", "Plan 移交字段名锁定 requestText（H15）");
  assertIncludes(planPayload.requestText, `v${deliverable.version}`, "requestText 带版本");
  assertIncludes(buildSoloHandoffPrompt(handoffInput), "# 圆桌交付物 v", "solo 移交文本以交付物标题开头");

  await assertRejects(() => manager.buildHandoff("不存在", "solo"), "未知交付物抛错");

  const beforeRevise = manager.getDeliverables().find((entry) => entry.id === deliverable.id)?.revision ?? 0;
  const revised = manager.reviseDeliverable(
    deliverable.id,
    "# 修订稿\n\n## 结论与建议\n改用手写方案。",
    "seat-x",
    beforeRevise,
  );
  assertEqual(revised.ok, true, "最新版可被修订");
  assertEqual(
    manager.getDeliverables().find((entry) => entry.id === deliverable.id)?.revision,
    beforeRevise + 1,
    "修订成功后 revision +1（F2-3 CAS 令牌）",
  );
  const second = await manager.requestWrapUp("system");
  assertEqual(second.version, 2, "再整理出一版");
  const stale = manager.reviseDeliverable(deliverable.id, "过期改动", "seat-y");
  assertEqual(stale.ok, false, "已有后继版本时修订被拒（不静默覆盖）");
  assertEqual(stale.ok === false ? stale.currentVersion : 0, 2, "冲突回报当前最新版本号");
  assertEqual(stale.ok === false ? stale.currentRevision : 0, second.revision, "冲突回报当前 revision（F2-3）");
  const stanced = manager.stanceOnDeliverable(second.id, ids0, "support", "同意", "high");
  assertEqual(stanced.ok, true, "席位可对当前版本表态（FR-7）");

  // F2-3 补线（G2 仲裁）：席位工具必须按 facade 的形参顺序回调（id, markdown, actor）。
  // 三者同为 string，类型系统抓不到顺序错位；顺序错了席位路径会拿 seatId 当交付物 id，
  // 恒返回 conflict，F2-3 要求的「席位可修订、模型按 currentRevision 重试」整条失效。
  const seatTools = registerSeatTools({ seatId: ids0, host: manager });
  const reviseTool = seatTools.find((tool) => tool.name === "revise_deliverable")!;
  const currentSecond = manager.getDeliverables().find((entry) => entry.id === second.id);
  const viaTool = await reviseTool.execute(
    "tc-revise",
    {
      id: second.id,
      markdown: "# 席位修订稿\n\n## 结论与建议\n由席位改写。",
      expectedRevision: currentSecond?.revision ?? second.revision,
    },
    undefined,
    undefined,
    NO_EXTENSION_CONTEXT,
  );
  assertEqual(
    (viaTool.details as { ok: boolean }).ok,
    true,
    "席位经 revise_deliverable 真的写入当前版本（工具与 facade 形参顺序一致）",
  );
  assertIncludes(
    manager.getDeliverables().find((entry) => entry.id === second.id)?.markdown ?? "",
    "由席位改写",
    "席位修订的正文落到交付物（不是只回 conflict）",
  );

  // 同源的形参错位（本轮修复发现）：stance_on_deliverable 也必须按 facade 的
  // (id, seatId, stance) 回调。写反时 setStance 收到 id=seatId，恒返回
  // 「交付物 <seatId> 不存在」，席位表态（FR-7）在席位侧 100% 失效。
  const stanceTool = seatTools.find((tool) => tool.name === "stance_on_deliverable")!;
  const stanceViaTool = await stanceTool.execute(
    "tc-stance",
    { id: second.id, stance: "oppose", reason: "席位反对" },
    undefined,
    undefined,
    NO_EXTENSION_CONTEXT,
  );
  assertEqual(
    (stanceViaTool.details as { ok: boolean }).ok,
    true,
    "席位经 stance_on_deliverable 能对当前版本表态（工具与 facade 形参顺序一致）",
  );
  assertEqual(
    manager
      .getDeliverables()
      .find((entry) => entry.id === second.id)
      ?.stances?.find((entry) => entry.seatId === ids0)?.stance,
    "oppose",
    "席位表态记录到该版本（不是落到别人/别的版本上）",
  );
  await manager.dispose();
});

// ============================================================================
// 9. createAgentSession 入参（H29 / H34 / H35）+ WSL 不变量
// ============================================================================

await run("席位 createAgentSession 入参 + WSL：backend 对象身份 / runtimeCwd=logical / hash=physical", async () => {
  const backendDisposeCalls: number[] = [];
  const backend: ExecutionBackend = {
    paths: {
      pathStyle: "posix",
      homeDir: "/home/u",
      resolvePath: (input, cwd) => pathPosix.resolve(cwd, input),
    },
    getCwd: () => "/home/u/repo",
    dispose: async () => {
      backendDisposeCalls.push(1);
    },
  };
  const physicalCwd = makeWorkspace("wsl");
  const context = buildWslContext(physicalCwd, backend);
  const fixture = await makeFixture("wsl-run", { context });
  const { manager } = fixture;
  const state = await manager.createRoundtable({ topic: "WSL 议题" });
  await settle();

  const seatOptions = fixture.captured.filter((options) => (options.customTools ?? []).length > 0);
  assertEqual(seatOptions.length, 5, "5 个席位各自创建了 session");
  for (const options of seatOptions) {
    assert(options.executionBackend === backend, "席位与 host 共用同一个 executionBackend 对象（身份）");
    assertEqual(options.runtimeCwd, "/home/u/repo", "runtimeCwd = logical cwd（不是物理路径）");
    assertEqual(options.cwd, physicalCwd, "bootstrap cwd = physical cwd");
    assertEqual(options.enableBuiltInEnhancementTools, false, "enhancement 工具关闭（H29）");
    assertEqual(options.shouldStopAfterTurn !== undefined, true, "注入了 shouldStopAfterTurn（H32 消费语义）");
    assertEqual(options.hostToolPolicyOverride !== undefined, true, "hostToolPolicyOverride 永不 undefined");
    const tools = options.tools ?? [];
    for (const tool of ["read", "grep", "find", "ls"]) {
      assert(tools.includes(tool), `tools 白名单含 ${tool}（H35）`);
    }
    assert(!tools.includes("edit") && !tools.includes("write"), "只读档不含 edit/write");
    assert(!tools.includes("bash") && !tools.includes("agent"), "tools 白名单不含内置 bash / agent");
    const excluded = options.excludeTools ?? [];
    for (const tool of ["bash", "run_background", "read_output", "stop_process", "agent", "get_goal", "create_goal", "update_goal"]) {
      assert(excluded.includes(tool), `excludeTools 含 ${tool}（H29）`);
    }
    assertEqual((options.customTools ?? []).length, 13, "席位工具 13 个（§4.11）");
  }

  // 席位 cwd 视图（H34）：logical + backend.getCwd()。
  const exec = access(manager)._seatExecView();
  assertEqual(exec.logicalCwd, "/home/u/repo", "SeatExecutionView.logicalCwd = logical cwd");
  assertEqual(exec.getCwd(), "/home/u/repo", "exec.getCwd() = backend cwd（= logical）");
  assertEqual(exec.resolvePath("src/a.ts"), "/home/u/repo/src/a.ts", "路径解析走 backend.paths.resolvePath");

  // 落盘 / hash 用物理路径（§6.1）。快照有合并窗口，断言前先 flush。
  await persistenceOf(manager).flush();
  const physicalDir = join(getAgentDir(), "roundtables", sha1Hex(physicalCwd), state.roundtableId);
  const logicalDir = join(getAgentDir(), "roundtables", sha1Hex("/home/u/repo"), state.roundtableId);
  assertEqual(existsSync(join(physicalDir, "meta.json")), true, "圆桌目录按 physicalCwd 的 sha1 落盘");
  assertEqual(existsSync(logicalDir), false, "没有按 logical cwd 落盘的第二份目录");
  assertEqual(access(manager)._physicalCwd, physicalCwd, "facade 保存 physicalCwd 作为 hash 输入");
  assertEqual(access(manager)._logicalCwd, "/home/u/repo", "facade 保存 logicalCwd 作为 runtimeCwd");
  assertEqual(access(manager)._isWsl, true, "WSL 标记来自 context");

  // 停止不是 backend 的所有者：只有 context owner 才能 dispose。
  await manager.stop();
  assertEqual(access(manager)._executionBackend === backend, true, "stop 不释放借来的 backend");
  assertEqual(backendDisposeCalls.length, 0, "stop 从不调用 backend.dispose");
  await manager.dispose();
});

// ============================================================================
// 10. metrics → runner（H20 / H43）
// ============================================================================

await run("metrics：H20 降速值接进 SeatRunner.getMinIdleMs", async () => {
  const plain = await makeFixture("idle-plain");
  await plain.manager.createRoundtable({ topic: "默认无降速" });
  await settle();
  const [plainSeat] = seatIds(plain.manager.getState()!);
  const plainRunner = access(plain.manager)._runners.get(plainSeat!) as unknown as { getMinIdleMs: () => number };
  assertEqual(plainRunner.getMinIdleMs(), 0, "默认（未开无人值守）getMinIdleMs = 0");
  await plain.manager.dispose();

  // 软预算按成本算（5 席 fake 各 0.01 → 合计 0.05），比值确定：
  // 0.05 / 0.02 = 2.5 → 段位 2（降速 + 只探索不整理，还没到暂停）。
  const guarded = await makeFixture("idle-guarded");
  await guarded.manager.createRoundtable({
    topic: "无人值守降速",
    settings: { unattendedGuard: true, softBudget: { maxCostUsd: 0.02 } },
  });
  await settle();
  const [guardedSeat] = seatIds(guarded.manager.getState()!);
  const guardedRunner = access(guarded.manager)._runners.get(guardedSeat!) as unknown as { getMinIdleMs: () => number };
  assertEqual(guardedRunner.getMinIdleMs(), 15_000, "过软预算后 runner 拿到 15s 降速值（H20/H43）");
  assertEqual(
    guarded.manager.getAttention().some((item) => item.kind === "soft_budget"),
    true,
    "软预算到达只发注意力，不拒绝发言（H19）",
  );
  assertEqual(guarded.manager.getState()!.lifecycle, "active", "只探索阶段仍不暂停（暂停要再过一次软预算）");

  let wrapUpError = "";
  try {
    await guarded.manager.requestWrapUp("system");
  } catch (err) {
    wrapUpError = err instanceof Error ? err.message : String(err);
  }
  assertIncludes(wrapUpError, "只探索不整理", "无人值守「只探索不整理」拒绝 request_wrap_up（H20）");

  // 再过同一软预算 1× → 暂停整场（H20 第三段；硬停止仍只在 hardStop.enabled 时生效）。
  guarded.manager.setSettings({ softBudget: { maxCostUsd: 0.01 } });
  access(guarded.manager)._modules!.metrics.evaluate();
  await settle();
  assertEqual(guarded.manager.getState()!.lifecycle, "paused", "再过同一软预算 1× → 无人值守暂停整场");
  await guarded.manager.dispose();
});

// ============================================================================
// 11. 注意力面：每个 kind 都有生产者（H44）
// ============================================================================

await run("注意力生产者：permission / write_conflict / l2_fused / seat_error / user_mentioned / deliverable_ready / exit_request / soft_budget / hard_stop", async () => {
  const fixture = await makeFixture("attention");
  const { manager } = fixture;
  await manager.createRoundtable({ topic: "注意力面测试" });
  await settle();
  const ids = seatIds(manager.getState()!);
  const [seatA, seatB] = ids;
  await manager.updateSeatAuth(seatA!, "write");
  await manager.updateSeatAuth(seatB!, "write");
  await settle();
  const kinds = (): string[] => manager.getAttention().map((item) => item.kind);

  // permission（唯一权限生产者）
  const permission = manager.requestPermission(seatA!, "team_bash", { command: "npm test" }, "需要跑测试");
  assert(kinds().includes("permission"), "permission ← request_permission");
  manager.respondPermission(permission.requestId, false, "不允许");

  // write_conflict（租约冲突）
  const claimed = manager.claimWritePaths(seatA!, ["src/a.ts"]);
  assertEqual(claimed.ok, true, "第一席拿到写租约");
  const conflict = manager.claimWritePaths(seatB!, ["src/a.ts"]);
  assertEqual(conflict.ok, false, "第二席申请同路径被拒绝");
  assert(kinds().includes("write_conflict"), "write_conflict ← 租约冲突");

  // user_mentioned（@user）
  await manager.postSeatMessage(seatA!, {
    to: "*",
    text: `请 @用户 决定优先级`,
    type: "question",
    utteranceKind: "question",
    interrupt: "L1",
    mentionIds: [USER_SEAT_ID],
  });
  assert(kinds().includes("user_mentioned"), "user_mentioned ← @用户");

  // l2_fused（L2 预算拒绝）
  await manager.postSeatMessage(seatA!, {
    to: seatB!,
    text: "第二条长论证，要求对方改向",
    type: "utterance",
    utteranceKind: "argument",
    interrupt: "L2",
    reason: "结论已经站不住",
    mentionIds: [seatB!],
  });
  await manager.postSeatMessage(seatA!, {
    to: seatB!,
    text: "又来一条",
    type: "utterance",
    utteranceKind: "argument",
    interrupt: "L2",
    reason: "再打断一次",
    mentionIds: [seatB!],
  });
  assert(kinds().includes("l2_fused"), "l2_fused ← 打断预算");

  // deliverable_ready（整理出稿）
  const deliverable = await manager.requestWrapUp("system");
  assert(kinds().includes("deliverable_ready"), "deliverable_ready ← 交付物建立");

  // exit_request（退出协商）
  await manager.requestExit(seatA!, seatB!, "该席已经完成任务");
  assert(kinds().includes("exit_request"), "exit_request ← request_exit");

  assert(deliverable.cutoffSeq >= 0, "交付物带截止点");
  assert(deliverable.markdown.includes("采用方案 A"), "整理正文写回该版本");

  // seat_stuck / wrap_up_ready 是时间驱动的：这里只断言 facade 把真实注意力面
  // 与探针接到了 health / metrics 上（生产者本身由各自模块的单测覆盖）。
  const health = access(manager)._modules?.health as unknown as {
    probes: Map<string, SeatHealthProbe>;
    attention: unknown;
  };
  assertEqual(health.probes.size, 5, "health 注册了全部席位探针（seat_stuck 生产者已接线）");
  // F3-1：生产者的 attention 参数是 facade 的 `_raiseAttention` 包装（push + 事件 + 落盘），
  // 不是裸 AttentionBus——裸 bus 的条目既不实时到渲染层也不进 attention.jsonl。
  assert(
    health.attention !== undefined && health.attention !== access(manager)._modules?.attention,
    "health 的注意力 sink 是 facade 的 _raiseAttention 包装，不是裸 AttentionBus（F3-1）",
  );
  assert(
    access(manager)._modules?.metrics.snapshot().perSeat !== undefined,
    "metrics 接在 facade 上（soft_budget / wrap_up_ready / hard_stop 生产者已接线）",
  );
  await manager.dispose();
});

// ============================================================================
// 11b. wrap_up_ready：H18 的整理建议由 façade 上的 metrics 经真实注意力面发出
// ============================================================================

await run("wrap_up_ready：证据静默 10 分钟由真实 AttentionBus 发出", async () => {
  const fixture = await makeFixture("wrapup-attention");
  const { manager } = fixture;
  await manager.createRoundtable({ topic: "整理建议", settings: { suggestWrapUp: true } });
  await settle();
  // 把开场时间往前挪 20 分钟：全场没有任何知识卡 / claimKind:"evidenced" 发言。
  access(manager)._state!.createdAt = Date.now() - 20 * 60_000;
  access(manager)._modules!.metrics.evaluate();
  assertEqual(
    manager.getAttention().some((item) => item.kind === "wrap_up_ready"),
    true,
    "wrap_up_ready ← metrics 经 façade 的真实注意力面（H18/H44）",
  );
  await manager.dispose();
});

// ============================================================================
// 11c. F3-1：生产者（metrics / interrupt）的注意力必须走 facade 的唯一出口
//      F3-2：时间线的落盘/事件也只有一个出口（不重复落盘）
// ============================================================================

await run("F3-1/F3-2：soft_budget 与 l2_fused 既发 attention 事件也落盘；时间线只追加一次", async () => {
  const fixture = await makeFixture("attention-sink");
  const { manager, workspace } = fixture;
  const events: TeamEvent[] = [];
  manager.onEvent((event) => {
    events.push(event);
  });
  // 软预算设成「当前成本必然超过」：metrics 在 create 结束后立刻 evaluate。
  const state = await manager.createRoundtable({
    topic: "生产者注意力出口",
    settings: { softBudget: { maxCostUsd: 0.02 } },
  });
  await settle();
  const [seatA, seatB] = seatIds(manager.getState()!);

  assertEqual(
    manager.getAttention().some((item) => item.kind === "soft_budget"),
    true,
    "soft_budget 进入注意力面（metrics 生产者已接线）",
  );
  assertEqual(
    events.some((event) => event.type === "attention" && event.item.kind === "soft_budget"),
    true,
    "soft_budget 经 _raiseAttention 发出 attention 事件（接裸 bus 时事件数为 0，F3-1）",
  );

  // l2_fused ← 打断 controller（同一个 sink 出口）。
  await manager.postSeatMessage(seatA!, {
    to: seatB!,
    text: "第一条 L2",
    type: "utterance",
    utteranceKind: "argument",
    interrupt: "L2",
    reason: "结论站不住",
    mentionIds: [seatB!],
  });
  await manager.postSeatMessage(seatA!, {
    to: seatB!,
    text: "第二条 L2",
    type: "utterance",
    utteranceKind: "argument",
    interrupt: "L2",
    reason: "再打断一次",
    mentionIds: [seatB!],
  });
  assertEqual(
    events.some((event) => event.type === "attention" && event.item.kind === "l2_fused"),
    true,
    "l2_fused 经 _raiseAttention 发出 attention 事件（F3-1）",
  );

  // 落盘：attention.jsonl 是独立 replay 的持久流（§4.10），这两类都必须进去。
  await sleep(30);
  await persistenceOf(manager).flush();
  const persisted = readFileSync(
    roundtableFilePath(workspace, state.roundtableId, "attention.jsonl"),
    "utf-8",
  )
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { kind: string }).kind);
  assert(persisted.includes("soft_budget"), "soft_budget 落进 attention.jsonl（F3-1）");
  assert(persisted.includes("l2_fused"), "l2_fused 落进 attention.jsonl（F3-1）");

  // F3-2：facade 自己的 append 路径不再各自 persist/emit——一条用户消息只追加一次。
  const before = readFileSync(
    roundtableFilePath(workspace, state.roundtableId, "timeline.jsonl"),
    "utf-8",
  ).split("\n").filter((line) => line.trim().length > 0).length;
  const message = await manager.postUserMessage({ to: "*", text: "只应追加一次" });
  await sleep(30);
  const lines = readFileSync(roundtableFilePath(workspace, state.roundtableId, "timeline.jsonl"), "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  assertEqual(lines.length, before + 1, "postUserMessage 后 timeline.jsonl 只追加一次（F3-2：删除手动的 persist/emit）");
  assertEqual(
    lines.filter((line) => (JSON.parse(line) as { id: string }).id === message.id).length,
    1,
    "同一 messageId 在 timeline.jsonl 里只出现一次",
  );
  assertEqual(
    events.filter((event) => event.type === "timeline_item" && event.item.id === message.id).length,
    1,
    "同一 messageId 只发一次 timeline_item 事件",
  );
  await manager.dispose();
});

// ============================================================================
// 11d. F3-2 验收第二条：SeatRunner 自己 append 的条目（唤醒提示 / 半成品标注）
//      也必须经订阅出口落盘 + 发事件（facade 只是订阅方，没有它的 append 路径）
// ============================================================================

await run("F3-2：SeatRunner 侧的 append（唤醒提示）也经统一出口落盘并发事件", async () => {
  const fixture = await makeFixture("runner-append-outlet");
  const { manager, workspace } = fixture;
  const events: TeamEvent[] = [];
  manager.onEvent((event) => {
    events.push(event);
  });
  const state = await manager.createRoundtable({ topic: "唤醒提示也要落盘" });
  await settle();
  const [seatA] = seatIds(manager.getState()!);
  // 唤醒窗口只在待注入为 0 时走 runner.wake()（有 pending 时 wakeSeat 走 resume，
  // 那条路径不 append），所以先确认这个前提，否则用例会退化成 resume。
  assertEqual(
    manager.getInbox(seatA!).filter((entry) => entry.state === "pending_inject").length,
    0,
    "唤醒前该席收件箱没有待注入条目（走 runner.wake 而不是 runner.resume）",
  );
  const persisted = (): TimelineItem[] =>
    readFileSync(roundtableFilePath(workspace, state.roundtableId, "timeline.jsonl"), "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TimelineItem);
  const before = persisted().length;

  await manager.wakeSeat(seatA!);
  await settle();
  await sleep(50);

  const wakeItem = timelineOf(manager).find((item) => item.summary === "唤醒");
  assert(wakeItem !== undefined, "SeatRunner 的唤醒提示进了内存时间线");
  assertEqual(persisted().length, before + 1, "SeatRunner 侧的 append 也进 timeline.jsonl（F3-2）");
  assertEqual(
    persisted().filter((item) => item.id === wakeItem!.id).length,
    1,
    "唤醒提示只落盘一次（不重复写）",
  );
  assertEqual(
    events.filter((event) => event.type === "timeline_item" && event.item.id === wakeItem!.id).length,
    1,
    "SeatRunner 的条目也发一条 timeline_item（F3-2）",
  );
  await manager.dispose();
});

// ============================================================================
// 12. 席位 session 创建失败 / 崩溃：该席 error，圆桌其余继续（§5.14）
// ============================================================================

await run("席位 session 创建失败：该席 error + seat_error，其余席继续", async () => {
  const fixture = await makeFixture("seat-error", { failOnSeatIndex: 1 });
  const { manager } = fixture;
  await manager.createRoundtable({ topic: "单席失败不影响整桌" });
  await settle();
  const states = Object.values(manager.getState()!.seats);
  const errored = states.filter((seat) => seat.status === "error");
  assertEqual(errored.length, 1, "只有一个席位进入 error");
  assertEqual(manager.getAttention().some((item) => item.kind === "seat_error"), true, "发出 seat_error 注意力");
  const running = states.filter((seat) => seat.status === "speaking");
  assertEqual(running.length, 4, "其余 4 席照常开跑（圆桌继续）");
  await manager.dispose();
});

// ============================================================================
// 13. 硬停止（AC-11）
// ============================================================================

await run("hardStop：到达阈值发 hard_stop 并暂停整场", async () => {
  const fixture = await makeFixture("hardstop-run");
  const { manager } = fixture;
  await manager.createRoundtable({
    topic: "硬停止运行",
    settings: { hardStop: { enabled: true, maxDurationMs: 1, allowWrapUpOnStop: false } },
  });
  await sleep(15);
  await manager.postUserMessage({ to: "*", text: "触发一次评估" });
  await settle();
  assertEqual(manager.getAttention().some((item) => item.kind === "hard_stop"), true, "hard_stop ← metrics");
  assertEqual(manager.getState()!.lifecycle, "paused", "硬停止停一切团队模型调用");
  await manager.dispose();
});

// ============================================================================
// 13b. 停止时的一次整理（AC-11：只有授权过才允许）
// ============================================================================

await run("stop({wrapUp})：只有 hardStop.allowWrapUpOnStop 授权时才整理一次", async () => {
  const allowed = await makeFixture("stop-wrapup");
  await allowed.manager.createRoundtable({
    topic: "停止后整理",
    settings: { hardStop: { enabled: true, allowWrapUpOnStop: true } },
  });
  await settle();
  await allowed.manager.stop({ wrapUp: true });
  const deliverables = allowed.manager.getDeliverables();
  assertEqual(deliverables.length, 1, "授权后停止时产出一次交付物");
  assertIncludes(deliverables[0]?.markdown ?? "", "采用方案 A", "整理正文写回该版本");
  assertEqual(allowed.manager.getState()!.lifecycle, "stopped", "停止后 lifecycle = stopped");
  assertEqual(allowed.manager.hasActiveTeam(), false, "停止后不再算活跃场");
  await allowed.manager.dispose();

  const refused = await makeFixture("stop-nowrapup");
  await refused.manager.createRoundtable({
    topic: "未授权整理",
    settings: { hardStop: { enabled: true, allowWrapUpOnStop: false } },
  });
  await settle();
  await refused.manager.stop({ wrapUp: true });
  assertEqual(refused.manager.getDeliverables().length, 0, "未授权时不发起整理调用");
  await refused.manager.dispose();
});

// ============================================================================
// 14. 预设（plan §6.4）
// ============================================================================
await run("预设：listPresets / savePreset / deletePreset 落在 getAgentDir()/roundtable-presets.json", async () => {
  const fixture = await makeFixture("presets");
  const { manager } = fixture;
  await manager.savePreset("我的六席", [
    { name: "甲", perspective: "视角甲", auth: "read_only" },
    { name: "乙", perspective: "视角乙", auth: "read_only" },
    { name: "丙", perspective: "视角丙", auth: "read_only" },
  ]);
  const presets = await manager.listPresets();
  assertEqual(presets.length, 1, "保存一个预设");
  assertEqual(presets[0]?.name, "我的六席", "预设名保留");
  assertEqual(presets[0]?.seats.length, 3, "预设席位保留");
  assertEqual(existsSync(join(getAgentDir(), "roundtable-presets.json")), true, "预设文件在 agent 根目录（不属于工作区 hash）");

  await manager.savePreset("我的六席", [
    { name: "甲", perspective: "改过的视角", auth: "read_only" },
  ]);
  const updated = await manager.listPresets();
  assertEqual(updated.length, 1, "同名预设覆盖而不是追加");
  assertEqual(updated[0]?.seats[0]?.perspective, "改过的视角", "覆盖写入了新内容");

  await manager.deletePreset("我的六席");
  assertEqual((await manager.listPresets()).length, 0, "删除预设");
  await manager.dispose();
});

// ============================================================================
// 15. 导出（AC-21）+ H8 归档提示
// ============================================================================

await run("exportMarkdown：导出记录，且不静默丢场", async () => {
  const fixture = await makeFixture("export");
  const { manager } = fixture;
  await manager.createRoundtable({ topic: "导出测试" });
  await settle();
  const markdown = await manager.exportMarkdown();
  assertIncludes(markdown, "# 圆桌记录：", "导出带标题");
  assertIncludes(markdown, "导出测试", "导出带议题");
  assertIncludes(markdown, "## 时间线", "导出带时间线");
  assertIncludes(markdown, "## 未决项", "导出带未决项");

  // H8：阈值只提示，永不静默丢场。
  assertEqual(archiveNotice({ timelineBytes: 0, timelineEntries: 19_999 }), null, "未达阈值不提示");
  assert(archiveNotice({ timelineBytes: 0, timelineEntries: 20_000 }) !== null, "≥ 20000 条 → 归档提示");
  assert(archiveNotice({ timelineBytes: 50 * 1024 * 1024, timelineEntries: 1 }) !== null, "≥ 50MB → 归档提示");
  assertIncludes(
    archiveNotice({ timelineBytes: 0, timelineEntries: 20_000 })?.text ?? "",
    "不会自动删除",
    "提示说明记录不会被自动删除（不静默丢用户正在看的场）",
  );
  await manager.dispose();
});

// ============================================================================
// 16. 有序模式放行 + 退出协商超时（§5.12）
// ============================================================================

await run("退出协商超时：到点后按请求执行并记录双方说法", async () => {
  const fixture = await makeFixture("exit-timeout");
  const { manager } = fixture;
  await manager.createRoundtable({
    topic: "退出协商测试",
    settings: { exitRequestTimeoutMs: 40 },
  });
  await settle();
  const ids = seatIds(manager.getState()!);
  const [seatA, seatB] = ids;

  await manager.requestExit(seatA!, seatB!, "反例席的结论已经稳定");
  assertEqual(manager.getState()!.seats[seatB!]?.status !== "exited", true, "协商期间目标席仍在名册上");
  await sleep(120);
  await settle();
  assertEqual(manager.getState()!.seats[seatB!]?.status, "exited", "超时后执行移除");
  const record = timelineOf(manager).find((item) => item.type === "system" && item.text.includes("双方说法"));
  assert(record !== undefined, "双方说法记入时间线");
  assertIncludes(record?.text ?? "", "反例席的结论已经稳定", "记录请求方说法");

  // 对方接受时立即执行。
  await manager.requestExit(seatA!, ids[2]!, "该席可以退了");
  const pendingExit = manager.getAttention().filter((item) => item.kind === "exit_request").at(-1)!;
  await manager.respondExit(pendingExit.refId!, "同意退出", true);
  await settle();
  assertEqual(manager.getState()!.seats[ids[2]!]?.status, "exited", "接受后立即移除");
  await manager.dispose();
});

// ============================================================================
// 17. solo 隔离 / 禁止的调用
// ============================================================================

await run("源码自检：没有 setModel / setSteeringMode / setExecutionMode，也不 import agent-task", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    join(here, "..", "team-manager.ts"),
    join(here, "..", "team", "roster.ts"),
    join(here, "..", "team", "metrics.ts"),
    join(here, "..", "team", "export.ts"),
    join(here, "..", "team", "handoff.ts"),
    join(here, "..", "team", "debug-logger.ts"),
    join(here, "..", "team", "attention-bus.ts"),
    join(here, "..", "team", "ordered-speech.ts"),
    join(here, "..", "team", "open-items.ts"),
    join(here, "..", "team", "deliverable-store.ts"),
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const name = file.split(/[\\/]/).pop() ?? file;
    // 只看代码行：注释里会写「禁止 session.setModel()」这类说明。
    const code = source
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
      })
      .join("\n");
    assert(!code.includes("session.setModel("), `${name} 不调用 session.setModel（H24）`);
    assert(!code.includes(".setSteeringMode("), `${name} 不调用 setSteeringMode（H22）`);
    assert(!code.includes(".setExecutionMode("), `${name} 不调用 setExecutionMode（§4.5）`);
    assert(
      !/from\s+"[^"]*(agent-task|plan-controller)[^"]*"/.test(source),
      `${name} 不 import agent-task / PlanController（§2.4 禁止耦合）`,
    );
    assert(
      !/from\s+"[^"]*agent-task[^"]*"/.test(source),
      `${name} 不 import agent-task（席位不进 solo 调度器）`,
    );
  }
  assertEqual(STUCK_MS, 30 * 60_000, "卡死阈值沿用 30 分钟（真卡死才介入）");
});

// ============================================================================
// 18. metrics 单元面：wrap_up_ready（H18）
// ============================================================================

await run("RoundtableMetrics：H18 整理建议由「证据停止流入」触发", async () => {
  const attentions: Array<{ kind: string; text: string }> = [];
  const nowValue = { value: 1_000_000 };
  const timeline: TimelineItem[] = [
    {
      id: "k1",
      seq: 1,
      ts: nowValue.value - 20 * 60_000,
      type: "knowledge_card",
      fromId: "a::rt",
      toId: "*",
      text: "",
      summary: "早先的依据",
      mentionIds: [],
      knowledgeCard: { claim: "早期发现", claimKind: "evidenced", confidence: "high", evidence: [] },
    },
  ];
  const metrics = new RoundtableMetrics({
    getSeats: () => [],
    getTimeline: () => timeline,
    getSettings: () => ({
      orderedMode: false,
      waitForUserQuestions: false,
      autoContinueAfterCrash: false,
      unattendedGuard: false,
      suggestWrapUp: true,
      orderedReleaseMs: 60_000,
      exitRequestTimeoutMs: 120_000,
      l2: { perSeatPerTurn: 1, minIntervalMs: 30_000, globalWindowMs: 60_000, globalMaxInWindow: 8, consecutiveFuse: 2 },
    }),
    getLifecycle: () => "active",
    getCreatedAt: () => nowValue.value - 30 * 60_000,
    attention: { push: (item) => attentions.push({ kind: item.kind, text: item.text }) },
    now: () => nowValue.value,
  });
  metrics.evaluate();
  assertEqual(attentions.filter((item) => item.kind === "wrap_up_ready").length, 1, "连续 10 分钟无新证据 → wrap_up_ready");
  assertIncludes(attentions[0]?.text ?? "", "知识卡", "提示说明判断依据是证据停止流入");

  // 新知识卡进来后重新计时，不再重复提示。
  timeline.push({
    id: "k2",
    seq: 2,
    ts: nowValue.value,
    type: "knowledge_card",
    fromId: "b::rt",
    toId: "*",
    text: "",
    summary: "新依据",
    mentionIds: [],
    knowledgeCard: { claim: "新发现", claimKind: "evidenced", confidence: "high", evidence: [] },
  });
  metrics.evaluate();
  assertEqual(attentions.filter((item) => item.kind === "wrap_up_ready").length, 1, "证据回来后不再重复提示");

  // seat_stuck 生产者（时间驱动的健康检查；间隔与判定阈值可注入）。
  const stuck: string[] = [];
  const health = new RoundtableHealth({
    now: () => nowValue.value,
    intervalMs: 1_000_000,
    attention: { push: (item) => stuck.push(item.kind) },
  });
  health.registerSeat({
    seatId: "a::rt",
    isRunning: () => true,
    lastActiveAt: () => nowValue.value - 60 * 60_000,
    // F4-2：recover() 返回 Promise<boolean>，true = 真的恢复了。这里给 true，
    // 否则 health 一旦按「只在 true 时发 seat_stuck」（F4-2 修法 3）就推不出注意力。
    recover: async (): Promise<boolean> => true,
  });
  await health.checkNow();
  assertEqual(stuck.includes("seat_stuck"), true, "真卡死才发 seat_stuck（H44）");
  health.stop();
  metrics.stop();
});

// ============================================================================
// 19. F3-3：换场（initialize）必须把旧场的 session / runner / 定时器拆干净
// ============================================================================

await run("F3-3：initialize → create → initialize 拆掉旧场（dispose 计数、定时器、runner）", async () => {
  const workspace = makeWorkspace("teardown");
  let disposeCalls = 0;
  const factory = async (sessionOptions: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
    if ((sessionOptions.customTools ?? []).length === 0) {
      return { session: createAuxFake(AUX_MARKDOWN).session } as unknown as CreateAgentSessionResult;
    }
    const fake = createSeatFake();
    const base = fake.session.dispose.bind(fake.session);
    (fake.session as unknown as { dispose: (options: { reason: string }) => Promise<void> }).dispose = async (options) => {
      disposeCalls++;
      await base(options);
    };
    return { session: fake.session } as unknown as CreateAgentSessionResult;
  };
  const manager = new TeamManager({ sessionFactory: factory as typeof createAgentSession });
  const context = buildWindowsContext(workspace);
  await manager.initialize(context, AuthStorage.inMemory());
  const state = await manager.createRoundtable({ topic: "换场前的一场" });
  await settle();
  const seatCount = seatIds(state).length;
  assertEqual(disposeCalls, 0, "建场后没有席位 session 被 dispose");
  const oldHealth = access(manager)._modules!.health as unknown as { timer: unknown };
  const oldMetrics = access(manager)._modules!.metrics as unknown as { timer: unknown };
  assert(oldHealth.timer !== null && oldMetrics.timer !== null, "旧场的 health / metrics 定时器在跑");
  // meta.json 有 200ms 合并窗口：先落盘，第二次 initialize 才是「恢复」而不是「无场」。
  await persistenceOf(manager).flush();
  await settle();

  await manager.initialize(context, AuthStorage.inMemory());
  await settle();
  assert(disposeCalls >= seatCount, `旧场 ${seatCount} 个席位 session 全部 dispose（实际 ${disposeCalls}）`);
  assertEqual(oldHealth.timer, null, "旧 health 定时器已停（F3-3）");
  assertEqual(oldMetrics.timer, null, "旧 metrics 定时器已停（F3-3）");
  assertEqual(access(manager)._runners.size, 0, "旧 runner 不残留");
  assertEqual(access(manager)._sessions.size, 0, "旧 session 不残留");
  await manager.dispose();
});

// ============================================================================
// 20. F3-4：退出协商定时器在 stop 之后不能把主进程打崩
// ============================================================================

await run("F3-4：requestExit 后立即 stop 不产生 unhandledRejection，归档目录不被重建", async () => {
  const fixture = await makeFixture("exit-after-stop");
  const { manager, workspace } = fixture;
  const rejections: Array<unknown> = [];
  const onRejection = (err: unknown): void => {
    rejections.push(err);
  };
  process.on("unhandledRejection", onRejection);
  try {
    const events: TeamEvent[] = [];
    manager.onEvent((event) => {
      events.push(event);
    });
    const state = await manager.createRoundtable({
      topic: "停止后的退出定时器",
      settings: { exitRequestTimeoutMs: 30 },
    });
    await settle();
    const [seatA, seatB] = seatIds(manager.getState()!);
    await manager.requestExit(seatA!, seatB!, "该席可以退了");
    const requested = events.find((event) => event.type === "exit_request");
    await manager.stop();
    const archived = join(getAgentDir(), "roundtables", sha1Hex(workspace), "archive", state.roundtableId);
    assertEqual(existsSync(archived), true, "stop 之后整场目录归档");

    // 定时器到点（已在 stop 里 clearAll 清掉）：不报错、不重建活跃目录。
    await sleep(120);
    await settle();
    assertEqual(rejections.length, 0, `停止后没有 unhandledRejection（实际 ${rejections.length}）`);
    assertEqual(
      existsSync(join(getAgentDir(), "roundtables", sha1Hex(workspace), state.roundtableId)),
      false,
      "归档后活跃目录不被重建（F3-4）",
    );

    // 直接走一遍「超时到点」的应用路径：lifecycle 守卫让它变 no-op，绝不抛。
    const request = requested !== undefined && requested.type === "exit_request" ? requested.request : null;
    let guardError: unknown = null;
    if (request !== null) {
      try {
        await access(manager)._applyExit(request as ExitRequest, "peer");
      } catch (err) {
        guardError = err;
      }
    }
    assertEqual(guardError, null, "stop 之后的 _applyExit 是 no-op（F3-4 lifecycle 守卫）");
    assertEqual(
      existsSync(join(getAgentDir(), "roundtables", sha1Hex(workspace), state.roundtableId)),
      false,
      "no-op 路径也不重建归档目录",
    );
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  await manager.dispose();
});

// ============================================================================
// 21. F3-5：jsonl / 快照写失败 → seat_error 注意力（30s 节流）
// ============================================================================

await run("F3-5：落盘失败发 seat_error 注意力，同一写入目标 30s 内只发一次", async () => {
  const fixture = await makeFixture("persist-fail");
  const { manager } = fixture;
  await manager.createRoundtable({ topic: "落盘失败" });
  await settle();
  const modules = access(manager)._modules!;
  const failed = (): Promise<void> => Promise.reject(new Error("disk full (test)"));
  modules.persistence.appendTimeline = failed;
  modules.persistence.saveSnapshot = failed;
  const timelineFailures = (): AttentionItem[] =>
    manager.getAttention().filter((item) => item.kind === "seat_error" && item.text.includes("（timeline.jsonl）"));

  await manager.postUserMessage({ to: "*", text: "第一条" });
  await settle();
  assertEqual(timelineFailures().length, 1, "timeline.jsonl 写失败 → 一条 seat_error 注意力（§5.14 / F3-5）");
  assertIncludes(timelineFailures()[0]?.text ?? "", "disk full (test)", "注意力带上失败原因");

  await manager.postUserMessage({ to: "*", text: "第二条" });
  await settle();
  assertEqual(timelineFailures().length, 1, "同一写入目标 30s 内只发一次（节流，F3-5）");
  await manager.dispose();
});

// ============================================================================
// 22. F3-6：aux 整理产出空稿 → 不置 ready、保持 drafting
// ============================================================================

await run("F3-6：aux 起草返回空串 → 版本保持 drafting 并发 seat_error", async () => {
  const workspace = makeWorkspace("empty-wrapup");
  const factory = async (sessionOptions: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
    if ((sessionOptions.customTools ?? []).length === 0) {
      // 整理 session 返回空正文（起草失败 / 被 pause 取消的表现）。
      return { session: createAuxFake("").session } as unknown as CreateAgentSessionResult;
    }
    return { session: createSeatFake().session } as unknown as CreateAgentSessionResult;
  };
  const manager = new TeamManager({ sessionFactory: factory as typeof createAgentSession });
  await manager.initialize(buildWindowsContext(workspace), AuthStorage.inMemory());
  await manager.createRoundtable({ topic: "空稿" });
  await settle();

  const deliverable = await manager.requestWrapUp("system");
  assertEqual(deliverable.markdown, "", "空稿没有正文");
  assertEqual(deliverable.status, "drafting", "空稿不置 ready（仍 drafting，F3-6 / AC-5）");
  const latest = manager.getDeliverables().at(-1);
  assertEqual(latest?.status, "drafting", "交付物列表里也是 drafting，没有 ready 空稿");
  assertEqual(
    manager.getAttention().some((item) => item.kind === "seat_error" && item.text.includes("整理未产出正文")),
    true,
    "空稿发 seat_error 注意力（可重新整理）",
  );
  await manager.dispose();
});

// ============================================================================
// 23. F3-7：file_change 落到未持约路径 → 事后审计注意力
// ============================================================================

await run("F3-7：未持约路径的 file_change → write_conflict 事后审计（30s 去重）", async () => {
  const fixture = await makeFixture("file-change");
  const { manager, workspace } = fixture;
  await manager.createRoundtable({ topic: "文件变更审计" });
  await settle();
  const [seatA, seatB] = seatIds(manager.getState()!);
  await manager.updateSeatAuth(seatA!, "write");
  await manager.updateSeatAuth(seatB!, "write");
  const fileChange = (path: string): AgentSessionEvent => ({
    type: "file_change",
    toolCallId: "tc-file",
    toolName: "edit",
    change: { path, added: 3, removed: 1, toolCallId: "tc-file", toolName: "edit" },
    aggregate: { files: 1, added: 3, removed: 1, changes: [] },
  });
  const audits = (): AttentionItem[] =>
    manager.getAttention().filter((item) => item.text.includes("未持约路径"));

  const unleased = join(workspace, "src", "outside.ts");
  access(manager)._onSeatEvent(seatA!, fileChange(unleased));
  assertEqual(audits().length, 1, "未持约路径的文件变更发一条 write_conflict 注意力（§4.6 末段）");
  assertEqual(audits()[0]?.kind, "write_conflict", "kind = write_conflict");
  assertEqual(audits()[0]?.seatId, seatA!, "注意力带席位");
  assertIncludes(audits()[0]?.text ?? "", unleased, "注意力带路径");

  // 30s 去重：同一 (seatId, path) 再报一次不新增。
  access(manager)._onSeatEvent(seatA!, fileChange(unleased));
  assertEqual(audits().length, 1, "同一 (seatId, path) 30s 内只报一次（F3-7 去重）");

  // 已持约的路径不报（事前 acquire 过的写不算冲突）。
  const leased = join(workspace, "src", "inside.ts");
  assertEqual(manager.claimWritePaths(seatA!, [leased]).ok, true, "该席先拿到写租约");
  access(manager)._onSeatEvent(seatA!, fileChange(leased));
  assertEqual(
    audits().filter((item) => item.text.includes("inside.ts")).length,
    0,
    "持约路径的文件变更不报冲突",
  );
  // 别人持约的路径（B 席）→ 报在 B 身上。
  access(manager)._onSeatEvent(seatB!, fileChange(leased));
  assertEqual(
    audits().filter((item) => item.text.includes("inside.ts")).length,
    1,
    "非持约席在同一路径上的变更报冲突",
  );
  await manager.dispose();
});

// ============================================================================
// 24. F3-8：附件必须进席位上下文（附件-only 不能注入空块）
// ============================================================================

await run("F3-8：附件进入注入正文（附件-only 消息正文非空且含名称与路径）", async () => {
  const fixture = await makeFixture("attachments");
  const { manager } = fixture;
  await manager.createRoundtable({
    topic: "抛材料",
    attachments: [{ path: "docs/opening.md", name: "opening.md", kind: "file" }],
  });
  await settle();
  const [seatA] = seatIds(manager.getState()!);
  const opening = timelineOf(manager).find((item) => item.type === "system" && item.toId === "*");
  assertIncludes(opening?.text ?? "", "[附件] opening.md（docs/opening.md）", "开场简报带附件行（F3-8）");

  const message = await manager.postUserMessage({
    to: seatA!,
    text: "",
    attachments: [{ path: "docs/bench.md", name: "bench.md", kind: "file" }],
  });
  const entry = inboxEntry(manager, seatA!, message.id);
  assert(entry !== undefined && entry.text.trim().length > 0, "附件-only 消息的注入正文非空（F3-8）");
  assertIncludes(entry?.text ?? "", "bench.md", "注入正文含附件名");
  assertIncludes(entry?.text ?? "", "docs/bench.md", "注入正文含附件路径（席位据此 read）");
  assertEqual(message.text, "", "时间线条目正文仍为空（附件挂在 attachments 字段）");
  assertEqual(message.attachments?.length, 1, "时间线条目保留 attachments");
  await manager.dispose();
});

// ============================================================================
// 25. F3-10：request_permission 的幂等与每席配额
// ============================================================================

await run("F3-10：同 (tool,args) 幂等返回同一 requestId；每席 pending 上限 10", async () => {
  const fixture = await makeFixture("permission-quota");
  const { manager } = fixture;
  await manager.createRoundtable({ topic: "权限配额" });
  await settle();
  const [seatA, seatB] = seatIds(manager.getState()!);
  const permissionAttention = (): number =>
    manager.getAttention().filter((item) => item.kind === "permission").length;

  const first = manager.requestPermission(seatA!, "edit", { path: "src/a.ts" }, "需要改动");
  const duplicate = manager.requestPermission(seatA!, "edit", { path: "src/a.ts" }, "需要改动");
  assertEqual(duplicate.requestId, first.requestId, "同席同 (tool,args) 幂等返回同一 requestId（F3-10）");
  assertEqual(permissionAttention(), 1, "重复提交不新增注意力");

  for (let i = 0; i < 9; i++) {
    manager.requestPermission(seatA!, "team_bash", { command: `npm test ${i}` }, "需要跑测试");
  }
  assertEqual(
    access(manager)._modules!.protocol.countPendingPermissions(seatA!),
    MAX_PENDING_PERMISSIONS_PER_SEAT,
    "该席待批请求达到上限 10",
  );
  let capped = "";
  try {
    manager.requestPermission(seatA!, "team_bash", { command: "npm test 10" }, "再来一次");
  } catch (err) {
    capped = err instanceof Error ? err.message : String(err);
  }
  assertIncludes(capped, "上限", "第 11 条被拒（F3-10 配额）");
  assertEqual(permissionAttention(), 10, "被拒的请求不新增注意力");
  assertEqual(
    manager.requestPermission(seatB!, "edit", { path: "src/b.ts" }, "另一个席位").submitted,
    true,
    "配额按席计算：其它席不受影响",
  );
  await manager.dispose();
});

// ============================================================================
// 26. F3-9：无 backend 时 file:// 与裸路径必须同源（策略层与执行层同一 pathKey）
// ============================================================================

await run("F3-9：file:// 与裸路径同源——同一 pathKey、同一条写租约", async () => {
  const fixture = await makeFixture("file-url");
  const { manager, workspace } = fixture;
  await manager.createRoundtable({ topic: "路径归一化" });
  await settle();
  const [seatA, seatB] = seatIds(manager.getState()!);
  await manager.updateSeatAuth(seatA!, "write");
  await manager.updateSeatAuth(seatB!, "write");
  const view = access(manager)._seatExecView();
  const plain = join(workspace, "src", "a.ts");
  const asUrl = pathToFileURL(plain).href;
  assertEqual(view.resolvePath(asUrl), view.resolvePath(plain), "file:// 与裸路径得到同一 pathKey（F3-9 / S5）");
  if (process.platform === "win32") {
    assertEqual(
      view.resolvePath("file:///C:/Windows/win.ini"),
      "C:\\Windows\\win.ini",
      "file:/// 归一成平台绝对路径（与工具侧同串）",
    );
  }
  assertEqual(manager.claimWritePaths(seatA!, [asUrl]).ok, true, "file:// 写法拿到写租约");
  assertEqual(manager.claimWritePaths(seatB!, [plain]).ok, false, "裸路径被同一条租约挡住（同源 pathKey）");
  await manager.dispose();
});

// ============================================================================
// 27. F3-2：重启 replay 只补内存记录，不再落盘、不再发事件
// ============================================================================

await run("F3-2：重启 replay 不重复写 timeline.jsonl、不发 timeline_item", async () => {
  const workspace = makeWorkspace("replay-once");
  const first = await makeFixture("replay-once-1", { context: buildWindowsContext(workspace) });
  const state = await first.manager.createRoundtable({ topic: "重启不重复落盘" });
  await settle();
  await first.manager.postUserMessage({ to: "*", text: "一条消息" });
  await persistenceOf(first.manager).flush();
  await sleep(30);
  const timelinePath = roundtableFilePath(workspace, state.roundtableId, "timeline.jsonl");
  const lines = (): number =>
    readFileSync(timelinePath, "utf-8").split("\n").filter((line) => line.trim().length > 0).length;
  const before = lines();
  assert(before > 0, "时间线已落盘");
  await first.manager.dispose();

  const factory = async (sessionOptions: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
    const isAux = (sessionOptions.customTools ?? []).length === 0;
    return {
      session: isAux ? createAuxFake(AUX_MARKDOWN).session : createSeatFake().session,
    } as unknown as CreateAgentSessionResult;
  };
  const restored = new TeamManager({ sessionFactory: factory as typeof createAgentSession });
  const events: TeamEvent[] = [];
  restored.onEvent((event) => {
    events.push(event);
  });
  await restored.initialize(buildWindowsContext(workspace), AuthStorage.inMemory());
  await settle();

  assertEqual(lines(), before, "replay 不追加 timeline.jsonl（否则每次重启都会翻倍，F3-2 / §4.10）");
  assertEqual(
    events.filter((event) => event.type === "timeline_item").length,
    0,
    "replay 不发 timeline_item 事件（§4.10：replay 只补记录）",
  );
  assertEqual(timelineOf(restored).length, before, "内存时间线条数 = 落盘条数");
  await restored.dispose();
});

// ============================================================================
// 28. F4-2：health 的恢复失败（stopped / 超时）不得报「已恢复」
// ============================================================================

await run("F4-2：recover() 返回 false（stopped）不推 seat_stuck；超时视为未恢复且可重试", async () => {
  const pushed: Array<{ kind: string; seatId?: string }> = [];
  const recovered: string[] = [];
  const health = new RoundtableHealth({
    // 远大于 STUCK_MS 的「现在」：三个探针都处于「超阈值无活动」的卡死判定里。
    now: () => 10_000_000,
    recoverTimeoutMs: 20,
    attention: {
      push: (item) => {
        pushed.push(item);
      },
    },
    onRecovered: (seatId) => {
      recovered.push(seatId);
    },
  });

  let flakyCalls = 0;
  const probes: Array<{ seatId: string; recover: () => Promise<boolean> }> = [
    { seatId: "stopped::rt", recover: async () => false },
    { seatId: "alive::rt", recover: async () => true },
    {
      seatId: "flaky::rt",
      recover: async () => {
        flakyCalls++;
        if (flakyCalls === 1) {
          // 第一次远慢于 recoverTimeoutMs（卡死那类的替身）：旧实现在这里等它 settle，
          // 期间后面的席全被堵住、该席永久留在 recovering。
          await sleep(300);
        }
        return true;
      },
    },
  ];
  for (const probe of probes) {
    health.registerSeat({
      seatId: probe.seatId,
      lastActiveAt: () => 0,
      isRunning: () => true,
      recover: probe.recover,
    });
  }

  const countOf = (seatId: string): number => pushed.filter((item) => item.seatId === seatId).length;
  const startedAt = Date.now();
  await health.checkNow();
  const elapsed = Date.now() - startedAt;
  assertEqual(countOf("stopped::rt"), 0, "recover() === false 时不推 seat_stuck（F4-2：旧实现无条件推）");
  assertEqual(recovered.includes("stopped::rt"), false, "stopped 的席不被标成「已恢复」");
  assertEqual(countOf("alive::rt"), 1, "真恢复的席推一条 seat_stuck");
  assertEqual(recovered.join(","), "alive::rt", "onRecovered 只在 recover() === true 时调用");
  assertEqual(countOf("flaky::rt"), 0, "超时的恢复算未恢复（不推误导性文案）");
  assert(elapsed < 250, `恢复超时在 recoverTimeoutMs 内返回、没有被慢恢复堵住（实际 ${elapsed}ms）`);

  await health.checkNow();
  assertEqual(countOf("flaky::rt"), 1, "超时后 recovering 被清掉：下一轮还能重试（不是永久跳过）");
  assertEqual(recovered.includes("flaky::rt"), true, "第二次真恢复后才调 onRecovered");
});

// ============================================================================
// 29. F4-3：metrics 分子分母同一 population（exited 也计入）
// ============================================================================

await run("F4-3：移除一席后 Σ speakShare 仍为 1，totals.utterances 覆盖全时间线", async () => {
  const fixture = await makeFixture("metrics-population");
  const { manager } = fixture;
  await manager.createRoundtable({ topic: "指标 population" });
  await settle();
  const [seatA, seatB, seatC] = seatIds(manager.getState()!);

  for (const [from, to] of [[seatA!, seatB!], [seatB!, seatC!], [seatC!, seatA!]] as const) {
    await manager.postSeatMessage(from, {
      to,
      text: `来自 ${from} 的发言`,
      type: "utterance",
      utteranceKind: "note",
      mentionIds: [to],
    });
  }
  await settle();

  const utteranceCount = (): number =>
    manager
      .getTimeline()
      .filter((item) => item.fromId !== USER_SEAT_ID && item.type === "utterance").length;
  const shareSum = (): number =>
    Object.values(manager.getMetrics().health.speakShare).reduce((sum, value) => sum + value, 0);

  assertEqual(manager.getMetrics().totals.utterances, utteranceCount(), "totals.utterances = 时间线里席位发言条数");
  assert(Math.abs(shareSum() - 1) < 1e-9, `移除前 Σ speakShare = 1（实际 ${shareSum()}）`);

  // 退出席位的消耗也要留下（F4-3）：dispose 之后 session 查不到，用量必须已经在退场时记下。
  const costBefore = manager.getMetrics().totals.cost;
  const seatCostBefore = manager.getMetrics().perSeat[seatC!]?.cost ?? 0;
  assert(seatCostBefore > 0, `移除前该席有真实消耗（实际 ${seatCostBefore}）`);

  await manager.removeSeat(seatC!, "self");
  await settle();
  assertEqual(
    manager.getMetrics().totals.utterances,
    utteranceCount(),
    "移除一席后 totals.utterances 仍覆盖全时间线（分母含 exited，F4-3）",
  );
  assert(Math.abs(shareSum() - 1) < 1e-9, `移除一席后 Σ speakShare 仍为 1（实际 ${shareSum()}）`);
  assert(manager.getMetrics().perSeat[seatC!] !== undefined, "退出席位仍在 perSeat 里（渲染层据此标注「已退出」）");
  assertEqual(
    manager.getMetrics().perSeat[seatC!]?.cost,
    seatCostBefore,
    "退出席位保留已产生的成本（dispose 不把消耗归零，F4-3）",
  );
  assertEqual(manager.getMetrics().totals.cost, costBefore, "移除席位后 totals.cost 不回退（花掉的钱不能凭空消失）");
  assertEqual(
    Object.values(manager.getMetrics().health.speakShare).some((value) => value > 1),
    false,
    "没有席位占比 >1（旧口径下退出席位的发言仍在分子里）",
  );
  await manager.dispose();
});

// ============================================================================
// 30. F4-4：阈值口径 = 累计活跃时长（不是墙钟）
// ============================================================================

function metricsSettings(overrides: Partial<RoundtableSettings> = {}): RoundtableSettings {
  return {
    orderedMode: false,
    waitForUserQuestions: false,
    autoContinueAfterCrash: false,
    unattendedGuard: false,
    suggestWrapUp: false,
    orderedReleaseMs: ORDERED_RELEASE_MS,
    exitRequestTimeoutMs: EXIT_REQUEST_TIMEOUT_MS,
    l2: { ...DEFAULT_L2_BUDGET },
    ...overrides,
  };
}

await run("F4-4：时间类阈值用累计活跃时长；暂停 / 恢复瞬间不误触发 hard_stop", async () => {
  const HARD_STOP = { enabled: true, maxDurationMs: 30 * 60_000, allowWrapUpOnStop: false };
  const makeMetrics = (lifecycle: RoundtableState["lifecycle"], activeMs: number): {
    metrics: RoundtableMetrics;
    raised: string[];
    hardStops: () => number;
  } => {
    const raised: string[] = [];
    let hardStops = 0;
    const metrics = new RoundtableMetrics({
      getSeats: () => [
        {
          seatId: "sources::rt",
          getSessionStats: () => ({
            tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
            cost: 0.01,
          }),
          durationMs: () => activeMs,
        },
      ],
      getTimeline: () => [],
      getSettings: () => metricsSettings({ hardStop: HARD_STOP }),
      getLifecycle: () => lifecycle,
      // 墙钟：1 小时前建场（含暂停），旧口径用 now - createdAt 判阈值。
      getCreatedAt: () => Date.now() - 60 * 60_000,
      attention: {
        push: (item) => {
          raised.push(item.kind);
        },
      },
      onHardStop: () => {
        hardStops++;
      },
    });
    return { metrics, raised, hardStops: () => hardStops };
  };

  const paused = makeMetrics("paused", 0);
  paused.metrics.evaluate();
  assertEqual(paused.hardStops(), 0, "暂停时墙钟超阈值也不 hard_stop（F4-4：暂停不判时间类阈值）");
  assertEqual(paused.raised.length, 0, "暂停时不推时间类注意力");

  const resumed = makeMetrics("active", 0);
  resumed.metrics.evaluate();
  assertEqual(resumed.hardStops(), 0, "恢复瞬间（墙钟 1 小时、累计活跃 0）不 hard_stop");
  assertEqual(
    resumed.raised.includes("hard_stop"),
    false,
    "一次性 hardStopFired 闩锁没有被消耗（旧口径会在这里点火）",
  );

  const over = makeMetrics("active", 31 * 60_000);
  over.metrics.evaluate();
  assertEqual(over.hardStops(), 1, "累计活跃超过阈值才 hard_stop");
  assertEqual(over.raised.includes("hard_stop"), true, "hard_stop 注意力同时发出");
});

// ============================================================================
// 31. F4-5：facade 把 acked 写进快照、恢复后逐条 ack
// ============================================================================

await run("F4-5：注意力 ack 状态跨重启保持（已处理的权限卡不复活）", async () => {
  const workspace = makeWorkspace("attention-acks");
  const first = await makeFixture("attention-acks-1", { context: buildWindowsContext(workspace) });
  await first.manager.createRoundtable({ topic: "ack 恢复" });
  await settle();
  const [seatA] = seatIds(first.manager.getState()!);
  const permission = first.manager.requestPermission(seatA!, "edit", { path: "src/a.ts" }, "需要改动");
  const target = first.manager
    .getAttention()
    .find((item) => item.refId === permission.requestId);
  assert(target !== undefined, "权限请求进了注意力面");

  first.manager.ackAttention(target!.id);
  assertEqual(
    first.manager.getAttention().find((item) => item.id === target!.id)?.acked,
    true,
    "ack 之后内存里是已确认",
  );
  await persistenceOf(first.manager).flush();
  await sleep(30);
  await first.manager.dispose();

  const factory = async (sessionOptions: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
    const isAux = (sessionOptions.customTools ?? []).length === 0;
    return {
      session: isAux ? createAuxFake(AUX_MARKDOWN).session : createSeatFake().session,
    } as unknown as CreateAgentSessionResult;
  };
  const restored = new TeamManager({ sessionFactory: factory as typeof createAgentSession });
  await restored.initialize(buildWindowsContext(workspace), AuthStorage.inMemory());
  await settle();

  const restoredItem = restored.getAttention().find((item) => item.id === target!.id);
  assert(restoredItem !== undefined, "注意力条目从 attention.jsonl replay 回来");
  assertEqual(restoredItem?.acked, true, "已确认状态跨重启保持（F4-5：旧实现在这里复活成未处理）");
  assertEqual(
    restored.getAttention().filter((item) => item.acked === false && item.kind === "permission").length,
    0,
    "没有复活成可点却已失效的权限卡",
  );
  await restored.dispose();
});

// ============================================================================
// 32. F4-8：导出不重放已静音线程的正文
// ============================================================================
await run("F4-8：静音线程只留计数行，不重放正文", async () => {
  const fixture = await makeFixture("export-muted-thread");
  const { manager } = fixture;
  await manager.createRoundtable({ topic: "静音导出" });
  await settle();
  const [seatA, seatB] = seatIds(manager.getState()!);

  await manager.postSeatMessage(seatA!, {
    to: seatB!,
    text: "静音线程里的独有正文片段 ZZZ-ONLY-IN-THREAD",
    type: "utterance",
    utteranceKind: "note",
    threadId: "th-muted",
    mentionIds: [seatB!],
  });
  await manager.postSeatMessage(seatB!, {
    to: seatA!,
    text: "未静音线程的正文",
    type: "utterance",
    utteranceKind: "note",
    threadId: "th-open",
    mentionIds: [seatA!],
  });
  await settle();

  const beforeMute = await manager.exportMarkdown();
  assertIncludes(beforeMute, "ZZZ-ONLY-IN-THREAD", "静音前正文在导出里");

  manager.muteThread("th-muted", true);
  const afterMute = await manager.exportMarkdown();
  assertEqual(
    afterMute.includes("ZZZ-ONLY-IN-THREAD"),
    false,
    "静音线程的正文不再重放（F4-8：与「静音 = 折叠成计数」的契约一致）",
  );
  assertIncludes(afterMute, "已静音的线程（正文未展开）", "静音线程保留计数行");
  assertIncludes(afterMute, "th-muted：1 条", "计数行带条数");
  assertIncludes(afterMute, "未静音线程的正文", "未静音线程照常展开");
  await manager.dispose();
});

// ============================================================================
// 33. F4-7：损坏的记录让 hydrate 报错，而不是静默按空集合恢复
// ============================================================================

await run("F4-7：记录损坏时 hydrate 不静默降级成空场", async () => {
  const workspace = makeWorkspace("corrupt-hydrate");
  const first = await makeFixture("corrupt-hydrate-1", { context: buildWindowsContext(workspace) });
  const state = await first.manager.createRoundtable({ topic: "损坏恢复" });
  await settle();
  await first.manager.postUserMessage({ to: "*", text: "一条消息" });
  await persistenceOf(first.manager).flush();
  await sleep(30);
  await first.manager.dispose();

  const inboxPath = roundtableFilePath(workspace, state.roundtableId, "inbox.json");
  const corrupted = "{ 这不是 JSON";
  writeFileSync(inboxPath, corrupted, "utf-8");

  const factory = async (sessionOptions: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
    const isAux = (sessionOptions.customTools ?? []).length === 0;
    return {
      session: isAux ? createAuxFake(AUX_MARKDOWN).session : createSeatFake().session,
    } as unknown as CreateAgentSessionResult;
  };
  const restored = new TeamManager({ sessionFactory: factory as typeof createAgentSession });
  const hydrateEvents = collectEvents(restored);
  await restored.initialize(buildWindowsContext(workspace), AuthStorage.inMemory());
  await settle();

  assertEqual(restored.getState(), null, "损坏的记录不恢复成空场（F4-7：旧实现给一份空收件箱的假场）");
  assertEqual(restored.hasActiveTeam(), false, "没有活跃场");
  assertEqual(readFileSync(inboxPath, "utf-8"), corrupted, "损坏文件保持原样（用户仍可手工抢救）");
  assertEqual(
    restored.getAttention().some((item) => item.text.includes("圆桌记录损坏")),
    false,
    "此刻还没有注意力面：不产生一条无从显示的孤儿条目",
  );
  assert(
    hydrateEvents.some((event) => event.type === "record_corrupt_notice"),
    "hydrate 立刻发出 record_corrupt_notice（渲染层不必等下一场圆桌）",
  );

  // G10 收尾：F4-7 的可见性闭环。恢复路径上 AttentionBus 还不存在（上面 _modules === null），
  // 旧实现只 console.error —— Electron 主进程的 console 不进 UI，用户完全看不到「记录损坏」
  // （H36 私密正文的唯一载体就在 inbox.json 里）。暂存后必须在本工作区下一场圆桌里补发。
  const other = makeWorkspace("corrupt-hydrate-b");
  await restored.initialize(buildWindowsContext(other), AuthStorage.inMemory());
  await settle();
  await restored.createRoundtable({ topic: "另一个工作区的新场" });
  await settle();
  assertEqual(
    restored.getAttention().some((item) => item.text.includes("圆桌记录损坏")),
    false,
    "暂存按工作区隔离：别的工作区建场不补发（否则提示会指错记录）",
  );

  await restored.initialize(buildWindowsContext(workspace), AuthStorage.inMemory());
  await settle();
  await restored.createRoundtable({ topic: "损坏后的新场" });
  await settle();
  assert(
    restored.getAttention().some((item) => item.text.includes("圆桌记录损坏")),
    "回到损坏的工作区建场后补发损坏提示（旧实现只有 console.error，App 内不可见）",
  );
  assertEqual(
    restored.getAttention().filter((item) => item.text.includes("圆桌记录损坏")).length,
    1,
    "同一工作区反复 initialize 只补发一条（上面 initialize 过两次）",
  );
  await restored.dispose();
});

// ============================================================================
// 34. G10 收尾：换工作区不留上一场的僵尸 state（F3-3 的收尾）
// ============================================================================

await run("G10：initialize 到没有圆桌的工作区不留上一场的 state", async () => {
  const fixture = await makeFixture("switch-workspace");
  const state = await fixture.manager.createRoundtable({ topic: "换工作区前的一场" });
  await settle();
  // 先 flush，保证第二次 initialize 走的是「本工作区没有可恢复的场」分支，
  // 而不是残留的合并窗口。
  await persistenceOf(fixture.manager).flush();
  await fixture.manager.pause();

  // 真实链路（start-team-runtime）：切到另一个工作区 = 同一个实例再 initialize。
  const other = makeWorkspace("switch-workspace-b");
  await fixture.manager.initialize(buildWindowsContext(other), AuthStorage.inMemory());
  await settle();

  assert(state.roundtableId.length > 0, "换场前确有上一场");
  assertEqual(access(fixture.manager)._state, null, "换到无场工作区后 _state 不再指向上一场");
  assertEqual(fixture.manager.getState(), null, "getState() 为 null（旧实现返回上一场的 roundtableId）");
  assertEqual(fixture.manager.hasActiveTeam(), false, "hasActiveTeam() 为假（旧实现仍为 true）");
  await fixture.manager.dispose();
});

// ============================================================================
// Summary + 清理
// ============================================================================

for (const dir of WORKSPACES) {
  rmSync(dir, { recursive: true, force: true });
}
rmSync(AGENT_DIR, { recursive: true, force: true });

console.log("\n=== Summary ===\n");
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
