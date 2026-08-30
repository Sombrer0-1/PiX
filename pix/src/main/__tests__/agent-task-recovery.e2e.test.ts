/**
 * PiX 1.4.2 five-timepoint hard-kill recovery E2E (design plan §8 R6, PRD
 * §7.8 / §10.3).
 *
 * Every scenario runs the REAL AgentTaskService + AgentTaskRuntime against a
 * REAL model provider inside a child process (this same file re-executed via
 * `node --import tsx` with PIX_RECOVERY_E2E_ROLE=child). The child drives the
 * task to the target timepoint and writes a marker; the parent then hard-kills
 * the child process tree (taskkill /T /F, TerminateProcess fallback) - a
 * genuine crash: no prepareShutdown, no close marker. The parent "reopens the
 * app" exactly like index.ts does at ready: a FRESH AgentTaskService over the
 * SAME store root, restoreAll() first, then the safe resume path. The five
 * timepoints of PRD §7.8:
 *
 * - queued: 5 parallel sleep tasks occupy the 4 global slots; the 5th is
 *   killed while queued. Restart hydrates ALL five as interrupted and the
 *   queued one resumes to completion (new finalized assistant message).
 * - model: the child kills right after the model's first response finalized on
 *   disk AND the persisted checkpoint references the real transcript file (the
 *   SessionManager only writes the file when the first assistant message ends;
 *   a kill earlier would leave a checkpoint pointing at a never-written file).
 *   The next generation is still in flight when the kill lands. Restart
 *   hydrates interrupted; resume produces a new finalized assistant message.
 * - tool: the child kills when the first tool activity starts (bash sleep) -
 *   the transcript holds an assistant tool call with no ToolResult. The
 *   parent additionally truncates the session JSONL tail (deterministic crash
 *   signature); resume repairs it inside the budget reservation (full
 *   hash-named .bak preserved, atomic prefix replace), closes the open call
 *   with exactly one interrupted_unknown ToolResult and completes with a new
 *   finalized assistant message. The interrupted call is only closed, never
 *   auto-replayed.
 * - input: killed while the task waits for user input. Restart hydrates
 *   interrupted; resume settles the unanswered input as cancelled
 *   (input_settled) and the resumed round completes (when the model re-asks,
 *   the parent answers the fresh request through respondInput).
 * - post-complete: killed AFTER the task durably completed (index + log).
 *   Restart keeps it completed - never interrupted; resume is rejected as
 *   task_not_interrupted.
 *
 * Real disk artifacts are verified per scenario (design plan §6.4): index.json
 * / index.prev.json, events.jsonl, checkpoint.json, sessions/*.jsonl and the
 * corruption .bak; the recovery-completeness rate (PRD §4.3) is computed from
 * fully hydrated tasks (identity, status, last checkpoint seq and Plan marker
 * consistency) and asserted as 1.0. The recovery product events are read from
 * the REAL collector's log: agent_task_restored / agent_task_interrupted /
 * agent_task_resume_requested / agent_task_resume_succeeded /
 * agent_task_completed.
 *
 * Environment gate (design plan §8, R6): real model credentials must exist in
 * the agent dir (models.json + at least one auth-configured model); missing
 * credentials exit non-zero at startup - SKIP is forbidden. The model under
 * test is PIX_E2E_MODEL (provider/modelId) when set, otherwise the first
 * auth-configured model whose id matches flash|free (fallback: the first
 * auth-configured model). The real agent dir is never modified: credentials
 * are copied into a throwaway agent dir per scenario.
 *
 * Run with: npm exec tsx -- src/main/__tests__/agent-task-recovery.e2e.test.ts
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  ModelRegistry,
  getAgentDir,
  type RequestUserInputResponse,
} from "@earendil-works/pi-coding-agent";
import type { AgentTaskInfo, AgentTaskInputRequest } from "../../shared/agent-task-types.js";
import type { ProjectLocation } from "../../shared/project-location.js";
import { AgentTaskStore } from "../agent-task/agent-task-store.js";
import { workspaceIdOf } from "../agent-task/agent-task-identity.js";
import { RESUME_INTERRUPTED_TOOL_RESULT_TEXT, RESUME_NOTE_CUSTOM_TYPE } from "../agent-task/agent-task-resumer.js";
import { RESUME_TURN_MESSAGE } from "../agent-task/agent-task-runtime.js";
import {
  AgentTaskService,
  __setAgentTaskServiceHooksForTests,
  type AgentTaskServiceEvent,
  type AgentTaskSubmissionContext,
} from "../agent-task/agent-task-service.js";
import type { SubagentTaskItem } from "../subagent/types.js";
import { ProductEventCollector } from "../product-event-collector.js";
import { SettingsStore } from "../settings-store.js";

// ============================================================================
// Test harness (matches agent-task-e2e.test.ts style)
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

/** Wall-clock bounded wait for async conditions (real model latency). */
async function waitForMs(condition: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${message}`);
}

/** Wall-clock bounded wait for async conditions. */
async function waitForAsyncMs(condition: () => Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${message}`);
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
// Environment gate (R6; missing credentials exits non-zero, SKIP is forbidden)
// ============================================================================

const REAL_AGENT_DIR = getAgentDir();

async function runEnvironmentGate(): Promise<Model<Api>> {
  const realModelsPath = join(REAL_AGENT_DIR, "models.json");
  if (!existsSync(realModelsPath)) {
    console.error(
      `[agent-task-recovery.e2e] GATE FAILED: no model credentials found (${realModelsPath} missing). ` +
        "Configure the test model credentials before running; this R6 gate forbids SKIP; exiting non-zero.",
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
      "[agent-task-recovery.e2e] GATE FAILED: no model in the agent dir has configured credentials. " +
        "Configure the test model credentials before running; this R6 gate forbids SKIP; exiting non-zero.",
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
        `[agent-task-recovery.e2e] GATE FAILED: PIX_E2E_MODEL="${envModel}" is not an auth-configured model. ` +
          "Exiting non-zero.",
      );
      process.exit(2);
    }
  } else {
    chosen = configured.find((model) => /flash|free/i.test(model.id)) ?? configured[0]!;
  }
  console.log(`  gate: recovery E2E model = ${chosen.provider}/${chosen.id} (PIX_E2E_MODEL override: ${envModel ?? "auto"})`);
  return chosen;
}

