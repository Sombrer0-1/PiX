import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { constants, copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	assertValidSessionId,
	loadEntriesFromFile,
	type SessionFileHost,
	SessionManager,
	sidecarPathForSessionFile,
} from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

type Release = () => Promise<void>;
type FileOperation<K extends keyof SessionFileHost> = Parameters<NonNullable<SessionFileHost[K]>>[0];

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

// Resolve symlinked ancestors as well when a file or subdirectory is new.
function canonicalPath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch (error) {
		const parent = dirname(absolute);
		if (!isMissing(error) || parent === absolute) throw error;
		return join(canonicalPath(parent), relative(parent, absolute));
	}
}

function inside(root: string, path: string): boolean {
	const fromRoot = relative(root, path);
	return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

async function copyAcpState(source: string, target: string): Promise<void> {
	try {
		await copyFile(sidecarPathForSessionFile(source), sidecarPathForSessionFile(target), constants.COPYFILE_EXCL);
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
}

export class CliSessionFiles implements SessionFileHost {
	private root = "";
	private readonly locks = new Map<SessionManager, Release>();
	private readonly defaultAcp: boolean;
	private readonly markNewProject?: (manager: SessionManager, parent?: SessionManager) => void;

	constructor(defaultAcp: boolean, markNewProject?: (manager: SessionManager, parent?: SessionManager) => void) {
		this.defaultAcp = defaultAcp;
		this.markNewProject = markNewProject;
	}

	resolveSessionDir({ agentDir, sessionDir }: FileOperation<"resolveSessionDir">): string {
		this.root = canonicalPath(join(agentDir, "pix-cli-sessions"));
		const target = canonicalPath(resolve(this.root, sessionDir ?? ""));
		if (!inside(this.root, target)) throw new Error("--session-dir must be inside the PiX CLI session directory.");
		return target;
	}

	private ownedPath(path: string): string {
		const target = canonicalPath(path);
		if (!inside(this.root, target) || target === this.root) {
			throw new Error(`Session file is outside the PiX CLI session directory: ${path}`);
		}
		return target;
	}

	private async acquire(path: string): Promise<Release> {
		await mkdir(dirname(path), { recursive: true });
		try {
			return await lockfile.lock(path, { realpath: false });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
				throw new Error(`Session is in use by another PiX CLI: ${path}`, { cause: error });
			}
			throw error;
		}
	}

	private async withLock(
		path: string,
		prepare: () => SessionManager | Promise<SessionManager>,
	): Promise<SessionManager> {
		const release = await this.acquire(path);
		try {
			const manager = await prepare();
			this.locks.set(manager, release);
			return manager;
		} catch (error) {
			await release();
			throw error;
		}
	}

	private async withNewFile(
		path: string,
		prepare: () => SessionManager | Promise<SessionManager>,
	): Promise<SessionManager> {
		return this.withLock(path, async () => {
			if (await this.exists(path)) throw new Error(`Session already exists: ${path}`);
			try {
				return await prepare();
			} catch (error) {
				await this.removeFiles(path);
				throw error;
			}
		});
	}

	private async exists(path: string): Promise<boolean> {
		try {
			await stat(path);
			return true;
		} catch (error) {
			if (!isMissing(error)) throw error;
			return false;
		}
	}

	async create({
		cwd,
		sessionDir,
		id,
		parentSession,
		parent,
		persist = true,
	}: FileOperation<"create">): Promise<SessionManager> {
		const parentPath = parentSession ? canonicalPath(resolve(cwd, parentSession)) : undefined;
		const parentHeader = parentPath
			? parent && this.isCurrent(parentPath, parent)
				? parent.getHeader()
				: loadEntriesFromFile(parentPath)[0]
			: undefined;
		const acp = parentPath ? parentHeader?.type === "session" && parentHeader.acp === true : this.defaultAcp;
		const options = { id: id ?? randomUUID(), parentSession: parentPath, acp };
		if (!persist) {
			const manager = SessionManager.inMemory(cwd, options);
			this.markNewProject?.(manager, parent);
			return manager;
		}
		assertValidSessionId(options.id);
		const targetPath = this.ownedPath(join(sessionDir, `${options.id}.jsonl`));
		return this.withLock(targetPath, async () => {
			if (await this.exists(targetPath)) return SessionManager.open(targetPath, sessionDir);
			const manager = SessionManager.create(cwd, sessionDir, { ...options, targetPath });
			this.markNewProject?.(manager, parent);
			return manager;
		});
	}

	async open({ path, cwd, sessionDir, cwdOverride, previous }: FileOperation<"open">): Promise<SessionManager> {
		const target = canonicalPath(resolve(cwd, path));
		if (!inside(this.root, target)) {
			return this.import({ sourcePath: target, cwd, sessionDir, cwdOverride });
		}
		if (relative(this.root, target) === "") throw new Error(`Expected a session file: ${target}`);
		if (previous && this.isCurrent(target, previous)) {
			const manager = SessionManager.open(target, sessionDir, cwdOverride);
			const release = this.locks.get(previous);
			if (release) {
				this.locks.delete(previous);
				this.locks.set(manager, release);
			}
			return manager;
		}
		return this.withLock(target, async () => {
			if (await this.exists(target)) return SessionManager.open(target, sessionDir, cwdOverride);
			const manager = SessionManager.create(cwdOverride ?? cwd, sessionDir, {
				targetPath: target,
				acp: this.defaultAcp,
			});
			this.markNewProject?.(manager);
			return manager;
		});
	}

	async fork({ sourcePath, cwd, sessionDir, id = randomUUID() }: FileOperation<"fork">): Promise<SessionManager> {
		assertValidSessionId(id);
		const source = canonicalPath(resolve(cwd, sourcePath));
		const targetPath = this.ownedPath(join(sessionDir, `${id}.jsonl`));
		return this.withNewFile(targetPath, async () => {
			const manager = SessionManager.forkFrom(source, cwd, sessionDir, { id, targetPath });
			await copyAcpState(source, targetPath);
			return manager;
		});
	}

	async branch({ source, leafId, cwd, sessionDir }: FileOperation<"branch">): Promise<SessionManager> {
		const sourcePath = source.getSessionFile();
		if (leafId === null) {
			if (sourcePath) return this.create({ cwd, sessionDir, parentSession: sourcePath, parent: source });
			const manager = SessionManager.inMemory(cwd, { acp: source.getAcp() });
			this.markNewProject?.(manager, source);
			return manager;
		}
		const id = randomUUID();
		if (!sourcePath) {
			const manager = source.forkBranch(leafId, { id });
			this.markNewProject?.(manager, source);
			return manager;
		}
		const targetPath = this.ownedPath(join(sessionDir, `${id}.jsonl`));
		return this.withNewFile(targetPath, async () => {
			const manager = source.forkBranch(leafId, { id, targetPath });
			if (manager.isFlushed()) await copyAcpState(sourcePath, targetPath);
			this.markNewProject?.(manager, source);
			return manager;
		});
	}

	async import({ sourcePath, cwd, sessionDir, cwdOverride }: FileOperation<"import">): Promise<SessionManager> {
		const source = canonicalPath(resolve(cwd, sourcePath));
		const id = randomUUID();
		const target = this.ownedPath(join(sessionDir, `${id}.jsonl`));
		return this.withNewFile(target, async () => {
			const [header, ...entries] = loadEntriesFromFile(source);
			if (header?.type !== "session") throw new Error(`Cannot import an invalid session: ${source}`);
			const copiedHeader = { ...header, id, cwd: cwdOverride ?? header.cwd ?? cwd };
			const jsonl = [copiedHeader, ...entries].map((entry) => `${JSON.stringify(entry)}\n`).join("");
			await writeFile(target, jsonl, { flag: "wx" });
			await copyAcpState(source, target);
			return SessionManager.open(target, sessionDir, cwdOverride);
		});
	}

	isCurrent(path: string, sessionManager: SessionManager): boolean {
		const activePath = sessionManager.getSessionFile();
		return activePath !== undefined && relative(activePath, canonicalPath(path)) === "";
	}

	async rename({ path, name }: FileOperation<"rename">): Promise<void> {
		const target = this.ownedPath(path);
		const release = await this.acquire(target);
		try {
			if (!(await this.exists(target))) throw new Error(`Session file does not exist: ${target}`);
			SessionManager.open(target).appendSessionInfo(name);
		} finally {
			await release();
		}
	}

	async delete({ path, active }: FileOperation<"delete">): Promise<void> {
		const target = this.ownedPath(path);
		const activeRelease = active && this.isCurrent(target, active) ? this.locks.get(active) : undefined;
		const release = activeRelease ?? (await this.acquire(target));
		try {
			await this.removeFiles(target);
		} finally {
			if (active && activeRelease) this.locks.delete(active);
			await release();
		}
	}

	private async removeFiles(target: string): Promise<void> {
		await rm(target, { force: true });
		await rm(sidecarPathForSessionFile(target), { force: true });
		SessionManager.invalidateSessionListCache(dirname(target));
	}

	async release(manager: SessionManager): Promise<void> {
		const release = this.locks.get(manager);
		this.locks.delete(manager);
		await release?.();
	}
}
