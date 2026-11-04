/**
 * Fake cua-driver child process for the mcp-driver-client tests.
 *
 * A real MCP stdio server (McpServer + StdioServerTransport from `@modelcontextprotocol/sdk`)
 * that mimics the parts of cua-driver 0.34.1 the client depends on:
 *   - tools/list with a realistic inputSchema (`required` / `properties`) and outputSchema;
 *   - structuredContent that intentionally violates the declared outputSchema (extra property,
 *     i.e. driver schema drift) so a successful call proves the client's pass-through validator;
 *   - every tool from `DRIVER_TOOL_ALLOWLIST` (so callTool's allowlist / tool-list guards work);
 *   - configurable per-call delays, error results, handshake delays and process exits.
 *
 * Configuration (all optional, read from the child environment — the client passes the parent env):
 *   FAKE_DRIVER_REPORT              path of an append-only JSONL log (one line per lifecycle
 *                                   event and per tool call, phase "call" with name + args)
 *   FAKE_DRIVER_OMIT_TOOLS          comma-separated tool names left out of tools/list
 *   FAKE_DRIVER_DELAYS              "tool=ms,tool=ms" per-call delay before answering
 *   FAKE_DRIVER_ERROR_TOOLS         comma-separated tool names that answer with isError: true
 *   FAKE_DRIVER_HANDSHAKE_DELAY_MS  delay before the MCP transport is connected
 *   FAKE_DRIVER_CRASH_FILE          file path; when the file exists the process exits(9) and deletes
 *                                   it, giving tests a deterministic crash trigger (idle or mid-call)
 *   FAKE_DRIVER_OMIT_STRUCTURED_CONTENT  when "1", tools that declare an outputSchema succeed
 *                                   WITHOUT structuredContent (proves the client skips the SDK's
 *                                   "output schema but no structured content" guard too)
 *
 * Run directly with node (no shebang: Windows cannot exec extensionless/shebang files directly, the
 * tests spawn `process.execPath` with this path, or the extensionless `mcp` entry next to it).
 */

import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

/** 1x1 transparent PNG, the smallest thing a driver-like image result can carry. */
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const session = { session: z.string().optional() };

/**
 * Tool catalogue: the 22 tools of `DRIVER_TOOL_ALLOWLIST` plus 2 extra (`get_screen_size`,
 * `health_report`) that PiX never calls, mirroring the real driver surface (62 tools).
 * `output` tools declare an outputSchema and answer with `sample` plus an extra property that the
 * declared schema does not allow (additionalProperties: false) — schema drift on purpose.
 * `validate` tools have no inputSchema-level `required` for their either/or argument groups and
 * enforce them in the handler instead (isError result), matching the cua-driver contract tools
 * that accept "element_token OR x,y" style alternatives.
 */
