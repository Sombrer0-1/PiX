/**
 * TimelineLog + SeatInbox tests (S2a, plan §4.3/§4.4 + H6/H7/H21/H36/H37/H41/H42).
 *
 * Covers:
 *   - the §4.4 packing example: pending [user U, mention M, note N1(old), note N2(new)]
 *     with a budget that only fits U+M+N2 -> injectedIds {U,M,N2}, N1 still pending
 *   - packForNextCall does not change state; commitInjected is the only transition
 *   - a private message body lives in InboxEntry.text while the timeline stub is empty
 *   - broadcast excludes the sender; mention / user priorities (H21 / H41)
 *   - an over-budget entry stays pending and its original text stays retrievable
 *   - restore does not re-pend injected ids; private text survives a JSON round-trip
 *   - onChange fires on enqueue and on commitInjected
 *   - the same messageId never lands twice in one seat's pending list
 *   - the H7 cap folds the oldest non-user non-mention entries into one pending
 *     summary without deleting timeline originals
 *
 * Run with: npx tsx pix/src/main/__tests__/team-inbox.test.ts
 */

import {
  USER_SEAT_ID,
  type InboxEntry,
  type PackedContext,
  type SeatInfo,
  type TimelineItem,
} from "../../shared/team-types.js";
import { MAX_PENDING_INJECT_PER_SEAT } from "../team/constants.js";
import { SeatInbox, parseMentions } from "../team/seat-inbox.js";
import { TimelineLog } from "../team/timeline-log.js";

// ============================================================================
// Test harness (matches team-ids.test.ts / execution-context.test.ts style)
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

const RT = "rt-1";
const SEAT_A = `sources::${RT}`;
const SEAT_B = `counterexample::${RT}`;
const SEAT_C = `theory::${RT}`;
const NOW = 1_700_000_000_000;

function makeSeat(name: string, slug: string): SeatInfo {
  return {
    name,
    slug,
    seatId: `${slug}::${RT}`,
    perspective: name,
    auth: "read_only",
    color: "#16a34a",
    status: "idle",
    createdAt: NOW,
    statusChangedAt: NOW,
  };
}

function baseItem(id: string): Omit<TimelineItem, "seq"> {
  return {
    id,
    ts: NOW,
    type: "utterance",
    fromId: SEAT_A,
    toId: "*",
    text: "",
    summary: "",
    mentionIds: [],
  };
}

/** append 一条时间线条目，overrides 覆盖默认字段。 */
function appendItem(
  log: TimelineLog,
  id: string,
  overrides: Partial<Omit<TimelineItem, "id" | "seq">> = {},
): TimelineItem {
  return log.append(Object.assign(baseItem(id), overrides));
}

function idsOf(entries: InboxEntry[]): string[] {
  return entries.map((entry) => entry.messageId);
}

function foldSummaries(entries: InboxEntry[]): InboxEntry[] {
  return entries.filter((entry) => entry.messageId.startsWith("fold:"));
}

function stateOf(entries: InboxEntry[], messageId: string): string | undefined {
  return entries.find((entry) => entry.messageId === messageId)?.state;
}

/** 与 seat-inbox 的估算一致（H6：字符 / 4 向上取整），用来断言整包不超预算。 */
function estimateBlockTokens(packed: PackedContext): number {
  return packed.blocks.reduce((sum, block) => sum + Math.ceil(block.text.length / 4), 0);
}

// ============================================================================
// §4.4 packing example + state machine
// ============================================================================

await run("§4.4 example: pack picks user + mention + newest note; N1 stays pending", async () => {
  const log = new TimelineLog();
  const inbox = new SeatInbox();

  const U = appendItem(log, "U", { type: "user", fromId: USER_SEAT_ID, text: "u".repeat(40), summary: "user" });
  const M = appendItem(log, "M", { fromId: SEAT_A, toId: SEAT_B, text: "m".repeat(40), summary: "mention", mentionIds: [SEAT_B] });
  const N1 = appendItem(log, "N1", { fromId: SEAT_A, text: "n".repeat(400), summary: "old note" });
  const N2 = appendItem(log, "N2", { fromId: SEAT_A, text: "p".repeat(40), summary: "new note" });

  inbox.enqueue(U, [SEAT_B]);
  inbox.enqueue(M, [SEAT_B]);
  inbox.enqueue(N1, [SEAT_B]);
  inbox.enqueue(N2, [SEAT_B]);
  assertEqual(inbox.pending(SEAT_B).length, 4, "all four messages are pending before packing");

  // 10 + 10 + 10 tokens fit exactly; N1 (100 tokens) does not.
  const packed = inbox.packForNextCall(SEAT_B, 30);
  assertEqual(packed.injectedIds.join(","), "U,M,N2", "injectedIds is exactly {U,M,N2}");
  assertEqual(packed.stillPendingIds.join(","), "N1", "stillPendingIds is exactly {N1}");
  assert(
    packed.blocks.filter((block) => block.mode === "original").map((block) => block.messageId).join(",") === "U,M,N2",
    "original blocks follow the injected order",
  );
  const summaryBlock = packed.blocks.find((block) => block.mode === "summary");
  // F2-2：预算刚好用尽（剩余 0）→ 不追加摘要块（旧行为会追加无上限摘要）。
  assertEqual(summaryBlock, undefined, "预算用尽时不追加摘要块（F2-2）");
  assertEqual(packed.blocks.length, 3, "本 call 只有三条原文块");
  assert(
    packed.blocks.every((block) => block.text !== N1.text),
    "N1's full text is not part of this call",
  );
  // 有剩余预算时才贡献一行摘要（§4.4 步骤 4）。
  const withRoom = inbox.packForNextCall(SEAT_B, 45);
  const roomySummary = withRoom.blocks.find((block) => block.mode === "summary");
  assert(roomySummary !== undefined, "N1 contributes one summary block when the budget allows");
  assertEqual(roomySummary?.messageId, N1.id, "the summary block is attributed to N1");
  assert(roomySummary?.text.includes("N1") === true, "the summary block names the omitted message");
  assert(packed.callId.length > 0, "packForNextCall returns a callId");
  assert(
    inbox.packForNextCall(SEAT_B, 30).callId !== packed.callId,
    "the callId is fresh per call",
  );
});

