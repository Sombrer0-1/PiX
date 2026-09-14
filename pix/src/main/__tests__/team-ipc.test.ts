/**
 * Team IPC source gates（S5，plan §8「S5 验收」一栏）。
 *
 * Plan §8 锁定 S5 的五条验收，全部只能对着源码做门禁（`ipc-handlers.ts` 在纯
 * Node 里 import 不了：它的 electron 依赖链在 Electron 运行时之外加载即失败）：
 *   1. `isTeamCommand` 穷尽 §4.12 联合（`VALID_TEAM_COMMAND_TYPES` 与 `TeamCommand`
 *      的键集合逐字相等，且每个成员在 switch 里都有 case + 编译期 never 兜底）；
 *   2. 无 `registerLeaderTools`（leader 工具入口随旧编排一起删除）；
 *   3. 无公开 `setLeaderSession` / `resumeRuntime` / `abortActiveTurns`；
 *   4. `has-team-snapshot` 不因旧 `team.json` 为 true（旧场永不恢复，H14 / AC-13）；
 *   5. Plan IPC 仍绑 single（`singleSessionBridge`，不许改绑 team leader bridge）。
 *
 * 这些断言不跑实现语义，只钉「接线不许回退」：删掉一条 case、把 Plan 控制器换个
 * bridge、或者让旧 json 参与「可恢复」判断，都会在这里变红。
 *
 * Run with: npx tsx pix/src/main/__tests__/team-ipc.test.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { roundtableCurrentPointerPath } from "../team/constants.js";
import {
  LEGACY_SNAPSHOT_RESTORABLE,
  detectLegacyTeamSnapshot,
  isLegacySnapshotRestorable,
} from "../team/legacy-snapshot.js";
import { RoundtablePersistence } from "../team/persistence.js";
import { teamSnapshotPath } from "../team-persistence.js";

// ============================================================================
// Test harness (matches team-persistence.test.ts / workflow-ipc.test.ts style)
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
    console.error(
      `  FAIL: ${message} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
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

/** 集合差异，失败信息里带上具体成员。 */
function diff(actual: ReadonlySet<string>, expected: ReadonlySet<string>): string[] {
  return [...actual].filter((entry) => !expected.has(entry)).sort();
}

// ============================================================================
// 源码读取
// ============================================================================

// 旧快照探测（`detectLegacyTeamSnapshot`）写在 agent 目录下：指向临时目录，
// 真实用户目录绝不参与。
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pix-team-ipc-agent-"));

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_DIR = join(HERE, "..");
const SRC_DIR = join(MAIN_DIR, "..");

const IPC_SOURCE = readFileSync(join(MAIN_DIR, "ipc-handlers.ts"), "utf8");
const TEAM_TYPES_SOURCE = readFileSync(join(SRC_DIR, "shared", "team-types.ts"), "utf8");

/**
 * `pix/src` 下的全部生产 .ts / .vue。测试目录整棵排除：门禁说的是「产品代码里没有
 * 这个入口」，而负向用例本身必须写下这些名字才可能断言它们不存在。
 */
function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") {
          continue;
        }
        walk(full);
      } else if (/\.(ts|vue)$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * 去掉块注释与行注释，只留代码。门禁必须区分「代码里的名字」与「注释里提到的
 * 名字」：`team-manager.ts` 在头注释里记着「已删除 setLeaderSession …」，那是
 * 文档而不是 API。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/[^\n]*$/gm, "$1");
}

/**
 * 取一段源码：从 `start` 锚点到其后第一次出现的 `end` 锚点。锚点缺失时返回空串
 * （对应的断言已经记了一条 FAIL），让后面的断言各自报出「这段代码里没有 X」，
 * 而不是拿一段被切歪的源码给出误导性的结论。
 */
function sliceBetween(source: string, startAnchor: string, endAnchor: string): string {
  const start = source.indexOf(startAnchor);
  assert(start >= 0, `找到锚点 ${JSON.stringify(startAnchor)}`);
  if (start < 0) {
    return "";
  }
  const rest = source.slice(start);
  const end = rest.indexOf(endAnchor);
  assert(end >= 0, `找到结束锚点 ${JSON.stringify(endAnchor)}`);
  if (end < 0) {
    return "";
  }
  return rest.slice(0, end + endAnchor.length);
}

// ============================================================================
// 1. isTeamCommand 穷尽 §4.12 联合
// ============================================================================

