# pi-mcp-adapter

MCP client adapter extension for Pi and PiX.

It connects configured MCP servers when a Pi session starts, discovers their
tools, registers them as Pi tools, reconnects once on transient failures, and
closes all transports when the session shuts down.

## Connection reuse, circuit breaker, startup budget

Connections are owned by a **process-wide pool**, not by the adapter instance.
PiX builds a fresh adapter for every session generation (opening a workspace,
switching sessions, forking) and disposes the previous one first, so pooling is
what keeps the `initialize` + `tools/list` handshake from repeating on every
switch.

- **Hot path** — a session that finds an already-connected pooled server
  registers its cached tools synchronously. No network round trip, no `await`.
- **Idle eviction** — after the last adapter releases a connection it stays warm
  for 10 minutes, then is disconnected. The pool is shared by adapters whose
  loaded configs differ (different `cwd`, `allowStdio`, `options.servers`), so
  there is no "not in my config" eviction: removing a server from `mcp.json`
  lets its connection linger at most 10 minutes, during which it is invisible to
  `getServers()` and to every session's tool list.
- **Startup budget** — the `startupBlockingBudgetMs` adapter option (default
  `1500`) caps how long a non-required server may block `session_start`. Servers
  that exceed it keep connecting in the background and register their tools when
  ready (`registerTool` refreshes the session's tool registry automatically).
  `required: true` servers are exempt and still wait the full `startupTimeoutMs`.
- **Circuit breaker** — a failed *startup* connect arms a per-connection breaker
  that backs off 30s, 60s, 120s, 240s, 300s. While it is open the startup path
  refuses to connect at all (so an unreachable server no longer costs
  `DEFAULT_STARTUP_TIMEOUT_MS` on every session switch) and `getServers()` /
  `mcp_list_servers` report the remaining cool-down. Request paths (tool calls,
  resource queries) do **not** arm the breaker and are never blocked by it, so a
  manual refresh always retries for real.

`DEFAULT_STARTUP_TIMEOUT_MS` is unchanged: it still bounds an individual connect
attempt, it just no longer bounds how long `session_start` can stall.

**Known deviations from per-adapter ownership** (harmless in practice, since all
adapters in a process read the same config): `startupTimeoutMs`,
`requestTimeoutMs` and `toolNamePrefix` come from the first adapter that created
a pooled connection. Connection-level state (`status`, `error`, `tools`, client,
transport) is shared, so a health-check or reconnect-driven `disconnect()` on
one adapter is visible to the others; they recover through their own
`withReconnect` on the next request, and already-registered tools never
disappear.

Applications that shut down should call the exported
`closeAllMcpConnections()` (PiX does this in its Electron `cleanup()`) to
disconnect HTTP/SSE transports and kill stdio children. A `process.once("exit")`
handler kills stdio children as a fallback.

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
