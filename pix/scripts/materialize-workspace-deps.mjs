// Replace npm's `file:` dependency symlinks in pix/node_modules with real
// copies of the workspace packages, so electron-builder packs files that are
// physically inside the app directory.
//
// Why this exists:
//   npm installs `file:` deps (e.g. "@earendil-works/pi-agent-core":
//   "file:../packages/agent") as SYMLINKS into pix/node_modules. electron-builder
//   follows those links while collecting files, so pack paths resolve to real
//   locations outside pix/ (e.g. E:\develop\pi\packages\agent\dist\...). Once
//   `build.asarUnpack` is configured, its per-file filter calls getRelativePath
//   on every packed file and THROWS "must be under <appDir>" for such paths.
//   Direct file: copies are not enough: transitive workspace packages (e.g.
//   @earendil-works/pi-tui, a dep of pi-coding-agent) are not listed in pix's
//   package.json, so npm never links them into pix/node_modules. Node then
//   walks up to the monorepo root junction (packages/tui), whose realpath has
//   no `node_modules` segment — the exact case getRelativePath cannot recover.
//   With real copies of the whole production workspace closure, every packed
//   file lives under pix/node_modules and both asar packing and asarUnpack work.
//
// Runs as part of `npm run package` (and therefore package-with-proxy.bat),
// after `npm run build` so fresh dist output and the nested node_modules
// created by sync-nested-deps.mjs are included. Idempotent: a re-run replaces
// whatever npm left there (symlink or previous copy) with a fresh copy.

import { readFileSync, existsSync, lstatSync, rmSync, cpSync, realpathSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const PIX_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PIX_MODULES = join(PIX_DIR, "node_modules");
const pkg = JSON.parse(readFileSync(join(PIX_DIR, "package.json"), "utf8"));

function normalizePath(value) {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isUnder(child, parent) {
  const childPath = normalizePath(realpathSync(child));
  const parentPath = normalizePath(realpathSync(parent));
  return childPath === parentPath || childPath.startsWith(`${parentPath}/`);
}

function destFor(name) {
  return join(PIX_MODULES, ...name.split("/"));
}

function copyPackage(name, src) {
  const dest = destFor(name);
  if (!existsSync(src)) {
    console.warn(`[materialize-workspace-deps] skip ${name}: source missing at ${src}`);
    return false;
  }
  let wasLink = false;
  try {
    wasLink = lstatSync(dest).isSymbolicLink();
  } catch {
    // destination absent (npm install never ran or link was removed)
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(`[materialize-workspace-deps] ${name} -> ${dest}${wasLink ? " (replaced symlink)" : ""}`);
  return true;
}

function readProdDeps(pkgDir) {
  try {
    const json = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    return Object.keys({ ...(json.dependencies ?? {}), ...(json.optionalDependencies ?? {}) });
  } catch {
    return [];
  }
}

/** Node-style walk from `fromDir` looking for node_modules/<name>. */
function findInstalledPackage(fromDir, name) {
  let dir = fromDir;
  const parts = name.split("/");
  while (true) {
    const candidate = join(dir, "node_modules", ...parts);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * electron-builder asarUnpack's getRelativePath throws unless the file is
 * under appDir or the absolute path contains a `node_modules` segment.
 * Workspace junctions resolve to packages/<name>, which has neither.
 */
function isAsarUnsafeOutsidePix(packageDir) {
  if (isUnder(packageDir, PIX_DIR)) return false;
  const real = realpathSync(packageDir);
  return !real.split(/[\\/]/).includes("node_modules");
}

let materialized = 0;
const pending = [];
const seen = new Set();

for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  if (typeof spec !== "string" || !spec.startsWith("file:")) {
    continue;
  }
  const src = resolve(PIX_DIR, spec.slice("file:".length));
  if (!copyPackage(name, src)) continue;
  materialized++;
  seen.add(name);
  pending.push(name);
}

while (pending.length) {
  const name = pending.shift();
  const installed = destFor(name);
  if (!existsSync(installed)) continue;
  for (const dep of readProdDeps(installed)) {
    if (seen.has(dep)) continue;
    const found = findInstalledPackage(installed, dep);
    if (!found) continue;
    if (!isAsarUnsafeOutsidePix(found)) {
      seen.add(dep);
      continue;
    }
    if (!copyPackage(dep, realpathSync(found))) continue;
    materialized++;
    seen.add(dep);
    pending.push(dep);
  }
}

console.log(`[materialize-workspace-deps] done (${materialized} package(s) materialized)`);
if (materialized === 0) {
  console.warn("[materialize-workspace-deps] no file: dependencies found; nothing to do");
}
