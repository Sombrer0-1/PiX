import { existsSync } from "node:fs";
import { access, open, readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import type { ImageContent } from "@earendil-works/pi-ai";
import { formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import type { ChatMessageAttachment } from "../shared/types.js";

const IMAGE_TYPE_SNIFF_BYTES = 4100;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface ProcessedChatFiles {
	text: string;
	images: ImageContent[];
	attachments: ChatMessageAttachment[];
}

export interface ProcessChatFileOptions {
	autoResizeImages?: boolean;
}

export async function processChatFiles(
	filePaths: readonly string[],
	cwd: string,
	options?: ProcessChatFileOptions,
): Promise<ProcessedChatFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	let text = "";
	const images: ImageContent[] = [];
	const attachments: ChatMessageAttachment[] = [];

	for (const filePath of filePaths) {
		const absolutePath = resolveReadPath(filePath, cwd);

		try {
			await access(absolutePath);
		} catch {
			throw new Error(`File not found: ${absolutePath}`);
		}

		const fileStats = await stat(absolutePath);
		if (fileStats.size === 0) {
			attachments.push({
				path: absolutePath,
				name: basenameFromPath(absolutePath),
				kind: "file",
				size: fileStats.size,
			});
			continue;
		}

		const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
		if (mimeType) {
			const content = await readFile(absolutePath);
			attachments.push({
				path: absolutePath,
				name: basenameFromPath(absolutePath),
				kind: "image",
				size: fileStats.size,
			});
			let attachment: ImageContent;
			let dimensionNote: string | undefined;

			if (autoResizeImages) {
				const resized = await resizeImage(content, mimeType);
				if (!resized) {
					text += `<file name="${absolutePath}">[Image omitted: could not be resized below the inline image size limit.]</file>\n`;
					continue;
				}
				dimensionNote = formatDimensionNote(resized);
				attachment = {
					type: "image",
					mimeType: resized.mimeType,
					data: resized.data,
				};
			} else {
				attachment = {
					type: "image",
					mimeType,
					data: content.toString("base64"),
				};
			}

			images.push(attachment);
			text += dimensionNote
				? `<file name="${absolutePath}">${dimensionNote}</file>\n`
				: `<file name="${absolutePath}"></file>\n`;
		} else {
			try {
				const content = await readFile(absolutePath, "utf-8");
				attachments.push({
					path: absolutePath,
					name: basenameFromPath(absolutePath),
					kind: "text",
					size: fileStats.size,
					content,
				});
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Could not read file ${absolutePath}: ${message}`);
			}
		}
	}

	return { text, images, attachments };
}

function basenameFromPath(filePath: string): string {
	return filePath.split(/[/\\]/).pop() || filePath;
}

function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);
	const candidates = buildPathCandidates(resolved);

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	return resolved;
}

function buildPathCandidates(filePath: string): string[] {
	const candidates = new Set<string>();
	const addCandidate = (candidate: string): void => {
		candidates.add(candidate);
		candidates.add(candidate.normalize("NFC"));
		candidates.add(candidate.normalize("NFD"));
		candidates.add(candidate.normalize("NFKC"));
		candidates.add(candidate.normalize("NFKD"));
		candidates.add(candidate.replace(/'/g, "\u2019"));
		candidates.add(candidate.replace(/\u2019/g, "'"));
		candidates.add(candidate.normalize("NFD").replace(/'/g, "\u2019"));
		candidates.add(candidate.normalize("NFD").replace(/\u2019/g, "'"));
		candidates.add(candidate.normalize("NFKC").replace(/'/g, "\u2019"));
		candidates.add(candidate.normalize("NFKC").replace(/\u2019/g, "'"));
	};

	addCandidate(filePath);
	addCandidate(tryMacOSScreenshotPath(filePath));
	return Array.from(candidates);
}

function resolveToCwd(filePath: string, cwd: string): string {
	const expanded = expandPath(filePath);
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function expandPath(filePath: string): string {
	let value = filePath.trim();
	if (value.startsWith("@")) value = value.slice(1);
	value = value.replace(/\u00a0/g, " ").replace(/\u202f/g, " ");
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) {
		return resolve(homedir(), value.slice(2));
	}
	return value;
}

async function detectSupportedImageMimeTypeFromFile(filePath: string): Promise<string | null> {
	const fileHandle = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(IMAGE_TYPE_SNIFF_BYTES);
		const { bytesRead } = await fileHandle.read(buffer, 0, IMAGE_TYPE_SNIFF_BYTES, 0);
		return detectSupportedImageMimeType(buffer.subarray(0, bytesRead));
	} finally {
		await fileHandle.close();
	}
}

function detectSupportedImageMimeType(buffer: Uint8Array): string | null {
	if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
		return buffer[3] === 0xf7 ? null : "image/jpeg";
	}
	if (startsWith(buffer, PNG_SIGNATURE)) {
		return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
	}
	if (startsWithAscii(buffer, 0, "GIF")) {
		return "image/gif";
	}
	if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
		return "image/webp";
	}
	return null;
}

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./gi, "\u202f$1.");
}

function isPng(buffer: Uint8Array): boolean {
	return (
		buffer.length >= 16 &&
		readUint32BE(buffer, PNG_SIGNATURE.length) === 13 &&
		startsWithAscii(buffer, 12, "IHDR")
	);
}

function isAnimatedPng(buffer: Uint8Array): boolean {
	let offset = PNG_SIGNATURE.length;
	while (offset + 8 <= buffer.length) {
		const chunkLength = readUint32BE(buffer, offset);
		const chunkTypeOffset = offset + 4;
		if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
		if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;

		const nextOffset = offset + 8 + chunkLength + 4;
		if (nextOffset <= offset || nextOffset > buffer.length) return false;
		offset = nextOffset;
	}
	return false;
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) * 0x1000000 +
		((buffer[offset + 1] ?? 0) << 16) +
		((buffer[offset + 2] ?? 0) << 8) +
		(buffer[offset + 3] ?? 0)
	);
}

function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
	if (buffer.length < bytes.length) return false;
	return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
	if (buffer.length < offset + text.length) return false;
	for (let index = 0; index < text.length; index++) {
		if (buffer[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}
