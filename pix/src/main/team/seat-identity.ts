/**
 * 席位身份（plan §4.11 `registerSeatIdentity` / §5.1）。
 *
 * 身份必须落在**系统提示**里：L1 是 steer 注入，[deliverAs:"steer"] 不会重跑
 * `before_agent_start`，所以「下次注入时重写身份」这条路根本不存在。这里用与
 * `registerWorkerIdentityPrompt` 相同的方式：每次 agent start 追加一段
 * `<roundtable-seat-identity>` 块。
 *
 * 块内只写圆桌规则本身（对等、只读默认、用 send_team_message 说话、不私密
 * 互聊、依据规则 H16），不写 Leader / 派单 / 完成 gate 之类已删除的语义。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SeatInfo, ToolAuthTier } from "../../shared/team-types.js";
import type { RoundtableToolHost } from "./tool-host.js";

/** 授权档位的中文说明（写进身份，避免席位误以为自己能写）。 */
const AUTH_RULES: Record<ToolAuthTier, string> = {
  read_only:
    "你的授权档位是只读：只能 read/grep/find/ls 与 shell 白名单命令；不能 edit/write，也不能申请写租约。",
  write:
    "你的授权档位可写，但必须先 claim_write_paths 拿到写租约才能 edit/write；team_bash 的 paths 必须全部已持约。",
  restricted:
    "你的授权档位是受限：只能读路径白名单内的文件，且每次 read/grep/find/ls 都必须给出显式 path；永远没有 team_bash。",
};

/**
 * 注册席位身份：`before_agent_start` 时把视角 + 圆桌规则追加到系统提示。
 * host 只用来读名册/档位；工具与 session 都不在这里碰。
 */
export function registerSeatIdentity(host: RoundtableToolHost, pi: ExtensionAPI, seatId: string): void {
  pi.on("before_agent_start", (event) => {
    const seat = host.getState()?.seats[seatId];
    if (seat === undefined) {
      return {};
    }
    return { systemPrompt: `${event.systemPrompt}\n${buildSeatIdentityBlock(seat)}` };
  });
}

/** 纯函数形态（便于测试与复用）：席位身份块文本。 */
export function buildSeatIdentityBlock(seat: SeatInfo): string {
  const peers = `圆桌里的每个席位（包括你）都是对等参与者：没有负责人、没有派单、没有人给你安排任务，也没有「完成」判定。用户是唯一的裁决方。`;
  return [
    "",
    "<roundtable-seat-identity>",
    `你是圆桌席位「${seat.name}」（seatId: ${seat.seatId}），视角：${seat.perspective}`,
    "",
    "圆桌规则：",
    `- ${peers}`,
    "- 助手正文对别人不可见。要说话就用 send_team_message；不发言就等于没参与讨论。",
    "- 席位之间禁止私密互聊（private 只属于用户对单席）；任何结论都必须在时间线上公开。",
    "- 对等请求（request_peer_explore）不是派单：对方可以接、可以拒、可以改范围。",
    `- ${AUTH_RULES[seat.auth]}`,
    "- 依据规则（H16）：结论要么给出工作区路径、命令输出摘录或 URL 作为依据，要么显式标注 claimKind=\"opinion\"。禁止伪造依据，也禁止把没验证过的猜测说成已验证。",
    "- 不确定就说不确定；有反例就直说反例。不要为了顺着别人而放弃自己的视角。",
    "- 被打断（L2/L3）不是失败：收件箱里的新消息会在下一次调用前注入，接着推进就好。",
    "</roundtable-seat-identity>",
    "",
  ].join("\n");
}
