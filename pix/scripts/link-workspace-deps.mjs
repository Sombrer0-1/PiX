import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pixDir = fileURLToPath(new URL("../", import.meta.url));
const modulesDir = join(pixDir, "node_modules");
const manifest = JSON.parse(readFileSync(join(pixDir, "package.json"), "utf8"));

for (const [name, dependency] of Object.entries(manifest.dependencies)) {
  if (!dependency.startsWith("file:")) continue;
  const source = realpathSync(resolve(pixDir, dependency.slice("file:".length)));
  const target = join(modulesDir, name);
  const installed = lstatSync(target, { throwIfNoEntry: false });
  if (installed?.isSymbolicLink() && realpathSync(target) === source) continue;
  if (installed) rmSync(target, { recursive: true });
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(source, target, "junction");
}
