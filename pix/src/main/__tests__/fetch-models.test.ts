/**
 * Fetch-models (/models listing probe) tests.
 *
 * Covers fetchProviderModels against an injected fake fetch (deps seam, no
 * network): URL joining (trailing slashes, prefix paths), the protocol gate,
 * the error taxonomy (unreachable / HTTP status with and without the key hint
 * / non-JSON / no data array), the 4MiB ceiling (declared content-length and
 * accumulated bytes), field mapping (context_window|context_length,
 * max_output_tokens|max_tokens, name|display_name, positive-integer filter),
 * id-required skip + dedupe + endpoint order, credential resolution ($ENV,
 * !cmd refusal, $$/$! escapes, header-unsafe rejection) and header presence,
 * caller abort, and the timeout path.
 *
 * Run with: npx tsx pix/src/main/__tests__/fetch-models.test.ts
 */

import { fetchProviderModels, resolveApiKeyForProbe, LISTABLE_APIS } from "../providers/fetch-models.js";
import type { FetchProviderModelsDeps } from "../providers/fetch-models.js";

// ============================================================================
// Test harness (matches side-question.test.ts style)
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		passed++;
		console.log(`  PASS: ${message}`);
	} else {
		failed++;
		console.error(`  FAIL: ${message}`);
	}
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
	if (actual === expected) {
		passed++;
		console.log(`  PASS: ${message}`);
	} else {
		failed++;
		console.error(`  FAIL: ${message} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

async function run(name: string, fn: () => Promise<void>): Promise<void> {
	console.log(`\n=== ${name} ===\n`);
	try {
		await fn();
	} catch (err) {
		failed++;
		console.error(`  FAIL: ${name} threw unexpectedly: ${String(err)}`);
	}
}

/** Extract the message of whatever fetchProviderModels threw. */
async function errorMessage(fn: () => Promise<unknown>): Promise<string> {
	try {
		await fn();
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
	return "";
}

// ============================================================================
// Fixtures
// ============================================================================

interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
	signal: AbortSignal | undefined;
}

type Scripted = (url: string) => Response | Promise<Response>;

/** Fake fetch capturing url/headers/signal, answering from `scripted`. */
function makeFetch(scripted: Scripted): { deps: FetchProviderModelsDeps; captured: CapturedRequest[] } {
	const captured: CapturedRequest[] = [];
	const deps: FetchProviderModelsDeps = {
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			captured.push({
				url,
				headers: (init?.headers as Record<string, string> | undefined) ?? {},
				signal: init?.signal ?? undefined,
			});
			return scripted(url);
		}) as typeof globalThis.fetch,
	};
	return { deps, captured };
}

/** Fake fetch that never answers; rejects with an abort-style error once the signal fires. */
function makeHangingFetch(): { deps: FetchProviderModelsDeps; captured: CapturedRequest[] } {
	const captured: CapturedRequest[] = [];
	const deps: FetchProviderModelsDeps = {
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			captured.push({
				url,
				headers: (init?.headers as Record<string, string> | undefined) ?? {},
				signal: init?.signal ?? undefined,
			});
			return new Promise<Response>((_, reject) => {
				const signal = init?.signal;
				if (signal?.aborted) {
					reject(new Error("This operation was aborted"));
					return;
				}
				signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")), { once: true });
			});
		}) as typeof globalThis.fetch,
	};
	return { deps, captured };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

function statusResponse(status: number): Response {
	return new Response("nope", { status });
}

/** A stream that enqueues `sizes` zero-filled chunks then closes. */
function chunkedStream(sizes: number[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const size of sizes) controller.enqueue(new Uint8Array(size));
			controller.close();
		},
	});
}

/** A stream whose chunks concatenate to `text`. */
function textStream(text: string, splitAt: number[]): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	const cuts = [0, ...splitAt.filter((at) => at > 0 && at < bytes.length), bytes.length];
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (let i = 0; i + 1 < cuts.length; i++) {
				controller.enqueue(bytes.slice(cuts[i], cuts[i + 1]));
			}
			controller.close();
		},
	});
}

const BASE = "https://relay.example.com/v1";
const MIB = 1024 * 1024;

// ============================================================================
// Tests
// ============================================================================

await run("URL joining: trailing slashes stripped, prefix path preserved", async () => {
	const { deps, captured } = makeFetch(() => jsonResponse({ data: [] }));
	await fetchProviderModels({ baseUrl: `${BASE}//`, api: "openai-completions" }, deps);
	assertEqual(captured[0]?.url, `${BASE}/models`, "trailing slashes collapsed onto /models");

	const { deps: deps2, captured: captured2 } = makeFetch(() => jsonResponse({ data: [] }));
	await fetchProviderModels({ baseUrl: "https://gateway.example.com/openai/v1/", api: "openai-responses" }, deps2);
	assertEqual(captured2[0]?.url, "https://gateway.example.com/openai/v1/models", "deployment path kept its segments");
});

