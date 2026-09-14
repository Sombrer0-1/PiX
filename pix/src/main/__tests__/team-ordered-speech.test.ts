/**
 * OrderedSpeechGate tests (S2d, plan §4.5 / §5.15, H3 / H4 / H27 / H28 / H41).
 *
 * Covers:
 *   - argument + orderedMode on → admit returns `{ ok: false, queued: true }`
 *     immediately, carrying the messageId, without blocking (H28)
 *   - onReleased hands back that same messageId / fromId at orderedReleaseMs (H4)
 *   - queue key: @-mentioned seat first → longest silent next → FIFO ties (H41)
 *   - knowledge_card / explore_result / note / question / challenge never queue (H3)
 *   - every kind passes through while orderedMode is off
 *   - orderedMode is read through the getter on every admit (H27: no cached enabled)
 *   - the waiting listing mirrors queue membership and drains on release
 *   - reset() (ordered mode turned off) releases waiting arguments without loss
 *
 * Run with: npx tsx pix/src/main/__tests__/team-ordered-speech.test.ts
 */

import { OrderedSpeechGate } from "../team/ordered-speech.js";
import type { UtteranceKind } from "../../shared/team-types.js";

// ============================================================================
// Test harness (matches execution-context.test.ts / team-manager.test.ts style)
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

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Gate harness: injectable clock / settings getters
// ============================================================================

interface GateHarness {
  gate: OrderedSpeechGate;
  /** onReleased 收到的 (messageId, fromId)，按放行顺序。 */
  released: Array<{ messageId: string; fromId: string }>;
  /** 注入的时钟（毫秒）；测试直接改它。 */
  clock: { at: number };
  /** 注入的 `RoundtableSettings.orderedMode` 权威值（H27）。 */
  orderedMode: { on: boolean };
  lastSpokeAt: Map<string, number>;
  enabledReads: () => number;
}

function makeGate(options?: { ordered?: boolean; releaseMs?: number }): GateHarness {
  const clock = { at: 0 };
  const orderedMode = { on: options?.ordered ?? true };
  const releaseMs = options?.releaseMs ?? 40;
  const lastSpokeAt = new Map<string, number>();
  const released: Array<{ messageId: string; fromId: string }> = [];
  let reads = 0;
  const gate = new OrderedSpeechGate(
    () => {
      reads++;
      return orderedMode.on;
    },
    () => releaseMs,
    (seatId) => lastSpokeAt.get(seatId),
    () => clock.at,
  );
  gate.onReleased((messageId, fromId) => {
    released.push({ messageId, fromId });
  });
  return { gate, released, clock, orderedMode, lastSpokeAt, enabledReads: () => reads };
}

function argument(fromId: string, messageId: string, mentionIds: string[] = []) {
  return { messageId, fromId, utteranceKind: "argument" as UtteranceKind, mentionIds };
}

function idsOf(released: Array<{ messageId: string }>): string {
  return released.map((entry) => entry.messageId).join(",");
}

// ============================================================================
// Tests
// ============================================================================

await run("有序模式关：一切 kind 直接放行，argument 也不排队", async () => {
  const h = makeGate({ ordered: false, releaseMs: 30 });
  const kinds: UtteranceKind[] = [
    "argument",
    "note",
    "knowledge_card",
    "question",
    "explore_result",
    "challenge",
  ];
  for (const kind of kinds) {
    const result = h.gate.admit({ messageId: `m-${kind}`, fromId: "seat-1", utteranceKind: kind, mentionIds: [] });
    assertEqual(result.ok, true, `有序模式关：${kind} → ok:true`);
  }
  assertEqual(h.gate.size(), 0, "有序模式关：队列为空");
  assertEqual(h.gate.waiting().length, 0, "有序模式关：waiting 为空");
  h.clock.at += 500;
  await sleep(80);
  assertEqual(h.released.length, 0, "有序模式关：没有放行回调");
});

