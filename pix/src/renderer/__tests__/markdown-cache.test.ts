/**
 * markdown renderMarkdown LRU cache tests (perf SDD §4.9, stage S10).
 *
 * Acceptance:
 * - identical content parsed once; the second call is a cache hit (marked.parse
 *   spy count stays put);
 * - a cache hit returns a string byte-identical to an immediate parse;
 * - content over MARKDOWN_CACHE_MAX_CONTENT_BYTES (64KB) bypasses the cache
 *   (a third call still re-parses); empty content never parses;
 * - beyond MARKDOWN_CACHE_MAX_ENTRIES (512) the oldest key is evicted (the
 *   test drives the exported constants with 513 distinct keys), and a hit
 *   refreshes LRU recency so the touched key survives eviction.
 *
 * The cache is module-level and persists across tests in this file, so every
 * test uses distinct content strings.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { marked } from "marked";
import {
  MARKDOWN_CACHE_MAX_CONTENT_BYTES,
  MARKDOWN_CACHE_MAX_ENTRIES,
  renderMarkdown,
} from "../utils/markdown";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("markdown LRU cache (S10)", () => {
  it("exports the contracted cache limits", () => {
    expect(MARKDOWN_CACHE_MAX_ENTRIES).toBe(512);
    expect(MARKDOWN_CACHE_MAX_CONTENT_BYTES).toBe(65536);
  });

  it("parses identical content once — the second call is a cache hit", () => {
    const spy = vi.spyOn(marked, "parse");
    const content = "cache-hit alpha\n\n- one\n- two";

    const first = renderMarkdown(content);
    expect(spy).toHaveBeenCalledTimes(1);

    const second = renderMarkdown(content);
    expect(spy).toHaveBeenCalledTimes(1); // zero extra parses
    expect(second).toBe(first);
  });

  it("returns a hit byte-identical to an immediate parse", () => {
    const spy = vi.spyOn(marked, "parse");
    const content = "byte-identity check\n\n```js\nconst a = 1;\n```";

    const cached = renderMarkdown(content); // parsed + cached
    // Evict the entry by filling the cache with distinct keys, then render the
    // same content again — a forced miss gives a fresh immediate parse of the
    // identical (default copyButton) rendering.
    for (let i = 0; i < MARKDOWN_CACHE_MAX_ENTRIES; i++) {
      renderMarkdown(`identity-fill-${i}`);
    }
    const before = spy.mock.calls.length;
    const immediate = renderMarkdown(content);
    expect(spy.mock.calls.length).toBe(before + 1); // really re-parsed
    expect(immediate).toBe(cached);
  });

  it("bypasses the cache for content over the byte limit — a third call re-parses", () => {
    const spy = vi.spyOn(marked, "parse");
    const big = `oversized ${"a".repeat(MARKDOWN_CACHE_MAX_CONTENT_BYTES)}`;

    const first = renderMarkdown(big);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(renderMarkdown(big)).toBe(first);
    expect(spy).toHaveBeenCalledTimes(2); // never served from cache
    expect(renderMarkdown(big)).toBe(first);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("caches content at exactly the byte limit", () => {
    const spy = vi.spyOn(marked, "parse");
    const exact = "b".repeat(MARKDOWN_CACHE_MAX_CONTENT_BYTES);

    renderMarkdown(exact);
    renderMarkdown(exact);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("returns the placeholder for empty content without parsing", () => {
    const spy = vi.spyOn(marked, "parse");
    expect(renderMarkdown("")).toBe("&nbsp;");
    expect(renderMarkdown("")).toBe("&nbsp;");
    expect(spy).not.toHaveBeenCalled();
  });

  it("evicts the oldest entry past the capacity limit", () => {
    const spy = vi.spyOn(marked, "parse");
    const oldest = "eviction-oldest";
    const oldestHtml = renderMarkdown(oldest); // entry #1

    // 512 more distinct keys → 513 inserts total, so `oldest` is evicted.
    for (let i = 1; i <= MARKDOWN_CACHE_MAX_ENTRIES; i++) {
      renderMarkdown(`eviction-order-${String(i).padStart(3, "0")}`);
    }
    expect(spy.mock.calls.length).toBe(1 + MARKDOWN_CACHE_MAX_ENTRIES);

    const baseline = spy.mock.calls.length;
    const reparsed = renderMarkdown(oldest);
    expect(spy.mock.calls.length).toBe(baseline + 1); // miss → re-parse
    expect(reparsed).toBe(oldestHtml); // purity: re-parse is byte-identical

    // The newest key is still cached (no extra parse).
    const newest = `eviction-order-${String(MARKDOWN_CACHE_MAX_ENTRIES).padStart(3, "0")}`;
    const before = spy.mock.calls.length;
    renderMarkdown(newest);
    expect(spy.mock.calls.length).toBe(before);
  });

  it("refreshes recency on a hit — a touched key survives eviction", () => {
    const spy = vi.spyOn(marked, "parse");
    renderMarkdown("lru-touched"); // entry #1
    for (let i = 0; i < MARKDOWN_CACHE_MAX_ENTRIES - 1; i++) {
      renderMarkdown(`lru-fill-${i}`); // entries #2..#512
    }
    // Hit → delete+set refreshes the LRU position; no parse.
    const afterFill = spy.mock.calls.length;
    renderMarkdown("lru-touched");
    expect(spy.mock.calls.length).toBe(afterFill);

    // The 513th insert must evict the oldest fill key, not the touched one.
    renderMarkdown("lru-new");
    const before = spy.mock.calls.length;
    renderMarkdown("lru-touched");
    expect(spy.mock.calls.length).toBe(before); // still cached
  });
});
