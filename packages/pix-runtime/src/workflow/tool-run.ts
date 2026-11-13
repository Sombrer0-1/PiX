import type { WorkflowResult } from "../shared/workflow-types.js";
import type { WorkflowRun, WorkflowStartRequest } from "./engine/runtime-types.js";
import type { WorkflowToolHost } from "./tool-workflow.js";

export function startToolRun(
  host: WorkflowToolHost,
  request: WorkflowStartRequest,
  toolCallId: string,
  toolName: "workflow" | "ralph",
  subscribe?: (run: WorkflowRun) => Array<() => void>,
): { run: WorkflowRun; completion: Promise<WorkflowResult> } {
  const { signal } = request;
  let startedRun: WorkflowRun | undefined;
  // Register before the engine signal so cancellation keeps this reason.
  const onAbort = () => startedRun?.cancel("parent step aborted");
  signal?.addEventListener("abort", onAbort, { once: true });
  let run: WorkflowRun;
  try {
    run = host.engine.start(request);
  } catch (error) {
    signal?.removeEventListener("abort", onAbort);
    throw error;
  }
  startedRun = run;

  const completion = (async () => {
    const background = subscribe === undefined;
    let unsubscribe: Array<() => void> = [];
    let result: WorkflowResult | undefined;
    let recorded = false;
    try {
      host.recorder.start(run, toolCallId, toolName);
      unsubscribe = subscribe?.(run) ?? [];
      result = await run.result;
      return result;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      try {
        // Disposal can emit the final member endings consumed by the recorder.
        try {
          await run.dispose();
          await run.waitForChildren?.();
        } catch (error) {
          if (!background) throw error;
        }
        if (result) {
          host.recorder.finish(run.id, result.stopReason);
          recorded = true;
        }
      } finally {
        for (const remove of unsubscribe) remove();
        if (!recorded || !background) host.recorder.abandon(run.id);
      }
    }
  })();
  host.trackRun?.(completion);
  return { run, completion };
}
