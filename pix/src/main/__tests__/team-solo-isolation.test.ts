/**
 * S8 solo 隔离门禁（plan §1.4 原则 1-2 / §7.2 / H22 / H24 / AC-S1–S3）。
 *
 * 证明圆桌改动没有挪动任何 solo 不变量：
 *   - AGENT_TASK_DEFAULT_RUNNING_SLOTS=4、DEFAULT_MAX_TURNS=150（含
 *     agent-task-runtime / agent-task-service 的再导出）、
 *     DEFAULT_COALESCE_INTERVAL_MS=50
 *   - 席位 session 永不收到 setModel / setSteeringMode / setExecutionMode
 *     调用（H22/H24）；降档只写 `agent.state.model` +
 *     `sessionManager.appendModelChange(provider, id)` 两个位置参数
 *   - Team 持久化不写 solo 的 agent-task 存储根
 *   - TeamCapacityPool 与 AgentTaskScheduler 是彼此独立的对象图（无 import 边）
 *
 * 行为面：席位 fake 带三个 setter spy，整条席位生命周期（建场 / L1 / L2 / 暂停
 * 恢复 / 降档 / stop+dispose）跑完后断言 spy 零调用，降档只认赋值路径；solo
 * 调度器与 Team 池各自跑一遍并发。结构面只有一条——"没有 import 边"本身是结构
 * 性质，用 team/ 与 team-manager.ts 的 import 说明符证明。
 *
 * Run with: npx tsx pix/src/main/__tests__/team-solo-isolation.test.ts
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthStorage,
  createAgentSession,
  type AgentSession,
  type AgentSessionEvent as SdkAgentSessionEvent,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  AGENT_TASK_DEFAULT_RUNNING_SLOTS,
  DEFAULT_MAX_TURNS,
} from "../../shared/agent-task-types.js";
import type { AgentSessionEvent } from "../../shared/types.js";
import type { SeatConfig } from "../../shared/team-types.js";
import { workspaceIdOf } from "../agent-task/agent-task-identity.js";
import { DEFAULT_MAX_TURNS as RUNTIME_DEFAULT_MAX_TURNS } from "../agent-task/agent-task-runtime.js";
import { AgentTaskScheduler } from "../agent-task/agent-task-scheduler.js";
import { DEFAULT_MAX_TURNS as SERVICE_DEFAULT_MAX_TURNS } from "../agent-task/agent-task-service.js";
import {
  AGENT_TASK_DEFAULT_MAX_TASK_BYTES,
  AGENT_TASK_DEFAULT_MAX_WORKSPACE_BYTES,
  AgentTaskStore,
} from "../agent-task/agent-task-store.js";
import type { ProjectExecutionContext } from "../execution-context.js";
import { DEFAULT_COALESCE_INTERVAL_MS, MessageUpdateCoalescer } from "../message-update-coalescer.js";
import { TeamManager } from "../team-manager.js";
import { TeamCapacityPool } from "../team/capacity-pool.js";
import { defaultSeatConfigs } from "../team/roster.js";
import {
  MAX_AUX_SLOTS,
  MAX_SEAT_SLOTS,
  roundtableDir,
  roundtableSessionsDir,
  roundtablesDir,
  roundtablePresetsPath,
} from "../team/constants.js";

// ============================================================================
// Harness（与 execution-context / team-manager 同一风格）
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

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${name} ===\n`);
  try {
    await fn();
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name} threw unexpectedly: ${String(err)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** 让 facade / runner 的 fire-and-forget 链跑完。 */
async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** 轮询到条件成立（或超时），返回耗时 ms。 */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<number> {
  const startedAt = Date.now();
  while (!predicate() && Date.now() - startedAt < timeoutMs) {
    await sleep(5);
  }
  return Date.now() - startedAt;
}

// ============================================================================
// 隔离：agent 目录 + 工作区（绝不碰真实用户 profile）
// ============================================================================

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pix-team-solo-isolation-agent-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const WORKSPACES: string[] = [];

