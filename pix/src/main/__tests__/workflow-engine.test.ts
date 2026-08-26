/**
 * Engine + host tests (S3): WorkerThreadWorkflowEngine.start() orchestration,
 * the WorkerRun settlement state machine (result / death / grace first-wins,
 * cancellation semantics, the agent-end pairing ledger, child admission) and
 * the worker path/env resolution — driven through a FAKE WorkflowChildSpawner
 * plus at least one REAL worker spawned directly from worker.ts (which
 * resolves under tsx). The host must never import the task service; that is
 * asserted on its source text below.
 *
 * Covers: synchronous throws for invalid start requests (META_INVALID,
 * SCRIPT_PARSE, INVALID_ARGUMENT, args clone failure) with nothing published,
 * result-never-rejects across completed/error/cancelled runs, cancel
 * settling within the grace window (including the stranded-agent synthesis
 * that precedes workflow/end), cancel-after-settlement being a no-op that
 * arms no grace timer, per-listener emit isolation, admission refusal
 * (child-start-error only), preflight failure pairing (child-failed /
 * AGENT_RESULT with a failed agent-end), queued-cancel children resolving
 * null to the script, disposeAll bounded disposal, worker path/env
 * resolution, and a real Worker end-to-end script run.
 *
 * The S14 integration section repeats the end-to-end path through the REAL
 * createAgentTaskChildSpawner over a FAKE AgentTaskService (recorded
 * createTaskGroup calls, scripted awaitGroup outcomes): parallel fan-out,
 * pipeline stage failure, the preflight model failure channel, the
 * queued-cancel channel and the workflowOwned background refusal.
 *
 * Run with: npm exec tsx -- src/main/__tests__/workflow-engine.test.ts
 */

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowErrorCode,
  WorkflowMeta,
  WorkflowResult,
} from "../../shared/workflow-types.js";
import { SUBAGENT_DETAILS_SCHEMA_VERSION } from "../../shared/subagent-types.js";
import type {
  SubagentDetails,
  SubagentFailureReason,
  SubagentSingleResult,
  SubagentStatus,
} from "../../shared/subagent-types.js";
import type { AgentTaskGroupHandle, AgentTaskStopReason } from "../../shared/agent-task-types.js";
import type { AgentTaskPresentation } from "../../shared/agent-task-types.js";
import type { AgentTaskService, AgentTaskSubmissionContext, CreateTaskParams } from "../agent-task/agent-task-service.js";
import type { WorkflowParentRef, WorkflowStartRequest } from "../workflow/engine/runtime-types.js";
import { WorkflowError } from "../workflow/engine/engine.js";
import { createAgentTaskChildSpawner } from "../workflow/child-spawner.js";
import { HostToWorkerType, WorkerToHostType } from "../workflow/engine/protocol.js";
import type { HostToWorkerMessage, WorkerToHostMessage } from "../workflow/engine/protocol.js";
import type { ChildHandle, ChildResult, ChildStartRequest, WorkerInit, WorkerLimits } from "../workflow/engine/child-types.js";
import { SCHEMA_CHILD_DEFAULT_MAX_TURNS } from "../workflow/engine/child-types.js";
import type { WorkflowChildSpawner } from "../workflow/child-spawner.js";
import { WorkflowChildCache } from "../workflow/child-cache.js";
import { workflowCacheKey, workflowCacheScopeId } from "../workflow/engine/child-cache-key.js";
import { workerSpawnEnv } from "../workflow/engine/host.js";
import { rewriteAsarWorkerPath, resolveWorkerEntry, resolveMaxConcurrentAgents, WorkerThreadWorkflowEngine } from "../workflow/engine/worker-thread-engine.js";

// ============================================================================
// Test harness (matches workflow-session.test.ts style)
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

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message} - expected ${b}, got ${a}`);
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until the condition holds; throws (failing the enclosing run) on timeout. */
async function waitFor(condition: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${message}`);
    await sleep(5);
  }
}

// ============================================================================
// Fixture helpers
// ============================================================================

/** A minimal valid parent ref; the fake spawner never calls getSubmissionContext. */
function parentRef(toolCallId = "tc-1"): WorkflowParentRef {
  return {
    sessionId: "sess-1",
    toolCallId,
    workspaceId: "ws-test",
    getSubmissionContext: () => ({}) as never,
  };
}

function meta(name = "engine-test"): WorkflowMeta {
  return { name, description: "engine test workflow" };
}

function startRequest(script: string, extra?: Partial<WorkflowStartRequest>): WorkflowStartRequest {
  return { script, meta: meta(), parent: parentRef(), ...extra };
}

/** A default WorkerInit for a script body (the session receives it pre-extracted). */
function init(body: string, args?: unknown, limitOverrides?: Partial<WorkerLimits>): WorkerInit {
  return {
    meta: meta(),
    body,
    ...args !== undefined ? { args } : {},
    limits: { maxConcurrentAgents: 4, maxTotalAgents: 1000, maxItemsPerCall: 4096, syncTimeoutMs: 5000, ...limitOverrides },
  };
}

/** A completed text child result. */
function text(reply: string): ChildResult {
  return { output: [{ type: "text", text: reply }], stopReason: "completed" };
}

/** A tiny Promise.withResolvers stand-in (the project targets ES2022 libs). */
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** One started (or pending) child as the fake spawner sees it. */
interface FakeChild {
  id: string;
  request: ChildStartRequest;
  runSignal: AbortSignal;
  result: Promise<ChildResult>;
  disposeCalls: number;
  disposeSettled: Promise<void>;
  settle(result: ChildResult): void;
  fail(error: Error): void;
}

interface FakeSpawnerOptions {
  /** Hold every start pending until releaseStart(index, error?) is called (child record still visible). */
  holdStarts?: boolean;
  /** Auto-settle every started child with this result factory (by call index). */
  autoReply?: (request: ChildStartRequest, index: number) => ChildResult | undefined;
  /** Auto-settle every child with stopReason "cancelled" when the run signal aborts. */
  settleOnAbort?: boolean;
}

interface FakeSpawner {
  spawner: WorkflowChildSpawner;
  children: FakeChild[];
  /** For holdStarts: release (or reject) the n-th held start, in call order. */
  releaseStart(index: number, error?: Error): void;
}

/**
 * The fake WorkflowChildSpawner (S3 acceptance): mirrors the real adapter's
 * host-visible behavior — createTaskGroup always returns a handle, and a
 * provider failure after admission rejects the handle's result (child-failed).
 */
