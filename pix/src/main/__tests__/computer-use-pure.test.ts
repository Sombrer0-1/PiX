/**
 * Pure computer-use module tests.
 *
 * Covers the four Electron-free modules:
 * - context-budget.ts: the retention examples (4/5/6/7 screenshots -> 0/2/2/4 removed),
 *   same-instance no-op, non-computer / user images untouched, placeholder text.
 * - screenshot-codec.ts: as-is under budget, strict `<` boundary, same-dimension
 *   re-encode above budget, over_budget on dimension change or encode failure,
 *   and the "never changes pixel dimensions" invariant (real Photon round-trips).
 * - target-guard.ts: PiX pid / PiX focus rules, chordOf + isDangerousHotkey
 *   alias/order/case normalization, DANGEROUS_HOTKEYS table.
 * - desktop-lease.ts: mutual exclusion, holder touch, 60s idle auto-release with
 *   a fake clock, change notifications.
 *
 * Run with: npm exec tsx -- src/main/__tests__/computer-use-pure.test.ts
 */

import { deflateSync } from "node:zlib";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { COMPUTER_ACT_TOOL_NAME, COMPUTER_OBSERVE_TOOL_NAME } from "../../shared/computer-use-types.js";
import { applyScreenshotRetention, SCREENSHOT_PLACEHOLDER_PREFIX } from "../computer-use/context-budget.js";
import {
	ComputerUseError,
	type BackendImage,
	type DesktopLeaseState,
	type PixSurfaceProvider,
} from "../computer-use/contracts.js";
import { createDesktopLease } from "../computer-use/desktop-lease.js";
import { encodeScreenshotForModel } from "../computer-use/screenshot-codec.js";
import { chordOf, createTargetGuard, DANGEROUS_HOTKEYS, isDangerousHotkey } from "../computer-use/target-guard.js";

// ============================================================================
// Test harness (todo-ipc.test.ts style)
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

function assertSelfTarget(fn: () => void, message: string): void {
	try {
		fn();
		failed++;
		console.error(`  FAIL: ${message} - expected ComputerUseError("self_target")`);
		return;
	} catch (error: unknown) {
		const ok =
			error instanceof ComputerUseError &&
			error.code === "self_target" &&
			error.message.startsWith("[computer_use:self_target] ") &&
			error.message.includes("\nHint: ");
		if (ok) {
			passed++;
			console.log(`  PASS: ${message}`);
		} else {
			failed++;
			console.error(`  FAIL: ${message} - got ${String(error)}`);
		}
	}
}

function assertNoThrow(fn: () => void, message: string): void {
	try {
		fn();
		passed++;
		console.log(`  PASS: ${message}`);
	} catch (error: unknown) {
		failed++;
		console.error(`  FAIL: ${message} - unexpected throw: ${String(error)}`);
	}
}

async function run(name: string, fn: () => Promise<void>): Promise<void> {
	console.log(`\n=== ${name} ===\n`);
	try {
		await fn();
	} catch (error: unknown) {
		failed++;
		console.error(`  FAIL: ${name} threw unexpectedly: ${String(error)}`);
	}
}

// ============================================================================
// Fixtures
// ============================================================================

interface ComputerResultOptions {
	images?: number;
	captureId?: string;
	toolName?: string;
}

/** One computer_observe/computer_act toolResult: leading text item plus N images. */
function computerResult(callIndex: number, opts: ComputerResultOptions = {}): AgentMessage {
	const images = opts.images ?? 1;
	return {
		role: "toolResult",
		toolCallId: `call-${callIndex}`,
		toolName: opts.toolName ?? (callIndex % 2 === 0 ? COMPUTER_OBSERVE_TOOL_NAME : COMPUTER_ACT_TOOL_NAME),
		content: [
			{ type: "text", text: `output ${callIndex}` },
			...Array.from({ length: images }, (_, imageIndex) => ({
				type: "image" as const,
				data: `image-data-${callIndex}-${imageIndex}`,
				mimeType: "image/png",
			})),
		],
		...(opts.captureId !== undefined ? { details: { captureId: opts.captureId } } : {}),
		isError: false,
		timestamp: callIndex,
	};
}

function userMessageWithImage(): AgentMessage {
	return {
		role: "user",
		content: [
			{ type: "text", text: "look at this" },
			{ type: "image", data: "user-image-data", mimeType: "image/png" },
		],
		timestamp: -1,
	};
}

