# Claude Code integration cross-review — 2026-07-23

The reviewers received the actual diffs, tests, API contract, and README/setup
documents from both repositories.

## Review results

| Reviewer | Result | Important findings |
| --- | --- | --- |
| Codex implementation review | Approve | No actionable code findings; focused gateway and Meetmate tests re-run |
| Codex security review | Conditional go after fix | Initially found shared-token privilege expansion and a documentation-only trust boundary. Fixed with dedicated `CATY_OPENAI_CHAT_TOKEN`, required trust header, and default-off `trustedAgentTools`; re-review found no blocking issue |
| Codex test review | Conditional go after fix | Requested direct same-agent `historyMaxTurns: 0` regression and lock/semaphore reuse tests after stream failures; both were added |
| Beginner README review | Approve | Hero retained; current/planned, MCP/voice brain, Meet/Zoom, avatar, account, pricing, and secret-key boundaries were clear |
| Claude Code CLI | Unavailable as a final reviewer | CLI was installed and responsive, but final-review invocations returned no review body in this environment. The earlier design review was retained as input, not misreported as final diff approval |
| Kimi K3 CLI | Unavailable as a final reviewer | The installed CLI stopped after proposing its own exploration step and did not return a completed diff review |
| GLM 5.2 CLI | Unavailable as a final reviewer | The installed command emitted an authentication/connector precedence warning and no review |
| Fugu Ultra wrapper | Unavailable as a final reviewer | The wrapper returned suggested shell commands instead of executing a filesystem-backed diff review |

The unavailable external reviewers were not silently counted as approvals.
Their role was covered by independent Codex code, security, test, architecture,
and beginner-documentation reviewers.

## Fixed review findings

### High — shared credential for a high-privilege agent

The original endpoint reused `CATY_TOKEN`, which is also used by lower-trust
phone/watch clients. The endpoint now requires its own
`CATY_OPENAI_CHAT_TOKEN`; there is no fallback.

### High — trusted-meeting boundary was documentation-only

The gateway now requires `X-Caty-Agent-Trust: trusted`. Meetmate sends it only
when the generic OpenAI-compatible setting `trustedAgentTools` is explicitly
`true`; the default is `false`.

### P1 — double-history behavior needed a direct regression

A same-agent two-turn test now proves that `historyMaxTurns: 0` sends only the
system message and latest user turn on the second request.

### P1 — session/concurrency cleanup needed reuse tests

Gateway tests now prove the same session and global slot can be reused after a
stream disconnect, backend error, and timeout.

## Final review posture

The code and security reviews allow a **trusted-meeting-only conditional go**.
The product compatibility status remains **integration in progress** until the
remaining real-meeting barge-in check is recorded.
