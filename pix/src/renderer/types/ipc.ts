/**
 * IPC communication types for renderer.
 */

import type { PixApi } from "../../main/preload";

export type {
  ExecutionEnvironmentInfo,
  ProjectLocation,
  ProjectLocationInput,
  ResolveProjectLocationResult,
  SessionInfo,
  WslDistroInfo,
  WslDistroListResult,
} from "../../shared/types";

declare global {
  interface Window {
    pixApi: PixApi;
  }
}

export {};
