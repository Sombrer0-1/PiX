/**
 * Seat id / slug tests (S0, plan H25 + §4.1/§4.2).
 *
 * Covers:
 *   - the five default Chinese labels (资料/反例/理论/可行性/实验) allocate five
 *     non-empty, mutually distinct slugs (never via sanitizeAgentName)
 *   - duplicate display names are deduped (-2, -3, ...) and a caller-provided
 *     `used` set is respected
 *   - empty / whitespace / punctuation-only names fall back to "seat"
 *   - formatSeatId <-> parseSeatId round-trip; sepIndex > 0 enforcement
 *   - the default five slug set equals the five PERSPECTIVE_TEMPLATES ids
 *   - seat colours are non-empty and stable for consecutive indices
 *   - the shared constants/helpers of team-types.ts match §4.1
 *
 * Run with: npx tsx pix/src/main/__tests__/team-ids.test.ts
 */

import {
  allocateSeatSlug,
  formatSeatId,
  parseSeatId,
  pickSeatColor,
  pickTeammateColor,
  SEAT_COLOR_PALETTE,
  TEAMMATE_COLOR_PALETTE,
} from "../team/ids.js";
import {
  DEFAULT_ROUNDTABLE_TIER,
  MAX_SEATS,
  MIN_SEATS,
  PERSPECTIVE_TEMPLATES,
  ROUNDTABLE_TIER_SEATS,
  timelineTypeFromUtterance,
  USER_SEAT_ID,
  type UtteranceKind,
  type TimelineItemType,
} from "../../shared/team-types.js";