const MODEL = await runEnvironmentGate();

// ============================================================================
// Child role: drive a real task to the target timepoint, then stay alive
// until the parent hard-kills the process (a genuine crash).
// ============================================================================

type CrashTimepoint = "queued" | "model" | "tool" | "input" | "post_complete";

const CHILD_ROLE = process.env.PIX_RECOVERY_E2E_ROLE === "child";
const THIS_FILE = fileURLToPath(import.meta.url);
const PIX_ROOT = resolve(dirname(THIS_FILE), "..", "..", "..");

function sleepPrompt(): string {
  return "Run the bash command: sleep 10. Then reply with the single word DONE.";
}

function timepointPrompt(timepoint: CrashTimepoint): string {
  switch (timepoint) {
    case "queued":
      return sleepPrompt();
    case "model":
      // Short and explicit: the crash-safe kill point is the FIRST finalized
      // response (the transcript file materializes then), and the resumed
      // round must finish quickly too.
      return [
        "Write a short one-paragraph analysis of the current directory (at most 50 words).",
        "Then use the write tool to create the file model-marker.txt in the current directory containing exactly model-ok,",
        "then reply with the single word DONE.",
      ].join("\n");
    case "tool":
      return [
        "Run the bash command: sleep 10.",
        "Then use the write tool to create the file tool-marker.txt in the current directory containing exactly tool-ok,",
        "then reply with the single word DONE.",
      ].join("\n");
    case "input":
      return [
        "You must call the request_user_input tool as your FIRST action.",
        "Call it exactly once with this argument:",
        '{"questions": [{"id": "value", "header": "Value", "question": "What value should be written to input-marker.txt?"}]}',
        "After the user answers, use the write tool to create input-marker.txt in the current directory containing exactly the answer, " +
          "then reply with the exact answer prefixed with ANSWER:.",
      ].join("\n");
    case "post_complete":
      return [
        "Use the write tool to create the file post-marker.txt in the current directory containing exactly post-ok.",
        "Then reply with the single word DONE.",
      ].join("\n");
  }
}

/**
 * Wait until the on-disk task record says terminal (used by the child).
 * index.json is pretty-printed by the store (JSON.stringify(value, null, 2)),
 * so the status is matched structurally, not by raw text.
 */
async function diskSaysTerminal(storeRoot: string, projectDir: string, taskId: string, status: string): Promise<boolean> {
  try {
    const ws = workspaceIdOf(projectDir);
    const indexRaw = readFileSync(join(storeRoot, ws, "index.json"), "utf-8");
    const index = JSON.parse(indexRaw) as { tasks?: Array<{ taskId?: string; status?: string }> };
    if (!(index.tasks ?? []).some((entry) => entry.taskId === taskId && entry.status === status)) {
      return false;
    }
    const eventsRaw = readFileSync(join(storeRoot, ws, taskId, "events.jsonl"), "utf-8");
    return eventsRaw.includes(`"to":"${status}"`);
  } catch {
    return false;
  }
}

/** Wait until the on-disk events log contains a given JSON fragment (used by the child). */
async function diskContainsEvent(storeRoot: string, projectDir: string, taskId: string, fragment: string): Promise<boolean> {
  try {
    const ws = workspaceIdOf(projectDir);
    const eventsRaw = readFileSync(join(storeRoot, ws, taskId, "events.jsonl"), "utf-8");
    return eventsRaw.includes(fragment);
  } catch {
    return false;
  }
}

/**
 * True once the task session transcript file materialized on disk (the
 * SessionManager only writes the file when the FIRST assistant message
 * finalizes) and contains a given JSON fragment (used by the child).
 */
