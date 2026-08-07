/**
 * Shared project location & execution environment types.
 *
 * Canonical, serializable types describing where a PiX project runs. Shared by
 * the renderer, preload and main processes per wsl_plan.md §4.3.
 *
 * `ProjectLocation.path` is ALWAYS the logical (model-visible) path: for
 * Windows it equals `physicalPath`; for WSL it is the POSIX path inside the
 * distro. `physicalPath` is the host/bootstrap path and is never shown to the
 * model.
 *
 * This module is a leaf: it has no runtime imports. `ThinkingLevel`,
 * `TakeHerEyesSettings` and `GuiSettings` are co-located here (and re-exported
 * by types.ts) so that `GuiSettings` can reference them without a circular
 * dependency. Their field shapes are preserved exactly as they were in types.ts
 * (e.g. `takeHerEyes` remains the `TakeHerEyesSettings` object, not the bare
 * `boolean` sketched in the plan's prose), because out-of-scope callers
 * (SettingsPage.vue, session-bridge.ts) read `takeHerEyes.provider` /
 * `takeHerEyes.modelId` and assign `defaultThinkingLevel` to a `ThinkingLevel`
 * ref. The §4.3 additions (`schemaVersion`, `wsl`) are the only GuiSettings
 * shape changes.
 */

// ============================================================================
// Project environment & location
// ============================================================================

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

// ============================================================================
// Thinking & take-her-eyes settings (co-located for GuiSettings)
// ============================================================================

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface TakeHerEyesSettings {
  enabled: boolean;
  provider?: string;
  modelId?: string;
}

// ============================================================================
// GUI settings
// ============================================================================

export interface GuiSettings {
  /** @deprecated No longer needed with direct AgentSession integration */
  piPath?: string;
  theme: string;
  recentProjects: ProjectInfo[];
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  takeHerEyes?: TakeHerEyesSettings;
  /** Settings schema version; migrated to 2 on first load. */
  schemaVersion?: number;
  /** Global WSL defaults; only seed new-project dialog defaults. */
  wsl?: WslSettings;
}
