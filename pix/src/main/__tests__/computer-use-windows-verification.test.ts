import assert from "node:assert/strict";
import { ComputerUseError, type BackendVerifyResult } from "../computer-use/contracts.js";
import {
	evaluateWindowsVerification,
	mergeWindowsVerification,
	verifyNativeWindowsElements,
	type WindowsVerificationElement,
	type WindowsVerificationSnapshot,
} from "../computer-use/windows-verification.js";

const target = { pid: 42, window_id: 7 };
const editor: WindowsVerificationElement = {
	role: "Document", label: "Text editor", runtime_id: "42,7,3", process_id: 42,
	framework_id: "Win32", class_name: "RichEditD2DPT",
	web_ancestor: false, value: "hello", enabled: true,
};
const snapshot: WindowsVerificationSnapshot = { ...target, complete: true, elements: [editor] };
const expected = [{ element: { selector: { role: "Document", label_contains: "Text editor" }, exists: true, value_equals: "hello", enabled: true } }];

const native = evaluateWindowsVerification(target, expected, snapshot);
assert.equal(native[0].status, "satisfied", "native RichEdit Document is verified from independent UIA evidence");
assert.match(native[0].observed ?? "", /windows_uia/);
assert.match(native[0].observed ?? "", /42,7,3/);

assert.equal(evaluateWindowsVerification(target, [{ element: { selector: { role: "Document" } } }], snapshot)[0].status, "satisfied", "a selector alone retains the driver's existence semantics");
assert.equal(evaluateWindowsVerification(target, [{ element: { selector: { label_contains: "editor" }, value_equals: "wrong" } }], snapshot)[0].status, "unsatisfied", "a readable mismatched value is negative evidence");
assert.equal(evaluateWindowsVerification(target, [{ element: { selector: { label_contains: "editor" }, selected: true } }], snapshot)[0].unknownReason, "unsupported_predicate", "a missing selection property remains unknown");
assert.equal(evaluateWindowsVerification(target, expected, { ...snapshot, complete: false })[0].unknownReason, "observation_unavailable", "partial walks cannot establish a unique property target");
assert.equal(evaluateWindowsVerification(target, expected, { ...snapshot, pid: 99 })[0].unknownReason, "target_missing", "the requested window owner must match");
assert.equal(evaluateWindowsVerification(target, expected, { ...snapshot, elements: [editor, { ...editor, runtime_id: "42,7,4" }] })[0].unknownReason, "multi_match", "ambiguous value selectors are never first-match wins");
assert.equal(evaluateWindowsVerification(target, [{ element: { selector: { label_contains: "absent" }, exists: true } }], snapshot)[0].status, "unknown", "missing controls retain conservative absence semantics");

const truncatedValue = evaluateWindowsVerification(target, expected, { ...snapshot, elements: [{ ...editor, value: "hello", value_truncated: true }] });
assert.equal(truncatedValue[0].status, "unknown", "a truncated value cannot disprove an exact expectation");
assert.equal(truncatedValue[0].unknownReason, "value_truncated");
const oversizedDocument = "v".repeat(20_000);
const unreadSuffix = evaluateWindowsVerification(target, [{ element: { selector: { role: "Document" }, value_equals: oversizedDocument } }], { ...snapshot, elements: [{ ...editor, value: oversizedDocument.slice(0, 10_001), value_truncated: true }] });
assert.equal(unreadSuffix[0].status, "unknown", "a matching prefix of a document beyond the native read limit is not an unequal value");
assert.equal(evaluateWindowsVerification(target, [{ element: { selector: { role: "Document" }, exists: true } }], { ...snapshot, elements: [{ ...editor, value_truncated: true }] })[0].status, "satisfied", "value truncation does not affect an existence-only check");

const longValue = '\"\n\u0001'.repeat(2_000);
const longLabel = "Text editor " + '\"\n'.repeat(1_000);
const largeEvidence = evaluateWindowsVerification(target, [{ element: { selector: { role: "Document" }, value_equals: longValue } }], { ...snapshot, elements: [{ ...editor, label: longLabel, value: longValue }] });
assert.equal(largeEvidence[0].status, "satisfied", "the actual value is compared before evidence is shortened");
assert.ok((largeEvidence[0].observed?.length ?? 0) <= 2_000, "escaped evidence stays within the per-predicate character budget");
const evidence = JSON.parse(largeEvidence[0].observed ?? "null");
assert.equal(evidence.runtime_id, editor.runtime_id, "opaque runtime identity remains complete");
assert.ok(evidence.truncated_fields.includes("value"));
assert.ok(evidence.truncated_fields.includes("label"));

for (const patch of [
	{ framework_id: "Chrome" },
	{ framework_id: "unknown" },
	{ class_name: "Chrome_RenderWidgetHostHWND" },
	{ web_ancestor: true },
	{ process_id: 99 },
]) {
	assert.equal(evaluateWindowsVerification(target, expected, { ...snapshot, elements: [{ ...editor, ...patch }] })[0].unknownReason, "untrusted_source", `untrusted source retains unknown: ${JSON.stringify(patch)}`);
}