function makeWorkspace(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pix-team-solo-isolation-${name}-`));
  WORKSPACES.push(dir);
  return dir;
}

/** solo agent-task 存储根：与 `pix/src/main/index.ts` 里 AgentTaskService 的 rootDir 同一表达式。 */
function soloAgentTaskRoot(): string {
  return join(getAgentDir(), "agent-tasks");
}

/** 递归列出某目录下的相对路径（用于检查有没有写到 solo 的根下面）。 */
function listRelativePaths(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      out.push(rel);
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel);
      }
    }
  };
  walk(root, "");
  return out;
}

/** import 说明符（只用于证明"没有 import 边"这一结构断言）。 */
function importSpecifiersOf(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map((match) => match[1]!);
}

// ============================================================================
// 带 spy 的席位 fake（无 runtimeCwd：H34 的会话面根本没有它）
// ============================================================================

const SPY_MODEL = { id: "fake-model", provider: "fake", contextWindow: 200_000 };
const CHEAP_MODEL = { id: "xs-cheap", provider: "faux-expensive", contextWindow: 128_000 };

interface SpySeat {
  session: AgentSession;
  agent: { steeringMode: "all" | "one-at-a-time" };
  state: { model?: { id: string; provider: string; contextWindow: number }; isStreaming: boolean };
  /** AgentSession.setModel —— 会 setDefaultModelAndProvider + save()（H24 禁止）。 */
  setModelCalls: unknown[][];
  /** AgentSession.setSteeringMode —— 会写全局 settings（H22 禁止）。 */
  setSteeringModeCalls: unknown[][];
  /** SettingsManager.setExecutionMode —— 会写全局 settings（§1.4 原则 2 禁止）。 */
  setExecutionModeCalls: unknown[][];
  /** appendModelChange 的实参原样记录（用来验证两个位置参数）。 */
  modelChanges: Array<{ args: unknown[] }>;
  /** 席位 session 的 SettingsManager 上被调用过的方法名（应该一个都没有）。 */
  settingsCalls: string[];
  prompts: string[];
  customMessages: number;
  disposed: number;
}

/**
 * 席位 fake。prompt 立刻 resolve 但 `isStreaming` 保持 true（模拟"这个 run 一直在
 * 跑"），于是 L1 走 steer、L2 走 abort 后重开，整条执行面都被走到。
 *
 * 三个 setter 是 spy：真实 `AgentSession` 的 `setModel` / `setSteeringMode`，以及
 * 真实 `session.settingsManager.setExecutionMode`（§1.4 原则 2 点名的那个）；同时
 * 也在 session 自身上放一份 `setExecutionMode`，任何一条路径调用都会记录。
 */
function createSpySeat(): SpySeat {
  let customMessages = 0;
  let disposed = 0;
  const setModelCalls: unknown[][] = [];
  const setSteeringModeCalls: unknown[][] = [];
  const setExecutionModeCalls: unknown[][] = [];
  const modelChanges: Array<{ args: unknown[] }> = [];
  const prompts: string[] = [];
  const subscribers = new Set<(event: AgentSessionEvent) => void>();
  const state = {
    isStreaming: false,
    model: { ...SPY_MODEL } as { id: string; provider: string; contextWindow: number } | undefined,
    streamingMessage: undefined as { content: Array<{ type: string; text?: string }> } | undefined,
    pendingToolCalls: new Set<string>(),
  };
  // agent 与 state 必须是 session 上那个同一个对象：H22 观察的就是它的字段。
  const agent = {
    steeringMode: "one-at-a-time" as "all" | "one-at-a-time",
    waitForIdle: async (): Promise<void> => undefined,
    state,
  };
  // SettingsManager 面：真实 AgentSession 的 session.settingsManager 暴露
  // setExecutionMode（§1.4 原则 2 点名的那条污染路径）。除了给它一份具名 spy，
  // 再用 Proxy 记录"Team 碰过 SettingsManager 的任何方法"——席位策略只允许走
  // hostToolPolicyOverride，一次都不该写全局 settings。
  const settingsCalls: string[] = [];
  const settingsManagerTarget: Record<string, unknown> = {
    setExecutionMode: (...args: unknown[]): void => {
      setExecutionModeCalls.push(args);
    },
  };
  const settingsManager = new Proxy(settingsManagerTarget, {
    get: (target, prop) => {
      if (typeof prop !== "string") {
        return undefined;
      }
      const value = target[prop];
      return (...args: unknown[]): unknown => {
        settingsCalls.push(prop);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown)(...args) : undefined;
      };
    },
  });
  const base = {
    prompt: async (text: string): Promise<void> => {
      prompts.push(text);
      state.isStreaming = true;
      for (const subscriber of [...subscribers]) {
        subscriber({ type: "agent_start" } as AgentSessionEvent);
      }
    },
    abort: async (): Promise<void> => {
      state.isStreaming = false;
      state.streamingMessage = undefined;
      for (const subscriber of [...subscribers]) {
        subscriber({ type: "agent_end", messages: [] } as unknown as AgentSessionEvent);
      }
    },
    abortCompaction: (): void => undefined,
    clearQueue: (): { steering: string[]; followUp: string[] } => ({ steering: [], followUp: [] }),
    sendCustomMessage: async (): Promise<unknown> => {
      customMessages += 1;
      return undefined;
    },
    subscribe: (fn: (event: AgentSessionEvent) => void): (() => void) => {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    getSessionStats: () => ({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
    }),
    model: { ...SPY_MODEL },
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === CHEAP_MODEL.provider && id === CHEAP_MODEL.id ? { ...CHEAP_MODEL } : undefined,
      getAvailable: () => [{ ...CHEAP_MODEL }],
    },
    sessionManager: {
      appendModelChange: (provider: string, modelId: string): string => {
        modelChanges.push({ args: [provider, modelId] });
        return "model-change";
      },
    },
    settingsManager,
    dispose: async (): Promise<void> => {
      disposed += 1;
    },
    getLastAssistantText: (): string | undefined => undefined,
  };
  // 三个 setter spy：真实 AgentSession 面 + settingsManager 面各来一份。
  const session = {
    ...base,
    agent,
    setModel: (...args: unknown[]): Promise<void> => {
      setModelCalls.push(args);
      return Promise.resolve();
    },
    setSteeringMode: (...args: unknown[]): void => {
      setSteeringModeCalls.push(args);
    },
    setExecutionMode: (...args: unknown[]): void => {
      setExecutionModeCalls.push(args);
    },
  };
  return {
    session: session as unknown as AgentSession,
    agent,
    state,
    setModelCalls,
    setSteeringModeCalls,
    setExecutionModeCalls,
    modelChanges,
    settingsCalls,
    prompts,
    get customMessages() {
      return customMessages;
    },
    get disposed() {
      return disposed;
    },
  };
}

// ============================================================================
// Manager fixture
// ============================================================================

function makeContext(physicalCwd: string): ProjectExecutionContext {
  return {
    location: { path: physicalCwd, physicalPath: physicalCwd, name: "solo-iso", environment: { kind: "windows" } },
    logicalCwd: physicalCwd,
    physicalCwd,
    isWsl: false,
  };
}

interface ManagerFixture {
  manager: TeamManager;
  workspace: string;
  seats: SpySeat[];
  roundtableId: string;
  sessionOptions: CreateAgentSessionOptions[];
}

/**
 * 席位配置：紧凑档 3 席（MIN_SEATS，只读授权，注册表内置模板视角）。
 * 第一席带显式 `model`，让 H24 的第二个现场（建场时按席位配置落模型）也走到。
 */
function seatConfigs(): SeatConfig[] {
  const configs = defaultSeatConfigs("compact");
  configs[0]!.model = CHEAPER_MODEL_SPEC;
  return configs;
}

const CHEAPER_MODEL_SPEC = "faux-expensive/xs-cheap";

async function makeFixture(name: string): Promise<ManagerFixture> {
  const workspace = makeWorkspace(name);
  const seats: SpySeat[] = [];
  const sessionOptions: CreateAgentSessionOptions[] = [];
  const factory = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
    sessionOptions.push(options);
    const spy = createSpySeat();
    seats.push(spy);
    return { session: spy.session } as unknown as CreateAgentSessionResult;
  };
  const manager = new TeamManager({ sessionFactory: factory as typeof createAgentSession });
  await manager.initialize(makeContext(workspace), AuthStorage.inMemory());
  const state = await manager.createRoundtable({
    topic: "评估 solo 隔离门禁",
    seats: seatConfigs(),
    settings: { cheaperModel: CHEAPER_MODEL_SPEC },
  });
  await settle();
  return { manager, workspace, seats, roundtableId: state.roundtableId, sessionOptions };
}

function totalSpyCalls(seats: SpySeat[]): number {
  return seats.reduce(
    (sum, seat) =>
      sum + seat.setModelCalls.length + seat.setSteeringModeCalls.length + seat.setExecutionModeCalls.length,
    0,
  );
}

// ============================================================================
// 1. solo 常量（AC-S1）
// ============================================================================

await run("solo 常量：槽位 / turn 上限 / 合并窗口", async () => {
  assertEqual(AGENT_TASK_DEFAULT_RUNNING_SLOTS, 4, "AGENT_TASK_DEFAULT_RUNNING_SLOTS === 4");
  assertEqual(DEFAULT_MAX_TURNS, 150, "DEFAULT_MAX_TURNS === 150");
  // 两处再导出必须仍是同一个值（solo 的 turn 上限只有一个来源）。
  assertEqual(RUNTIME_DEFAULT_MAX_TURNS, 150, "agent-task-runtime 再导出的 DEFAULT_MAX_TURNS === 150");
  assertEqual(SERVICE_DEFAULT_MAX_TURNS, 150, "agent-task-service 再导出的 DEFAULT_MAX_TURNS === 150");
  assertEqual(DEFAULT_COALESCE_INTERVAL_MS, 50, "DEFAULT_COALESCE_INTERVAL_MS === 50");

  // 行为面：默认构造的合并器用 50ms 窗口（不是"无窗口"，也不是大窗口）。
  // 合并器吃的是 SDK 的 AgentSessionEvent（与 shared/types 的同名类型分属两套
  // AgentMessage 定义，见 team-manager.ts 的 SdkSessionEvent 注释）。
  const seen: SdkAgentSessionEvent[] = [];
  const coalescer = new MessageUpdateCoalescer((event) => {
    seen.push(event);
  });
  const delta = {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "x" },
  } as unknown as SdkAgentSessionEvent;
  coalescer.push(delta);
  assertEqual(seen.length, 0, "默认窗口：text_delta 不会同步发出");
  const elapsed = await waitUntil(() => seen.length > 0, 2_000);
  assertEqual(seen.length, 1, "默认窗口：窗口到期后合并发出一次");
  assert(
    elapsed >= DEFAULT_COALESCE_INTERVAL_MS - 5 && elapsed <= 1_000,
    `默认合并窗口就是 DEFAULT_COALESCE_INTERVAL_MS（实测 ${elapsed}ms）`,
  );
  coalescer.dispose();
});

// ============================================================================
// 2. 三个 setter 从未被调用 + 降档走赋值路径（H22 / H24 / §1.4 原则 2）
// ============================================================================

await run("席位 session 全程不调用 setModel / setSteeringMode / setExecutionMode", async () => {
  const fixture = await makeFixture("spies");
  const { manager, seats } = fixture;

  assertEqual(seats.length, 3, "紧凑档 3 席各拿到一个 fake session");
  assertEqual(totalSpyCalls(seats), 0, "建场（session 创建 + 首轮 prompt）后三个 spy 都是 0 次");
  // 席位配置里的显式 model：同样只走赋值 + appendModelChange（H24 的第二个现场）。
  assertEqual(seats[0]!.state.model?.id, CHEAP_MODEL.id, "建场时席位显式模型被赋值给 agent.state.model");
  assertEqual(seats[0]!.modelChanges.length, 1, "建场时席位显式模型走 appendModelChange");
  assertEqual(seats[0]!.modelChanges[0]!.args.length, 2, "建场时 appendModelChange 也是两个位置参数");

  // 席位创建入参：不开增强工具、带 hostToolPolicyOverride（§1.4 原则 2 的正路）。
  const options = fixture.sessionOptions[0]!;
  assertEqual(options.enableBuiltInEnhancementTools, false, "席位 enableBuiltInEnhancementTools === false（H29）");
  assert(options.hostToolPolicyOverride !== undefined, "席位用 hostToolPolicyOverride 表达只读，而不是执行模式");
  assert(options.tools?.includes("read") === true, "席位 tools 白名单含只读四工具之一（H35）");

  // 席位 session 就是带 spy 的那个对象（spy 确实坐在被驱动的实例上）。
  const live = manager as unknown as { _sessions: Map<string, AgentSession> };
  const liveSessions = [...live._sessions.values()];
  assertEqual(liveSessions.length, 3, "facade 持有三个席位 session");
  assert(
    liveSessions.every((session) => seats.some((seat) => seat.session === session)),
    "facade 驱动的 session 与 spy 是同一个对象",
  );

  // 执行面走一遍：L1 steer、唤醒、L2 abort 后重开、暂停、恢复。
  await manager.postUserMessage({ to: "*", text: "先各自给一条依据。", interrupt: "L1" });
  await settle();
  assert(seats.some((seat) => seat.customMessages > 0), "L1 走 sendCustomMessage(steer) 注入");
  assertEqual(totalSpyCalls(seats), 0, "L1 打断后三个 spy 仍是 0 次");

  await manager.wakeSeat(Object.keys(manager.getState()!.seats)[0]!);
  await settle();
  assertEqual(totalSpyCalls(seats), 0, "wakeSeat 后三个 spy 仍是 0 次");

  await manager.postUserMessage({ to: "*", text: "停一下再继续。", interrupt: "L2" });
  await settle();
  const promptsBefore = seats.reduce((sum, seat) => sum + seat.prompts.length, 0);
  assert(promptsBefore >= 2, "L2 后席位重开新一轮（abort + 带收件箱 prompt）");
  assertEqual(totalSpyCalls(seats), 0, "L2 打断（abort + 重开）后三个 spy 仍是 0 次");

  await manager.pause();
  await settle();
  manager.resume("solo 隔离门禁测试");
  await settle();
  assertEqual(totalSpyCalls(seats), 0, "pause（L3）/ resume 后三个 spy 仍是 0 次");

  // H22：steeringMode 只写内存字段（不是调 setSteeringMode）。
  assertEqual(
    seats.every((seat) => seat.agent.steeringMode === "all"),
    true,
    "steeringMode 被赋值成 \"all\"（内存字段，H22）",
  );

  // H24 降档续跑：赋值 agent.state.model + appendModelChange(provider, id)。
  await manager.downgradeModels(CHEAPER_MODEL_SPEC);
  await settle();
  assertEqual(totalSpyCalls(seats), 0, "降档后三个 spy 仍是 0 次");
  assertEqual(
    seats.every((seat) => seat.state.model?.id === CHEAP_MODEL.id && seat.state.model?.provider === CHEAP_MODEL.provider),
    true,
    "降档改的是 session.agent.state.model",
  );
  assertEqual(
    seats.every((seat) => seat.modelChanges.length >= 1),
    true,
    "降档每席都调了 sessionManager.appendModelChange",
  );
  assertEqual(seats[0]!.modelChanges.length, 2, "带显式模型的那席：建场 1 次 + 降档 1 次");
  assertEqual(
    seats.slice(1).every((seat) => seat.modelChanges.length === 1),
    true,
    "其余席只被降档改过 1 次",
  );
  assertEqual(
    seats.every((seat) => seat.modelChanges.every((change) => change.args.length === 2)),
    true,
    "appendModelChange 每次都是恰好两个位置参数",
  );
  assertEqual(
    seats.every((seat) =>
      seat.modelChanges.every(
        (change) => change.args[0] === CHEAP_MODEL.provider && change.args[1] === CHEAP_MODEL.id,
      ),
    ),
    true,
    "appendModelChange(provider, id) 实参正确",
  );
  assertEqual(
    Object.values(manager.getState()!.seats).every((seat) => seat.model === CHEAPER_MODEL_SPEC),
    true,
    "名册同步记录降档后的模型名",
  );

  // 控制组：spy 是活的（直接在同一个对象上调用会被记录），所以上面的 0 次不是假象。
  await seats[0]!.session.setModel(CHEAP_MODEL as never);
  assertEqual(seats[0]!.setModelCalls.length, 1, "控制组：直接调用 setModel 会被 spy 记录");
  seats[0]!.setModelCalls.length = 0;

  await manager.stop({ wrapUp: false });
  await settle();
  await manager.dispose();
  await settle();
  assertEqual(totalSpyCalls(seats), 0, "stop + dispose 后三个 spy 仍是 0 次");
  assert(seats.every((seat) => seat.disposed > 0), "席位 session 被正常 dispose");

  // §1.4 原则 2：席位只读走 hostToolPolicyOverride，绝不写全局 settings。
  assertEqual(
    seats.reduce((sum, seat) => sum + seat.settingsCalls.length, 0),
    0,
    "Team 代码一次都没碰过席位 session 的 SettingsManager",
  );
  seats[0]!.session.settingsManager.setExecutionMode("read-only");
  assertEqual(seats[0]!.settingsCalls[0], "setExecutionMode", "控制组：SettingsManager 上的调用会被记录");
  assertEqual(seats[0]!.setExecutionModeCalls.length, 1, "控制组：setExecutionMode 具名 spy 同时记录");
});

// ============================================================================
// 3. Team 持久化不写 solo 的 agent-task 存储根（AC-S3）
// ============================================================================

await run("Team 持久化只写 roundtables/ 与 roundtable-sessions/，不碰 agent-tasks/", async () => {
  const fixture = await makeFixture("storage");
  const { manager, workspace, roundtableId } = fixture;

  await manager.postUserMessage({ to: "*", text: "写点东西让持久化真的落盘。" });
  await settle();
  await manager.exportMarkdown();
  const persistence = (manager as unknown as { _modules: { persistence: { flush(): Promise<void> } } })._modules
    .persistence;
  await persistence.flush();

  const soloRoot = soloAgentTaskRoot();
  const teamRoot = roundtablesDir(workspace);
  const teamSessionRoot = roundtableSessionsDir(roundtableId);

  assertEqual(existsSync(join(roundtableDir(workspace, roundtableId), "meta.json")), true, "Team 确实落盘了（负向断言非空转）");
  assertEqual(existsSync(join(teamSessionRoot)), true, "Team 的席位 session 目录在 roundtable-sessions/ 下");
  assertEqual(existsSync(soloRoot), false, "agent-tasks/ 存储根根本没有被创建");

  // 同一套 id 命名空间（sha1(physicalCwd)），不同根：两边不交叉。
  const workspaceId = workspaceIdOf(workspace);
  assertEqual(workspaceId, createHash("sha1").update(workspace).digest("hex"), "solo 与 Team 用同一个工作区 id 算法");
  assertEqual(existsSync(join(soloRoot, workspaceId)), false, "solo 侧的工作区目录不存在");

  // 用真实 AgentTaskStore 读 solo 根：没有任何工作区，索引也读不到。
  const soloStore = new AgentTaskStore({
    rootDir: soloRoot,
    maxTaskBytes: AGENT_TASK_DEFAULT_MAX_TASK_BYTES,
    maxWorkspaceBytes: AGENT_TASK_DEFAULT_MAX_WORKSPACE_BYTES,
  });
  const soloWorkspaces = await soloStore.listWorkspaces();
  assertEqual(soloWorkspaces.length, 0, "solo AgentTaskStore.listWorkspaces() 为空");
  assertEqual(await soloStore.readIndex(workspaceId), null, "solo 侧同一工作区 id 没有索引");
  assertEqual(await soloStore.readIndex(roundtableId), null, "roundtableId 不作为 solo 工作区出现");

  // 整个 agent 目录里没有任何 agent-tasks 路径段。
  const agentPaths = listRelativePaths(getAgentDir());
  assert(agentPaths.length > 0, "agent 目录里有 Team 写下的内容");
  assert(
    agentPaths.every((rel) => !rel.split("/").includes("agent-tasks")),
    "agent 目录下没有任何 agent-tasks 路径段",
  );
  assert(
    agentPaths.some((rel) => rel.startsWith("roundtables/")),
    "Team 的落盘都在 roundtables/ 下",
  );

  // Team 的三条路径都在 solo 根之外。
  const teamPaths = [teamRoot, teamSessionRoot, roundtablePresetsPath()];
  assert(
    teamPaths.every((path) => path !== soloRoot && !path.startsWith(`${soloRoot}\\`) && !path.startsWith(`${soloRoot}/`)),
    "Team 的持久化根（含预设）都在 agent-tasks/ 之外",
  );

  await manager.dispose();
  await settle();
});

// ============================================================================
// 4. TeamCapacityPool 与 AgentTaskScheduler 独立（§2.1 / §4.8 / AC-S3）
// ============================================================================

await run("Team 容量池与 agent-task 调度器互不影响", async () => {
  // 行为面：solo 调度器的默认档与占用不受 Team 池影响，反向也一样。
  const scheduler = new AgentTaskScheduler();
  assertEqual(scheduler.maxSlots, AGENT_TASK_DEFAULT_RUNNING_SLOTS, "solo 调度器默认档仍是 4");
  assertEqual(scheduler.activeCount, 0, "solo 调度器初始占用为 0");

  const pool = new TeamCapacityPool();
  const teamSeats: string[] = [];
  for (let index = 0; index < MAX_SEAT_SLOTS; index++) {
    const acquired = pool.acquireSeat(`seat-${index}`);
    if (acquired) {
      teamSeats.push(`seat-${index}`);
    }
  }
  assertEqual(teamSeats.length, MAX_SEAT_SLOTS, `Team 池可持 ${MAX_SEAT_SLOTS} 席`);
  assertEqual(pool.acquireSeat("seat-overflow"), false, "第 13 席拿不到槽（H1）");
  assertEqual(pool.acquireAux("aux-1"), true, "aux 槽独立于席位槽");
  assertEqual(pool.acquireAux("aux-2"), true, "aux 槽可持 2 个");
  assertEqual(pool.acquireAux("aux-3"), false, `第 ${MAX_AUX_SLOTS + 1} 个 aux 拿不到槽`);

  assertEqual(scheduler.maxSlots, AGENT_TASK_DEFAULT_RUNNING_SLOTS, "Team 池占满后 solo 调度器档位不变");
  assertEqual(scheduler.activeCount, 0, "Team 池占满后 solo 调度器占用仍是 0");

  // solo 调度器在 Team 池占满时照常工作：仍是 4 个并发、第 5 个排队。
  const soloIds = ["t1", "t2", "t3", "t4", "t5"];
  const soloGrants = soloIds.map((taskId) => scheduler.enqueue(taskId));
  assertEqual(soloGrants.filter(Boolean).length, AGENT_TASK_DEFAULT_RUNNING_SLOTS, "Team 池占满时 solo 仍能起 4 个任务");
  assertEqual(scheduler.activeCount, AGENT_TASK_DEFAULT_RUNNING_SLOTS, "solo 调度器占用到 4");
  assertEqual(scheduler.getQueuePosition("t5"), 1, "第 5 个 solo 任务在排队");
  scheduler.release();
  assertEqual(scheduler.activeCount, AGENT_TASK_DEFAULT_RUNNING_SLOTS, "释放一个槽立刻交给排队者（占用不变）");
  assertEqual(scheduler.getQueuePosition("t5"), undefined, "排队者已拿到槽");
  assertEqual(pool.acquireSeat("seat-overflow"), false, "solo 调度器活动不影响 Team 池满槽事实");

  // 池暂停不释放已持槽（§4.8），且不产生任何 solo 副作用。
  pool.pause();
  assertEqual(pool.acquireSeat("seat-fresh"), false, "暂停后新 acquire 全失败");
  assertEqual(pool.acquireSeat("seat-0"), false, "暂停后已持槽席的重复 acquire 也失败");
  for (const seatId of teamSeats) {
    pool.releaseSeat(seatId);
  }
  assertEqual(pool.acquireSeat("seat-0"), false, "暂停期间释放也不放行");
  pool.resume();
  assertEqual(pool.acquireSeat("seat-0"), true, "恢复后重新可以持槽");
  assertEqual(scheduler.activeCount, AGENT_TASK_DEFAULT_RUNNING_SLOTS, "Team 池暂停/恢复全程不影响 solo 调度器");

  // 结构面：Team 侧没有任何指向 agent-task 的 import 边。
  const mainDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const teamDir = join(mainDir, "team");
  const teamSources = readdirSync(teamDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name: join("team", name), source: readFileSync(join(teamDir, name), "utf8") }));
  teamSources.push({ name: "team-manager.ts", source: readFileSync(join(mainDir, "team-manager.ts"), "utf8") });

  const agentTaskEdges: string[] = [];
  for (const file of teamSources) {
    for (const specifier of importSpecifiersOf(file.source)) {
      if (specifier.includes("agent-task")) {
        agentTaskEdges.push(`${file.name} -> ${specifier}`);
      }
    }
  }
  assertEqual(agentTaskEdges.length, 0, `Team 侧没有 agent-task import 边（${agentTaskEdges.join(", ")}）`);
  const poolSource = teamSources.find((file) => file.name.endsWith("capacity-pool.ts"))!;
  assertEqual(importSpecifiersOf(poolSource.source).length, 0, "capacity-pool.ts 自身零 import（对象图完全独立）");

  // 管理器的容量模块就是 TeamCapacityPool 实例，不是调度器。
  const fixture = await makeFixture("pool");
  const modules = (fixture.manager as unknown as { _modules: { capacity: unknown } })._modules;
  assert(modules.capacity instanceof TeamCapacityPool, "facade 的容量池是 TeamCapacityPool");
  await fixture.manager.dispose();
  await settle();
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
