/**
 * The worker-thread entry: boots {@link runWorkerSession} on the real
 * `parentPort`. Logic lives in session.ts so in-process MessageChannel tests
 * can drive it; production unpacks the whole `workflow/engine/` directory
 * (asarUnpack) because this file's ESM relative imports cannot re-enter the
 * asar. Importing this entry on the main thread exercises
 * `requireParentPort`'s failure path.
 */

import { parentPort, workerData } from "node:worker_threads";
import { requireParentPort, runWorkerSession } from "./session.js";
import type { WorkerInit } from "./child-types.js";

// workerData is `any` at the node:worker_threads boundary; the engine is the
// only spawner and always provides a WorkerInit.
void runWorkerSession(requireParentPort(parentPort), workerData as WorkerInit);
