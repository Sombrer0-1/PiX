// Stop a previously packaged PiX still running from release/win-unpacked.
// electron-builder empties that directory before unpacking Electron; a live
// PiX.exe holds DLLs open and the pack fails with "Access is denied".
//
// Only processes whose ExecutablePath is under win-unpacked are stopped.
// An installed copy (Program Files, etc.) is left alone.
//
// Runs as part of `npm run package` (and therefore package-with-proxy.bat),
// immediately before electron-builder.

import { existsSync } from "fs";
import { spawnSync } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const PIX_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const UNPACKED = resolve(PIX_DIR, "release", "win-unpacked");

function listUnpackedPids() {
  if (process.platform !== "win32") {
    return [];
  }
  const ps = `
    $root = ${JSON.stringify(UNPACKED)}
    Get-Process |
      Where-Object {
        $_.Path -and
        $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
      } |
      Select-Object -ExpandProperty Id
  `;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const err = (result.stderr ?? "").trim();
    if (err !== "") {
      console.warn("[stop-unpacked-app] pid listing failed:", err);
    }
    return [];
  }
  return (result.stdout ?? "")
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function sleepMs(ms) {
  spawnSync("powershell.exe", ["-NoProfile", "-Command", `Start-Sleep -Milliseconds ${ms}`], {
    windowsHide: true,
  });
}

const pids = listUnpackedPids();
if (pids.length === 0) {
  if (existsSync(UNPACKED)) {
    console.log("[stop-unpacked-app] no running process from win-unpacked");
  } else {
    console.log("[stop-unpacked-app] no win-unpacked directory");
  }
  process.exit(0);
}

console.log(`[stop-unpacked-app] stopping ${pids.length} process(es) from win-unpacked: ${pids.join(", ")}`);
const kill = spawnSync("taskkill", ["/F", ...pids.flatMap((pid) => ["/PID", String(pid)])], {
  encoding: "utf8",
  windowsHide: true,
});
if (kill.status !== 0) {
  const err = (kill.stderr ?? kill.stdout ?? "").trim();
  console.error("[stop-unpacked-app] taskkill failed:", err !== "" ? err : `exit ${kill.status}`);
  process.exit(1);
}

for (let attempt = 0; attempt < 10; attempt++) {
  sleepMs(300);
  if (listUnpackedPids().length === 0) {
    console.log("[stop-unpacked-app] win-unpacked processes stopped");
    process.exit(0);
  }
}

console.error("[stop-unpacked-app] processes still running after taskkill; close PiX and retry");
process.exit(1);