await run("packForNextCall does not change state; commitInjected is the only transition", async () => {
  const log = new TimelineLog();
  const inbox = new SeatInbox();
  const U = appendItem(log, "U", { type: "user", fromId: USER_SEAT_ID, text: "u".repeat(40) });
  const M = appendItem(log, "M", { fromId: SEAT_A, toId: SEAT_B, text: "m".repeat(40), mentionIds: [SEAT_B] });
  const N1 = appendItem(log, "N1", { fromId: SEAT_A, text: "n".repeat(400) });
  const N2 = appendItem(log, "N2", { fromId: SEAT_A, text: "p".repeat(40) });
  for (const item of [U, M, N1, N2]) {
    inbox.enqueue(item, [SEAT_B]);
  }

  const packed = inbox.packForNextCall(SEAT_B, 30);
  assertEqual(inbox.pending(SEAT_B).length, 4, "packing leaves all four entries pending");
  assert(
    inbox.snapshot().every((entry) => entry.state === "pending_inject"),
    "packing changes no InboxEntry state",
  );
  assertEqual(
    inbox.pending(SEAT_B).find((entry) => entry.messageId === "N1")?.text,
    N1.text,
    "the over-budget original text is still in the pending entry",
  );

  inbox.commitInjected(SEAT_B, packed.injectedIds, packed.callId);
  const after = inbox.snapshot();
  assertEqual(inbox.pending(SEAT_B).length, 1, "only the un-injected entry stays pending");
  assertEqual(stateOf(after, "U"), "injected", "U is injected after commit");
  assertEqual(stateOf(after, "M"), "injected", "M is injected after commit");
  assertEqual(stateOf(after, "N2"), "injected", "N2 is injected after commit");
  assertEqual(stateOf(after, "N1"), "pending_inject", "an id that was not committed stays pending (H37)");
  const injected = after.find((entry) => entry.messageId === "U");
  assertEqual(injected?.injectedInCallId, packed.callId, "injectedInCallId records the packing call");
  assertEqual(typeof injected?.injectedAt, "number", "injectedAt is stamped");
  assertEqual(after.find((entry) => entry.messageId === "N1")?.injectedAt, undefined, "pending entries keep no injectedAt");

  // Unknown ids and a second commit are no-ops, never errors.
  inbox.commitInjected(SEAT_B, ["does-not-exist"], "call-x");
  inbox.commitInjected(SEAT_B, packed.injectedIds, packed.callId);
  assertEqual(inbox.pending(SEAT_B).length, 1, "re-committing stays idempotent");
});

await run("H36: private body lives in InboxEntry.text while the timeline stub is empty", async () => {
  const log = new TimelineLog();
  const inbox = new SeatInbox();
  const body = "这是只给该席位的私密正文。";

  const stub = appendItem(log, "P1", {
    type: "private_stub",
    fromId: USER_SEAT_ID,
    toId: SEAT_A,
    text: "",
    summary: "私密消息",
    privateStub: { fromId: USER_SEAT_ID, toId: SEAT_A },
  });
  assertEqual(stub.text, "", "the recorded timeline item keeps an empty text");

  inbox.enqueue({ ...stub, text: body }, [SEAT_A]);
  const pending = inbox.pending(SEAT_A);
  assertEqual(pending.length, 1, "the private message reaches the target seat");
  assertEqual(pending[0]?.text, body, "the body is carried by InboxEntry.text");
  assert(pending[0] !== undefined && pending[0].text.length > 0, "the private body is non-empty");
  assertEqual(pending[0]?.priority, "user", "a user private message has user priority");
  assertEqual(log.getById("P1")?.text, "", "the timeline copy is still empty after enqueue");

  const packed = inbox.packForNextCall(SEAT_A, 10_000);
  assertEqual(packed.blocks[0]?.text, body, "the private body is what gets injected");
  assertEqual(inbox.pending(SEAT_C).length, 0, "a private message only reaches the addressed seat");
});

