# Changelog

## 0.9.1

- The pinned row is labelled "共享槽位" instead of "当前会话": it shows the project unscoped MCP
  calls resolve to, which another window can change at any time.

## 0.9.0

- The install check is actionable: the rules-file row has a **write** button that inserts or
  replaces the canonical `ai-memory:start` block (fetched from the server, with a local fallback),
  and the MCP row has a **copy command** button.
- Writing is marker-scoped: existing content is preserved, an unbalanced marker pair is refused,
  and the file is backed up before it is touched.
- `instructionsPath` selects which rules file the check reads and the button writes; empty means
  `~/.agents/AGENTS.md`, else the workspace `AGENTS.md`.

## 0.8.1

- The panel now checks the install instead of assuming it: ai-memory reachability, whether the
  `mcp__ai-memory__*` tools are registered, and whether a rules file carries the ai-memory marker.
  Each missing piece shows the command that fixes it; a complete install shows nothing.
- Fix: the health helper was not imported, which made the whole check return nothing.

## 0.8.0

- Installing the plugin still does nothing to ai-memory itself; the README now says so explicitly.
- When the server is unreachable the panel shows the three setup steps instead of an empty page, and
  the Host logs a warning rather than a debug line.

## 0.7.3

- Saving settings now writes only the fields that changed. Untouched fields keep following the
  plugin's defaults, so a later default improvement still reaches you; saving with no change is a
  no-op instead of pinning every field.

## 0.7.2

- The settings form now shows effective values (defaults merged with the row's config) instead of
  empty fields, and exposes `maxInflight`, `cooldownMs` and `allowRemote` as well.
- The project list no longer repeats the pinned current project.

## 0.7.1

- Settings resolve the plugin row from `ctx.fiber.entry`, falling back to the config editor's
  inventory, so the editable/read-only state is accurate on builds that hide the fiber handle.

## 0.7.0

- Pages and hits now show where they came from: the owning project on every search result, the
  agent that wrote a page, and the project's agent breakdown (sessions per harness).
- Search moved to `/api/v1/search`, which returns the owning project with each hit.
- A Settings tab: the plugin's own knobs are editable (serverUrl, capture switches, budgets) and
  saved through the config editor; the ai-memory server's version, providers and ingest counters
  are shown read-only.

## 0.6.0

- The sidebar panel is a memory browser: every project that holds pages, one project's snapshot
  (counters, 7-day activity, open handoffs, messages, rules), its recent pages, and a search box
  that can reach across projects.
- Two read-only Host routes back it: `overview` and `search`.

## 0.5.1

- Revert the default agent label to `claude-code`. ai-memory binds the agent kind to a session id
  when the session is first stored; sending a different label for an existing session is dropped
  with `hook session collision`, which is why a resumed session stopped being captured after 0.3.0.
  Changing `agent` on a store that already has sessions breaks them — keep the default.

## 0.5.0

- A session is opened by its first agent activity (prompt, tool result, turn end), not only by
  a creation seam. The desktop app restores sessions without announcing `session/created`,
  `agent/created` or `session/flush`, which left a restarted session invisible.
- Subagents are captured as their own sessions: an agent carries no parent marker, and losing a
  real session is worse than an extra one.

## 0.4.0

- A restored session is captured again. The desktop app resumes sessions without announcing
  `session/created`, so the agent seam and the durability flush now open a session too, and a
  session is still announced exactly once.
- Subagent agents and compaction restarts are not mistaken for new sessions.

## 0.3.0

- Every session carries a short note explaining that ai-memory is shared but filed per
  project, and that a thin result means "not in this project" rather than "not remembered".
  Set `announceScope: false` to drop it.
- The default agent label is now `dsh`. ai-memory 3.0 files unknown labels as `other`, which
  is honest; set `agent: claude-code` to restore the previous attribution.

## 0.2.0

- A sidebar entry and panel: server status, the resolved project, counters and the
  most recently updated pages, read through one Host route so the browser never sees
  the bearer token.

## 0.1.0

First release.

- Forward `session-start` and `session-end` with the real session id and working directory, closing
  a session exactly once across both disposal seams.
- Optional prompt capture (off by default), tool-result capture with a byte budget, and a per-turn
  stop event.
- Bounded send queue with a circuit breaker, so a stopped server costs the session nothing.
- Secret redaction for prompts and tool bodies before capture.
- Config schema with loopback-only defaults and an opt-in for remote servers.
