import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";
import { PlanController, type PlanControllerContext } from "../plan/plan-controller.js";
import { createSubmitUserPlanTool, createUpdatePlanStepTool } from "../plan/plan-tools.js";
import type { PlanStepExecutionTarget } from "../../shared/plan-types.js";
import { CuaDriverBackend, translateAct } from "../computer-use/cua-backend.js";
import { ComputerUseError, type DriverClient, type DriverToolInputSchema } from "../computer-use/contracts.js";

for (const target of ["parent", "subagent_foreground", "subagent_background"] as const satisfies readonly PlanStepExecutionTarget[]) {
  test(`plan ${target}: visible context supplies valid status-update identifiers`, async () => {
    const messages: string[] = [];
    const model = getModel("anthropic", "claude-sonnet-4-5");
    const location = { path: process.cwd(), physicalPath: process.cwd(), name: "test", environment: { kind: "windows" as const } };
    const session = {
      model, thinkingLevel: "off", isStreaming: false,
      getActiveToolNames: () => ["read", "submit_user_plan", "update_plan_step"],
      setActiveToolsByName: () => {}, setModel: async () => {}, setThinkingLevel: () => {},
      subscribe: () => () => {}, abort: async () => {},
      sendCustomMessage: async (message: { content: string }) => { messages.push(message.content); },
    } as unknown as AgentSession;
    const context: PlanControllerContext = {
      getSession: () => session,
      getSessionManager: () => ({ appendCustomEntry: () => "record" }) as unknown as SessionManager,
      getProjectLocation: () => location,
      getExecutionContext: () => ({ location, physicalCwd: process.cwd(), logicalCwd: process.cwd(), isWsl: false }),
      getExecutionMode: () => "unattended",
      resolvePlanningModel: () => ({ model, thinkingLevel: "off" }),
      promptPlanningRequest: async () => {},
      requestUserInput: async () => ({ id: "input", cancelled: true, answers: {} }),
      recordProductEvent: () => {},
      delegateSubagentStep: async (_step, link) => target === "subagent_background"
        ? { stepId: link.stepId, status: "backgrounded", groupId: "group", taskIds: ["task"] }
        : { stepId: link.stepId, status: "result", summary: "done" },
      getPlanTaskGroupResult: async () => ({ ok: true, status: "completed", taskIds: ["task"], summary: "done" }),
      confirmPlanTaskGroupConsumed: async () => {},
    };
    const controller = new PlanController(context);
    try {
      const entered = await controller.enterPlanning({ text: "Inspect" });
      const submitted = await createSubmitUserPlanTool({ controller }).execute("submit", {
        generationId: entered.generationId!, title: "Inspect", summary: "Inspect", steps: [{
          stepKey: "inspect", title: "Inspect", description: "Inspect the workspace", files: [], expectedCommands: [],
          executionTarget: target, risk: "low", riskReason: "Read only", effort: "small", verification: "Inspected", dependsOn: [],
        }],
      }, undefined, undefined, {} as never);
      assert.equal(submitted.details.accepted, true);
      const plan = controller.getSnapshot().plan!;
      assert.equal((await controller.approve(plan.planId, plan.version)).ok, true);
      assert.equal((await controller.startExecution(plan.planId, plan.version)).ok, true);
      if (target === "subagent_background") assert.equal((await controller.continuePlan(plan.planId, plan.version)).ok, true);

      // The executing model receives content, not the tool's details snapshot.
      const visible = messages.at(-1)!;
      const planId = /planId="([^"]+)"/.exec(visible)?.[1];
      const version = Number(/version=(\d+)/.exec(visible)?.[1]);
      const stepId = /stepId=([^)]+)/.exec(visible)?.[1];
      assert(planId && stepId);
      const tool = createUpdatePlanStepTool({ controller });
      if (target === "parent") {
        assert.equal((await tool.execute("running", { planId, version, stepId, status: "running" }, undefined, undefined, {} as never)).details.accepted, true);
      }
      assert.equal((await tool.execute("completed", {
        planId, version, stepId, status: "completed", completionSummary: "Inspected", verificationResult: { status: "passed", summary: "Verified" },
      }, undefined, undefined, {} as never)).details.accepted, true);
      assert.equal(controller.getSnapshot().phase, "completed");
    } finally {
      await controller.dispose("host_disposed");
    }
  });
}

