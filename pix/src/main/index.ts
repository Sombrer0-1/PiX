/**
 * Electron Main Process Entry Point
 *
 * v2: Uses SessionBridge for direct AgentSession integration.
 * No more subprocess spawning; the coding agent runs in-process.
 */

import { BrowserWindow, Menu, app, shell } from "electron";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { registerIpcHandlers, setupEventForwarding } from "./ipc-handlers.js";
import { SessionBridge } from "./session-bridge.js";
import { SettingsStore } from "./settings-store.js";

// ESM doesn't have __dirname; derive it from import.meta.url.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;
/** Mutable ref that always points to the current active window (survives close/reopen). */
let activeWin: BrowserWindow | null = null;
let sessionBridge: SessionBridge | null = null;
let settingsStore: SettingsStore;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: "PiX",
    backgroundColor: "#f0f0f0",
    frame: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Load app
  if (process.env.NODE_ENV === "development" || process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || "http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    // __dirname is dist/main/main, renderer build is at dist/renderer/
    mainWindow.loadFile(join(__dirname, "..", "..", "renderer", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function cleanup(): void {
  if (sessionBridge) {
    try {
      sessionBridge.dispose();
    } catch (err) {
      console.error("[main] Error during session bridge cleanup:", err);
    }
  }
}

app.whenReady().then(() => {
  // Remove default Electron menu bar (File, Edit, View, Window, Help)
  Menu.setApplicationMenu(null);

  console.log("[main] app.whenReady() callback executing");

  try {
    settingsStore = new SettingsStore();
    console.log("[main] SettingsStore created");
  } catch (err) {
    console.error("[main] SettingsStore FAILED:", err);
    throw err;
  }

  try {
    sessionBridge = new SessionBridge();
    console.log("[main] SessionBridge created");
  } catch (err) {
    console.error("[main] SessionBridge FAILED:", err);
    throw err;
  }

  createWindow();
  activeWin = mainWindow;
  console.log("[main] Window created, activeWin:", !!activeWin);

  if (activeWin) {
    console.log("[main] registering IPC handlers...");
    registerIpcHandlers(activeWin, sessionBridge, settingsStore);
    setupEventForwarding(() => activeWin, sessionBridge);
    console.log("[main] IPC handlers registered");
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      activeWin = mainWindow;
      if (activeWin && sessionBridge) {
        // Re-register IPC handlers for the new window (handler guard prevents duplicates)
        registerIpcHandlers(activeWin, sessionBridge, settingsStore);
        // Event forwarding is already set up with a getter; updating activeWin is enough.
      }
    }
  });
});

let quitting = false;

app.on("window-all-closed", () => {
  // On macOS, the app stays alive in the Dock; keep the session alive
  // so event forwarding works when the user reopens a window via activate.
  // On other platforms, quit when all windows close.
  if (process.platform !== "darwin") {
    quitting = true;
    cleanup();
    app.quit();
  }
});

app.on("before-quit", async (event) => {
  if (!quitting) {
    event.preventDefault();
    quitting = true;
    await cleanup();
    app.quit();
  }
});
