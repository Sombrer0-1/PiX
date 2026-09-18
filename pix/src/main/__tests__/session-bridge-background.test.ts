/**
 * SessionBridge background-liveness tests (Stage B, SDD §4.6).
 *
 * Constructs the REAL SessionBridge directly (never ipc-handlers/preload)
 * against a temp agent dir and verifies the session-parallelism contract:
 * a busy session detached on switch/new/fork keeps running in the background
 * (no dispose, no abort), background events never reach the forwarding
 * listeners, idle runs auto-finalize with the full close sequence,
 * waiting_input blocks finalize, switching back re-attaches the same
 * AgentSession instance (usage alias re-bound, suspended user input re-sent,
 * event forwarding resumed), the running cap evicts the oldest background
 * session, bridge dispose closes every background session, the delivery sink
 * keeps delivering to a backgrounded session, and switch-to-self is a no-op.
 *
 * Run with: npx tsx src/main/__tests__/session-bridge-background.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { AgentSession, SessionManager, type RequestUserInputRequest } from "@earendil-works/pi-coding-agent";
import type { ProjectLocation, RequestUserInputDismissal } from "../../shared/types.js";
import type { AgentSessionEvent, SessionsStatePayload } from "../../shared/types.js";
import { AgentTaskStore } from "../agent-task/agent-task-store.js";
import { AgentTaskService, __setAgentTaskServiceHooksForTests } from "../agent-task/agent-task-service.js";
import type { AgentTaskRuntime } from "../agent-task/agent-task-runtime.js";
import type { ProductEventCollector } from "../product-event-collector.js";
import { SettingsStore } from "../settings-store.js";
import type { SubagentExecutionContext } from "../subagent/types.js";
import type { SubagentRunner } from "../subagent/subagent-runner.js";
import type { PlanController } from "../plan/plan-controller.js";
import { SessionBridge } from "../session-bridge.js";

// ============================================================================
// Test harness (matches session-bridge-subagent.test.ts style)
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

function drain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Poll for a condition without relying on real timeouts. */
async function waitFor(condition: () => boolean, iterations = 20000, message = "condition"): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    if (condition()) {
      return;
    }
    await drain();
  }
  throw new Error(`Timed out waiting for ${message}`);
}

// ============================================================================
// Shared temp environment (agentDir + per-test project cwds)
// ============================================================================

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pix-bg-agent-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const MODELS_JSON = {
  providers: {
    faux: {
      baseUrl: "http://localhost:1",
      api: "faux-api",
      apiKey: "faux-key",
      models: [
        {
          id: "faux-model",
          name: "Faux Model",
          reasoning: true,
          input: ["text"],
          cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
          contextWindow: 100000,
          maxTokens: 4096,
          thinkingLevelMap: { off: null, low: "low", high: "high" },
        },
      ],
    },
  },
};

writeFileSync(join(AGENT_DIR, "models.json"), JSON.stringify(MODELS_JSON, null, 2), "utf-8");

