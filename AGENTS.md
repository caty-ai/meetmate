# AGENTS.md — Meetmate repository guide for AI assistants

Ground truth for AI tools (and humans) working on this repository. The generated per-instance file that `meetmate init` writes into a *user's* directory is a different file — its template lives at `src/agents-template.md`.

## Canonical commands

- `make test` — **canonical test entry** (family CI gate runs exactly this; bootstraps Node ≥ 26 and deps, then runs the suite serially).
- `make lint` — canonical lint entry.
- `npm test` — the **flaky parallel runner**: it invokes `node --test` with parallel file execution, which intermittently fails on runner IPC under some local Node builds. Do not treat an `npm test` failure as ground truth until reproduced via `make test`. The PR/family CI gate runs `make test`; note that `.github/workflows/publish.yml` runs `npm test` itself, so a red there IS the release gate, and the post-merge canary runs `node --test --test-concurrency=1` directly.
- `npm start` — boot the server (runtime entry; same as `node src/server.js`).
- Node **≥ 26** is required (`engines.node`); `bin/ai-meet.js` preflights this for `init`/`start`.

## Layout map

| Path | What lives there |
|---|---|
| `bin/ai-meet.js` | CLI: `init` wizard (writes `config.json` / `.env` / `AGENTS.md` into the resolved home), `start`, `mcp`, preflight |
| `src/server.js` | HTTP server, settings UI, `/health`; prints the settings-UI URL once, post-bind |
| `src/paths.js` | Home resolution — `AI_MEET_HOME` pinned pre-dotenv, cwd default; bundled-vs-user asset split |
| `src/config.js` | `config.json` loading (lazy path resolution) |
| `src/llm*.js`, `src/stt*.js`, `src/tts-*.js` | LLM / speech-to-text / text-to-speech providers |
| `src/transport-meet/`, `src/mcp/` | Meeting transport; MCP control plane (tools: `join_meeting`, `leave_meeting`, `get_active_session`, `health`) |
| `src/agents-template.md` | Static template for the user-side generated `AGENTS.md` (ships in the tarball) |
| `test/` | `node --test` suite (not shipped) |
| `docs/` | Engineering docs (not shipped); **`docs/cli-contract.md` is the FROZEN CLI & config-resolution contract** |
| `.github/workflows/publish.yml` | npm trusted publishing (OIDC + provenance), gated by the `npm-publish` environment |

## Contribution constraints

- **Issue-first**: repo code changes start from a GitHub Issue; Conventional Commits; PRs carry a completion record.
- **`docs/cli-contract.md` is frozen** — CLI surface, wizard prompt sequence, path-resolution order, tarball contents, and the generated-file rules are contract-level. Do not change behavior it pins without an owner-approved contract amendment.
- The npm tarball is allowlist-packed via `package.json` `files` (plus npm's forced README/LICENSE/NOTICE class); `test/`, `docs/`, `scripts/`, `tools/` never ship.
- Never commit `.env` or `config.json`; never interpolate user or config values into `src/agents-template.md` (key **names** only — enforced by tests).
- Secrets policy for assistants: never print, log, or commit values from `.env`.
