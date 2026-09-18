import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	type CallToolResult,
	CallToolResultSchema,
	type ContentBlock,
	ErrorCode,
	type ListResourcesResult,
	type ListResourceTemplatesResult,
	type ListToolsResult,
	McpError,
	type Progress,
	type ReadResourceResult,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { type TSchema, Type } from "typebox";

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_STDERR_CHARS = 16_384;
const RECONNECT_COOLDOWN_MS = 5_000;
/**
 * How long an unused pooled connection stays alive (and keeps its warm
 * handshake + tools cache) after the last adapter releases it. Session
 * switches in PiX close the old McpAdapter before the next one is created, so
 * this grace window is what makes re-acquisition free.
 */
const IDLE_EVICT_MS = 10 * 60_000;
/** First backoff step of the connect circuit breaker; doubles per failure. */
const BREAKER_BASE_MS = 30_000;
/** Backoff ceiling of the connect circuit breaker. */
const BREAKER_MAX_MS = 300_000;
/** Default upper bound for blocking session_start on non-required servers. */
const DEFAULT_STARTUP_BLOCKING_BUDGET_MS = 1_500;

const LOG_PREFIX = "[mcp-adapter]";

function log(level: "debug" | "info" | "warn" | "error", message: string, ...args: unknown[]): void {
	const fn = console[level] ?? console.log;
	fn(`${LOG_PREFIX} ${message}`, ...args);
}

type JsonObject = Record<string, unknown>;
type PiContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type McpTransportKind = "stdio" | "http" | "sse";

export interface McpServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	transport?: "stdio" | "http" | "streamable-http" | "streamableHttp" | "sse";
	type?: "stdio" | "http" | "streamable-http" | "streamableHttp" | "sse";
	headers?: Record<string, string>;
	enabled?: boolean;
	disabled?: boolean;
	required?: boolean;
	startupTimeoutMs?: number;
	requestTimeoutMs?: number;
	timeoutMs?: number;
	toolNamePrefix?: string | false;
	description?: string;
}

export interface McpAdapterConfigFile {
	mcpServers?: Record<string, McpServerConfig>;
	servers?: Record<string, McpServerConfig>;
}

export interface McpAdapterOptions {
	servers?: Record<string, McpServerConfig>;
	configPaths?: string[];
	autoDiscover?: boolean;
	registerResourceTools?: boolean;
	startupTimeoutMs?: number;
	requestTimeoutMs?: number;
	/**
	 * Upper bound (ms) that a non-required MCP server may block session_start
	 * while connecting. Servers that exceed the budget keep connecting in the
	 * background and register their tools once they are ready. Defaults to 1500.
	 */
	startupBlockingBudgetMs?: number;
	/**
	 * Whether stdio MCP servers may be spawned on the host. Defaults to true.
	 * WSL-backed sessions pass false: the Windows host cannot launch a Linux
	 * stdio server, so it is filtered with a clear diagnostic instead of a
	 * confusing spawn failure (wsl_plan.md §4.10). HTTP/SSE are unaffected.
	 */
	allowStdio?: boolean;
}

interface LoadedConfig {
	servers: Map<string, McpServerConfig>;
	paths: string[];
	errors: string[];
}

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "failed";

interface ExposedTool {
	serverName: string;
	originalName: string;
	exposedName: string;
	tool: Tool;
}

export interface McpServerStatus {
	name: string;
	status: ConnectionStatus;
	error?: string;
	toolCount: number;
	tools: string[];
	transport: McpTransportKind;
	required: boolean;
	stderr?: string;
}

export interface McpConfigInfo {
	configPaths: string[];
	errors: string[];
}

export interface McpResourceQueryResult {
	results: { server: string; resources: unknown[] }[];
	errors: string[];
}

export interface McpReadResourceResult {
	server: string;
	contents: unknown[];
	errors?: string[];
}

const listServersSchema = Type.Object({
	server: Type.Optional(Type.String({ description: "Optional MCP server name to inspect." })),
});

const listResourcesSchema = Type.Object({
	server: Type.Optional(
		Type.String({ description: "Optional MCP server name. Omit to list resources from every server." }),
	),
	cursor: Type.Optional(Type.String({ description: "Pagination cursor. Use only with a single server." })),
});

const listResourceTemplatesSchema = Type.Object({
	server: Type.Optional(
		Type.String({ description: "Optional MCP server name. Omit to list resource templates from every server." }),
	),
	cursor: Type.Optional(Type.String({ description: "Pagination cursor. Use only with a single server." })),
});

const readResourceSchema = Type.Object({
	uri: Type.String({ description: "Resource URI to read." }),
	server: Type.Optional(Type.String({ description: "Optional MCP server name. Omit to try every connected server." })),
});

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result = value.filter((entry): entry is string => typeof entry === "string");
	return result.length === value.length ? result : undefined;
}

function expandPath(input: string, baseDir?: string): string {
	const trimmed = input.trim();
	const homeExpanded =
		trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")
			? join(homedir(), trimmed.slice(2))
			: trimmed;
	return isAbsolute(homeExpanded) ? resolve(homeExpanded) : resolve(baseDir ?? process.cwd(), homeExpanded);
}

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR
		? expandPath(process.env.PI_CODING_AGENT_DIR)
		: join(homedir(), ".pi", "agent");
}

function getDefaultConfigPaths(cwd: string): string[] {
	return [join(getAgentDir(), "mcp.json"), join(cwd, ".mcp.json"), join(cwd, ".pi", "mcp.json")];
}

function getEnvConfigPaths(): string[] {
	const raw = process.env.PI_MCP_CONFIG;
	if (!raw) return [];
	return raw
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => expandPath(entry));
}

