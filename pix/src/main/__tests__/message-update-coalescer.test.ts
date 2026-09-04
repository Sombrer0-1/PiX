/**
 * MessageUpdateCoalescer tests (perf SDD §4.2, Stage S2).
 *
 * Covers the full merge-rule matrix: thinking_delta concatenation (with the
 * newest accumulated message snapshot and no in-place mutation of shared
 * event objects), text_delta / toolcall_delta latest-wins, heterogeneous
 * pending-type flush, markers and unknown ame types passing through
 * immediately with the pending update flushed ahead of them, non-update
 * events flushing pending before passthrough, the fixed (non-sliding)
 * coalescing window, and dispose degrading push() to direct passthrough.
 *
 * Timing tests use real short intervals plus polling waits (no fake clock).
 *
 * Run with: npm exec tsx -- src/main/__tests__/message-update-coalescer.test.ts
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_COALESCE_INTERVAL_MS,
  MessageUpdateCoalescer,
} from "../message-update-coalescer.js";

// ============================================================================
// Test harness (matches agent-task-ipc.test.ts style)
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until the condition holds, failing the test on timeout. */
async function waitFor(condition: () => boolean, ms: number, message: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await sleep(5);
  }
  failed++;
  console.error(`  FAIL: timed out waiting for ${message}`);
}

// ============================================================================
// Fixtures
// ============================================================================

interface UpdateFixture {
  type: "message_update";
  message: { role: "assistant"; text: string };
  assistantMessageEvent: { type: string; delta?: string; contentIndex?: number };
}

/** Build a message_update event. `text` models the accumulated message snapshot. */
function update(ameType: string, delta: string | undefined, text: string): AgentSessionEvent {
  return {
    type: "message_update",
    message: { role: "assistant", text },
    assistantMessageEvent: { type: ameType, delta, contentIndex: 0 },
  } as unknown as AgentSessionEvent;
}

/** Build any non-message_update event (message_end, api_error, ...). */
function plainEvent(type: string): AgentSessionEvent {
  return { type } as unknown as AgentSessionEvent;
}

function ameTypeOf(event: AgentSessionEvent): string | undefined {
  return (event as UpdateFixture).assistantMessageEvent?.type;
}

function deltaOf(event: AgentSessionEvent): string | undefined {
  return (event as UpdateFixture).assistantMessageEvent?.delta;
}

function messageTextOf(event: AgentSessionEvent): string | undefined {
  return (event as UpdateFixture).message?.text;
}

function collect(sink: AgentSessionEvent[]): (event: AgentSessionEvent) => void {
  return (event) => sink.push(event);
}

// ============================================================================
// Tests
// ============================================================================

await run("default interval constant and default-window flush", async () => {
  assertEqual(DEFAULT_COALESCE_INTERVAL_MS, 50, "DEFAULT_COALESCE_INTERVAL_MS is 50");
  const sink: AgentSessionEvent[] = [];
  const coalescer = new MessageUpdateCoalescer(collect(sink));
  coalescer.push(update("thinking_delta", "a", "a"));
  await waitFor(() => sink.length === 1, 500, "default-window flush within 500ms");
  coalescer.dispose();
});

await run("thinking_delta events are concatenated with the latest message snapshot", async () => {
  const sink: AgentSessionEvent[] = [];
  const coalescer = new MessageUpdateCoalescer(collect(sink), 20);
  coalescer.push(update("thinking_delta", "He", "He"));
  coalescer.push(update("thinking_delta", "ll", "Hell"));
  coalescer.push(update("thinking_delta", "o", "Hello"));
  assertEqual(sink.length, 0, "no sink before the window elapses");
  await waitFor(() => sink.length === 1, 500, "merged thinking_delta flushed");
  if (sink.length === 1) {
    assertEqual(ameTypeOf(sink[0]), "thinking_delta", "merged event is a thinking_delta");
    assertEqual(deltaOf(sink[0]), "Hello", "deltas are concatenated");
    assertEqual(messageTextOf(sink[0]), "Hello", "message is the newest accumulated snapshot");
  }
  // The incoming events are shared with main-process consumers and must not
  // be mutated by the merge.
  const first = update("thinking_delta", "He", "He");
  coalescer.push(first);
  coalescer.push(update("thinking_delta", "llo", "Hello"));
  await sleep(60);
  assertEqual(deltaOf(first), "He", "original event object is not mutated in place");
  coalescer.dispose();
});

