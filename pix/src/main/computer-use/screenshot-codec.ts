/**
 * Screenshot byte-budget encoder.
 *
 * Decides what the model may actually see: an image is sent only when its
 * base64 payload is strictly smaller than the resolved `screenshotMaxBytes`.
 * Re-encoding NEVER changes the pixel dimensions - if the image cannot fit at
 * its own size the result is `over_budget` and the caller re-shoots at a
 * smaller long edge, keeping the driver's coordinate frame meaningful.
 *
 * `resizeImage` is first-come-first-served (image-resize-core.ts:83-150): it
 * returns the input untouched when it is already within all limits, otherwise
 * it tries PNG then JPEG (75, 85, 70, 55, 40) at the current size and only then
 * shrinks. It also sets `wasResized` when only the encoding changed, so the
 * dimension check below compares width/height, never `wasResized`.
 */

import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { BackendImage, EncodeResult, ScreenshotEncoder } from "./contracts.js";

/** JPEG quality tried first, before 85/70/55/40 (image-resize-core.ts qualitySteps). */
const JPEG_QUALITY = 75;

/**
 * `bytes` is the base64 payload length: for `ok` the returned payload, for
 * `over_budget` the input payload that could not fit at its own dimensions.
 */
export const encodeScreenshotForModel: ScreenshotEncoder = async (
	img: BackendImage,
	maxBytes: number,
): Promise<EncodeResult> => {
	const inputBase64Length = img.data.length;
	if (inputBase64Length < maxBytes) {
		return {
			ok: true,
			data: img.data,
			mimeType: img.mimeType,
			width: img.width,
			height: img.height,
			bytes: inputBase64Length,
		};
	}

	const resized = await resizeImage(Buffer.from(img.data, "base64"), img.mimeType, {
		maxWidth: img.width,
		maxHeight: img.height,
		maxBytes,
		jpegQuality: JPEG_QUALITY,
	});
	if (resized === null || resized.width !== img.width || resized.height !== img.height) {
		return { ok: false, reason: "over_budget", bytes: inputBase64Length };
	}
	return {
		ok: true,
		data: resized.data,
		mimeType: resized.mimeType,
		width: resized.width,
		height: resized.height,
		bytes: resized.data.length,
	};
};
