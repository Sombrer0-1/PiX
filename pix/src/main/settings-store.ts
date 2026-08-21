/**
 * GUI Settings Store
 *
 * Persistent storage for PiX GUI settings using electron-store.
 */

import Store from "electron-store";
import { existsSync, statSync } from "fs";
import type {
  GuiSettings,
  ProjectEnvironment,
  ProjectInfo,
} from "../shared/types.js";

const SCHEMA_VERSION = 4;
const DEFAULT_WSL_SETTINGS: NonNullable<GuiSettings["wsl"]> = {
  enabled: false,
  distro: "",
  defaultCwd: "/home",
};

const defaultSettings: GuiSettings = {
  theme: "light",
  recentProjects: [],
  defaultProvider: undefined,
  defaultModel: undefined,
  defaultThinkingLevel: "xhigh",
  takeHerEyes: { enabled: false },
  wsl: DEFAULT_WSL_SETTINGS,
  // schemaVersion is intentionally NOT in defaults so a missing/old store file
  // is detectable and migrated; migrate() writes it once.
};

export interface SettingsStoreOptions {
  /** Override the electron-store config directory (for tests). */
  cwd?: string;
}

/**
 * Migrate a single persisted recent-project entry to the schemaVersion=2 shape.
 *
 * Old entries (no physicalPath/environment) become Windows projects with
 * physicalPath = path. Entries that already carry a WSL environment keep their
 * logical path; malformed records are dropped.
 */
function migrateProjectInfo(entry: unknown): ProjectInfo | null {
  if (!entry || typeof entry !== "object") return null;
  const r = entry as Record<string, unknown>;
  if (
    typeof r.path !== "string" ||
    typeof r.name !== "string" ||
    typeof r.lastOpened !== "number" ||
    typeof r.sessionCount !== "number"
  ) {
    return null;
  }
  const physicalPath = typeof r.physicalPath === "string" ? r.physicalPath : r.path;

  let environment: ProjectEnvironment;
  const env = r.environment as { kind?: unknown; distro?: unknown } | undefined;
  if (env && env.kind === "wsl" && typeof env.distro === "string" && env.distro) {
    environment = { kind: "wsl", distro: env.distro };
  } else {
    environment = { kind: "windows" };
  }

  // For Windows, path === physicalPath (no separate logical namespace).
  const path = environment.kind === "windows" ? physicalPath : r.path;
  return { path, physicalPath, name: r.name, environment, lastOpened: r.lastOpened, sessionCount: r.sessionCount };
}

export class SettingsStore {
  private store: Store<GuiSettings>;

  constructor(options?: SettingsStoreOptions) {
    this.store = new Store<GuiSettings>({
      name: "pix-settings",
      defaults: defaultSettings,
      cwd: options?.cwd,
    });
    this.migrate();
  }

  /**
   * Per-version, idempotent migration to schemaVersion=4 (1.4.1). Steps run in
   * order so any older store is advanced one version at a time; a store already
   * at the current version is untouched. Migrations never write the optional
   * 1.4.1 field: an absent autoBackgroundMs means the consumer default
   * (DEFAULT_AUTO_BACKGROUND_MS = 0, off).
   *
   * 0/1 -> 2 (legacy):
   *   1. Old entries without physicalPath/environment become Windows projects
   *      (physicalPath = path, environment = windows, path = physicalPath).
   *   2. Missing wsl defaults are written.
   * 2 -> 3 (1.4.0):
   *   3. enableProductAnalytics defaults to false; planModel/planThinkingLevel
   *      stay absent (undefined = inherit).
   * 3 -> 4 (1.4.1):
   *   4. No field writes: autoBackgroundMs stays absent (undefined = consumer
   *      default 0 / off); the schemaVersion stamp below advances the version.
   * 5. schemaVersion is stamped to 4.
   */
  private migrate(): void {
    const version = this.store.get("schemaVersion");
    if (version === SCHEMA_VERSION) return;

    if (version === undefined || version < 2) {
      const rawProjects = this.store.get("recentProjects") ?? [];
      const migrated: ProjectInfo[] = [];
      for (const entry of rawProjects) {
        const info = migrateProjectInfo(entry);
        if (info) migrated.push(info);
      }
      this.store.set("recentProjects", migrated);

      if (!this.store.get("wsl")) {
        this.store.set("wsl", DEFAULT_WSL_SETTINGS);
      }
    }

    if (version === undefined || version < 3) {
      if (this.store.get("enableProductAnalytics") === undefined) {
        this.store.set("enableProductAnalytics", false);
      }
    }

    if (version === undefined || version < 4) {
      // 3 -> 4 (1.4.1): nothing to write. autoBackgroundMs is optional; when
      // absent, consumers fall back to DEFAULT_AUTO_BACKGROUND_MS (0 = off),
      // so the migration only advances the version via the stamp below.
    }

    this.store.set("schemaVersion", SCHEMA_VERSION);
  }