await run("argument + 有序模式开：admit 立即 queued、带 messageId、不阻塞（H28）", async () => {
  const h = makeGate({ releaseMs: 40 });
  const started = Date.now();
  const admission = h.gate.admit(argument("seat-1", "m-1"));
  const elapsed = Date.now() - started;

  assertEqual(admission.ok, false, "admit 不放行：argument 进门队列");
  if (!admission.ok) {
    assertEqual(admission.queued, true, "queued:true（H28）");
    assertEqual(admission.waitMs, 40, "waitMs = orderedReleaseMs（H4 上限）");
    assertEqual(admission.position, 1, "position 从 1 起算");
  }
  assert(elapsed < 200, `admit 同步返回、不阻塞（${elapsed}ms）`);
  assertEqual(h.released.length, 0, "admit 阶段没有放行：已记录、未投递");
  assertEqual(h.gate.size(), 1, "队列里有这一条");

  // 未到 orderedReleaseMs：还是不投递。
  await sleep(20);
  assertEqual(h.released.length, 0, "未到 orderedReleaseMs 不放行");

  h.clock.at += 40;
  await sleep(200);
  assertEqual(h.released.length, 1, "到 orderedReleaseMs 自动放行");
  assertEqual(h.released[0]?.messageId, "m-1", "onReleased 带回同一个 messageId");
  assertEqual(h.released[0]?.fromId, "seat-1", "onReleased 带回发言席");
  assertEqual(h.gate.size(), 0, "放行后队列排空");
  assertEqual(h.gate.waiting().length, 0, "放行后 waiting 为空");
  assertEqual(h.gate.isWaiting("seat-1"), false, "放行后不再 isWaiting");
});

await run("排队键：被 @ 的席位的响应优先（H41 读 mentionIds）", async () => {
  const h = makeGate({ releaseMs: 40 });
  const first = h.gate.admit(argument("seat-1", "m-1", ["seat-2"]));
  const second = h.gate.admit(argument("seat-2", "m-2"));
  const third = h.gate.admit(argument("seat-3", "m-3"));

  assertEqual(first.ok, false, "m-1 排队");
  assertEqual(second.ok === false ? second.position : 0, 1, "被 @ 的 seat-2 排到下一位");
  assertEqual(third.ok === false ? third.position : 0, 3, "seat-3 排在未被 @ 的 seat-1 之后");
  assertEqual(h.gate.waiting().map((entry) => entry.seatId).join(","), "seat-2,seat-1,seat-3", "队列按排队键列出");

  h.clock.at += 40;
  await sleep(200);
  assertEqual(idsOf(h.released), "m-2,m-1,m-3", "被 @ 的席位先放行，其余按最久未发言");
});

await run("F2-4：@ 优先是一次性的，放行一轮后回到普通排队键", async () => {
  const h = makeGate({ releaseMs: 40 });
  h.clock.at = 1_000;
  h.lastSpokeAt.set("seat-2", 900); // 沉默 100（被 @，但按沉默算该靠后）
  h.lastSpokeAt.set("seat-1", 100); // 沉默 900

  h.gate.admit(argument("seat-1", "m-1", ["seat-2"]));
  h.gate.admit(argument("seat-2", "m-2"));
  assertEqual(h.gate.waiting().map((entry) => entry.messageId).join(","), "m-2,m-1", "被 @ 的席位先排");

  h.clock.at += 40;
  await sleep(200);
  assertEqual(idsOf(h.released), "m-2,m-1", "第一轮按排队键放行");

  // 优先权已消费：同一席再排队不再插队（否则整场永久占优）。
  h.gate.admit(argument("seat-2", "m-4"));
  h.gate.admit(argument("seat-1", "m-5"));
  assertEqual(
    h.gate.waiting().map((entry) => entry.messageId).join(","),
    "m-5,m-4",
    "优先权用完即弃：回到最久未发言键（seat-1 沉默更久）",
  );
});

