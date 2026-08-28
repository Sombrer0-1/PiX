import type { ThinkingLevel } from "@/types/rpc";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export const THINKING_LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  off: "不启用额外推理，适合直接任务",
  minimal: "最低推理开销，适合快速回答",
  low: "优先响应速度，适合简单任务",
  medium: "推荐日常使用",
  high: "更强推理，适合复杂问题",
  xhigh: "最充分思考，适合高难任务",
};

export function thinkingLevelLabel(level: string): string {
  return THINKING_LEVELS.includes(level as ThinkingLevel) ? level : level;
}

export function thinkingLevelDescription(level: string): string {
  return THINKING_LEVEL_DESCRIPTIONS[level as ThinkingLevel] ?? "选择该模型的思考深度";
}

export const thinkingLevelItems: Array<{ title: string; value: ThinkingLevel }> = THINKING_LEVELS.map((value) => ({
  title: value,
  value,
}));
