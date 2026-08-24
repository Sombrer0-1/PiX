/**
 * ThinkingBlock tests (PiX 1.5, stage S3B, SDD §4.1.3).
 *
 * Acceptance: the placeholder capsule renders while content is empty and is
 * not clickable; streaming deltas reveal the plain-text body; the collapsed
 * title formats "思考过程 · {first-line summary ≤60 chars} · 全文 {N} 字";
 * a manual expand pins the block against supersede changes; the 10s fallback
 * (vi.useFakeTimers) auto-collapses an ended, not-superseded block left in
 * auto but never a manually expanded one; a manual collapse survives
 * subsequent deltas. No Electron runtime, no stores, no Vuetify - the
 * component only reads its props.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import type { DisplayBlock } from "@/types/session";
import ThinkingBlock from "../components/session/ThinkingBlock.vue";

type ThinkingBlockData = Extract<DisplayBlock, { type: "thinking" }>;

function makeBlock(overrides?: Partial<ThinkingBlockData>): ThinkingBlockData {
  return {
    id: "t1",
    type: "thinking",
    content: "",
    phase: "streaming",
    superseded: false,
    timestamp: 1,
    ...overrides,
  };
}

let wrapper: ReturnType<typeof mount> | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.useRealTimers();
});

// ============================================================================
// Placeholder capsule
// ============================================================================

describe("placeholder capsule", () => {
  it("renders the capsule while content is empty and it is not clickable", () => {
    wrapper = mount(ThinkingBlock, {
      props: { block: makeBlock({ content: "" }), effortLabel: "high" },
    });

    expect(wrapper.find(".thinking-placeholder").exists()).toBe(true);
    expect(wrapper.text()).toContain("AI 正在思考...");
    expect(wrapper.text()).toContain("· high");
    // No interactive header and no body in the placeholder state.
    expect(wrapper.find(".thinking-header").exists()).toBe(false);
    expect(wrapper.find(".thinking-placeholder button").exists()).toBe(false);
    expect(wrapper.find(".thinking-body").exists()).toBe(false);
  });

  it("omits the effort label segment when none is provided", () => {
    wrapper = mount(ThinkingBlock, {
      props: { block: makeBlock({ content: "" }) },
    });

    expect(wrapper.find(".thinking-placeholder").text()).toBe("AI 正在思考...");
  });
});

// ============================================================================
// Streaming append
// ============================================================================

describe("streaming append", () => {
  it("reveals the plain-text body once content arrives and follows deltas", async () => {
    wrapper = mount(ThinkingBlock, {
      props: { block: makeBlock({ content: "" }), effortLabel: "high" },
    });
    expect(wrapper.find(".thinking-placeholder").exists()).toBe(true);

    await wrapper.setProps({ block: makeBlock({ content: "first delta", phase: "streaming" }) });

    expect(wrapper.find(".thinking-placeholder").exists()).toBe(false);
    expect(wrapper.find(".thinking-header").attributes("aria-expanded")).toBe("true");
    expect(wrapper.find(".thinking-title").text()).toBe("思考过程 · high");
    // Spinner shows while streaming.
    expect(wrapper.find(".thinking-spinner").exists()).toBe(true);
    const body = wrapper.find(".thinking-body");
    expect(body.exists()).toBe(true);
    expect(body.text()).toBe("first delta");

    await wrapper.setProps({
      block: makeBlock({ content: "first delta\nsecond delta", phase: "streaming" }),
    });
    expect(wrapper.find(".thinking-body").text()).toBe("first delta\nsecond delta");
  });

  it("drops the spinner once the phase ends", async () => {
    wrapper = mount(ThinkingBlock, {
      props: { block: makeBlock({ content: "thinking", phase: "streaming" }) },
    });
    expect(wrapper.find(".thinking-spinner").exists()).toBe(true);

    await wrapper.setProps({ block: makeBlock({ content: "thinking", phase: "ended", superseded: false }) });
    expect(wrapper.find(".thinking-spinner").exists()).toBe(false);
    // Still expanded: the block awaits its next move.
    expect(wrapper.find(".thinking-header").attributes("aria-expanded")).toBe("true");
  });
});

// ============================================================================
// Collapsed title format
// ============================================================================

describe("collapsed title format", () => {
  it("truncates a long first line to 60 chars and counts the full content", () => {
    const longFirstLine = "第一步：分析当前项目结构并列出所有需要修改的文件".repeat(3); // 72 chars
    const content = `  ${longFirstLine}  \nsecond line\n`;
    wrapper = mount(ThinkingBlock, {
      props: { block: makeBlock({ content, phase: "ended", superseded: true }) },
    });

    const header = wrapper.find(".thinking-header");
    expect(header.attributes("aria-expanded")).toBe("false");
    expect(wrapper.find(".thinking-body").exists()).toBe(false);

    // Summary = first non-empty line (whitespace stripped), cut at 60 chars;
    // the count covers the full raw content.
    const summary = Array.from(longFirstLine).slice(0, 60).join("");
    const title = wrapper.find(".thinking-title").text();
    expect(title).toBe(`思考过程 · ${summary} · 全文 ${Array.from(content).length} 字`);
    expect(summary.length).toBe(60);
  });

  it("uses the first non-empty line with whitespace stripped for the summary", () => {
    const content = "\n   short summary line   \nrest of the thinking\n";
    wrapper = mount(ThinkingBlock, {
      props: { block: makeBlock({ content, phase: "ended", superseded: true }) },
    });

    const title = wrapper.find(".thinking-title").text();
    expect(title.startsWith("思考过程 · short summary line · 全文 ")).toBe(true);
    expect(title).toBe(`思考过程 · short summary line · 全文 ${Array.from(content).length} 字`);
  });

  it("recomputes the summary and count in real time while streaming collapsed", async () => {
    wrapper = mount(ThinkingBlock, {
      props: { block: makeBlock({ content: "alpha", phase: "streaming", superseded: false }) },
    });
    // Manual collapse while streaming.
    await wrapper.find(".thinking-header").trigger("click");
    expect(wrapper.find(".thinking-header").attributes("aria-expanded")).toBe("false");

    await wrapper.setProps({
      block: makeBlock({ content: "alpha beta gamma", phase: "streaming", superseded: false }),
    });
    const title = wrapper.find(".thinking-title").text();
    expect(title).toBe(`思考过程 · alpha beta gamma · 全文 ${Array.from("alpha beta gamma").length} 字`);
  });
});

// ============================================================================
// Manual expand pins against supersede
// ============================================================================

describe("manual expand pinning", () => {
  it("stays expanded after a manual expand even when superseded changes", async () => {
    wrapper = mount(ThinkingBlock, {
      props: { block: makeBlock({ content: "thinking", phase: "ended", superseded: true }) },
    });
    const header = wrapper.find(".thinking-header");
    expect(header.attributes("aria-expanded")).toBe("false");

    await header.trigger("click");
    expect(header.attributes("aria-expanded")).toBe("true");

    // Supersede flips either way; the manual override keeps it expanded.
    await wrapper.setProps({ block: makeBlock({ content: "thinking", phase: "ended", superseded: false }) });
    expect(wrapper.find(".thinking-header").attributes("aria-expanded")).toBe("true");
    await wrapper.setProps({ block: makeBlock({ content: "thinking", phase: "ended", superseded: true }) });
    expect(wrapper.find(".thinking-header").attributes("aria-expanded")).toBe("true");
    expect(wrapper.find(".thinking-body").text()).toBe("thinking");
  });
});

// ============================================================================
// Manual collapse survives deltas
// ============================================================================

describe("manual collapse", () => {
  it("keeps a manually collapsed block collapsed while content streams", async () => {
    wrapper = mount(ThinkingBlock, {
      props: { block: makeBlock({ content: "alpha", phase: "streaming", superseded: false }) },
    });
    expect(wrapper.find(".thinking-header").attributes("aria-expanded")).toBe("true");

    await wrapper.find(".thinking-header").trigger("click");
    expect(wrapper.find(".thinking-header").attributes("aria-expanded")).toBe("false");
    expect(wrapper.find(".thinking-body").exists()).toBe(false);

    // Delta keeps arriving; the block stays collapsed (no re-open).
    await wrapper.setProps({
      block: makeBlock({ content: "alpha beta gamma delta", phase: "streaming", superseded: false }),
    });
    expect(wrapper.find(".thinking-header").attributes("aria-expanded")).toBe("false");
    expect(wrapper.find(".thinking-body").exists()).toBe(false);
  });
});

// ============================================================================
// 10s auto-collapse fallback (fake timers)
// ============================================================================

describe("10s auto-collapse fallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("auto-collapses an ended, not-superseded block after 10s when left in auto", async () => {
    wrapper = mount(ThinkingBlock, {
      props: { block: makeBlock({ content: "thinking", phase: "ended", superseded: false }) },
    });
    const header = wrapper.find(".thinking-header");
    expect(header.attributes("aria-expanded")).toBe("true");

    // The "small window" before the fallback: still expanded at 9.999s.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(wrapper.find(".thinking-header").attributes("aria-expanded")).toBe("true");

    await vi.advanceTimersByTimeAsync(1);
    await nextTick();
    expect(wrapper.find(".thinking-header").attributes("aria-expanded")).toBe("false");
    expect(wrapper.find(".thinking-body").exists()).toBe(false);
    // The collapsed summary title appears.
    expect(wrapper.find(".thinking-title").text()).toBe(
      `思考过程 · thinking · 全文 ${Array.from("thinking").length} 字`,
    );
  });

  it("never arms the timer while the phase is still streaming", async () => {
    wrapper = mount(ThinkingBlock, {
      props: { block: makeBlock({ content: "thinking", phase: "streaming", superseded: false }) },
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(wrapper.find(".thinking-header").attributes("aria-expanded")).toBe("true");
  });

  it("does not collapse a manually expanded block after 10s", async () => {
    wrapper = mount(ThinkingBlock, {
      props: { block: makeBlock({ content: "thinking", phase: "ended", superseded: false }) },
    });
    // In auto the block starts expanded; clicking once collapses (pinned),
    // clicking again expands (pinned). The armed timer is cleared by the
    // override change either way.
    await wrapper.find(".thinking-header").trigger("click");
    await wrapper.find(".thinking-header").trigger("click");
    expect(wrapper.find(".thinking-header").attributes("aria-expanded")).toBe("true");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(wrapper.find(".thinking-header").attributes("aria-expanded")).toBe("true");
    expect(wrapper.find(".thinking-body").exists()).toBe(true);
  });

  it("clears the timer once the block is superseded before the fallback fires", async () => {
    wrapper = mount(ThinkingBlock, {
      props: { block: makeBlock({ content: "thinking", phase: "ended", superseded: false }) },
    });

    // Next move starts: superseded flips, the fallback is no longer armed.
    await wrapper.setProps({ block: makeBlock({ content: "thinking", phase: "ended", superseded: true }) });
    await vi.advanceTimersByTimeAsync(30_000);

    // Auto state follows superseded: collapsed, but not by the timer.
    expect(wrapper.find(".thinking-header").attributes("aria-expanded")).toBe("false");
  });
});

// ============================================================================
// Keyboard / aria
// ============================================================================

describe("keyboard and aria", () => {
  it("renders the header as a button with aria-expanded bound to the effective state", async () => {
    wrapper = mount(ThinkingBlock, {
      props: { block: makeBlock({ content: "thinking", phase: "ended", superseded: true }) },
    });

    const header = wrapper.find(".thinking-header");
    expect(header.element.tagName).toBe("BUTTON");
    expect(header.attributes("type")).toBe("button");
    expect(header.attributes("aria-expanded")).toBe("false");

    await header.trigger("click");
    expect(wrapper.find(".thinking-header").attributes("aria-expanded")).toBe("true");
  });
});