await run("broadcast excludes the sender; mention/user priorities (H21 / H41)", async () => {
  const log = new TimelineLog();
  const active = [SEAT_A, SEAT_B, SEAT_C];
  const inbox = new SeatInbox({ getActiveSeatIds: () => [...active, USER_SEAT_ID] });

  const broadcast = appendItem(log, "B1", { fromId: SEAT_A, text: "b1".repeat(10) });
  inbox.enqueue(broadcast, ["*"]);
  assertEqual(inbox.pending(SEAT_A).length, 0, "the sender never receives its own broadcast");
  assertEqual(inbox.pending(SEAT_B).length, 1, "broadcast reaches seat B");
  assertEqual(inbox.pending(SEAT_C).length, 1, "broadcast reaches seat C");

  // An explicit target list that still contains the sender and the user.
  const second = appendItem(log, "B2", { fromId: SEAT_B, text: "b2".repeat(10) });
  inbox.enqueue(second, [SEAT_A, SEAT_B, USER_SEAT_ID]);
  assertEqual(inbox.pending(SEAT_B).length, 1, "the sender is dropped from an explicit target list");
  assertEqual(inbox.pending(SEAT_A).length, 1, "the remaining target still receives it");
  assertEqual(
    inbox.snapshot().some((entry) => entry.seatId === USER_SEAT_ID),
    false,
    "the user never gets a seat inbox entry",
  );

  // H21/H41: mentionIds drive priority "mention".
  const mention = appendItem(log, "B3", { fromId: SEAT_A, mentionIds: [SEAT_C], text: "b3".repeat(10) });
  inbox.enqueue(mention, [SEAT_B, SEAT_C]);
  assertEqual(
    inbox.pending(SEAT_C).find((entry) => entry.messageId === "B3")?.priority,
    "mention",
    "the @-mentioned seat gets priority mention",
  );
  assertEqual(
    inbox.pending(SEAT_B).find((entry) => entry.messageId === "B3")?.priority,
    "normal",
    "a non-mentioned seat gets priority normal",
  );

  // A user message wins over mention.
  const userItem = appendItem(log, "B4", {
    type: "user",
    fromId: USER_SEAT_ID,
    mentionIds: [SEAT_C],
    text: "b4".repeat(10),
  });
  inbox.enqueue(userItem, [SEAT_B, SEAT_C]);
  assertEqual(
    inbox.pending(SEAT_B).find((entry) => entry.messageId === "B4")?.priority,
    "user",
    "user messages are priority user",
  );
  assertEqual(
    inbox.pending(SEAT_C).find((entry) => entry.messageId === "B4")?.priority,
    "user",
    "user priority wins over mention",
  );

  // Priority ordering: user and mention are packed before the newest normal note.
  const packed = inbox.packForNextCall(SEAT_C, 0);
  assertEqual(packed.injectedIds.length, 0, "a zero budget injects nothing");
  assertEqual(packed.stillPendingIds.join(","), "B4,B3,B1", "packing order is user > mention > normal, newest first");
});

await run("packing order: same-timestamp entries break ties by arrival order", async () => {
  const inbox = new SeatInbox();
  inbox.restore([
    { messageId: "r1", seatId: SEAT_B, state: "pending_inject", text: "a".repeat(40), enqueuedAt: NOW, priority: "normal" },
    { messageId: "r2", seatId: SEAT_B, state: "pending_inject", text: "b".repeat(40), enqueuedAt: NOW, priority: "normal" },
  ]);

  // Only one 10-token entry fits, so the winner reveals the ordering.
  const packed = inbox.packForNextCall(SEAT_B, 10);
  assertEqual(packed.injectedIds.join(","), "r2", "the later arrival wins the tie");
  assertEqual(packed.stillPendingIds.join(","), "r1", "the earlier arrival stays pending");
});

await run("over-budget entry stays pending and its original text stays retrievable", async () => {
  const log = new TimelineLog();
  const inbox = new SeatInbox();
  const longText = "很长的正文。".repeat(400);
  const long = appendItem(log, "L1", { fromId: SEAT_A, text: longText, summary: "长时间线条目" });
  const short = appendItem(log, "S1", { fromId: SEAT_A, text: "短消息", summary: "短" });
  inbox.enqueue(long, [SEAT_B]);
  inbox.enqueue(short, [SEAT_B]);

  const packed = inbox.packForNextCall(SEAT_B, 20);
  assertEqual(packed.injectedIds.join(","), "S1", "only the entry inside the budget is injected");
  assert(packed.stillPendingIds.includes("L1"), "the over-budget entry stays pending");
  assert(
    packed.blocks.some((block) => block.mode === "summary" && block.messageId === "L1"),
    "the over-budget entry appears as one summary block",
  );
  assertEqual(
    inbox.pending(SEAT_B).find((entry) => entry.messageId === "L1")?.text,
    longText,
    "its original text is still in the inbox entry",
  );
  assertEqual(log.getById("L1")?.text, longText, "its original text is still in the timeline");
  assertEqual(
    inbox.packForNextCall(SEAT_B, 10_000).injectedIds.includes("L1"),
    true,
    "with a large enough budget the original is injected",
  );
});

