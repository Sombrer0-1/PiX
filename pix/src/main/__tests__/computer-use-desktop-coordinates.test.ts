import assert from "node:assert/strict";
import { test } from "node:test";
import { ComputerUseError } from "../computer-use/contracts.js";
import { DesktopCoordinateMapper } from "../computer-use/desktop-coordinate-mapper.js";

const DESKTOP = {
	screenshot_width: 1568,
	screenshot_height: 882,
	screen_width: 1920,
	screen_height: 1080,
	capture_id: "desktop-1",
};

test("desktop screenshot pixels map to physical screen pixels for each native pointer route", () => {
	const mapper = new DesktopCoordinateMapper();
	mapper.record("a", DESKTOP);
	for (const action of ["click", "scroll", "move_cursor"] as const) {
		const args = { x: 784, y: 441, scope: "desktop" };
		assert.deepEqual(mapper.map("a", { action, x: 784, y: 441 }, args), { x: 960, y: 540, scope: "desktop" });
		assert.deepEqual(args, { x: 784, y: 441, scope: "desktop" });
	}
	assert.deepEqual(
		mapper.map("a", { action: "drag", x: 784, y: 441, to_x: 1176, to_y: 661.5 }, { from_x: 784, from_y: 441, to_x: 1176, to_y: 661.5 }),
		{ from_x: 960, from_y: 540, to_x: 1440, to_y: 810 },
	);
});

test("capture-bound clicks and window coordinates remain in the driver's coordinate frame", () => {
	const mapper = new DesktopCoordinateMapper();
	const bound = { x: 784, y: 441, capture_id: "desktop-1" };
	assert.equal(mapper.map("a", { action: "click", capture_id: "desktop-1", x: 784, y: 441 }, bound), bound);
	for (const action of ["double_click", "right_click"] as const) {
		const unsupported = { x: 784, y: 441 };
		assert.equal(mapper.map("a", { action, x: 784, y: 441 }, unsupported), unsupported);
	}
	mapper.record("a", DESKTOP);
	const windowArgs = { x: 100, y: 50, pid: 4, window_id: 8 };
	assert.equal(mapper.map("a", { action: "click", pid: 4, window_id: 8, x: 100, y: 50 }, windowArgs), windowArgs);
	assert.equal(mapper.map("a", { action: "click", frame: "desktop", pid: 4, x: 100, y: 50 }, windowArgs), windowArgs);
	assert.equal(mapper.map("a", { action: "click", from_zoom: true, x: 100, y: 50 }, windowArgs), windowArgs);
	assert.equal(mapper.map("a", { action: "type_text", text: "hello" }, { text: "hello" }).text, "hello");
});

test("an explicit capture id on a route without driver capture binding must match the latest desktop screenshot", () => {
	const mapper = new DesktopCoordinateMapper();
	mapper.record("a", DESKTOP);
	assert.deepEqual(mapper.map("a", { action: "scroll", x: 784, y: 441, capture_id: "desktop-1" }, { x: 784, y: 441 }), { x: 960, y: 540 });
	assert.throws(
		() => mapper.map("a", { action: "scroll", x: 784, y: 441, capture_id: "old" }, { x: 784, y: 441 }),
		(error: unknown) => error instanceof ComputerUseError && error.code === "stale_reference",
	);
});

test("native dimensions preserve pixels, and per-axis screenshot rounding uses the actual dimensions", () => {
	const mapper = new DesktopCoordinateMapper();
	mapper.record("a", { ...DESKTOP, screenshot_width: 1920, screenshot_height: 1080 });
	assert.deepEqual(mapper.map("a", { action: "move_cursor", x: 123, y: 456 }, { x: 123, y: 456 }), { x: 123, y: 456 });
	mapper.record("a", { ...DESKTOP, screenshot_width: 1000, screenshot_height: 563, screenshot_original_width: 2000, screenshot_original_height: 1125 });
	assert.deepEqual(mapper.map("a", { action: "move_cursor", x: 500, y: 281.5 }, { x: 500, y: 281.5 }), { x: 1000, y: 562.5 });
});

test("session geometry follows visible desktop observations and driver/session lifecycle", () => {
	const mapper = new DesktopCoordinateMapper();
	const map = (session: string): Record<string, unknown> => mapper.map(session, { action: "click", x: 784, y: 441 }, { x: 784, y: 441 });
	mapper.record("a", DESKTOP);
	assert.throws(() => map("b"), ComputerUseError);
	mapper.record("b", DESKTOP);
	mapper.clear("a");
	assert.throws(() => map("a"), ComputerUseError);
	assert.deepEqual(map("b"), { x: 960, y: 540 });
	mapper.clear();
	assert.throws(() => map("b"), ComputerUseError);
	mapper.record("a", DESKTOP);
	mapper.record("a", DESKTOP, false);
	assert.throws(() => map("a"), ComputerUseError);
	mapper.record("a", DESKTOP);
	mapper.record("a", { screenshot_width: 0, screenshot_height: 882 });
	assert.throws(() => map("a"), ComputerUseError);
});
