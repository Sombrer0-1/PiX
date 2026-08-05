/**
 * File Dialog Helpers
 *
 * v2: selectPiExecutable removed; direct AgentSession integration
 *     means no external pi binary to locate.
 */

import { BrowserWindow, dialog } from "electron";

/**
 * Open a native directory picker dialog.
 */
export async function selectProjectDirectory(parent: BrowserWindow): Promise<string | null> {
  console.log("[file-dialogs] selectProjectDirectory called, parent window valid:", !parent.isDestroyed());
  const result = await dialog.showOpenDialog(parent, {
    title: "选择项目目录",
    properties: ["openDirectory"],
  });
  console.log("[file-dialogs] dialog result:", { canceled: result.canceled, filePaths: result.filePaths });

  if (result.canceled || result.filePaths.length === 0) {
    console.log("[file-dialogs] dialog canceled or empty, returning null");
    return null;
  }

  console.log("[file-dialogs] returning path:", result.filePaths[0]);
  return result.filePaths[0];
}

/**
 * Open a native file picker for session JSONL files.
 */
export async function selectSessionFile(parent: BrowserWindow): Promise<string | null> {
  const result = await dialog.showOpenDialog(parent, {
    title: "选择会话文件",
    properties: ["openFile"],
    filters: [
      { name: "会话文件", extensions: ["jsonl"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
}

/**
 * Open a native multi-file picker for chat attachments.
 */
export async function selectChatFiles(parent: BrowserWindow): Promise<string[]> {
  const result = await dialog.showOpenDialog(parent, {
    title: "选择文件",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "所有文件", extensions: ["*"] },
    ],
  });

  if (result.canceled) {
    return [];
  }

  return result.filePaths;
}
