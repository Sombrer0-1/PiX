import { describe, expect, it } from "vitest";
import {
	applyThinkingLevelMetadata,
	reasoningOptionsToThinkingLevelMap,
	type ReasoningOption,
} from "../scripts/generate-models.ts";
import type { Model } from "../src/types.ts";

const effort = (...values: (string | null)[]): ReasoningOption[] => [{ type: "effort", values }];

function makeModel(overrides: Partial<Model<any>>): Model<any> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "opencode-go",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		...overrides,
	};
}

describe("reasoningOptionsToThinkingLevelMap", () => {
	it("maps partial effort vocabularies and hides unmapped tiers", () => {
		expect(reasoningOptionsToThinkingLevelMap(effort("low", "high", "max"), "openai-completions")).toEqual({
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: "max",
		});
	});

	it("maps full vocabularies verbatim", () => {
		expect(reasoningOptionsToThinkingLevelMap(effort("minimal", "low", "medium", "high", "xhigh"), "openai-completions")).toEqual({
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
		});
	});

	it("maps a single max value to the xhigh tier", () => {
		expect(reasoningOptionsToThinkingLevelMap(effort("max"), "openai-completions")).toEqual({
			minimal: null,
			low: null,
			medium: null,
			high: null,
			xhigh: "max",
		});
	});

	it("normalizes wire values to lowercase", () => {
		expect(reasoningOptionsToThinkingLevelMap(effort("LOW", "High", "MAX"), "openai-completions")).toEqual({
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: "max",
		});
	});

	it("maps off wire values onto the off tier", () => {
		expect(reasoningOptionsToThinkingLevelMap(effort("none", "low", "high"), "openai-completions")).toMatchObject({
			off: "none",
		});
		expect(reasoningOptionsToThinkingLevelMap(effort("off", "high"), "openai-completions")).toMatchObject({ off: "off" });
		expect(reasoningOptionsToThinkingLevelMap(effort("disabled", "high"), "openai-completions")).toMatchObject({
			off: "disabled",
		});
	});

	it("maps null values to the none wire value (opencode semantics)", () => {
		expect(reasoningOptionsToThinkingLevelMap(effort(null, "high"), "openai-completions")).toMatchObject({
			off: "none",
			high: "high",
		});
	});

	it("resolves the xhigh slot conflict in favor of max regardless of order", () => {
		expect(reasoningOptionsToThinkingLevelMap(effort("none", "low", "medium", "high", "xhigh", "max"), "openai-completions")).toMatchObject({
			xhigh: "max",
		});
		expect(reasoningOptionsToThinkingLevelMap(effort("max", "xhigh"), "openai-completions")).toMatchObject({
			xhigh: "max",
		});
	});

	it("recognizes maximum and extra_high aliases", () => {
		expect(reasoningOptionsToThinkingLevelMap(effort("extra_high"), "openai-completions")).toMatchObject({
			xhigh: "xhigh",
		});
		expect(reasoningOptionsToThinkingLevelMap(effort("maximum"), "openai-completions")).toMatchObject({
			xhigh: "max",
		});
	});

	it("ignores unrecognized wire values", () => {
		expect(reasoningOptionsToThinkingLevelMap(effort("default", "low"), "openai-completions")).toEqual({
			minimal: null,
			low: "low",
			medium: null,
			high: null,
			xhigh: null,
		});
	});

	it("returns undefined when no wire value is recognized", () => {
		expect(reasoningOptionsToThinkingLevelMap(effort("turbo", "ludicrous"), "openai-completions")).toBeUndefined();
	});

	it("maps an off-only vocabulary to a map with every tier hidden", () => {
		// groq qwen/qwen3.6-27b lists ["none", "default"]; "default" is not a pi
		// tier, so only off remains selectable.
		expect(reasoningOptionsToThinkingLevelMap(effort("none", "default"), "openai-completions")).toEqual({
			off: "none",
			minimal: null,
			low: null,
			medium: null,
			high: null,
			xhigh: null,
		});
	});

	it("ignores wire values with surrounding whitespace", () => {
		expect(reasoningOptionsToThinkingLevelMap(effort(" low ", "high"), "openai-completions")).toEqual({
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
		});
	});

	it("is idempotent for duplicate wire values", () => {
		expect(reasoningOptionsToThinkingLevelMap(effort("low", "low", "high", "high", "max", "max"), "openai-completions")).toEqual({
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: "max",
		});
	});

	it("keeps the xhigh slot when only xhigh is offered", () => {
		expect(reasoningOptionsToThinkingLevelMap(effort("xhigh"), "openai-completions")).toEqual({
			minimal: null,
			low: null,
			medium: null,
			high: null,
			xhigh: "xhigh",
		});
	});

	it("hides off for responses APIs when the vocabulary has no off wire value", () => {
		const options = effort("medium", "high", "xhigh");
		expect(reasoningOptionsToThinkingLevelMap(options, "openai-responses")).toMatchObject({ off: null });
		expect(reasoningOptionsToThinkingLevelMap(options, "azure-openai-responses")).toMatchObject({ off: null });
	});

	it("keeps off visible (unset) for APIs with a native disable mechanism", () => {
		const options = effort("low", "high", "max");
		expect(reasoningOptionsToThinkingLevelMap(options, "openai-completions")?.off).toBeUndefined();
		expect(reasoningOptionsToThinkingLevelMap(options, "anthropic-messages")?.off).toBeUndefined();
		expect(reasoningOptionsToThinkingLevelMap(options, "google-generative-ai")?.off).toBeUndefined();
	});

	it("returns undefined for toggle and budget_tokens options", () => {
		expect(reasoningOptionsToThinkingLevelMap([{ type: "toggle" }], "openai-completions")).toBeUndefined();
		expect(
			reasoningOptionsToThinkingLevelMap([{ type: "toggle" }, { type: "budget_tokens", max: 81920 }], "openai-completions"),
		).toBeUndefined();
		expect(reasoningOptionsToThinkingLevelMap([{ type: "budget_tokens", min: 1024 }], "anthropic-messages")).toBeUndefined();
	});

	it("returns undefined for empty or missing options", () => {
		expect(reasoningOptionsToThinkingLevelMap([], "openai-completions")).toBeUndefined();
		expect(reasoningOptionsToThinkingLevelMap(undefined, "openai-completions")).toBeUndefined();
		expect(reasoningOptionsToThinkingLevelMap(effort(), "openai-completions")).toBeUndefined();
	});

	it("tolerates dirty catalog data instead of aborting the generator", () => {
		// The function runs inside the regeneration loop; an exception would
		// abort the whole run and silently ship a stale catalog.
		expect(reasoningOptionsToThinkingLevelMap(null as unknown as ReasoningOption[], "openai-completions")).toBeUndefined();
		expect(reasoningOptionsToThinkingLevelMap({} as unknown as ReasoningOption[], "openai-completions")).toBeUndefined();
		expect(reasoningOptionsToThinkingLevelMap([null as unknown as ReasoningOption], "openai-completions")).toBeUndefined();
		// Effort option without a usable values array.
		expect(
			reasoningOptionsToThinkingLevelMap([{ type: "effort" } as unknown as ReasoningOption], "openai-completions"),
		).toBeUndefined();
		expect(
			reasoningOptionsToThinkingLevelMap(
				[{ type: "effort", values: "low,high" as unknown as (string | null)[] }],
				"openai-completions",
			),
		).toBeUndefined();
		// Non-string entries are skipped; recognized ones still map.
		expect(
			reasoningOptionsToThinkingLevelMap(
				[{ type: "effort", values: [5, "high", true] as unknown as (string | null)[] }],
				"openai-completions",
			),
		).toEqual({ minimal: null, low: null, medium: null, high: "high", xhigh: null });
	});
});