function normalizeServerConfig(value: unknown, configPath: string): McpServerConfig | undefined {
	if (!isRecord(value)) return undefined;
	const config = value as McpServerConfig;
	const args = asStringArray(config.args);
	const hasCommand = typeof config.command === "string" && config.command.length > 0;
	const hasUrl = typeof config.url === "string" && config.url.length > 0;
	if (!hasCommand && !hasUrl) {
		return undefined;
	}
	return {
		command: config.command,
		args,
		env: config.env,
		cwd: typeof config.cwd === "string" ? expandPath(config.cwd, dirname(configPath)) : undefined,
		url: config.url,
		transport: config.transport,
		type: config.type,
		headers: config.headers,
		enabled: config.enabled,
		disabled: config.disabled,
		required: config.required,
		startupTimeoutMs: config.startupTimeoutMs,
		requestTimeoutMs: config.requestTimeoutMs,
		timeoutMs: config.timeoutMs,
		toolNamePrefix: config.toolNamePrefix,
		description: config.description,
	};
}

async function loadConfigFile(
	configPath: string,
): Promise<{ servers: Record<string, McpServerConfig>; errors: string[] }> {
	let raw: string;
	try {
		raw = await readFile(configPath, "utf-8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return { servers: {}, errors: [] };
		}
		return {
			servers: {},
			errors: [`${configPath}: ${error instanceof Error ? error.message : String(error)}`],
		};
	}

	try {
		const parsed = JSON.parse(raw) as McpAdapterConfigFile | Record<string, unknown>;
		const rawServers = isRecord(parsed.mcpServers)
			? parsed.mcpServers
			: isRecord(parsed.servers)
				? parsed.servers
				: {};
		const servers: Record<string, McpServerConfig> = {};
		const errors: string[] = [];

		for (const [name, value] of Object.entries(rawServers)) {
			const normalized = normalizeServerConfig(value, configPath);
			if (!normalized) {
				errors.push(`${configPath}: MCP server "${name}" must define either command or url`);
				continue;
			}
			servers[name] = normalized;
		}

		return { servers, errors };
	} catch (error) {
		return {
			servers: {},
			errors: [`${configPath}: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
}

async function loadAdapterConfig(cwd: string, options: McpAdapterOptions): Promise<LoadedConfig> {
	const autoDiscover = options.autoDiscover ?? true;
	const paths = [
		...(autoDiscover ? getDefaultConfigPaths(cwd) : []),
		...getEnvConfigPaths(),
		...(options.configPaths ?? []).map((entry) => expandPath(entry, cwd)),
	];
	const seenPaths = new Set<string>();
	const servers = new Map<string, McpServerConfig>();
	const errors: string[] = [];
	const loadedPaths: string[] = [];

	for (const path of paths) {
		const resolved = expandPath(path, cwd);
		if (seenPaths.has(resolved)) continue;
		seenPaths.add(resolved);
		const result = await loadConfigFile(resolved);
		if (Object.keys(result.servers).length > 0 || result.errors.length > 0) {
			loadedPaths.push(resolved);
		}
		errors.push(...result.errors);
		for (const [name, server] of Object.entries(result.servers)) {
			servers.set(name, server);
		}
	}

	for (const [name, server] of Object.entries(options.servers ?? {})) {
		servers.set(name, server);
	}

	for (const [name, server] of Array.from(servers.entries())) {
		if (server.enabled === false || server.disabled === true) {
			servers.delete(name);
		}
	}

	return { servers, paths: loadedPaths, errors };
}

function sanitizeToolName(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
	const safe = sanitized.length > 0 ? sanitized : "tool";
	return safe.slice(0, 120);
}

function getTransportKind(config: McpServerConfig): McpTransportKind {
	const raw = config.transport ?? config.type;
	if (raw === "sse") return "sse";
	if (raw === "http" || raw === "streamable-http" || raw === "streamableHttp") return "http";
	if (raw === "stdio") return "stdio";
	return config.url ? "http" : "stdio";
}

/** Shared by the GUI query API and the mcp_list_servers tool so they agree. */
function describeConnectionStatus(connection: McpServerConnection): McpServerStatus {
	const breakerMs = connection.breakerRemainingMs();
	return {
		name: connection.name,
		status: connection.status,
		// Breaker wins: the failure path never clears connection.error, so the raw
		// error would otherwise hide the remaining cool-down.
		error: breakerMs > 0 ? connection.describeBreaker() : connection.error,
		toolCount: connection.tools.length,
		tools: connection.tools.map((tool) => tool.name),
		transport: getTransportKind(connection.config),
		required: connection.config.required === true,
		stderr: connection.lastStderr || undefined,
	};
}

function resolveConfigTemplate(value: string): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
		const envValue = process.env[(braced || bare) as string];
		return envValue ?? match;
	});
}

function resolveConfigRecord(record: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!record) return undefined;
	return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, resolveConfigTemplate(value)]));
}

function mergeHeaders(base: RequestInit["headers"] | undefined, extra: Record<string, string>): RequestInit["headers"] {
	const headers = new Headers(base);
	for (const [key, value] of Object.entries(extra)) {
		headers.set(key, value);
	}
	return headers;
}

function createFetchWithHeaders(headers: Record<string, string>) {
	return (url: string | URL, init?: RequestInit) =>
		fetch(url, {
			...init,
			headers: mergeHeaders(init?.headers, headers),
		});
}

function makeRequestOptions(
	signal: AbortSignal | undefined,
	timeout: number,
	onprogress?: (progress: Progress) => void,
): RequestOptions {
	return {
		signal,
		timeout,
		resetTimeoutOnProgress: true,
		onprogress,
	};
}

// NOTE: relies on error message matching, which is fragile across MCP SDK upgrades.
// The SDK does not currently expose structured error codes for task-required errors,
// so this is a known compromise.
function isTaskRequiredError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /requires task-based execution|callToolStream/i.test(message);
}

function makeTextResult(text: string, details: unknown = undefined): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

function jsonText(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function contentBlockToPiContent(block: ContentBlock): PiContent[] {
	if (block.type === "text") {
		return [{ type: "text", text: block.text }];
	}
	if (block.type === "image") {
		return [{ type: "image", data: block.data, mimeType: block.mimeType }];
	}
	if (block.type === "audio") {
		return [
			{
				type: "text",
				text: `[MCP audio content omitted: ${block.mimeType}, ${block.data.length} base64 characters]`,
			},
		];
	}
	if (block.type === "resource") {
		const resource = block.resource;
		if ("text" in resource) {
			return [
				{
					type: "text",
					text: `Resource ${resource.uri}${resource.mimeType ? ` (${resource.mimeType})` : ""}\n\n${resource.text}`,
				},
			];
		}
		return [
			{
				type: "text",
				text: `Resource ${resource.uri}${resource.mimeType ? ` (${resource.mimeType})` : ""} returned binary data (${resource.blob.length} base64 characters).`,
			},
		];
	}
	if (block.type === "resource_link") {
		return [{ type: "text", text: `Resource link:\n${jsonText(block)}` }];
	}
	return [{ type: "text", text: jsonText(block) }];
}

function convertCallToolResult(result: CallToolResult, details: unknown): AgentToolResult<unknown> {
	const content = result.content.flatMap(contentBlockToPiContent);
	if (result.structuredContent !== undefined) {
		content.push({
			type: "text",
			text: `Structured content:\n${jsonText(result.structuredContent)}`,
		});
	}
	if (content.length === 0) {
		content.push({ type: "text", text: "MCP tool returned no content." });
	}
	return { content, details };
}

function resourceContentsToPiContent(result: ReadResourceResult): PiContent[] {
	const content: PiContent[] = [];
	for (const item of result.contents) {
		if ("text" in item) {
			content.push({
				type: "text",
				text: `Resource ${item.uri}${item.mimeType ? ` (${item.mimeType})` : ""}\n\n${item.text}`,
			});
		} else {
			content.push({
				type: "text",
				text: `Resource ${item.uri}${item.mimeType ? ` (${item.mimeType})` : ""} returned binary data (${item.blob.length} base64 characters).`,
			});
		}
	}
	return content.length > 0 ? content : [{ type: "text", text: "MCP resource returned no content." }];
}

function normalizeInputSchema(tool: Tool): TSchema {
	const schema: JsonObject = isRecord(tool.inputSchema) ? structuredClone(tool.inputSchema) : {};
	if (schema.type !== "object") {
		schema.type = "object";
	}
	if (!isRecord(schema.properties)) {
		schema.properties = {};
	}
	if (schema.required !== undefined && !Array.isArray(schema.required)) {
		delete schema.required;
	}
	return schema as TSchema;
}

function describeTool(serverName: string, tool: Tool): string {
	const title = tool.title || tool.annotations?.title;
	const pieces = [`MCP server: ${serverName}.`, `Remote tool: ${tool.name}.`];
	if (title && title !== tool.name) {
		pieces.push(`Title: ${title}.`);
	}
	if (tool.description) {
		pieces.push(tool.description);
	}
	return pieces.join(" ");
}

/**
 * Per-adapter subscription to a connection. Connections live in the module-level
 * pool and may be shared by several adapters (active session, background
 * sessions, nested agent-task sessions), so notifications fan out to every
 * subscriber instead of a single construction-time callback.
 */
interface ConnectionListener {
	onToolsChanged: (serverName: string, tools: Tool[]) => void;
	onResourcesChanged: (serverName: string) => void;
}

class McpServerConnection {
	readonly name: string;
	readonly config: McpServerConfig;
	status: ConnectionStatus = "disconnected";
	error: string | undefined;
	lastStderr = "";
	tools: Tool[] = [];
	private client: Client | undefined;
	private transport: Transport | undefined;
	private connecting: Promise<void> | undefined;
	private readonly listeners = new Set<ConnectionListener>();
	private startupTimeoutMs: number;
	private requestTimeoutMs: number;
	private readonly allowStdio: boolean;
	private lastReconnectAttempt = 0;
	private healthCheckTimer: ReturnType<typeof setInterval> | undefined;
	private readonly HEALTH_CHECK_INTERVAL_MS = 30_000;
	/** Consecutive startup connect failures; drives the circuit breaker backoff. */
	private failureCount = 0;
	/** Epoch ms until which startup connects are refused without touching the network. */
	private breakerOpenUntil = 0;
	private lastConnectError: string | undefined;
	/** Whether the in-flight connect() should arm the breaker on failure. */
	private armBreaker = false;

	constructor(
		name: string,
		config: McpServerConfig,
		options: { startupTimeoutMs: number; requestTimeoutMs: number; allowStdio: boolean },
	) {
		this.name = name;
		this.config = config;
		this.startupTimeoutMs = config.startupTimeoutMs ?? config.timeoutMs ?? options.startupTimeoutMs;
		this.requestTimeoutMs = config.requestTimeoutMs ?? config.timeoutMs ?? options.requestTimeoutMs;
		this.allowStdio = options.allowStdio;
	}

	addListener(listener: ConnectionListener): void {
		this.listeners.add(listener);
	}

	removeListener(listener: ConnectionListener): void {
		this.listeners.delete(listener);
	}

	get isConnected(): boolean {
		return this.status === "connected" && this.client !== undefined;
	}

	breakerRemainingMs(now = Date.now()): number {
		return Math.max(0, this.breakerOpenUntil - now);
	}

	describeBreaker(): string {
		const left = Math.ceil(this.breakerRemainingMs() / 1000);
		return `连接熔断中（${left}s 后可重试）：${this.lastConnectError ?? "unknown error"}`;
	}

	/**
	 * Best-effort synchronous teardown for process exit. Only stdio servers need
	 * it: HTTP/SSE sockets die with the process, but a spawned child would
	 * otherwise be orphaned because the pool's idle timers die with us too.
	 */
	killSync(): void {
		const transport = this.transport;
		if (!(transport instanceof StdioClientTransport)) return;
		const pid = transport.pid;
		if (!pid) return;
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}

	private recordFailure(error: unknown): void {
		this.failureCount += 1;
		this.lastConnectError = error instanceof Error ? error.message : String(error);
		this.breakerOpenUntil = Date.now() + Math.min(BREAKER_BASE_MS * 2 ** (this.failureCount - 1), BREAKER_MAX_MS);
	}

	private clearFailure(): void {
		this.failureCount = 0;
		this.breakerOpenUntil = 0;
		this.lastConnectError = undefined;
	}

	private notifyToolsChanged(): void {
		for (const listener of this.listeners) listener.onToolsChanged(this.name, this.tools);
	}

	private notifyResourcesChanged(): void {
		for (const listener of this.listeners) listener.onResourcesChanged(this.name);
	}

	/**
	 * @param options.armBreaker Arm the circuit breaker when this connect fails.
	 * Only the session_start path passes true; request paths (tool calls, GUI
	 * resource queries) stay able to retry for real, so a user-triggered refresh
	 * can always recover a server while the breaker window is still open.
	 */
	async connect(signal?: AbortSignal, options?: { armBreaker?: boolean }): Promise<void> {
		if (this.status === "connected" && this.client) return;
		if (this.connecting) return this.connecting;
		if (options?.armBreaker === true && this.breakerRemainingMs() > 0) {
			throw new Error(this.describeBreaker());
		}

		this.armBreaker = options?.armBreaker === true;
		this.connecting = this.connectOnce(signal).finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}

	async disconnect(): Promise<void> {
		log("info", `disconnecting "${this.name}"`);
		this.stopHealthCheck();
		this.status = "disconnected";
		this.error = undefined;
		const client = this.client;
		const transport = this.transport;
		this.client = undefined;
		this.transport = undefined;
		this.tools = [];
		try {
			await client?.close();
		} catch {}
		try {
			await transport?.close();
		} catch {}
	}

	async refreshTools(signal?: AbortSignal): Promise<Tool[]> {
		return this.withReconnect(async (client) => this.listAllTools(client, signal), signal);
	}

	async listResources(cursor: string | undefined, signal?: AbortSignal): Promise<ListResourcesResult> {
		return this.withReconnect(
			(client) =>
				client.listResources(cursor ? { cursor } : undefined, makeRequestOptions(signal, this.requestTimeoutMs)),
			signal,
		);
	}

	async listResourceTemplates(cursor: string | undefined, signal?: AbortSignal): Promise<ListResourceTemplatesResult> {
		return this.withReconnect(
			(client) =>
				client.listResourceTemplates(
					cursor ? { cursor } : undefined,
					makeRequestOptions(signal, this.requestTimeoutMs),
				),
			signal,
		);
	}

	async readResource(uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
		return this.withReconnect(
			(client) => client.readResource({ uri }, makeRequestOptions(signal, this.requestTimeoutMs)),
			signal,
		);
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<unknown> | undefined,
	): Promise<CallToolResult> {
		return this.withReconnect((client) => this.callToolWithClient(client, name, args, signal, onUpdate), signal);
	}

	private async connectOnce(signal?: AbortSignal): Promise<void> {
		log("info", `connecting to "${this.name}" (${getTransportKind(this.config)})`);
		this.status = "connecting";
		this.error = undefined;
		this.lastStderr = "";

		// createTransport() can throw synchronously (e.g. stdio disabled in WSL
		// mode, or missing command/url). Wrap it so the failure is recorded as
		// status="failed" with a per-server error before re-throwing, instead of
		// escaping with status stuck at "connecting" and error undefined.
		// wsl_plan.md §4.10: diagnostic must land in BOTH McpConfigInfo.errors
		// AND McpServerStatus.error.
		let transport: Transport;
		try {
			transport = this.createTransport();
		} catch (error) {
			this.status = "failed";
			this.error = error instanceof Error ? error.message : String(error);
			if (this.armBreaker) this.recordFailure(error);
			log("error", `"${this.name}" connection failed: ${this.error}`);
			throw error;
		}
		this.transport = transport;
		transport.onclose = () => {
			if (this.transport !== transport) return;
			log("debug", `transport closed for "${this.name}"`);
			if (this.status === "connected" || this.status === "connecting") {
				this.status = "disconnected";
			}
		};
		transport.onerror = (error) => {
			if (this.transport !== transport) return;
			log("error", `transport error for "${this.name}": ${error.message}`);
			this.error = error.message;
		};

		const client = new Client(
			{ name: "pi-mcp-adapter", version: "0.1.0" },
			{
				capabilities: {},
				listChanged: {
					tools: {
						onChanged: (error, tools) => {
							if (error) {
								this.error = error.message;
								return;
							}
							this.tools = tools ?? [];
							this.notifyToolsChanged();
						},
					},
					resources: {
						onChanged: (error) => {
							if (error) {
								this.error = error.message;
								return;
							}
							this.notifyResourcesChanged();
						},
					},
				},
			},
		);

		try {
			await client.connect(transport, makeRequestOptions(signal, this.startupTimeoutMs));
			if (this.status !== "connecting") {
				try {
					await client.close();
				} catch {}
				try {
					await transport.close();
				} catch {}
				return;
			}
			this.client = client;
			this.transport = transport;
			this.status = "connected";
			log("info", `"${this.name}" connected, listing tools`);
			this.tools = await this.listAllTools(client, signal);
			if (this.status !== "connected") {
				try {
					await client.close();
				} catch {}
				try {
					await transport.close();
				} catch {}
				return;
			}
			this.startHealthCheck();
			this.clearFailure();
			log("info", `"${this.name}" has ${this.tools.length} tools`);
		} catch (error) {
			this.status = "failed";
			this.error = error instanceof Error ? error.message : String(error);
			if (this.armBreaker) this.recordFailure(error);
			log("error", `"${this.name}" connection failed: ${this.error}`);
			this.stopHealthCheck();
			try {
				await client.close();
			} catch {}
			try {
				await transport.close();
			} catch {}
			throw error;
		}
	}

	private createTransport(): Transport {
		const kind = getTransportKind(this.config);
		if (kind === "stdio") {
			if (!this.allowStdio) {
				throw new Error(
					"MCP stdio server is disabled in WSL mode; use HTTP/SSE or run the server inside WSL",
				);
			}
			if (!this.config.command) {
				throw new Error(`MCP server "${this.name}" is missing command`);
			}
			const transport = new StdioClientTransport({
				command: resolveConfigTemplate(this.config.command),
				args: this.config.args ?? [],
				cwd: this.config.cwd,
				env: {
					...getDefaultEnvironment(),
					...resolveConfigRecord(this.config.env),
				},
				stderr: "pipe",
			});
			transport.stderr?.on("data", (chunk) => {
				this.lastStderr = (this.lastStderr + chunk.toString()).slice(-MAX_STDERR_CHARS);
			});
			return transport;
		}

		if (!this.config.url) {
			throw new Error(`MCP server "${this.name}" is missing url`);
		}
		const url = new URL(resolveConfigTemplate(this.config.url));
		const headers = resolveConfigRecord(this.config.headers);
		if (!headers || Object.keys(headers).length === 0) {
			return kind === "sse" ? new SSEClientTransport(url) : new StreamableHTTPClientTransport(url);
		}

		const fetchWithHeaders = createFetchWithHeaders(headers);
		if (kind === "sse") {
			// as never: MCP SDK's SSEClientTransport constructor types eventSourceInit
			// without a fetch field, but the underlying EventSource implementation accepts it.
			return new SSEClientTransport(url, {
				requestInit: { headers },
				fetch: fetchWithHeaders,
				eventSourceInit: { fetch: fetchWithHeaders } as never,
			});
		}
		return new StreamableHTTPClientTransport(url, {
			requestInit: { headers },
			fetch: fetchWithHeaders,
		});
	}

	private async withReconnect<T>(fn: (client: Client) => Promise<T>, signal?: AbortSignal): Promise<T> {
		await this.connect(signal);
		if (!this.client) {
			throw new Error(`MCP server "${this.name}" is not connected`);
		}
		try {
			return await fn(this.client);
		} catch (error) {
			if (signal?.aborted) throw error;
			const now = Date.now();
			if (now - this.lastReconnectAttempt < RECONNECT_COOLDOWN_MS) {
				throw error;
			}
			this.lastReconnectAttempt = now;
			log(
				"warn",
				`"${this.name}" request failed, reconnecting: ${error instanceof Error ? error.message : String(error)}`,
			);
			await this.disconnect();
			await this.connect(signal);
			if (!this.client) {
				throw new Error(`MCP server "${this.name}" is not connected after reconnect`);
			}
			return fn(this.client);
		}
	}

	private startHealthCheck(): void {
		const kind = getTransportKind(this.config);
		if (kind === "stdio") return;
		this.stopHealthCheck();
		this.healthCheckTimer = setInterval(() => {
			if (this.status !== "connected" || !this.client) return;
			this.client
				.ping({ timeout: 5_000 })
				.then(() => {
					log("debug", `"${this.name}" health check ok`);
				})
				.catch((error) => {
					if (error instanceof McpError && error.code === ErrorCode.MethodNotFound) {
						log("debug", `"${this.name}" health check: ping not supported by server, skipping`);
						return;
					}
					log(
						"warn",
						`"${this.name}" health check failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					this.disconnect();
				});
		}, this.HEALTH_CHECK_INTERVAL_MS);
	}

	private stopHealthCheck(): void {
		if (this.healthCheckTimer !== undefined) {
			clearInterval(this.healthCheckTimer);
			this.healthCheckTimer = undefined;
		}
	}

	private async listAllTools(client: Client, signal?: AbortSignal): Promise<Tool[]> {
		const tools: Tool[] = [];
		let cursor: string | undefined;
		try {
			do {
				const result: ListToolsResult = await client.listTools(
					cursor ? { cursor } : undefined,
					makeRequestOptions(signal, this.requestTimeoutMs),
				);
				tools.push(...result.tools);
				cursor = result.nextCursor;
			} while (cursor);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/capability|tools\/list|does not support/i.test(message)) {
				return [];
			}
			throw error;
		}
		this.tools = tools;
		return tools;
	}

	private async callToolWithClient(
		client: Client,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<unknown> | undefined,
	): Promise<CallToolResult> {
		const requestOptions = makeRequestOptions(signal, this.requestTimeoutMs, (progress) => {
			onUpdate?.(
				makeTextResult(`MCP ${this.name}/${name} progress: ${jsonText(progress)}`, {
					server: this.name,
					tool: name,
					progress,
				}),
			);
		});

		try {
			return (await client.callTool(
				{ name, arguments: args },
				CallToolResultSchema,
				requestOptions,
			)) as CallToolResult;
		} catch (error) {
			if (!isTaskRequiredError(error)) throw error;
		}

		let finalResult: CallToolResult | undefined;
		for await (const message of client.experimental.tasks.callToolStream(
			{ name, arguments: args },
			CallToolResultSchema,
			requestOptions,
		)) {
			if (message.type === "taskCreated" || message.type === "taskStatus") {
				onUpdate?.(
					makeTextResult(`MCP ${this.name}/${name} task ${message.task.taskId}: ${message.task.status}`, {
						server: this.name,
						tool: name,
						task: message.task,
					}),
				);
			} else if (message.type === "result") {
				finalResult = message.result as CallToolResult;
			} else if (message.type === "error") {
				throw new Error(message.error.message);
			}
		}

		if (!finalResult) {
			throw new Error(`MCP ${this.name}/${name} task ended without a result`);
		}
		return finalResult;
	}
}

