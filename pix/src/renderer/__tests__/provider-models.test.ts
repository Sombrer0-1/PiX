/**
 * Provider /models 候选合并逻辑测试（CustomProviders「从 API 获取模型」的纯函数部分）。
 *
 * 覆盖 toCandidateRows（已存在标注、预勾选策略：已配置不勾、未配置全勾）与
 * mergeFetchedModels（已存在行不被覆盖、勾选且未配置的按端点顺序追加、重复 id
 * 只落一行、空 id 行不参与去重键、返回新增计数）。
 */

import { describe, expect, it } from "vitest";
import { mergeFetchedModels, toCandidateRows, type ModelCandidateRow } from "../utils/provider-models";
import type { FetchedProviderModel } from "@shared/custom-providers";

interface DraftRow {
	id: string;
	name?: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
}

/** 与 CustomProviders.confirmImportModels 相同的新行默认值。 */
function toRow(candidate: ModelCandidateRow): DraftRow {
	return {
		id: candidate.id,
		name: candidate.name,
		reasoning: false,
		input: ["text"],
		contextWindow: candidate.contextWindow,
		maxTokens: candidate.maxTokens,
	};
}

function listing(...models: FetchedProviderModel[]): FetchedProviderModel[] {
	return models;
}

describe("toCandidateRows", () => {
	it("marks configured ids as existing and unchecked, others pre-picked", () => {
		const rows = toCandidateRows(
			listing({ id: "a" }, { id: "b" }, { id: "c", name: "Cee" }),
			["a", "c"],
		);
		expect(rows.map((r) => [r.id, r.exists, r.picked])).toEqual([
			["a", true, false],
			["b", false, true],
			["c", true, false],
		]);
	});

	it("keeps fetched metadata (name / contextWindow / maxTokens)", () => {
		const rows = toCandidateRows(listing({ id: "m", name: "M", contextWindow: 128000, maxTokens: 8192 }), []);
		expect(rows[0]).toMatchObject({ id: "m", name: "M", contextWindow: 128000, maxTokens: 8192, exists: false, picked: true });
	});
});

describe("mergeFetchedModels", () => {
	it("appends picked new candidates in listing order", () => {
		const rows: DraftRow[] = [{ id: "a", reasoning: true, input: ["text"], contextWindow: 1 }];
		const candidates = toCandidateRows(listing({ id: "b" }, { id: "c" }), ["a"]);
		const added = mergeFetchedModels(rows, candidates, toRow);
		expect(added).toBe(2);
		expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
		expect(rows[1]).toMatchObject({ reasoning: false, input: ["text"] });
	});

	it("never touches existing rows even when a duplicate candidate is somehow picked", () => {
		const existing: DraftRow = { id: "a", reasoning: true, input: ["image"], contextWindow: 7, maxTokens: 3 };
		const rows: DraftRow[] = [{ ...existing }];
		const candidates = toCandidateRows(listing({ id: "a", contextWindow: 999999 }), ["a"]);
		// 模拟极端情况：已存在行仍被勾选（防御）。
		const forced: ModelCandidateRow[] = candidates.map((c) => ({ ...c, picked: true }));
		const added = mergeFetchedModels(rows, forced, toRow);
		expect(added).toBe(0);
		expect(rows.length).toBe(1);
		expect(rows[0]).toEqual(existing);
	});

	it("skips unpicked candidates", () => {
		const rows: DraftRow[] = [];
		const candidates = toCandidateRows(listing({ id: "a" }, { id: "b" }), []);
		candidates[0]!.picked = false;
		const added = mergeFetchedModels(rows, candidates, toRow);
		expect(added).toBe(1);
		expect(rows.map((r) => r.id)).toEqual(["b"]);
	});

	it("dedupes duplicate picked ids within one listing", () => {
		const rows: DraftRow[] = [];
		const candidates: ModelCandidateRow[] = [
			{ id: "dup", exists: false, picked: true },
			{ id: "dup", exists: false, picked: true },
		];
		const added = mergeFetchedModels(rows, candidates, toRow);
		expect(added).toBe(1);
		expect(rows.map((r) => r.id)).toEqual(["dup"]);
	});

	it("does not treat an empty-id draft row as a collision (it is not yet a model)", () => {
		const rows: DraftRow[] = [{ id: "", reasoning: false, input: ["text"] }];
		const candidates = toCandidateRows(listing({ id: "a" }), []);
		const added = mergeFetchedModels(rows, candidates, toRow);
		expect(added).toBe(1);
		expect(rows.map((r) => r.id)).toEqual(["", "a"]);
	});
});

describe("toCandidateRows dedup", () => {
	it("keeps only the first occurrence of a duplicate id (v-for :key guarantee)", () => {
		const rows = toCandidateRows(listing({ id: "dup", name: "first" }, { id: "dup", name: "second" }, { id: "ok" }), []);
		expect(rows.map((r) => r.id)).toEqual(["dup", "ok"]);
		expect(rows[0]?.name).toBe("first");
	});
});