function createFakeSpawner(options?: FakeSpawnerOptions): FakeSpawner {
  const children: FakeChild[] = [];
  const startGates: Array<{ resolve(): void; reject(error: Error): void }> = [];
  let nextId = 0;
  const spawner: WorkflowChildSpawner = {
    async start(request, _parent, runSignal): Promise<ChildHandle> {
      const id = `task-${++nextId}`;
      const settled = deferred<ChildResult>();
      const disposed = deferred<void>();
      const child: FakeChild = {
        id,
        request,
        runSignal,
        result: settled.promise,
        disposeCalls: 0,
        disposeSettled: disposed.promise,
        settle: (result) => {
          settled.resolve(result);
        },
        fail: (error) => {
          settled.reject(error);
        },
      };
      children.push(child);
      if (options?.settleOnAbort === true) {
        runSignal.addEventListener(
          "abort",
          () => {
            settled.resolve({ output: [], stopReason: "cancelled" });
          },
          { once: true },
        );
      }
      if (options?.holdStarts === true) {
        await new Promise<void>((resolve, reject) => {
          startGates.push({ resolve, reject });
        });
      }
      const index = children.indexOf(child);
      const reply = options?.autoReply?.(request, index);
      if (reply !== undefined) settled.resolve(reply);
      return {
        id,
        result: child.result,
        dispose: () => {
          child.disposeCalls += 1;
          disposed.resolve();
          return child.disposeSettled;
        },
      };
    },
  };
  return {
    spawner,
    children,
    releaseStart: (index, error) => {
      const gate = startGates[index];
      if (gate === undefined) throw new Error(`no held start at index ${index}`);
      if (error !== undefined) gate.reject(error);
      else gate.resolve();
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

await run("start with invalid input throws synchronously and publishes nothing", async () => {
  const fake = createFakeSpawner();
  const engine = new WorkerThreadWorkflowEngine(fake.spawner);
  let starts = 0;
  engine.on("workflow/start", () => {
    starts += 1;
  });

  const expectWorkflowError = (code: WorkflowErrorCode, label: string, fn: () => unknown): string => {
    try {
      fn();
      failed++;
      console.error(`  FAIL: ${label} did not throw`);
      return "";
    } catch (error) {
      if (error instanceof WorkflowError && error.code === code) {
        passed++;
        console.log(`  PASS: ${label} throws ${code}`);
        return error.message;
      }
      failed++;
      console.error(`  FAIL: ${label} threw ${String(error)} (expected WorkflowError ${code})`);
      return "";
    }
  };

  const metaMessage = expectWorkflowError("META_INVALID", "invalid meta", () =>
    engine.start(startRequest("return 1", { meta: { name: "", description: "x", extra: 1 } as WorkflowMeta })),
  );
  assert(metaMessage.includes("name must be a non-empty string"), "meta violation names the name field");
  assert(metaMessage.includes("unexpected key extra"), "meta violation names the unknown key");

  const exportMessage = expectWorkflowError("SCRIPT_PARSE", "body with export const meta", () =>
    engine.start(startRequest("export const meta = { name: 'x' }")),
  );
  assert(exportMessage.includes("remove the `export const meta"), "meta-export message points at the statement");

  expectWorkflowError("SCRIPT_PARSE", "uncompilable body", () => engine.start(startRequest("return (((")));
  expectWorkflowError("INVALID_ARGUMENT", "maxTotalAgents 0", () =>
    engine.start(startRequest("return 1", { maxTotalAgents: 0 })),
  );
  expectWorkflowError("INVALID_ARGUMENT", "maxTotalAgents 1.5", () =>
    engine.start(startRequest("return 1", { maxTotalAgents: 1.5 })),
  );
  const ceilingMessage = expectWorkflowError("INVALID_ARGUMENT", "maxTotalAgents over the ceiling", () =>
    engine.start(startRequest("return 1", { maxTotalAgents: 1001 })),
  );
  assert(ceilingMessage.includes("exceeds the engine ceiling 1000"), "ceiling message names the limit");

  // The args clone failure is rethrown AS-IS (not wrapped as WorkflowError).
  let cloneThrew = false;
  let cloneError: unknown;
  try {
    engine.start(startRequest("return 1", { args: { fn: () => undefined } }));
  } catch (error) {
    cloneThrew = true;
    cloneError = error;
  }
  assert(cloneThrew, "an uncloneable args value throws synchronously");
  assert(
    !(cloneError instanceof WorkflowError) && cloneError instanceof Error && cloneError.name === "DataCloneError",
    "the clone failure surfaces as DataCloneError, not a WorkflowError",
  );
  assertEqual(starts, 0, "no workflow/start was published for any invalid request");
});

await run("result never rejects across completed / error / cancelled runs", async () => {
  // Only the errored child is auto-replied (by prompt, order-independent); the
  // cancelled run's child stays parked so the cancel lands while it is live.
  const fake = createFakeSpawner({
    autoReply: (request) => (request.prompt === "x" ? text("ok") : undefined),
    settleOnAbort: true,
  });
  const engine = new WorkerThreadWorkflowEngine(fake.spawner, { disposeGraceMs: 400 });
  const completed = engine.start(startRequest("return { ok: 1 }"));
  const errored = engine.start(startRequest("await agent('x')\nthrow new Error('boom')"));
  const cancelled = engine.start(startRequest("return await agent('p')"));
  await waitFor(() => fake.children.length === 2, "both agents reached the spawner");
  cancelled.cancel("user aborted");

  let rejected = false;
  const results = await Promise.all(
    [completed.result, errored.result, cancelled.result].map(async (promise) => {
      try {
        return await promise;
      } catch {
        rejected = true;
        return null;
      }
    }),
  );
  assert(!rejected, "no result promise rejected");
  const [c, e, x] = results;
  assertEqual(c?.stopReason, "completed", "completed run stops completed");
  assertDeepEqual(c?.value, { ok: 1 }, "completed value materializes");
  assertEqual(e?.stopReason, "error", "errored run stops error");
  assert((e?.error ?? "").includes("boom"), "error message survives the thread boundary");
  assertEqual(e?.agentsStarted, 1, "the error run started one agent");
  // A cancel racing a completed worker result is rewritten to cancelled.
  assertEqual(x?.stopReason, "cancelled", "cancelled run stops cancelled");
  assert((x?.error ?? "").includes("user aborted"), "cancel reason carried");
  await completed.dispose();
  await errored.dispose();
  await cancelled.dispose();
});

await run("end to end: phase/log/agents complete and workflow/end carries no value", async () => {
  const fake = createFakeSpawner({ autoReply: (_request, index) => text(`r${index}`) });
  const engine = new WorkerThreadWorkflowEngine(fake.spawner);
  const events: string[] = [];
  const starts: WorkflowAgentInfo[] = [];
  const ends: WorkflowAgentEndInfo[] = [];
  let endPayload: Record<string, unknown> | undefined;
  engine.on("workflow/phase", (_info, title) => {
    events.push(`phase:${title}`);
  });
  engine.on("workflow/log", (_info, message) => {
    events.push(`log:${message}`);
  });
  engine.on("workflow/agent-start", (_info, agent) => {
    starts.push(agent);
    events.push(`start:${agent.seq}`);
  });
  engine.on("workflow/agent-end", (_info, agent) => {
    ends.push(agent);
    events.push(`end:${agent.seq}:${agent.outcome}`);
  });
  engine.on("workflow/end", (_info, result) => {
    events.push("end");
    endPayload = { ...result };
  });
  const run = engine.start(
    startRequest(
      "phase('Scan')\nlog('begin ' + args.n)\nconst a = await agent('first')\nconst b = await parallel([() => agent('second'), () => agent('third')])\nreturn { a, b, n: args.n }",
      { args: { n: 3 } },
    ),
  );
  const result = await run.result;
  await run.dispose();
  assertEqual(result.stopReason, "completed", "stopReason is completed");
  assertDeepEqual(result.value, { a: "r0", b: ["r1", "r2"], n: 3 }, "script value materializes");
  assertEqual(result.agentsStarted, 3, "three agents started");
  assertEqual(events[0], "phase:Scan", "phase precedes everything");
  assertEqual(events[1], "log:begin 3", "log follows phase");
  assertDeepEqual(starts.map((s) => s.seq), [1, 2, 3], "agent-start seqs ascend");
  assertEqual(ends.length, 3, "three agent-ends");
  assert(ends.every((agent) => agent.outcome === "completed"), "every outcome completed");
  assertEqual(events[events.length - 1], "end", "workflow/end is last");
  assertEqual(endPayload?.stopReason, "completed", "end payload carries stopReason");
  assertEqual(endPayload?.agentsStarted, 3, "end payload carries agentsStarted");
  assertDeepEqual(endPayload?.childStats, { completed: 3, failed: 0, cancelled: 0 }, "end payload carries childStats");
  assertEqual(endPayload?.sources?.length, 3, "end payload carries sources for completed children");
  assert(!("value" in (endPayload ?? {})), "workflow/end never carries the value");
  assertDeepEqual(
    fake.children.map((child) => child.request.prompt),
    ["first", "second", "third"],
    "each child-start reached the spawner with its prompt",
  );
});

await run("maxTotalAgents flows to the worker: the second agent trips AGENT_CAP", async () => {
  const fake = createFakeSpawner({ autoReply: () => text("ok") });
  const engine = new WorkerThreadWorkflowEngine(fake.spawner);
  const run = engine.start(startRequest("await agent('one')\nawait agent('two')", { maxTotalAgents: 1 }));
  const result = await run.result;
  await run.dispose();
  assertEqual(result.stopReason, "error", "stopReason is error");
  assert((result.error ?? "").includes("total agent cap (1)"), "error names the cap");
  assertEqual(result.agentsStarted, 1, "one agent was started");
});

await run("cancel of a wedged script settles within the grace window, pairing the stranded agent", async () => {
  const fake = createFakeSpawner();
  const engine = new WorkerThreadWorkflowEngine(fake.spawner, { disposeGraceMs: 150 });
  const order: string[] = [];
  engine.on("workflow/agent-start", () => {
    order.push("agent-start");
  });
  engine.on("workflow/agent-end", (_info, agent) => {
    order.push(`agent-end:${agent.outcome}`);
  });
  engine.on("workflow/end", () => {
    order.push("workflow/end");
  });
  const run = engine.start(startRequest("return await agent('wedged')"));
  await waitFor(() => order.includes("agent-start"), "agent-start emitted");
  const started = Date.now();
  run.cancel("stop now");
  const result = await run.result;
  await run.dispose();
  const elapsed = Date.now() - started;
  assertEqual(result.stopReason, "cancelled", "stopReason is cancelled");
  assert((result.error ?? "").includes("stop now"), "error carries the first reason");
  assertEqual(order.filter((entry) => entry.startsWith("agent-end")).length, 1, "exactly one agent-end");
  const endEntryIndex = order.indexOf("agent-end:cancelled");
  const endIndex = order.indexOf("workflow/end");
  assert(endEntryIndex !== -1 && endEntryIndex < endIndex, "the synthesized agent-end precedes workflow/end");
  assertEqual(order[order.length - 1], "workflow/end", "workflow/end is last");
  assert(elapsed < 1500, `settlement was grace-bound (${elapsed}ms)`);
  assertEqual(fake.children[0]?.disposeCalls, 1, "the child's dispose ran exactly once (memoized across reaps)");
});

await run("cancel after settlement is a no-op that arms no grace timer", async () => {
  const fake = createFakeSpawner();
  const engine = new WorkerThreadWorkflowEngine(fake.spawner, { disposeGraceMs: 2000 });
  const run = engine.start(startRequest("return { ok: true }"));
  const result = await run.result;
  assertEqual(result.stopReason, "completed", "run completed");
  const started = Date.now();
  // The holder path `await result; dispose -> cancel` must not re-arm a timer.
  run.cancel("too late");
  const again = await run.result;
  assertEqual(again, result, "the settled result is unchanged");
  await run.dispose();
  const elapsed = Date.now() - started;
  assert(elapsed < 1500, `dispose after a late cancel resolves promptly (${elapsed}ms)`);
});

await run("a throwing or rejecting listener never affects the run's result", async () => {
  const fake = createFakeSpawner({ autoReply: (request) => text(`ok:${request.prompt}`) });
  const engine = new WorkerThreadWorkflowEngine(fake.spawner);
  engine.on("workflow/start", () => {
    throw new Error("start listener boom");
  });
  engine.on("workflow/phase", () => {
    throw new Error("phase listener boom");
  });
  engine.on("workflow/log", async () => {
    throw new Error("log listener boom");
  });
  engine.on("workflow/agent-start", () => {
    throw new Error("agent-start listener boom");
  });
  engine.on("workflow/end", () => {
    throw new Error("end listener boom");
  });
  const run = engine.start(startRequest("phase('Scan')\nlog('hi')\nreturn await agent('audit')"));
  const result = await run.result;
  await run.dispose();
  assertEqual(result.stopReason, "completed", "run completed despite throwing listeners");
  assertEqual(result.value, "ok:audit", "value intact");
  assertEqual(result.agentsStarted, 1, "one agent started");
});

await run("admission: a start refused after cancel gets child-start-error and no agent-start", async () => {
  const fake = createFakeSpawner({ holdStarts: true });
  const engine = new WorkerThreadWorkflowEngine(fake.spawner, { disposeGraceMs: 500 });
  const starts: WorkflowAgentInfo[] = [];
  engine.on("workflow/agent-start", (_info, agent) => {
    starts.push(agent);
  });
  const run = engine.start(startRequest("return await agent('late')"));
  await waitFor(() => fake.children.length === 1, "child-start reached the spawner");
  run.cancel("stopped early");
  // The provider start fails on the now-aborted signal (createTaskGroup throw).
  fake.releaseStart(0, new Error("aborted by signal"));
  const result = await run.result;
  await run.dispose();
  assertEqual(result.stopReason, "cancelled", "stopReason is cancelled");
  assert((result.error ?? "").includes("stopped early"), "error carries the first reason");
  assertEqual(starts.length, 0, "no agent-start for a refused start");
});

await run("a preflight-failed child pairs a failed agent-end and surfaces as fatal AGENT_RESULT", async () => {
  const fake = createFakeSpawner();
  const engine = new WorkerThreadWorkflowEngine(fake.spawner);
  const starts: WorkflowAgentInfo[] = [];
  const ends: WorkflowAgentEndInfo[] = [];
  engine.on("workflow/agent-start", (_info, agent) => {
    starts.push(agent);
  });
  engine.on("workflow/agent-end", (_info, agent) => {
    ends.push(agent);
  });
  const run = engine.start(
    startRequest("try { await agent('doomed'); return 'unreachable' } catch (e) { return { code: e.code, fatal: e.fatal } }"),
  );
  await waitFor(() => fake.children.length === 1, "child started");
  // Preflight rejection AFTER createTaskGroup returned: the handle exists, so
  // the host posted ChildStarted already — the failure must be child-failed,
  // never a second start reply.
  fake.children[0]?.fail(new Error("workflow child failed to start: model_not_found"));
  const result = await run.result;
  await run.dispose();
  assertEqual(result.stopReason, "completed", "the script caught the fatal error and completed");
  assertDeepEqual(result.value, { code: "AGENT_RESULT", fatal: true }, "the script saw the fatal WorkflowError shape");
  assertEqual(starts.length, 1, "exactly one agent-start");
  assertEqual(ends.length, 1, "exactly one paired agent-end");
  assertEqual(ends[0]?.outcome, "failed", "the paired outcome is failed");
});

await run("a child settling cancelled (queued cancel) resolves null to the script; the run still completes", async () => {
  const fake = createFakeSpawner();
  const engine = new WorkerThreadWorkflowEngine(fake.spawner);
  const ends: WorkflowAgentEndInfo[] = [];
  engine.on("workflow/agent-end", (_info, agent) => {
    ends.push(agent);
  });
  const run = engine.start(startRequest("const v = await agent('doomed')\nreturn { v }"));
  await waitFor(() => fake.children.length === 1, "child started");
  fake.children[0]?.settle({ output: [], stopReason: "cancelled" });
  const result = await run.result;
  await run.dispose();
  assertEqual(result.stopReason, "completed", "a child failure does not fail the run");
  assertDeepEqual(result.value, { v: null }, "the child resolves null to the script");
  assertEqual(ends[0]?.outcome, "failed", "the paired outcome is failed");
});

await run("an already-aborted start signal cancels the run before the body executes", async () => {
  const fake = createFakeSpawner();
  const engine = new WorkerThreadWorkflowEngine(fake.spawner);
  const run = engine.start(startRequest("log('ran')\nreturn 1", { signal: AbortSignal.abort() }));
  const result = await run.result;
  await run.dispose();
  assertEqual(result.stopReason, "cancelled", "stopReason is cancelled");
  assert((result.error ?? "").includes("already aborted"), "error names the aborted start signal");
  assertEqual(result.agentsStarted, 0, "no agents started");
});

await run("disposeAll cancels and bounded-disposes every live run; idempotent", async () => {
  const fake = createFakeSpawner();
  const engine = new WorkerThreadWorkflowEngine(fake.spawner, { disposeGraceMs: 120 });
  const runA = engine.start(startRequest("await agent('a')\nreturn 1"));
  const runB = engine.start(startRequest("await agent('b')\nreturn 2"));
  await waitFor(() => fake.children.length === 2, "both children started");
  const started = Date.now();
  await engine.disposeAll();
  const elapsed = Date.now() - started;
  const a = await runA.result;
  const b = await runB.result;
  assertEqual(a.stopReason, "cancelled", "run A cancelled");
  assertEqual(b.stopReason, "cancelled", "run B cancelled");
  assert((a.error ?? "").includes("session closing"), "run A carries the session-closing reason");
  assert(elapsed < 1000, `disposeAll was bounded by the grace (${elapsed}ms)`);
  assertEqual(fake.children[0]?.disposeCalls, 1, "child A disposed exactly once");
  assertEqual(fake.children[1]?.disposeCalls, 1, "child B disposed exactly once");
  const again = Date.now();
  await engine.disposeAll();
  assert(Date.now() - again < 500, "a second disposeAll is a fast no-op");
});

await run("asarUnpack covers the whole engine directory; worker value-imports stay inside it", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
    scripts?: { "build:main"?: string };
    build?: { asarUnpack?: string[] };
  };
  assertDeepEqual(
    pkg.build?.asarUnpack,
    ["dist/main/main/workflow/engine/**/*"],
    "asarUnpack unpacks workflow/engine/**, not only worker.js",
  );
  const enginePkg = JSON.parse(
    readFileSync(new URL("../workflow/engine/package.json", import.meta.url), "utf8"),
  ) as { type?: string };
  assertEqual(enginePkg.type, "module", "unpacked engine package.json declares type module");
  assert(
    (pkg.scripts?.["build:main"] ?? "").includes("workflow/engine/package.json"),
    "build:main copies the engine package.json into dist so packaging can unpack it",
  );

  const workerGraph = ["worker.ts", "session.ts", "protocol.ts", "realm.ts", "runtime.ts", "engine.ts", "schema.ts"];
  const valueFrom = /(?:^|\n)import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/g;
  for (const file of workerGraph) {
    const source = readFileSync(new URL(`../workflow/engine/${file}`, import.meta.url), "utf8");
    for (const match of source.matchAll(valueFrom)) {
      const spec = match[1];
      assert(
        spec.startsWith("./") || spec.startsWith("node:"),
        `${file} value-imports ${JSON.stringify(spec)} (must be ./ or node:)`,
      );
    }
  }
});

await run("maxConcurrentAgents clamps to the live slot cap", async () => {
  assertEqual(resolveMaxConcurrentAgents(8, 4), 4, "requested 8 with cap 4 becomes 4");
  assertEqual(resolveMaxConcurrentAgents(8, 8), 8, "requested 8 with cap 8 stays 8");
  assertEqual(resolveMaxConcurrentAgents(1, 8), 1, "requested 1 with cap 8 stays 1");
  const autoAtFour = resolveMaxConcurrentAgents(0, 4);
  assert(autoAtFour >= 1 && autoAtFour <= 4, `auto with cap 4 is in [1,4] (got ${autoAtFour})`);
  const autoAtEight = resolveMaxConcurrentAgents(undefined, 8);
  assert(autoAtEight >= 1 && autoAtEight <= 8, `auto with cap 8 is in [1,8] (got ${autoAtEight})`);
});

await run("worker path resolution: asar rewrite and the unbuilt entry", async () => {
  const win = rewriteAsarWorkerPath("E:\\app\\resources\\app.asar\\dist\\main\\main\\workflow\\engine\\worker.js");
  assert(win.includes("app.asar.unpacked"), "backslash app.asar segment rewritten");
  assert(!win.includes("app.asar\\dist"), "no app.asar segment remains");
  const posix = rewriteAsarWorkerPath("E:/app/resources/app.asar/dist/main/main/workflow/engine/worker.js");
  assert(posix.includes("app.asar.unpacked"), "forward-slash app.asar segment rewritten");
  const plain = rewriteAsarWorkerPath("E:/dev/pi/pix/dist/main/main/workflow/engine/worker.js");
  assertEqual(plain, "E:/dev/pi/pix/dist/main/main/workflow/engine/worker.js", "a dev path (no asar) is a no-op");
  const entry = resolveWorkerEntry();
  assert(entry instanceof URL && entry.protocol === "data:", "the unbuilt resolution is a data: bootstrap");
  assert(
    decodeURIComponent((entry as URL).href).includes("/worker.ts"),
    "the bootstrap imports the sibling worker.ts",
  );
});

await run("worker spawn env: win32 carries only TMP/TEMP, other platforms empty", async () => {
  const win = workerSpawnEnv("win32");
  assertEqual(win.TMP, tmpdir(), "TMP is the host temp dir");
  assertEqual(win.TEMP, tmpdir(), "TEMP is the host temp dir");
  assertDeepEqual(Object.keys(win).sort(), ["TEMP", "TMP"], "no other variables leak");
  assertDeepEqual(workerSpawnEnv("linux"), {}, "linux env is empty");
  assertDeepEqual(workerSpawnEnv("darwin"), {}, "darwin env is empty");
});

await run("a real Worker (worker.ts resolves under tsx) runs a script end to end", async () => {
  // Direct spawn as the acceptance names it. No execArgv override: the tsx
  // loader rides process.execArgv into the worker, which is what makes the
  // .ts entry (and its .js-extension imports) resolvable under tsx.
  const worker = new Worker(new URL("../workflow/engine/worker.ts", import.meta.url), {
    workerData: init("return { doubled: args.n * 2 }", { n: 21 }),
    env: workerSpawnEnv(),
  });
  const messages: WorkerToHostMessage[] = [];
  const result = new Promise<Extract<WorkerToHostMessage, { type: "result" }>["result"]>((resolve, reject) => {
    worker.on("message", (message: WorkerToHostMessage) => {
      messages.push(message);
      if (message.type === WorkerToHostType.Ready) {
        worker.postMessage({ type: HostToWorkerType.Go } satisfies HostToWorkerMessage);
      } else if (message.type === WorkerToHostType.Result) {
        resolve(message.result);
      }
    });
    worker.on("error", reject);
  });
  const settled = await result;
  await worker.terminate();
  assertEqual(messages[0]?.type, "ready", "ready is the first message");
  assertEqual(settled.stopReason, "completed", "stopReason is completed");
  assertDeepEqual(settled.value, { doubled: 42 }, "the script value materializes");
  assertEqual(settled.agentsStarted, 0, "no children involved");
});

await run("host.ts does not import the task service (source gate)", async () => {
  const source = readFileSync(new URL("../workflow/engine/host.ts", import.meta.url), "utf8");
  assert(!source.includes("../agent-task/"), "host.ts imports nothing from the agent-task tree");
  assert(!source.includes("AgentTaskService"), "host.ts never names the service");
  assert(!/agent[-_ ]?task/i.test(source), "host.ts carries no task-service identifier");
});

// ============================================================================
// Integration section (S14): the REAL createAgentTaskChildSpawner wired into
// the engine's real worker path, backed by a FAKE AgentTaskService that
// records every createTaskGroup invocation (params + submission context) and
// returns scripted awaitGroup outcomes. The fake mirrors the service's locked
// expectations: createTaskGroup always returns a handle (a preflight-rejected
// spec becomes an already-terminated failed task), awaitGroup has NO
// "cancelled" kind (only completed | backgrounded | failed), and background()
// on a workflowOwned group refuses with workflow_owned.
// ============================================================================

/**
 * One scripted awaitGroup outcome per created group (consumed FIFO; the
 * default for an exhausted queue is a completed reply).
 */
type FakeAwaitOutcome =
  | { kind: "completed"; finalOutput: string; structured?: unknown }
  | { kind: "ran-failed" }
  | { kind: "missing-structured" }
  | { kind: "preflight-failed"; failureReason: SubagentFailureReason; errorMessage: string }
  | { kind: "queued-cancelled" }
  | { kind: "backgrounded" };

/** What the fake recorded for one createTaskGroup call. */
interface RecordedCreateTaskGroup {
  params: CreateTaskParams;
  parent: AgentTaskSubmissionContext;
  presentation: AgentTaskPresentation;
  /** Snapshot at create time: the host must never call on an aborted signal. */
  signalAborted: boolean;
  groupId: string;
  taskId: string;
  generation: number;
}

interface FakeTaskService {
  service: AgentTaskService;
  createCalls: RecordedCreateTaskGroup[];
  awaitCalls: string[];
  cancelCalls: Array<{ taskId: string; generation: number; reason: AgentTaskStopReason }>;
  backgroundCalls: Array<{ taskId: string; generation: number }>;
  /** The locked workflowOwned refusal (spawner never calls it; recorded anyway). */
  background(taskId: string, generation: number): { ok: boolean; reason?: string };
}

function makeSingleResult(status: SubagentStatus, overrides: Partial<SubagentSingleResult> = {}): SubagentSingleResult {
  return {
    id: "result-0",
    index: 0,
    agentName: "general-purpose",
    agentSource: "built-in",
    description: "workflow child",
    status,
    finalOutput: "",
    outputTruncated: false,
    originalOutputBytes: 0,
    toolUseCount: 0,
    activities: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
    durationMs: 1,
    ...overrides,
  };
}

function makeDetails(results: SubagentSingleResult[]): SubagentDetails {
  return {
    schemaVersion: SUBAGENT_DETAILS_SCHEMA_VERSION,
    mode: "single",
    agentScope: "user",
    results,
    startedAt: 1000,
    updatedAt: 2000,
    durationMs: 1000,
  };
}

function createFakeTaskService(outcomes: FakeAwaitOutcome[] = []): FakeTaskService {
  const createCalls: RecordedCreateTaskGroup[] = [];
  const awaitCalls: string[] = [];
  const cancelCalls: Array<{ taskId: string; generation: number; reason: AgentTaskStopReason }> = [];
  const backgroundCalls: Array<{ taskId: string; generation: number }> = [];
  const queue: FakeAwaitOutcome[] = [...outcomes];
  const behaviors = new Map<string, FakeAwaitOutcome>();
  let nextId = 0;

  const service = {
    async createTaskGroup(
      params: CreateTaskParams,
      parent: AgentTaskSubmissionContext,
      presentation: AgentTaskPresentation,
      signal?: AbortSignal,
    ): Promise<AgentTaskGroupHandle> {
      // Mirror the real service: never create on an already-aborted signal.
      if (signal?.aborted === true) throw new Error("aborted by signal");
      const groupId = `group-${++nextId}`;
      const taskId = `task-${nextId}`;
      behaviors.set(groupId, queue.shift() ?? { kind: "completed", finalOutput: "default output" });
      createCalls.push({
        params,
        parent,
        presentation,
        signalAborted: signal?.aborted === true,
        groupId,
        taskId,
        generation: 0,
      });
      return { kind: "agent_task_group", groupId, mode: params.mode, tasks: [{ kind: "agent_task", taskId, generation: 0, status: "queued" }] };
    },
    async awaitGroup(groupId: string): Promise<{ kind: "completed" | "backgrounded" | "failed"; details?: SubagentDetails; handle?: AgentTaskGroupHandle }> {
      awaitCalls.push(groupId);
      const behavior = behaviors.get(groupId) ?? { kind: "completed", finalOutput: "" };
      switch (behavior.kind) {
        case "completed":
          return {
            kind: "completed",
            details: makeDetails([
              makeSingleResult("completed", {
                finalOutput: behavior.finalOutput,
                ...(behavior.structured !== undefined ? { structured: behavior.structured } : {}),
              }),
            ]),
          };
        case "ran-failed":
          // Ran, then failed for its own reasons: NOT a preflight rejection.
          return {
            kind: "failed",
            details: makeDetails([makeSingleResult("failed", { failureReason: "max_turns", errorMessage: "The agent ran out of turns." })]),
          };
        case "missing-structured":
          // Schema child ran but never submitted: invalid_parameters WITH startedAt.
          return {
            kind: "failed",
            details: makeDetails([
              makeSingleResult("failed", {
                failureReason: "invalid_parameters",
                errorMessage: "The workflow child did not submit the structured result.",
                startedAt: 1000,
              }),
            ]),
          };
        case "preflight-failed":
          // The spec never became ready: status is "failed" (never "aborted"),
          // so the spawner maps it to the child-failed channel.
          return {
            kind: "failed",
            details: makeDetails([
              makeSingleResult("failed", { failureReason: behavior.failureReason, errorMessage: behavior.errorMessage }),
            ]),
          };
        case "queued-cancelled":
          // Cancelled before it ever started: status "aborted", no startedAt.
          return {
            kind: "failed",
            details: makeDetails([
              makeSingleResult("aborted", { failureReason: "aborted", errorMessage: "The agent task was cancelled while queued." }),
            ]),
          };
        case "backgrounded":
          return {
            kind: "backgrounded",
            handle: { kind: "agent_task_group", groupId, mode: "single", tasks: [] },
          };
      }
    },
    async cancel(taskId: string, generation: number, reason: AgentTaskStopReason): Promise<{ ok: boolean; reason?: string }> {
      cancelCalls.push({ taskId, generation, reason });
      return { ok: true };
    },
    background(taskId: string, generation: number): { ok: boolean; reason?: string } {
      backgroundCalls.push({ taskId, generation });
      return { ok: false, reason: "workflow_owned" };
    },
  };

  return {
    service: service as unknown as AgentTaskService,
    createCalls,
    awaitCalls,
    cancelCalls,
    backgroundCalls,
    background: service.background,
  };
}

/** A parent ref whose submission context the fake service records verbatim. */
function integrationParentRef(toolCallId = "tc-int"): WorkflowParentRef {
  return {
    sessionId: "sess-int",
    toolCallId,
    workspaceId: "ws-test",
    getSubmissionContext: () => ({ parentSessionId: "sess-int", parentToolCallId: toolCallId }) as unknown as AgentTaskSubmissionContext,
  };
}

function integrationEngine(fake: FakeTaskService): WorkerThreadWorkflowEngine {
  return new WorkerThreadWorkflowEngine(createAgentTaskChildSpawner(fake.service));
}

await run("integration: parallel fan-out issues TWO createTaskGroup calls with the locked spawn params", async () => {
  const fake = createFakeTaskService([
    { kind: "completed", finalOutput: "r0" },
    { kind: "completed", finalOutput: "r1" },
  ]);
  const engine = integrationEngine(fake);
  const ends: WorkflowAgentEndInfo[] = [];
  engine.on("workflow/agent-end", (_info, agent) => {
    ends.push(agent);
  });
  const run = engine.start(
    startRequest("return await parallel([() => agent('alpha'), () => agent('beta')])", {
      parent: integrationParentRef("tc-int"),
    }),
  );
  const result = await run.result;
  await run.dispose();

  assertEqual(result.stopReason, "completed", "stopReason is completed");
  assertDeepEqual(result.value, ["r0", "r1"], "both children resolved in thunk order");
  assertEqual(result.agentsStarted, 2, "two agents started");
  assertEqual(fake.createCalls.length, 2, "exactly TWO createTaskGroup calls");
  assertDeepEqual(
    fake.createCalls.map((call) => call.params.tasks[0].prompt).sort(),
    ["alpha", "beta"],
    "one recorded task per parallel child",
  );
  assertEqual(fake.awaitCalls.length, 2, "both groups were awaited");
  for (const call of fake.createCalls) {
    assertEqual(call.params.mode, "single", "locked spawn params: single mode");
    assertEqual(call.params.agentScope, "user", "locked spawn params: agentScope user (never both)");
    assertEqual(call.params.runInBackground, false, "locked spawn params: never background");
    assertEqual(call.params.tasks[0].subagent_type, "general-purpose", "default provider maps to general-purpose");
    assertEqual(call.params.tasks[0].description, call.params.tasks[0].prompt, "description is the default label of the prompt");
    assertEqual(call.params.workflowExtras?.length, 1, "workflowExtras parallels tasks 1:1");
    assertEqual(call.params.workflowExtras?.[0]?.modelOverride, undefined, "no model override without a model option");
    assertEqual(call.params.workflowExtras?.[0]?.outputSchema, undefined, "no outputSchema without a schema option");
    assertEqual(call.presentation, "foreground", "presentation is foreground");
    assertEqual(call.parent.parentSessionId, "sess-int", "submission context records the parent session");
    assertEqual(call.parent.parentToolCallId, "tc-int", "submission context records the parent tool call");
    assertEqual(call.signalAborted, false, "createTaskGroup was never called on an aborted signal");
  }
  assertEqual(ends.length, 2, "two agent-ends");
  assert(ends.every((agent) => agent.outcome === "completed"), "every outcome completed");
  assertEqual(fake.backgroundCalls.length, 0, "no background attempt");
});

await run("integration: a pipeline stage whose child fails resolves null for that item", async () => {
  const fake = createFakeTaskService([
    { kind: "ran-failed" },
    { kind: "completed", finalOutput: "ok" },
  ]);
  const engine = integrationEngine(fake);
  const ends: WorkflowAgentEndInfo[] = [];
  engine.on("workflow/agent-end", (_info, agent) => {
    ends.push(agent);
  });
  const run = engine.start(
    startRequest("return await pipeline([1, 2], () => agent('stage'))", { parent: integrationParentRef() }),
  );
  const result = await run.result;
  await run.dispose();

  assertEqual(result.stopReason, "completed", "a stage failure does not fail the run");
  assertDeepEqual(result.value, [null, "ok"], "the failed stage item resolves null, the healthy item keeps its reply");
  assertEqual(result.agentsStarted, 2, "one child per item");
  assertEqual(fake.createCalls.length, 2, "two createTaskGroup calls");
  assertDeepEqual(ends.map((agent) => agent.outcome), ["failed", "completed"], "the failed child pairs a failed agent-end");
});

await run("integration: a preflight model failure is child-failed / AGENT_START, never child-start-error", async () => {
  const fake = createFakeTaskService([
    { kind: "preflight-failed", failureReason: "model_not_found", errorMessage: "model faux/nope was not found" },
  ]);
  const engine = integrationEngine(fake);
  const starts: WorkflowAgentInfo[] = [];
  const ends: WorkflowAgentEndInfo[] = [];
  engine.on("workflow/agent-start", (_info, agent) => {
    starts.push(agent);
  });
  engine.on("workflow/agent-end", (_info, agent) => {
    ends.push(agent);
  });
  const run = engine.start(
    startRequest("try { await agent('doomed', { model: 'faux/nope' }); return 'unreachable' } catch (e) { return { code: e.code, fatal: e.fatal } }", {
      parent: integrationParentRef(),
    }),
  );
  const result = await run.result;
  await run.dispose();

  assertEqual(result.stopReason, "completed", "the script caught the fatal and completed");
  // child-start-error would resolve null WITHOUT throwing; the fatal AGENT_RESULT
  // proves the preflight rejection rode the child-failed channel.
  assertDeepEqual(result.value, { code: "AGENT_RESULT", fatal: true }, "the script saw the fatal AGENT_RESULT (child-failed, not child-start-error)");
  assertEqual(fake.createCalls.length, 1, "createTaskGroup was still called (preflight happens after the handle exists)");
  assertEqual(fake.createCalls[0]?.params.workflowExtras?.[0]?.modelOverride, "faux/nope", "the model override rode the spawn params");
  assertEqual(starts.length, 1, "exactly one agent-start (ChildStarted was posted)");
  assertEqual(ends.length, 1, "exactly one paired agent-end");
  assertEqual(ends[0]?.outcome, "failed", "the paired outcome is failed");
});

await run("integration: a queued-cancelled child resolves null to the script; reap cancels by taskId", async () => {
  const fake = createFakeTaskService([{ kind: "queued-cancelled" }]);
  const engine = integrationEngine(fake);
  const ends: WorkflowAgentEndInfo[] = [];
  engine.on("workflow/agent-end", (_info, agent) => {
    ends.push(agent);
  });
  const run = engine.start(startRequest("const v = await agent('queued')\nreturn { v }", { parent: integrationParentRef() }));
  const result = await run.result;
  await run.dispose();

  assertEqual(result.stopReason, "completed", "a child failure does not fail the run");
  assertDeepEqual(result.value, { v: null }, "the queued-cancelled child resolves null to the script (never AGENT_START)");
  assertEqual(ends[0]?.outcome, "failed", "the paired outcome is failed");
  const taskId = fake.createCalls[0]?.taskId;
  assert(taskId !== undefined, "the fake recorded the child taskId");
  assert(
    fake.cancelCalls.some((call) => call.taskId === taskId && call.reason === "user_cancel"),
    "the reap cancelled the child by taskId with user_cancel",
  );
});

await run("integration: a backgrounded child kills the script; background() on a workflowOwned group refuses", async () => {
  const fake = createFakeTaskService([{ kind: "backgrounded" }]);
  const engine = integrationEngine(fake);
  const run = engine.start(
    startRequest(
      "try { await agent('bg'); return 'unreachable' } catch (e) { return { code: e.code, detached: String(e.message).includes('workflow child was detached') } }",
      { parent: integrationParentRef() },
    ),
  );
  const result = await run.result;
  await run.dispose();

  assertEqual(result.stopReason, "completed", "the script caught the fatal and completed");
  assertDeepEqual(
    result.value,
    { code: "AGENT_RESULT", detached: true },
    "backgrounded maps to a fatal AGENT_RESULT carrying the locked wording",
  );
  const refusal = fake.background("any-task", 0);
  assertEqual(refusal.ok, false, "background() on a workflowOwned group fails");
  assertEqual(refusal.reason, "workflow_owned", "failure reason is workflow_owned");
});

await run("integration: schema child that never submits resolves null (never AGENT_START)", async () => {
  const fake = createFakeTaskService([{ kind: "missing-structured" }]);
  const engine = integrationEngine(fake);
  const run = engine.start(
    startRequest(
      "const v = await agent('round', { retry: 0, schema: { type: 'object', properties: { status: { type: 'string' } } } })\nreturn { v }",
      { parent: integrationParentRef() },
    ),
  );
  const result = await run.result;
  await run.dispose();
  assertEqual(result.stopReason, "completed", "missing structured submit does not kill the run");
  assertDeepEqual(result.value, { v: null }, "the script sees null, not a fatal AGENT_START");
  assertEqual(
    fake.createCalls[0]?.params.workflowExtras?.[0]?.maxTurns,
    SCHEMA_CHILD_DEFAULT_MAX_TURNS,
    "schema child default maxTurns rode the extras",
  );
  assertDeepEqual(result.childStats, { completed: 0, failed: 1, cancelled: 0 }, "childStats counts the failed schema child");
});

await run("integration: subagentProvider and label reach createTaskGroup", async () => {
  const fake = createFakeTaskService([{ kind: "completed", finalOutput: "ok" }]);
  const engine = integrationEngine(fake);
  const run = engine.start(
    startRequest("return await agent('do it', { label: 'Ralph round 1' })", {
      parent: integrationParentRef(),
      subagentProvider: "auditor",
    }),
  );
  const result = await run.result;
  await run.dispose();
  assertEqual(result.stopReason, "completed", "run completed");
  assertEqual(fake.createCalls[0]?.params.tasks[0].subagent_type, "auditor", "runDefault mapped the agent type");
  assertEqual(fake.createCalls[0]?.params.tasks[0].description, "Ralph round 1", "explicit label became the task description");
});

// ============================================================================
// S11 ChildCache acceptance: tmp WorkflowChildCache + fake spawner.
// Hit: no start/end, agentsStarted excludes hits, replayed counts.
// Miss: ChildStart. Failed oversized synthesize does not write cache.
// ============================================================================

const REVIEW_NAMES = ["auth", "api", "db", "ui", "cli", "net", "fs", "rpc", "log", "cfg"] as const;
const OVERSIZED_X = "x".repeat(70_000);
const OVERSIZED_Y = "y".repeat(70_000);

function reviewPrompt(name: string, variant = ""): string {
  return `review ${name}${variant}`;
}

function reviewLabel(name: string): string {
  return `review:${name}`;
}

function tenReviewScript(opts: {
  synth?: string;
  changed?: string;
  cacheFalse?: boolean;
}): string {
  const cacheOpt = opts.cacheFalse === true ? ", cache: false" : "";
  const thunks = REVIEW_NAMES.map((name) => {
    const prompt = reviewPrompt(name, name === opts.changed ? "-changed" : "");
    return `() => agent(${JSON.stringify(prompt)}, { label: ${JSON.stringify(reviewLabel(name))}${cacheOpt} })`;
  });
  const body = [`const reviews = await parallel([${thunks.join(", ")}])`];
  if (opts.synth !== undefined) {
    body.push(
      `const synth = await settled(${JSON.stringify(opts.synth)}, { label: "synthesize"${cacheOpt} })`,
      "return { reviews, synthOk: synth.ok }",
    );
  } else {
    body.push("return { reviews }");
  }
  return body.join("\n");
}

function cacheAutoReply(request: ChildStartRequest): ChildResult {
  if (request.prompt.length > 65536) {
    return {
      output: [{ type: "text", text: "" }],
      stopReason: "failed",
      failureReason: "prompt_too_large",
      error: "The delegated prompt exceeds 65536 bytes.",
    };
  }
  return text(`ok:${request.label ?? request.prompt}`);
}

async function waitForReviewStores(cache: WorkflowChildCache, scopeId: string): Promise<void> {
  const keys = REVIEW_NAMES.map((name) => workflowCacheKey(reviewPrompt(name), {}));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const hits = await Promise.all(keys.map((key) => cache.lookup(scopeId, key)));
    if (hits.every((hit) => hit !== undefined)) return;
    await sleep(10);
  }
  throw new Error("timed out waiting for the ten review cache stores");
}