async function diskSessionContains(storeRoot: string, projectDir: string, taskId: string, fragment: string): Promise<boolean> {
  try {
    const ws = workspaceIdOf(projectDir);
    const sessionsDir = join(storeRoot, ws, taskId, "sessions");
    if (!existsSync(sessionsDir)) {
      return false;
    }
    for (const fileName of readdirSync(sessionsDir)) {
      if (readFileSync(join(sessionsDir, fileName), "utf-8").includes(fragment)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * True once the persisted checkpoint.json references a session file that
 * actually exists on disk (the crash-safe checkpoint point: the file was
 * flushed BEFORE the checkpoint write in the runtime's serialized chain).
 */
async function diskCheckpointReferencesRealSession(storeRoot: string, projectDir: string, taskId: string): Promise<boolean> {
  try {
    const ws = workspaceIdOf(projectDir);
    const cpPath = join(storeRoot, ws, taskId, "checkpoint.json");
    if (!existsSync(cpPath)) {
      return false;
    }
    const cp = JSON.parse(readFileSync(cpPath, "utf-8")) as { sessionFileName?: string | null };
    if (cp.sessionFileName === null || cp.sessionFileName === undefined) {
      return false;
    }
    return existsSync(join(storeRoot, ws, taskId, "sessions", cp.sessionFileName));
  } catch {
    return false;
  }
}

/** The child: real service + store on the env-provided paths, no prepareShutdown. */
async function runChild(model: Model<Api>): Promise<void> {
  const timepoint = process.env.PIX_RECOVERY_E2E_TIMEPOINT as CrashTimepoint;
  const storeRoot = process.env.PIX_RECOVERY_E2E_STORE_ROOT!;
  const projectDir = process.env.PIX_RECOVERY_E2E_PROJECT!;
  const controlDir = process.env.PIX_RECOVERY_E2E_CONTROL!;
  const runId = process.env.PIX_RECOVERY_E2E_RUN_ID!;
  const taskCount = Number(process.env.PIX_RECOVERY_E2E_TASK_COUNT ?? "1");
  const agentDir = getAgentDir();

  const settings = new SettingsStore({
    cwd: process.env.PIX_RECOVERY_E2E_SETTINGS ?? mkdtempSync(join(tmpdir(), "pix-recovery-e2e-child-settings-")),
  });
  settings.set("enableProductAnalytics", true);
  settings.set("autoBackgroundMs", 0);
  const events = new ProductEventCollector({ settings, agentDir });
  const store = new AgentTaskStore({
    rootDir: storeRoot,
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const service = new AgentTaskService({ settings, events, store, runId });

  const location: ProjectLocation = {
    path: projectDir,
    physicalPath: projectDir,
    name: basename(projectDir),
    environment: { kind: "windows" },
  };
  const auth = AuthStorage.create(join(agentDir, "auth.json"));
  const registry = ModelRegistry.create(auth, join(agentDir, "models.json"));
  const context: AgentTaskSubmissionContext = {
    parentSessionId: "e2e-parent-session",
    parentToolCallId: `e2e-${timepoint}`,
    project: location,
    agentDir,
    loadedAgents: undefined,
    modelRegistry: registry,
    parentRuntime: { model, thinkingLevel: "off", executionMode: "approval", verificationGate: false, acp: false },
    requestUserInput: async (request) => ({ id: request.id, answers: {}, cancelled: false }),
    hostDisposed: new Promise(() => {}),
  };

  const tasks: SubagentTaskItem[] = [];
  for (let index = 0; index < taskCount; index++) {
    tasks.push({ prompt: index === taskCount - 1 ? timepointPrompt(timepoint) : sleepPrompt() });
  }
  const handle = await service.createTaskGroup(
    { mode: taskCount > 1 ? "parallel" : "single", agentScope: "user", tasks, runInBackground: true },
    context,
    "background",
  );
  const targetTaskId = handle.tasks[taskCount - 1]!.taskId;

  const markerPath = join(controlDir, "reached.json");
  let written = false;
  const writeMarker = (status: string): void => {
    if (written) {
      return;
    }
    written = true;
    writeFileSync(markerPath, JSON.stringify({ timepoint, taskId: targetTaskId, status, ts: Date.now() }), "utf-8");
  };

  // Watchdog: if the target settles before the timepoint is reached, record
  // the real state so the parent fails fast with context instead of a timeout.
  // For post_complete, "completed" IS the expected state - the case below
  // writes the authoritative marker after the durability check.
  const unsubscribe = service.onEvent((event: AgentTaskServiceEvent) => {
    if (event.type === "task_state" && event.task.taskId === targetTaskId && !written) {
      const status = event.task.status;
      if (status === "completed" || status === "failed" || status === "cancelled") {
        if (timepoint === "post_complete" && status === "completed") {
          return;
        }
        writeMarker(`settled_${status}`);
      }
    }
  });

  const statusOf = (taskId: string): string | undefined =>
    service.getAll().tasks.find((info) => info.taskId === taskId)?.status;

  try {
    switch (timepoint) {
      case "queued":
        await waitForMs(
          () => {
            const active = service.getAll().tasks.filter((info) => info.status === "running" || info.status === "queued").length;
            return active >= 4 && statusOf(targetTaskId) === "queued";
          },
          180_000,
          "four slots held and the target task queued",
        );
        writeMarker("queued");
        break;
      case "model":
        // Kill right after the model's FIRST response finalized on disk (the
        // SessionManager only materializes the transcript file when the first
        // assistant message ends) AND the persisted checkpoint references that
        // real file (a kill before that would leave a checkpoint pointing at a
        // never-written file, which the strict resumer scan rejects). The next
        // generation is still in flight when the kill lands.
        await waitForAsyncMs(
          () => diskSessionContains(storeRoot, projectDir, targetTaskId, '"role":"assistant"'),
          240_000,
          "first model response finalized in the session transcript",
        );
        await waitForAsyncMs(
          () => diskCheckpointReferencesRealSession(storeRoot, projectDir, targetTaskId),
          60_000,
          "persisted checkpoint referencing the real session file",
        );
        writeMarker("running");
        break;
      case "tool":
        // First tool activity of the target task = mid-tool-execution.
        await new Promise<void>((resolvePromise) => {
          const off = service.onEvent((event: AgentTaskServiceEvent) => {
            if (event.type === "task_activities" && event.taskId === targetTaskId && event.activities.length > 0 && !written) {
              off();
              writeMarker("running");
              resolvePromise();
            }
          });
        });
        break;
      case "input":
        await waitForMs(() => statusOf(targetTaskId) === "waiting_input", 240_000, "task waiting for user input");
        // The unanswered request must be durably in the events log before the
        // kill so the restart sees it and settles it cancelled.
        await waitForAsyncMs(
          () => diskContainsEvent(storeRoot, projectDir, targetTaskId, '"type":"input_requested"'),
          60_000,
          "input_requested event durably appended",
        );
        writeMarker("waiting_input");
        break;
      case "post_complete":
        await waitForMs(() => statusOf(targetTaskId) === "completed", 300_000, "task completed");
        await waitForAsyncMs(
          () => diskSaysTerminal(storeRoot, projectDir, targetTaskId, "completed"),
          60_000,
          "completed state durable on disk (index + events log)",
        );
        writeMarker("completed");
        break;
    }
  } finally {
    unsubscribe();
  }

  // Keep the process alive until the parent hard-kills it (a real crash; no
  // prepareShutdown, no close marker).
  await new Promise<void>(() => setInterval(() => {}, 1000));
}

// ============================================================================
// Parent role: spawn the child, hard-kill it at the timepoint, reopen the app
// (fresh service over the same store) and verify PRD §7.8.
// ============================================================================

const MARKER_TIMEOUT_MS = 300_000;

interface CrashHarness {
  root: string;
  service: AgentTaskService;
  store: AgentTaskStore;
  events: ProductEventCollector;
  storeRoot: string;
  projectDir: string;
  eventsDir: string;
  wsId: string;
  marker: { timepoint: string; taskId: string; status: string };
}

function killProcessTree(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null) {
      // The child already exited (e.g. wrote error.json before any marker).
      resolvePromise();
      return;
    }
    const safety = setTimeout(() => {
      child.kill("SIGKILL");
    }, 15_000);
    child.once("exit", () => {
      clearTimeout(safety);
      resolvePromise();
    });
    if (process.platform === "win32") {
      // taskkill /T /F kills the whole process tree (nested bash sessions too).
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) => {
        if (error) {
          child.kill("SIGKILL");
        }
      });
    } else {
      child.kill("SIGKILL");
    }
  });
}

/** One crash scenario: spawn + kill the child, then reopen the app on the same store. */
async function crashHarness(
  timepoint: CrashTimepoint,
  opts: { taskCount?: number; autoRecovery?: boolean } = {},
): Promise<CrashHarness> {
  const root = mkdtempSync(join(tmpdir(), `pix-recovery-e2e-${timepoint}-`));
  const storeRoot = join(root, "store");
  const projectDir = join(root, "project");
  const controlDir = join(root, "control");
  const agentDir = join(root, "agent");
  const eventsDir = join(root, "events");
  const childSettingsDir = join(root, "child-settings");
  mkdirSync(storeRoot, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(controlDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(eventsDir, { recursive: true });
  mkdirSync(childSettingsDir, { recursive: true });
  copyFileSync(join(REAL_AGENT_DIR, "models.json"), join(agentDir, "models.json"));
  if (existsSync(join(REAL_AGENT_DIR, "auth.json"))) {
    copyFileSync(join(REAL_AGENT_DIR, "auth.json"), join(agentDir, "auth.json"));
  }

  const child = spawn(process.execPath, ["--import", "tsx", THIS_FILE], {
    cwd: PIX_ROOT,
    env: {
      ...process.env,
      PIX_RECOVERY_E2E_ROLE: "child",
      PIX_RECOVERY_E2E_TIMEPOINT: timepoint,
      PIX_RECOVERY_E2E_STORE_ROOT: storeRoot,
      PIX_RECOVERY_E2E_PROJECT: projectDir,
      PIX_RECOVERY_E2E_CONTROL: controlDir,
      PIX_RECOVERY_E2E_RUN_ID: `child-${timepoint}`,
      PIX_RECOVERY_E2E_TASK_COUNT: String(opts.taskCount ?? 1),
      PIX_RECOVERY_E2E_SETTINGS: childSettingsDir,
      PI_CODING_AGENT_DIR: agentDir,
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`  [${timepoint} child] ${chunk.toString()}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`  [${timepoint} child] ${chunk.toString()}`));

  const markerPath = join(controlDir, "reached.json");
  const errorPath = join(controlDir, "error.json");
  try {
    await waitForMs(() => existsSync(markerPath), MARKER_TIMEOUT_MS, `child to reach ${timepoint}`);
  } catch (err) {
    // Never leave an orphaned child behind on the failure path.
    await killProcessTree(child).catch(() => {});
    if (existsSync(errorPath)) {
      throw new Error(`child failed before reaching ${timepoint}: ${readFileSync(errorPath, "utf-8")}`);
    }
    throw err;
  }
  const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as { timepoint: string; taskId: string; status: string };
  await killProcessTree(child);

  // Reopen the app: a FRESH service over the SAME store (index.ts restoreAll).
  const settings = new SettingsStore({ cwd: join(root, "parent-settings") });
  settings.set("enableProductAnalytics", true);
  settings.set("autoBackgroundMs", 0);
  const events = new ProductEventCollector({ settings, agentDir: eventsDir });
  const store = new AgentTaskStore({
    rootDir: storeRoot,
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const service = new AgentTaskService({ settings, events, store, runId: `restore-${timepoint}` });
  // 1.5 (P1): the crash scenarios verify the manual hydration/resume flows -
  // disable the automatic post-restoreAll recovery pass by default; the
  // dedicated auto-recovery scenario opts back in.
  if (!opts.autoRecovery) {
    __setAgentTaskServiceHooksForTests({ disableAutoRecovery: true });
  } else {
    __setAgentTaskServiceHooksForTests({});
  }
  return {
    root,
    service,
    store,
    events,
    storeRoot,
    projectDir,
    eventsDir,
    wsId: workspaceIdOf(projectDir),
    marker,
  };
}

function findTask(harness: CrashHarness, taskId: string): AgentTaskInfo {
  const info = harness.service.getAll().tasks.find((candidate) => candidate.taskId === taskId);
  if (!info) {
    throw new Error(`Task ${taskId} not found in the restored service`);
  }
  return info;
}

interface AgentTaskRestoreReportLike {
  restored: number;
  interrupted: number;
  corrupted: number;
  diagnostics: string[];
}

/**
 * Read a session transcript tolerantly: a hard kill can leave the final line
 * truncated (the tail-corrupt crash signature), which the resumer repairs
 * before resume; the valid prefix is all the analysis needs.
 */
function readTranscript(sessionsDir: string, fileName: string): Array<Record<string, unknown>> {
  const text = readFileSync(join(sessionsDir, fileName), "utf-8");
  const entries: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    try {
      entries.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Tail-corrupt crash signature: skip the truncated final line only.
    }
  }
  return entries;
}

/**
 * JSONL validity with the crash allowance: every line must parse except that a
 * truncated FINAL line is the documented tail-corrupt signature (PRD §7.8).
 */
function assertJsonlWithOptionalPartialTail(path: string, message: string): void {
  const lines = readFileSync(path, "utf-8").split("\n").filter((line) => line.trim() !== "");
  let malformed = 0;
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      malformed++;
    }
  }
  assert(malformed <= 1, `${message} (${malformed} malformed line(s) - only the truncated tail is allowed)`);
}

async function readProductEventLog(harness: CrashHarness): Promise<string> {
  await harness.events.flushLog();
  const logPath = join(harness.eventsDir, "product-events.log");
  if (!existsSync(logPath)) {
    return "";
  }
  return readFileSync(logPath, "utf-8");
}

/**
 * PRD §4.3 recovery-completeness rate: every task must fully hydrate - the
 * index entry, the in-memory info (identity/status), the last checkpoint seq
 * and the disk artifacts (valid JSONL) must be mutually consistent. Asserted
 * as 1.0 (complete === restored).
 */
async function assertRestoreCompleteness(
  harness: CrashHarness,
  opts: { expectedRestored: number; expectedInterrupted: number; timepointLabel: string },
): Promise<AgentTaskRestoreReportLike> {
  const report = await harness.service.restoreAll();
  assertEqual(report.restored, opts.expectedRestored, `${opts.timepointLabel}: restoreAll restored count`);
  assertEqual(report.interrupted, opts.expectedInterrupted, `${opts.timepointLabel}: pre-exit non-terminal tasks hydrate interrupted`);
  assertEqual(report.corrupted, 0, `${opts.timepointLabel}: no corrupted records`);
  assert(
    report.diagnostics.some((line) => line.includes("crash")),
    `${opts.timepointLabel}: no close marker -> crash diagnosis`,
  );

  const snap = harness.service.getAll();
  assertEqual(snap.tasks.length, opts.expectedRestored, `${opts.timepointLabel}: snapshot lists every restored task`);
  // A hard kill can leave one truncated final log line: that surfaces as a
  // recoverable tail_corrupt issue and never blocks the task (PRD §7.8). Any
  // other issue code would mean the record is genuinely unreadable.
  for (const issue of snap.recoveryIssues) {
    assertEqual(issue.code, "tail_corrupt", `${issue.taskId}: recovery issue is recoverable tail_corrupt only`);
    assertEqual(issue.recoverable, true, `${issue.taskId}: tail-corrupt issue is recoverable`);
    assertEqual(issue.readOnly, false, `${issue.taskId}: tail-corrupt task stays writable`);
  }

  let complete = 0;
  for (const info of snap.tasks) {
    const index = await harness.store.readIndex(info.workspaceId);
    assert(index !== null, `${info.taskId}: index.json readable`);
    const entry = index!.tasks.find((candidate) => candidate.taskId === info.taskId);
    assert(entry !== undefined, `${info.taskId}: index entry present`);
    assertEqual(info.parentSessionId, entry!.parentSessionId, `${info.taskId}: parent session matches the index`);
    assertEqual(info.parentToolCallId, entry!.parentToolCallId, `${info.taskId}: parent tool call matches the index`);
    assertEqual(info.workspaceId, entry!.workspaceId, `${info.taskId}: workspace matches the index`);
    const read = await harness.store.readTask(info.workspaceId, info.taskId);
    if (read.checkpoint !== null && info.lastCheckpointSeq !== undefined) {
      // The checkpoint is written before the index in the same flush batch, so
      // a kill between the two atomic writes can only leave checkpoint.seq >=
      // the hydrated lastCheckpointSeq (never behind, never far ahead).
      const delta = read.checkpoint.seq - info.lastCheckpointSeq;
      assert(delta >= 0, `${info.taskId}: checkpoint.json never lags the hydrated lastCheckpointSeq (delta ${delta})`);
      assert(delta <= 10, `${info.taskId}: checkpoint seq close to the hydrated record (delta ${delta})`);
    }
    assertJsonlWithOptionalPartialTail(
      join(harness.storeRoot, info.workspaceId, info.taskId, "events.jsonl"),
      `${info.taskId}: events.jsonl valid up to the truncated tail`,
    );
    complete++;
  }
  assertEqual(complete, opts.expectedRestored, `${opts.timepointLabel}: recovery completeness rate = 1.0 (${complete}/${opts.expectedRestored})`);
  return report;
}

/**
 * Resume one restored task and wait for its new round to complete. Returns
 * true when a fresh input request appeared after resume and the parent
 * answered it (the caller can then assert the answered value's effect).
 */
async function resumeAndComplete(
  harness: CrashHarness,
  taskId: string,
  opts: { answerInput?: boolean; label: string; timeoutMs?: number },
): Promise<boolean> {
  const info = findTask(harness, taskId);
  assertEqual(info.status, "interrupted", `${opts.label}: task hydrated interrupted before resume`);
  const resumeResult = await harness.service.resume(taskId, info.generation, { action: "continue", confirmWorkspaceChanges: true });
  assertEqual(resumeResult.ok, true, `${opts.label}: resume accepted${resumeResult.ok ? "" : ` (reason: ${resumeResult.reason})`}`);
  if (!resumeResult.ok) {
    throw new Error(`${opts.label}: resume rejected with reason "${resumeResult.reason}"`);
  }
  const afterResume = findTask(harness, taskId);
  assertEqual(afterResume.generation, info.generation + 1, `${opts.label}: generation bumped on resume`);
  assert(
    afterResume.status === "queued" || afterResume.status === "running",
    `${opts.label}: resumed task enters queued/running (status=${afterResume.status})`,
  );

  // The resumed round may ask for user input again (the interrupted request
  // was settled cancelled); answer the fresh request when it appears. Every
  // wait is terminal-aware so a failed/cancelled resumed round fails fast
  // with its details instead of hanging the full timeout.
  let answeredFresh = false;
  if (opts.answerInput === true) {
    await waitForMs(
      () => {
        const current = findTask(harness, taskId);
        return current.status === "completed" || current.status === "failed" || current.status === "cancelled" || current.status === "waiting_input";
      },
      opts.timeoutMs ?? 300_000,
      `${opts.label}: resumed task to complete, fail or re-ask for input`,
    );
    const current = findTask(harness, taskId);
    if (current.status === "waiting_input") {
      const request = harness.service.getActiveInputRequests().find((candidate) => candidate.taskId === taskId);
      assert(request !== undefined, `${opts.label}: fresh input request routed after resume`);
      if (request) {
        const answered = harness.service.respondInput(
          request.taskId,
          request.requestId,
          request.generation,
          answerResponse(request, "e2e-42"),
        );
        assertEqual(answered, true, `${opts.label}: respondInput accepts the fresh triple`);
        answeredFresh = true;
      }
    }
  }
  await waitForMs(
    () => {
      const current = findTask(harness, taskId);
      return current.status === "completed" || current.status === "failed" || current.status === "cancelled";
    },
    opts.timeoutMs ?? 300_000,
    `${opts.label}: resumed task to reach a terminal state`,
  );
  const completed = findTask(harness, taskId);
  assertEqual(completed.status, "completed", `${opts.label}: resumed task completed`);
  if (completed.status !== "completed") {
    throw new Error(
      `${opts.label}: resumed task ended ${completed.status} (${completed.failureReason ?? ""} ${completed.errorMessage ?? ""})`,
    );
  }
  assert(completed.results.length >= 1, `${opts.label}: resumed run produced a result`);
  return answeredFresh;
}

function answerResponse(request: AgentTaskInputRequest, answer: string): RequestUserInputResponse {
  return { id: request.requestId, answers: { [request.request.questions[0]!.id]: answer } };
}

// ============================================================================
// Parent: the five timepoint scenarios
// ============================================================================

async function runParent(): Promise<void> {
  await run("queued: killed while queued -> all hydrate interrupted; the queued task resumes to a new finalized message", async () => {
    const harness = await crashHarness("queued", { taskCount: 5 });
    try {
      assertEqual(harness.marker.status, "queued", "child reached the queued timepoint");
      await assertRestoreCompleteness(harness, { expectedRestored: 5, expectedInterrupted: 5, timepointLabel: "queued" });
      const snap = harness.service.getAll();
      for (const info of snap.tasks) {
        assertEqual(
          info.status,
          "interrupted",
          `queued: task ${info.taskId} is interrupted, never running (got ${info.status}${info.failureReason ? `/${info.failureReason}` : ""}${info.errorMessage ? `: ${info.errorMessage}` : ""})`,
        );
        assertEqual(info.presentation, "background", `queued: task ${info.taskId} presented background after restart`);
        assertEqual(info.stopReason, "app_shutdown", `queued: task ${info.taskId} stopReason app_shutdown`);
        assertEqual(info.autoBackground, undefined, `queued: task ${info.taskId} clears autoBackground`);
        assertEqual(info.queuePosition, undefined, `queued: task ${info.taskId} clears queuePosition`);
      }
      await resumeAndComplete(harness, harness.marker.taskId, { label: "queued" });
      const completed = findTask(harness, harness.marker.taskId);
      assertEqual(completed.generation, 1, "queued: resumed task generation 1");
      const log = await readProductEventLog(harness);
      assert(log.includes('"name":"agent_task_restored"'), "queued: agent_task_restored recorded");
      assert(log.includes('"name":"agent_task_interrupted"'), "queued: agent_task_interrupted recorded");
      assert(log.includes('"name":"agent_task_resume_requested"'), "queued: agent_task_resume_requested recorded");
      assert(log.includes('"name":"agent_task_resume_succeeded"'), "queued: resume_succeeded (new finalized assistant message)");
      assert(log.includes('"name":"agent_task_completed"'), "queued: agent_task_completed recorded");
    } finally {
      // Stop the scenario's service before deleting its store root, so no
      // late flush (throttle/checkpoint tails) writes into a removed dir.
      await harness.service.dispose("app_shutdown").catch(() => {});
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  await run("model: killed mid-generation -> interrupted; resume produces a new finalized assistant message", async () => {
    const harness = await crashHarness("model");
    try {
      assertEqual(harness.marker.status, "running", "child killed while the model was generating");
      await assertRestoreCompleteness(harness, { expectedRestored: 1, expectedInterrupted: 1, timepointLabel: "model" });
      await resumeAndComplete(harness, harness.marker.taskId, { label: "model" });
      const log = await readProductEventLog(harness);
      assert(log.includes('"name":"agent_task_resume_succeeded"'), "model: resume_succeeded (new finalized assistant message)");
      // The resumed round produced a new finalized assistant message in the
      // task transcript on top of the pre-crash one.
      const ws = harness.wsId;
      const info = findTask(harness, harness.marker.taskId);
      const sessionsDir = harness.store.getTaskSessionDir(ws, info.taskId);
      const files = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
      if (files.length > 0) {
        const transcript = readTranscript(sessionsDir, files[files.length - 1]!);
        const assistantCount = transcript.filter(
          (entry) => entry.type === "message" && (entry.message as { role?: string }).role === "assistant",
        ).length;
        assert(assistantCount >= 1, `model: resumed round persisted a finalized assistant message (${assistantCount})`);
        const notes = transcript.filter((entry) => entry.type === "custom_message" && entry.customType === RESUME_NOTE_CUSTOM_TYPE);
        assertEqual(notes.length, 1, "model: exactly one visible recovery note");
      }
    } finally {
      // Stop the scenario's service before deleting its store root, so no
      // late flush (throttle/checkpoint tails) writes into a removed dir.
      await harness.service.dispose("app_shutdown").catch(() => {});
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  await run("auto-recovery: killed mid-generation -> restoreAll auto-resumes with no user action", async () => {
    // 1.5 (P1): the crash happens at the crash-safe model timepoint (the
    // transcript is materialized and the checkpoint references the real file),
    // so the automatic recovery pass must resume the task by itself: fixed
    // decision {continue, confirmWorkspaceChanges:false} - the fingerprint is
    // unchanged, so no workspace confirmation exists to give.
    const harness = await crashHarness("model", { autoRecovery: true });
    try {
      assertEqual(harness.marker.status, "running", "auto: child killed while the model was generating");
      const report = await harness.service.restoreAll();
      assertEqual(report.interrupted, 1, "auto: task hydrated interrupted");
      assertEqual(report.autoResumed, 1, "auto: the recovery pass resumed it automatically");
      assertEqual(report.autoFailed, 0, "auto: nothing converged to resume_blocked");

      const resumed = findTask(harness, harness.marker.taskId);
      assertEqual(resumed.generation, 1, "auto: generation bumped by the automatic resume");
      assert(
        resumed.status === "queued" || resumed.status === "running",
        `auto: resumed task entered queued/running (status=${resumed.status})`,
      );

      // No user interaction exists anymore: the resumed round runs to its
      // terminal state on its own.
      await waitForMs(
        () => {
          const current = findTask(harness, harness.marker.taskId);
          return current.status === "completed" || current.status === "failed" || current.status === "cancelled";
        },
        300_000,
        "auto: auto-resumed task to reach a terminal state",
      );
      const completed = findTask(harness, harness.marker.taskId);
      assertEqual(completed.status, "completed", "auto: auto-resumed task completed");
      if (completed.status !== "completed") {
        throw new Error(`auto: task ended ${completed.status} (${completed.failureReason ?? ""} ${completed.errorMessage ?? ""})`);
      }

      const log = await readProductEventLog(harness);
      assert(log.includes('"name":"agent_task_resume_requested"'), "auto: agent_task_resume_requested recorded");
      assert(log.includes('"name":"agent_task_resume_succeeded"'), "auto: agent_task_resume_succeeded recorded");
      assert(log.includes('"name":"agent_task_completed"'), "auto: agent_task_completed recorded");
      assert(existsSync(join(harness.projectDir, "model-marker.txt")), "auto: the resumed round produced its marker file");
    } finally {
      // Stop the scenario's service before deleting its store root, so no
      // late flush (throttle/checkpoint tails) writes into a removed dir.
      await harness.service.dispose("app_shutdown").catch(() => {});
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  await run("tool: killed mid-tool -> open call closed once, tail repaired with hash backup; resume completes", async () => {
    const harness = await crashHarness("tool");
    try {
      assertEqual(harness.marker.status, "running", "child killed while the tool was executing");
      await assertRestoreCompleteness(harness, { expectedRestored: 1, expectedInterrupted: 1, timepointLabel: "tool" });
      const ws = harness.wsId;
      const taskId = harness.marker.taskId;
      const sessionsDir = harness.store.getTaskSessionDir(ws, taskId);
      const files = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
      assertEqual(files.length, 1, "tool: the crashed run left one session JSONL");
      const sessionPath = join(sessionsDir, files[0]!);
      const openTranscript = readTranscript(sessionsDir, files[0]!);
      const openAssistantCalls = openTranscript
        .filter((entry) => entry.type === "message" && (entry.message as { role?: string }).role === "assistant")
        .flatMap((entry) => {
          const content = (entry.message as { content?: Array<{ type?: string; id?: string; name?: string }> }).content ?? [];
          return content.filter((block) => block.type === "toolCall");
        });
      const bashCall = openAssistantCalls.find((call) => call.name === "bash");
      assert(bashCall !== undefined, "tool: the transcript holds the interrupted bash tool call");
      if (bashCall === undefined) {
        return; // the scenario already failed above
      }
      const openCallId = bashCall.id!;

      // Deterministic crash signature: a truncated final JSONL line. The
      // natural kill may also have left one; appending makes it deterministic.
      writeFileSync(sessionPath, readFileSync(sessionPath, "utf-8") + '{"type":"message","id":"partial-json"', "utf-8");
      const corruptSha = createHash("sha256").update(readFileSync(sessionPath)).digest("hex");

      await resumeAndComplete(harness, taskId, { label: "tool" });

      // Tail repair: full hash-named backup preserved, working file valid JSONL.
      const afterFiles = readdirSync(sessionsDir);
      const bak = afterFiles.find((name) => name.includes(`.corrupt-${corruptSha}.bak`));
      assert(bak !== undefined, `tool: full hash-named .bak preserved (sessions: ${afterFiles.join(", ")})`);
      const transcript = readTranscript(sessionsDir, files[0]!);
      const toolResults = transcript.filter(
        (entry) => entry.type === "message" && (entry.message as { role?: string }).role === "toolResult",
      );
      const closures = toolResults.filter((result) => (result.message as { toolCallId?: string }).toolCallId === openCallId);
      assertEqual(closures.length, 1, "tool: exactly one interrupted_unknown ToolResult closes the open call");
      if (closures.length === 1) {
        const message = closures[0]!.message as { isError?: boolean; content?: Array<{ text?: string }> };
        assertEqual(message.isError, true, "tool: the closure ToolResult is a non-success result");
        assert(
          (message.content ?? []).some((block) => (block.text ?? "").includes(RESUME_INTERRUPTED_TOOL_RESULT_TEXT)),
          "tool: closure carries the interrupted_unknown marker",
        );
      }
      assertEqual(
        transcript.filter((entry) => entry.type === "custom_message" && entry.customType === RESUME_NOTE_CUSTOM_TYPE).length,
        1,
        "tool: exactly one visible recovery note",
      );
      assert(
        transcript.filter((entry) => entry.type === "message" && (entry.message as { role?: string }).role === "user").some(
          (entry) => {
            const content = (entry.message as { content?: string | Array<{ text?: string }> }).content;
            const text = Array.isArray(content) ? content.map((block) => block.text ?? "").join("") : (content ?? "");
            return text.includes(RESUME_TURN_MESSAGE);
          },
        ),
        "tool: the fixed RESUME_TURN_MESSAGE was sent exactly once",
      );
      const log = await readProductEventLog(harness);
      assert(log.includes('"name":"agent_task_resume_succeeded"'), "tool: resume_succeeded (new finalized assistant message)");
      assert(log.includes('"name":"agent_task_interrupted"'), "tool: agent_task_interrupted recorded");
    } finally {
      // Stop the scenario's service before deleting its store root, so no
      // late flush (throttle/checkpoint tails) writes into a removed dir.
      await harness.service.dispose("app_shutdown").catch(() => {});
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  await run("input: killed while waiting input -> interrupted; input settled cancelled; resume completes", async () => {
    const harness = await crashHarness("input");
    try {
      assertEqual(harness.marker.status, "waiting_input", "child killed while the task waited for input");
      await assertRestoreCompleteness(harness, { expectedRestored: 1, expectedInterrupted: 1, timepointLabel: "input" });
      const taskId = harness.marker.taskId;
      const ws = harness.wsId;
      const info = findTask(harness, taskId);
      const read = await harness.store.readTask(ws, taskId);
      assert(
        read.events.some((event) => event.type === "input_requested"),
        "input: the unanswered request was persisted before the crash",
      );

      const answeredFresh = await resumeAndComplete(harness, taskId, { label: "input", answerInput: true });
      if (answeredFresh) {
        assertEqual(
          readMarker(harness.projectDir, "input-marker.txt"),
          "e2e-42",
          "input: the answered value was written by the resumed nested session",
        );
      }

      // The interrupted request settled as cancelled exactly once; the resumed
      // round may re-ask and the fresh request then settles as answered.
      const after = await harness.store.readTask(ws, taskId);
      const settled = after.events.filter((event) => event.type === "input_settled");
      const cancelled = settled.filter((event) => (event as { outcome: string }).outcome === "cancelled");
      const answered = settled.filter((event) => (event as { outcome: string }).outcome === "answered");
      assertEqual(cancelled.length, 1, "input: the interrupted request settles cancelled exactly once");
      assert(
        answered.length === 0 || answered.length === 1,
        `input: the resumed round settles at most one answered request (${answered.length})`,
      );
      const log = await readProductEventLog(harness);
      assert(log.includes('"name":"agent_task_resume_succeeded"'), "input: resume_succeeded (new finalized assistant message)");
    } finally {
      // Stop the scenario's service before deleting its store root, so no
      // late flush (throttle/checkpoint tails) writes into a removed dir.
      await harness.service.dispose("app_shutdown").catch(() => {});
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  await run("post-complete: killed after durable completion -> stays completed, never interrupted; resume rejected", async () => {
    const harness = await crashHarness("post_complete");
    try {
      assertEqual(harness.marker.status, "completed", "child killed after the task durably completed");
      await assertRestoreCompleteness(harness, { expectedRestored: 1, expectedInterrupted: 0, timepointLabel: "post-complete" });
      const taskId = harness.marker.taskId;
      const info = findTask(harness, taskId);
      assertEqual(info.status, "completed", "post-complete: the completed task is never hydrated as interrupted");
      assertEqual(info.results.length, 1, "post-complete: the terminal result survived the restart");
      assertEqual(
        readMarker(harness.projectDir, "post-marker.txt"),
        "post-ok",
        "post-complete: the marker written by the nested session survived",
      );
      // Terminal tasks cannot resume (PRD §7.8: only interrupted tasks do).
      const resumeResult = await harness.service.resume(taskId, info.generation, { action: "continue", confirmWorkspaceChanges: true });
      assertEqual(resumeResult.ok, false, "post-complete: resume rejected for a terminal task");
      if (!resumeResult.ok) {
        assertEqual(resumeResult.reason, "task_not_interrupted", "post-complete: task_not_interrupted reason");
      }
      const log = await readProductEventLog(harness);
      assert(log.includes('"name":"agent_task_restored"'), "post-complete: agent_task_restored recorded");
      assert(!log.includes('"name":"agent_task_interrupted"'), "post-complete: no agent_task_interrupted for a terminal task");
    } finally {
      // Stop the scenario's service before deleting its store root, so no
      // late flush (throttle/checkpoint tails) writes into a removed dir.
      await harness.service.dispose("app_shutdown").catch(() => {});
      rmSync(harness.root, { recursive: true, force: true });
    }
  });
}

function readMarker(projectDir: string, fileName: string): string {
  return readFileSync(join(projectDir, fileName), "utf8").trim();
}

// ============================================================================
// Entry: child role re-executes this file; the parent role runs the matrix.
// ============================================================================

if (CHILD_ROLE) {
  try {
    await runChild(MODEL);
  } catch (err) {
    const controlDir = process.env.PIX_RECOVERY_E2E_CONTROL;
    if (controlDir) {
      try {
        writeFileSync(
          join(controlDir, "error.json"),
          JSON.stringify({ message: err instanceof Error ? err.message : String(err) }),
          "utf-8",
        );
      } catch {
        // Best-effort diagnostics.
      }
    }
    console.error(`[agent-task-recovery.e2e child] ${timepointLabel()} failed: ${String(err)}`);
    process.exit(3);
  }
} else {
  await runParent();
  assertNoUnhandledRejections();
}

// Finished runtime sessions keep MCP health-check timers alive; exit
// deterministically with the verdict (after flushing the summary) instead of
// hanging on the event loop.
const summary = `\nPassed: ${passed}, Failed: ${failed}\n`;
process.stdout.write(summary, () => {
  process.exit(failed > 0 ? 1 : 0);
});

function timepointLabel(): string {
  return process.env.PIX_RECOVERY_E2E_TIMEPOINT ?? "unknown";
}
