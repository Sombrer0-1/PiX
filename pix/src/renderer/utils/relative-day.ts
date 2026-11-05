/**
 * Format a timestamp relative to the local calendar day.
 * Uses midnights rather than rolling 24h windows so "昨天" means yesterday's date.
 */
export function formatRelativeDay(
  timestamp: number,
  now: Date = new Date(),
): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfThatDay) / 86_400_000);

  if (dayDiff <= 0) return "今天";
  if (dayDiff === 1) return "昨天";
  if (dayDiff < 7) return `${dayDiff} 天前`;

  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}
