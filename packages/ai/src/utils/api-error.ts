import type { ApiErrorInfo } from "../types.ts";

/**
 * API error classification.
 *
 * Providers embed HTTP status codes and provider-specific error text inside the
 * `errorMessage` string on a failed AssistantMessage (stopReason "error"). This
 * module parses that string into a structured classification so the UI can show
 * a readable status badge and decide whether a manual retry makes sense.
 *
 * This is intentionally string-based (no AssistantMessage dependency) so it can
 * run anywhere - main process event emission, renderer display, tests.
 *
 * Classification is independent of the auto-retry decision in AgentSession
 * (`_isRetryableError`): auto-retry is conservative (don't waste requests on
 * uncertain errors), while the manual-retry affordance is permissive (let the
 * user decide). The two may disagree on edge cases by design.
 */

export type ApiErrorCategory =
	| "auth"
	| "quota"
	| "overloaded"
	| "server"
	| "rate_limit"
	| "network"
	| "unknown";

export interface ClassifiedApiError {
	category: ApiErrorCategory;
	/** Parsed HTTP status code, if one is recognizable in the message. */
	httpStatus?: number;
	/** Short localized label for the badge/header, e.g. "服务过载". */
	title: string;
	/** Whether offering a manual retry button is worthwhile. */
	retryable: boolean;
	/** The original, unmodified error message. */
	rawMessage: string;
}

/**
 * Patterns that extract a 3-digit HTTP status code from provider error strings.
 * Ordered most-specific first. Only 4xx/5xx codes are accepted.
 */
const STATUS_CODE_PATTERNS = [
	/\b(\d{3})\s+status code/i, // Anthropic: "529 status code (no body)"
	/API error\s*\((\d{3})\)/i, // OpenAI / Mistral / Azure: "OpenAI API error (429)"
	/\bstatus[:\s]+(\d{3})/i, // "status: 429" / "status 429"
	/\bHTTP\s*(\d{3})/i, // "HTTP 429"
	/^(\d{3})\b/, // leading "429 ..."
];

function extractHttpStatus(message: string): number | undefined {
	for (const pattern of STATUS_CODE_PATTERNS) {
		const match = message.match(pattern);
		if (match) {
			const code = Number.parseInt(match[1], 10);
			if (code >= 400 && code <= 599) return code;
		}
	}
	return undefined;
}

// Quota / billing - never retryable (retrying cannot create more quota).
const QUOTA_PATTERN =
	/insufficient_quota|quota exceeded|out of budget|billing|available balance|GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached/i;

// Auth - never retryable (user must fix credentials).
const AUTH_PATTERN =
	/\b401\b|\b403\b|unauthorized|forbidden|invalid[^.]*api.?key|authentication failed|permission denied/i;

// Overloaded (Anthropic 529 and equivalents).
const OVERLOADED_PATTERN = /overloaded|overloaded_error/i;

// Server errors (5xx, excluding 529 which is overloaded).
const SERVER_PATTERN =
	/\b500\b|\b502\b|\b503\b|\b504\b|service.?unavailable|internal.?server.?error|internal.?error|server.?error|bad.?gateway|gateway.?timeout|upstream.?error/i;

// Transient rate limiting (429 without quota/billing intent).
const RATE_LIMIT_PATTERN = /rate.?limit|too many requests|\b429\b/i;

// Network / transport failures.
const NETWORK_PATTERN =
	/network.?error|connection.?error|connection.?refused|connection.?lost|connection.?reset|fetch failed|socket hang up|upstream.?connect|reset before headers|ended without|stream ended before|http2 request did not get a response|timed.?out|timeout|terminated|websocket.?closed|websocket.?error|other side closed|ECONNRESET|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ERR_INTERNET_DISCONNECTED/i;

/**
 * Classify a provider error message into a structured category.
 *
 * Order matters: quota is checked before rate_limit because a 429 may carry
 * quota/billing text (e.g. "insufficient_quota"); auth is checked before
 * generic patterns so 401/403 never become "unknown".
 */
