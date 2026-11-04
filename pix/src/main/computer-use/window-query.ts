import type { DriverToolResult } from "./contracts.js";

/** The driver budgets its walk before query projection. PiX budgets matching output. */
export function limitWindowQuery(result: DriverToolResult, query: string, limit: number): DriverToolResult {
	const structured = result.structuredContent;
	if (!Array.isArray(structured?.elements)) return result;
	const needle = query.toLowerCase();
	const matches = structured.elements.filter((entry: unknown): entry is Record<string, unknown> => {
		if (typeof entry !== "object" || entry === null) return false;
		const element = entry as Record<string, unknown>;
		return ["label", "role", "value", "identifier", "description"].some((key) => typeof element[key] === "string" && element[key].toLowerCase().includes(needle));
	});
	const elements = matches.slice(0, Math.max(1, limit));
	const truncated = structured.truncated === true || matches.length > elements.length;
	const summary = `Window ${String(structured.window_id ?? "")}: query=${JSON.stringify(query)}, returned ${elements.length}/${matches.length} matching elements${truncated ? " (truncated)" : ""}.`;
	return {
		...result,
		content: [{ type: "text", text: [summary, ...elements.map((element) => JSON.stringify(element))].join("\n") }, ...result.content.filter((item) => item.type === "image")],
		structuredContent: {
			...structured, elements, tree_markdown: elements.map((element) => JSON.stringify(element)).join("\n"),
			returned_element_count: elements.length, filtered_element_count: matches.length,
			elements_complete: !truncated && structured.elements_complete !== false,
			truncated, truncation_reason: matches.length > elements.length ? "matching_element_limit" : structured.truncation_reason,
		},
	};
}
