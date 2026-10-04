import type { Model } from "../../src/types.ts";

export const opencodeGoKimi: Model<"openai-completions"> = {
	id: "kimi-k2.6",
	name: "Kimi toggle fixture",
	api: "openai-completions",
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	reasoning: true,
	thinkingLevelMap: { minimal: null, low: null, medium: null },
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262144,
	maxTokens: 131000,
	compat: { thinkingFormat: "deepseek", supportsReasoningEffort: false },
};
