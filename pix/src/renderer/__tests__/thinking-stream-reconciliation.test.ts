import { describe, expect, it } from "vitest";
import { defineComponent, nextTick, reactive } from "vue";
import { mount } from "@vue/test-utils";
import type { AgentMessage, AgentSessionEvent } from "@shared/types.js";
import type { AgentSessionEvent as CoreSessionEvent } from "@earendil-works/pi-coding-agent";
import { MessageUpdateCoalescer } from "../../main/message-update-coalescer";
import { createDisplayBlockAssembler } from "../utils/display-blocks";
import ThinkingBlock from "../components/session/ThinkingBlock.vue";
import type { DisplayBlock } from "../types/session";

interface ContentBlock { type: string; thinking?: string; text?: string; id?: string; name?: string; arguments?: unknown }

function message(content: ContentBlock[], timestamp = 100): AgentMessage {
  return { role: "assistant", content, timestamp };
}

function update(msg: AgentMessage, type: string, contentIndex: number, delta?: string): AgentSessionEvent {
  return { type: "message_update", message: msg, assistantMessageEvent: { type, contentIndex, delta } };
}

describe("thinking segment reconciliation", () => {
  it("does not render future text or duplicate thinking when a buffered snapshot advances", () => {
    const assembler = createDisplayBlockAssembler();
    const coalescer = new MessageUpdateCoalescer((event) => assembler.applyEvent(event as AgentSessionEvent), 50_000);
    const thought: ContentBlock = { type: "thinking", thinking: "Inspect the input box." };
    const msg = message([thought]);
    try {
      coalescer.push(update(msg, "thinking_start", 0) as CoreSessionEvent);
      coalescer.push(update(msg, "thinking_delta", 0, thought.thinking) as CoreSessionEvent);
      // Provider partials share the content array. It can grow while the IPC
      // coalescer still holds a thinking delta from the preceding phase.
      thought.thinking += " Then enter hello.";
      (msg.content as ContentBlock[]).push({ type: "text", text: "输入 hello。" });
      coalescer.flush();
      expect(assembler.blocks.map((block) => block.type)).toEqual(["thinking"]);

      coalescer.push(update(msg, "thinking_delta", 0, " Then enter hello.") as CoreSessionEvent);
      coalescer.push(update(msg, "text_start", 1) as CoreSessionEvent);
      coalescer.push(update(msg, "text_delta", 1, "输入 hello。") as CoreSessionEvent);
      coalescer.push(update(msg, "thinking_end", 0) as CoreSessionEvent);
      coalescer.push({ type: "message_end", message: msg } as unknown as CoreSessionEvent);
      expect(assembler.blocks.map((block) => block.type)).toEqual(["thinking", "agent-message"]);
      const thinking = assembler.blocks.filter((block) => block.type === "thinking");
      expect(thinking).toHaveLength(1);
      expect(thinking[0].content).toBe(thought.thinking);
      expect(thinking[0].superseded).toBe(true);
    } finally { coalescer.dispose(); }
  });

  it("updates the original thinking segment when a trailing delta arrives after text or a tool marker", () => {
    for (const nextMove of ["text_start", "toolcall_start"]) {
      const assembler = createDisplayBlockAssembler();
      const thought: ContentBlock = { type: "thinking", thinking: "Find the send button." };
      const msg = message([thought]);
      assembler.applyEvent(update(msg, "thinking_start", 0));
      assembler.applyEvent(update(msg, "thinking_delta", 0, thought.thinking));
      const original = assembler.blocks[0];
      (msg.content as ContentBlock[]).push(nextMove === "text_start"
        ? { type: "text", text: "点击发送。" }
        : { type: "toolCall", id: "click-send", name: "computer_act", arguments: { action: "click" } });
      assembler.applyEvent(update(msg, nextMove, 1));
      thought.thinking += " Verify its enabled state.";
      assembler.applyEvent(update(msg, "thinking_delta", 0, " Verify its enabled state."));
      assembler.applyEvent(update(msg, "thinking_end", 0));
      const thinking = assembler.blocks.filter((block) => block.type === "thinking");
      expect(thinking).toHaveLength(1);
      expect(thinking[0]).toBe(original);
      expect(thinking[0].content).toBe(thought.thinking);
      expect(thinking[0].superseded).toBe(true);
    }
  });

  it("preserves genuinely separate segments even when their text is identical", () => {
    const assembler = createDisplayBlockAssembler();
    const msg = message([{ type: "thinking", thinking: "Check." }, { type: "text", text: "First." }]);
    assembler.applyEvent(update(msg, "thinking_start", 0));
    assembler.applyEvent(update(msg, "thinking_delta", 0, "Check."));
    assembler.applyEvent(update(msg, "thinking_end", 0));
    assembler.applyEvent(update(msg, "text_start", 1));
    (msg.content as ContentBlock[]).push({ type: "thinking", thinking: "Check." });
    assembler.applyEvent(update(msg, "thinking_start", 2));
    assembler.applyEvent(update(msg, "thinking_delta", 2, "Check."));
    const thinking = assembler.blocks.filter((block) => block.type === "thinking");
    expect(thinking).toHaveLength(2);
    expect(thinking.map((block) => block.content)).toEqual(["Check.", "Check."]);
    expect(thinking[1].superseded).toBe(false);
  });

  it("scopes content indices to each assistant message", () => {
    const assembler = createDisplayBlockAssembler();
    for (const timestamp of [100, 200]) {
      const msg = message([{ type: "thinking", thinking: "Check." }], timestamp);
      assembler.applyEvent({ type: "message_start", message: msg });
      assembler.applyEvent(update(msg, "thinking_start", 0));
      assembler.applyEvent(update(msg, "thinking_delta", 0, "Check."));
      assembler.applyEvent({ type: "message_end", message: msg });
    }
    expect(assembler.blocks.filter((block) => block.type === "thinking")).toHaveLength(2);
  });

  it("recovers final text when a late subscriber first sees a tool marker", () => {
    const assembler = createDisplayBlockAssembler();
    const msg = message([{ type: "text", text: "Running the command." }, { type: "toolCall", id: "run", name: "bash", arguments: {} }]);
    assembler.applyEvent(update(msg, "toolcall_start", 1));
    assembler.applyEvent({ type: "message_end", message: msg });
    const text = assembler.blocks.filter((block) => block.type === "agent-message");
    expect(text).toHaveLength(1);
    expect(text[0].content).toBe("Running the command.");
  });

  it("reconciles a started text prefix from the final message after joining during tools", () => {
    const assembler = createDisplayBlockAssembler();
    assembler.applyEvent({ type: "message_start", message: message([{ type: "text", text: "Running" }]) });
    const msg = message([{ type: "text", text: "Running the command." }, { type: "toolCall", id: "run", name: "bash", arguments: {} }]);
    assembler.applyEvent(update(msg, "toolcall_start", 1));
    assembler.applyEvent({ type: "message_end", message: msg });
    const text = assembler.blocks.filter((block) => block.type === "agent-message");
    expect(text).toHaveLength(1);
    expect(text[0].content).toBe("Running the command.");
  });

  it("renders a single thinking header above the answer after the final reasoning updates", async () => {
    const blocks = reactive<DisplayBlock[]>([]);
    const assembler = createDisplayBlockAssembler({ blocks });
    const view = mount(defineComponent({
      components: { ThinkingBlock },
      setup: () => ({ blocks }),
      template: '<div><template v-for="block in blocks" :key="block.id"><ThinkingBlock v-if="block.type === \'thinking\'" :block="block"/><p v-else-if="block.type === \'agent-message\'">{{ block.content }}</p></template></div>',
    }));
    try {
      const thought: ContentBlock = { type: "thinking", thinking: "Inspect the input box." };
      const msg = message([thought, { type: "text", text: "输入 hello。" }]);
      // Even message_start can share an already-advanced provider partial.
      assembler.applyEvent({ type: "message_start", message: msg });
      assembler.applyEvent(update(msg, "thinking_start", 0));
      assembler.applyEvent(update(msg, "thinking_delta", 0, thought.thinking));
      assembler.applyEvent(update(msg, "text_start", 1));
      thought.thinking += " Then enter hello.";
      assembler.applyEvent(update(msg, "thinking_delta", 0, " Then enter hello."));
      assembler.applyEvent(update(msg, "thinking_end", 0));
      assembler.applyEvent({ type: "message_end", message: msg });
      await nextTick();
      expect(view.findAll(".thinking-header")).toHaveLength(1);
      expect(view.find("p").text()).toBe("输入 hello。");
      expect(blocks.map((block) => block.type)).toEqual(["thinking", "agent-message"]);
      await view.find(".thinking-header").trigger("click");
      expect(view.find(".thinking-body").text()).toBe(thought.thinking);
    } finally { view.unmount(); }
  });
});
