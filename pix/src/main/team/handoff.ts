/**
 * 移交 payload（plan §4.15 / §5.13，H15 / FR-12）。
 *
 * 只产文本，不 import PlanController、不碰 solo 会话、不做任何 IO：
 * renderer 拿文本走既有出口（solo: newSession 后当第一条用户消息；
 * Plan: enterPlanning({ requestText })）。移交单向，讨论可继续出下一版。
 *
 * H15：Plan 的字段名是 `requestText`（不是 `request.text`）。facade 的
 * `buildHandoff(id, target)` 仍只回 `{ text }`（§4.12），由 renderer 决定怎么用。
 */

import type { DeliverableVersion, RoundtableState } from "../../shared/team-types.js";

/** 移交 payload 的公共来源：绑定具体交付物版本（AC-19）。 */
export interface HandoffInput {
  state: RoundtableState;
  deliverable: DeliverableVersion;
}

/** 来源脚注：圆桌名 + 版本 + 截止点，便于在 solo / Plan 里追溯。 */
function sourceFooter(input: HandoffInput): string {
  const { state, deliverable } = input;
  return `> 来源：roundtable ${state.name}（${state.roundtableId}）| 交付物 v${deliverable.version}（id ${deliverable.id}）| cutoffSeq=${deliverable.cutoffSeq} | 席位 ${Object.keys(state.seats).length}`;
}

/** 未验证段：缺依据的结论在这里显式列出，避免移交后当成已验证事实（AC-5）。 */
function untracedSection(deliverable: DeliverableVersion): string[] {
  const lines: string[] = [];
  if (deliverable.sections.evidenceIndex.trim().length === 0) {
    lines.push("", "未验证：本版没有记录任何依据入口，结论均为未验证。");
  }
  if (deliverable.sections.disagreements.trim().length === 0) {
    lines.push("", "本版未记录分歧与未决项：如与实施结果冲突，以现场复核为准。");
  }
  return lines;
}

/**
 * 移交 solo：交付物 Markdown 直接作为新 solo 会话的第一条用户消息。
 * 提示词只说清「这是一份讨论稿、实施边界在仓库」，不携带任何 Team 运行时状态。
 */
export function buildSoloHandoffPrompt(input: HandoffInput): string {
  const { deliverable } = input;
  const missing = Object.keys(input.state.seats).length === 0 ? { absent: [], unspoken: [] } : classifySeats(input);
  return [
    `# 圆桌交付物 v${deliverable.version}`,
    "",
    "以下是一轮圆桌讨论（多席位对等讨论，无负责人）整理出的方案稿。请按它实施：把结论当成待验证的输入，不要当成已验证事实；有冲突时以仓库现状为准。",
    "",
    "---",
    "",
    deliverable.markdown.trim().length > 0
      ? deliverable.markdown
      : "_（本版没有正文：整理调用未产出内容，请以时间线为准。）_",
    "",
    "---",
    "",
    `依据入口：${deliverable.sections.evidenceIndex || "（本版未记录依据入口，标未验证）"}`,
    `分歧与未决：${deliverable.sections.disagreements || "（无）"}`,
    `后续动作：${deliverable.sections.nextActions || "（无）"}`,
    ...(missing.absent.length > 0 ? [`缺席视角：${missing.absent.join("、")}（未参与本版，不代表同意）`] : []),
    ...(missing.unspoken.length > 0 ? [`未表态：${missing.unspoken.join("、")}（在场但未表态，不代表同意）`] : []),
    ...untracedSection(deliverable),
    "",
    sourceFooter(input),
  ].join("\n");
}

/**
 * 移交 Plan：字段名 `requestText`（H15）。文本面向 Plan 的「请求」输入，
 * 因此把结论、依据、未决压缩成一段可执行的诉求，而不是整份记录。
 */
export function buildPlanHandoffRequest(input: HandoffInput): { requestText: string } {
  const { deliverable } = input;
  const requestText = [
    `# 圆桌交付物 v${deliverable.version}`,
    "",
    "以下方案来自一轮圆桌讨论，请据此规划实施步骤；结论里的「未验证」条目需要先验证再落地。",
    "",
    deliverable.sections.conclusions.trim().length > 0
      ? deliverable.sections.conclusions.trim()
      : deliverable.markdown.trim(),
    "",
    `依据入口：${deliverable.sections.evidenceIndex || "（未记录，标未验证）"}`,
    `分歧与未决：${deliverable.sections.disagreements || "（无）"}`,
    `后续动作：${deliverable.sections.nextActions || "（无）"}`,
    "",
    sourceFooter(input),
  ].join("\n");
  return { requestText };
}

/** 缺席 = 已退出或显式 `stance: "absent"`；未表态 = 仍在场且没有支持/反对/有条件。 */
function classifySeats(input: HandoffInput): { absent: string[]; unspoken: string[] } {
  const stances = input.deliverable.stances ?? [];
  const spoken = new Set(stances.filter((stance) => stance.stance !== "absent").map((stance) => stance.seatId));
  const markedAbsent = new Set(stances.filter((stance) => stance.stance === "absent").map((stance) => stance.seatId));
  const absent: string[] = [];
  const unspoken: string[] = [];
  for (const seat of Object.values(input.state.seats)) {
    if (seat.status === "exited" || markedAbsent.has(seat.seatId)) {
      absent.push(seat.name);
      continue;
    }
    if (!spoken.has(seat.seatId)) {
      unspoken.push(seat.name);
    }
  }
  return { absent, unspoken };
}
