/**
 * Side-question (BTW) IPC tests (PiX 1.5.0, design plan §4.2.4).
 *
 * Covers the btw-ask / btw-cancel registration with an INJECTABLE IPC
 * adapter (pure Node, no Electron runtime): the question guard (non-string /
 * blank-after-trim / over-long resolve an error BtwAskResult instead of
 * rejecting), ask passthrough and cancel passthrough.
 *
 * IPC harness rule (design plan §3): the test registers the REAL production
 * handlers from ipc-btw-adapters.ts on a top-level-imported injectable
 * IpcMainLike adapter; production registerIpcHandlers passes the real
 * ipcMain and the SessionBridge-backed deps. ipc-handlers.ts itself cannot
 * be imported from pure Node (its electron import chain fails to load
 * outside the Electron runtime), so the btw registration was extracted into
 * a pure module (ipc-btw-adapters.ts) that this test imports directly - no
 * mirror, no lockstep.
 *
 * Run with: npx tsx pix/src/main/__tests__/btw-ipc.test.ts
 */

import { BTW_MAX_QUESTION_LENGTH, btwValidateQuestion, type BtwAskResult } from "../../shared/btw-types.js";
import { registerBtwIpcHandlers, type BtwIpcDeps } from "../ipc-btw-adapters.js";
import type { IpcMainLike } from "../ipc-plan-adapters.js";

// ============================================================================
// Test harness (matches plan-ipc.test.ts style)
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

// ============================================================================
// Injectable IPC adapter (pure Node; REAL handlers imported from
// ipc-btw-adapters.ts - no mirror, no lockstep)
// ============================================================================

class FakeIpcMain implements IpcMainLike {
  private readonly _handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
    this._handlers.set(channel, listener);
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const listener = this._handlers.get(channel);
    if (!listener) {
      throw new Error(`No handler registered for channel "${channel}"`);
    }
    return listener({}, ...args);
  }
}

interface FakeDeps extends BtwIpcDeps {
  asks: string[];
  cancels: number;
}

function makeDeps(): FakeDeps {
  const deps: FakeDeps = {
    asks: [],
    cancels: 0,
    ask: async (question: string) => {
      deps.asks.push(question);
      return { status: "answered", answer: `answer to: ${question}` };
    },
    cancel: () => {
      deps.cancels += 1;
    },
  };
  return deps;
}

function makeHarness(): { ipc: FakeIpcMain; deps: FakeDeps } {
  const deps = makeDeps();
  const ipc = new FakeIpcMain();
  registerBtwIpcHandlers(ipc, deps);
  return { ipc, deps };
}

// ============================================================================
// Tests
// ============================================================================

await run("guard: non-string questions resolve an error result (no reject/throw)", async () => {
  const { ipc, deps } = makeHarness();
  for (const bad of [42, null, undefined, true, {}, ["question"], { question: "q" }]) {
    const result = (await ipc.invoke("btw-ask", bad)) as BtwAskResult;
    assertEqual(result.status, "error", `non-string ${JSON.stringify(bad)} resolves error status`);
    assert(result.errorMessage !== undefined && result.errorMessage.length > 0, `error message present for ${JSON.stringify(bad)}`);
  }
  assertEqual(deps.asks.length, 0, "deps.ask never called for guard violations");
});

await run("guard: blank-after-trim questions resolve an error result", async () => {
  const { ipc, deps } = makeHarness();
  for (const blank of ["", "   ", "\t\n  ", "　"]) {
    const result = (await ipc.invoke("btw-ask", blank)) as BtwAskResult;
    assertEqual(result.status, "error", `blank ${JSON.stringify(blank)} resolves error status`);
    assertEqual(result.errorMessage, "用法：/btw <问题>", `usage error message for ${JSON.stringify(blank)}`);
  }
  assertEqual(deps.asks.length, 0, "deps.ask never called for blank questions");
});

await run("guard: over-long questions resolve an error result", async () => {
  const { ipc, deps } = makeHarness();
  const tooLong = "q".repeat(BTW_MAX_QUESTION_LENGTH + 1);
  const result = (await ipc.invoke("btw-ask", tooLong)) as BtwAskResult;
  assertEqual(result.status, "error", "over-long question resolves error status");
  assertEqual(result.errorMessage, `问题过长（≤${BTW_MAX_QUESTION_LENGTH} 字符）`, "too-long error message");
  assertEqual(deps.asks.length, 0, "deps.ask never called for over-long question");
});

