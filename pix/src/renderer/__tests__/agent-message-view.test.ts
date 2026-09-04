/**
 * AgentMessageView tests (perf SDD §3.6/§4.3, stage S3).
 *
 * Acceptance: the component renders the same DOM shape as the former inline
 * agent-message branch in SessionView (.agent-block > .agent-content
 * .markdown-body, streaming class bound to isStreaming, innerHTML =
 * renderMarkdown(content)); re-rendering with unchanged content does NOT
 * re-run renderMarkdown (spy call count stays put — the whole point of the
 * extraction), while a content change re-runs it exactly once.
 *
 * renderMarkdown is module-mocked with a counting wrapper around the real
 * implementation, so the HTML output stays the production one.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import AgentMessageView from "../components/session/AgentMessageView.vue";
import { renderMarkdown } from "../utils/markdown";

vi.mock("../utils/markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/markdown")>();
  return { ...actual, renderMarkdown: vi.fn(actual.renderMarkdown) };
});

const renderMarkdownSpy = vi.mocked(renderMarkdown);

let wrapper: ReturnType<typeof mount> | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  renderMarkdownSpy.mockClear();
});

// ============================================================================
// DOM structure (byte-identical to the former inline branch)
// ============================================================================

describe("DOM structure", () => {
  it("renders .agent-block > .agent-content.markdown-body with the renderer output", () => {
    const content = "# Hello **world**\n\n```js\nconst a = 1;\n```";
    wrapper = mount(AgentMessageView, { props: { content, isStreaming: true } });

    expect(wrapper.find(".agent-block").exists()).toBe(true);
    const body = wrapper.find(".agent-block > .agent-content.markdown-body");
    expect(body.exists()).toBe(true);
    expect(body.classes()).toContain("streaming");
    expect(body.element.innerHTML).toBe(renderMarkdown(content));
    // The copy button markup (delegated click handling) is part of the HTML.
    expect(body.element.innerHTML).toContain("code-copy-btn");
  });

  it("binds the streaming class to isStreaming without touching content", async () => {
    wrapper = mount(AgentMessageView, { props: { content: "plain text", isStreaming: false } });
    expect(wrapper.find(".agent-content").classes()).not.toContain("streaming");

    await wrapper.setProps({ isStreaming: true });
    expect(wrapper.find(".agent-content").classes()).toContain("streaming");
    // Class-only re-render: markdown is not recomputed.
    expect(renderMarkdownSpy).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Markdown memoization (component-boundary render scope)
// ============================================================================

describe("markdown memoization", () => {
  it("does not re-run renderMarkdown when content is unchanged", async () => {
    wrapper = mount(AgentMessageView, { props: { content: "streaming answer draft", isStreaming: true } });
    expect(renderMarkdownSpy).toHaveBeenCalledTimes(1);

    // Re-render with the same content (only isStreaming flips): no re-parse.
    await wrapper.setProps({ isStreaming: false });
    expect(renderMarkdownSpy).toHaveBeenCalledTimes(1);

    // Same content again — still one call.
    await wrapper.setProps({ isStreaming: true });
    expect(renderMarkdownSpy).toHaveBeenCalledTimes(1);
  });

  it("re-runs renderMarkdown exactly once when content changes", async () => {
    wrapper = mount(AgentMessageView, { props: { content: "first", isStreaming: true } });
    expect(renderMarkdownSpy).toHaveBeenCalledTimes(1);

    await wrapper.setProps({ content: "second" });
    expect(renderMarkdownSpy).toHaveBeenCalledTimes(2);
    // The DOM follows the new content.
    expect(wrapper.find(".agent-content").element.innerHTML).toBe(renderMarkdown("second"));
  });
});
