import type { CompressionState } from "acp-kernel";

export const ACP_TOOL_NAMES = ["compress", "decompress", "search_context", "acp_status"] as const;
export type AcpToolName = (typeof ACP_TOOL_NAMES)[number];

export interface AcpSidecarFile {
	version: 1;
	state: CompressionState;
}

export interface CompressRangeArgs {
	startId: string;
	endId: string;
	summary: string;
	topic?: string;
}

export interface CompressToolArgs {
	topic?: string;
	content: CompressRangeArgs[] | string;
}

export interface DecompressToolArgs {
	blockId: string;
	full?: boolean;
	inline?: boolean;
}

export interface SearchContextToolArgs {
	query: string;
}

export interface AcpStatusToolArgs {
	scope?: "uncompressed" | "compressed";
	view?: "messages";
}

export const ACP_NUDGE_FAIL_LIMIT = 3;
