import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ComputerUseError } from "./contracts.js";

const CLIPBOARD_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type 'using System; using System.Runtime.InteropServices; public static class ClipboardSequence {
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, UIntPtr w, IntPtr l, uint flags, uint timeout, out UIntPtr result);
}'
$request = [Console]::ReadLine() | ConvertFrom-Json
$backup = [Windows.Forms.DataObject]::new()
$original = [Windows.Forms.Clipboard]::GetDataObject()
if ($null -ne $original) {
  foreach ($format in $original.GetFormats($false)) {
    $data = $original.GetData($format, $false)
    if ($null -eq $data) { throw "Cannot preserve clipboard format: $format" }
    $backup.SetData($format, $false, $data)
  }
}
$changed = $false
$sequence = 0
try {
  [Windows.Forms.Clipboard]::SetText([string]$request.text, [Windows.Forms.TextDataFormat]::UnicodeText)
  $changed = $true
  $sequence = [ClipboardSequence]::GetClipboardSequenceNumber()
  [Console]::WriteLine('ready')
  while ($null -ne ($commandLine = [Console]::ReadLine())) {
    if ($commandLine -eq 'restore') { break }
    try {
      $command = $commandLine | ConvertFrom-Json
      $hwnd = [IntPtr][long]$command.hwnd
      [uint32]$owner = 0
      $null = [ClipboardSequence]::GetWindowThreadProcessId($hwnd, [ref]$owner)
      if ($owner -ne $command.pid) { throw 'The native editor no longer belongs to the target process.' }
      [UIntPtr]$result = [UIntPtr]::Zero
      $sent = [ClipboardSequence]::SendMessageTimeout($hwnd, 0x0302, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 5000, [ref]$result)
      if ($sent -eq [IntPtr]::Zero) { throw 'Native paste did not finish. Observe the target before deciding whether to retry.' }
      [Console]::WriteLine('{"ok":true}')
    } catch {
      [Console]::WriteLine((@{error=[string]$_.Exception.Message}|ConvertTo-Json -Compress))
    }
  }
} finally {
  if ($changed -and [ClipboardSequence]::GetClipboardSequenceNumber() -eq $sequence) {
    if ($null -eq $original) { [Windows.Forms.Clipboard]::Clear() }
    else { [Windows.Forms.Clipboard]::SetDataObject($backup, $true) }
  }
}
`;

/** Keep clipboard ownership in one STA process until the paste and read-back finish. */
export async function withWindowsClipboardText<T>(text: string, paste: (pasteNative: (pid: number, hwnd: number) => Promise<void>) => Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) throw new ComputerUseError("cancelled", "Text input was cancelled before changing the clipboard.");
	if (text.length === 0) throw new ComputerUseError("invalid_params", "Clipboard input needs non-empty text.");
	const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-Sta", "-Command", CLIPBOARD_SCRIPT], {
		windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
	});
	const lines = createInterface({ input: child.stdout });
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-2_000); });
	let ready = false;
	let pasteStarted = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const exited = new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => code === 0 ? resolve() : reject(new ComputerUseError("driver_error", `Clipboard transaction failed: ${stderr || `exit ${code}`}`)));
	});
	void exited.catch(() => undefined);
	const prepared = new Promise<void>((resolve, reject) => {
		lines.once("line", (line) => {
			if (line !== "ready") return reject(new ComputerUseError("driver_error", "Unexpected clipboard transaction response."));
			ready = true;
			resolve();
		});
		exited.then(() => { if (!ready) reject(new ComputerUseError("driver_error", "Clipboard transaction ended before preparing text.")); }, reject);
		timer = setTimeout(() => { child.kill(); reject(new ComputerUseError("timeout", "Preparing the clipboard timed out; no paste was sent.")); }, 10_000);
	});
	child.stdin.on("error", () => {}); // The process exit supplies the clipboard diagnostic.
	child.stdin.write(`${JSON.stringify({ text })}\n`);
	try {
		await prepared;
		clearTimeout(timer);
		if (signal?.aborted) throw new ComputerUseError("cancelled", "Text input was cancelled before pasting.");
		pasteStarted = true;
		return await paste(async (pid, hwnd) => {
			if (signal?.aborted) throw new ComputerUseError("cancelled", "Native paste was cancelled before dispatch.");
			const response = new Promise<void>((resolve, reject) => lines.once("line", (line) => {
				try {
					const parsed = JSON.parse(line) as { ok?: boolean; error?: string };
					if (parsed.ok === true) resolve();
					else reject(new ComputerUseError("driver_error", parsed.error ?? "Native paste failed; observe before retrying."));
				} catch (error) { reject(error); }
			}));
			child.stdin.write(`${JSON.stringify({ pid, hwnd })}\n`);
			await Promise.race([response, exited.then(() => { throw new ComputerUseError("driver_error", "Clipboard process ended during paste; observe before retrying."); })]);
		});
	} finally {
		clearTimeout(timer);
		child.stdin.end("restore\n");
		try {
			await exited;
		} catch (error) {
			if (pasteStarted) throw new ComputerUseError("driver_error", "The paste may have completed, but clipboard cleanup failed. Observe the target before deciding whether to retry.", error instanceof Error ? error.message : String(error));
			throw error;
		} finally { lines.close(); }
	}
}
