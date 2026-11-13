import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const npm = (...args) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, stdio: "inherit" });
const loadManifest = (path) => JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));
const rootManifest = loadManifest(".");
const pixPackages = new Set(["packages/pix-runtime", "packages/pix-cli"]);
const workspaces = [
  ...readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`)
    .filter((path) => !pixPackages.has(path)),
  ...rootManifest.workspaces.filter((path) => !path.includes("*")),
];
const previousVersions = new Map(workspaces.map((path) => {
  const manifest = loadManifest(path);
  return [manifest.name, manifest.version];
}));
npm("version", ...process.argv.slice(2), "--no-git-tag-version", "--ignore-scripts", ...workspaces.map((path) => `--workspace=${path}`));
if (process.argv.length === 2) process.exit(0);

const versions = new Map(workspaces.map((path) => {
  const manifest = loadManifest(path);
  return [manifest.name, manifest.version];
}));
for (const path of [...workspaces, ...pixPackages]) {
  const file = join(root, path, "package.json");
  const source = readFileSync(file, "utf8");
  const manifest = JSON.parse(source);
  let changed = false;
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      const operator = /^[~^]/.exec(spec)?.[0] ?? "";
      if (!versions.has(name) || spec !== operator + previousVersions.get(name) || versions.get(name) === previousVersions.get(name)) continue;
      manifest[field][name] = operator + versions.get(name);
      changed = true;
    }
  }
  if (changed) writeFileSync(file, `${JSON.stringify(manifest, null, /^\s+/.exec(source.split("\n")[1])?.[0] ?? "\t")}\n`);
}
for (const args of [[], ["--prefix", "pix"]]) {
  npm(...args, "install", "--package-lock-only", "--ignore-scripts");
}
