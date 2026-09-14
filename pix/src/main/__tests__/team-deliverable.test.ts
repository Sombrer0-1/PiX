/**
 * DeliverableStore / OpenItemBoard / AttentionBus tests (S2d, plan §4.6b / §4.9).
 *
 * Covers:
 *   - DeliverableStore.create pins cutoffSeq to the current timeline lastSeq and
 *     version to max+1; status drafting → ready after the markdown lands
 *   - updateMarkdown: the five required sections are carried, the CAS path refuses
 *     a write against a superseded base and reports the current version, and the
 *     old markdown is never silently overwritten
 *   - setStance records support / oppose / conditional / absent (a seat that never
 *     voted reads back as "absent") and overwrites on re-stance
 *   - list / get / restore round-trips
 *   - OpenItemBoard.open / claim / resolve / drop / list / get / restore, and
 *     releaseOwned returning a claimed item to open with claimedBy cleared (H9)
 *   - AttentionBus.push fills id / ts / acked, ack round-trips, restore keeps state
 *
 * Run with: npx tsx pix/src/main/__tests__/team-deliverable.test.ts
 */

import { DeliverableStore } from "../team/deliverable-store.js";
import { OpenItemBoard } from "../team/open-items.js";
import { AttentionBus } from "../team/attention-bus.js";
import type { DeliverableVersion } from "../../shared/team-types.js";

// ============================================================================
// Test harness (matches execution-context.test.ts / team-ids.test.ts style)
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

// ============================================================================
// Fixtures
// ============================================================================

interface StoreHarness {
  store: DeliverableStore;
  /** 时间线最大 seq（create 钉截止点用）。 */
  timeline: { lastSeq: number };
  clock: { at: number };
}

function makeStore(): StoreHarness {
  const timeline = { lastSeq: 0 };
  const clock = { at: 1_000 };
  const store = new DeliverableStore({ getCutoffSeq: () => timeline.lastSeq, now: () => clock.at });
  return { store, timeline, clock };
}

/** 整理输出的小节格式取自 S4 的整理 prompt（§4.12c）。 */
function deliverableMarkdown(conclusion: string, evidence: string): string {
  return [
    "## 结论与建议（带置信度）",
    conclusion,
    "",
    "## 依据入口（时间线 id / 知识卡 id；追溯不到的条目标「未验证」）",
    evidence,
    "",
    "## 分歧与未决",
    "无",
    "",
    "## 后续动作",
    "先做 A，再看 B",
    "",
    "## 过程索引",
    "seq=3 转折",
  ].join("\n");
}

// ============================================================================
// DeliverableStore
// ============================================================================

await run("create 钉 cutoffSeq / version，状态 drafting", async () => {
  const h = makeStore();
  h.timeline.lastSeq = 7;
  const v1 = h.store.create({ author: "system" });

  assertEqual(v1.version, 1, "首版 version=1");
  assertEqual(v1.cutoffSeq, 7, "截止点 = 当前 lastSeq");
  assertEqual(v1.status, "drafting", "新建是 drafting");
  assertEqual(v1.markdown, "", "正文由主笔随后写入");
  assertEqual(v1.basedOnVersion, undefined, "首版没有基准版本");
  assertEqual(v1.author, "system", "作者记录了");

  h.timeline.lastSeq = 42;
  const v2 = h.store.create({ author: "seat-1", basedOnVersion: 1 });
  assertEqual(v2.version, 2, "version = max+1");
  assertEqual(v2.cutoffSeq, 42, "新版的截止点是新的 lastSeq");
  assertEqual(v2.basedOnVersion, 1, "新版的基准版本记录了");
  assertEqual(h.store.get(v1.id)?.cutoffSeq, 7, "已钉版本的截止点不被改写");
});

