/**
 * Managed cua-driver installer.
 *
 * Flow: stream the platform release asset into
 * <agentDir>/computer-use/tmp/<uuid>.<ext> (AbortController cancels) -> sha256
 * compare against DRIVER_ASSETS[platform].sha256 (mismatch = failed, temp file
 * deleted, the archive is NEVER executed) -> extract into
 * <agentDir>/computer-use/cua-driver/<ver>.staging-<uuid>/ -> verify the
 * executable exists, chmod 0o755 on POSIX, best-effort strip the macOS
 * quarantine attribute -> rename staging over the final directory (an existing
 * install is renamed to <final>.bak first, restored if the replace fails and
 * removed once the new directory lands) -> write the install.json receipt.
 * The driver is never started here. Cancellation is honored through extraction:
 * aborting kills a running tar child.
 *
 * Extraction uses the OS-provided tar only (no npm archive dependency):
 * /usr/bin/tar on macOS/Linux, and on Windows the absolute path
 * %SystemRoot%\System32\tar.exe - never PATH resolution, because Git for
 * Windows / MSYS2 GNU tar often comes first on PATH and cannot read zip.
 *
 * `install` is single-flight: concurrent calls share one download/promise and
 * each listener receives every progress update (a late joiner receives the
 * latest one immediately). Failures and cancellations throw ComputerUseError
 * ("driver_error" / "cancelled") after emitting a terminal progress event.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat, writeFile, access } from "node:fs/promises";
import { finished } from "node:stream/promises";
import path from "node:path";
import type { ComputerUsePlatform, InstallProgress } from "../../shared/computer-use-types.js";
import { ComputerUseError, errorText } from "./contracts.js";
import { managedDriverDir, managedDriverRoot } from "./driver-locator.js";
import type { DriverAsset } from "./driver-manifest.js";
import { DRIVER_ASSETS, DRIVER_RELEASE_BASE_URL, DRIVER_VERSION } from "./driver-manifest.js";

const STALE_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PROGRESS_BYTE_STEP = 256 * 1024;
const COMMAND_STDERR_MAX_CHARS = 16 * 1024;
/** A hung tar must not pin isInstalling() forever: killed and failed after this budget. */
const EXTRACT_TIMEOUT_MS = 120_000;

/** install.json receipt written into the managed directory. */
interface InstallReceipt {
	schemaVersion: 1;
	version: string;
	platform: ComputerUsePlatform;
	asset: string;
	sha256: string;
	executable: string;
	installedAt: number;
}

interface ActiveInstall {
	promise: Promise<string>;
	listeners: Set<(progress: InstallProgress) => void>;
	controller: AbortController;
}

export interface DriverInstallerDeps {
	agentDir: string;
	platform: ComputerUsePlatform;
	fetchImpl?: typeof fetch;                 // 测试注入
	extract?: (archive: string, kind: "zip" | "tar.gz", destDir: string, signal?: AbortSignal) => Promise<void>; // 测试注入
	baseUrl?: string;                         // 测试注入（本地 http server）
	move?: (from: string, to: string) => Promise<void>; // 测试注入：替换失败演练用的 rename 缝
	remove?: (target: string) => Promise<void>;          // 测试注入：缺省 rm(recursive, force)——备份删除失败演练用
}

function pathExists(target: string): Promise<boolean> {
	return access(target).then(() => true, () => false);
}

/** Hint for install failures the user can work around manually. */
function manualDownloadHint(asset: DriverAsset): string {
	return `也可以手动下载 ${asset.fileName} 并解压，然后在 设置 › 电脑操控 中填写 cua-driver 可执行文件路径。`;
}

/** Absolute path of the OS tar used by the default extractor. Exposed for tests. */
export function systemTarPath(platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") {
		// path.win32 on purpose: this branch must produce a legal Windows path even
		// when called from a non-Windows host (tests probing the win32 layout).
		return path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
	}
	return "/usr/bin/tar";
}

/** sha256 of a file as lowercase hex. Exposed for tests. */
export async function sha256File(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) {
		hash.update(chunk as Buffer);
	}
	return hash.digest("hex");
}

