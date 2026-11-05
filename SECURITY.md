# Security policy

## Supported versions

Only the latest published minor version receives security fixes.

## Reporting a vulnerability

Open a private security advisory on the repository, or email the maintainer listed in
`package.json`. Please do not open a public issue for a suspected vulnerability.

Include the plugin version, the DSH version, and the smallest reproduction you can manage.

## Threat model

The plugin runs inside the DeepSeek Harness Host process and talks to a local ai-memory server.
The assets worth protecting are:

1. **The ai-memory bearer token.** Read at runtime from ai-memory's own data directory, held in
   memory, never written to configuration or logs.
2. **Session content.** Prompts, tool inputs and tool results can contain credentials or private
   data. Prompt capture is off by default; tool bodies are clipped to a byte budget.
3. **Data destination.** A misconfigured `serverUrl` must not become an exfiltration path.

### Mitigations

- Non-loopback servers are refused unless `allowRemote: true` is set, and must then use `https`.
- Credential-shaped strings are redacted before capture (`lib/redact.js`).
- In-flight requests are capped and the queue drops work rather than growing without bound.
- The plugin never spawns a process, never evaluates captured text, and never writes files other
  than the optional `DSH_AI_MEMORY_TRACE` log.
- Every handler is wrapped so a failure cannot escape into the agent loop.

### Out of scope

- A hostile ai-memory server on loopback: anything running as your user already has the token.
- Content that reaches ai-memory by other channels (the MCP tools, command hooks, other harnesses).
- Denial of service by a local process.
