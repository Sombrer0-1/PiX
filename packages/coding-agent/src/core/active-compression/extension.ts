import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionFactory } from "../extensions/types.ts";
import type { SessionManager } from "../session-manager.ts";
import { AcpRuntime } from "./runtime.ts";
import { createAcpTools } from "./tools.ts";

export function createActiveCompressionExtension(getSessionManager: () => SessionManager): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		if (getSessionManager().getAcp() !== true) return;
		const runtime = new AcpRuntime(getSessionManager());
		for (const tool of createAcpTools(runtime)) {
			pi.registerTool(tool);
		}
		pi.on("context", async (event, ctx) => {
			return runtime.processContext(event.messages as AgentMessage[], ctx);
		});
		pi.on("session_before_compact", () => ({ cancel: true }));
		pi.on("session_start", () => {
			runtime.load();
		});
		pi.on("session_shutdown", () => {
			runtime.flush();
		});
	};
}
