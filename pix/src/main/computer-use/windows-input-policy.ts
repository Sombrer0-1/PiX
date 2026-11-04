import type { ComputerActParams } from "../../shared/computer-use-types.js";
import { ComputerUseError, type DriverToolResult } from "./contracts.js";

type ReadWindowDiagnostic = (pid: number) => Promise<DriverToolResult | null>;

const FOREGROUND_KEYBOARD_HINT = 'Retry with delivery="foreground" to request foreground input. Use set_value for an explicit whole-value update.';

/** Refuse keyboard routes that XAML ignores or emulates through whole-value append.
 * debug_window_info reads native window metadata without invalidating element tokens.
 */
export async function assertWindowsBackgroundKeyboardAllowed(
	params: ComputerActParams,
	readDiagnostic: ReadWindowDiagnostic,
): Promise<void> {
	if (params.delivery === "foreground" || !["type_text", "press_key", "hotkey"].includes(params.action)) return;
	if (params.pid === undefined) {
		throw new ComputerUseError(
			"background_unavailable",
			"Keyboard input to the foreground application requires foreground delivery; no input was sent.",
			FOREGROUND_KEYBOARD_HINT,
		);
	}
	const result = await readDiagnostic(params.pid);
	const diagnostic = result?.structuredContent;
	let modern: boolean | undefined;
	if (diagnostic?.exe_xaml_match === true) {
		modern = true;
	} else if (Array.isArray(diagnostic?.windows) && params.window_id !== undefined) {
		const window = diagnostic.windows.find((entry: unknown) => {
			if (typeof entry !== "object" || entry === null) return false;
			return (entry as Record<string, unknown>).hwnd === params.window_id;
		}) as Record<string, unknown> | undefined;
		if (window?.xaml_class_match === true) modern = true;
		else if (window?.xaml_class_match === false && diagnostic.exe_xaml_match === false) modern = false;
	} else if (typeof diagnostic?.xaml_routing_recommended === "boolean") {
		modern = diagnostic.xaml_routing_recommended;
	}
	if (modern === false && result?.isError !== true) return;
	throw new ComputerUseError(
		"background_unavailable",
		modern === true
			? `The driver cannot reliably deliver ${params.action} as background keyboard input to this window host; no input was sent.`
			: "The driver could not determine whether this window accepts background keyboard input; no input was sent.",
		FOREGROUND_KEYBOARD_HINT,
	);
}
