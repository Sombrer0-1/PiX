import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const clipboardPackage = "@mariozechner/clipboard";
const lockPath = new URL("../package-lock.json", import.meta.url);

export async function stageCliClipboard(stageDir) {
	const wrapperDir = join(stageDir, "node_modules", clipboardPackage);
	const manifestPath = join(wrapperDir, "package.json");
	const [lock, manifest] = await Promise.all([
		readFile(lockPath, "utf8").then(JSON.parse),
		readFile(manifestPath, "utf8").then(JSON.parse),
	]);

	await Promise.all(
		Object.entries(manifest.optionalDependencies).map(async ([name, version]) => {
			// The published 0.3.9 musl tarballs contain no native addon.
			if (version === "0.3.9" && name.endsWith("-musl")) return;
			const locked = lock.packages[`node_modules/${name}`];
			if (locked?.version !== version) {
				throw new Error(`Clipboard binding ${name}@${version} is missing from package-lock.json`);
			}
			const response = await fetch(locked.resolved);
			if (!response.ok) {
				throw new Error(`Could not download ${name}@${version} (HTTP ${response.status})`);
			}
			const archive = Buffer.from(await response.arrayBuffer());
			const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
			if (integrity !== locked.integrity) {
				throw new Error(`Clipboard binding ${name}@${version} does not match package-lock.json integrity`);
			}
			const filename = `clipboard.${name.slice(clipboardPackage.length + 1)}.node`;
			const binary = execFileSync("tar", ["-xOzf", "-", "--", `package/${filename}`], {
				input: archive,
				maxBuffer: 16 * 1024 * 1024,
			});
			await writeFile(join(wrapperDir, filename), binary);
		}),
	);

	// The wrapper loads adjacent binaries before trying platform-specific npm packages.
	delete manifest.optionalDependencies;
	if (manifest.files) manifest.files.push("clipboard.*.node");
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
