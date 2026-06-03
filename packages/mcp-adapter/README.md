# pi-mcp-adapter

MCP client adapter extension for Pi and PiX.

It connects configured MCP servers when a Pi session starts, discovers their
tools, registers them as Pi tools, reconnects once on transient failures, and
closes all transports when the session shuts down.

## Configuration

The adapter discovers MCP servers from these files, in order:

- `~/.pi/agent/mcp.json`
- `<project>/.mcp.json`
- `<project>/.pi/mcp.json`
- Additional paths listed in `PI_MCP_CONFIG` separated by the platform path delimiter

Supported config shape:

```json
{
	"mcpServers": {
		"filesystem": {
			"command": "npx",
			"args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
		},
		"docs": {
			"url": "https://example.com/mcp",
			"transport": "http"
		}
	}
}
```

Supported transports:

- `stdio`: `command`, optional `args`, `cwd`, and `env`
- `http` / `streamable-http`: `url`, optional `headers`
- `sse`: `url`, optional `headers`

Server options include `enabled`, `disabled`, `required`, `startupTimeoutMs`,
`requestTimeoutMs`, `timeoutMs`, `toolNamePrefix`, and `description`.

Remote tools are exposed as `mcp__<server>__<tool>` by default. The adapter also
registers resource/status tools when MCP is configured:

- `mcp_list_servers`
- `mcp_list_resources`
- `mcp_list_resource_templates`
- `mcp_read_resource`

PiX loads this adapter by default through its session resource loader, so users
only need to add an MCP config file.
