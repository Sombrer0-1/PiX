import { execFile } from "node:child_process";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { ComputerVerifyExpectation } from "../../shared/computer-use-types.js";
import { ComputerUseError, type BackendVerifyPredicate, type BackendVerifyResult } from "./contracts.js";

export interface WindowsVerificationElement {
	role: string;
	label: string;
	runtime_id: string;
	process_id: number;
	framework_id: string;
	class_name: string;
	native_window_handle?: number;
	web_ancestor: boolean;
	value?: string;
	value_truncated?: boolean;
	enabled?: boolean;
	selected?: boolean;
	text_document?: string;
	selection_prefix?: string;
	selection_text?: string;
}

export interface WindowsVerificationSnapshot {
	pid: number;
	window_id: number;
	complete: boolean;
	elements: WindowsVerificationElement[];
	error?: string;
}

interface WindowTarget { pid: number; window_id: number }
type SnapshotReader = (target: WindowTarget, expect: readonly ComputerVerifyExpectation[], signal?: AbortSignal) => Promise<WindowsVerificationSnapshot>;

// UIA's Document control type also describes native RichEdit editors. Framework
// and window-class properties distinguish them from browser-controlled documents.
const NATIVE_FRAMEWORKS = new Set(["win32", "winform", "wpf", "xaml"]);
const WEB_PROVIDER = /chrome|chromium|webview|webkit|mozilla|mshtml|internet.?explorer|edgehtml/i;

