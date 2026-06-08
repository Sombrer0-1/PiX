/**
 * Cache-hit debug logger.
 *
 * Writes one JSON line per request + one per response to
 * `<PI_CACHE_DEBUG_DIR>/cache-debug.jsonl` so the caller can diff consecutive
 * turns and spot exactly which part of the request prefix changed when
 * cached_tokens drops.
 *
 * Enabled automatically when the target log directory is writable.
 * Set PI_CACHE_DEBUG=0 to disable.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let enabled: boolean | null = null;
let logPath = "";
let turn = 0;
let reqSeq = 0;

/** Previous request snapshot for diff_prev computation. */
interface PrevSnapshot {
	input_hash: string;
	sys_hash: string;
	tools_hash: string;
	item_hashes: string[];
	system_segment_hashes: string[];
	items: Array<{
		i: number;
		item_hash: string;
		field_hashes: FieldHashes;
	}>;
}

let prevSnapshot: PrevSnapshot | null = null;

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

/** Compact 8-char hex hash (FNV-1a 32-bit). */
function shortHash(data: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < data.length; i++) {
		h ^= data.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/** Content hash: JSON-serialize then shortHash. */
function contentHash(content: unknown): string {
	return shortHash(JSON.stringify(content));
}

function computeContentPrefixHash(content: unknown, length: number): string | undefined {
	if (content == null) return undefined;
	const s = typeof content === "string" ? content : JSON.stringify(content);
	if (s.length === 0) return undefined;
	return shortHash(s.slice(0, length));
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

function tryEnable(): void {
	if (enabled !== null) return;
	if (typeof process !== "undefined" && process.env.PI_CACHE_DEBUG === "0") {
		enabled = false;
		return;
	}
	try {
		const base = typeof process !== "undefined" ? process.env.PI_CACHE_DEBUG_DIR : undefined;
		const dir = base ?? join(process.cwd(), "log");
		mkdirSync(dir, { recursive: true });
		logPath = join(dir, "cache-debug.jsonl");
		enabled = true;
	} catch {
		enabled = false;
	}
}

function generateRequestId(): string {
	reqSeq++;
	const rand = Math.random().toString(36).slice(2, 10);
	return `req_${reqSeq}_${rand}`;
}

// ---------------------------------------------------------------------------
// System segment hashing
// ---------------------------------------------------------------------------

const SYSTEM_SEGMENT_SIZE = 2000;

function computeSystemSegments(
	systemText: string,
): Array<{ segment: number; char_start: number; char_end: number; hash: string; head: string }> {
	const segments: Array<{
		segment: number;
		char_start: number;
		char_end: number;
		hash: string;
		head: string;
	}> = [];
	if (!systemText) return segments;

	for (let i = 0; i < systemText.length; i += SYSTEM_SEGMENT_SIZE) {
		const chunk = systemText.slice(i, i + SYSTEM_SEGMENT_SIZE);
		segments.push({
			segment: Math.floor(i / SYSTEM_SEGMENT_SIZE),
			char_start: i,
			char_end: Math.min(i + SYSTEM_SEGMENT_SIZE, systemText.length),
			hash: shortHash(chunk),
			head: chunk.slice(0, 80),
		});
	}
	return segments;
}

// ---------------------------------------------------------------------------
// Per-item field-level hash extraction
// ---------------------------------------------------------------------------

interface FieldHashes {
	id: string | null;
	call_id: string | null;
	name: string | null;
	content: string | null;
	arguments: string | null;
	output: string | null;
	encrypted_content: string | null;
	signature: string | null;
	status: string | null;
}

interface ItemInfo {
	i: number;
	role?: string;
	type?: string;
	id?: string | null;
	call_id?: string | null;
	name?: string | null;
	field_hashes: FieldHashes;
	content_prefix_1k_hash?: string;
	content_prefix_4k_hash?: string;
	item_hash: string;
}

function emptyFieldHashes(): FieldHashes {
	return {
		id: null,
		call_id: null,
		name: null,
		content: null,
		arguments: null,
		output: null,
		encrypted_content: null,
		signature: null,
		status: null,
	};
}

function extractItemInfo(index: number, item: unknown): ItemInfo {
	if (item == null) {
		return {
			i: index,
			field_hashes: emptyFieldHashes(),
			item_hash: shortHash("null"),
		};
	}

	const rec = item as Record<string, unknown>;
	const fh: FieldHashes = emptyFieldHashes();
	const info: ItemInfo = { i: index, field_hashes: fh, item_hash: "" };

	// ── Common identity fields ──────────────────────────────────────────

	info.role = typeof rec.role === "string" ? rec.role : undefined;

	if (rec.id != null) {
		info.id = String(rec.id);
		fh.id = shortHash(String(rec.id));
	}
	if (rec.responseId != null && info.id == null) {
		info.id = String(rec.responseId);
		fh.id = shortHash(String(rec.responseId));
	}

	if (rec.call_id != null) {
		info.call_id = String(rec.call_id);
		fh.call_id = shortHash(String(rec.call_id));
	} else if (rec.toolCallId != null) {
		info.call_id = String(rec.toolCallId);
		fh.call_id = shortHash(String(rec.toolCallId));
	}

	if (typeof rec.name === "string") {
		info.name = rec.name;
		fh.name = shortHash(rec.name);
	} else if (typeof rec.toolName === "string") {
		info.name = rec.toolName;
		fh.name = shortHash(rec.toolName);
	}

	if (typeof rec.status === "string") {
		fh.status = shortHash(rec.status);
	}

	// ── OpenAI Responses: explicit `type` field ─────────────────────────

	if (typeof rec.type === "string") {
		info.type = rec.type;

		if (rec.type === "reasoning") {
			if (rec.encrypted_content != null) {
				fh.encrypted_content = contentHash(rec.encrypted_content);
				info.content_prefix_4k_hash = computeContentPrefixHash(rec.encrypted_content, 4096);
			}
			if (rec.summary != null) {
				fh.content = contentHash(rec.summary);
			}
		} else if (rec.type === "function_call") {
			if (rec.arguments != null) {
				const argsStr = typeof rec.arguments === "string" ? rec.arguments : JSON.stringify(rec.arguments);
				fh.arguments = shortHash(argsStr);
				info.content_prefix_4k_hash = computeContentPrefixHash(argsStr, 4096);
			}
		} else if (rec.type === "function_call_output") {
			if (rec.output != null) {
				fh.output = contentHash(rec.output);
				const outputStr = typeof rec.output === "string" ? rec.output : JSON.stringify(rec.output);
				info.content_prefix_1k_hash = shortHash(outputStr.slice(0, 1024));
				info.content_prefix_4k_hash = shortHash(outputStr.slice(0, 4096));
			}
		} else if (rec.type === "message") {
			if (rec.content != null) {
				fh.content = contentHash(rec.content);
				const contentStr = JSON.stringify(rec.content);
				info.content_prefix_1k_hash = shortHash(contentStr.slice(0, 1024));
				info.content_prefix_4k_hash = shortHash(contentStr.slice(0, 4096));
			}
		}

		info.item_hash = shortHash(JSON.stringify(item));
		return info;
	}

	// ── Anthropic-format: role-based ────────────────────────────────────

	if (rec.role === "assistant") {
		const content = rec.content;
		if (Array.isArray(content)) {
			fh.content = contentHash(content);
			const first = content[0] as Record<string, unknown> | undefined;
			if (first) {
				info.type = typeof first.type === "string" ? first.type : undefined;
				if (first.id != null && info.id == null) {
					info.id = String(first.id);
					fh.id = shortHash(String(first.id));
				}
				if (first.type === "toolCall") {
					info.name = typeof first.name === "string" ? first.name : undefined;
					if (info.name) fh.name = shortHash(info.name);
					fh.arguments = contentHash(first.arguments);
				}
			}
		} else if (typeof content === "string") {
			fh.content = contentHash(content);
			info.type = "text";
			info.content_prefix_1k_hash = shortHash(content.slice(0, 1024));
			info.content_prefix_4k_hash = shortHash(content.slice(0, 4096));
		}
		if (rec.thinkingSignature != null) {
			fh.signature = shortHash(String(rec.thinkingSignature));
		}
	} else if (rec.role === "user") {
		const content = rec.content;
		if (typeof content === "string") {
			fh.content = contentHash(content);
			info.type = "text";
			info.content_prefix_1k_hash = shortHash(content.slice(0, 1024));
			info.content_prefix_4k_hash = shortHash(content.slice(0, 4096));
		} else if (Array.isArray(content)) {
			fh.content = contentHash(content);
			const first = content[0] as Record<string, unknown> | undefined;
			info.type = first && typeof first.type === "string" ? first.type : "array";
			const contentStr = JSON.stringify(content);
			info.content_prefix_1k_hash = shortHash(contentStr.slice(0, 1024));
			info.content_prefix_4k_hash = shortHash(contentStr.slice(0, 4096));
		}
	} else if (rec.role === "toolResult") {
		fh.output = contentHash(rec.content);
		const outputStr = typeof rec.content === "string" ? rec.content : JSON.stringify(rec.content);
		info.content_prefix_1k_hash = shortHash(outputStr.slice(0, 1024));
		info.content_prefix_4k_hash = shortHash(outputStr.slice(0, 4096));
	} else if (rec.role === "system" || rec.role === "developer") {
		if (typeof rec.content === "string") {
			fh.content = shortHash(rec.content);
			info.type = "text";
			info.content_prefix_1k_hash = shortHash(rec.content.slice(0, 1024));
			info.content_prefix_4k_hash = shortHash(rec.content.slice(0, 4096));
		} else if (Array.isArray(rec.content)) {
			fh.content = contentHash(rec.content);
		}
	} else {
		// Generic fallback
		fh.content = contentHash(item);
		info.type = "unknown";
	}

	info.item_hash = shortHash(JSON.stringify(item));
	return info;
}

// ---------------------------------------------------------------------------
// Diff vs previous request
// ---------------------------------------------------------------------------

function computeDiffPrev(
	inputHash: string,
	sysHash: string,
	toolsHash: string,
	itemHashes: string[],
	systemSegmentHashes: string[],
	items: ItemInfo[],
): Record<string, unknown> | null {
	if (!prevSnapshot) return null;

	const topLevelChanged: string[] = [];
	if (inputHash !== prevSnapshot.input_hash) topLevelChanged.push("input_hash");
	if (sysHash !== prevSnapshot.sys_hash) topLevelChanged.push("sys_hash");
	if (toolsHash !== prevSnapshot.tools_hash) topLevelChanged.push("tools_hash");

	// Find first changed item index
	let firstChangedIndex = -1;
	const maxLen = Math.max(itemHashes.length, prevSnapshot.item_hashes.length);
	for (let i = 0; i < maxLen; i++) {
		const curr = itemHashes[i] ?? null;
		const prev = prevSnapshot.item_hashes[i] ?? null;
		if (curr !== prev) {
			firstChangedIndex = i;
			break;
		}
	}

	let changedItemFields: string[] | undefined;
	let prevItemHash: string | null | undefined;
	let currItemHash: string | null | undefined;

	if (firstChangedIndex >= 0) {
		prevItemHash = prevSnapshot.item_hashes[firstChangedIndex] ?? null;
		currItemHash = itemHashes[firstChangedIndex] ?? null;

		// Field-level diff for the first changed item
		const prevItem = prevSnapshot.items.find((it) => it.i === firstChangedIndex);
		const currItem = items.find((it) => it.i === firstChangedIndex);
		if (prevItem && currItem) {
			const changed: string[] = [];
			const keys = new Set([...Object.keys(prevItem.field_hashes), ...Object.keys(currItem.field_hashes)]);
			for (const key of keys) {
				const pv = (prevItem.field_hashes as unknown as Record<string, string | null>)[key];
				const cv = (currItem.field_hashes as unknown as Record<string, string | null>)[key];
				if (pv !== cv) changed.push(key);
			}
			if (changed.length > 0) changedItemFields = changed;
		}
	}

	// Find which system segment changed
	let changedSystemSegment: number | undefined;
	if (sysHash !== prevSnapshot.sys_hash) {
		const prevSegs = prevSnapshot.system_segment_hashes;
		const segLen = Math.max(prevSegs.length, systemSegmentHashes.length);
		for (let i = 0; i < segLen; i++) {
			if ((prevSegs[i] ?? null) !== (systemSegmentHashes[i] ?? null)) {
				changedSystemSegment = i;
				break;
			}
		}
	}

	const diff: Record<string, unknown> = {
		top_level_changed: topLevelChanged,
	};
	if (firstChangedIndex >= 0) {
		diff.first_changed_input_index = firstChangedIndex;
		if (changedItemFields) diff.changed_item_fields = changedItemFields;
		if (prevItemHash != null) diff.prev_item_hash = prevItemHash;
		if (currItemHash != null) diff.curr_item_hash = currItemHash;
	}
	if (changedSystemSegment !== undefined) {
		diff.changed_system_segment = changedSystemSegment;
	}

	return diff;
}

// ---------------------------------------------------------------------------
// Snapshot persistence
// ---------------------------------------------------------------------------

function saveSnapshot(
	inputHash: string,
	sysHash: string,
	toolsHash: string,
	itemHashes: string[],
	systemSegmentHashes: string[],
	items: ItemInfo[],
): void {
	prevSnapshot = {
		input_hash: inputHash,
		sys_hash: sysHash,
		tools_hash: toolsHash,
		item_hashes: itemHashes,
		system_segment_hashes: systemSegmentHashes,
		items: items.map((it) => ({
			i: it.i,
			item_hash: it.item_hash,
			field_hashes: { ...it.field_hashes },
		})),
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CacheDebugRequest {
	model?: {
		id?: string;
		name?: string;
		api?: string;
		provider?: string;
		reasoning?: boolean;
		baseUrl?: string;
	};
	systemText: string;
	messages: unknown[];
	tools: unknown[];
	/** OpenAI Responses: `prompt_cache_key` sent to the API. */
	promptCacheKey?: string;
	/** OpenAI Responses: `prompt_cache_retention` sent to the API. */
	promptCacheRetention?: string;
	/** Request headers (provider-specific, e.g. `session_id`, `x-client-request-id`). */
	headers?: Record<string, string>;
	/** OpenAI Responses: `reasoning` param object. */
	reasoningParams?: unknown;
	/** OpenAI Responses: `include` param. */
	includeParams?: unknown;
	/** OpenAI Responses: `store` param. */
	store?: boolean;
}

/**
 * Log request details right before the provider HTTP call.
 * Returns a `request_id` to pair with `logResponse`.
 */
export function logRequest(req: CacheDebugRequest): string {
	tryEnable();
	const requestId = generateRequestId();
	if (!enabled) return requestId;

	turn++;

	// Build ordered items: system, tools, messages
	const systemRole =
		req.model?.api === "openai-responses" && req.model?.reasoning ? "developer" : "system";
	const allItems: unknown[] = [
		{ role: systemRole, content: req.systemText },
		...(req.tools ?? []),
		...req.messages,
	];

	// System segments
	const systemSegments = computeSystemSegments(req.systemText);
	const systemSegmentHashes = systemSegments.map((s) => s.hash);

	// Per-item extraction (limit to 80 items)
	const itemHashes: string[] = [];
	const itemsInfo: ItemInfo[] = [];
	const LIMIT = 80;
	for (let i = 0; i < allItems.length; i++) {
		const h = shortHash(JSON.stringify(allItems[i]));
		itemHashes.push(h);
		if (i < LIMIT) {
			itemsInfo.push(extractItemInfo(i, allItems[i]));
		}
	}

	// Top-level hashes
	const fullJson = JSON.stringify(allItems);
	const inputHash = shortHash(fullJson);
	const sysHash = shortHash(req.systemText);
	const toolsJson = JSON.stringify(req.tools ?? []);
	const toolsHash = shortHash(toolsJson);

	// Prefix hashes for change isolation
	const prefix4kHash = shortHash(fullJson.slice(0, 4096));
	const prefix16kHash = shortHash(fullJson.slice(0, 16384));

	// Diff against previous request
	const diffPrev = computeDiffPrev(inputHash, sysHash, toolsHash, itemHashes, systemSegmentHashes, itemsInfo);

	// Save snapshot for next diff
	saveSnapshot(inputHash, sysHash, toolsHash, itemHashes, systemSegmentHashes, itemsInfo);

	// ── Build log entry ────────────────────────────────────────────────

	const entry: Record<string, unknown> = {
		ts: new Date().toISOString(),
		turn,
		request_id: requestId,
		type: "request",
		model: req.model?.name,
		api: req.model?.api,
		provider: req.model?.provider,
		reasoning: req.model?.reasoning ?? false,
		input_hash: inputHash,
		prefix_4k_hash: prefix4kHash,
		prefix_16k_hash: prefix16kHash,
		sys_hash: sysHash,
		tools_hash: toolsHash,
		tools_count: (req.tools ?? []).length,
		input_items_count: allItems.length,
		system_segments: systemSegments,
		system_segment_hashes: systemSegmentHashes,
		input_items: itemsInfo,
		item_hashes: itemHashes,
	};

	// Prefix hash for long inputs
	if (fullJson.length > 65536) {
		entry.prefix_64k_hash = shortHash(fullJson.slice(0, 65536));
	}

	// Diff
	if (diffPrev) entry.diff_prev = diffPrev;

	// ── OpenAI Responses-specific fields ───────────────────────────────

	if (req.model?.api === "openai-responses") {
		entry.prompt_cache_key = req.promptCacheKey ?? null;
		entry.prompt_cache_retention = req.promptCacheRetention ?? null;
		entry.store = req.store ?? false;
		if (req.headers) {
			entry.headers_hash = shortHash(JSON.stringify(req.headers));
			entry.headers_summary = {
				session_id: req.headers["session_id"] ?? null,
				x_client_request_id: req.headers["x-client-request-id"] ?? null,
			};
		}
		if (req.reasoningParams != null) {
			entry.reasoning_param_hash = shortHash(JSON.stringify(req.reasoningParams));
		}
		if (req.includeParams != null) {
			entry.include_hash = shortHash(JSON.stringify(req.includeParams));
		}
	}

	try {
		appendFileSync(logPath, JSON.stringify(entry) + "\n");
	} catch {
		// best-effort
	}

	return requestId;
}

/**
 * Log response usage data.
 * @param usage  Token usage from the provider response.
 * @param requestId  The `request_id` returned by the corresponding `logRequest` call.
 */
export function logResponse(
	usage: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
	},
	requestId: string,
): void {
	if (!enabled) return;

	const total = usage?.input ?? 0;
	const cached = usage?.cacheRead ?? 0;
	const uncached = total - cached;
	const ratio = total > 0 ? cached / total : 0;

	const entry: Record<string, unknown> = {
		ts: new Date().toISOString(),
		turn,
		request_id: requestId,
		type: "response",
		input_tokens_total: total,
		input_tokens_cached: cached,
		input_tokens_uncached: uncached,
		output_tokens: usage?.output ?? 0,
		cache_write_tokens: usage?.cacheWrite ?? 0,
		cache_ratio: Math.round(ratio * 1000) / 1000,
		raw_usage: usage,
	};

	if (cached <= 100 && total > 5000) {
		entry.ANOMALY = `cached=${cached} total=${total} (ratio=${entry.cache_ratio})`;
	}

	try {
		appendFileSync(logPath, JSON.stringify(entry) + "\n");
	} catch {
		// best-effort
	}
}

export { shortHash };
