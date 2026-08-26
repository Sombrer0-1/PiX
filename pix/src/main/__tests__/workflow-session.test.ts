/**
 * Worker session tests (S2): runWorkerSession driven IN-PROCESS over a
 * MessageChannel pair, with a fake host-side port reader mirroring the real
 * host's protocol discipline (one started/start-error per start; settled /
 * disposed follow). This is where the worker-side files earn their coverage —
 * code inside a real Worker is invisible to a plain tsx test process.
 *
 * Covers: the ready/go handshake, phase/log/agent-start/agent-end progress
 * messages, the child RPC bridge (schema/model/provider forwarding, start
 * refusals, infrastructure failures, dispose), cancellation semantics (before
 * go -> body never executes; mid-run -> the NEXT hook boundary throws;
 * queued slot waiters reject), cap enforcement (AGENT_CAP / ITEM_CAP),
 * combinator null-vs-fatal semantics (a forged fatal-shaped object stays
 * null), result materialization (RESULT_UNSERIALIZABLE), the vm sync timeout,
 * label defaults/truncation, and the `export const meta` absence: the session
 * receives the body pre-extracted (pre-parse is start()'s job, S3), so no
 * meta-export test lives here.
 *
 * Run with: npm exec tsx -- src/main/__tests__/workflow-session.test.ts
 */

import { MessageChannel } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import { HostToWorkerType, WorkerToHostType } from "../workflow/engine/protocol.js";
import type { HostToWorkerMessage, WorkerToHostMessage } from "../workflow/engine/protocol.js";
import { requireParentPort, runWorkerSession } from "../workflow/engine/session.js";
import type { ChildResult, WorkerInit } from "../workflow/engine/child-types.js";
import { SCHEMA_CHILD_DEFAULT_MAX_TURNS } from "../workflow/engine/child-types.js";