await run("protocol gate: non-listable APIs refused before any fetch", async () => {
	for (const api of ["anthropic-messages", "google-generative-ai"] as const) {
		const { deps, captured } = makeFetch(() => jsonResponse({ data: [] }));
		const message = await errorMessage(() =>
			fetchProviderModels({ baseUrl: BASE, api }, deps),
		);
		assert(message.includes(api) && message.includes("不支持自动获取"), `${api}: refusal message names the api`);
		assert(!message.includes(BASE), `${api}: refusal is local, no url blamed`);
		assertEqual(captured.length, 0, `${api}: fetch not called`);
	}
	assert(LISTABLE_APIS.has("openai-completions") && LISTABLE_APIS.has("openai-responses"), "listable set contents");
});

await run("guards: empty baseUrl refused", async () => {
	const { deps, captured } = makeFetch(() => jsonResponse({ data: [] }));
	const message = await errorMessage(() => fetchProviderModels({ baseUrl: "   ", api: "openai-completions" }, deps));
	assert(message.includes("baseUrl"), "message names baseUrl");
	assertEqual(captured.length, 0, "fetch not called");
});

await run("error taxonomy: HTTP status with and without the key hint", async () => {
	const cases: Array<[number, RegExp]> = [
		[401, /HTTP 401；请检查 API Key 是否有效/],
		[403, /HTTP 403；请检查 API Key 是否有效/],
		[404, /HTTP 404$/],
		[500, /HTTP 500$/],
	];
	for (const [status, pattern] of cases) {
		const { deps } = makeFetch(() => statusResponse(status));
		const message = await errorMessage(() =>
			fetchProviderModels({ baseUrl: BASE, api: "openai-completions", apiKey: "sk-secret-value" }, deps),
		);
		assert(pattern.test(message), `HTTP ${status}: message "${message}" matches ${pattern}`);
		assert(!message.includes("sk-secret-value"), `HTTP ${status}: key absent from message`);
	}
});

await run("error taxonomy: unreachable endpoint surfaces the cause", async () => {
	const { deps } = makeFetch(() => {
		const err = new Error("fetch failed");
		(err as Error & { cause?: Error }).cause = new Error("getaddrinfo ENOTFOUND relay.example.com");
		throw err;
	});
	const message = await errorMessage(() => fetchProviderModels({ baseUrl: BASE, api: "openai-completions" }, deps));
	assert(message.startsWith(`无法连接 ${BASE}/models`), "message blames the url");
	assert(message.includes("ENOTFOUND"), "cause detail surfaced");
});

await run("error taxonomy: non-JSON body", async () => {
	const { deps } = makeFetch(() => new Response("<html>login page</html>", { status: 200 }));
	const message = await errorMessage(() => fetchProviderModels({ baseUrl: BASE, api: "openai-completions" }, deps));
	assert(message.includes("未返回 JSON"), `message: ${message}`);
});

await run("error taxonomy: reply without a data array", async () => {
	const { deps } = makeFetch(() => jsonResponse({ object: "list", models: [] }));
	const message = await errorMessage(() => fetchProviderModels({ baseUrl: BASE, api: "openai-completions" }, deps));
	assert(message.includes("data 数组"), `message: ${message}`);
});

