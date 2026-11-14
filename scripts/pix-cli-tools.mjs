import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const releases = [
	{
		repo: "BurntSushi/ripgrep",
		tag: "15.2.0",
		archivePrefix: "ripgrep-15.2.0",
		binary: "rg",
		licenses: ["COPYING", "LICENSE-MIT", "UNLICENSE"],
		assets: [
			["win32-x64", "x86_64-pc-windows-msvc.zip", "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5"],
			["win32-arm64", "aarch64-pc-windows-msvc.zip", "e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f"],
			["darwin-x64", "x86_64-apple-darwin.tar.gz", "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1"],
			["darwin-arm64", "aarch64-apple-darwin.tar.gz", "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4"],
			["linux-x64", "x86_64-unknown-linux-musl.tar.gz", "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c"],
			["linux-arm64", "aarch64-unknown-linux-musl.tar.gz", "800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915"],
		],
	},
	{
		repo: "sharkdp/fd",
		tag: "v10.3.0",
		archivePrefix: "fd-v10.3.0",
		binary: "fd",
		licenses: ["LICENSE-APACHE", "LICENSE-MIT"],
		assets: [
			["win32-x64", "x86_64-pc-windows-msvc.zip", "318aa2a6fa664325933e81fda60d523fff29444129e91ebf0726b5b3bcd8b059"],
			["win32-arm64", "aarch64-pc-windows-msvc.zip", "bf9b1e31bcac71c1e95d49c56f0d872f525b95d03854e94b1d4dd6786f825cc5"],
			["darwin-x64", "x86_64-apple-darwin.tar.gz", "50d30f13fe3d5914b14c4fff5abcbd4d0cdab4b855970a6956f4f006c17117a3"],
			["darwin-arm64", "aarch64-apple-darwin.tar.gz", "0570263812089120bc2a5d84f9e65cd0c25e4a4d724c80075c357239c74ae904"],
			["linux-x64", "x86_64-unknown-linux-musl.tar.gz", "2b6bfaae8c48f12050813c2ffe1884c61ea26e750d803df9c9114550a314cd14"],
			["linux-arm64", "aarch64-unknown-linux-musl.tar.gz", "996b9b1366433b211cb3bbedba91c9dbce2431842144d925428ead0adf32020b"],
		],
	},
];

async function extractArchive(archive, cwd) {
	if (archive.endsWith(".zip")) {
		try {
			await exec("unzip", ["-q", archive], { cwd });
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			await exec("busybox", ["unzip", "-q", archive], { cwd });
		}
	} else {
		await exec("tar", ["-xf", archive], { cwd });
	}
}

async function stageRelease(release, [target, suffix, digest], workDir, toolsDir) {
	const filename = `${release.archivePrefix}-${suffix}`;
	const url = `https://github.com/${release.repo}/releases/download/${release.tag}/${filename}`;
	let contents;
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		contents = Buffer.from(await response.arrayBuffer());
	} catch (error) {
		throw new Error(`Could not download ${filename}: ${error.message}`, { cause: error });
	}
	if (createHash("sha256").update(contents).digest("hex") !== digest) {
		throw new Error(`Checksum mismatch for ${filename}`);
	}

	const archive = join(workDir, filename);
	await writeFile(archive, contents);
	await extractArchive(archive, workDir);

	const from = join(workDir, filename.replace(/\.(?:tar\.gz|zip)$/, ""));
	const destination = join(toolsDir, target);
	await mkdir(destination, { recursive: true });
	const binaryName = release.binary + (target.startsWith("win32-") ? ".exe" : "");
	const binary = join(destination, binaryName);
	await copyFile(join(from, binaryName), binary);
	await chmod(binary, 0o755);
	for (const license of release.licenses) {
		await copyFile(join(from, license), join(destination, `${release.binary}-${license}`));
	}
}

export async function stageCliTools(stageDir) {
	const toolsDir = join(stageDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "vendor", "tools");
	const workDir = await mkdtemp(join(tmpdir(), "pix-cli-tools-"));
	try {
		const results = await Promise.allSettled(
			releases.flatMap((release) => release.assets.map((asset) => stageRelease(release, asset, workDir, toolsDir))),
		);
		const failure = results.find((result) => result.status === "rejected");
		if (failure) throw failure.reason;
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}
