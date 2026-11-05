# dsh-ai-memory

Connects [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) sessions to
[ai-memory](https://github.com/akitaonrails/ai-memory), so each session is stored under the repository
it actually ran in.

## Why this exists

DSH reaches ai-memory's tools over MCP. That transport carries tool calls, but not the two things
ai-memory needs to file a session correctly:

- **Session identity.** The MCP bridge runs with `--no-session-id`, so the server falls back to a
  global "last project" slot. Concurrent harnesses overwrite that slot for each other.
- **Lifecycle events.** Session start and end are what turn raw observations into a session page and
  a handoff. MCP has no such channel, and DSH's command-hook bridge cannot write ai-memory's spool
  directory inside its sandbox.

This plugin is a Host half that forwards exactly those two things over ai-memory's HTTP ingest
endpoint. It does not replace the tools: keep using the ai-memory MCP client for `memory_*` calls.

## Requirements

- DeepSeek Harness 0.2.2-rc.1 or newer.
- ai-memory 3.x reachable on loopback (default `http://127.0.0.1:49374`).
- The ai-memory MCP server, if you want the `memory_*` tools as well. This plugin only syncs sessions.

## Install

From a local checkout:

```text
plugin_manager install_bundle  target: /absolute/path/to/dsh-ai-memory
```

From the plugin manager UI: **Settings → Plugins → Add**, then enable **ai-memory sync**.

Restart the app after installation. The plugin activates for every session in the profile.

## How it behaves

| DSH moment | Sent to ai-memory |
|---|---|
| `session/created`, `agent/created` (startup/resume), `session/flush`, or the first agent activity | `session-start` with the real session id and working directory, exactly once per session |
| `agent/inbox/claimed` | `user-prompt` (opt-in, off by default) |
| `tools/result` | `post-tool-use` with the tool name, clipped input and clipped result |
| `agent/turn-stopping` | `stop` |
| `session/disposed` or `agent/disposed` | `session-end`, exactly once per session |

Capture is best effort. If ai-memory is down, events are dropped; the session is never delayed,
retried in the background, or blocked.

## Sidebar panel

The plugin adds an **ai-memory** entry to the left rail. It opens a memory browser:

- **Left**: every project that holds at least one page, newest first, with its page count. The
  session's own project is pinned at the top. Filter by name.
- **Right**: the selected project's counters, 7-day activity, open handoffs, pending messages,
  rules, and its most recently updated pages.
- **Search**: full-text search inside the selected project, or across every project with the
  **全局** switch.

Two read-only Host routes back the panel (`overview`, `search`); the browser never receives the
bearer token.

Restart the app after installing: the browser half is loaded at boot.

## Configuration

Set these on the plugin row (`cordis.patch.yml` or the row's configuration page):

```yaml
- id: ai-memory-sync
  name: 'dsh-ai-memory'
  config:
    capturePrompt: true
    serverUrl: 'http://127.0.0.1:49374'
```

| Key | Default | Meaning |
|---|---|---|
| `serverUrl` | `http://127.0.0.1:49374` | ai-memory base URL. Non-loopback hosts are refused unless `allowRemote` is set, and must then use `https`. |
| `dataDir` | platform default | Where to read `auth-token`. Empty resolves `$AI_MEMORY_DATA_DIR`, then the platform data directory. |
| `agent` | `claude-code` | Agent label ai-memory records. ai-memory binds the agent kind to a session id on first capture, so changing this after sessions exist makes their events drop as session collisions. Leave it alone. |
| `allowRemote` | `false` | Permit a non-loopback server. |
| `timeoutMs` | `3000` | Per-request timeout. |
| `captureSession` | `true` | Forward session start and end. |
| `capturePrompt` | `false` | Forward user prompt text. |
| `captureTools` | `true` | Forward tool results. |
| `captureStop` | `true` | Forward a stop event per turn. |
| `maxPromptChars` | `4000` | Prompt budget. |
| `maxToolChars` | `2000` | Tool input and result budget. |
| `maxInflight` | `4` | Concurrent ingest requests. |
| `cooldownMs` | `30000` | How long to stop sending after five consecutive failures. |
| `announceScope` | `true` | Add a short prompt section explaining that memory is shared but filed per project. |

## How memory is scoped

ai-memory is one store shared by every agent on the machine, but pages are filed **per project**,
and a project is resolved from the working directory (git remote). Two consequences:

- Agents that run in the same repository read each other's memory automatically.
- `memory_query` searches only the current project. To read another project, or work another
  agent did elsewhere, pass `global: true` or explicit `workspace`/`project` scopes.

This plugin tells the model that at every session (`announceScope`), so a thin result reads as
"not in this project" instead of "not remembered".

## Privacy and security

- **No token is stored.** The plugin reads ai-memory's own owner-only `auth-token` file at runtime
  and keeps it in memory.
- **Prompts are off by default.** They are the most sensitive thing a session produces.
- **Secrets are redacted before capture.** `sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, Google keys and
  private-key blocks are replaced with `[redacted]` in prompts and tool bodies. ai-memory sanitizes
  server-side as well; this is the earlier of the two checks.
- **Loopback only.** A remote server requires `allowRemote: true` and `https`.
- **No shell.** The plugin never spawns a process; it only makes HTTP requests.
- **Bounded.** In-flight requests are capped and the queue drops work instead of growing.

## Troubleshooting

The plugin is deliberately quiet. To see what it does:

```text
DSH_AI_MEMORY_TRACE=/tmp/dsh-ai-memory.log dsh web
```

Each captured event appends one line. Then check the server side:

```text
ai-memory doctor
ai-memory status
```

Common causes:

| Symptom | Cause |
|---|---|
| Nothing captured, no warning | ai-memory not running, or `serverUrl` points elsewhere |
| `no readable bearer token` | `dataDir` is wrong, or the file is not readable by your user |
| Sessions appear under the wrong project | The session's working directory is not the repository root |
| Tool calls work but sessions do not | Only the MCP client is installed; this plugin is separate |

## Uninstall

Remove the bundle from **Settings → Plugins**, or:

```text
plugin_manager remove_bundle  target: dsh-ai-memory
```

Sessions already captured stay in ai-memory.

## Development

```text
npm install
npm test
```

The suite covers path resolution, payload shapes, clipping, redaction, the send queue and the
plugin's event wiring against a local HTTP server.

## License

MIT
