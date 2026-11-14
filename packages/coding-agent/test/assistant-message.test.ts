import type { AssistantMessage } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("keeps full thinking markdown when progressive display is off", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "alpha\nbeta" }]),
		);
		const rendered = stripAnsi(component.render(40).join("\n"));

		expect(rendered).toContain("alpha");
		expect(rendered).toContain("beta");
	});
});

describe("AssistantMessageComponent progressive display", () => {
	function progressive(): AssistantMessageComponent {
		initTheme("dark");
		return new AssistantMessageComponent(undefined, false, undefined, "Thinking...", { progressive: true });
	}

	function thinkingMessage(thinking: string, extra?: Partial<AssistantMessage>): AssistantMessage {
		return { ...createAssistantMessage([{ type: "thinking", thinking }]), ...extra };
	}

	test("updates one thinking segment and settles it to the first line", () => {
		const component = progressive();
		const started = thinkingMessage("");
		component.updateContent(started, { type: "start" });
		component.updateContent(started, {
			type: "update",
			event: { type: "thinking_start", contentIndex: 0, partial: started },
		});
		expect(stripAnsi(component.render(80).join("\n"))).toContain("Thinking…");

		const checking = thinkingMessage("Checking the test setup");
		component.updateContent(checking, {
			type: "update",
			event: { type: "thinking_delta", contentIndex: 0, delta: "Checking the test setup", partial: checking },
		});
		expect(stripAnsi(component.render(80).join("\n"))).toContain("Thinking… Checking the test setup");

		const continued = thinkingMessage("Checking the test setup\nLooking at the assertion");
		component.updateContent(continued, {
			type: "update",
			event: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "\nLooking at the assertion",
				partial: continued,
			},
		});
		let rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("Thinking… Looking at the assertion");
		expect(rendered).not.toContain("Checking the test setup");

		component.updateContent(continued, {
			type: "update",
			event: {
				type: "thinking_end",
				contentIndex: 0,
				content: "Checking the test setup\nLooking at the assertion",
				partial: continued,
			},
		});
		rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("Checking the test setup");
		expect(rendered).not.toContain("Looking at the assertion");
		expect(rendered).not.toContain("Thinking…");

		const items = component.getHistoryItems("msg-think");
		expect(items.map((item) => item.id)).toEqual(["msg-think:thinking:0"]);
		expect(items[0]?.kind).toBe("thinking");
		expect(items[0]?.detail?.()).toBe("Checking the test setup\nLooking at the assertion");
	});

	test("settles an open thinking segment when later text arrives and keeps the PiX label", () => {
		const component = progressive();
		const message = createAssistantMessage([
			{ type: "thinking", thinking: "first summary\nrecent tail" },
			{ type: "text", text: "Hel" },
		]);
		component.updateContent(message, { type: "start" });
		component.updateContent(message, {
			type: "update",
			event: { type: "text_start", contentIndex: 1, partial: message },
		});
		let rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("first summary");
		expect(rendered).not.toContain("recent tail");
		expect(rendered).toContain("PiX");
		expect(rendered).toContain("Hel");

		const grown = createAssistantMessage([
			{ type: "thinking", thinking: "first summary\nrecent tail" },
			{ type: "text", text: "Hello from the assistant" },
		]);
		component.updateContent(grown, {
			type: "update",
			event: { type: "text_delta", contentIndex: 1, delta: "lo from the assistant", partial: grown },
		});
		rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered.match(/PiX/g)?.length).toBe(1);
		expect(rendered).toContain("Hello from the assistant");
		expect(rendered.indexOf("PiX")).toBeLessThan(rendered.indexOf("Hello from the assistant"));
	});

	test("adds OSC 133 to a text-only progressive result and labels it Answer", () => {
		const component = progressive();
		const message = createAssistantMessage([{ type: "text", text: "hello from pix" }]);
		component.updateContent(message, { type: "end" });
		const lines = component.render(40);

		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		const rendered = stripAnsi(lines.join("\n"));
		expect(rendered).toContain("PiX");
		expect(rendered).toContain("hello from pix");

		const items = component.getHistoryItems("msg-answer");
		expect(items).toEqual([expect.objectContaining({ id: "msg-answer:text:0", kind: "assistant", label: "Answer" })]);
		expect(items[0]?.detail?.()).toBe("hello from pix");
	});

	test("shows Thinking… for an empty in-progress segment", () => {
		const component = progressive();
		const message = thinkingMessage(" \n\t");
		component.updateContent(message, { type: "start" });
		component.updateContent(message, {
			type: "update",
			event: { type: "thinking_start", contentIndex: 0, partial: message },
		});

		expect(stripAnsi(component.render(40).join("\n"))).toContain("Thinking…");
		expect(component.getHistoryItems("msg-empty")[0]?.detail).toBeUndefined();
	});

	test("shows redacted thinking hints without signature fields", () => {
		const component = progressive();
		const hinted = createAssistantMessage([
			{ type: "thinking", thinking: "[Reasoning redacted]", redacted: true, thinkingSignature: "sig-SECRET" },
		]);
		component.updateContent(hinted, { type: "end" });
		let rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("[Reasoning redacted]");
		expect(rendered).not.toContain("sig-SECRET");
		expect(component.getHistoryItems("msg-redacted")[0]?.detail?.()).toBe("[Reasoning redacted]");
		expect(component.getHistoryItems("msg-redacted")[0]?.detail?.()).not.toContain("sig-SECRET");

		const hidden = createAssistantMessage([
			{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque-SECRET" },
		]);
		component.updateContent(hidden, { type: "end" });
		rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("Reasoning unavailable");
		expect(rendered).not.toContain("opaque-SECRET");
		expect(component.getHistoryItems("msg-redacted")[0]?.detail?.()).toBe("Reasoning unavailable");
	});

	test("truncates the live thinking line to the terminal width", () => {
		const component = progressive();
		const message = thinkingMessage(`Checking ${"配置".repeat(40)}`);
		component.updateContent(message, { type: "start" });
		component.updateContent(message, {
			type: "update",
			event: { type: "thinking_delta", contentIndex: 0, delta: "配置", partial: message },
		});

		const lines = component.render(16);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(16);
		}
		expect(stripAnsi(lines.join("\n"))).toContain("Thinking…");
	});

	test("hides thinking text on the main screen while history detail keeps it", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(undefined, true, undefined, "Hidden thought", {
			progressive: true,
		});
		const message = thinkingMessage("secret reasoning\nmore detail");
		component.updateContent(message, { type: "end" });

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("Hidden thought");
		expect(rendered).not.toContain("secret reasoning");
		const item = component.getHistoryItems("msg-hidden")[0];
		expect(item?.kind).toBe("thinking");
		expect(item?.label).toBe("Hidden thought");
		expect(item?.detail?.()).toBe("secret reasoning\nmore detail");
	});

	test("uses end.errorMessage only for local display", () => {
		const component = progressive();
		const message = createAssistantMessage([{ type: "text", text: "partial answer" }]);
		component.updateContent(message, { type: "end", errorMessage: "socket closed" });

		expect(message.errorMessage).toBeUndefined();
		expect(stripAnsi(component.render(80).join("\n"))).toContain("socket closed");
		const errorItem = component.getHistoryItems("msg-error").find((item) => item.kind === "error");
		expect(errorItem?.id).toBe("msg-error:error:0");
		expect(errorItem?.label).toContain("socket closed");
	});

	test("drops history slots that disappear from the final snapshot", () => {
		const component = progressive();
		component.updateContent(
			createAssistantMessage([
				{ type: "thinking", thinking: "temporary" },
				{ type: "text", text: "stay" },
			]),
			{ type: "end" },
		);
		component.updateContent(createAssistantMessage([{ type: "text", text: "stay" }]), { type: "end" });

		const items = component.getHistoryItems("msg-drop");
		expect(items.map((item) => item.id)).toEqual(["msg-drop:text:0"]);
		expect(items[0]?.label).toBe("Answer");
	});
});
