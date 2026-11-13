import type { RequestUserInputHandler } from "../core/request-user-input-tool.ts";

/** Present one host input request at a time and let queued requests abort independently. */
export function queueHostInput(present: RequestUserInputHandler): RequestUserInputHandler {
	let tail = Promise.resolve();
	return (request, signal) => {
		const cancelled = { id: request.id, answers: {}, cancelled: true };
		if (signal?.aborted) return Promise.resolve(cancelled);
		const next = tail.then(() => (signal?.aborted ? cancelled : present(request, signal)));
		tail = next.then(
			() => undefined,
			() => undefined,
		);
		return new Promise((resolve, reject) => {
			const onAbort = () => resolve(cancelled);
			signal?.addEventListener("abort", onAbort, { once: true });
			void next.then(resolve, reject).finally(() => signal?.removeEventListener("abort", onAbort));
		});
	};
}
