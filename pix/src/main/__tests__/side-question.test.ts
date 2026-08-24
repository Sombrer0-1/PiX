/**
 * Side-question (/btw) tests (PiX 1.5.0, S2C).
 *
 * Covers runSideQuestion result classification against an injected fake
 * complete (answered / no_answer / tool_call_violation / aborted / error),
 * the no-partial-removal invariant (session.messages only holds finalized
 * messages; streamingMessage state does not alter the side-question
 * context), systemPrompt suffix concatenation, reasoning passthrough
 * (off -> undefined, other levels passed through), message role filtering
 * (custom messages dropped) and the coordinator's at-most-one-in-flight
 * semantics (a new ask aborts the old, cancel aborts the in-flight ask).
 * Pure Node, no Electron.
 *
 * Run with: npx tsx pix/src/main/__tests__/side-question.test.ts
 */

import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  StopReason,
  TextContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, ThinkingLevel } from "@earendil-works/pi-coding-agent";
import { createSideQuestionCoordinator, runSideQuestion, type SideQuestionDeps } from "../btw/side-question.js";

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

/** Yield to pending microtasks so async chains (auth -> complete) register. */
function drain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ============================================================================
// Fixtures
// ============================================================================

const EXPECTED_BTW_SYSTEM_SUFFIX = [
  "You are also answering side questions (asked with /btw) in parallel with the main task.",
  "Side-question answers: use only the existing conversation context, never call tools,",
  "never promise or claim to perform any action, never claim you were interrupted.",
  "Answer concisely (under 300 words; bullet points when helpful).",
  "If the answer is not in the context, say so plainly.",
].join(" ");

const EXPECTED_BTW_WRAPPER_PREFIX = [
  "<system-reminder>This is a side question from the user. Answer it directly in a single response.",
  "You have no tools. This is a one-off reply. Do not say you will check, run, or do anything.",
  "Base your answer only on what the conversation already contains.</system-reminder>",
  "",
].join("\n");

const EMPTY_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeModel(): Model<Api> {
  return {
    id: "faux-model",
    name: "faux-model",
    api: "faux-api",
    provider: "faux",
    baseUrl: "http://localhost:1",
    reasoning: true,
    thinkingLevelMap: { off: null, low: "low", high: "high" },
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 4096,
  } as unknown as Model<Api>;
}

function text(contents: string): TextContent {
  return { type: "text", text: contents };
}

function toolCall(name = "read"): ToolCall {
  return { type: "toolCall", id: "tc-1", name, arguments: {} };
}

function scriptedAssistant(
  content: Array<TextContent | ToolCall>,
  stopReason: StopReason = "stop",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "faux-api",
    provider: "faux",
    model: "faux-model",
    usage: EMPTY_USAGE,
    stopReason,
    errorMessage,
    timestamp: 1,
  };
}

function userMsg(contents: string): Message {
  return { role: "user", content: contents, timestamp: 1 };
}

function assistantMsg(contents: Array<TextContent | ToolCall>): Message {
  return { role: "assistant", content: contents, api: "faux-api", provider: "faux", model: "faux-model", usage: EMPTY_USAGE, stopReason: "stop", timestamp: 2 };
}

function toolResultMsg(contents: string): Message {
  return { role: "toolResult", toolCallId: "tc-1", toolName: "read", content: [text(contents)], isError: false, timestamp: 3 };
}

function customMsg(contents: string): AgentMessage {
  return { role: "custom", customType: "pix-test", content: contents, display: true, timestamp: 4 } as AgentMessage;
}

interface FakeRegistryAuth {
  ok: true;
  apiKey?: string;
  headers?: Record<string, string>;
}

interface MakeSessionOptions {
  model?: Model<Api> | null;
  auth?: FakeRegistryAuth | { ok: false; error: string };
  messages?: AgentMessage[];
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  streamingMessage?: AgentMessage | undefined;
}