await run("updateMarkdown：写入正文、带出五个小节、状态转 ready", async () => {
  const h = makeStore();
  h.timeline.lastSeq = 12;
  const v1 = h.store.create({ author: "system" });
  const markdown = deliverableMarkdown("采用方案 A（置信度：中）", "- timeline seq=12\n- kc-3");

  const result = h.store.updateMarkdown(v1.id, markdown, "seat-1");
  assertEqual(result.ok, true, "首次写入成功");

  const after = h.store.get(v1.id);
  assertEqual(after?.status, "ready", "写入后转 ready");
  assertEqual(after?.markdown, markdown, "markdown 原样保存");
  assertEqual(after?.sections.conclusions, "采用方案 A（置信度：中）", "结论与建议（含置信度）");
  assertEqual(after?.sections.evidenceIndex, "- timeline seq=12\n- kc-3", "依据入口（timeline / 知识卡 id）");
  assertEqual(after?.sections.disagreements, "无", "分歧与未决");
  assertEqual(after?.sections.nextActions, "先做 A，再看 B", "后续动作");
  assertEqual(after?.sections.processIndex, "seq=3 转折", "过程索引");
  assertEqual(h.store.revisionLog().length, 1, "修订链记录了这次写入");
  assertEqual(h.store.revisionLog()[0]?.actor, "seat-1", "修订链记了作者");
});

await run("updateMarkdown 并发：ready 后继冻结再修订；drafting 后继仍放行首次 publish", async () => {
  const h = makeStore();
  h.timeline.lastSeq = 3;
  const v1 = h.store.create({ author: "system" });
  const markdown1 = deliverableMarkdown("第一版结论（置信度：低）", "- 未验证");
  assertEqual(h.store.updateMarkdown(v1.id, markdown1, "system").ok, true, "v1 写入成功");

  // 另一个整理者基于 v1 开了 v2（仍是 drafting）：v1 已 ready，不能再改。
  const v2 = h.store.create({ author: "seat-2", basedOnVersion: 1 });
  const refused = h.store.updateMarkdown(v1.id, deliverableMarkdown("第二版结论（置信度：高）", "- x"), "seat-1");
  assertEqual(refused.ok, false, "已 ready 且有 drafting 后继时再修订被拒");
  assertEqual(refused.ok === false ? refused.conflict : false, true, "返回 conflict:true");
  assertEqual(refused.ok === false ? refused.currentVersion : 0, 2, "告知当前版本号，调用方另开新版本");
  assertEqual(h.store.get(v1.id)?.markdown, markdown1, "旧版的 markdown 没有被静默覆盖");

  // 基于 currentVersion 另开一版。
  const v3 = h.store.create({ author: "seat-1", basedOnVersion: refused.ok === false ? refused.currentVersion : 0 });
  assertEqual(v3.version, 3, "基于 currentVersion 另开新版本");

  // v2 仍是 drafting：首次 publish 不被后继挡住（连点两次整理时先建的那版必须能写完）。
  const v2Markdown = deliverableMarkdown("第二版结论（置信度：中）", "- kc-2");
  assertEqual(h.store.updateMarkdown(v2.id, v2Markdown, "seat-2").ok, true, "drafting 后继不挡住 v2 首次 publish");
  assertEqual(h.store.get(v2.id)?.status, "ready", "v2 首次写入转 ready");
  assertEqual(h.store.get(v2.id)?.markdown, v2Markdown, "v2 正文落库");

  // 最新一版仍可写（席位轮番改稿不丢来源）。
  assertEqual(h.store.updateMarkdown(v3.id, deliverableMarkdown("第三版结论（置信度：中）", "- kc-9"), "seat-3").ok, true, "最新版可写");
  assertEqual(h.store.get(v3.id)?.status, "ready", "最新版转 ready");
  assertEqual(h.store.get(v1.id)?.status, "superseded", "更高 version 首次 ready 后更低的 ready 标 superseded");
  assertEqual(h.store.revisionLog().length, 3, "被拒的写入不进修订链");
  assertEqual(h.store.updateMarkdown(v3.id, deliverableMarkdown("第三版改稿（置信度：高）", "- kc-9\n- seq=8"), "seat-1").ok, true, "同一最新版可再改稿");
  assertEqual(h.store.revisionLog().length, 4, "二次改稿追加修订记录");
  assertEqual(h.store.get(v3.id)?.sections.conclusions, "第三版改稿（置信度：高）", "改稿后的结论");

  const missing = h.store.updateMarkdown("no-such-id", "x", "seat-1");
  assertEqual(missing.ok, false, "未知 id 被拒");
  assertEqual(missing.ok === false ? missing.currentVersion : 0, 3, "未知 id 也给出当前版本号");
});

