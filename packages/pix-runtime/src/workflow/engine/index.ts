/**
 * The engine subsystem barrel: external consumers (SessionBridge, the tool
 * layer) import the engine abstraction and the start types ONLY from here —
 * never host.ts / worker.ts / protocol.ts internals. (The tool steps import
 * directly from engine.ts per the engine.ts note; that note is for S6/S7.)
 */

export { WorkflowEngine, WorkflowError, isFatalWorkflowError } from "./engine.js";
export type { WorkflowEventListener } from "./engine.js";
export type { WorkflowEngineConfig, WorkflowParentRef, WorkflowRun, WorkflowStartRequest } from "./runtime-types.js";
export { WorkerThreadWorkflowEngine } from "./worker-thread-engine.js";