await run("restore does not re-pend injected ids; private text survives a JSON round-trip", async () => {
  const log = new TimelineLog();
  const inbox = new SeatInbox();
  const body = "私密正文不能丢。";
  const stub = appendItem(log, "P1", {
    type: "private_stub",
    fromId: USER_SEAT_ID,
    toId: SEAT_B,
    text: "",
    privateStub: { fromId: USER_SEAT_ID, toId: SEAT_B },
  });
  const note = appendItem(log, "N1", { fromId: SEAT_A, text: "note", summary: "note" });
  inbox.enqueue({ ...stub, text: body }, [SEAT_B]);
  inbox.enqueue(note, [SEAT_B]);

  const packed = inbox.packForNextCall(SEAT_B, 10_000);
  assertEqual(packed.injectedIds.join(","), "P1,N1", "both entries fit the budget");
  inbox.commitInjected(SEAT_B, packed.injectedIds, packed.callId);

  const persisted = JSON.parse(JSON.stringify(inbox.snapshot())) as InboxEntry[];
  assertEqual(persisted.length, 2, "snapshot is JSON-serializable");
  const restored = new SeatInbox();
  restored.restore(persisted);
  assertEqual(restored.pending(SEAT_B).length, 0, "already-injected ids do not come back as pending");
  assertEqual(stateOf(restored.snapshot(), "P1"), "injected", "P1 restores as injected");

  // A pending entry with a private body survives the round-trip with its text.
  const pendingPrivate = appendItem(log, "P2", {
    type: "private_stub",
    fromId: USER_SEAT_ID,
    toId: SEAT_B,
    text: "",
    privateStub: { fromId: USER_SEAT_ID, toId: SEAT_B },
  });
  inbox.enqueue({ ...pendingPrivate, text: body }, [SEAT_B]);
  const revived = new SeatInbox();
  revived.restore(JSON.parse(JSON.stringify(inbox.snapshot())) as InboxEntry[]);
  const revivedPending = revived.pending(SEAT_B);
  assertEqual(revivedPending.length, 1, "the uncommitted entry restores as pending");
  assertEqual(revivedPending[0]?.text, body, "the private body is intact after restore");
  assertEqual(revivedPending[0]?.messageId, "P2", "the entry keeps its messageId");

  // An injected copy never regresses to pending, even if a pending copy arrives later.
  revived.restore([
    { messageId: "P2", seatId: SEAT_B, state: "injected", text: body, enqueuedAt: NOW, priority: "user", injectedAt: NOW, injectedInCallId: "call-z" },
  ]);
  assertEqual(revived.pending(SEAT_B).length, 0, "a later injected copy is not pulled back to pending");
  assertEqual(stateOf(revived.snapshot(), "P2"), "injected", "the entry keeps the injected state");
});

await run("onChange fires on enqueue and on commitInjected (H42)", async () => {
  const log = new TimelineLog();
  const inbox = new SeatInbox();
  const events: string[] = [];
  const unsubscribe = inbox.onChange((seatId) => events.push(seatId));

  const item = appendItem(log, "N1", { fromId: SEAT_A, text: "note" });
  inbox.enqueue(item, [SEAT_B]);
  assertEqual(events.length, 1, "enqueue fires onChange once");
  assertEqual(events[0], SEAT_B, "onChange reports the affected seat");

  inbox.enqueue(item, [SEAT_B]);
  assertEqual(events.length, 1, "a deduped enqueue is not a state change");

  inbox.enqueue(item, [SEAT_B, SEAT_C]);
  assertEqual(events.length, 2, "a new target seat fires onChange too");
  assertEqual(events[1], SEAT_C, "the second notification is for the second seat");

  const packed = inbox.packForNextCall(SEAT_B, 1_000);
  assertEqual(events.length, 2, "packing alone does not fire onChange");
  inbox.commitInjected(SEAT_B, packed.injectedIds, packed.callId);
  assertEqual(events.length, 3, "commitInjected fires onChange");
  assertEqual(events[2], SEAT_B, "the commit notification carries the seat id");

  inbox.commitInjected(SEAT_B, packed.injectedIds, packed.callId);
  assertEqual(events.length, 3, "a no-op commit does not fire");

  unsubscribe();
  inbox.enqueue(appendItem(log, "N2", { fromId: SEAT_A }), [SEAT_B]);
  assertEqual(events.length, 3, "unsubscribe stops notifications");
});

await run("dedupe: the same messageId never lands twice in one seat's pending list", async () => {
  const log = new TimelineLog();
  const inbox = new SeatInbox();
  const item = appendItem(log, "N1", { fromId: SEAT_A, text: "第一次" });
  inbox.enqueue(item, [SEAT_B, SEAT_C]);
  inbox.enqueue(item, [SEAT_B]);
  inbox.enqueue({ ...item, text: "第二次" }, [SEAT_B, SEAT_C]);

  const pendingB = inbox.pending(SEAT_B);
  assertEqual(pendingB.length, 1, "the same messageId is pending once");
  assertEqual(pendingB[0]?.text, "第一次", "the first delivery keeps its body");
  assertEqual(inbox.pending(SEAT_C).length, 1, "the other seat is deduped as well");
  assertEqual(inbox.snapshot().length, 2, "one entry per target seat, not per enqueue call");
});

// ============================================================================
// H7 backpressure
// ============================================================================

await run("H7 字面值：每席 pending_inject 上限 = 500（Plan H7）", async () => {
  // T-1：断言协议数值本身，而不是拿它当构造输入。下面几条折叠用例都用常量构造
  // 循环次数，常量被改小仍然全绿；这条是唯一能抓住「上限被偷偷改掉」的断言。
  assertEqual(MAX_PENDING_INJECT_PER_SEAT, 500, "MAX_PENDING_INJECT_PER_SEAT === 500（Plan H7）");
});