const TOOL_SPECS = [
	{ name: "start_session", input: { label: z.string(), ...session } },
	{ name: "end_session", input: { ...session } },
	{ name: "check_permissions", input: { prompt: z.boolean().optional(), ...session } },
	{ name: "get_screen_size", input: { ...session } },
	{ name: "health_report", input: { ...session } },
	{ name: "list_apps", input: { query: z.string().optional(), ...session }, output: { apps: z.array(z.string()) }, sample: { apps: ["Files", "Terminal"] } },
	{ name: "list_windows", input: { pid: z.number().optional(), on_screen_only: z.boolean().optional(), ...session } },
	{
		name: "get_window_state",
		input: { pid: z.number(), window_id: z.number(), query: z.string().optional(), max_elements: z.number().optional(), max_image_dimension: z.number().optional(), session: z.string().optional() },
		output: { capture_id: z.string(), snapshot_id: z.string(), screenshot_width: z.number(), screenshot_height: z.number(), truncated: z.boolean() },
		sample: { capture_id: "fake-cap-1", snapshot_id: "fake-snap-1", screenshot_width: 800, screenshot_height: 600, truncated: false },
		image: true,
	},
	{
		name: "get_desktop_state",
		input: { max_image_dimension: z.number().optional(), ...session },
		output: { capture_id: z.string(), screenshot_width: z.number(), screenshot_height: z.number(), display: z.string() },
		sample: { capture_id: "fake-cap-2", screenshot_width: 960, screenshot_height: 600, display: "primary" },
		image: true,
	},
	{ name: "zoom", input: { pid: z.number(), window_id: z.number(), x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), ...session } },
	{ name: "verify_state", input: { pid: z.number().optional(), window_id: z.number().optional(), ...session } },
	{
		name: "click",
		input: { element_token: z.string().optional(), x: z.number().optional(), y: z.number().optional(), coordinate_frame: z.enum(["window", "desktop"]).optional(), ...session },
		output: { summary: z.string() },
		sample: { summary: "clicked" },
		validate: (args) =>
			args.element_token !== undefined || (args.x !== undefined && args.y !== undefined)
				? null
				: "click requires either element_token or both x and y",
	},
	{ name: "double_click", input: { x: z.number(), y: z.number(), ...session } },
	{ name: "right_click", input: { x: z.number(), y: z.number(), ...session } },
	{ name: "type_text", input: { text: z.string(), delivery: z.enum(["background", "foreground"]).optional(), ...session }, output: { summary: z.string() }, sample: { summary: "typed" } },
	{ name: "press_key", input: { key: z.string(), modifiers: z.array(z.string()).optional(), ...session }, output: { summary: z.string() }, sample: { summary: "pressed" } },
	{ name: "hotkey", input: { keys: z.array(z.string()), ...session }, output: { summary: z.string() }, sample: { summary: "hotkey" } },
	{ name: "scroll", input: { direction: z.enum(["up", "down", "left", "right"]), amount: z.number().optional(), x: z.number().optional(), y: z.number().optional(), pid: z.number().optional(), window_id: z.number().optional(), ...session }, output: { summary: z.string() }, sample: { summary: "scrolled" } },
	{ name: "drag", input: { from_x: z.number(), from_y: z.number(), to_x: z.number(), to_y: z.number(), pid: z.number().optional(), window_id: z.number().optional(), ...session } },
	{ name: "move_cursor", input: { x: z.number(), y: z.number(), ...session } },
	{ name: "set_value", input: { pid: z.number(), value: z.string(), element_token: z.string().optional(), window_id: z.number().optional(), ...session } },
	{ name: "invoke_menu", input: { pid: z.number(), window_id: z.number(), path: z.array(z.string()), ...session } },
	{ name: "launch_app", input: { name: z.string(), urls: z.array(z.string()).optional(), ...session } },
	{ name: "bring_to_front", input: { pid: z.number().optional(), window_id: z.number().optional(), ...session } },
];

function parseSet(value) {
	return new Set((value ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0));
}

function parseDelays(value) {
	const delays = new Map();
	for (const entry of (value ?? "").split(",")) {
		const [name, ms] = entry.split("=");
		if (name && ms && Number.isFinite(Number(ms))) {
			delays.set(name.trim(), Number(ms));
		}
	}
	return delays;
}

/** Log lifecycle events to the JSONL report file, when the test asked for one. */
function report(phase, extra) {
	const file = process.env.FAKE_DRIVER_REPORT;
	if (!file) {
		return;
	}
	try {
		fs.appendFileSync(file, `${JSON.stringify({ phase, pid: process.pid, time: Date.now(), ...extra })}\n`);
	} catch {
		// Reporting is diagnostics only; never let it break the fake driver.
	}
}

