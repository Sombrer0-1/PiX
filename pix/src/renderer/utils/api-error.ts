/**
 * API error classification (renderer-side mirror).
 *
 * This mirrors @earendil-works/pi-ai's classifyApiError so the renderer can
 * classify persisted error messages on history load without importing the
 * pi-ai root entry (which would pull Node-only providers into the browser
 * bundle). Keep in sync with packages/ai/src/utils/api-error.ts.
 */
import type { ApiErrorCategory } from "@/types/session";

export interface ClassifiedApiError {
	category: ApiErrorCategory;
	httpStatus?: number;
	title: string;
	retryable: boolean;
	rawMessage: string;
}

const STATUS_CODE_PATTERNS = [
	/\b(\d{3})\s+status code/i,
	/API error\s*\((\d{3})\)/i,
	/\bstatus[:\s]+(\d{3})/i,
	/\bHTTP\s*(\d{3})/i,
	/^(\d{3})\b/,
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

const QUOTA_PATTERN =
	/insufficient_quota|quota exceeded|out of budget|billing|available balance|GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached/i;

const AUTH_PATTERN =
	/\b401\b|\b403\b|unauthorized|forbidden|invalid[^.]*api.?key|authentication failed|permission denied/i;

const OVERLOADED_PATTERN = /overloaded|overloaded_error/i;

const SERVER_PATTERN =
	/\b500\b|\b502\b|\b503\b|\b504\b|service.?unavailable|internal.?server.?error|internal.?error|server.?error|bad.?gateway|gateway.?timeout|upstream.?error/i;

const RATE_LIMIT_PATTERN = /rate.?limit|too many requests|\b429\b/i;

const NETWORK_PATTERN =
	/network.?error|connection.?error|connection.?refused|connection.?lost|connection.?reset|fetch failed|socket hang up|upstream.?connect|reset before headers|ended without|stream ended before|http2 request did not get a response|timed.?out|timeout|terminated|websocket.?closed|websocket.?error|other side closed|ECONNRESET|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ERR_INTERNET_DISCONNECTED/i;

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

	return { category: "unknown", httpStatus, title: "请求失败", retryable: true, rawMessage };
}
