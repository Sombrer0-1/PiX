import type { TeammateChatMessage } from "../shared/types.js";
import { MAX_MESSAGE_HISTORY } from "./team-constants.js";

/** Format an agent ID: "agentName::teamName" (uses '::' to avoid ambiguity with '@' in names). */
export function formatAgentId(agentName: string, teamName: string): string {
  return `${agentName}::${teamName}`;
}

/** Parse an agent ID into its components. */
export function parseAgentId(agentId: string): { agentName: string; teamName: string } | null {
  const sepIndex = agentId.lastIndexOf("::");
  if (sepIndex <= 0 || sepIndex >= agentId.length - 2) return null;
  return {
    agentName: agentId.slice(0, sepIndex),
    teamName: agentId.slice(sepIndex + 2),
  };
}

/** Push a message to a history array, evicting the oldest entry if over the cap. */
export function pushHistory(arr: TeammateChatMessage[], msg: TeammateChatMessage): void {
  arr.push(msg);
  if (arr.length > MAX_MESSAGE_HISTORY) arr.shift();
}

/** Generate a simple team name from a timestamp suffix. */
export function generateTeamName(): string {
  const suffix = Date.now().toString(36).slice(-6);
  return `team-${suffix}`;
}

/**
 * Sanitize an LLM-provided teammate name into a safe short identifier:
 * lowercase alphanumerics and dashes, no leading/trailing dashes, max 32 chars.
 * Returns "" when nothing usable remains (caller falls back to the role name).
 */
export function sanitizeAgentName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/** Palette for per-teammate UI colors (same-role teammates stay distinguishable). */
export const TEAMMATE_COLOR_PALETTE = [
  "#16a34a", // green
  "#6356f3", // indigo
  "#f59e0b", // amber
  "#0ea5e9", // sky
  "#a855f7", // purple
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f97316", // orange
] as const;

/** Pick a palette color for the nth teammate (wraps around). */
export function pickTeammateColor(index: number): string {
  return TEAMMATE_COLOR_PALETTE[((index % TEAMMATE_COLOR_PALETTE.length) + TEAMMATE_COLOR_PALETTE.length) % TEAMMATE_COLOR_PALETTE.length]!;
}

/** Sleep for the given number of milliseconds. Supports AbortSignal for cleanup. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