// ============================================================================
// Test harness (matches plan-types.test.ts style)
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
async function waitFor(condition: () => boolean, message: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${message}`);
    await sleep(5);
  }
}

// ============================================================================
// Fixture helpers
// ============================================================================

/** Default limits for in-process sessions (concurrency pinned; auto is machine-derived). */
function limits(overrides?: Partial<WorkerInit["limits"]>): WorkerInit["limits"] {
  return { maxConcurrentAgents: 8, maxTotalAgents: 1000, maxItemsPerCall: 4096, syncTimeoutMs: 5000, ...overrides };
}

/** Wrap a body in the minimal valid meta header (the session receives it pre-extracted). */
function init(body: string, args?: unknown, limitOverrides?: Partial<WorkerInit["limits"]>): WorkerInit {
  return {
    meta: { name: "test-flow", description: "a test workflow" },
    body,
    ...args !== undefined ? { args } : {},
    limits: limits(limitOverrides),
  };
}

/** One scripted host over the other end of a MessageChannel. */
interface FakeHost {
  port: MessagePort;
  messages: WorkerToHostMessage[];
  /** Messages of one type, as they arrive. */
  ofType<T extends WorkerToHostMessage["type"]>(type: T): Array<Extract<WorkerToHostMessage, { type: T }>>;
  send(message: HostToWorkerMessage): void;
  /** Resolves with the terminal result message. */
  result(): Promise<Extract<WorkerToHostMessage, { type: "result" }>["result"]>;
  close(): void;
}

interface FakeHostOptions {
  /** Auto-respond to child-start: reply started + settled per child index. Omit a reply to leave the child pending. */
  reply?: (request: { prompt: string; schema?: unknown; provider?: string; model?: string }, index: number) => ChildResult | undefined;
  /** Reject the start instead (child-start-error) when returning a string. */
  refuse?: (index: number) => string | undefined;
  /** Auto-send `go` on `ready` (default true). */
  go?: boolean;
  /** Manual mode: do NOT auto-answer child-start at all (the test scripts the replies). */
  manual?: boolean;
  /** Override cache-lookup. Default miss. Return undefined to leave the lookup pending. */
  cacheLookup?: (key: string, callId: number) => { hit: boolean; value?: unknown; childId?: string } | undefined;
  /** If true, do not auto-ack cache-store (proves agent()/settled() do not await store). */
  holdStore?: boolean;
}

/**
 * Drive runWorkerSession IN-PROCESS over a MessageChannel: this is where the
 * worker-side files earn their coverage — code inside a real Worker is
 * invisible to main-process coverage. The fake host mirrors the real host's
 * protocol discipline (one started/start-error per start; settled/disposed
 * follow).
 */
function fakeHost(options?: FakeHostOptions): FakeHost {
  const channel = new MessageChannel();
  const messages: WorkerToHostMessage[] = [];
  const resultGate = (() => {
    let resolve!: (result: Extract<WorkerToHostMessage, { type: "result" }>["result"]) => void;
    const promise = new Promise<Extract<WorkerToHostMessage, { type: "result" }>["result"]>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  })();
  let childIndex = 0;
  channel.port1.on("message", (message: WorkerToHostMessage) => {
    messages.push(message);
    switch (message.type) {
      case WorkerToHostType.Ready:
        if (options?.go !== false) {
          channel.port1.postMessage({ type: HostToWorkerType.Go } satisfies HostToWorkerMessage);
        }
        break;
      case WorkerToHostType.ChildStart: {
        if (options?.manual) break;
        const index = childIndex;
        childIndex += 1;
        const refusal = options?.refuse?.(index);
        if (refusal !== undefined) {
          channel.port1.postMessage(
            { type: HostToWorkerType.ChildStartError, callId: message.callId, rendered: refusal } satisfies HostToWorkerMessage,
          );
          break;
        }
        channel.port1.postMessage(
          { type: HostToWorkerType.ChildStarted, callId: message.callId, childId: `child-${index}` } satisfies HostToWorkerMessage,
        );
        const reply = options?.reply?.(message.request, index);
        if (reply !== undefined) {
          channel.port1.postMessage(
            { type: HostToWorkerType.ChildSettled, callId: message.callId, result: reply } satisfies HostToWorkerMessage,
          );
        }
        break;
      }
      case WorkerToHostType.ChildDispose:
        channel.port1.postMessage({ type: HostToWorkerType.ChildDisposed, callId: message.callId } satisfies HostToWorkerMessage);
        break;
      case WorkerToHostType.CacheLookup: {
        const lookup = options?.cacheLookup?.(message.key, message.callId);
        if (lookup === undefined && options?.cacheLookup !== undefined) break;
        const reply = lookup ?? { hit: false };
        channel.port1.postMessage(
          {
            type: HostToWorkerType.CacheLookupResult,
            callId: message.callId,
            hit: reply.hit,
            ...reply.hit ? { value: reply.value } : {},
            ...reply.hit && reply.childId !== undefined ? { childId: reply.childId } : {},
          } satisfies HostToWorkerMessage,
        );
        break;
      }
      case WorkerToHostType.CacheStore:
        if (options?.holdStore) break;
        channel.port1.postMessage(
          { type: HostToWorkerType.CacheStored, callId: message.callId } satisfies HostToWorkerMessage,
        );
        break;
      case WorkerToHostType.Result:
        resultGate.resolve(message.result);
        break;
      default:
        break;
    }
  });
  return {
    port: channel.port2,
    messages,
    ofType: (type) => messages.filter((message): message is Extract<WorkerToHostMessage, { type: typeof type }> => message.type === type),
    send: (message) => {
      channel.port1.postMessage(message);
    },
    result: () => resultGate.promise,
    close: () => {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

/** A completed text child result. */
function text(reply: string): ChildResult {
  return { output: [{ type: "text", text: reply }], stopReason: "completed" };
}

// ============================================================================
// Tests
// ============================================================================

await run("fake ChildPort: `return 1` completes with value 1", async () => {
  const host = fakeHost();
  void runWorkerSession(host.port, init("return 1"));
  const result = await host.result();
  assertEqual(result.stopReason, "completed", "stopReason is completed");
  assertEqual(result.value, 1, "value is 1");
  assertEqual(result.agentsStarted, 0, "no agents started");
  host.close();
});

await run("runs a script end to end: ready/go handshake, phases, log, agents, result", async () => {
  const host = fakeHost({ reply: (_request, index) => text(`answer-${index}`) });
  const session = runWorkerSession(
    host.port,
    init(`
      phase('Scan')
      log('starting with ' + args.files.length + ' files')
      const answers = await pipeline(args.files, (prev, item) => agent('read ' + item))
      return { answers }
    `, { files: ["a.ts", "b.ts"] }),
  );
  const result = await host.result();
  await session;
  assertEqual(result.stopReason, "completed", "stopReason is completed");
  assertEqual(result.agentsStarted, 2, "two agents started");
  assertDeepEqual(result.value, { answers: ["answer-0", "answer-1"] }, "pipeline answers materialize");
  assertEqual(host.messages[0]?.type, "ready", "first message is ready");
  assertDeepEqual(host.ofType(WorkerToHostType.Phase).map((m) => m.title), ["Scan"], "phase message posted");
  assertDeepEqual(
    host.ofType(WorkerToHostType.Log).map((m) => m.message),
    ["starting with 2 files"],
    "log message posted",
  );
  assertDeepEqual(
    host.ofType(WorkerToHostType.AgentStart).map((m) => m.info.childId),
    ["child-0", "child-1"],
    "agent-start posted per child with host childId",
  );
  assert(
    host.ofType(WorkerToHostType.AgentEnd).every((m) => m.info.outcome === "completed"),
    "both agents ended completed",
  );
  host.close();
});

await run("agent({schema}) forwards the schema on the start request and returns the structured value", async () => {
  const host = fakeHost({
    reply: () => ({ output: [], structured: { files: { first: "x.ts" } }, stopReason: "completed" }),
  });
  void runWorkerSession(
    host.port,
    init(`
      const found = await agent('list files', { schema: { type: 'object', properties: { files: { type: 'object' } } }, model: 'deepseek-v4-pro' })
      return { first: found.files.first }
    `),
  );
  const result = await host.result();
  assertDeepEqual(result.value, { first: "x.ts" }, "structured value returned");
  const start = host.ofType(WorkerToHostType.ChildStart)[0];
  assert(start !== undefined, "a child-start was posted");
  assertDeepEqual(
    start.request.schema,
    { type: "object", properties: { files: { type: "object" } } },
    "schema forwarded on the start request",
  );
  assertEqual(start.request.model, "deepseek-v4-pro", "model forwarded on the start request");
  host.close();
});

await run("agent({schema}) accepts nested string/array nodes (ralph reportSchema)", async () => {
  const host = fakeHost({
    reply: () => ({
      output: [],
      structured: {
        status: "complete",
        summary: "done",
        evidence: ["a"],
        nextSteps: ["b"],
        blocker: "none",
      },
      stopReason: "completed",
    }),
  });
  void runWorkerSession(
    host.port,
    init(`
      return await agent('round', {
        schema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['continue', 'complete', 'blocked'] },
            summary: { type: 'string' },
            evidence: { type: 'array', items: { type: 'string' } },
            nextSteps: { type: 'array', items: { type: 'string' } },
            blocker: { type: 'string' },
          },
          required: ['status', 'summary', 'evidence', 'nextSteps', 'blocker'],
          additionalProperties: false,
        },
        label: 'Ralph round 1',
      })
    `),
  );
  const result = await host.result();
  assertEqual(result.stopReason, "completed", "ralph-shaped schema is not UNSUPPORTED_SCHEMA");
  assertDeepEqual(result.value, {
    status: "complete",
    summary: "done",
    evidence: ["a"],
    nextSteps: ["b"],
    blocker: "none",
  }, "structured report returned");
  const start = host.ofType(WorkerToHostType.ChildStart)[0];
  assertEqual(start?.request.label, "Ralph round 1", "ralph round label forwarded");
  assertEqual(start?.request.maxTurns, SCHEMA_CHILD_DEFAULT_MAX_TURNS, "schema child defaults to the shared maxTurns");
  host.close();
});

await run("WorkerInit.runDefault is forwarded as providerDefault on child-start", async () => {
  const host = fakeHost({ reply: () => text("ok") });
  const payload = init("return await agent('p')");
  payload.runDefault = "auditor";
  void runWorkerSession(host.port, payload);
  const result = await host.result();
  assertEqual(result.stopReason, "completed", "run completed");
  const start = host.ofType(WorkerToHostType.ChildStart)[0];
  assertEqual(start?.request.providerDefault, "auditor", "runDefault became providerDefault");
  host.close();
});

await run("agent({provider}) forwards a provider without inventing a model", async () => {
  const host = fakeHost({ reply: () => text("ok") });
  void runWorkerSession(host.port, init("return await agent('route me', { provider: 'openai' })"));
  const result = await host.result();
  assertEqual(result.value, "ok", "text result returned");
  const start = host.ofType(WorkerToHostType.ChildStart)[0];
  assert(start !== undefined, "a child-start was posted");
  assertEqual(start.request.provider, "openai", "provider forwarded");
  assertEqual(start.request.model, undefined, "no model invented");
  host.close();
});

await run("a schema child completing WITHOUT a structured value resolves null with a failed outcome", async () => {
  const host = fakeHost({ reply: () => text("prose, no structure") });
  void runWorkerSession(host.port, init("return await agent('p', { schema: { type: 'object' }, retry: 0 })"));
  const result = await host.result();
  assertEqual(result.value, null, "null returned");
  assertEqual(host.ofType(WorkerToHostType.AgentEnd)[0]?.info.outcome, "failed", "agent-end outcome is failed");
  assert(
    (host.ofType(WorkerToHostType.AgentEnd)[0]?.info.error ?? "").includes("structured"),
    "agent-end error names the missing submit",
  );
  const logs = host.ofType(WorkerToHostType.Log).map((m) => m.message);
  assert(logs.some((line) => line.includes("ended failed") && line.includes("structured")), "log carries the failure reason");
  host.close();
});

await run("a child settling non-completed resolves null (scripts filter), never throwing into the script", async () => {
  const host = fakeHost({ reply: (_request, index) => (index === 0 ? { output: [], stopReason: "error" } : text("ok")) });
  void runWorkerSession(host.port, init("return await parallel([() => agent('one'), () => agent('two')])"));
  const result = await host.result();
  assertDeepEqual(result.value, [null, "ok"], "failed child is null, completed child passes");
  const outcomes = host.ofType(WorkerToHostType.AgentEnd).map((m) => m.info.outcome);
  assert(outcomes.includes("failed") && outcomes.includes("completed"), "paired failed + completed outcomes");
  host.close();
});

await run("a start refusal (child-start-error) is a fatal AGENT_START that kills the script through a combinator", async () => {
  const host = fakeHost({ refuse: () => "no provider here" });
  void runWorkerSession(host.port, init("return await pipeline([1], () => agent('p'))"));
  const result = await host.result();
  assertEqual(result.stopReason, "error", "stopReason is error");
  assert((result.error ?? "").includes("agent() could not start a child"), "error names the start failure");
  assert((result.error ?? "").includes("no provider here"), "error carries the host's rendered reason");
  host.close();
});

await run("a child-failed message (infrastructure rejection) is fatal AGENT_RESULT with the paired failed outcome", async () => {
  const host = fakeHost();
  void runWorkerSession(
    host.port,
    init(`
      try { await agent('p'); return 'unreachable' } catch (e) { return { name: e.name, code: e.code, fatal: e.fatal } }
    `),
  );
  await waitFor(() => host.ofType(WorkerToHostType.ChildStart).length === 1, "child-start posted");
  const callId = host.ofType(WorkerToHostType.ChildStart)[0].callId;
  host.send({ type: HostToWorkerType.ChildStarted, callId, childId: "child-0" });
  host.send({ type: HostToWorkerType.ChildFailed, callId, rendered: "backend exploded" });
  const result = await host.result();
  assertDeepEqual(
    result.value,
    { name: "WorkflowError", code: "AGENT_RESULT", fatal: true },
    "script observes the fatal WorkflowError shape",
  );
  assertEqual(host.ofType(WorkerToHostType.AgentEnd)[0]?.info.outcome, "failed", "paired agent-end outcome is failed");
  host.close();
});

await run("cancel before go: the body never runs at all and the result is cancelled (a second cancel is a no-op)", async () => {
  const host = fakeHost({ go: false });
  const session = runWorkerSession(host.port, init("log('ran')\nreturn 123"));
  await waitFor(() => host.messages.some((m) => m.type === WorkerToHostType.Ready), "ready posted");
  host.send({ type: HostToWorkerType.Cancel, reason: "aborted before start" });
  // Idempotence: the first reason wins; a duplicate cancel changes nothing.
  host.send({ type: HostToWorkerType.Cancel, reason: "a later reason that must lose" });
  const result = await host.result();
  await session;
  assertEqual(result.stopReason, "cancelled", "stopReason is cancelled");
  assert((result.error ?? "").includes("aborted before start"), "error carries the first reason");
  assert(!(result.error ?? "").includes("must lose"), "second reason did not win");
  assertEqual(result.value, null, "no value");
  assertEqual(host.ofType(WorkerToHostType.Log).length, 0, "the body never executed");
  host.close();
});

await run("a script with no return value resolves value: null", async () => {
  const host = fakeHost({ reply: () => text("ok") });
  void runWorkerSession(host.port, init("await agent('p')"));
  const result = await host.result();
  assertEqual(result.stopReason, "completed", "stopReason is completed");
  assertEqual(result.value, null, "value is null");
  host.close();
});

await run("cancel mid-run: hooks throw at entry and the run reports cancelled", async () => {
  const host = fakeHost();
  void runWorkerSession(
    host.port,
    init(`
      phase('before')
      try { await agent('x') } catch (e) {}
      try { phase('after') } catch (e) {}
      try { log('after') } catch (e) {}
      try { await parallel([() => 'ran']) } catch (e) {}
      try { await pipeline(['item'], p => p) } catch (e) {}
      return 'survived by catching'
    `),
  );
  await waitFor(() => host.ofType(WorkerToHostType.ChildStart).length === 1, "child-start posted");
  const callId = host.ofType(WorkerToHostType.ChildStart)[0].callId;
  host.send({ type: HostToWorkerType.ChildStarted, callId, childId: "child-0" });
  host.send({ type: HostToWorkerType.Cancel, reason: "stop everything" });
  // The real host settles the aborted child; mirror it.
  host.send({ type: HostToWorkerType.ChildSettled, callId, result: { output: [], stopReason: "aborted" } });
  const result = await host.result();
  assertEqual(result.stopReason, "cancelled", "stopReason is cancelled");
  assert((result.error ?? "").includes("stop everything"), "error carries the cancel reason");
  assertEqual(host.ofType(WorkerToHostType.AgentEnd)[0]?.info.outcome, "cancelled", "agent-end outcome is cancelled");
  // No post-cancel narration left the runtime (the hooks threw at entry).
  assertDeepEqual(host.ofType(WorkerToHostType.Phase).map((m) => m.title), ["before"], "only the pre-cancel phase posted");
  assertEqual(host.ofType(WorkerToHostType.Log).length, 0, "no log after cancel");
  host.close();
});

await run("cancellation between a queued waiter and its slot: the waiter rejects without a child-start", async () => {
  const host = fakeHost({ go: true });
  void runWorkerSession(
    host.port,
    init(
      "return await parallel([() => agent('a'), () => agent('b')])",
      undefined,
      { maxConcurrentAgents: 1 },
    ),
  );
  await waitFor(() => host.ofType(WorkerToHostType.ChildStart).length === 1, "first child-start posted");
  host.send({ type: HostToWorkerType.Cancel, reason: "raced" });
  const result = await host.result();
  assertEqual(result.stopReason, "cancelled", "stopReason is cancelled");
  assertEqual(host.ofType(WorkerToHostType.ChildStart).length, 1, "only the first agent ever reached the host");
  host.close();
});

await run("a stray (never-awaited) agent is reaped after settlement: cancel + dispose RPCs flow, no unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const host = fakeHost();
    void runWorkerSession(host.port, init("agent('stray, never awaited')\nreturn 'done without awaiting'"));
    const result = await host.result();
    assertEqual(result.stopReason, "completed", "run completes");
    await waitFor(() => host.ofType(WorkerToHostType.ChildStart).length === 1, "child-start posted");
    const callId = host.ofType(WorkerToHostType.ChildStart)[0].callId;
    host.send({ type: HostToWorkerType.ChildStarted, callId, childId: "child-0" });
    host.send({ type: HostToWorkerType.ChildSettled, callId, result: { output: [], stopReason: "aborted" } });
    await waitFor(() => host.ofType(WorkerToHostType.ChildDispose).some((m) => m.callId === callId), "child-dispose posted");
    await sleep(20);
    assertEqual(unhandled.length, 0, "no unhandled rejection surfaced");
    host.close();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

await run("an unparseable body settles an error result instead of dying without one (host pre-parse skew guard)", async () => {
  const host = fakeHost();
  await runWorkerSession(host.port, init("return ((("));
  const result = await host.result();
  assertEqual(result.stopReason, "error", "stopReason is error");
  assert((result.error ?? "").includes("does not parse"), "error names the parse failure");
  assertEqual(result.agentsStarted, 0, "no agents started");
  host.close();
});

await run("a synchronous spin in the initial slice dies by the in-worker vm timeout", async () => {
  const host = fakeHost();
  void runWorkerSession(host.port, init("while (true) {}", undefined, { syncTimeoutMs: 50 }));
  const result = await host.result();
  assertEqual(result.stopReason, "error", "stopReason is error");
  assert((result.error ?? "").toLowerCase().includes("timed out"), "error mentions the timeout");
  host.close();
});

await run("a non-JSON return value fails loud as RESULT_UNSERIALIZABLE", async () => {
  const host = fakeHost();
  void runWorkerSession(host.port, init("return { when: new Date(0) }"));
  const result = await host.result();
  assertEqual(result.stopReason, "error", "stopReason is error");
  assert((result.error ?? "").includes("not plain JSON data"), "error names the serialization failure");
  host.close();
});

await run("tolerates replies for unknown callIds (a teardown race): nothing crashes, the run completes", async () => {
  const host = fakeHost({ reply: () => text("fine") });
  void runWorkerSession(host.port, init("return await agent('p')"));
  host.send({ type: HostToWorkerType.ChildStarted, callId: 999, childId: "ghost" });
  host.send({ type: HostToWorkerType.ChildStartError, callId: 999, rendered: "ghost" });
  host.send({ type: HostToWorkerType.ChildSettled, callId: 999, result: text("ghost") });
  host.send({ type: HostToWorkerType.ChildFailed, callId: 999, rendered: "ghost" });
  host.send({ type: HostToWorkerType.ChildDisposed, callId: 999 });
  const result = await host.result();
  assertEqual(result.stopReason, "completed", "stopReason is completed");
  assertEqual(result.value, "fine", "value returned");
  host.close();
});

await run("caps and malformed hook arguments reject loud (the runtime runs unchanged inside the session)", async () => {
  const cases: Array<[string, string]> = [
    ["return await agent(42)", "non-empty prompt string"],
    ["return await agent('')", "non-empty prompt string"],
    ["return await agent('p', 'opts')", "options must be an object"],
    ["return await agent('p', { label: 3 })", '"label" must be a string'],
    ["return await agent('p', { get label() { throw new Error('read failed') } })", "options must be plain JSON data"],
    ["return await agent('p', { bogus: true })", '"bogus" is not recognized'],
    ["return await agent('p', { effort: 'high' })", '"effort" is deferred and not supported by this engine (supported: label, phase, schema, provider, model, retry, maxTurns, cache, artifacts)'],
    ["return await agent('p', { cache: 'no' })", '"cache" must be a boolean'],
    ["return await agent('p', { isolation: true })", '"isolation" is deferred'],
    ["return await agent('p', { agentType: 'task' })", '"agentType" is deferred'],
    ["return await agent('p', { schema: { type: 'array' } })", "outside the supported subset"],
    ["return await agent('p', { schema: { type: 'object', minLength: 1 } })", "outside the supported subset"],
    ["return await parallel([() => 1, () => 2, () => 3])", "over the per-call cap (2)"],
    ["return await pipeline([1, 2, 3], (x) => x)", "maxItemsPerCall"],
    ["return await parallel('no')", "parallel() requires an array"],
    ["return await parallel([3])", "item 0 is not a function"],
    ["return await pipeline('no', () => 1)", "pipeline() requires an items array"],
    ["return await pipeline([1])", "at least one stage"],
    ["return await pipeline([1], 'x')", "stage 0 is not a function"],
    ["return await pipeline([1], (x) => x, { isolation: true })", "not recognized"],
    ["return await pipeline([1], (x) => x, { retry: 3 })", "must be an integer between 0 and 2"],
    ["return await parallel([() => 1], { retry: -1 })", "must be an integer between 0 and 2"],
    ["phase('')", "phase() requires a non-empty title string"],
    ["phase(3)", "phase() requires a non-empty title string"],
    ["log(3)", "log() requires a message string"],
  ];
  for (const [body, expected] of cases) {
    const host = fakeHost({ reply: () => text("ok") });
    void runWorkerSession(host.port, init(body, undefined, { maxItemsPerCall: 2 }));
    const result = await host.result();
    assertEqual(result.stopReason, "error", `${body} -> error`);
    assert((result.error ?? "").includes(expected), `${body} -> error contains ${JSON.stringify(expected)}`);
    host.close();
  }
});

await run("combinator semantics: thunk/stage throws null the item; a forged fatal-shaped object stays null; real fatals propagate", async () => {
  const host = fakeHost({ reply: () => text("fine") });
  void runWorkerSession(
    host.port,
    init(`
      const viaParallel = await parallel([
        () => { throw new Error('boom') },
        () => agent('fine'),
        () => 'plain value',
        () => { throw { name: 'WorkflowError', fatal: true, message: 'forged fatal' } },
      ])
      const viaPipeline = await pipeline([10, 20],
        (prev, item, index) => { if (item === 10) throw new Error('ordinary failure'); return 'kept-' + item + '-' + index },
      )
      return { viaParallel, viaPipeline }
    `),
  );
  const result = await host.result();
  assertEqual(result.stopReason, "completed", "stopReason is completed");
  assertDeepEqual(
    result.value,
    { viaParallel: [null, "fine", "plain value", null], viaPipeline: [null, "kept-20-1"] },
    "ordinary throws null the item; forged fatality stays null",
  );
  host.close();
});

await run("trips the total-agent cap with a message naming the config knob", async () => {
  const host = fakeHost({ reply: () => text("ok") });
  void runWorkerSession(host.port, init("await agent('1'); await agent('2'); await agent('3')", undefined, { maxTotalAgents: 2 }));
  const result = await host.result();
  assertEqual(result.stopReason, "error", "stopReason is error");
  assert((result.error ?? "").includes("total agent cap (2)"), "error names the cap");
  assert((result.error ?? "").includes("applicable maxTotalAgents limit"), "error names the config knob");
  assertEqual(result.agentsStarted, 2, "two agents were started");
  host.close();
});

await run("queued agents proceed through the concurrency semaphore in FIFO order", async () => {
  const host = fakeHost({ reply: (request) => text(`ok:${request.prompt}`) });
  void runWorkerSession(
    host.port,
    init(
      "return await parallel([1, 2, 3].map((n) => () => agent('job ' + n)))",
      undefined,
      { maxConcurrentAgents: 1 },
    ),
  );
  const result = await host.result();
  assertDeepEqual(result.value, ["ok:job 1", "ok:job 2", "ok:job 3"], "FIFO order preserved");
  host.close();
});

await run("labels default from the prompt first line, truncated; explicit label/phase options win", async () => {
  const host = fakeHost({ reply: () => text("ok") });
  void runWorkerSession(
    host.port,
    init(`
      phase('Find')
      await agent('a prompt that is quite long and will surely get truncated down to a display label\\n'
        + 'with a second line the label must not include')
      await agent('short', { label: 'named', phase: 'Custom' })
      return null
    `),
  );
  await host.result();
  const starts = host.ofType(WorkerToHostType.AgentStart).map((m) => m.info);
  assertEqual(starts[0].seq, 1, "first seq is 1");
  assertEqual(starts[0].phase, "Find", "phase defaults to the current phase");
  assert(starts[0].label.length <= 48, "default label is truncated to <= 48 chars");
  assert(!starts[0].label.includes("second line"), "default label stops at the first newline");
  assertEqual(starts[1].seq, 2, "second seq is 2");
  assertEqual(starts[1].label, "named", "explicit label wins");
  assertEqual(starts[1].phase, "Custom", "explicit phase wins");
  const childStarts = host.ofType(WorkerToHostType.ChildStart);
  assertEqual(childStarts[1]?.request.label, "named", "explicit label is forwarded on child-start");
  host.close();
});

await run("non-text output blocks are filtered out of the text result", async () => {
  const host = fakeHost({
    reply: () => ({
      output: [
        { type: "text", text: "first " },
        { type: "tool_call", id: "c1", name: "x", arguments: {} },
        { type: "text", text: "second" },
      ],
      stopReason: "completed",
    }) as unknown as ChildResult,
  });
  void runWorkerSession(host.port, init("return await agent('p')"));
  const result = await host.result();
  assertEqual(result.value, "first second", "only text blocks join");
  host.close();
});

await run("a cancel landing DURING the start round-trip disposes the fresh child and dies cancelled", async () => {
  const host = fakeHost({ manual: true });
  void runWorkerSession(host.port, init("return await agent('p')"));
  await waitFor(() => host.ofType(WorkerToHostType.ChildStart).length === 1, "child-start posted");
  const callId = host.ofType(WorkerToHostType.ChildStart)[0].callId;
  // Simulate a teardown race by delivering cancellation before a stale start reply.
  host.send({ type: HostToWorkerType.Cancel, reason: "raced the start" });
  host.send({ type: HostToWorkerType.ChildStarted, callId, childId: "child-0" });
  const result = await host.result();
  assertEqual(result.stopReason, "cancelled", "stopReason is cancelled");
  await waitFor(() => host.ofType(WorkerToHostType.ChildDispose).some((m) => m.callId === callId), "child-dispose posted");
  // The unpublished child is disposed without a lifecycle announcement.
  assertEqual(host.ofType(WorkerToHostType.AgentStart).length, 0, "no agent-start for the unpublished child");
  host.close();
});

await run("a start refusal arriving after a cancel reads as the cancellation, not a broken seam", async () => {
  const host = fakeHost({ manual: true });
  void runWorkerSession(
    host.port,
    init(`
      try { await agent('p'); return 'unreachable' } catch (e) { return { code: e.code } }
    `),
  );
  await waitFor(() => host.ofType(WorkerToHostType.ChildStart).length === 1, "child-start posted");
  const callId = host.ofType(WorkerToHostType.ChildStart)[0].callId;
  host.send({ type: HostToWorkerType.Cancel, reason: "stopping" });
  host.send({ type: HostToWorkerType.ChildStartError, callId, rendered: "workflow run cancelled: stopping" });
  const result = await host.result();
  // The run reports cancelled (the script died of CANCELLED, not AGENT_START).
  assertEqual(result.stopReason, "cancelled", "stopReason is cancelled");
  host.close();
});

await run("a child result rejection while cancelled pairs a cancelled agent-end, and the run reports cancelled", async () => {
  const host = fakeHost({ manual: true });
  void runWorkerSession(host.port, init("return await agent('doomed')"));
  await waitFor(() => host.ofType(WorkerToHostType.ChildStart).length === 1, "child-start posted");
  const callId = host.ofType(WorkerToHostType.ChildStart)[0].callId;
  host.send({ type: HostToWorkerType.ChildStarted, callId, childId: "child-0" });
  await waitFor(() => host.ofType(WorkerToHostType.AgentStart).length === 1, "agent-start posted");
  host.send({ type: HostToWorkerType.Cancel, reason: "user aborted" });
  host.send({ type: HostToWorkerType.ChildFailed, callId, rendered: "backend crashed on abort" });
  const result = await host.result();
  assertEqual(result.stopReason, "cancelled", "stopReason is cancelled");
  assertEqual(host.ofType(WorkerToHostType.AgentEnd)[0]?.info.outcome, "cancelled", "agent-end outcome is cancelled");
  host.close();
});

await run("settled() returns a tagged envelope; stats() counts failed children", async () => {
  const host = fakeHost({
    reply: () => ({
      output: [],
      stopReason: "failed",
      failureReason: "max_turns",
      error: "The agent exceeded its turn limit (12).",
    }),
  });
  void runWorkerSession(
    host.port,
    init(`
      const r = await settled('p', { label: 'audit' })
      const s = stats()
      return { r, s }
    `),
  );
  const result = await host.result();
  assertEqual(result.stopReason, "completed", "script completed");
  assertDeepEqual(
    result.value,
    {
      r: { ok: false, reason: "max_turns", message: "The agent exceeded its turn limit (12).", stopReason: "failed" },
      s: { completed: 0, failed: 1, cancelled: 0 },
    },
    "settled envelope and stats survive materialization",
  );
  assertDeepEqual(result.childStats, { completed: 0, failed: 1, cancelled: 0 }, "result childStats matches stats()");
  assertEqual(result.failures?.length, 1, "failures lists the child");
  assertEqual(result.failures?.[0]?.reason, "max_turns", "failure reason is max_turns");
  host.close();
});

await run("retry:1 restarts a retryable child failure and returns the later success", async () => {
  const host = fakeHost({
    reply: (_request, index) =>
      index === 0
        ? {
            output: [],
            stopReason: "failed",
            failureReason: "max_turns",
            error: "The agent exceeded its turn limit (12).",
          }
        : text("recovered"),
  });
  void runWorkerSession(host.port, init("return await agent('p', { retry: 1, label: 'audit' })"));
  const result = await host.result();
  assertEqual(result.value, "recovered", "retry success is the agent() value");
  assertEqual(result.agentsStarted, 2, "retry counted as a second agent start");
  assertDeepEqual(result.childStats, { completed: 1, failed: 1, cancelled: 0 }, "first attempt failed, second completed");
  assertEqual(host.ofType(WorkerToHostType.ChildStart).length, 2, "two child-starts");
  host.close();
});

await run("agent() option maxTurns is forwarded on child-start", async () => {
  const host = fakeHost({ reply: () => text("ok") });
  void runWorkerSession(host.port, init("return await agent('p', { maxTurns: 4 })"));
  const result = await host.result();
  assertEqual(result.value, "ok", "text result returned");
  assertEqual(host.ofType(WorkerToHostType.ChildStart)[0]?.request.maxTurns, 4, "maxTurns forwarded");
  host.close();
});

await run("schema children default to retry:1 and recover on the second attempt", async () => {
  const host = fakeHost({
    reply: (_request, index) =>
      index === 0
        ? text("prose, no structure")
        : { output: [], structured: { status: "ok" }, stopReason: "completed" },
  });
  void runWorkerSession(
    host.port,
    init("return await agent('p', { schema: { type: 'object', properties: { status: { type: 'string' } } } })"),
  );
  const result = await host.result();
  assertDeepEqual(result.value, { status: "ok" }, "default schema retry returned the second structured value");
  assertEqual(result.agentsStarted, 2, "default schema retry started a second child");
  assertDeepEqual(result.childStats, { completed: 1, failed: 1, cancelled: 0 }, "first attempt failed, second completed");
  host.close();
});

await run("pipeline({retry:1}) re-runs only null items", async () => {
  const host = fakeHost();
  void runWorkerSession(
    host.port,
    init(`
      let b = 0
      const out = await pipeline(['a', 'b'], (prev, item) => {
        if (item === 'b') {
          b++
          return b >= 2 ? 'ok' : null
        }
        return item
      }, { retry: 1 })
      return { out, b }
    `),
  );
  const result = await host.result();
  assertDeepEqual(result.value, { out: ["a", "ok"], b: 2 }, "only the null item was retried");
  host.close();
});

await run("parallel({retry:1}) re-runs only null thunks", async () => {
  const host = fakeHost();
  void runWorkerSession(
    host.port,
    init(`
      let n = 0
      const out = await parallel([
        () => 'keep',
        () => { n++; return n >= 2 ? 'recovered' : null },
      ], { retry: 1 })
      return { out, n }
    `),
  );
  const result = await host.result();
  assertDeepEqual(result.value, { out: ["keep", "recovered"], n: 2 }, "only the null thunk was retried");
  host.close();
});

await run("FakeChildPort prompt_too_large failed: settled carries bytes, guidance, and no put(/ref(", async () => {
  const prompt = "x".repeat(70000);
  const bytes = new TextEncoder().encode(prompt).length;
  const hostError = "The delegated prompt exceeds 65536 bytes.";
  const host = fakeHost({
    reply: () => ({
      output: [],
      stopReason: "failed",
      failureReason: "prompt_too_large",
      error: hostError,
    }),
  });
  void runWorkerSession(
    host.port,
    init(`return await settled(${JSON.stringify(prompt)}, { label: 'synthesize' })`),
  );
  const result = await host.result();
  assertEqual(result.stopReason, "completed", "script completed with a settled fail");
  const settled = result.value as {
    ok: boolean;
    reason: string;
    message: string;
    stopReason: string;
    bytes?: number;
  };
  assertEqual(settled.ok, false, "settled.ok is false");
  assertEqual(settled.reason, "prompt_too_large", "settled.reason is prompt_too_large");
  assertEqual(settled.stopReason, "failed", "settled.stopReason is failed");
  assertEqual(settled.bytes, bytes, "settled.bytes is the utf8 prompt length");
  assert(
    settled.message.includes(hostError) && settled.message.includes(`Prompt is ${bytes} bytes.`),
    "message keeps the host error and adds the byte count",
  );
  assert(
    settled.message.includes("Shrink the schema or aggregate in JS; do not inline full child reports."),
    "message includes the guidance sentence",
  );
  assert(!settled.message.includes("put(") && !settled.message.includes("ref("), "message has no put( or ref(");
  assertEqual(host.ofType(WorkerToHostType.ChildStart).length, 1, "oversized still spawned (no runtime precheck)");
  assertEqual(result.failures?.length, 1, "failures lists the oversized child");
  assertEqual(result.failures?.[0]?.reason, "prompt_too_large", "failures reason is prompt_too_large");
  assertEqual(result.failures?.[0]?.message, settled.message, "failures message is the augmented guidance");
  host.close();
});

await run("empty prompt is INVALID_ARGUMENT with no slot and no spawn", async () => {
  const host = fakeHost({ reply: () => text("should not spawn") });
  void runWorkerSession(host.port, init("return await agent('')"));
  const result = await host.result();
  assertEqual(result.stopReason, "error", "stopReason is error");
  assert((result.error ?? "").includes("non-empty prompt string"), "error names the empty prompt");
  assertEqual(host.ofType(WorkerToHostType.ChildStart).length, 0, "empty prompt does not spawn");
  assertEqual(result.agentsStarted, 0, "empty prompt does not take a slot");
  host.close();
});

await run("whitespace-only prompt still spawns (worker does not trim)", async () => {
  const host = fakeHost({ reply: () => text("ok") });
  void runWorkerSession(host.port, init("return await agent(' ')"));
  const result = await host.result();
  assertEqual(result.stopReason, "completed", "whitespace prompt is not INVALID_ARGUMENT");
  assertEqual(result.value, "ok", "whitespace prompt spawned and completed");
  assertEqual(host.ofType(WorkerToHostType.ChildStart).length, 1, "whitespace-only still spawns");
  host.close();
});

await run("return {a:undefined} completes and logs omitted undefined fields", async () => {
  const host = fakeHost();
  void runWorkerSession(host.port, init("return { a: undefined }"));
  const result = await host.result();
  assertEqual(result.stopReason, "completed", "stopReason is completed");
  assertDeepEqual(result.value, {}, "undefined field is omitted from the result");
  const logs = host.ofType(WorkerToHostType.Log).map((m) => m.message);
  assert(logs.some((line) => line.includes("omitted 1 undefined fields")), "omitted log is emitted");
  host.close();
});

await run("root undefined still becomes null and is not omitted", async () => {
  const host = fakeHost();
  void runWorkerSession(host.port, init("return undefined"));
  const result = await host.result();
  assertEqual(result.stopReason, "completed", "stopReason is completed");
  assertEqual(result.value, null, "root undefined becomes null");
  assert(
    !host.ofType(WorkerToHostType.Log).some((m) => m.message.includes("omitted")),
    "root undefined is not counted as omitted",
  );
  host.close();
});

await run("cache:false does not lookup or store", async () => {
  const host = fakeHost({ reply: () => text("fresh") });
  void runWorkerSession(host.port, init("return await agent('p', { cache: false, label: 'review' })"));
  const result = await host.result();
  assertEqual(result.value, "fresh", "cache:false still runs the child");
  assertEqual(host.ofType(WorkerToHostType.CacheLookup).length, 0, "cache:false does not lookup");
  assertEqual(host.ofType(WorkerToHostType.CacheStore).length, 0, "cache:false does not store");
  assertEqual(host.ofType(WorkerToHostType.ChildStart).length, 1, "cache:false still spawns");
  assertEqual(result.agentsStarted, 1, "cache:false counts as a real start");
  assertEqual(result.childStats?.replayed, undefined, "cache:false does not set replayed");
  host.close();
});

await run("cache hit does not started++ and has no agent-start/end", async () => {
  const host = fakeHost({
    reply: () => text("should not spawn"),
    cacheLookup: () => ({ hit: true, value: "cached-text", childId: "tsk_auth" }),
  });
  void runWorkerSession(
    host.port,
    init(`
      const v = await agent('review the file', { label: 'review:auth' })
      const s = stats()
      return { v, s }
    `),
  );
  const result = await host.result();
  assertEqual(result.stopReason, "completed", "hit run completed");
  assertDeepEqual(result.value, { v: "cached-text", s: { completed: 0, failed: 0, cancelled: 0, replayed: 1 } }, "hit value and stats.replayed");
  assertEqual(result.agentsStarted, 0, "hit does not started++");
  assertEqual(result.childStats?.replayed, 1, "result childStats.replayed is 1");
  assertDeepEqual(result.sources, [{ label: "review:auth", childId: "tsk_auth" }], "hit records the cached childId as a source");
  assertEqual(host.ofType(WorkerToHostType.ChildStart).length, 0, "hit does not spawn");
  assertEqual(host.ofType(WorkerToHostType.AgentStart).length, 0, "hit has no agent-start");
  assertEqual(host.ofType(WorkerToHostType.AgentEnd).length, 0, "hit has no agent-end");
  assertEqual(host.ofType(WorkerToHostType.CacheStore).length, 0, "hit does not store again");
  const logs = host.ofType(WorkerToHostType.Log).map((m) => m.message);
  assert(logs.includes("cache hit: review:auth"), "hit logs cache hit: <label>");
  host.close();
});

await run("cache hit without childId omits that source", async () => {
  const host = fakeHost({
    reply: () => text("should not spawn"),
    cacheLookup: () => ({ hit: true, value: "cached-text" }),
  });
  void runWorkerSession(host.port, init("return await agent('review the file', { label: 'review:auth' })"));
  const result = await host.result();
  assertEqual(result.value, "cached-text", "legacy hit still returns the value");
  assertEqual(result.sources, undefined, "legacy hit without childId does not invent a source");
  host.close();
});

await run("schema cache hit that is not an object is treated as a miss", async () => {
  const host = fakeHost({
    reply: () => ({ output: [], structured: { ok: true }, stopReason: "completed" }),
    cacheLookup: () => ({ hit: true, value: "not-an-object" }),
  });
  void runWorkerSession(
    host.port,
    init("return await agent('p', { schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, retry: 0 })"),
  );
  const result = await host.result();
  assertDeepEqual(result.value, { ok: true }, "non-object schema hit falls through to spawn");
  assertEqual(host.ofType(WorkerToHostType.ChildStart).length, 1, "non-object schema hit is a miss");
  assertEqual(result.agentsStarted, 1, "miss after bad hit still started++");
  assertEqual(result.childStats?.replayed, undefined, "bad schema hit is not replayed");
  host.close();
});

await run("successful store does not block the agent() return", async () => {
  const host = fakeHost({ reply: () => text("ok"), holdStore: true });
  void runWorkerSession(host.port, init("return await agent('p', { label: 'review' })"));
  const result = await host.result();
  assertEqual(result.stopReason, "completed", "run completed without a store ack");
  assertEqual(result.value, "ok", "value returned before store ack");
  assertEqual(host.ofType(WorkerToHostType.CacheStore).length, 1, "store was posted");
  assertDeepEqual(result.sources, [{ label: "review", childId: "child-0" }], "spawn records the childId as a source");
  host.close();
});

await run("fail and null do not store; oversized value skips with a log", async () => {
  const tooBig = "x".repeat(256 * 1024);
  let index = 0;
  const host = fakeHost({
    reply: () => {
      const n = index;
      index += 1;
      if (n === 0) {
        return { output: [], stopReason: "failed", failureReason: "max_turns", error: "turns" };
      }
      if (n === 1) {
        return { output: [{ type: "text", text: tooBig }], stopReason: "completed" };
      }
      return text("small");
    },
  });
  void runWorkerSession(
    host.port,
    init(`
      const failed = await agent('fail me', { label: 'fail', retry: 0 })
      const skipped = await agent('big', { label: 'synth' })
      const stored = await agent('ok', { label: 'ok' })
      return { failed, skippedLen: skipped.length, stored }
    `),
  );
  const result = await host.result();
  assertEqual(result.stopReason, "completed", "script completed");
  assertDeepEqual(
    result.value,
    { failed: null, skippedLen: tooBig.length, stored: "small" },
    "fail is null; oversized still succeeds; small stores",
  );
  const stores = host.ofType(WorkerToHostType.CacheStore);
  assertEqual(stores.length, 1, "only the small success stores");
  assertEqual(stores[0]?.value, "small", "store value is the agent() return");
  assertEqual(stores[0]?.childId, "child-2", "store carries the spawn taskId");
  const logs = host.ofType(WorkerToHostType.Log).map((m) => m.message);
  assert(logs.includes("cache skip: synth exceeds 256KiB"), "oversized logs cache skip: <label> exceeds 256KiB");
  host.close();
});

await run("put/get/ref round-trip and agent({artifacts}) forwards payload on child-start", async () => {
  const host = fakeHost({ reply: () => text("ok") });
  void runWorkerSession(
    host.port,
    init(`
      const handle = put('reviews', { n: 2, items: ['a', 'b'] })
      const viaGet = get('reviews')
      const viaRef = ref('reviews')
      const missing = get('absent')
      const out = await agent('synthesize', { artifacts: [handle], cache: false })
      return { handle, viaGet, viaRef, missing, out }
    `),
  );
  const result = await host.result();
  assertEqual(result.stopReason, "completed", "stopReason is completed");
  assertDeepEqual(
    result.value,
    {
      handle: { name: "reviews" },
      viaGet: { n: 2, items: ["a", "b"] },
      viaRef: { name: "reviews" },
      missing: null,
      out: "ok",
    },
    "put/get/ref values materialize",
  );
  const start = host.ofType(WorkerToHostType.ChildStart)[0];
  assert(start !== undefined, "a child-start was posted");
  assertDeepEqual(
    start.request.artifacts,
    [{ name: "reviews", value: { n: 2, items: ["a", "b"] } }],
    "ChildStart carries materialized artifact payloads",
  );
  host.close();
});

await run("illegal artifact names are INVALID_ARGUMENT fatal", async () => {
  const cases: Array<[string, string]> = [
    ["put('.', 1)", "legal artifact name"],
    ["put('..', 1)", "legal artifact name"],
    ["put('a/b', 1)", "legal artifact name"],
    ["put('', 1)", "legal artifact name"],
    ["put('has space', 1)", "legal artifact name"],
    ["get('/')", "legal artifact name"],
    ["ref('..')", "legal artifact name"],
  ];
  for (const [body, expected] of cases) {
    const host = fakeHost({ reply: () => text("should not spawn") });
    void runWorkerSession(host.port, init(body));
    const result = await host.result();
    assertEqual(result.stopReason, "error", `${body} -> error`);
    assert((result.error ?? "").includes(expected), `${body} -> error contains ${JSON.stringify(expected)}`);
    assertEqual(host.ofType(WorkerToHostType.ChildStart).length, 0, `${body} does not spawn`);
    host.close();
  }
});

await run("put 257th distinct name is INVALID_ARGUMENT fatal", async () => {
  const host = fakeHost();
  void runWorkerSession(
    host.port,
    init(`
      for (let i = 0; i < 256; i++) put('n' + i, i)
      put('n256', 256)
    `),
  );
  const result = await host.result();
  assertEqual(result.stopReason, "error", "257th put is fatal");
  assert((result.error ?? "").includes("artifact count"), "error names the object-count cap");
  host.close();
});

await run("put over 8MiB is INVALID_ARGUMENT fatal", async () => {
  const host = fakeHost();
  void runWorkerSession(
    host.port,
    init(`
      put('keep', 'ok')
      put('blob', 'x'.repeat(8 * 1024 * 1024 - 16))
      put('blob', 'y'.repeat(8 * 1024 * 1024))
    `),
  );
  const result = await host.result();
  assertEqual(result.stopReason, "error", "over-8MiB put is fatal");
  assert((result.error ?? "").includes("artifact store"), "error names the 8MiB store cap");
  host.close();
});

await run("same-name overwrite uses delta so shrinking stays under 8MiB", async () => {
  const host = fakeHost();
  void runWorkerSession(
    host.port,
    init(`
      put('blob', 'x'.repeat(5 * 1024 * 1024))
      const afterShrink = put('blob', 'y')
      return { name: afterShrink.name, value: get('blob') }
    `),
  );
  const result = await host.result();
  assertEqual(result.stopReason, "completed", "delta overwrite does not trip the 8MiB cap");
  assertDeepEqual(result.value, { name: "blob", value: "y" }, "overwrite replaced the stored value");
  host.close();
});

await run("artifact render over 1MiB is INVALID_ARGUMENT and does not ChildStart", async () => {
  const host = fakeHost({ reply: () => text("should not spawn") });
  void runWorkerSession(
    host.port,
    init(`
      const handle = put('reviews', 'x'.repeat(1024 * 1024))
      return await agent('synthesize', { artifacts: [handle], cache: false })
    `),
  );
  const result = await host.result();
  assertEqual(result.stopReason, "error", "oversized render is fatal");
  assert((result.error ?? "").includes("artifacts render exceeds"), "error names the 1MiB inject cap");
  assertEqual(host.ofType(WorkerToHostType.ChildStart).length, 0, "render over 1MiB does not ChildStart");
  assertEqual(result.agentsStarted, 0, "render over 1MiB does not started++");
  host.close();
});

await run("the worker bootstrap: requireParentPort narrows a real port and throws on the main thread", async () => {
  const channel = new MessageChannel();
  assertEqual(requireParentPort(channel.port1), channel.port1, "a real port passes through");
  channel.port1.close();
  channel.port2.close();
  let threw = false;
  try {
    requireParentPort(null);
  } catch (error) {
    threw = true;
    assert((error as Error).message.includes("inside a worker thread"), "message names the missing worker");
  }
  assert(threw, "null parentPort throws");
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
