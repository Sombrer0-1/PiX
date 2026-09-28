/**
 * SessionBridge.fetchProviderModels credential-resolution behavior tests.
 *
 * Exercises the IPC-facing path end to end with a stubbed global fetch (no
 * network) and a temp PI_CODING_AGENT_DIR holding auth.json / models.json
 * fixtures. The bridge never started a session, so _authStorage is null —
 * exactly the state that must still read auth.json (settings can open before
 * any session activation). Verifies the kernel precedence (form key > auth.json
 * > models.json apiKey, with $ENV templates resolved by the fetch module), the
 * SENTINEL guard, anonymous probes, and that no error message leaks the key.
 *
 * Run with: npx tsx pix/src/main/__tests__/fetch-provider-models-bridge.test.ts
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionBridge } from "../session-bridge.js";
import { SENTINEL, type FetchProviderModelsResult } from "../../shared/custom-providers.js";

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

// ============================================================================
// Fixtures
// ============================================================================

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pix-fetch-models-agent-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

writeFileSync(
	join(AGENT_DIR, "auth.json"),
	JSON.stringify({ relay: { type: "api_key", key: "sk-auth-json" } }, null, 2),
	"utf-8",
);
writeFileSync(
	join(AGENT_DIR, "models.json"),
	JSON.stringify(
		{
			providers: {
				relay: { baseUrl: "https://relay.example.com/v1", api: "openai-completions", apiKey: "sk-models-json", models: [] },
				templated: { baseUrl: "https://relay.example.com/v1", api: "openai-completions", apiKey: "$PIX_BRIDGE_TEST_KEY", models: [] },
			},
		},
		null,
		2,
	),
	"utf-8",
);

interface CapturedFetch {
	url: string;
	authorization: string | undefined;
}

/** Stub globalThis.fetch: capture the request, answer with a one-model listing. */
function stubFetch(status = 200): CapturedFetch[] {
	const captured: CapturedFetch[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const headers = (init?.headers as Record<string, string> | undefined) ?? {};
		captured.push({ url, authorization: headers.authorization });
		const body = status === 200 ? JSON.stringify({ data: [{ id: "stub-model" }] }) : "denied";
		return new Response(body, { status, headers: { "content-type": "application/json" } });
	}) as typeof globalThis.fetch;
	return captured;
}

const originalFetch = globalThis.fetch;

async function probe(params: {
	baseUrl: string;
	api: "openai-completions" | "openai-responses";
	apiKey?: string;
	providerName?: string;
}): Promise<FetchProviderModelsResult> {
	return new SessionBridge().fetchProviderModels(params);
}

// ============================================================================
// Tests
// ============================================================================

await run("form key wins over every stored source", async () => {
	const captured = stubFetch();
	const result = await probe({ baseUrl: "https://relay.example.com/v1", api: "openai-completions", apiKey: "sk-form", providerName: "relay" });
	assertEqual(result.success, true, "probe succeeded");
	assertEqual(captured[0]?.authorization, "Bearer sk-form", "form key used, not the stored ones");
});

await run("SENTINEL form key falls through to the stored key", async () => {
	const captured = stubFetch();
	const result = await probe({ baseUrl: "https://relay.example.com/v1", api: "openai-completions", apiKey: SENTINEL, providerName: "relay" });
	assertEqual(result.success, true, "probe succeeded");
	assertEqual(captured[0]?.authorization, "Bearer sk-auth-json", "mask literal never sent; auth.json key used");
});

await run("auth.json outranks the models.json apiKey (kernel precedence)", async () => {
	const captured = stubFetch();
	await probe({ baseUrl: "https://relay.example.com/v1", api: "openai-completions", providerName: "relay" });
	assertEqual(captured[0]?.authorization, "Bearer sk-auth-json", "auth.json key wins over models.json key");
});

await run("models.json apiKey used when auth.json has none; $ENV template resolved", async () => {
	process.env.PIX_BRIDGE_TEST_KEY = "sk-env-resolved";
	try {
		const captured = stubFetch();
		await probe({ baseUrl: "https://relay.example.com/v1", api: "openai-completions", providerName: "templated" });
		assertEqual(captured[0]?.authorization, "Bearer sk-env-resolved", "$ENV template from models.json resolved");
	} finally {
		delete process.env.PIX_BRIDGE_TEST_KEY;
	}
});

await run("no key and no provider name probes anonymously", async () => {
	const captured = stubFetch();
	const result = await probe({ baseUrl: "https://relay.example.com/v1", api: "openai-completions" });
	assertEqual(result.success, true, "probe succeeded");
	assertEqual(captured[0]?.authorization, undefined, "no authorization header without a credential");
});

await run("failure carries a user-facing error without the key", async () => {
	stubFetch(401);
	const result = await probe({ baseUrl: "https://relay.example.com/v1", api: "openai-completions", apiKey: "sk-secret-value" });
	assertEqual(result.success, false, "probe failed");
	if (!result.success) {
		assert(result.error.includes("HTTP 401"), `error names the status: ${result.error}`);
		assert(!result.error.includes("sk-secret-value"), "key absent from the error");
	}
});

await run("auth.json !cmd credential is refused, never executed", async () => {
	// A fresh bridge re-reads auth.json; swap the relay credential for a
	// command form and confirm the probe refuses it (getApiKey would EXECUTE
	// the command - the settings probe must not).
	writeFileSync(
		join(AGENT_DIR, "auth.json"),
		JSON.stringify({ relay: { type: "api_key", key: "!echo should-not-run" } }, null, 2),
		"utf-8",
	);
	const captured = stubFetch();
	const result = await probe({ baseUrl: "https://relay.example.com/v1", api: "openai-completions", providerName: "relay" });
	assertEqual(result.success, false, "probe refused the command credential");
	if (!result.success) {
		assert(result.error.includes("!cmd"), `error explains the refusal: ${result.error}`);
	}
	assertEqual(captured.length, 0, "no request went out");
	// Restore the literal credential for any later runs.
	writeFileSync(
		join(AGENT_DIR, "auth.json"),
		JSON.stringify({ relay: { type: "api_key", key: "sk-auth-json" } }, null, 2),
		"utf-8",
	);
});

await run("auth.json $ENV template resolves through the probe resolver", async () => {
	process.env.PIX_BRIDGE_AUTH_KEY = "sk-auth-env";
	try {
		writeFileSync(
			join(AGENT_DIR, "auth.json"),
			JSON.stringify({ relay: { type: "api_key", key: "$PIX_BRIDGE_AUTH_KEY" } }, null, 2),
			"utf-8",
		);
		const captured = stubFetch();
		const result = await probe({ baseUrl: "https://relay.example.com/v1", api: "openai-completions", providerName: "relay" });
		assertEqual(result.success, true, "probe succeeded");
		assertEqual(captured[0]?.authorization, "Bearer sk-auth-env", "auth.json template resolved");
	} finally {
		delete process.env.PIX_BRIDGE_AUTH_KEY;
		writeFileSync(
			join(AGENT_DIR, "auth.json"),
			JSON.stringify({ relay: { type: "api_key", key: "sk-auth-json" } }, null, 2),
			"utf-8",
		);
	}
});

// ============================================================================

globalThis.fetch = originalFetch;
console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
	process.exit(1);
}
