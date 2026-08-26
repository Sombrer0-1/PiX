/**
 * Host side of one workflow run ({@link WorkerRun}): the Worker thread
 * lifecycle, the child registry, the settlement state machine and the
 * agent-end pairing ledger. Three terminal sources — the worker's `result`
 * message, worker death (error / messageerror / exit), and grace expiry after
 * cancellation — race for settlement: `terminalClaimed` first-wins, and
 * cleanup callbacks never overwrite it.
 *
 * The only seam into the child backend is the spawner interface from
 * child-spawner.ts (the task-service adapter lives there); this file depends
 * on that interface alone, so a fake spawner can drive it in tests.
 */

import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowMeta,
  WorkflowResult,
  WorkflowRunId,
} from "../../../shared/workflow-types.js";
import type { WorkflowEngineConfig, WorkflowParentRef, WorkflowRun } from "./runtime-types.js";
import { assertNever, HostToWorkerType, WorkerToHostType } from "./protocol.js";
import type { HostToWorkerPayloads, WorkerToHostMessage } from "./protocol.js";
import { renderThrown } from "./realm.js";
import { workflowCacheScopeId } from "./child-cache-key.js";
import type { ChildHandle, ChildResult, ChildStartRequest, WorkerInit } from "./child-types.js";
import type { WorkflowChildSpawner } from "../child-spawner.js";

/** One published child and its shared (memoized) disposal transaction. */
interface ChildRecord {
  readonly handle: ChildHandle;
  disposal?: Promise<void>;
}

/** The progress observer the engine installs, mapped onto its event bus. */
export interface HostRunObserver {
  phase(title: string): void;
  log(message: string): void;
  agentStart(agent: WorkflowAgentInfo): void;
  agentEnd(agent: WorkflowAgentEndInfo): void;
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

/** A plain unref'd timer sleep: never holds the process open (the dispose grace). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * The scrubbed worker environment: no ambient credentials, no loader flags.
 * Windows derives `os.tmpdir()` from `TMP`/`TEMP` and falls back to the
 * literal relative path `undefined\temp` on an empty environment, so the
 * worker's temp-dependent machinery would land in a cwd-relative
 * `undefined/temp` directory; the host's real temp path (not a credential)
 * is injected there.
 */
export function workerSpawnEnv(platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (platform === "win32") {
    const tmp = tmpdir();
    env.TMP = tmp;
    env.TEMP = tmp;
  }
  return env;
}

/**
 * One live worker-engine run — the seam's {@link WorkflowRun}, returned by
 * `start()` directly. Owns the Worker, the child registry and the result
 * settlement; `result` never rejects. The spawner is borrowed, never owned:
 * this run can keep starting and cleaning up its children even after the
 * engine instance is unloaded.
 */
export class WorkerRun implements WorkflowRun {
  /** Settles exactly once with the run's outcome; never rejects. */
  readonly result: Promise<WorkflowResult>;
  private settleResolve!: (result: WorkflowResult) => void;
  private settled = false;
  /** A result / death / grace outcome atomically won before teardown callbacks. */
  private terminalClaimed = false;
  /** The first death signal closes worker-message admission and owns failure-time cleanup. */
  private workerDeathObserved = false;
  private cancelReason: string | undefined;
  private graceTimer: NodeJS.Timeout | undefined;
  private readonly worker: Worker;
  /** Set on `exit`: the thread is gone, so posting has nowhere to go. */
  private workerGone = false;
  /** Accepted child-start messages — the failure-time `agentsStarted` count. */
  private hostStarted = 0;
  /** Published children by callId; an entry leaves only after disposal settles. */
  private readonly children = new Map<number, ChildRecord>();
  /** Provider starts that have not yet fulfilled or rejected. */
  private readonly pendingStarts = new Set<Promise<void>>();
  /** Started-but-not-ended agents by seq — the pairing ledger the host guarantees. */
  private readonly liveAgents = new Map<number, WorkflowAgentInfo>();
  private readonly quiescenceWaiters: Array<() => void> = [];
  /** The per-run abort fanout every child start request carries. */
  private readonly controller = new AbortController();
  /** External start signal and the exact callback installed on it, retained only until first settle/teardown. */
  private inputSignal: AbortSignal | undefined;
  private inputSignalAbort: (() => void) | undefined;
  private disposed: Promise<void> | undefined;

