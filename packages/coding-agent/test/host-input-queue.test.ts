import { expect, it } from "vitest";
import type { RequestUserInputResponse } from "../src/core/request-user-input-tool.ts";
import { queueHostInput } from "../src/modes/host-input-queue.ts";

it("presents input requests in order and cancels a queued request independently", async () => {
	const shown: string[] = [];
	const first = Promise.withResolvers<RequestUserInputResponse>();
	const requestInput = queueHostInput(async ({ id }) => {
		shown.push(id);
		return id === "first" ? first.promise : { id, answers: { answer: id } };
	});
	const controller = new AbortController();
	const current = requestInput({ id: "first", questions: [] });
	const cancelled = requestInput({ id: "second", questions: [] }, controller.signal);
	const next = requestInput({ id: "third", questions: [] });

	controller.abort();
	await expect(cancelled).resolves.toEqual({ id: "second", answers: {}, cancelled: true });
	expect(shown).toEqual(["first"]);
	first.resolve({ id: "first", answers: { answer: "first" } });
	await expect(current).resolves.toEqual({ id: "first", answers: { answer: "first" } });
	await expect(next).resolves.toEqual({ id: "third", answers: { answer: "third" } });
	expect(shown).toEqual(["first", "third"]);
});
