import { createInitialState } from "acp-kernel";
import type { CompressionBlock, CompressionState } from "acp-kernel";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionManager } from "../session-manager.ts";
import { branchContextIds } from "./messages.ts";
import type { AcpSidecarFile } from "./types.ts";

const SIDECAR_VERSION = 1 as const;
const memoryBySessionId = new Map<string, CompressionState>();
/** Upper bound on remembered in-memory states; evicts oldest first (Map insertion order). */
const MEMORY_STATE_LIMIT = 32;

function rememberMemoryState(sessionId: string, state: CompressionState): void {
	memoryBySessionId.delete(sessionId);
	memoryBySessionId.set(sessionId, state);
	while (memoryBySessionId.size > MEMORY_STATE_LIMIT) {
		const oldest = memoryBySessionId.keys().next().value;
		if (oldest === undefined) break;
		memoryBySessionId.delete(oldest);
	}
}

export function sidecarPathForSessionFile(sessionFile: string): string {
	return `${sessionFile}.acp.json`;
}

function serializeSidecar(state: CompressionState): string {
	const payload: AcpSidecarFile = { version: SIDECAR_VERSION, state };
	return `${JSON.stringify(payload)}\n`;
}

function cloneState(state: CompressionState): CompressionState {
	return structuredClone(state);
}

function isCompressionState(value: unknown): value is CompressionState {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return Array.isArray(record.blocks) && typeof record.nextBlockId === "number";
}

type SidecarRead =
	| { kind: "missing" }
	| { kind: "ok"; state: CompressionState }
	| { kind: "corrupt" };

function parseSidecar(raw: string, sessionId: string): SidecarRead {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") {
			console.warn(`[acp] corrupt sidecar for session ${sessionId}: not an object`);
			return { kind: "corrupt" };
		}
		const file = parsed as Partial<AcpSidecarFile>;
		if (file.version !== SIDECAR_VERSION || !isCompressionState(file.state)) {
			console.warn(`[acp] corrupt sidecar for session ${sessionId}: version or state invalid`);
			return { kind: "corrupt" };
		}
		return { kind: "ok", state: cloneState(file.state) };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[acp] corrupt sidecar for session ${sessionId}: ${message}`);
		return { kind: "corrupt" };
	}
}

function readSidecarFile(path: string, sessionId: string): SidecarRead {
	if (!existsSync(path)) return { kind: "missing" };
	try {
		return parseSidecar(readFileSync(path, "utf-8"), sessionId);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[acp] failed to read sidecar ${path}: ${message}`);
		return { kind: "corrupt" };
	}
}

function writeSidecarFile(path: string, state: CompressionState): string {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const json = serializeSidecar(state);
	writeFileSync(path, json, "utf-8");
	return json;
}

function parentSidecarPath(parentSession: string | undefined): string | undefined {
	if (!parentSession) return undefined;
	if (parentSession.endsWith(".acp.json")) return parentSession;
	return sidecarPathForSessionFile(parentSession);
}

function hasUserOrAssistantOnBranch(sm: SessionManager): boolean {
	return sm.getBranch().some(
		(entry) =>
			entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"),
	);
}

function blockMessageIds(block: CompressionBlock): string[] {
	return [...block.directMessageIds, ...block.effectiveMessageIds];
}

function parentSharesBranchIds(parent: CompressionState, sm: SessionManager): boolean {
	const ids = branchContextIds(sm);
	if (ids.size === 0) return false;
	for (const block of parent.blocks) {
		for (const id of blockMessageIds(block)) {
			if (ids.has(id)) return true;
		}
	}
	return false;
}

export class AcpStateStore {
	private state: CompressionState;
	private readonly sessionId: string;
	/** Last content written to the sidecar FILE path; skips identical rewrites. */
	private lastWrittenJson: string | undefined;

	private readonly sessionManager: SessionManager;

	constructor(sessionManager: SessionManager) {
		this.sessionManager = sessionManager;
		this.sessionId = sessionManager.getSessionId();
		this.state = createInitialState();
	}

	getState(): CompressionState {
		return this.state;
	}

	setState(state: CompressionState): void {
		this.state = state;
	}

	loadOrInherit(): void {
		const sessionFile = this.sessionManager.getSessionFile();
		// persist newSession already assigns a jsonl path while isFlushed()===false.
		// Unflushed sessions stay in memory; do not read a disk sidecar even if present.
		if (sessionFile && this.sessionManager.isFlushed()) {
			const own = readSidecarFile(sidecarPathForSessionFile(sessionFile), this.sessionId);
			if (own.kind === "corrupt") {
				this.state = createInitialState();
				return;
			}
			if (own.kind === "ok" && own.state.blocks.length > 0) {
				this.state = own.state;
				this.lastWrittenJson = serializeSidecar(own.state);
				return;
			}
			const empty = own.kind === "ok" ? own.state : undefined;
			if (this.tryInherit(empty)) return;
			this.state = empty ?? createInitialState();
			return;
		}

		const cached = memoryBySessionId.get(this.sessionId);
		if (cached && cached.blocks.length > 0) {
			this.state = cloneState(cached);
			return;
		}
		if (this.tryInherit(cached)) return;
		this.state = cached ? cloneState(cached) : createInitialState();
	}

	flush(): void {
		const sessionFile = this.sessionManager.getSessionFile();
		if (sessionFile && this.sessionManager.isFlushed()) {
			const path = sidecarPathForSessionFile(sessionFile);
			const json = serializeSidecar(this.state);
			// Identical content already on disk: skip the rewrite (guard against
			// a deleted file so recovery still persists).
			if (json === this.lastWrittenJson && existsSync(path)) return;
			this.lastWrittenJson = writeSidecarFile(path, this.state);
			return;
		}
		rememberMemoryState(this.sessionId, cloneState(this.state));
	}

	private tryInherit(own: CompressionState | undefined): boolean {
		const ownMissingOrEmpty = !own || own.blocks.length === 0;
		if (!ownMissingOrEmpty) return false;
		if (!hasUserOrAssistantOnBranch(this.sessionManager)) return false;
		const parentPath = parentSidecarPath(this.sessionManager.getHeader()?.parentSession);
		if (!parentPath) return false;
		const parentRead = readSidecarFile(parentPath, this.sessionId);
		if (parentRead.kind !== "ok") return false;
		if (!parentSharesBranchIds(parentRead.state, this.sessionManager)) return false;
		this.state = parentRead.state;
		return true;
	}
}