await run("F2-4：自由模式与非 argument 的 @ 都不登记优先", async () => {
  // 自由模式：argument 直接投递，@ 不留下任何优先标记。
  const free = makeGate({ ordered: false, releaseMs: 40 });
  free.clock.at = 1_000;
  free.lastSpokeAt.set("seat-1", 100); // 沉默 900（最久）
  free.lastSpokeAt.set("seat-3", 900); // 沉默 100（被 @，但按沉默算该靠后）
  assertEqual(free.gate.admit(argument("seat-1", "m-0", ["seat-3"])).ok, true, "自由模式：argument 直接投递");
  free.orderedMode.on = true;
  free.gate.admit(argument("seat-1", "m-1"));
  free.gate.admit(argument("seat-3", "m-3"));
  assertEqual(
    free.gate.waiting().map((entry) => entry.seatId).join(","),
    "seat-1,seat-3",
    "自由模式里的 @ 不构成优先：翻开有序模式后仍按最久未发言排队",
  );

  // 有序模式里非 argument 的 @ 同样不登记（它本来就不进队列）。
  const ordered = makeGate({ releaseMs: 40 });
  ordered.clock.at = 1_000;
  ordered.lastSpokeAt.set("seat-1", 100); // 沉默 900（最久）
  ordered.lastSpokeAt.set("seat-3", 900); // 沉默 100
  assertEqual(
    ordered.gate.admit({ messageId: "n-0", fromId: "seat-3", utteranceKind: "note", mentionIds: ["seat-3"] }).ok,
    true,
    "有序模式：note 直接投递（H3）",
  );
  ordered.gate.admit(argument("seat-1", "m-1"));
  ordered.gate.admit(argument("seat-3", "m-3"));
  assertEqual(
    ordered.gate.waiting().map((entry) => entry.seatId).join(","),
    "seat-1,seat-3",
    "非 argument 的 @ 不登记优先",
  );
});

await run("排队键：最久未发言的席位次之", async () => {
  const h = makeGate({ releaseMs: 40 });
  h.clock.at = 1_000;
  h.lastSpokeAt.set("seat-1", 900); // 沉默 100
  h.lastSpokeAt.set("seat-2", 500); // 沉默 500
  h.lastSpokeAt.set("seat-3", 0); // 沉默 1000（与从未发言同效）
  h.gate.admit(argument("seat-1", "m-1"));
  h.gate.admit(argument("seat-2", "m-2"));
  h.gate.admit(argument("seat-3", "m-3"));

  assertEqual(h.gate.waiting().map((entry) => entry.seatId).join(","), "seat-3,seat-2,seat-1", "最久未发言在前");

  h.clock.at += 40;
  await sleep(200);
  assertEqual(idsOf(h.released), "m-3,m-2,m-1", "按 now - lastSpokeAt 降序放行");
});

await run("排队键：同分先到先发（FIFO）", async () => {
  const h = makeGate({ releaseMs: 40 });
  h.clock.at = 1_000;
  h.lastSpokeAt.set("seat-1", 500);
  h.lastSpokeAt.set("seat-2", 500);
  h.lastSpokeAt.set("seat-3", 500);
  h.gate.admit(argument("seat-3", "m-3"));
  h.gate.admit(argument("seat-1", "m-1"));
  h.gate.admit(argument("seat-2", "m-2"));

  h.clock.at += 40;
  await sleep(200);
  assertEqual(idsOf(h.released), "m-3,m-1,m-2", "同分按入队顺序放行");
});

await run("知识卡 / 探索回灌 / 短补充 / 提问 / 挑战都不进队列（H3）", async () => {
  const h = makeGate({ releaseMs: 30 });
  const passthrough: UtteranceKind[] = ["knowledge_card", "explore_result", "note", "question", "challenge"];
  for (const kind of passthrough) {
    const result = h.gate.admit({ messageId: `m-${kind}`, fromId: "seat-1", utteranceKind: kind, mentionIds: [] });
    assertEqual(result.ok, true, `有序模式开：${kind} 直接投递`);
  }
  assertEqual(h.gate.size(), 0, "知识卡等不进队列");
  assertEqual(h.gate.waiting().length, 0, "waiting 里没有知识卡 / 探索回灌");
  h.clock.at += 500;
  await sleep(60);
  assertEqual(h.released.length, 0, "没有放行回调（本来就没排队）");
});

