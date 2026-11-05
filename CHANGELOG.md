# Changelog

## 0.1.0

First release.

- Forward `session-start` and `session-end` with the real session id and working directory, closing
  a session exactly once across both disposal seams.
- Optional prompt capture (off by default), tool-result capture with a byte budget, and a per-turn
  stop event.
- Bounded send queue with a circuit breaker, so a stopped server costs the session nothing.
- Secret redaction for prompts and tool bodies before capture.
- Config schema with loopback-only defaults and an opt-in for remote servers.
