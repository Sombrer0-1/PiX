/**
 * GUI Settings Store
 *
 * Persistent storage for PiX GUI settings using electron-store.
 */

import Store from "electron-store";
import { existsSync, statSync } from "fs";
import type { GuiSettings, ProjectInfo } from "../shared/types.js";

const defaultSettings: GuiSettings = {
  theme: "light",
  recentProjects: [],
  defaultProvider: undefined,
  defaultModel: undefined,
  defaultThinkingLevel: "xhigh",
};

export class SettingsStore {
  private store: Store<GuiSettings>;

  constructor() {
    this.store = new Store<GuiSettings>({
      name: "pix-settings",
      defaults: defaultSettings,
    });
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
  }

  addRecentProject(path: string, name: string): void {
    const projects = this.store.get("recentProjects") || [];
    const existing = projects.findIndex((p: ProjectInfo) => p.path === path);
    if (existing !== -1) {
      projects[existing] = {
        ...projects[existing],
        lastOpened: Date.now(),
        name,
      };
    } else {
      projects.unshift({
        path,
        name,
        lastOpened: Date.now(),
        sessionCount: 0,
      });
    }
    // Keep only 20 recent projects
    this.store.set("recentProjects", projects.slice(0, 20));
  }

  removeRecentProject(path: string): void {
    const projects = this.store.get("recentProjects") || [];
    this.store.set(
      "recentProjects",
      projects.filter((p: ProjectInfo) => p.path !== path)
    );
  }

  private pruneMissingRecentProjects(): void {
    const projects = this.store.get("recentProjects") || [];
    const existingProjects = projects.filter((project: ProjectInfo) => this.projectPathExists(project.path));
    if (existingProjects.length !== projects.length) {
      this.store.set("recentProjects", existingProjects);
    }
  }

  private projectPathExists(path: string): boolean {
    try {
      return existsSync(path) && statSync(path).isDirectory();
    } catch {
      return false;
    }
  }
}