for (const role of ["WebArea", "DocumentWeb", "Embedded"]) {
	const result = evaluateWindowsVerification(target, [{ element: { selector: { label_contains: "editor" }, exists: true } }], { ...snapshot, elements: [{ ...editor, role }] });
	assert.equal(result[0].unknownReason, "untrusted_source", `explicit ${role} is never treated as native`);
}

for (const malformed of [
	{ window: { exists: true }, element: { selector: { role: "Document" }, exists: true } },
	{ element: { selector: {}, exists: true } },
	{ element: { selector: { role: " " }, exists: true } },
	{ element: { selector: { role: "Document" }, exists: false } },
]) {
	assert.equal(evaluateWindowsVerification(target, [malformed], snapshot)[0].unknownReason, "invalid_predicate");
}

let calls = 0;
const verified = await verifyNativeWindowsElements(target, expected, undefined, async () => {
	calls++;
	return snapshot;
});
assert.equal(verified.status, "satisfied");
assert.equal(verified.stable, true);
assert.equal(verified.samples, 2);
assert.equal(calls, 2, "native verification reads two independent samples");
const longVerified = await verifyNativeWindowsElements(target, [{ element: { selector: { role: "Document" }, value_equals: longValue } }], undefined, async () => ({ ...snapshot, elements: [{ ...editor, label: longLabel, value: longValue }] }));
assert.equal(longVerified.status, "satisfied", "bounded JSON evidence remains usable for stable runtime-identity comparison");

const driver: BackendVerifyResult = {
	status: "unknown", stable: false, samples: 50, elapsedMs: 5_000,
	predicates: [
		{ index: 0, status: "satisfied", unknownReason: null, observed: "driver window evidence" },
		{ index: 1, status: "unknown", unknownReason: "untrusted_source", observed: "driver document evidence" },
	],
};
const nativeGroup = await verifyNativeWindowsElements(target, [{ window: { exists: true } }, ...expected], undefined, async () => snapshot);
assert.equal(nativeGroup.status, "satisfied", "the native group rechecks the window and editor in the same two samples");
assert.equal(mergeWindowsVerification(driver, nativeGroup), nativeGroup, "a full new native sampling group replaces the old result as one group");
assert.equal(nativeGroup.samples, 2, "full replacement reports only native samples");
assert.equal(mergeWindowsVerification(nativeGroup, driver), nativeGroup, "a result without the driver's untrusted-source defect is unchanged");
const partialNative: BackendVerifyResult = {
	...nativeGroup, status: "unknown", stable: false,
	predicates: [{ index: 0, status: "unknown", unknownReason: "observation_unavailable", observed: null }, nativeGroup.predicates[1]],
};
const partial = mergeWindowsVerification(driver, partialNative);
assert.equal(partial.status, "satisfied");
assert.equal(partial.stable, false, "mixing earlier driver state and new native state cannot establish stability");
assert.equal(partial.samples, 52);
assert.equal(partial.predicates[0], driver.predicates[0], "unaffected driver predicates are retained");
assert.equal(partial.predicates[1], partialNative.predicates[1]);
assert.equal(driver.predicates[1].status, "unknown", "merging never mutates driver evidence");
const stillUnknown = { ...partialNative, predicates: partialNative.predicates.map((predicate) => ({ ...predicate, status: "unknown" as const, unknownReason: "untrusted_source" })) };
assert.equal(mergeWindowsVerification(driver, stillUnknown), driver, "untrusted native evidence cannot change the original driver result");

calls = 0;
const changedTarget = await verifyNativeWindowsElements(target, expected, undefined, async () => {
	calls++;
	return { ...snapshot, elements: [{ ...editor, runtime_id: calls === 1 ? "first" : "second" }] };
});
assert.equal(changedTarget.status, "unknown");
assert.equal(changedTarget.stable, false);
assert.equal(changedTarget.predicates[0].unknownReason, "stability_unproven", "a replaced element cannot establish stable native evidence");

const unavailable = await verifyNativeWindowsElements(target, expected, undefined, async () => { throw new Error("UIA read failed"); });
assert.equal(unavailable.status, "unknown");
assert.equal(unavailable.predicates[0].unknownReason, "observation_unavailable");
assert.match(unavailable.predicates[0].observed ?? "", /UIA read failed/);

const abort = new AbortController();
await assert.rejects(verifyNativeWindowsElements(target, expected, abort.signal, async () => {
	abort.abort();
	return snapshot;
}), (error: unknown) => error instanceof ComputerUseError && error.code === "cancelled");

console.log("PASS: Windows native verification, web trust, ambiguity, stability, errors and cancellation.");