/** `team-types.ts` 里 `TeamCommand` 联合的成员（§4.12 的唯一真源）。 */
function unionCommandTypes(): Set<string> {
  const start = TEAM_TYPES_SOURCE.indexOf("export type TeamCommand =");
  assert(start >= 0, "team-types.ts 声明了 TeamCommand");
  const rest = TEAM_TYPES_SOURCE.slice(start);
  const end = rest.indexOf("\nexport ");
  const union = end === -1 ? rest : rest.slice(0, end);
  const types = new Set<string>();
  for (const match of union.matchAll(/\{\s*type:\s*"([a-z0-9_]+)"/g)) {
    types.add(match[1]!);
  }
  return types;
}

await run("S5：isTeamCommand 穷尽 §4.12 联合（VALID_TEAM_COMMAND_TYPES 逐字相等）", async () => {
  const union = unionCommandTypes();
  assert(union.size > 0, "从 team-types.ts 抽出非空命令联合");

  const validBlock = sliceBetween(IPC_SOURCE, "const VALID_TEAM_COMMAND_TYPES = new Set([", "]);");
  const valid = new Set<string>();
  for (const match of validBlock.matchAll(/"([a-z0-9_]+)"/g)) {
    valid.add(match[1]!);
  }

  assertEqual(diff(union, valid).length, 0, `白名单漏掉的命令：${diff(union, valid).join(",") || "无"}`);
  assertEqual(diff(valid, union).length, 0, `白名单多出的命令：${diff(valid, union).join(",") || "无"}`);
  assertEqual(valid.size, union.size, `白名单与联合成员数一致（各 ${union.size} 条）`);

  const guard = sliceBetween(IPC_SOURCE, "function isTeamCommand(", "\n}");
  const cases = new Set<string>();
  for (const match of guard.matchAll(/case\s+"([a-z0-9_]+)":/g)) {
    cases.add(match[1]!);
  }
  assertEqual(
    diff(union, cases).length,
    0,
    `switch 漏掉的命令：${diff(union, cases).join(",") || "无"}（漏一条就不再穷尽）`,
  );
  assert(
    guard.includes("const exhaustive: never = type;"),
    "switch 的 default 保留编译期穷尽兜底（新增成员不写 case 就不编译）",
  );
  assert(
    guard.includes("VALID_TEAM_COMMAND_TYPES.has(c.type)"),
    "未知 type 在进入 switch 之前就被白名单拦掉（不是靠 default 猜）",
  );
});

await run("S5：team-command 派发到 TeamManager facade，不经过 leader session", async () => {
  const handler = sliceBetween(IPC_SOURCE, 'ipcMain.handle("team-command"', "\n  });");
  assert(handler.includes("executeTeamCommand(teamManager, command)"), "命令派发给 TeamManager facade");
  assert(
    !handler.includes("teamLeaderSessionBridge"),
    "team-command 不把 leader session 当讨论引擎（S5 的接线约束）",
  );
});

// ============================================================================
// 2/3. leader 工具入口与三个废弃方法
// ============================================================================

await run("S5：无 registerLeaderTools（旧编排的 leader 工具入口已删除）", async () => {
  const files = listSourceFiles(SRC_DIR);
  assert(files.length > 0, `扫描到 ${files.length} 个源文件`);
  // 与下面三个废弃方法同口径：看去注释后的代码。`team-manager.ts:15`、
  // `team/debug-logger.ts:8` 都正当记着「已删除 X」的历史，注释里的旧入口是文档
  // 而不是接线；把注释也算进去会让「补一句删除说明」变成假红。
  const hits = files.filter((file) => stripComments(readFileSync(file, "utf8")).includes("registerLeaderTools"));
  assertEqual(hits.length, 0, `registerLeaderTools 在代码里零命中：${hits.join(", ") || "无"}`);
  assert(
    !existsSync(join(MAIN_DIR, "team-leader-tools.ts")),
    "旧模块 team-leader-tools.ts 已从 main/ 删除",
  );
});

await run("S5：无公开 setLeaderSession / resumeRuntime / abortActiveTurns", async () => {
  const stripped = stripComments(
    "class X {\n  // setLeaderSession(a)\n  setLeaderSession(a: number): void {}\n}\n",
  );
  assert(
    stripped.includes("setLeaderSession("),
    "自检：去注释后方法声明仍在（否则下面的零容忍断言会因为是空的而恒真）",
  );
  assert(
    !stripped.includes("// setLeaderSession"),
    "自检：注释里的名字被去掉（文档里的「已删除」不算 API）",
  );

  const banned = ["setLeaderSession", "resumeRuntime", "abortActiveTurns"];
  for (const name of banned) {
    const hits: string[] = [];
    for (const file of listSourceFiles(SRC_DIR)) {
      if (stripComments(readFileSync(file, "utf8")).includes(name)) {
        hits.push(file);
      }
    }
    assertEqual(hits.length, 0, `${name} 在代码里零命中：${hits.join(", ") || "无"}`);
  }
});

// ============================================================================
// 4. has-team-snapshot 不因旧 json 为 true
// ============================================================================

await run("S5：has-team-snapshot 只读工作区指针，不碰旧 team.json", async () => {
  // 负向判定看去注释后的代码：handler 的文档注释里正当地写着「旧 team.json 不是快照」。
  const handler = sliceBetween(IPC_SOURCE, 'ipcMain.handle("has-team-snapshot"', "\n  });");
  const handlerCode = stripComments(handler);
  assert(handlerCode.includes("hasResumableRoundtable(location.physicalPath)"), "探针走 hasResumableRoundtable");
  assert(
    !handlerCode.includes("detectLegacyTeamSnapshot"),
    "可恢复判断不读旧快照探测（H14：旧场不可恢复）",
  );
  assert(!handlerCode.includes("team.json"), "可恢复判断不出现旧文件名 team.json");
  assert(!handlerCode.includes("LEGACY_SNAPSHOT"), "可恢复判断不接受 LEGACY_SNAPSHOT_* 常量");

  const probe = stripComments(sliceBetween(IPC_SOURCE, "async function hasResumableRoundtable(", "\n}"));
  assert(probe.includes("readCurrentPointer()"), "探针读工作区指针 current.json");
  assert(!probe.includes("teamSnapshotPath"), "探针不读旧快照路径");
  assert(!probe.includes("team.json"), "探针不出现旧文件名");

  // 旧快照探测只保留在它自己的通道上，并受 ack 约束（AC-13：只提示一次）。
  const legacyHandler = sliceBetween(IPC_SOURCE, 'ipcMain.handle("has-legacy-team-snapshot"', "\n  });");
  assert(
    legacyHandler.includes("detectLegacyTeamSnapshot(location.physicalPath)"),
    "has-legacy-team-snapshot 才做旧快照探测",
  );
  assert(
    legacyHandler.includes("ack.legacySnapshotNoticeAck !== true"),
    "ack 之后该通道返回 false（AC-13 的「只提示一次」由主进程判定）",
  );
});

await run("旧 team.json 存在也不构成可恢复快照（H14 / AC-13）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pix-team-ipc-legacy-"));
  try {
    const legacyPath = teamSnapshotPath(cwd);
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({ roundtableId: "old-team" }), "utf8");
    assertEqual(detectLegacyTeamSnapshot(cwd), true, "旧 team.json 只被探测到（用于提示一次）");
    assertEqual(LEGACY_SNAPSHOT_RESTORABLE, false, "LEGACY_SNAPSHOT_RESTORABLE === false");
    assertEqual(isLegacySnapshotRestorable(), false, "isLegacySnapshotRestorable() === false");

    assertEqual(existsSync(roundtableCurrentPointerPath(cwd)), false, "前提：没有工作区指针");
    const probe = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: "bootstrap" });
    assertEqual(
      await probe.readCurrentPointer(),
      null,
      "只有旧 json、没有 current.json 指针 → has-team-snapshot 判定为 false",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. Plan IPC 仍绑 single
// ============================================================================

await run("S5：Plan IPC 仍绑 singleSessionBridge", async () => {
  const calls = [...IPC_SOURCE.matchAll(/registerPlanIpcHandlers\([^;]*;/g)].map((match) => match[0]);
  assertEqual(calls.length, 1, "ipc-handlers.ts 只注册一次 Plan IPC");
  const call = calls[0] ?? "";
  assert(call.includes("singleSessionBridge.getPlanController()"), "Plan 控制器取自 singleSessionBridge");
  assert(!call.includes("teamLeaderSessionBridge"), "Plan IPC 没有改绑 team leader bridge");

  // 全文件的 Plan 控制器引用都必须挂在 single 上（事件转发订阅也算）。
  const planGetters = [...IPC_SOURCE.matchAll(/getPlanController\(\)/g)].length;
  const singleGetters = [...IPC_SOURCE.matchAll(/singleSessionBridge\.getPlanController\(\)/g)].length;
  assert(planGetters > 0, `Plan 控制器引用非空（${planGetters} 处）`);
  assertEqual(planGetters, singleGetters, "每一处 getPlanController() 都来自 singleSessionBridge");
});

// ============================================================================

console.log("\n=== Summary ===\n");
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