await run("S11 ChildCache: same meta.name hit/miss, change name, cache:false", async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-workflow-engine-cache-"));
  try {
    const cache = new WorkflowChildCache({ rootDir: root });
    const fake = createFakeSpawner({ autoReply: cacheAutoReply });
    const engine = new WorkerThreadWorkflowEngine(fake.spawner, {
      cache,
      maxConcurrentAgents: 10,
      getRunningSlotCap: () => 10,
    });
    const logs: string[] = [];
    const starts: WorkflowAgentInfo[] = [];
    const ends: WorkflowAgentEndInfo[] = [];
    engine.on("workflow/log", (_info, message) => {
      logs.push(message);
    });
    engine.on("workflow/agent-start", (_info, agent) => {
      starts.push(agent);
    });
    engine.on("workflow/agent-end", (_info, agent) => {
      ends.push(agent);
    });

    const cacheParent = parentRef();
    const auditMeta = meta("audit-cache");
    const scopeId = workflowCacheScopeId(cacheParent.workspaceId, cacheParent.sessionId, auditMeta.name);
    const expectedReviews = REVIEW_NAMES.map((name) => `ok:${reviewLabel(name)}`);

    const runCached = async (script: string, name: string): Promise<WorkflowResult> => {
      logs.length = 0;
      starts.length = 0;
      ends.length = 0;
      const live = engine.start({ script, meta: meta(name), parent: cacheParent });
      const result = await live.result;
      await live.dispose();
      return result;
    };

    // --- run1: ten reviews + oversized synthesize writes cache for the ten ---
    const run1 = await runCached(tenReviewScript({ synth: OVERSIZED_X }), "audit-cache");
    assertEqual(run1.stopReason, "completed", "run1 completed (oversized synth does not kill the script)");
    assertDeepEqual((run1.value as { reviews: string[] }).reviews, expectedReviews, "run1 ten reviews resolved");
    assertEqual((run1.value as { synthOk: boolean }).synthOk, false, "run1 oversized synth failed");
    assertEqual(run1.agentsStarted, 11, "run1 agentsStarted is 11 (ten reviews + synth)");
    assertEqual(run1.childStats?.replayed, undefined, "run1 has no replayed");
    assertEqual(starts.length, 11, "run1 miss path emits 11 agent-starts");
    assertEqual(ends.length, 11, "run1 miss path emits 11 agent-ends");
    assertEqual(
      ends.filter((agent) => agent.outcome === "completed").length,
      10,
      "run1 ten reviews completed",
    );
    assertEqual(
      ends.filter((agent) => agent.outcome === "failed" && agent.label === "synthesize").length,
      1,
      "run1 synthesize failed with a paired end",
    );
    assertEqual(fake.children.length, 11, "run1 spawned 11 children");
    await waitForReviewStores(cache, scopeId);
    assertEqual(
      await cache.lookup(scopeId, workflowCacheKey(OVERSIZED_X, {})),
      undefined,
      "failed oversized synthesize does not write cache",
    );

    // --- run2: change the synthesize segment => 10 cache hits + 1 real spawn ---
    const run2 = await runCached(tenReviewScript({ synth: OVERSIZED_Y }), "audit-cache");
    assertEqual(run2.stopReason, "completed", "run2 completed");
    assertDeepEqual((run2.value as { reviews: string[] }).reviews, expectedReviews, "run2 reviews replay from cache");
    assertEqual(run2.agentsStarted, 1, "run2 agentsStarted excludes the ten hits");
    assertEqual(run2.childStats?.replayed, 10, "run2 replayed is 10");
    assertEqual(run2.sources?.length, 10, "run2 sources are the ten cached reviews (failed synthesize is not a source)");
    assertEqual(
      run2.sources?.filter((source) => source.label.startsWith("review:")).length,
      10,
      "run2 sources include the ten cached reviews",
    );
    assertEqual(starts.length, 1, "run2 hit path has no start for the ten reviews");
    assertEqual(ends.length, 1, "run2 hit path has no end for the ten reviews");
    assertEqual(starts[0]?.label, "synthesize", "run2 only the changed synthesize spawns");
    assertEqual(fake.children.length, 12, "run2 added exactly one spawn");
    assertEqual(
      REVIEW_NAMES.filter((name) => logs.includes(`cache hit: ${reviewLabel(name)}`)).length,
      10,
      "run2 logs cache hit: <label> for each review",
    );

    // --- run3: change one review prompt => only that misses, others hit ---
    const run3 = await runCached(tenReviewScript({ changed: "auth" }), "audit-cache");
    assertEqual(run3.stopReason, "completed", "run3 completed");
    assertEqual(run3.agentsStarted, 1, "run3 agentsStarted is the one changed review");
    assertEqual(run3.childStats?.replayed, 9, "run3 replayed is 9");
    assertEqual(starts.length, 1, "run3 only the changed review has start");
    assertEqual(ends.length, 1, "run3 only the changed review has end");
    assertEqual(starts[0]?.label, "review:auth", "run3 miss is the changed review");
    assertEqual(fake.children.length, 13, "run3 added exactly one spawn");
    const run3Hits = REVIEW_NAMES.filter(
      (name) => name !== "auth" && logs.includes(`cache hit: ${reviewLabel(name)}`),
    );
    assertEqual(run3Hits.length, 9, "run3 logs cache hit for the nine unchanged reviews");
    assert(
      !logs.includes("cache hit: review:auth"),
      "run3 changed review is not a hit",
    );
    assertDeepEqual(
      (run3.value as { reviews: string[] }).reviews,
      expectedReviews,
      "run3 still returns ten review values (nine replayed, one fresh with the same label)",
    );

    // --- run4: change meta.name => miss ---
    const otherScope = workflowCacheScopeId(cacheParent.workspaceId, cacheParent.sessionId, "audit-other");
    const run4 = await runCached(tenReviewScript({}), "audit-other");
    assertEqual(run4.stopReason, "completed", "run4 completed");
    assertEqual(run4.agentsStarted, 10, "run4 different meta.name misses all ten");
    assertEqual(run4.childStats?.replayed, undefined, "run4 has no replayed");
    assertEqual(starts.length, 10, "run4 miss path emits 10 agent-starts");
    assertEqual(ends.length, 10, "run4 miss path emits 10 agent-ends");
    assertEqual(fake.children.length, 23, "run4 spawned all ten");
    assertEqual(
      logs.filter((line) => line.startsWith("cache hit:")).length,
      0,
      "run4 change meta.name produces no cache hits",
    );
    await waitForReviewStores(cache, otherScope);
    assertEqual(
      (await cache.lookup(otherScope, workflowCacheKey(reviewPrompt("auth"), {})))?.value,
      "ok:review:auth",
      "run4 stores under the new meta.name scope",
    );
    assertEqual(
      (await cache.lookup(scopeId, workflowCacheKey(reviewPrompt("auth"), {})))?.value,
      "ok:review:auth",
      "run4 does not clobber the original meta.name scope",
    );

    // --- run5: cache:false => all spawn ---
    const run5 = await runCached(tenReviewScript({ cacheFalse: true }), "audit-cache");
    assertEqual(run5.stopReason, "completed", "run5 completed");
    assertEqual(run5.agentsStarted, 10, "run5 cache:false spawns all ten despite a warm cache");
    assertEqual(run5.childStats?.replayed, undefined, "run5 cache:false does not set replayed");
    assertEqual(starts.length, 10, "run5 cache:false emits start for every child");
    assertEqual(ends.length, 10, "run5 cache:false emits end for every child");
    assertEqual(fake.children.length, 33, "run5 spawned all ten");
    assertEqual(
      logs.filter((line) => line.startsWith("cache hit:")).length,
      0,
      "run5 cache:false produces no cache hits",
    );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
