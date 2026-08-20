/**
 * PiX 1.4.1 Windows/WSL2 real-functionality E2E (design plan §5.3/§5.4, B10).
 *
 * Runs the REAL AgentTaskService + AgentTaskRuntime + SessionBridge runner
 * facade against a REAL model provider end to end (no fakes, no SKIP). Per leg
 * it verifies:
 *
 * - foreground: an `agent` tool run completes and the facade rebuilds the
 *   legacy SubagentDetails (marker file written by the real nested session);
 * - background: a backgrounded run returns the AgentTaskGroupHandle
 *   immediately while the task keeps running to completion in the service;
 * - input: a nested request_user_input request routes through the per-task
 *   input router (task_input + waiting_input), respondInput delivers the
 *   answer and the task continues to completion;
 * - bounded shutdown: service.dispose("app_shutdown") cancels running /
 *   waiting_input tasks, settles pending input requests and settles within the
 *   bounded abort/cleanup window.
 *
 * WSL2 leg: every runtime creates its own WSL backend from the frozen
 * ProjectLocation; cwd/paths/commands use the logical Linux environment (the
 * marker written by the nested session is verified inside the distro and its
 * content is the logical `pwd`). The parent SessionBridge and every WSL nested
 * session exclude run_background/read_output/stop_process: the parent tool
 * registry is inspected directly, an explicit agent tool reference fails as
 * tool_unavailable, and an all-tools nested session cannot re-add them.
 *
 * WSL1 leg: the existing ProjectLocation/WSL validation refuses WSL1 distros
 * (real distro when one exists, otherwise a WSL1-shaped resolver fixture), so
 * no project context - and therefore no backgrounding entry - can exist.
 *
 * Environment gate (design plan §8, B10): PIX_WSL_TEST_DISTRO must name a WSL2
 * distro and the agent dir must contain configured model credentials. Missing
 * variables / a non-WSL2 distro / missing credentials exit non-zero at startup;
 * SKIP is forbidden for this gate. The model under test is PIX_E2E_MODEL
 * (provider/modelId) when set, otherwise the first auth-configured model whose
 * id matches flash|free (fallback: first auth-configured model).
 *
 * Model credentials are read from the real agent dir (models.json/auth.json),
 * copied into a throwaway agent dir; the real agent dir is never modified.
 *
 * Run with: npm exec tsx -- src/main/__tests__/agent-task-e2e.test.ts --windows --wsl2
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  AgentSession,
  AuthStorage,
  ModelRegistry,
  getAgentDir,
  type RequestUserInputResponse,
} from "@earendil-works/pi-coding-agent";
import type { AgentTaskGroupHandle, AgentTaskInfo, AgentTaskInputRequest } from "../../shared/agent-task-types.js";
import type { ProjectLocation } from "../../shared/project-location.js";
import { isSubagentDetails, type SubagentDetails } from "../../shared/subagent-types.js";
import { AgentTaskStore } from "../agent-task/agent-task-store.js";
import { AgentTaskService, type AgentTaskServiceEvent } from "../agent-task/agent-task-service.js";
import type { ProjectExecutionContext } from "../execution-context.js";
import { createProjectExecutionContext, disposeProjectExecutionContext, resolveProjectLocation } from "../execution-context.js";
import type { ProductEventCollector } from "../product-event-collector.js";
import { SettingsStore } from "../settings-store.js";
import { SessionBridge } from "../session-bridge.js";
import type { SubagentRunner } from "../subagent/subagent-runner.js";
import { WslDistroResolver, type WslDistroInfo } from "../wsl/wsl-distro.js";
import { createWslRuntime, type WslRuntime } from "../wsl/wsl-runtime.js";

// ============================================================================
// CLI flags: --windows / --wsl2 select the legs; no flags run both.
// ============================================================================

const cliArgs = process.argv.slice(2);
const RUN_WINDOWS = cliArgs.includes("--windows") || !cliArgs.includes("--wsl2");
const RUN_WSL2 = cliArgs.includes("--wsl2") || !cliArgs.includes("--windows");

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

function assertIncludes(actual: string, expected: string, message: string): void {
  if (actual.includes(expected)) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message} - expected "${actual}" to include ${JSON.stringify(expected)}`);
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

/** Wall-clock bounded wait for async conditions (real model latency). */
async function waitForMs(condition: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${message}`);
}

/** Wait until the service knows the single task of a fresh per-test service. */
async function waitForSingleTask(service: AgentTaskService, timeoutMs: number): Promise<AgentTaskInfo> {
  await waitForMs(() => service.getAll().tasks.length > 0, timeoutMs, "the task to be created in the service");
  return service.getAll()[0]!;
}

const unhandledRejections: unknown[] = [];
process.on("unhandledRejection", (reason: unknown) => {
  unhandledRejections.push(reason);
});

function assertNoUnhandledRejections(): void {
  assertEqual(unhandledRejections.length, 0, "no unhandled rejections observed");
  unhandledRejections.length = 0;
}

// ============================================================================
// Environment gate (B10; missing/invalid exits non-zero, SKIP is forbidden)
// ============================================================================

const REAL_AGENT_DIR = getAgentDir();

async function runEnvironmentGate(): Promise<{ distro: string; model: Model<Api> }> {
  const distro = process.env.PIX_WSL_TEST_DISTRO;
  if (!distro || distro.trim() === "") {
    console.error(
      "[agent-task-e2e] GATE FAILED: PIX_WSL_TEST_DISTRO is empty. " +
        "Set it to a WSL2 distro name (e.g. PIX_WSL_TEST_DISTRO=Ubuntu-22.04). " +
        "This B10 gate forbids SKIP; exiting non-zero.",
    );
    process.exit(2);
  }
  const gateResolver = new WslDistroResolver();
  let distroInfo: WslDistroInfo;
  try {
    distroInfo = await gateResolver.requireDistro(distro);
  } catch (err) {
    console.error(
      `[agent-task-e2e] GATE FAILED: PIX_WSL_TEST_DISTRO="${distro}" is not a usable WSL2 distro: ${String(err)}. ` +
        "This B10 gate forbids SKIP; exiting non-zero.",
    );
    process.exit(2);
  }
  console.log(`  gate: PIX_WSL_TEST_DISTRO=${distro} (WSL2 version ${distroInfo.version}, state ${distroInfo.state})`);

  // Model credentials: the real agent dir must contain models.json and at
  // least one auth-configured model.
  const realModelsPath = join(REAL_AGENT_DIR, "models.json");
  if (!existsSync(realModelsPath)) {
    console.error(
      `[agent-task-e2e] GATE FAILED: no model credentials found (${realModelsPath} missing). ` +
        "Configure the test model credentials before running; this B10 gate forbids SKIP; exiting non-zero.",
    );
    process.exit(2);
  }
  const gateAuth = AuthStorage.create(join(REAL_AGENT_DIR, "auth.json"));
  const gateRegistry = ModelRegistry.create(gateAuth, realModelsPath);
  const configured = gateRegistry
    .getAll()
    .filter((model) => gateRegistry.hasConfiguredAuth(model))
    .sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
  if (configured.length === 0) {
    console.error(
      "[agent-task-e2e] GATE FAILED: no model in the agent dir has configured credentials. " +
        "Configure the test model credentials before running; this B10 gate forbids SKIP; exiting non-zero.",
    );
    process.exit(2);
  }

  const envModel = process.env.PIX_E2E_MODEL;
  let chosen: Model<Api> | undefined;
  if (envModel && envModel.trim() !== "") {
    const slash = envModel.indexOf("/");
    chosen =
      slash === -1
        ? configured.find((model) => model.id === envModel)
        : configured.find((model) => model.provider === envModel.slice(0, slash) && model.id === envModel.slice(slash + 1));
    if (!chosen) {
      console.error(
        `[agent-task-e2e] GATE FAILED: PIX_E2E_MODEL="${envModel}" is not an auth-configured model. ` +
          "Exiting non-zero.",
      );
      process.exit(2);
    }
  } else {
    chosen =
      configured.find((model) => /flash|free/i.test(model.id)) ?? configured[0]!;
  }
  console.log(`  gate: E2E model = ${chosen.provider}/${chosen.id} (PIX_E2E_MODEL override: ${envModel ?? "auto"})`);
  return { distro, model: chosen };
}

const { distro: DISTRO, model: MODEL } = await runEnvironmentGate();

// ============================================================================
// Throwaway environment: temp agent dir carrying a COPY of the real
// credentials + a WSL shell-tool user agent for the explicit-denial leg.
// The real agent dir is never modified.
// ============================================================================

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pix-e2e-agent-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
copyFileSync(join(REAL_AGENT_DIR, "models.json"), join(AGENT_DIR, "models.json"));
if (existsSync(join(REAL_AGENT_DIR, "auth.json"))) {
  copyFileSync(join(REAL_AGENT_DIR, "auth.json"), join(AGENT_DIR, "auth.json"));
}
mkdirSync(join(AGENT_DIR, "agents"), { recursive: true });
writeFileSync(
  join(AGENT_DIR, "agents", "e2e-shell.md"),
  [
    "---",
    "name: e2e-shell",
    "description: e2e agent explicitly referencing a shell background tool",
    "tools: [run_background]",
    "---",
    "",
    "You are an e2e shell agent.",
  ].join("\n"),
  "utf-8",
);

// ============================================================================
// Shared helpers
// ============================================================================

/** Fresh app-level service (auto-background disabled: 0 = never). */
function makeService(): AgentTaskService {
  const settings = new SettingsStore({ cwd: mkdtempSync(join(tmpdir(), "pix-e2e-settings-")) });
  settings.set("autoBackgroundMs", 0);
  const events = { record: () => {} } as unknown as ProductEventCollector;
  // 1.4.2 (R2): the service requires a real store + frozen runId.
  const store = new AgentTaskStore({
    rootDir: mkdtempSync(join(tmpdir(), "pix-e2e-store-")),
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  return new AgentTaskService({ settings, events, store, runId: "e2e-run" });
}

interface BridgeAccess {
  _session: AgentSession | null;
  _generation: { runner: SubagentRunner } | null;
  _executionContext: ProjectExecutionContext | null;
}

function accessBridge(bridge: SessionBridge): BridgeAccess {
  return bridge as unknown as BridgeAccess;
}

/** Wait until the task leaves running (terminal or waiting_input). */
async function waitTaskSettled(service: AgentTaskService, taskId: string, timeoutMs: number): Promise<AgentTaskInfo> {
  await waitForMs(
    () => {
      const info = service.getAll().tasks.find((candidate) => candidate.taskId === taskId);
      return info !== undefined && !["queued", "running"].includes(info.status);
    },
    timeoutMs,
    `task ${taskId} to settle`,
  );
  return service.getAll().tasks.find((candidate) => candidate.taskId === taskId)!;
}

/** Wait for the task's first pending input request to reach the router. */
async function waitInputRequest(service: AgentTaskService, taskId: string, timeoutMs: number): Promise<AgentTaskInputRequest> {
  await waitForMs(
    () => {
      const request = service.getActiveInputRequests().find((candidate) => candidate.taskId === taskId);
      return request !== undefined;
    },
    timeoutMs,
    `input request of task ${taskId}`,
  );
  return service.getActiveInputRequests().find((candidate) => candidate.taskId === taskId)!;
}

function readMarker(projectDir: string, fileName: string): string {
  return readFileSync(join(projectDir, fileName), "utf8").trim();
}

/** Fixed input prompt shape that makes the nested model ask reliably (probe-validated). */
function inputPrompt(markerName: string): string {
  return [
    "You must call the request_user_input tool as your FIRST action.",
    "Call it exactly once with this argument:",
    '{"questions": [{"id": "value", "header": "Value", "question": "What value should be written to ' + markerName + '?"}]}',
    `After the user answers, use the write tool to create ${markerName} in the current directory containing exactly the answer, ` +
      "then reply with the exact answer prefixed with ANSWER:.",
  ].join("\n");
}

function answerResponse(request: AgentTaskInputRequest, answer: string): RequestUserInputResponse {
  return { id: request.requestId, answers: { [request.request.questions[0]!.id]: answer } };
}

// ============================================================================
// Windows leg
// ============================================================================

const WIN_PROJECT = mkdtempSync(join(tmpdir(), "pix-e2e-win-project-"));
const WIN_LOCATION: ProjectLocation = {
  path: WIN_PROJECT,
  physicalPath: WIN_PROJECT,
  name: basename(WIN_PROJECT),
  environment: { kind: "windows" },
};

if (RUN_WINDOWS) {
  await run("windows: foreground agent tool completes and rebuilds SubagentDetails", async () => {
    const service = makeService();
    const bridge = new SessionBridge({ agentTaskService: service });
    await bridge.start(WIN_LOCATION);
    try {
      await bridge.setModel(MODEL.provider, MODEL.id);
      const runner = accessBridge(bridge)._generation!.runner;
      const result = await runner.run(
        {
          mode: "single",
          agentScope: "user",
          tasks: [
            {
              prompt:
                "Use the write tool to create the file fg-marker.txt in the current directory containing the text " +
                "foreground-ok. Then reply with the single word DONE.",
            },
          ],
        },
        undefined,
        undefined,
        undefined,
        { parentToolCallId: "e2e-win-fg" },
      );
      assert(!("kind" in result), "foreground run resolves with SubagentDetails, never a group handle");
      assert(isSubagentDetails(result), "foreground result passes the shared SubagentDetails guard");
      const details = result as SubagentDetails;
      assertEqual(details.mode, "single", "foreground details preserve the single mode");
      assertEqual(details.results.length, 1, "foreground details carry one result");
      assertEqual(details.results[0]?.status, "completed", "foreground result is completed");
      assertIncludes(details.results[0]?.finalOutput ?? "", "DONE", "foreground final output present");
      assertEqual(details.results[0]?.agentName, "general-purpose", "foreground result names general-purpose");
      assertEqual(
        readMarker(WIN_PROJECT, "fg-marker.txt"),
        "foreground-ok",
        "the nested session wrote the marker through the real write tool",
      );
    } finally {
      await bridge.dispose();
      await service.dispose("app_shutdown");
    }
    assertNoUnhandledRejections();
  });

  await run("windows: background returns AgentTaskGroupHandle and the task continues", async () => {
    const service = makeService();
    const bridge = new SessionBridge({ agentTaskService: service });
    await bridge.start(WIN_LOCATION);
    try {
      await bridge.setModel(MODEL.provider, MODEL.id);
      const runner = accessBridge(bridge)._generation!.runner;
      const handle = (await runner.run(
        {
          mode: "single",
          agentScope: "user",
          tasks: [
            {
              prompt:
                "Use the write tool to create the file bg-marker.txt in the current directory containing the text " +
                "background-ok. Then reply with the single word DONE.",
            },
          ],
        },
        undefined,
        undefined,
        undefined,
        { parentToolCallId: "e2e-win-bg", runInBackground: true },
      )) as AgentTaskGroupHandle;
      assertEqual(handle.kind, "agent_task_group", "background run resolves with an AgentTaskGroupHandle");
      assertEqual(handle.mode, "single", "group handle preserves the single mode");
      assertEqual(handle.tasks.length, 1, "group handle lists one task");
      assertEqual(handle.tasks[0]?.kind, "agent_task", "group child is an AgentTaskHandle");
      assertEqual(handle.tasks[0]?.generation, 0, "group child carries generation 0");
      assertEqual(handle.tasks[0]?.presentation, "background", "group child is presented as background");

      const taskId = handle.tasks[0]!.taskId;
      const initial = service.getAll().tasks.find((info) => info.taskId === taskId)!;
      assert(
        initial.status === "queued" || initial.status === "running",
        `the task is still active when the handle returns (status=${initial.status})`,
      );

      const info = await waitTaskSettled(service, taskId, 300_000);
      assertEqual(info.status, "completed", "the backgrounded task continues to completion in the service");
      assertIncludes(info.finalOutput, "DONE", "background task produced final output");
      assertEqual(
        readMarker(WIN_PROJECT, "bg-marker.txt"),
        "background-ok",
        "the backgrounded nested session wrote its marker while detached",
      );
      assertEqual(info.presentation, "background", "the completed task stays presented as background");
    } finally {
      await bridge.dispose();
      await service.dispose("app_shutdown");
    }
    assertNoUnhandledRejections();
  });

  await run("windows: nested requestUserInput routes to the panel and respondInput continues the task", async () => {
    const service = makeService();
    const bridge = new SessionBridge({ agentTaskService: service });
    await bridge.start(WIN_LOCATION);
    try {
      await bridge.setModel(MODEL.provider, MODEL.id);
      const runner = accessBridge(bridge)._generation!.runner;
      const eventsSeen: string[] = [];
      service.onEvent((event: AgentTaskServiceEvent) => {
        if (event.type === "task_input") eventsSeen.push("task_input");
        if (event.type === "task_input_dismissed") eventsSeen.push(`dismissed:${event.reason}`);
        if (event.type === "task_state" && event.task.status === "waiting_input") eventsSeen.push("waiting_input");
      });

      const runPromise = runner.run(
        { mode: "single", agentScope: "user", tasks: [{ prompt: inputPrompt("input-marker.txt") }] },
        undefined,
        undefined,
        undefined,
        { parentToolCallId: "e2e-win-input" },
      ) as Promise<SubagentDetails>;
      const taskInfo = await waitForSingleTask(service, 60_000);
      const request = await waitInputRequest(service, taskInfo.taskId, 240_000);
      assertIncludes(eventsSeen.join(","), "task_input", "the nested request reached the input router (task_input event)");
      assertIncludes(eventsSeen.join(","), "waiting_input", "the task flipped to waiting_input while the request is shown");

      const responded = service.respondInput(request.taskId, request.requestId, request.generation, answerResponse(request, "e2e-42"));
      assertEqual(responded, true, "respondInput accepts the taskId+requestId+generation triple");
      assertEqual(service.respondInput(request.taskId, "never-seen", request.generation, answerResponse(request, "x")), false, "wrong requestId is rejected");

      const details = await runPromise;
      assertEqual(details.results[0]?.status, "completed", "the task continues to completion after the answer");
      assertIncludes(details.results[0]?.finalOutput ?? "", "e2e-42", "the model consumed the answered value");
      assertEqual(
        readMarker(WIN_PROJECT, "input-marker.txt"),
        "e2e-42",
        "the answered value was written by the nested session",
      );
      assertEqual(service.getActiveInputRequests().length, 0, "the router drained the answered request");
      assertIncludes(eventsSeen.join(","), "dismissed:answered", "task_input_dismissed emitted with reason answered");
    } finally {
      await bridge.dispose();
      await service.dispose("app_shutdown");
    }
    assertNoUnhandledRejections();
  });

  await run("windows: bounded app shutdown cancels tasks and settles pending input", async () => {
    const service = makeService();
    const bridge = new SessionBridge({ agentTaskService: service });
    await bridge.start(WIN_LOCATION);
    try {
      await bridge.setModel(MODEL.provider, MODEL.id);
      const runner = accessBridge(bridge)._generation!.runner;
      const dismissedReasons: string[] = [];
      service.onEvent((event: AgentTaskServiceEvent) => {
        if (event.type === "task_input_dismissed") dismissedReasons.push(event.reason);
      });

      const sleeping = (await runner.run(
        { mode: "single", agentScope: "user", tasks: [{ prompt: "Run the bash command: sleep 120. Then reply DONE." }] },
        undefined,
        undefined,
        undefined,
        { parentToolCallId: "e2e-win-sleep", runInBackground: true },
      )) as AgentTaskGroupHandle;
      const waiting = (await runner.run(
        { mode: "single", agentScope: "user", tasks: [{ prompt: inputPrompt("shutdown-input.txt") }] },
        undefined,
        undefined,
        undefined,
        { parentToolCallId: "e2e-win-wait", runInBackground: true },
      )) as AgentTaskGroupHandle;

      const sleepId = sleeping.tasks[0]!.taskId;
      const waitId = waiting.tasks[0]!.taskId;
      await waitForMs(
        () => service.getAll().tasks.find((info) => info.taskId === sleepId)?.status === "running",
        120_000,
        "sleeping task to start running",
      );
      await waitForMs(
        () => service.getAll().tasks.find((info) => info.taskId === waitId)?.status === "waiting_input",
        120_000,
        "input-waiting task to reach waiting_input",
      );
      assert(service.getActiveInputRequests().length > 0, "a request is pending when shutdown starts");

      const startedAt = Date.now();
      await service.dispose("app_shutdown");
      const elapsed = Date.now() - startedAt;
      assert(elapsed < 30_000, `dispose settles within the bounded abort/cleanup window (${elapsed}ms)`);
      const sleepInfo = service.getAll().tasks.find((info) => info.taskId === sleepId)!;
      const waitInfo = service.getAll().tasks.find((info) => info.taskId === waitId)!;
      assertEqual(sleepInfo.status, "cancelled", "the running task is cancelled by app shutdown");
      assertEqual(waitInfo.status, "cancelled", "the input-waiting task is cancelled by app shutdown");
      assertEqual(service.getActiveInputRequests().length, 0, "pending input requests are settled by shutdown");
      assertIncludes(dismissedReasons.join(","), "shutdown", "the pending request is dismissed with reason shutdown");
    } finally {
      await bridge.dispose();
    }
    assertNoUnhandledRejections();
  });
}

// ============================================================================
// WSL2 leg
// ============================================================================

/** WSL1-shaped resolver fixture: the real requireDistro logic sees version 1. */
class FakeWsl1Resolver extends WslDistroResolver {
  override async list(): Promise<WslDistroInfo[]> {
    return [{ name: "Legacy-Distro", state: "Running", version: 1, isDefault: true }];
  }
}

if (RUN_WSL2) {
  const wslResolver = new WslDistroResolver();
  const home = await wslResolver.getHome(DISTRO);
  const linuxDir = `${home}/pix-e2e-${Date.now()}`;
  const wslRuntime: WslRuntime = createWslRuntime({
    distro: DISTRO,
    readyTimeoutMs: 60_000,
    killTimeoutMs: 10_000,
    keepAliveIntervalMs: 0,
  });
  let wslLocation: ProjectLocation | undefined;
  try {
    await wslRuntime.warmUp();
    const mkdir = await wslRuntime.run(["mkdir", "-p", linuxDir], { timeoutMs: 60_000 });
    assertEqual(mkdir.exitCode, 0, `WSL project directory created in the distro (${linuxDir})`);
    wslLocation = await resolveProjectLocation({ environment: { kind: "wsl", distro: DISTRO }, logicalPath: linuxDir }, wslResolver);
    console.log(`  wsl2: project logicalPath=${wslLocation.path} physicalPath=${wslLocation.physicalPath}\n`);

    const wslCat = async (fileName: string): Promise<string> => {
      const result = await wslRuntime.run(["cat", `${linuxDir}/${fileName}`], { timeoutMs: 30_000 });
      return result.stdout.toString("utf8").trim();
    };

    await run("wsl2: parent SessionBridge excludes shell background tools and runs on the logical Linux cwd", async () => {
      const service = makeService();
      const bridge = new SessionBridge({ agentTaskService: service });
      await bridge.start(wslLocation!);
      try {
        const access = accessBridge(bridge);
        assertEqual(access._executionContext?.isWsl, true, "parent execution context is WSL");
        assertEqual(access._executionContext?.logicalCwd, linuxDir, "parent cwd is the logical Linux path");
        assert(access._executionContext?.executionBackend !== undefined, "parent context owns a WSL execution backend");
        const toolNames = access._session!.getAllTools().map((tool) => tool.name);
        assert(!toolNames.includes("run_background"), "parent session has no run_background tool (denylisted)");
        assert(!toolNames.includes("read_output"), "parent session has no read_output tool (denylisted)");
        assert(!toolNames.includes("stop_process"), "parent session has no stop_process tool (denylisted)");
      } finally {
        await bridge.dispose();
        await service.dispose("app_shutdown");
      }
      assertNoUnhandledRejections();
    });

    await run("wsl2: runtime creates its own WSL backend; cwd/paths/commands use the logical Linux environment", async () => {
      const service = makeService();
      const bridge = new SessionBridge({ agentTaskService: service });
      await bridge.start(wslLocation!);
      try {
        await bridge.setModel(MODEL.provider, MODEL.id);
        const runner = accessBridge(bridge)._generation!.runner;
        const details = (await runner.run(
          {
            mode: "single",
            agentScope: "user",
            tasks: [
              {
                prompt:
                  "Run the bash command: pwd. Then use the write tool to create the file wsl-cwd-marker.txt in the " +
                  "current directory containing exactly the output of pwd. Then reply with the single word DONE.",
              },
            ],
          },
          undefined,
          undefined,
          undefined,
          { parentToolCallId: "e2e-wsl-cwd" },
        )) as SubagentDetails;
        assertEqual(details.results[0]?.status, "completed", "WSL foreground task completed");
        assertEqual(
          await wslCat("wsl-cwd-marker.txt"),
          linuxDir,
          "the marker written inside the distro equals the logical Linux cwd (paths/commands ran in Linux)",
        );
        const info = await waitForSingleTask(service, 30_000);
        assertEqual(info.project.environment.kind, "wsl", "the frozen spec project is the WSL location");
        assertEqual(info.project.path, linuxDir, "the frozen spec project path is the logical Linux path");
        assertEqual(info.status, "completed", "the WSL task completed through the runtime's own WSL backend");
      } finally {
        await bridge.dispose();
        await service.dispose("app_shutdown");
      }
      assertNoUnhandledRejections();
    });

    await run("wsl2: background returns the group handle and the task continues in the distro", async () => {
      const service = makeService();
      const bridge = new SessionBridge({ agentTaskService: service });
      await bridge.start(wslLocation!);
      try {
        await bridge.setModel(MODEL.provider, MODEL.id);
        const runner = accessBridge(bridge)._generation!.runner;
        const handle = (await runner.run(
          {
            mode: "single",
            agentScope: "user",
            tasks: [
              {
                prompt:
                  "Use the write tool to create the file wsl-bg-marker.txt in the current directory containing the " +
                  "text background-ok. Then reply with the single word DONE.",
              },
            ],
          },
          undefined,
          undefined,
          undefined,
          { parentToolCallId: "e2e-wsl-bg", runInBackground: true },
        )) as AgentTaskGroupHandle;
        assertEqual(handle.kind, "agent_task_group", "WSL background run resolves with the group handle");
        const taskId = handle.tasks[0]!.taskId;
        const initial = service.getAll().tasks.find((info) => info.taskId === taskId)!;
        assert(
          initial.status === "queued" || initial.status === "running",
          `WSL task still active when the handle returns (status=${initial.status})`,
        );
        const info = await waitTaskSettled(service, taskId, 300_000);
        assertEqual(info.status, "completed", "WSL background task continued to completion");
        assertEqual(
          await wslCat("wsl-bg-marker.txt"),
          "background-ok",
          "the backgrounded WSL nested session wrote its marker inside the distro",
        );
      } finally {
        await bridge.dispose();
        await service.dispose("app_shutdown");
      }
      assertNoUnhandledRejections();
    });

    await run("wsl2: nested requestUserInput routes through the input router and respondInput continues", async () => {
      const service = makeService();
      const bridge = new SessionBridge({ agentTaskService: service });
      await bridge.start(wslLocation!);
      try {
        await bridge.setModel(MODEL.provider, MODEL.id);
        const runner = accessBridge(bridge)._generation!.runner;
        const eventsSeen: string[] = [];
        service.onEvent((event: AgentTaskServiceEvent) => {
          if (event.type === "task_input") eventsSeen.push("task_input");
          if (event.type === "task_state" && event.task.status === "waiting_input") eventsSeen.push("waiting_input");
        });

        const runPromise = runner.run(
          { mode: "single", agentScope: "user", tasks: [{ prompt: inputPrompt("wsl-input-marker.txt") }] },
          undefined,
          undefined,
          undefined,
          { parentToolCallId: "e2e-wsl-input" },
        ) as Promise<SubagentDetails>;
        const taskInfo = await waitForSingleTask(service, 60_000);
        const request = await waitInputRequest(service, taskInfo.taskId, 240_000);
        assertIncludes(eventsSeen.join(","), "task_input", "WSL nested request reached the input router");
        assertIncludes(eventsSeen.join(","), "waiting_input", "WSL task flipped to waiting_input");
        const responded = service.respondInput(request.taskId, request.requestId, request.generation, answerResponse(request, "e2e-42"));
        assertEqual(responded, true, "WSL respondInput accepts the triple");
        const details = await runPromise;
        assertEqual(details.results[0]?.status, "completed", "WSL task continued to completion after the answer");
        assertIncludes(details.results[0]?.finalOutput ?? "", "e2e-42", "WSL model consumed the answered value");
        assertEqual(await wslCat("wsl-input-marker.txt"), "e2e-42", "the answered value was written inside the distro");
      } finally {
        await bridge.dispose();
        await service.dispose("app_shutdown");
      }
      assertNoUnhandledRejections();
    });

    await run("wsl2: explicit shell background tool reference fails as tool_unavailable", async () => {
      const service = makeService();
      const bridge = new SessionBridge({ agentTaskService: service });
      await bridge.start(wslLocation!);
      try {
        await bridge.setModel(MODEL.provider, MODEL.id);
        const runner = accessBridge(bridge)._generation!.runner;
        const details = (await runner.run(
          {
            mode: "single",
            agentScope: "both",
            tasks: [{ subagent_type: "e2e-shell", prompt: "Run a background command." }],
          },
          undefined,
          undefined,
          undefined,
          { parentToolCallId: "e2e-wsl-explicit" },
        )) as SubagentDetails;
        assertEqual(details.results[0]?.status, "failed", "explicit shell-tool agent fails in WSL");
        assertEqual(details.results[0]?.failureReason, "tool_unavailable", "failure reason is tool_unavailable");
      } finally {
        await bridge.dispose();
        await service.dispose("app_shutdown");
      }
      assertNoUnhandledRejections();
    });

    await run("wsl2: all-tools nested session cannot re-add run_background/read_output/stop_process", async () => {
      const service = makeService();
      const bridge = new SessionBridge({ agentTaskService: service });
      await bridge.start(wslLocation!);
      try {
        await bridge.setModel(MODEL.provider, MODEL.id);
        const runner = accessBridge(bridge)._generation!.runner;
        const details = (await runner.run(
          {
            mode: "single",
            agentScope: "user",
            tasks: [
              {
                prompt:
                  "Call the run_background tool with the argument command='echo probe' exactly once. " +
                  "The tool is intentionally unavailable in this environment. " +
                  "After the call attempt, reply with exactly MISSING_TOOL and nothing else.",
              },
            ],
          },
          undefined,
          undefined,
          undefined,
          { parentToolCallId: "e2e-wsl-all-tools" },
        )) as SubagentDetails;
        const output = details.results[0]?.finalOutput ?? "";
        const unavailable = /MISSING_TOOL|not (available|found)|unavailable|does not exist|not registered/i.test(output);
        assert(unavailable, `WSL nested session reports the shell background tool unavailable (output: "${output.slice(0, 160)}")`);
        assert(
          (details.results[0]?.activities ?? []).every((activity) => activity.toolName !== "run_background"),
          "no run_background tool execution was ever observed in the WSL nested session",
        );
      } finally {
        await bridge.dispose();
        await service.dispose("app_shutdown");
      }
      assertNoUnhandledRejections();
    });

    await run("wsl2: bounded app shutdown cancels tasks inside the distro", async () => {
      const service = makeService();
      const bridge = new SessionBridge({ agentTaskService: service });
      await bridge.start(wslLocation!);
      try {
        await bridge.setModel(MODEL.provider, MODEL.id);
        const runner = accessBridge(bridge)._generation!.runner;
        const sleeping = (await runner.run(
          { mode: "single", agentScope: "user", tasks: [{ prompt: "Run the bash command: sleep 120. Then reply DONE." }] },
          undefined,
          undefined,
          undefined,
          { parentToolCallId: "e2e-wsl-sleep", runInBackground: true },
        )) as AgentTaskGroupHandle;
        const taskId = sleeping.tasks[0]!.taskId;
        await waitForMs(
          () => service.getAll().tasks.find((info) => info.taskId === taskId)?.status === "running",
          120_000,
          "WSL sleeping task to start running",
        );
        const startedAt = Date.now();
        await service.dispose("app_shutdown");
        const elapsed = Date.now() - startedAt;
        assert(elapsed < 30_000, `WSL dispose settles within the bounded abort/cleanup window (${elapsed}ms)`);
        const info = service.getAll().tasks.find((candidate) => candidate.taskId === taskId)!;
        assertEqual(info.status, "cancelled", "the WSL running task is cancelled by app shutdown");
      } finally {
        await bridge.dispose();
      }
      assertNoUnhandledRejections();
    });
  } finally {
    // Distro-side cleanup: remove the throwaway project directory.
    try {
      await wslRuntime.run(["rm", "-rf", linuxDir], { timeoutMs: 30_000 });
    } catch {
      // Best-effort cleanup.
    }
    await wslRuntime.dispose();
  }

  await run("wsl1: ProjectLocation/WSL validation refuses WSL1 distros (no project, no backgrounding entry)", async () => {
    const distros = await wslResolver.list();
    const realV1 = distros.find((candidate) => candidate.version === 1);
    const usedFixture = realV1 === undefined;
    const resolver = realV1 ? wslResolver : new FakeWsl1Resolver();
    const distroName = realV1?.name ?? "Legacy-Distro";
    const context = usedFixture
      ? "no real WSL1 distro present; using the WSL1-shaped resolver fixture (real requireDistro version check)"
      : `real WSL1 distro "${realV1!.name}" present`;
    console.log(`  wsl1: ${context}\n`);

    let resolveError: string | undefined;
    try {
      await resolveProjectLocation({ environment: { kind: "wsl", distro: distroName }, logicalPath: "/home/x" }, resolver);
    } catch (err) {
      resolveError = err instanceof Error ? err.message : String(err);
    }
    assert(resolveError !== undefined, "resolveProjectLocation rejects the WSL1 distro");
    assertIncludes(resolveError ?? "", "version 1", "the rejection names the WSL1 version");
    assertIncludes(resolveError ?? "", "WSL2", "the rejection points at WSL2 as the requirement");

    const location: ProjectLocation = {
      path: "/home/x",
      physicalPath: `\\\\wsl.localhost\\${distroName}\\home\\x`,
      name: "x",
      environment: { kind: "wsl", distro: distroName },
    };
    let contextError: string | undefined;
    try {
      const context = await createProjectExecutionContext(location, { resolver });
      await disposeProjectExecutionContext(context);
    } catch (err) {
      contextError = err instanceof Error ? err.message : String(err);
    }
    assert(contextError !== undefined, "createProjectExecutionContext rejects the WSL1 distro (no project context)");
  });
}

// ============================================================================

rmSync(AGENT_DIR, { recursive: true, force: true });
rmSync(WIN_PROJECT, { recursive: true, force: true });

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
