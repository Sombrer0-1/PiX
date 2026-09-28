/**
 * Fetch the model listing of a custom provider (settings UI "fetch models
 * from API" action, dsh discovery parity).
 *
 * Interrogates the OpenAI-compatible `GET {baseUrl}/models` endpoint only:
 * that is the one shape gateways, self-hosted servers and the official
 * endpoints agree on. Other protocols report that they cannot be listed so
 * the UI falls back to hand-entry rather than guessing a response shape.
 *
 * Robustness contract (ported from dsh discovery.ts):
 * - URL join treats baseUrl as a prefix (deployment paths keep their
 *   segments); trailing slashes are stripped.
 * - GET + accept: application/json; authorization: Bearer only when a key
 *   is available (an unauthenticated probe stays unauthenticated).
 * - Error taxonomy: could-not-reach / answered <status> (401/403 hint at the
 *   key) / not-JSON / oversized (>4MiB, checked via content-length first,
 *   then enforced on the bytes actually read).
 * - Reply entries without a usable id are skipped; duplicate ids keep the
 *   first occurrence (an intentional addition over dsh, which does not
 *   dedup); endpoint order is preserved.
 * - The API key never appears in any error message.
 *
 * Test seam: `deps.fetch` is injected (top-level imports only, mirroring
 * btw/side-question.ts); defaults to the Node global fetch.
 */

import type { CustomApi, FetchedProviderModel } from "../../shared/custom-providers.js";

/** User-facing failure; the message is safe to cross IPC (never embeds the key). */
export class ProviderModelsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProviderModelsError";
	}
}

/** APIs whose `GET /models` listing this module can read (bearer auth shape). */
export const LISTABLE_APIS: ReadonlySet<string> = new Set(["openai-completions", "openai-responses"]);

/** Replies larger than this are refused (a truncated listing is not parseable). */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Default probe timeout; bounds the ipc invoke from below. */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface FetchProviderModelsParams {
	baseUrl: string;
	api: CustomApi;
	/**
	 * Optional credential for the probe: a literal, or a `$ENV` / `${ENV}`
	 * reference (resolved here). Command values (`!cmd`) are rejected with a
	 * clear error instead of executed from a settings action.
	 */
	apiKey?: string;
	/** Caller cancellation (renderer navigation, dialog close). */
	signal?: AbortSignal;
	/** Defaults to 30s. */
	timeoutMs?: number;
}

/** Test seam: `fetch` is injectable so tests never touch the network. */
export interface FetchProviderModelsDeps {
	fetch?: typeof globalThis.fetch;
}

/** One entry of an OpenAI-compatible `GET /models` reply. */
interface ListingEntry {
	id?: unknown;
	/** Common gateway extensions; absent from the official listings. */
	name?: unknown;
	display_name?: unknown;
	context_window?: unknown;
	context_length?: unknown;
	max_tokens?: unknown;
	max_output_tokens?: unknown;
}

/** A positive integer field of a listing entry, or undefined when absent/unusable. */
function capacity(...candidates: readonly unknown[]): number | undefined {
	for (const candidate of candidates) {
		if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) return candidate;
	}
	return undefined;
}

/** A non-empty string field of a listing entry, or undefined. */
function label(...candidates: readonly unknown[]): string | undefined {
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	return undefined;
}

