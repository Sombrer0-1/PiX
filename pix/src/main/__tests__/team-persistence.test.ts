/**
 * RoundtablePersistence tests (S2e, plan §4.10 / §5.11 / §6.1–6.3，H7 / H8 / H14 / H33 / H36).
 *
 * Covers:
 *   - timeline.jsonl / attention.jsonl append + replay: file order, seq kept, disk
 *     (not the snapshot body) is the source
 *   - snapshot round-trips roster / settings / inbox / open items / deliverables /
 *     metrics (plus mutedThreads / pendingPermissions / pendingExits)
 *   - a reloaded seat never re-injects an already-injected id, and a private inbox
 *     entry still carries its text (H36) after restore
 *   - crash recovery hydrates to "paused" by default, honours autoContinueAfterCrash,
 *     never revives a stopped roundtable
 *   - the old team-state/<sha1>/team.json is detected but never restorable, and the
 *     file is left untouched
 *   - current.json pointer write/read/clear (H33) and the workspace-level ack.json
 *     round-trip independent of any roundtableId (H14)
 *   - archive() moves the whole directory under archive/<roundtableId>/ and the
 *     pointer no longer resolves to it
 *   - a failed write is retried, then surfaced, and the in-memory snapshot survives
 *     for the next flush (§5.14)
 *
 * The test never touches the real user profile: PI_CODING_AGENT_DIR points at a temp
 * directory (same trick as acp-session-bridge.test.ts), and the injectable rootDir is
 * covered separately.
 *
 * Run with: npx tsx pix/src/main/__tests__/team-persistence.test.ts
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PermissionRequest } from "../../shared/types.js";
import {
  USER_SEAT_ID,
  type AttentionItem,
  type DeliverableVersion,
  type ExitRequest,
  type InboxEntry,
  type OpenItem,
  type PersistedRoundtable,
  type RoundtableMetricsSnapshot,
  type RoundtableSettings,
  type RoundtableState,
  type SeatInfo,
  type TimelineItem,
  type WriteLease,
} from "../../shared/team-types.js";
import {
  DEFAULT_L2_BUDGET,
  EXIT_REQUEST_TIMEOUT_MS,
  ORDERED_RELEASE_MS,
  roundtableAckPath,
  roundtableArchiveDir,
  roundtableCurrentPointerPath,
  roundtableDir,
  roundtableFilePath,
  roundtablesDir,
} from "../team/constants.js";
import { detectLegacyTeamSnapshot, isLegacySnapshotRestorable, LEGACY_SNAPSHOT_RESTORABLE } from "../team/legacy-snapshot.js";
import { AttentionBus } from "../team/attention-bus.js";
import { resolveCrashRecoveryLifecycle, RoundtablePersistence } from "../team/persistence.js";
import { SeatInbox } from "../team/seat-inbox.js";
import { teamSnapshotPath } from "../team-persistence.js";

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

/** assert + narrow a loadLatest result. */
function loadedOrFail<T>(value: T | null, message: string): T {
  assert(value !== null, message);
  if (value === null) {
    throw new Error(`loadLatest returned null: ${message}`);
  }
  return value;
}

function assertIncludes(haystack: string, needle: string, message: string): void {
  assert(haystack.includes(needle), message);
}

/** Key-sorted JSON: structural comparison that ignores object key order. */
function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortValue(source[key]);
    }
    return sorted;
  }
  return value;
}

// ============================================================================
// Fixtures
// ============================================================================

