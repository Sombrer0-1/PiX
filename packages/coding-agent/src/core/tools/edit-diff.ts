/**
 * Shared diff computation utilities for the edit tool.
 * Used by both edit.ts (for execution) and tool-execution.ts (for preview rendering).
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import type { ToolPathContext } from "./execution-backend.ts";
import { resolveToCwd } from "./path-utils.ts";

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Apply replacements matched in `normalizeToLF(originalContent)` to `originalContent` itself.
 * Text outside the replaced ranges keeps its bytes, including its line endings. Line breaks in
 * the new text get the line ending of the line where the replaced range starts. The result,
 * normalized to LF, equals the replacements applied to the normalized content.
 */
export function applyReplacementsToOriginal(originalContent: string, replacements: TextReplacement[]): string {
	// Only CRLF changes length when normalizing: the LF of the n-th CRLF (at original offset p) is at
	// p - n in the normalized text. Adding the number of CRLFs before a normalized offset gives the
	// original offset, and a range that covers that LF covers the whole CRLF.
	let crlfBefore = 0;
	let nextCrlf = originalContent.indexOf("\r\n");
	const toOriginal = (offset: number): number => {
		while (nextCrlf !== -1 && nextCrlf - crlfBefore < offset) {
			crlfBefore++;
			nextCrlf = originalContent.indexOf("\r\n", nextCrlf + 2);
		}
		return offset + crlfBefore;
	};

	const parts: string[] = [];
	let endsWithCr = false;
	const push = (part: string): void => {
		if (part.length === 0) return;
		// A CR before a seam and an LF after it would merge into one CRLF line break, for example a kept
		// lone CR followed by inserted text that starts with LF, or both sides of a deleted range. Adding
		// an LF turns the CR into a CRLF of its own, so the written file has the line breaks the diff shows.
		if (endsWithCr && part[0] === "\n") parts.push("\n");
		parts.push(part);
		endsWithCr = part[part.length - 1] === "\r";
	};
	let position = 0;
	for (const replacement of replacements) {
		const start = toOriginal(replacement.matchIndex);
		push(originalContent.slice(position, start));
		const ending = getLineEndingAt(originalContent, start);
		push(ending === "\n" ? replacement.newText : replacement.newText.replaceAll("\n", ending));
		position = toOriginal(replacement.matchIndex + replacement.matchLength);
	}
	push(originalContent.slice(position));
	return parts.join("");
}

/**
 * Line ending of the line containing `offset`: its own LF or CRLF, or that of the line before
 * for an unterminated last line. A lone CR only counts in files without any LF (classic Mac
 * line endings); elsewhere it is more likely a control character inside a line.
 */
function getLineEndingAt(content: string, offset: number): "\r\n" | "\n" | "\r" {
	let lineFeed = content.indexOf("\n", offset);
	if (lineFeed === -1) lineFeed = content.lastIndexOf("\n", offset);
	if (lineFeed === -1) return content.includes("\r") ? "\r" : "\n";
	return content[lineFeed - 1] === "\r" ? "\r\n" : "\n";
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return normalizeFuzzyCharacters(text).split("\n").map((line) => line.trimEnd()).join("\n");
}

function normalizeFuzzyCharacters(text: string): string {
	return text
		.normalize("NFKC")
		// Smart single quotes → '
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		// Smart double quotes → "
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		// Various dashes/hyphens → -
		// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
		// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		// Special spaces → regular space
		// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
		// U+205F medium math space, U+3000 ideographic space
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

export interface FuzzyMatchResult {
	/** Whether a match was found */
	found: boolean;
	/** The index where the match starts in the original content. */
	index: number;
	/** Length of the matched text */
	matchLength: number;
	/** Whether fuzzy matching was used (false = exact match) */
	usedFuzzyMatch: boolean;
	/**
	 * The content to use for replacement operations.
	 * Original content; fuzzy normalization is used only to locate a match.
	 */
	contentForReplacement: string;
}

export interface Edit {
	oldText: string;
	newText: string;
}

interface TextReplacement {
	matchIndex: number;
	matchLength: number;
	newText: string;
}

interface MatchedEdit extends TextReplacement {
	editIndex: number;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
	replacements: TextReplacement[];
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * Fuzzy matches are mapped back to original character boundaries so unrelated
 * whitespace and Unicode characters are preserved.
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	// Try exact match first
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// Try fuzzy match - work entirely in normalized space
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

	const range = fuzzyIndex === -1 || fuzzyOldText.length === 0
		? undefined
		: originalFuzzyRange(content, fuzzyIndex, fuzzyOldText.length);
	if (!range) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	return {
		found: true,
		index: range.start,
		matchLength: range.end - range.start,
		usedFuzzyMatch: true,
		contentForReplacement: content,
	};
}

/** Map normalized offsets at whole Unicode grapheme boundaries back to the file. */
function originalFuzzyRange(content: string, index: number, length: number): { start: number; end: number } | undefined {
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	let originalOffset = 0;
	let normalizedOffset = 0;
	let start: number | undefined;
	const lines = content.split("\n");
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		for (const part of segmenter.segment(line.trimEnd())) {
			if (normalizedOffset === index) start = originalOffset + part.index;
			normalizedOffset += normalizeFuzzyCharacters(part.segment).length;
			if (start !== undefined && normalizedOffset === index + length) {
				return { start, end: originalOffset + part.index + part.segment.length };
			}
		}
		if (lineIndex < lines.length - 1) {
			if (normalizedOffset === index) start = originalOffset + line.length;
			normalizedOffset++;
			if (start !== undefined && normalizedOffset === index + length) {
				return { start, end: originalOffset + line.length + 1 };
			}
		}
		originalOffset += line.length + 1;
	}
	return undefined;
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}, including the fallback for trailing whitespace and Unicode punctuation/compatibility differences. Read the current file and provide matching oldText.`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}, including the fallback for trailing whitespace and Unicode punctuation/compatibility differences. Read the current file and provide matching oldText.`,
	);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more targeted replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const baseContent = normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(baseContent, edit.oldText);
		if (!matchResult.found) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}

		const occurrences = countOccurrences(baseContent, edit.oldText);
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	let newContent = baseContent;
	for (let i = matchedEdits.length - 1; i >= 0; i--) {
		const edit = matchedEdits[i];
		newContent =
			newContent.substring(0, edit.matchIndex) +
			edit.newText +
			newContent.substring(edit.matchIndex + edit.matchLength);
	}

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent, replacements: matchedEdits };
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

