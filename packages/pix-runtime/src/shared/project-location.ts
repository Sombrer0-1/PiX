export type ProjectEnvironment =
  | { kind: "windows" }
  | { kind: "wsl"; distro: string };

export interface ProjectLocation {
  /** Logical (model-visible) path; equals physicalPath for Windows. */
  path: string;
  /** Host/bootstrap path; never displayed to the model. */
  physicalPath: string;
  name: string;
  environment: ProjectEnvironment;
}

export interface ProjectInfo extends ProjectLocation {
  lastOpened: number;
  sessionCount: number;
}

export interface ProjectLocationInput {
  environment: ProjectEnvironment;
  logicalPath?: string;
  physicalPath?: string;
  name?: string;
}

// ============================================================================
// WSL settings & distro metadata
// ============================================================================

export interface WslSettings {
  enabled: boolean;
  distro: string;
  defaultCwd: string;
}

export interface WslDistroInfo {
  name: string;
  state: string;
  version: number;
  isDefault: boolean;
}

export interface WslDistroListResult {
  distros: WslDistroInfo[];
  diagnostic?: string;
}

export type ResolveProjectLocationResult =
  | { success: true; location: ProjectLocation }
  | { success: false; error: string };

export type ExecutionEnvironmentInfo =
  | { kind: "windows"; logicalCwd: string }
  | { kind: "wsl"; distro: string; logicalCwd: string; ready: boolean; diagnostic?: string };

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