await run("H7 cap: oldest non-user non-mention entries fold into one pending summary", async () => {
  const log = new TimelineLog();
  const inbox = new SeatInbox();
  const originalText = new Map<string, string>();
  const foldEvents: string[] = [];
  inbox.onChange((seatId) => foldEvents.push(seatId));
  const push = (id: string): void => {
    const text = `低优先级正文 ${id}`;
    originalText.set(id, text);
    inbox.enqueue(appendItem(log, id, { fromId: SEAT_A, text, summary: text }), [SEAT_B]);
  };

  // One entry over the cap folds the two oldest into a single summary.
  for (let index = 1; index <= MAX_PENDING_INJECT_PER_SEAT + 1; index++) {
    push(`n${index}`);
  }
  const pending = inbox.pending(SEAT_B);
  assertEqual(pending.length, MAX_PENDING_INJECT_PER_SEAT, "pending_inject is folded back to the cap");
  assert(foldEvents.includes(SEAT_B), "折叠会发 onChange（F2-1：facade 据此投影 delivery_changed）");
  const summaries = foldSummaries(pending);
  assertEqual(summaries.length, 1, "exactly one replacement summary stays pending");
  assertEqual(summaries[0]?.state, "pending_inject", "the folded summary is still pending_inject");
  assertEqual(summaries[0]?.priority, "normal", "the folded summary is ordinary priority");
  assert(
    summaries[0] !== undefined && summaries[0].text.includes("n1") && summaries[0].text.includes("n2"),
    "the summary names the folded originals",
  );
  const pendingIds = new Set(idsOf(pending));
  assertEqual(pendingIds.has("n1"), false, "the oldest entry left the pending list");
  assertEqual(pendingIds.has("n2"), false, "the second oldest entry left the pending list");
  assert(pendingIds.has(`n${MAX_PENDING_INJECT_PER_SEAT + 1}`), "the newest entry is still pending");

  // F2-1：折叠改状态而不删条目——条目仍在 snapshot 里（可落盘、可恢复、可审计）。
  // 删掉它 facade 的投递态 diff 就看不到这次变化，时间线会永远停在「待注入」。
  const snapshot = inbox.snapshot();
  assertEqual(stateOf(snapshot, "n1"), "folded", "被折叠条目的状态是 folded");
  assertEqual(stateOf(snapshot, "n2"), "folded", "第二条同样标成 folded");
  assertEqual(
    snapshot.find((entry) => entry.messageId === "n1")?.text,
    originalText.get("n1"),
    "被折叠条目保留正文（不是删除）",
  );
  assertEqual(snapshot.length, MAX_PENDING_INJECT_PER_SEAT + 2, "快照里原条目与折叠摘要都在");

  // Two more entries: the summary is folded again, still exactly one stays.
  push(`n${MAX_PENDING_INJECT_PER_SEAT + 2}`);
  push(`n${MAX_PENDING_INJECT_PER_SEAT + 3}`);
  const afterMore = inbox.pending(SEAT_B);
  assertEqual(afterMore.length, MAX_PENDING_INJECT_PER_SEAT, "the cap still holds after further folding");
  assertEqual(foldSummaries(afterMore).length, 1, "further folding never grows the summary count");

  const foldedIds = ["n1", "n2", "n3", "n4"];
  assertEqual(
    foldedIds.filter((id) => log.getById(id) === undefined).length,
    0,
    "no timeline original was deleted",
  );
  assertEqual(log.getById("n1")?.text, originalText.get("n1"), "the folded original text is intact in the timeline");
  assertEqual(log.list().length, MAX_PENDING_INJECT_PER_SEAT + 3, "the timeline still holds every appended item");
  assertEqual(
    afterMore.filter((entry) => entry.priority !== "normal").length,
    0,
    "nothing but ordinary entries were involved",
  );

  // restore 保留 folded：折叠过的条目不会变回 pending（F2-1 规则 3）。
  const revived = new SeatInbox();
  revived.restore(JSON.parse(JSON.stringify(inbox.snapshot())) as InboxEntry[]);
  assertEqual(stateOf(revived.snapshot(), "n1"), "folded", "restore 后仍是 folded");
  assertEqual(
    revived.pending(SEAT_B).some((entry) => entry.messageId === "n1"),
    false,
    "折叠过的条目恢复后不会重新变成 pending",
  );
});

await run("H7 cap: user and mention entries are never folded", async () => {
  const log = new TimelineLog();
  const inbox = new SeatInbox();
  const userItem = appendItem(log, "u1", { type: "user", fromId: USER_SEAT_ID, text: "用户消息" });
  const mentionItem = appendItem(log, "m1", { fromId: SEAT_A, mentionIds: [SEAT_B], text: "被点名" });
  inbox.enqueue(userItem, [SEAT_B]);
  inbox.enqueue(mentionItem, [SEAT_B]);

  for (let index = 1; index <= MAX_PENDING_INJECT_PER_SEAT + 5; index++) {
    const item = appendItem(log, `n${index}`, { fromId: SEAT_A, text: `低优先级 ${index}` });
    inbox.enqueue(item, [SEAT_B]);
  }

  const pending = inbox.pending(SEAT_B);
  assertEqual(pending.length, MAX_PENDING_INJECT_PER_SEAT, "the cap still holds with protected entries");
  assertEqual(
    pending.find((entry) => entry.messageId === "u1")?.priority,
    "user",
    "the user message survives the folding",
  );
  assertEqual(
    pending.find((entry) => entry.messageId === "m1")?.priority,
    "mention",
    "the @-mentioned message survives the folding",
  );
  assertEqual(foldSummaries(pending).length, 1, "the folded originals end up in one summary");
  assertEqual(log.getById("n1")?.text, "低优先级 1", "folded timeline originals are still retrievable");
});