await run("4MiB ceiling: declared content-length refused without transfer", async () => {
	const { deps } = makeFetch(
		() => new Response(chunkedStream([8 * MIB]), { headers: { "content-length": String(8 * MIB) } }),
	);
	const message = await errorMessage(() => fetchProviderModels({ baseUrl: BASE, api: "openai-completions" }, deps));
	assert(message.includes("4MiB"), `message: ${message}`);
});

await run("4MiB ceiling: under-declared body refused on accumulated bytes", async () => {
	const { deps } = makeFetch(() => new Response(chunkedStream([2 * MIB, 2 * MIB, 2 * MIB])));
	const message = await errorMessage(() => fetchProviderModels({ baseUrl: BASE, api: "openai-completions" }, deps));
	assert(message.includes("4MiB"), `message: ${message}`);
});

await run("field mapping: names, capacities, filters", async () => {
	const listing = {
		data: [
			{
				id: "m-1",
				name: "Display One",
				context_window: 128000,
				max_output_tokens: 8192,
			},
			{
				id: "m-2",
				display_name: "Display Two",
				context_length: 64000,
				max_tokens: 4096,
			},
			{
				id: "m-3",
				// Zero / negative / fractional / string capacities are unusable.
				context_window: 0,
				context_length: -5,
				max_output_tokens: 1.5,
				max_tokens: "4096",
			},
		],
	};
	const { deps } = makeFetch(() => jsonResponse(listing));
	const { models } = await fetchProviderModels({ baseUrl: BASE, api: "openai-completions" }, deps);
	assertEqual(models.length, 3, "three entries parsed");
	assertEqual(models[0]?.name, "Display One", "name field read");
	assertEqual(models[0]?.contextWindow, 128000, "context_window read");
	assertEqual(models[0]?.maxTokens, 8192, "max_output_tokens read");
	assertEqual(models[1]?.name, "Display Two", "display_name fallback");
	assertEqual(models[1]?.contextWindow, 64000, "context_length fallback");
	assertEqual(models[1]?.maxTokens, 4096, "max_tokens fallback");
	assertEqual(models[2]?.contextWindow, undefined, "unusable context fields dropped");
	assertEqual(models[2]?.maxTokens, undefined, "unusable max-token fields dropped");
});

await run("listing hygiene: missing id skipped, duplicate ids deduped, order preserved", async () => {
	const listing = {
		data: [
			{ name: "no id" },
			{ id: "a" },
			{ id: "b" },
			{ id: "a", name: "duplicate a" },
			{ id: "" },
			{ id: "c" },
		],
	};
	const { deps } = makeFetch(() => jsonResponse(listing));
	const { models } = await fetchProviderModels({ baseUrl: BASE, api: "openai-completions" }, deps);
	assertEqual(
		models.map((m) => m.id).join(","),
		"a,b,c",
		"no-id and empty-id rows skipped, first duplicate kept, endpoint order preserved",
	);
	assertEqual(models[0]?.name, undefined, "first occurrence won the id");
});

await run("credential: header present with a key, absent without", async () => {
	const withKey = makeFetch(() => jsonResponse({ data: [] }));
	await fetchProviderModels({ baseUrl: BASE, api: "openai-completions", apiKey: "sk-probe" }, withKey.deps);
	assertEqual(withKey.captured[0]?.headers.authorization, "Bearer sk-probe", "authorization sent");
	assertEqual(withKey.captured[0]?.headers.accept, "application/json", "accept header sent");

	const withoutKey = makeFetch(() => jsonResponse({ data: [] }));
	await fetchProviderModels({ baseUrl: BASE, api: "openai-completions" }, withoutKey.deps);
	assertEqual(withoutKey.captured[0]?.headers.authorization, undefined, "no authorization header without a key");
});

