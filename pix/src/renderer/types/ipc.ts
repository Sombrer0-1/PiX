/**
 * IPC communication types for renderer.
 */

import type { PixApi } from "../../main/preload";

declare global {
  interface Window {
    pixApi: PixApi;
  }
}

export {};
