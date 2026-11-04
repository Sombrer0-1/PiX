/**
 * PiX-surface target guard.
 *
 * The agent must never observe or drive PiX itself, and focus-dependent input
 * must not be sent while a PiX window is focused: PiX pids are rejected
 * outright, and keyboard actions / token-less coordinate clicks with no target
 * window are refused when `isPixFocused()`. Also the single source of the
 * dangerous-hotkey tables (chordOf / isDangerousHotkey / DANGEROUS_HOTKEYS):
 * the grant policy that acts on them (approval prompt vs. unattended
 * rejection) lives in the session controller, which imports them from here.
 *
 * Pure Node: the Electron facts (pids, focus) arrive through the injected
 * `PixSurfaceProvider` (service: `app.getAppMetrics()`, `BrowserWindow`); this
 * module never imports electron.
 */

import type { ComputerActParams, ComputerObserveParams } from "../../shared/computer-use-types.js";
import { ComputerUseError, type PixSurfaceProvider, type TargetGuard } from "./contracts.js";

/** Focused-window input: no pid means the driver types into whatever is focused. */
const KEYBOARD_ACTIONS: ReadonlySet<string> = new Set(["type_text", "press_key", "hotkey"]);
/** Coordinate clicks without an element handle follow the same focus rule. */
const COORDINATE_CLICK_ACTIONS: ReadonlySet<string> = new Set(["click", "double_click", "right_click"]);

/**
 * Pure: true for system-level/destructive chords. Case/order-insensitive; cmd≡super≡win≡meta,
 * option≡alt, esc≡escape.
 */
export function isDangerousHotkey(keys: string[]): boolean {
	const chord = normalizeChord(keys);
	return DANGEROUS_HOTKEYS.some((dangerous) => normalizeChord(dangerous) === chord);
}

/** Pure: chord of an act call - hotkey -> keys; press_key -> [...modifiers, key]; others -> null. */
export function chordOf(p: ComputerActParams): string[] | null {
	if (p.action === "hotkey") return p.keys !== undefined && p.keys.length > 0 ? [...p.keys] : null;
	if (p.action === "press_key") {
		return p.key !== undefined && p.key.length > 0 ? [...(p.modifiers ?? []), p.key] : null;
	}
	return null;
}

export const DANGEROUS_HOTKEYS: readonly (readonly string[])[] = [
	["alt", "f4"], ["cmd", "q"], ["cmd", "w"], ["ctrl", "w"], ["ctrl", "alt", "delete"], ["ctrl", "shift", "escape"],
	["cmd", "option", "escape"], ["super", "l"], ["cmd", "ctrl", "q"], ["ctrl", "alt", "t"], ["super", "r"], ["cmd", "space"],
];

export function createTargetGuard(provider: PixSurfaceProvider): TargetGuard {
	function assertNotPixPid(pid: number, kind: "act" | "observe"): void {
		if (!provider.getPixPids().includes(pid)) return;
		if (kind === "act") {
			throw new ComputerUseError(
				"self_target",
				`Refusing to control PiX itself: pid ${pid} is a PiX process.`,
				'Pick the target application with computer_observe view="windows" (or view="apps") and use its pid.',
			);
		}
		throw new ComputerUseError(
			"self_target",
			`Refusing to observe PiX itself: pid ${pid} is a PiX process.`,
			"Observing PiX would let the model read its own conversation; observe the target application instead.",
		);
	}

	return {
		assertActAllowed(p: ComputerActParams): void {
			if (p.pid !== undefined) assertNotPixPid(p.pid, "act");
			// cua-driver 0.34.1 type_text requires pid (unless scope=desktop, which
			// types into whatever is focused). A pid therefore targets type_text
			// the same way it targets press_key. element_token also targets it:
			// that call is not "whatever is focused", and the driver asks for pid
			// itself when the token arrives without one.
			const targeted = p.pid !== undefined || (p.action === "type_text" && p.element_token !== undefined);
			if (targeted || !provider.isPixFocused()) return;
			if (KEYBOARD_ACTIONS.has(p.action)) {
				throw new ComputerUseError(
					"self_target",
					"PiX window is focused; typing would go into PiX.",
					"Call computer_act action=focus_window with the target pid first, or pass pid/window_id.",
				);
			}
			if (COORDINATE_CLICK_ACTIONS.has(p.action) && !p.element_token) {
				throw new ComputerUseError(
					"self_target",
					"PiX window is focused; a desktop-frame click without element_token could land on PiX.",
					"Focus the target window first (computer_act action=focus_window), or click an element_token from a window observation.",
				);
			}
			// Residual risk: clicks/drags that do carry a pid, and other
			// coordinate actions (drag/move_cursor/scroll), are not region-checked -
			// DPI/multi-monitor math is unreliable and the driver already maps
			// screenshot pixels. The tool description forbids operating PiX.
		},

		assertObserveAllowed(p: ComputerObserveParams): void {
			if (p.pid === undefined) return;
			if (p.view !== "window" && p.view !== "zoom" && p.view !== "verify") return;
			assertNotPixPid(p.pid, "observe");
		},
	};
}

// ============================================================================
// Internal helpers
// ============================================================================

const KEY_ALIASES: Readonly<Record<string, string>> = {
	cmd: "cmd", command: "cmd", super: "cmd", win: "cmd", meta: "cmd",
	option: "alt", alt: "alt",
	esc: "escape", escape: "escape",
	control: "ctrl", ctrl: "ctrl",
};

/** Lowercase + alias-normalized key set as a stable string; order, duplicates and empty tokens drop out. */
function normalizeChord(keys: readonly string[]): string {
	const normalized = keys
		.map((key) => KEY_ALIASES[key.trim().toLowerCase()] ?? key.trim().toLowerCase())
		.filter((key) => key.length > 0);
	return [...new Set(normalized)].sort().join("+");
}