/** Download tmp dir: <agentDir>/computer-use/tmp. */
export function installerTmpDir(agentDir: string): string {
	return path.join(agentDir, "computer-use", "tmp");
}

/**
 * Managed driver root, delegated to driver-locator so both modules share one
 * definition; also the sweep root for removeStaleEntries(_, "staging").
 */
export function installerDriverRoot(agentDir: string): string {
	return managedDriverRoot(agentDir);
}

/** Staging directory names: <DRIVER_VERSION>.staging-<uuid> (see _runInstall). */
const STAGING_DIR_NAME_PATTERN = /\.staging-[0-9a-f-]{6,}$/;

/**
 * Best-effort sweep of crashed-install leftovers older than 24h.
 * kind "staging": every `<ver>.staging-<uuid>/` under `dir` (30-47 MB each; a
 * live install's staging dir is minutes old, so fresh ones are never touched,
 * and non-staging entries like the versioned managed dir are ignored).
 * kind "tmp": download leftovers in the tmp dir. Never throws; also run at
 * service startup.
 */
export async function removeStaleEntries(dir: string, kind: "staging" | "tmp"): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	const cutoff = Date.now() - STALE_TMP_MAX_AGE_MS;
	for (const entry of entries) {
		if (kind === "staging" && !STAGING_DIR_NAME_PATTERN.test(entry)) continue;
		const target = path.join(dir, entry);
		try {
			const info = await stat(target);
			if (info.mtimeMs >= cutoff) continue;
			await rm(target, { recursive: true, force: true });
		} catch (err) {
			const reason = kind === "staging" ? "旧 staging 目录清理失败" : "临时文件清理失败";
			console.warn(`[ComputerUse] ${reason}（${target}）：${errorText(err)}`);
		}
	}
}

/** Await a single stream write (callback fires when the chunk is flushed). */
function writeToStream(stream: WriteStream, chunk: Uint8Array): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		stream.write(Buffer.from(chunk), (err) => (err ? reject(err) : resolve()));
	});
}

/**
 * Run a child with an argv array, never a shell string; rejects on spawn error
 * or non-zero exit. Aborting `signal` or exceeding `timeoutMs` kills the child
 * and rejects. Exposed for tests.
 */
export function runCommand(
	command: string,
	args: readonly string[],
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const child = spawn(command, [...args], { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const killChild = (): void => {
			try {
				child.kill();
			} catch {
				// The close event still fires and settles the promise.
			}
		};
		const cleanup = (): void => {
			if (timer !== undefined) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", killChild);
		};
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < COMMAND_STDERR_MAX_CHARS) stderr += chunk.toString("utf8");
		});
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error(`${command} 启动失败：${errorText(err)}`));
		});
		child.on("close", (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (code === 0) resolve();
			else if (timedOut) reject(new Error(`${command} 超时（${opts.timeoutMs} ms），已终止`));
			else if (opts.signal?.aborted === true) reject(new Error(`${command} 已取消`));
			else reject(new Error(`${command} 退出码 ${code ?? "unknown"}：${stderr.trim()}`));
		});
		if (opts.signal !== undefined) {
			if (opts.signal.aborted) killChild();
			else opts.signal.addEventListener("abort", killChild, { once: true });
		}
		if (opts.timeoutMs !== undefined) {
			timer = setTimeout(() => {
				timedOut = true;
				killChild();
			}, opts.timeoutMs);
		}
	});
}

/** Default extractor: OS tar only. tar.gz uses -xzf, zip uses -xf (Windows bsdtar). Abort kills tar; a hung tar is killed after EXTRACT_TIMEOUT_MS. */
async function defaultExtract(
	archivePath: string,
	kind: "zip" | "tar.gz",
	destDir: string,
	signal?: AbortSignal,
): Promise<void> {
	const tarPath = systemTarPath();
	if (!(await pathExists(tarPath))) {
		throw new Error(`系统 tar 不可用（${tarPath}）`);
	}
	await runCommand(
		tarPath,
		kind === "tar.gz"
			? ["-xzf", archivePath, "-C", destDir]
			: ["-xf", archivePath, "-C", destDir],
		{ signal, timeoutMs: EXTRACT_TIMEOUT_MS },
	);
}

