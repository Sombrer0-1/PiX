import type { SessionInfo } from "@/types/session";

const EMPTY_FIRST_MESSAGE = "(no messages)";
const MAX_TITLE_CHARS = 28;

function compactText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "代码片段")
    .replace(/https?:\/\/\S+/g, "链接")
    .replace(/\s+/g, " ")
    .trim();
}

function stripRequestPrefix(text: string): string {
  let result = text
    .replace(/^修复\s*bug\s*[:：,，]?\s*/i, "")
    .replace(/^bug\s*[:：,，]?\s*/i, "");

  for (let i = 0; i < 2; i++) {
    result = result
      .replace(/^\d+[.、)]\s*/, "")
      .replace(/^(请|请你|帮我|麻烦|麻烦你|我希望|希望|我想|需要|实现|处理)\s*/i, "");
  }

  return result.trim();
}

function truncateTitle(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= MAX_TITLE_CHARS) return text;
  return `${chars.slice(0, MAX_TITLE_CHARS).join("")}…`;
}

export function summarizeSessionText(text: string): string {
  const compact = stripRequestPrefix(compactText(text));
  const parts = compact
    .split(/(?:但是|不过|然后|另外|还有|同时|以及|[。！？!?；;，,\n])/)
    .map((part) => stripRequestPrefix(part))
    .filter((part) => part.length > 1);

  return truncateTitle(parts[0] || compact || "新会话");
}

export function deriveSessionTitle(session: SessionInfo | null | undefined): string {
  if (!session) return "新会话";

  const explicitName = session.name?.trim();
  if (explicitName) return truncateTitle(explicitName);

  const firstMessage = session.firstMessage?.trim();
  if (firstMessage && firstMessage !== EMPTY_FIRST_MESSAGE) {
    return summarizeSessionText(firstMessage);
  }

  return "新会话";
}

export function formatSessionTime(value: string | number | Date | undefined): string {
  if (!value) return "";

  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";

  const diff = Math.max(0, Date.now() - time);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时`;
  if (diff < 2 * day) return "昨天";
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天`;

  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
