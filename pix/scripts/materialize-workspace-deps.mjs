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
//   With real copies (which the repo's own sync-nested-deps.mjs comment already
//   assumes npm produces), every packed file lives under pix/node_modules and
//   both asar packing and asarUnpack work.
//
// Runs as part of `npm run package` (and therefore package-with-proxy.bat),
// after `npm run build` so fresh dist output and the nested node_modules
// created by sync-nested-deps.mjs are included. Idempotent: a re-run replaces
// whatever npm left there (symlink or previous copy) with a fresh copy.

import { readFileSync, existsSync, lstatSync, rmSync, cpSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const PIX_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PIX_MODULES = join(PIX_DIR, "node_modules");
const pkg = JSON.parse(readFileSync(join(PIX_DIR, "package.json"), "utf8"));

let materialized = 0;
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  if (typeof spec !== "string" || !spec.startsWith("file:")) {
    continue;
  }
  const src = resolve(PIX_DIR, spec.slice("file:".length));
  const dest = join(PIX_MODULES, ...name.split("/"));
  if (!existsSync(src)) {
    console.warn(`[materialize-workspace-deps] skip ${name}: source missing at ${src}`);
    continue;
  }
  let wasLink = false;
  try {
    wasLink = lstatSync(dest).isSymbolicLink();
  } catch {
    // destination absent (npm install never ran or link was removed)
  }
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  materialized++;
  console.log(`[materialize-workspace-deps] ${name} -> ${dest}${wasLink ? " (replaced symlink)" : ""}`);
}

console.log(`[materialize-workspace-deps] done (${materialized} package(s) materialized)`);
if (materialized === 0) {
  console.warn("[materialize-workspace-deps] no file: dependencies found; nothing to do");
}
