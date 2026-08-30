import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import {
	ACP_STATUS_PROMPT_GUIDELINES,
	ACP_STATUS_PROMPT_SNIPPET,
	COMPRESS_PROMPT_GUIDELINES,
	COMPRESS_PROMPT_SNIPPET,
	DECOMPRESS_PROMPT_GUIDELINES,
	DECOMPRESS_PROMPT_SNIPPET,
	SEARCH_CONTEXT_PROMPT_GUIDELINES,
	SEARCH_CONTEXT_PROMPT_SNIPPET,
} from "./prompt.ts";
import type { AcpRuntime } from "./runtime.ts";
import { ACP_TOOL_NAMES } from "./types.ts";

const compressRangeSchema = Type.Object({
	startId: Type.String({ description: "Start message ref (for example m00005)" }),
	endId: Type.String({ description: "End message ref (inclusive)" }),
	summary: Type.String({ description: "Self-contained historical summary of the range" }),
	topic: Type.Optional(Type.String({ description: "Optional topic label for the block" })),
});

const compressSchema = Type.Object({
	topic: Type.Optional(Type.String({ description: "Optional topic for this compress call" })),
	content: Type.Union([
		Type.Array(compressRangeSchema),
		Type.String({ description: "JSON-encoded range array from non-strict tool providers" }),
	]),
});

const decompressSchema = Type.Object({
	blockId: Type.String({ description: "Compressed block id (for example b3)" }),
	full: Type.Optional(Type.Boolean({ description: "Recurse nested tiers to original messages" })),
	inline: Type.Optional(Type.Boolean({ description: "Return body in the tool result instead of a temp file" })),
});

const searchSchema = Type.Object({
	query: Type.String({ description: "Search query over compressed blocks and folded history" }),
});

const statusSchema = Type.Object({
	scope: Type.Optional(
		Type.Union([Type.Literal("uncompressed"), Type.Literal("compressed")], {
			description: "Which side of the send view to list",
		}),
	),
	view: Type.Optional(Type.Literal("messages", { description: "List message refs instead of ranges" })),
});

function textResult(text: string, details: object = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

export function createAcpTools(runtime: AcpRuntime): ToolDefinition[] {
	return [
		defineTool({
			name: ACP_TOOL_NAMES[0],
			label: "Compress",
			description:
				"Fold consumed conversation ranges into summaries. Cite ref ids only (m00005, b3). Do not wrap args in <acp> XML.",
			promptSnippet: COMPRESS_PROMPT_SNIPPET,
			promptGuidelines: COMPRESS_PROMPT_GUIDELINES,
			parameters: compressSchema,
			async execute(_toolCallId, params: Static<typeof compressSchema>, _signal, _onUpdate, ctx) {
				const result = runtime.applyCompressResult(params, ctx);
				if (result.isError) {
					throw new Error(result.text);
				}
				return textResult(result.text, result.details);
			},
		}),
		defineTool({
			name: ACP_TOOL_NAMES[1],
			label: "Decompress",
			description: "Restore a compressed block. Default writes a temp file and returns its path.",
			promptSnippet: DECOMPRESS_PROMPT_SNIPPET,
			promptGuidelines: DECOMPRESS_PROMPT_GUIDELINES,
			parameters: decompressSchema,
			async execute(_toolCallId, params: Static<typeof decompressSchema>) {
				const text = await runtime.decompress(params);
				return textResult(text);
			},
		}),
		defineTool({
			name: ACP_TOOL_NAMES[2],
			label: "Search context",
			description: "Search compressed blocks and folded history to find a ref before decompress.",
			promptSnippet: SEARCH_CONTEXT_PROMPT_SNIPPET,
			promptGuidelines: SEARCH_CONTEXT_PROMPT_GUIDELINES,
			parameters: searchSchema,
			async execute(_toolCallId, params: Static<typeof searchSchema>) {
				const text = await runtime.search(params);
				return textResult(text);
			},
		}),
		defineTool({
			name: ACP_TOOL_NAMES[3],
			label: "ACP status",
			description: "Show current uncompressed/compressed refs. Call this after a failed compress before retrying.",
			promptSnippet: ACP_STATUS_PROMPT_SNIPPET,
			promptGuidelines: ACP_STATUS_PROMPT_GUIDELINES,
			parameters: statusSchema,
			async execute(_toolCallId, params: Static<typeof statusSchema>) {
				const text = await runtime.status(params);
				return textResult(text);
			},
		}),
	];
}
