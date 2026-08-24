import { completeSimple, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { BtwAskResult } from "../../shared/btw-types.js";

/** 测试缝：默认 completeSimple；tsx 测试注入 fake（顶层 import 禁内联导入，故作参数注入）。 */
export interface SideQuestionDeps {
  complete?: typeof completeSimple;
}

/** 侧问系统提示后缀（英文，与仓库内 TAKE_HER_EYES_SYSTEM_PROMPT 同风格）。 */
const BTW_SYSTEM_SUFFIX = [
  "You are also answering side questions (asked with /btw) in parallel with the main task.",
  "Side-question answers: use only the existing conversation context, never call tools,",
  "never promise or claim to perform any action, never claim you were interrupted.",
  "Answer concisely (under 300 words; bullet points when helpful).",
  "If the answer is not in the context, say so plainly.",
].join(" ");

/** 用户问题包裹前缀：单回合、无工具、不承诺执行任何动作。 */
const BTW_WRAPPER_PREFIX = [
  "<system-reminder>This is a side question from the user. Answer it directly in a single response.",
  "You have no tools. This is a one-off reply. Do not say you will check, run, or do anything.",
  "Base your answer only on what the conversation already contains.</system-reminder>",
  "",
].join("\n");

const BTW_MAX_TOKENS = 1024;
const BTW_TIMEOUT_MS = 120_000;

/**
 * 侧问核心：复用 session 的模型/系统提示/消息历史，发起一次无工具单回合
 * completeSimple 调用并分类结果。只读 session；不写 messages、不发事件、不记 usage。
 */
export async function runSideQuestion(
  session: AgentSession,
  question: string,
  signal: AbortSignal,
  deps?: SideQuestionDeps,
): Promise<BtwAskResult> {
  const model = session.model;
  if (!model) {
    return { status: "error", errorMessage: "会话未选择模型" };
  }

  const auth = await session.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    return { status: "error", errorMessage: "模型未配置授权" };
  }

  // 纯 role 过滤 + 类型收窄（与 pi-agent-core defaultConvertToLlm 同款），
  // 不做字段变换，custom 消息天然被滤除。
  const messages: Message[] = session.messages.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
  );
  // 不变量：session.messages 只含定稿消息，在途 partial 天然不在其中——
  // agent-core processEvents 在 message_end 同一同步块内清除 streamingMessage
  // 并推入 messages，在途 partial 只存在于 streamingMessage、从不进入
  // messages。因此无需（也无法）按 streamingMessage 判据剔除末条：该字段对
  // 任意角色（含 user、toolResult）的 message_start 都会置位、直到该消息的
  // message_end 才清除（其间 await 全部监听器），按其判据会误删窗口内上一
  // 条已定稿的完整 assistant 消息。
  messages.push({
    role: "user",
    content: BTW_WRAPPER_PREFIX + question,
    timestamp: Date.now(),
  });

  const systemPrompt = session.systemPrompt + "\n\n" + BTW_SYSTEM_SUFFIX;

  const complete = deps?.complete ?? completeSimple;
  let response: AssistantMessage;
  try {
    response = await complete(model, { systemPrompt, messages }, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal,
      maxTokens: BTW_MAX_TOKENS,
      timeoutMs: BTW_TIMEOUT_MS,
      maxRetries: 0,
      reasoning: session.thinkingLevel === "off" ? undefined : session.thinkingLevel,
    });
  } catch (err) {
    return {
      status: "error",
      errorMessage: err instanceof Error && err.message ? err.message : "侧问请求失败",
    };
  }

  if (response.stopReason === "aborted") {
    return { status: "aborted" };
  }
  if (response.stopReason === "error") {
    return { status: "error", errorMessage: response.errorMessage || "侧问请求失败" };
  }

  const answer = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  if (answer !== "") {
    return { status: "answered", answer };
  }
  if (response.content.some((block) => block.type === "toolCall")) {
    return { status: "tool_call_violation", errorMessage: "本轮侧问未产生有效回答，请换种问法或到主对话中提问" };
  }
  return { status: "no_answer", errorMessage: "未获得回答" };
}

/**
 * 在途侧问协调器：实现 askSideQuestion 的"至多一个在途、新 ask 先中止旧"语义。
 * 纯模块（不 import electron），可被 tsx 测试直接实例化。
 */
export interface SideQuestionCoordinator {
  ask(question: string): Promise<BtwAskResult>;
  cancel(): void;
}

/**
 * 协调器内部持有单个 AbortController；ask 先 abort 上一代（若有）再新建并调
 * runSideQuestion，Promise settle 后若仍是本代则清空引用；cancel 仅 abort 当前代。
 */
export function createSideQuestionCoordinator(
  getSession: () => AgentSession,
  deps?: SideQuestionDeps,
): SideQuestionCoordinator {
  let controller: AbortController | undefined;
  return {
    async ask(question: string): Promise<BtwAskResult> {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        return await runSideQuestion(getSession(), question, current.signal, deps);
      } finally {
        if (controller === current) {
          controller = undefined;
        }
      }
    },
    cancel(): void {
      controller?.abort();
    },
  };
}
