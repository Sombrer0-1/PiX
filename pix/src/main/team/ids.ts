/**
 * Seat identity helpers (plan H25 / §7.1).
 *
 * `seatId = `${slug}::${roundtableId}``. Slugs are ASCII and never empty, so
 * `parseSeatId` can rely on `sepIndex > 0`. The five default template seats use
 * `PERSPECTIVE_TEMPLATES[i].id` directly; only placeholder/custom seats go
 * through `allocateSeatSlug`.
 *
 * Do NOT reuse team-utils.ts `sanitizeAgentName` here: it returns "" for pure
 * Chinese display names ("资料"), which would collapse every seat id (H25).
 *
 * Also owns the seat colour palette (moved out of team-utils.ts, §7.1).
 */

/** Palette for per-seat UI colours (same-role seats stay distinguishable). */
export const SEAT_COLOR_PALETTE = [
  "#16a34a", // green
  "#6356f3", // indigo
  "#f59e0b", // amber
  "#0ea5e9", // sky
  "#a855f7", // purple
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f97316", // orange
] as const;

/** Pick a palette colour for the nth seat (wraps around, stable per index). */
export function pickSeatColor(index: number): string {
  return SEAT_COLOR_PALETTE[((index % SEAT_COLOR_PALETTE.length) + SEAT_COLOR_PALETTE.length) % SEAT_COLOR_PALETTE.length]!;
}

/** Pre-move names, so existing imports only need a path change. */
export const TEAMMATE_COLOR_PALETTE = SEAT_COLOR_PALETTE;
export const pickTeammateColor = pickSeatColor;

/**
 * ASCII slug of a display name: lowercase `[a-z0-9]` kept, every run of other
 * characters collapses into a single "-", leading/trailing "-" trimmed.
 * Pure Chinese names (the normal case) yield "" and fall back to "seat".
 */
function asciiSlug(displayName: string): string {
  let out = "";
  let pendingDash = false;
  for (const ch of displayName.toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      if (pendingDash && out.length > 0) out += "-";
      pendingDash = false;
      out += ch;
    } else {
      pendingDash = true;
    }
  }
  return out;
}

/**
 * Allocate a seat slug that is unique within `used`, and record it there.
 * Empty/ASCII-less names fall back to "seat"; collisions append -2, -3, ...
 */
export function allocateSeatSlug(displayName: string, used: Set<string>): string {
  const base = asciiSlug(displayName) || "seat";
  let slug = base;
  let suffix = 2;
  while (used.has(slug)) {
    slug = `${base}-${suffix}`;
    suffix++;
  }
  used.add(slug);
  return slug;
}

/** `${slug}::${roundtableId}` — pure string join (H25). */
export function formatSeatId(slug: string, roundtableId: string): string {
  return `${slug}::${roundtableId}`;
}

/** Split a seat id back into slug + roundtableId; null when the separator is missing or at index 0. */
export function parseSeatId(seatId: string): { slug: string; roundtableId: string } | null {
  const sepIndex = seatId.indexOf("::");
  if (sepIndex <= 0) return null;
  return {
    slug: seatId.slice(0, sepIndex),
    roundtableId: seatId.slice(sepIndex + 2),
  };
}