await run("guard: boundary questions pass through", async () => {
  const { ipc, deps } = makeHarness();
  const atLimit = "q".repeat(BTW_MAX_QUESTION_LENGTH);
  const atLimitResult = (await ipc.invoke("btw-ask", atLimit)) as BtwAskResult;
  assertEqual(atLimitResult.status, "answered", "exactly-max question passes through");
  // Surrounding whitespace is trimmed before the length check, so a padded
  // question within the limit still passes.
  const padded = `${" ".repeat(3)}${"p".repeat(BTW_MAX_QUESTION_LENGTH - 3)}${"\n"}`;
  const paddedResult = (await ipc.invoke("btw-ask", padded)) as BtwAskResult;
  assertEqual(paddedResult.status, "answered", "whitespace-padded question within limit passes through");
  // 计长口径统一为码点（非 UTF-16 码元）：501 个 emoji = 501 码点 / 1002 码元，
  // 必须放行（原缺陷复现路径：renderer 放行后主进程拒绝）。
  const emojiQuestion = "😀".repeat(501);
  const emojiResult = (await ipc.invoke("btw-ask", emojiQuestion)) as BtwAskResult;
  assertEqual(emojiResult.status, "answered", "501-emoji question (1002 UTF-16 units) passes through");
  assertEqual(deps.asks.length, 3, "all three boundary questions reached deps.ask");
});

await run("guard: over-long by code points resolves an error result", async () => {
  const { ipc, deps } = makeHarness();
  const tooLongEmoji = "😀".repeat(BTW_MAX_QUESTION_LENGTH + 1);
  const result = (await ipc.invoke("btw-ask", tooLongEmoji)) as BtwAskResult;
  assertEqual(result.status, "error", "1001-emoji question resolves error status");
  assertEqual(result.errorMessage, `问题过长（≤${BTW_MAX_QUESTION_LENGTH} 字符）`, "too-long error message");
  assertEqual(deps.asks.length, 0, "deps.ask never called for over-long emoji question");
});

await run("btwValidateQuestion: unified trim-then-code-point counting", async () => {
  assertEqual(btwValidateQuestion(""), "用法：/btw <问题>", "empty question -> usage error");
  assertEqual(btwValidateQuestion("   "), "用法：/btw <问题>", "blank question -> usage error");
  assertEqual(btwValidateQuestion("你好"), null, "normal question -> null");
  assertEqual(btwValidateQuestion("问".repeat(BTW_MAX_QUESTION_LENGTH)), null, "exactly-max question -> null");
  assertEqual(
    btwValidateQuestion("问".repeat(BTW_MAX_QUESTION_LENGTH + 1)),
    `问题过长（≤${BTW_MAX_QUESTION_LENGTH} 字符）`,
    "over-long question -> too-long error",
  );
  // 反向差异消除：恰好 1000 字符 + 尾随空格，trim 后放行。
  assertEqual(
    btwValidateQuestion(`问`.repeat(BTW_MAX_QUESTION_LENGTH) + " "),
    null,
    "exactly-max question with trailing space -> null",
  );
  // 码点口径：501 个 emoji 放行，1001 个 emoji 拒绝（UTF-16 码元口径会误判）。
  assertEqual(btwValidateQuestion("😀".repeat(501)), null, "501 emoji (1002 UTF-16 units) -> null");
  assertEqual(
    btwValidateQuestion("😀".repeat(BTW_MAX_QUESTION_LENGTH + 1)),
    `问题过长（≤${BTW_MAX_QUESTION_LENGTH} 字符）`,
    "1001 emoji -> too-long error",
  );
});

await run("ask: question passthrough and result returned as-is", async () => {
  const { ipc, deps } = makeHarness();
  const question = " 为什么这个文件要这样写？  ";
  const result = (await ipc.invoke("btw-ask", question)) as BtwAskResult;
  assertEqual(deps.asks.length, 1, "deps.ask called exactly once");
  assertEqual(deps.asks[0], question, "exact question forwarded (not trimmed)");
  assertEqual(result.status, "answered", "deps.ask result status returned as-is");
  assertEqual(result.answer, `answer to: ${question}`, "deps.ask result answer returned as-is");

  const errorResult: BtwAskResult = { status: "error", errorMessage: "会话未连接" };
  deps.ask = async () => errorResult;
  const errored = (await ipc.invoke("btw-ask", "again")) as BtwAskResult;
  assertEqual(errored, errorResult, "deps.ask error result returned as-is");
});

await run("cancel: passthrough to deps.cancel", async () => {
  const { ipc, deps } = makeHarness();
  assertEqual(deps.cancels, 0, "deps.cancel not called before invoke");
  await ipc.invoke("btw-cancel");
  assertEqual(deps.cancels, 1, "deps.cancel called once");
  await ipc.invoke("btw-cancel");
  assertEqual(deps.cancels, 2, "deps.cancel called again");
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