/** Best-effort removal of the macOS quarantine flag; failures are ignored. */
async function removeQuarantine(target: string): Promise<void> {
	try {
		await runCommand("/usr/bin/xattr", ["-dr", "com.apple.quarantine", target]);
	} catch (err) {
		console.warn(`[ComputerUse] 移除 macOS 隔离属性失败（已忽略）：${errorText(err)}`);
	}
}

export class DriverInstaller {
	private readonly _agentDir: string;
	private readonly _platform: ComputerUsePlatform;
	private readonly _fetchImpl: typeof fetch;
	private readonly _extract: ((archive: string, kind: "zip" | "tar.gz", destDir: string, signal?: AbortSignal) => Promise<void>) | null;
	private readonly _move: ((from: string, to: string) => Promise<void>) | null;
	private readonly _remove: (target: string) => Promise<void>;
	private readonly _baseUrl: string;
	private _active: ActiveInstall | null = null;
	private _lastProgress: InstallProgress | null = null;

	constructor(deps: DriverInstallerDeps) {
		this._agentDir = deps.agentDir;
		this._platform = deps.platform;
		this._fetchImpl = deps.fetchImpl ?? fetch;
		this._extract = deps.extract ?? null;
		this._move = deps.move ?? null;
		this._remove = deps.remove ?? ((target: string) => rm(target, { recursive: true, force: true }));
		this._baseUrl = (deps.baseUrl ?? DRIVER_RELEASE_BASE_URL).replace(/\/+$/, "");
	}

	/**
	 * Single-flight: concurrent calls share one promise. Resolves to the
	 * installed executable path. Emits progress. Throws ComputerUseError on
	 * failure/cancel.
	 */
	install(onProgress: (progress: InstallProgress) => void): Promise<string> {
		const active = this._active;
		if (active !== null) {
			active.listeners.add(onProgress);
			const lastProgress = this._lastProgress;
			if (lastProgress !== null) {
				try {
					onProgress(lastProgress);
				} catch (err) {
					console.warn(`[ComputerUse] 安装进度回调抛错（已忽略）：${errorText(err)}`);
				}
			}
			return active.promise;
		}
		const controller = new AbortController();
		const listeners = new Set<(progress: InstallProgress) => void>([onProgress]);
		const emit = (progress: InstallProgress): void => {
			this._lastProgress = progress;
			for (const listener of [...listeners]) {
				try {
					listener(progress);
				} catch (err) {
					console.warn(`[ComputerUse] 安装进度回调抛错（已忽略）：${errorText(err)}`);
				}
			}
		};
		const promise = this._runInstall(controller, emit).finally(() => {
			this._active = null;
			this._lastProgress = null;
		});
		this._active = { promise, listeners, controller };
		return promise;
	}

	cancel(): void {
		this._active?.controller.abort();
	}

	isInstalling(): boolean {
		return this._active !== null;
	}

	private throwIfAborted(signal: AbortSignal): void {
		if (signal.aborted) throw new ComputerUseError("cancelled", "驱动安装已取消");
	}