await run("credential: $ENV resolved, missing env named", async () => {
	process.env["PIX_TEST_PROBE_KEY"] = "sk-from-env";
	try {
		const { deps, captured } = makeFetch(() => jsonResponse({ data: [] }));
		await fetchProviderModels({ baseUrl: BASE, api: "openai-completions", apiKey: "$PIX_TEST_PROBE_KEY" }, deps);
		assertEqual(captured[0]?.headers.authorization, "Bearer sk-from-env", "$ENV form resolved");

		const braced = makeFetch(() => jsonResponse({ data: [] }));
		await fetchProviderModels({ baseUrl: BASE, api: "openai-completions", apiKey: "${PIX_TEST_PROBE_KEY}" }, braced.deps);
		assertEqual(braced.captured[0]?.headers.authorization, "Bearer sk-from-env", "${ENV} form resolved");

		const missing = await errorMessage(() => resolveApiKeyForProbe("$PIX_TEST_PROBE_MISSING"));
		assert(missing.includes("PIX_TEST_PROBE_MISSING") && missing.includes("未设置"), `missing env named: ${missing}`);
	} finally {
		delete process.env["PIX_TEST_PROBE_KEY"];
	}
});

await run("credential: !cmd refused, $$/$! escapes, header-unsafe rejected", async () => {
	const cmd = await errorMessage(() => resolveApiKeyForProbe("!op read secret"));
	assert(cmd.includes("!cmd"), `!cmd refused: ${cmd}`);

	assertEqual(resolveApiKeyForProbe("$$literal-dollar"), "$literal-dollar", "$$ escapes a literal dollar");
	assertEqual(resolveApiKeyForProbe("$!literal-bang"), "!literal-bang", "$! escapes a literal bang");

	const unsafe = await errorMessage(() => resolveApiKeyForProbe("sk-bad\nHeader: x"));
	assert(unsafe.includes("HTTP 头无法承载"), `unsafe key rejected: ${unsafe}`);
	const nonAscii = await errorMessage(() => resolveApiKeyForProbe("sk-密钥"));
	assert(nonAscii.includes("HTTP 头无法承载"), `non-ascii key rejected: ${nonAscii}`);

	const { deps, captured } = makeFetch(() => jsonResponse({ data: [] }));
	const refused = await errorMessage(() =>
		fetchProviderModels({ baseUrl: BASE, api: "openai-completions", apiKey: "!op read secret" }, deps),
	);
	assert(refused.includes("!cmd"), "!cmd refused end-to-end");
	assertEqual(captured.length, 0, "fetch not called for a refused key");
});

await run("credential: kernel template parity ($ENV embedded, escapes mid-string)", async () => {
	process.env["PIX_TEST_PROBE_KEY"] = "sk-from-env";
	try {
		// Embedded braced / bare-name templates resolve like resolve-config-value.ts.
		assertEqual(resolveApiKeyForProbe("sk-${PIX_TEST_PROBE_KEY}"), "sk-sk-from-env", "embedded ${ENV} interpolated");
		assertEqual(resolveApiKeyForProbe("sk-$PIX_TEST_PROBE_KEY"), "sk-sk-from-env", "bare $ENV consumes the name");
		assertEqual(resolveApiKeyForProbe("${PIX_TEST_PROBE_KEY}-suffix"), "sk-from-env-suffix", "leading template with literal tail");
		// Escapes work mid-string, not only at the start.
		assertEqual(resolveApiKeyForProbe("a$$b$!c"), "a$b!c", "$$/$! escape anywhere");
		// A lone $ with no name character behind it stays literal (kernel parity).
		assertEqual(resolveApiKeyForProbe("abc$"), "abc$", "trailing lone $ is literal");
		assertEqual(resolveApiKeyForProbe("$${A"), "${A", "unterminated brace after escape is literal");
		// Empty env value counts as unset (kernel: process.env[n] || undefined).
		process.env["PIX_TEST_PROBE_EMPTY"] = "";
		const empty = await errorMessage(() => resolveApiKeyForProbe("$PIX_TEST_PROBE_EMPTY"));
		assert(empty.includes("PIX_TEST_PROBE_EMPTY") && empty.includes("未设置"), `empty env counts as missing: ${empty}`);
		delete process.env["PIX_TEST_PROBE_EMPTY"];
		// Missing env inside a template names the variable.
		const missing = await errorMessage(() => resolveApiKeyForProbe("pre-${PIX_TEST_PROBE_MISSING}-post"));
		assert(missing.includes("PIX_TEST_PROBE_MISSING") && missing.includes("未设置"), `embedded missing env named: ${missing}`);
		// Header-safety is judged on the RESOLVED value, not the raw one.
		process.env["PIX_TEST_PROBE_BAD"] = "bad\nvalue";
		const unsafe = await errorMessage(() => resolveApiKeyForProbe("${PIX_TEST_PROBE_BAD}"));
		assert(unsafe.includes("HTTP 头无法承载"), `resolved value safety-checked: ${unsafe}`);
		delete process.env["PIX_TEST_PROBE_BAD"];
		// End-to-end: an embedded template key reaches fetch as its resolved literal.
		const { deps, captured } = makeFetch(() => jsonResponse({ data: [] }));
		await fetchProviderModels({ baseUrl: BASE, api: "openai-completions", apiKey: "sk-${PIX_TEST_PROBE_KEY}" }, deps);
		assertEqual(captured[0]?.headers.authorization, "Bearer sk-sk-from-env", "embedded template resolved end-to-end");
	} finally {
		delete process.env["PIX_TEST_PROBE_KEY"];
	}
});