// =========================================================================
// Process-wide connection pool
//
// PiX creates a fresh McpAdapter for every session generation and closes the
// previous one first (session-bridge _closeCurrentSession runs before
// _createSession). Reconnecting on every workspace open / session switch costs
// an initialize + tools/list round trip per server (2-4s on a slow remote, up
// to DEFAULT_STARTUP_TIMEOUT_MS when unreachable). The pool keeps connections
// (and their tools cache) alive across that gap so re-acquisition is free.
//
// Only the idle timer reclaims entries: the pool is shared by adapters whose
// loaded configs differ (different cwd, allowStdio, options.servers), so
// evicting by "not in this adapter's config" would kill connections other
// adapters still use. A removed server therefore lingers at most IDLE_EVICT_MS
// and never shows up in getServers() or in any session's tool list.
// =========================================================================

interface PoolEntry {
	key: string;
	connection: McpServerConnection;
	refCount: number;
	idleTimer: ReturnType<typeof setTimeout> | undefined;
}

const connectionPool = new Map<string, PoolEntry>();

function computePoolKey(name: string, config: McpServerConfig, allowStdio: boolean): string {
	const kind = getTransportKind(config);
	const identity: string[] = [kind, name];
	if (kind === "stdio") {
		identity.push(resolveConfigTemplate(config.command ?? ""));
		identity.push(JSON.stringify(config.args ?? []));
		identity.push(config.cwd ?? "");
		identity.push(JSON.stringify(resolveConfigRecord(config.env) ?? {}));
	} else {
		identity.push(resolveConfigTemplate(config.url ?? ""));
	}
	identity.push(JSON.stringify(Object.entries(resolveConfigRecord(config.headers) ?? {}).sort()));
	identity.push(allowStdio ? "1" : "0");
	return identity.join("\u0001");
}

