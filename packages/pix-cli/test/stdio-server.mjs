import { writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const marker = process.argv[2];
const server = new McpServer({ name: "fixture", version: "1.0.0" });
server.registerTool("ping", {}, () => ({ content: [{ type: "text", text: "pong" }] }));
await server.connect(new StdioServerTransport());
process.stdin.on("end", async () => {
	await server.close();
	await writeFile(marker, "closed");
});