await run("F2-2: the overflow summary is line-capped and counted against the budget", async () => {
  const log = new TimelineLog();
  const inbox = new SeatInbox();
  const LONG = "很长的正文片段。".repeat(500); // 4000 字符 ≈ 1000 token
  for (let index = 0; index < 30; index++) {
    inbox.enqueue(appendItem(log, `big${index}`, { fromId: SEAT_A, text: LONG }), [SEAT_B]);
  }
  assertEqual(inbox.pending(SEAT_B).length, 30, "30 条积压都在等注入（未到 H7 上限）");

  // 预算足够放下摘要全文、但一条原文也放不下：行数上限生效。
  const roomy = inbox.packForNextCall(SEAT_B, 600);
  assertEqual(roomy.injectedIds.length, 0, "原文一条都装不下，全部只贡献摘要");
  const summary = roomy.blocks.find((block) => block.mode === "summary");
  const text = summary?.text ?? "";
  assertEqual(
    text.split("\n").filter((line) => line.startsWith("- ")).length,
    21,
    "摘要最多 20 条摘录 + 1 行「另有 N 条未列出」",
  );
  assert(text.includes("另有 10 条未列出"), "超出上限的条数只报总数");
  assert(
    estimateBlockTokens(roomy) <= 600,
    `Σ(blocks 的 token 估算) ≤ budget（实际 ${estimateBlockTokens(roomy)}）`,
  );
  assertEqual(roomy.stillPendingIds.length, 30, "摘要块不消费原文：30 条仍 pending");

  // 预算很紧：摘要按剩余预算截断，整包绝不超预算（旧行为会追加无上限摘要）。
  const tight = inbox.packForNextCall(SEAT_B, 50);
  const tightSummary = tight.blocks.find((block) => block.mode === "summary");
  assert(tightSummary !== undefined, "剩余预算 > 0 时仍给一行摘要");
  assertEqual(tightSummary?.text.endsWith("…"), true, "超出剩余预算处截断并补省略号");
  assert(
    estimateBlockTokens(tight) <= 50,
    `截断后仍不超预算（实际 ${estimateBlockTokens(tight)}）`,
  );
  assertEqual(tight.stillPendingIds.length, 30, "被摘要到的原文仍 pending");
});

// ============================================================================
// H21 @ parsing
// ============================================================================

await run("parseMentions: @user / @用户 / display names / slugs (H21)", async () => {
  const roster: SeatInfo[] = [
    makeSeat("资料", "sources"),
    makeSeat("反例", "counterexample"),
    makeSeat("理论", "theory"),
    makeSeat("可行性", "feasibility"),
    makeSeat("实验", "experiment"),
    makeSeat("Seat Two", "seat-2"),
  ];

  assertEqual(parseMentions("@user 请看这里", roster).join(","), USER_SEAT_ID, "@user -> USER_SEAT_ID");
  assertEqual(parseMentions("@用户 请看这里", roster).join(","), USER_SEAT_ID, "@用户 -> USER_SEAT_ID");
  assertEqual(parseMentions("@USER", roster).join(","), USER_SEAT_ID, "@user is case-insensitive");
  assertEqual(
    parseMentions("@资料 核对一下出处", roster).join(","),
    `sources::${RT}`,
    "a Chinese display name resolves to its seatId",
  );
  assertEqual(
    parseMentions("@反例 还有反例吗", roster).join(","),
    `counterexample::${RT}`,
    "a second display name resolves independently",
  );
  assertEqual(
    parseMentions("@CounterExample 说两句", roster).join(","),
    `counterexample::${RT}`,
    "slug matching is case-insensitive",
  );
  assertEqual(
    parseMentions("@seat-2 你来", roster).join(","),
    `seat-2::${RT}`,
    "a hyphenated slug resolves",
  );
  assertEqual(parseMentions("没有点名", roster).length, 0, "text without @ yields nothing");
  assertEqual(parseMentions("@nobody 在吗", roster).length, 0, "an unmatched @foo is ordinary text");
  assertEqual(parseMentions("@", roster).length, 0, "a bare @ yields nothing");
  assertEqual(parseMentions("@资料员", roster).length, 0, "only whole names match, no prefix matching");
  assertEqual(parseMentions("", roster).length, 0, "empty text yields nothing");
  assertEqual(
    parseMentions("@资料 @资料 @user @用户", roster).join(","),
    `sources::${RT},${USER_SEAT_ID}`,
    "the result is de-duplicated and ordered by first appearance",
  );
  assertEqual(
    parseMentions("@资料，@反例。请都看一下", roster).join(","),
    `sources::${RT},counterexample::${RT}`,
    "punctuation terminates a mention token",
  );
  assertEqual(
    parseMentions("@理论\n@实验", roster).join(","),
    `theory::${RT},experiment::${RT}`,
    "newlines terminate mention tokens",
  );
});

// ============================================================================
// TimelineLog §4.3
// ============================================================================

await run("TimelineLog: append assigns seq, records mentionIds, never mutates the input", async () => {
  const log = new TimelineLog();
  assertEqual(log.lastSeq(), 0, "an empty log has lastSeq 0");
  assertEqual(log.nextSeq(), 1, "the first assigned seq is 1");

  const input = baseItem("m1");
  const appended = log.append(input);
  assertEqual(appended.seq, 1, "append returns the assigned seq");
  assertEqual((input as { seq?: number }).seq, undefined, "the caller's input is not mutated");
  assertEqual((input as { id?: string }).id, "m1", "the caller's input keeps its fields");
  assertEqual(appended.id, "m1", "a caller-provided id is kept");
  assertEqual(appended.mentionIds.join(","), "", "mentionIds is recorded as an empty array when omitted");
  assertEqual(appended.mentionIds.includes(SEAT_A), false, "no phantom mentions");

  // mentionIds defaults to [] at runtime (the type keeps it required for callers).
  const withoutMentions = log.append({
    ts: NOW,
    type: "system",
    fromId: "system",
    toId: "*",
    text: "系统公告",
    summary: "系统公告",
  } as unknown as Omit<TimelineItem, "seq" | "id"> & { id?: string; seq?: never });
  assertEqual(withoutMentions.mentionIds.length, 0, "mentionIds defaults to []");

  const generated = log.append({
    ts: NOW,
    type: "utterance",
    fromId: SEAT_A,
    toId: "*",
    text: "自动 id",
    summary: "自动 id",
    mentionIds: [],
  });
  assert(generated.id.length > 0, "append generates an id when the caller omits one");
  assertEqual(new Set([appended.id, withoutMentions.id, generated.id]).size, 3, "generated ids are unique");
  assertEqual(log.nextSeq(), 4, "nextSeq is one past the last assigned seq");
  assertEqual(log.lastSeq(), 3, "lastSeq is the last assigned seq");
  assertEqual(log.getById("m1")?.seq, 1, "getById finds a stored item");
  assertEqual(log.getById("missing"), undefined, "getById returns undefined for unknown ids");
  assertEqual(log.list().length, 3, "list returns every item");
});

