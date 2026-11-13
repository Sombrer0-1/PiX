import type { SessionManager } from "./session-manager.ts";

interface SessionFileContext {
	cwd: string;
	sessionDir: string;
}

/** Host-owned writable session files. Reads and listing can use the SDK directly. */
export interface SessionFileHost {
	resolveSessionDir(options: { agentDir: string; sessionDir?: string }): string | Promise<string>;
	create(
		options: SessionFileContext & {
			id?: string;
			parentSession?: string;
			parent?: SessionManager;
			persist?: boolean;
		},
	): Promise<SessionManager>;
	open(
		options: SessionFileContext & { path: string; cwdOverride?: string; previous?: SessionManager },
	): Promise<SessionManager>;
	fork(options: SessionFileContext & { sourcePath: string; id?: string }): Promise<SessionManager>;
	branch(options: SessionFileContext & { source: SessionManager; leafId: string | null }): Promise<SessionManager>;
	import(options: SessionFileContext & { sourcePath: string; cwdOverride?: string }): Promise<SessionManager>;
	isCurrent?(path: string, sessionManager: SessionManager): boolean;
	rename(options: { path: string; name: string }): Promise<void>;
	delete(options: { path: string; active?: SessionManager }): Promise<void>;
	release(sessionManager: SessionManager): Promise<void>;
}