/** Join the endpoint base with the listing path, treating the base as a prefix. */
function listingUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/models`;
}

/**
 * Read a reply body, refusing one that outgrows the ceiling. A declared
 * content-length is checked first so an honest server is turned away without
 * transferring anything; the accumulated total enforces the bound for a
 * server that under-declares (or streams).
 */
async function readBounded(response: Response, url: string): Promise<string> {
	const oversized = (): ProviderModelsError =>
		new ProviderModelsError(`${url} 响应超过 4MiB 上限，已中止`);
	const declared = Number(response.headers.get("content-length") ?? Number.NaN);
	if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
		await response.body?.cancel();
		throw oversized();
	}
	// fetch always exposes a body stream on a 2xx Response; the null guard is defensive.
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES) throw oversized();
			chunks.push(value);
		}
	} finally {
		// Cancel after a drained or abandoned read settles without rejecting;
		// unobserved best-effort cleanup.
		await reader.cancel().catch(() => {});
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

/**
 * Read one listing reply. Entries without a usable id are skipped rather
 * than failing the whole interrogation; duplicate ids keep the first
 * occurrence; endpoint order is preserved.
 */
function readListing(body: unknown): FetchedProviderModel[] {
	const data = (body as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) {
		throw new ProviderModelsError('响应中没有 data 数组，无法解析模型列表；请手动添加模型');
	}
	const models: FetchedProviderModel[] = [];
	const seen = new Set<string>();
	for (const raw of data) {
		const entry = raw as ListingEntry | null;
		const id = label(entry?.id);
		if (id === undefined || seen.has(id)) continue;
		seen.add(id);
		const name = label(entry?.name, entry?.display_name);
		const contextWindow = capacity(entry?.context_window, entry?.context_length);
		const maxTokens = capacity(entry?.max_output_tokens, entry?.max_tokens);
		models.push({
			id,
			...(name === undefined ? {} : { name }),
			...(contextWindow === undefined ? {} : { contextWindow }),
			...(maxTokens === undefined ? {} : { maxTokens }),
		});
	}
	return models;
}

// --- probe credential resolution (kernel template parity) --------------------
// Ported from packages/coding-agent/src/core/resolve-config-value.ts
// (parseConfigValueTemplate/resolveTemplate) so a models.json apiKey resolves
// to the same literal the kernel would put on the wire: `$ENV` / `${ENV}`
// interpolate ANYWHERE in the value (mixed with literals), `$$` / `$!` escape
// a literal dollar/bang anywhere, a `$` followed by no name character is a
// literal dollar, and an empty env value counts as unset. One deliberate
// divergence: command values (`!cmd`) are refused, not executed — a settings
// probe must not run shell commands. Keep this parser in sync with the kernel.

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

function appendLiteral(parts: TemplatePart[], value: string): void {
	if (!value) return;
	const previous = parts[parts.length - 1];
	if (previous?.type === "literal") {
		previous.value += value;
		return;
	}
	parts.push({ type: "literal", value });
}

function parseProbeTemplate(config: string): TemplatePart[] {
	const parts: TemplatePart[] = [];
	let index = 0;
	while (index < config.length) {
		const dollarIndex = config.indexOf("$", index);
		if (dollarIndex < 0) {
			appendLiteral(parts, config.slice(index));
			break;
		}
		appendLiteral(parts, config.slice(index, dollarIndex));
		const nextChar = config[dollarIndex + 1];
		if (nextChar === "$" || nextChar === "!") {
			appendLiteral(parts, nextChar);
			index = dollarIndex + 2;
			continue;
		}
		if (nextChar === "{") {
			const endIndex = config.indexOf("}", dollarIndex + 2);
			if (endIndex < 0) {
				appendLiteral(parts, "$");
				index = dollarIndex + 1;
				continue;
			}
			const name = config.slice(dollarIndex + 2, endIndex);
			if (ENV_VAR_NAME_RE.test(name)) {
				parts.push({ type: "env", name });
			} else {
				appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
			}
			index = endIndex + 1;
			continue;
		}
		const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
		if (match) {
			parts.push({ type: "env", name: match[0] });
			index = dollarIndex + 1 + match[0].length;
			continue;
		}
		appendLiteral(parts, "$");
		index = dollarIndex + 1;
	}
	return parts;
}

/**
 * Resolve a probe credential. Accepts literals and the `$ENV` / `${ENV}`
 * template forms models.json documents (kernel semantics, see the parser
 * note above); command values (`!cmd`) are refused (a settings action must
 * not execute shell commands), and a resolved value no HTTP header can carry
 * is rejected here instead of surfacing as a network failure.
 */
export function resolveApiKeyForProbe(raw: string): string {
	const value = raw.trim();
	if (value === "") {
		throw new ProviderModelsError("密钥为空，无法用于认证；请填写密钥或留空以匿名探测");
	}
	if (value.startsWith("!")) {
		throw new ProviderModelsError("密钥为命令形式（!cmd），无法用于获取模型列表；请在设置中临时粘贴明文密钥");
	}
	const resolved: string[] = [];
	const missing: string[] = [];
	for (const part of parseProbeTemplate(value)) {
		if (part.type === "literal") {
			resolved.push(part.value);
			continue;
		}
		// Kernel parity: an empty env value counts as unset (`process.env[n] || undefined`).
		const envValue = process.env[part.name] || undefined;
		if (envValue === undefined) {
			if (!missing.includes(part.name)) missing.push(part.name);
			continue;
		}
		resolved.push(envValue);
	}
	if (missing.length > 0) {
		throw new ProviderModelsError(`密钥引用的环境变量 ${missing.join("、")} 未设置`);
	}
	const literal = resolved.join("");
	// dsh parity (\x21-\x7e): printable ASCII without the space.
	if (!/^[\x21-\x7e]+$/.test(literal)) {
		throw new ProviderModelsError("密钥包含 HTTP 头无法承载的字符，请检查密钥内容");
	}
	return literal;
}

/**
 * Interrogate one custom provider endpoint for the models it advertises.
 * @returns the advertised models in endpoint order.
 * @throws ProviderModelsError with a user-facing (Chinese, key-free) message
 *   when the protocol has no readable listing, the endpoint refuses or fails
 *   the request, or the reply is not a model listing.
 */
export async function fetchProviderModels(
	params: FetchProviderModelsParams,
	deps?: FetchProviderModelsDeps,
): Promise<{ models: FetchedProviderModel[] }> {
	if (!LISTABLE_APIS.has(params.api)) {
		throw new ProviderModelsError(`API 类型「${params.api}」暂不支持自动获取模型列表，请手动添加模型`);
	}
	const baseUrl = params.baseUrl.trim();
	if (baseUrl === "") {
		throw new ProviderModelsError("baseUrl 为空，请先填写 baseUrl");
	}
	const url = listingUrl(baseUrl);
	const apiKey = params.apiKey === undefined ? undefined : resolveApiKeyForProbe(params.apiKey);

	// Merge the caller's signal with the timeout into one controller. The
	// caller-aborted and timed-out cases are distinguished by flags so the
	// error taxonomy never blames the network for a local cancellation.
	const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const controller = new AbortController();
	let timedOut = false;
	const onCallerAbort = (): void => {
		controller.abort();
	};
	if (params.signal?.aborted) {
		controller.abort();
	} else {
		params.signal?.addEventListener("abort", onCallerAbort, { once: true });
	}
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	try {
		let response: Response;
		try {
			response = await (deps?.fetch ?? globalThis.fetch)(url, {
				method: "GET",
				headers: {
					accept: "application/json",
					...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
				},
				signal: controller.signal,
			});
		} catch (error: unknown) {
			if (params.signal?.aborted) {
				throw new ProviderModelsError("已取消获取模型列表");
			}
			if (timedOut) {
				throw new ProviderModelsError(`请求 ${url} 超时（${Math.round(timeoutMs / 1000)} 秒）`);
			}
			// Undici reports "fetch failed" with the DNS/ETIMEDOUT code on
			// .cause; surface it when present. Never includes the key.
			const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
			throw new ProviderModelsError(`无法连接 ${url}${cause ? `（${cause}）` : ""}`);
		}
		if (!response.ok) {
			throw new ProviderModelsError(
				`${url} 返回 HTTP ${response.status}${response.status === 401 || response.status === 403 ? "；请检查 API Key 是否有效" : ""}`,
			);
		}
		let text: string;
		try {
			text = await readBounded(response, url);
		} catch (error: unknown) {
			// Cancellation during the body read gets the same coded failure it
			// would have for a cancellation before the request went out.
			if (params.signal?.aborted) {
				throw new ProviderModelsError("已取消获取模型列表");
			}
			if (timedOut) {
				throw new ProviderModelsError(`请求 ${url} 超时（${Math.round(timeoutMs / 1000)} 秒）`);
			}
			throw error;
		}
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			throw new ProviderModelsError(`${url} 未返回 JSON 格式的模型列表`);
		}
		return { models: readListing(body) };
	} finally {
		clearTimeout(timer);
		params.signal?.removeEventListener("abort", onCallerAbort);
	}
}
