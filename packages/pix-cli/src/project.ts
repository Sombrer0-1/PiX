import { basename, relative } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { parseWslUnc, resolveProjectLocation } from "@earendil-works/pix-runtime";
import type { ProjectLocation } from "@earendil-works/pix-runtime/shared";

const PROJECT_LOCATION_ENTRY = "pix-cli-project-location";

interface WslProject {
	distro: string;
	logicalPath: string;
}

function savedWslProject(manager: SessionManager): WslProject | undefined {
	for (const entry of manager.getEntries().reverse()) {
		if (entry.type !== "custom" || entry.customType !== PROJECT_LOCATION_ENTRY) continue;
		if (typeof entry.data !== "object" || entry.data === null) return undefined;
		const data = entry.data as Record<string, unknown>;
		if (
			typeof data.distro === "string" &&
			typeof data.logicalPath === "string" &&
			typeof data.physicalPath === "string" &&
			relative(data.physicalPath, manager.getCwd()) === ""
		) {
			return { distro: data.distro, logicalPath: data.logicalPath };
		}
		return undefined;
	}
	return undefined;
}

function resolveWslProject(project: WslProject): Promise<ProjectLocation> {
	return resolveProjectLocation({
		environment: { kind: "wsl", distro: project.distro },
		logicalPath: project.logicalPath,
	});
}

export class CliProjects {
	private readonly startupProject?: WslProject;
	private startupLocation?: ProjectLocation;

	constructor(startupProject?: WslProject) {
		this.startupProject = startupProject;
	}

	async resolveStartupCwd(cwd: string): Promise<string> {
		if (!this.startupProject) return cwd;
		if (process.platform !== "win32") throw new Error("WSL2 projects require a Windows host.");
		this.startupLocation = await resolveWslProject(this.startupProject);
		return this.startupLocation.physicalPath;
	}

	markNewProject(manager: SessionManager, parent?: SessionManager): void {
		const physicalPath = manager.getCwd();
		const project = parent ? savedWslProject(parent) : undefined;
		if (project && !savedWslProject(manager))
			manager.appendCustomEntry(PROJECT_LOCATION_ENTRY, { ...project, physicalPath });
	}

	async resolveSessionProject(manager: SessionManager): Promise<ProjectLocation> {
		const physicalPath = manager.getCwd();
		const initialProject = this.startupLocation;
		this.startupLocation = undefined;
		const saved = savedWslProject(manager);
		if (saved) {
			const project = await resolveWslProject(saved);
			if (relative(project.physicalPath, physicalPath) !== "") {
				throw new Error(`WSL2 project path ${saved.logicalPath} now maps to ${project.physicalPath}.`);
			}
			return project;
		}
		if (initialProject?.environment.kind === "wsl" && relative(initialProject.physicalPath, physicalPath) === "") {
			manager.appendCustomEntry(PROJECT_LOCATION_ENTRY, {
				distro: initialProject.environment.distro,
				logicalPath: initialProject.path,
				physicalPath,
			});
			return initialProject;
		}
		const unc = parseWslUnc(physicalPath);
		if (unc) {
			return resolveWslProject({ distro: unc.distro, logicalPath: unc.rest.replaceAll("\\", "/") || "/" });
		}
		return { environment: { kind: "windows" }, path: physicalPath, physicalPath, name: basename(physicalPath) };
	}
}
