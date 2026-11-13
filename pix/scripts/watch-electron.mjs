import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { createRequire } from "node:module";

const electron = createRequire(import.meta.url)("electron");
const cwd = new URL("../", import.meta.url);
const watchers = [
  new URL("../dist/main/", import.meta.url),
  new URL("../../packages/pix-runtime/dist/", import.meta.url),
].map((path) => watch(path, { recursive: true }, scheduleRestart));

let child = startElectron();
let restart;
let stopping = false;

function startElectron() {
  const app = spawn(electron, ["."], {
    cwd,
    env: { ...process.env, VITE_DEV_SERVER_URL: "http://localhost:5173" },
    stdio: "inherit",
  });
  app.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
    stop();
  });
  return app;
}

function scheduleRestart(_event, file) {
  if (stopping || !file?.endsWith(".js") && !file?.endsWith(".cjs")) return;
  clearTimeout(restart);
  restart = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.once("exit", () => {
        if (!stopping) child = startElectron();
      });
      child.kill();
    } else {
      child = startElectron();
    }
  }, 150);
}

function stop() {
  stopping = true;
  clearTimeout(restart);
  for (const watcher of watchers) watcher.close();
  child.kill();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
