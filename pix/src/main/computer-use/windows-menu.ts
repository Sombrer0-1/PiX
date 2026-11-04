import { setTimeout } from "node:timers/promises";
import { COMPUTER_USE_LIMITS } from "../../shared/computer-use-types.js";
import { ComputerUseError, type DriverToolResult } from "./contracts.js";

type MenuDriverCall = (tool: string, args: Record<string, unknown>) => Promise<DriverToolResult>;

interface MenuElement {
	element_token: string;
	role: string;
	label: string;
	actions: string[];
}

function matchingMenuElements(result: DriverToolResult, label: string): MenuElement[] {
	const elements = result.structuredContent?.elements;
	if (!Array.isArray(elements)) return [];
	const matches: MenuElement[] = [];
	for (const element of elements) {
		if (typeof element !== "object" || element === null) continue;
		const node = element as Record<string, unknown>;
		if (node.label !== label || typeof node.element_token !== "string" || node.enabled === false) continue;
		const actions = Array.isArray(node.actions) ? node.actions.filter((action): action is string => typeof action === "string") : [];
		if (node.role !== "MenuItem" && !(node.role === "Button" && actions.includes("expand"))) continue;
		if (typeof node.frame !== "object" || node.frame === null) continue;
		const frame = node.frame as Record<string, unknown>;
		if (typeof frame.w !== "number" || frame.w <= 0 || typeof frame.h !== "number" || frame.h <= 0) continue;
		matches.push({ element_token: node.element_token, role: String(node.role), label, actions });
	}
	// A menu command takes precedence over a ribbon button with the same name.
	const menuItems = matches.filter((element) => element.role === "MenuItem");
	return menuItems.length > 0 ? menuItems : matches;
}

/** Resolve every hop from fresh state; background UIA actions keep popup menus open. */
export async function invokeWindowsMenu(
	target: { pid: number; window_id: number; menu_path: readonly string[] },
	call: MenuDriverCall,
	signal?: AbortSignal,
): Promise<DriverToolResult> {
	let result: DriverToolResult | undefined;
	try {
		for (const [index, rawLabel] of target.menu_path.entries()) {
			const label = rawLabel.trim();
			const deadline = Date.now() + 1_000;
			let candidates: MenuElement[];
			do {
				signal?.throwIfAborted();
				const snapshot = await call("get_window_state", {
					pid: target.pid,
					window_id: target.window_id,
					include_screenshot: false,
					max_elements: COMPUTER_USE_LIMITS.maxElements.max,
				});
				candidates = matchingMenuElements(snapshot, label);
				if (candidates.length > 0 || index === 0 || Date.now() >= deadline) break;
				// Menu providers publish popup children after the expand call returns.
				await setTimeout(50, undefined, { signal });
			} while (true);
			if (candidates.length !== 1) {
				const progress = result === undefined ? "" : " Previous menu hops were dispatched; observe the window before retrying the path.";
				throw new ComputerUseError(
					"driver_error",
					(candidates.length === 0
						? `Menu item "${label}" is unavailable or disabled in ${target.menu_path.slice(0, index + 1).join(" > ")}.`
						: `Menu item "${label}" is ambiguous (${candidates.length} visible matches); observe the window and select its element_token.`) + progress,
				);
			}
			const element = candidates[0];
			result = await call("click", {
				pid: target.pid,
				window_id: target.window_id,
				element_token: element.element_token,
				delivery_mode: "background",
				...(element.actions.includes("expand") ? { action: "expand" } : {}),
			});
		}
	} catch (error) {
		if (signal?.aborted) {
			throw new ComputerUseError("cancelled", result === undefined
				? "Menu invocation was cancelled; observe the window before acting again."
				: "Menu invocation was cancelled after earlier menu hops were dispatched; observe the window before acting again.");
		}
		throw error;
	}
	if (result === undefined) throw new ComputerUseError("invalid_params", "menu_path must contain at least one menu item.");
	return {
		...result,
		structuredContent: { ...result.structuredContent, route: "uia_menu_path" },
	};
}
