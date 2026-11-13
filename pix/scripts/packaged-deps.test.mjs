import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const pixPackage = JSON.parse(readFileSync(join(scriptsDir, "../package.json"), "utf8"));
const preparation = pixPackage.scripts.package
  .split(" && ")
  .filter((command) => /^node scripts\/(materialize-workspace-deps|sync-nested-deps)\.mjs$/.test(command));
assert.equal(preparation.length, 2);

function writePackage(directory, manifest, files = {}) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    writeFileSync(join(directory, name), contents);
  }
}

for (const layout of ["npm junction", "previously materialized package"]) {
  test(`packaging preserves ESM dependency versions from ${layout}`, () => {
    const root = mkdtempSync(join(tmpdir(), "pix-packaged-deps-"));
    const pix = join(root, "pix");
    const workspace = join(root, "packages/runtime");
    const installed = join(pix, "node_modules/test-workspace");
    try {
      writePackage(pix, {
        dependencies: {
          "test-workspace": "file:../packages/runtime",
          "pi-mcp-adapter": "file:../packages/mcp-adapter",
        },
      });
      writePackage(workspace, {
        name: "test-workspace", version: "1.0.0", type: "module",
        dependencies: { glob: "13.0.6", "pi-mcp-adapter": "1.0.0", "@earendil-works/pi-tui": "1.0.0" },
      }, { "dist/index.mjs": 'import { globSync } from "glob"; import "pi-mcp-adapter"; import "@earendil-works/pi-tui"; console.log(globSync());' });
      writePackage(join(root, "packages/mcp-adapter"), {
        name: "pi-mcp-adapter", version: "1.0.0", type: "module", exports: "./dist/index.js",
      }, { "dist/index.js": "export {}" });
      writePackage(join(workspace, "node_modules/pi-mcp-adapter"), {
        name: "pi-mcp-adapter", version: "1.0.0", type: "module", exports: "./dist/index.js",
      }, { "dist/index.js": 'throw new Error("stale nested adapter")' });
      const tui = join(root, "packages/tui");
      writePackage(tui, {
        name: "@earendil-works/pi-tui", version: "1.0.0", type: "module", exports: "./dist/index.js",
      }, { "dist/index.js": "export {}" });
      const rootScope = join(root, "node_modules/@earendil-works");
      mkdirSync(rootScope, { recursive: true });
      symlinkSync(tui, join(rootScope, "pi-tui"), "junction");
      writePackage(join(root, "node_modules/glob"), {
        name: "glob", version: "13.0.6", type: "module", exports: "./index.js",
        dependencies: { "test-transitive": "2.0.0" },
      }, { "index.js": 'import { value } from "test-transitive"; export function globSync() { return value; }' });
      writePackage(join(root, "node_modules/test-transitive"), {
        name: "test-transitive", version: "2.0.0", type: "module", exports: "./index.js",
      }, { "index.js": 'export const value = "correct ESM dependency";' });
      writePackage(join(pix, "node_modules/glob"), {
        name: "glob", version: "7.2.3", main: "index.js",
      }, { "index.js": "module.exports = function glob() {};" });
      writePackage(join(pix, "node_modules/test-transitive"), {
        name: "test-transitive", version: "1.0.0", main: "index.js",
      }, { "index.js": 'module.exports = "wrong transitive dependency";' });
      if (layout === "npm junction") symlinkSync(workspace, installed, "junction");
      else cpSync(workspace, installed, { recursive: true });
      mkdirSync(join(pix, "scripts"));
      for (const file of ["materialize-workspace-deps.mjs", "sync-nested-deps.mjs"]) {
        cpSync(join(scriptsDir, file), join(pix, "scripts", file));
      }
      for (const command of preparation) {
        const result = spawnSync(process.execPath, [command.slice("node ".length)], { cwd: pix, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      }
      const result = spawnSync(process.execPath, [join(installed, "dist/index.mjs")], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "correct ESM dependency");
      assert.equal(JSON.parse(readFileSync(join(installed, "node_modules/glob/package.json"), "utf8")).version, "13.0.6");
      assert.equal(readFileSync(join(pix, "node_modules/@earendil-works/pi-tui/dist/index.js"), "utf8"), "export {}");
      assert.throws(() => readFileSync(join(installed, "node_modules/pi-mcp-adapter/package.json")), { code: "ENOENT" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
