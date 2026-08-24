import { readonly, ref, type Ref } from "vue";
import type { BtwAskResult } from "@shared/types.js";

export interface BtwCardState {
  kind: "idle" | "loading" | "answered" | "failed" | "usage";
  question: string;
  answer?: string;
  errorMessage?: string;
  /** 发起时刻（loading 计时起点）/ 结束时刻（其它 kind）。 */
  settledAt: number;
}

// 模块级单例 reactive state（同 useRpc 模式）：BtwCard 与 CenterPanel 读到的
// 是同一份卡片状态，任何一方发起的变更另一方自动可见。
const card = ref<BtwCardState>({ kind: "idle", question: "", settledAt: 0 });
const elapsedMs = ref(0);
let generation = 0;
let ticker: ReturnType<typeof setInterval> | null = null;

function stopTicker(): void {
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

/** loading 计时：每 100ms 递增，从 0 起。 */
function startTicker(): void {
  stopTicker();
  elapsedMs.value = 0;
  ticker = setInterval(() => {
    elapsedMs.value += 100;
  }, 100);
}

/**
 * 发起一次侧问：置 loading 并调 btwAsk。generation 计数器保证 Promise 回来时
 * 若期间有新的 ask/close/destroy，则整包丢弃，过期结果不得覆盖新状态。
 */
async function askInternal(question: string): Promise<void> {
  const myGeneration = generation + 1;
  generation = myGeneration;
  card.value = { kind: "loading", question, settledAt: Date.now() };
  startTicker();

  let result: BtwAskResult;
  try {
    result = await window.pixApi.btwAsk(question);
  } catch (err) {
    result = { status: "error", errorMessage: err instanceof Error ? err.message : "侧问请求失败" };
  }
  if (generation !== myGeneration) return; // 过期结果整包丢弃

  stopTicker();
  if (result.status === "answered") {
    card.value = { kind: "answered", question, answer: result.answer ?? "", settledAt: Date.now() };
    return;
  }
  if (result.status === "aborted") {
    // 被中止：结果丢弃，卡片回到无卡状态（close/destroy 已置 idle 时此处无感）。
    card.value = { kind: "idle", question: "", settledAt: Date.now() };
    return;
  }
  card.value = {
    kind: "failed",
    question,
    errorMessage: result.errorMessage ?? "侧问请求失败",
    settledAt: Date.now(),
  };
}

export function useBtw(): {
  card: Readonly<Ref<BtwCardState>>;        // kind==="idle" 表示无卡片
  ask(question: string): void;              // 替换旧卡片：先 btwCancel + 丢弃旧结果
  retry(): void;                            // 以 card.question 重发
  close(): void;                            // Esc/×：btwCancel + 置 idle
  destroy(): void;                          // 发送主消息前：等同 close
  showUsage(message: string): void;         // 用法/超长提示卡（kind:"usage"）
  elapsedMs: Readonly<Ref<number>>;         // loading 中每 100ms 递增；settle 定格
} {
  function ask(question: string): void {
    void askInternal(question);
  }

  function retry(): void {
    const current = card.value;
    if (current.kind !== "failed" && current.kind !== "answered") return;
    void askInternal(current.question);
  }

  function close(): void {
    generation += 1;
    stopTicker();
    // 无卡片（idle）即无在途请求，无需也无意调 btwCancel；非 idle 时才中止在途侧问。
    if (card.value.kind !== "idle") {
      window.pixApi.btwCancel();
    }
    card.value = { kind: "idle", question: "", settledAt: 0 };
  }

  function destroy(): void {
    close();
  }

  function showUsage(message: string): void {
    generation += 1;
    stopTicker();
    // 与 close 对齐：非 idle（loading 在途）时中止旧请求，其返回结果由 generation 整包丢弃。
    if (card.value.kind !== "idle") {
      window.pixApi.btwCancel();
    }
    card.value = { kind: "usage", question: "", errorMessage: message, settledAt: Date.now() };
  }

  return {
    card: readonly(card),
    ask,
    retry,
    close,
    destroy,
    showUsage,
    elapsedMs: readonly(elapsedMs),
  };
}