await run("listing shape defenses: data scalar, non-object entries", async () => {
	const stringData = makeFetch(() => jsonResponse({ data: "gpt-4,gpt-5" }));
	const message = await errorMessage(() =>
		fetchProviderModels({ baseUrl: BASE, api: "openai-completions" }, stringData.deps),
	);
	assert(message.includes("data 数组"), `scalar data rejected: ${message}`);

	const listing = {
		data: ["bare-string", null, 42, { id: "real-entry" }, true],
	};
	const { deps } = makeFetch(() => jsonResponse(listing));
	const { models } = await fetchProviderModels({ baseUrl: BASE, api: "openai-completions" }, deps);
	assertEqual(models.map((m) => m.id).join(","), "real-entry", "non-object entries skipped, object entries kept");
});

await run("4MiB ceiling: lying content-length refused on accumulated bytes", async () => {
	// Declares 100 bytes, streams 5MiB: the declared check passes, the
	// accumulated read must still refuse the body.
	const { deps } = makeFetch(
		() => new Response(chunkedStream([2 * MIB, 2 * MIB, MIB]), { headers: { "content-length": "100" } }),
	);
	const message = await errorMessage(() => fetchProviderModels({ baseUrl: BASE, api: "openai-completions" }, deps));
	assert(message.includes("4MiB"), `under-declared oversized body refused: ${message}`);
});

await run("abort: caller cancellation during the request", async () => {
	const { deps } = makeHangingFetch();
	const controller = new AbortController();
	const pending = fetchProviderModels({ baseUrl: BASE, api: "openai-completions", signal: controller.signal }, deps);
	setTimeout(() => controller.abort(), 10);
	const message = await errorMessage(() => pending);
	assertEqual(message, "已取消获取模型列表", "abort classified as caller cancellation");
});

await run("timeout: bounded by timeoutMs", async () => {
	const { deps } = makeHangingFetch();
	const message = await errorMessage(() =>
		fetchProviderModels({ baseUrl: BASE, api: "openai-completions", timeoutMs: 1000 }, deps),
	);
	assert(message.startsWith(`请求 ${BASE}/models 超时`), `timeout message: ${message}`);
	assert(message.includes("1 秒"), "timeout message names the bound");
});

await run("streamed JSON across chunk boundaries parses", async () => {
	const text = JSON.stringify({ data: [{ id: "split-model", context_window: 4096 }] });
	const { deps } = makeFetch(() => new Response(textStream(text, [7, 23, 40])));
	const { models } = await fetchProviderModels({ baseUrl: BASE, api: "openai-completions" }, deps);
	assertEqual(models.length, 1, "one model parsed");
	assertEqual(models[0]?.id, "split-model", "id intact across chunks");
	assertEqual(models[0]?.contextWindow, 4096, "capacity intact across chunks");
});

await run("empty listing is a success with zero models", async () => {
	const { deps } = makeFetch(() => jsonResponse({ data: [] }));
	const { models } = await fetchProviderModels({ baseUrl: BASE, api: "openai-completions" }, deps);
	assertEqual(models.length, 0, "data: [] -> empty success");
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
	process.exit(1);
}