function acquirePoolEntry(params: {
	key: string;
	name: string;
	config: McpServerConfig;
	startupTimeoutMs: number;
	requestTimeoutMs: number;
	allowStdio: boolean;
	listener: ConnectionListener;
}): { entry: PoolEntry; warm: boolean } {
	let entry = connectionPool.get(params.key);
	if (!entry) {
		const connection = new McpServerConnection(params.name, params.config, {
			startupTimeoutMs: params.startupTimeoutMs,
			requestTimeoutMs: params.requestTimeoutMs,
			allowStdio: params.allowStdio,
		});
		entry = { key: params.key, connection, refCount: 0, idleTimer: undefined };
		connectionPool.set(params.key, entry);
	}
	if (entry.idleTimer !== undefined) {
		clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
	}
	entry.refCount += 1;
	entry.connection.addListener(params.listener);
	return { entry, warm: entry.connection.isConnected };
}

function releasePoolEntry(entry: PoolEntry, listener: ConnectionListener): void {
	entry.connection.removeListener(listener);
	entry.refCount = Math.max(0, entry.refCount - 1);
	if (entry.refCount > 0) return;
	if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
	entry.idleTimer = setTimeout(() => {
		entry.idleTimer = undefined;
		if (entry.refCount === 0) closePoolEntry(entry);
	}, IDLE_EVICT_MS);
	entry.idleTimer.unref?.();
}

