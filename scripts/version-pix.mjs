import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const files = ["pix", "packages/pix-runtime", "packages/pix-cli"].map((path) => new URL(`${path}/package.json`, root));
const [desktop, runtime, cli] = files.map((file) => JSON.parse(readFileSync(file, "utf8")));
const [arg, ...extra] = process.argv.slice(2);

function check() {
  if (runtime.version !== desktop.version || cli.version !== desktop.version ||
      cli.dependencies[runtime.name] !== desktop.version ||
      desktop.dependencies[runtime.name] !== "file:../packages/pix-runtime") {
    throw new Error(`PiX versions disagree (desktop ${desktop.version}, runtime ${runtime.version}, CLI ${cli.version}, CLI runtime dependency ${cli.dependencies[runtime.name]}, desktop runtime dependency ${desktop.dependencies[runtime.name]}).`);
  }
}

if (arg === "--check" && extra.length === 0) {
  check();
} else {
  const number = "(?:0|[1-9]\\d*)";
  const prerelease = `(?:${number}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
  const semver = new RegExp(`^${number}\\.${number}\\.${number}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
  if (extra.length || !arg || !semver.test(arg)) {
    throw new Error("Usage: npm run version:pix -- <version|--check>");
  }
  for (const manifest of [desktop, runtime, cli]) manifest.version = arg;
  cli.dependencies[runtime.name] = arg;
  check();
  for (const [index, manifest] of [desktop, runtime, cli].entries()) {
    const indent = index === 0 ? 2 : "\t";
    writeFileSync(files[index], `${JSON.stringify(manifest, null, indent)}\n`);
  }
  for (const cwd of [root, new URL("pix/", root)]) {
    execFileSync(process.execPath, [process.env.npm_execpath, "install", "--package-lock-only", "--ignore-scripts"], {
      cwd: fileURLToPath(cwd),
      stdio: "inherit",
    });
  }
}
