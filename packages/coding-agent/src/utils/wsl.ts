import { readFileSync } from "node:fs";

export function isWSL(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.WSL_DISTRO_NAME || env.WSLENV || env.WSL_INTEROP) {
		return true;
	}

	try {
		return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf-8"));
	} catch {
		return false;
	}
}
