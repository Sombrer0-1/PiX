import { describe, expect, it } from "vitest";
import { tokenPricePerMillion } from "../scripts/generate-models.ts";
import { calculateCost, getModel, getModels } from "../src/models.ts";
import type { Usage } from "../src/types.ts";

describe("OpenRouter pricing", () => {
	it.each(["-1", "-0.5", "0", "", "unknown", "Infinity", undefined])("treats unknown price %s as zero", (price) => {
		expect(tokenPricePerMillion(price)).toBe(0);
	});
	it("converts a known token price to a rate per million", () => {
		expect(tokenPricePerMillion("0.0000025")).toBe(2.5);
	});
	it("ships finite nonnegative OpenRouter rates", () => {
		for (const model of getModels("openrouter")) {
			for (const rate of Object.values(model.cost)) {
				expect(Number.isFinite(rate), model.id).toBe(true);
				expect(rate, model.id).toBeGreaterThanOrEqual(0);
			}
		}
	});
	it.each(["openrouter/auto", "openrouter/auto-beta", "typesafe/jev-router"] as const)("does not credit unknown route %s", (id) => {
		const usage: Usage = {
			input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 2000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		calculateCost(getModel("openrouter", id), usage);
		expect(usage.cost.total).toBe(0);
	});
});
