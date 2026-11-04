/**
 * Windows cua-driver 0.34.1 accepts physical desktop pixels for unbound pointer
 * input, although get_desktop_state can return a smaller image. Keep that
 * conversion here; capture-bound clicks use the driver's capture geometry.
 */

import type { ComputerActParams } from "../../shared/computer-use-types.js";
import { ComputerUseError, effectiveFrame } from "./contracts.js";

interface DesktopGeometry {
	width: number;
	height: number;
	nativeWidth: number;
	nativeHeight: number;
	captureId?: string;
}

const POINTER_ACTIONS: ReadonlySet<ComputerActParams["action"]> = new Set([
	"click", "scroll", "drag", "move_cursor",
]);

function positiveDimension(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Owned by the Windows backend and reset with the driver's session lifecycle. */
export class DesktopCoordinateMapper {
	private readonly _geometry = new Map<string, DesktopGeometry>();

	/** A screenshot not returned to the model cannot establish its coordinate frame. */
	record(session: string, structured: Record<string, unknown> | undefined, imageVisible = true): void {
		this._geometry.delete(session);
		if (!imageVisible || structured === undefined) return;
		const width = positiveDimension(structured.screenshot_width);
		const height = positiveDimension(structured.screenshot_height);
		const nativeWidth = positiveDimension(structured.screenshot_original_width) ?? positiveDimension(structured.screen_width);
		const nativeHeight = positiveDimension(structured.screenshot_original_height) ?? positiveDimension(structured.screen_height);
		if (width === undefined || height === undefined || nativeWidth === undefined || nativeHeight === undefined) return;
		this._geometry.set(session, {
			width,
			height,
			nativeWidth,
			nativeHeight,
			captureId: typeof structured.capture_id === "string" ? structured.capture_id : undefined,
		});
	}

	/** Map only native desktop routes; window and capture-bound routes already map in the driver. */
	map(session: string, params: ComputerActParams, args: Record<string, unknown>): Record<string, unknown> {
		if (
			!POINTER_ACTIONS.has(params.action)
			|| effectiveFrame(params) !== "desktop"
			|| params.pid !== undefined
			|| params.window_id !== undefined
			|| params.element_token !== undefined
			|| params.from_zoom === true
			|| args.capture_id !== undefined
		) return args;
		const xField = params.action === "drag" ? "from_x" : "x";
		const yField = params.action === "drag" ? "from_y" : "y";
		if (typeof args[xField] !== "number" || typeof args[yField] !== "number") return args;
		const geometry = this._geometry.get(session);
		if (geometry === undefined || (params.capture_id !== undefined && params.capture_id !== geometry.captureId)) {
			throw new ComputerUseError(
				"stale_reference",
				"No current desktop screenshot matches these coordinates.",
				'Call computer_observe view="desktop", then use coordinates and capture_id from that screenshot.',
			);
		}
		const mapped = { ...args };
		for (const field of params.action === "drag" ? ["from_x", "from_y", "to_x", "to_y"] : ["x", "y"]) {
			const value = args[field];
			if (typeof value === "number") {
				const horizontal = field.endsWith("x");
				mapped[field] = value * (horizontal ? geometry.nativeWidth / geometry.width : geometry.nativeHeight / geometry.height);
			}
		}
		return mapped;
	}

	clear(session?: string): void {
		if (session === undefined) this._geometry.clear();
		else this._geometry.delete(session);
	}
}