  getAll(): GuiSettings {
    this.pruneMissingRecentProjects();
    return this.store.store;
  }

  get<K extends keyof GuiSettings>(key: K): GuiSettings[K] {
    return this.store.get(key);
  }

  set<K extends keyof GuiSettings>(key: K, value: GuiSettings[K]): void {
    this.store.set(key, value);
  }

  setMany(settings: Partial<GuiSettings>): void {
    if (Object.hasOwn(settings, "piPath")) {
      this.store.set("piPath", settings.piPath);
    }
    if (Object.hasOwn(settings, "theme") && settings.theme !== undefined) {
      this.store.set("theme", settings.theme);
    }
    if (Object.hasOwn(settings, "recentProjects") && settings.recentProjects !== undefined) {
      this.store.set("recentProjects", settings.recentProjects);
    }
    if (Object.hasOwn(settings, "defaultProvider")) {
      if (settings.defaultProvider === undefined) {
        this.store.delete("defaultProvider");
      } else {
        this.store.set("defaultProvider", settings.defaultProvider);
      }
    }
    if (Object.hasOwn(settings, "defaultModel")) {
      if (settings.defaultModel === undefined) {
        this.store.delete("defaultModel");
      } else {
        this.store.set("defaultModel", settings.defaultModel);
      }
    }
    if (Object.hasOwn(settings, "defaultThinkingLevel")) {
      if (settings.defaultThinkingLevel === undefined) {
        this.store.delete("defaultThinkingLevel");
      } else {
        this.store.set("defaultThinkingLevel", settings.defaultThinkingLevel);
      }
    }
    if (Object.hasOwn(settings, "takeHerEyes")) {
      if (settings.takeHerEyes === undefined) {
        this.store.delete("takeHerEyes");
      } else {
        this.store.set("takeHerEyes", settings.takeHerEyes);
      }
    }
    if (Object.hasOwn(settings, "wsl")) {
      if (settings.wsl === undefined) {
        this.store.delete("wsl");
      } else {
        this.store.set("wsl", settings.wsl);
      }
    }
    if (Object.hasOwn(settings, "planModel")) {
      if (settings.planModel === undefined) {
        this.store.delete("planModel");
      } else {
        this.store.set("planModel", settings.planModel);
      }
    }
    if (Object.hasOwn(settings, "planThinkingLevel")) {
      if (settings.planThinkingLevel === undefined) {
        this.store.delete("planThinkingLevel");
      } else {
        this.store.set("planThinkingLevel", settings.planThinkingLevel);
      }
    }
    if (Object.hasOwn(settings, "enableProductAnalytics")) {
      if (settings.enableProductAnalytics === undefined) {
        this.store.delete("enableProductAnalytics");
      } else {
        this.store.set("enableProductAnalytics", settings.enableProductAnalytics);
      }
    }
    if (Object.hasOwn(settings, "autoBackgroundMs")) {
      if (settings.autoBackgroundMs === undefined) {
        this.store.delete("autoBackgroundMs");
      } else {
        this.store.set("autoBackgroundMs", settings.autoBackgroundMs);
      }
    }
  }

  addRecentProject(path: string, name: string): void {
    // String callers are Windows projects: physicalPath === path. WSL projects
    // are recorded with their full ProjectLocation by the session bridge (S7).
    const physicalPath = path;
    const projects = this.store.get("recentProjects") || [];
    const existing = projects.findIndex((p: ProjectInfo) => p.physicalPath === physicalPath);
    if (existing !== -1) {
      projects[existing] = {
        ...projects[existing],
        path: physicalPath,
        physicalPath,
        name,
        environment: { kind: "windows" },
        lastOpened: Date.now(),
      };
    } else {
      projects.unshift({
        path,
        physicalPath,
        name,
        environment: { kind: "windows" },
        lastOpened: Date.now(),
        sessionCount: 0,
      });
    }
    // Keep only 20 recent projects
    this.store.set("recentProjects", projects.slice(0, 20));
  }

  removeRecentProject(path: string): void {
    const projects = this.store.get("recentProjects") || [];
    // Match by either logical path or physicalPath so callers may pass either.
    this.store.set(
      "recentProjects",
      projects.filter((p: ProjectInfo) => p.path !== path && p.physicalPath !== path),
    );
  }

  private pruneMissingRecentProjects(): void {
    const projects = this.store.get("recentProjects") || [];
    const existingProjects = projects.filter((project: ProjectInfo) => this.projectPathExists(project));
    if (existingProjects.length !== projects.length) {
      this.store.set("recentProjects", existingProjects);
    }
  }

  /**
   * Check that a project's PHYSICAL directory still exists on the host. Uses
   * Windows fs on the physicalPath (drive or UNC) only; never on a Linux
   * logical path, which win32 fs cannot access.
   */
  private projectPathExists(project: ProjectInfo): boolean {
    try {
      return existsSync(project.physicalPath) && statSync(project.physicalPath).isDirectory();
    } catch {
      return false;
    }
  }
}
