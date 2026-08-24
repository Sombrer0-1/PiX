/**
 * Plain-data contract for the PiX side-question (BTW) feature (1.5.0).
 *
 * Shared by main (side-question, SessionBridge, ipc-btw-adapters) and
 * renderer (useBtw, BtwCard), so this is a leaf module: no runtime imports
 * (not even each other between git-types and btw-types), every value here
 * survives structuredClone / JSON round-trips and the renderer can import it
 * directly.
 */

/** 侧问单次请求的终态分类。 */
export type BtwAskStatus =
  | "answered"          // 成功，answer 为 Markdown 正文
  | "no_answer"         // 正义完成但正文为空（如思考模型只输出思考块）
  | "tool_call_violation" // 模型违反约定产出工具调用（不展示原始 tool_use）
  | "aborted"           // 被新侧问 / Esc / 卡片销毁中止
  | "error";            // API 错误 / 超时 / 会话未连接 / 模型未授权等

export interface BtwAskResult {
  status: BtwAskStatus;
  /** 仅 status==="answered" 时存在；Markdown 文本。 */
  answer?: string;
  /** 除 answered/aborted 外存在；已本地化、可直接展示的错误文案。 */
  errorMessage?: string;
}

/** 侧问入口常量：问题长度上限（字符数）。 */
export const BTW_MAX_QUESTION_LENGTH = 1000;

/**
 * 侧问问题统一校验：trim 后按码点计数（Array.from），返回错误文案（可直接展示）
 * 或 null（合法）。CenterPanel 拦截分支、ipc-btw-adapters 守卫、SessionBridge
 * 校验三处共用，保证 renderer 与主进程计长口径一致——UTF-16 码元口径在含增补
 * 平面字符（emoji、CJK 扩展 B 等）时会与码点口径产生分歧（501 个 emoji = 501
 * 码点 / 1002 码元），导致 renderer 放行后被主进程拒绝。
 */
export function btwValidateQuestion(question: string): string | null {
  const trimmed = question.trim();
  if (trimmed === "") {
    return "用法：/btw <问题>";
  }
  if (Array.from(trimmed).length > BTW_MAX_QUESTION_LENGTH) {
    return `问题过长（≤${BTW_MAX_QUESTION_LENGTH} 字符）`;
  }
  return null;
}