await run("两个 drafting：后继不挡住先建那版的首次 publish", async () => {
  const h = makeStore();
  const v1 = h.store.create({ author: "system" });
  const v2 = h.store.create({ author: "seat-2", basedOnVersion: 1 });
  const markdown = deliverableMarkdown("先建那版（置信度：中）", "- a");
  assertEqual(h.store.updateMarkdown(v1.id, markdown, "system").ok, true, "v1 虽有 drafting 后继仍可首次 publish");
  assertEqual(h.store.get(v1.id)?.status, "ready", "v1 转 ready");
  assertEqual(h.store.get(v2.id)?.status, "drafting", "后继仍是 drafting");
});

await run("updateMarkdown CAS（F2-3）：同一 revision 的第二次修订被拒且正文不被覆盖", async () => {
  const h = makeStore();
  const v1 = h.store.create({ author: "system" });
  assertEqual(v1.revision, 1, "create 的 revision = 1（调用方拿到的 CAS 令牌）");

  const markdownA = deliverableMarkdown("A 的结论（置信度：中）", "- a");
  const markdownB = deliverableMarkdown("B 的结论（置信度：高）", "- b");

  // A 与 B 都基于 revision 1 提交：先到的成功，后到的拿冲突（不再静默覆盖）。
  const first = h.store.updateMarkdown(v1.id, markdownA, "seat-A", 1);
  assertEqual(first.ok, true, "基于 revision 1 的第一次修订成功");
  assertEqual(h.store.get(v1.id)?.revision, 2, "成功后 revision +1");

  const second = h.store.updateMarkdown(v1.id, markdownB, "seat-B", 1);
  assertEqual(second.ok, false, "拿旧 revision 的第二次修订被拒");
  assertEqual(second.ok === false ? second.conflict : false, true, "返回 conflict:true");
  assertEqual(second.ok === false ? second.currentVersion : 0, 1, "冲突回报当前版本号");
  assertEqual(second.ok === false ? second.currentRevision : 0, 2, "冲突回报当前 revision（调用方据此重投）");
  assertEqual(h.store.get(v1.id)?.markdown, markdownA, "先写者的正文没有被覆盖");
  assertEqual(h.store.revisionLog().length, 1, "被拒的写入不进修订链");

  // 拿到 currentRevision 重投：成功。
  const retry = h.store.updateMarkdown(v1.id, markdownB, "seat-B", 2);
  assertEqual(retry.ok, true, "基于 currentRevision 重投成功");
  assertEqual(h.store.get(v1.id)?.revision, 3, "重投后 revision = 3");
  assertEqual(h.store.get(v1.id)?.markdown, markdownB, "重投的正文落库");

  // 修订链只记 revision / actor / 长度，不存正文。
  const log = h.store.revisionLog();
  assertEqual(log.map((entry) => entry.revision).join(","), "2,3", "修订链记下每轮的 revision");
  assertEqual(log[0]?.version, 1, "修订链仍带版本号");
  assertEqual(log[0]?.chars, markdownA.length, "修订链只记正文长度");
  assertEqual(log.every((entry) => !("markdown" in entry)), true, "修订链不存正文");
});

await run("restore 兼容旧快照（F2-3）：缺 revision 补 1，CAS 仍可工作", async () => {
  const h = makeStore();
  const legacy = {
    id: "legacy-1",
    version: 1,
    cutoffSeq: 3,
    createdAt: 1,
    author: "system",
    status: "ready",
    markdown: "旧版正文",
    stances: [],
    sections: { conclusions: "", evidenceIndex: "", disagreements: "", nextActions: "", processIndex: "" },
  } as unknown as DeliverableVersion;

  h.store.restore([legacy]);
  assertEqual(h.store.get("legacy-1")?.revision, 1, "旧快照缺 revision → 补 1");
  assertEqual(h.store.get("legacy-1")?.markdown, "旧版正文", "旧正文保留");

  const result = h.store.updateMarkdown(
    "legacy-1",
    deliverableMarkdown("补的结论（置信度：低）", "- 未验证"),
    "seat-1",
    1,
  );
  assertEqual(result.ok, true, "补过 revision 的旧版仍可 CAS 写入");
  assertEqual(h.store.get("legacy-1")?.revision, 2, "写入后 revision = 2");
});

