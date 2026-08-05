import { describe, expect, it } from "vitest";
import { classifyApiError } from "../src/utils/api-error.ts";

describe("classifyApiError", () => {
	describe("HTTP status code extraction", () => {
		it("extracts status from Anthropic 'N status code' format", () => {
			expect(classifyApiError("529 status code (no body)").httpStatus).toBe(529);
			expect(classifyApiError("429 status code (no body)").httpStatus).toBe(429);
		});

		it("extracts status from OpenAI/Mistral 'API error (N)' format", () => {
			expect(classifyApiError("OpenAI API error (429): Too many requests").httpStatus).toBe(429);
			expect(classifyApiError("Mistral API error (403): Forbidden").httpStatus).toBe(403);
			expect(classifyApiError("Azure OpenAI API error (500): Internal").httpStatus).toBe(500);
		});

		it("extracts status from 'status: N' and leading 'N ' formats", () => {
			expect(classifyApiError("Request failed with status: 503").httpStatus).toBe(503);
			expect(classifyApiError("502 Bad Gateway").httpStatus).toBe(502);
		});

		it("returns undefined when no recognizable status code is present", () => {
			expect(classifyApiError("fetch failed").httpStatus).toBeUndefined();
			expect(classifyApiError("socket hang up").httpStatus).toBeUndefined();
		});

		it("ignores non-HTTP 3-digit numbers (e.g. token counts)", () => {
			// 6-digit token counts must not be mistaken for status codes
			const result = classifyApiError("prompt is too long: 213462 tokens > 200000 maximum");
			expect(result.httpStatus).toBeUndefined();
		});
	});

	describe("quota / billing", () => {
		it("classifies insufficient_quota as non-retryable quota", () => {
			const result = classifyApiError("OpenAI API error (429): insufficient_quota");
			expect(result.category).toBe("quota");
			expect(result.retryable).toBe(false);
			expect(result.httpStatus).toBe(429);
		});

		it("classifies billing/balance errors as quota", () => {
			const result = classifyApiError("available balance is 0; billing required");
			expect(result.category).toBe("quota");
			expect(result.retryable).toBe(false);
		});

		it("classifies GoUsageLimitError as quota", () => {
			const result = classifyApiError("GoUsageLimitError: monthly limit reached");
			expect(result.category).toBe("quota");
			expect(result.retryable).toBe(false);
		});
	});

	describe("auth", () => {
		it("classifies 403 as non-retryable auth", () => {
			const result = classifyApiError("Mistral API error (403): Forbidden");
			expect(result.category).toBe("auth");
			expect(result.retryable).toBe(false);
			expect(result.httpStatus).toBe(403);
		});

		it("classifies 401 as non-retryable auth", () => {
			const result = classifyApiError("401 Unauthorized");
			expect(result.category).toBe("auth");
			expect(result.retryable).toBe(false);
			expect(result.httpStatus).toBe(401);
		});

		it("classifies invalid api key text as auth", () => {
			const result = classifyApiError("invalid api key provided");
			expect(result.category).toBe("auth");
			expect(result.retryable).toBe(false);
		});
	});

	describe("overloaded", () => {
		it("classifies 529 as retryable overloaded", () => {
			const result = classifyApiError("529 status code (no body)");
			expect(result.category).toBe("overloaded");
			expect(result.retryable).toBe(true);
			expect(result.httpStatus).toBe(529);
		});

		it("classifies overloaded_error text as overloaded", () => {
			const result = classifyApiError("overloaded_error");
			expect(result.category).toBe("overloaded");
			expect(result.retryable).toBe(true);
		});
	});

	describe("server errors", () => {
		it("classifies 500/502/503/504 as retryable server", () => {
			for (const code of [500, 502, 503, 504]) {
				const result = classifyApiError(`API error (${code}): server fault`);
				expect(result.category).toBe("server");
				expect(result.retryable).toBe(true);
				expect(result.httpStatus).toBe(code);
			}
		});

		it("classifies 'service unavailable' text as server", () => {
			const result = classifyApiError("Service unavailable: upstream error");
			expect(result.category).toBe("server");
			expect(result.retryable).toBe(true);
		});
	});

	describe("rate limit (transient)", () => {
		it("classifies a plain 429 as retryable rate_limit", () => {
			const result = classifyApiError("429 Too Many Requests");
			expect(result.category).toBe("rate_limit");
			expect(result.retryable).toBe(true);
			expect(result.httpStatus).toBe(429);
		});

		it("classifies 'rate limit' text as rate_limit", () => {
			const result = classifyApiError("rate limit exceeded, retry later");
			expect(result.category).toBe("rate_limit");
			expect(result.retryable).toBe(true);
		});
	});

	describe("network", () => {
		it("classifies connection lost as retryable network", () => {
			const result = classifyApiError("connection lost");
			expect(result.category).toBe("network");
			expect(result.retryable).toBe(true);
		});

		it("classifies fetch failed as retryable network", () => {
			const result = classifyApiError("fetch failed");
			expect(result.category).toBe("network");
			expect(result.retryable).toBe(true);
		});

		it("classifies socket hang up as retryable network", () => {
			const result = classifyApiError("socket hang up");
			expect(result.category).toBe("network");
			expect(result.retryable).toBe(true);
		});

		it("classifies timeout as retryable network", () => {
			const result = classifyApiError("Request timed out after 60000ms");
			expect(result.category).toBe("network");
			expect(result.retryable).toBe(true);
		});
	});

	describe("unknown", () => {
		it("classifies unrecognized errors as retryable unknown", () => {
			const result = classifyApiError("some weird unclassified error");
			expect(result.category).toBe("unknown");
			expect(result.retryable).toBe(true);
		});
	});

	describe("title", () => {
		it("provides a localized title for each category", () => {
			expect(classifyApiError("529 status code").title).toBe("服务过载");
			expect(classifyApiError("403 Forbidden").title).toBe("认证失败");
			expect(classifyApiError("fetch failed").title).toBe("网络错误");
			expect(classifyApiError("429 Too Many Requests").title).toBe("请求限流");
			expect(classifyApiError("insufficient_quota").title).toBe("配额超限");
			expect(classifyApiError("503 service unavailable").title).toBe("服务器错误");
		});

		it("preserves the original message in rawMessage", () => {
			const raw = "529 status code (no body)";
			expect(classifyApiError(raw).rawMessage).toBe(raw);
		});
	});
});
