import assert from "node:assert/strict";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveComputerUseSettings, type ComputerVerifyExpectation } from "../../shared/computer-use-types.js";
import { ComputerUseError, type ComputerBackend } from "../computer-use/contracts.js";
import { classifyDriverError } from "../computer-use/cua-backend.js";
import { createDesktopLease } from "../computer-use/desktop-lease.js";
import { ComputerUseSessionController, type ComputerUseSessionControllerDeps } from "../computer-use/session-controller.js";
import { createTargetGuard } from "../computer-use/target-guard.js";

const session = {
	getActiveToolNames: () => [],
	setActiveToolsByName: () => {},
	isStreaming: false,
	settingsManager: { getExecutionMode: () => "unattended" },
} as unknown as AgentSession;
let serviceCalls = 0;
const deps: ComputerUseSessionControllerDeps = {
	controllerId: "verify-validation",
	backend: () => null,
	ensureReady: async () => { serviceCalls++; throw new ComputerUseError("unavailable", "Reached service"); },
	lease: createDesktopLease(),
	guard: createTargetGuard({ getPixPids: () => [], isPixFocused: () => false }),
	encode: async () => ({ ok: false, reason: "over_budget", bytes: 0 }),
	getSettings: () => resolveComputerUseSettings({ enabled: true }),
	getSession: () => session,
	getSessionManager: () => null,
	isForeground: () => true,
	requestUserInput: async () => { throw new Error("Invalid predicates must not request permission"); },
	isPlanRestricted: () => false,
	emit: () => {},
};
const controller = new ComputerUseSessionController(deps);
controller.setSessionEnabled(true);
const context = {} as ExtensionContext;

for (const expect of [
	[{ element: { selector: { role: "Document", label_contains: "Text editor" }, exists: true, enabled: true }, window: { exists: true } }],
	[{}],
	[{ element: { selector: {}, exists: true } }],
	[{ window: {} }],
] satisfies ComputerVerifyExpectation[][]) {
	await assert.rejects(controller.observe("bad-predicate", { view: "verify", pid: 42, window_id: 7, expect }, undefined, context),
		(error: unknown) => error instanceof ComputerUseError && error.code === "invalid_params");
}
assert.equal(serviceCalls, 0, "malformed predicates are rejected before starting the driver or requesting a grant");

for (const expect of [
	[{ element: { selector: { role: "Document", label_contains: "Text editor" }, exists: true } }],
	[{ window: { exists: true } }, { element: { selector: { role: "Document" }, value_equals: "0123456789" } }],
	[{ element: { selector: { role: "Document" } } }],
] satisfies ComputerVerifyExpectation[][]) {
	await assert.rejects(controller.observe("valid-predicate", { view: "verify", pid: 42, window_id: 7, expect }, undefined, context),
		(error: unknown) => error instanceof ComputerUseError && error.code === "unavailable" && error.detail === "Reached service");
}
assert.equal(serviceCalls, 3, "role plus label and separate window/element conditions remain valid");
await controller.dispose();

let zoomRefreshes = 0;
const zoomBackend: ComputerBackend = {
	platform: "win32-x64",
	openSession: async (label) => ({ driverSession: label }),
	closeSession: async () => {},
	act: async () => ({ text: "Clicked.", driverTool: "click" }),
	observe: async (_handle, _params, options) => {
		assert.equal(options.preserveZoom, true, "post-action observation refreshes the zoom viewport");
		zoomRefreshes++;
		return { text: "Fresh zoom.", image: null, zoom: true, driverTool: "zoom" };
	},
	checkPermissions: async () => ({ missing: [], degraded: [] }),
	supports: () => true,
};
const zoomController = new ComputerUseSessionController({ ...deps, controllerId: "zoom-refresh", backend: () => zoomBackend, ensureReady: async () => {} });
zoomController.setSessionEnabled(true);
for (let index = 0; index < 2; index++) {
	const result = await zoomController.act(`zoom-${index}`, { action: "click", pid: 42, window_id: 7, x: 20, y: 48, from_zoom: true }, undefined, context);
	assert.ok(result.content.some((item) => item.type === "text" && item.text.includes("from_zoom=true")), "fresh zoom coordinates are identified in the tool result");
}
assert.equal(zoomRefreshes, 2);
await zoomController.dispose();

for (const code of ["zoom_context_missing", "screenshot_context_missing"]) {
	assert.equal(classifyDriverError({ isError: true, content: [{ type: "text", text: `${code}: observe and zoom again` }] }).code, "stale_reference");
	assert.equal(classifyDriverError({ isError: true, content: [], structuredContent: { code } }).code, "stale_reference");
}
assert.equal(classifyDriverError({ isError: true, content: [{ type: "text", text: "Unknown failure" }] }).code, "driver_error");

console.log("PASS: verify predicates fail locally with clear errors, and expired zoom contexts are stale references.");