	private async _runInstall(controller: AbortController, emit: (progress: InstallProgress) => void): Promise<string> {
		const asset = DRIVER_ASSETS[this._platform];
		const signal = controller.signal;
		const tmpDir = installerTmpDir(this._agentDir);
		const driverRoot = installerDriverRoot(this._agentDir);
		const managedDir = managedDriverDir(this._agentDir);
		const stagingDir = path.join(driverRoot, `${DRIVER_VERSION}.staging-${randomUUID()}`);
		const archivePath = path.join(tmpDir, `${randomUUID()}.${asset.archive}`);
		let receivedBytes = 0;
		let totalBytes: number | null = asset.sizeBytes;
		try {
			// Crash recovery first (see _recoverCrashedBackup): heal a leftover
			// <final>.bak before anything in this attempt can fail or delete it.
			await this._recoverCrashedBackup(managedDir);
			await mkdir(tmpDir, { recursive: true });
			await removeStaleEntries(tmpDir, "tmp");
			this.throwIfAborted(signal);
			emit({ phase: "downloading", receivedBytes: 0, totalBytes: asset.sizeBytes });
			await this._download(asset, archivePath, signal, (received, total) => {
				receivedBytes = received;
				totalBytes = total;
				emit({ phase: "downloading", receivedBytes: received, totalBytes: total });
			});
			this.throwIfAborted(signal);
			emit({ phase: "verifying", receivedBytes, totalBytes });
			const digest = await sha256File(archivePath);
			if (digest !== asset.sha256) {
				throw new ComputerUseError(
					"driver_error",
					`校验失败，已拒绝安装：${asset.fileName} 的 sha256 与清单不符（期望 ${asset.sha256}，实际 ${digest}），文件未被安装或执行`,
					manualDownloadHint(asset),
				);
			}
			this.throwIfAborted(signal);
			emit({ phase: "extracting", receivedBytes, totalBytes });
			await mkdir(stagingDir, { recursive: true });
			this.throwIfAborted(signal);
			await (this._extract ?? defaultExtract)(archivePath, asset.archive, stagingDir, signal);
			this.throwIfAborted(signal);
			const stagedExecutable = path.join(stagingDir, asset.executable);
			if (!(await pathExists(stagedExecutable))) {
				throw new ComputerUseError(
					"driver_error",
					`解压后的归档中缺少可执行文件 ${asset.executable}`,
					manualDownloadHint(asset),
				);
			}
			if (process.platform !== "win32") await chmod(stagedExecutable, 0o755);
			if (process.platform === "darwin") await removeQuarantine(stagedExecutable);
			// The receipt travels INSIDE the staged directory: the landing rename
			// makes staging and receipt land atomically, so a crash after the .bak
			// delete but before a separate receipt write can no longer leave a
			// receipt-less (i.e. "corrupt") managed install behind.
			const receipt: InstallReceipt = {
				schemaVersion: 1,
				version: DRIVER_VERSION,
				platform: this._platform,
				asset: asset.fileName,
				sha256: asset.sha256,
				executable: asset.executable,
				installedAt: Date.now(),
			};
			await writeFile(path.join(stagingDir, "install.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
			await this._landInstall(stagingDir, managedDir);
			emit({ phase: "done", receivedBytes, totalBytes });
			return path.join(managedDir, asset.executable);
		} catch (err) {
			if (signal.aborted) {
				const cancelled = new ComputerUseError("cancelled", "驱动安装已取消");
				emit({ phase: "cancelled", receivedBytes, totalBytes, error: cancelled.message });
				throw cancelled;
			}
			const failure = err instanceof ComputerUseError
				? err
				: new ComputerUseError("driver_error", `驱动安装失败：${errorText(err)}`, manualDownloadHint(asset));
			emit({ phase: "failed", receivedBytes, totalBytes, error: failure.message });
			throw failure;
		} finally {
			await rm(archivePath, { force: true }).catch(() => undefined);
			await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/** Stream the release asset to disk; progress is emitted at most every PROGRESS_BYTE_STEP bytes. */
	private async _download(
		asset: DriverAsset,
		archivePath: string,
		signal: AbortSignal,
		onBytes: (received: number, total: number | null) => void,
	): Promise<void> {
		const url = `${this._baseUrl}/${asset.fileName}`;
		let response: Response;
		try {
			response = await this._fetchImpl(url, { signal, redirect: "follow" });
		} catch (err) {
			if (signal.aborted) throw err;
			throw new ComputerUseError("driver_error", `下载驱动失败（${url}）：${errorText(err)}`, manualDownloadHint(asset));
		}
		if (!response.ok) {
			throw new ComputerUseError(
				"driver_error",
				`下载驱动失败：HTTP ${response.status} ${response.statusText}（${url}）`,
				manualDownloadHint(asset),
			);
		}
		const body = response.body;
		if (body === null) {
			throw new ComputerUseError("driver_error", `下载驱动失败：响应没有数据流（${url}）`, manualDownloadHint(asset));
		}
		const contentLength = Number(response.headers.get("content-length"));
		const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : asset.sizeBytes;
		const stream = createWriteStream(archivePath);
		// A WriteStream also emits "error" on its own (open failure, ENOSPC)
		// outside the write-callback path; without a listener that is an
		// uncaught exception that kills the process. Forward it into the same
		// rejection the loop below awaits - a promise settles once, so the two
		// paths never double-reject.
		let rejectStreamFailure!: (err: Error) => void;
		const streamFailure = new Promise<never>((_resolve, reject) => {
			rejectStreamFailure = reject;
		});
		void streamFailure.catch(() => undefined); // no unhandled rejection while no race is attached
		stream.on("error", (err: Error) => rejectStreamFailure(err));
		const reader = body.getReader();
		let received = 0;
		let lastEmitted = 0;
		try {
			for (;;) {
				const { done, value } = await Promise.race([reader.read(), streamFailure]);
				if (done) break;
				if (value !== undefined) {
					received += value.byteLength;
					await Promise.race([writeToStream(stream, value), streamFailure]);
				}
				if (received - lastEmitted >= PROGRESS_BYTE_STEP) {
					lastEmitted = received;
					onBytes(received, total);
				}
			}
			stream.end();
			await finished(stream);
			onBytes(received, total);
		} catch (err) {
			stream.destroy();
			throw err;
		}
	}

	/** The rename primitive (DI-injectable for tests), shared by recovery and landing. */
	private _moveFn(): (from: string, to: string) => Promise<void> {
		return this._move ?? ((from: string, to: string) => rename(from, to));
	}

	/**
	 * Crash recovery: a previous run may have died between the backup rename
	 * (managedDir → managedDir.bak) and the staging rename, so only the .bak
	 * exists on disk. Restore it up front - before the download - so the user's
	 * last working driver is back in place whether this attempt succeeds or
	 * fails. A failed restore is logged and never blocks the install.
	 */
	private async _recoverCrashedBackup(managedDir: string): Promise<void> {
		const backupDir = `${managedDir}.bak`;
		if (await pathExists(managedDir)) return;
		if (!(await pathExists(backupDir))) return;
		await this._moveFn()(backupDir, managedDir).catch((err: unknown) => {
			console.warn(`[ComputerUse] 崩溃残留的旧驱动备份恢复失败（${backupDir} → ${managedDir}）：${errorText(err)}`);
		});
	}

	/**
	 * Move staging into place with backup protection: the existing install is
	 * renamed to <final>.bak first and deleted only after the new directory
	 * lands; if the final rename fails the backup is restored before rethrowing,
	 * so a failed replace never loses the working driver.
	 */
	private async _landInstall(stagingDir: string, managedDir: string): Promise<void> {
		await mkdir(path.dirname(managedDir), { recursive: true });
		const move = this._moveFn();
		const backupDir = `${managedDir}.bak`;
		// A leftover backup from a previous crashed run must not block the rename below.
		// (_recoverCrashedBackup already restored the crash-leftover case at the
		// start of this install; this rm only clears a stale name.)
		await this._remove(backupDir).catch(() => undefined);
		if (await pathExists(backupDir)) {
			// A swallowed rm failure would make the move(managedDir, backupDir)
			// below fail unconditionally. Throw before managedDir is touched - the
			// existing install stays intact and the message names the manual fix.
			throw new ComputerUseError(
				"driver_error",
				`无法删除残留的旧驱动备份目录 ${backupDir}，请手动删除该目录后重试安装`,
			);
		}
		let hadExisting = false;
		if (await pathExists(managedDir)) {
			hadExisting = true;
			await move(managedDir, backupDir);
		}
		try {
			await move(stagingDir, managedDir);
		} catch (err) {
			if (hadExisting) {
				await move(backupDir, managedDir).catch((restoreErr: unknown) => {
					console.warn(`[ComputerUse] 旧驱动目录恢复失败（${backupDir} → ${managedDir}）：${errorText(restoreErr)}`);
				});
			}
			throw err;
		}
		if (hadExisting) {
			await this._remove(backupDir).catch((err: unknown) => {
				console.warn(`[ComputerUse] 旧驱动目录备份清理失败（${backupDir}）：${errorText(err)}`);
			});
		}
	}
}
