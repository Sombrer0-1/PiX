/**
 * Computer-use session extension.
 *
 * Wires one ComputerUseSessionController into an AgentSession through the
 * extension API:
 *  - `session_start` (startup / reload / new / resume / fork) and `session_tree`
 *    (branch navigation) re-read the toggle entry and reconcile the active
 *    tool set, so the session toggle always matches the current branch;
 *  - `before_agent_start` (every prompt) does the same plus `onUserTurnStart`
 *    (clears halted / deniedThisRun for the new user turn). It must return
 *    `undefined`: returning `systemPrompt` would override the base prompt that
 *    `setActiveToolsByName` just rebuilt (agent-session.ts:1926-1955), and
 *    returning `message` would inject a synthetic message on every turn;
 *  - `context` replaces older computer-use screenshots with text placeholders
 *    via the pure `applyScreenshotRetention`. Handlers are chained in
 *    registration order (runner.ts:864), which is why the factory must be
 *    appended to `extensionFactories` after `createActiveCompressionExtension`.
 *
 * Scope note: `before_agent_start` only fires on the `prompt()` path;
 * the `agent.continue()` paths (auto retry, post-compaction continuation, queue
 * continuation) and in-flight steer/followUp do not fire it and reuse the last
 * reconciliation. Safety on those paths rests on the controller's execute
 * guards plus the core read-only / plan policies; visibility converges on the
 * next prompt. Disabling (session toggle, global switch, backgrounding, halt)
 * also reconciles immediately from the controller itself.
 *
 * Coupling: talks only to the controller's public interface and the pure
 * context-budget helper - never to the service, backend or driver client.
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { applyScreenshotRetention } from "./context-budget.js";
import type { ScreenshotRetentionPolicy } from "./contracts.js";
import type { ComputerUseSessionController } from "./session-controller.js";

export function createComputerUseExtension(
	controller: ComputerUseSessionController,
	getPolicy: () => ScreenshotRetentionPolicy,
): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const reconcile = (): void => {
			controller.hydrate();
			controller.reconcileTools();
		};

		pi.on("session_start", reconcile);
		pi.on("session_tree", reconcile);
		pi.on("before_agent_start", () => {
			controller.hydrate();
			controller.onUserTurnStart();
			controller.reconcileTools();
			// Never return systemPrompt/message from this hook (see the header note).
			return undefined;
		});
		pi.on("context", (event) => ({ messages: applyScreenshotRetention(event.messages, getPolicy()) }));
	};
}