function splitDisplayLines(content: string): string[] {
	if (content.length === 0) return [];
	const lines = normalizeToLF(content).split("\n");
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const oldLines = splitDisplayLines(oldContent);
	const newLines = splitDisplayLines(newContent);
	const parts = Diff.diffArrays(oldLines, newLines);
	const maxLineNum = Math.max(1, oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;
	const { output, firstChangedLine } = formatDisplayDiff(parts, 1, 1, lineNumWidth, contextLines);
	return { diff: output.join("\n"), firstChangedLine };
}

function formatDisplayDiff(
	parts: Diff.ArrayChange<string>[],
	oldLineNum: number,
	newLineNum: number,
	lineNumWidth: number,
	contextLines: number,
): { output: string[]; firstChangedLine: number | undefined } {
	const output: string[] = [];
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value;

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { output, firstChangedLine };
}

/** Count display lines without allocating an array for the whole file. */
function countLines(text: string): number {
	return countLineFeeds(text, 0, text.length) + (text.length > 0 && !text.endsWith("\n") ? 1 : 0);
}

function countLineFeeds(text: string, start: number, end: number): number {
	let count = 0;
	for (let index = text.indexOf("\n", start); index !== -1 && index < end; index = text.indexOf("\n", index + 1)) {
		count++;
	}
	return count;
}

/** Display diff and unified patch of an edit, as returned in the edit tool's details. */
export interface EditDiff {
	diff: string;
	patch: string;
	firstChangedLine: number | undefined;
}

/**
 * Unchanged lines diffed on each side of a replacement. Well above the 4 context lines shown, so jsdiff
 * aligns a change within its window as it would over the whole file.
 */
const DIFF_WINDOW_MARGIN_LINES = 32;

/**
 * Diff an edit only around its replacements, so time and memory follow the size of the change instead of
 * the file. jsdiff may align repeated lines differently within a window.
 */
export function generateEditDiff(
	path: string,
	baseContent: string,
	newContent: string,
	replacements: TextReplacement[],
	contextLines = 4,
): EditDiff {
	const lineNumWidth = String(Math.max(1, countLines(baseContent), countLines(newContent))).length;
	const skipMarker = ` ${"".padStart(lineNumWidth, " ")} ...`;
	const output: string[] = [];
	const hunks: Diff.StructuredPatchHunk[] = [];
	let firstChangedLine: number | undefined;
	for (const window of getDiffWindows(baseContent, replacements)) {
		const oldText = baseContent.slice(window.oldStart, window.oldEnd);
		const newText = newContent.slice(window.newStart, window.newEnd);
		const shown = formatDisplayDiff(
			Diff.diffArrays(splitDisplayLines(oldText), splitDisplayLines(newText)),
			window.oldLine + 1,
			window.newLine + 1,
			lineNumWidth,
			contextLines,
		);
		firstChangedLine ??= shown.firstChangedLine;
		if (shown.output.length > 0) {
			if (window.oldStart > 0 && output.at(-1) !== skipMarker && shown.output[0] !== skipMarker) {
				output.push(skipMarker);
			}
			if (output.at(-1) === skipMarker && shown.output[0] === skipMarker) shown.output.shift();
		}
		// A loop, not push(...lines): spreading a replacement of many lines overflows the call stack.
		for (const line of shown.output) output.push(line);
		if (shown.output.length > 0 && window.oldEnd < baseContent.length && output.at(-1) !== skipMarker) {
			output.push(skipMarker);
		}
		const patch = Diff.structuredPatch(path, path, oldText, newText, undefined, undefined, { context: contextLines });
		for (const hunk of patch.hunks) {
			hunks.push({ ...hunk, oldStart: hunk.oldStart + window.oldLine, newStart: hunk.newStart + window.newLine });
		}
	}
	const patch = Diff.formatPatch(
		{ oldFileName: path, newFileName: path, oldHeader: undefined, newHeader: undefined, hunks },
		Diff.FILE_HEADERS_ONLY,
	);
	return { diff: output.join("\n"), patch, firstChangedLine };
}

/** Matching ranges of the old and new contents around one or more replacements: offsets and 0-based first lines. */
interface DiffWindow {
	oldStart: number;
	oldEnd: number;
	oldLine: number;
	newStart: number;
	newEnd: number;
	newLine: number;
}

/** Start of the line that contains `offset`. */
function lineStartBefore(text: string, offset: number): number {
	// lastIndexOf treats a negative position as 0 and would find a line feed at offset 0.
	return offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
}

/** Whole-line windows with margin around the replacements, which are sorted and disjoint; overlapping windows merge. */
function getDiffWindows(baseContent: string, replacements: TextReplacement[]): DiffWindow[] {
	const windows: DiffWindow[] = [];
	// Offset and line deltas of the replacements before the current one, and a line-counting cursor.
	let offsetDelta = 0;
	let lineDelta = 0;
	let cursorOffset = 0;
	let cursorLine = 0;
	for (const replacement of replacements) {
		const matchEnd = replacement.matchIndex + replacement.matchLength;
		let start = lineStartBefore(baseContent, replacement.matchIndex);
		for (let i = 0; i < DIFF_WINDOW_MARGIN_LINES && start > 0; i++) {
			start = lineStartBefore(baseContent, start - 1);
		}
		let end = matchEnd;
		for (let i = 0; i <= DIFF_WINDOW_MARGIN_LINES && end < baseContent.length; i++) {
			const lineFeed = baseContent.indexOf("\n", i === 0 ? Math.max(matchEnd - 1, replacement.matchIndex) : end);
			end = lineFeed === -1 ? baseContent.length : lineFeed + 1;
		}
		const replacementOffsetDelta = replacement.newText.length - replacement.matchLength;
		const replacementLineDelta =
			countLineFeeds(replacement.newText, 0, replacement.newText.length) -
			countLineFeeds(baseContent, replacement.matchIndex, matchEnd);
		const previous = windows.at(-1);
		if (previous && start <= previous.oldEnd) {
			previous.oldEnd = Math.max(previous.oldEnd, end);
			previous.newEnd = previous.oldEnd + offsetDelta + replacementOffsetDelta;
		} else {
			cursorLine += countLineFeeds(baseContent, cursorOffset, start);
			cursorOffset = start;
			windows.push({
				oldStart: start,
				oldEnd: end,
				oldLine: cursorLine,
				newStart: start + offsetDelta,
				newEnd: end + offsetDelta + replacementOffsetDelta,
				newLine: cursorLine + lineDelta,
			});
		}
		offsetDelta += replacementOffsetDelta;
		lineDelta += replacementLineDelta;
	}
	return windows;
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

/** Operations used by computeEditsDiff to read the target file for preview. */
export interface EditDiffReadOperations {
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
}

export interface ComputeEditsDiffOptions {
	/**
	 * Backend file operations. When provided, preview reads go through them so a
	 * remote backend (WSL) reads the physical file via its own operations instead
	 * of the host filesystem. Defaults to local fs.access/fs.readFile.
	 */
	operations?: EditDiffReadOperations;
	/**
	 * Path context for the active execution backend. When provided, the preview
	 * path is resolved in the runtime namespace (POSIX under WSL). Defaults to
	 * local win32 resolution.
	 */
	paths?: ToolPathContext;
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 *
 * The 3-arg form `computeEditsDiff(path, edits, cwd)` is unchanged for
 * existing callers. Pass `options` to route resolution and reads through a
 * remote execution backend (WSL) so the preview matches execution.
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
	options?: ComputeEditsDiffOptions,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd, options?.paths);
	const accessFn = options?.operations?.access ?? ((p: string) => access(p, constants.R_OK));
	const readFileFn = options?.operations?.readFile ?? ((p: string) => readFile(p));

	try {
		// Check if file exists and is readable
		try {
			await accessFn(absolutePath);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// Read the file
		const rawBuffer = await readFileFn(absolutePath);
		const rawContent = rawBuffer.toString("utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent, replacements } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// Generate the diff
		const { diff, firstChangedLine } = generateEditDiff(path, baseContent, newContent, replacements);
		return { diff, firstChangedLine };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
	options?: ComputeEditsDiffOptions,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd, options);
}