function computerFixture() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const schemas = new Map<string, DriverToolInputSchema>([
    ["scroll", { required: ["direction"], properties: new Set(["direction", "amount", "pid", "window_id", "x", "y", "scope", "delivery_mode"]) }],
    ["move_cursor", { required: ["x", "y"], properties: new Set(["x", "y", "scope"]) }],
  ]);
  const client: DriverClient = {
    state: "ready", ensureStarted: async () => {}, cancelAll: () => {}, stop: async () => {}, onStateChange: () => () => {},
    listToolNames: () => new Set(["scroll", "move_cursor", "get_window_state", "get_desktop_state", "zoom"]),
    getToolInputSchema: name => schemas.get(name) ?? null,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return {
        isError: false,
        content: name === "get_desktop_state" ? [{ type: "image", mimeType: "image/png", data: "" }] : [],
        structuredContent: { capture_id: name === "get_desktop_state" ? "desktop" : "window", elements: [], screenshot_width: 100, screenshot_height: 50, screenshot_original_width: 200, screenshot_original_height: 100 },
      };
    },
  };
  return { backend: new CuaDriverBackend(client, "win32-x64"), calls, schemas };
}

test("unsupported zoom scrolling and Windows window cursor coordinates never reach the driver", async () => {
  const { backend, calls } = computerFixture();
  const handle = { driverSession: "test" };
  for (const params of [
    { action: "scroll" as const, direction: "down" as const, pid: 1, window_id: 2, x: 3, y: 4, from_zoom: true },
    { action: "move_cursor" as const, pid: 1, window_id: 2, x: 3, y: 4 },
    { action: "move_cursor" as const, frame: "desktop" as const, pid: 1, x: 3, y: 4 },
  ]) {
    await assert.rejects(backend.act(handle, params, {}), (error: unknown) => error instanceof ComputerUseError && error.code === "unsupported_on_platform");
  }
  assert.equal(calls.length, 0);
});

test("scroll checks the capture and target when the driver cannot bind captures", async () => {
  const { backend, calls } = computerFixture();
  const handle = { driverSession: "test" };
  await backend.observe(handle, { view: "window", pid: 1, window_id: 2 }, { maxImageDimension: 100, wantImage: false });
  const params = { action: "scroll" as const, direction: "down" as const, pid: 1, window_id: 2, x: 3, y: 4, capture_id: "window", delivery: "foreground" as const };
  const stale = (error: unknown) => error instanceof ComputerUseError && error.code === "stale_reference";
  await assert.rejects(backend.act(handle, { ...params, capture_id: "old" }, {}), stale);
  await assert.rejects(backend.act(handle, { ...params, pid: 3 }, {}), stale);
  assert.equal(calls.some(call => call.name === "scroll"), false);
  await backend.act(handle, params, {});
  const sent = calls.find(call => call.name === "scroll")!.args;
  assert.equal(sent.capture_id, undefined);
  assert.equal(sent.pid, 1);
  await assert.rejects(backend.act(handle, params, {}), stale);
});

test("Windows desktop cursor keeps screenshot scaling and capture binding", async () => {
  const { backend, calls } = computerFixture();
  const handle = { driverSession: "test" };
  await backend.observe(handle, { view: "desktop" }, { maxImageDimension: 100, wantImage: true });
  await backend.act(handle, { action: "move_cursor", frame: "desktop", x: 10, y: 20, capture_id: "desktop" }, {});
  assert.deepEqual(calls.find(call => call.name === "move_cursor")?.args, { x: 20, y: 40, scope: "desktop", session: "test" });
});

test("drivers declaring zoom/capture support receive those fields", () => {
  const schema = { required: [], properties: new Set(["pid", "window_id", "coordinate_frame", "capture_id", "from_zoom", "scope"]) };
  for (const action of ["scroll", "move_cursor"] as const) {
    const result = translateAct({ action, pid: 1, window_id: 2, x: 3, y: 4, direction: "down", capture_id: "zoom", from_zoom: true }, () => schema);
    assert("tool" in result);
    assert.equal(result.args.capture_id, "zoom");
    assert.equal(result.args.from_zoom, true);
    assert.equal(result.args.pid, 1);
    assert.equal(result.args.window_id, 2);
  }
});
