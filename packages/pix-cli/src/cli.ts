#!/usr/bin/env node
import { createRequire } from "node:module";
import { main } from "@earendil-works/pi-coding-agent";
import { createCliHost, parseCliOptions } from "./host.js";
import { createPixInteractivePresentation } from "./tui-presentation.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
process.title = "pix";
process.env.PI_CODING_AGENT = "true";

try {
	const { args, options } = parseCliOptions(process.argv.slice(2));
	await main(args, {
		host: createCliHost(version, options),
		interactivePresentation: createPixInteractivePresentation,
	});
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
