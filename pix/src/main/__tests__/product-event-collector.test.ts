/**
 * Anonymous product-event collector + settings 2 -> 3 migration tests (F4).
 *
 * Covers:
 *   - the shared product-events guard: exact 1.4.0 event name set (no
 *     agent_task_* yet), isProductEvent shape validation, and the
 *     sanitizeProductEventPayload privacy allowlist (prompt/code/file content/
 *     command text/model output are dropped);
 *   - collector enable/disable semantics: default (disabled) and disabled
 *     mid-run produce zero new records, re-enabling resumes recording;
 *   - fresh random taskId per event and sanitization before append;
 *   - local valid Solo session counting with a baseline line that survives
 *     collector restarts;
 *   - log rolling to product-events.log.1 at the size cap;
 *   - SettingsStore schema 2 -> 3 migration: idempotent, per-version, does not
 *     write 1.4.1 fields (autoBackgroundMs), and setMany covering the new
 *     1.4.0 fields.
 *
 * Run with: npm exec tsx -- src/main/__tests__/product-event-collector.test.ts
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  PRODUCT_EVENT_ERROR_CATEGORIES,
  PRODUCT_EVENT_NAMES_V140,
  PRODUCT_EVENT_NAMES_V143,
  PRODUCT_EVENT_SCHEMA_VERSION,
  isProductEvent,
  sanitizeProductEventPayload,
  type ProductEvent,
  type ProductEventPayload,
} from "../../shared/product-events.js";
import { SettingsStore } from "../settings-store.js";
import { ProductEventCollector } from "../product-event-collector.js";

// ============================================================================
// Test harness (matches subagent-types.test.ts style)
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

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${name} ===\n`);
  try {
    await fn();
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name} threw unexpectedly: ${String(err)}`);
  }
}

// ============================================================================
// Fixture helpers
// ============================================================================

function makeEvent(name: ProductEvent["name"], payload: unknown = {}): ProductEvent {
  return { schemaVersion: PRODUCT_EVENT_SCHEMA_VERSION, name, payload: payload as ProductEventPayload };
}

interface LogLine {
  record: string;
  taskId?: string;
  name?: string;
  occurredAt?: number;
  payload?: unknown;
  kind?: string;
  count?: number;
}

function readLog(path: string): LogLine[] {
  if (!existsSync(path)) return [];
  const lines: LogLine[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    lines.push(JSON.parse(line) as LogLine);
  }
  return lines;
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ============================================================================
// Tests
// ============================================================================

await run("shared product-events: 1.4.0 name set is exact and version-gated", async () => {
  assertEqual(PRODUCT_EVENT_NAMES_V140.length, 12, "exactly 12 event names in 1.4.0");
  const expected = [
    "plan_mode_entered",
    "plan_generation_started",
    "plan_generation_succeeded",
    "plan_generation_failed",
    "plan_generation_cancelled",
    "plan_revision_requested",
    "plan_approved",
    "plan_cancelled",
    "plan_execution_started",
    "plan_execution_completed",
    "plan_execution_failed",
    "plan_execution_cancelled",
  ];
  for (const name of expected) {
    assert(PRODUCT_EVENT_NAMES_V140.includes(name as (typeof PRODUCT_EVENT_NAMES_V140)[number]), `name ${name} present`);
  }
  assert(
    !PRODUCT_EVENT_NAMES_V140.some((name) => name.startsWith("agent_task")),
    "no agent_task_* names in 1.4.0 (version gate)",
  );
  assertEqual(PRODUCT_EVENT_SCHEMA_VERSION, 1, "PRODUCT_EVENT_SCHEMA_VERSION === 1");
  assertEqual(PRODUCT_EVENT_ERROR_CATEGORIES.length, 7, "seven error categories");
});

await run("sanitizeProductEventPayload: drops everything outside the allowlist", async () => {
  const dirty = {
    version: 3,
    status: "executing",
    durationMs: 1234,
    counts: { steps: 4, revisions: 1 },
    model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
    errorCategory: "timeout",
    prompt: "please plan a refactor",
    code: "const secret = 42",
    fileContent: "// full file body",
    command: "rm -rf project",
    output: "model generated output",
  };
  const clean = sanitizeProductEventPayload(dirty);
  assertEqual(clean.version, 3, "version preserved");
  assertEqual(clean.status, "executing", "status preserved");
  assertEqual(clean.durationMs, 1234, "durationMs preserved");
  assertEqual(JSON.stringify(clean.counts), JSON.stringify({ steps: 4, revisions: 1 }), "counts preserved");
  assertEqual(JSON.stringify(clean.model), JSON.stringify({ provider: "anthropic", modelId: "claude-sonnet-4-5" }), "model preserved");
  assertEqual(clean.errorCategory, "timeout", "errorCategory preserved");
  assert((clean as Record<string, unknown>).prompt === undefined, "prompt dropped");
  assert((clean as Record<string, unknown>).code === undefined, "code dropped");
  assert((clean as Record<string, unknown>).fileContent === undefined, "fileContent dropped");
  assert((clean as Record<string, unknown>).command === undefined, "command dropped");
  assert((clean as Record<string, unknown>).output === undefined, "output dropped");

  assertEqual(JSON.stringify(sanitizeProductEventPayload(null)), "{}", "null payload sanitizes to {}");
  assertEqual(JSON.stringify(sanitizeProductEventPayload("str")), "{}", "string payload sanitizes to {}");
  assertEqual(JSON.stringify(sanitizeProductEventPayload(42)), "{}", "number payload sanitizes to {}");
  assertEqual(JSON.stringify(sanitizeProductEventPayload([])), "{}", "array payload sanitizes to {}");
  assertEqual(JSON.stringify(sanitizeProductEventPayload(undefined)), "{}", "undefined payload sanitizes to {}");
});

await run("sanitizeProductEventPayload: invalid allowlisted values are dropped", async () => {
  assert(sanitizeProductEventPayload({ version: "3" }).version === undefined, "string version dropped");
  assert(sanitizeProductEventPayload({ version: -1 }).version === undefined, "negative version dropped");
  assert(sanitizeProductEventPayload({ version: 2.5 }).version === undefined, "non-integer version dropped");
  assert(sanitizeProductEventPayload({ durationMs: -5 }).durationMs === undefined, "negative durationMs dropped");
  assert(sanitizeProductEventPayload({ durationMs: NaN }).durationMs === undefined, "NaN durationMs dropped");
  assert(sanitizeProductEventPayload({ durationMs: Infinity }).durationMs === undefined, "Infinity durationMs dropped");
  assert(sanitizeProductEventPayload({ status: "" }).status === undefined, "empty status dropped");
  assert(
    sanitizeProductEventPayload({ status: "x".repeat(65) }).status === undefined,
    "over-long status dropped",
  );
  assert(sanitizeProductEventPayload({ counts: {} }).counts === undefined, "empty counts dropped");
  assert(sanitizeProductEventPayload({ counts: { a: "1" } }).counts === undefined, "non-numeric count dropped");
  assert(sanitizeProductEventPayload({ counts: { a: -1 } }).counts === undefined, "negative count dropped");
  assert(
    sanitizeProductEventPayload({ counts: { ["x".repeat(33)]: 1 } }).counts === undefined,
    "over-long count key dropped",
  );
  const manyCounts: Record<string, number> = {};
  for (let i = 0; i < 17; i++) manyCounts[`k${i}`] = i;
  assert(sanitizeProductEventPayload({ counts: manyCounts }).counts === undefined, "over-16-entry counts dropped");
  assert(sanitizeProductEventPayload({ model: { provider: "" } }).model === undefined, "empty provider dropped");
  assert(
    sanitizeProductEventPayload({ model: { provider: "p", modelId: "" } }).model === undefined,
    "empty modelId dropped",
  );
  assert(
    sanitizeProductEventPayload({ model: { provider: "p".repeat(129), modelId: "m" } }).model === undefined,
    "over-long provider dropped",
  );
  assert(
    sanitizeProductEventPayload({ errorCategory: "bogus" }).errorCategory === undefined,
    "unknown errorCategory dropped",
  );
});

await run("isProductEvent: accepts valid events and rejects malformed ones", async () => {
  assert(isProductEvent(makeEvent("plan_approved", { version: 1, durationMs: 5 })), "valid event accepted");
  assert(
    isProductEvent(makeEvent("plan_mode_entered", { model: { provider: "p", modelId: "m" } })),
    "valid minimal event accepted",
  );

  assert(isProductEvent(makeEvent("agent_task_started")), "agent_task_started accepted (1.4.1 events)");
  for (const name of PRODUCT_EVENT_NAMES_V143) {
    assert(isProductEvent(makeEvent(name)), `${name} accepted (1.4.3 events)`);
  }
  assert(!isProductEvent(makeEvent("plan_bogus")), "unknown name rejected");
  assert(!isProductEvent({ schemaVersion: 2, name: "plan_approved", payload: {} }), "wrong schemaVersion rejected");
  assert(!isProductEvent({ schemaVersion: 1, name: "plan_approved" }), "missing payload rejected");
  assert(!isProductEvent({ schemaVersion: 1, name: "plan_approved", payload: "x" }), "non-object payload rejected");
  assert(
    !isProductEvent({ schemaVersion: 1, name: "plan_approved", payload: { version: -1 } }),
    "negative payload version rejected",
  );
  assert(
    !isProductEvent({ schemaVersion: 1, name: "plan_approved", payload: { durationMs: NaN } }),
    "NaN payload durationMs rejected",
  );
  assert(!isProductEvent(null), "null rejected");
  assert(!isProductEvent(undefined), "undefined rejected");
  assert(!isProductEvent(42), "non-object rejected");

  const garbage: unknown[] = [
    { schemaVersion: 1, name: 5, payload: {} },
    { schemaVersion: 1, name: "plan_approved", payload: [null] },
    { schemaVersion: 1, name: "plan_approved", payload: { counts: { a: NaN } } },
  ];
  for (const input of garbage) {
    let threw = false;
    try {
      isProductEvent(input);
    } catch {
      threw = true;
    }
    assert(!threw, "isProductEvent does not throw on garbage");
  }
});

await run("collector: default (disabled) records nothing", async () => {
  const cwd = makeTempDir("pix-events-disabled-");
  const agentDir = join(cwd, "agent");
  const store = new SettingsStore({ cwd });
  const collector = new ProductEventCollector({ settings: store, agentDir });

  assert(!collector.isEnabled(), "collector disabled by default");
  collector.record(makeEvent("plan_approved", { version: 1 }));
  collector.recordValidSoloSession();
  await collector.flushLog();
  assert(!existsSync(join(agentDir, "product-events.log")), "no log file created while disabled");

  rmSync(cwd, { recursive: true, force: true });
});

await run("collector: enabled records sanitized JSONL with fresh random taskIds", async () => {
  const cwd = makeTempDir("pix-events-enabled-");
  const agentDir = join(cwd, "agent");
  const store = new SettingsStore({ cwd });
  store.set("enableProductAnalytics", true);
  const collector = new ProductEventCollector({ settings: store, agentDir });

  assert(collector.isEnabled(), "collector enabled after setting the switch");
  collector.record(
    makeEvent("plan_approved", {
      version: 2,
      durationMs: 321,
      prompt: "secret user request",
      fileContent: "secret file body",
    }),
  );
  collector.record(makeEvent("plan_execution_started", { version: 2, counts: { steps: 5 } }));
  await collector.flushLog();

  const lines = readLog(join(agentDir, "product-events.log"));
  assertEqual(lines.length, 2, "two event lines flushed (no baseline yet)");
  assertEqual(lines[0]!.record, "event", "first line is an event record");
  assertEqual(lines[0]!.name, "plan_approved", "first event name preserved");
  assertEqual(lines[1]!.name, "plan_execution_started", "second event name preserved");
  assert(lines[0]!.taskId !== undefined, "event carries a stamped taskId");
  assert(
    typeof lines[0]!.taskId === "string" && lines[0]!.taskId.length === 36,
    "taskId is a random UUID string",
  );
  assert(lines[0]!.taskId !== lines[1]!.taskId, "each event gets a fresh random taskId");
  assert(typeof lines[0]!.occurredAt === "number" && lines[0]!.occurredAt > 0, "occurredAt stamped");
  const payload0 = lines[0]!.payload as Record<string, unknown>;
  assertEqual(payload0.version, 2, "sanitized version preserved");
  assertEqual(payload0.durationMs, 321, "sanitized durationMs preserved");
  assert(payload0.prompt === undefined, "prompt stripped before append");
  assert(payload0.fileContent === undefined, "fileContent stripped before append");
  const payload1 = lines[1]!.payload as Record<string, unknown>;
  assertEqual(JSON.stringify(payload1.counts), JSON.stringify({ steps: 5 }), "sanitized counts preserved");

  rmSync(cwd, { recursive: true, force: true });
});

await run("collector: disabling mid-run stops new records; re-enabling resumes", async () => {
  const cwd = makeTempDir("pix-events-toggle-");
  const agentDir = join(cwd, "agent");
  const logPath = join(agentDir, "product-events.log");
  const store = new SettingsStore({ cwd });
  store.set("enableProductAnalytics", true);
  const collector = new ProductEventCollector({ settings: store, agentDir });

  collector.record(makeEvent("plan_mode_entered"));
  await collector.flushLog();
  const before = readFileSync(logPath, "utf-8");

  store.set("enableProductAnalytics", false);
  assert(!collector.isEnabled(), "isEnabled reflects the live setting");
  collector.record(makeEvent("plan_generation_started"));
  await collector.flushLog();
  const afterDisabled = readFileSync(logPath, "utf-8");
  assertEqual(afterDisabled, before, "no new records appended after disabling mid-run");

  store.set("enableProductAnalytics", true);
  assert(collector.isEnabled(), "re-enabled");
  collector.record(makeEvent("plan_cancelled"));
  await collector.flushLog();
  const lines = readLog(logPath);
  assertEqual(lines.length, 2, "re-enabling resumes recording");
  assertEqual(lines[1]!.name, "plan_cancelled", "the re-enabled event is appended");

  rmSync(cwd, { recursive: true, force: true });
});

await run("collector: valid Solo session counting persists across restarts", async () => {
  const cwd = makeTempDir("pix-events-solo-");
  const agentDir = join(cwd, "agent");
  const logPath = join(agentDir, "product-events.log");
  const store = new SettingsStore({ cwd });
  store.set("enableProductAnalytics", true);
  const collector = new ProductEventCollector({ settings: store, agentDir });

  collector.recordValidSoloSession();
  collector.recordValidSoloSession();
  collector.recordValidSoloSession();
  await collector.flushLog();
  const baselines = readLog(logPath).filter((line) => line.record === "baseline");
  assertEqual(baselines.length, 1, "one baseline line after first flush");
  assertEqual(baselines[0]!.kind, "valid_solo_sessions", "baseline kind is valid_solo_sessions");
  assertEqual(baselines[0]!.count, 3, "baseline count is 3");

  store.set("enableProductAnalytics", false);
  collector.recordValidSoloSession();
  await collector.flushLog();
  const afterDisabled = readFileSync(logPath, "utf-8");
  const lastCount = readLog(logPath).filter((line) => line.record === "baseline").pop()!;
  assertEqual(lastCount.count, 3, "disabled session increments nothing");
  assertEqual(readFileSync(logPath, "utf-8"), afterDisabled, "disabled run does not rewrite the log");

  store.set("enableProductAnalytics", true);
  collector.recordValidSoloSession();
  await collector.flushLog();
  const afterReenable = readLog(logPath).filter((line) => line.record === "baseline").pop()!;
  assertEqual(afterReenable.count, 4, "re-enabled session increments the count");

  // Simulate an app restart: a fresh collector seeds from the last baseline.
  const restarted = new ProductEventCollector({ settings: store, agentDir });
  restarted.recordValidSoloSession();
  await restarted.flushLog();
  const afterRestart = readLog(logPath).filter((line) => line.record === "baseline").pop()!;
  assertEqual(afterRestart.count, 5, "count seeds from the log and continues after restart");

  rmSync(cwd, { recursive: true, force: true });
});

await run("collector: failed append does not drop the baseline; the next flush rewrites it", async () => {
  const cwd = makeTempDir("pix-events-baseline-retry-");
  const agentDir = join(cwd, "agent");
  const logPath = join(agentDir, "product-events.log");
  const store = new SettingsStore({ cwd });
  store.set("enableProductAnalytics", true);
  const collector = new ProductEventCollector({ settings: store, agentDir });

  collector.recordValidSoloSession();
  collector.recordValidSoloSession();
  collector.recordValidSoloSession();
  await collector.flushLog();
  const firstBaseline = readLog(logPath).filter((line) => line.record === "baseline").pop()!;
  assertEqual(firstBaseline.count, 3, "baseline 3 written before the failure");

  // Block the log path with a directory so appendFile fails (EISDIR): a
  // transient write failure must not advance the flushed baseline watermark.
  rmSync(logPath, { force: true });
  mkdirSync(logPath);
  collector.recordValidSoloSession(); // in-memory count -> 4
  await collector.flushLog(); // append fails; the error is swallowed
  assert(existsSync(logPath), "log path still blocked after the failed flush");

  // Unblock and flush again without a new session: the pending baseline must
  // be rewritten (count 4), not skipped because the watermark had advanced.
  rmSync(logPath, { recursive: true, force: true });
  await collector.flushLog();
  const afterRetry = readLog(logPath).filter((line) => line.record === "baseline").pop()!;
  assertEqual(afterRetry.count, 4, "failed baseline is rewritten on the next flush");

  // Simulate an app restart: the seed must read 4, not the stale 3.
  const restarted = new ProductEventCollector({ settings: store, agentDir });
  restarted.recordValidSoloSession();
  await restarted.flushLog();
  const afterRestart = readLog(logPath).filter((line) => line.record === "baseline").pop()!;
  assertEqual(afterRestart.count, 5, "restart seeds from the rewritten baseline");

  rmSync(cwd, { recursive: true, force: true });
});

await run("collector: log rolls to .1 at the size cap", async () => {
  const cwd = makeTempDir("pix-events-roll-");
  const agentDir = join(cwd, "agent");
  const logPath = join(agentDir, "product-events.log");
  const store = new SettingsStore({ cwd });
  store.set("enableProductAnalytics", true);
  const collector = new ProductEventCollector({ settings: store, agentDir, maxLogBytes: 400 });

  for (let i = 0; i < 30; i++) {
    collector.record(makeEvent("plan_approved", { version: 1 }));
  }
  await collector.flushLog();
  for (let i = 0; i < 30; i++) {
    collector.record(makeEvent("plan_execution_completed", { version: 1 }));
  }
  await collector.flushLog();

  assert(existsSync(logPath), "current log exists after second flush");
  assert(existsSync(`${logPath}.1`), "rolled log exists");
  const currentLines = readLog(logPath);
  const rolledLines = readLog(`${logPath}.1`);
  assertEqual(currentLines.length + rolledLines.length, 60, "no event lost across rolling");
  assert(rolledLines.length > 0, "rolled log contains the older lines");
  assert(currentLines.every((line) => line.name === "plan_execution_completed"), "current log holds the newest batch");
  assert(rolledLines.every((line) => line.name === "plan_approved"), "rolled log holds the oldest batch");

  rmSync(cwd, { recursive: true, force: true });
});

await run("collector: seeds solo-session count from rolled product-events.log.1", async () => {
  const cwd = makeTempDir("pix-events-seed-rolled-");
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "product-events.log.1"),
    `${JSON.stringify({ record: "baseline", kind: "valid_solo_sessions", count: 9 })}\n`,
    "utf-8",
  );
  const store = new SettingsStore({ cwd });
  store.set("enableProductAnalytics", true);
  const collector = new ProductEventCollector({ settings: store, agentDir });
  collector.recordValidSoloSession();
  await collector.flushLog();
  const last = readLog(join(agentDir, "product-events.log")).filter((line) => line.record === "baseline").pop()!;
  assertEqual(last.count, 10, "seeded from rolled log then incremented");
  rmSync(cwd, { recursive: true, force: true });
});

await run("SettingsStore: schema 2 -> 3 migration is idempotent and skips 1.4.1 fields", async () => {
  const cwd = makeTempDir("pix-settings-2to3-");
  const realProject = makeTempDir("pix-2to3-project-");
  const settingsFile = join(cwd, "pix-settings.json");
  writeFileSync(
    settingsFile,
    JSON.stringify({
      schemaVersion: 2,
      theme: "dark",
      wsl: { enabled: true, distro: "Ubuntu-22.04", defaultCwd: "/home/u" },
      recentProjects: [
        {
          path: realProject,
          physicalPath: realProject,
          name: basename(realProject),
          environment: { kind: "windows" },
          lastOpened: 999,
          sessionCount: 3,
        },
      ],
    }),
    "utf-8",
  );

  const store = new SettingsStore({ cwd });
  assertEqual(store.get("schemaVersion"), 4, "migrated schemaVersion === 4");
  assertEqual(store.get("enableProductAnalytics"), false, "enableProductAnalytics defaults to false");

  const raw = JSON.parse(readFileSync(settingsFile, "utf-8")) as Record<string, unknown>;
  assertEqual(raw.schemaVersion, 4, "file stamped schemaVersion 4");
  assertEqual(raw.enableProductAnalytics, false, "file carries enableProductAnalytics false");
  assertEqual(raw.theme, "dark", "existing theme preserved");
  assertEqual((raw.wsl as Record<string, unknown>).distro, "Ubuntu-22.04", "existing wsl preserved");
  assertEqual((raw.recentProjects as unknown[]).length, 1, "existing recent projects preserved");
  assert(!("planModel" in raw), "planModel not written by migration (undefined = inherit)");
  assert(!("planThinkingLevel" in raw), "planThinkingLevel not written by migration");
  assert(!("autoBackgroundMs" in raw), "1.4.1 autoBackgroundMs never written");

  const beforeReload = readFileSync(settingsFile, "utf-8");
  const store2 = new SettingsStore({ cwd });
  assertEqual(store2.get("schemaVersion"), 4, "second load stays at 4");
  assertEqual(readFileSync(settingsFile, "utf-8"), beforeReload, "migration is idempotent (file unchanged)");

  rmSync(cwd, { recursive: true, force: true });
  rmSync(realProject, { recursive: true, force: true });
});

await run("SettingsStore: legacy (no schemaVersion) store steps straight to 3", async () => {
  const cwd = makeTempDir("pix-settings-legacy-");
  const realProject = makeTempDir("pix-legacy-project-");
  const settingsFile = join(cwd, "pix-settings.json");
  writeFileSync(
    settingsFile,
    JSON.stringify({
      theme: "light",
      recentProjects: [{ path: realProject, name: "project", lastOpened: 123, sessionCount: 0 }],
    }),
    "utf-8",
  );

  const store = new SettingsStore({ cwd });
  const all = store.getAll();
  assertEqual(all.schemaVersion, 4, "legacy store migrated to 4");
  assertEqual(all.enableProductAnalytics, false, "legacy store gains enableProductAnalytics false");
  assert(all.wsl !== undefined, "legacy store gains wsl defaults");
  assertEqual(all.recentProjects.length, 1, "legacy project entry kept");
  assertEqual(all.recentProjects[0]!.physicalPath, realProject, "legacy project got physicalPath = path");
  assertEqual(all.recentProjects[0]!.environment.kind, "windows", "legacy project environment is windows");

  rmSync(cwd, { recursive: true, force: true });
  rmSync(realProject, { recursive: true, force: true });
});

await run("SettingsStore: setMany covers the 1.4.0 fields", async () => {
  const cwd = makeTempDir("pix-settings-setmany-");
  const store = new SettingsStore({ cwd });

  store.setMany({
    planModel: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
    planThinkingLevel: "high",
    enableProductAnalytics: true,
  });
  assertEqual(
    JSON.stringify(store.get("planModel")),
    JSON.stringify({ provider: "anthropic", modelId: "claude-sonnet-4-5" }),
    "setMany stores planModel",
  );
  assertEqual(store.get("planThinkingLevel"), "high", "setMany stores planThinkingLevel");
  assertEqual(store.get("enableProductAnalytics"), true, "setMany stores enableProductAnalytics");

  store.setMany({ planModel: undefined, planThinkingLevel: undefined, enableProductAnalytics: undefined });
  const raw = JSON.parse(readFileSync(join(cwd, "pix-settings.json"), "utf-8")) as Record<string, unknown>;
  assert(!("planModel" in raw), "undefined planModel deletes the key");
  assert(!("planThinkingLevel" in raw), "undefined planThinkingLevel deletes the key");
  assert(!("enableProductAnalytics" in raw), "undefined enableProductAnalytics deletes the key");

  rmSync(cwd, { recursive: true, force: true });
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