await run("TimelineLog: list filters (seat / type / thread / q)", async () => {
  const log = new TimelineLog();
  appendItem(log, "m1", { fromId: SEAT_A, toId: "*", text: "假设 X 不成立", summary: "X 不成立" });
  appendItem(log, "m2", { fromId: SEAT_B, toId: SEAT_C, text: "同意", summary: "同意" });
  appendItem(log, "m3", { fromId: SEAT_A, toId: "*", text: "另一个线程", summary: "线程内", threadId: "t1" });
  appendItem(log, "m4", {
    fromId: SEAT_C,
    toId: "*",
    type: "knowledge_card",
    text: "",
    summary: "知识卡",
    knowledgeCard: {
      claim: "缓存是瓶颈",
      claimKind: "evidenced",
      confidence: "medium",
      evidence: [{ kind: "path", ref: "src/cache.ts" }],
    },
  });

  assertEqual(log.list({ threadId: null }).map((item) => item.id).join(","), "m1,m2,m4", "threadId null = main line only");
  assertEqual(log.list({ threadId: "t1" }).map((item) => item.id).join(","), "m3", "threadId string = that thread");
  assertEqual(log.list({ type: "knowledge_card" }).map((item) => item.id).join(","), "m4", "type filter");
  assertEqual(log.list({ seatId: SEAT_A }).map((item) => item.id).join(","), "m1,m3", "seat filter matches fromId");
  assertEqual(log.list({ seatId: SEAT_C }).map((item) => item.id).join(","), "m2,m4", "seat filter matches toId");
  assertEqual(
    log.list({ seatId: SEAT_B }).map((item) => item.id).join(","),
    "m2",
    "seat filter ignores unrelated items",
  );
  assertEqual(log.list({ q: "缓存" }).map((item) => item.id).join(","), "m4", "q searches the knowledge card claim");
  assertEqual(log.list({ q: "src/cache.ts" }).map((item) => item.id).join(","), "m4", "q searches evidence refs");
  assertEqual(log.list({ q: "同意" }).map((item) => item.id).join(","), "m2", "q searches text and summary");
  assertEqual(log.list({ q: "同意", threadId: null }).length, 1, "filters combine");

  const mention = appendItem(log, "m5", { fromId: SEAT_B, toId: "*", mentionIds: [SEAT_A] });
  assertEqual(mention.id, "m5", "an @ mention can be appended");
  assert(
    log.list({ seatId: SEAT_A }).some((item) => item.id === "m5"),
    "a mentioned seat sees the message in its filter",
  );
  assertEqual(log.list().length, 5, "filters never change the log");
});

await run("TimelineLog: buildJoinPacket digests the main line without replaying it", async () => {
  const log = new TimelineLog();
  const longBody = "长正文片段。".repeat(200);
  appendItem(log, "m1", { fromId: SEAT_A, toId: "*", text: "开场", summary: "开场设定" });
  appendItem(log, "m2", {
    fromId: SEAT_B,
    toId: "*",
    type: "knowledge_card",
    text: "",
    summary: "知识卡",
    knowledgeCard: {
      claim: "X 与 Y 相互独立",
      claimKind: "evidenced",
      confidence: "high",
      evidence: [{ kind: "command", ref: "npm test" }],
    },
  });
  appendItem(log, "m3", { fromId: SEAT_A, toId: "*", text: longBody, summary: "长发言" });
  appendItem(log, "m4", { fromId: SEAT_A, toId: "*", text: "线程内内容", summary: "线程内", threadId: "t1" });
  appendItem(log, "m5", { fromId: SEAT_C, toId: "*", text: longBody, summary: "" });

  const joined = log.buildJoinPacket();
  assert(joined.summary.length > 0, "the join packet has a summary text");
  assert(joined.summary.includes("主线 4 条记录"), "the summary counts the main line only");
  assert(joined.summary.includes(SEAT_A), "the summary lists the speaking seats");
  assert(joined.summary.includes("knowledge_card"), "the summary counts item types");
  assertEqual(joined.summary.includes(longBody), false, "the full text of a long item is not replayed");
  assert(
    joined.summary.includes(longBody.slice(0, 40)),
    "a summary-less long item appears only as a truncated excerpt",
  );
  assert(joined.summary.includes("…"), "the excerpt is visibly truncated");

  const indexIds = joined.index.map((entry) => entry.id);
  assert(indexIds.includes("m2"), "the knowledge card is indexed");
  assert(indexIds.includes("m3"), "each seat's newest main-line item is indexed");
  assertEqual(indexIds.includes("m4"), false, "thread items are not part of the seat digest");
  assertEqual(new Set(indexIds).size, indexIds.length, "index ids are unique");
  assert(
    joined.index.every((entry) => entry.title.length > 0 && entry.title.length <= 81),
    "index titles are non-empty and truncated",
  );
  assertEqual(
    log.buildJoinPacket().summary,
    joined.summary,
    "the join packet is stable for an unchanged log",
  );
});