const READ_UIA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$root = [Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$request.window_id)
if ($null -eq $root -or $root.Current.ProcessId -ne $request.pid) { throw 'The window no longer belongs to the requested process.' }
$walker = [Windows.Automation.TreeWalker]::ControlViewWalker
$queue = [Collections.Generic.Queue[object]]::new()
$queue.Enqueue(@{ element = $root; web = $false })
$records = [Collections.Generic.List[object]]::new()
$visited = 0
$complete = $true
$observationError = $null
function Normalize-Role([string]$role) {
  $role = ($role -replace '[^a-zA-Z0-9]', '').ToLowerInvariant() -replace '^ax', ''
  switch ($role) { 'pushbutton' { 'button' } 'pagetab' { 'tab' } 'tabitem' { 'tab' } default { $role } }
}
while ($queue.Count -gt 0 -and $visited -lt 2000) {
  $item = $queue.Dequeue()
  $element = $item.element
  $visited++
  try {
    $current = $element.Current
    $role = $current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    $framework = [string]$current.FrameworkId
    $class = [string]$current.ClassName
    $web = $item.web -or (($framework + ' ' + $class) -match '(?i)chrome|chromium|webview|webkit|mozilla|mshtml|internet.?explorer|edgehtml')
    if ($role -eq 'Document' -and $framework.ToLowerInvariant() -notin @('win32', 'winform', 'wpf', 'xaml')) { $web = $true }
    $matches = $false
    foreach ($predicate in $request.expect) {
      if ($null -eq $predicate.element) { continue }
      $selector = $predicate.element.selector
      if ($selector.role -and (Normalize-Role $selector.role) -ne (Normalize-Role $role)) { continue }
      if ($selector.label_contains -and ([string]$current.Name).IndexOf([string]$selector.label_contains, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
      $matches = $true
      break
    }
    if ($matches) {
      $record = @{
        role = $role; label = [string]$current.Name; runtime_id = [string]::Join(',', $element.GetRuntimeId())
        process_id = $current.ProcessId; framework_id = $framework; class_name = $class
        native_window_handle = [long]$current.NativeWindowHandle
        web_ancestor = [bool]$web; enabled = [bool]$current.IsEnabled
      }
      $pattern = $null
      if ($element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        $value = [string]$pattern.Current.Value
        $record.value = $value.Substring(0, [Math]::Min(10001, $value.Length))
        $record.value_truncated = $value.Length -gt 10001
      } elseif ($element.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
        $value = [string]$pattern.DocumentRange.GetText(10002)
        $record.value = $value.Substring(0, [Math]::Min(10001, $value.Length))
        $record.value_truncated = $value.Length -gt 10001
      }
      $pattern = $null
      if ($request.selection -and $element.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
        $selection = $pattern.GetSelection()
        if ($selection.Count -eq 1) {
          $prefix = $pattern.DocumentRange.Clone()
          $prefix.MoveEndpointByRange([Windows.Automation.Text.TextPatternRangeEndpoint]::End, $selection[0], [Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
          $record.text_document = [string]$pattern.DocumentRange.GetText(10002)
          $record.selection_prefix = [string]$prefix.GetText(10002)
          $record.selection_text = [string]$selection[0].GetText(10002)
        }
      }
      $pattern = $null
      if ($element.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
        $record.selected = [bool]$pattern.Current.IsSelected
      } elseif ($element.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
        if ($pattern.Current.ToggleState -ne [Windows.Automation.ToggleState]::Indeterminate) {
          $record.selected = $pattern.Current.ToggleState -eq [Windows.Automation.ToggleState]::On
        }
      }
      $records.Add($record)
    }
    $child = $walker.GetFirstChild($element)
    while ($null -ne $child) {
      $queue.Enqueue(@{ element = $child; web = $web })
      $child = $walker.GetNextSibling($child)
    }
  } catch {
    $complete = $false
    if ($null -eq $observationError) { $observationError = [string]$_.Exception.Message }
  }
}
if ($queue.Count -gt 0) { $complete = $false }
@{ pid = [int]$request.pid; window_id = [long]$request.window_id; complete = $complete; elements = @($records.ToArray()); error = $observationError } | ConvertTo-Json -Depth 8 -Compress
`;

function normalizedRole(role: string): string {
	const normalized = role.replace(/[^a-z0-9]/gi, "").toLowerCase().replace(/^ax/, "");
	if (normalized === "pushbutton") return "button";
	return normalized === "pagetab" || normalized === "tabitem" ? "tab" : normalized;
}

function outcome(index: number, status: BackendVerifyPredicate["status"], unknownReason: string | null, observed: Record<string, unknown> | null): BackendVerifyPredicate {
	let encoded = JSON.stringify(observed);
	if (observed !== null && encoded.length > 2_000) {
		const bounded = { ...observed };
		const fields = Object.entries(observed)
			.filter(([key, value]) => key !== "source" && key !== "runtime_id" && typeof value === "string")
			.sort((left, right) => String(right[1]).length - String(left[1]).length);
		const truncatedFields: string[] = [];
		bounded.truncated_fields = truncatedFields;
		for (const [key, value] of fields) {
			if (encoded.length <= 2_000) break;
			truncatedFields.push(key);
			const text = String(value);
			bounded[key] = "";
			const available = Math.max(0, 2_000 - JSON.stringify(bounded).length);
			bounded[key] = text.slice(0, available);
			encoded = JSON.stringify(bounded);
			if (encoded.length > 2_000 && available > 0) {
				bounded[key] = text.slice(0, Math.max(0, available - (encoded.length - 2_000)));
				encoded = JSON.stringify(bounded);
			}
		}
	}
	return { index, status, unknownReason, observed: encoded };
}

/** Evaluate newly read native UIA evidence; web providers retain unknown status. */
export function evaluateWindowsVerification(
	target: WindowTarget,
	expect: readonly ComputerVerifyExpectation[],
	snapshot: WindowsVerificationSnapshot,
): BackendVerifyPredicate[] {
	return expect.map((predicate, index) => {
		const requested = predicate.element;
		if ((requested === undefined) === (predicate.window === undefined) || requested?.exists === false) {
			return outcome(index, "unknown", "invalid_predicate", null);
		}
		if (snapshot.pid !== target.pid || snapshot.window_id !== target.window_id) {
			return outcome(index, "unknown", "target_missing", null);
		}
		if (requested === undefined) {
			return predicate.window?.exists === undefined ? outcome(index, "unknown", "invalid_predicate", null)
				: outcome(index, predicate.window.exists ? "satisfied" : "unsatisfied", null, { source: "windows_uia", exists: true, ...target });
		}
		const selector = requested.selector;
		if ((!selector.role && !selector.label_contains) || selector.role?.trim() === "" || selector.label_contains?.trim() === "") {
			return outcome(index, "unknown", "invalid_predicate", null);
		}
		const matches = snapshot.elements.filter((element) =>
			(selector.role === undefined || normalizedRole(element.role) === normalizedRole(selector.role))
			&& (selector.label_contains === undefined || element.label.toLowerCase().includes(selector.label_contains.toLowerCase())));
		if (matches.length === 0) return outcome(index, "unknown", snapshot.complete ? "target_missing" : "observation_unavailable", { source: "windows_uia", matches: 0, error: snapshot.error });
		const trusted = matches.filter((element) => element.process_id === target.pid
			&& NATIVE_FRAMEWORKS.has(element.framework_id.toLowerCase())
			&& !element.web_ancestor
			&& !WEB_PROVIDER.test(`${element.framework_id} ${element.class_name}`)
			&& !/webarea|documentweb|embedded/i.test(normalizedRole(element.role)));
		if (trusted.length !== matches.length) return outcome(index, "unknown", "untrusted_source", { source: "windows_uia", matches: matches.length });
		const hasProperty = requested.value_equals !== undefined || requested.enabled !== undefined || requested.selected !== undefined;
		if (hasProperty && (matches.length !== 1 || !snapshot.complete)) {
			return outcome(index, "unknown", matches.length !== 1 ? "multi_match" : "observation_unavailable", { source: "windows_uia", matches: matches.length });
		}
		const element = trusted[0];
		const evidence = {
			source: "windows_uia", runtime_id: element.runtime_id, role: element.role, label: element.label,
			framework_id: element.framework_id, class_name: element.class_name,
			value: element.value, value_truncated: element.value_truncated, enabled: element.enabled, selected: element.selected,
		};
		for (const [key, expected] of [["value", requested.value_equals], ["enabled", requested.enabled], ["selected", requested.selected]] as const) {
			if (expected === undefined) continue;
			if (element[key] === undefined) return outcome(index, "unknown", "unsupported_predicate", evidence);
			if (key === "value" && element.value_truncated === true) return outcome(index, "unknown", "value_truncated", evidence);
			if (element[key] !== expected) return outcome(index, "unsatisfied", null, evidence);
		}
		return outcome(index, "satisfied", null, evidence);
	});
}

export async function readWindowsUiaElements(target: WindowTarget, expect: readonly ComputerVerifyExpectation[], signal?: AbortSignal, selection = false): Promise<WindowsVerificationSnapshot> {
	const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	return new Promise((resolve, reject) => {
		const child = execFile(executable, ["-NoProfile", "-NonInteractive", "-Command", READ_UIA_SCRIPT], {
			windowsHide: true, timeout: 8_000, maxBuffer: 4 * 1024 * 1024, signal, encoding: "utf8",
		}, (error, stdout, stderr) => {
			if (error !== null) return reject(new Error(stderr.trim() || `Native UIA reader exited with ${error.code ?? error.name}.`));
			try { resolve(JSON.parse(stdout) as WindowsVerificationSnapshot); } catch (parseError) { reject(parseError); }
		});
		child.stdin?.once("error", reject);
		child.stdin?.end(JSON.stringify({ ...target, expect, selection }));
	});
}

/** Independently sample native controls twice after the driver rejects a Document source. */
export async function verifyNativeWindowsElements(
	target: WindowTarget,
	expect: readonly ComputerVerifyExpectation[],
	signal?: AbortSignal,
	read: SnapshotReader = readWindowsUiaElements,
): Promise<BackendVerifyResult> {
	const started = Date.now();
	let samples = 0;
	try {
		const first = evaluateWindowsVerification(target, expect, await read(target, expect, signal));
		samples++;
		await setTimeout(100, undefined, { signal });
		const predicates = evaluateWindowsVerification(target, expect, await read(target, expect, signal));
		samples++;
		for (const current of predicates) {
			const previous = first[current.index];
			const previousEvidence = previous.observed === null ? null : JSON.parse(previous.observed) as { runtime_id?: string };
			const currentEvidence = current.observed === null ? null : JSON.parse(current.observed) as { runtime_id?: string };
			if (current.status === "satisfied" && (previous.status !== "satisfied" || previousEvidence?.runtime_id !== currentEvidence?.runtime_id)) {
				current.status = "unknown";
				current.unknownReason = "stability_unproven";
			}
		}
		const status = predicates.some((predicate) => predicate.status === "unsatisfied") ? "unsatisfied"
			: predicates.some((predicate) => predicate.status === "unknown") ? "unknown" : "satisfied";
		return { status, stable: status === "satisfied", samples, elapsedMs: Date.now() - started, predicates };
	} catch (error) {
		if (signal?.aborted) throw new ComputerUseError("cancelled", "Native UIA verification was cancelled.");
		const detail = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
		return {
			status: "unknown", stable: false, samples, elapsedMs: Date.now() - started,
			predicates: expect.map((_predicate, index) => outcome(index, "unknown", "observation_unavailable", { source: "windows_uia", error: detail })),
		};
	}
}

/** Prefer one complete native sampling group; partial evidence cannot establish stability. */
export function mergeWindowsVerification(driver: BackendVerifyResult, native: BackendVerifyResult): BackendVerifyResult {
	if (!driver.predicates.some((predicate) => predicate.status === "unknown" && predicate.unknownReason === "untrusted_source")) return driver;
	if (native.predicates.length === driver.predicates.length && native.predicates.every((predicate) => predicate.status !== "unknown")) return native;
	const nativeByIndex = new Map(native.predicates.map((predicate) => [predicate.index, predicate]));
	let replaced = false;
	const predicates = driver.predicates.map((predicate) => {
		const replacement = nativeByIndex.get(predicate.index);
		if (predicate.status !== "unknown" || predicate.unknownReason !== "untrusted_source" || replacement === undefined || replacement.status === "unknown") return predicate;
		replaced = true;
		return replacement;
	});
	if (!replaced) return driver;
	const status = predicates.some((predicate) => predicate.status === "unsatisfied") ? "unsatisfied"
		: predicates.some((predicate) => predicate.status === "unknown") ? "unknown" : "satisfied";
	return {
		status, stable: false, samples: driver.samples + native.samples,
		elapsedMs: driver.elapsedMs === null || native.elapsedMs === null ? null : driver.elapsedMs + native.elapsedMs,
		predicates,
	};
}
