/**
 * Managed / custom cua-driver locator.
 *
 * Read-only resolution, never downloads (that is driver-installer.ts):
 *   1. custom path from the GUI settings, when it exists and is executable;
 *   2. the managed install at <agentDir>/computer-use/cua-driver/<DRIVER_VERSION>/
 *      when its install.json receipt is valid for this platform and the
 *      recorded executable still exists.
 * A managed install whose receipt does not match the locked DRIVER_VERSION /
 * platform / executable / sha256 is treated as corrupt: resolveDriverBinary
 * returns null and the user reinstalls.
 *
 * `probeDriverVersion` runs `<path> --version` with shell:false (the custom
 * path is user input; shell:true would be a command-injection vector) under a
 * 5 s timeout and parses the first semver from stdout+stderr. Every failure -
 * missing file, spawn error, non-zero exit, timeout, no semver - raises
 * ComputerUseError("driver_incompatible"). A custom-path version different from
 * DRIVER_VERSION is still allowed to run: the service reports the
 * "not the PiX-verified version" warning through availabilityDetail.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ComputerUsePlatform } from "../../shared/computer-use-types.js";
import { ComputerUseError, errorText } from "./contracts.js";
import { DRIVER_ASSETS, DRIVER_VERSION, driverChildEnv } from "./driver-manifest.js";

export interface ResolvedDriver { path: string; source: "managed" | "custom"; dir: string }

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_OUTPUT_MAX_CHARS = 64 * 1024;
const SEMVER_PATTERN = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;

const PROBE_HINT = "重新安装驱动，或在 设置 › 电脑操控 中填写可用的 cua-driver 可执行文件路径后重试。";

/** Managed driver root: <agentDir>/computer-use/cua-driver. */
export function managedDriverRoot(agentDir: string): string {
	return path.join(agentDir, "computer-use", "cua-driver");
}

/** Versioned managed install: <agentDir>/computer-use/cua-driver/<DRIVER_VERSION>/. */
export function managedDriverDir(agentDir: string): string {
	return path.join(managedDriverRoot(agentDir), DRIVER_VERSION);
}

function incompatibleError(detail: string): ComputerUseError {
	return new ComputerUseError("driver_incompatible", detail, PROBE_HINT);
}

/** Exists, is a regular file, and passes the X_OK access check (no-op on Windows). */
async function isExecutableFile(candidate: string): Promise<boolean> {
	try {
		const info = await stat(candidate);
		if (!info.isFile()) return false;
		await access(candidate, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Parse <managedDir>/install.json; null on any read/parse/shape failure. */
async function readReceipt(dir: string): Promise<Record<string, unknown> | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path.join(dir, "install.json"), "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** Receipt validity for this PiX build: version/platform/executable/sha256 all pinned. */
function receiptMatchesManagedInstall(receipt: Record<string, unknown>, platform: ComputerUsePlatform): boolean {
	const asset = DRIVER_ASSETS[platform];
	return receipt.schemaVersion === 1
		&& receipt.version === DRIVER_VERSION
		&& receipt.platform === platform
		&& receipt.executable === asset.executable
		&& receipt.sha256 === asset.sha256
		&& typeof receipt.installedAt === "number";
}

/**
 * custom path (if set & exists & executable) > managed install (receipt valid & file exists).
 * Returns null when none. Never downloads.
 */
export async function resolveDriverBinary(opts: {
	agentDir: string;
	platform: ComputerUsePlatform;
	customPath: string | null;
}): Promise<ResolvedDriver | null> {
	const { agentDir, platform, customPath } = opts;
	if (customPath !== null && customPath.length > 0 && (await isExecutableFile(customPath))) {
		return { path: customPath, source: "custom", dir: path.dirname(customPath) };
	}
	const dir = managedDriverDir(agentDir);
	const receipt = await readReceipt(dir);
	if (receipt === null || !receiptMatchesManagedInstall(receipt, platform)) return null;
	const executable = path.join(dir, DRIVER_ASSETS[platform].executable);
	if (!(await isExecutableFile(executable))) return null;
	return { path: executable, source: "managed", dir };
}

/**
 * Run `<path> --version` (timeout 5s, env = driverChildEnv() — sensitive keys
 * stripped, same policy as the MCP child) and return the first semver in its
 * output. Throws ComputerUseError("driver_incompatible") on any failure.
 */
export function probeDriverVersion(binaryPath: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawn(binaryPath, ["--version"], {
				shell: false,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: driverChildEnv(),
			});
		} catch (err) {
			reject(incompatibleError(`无法启动驱动版本探测（${binaryPath}）：${errorText(err)}`));
			return;
		}

		let output = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const collect = (chunk: Buffer): void => {
			if (output.length >= PROBE_OUTPUT_MAX_CHARS) return;
			output += chunk.toString("utf8").slice(0, PROBE_OUTPUT_MAX_CHARS - output.length);
		};
		const finish = (settle: () => void): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			settle();
		};
		const killChild = (): void => {
			try {
				child.kill();
			} catch {
				// ignore kill failures during cleanup
			}
		};

		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		child.on("error", (err: NodeJS.ErrnoException) => {
			finish(() => reject(incompatibleError(`无法执行驱动（${binaryPath}）：${errorText(err)}`)));
		});
		child.on("close", (code: number | null) => {
			finish(() => {
				if (code !== 0) {
					reject(incompatibleError(`驱动版本探测失败（${binaryPath} 退出码 ${code ?? "unknown"}）：${output.trim()}`));
					return;
				}
				const match = SEMVER_PATTERN.exec(output);
				if (match === null) {
					reject(incompatibleError(`驱动版本输出中未找到版本号（${binaryPath}）：${output.trim()}`));
					return;
				}
				resolve(match[0]);
			});
		});
		timer = setTimeout(() => {
			finish(() => {
				killChild();
				reject(incompatibleError(`驱动版本探测超时（${binaryPath}，${PROBE_TIMEOUT_MS} ms）`));
			});
		}, PROBE_TIMEOUT_MS);
	});
}
