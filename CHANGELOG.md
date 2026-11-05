# Changelog

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