await run("setStance：支持 / 反对 / 有条件 / 缺席，重复表态覆盖", async () => {
  const h = makeStore();
  const v1 = h.store.create({ author: "system" });
  h.store.updateMarkdown(v1.id, deliverableMarkdown("结论（置信度：中）", "- 未验证"), "system");

  assertEqual(h.store.setStance(v1.id, "seat-1", "support", "有实验依据", "high").ok, true, "seat-1 支持");
  assertEqual(h.store.setStance(v1.id, "seat-2", "oppose", "成本过高", "medium").ok, true, "seat-2 反对");
  assertEqual(h.store.setStance(v1.id, "seat-3", "absent").ok, true, "seat-3 缺席（未表态）");

  const stances = h.store.get(v1.id)?.stances ?? [];
  assertEqual(stances.length, 3, "三条表态");
  const seat1 = stances.find((entry) => entry.seatId === "seat-1");
  assertEqual(seat1?.stance, "support", "seat-1 读回 support");
  assertEqual(seat1?.reason, "有实验依据", "理由读回");
  assertEqual(seat1?.confidence, "high", "置信度读回");
  assertEqual(stances.find((entry) => entry.seatId === "seat-3")?.stance, "absent", "没投的席位读回 absent");

  assertEqual(h.store.setStance(v1.id, "seat-2", "conditional", "先降规模", "low").ok, true, "同席改口");
  const updated = h.store.get(v1.id)?.stances ?? [];
  assertEqual(updated.length, 3, "改口是覆盖不是追加");
  assertEqual(updated.find((entry) => entry.seatId === "seat-2")?.stance, "conditional", "seat-2 读回 conditional");
  assertEqual(updated.find((entry) => entry.seatId === "seat-2")?.confidence, "low", "改口后的置信度");

  const bad = h.store.setStance("no-such-id", "seat-1", "support");
  assertEqual(bad.ok, false, "未知交付物 id → error");
  assertEqual(bad.ok === false ? bad.error.length > 0 : false, true, "错误信息非空");
});

await run("list / get 返回副本，restore 往返", async () => {
  const h = makeStore();
  h.timeline.lastSeq = 5;
  const v1 = h.store.create({ author: "system" });
  h.store.updateMarkdown(v1.id, deliverableMarkdown("一（置信度：低）", "- a"), "system");
  h.timeline.lastSeq = 9;
  const v2 = h.store.create({ author: "seat-1", basedOnVersion: 1 });

  assertEqual(h.store.list().map((entry) => entry.version).join(","), "1,2", "list 从旧到新");
  assertEqual(h.store.get("no-such-id"), undefined, "get 未知 id → undefined");

  const copy = h.store.get(v1.id);
  if (copy !== undefined) {
    copy.markdown = "被改过的副本";
    copy.sections.conclusions = "被改过";
    copy.stances?.push({ seatId: "seat-9", stance: "support" });
  }
  assertEqual(h.store.get(v1.id)?.markdown !== "被改过的副本", true, "get 返回副本：改副本不影响 store");
  assertEqual(h.store.get(v1.id)?.stances?.length ?? 0, 0, "stances 也是副本");

  const restored = makeStore().store;
  restored.restore(h.store.list());
  assertEqual(restored.list().length, 2, "restore 放回全部版本");
  assertEqual(restored.get(v2.id)?.basedOnVersion, 1, "restore 保留基准版本");
  assertEqual(restored.get(v1.id)?.cutoffSeq, 5, "restore 保留截止点");
});

// ============================================================================
// OpenItemBoard
// ============================================================================