await run("markers flush the pending update and pass through immediately in order", async () => {
  const markerTypes = [
    "thinking_start",
    "thinking_end",
    "text_start",
    "text_end",
    "toolcall_start",
    "toolcall_end",
    "totally_unknown_type",
  ];
  for (const markerType of markerTypes) {
    const sink: AgentSessionEvent[] = [];
    // Long window: the marker must arrive without waiting for the timer.
    const coalescer = new MessageUpdateCoalescer(collect(sink), 5000);
    coalescer.push(update("thinking_delta", "a", "a"));
    coalescer.push(update("thinking_delta", "b", "ab"));
    assertEqual(sink.length, 0, `${markerType}: nothing sinks while pending`);
    coalescer.push(update(markerType, undefined, "ab"));
    assertEqual(sink.length, 2, `${markerType}: marker passes through synchronously`);
    if (sink.length === 2) {
      assertEqual(ameTypeOf(sink[0]), "thinking_delta", `${markerType}: pending update sinks first`);
      assertEqual(deltaOf(sink[0]), "ab", `${markerType}: flushed update carries the merged delta`);
      assertEqual(ameTypeOf(sink[1]), markerType, `${markerType}: marker sinks second, unbuffered`);
    }
    coalescer.dispose();
  }
});

await run("markers pass through even when nothing is pending", async () => {
  const sink: AgentSessionEvent[] = [];
  const coalescer = new MessageUpdateCoalescer(collect(sink), 5000);
  coalescer.push(update("thinking_start", undefined, ""));
  assertEqual(sink.length, 1, "idle marker still sinks immediately");
  coalescer.dispose();
});

await run("text_delta and toolcall_delta are latest-wins", async () => {
  for (const deltaType of ["text_delta", "toolcall_delta"]) {
    const sink: AgentSessionEvent[] = [];
    const coalescer = new MessageUpdateCoalescer(collect(sink), 5000);
    const stale = update(deltaType, "stale", "stale snapshot");
    const latest = update(deltaType, "latest", "latest snapshot");
    coalescer.push(stale);
    coalescer.push(latest);
    assertEqual(sink.length, 0, `${deltaType}: buffered while pending`);
    coalescer.flush();
    assertEqual(sink.length, 1, `${deltaType}: exactly one event sinks`);
    if (sink.length === 1) {
      assert(sink[0] === latest, `${deltaType}: pending is replaced wholesale by the latest event`);
      assert(sink[0] !== stale, `${deltaType}: stale event is dropped`);
    }
    coalescer.dispose();
  }
});

await run("heterogeneous pending type flushes the old update before buffering", async () => {
  const sink: AgentSessionEvent[] = [];
  const coalescer = new MessageUpdateCoalescer(collect(sink), 5000);
  const thinking = update("thinking_delta", "th", "th");
  const text = update("text_delta", "bo", "body");
  coalescer.push(thinking);
  coalescer.push(text);
  // thinking_delta cannot merge with text_delta: it must flush synchronously.
  assertEqual(sink.length, 1, "old-type pending flushes on heterogeneous arrival");
  if (sink.length === 1) {
    assert(sink[0] === thinking, "flushed event is the earlier thinking_delta");
  }
  assertEqual(sink.length, 1, "new-type event stays buffered");
  coalescer.flush();
  assertEqual(sink.length, 2, "text_delta flushes next");
  if (sink.length === 2) {
    assert(sink[1] === text, "second sink is the text_delta");
  }
  coalescer.dispose();
});