function imageCount(message: AgentMessage): number {
	if (message.role !== "toolResult" && message.role !== "user" && message.role !== "assistant") return 0;
	const content = message.content;
	if (!Array.isArray(content)) return 0;
	let count = 0;
	for (const item of content) if (item.type === "image") count++;
	return count;
}

function totalImages(messages: AgentMessage[]): number {
	return messages.reduce((sum, message) => sum + imageCount(message), 0);
}

function messageText(message: AgentMessage): string {
	if (message.role !== "toolResult") return "";
	const texts: string[] = [];
	for (const item of message.content) if (item.type === "text") texts.push(item.text);
	return texts.join("\n");
}

/** Minimal PNG-less image payload: the codec only reads `data`, `mimeType`, width, height. */
function fakeImage(data: string, width = 8, height = 6): BackendImage {
	return { data, mimeType: "image/png", width, height };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		let value = (crc ^ byte) & 0xff;
		for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		crc = (crc >>> 8) ^ value;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(typeAndData), 0);
	return Buffer.concat([length, typeAndData, checksum]);
}

/** Deterministic noise PNG (8-bit truecolor) that JPEG re-encoding can shrink below budget. */
function makeNoisePng(width: number, height: number): Buffer {
	const stride = 1 + width * 3;
	const raw = Buffer.alloc(height * stride);
	for (let y = 0; y < height; y++) {
		const rowStart = y * stride;
		raw[rowStart] = 0; // filter type: none
		for (let x = 0; x < width; x++) {
			const offset = rowStart + 1 + x * 3;
			raw[offset] = (x * 7919 + y * 104729) % 251;
			raw[offset + 1] = (x * 31 + y * 17) % 241;
			raw[offset + 2] = (x * x + y * y) % 239;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type: truecolor
	return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

const NOISE_PNG_256 = makeNoisePng(256, 256);
const NOISE_256: BackendImage = {
	data: NOISE_PNG_256.toString("base64"),
	mimeType: "image/png",
	width: 256,
	height: 256,
};

function pixProvider(pids: number[], focused: boolean): PixSurfaceProvider {
	return { getPixPids: () => [...pids], isPixFocused: () => focused };
}

interface FakeTimer {
	id: number;
	at: number;
	fn: () => void;
	cleared: boolean;
}

function createFakeClock(startTime = 1_000) {
	let current = startTime;
	let nextId = 1;
	const timers: FakeTimer[] = [];
	return {
		now: () => current,
		setTimer: ((fn: () => void, ms?: number) => {
			const timer: FakeTimer = { id: nextId++, at: current + (ms ?? 0), fn, cleared: false };
			timers.push(timer);
			return timer.id;
		}) as unknown as typeof setTimeout,
		clearTimer: ((id: unknown) => {
			for (const timer of timers) if (timer.id === id) timer.cleared = true;
		}) as unknown as typeof clearTimeout,
		advance: (ms: number) => {
			current += ms;
			for (const timer of [...timers]) {
				if (!timer.cleared && timer.at <= current) {
					timer.cleared = true;
					timer.fn();
				}
			}
		},
		/** Delays of armed timers, relative to "now" (used to read the default idle window). */
		pendingDelays: () => timers.filter((timer) => !timer.cleared).map((timer) => timer.at - current),
	};
}

function stateJson(state: DesktopLeaseState): string {
	return JSON.stringify(state);
}

// ============================================================================
// context-budget.ts
// ============================================================================

await run("context-budget: retention examples (keepRecent=3, chunk=2)", async () => {
	const policy = { keepRecent: 3, chunk: 2 };
	assertEqual(
		SCREENSHOT_PLACEHOLDER_PREFIX,
		"[earlier computer screenshot removed to save context",
		"SCREENSHOT_PLACEHOLDER_PREFIX matches §4.9",
	);

	{
		const messages = [0, 1, 2, 3].map((index) => computerResult(index, { captureId: `cap-${index}` }));
		const result = applyScreenshotRetention(messages, policy);
		assert(result === messages, "4 screenshots -> same array instance (remove 0)");
		assertEqual(totalImages(result), 4, "4 screenshots -> all 4 images survive");
	}
	{
		const messages = [0, 1, 2, 3, 4].map((index) => computerResult(index, { captureId: `cap-${index}` }));
		const result = applyScreenshotRetention(messages, policy);
		assert(result !== messages, "5 screenshots -> new array (remove 2)");
		assertEqual(totalImages(result), 3, "5 screenshots -> 3 images survive");
		assertEqual(imageCount(result[0]), 0, "5 screenshots -> oldest message image removed");
		assertEqual(imageCount(result[1]), 0, "5 screenshots -> second-oldest message image removed");
		assertEqual(imageCount(result[2]), 1, "5 screenshots -> third-oldest image kept");
		assertEqual(imageCount(result[3]), 1, "5 screenshots -> fourth image kept");
		assertEqual(imageCount(result[4]), 1, "5 screenshots -> newest image kept");
		assert(result[4] === messages[4], "5 screenshots -> untouched newest message keeps object identity");
		assertEqual(
			messageText(result[0]),
			`output 0\n${SCREENSHOT_PLACEHOLDER_PREFIX}; capture_id=cap-0]`,
			"5 screenshots -> oldest placeholder text with capture_id",
		);
		assertEqual(
			messageText(result[1]),
			`output 1\n${SCREENSHOT_PLACEHOLDER_PREFIX}; capture_id=cap-1]`,
			"5 screenshots -> second placeholder text with capture_id",
		);
	}
	{
		const messages = [0, 1, 2, 3, 4, 5].map((index) => computerResult(index));
		const result = applyScreenshotRetention(messages, policy);
		assertEqual(totalImages(result), 4, "6 screenshots -> remove 2, keep 4");
		assertEqual(imageCount(result[0]), 0, "6 screenshots -> oldest image removed");
		assertEqual(imageCount(result[1]), 0, "6 screenshots -> second image removed");
		assertEqual(imageCount(result[2]), 1, "6 screenshots -> third image kept");
	}
	{
		const messages = [0, 1, 2, 3, 4, 5, 6].map((index) => computerResult(index));
		const result = applyScreenshotRetention(messages, policy);
		assertEqual(totalImages(result), 3, "7 screenshots -> remove 4, keep 3");
		assertEqual(imageCount(result[0]), 0, "7 screenshots -> first image removed");
		assertEqual(imageCount(result[3]), 0, "7 screenshots -> fourth image removed");
		assertEqual(imageCount(result[4]), 1, "7 screenshots -> fifth image kept");
		assertEqual(imageCount(result[6]), 1, "7 screenshots -> newest image kept");
	}
	{
		// chunk rounding: excess 3 rounds down to 2 (allow keepRecent + chunk - 1 to survive)
		const messages = [0, 1, 2, 3, 4].map((index) => computerResult(index));
		const result = applyScreenshotRetention(messages, { keepRecent: 2, chunk: 2 });
		assertEqual(totalImages(result), 3, "keepRecent=2, chunk=2, 5 screenshots -> remove 2 (not 3)");
	}
	{
		const messages = [0, 1, 2, 3].map((index) => computerResult(index));
		const result = applyScreenshotRetention(messages, { keepRecent: 1, chunk: 2 });
		assertEqual(totalImages(result), 2, "keepRecent=1, chunk=2, 4 screenshots -> remove 2, keep 2");
	}
	{
		const messages = Array.from({ length: 8 }, (_, index) => computerResult(index));
		const result = applyScreenshotRetention(messages, policy);
		assertEqual(totalImages(result), 4, "8 screenshots -> remove 4, keep 4");
	}
});

await run("context-budget: no-op paths keep the same array instance", async () => {
	assert(
		applyScreenshotRetention([], { keepRecent: 3, chunk: 2 }).length === 0,
		"empty message list stays empty",
	);

	const noComputerImages: AgentMessage[] = [
		userMessageWithImage(),
		{ role: "assistant", content: [{ type: "text", text: "hi" }], api: "anthropic", provider: "anthropic", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 },
		computerResult(9, { images: 0 }),
		computerResult(10, { toolName: "read", images: 2 }),
	];
	assert(
		applyScreenshotRetention(noComputerImages, { keepRecent: 3, chunk: 2 }) === noComputerImages,
		"no computer screenshots -> same array instance",
	);

	const exactlyKeepRecent = [0, 1, 2].map((index) => computerResult(index));
	assert(
		applyScreenshotRetention(exactlyKeepRecent, { keepRecent: 3, chunk: 2 }) === exactlyKeepRecent,
		"exactly keepRecent screenshots -> same array instance",
	);
});

await run("context-budget: never touches user or non-computer images, preserves structure", async () => {
	const messages: AgentMessage[] = [
		userMessageWithImage(),
		computerResult(0, { captureId: "cap-0" }),
		computerResult(1),
		computerResult(2),
		computerResult(3),
		computerResult(4),
		computerResult(5),
		computerResult(6),
		computerResult(7, { toolName: "read", images: 2 }),
	];
	const result = applyScreenshotRetention(messages, { keepRecent: 3, chunk: 2 });

	assertEqual(result.length, messages.length, "message count unchanged");
	assertEqual(imageCount(result[0]), 1, "user message image untouched");
	assert(result[0] === messages[0], "user message object identity preserved");
	assertEqual(imageCount(result[8]), 2, "non-computer tool images untouched");
	assert(result[8] === messages[8], "non-computer tool result object identity preserved");
	assertEqual(totalImages(result), 3 + 1 + 2, "only the 4 oldest computer screenshots were removed");
	assertEqual(imageCount(result[1]), 0, "oldest computer screenshot removed");
	assertEqual(result[2].role === "toolResult" ? result[2].toolCallId : "", "call-1", "toolCallId preserved");
	assertEqual(result[2].role === "toolResult" ? result[2].timestamp : -1, 1, "timestamp preserved");
	assert(messageText(result[2]).startsWith("output 1\n"), "leading text item preserved on rewritten messages");
	assertEqual(
		result[2].role === "toolResult" && result[2].isError,
		false,
		"isError flag preserved on rewritten messages",
	);
});

await run("context-budget: multiple images inside one message are replaced in place", async () => {
	const messages: AgentMessage[] = [
		computerResult(0, { images: 5, captureId: "cap-multi" }),
		computerResult(1),
	];
	const result = applyScreenshotRetention(messages, { keepRecent: 3, chunk: 2 });

	assertEqual(result.length, 2, "message list length unchanged");
	const first = result[0];
	assert(first.role === "toolResult", "first message remains a toolResult");
	if (first.role === "toolResult") {
		assertEqual(first.content.length, 6, "content item count unchanged (1 text + 5 images)");
		assertEqual(first.content[0].type, "text", "leading text item stays first");
		assertEqual(first.content[1].type, "text", "oldest image replaced by text in place");
		assertEqual(first.content[2].type, "text", "second image replaced by text in place");
		assertEqual(first.content[3].type, "image", "third image kept");
		assertEqual(first.content[5].type, "image", "newest image kept");
		assertEqual(
			first.content[1].type === "text" ? first.content[1].text : "",
			`${SCREENSHOT_PLACEHOLDER_PREFIX}; capture_id=cap-multi]`,
			"in-place placeholder carries the message capture_id",
		);
	}
	assertEqual(totalImages(result), 3 + 1, "3 newest images of the batch survive");
});

await run("context-budget: capture_id falls back to n/a", async () => {
	const messages = [0, 1, 2, 3, 4].map((index) => computerResult(index, index % 2 === 0 ? { captureId: `cap-${index}` } : {}));
	const result = applyScreenshotRetention(messages, { keepRecent: 3, chunk: 2 });
	assertEqual(
		messageText(result[1]),
		`output 1\n${SCREENSHOT_PLACEHOLDER_PREFIX}; capture_id=n/a]`,
		"missing details.captureId -> capture_id=n/a",
	);
});

// ============================================================================
// screenshot-codec.ts
// ============================================================================

await run("screenshot-codec: within budget returns the input untouched", async () => {
	const data = Buffer.from("tiny-fake-image-bytes").toString("base64");
	const image = fakeImage(data, 12, 7);
	const result = await encodeScreenshotForModel(image, data.length + 1);
	assert(result.ok === true, "under budget -> ok");
	if (result.ok) {
		assert(result.data === image.data, "under budget -> original base64 data returned as-is");
		assertEqual(result.mimeType, image.mimeType, "under budget -> mimeType passthrough");
		assertEqual(result.width, 12, "under budget -> width passthrough");
		assertEqual(result.height, 7, "under budget -> height passthrough");
		assertEqual(result.bytes, data.length, "under budget -> bytes = base64 length");
	}
});

await run("screenshot-codec: budget check is strict (<) and failures report the input size", async () => {
	const data = Buffer.from("tiny-fake-image-bytes").toString("base64");
	const result = await encodeScreenshotForModel(fakeImage(data), data.length);
	assert(result.ok === false, "base64 length === maxBytes -> not treated as within budget");
	if (!result.ok) {
		assertEqual(result.reason, "over_budget", "boundary miss -> over_budget");
		assertEqual(result.bytes, data.length, "over_budget -> bytes = input base64 length");
	}

	// Invalid bytes cannot be decoded: encode fails -> over_budget, never throws.
	const garbage = await encodeScreenshotForModel(fakeImage("bm90IGFuIGltYWdlLCBqdXN0IHRleHQ="), 10);
	assert(garbage.ok === false, "undecodable image -> over_budget (null from resizeImage)");
	if (!garbage.ok) {
		assertEqual(garbage.bytes, "bm90IGFuIGltYWdlLCBqdXN0IHRleHQ=".length, "undecodable -> bytes = input base64 length");
	}
});

await run("screenshot-codec: real PNG re-encodes at the same dimensions under budget", async () => {
	const inputLength = NOISE_256.data.length;
	const result = await encodeScreenshotForModel(NOISE_256, 120_000);
	assert(result.ok === true, "over budget but encodable -> ok");
	if (result.ok) {
		assertEqual(result.width, 256, "re-encode -> width unchanged");
		assertEqual(result.height, 256, "re-encode -> height unchanged");
		assert(result.bytes < 120_000, "re-encode -> bytes strictly below maxBytes");
		assert(result.bytes < inputLength, "re-encode -> smaller than the original payload");
		assert(result.data !== NOISE_256.data, "re-encode -> payload was actually re-encoded");
		assert(
			result.mimeType === "image/png" || result.mimeType === "image/jpeg",
			"re-encode -> mimeType is a supported raster encoding",
		);
	}
});

await run("screenshot-codec: over budget, never changes dimensions (sweep)", async () => {
	const budgets = [64, 1_000, 20_000, 400_000];
	let sawOk = false;
	let sawOverBudget = false;
	for (const maxBytes of budgets) {
		const result = await encodeScreenshotForModel(NOISE_256, maxBytes);
		if (result.ok) {
			sawOk = true;
			assertEqual(result.width, NOISE_256.width, `maxBytes=${maxBytes}: ok result keeps width`);
			assertEqual(result.height, NOISE_256.height, `maxBytes=${maxBytes}: ok result keeps height`);
			assert(result.bytes < maxBytes, `maxBytes=${maxBytes}: ok result is strictly under budget`);
		} else {
			sawOverBudget = true;
			assertEqual(result.reason, "over_budget", `maxBytes=${maxBytes}: failure reason is over_budget`);
			assertEqual(result.bytes, NOISE_256.data.length, `maxBytes=${maxBytes}: failure reports the input size`);
		}
	}
	assert(sawOk, "sweep -> at least one budget fits at the original dimensions");
	assert(sawOverBudget, "sweep -> at least one budget is rejected instead of being shrunk");

	const huge = await encodeScreenshotForModel(NOISE_256, NOISE_256.data.length + 1);
	assert(huge.ok === true && huge.data === NOISE_256.data, "one byte above the payload -> returned as-is");
});

// ============================================================================
// target-guard.ts
// ============================================================================

await run("target-guard: isDangerousHotkey normalization", async () => {
	assertEqual(isDangerousHotkey(["F4", "Alt"]), true, 'isDangerousHotkey(["F4","Alt"]) === true');
	assertEqual(isDangerousHotkey(["ctrl", "c"]), false, 'isDangerousHotkey(["ctrl","c"]) === false');
	assertEqual(isDangerousHotkey(["Alt", "f4"]), true, "order-insensitive");
	assertEqual(isDangerousHotkey(["ALT", "F4"]), true, "case-insensitive");
	assertEqual(isDangerousHotkey(["super", "q"]), true, "cmd≡super");
	assertEqual(isDangerousHotkey(["win", "q"]), true, "cmd≡win");
	assertEqual(isDangerousHotkey(["meta", "q"]), true, "cmd≡meta");
	assertEqual(isDangerousHotkey(["cmd", "option", "esc"]), true, "option≡alt and esc≡escape");
	assertEqual(isDangerousHotkey(["alt", "meta", "Escape"]), true, "alias mix matches cmd+option+escape");
	assertEqual(isDangerousHotkey(["super", "l"]), true, "win/linux lock chord");
	assertEqual(isDangerousHotkey(["control", "shift", "escape"]), true, "control≡ctrl");
	assertEqual(isDangerousHotkey([]), false, "empty chord is not dangerous");
	assertEqual(isDangerousHotkey(["alt", "f4", "shift"]), false, "superset does not match");
	assertEqual(isDangerousHotkey(["ctrl", "alt", "f4"]), false, "different chord does not match");
	assertEqual(isDangerousHotkey(["", "alt", "f4"]), true, "empty tokens are dropped: ['', 'alt', 'f4'] still matches alt+f4");
	assertEqual(isDangerousHotkey(["alt", "", "", "f4"]), true, "multiple empty tokens are dropped");
	assertEqual(isDangerousHotkey([""]), false, "a chord of only empty tokens is not dangerous");
	assertEqual(
		JSON.stringify(DANGEROUS_HOTKEYS),
		JSON.stringify([
			["alt", "f4"], ["cmd", "q"], ["cmd", "w"], ["ctrl", "w"], ["ctrl", "alt", "delete"], ["ctrl", "shift", "escape"],
			["cmd", "option", "escape"], ["super", "l"], ["cmd", "ctrl", "q"], ["ctrl", "alt", "t"], ["super", "r"], ["cmd", "space"],
		]),
		"DANGEROUS_HOTKEYS matches the §4.10 table",
	);
	assert(DANGEROUS_HOTKEYS.every((chord) => isDangerousHotkey([...chord])), "every listed chord is dangerous");
	// Full-table enumeration: each of the 12 entries is dangerous on its own
	// (the table is the single source shared with the session controller).
	assertEqual(DANGEROUS_HOTKEYS.length, 12, "the dangerous table has 12 chords");
	for (const chord of DANGEROUS_HOTKEYS) {
		assertEqual(isDangerousHotkey([...chord]), true, `table entry [${chord.join(",")}] is dangerous`);
	}
	for (const chord of [["ctrl", "c"], ["alt", "tab"], ["cmd", "shift", "4"], ["a"], ["ctrl", "shift", "t"], ["alt", "f5"]] as const) {
		assertEqual(isDangerousHotkey([...chord]), false, `[${chord.join(",")}] is not dangerous`);
	}
});

await run("target-guard: chordOf", async () => {
	assertEqual(chordOf({ action: "press_key", key: "f4", modifiers: ["alt"] })?.join("+"), "alt+f4", "press_key -> [...modifiers, key]");
	assertEqual(chordOf({ action: "press_key", key: "F4" })?.join("+"), "F4", "press_key without modifiers");
	assertEqual(chordOf({ action: "hotkey", keys: ["ctrl", "alt", "t"] })?.join("+"), "ctrl+alt+t", "hotkey -> keys");
	assertEqual(chordOf({ action: "click", x: 1, y: 2 }), null, "click -> null");
	assertEqual(chordOf({ action: "wait" }), null, "wait -> null");
	assertEqual(chordOf({ action: "press_key" }), null, "press_key without key -> null");
	assertEqual(chordOf({ action: "hotkey", keys: [] }), null, "empty hotkey -> null");

	assertEqual(
		isDangerousHotkey(chordOf({ action: "press_key", key: "f4", modifiers: ["alt"] }) ?? []),
		true,
		"press_key + modifiers form of alt+f4 is dangerous",
	);
	assertEqual(
		isDangerousHotkey(chordOf({ action: "hotkey", keys: ["Alt", "F4"] }) ?? []),
		true,
		"hotkey form of alt+f4 is dangerous",
	);
	assertEqual(
		isDangerousHotkey(chordOf({ action: "type_text", text: "hi" }) ?? []),
		false,
		"type_text has no chord",
	);

	const keys = ["alt", "f4"];
	chordOf({ action: "hotkey", keys })?.push("shift");
	assertEqual(keys.length, 2, "chordOf returns a copy of keys");
});

await run("target-guard: PiX pid and focus rules", async () => {
	const guard = createTargetGuard(pixProvider([100, 101], false));

	assertSelfTarget(
		() => guard.assertActAllowed({ action: "click", pid: 100, window_id: 1, element_token: "s1a2b3c4:5" }),
		"act with PiX pid is rejected",
	);
	assertSelfTarget(() => guard.assertActAllowed({ action: "focus_window", pid: 101 }), "focus_window on a PiX pid is rejected");
	assertNoThrow(
		() => guard.assertActAllowed({ action: "click", pid: 4242, window_id: 7, element_token: "s1a2b3c4:5" }),
		"act on a non-PiX pid is allowed",
	);
	assertNoThrow(() => guard.assertActAllowed({ action: "type_text", text: "hi" }), "desktop typing is allowed while PiX is not focused");
	assertNoThrow(() => guard.assertActAllowed({ action: "hotkey", keys: ["ctrl", "alt", "t"] }), "hotkey is allowed while PiX is not focused");

	assertSelfTarget(() => guard.assertObserveAllowed({ view: "window", pid: 100, window_id: 1 }), "observe window on a PiX pid is rejected");
	assertSelfTarget(() => guard.assertObserveAllowed({ view: "zoom", pid: 101, window_id: 1, region: { x1: 0, y1: 0, x2: 1, y2: 1 } }), "observe zoom on a PiX pid is rejected");
	assertSelfTarget(() => guard.assertObserveAllowed({ view: "verify", pid: 100, window_id: 1, expect: [{}] }), "observe verify on a PiX pid is rejected");
	assertNoThrow(() => guard.assertObserveAllowed({ view: "desktop" }), "observe desktop has no pid to reject");
	assertNoThrow(() => guard.assertObserveAllowed({ view: "windows", pid: 100 }), "windows view pid is a filter, not a target");
	assertNoThrow(() => guard.assertObserveAllowed({ view: "window", pid: 4242, window_id: 7 }), "observe on a non-PiX pid is allowed");

	const focusedGuard = createTargetGuard(pixProvider([100], true));
	assertSelfTarget(() => focusedGuard.assertActAllowed({ action: "type_text", text: "hi" }), "focused: type_text without pid is rejected");
	assertSelfTarget(() => focusedGuard.assertActAllowed({ action: "press_key", key: "enter" }), "focused: press_key without pid is rejected");
	assertSelfTarget(() => focusedGuard.assertActAllowed({ action: "hotkey", keys: ["ctrl", "c"] }), "focused: hotkey without pid is rejected");
	// cua-driver 0.34.1 type_text requires pid and PiX forwards it, so a
	// non-PiX pid is a target even without an element_token.
	assertNoThrow(
		() => focusedGuard.assertActAllowed({ action: "type_text", text: "hi", pid: 4242 }),
		"focused: type_text with a non-PiX pid is allowed (pid is forwarded)",
	);
	assertNoThrow(
		() => focusedGuard.assertActAllowed({ action: "type_text", text: "hi", pid: 4242, window_id: 7, element_token: "s1a2b3c4d:5" }),
		"focused: type_text with element_token is directed and allowed",
	);
	// A token without a pid is still not "whatever is focused". The driver
	// then requires pid; that rejection happens at the driver, not here.
	assertNoThrow(
		() => focusedGuard.assertActAllowed({ action: "type_text", text: "hi", element_token: "s1a2b3c4d:5" }),
		"focused: type_text with element_token but no pid is still directed and allowed",
	);
	assertNoThrow(
		() => focusedGuard.assertActAllowed({ action: "press_key", key: "enter", pid: 4242 }),
		"focused: press_key with a non-PiX pid is allowed (pid is forwarded)",
	);
	assertSelfTarget(() => focusedGuard.assertActAllowed({ action: "click", x: 10, y: 20 }), "focused: token-less desktop click is rejected");
	assertSelfTarget(() => focusedGuard.assertActAllowed({ action: "double_click", x: 10, y: 20 }), "focused: token-less double_click is rejected");
	assertSelfTarget(() => focusedGuard.assertActAllowed({ action: "right_click", x: 10, y: 20 }), "focused: token-less right_click is rejected");
	assertNoThrow(() => focusedGuard.assertActAllowed({ action: "click", x: 10, y: 20, element_token: "s1a2b3c4:5" }), "focused: element_token click is allowed");
	assertNoThrow(() => focusedGuard.assertActAllowed({ action: "click", pid: 4242, window_id: 7, x: 10, y: 20 }), "focused: click with a target pid is allowed");
	assertNoThrow(() => focusedGuard.assertActAllowed({ action: "scroll", direction: "down" }), "focused: scroll is not focus-blocked");
	assertNoThrow(() => focusedGuard.assertActAllowed({ action: "wait", duration_ms: 100 }), "focused: wait is allowed");
});

// ============================================================================
// desktop-lease.ts
// ============================================================================

await run("desktop-lease: mutual exclusion and holder touch", async () => {
	const clock = createFakeClock(1_000);
	const lease = createDesktopLease({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

	assertEqual(lease.tryAcquire("gen-1"), true, "first holder acquires");
	assertEqual(stateJson(lease.getState()), stateJson({ holderId: "gen-1", acquiredAt: 1_000, lastUsedAt: 1_000 }), "state after acquire");
	assertEqual(lease.tryAcquire("gen-2"), false, "second holder is refused");
	assertEqual(stateJson(lease.getState()), stateJson({ holderId: "gen-1", acquiredAt: 1_000, lastUsedAt: 1_000 }), "refused acquire leaves state untouched");
	lease.release("gen-2");
	assertEqual(lease.getState().holderId, "gen-1", "non-holder release is a no-op");

	clock.advance(30_000);
	assertEqual(lease.tryAcquire("gen-1"), true, "holder re-acquire succeeds");
	assertEqual(stateJson(lease.getState()), stateJson({ holderId: "gen-1", acquiredAt: 1_000, lastUsedAt: 31_000 }), "re-acquire touches lastUsedAt, keeps acquiredAt");

	lease.release("gen-1");
	assertEqual(stateJson(lease.getState()), stateJson({ holderId: null, acquiredAt: null, lastUsedAt: null }), "holder release frees the lease");
	assertEqual(lease.tryAcquire("gen-2"), true, "another holder can acquire after release");
});

await run("desktop-lease: 60s idle auto-release (injected clock)", async () => {
	const clock = createFakeClock(5_000);
	const lease = createDesktopLease({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
	const states: DesktopLeaseState[] = [];
	const unsubscribe = lease.onChange((state) => states.push(state));

	assertEqual(lease.tryAcquire("gen-9"), true, "acquire");
	assertEqual(clock.pendingDelays().join(","), "60000", "default idleReleaseMs is 60_000");
	assertEqual(states.length, 1, "acquire notifies listeners");

	clock.advance(59_999);
	assertEqual(lease.getState().holderId, "gen-9", "still held one millisecond before the idle window");
	clock.advance(1);
	assertEqual(stateJson(lease.getState()), stateJson({ holderId: null, acquiredAt: null, lastUsedAt: null }), "idle release after 60s");
	assertEqual(states.length, 2, "idle release notifies listeners");
	assertEqual(states[1].holderId, null, "notification carries the released state");
	assertEqual(lease.tryAcquire("gen-9"), true, "holder can re-acquire after an idle release");
	assertEqual(clock.pendingDelays().join(","), "60000", "re-acquire re-arms the idle timer");

	lease.forceRelease();
	assertEqual(states.length, 4, "forceRelease notifies a held lease");
	lease.forceRelease();
	assertEqual(states.length, 4, "forceRelease on a free lease does not notify");
	assertEqual(clock.pendingDelays().length, 0, "idle timer cleared on release");
	unsubscribe();
	assertEqual(states.length, 4, "unsubscribed listener stops receiving states");
});

await run("desktop-lease: touch re-arms the idle window, custom idleReleaseMs", async () => {
	const clock = createFakeClock(0);
	const lease = createDesktopLease({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

	lease.tryAcquire("gen-1");
	clock.advance(50_000);
	assertEqual(lease.tryAcquire("gen-1"), true, "heartbeat inside the idle window");
	clock.advance(50_000);
	assertEqual(lease.getState().holderId, "gen-1", "heartbeat pushed the idle deadline out");
	clock.advance(10_000);
	assertEqual(lease.getState().holderId, null, "released 60s after the last heartbeat");

	const custom = createDesktopLease({ idleReleaseMs: 1_000, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
	custom.tryAcquire("gen-2");
	assertEqual(clock.pendingDelays().join(","), "1000", "custom idleReleaseMs is honored");
	clock.advance(999);
	assertEqual(custom.getState().holderId, "gen-2", "custom window not yet elapsed");
	clock.advance(1);
	assertEqual(custom.getState().holderId, null, "custom window elapsed -> released");

	const notifications: string[] = [];
	const other = createDesktopLease({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
	const stop = other.onChange((state) => notifications.push(state.holderId ?? "free"));
	other.tryAcquire("gen-3");
	other.tryAcquire("gen-4");
	other.release("gen-3");
	stop();
	other.forceRelease();
	assertEqual(notifications.join(","), "gen-3,free", "listener sees acquire + release, then unsubscribes");
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
	process.exit(1);
}