function closePoolEntry(entry: PoolEntry): void {
	// Defensive: a stale idle timer must never delete a replacement entry that
	// was acquired under the same key.
	if (connectionPool.get(entry.key) !== entry) return;
	connectionPool.delete(entry.key);
	if (entry.idleTimer !== undefined) {
		clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
	}
	void entry.connection.disconnect().catch(() => {});
}

/**
 * Tear down every pooled connection. Call on application shutdown: releasing
 * adapters only drops their references, so without this the pool's idle timers
 * would be the only owner of an otherwise unused connection.
 */
export async function closeAllMcpConnections(): Promise<void> {
	const entries = Array.from(connectionPool.values());
	connectionPool.clear();
	await Promise.all(entries.map((entry) => entry.connection.disconnect().catch(() => {})));
}

// Second line of defense: kill stdio children synchronously if the process
// exits before closeAllMcpConnections() ran (or if it threw).
process.once("exit", () => {
	for (const entry of connectionPool.values()) entry.connection.killSync();
});

export class McpAdapter {
	private options: McpAdapterOptions;
	private connections = new Map<string, McpServerConnection>();
	private configErrors: string[] = [];
	private configPaths: string[] = [];
	private toolNameOwners = new Map<string, string>();
	private exposedByOriginal = new Map<string, ExposedTool>();
	private activePi: ExtensionAPI | undefined;
	private resourceToolsRegistered = false;
	private acquired: Array<{ entry: PoolEntry; listener: ConnectionListener }> = [];

