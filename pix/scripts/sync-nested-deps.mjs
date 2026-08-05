// Ensure file: workspace packages resolve the EXACT dependency versions they
// were built against, by nesting those versions into each package's installed
// node_modules.
//
// Why this exists:
//   pix consumes @earendil-works/pi-* and pi-* packages as `file:` deps. npm
//   copies them into pix/node_modules WITHOUT their own node_modules, so their
//   `import`s resolve up to pix's top-level node_modules. When a build tool
//   (electron-builder, node-gyp, rimraf, ...) pulls an OLDER major of a shared
//   dependency (e.g. glob@7, chalk@4, hosted-git-info@4) to the top level, the
//   workspace package — which pins a newer major (glob@13, chalk@5, ...) —
//   silently resolves the wrong version at runtime and crashes in the packaged
//   app (ERR_PACKAGE_PATH_NOT_EXPORTED, "Named export not found", etc.).
//
//   npm `overrides` do NOT apply to dependencies of `file:`/`link:` local
//   packages, so this is fixed deterministically here: for every dependency
//   that resolves to a different version from the build context than it does
//   from the packaged context, copy the build-context version into the
//   packaged package's nested node_modules. Transitive mismatches are followed.
//
// Runs as part of `npm run build` (and therefore `npm run package`).

import { readFileSync, existsSync, rmSync, mkdirSync, cpSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const PIX_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PIX_MODULES = join(PIX_DIR, "node_modules");

/** Resolve a package's root directory from a given base, tolerating `exports`
 *  fields that block "./package.json". Returns { dir, version } or null. */
function resolvePackage(baseDir, name) {
  const req = createRequire(join(baseDir, "noop.js"));
  // Fast path: many packages expose ./package.json.
  try {
    const pj = req.resolve(`${name}/package.json`);
    return { dir: dirname(pj), version: JSON.parse(readFileSync(pj, "utf8")).version };
  } catch {
    // Fall back: resolve the entry point, then walk up to its package.json.
    let entry;
    try {
      entry = req.resolve(name);
    } catch {
      return null;
    }
    let dir = dirname(entry);
    const stop = dir.split(/[\\/]/).length;
    for (let i = 0; i < stop; i++) {
      const pj = join(dir, "package.json");
      if (existsSync(pj)) {
        try {
          const json = JSON.parse(readFileSync(pj, "utf8"));
          if (json.name === name) return { dir, version: json.version };
        } catch {
          // keep walking up
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }
}

function readPackageInfo(packageDir) {
  const packageJsonPath = join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) return null;

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (typeof packageJson.version !== "string") return null;
    return { dir: packageDir, version: packageJson.version };
  } catch {
    return null;
  }
}

function resolveBuildPackage(baseDir, name, localPackages) {
  const localPackage = localPackages.get(name);
  if (localPackage) {
    const packageInfo = readPackageInfo(localPackage.buildDir);
    if (packageInfo) return packageInfo;
  }
  return resolvePackage(baseDir, name);
}

function normalizePathForCompare(value) {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function readDeps(pkgDir) {
  try {
    const json = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    return Object.keys(json.dependencies || {});
  } catch {
    return [];
  }
}

/** For one installed workspace package, compute and copy the mismatch closure. */
function syncPackage(name, buildDir, installedDir, localPackages) {
  if (!existsSync(join(installedDir, "dist"))) return [];
  const nestedRoot = join(installedDir, "node_modules");

  // BFS over the dependency graph starting from the package's direct deps.
  // build context = buildDir (monorepo source, correct versions)
  // packaged context = installedDir (what the app resolves at runtime)
  const queued = new Set();
  const queue = [];
  for (const d of readDeps(buildDir)) {
    if (!queued.has(d)) { queued.add(d); queue.push({ name: d, buildBase: buildDir, pkgBase: installedDir }); }
  }

  const toNest = [];
  while (queue.length) {
    const { name: dep, buildBase, pkgBase } = queue.shift();
    const fromBuild = resolveBuildPackage(buildBase, dep, localPackages);
    if (!fromBuild) continue; // optional/absent dependency
    const fromPkg = resolvePackage(pkgBase, dep);

    const isLocalWorkspaceDependency = localPackages.has(dep);
    const resolvesDifferentLocalPackage =
      isLocalWorkspaceDependency &&
      fromPkg &&
      normalizePathForCompare(fromPkg.dir) !== normalizePathForCompare(fromBuild.dir);

    if (!fromPkg || fromPkg.version !== fromBuild.version || resolvesDifferentLocalPackage) {
      toNest.push({ name: dep, srcDir: fromBuild.dir, version: fromBuild.version });
      // After nesting, this dep's own deps resolve from the nested location,
      // walking up through nestedRoot. Follow them from the build version.
      for (const sub of readDeps(fromBuild.dir)) {
        if (!queued.has(sub)) { queued.add(sub); queue.push({ name: sub, buildBase: fromBuild.dir, pkgBase: nestedRoot }); }
      }
    }
  }

  for (const { name: dep, srcDir } of toNest) {
    const dest = join(nestedRoot, ...dep.split("/"));
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    // Copy the package without its own (possibly empty/hoisted) node_modules;
    // transitive deps are nested flat alongside and resolved by walk-up.
    cpSync(srcDir, dest, {
      recursive: true,
      filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src.slice(srcDir.length)),
    });
  }
  return toNest.map((t) => `${t.name}@${t.version}`);
}

// Discover file: workspace packages from pix/package.json and sync each.
const pixPkg = JSON.parse(readFileSync(join(PIX_DIR, "package.json"), "utf8"));
const fileDeps = Object.entries(pixPkg.dependencies || {})
  .filter(([, spec]) => typeof spec === "string" && spec.startsWith("file:"))
  .map(([name, spec]) => ({ name, buildDir: join(PIX_DIR, spec.slice("file:".length)) }));
const localPackages = new Map(fileDeps.map((dependency) => [dependency.name, dependency]));

let total = 0;
for (const { name, buildDir } of fileDeps) {
  const installedDir = join(PIX_MODULES, ...name.split("/"));
  if (!existsSync(installedDir) || !existsSync(buildDir)) continue;
  const nested = syncPackage(name, buildDir, installedDir, localPackages);
  if (nested.length) {
    total += nested.length;
    console.log(`[sync-nested-deps] ${name}: nested ${nested.join(", ")}`);
  }
}
console.log(total ? `[sync-nested-deps] done (${total} package(s) nested)` : "[sync-nested-deps] no mismatches");