function makeSession(options: MakeSessionOptions = {}): AgentSession {
  return {
    model: options.model === undefined ? makeModel() : options.model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => options.auth ?? { ok: true, apiKey: "test-key" },
    },
    messages: options.messages ?? [],
    systemPrompt: options.systemPrompt ?? "Base system prompt",
    thinkingLevel: options.thinkingLevel ?? "off",
    agent: {
      state: {
        streamingMessage: options.streamingMessage,
      },
    },
  } as unknown as AgentSession;
}

interface CapturedCall {
  model: Model<Api>;
  context: Context;
  options: SimpleStreamOptions;
}

function makeCapturingComplete(scripted: AssistantMessage, captured: CapturedCall[]): SideQuestionDeps {
  return {
    complete: async (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
      captured.push({ model, context, options: options ?? {} });
      return scripted;
    },
  };
}

/** Fake complete that stays pending until the test resolves it; aborts resolve as aborted. */
interface DeferredCall {
  resolve: (message: AssistantMessage) => void;
  signal: AbortSignal | undefined;
}

function makeDeferrableComplete(deferred: DeferredCall[]): SideQuestionDeps {
  return {
    complete: async (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
      return new Promise<AssistantMessage>((resolve) => {
        const signal = options?.signal;
        if (signal) {
          if (signal.aborted) {
            resolve(scriptedAssistant([], "aborted"));
          } else {
            signal.addEventListener("abort", () => resolve(scriptedAssistant([], "aborted")), { once: true });
          }
        }
        deferred.push({ resolve, signal });
      });
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

await run("classification: answered", async () => {
  const captured: CapturedCall[] = [];
  const deps = makeCapturingComplete(
    scriptedAssistant([text("  first "), text("second\n")]),
    captured,
  );
  const result = await runSideQuestion(makeSession(), "q", new AbortController().signal, deps);
  assertEqual(result.status, "answered", "status answered");
  if (result.status === "answered") {
    assertEqual(result.answer, "first second", "text blocks joined with no separator and trimmed");
  }
  assertEqual(captured.length, 1, "complete called once");
});

await run("classification: no_answer", async () => {
  // Empty content.
  const empty = await runSideQuestion(
    makeSession(),
    "q",
    new AbortController().signal,
    makeCapturingComplete(scriptedAssistant([]), []),
  );
  assertEqual(empty.status, "no_answer", "empty content -> no_answer");
  if (empty.status === "no_answer") {
    assertEqual(empty.errorMessage, "未获得回答", "no_answer message");
  }

  // Whitespace-only text.
  const whitespace = await runSideQuestion(
    makeSession(),
    "q",
    new AbortController().signal,
    makeCapturingComplete(scriptedAssistant([text("   \n")]), []),
  );
  assertEqual(whitespace.status, "no_answer", "whitespace-only text -> no_answer");

  // Thinking-only output (thinking models that emit no text block).
  const thinkingOnly = scriptedAssistant([], "stop");
  thinkingOnly.content.push({ type: "thinking", thinking: "deliberation" });
  const thinking = await runSideQuestion(
    makeSession(),
    "q",
    new AbortController().signal,
    makeCapturingComplete(thinkingOnly, []),
  );
  assertEqual(thinking.status, "no_answer", "thinking-only content -> no_answer");
});

await run("classification: tool_call_violation", async () => {
  const violation = await runSideQuestion(
    makeSession(),
    "q",
    new AbortController().signal,
    makeCapturingComplete(scriptedAssistant([toolCall()]), []),
  );
  assertEqual(violation.status, "tool_call_violation", "toolCall-only content -> tool_call_violation");
  if (violation.status === "tool_call_violation") {
    assertEqual(violation.errorMessage, "本轮侧问未产生有效回答，请换种问法或到主对话中提问", "violation message");
  }

  const emptyTextPlusCall = await runSideQuestion(
    makeSession(),
    "q",
    new AbortController().signal,
    makeCapturingComplete(scriptedAssistant([toolCall(), text("")]), []),
  );
  assertEqual(emptyTextPlusCall.status, "tool_call_violation", "empty text + toolCall -> tool_call_violation");
});

await run("classification: aborted", async () => {
  const result = await runSideQuestion(
    makeSession(),
    "q",
    new AbortController().signal,
    makeCapturingComplete(scriptedAssistant([text("partial")], "aborted"), []),
  );
  assertEqual(result.status, "aborted", "stopReason aborted -> status aborted");
  assertEqual(result.answer, undefined, "no answer on aborted");
  assertEqual(result.errorMessage, undefined, "no errorMessage on aborted");
});

await run("classification: error", async () => {
  const withMessage = await runSideQuestion(
    makeSession(),
    "q",
    new AbortController().signal,
    makeCapturingComplete(scriptedAssistant([], "error", "upstream failure"), []),
  );
  assertEqual(withMessage.status, "error", "stopReason error -> status error");
  if (withMessage.status === "error") {
    assertEqual(withMessage.errorMessage, "upstream failure", "response errorMessage surfaced");
  }

  const withoutMessage = await runSideQuestion(
    makeSession(),
    "q",
    new AbortController().signal,
    makeCapturingComplete(scriptedAssistant([], "error"), []),
  );
  assertEqual(withoutMessage.status, "error", "error without errorMessage -> status error");
  if (withoutMessage.status === "error") {
    assertEqual(withoutMessage.errorMessage, "侧问请求失败", "fallback errorMessage");
  }
});

await run("thrown errors are classified as error", async () => {
  const thrown = await runSideQuestion(
    makeSession(),
    "q",
    new AbortController().signal,
    {
      complete: async () => {
        throw new Error("boom");
      },
    },
  );
  assertEqual(thrown.status, "error", "thrown Error -> status error");
  if (thrown.status === "error") {
    assertEqual(thrown.errorMessage, "boom", "thrown message surfaced");
  }

  const emptyMessage = await runSideQuestion(
    makeSession(),
    "q",
    new AbortController().signal,
    {
      complete: async () => {
        throw new Error("");
      },
    },
  );
  assertEqual(emptyMessage.status, "error", "thrown Error without message -> status error");
  if (emptyMessage.status === "error") {
    assertEqual(emptyMessage.errorMessage, "侧问请求失败", "fallback errorMessage for empty message");
  }

  const nonError = await runSideQuestion(
    makeSession(),
    "q",
    new AbortController().signal,
    {
      complete: async () => {
        throw "string failure";
      },
    },
  );
  assertEqual(nonError.status, "error", "non-Error throw -> status error");
  if (nonError.status === "error") {
    assertEqual(nonError.errorMessage, "侧问请求失败", "fallback errorMessage for non-Error throw");
  }
});

await run("guards: no model and no auth", async () => {
  const captured: CapturedCall[] = [];
  const noModel = await runSideQuestion(
    makeSession({ model: null }),
    "q",
    new AbortController().signal,
    makeCapturingComplete(scriptedAssistant([text("x")]), captured),
  );
  assertEqual(noModel.status, "error", "no model -> status error");
  if (noModel.status === "error") {
    assertEqual(noModel.errorMessage, "会话未选择模型", "no-model message");
  }
  assertEqual(captured.length, 0, "complete not called without a model");

  const noAuth = await runSideQuestion(
    makeSession({ auth: { ok: false, error: "no key" } }),
    "q",
    new AbortController().signal,
    makeCapturingComplete(scriptedAssistant([text("x")]), captured),
  );
  assertEqual(noAuth.status, "error", "auth failure -> status error");
  if (noAuth.status === "error") {
    assertEqual(noAuth.errorMessage, "模型未配置授权", "no-auth message");
  }
  assertEqual(captured.length, 0, "complete not called without auth");
});

await run("context assembly: role filtering, wrapper user message, systemPrompt suffix", async () => {
  const captured: CapturedCall[] = [];
  const session = makeSession({
    systemPrompt: "Base system prompt",
    messages: [userMsg("hi"), assistantMsg([text("hello")]), toolResultMsg("ok"), customMsg("custom!")],
  });
  const before = Date.now();
  await runSideQuestion(session, "what is the weather?", new AbortController().signal, makeCapturingComplete(scriptedAssistant([text("sunny")]), captured));
  const after = Date.now();

  assertEqual(captured.length, 1, "complete called once");
  if (captured.length === 1) {
    const { context, options } = captured[0];
    assertEqual(context.messages.length, 4, "custom message filtered out");
    assertEqual(context.messages[0].role, "user", "first message kept");
    assertEqual(context.messages[1].role, "assistant", "assistant message kept");
    assertEqual(context.messages[2].role, "toolResult", "toolResult message kept");

    const wrapper = context.messages[3];
    assertEqual(wrapper.role, "user", "question appended as user message");
    if (wrapper.role === "user") {
      assertEqual(
        typeof wrapper.content === "string" ? wrapper.content : JSON.stringify(wrapper.content),
        EXPECTED_BTW_WRAPPER_PREFIX + "what is the weather?",
        "wrapper prefix + question verbatim",
      );
      assert(wrapper.timestamp >= before && wrapper.timestamp <= after, "wrapper timestamp is now");
    }

    assertEqual(
      context.systemPrompt,
      "Base system prompt\n\n" + EXPECTED_BTW_SYSTEM_SUFFIX,
      "systemPrompt suffix appended with blank line",
    );
    assertEqual(options.apiKey, "test-key", "apiKey flows through");
    assertEqual(options.maxTokens, 1024, "maxTokens 1024");
    assertEqual(options.timeoutMs, 120_000, "timeoutMs 120s");
    assertEqual(options.maxRetries, 0, "maxRetries 0");
    assertEqual(options.signal?.aborted, false, "signal passed through and not aborted");
  }
});

await run("invariant: no partial removal — session.messages only holds finalized messages", async () => {
  const streamingPartial = scriptedAssistant([text("partial")]);
  const cases: Array<{
    name: string;
    session: AgentSession;
    expectedRoles: string[];
  }> = [
    {
      // Regression for the retired criterion: within a user/toolResult
      // message_start->message_end window streamingMessage is non-empty while
      // the last finalized message is a complete assistant message; the old
      // pop would have dropped it from the side-question context.
      name: "streamingMessage set + trailing finalized assistant kept",
      session: makeSession({
        streamingMessage: streamingPartial,
        messages: [userMsg("hi"), toolResultMsg("ok"), assistantMsg([text("in-flight")])],
      }),
      expectedRoles: ["user", "toolResult", "assistant", "user"],
    },
    {
      name: "streamingMessage undefined -> assistant kept",
      session: makeSession({
        streamingMessage: undefined,
        messages: [userMsg("hi"), assistantMsg([text("done")])],
      }),
      expectedRoles: ["user", "assistant", "user"],
    },
    {
      name: "streamingMessage set + trailing toolResult kept",
      session: makeSession({
        streamingMessage: streamingPartial,
        messages: [userMsg("hi"), toolResultMsg("ok")],
      }),
      expectedRoles: ["user", "toolResult", "user"],
    },
    {
      name: "streamingMessage set + trailing user kept",
      session: makeSession({
        streamingMessage: streamingPartial,
        messages: [userMsg("hi"), assistantMsg([text("done")]), userMsg("follow-up")],
      }),
      expectedRoles: ["user", "assistant", "user", "user"],
    },
    {
      name: "role filter still applies (custom trailing message dropped, assistant kept)",
      session: makeSession({
        streamingMessage: streamingPartial,
        messages: [userMsg("hi"), assistantMsg([text("in-flight")]), customMsg("custom!")],
      }),
      expectedRoles: ["user", "assistant", "user"],
    },
  ];

  for (const testCase of cases) {
    const captured: CapturedCall[] = [];
    await runSideQuestion(testCase.session, "q", new AbortController().signal, makeCapturingComplete(scriptedAssistant([text("a")]), captured));
    assertEqual(captured.length, 1, `${testCase.name}: complete called`);
    if (captured.length === 1) {
      assertEqual(
        captured[0].context.messages.map((m) => m.role).join(","),
        testCase.expectedRoles.join(","),
        `${testCase.name}: roles`,
      );
    }
  }
});

await run("reasoning passthrough", async () => {
  for (const level of ["off", "minimal", "high"] as const) {
    const captured: CapturedCall[] = [];
    await runSideQuestion(
      makeSession({ thinkingLevel: level }),
      "q",
      new AbortController().signal,
      makeCapturingComplete(scriptedAssistant([text("a")]), captured),
    );
    assertEqual(captured.length, 1, `${level}: complete called`);
    if (captured.length === 1) {
      assertEqual(
        captured[0].options.reasoning,
        level === "off" ? undefined : level,
        `${level}: reasoning ${level === "off" ? "undefined" : level}`,
      );
    }
  }
});

await run("coordinator: a new ask aborts the old in-flight ask", async () => {
  const deferred: DeferredCall[] = [];
  const coordinator = createSideQuestionCoordinator(() => makeSession(), makeDeferrableComplete(deferred));

  const first = coordinator.ask("q1");
  const second = coordinator.ask("q2");

  const firstResult = await first;
  assertEqual(firstResult.status, "aborted", "old ask resolves aborted");
  assertEqual(deferred.length, 2, "both complete calls made");
  if (deferred.length === 2) {
    assertEqual(deferred[0].signal?.aborted ?? false, true, "old call's signal aborted");
    assertEqual(deferred[1].signal?.aborted ?? false, false, "new call's signal not aborted");
  }

  deferred[1].resolve(scriptedAssistant([text("second answer")], "stop"));
  const secondResult = await second;
  assertEqual(secondResult.status, "answered", "new ask still answers");
  if (secondResult.status === "answered") {
    assertEqual(secondResult.answer, "second answer", "new ask's answer");
  }
});

await run("coordinator: cancel aborts the in-flight ask", async () => {
  const deferred: DeferredCall[] = [];
  const coordinator = createSideQuestionCoordinator(() => makeSession(), makeDeferrableComplete(deferred));

  const pending = coordinator.ask("q");
  coordinator.cancel();

  const result = await pending;
  assertEqual(result.status, "aborted", "cancel -> in-flight ask aborted");
  assertEqual(deferred.length, 1, "complete called once");
  if (deferred.length === 1) {
    assertEqual(deferred[0].signal?.aborted ?? false, true, "aborted via the coordinator's controller");
  }
});

await run("coordinator: settled ask clears the reference; later cancel is a no-op", async () => {
  const deferred: DeferredCall[] = [];
  const coordinator = createSideQuestionCoordinator(() => makeSession(), makeDeferrableComplete(deferred));

  const first = coordinator.ask("q1");
  await drain();
  assertEqual(deferred.length, 1, "first ask reached complete");
  deferred[0].resolve(scriptedAssistant([text("one")], "stop"));
  assertEqual((await first).status, "answered", "first ask answered");

  // Cancel after settle must not abort anything and must not throw.
  coordinator.cancel();

  const second = coordinator.ask("q2");
  await drain();
  assertEqual(deferred.length, 2, "second ask reached complete");
  if (deferred.length === 2) {
    assertEqual(deferred[1].signal?.aborted ?? false, false, "second ask not pre-aborted by the stale cancel");
  }
  deferred[1].resolve(scriptedAssistant([text("two")], "stop"));
  assertEqual((await second).status, "answered", "second ask answered");
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