	constructor(options: McpAdapterOptions = {}) {
		this.options = options;
	}

	register(pi: ExtensionAPI): void {
		pi.on("session_start", async (_event, ctx) => {
			this.activePi = pi;
			await this.start(pi, ctx);
		});
		pi.on("session_shutdown", async () => {
			this.activePi = undefined;
			try {
				await this.stop();
			} catch (error) {
				log("error", `error during shutdown: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
	}

	// =========================================================================
	// Public query API for GUI
	// =========================================================================

	getServers(): McpServerStatus[] {
		return Array.from(this.connections.values()).map(describeConnectionStatus);
	}

	getConfigInfo(): McpConfigInfo {
		return { configPaths: this.configPaths, errors: this.configErrors };
	}

	/**
	 * Release this adapter's pool references. The shared connections stay warm
	 * for IDLE_EVICT_MS so the next session re-acquires them without a handshake;
	 * use closeAllMcpConnections() for a real process-wide teardown.
	 */
	async dispose(): Promise<void> {
		this.activePi = undefined;
		this.releaseAcquiredConnections();
	}

	async listResources(serverName?: string, signal?: AbortSignal): Promise<McpResourceQueryResult> {
		const { results, errors } = await this.forSelectedConnections(serverName, async (connection) => {
			const result = await connection.listResources(undefined, signal);
			return { server: connection.name, resources: result.resources };
		});
		return { results, errors };
	}

	async readResource(
		serverName: string | undefined,
		uri: string,
		signal?: AbortSignal,
	): Promise<McpReadResourceResult> {
		const { results: attempts, errors } = await this.forSelectedConnections(serverName, async (connection) => {
			const result = await connection.readResource(uri, signal);
			return { server: connection.name, contents: result.contents };
		});
		const successful = attempts[0];
		if (!successful) {
			throw new Error(`No MCP server could read resource: ${uri}`);
		}
		return { ...successful, errors: errors.length > 0 ? errors : undefined };
	}

	private async start(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
		this.releaseAcquiredConnections();
		this.activePi = pi;
		this.resourceToolsRegistered = false;
		this.toolNameOwners.clear();
		this.exposedByOriginal.clear();

		const loaded = await loadAdapterConfig(ctx.cwd, this.options);
		this.configErrors = loaded.errors;
		this.configPaths = loaded.paths;

		const allowStdio = this.options.allowStdio ?? true;
		const startupTimeoutMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
		const requestTimeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		const budgetMs = this.options.startupBlockingBudgetMs ?? DEFAULT_STARTUP_BLOCKING_BUDGET_MS;

		// Preserve the historical behavior: with no usable server but with config
		// errors, still register the resource tools so the user can read the error.
		if (loaded.servers.size === 0 && this.configErrors.length === 0) {
			return;
		}

		this.registerResourceTools(pi);

		const failures: string[] = [];
		const pending: Promise<void>[] = [];

		for (const [name, config] of loaded.servers) {
			const key = computePoolKey(name, config, allowStdio);
			const listener: ConnectionListener = {
				onToolsChanged: (serverName, tools) => {
					// A stale pi must never be handed tools: replacement invalidates
					// the old extension runtime and registerTool() would throw.
					if (this.activePi === pi) this.registerServerTools(pi, serverName, tools);
				},
				onResourcesChanged: () => {},
			};
			const { entry, warm } = acquirePoolEntry({
				key,
				name,
				config,
				startupTimeoutMs,
				requestTimeoutMs,
				allowStdio,
				listener,
			});
			this.acquired.push({ entry, listener });
			this.connections.set(name, entry.connection);

			if (warm) {
				// Hot path: warm handshake and cached tools, zero awaits, no network.
				this.registerServerTools(pi, name, entry.connection.tools);
				continue;
			}

			const breakerMs = entry.connection.breakerRemainingMs();
			if (breakerMs > 0) {
				const reason = entry.connection.describeBreaker();
				failures.push(`${name}: ${reason}`);
				if (config.required === true) {
					throw new Error(`Required MCP server "${name}" failed to start: ${reason}`);
				}
				continue;
			}

			if (config.required === true) {
				// required servers keep the fail-fast contract and wait the full
				// startupTimeoutMs; only their own error may fail the session.
				let requiredError: unknown;
				await entry.connection
					.connect(undefined, { armBreaker: true })
					.then(() => {
						if (this.activePi === pi) this.registerServerTools(pi, name, entry.connection.tools);
					})
					.catch((error: unknown) => {
						requiredError = error;
					});
				if (requiredError !== undefined) {
					const message = requiredError instanceof Error ? requiredError.message : String(requiredError);
					failures.push(`${name}: ${message}`);
					throw new Error(`Required MCP server "${name}" failed to start: ${message}`);
				}
				continue;
			}

			pending.push(
				entry.connection
					.connect(undefined, { armBreaker: true })
					.then(() => {
						if (this.activePi === pi) this.registerServerTools(pi, name, entry.connection.tools);
					})
					.catch((error: unknown) => {
						failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
					}),
			);
		}

		if (pending.length > 0) {
			// Bounded blocking: servers that finish within the budget register their
			// tools in this session_start; slower ones keep connecting in the
			// background and register when ready (registerTool refreshes the
			// session's tool registry, so no manual refresh is needed).
			await Promise.race([
				Promise.allSettled(pending),
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, budgetMs);
					timer.unref?.();
				}),
			]);
		}

		this.configErrors.push(...failures);
	}

	private releaseAcquiredConnections(): void {
		for (const { entry, listener } of this.acquired) releasePoolEntry(entry, listener);
		this.acquired = [];
		this.connections.clear();
	}

	private async stop(): Promise<void> {
		this.releaseAcquiredConnections();
	}

	private registerServerTools(pi: ExtensionAPI, serverName: string, tools: Tool[]): void {
		const currentToolNames = new Set(tools.map((tool) => tool.name));
		for (const tool of tools) {
			const exposed = this.getOrCreateExposedTool(serverName, tool);
			exposed.tool = tool;
			pi.registerTool(this.createToolDefinition(exposed));
		}

		for (const exposed of this.exposedByOriginal.values()) {
			if (exposed.serverName === serverName && !currentToolNames.has(exposed.originalName)) {
				pi.registerTool(this.createUnavailableToolDefinition(exposed));
			}
		}
	}

	private getOrCreateExposedTool(serverName: string, tool: Tool): ExposedTool {
		const key = `${serverName}\0${tool.name}`;
		const existing = this.exposedByOriginal.get(key);
		if (existing) return existing;

		const connection = this.connections.get(serverName);
		const configuredPrefix = connection?.config.toolNamePrefix;
		const prefix =
			configuredPrefix === false
				? ""
				: typeof configuredPrefix === "string"
					? configuredPrefix
					: `mcp__${serverName}`;
		const rawBase = prefix ? `${prefix}__${tool.name}` : tool.name;
		const base = sanitizeToolName(rawBase);
		let exposedName = base;
		let suffix = 2;
		while (this.toolNameOwners.has(exposedName) && this.toolNameOwners.get(exposedName) !== key) {
			const trimmed = base.slice(0, Math.max(1, 120 - String(suffix).length - 1));
			exposedName = `${trimmed}_${suffix}`;
			suffix++;
		}
		this.toolNameOwners.set(exposedName, key);
		const exposed = { serverName, originalName: tool.name, exposedName, tool };
		this.exposedByOriginal.set(key, exposed);
		return exposed;
	}

	private createToolDefinition(exposed: ExposedTool): ToolDefinition {
		return {
			name: exposed.exposedName,
			label: exposed.tool.title || exposed.tool.annotations?.title || exposed.tool.name,
			description: describeTool(exposed.serverName, exposed.tool),
			promptSnippet: `Use ${exposed.exposedName} for MCP server "${exposed.serverName}" tool "${exposed.originalName}".`,
			parameters: normalizeInputSchema(exposed.tool),
			executionMode: "parallel",
			execute: async (_toolCallId, params, signal, onUpdate) => {
				const connection = this.connections.get(exposed.serverName);
				if (!connection) {
					throw new Error(`MCP server "${exposed.serverName}" is not configured`);
				}
				const args = isRecord(params) ? params : {};
				const result = await connection.callTool(exposed.originalName, args, signal, onUpdate);
				const converted = convertCallToolResult(result, {
					server: exposed.serverName,
					tool: exposed.originalName,
					exposedTool: exposed.exposedName,
					result,
				});
				if (result.isError) {
					throw new Error(
						converted.content.map((item) => (item.type === "text" ? item.text : "[image]")).join("\n\n"),
					);
				}
				return converted;
			},
		};
	}

	private createUnavailableToolDefinition(exposed: ExposedTool): ToolDefinition {
		return {
			name: exposed.exposedName,
			label: `${exposed.tool.title || exposed.tool.annotations?.title || exposed.tool.name} (unavailable)`,
			description: `MCP server "${exposed.serverName}" no longer exposes remote tool "${exposed.originalName}".`,
			promptSnippet: `Do not use ${exposed.exposedName}; the MCP server no longer exposes "${exposed.originalName}".`,
			parameters: normalizeInputSchema(exposed.tool),
			executionMode: "parallel",
			execute: async () => {
				throw new Error(`MCP server "${exposed.serverName}" no longer exposes tool "${exposed.originalName}".`);
			},
		};
	}

	private registerResourceTools(pi: ExtensionAPI): void {
		if (this.resourceToolsRegistered || this.options.registerResourceTools === false) return;
		this.resourceToolsRegistered = true;

		pi.registerTool({
			name: "mcp_list_servers",
			label: "List MCP servers",
			description: "List configured MCP servers, connection status, discovered tool counts, and startup errors.",
			promptSnippet: "Use mcp_list_servers to inspect connected MCP servers and adapter status.",
			parameters: listServersSchema,
			executionMode: "parallel",
			execute: async (_toolCallId, params) => {
				const server = isRecord(params) && typeof params.server === "string" ? params.server : undefined;
				const servers = Array.from(this.connections.values())
					.filter((connection) => !server || connection.name === server)
					.map(describeConnectionStatus);
				return makeTextResult(jsonText({ configPaths: this.configPaths, errors: this.configErrors, servers }), {
					configPaths: this.configPaths,
					errors: this.configErrors,
					servers,
				});
			},
		});

		pi.registerTool({
			name: "mcp_list_resources",
			label: "List MCP resources",
			description: "List readable resources exposed by connected MCP servers.",
			promptSnippet: "Use mcp_list_resources to discover MCP resources before reading one.",
			parameters: listResourcesSchema,
			executionMode: "parallel",
			execute: async (_toolCallId, params, signal) => {
				const { server, cursor } = this.readListParams(params);
				if (cursor && !server) {
					throw new Error("cursor can only be used when server is provided");
				}
				const { results, errors } = await this.forSelectedConnections(server, async (connection) => {
					const result = await connection.listResources(cursor, signal);
					return { server: connection.name, ...result };
				});
				return makeTextResult(jsonText({ resources: results, errors: errors.length > 0 ? errors : undefined }), {
					resources: results,
					errors,
				});
			},
		});

		pi.registerTool({
			name: "mcp_list_resource_templates",
			label: "List MCP resource templates",
			description: "List resource URI templates exposed by connected MCP servers.",
			promptSnippet: "Use mcp_list_resource_templates to discover parameterized MCP resources.",
			parameters: listResourceTemplatesSchema,
			executionMode: "parallel",
			execute: async (_toolCallId, params, signal) => {
				const { server, cursor } = this.readListParams(params);
				if (cursor && !server) {
					throw new Error("cursor can only be used when server is provided");
				}
				const { results, errors } = await this.forSelectedConnections(server, async (connection) => {
					const result = await connection.listResourceTemplates(cursor, signal);
					return { server: connection.name, ...result };
				});
				return makeTextResult(
					jsonText({ resourceTemplates: results, errors: errors.length > 0 ? errors : undefined }),
					{ resourceTemplates: results, errors },
				);
			},
		});

		pi.registerTool({
			name: "mcp_read_resource",
			label: "Read MCP resource",
			description: "Read a resource from a connected MCP server by URI.",
			promptSnippet: "Use mcp_read_resource to read a concrete MCP resource URI.",
			parameters: readResourceSchema,
			executionMode: "parallel",
			execute: async (_toolCallId, params, signal) => {
				if (!isRecord(params) || typeof params.uri !== "string") {
					throw new Error("uri is required");
				}
				const server = typeof params.server === "string" ? params.server : undefined;
				const uri = params.uri;
				const { results: attempts, errors } = await this.forSelectedConnections(server, async (connection) => {
					const result = await connection.readResource(uri, signal);
					return { server: connection.name, result };
				});
				const successful = attempts[0];
				if (!successful) {
					throw new Error(`No MCP server could read resource: ${uri}`);
				}
				return {
					content: resourceContentsToPiContent(successful.result),
					details: { ...successful, errors: errors.length > 0 ? errors : undefined },
				};
			},
		});
	}

	private readListParams(params: unknown): { server?: string; cursor?: string } {
		if (!isRecord(params)) return {};
		return {
			server: typeof params.server === "string" ? params.server : undefined,
			cursor: typeof params.cursor === "string" ? params.cursor : undefined,
		};
	}

	private async forSelectedConnections<T>(
		server: string | undefined,
		fn: (connection: McpServerConnection) => Promise<T>,
	): Promise<{ results: T[]; errors: string[] }> {
		const all = Array.from(this.connections.values());
		const selected = server
			? [this.getConnectionOrThrow(server)]
			: all.filter((connection) => connection.status !== "failed");
		const results: T[] = [];
		const errors: string[] = [];
		await Promise.all(
			selected.map(async (connection) => {
				try {
					results.push(await fn(connection));
				} catch (error) {
					errors.push(`${connection.name}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}),
		);
		if (results.length === 0 && errors.length > 0) {
			throw new Error(errors.join("\n"));
		}
		// A cooling server is reported instead of silently omitted, but its request
		// is never attempted here: connecting would block for the full
		// startupTimeoutMs (20s) and stall the whole listing.
		const cooling =
			server === undefined
				? all
						.filter((connection) => connection.breakerRemainingMs() > 0)
						.map((connection) => `${connection.name}: ${connection.describeBreaker()}`)
				: [];
		return { results, errors: [...errors, ...cooling] };
	}

	private getConnectionOrThrow(server: string): McpServerConnection {
		const connection = this.connections.get(server);
		if (!connection) {
			throw new Error(`Unknown MCP server: ${server}`);
		}
		return connection;
	}
}

export function createMcpAdapterExtension(options: McpAdapterOptions = {}) {
	return function mcpAdapterExtension(pi: ExtensionAPI): void {
		new McpAdapter(options).register(pi);
	};
}