await run("TimelineLog: overflowWindow collapses the oldest items", async () => {
  const log = new TimelineLog();
  for (let index = 1; index <= 10; index++) {
    appendItem(log, `m${index}`, { fromId: SEAT_A, text: `第 ${index} 条` });
  }

  const all = log.overflowWindow(20);
  assertEqual(all.collapsed, 0, "under the cap nothing collapses");
  assertEqual(all.items.length, 10, "all items are returned when they fit");

  const windowed = log.overflowWindow(4);
  assertEqual(windowed.collapsed, 6, "the older items are counted as collapsed");
  assertEqual(windowed.items.length, 4, "only the newest visibleCap items are returned");
  assertEqual(windowed.items[0]?.id, "m7", "the window starts at the oldest visible item");
  assertEqual(windowed.items[3]?.id, "m10", "the window ends at the newest item");
  assertEqual(log.getById("m1")?.text, "第 1 条", "collapsed originals are still retrievable");

  const empty = log.overflowWindow(0);
  assertEqual(empty.collapsed, 10, "a zero cap collapses everything");
  assertEqual(empty.items.length, 0, "a zero cap returns no items");
});

// ============================================================================
// F1-2 / F1-4：落盘出口（onAppend）、id 唯一性、注入来源标签
// ============================================================================

await run("F1-2: onAppend broadcasts every append and can be unsubscribed", async () => {
  const log = new TimelineLog();
  const seen: string[] = [];
  const off = log.onAppend((item) => seen.push(item.id));

  const first = log.append(baseItem("m-1"));
  assertEqual(seen.join(","), "m-1", "append 之后回调一次（带该条目）");
  assertEqual(seen[0], first.id, "回调拿到的是刚写入的那条");
  log.append(baseItem("m-2"));
  assertEqual(seen.join(","), "m-1,m-2", "每次 append 都广播一次");

  off();
  log.append(baseItem("m-3"));
  assertEqual(seen.length, 2, "退订后不再调用（S4 发事件/落盘的唯一出口）");
  assertEqual(log.getById("m-3")?.id, "m-3", "退订不影响日志本身");
});

await run("F1-2: an explicit id is never handed out again by nextGeneratedId", async () => {
  const log = new TimelineLog();
  log.append(baseItem("m-3"));
  const generated: string[] = [];
  for (let index = 0; index < 6; index++) {
    generated.push(log.append(baseItem("")).id);
  }
  assert(
    !generated.includes("m-3"),
    "显式 id 之后 nextGeneratedId 不再产出该 id（重启后 replay 的 m-N 不会被复用）",
  );
  assertEqual(new Set(generated).size, generated.length, "自动 id 互不重复");
  assert(generated.every((id) => /^m-\d+$/.test(id)), "自动 id 保持 m-N 形态");

  // replay：文件里已有的 m-1/m-2 占用之后，新条目从下一个空位开始。
  const replayed = new TimelineLog();
  replayed.append(baseItem("m-1"));
  replayed.append(baseItem("m-2"));
  const fresh = replayed.append(baseItem("")).id;
  assert(fresh !== "m-1" && fresh !== "m-2", "replay 用过的 id 不会被新条目复用");
});

await run("F1-4: entries carry their source and packed blocks keep it", async () => {
  const log = new TimelineLog();
  const inbox = new SeatInbox();
  const user = log.append({ ...baseItem("U1"), type: "user", fromId: USER_SEAT_ID, text: "用户说的" });
  const seat = log.append({ ...baseItem("B1"), fromId: SEAT_A, text: "席位说的" });
  inbox.enqueue(user, [SEAT_B]);
  inbox.enqueue(seat, [SEAT_B]);

  const pending = inbox.pending(SEAT_B);
  assertEqual(
    pending.find((entry) => entry.messageId === "B1")?.fromId,
    SEAT_A,
    "enqueue 把发送方拷进 InboxEntry（旧快照缺省 unknown）",
  );
  assertEqual(
    pending.find((entry) => entry.messageId === "B1")?.type,
    "utterance",
    "enqueue 把 TimelineItemType 拷进 InboxEntry",
  );
  assertEqual(
    pending.find((entry) => entry.messageId === "U1")?.type,
    "user",
    "用户消息的来源类型是 user",
  );

  const pack = inbox.packForNextCall(SEAT_B, 10_000);
  assert(pack.blocks.every((block) => block.fromId.length > 0), "每个 block 都带 fromId");
  assertEqual(
    pack.blocks.find((block) => block.messageId === "B1")?.fromId,
    SEAT_A,
    "block 的来源就是原条目",
  );

  // 旧快照（F1-4 之前的 inbox.json）没有来源字段：restore 兜底，不抛错也不留 undefined。
  const legacy = new SeatInbox();
  legacy.restore([
    {
      messageId: "old-1",
      seatId: SEAT_B,
      state: "pending_inject",
      text: "旧快照正文",
      enqueuedAt: 1,
      priority: "normal",
    } as unknown as InboxEntry,
  ]);
  const restored = legacy.pending(SEAT_B)[0];
  assertEqual(restored?.fromId, "unknown", "旧快照缺 fromId → 兜底 unknown");
  assertEqual(restored?.type, "system", "旧快照缺 type → 兜底 system");
  assertEqual(restored?.text, "旧快照正文", "正文照旧保留");
});

// ============================================================================

console.log("\n=== Summary ===\n");
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
