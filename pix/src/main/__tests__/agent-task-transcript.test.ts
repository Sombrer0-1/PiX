/**
 * Agent task transcript unit tests (design plan §4.3/§4.4/§4.5, 1.5 P3).
 *
 * Covers the P3 main-transcript surface end to end with the REAL
 * AgentTaskStore (temp dir) and the REAL AgentTaskService (nested-session
 * runtime replaced by a controllable fake via
 * __setAgentTaskServiceHooksForTests, mirroring agent-task-ipc.test.ts):
 * lenient paginated reads (byte-offset cursor over multi-byte UTF-8, bad-line
 * skipping), the log-driven item_session mapping with legacy fallbacks,
 * the live watch/forward channel (no watcher = zero events, queued-phase
 * subscription, terminal convergence), the message_update tail merge and the
 * 1000-entry capacity overflow, and the task_transcript JSON round-trip.
 *
 * Run with: npm exec tsx -- src/main/__tests__/agent-task-transcript.test.ts
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentDefinition, FileChangeSummary, LoadAgentsResult, TurnDiffSummary } from "@earendil-works/pi-coding-agent";
import { isProductEvent, type ProductEvent } from "../../shared/product-events.js";
import type {
  AgentTaskActivity,
  AgentTaskInfo,
  AgentTaskSpec,
  AgentTaskUsage,
} from "../../shared/agent-task-types.js";
import type { ProjectLocation } from "../../shared/project-location.js";
import type { SubagentSingleResult } from "../../shared/subagent-types.js";
import { workspaceIdOf } from "../agent-task/agent-task-identity.js";
import { SettingsStore } from "../settings-store.js";
import type { ProductEventCollector } from "../product-event-collector.js";
import type { SubagentParentRuntimeSnapshot, SubagentTaskItem } from "../subagent/types.js";
import type { AgentTaskInputRouter } from "../agent-task/agent-task-input.js";
import type { AgentTaskRuntime, AgentTaskRuntimeResult } from "../agent-task/agent-task-runtime.js";
import {
  AgentTaskStore,
  type TranscriptPageRead,
} from "../agent-task/agent-task-store.js";
import {
  AgentTaskService,
  __setAgentTaskServiceHooksForTests,
  type AgentTaskServiceEvent,
  type AgentTaskServiceTestHooks,
  type AgentTaskSubmissionContext,
  type CreateTaskParams,
} from "../agent-task/agent-task-service.js";

// ============================================================================
// Test harness (matches agent-task-ipc.test.ts style)
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
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
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

function drain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(condition: () => boolean, iterations = 20000, message = "condition"): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    if (condition()) {
      return;
    }
    await drain();
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function emptyUsage(): AgentTaskUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 };
}

// ============================================================================
// Fakes
// ============================================================================

const PROJECT: ProjectLocation = {
  path: "E:\\proj\\demo",
  physicalPath: "E:\\proj\\demo",
  name: "demo",
  environment: { kind: "windows" },
};

function makeModel(id: string, provider = "faux"): Model<Api> {
  return {
    id,
    name: id,
    api: "faux-api",
    provider,
    baseUrl: "http://localhost:1",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 4096,
  } as Model<Api>;
}

function makeAgent(name: string, source: AgentDefinition["source"] = "user"): AgentDefinition {
  return {
    name,
    description: `${name} description`,
    systemPrompt: `${name} system prompt`,
    source,
    filePath: source === "built-in" ? undefined : `agents/${name}.md`,
    baseDir: "agents",
  };
}

function makeTask(index: number, agentName = "general-purpose"): SubagentTaskItem {
  return {
    subagent_type: agentName,
    prompt: `Task prompt ${index} - do the thing`,
    description: `Task ${index} description`,
  };
}

const PARENT_RUNTIME: SubagentParentRuntimeSnapshot = {
  model: makeModel("parent-model", "faux"),
  thinkingLevel: "xhigh",
  executionMode: "approval",
  verificationGate: false,
  acp: false,
};

class FakeCollector {
  readonly records: ProductEvent[] = [];
  record(event: ProductEvent): void {
    if (isProductEvent(event)) {
      this.records.push(event);
    }
  }
}

interface FakeTimerEntry {
  callback: () => void;
  ms: number;
  cancelled: boolean;
}

/** Hand-rolled fake timers with a mutable clock (deterministic throttle tests). */
function makeFakeTimers(start: number): {
  now: () => number;
  advance: (ms: number) => void;
  setTimer: (callback: () => void, ms: number) => { cancel: () => void };
  timers: () => FakeTimerEntry[];
  fireAll: () => void;
} {
  let clock = start;
  const entries: FakeTimerEntry[] = [];
  return {
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    setTimer: (callback, ms) => {
      const entry: FakeTimerEntry = { callback, ms, cancelled: false };
      entries.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
    timers: () => entries,
    fireAll: () => {
      for (const entry of [...entries]) {
        if (!entry.cancelled) {
          entry.callback();
        }
      }
    },
  };
}

type AgentTaskRuntimeEventLike =
  | { type: "activity"; activity: AgentTaskActivity }
  | { type: "output"; text: string; truncated: boolean; originalBytes: number }
  | { type: "file_change"; change: FileChangeSummary; aggregate: TurnDiffSummary }
  | { type: "assistant_finalized"; entryId: string }
  | { type: "item_result"; result: SubagentSingleResult }
  | { type: "nested_transcript"; itemIndex: number; event: object }
  | { type: "item_session"; itemIndex: number; sessionFileName: string };

class FakeRuntime {
  static instances: FakeRuntime[] = [];

  readonly spec: AgentTaskSpec;
  input: AgentTaskInputRouter | undefined;
  onEvent: ((event: AgentTaskRuntimeEventLike) => void) | undefined;
  forwarding = false;
  private _resolveRun: ((result: AgentTaskRuntimeResult) => void) | undefined;
  settled = false;

  constructor(spec: AgentTaskSpec) {
    this.spec = spec;
    FakeRuntime.instances.push(this);
  }

  run(_signal: AbortSignal, onEvent: (event: AgentTaskRuntimeEventLike) => void): Promise<AgentTaskRuntimeResult> {
    this.onEvent = onEvent;
    return new Promise<AgentTaskRuntimeResult>((resolve) => {
      this._resolveRun = resolve;
    });
  }

  setTranscriptForwarding(enabled: boolean): void {
    this.forwarding = enabled;
  }

  emitNestedTranscript(itemIndex: number, event: object): void {
    this.onEvent?.({ type: "nested_transcript", itemIndex, event });
  }

  emitItemSession(itemIndex: number, sessionFileName: string): void {
    this.onEvent?.({ type: "item_session", itemIndex, sessionFileName });
  }

  emitFileChange(): void {
    this.onEvent?.({
      type: "file_change",
      change: { path: "src/a.txt", toolCallId: "fc-1", toolName: "edit", added: 1, removed: 0 },
      aggregate: { added: 1, removed: 0, files: 1, changes: [] },
    });
  }

  emitActivity(activity: AgentTaskActivity): void {
    this.onEvent?.({ type: "activity", activity });
  }

  emitOutput(text: string, truncated = false, originalBytes = Buffer.byteLength(text, "utf8")): void {
    this.onEvent?.({ type: "output", text, truncated, originalBytes });
  }

  complete(partial?: Partial<AgentTaskRuntimeResult>): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this._resolveRun?.({
      status: "completed",
      finalOutput: `final-${this.spec.taskId}`,
      results: this.spec.items.map((item, index) => this.makeItemResult(item, index)),
      usage: emptyUsage(),
      activities: [],
      ...partial,
    });
  }

  private makeItemResult(item: AgentTaskSpec["items"][number], index: number): SubagentSingleResult {
    return {
      id: `fake-${this.spec.taskId}-${index}`,
      index: item.index,
      step: this.spec.mode === "chain" ? item.index + 1 : undefined,
      agentName: item.resolution === "ready" ? item.agent.name : item.requestedAgentName ?? "general-purpose",
      agentSource: item.resolution === "ready" ? item.agent.source : "unknown",
      description: item.description,
      status: "completed",
      finalOutput: `output-${index}`,
      outputTruncated: false,
      originalOutputBytes: 0,
      toolUseCount: 1,
      activities: [],
      usage: emptyUsage(),
      model: item.resolution === "ready" ? `${item.model.provider}/${item.model.modelId}` : undefined,
      startedAt: 1000,
      endedAt: 2000,
      durationMs: 1000,
    };
  }

  abort(): void {
    if (!this.settled) {
      this.complete({
        status: "cancelled",
        results: this.spec.items.map((item, index) => ({
          ...this.makeItemResult(item, index),
          status: "aborted",
          failureReason: "aborted",
          errorMessage: "The agent task was aborted.",
        })),
      });
    }
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  resolveInput(_requestId: string, _response: unknown): boolean {
    return true;
  }

  cancelInput(_requestId: string): boolean {
    return true;
  }
}

interface Harness {
  service: AgentTaskService;
  store: AgentTaskStore;
  storeRoot: string;
}

function makeHarness(extraHooks?: Partial<AgentTaskServiceTestHooks>): Harness {
  FakeRuntime.instances = [];
  const cwd = mkdtempSync(join(tmpdir(), "pix-agent-task-transcript-"));
  const settings = new SettingsStore({ cwd });
  settings.set("enableProductAnalytics", true);
  const events = new FakeCollector() as unknown as ProductEventCollector;
  const storeRoot = mkdtempSync(join(tmpdir(), "pix-agent-task-transcript-store-"));
  const store = new AgentTaskStore({
    rootDir: storeRoot,
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const service = new AgentTaskService({ settings, events, store, runId: "test-run-transcript" });
  __setAgentTaskServiceHooksForTests({
    autoBackgroundMsOverride: 0,
    runtimeFactory: (spec) => {
      const fake = new FakeRuntime(spec);
      return fake as unknown as AgentTaskRuntime;
    },
    ...extraHooks,
  });
  return { service, store, storeRoot };
}

function makeContext(harness: Harness): AgentTaskSubmissionContext {
  const loaded: LoadAgentsResult = {
    agents: [makeAgent("general-purpose", "built-in")],
    projectAgentsDir: "E:\\proj\\demo\\.pi\\agents",
    diagnostics: [],
  };
  return {
    parentSessionId: "session-1",
    parentToolCallId: "tool-call-1",
    project: { ...PROJECT },
    agentDir: join(tmpdir(), "pix-agent-task-transcript-agent"),
    loadedAgents: loaded,
    modelRegistry: {
      getAll: () => [makeModel("alpha", "faux")],
      find: (provider: string, modelId: string) =>
        provider === "faux" && modelId === "alpha" ? makeModel(modelId, "faux") : undefined,
      hasConfiguredAuth: () => true,
    } as never,
    parentRuntime: { ...PARENT_RUNTIME },
    requestUserInput: async () => ({ id: "unused", answers: {}, cancelled: true }),
    hostDisposed: Promise.resolve("host_disposed" as const),
  };
}

function makeParams(
  mode: "single" | "parallel" | "chain",
  tasks: SubagentTaskItem[],
  overrides?: Partial<CreateTaskParams>,
): CreateTaskParams {
  return {
    mode,
    agentScope: "user",
    tasks,
    runInBackground: false,
    ...overrides,
  };
}

async function createSingleForegroundTask(harness: Harness): Promise<{ taskId: string; runtime: FakeRuntime }> {
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), makeContext(harness), "foreground");
  const taskId = handle.tasks[0].taskId;
  const runtime = FakeRuntime.instances.find((fake) => fake.spec.taskId === taskId);
  if (!runtime) {
    throw new Error("FakeRuntime for the single task not found");
  }
  return { taskId, runtime };
}

function findTask(harness: Harness, taskId: string): AgentTaskInfo {
  const task = harness.service.getAll().tasks.find((info) => info.taskId === taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  return task;
}

/** Session JSONL writer: header + raw lines (each may be valid JSON or garbage). */
function writeSessionFile(harness: Harness, taskId: string, fileName: string, lines: unknown[]): void {
  const sessionsDir = join(harness.storeRoot, workspaceIdOf(PROJECT.physicalPath), taskId, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const body = lines.map((line) => `${typeof line === "string" ? line : JSON.stringify(line)}\n`).join("");
  writeFileSync(join(sessionsDir, fileName), body);
}

function messageEntry(id: string, role: string, content: string): Record<string, unknown> {
  return { type: "message", id, timestamp: "2026-01-01T00:00:00Z", role, content };
}

// ============================================================================
// 4.3 store-level: lenient paginated reading
// ============================================================================

await run("store: 宽松分页读 - 口径筛选 + 坏行跳过 + 全文件计数", async () => {
  const storeRoot = mkdtempSync(join(tmpdir(), "pix-transcript-store-"));
  const store = new AgentTaskStore({
    rootDir: storeRoot,
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const sessionsDir = join(storeRoot, "ws", "t1", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const lines: unknown[] = [
    { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "E:\\proj\\demo" },
    messageEntry("m1", "user", "中文第一行"),
    "this is not json", // 原始坏行(非 JSON)
    messageEntry("m2", "assistant", "助手回复 🎉"),
    { type: "tool_execution", id: "x1", timestamp: "2026-01-01T00:00:02Z", toolCallId: "call-1" },
    { type: "custom_message", id: "c1", timestamp: "2026-01-01T00:00:03Z", customType: "note", display: false },
    { type: "custom_message", id: "c2", timestamp: "2026-01-01T00:00:04Z", customType: "note", display: true },
    { type: "message", id: "m3" },
    "{\"broken\":", // 原始坏行(截断 JSON)
  ];
  writeFileSync(
    join(sessionsDir, "sess.jsonl"),
    lines.map((line) => `${typeof line === "string" ? line : JSON.stringify(line)}\n`).join(""),
  );

  const page: TranscriptPageRead = await store.readTranscriptPage("ws", "t1", "sess.jsonl", undefined, 100);
  // 口径: message(c1 display:false 排除, m3 缺字符串字段但仍按 type 判定为
  // message → 计入) + display!==false 的 custom_message。
  const ids = page.entries.map((entry) => (entry as { id: string }).id);
  assertEqual(ids, ["m1", "m2", "c2", "m3"], "entries = message + displayable custom_message, header/tool/hidden excluded");
  assertEqual(page.totalCount, 4, "totalCount counts the whole file's entry set");
  assertEqual(page.skippedLines, 2, "bad lines counted: raw text + truncated JSON");
  assertEqual(page.nextCursor, null, "whole file in one page");
});

await run("store: 分页 + cursor 续读(中文与 emoji 多字节跨页, byteOffset 语义)", async () => {
  const storeRoot = mkdtempSync(join(tmpdir(), "pix-transcript-page-"));
  const store = new AgentTaskStore({
    rootDir: storeRoot,
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const sessionsDir = join(storeRoot, "ws", "t1", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const messageEntries = [
    messageEntry("m1", "user", "中文'你好'与 emoji 🎉 混排的内容"),
    messageEntry("m2", "assistant", "第一行回复包含中文标点——分页边界"),
    messageEntry("m3", "user", "第二页: 🚀 火箭与 💡 灯泡都按字节偏移续读"),
    messageEntry("m4", "assistant", "最后一行"),
  ];
  writeFileSync(
    join(sessionsDir, "sess.jsonl"),
    `${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "E:\\proj\\demo" })}\n` +
      messageEntries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
  );

  const p1 = await store.readTranscriptPage("ws", "t1", "sess.jsonl", undefined, 2);
  assertEqual(p1.entries.length, 2, "page 1 holds two entries");
  assertEqual((p1.entries[0] as { id: string }).id, "m1", "page 1 starts at m1");
  assert(p1.nextCursor !== null, "page 1 not at the end");
  const p2 = await store.readTranscriptPage("ws", "t1", "sess.jsonl", p1.nextCursor!, 2);
  assertEqual(p2.entries.length, 2, "page 2 holds two entries");
  assertEqual((p2.entries[1] as { id: string }).id, "m4", "page 2 ends at m4");
  assertEqual((p2.entries[0] as { content: string }).content, messageEntries[2].content as string, "multi-byte content intact across the boundary");
  assertEqual(p2.nextCursor, null, "page 2 reaches the file end");
  // 逐条共读两页:没有丢失/重复。
  const all = [...p1.entries, ...p2.entries];
  assertEqual(
    all.map((entry) => (entry as { id: string }).id),
    ["m1", "m2", "m3", "m4"],
    "pages concatenate without loss or duplication",
  );

  // 无效 cursor 与越界 cursor:宽松处理,从 0 或 EOF 开始,绝不报错。
  const bad = await store.readTranscriptPage("ws", "t1", "sess.jsonl", "not-a-cursor", 100);
  assertEqual(bad.entries.length, 4, "invalid cursor falls back to the start");
  const beyond = await store.readTranscriptPage("ws", "t1", "sess.jsonl", JSON.stringify({ o: 10_000_000 }), 100);
  assertEqual(beyond.entries.length, 0, "beyond-EOF cursor yields an empty page");
  assertEqual(beyond.nextCursor, null, "beyond-EOF cursor ends");
});

await run("store: 文件不存在返回全空; 目录不存在 listSessionFiles 返回 []", async () => {
  const storeRoot = mkdtempSync(join(tmpdir(), "pix-transcript-missing-"));
  const store = new AgentTaskStore({
    rootDir: storeRoot,
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const page = await store.readTranscriptPage("ws", "t1", "missing.jsonl", undefined, 10);
  assertEqual(page, { entries: [], totalCount: 0, nextCursor: null, prevCursor: null, skippedLines: 0 }, "missing file returns a fully empty page");
  assertEqual(await store.listSessionFiles("ws", "t1"), [], "missing sessions dir returns []");
});

await run("store: listSessionFiles 只列 .jsonl 且字典序; 路径逃逸被拒绝", async () => {
  const storeRoot = mkdtempSync(join(tmpdir(), "pix-transcript-listing-"));
  const store = new AgentTaskStore({
    rootDir: storeRoot,
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const sessionsDir = join(storeRoot, "ws", "t1", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, "b.jsonl"), "{}\n");
  writeFileSync(join(sessionsDir, "a.jsonl"), "{}\n");
  writeFileSync(join(sessionsDir, "notes.txt"), "not a transcript\n");
  writeFileSync(join(sessionsDir, "a.jsonl.bak"), "{}\n");
  assertEqual(await store.listSessionFiles("ws", "t1"), ["a.jsonl", "b.jsonl"], "only .jsonl files, lexicographic order");
  let threw = "";
  try {
    await store.readTranscriptPage("ws", "t1", "..\\evil.jsonl", undefined, 10);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  assert(threw.includes("session transcript file name"), "escaping file name rejected by the path guard");
});

// ============================================================================
// service: item_session log-driven mapping + legacy fallbacks
// ============================================================================

await run("service: item_session 映射优先于字典序, orphan 文件被忽略, 后写覆盖先写", async () => {
  const harness = makeHarness();
  const { taskId } = await createSingleForegroundTask(harness);
  const workspaceId = findTask(harness, taskId).workspaceId;

  // 三个文件: a.jsonl(字典序最前, 但未映射 = orphan), z.jsonl(映射到的),
  // 后用 item_session 覆盖 0 → y.jsonl(后写覆盖先写)。
  writeSessionFile(harness, taskId, "a.jsonl", [
    { type: "session", id: "orphan", timestamp: "2026-01-01T00:00:00Z", cwd: "E:\\proj\\demo" },
    messageEntry("oa", "assistant", "orphan content: 永远不会被读到"),
  ]);
  writeSessionFile(harness, taskId, "z.jsonl", [
    { type: "session", id: "mapped", timestamp: "2026-01-01T00:00:00Z", cwd: "E:\\proj\\demo" },
    messageEntry("za", "assistant", "mapped content: z"),
  ]);
  writeSessionFile(harness, taskId, "y.jsonl", [
    { type: "session", id: "covered", timestamp: "2026-01-01T00:00:00Z", cwd: "E:\\proj\\demo" },
    messageEntry("ya", "assistant", "覆盖后的映射: y"),
  ]);

  await harness.store.appendEvent(workspaceId, taskId, { type: "item_session", itemIndex: 0, sessionFileName: "z.jsonl" });
  await harness.store.appendEvent(workspaceId, taskId, { type: "item_session", itemIndex: 0, sessionFileName: "y.jsonl" });

  const page = await harness.service.getTranscriptPage(taskId, 0, undefined, 10);
  assertEqual(page.entries.length, 1, "mapped file read");
  assertEqual((page.entries[0] as { content: string }).content, "覆盖后的映射: y", "last item_session wins over the first");
  assertEqual(page.totalCount, 1, "totalCount from the mapped file");
  // orphan (a.jsonl) 即使字典序最前也从不被读取。
  assert(!page.entries.some((entry) => (entry as { content: string }).content.includes("orphan")), "orphan file ignored");
});

await run("service: 旧任务降级 - 单文件直映与多文件字典序; 无映射无文件返回空页", async () => {
  const harness = makeHarness();
  const { taskId } = await createSingleForegroundTask(harness);

  // 无 item_session 条目 + 单文件: 全部 itemIndex 直映该文件。
  writeSessionFile(harness, taskId, "only.jsonl", [
    { type: "session", id: "only", timestamp: "2026-01-01T00:00:00Z", cwd: "E:\\proj\\demo" },
    messageEntry("only-1", "assistant", "单文件内容"),
  ]);
  const single = await harness.service.getTranscriptPage(taskId, 0, undefined, 10);
  const singleHigh = await harness.service.getTranscriptPage(taskId, 3, undefined, 10);
  assertEqual(single.entries.length, 1, "single-file fallback reads item 0");
  assertEqual(singleHigh.entries.length, 1, "single-file fallback maps every item index");

  // 多文件: 按字典序序数映射 (aa → 0, bb → 1)。
  writeSessionFile(harness, taskId, "aa.jsonl", [
    { type: "session", id: "aa", timestamp: "2026-01-01T00:00:00Z", cwd: "E:\\proj\\demo" },
    messageEntry("aa-1", "assistant", "序数 0 内容"),
  ]);
  writeSessionFile(harness, taskId, "bb.jsonl", [
    { type: "session", id: "bb", timestamp: "2026-01-01T00:00:00Z", cwd: "E:\\proj\\demo" },
    messageEntry("bb-1", "assistant", "序数 1 内容"),
  ]);
  const dic0 = await harness.service.getTranscriptPage(taskId, 0, undefined, 10);
  const dic1 = await harness.service.getTranscriptPage(taskId, 1, undefined, 10);
  assertEqual((dic0.entries[0] as { content: string }).content, "序数 0 内容", "dictionary ordinal 0 -> aa.jsonl");
  assertEqual((dic1.entries[0] as { content: string }).content, "序数 1 内容", "dictionary ordinal 1 -> bb.jsonl");
  const dic3 = await harness.service.getTranscriptPage(taskId, 3, undefined, 10);
  assertEqual(dic3.entries.length, 0, "ordinal beyond the file list -> empty page");

  // 既无映射也无文件: 空页。
  const harness2 = makeHarness();
  const empty = await createSingleForegroundTask(harness2);
  const emptyPage = await harness2.service.getTranscriptPage(empty.taskId, 0, undefined, 10);
  assertEqual(emptyPage.entries.length, 0, "no mapping no files -> empty page");
  assertEqual(emptyPage.totalCount, 0, "empty page totalCount 0");
  assertEqual(emptyPage.nextCursor, null, "empty page nextCursor null");
});

await run("service: 任务不在镜像抛 not_found; 读异常向上抛原始错误", async () => {
  const harness = makeHarness();
  let notFound = "";
  try {
    await harness.service.getTranscriptPage("ghost-task", 0, undefined, 10);
  } catch (err) {
    notFound = err instanceof Error ? err.message : String(err);
  }
  assertEqual(notFound, "not_found", "unknown task throws not_found");

  const { taskId } = await createSingleForegroundTask(harness);
  const workspaceId = findTask(harness, taskId).workspaceId;
  await harness.store.appendEvent(workspaceId, taskId, { type: "item_session", itemIndex: 0, sessionFileName: "..\\evil" });
  let escaped = "";
  try {
    await harness.service.getTranscriptPage(taskId, 0, undefined, 10);
  } catch (err) {
    escaped = err instanceof Error ? err.message : String(err);
  }
  assert(escaped.includes("session transcript file name"), "path-guard error propagates with its original message");
});

// ============================================================================
// 4.5 service: live watch/forward channel
// ============================================================================

await run("service: 无 watcher 零事件(零订阅零开销)", async () => {
  const fakeTimers = makeFakeTimers(2_000_000);
  const harness = makeHarness({ now: fakeTimers.now, setTimer: fakeTimers.setTimer });
  const serviceEvents: AgentTaskServiceEvent[] = [];
  harness.service.onEvent((event) => serviceEvents.push(event));
  const { runtime } = await createSingleForegroundTask(harness);

  runtime.emitNestedTranscript(0, { type: "message_start", message: { role: "user", content: "hi" } });
  runtime.emitNestedTranscript(0, { type: "message_update", message: { role: "assistant", content: "st" } });
  runtime.emitNestedTranscript(0, { type: "message_end", message: { role: "assistant", content: "done" } });
  fakeTimers.fireAll();
  assertEqual(runtime.forwarding, false, "no watch -> runtime forwarding off");
  assertEqual(
    serviceEvents.filter((event) => event.type === "task_transcript").length,
    0,
    "no task_transcript without a watcher",
  );
});

await run("service: watch 开启转发; task_transcript JSON round-trip 结构一致", async () => {
  const fakeTimers = makeFakeTimers(2_000_000);
  const harness = makeHarness({ now: fakeTimers.now, setTimer: fakeTimers.setTimer });
  const serviceEvents: AgentTaskServiceEvent[] = [];
  harness.service.onEvent((event) => serviceEvents.push(event));
  const { taskId, runtime } = await createSingleForegroundTask(harness);

  assertEqual(harness.service.watchTask(taskId), true, "watchTask succeeds");
  assertEqual(harness.service.isTaskWatched(taskId), true, "isTaskWatched true");
  assertEqual(runtime.forwarding, true, "0->1 with a live runtime enables forwarding");

  // 一条带嵌套结构的消息事件: 结构化克隆后逐层一致。
  const nested: object = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "hello 🌍" },
        { type: "tool_use", id: "call-42", name: "edit", input: { path: "E:\\proj\\demo\\a.txt", text: "修改内容" } },
      ],
      timestamp: 1767196800000,
    },
  };
  runtime.emitNestedTranscript(0, nested);
  fakeTimers.fireAll();
  assertEqual(
    serviceEvents.filter((event) => event.type === "task_transcript").length,
    1,
    "one watched event becomes one task_transcript",
  );
  const transcriptEvent = serviceEvents.find((event) => event.type === "task_transcript") as Extract<
    AgentTaskServiceEvent,
    { type: "task_transcript" }
  >;
  assertEqual(transcriptEvent.taskId, taskId, "task_transcript carries the taskId");
  const roundTrip = JSON.parse(JSON.stringify(transcriptEvent)) as typeof transcriptEvent;
  assertEqual(
    roundTrip,
    transcriptEvent,
    "JSON round-trip of task_transcript (cast seam + nested event) is structurally identical",
  );
});

await run("service: queued 阶段 watch, 获槽位后直播不中断(运行时创建点初始化)", async () => {
  const harness = makeHarness();
  const serviceEvents: AgentTaskServiceEvent[] = [];
  harness.service.onEvent((event) => serviceEvents.push(event));

  // 填满 4 个运行槽。
  const parallel = await harness.service.createTaskGroup(
    makeParams("parallel", [makeTask(0), makeTask(1), makeTask(2), makeTask(3)]),
    makeContext(harness),
    "foreground",
  );
  const runners = parallel.tasks.map(
    (task) => FakeRuntime.instances.find((fake) => fake.spec.taskId === task.taskId)!,
  );

  // 第 5 个任务排队。
  const queued = await harness.service.createTaskGroup(makeParams("single", [makeTask(4)]), makeContext(harness), "foreground");
  const queuedTaskId = queued.tasks[0].taskId;
  await waitFor(() => findTask(harness, queuedTaskId).status === "queued", 20000, "task queued");
  assertEqual(harness.service.watchTask(queuedTaskId), true, "queued task is watcheable");
  const queuedRuntime = FakeRuntime.instances.find((fake) => fake.spec.taskId === queuedTaskId);
  assertEqual(queuedRuntime?.forwarding ?? "no-runtime", "no-runtime", "no runtime while queued (forwarding not yet applied)");

  // 释放一个槽位 → 排队任务获槽位启动: 运行时创建点按 watcher 计数开转发。
  runners[0].complete();
  await waitFor(() => FakeRuntime.instances.some((fake) => fake.spec.taskId === queuedTaskId), 20000, "queued task started");
  const started = FakeRuntime.instances.find((fake) => fake.spec.taskId === queuedTaskId)!;
  assertEqual(started.forwarding, true, "runtime creation point applies the watcher count");

  // 直播到达。
  started.emitNestedTranscript(0, { type: "turn_start" });
  await waitFor(
    () => serviceEvents.some((event) => event.type === "task_transcript"),
    20000,
    "live transcript after slot grant",
  );
  const transcript = serviceEvents.find((event) => event.type === "task_transcript") as Extract<
    AgentTaskServiceEvent,
    { type: "task_transcript" }
  >;
  assertEqual(transcript.taskId, queuedTaskId, "queued-subscribed task streams live");
});

await run("service: 终态收敛 - flush 先于终态 task_state, watcher 清空, 转发关闭, 终态后零事件", async () => {
  const fakeTimers = makeFakeTimers(2_000_000);
  const harness = makeHarness({ now: fakeTimers.now, setTimer: fakeTimers.setTimer });
  const serviceEvents: AgentTaskServiceEvent[] = [];
  harness.service.onEvent((event) => serviceEvents.push(event));
  const { taskId, runtime } = await createSingleForegroundTask(harness);
  harness.service.watchTask(taskId);

  runtime.emitNestedTranscript(0, {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "read",
    args: { path: "a.txt" },
  });
  runtime.emitNestedTranscript(0, { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: {}, isError: false });
  fakeTimers.fireAll();
  assertEqual(serviceEvents.filter((event) => event.type === "task_transcript").length, 2, "two events queued and flushed");

  runtime.complete();
  await waitFor(() => serviceEvents.some((event) => event.type === "task_state" && event.task.status === "completed"), 20000, "terminal state");
  const terminalIndex = serviceEvents.findIndex((event) => event.type === "task_state" && event.task.status === "completed");
  const transcriptIndexes = serviceEvents
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === "task_transcript")
    .map(({ index }) => index);
  assert(transcriptIndexes.every((index) => index < terminalIndex), "all task_transcript events precede the terminal task_state");
  assertEqual(harness.service.isTaskWatched(taskId), false, "watcher count cleared at terminal");
  assertEqual(runtime.forwarding, false, "runtime forwarding switched off at terminal");

  // 终态后: 残余事件不再产生任何 transcript。
  const after = serviceEvents.length;
  runtime.emitNestedTranscript(0, { type: "turn_start" });
  fakeTimers.fireAll();
  assertEqual(serviceEvents.length, after, "no events after the terminal state");
});

await run("service: message_update 队尾合并(同 item 替换, 跨 item 不合并)", async () => {
  const fakeTimers = makeFakeTimers(2_000_000);
  const harness = makeHarness({ now: fakeTimers.now, setTimer: fakeTimers.setTimer });
  const serviceEvents: AgentTaskServiceEvent[] = [];
  harness.service.onEvent((event) => serviceEvents.push(event));
  const { taskId, runtime } = await createSingleForegroundTask(harness);
  harness.service.watchTask(taskId);

  // 预热: 第一条活动立即 flush, 令 lastEmitAt 落在窗口内(TEXT_UPDATE_THROTTLE_MS=100)。
  runtime.emitActivity({ sequence: 1, toolCallId: "warm", toolName: "read", status: "completed", summary: "warm", startedAt: 1, endedAt: 2 });
  fakeTimers.fireAll();

  // 同一 item 的三条流式更新合并为最后快照; 随后端消息原样追加。
  runtime.emitNestedTranscript(0, { type: "message_update", message: { role: "assistant", content: "a" } });
  runtime.emitNestedTranscript(0, { type: "message_update", message: { role: "assistant", content: "ab" } });
  runtime.emitNestedTranscript(0, { type: "message_update", message: { role: "assistant", content: "abc" } });
  runtime.emitNestedTranscript(0, { type: "message_end", message: { role: "assistant", content: "abc" } });
  fakeTimers.fireAll();
  const updateEvents = serviceEvents.filter((event) => event.type === "task_transcript") as Array<
    Extract<AgentTaskServiceEvent, { type: "task_transcript" }>
  >;
  assertEqual(
    updateEvents.map((event) => (event.event as { type: string; message: { content: string } }).type).join(","),
    "message_update,message_end",
    "three updating events merge into the final snapshot",
  );
  assertEqual(
    (updateEvents[0].event as { message: { content: string } }).message.content,
    "abc",
    "merged update carries the last full text",
  );

  // 跨 item 的 message_update 不合并(队尾 itemIndex 不同)。
  const before = serviceEvents.length;
  runtime.emitNestedTranscript(0, { type: "message_update", message: { role: "assistant", content: "item0-again" } });
  runtime.emitNestedTranscript(1, { type: "message_update", message: { role: "assistant", content: "item1" } });
  fakeTimers.fireAll();
  const crossItem = serviceEvents.slice(before).filter((event) => event.type === "task_transcript");
  assertEqual(crossItem.length, 2, "cross-item updates both keep their own queue slot");
  assertEqual((crossItem[0] as { itemIndex: number }).itemIndex, 0, "first cross-item event keeps item 0");
  assertEqual((crossItem[1] as { itemIndex: number }).itemIndex, 1, "second cross-item event keeps item 1");
  void taskId;
});

await run("service: pendingTranscript 容量 1000, 溢出丢最旧", async () => {
  const fakeTimers = makeFakeTimers(2_000_000);
  const harness = makeHarness({ now: fakeTimers.now, setTimer: fakeTimers.setTimer });
  const serviceEvents: AgentTaskServiceEvent[] = [];
  harness.service.onEvent((event) => serviceEvents.push(event));
  const { runtime } = await createSingleForegroundTask(harness);
  harness.service.watchTask(runtime.spec.taskId);

  // 预热同 message_update 测试。
  runtime.emitActivity({ sequence: 1, toolCallId: "warm", toolName: "read", status: "completed", summary: "warm", startedAt: 1, endedAt: 2 });
  fakeTimers.fireAll();

  // 1001 个互不合并的事件(tool_execution_start 无合并规则)。
  for (let i = 1; i <= 1001; i++) {
    runtime.emitNestedTranscript(0, { type: "tool_execution_start", toolCallId: `call-${i}`, toolName: "read", args: { path: `f-${i}` } });
  }
  fakeTimers.fireAll();
  const transcriptEvents = serviceEvents.filter((event) => event.type === "task_transcript") as Array<
    Extract<AgentTaskServiceEvent, { type: "task_transcript" }>
  >;
  assertEqual(transcriptEvents.length, 1000, "capacity capped at 1000");
  assertEqual(
    (transcriptEvents[0].event as { toolCallId: string }).toolCallId,
    "call-2",
    "overflow dropped the oldest entry (call-1)",
  );
  assertEqual(
    (transcriptEvents[transcriptEvents.length - 1].event as { toolCallId: string }).toolCallId,
    "call-1001",
    "newest entry survives",
  );
});

await run("service: runtime item_session 持久化进任务日志(不节流, 不依赖 watcher)", async () => {
  const harness = makeHarness();
  const { taskId, runtime } = await createSingleForegroundTask(harness);
  const workspaceId = findTask(harness, taskId).workspaceId;

  // 无 watcher 也持久化。
  runtime.emitItemSession(0, "sess-1.jsonl");
  let persisted = false;
  for (let i = 0; i < 20000 && !persisted; i++) {
    const read = await harness.store.readTask(workspaceId, taskId);
    persisted = read.events.some((event) => event.type === "item_session");
    if (!persisted) {
      await drain();
    }
  }
  assert(persisted, "item_session persisted without a watcher");
  const read = await harness.store.readTask(workspaceId, taskId);
  const itemSession = read.events.find((event) => event.type === "item_session");
  assertEqual((itemSession as { type: string; itemIndex: number; sessionFileName: string }).itemIndex, 0, "item_session itemIndex");
  assertEqual((itemSession as { type: string; sessionFileName: string }).sessionFileName, "sess-1.jsonl", "item_session sessionFileName");
});

// ============================================================================
// 1.5 (P4) S6: file_change 持久化 + get_task_log 数据面
// ============================================================================

await run("S6: file_change 落盘 payload 只含 change 不含 aggregate", async () => {
  const harness = makeHarness();
  const { taskId, runtime } = await createSingleForegroundTask(harness);

  runtime.emitFileChange();
  const snap = await harness.service.getTaskLog(taskId);
  const fileChange = snap.events.find((event) => event.type === "file_change");
  assert(fileChange !== undefined, "file_change event persisted");
  if (fileChange !== undefined) {
    assertEqual((fileChange.change as { toolCallId: string }).toolCallId, "fc-1", "change payload carries the toolCallId");
    assertEqual((fileChange.change as { path: string }).path, "src/a.txt", "change payload carries the path");
    assertEqual((fileChange.change as { added: number }).added, 1, "added count persisted");
    assert(!("aggregate" in fileChange), "turn aggregate never persisted");
    assert(!("changes" in fileChange), "TurnDiffSummary.changes array never persisted");
  }
});

await run("S6: 终态后立即 getTaskLog 读到最后一批变更(drain 屏障)", async () => {
  const harness = makeHarness();
  const { taskId, runtime } = await createSingleForegroundTask(harness);

  runtime.emitFileChange();
  runtime.complete();
  // 无 waitFor:getTaskLog 内部先 drain 串行 flush 队列再 readTask,终态后
  // 立即读取也必须看到刚上报的 file_change 与终态 state 事件。
  const snap = await harness.service.getTaskLog(taskId);
  assert(snap.events.some((event) => event.type === "file_change"), "last-batch file_change readable right after terminal");
  assert(
    snap.events.some((event) => event.type === "state" && (event as { to: string }).to === "completed"),
    "terminal state event readable in the same snapshot",
  );
  assertEqual(snap.truncated, false, "small log not truncated");
});

await run("S6: item_session 与 file_change 旧日志兼容(无新条目不报错)", async () => {
  const harness = makeHarness();
  const { taskId } = await createSingleForegroundTask(harness);
  const workspaceId = findTask(harness, taskId).workspaceId;

  // 模拟 1.5 之前的旧日志:只有 state 与 delivery 条目,没有 item_session /
  // file_change。getTaskLog 必须原样读出且不报错。先 drain(slot grant 的
  // running 事件仍在待 flush 队列),避免覆盖后被追加进 NEW 条目。
  await harness.service.getTaskLog(taskId);
  const info = findTask(harness, taskId);
  const oldEvents = [
    { type: "state", from: "queued", to: "running", info, seq: 1, ts: 1000, reason: "slot grant" },
    { type: "delivery", targetSessionId: "session-1", deliveredAt: 2000, seq: 2, ts: 2000 },
  ];
  writeFileSync(
    join(harness.storeRoot, workspaceId, taskId, "events.jsonl"),
    oldEvents.map((event) => `${JSON.stringify(event)}\n`).join(""),
  );

  const snap = await harness.service.getTaskLog(taskId);
  assertEqual(snap.events.length, 2, "old log events read verbatim");
  assertEqual(snap.events[0].type, "state", "state entry survives");
  assertEqual(snap.events[1].type, "delivery", "delivery entry survives");
  assertEqual(snap.events.some((event) => event.type === "item_session"), false, "no item_session in a old log");
  assertEqual(snap.events.some((event) => event.type === "file_change"), false, "no file_change in a old log");
  assertEqual(snap.truncated, false, "old log not truncated");
});

await run("S6: 快照超过 10000 条保留最新并截断", async () => {
  const harness = makeHarness();
  const { taskId } = await createSingleForegroundTask(harness);
  const workspaceId = findTask(harness, taskId).workspaceId;

  // 先 drain 确保没有待 flush 的写入,再整体替换 events.jsonl(单次写盘,
  // 避免逐条 append 的 O(n²) 全文件扫描)。
  await harness.service.getTaskLog(taskId);
  const COUNT = 10005;
  const lines: string[] = [];
  for (let i = 1; i <= COUNT; i++) {
    lines.push(`${JSON.stringify({ type: "diagnostic", code: "d", message: "m", seq: i, ts: i })}\n`);
  }
  writeFileSync(join(harness.storeRoot, workspaceId, taskId, "events.jsonl"), lines.join(""));

  const snap = await harness.service.getTaskLog(taskId);
  assertEqual(snap.truncated, true, "snapshot truncated past 10000 events");
  assertEqual(snap.events.length, 10000, "latest 10000 events retained");
  assertEqual(snap.events[0].seq, 6, "oldest 5 events dropped (seq 1..5 gone)");
  assertEqual(snap.events[snap.events.length - 1].seq, 10005, "newest event survives");
});

await run("output persist coalesces snapshots: last written text equals the final emit", async () => {
  const harness = makeHarness();
  const { taskId, runtime } = await createSingleForegroundTask(harness);
  runtime.emitOutput("hel");
  runtime.emitOutput("hell");
  runtime.emitOutput("hello world");
  runtime.emitActivity({
    sequence: 1,
    toolCallId: "c1",
    toolName: "read",
    status: "running",
    summary: "read",
    startedAt: Date.now(),
  });
  runtime.emitOutput("hello world!");
  const snap = await harness.service.getTaskLog(taskId);
  const outputs = snap.events.filter((event) => event.type === "output");
  assert(outputs.length >= 1, "at least one output event persisted");
  assertEqual(
    (outputs[outputs.length - 1] as { text: string }).text,
    "hello world!",
    "merged last output text equals the final snapshot emit",
  );
  assert(
    snap.events.some((event) => event.type === "activity"),
    "activity events are not coalesced away",
  );
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