/** Subset of the child environment the tests assert on (sanitised parent-env inheritance). */
function pickEnv(env) {
	const picked = { envCount: Object.keys(env).length };
	for (const [key, value] of Object.entries(env)) {
		if (/^(PIX_TEST|CUA_DRIVER|DO_NOT_TRACK|FAKE_DRIVER)/.test(key) || key === "DISPLAY" || key === "WAYLAND_DISPLAY" || key === "XDG_SESSION_TYPE") {
			picked[key] = value;
		}
	}
	return picked;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const omitTools = parseSet(process.env.FAKE_DRIVER_OMIT_TOOLS);
const delays = parseDelays(process.env.FAKE_DRIVER_DELAYS);
const errorTools = parseSet(process.env.FAKE_DRIVER_ERROR_TOOLS);
const omitStructuredContent = process.env.FAKE_DRIVER_OMIT_STRUCTURED_CONTENT === "1";

const server = new McpServer({ name: "fake-cua-driver", version: "0.1.0-fake" }, { capabilities: { tools: {} } });

if (omitStructuredContent) {
	// The SDK server has its own "declared outputSchema requires structuredContent" guard
	// (server/mcp.js validateToolOutput -> isError result). Bypass it so a SUCCESS result without
	// structuredContent actually reaches the wire: a real driver (the Rust cua-driver) has no such
	// server-side guard, and it is the CLIENT-side SDK guard that the tests exercise.
	server.validateToolOutput = async () => {};
}

for (const spec of TOOL_SPECS) {
	if (omitTools.has(spec.name)) {
		continue;
	}
	const config = { description: `fake ${spec.name} (test double, no real input)` };
	if (spec.input) {
		config.inputSchema = spec.input;
	}
	if (spec.output) {
		config.outputSchema = spec.output;
	}
	server.registerTool(spec.name, config, async (args) => {
		report("call", { name: spec.name, args });
		const delay = delays.get(spec.name) ?? 0;
		if (delay > 0) {
			await sleep(delay);
		}
		if (errorTools.has(spec.name)) {
			return { content: [{ type: "text", text: `fake ${spec.name} failed on purpose` }], isError: true };
		}
		if (spec.validate) {
			const problem = spec.validate(args);
			if (problem) {
				return { content: [{ type: "text", text: `fake ${spec.name} invalid input: ${problem}` }], isError: true };
			}
		}
		const content = [{ type: "text", text: `fake ${spec.name} ok ${JSON.stringify(args)}` }];
		if (spec.image) {
			content.push({ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
		}
		const result = { content };
		if (spec.output && !omitStructuredContent) {
			// Deliberate schema drift: the declared outputSchema forbids additional properties.
			result.structuredContent = { ...spec.sample, driver_unexpected_field: "schema drift" };
		}
		return result;
	});
}

// Deterministic crash trigger: the test creates the file, the driver exits and consumes it.
const crashFile = process.env.FAKE_DRIVER_CRASH_FILE;
if (crashFile) {
	setInterval(() => {
		if (!fs.existsSync(crashFile)) {
			return;
		}
		try {
			fs.unlinkSync(crashFile);
		} catch {
			// Ignore: exit anyway, the trigger only has to fire once.
		}
		report("crash", { reason: "crash_file" });
		process.stderr.write("[fake-cua-driver] crash trigger detected, exiting with code 9\n");
		process.exit(9);
	}, 20);
}

// Exit when the parent closes our stdin (transport.close()) so tests leave no orphan processes.
process.stdin.on("close", () => {
	report("stdin_closed");
	process.exit(0);
});

report("start", {
	argv: process.argv.slice(1),
	node: process.version,
	cwd: process.cwd(),
	tools: TOOL_SPECS.filter((spec) => !omitTools.has(spec.name)).map((spec) => spec.name),
	env: pickEnv(process.env),
});

const handshakeDelayMs = Number(process.env.FAKE_DRIVER_HANDSHAKE_DELAY_MS ?? "0");
if (Number.isFinite(handshakeDelayMs) && handshakeDelayMs > 0) {
	await sleep(handshakeDelayMs);
}

// clientInfo of the initialize handshake (name + version the client sent), reported when the
// client's `notifications/initialized` arrives — strictly before client connect() resolves.
server.server.oninitialized = () => {
	report("initialized", { clientInfo: server.server.getClientVersion() });
};

await server.connect(new StdioServerTransport());
report("connected");
