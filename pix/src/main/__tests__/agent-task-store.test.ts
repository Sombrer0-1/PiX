/**
 * AgentTaskStore tests (1.4.2 R1, design plan section 4.7 / acceptance R1).
 *
 * Verifies: workspace enumeration, atomic index + index.prev fallback,
 * store-allocated monotonic event seq, tail/mid JSONL corruption, the
 * idempotent tail-repair transaction (hash-named immutable .bak backup,
 * retryable at any point of the transaction, appends stay valid JSONL after
 * repair), repair/backup/temp peak budgeting, unknown-schema read-only
 * isolation, migration-failure preservation, budget reservations, the 80%
 * warning level and hard limits, runId close-marker consumption, checkpoint
 * read/write structure, deleteTask and the shared AgentTaskRecoveryIssueCode
 * dependency of the store diagnostics.
 *
 * Run with: npm exec tsx -- src/main/__tests__/agent-task-store.test.ts
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentTaskStore,
  AGENT_TASK_CLOSE_MARKER_SCHEMA_VERSION,
  AGENT_TASK_STORAGE_WARNING_RATIO,
  TaskStorageLimitError,
  storageUsageLevel,
  type AgentTaskCloseMarker,
  type TaskCheckpoint,
  type TaskIndex,
  type TaskMetadata,
} from "../agent-task/agent-task-store.js";
import type { AgentTaskRecoveryIssueCode } from "../../shared/agent-task-types.js";
import type { ProjectLocation } from "../../shared/project-location.js";
import type { SubagentSingleResult } from "../../shared/subagent-types.js";

// ============================================================================
// Test harness (matches agent-task-types.test.ts style)
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

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message} - expected ${e}, got ${a}`);
  }
}

async function assertThrows(fn: () => Promise<unknown> | unknown, message: string): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    passed++;
    console.log(`  PASS: ${message}`);
    return err;
  }
  failed++;
  console.error(`  FAIL: ${message} - expected an error but none was thrown`);
  return undefined;
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

const STARTED = 1_770_000_000_000;
const ENDED = 1_770_000_000_420;

function makeProject(): ProjectLocation {
  return {
    path: "E:/develop/demo",
    physicalPath: "E:/develop/demo",
    name: "demo",
    environment: { kind: "windows" },
  };
}

function makeUsage() {
  return { input: 10, output: 20, cacheRead: 3, cacheWrite: 2, totalTokens: 35, cost: 0.0012, turns: 1 };
}

function makeActivity() {
  return {
    sequence: 1,
    toolCallId: "nested-tool-1",
    toolName: "grep",
    status: "completed",
    summary: "authentication",
    startedAt: STARTED,
    endedAt: ENDED,
  };
}

function makeResult(): SubagentSingleResult {
  return {
    id: "task-result-1",
    index: 0,
    agentName: "scout",
    agentSource: "user",
    description: "Locate auth entry points",
    status: "completed",
    finalOutput: "auth entry points: src/auth.ts",
    outputTruncated: false,
    originalOutputBytes: 30,
    toolUseCount: 1,
    activities: [makeActivity()],
    usage: makeUsage(),
    model: "provider/model-id",
    startedAt: STARTED,
    endedAt: ENDED,
    durationMs: 420,
  };
}

function makeItemSummary() {
  return {
    index: 0,
    agentName: "scout",
    agentSource: "user" as const,
    model: { provider: "provider", modelId: "model-id" },
    maxTurns: 40,
  };
}

function makeSpec(taskId: string, workspaceId: string) {
  return {
    schemaVersion: 1 as const,
    taskId,
    groupId: "group-1",
    groupMode: "single" as const,
    mode: "single" as const,
    items: [
      {
        resolution: "ready" as const,
        index: 0,
        prompt: "Locate auth entry points",
        description: "Locate auth entry points",
        agent: {
          name: "general-purpose",
          description: "General purpose",
          systemPrompt: "You are a general purpose agent.",
          source: "built-in" as const,
        },
        model: { provider: "provider", modelId: "model-id" },
        maxTurns: 40,
      },
    ],
    agentScope: "user" as const,
    thinkingLevel: "medium" as const,
    executionMode: "approval" as const,
    verificationGate: false,
    project: makeProject(),
    workspaceId,
    agentDir: "E:/develop/pi/pix",
    parentSessionId: "session-1",
    parentToolCallId: "tool-call-1",
    createdAt: STARTED,
  };
}

function makeInfo(taskId: string, workspaceId: string) {
  return {
    schemaVersion: 1 as const,
    taskId,
    groupId: "group-1",
    groupMode: "single" as const,
    workspaceId,
    parentSessionId: "session-1",
    parentToolCallId: "tool-call-1",
    itemSummaries: [makeItemSummary()],
    thinkingLevel: "medium" as const,
    executionMode: "approval" as const,
    project: makeProject(),
    presentation: "foreground" as const,
    status: "completed" as const,
    failureReason: undefined,
    errorMessage: undefined,
    description: "Locate auth entry points",
    finalOutput: "auth entry points: src/auth.ts",
    outputTruncated: false,
    originalOutputBytes: 30,
    results: [makeResult()],
    activities: [makeActivity()],
    usage: makeUsage(),
    toolUseCount: 1,
    createdAt: STARTED,
    startedAt: STARTED,
    updatedAt: ENDED,
    endedAt: ENDED,
    durationMs: 420,
    planLink: undefined,
    deliveredSessionIds: [],
    planLinkState: "none" as const,
    generation: 0,
  };
}

function makeMetadata(taskId: string, workspaceId: string): TaskMetadata {
  return { schemaVersion: 1, spec: makeSpec(taskId, workspaceId), initialInfo: makeInfo(taskId, workspaceId) };
}

function makeCheckpoint(taskId: string, seq: number): TaskCheckpoint {
  return {
    taskId,
    generation: 0,
    seq,
    activeItemIndex: 1,
    sessionFileName: "sess.jsonl",
    sessionLeafId: "e-2",
    openToolCalls: [],
    workspaceFingerprint: { isGit: false, observedFileHashes: { "src/auth.ts": "abc123" } },
    ts: STARTED,
  };
}

function makeIndex(workspaceId: string, generation: number, runId: string): TaskIndex {
  return {
    schemaVersion: 1,
    workspaceId,
    generation,
    lastWriterRunId: runId,
    tasks: [],
  };
}

function diagnosticEvent(code: string, message: string) {
  return { type: "diagnostic" as const, code, message };
}

// ============================================================================
// Store helpers
// ============================================================================

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-task-store-"));
  roots.push(dir);
  return dir;
}

function makeStore(
  rootDir: string,
  opts: { maxTaskBytes?: number; maxWorkspaceBytes?: number } = {},
): AgentTaskStore {
  return new AgentTaskStore({
    rootDir,
    maxTaskBytes: opts.maxTaskBytes ?? 25 * 1024 * 1024,
    maxWorkspaceBytes: opts.maxWorkspaceBytes ?? 500 * 1024 * 1024,
  });
}

async function writeSessionTranscript(rootDir: string, workspaceId: string, taskId: string, content: string): Promise<string> {
  const sessionsDir = join(rootDir, workspaceId, taskId, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const path = join(sessionsDir, "sess.jsonl");
  await writeFile(path, content, "utf-8");
  return path;
}

function sessionHeaderLine(): string {
  return '{"type":"session","version":3,"id":"sess-1","timestamp":"2026-08-11T00:00:00.000Z","cwd":"E:/develop/demo"}\n';
}

function sessionEntryLine(id: string, parentId: string | null, content: string): string {
  return `{"type":"message","id":"${id}","parentId":${parentId === null ? "null" : JSON.stringify(parentId)},"timestamp":"2026-08-11T00:00:01.000Z","message":{"role":"user","content":${JSON.stringify(content)}}}\n`;
}

function validSessionTranscript(): string {
  return sessionHeaderLine() + sessionEntryLine("e-1", null, "hi") + sessionEntryLine("e-2", "e-1", "hello");
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileBytes(path: string): Promise<Buffer> {
  return readFile(path);
}

async function assertValidJsonl(path: string, message: string): Promise<void> {
  const text = await readFile(path, "utf-8");
  const lines = text.split("\n");
  const last = lines.pop() ?? "";
  if (last !== "") {
    failed++;
    console.error(`  FAIL: ${message} - file does not end with a newline`);
    return;
  }
  let ok = true;
  for (let i = 0; i < lines.length; i++) {
    try {
      JSON.parse(lines[i]);
    } catch {
      ok = false;
      console.error(`  FAIL: ${message} - line ${i + 1} does not parse: ${lines[i]}`);
    }
  }
  if (ok) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
  }
}

// ============================================================================
// 1. Workspace enumeration
// ============================================================================

await run("workspace enumeration and initWorkspace", async () => {
  const root = await makeRoot();
  const store = makeStore(root);
  assertDeepEqual(await store.listWorkspaces(), [], "missing root yields no workspaces");

  await store.initWorkspace("ws-a");
  await store.initWorkspace("ws-b");
  // Stray files and hidden dirs at the root are not workspaces.
  await writeFile(join(root, "readme.txt"), "hi", "utf-8");
  await mkdir(join(root, ".hidden"));
  assertDeepEqual(await store.listWorkspaces(), ["ws-a", "ws-b"], "only non-hidden workspace dirs are listed");
});

// ============================================================================
// 2. Atomic index + index.prev fallback
// ============================================================================

await run("atomic index writes with previous-generation fallback", async () => {
  const root = await makeRoot();
  const store = makeStore(root);
  const ws = "ws-idx";

  await store.initWorkspace(ws);
  assertEqual(await store.readIndex(ws), null, "no index before the first write");

  await store.writeIndex(ws, makeIndex(ws, 1, "run-1"));
  assertEqual((await store.readIndex(ws))?.generation, 1, "current index is generation 1");

  await store.writeIndex(ws, makeIndex(ws, 2, "run-2"));
  const current = await store.readIndex(ws);
  assertEqual(current?.generation, 2, "current index is generation 2");
  assertEqual(current?.lastWriterRunId, "run-2", "current index carries the new runId");
  const prev = JSON.parse(await readFile(join(root, ws, "index.prev.json"), "utf-8")) as TaskIndex;
  assertEqual(prev.generation, 1, "index.prev.json preserves the previous known-valid generation");
  assertEqual(prev.lastWriterRunId, "run-1", "index.prev.json preserves the previous runId");

  // Corrupt current generation -> fall back to prev.
  await writeFile(join(root, ws, "index.json"), "not json at all", "utf-8");
  const fallenBack = await store.readIndex(ws);
  assertEqual(fallenBack?.generation, 1, "corrupt current generation falls back to index.prev.json");

  // Both generations corrupt -> null.
  await writeFile(join(root, ws, "index.prev.json"), "{broken", "utf-8");
  assertEqual(await store.readIndex(ws), null, "both generations corrupt -> null");

  // Shape validation on write.
  await assertThrows(
    () => store.writeIndex(ws, { ...makeIndex(ws, 3, "run-3"), generation: -1 }),
    "writeIndex rejects a negative generation",
  );
  await assertThrows(
    () => store.writeIndex(ws, makeIndex("other-ws", 3, "run-3")),
    "writeIndex rejects a workspaceId mismatch",
  );

  // Fresh state, then a corrupt current index never clobbers the valid prev.
  await rm(join(root, ws, "index.json"), { force: true });
  await rm(join(root, ws, "index.prev.json"), { force: true });
  await store.writeIndex(ws, makeIndex(ws, 3, "run-3"));
  await store.writeIndex(ws, makeIndex(ws, 4, "run-4"));
  const prevAfter = JSON.parse(await readFile(join(root, ws, "index.prev.json"), "utf-8")) as TaskIndex;
  assertEqual(prevAfter.generation, 3, "index.prev.json tracks the immediately previous valid generation");
  await writeFile(join(root, ws, "index.json"), "garbage", "utf-8");
  await store.writeIndex(ws, makeIndex(ws, 5, "run-5"));
  const prevKept = JSON.parse(await readFile(join(root, ws, "index.prev.json"), "utf-8")) as TaskIndex;
  assertEqual(prevKept.generation, 3, "writing over a corrupt current index keeps the last known-valid prev");
});

// ============================================================================
// 3. Monotonic event seq
// ============================================================================

await run("monotonic event seq allocation and ordered read-back", async () => {
  const root = await makeRoot();
  const store = makeStore(root);
  const ws = "ws-seq";
  const task = "task-1";

  const e1 = await store.appendEvent(ws, task, diagnosticEvent("d1", "one"));
  const e2 = await store.appendEvent(ws, task, diagnosticEvent("d2", "two"));
  assertEqual(e1.seq, 1, "first event gets seq 1");
  assertEqual(e2.seq, 2, "second event gets seq 2");
  assert(e2.ts >= e1.ts, "ts is assigned by the store and monotonic");

  // Concurrent appends get distinct monotonic seqs in queue order.
  const concurrent = await Promise.all(
    Array.from({ length: 20 }, (_, i) => store.appendEvent(ws, task, diagnosticEvent(`c${i}`, `c-${i}`))),
  );
  const seqs = concurrent.map((e) => e.seq);
  assertEqual(seqs[0], 3, "concurrent batch starts at seq 3");
  assert(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), "concurrent seqs are strictly increasing");

  const read = await store.readTask(ws, task);
  assertDeepEqual(
    read.events.map((e) => e.seq),
    Array.from({ length: 22 }, (_, i) => i + 1),
    "read-back preserves the exact append order",
  );
  assertDeepEqual(read.diagnostics, [], "no diagnostics on a healthy log");
  assertEqual((read.events[0] as { code?: string }).code, "d1", "event payload round-trips");

  // A new store instance on the same root continues the sequence.
  const reopened = makeStore(root);
  const e23 = await reopened.appendEvent(ws, task, diagnosticEvent("d23", "after restart"));
  assertEqual(e23.seq, 23, "seq continues across store instances");
});

// ============================================================================
// 4. Events tail corruption: repair-before-append
// ============================================================================

await run("events tail corruption: diagnostics, repair-before-append, valid JSONL after", async () => {
  const root = await makeRoot();
  const store = makeStore(root);
  const ws = "ws-tail";
  const task = "task-1";

  await store.appendEvent(ws, task, diagnosticEvent("d1", "one"));
  await store.appendEvent(ws, task, diagnosticEvent("d2", "two"));
  await store.appendEvent(ws, task, diagnosticEvent("d3", "three"));
  const eventsPath = join(root, ws, task, "events.jsonl");
  const full = await fileBytes(eventsPath);
  const corrupt = full.subarray(0, full.length - 7); // cut into the last line, no trailing newline
  await writeFile(eventsPath, corrupt);

  const read = await store.readTask(ws, task);
  assertEqual(read.diagnostics.length, 1, "tail corruption yields exactly one diagnostic");
  assertEqual(read.diagnostics[0].code, "tail_corrupt", "tail corruption code is tail_corrupt");
  assertEqual(read.diagnostics[0].recoverable, true, "tail corruption is recoverable");
  assertDeepEqual(
    read.events.map((e) => e.seq),
    [1, 2],
    "read returns the last validated records only",
  );

  // Next append repairs first (hash-named .bak + atomic prefix replace), then
  // appends with the next seq; the result is still valid JSONL.
  const e4 = await store.appendEvent(ws, task, diagnosticEvent("d4", "four"));
  assertEqual(e4.seq, 3, "append after tail repair continues at lastValidSeq + 1");
  const bakName = `events.jsonl.corrupt-${sha256Hex(corrupt)}.bak`;
  const bakPath = join(root, ws, task, bakName);
  const bak = await fileBytes(bakPath).catch(() => null);
  assert(bak !== null, "tail repair preserves the full corrupt original as a hash-named .bak");
  if (bak !== null) {
    assertDeepEqual(bak.toString("utf-8"), corrupt.toString("utf-8"), ".bak content is byte-identical to the corrupt original");
    assertEqual(sha256Hex(bak), sha256Hex(corrupt), ".bak name embeds the sha256 of its content");
  }
  await assertValidJsonl(eventsPath, "events.jsonl stays valid JSONL after repair + append");
  const after = await store.readTask(ws, task);
  assertDeepEqual(
    after.events.map((e) => e.seq),
    [1, 2, 3],
    "repaired log plus the new event reads back in order",
  );
});

// ============================================================================
// 4b. Events tail without trailing newline: crash-truncation signature
// ============================================================================

await run("events no-newline tail is repaired before the next append, history preserved", async () => {
  const root = await makeRoot();
  const store = makeStore(root);
  const ws = "ws-tail-nl";
  const task = "task-1";

  await store.appendEvent(ws, task, diagnosticEvent("d1", "one"));
  await store.appendEvent(ws, task, diagnosticEvent("d2", "two"));
  await store.appendEvent(ws, task, diagnosticEvent("d3", "three"));
  const eventsPath = join(root, ws, task, "events.jsonl");
  const full = await fileBytes(eventsPath);
  // Crash-truncation signature: the final line is complete JSON but its
  // terminating newline never reached the disk.
  const noNewline = full.subarray(0, full.length - 1);
  await writeFile(eventsPath, noNewline);

  const read = await store.readTask(ws, task);
  assertEqual(read.diagnostics.length, 1, "no-newline tail yields exactly one diagnostic");
  assertEqual(read.diagnostics[0].code, "tail_corrupt", "no-newline tail is tail_corrupt, never accepted as valid");
  assertEqual(read.diagnostics[0].recoverable, true, "no-newline tail is recoverable");
  assertDeepEqual(
    read.events.map((e) => e.seq),
    [1, 2],
    "the newline-terminated history stays readable",
  );

  // The next append repairs first (hash-named .bak + atomic prefix replace)
  // and never concatenates onto the last line.
  const e4 = await store.appendEvent(ws, task, diagnosticEvent("d4", "four"));
  assertEqual(e4.seq, 3, "append after no-newline tail repair continues at lastValidSeq + 1");
  const bakName = `events.jsonl.corrupt-${sha256Hex(noNewline)}.bak`;
  const bak = await fileBytes(join(root, ws, task, bakName)).catch(() => null);
  assert(bak !== null, "no-newline tail repair preserves the full original as a hash-named .bak");
  if (bak !== null) {
    assertDeepEqual(bak.toString("utf-8"), noNewline.toString("utf-8"), ".bak is byte-identical to the no-newline original");
  }
  const repairedBytes = await fileBytes(eventsPath);
  assertEqual(repairedBytes[repairedBytes.length - 1], 0x0a, "repaired file ends with a newline");
  await assertValidJsonl(eventsPath, "events.jsonl stays valid JSONL after no-newline repair + append");
  const after = await store.readTask(ws, task);
  assertDeepEqual(
    after.events.map((e) => e.seq),
    [1, 2, 3],
    "the full event history is intact after repair + append",
  );

  // Continuing to append stays valid JSONL.
  await store.appendEvent(ws, task, diagnosticEvent("d5", "five"));
  await assertValidJsonl(eventsPath, "further appends keep events.jsonl valid JSONL");
  const finalRead = await store.readTask(ws, task);
  assertDeepEqual(
    finalRead.events.map((e) => e.seq),
    [1, 2, 3, 4],
    "appends continue on the repaired log without seq gaps",
  );

  // Session transcripts accept the same shape: a parseable no-newline final
  // entry is tail_corrupt and repairable through repairSessionTranscriptTail.
  const validSession = validSessionTranscript();
  const noNewlineSession = validSession.slice(0, -1);
  const sessionPath = await writeSessionTranscript(root, ws, task, noNewlineSession);
  const sessionInspection = await store.inspectSessionTranscript(ws, task, "sess.jsonl");
  assertEqual(sessionInspection.kind, "tail_corrupt", "no-newline session tail is tail_corrupt");
  const sessionRepair = await store.repairSessionTranscriptTail(ws, task, "sess.jsonl", sessionInspection);
  assertEqual(sessionRepair.ok, true, "no-newline session tail is repaired");
  const repairedSession = await fileBytes(sessionPath);
  assertEqual(repairedSession[repairedSession.length - 1], 0x0a, "repaired session transcript ends with a newline");
  assertEqual(
    (await store.inspectSessionTranscript(ws, task, "sess.jsonl")).kind,
    "valid",
    "repaired session transcript is valid",
  );
});

// ============================================================================
// 5. Events mid corruption
// ============================================================================

await run("events mid corruption: read diagnostics and append refusal", async () => {
  const root = await makeRoot();
  const store = makeStore(root);
  const ws = "ws-mid";
  const task = "task-1";

  await store.appendEvent(ws, task, diagnosticEvent("d1", "one"));
  await store.appendEvent(ws, task, diagnosticEvent("d2", "two"));
  await store.appendEvent(ws, task, diagnosticEvent("d3", "three"));
  const eventsPath = join(root, ws, task, "events.jsonl");
  const lines = (await readFile(eventsPath, "utf-8")).split("\n").filter((l) => l !== "");
  await writeFile(eventsPath, `${lines[0]}\nBROKEN LINE\n${lines[2]}\n`, "utf-8");

  const read = await store.readTask(ws, task);
  const midDiag = read.diagnostics.find((d) => d.code === "mid_log_corrupt");
  assert(midDiag !== undefined, "mid corruption yields a mid_log_corrupt diagnostic");
  assertEqual(midDiag?.recoverable, false, "mid corruption is not recoverable");
  assertDeepEqual(
    read.events.map((e) => e.seq),
    [1],
    "only the valid prefix before the bad line is returned",
  );

  // Appending to a mid-corrupt log is refused and the file is untouched.
  const before = await fileBytes(eventsPath);
  await assertThrows(
    () => store.appendEvent(ws, task, diagnosticEvent("d4", "four")),
    "appendEvent refuses a mid-corrupt log",
  );
  assertDeepEqual((await fileBytes(eventsPath)).toString("utf-8"), before.toString("utf-8"), "refused append leaves the file untouched");
});

// ============================================================================
// 6. Session transcript strict inspection
// ============================================================================

await run("session transcript strict inspection", async () => {
  const root = await makeRoot();
  const store = makeStore(root);
  const ws = "ws-sess";
  const task = "task-1";

  const valid = validSessionTranscript();
  await writeSessionTranscript(root, ws, task, valid);
  const ok = await store.inspectSessionTranscript(ws, task, "sess.jsonl");
  assertEqual(ok.kind, "valid", "healthy transcript is valid");
  assertEqual(ok.lastValidByteOffset, Buffer.byteLength(valid, "utf-8"), "valid inspection reports the full byte length");
  assertDeepEqual(ok.diagnostics, [], "no diagnostics for a healthy transcript");

  // Header not JSON.
  await writeSessionTranscript(root, ws, task, `not json\n${sessionEntryLine("e-1", null, "hi")}`);
  const badHeader = await store.inspectSessionTranscript(ws, task, "sess.jsonl");
  assertEqual(badHeader.kind, "invalid", "non-JSON header is invalid");
  assertEqual(badHeader.diagnostics[0].code, "session_header_corrupt", "non-JSON header diagnostic code");
  assertEqual(badHeader.diagnostics[0].recoverable, false, "header corruption is not recoverable");

  // Header JSON but wrong shape.
  await writeSessionTranscript(root, ws, task, `{"type":"user","id":"x","timestamp":"t","cwd":"c"}\n${sessionEntryLine("e-1", null, "hi")}`);
  const wrongHeader = await store.inspectSessionTranscript(ws, task, "sess.jsonl");
  assertEqual(wrongHeader.kind, "invalid", "wrong-type header is invalid");
  assertEqual(wrongHeader.diagnostics[0].code, "session_header_corrupt", "wrong-type header diagnostic code");

  // Truncated header (first line itself partial).
  await writeSessionTranscript(root, ws, task, '{"type":"session","id":"ses');
  const truncatedHeader = await store.inspectSessionTranscript(ws, task, "sess.jsonl");
  assertEqual(truncatedHeader.kind, "invalid", "truncated header is invalid");
  assertEqual(truncatedHeader.diagnostics[0].code, "session_header_corrupt", "truncated header diagnostic code");

  // Empty file.
  await writeSessionTranscript(root, ws, task, "");
  const empty = await store.inspectSessionTranscript(ws, task, "sess.jsonl");
  assertEqual(empty.kind, "invalid", "empty transcript is invalid");
  assertEqual(empty.diagnostics[0].code, "session_header_corrupt", "empty transcript diagnostic code");

  // Mid-log bad line (complete line, keeps its newline).
  await writeSessionTranscript(
    root,
    ws,
    task,
    sessionHeaderLine() + sessionEntryLine("e-1", null, "hi") + `BROKEN\n` + sessionEntryLine("e-2", "e-1", "hello"),
  );
  const mid = await store.inspectSessionTranscript(ws, task, "sess.jsonl");
  assertEqual(mid.kind, "invalid", "mid-log bad line is invalid");
  assertEqual(mid.diagnostics[0].code, "mid_log_corrupt", "mid-log corruption diagnostic code");
  const prefixBytes = Buffer.byteLength(sessionHeaderLine() + sessionEntryLine("e-1", null, "hi"), "utf-8");
  assertEqual(mid.lastValidByteOffset, prefixBytes, "invalid inspection points at the end of the valid prefix");

  // Truncated tail (last entry incomplete).
  const truncated = valid.slice(0, -10);
  await writeSessionTranscript(root, ws, task, truncated);
  const tail = await store.inspectSessionTranscript(ws, task, "sess.jsonl");
  assertEqual(tail.kind, "tail_corrupt", "truncated final entry is tail_corrupt");
  assertEqual(tail.diagnostics[0].code, "tail_corrupt", "tail corruption diagnostic code");
  assertEqual(tail.diagnostics[0].recoverable, true, "tail corruption is recoverable");
  assertEqual(tail.lastValidByteOffset, prefixBytes, "tail offset is the start of the incomplete entry");

  // Header-only transcript (no entries yet) is valid.
  await writeSessionTranscript(root, ws, task, sessionHeaderLine());
  const headerOnly = await store.inspectSessionTranscript(ws, task, "sess.jsonl");
  assertEqual(headerOnly.kind, "valid", "header-only transcript is valid");

  // Missing file.
  const missing = await store.inspectSessionTranscript(ws, task, "missing.jsonl");
  assertEqual(missing.kind, "invalid", "missing transcript is invalid");
  assertEqual(missing.diagnostics[0].code, "session_header_corrupt", "missing transcript diagnostic code");
});

// ============================================================================
// 7. Session tail repair transaction
// ============================================================================

await run("session tail repair transaction (idempotent, hash-named backup)", async () => {
  const root = await makeRoot();
  const store = makeStore(root);
  const ws = "ws-repair";
  const task = "task-1";

  const valid = validSessionTranscript();
  const truncated = valid.slice(0, -10);
  const sessionPath = await writeSessionTranscript(root, ws, task, truncated);
  const corruptBytes = await fileBytes(sessionPath);
  const prefixBytes = Buffer.byteLength(sessionHeaderLine() + sessionEntryLine("e-1", null, "hi"), "utf-8");
  const bakName = `sess.jsonl.corrupt-${sha256Hex(corruptBytes)}.bak`;

  const inspection = await store.inspectSessionTranscript(ws, task, "sess.jsonl");
  assertEqual(inspection.kind, "tail_corrupt", "precondition: transcript is tail_corrupt");

  const repair = await store.repairSessionTranscriptTail(ws, task, "sess.jsonl", inspection);
  assertEqual(repair.ok, true, "tail repair succeeds");
  if (repair.ok) {
    assertEqual(repair.preservedFileName, bakName, "preserved file name embeds the content sha256");
  }

  // Backup holds the full original; the working file is the valid prefix.
  const bak = await fileBytes(join(root, ws, task, "sessions", bakName));
  assertDeepEqual(bak.toString("utf-8"), corruptBytes.toString("utf-8"), "backup is byte-identical to the corrupt original");
  const repaired = await fileBytes(sessionPath);
  assertEqual(repaired.byteLength, prefixBytes, "working file is exactly the valid prefix length");
  assertDeepEqual(repaired.toString("utf-8"), valid.slice(0, prefixBytes), "working file equals the valid prefix");
  assertEqual(repaired[repaired.length - 1], 0x0a, "repaired prefix ends with a newline");

  // Appending after repair keeps the transcript valid JSONL.
  await writeFile(sessionPath, (await readFile(sessionPath, "utf-8")) + sessionEntryLine("e-3", "e-2", "world"), "utf-8");
  const afterAppend = await store.inspectSessionTranscript(ws, task, "sess.jsonl");
  assertEqual(afterAppend.kind, "valid", "repair + append yields a valid transcript");

  // Retrying with the stale inspection is rejected.
  const stale = await store.repairSessionTranscriptTail(ws, task, "sess.jsonl", inspection);
  assertEqual(stale.ok, false, "retry with the old inspection fails");
  if (!stale.ok) assertEqual(stale.reason, "stale_inspection", "changed file is reported stale");

  // Non-tail inspections are rejected.
  const validInspection = await store.inspectSessionTranscript(ws, task, "sess.jsonl");
  const wrongKind = await store.repairSessionTranscriptTail(ws, task, "sess.jsonl", validInspection);
  assertEqual(wrongKind.ok, false, "repair rejects a non-tail_corrupt inspection");
  if (!wrongKind.ok) assertEqual(wrongKind.reason, "stale_inspection", "non-tail inspection is reported stale");

  // Crash between backup and replace: the backup already exists with the
  // right hash -> verified and reused idempotently, working file repaired.
  const reCorrupted = truncated;
  await writeFile(sessionPath, reCorrupted, "utf-8");
  await writeFile(join(root, ws, task, "sessions", bakName), corruptBytes); // pre-existing backup
  const retry = await store.repairSessionTranscriptTail(ws, task, "sess.jsonl", await store.inspectSessionTranscript(ws, task, "sess.jsonl"));
  assertEqual(retry.ok, true, "repair retry after crash-before-replace succeeds");
  const bakAfterRetry = await fileBytes(join(root, ws, task, "sessions", bakName));
  assertDeepEqual(bakAfterRetry.toString("utf-8"), corruptBytes.toString("utf-8"), "pre-existing backup is reused byte-identically");
  assertEqual((await fileBytes(sessionPath)).byteLength, prefixBytes, "working file repaired on retry");

  // A backup whose content does not match its hash name is never modified.
  await writeFile(sessionPath, truncated, "utf-8");
  await writeFile(join(root, ws, task, "sessions", bakName), "tampered backup");
  await assertThrows(
    async () => {
      const inspection = await store.inspectSessionTranscript(ws, task, "sess.jsonl");
      return store.repairSessionTranscriptTail(ws, task, "sess.jsonl", inspection);
    },
    "repair refuses a backup whose content mismatches its hash name",
  );
});

// ============================================================================
// 8. Repair budget: storage_limit leaves originals untouched
// ============================================================================

await run("repair storage_limit leaves originals untouched", async () => {
  const root = await makeRoot();
  const ws = "ws-budget-repair";
  const task = "task-1";
  const truncated = validSessionTranscript().slice(0, -10);

  // Workspace-level limit is too small for the backup + prefix peak.
  const smallWorkspace = makeStore(root, { maxWorkspaceBytes: 100, maxTaskBytes: 25 * 1024 * 1024 });
  const sessionPath = await writeSessionTranscript(root, ws, task, truncated);
  const original = await fileBytes(sessionPath);
  const inspection = await smallWorkspace.inspectSessionTranscript(ws, task, "sess.jsonl");
  assertEqual(inspection.kind, "tail_corrupt", "precondition: transcript is tail_corrupt");
  const denied = await smallWorkspace.repairSessionTranscriptTail(ws, task, "sess.jsonl", inspection);
  assertEqual(denied.ok, false, "repair is denied when the backup + peak budget does not fit");
  if (!denied.ok) assertEqual(denied.reason, "storage_limit", "denial reason is storage_limit");
  assertDeepEqual((await fileBytes(sessionPath)).toString("utf-8"), original.toString("utf-8"), "denied repair leaves the working file untouched");
  const entries = await readdir(join(root, ws, task, "sessions"));
  assertDeepEqual(entries, ["sess.jsonl"], "denied repair creates no backup and no temp leftovers");

  // Task-level limit can deny the same transaction.
  const smallTask = makeStore(root, { maxTaskBytes: 100, maxWorkspaceBytes: 25 * 1024 * 1024 });
  const deniedTask = await smallTask.repairSessionTranscriptTail(ws, task, "sess.jsonl", await smallTask.inspectSessionTranscript(ws, task, "sess.jsonl"));
  assertEqual(deniedTask.ok, false, "task-level budget denial also returns storage_limit");
  if (!deniedTask.ok) assertEqual(deniedTask.reason, "storage_limit", "task denial reason is storage_limit");
});

// ============================================================================
// 9. Unknown schema read-only and migration failure preservation
// ============================================================================

await run("unknown schema read-only and migration failure preserve originals", async () => {
  const root = await makeRoot();
  const store = makeStore(root);
  const ws = "ws-migrate";
  const task = "task-1";
  const taskDir = join(root, ws, task);

  // Unknown schemaVersion: read-only, file untouched.
  const unknownSchema = { schemaVersion: 2, spec: { taskId: task }, initialInfo: { taskId: task } };
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, "task.json"), JSON.stringify(unknownSchema), "utf-8");
  const readUnknown = await store.readTask(ws, task);
  assertEqual(readUnknown.metadata, null, "unknown schema yields no metadata");
  const unknownDiag = readUnknown.diagnostics.find((d) => d.code === "unknown_schema");
  assert(unknownDiag !== undefined, "unknown schema yields an unknown_schema diagnostic");
  assertEqual(unknownDiag?.recoverable, false, "unknown schema is read-only");
  assertDeepEqual(await readFile(join(taskDir, "task.json"), "utf-8"), JSON.stringify(unknownSchema), "unknown schema file is not modified");

  // Non-numeric schemaVersion is also unknown.
  await writeFile(join(taskDir, "task.json"), JSON.stringify({ schemaVersion: "v2" }), "utf-8");
  const readNoNumeric = await store.readTask(ws, task);
  assert(
    readNoNumeric.diagnostics.some((d) => d.code === "unknown_schema"),
    "non-numeric schemaVersion is unknown_schema",
  );

  // Migration failure: current version but structurally invalid content.
  const invalidV1 = { schemaVersion: 1, spec: { taskId: task }, initialInfo: { garbage: true } };
  await writeFile(join(taskDir, "task.json"), JSON.stringify(invalidV1), "utf-8");
  const readFailed = await store.readTask(ws, task);
  assertEqual(readFailed.metadata, null, "invalid v1 yields no metadata");
  const failedDiag = readFailed.diagnostics.find((d) => d.code === "migration_failed");
  assert(failedDiag !== undefined, "invalid v1 yields a migration_failed diagnostic");
  assertDeepEqual(await readFile(join(taskDir, "task.json"), "utf-8"), JSON.stringify(invalidV1), "migration failure preserves the original file");

  // Valid v1 metadata round-trips.
  const metadata = makeMetadata(task, ws);
  await store.writeMetadata(ws, task, metadata);
  const healthy = await store.readTask(ws, task);
  assertDeepEqual(healthy.metadata, metadata, "valid metadata round-trips through writeMetadata/readTask");
  assert(
    !healthy.diagnostics.some((d) => d.code === "unknown_schema" || d.code === "migration_failed"),
    "no schema diagnostics on a healthy task",
  );
});

// ============================================================================
// 10. Budget reservations
// ============================================================================

await run("budget reservations", async () => {
  const root = await makeRoot();
  const store = makeStore(root, { maxTaskBytes: 500, maxWorkspaceBytes: 1000 });
  const ws = "ws-reserve";
  const task = "task-1";

  const r1 = await store.reserveBudget(ws, task, 300);
  assertEqual(r1.reservedBytes, 300, "reservation carries the requested bytes");
  assert(typeof r1.reservationId === "string" && r1.reservationId.length > 0, "reservation has an id");

  const err = await assertThrows(
    () => store.reserveBudget(ws, task, 300),
    "second reservation over the task budget is rejected",
  );
  assert(err instanceof TaskStorageLimitError, "budget rejection is a TaskStorageLimitError");
  if (err instanceof TaskStorageLimitError) assertEqual(err.code, "storage_limit", "limit error code is storage_limit");

  store.releaseBudget(r1.reservationId);
  const r2 = await store.reserveBudget(ws, task, 300);
  assertEqual(r2.reservedBytes, 300, "released headroom can be reserved again");

  const wsErr = await assertThrows(
    () => store.reserveBudget(ws, task, 800),
    "reservation over the workspace budget is rejected",
  );
  assert(wsErr instanceof TaskStorageLimitError, "workspace rejection is a TaskStorageLimitError");

  store.releaseBudget(r2.reservationId);
  await assertThrows(
    () => store.reserveBudget(ws, task, -5),
    "negative reservation size is rejected",
  );
  await assertThrows(
    () => store.reserveBudget(ws, "bad/task", 10),
    "reservation with an unsafe taskId is rejected",
  );
});

// ============================================================================
// 11. Usage accounting and the 80% warning level
// ============================================================================

await run("workspace usage accounting and 80% warning", async () => {
  const root = await makeRoot();
  const store = makeStore(root, { maxTaskBytes: 25 * 1024 * 1024, maxWorkspaceBytes: 1000 });
  const ws = "ws-usage";
  const task = "task-1";

  const empty = await store.getWorkspaceUsage(ws);
  assertDeepEqual(empty, { usedBytes: 0, reservedBytes: 0, limitBytes: 1000 }, "empty workspace usage");

  await store.reserveBudget(ws, task, 100);
  const reserved = await store.getWorkspaceUsage(ws);
  assertEqual(reserved.reservedBytes, 100, "active reservation counts as reserved bytes");
  assertEqual(reserved.usedBytes, 0, "no writes yet");

  await store.appendEvent(ws, task, diagnosticEvent("d1", "x"));
  const used = await store.getWorkspaceUsage(ws);
  assert(used.usedBytes > 0, "appended events count as used bytes");
  assertEqual(
    used.usedBytes + used.reservedBytes,
    100,
    "a write converts its own reservation into usage (committed stays flat)",
  );
  const eventsSize = (await stat(join(root, ws, task, "events.jsonl"))).size;
  assertEqual(used.usedBytes, eventsSize, "used bytes equal the real on-disk size of the task dir");

  // 80% warning level (pure function over the §4.7 usage shape).
  assertEqual(storageUsageLevel({ usedBytes: 0, reservedBytes: 0, limitBytes: 1000 }), "ok", "0% is ok");
  assertEqual(storageUsageLevel({ usedBytes: 799, reservedBytes: 0, limitBytes: 1000 }), "ok", "below 80% is ok");
  assertEqual(storageUsageLevel({ usedBytes: 800, reservedBytes: 0, limitBytes: 1000 }), "warning", "exactly 80% is warning");
  assertEqual(storageUsageLevel({ usedBytes: 999, reservedBytes: 0, limitBytes: 1000 }), "warning", "below the limit is warning");
  assertEqual(storageUsageLevel({ usedBytes: 500, reservedBytes: 300, limitBytes: 1000 }), "warning", "committed (used+reserved) 80% is warning");
  assertEqual(storageUsageLevel({ usedBytes: 700, reservedBytes: 300, limitBytes: 1000 }), "full", "committed at the limit is full");
  assertEqual(storageUsageLevel({ usedBytes: 1000, reservedBytes: 0, limitBytes: 1000 }), "full", "used at the limit is full");
  assertEqual(AGENT_TASK_STORAGE_WARNING_RATIO, 0.8, "warning ratio is 0.8");
});

// ============================================================================
// 12. runId close marker
// ============================================================================

await run("runId close marker write/consume", async () => {
  const root = await makeRoot();
  const store = makeStore(root);
  const ws = "ws-marker";

  const crash = await store.consumeCloseMarker(ws, "run-1");
  assertEqual(crash.kind, "crash", "no marker means crash");

  const marker: AgentTaskCloseMarker = { schemaVersion: AGENT_TASK_CLOSE_MARKER_SCHEMA_VERSION, runId: "run-1", closedAt: ENDED };
  await store.writeCloseMarker(ws, marker);
  const clean = await store.consumeCloseMarker(ws, "run-1");
  assertEqual(clean.kind, "clean", "matching runId is clean");
  assertEqual(clean.marker?.runId, "run-1", "clean diagnosis carries the marker");
  const afterClean = await store.consumeCloseMarker(ws, "run-1");
  assertEqual(afterClean.kind, "crash", "marker is consumed (removed) after a clean close");

  await store.writeCloseMarker(ws, { schemaVersion: 1, runId: "run-2", closedAt: ENDED });
  const stale = await store.consumeCloseMarker(ws, "run-1");
  assertEqual(stale.kind, "stale_marker", "non-matching runId is stale");
  assertEqual(stale.marker?.runId, "run-2", "stale diagnosis carries the marker");
  assertEqual((await store.consumeCloseMarker(ws, "run-1")).kind, "crash", "stale marker is removed and cannot leak into the next run");

  // Unreadable markers are removed too.
  await writeFile(join(root, ws, "close-marker.json"), "garbage", "utf-8");
  assertEqual((await store.consumeCloseMarker(ws, "run-1")).kind, "stale_marker", "unreadable marker is stale");
  await writeFile(join(root, ws, "close-marker.json"), JSON.stringify({ schemaVersion: 2, runId: "run-3", closedAt: ENDED }), "utf-8");
  assertEqual((await store.consumeCloseMarker(ws, "run-1")).kind, "stale_marker", "unknown marker schema is stale");
  assertEqual((await store.consumeCloseMarker(ws, "run-1")).kind, "crash", "removed markers are gone");

  await assertThrows(
    () => store.writeCloseMarker(ws, { schemaVersion: 1, runId: 42, closedAt: ENDED } as unknown as AgentTaskCloseMarker),
    "writeCloseMarker rejects an invalid marker",
  );
});

// ============================================================================
// 13. Checkpoint structure and budget enforcement
// ============================================================================

await run("checkpoint structure and write-budget enforcement", async () => {
  const root = await makeRoot();
  const store = makeStore(root);
  const ws = "ws-cp";
  const task = "task-1";

  const cp = makeCheckpoint(task, 7);
  await store.writeCheckpoint(ws, task, cp);
  const read = await store.readTask(ws, task);
  assertDeepEqual(read.checkpoint, cp, "checkpoint round-trips through writeCheckpoint/readTask");
  assertDeepEqual(read.diagnostics, [], "healthy checkpoint yields no diagnostics");

  await assertThrows(
    () => store.writeCheckpoint(ws, task, { ...cp, taskId: "other-task" }),
    "writeCheckpoint rejects a taskId mismatch",
  );
  await assertThrows(
    () => store.writeCheckpoint(ws, task, { ...cp, workspaceFingerprint: { isGit: "yes" } }),
    "writeCheckpoint rejects an invalid checkpoint shape",
  );

  // A checkpoint write that would exceed the task budget is refused and the
  // original file is not modified.
  const tight = makeStore(root, { maxTaskBytes: 100, maxWorkspaceBytes: 25 * 1024 * 1024 });
  const cpPath = join(root, ws, task, "checkpoint.json");
  const err = await assertThrows(
    () => tight.writeCheckpoint(ws, "task-2", { ...cp, taskId: "task-2", workspaceFingerprint: { isGit: true, observedFileHashes: { f: "a".repeat(500) } } }),
    "checkpoint over the task budget is refused",
  );
  assert(err instanceof TaskStorageLimitError, "checkpoint budget refusal is a TaskStorageLimitError");
  const entries = await readdir(join(root, ws, "task-2"));
  assert(!entries.includes("checkpoint.json"), "refused checkpoint leaves no checkpoint file");

  // A corrupt checkpoint.json surfaces as a migration_failed diagnostic.
  await writeFile(cpPath, "{broken json", "utf-8");
  const corruptRead = await store.readTask(ws, task);
  assert(
    corruptRead.diagnostics.some((d) => d.code === "migration_failed"),
    "unreadable checkpoint.json yields a migration_failed diagnostic",
  );
  assertEqual(corruptRead.checkpoint, null, "unreadable checkpoint yields no checkpoint");
});

// ============================================================================
// 14. Metadata round-trip and deleteTask
// ============================================================================

await run("metadata round-trip and deleteTask", async () => {
  const root = await makeRoot();
  const store = makeStore(root);
  const ws = "ws-delete";
  const task = "task-1";

  const metadata = makeMetadata(task, ws);
  await store.writeMetadata(ws, task, metadata);
  await store.appendEvent(ws, task, diagnosticEvent("d1", "one"));
  await store.writeCheckpoint(ws, task, makeCheckpoint(task, 1));
  await store.writeIndex(ws, makeIndex(ws, 1, "run-1"));

  await store.reserveBudget(ws, task, 50);
  await store.deleteTask(ws, task);
  const taskDir = join(root, ws, task);
  await assertThrows(() => readdir(taskDir), "deleteTask removes the task directory");
  const usage = await store.getWorkspaceUsage(ws);
  assertEqual(usage.reservedBytes, 0, "deleteTask drops the deleted task's reservations");
  assertDeepEqual(
    await store.listWorkspaces(),
    [ws],
    "the workspace itself survives deleteTask",
  );
  const gone = await store.readTask(ws, task);
  assertDeepEqual(gone, { metadata: null, events: [], checkpoint: null, diagnostics: [] }, "readTask on a deleted task is empty");
});

// ============================================================================
// 14b. removeFromIndex (clear paths)
// ============================================================================

function makeIndexEntry(taskId: string, workspaceId: string): TaskIndex["tasks"][number] {
  return {
    taskId,
    workspaceId,
    parentSessionId: "session-1",
    parentToolCallId: "tool-1",
    groupId: "group-1",
    status: "completed",
    lastCheckpointSeq: 0,
    hasUnclosedToolCall: false,
    updatedAt: Date.now(),
    schemaVersion: 1,
    lastWriterRunId: "run-1",
  };
}

await run("removeFromIndex removes exactly one task and bumps the generation", async () => {
  const root = await makeRoot();
  const store = makeStore(root);
  const ws = "ws-remove";
  await store.initWorkspace(ws);

  const withEntries: TaskIndex = {
    schemaVersion: 1,
    workspaceId: ws,
    generation: 4,
    lastWriterRunId: "run-1",
    tasks: [makeIndexEntry("task-a", ws), makeIndexEntry("task-b", ws)],
  };
  await store.writeIndex(ws, withEntries);

  const removed = await store.removeFromIndex(ws, "task-a");
  assertEqual(removed, 5, "generation bumped to 5");
  const index = await store.readIndex(ws);
  assertEqual(index?.generation, 5, "the rewritten index carries generation 5");
  assertEqual(index?.tasks.length, 1, "exactly one task left");
  assertEqual(index?.tasks[0].taskId, "task-b", "the sibling stays");
  const prev = JSON.parse(await readFile(join(root, ws, "index.prev.json"), "utf-8")) as TaskIndex;
  assertEqual(prev.generation, 4, "index.prev.json preserved the previous generation");

  // Removing a task that is not listed writes nothing.
  const noop = await store.removeFromIndex(ws, "task-none");
  assertEqual(noop, undefined, "unlisted taskId writes nothing");
  assertEqual((await store.readIndex(ws))?.generation, 5, "generation unchanged after a no-op removal");

  // Removing the last task still writes the empty entries array.
  const last = await store.removeFromIndex(ws, "task-b");
  assertEqual(last, 6, "last removal bumps to 6");
  const empty = await store.readIndex(ws);
  assert(empty !== null, "index exists after the last removal");
  assertEqual(empty?.tasks.length, 0, "empty entries array written");

  // An unreadable/missing index pair leaves the removal as a no-op.
  const ws2 = "ws-remove-none";
  await store.initWorkspace(ws2);
  assertEqual(await store.removeFromIndex(ws2, "task-a"), undefined, "no index -> no-op removal");
});

// ============================================================================
// 15. Session file name validation and task session dir
// ============================================================================

await run("session file name validation and task session dir", async () => {
  const root = await makeRoot();
  const store = makeStore(root);
  const ws = "ws-safe";
  const task = "task-1";

  await assertThrows(
    () => store.inspectSessionTranscript(ws, task, "../escape.jsonl"),
    "inspect rejects path traversal in the session file name",
  );
  await assertThrows(
    () => store.inspectSessionTranscript(ws, task, "a/b.jsonl"),
    "inspect rejects nested session file names",
  );
  await assertThrows(
    () => store.inspectSessionTranscript(ws, task, ".."),
    "inspect rejects dot-dot session file names",
  );
  await assertThrows(
    () => store.repairSessionTranscriptTail(ws, task, "..\\escape.jsonl", { kind: "tail_corrupt", lastValidByteOffset: 0, diagnostics: [] }),
    "repair rejects path traversal in the session file name",
  );
  assertEqual(
    store.getTaskSessionDir(ws, task),
    join(root, ws, task, "sessions"),
    "getTaskSessionDir points into the task sessions directory",
  );
});

// ============================================================================
// 16. R1 diagnostics use the shared AgentTaskRecoveryIssueCode
// ============================================================================

await run("R1 diagnostics depend on the shared AgentTaskRecoveryIssueCode", async () => {
  // Compile-time: TaskStorageDiagnostic.code is the 1.4.2 R1 shared type.
  const expectRecoveryCode = (_code: AgentTaskRecoveryIssueCode): void => {};
  const codes: AgentTaskRecoveryIssueCode[] = [
    "tail_corrupt",
    "mid_log_corrupt",
    "session_header_corrupt",
    "index_corrupt",
    "unknown_schema",
    "migration_failed",
  ];
  for (const code of codes) expectRecoveryCode(code);
  assertEqual(codes.length, 6, "R1 declares exactly the six recovery issue codes");

  // Diagnostics emitted by the store carry codes assignable to the shared type.
  const root = await makeRoot();
  const store = makeStore(root);
  const ws = "ws-code";
  const task = "task-1";
  await store.appendEvent(ws, task, diagnosticEvent("d1", "one"));
  await writeFile(join(root, ws, task, "events.jsonl"), (await readFile(join(root, ws, task, "events.jsonl"), "utf-8")).slice(0, -7), "utf-8");
  const read = await store.readTask(ws, task);
  for (const diag of read.diagnostics) {
    expectRecoveryCode(diag.code);
  }
  assert(read.diagnostics.some((d) => d.code === "tail_corrupt"), "store diagnostics carry the shared code type");
});

// ============================================================================
// 17. Append over the hard budget
// ============================================================================

await run("append over the hard budget keeps the readable tail", async () => {
  const root = await makeRoot();
  const store = makeStore(root, { maxTaskBytes: 300, maxWorkspaceBytes: 25 * 1024 * 1024 });
  const ws = "ws-limit";
  const task = "task-1";

  await store.appendEvent(ws, task, diagnosticEvent("d1", "small"));
  const eventsPath = join(root, ws, task, "events.jsonl");
  const sizeBefore = (await stat(eventsPath)).size;

  const err = await assertThrows(
    () => store.appendEvent(ws, task, diagnosticEvent("d2", "a".repeat(500))),
    "append over the task budget is refused",
  );
  assert(err instanceof TaskStorageLimitError, "append budget refusal is a TaskStorageLimitError");
  assertEqual((await stat(eventsPath)).size, sizeBefore, "refused append leaves the readable tail untouched");
  await assertValidJsonl(eventsPath, "the readable tail stays valid JSONL after a refused append");
});

// ============================================================================
// 18. Workspace-level append limit
// ============================================================================

await run("workspace-level append limit", async () => {
  const root = await makeRoot();
  const store = makeStore(root, { maxTaskBytes: 25 * 1024 * 1024, maxWorkspaceBytes: 50 });
  const ws = "ws-wlimit";
  const task = "task-1";
  const err = await assertThrows(
    () => store.appendEvent(ws, task, diagnosticEvent("d1", "hello world")),
    "append over the workspace budget is refused",
  );
  assert(err instanceof TaskStorageLimitError, "workspace append refusal is a TaskStorageLimitError");
  const taskDir = join(root, ws, task);
  const entries = await readdir(taskDir).catch(() => []);
  assertDeepEqual(entries, [], "refused workspace append creates no files");
});

await run("appendEvents writes in order and keeps a successful prefix on storage_limit", async () => {
  const root = await makeRoot();
  const store = makeStore(root, { maxTaskBytes: 420, maxWorkspaceBytes: 25 * 1024 * 1024 });
  const ws = "ws-batch";
  const task = "task-1";
  const first = await store.appendEvents(ws, task, [diagnosticEvent("a", "one"), diagnosticEvent("b", "two")]);
  assertEqual(first.written.length, 2, "healthy batch writes both events");
  assertEqual(first.lastSeq, 2, "healthy batch lastSeq is 2");
  assertEqual(first.failedAt, undefined, "healthy batch has no failedAt");
  const over = await store.appendEvents(ws, task, [
    diagnosticEvent("c", "three"),
    diagnosticEvent("huge", "x".repeat(800)),
    diagnosticEvent("d", "never"),
  ]);
  assertEqual(over.written.length, 1, "prefix event before the oversize payload is kept");
  assertEqual(over.lastSeq, 3, "prefix seq is continuous");
  assertEqual(over.failedAt, 1, "failure stops at the oversize payload");
  assert(over.error instanceof TaskStorageLimitError, "batch failure is storage_limit");
  const read = await store.readTask(ws, task);
  assertDeepEqual(
    read.events.map((event) => event.seq),
    [1, 2, 3],
    "readable prefix is seq-continuous after a mid-batch storage_limit",
  );
  assert(
    !read.events.some((event) => event.type === "diagnostic" && (event as { code?: string }).code === "d"),
    "events after the failed payload are not written",
  );
});

await run("cross-workspace append does not serialize behind another workspace read", async () => {
  const root = await makeRoot();
  const store = makeStore(root);
  await store.appendEvent("ws-a", "t-a", diagnosticEvent("a", "a"));
  const started = Date.now();
  const [page, written] = await Promise.all([
    store.readTranscriptPage("ws-a", "t-a", "missing.jsonl", undefined, 10),
    store.appendEvent("ws-b", "t-b", diagnosticEvent("b", "b")),
  ]);
  assertEqual(page.entries.length, 0, "missing transcript on ws-a stays empty");
  assertEqual(written.seq, 1, "ws-b append completes independently");
  assert(Date.now() - started < 5000, "cross-workspace pair finishes promptly");
});

await run("readTranscriptPage seek + tail + exact totalCount + idempotent cursor", async () => {
  const root = await makeRoot();
  const store = makeStore(root);
  const sessionsDir = join(root, "ws", "t1", "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", id: "s" }),
    JSON.stringify({ type: "message", id: "m1", role: "user", content: "中文 🎉" }),
    "not-json",
    JSON.stringify({ type: "message", id: "m2", role: "assistant", content: "ok" }),
    JSON.stringify({ type: "message", id: "m3", role: "user", content: "tail" }),
  ];
  await writeFile(join(sessionsDir, "sess.jsonl"), `${lines.join("\n")}\n`, "utf-8");
  const all = await store.readTranscriptPage("ws", "t1", "sess.jsonl", undefined, 100);
  assertEqual(all.totalCount, 3, "totalCount is exact displayable entries");
  assertEqual(all.skippedLines, 1, "bad line counted");
  const p1 = await store.readTranscriptPage("ws", "t1", "sess.jsonl", undefined, 1);
  const p1b = await store.readTranscriptPage("ws", "t1", "sess.jsonl", undefined, 1);
  assertDeepEqual(
    p1.entries.map((entry) => (entry as { id: string }).id),
    p1b.entries.map((entry) => (entry as { id: string }).id),
    "same cursor+limit is idempotent",
  );
  const p2 = await store.readTranscriptPage("ws", "t1", "sess.jsonl", p1.nextCursor ?? undefined, 10);
  assertDeepEqual(
    p2.entries.map((entry) => (entry as { id: string }).id),
    ["m2", "m3"],
    "seek page continues after the first entry",
  );
  const mid = p1.nextCursor ? JSON.parse(p1.nextCursor) as { o: number } : { o: 0 };
  const split = await store.readTranscriptPage("ws", "t1", "sess.jsonl", JSON.stringify({ o: mid.o + 1 }), 10);
  assert(
    split.entries.length >= 1,
    "mid-line cursor falls back to a line boundary instead of throwing",
  );
  const tail = await store.readTranscriptPage("ws", "t1", "sess.jsonl", undefined, 1, true);
  assertEqual((tail.entries[0] as { id: string }).id, "m3", "fromEnd returns the last displayable entry");
  assert(tail.prevCursor !== null, "fromEnd exposes prevCursor when older entries exist");
  const older = await store.readTranscriptPage("ws", "t1", "sess.jsonl", undefined, 2, false, tail.prevCursor ?? undefined);
  assertDeepEqual(
    older.entries.map((entry) => (entry as { id: string }).id),
    ["m1", "m2"],
    "before cursor returns the previous displayable entries in one seek",
  );
  assertEqual(older.prevCursor, null, "oldest reverse page has no further prevCursor");
  const midTail = await store.readTranscriptPage("ws", "t1", "sess.jsonl", undefined, 2, true);
  const unaligned = await store.readTranscriptPage("ws", "t1", "sess.jsonl", undefined, 80, false, midTail.prevCursor ?? undefined);
  assertDeepEqual(
    unaligned.entries.map((entry) => (entry as { id: string }).id),
    ["m1"],
    "unaligned remainder before a tail page is returned without overlap",
  );
});

// ============================================================================

async function cleanup(): Promise<void> {
  for (const dir of roots) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

await cleanup();

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