describe("catalog-first thinking level priority", () => {
	it("skips hardcoded map rules when a catalog map exists", () => {
		const model = makeModel({ id: "gpt-5.4", api: "openai-responses", provider: "openai" });
		applyThinkingLevelMetadata(model, true);
		expect(model.thinkingLevelMap).toBeUndefined();
	});

	it("applies hardcoded map rules as fallback when no catalog map exists", () => {
		const model = makeModel({ id: "gpt-5.4", api: "openai-responses", provider: "openai" });
		applyThinkingLevelMetadata(model, false);
		expect(model.thinkingLevelMap).toEqual({ off: "none", xhigh: "xhigh" });
	});

	it("still applies compat rules when a catalog map exists", () => {
		const model = makeModel({ id: "claude-opus-4-6", api: "anthropic-messages", provider: "anthropic" });
		applyThinkingLevelMetadata(model, true);
		expect(model.thinkingLevelMap).toBeUndefined();
		expect(model.compat).toMatchObject({ forceAdaptiveThinking: true });
	});

	it("keeps the Opus 4.7/4.8 xhigh override on top of a catalog map", () => {
		// models.dev lists both "xhigh" and "max" for Opus 4.7/4.8, but the
		// Anthropic API only accepts "xhigh" there ("max" is Opus 4.6-only).
		const model = makeModel({ id: "claude-opus-4-8", api: "anthropic-messages", provider: "anthropic" });
		model.thinkingLevelMap = { minimal: null, low: "low", medium: "medium", high: "high", xhigh: "max" };
		applyThinkingLevelMetadata(model, true);
		expect(model.thinkingLevelMap).toMatchObject({ xhigh: "xhigh" });
		expect(model.compat).toMatchObject({ forceAdaptiveThinking: true, supportsTemperature: false });
	});

	it("keeps off hidden for Gemini 3 models even with a catalog map", () => {
		// Gemini 3 Pro/Flash cannot disable thinking; the send side falls back
		// to the lowest thinkingLevel, so an offered off would be a lie.
		const model = makeModel({ id: "gemini-3.1-pro-preview", api: "google-generative-ai", provider: "google" });
		model.thinkingLevelMap = { minimal: null, low: "low", medium: "medium", high: "high", xhigh: null };
		applyThinkingLevelMetadata(model, true);
		expect(model.thinkingLevelMap).toMatchObject({ off: null, low: "low" });

		const flash = makeModel({ id: "gemini-3-flash-preview", api: "google-generative-ai", provider: "google" });
		flash.thinkingLevelMap = { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null };
		applyThinkingLevelMetadata(flash, true);
		expect(flash.thinkingLevelMap).toMatchObject({ off: null, minimal: "minimal" });
	});

	it("keeps off hidden for Together gpt-oss models even with a catalog map", () => {
		// Together's gpt-oss endpoints accept no "none" effort; selecting off
		// would send no reasoning_effort and silently keep default reasoning.
		const model = makeModel({
			id: "openai/gpt-oss-120b",
			api: "openai-completions",
			provider: "together",
		});
		model.thinkingLevelMap = { minimal: null, low: "low", medium: "medium", high: "high", xhigh: null };
		applyThinkingLevelMetadata(model, true);
		expect(model.thinkingLevelMap).toMatchObject({ off: null, low: "low", high: "high" });
	});
});