  constructor(
    private readonly spawner: WorkflowChildSpawner,
    private readonly parent: WorkflowParentRef,
    readonly id: WorkflowRunId,
    readonly meta: WorkflowMeta,
    init: WorkerInit,
    entry: string | URL,
    private readonly disposeGraceMs: number,
    private readonly observer: HostRunObserver,
    signal: AbortSignal | undefined,
    private readonly cache: WorkflowEngineConfig["cache"],
  ) {
    this.result = new Promise<WorkflowResult>((resolve) => {
      this.settleResolve = resolve;
    });
    // workerData rides the structured clone; the engine has already cloned
    // `args` once so a clone failure throws out of start() synchronously.
    this.worker = new Worker(entry, { workerData: init, execArgv: [], env: workerSpawnEnv() });
    this.worker.on("message", (message: WorkerToHostMessage) => {
      this.onMessage(message);
    });
    this.worker.on("error", (error) => {
      this.onWorkerDeath(`workflow worker failed: ${renderThrown(error)}`, false);
    });
    this.worker.on("messageerror", (error) => {
      this.onWorkerDeath(`workflow worker message failed to deserialize: ${renderThrown(error)}`, false);
    });
    this.worker.on("exit", (code) => {
      this.workerGone = true;
      this.onWorkerDeath(`workflow worker exited before the run settled (exit code ${code})`, true);
    });
    if (signal?.aborted) {
      this.cancel("workflow start signal already aborted");
    } else if (signal !== undefined) {
      const onAbort = (): void => {
        this.detachInputSignal();
        this.cancel("workflow signal aborted");
      };
      this.inputSignal = signal;
      this.inputSignalAbort = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  /**
   * Cancel the run: the worker is told (its hooks start throwing and the
   * script dies at its next await), the signal shared by every child start
   * is aborted, and a grace timer arms: a run still unsettled
   * `disposeGraceMs` later force-settles `cancelled` and its worker is
   * TERMINATED. Idempotent; the first reason wins.
   * @param reason - human-readable cause (default `workflow cancelled`).
   */
  cancel(reason?: string): void {
    // A settled run has nothing left to cancel, and a terminal source claimed
    // before its cleanup callbacks must exclude cancellation reentered by one
    // of those callbacks. Without the settled guard the ordinary consumer
    // path (await result, then dispose -> cancel) would arm a grace timer
    // nothing ever clears, pinning the run and its Worker closure until the
    // grace expires — a bounded leak per completed run.
    if (this.settled || this.terminalClaimed || this.cancelReason !== undefined) return;
    this.cancelReason = reason ?? "workflow cancelled";
    this.post(HostToWorkerType.Cancel, { reason: this.cancelReason });
    this.abortChildren(this.cancelReason);
    this.graceTimer = setTimeout(() => {
      // Cancellation already owns the race through cancelReason; close the
      // terminal boundary explicitly before observer teardown callbacks.
      this.terminalClaimed = true;
      // The worker may no longer speak (it is about to be terminated): pair
      // every stranded agent before the run settles, so ends precede
      // workflow/end.
      this.endStrandedAgents();
      this.settleResult(this.cancelledResult(this.hostStarted));
      void this.worker.terminate();
    }, this.disposeGraceMs);
    // unref'd: an armed grace timer must never hold the process open.
    this.graceTimer.unref();
  }

  /**
   * Cancel + bounded settle + termination. Host-drives every registered
   * child's disposal IMMEDIATELY — a wedged worker can relay no dispose RPC,
   * and deferring child teardown to the post-terminate reap would spend the
   * whole grace waiting for a quiescence that cannot start — so child
   * disposal overlaps the same grace the worker gets to settle. Waits (at
   * most the grace) for the result and child quiescence, then terminates the
   * worker unconditionally and reaps whatever children remain. Idempotent.
   * @returns resolves when the run's resources are released or abandoned.
   */
  dispose(): Promise<void> {
    if (this.disposed !== undefined) return this.disposed;
    // Claim the public transaction BEFORE its body invokes child disposal; a
    // reentrant dispose() must join this promise, not start a second walk.
    const claimed = deferred<void>();
    this.disposed = claimed.promise;
    void (async () => {
      this.detachInputSignal();
      this.cancel("workflow disposed");
      // cancel() becomes a no-op after terminal settlement, but disposal
      // still owns every registered child: reap independently so an
      // already-settled workflow cannot wait on quiescence before the
      // surviving children's disposals have started.
      this.reapChildren("workflow disposed");
      await Promise.race([
        (async () => {
          await this.result;
          await this.childQuiescence();
        })(),
        sleep(this.disposeGraceMs),
      ]);
      await this.worker.terminate();
      this.reapChildren("workflow disposed");
    })().then(
      () => {
        claimed.resolve();
      },
      (error: unknown) => {
        // result/quiescence never reject; Worker.terminate is the only
        // external promise. A rejection still releases the waiter.
        claimed.reject(error);
      },
    );
    return this.disposed;
  }

  /** Post one message to the worker, tolerating a thread that is already gone. */
  private post<T extends HostToWorkerType>(type: T, payload: HostToWorkerPayloads[T]): void {
    if (this.workerGone || this.workerDeathObserved) return;
    try {
      this.worker.postMessage({ type, ...payload });
    } catch (error: unknown) {
      // Only a teardown race can land here (every engine message is JSON
      // data, so serialization cannot fail); there is nothing left to
      // deliver to — log and move on.
      console.warn(`workflow: postMessage to the workflow worker failed: ${renderThrown(error)}`);
    }
  }

  private onMessage(message: WorkerToHostMessage): void {
    // Node may emit `error`, then deliver an already-queued `message`, then
    // emit `exit`. The first death signal is the host's logical delivery
    // barrier: nothing arriving afterward may create a child, narrate after
    // workflow/end, or compete with the chosen outcome.
    if (this.workerDeathObserved) return;
    switch (message.type) {
      case WorkerToHostType.Ready:
        this.post(HostToWorkerType.Go, {});
        break;
      case WorkerToHostType.Phase:
        // Post-cancel narration is suppressed host-side: worker-side the
        // hooks throw once the cancel message is PROCESSED, but narration
        // already in flight must not reach observers — nothing is emitted
        // after cancel() returns.
        if (this.cancelReason === undefined) this.observer.phase(message.title);
        break;
      case WorkerToHostType.Log:
        if (this.cancelReason === undefined) this.observer.log(message.message);
        break;
      case WorkerToHostType.AgentStart:
        this.liveAgents.set(message.info.seq, message.info);
        this.observer.agentStart(message.info);
        break;
      case WorkerToHostType.AgentEnd:
        // NOT suppressed on cancel: cancelled children report their paired
        // agent-end with outcome "cancelled". The endAgent gate (with the
        // termination paths' synthesis) is what makes the one-pair-per-agent
        // contract hold on every stop path.
        this.endAgent(message.info);
        break;
      case WorkerToHostType.ChildStart:
        this.onChildStart(message.callId, message.request);
        break;
      case WorkerToHostType.ChildDispose:
        this.onChildDispose(message.callId);
        break;
      case WorkerToHostType.CacheLookup:
        this.onCacheLookup(message.callId, message.key);
        break;
      case WorkerToHostType.CacheStore:
        this.onCacheStore(message.callId, message.key, message.value, message.childId);
        break;
      case WorkerToHostType.Result:
        this.onResult(message.result);
        break;
      default:
        // The exhaustive worker-to-host union: an unknown tag is a protocol
        // violation, and adding a tag makes this a compile error.
        assertNever(message);
    }
  }

  /** Why a ready provider result may no longer be admitted to the worker. */
  private childAdmissionFailure(): { reason: string; rendered: string } | undefined {
    if (this.cancelReason !== undefined) {
      return { reason: this.cancelReason, rendered: `workflow run cancelled: ${this.cancelReason}` };
    }
    if (this.workerDeathObserved) {
      return { reason: "workflow worker gone", rendered: "workflow worker is no longer available" };
    }
    if (this.terminalClaimed) {
      return { reason: "workflow settled", rendered: "workflow run already settled" };
    }
    return undefined;
  }

  /** Content-key lookup; miss/hit never go through the spawner or hostStarted. */
  private onCacheLookup(callId: number, key: string): void {
    void this.lookupCache(callId, key);
  }

  private async lookupCache(callId: number, key: string): Promise<void> {
    if (this.cache === undefined) {
      this.post(HostToWorkerType.CacheLookupResult, { callId, hit: false });
      return;
    }
    try {
      const hit = await this.cache.lookup(this.cacheScopeId(), key);
      if (hit === undefined) {
        this.post(HostToWorkerType.CacheLookupResult, { callId, hit: false });
        return;
      }
      this.post(HostToWorkerType.CacheLookupResult, {
        callId,
        hit: true,
        value: hit.value,
        ...hit.childId !== undefined ? { childId: hit.childId } : {},
      });
    } catch (error: unknown) {
      console.warn(`workflow: cache lookup failed: ${renderThrown(error)}`);
      this.post(HostToWorkerType.CacheLookupResult, { callId, hit: false });
    }
  }

  /** Store ack is always owed; size/IO failures are swallowed so the script lives. */
  private onCacheStore(callId: number, key: string, value: unknown, childId?: string): void {
    void this.storeCache(callId, key, value, childId);
  }

  private async storeCache(callId: number, key: string, value: unknown, childId?: string): Promise<void> {
    if (this.cache !== undefined) {
      try {
        await this.cache.store(this.cacheScopeId(), key, value, childId);
      } catch (error: unknown) {
        console.warn(`workflow: cache store failed: ${renderThrown(error)}`);
      }
    }
    this.post(HostToWorkerType.CacheStored, { callId });
  }

  /** Scope is host-only: WorkerInit never carries sessionId / workspaceId. */
  private cacheScopeId(): string {
    return workflowCacheScopeId(this.parent.workspaceId, this.parent.sessionId, this.meta.name);
  }

  private onChildStart(callId: number, request: ChildStartRequest): void {
    const initialFailure = this.childAdmissionFailure();
    if (initialFailure !== undefined) {
      // Refuse after a terminal boundary: a child must never start on an
      // already-aborted signal (a provider subscribing only to future abort
      // events would never observe it). No agent-start / agent-end here.
      this.post(HostToWorkerType.ChildStartError, { callId, rendered: initialFailure.rendered });
      return;
    }
    this.hostStarted += 1;
    const task = this.startChild(callId, request);
    this.pendingStarts.add(task);
    void task.then(
      () => {
        this.finishPendingStart(task);
      },
      () => {
        this.finishPendingStart(task);
      },
    );
  }

  /** Await one provider-owned startup transaction and publish only while admitted. */
  private async startChild(callId: number, request: ChildStartRequest): Promise<void> {
    let handle: ChildHandle;
    try {
      handle = await this.spawner.start(request, this.parent, this.controller.signal);
    } catch (error: unknown) {
      const failure = this.childAdmissionFailure();
      this.post(HostToWorkerType.ChildStartError, {
        callId,
        rendered: failure?.rendered ?? renderThrown(error),
      });
      return;
    }
    const failure = this.childAdmissionFailure();
    if (failure !== undefined) {
      this.post(HostToWorkerType.ChildStartError, { callId, rendered: failure.rendered });
      try {
        await handle.dispose();
      } catch (error: unknown) {
        console.warn(`workflow: refused child dispose failed: ${renderThrown(error)}`);
      }
      return;
    }

    const record: ChildRecord = { handle };
    this.children.set(callId, record);
    // Attach result forwarding before publishing the child handle. Because
    // the forwarding itself runs in a later microtask, ChildStarted is still
    // posted first even for an already-settled provider child.
    const forwardResult = handle.result.then<() => void, () => void>(
      (result) => () => {
        this.post(HostToWorkerType.ChildSettled, { callId, result });
      },
      (error: unknown) => {
        const rendered = renderThrown(error);
        return () => {
          this.post(HostToWorkerType.ChildFailed, { callId, rendered });
        };
      },
    );
    this.post(HostToWorkerType.ChildStarted, { callId, childId: handle.id });
    void forwardResult.then((forward) => {
      forward();
    });
  }

  private onChildDispose(callId: number): void {
    const record = this.children.get(callId);
    if (record === undefined) {
      // Already disposed host-side (a dispose() drive or a death reap beat
      // the RPC) — the ack is still owed (the worker-side wrapper awaits it).
      this.post(HostToWorkerType.ChildDisposed, { callId });
      return;
    }
    // disposeChild never rejects (containment is inside), so the ack always follows.
    void this.disposeChild(callId, record).then(() => {
      this.post(HostToWorkerType.ChildDisposed, { callId });
    });
  }

  /**
   * Start (or join) one registered child's disposal; the registry entry
   * leaves when it settles. Memoized per callId: the worker's dispose RPC,
   * the dispose() host drive and the reap can all land on the same child —
   * the child's `dispose()` runs once and every caller awaits that one
   * settlement. A rejection is contained: logged, and the child still leaves
   * the registry.
   */
  private disposeChild(callId: number, record: ChildRecord): Promise<void> {
    if (record.disposal !== undefined) return record.disposal;
    record.disposal = Promise.resolve()
      .then(() => record.handle.dispose())
      .catch((error: unknown) => {
        console.warn(`workflow: child dispose failed: ${renderThrown(error)}`);
      })
      .then(() => {
        this.finishChild(callId);
      });
    return record.disposal;
  }

  /** Drop a child record and release quiescence waiters when all work ends. */
  private finishChild(callId: number): void {
    this.children.delete(callId);
    this.notifyChildQuiescence();
  }

  /** Retire one provider startup transaction. */
  private finishPendingStart(task: Promise<void>): void {
    this.pendingStarts.delete(task);
    this.notifyChildQuiescence();
  }

  /** Release waiters only after both pending starts and published children end. */
  private notifyChildQuiescence(): void {
    if (this.children.size !== 0 || this.pendingStarts.size !== 0) return;
    for (const waiter of this.quiescenceWaiters.splice(0)) waiter();
  }

  /** Resolves once every pending start and published child has reached quiescence. */
  private childQuiescence(): Promise<void> {
    if (this.children.size === 0 && this.pendingStarts.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.quiescenceWaiters.push(resolve);
    });
  }

  /** Abort + dispose every registered child (worker death / final teardown); disposal is contained, not awaited. */
  private reapChildren(reason: string): void {
    this.abortChildren(this.cancelReason ?? reason);
    for (const [callId, record] of [...this.children]) {
      void this.disposeChild(callId, record);
    }
  }

  /** Abort the one canonical signal shared by pending and published children. */
  private abortChildren(reason: string): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  private onResult(result: WorkflowResult): void {
    // The owned worker session sends one Result. Keep a late duplicate or a
    // Result queued behind another terminal source completely side-effect-free.
    if (this.terminalClaimed) return;
    // First-wins is decided when the Result message reaches the host. If no
    // external cancellation was already in flight, this result won.
    const cancellationWasRequested = this.cancelReason !== undefined;
    // Claim before settlement cleanup invokes child disposal; once Result
    // won, a later cancellation cannot rewrite it.
    this.terminalClaimed = true;
    // Abort pending starts and begin disposing published children before the
    // workflow becomes externally settled. Cleanup remains independently
    // tracked by childQuiescence and the holder's dispose().
    this.reapChildren("workflow settled");
    if (!cancellationWasRequested) {
      this.settleResult(result);
      return;
    }
    if (result.stopReason !== "cancelled") {
      // The script settled while our cancel was crossing the thread boundary
      // — report cancelled (the vm drive()'s post-settle check, relocated to
      // the receiving side of the race).
      this.settleResult(this.cancelledResult(result.agentsStarted));
      return;
    }
    this.settleResult(result);
  }

  /** Process an error/messageerror/exit signal; `exit` also performs the final disposal sweep. */
  private onWorkerDeath(message: string, isExit: boolean): void {
    if (!this.workerDeathObserved) {
      // Close message admission BEFORE cleanup callbacks: Node can deliver a
      // message queued before the crash after its `error` event. Treating the
      // first death signal as a logical barrier prevents that late message
      // from creating work or narrating after workflow/end.
      this.workerDeathObserved = true;
      const outcomeWasClaimed = this.terminalClaimed;
      const cancellationWasRequested = this.cancelReason !== undefined;
      // When death is itself the terminal source, claim BEFORE child reap or
      // synthesized observer callbacks. Either can reenter cancel(); a death
      // that arrived first remains an error, while a cancellation already
      // accepted before death remains cancelled. If Result/grace already won,
      // preserve it while still performing prompt failure-time cleanup.
      if (!outcomeWasClaimed) this.terminalClaimed = true;
      if (this.children.size > 0 || this.pendingStarts.size > 0) this.reapChildren("workflow worker gone");
      this.endStrandedAgents();
      if (!outcomeWasClaimed) {
        if (cancellationWasRequested) {
          this.settleResult(this.cancelledResult(this.hostStarted));
        } else {
          this.settleResult({ value: null, stopReason: "error", error: message, agentsStarted: this.hostStarted });
        }
      }
    }
    if (!isExit) return;
    // `error` is not Node's physical delivery barrier: a queued message may
    // precede `exit`. Admission is already closed, so this final sweep only
    // joins/starts disposal for registry survivors; it deliberately does not
    // repeat explicit provider cancellation.
    for (const [callId, record] of [...this.children]) void this.disposeChild(callId, record);
    this.endStrandedAgents();
  }

  /**
   * The single agent-end emission gate: forwards `end` iff its start is still
   * unpaired in the ledger, so every forwarded workflow/agent-start gets
   * EXACTLY one workflow/agent-end — the worker's own report where it can
   * speak, a host-synthesized one where it cannot ({@link endStrandedAgents}).
   */
  private endAgent(end: WorkflowAgentEndInfo): void {
    if (!this.liveAgents.delete(end.seq)) return;
    this.observer.agentEnd(end);
  }

  /**
   * Synthesize the missing agent-end for every started-but-unpaired agent,
   * outcome "cancelled": the reap cancels every child, and a real settlement
   * racing the force-settle loses to that already-started external
   * cancellation. Called where the worker can no longer speak (the grace
   * force-settle, worker death, physical exit). When grace/death is the
   * terminal source it runs before settleResult, so already-known pairs
   * precede workflow/end; after an earlier Result, exit cleanup may close a
   * survivor afterward. The ledger preserves exactly-once pairing in both
   * orders.
   */
  private endStrandedAgents(): void {
    for (const info of [...this.liveAgents.values()]) {
      this.endAgent({ ...info, outcome: "cancelled" });
    }
  }

  private cancelledResult(agentsStarted: number): WorkflowResult {
    // cancel() is the only writer of cancelReason and every caller checks it
    // first; the fallback guards the type, not a reachable path.
    const reason = this.cancelReason ?? "workflow cancelled";
    return { value: null, stopReason: "cancelled", error: `workflow run cancelled: ${reason}`, agentsStarted };
  }

  /** Remove the exact abort callback installed on the caller's start signal. */
  private detachInputSignal(): void {
    const signal = this.inputSignal;
    const onAbort = this.inputSignalAbort;
    if (signal === undefined || onAbort === undefined) return;
    this.inputSignal = undefined;
    this.inputSignalAbort = undefined;
    signal.removeEventListener("abort", onAbort);
  }

  /** First settle wins; disarms the grace timer and releases the caller signal. */
  private settleResult(result: WorkflowResult): void {
    // Every current terminal source claims ownership before calling here;
    // keep the fallback local so a future caller cannot resolve twice.
    if (this.settled) return;
    this.terminalClaimed = true;
    this.settled = true;
    this.detachInputSignal();
    clearTimeout(this.graceTimer);
    this.settleResolve(result);
  }
}