export function classifyApiError(errorMessage: string): ClassifiedApiError {
	const rawMessage = errorMessage;
	const httpStatus = extractHttpStatus(errorMessage);

	if (QUOTA_PATTERN.test(errorMessage)) {
		return { category: "quota", httpStatus, title: "配额超限", retryable: false, rawMessage };
	}

	if (httpStatus === 401 || httpStatus === 403 || AUTH_PATTERN.test(errorMessage)) {
		const status = httpStatus ?? (/\b403\b/.test(errorMessage) ? 403 : /\b401\b/.test(errorMessage) ? 401 : undefined);
		return { category: "auth", httpStatus: status, title: "认证失败", retryable: false, rawMessage };
	}

	if (httpStatus === 529 || OVERLOADED_PATTERN.test(errorMessage)) {
		return { category: "overloaded", httpStatus: httpStatus ?? 529, title: "服务过载", retryable: true, rawMessage };
	}

	if ((httpStatus !== undefined && httpStatus >= 500) || SERVER_PATTERN.test(errorMessage)) {
		return { category: "server", httpStatus, title: "服务器错误", retryable: true, rawMessage };
	}

	if (httpStatus === 429 || RATE_LIMIT_PATTERN.test(errorMessage)) {
		return { category: "rate_limit", httpStatus: httpStatus ?? 429, title: "请求限流", retryable: true, rawMessage };
	}

	if (NETWORK_PATTERN.test(errorMessage)) {
		return { category: "network", httpStatus, title: "网络错误", retryable: true, rawMessage };
	}

	// Unclassified - offer a retry so the user can decide. Most unrecognized
	// errors in practice are transient; a rare non-retryable 4xx will simply
	// fail again on retry, which is a tolerable edge case.
	return { category: "unknown", httpStatus, title: "请求失败", retryable: true, rawMessage };
}

function readHeader(headers: unknown, name: string): string | undefined {
	if (headers === null || headers === undefined || typeof headers !== "object") {
		return undefined;
	}

	if ("get" in headers && typeof headers.get === "function") {
		const value = (headers as { get: (key: string) => unknown }).get(name);
		return typeof value === "string" ? value : undefined;
	}

	const target = name.toLowerCase();
	for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
		if (key.toLowerCase() === target && typeof value === "string") {
			return value;
		}
	}
	return undefined;
}

function parseRetryAfterHeader(retryAfter: string | undefined): number | undefined {
	if (retryAfter === undefined || retryAfter.trim() === "") {
		return undefined;
	}

	const seconds = Number(retryAfter);
	// Integer seconds only. Fractional values ("2.5") and HTTP-dates both parse as
	// finite numbers; HTTP-dates are NaN via Number() and fall through to Date.parse.
	// Fractions are rejected so turn-level parsing stays conservative; Codex request-
	// level retry restores the historical Number()*1000 path in toCodexRetryAfterDelayMs.
	if (Number.isFinite(seconds) && Number.isInteger(seconds)) {
		const millis = seconds * 1000;
		return millis < 0 ? undefined : millis;
	}

	const date = Date.parse(retryAfter);
	if (!Number.isNaN(date)) {
		const millis = date - Date.now();
		return millis < 0 ? undefined : millis;
	}

	return undefined;
}

/** Parse Retry-After style delays from Headers instances or header records. */
export function extractRetryAfterMs(headers: unknown): number | undefined {
	const retryAfterMs = readHeader(headers, "retry-after-ms");
	if (retryAfterMs !== undefined && retryAfterMs.trim() !== "") {
		const millis = Number(retryAfterMs);
		// A finite retry-after-ms, including negative, short-circuits retry-after.
		if (Number.isFinite(millis)) {
			return millis < 0 ? undefined : millis;
		}
	}
	return parseRetryAfterHeader(readHeader(headers, "retry-after"));
}

/** Extract ApiErrorInfo from thrown SDK errors (duck-typed: { status, headers, requestID }). */
export function extractApiErrorInfo(error: unknown): ApiErrorInfo | undefined {
	if (typeof error !== "object" || error === null) {
		return undefined;
	}

	const candidate = error as {
		status?: unknown;
		headers?: unknown;
		requestID?: unknown;
		request_id?: unknown;
	};

	const info: ApiErrorInfo = {};
	// Only persist recognizable HTTP statuses. Relays sometimes surface status 0
	// for a connection failure; treating that as structured would skip the
	// message-pattern fallback in AgentSession.
	if (
		typeof candidate.status === "number" &&
		Number.isFinite(candidate.status) &&
		candidate.status >= 400 &&
		candidate.status <= 599
	) {
		info.status = candidate.status;
	}

	const retryAfterMs = extractRetryAfterMs(candidate.headers);
	if (retryAfterMs !== undefined) {
		info.retryAfterMs = retryAfterMs;
	}

	const requestId = candidate.requestID ?? candidate.request_id;
	if (typeof requestId === "string" && requestId.length > 0) {
		info.requestId = requestId;
	}

	if (info.status === undefined && info.retryAfterMs === undefined && info.requestId === undefined) {
		return undefined;
	}
	return info;
}
