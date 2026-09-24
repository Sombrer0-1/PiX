/**
 * tool-details component tests (Stage D, SDD §2.10 + follow-up fix).
 *
 * Acceptance: the ToolCallDetails dispatcher mounts the per-tool view for each
 * SDD §2.1 table row (exact name and substring fallbacks); result.ts
 * normalizes the three result shapes (AgentToolResult object / string / text
 * block array) and parses display diffs (added/removed/context/gap rows with
 * true file line numbers); EditToolDetails prefers the real details.diff and
 * falls back to args hunks (multi-edits with dividers, legacy top-level
 * fields, JSON-string degrade); WriteToolDetails derives its stat from the
 * same diff the outer counters use (live/replay parity with the header +N/-M)
 * and only falls back to counting args content; diff/read bodies are
 * scroll-capped with a render limit instead of an expand button;
 * BashToolDetails shows command and output; JsonToolDetails renders the
 * key/value table and a highlight.js JSON node. All components are purely
 * presentational - tests mount them with plain props, no stores or IPC.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import type { ToolWorkItem } from "@/types/session";
import ToolCallDetails from "../components/session/tool-details/ToolCallDetails.vue";
import EditToolDetails from "../components/session/tool-details/EditToolDetails.vue";
import WriteToolDetails from "../components/session/tool-details/WriteToolDetails.vue";
import BashToolDetails from "../components/session/tool-details/BashToolDetails.vue";
import ReadFileToolDetails from "../components/session/tool-details/ReadFileToolDetails.vue";
import JsonToolDetails from "../components/session/tool-details/JsonToolDetails.vue";
import TodoToolDetails from "../components/session/tool-details/TodoToolDetails.vue";
import {
  countDiffRows,
  extractToolResultDetails,
  extractToolResultText,
  parseDisplayDiff,
} from "../components/session/tool-details/result";

// ============================================================================
// Fixtures
// ============================================================================

function makeTool(overrides?: Partial<ToolWorkItem>): ToolWorkItem {
  return {
    toolCallId: "t-1",
    toolName: "bash",
    args: {},
    result: "",
    isError: false,
    ...overrides,
  };
}

let wrapper: ReturnType<typeof mount> | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

// ============================================================================
// Dispatcher table (SDD §2.1)
// ============================================================================

describe("ToolCallDetails dispatcher", () => {
  const cases: Array<{ label: string; tool: ToolWorkItem; viewClass: string }> = [
    {
      label: "exact edit",
      tool: makeTool({ toolName: "edit", args: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] } }),
      viewClass: ".td-edit",
    },
    {
      label: "substring edit",
      tool: makeTool({ toolName: "multi_edit", args: { edits: [{ oldText: "x", newText: "y" }] } }),
      viewClass: ".td-edit",
    },
    {
      label: "exact write",
      tool: makeTool({ toolName: "write", args: { path: "a.ts", content: "line" } }),
      viewClass: ".td-write",
    },
    {
      label: "substring write",
      tool: makeTool({ toolName: "file_write", args: { path: "a.ts", content: "line" } }),
      viewClass: ".td-write",
    },
    {
      label: "exact bash",
      tool: makeTool({ toolName: "bash", args: { command: "ls" }, result: "file" }),
      viewClass: ".td-bash",
    },
    {
      label: "substring bash",
      tool: makeTool({ toolName: "safe_bash", args: { command: "ls" }, result: "file" }),
      viewClass: ".td-bash",
    },
    {
      label: "substring bash without a command arg falls through to json",
      tool: makeTool({ toolName: "git_bash", args: { repo: "pi" }, result: "ok" }),
      viewClass: ".td-json",
    },
    {
      label: "run_ prefix with a command arg",
      tool: makeTool({ toolName: "run_task", args: { command: "npm test" }, result: "ok" }),
      viewClass: ".td-bash",
    },
    {
      label: "run_ without a command arg falls through to json",
      tool: makeTool({ toolName: "run_task", args: { tasks: [] }, result: "ok" }),
      viewClass: ".td-json",
    },
    {
      label: "exact read",
      tool: makeTool({ toolName: "read", args: { path: "a.ts" }, result: "contents" }),
      viewClass: ".td-read",
    },
    {
      label: "exact grep",
      tool: makeTool({ toolName: "grep", args: { pattern: "TODO" }, result: "a.ts:1 TODO" }),
      viewClass: ".td-search",
    },
    {
      label: "exact glob / find / ls",
      tool: makeTool({ toolName: "ls", args: { path: "." }, result: "a.ts" }),
      viewClass: ".td-search",
    },
    {
      label: "substring search",
      tool: makeTool({ toolName: "workspace_search", args: { query: "pi" }, result: "hit" }),
      viewClass: ".td-search",
    },
    {
      label: "exact todo_write (exact name beats the write substring)",
      tool: makeTool({
        toolName: "todo_write",
        args: { todos: [{ content: "Run tests", status: "in_progress" }] },
        result: "updated",
      }),
      viewClass: ".td-todo",
    },
    {
      label: "unknown tool falls back to json",
      tool: makeTool({ toolName: "fancy_tool", args: { thing: 1 }, result: "done" }),
      viewClass: ".td-json",
    },
  ];

  for (const { label, tool, viewClass } of cases) {
    it(`mounts the right view for ${label}`, () => {
      wrapper = mount(ToolCallDetails, { props: { tool } });
      expect(wrapper.find(viewClass).exists()).toBe(true);
    });
  }

  it("wraps an errored tool in the error frame with the failure label", () => {
    wrapper = mount(ToolCallDetails, {
      props: { tool: makeTool({ toolName: "bash", args: { command: "exit 1" }, result: "boom", isError: true }) },
    });
    expect(wrapper.find(".td-error").exists()).toBe(true);
    expect(wrapper.find(".td-error-label").text()).toBe("执行失败");
  });

  it("shows the inline running spinner while the result is null", () => {
    wrapper = mount(ToolCallDetails, {
      props: { tool: makeTool({ toolName: "bash", args: { command: "ls" }, result: null }) },
    });
    expect(wrapper.find(".td-running").exists()).toBe(true);
    expect(wrapper.find(".td-running").text()).toContain("运行中");
    expect(wrapper.find(".td-bash").exists()).toBe(false);
  });
});

// ============================================================================
// result.ts normalization (SDD §2.2)
// ============================================================================

describe("extractToolResultText", () => {
  it("joins text blocks out of an AgentToolResult-shaped object", () => {
    const result = { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], details: { x: 1 } };
    expect(extractToolResultText(result)).toBe("ab");
  });

  it("returns a plain string as-is", () => {
    expect(extractToolResultText("raw output")).toBe("raw output");
  });

  it("joins a replayed content block array", () => {
    const result = [{ type: "text", text: "line1\n" }, { type: "text", text: "line2" }];
    expect(extractToolResultText(result)).toBe("line1\nline2");
  });

  it("stringifies any other object shape", () => {
    expect(extractToolResultText({ foo: 1 })).toBe('{\n  "foo": 1\n}');
    expect(extractToolResultText(null)).toBe("");
  });
});

describe("extractToolResultDetails", () => {
  it("returns details from an AgentToolResult-shaped object", () => {
    const details = { diff: "-x\n+y" };
    expect(extractToolResultDetails({ content: [], details })).toBe(details);
  });

  it("returns undefined for strings, arrays and detail-less records", () => {
    expect(extractToolResultDetails("text")).toBeUndefined();
    expect(extractToolResultDetails([{ type: "text", text: "t" }])).toBeUndefined();
    expect(extractToolResultDetails({ content: [] })).toBeUndefined();
    expect(extractToolResultDetails(null)).toBeUndefined();
  });
});

// ============================================================================
// Display-diff parsing (details.diff of edit/write)
// ============================================================================

describe("parseDisplayDiff", () => {
  it("parses added/removed/context rows with their true line numbers", () => {
    // Format from edit-diff.ts generateDiffString: `<sign><padded n> <line>`.
    const rows = parseDisplayDiff("-5 old\n+5 new\n 6 ctx\n+7 new2");
    expect(rows).toEqual([
      { kind: "removed", lineNo: "5", text: "old" },
      { kind: "added", lineNo: "5", text: "new" },
      { kind: "context", lineNo: "6", text: "ctx" },
      { kind: "added", lineNo: "7", text: "new2" },
    ]);
    expect(countDiffRows(rows)).toEqual({ added: 2, removed: 1 });
  });

  it("parses the ellipsis row as a gap and keeps empty content rows", () => {
    const rows = parseDisplayDiff("+1 \n    ...\n 2 x");
    expect(rows[0]).toEqual({ kind: "added", lineNo: "1", text: "" });
    expect(rows[1]).toEqual({ kind: "gap", lineNo: "", text: "..." });
    expect(rows[2]).toEqual({ kind: "context", lineNo: "2", text: "x" });
  });

  it("returns an empty array for content that matches no row shape", () => {
    expect(parseDisplayDiff("")).toEqual([]);
  });
});

// ============================================================================
// EditToolDetails (SDD §2.4)
// ============================================================================

describe("EditToolDetails", () => {
  it("prefers the real details.diff: context rows, true line numbers, single block", () => {
    // args.edits exist too — the details.diff must win (same source as the
    // outer header counters).
    const diff = " 4 keep\n-5 old\n+5 new\n    ...\n 9 tail";
    wrapper = mount(EditToolDetails, {
      props: {
        tool: makeTool({
          toolName: "edit",
          args: { path: "src/a.ts", edits: [{ oldText: "old", newText: "new" }] },
          result: { content: [{ type: "text", text: "ok" }], details: { diff, firstChangedLine: 5 } },
        }),
      },
    });

    // One diff block, no per-edit dividers in diff mode.
    expect(wrapper.findAll(".td-diff")).toHaveLength(1);
    expect(wrapper.find(".td-hunk-divider").exists()).toBe(false);
    const kinds = wrapper.findAll(".td-diff-line").map((row) => row.classes().slice(1).join(" "));
    expect(kinds).toEqual(["context", "removed", "added", "gap", "context"]);
    // Line-number column carries the true file line numbers.
    const numbers = wrapper.findAll(".td-diff-no").map((node) => node.text());
    expect(numbers).toEqual(["4", "5", "5", "", "9"]);
    // Sign column only on change rows.
    const signs = wrapper.findAll(".td-diff-sign").map((node) => node.text());
    expect(signs).toEqual(["", "-", "+", "", ""]);
  });

  it("renders removed/added rows for each edit with dividers (args fallback)", () => {
    wrapper = mount(EditToolDetails, {
      props: {
        tool: makeTool({
          toolName: "edit",
          args: {
            path: "src/a.ts",
            edits: [
              { oldText: "a\nb", newText: "a\nB" },
              { oldText: "c", newText: "c\nc2" },
            ],
          },
        }),
      },
    });

    expect(wrapper.find(".td-path-chip").text()).toBe("src/a.ts");
    const removed = wrapper.findAll(".td-diff-line.removed");
    const added = wrapper.findAll(".td-diff-line.added");
    expect(removed).toHaveLength(3);
    expect(added).toHaveLength(4);
    expect(removed[0].find(".td-diff-sign").text()).toBe("-");
    expect(added[0].find(".td-diff-sign").text()).toBe("+");
    // Two hunks separated by 第 k 处修改 dividers.
    const dividers = wrapper.findAll(".td-hunk-divider");
    expect(dividers).toHaveLength(2);
    expect(dividers[0].text()).toContain("src/a.ts 内第 1 处");
    expect(dividers[1].text()).toContain("src/a.ts 内第 2 处");
  });

  it("renders legacy top-level old_string/new_string fields", () => {
    wrapper = mount(EditToolDetails, {
      props: {
        tool: makeTool({
          toolName: "edit",
          args: { path: "old.ts", old_string: "was", new_string: "now" },
        }),
      },
    });

    const removed = wrapper.findAll(".td-diff-line.removed");
    const added = wrapper.findAll(".td-diff-line.added");
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(removed[0].find(".td-diff-text").text()).toBe("was");
    expect(added[0].find(".td-diff-text").text()).toBe("now");
    // A single edit has no divider.
    expect(wrapper.find(".td-hunk-divider").exists()).toBe(false);
  });

  it("render body is scroll-capped instead of an expand button", async () => {
    const big = Array.from({ length: 400 }, (_, i) => `old-${i}`).join("\n");
    wrapper = mount(EditToolDetails, {
      props: {
        tool: makeTool({ toolName: "edit", args: { path: "big.ts", edits: [{ oldText: big, newText: "x" }] } }),
      },
    });

    // All rows render inside the scroll container (no expand button, no trim).
    expect(wrapper.find(".td-diff-scroll").exists()).toBe(true);
    expect(wrapper.find(".td-expand").exists()).toBe(false);
    expect(wrapper.findAll(".td-diff-line")).toHaveLength(401);
  });

  it("truncates only past the 2000-row render cap with a note", () => {
    const big = Array.from({ length: 1500 }, (_, i) => `old-${i}`).join("\n");
    const bigNew = Array.from({ length: 1500 }, (_, i) => `new-${i}`).join("\n");
    wrapper = mount(EditToolDetails, {
      props: {
        tool: makeTool({ toolName: "edit", args: { path: "big.ts", edits: [{ oldText: big, newText: bigNew }] } }),
      },
    });

    expect(wrapper.findAll(".td-diff-line")).toHaveLength(2000);
    expect(wrapper.find(".td-diff-truncated").text()).toContain("已省略后 1000 行");
  });

  it("degrades to the JSON fallback when edits is a JSON string", () => {
    wrapper = mount(EditToolDetails, {
      props: {
        tool: makeTool({
          toolName: "edit",
          args: { path: "a.ts", edits: '[{"oldText":"x","newText":"y"}]' },
        }),
      },
    });

    expect(wrapper.find(".td-json").exists()).toBe(true);
    expect(wrapper.find(".td-diff-line").exists()).toBe(false);
  });

  it("degrades to the JSON fallback when an edit field is not a string", () => {
    wrapper = mount(EditToolDetails, {
      props: {
        tool: makeTool({
          toolName: "edit",
          args: { path: "a.ts", edits: [{ oldText: 123, newText: "y" }] },
        }),
      },
    });

    expect(wrapper.find(".td-json").exists()).toBe(true);
    expect(wrapper.find(".td-diff-line").exists()).toBe(false);
  });
});

// ============================================================================
// WriteToolDetails (SDD §2.4)
// ============================================================================

describe("WriteToolDetails", () => {
  it("derives the stat from the real details.diff, not the args content length", () => {
    // The user-visible mismatch case: an overwrite of an existing file whose
    // args.content is 97 lines while the real diff is +26/-31. The stat must
    // match the outer header counters (both count the same details.diff).
    const diffLines = [
      ...Array.from({ length: 31 }, (_, i) => `-${i + 1} old ${i}`),
      ...Array.from({ length: 26 }, (_, i) => `+${i + 1} new ${i}`),
    ];
    const content = Array.from({ length: 97 }, (_, i) => `line-${i}`).join("\n");
    wrapper = mount(WriteToolDetails, {
      props: {
        tool: makeTool({
          toolName: "write",
          args: { path: "existing.ts", content },
          result: {
            content: [{ type: "text", text: "Successfully wrote 2048 bytes" }],
            details: { diff: diffLines.join("\n") },
          },
        }),
      },
    });

    expect(wrapper.find(".td-write-stat .stat-added").text()).toBe("+26");
    expect(wrapper.find(".td-write-stat .stat-removed").text()).toBe("-31");
    // Rows come from the parsed diff (with true line numbers), not the args.
    expect(wrapper.findAll(".td-diff-line.added")).toHaveLength(26);
    expect(wrapper.findAll(".td-diff-line.removed")).toHaveLength(31);
    const firstAdded = wrapper.findAll(".td-diff-line.added")[0]!;
    expect(firstAdded.find(".td-diff-no").text()).toBe("1");
    // Scroll-capped body, no expand button.
    expect(wrapper.find(".td-diff-scroll").exists()).toBe(true);
    expect(wrapper.find(".td-expand").exists()).toBe(false);
  });

  it("renders all lines as added rows with the +N 行 stat (args fallback)", () => {
    wrapper = mount(WriteToolDetails, {
      props: {
        tool: makeTool({ toolName: "write", args: { path: "new.ts", content: "l1\nl2\nl3" } }),
      },
    });

    expect(wrapper.find(".td-path-chip").text()).toBe("new.ts");
    expect(wrapper.find(".td-write-stat").text()).toBe("+3行");
    const rows = wrapper.findAll(".td-diff-line");
    expect(rows).toHaveLength(3);
    // Every row is an added row with a + sign and a relative line number.
    expect(wrapper.findAll(".td-diff-line.added")).toHaveLength(3);
    expect(rows.every((row) => row.find(".td-diff-sign").text() === "+")).toBe(true);
    expect(rows.map((row) => row.find(".td-diff-no").text())).toEqual(["1", "2", "3"]);
    expect(rows[2].find(".td-diff-text").text()).toBe("l3");
    expect(wrapper.find(".td-diff-line.removed").exists()).toBe(false);
    expect(wrapper.find(".td-write-stat .stat-removed").exists()).toBe(false);
  });

  it("degrades to the JSON fallback when content is not a string", () => {
    wrapper = mount(WriteToolDetails, {
      props: { tool: makeTool({ toolName: "write", args: { path: "new.ts", content: 42 } }) },
    });
    expect(wrapper.find(".td-json").exists()).toBe(true);
    expect(wrapper.find(".td-diff-line").exists()).toBe(false);
  });
});

// ============================================================================
// ReadFileToolDetails (SDD §2.6 + follow-up)
// ============================================================================

describe("ReadFileToolDetails", () => {
  it("renders line-numbered rows with offset-aware numbering in a scroll container", () => {
    wrapper = mount(ReadFileToolDetails, {
      props: {
        tool: makeTool({
          toolName: "read",
          args: { path: "a.ts", offset: 10, limit: 3 },
          result: "alpha\nbeta\ngamma",
        }),
      },
    });

    expect(wrapper.find(".td-diff-scroll").exists()).toBe(false);
    expect(wrapper.find(".td-read-scroll").exists()).toBe(true);
    expect(wrapper.find(".td-expand").exists()).toBe(false);
    expect(wrapper.find(".td-range-chip").text()).toBe("行 10-12");
    const numbers = wrapper.findAll(".td-read-no").map((node) => node.text());
    expect(numbers).toEqual(["10", "11", "12"]);
  });
});

// ============================================================================
// BashToolDetails (SDD §2.5)
// ============================================================================

describe("BashToolDetails", () => {
  it("shows the $-prefixed command above the normalized output", () => {
    wrapper = mount(BashToolDetails, {
      props: {
        tool: makeTool({
          toolName: "bash",
          args: { command: "npm test" },
          result: { content: [{ type: "text", text: "all green\n" }], details: {} },
        }),
      },
    });

    const command = wrapper.find(".td-bash-command");
    expect(command.exists()).toBe(true);
    expect(command.text()).toContain("$");
    expect(command.text()).toContain("npm test");
    const output = wrapper.find(".td-bash-output");
    expect(output.exists()).toBe(true);
    expect(output.text()).toBe("all green");
    // No exitCode chip exists anywhere.
    expect(wrapper.text()).not.toContain("exit");
  });
});

// ============================================================================
// JsonToolDetails (SDD §2.8)
// ============================================================================

describe("JsonToolDetails", () => {
  it("renders args as a key/value table with inline strings", () => {
    wrapper = mount(JsonToolDetails, {
      props: {
        tool: makeTool({ toolName: "mcp_tool", args: { target: "repo", count: 3 }, result: "ok" }),
      },
    });

    const rows = wrapper.findAll(".td-kv-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].find(".td-kv-key").text()).toBe("target");
    expect(rows[0].find(".td-kv-value").text()).toBe("repo");
    // Non-string values render as single-line JSON.
    expect(rows[1].find(".td-kv-value").text()).toBe("3");
    expect(wrapper.find(".td-pre").text()).toBe("ok");
  });

  it("highlights an object result as JSON", () => {
    wrapper = mount(JsonToolDetails, {
      props: {
        tool: makeTool({ toolName: "mcp_tool", args: {}, result: { items: ["a", "b"] } }),
      },
    });

    const pre = wrapper.find(".td-hljs");
    expect(pre.exists()).toBe(true);
    expect(pre.find("code").exists()).toBe(true);
    expect(pre.find("code .hljs-attr").exists()).toBe(true);
    expect(pre.find("code .hljs-string").exists()).toBe(true);
    // Escaped markup stays text, never raw HTML.
    expect(pre.text()).toContain('"items"');
  });

  it("renders a live AgentToolResult wrapper as normalized text, not a JSON dump (live/replay parity)", () => {
    wrapper = mount(JsonToolDetails, {
      props: {
        tool: makeTool({
          toolName: "mcp_tool",
          args: {},
          result: { content: [{ type: "text", text: "joined output" }], details: { x: 1 } },
        }),
      },
    });

    const pre = wrapper.find(".td-pre");
    expect(pre.exists()).toBe(true);
    expect(pre.find("code").exists()).toBe(false);
    expect(pre.text()).toBe("joined output");
  });
});

// ============================================================================
// TodoToolDetails (R3, CC-style checklist presentation)
// ============================================================================

describe("TodoToolDetails", () => {
  it("renders the full list from args.todos with per-status styling and the activeForm copy", () => {
    wrapper = mount(TodoToolDetails, {
      props: {
        tool: makeTool({
          toolName: "todo_write",
          args: {
            todos: [
              { content: "Inspect the module", status: "completed" },
              { content: "Run tests", status: "in_progress", activeForm: "Running tests" },
              { content: "Update docs", status: "pending" },
            ],
          },
          result: "updated",
        }),
      },
    });

    expect(wrapper.find(".td-todo-stat").text()).toContain("1/3 完成");
    const rows = wrapper.findAll(".td-todo-row");
    expect(rows).toHaveLength(3);
    expect(rows[0].classes()).toContain("completed");
    expect(rows[1].classes()).toContain("in_progress");
    expect(rows[2].classes()).toContain("pending");
    // in_progress rows show the progressive copy, others the imperative one.
    expect(rows[1].find(".td-todo-text").text()).toBe("Running tests");
    expect(rows[2].find(".td-todo-text").text()).toBe("Update docs");
    // Partially done list has no wrap-up hint.
    expect(wrapper.find(".td-todo-done-hint").exists()).toBe(false);
  });

  it("shows the wrap-up hint for an all-completed payload (controller auto-clear)", () => {
    wrapper = mount(TodoToolDetails, {
      props: {
        tool: makeTool({
          toolName: "todo_write",
          args: { todos: [{ content: "Run tests", status: "completed" }] },
          result: "updated",
        }),
      },
    });

    expect(wrapper.find(".td-todo-stat").text()).toContain("1/1 完成");
    expect(wrapper.find(".td-todo-done-hint").exists()).toBe(true);
  });

  it("renders the empty state for an explicit clear and for malformed args", () => {
    wrapper = mount(TodoToolDetails, {
      props: { tool: makeTool({ toolName: "todo_write", args: { todos: [] }, result: "updated" }) },
    });
    expect(wrapper.find(".td-todo-empty").text()).toBe("清单已清空");

    wrapper = mount(TodoToolDetails, {
      props: { tool: makeTool({ toolName: "todo_write", args: { todos: "junk" }, result: "updated" }) },
    });
    expect(wrapper.find(".td-todo-empty").text()).toBe("清单已清空");
    expect(wrapper.find(".td-todo-row").exists()).toBe(false);
  });

  it("drops structurally invalid items instead of rendering them", () => {
    wrapper = mount(TodoToolDetails, {
      props: {
        tool: makeTool({
          toolName: "todo_write",
          args: { todos: [{ content: "Run tests", status: "in_progress" }, { content: "", status: "pending" }] },
          result: "updated",
        }),
      },
    });

    expect(wrapper.findAll(".td-todo-row")).toHaveLength(1);
  });
});