await run("OpenItemBoard：open / claim / releaseOwned（H9）/ resolve / drop", async () => {
  const clock = { at: 1_000 };
  const board = new OpenItemBoard(() => clock.at);
  const item = board.open({ subject: "向量库选型", body: "待确认", createdBy: "seat-1" });

  assertEqual(item.status, "open", "新建即 open");
  assertEqual(item.claimedBy, undefined, "没人认领");
  assertEqual(board.list().length, 1, "list 有一条");

  const claimed = board.claim(item.id, "seat-2", "我来核这个口径");
  assertEqual(claimed?.status, "claimed", "自愿认领 → claimed");
  assertEqual(claimed?.claimedBy, "seat-2", "claimedBy 记录认领席");
  assertEqual(claimed?.claimNote, "我来核这个口径", "claim note 写回");
  assertEqual(board.claim(item.id, "seat-3"), null, "已被认领：别人不能抢");
  assertEqual(board.releaseOwned("seat-3").length, 0, "非认领席的 releaseOwned 不动这项");
  assertEqual(board.get(item.id)?.status, "claimed", "别人的项不受影响");

  const released = board.releaseOwned("seat-2");
  assertEqual(released.length, 1, "认领席退出：退回一条");
  assertEqual(released[0]?.status, "open", "退回 open");
  assertEqual(released[0]?.claimedBy, undefined, "claimedBy 清空");
  assertEqual(board.get(item.id)?.claimedBy, undefined, "store 里也清空了");

  assertEqual(board.claim(item.id, "seat-3")?.claimedBy, "seat-3", "退回后别人可以接着认领");
  const resolved = board.resolve(item.id, "seat-3", "选 A");
  assertEqual(resolved?.status, "resolved", "给出结论 → resolved");
  assertEqual(resolved?.body.includes("选 A"), true, "结论写进 body");
  assertEqual(board.resolve(item.id, "seat-3"), null, "已解决不能再解决");

  const second = board.open({ subject: "再看 B", body: "y", createdBy: "seat-1" });
  assertEqual(board.drop(second.id)?.status, "dropped", "drop → dropped");
  assertEqual(board.claim(second.id, "seat-1"), null, "丢弃的项不能被认领");
  assertEqual(board.get("no-such-id"), undefined, "get 未知 id → undefined");
  assertEqual(board.list().length, 2, "list 有两条");

  const copy = board.list()[0];
  if (copy !== undefined) {
    copy.subject = "被改过";
  }
  assertEqual(board.get(item.id)?.subject, "向量库选型", "list 返回副本");

  const restored = new OpenItemBoard();
  restored.restore(board.list());
  assertEqual(restored.list().length, 2, "restore 往返");
  assertEqual(restored.get(second.id)?.status, "dropped", "restore 保留状态");
});

// ============================================================================
// AttentionBus
// ============================================================================

await run("AttentionBus：push 补 id/ts/acked，ack 后 unackedOnly 不再返回", async () => {
  const clock = { at: 500 };
  const bus = new AttentionBus(() => clock.at);

  const first = bus.push({ kind: "user_mentioned", text: "被用户点名", seatId: "seat-1", refId: "m-1" });
  assert(first.id.length > 0, "id 自动生成");
  assertEqual(first.ts, 500, "ts 取注入时钟");
  assertEqual(first.acked, false, "新条目未确认");
  assertEqual(first.kind, "user_mentioned", "kind 原样保存");

  clock.at = 900;
  const second = bus.push({ kind: "permission", text: "需要批准", refId: "req-1" });
  assertEqual(second.ts, 900, "第二条用自己的时间");

  const explicit = bus.push({ id: "fixed-id", ts: 111, kind: "hard_stop", text: "硬停止" });
  assertEqual(explicit.id, "fixed-id", "显式 id 不被覆盖");
  assertEqual(explicit.ts, 111, "显式 ts 不被覆盖");
  assertEqual(bus.push({ id: "fixed-id", ts: 222, kind: "hard_stop", text: "重复" }).ts, 111, "重复 id 不覆盖已有条目");
  assertEqual(bus.list().length, 3, "重复 id 不产生第二条");

  bus.ack(first.id);
  assertEqual(bus.list().find((entry) => entry.id === first.id)?.acked, true, "ack 后 acked=true");
  assertEqual(bus.list(true).length, 2, "unackedOnly 只回未确认的");
  assertEqual(bus.list().length, 3, "list() 仍含已确认的");

  bus.ack("no-such-id");
  assertEqual(bus.list(true).length, 2, "ack 未知 id 是 no-op");
  assertEqual(bus.list().map((entry) => entry.ts).join(","), "111,500,900", "list 按时间排序");

  const restored = new AttentionBus(() => 0);
  restored.restore(bus.list());
  assertEqual(restored.list().length, 3, "restore 放回全部条目");
  assertEqual(restored.list(true).length, 2, "restore 保留 acked 状态");
});

// ============================================================================

console.log("\n=== Summary ===\n");
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
