import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ComputerUseError } from "../computer-use/contracts.js";
import { withWindowsClipboardText } from "../computer-use/windows-clipboard.js";

const execute = promisify(execFile);
async function readClipboard(): Promise<{ text: string; formats: string[] }> {
	const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Sta", "-Command",
		"Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $data=[Windows.Forms.Clipboard]::GetDataObject(); @{text=[Windows.Forms.Clipboard]::GetText();formats=@(if($null -ne $data){$data.GetFormats($false)})}|ConvertTo-Json -Compress"], { windowsHide: true, encoding: "utf8" });
	return JSON.parse(stdout) as { text: string; formats: string[] };
}

if (process.platform === "win32") {
	const original = await readClipboard();
	for (const fail of [false, true]) {
		const operation = withWindowsClipboardText("PiX clipboard test 中文\n123 !@#", async () => {
			assert.ok((await readClipboard()).text === "PiX clipboard test 中文\n123 !@#", "the paste sees the entire Unicode text");
			if (fail) throw new ComputerUseError("cancelled", "Test cancellation");
			return "pasted";
		});
		if (fail) await assert.rejects(operation, (error: unknown) => error instanceof ComputerUseError && error.code === "cancelled");
		else assert.equal(await operation, "pasted");
		const restored = await readClipboard();
		assert.ok(restored.text === original.text, "the original clipboard text is restored on completion and cancellation");
		assert.ok(original.formats.every((format) => restored.formats.includes(format)), "all original clipboard formats remain available");
	}
	console.log("PASS: clipboard Unicode payload and original formats survive success and cancellation.");
} else console.log("SKIP: Windows clipboard test.");
