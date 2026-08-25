import { describe, expect, it } from "vitest";
import { convertToLlm, createCustomMessage } from "../../src/harness/messages.ts";

describe("harness internal custom message conversion", () => {
	it("wraps internal messages while keeping details out of model content", () => {
		const message = createCustomMessage(
			"pix-agent-task-result",
			"completed <untrusted> result",
			false,
			{ hidden: "details" },
			"2026-01-01T00:00:00.000Z",
			"internal",
		);

		const [converted] = convertToLlm([message]);

		expect(converted).toEqual({
			role: "user",
			content: [
				{
					type: "text",
					text:
						'<internal-message custom-type="pix-agent-task-result">\n' +
						"completed <untrusted> result\n" +
						"</internal-message>",
				},
			],
			timestamp: new Date("2026-01-01T00:00:00.000Z").getTime(),
		});
		expect(JSON.stringify(converted)).not.toContain("details");
	});

	it("keeps ordinary custom messages unchanged", () => {
		const message = createCustomMessage(
			"ordinary",
			"visible content",
			true,
			undefined,
			"2026-01-01T00:00:00.000Z",
		);

		expect(convertToLlm([message])).toEqual([
			{
				role: "user",
				content: [{ type: "text", text: "visible content" }],
				timestamp: new Date("2026-01-01T00:00:00.000Z").getTime(),
			},
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
			content: '<teammate-message from="coder">partial text without closer',
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

	it("escapes apostrophes in the internal custom-type attribute", () => {
		const message = createCustomMessage(
			"o'reilly",
			"ok",
			false,
			undefined,
			"2026-01-01T00:00:00.000Z",
			"internal",
		);
		const [converted] = convertToLlm([message]);
		expect(converted.content).toEqual([
			{
				type: "text",
				text: '<internal-message custom-type="o&apos;reilly">\nok\n</internal-message>',
			},
		]);
	});
});