// 真实用户目录绝不参与：agent 目录指向临时目录（getAgentDir() 读环境变量）。
const AGENT_DIR = mkdtempSync(join(tmpdir(), "pix-team-persistence-agent-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const RT = "rt-11111111-2222-3333-4444-555555555555";
const SEAT_A = `sources::${RT}`;
const SEAT_B = `theory::${RT}`;

function fixtureCwd(name: string): string {
  return mkdtempSync(join(tmpdir(), `pix-team-persistence-${name}-`));
}

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

function makeSettings(overrides?: Partial<RoundtableSettings>): RoundtableSettings {
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

function makeSeat(name: string, slug: string, seatId: string, color: string): SeatInfo {
  return {
    name,
    perspective: "测试视角",
    auth: "read_only",
    seatId,
    slug,
    color,
    status: "idle",
    createdAt: 1_700_000_000_000,
    statusChangedAt: 1_700_000_000_000,
  };
}

function makeState(overrides?: Partial<RoundtableState>): RoundtableState {
  return {
    roundtableId: RT,
    name: "持久化测试场",
    lifecycle: "active",
    createdAt: 1_700_000_000_000,
    tier: "standard",
    settings: makeSettings(),
    seats: {
      [SEAT_A]: makeSeat("资料", "sources", SEAT_A, "#111111"),
      [SEAT_B]: makeSeat("理论", "theory", SEAT_B, "#222222"),
    },
    orderedMode: false,
    hostSessionId: "host-session-1",
    ...overrides,
  };
}

function makeItem(
  id: string,
  seq: number,
  fromId: string,
  text: string,
  overrides?: Partial<TimelineItem>,
): TimelineItem {
  return {
    id,
    seq,
    ts: 1_700_000_000_000 + seq,
    type: "utterance",
    fromId,
    toId: "*",
    text,
    summary: text,
    mentionIds: [],
    ...overrides,
  };
}

function makeAttention(id: string): AttentionItem {
  return { id, ts: 1_700_000_000_000, kind: "permission", text: `注意力 ${id}`, acked: false };
}

function makeMetrics(): RoundtableMetricsSnapshot {
  return {
    perSeat: {
      [SEAT_A]: { utterances: 3, tokensIn: 1200, tokensOut: 800, cost: 0.0123, durationMs: 45_000 },
    },
    totals: { utterances: 3, tokens: 2000, cost: 0.0123, durationMs: 45_000 },
    health: { speakShare: { [SEAT_A]: 1 }, evidenceDensity: 0.66, interruptRate: 0.33 },
  };
}

const OPEN_ITEM: OpenItem = {
  id: "oi-1",
  subject: "缓存失效策略未定",
  body: "需要一轮实验",
  status: "claimed",
  claimedBy: SEAT_A,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
};

const LEASE: WriteLease = { pathKey: "E:/proj/src/a.ts", ownerSeatId: SEAT_A, acquiredAt: 1_700_000_050_000 };

const DELIVERABLE: DeliverableVersion = {
  id: "dv-2",
  version: 2,
  cutoffSeq: 7,
  createdAt: 1_700_000_100_000,
  author: SEAT_B,
  basedOnVersion: 1,
  status: "ready",
  markdown: "# 结论\n\n- 可做，先做实验",
  stances: [{ seatId: SEAT_A, stance: "support", reason: "有依据", confidence: "high" }],
  sections: {
    conclusions: "结论",
    evidenceIndex: "依据",
    disagreements: "分歧",
    nextActions: "下一步",
    processIndex: "过程",
  },
};

const PERMISSION: PermissionRequest = {
  id: "perm-1",
  teamName: "持久化测试场",
  agentId: SEAT_A,
  tool: "team_bash",
  args: { command: "npm test", paths: ["E:/proj/src/a.ts"] },
  status: "pending",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const EXIT_REQUEST: ExitRequest = {
  id: "exit-1",
  targetSeatId: SEAT_B,
  requestedBy: SEAT_A,
  requestedAt: 1_700_000_200_000,
  statements: [{ fromId: SEAT_A, text: "该席已无补充" }],
  status: "pending",
};

function makeSnapshot(
  state: RoundtableState,
  patch?: Partial<PersistedRoundtable>,
): PersistedRoundtable {
  return {
    version: 2,
    roundtableId: RT,
    physicalCwd: "",
    savedAt: 1_700_000_300_000,
    state,
    inbox: [],
    openItems: [],
    leases: [],
    deliverables: [],
    mutedThreads: [],
    metrics: makeMetrics(),
    pendingPermissions: [],
    pendingExits: [],
    attentionAcks: [],
    ...patch,
  };
}

// ============================================================================

async function main(): Promise<void> {
  // --------------------------------------------------------------------------
  await run("协议默认值的字面值：60s 放行 / 120s 退出协商 / L2 五元组（Plan H4/H5）", async () => {
    // T-1：上面 makeSettings 只把这三个常量当构造输入，改小常量测试照样全绿。
    // 这条断言数值本身（Plan H4/H5 的字面值），是唯一能抓住默认值漂移的断言。
    assertEqual(ORDERED_RELEASE_MS, 60_000, "有序队列自动放行 60s（Plan H4）");
    assertEqual(EXIT_REQUEST_TIMEOUT_MS, 120_000, "退出协商超时 120s（Plan H4）");
    assertEqual(DEFAULT_L2_BUDGET.perSeatPerTurn, 1, "L2 每席每轮 1 次（Plan H5）");
    assertEqual(DEFAULT_L2_BUDGET.minIntervalMs, 30_000, "L2 对同一目标间隔 ≥30s（Plan H5）");
    assertEqual(DEFAULT_L2_BUDGET.globalWindowMs, 60_000, "L2 全场滚动窗口 60s（Plan H5）");
    assertEqual(DEFAULT_L2_BUDGET.globalMaxInWindow, 8, "L2 窗口内最多 8 次（Plan H5）");
    assertEqual(DEFAULT_L2_BUDGET.consecutiveFuse, 2, "同一目标连续 2 次被打即熔断（Plan H5）");
    assertEqual(
      Object.keys(DEFAULT_L2_BUDGET).length,
      5,
      "L2 预算就是 Plan 的五元组（新增键会在这里暴露）",
    );
  });

  await run("jsonl append then replay keeps order, seq and comes from disk", async () => {
    const cwd = fixtureCwd("jsonl");
    const p = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: RT, debounceMs: 0 });
    const timelinePath = roundtableFilePath(cwd, RT, "timeline.jsonl");
    const attentionPath = roundtableFilePath(cwd, RT, "attention.jsonl");

    // 正文里带换行也不破坏 JSONL：一行一条。
    await p.appendTimeline(makeItem("m1", 1, SEAT_A, "第一\n行"));
    await p.appendTimeline(makeItem("m2", 2, SEAT_B, "第二"));
    await p.appendTimeline(makeItem("m3", 3, USER_SEAT_ID, "第三"));

    const raw = readFileSync(timelinePath, "utf-8");
    assertEqual(raw.split("\n").filter((line) => line.length > 0).length, 3, "timeline.jsonl has one line per item");
    assertEqual(raw.includes("\\n"), true, "a newline inside the text is escaped, not split into two lines");

    await p.writeCurrentPointer(RT);
    await p.saveSnapshot(makeSnapshot(makeState()));

    const loaded = loadedOrFail(await p.loadLatest(cwd), "loadLatest returns the saved roundtable");
    assertEqual(loaded.timeline.map((item) => item.id).join(","), "m1,m2,m3", "replay keeps file order");
    assertEqual(loaded.timeline.map((item) => item.seq).join(","), "1,2,3", "replay keeps seq");
    assertEqual(loaded.timeline[0]?.text, "第一\n行", "the text (with newline) round-trips");
    assertEqual(loaded.attention.length, 0, "no attention items yet");

    await p.appendAttention(makeAttention("a1"));
    await p.appendAttention(makeAttention("a2"));
    const withAttention = loadedOrFail(await p.loadLatest(cwd), "reload after attention appends");
    assertEqual(withAttention.attention.map((item) => item.id).join(","), "a1,a2", "attention replays in file order");
    assertEqual(withAttention.timeline.length, 3, "attention appends do not touch the timeline");

    // 快照写入之后直接往 jsonl 追一行：loadLatest 必须从磁盘读到它。
    const late = makeItem("m-late", 4, SEAT_B, "快照之后追加");
    appendFileSync(timelinePath, `${JSON.stringify(late)}\n`, "utf-8");
    const replayed = loadedOrFail(await p.loadLatest(cwd), "reload after an out-of-band jsonl append");
    assertEqual(
      replayed.timeline.map((item) => item.id).join(","),
      "m1,m2,m3,m-late",
      "timeline is replayed from the file, not from the snapshot body",
    );
    assertEqual(replayed.meta.savedAt, 1_700_000_300_000, "the snapshot itself was not rewritten");
    assertEqual(
      readFileSync(attentionPath, "utf-8").split("\n").filter((line) => line.length > 0).length,
      2,
      "attention.jsonl holds exactly the two appended items",
    );
  });

  // --------------------------------------------------------------------------
  await run("snapshot round-trips roster, settings, inbox, open items, deliverables, metrics", async () => {
    const cwd = fixtureCwd("snapshot");
    const p = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: RT, debounceMs: 0 });
    await p.writeCurrentPointer(RT);

    const settings = makeSettings({
      orderedMode: true,
      waitForUserQuestions: true,
      autoContinueAfterCrash: false,
      unattendedGuard: true,
      suggestWrapUp: true,
      cheaperModel: "faux/cheap",
      softBudget: { maxCostUsd: 3.5 },
      hardStop: { enabled: true, maxCostUsd: 9, allowWrapUpOnStop: true },
      l2: { perSeatPerTurn: 2, minIntervalMs: 10_000, globalWindowMs: 30_000, globalMaxInWindow: 4, consecutiveFuse: 3 },
    });
    const state = makeState({ settings, orderedMode: true });
    const inbox: InboxEntry[] = [
      {
        messageId: "m-public",
        seatId: SEAT_A,
        state: "pending_inject",
        text: "公开正文副本",
        enqueuedAt: 1,
        priority: "user",
      },
      {
        messageId: "m-private",
        seatId: SEAT_A,
        state: "injected",
        text: "私密正文（唯一落盘载体）",
        enqueuedAt: 2,
        injectedAt: 3,
        injectedInCallId: "call-1",
        priority: "mention",
      },
    ];
    const snapshot = makeSnapshot(state, {
      physicalCwd: cwd,
      inbox,
      openItems: [OPEN_ITEM],
      leases: [LEASE],
      deliverables: [DELIVERABLE],
      mutedThreads: ["th-1", "th-2"],
      pendingPermissions: [PERMISSION],
      pendingExits: [EXIT_REQUEST],
    });

    await p.saveSnapshot(snapshot);
    const loaded = loadedOrFail(await p.loadLatest(cwd), "loadLatest after a rich snapshot");

    assertEqual(stableJson(loaded.meta.state.seats), stableJson(state.seats), "roster (seats) round-trips");
    assertEqual(loaded.meta.state.seats[SEAT_A]?.name, "资料", "the seat display name survives");
    assertEqual(stableJson(loaded.meta.state.settings), stableJson(settings), "settings round-trip");
    assertEqual(loaded.meta.state.lifecycle, "active", "lifecycle round-trips");
    assertEqual(loaded.meta.state.hostSessionId, "host-session-1", "hostSessionId round-trips");
    assertEqual(stableJson(loaded.meta.inbox), stableJson(inbox), "inbox round-trips (state + text + injectedAt)");
    assertEqual(stableJson(loaded.meta.openItems), stableJson([OPEN_ITEM]), "open items round-trip");
    assertEqual(stableJson(loaded.meta.leases), stableJson([LEASE]), "leases round-trip");
    assertEqual(stableJson(loaded.meta.deliverables), stableJson([DELIVERABLE]), "finished deliverables round-trip");
    assertEqual(stableJson(loaded.meta.metrics), stableJson(makeMetrics()), "metrics round-trip");
    assertEqual(loaded.meta.mutedThreads.join(","), "th-1,th-2", "mutedThreads round-trip");
    assertEqual(stableJson(loaded.meta.pendingPermissions), stableJson([PERMISSION]), "pending permissions round-trip");
    assertEqual(stableJson(loaded.meta.pendingExits), stableJson([EXIT_REQUEST]), "pending exits round-trip");
    assertEqual(loaded.meta.roundtableId, RT, "roundtableId round-trips");
    assertEqual(loaded.meta.physicalCwd, cwd, "physicalCwd round-trips");

    assertEqual(
      readdirSync(roundtableDir(cwd, RT)).sort().join(","),
      "deliverables.json,inbox.json,leases.json,meta.json,metrics.json,open-items.json",
      "the roundtable directory holds exactly the §4.10 files (timeline/attention only when appended)",
    );
    const metaRaw = readFileSync(roundtableFilePath(cwd, RT, "meta.json"), "utf-8");
    assert(!metaRaw.includes('"timeline"'), "timeline is not part of the snapshot body");
    assert(!metaRaw.includes('"attention"'), "attention is not part of the snapshot body");
    assertEqual(
      dirname(roundtableCurrentPointerPath(cwd)),
      roundtablesDir(cwd),
      "current.json lives at the workspace level",
    );
  });

  // --------------------------------------------------------------------------
  await run("a reloaded seat never re-injects an injected id and keeps private text", async () => {
    const cwd = fixtureCwd("reload");
    const p = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: RT, debounceMs: 0 });
    await p.writeCurrentPointer(RT);

    const inbox = new SeatInbox();
    const publicItem = makeItem("m-public", 1, USER_SEAT_ID, "公开正文", { type: "user", toId: SEAT_A });
    const privateStub = makeItem("m-private", 2, SEAT_A, "", {
      type: "private_stub",
      toId: SEAT_B,
      privateStub: { fromId: SEAT_A, toId: SEAT_B },
      mentionIds: [SEAT_B],
    });
    inbox.enqueue(publicItem, [SEAT_A]);
    // H36：私密正文只在 InboxEntry.text，时间线 stub 的 text 保持空串。
    inbox.enqueue({ ...privateStub, text: "私密正文只在 InboxEntry.text" }, [SEAT_B]);

    const firstPack = inbox.packForNextCall(SEAT_A, 10_000);
    assertEqual(firstPack.injectedIds.join(","), "m-public", "A packs the user message");
    inbox.commitInjected(SEAT_A, firstPack.injectedIds, firstPack.callId);
    assertEqual(inbox.pending(SEAT_A).length, 0, "A has nothing pending after the commit");

    await p.appendTimeline(publicItem);
    await p.appendTimeline(privateStub);
    await p.saveSnapshot(makeSnapshot(makeState(), { inbox: inbox.snapshot() }));

    const loaded = loadedOrFail(await p.loadLatest(cwd), "loadLatest after the delivery round");
    assertEqual(
      loaded.meta.inbox.find((entry) => entry.messageId === "m-public")?.state,
      "injected",
      "the injected state is persisted",
    );
    assertEqual(
      loaded.meta.inbox.find((entry) => entry.messageId === "m-public")?.injectedInCallId,
      firstPack.callId,
      "injectedInCallId is persisted",
    );

    const restored = new SeatInbox();
    restored.restore(loaded.meta.inbox);
    assertEqual(restored.pending(SEAT_A).length, 0, "an already-injected id never comes back as pending");
    const repack = restored.packForNextCall(SEAT_A, 10_000);
    assertEqual(repack.injectedIds.length, 0, "pack injects nothing for the reloaded A");
    assertEqual(repack.blocks.length, 0, "pack produces no block for the reloaded A");

    const pendingB = restored.pending(SEAT_B);
    assertEqual(pendingB.length, 1, "the private message is still pending for B");
    assertEqual(pendingB[0]?.text, "私密正文只在 InboxEntry.text", "the private body lives in InboxEntry.text after restore");
    const privatePack = restored.packForNextCall(SEAT_B, 10_000);
    assert(
      privatePack.blocks.some((block) => block.text.includes("私密正文只在 InboxEntry.text")),
      "pack reads the private body from the inbox, not from the empty timeline stub",
    );
    const reloadedStub = loaded.timeline.find((item) => item.id === "m-private");
    assertEqual(reloadedStub?.text, "", "the public timeline stub stays empty (H36)");
    assertEqual(reloadedStub?.privateStub?.toId, SEAT_B, "the private stub keeps the recipient for the trace");
  });

  // --------------------------------------------------------------------------
  await run("crash recovery pauses by default and honours autoContinueAfterCrash", async () => {
    const cwd = fixtureCwd("recovery");
    const p = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: RT, debounceMs: 0 });
    await p.writeCurrentPointer(RT);
    await p.saveSnapshot(makeSnapshot(makeState()));

    const crashed = loadedOrFail(await p.loadLatest(cwd), "loadLatest returns what was persisted");
    assertEqual(crashed.meta.state.lifecycle, "active", "loadLatest returns the persisted lifecycle verbatim");
    assertEqual(resolveCrashRecoveryLifecycle(crashed.meta), "paused", "the default hydrate target is paused");

    await p.saveSnapshot(makeSnapshot(makeState({ settings: makeSettings({ autoContinueAfterCrash: true }) })));
    const auto = loadedOrFail(await p.loadLatest(cwd), "loadLatest after autoContinueAfterCrash");
    assertEqual(auto.meta.state.settings.autoContinueAfterCrash, true, "autoContinueAfterCrash is persisted");
    assertEqual(resolveCrashRecoveryLifecycle(auto.meta), "active", "autoContinueAfterCrash keeps the roundtable running");

    await p.saveSnapshot(makeSnapshot(makeState({ lifecycle: "stopped" })));
    const stopped = loadedOrFail(await p.loadLatest(cwd), "loadLatest after stop");
    assertEqual(resolveCrashRecoveryLifecycle(stopped.meta), "stopped", "a stopped roundtable is never revived");

    await p.saveSnapshot(makeSnapshot(makeState({ lifecycle: "inactive" })));
    const inactive = loadedOrFail(await p.loadLatest(cwd), "loadLatest while inactive");
    assertEqual(resolveCrashRecoveryLifecycle(inactive.meta), "inactive", "an inactive roundtable stays inactive");
  });

  // --------------------------------------------------------------------------
  await run("the old team.json is detected but never offered as a restorable roundtable", async () => {
    const cwd = fixtureCwd("legacy");
    const legacyPath = teamSnapshotPath(cwd);
    assertEqual(
      legacyPath,
      join(AGENT_DIR, "team-state", sha1(cwd), "team.json"),
      "teamSnapshotPath is still the old getAgentDir()/team-state/<sha1>/team.json path",
    );
    mkdirSync(dirname(legacyPath), { recursive: true });
    const legacyBody = JSON.stringify(
      {
        version: 1,
        cwd,
        savedAt: 1,
        team: { name: "旧团队", status: "active", leadAgentId: "lead", createdAt: 1, workers: [], tasks: [], bus: {}, messageHistory: {} },
      },
      null,
      2,
    );
    writeFileSync(legacyPath, legacyBody, "utf-8");

    assertEqual(detectLegacyTeamSnapshot(cwd), true, "the legacy team.json is detected");
    assertEqual(detectLegacyTeamSnapshot(fixtureCwd("legacy-other")), false, "another cwd has no legacy snapshot");
    assertEqual(LEGACY_SNAPSHOT_RESTORABLE, false, "the exported constant says: not restorable");
    assertEqual(isLegacySnapshotRestorable(), false, "the exported predicate says: not restorable");

    const p = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: RT, debounceMs: 0 });
    assertEqual(await p.loadLatest(cwd), null, "loadLatest offers no roundtable for a legacy-only workspace");
    assertEqual(await p.readCurrentPointer(), null, "a legacy snapshot produces no current.json pointer");
    assertEqual(existsSync(roundtablesDir(cwd)), false, "detection writes nothing into the new roundtables/ directory");

    // H14：旧文件保留，探测与恢复路径都不许动它。
    assertEqual(readFileSync(legacyPath, "utf-8"), legacyBody, "the legacy team.json is left byte-identical");
    assertEqual(legacyPath.startsWith(join(AGENT_DIR, "team-state")), true, "the legacy file stays under team-state/");
  });

  // --------------------------------------------------------------------------
  await run("current.json round-trips and can be cleared", async () => {
    const cwd = fixtureCwd("pointer");
    const p = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: RT, debounceMs: 0 });
    const pointerPath = roundtableCurrentPointerPath(cwd);

    assertEqual(await p.readCurrentPointer(), null, "no pointer before the first write");
    await p.writeCurrentPointer(RT);
    assertEqual(readFileSync(pointerPath, "utf-8"), JSON.stringify({ roundtableId: RT }, null, 2), "current.json content is { roundtableId }");
    assertEqual(await p.readCurrentPointer(), RT, "the pointer round-trips");
    assertEqual(dirname(pointerPath), roundtablesDir(cwd), "the pointer is workspace-level (H33)");

    // 指针才是权威（H33）：S4 用 roundtableId="bootstrap" 的工作区探针调 loadLatest，
    // 实例自己绑的场不参与解析。
    await p.saveSnapshot(makeSnapshot(makeState()));
    const probe = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: "bootstrap", debounceMs: 0 });
    const viaPointer = loadedOrFail(await probe.loadLatest(cwd), "a probe instance resolves the roundtable through current.json");
    assertEqual(viaPointer.meta.roundtableId, RT, "the instance's own roundtableId does not steer loadLatest");
    assertEqual(
      await probe.loadLatest(fixtureCwd("pointer-other")),
      null,
      "loadLatest resolves the pointer of the cwd it was given, not of the instance cwd",
    );

    // 另一份工作区即使躺着同名目录，探针也只看被查询 cwd 的指针（H33）。
    const orphanCwd = fixtureCwd("pointer-orphan");
    const orphan = new RoundtablePersistence({ physicalCwd: orphanCwd, roundtableId: RT, debounceMs: 0 });
    await orphan.saveSnapshot(makeSnapshot(makeState()));
    assertEqual(await orphan.loadLatest(orphanCwd), null, "a roundtable directory without a pointer is not recoverable");
    assertEqual(await probe.loadLatest(orphanCwd), null, "the probe finds nothing in a workspace without its own pointer");

    await p.writeCurrentPointer(null);
    assertEqual(existsSync(pointerPath), false, "clearing removes current.json");
    assertEqual(await p.readCurrentPointer(), null, "a cleared pointer reads back as null");
  });

  // --------------------------------------------------------------------------
  await run("the workspace-level ack round-trips independently of any roundtableId", async () => {
    const cwd = fixtureCwd("ack");
    const p = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: RT, debounceMs: 0 });
    const ackPath = roundtableAckPath(cwd);

    assertEqual((await p.readAck(cwd)).legacySnapshotNoticeAck, undefined, "no ack initially");
    await p.writeAck(cwd, { legacySnapshotNoticeAck: true });
    assertEqual((await p.readAck(cwd)).legacySnapshotNoticeAck, true, "the ack round-trips");
    assertEqual(existsSync(ackPath), true, "ack.json exists at the workspace level");
    assertEqual(dirname(ackPath), roundtablesDir(cwd), "ack.json sits next to current.json, not inside a roundtable (H14)");

    // 不依赖 roundtableId：没有指针、换一场、归档整场都读同一份。
    await p.writeCurrentPointer(null);
    assertEqual((await p.readAck(cwd)).legacySnapshotNoticeAck, true, "the ack survives a cleared pointer");
    await p.saveSnapshot(makeSnapshot(makeState()));
    await p.archive(RT);
    assertEqual((await p.readAck(cwd)).legacySnapshotNoticeAck, true, "the ack survives archiving the roundtable");

    const other = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: "rt-99999999-0000-0000-0000-000000000000", debounceMs: 0 });
    assertEqual((await other.readAck(cwd)).legacySnapshotNoticeAck, true, "another instance reads the same workspace ack");

    await p.writeAck(cwd, { legacySnapshotNoticeAck: false });
    assertEqual((await p.readAck(cwd)).legacySnapshotNoticeAck, false, "the ack can be turned off");
    writeFileSync(ackPath, JSON.stringify({ legacySnapshotNoticeAck: false, otherFlag: 7 }), "utf-8");
    await p.writeAck(cwd, { legacySnapshotNoticeAck: true });
    const merged = JSON.parse(readFileSync(ackPath, "utf-8")) as Record<string, unknown>;
    assertEqual(merged.otherFlag, 7, "writeAck merges instead of dropping other fields");
    assertEqual(merged.legacySnapshotNoticeAck, true, "writeAck updates the legacy flag");
  });

  // --------------------------------------------------------------------------
  // F5-3：`has-legacy-team-snapshot`（ipc-handlers.ts）本身带 electron 依赖、纯 Node
  // 跑不了，所以行为面按它的组合（detect + readAck）断言，接线用源码门禁兜住——
  // 少了 readAck 这一读，ack 之后每次从首页打开都会再弹一次阻塞式确认框（AC-13）。
  await run("the legacy probe is acked-once: detect + readAck, and the IPC handler keeps that wiring", async () => {
    const cwd = fixtureCwd("legacy-probe");
    const legacyPath = teamSnapshotPath(cwd);
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({ version: 1, leader: "old" }), "utf-8");

    const probe = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: "bootstrap", debounceMs: 0 });
    const shouldPrompt = async (): Promise<boolean> =>
      detectLegacyTeamSnapshot(cwd) && (await probe.readAck(cwd)).legacySnapshotNoticeAck !== true;

    assertEqual(await shouldPrompt(), true, "旧快照存在且没确认过 → 提示一次");
    await probe.writeAck(cwd, { legacySnapshotNoticeAck: true });
    assertEqual(await shouldPrompt(), false, "确认过之后探针为 false（换实例/重启也读同一份 ack.json）");
    assertEqual(
      detectLegacyTeamSnapshot(cwd),
      true,
      "旧 team.json 本身仍在（提示只影响探针，不动文件）",
    );

    const source = readFileSync(new URL("../ipc-handlers.ts", import.meta.url), "utf8");
    const handler = source.slice(
      source.indexOf('"has-legacy-team-snapshot"'),
      source.indexOf('"ack-legacy-team-snapshot"'),
    );
    assert(handler.includes("detectLegacyTeamSnapshot("), "has-legacy-team-snapshot still probes the legacy file");
    assert(handler.includes("readAck("), "has-legacy-team-snapshot reads the workspace ack.json (AC-13「只提示一次」)");
    assert(
      handler.includes("legacySnapshotNoticeAck !== true"),
      "has-legacy-team-snapshot returns false once the workspace is acked",
    );
  });

  // --------------------------------------------------------------------------
  await run("archive() moves the directory under archive/ and the pointer stops resolving", async () => {
    const cwd = fixtureCwd("archive");
    const p = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: RT, debounceMs: 0 });
    await p.writeCurrentPointer(RT);
    await p.appendTimeline(makeItem("m1", 1, SEAT_A, "归档前的记录"));
    await p.saveSnapshot(makeSnapshot(makeState()));

    const live = roundtableDir(cwd, RT);
    const archived = roundtableArchiveDir(cwd, RT);
    assertEqual(existsSync(join(live, "meta.json")), true, "the live directory holds meta.json before archiving");
    loadedOrFail(await p.loadLatest(cwd), "loadLatest resolves before archiving");

    await p.archive(RT);
    assertEqual(existsSync(live), false, "the live directory is gone");
    assertEqual(existsSync(join(archived, "meta.json")), true, "meta.json is now under archive/<roundtableId>/");
    assertEqual(
      readFileSync(join(archived, "timeline.jsonl"), "utf-8").split("\n").filter((line) => line.length > 0).length,
      1,
      "the append-only timeline moves with the directory",
    );
    assertEqual(readdirSync(dirname(archived)).join(","), RT, "the archive name is exactly the roundtableId (no glob, H33)");
    assertEqual(await p.readCurrentPointer(), null, "the pointer no longer points at the archived roundtable");
    assertEqual(await p.loadLatest(cwd), null, "an archived roundtable is not offered as restorable");

    // 指针异常残留（崩在归档中间）也不能让归档场复活（§6.1：归档场在 archive/ 下）。
    writeFileSync(roundtableCurrentPointerPath(cwd), JSON.stringify({ roundtableId: RT }, null, 2), "utf-8");
    assertEqual(await p.loadLatest(cwd), null, "a stale pointer to an archived roundtable still resolves to nothing");

    const second = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: RT, debounceMs: 0 });
    assertEqual(await second.loadLatest(cwd), null, "a fresh instance cannot resolve the archived roundtable either");
  });

  // --------------------------------------------------------------------------
  await run("a failed write is surfaced after a retry and the snapshot is not lost", async () => {
    const cwd = fixtureCwd("write-failure");
    const p = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: RT, debounceMs: 0 });
    await p.writeCurrentPointer(RT);

    // 用同名目录挡住写：临时文件能建，rename/appendFile 目标必失败（平台无关）。
    const live = roundtableDir(cwd, RT);
    mkdirSync(join(live, "meta.json"), { recursive: true });
    mkdirSync(join(live, "timeline.jsonl"), { recursive: true });

    let snapshotError: unknown = null;
    try {
      await p.saveSnapshot(makeSnapshot(makeState()));
    } catch (err) {
      snapshotError = err;
    }
    assert(snapshotError instanceof Error, "saveSnapshot surfaces the error to the caller after retrying");

    let appendError: unknown = null;
    try {
      await p.appendTimeline(makeItem("m1", 1, SEAT_A, "写不进去"));
    } catch (err) {
      appendError = err;
    }
    assert(appendError instanceof Error, "appendTimeline surfaces the error as well");

    // 障碍移除后：内存里的快照用 flush 补写（§5.14 尽力再 flush），不需要重新 saveSnapshot。
    rmSync(join(live, "meta.json"), { recursive: true, force: true });
    rmSync(join(live, "timeline.jsonl"), { recursive: true, force: true });
    await p.flush();
    await p.appendTimeline(makeItem("m1", 1, SEAT_A, "写进去了"));

    const loaded = loadedOrFail(await p.loadLatest(cwd), "after the re-flush the roundtable loads");
    assertEqual(loaded.meta.state.name, "持久化测试场", "the in-memory snapshot survived the failure");
    assertEqual(loaded.timeline.map((item) => item.id).join(","), "m1", "the retried jsonl append landed");
  });

  // --------------------------------------------------------------------------
  await run("the injectable rootDir mirrors the agent-dir layout", async () => {
    const cwd = fixtureCwd("root-injection");
    const rootDir = mkdtempSync(join(tmpdir(), "pix-team-persistence-root-"));
    const injected = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: RT, rootDir, debounceMs: 0 });
    await injected.writeCurrentPointer(RT);
    await injected.saveSnapshot(makeSnapshot(makeState({ name: "注入 root 的场" })));

    assertEqual(
      existsSync(join(rootDir, "roundtables", sha1(cwd), RT, "meta.json")),
      true,
      "an injected root gets the same roundtables/<sha1>/<roundtableId>/ layout",
    );
    assertEqual(existsSync(join(rootDir, "roundtables", sha1(cwd), "current.json")), true, "the pointer follows the injected root");
    assertEqual(existsSync(roundtablesDir(cwd)), false, "the default agent dir is untouched when rootDir is injected");

    // 不注入时落在 constants.ts helper 给出的路径上（这里 AGENT_DIR 已被环境变量改写）。
    const plain = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: RT, debounceMs: 0 });
    await plain.writeCurrentPointer(RT);
    await plain.saveSnapshot(makeSnapshot(makeState({ name: "默认 root 的场" })));
    assertEqual(existsSync(roundtableFilePath(cwd, RT, "meta.json")), true, "the default root uses the constants.ts path helpers");
    assertEqual(
      readdirSync(roundtablesDir(cwd)).sort().join(","),
      ["current.json", RT].sort().join(","),
      "the workspace directory holds the pointer plus one roundtable directory",
    );
    const loaded = loadedOrFail(await injected.loadLatest(cwd), "the injected instance reads its own store");
    assertEqual(
      readFileSync(join(rootDir, "roundtables", sha1(cwd), RT, "meta.json"), "utf-8").includes("注入 root 的场"),
      true,
      "the injected store holds the injected snapshot",
    );
    assertEqual(
      loaded.meta.state.name,
      "注入 root 的场",
      "loadLatest on the injected instance does not see the default agent dir",
    );
  });

  // --------------------------------------------------------------------------
  await run("snapshots coalesce inside the debounce window and stay bound to one roundtable", async () => {
    const cwd = fixtureCwd("coalesce");
    // 默认 200ms 窗口：两次 saveSnapshot 合并成一次写，最后一次状态胜出。
    const p = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: RT });
    await p.writeCurrentPointer(RT);

    const startedAt = Date.now();
    const first = p.saveSnapshot(makeSnapshot(makeState({ name: "旧名字" })));
    const second = p.saveSnapshot(makeSnapshot(makeState({ name: "新名字" })));
    await Promise.all([first, second]);
    const elapsed = Date.now() - startedAt;
    assert(elapsed >= 190, `the coalesced write waits for the (default 200ms) window: ${elapsed}ms`);

    const loaded = loadedOrFail(await p.loadLatest(cwd), "loadLatest after coalescing");
    assertEqual(loaded.meta.state.name, "新名字", "the newest state wins inside the window");
    assertEqual(existsSync(roundtableFilePath(cwd, RT, "meta.json")), true, "the coalesced write landed");

    let rejected = false;
    try {
      await p.saveSnapshot({ ...makeSnapshot(makeState()), roundtableId: "rt-other" });
    } catch {
      rejected = true;
    }
    assert(rejected, "a snapshot for another roundtableId is rejected (one instance = one roundtable)");

    // 反向：换一场要用新实例，旧实例不会把别人的状态写进自己的目录。
    const other = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: "rt-other", debounceMs: 0 });
    await other.saveSnapshot({
      ...makeSnapshot(makeState({ roundtableId: "rt-other", name: "另一场" })),
      roundtableId: "rt-other",
    });
    assertEqual(existsSync(roundtableFilePath(cwd, "rt-other", "meta.json")), true, "the other instance writes its own directory");
  });

  // --------------------------------------------------------------------------
  // ============================================================================
  // F4-5 / F4-6 / F4-7：注意力 ack 落盘、归档后不再写盘、损坏不再静默
  // ============================================================================

  await run("F4-5：注意力 acked 只随快照本体落盘，恢复后不复活", async () => {
    const cwd = fixtureCwd("attention-acks");
    const p = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: RT, debounceMs: 0 });
    await p.writeCurrentPointer(RT);

    const bus = new AttentionBus();
    const handled = bus.push({ kind: "permission", text: "已处理" });
    const untouched = bus.push({ kind: "seat_error", text: "还没看" });
    bus.ack(handled.id);
    // attention.jsonl 只记 push 时的样子（acked 恒 false），acks 只能走快照本体。
    await p.appendAttention({ ...handled, acked: false });
    await p.appendAttention({ ...untouched, acked: false });
    await p.saveSnapshot(
      makeSnapshot(makeState(), {
        attentionAcks: bus.list().filter((item) => item.acked).map((item) => item.id),
      }),
    );

    const loaded = loadedOrFail(await p.loadLatest(cwd), "loadLatest after the ack snapshot");
    assertEqual(loaded.meta.attentionAcks.join(","), handled.id, "acks 随快照落盘（F4-5）");
    assertEqual(
      loaded.attention.every((item) => item.acked === false),
      true,
      "attention.jsonl 里的条目仍是未确认（acks 不在这个流里）",
    );

    const restored = new AttentionBus();
    restored.restore(loaded.attention);
    for (const id of loaded.meta.attentionAcks) {
      restored.ack(id);
    }
    assertEqual(
      restored.list().find((item) => item.id === handled.id)?.acked,
      true,
      "恢复后被 ack 的条目仍是已确认（权限卡不会变成死按钮）",
    );
    assertEqual(
      restored.list().find((item) => item.id === untouched.id)?.acked,
      false,
      "未 ack 的条目保持未确认",
    );

    // 旧快照（meta.json 里没有 attentionAcks）按空列表恢复，不炸。
    const metaPath = roundtableFilePath(cwd, RT, "meta.json");
    const metaRaw = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
    delete metaRaw.attentionAcks;
    writeFileSync(metaPath, JSON.stringify(metaRaw, null, 2), "utf-8");
    const legacy = loadedOrFail(await p.loadLatest(cwd), "loadLatest on a pre-F4-5 snapshot");
    assertEqual(legacy.meta.attentionAcks.length, 0, "旧快照缺 attentionAcks → 空列表（向后兼容）");
  });

  await run("F4-6：archive 之后 saveSnapshot / append 不重建 ghost 活跃目录", async () => {
    const cwd = fixtureCwd("archive-ghost");
    const p = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: RT, debounceMs: 0 });
    await p.writeCurrentPointer(RT);
    await p.saveSnapshot(makeSnapshot(makeState()));
    await p.appendTimeline(makeItem("m-before", 1, SEAT_A, "归档前的记录"));
    await p.archive(RT);

    const live = roundtableDir(cwd, RT);
    const archived = roundtableArchiveDir(cwd, RT);
    assertEqual(existsSync(live), false, "归档后活跃目录不存在");

    await p.saveSnapshot(makeSnapshot(makeState({ name: "归档后又被写了一次" })));
    await p.appendTimeline(makeItem("m-late", 9, SEAT_A, "归档后追加"));
    await p.appendAttention(makeAttention("a-late"));

    assertEqual(existsSync(live), false, "归档后写盘不重建活跃目录（F4-6：否则留下永不消费的 ghost）");
    const archivedMeta = readFileSync(join(archived, "meta.json"), "utf-8");
    assert(!archivedMeta.includes("归档后又被写了一次"), "归档包是只读的：没有被覆盖");
    const archivedTimeline = readFileSync(join(archived, "timeline.jsonl"), "utf-8");
    assertIncludes(archivedTimeline, "归档前的记录", "归档包带着归档那一刻的时间线");
    assertEqual(archivedTimeline.includes("归档后追加"), false, "归档后追加的条目既没进活跃目录也没进归档包");
  });

  await run("F4-7：副文件损坏让 loadLatest 抛错（不再静默按空集合恢复）", async () => {
    const cwd = fixtureCwd("corrupt");
    const p = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: RT, debounceMs: 0 });
    await p.writeCurrentPointer(RT);
    await p.saveSnapshot(
      makeSnapshot(makeState(), {
        // H36 的私密正文只在 inbox.json：这里损坏的正是它。
        inbox: [{
          messageId: "m-private",
          seatId: SEAT_A,
          state: "injected",
          text: "私密正文（唯一落盘载体）",
          enqueuedAt: 1,
          priority: "mention",
          fromId: SEAT_A,
          type: "private_stub",
        }],
      }),
    );
    const inboxPath = roundtableFilePath(cwd, RT, "inbox.json");
    assertEqual(readFileSync(inboxPath, "utf-8").includes("唯一落盘载体"), true, "inbox.json 里有私密正文");

    writeFileSync(inboxPath, "{ 这不是 JSON", "utf-8");
    let error: unknown = null;
    try {
      await p.loadLatest(cwd);
    } catch (err) {
      error = err;
    }
    assert(error instanceof Error, "损坏的 inbox.json 让 loadLatest 抛错（F4-7）");
    assertIncludes(String(error), "inbox.json", "错误里带文件名，用户能定位");
    assert(
      !(error instanceof Error && error.message.includes("after")),
      "不是被当成空集合（空集合会是静默 null / 空 inbox）",
    );

    // 缺文件仍是「没有那一部分」，不是损坏。
    rmSync(inboxPath, { force: true });
    const loaded = loadedOrFail(await p.loadLatest(cwd), "缺 inbox.json 时仍能恢复（ENOENT ≠ 损坏）");
    assertEqual(loaded.meta.inbox.length, 0, "缺文件按空集合恢复");

    // 指针自身损坏只影响「指路」，仍按没有可恢复的场处理（archive() 也读它）。
    writeFileSync(roundtableCurrentPointerPath(cwd), "{ 坏了", "utf-8");
    assertEqual(await p.loadLatest(cwd), null, "指针损坏 → 没有可恢复的场（不让归档/探测抛错）");
  });

  // F4-7 的严格读语义只针对「某一场的记录」；ack.json 是工作区级提示标志，
  // 读不出来 = 「还没确认」而不是致命错误。写路径更必须能覆盖：否则一旦损坏，
  // `ack-legacy-team-snapshot` 永久失败，用户只能手删 ack.json 才能让横幅消失。
  await run("F4-7 补：损坏的 ack.json 只让读退化成「未确认」，写路径必须能覆盖（自愈）", async () => {
    const cwd = fixtureCwd("ack-corrupted");
    const p = new RoundtablePersistence({ physicalCwd: cwd, roundtableId: RT, debounceMs: 0 });
    const ackPath = roundtableAckPath(cwd);
    mkdirSync(dirname(ackPath), { recursive: true });
    writeFileSync(ackPath, "{ 这不是 JSON", "utf-8");

    assertEqual(
      (await p.readAck(cwd)).legacySnapshotNoticeAck,
      undefined,
      "损坏的 ack 读作「未确认」（不是把错误抛给 IPC）",
    );

    await p.writeAck(cwd, { legacySnapshotNoticeAck: true });
    const merged = JSON.parse(readFileSync(ackPath, "utf-8")) as Record<string, unknown>;
    assertEqual(merged.legacySnapshotNoticeAck, true, "损坏的 ack.json 被写成有效 ack（写路径自愈）");
    assertEqual((await p.readAck(cwd)).legacySnapshotNoticeAck, true, "覆盖后读得到");
  });

}

// ============================================================================

main()
  .catch((err) => {
    failed++;
    console.error(`  FAIL: the suite threw unexpectedly: ${String(err)}`);
  })
  .then(() => {
    console.log("\n=== Summary ===\n");
    console.log(`Passed: ${passed}, Failed: ${failed}`);
    if (failed > 0) {
      process.exit(1);
    }
  });
