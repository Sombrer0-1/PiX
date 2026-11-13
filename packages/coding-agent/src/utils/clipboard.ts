import { execFile, execSync, spawn } from "child_process";
import { platform } from "os";
import { promisify } from "util";
import { isWaylandSession } from "./clipboard-image.ts";
import { clipboard } from "./clipboard-native.ts";
import { isWSL } from "./wsl.ts";

type NativeClipboardExecOptions = {
	input: string;
	timeout: number;
	stdio: ["pipe", "ignore", "ignore"];
};

function copyToX11Clipboard(options: NativeClipboardExecOptions): void {
	try {
		execSync("xclip -selection clipboard", options);
	} catch {
		execSync("xsel --clipboard --input", options);
	}
}

const MAX_OSC52_ENCODED_LENGTH = 100_000;
const execClipboard = promisify(execFile);

async function readClipboardCommand(command: string, args: string[]): Promise<string | null> {
	try {
		const { stdout } = await execClipboard(command, args, {
			cwd: "/",
			encoding: "utf-8",
			maxBuffer: 50 * 1024 * 1024,
			timeout: 5000,
			windowsHide: true,
		});
		return stdout || null;
	} catch {
		return null;
	}
}

export async function readClipboardText(): Promise<string | null> {
	const p = platform();
	const commands: [string, string[]][] = [];
	if (process.env.TERMUX_VERSION) commands.push(["termux-clipboard-get", []]);
	if (p === "linux") {
		if (process.env.WAYLAND_DISPLAY) commands.push(["wl-paste", ["--no-newline", "--type", "text"]]);
		if (process.env.DISPLAY) {
			commands.push(["xclip", ["-selection", "clipboard", "-out"]], ["xsel", ["--clipboard", "--output"]]);
		}
	}
	for (const [command, args] of commands) {
		const text = await readClipboardCommand(command, args);
		if (text) return text;
	}
	try {
		const text = await clipboard?.getText();
		if (text) return text;
	} catch {
		// Windows can still read the clipboard through PowerShell.
	}
	if (p === "win32" || (p === "linux" && isWSL())) {
		return readClipboardCommand("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); [Console]::Write([string](Get-Clipboard -Raw))",
		]);
	}
	return null;
}

function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

export async function copyToClipboard(text: string): Promise<void> {
	let copied = false;

	const p = platform();

	// Prefer direct clipboard writes. Emitting OSC 52 first can make terminals
	// write the same native clipboard concurrently with the addon, and very large
	// OSC 52 payloads can desynchronize terminal rendering.
	//
	// On Linux, skip the native addon. The underlying `clipboard-rs` crate is
	// X11-only and does not retain selection ownership after `set_text`
	// resolves, so on Wayland-only compositors (Hyprland, Niri, ...) and even
	// some X11 sessions the call resolves successfully without populating the
	// clipboard. The platform tools below (wl-copy, xclip, xsel) properly
	// daemonize and keep ownership.
	try {
		if (clipboard && p !== "linux") {
			await clipboard.setText(text);
			copied = true;
		}
	} catch {
		// Fall through to platform-specific clipboard tools.
	}

	const remote = isRemoteSession();
	if (copied && !remote) {
		return;
	}

	const options: NativeClipboardExecOptions = { input: text, timeout: 5000, stdio: ["pipe", "ignore", "ignore"] };

	if (!copied) {
		try {
			if (p === "darwin") {
				execSync("pbcopy", options);
				copied = true;
			} else if (p === "win32") {
				execSync("clip", options);
				copied = true;
			} else {
				// Linux. Try Termux, Wayland, or X11 clipboard tools.
				if (process.env.TERMUX_VERSION) {
					try {
						execSync("termux-clipboard-set", options);
						copied = true;
					} catch {
						// Fall back to Wayland or X11 tools.
					}
				}

				if (!copied) {
					const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
					const hasX11Display = Boolean(process.env.DISPLAY);
					const isWayland = isWaylandSession();
					if (isWayland && hasWaylandDisplay) {
						try {
							// Verify wl-copy exists (spawn errors are async and won't be caught)
							execSync("which wl-copy", { stdio: "ignore" });
							// wl-copy with execSync hangs due to fork behavior; use spawn instead
							const proc = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
							proc.stdin.on("error", () => {
								// Ignore EPIPE errors if wl-copy exits early
							});
							proc.stdin.write(text);
							proc.stdin.end();
							proc.unref();
							copied = true;
						} catch {
							if (hasX11Display) {
								copyToX11Clipboard(options);
								copied = true;
							}
						}
					} else if (hasX11Display) {
						copyToX11Clipboard(options);
						copied = true;
					}
				}
			}
		} catch {
			// Fall through to OSC 52 fallback.
		}
	}

	if (remote || !copied) {
		const osc52Copied = emitOsc52(text);
		copied = copied || osc52Copied;
	}

	if (!copied) {
		throw new Error("Failed to copy to clipboard");
	}
}
