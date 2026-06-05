import { randomUUID } from "node:crypto";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "./extensions/types.ts";
import { defineTool } from "./extensions/types.ts";

export interface UserInputAttachment {
	path: string;
	name: string;
	kind: "text" | "image" | "file";
	size?: number;
	content?: string;
}

export interface RequestUserInputOption {
	label: string;
	description?: string;
}

export interface RequestUserInputQuestion {
	id: string;
	header: string;
	question: string;
	options?: RequestUserInputOption[];
}

export interface RequestUserInputRequest {
	id: string;
	questions: RequestUserInputQuestion[];
}

export interface RequestUserInputResponse {
	id: string;
	answers: Record<string, string>;
	cancelled?: boolean;
}

export type RequestUserInputHandler = (
	request: RequestUserInputRequest,
	signal?: AbortSignal,
) => Promise<RequestUserInputResponse>;

const optionSchema = Type.Object({
	label: Type.String({ description: "Short user-facing option label." }),
	description: Type.Optional(Type.String({ description: "One sentence explaining the option's impact." })),
});

const questionSchema = Type.Object({
	id: Type.String({ description: "Stable snake_case id for mapping the user's answer." }),
	header: Type.String({ description: "Short header label, 12 characters or fewer." }),
	question: Type.String({ description: "Single-sentence prompt shown to the user." }),
	options: Type.Optional(
		Type.Array(optionSchema, {
			minItems: 2,
			maxItems: 3,
			description: "Optional mutually exclusive choices. The UI can also collect free-form text.",
		}),
	),
});

const requestUserInputSchema = Type.Object({
	questions: Type.Array(questionSchema, {
		minItems: 1,
		maxItems: 3,
		description: "One to three short questions for the user.",
	}),
});

function normalizeQuestion(question: Static<typeof questionSchema>): RequestUserInputQuestion {
	return {
		id: question.id.trim(),
		header: question.header.trim(),
		question: question.question.trim(),
		options: question.options?.map((option) => ({
			label: option.label.trim(),
			description: option.description?.trim(),
		})),
	};
}

function validateQuestions(questions: RequestUserInputQuestion[]): RequestUserInputQuestion[] {
	if (questions.length < 1 || questions.length > 3) {
		throw new Error("request_user_input requires one to three questions.");
	}
	const seen = new Set<string>();
	for (const question of questions) {
		if (!question.id) throw new Error("Each request_user_input question needs a non-empty id.");
		if (seen.has(question.id)) throw new Error(`Duplicate request_user_input question id: ${question.id}`);
		seen.add(question.id);
		if (!question.header) throw new Error(`Question ${question.id} needs a header.`);
		if (!question.question) throw new Error(`Question ${question.id} needs question text.`);
		if (question.options && (question.options.length < 2 || question.options.length > 3)) {
			throw new Error(`Question ${question.id} options must contain two or three choices.`);
		}
	}
	return questions;
}

export function createRequestUserInputToolDefinitions(handler?: RequestUserInputHandler): ToolDefinition[] {
	if (!handler) return [];

	return [
		defineTool({
			name: "request_user_input",
			label: "Request user input",
			description:
				"Ask the user one to three short questions when you need clarification before continuing. Execution pauses until the user responds.",
			promptSnippet:
				"Use request_user_input when progress requires explicit user input. Keep questions short and provide 2-3 choices when possible.",
			parameters: requestUserInputSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params: Static<typeof requestUserInputSchema>, signal) {
				const request: RequestUserInputRequest = {
					id: randomUUID(),
					questions: validateQuestions(params.questions.map(normalizeQuestion)),
				};
				const response = await handler(request, signal);
				if (response.cancelled) {
					return {
						content: [{ type: "text", text: "User cancelled the input request." }],
						details: { request, response },
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `User response:\n${JSON.stringify(response.answers, null, 2)}`,
						},
					],
					details: { request, response },
				};
			},
		}),
	];
}
