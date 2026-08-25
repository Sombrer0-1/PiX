import { describe, expect, it } from "vitest";
import {
  convertToLlm,
  isInternalCustomMessage,
  LEGACY_INTERNAL_CUSTOM_TYPES,
  type CustomMessage,
} from "../src/core/messages.ts";

function customMessage(overrides: Partial<CustomMessage> = {}): CustomMessage {
  return {
    role: "custom",
    customType: "example",
    content: "hello",
    display: true,
    details: { hidden: true },
    timestamp: 123,
    ...overrides,
  };
}

describe("internal custom message conversion", () => {
  it("keeps ordinary custom messages unchanged", () => {
    const [message] = convertToLlm([customMessage()]);

    expect(message).toEqual({
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: 123,
    });
  });

  it("wraps internal messages without leaking details", () => {
    const [message] = convertToLlm([
      customMessage({
        customType: 'pix-agent-task-result"><ignored>',
        display: false,
        context: "internal",
        content: "result <untrusted> & data",
      }),
    ]);

    expect(message?.role).toBe("user");
    expect(message?.timestamp).toBe(123);
    expect(message?.content).toEqual([
      {
        type: "text",
        text:
          '<internal-message custom-type="pix-agent-task-result&quot;&gt;&lt;ignored&gt;">\n' +
          "result <untrusted> & data\n" +
          "</internal-message>",
      },
    ]);
    expect(JSON.stringify(message)).not.toContain("hidden");
  });

  it("recognizes legacy runtime custom types and preserves mixed content blocks", () => {
    const legacy = customMessage({
      customType: "pix-plan-retry",
      content: [
        { type: "text", text: "retry" },
        { type: "image", data: "ignored", mimeType: "image/png" },
      ],
    });

    expect(isInternalCustomMessage(legacy)).toBe(true);
    const [message] = convertToLlm([legacy]);
    expect(message?.content).toEqual([
      { type: "text", text: '<internal-message custom-type="pix-plan-retry">\n' },
      { type: "text", text: "retry" },
      { type: "image", data: "ignored", mimeType: "image/png" },
      { type: "text", text: "\n</internal-message>" },
    ]);
  });

  it("marks legacy notification text stored as a user message as internal", () => {
    const [message] = convertToLlm([
      {
        role: "user",
        content: '<teammate-message from="coder">done</teammate-message>',
        timestamp: 456,
      },
    ]);

    expect(message).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text:
            '<internal-message custom-type="legacy-runtime-notification">\n' +
            '<teammate-message from="coder">done</teammate-message>\n' +
            "</internal-message>",
        },
      ],
      timestamp: 456,
    });
  });

  it("does not wrap a user message that merely mentions a reserved prefix", () => {
    const input = {
      role: "user" as const,
      content: "See this format: <task-notification>please explain</task-notification> — what does it mean?",
      timestamp: 789,
    };
    expect(convertToLlm([input])).toEqual([input]);
  });

  it("does not wrap a user message with an opening tag but no closing tag", () => {
    const input = {
      role: "user" as const,
      content: "<teammate-message from=\"coder\">partial text without closer",
      timestamp: 790,
    };
    expect(convertToLlm([input])).toEqual([input]);
  });

  it("does not treat a longer tag name as a reserved root", () => {
    const input = {
      role: "user" as const,
      content: "<teammate-message2>not a reserved root</teammate-message2>",
      timestamp: 791,
    };
    expect(convertToLlm([input])).toEqual([input]);
  });

  it("keeps the legacy customType set identical to the four pix protocol types", () => {
    expect([...LEGACY_INTERNAL_CUSTOM_TYPES].sort()).toEqual([
      "pix-agent-task-result",
      "pix-plan-context",
      "pix-plan-retry",
      "pix-team-notification",
    ]);
  });

  it("escapes apostrophes in the internal custom-type attribute", () => {
    const [message] = convertToLlm([
      customMessage({
        customType: "o'reilly",
        display: false,
        context: "internal",
        content: "ok",
      }),
    ]);
    expect(message?.content).toEqual([
      {
        type: "text",
        text: '<internal-message custom-type="o&apos;reilly">\nok\n</internal-message>',
      },
    ]);
  });
});