// ============================================================================
// Test harness (matches execution-context.test.ts / team-manager.test.ts style)
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(
      `  FAIL: ${message} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${name} ===\n`);
  try {
    await fn();
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name} threw unexpectedly: ${String(err)}`);
  }
}

/** The five default (standard tier) seat labels from appendix A. */
const DEFAULT_SEAT_LABELS = ["资料", "反例", "理论", "可行性", "实验"];

// ============================================================================
// Tests
// ============================================================================

await run("allocateSeatSlug: five Chinese default labels -> five distinct slugs", async () => {
  const used = new Set<string>();
  const slugs = DEFAULT_SEAT_LABELS.map((label) => allocateSeatSlug(label, used));

  assertEqual(slugs.length, 5, "five labels allocated");
  assert(slugs.every((slug) => slug.length > 0), `all slugs non-empty: ${JSON.stringify(slugs)}`);
  assertEqual(new Set(slugs).size, 5, `five mutually distinct slugs: ${JSON.stringify(slugs)}`);
  assertEqual(used.size, 5, "each allocated slug is recorded in the caller's used set");
  assert(
    slugs.every((slug) => !slug.includes("::")),
    "no slug contains the seatId separator",
  );
  // A pure Chinese name has no ASCII to keep, so the fallback chain applies.
  assertEqual(slugs[0], "seat", "first Chinese label falls back to 'seat'");
  assertEqual(slugs[1], "seat-2", "second Chinese label dedupes to 'seat-2'");
  assertEqual(slugs[4], "seat-5", "fifth Chinese label dedupes to 'seat-5'");
});

await run("allocateSeatSlug: ASCII names, punctuation-only names, collisions", async () => {
  const used = new Set<string>();
  assertEqual(allocateSeatSlug("Coder UI!", used), "coder-ui", "punctuation collapses into '-' and is trimmed");
  assertEqual(allocateSeatSlug("视角 1", used), "1", "appendix A placeholder: '视角 1' -> '1'");
  assertEqual(allocateSeatSlug("  Sources  ", used), "sources", "case folded and trimmed");

  // Empty / whitespace / punctuation-only names fall back to "seat", never "".
  const fallbackNames = ["", "   ", "///", "@@@ —", "···", "！？"];
  const fallbackUsed = new Set<string>();
  const fallbackSlugs = fallbackNames.map((name) => allocateSeatSlug(name, fallbackUsed));
  assert(fallbackSlugs.every((slug) => slug.length > 0), `fallbacks never empty: ${JSON.stringify(fallbackSlugs)}`);
  assertEqual(fallbackSlugs[0], "seat", "empty name -> 'seat'");
  assertEqual(fallbackSlugs[1], "seat-2", "whitespace-only name -> 'seat-2'");
  assertEqual(new Set(fallbackSlugs).size, fallbackNames.length, "fallback slugs stay distinct");

  // Duplicate display name: the second call gets a different slug.
  const dupUsed = new Set<string>();
  const first = allocateSeatSlug("Alice", dupUsed);
  const second = allocateSeatSlug("Alice", dupUsed);
  assertEqual(first, "alice", "first 'Alice' -> 'alice'");
  assert(second !== first, `duplicate 'Alice' -> different slug (${second})`);
  assertEqual(second, "alice-2", "duplicate 'Alice' -> 'alice-2'");

  // A caller-provided used set containing the first slug is respected.
  const seeded = new Set<string>(["alice"]);
  const third = allocateSeatSlug("Alice", seeded);
  assertEqual(third, "alice-2", "caller-provided used set forces the -2 suffix");
  assert(seeded.has("alice-2"), "the allocated slug is added to the caller's used set");
  const fourth = allocateSeatSlug("Alice", seeded);
  assertEqual(fourth, "alice-3", "third 'Alice' skips to 'alice-3'");
  assertEqual(new Set([first, second]).size, 2, "both slugs from the first used set are distinct");
  assertEqual(new Set([third, fourth]).size, 2, "both slugs from the seeded used set are distinct");
});

await run("formatSeatId / parseSeatId", async () => {
  const seatId = formatSeatId("sources", "rt-1");
  assertEqual(seatId, "sources::rt-1", "formatSeatId joins with '::'");

  const parsed = parseSeatId(seatId);
  assert(parsed !== null, "parseSeatId parses a formatted seatId");
  assertEqual(parsed?.slug, "sources", "round-trip slug");
  assertEqual(parsed?.roundtableId, "rt-1", "round-trip roundtableId");

  const allocated = allocateSeatSlug("资料", new Set<string>());
  const roundTripped = parseSeatId(formatSeatId(allocated, "rt-42"));
  assertEqual(roundTripped?.slug, allocated, "a Chinese-name slug round-trips");
  assertEqual(roundTripped?.roundtableId, "rt-42", "roundtableId survives the round-trip");

  assert(parseSeatId("noseparator") === null, "no separator -> null");
  assert(parseSeatId("::rt-1") === null, "separator at index 0 -> null (sepIndex > 0)");
  assert(parseSeatId("") === null, "empty string -> null");
  assert(
    parseSeatId(formatSeatId(allocateSeatSlug("   ", new Set<string>()), "rt-9")) !== null,
    "slug fallback keeps the sepIndex > 0 invariant",
  );
});

await run("default five seat slugs = PERSPECTIVE_TEMPLATES ids", async () => {
  const templateIds: string[] = PERSPECTIVE_TEMPLATES.map((template) => template.id);
  assertEqual(templateIds.length, 5, "five perspective templates");
  assertEqual(
    templateIds.join(","),
    "sources,counterexample,theory,feasibility,experiment",
    "template ids in order",
  );
  assertEqual(new Set(templateIds).size, 5, "template ids are distinct");
  assertEqual(
    PERSPECTIVE_TEMPLATES.map((template) => template.label).join("/"),
    DEFAULT_SEAT_LABELS.join("/"),
    "template labels are the five default Chinese labels",
  );

  // The default roster uses the template ids verbatim (never allocateSeatSlug).
  const seatIds = PERSPECTIVE_TEMPLATES.map((template) => formatSeatId(template.id, "rt-1"));
  assertEqual(seatIds.length, 5, "five default seatIds");
  assertEqual(new Set(seatIds).size, 5, "five distinct default seatIds");
  assertEqual(seatIds[0], "sources::rt-1", "first default seatId");
  const lastDefaultSeatId = seatIds[4] ?? "";
  assertEqual(parseSeatId(lastDefaultSeatId)?.slug, "experiment", "last default slug is the template id");

  // Placeholder seats allocated from the same Chinese labels never collide with
  // the template ids already recorded in `used`.
  const placeholderUsed = new Set<string>(templateIds);
  const placeholders = DEFAULT_SEAT_LABELS.map((label) => allocateSeatSlug(label, placeholderUsed));
  assert(
    placeholders.every((slug) => !templateIds.includes(slug)),
    `placeholder slugs avoid the template ids: ${JSON.stringify(placeholders)}`,
  );
  assertEqual(placeholderUsed.size, 10, "five template ids + five placeholder slugs are all distinct");
});

await run("seat colours: non-empty, stable, wrapping", async () => {
  assert(SEAT_COLOR_PALETTE.length >= 5, "palette covers at least the five default seats");
  assertEqual(new Set(SEAT_COLOR_PALETTE).size, SEAT_COLOR_PALETTE.length, "palette colours are distinct");

  for (let index = 0; index < 5; index++) {
    const color = pickSeatColor(index);
    assert(typeof color === "string" && color.length > 0, `colour for index ${index} is non-empty`);
    assertEqual(pickSeatColor(index), color, `colour for index ${index} is stable across calls`);
  }
  assertEqual(pickSeatColor(0), SEAT_COLOR_PALETTE[0], "index 0 -> first palette colour");
  assert(pickSeatColor(0) !== pickSeatColor(1), "consecutive indices get different colours");
  assertEqual(
    pickSeatColor(SEAT_COLOR_PALETTE.length),
    SEAT_COLOR_PALETTE[0],
    "wraps around at the palette length",
  );
  assertEqual(
    pickSeatColor(-1),
    SEAT_COLOR_PALETTE[SEAT_COLOR_PALETTE.length - 1],
    "negative indices wrap backwards",
  );

  // Ported names from team-utils.ts resolve to the same palette/picker.
  assert(TEAMMATE_COLOR_PALETTE === SEAT_COLOR_PALETTE, "TEAMMATE_COLOR_PALETTE points at the same palette");
  assertEqual(pickTeammateColor(2), pickSeatColor(2), "pickTeammateColor matches pickSeatColor");
});

await run("team-types: §4.1 identifiers and utterance -> timeline mapping", async () => {
  assertEqual(USER_SEAT_ID, "user", "USER_SEAT_ID is the fixed user id");
  assertEqual(MIN_SEATS, 3, "MIN_SEATS");
  assertEqual(MAX_SEATS, 12, "MAX_SEATS");
  assertEqual(DEFAULT_ROUNDTABLE_TIER, "standard", "default tier is standard");
  assertEqual(ROUNDTABLE_TIER_SEATS.compact, 3, "compact = 3 seats");
  assertEqual(ROUNDTABLE_TIER_SEATS.standard, 5, "standard = 5 seats");
  assertEqual(ROUNDTABLE_TIER_SEATS.deep, 8, "deep = 8 seats");
  assertEqual(ROUNDTABLE_TIER_SEATS.blitz, 12, "blitz = 12 seats");
  assertEqual(
    ROUNDTABLE_TIER_SEATS[DEFAULT_ROUNDTABLE_TIER],
    5,
    "the default tier roster is the five template seats",
  );

  const expected: Array<[UtteranceKind, TimelineItemType]> = [
    ["argument", "utterance"],
    ["note", "utterance"],
    ["explore_result", "utterance"],
    ["knowledge_card", "knowledge_card"],
    ["question", "question"],
    ["challenge", "challenge"],
  ];
  for (const [kind, type] of expected) {
    assertEqual(timelineTypeFromUtterance(kind), type, `timelineTypeFromUtterance(${kind}) === ${type}`);
  }
});

// ============================================================================

console.log("\n=== Summary ===\n");
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