function tempCwd(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeLocation(cwd: string): ProjectLocation {
  return {
    path: cwd,
    physicalPath: cwd,
    name: basename(cwd),
    environment: { kind: "windows" },
  };
}

/** Persist one seeded session file into the cwd's default session namespace. */
function makeSessionFile(cwd: string, seed: string): string {
  const manager = SessionManager.create(cwd);
  manager.appendModelChange("faux", "faux-model");
  manager.appendMessage({ role: "user", content: `seed ${seed}`, timestamp: Date.now() });
  const file = manager.getSessionFile();
  if (!file) {
    throw new Error(`seed session file missing for ${seed}`);
  }
  return file;
}

// ============================================================================
// Private surface access (same cast convention as session-bridge-subagent)
// ============================================================================

interface AuxiliaryTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface UserInputEntryAccess {
  request: RequestUserInputRequest;
  state: "queued" | "active" | "terminal";
}

interface UserInputStateAccess {
  queue: UserInputEntryAccess[];
  activeEntry: UserInputEntryAccess | null;
  queueClosing: boolean;
}

interface GenerationAccess {
  genId: number;
  auxiliaryUsage: AuxiliaryTotals;
  session: AgentSession | null;
  runner: SubagentRunner;
  planController: PlanController;
}

interface BackgroundRecordAccess {
  path: string;
  session: AgentSession;
  state: "running" | "waiting_input";
  pendingCount: number;
  finalizeScheduled: boolean;
  userInput: UserInputStateAccess;
  eyeUsage: AuxiliaryTotals;
}

interface BridgeAccess {
  _session: AgentSession | null;
  _generation: GenerationAccess | null;
  _backgroundSessions: Map<string, BackgroundRecordAccess>;
  _auxiliaryUsage: AuxiliaryTotals;
}

function accessBridge(bridge: SessionBridge): BridgeAccess {
  return bridge as unknown as BridgeAccess;
}

interface RunnerAccess {
  _ctx: SubagentExecutionContext;
}

function accessRunnerCtx(runner: SubagentRunner): SubagentExecutionContext {
  return (runner as unknown as RunnerAccess)._ctx;
}

// ============================================================================
// Session prototype instrumentation: live subscription capture + dispose trace
// ============================================================================

type CapturedListener = (event: AgentSessionEvent) => void;
const sessionListeners = new Map<AgentSession, CapturedListener[]>();
const disposedSessions: AgentSession[] = [];

/** Emit a synthetic event to every LIVE subscription of one session. */
function emitSessionEvent(session: AgentSession, event: AgentSessionEvent): void {
  for (const listener of sessionListeners.get(session) ?? []) {
    listener(event);
  }
}

{
  const origSubscribe = AgentSession.prototype.subscribe;
  const patchedSubscribe = function (this: AgentSession, listener: Parameters<typeof origSubscribe>[0]): () => void {
    let list = sessionListeners.get(this);
    if (list === undefined) {
      list = [];
      sessionListeners.set(this, list);
    }
    const captured = listener as unknown as CapturedListener;
    list.push(captured);
    const unsubscribe = origSubscribe.call(this, listener);
    return () => {
      const index = list.indexOf(captured);
      if (index !== -1) {
        list.splice(index, 1);
      }
      unsubscribe();
    };
  };
  (AgentSession.prototype as unknown as { subscribe: typeof patchedSubscribe }).subscribe = patchedSubscribe;

  const origDispose = AgentSession.prototype.dispose;
  const patchedDispose = function (this: AgentSession, ...args: Parameters<typeof origDispose>): Promise<void> {
    disposedSessions.push(this);
    return origDispose.call(this, ...args);
  };
  (AgentSession.prototype as unknown as { dispose: typeof patchedDispose }).dispose = patchedDispose;
}

function isDisposed(session: AgentSession): boolean {
  return disposedSessions.includes(session);
}

/** Shadow the prototype isStreaming getter (restorable via restoreStreaming). */
function forceStreaming(session: AgentSession, value: boolean): void {
  Object.defineProperty(session, "isStreaming", { get: () => value, configurable: true });
}

function restoreStreaming(session: AgentSession): void {
  delete (session as { isStreaming?: boolean }).isStreaming;
}

// ============================================================================
// Faux app-level AgentTaskService (delivery-sink case)
// ============================================================================

const unhandledRejections: unknown[] = [];
process.on("unhandledRejection", (reason: unknown) => {
  unhandledRejections.push(reason);
});

function assertNoUnhandledRejections(): void {
  assertEqual(unhandledRejections.length, 0, "no unhandled rejections observed");
  unhandledRejections.length = 0;
}

function makeTaskService(): AgentTaskService {
  const cwd = mkdtempSync(join(tmpdir(), "pix-bg-task-service-"));
  const settings = new SettingsStore({ cwd });
  const events = { record: () => {} } as unknown as ProductEventCollector;
  const store = new AgentTaskStore({
    rootDir: mkdtempSync(join(tmpdir(), "pix-bg-task-store-")),
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  return new AgentTaskService({ settings, events, store, runId: "bg-run" });
}

/** Never-settling runtime so a foreground task keeps its delivery alive. */
class NeverSettlingRuntime {
  readonly spec: unknown;
  constructor(spec: unknown) {
    this.spec = spec;
  }
  run(): Promise<never> {
    return new Promise(() => {});
  }
  abort(): void {}
  dispose(): Promise<void> {
    return Promise.resolve();
  }
  resolveInput(): boolean {
    return true;
  }
  cancelInput(): boolean {
    return true;
  }
}

function installNeverSettlingRuntimeHooks(): () => void {
  return __setAgentTaskServiceHooksForTests({
    autoBackgroundMsOverride: 0,
    runtimeFactory: (spec) => new NeverSettlingRuntime(spec) as unknown as AgentTaskRuntime,
  });
}

// ============================================================================
// Shared scenario helpers
// ============================================================================

/**
 * Start a bridge whose active session is a persisted anchor. The anchor is the
 * ONLY file in the namespace at start time (continueRecent deterministically
 * resumes it); every switch target is created AFTER start so it can never be
 * the resumed session (which would turn the switch into a self-switch).
 */
async function startBridge(cwd: string, options: { agentTaskService?: AgentTaskService } = {}): Promise<SessionBridge> {
  makeSessionFile(cwd, "anchor");
  const bridge = new SessionBridge(options.agentTaskService ? { agentTaskService: options.agentTaskService } : {});
  await bridge.start(makeLocation(cwd));
  const session = accessBridge(bridge)._session;
  if (!session?.sessionFile) {
    throw new Error("bridge active session is not persisted");
  }
  return bridge;
}

interface BroadcastLog {
  payloads: SessionsStatePayload[];
  off: () => void;
}

function recordBroadcasts(bridge: SessionBridge): BroadcastLog {
  const payloads: SessionsStatePayload[] = [];
  const off = bridge.onSessionsState((payload) => {
    payloads.push(payload);
  });
  return { payloads, off };
}

// ============================================================================
// Tests
// ============================================================================

await run("busy switchSession: session alive in background, broadcast, session_backgrounded dismissal", async () => {
  const cwd = tempCwd("pix-bg-switch-");
  try {
    const bridge = await startBridge(cwd);
    const other = makeSessionFile(cwd, "other");
    const b = accessBridge(bridge);
    const sessionA = b._session!;
    const pathA = resolve(sessionA.sessionFile!);

    const broadcasts = recordBroadcasts(bridge);
    const requests: RequestUserInputRequest[] = [];
    const dismissals: RequestUserInputDismissal[] = [];
    bridge.onUserInputRequest((request) => requests.push(request));
    bridge.onUserInputDismissed((dismissal) => dismissals.push(dismissal));

    // One displayed request through the runner-closure FIFO (generation-bound).
    const runnerCtx = accessRunnerCtx(b._generation!.runner);
    const inputPromise = runnerCtx
      .requestUserInput({ id: "bg-req-1", questions: [{ id: "q", header: "H", question: "Q" }] }, undefined)
      .catch(() => {});
    await waitFor(() => requests.length === 1, 20000, "request displayed");

    forceStreaming(sessionA, true);
    await bridge.switchSession(other);

    assert(!isDisposed(sessionA), "detached busy session is NOT disposed");
    assert(b._session !== null && b._session !== sessionA, "a fresh session is active after the switch");
    assertEqual(b._backgroundSessions.size, 1, "background map gained the detached session");
    const record = b._backgroundSessions.get(pathA)!;
    assert(record !== undefined, "background record keyed by the resolved session path");
    assertEqual(record.state, "waiting_input", "record state is waiting_input while a request is suspended");
    assertEqual(record.session, sessionA, "record holds the original AgentSession instance");
    assert(
      broadcasts.payloads.some((payload) => payload.sessions.some((info) => info.path === pathA && info.state === "waiting_input")),
      "sessions-state broadcast contains the detached path",
    );
    assertEqual(dismissals.length, 1, "the displayed request got exactly one dismissal");
    assertEqual(dismissals[0]!.id, "bg-req-1", "dismissal targets the displayed request id");
    assertEqual(dismissals[0]!.reason, "session_backgrounded", "dismissal reason is session_backgrounded");
    assertEqual(record.userInput.activeEntry?.request.id, "bg-req-1", "bridge-side entry stays suspended (not settled)");

    broadcasts.off();
    await bridge.dispose();
    // The suspended request settles via the close (rejection already observed
    // by the chained catch above); nothing is left dangling.
    await inputPromise;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  assertNoUnhandledRejections();
});

await run("background events never reach the forwarding listeners", async () => {
  const cwd = tempCwd("pix-bg-events-");
  try {
    const bridge = await startBridge(cwd);
    const other = makeSessionFile(cwd, "other");
    const b = accessBridge(bridge);
    const sessionA = b._session!;

    forceStreaming(sessionA, true);
    await bridge.switchSession(other);
    const active = b._session!;

    const received: AgentSessionEvent[] = [];
    bridge.onEvent((event) => received.push(event));

    emitSessionEvent(sessionA, { type: "agent_start" });
    emitSessionEvent(sessionA, { type: "queue_update", steering: ["queued"], followUp: [] });
    await drain();
    assertEqual(received.length, 0, "backgrounded session events are not forwarded");

    emitSessionEvent(active, { type: "agent_start" });
    await drain();
    assertEqual(received.length, 1, "active session events are still forwarded");

    await bridge.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  assertNoUnhandledRejections();
});

await run("background agent_end with an empty queue auto-finalizes (full close + broadcast removal)", async () => {
  const cwd = tempCwd("pix-bg-finalize-");
  try {
    const bridge = await startBridge(cwd);
    const other = makeSessionFile(cwd, "other");
    const b = accessBridge(bridge);
    const sessionA = b._session!;
    const pathA = resolve(sessionA.sessionFile!);

    const broadcasts = recordBroadcasts(bridge);
    forceStreaming(sessionA, true);
    await bridge.switchSession(other);

    // The run "finishes": not streaming, nothing queued.
    restoreStreaming(sessionA);
    emitSessionEvent(sessionA, { type: "agent_end", messages: [], willRetry: false });
    await waitFor(() => isDisposed(sessionA), 20000, "background session disposed by auto-finalize");

    assertEqual(b._backgroundSessions.size, 0, "record removed from the background map");
    assert(
      broadcasts.payloads[broadcasts.payloads.length - 1]!.sessions.every((info) => info.path !== pathA),
      "final broadcast no longer lists the finalized path",
    );
    broadcasts.off();
    await bridge.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  assertNoUnhandledRejections();
});

await run("background agent_end with a suspended request does NOT finalize; state stays waiting_input", async () => {
  const cwd = tempCwd("pix-bg-waiting-");
  try {
    const bridge = await startBridge(cwd);
    const other = makeSessionFile(cwd, "other");
    const b = accessBridge(bridge);
    const sessionA = b._session!;
    const pathA = resolve(sessionA.sessionFile!);

    const requests: RequestUserInputRequest[] = [];
    bridge.onUserInputRequest((request) => requests.push(request));
    const runnerCtx = accessRunnerCtx(b._generation!.runner);
    const inputPromise = runnerCtx
      .requestUserInput({ id: "bg-req-2", questions: [{ id: "q", header: "H", question: "Q" }] }, undefined)
      .catch(() => {});
    await waitFor(() => requests.length === 1, 20000, "request displayed");

    forceStreaming(sessionA, true);
    await bridge.switchSession(other);
    restoreStreaming(sessionA);

    emitSessionEvent(sessionA, { type: "agent_end", messages: [], willRetry: false });
    for (let i = 0; i < 10; i++) {
      await drain();
    }
    assert(!isDisposed(sessionA), "waiting_input background session is not finalized");
    const record = b._backgroundSessions.get(pathA)!;
    assert(record !== undefined, "record still in the background map");
    assertEqual(record.state, "waiting_input", "state remains waiting_input");

    await bridge.dispose();
    await inputPromise;
    assert(isDisposed(sessionA), "bridge dispose still closes the waiting session");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  assertNoUnhandledRejections();
});

await run("switching back re-attaches the same instance: usage alias, user-input re-send, events resume", async () => {
  const cwd = tempCwd("pix-bg-attach-");
  try {
    const bridge = await startBridge(cwd);
    const other = makeSessionFile(cwd, "other");
    const b = accessBridge(bridge);
    const sessionA = b._session!;
    const pathA = resolve(sessionA.sessionFile!);
    const genA = b._generation!;

    const requests: RequestUserInputRequest[] = [];
    bridge.onUserInputRequest((request) => requests.push(request));
    const runnerCtx = accessRunnerCtx(genA.runner);
    const inputPromise = runnerCtx
      .requestUserInput({ id: "bg-req-3", questions: [{ id: "q", header: "H", question: "Q" }] }, undefined)
      .catch(() => {});
    await waitFor(() => requests.length === 1, 20000, "request displayed before detach");

    forceStreaming(sessionA, true);
    await bridge.switchSession(other);
    assertEqual(b._backgroundSessions.size, 1, "detached to background");

    // Background subagent usage keeps accumulating into the generation object.
    accessRunnerCtx(genA.runner).recordAuxiliaryUsage({
      input: 11,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 11,
      cost: 0,
      turns: 0,
    });
    assertEqual(genA.auxiliaryUsage.input, 11, "background usage lands in the detached generation accumulator");

    const events: AgentSessionEvent[] = [];
    const offEvents = bridge.onEvent((event) => events.push(event));

    await bridge.switchSession(pathA);
    assertEqual(b._session, sessionA, "re-attach reuses the SAME AgentSession instance");
    assertEqual(b._generation, genA, "re-attach restores the same runtime generation");
    assertEqual(b._backgroundSessions.size, 0, "record removed from the map on attach");
    assert(b._auxiliaryUsage === genA.auxiliaryUsage, "bridge _auxiliaryUsage re-aliases the generation accumulator");
    assertEqual(b._auxiliaryUsage.input, 11, "no second accumulation happened at attach");

    // D3.3: the suspended request is re-sent exactly once.
    await waitFor(() => requests.length === 2, 20000, "suspended request re-sent");
    assertEqual(requests[1]!.id, "bg-req-3", "re-sent request is the suspended one");
    assertEqual(bridge.getActiveUserInputRequest()?.id, "bg-req-3", "active snapshot exposes the re-sent request");
    assertEqual(bridge.respondUserInput({ id: "bg-req-3", answers: { q: "yes" } }), true, "response settles after re-attach");
    await inputPromise.catch(() => {});

    // Forwarding resumed: an event on the re-attached session reaches listeners.
    emitSessionEvent(sessionA, { type: "queue_update", steering: [], followUp: [] });
    await drain();
    assertEqual(events.length, 1, "events from the re-attached session are forwarded again");

    offEvents();
    await bridge.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  assertNoUnhandledRejections();
});

await run("busy newSession and fork detach instead of closing", async () => {
  const cwd = tempCwd("pix-bg-newfork-");
  try {
    // newSession
    {
      const bridge = await startBridge(cwd);
      const b = accessBridge(bridge);
      const sessionA = b._session!;
      const pathA = resolve(sessionA.sessionFile!);
      forceStreaming(sessionA, true);
      await bridge.newSession();
      assert(!isDisposed(sessionA), "busy newSession does not dispose the previous session");
      assert(b._backgroundSessions.get(pathA) !== undefined, "busy newSession backgrounds the previous session");
      restoreStreaming(sessionA);
      await bridge.dispose();
    }
    // fork
    {
      const bridge = await startBridge(cwd);
      const b = accessBridge(bridge);
      const sessionB = b._session!;
      const pathB = resolve(sessionB.sessionFile!);
      const userMessages = await bridge.getUserMessagesForForking();
      assert(userMessages.length > 0, "persisted seed session has a forking message");
      forceStreaming(sessionB, true);
      await bridge.fork(userMessages[0]!.entryId, "before");
      assert(!isDisposed(sessionB), "busy fork does not dispose the forked-away session");
      assert(b._backgroundSessions.get(pathB) !== undefined, "busy fork backgrounds the forked-away session");
      restoreStreaming(sessionB);
      await bridge.dispose();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  assertNoUnhandledRejections();
});

await run("dispose() closes every background session", async () => {
  const cwd = tempCwd("pix-bg-dispose-");
  try {
    const bridge = await startBridge(cwd);
    const t1 = makeSessionFile(cwd, "d1");
    const b = accessBridge(bridge);
    const sessionA = b._session!;
    const pathA = resolve(sessionA.sessionFile!);

    forceStreaming(sessionA, true);
    await bridge.switchSession(t1);
    const sessionB = b._session!;
    forceStreaming(sessionB, true);
    await bridge.newSession();
    assertEqual(b._backgroundSessions.size, 2, "two sessions backgrounded");
    restoreStreaming(sessionA);
    restoreStreaming(sessionB);

    await bridge.dispose();
    assert(isDisposed(sessionA), "first background session closed by dispose");
    assert(isDisposed(sessionB), "second background session closed by dispose");
    assertEqual(b._backgroundSessions.size, 0, "background map empty after dispose");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  assertNoUnhandledRejections();
});

await run("background new user-input stays off the renderer IPC and pumps on re-attach", async () => {
  const cwd = tempCwd("pix-bg-input-");
  try {
    const bridge = await startBridge(cwd);
    const other = makeSessionFile(cwd, "other");
    const b = accessBridge(bridge);
    const sessionA = b._session!;
    const pathA = resolve(sessionA.sessionFile!);
    const genA = b._generation!;

    forceStreaming(sessionA, true);
    await bridge.switchSession(other);
    restoreStreaming(sessionA);

    const requests: RequestUserInputRequest[] = [];
    bridge.onUserInputRequest((request) => requests.push(request));
    const runnerCtx = accessRunnerCtx(genA.runner);
    const inputPromise = runnerCtx
      .requestUserInput({ id: "bg-req-4", questions: [{ id: "q", header: "H", question: "Q" }] }, undefined)
      .catch(() => {});
    await drain();
    await drain();

    assertEqual(requests.length, 0, "background request is not emitted to the renderer");
    const record = b._backgroundSessions.get(pathA)!;
    assertEqual(record.userInput.queue.length, 1, "background request stays queued in its own state");
    assertEqual(record.state, "waiting_input", "record transitioned to waiting_input");

    // Re-attach: the FIFO pumps the queued head now that the state is active.
    await bridge.switchSession(pathA);
    await waitFor(() => requests.length === 1, 20000, "queued request pumped after re-attach");
    assertEqual(requests[0]!.id, "bg-req-4", "pumped request is the queued one");
    assertEqual(bridge.respondUserInput({ id: "bg-req-4", answers: { q: "yes" } }), true, "response settles the pumped request");
    await inputPromise.catch(() => {});

    await bridge.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  assertNoUnhandledRejections();
});

await run("running cap: the oldest of 4 backgrounded running sessions is evicted", async () => {
  const cwd = tempCwd("pix-bg-cap-");
  try {
    const bridge = await startBridge(cwd);
    const targets = [makeSessionFile(cwd, "c0"), makeSessionFile(cwd, "c1"), makeSessionFile(cwd, "c2"), makeSessionFile(cwd, "c3")];
    const b = accessBridge(bridge);

    // Detach the anchor plus c0..c2 in order (each switch opens the next
    // target), so four running records exist and the anchor is the oldest.
    // The cap eviction is scheduled by the fourth detach and may already have
    // completed by the time the switch returns, so the assertions wait for the
    // eviction instead of observing the transient count of four.
    const detached: AgentSession[] = [];
    for (const target of targets) {
      const current = b._session!;
      forceStreaming(current, true);
      await bridge.switchSession(target);
      restoreStreaming(current);
      detached.push(current);
    }

    const oldest = detached[0]!;
    await waitFor(() => isDisposed(oldest), 20000, "oldest background session evicted");
    assertEqual(b._backgroundSessions.size, 3, "cap enforced at three running background sessions");
    assert(
      detached.slice(1).every((session) => !isDisposed(session)),
      "the newer background sessions survive the eviction",
    );
    assert(b._session !== null && !isDisposed(b._session), "the active session is untouched by the eviction");

    await bridge.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  assertNoUnhandledRejections();
});

await run("delivery sink keeps delivering to a backgrounded session", async () => {
  const restoreHooks = installNeverSettlingRuntimeHooks();
  try {
    const cwd = tempCwd("pix-bg-sink-");
    try {
      const service = makeTaskService();
      const bridge = await startBridge(cwd, { agentTaskService: service });
      const other = makeSessionFile(cwd, "other");
      const b = accessBridge(bridge);
      const sessionA = b._session!;

      const delivered: string[] = [];
      const originalSend = sessionA.sendCustomMessage.bind(sessionA);
      sessionA.sendCustomMessage = async (message, options) => {
        delivered.push(String(message.customType));
        // Persist without starting a model turn so this wiring test stays offline.
        await originalSend(message, { triggerTurn: false });
        void options;
      };

      const context = b._generation!.runner.assembleSubmissionContext("bg-delivery-test");
      const handle = await service.createTaskGroup(
        {
          mode: "single",
          agentScope: "user",
          tasks: [{ subagent_type: "general-purpose", prompt: "Do the thing", description: "Delivery task" }],
          runInBackground: false,
        },
        context,
        "foreground",
      );
      const taskId = handle.tasks[0]!.taskId;
      const generation = handle.tasks[0]!.generation;

      forceStreaming(sessionA, true);
      await bridge.switchSession(other);

      const deliveredWhileBackgrounded = await service.sendResultToSession(taskId, generation, sessionA.sessionId);
      assertEqual(deliveredWhileBackgrounded.ok, true, "send_to_session delivers to the backgrounded session");
      assertEqual(delivered.length, 1, "delivery message injected into the backgrounded session");

      await bridge.dispose();
      const afterClose = await service.sendResultToSession(taskId, generation, sessionA.sessionId);
      assertEqual(afterClose.ok, false, "closed session rejects delivery");
      assertEqual(afterClose.reason, "target_session_not_open", "reason is target_session_not_open after close");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  } finally {
    restoreHooks();
  }
  assertNoUnhandledRejections();
});

await run("switch-to-self on a busy session is a no-op", async () => {
  const cwd = tempCwd("pix-bg-self-");
  try {
    const bridge = await startBridge(cwd);
    const b = accessBridge(bridge);
    const sessionA = b._session!;
    const pathA = resolve(sessionA.sessionFile!);

    forceStreaming(sessionA, true);
    const result = await bridge.switchSession(pathA);
    assertEqual(result.cancelled, false, "switch-to-self resolves normally");
    assertEqual(b._session, sessionA, "session instance unchanged on switch-to-self");
    assertEqual(b._backgroundSessions.size, 0, "no background record created on switch-to-self");
    assert(!isDisposed(sessionA), "session not disposed on switch-to-self");

    restoreStreaming(sessionA);
    await bridge.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  assertNoUnhandledRejections();
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