await run("waiting 列表反映队列成员与位置，放行后清空", async () => {
  const h = makeGate({ releaseMs: 40 });
  h.clock.at = 2_000;
  h.gate.admit(argument("seat-1", "m-1"));
  h.gate.admit(argument("seat-2", "m-2"));

  const waiting = h.gate.waiting();
  assertEqual(waiting.length, 2, "两条在等");
  assertEqual(waiting[0]?.messageId, "m-1", "waiting[0] 是队列头");
  assertEqual(waiting[0]?.position, 1, "队列头 position 1");
  assertEqual(waiting[1]?.position, 2, "第二条 position 2");
  assertEqual(waiting[0]?.waitMs, 40, "剩余等待 = orderedReleaseMs");
  assertEqual(h.gate.isWaiting("seat-1"), true, "seat-1 正在等待发言");

  h.clock.at += 40;
  await sleep(200);
  assertEqual(h.gate.waiting().length, 0, "放行后 waiting 清空");
  assertEqual(h.gate.isWaiting("seat-1"), false, "放行后 isWaiting 为 false");
  assertEqual(idsOf(h.released), "m-1,m-2", "两条都投递（投递零丢失）");
});

await run("orderedMode 只经 getter 读，每次 admit 都看当前值（H27 禁止自存 enabled）", async () => {
  const h = makeGate({ ordered: true, releaseMs: 30 });
  h.orderedMode.on = false;
  assertEqual(h.gate.admit(argument("seat-1", "m-off")).ok, true, "getter 为 false → 直接放行");

  h.orderedMode.on = true;
  const queued = h.gate.admit(argument("seat-2", "m-on"));
  assertEqual(queued.ok, false, "同一个 gate：getter 翻成 true 后立刻开始排队");

  h.orderedMode.on = false;
  assertEqual(h.gate.admit(argument("seat-3", "m-off-2")).ok, true, "getter 翻回 false 后立刻放行");
  assert(h.enabledReads() >= 3, "每次 admit 都读 getter（没有缓存 enabled）");
  assertEqual(h.gate.size(), 1, "等待中的那条仍在队列里（由 facade 的 reset 处理）");
});

await run("reset（关有序模式）：按排队键放行等待中的 argument，投递不丢（§5.15）", async () => {
  const h = makeGate({ releaseMs: 5_000 });
  h.gate.admit(argument("seat-1", "m-1", ["seat-2"]));
  h.gate.admit(argument("seat-2", "m-2"));
  assertEqual(h.gate.size(), 2, "两条在等（远未到 orderedReleaseMs）");

  h.gate.reset();
  assertEqual(idsOf(h.released), "m-2,m-1", "reset 按排队键放行，投递零丢失");
  assertEqual(h.gate.size(), 0, "reset 后队列清空");
  assertEqual(h.gate.waiting().length, 0, "reset 后 waiting 清空");

  h.clock.at += 10_000;
  await sleep(60);
  assertEqual(h.released.length, 2, "reset 后不再重复放行");
});

await run("onReleased 返回退订函数", async () => {
  const h = makeGate({ releaseMs: 30 });
  const seen: string[] = [];
  const off = h.gate.onReleased((messageId) => {
    seen.push(messageId);
  });
  off();
  h.gate.admit(argument("seat-1", "m-1"));
  h.clock.at += 30;
  await sleep(150);
  assertEqual(h.released.length, 1, "主订阅仍收到放行");
  assertEqual(seen.length, 0, "退订后不再收到放行");
});

// ============================================================================

console.log("\n=== Summary ===\n");
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
