/**
 * The host<->worker wire vocabulary: message tags, payload maps, discriminated
 * message unions and the `assertNever` exhaustion guard. This file is the ONLY
 * source of truth for the protocol; host.ts and session.ts consume it and
 * never hand-build messages.
 */

import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowResult,
} from "../../../shared/workflow-types.js";
import type { ChildResult, ChildStartRequest } from "./child-types.js";

export enum WorkerToHostType {
  Ready = "ready",
  Phase = "phase",
  Log = "log",
  AgentStart = "agent-start",
  AgentEnd = "agent-end",
  ChildStart = "child-start",
  ChildDispose = "child-dispose",
  CacheLookup = "cache-lookup",
  CacheStore = "cache-store",
  Result = "result",
}
export enum HostToWorkerType {
  Go = "go",
  Cancel = "cancel",
  ChildStarted = "child-started",
  ChildStartError = "child-start-error",
  ChildSettled = "child-settled",
  ChildFailed = "child-failed",
  ChildDisposed = "child-disposed",
  CacheLookupResult = "cache-lookup-result",
  CacheStored = "cache-stored",
}

export interface WorkerToHostPayloads {
  [WorkerToHostType.Ready]: Record<never, never>;
  [WorkerToHostType.Phase]: { title: string };
  [WorkerToHostType.Log]: { message: string };
  [WorkerToHostType.AgentStart]: { info: WorkflowAgentInfo };
  [WorkerToHostType.AgentEnd]: { info: WorkflowAgentEndInfo };
  [WorkerToHostType.ChildStart]: { callId: number; request: ChildStartRequest };
  [WorkerToHostType.ChildDispose]: { callId: number };
  [WorkerToHostType.CacheLookup]: { callId: number; key: string };
  [WorkerToHostType.CacheStore]: { callId: number; key: string; value: unknown; childId?: string };
  [WorkerToHostType.Result]: { result: WorkflowResult };
}
export interface HostToWorkerPayloads {
  [HostToWorkerType.Go]: Record<never, never>;
  [HostToWorkerType.Cancel]: { reason: string };
  [HostToWorkerType.ChildStarted]: { callId: number; childId: string };
  [HostToWorkerType.ChildStartError]: { callId: number; rendered: string };
  [HostToWorkerType.ChildSettled]: { callId: number; result: ChildResult };
  [HostToWorkerType.ChildFailed]: { callId: number; rendered: string };
  [HostToWorkerType.ChildDisposed]: { callId: number };
  [HostToWorkerType.CacheLookupResult]: { callId: number; hit: boolean; value?: unknown; childId?: string };
  [HostToWorkerType.CacheStored]: { callId: number };
}

export type WorkerToHostMessage<T extends WorkerToHostType = WorkerToHostType> =
  { [K in T]: { type: K } & WorkerToHostPayloads[K] }[T];
export type HostToWorkerMessage<T extends HostToWorkerType = HostToWorkerType> =
  { [K in T]: { type: K } & HostToWorkerPayloads[K] }[T];

/** Exhaustion guard for receivers; an unknown tag is a protocol violation. */
export function assertNever(value: never): never {
  throw new Error(`workflow: unexpected protocol message tag ${JSON.stringify(value)}`);
}
