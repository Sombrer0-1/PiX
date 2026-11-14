import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { stageCliClipboard } from "./pix-cli-clipboard.mjs";
import { stageCliTools } from "./pix-cli-tools.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const cli = "packages/pix-cli";
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const manifest = readJson(join(repo, cli, "package.json"));
const { packages } = readJson(join(repo, "package-lock.json"));
const workspaces = new Map(
	Object.entries(packages).filter(([, entry]) => entry.link).map(([location, entry]) => [entry.resolved, location]),
);
const clipboard = "@mariozechner/clipboard";

function resolveDependency(location, name) {
	for (let parent = location; parent !== "."; parent = posix.dirname(parent)) {
		if (posix.basename(parent) === "node_modules") continue;
		const candidate = posix.join(parent, "node_modules", name);
		if (packages[candidate]) return candidate;
	}
	const hoisted = `node_modules/${name}`;
	return packages[hoisted] ? hoisted : undefined;
}

function stageDependencies(stage) {
	const seen = new Set();
	const pending = [cli];
	while (pending.length) {
		const owner = pending.pop();
		// The release embeds clipboard bindings next to the loader for every platform.
		if (owner === `node_modules/${clipboard}`) continue;
		const entry = packages[owner];
		const source = entry.link ? entry.resolved : owner;
		const { dependencies, optionalDependencies } = packages[source];
		for (const name of Object.keys({ ...dependencies, ...optionalDependencies })) {
			const location = resolveDependency(source, name);
			if (!location || !existsSync(join(repo, location, "package.json"))) {
				if (optionalDependencies?.[name] && name !== clipboard) continue;
				throw new Error(`Missing installed CLI dependency ${name} from ${source}. Run npm ci --ignore-scripts.`);
			}
			if (seen.has(location)) continue;
			seen.add(location);
			const lock = packages[location];
			const packageSource = lock.link ? lock.resolved : location;
			const installed = join(repo, packageSource);
			const pkg = readJson(join(installed, "package.json"));
			if (pkg.version !== packages[packageSource].version) {
				throw new Error(`Unexpected version at ${packageSource}: ${pkg.version}. Run npm ci --ignore-scripts.`);
			}
			const packageRoot = location.split("/node_modules/")[0];
			const destination = join(stage, workspaces.get(packageRoot) ?? packageRoot, location.slice(packageRoot.length));
			if (lock.link) {
				stageWorkspace(installed, destination, pkg.name);
			} else {
				cpSync(installed, destination, {
					recursive: true,
					filter: (path) => path !== join(installed, "node_modules"),
				});
			}
			pending.push(location);
		}
	}
}

function stageWorkspace(source, destination, name) {
	mkdirSync(destination, { recursive: true });
	for (const path of ["package.json", "dist", "README.md", "CHANGELOG.md", "docs", "examples"]) {
		const from = join(source, path);
		if (path === "dist" || existsSync(from)) {
			cpSync(from, join(destination, path), {
				recursive: true,
				filter: (file) => !file.slice(from.length).split(/[\\/]/).includes("node_modules"),
			});
		}
	}
	if (name === "@earendil-works/pi-tui") {
		for (const platform of ["darwin", "win32"]) {
			const path = join("native", platform, "prebuilds");
			cpSync(join(source, path), join(destination, path), { recursive: true });
		}
	}
}

if (process.platform === "win32") {
	throw new Error("Pack PiX CLI from Linux, macOS or the WSL Linux filesystem to preserve Unix executable permissions.");
}

const stage = mkdtempSync(join(tmpdir(), "pix-npm-"));
try {
	const destination = join(repo, "dist", "npm");
	mkdirSync(destination, { recursive: true });
	cpSync(join(repo, cli, "dist"), join(stage, "dist"), { recursive: true });
	cpSync(join(repo, "README.md"), join(stage, "README.md"));
	cpSync(join(repo, "LICENSE"), join(stage, "LICENSE"));
	writeFileSync(join(stage, "package.json"), JSON.stringify({
		name: "@sombrer0/pix",
		version: manifest.version,
		description: manifest.description,
		type: manifest.type,
		bin: manifest.bin,
		files: manifest.files,
		engines: manifest.engines,
		license: "MIT",
		repository: { type: "git", url: "git+https://github.com/Sombrer0-1/PiX.git" },
		dependencies: manifest.dependencies,
		bundleDependencies: true,
		publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
	}, null, 2) + "\n");
	stageDependencies(stage);
	const stagedAssets = await Promise.allSettled([stageCliClipboard(stage), stageCliTools(stage)]);
	const failure = stagedAssets.find((result) => result.status === "rejected");
	if (failure) throw failure.reason;
	const [packed] = JSON.parse(execFileSync(process.execPath, [
		process.env.npm_execpath, "pack", "--ignore-scripts", "--json", "--pack-destination", destination,
	], { cwd: stage, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
	console.log(join(destination, packed.filename));
} finally {
	rmSync(stage, { recursive: true, force: true });
}