await run("non-update events flush pending then pass through", async () => {
  const sink: AgentSessionEvent[] = [];
  const coalescer = new MessageUpdateCoalescer(collect(sink), 5000);
  coalescer.push(update("thinking_delta", "a", "a"));
  coalescer.push(update("thinking_delta", "b", "ab"));
  const end = plainEvent("message_end");
  coalescer.push(end);
  assertEqual(sink.length, 2, "pending update flushed before the non-update event");
  if (sink.length === 2) {
    assertEqual(ameTypeOf(sink[0]), "thinking_delta", "merged update sinks first");
    assertEqual(deltaOf(sink[0]), "ab", "merged update carries the concatenated delta");
    assert(sink[1] === end, "non-update event passes through unmodified and unmerged");
  }
  coalescer.dispose();
});

await run("coalescing window is fixed, not reset by merges", async () => {
  const sink: AgentSessionEvent[] = [];
  const coalescer = new MessageUpdateCoalescer(collect(sink), 120);
  coalescer.push(update("thinking_delta", "a", "a"));
  // Push past half the window; a sliding implementation would restart it here.
  await sleep(80);
  coalescer.push(update("thinking_delta", "b", "ab"));
  // T0+140: the fixed window fired at ~T0+120. A reset window would not fire
  // until ~T0+80+120 = T0+200.
  await sleep(60);
  assertEqual(sink.length, 1, "window fires at the original deadline despite the late merge");
  if (sink.length === 1) {
    assertEqual(deltaOf(sink[0]), "ab", "merged event still contains both deltas");
  }
  coalescer.dispose();
});

await run("a new window starts after the previous flush", async () => {
  const sink: AgentSessionEvent[] = [];
  const coalescer = new MessageUpdateCoalescer(collect(sink), 20);
  coalescer.push(update("thinking_delta", "a", "a"));
  await waitFor(() => sink.length === 1, 500, "first window flushed");
  coalescer.push(update("thinking_delta", "b", "b"));
  await waitFor(() => sink.length === 2, 500, "second window flushed independently");
  if (sink.length === 2) {
    assertEqual(deltaOf(sink[0]), "a", "first flush carries only the first delta");
    assertEqual(deltaOf(sink[1]), "b", "second flush carries only the second delta");
  }
  coalescer.dispose();
});

await run("flush with nothing pending is a no-op", async () => {
  const sink: AgentSessionEvent[] = [];
  const coalescer = new MessageUpdateCoalescer(collect(sink), 5000);
  coalescer.flush();
  assertEqual(sink.length, 0, "idle flush sinks nothing");
  coalescer.push(update("thinking_delta", "a", "a"));
  coalescer.flush();
  coalescer.flush();
  assertEqual(sink.length, 1, "double flush sinks the pending event exactly once");
  await sleep(80);
  assertEqual(sink.length, 1, "timer was cancelled by flush (no late second sink)");
  coalescer.dispose();
});

await run("dispose flushes pending and degrades push to direct passthrough", async () => {
  const sink: AgentSessionEvent[] = [];
  const coalescer = new MessageUpdateCoalescer(collect(sink), 5000);
  coalescer.push(update("thinking_delta", "a", "a"));
  coalescer.dispose();
  assertEqual(sink.length, 1, "dispose flushes the pending update");
  if (sink.length === 1) {
    assertEqual(deltaOf(sink[0]), "a", "flushed update is intact");
  }
  const late = update("text_delta", "x", "x");
  coalescer.push(late);
  assertEqual(sink.length, 2, "post-dispose update passes through immediately");
  if (sink.length === 2) {
    assert(sink[1] === late, "post-dispose passthrough is unmerged");
  }
  const marker = update("text_end", undefined, "x");
  coalescer.push(marker);
  assertEqual(sink.length, 3, "post-dispose marker passes through immediately");
  const end = plainEvent("message_end");
  coalescer.push(end);
  assertEqual(sink.length, 4, "post-dispose non-update passes through immediately");
  await sleep(80);
  assertEqual(sink.length, 4, "no timer remains after dispose");
  coalescer.dispose();
  coalescer.dispose();
  assertEqual(sink.length, 4, "double dispose is a no-op");
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
